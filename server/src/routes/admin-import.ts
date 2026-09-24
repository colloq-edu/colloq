import { tr } from '@shared/i18n'
/**
 * Creating a seminar from a link to GitHub.
 *
 * The teacher's material is already written — notebooks in a course
 * repository, with the CSVs they read sitting next to them. This turns that
 * into a room: paste the link, get a seminar whose cells are already there and
 * whose workspace already holds the data.
 *
 * Staff-only, like everything on this surface. It reaches out to the public
 * internet on the caller's behalf, so it is deliberately narrow: github.com
 * only, public repositories only, no token, one folder deep.
 */
import { workspaceFs } from '../workspace.js'
import { Router, type NextFunction, type Request, type Response } from 'express'
import * as Y from 'yjs'
import { addBook, bookCells, bookList, createCell, getCells, getMeta, renameBook } from '@shared/notebook'
import { currentStaff, requireStaff } from '../admin/auth.js'
import { setSeminarCreator } from './admin-instance.js'
import { newSessionId } from '../auth.js'
import { projectBooks } from '../collab/books.js'
import { visitSessionDoc } from './doc-visit.js'
import { config } from '../config.js'
import { COUNCIL_ROOM, LECTURE_ROOM, readRules } from '@shared/rules'
import { createSession, setRules } from '../db.js'
import { activeName, exists as environmentExists } from '../environments.js'
import {
  fetchNotebook,
  fetchRaw,
  filesToTake,
  listDirectory,
  parseGithubUrl,
  seminarNameFor,
  type GithubTarget,
  type RepoEntry,
} from '../github.js'
import { readIpynb, type FlatCell } from '@shared/ipynb'
import { shelveCellImages } from '../notebook-images.js'
import { safeSegment } from '@shared/paths'
import { normalizeLabel } from '@shared/text'
import { resolveInSession } from '../workspace.js'
import { ENVIRONMENT_NAME, LIMITS, type AdminErrorBody } from '@shared/admin'

function fail(
  res: Response,
  status: number,
  reason: AdminErrorBody['reason'],
  message: string,
): void {
  res.status(status).json({ error: message, reason } satisfies AdminErrorBody)
}

/** A committed notebook can be megabytes of base64 output; the JSON still parses. */
const MAX_NOTEBOOK = 25 * 1024 * 1024

/**
 * A rejected promise goes to the error handler, not into the void.
 *
 * Express 4 knows nothing about async: what is thrown after the first `await`
 * never reaches the error middleware, `unhandledRejection` writes a line to
 * the log, and the request never answers: the preview spins until the browser
 * gives up.
 */
const wrap =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next)
  }

