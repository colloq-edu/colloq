/**
 * Creating a seminar from a link to GitHub.
 *
 * The teacher's material is already written — one notebook per week, in a
 * course repository, with the CSV it reads sitting next to it. This turns that
 * into a room: paste the link, get a seminar whose cells are already there and
 * whose workspace already holds the data.
 *
 * Staff-only, like everything on this surface. It reaches out to the public
 * internet on the caller's behalf, so it is deliberately narrow: github.com
 * only, public repositories only, no token, one folder deep.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Router, type Request, type Response } from 'express'
import * as Y from 'yjs'
import { createCell, getCells, getMeta } from '@shared/notebook'
import { currentStaff, requireStaff } from '../admin/auth.js'
import { setSeminarCreator } from './admin-instance.js'
import { newSessionId } from '../auth.js'
import { getSessionDoc } from '../collab/index.js'
import { flushPersistence } from '../collab/persistence.js'
import { config } from '../config.js'
import { createSession } from '../db.js'
import { activeName, exists as environmentExists } from '../environments.js'
import {
  fetchRaw,
  filesToTake,
  listDirectory,
  notebookCells,
  parseGithubUrl,
  pickNotebook,
  rawUrlFor,
  seminarNameFor,
  type GithubTarget,
  type RepoEntry,
} from '../github.js'
import { safeName, sessionDir } from '../workspace.js'
import { ENVIRONMENT_NAME, LIMITS, type AdminErrorBody } from '@shared/admin'

function fail(res: Response, status: number, reason: AdminErrorBody['reason'], message: string): void {
  res.status(status).json({ error: message, reason } satisfies AdminErrorBody)
}

/** A committed notebook can be megabytes of base64 output; the JSON still parses. */
const MAX_NOTEBOOK = 25 * 1024 * 1024

export function adminImportRoutes(): Router {
  const router = Router()

  /**
   * A dry run: what would this link produce?
   *
   * Separate from the import itself because the answer is worth showing before
   * anything is created. A teacher pasting a folder link wants to see "twelve
   * cells and train.csv" before a room exists, not after.
   */
  router.post('/api/admin/import/preview', requireStaff, async (req: Request, res: Response) => {
    const target = parseGithubUrl(String(req.body?.url ?? ''))
    if (!target) {
      return fail(
        res,
        400,
        'invalid',
        'That is not a GitHub link. Paste the address of a notebook or of the week\'s folder.',
      )
    }
    try {
      const plan = await planFor(target)
      res.json({
        name: seminarNameFor(plan.notebookTarget ?? target),
        notebook: plan.notebookName,
        cells: plan.cells.length,
        files: plan.files.map((f) => ({ name: f.name, size: f.size })),
        source: `${target.owner}/${target.repo}${target.path ? '/' + target.path : ''}`,
      })
    } catch (err) {
      fail(res, 400, 'invalid', err instanceof Error ? err.message : 'Could not read that link.')
    }
  })

  router.post('/api/admin/import', requireStaff, async (req: Request, res: Response) => {
    const target = parseGithubUrl(String(req.body?.url ?? ''))
    if (!target) {
      return fail(res, 400, 'invalid', 'That is not a GitHub link.')
    }

    const wanted = typeof req.body?.environment === 'string' ? req.body.environment.trim() : ''
    if (wanted && (!ENVIRONMENT_NAME.test(wanted) || !environmentExists(wanted))) {
      return fail(res, 400, 'invalid', `there is no environment called "${wanted}"`)
    }

    let plan: Plan
    try {
      plan = await planFor(target)
    } catch (err) {
      return fail(res, 400, 'invalid', err instanceof Error ? err.message : 'Could not read that link.')
    }
    if (plan.cells.length === 0) {
      return fail(res, 400, 'invalid', 'There is no notebook with any cells at that link.')
    }

    const asked = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const name = (asked || seminarNameFor(plan.notebookTarget ?? target)).slice(0, LIMITS.seminarName)

    const id = newSessionId()
    // То же правило, что и при обычном создании: имя окружения
    // записывается конкретное, а не «как на инстансе».
    createSession(id, name, wanted || activeName())
    const staff = currentStaff(req)
    /*
     * The same line the ordinary create path has run all along. Without it an
     * imported seminar arrives with no author, and the panel's list shows it
     * blank beside rooms that name theirs — two doors into the same room, and
     * only one of them signs its work.
     */
    if (staff) setSeminarCreator(id, staff.name)

    // The document first, the files second: a room whose notebook is empty
    // looks broken, and a room whose data has not landed yet only looks slow.
    const { doc } = getSessionDoc(id)
    doc.transact(() => {
      const cells = getCells(doc)
      // The server seeds a starter notebook for a fresh room; an import is
      // exactly the case where that starter is in the way.
      if (cells.length > 0) cells.delete(0, cells.length)
      cells.push(plan.cells.map((c) => createCell(c.type, c.source)))
      getMeta(doc).set('title', name)
    }, 'import')
    flushPersistence(id)

    const written: string[] = []
    const skipped: string[] = []
    for (const file of plan.files) {
      const safe = safeName(file.name)
      if (!safe || !file.downloadUrl) {
        skipped.push(file.name)
        continue
      }
      try {
        const buf = await fetchRaw(file.downloadUrl, config.maxUploadBytes)
        fs.writeFileSync(path.join(sessionDir(id), safe), buf)
        written.push(safe)
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
      cells: plan.cells.length,
      files: written,
      skipped,
      createdBy: staff?.name ?? null,
    })
  })

  return router
}

/* ------------------------------------------------------------------ plan */

interface Plan {
  cells: ReturnType<typeof notebookCells>
  files: RepoEntry[]
  notebookName: string
  notebookTarget: GithubTarget | null
}

/**
 * What a link would turn into, without creating anything.
 *
 * A file link is one request; a folder link is two — list, then fetch the
 * notebook. Files next to the notebook come along; subfolders do not, because
 * walking somebody's course repository is a surprise rather than a feature.
 */
async function planFor(target: GithubTarget): Promise<Plan> {
  if (target.kind === 'file') {
    if (!target.path.toLowerCase().endsWith('.ipynb')) {
      throw new Error('That link is not a notebook. Point it at an .ipynb file or at a folder.')
    }
    const raw = await fetchRaw(rawUrlFor(target), MAX_NOTEBOOK)
    return {
      cells: notebookCells(JSON.parse(raw.toString('utf8'))),
      files: [],
      notebookName: target.path.split('/').pop() ?? 'notebook.ipynb',
      notebookTarget: target,
    }
  }

  const entries = await listDirectory(target)
  const book = pickNotebook(entries)
  if (!book || !book.downloadUrl) {
    throw new Error('There is no .ipynb in that folder.')
  }
  const raw = await fetchRaw(book.downloadUrl, MAX_NOTEBOOK)
  return {
    cells: notebookCells(JSON.parse(raw.toString('utf8'))),
    files: filesToTake(entries, config.maxUploadBytes),
    notebookName: book.name,
    notebookTarget: { ...target, path: book.path, kind: 'file' },
  }
}
