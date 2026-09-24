/**
 * How a room is set up and what happens on entering it.
 *
 * Three things the room's doors did differently:
 *
 *  - `POST /api/sessions` wrote the environment as NULL, and to the kernel
 *    NULL means "follow the instance": the next "Make default" moved such a
 *    room's Python to another image. The panel abolished this state and always
 *    writes a concrete name — while the scripting door lived by the old rule.
 *  - `/join` warmed the kernel unconditionally, that is, it started the room's
 *    container (two gigabytes, two hours of idling) for EVERYONE who opened a
 *    link to a finished seminar to reread the walkthrough.
 *  - the name was cleaned by three verbatim copies of one function, and the
 *    fourth door — import — made do with `trim()`, so line breaks ended up in
 *    the panel's list.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { normalizeLabel } from '../shared/text.js'
import { createSession, getSession, sessionEnvironment, setFinished } from '../server/src/db.js'
import { activeName } from '../server/src/environments.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { app } from '../server/src/app.js'
import { warmsKernel } from '../server/src/routes/sessions.js'

let base = ''
let server: http.Server
let cookie = ''

before(async () => {
  const owner = createTeacher({ name: 'Ада', email: 'ada.open@test.local', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as Response, owner)
  cookie = `${STAFF_COOKIE}=${value}`

  /*
   * The whole application (server/src/app.ts), not our own express next to
   * it: a copy of the middleware order does not catch divergence from the
   * product, it repeats it.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/* ----------------------------------------------------------- environment */

test('a seminar created through the API remembers the environment name, not "same as the instance"', async () => {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Скриптовый семинар' }),
  })
  assert.equal(res.status, 201)
  const { session } = (await res.json()) as { session: { id: string } }
  /*
   * NULL here would mean "ask the instance at every kernel start": the room
   * would move to another image at the next change of the default, and the
   * panel would not count it among those that keep an environment from being
   * deleted.
   */
  assert.equal(sessionEnvironment(session.id), activeName())
})

test('a nonexistent environment is refused, not stored as the name of an image that does not exist', async () => {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'На чужом образе', environment: 'no-such-env' }),
  })
  assert.equal(res.status, 400)
})

/* ---------------------------------------------------------- kernel warm-up */

test('the kernel warms up for a live room, and for a finished one only for the teacher', () => {
  const id = 'warm-finished'
  createSession(id, 'Прошлая пара', 'base')
  assert.equal(warmsKernel(id, 'participant'), true, 'a live room does not warm up the kernel')

  setFinished(id, Date.now())
  assert.equal(
    warmsKernel(id, 'participant'),
    false,
    'entering a finished seminar started a container for a student',
  )
  // A teacher comes into a finished room to recompute something.
  assert.equal(warmsKernel(id, 'host'), true)

  setFinished(id, null)
  assert.equal(warmsKernel(id, 'participant'), true, 'a reopened room does not warm up')
})

test('an archived seminar does not start the kernel either', async () => {
  const id = 'warm-archived'
  createSession(id, 'Прошлый семестр', 'base')
  const res = await fetch(`${base}/api/admin/seminars/${id}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ archived: true }),
  })
  assert.equal(res.status, 200)
  assert.equal(warmsKernel(id, 'participant'), false)
  assert.equal(warmsKernel(id, 'host'), true)
})

/* ------------------------------------------------------------------- names */

test('a line break in a name becomes a space, not a broken layout', () => {
  assert.equal(normalizeLabel('a\nb\tc'), 'a b c')
  assert.equal(normalizeLabel('  Нина   Петрова  '), 'Нина Петрова')
  assert.equal(normalizeLabel(42), '')
})

test('import measures a name by the same yardstick as the other three doors', async () => {
  const res = await fetch(`${base}/api/admin/import/notebook`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Неделя\n4\tДеревья',
      cells: [{ cell_type: 'code', source: 'print(1)' }],
    }),
  })
  assert.equal(res.status, 201)
  const { id } = (await res.json()) as { id: string }
  assert.equal(getSession(id)?.name, 'Неделя 4 Деревья')
})

test('a room from the API cleans its name too', async () => {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Семинар\nвторой' }),
  })
  assert.equal(res.status, 201)
  const { session } = (await res.json()) as { session: { id: string; name: string } }
  assert.equal(session.name, 'Семинар второй')
})
