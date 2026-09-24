/**
 * Numbers the panel has to take from the server rather than make up.
 *
 * Two fields, and for both the cost is a line on screen that sounds confident
 * and lies.
 *
 * The upload limit: the seminar creation form prints it ("Up to 50 MB each")
 * and uses it to refuse a file that is too large BEFORE the room exists.
 * While the server did not send it, the panel kept a copy of the default — and
 * an operator who had raised MAX_UPLOAD_MB to 200 read somebody else's number
 * on screen and learned the truth from an upload that never arrived.
 *
 * The class clock: the list row says "Running now · started 25 min ago".
 * Before this clock existed, the row counted from the room's creation — and a
 * room is set up a week before the class and reused for the next one, so next
 * to the word "now" stood "6 days ago".
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { WebSocket } from 'ws'
import { STAFF_COOKIE, type AdminSeminar, type InstanceState } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { config } from '../server/src/config.js'
import { createSession } from '../server/src/db.js'
import { handleCollabSocket, liveSince, shutdownCollab } from '../server/src/collab/index.js'
import { adminAuthRoutes } from '../server/src/routes/admin-auth.js'
import { adminInstanceRoutes } from '../server/src/routes/admin-instance.js'

const ROOM = 'panel-clock'
let base = ''
let server: http.Server
let cookie = ''

function cookieFor(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

/** Exactly what `handleCollabSocket` reads, and nothing more. */
function seat(): { ws: WebSocket; close(): void } {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const fake = {
    binaryType: 'arraybuffer',
    readyState: WebSocket.OPEN as number,
    // Three arguments, the way collab/index.ts sends them: the frame, the
    // compression options and the callback. A two-argument fake caught the
    // options instead of the callback, called them as a function — and the
    // server, catching the exception, closed the socket right away.
    send(_frame: unknown, _opts?: unknown, done?: (err?: Error) => void) {
      done?.()
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
      // Otherwise the heartbeat outlives the test and drags the whole suite along.
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  return { ws: fake as unknown as WebSocket, close: () => fake.close() }
}

before(async () => {
  const teacher = createTeacher({ name: 'Ада', email: 'ada.facts@test.local', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  cookie = cookieFor(teacher)
  createSession(ROOM, 'Пара, которая идёт', null)

  const app = express()
  app.use(express.json())
  app.use(adminAuthRoutes())
  app.use(adminInstanceRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

test('the instance state names the upload limit as a number', async () => {
  const res = await fetch(`${base}/api/admin/state`)
  assert.equal(res.status, 200)
  const state = (await res.json()) as InstanceState
  assert.equal(
    state.maxUploadBytes,
    config.maxUploadBytes,
    'the panel is guessing the limit again instead of reading it',
  )
})

test('the class clock runs from the first socket, not from the room creation', async () => {
  assert.equal(liveSince(ROOM), null, 'a class is "running" in an empty room')

  const opened = Date.now()
  const first = seat()
  handleCollabSocket(first.ws, ROOM, 'participant', 'p_first')
  const started = liveSince(ROOM)
  assert.ok(started !== null && Math.abs(started - opened) < 5_000)

  // The second arrival does not reset the clock: the class runs from the first one.
  const second = seat()
  handleCollabSocket(second.ws, ROOM, 'participant', 'p_second')
  assert.equal(liveSince(ROOM), started, 'a latecomer moved the start of the class to themselves')

  const res = await fetch(`${base}/api/admin/seminars`, { headers: { cookie } })
  const rows = (await res.json()) as AdminSeminar[]
  const row = rows.find((one) => one.id === ROOM)
  assert.ok(row)
  assert.equal(row.liveSince, started, 'the class clock did not reach the panel')
  assert.notEqual(row.liveSince, row.createdAt, 'the room clock again instead of the class clock')

  first.close()
  second.close()
  // The room emptied, so there is no clock any more: a break between classes is
  // no different from the end of a class.
  assert.equal(liveSince(ROOM), null)
})
