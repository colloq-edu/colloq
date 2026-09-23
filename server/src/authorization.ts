/** Durable authority is resolved from the grant source, never the role in a token. */
import { staffFromCookieHeader } from './admin/auth.js'
import { staffAuthorizationVersion } from './admin/store.js'
import { isTokenHost } from './db.js'
import type { TokenPayload } from './auth.js'

export function roleFor(
  cookieHeader: string | undefined,
  payload: Pick<TokenPayload, 'sessionId' | 'participantId' | 'staff' | 'staffVersion'>,
): TokenPayload['role'] {
  if (staffFromCookieHeader(cookieHeader)) return 'host'
  if (payload.staff && staffAuthorizationVersion(payload.staff) === (payload.staffVersion ?? 1)) return 'host'
  return isTokenHost(payload.sessionId, payload.participantId) ? 'host' : 'participant'
}
