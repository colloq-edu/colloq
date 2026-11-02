/**
 * Tickets for the folder images of a note (web/src/lib/note-files.svelte.ts).
 *
 * Every failed ticket request used to be remembered as a refusal until the
 * tab was reloaded, so a Wi-Fi blip at the moment a room opened left its
 * images broken for the rest of the class: two asks, one request, no image
 * (the audit's probe, reproduced on the real module). What is checked here is
 * the rule that replaced it: a refusal is about the file and lasts until the
 * file shows up in the room; a failure is about the moment and is asked again
 * after a bounded wait, and at once when the connection returns — never
 * faster than the floor, however often it flaps; a stale ticket is renewed
 * every time it fails, a fresh one once.
 *
 * There is no Svelte compiler here: `$state` is a fake that returns the value
 * as is (as in tests/council-client.test.mts), so nothing re-runs by itself —
 * the test asks again where a note's effect would.
 */
import { test, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const shim = <T,>(value: T): T => value
;(globalThis as { $state?: unknown }).$state = shim

const { api, ApiError } = await import('../web/src/lib/api.js')
const { askFiles, fileSrc, filesReconnected, forgetFileSrc, pathOfFileSrc, retryDelay } = await import(
  '../web/src/lib/note-files.svelte.js'
)

type Answer = 'ok' | 'offline' | number | { status: number; retryAfter: number }

/** The ticket route, answering from a script: each request takes the next answer. */
function server(...answers: Answer[]): { calls: () => number } {
  let calls = 0
  api.fileTicket = async () => {
    calls += 1
    const answer = answers.shift() ?? 'ok'
    if (answer === 'ok') return { token: `ticket-${calls}` }
    if (answer === 'offline') throw new ApiError('Connection lost', 0)
    if (typeof answer === 'number') throw new ApiError(`HTTP ${answer}`, answer)
    throw new ApiError('Too many requests', answer.status, answer.retryAfter)
  }
  return { calls: () => calls }
}

/** Let a request's then/catch/finally run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const PATH = 'assets/fig01.png'
let room = 0
const fresh = (): string => `room-${++room}`

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  // The longest wait of every step: the checks below are about the ceiling.
  mock.method(Math, 'random', () => 1)
})

afterEach(() => {
  mock.timers.reset()
  mock.restoreAll()
})

test('a request lost on the way is asked again, and the image arrives without a reload', async () => {
  const id = fresh()
  const ticket = server('offline', 'ok')
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 1)
  assert.equal(fileSrc(id, PATH), null)
  // A redraw a moment later is not another request: the wait is not over.
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 1)
  mock.timers.tick(2_000)
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 2)
  assert.match(fileSrc(id, PATH) ?? '', /token=ticket-2/)
})

test('a server error is a moment too, and the waits double up to a minute', async () => {
  const id = fresh()
  const ticket = server(503, 502, 'ok')
  askFiles(id, 'token', [PATH])
  await settle()
  mock.timers.tick(1_999)
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 1, 'asked before the first wait was over')
  mock.timers.tick(1)
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 2)
  // The second failure waits twice as long.
  mock.timers.tick(3_999)
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 2)
  mock.timers.tick(1)
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 3)
  assert.notEqual(fileSrc(id, PATH), null)
  // The ladder itself: doubling, a ceiling, half of every step random.
  assert.deepEqual([1, 2, 3, 4, 5, 6, 40].map((n) => retryDelay(n, 1)), [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
  assert.equal(retryDelay(3, 0), 4_000)
})

test('the connection coming back asks at once, and flapping does not hammer', async () => {
  const id = fresh()
  const ticket = server('offline', 'offline', 'ok')
  askFiles(id, 'token', [PATH])
  await settle()
  mock.timers.tick(2_000)
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 2)
  // Now a four-second wait. The network flaps back ten times within it.
  for (let i = 0; i < 10; i++) {
    mock.timers.tick(100)
    filesReconnected(id)
    askFiles(id, 'token', [PATH])
    await settle()
  }
  assert.equal(ticket.calls(), 2, 'a flapping connection knocked more than once per floor')
  // The floor is two seconds after the last try — sooner than the four-second wait.
  mock.timers.tick(1_000)
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 3)
  assert.notEqual(fileSrc(id, PATH), null)
})

test('a reconnect does not cut short a wait the server named', async () => {
  const id = fresh()
  const ticket = server({ status: 429, retryAfter: 30 }, 'ok')
  askFiles(id, 'token', [PATH])
  await settle()
  mock.timers.tick(5_000)
  filesReconnected(id)
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 1)
  mock.timers.tick(25_000)
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 2)
})

test('a missing file is not asked for again until it appears in the room', async () => {
  const id = fresh()
  const ticket = server(404, 'ok')
  let listed = false
  const present = (): boolean => listed
  askFiles(id, 'token', [PATH], present)
  await settle()
  assert.equal(ticket.calls(), 1)
  // Redraws, time and reconnects change nothing about a file that is not there.
  for (let i = 0; i < 3; i++) askFiles(id, 'token', [PATH], present)
  mock.timers.tick(10 * 60_000)
  filesReconnected(id)
  askFiles(id, 'token', [PATH], present)
  await settle()
  assert.equal(ticket.calls(), 1)
  // The teacher drags the figure into the folder.
  listed = true
  askFiles(id, 'token', [PATH], present)
  await settle()
  assert.equal(ticket.calls(), 2)
  assert.notEqual(fileSrc(id, PATH), null)
})

test('a refusal that came while the tree still listed the file waits for it to come back', async () => {
  const id = fresh()
  const ticket = server(404, 'ok')
  let listed = true
  const present = (): boolean => listed
  // The tree is a moment behind a deletion: listed, but gone.
  askFiles(id, 'token', [PATH], present)
  await settle()
  askFiles(id, 'token', [PATH], present)
  await settle()
  assert.equal(ticket.calls(), 1, 'a stale tree turned into a request per redraw')
  listed = false
  askFiles(id, 'token', [PATH], present)
  listed = true
  askFiles(id, 'token', [PATH], present)
  await settle()
  assert.equal(ticket.calls(), 2)
})

test('a stale ticket is renewed each time its image fails, a fresh one only once', async () => {
  const id = fresh()
  const ticket = server()
  askFiles(id, 'token', [PATH])
  await settle()
  const first = fileSrc(id, PATH)
  assert.equal(pathOfFileSrc(id, first ?? ''), PATH)
  // A fresh address that fails is about the file: one more try, not a loop.
  assert.equal(forgetFileSrc(id, PATH), true)
  askFiles(id, 'token', [PATH])
  await settle()
  assert.equal(ticket.calls(), 2)
  assert.equal(forgetFileSrc(id, PATH), false)
  // An hour-long class: the tab sleeps, wakes with an expired ticket — twice.
  for (const calls of [3, 4]) {
    mock.timers.tick(5 * 60_000)
    assert.equal(forgetFileSrc(id, PATH), true, 'an expired ticket was not renewed')
    askFiles(id, 'token', [PATH])
    await settle()
    assert.equal(ticket.calls(), calls)
    assert.match(fileSrc(id, PATH) ?? '', new RegExp(`token=ticket-${calls}`))
  }
})

test('the end of a wait reaches the notes through a call, not a bare read', () => {
  // The TypeScript transform that runs on .svelte.ts before Svelte drops
  // `void due;` as an expression without effects: on the production build the
  // retry was scheduled and no note ever asked again. Here `$state` is a fake,
  // so only tests/browser/note-images.spec.ts can see the effect itself.
  const source = readFileSync(new URL('../web/src/lib/note-files.svelte.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*void due\b/m)
  assert.match(source.slice(source.indexOf('export function askFiles')), /^\s*waitsEnded\(\)/m)
})

test('the rooms and paths do not share their answers', async () => {
  const one = fresh()
  const two = fresh()
  const ticket = server(404, 'ok', 'ok')
  askFiles(one, 'token', [PATH])
  await settle()
  askFiles(two, 'token', [PATH, 'assets/other.png'])
  await settle()
  assert.equal(ticket.calls(), 3)
  assert.equal(fileSrc(one, PATH), null)
  assert.notEqual(fileSrc(two, PATH), null)
  assert.notEqual(fileSrc(two, 'assets/other.png'), null)
})
