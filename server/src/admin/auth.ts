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
import { config } from '../config.js'
import { countStaff, getTeacher, linkKeyOf } from './store.js'
import { STAFF_COOKIE, type AdminErrorBody, type Teacher } from '@shared/admin'

const SETUP_TOKEN_FILE = path.join(config.dataDir, 'setup-token')
/** Long enough to bookmark, short enough to paste into a terminal. */
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/* ------------------------------------------------------------ setup token */

function loadSetupToken(): string {
  try {
    const existing = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim()
    if (existing) return existing
  } catch {
    /* first boot, or someone deleted it to force a new one */
  }
  const token = crypto.randomBytes(24).toString('base64url')
  fs.mkdirSync(config.dataDir, { recursive: true })
  // 0600 up front rather than a chmod afterwards: there must be no instant at
  // which the file that owns this instance is world-readable.
  fs.writeFileSync(SETUP_TOKEN_FILE, token + '\n', { mode: 0o600 })
  return token
}

const setupToken = loadSetupToken()

export function readSetupToken(): string {
  return setupToken
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
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

/** Secure would make the cookie undeliverable on a self-hosted http instance. */
const secureCookie = config.publicUrl.startsWith('https')

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
    secure: secureCookie,
  })
}

export function clearStaffCookie(res: Response): void {
  // The attributes must match the ones it was set with or the browser keeps it.
  res.clearCookie(STAFF_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: secureCookie })
}

export function currentStaff(req: Request): Teacher | null {
  const raw = readCookie(req, STAFF_COOKIE)
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
  return teacher
}

/* ------------------------------------------------------------- middleware */

function deny(res: Response, status: number, reason: AdminErrorBody['reason'], error: string): void {
  const body: AdminErrorBody = { error, reason }
  res.status(status).json(body)
}

export function requireStaff(req: Request, res: Response, next: NextFunction): void {
  const teacher = currentStaff(req)
  if (!teacher) return deny(res, 401, 'unauthenticated', 'sign in to use the admin panel')
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
    if (!teacher) return deny(res, 401, 'unauthenticated', 'sign in to use the admin panel')
    if (teacher.role !== 'owner') return deny(res, 403, 'forbidden', `only an owner can ${action}`)
    next()
  }
}

/** The staff list is what an owner owns, so it is the default subject. */
export const requireOwner = ownerOnly('change the staff list')