export function adminImportRoutes(): Router {
  const router = Router()

  /**
   * A dry run: what would this link produce?
   *
   * Separate from the import itself because the answer is worth showing before
   * anything is created. A teacher pasting a folder link wants to see "twelve
   * cells and train.csv" before a room exists, not after.
   */
  router.post(
    '/api/admin/import/preview',
    requireStaff,
    wrap(async (req: Request, res: Response) => {
      const target = parseGithubUrl(String(req.body?.url ?? ''))
      if (!target) {
        return fail(
          res,
          400,
          'invalid',
          tr("server.enterAGithubLinkToANotebook.110b0f"),
        )
      }
      try {
        const plan = await planFor(target)
        res.json({
          name: seminarNameFor(plan.notebookTarget ?? target),
          notebook: plan.notebookName,
          notebooks: plan.notebooks.map((book) => ({ name: book.name, cells: book.cells.length })),
          cells: plan.notebooks.reduce((total, book) => total + book.cells.length, 0),
          files: plan.files.map((f) => ({ name: f.name, size: f.size })),
          // What will not fit in the room is named here, before it is created:
          // finding out after the import is too late.
          skipped: plan.skipped,
          source: `${target.owner}/${target.repo}${target.path ? '/' + target.path : ''}`,
        })
      } catch (err) {
        fail(res, 400, 'invalid', err instanceof Error ? err.message : tr("server.couldNotReadThatLink.6d642b"))
      }
    }),
  )

  router.post(
    '/api/admin/import',
    requireStaff,
    wrap(async (req: Request, res: Response) => {
      const target = parseGithubUrl(String(req.body?.url ?? ''))
      if (!target) {
        return fail(res, 400, 'invalid', tr("server.thatIsNotAGithubLink.d0476c"))
      }

      const wanted = typeof req.body?.environment === 'string' ? req.body.environment.trim() : ''
      if (wanted && (!ENVIRONMENT_NAME.test(wanted) || !environmentExists(wanted))) {
        return fail(res, 400, 'invalid', tr("server.thereIsNoEnvironmentCalled.a8903e", { p0: wanted }))
      }

      let plan: Plan
      try {
        plan = await planFor(target)
      } catch (err) {
        return fail(
          res,
          400,
          'invalid',
          err instanceof Error ? err.message : tr("server.couldNotReadThatLink.6d642b"),
        )
      }
      if (!plan.notebooks.some((book) => book.cells.length > 0)) {
        return fail(res, 400, 'invalid', tr("server.thereIsNoNotebookWithAnyCells.5fa7bc"))
      }

      // The same measure as the panel and the room use: the name comes from
      // someone else's repository and from the request body, and it is drawn
      // in the same list rows (shared/text.ts). A bare trim() here was enough
      // for a newline to end up in the title.
      const asked = normalizeLabel(req.body?.name)
      const name = normalizeLabel(asked || seminarNameFor(plan.notebookTarget ?? target)).slice(
        0,
        LIMITS.seminarName,
      )

      const staff = currentStaff(req)
      /*
       * One shared function for all doors; see seedSeminar.
       *
       * There once was a list of its own here: create the session, write the
       * rules, sign the author, put in the cells. The rules dropped out of it
       * once, and "from GitHub" with "teacher only" and the Oracle turned off
       * made a room where anyone could run. The rules are written at
       * creation, so there was no place left to fix it.
       *
       * The document before the files: a room with an empty notebook looks
       * broken, while a room where the data has not arrived yet just looks
       * slow.
       */
      const id = seedSeminar({
        name,
        environment: wanted || activeName(),
        rules: req.body?.rules,
        mode: req.body?.mode,
        cells: plan.cells,
        notebooks: target.kind === 'dir' ? plan.notebooks : undefined,
        author: staff?.name ?? null,
      })

      const written: string[] = []
      // What did not fit under the room's cap has already been named by the plan.
      const skipped: string[] = [...plan.skipped]
      for (const file of plan.files) {
        /*
         * The name is measured by the same measure as everything else in the
         * room's tree.
         *
         * This used to ask `safeName` (two hundred characters, a space at the
         * edge allowed), while the panel, upload and rename ask `safeSegment`
         * (a hundred and twenty, not allowed). A name from the middle of this
         * gap landed on disk and was visible in the tree, but there was no way
         * to open, download or rename it: `normalizePath` does not let such a
         * path through. A file that cannot be reached is worse than one not
         * brought at all, so such files go into `skipped`, where the teacher
         * sees them as a list.
         */
        const target = safeSegment(file.name) ? resolveInSession(id, file.name) : null
        if (!target || !file.downloadUrl) {
          skipped.push(file.name)
          continue
        }
        try {
          const buf = await fetchRaw(file.downloadUrl, config.maxUploadBytes)
          workspaceFs.writeFileSync(target, buf)
          written.push(file.name)
        } catch {
          // One unreadable file must not cost the whole import: the notebook is
          // already in the room and the teacher can drag the rest in by hand.
          skipped.push(file.name)
        }
      }

      res.status(201).json({
        id,
        name,
        url: `${config.publicUrl}/s/${id}`,
        cells: plan.notebooks.reduce((total, book) => total + book.cells.length, 0),
        files: written,
        skipped,
        createdBy: staff?.name ?? null,
      })
    }),
  )

  /*
   * The third door: a notebook from disk.
   *
   * Exactly the same path as the GitHub import, minus the network: the file
   * is already here, and the same `readIpynb` parses it. A separate route
   * rather than a field on the common creation, because there are things
   * here that can fail in their own way: the file may turn out not to be a
   * notebook, and the notebook may turn out to be empty, and each has to be
   * said in different words.
   *
   * A JSON body, not multipart: .ipynb is JSON already, and reading it in the
   * browser and sending it as text is cheaper than bringing up busboy for one
   * field.
   *
   * Only the cells arrive (`cell_type` and `source`), not the whole file. The
   * body limit is the common 1 MB (see express.json in app.ts), and a saved
   * notebook with a couple of charts breaks through it: its outputs are
   * megabytes of base64 that are thrown away here anyway. The same
   * `readIpynb` (shared/ipynb.ts) parses them as the GitHub import and the
   * room do: a second parser disagreeing about what a cell is would one day
   * lose half of someone else's notebook. The `notebook` field with the file
   * text is still accepted, for a notebook that fits within the limit.
   */
  router.post('/api/admin/import/notebook', requireStaff, (req: Request, res: Response) => {
    const sent: unknown = req.body?.cells
    const raw = typeof req.body?.notebook === 'string' ? req.body.notebook : ''

    let parsed: unknown
    if (Array.isArray(sent)) {
      parsed = { cells: sent }
    } else {
      if (!raw.trim()) return fail(res, 400, 'invalid', tr("server.noNotebookWasSent.4ec136"))
      try {
        parsed = JSON.parse(raw)
      } catch {
        return fail(
          res,
          400,
          'invalid',
          tr("server.couldNotReadThisFileAsA.ea3fc6"),
        )
      }
    }

    const cells = readIpynb(parsed)
    if (cells.length === 0) {
      return fail(res, 400, 'invalid', tr("server.thisNotebookHasNoNonemptyCells.bc0428"))
    }

    const wanted = typeof req.body?.environment === 'string' ? req.body.environment.trim() : ''
    if (wanted && (!ENVIRONMENT_NAME.test(wanted) || !environmentExists(wanted))) {
      return fail(res, 400, 'invalid', tr("server.thereIsNoEnvironmentCalled.a8903e", { p0: wanted }))
    }

    const asked = normalizeLabel(req.body?.name)
    const fallback = typeof req.body?.filename === 'string' ? req.body.filename : ''
    const name = normalizeLabel(asked || tidyNotebookName(fallback) || tr("server.untitledSeminar.08a8f2")).slice(
      0,
      LIMITS.seminarName,
    )

    const staff = currentStaff(req)
    const id = seedSeminar({
      name,
      environment: wanted || activeName(),
      rules: req.body?.rules,
      mode: req.body?.mode,
      cells,
      author: staff?.name ?? null,
    })

    res.status(201).json({
      id,
      name,
      url: `${config.publicUrl}/s/${id}`,
      cells: cells.length,
      files: [],
      skipped: [],
      createdBy: staff?.name ?? null,
    })
  })

  return router
}

