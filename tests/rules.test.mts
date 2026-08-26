/**
 * The rules of a room, and the one that is actually kept.
 *
 * Six of the seven fields in RoomRules are stored and not yet enforced — the
 * interface says so out loud rather than drawing them as switches that do
 * nothing. `run` is the exception, and these tests are what make the difference
 * between the two states honest: if `allows` ever stops letting the host
 * through, or a stored rule stops surviving the round trip, the screen starts
 * promising something the server does not do.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPEN_ROOM, allows, isOpenRoom, readRules } from '../shared/rules.js'
import { createSession, getRules, setRules } from '../server/src/db.js'

test('a room with no rules stored is the open room the product has always been', () => {
  const id = 'rules-default'
  createSession(id, 'Rules test', null)
  assert.deepEqual(getRules(id), OPEN_ROOM)
  assert.ok(isOpenRoom(getRules(id)))
})

test('the host is never locked out by a rule', () => {
  assert.equal(allows('host', 'host'), true, 'a host-only rule locked out the host')
  assert.equal(allows('room', 'host'), true)
})

test('a host-only rule refuses everybody else', () => {
  assert.equal(allows('host', 'participant'), false)
  assert.equal(allows('room', 'participant'), true)
})

test('a rule survives being written and read back', () => {
  const id = 'rules-round-trip'
  createSession(id, 'Rules test', null)
  setRules(id, { ...OPEN_ROOM, run: 'host', oracle: 'hints' })
  const back = getRules(id)
  assert.equal(back.run, 'host')
  assert.equal(back.oracle, 'hints')
  assert.equal(back.edit, 'room', 'an unset field did not come back as the open default')
  assert.ok(!isOpenRoom(back))
})

test('nonsense in the rules column reads as the open room, not as an error', () => {
  /*
   * A row written by an older build, a hand-edited database, a field added
   * after this seminar was created. None of those may open a room with no rules
   * at all, so every unreadable field falls back to the permissive default.
   */
  assert.deepEqual(readRules('not json at all'), OPEN_ROOM)
  assert.deepEqual(readRules(null), OPEN_ROOM)
  assert.equal(readRules({ run: 'nobody' }).run, 'room')
  assert.equal(readRules({ oracle: 'maybe' }).oracle, 'inherit')
})

test('a model name is trimmed and bounded, or dropped', () => {
  assert.equal(readRules({ model: '  gpt-4o-mini  ' }).model, 'gpt-4o-mini')
  assert.equal(readRules({ model: '   ' }).model, null)
  assert.equal(readRules({ model: 'x'.repeat(500) }).model?.length, 80)
})
