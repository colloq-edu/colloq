/** One revocation boundary for control, CRDT and file connections. */
import type { WebSocket } from 'ws'
import { staffFromCookieHeader } from './admin/auth.js'
import { onStaffAuthorizationChanged, staffAuthorizationVersion } from './admin/store.js'
import { TOKEN_MAX_AGE_MS, type TokenPayload } from './auth.js'
import { roleFor } from './authorization.js'
import { isRemoteCredential } from '@shared/remote-runner'
import type { IncomingHttpHeaders } from 'node:http'

export interface SocketCredentials {
  cookieHeader?: string
  payload: TokenPayload
}

/**
 * A connection retains its original authority until revoked; it never silently
 * upgrades. Staff mutations close it immediately, and every message rechecks
 * durable state/expiry to cover changes made outside this process. The caller
 * must reject the frame when this returns false, even while close is in flight.
 */
export function authorizeSocket(ws: WebSocket, credentials?: SocketCredentials): () => boolean {
  // Internal/trusted callers may supply a role directly. Network sockets always
  // carry credentials from the verified upgrade in index.ts.
  if (!credentials) return () => true
  const { cookieHeader, payload } = credentials
  const staff = staffFromCookieHeader(cookieHeader)
  const staffId = staff?.id ?? payload.staff
  const version = staffId ? staffAuthorizationVersion(staffId) : null
  let valid = true
  const revoke = () => {
    if (!valid) return
    valid = false
    unsubscribe()
    try { ws.close(4401, 'Authorization changed; reconnect') } catch { ws.terminate() }
  }
  // A change about some rooms only (a membership) closes the sockets in those
  // rooms; one about the person (role, link, deletion) closes all of them.
  const unsubscribe = onStaffAuthorizationChanged((id, sessionIds) => {
    if (id === staffId && (!sessionIds || sessionIds.includes(payload.sessionId))) revoke()
  })
  ws.on('close', unsubscribe)
  ws.on('error', unsubscribe)
  return () => {
    if (!valid) return false
    if ((staffId && staffAuthorizationVersion(staffId) !== version) ||
        (staff && !staffFromCookieHeader(cookieHeader)) ||
        (payload.iat !== undefined && Date.now() - payload.iat > TOKEN_MAX_AGE_MS) ||
        roleFor(cookieHeader, payload) !== payload.role) revoke()
    return valid
  }
}

/**
 * The room token a WebSocket upgrade presents, or `null` when it presents a
 * machine's credential (`cr1.…`, in its Authorization header or as its token)
 * — in which case it opens nothing, whatever else it carries. Only the
 * machines' router takes that credential (competitions/remote/routes.ts),
 * and a socket door that tried it as a token of its own kind, or let a
 * machine's call through on a cookie riding next to it, would be one more
 * place a leaked machine secret opens. index.ts asks this before verifyToken.
 */
export function upgradeToken(headers: IncomingHttpHeaders, token: string | null): string | null {
  if (isRemoteCredential(headers.authorization) || isRemoteCredential(token)) return null
  return token
}
