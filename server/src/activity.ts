import {
  ACTIVITY_KIND_LEVEL, ACTIVITY_LEVELS,
  type ActivityCategory, type ActivityDetails, type ActivityEvent, type ActivityKind,
  type ActivityLevel, type ActivityList,
} from '@shared/activity'
import type { ParticipantRole } from '@shared/protocol'
import { db, getParticipant } from './db.js'

db.transaction(() => {
  const hadTotals = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activity_totals'").get()

  /** Metadata only; notebook snapshots and Oracle transcripts have separate storage. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_activity (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      level INTEGER NOT NULL,
      actor_id TEXT,
      actor_name TEXT,
      actor_role TEXT,
      details TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_room_seq ON session_activity(session_id, seq DESC);
    CREATE TABLE IF NOT EXISTS activity_retention (
      session_id TEXT PRIMARY KEY,
      trimmed INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS activity_totals (
      session_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT,
      actor_role TEXT,
      subject_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      outcome TEXT NOT NULL,
      source TEXT NOT NULL,
      events INTEGER NOT NULL,
      items INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, actor_id, subject_id, kind, outcome, source)
    );
  `)

  // A running installation may already have the initial metadata-only schema.
  const retentionColumns = db.pragma('table_info(activity_retention)') as { name: string }[]
  if (!retentionColumns.some(column => column.name === 'event_count')) {
    db.exec(`ALTER TABLE activity_retention ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0;
      INSERT INTO activity_retention(session_id, event_count)
        SELECT session_id, COUNT(*) FROM session_activity GROUP BY session_id
        ON CONFLICT(session_id) DO UPDATE SET event_count = excluded.event_count;`)
  }
  db.exec(`
    DROP TRIGGER IF EXISTS activity_delete_session;
    CREATE TRIGGER activity_delete_session AFTER DELETE ON sessions BEGIN
      DELETE FROM session_activity WHERE session_id = OLD.id;
      DELETE FROM activity_retention WHERE session_id = OLD.id;
      DELETE FROM activity_totals WHERE session_id = OLD.id;
    END;
  `)

  if (!hadTotals) {
    // Recover every available event once; discarded rows cannot be reconstructed.
    db.exec(`INSERT OR IGNORE INTO activity_totals
      (session_id, actor_id, actor_name, actor_role, subject_id, kind, outcome, source,
        events, items, duration_ms, first_at, last_at)
      SELECT session_id, COALESCE(actor_id, ''), MAX(actor_name), MAX(actor_role),
        COALESCE(json_extract(details, '$.subjectId'), ''), kind,
        COALESCE(json_extract(details, '$.outcome'), ''), COALESCE(json_extract(details, '$.source'), 'participant'),
        COUNT(*), SUM(COALESCE(json_extract(details, '$.count'), 1)),
        SUM(COALESCE(json_extract(details, '$.durationMs'), 0)), MIN(created_at), MAX(created_at)
      FROM session_activity GROUP BY session_id, COALESCE(actor_id, ''),
        COALESCE(json_extract(details, '$.subjectId'), ''), kind,
        COALESCE(json_extract(details, '$.outcome'), ''), COALESCE(json_extract(details, '$.source'), 'participant');`)
  }
})()

export const ACTIVITY_MAX_EVENTS = 10_000
const insert = db.prepare(`INSERT INTO session_activity
  (session_id, created_at, kind, level, actor_id, actor_name, actor_role, details)
  SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)`)
const trim = db.prepare(`DELETE FROM session_activity WHERE session_id = ? AND seq <= (
  SELECT seq FROM session_activity WHERE session_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?
)`)
const noteTrim = db.prepare(`INSERT INTO activity_retention(session_id, trimmed) VALUES (?, 1)
  ON CONFLICT(session_id) DO UPDATE SET trimmed = 1`)
const countEvent = db.prepare(`INSERT INTO activity_retention(session_id, event_count) VALUES (?, 1)
  ON CONFLICT(session_id) DO UPDATE SET event_count = event_count + 1 RETURNING event_count`)
const totalEvent = db.prepare(`INSERT INTO activity_totals
  (session_id, actor_id, actor_name, actor_role, subject_id, kind, outcome, source, events, items, duration_ms, first_at, last_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  ON CONFLICT(session_id, actor_id, subject_id, kind, outcome, source) DO UPDATE SET
    actor_name = excluded.actor_name, actor_role = excluded.actor_role,
    events = events + 1, items = items + excluded.items,
    duration_ms = duration_ms + excluded.duration_ms, last_at = excluded.last_at`)

/** A strict allowlist prevents a caller accidentally persisting a prompt, key or code. */
function metadata(input: ActivityDetails): ActivityDetails {
  const out: ActivityDetails = {}
  if (['ask', 'explain', 'fix', 'debug', 'improve', 'hint', 'edit', 'work'].includes(input.action ?? '')) out.action = input.action
  for (const key of ['cellId', 'entryId', 'subjectId'] as const) {
    if (typeof input[key] === 'string') out[key] = input[key]!.slice(0, 128)
  }
  if (Number.isSafeInteger(input.count) && input.count! >= 0) out.count = Math.min(input.count!, 100_000)
  if (Number.isSafeInteger(input.requestSeq) && input.requestSeq! > 0) out.requestSeq = input.requestSeq
  if (Number.isSafeInteger(input.versionSeq) && input.versionSeq! > 0) out.versionSeq = input.versionSeq
  if (Number.isSafeInteger(input.durationMs) && input.durationMs! >= 0) out.durationMs = input.durationMs
  if (input.source === 'participant' || input.source === 'oracle') out.source = input.source
  if (['completed', 'cancelled', 'error'].includes(input.outcome ?? '')) out.outcome = input.outcome
  if (['disconnected', 'server_shutdown'].includes(input.reason ?? '')) out.reason = input.reason
  return out
}

export function trimActivity(sessionId: string, keep = ACTIVITY_MAX_EVENTS): number {
  const removed = trim.run(sessionId, sessionId, Math.max(0, Math.floor(keep))).changes
  if (removed) {
    noteTrim.run(sessionId)
    db.prepare('UPDATE activity_retention SET event_count = MAX(0, event_count - ?) WHERE session_id = ?').run(removed, sessionId)
  }
  return removed
}

const write = db.transaction((sessionId: string, participantId: string | null, kind: ActivityKind,
  details: ActivityDetails, role?: ParticipantRole): number | null => {
  const actor = participantId ? getParticipant(sessionId, participantId) : null
  const at = Date.now()
  const clean = metadata(details)
  const result = insert.run(sessionId, at, kind, ACTIVITY_LEVELS.indexOf(ACTIVITY_KIND_LEVEL[kind]),
    participantId, actor?.name.slice(0, 120) ?? null, role ?? actor?.role ?? null,
    JSON.stringify(clean), sessionId)
  if (!result.changes) return null
  totalEvent.run(sessionId, participantId ?? '', actor?.name.slice(0, 120) ?? null, role ?? actor?.role ?? null,
    clean.subjectId ?? '', kind, clean.outcome ?? '', clean.source ?? 'participant', clean.count ?? 1,
    clean.durationMs ?? 0, at, at)
  const { event_count: count } = countEvent.get(sessionId) as { event_count: number }
  // Drop a small batch: the indexed 10k-row walk happens once per hundred events.
  if (count > ACTIVITY_MAX_EVENTS) trimActivity(sessionId, ACTIVITY_MAX_EVENTS - 100)
  return Number(result.lastInsertRowid)
})

/** Recording must never prevent joining, running a cell or finishing an AI answer. */
export function appendActivity(sessionId: string, participantId: string | null, kind: ActivityKind,
  details: ActivityDetails = {}, role?: ParticipantRole): number | null {
  try { return write(sessionId, participantId, kind, details, role) }
  catch { console.warn('[activity] Could not record an activity event'); return null }
}

/** Aggregation is per room identity, never inferred from names or browser devices. */
export function activitySummary(sessionId: string) {
  const rows = db.prepare('SELECT * FROM activity_totals WHERE session_id = ? ORDER BY actor_id, kind, outcome, source, subject_id').all(sessionId) as {
    actor_id: string; actor_name: string | null; actor_role: ParticipantRole | null; subject_id: string;
    kind: ActivityKind; outcome: string; source: string; events: number; items: number;
    duration_ms: number; first_at: number; last_at: number;
  }[]
  return { summaries: rows.map(row => ({
    actor: row.actor_id ? { id: row.actor_id, name: row.actor_name ?? row.actor_id, role: row.actor_role ?? 'participant' } : null,
    subjectId: row.subject_id || null, kind: row.kind, outcome: row.outcome || null, source: row.source,
    events: row.events, items: row.items, durationMs: row.duration_ms, firstAt: row.first_at, lastAt: row.last_at,
  })) }
}

interface Row {
  seq: number; created_at: number; kind: ActivityKind; level: number
  actor_id: string | null; actor_name: string | null; actor_role: ParticipantRole | null; details: string
}
export function listActivity(sessionId: string, options: {
  level?: ActivityLevel; category?: ActivityCategory; before?: number; limit?: number
} = {}): ActivityList {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)))
  const category = options.category ?? 'all'
  const prefix = category === 'runtime' ? 'execution' : category
  const rows = db.prepare(`SELECT * FROM session_activity WHERE session_id = ? AND level <= ?
    AND seq < ? AND (? = 'all' OR kind LIKE ?) ORDER BY seq DESC LIMIT ?`).all(
    sessionId, ACTIVITY_LEVELS.indexOf(options.level ?? 'normal'), options.before ?? Number.MAX_SAFE_INTEGER,
    category, `${prefix}.%`, limit + 1,
  ) as Row[]
  const more = rows.length > limit
  const events: ActivityEvent[] = rows.slice(0, limit).map(row => ({
    seq: row.seq, createdAt: row.created_at, kind: row.kind, level: ACTIVITY_LEVELS[row.level],
    actor: row.actor_id ? { id: row.actor_id, name: row.actor_name ?? row.actor_id, role: row.actor_role ?? 'participant' } : null,
    details: JSON.parse(row.details),
  }))
  const retention = db.prepare('SELECT trimmed FROM activity_retention WHERE session_id = ?').get(sessionId) as { trimmed: number } | undefined
  return { events, nextBefore: more ? events[events.length - 1].seq : null, trimmed: !!retention?.trimmed }
}
