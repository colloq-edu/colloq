/** Durable authority is resolved from the grant source, never the role in a token. */
import { canSeeRoom, staffById, type StaffLike } from './admin/access.js'
import { staffAuthorizationVersion } from './admin/store.js'
import { isTokenHost } from './db.js'
import type { TokenPayload } from './auth.js'

/**
 * Host or participant, for this request in this room.
 *
 * `staff` is the staff account the request speaks for, as its own door
 * decided it: `currentStaff(req)` for an HTTP request (admin/auth.ts), where a
 * sign-in proxy that vouched for the person has the last word; for a socket,
 * the cookie header the proxy has had its say on (upgrade.ts,
 * sso/identity.ts · socketCookieHeader). It is the account and not a Cookie
 * header on purpose: a header here is something a door can hand over raw,
 * and the room's REST API did. On a lab computer still holding a teacher's
 * cookie, the student signed in through the proxy was refused staff by the
 * panel and by the sockets, and was the room's host in its API: rules,
 * history restore, the class activity.
 *
 * A staff account makes its holder host only in a room they teach
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
  staff: StaffLike | null | undefined,
  payload: Pick<TokenPayload, 'sessionId' | 'participantId' | 'staff' | 'staffVersion'>,
): TokenPayload['role'] {
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
