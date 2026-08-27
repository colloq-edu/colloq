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
import {
  getOracleSettings,
  parseOraclePatch,
  updateOracleSettings,
} from '../admin/settings.js'
import { summariseUsage } from '../admin/usage.js'
import { testConnection } from '../ai/provider.js'
import { newSessionId } from '../auth.js'
import { dropSessionDoc, getSessionDoc, onlineCount } from '../collab/index.js'
import { config } from '../config.js'
import { broadcast, closeControlRoom } from '../control.js'
import { readRules } from '@shared/rules'
import { createSession, db, discardHistory, getRules, loadDocSnapshot, sessionEnvironment, setRules } from '../db.js'
import { forgetCache } from '../collab/history.js'
import { environmentOf, shutdownSession } from '../kernel/index.js'
import { activeName, exists as environmentExists } from '../environments.js'
import { listFiles, sessionDir } from '../workspace.js'
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
const renameSeminar = db.prepare('UPDATE sessions SET name = ? WHERE id = ?')
const setArchived = db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?')
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
 */
function cellCount(sessionId: string, live: boolean): number {
  try {
    if (live) return getCells(getSessionDoc(sessionId).doc).length
    const snapshot = loadDocSnapshot(sessionId)
    if (!snapshot) return 0
    const doc = new Y.Doc()
    Y.applyUpdate(doc, snapshot)
    const count = getCells(doc).length
    doc.destroy()
    return count
  } catch {
    // A card with a zero on it is better than a list that will not load.
    return 0
  }
}

/** listFiles, not a bare readdir: the number on the card has to be the number the Files panel shows. */
function fileCount(sessionId: string): number {
  try {
    return listFiles(sessionId).length
  } catch {
    return 0
  }
}

function statusOf(liveCount: number, totalParticipants: number): SeminarStatus {
  if (liveCount > 0) return 'live'
  // Nobody has ever joined: the link was made and never used.
  return totalParticipants === 0 ? 'draft' : 'ended'
}

function toSeminar(row: SeminarRow): AdminSeminar {
  // Open collab sockets, which is the only "who is here right now" the server
  // actually holds (collab/index.ts). A second tab counts twice; the control
  // socket keeps no per-session tally to cross-check against.
  const liveCount = onlineCount(row.id)
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    status: statusOf(liveCount, row.participants),
    liveCount,
    totalParticipants: row.participants,
    cellCount: cellCount(row.id, liveCount > 0),
    fileCount: fileCount(row.id),
    url: `${config.publicUrl}/s/${row.id}`,
    /*
     * Что комната РЕАЛЬНО запустила, если ядро уже поднялось; иначе — что она
     * попросила при создании. Разница видна ровно тогда, когда она важна:
     * семинар, переживший переключение, продолжает работать на старом образе.
     */
    environment: environmentOf(row.id) ?? sessionEnvironment(row.id),
    createdBy: row.created_by,
    archivedAt: row.archived_at,
  }
}

/* ------------------------------------------------------------------ input */

