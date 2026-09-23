/** One revocation boundary for control, CRDT and file connections. */
import type { WebSocket } from 'ws'
import { staffFromCookieHeader } from './admin/auth.js'
import { onStaffAuthorizationChanged, staffAuthorizationVersion } from './admin/store.js'
import { TOKEN_MAX_AGE_MS, type TokenPayload } from './auth.js'
import { roleFor } from './authorization.js'

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
  const unsubscribe = onStaffAuthorizationChanged((id) => { if (id === staffId) revoke() })
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
