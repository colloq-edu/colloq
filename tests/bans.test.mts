/**
 * A ban: whom the room stops letting in, and what that rests on.
 *
 * There are no accounts in the product, so a ban rests on two leaky marks,
 * the participant id and the device mark in a cookie, and the first thing
 * checked here is exactly what is promised: both catch a return in the same
 * browser, and neither catches a clean one. Airtightness cannot be promised,
 * and a test pretending it exists would be worse than no test.
 *
 * The second is the cost of a slip. Banning yourself from a second tab is
 * easy: the participant list is made of names, not faces. Staff must pass
 * any ban, otherwise one press locks a teacher out of their own room in the
 * middle of a class.
 *
 * No network, no kernel: the room is real, the entry is real, and a
 * neighbouring room is next to it, so that a ban set in one would be seen if
 * it leaked into the other.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { Request, Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher } from '../server/src/admin/store.js'
import {
  addressOf,
  banFor,
  banParticipant,
  banRefusal,
  deviceOf,
  DEVICE_COOKIE,
  discardBans,
  liftBan,
  listBans,
  markDevice,
  BAN_MS,
} from '../server/src/bans.js'
import { createSession, db, upsertParticipant } from '../server/src/db.js'
import { app } from '../server/src/app.js'
import type { JoinResponse } from '../shared/protocol.js'

const ROOM = 'bans-room'
const OTHER = 'bans-other'
/**
 * A mark is 32 characters of the base64url alphabet; real ones are the same,
 * only random. One per test: a mark is a browser, and a banned browser must
 * stay banned until the end of the run.
 */
const mark = (letter: string) => letter.repeat(32)
const PHONE = mark('p')
const LAPTOP = mark('l')

let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Семинар', null)
  createSession(OTHER, 'Соседняя', null)
  /*
   * The whole app (server/src/app.ts), not an express of our own next to it:
   * a copy of the middleware order does not catch divergences from the
   * product, it repeats them.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

interface Attempt {
  name: string
  participantId?: string
  token?: string
  device?: string
  cookie?: string
  room?: string
}

async function join(attempt: Attempt): Promise<Answer> {
  const cookie =
    attempt.cookie ?? (attempt.device ? `${DEVICE_COOKIE}=${attempt.device}` : undefined)
  const res = await fetch(`${base}/api/sessions/${attempt.room ?? ROOM}/join`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      name: attempt.name,
      participantId: attempt.participantId ?? null,
      token: attempt.token ?? null,
    }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

interface Answer {
  status: number
  body: Record<string, unknown>
}

/** Came in and remembered how to prove that they are themselves. */
async function newcomer(name: string, device?: string): Promise<JoinResponse> {
  const res = await join({ name, device })
  assert.equal(res.status, 200, `${name} did not get in`)
  return res.body as unknown as JoinResponse
}

const ban = (participantId: string, until?: number) =>
  banParticipant({ sessionId: ROOM, participantId, ip: null, byTeacher: 'Ада', until })

/* ------------------------------------------------------------ two marks */

test('a ban by id does not let the same person back in', async () => {
  const kostya = await newcomer('Костя')
  assert.ok(ban(kostya.participant.id))

  const back = await join({
    name: 'Костя',
    participantId: kostya.participant.id,
    token: kostya.token,
  })
  assert.equal(back.status, 403)
  // The person must understand that this is the teacher's decision, not a
  // broken room, which is why the refusal carries their name.
  assert.match(String(back.body.error), /Костя/)
  assert.match(String(back.body.error), /преподаватель/i)
  // The time as a number: the browser draws the clock, the server in a container lives in UTC.
  assert.equal(typeof back.body.until, 'number')
  assert.ok(Number(back.body.until) > Date.now())
})

test('a ban also catches by device mark someone returning as a "new person"', async () => {
  const nina = await newcomer('Нина', mark('n'))
  assert.ok(ban(nina.participant.id))

  // A clean localStorage: neither id nor token. The cookie is in place: it is
  // the same browser, and that is the only case the ban must catch.
  const again = await join({ name: 'Не Нина', device: mark('n') })
  assert.equal(again.status, 403)
  assert.match(String(again.body.error), /Нина/)
})