/** Collapse whitespace and drop control characters so a name cannot break the list layout. */
function normalize(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

function invalid(res: Response, error: string): Response {
  const body: AdminErrorBody = { error, reason: 'invalid' }
  return res.status(400).json(body)
}

function notFound(res: Response): Response {
  const body: AdminErrorBody = { error: 'that seminar no longer exists', reason: 'invalid' }
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
    res.json(rows.map(toSeminar))
  })

  router.post('/api/admin/seminars', requireStaff, (req, res) => {
    const name = normalize(req.body?.name)
    if (!name) return invalid(res, 'a seminar name is required')
    if (name.length > LIMITS.seminarName) {
      return invalid(res, `a seminar name must be ${LIMITS.seminarName} characters or fewer`)
    }

    /*
     * Окружение проверяется, а не принимается на слово: имя становится тегом
     * образа и именем контейнера, и оно приходит из браузера. Несуществующее
     * имя лучше отвергнуть здесь, чем обнаружить, когда комната уже полна.
     */
    const wanted = typeof req.body?.environment === 'string' ? req.body.environment.trim() : ''
    if (wanted && (!ENVIRONMENT_NAME.test(wanted) || !environmentExists(wanted))) {
      return invalid(res, `there is no environment called "${wanted}"`)
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

    const id = newSessionId()
    createSession(id, name, environment)
    /*
     * Rules are written at creation and not before: there is no draft row to
     * hold them, so a seminar exists the moment it is created and it exists
     * with the rules it was created under. readRules() inside setRules fills in
     * anything the form did not send, so a caller that knows nothing about
     * rules — a script, an older client — still produces the open room the
     * product has always been.
     */
    if (req.body?.rules && typeof req.body.rules === 'object') {
      setRules(id, readRules(req.body.rules))
    }
    const staff = currentStaff(req)
    if (staff) setSeminarCreator(id, staff.name)

    const row = selectSeminar.get(id) as SeminarRow
    res.status(201).json(toSeminar(row))
  })

  router.patch('/api/admin/seminars/:id', requireStaff, (req, res) => {
    const row = seminarOr404(req, res)
    if (!row) return

    const body = req.body as { name?: unknown; archived?: unknown; rules?: unknown } | undefined
    if (body?.name !== undefined) {
      const name = normalize(body.name)
      if (!name) return invalid(res, 'a seminar name is required')
      if (name.length > LIMITS.seminarName) {
        return invalid(res, `a seminar name must be ${LIMITS.seminarName} characters or fewer`)
      }
      renameSeminar.run(name, row.id)
      // ...and into the room, whose header reads the document rather than this
      // row. Without it a rename in the panel never reached the people inside,
      // and the seminar quietly had two names.
      getMeta(getSessionDoc(row.id).doc).set('title', name)
    }
    if (body?.archived !== undefined) {
      if (typeof body.archived !== 'boolean') return invalid(res, 'archived must be true or false')
      // Archiving is a label on the list, not a lock: a room with people still
      // in it keeps working, which is why nothing here touches the document.
      setArchived.run(body.archived ? Date.now() : null, row.id)
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
        return invalid(res, 'rules must be an object')
      }
      setRules(row.id, readRules({ ...getRules(row.id), ...(body.rules as object) }))
      // The room finds out now, not on its next reload: the panel greys its
      // controls from this, and a rule nobody was told about is a rule that
      // looks like a bug when a button stops working.
      broadcast(row.id, { t: 'rules', rules: getRules(row.id) })
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
   * The live room is torn down before the rows go, in that order: the kernel
   * stops writing output, the document is evicted without a final flush and the
   * sockets are closed. Deleting the rows first would leave both of those
   * writing into a seminar that no longer exists — the snapshot would simply
   * come back.
   */
  router.delete('/api/admin/seminars/:id', ownerOnly('delete a seminar'), (req, res) => {
    const row = seminarOr404(req, res)
    if (!row) return
    // Awaited in order, because every one of these writers gets at the document
    // through getSessionDoc(), which creates one on demand: stopping them after
    // the eviction would rebuild the room and save a snapshot of it.
    void (async () => {
      try {
        closeControlRoom(row.id)
        await shutdownSession(row.id)
        dropSessionDoc(row.id)

        const purge = db.transaction((id: string) => {
          deleteParticipants.run(id)
          deleteSnapshot.run(id)
          // The history is the notebook, in full, one keyframe at a time. A
          // seminar deleted with it left behind is a seminar the dialog said
          // was gone and whose every cell is still on disk — and still served
          // over HTTP to anyone holding an old token.
          discardHistory(id)
          deleteSeminarRow.run(id)
        })
        purge(row.id)
        forgetCache(row.id)

        try {
          fs.rmSync(sessionDir(row.id), { recursive: true, force: true })
        } catch (err) {
          // The row is already gone; a workspace we could not remove is a stray
          // directory, not a half-deleted seminar.
          console.warn(`[admin] could not remove workspace for ${row.id}:`, err instanceof Error ? err.message : err)
        }

        res.status(204).end()
      } catch (err) {
        console.error(`[admin] deleting ${row.id} failed:`, err instanceof Error ? err.message : err)
        if (!res.headersSent) res.status(500).json({ error: 'the seminar could not be deleted', reason: 'invalid' } satisfies AdminErrorBody)
      }
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
  router.put('/api/admin/oracle', ownerOnly('change the oracle settings'), (req, res) => {
    const parsed = parseOraclePatch(req.body)
    if ('error' in parsed) return invalid(res, parsed.error)
    // The response is the masked settings, like the GET: the key goes in and is
    // never handed back, not even to the teacher who just typed it.
    res.json(updateOracleSettings(parsed.patch))
  })

  // Owner-only for the same reason: this is the button that makes the server
  // send a request, with the key attached, to whatever host is configured.
  router.post('/api/admin/oracle/test', ownerOnly('test the oracle connection'), (_req, res) => {
    void testConnection().then(
      (result) => res.json(result),
      (err: unknown) => {
        // testConnection turns failures into results; reaching here means the
        // call itself broke, which is still a sentence and not a 500.
        console.error('[admin] oracle test failed:', err instanceof Error ? err.message : err)
        const broke: OracleTestResult = {
          ok: false,
          ms: null,
          message: 'The test could not be run — check the server logs.',
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
