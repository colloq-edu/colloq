/** Durable authority is resolved from the grant source, never the role in a token. */
import { staffFromCookieHeader } from './admin/auth.js'
import { canSeeRoom, staffById } from './admin/access.js'
import { staffAuthorizationVersion } from './admin/store.js'
import { isTokenHost } from './db.js'
import type { TokenPayload } from './auth.js'

/**
 * Host or participant, for this request in this room.
 *
 * A staff cookie makes its holder host only in a room they teach
 * (admin/access.ts · canSeeRoom): its own teachers, the teachers of any
 * course that seats it, and owners. Until 0.19 any cookie was host in every
 * room on the instance, which on a university install meant every lecturer
 * could restart, ban and read the activity of every other lecturer's class.
 * Anyone else on the staff list is an ordinary participant here, the way a
 * student who has the link is.
 *
 * The tablet branch asks the same question about the teacher its token
 * names: a console handed off while they taught this room stops being host
 * the moment they no longer do, not thirty days later when the token expires.
 */
export function roleFor(
  cookieHeader: string | undefined,
  payload: Pick<TokenPayload, 'sessionId' | 'participantId' | 'staff' | 'staffVersion'>,
): TokenPayload['role'] {
  const staff = staffFromCookieHeader(cookieHeader)
  if (staff && canSeeRoom(staff, payload.sessionId)) return 'host'
  const handedOff = tokenStaff(payload)
  if (handedOff && canSeeRoom(staffById(handedOff), payload.sessionId)) return 'host'
  return isTokenHost(payload.sessionId, payload.participantId) ? 'host' : 'participant'
}

/**
 * The staff account a token speaks for, while that grant still stands.
 *
 * A handoff key puts the teacher's id and their authorization version into
 * the tablet's token; rotating the link key bumps the version, and from that
 * moment the tablet speaks for nobody. Everything that reads `payload.staff`
 * asks through here, so a revoked tablet stops being host, stops being told
 * it is the server's owner, and stops being merged with the teacher's own
 * browser, all at once rather than when the token expires.
 */
export function tokenStaff(payload: Pick<TokenPayload, 'staff' | 'staffVersion'>): string | null {
  if (!payload.staff) return null
  return staffAuthorizationVersion(payload.staff) === (payload.staffVersion ?? 1) ? payload.staff : null
}
