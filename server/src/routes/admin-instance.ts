import { tr } from '@shared/i18n'
/**
 * The instance's own routes: the seminars a teacher is running, and the
 * oracle that answers in them.
 *
 * Everything here is staff-only. The split between staff and owner is
 * deliberate and narrow: a teacher can create, rename and archive rooms all
 * day, but only the owner can destroy one, because that is the only action on
 * this surface that takes work away from people who are not in the request.
 */
import fs from 'node:fs'
import { Router, type Request, type Response } from 'express'
import * as Y from 'yjs'
import { getCells, getMeta } from '@shared/notebook'
import { currentStaff, ownerOnly, requireStaff } from '../admin/auth.js'
import { getOracleSettings, parseOraclePatch, updateOracleSettings } from '../admin/settings.js'
import { summariseUsage } from '../admin/usage.js'
import { discardBans } from '../bans.js'
import { stopAll } from '../ai/agent.js'
import { testConnection } from '../ai/provider.js'
import { newSessionId } from '../auth.js'
import { dropSessionDoc, getSessionDoc, liveSince, onlineCount } from '../collab/index.js'
import { visitSessionDoc } from './doc-visit.js'
import { config } from '../config.js'
import { broadcast, closeControlRoom, setClassFinished } from '../control.js'
import { COUNCIL_ROOM, LECTURE_ROOM, OPEN_ROOM, readRules } from '@shared/rules'
import { normalizeLabel } from '@shared/text'
import {
  createSession,
  db,
  discardHistory,
  discardNotes,
  finishedAt,
  forgetRoom,
  loadDocSnapshot,
  renameSession,
  sessionEnvironment,
  sessionCpus,
  sessionMemoryMb,
  setRules,
  setSessionCpus,
  setSessionMemoryMb,
  storedRules,
} from '../db.js'
import { forgetCache } from '../collab/history.js'
import { deleteRoomBlobs } from '../blobs.js'
import {
  deletePublication,
  entombSeminar,
  listCourses,
  orphanPublication,
  publicationOf,
  stepCount,
} from '../publish/store.js'
import { environmentOf, shutdownSession, syncBookKernels, syncDangerGuard } from '../kernel/index.js'
import { applyOwnLimits } from '../kernel/pool.js'
import { applyCpuLimit, applyMemoryLimit } from '../kernel/pool.js'
import {
  cpuBounds,
  forgetResources,
  memoryBounds,
  readCpuInput,
  readMemoryInput,
} from '../kernel/resources.js'
import { blockKernelStarts, kernelRetirementInProgress } from '../kernel/retirement.js'
import { activeName, exists as environmentExists } from '../environments.js'
import { forgetTree, listFiles, sessionDir, workspaceFs } from '../workspace.js'
import type { Course } from '@shared/publish'
import {
  ENVIRONMENT_NAME,
  LIMITS,
  type AdminErrorBody,
  type AdminSeminar,
  type OracleTestResult,
  type SeminarStatus,
} from '@shared/admin'

/**
 * The two columns the panel adds to a table db.ts already owns. Guarded by
 * table_info rather than a migrations framework: this is one ALTER per column,
 * SQLite has no ADD COLUMN IF NOT EXISTS, and an instance that has run once
 * must come up unchanged the next time.
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

ensureColumn('sessions', 'created_by', 'created_by TEXT')
ensureColumn('sessions', 'archived_at', 'archived_at INTEGER')

const selectSeminars = db.prepare(`
  SELECT s.id, s.name, s.created_at, s.created_by, s.archived_at,
         (SELECT COUNT(*) FROM participants p WHERE p.session_id = s.id) AS participants
  FROM sessions s
  ORDER BY s.created_at DESC
`)
const selectSeminar = db.prepare(`
  SELECT s.id, s.name, s.created_at, s.created_by, s.archived_at,
         (SELECT COUNT(*) FROM participants p WHERE p.session_id = s.id) AS participants
  FROM sessions s
  WHERE s.id = ?
`)
const updateCreator = db.prepare('UPDATE sessions SET created_by = ? WHERE id = ?')
const setArchived = db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?')
const selectArchived = db.prepare('SELECT archived_at FROM sessions WHERE id = ?')
const deleteSeminarRow = db.prepare('DELETE FROM sessions WHERE id = ?')
const deleteParticipants = db.prepare('DELETE FROM participants WHERE session_id = ?')
const deleteSnapshot = db.prepare('DELETE FROM doc_snapshots WHERE session_id = ?')

interface SeminarRow {
  id: string
  name: string
  created_at: number
  created_by: string | null
  archived_at: number | null
  participants: number
}

/**
 * Attribution for a seminar created through POST /api/sessions rather than
 * through the panel. Exported for routes/sessions.ts, which owns that path.
 */
