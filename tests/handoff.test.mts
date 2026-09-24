/**
 * The console handed over to a tablet.
 *
 * A link through which another device enters the room AS YOU is the most
 * dangerous string in the product: it is shorter than a password, lives in
 * the address bar and ends up in screenshots. What is checked here is exactly
 * what made it acceptable to introduce at all: the key lives for minutes, is
 * good only for an exchange and for nothing else, and only someone who is
 * already the host can issue it.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  signHandoffToken,
  signToken,
  verifyHandoffToken,
  verifyToken,
} from '../server/src/auth.js'
import { config } from '../server/src/config.js'
import { createSession, isTokenHost, upsertParticipant } from '../server/src/db.js'
import { roleFor } from '../server/src/routes/sessions.js'
import { app } from '../server/src/app.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, deleteTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { STAFF_COOKIE } from '../shared/admin.js'
import type { Response as ExpressResponse } from 'express'
import type { HandoffResponse, JoinResponse } from '../shared/protocol.js'

const ROOM = 'handoff-test'
const OTHER = 'handoff-other'
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Пульт', null)
  createSession(OTHER, 'Соседняя', null)
  upsertParticipant({
    id: 'p_teacher',
    sessionId: ROOM,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  upsertParticipant({
    id: 'p_student',
    sessionId: ROOM,
    name: 'Нина',
    avatar: null,
    role: 'participant',
  })

  /*
   * The whole app (server/src/app.ts), not an express of our own next to it:
   * a copy of the middleware order does not catch discrepancies with the
   * product, it repeats them.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

after(() => server?.close())

const asHost = () => signToken({ sessionId: ROOM, participantId: 'p_teacher', role: 'host' })
const asStudent = () =>
  signToken({ sessionId: ROOM, participantId: 'p_student', role: 'participant' })

function handoff(token: string | null, room = ROOM, cookie?: string): Promise<Response> {
  return fetch(`${base}/api/sessions/${room}/handoff`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: '{}',
  })
}

/** issueStaffCookie writes onto express's Response; this is the smallest thing that shape. */
function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

function claim(key: unknown, room = ROOM): Promise<Response> {
  return fetch(`${base}/api/sessions/${room}/handoff/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  })
}

test('the host gets a key, and the tablet exchanges it for the same sign-in', async () => {
  const made = await handoff(asHost())
  assert.equal(made.status, 200)
  const { key, livesMs, origin } = (await made.json()) as HandoffResponse
  assert.ok(livesMs > 0 && livesMs <= 30 * 60_000, 'the key lives for minutes, not days')
  // The address at which the room is visible from outside is known to the
  // server, not to the teacher's tab: a tablet will not open a link built
  // from `localhost`.
  assert.equal(origin, config.publicUrl)

  const claimed = await claim(key)
  assert.equal(claimed.status, 200)
  const body = (await claimed.json()) as JoinResponse
  // The same person, not a second one with the same name: otherwise the room
  // list has two teachers, and the wrong one leads the lecture.
  assert.equal(body.participant.id, 'p_teacher')
  assert.equal(body.participant.name, 'Ада')
  assert.equal(body.participant.role, 'host')
  // And the rights move over: the tablet has no cookie, yet it stays the host.
  assert.equal(verifyToken(body.token)?.role, 'host')
})

test('a student cannot hand over the console', async () => {
  const denied = await handoff(asStudent())
  assert.equal(denied.status, 403)
})

test('without a token no key is issued at all', async () => {
  assert.equal((await handoff(null)).status, 401)
})

test('a token of another room does not let you in here', async () => {
  const stranger = signToken({ sessionId: OTHER, participantId: 'p_teacher', role: 'host' })
  assert.equal((await handoff(stranger)).status, 401)
})

test('the key is no good as a token: it opens no door at all', async () => {
  const { key } = (await (await handoff(asHost())).json()) as HandoffResponse
  // The most important property: an exchange key is not a credential. Put in
  // place of a token, it must open nothing, including the issue of new keys.
  assert.equal(verifyToken(key), null)
  assert.equal((await handoff(key)).status, 401)
})

test('an expired key is rejected', () => {
  const key = signHandoffToken(ROOM, 'p_teacher')
  const [who, , sig] = key.split('.')
  const expired = `${who}.${(Date.now() - 1000).toString(36)}.${sig}`
  assert.equal(verifyHandoffToken(ROOM, expired), null)
})

test('a key for one room does not open another', async () => {
  const { key } = (await (await handoff(asHost())).json()) as HandoffResponse
  assert.equal(verifyHandoffToken(OTHER, key), null)
  assert.equal((await claim(key, OTHER)).status, 401)
})

test('the signature covers both the name and the expiry', () => {
  const key = signHandoffToken(ROOM, 'p_teacher')
  const [who, until, sig] = key.split('.')
  const someoneElse = Buffer.from('p_student').toString('base64url')
  assert.equal(verifyHandoffToken(ROOM, `${someoneElse}.${until}.${sig}`), null)
  const later = (Date.now() + 60 * 60_000).toString(36)
  assert.equal(verifyHandoffToken(ROOM, `${who}.${later}.${sig}`), null)
  assert.equal(verifyHandoffToken(ROOM, key)?.participantId, 'p_teacher')
})

test('a key is good for exactly one exchange', async () => {
  /*
   * "Ten minutes, once" is written in the comments of three files, but there
   * was nothing to cancel the key with: a link that went to the wrong AirDrop
   * window let any number of devices into the room as the teacher for all ten
   * minutes.
   */
  const { key } = (await (await handoff(asHost())).json()) as HandoffResponse
  assert.equal((await claim(key)).status, 200)
  assert.equal((await claim(key)).status, 401, 'the same key was exchanged twice')
})

test('a console issued on the strength of a cookie is taken away along with it', async () => {
  /*
   * The invariant from identity.test.mts: "host by cookie" is never written
   * into the participant row, otherwise there is nothing to revoke the rights
   * with. The console went around it — it wrote token_host, and a teacher
   * removed from the staff stayed host forever in every room where they had
   * pressed "Console" even once.
   */
  const teacher = createTeacher({ name: 'Нина', email: 'nina.handoff@example.edu', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  const cookie = mintCookie(teacher)

  upsertParticipant({
    id: 'p_cookie',
    sessionId: ROOM,
    name: 'Нина',
    avatar: null,
    role: 'host',
  })
  const laptop = signToken({ sessionId: ROOM, participantId: 'p_cookie', role: 'participant' })

  const made = await handoff(laptop, ROOM, cookie)
  assert.equal(made.status, 200)
  const { key } = (await made.json()) as HandoffResponse
  const claimed = (await (await claim(key)).json()) as JoinResponse
  const tablet = verifyToken(claimed.token)
  assert.ok(tablet)

  // The tablet leads: it has no cookie and never will.
  assert.equal(roleFor(undefined, tablet), 'host')
  // But no "host forever" record appeared — otherwise there would be nothing
  // to revoke.
  assert.equal(isTokenHost(ROOM, 'p_cookie'), false, 'the cookie was written into token_host')

  // Removed from the staff — the console stops being a console, like the laptop.
  assert.equal(deleteTeacher(teacher.id), true)
  assert.equal(roleFor(undefined, tablet), 'participant')
})

test('junk instead of a key does not crash the exchange', async () => {
  for (const bad of ['', 'a.b', 'a.b.c', null, 42, { key: 1 }]) {
    const res = await claim(bad)
    assert.equal(res.status, 401, JSON.stringify(bad))
  }
})