/**
 * Create a room and put a notebook into it.
 *
 * The shared part of two doors, from GitHub and from disk. It was written
 * twice in a row in one route, and the second time the room's rules got lost
 * from it; it was moved out so that a third door would not lose something of
 * its own.
 */
function seedSeminar(input: {
  name: string
  environment: string | null
  rules: unknown
  mode: unknown
  cells: FlatCell[]
  notebooks?: ImportedNotebook[]
  author: string | null
}): string {
  const id = newSessionId()
  createSession(id, input.name, input.environment)
  /*
   * The mode is a rules preset, and it must work at all three doors.
   *
   * Otherwise it would come out exactly as the paragraph above warns: a
   * seminar created by an import with lecture selected would open as a room
   * where everyone types. The rules sent in lie on top of the preset: a
   * person chose a mode and then tweaked one row.
   *
   * There are three modes, and there must be as many here as in
   * routes/admin-instance.ts: the council, which this line did not know,
   * fell through to "no preset", and an import with mode:'council' and no
   * rules created an open room, the exact opposite of the "the teacher does
   * everything" card. The panel did not show this, because it always sends
   * the full `rules` next to `mode`; what broke was a script or an old client
   * sending only the mode.
   */
  const preset =
    input.mode === 'council' ? COUNCIL_ROOM : input.mode === 'lecture' ? LECTURE_ROOM : null
  const asked = input.rules && typeof input.rules === 'object' ? input.rules : null
  if (preset || asked) setRules(id, readRules({ ...(preset ?? {}), ...(asked ?? {}) }))
  if (input.author) setSeminarCreator(id, input.author)

  /*
   * The document is created for the duration of the seeding and goes to
   * disk.
   *
   * Importing twelve weeks in a row left twelve other people's notebooks in
   * memory: `getSessionDoc` brings the document up, and it does not leave by
   * itself; the idle sweep lets it go only after ten minutes, and all that
   * time twelve notebooks sit in memory at once (routes/doc-visit.ts). The
   * snapshot is written by the same visit, so the first person to join brings
   * the room up exactly as it was assembled here.
   */
  visitSessionDoc(id, (doc) => {
    doc.transact(() => {
      const cells = getCells(doc)
      // The starter notebook the server seeds into a fresh room only gets in the way here.
      if (cells.length > 0) cells.delete(0, cells.length)
      /*
       * Problem statement images go on the room's shelf, not into its
       * document.
       *
       * A course notebook with images weighs megabytes, and all that base64
       * would otherwise move into the document: whole to everyone who joins
       * and into every snapshot (server/src/notebook-images.ts).
       */
      const shelve = (c: FlatCell): FlatCell => shelveCellImages(id, c)
      cells.push(input.cells.map((c) => createCell(c.type, shelve(c).source)))
      if (input.notebooks) {
        const first = bookList(doc)[0]
        if (first) renameBook(doc, first.path, input.notebooks[0].name)
        for (const book of input.notebooks.slice(1)) {
          const added = addBook(doc, book.name)
          bookCells(doc, added.root).push(
            book.cells.map((c) => createCell(c.type, shelve(c).source)),
          )
        }
      }
      getMeta(doc).set('title', input.name)
    }, 'import')
    /*
     * The notebook file now, not in a second and a half.
     *
     * `watchBooks` defers the write, and the observer will leave together
     * with the document: without this line `Тетрадь.ipynb` would appear in the
     * folder only when the room is first opened, and the panel would show zero
     * files for a fresh seminar.
     */
    projectBooks(id)
  })
  return id
}