export function setSeminarCreator(sessionId: string, createdBy: string): void {
  updateCreator.run(createdBy, sessionId)
}

/**
 * Whether the seminar was removed from the list. The column is created here,
 * so it is asked here too; `/join` reads it so as not to warm up a kernel for
 * a room people enter to reread the review.
 */
export function isArchived(sessionId: string): boolean {
  const row = selectArchived.get(sessionId) as { archived_at: number | null } | undefined
  return row?.archived_at != null
}

/* ----------------------------------------------------------------- counts */

/**
 * Cells, without dragging every notebook in the instance back into memory.
 *
 * getSessionDoc() creates and seeds a document as a side effect, so calling it
 * for each row would give a teacher who opened this list a resident Y.Doc per
 * seminar — and would seed starter cells into rooms nobody has ever opened.
 * A live room is read from the doc that is already there; everything else is
 * decoded from its stored snapshot, which for a room with nobody in it is what
 * the next visitor would load anyway.
 *
 * And it is recounted only when the snapshot changed. The list is requested
 * on every tab switch and every twenty seconds on the seminars screen, and
 * decoding someone else's notebook with images means milliseconds of blocking
 * the same event loop that serves the CRDT of live rooms. The key is the
 * snapshot's timestamp: nothing but a snapshot write can change it.
 */
const cellCounts = new Map<string, { at: number; count: number }>()
const snapshotStamp = db.prepare('SELECT updated_at FROM doc_snapshots WHERE session_id = ?')

function cellCount(sessionId: string, live: boolean): number {
  try {
    if (live) return getCells(getSessionDoc(sessionId).doc).length
    const at = (snapshotStamp.get(sessionId) as { updated_at: number } | undefined)?.updated_at ?? 0
    const cached = cellCounts.get(sessionId)
    if (cached && cached.at === at) return cached.count
    const snapshot = loadDocSnapshot(sessionId)
    if (!snapshot) return 0
    const doc = new Y.Doc()
    Y.applyUpdate(doc, snapshot)
    const count = getCells(doc).length
    doc.destroy()
    cellCounts.set(sessionId, { at, count })
    return count
  } catch {
    // A card with a zero on it is better than a list that will not load.
    return 0
  }
}

/**
 * listFiles, not a bare readdir: the number on the card has to be the number the
 * Files panel shows.
 *
 * Also by timestamp, not by a walk per row. `listFiles` reads the whole room
 * (readdir and an lstat per entry, up to two thousand, synchronously and in
 * the same event loop that serves live rooms), and the list is requested on
 * every tab switch and every twenty seconds. The key is the mtime of the
 * room's root: uploads, deletions and everything the kernel puts next to the
 * notebook land there. A file written deep in a subfolder leaves the old
 * number on the card until the next change of the root; it is a number on a
 * card, not a file list.
 *
 * Counting afresh means walking afresh too: `listFiles` itself has a short
 * memory of its own (workspace.ts · TREE_MEMO_MS), and it can be OLDER than
 * the timestamp we key by. Then a number counted on the previous tree got
 * pinned to the new mtime, and the card showed "0 files" not for three
 * hundred milliseconds but until the next change of the folder: a file was
 * put into the room bypassing workspace.ts (the kernel, saving an open file),
 * and the card did not show it at all. If the folder changed, we walk it
 * instead of remembering.
 */
const fileCounts = new Map<string, { at: number; count: number }>()

