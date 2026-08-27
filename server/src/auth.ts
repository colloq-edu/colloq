import crypto from 'node:crypto'
import { config } from './config.js'
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
  const stamped: TokenPayload = { ...payload, iat: payload.iat ?? Date.now() }
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

/** Host credential handed out at session creation; proves ownership after a refresh. */
export function signHostToken(sessionId: string): string {
  const sig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`host:${sessionId}`)
    .digest('base64url')
  return `${sessionId}.${sig}`
}

export function verifyHostToken(sessionId: string, token: string | undefined | null): boolean {
  if (!token) return false
  const expected = signHostToken(sessionId)
  const a = Buffer.from(token)
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
