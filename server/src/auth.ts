import crypto from 'node:crypto'
import { config } from './config.js'
import { staffAuthorizationVersion } from './admin/store.js'
import type { ParticipantRole } from '@shared/protocol'

export interface TokenPayload {
  sessionId: string
  participantId: string
  role: ParticipantRole
  /**
   * When this token was minted, in milliseconds.
   *
   * There is no account system to revoke against, so a token that never
   * expires is a capability handed out for good: a student who joined in
   * September can still open the room's files in May, and a token that leaked
   * into a chat log leaked forever. An age limit is the only revocation a
   * stateless credential can have. Absent on tokens minted before this
   * existed — those are read as ageless rather than refused, because a room
   * mid-seminar must not log everybody out on deploy.
   */
  iat?: number
  /**
   * Whose cookie gave this token its host rights — when the console is handed
   * off.
   *
   * "Host by cookie" is deliberately never written into the participant row:
   * the cookie can be taken away, and that is the whole point of the role (see
   * db.ts, the token_host column). A tablet has no cookie, so the right moves
   * here — but not for good: `roleFor` asks whether this teacher is still on
   * the staff, and once they are removed from the list the console stops being
   * a console. The signature covers the field, so nobody can write someone
   * else's id into it.
   */
  staff?: string
  /** Durable generation of the staff credential that granted this token. */
  staffVersion?: number
}

/**
 * How long a participant token is good for.
 *
 * A seminar is ninety minutes and a student may come back to the notebook that
 * evening; a term later they are not in that room any more. Thirty days is far
 * past any honest use and far short of forever.
 */
export const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Tokens are HMAC-signed rather than stored: there is no account system to
 * revoke against, and a seminar link is itself the capability. Signing only
 * stops a participant from claiming to be the host.
 */
export function signToken(payload: TokenPayload): string {
  const stamped: TokenPayload = {
    ...payload,
    iat: payload.iat ?? Date.now(),
    ...(payload.staff ? { staffVersion: payload.staffVersion ?? staffAuthorizationVersion(payload.staff) ?? 0 } : {}),
  }
  const body = Buffer.from(JSON.stringify(stamped)).toString('base64url')
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyToken(token: string | undefined | null): TokenPayload | null {
  if (!token || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof parsed?.sessionId !== 'string' || typeof parsed?.participantId !== 'string') return null
    const payload = parsed as TokenPayload
    // A signature proves who minted it, not that it is still good.
    if (typeof payload.iat === 'number' && Date.now() - payload.iat > TOKEN_MAX_AGE_MS) return null
    return payload
  } catch {
    return null
  }
}

/**
 * A credential for one file, good for minutes.
 *
 * A download is an `<a href download>` and an anchor cannot carry a header, so
 * something has to ride in the query string. It used to be the session token —
 * the same string that opens the control socket — so a teacher who copied a
 * link to `dataset.csv` into the group chat handed every student Restart,
 * Clear and Restore under their own name, for as long as the token lived.
 *
 * This one names the single file it is for and dies in five minutes: long
 * enough for the browser to follow the link, short enough that a link pasted
 * into a chat is already useless by the time anyone reads it.
 */
const DOWNLOAD_TTL_MS = 5 * 60 * 1000

export function signDownloadToken(sessionId: string, name: string): string {
  const until = Date.now() + DOWNLOAD_TTL_MS
  const body = `${sessionId}\u0000${name}\u0000${until}`
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url')
  return `${until}.${sig}`
}