test('a clean browser gets through, and that is said out loud, not forgotten', async () => {
  const oleg = await newcomer('Олег', mark('o'))
  assert.ok(ban(oleg.participant.id))

  // Incognito: a different cookie, a different id. The ban does not catch
  // such a return and never promised to; the teacher sees it in the
  // participant list.
  const incognito = await join({ name: 'Олег', device: mark('i') })
  assert.equal(incognito.status, 200)
})

test('lifting restores entry', async () => {
  const petya = await newcomer('Петя')
  const row = ban(petya.participant.id)
  assert.ok(row)

  assert.equal(liftBan(ROOM, row.id), true)
  assert.equal(liftBan(ROOM, row.id), false, 'there is nothing to lift twice')
  const back = await join({
    name: 'Петя',
    participantId: petya.participant.id,
    token: petya.token,
  })
  assert.equal(back.status, 200)
})

test('an expired ban has no effect and is removed by the very first read', async () => {
  const sveta = await newcomer('Света')
  const stale = ban(sveta.participant.id, Date.now() - 1000)
  assert.ok(stale)
  assert.equal(rowsFor(ROOM, stale.id), 1, 'the row landed in the database')

  const back = await join({
    name: 'Света',
    participantId: sveta.participant.id,
    token: sveta.token,
  })
  assert.equal(back.status, 200, 'the term is over: the ban holds not a second longer')
  // There is no timer: the row is removed by whoever next comes to read the room's bans.
  assert.equal(rowsFor(ROOM, stale.id), 0)
})

function rowsFor(sessionId: string, banId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM bans WHERE session_id = ? AND id = ?')
    .get(sessionId, banId) as { n: number }
  return row.n
}

/* --------------------------------------------------- the cost of a slip */

test('staff pass any ban: a slip does not lock you out', async () => {
  const ada = await newcomer('Ада', mark('a'))
  assert.ok(ban(ada.participant.id))

  const teacher = createTeacher({ email: 'ada@test.local', name: 'Ада', role: 'owner' })
  assert.ok(teacher)
  const staff = mintStaffCookie(teacher)

  const back = await join({
    name: 'Ада',
    participantId: ada.participant.id,
    token: ada.token,
    cookie: `${staff}; ${DEVICE_COOKIE}=${mark('a')}`,
  })
  assert.equal(back.status, 200)
  assert.equal(
    back.body.participant && (back.body.participant as { id: string }).id,
    ada.participant.id,
  )
})