/**
 * A seminar name from a file name: `01_HSE_Intro_to_Python.ipynb` → "HSE
 * Intro to Python". The same cleanup as for a GitHub link, and for the same
 * reason: nobody needs a sequence number and underscores in a room title.
 */
function tidyNotebookName(filename: string): string {
  const bare = filename.replace(/\.ipynb$/i, '').replace(/^[0-9]+[-_. ]*/, '')
  return bare.replace(/[-_]+/g, ' ').trim()
}

/* ------------------------------------------------------------------ plan */

interface ImportedNotebook {
  name: string
  cells: FlatCell[]
}

interface Plan {
  cells: FlatCell[]
  notebooks: ImportedNotebook[]
  files: RepoEntry[]
  /** Names of files that will not go into the room: they did not fit under its cap. */
  skipped: string[]
  notebookName: string
  notebookTarget: GithubTarget | null
}

/**
 * The room's cap applies to the import too.
 *
 * `filesToTake` cuts off one file at a time (`maxUploadBytes`), and nobody
 * knows the sum: a week folder with thirty CSVs of forty megabytes each went
 * into the room whole, although the same pile through the panel would have
 * been refused at `maxSessionBytes`. The disk here is shared with the
 * database and the images (see the comment on sessionBytes), so the cap has
 * to be the same for all doors.
 *
 * The remainder is not silent: it goes into `skipped`, where the teacher
 * sees it as a list, and into the preview, before the room exists.
 *
 * Exported for the test: the real path here goes over the network to GitHub.
 */
