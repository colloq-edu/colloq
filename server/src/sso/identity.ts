/**
 * Sign-in by a proxy that vouches for the person: AUTH_JWT_*.
 *
 * Colloq's own credentials are links — a personal sign-in link per teacher, a
 * room link per class. An organisation that already authenticates everybody
 * at its edge (Teleport application access in front of a Kubernetes service,
 * oauth2-proxy in front of an OIDC provider) can let that sign-in count here
 * too: the proxy forwards a signed JWT with every request, and this module
 * turns a token that verifies into who the person is.
 *
 *  - Staff. A verified email that belongs to the staff list signs in as that
 *    teacher: the ordinary staff cookie is issued, so the panel, the room and
 *    every socket see the same signed-in teacher they would after a personal
 *    link. Nobody is added because they have a token — the owner adds
 *    colleagues by email as before — unless the operator names the proxy's
 *    roles that mean "teacher" or "owner" (AUTH_JWT_TEACHER_ROLES,
 *    AUTH_JWT_OWNER_ROLES); then the first visit adds the person.
 *  - Students. A room joined with a verified token takes the person's name
 *    from it and keeps one participant per person in the room, whatever device
 *    they come from (sso/participants.ts). Per-address limits count the person
 *    instead of the address, which behind a proxy is the proxy's.
 *
 * Without a token, or with one that does not verify, a request is exactly the
 * request it was before: links keep working, so a proxy that lets some people
 * through without a token (or no proxy at all on another route) is not locked
 * out, and nothing here can lock out a class.
 */
import type { IncomingHttpHeaders } from 'node:http'
import type { NextFunction, Request, Response } from 'express'
import { LIMITS, STAFF_COOKIE, type Teacher } from '@shared/admin'
import { normalizeLabel } from '@shared/text'
import { clearStaffCookie, isClaimed, issueStaffCookie, retireSetupToken, staffCookieValue, staffFromCookieHeader } from '../admin/auth.js'
import { recordAdminEvent } from '../admin/audit-log.js'
import { createTeacher, getTeacherByEmail, looksLikeEmail, normalizeEmail, touchTeacherLastSeen } from '../admin/store.js'
import { seldom } from '../log.js'
import { localDestination } from '../outbound.js'
import { ASYMMETRIC_ALGORITHMS, KeyCache, peekKeyId, verifyJwt, type JwtAlgorithm, type JwtRules, type KeySource } from './jwt.js'

export interface SsoPolicy {
  enabled: boolean
  /** The request header with the token, lower case. */
  header: string
  source: KeySource
  rules: JwtRules
  /** Claim paths tried in order (`traits.email` reaches into an object); the first non-empty value wins. */
  claims: { subject: string[]; name: string[]; email: string[]; roles: string[] }
  /** Appended to a login that is not an email, for a proxy that knows people by login only. */
  emailDomain: string | null
  teacherRoles: string[]
  ownerRoles: string[]
  problems: string[]
}

export interface SsoIdentity {
  /** What the proxy calls the person, stable across sessions and devices. */
  subject: string
  name: string | null
  /** Lower case, or null when the token names none. */
  email: string | null
  roles: string[]
}

/** What the middleware leaves on a request. */
export interface SsoRequest {
  ssoIdentity?: SsoIdentity
  ssoStaff?: Teacher
}

export const DEFAULT_HEADER = 'teleport-jwt-assertion'
/**
 * Headers the token may not travel in. `authorization` is the room API's own
 * (the browser sends the room token there): a proxy that put its token in it
 * would overwrite that, and every file, history and oracle request would
 * answer 401. The rest mean something else to the HTTP layer and the proxies.
 */
const TAKEN_HEADERS = new Set(['authorization', 'cookie', 'host', 'origin', 'content-type', 'content-length',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip'])
const DEFAULT_CLAIMS = {
  subject: 'sub,username',
  name: 'name,traits.name,traits.full_name,traits.display_name,username',
  email: 'email,traits.email,traits.mail,username',
  roles: 'roles,groups,traits.groups',
}

function list(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

function text(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? '').trim()
}

function jwksUrl(raw: string, problems: string[]): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    problems.push(`AUTH_JWT_JWKS_URL=${raw}: not a URL`)
    return null
  }
  // Whoever can change the keys in flight signs in as anybody: http only to
  // an address that cannot be on someone else's network path (the proxy's
  // Service in this cluster, this machine).
  if (url.protocol === 'https:' || (url.protocol === 'http:' && localDestination(url.hostname))) return url.toString()
  problems.push(`AUTH_JWT_JWKS_URL=${raw}: must be https (http only to a cluster or loopback address)`)
  return null
}

