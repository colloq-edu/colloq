/**
 * The staff audit log: who on the staff did what, and when.
 *
 * A university's data-protection officer asks two questions of a system like
 * this: what personal data leaves it (ai/names.ts answers that one) and who did
 * what in the admin panel. Until 0.9 the second had no answer at all: a
 * sign-in, a teacher removed, a room deleted, a new model key — none of it left
 * a trace anywhere. This table is that trace.
 *
 * HOW TO RECORD — the only way to write here:
 *
 *   import { recordAdminEvent } from '../admin/audit-log.js'
 *
 *   recordAdminEvent({
 *     actor: currentStaff(req),                          // the Teacher doing it
 *     action: 'room.deleted',                            // AdminAuditAction (shared/admin.ts)
 *     target: { type: 'room', id: row.id, label: row.name },
 *     detail: { reading: 'kept' },                       // optional: small and flat
 *     req,                                               // optional: only its address is kept
 *   })
 *
 * - Call it AFTER the action succeeded, never on a refusal: the log says what
 *   happened, and "tried to" would be a different log.
 * - It never throws: a full disk must not turn a finished deletion into a 500.
 *   A failure is one line in the journal, naming the action only.
 * - It never stores a secret. An API key, a sign-in key or a token goes in as
 *   'set' / 'cleared' / 'replaced' at most, and a detail key that looks like a
 *   secret (…key, …token, …secret, …password) with any other value is stored
 *   as '[redacted]' — a guard against a careless call, not a licence for one.
 *   A password inside a URL (`https://user:secret@host/…`, as private package
 *   indexes and model endpoints are sometimes written) is masked in any
 *   string that is stored.
 * - For a person who is not staff (a competition entrant, a student) pass the
 *   id as the target and no label: this log is about the staff's
 *   accountability, and it must not become a second copy of students' names.
 *   (The competitions package's entrant deletion is wired this way:
 *   `{ type: 'entrant', id: entrantId }`, action 'competition.entrant_deleted'.)
 *
 * What is NOT here: anything students do. That is the room's own activity
 * (server/src/activity.ts), with its own limits.
 *
 * APPEND-ONLY. This module has no update and no delete besides retention, and
 * the database refuses both by trigger — an UPDATE always, a DELETE of anything
 * younger than the retention (less a day, so the pruning below never trips
 * over it). Retention is one year: pruned at start and once a day. Owners read
 * the log through `GET /api/admin/audit-log` (routes/admin-audit.ts).
 */
import type { IncomingHttpHeaders } from 'node:http'
import { addressOf } from '../bans.js'
import { db } from '../db.js'
import type {
  AdminAuditAction,
  AdminAuditEvent,
  AdminAuditPage,
  AdminAuditTargetType,
  AdminAuditValue,
  AdminRole,
} from '@shared/admin'

export const AUDIT_RETENTION_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_MS = AUDIT_RETENTION_DAYS * DAY_MS

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            INTEGER NOT NULL,
    actor_id      TEXT,
    actor_name    TEXT,
    actor_email   TEXT,
    actor_role    TEXT,
    action        TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    target_label  TEXT,
    detail        TEXT,
    ip            TEXT
  );
  CREATE INDEX IF NOT EXISTS admin_audit_log_at ON admin_audit_log(at);
`)

/*
 * Recreated on every start, not IF NOT EXISTS: the retention written into the
 * trigger must be the one in this file, and a trigger left by an older build
 * with another number would refuse this build's pruning or let it go too far.
 */
db.exec(`
  DROP TRIGGER IF EXISTS admin_audit_log_no_update;
  CREATE TRIGGER admin_audit_log_no_update BEFORE UPDATE ON admin_audit_log
  BEGIN
    SELECT RAISE(ABORT, 'admin_audit_log is append-only');
  END;
  DROP TRIGGER IF EXISTS admin_audit_log_keeps_a_year;
  CREATE TRIGGER admin_audit_log_keeps_a_year BEFORE DELETE ON admin_audit_log
  WHEN old.at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - ${RETENTION_MS - DAY_MS}
  BEGIN
    SELECT RAISE(ABORT, 'admin_audit_log keeps events for a year');
  END;
`)

const insertEvent = db.prepare(`
  INSERT INTO admin_audit_log
    (at, actor_id, actor_name, actor_email, actor_role, action, target_type, target_id, target_label, detail, ip)
  VALUES
    (@at, @actor_id, @actor_name, @actor_email, @actor_role, @action, @target_type, @target_id, @target_label, @detail, @ip)
