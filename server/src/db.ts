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

  -- The assistant thread moved into the session document, where the whole room
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
