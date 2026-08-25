import crypto from 'node:crypto'
import { config } from './config.js'
import type { ParticipantRole } from '@shared/protocol'

export interface TokenPayload {
  sessionId: string
  participantId: string
  role: ParticipantRole
}

/**
 * Tokens are HMAC-signed rather than stored: there is no account system to
 * revoke against, and a seminar link is itself the capability. Signing only
 * stops a participant from claiming to be the host.
 */
export function signToken(payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
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
    return parsed as TokenPayload
  } catch {
    return null
  }
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