export function withinRoomBudget(files: RepoEntry[]): { files: RepoEntry[]; skipped: string[] } {
  const fits: RepoEntry[] = []
  const skipped: string[] = []
  let total = 0
  for (const file of files) {
    if (total + file.size > config.maxSessionBytes) {
      skipped.push(file.name)
      continue
    }
    total += file.size
    fits.push(file)
  }
  return { files: fits, skipped }
}

/**
 * What a link would turn into, without creating anything.
 *
 * A file link is one request; a folder link lists and reads all its notebooks.
 * Files next to the notebooks come along; subfolders do not, because
 * walking somebody's course repository is a surprise rather than a feature.
 */
async function planFor(target: GithubTarget): Promise<Plan> {
  if (target.kind === 'file') {
    if (!target.path.toLowerCase().endsWith('.ipynb')) {
      throw new Error(tr("server.thatLinkIsNotANotebookPoint.1d59ce"))
    }
    /*
     * `fetchNotebook`, not a bare `fetchRaw`: a branch with a slash in its
     * name (`students/2026-fall`) is parsed from the link wrongly (only GitHub
     * knows where the branch name ends and the path begins), and raw answers
     * such a guess with a 404. A link to a FOLDER fixed itself
     * (`listDirectory` asks again inside), while a link to a file went past
     * that and got "Could not download … (404)" about a live file.
     *
     * It asks again only after a 404, and that matters more than it seems: a
     * branches request is one more trip to the GitHub API, and we go there
     * without a token, that is, sixty times an hour for the whole instance.
     * Spending those on every import for the sake of a rare branch is not an
     * option.
     */
    const raw = await fetchNotebook(target, MAX_NOTEBOOK)
    const cells = readIpynb(JSON.parse(raw.toString('utf8')))
    const name = target.path.split('/').pop() ?? 'notebook.ipynb'
    return {
      cells,
      notebooks: [{ name, cells }],
      files: [],
      skipped: [],
      notebookName: name,
      notebookTarget: target,
    }
  }

  const entries = await listDirectory(target)
  const books = entries
    .filter((entry) => entry.type === 'file' && /\.ipynb$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  const invalid = books.filter((book) => !safeSegment(book.name) || !book.downloadUrl || book.size > MAX_NOTEBOOK)
  const budget = withinRoomBudget([
    ...books.filter((book) => !invalid.includes(book)),
    ...filesToTake(entries, config.maxUploadBytes),
  ])
  const selected = books.filter((book) => budget.files.includes(book))
  if (selected.length === 0) {
    throw new Error(tr("server.thereIsNoIpynbInThatFolder.6299b2"))
  }
  // Read and validate every notebook before creating the room. A failed second
  // download must not silently leave a successful-looking, incomplete import.
  const notebooks: ImportedNotebook[] = []
  for (const book of selected) {
    const raw = await fetchRaw(book.downloadUrl!, MAX_NOTEBOOK)
    notebooks.push({ name: book.name, cells: readIpynb(JSON.parse(raw.toString('utf8'))) })
  }
  // The primary book is opened on entry. Keep an empty companion as a file,
  // but start with actual material (an empty primary is seeded on room load).
  const firstContent = notebooks.findIndex((book) => book.cells.length > 0)
  if (firstContent > 0) notebooks.unshift(...notebooks.splice(firstContent, 1))
  const book = selected.find((entry) => entry.name === notebooks[0].name)!
  return {
    cells: notebooks[0].cells,
    notebooks,
    files: budget.files.filter((file) => !selected.includes(file)),
    skipped: [...invalid.map((file) => file.name), ...budget.skipped],
    notebookName: book.name,
    notebookTarget: notebooks.length === 1 ? { ...target, path: book.path, kind: 'file' } : null,
  }
}
