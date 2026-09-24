import { tr } from '@shared/i18n'
/**
 * Staff credentials: the setup token, and the cookie both sign-in paths spend
 * themselves for.
 *
 * See shared/admin.ts for why there is no password here. This module is the
 * server half of that decision.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { NextFunction, Request, Response } from 'express'
import { config, ensureDataDir } from '../config.js'
import { countStaff, getTeacher, linkKeyOf } from './store.js'
import { STAFF_COOKIE, type AdminErrorBody, type Teacher } from '@shared/admin'

const SETUP_TOKEN_FILE = path.join(config.dataDir, 'setup-token')
/**
 * A month — but a month of INACTIVITY, not a month since sign-in: see
 * `slideStaffCookie`.
 *
 * That is how long a signature copied out of the browser somewhere else lives;
 * an active tab extends itself.
 */
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/**
 * Once a day is the extension step: more often is pointless, less often no
 * longer saves the semester.
 */
const COOKIE_SLIDE_AFTER_MS = 24 * 60 * 60 * 1000

/* ------------------------------------------------------------ setup token */

function loadSetupToken(): string {
  try {
    const existing = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim()
    if (existing) return existing
  } catch {
    /* first boot, or someone deleted it to force a new one */
  }
  const token = crypto.randomBytes(24).toString('base64url')
  ensureDataDir()
  // 0600 up front rather than a chmod afterwards: there must be no instant at
  // which the file that owns this instance is world-readable.
  fs.writeFileSync(SETUP_TOKEN_FILE, token + '\n', { mode: 0o600 })
  return token
}

let setupToken = loadSetupToken()

export function readSetupToken(): string {
  return setupToken
}

/**
 * Issue a new setup token and throw the old one away.
 *
 * The token signs in whoever uses it as the oldest owner and is printed by
 * `make host` on every start — so it lives in terminal history, in projector
 * screenshots and in the chats it was forwarded to. There was nothing to
 * revoke it with: the file could be deleted by hand, but that was written
 * nowhere, and the instruction "rotate it when someone leaves" was about
 * teachers' links and said nothing about this token.
 *
 * Written through a temporary file and a rename: otherwise, between opening
 * and writing there is an instant when neither the old token nor the new one
 * exists, and a start at that moment would create a third one.
 */
export function rotateSetupToken(): string {
  const token = crypto.randomBytes(24).toString('base64url')
  const tmp = `${SETUP_TOKEN_FILE}.new`
  ensureDataDir()
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 })
  fs.renameSync(tmp, SETUP_TOKEN_FILE)
  setupToken = token
  return token
}

export const setupTokenPath = SETUP_TOKEN_FILE

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  // Lengths leak through timingSafeEqual's own throw, so they are checked first
  // and deliberately: the length of a random token is not the secret.
  if (x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

export function verifySetupToken(token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0) return false
  return constantTimeEqual(token.trim(), setupToken)
}

/** True once anyone has claimed the instance; the claim route is closed after that. */
export function isClaimed(): boolean {
  return countStaff() > 0
}

/* ----------------------------------------------------------------- cookie */

interface StaffCookieBody {
  tid: string
  iat: number
}

/**
 * The signing message is `<body>.<link_key>`, keyed by the instance secret.
 *
 * Putting the person's own link key inside the message is what lets this
 * instance revoke a session without a session table: rotating a link or
 * deleting the row changes (or removes) the second half of the message, so
 * every cookie ever minted for that person stops verifying on the next request.
 * A shared-secret-only signature would have needed a revocation list to do the
 * same thing, and a revocation list is a table nobody remembers to prune.
 */