function fileCount(sessionId: string): number {
  try {
    const at = workspaceFs.statSync(sessionDir(sessionId)).mtimeMs
    const cached = fileCounts.get(sessionId)
    if (cached && cached.at === at) return cached.count
    forgetTree(sessionId)
    const count = listFiles(sessionId).filter((entry) => !entry.dir).length
    fileCounts.set(sessionId, { at, count })
    return count
  } catch {
    return 0
  }
}

/**
 * One word about the seminar, and the teacher's decision beats the count.
 *
 * Until the bell, the word answers "what is going on there now": someone is
 * in the room, the link was never given out, it is empty. After the bell
 * answering that makes no sense: the room is finished, and three people
 * rereading the review in it do not make the lesson live.
 */
function statusOf(
  liveCount: number,
  totalParticipants: number,
  finishedAt: number | null,
): SeminarStatus {
  if (finishedAt !== null) return 'finished'
  if (liveCount > 0) return 'live'
  // Nobody has ever joined: the link was made and never used.
  return totalParticipants === 0 ? 'draft' : 'idle'
}

function toSeminar(row: SeminarRow, courses = listCourses()): AdminSeminar {
  // Open collab sockets, which is the only "who is here right now" the server
  // actually holds (collab/index.ts). A second tab counts twice; the control
  // socket keeps no per-session tally to cross-check against.
  const liveCount = onlineCount(row.id)
  const publication = publicationOf(row.id)
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    status: statusOf(liveCount, row.participants, finishedAt(row.id)),
    liveCount,
    /*
     * The class's clock, not the room's: the line "Running now · started 25
     * min ago" is about how long THIS lesson has been going. The room was
     * created a week earlier, and its `createdAt` answered a different
     * question (collab/index.ts · liveSince).
     */
    liveSince: liveSince(row.id),
    totalParticipants: row.participants,
    cellCount: cellCount(row.id, liveCount > 0),
    fileCount: fileCount(row.id),
    url: `${config.publicUrl}/s/${row.id}`,
    /*
     * What the room ACTUALLY started, if the kernel is already up; otherwise
     * what it asked for at creation. The difference shows exactly when it
     * matters: a seminar that survived a switch keeps working on the old
     * image.
     */
    environment: environmentOf(row.id) ?? sessionEnvironment(row.id),
    createdBy: row.created_by,
    archivedAt: row.archived_at,
    /*
     * The chosen rules, not the effective ones: in the edit form a person has
     * to see what they chose. A finished class tightens the rights on top of
     * them (shared/rules.ts · rulesAfterClass) and steps back without
     * touching the setting, and `finishedAt` next to it says whether it is
     * running now.
     */
    rules: storedRules(row.id),
    /*
     * How much memory THIS room was given, or null for "as for the
     * environment".
     *
     * Its own number, not the effective one: in the settings form a person
     * has to see what they set, and tell "I set 4 GB" from "that is what the
     * environment gives". The panel takes the environment default from
     * /api/instance/resources: it is one for all rooms and changes without
     * them.
     */
    memoryMb: sessionMemoryMb(row.id),
    /** And CPUs by the same rule: the room's own number, not the effective one. */
    cpus: sessionCpus(row.id),
    finishedAt: finishedAt(row.id),
    publication: publication
      ? {
          id: publication.id,
          slug: publication.slug,
          state: publication.state,
          steps: stepCount(publication.id),
        }
      : null,
    courses: coursesWith(row.id, courses),
  }
}

/**
 * The courses the seminar belongs to. The list row shows them as links.
 *
 * The course list is passed in rather than requested again: in a semester of
 * sixty seminars that was sixty identical reads per response.
 */
function coursesWith(sessionId: string, courses: Course[]): { id: string; name: string }[] {
  return courses
    .filter((course) =>
      course.items.some((item) => item.kind === 'seminar' && item.sessionId === sessionId),
    )
    .map((course) => ({ id: course.id, name: course.name }))
}

/* ------------------------------------------------------------------ input */

/**
 * Collapse whitespace and drop control characters so a name cannot break the
 * list layout. One measure for all four doors: shared/text.ts.
 */
const normalize = normalizeLabel

