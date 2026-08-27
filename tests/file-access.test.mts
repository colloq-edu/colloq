/**
 * Who may read a seminar's folder.
 *
 * Both of these routes used to need nothing at all: `GET /files` listed every
 * file in a room and `GET /files/:name` handed any of them over, with no
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
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { signDownloadToken, signToken } from '../server/src/auth.js'
import { createSession } from '../server/src/db.js'
import { fileRoutes } from '../server/src/routes/files.js'
import { sessionDir } from '../server/src/workspace.js'

const ROOM = 'files-auth-test'
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'File access', null)
  fs.writeFileSync(path.join(sessionDir(ROOM), 'handout.csv'), 'a,b\n1,2\n')

  const app = express()
  app.use(fileRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

after(() => server?.close())

const token = () => signToken({ sessionId: ROOM, participantId: 'p_test', role: 'participant' })

test('a stranger cannot list the room’s files', async () => {
  const res = await fetch(`${base}/api/sessions/${ROOM}/files`)
  assert.equal(res.status, 401)
})

test('a stranger cannot download the room’s files', async () => {
  const res = await fetch(`${base}/api/sessions/${ROOM}/files/handout.csv`)
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
    `${base}/api/sessions/${ROOM}/files/handout.csv?token=${encodeURIComponent(ticket)}`,
  )
  assert.equal(res.status, 200)
  assert.match(await res.text(), /1,2/)
})

test('the session token no longer opens a download from the query string', async () => {
  const res = await fetch(
    `${base}/api/sessions/${ROOM}/files/handout.csv?token=${encodeURIComponent(token())}`,
  )
  assert.equal(res.status, 401)
})

test('a ticket for one file does not open another', async () => {
  fs.writeFileSync(path.join(sessionDir(ROOM), 'secret.csv'), 'x\n')
  const ticket = signDownloadToken(ROOM, 'handout.csv')
  const res = await fetch(
    `${base}/api/sessions/${ROOM}/files/secret.csv?token=${encodeURIComponent(ticket)}`,
  )
  assert.equal(res.status, 401)
})

test('only the teacher can remove a file from the room', async () => {
  fs.writeFileSync(path.join(sessionDir(ROOM), 'theirs.csv'), 'a\n')
  const asStudent = await fetch(`${base}/api/sessions/${ROOM}/files/theirs.csv`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token()}` },
  })
  assert.equal(asStudent.status, 403)
  assert.ok(fs.existsSync(path.join(sessionDir(ROOM), 'theirs.csv')), 'a student deleted it anyway')
})

test('a token for another seminar opens nothing here', async () => {
  const other = signToken({ sessionId: 'some-other-room', participantId: 'p_test', role: 'participant' })
  const res = await fetch(
    `${base}/api/sessions/${ROOM}/files/handout.csv?token=${encodeURIComponent(other)}`,
  )
  assert.equal(res.status, 401)
})
