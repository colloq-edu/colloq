/**
 * A ban closes HTTP too, not only the door and the socket.
 *
 * `banFor` was asked in two places: `/join` and the socket handshake. But a
 * participant token is signed and lives up to thirty days, and there is no
 * way to take it back, so a closed access closed the room and none of what
 * people usually get closed off for: the handouts, file uploads (that very
 * spam), the version feed, questions to the oracle on the instance's key. A
 * banned person with an old Bearer token carried on as if nothing had
 * happened.
 *
 * There is one door for all of the room's routes (routes/sessions.ts ·
 * banDoor), and it answers with words about the ban, not "join the
 * seminar": the person must understand that this is the teacher's decision.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { signToken } from '../server/src/auth.js'
import { banParticipant } from '../server/src/bans.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { app } from '../server/src/app.js'
import { sessionDir } from '../server/src/workspace.js'

const ROOM = 'ban-http'
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Комната с баном', null)
  fs.writeFileSync(path.join(sessionDir(ROOM), 'handout.csv'), 'a,b\n1,2\n')
  for (const id of ['p_rude', 'p_quiet']) {
    upsertParticipant({
      id,
      sessionId: ROOM,
      name: id === 'p_rude' ? 'Гриша' : 'Нина',
      avatar: null,
      role: 'participant',
    })
  }

  /*
   * The doors are mounted by the app (server/src/app.ts), not by three
   * routers side by side: in the product the ban door stands behind json
   * parsing and the origin check, and "stayed open" must mean open THERE,
   * not here.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

const tokenFor = (id: string) =>
  signToken({ sessionId: ROOM, participantId: id, role: 'participant' })

const bearer = (id: string) => ({ authorization: `Bearer ${tokenFor(id)}` })

async function upload(id: string, name = `drop-${id}.txt`): Promise<number> {
  const form = new FormData()
  form.append('file', new Blob(['spam\n']), name)
  const res = await fetch(`${base}/api/sessions/${ROOM}/files`, {
    method: 'POST',
    headers: bearer(id),
    body: form,
  })
  return res.status
}

test('before the ban a participant reads and writes, as they should', async () => {
  const files = await fetch(`${base}/api/sessions/${ROOM}/files`, { headers: bearer('p_rude') })
  assert.equal(files.status, 200)
  assert.equal(await upload('p_rude'), 200)
})

test('after the ban the same doors refuse, and the refusal names the reason', async () => {
  const ban = banParticipant({
    sessionId: ROOM,
    participantId: 'p_rude',
    ip: null,
    byTeacher: 'Преподаватель',
  })
  assert.ok(ban, 'the ban was not created')

  for (const door of ['files', 'history']) {
    const res = await fetch(`${base}/api/sessions/${ROOM}/${door}`, { headers: bearer('p_rude') })
    assert.equal(res.status, 403, `${door} stayed open`)
    const body = (await res.json()) as { error?: string; until?: number }
    // Words about the ban, not "join the session first": the person must
    // understand this is the teacher's decision, not a broken room.
    assert.match(body.error ?? '', /доступ/i, `${door}: the refusal is not about the ban`)
    assert.equal(typeof body.until, 'number', `${door}: there is no end to wait for`)
  }

  // And the main thing is the upload: that is what access is most often closed for.
  assert.equal(await upload('p_rude', 'after-ban.txt'), 403)
  assert.equal(
    fs.existsSync(path.join(sessionDir(ROOM), 'after-ban.txt')),
    false,
    'the file of the banned person still landed in the room',
  )
})

test('the ban does not affect a roommate', async () => {
  const res = await fetch(`${base}/api/sessions/${ROOM}/files`, { headers: bearer('p_quiet') })
  assert.equal(res.status, 200)
  assert.equal(await upload('p_quiet'), 200)
})

test('the teacher passes any ban, including their own', async () => {
  /*
   * A slip (banning oneself from a second tab) must not lock the teacher out
   * of their own room in the middle of a class. This rule lives in `banFor`
   * (staff pass by cookie), and the door must ask exactly it rather than
   * start its own.
   */
  const teacher = createTeacher({ name: 'Ада', email: 'ada.banhttp@test.local', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as Response, teacher)
  const cookie = `${STAFF_COOKIE}=${value}`

  const res = await fetch(`${base}/api/sessions/${ROOM}/files`, {
    headers: { ...bearer('p_rude'), cookie },
  })
  assert.equal(res.status, 200, 'the staff cookie did not open the door')
})

test('room entry still refuses a banned person with its own refusal', async () => {
  /*
   * `/join` checks the ban itself and in its own words: its token is in the
   * request body, not in a header, and the shared door deliberately lets it
   * through. Otherwise the newcomer would see "seminar not found" instead of
   * an explanation.
   */
  const res = await fetch(`${base}/api/sessions/${ROOM}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Гриша', participantId: 'p_rude', token: tokenFor('p_rude') }),
  })
  assert.equal(res.status, 403)
  const body = (await res.json()) as { error?: string }
  assert.match(body.error ?? '', /доступ/i)
})