function invalid(res: Response, error: string): Response {
  const body: AdminErrorBody = { error, reason: 'invalid' }
  return res.status(400).json(body)
}

/**
 * Why the number was not accepted, in numbers too.
 *
 * The bounds are named out loud: "must be a number" on a field the form
 * sends megabytes to tells nothing to someone who sent gigabytes, while "from
 * 512 to 71 680 MB" tells everything at once.
 */
function memoryRefusal(why: 'type' | 'range'): string {
  const { min, max } = memoryBounds()
  return why === 'type'
    ? tr('server.memoryMustBeWholeMegabytes')
    : tr('server.memoryOutOfRange', { p0: min, p1: max })
}

/** The same as for memory: the bounds are named in numbers, not as "invalid". */
function cpuRefusal(why: 'type' | 'range'): string {
  const { min, max } = cpuBounds()
  return why === 'type'
    ? tr('server.cpusMustBeWholeCores')
    : tr('server.cpusOutOfRange', { p0: min, p1: max })
}

function notFound(res: Response): Response {
  const body: AdminErrorBody = { error: tr("server.thatSeminarNoLongerExists.b346fe"), reason: 'invalid' }
  return res.status(404).json(body)
}

function seminarOr404(req: Request, res: Response): SeminarRow | null {
  const row = selectSeminar.get(req.params.id) as SeminarRow | undefined
  if (!row) {
    notFound(res)
    return null
  }
  return row
}

/** A week, which is the window a teacher is actually asking about after a class. */
const DEFAULT_USAGE_WINDOW_MS = 7 * 24 * 3_600_000
const MAX_USAGE_WINDOW_MS = 365 * 24 * 3_600_000

