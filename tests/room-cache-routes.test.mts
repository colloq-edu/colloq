/**
 * The panel's doors against a room that sits in memory.
 *
 * `getSession` answers from a cache (db.ts · roomCache): "is the seminar the
 * token named still alive" is the only thing every socket's handshake asks,
 * and after a server restart or a relay blink five hundred tabs ask it within
 * a second or two. Such a cache has exactly one price: it has to notice when
 * the room changes — and it is the panel that changes it, and both of its
 * doors wrote to the table with their own SQL, bypassing db.ts.
 *
 * The cache is WARMED here on purpose: a cold one answers from the database
 * and shows no divergence at all, so a test without warming is green whatever
 * breaks.
 *
 * The visible outcome is checked, not the mechanism: a seminar's name has two
 * stores — the row and the notebook's `meta.title` — and the panel has to
 * leave them consistent. Today that holds through two paths at once (the row
 * is written by `renameSession`, the notebook by the same handler, whose
 * observer mirrors it back into the row); the test fails when the last one
 * disappears.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, oldestOwner } from '../server/src/admin/store.js'
import { app } from '../server/src/app.js'
import { createSession, getSession } from '../server/src/db.js'
import { getMeta } from '../shared/notebook.js'
import { visitSessionDoc } from '../server/src/routes/doc-visit.js'

let base = ''
let server: http.Server

before(async () => {
  // Only the owner may delete a seminar, and an empty instance has no owner.
  createTeacher({ name: 'Ада', email: 'ada@room-cache.test', role: 'owner' })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

/** The owner's cookie: issueStaffCookie writes into an express response; this imitates one. */
function ownerCookie(): string {
  const owner = oldestOwner()
  assert.ok(owner, 'an instance without an owner: the test is not about that')
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, owner)
  return `${STAFF_COOKIE}=${value}`
}

function call(
  method: string,
  path: string,
  init: { body?: unknown } = {},
): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: ownerCookie() },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

test('a rename from the panel reaches the room, not just the table', async () => {
  const room = 'panel-rename-cache'
  createSession(room, 'Неделя первая', null)
  // Warming: exactly the read the room card and the socket door live on.
  assert.equal(getSession(room)?.name, 'Неделя первая')

  const res = await call('PATCH', `/api/admin/seminars/${room}`, { body: { name: 'Неделя вторая' } })
  assert.equal(res.status, 200)

  assert.equal(
    getSession(room)?.name,
    'Неделя вторая',
    'the panel renamed the seminar, but until a restart the server returns the old name',
  )
  // And the second place where a seminar has a name: the room header reads the notebook.
  assert.equal(
    visitSessionDoc(room, (doc) => getMeta(doc).get('title')),
    'Неделя вторая',
    'one name in the panel, another for the people in the room',
  )
})

test('a deleted seminar does not stay alive in memory', async () => {
  const room = 'panel-delete-cache'
  createSession(room, 'Под снос', null)
  assert.ok(getSession(room), 'the room was not created: nothing to check')

  const res = await call('DELETE', `/api/admin/seminars/${room}`)
  assert.equal(res.status, 204)

  /*
   * Not "the row is gone from the table" — the cascade test demands that of the
   * route (seminar-delete.test.mts) — but "the server no longer considers the
   * room alive": a token forgotten in a browser lives up to thirty days and
   * knocks on exactly this door, which answers from memory, where the warming above put the room.
   */
  assert.equal(
    getSession(room),
    null,
    'the deletion did not forget the room: an old token would open a socket until a restart',
  )
})
