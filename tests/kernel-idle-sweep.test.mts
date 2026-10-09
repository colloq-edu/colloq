/**
 * The idle sweep and stopped containers.
 *
 * It asked `docker ps` without `-a`, that is, it saw only live containers. A
 * stopped one (and after a machine reboot with `--restart=no` ALL of
 * yesterday's become stopped) did not exist for it at all — and was never
 * removed, neither after two hours nor after a week: only by hand or when the
 * same room was opened again. On a GPU machine this means that slices are held
 * by rooms nobody will open again, and a new seminar hears "no free slices:
 * there are two, and both are taken by other seminars".
 *
 * The rule is kept separate from docker because that is exactly where the bug
 * was.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { idleVerdict } from '../server/src/kernel/index.js'

const MINUTE = 60 * 1000
const now = 1_700_000_000_000

test('a busy room is never swept', () => {
  // A computing cell, a queue, a shell command or live tabs — all of this is
  // work with an owner, and the container must not be torn down under it.
  assert.equal(idleVerdict({ running: true, busy: true, since: now - 300 * MINUTE, now }), 'busy')
  assert.equal(idleVerdict({ running: false, busy: true, since: now - 300 * MINUTE, now }), 'busy')
})

test('an empty room is first put on watch, not swept', () => {
  // The first look starts the clock, it is not a verdict: otherwise a server
  // restart would tear down the containers of all running classes at once.
  assert.equal(idleVerdict({ running: true, busy: false, since: undefined, now }), 'watch')
  assert.equal(idleVerdict({ running: false, busy: false, since: undefined, now }), 'watch')
})

test('a live container is kept for two hours — a class plus coffee', () => {
  assert.equal(idleVerdict({ running: true, busy: false, since: now - 90 * MINUTE, now }), 'watch')
  assert.equal(idleVerdict({ running: true, busy: false, since: now - 121 * MINUTE, now }), 'drop')
})

test('a stopped container is swept — and sooner than a live one', () => {
  // There is nothing to lose there: its Python died with it, while it still
  // holds a layer on disk and a GPU slice. Two hours of waiting is a whole
  // morning without the card.
  assert.equal(idleVerdict({ running: false, busy: false, since: now - 10 * MINUTE, now }), 'watch')
  assert.equal(idleVerdict({ running: false, busy: false, since: now - 31 * MINUTE, now }), 'drop')
  // And the main thing: it gets a verdict at all instead of living forever.
  assert.equal(
    idleVerdict({ running: false, busy: false, since: now - 24 * 60 * MINUTE, now }),
    'drop',
  )
})

test("the owner's room setting replaces the two hours, and 0 keeps a live room for good", () => {
  // `roomIdleMin` (admin/resource-settings.ts), in milliseconds as the sweep passes it.
  const tenMinutes = 10 * MINUTE
  assert.equal(idleVerdict({ running: true, busy: false, since: now - 9 * MINUTE, now, limitMs: tenMinutes }), 'watch')
  assert.equal(idleVerdict({ running: true, busy: false, since: now - 11 * MINUTE, now, limitMs: tenMinutes }), 'drop')
  // A longer setting keeps a room the old two hours would have taken.
  assert.equal(idleVerdict({ running: true, busy: false, since: now - 150 * MINUTE, now, limitMs: 180 * MINUTE }), 'watch')
  // Never: a live room stays however long it is empty; a busy one is busy as always.
  assert.equal(idleVerdict({ running: true, busy: false, since: now - 7 * 24 * 60 * MINUTE, now, limitMs: null }), 'watch')
  assert.equal(idleVerdict({ running: true, busy: true, since: now - 300 * MINUTE, now, limitMs: tenMinutes }), 'busy')
})

test('a stopped container never outlives a live one, and "never" leaves it its half hour', () => {
  // It holds no variables, only a slice and a layer: the shorter of the two waits.
  assert.equal(idleVerdict({ running: false, busy: false, since: now - 11 * MINUTE, now, limitMs: 10 * MINUTE }), 'drop')
  assert.equal(idleVerdict({ running: false, busy: false, since: now - 20 * MINUTE, now, limitMs: 180 * MINUTE }), 'watch')
  assert.equal(idleVerdict({ running: false, busy: false, since: now - 31 * MINUTE, now, limitMs: 180 * MINUTE }), 'drop')
  // "Never" is about live kernels someone may come back to; a stopped one has none.
  assert.equal(idleVerdict({ running: false, busy: false, since: now - 31 * MINUTE, now, limitMs: null }), 'drop')
})