function sign(body: string, linkKey: string): string {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${body}.${linkKey}`)
    .digest('base64url')
}

/** Six lines instead of cookie-parser; this is the only cookie the server reads. */
function readCookieHeader(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    const raw = part.slice(eq + 1).trim()
    /*
     * A broken cookie is simply not a cookie, not a reason to throw.
     *
     * `decodeURIComponent('%')` throws URIError, and here that cost the
     * process: the same function is called by the role parsing in the socket
     * handshake, where there is no try/catch around the callback — so
     * `Cookie: colloq_staff=%` from any participant reached uncaughtException
     * and took down the whole instance with all its rooms. The value still has
     * to be a signature, and this one will not verify.
     */
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

/**
 * Secure would make the cookie undeliverable on a self-hosted http instance.
 *
 * Decided by the scheme of THIS request, not by PUBLIC_URL. It used to be
 * decided by PUBLIC_URL, and while `make host` held the tunnel, signing in from
 * an iPad at an address like http://192.168.1.5 issued the cookie with Secure:
 * the browser silently did not store it, the panel flashed and immediately
 * answered 401 — a sign-in screen without a single word about the reason. The
 * same wrong flag also went into clearCookie, so in the opposite case signing
 * out of the panel did not remove the cookie. PUBLIC_URL stays what it was —
 * the address for links.
 *
 * `res.req` rather than a separate parameter: six routes and three test
 * harnesses issue the cookie, and express puts the request on the response
 * itself. A fake without it (tests, scripts) reads as http — there is no
 * request there to begin with.
 *
 * Exported for the competition participant cookie (competitions/identity.ts):
 * there is one rule, and a second copy of it would silently drift from this
 * one — exactly the way issuing and clearing once drifted apart.
 */
export function secureCookie(res: Response): boolean {
  const req = res.req as Request | undefined
  if (!req) return false
  if (req.secure) return true
  // Behind the relay the server always sees http — only caddy knows about
  // https, and it says so in the only way it has.
  const forwarded = req.get?.('x-forwarded-proto') ?? ''
  return forwarded.split(',')[0].trim().toLowerCase() === 'https'
}

export function issueStaffCookie(res: Response, teacher: Teacher): void {
  const body = Buffer.from(JSON.stringify({ tid: teacher.id, iat: Date.now() } satisfies StaffCookieBody)).toString(
    'base64url',
  )
  const value = `${body}.${sign(body, linkKeyOf(teacher.id) ?? '')}`
  res.cookie(STAFF_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
    secure: secureCookie(res),
  })
}

export function clearStaffCookie(res: Response): void {
  // The attributes must match the ones it was set with or the browser keeps it.
  res.clearCookie(STAFF_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: secureCookie(res),
  })
}

export function currentStaff(req: Request): Teacher | null {
  return staffFromCookieHeader(req.headers.cookie)
}

/**
 * The same check against a raw Cookie header. The WebSocket upgrade never sees
 * an express Request, and interrupt/restart have to be answerable there.
 */
export function staffFromCookieHeader(header: string | undefined): Teacher | null {
  return readStaffCookie(header)?.teacher ?? null
}

/** The same, but with the issue date: the extension reads it. */
function readStaffCookie(header: string | undefined): { teacher: Teacher; iat: number } | null {
  const raw = readCookieHeader(header, STAFF_COOKIE)
  if (!raw) return null
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null
  const body = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)

  let parsed: StaffCookieBody
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StaffCookieBody
  } catch {
    return null
  }
  if (typeof parsed?.tid !== 'string' || typeof parsed?.iat !== 'number') return null
  // Max-Age is the browser's promise, not a guarantee; the server ages the
  // cookie out itself so a copied value cannot outlive its month.
  if (Date.now() - parsed.iat > COOKIE_MAX_AGE_MS) return null

  const teacher = getTeacher(parsed.tid)
  if (!teacher) return null
  if (!constantTimeEqual(sig, sign(body, linkKeyOf(teacher.id) ?? ''))) return null
  return { teacher, iat: parsed.iat }
}

/**
 * The cookie is extended by activity — otherwise the month counted from SIGN-IN.
 *
 * `iat` was set once and never moved, and no route reissued the cookie. For
 * someone who signed in on the first of September that meant the first of
 * October: mid-semester, a class in progress, and on the very next socket
 * reconnect `roleFor` finds no signature — the teacher becomes a participant in
 * their own room. Locks, kernel restart and the console disappear without a
 * word, the panel answers 401, and seminars created from the panel never gave
 * anyone a host token: there is no fallback, you need the personal link, which
 * half of them have "somewhere in a chat".
 *
 * Extending is not lengthening: a month stays a month, but a month without
 * activity. A value copied somewhere ages exactly the same way, because it ages
 * where nobody uses it.
 *
 * Installed once for all of `/api` (see app.ts), not in `requireStaff`: half of
 * a teacher's work bypasses the panel — the room, files, the kernel.
 */
export function slideStaffCookie(req: Request, res: Response): void {
  const seen = readStaffCookie(req.headers.cookie)
  if (!seen) return
  if (Date.now() - seen.iat < COOKIE_SLIDE_AFTER_MS) return
  issueStaffCookie(res, seen.teacher)
}

/* ------------------------------------------------------------- middleware */

function deny(res: Response, status: number, reason: AdminErrorBody['reason'], error: string): void {
  const body: AdminErrorBody = { error, reason }
  res.status(status).json(body)
}

/**
 * Our own origin, not someone else's.
 *
 * The cookie is issued with `sameSite: 'lax'`, and that is already almost
 * enough: the browser will not attach it to a cross-site POST. "Almost" —
 * because that is the browser's rule, not the server's, and it holds exactly
 * until the first machine with an old browser or with an extension that
 * decides for it.
 *
 * The Origin header is mandatory in a cross-site request, and in a same-site
 * one it matches the host. A request without it is curl or the server itself,
 * and those must not be refused: `make host` calls its own API. That is why
 * only an Origin that was sent is checked.
 *
 * Installed on everything that writes, including sign-out: a teacher thrown
 * out of the panel in the middle of a seminar is not "just a logout" but a
 * room without its host. "Everything" here is literal — all of `/api`, not just
 * the panel (see app.ts): the same cookie authorizes uploading files to a room,
 * restarting the kernel and handing out the console, and until this line only
 * SameSite protected them.
 */
export function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin')
  if (!origin) return next()
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return deny(res, 403, 'forbidden', tr("server.requestBlockedThisPageUsesADifferent.dd9b4b"))
  }
  // req.host drops the port, and here it matters: 5173 and 8080 are different sites.
  const reqHost = req.get('host') ?? ''
  if (host !== reqHost && !(thisMachine(reqHost) && (thisMachine(host) || host === tunnelHost()))) {
    return deny(res, 403, 'forbidden', tr("server.requestBlockedThisPageUsesADifferent.dd9b4b"))
  }
  next()
}

/**
 * The public address of a local class, if the tunnel holds one right now.
 *
 * The `colloq start --share` tunnel reaches the server with Host
 * 127.0.0.1:<port> (scripts/host.sh · --http-host-header), while the page sends
 * the Origin of its *.trycloudflare.com address. Without this line every POST
 * from the public address got "a different server address" — and the sign-in
 * link with a token did not sign in. A foreign site will not get through this
 * way: Origin must match the address the server itself hands out as its own
 * (config.publicUrl — the tunnel lease).
 */
function tunnelHost(): string | null {
  try {
    const url = new URL(config.publicUrl)
    return thisMachine(url.host) ? null : url.host
  } catch {
    return null
  }
}

/**
 * Two addresses on this same machine are `npm run dev`, not a foreign site.
 *
 * In development the page is served by Vite from its own port, and its proxy
 * rewrites Host to the server's address (changeOrigin) — after that there is
 * nothing to compare, and the panel answered 403 to EVERY write, including the
 * sign-in itself: in a dev build it could not be entered at all, although the
 * README promises that it works through the proxy.
 *
 * The concession here is exactly zero: to the browser localhost:5173 and
 * localhost:3000 are one site (SameSite looks at the name, not the port), so a
 * `lax` cookie would travel with such a request even without this line. A real
 * instance lives on a name or on a network address, and for it the rule is
 * unchanged.
 */
const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/i

function thisMachine(hostPort: string): boolean {
  return LOOPBACK.test(hostPort.replace(/:\d+$/, ''))
}

export function requireStaff(req: Request, res: Response, next: NextFunction): void {
  const teacher = currentStaff(req)
  if (!teacher) return deny(res, 401, 'unauthenticated', tr("server.signInToUseTheAdminPanel.301d28"))
  next()
}

/**
 * Owner-only, with the refusal saying what was refused. The message reaches a
 * teacher who just pressed a button, so "only an owner can change the staff
 * list" on a route that deletes a seminar would be a sentence about the wrong
 * thing — and being told the wrong reason is worse than being told none.
 */
export function ownerOnly(action: string) {
  return function requireOwnerFor(req: Request, res: Response, next: NextFunction): void {
    const teacher = currentStaff(req)
    if (!teacher) return deny(res, 401, 'unauthenticated', tr("server.signInToUseTheAdminPanel.301d28"))
    if (teacher.role !== 'owner') return deny(res, 403, 'forbidden', tr('server.ownerOnly', { action: tr(action) }))
    next()
  }
}

/** The staff list is what an owner owns, so it is the default subject. */
export const requireOwner = ownerOnly('server.ownerAction.0')
