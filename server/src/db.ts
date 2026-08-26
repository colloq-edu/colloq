import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'
import { colorForId, type Participant, type SessionInfo } from '@shared/protocol'

fs.mkdirSync(config.dataDir, { recursive: true })

export const db = new Database(path.join(config.dataDir, 'colloq.db'))
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS participants (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    avatar      TEXT,
    color       TEXT NOT NULL,
    role        TEXT NOT NULL,
    last_seen   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS participants_session ON participants(session_id);

  CREATE TABLE IF NOT EXISTS doc_snapshots (
    session_id  TEXT PRIMARY KEY,
    data        BLOB NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  /*
   * Every version of every notebook, as the bytes that produced it.
   *
   * One row is one *edit* — a burst of typing by one person — not one
   * keystroke: the recorder merges a burst in memory and writes it once. A
   * ninety-minute seminar produces a few dozen rows, not a few thousand.
   *
   * update_blob is a Yjs update. For an edit row it carries only that burst;
   * for a keyframe row it carries the whole document, so materialising an
   * old version replays a bounded number of updates onto the nearest keyframe
   * instead of the entire history.
   *
   * Kept separate from doc_snapshots on purpose. That table answers "what is
   * the notebook now" and is overwritten constantly; this one is append-only
   * and answers "what was it then". A single table would have to be both.
   */
  CREATE TABLE IF NOT EXISTS doc_history (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    update_blob BLOB NOT NULL,
    kind        TEXT NOT NULL,
    author_id   TEXT,
    created_at  INTEGER NOT NULL,
    label       TEXT,
    summary     TEXT NOT NULL DEFAULT '',
    added       INTEGER NOT NULL DEFAULT 0,
    removed     INTEGER NOT NULL DEFAULT 0,
    cells       TEXT NOT NULL DEFAULT '[]'
  );
  /* Every read is "this session, in order", which is exactly this index. */
  CREATE INDEX IF NOT EXISTS doc_history_session ON doc_history(session_id, seq);

  -- The oracle thread moved into the session document, where the whole room
  -- can read it; doc_snapshots persists it now. Installs from before that keep
  -- a private per-person transcript on disk until this runs.
  DROP TABLE IF EXISTS ai_messages;
`)

/**
 * The environment a seminar was created with.
 *
 * Chosen once, at creation, and then it is that room's Python for good: a
 * seminar whose packages changed under it mid-class is worse than one that
 * never had the newest ones. Null means "whatever the instance runs", which is
 * what every seminar made before environments existed has.
 *
 * Guarded by table_info rather than a migration framework — one ALTER, and
 * SQLite has no ADD COLUMN IF NOT EXISTS.
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}
ensureColumn('sessions', 'environment', 'environment TEXT')

/* ------------------------------------------------------------- sessions */

const insertSession = db.prepare(
  'INSERT INTO sessions (id, name, created_at, environment) VALUES (?, ?, ?, ?)',
)
const selectEnvironment = db.prepare('SELECT environment FROM sessions WHERE id = ?')
const selectSession = db.prepare('SELECT id, name, created_at FROM sessions WHERE id = ?')

interface SessionRow {
  id: string
  name: string
  created_at: number
}

export function createSession(id: string, name: string, environment?: string | null): SessionInfo {
  const createdAt = Date.now()
  insertSession.run(id, name, createdAt, environment ?? null)
  return { id, name, createdAt }
}

/**
 * Which environment this room asked for, or null for "whatever the instance
 * runs". Read on every kernel start rather than cached: an operator can change
 * the row, and the answer decides which container the room talks to.
 */
export function sessionEnvironment(id: string): string | null {
  const row = selectEnvironment.get(id) as { environment: string | null } | undefined
  return row?.environment ?? null
}

const renameSessionStmt = db.prepare('UPDATE sessions SET name = ? WHERE id = ?')

/**
 * Keeps the row in step with the room's own title.
 *
 * The seminar's name lives in two places — this row, which the admin list reads,
 * and `meta.title` in the shared document, which the header shows and the host
 * can edit in place. They used to drift in both directions: renaming in the
 * panel never reached the room, and renaming in the room never reached the
 * panel, so one seminar quietly had two names.
 *
 * The document is the source of truth and this mirrors it. One writer, one
 * direction.
 */
export function renameSession(id: string, name: string): void {
  renameSessionStmt.run(name, id)
}

export function getSession(id: string): SessionInfo | null {
  const row = selectSession.get(id) as SessionRow | undefined
  return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null
}

/* --------------------------------------------------------- participants */

const upsertParticipantStmt = db.prepare(`
  INSERT INTO participants (id, session_id, name, avatar, color, role, last_seen)
  VALUES (@id, @session_id, @name, @avatar, @color, @role, @last_seen)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    avatar = excluded.avatar,
    role = excluded.role,
    last_seen = excluded.last_seen
`)
const selectParticipant = db.prepare('SELECT * FROM participants WHERE id = ? AND session_id = ?')
const selectParticipants = db.prepare(
  'SELECT * FROM participants WHERE session_id = ? ORDER BY last_seen DESC',
)
const touchParticipant = db.prepare('UPDATE participants SET last_seen = ? WHERE id = ?')

interface ParticipantRow {
  id: string
  session_id: string
  name: string
  avatar: string | null
  color: string
  role: string
  last_seen: number
}

function toParticipant(row: ParticipantRow): Participant {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    color: row.color,
    role: row.role === 'host' ? 'host' : 'participant',
  }
}

export function upsertParticipant(p: {
  id: string
  sessionId: string
  name: string
  avatar: string | null
  role: Participant['role']
}): Participant {
  const existing = selectParticipant.get(p.id, p.sessionId) as ParticipantRow | undefined
  const color = existing?.color ?? colorForId(p.id)
  upsertParticipantStmt.run({
    id: p.id,
    session_id: p.sessionId,
    name: p.name,
    avatar: p.avatar,
    color,
    role: p.role,
    last_seen: Date.now(),
  })
  return { id: p.id, name: p.name, avatar: p.avatar, color, role: p.role }
}

export function getParticipant(sessionId: string, participantId: string): Participant | null {
  const row = selectParticipant.get(participantId, sessionId) as ParticipantRow | undefined
  return row ? toParticipant(row) : null
}

export function listParticipants(sessionId: string): Participant[] {
  return (selectParticipants.all(sessionId) as ParticipantRow[]).map(toParticipant)
}

export function touchLastSeen(participantId: string): void {
  touchParticipant.run(Date.now(), participantId)
}

/* ------------------------------------------------------- doc snapshots */

const upsertSnapshot = db.prepare(`
  INSERT INTO doc_snapshots (session_id, data, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`)
const selectSnapshot = db.prepare('SELECT data FROM doc_snapshots WHERE session_id = ?')

export function saveDocSnapshot(sessionId: string, update: Uint8Array): void {
  upsertSnapshot.run(sessionId, Buffer.from(update), Date.now())
}

export function loadDocSnapshot(sessionId: string): Uint8Array | null {
  const row = selectSnapshot.get(sessionId) as { data: Buffer } | undefined
  return row ? new Uint8Array(row.data) : null
}

/* ---------------------------------------------------------------- history */

const insertVersion = db.prepare(`
  INSERT INTO doc_history
    (session_id, update_blob, kind, author_id, created_at, label, summary, added, removed, cells)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

export interface VersionRow {
  seq: number
  kind: string
  author_id: string | null
  created_at: number
  label: string | null
  summary: string
  added: number
  removed: number
  cells: string
}

export function appendVersion(input: {
  sessionId: string
  update: Uint8Array
  kind: string
  authorId: string | null
  createdAt: number
  label: string | null
  summary: string
  added: number
  removed: number
  cells: string[]
}): number {
  const result = insertVersion.run(
    input.sessionId,
    Buffer.from(input.update),
    input.kind,
    input.authorId,
    input.createdAt,
    input.label,
    input.summary,
    input.added,
    input.removed,
    JSON.stringify(input.cells),
  )
  return Number(result.lastInsertRowid)
}

const selectVersions = db.prepare(`
  SELECT seq, kind, author_id, created_at, label, summary, added, removed, cells
  FROM doc_history WHERE session_id = ? ORDER BY seq DESC LIMIT ?
`)

export function listVersions(sessionId: string, limit: number): VersionRow[] {
  return selectVersions.all(sessionId, limit) as VersionRow[]
}

const selectOneVersion = db.prepare(`
  SELECT seq, kind, author_id, created_at, label, summary, added, removed, cells
  FROM doc_history WHERE session_id = ? AND seq = ?
`)

export function getVersion(sessionId: string, seq: number): VersionRow | null {
  return (selectOneVersion.get(sessionId, seq) as VersionRow | undefined) ?? null
}

/*
 * The bytes needed to rebuild the state as of `seq`: the newest keyframe at or
 * below it, then every update after that keyframe up to and including it. The
 * keyframe row's own blob is a whole document, so the replay starts there
 * rather than at the beginning of the seminar.
 */
const selectKeyframeAt = db.prepare(`
  SELECT seq FROM doc_history
  WHERE session_id = ? AND seq <= ? AND kind = 'keyframe'
  ORDER BY seq DESC LIMIT 1
`)

const selectRange = db.prepare(`
  SELECT update_blob FROM doc_history
  WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC
`)

export function updatesUpTo(sessionId: string, seq: number): Uint8Array[] {
  const keyframe = selectKeyframeAt.get(sessionId, seq) as { seq: number } | undefined
  const from = keyframe ? keyframe.seq : 0
  const rows = selectRange.all(sessionId, from, seq) as { update_blob: Buffer }[]
  return rows.map((row) => new Uint8Array(row.update_blob))
}

const countVersions = db.prepare(
  `SELECT COUNT(*) AS n FROM doc_history WHERE session_id = ?`,
)

export function versionCount(sessionId: string): number {
  return (countVersions.get(sessionId) as { n: number }).n
}

const countBases = db.prepare(
  `SELECT COUNT(*) AS n FROM doc_history
   WHERE session_id = ? AND kind IN ('opened', 'keyframe')`,
)

/**
 * Does this room's history have anything to replay *from*?
 *
 * Every other row is a delta. Without at least one row carrying a whole
 * document, rebuilding any version applies changes to an empty notebook and
 * returns an empty notebook — quietly, with no error anywhere.
 */
export function hasHistoryBase(sessionId: string): boolean {
  return (countBases.get(sessionId) as { n: number }).n > 0
}

const dropHistory = db.prepare(`DELETE FROM doc_history WHERE session_id = ?`)

/** A deleted seminar takes its history with it. */
export function discardHistory(sessionId: string): void {
  dropHistory.run(sessionId)
}