test('the teacher of a room cannot be banned at all', () => {
  upsertParticipant({
    id: 'p_host',
    sessionId: ROOM,
    name: 'Ведущий',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  assert.equal(ban('p_host'), null)
  // Nor someone who is not in the room: there is nobody to ban.
  assert.equal(ban('p_nobody'), null)
})

/* ------------------------------------------------------- room boundaries */

test('a ban in one room does not close the neighbouring one', async () => {
  const grisha = await newcomer('Гриша', mark('g'))
  assert.ok(ban(grisha.participant.id))

  const next = await join({ name: 'Гриша', device: mark('g'), room: OTHER })
  assert.equal(next.status, 200, 'the neighbouring seminar is not the one they were closed out of')
  assert.equal(banFor(OTHER, grisha.participant.id, `${DEVICE_COOKIE}=${mark('g')}`), null)
})

/* -------------------------------------------------- what the teacher sees */

test('the list shows the name, who closed them off, and whether it is your own device', async () => {
  const room = 'bans-list'
  createSession(room, 'Список', null)
  upsertParticipant({
    id: 'p_shura',
    sessionId: room,
    name: 'Шура',
    avatar: null,
    role: 'participant',
    device: PHONE,
  })
  const row = banParticipant({
    sessionId: room,
    participantId: 'p_shura',
    ip: '10.1.2.3',
    byTeacher: 'Ада',
  })
  assert.ok(row)
  assert.equal(row.name, 'Шура')
  assert.equal(row.byTeacher, 'Ада')
  assert.ok(row.until - row.createdAt === BAN_MS)

  // "Your own device" is only about a matching mark.
  const asPhone = listBans(room, PHONE)
  assert.equal(asPhone.length, 1)
  assert.equal(asPhone[0].mine, true)
  assert.equal(listBans(room, LAPTOP)[0].mine, false)
  assert.equal(listBans(room, null)[0].mine, false, 'two browsers without a mark are not one device')

  // The mark and the address landed in the row, but the list does not expose them.
  const stored = db.prepare('SELECT device, ip FROM bans WHERE id = ?').get(row.id) as {
    device: string | null
    ip: string | null
  }
  assert.equal(stored.device, PHONE)
  assert.equal(stored.ip, '10.1.2.3')
  assert.equal('device' in asPhone[0], false)
  assert.equal('ip' in asPhone[0], false)

  discardBans(room)
  assert.deepEqual(listBans(room, PHONE), [], 'the seminar was deleted, and the address went with it')
})

test('the refusal names the person and the end moment, and leaves the clock to the browser', () => {
  const until = Date.now() + BAN_MS
  const said = banRefusal({ id: 'b_x', name: 'Костя', until })
  assert.equal(said.until, until)
  assert.match(said.error, /^Костя, /)
  // Neither "15:40" nor ISO: the server in a container lives in UTC, and a
  // time it assembled would point to the wrong hour in the classroom.
  assert.equal(/\d{1,2}:\d{2}/.test(said.error), false)
})

/* ------------------------------------------------------------ device mark */

function mintStaffCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

interface Written {
  name: string
  value: string
  options: { httpOnly?: boolean; sameSite?: string; maxAge?: number; secure?: boolean }
}

function pageRequest(opts: { cookie?: string; forwardedProto?: string; secure?: boolean }): {
  req: Request
  written: Written[]
} {
  const written: Written[] = []
  const req = {
    headers: { cookie: opts.cookie },
    secure: opts.secure ?? false,
    get: (name: string) =>
      name.toLowerCase() === 'x-forwarded-proto' ? opts.forwardedProto : undefined,
  } as unknown as Request
  const res = {
    cookie: (name: string, value: string, options: Written['options']) =>
      written.push({ name, value, options }),
  } as unknown as Response
  markDevice(req, res)
  return { req, written }
}

test('the mark is set once and survives a return', () => {
  const first = pageRequest({})
  assert.equal(first.written.length, 1)
  const [mark] = first.written
  assert.equal(mark.name, DEVICE_COOKIE)
  assert.match(mark.value, /^[A-Za-z0-9_-]{32}$/)
  assert.equal(mark.options.httpOnly, true)
  assert.equal(mark.options.sameSite, 'lax')
  assert.ok((mark.options.maxAge ?? 0) >= 365 * 24 * 60 * 60 * 1000)

  // Came again with the same cookie: no second mark is created.
  const again = pageRequest({ cookie: `${DEVICE_COOKIE}=${mark.value}` })
  assert.deepEqual(again.written, [])
})

test('Secure follows the scheme of this request, otherwise the cookie is not stored at all', () => {
  assert.equal(pageRequest({}).written[0].options.secure, false)
  assert.equal(pageRequest({ secure: true }).written[0].options.secure, true)
  // Behind the relay the server always sees http; caddy tells it about https.
  assert.equal(pageRequest({ forwardedProto: 'https' }).written[0].options.secure, true)
})

test('a malformed or foreign cookie means no mark, not a mark', () => {
  assert.equal(deviceOf(undefined), null)
  assert.equal(deviceOf('colloq_staff=abc'), null)
  assert.equal(deviceOf(`${DEVICE_COOKIE}=слишком-коротко`), null)
  assert.equal(deviceOf(`${DEVICE_COOKIE}=${'x'.repeat(4096)}`), null)
  assert.equal(deviceOf(`${DEVICE_COOKIE}=%`), null, 'a malformed cookie does not crash the parsing')
  assert.equal(deviceOf(`${DEVICE_COOKIE}=${PHONE}; other=1`), PHONE)
})

/* -------------------------------------------------------------- address */

test('the address header is trusted only from a proxy on the same machine', () => {
  const headers = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }
  // Behind the relay the socket peer is loopback, and the real address is
  // only in the header.
  assert.equal(addressOf({ headers, socket: { remoteAddress: '127.0.0.1' } }), '203.0.113.7')
  assert.equal(addressOf({ headers, socket: { remoteAddress: '::1' } }), '203.0.113.7')
  // But one sent directly by anybody is made up: the "seems to have come
  // back" hint would point at a person who sat quietly.
  assert.equal(addressOf({ headers, socket: { remoteAddress: '198.51.100.4' } }), '198.51.100.4')
  assert.equal(addressOf({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1')
  assert.equal(addressOf({ headers: {} }), null)
})
