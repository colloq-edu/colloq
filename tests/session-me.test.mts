/**
 * "But am I let in?" — the only door that must answer someone who is locked out.
 *
 * A tab that was refused the handshake knows nothing about itself: the socket
 * closes BEFORE the upgrade and without a word, the browser sees 1006. There
 * are three cases — the room is gone, the key has expired, the teacher closed
 * access — and they can only be told apart by asking. While there was nowhere
 * to ask, a banned participant read "seat expired" after a reload, lost their
 * identity in the room and the next day came in as a new person: council
 * attempts and authorship stayed with someone who no longer exists.
 *
 * The failure here is silent in both directions, so the test also checks what
 * the door does NOT do: it does not sit behind the shared `banDoor` (otherwise
 * a banned participant would get a 403 with no explanation), and it answers
 * about a nonexistent room in OUR words — by them the client decides to wipe
 * its local copy of the notebook (shared/protocol.ts · SESSION_MISSING).
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_MISSING, type SessionMe } from '../shared/protocol.js'
import { signToken } from '../server/src/auth.js'
import { banParticipant, liftBan } from '../server/src/bans.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { fileRoutes } from '../server/src/routes/files.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'

const ROOM = 'me-room'
const OTHER = 'me-other-room'
let base = ''
let server: http.Server

before(async () => {
  for (const id of [ROOM, OTHER]) createSession(id, `Комната ${id}`, null)
  upsertParticipant({
    id: 'p_asks',
    sessionId: ROOM,
    name: 'Нина',
    avatar: null,
    role: 'participant',
  })

  const app = express()
  app.use(express.json())
  // The same order as in app.ts: room routes first, file routes after. The
  // order is the very thing under test — the file router's `banDoor` hangs on
  // the same prefix.
  app.use(sessionRoutes())
  app.use(fileRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

const tokenFor = (sessionId: string, participantId: string) =>
  signToken({ sessionId, participantId, role: 'participant' })

async function ask(room: string, token?: string): Promise<{ status: number; body: SessionMe }> {
  const res = await fetch(`${base}/api/sessions/${room}/me`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: res.status, body: (await res.json()) as SessionMe }
}

test('own key — the room recognizes it and says whose it is', async () => {
  const { status, body } = await ask(ROOM, tokenFor(ROOM, 'p_asks'))
  assert.equal(status, 200)
  assert.deepEqual(body, {
    tokenValid: true,
    ban: null,
    participantId: 'p_asks',
    role: 'participant',
  })
})

test('no key — "show your key", not "you were removed"', async () => {
  const { status, body } = await ask(ROOM)
  assert.equal(status, 200, 'the door exists precisely to answer; it must not stay silent')
  assert.deepEqual(body, { tokenValid: false, ban: null, participantId: null, role: null })
})

test('a key from another room is not a key', async () => {
  const { body } = await ask(ROOM, tokenFor(OTHER, 'p_asks'))
  assert.equal(body.tokenValid, false, 'a key from another room was accepted as our own')
  assert.equal(body.participantId, null)
})

test('no such room — a 404 in OUR words', async () => {
  const res = await fetch(`${base}/api/sessions/no-such-room/me`)
  assert.equal(res.status, 404)
  const body = (await res.json()) as { error: string }
  // By these words the client wipes its local copy of the notebook. Any other
  // 404 — from the relay, from static hosting — is a lost connection to it,
  // not a verdict.
  assert.equal(body.error, SESSION_MISSING)
})

test('this door answers a banned participant — and says until what time', async () => {
  const until = Date.now() + 45 * 60 * 1000
  const ban = banParticipant({
    sessionId: ROOM,
    participantId: 'p_asks',
    ip: null,
    byTeacher: 'Ада',
    until,
  })
  assert.ok(ban, 'the ban was not created — nothing to check')

  const token = tokenFor(ROOM, 'p_asks')
  const { status, body } = await ask(ROOM, token)
  assert.equal(status, 200, 'the door refused the banned participant — exactly what it must not do')
  assert.equal(body.tokenValid, true, 'the key is intact: the person was locked out, not logged out')
  assert.equal(body.ban?.until, until, 'the ban screen draws the end time from this number')

  // Yet the room's other doors are closed to them — so the point is not that
  // the ban does not work, but that this door is set up separately and on
  // purpose.
  const closed = await fetch(`${base}/api/sessions/${ROOM}/participants`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(closed.status, 403, 'the ban stopped closing the room')

  // And so is the file door, which hangs its own banDoor on the same prefix:
  // the router order must not drag /me behind someone else's door.
  const files = await fetch(`${base}/api/sessions/${ROOM}/files`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(files.status, 403)

  liftBan(ROOM, ban.id)
  const after = await ask(ROOM, token)
  assert.equal(after.body.ban, null, 'the lifted ban stayed in the response')
})