`)
const selectLatest = db.prepare('SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT ?')
const selectBefore = db.prepare('SELECT * FROM admin_audit_log WHERE id < ? ORDER BY id DESC LIMIT ?')
const deleteOlder = db.prepare('DELETE FROM admin_audit_log WHERE at < ?')

interface AuditRow {
  id: number
  at: number
  actor_id: string | null
  actor_name: string | null
  actor_email: string | null
  actor_role: string | null
  action: string
  target_type: string | null
  target_id: string | null
  target_label: string | null
  detail: string | null
  ip: string | null
}

export interface AdminEventInput {
  /** Who did it — a `Teacher` fits. `null` only when no signed-in person caused it. */
  actor: { id: string; name: string; email?: string | null; role?: AdminRole | null } | null | undefined
  action: AdminAuditAction
  target?: { type: AdminAuditTargetType; id?: string | null; label?: string | null } | null
  detail?: Record<string, AdminAuditValue | undefined> | null
  /** The request, for its address only. */
  req?: { headers: IncomingHttpHeaders; socket?: { remoteAddress?: string | undefined } } | null
}

/** Names of detail keys whose value is a secret unless it only says what happened to one. */
const SECRET_KEY = /(key|token|secret|password)$/i
const SAFE_SECRET_VALUES = new Set(['set', 'cleared', 'replaced', 'unchanged'])

/*
 * A detail is a few facts, not a document. The caps keep one careless call —
 * a whole package list, a house-rules essay — from turning a row into a page.
 */
const MAX_TEXT = 300
const MAX_LIST = 50
const MAX_DETAIL = 4_000

/** `https://user:secret@host` → `https://***@host`: the credentials go, the address stays readable. */
function maskUrlCredentials(value: string): string {
  return value.replace(/(\/\/)[^/@\s]+@/g, '$1***@')
}

function clampText(value: string, limit = MAX_TEXT): string {
  const masked = maskUrlCredentials(value)
  return masked.length > limit ? `${masked.slice(0, limit - 1)}…` : masked
}

function cleanValue(value: AdminAuditValue): AdminAuditValue {
  if (typeof value === 'string') return clampText(value)
  if (Array.isArray(value)) {
    const items = (value as readonly string[]).slice(0, MAX_LIST).map((item) => clampText(String(item)))
    return value.length > MAX_LIST ? [...items, `… +${value.length - MAX_LIST}`] : items
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

function cleanDetail(detail: AdminEventInput['detail']): string | null {
  if (!detail) return null
  const out: Record<string, AdminAuditValue> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue
    const harmless = typeof value === 'boolean' || value === null || (typeof value === 'string' && SAFE_SECRET_VALUES.has(value))
    out[key] = SECRET_KEY.test(key) && !harmless ? '[redacted]' : cleanValue(value)
  }
  if (Object.keys(out).length === 0) return null
  const json = JSON.stringify(out)
  // Over the cap the facts are cut to their names: which fields changed is
  // still an answer, a half-written JSON is not.
  return json.length <= MAX_DETAIL ? json : JSON.stringify({ truncated: true, fields: Object.keys(out).slice(0, MAX_LIST) })
}

/** Record one staff action. Never throws; see the header for the rules. */
export function recordAdminEvent(event: AdminEventInput): void {
  try {
    insertEvent.run({
      at: Date.now(),
      actor_id: event.actor?.id ?? null,
      actor_name: event.actor ? clampText(event.actor.name) : null,
      actor_email: event.actor?.email ? clampText(event.actor.email) : null,
      actor_role: event.actor?.role ?? null,
      action: event.action,
      target_type: event.target?.type ?? null,
      target_id: event.target?.id ?? null,
      target_label: event.target?.label ? clampText(event.target.label, 200) : null,
      detail: cleanDetail(event.detail),
      ip: event.req ? addressOf(event.req) : null,
    })
  } catch (err) {
    // The action itself has already happened; failing it now would lie about that.
    console.error(`[audit] could not record ${event.action}:`, err instanceof Error ? err.message : err)
  }
}

function parseDetail(raw: string | null): Record<string, AdminAuditValue> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, AdminAuditValue>) : null
  } catch {
    return null
  }
}

function toEvent(row: AuditRow): AdminAuditEvent {
  return {
    id: row.id,
    at: row.at,
    actor:
      row.actor_id === null
        ? null
        : {
            id: row.actor_id,
            name: row.actor_name ?? '',
            email: row.actor_email ?? '',
            role: row.actor_role === 'owner' || row.actor_role === 'teacher' ? row.actor_role : null,
          },
    action: row.action,
    target:
      row.target_type === null ? null : { type: row.target_type, id: row.target_id, label: row.target_label },
    detail: parseDetail(row.detail),
    ip: row.ip,
  }
}

export const AUDIT_PAGE_DEFAULT = 50
export const AUDIT_PAGE_MAX = 200

/**
 * One page, newest first. `before` is the id the previous page ended on: ids
 * only grow, so a page is stable while new events keep arriving above it —
 * an offset would shift by one with every sign-in and show a row twice.
 */
export function listAdminEvents(options: { before?: number | null; limit?: number } = {}): AdminAuditPage {
  const asked = Math.trunc(options.limit ?? AUDIT_PAGE_DEFAULT)
  const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : AUDIT_PAGE_DEFAULT, 1), AUDIT_PAGE_MAX)
  const before = options.before ?? null
  const rows = (
    before !== null && before > 0 ? selectBefore.all(before, limit + 1) : selectLatest.all(limit + 1)
  ) as AuditRow[]
  const events = rows.slice(0, limit).map(toEvent)
  return {
    events,
    next: rows.length > limit ? events[events.length - 1].id : null,
    retentionDays: AUDIT_RETENTION_DAYS,
  }
}

/** Forget what is older than the retention. Returns how many events went. */
export function pruneAdminEvents(now = Date.now()): number {
  try {
    return deleteOlder.run(now - RETENTION_MS).changes
  } catch (err) {
    console.error('[audit] pruning failed:', err instanceof Error ? err.message : err)
    return 0
  }
}

// At start and then daily. Unref'd: a timer is no reason to keep the process up.
pruneAdminEvents()
const pruneTimer = setInterval(() => pruneAdminEvents(), DAY_MS)
pruneTimer.unref?.()