/** Pure: the policy these settings describe. Sign-in by proxy is on when a key source is given. */
export function parseSsoPolicy(env: NodeJS.ProcessEnv): SsoPolicy {
  const problems: string[] = []
  const url = jwksUrl(text(env, 'AUTH_JWT_JWKS_URL'), problems)
  const file = text(env, 'AUTH_JWT_JWKS_FILE') || null
  if (url && file) problems.push('AUTH_JWT_JWKS_URL and AUTH_JWT_JWKS_FILE are both set: name one source of keys')

  const algorithms: JwtAlgorithm[] = []
  for (const name of list(env.AUTH_JWT_ALGORITHMS)) {
    if ((ASYMMETRIC_ALGORITHMS as readonly string[]).includes(name)) algorithms.push(name as JwtAlgorithm)
    else problems.push(`AUTH_JWT_ALGORITHMS: ${name} is never accepted (only ${ASYMMETRIC_ALGORITHMS.join(', ')})`)
  }

  let leewaySeconds = 60
  const leeway = text(env, 'AUTH_JWT_LEEWAY_SECONDS')
  if (leeway) {
    const value = Number(leeway)
    if (Number.isInteger(value) && value >= 0 && value <= 600) leewaySeconds = value
    else problems.push(`AUTH_JWT_LEEWAY_SECONDS=${leeway}: a whole number of seconds from 0 to 600; it stays 60`)
  }

  const domain = text(env, 'AUTH_JWT_EMAIL_DOMAIN').replace(/^@/, '').toLowerCase()
  const emailDomain = domain && /^[a-z0-9.-]+$/.test(domain) ? domain : null
  if (domain && !emailDomain) problems.push(`AUTH_JWT_EMAIL_DOMAIN=${domain}: not a domain name`)

  let header = (text(env, 'AUTH_JWT_HEADER') || DEFAULT_HEADER).toLowerCase()
  const headerProblem = TAKEN_HEADERS.has(header) || !/^[a-z0-9-]+$/.test(header)
  if (headerProblem) {
    problems.push(`AUTH_JWT_HEADER=${header}: Colloq or HTTP already uses this header; pass the token in one of its own (Teleport: teleport-jwt-assertion)`)
    header = DEFAULT_HEADER
  }

  /*
   * The audience is required. A proxy signs the tokens of every application
   * behind it with one key — Teleport does — so without it a token minted for
   * another application, seen by that application's team or its logs, signs
   * in here as the person it names. `*` accepts any, said out loud.
   */
  const audienceSetting = text(env, 'AUTH_JWT_AUDIENCE')
  const keySource = Boolean(url || file)
  if (keySource && !audienceSetting) {
    problems.push('AUTH_JWT_AUDIENCE is not set: name the aud the proxy writes for this application (Teleport: the app\'s uri), or * to accept tokens meant for any application')
  }

  const sourceProblem = (url && file) || (text(env, 'AUTH_JWT_JWKS_URL') !== '' && !url)
  return {
    enabled: keySource && !sourceProblem && !headerProblem && audienceSetting !== '',
    header,
    source: { url: file ? null : url, file },
    rules: {
      algorithms: algorithms.length > 0 ? algorithms : [...ASYMMETRIC_ALGORITHMS],
      issuer: text(env, 'AUTH_JWT_ISSUER') || null,
      audience: audienceSetting === '*' ? null : audienceSetting || null,
      leewaySeconds,
    },
    claims: {
      subject: list(env.AUTH_JWT_SUBJECT_CLAIM || DEFAULT_CLAIMS.subject),
      name: list(env.AUTH_JWT_NAME_CLAIM || DEFAULT_CLAIMS.name),
      email: list(env.AUTH_JWT_EMAIL_CLAIM || DEFAULT_CLAIMS.email),
      roles: list(env.AUTH_JWT_ROLES_CLAIM || DEFAULT_CLAIMS.roles),
    },
    emailDomain,
    teacherRoles: list(env.AUTH_JWT_TEACHER_ROLES),
    ownerRoles: list(env.AUTH_JWT_OWNER_ROLES),
    problems,
  }
}

let current: SsoPolicy | null = null
let cache: KeyCache | null = null

/** Parsed once, on first use: a changed setting reaches the server with a restart. */
export function ssoPolicy(): SsoPolicy {
  return (current ??= parseSsoPolicy(process.env))
}

/** Tests put a policy of their own in place; null goes back to the environment. */
export function useSsoPolicy(policy: SsoPolicy | null, keys: KeyCache | null = null): void {
  current = policy
  cache = keys
}

function keyCache(policy: SsoPolicy): KeyCache {
  return (cache ??= new KeyCache({ source: policy.source }))
}

