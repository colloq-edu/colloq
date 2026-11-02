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
 * Where a request's role came from, kept by work that outlives the request:
 * an Oracle turn (ai/agent.ts) writes files and runs code for minutes after
 * the request that started it was answered.
 *
 * Not the role but the question that gave it, to be asked again: the staff
 * account the request spoke for, with its authorization version at the time,
 * and the room token it carried, whose handoff grant and host-token branch
 * `roleFor` reads exactly as on any request.
 */
export interface RoleGrant {
  staff: { id: string; version: number | null } | null
  token: Pick<TokenPayload, 'sessionId' | 'participantId' | 'staff' | 'staffVersion'>
}

/** The grant behind the role `roleFor(staff, payload)` gives a request now. */
export function grantOf(
  staff: StaffLike | null | undefined,
  payload: Pick<TokenPayload, 'sessionId' | 'participantId' | 'staff' | 'staffVersion'>,
): RoleGrant {
  return {
    staff: staff ? { id: staff.id, version: staffAuthorizationVersion(staff.id) } : null,
    token: {
      sessionId: payload.sessionId,
      participantId: payload.participantId,
      staff: payload.staff,
      staffVersion: payload.staffVersion,
    },
  }
}

/**
 * The role a grant gives right now.
 *
 * The staff account still counts only at the authorization version the
 * request saw: rotating the link moves it (and breaks the cookie that spoke
 * for the account), deleting the row takes it away. A changed role or a lost
 * seat needs no version: `roleFor` asks canSeeRoom of the row as it is now.
 * These are the questions a socket asks on every frame
 * (socket-authorization.ts), for work that has no frames to ask them on.
 */
export function grantedRole(grant: RoleGrant): TokenPayload['role'] {
  const { staff } = grant
  const held = staff && staffAuthorizationVersion(staff.id) === staff.version ? staffById(staff.id) : null
  return roleFor(held, grant.token)
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
