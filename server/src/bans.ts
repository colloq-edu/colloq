import { tr } from '@shared/i18n'
/**
 * A ban: the "block access" button and everything it rests on.
 *
 * The product has no accounts, so there are two marks to rest on, and both are
 * leaky: the participant id sits in the person's localStorage, the device mark
 * in a cookie. Incognito gives a clean browser, and nobody promises anything
 * airtight here. What is promised is something else, exactly what a class
 * needs: a lazy return — the same tab, the same browser, a reloaded page — does
 * not get through, and whoever comes back in earnest arrives as a new person,
 * which the teacher can see in the list.
 *
 * The request address is written into a ban only as a hint "seems to have come
 * back" and NEVER takes part in the check: a whole lecture hall sits behind one
 * NAT.
 *
 * The table schema is in db.ts, next to the room's other tables; here are the
 * queries against it, the device cookie and the rule about expired rows.
 */
import crypto from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { Request, Response } from 'express'
import { staffFromCookieHeader } from './admin/auth.js'
import { db, deviceOfParticipant, getParticipant } from './db.js'
import type { Ban } from '@shared/protocol'

/**
 * A day.
 *
 * Enough to cover the rest of the class and the evening after it, while the ban
 * does not live until the next class: the teacher does not have to lift it by
 * hand, and a person should be able to come next week into a room they were
 * blocked from a month ago.
 */
export const BAN_MS = 24 * 60 * 60 * 1000

/* --------------------------------------------------------- device cookie */

export const DEVICE_COOKIE = 'colloq_device'
/** No reason for the mark to live shorter: it outlives the semester and storage clearing. */
const DEVICE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000
/** 24 bytes is exactly 32 base64url characters. The mark always has the same length. */
const DEVICE_SHAPE = /^[A-Za-z0-9_-]{32}$/

/** Six lines instead of cookie-parser; this server has two cookies. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    /*
     * No decodeURIComponent, unlike the parsing of the teacher cookie: the
     * value is 32 characters of the base64url alphabet, there is nothing to
     * escape, and `decodeURIComponent('%')` throws URIError — a price already
     * paid once (admin/auth.ts · readCookieHeader), because the same function
     * is called in the socket handshake, where there is no try/catch around the
     * callback.
     */
    return part.slice(eq + 1).trim()
  }
  return null
}

/**
 * The browser mark from the request, or null.
 *
 * A damaged or foreign cookie is the absence of a mark, not a mark: otherwise a
 * string of any length that anyone sent would go into the database and into
 * the check. No mark is common: the person is here for the first time, or the
 * page was served by a different server (in development Vite serves it). There
 * is nothing suspicious in that, and such a guest should be treated as new.
 */
export function deviceOf(cookieHeader: string | undefined): string | null {
  const raw = readCookie(cookieHeader, DEVICE_COOKIE)
  return raw && DEVICE_SHAPE.test(raw) ? raw : null
}

/**
 * Secure — by the scheme of THIS request, not by PUBLIC_URL.
 *
 * The same rule and for the same reason as the teacher cookie (admin/auth.ts ·
 * secureCookie): while `make host` holds the address to the outside, signing in
 * from an iPad at http://192.168.1.5 would get a cookie with Secure, the
 * browser would silently not store it — and the device mark would never be
 * set, quietly and forever. Behind the relay the server always sees http, and
 * caddy tells it about https in the only way it has.
 */
function secureCookie(req: Request): boolean {
  if (req.secure) return true
  const forwarded = req.get?.('x-forwarded-proto') ?? ''
  return forwarded.split(',')[0].trim().toLowerCase() === 'https'
}

/**
 * Mark the browser if it is not marked yet, and return the mark.
 *
 * Called when the application page is served — where the response goes to the
 * browser rather than to fetch: a cookie set on an API request will not reach
 * everyone (in development the page is served by Vite from its own address).
 */
export function markDevice(req: Request, res: Response): string {
  const known = deviceOf(req.headers.cookie)
  if (known) return known
  const device = crypto.randomBytes(24).toString('base64url')
  res.cookie(DEVICE_COOKIE, device, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_MAX_AGE_MS,
    secure: secureCookie(req),
  })
  return device
}