export function adminInstanceRoutes(): Router {
  const router = Router()

  /* --------------------------------------------------------- seminars */

  router.get('/api/admin/seminars', requireStaff, (_req, res) => {
    const rows = selectSeminars.all() as SeminarRow[]
    const courses = listCourses()
    res.json(rows.map((row) => toSeminar(row, courses)))
  })

  router.post('/api/admin/seminars', requireStaff, (req, res) => {
    const name = normalize(req.body?.name)
    if (!name) return invalid(res, tr("server.aSeminarNameIsRequired.f10426"))
    if (name.length > LIMITS.seminarName) {
      return invalid(res, tr("server.aSeminarNameMustBeCharactersOr.c9d56a", { p0: LIMITS.seminarName }))
    }

    /*
     * The environment is checked, not taken on trust: the name becomes an
     * image tag and a container name, and it comes from the browser. A
     * nonexistent name is better rejected here than discovered when the room
     * is already full.
     */
    const wanted = typeof req.body?.environment === 'string' ? req.body.environment.trim() : ''
    if (wanted && (!ENVIRONMENT_NAME.test(wanted) || !environmentExists(wanted))) {
      return invalid(res, tr("server.thereIsNoEnvironmentCalled.a8903e", { p0: wanted }))
    }

    /*
     * A concrete name is always recorded, never "follow the instance".
     *
     * There used to be a third state — null meaning "whatever the instance is
     * set to" — and it quietly contradicted the promise this feature makes: a
     * seminar's Python is decided once, so that a room's packages cannot change
     * under it mid-class. A room left on "follow" would have moved the next
     * time somebody changed the default. Resolving the default HERE, at
     * creation, keeps one rule instead of two.
     */
    const environment = wanted || activeName()

    /*
     * The memory limit is checked by the same measure as on change: the
     * machine has one boundary, and the creation form is not the place where
     * a room can be promised more than there is.
     */
    const memory = readMemoryInput(req.body?.memoryMb)
    if (!memory.ok) return invalid(res, memoryRefusal(memory.error))
    const cpu = readCpuInput(req.body?.cpus)
    if (!cpu.ok) return invalid(res, cpuRefusal(cpu.error))

    const id = newSessionId()
    createSession(id, name, environment)
    /*
     * Rules are written at creation and not before: there is no draft row to
     * hold them, so a seminar exists the moment it is created and it exists
     * with the rules it was created under. readRules() inside setRules fills in
     * anything the form did not send, so a caller that knows nothing about
     * rules — a script, an older client — still produces the open room the
     * product has always been.
     *
     * The mode is a rules PRESET, and it is recorded as rules. As a separate
     * room state ("this one is a lecture room") it would introduce a second
     * source of truth about what is allowed in the room: the server asks the
     * rules for rights, the settings show the same rules, and the first
     * switch in the settings would split word from deed. So 'lecture' is
     * `LECTURE_ROOM`, 'lab' and a missing field are `OPEN_ROOM`, and from then
     * on the room lives by rules alone.
     *
     * The rules sent in lie ON TOP of the preset: a person chose a mode and
     * tweaked one row in it, and the tweak must be stronger than the choice,
     * not the other way round.
     */
    const mode = req.body?.mode
    // A council is the same lecture, except the lock opens each person's own sheet to them.
    const preset = mode === 'council' ? COUNCIL_ROOM : mode === 'lecture' ? LECTURE_ROOM : null
    const asked =
      req.body?.rules && typeof req.body.rules === 'object' ? (req.body.rules as object) : null
    if (preset || asked) {
      setRules(id, readRules({ ...(preset ?? OPEN_ROOM), ...asked }))
    }
    /*
     * Memory goes into the row right away, before the kernel's first start.
     *
     * A vision class is created the day before, and the "six gigabytes"
     * choice has to last until the lesson rather than be a separate trip to
     * the settings in the morning. There is no container yet, nothing to
     * change: the number just lies there waiting for its `docker run`.
     */
    if (memory.ok && memory.mb !== null) {
      setSessionMemoryMb(id, memory.mb)
      forgetResources()
    }
    if (cpu.ok && cpu.cpus !== null) {
      setSessionCpus(id, cpu.cpus)
      forgetResources()
    }

    const staff = currentStaff(req)
    if (staff) setSeminarCreator(id, staff.name)

    const row = selectSeminar.get(id) as SeminarRow
    res.status(201).json(toSeminar(row))
  })

  router.patch('/api/admin/seminars/:id', requireStaff, (req, res) => {
    const row = seminarOr404(req, res)
    if (!row) return

    const body = req.body as
      | {
          name?: unknown
          archived?: unknown
          finished?: unknown
          rules?: unknown
          memoryMb?: unknown
          cpus?: unknown
        }
      | undefined
    if (body?.name !== undefined) {
      const name = normalize(body.name)
      if (!name) return invalid(res, tr("server.aSeminarNameIsRequired.f10426"))
      if (name.length > LIMITS.seminarName) {
        return invalid(res, tr("server.aSeminarNameMustBeCharactersOr.c9d56a", { p0: LIMITS.seminarName }))
      }
      /*
       * Into the row through `renameSession`, not an UPDATE of our own.
       *
       * There used to be a second, identical `UPDATE sessions SET name` here,
       * and ever since the room name went into the row cache
       * (db.ts · roomCache) it wrote past the cache: the panel renamed the
       * seminar, while `getSession` kept serving the old name until a
       * restart, to the same room card, the publication and the course list.
       * The name row has one door, and it forgets the cache behind itself.
       */
      renameSession(row.id, name)
      // ...and into the room, whose header reads the document rather than this
      // row. Without it a rename in the panel never reached the people inside,
      // and the seminar quietly had two names.
      //
      // Through visitSessionDoc: renaming last year's seminar brings up its
      // notebook with all the images, and without a visit it would sit in
      // memory until the next idle sweep, and seminars get renamed in batches
      // when sorting out a semester (routes/doc-visit.ts).
      visitSessionDoc(row.id, (doc) => getMeta(doc).set('title', name))
    }
    if (body?.archived !== undefined) {
      if (typeof body.archived !== 'boolean') return invalid(res, tr("server.archivedMustBeTrueOrFalse.db6c12"))
      // Archiving is a label on the list, not a lock: a room with people still
      // in it keeps working, which is why nothing here touches the document.
      setArchived.run(body.archived ? Date.now() : null, row.id)
    }

    if (body?.finished !== undefined) {
      if (typeof body.finished !== 'boolean') return invalid(res, tr("server.finishedMustBeTrueOrFalse.f9f3c0"))
      /*
       * The same door as the button in the room: a teacher who closed the tab
       * and remembered the class on the metro should not have to go back into
       * the seminar for one click.
       *
       * The time of an already finished one is not rewritten: the panel sends
       * the whole form, and renaming the seminar would move "finished at
       * 15:40" to now, the hour people later ask about to find out when the
       * lesson ended.
       */
      const was = finishedAt(row.id)
      const at = body.finished ? (was ?? Date.now()) : null
      if (at !== was) {
        setClassFinished(row.id, at)
        // The room learns now, not on reload: otherwise a student still has
        // lit buttons the server will no longer accept, and the refusal reads
        // as a breakage. The same frame opens it back up, too.
        broadcast(row.id, { t: 'class', finishedAt: at })
        // And the agent's turn is cut off, exactly as with the button in the
        // room (control.ts · class:finish). Otherwise "End class" from the
        // panel leaves the Oracle editing files where everyone else may only
        // read.
        if (at !== null) stopAll(row.id)
      }
    }

    if (body?.rules !== undefined) {
      /*
       * Rules can be changed after the fact, and could always have been: the
       * server reads them fresh on every request, so a change takes effect at
       * once. Only the panel had no way to send one — a seminar created with
       * "everyone may run" stayed that way for its whole life, and the teacher
       * who wanted a lecture had to make a second room.
       */
      if (typeof body.rules !== 'object' || body.rules === null) {
        return invalid(res, tr("server.rulesMustBeAnObject.c2a9d1"))
      }
      setRules(row.id, readRules({ ...storedRules(row.id), ...(body.rules as object) }))
      // And the personal notebooks' numbers go to their container, the same way as from the room.
      void applyOwnLimits(row.id).catch(() => {})
      // A notebook's access decides which container its kernel is in; if it
      // changed, the kernel is shut down. The same argument as in
      // routes/sessions.ts.
      syncBookKernels(row.id)
      // And the guard against dangerous commands goes into the class's live
      // kernels, the same way and for the same reason as from the room
      // (routes/sessions.ts).
      syncDangerGuard(row.id)
      // The room finds out now, not on its next reload: the panel greys its
      // controls from this, and a rule nobody was told about is a rule that
      // looks like a bug when a button stops working.
      broadcast(row.id, { t: 'rules', rules: storedRules(row.id) })
    }

    if (body?.memoryMb !== undefined) {
      const memory = readMemoryInput(body.memoryMb)
      if (!memory.ok) return invalid(res, memoryRefusal(memory.error))
      setSessionMemoryMb(row.id, memory.mb)
      forgetResources()
      /*
       * To the live room right now, and WITHOUT a kernel restart.
       *
       * This is what all of it was started for: a teacher whose kernel was
       * just killed for memory adds gigabytes and runs the same cell again
       * without losing the seminar's variables or the open terminal. The
       * answer is not awaited: `docker update` on a busy machine takes
       * hundreds of milliseconds, and the number is already recorded; if
       * there is no container or docker refused, the next start picks it up.
       * The kernel log will say what exactly happened.
       */
      // A reset to the default (`null`) goes too: the broker returns the live
      // Pod to its default at once, docker still waits for the next start.
      void applyMemoryLimit(row.id, memory.mb).catch((err: unknown) => {
        console.error(`[kernel] memory limit for ${row.id} did not get through:`, err)
      })
    }

    if (body?.cpus !== undefined) {
      const cpu = readCpuInput(body.cpus)
      if (!cpu.ok) return invalid(res, cpuRefusal(cpu.error))
      setSessionCpus(row.id, cpu.cpus)
      forgetResources()
      /*
       * To the live room at once, like memory, on both backends:
       * `docker update --cpus` or the broker's `pods/resize`. There is one
       * caveat, and an honest one: the numpy and torch threads are set when
       * the room's container is created and cannot be changed in a live one,
       * not even by a kernel restart. The form says so out loud, so the
       * kernel is not touched here.
       */
      // A reset to the default also changes the quota of an already running
      // container; whose default it is (KERNEL_CPUS or the broker's) is up to
      // the pool.
      void applyCpuLimit(row.id, cpu.cpus).catch((err: unknown) => {
        console.error(`[kernel] CPU count for ${row.id} did not get through:`, err)
      })
    }

    res.json(toSeminar(selectSeminar.get(row.id) as SeminarRow))
  })

  /**
   * Destructive, and owner-only for exactly that reason: this is not "hide the
   * card". It drops the roster, the notebook snapshot and every file the room
   * uploaded or wrote, none of which Colloq keeps a second copy of — a student
   * may be standing in the room as it goes. Archiving is the reversible action;
   * this one is for a seminar that must actually be gone.
   *
   * The ai_usage rows survive on purpose: they are anonymous counters of what
   * the instance's key really spent, and deleting a room should not quietly
   * rewrite that history.
   *
   * The live room is torn down before the rows go: the sockets are closed and
   * the document is evicted without a final flush, so nothing writes a snapshot
   * back for a seminar that no longer exists.
   *
   * New joins and kernel starts are blocked while the runtime is stopped.
   * If stopping fails, all persistent room data stays available for a retry.
   * After confirmation, sockets, documents and rows are removed synchronously.
   */
  router.delete('/api/admin/seminars/:id', ownerOnly('delete a seminar'), (req, res) => {
    const row = seminarOr404(req, res)
    if (!row) return
    if (kernelRetirementInProgress(row.id)) {
      res.status(503).json({ error: tr("server.theSeminarIsAlreadyStoppingTryAgain.ca0fd7"), reason: 'invalid' } satisfies AdminErrorBody)
      return
    }
    const release = blockKernelStarts(row.id)
    // `?reading=drop` means "delete both". The default keeps the reading.
    const keepReading = req.query.reading !== 'drop'
    void (async () => {
      try {
        // Keep the complete room until the broker confirms that its Pod is gone.
        // The gate rejects new joins/starts while existing ensure requests drain.
        stopAll(row.id)
        try {
          await shutdownSession(row.id, true)
        } catch (err) {
          console.warn(`[admin] could not stop the kernel for ${row.id}:`, err instanceof Error ? err.message : err)
          res.status(503).json({
            error: tr("server.deletionCouldNotFinishBecauseTheKernel.c885fc"),
            reason: 'invalid',
          } satisfies AdminErrorBody)
          return
        }
        closeControlRoom(row.id)
        dropSessionDoc(row.id)

        try {
          workspaceFs.rmSync(sessionDir(row.id), { recursive: true, force: true })
        } catch (err) {
          console.warn(`[admin] workspace cleanup for ${row.id} is incomplete:`, err instanceof Error ? err.message : err)
          forgetTree(row.id)
          res.status(503).json({
            error: tr("server.deletionCouldNotFinishBecauseSomeFiles.81f721"),
            reason: 'invalid',
          } satisfies AdminErrorBody)
          return
        }

        // And the output images: they are not in the room's folder but on
        // their own shelf next to the database (server/src/blobs.ts). Without
        // this line the folder would live until the next sweep; there is one,
        // but that is an hour too long.
        deleteRoomBlobs(row.id)

        const purge = db.transaction((id: string) => {
          deleteParticipants.run(id)
          deleteSnapshot.run(id)
          // The history is the notebook, in full, one keyframe at a time. A
          // seminar deleted with it left behind is a seminar the dialog said
          // was gone and whose every cell is still on disk — and still served
          // over HTTP to anyone holding an old token.
          discardHistory(id)
          // And the lecture notes: the only thing the teacher wrote for
          // themselves, and there is no reason to keep them in the database of
          // a deleted room.
          discardNotes(id)
          // And the bans: a ban row holds the person's address, and it must
          // not outlive a room that no longer exists.
          discardBans(id)
          deleteSeminarRow.run(id)
        })
        purge(row.id)
        forgetCache(row.id)
        /*
         * And everything db.ts remembers about the room: the row, the rules
         * and its people's rights by token.
         *
         * `forgetRules` used to be called here, and while memory held only
         * the rules, that was enough. Now the row itself lives there too, the
         * very "is the seminar still alive" that the socket door meets a token
         * forgotten in a browser with: not forgetting it would mean letting
         * people into a deleted room until the server restarts.
         */
        forgetRoom(row.id)
        cellCounts.delete(row.id)
        fileCounts.delete(row.id)
        /*
         * The published page is a separate object, and its fate is asked
         * about separately. It is assembled whole and lives in its own rows:
         * there is no room and no document behind it, so "delete the room,
         * keep the reading" is a choice, not an excuse. By default it is kept:
         * a link cannot be recalled from students, and a page answering 404
         * where yesterday there was a seminar is the worse of the two.
         */
        const pub = publicationOf(row.id)
        if (pub) {
          if (keepReading) orphanPublication(row.id)
          else deletePublication(pub.id)
        }
        // A tombstone stays in the courses: a missing fourth week breaks the
        // course for whoever attended it and shifts the numbering of the rest.
        entombSeminar(row.id, row.name)

        /*
         * A second pass, over what may have come back to life while the
         * kernel was shutting down.
         *
         * A late cell output or a console that reached `getSessionDoc` a
         * millisecond before the rows were removed brings the document up
         * again, and it writes a snapshot and a feed row. These are cheap
         * DELETEs by key, and repeating them costs nothing; in return the room
         * is really deleted after deletion, rather than coming back on the
         * next restart.
         */
        dropSessionDoc(row.id)
        deleteSnapshot.run(row.id)
        discardHistory(row.id)


        res.status(204).end()
      } catch (err) {
        console.error(
          `[admin] deleting ${row.id} failed:`,
          err instanceof Error ? err.message : err,
        )
        if (!res.headersSent)
          res.status(500).json({
            error: tr("server.theSeminarCouldNotBeDeleted.e7f27d"),
            reason: 'invalid',
          } satisfies AdminErrorBody)
      } finally { release() }
    })()
  })

  /* -------------------------------------------------------- oracle */

  router.get('/api/admin/oracle', requireStaff, (_req, res) => {
    res.json(getOracleSettings())
  })

  /*
   * Owner-only, and the reason is not tidiness. baseUrl is attacker-controlled
   * input that the provider then receives the instance's API key on: point it
   * at a host you own, press Test, and the key walks out in an Authorization
   * header — including a key that only ever lived in OPENAI_API_KEY and was
   * never typed into this panel. The same rewrite silently routes every
   * student's question and notebook context through that host until someone
   * notices. shared/admin.ts scopes a teacher to READING settings; the GET
   * below is that read, and it is masked.
   */
  router.put('/api/admin/oracle', ownerOnly('server.ownerAction.6'), (req, res) => {
    const parsed = parseOraclePatch(req.body)
    if ('error' in parsed) return invalid(res, parsed.error)
    // The response is the masked settings, like the GET: the key goes in and is
    // never handed back, not even to the teacher who just typed it.
    res.json(updateOracleSettings(parsed.patch))
  })

  // Owner-only for the same reason: this is the button that makes the server
  // send a request, with the key attached, to whatever host is configured.
  router.post('/api/admin/oracle/test', ownerOnly('server.ownerAction.7'), (_req, res) => {
    void testConnection().then(
      (result) => res.json(result),
      (err: unknown) => {
        // testConnection turns failures into results; reaching here means the
        // call itself broke, which is still a sentence and not a 500.
        console.error('[admin] oracle test failed:', err instanceof Error ? err.message : err)
        const broke: OracleTestResult = {
          ok: false,
          ms: null,
          message: tr("server.theTestCouldNotBeRunCheck.4fcf49"),
          model: null,
        }
        res.json(broke)
      },
    )
  })

  router.get('/api/admin/oracle/usage', requireStaff, (req, res) => {
    const now = Date.now()
    const asked = Number(req.query.since)
    const since =
      Number.isFinite(asked) && asked > 0
        ? Math.min(Math.max(asked, now - MAX_USAGE_WINDOW_MS), now)
        : now - DEFAULT_USAGE_WINDOW_MS
    res.json(summariseUsage(since))
  })

  return router
}