export function verifyDownloadToken(
  sessionId: string,
  name: string,
  token: string | undefined | null,
): boolean {
  if (!token || !token.includes('.')) return false
  const [untilRaw, sig] = token.split('.')
  const until = Number(untilRaw)
  if (!sig || !Number.isFinite(until) || Date.now() > until) return false
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${sessionId}\u0000${name}\u0000${until}`)
    .digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * The key with which a teacher hands THEIR OWN console to their own tablet.
 *
 * The task sounds simple: run a class from an iPad without signing in on it
 * again and without carrying over a name or rights by hand. But a participant
 * token in the address is exactly what `signDownloadToken` moved away from: the
 * string that opens the control socket, in a link people copy into a chat.
 *
 * So the link carries not a token but an exchange key: it lives ten minutes,
 * works once and is good for nothing but the exchange — it can neither open a
 * socket nor download a file. The tablet exchanges it for an ordinary
 * participant token and from then on lives like anyone who has signed in.
 *
 * Ten minutes is "walked to the lectern and opened it"; a link forgotten in a
 * chat goes stale before anyone reads it.
 */
export const HANDOFF_TTL_MS = 10 * 60 * 1000

/** Who gets the console and whose cookie holds that right (null: their own token). */
export interface HandoffHolder {
  participantId: string
  staff: string | null
}

export function signHandoffToken(
  sessionId: string,
  participantId: string,
  staff: string | null = null,
): string {
  const until = Date.now() + HANDOFF_TTL_MS
  const who = staff ? `${participantId}\u0000${staff}\u0000${staffAuthorizationVersion(staff) ?? 0}` : participantId
  const body = `handoff:${sessionId}\u0000${who}\u0000${until}`
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url')
  return `${Buffer.from(who).toString('base64url')}.${until.toString(36)}.${sig}`
}

/** Whom this key belongs to — or null if it is someone else's, malformed or stale. */
export function verifyHandoffToken(
  sessionId: string,
  token: string | undefined | null,
): HandoffHolder | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [who, untilRaw, sig] = parts
  const until = Number.parseInt(untilRaw, 36)
  if (!Number.isFinite(until) || Date.now() > until) return null
  let decoded: string
  try {
    decoded = Buffer.from(who, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const [participantId, staff, version] = decoded.split('\u0000')
  if (!participantId) return null
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`handoff:${sessionId}\u0000${decoded}\u0000${until}`)
    .digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  if (staff && staffAuthorizationVersion(staff) !== (version === undefined ? 1 : Number(version))) return null
  return { participantId, staff: staff || null }
}

/**
 * Spent keys — kept exactly until their own expiry.
 *
 * "Works once" was written in three places and was true in none: the key was
 * checked by signature and expiry, and there was nothing to mark it spent with
 * — a link that went to the wrong AirDrop window let any number of devices into
 * the room as the teacher for ten minutes. A set in memory, not a table: it
 * lives as long as a key does, and ten minutes after a process crash cost less
 * than a table nobody cleans.
 */
const spentHandoffs = new Map<string, number>()

/**
 * Check a key and spend it right away. A second exchange of the same key gives
 * null, just like someone else's key: the tablet exchanges the key exactly
 * once, and a copy of the link from a chat arrives at one already spent.
 */
export function spendHandoffToken(
  sessionId: string,
  token: string | undefined | null,
): HandoffHolder | null {
  const holder = verifyHandoffToken(sessionId, token)
  if (!holder) return null
  const now = Date.now()
  // Cleanup right here: keys are few, and otherwise the Map grows all semester.
  for (const [key, until] of spentHandoffs) if (until <= now) spentHandoffs.delete(key)
  const key = `${sessionId}\u0000${token as string}`
  if (spentHandoffs.has(key)) return null
  spentHandoffs.set(key, now + HANDOFF_TTL_MS)
  return holder
}

/** Host credential handed out at session creation; proves ownership after a refresh. */
/**
 * The host key to a room — with an expiry, like the participant's.
 *
 * It used to sign a bare `host:<sessionId>`: such a key never aged. Revoking it
 * was only possible by resetting SESSION_SECRET, that is, throwing everyone out
 * of every room at once. And it lives where links live — in terminal history,
 * in a chat, in a bookmark.
 *
 * The timestamp is in the key itself, not next to it: the signature covers it
 * too, so the expiry cannot be rewritten without knowing the secret. The same
 * thirty-day limit as the participant token, and for the same reason — a
 * semester is longer, but a seminar is not.
 */
export function signHostToken(sessionId: string): string {
  const issued = Date.now().toString(36)
  const sig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`host:${sessionId}:${issued}`)
    .digest('base64url')
  return `${sessionId}.${issued}.${sig}`
}

export function verifyHostToken(sessionId: string, token: string | undefined | null): boolean {
  if (typeof token !== 'string' || !token) return false
  const parts = token.split('.')
  /*
   * Two-part keys — issued before they had an expiry.
   *
   * Accepting them would mean leaving the hole open for convenience, and
   * rejecting them silently would mean throwing out of their own rooms those
   * who have kept a tab open since yesterday. The second is more honest: the
   * key is issued again on the next entry through the panel, and the room does
   * not disappear because of it — only the host badge is lost.
   */
  if (parts.length !== 3) return false
  const [claimed, issued, sig] = parts
  if (claimed !== sessionId) return false

  const at = Number.parseInt(issued, 36)
  if (!Number.isFinite(at) || Date.now() - at > TOKEN_MAX_AGE_MS) return false

  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`host:${sessionId}:${issued}`)
    .digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function newSessionId(): string {
  // Short and unambiguous: no 0/O/1/l, so a link read aloud still works.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(8)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

export function newParticipantId(): string {
  return 'p_' + crypto.randomBytes(9).toString('base64url')
}