/* ------------------------------------------------------------------ address */

/** Loopback is a proxy on this same machine, not a student. */
const LOOPBACK = /^(?:::1|(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/

/**
 * The address a request came from — solely for the hint in the ban list.
 *
 * Behind the relay the server sees loopback: caddy on the VPS hands the request
 * to frps, which hands it to the client on this machine, and it reaches Colloq
 * from 127.0.0.1. The real address arrives in the `X-Forwarded-For` header,
 * which caddy sets itself (scripts/relay-setup.sh, scripts/host.sh).
 *
 * The header cannot always be trusted: anyone can write it. On an instance with
 * no proxy in front, one line in a request would swap the hint for someone
 * else's address — and the teacher would read "seems to have come back" about
 * a person who sat quietly. So the header is accepted exactly when the socket
 * peer is loopback, that is, a proxy on this same machine; in all other cases
 * the address is taken from the connection itself.
 */
export function addressOf(req: {
  headers: IncomingHttpHeaders
  socket?: { remoteAddress?: string | undefined }
}): string | null {
  const peer = req.socket?.remoteAddress ?? null
  if (peer && LOOPBACK.test(peer)) {
    /*
     * Cloudflare, if it is in front of us, puts the real address into its own
     * header and appends ITSELF to the end of x-forwarded-for. Without this
     * line, behind the proxy all visitors look like one address — Cloudflare's
     * — and the "seems to have come back" hint starts pointing at everyone at
     * once, that is, lying.
     */
    const single = (value: string | string[] | undefined): string | undefined =>
      (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim()
    const real = single(req.headers['cf-connecting-ip']) ?? single(req.headers['x-forwarded-for'])
    // 64 chars: room for IPv6 with a zone; a hint is no reason to keep a paragraph.
    if (real) return real.slice(0, 64)
  }
  return peer
}

/* ----------------------------------------------------------------- queries */

interface BanRow {
  id: string
  session_id: string
  participant_id: string | null
  device: string | null
  ip: string | null
  name: string
  until: number
  by_teacher: string | null
  created_at: number
}

const insertBan = db.prepare(`
  INSERT INTO bans (id, session_id, participant_id, device, ip, name, until, by_teacher, created_at)
  VALUES (@id, @session_id, @participant_id, @device, @ip, @name, @until, @by_teacher, @created_at)
`)
const dropExpired = db.prepare('DELETE FROM bans WHERE session_id = ? AND until <= ?')
const selectActive = db.prepare(
  'SELECT * FROM bans WHERE session_id = ? AND until > ? ORDER BY created_at DESC',
)
/*
 * A match is by id OR by device mark, and in no case by address. NULL in SQL
 * equals nothing, including NULL: a row without a mark does not catch a guest
 * without a mark, and vice versa.
 */
const selectMatch = db.prepare(`
  SELECT id, name, until FROM bans
  WHERE session_id = ? AND until > ? AND (participant_id = ? OR device = ?)
  ORDER BY until DESC LIMIT 1
`)
const dropBan = db.prepare('DELETE FROM bans WHERE session_id = ? AND id = ?')
const dropBansOf = db.prepare('DELETE FROM bans WHERE session_id = ?')
const selectLatest = db.prepare(
  'SELECT MAX(until) AS until FROM bans WHERE session_id = ? AND until > ?',
)

/**
 * Expired rows are removed by whoever comes to read next.
 *
 * There is no timer on purpose. A day-long ban outlives both a night of
 * downtime and a server restart, so cleanup would have to happen at startup
 * anyway — that is, a timer would be a second clock on top of the only real
 * one, the `until` field. It is also by that field that a ban stops working:
 * not a second past its term does the row take effect, even if nobody removed
 * it. And it is removed here so that the teacher's list does not pile up
 * yesterday's bans.
 *
 * It is called only by those who really read the database: the first read of a
 * room (`untilOf`) and the teacher's list (`listBans`). A room already known to
 * have nobody to catch never gets here at all — see `untilOf`. For a row whose
 * term ran out without a single new read, this takes away only the cleanup: it
 * stopped working at its `until`, and the teacher's list or the first read
 * after a restart will remove it.
 */
function sweep(sessionId: string): void {
  dropExpired.run(sessionId, Date.now())
}

/**
 * Until what moment the room has at least one ban in force. `0` means none.
 *
 * A per-room cache, like `rulesCache` in db.ts, and it exists because of the
 * storm: `banFor` is asked at join and in the handshake of EACH of the three
 * sockets, and after a server restart five hundred tabs come back within a
 * second or two — that is a thousand DELETEs plus a thousand SELECTs in the
 * very second everyone is waiting for the room to come back. Each indexed call
 * costs only microseconds, but they are paid where the event loop is fully
 * busy, and for nothing: the vast majority of rooms have no bans at all.
 *
 * A number, not a flag: time by itself only LIFTS bans, and by expiry the entry
 * goes stale without anyone's help — by the same `until` field the ban itself
 * lives by. A ban can only appear through `banParticipant` in this process, and
 * there the cache is forgotten; `liftBan` and `discardBans` do the same. A row
 * put into the table bypassing these functions (by hand in sqlite3) the cache
 * will not see: the product has one door for writing, and it is here.
 *
 * The memory price is a number per room that has been asked about at least
 * once.
 */
const liveBans = new Map<string, number>()

function untilOf(sessionId: string): number {
  const known = liveBans.get(sessionId)
  if (known !== undefined) return known
  // The first read of a room is also the cleanup: the promise "removed by the
  // very first read" rests on it.
  sweep(sessionId)
  const row = selectLatest.get(sessionId, Date.now()) as { until: number | null } | undefined
  const until = row?.until ?? 0
  liveBans.set(sessionId, until)
  return until
}

/** A ban in force right now: only what needs to be told to the person. */
export interface BanInForce {
  id: string
  name: string
  until: number
}

/**
 * Whether a ban applies to whoever is knocking now — and which one.
 *
 * One door for all entrances: `/join` and the handshake of each of the three
 * sockets. Separately they would drift apart, and silently — a banned person
 * would be left with an open notebook in a room they are no longer let into.
 *
 * Staff pass any ban. This is not politeness to the bosses: a slip — banning
 * yourself from a second tab — must not lock the teacher out of their own room
 * in the middle of a class.
 */
export function banFor(
  sessionId: string,
  participantId: string | null,
  cookieHeader: string | undefined,
): BanInForce | null {
  if (staffFromCookieHeader(cookieHeader)) return null
  const device = deviceOf(cookieHeader)
  // Nothing to present means nothing to catch: this is a clean browser, and it
  // gets through. The hole is named out loud in the file header.
  if (!participantId && !device) return null
  // A room with nobody to catch does not reach the database: in a reconnection
  // storm that is a thousand calls that simply do not happen.
  if (untilOf(sessionId) <= Date.now()) return null
  sweep(sessionId)
  const row = selectMatch.get(sessionId, Date.now(), participantId, device) as
    | BanInForce
    | undefined
  return row ?? null
}

/**
 * What to tell a banned person.
 *
 * Calmly and to the point: who closed access and to whom — so the person
 * understands it is the teacher's decision, not a broken room. There is no time
 * in the line on purpose: the server in a container lives on UTC, and an
 * "until 15:40" built by it would point to the wrong hour in a UTC+3 lecture
 * hall. The moment travels as a number in `until`, and the clock is drawn by
 * whoever looks — the version feed lives by the same rule (db.ts ·
 * target_seq).
 */
export function banRefusal(ban: BanInForce): { error: string; until: number } {
  return {
    error: tr("server.theTeacherHasBlockedYourAccessTo.5eba21", { p0: ban.name }),
    until: ban.until,
  }
}

function toBan(row: BanRow, viewerDevice: string | null): Ban {
  return {
    id: row.id,
    name: row.name,
    until: row.until,
    createdAt: row.created_at,
    byTeacher: row.by_teacher,
    // A mark is compared only with a non-empty one: two browsers without a mark
    // are not "the same device" but two unknowns.
    mine: row.device !== null && row.device === viewerDevice,
  }
}

/**
 * The room's bans in force.
 *
 * `viewerDevice` is the mark of whoever is looking, and it is needed exactly
 * for the `mine` field.
 */
export function listBans(sessionId: string, viewerDevice: string | null): Ban[] {
  sweep(sessionId)
  const rows = selectActive.all(sessionId, Date.now()) as BanRow[]
  // The list has already read exactly what the cache needs to know: until what
  // moment there is someone to catch in the room. No separate query is needed.
  liveBans.set(
    sessionId,
    rows.reduce((latest, row) => Math.max(latest, row.until), 0),
  )
  return rows.map((row) => toBan(row, viewerDevice))
}

/**
 * Create a ban for a day.
 *
 * `null` means there is nobody to ban: no such person in the room, or they are
 * its host. The second is that very "staff are not banned": the invariant lives
 * here, next to the check itself, not in the route, where someone would one
 * day forget it.
 *
 * Both marks go into the row — the id and the browser the person last came
 * from — plus the address as a hint. The mark is taken from the participant's
 * row: there is nowhere to take it from in the request, since the teacher sends
 * the request, and the cookie in it is the teacher's own.
 */
export function banParticipant(input: {
  sessionId: string
  participantId: string
  /** Only the "seems to have come back" hint. Takes no part in the check. */
  ip: string | null
  /** Who banned — a name for the list, not an id. */
  byTeacher: string | null
  /** The mark of whoever bans: the response needs it to show `mine`. */
  viewerDevice?: string | null
  /** The end moment; defaults to a day from now. */
  until?: number
}): Ban | null {
  const person = getParticipant(input.sessionId, input.participantId)
  if (!person || person.role === 'host') return null
  const now = Date.now()
  const row: BanRow = {
    id: 'b_' + crypto.randomBytes(9).toString('base64url'),
    session_id: input.sessionId,
    participant_id: person.id,
    device: deviceOfParticipant(input.sessionId, person.id),
    ip: input.ip,
    name: person.name,
    until: input.until ?? now + BAN_MS,
    by_teacher: input.byTeacher,
    created_at: now,
  }
  insertBan.run(row)
  // The room now has someone to catch — and the cache has no way to know it.
  liveBans.delete(input.sessionId)
  return toBan(row, input.viewerDevice ?? null)
}

/** Lift a ban. `false` means there is no such ban in this room (or it has expired). */
export function liftBan(sessionId: string, banId: string): boolean {
  liveBans.delete(sessionId)
  return dropBan.run(sessionId, banId).changes > 0
}

/**
 * The seminar was deleted — the bans go with it.
 *
 * Not only for tidiness: a row holds the address the person came from, and it
 * must not outlive the room.
 */
export function discardBans(sessionId: string): void {
  liveBans.delete(sessionId)
  dropBansOf.run(sessionId)
}

/* -------------------------------------------------------------- eviction */

/**
 * Whom to tell that a person has been evicted right now.
 *
 * A ban closes three doors: the notebook, the control socket and the file. The
 * first two are closed by `evictBanned` (control.ts) — it holds the sockets of
 * both itself. The third — the editor's file socket — is held by
 * collab/files.ts, and calling it from there directly would be possible:
 * control.ts imports this module anyway, and files.ts does not look back at
 * control.ts — there is no cycle. But then the list of wires would live in the
 * module that handles presses, and every next wire would have to be remembered
 * exactly there. So the event is declared here, in the ban module — where the
 * very notion "this person may no longer come here" lives — and whoever holds a
 * wire subscribes to it on their side.
 *
 * The handshake check closes the door to whoever is knocking; this closes it to
 * whoever is already sitting inside with an open file.
 */
type EvictionListener = (sessionId: string, participantId: string) => void

const evictors = new Set<EvictionListener>()

export function onEviction(listener: EvictionListener): void {
  evictors.add(listener)
}

/**
 * A person was evicted — close their wires.
 *
 * Each listener under its own try/catch: a door closed halfway is better than a
 * ban route that crashed in the middle — the row in the database is already in
 * place, and the person is banned regardless of whose socket did not close.
 */
export function evicted(sessionId: string, participantId: string): void {
  for (const listener of evictors) {
    try {
      listener(sessionId, participantId)
    } catch (err) {
      console.error(
        `[bans ${sessionId}] eviction did not reach one of the wires:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}