/** The start line (index.ts prints it once). */
export function describeSsoPolicy(policy: SsoPolicy): string {
  if (!policy.enabled) return 'sign-in by proxy is off'
  const from = policy.source.file ? `keys from ${policy.source.file}` : `keys from ${policy.source.url}`
  const checks = [policy.rules.issuer ? `issuer ${policy.rules.issuer}` : null, policy.rules.audience ? `audience ${policy.rules.audience}` : 'ANY audience']
    .filter(Boolean).join(', ')
  const adds = policy.ownerRoles.length + policy.teacherRoles.length > 0
    ? `adds staff with roles ${[...policy.ownerRoles.map((r) => `${r} (owner)`), ...policy.teacherRoles].join(', ')}`
    : 'adds nobody: staff are matched by email'
  return `sign-in by proxy from the ${policy.header} header; ${from}${checks ? `; ${checks}` : ''}; ${adds}`
}

/* ---------------------------------------------------------------- claims */

function claimAt(claims: Record<string, unknown>, path: string): unknown {
  let value: unknown = claims
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** A claim as strings: Teleport puts traits in lists even when they hold one value. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'number') return [String(value)]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

function firstOf(claims: Record<string, unknown>, paths: string[]): string | null {
  for (const path of paths) {
    const found = strings(claimAt(claims, path)).map((item) => item.trim()).find(Boolean)
    if (found) return found
  }
  return null
}

function emailOf(claims: Record<string, unknown>, policy: SsoPolicy): string | null {
  for (const path of policy.claims.email) {
    for (const raw of strings(claimAt(claims, path))) {
      const value = raw.trim()
      const email = value.includes('@') ? value : policy.emailDomain && /^[A-Za-z0-9._+-]+$/.test(value) ? `${value}@${policy.emailDomain}` : ''
      const normal = normalizeEmail(email)
      if (normal && normal.length <= LIMITS.email && looksLikeEmail(normal)) return normal
    }
  }
  return null
}

/** Who the claims describe, or null without a subject: a person with no stable name cannot be kept apart from the next one. */
export function identityFromClaims(claims: Record<string, unknown>, policy: SsoPolicy): SsoIdentity | null {
  const subject = firstOf(claims, policy.claims.subject)
  if (!subject) return null
  const name = normalizeLabel(firstOf(claims, policy.claims.name) ?? '').slice(0, 100) || null
  const roles = [...new Set(policy.claims.roles.flatMap((path) => strings(claimAt(claims, path)).map((role) => role.trim())).filter(Boolean))]
  return { subject: subject.slice(0, 200), name, email: emailOf(claims, policy), roles }
}

/* ----------------------------------------------------------------- tokens */

/** The token a request carries in the configured header. */
export function tokenFromHeaders(headers: IncomingHttpHeaders, policy: SsoPolicy = ssoPolicy()): string | null {
  const raw = headers[policy.header]
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  return value || null
}

/** The person a token vouches for, or null. Never throws: a broken token is no token. */
export async function identityFromToken(token: string, policy: SsoPolicy = ssoPolicy()): Promise<SsoIdentity | null> {
  if (!policy.enabled) return null
  const keys = keyCache(policy)
  await keys.ready(peekKeyId(token))
  const verdict = verifyJwt(token, keys.keys, policy.rules)
  if (!verdict.ok) {
    // Refusals are counted by reason, once a minute each: a misconfigured
    // proxy produces one on every request.
    if (seldom(`sso:${verdict.reason}`)) {
      const why = verdict.reason === 'unknown_key' && keys.lastError ? `; the keys: ${keys.lastError}` : ''
      console.warn(`[sso] a token was not accepted (${verdict.reason})${why}; the request goes on without it`)
    }
    return null
  }
  const identity = identityFromClaims(verdict.claims, policy)
  if (!identity && seldom('sso:subject')) {
    console.warn(`[sso] a verified token names nobody: none of ${policy.claims.subject.join(', ')} holds a value (AUTH_JWT_SUBJECT_CLAIM)`)
  }
  return identity
}

/* ------------------------------------------------------------------ staff */

function holdsAny(roles: string[], wanted: string[]): boolean {
  return wanted.some((role) => roles.includes(role))
}

/**
 * The staff member a verified identity is, adding them when the proxy's roles
 * say so.
 *
 * Matched by email, the identity the staff list already keys on. A role in
 * AUTH_JWT_OWNER_ROLES or AUTH_JWT_TEACHER_ROLES adds a person the list does
 * not have yet; it never changes the role of someone already on it — that is
 * the owner's decision in the panel, and a proxy flipping a role on every
 * request would fight it. An unclaimed instance is claimed only by an owner
 * role: the first account may not be a teacher, because an instance needs an
 * owner who can grant access.
 */
