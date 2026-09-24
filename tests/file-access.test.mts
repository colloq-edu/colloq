/**
 * Who may read a seminar's folder.
 *
 * Both of these routes used to need nothing at all: `GET /files` listed every
 * file in a room and `GET /file?path=` handed any of them over, with no
 * credential of any kind. A seminar id is eight characters — short on purpose,
 * because the link gets read aloud in a lecture hall — so it is guessable
 * rather than secret, and the folder holds the material the class was given and
 * everything the class uploaded.
 *
 * The download takes its credential from the query string, and that is not a
 * shortcut: a download is an `<a href>`, and an anchor cannot carry an
 * Authorization header. Both forms are pinned here, because a later refactor
 * that "tidied" the query form away would silently break every download.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { signDownloadToken, signToken } from '../server/src/auth.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { app } from '../server/src/app.js'
import { sessionDir } from '../server/src/workspace.js'

const ROOM = 'files-auth-test'
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'File access', null)
  fs.writeFileSync(path.join(sessionDir(ROOM), 'handout.csv'), 'a,b\n1,2\n')
  /*
   * The role is decided on every request and is not read from the token
   * (routes/sessions.ts · roleFor): "host" in the signature means nothing
   * until the participant row is marked token_host. This is the only path
   * where the host token is the whole credential — a seminar created
   * directly against the API.
   */
  upsertParticipant({
    id: 'p_host',
    sessionId: ROOM,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })

  /*
   * The room's doors are mounted by the application (server/src/app.ts), not
   * by a single router: in the product, files stand behind the write-origin
   * check and the ban at the entrance, and a refusal must come from the same
   * place it will come from in class.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

after(() => server?.close())

const token = () => signToken({ sessionId: ROOM, participantId: 'p_test', role: 'participant' })
const hostToken = () => signToken({ sessionId: ROOM, participantId: 'p_host', role: 'host' })

test('a stranger cannot list the room’s files', async () => {
  const res = await fetch(`${base}/api/sessions/${ROOM}/files`)
  assert.equal(res.status, 401)
})

test('a stranger cannot download the room’s files', async () => {
  const res = await fetch(`${base}/api/sessions/${ROOM}/file?path=handout.csv`)
  assert.equal(res.status, 401)
})

test('somebody in the room can list them', async () => {
  const res = await fetch(`${base}/api/sessions/${ROOM}/files`, {
    headers: { authorization: `Bearer ${token()}` },
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { files: { name: string }[] }
  assert.ok(body.files.some((f) => f.name === 'handout.csv'))
})

test('a download carries a ticket in the query string, not the session token', async () => {
  /*
   * An <a href download> cannot send a header, so something must ride in the
   * URL — but the session token opens the control socket, and a link with it
   * in is a link that hands Restart to whoever it is forwarded to. What rides
   * there now names one file and dies in five minutes.
   */
  const ticket = signDownloadToken(ROOM, 'handout.csv')
  const res = await fetch(
    `${base}/api/sessions/${ROOM}/file?path=handout.csv&token=${encodeURIComponent(ticket)}`,
  )
  assert.equal(res.status, 200)
  assert.match(await res.text(), /1,2/)
})

test('the session token no longer opens a download from the query string', async () => {
  const res = await fetch(
    `${base}/api/sessions/${ROOM}/file?path=handout.csv&token=${encodeURIComponent(token())}`,
  )
  assert.equal(res.status, 401)
})

test('a ticket for one file does not open another', async () => {
  fs.writeFileSync(path.join(sessionDir(ROOM), 'secret.csv'), 'x\n')
  const ticket = signDownloadToken(ROOM, 'handout.csv')
  const res = await fetch(
    `${base}/api/sessions/${ROOM}/file?path=secret.csv&token=${encodeURIComponent(ticket)}`,
  )
  assert.equal(res.status, 401)
})

test('only the teacher can remove a file from the room', async () => {
  fs.writeFileSync(path.join(sessionDir(ROOM), 'theirs.csv'), 'a\n')
  const asStudent = await fetch(`${base}/api/sessions/${ROOM}/file?path=theirs.csv`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token()}` },
  })
  assert.equal(asStudent.status, 403)
  assert.ok(fs.existsSync(path.join(sessionDir(ROOM), 'theirs.csv')), 'a student deleted it anyway')

  /*
   * And the second half of the deal, without which the first is worth
   * nothing: a permission that refuses everyone is not a permission.
   * Checking only the 403 for a student left the teacher's broken deletion
   * invisible — and the teacher deletes a dataset exactly to free up space.
   */
  const asHost = await fetch(`${base}/api/sessions/${ROOM}/file?path=theirs.csv`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${hostToken()}` },
  })
  assert.equal(asHost.status, 200)
  assert.equal(
    fs.existsSync(path.join(sessionDir(ROOM), 'theirs.csv')),
    false,
    'the teacher pressed "remove", and the file stayed',
  )
})

test('deletion does not leave the room folder even for the teacher', async () => {
  // The room folder is this route's whole world. `..` in the path is not
  // "remove the neighbouring seminar", it is a refusal.
  const outside = path.join(sessionDir(ROOM), '..', 'not-mine.csv')
  fs.writeFileSync(outside, 'чужое\n')
  const res = await fetch(
    `${base}/api/sessions/${ROOM}/file?path=${encodeURIComponent('../not-mine.csv')}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${hostToken()}` } },
  )
  assert.ok(res.status === 400 || res.status === 404, `a path outside passed as ${res.status}`)
  assert.ok(fs.existsSync(outside), 'the deletion went outside the room folder')
  fs.rmSync(outside, { force: true })
})

test('a download ticket from another seminar opens nothing here', async () => {
  /*
   * The cross-room case, and it is the only meaningful one here: the check
   * "a session token in the query is not accepted" already stands above and
   * refuses regardless of the room, so this path is not checked with someone
   * else's session token at all. The ticket is signed for THE SAME handout,
   * but in another room — should sessionId ever fall out of the signature, a
   * link from one seminar would start opening the files of all the others.
   */
  const elsewhere = signDownloadToken('some-other-room', 'handout.csv')
  const res = await fetch(
    `${base}/api/sessions/${ROOM}/file?path=handout.csv&token=${encodeURIComponent(elsewhere)}`,
  )
  assert.equal(res.status, 401)

  // And the other way round: this room's ticket is not accepted in another
  // room either.
  const mine = signDownloadToken(ROOM, 'handout.csv')
  const there = await fetch(
    `${base}/api/sessions/some-other-room/file?path=handout.csv&token=${encodeURIComponent(mine)}`,
  )
  assert.ok(there.status === 401 || there.status === 404, `the other room answered ${there.status}`)
})

test('a token for another seminar opens nothing here', async () => {
  const other = signToken({ sessionId: 'some-other-room', participantId: 'p_test', role: 'participant' })
  const res = await fetch(
    `${base}/api/sessions/${ROOM}/file?path=handout.csv&token=${encodeURIComponent(other)}`,
  )
  assert.equal(res.status, 401)
})