export function staffForIdentity(identity: SsoIdentity, req?: Request, policy: SsoPolicy = ssoPolicy()): Teacher | null {
  if (!identity.email) return null
  const existing = getTeacherByEmail(identity.email)
  if (existing) return existing
  const owner = holdsAny(identity.roles, policy.ownerRoles)
  if (!owner && !holdsAny(identity.roles, policy.teacherRoles)) return null
  const claiming = !isClaimed()
  if (claiming && !owner) return null
  const name = (identity.name ?? identity.email).slice(0, LIMITS.teacherName)
  const added = createTeacher({ email: identity.email, name, role: owner ? 'owner' : 'teacher' })
  // Two first requests at once: the second insert loses to the UNIQUE index.
  if (!added) return getTeacherByEmail(identity.email)
  // The printed setup token dies at the claim, whichever door made it.
  if (claiming) retireSetupToken()
  recordAdminEvent({
    actor: added,
    action: claiming ? 'instance.claimed' : 'staff.added',
    target: { type: 'staff', id: added.id, label: added.name },
    detail: { via: 'sso', role: added.role },
    req,
  })
  return added
}

/* ------------------------------------------------------------- middleware */

/**
 * Read the token before anything else reads the request.
 *
 * A staff identity becomes the staff cookie, issued on the first request that
 * shows it (the page itself, in practice): from then on the WebSocket
 * handshakes, which never pass through express, carry the cookie like after a
 * personal link. `currentStaff` reads the identity directly for this very
 * request, whose cookie only arrives with the response.
 */
export async function attachSsoIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
  const policy = ssoPolicy()
  if (!policy.enabled) return next()
  try {
    const token = tokenFromHeaders(req.headers, policy)
    const identity = token ? await identityFromToken(token, policy) : null
    if (identity) {
      const target = req as Request & SsoRequest
      target.ssoIdentity = identity
      const staff = staffForIdentity(identity, req, policy)
      if (staff) target.ssoStaff = staff
      const held = staffFromCookieHeader(req.headers.cookie)
      /*
       * The cookie follows the proxy's decision — on a page or an API
       * request only: the build's assets go out `public, immutable`, and a
       * Set-Cookie on them is something a shared cache may keep and hand on.
       * A cookie for anyone else (the previous person on a shared computer)
       * is replaced, or removed when this person is not staff at all.
       */
      if (held?.id !== staff?.id && carriesCookie(req)) {
        if (staff) {
          issueStaffCookie(res, staff)
          touchTeacherLastSeen(staff.id)
          // A page load fires several requests before the browser stores the
          // cookie; one line in the audit log per sign-in, not per request.
          if (seldom(`sso:signin:${staff.id}`, 10 * 60_000)) {
            recordAdminEvent({ actor: staff, action: 'staff.signed_in', detail: { via: 'sso' }, req })
          }
        } else {
          clearStaffCookie(res)
        }
      }
    }
  } catch (error) {
    if (seldom('sso:middleware')) console.warn(`[sso] the token could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  next()
}

/** A page navigation or an API call: the requests a cookie may ride on (see attachSsoIdentity). */
function carriesCookie(req: Request): boolean {
  if (req.path.startsWith('/api/')) return true
  return req.method === 'GET' && (req.get('sec-fetch-mode') === 'navigate' || (req.get('accept') ?? '').includes('text/html'))
}

function withoutCookie(header: string | undefined, name: string): string {
  return (header ?? '').split(';').map((part) => part.trim()).filter((part) => part && part.split('=')[0]!.trim() !== name).join('; ')
}

/**
 * The cookie header a WebSocket's authority is read from.
 *
 * The handshake never passes through express, so the middleware's decision
 * is made again here: with a verified token the staff cookie is the proxy's —
 * the teacher it vouches for, or none — whatever the browser kept. Without
 * one the header is the browser's, as always.
 */
export async function socketCookieHeader(headers: IncomingHttpHeaders, policy: SsoPolicy = ssoPolicy()): Promise<string | undefined> {
  if (!policy.enabled) return headers.cookie
  const token = tokenFromHeaders(headers, policy)
  const identity = token ? await identityFromToken(token, policy) : null
  if (!identity) return headers.cookie
  const staff = staffForIdentity(identity, undefined, policy)
  const rest = withoutCookie(headers.cookie, STAFF_COOKIE)
  const own = staff ? `${STAFF_COOKIE}=${encodeURIComponent(staffCookieValue(staff))}` : ''
  return [rest, own].filter(Boolean).join('; ') || undefined
}

export function ssoIdentityOf(req: Request): SsoIdentity | null {
  return (req as Request & SsoRequest).ssoIdentity ?? null
}
