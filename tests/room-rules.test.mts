/**
 * A rule the product cannot keep must not be presented as one.
 *
 * These pin the two rules that are actually enforced today, and the shape of
 * the defaults — because the defaults are a promise too: a seminar created
 * before rules existed, and a seminar whose teacher never opened the settings,
 * must behave exactly as Colloq always has.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPEN_ROOM, isOpenRoom, readRules } from '../shared/rules.js'
import { createSession, getRules, getSession, setRules } from '../server/src/db.js'

test('a room with nothing decided about it is the open room', () => {
  const id = 'rules-default'
  createSession(id, 'Rules', null)
  assert.deepEqual(getRules(id), OPEN_ROOM)
  assert.ok(isOpenRoom(getSession(id)!.rules))
})

test('a half-written rule set still opens a room', () => {
  // A row from an older build, a hand-edited database, a field added later.
  // None of those may leave a room with no rules at all.
  const rules = readRules('{"run":"host","nonsense":1}')
  assert.equal(rules.run, 'host')
  assert.equal(rules.edit, OPEN_ROOM.edit, 'an absent field did not fall back')
  assert.equal(rules.oracle, 'inherit')
})

test('a value nobody recognises falls back to the permissive default', () => {
  const rules = readRules({ run: 'nobody', oracle: 'maybe' })
  assert.equal(rules.run, 'room')
  assert.equal(rules.oracle, 'inherit')
})

test('rules survive a round trip through the database', () => {
  const id = 'rules-store'
  createSession(id, 'Rules', null)
  setRules(id, { ...OPEN_ROOM, run: 'host', oracle: 'hints' })
  const back = getRules(id)
  assert.equal(back.run, 'host')
  assert.equal(back.oracle, 'hints')
  assert.equal(back.edit, 'room', 'an untouched rule changed')
  assert.ok(!isOpenRoom(back))
})

test('what is stored is always a complete, valid set', () => {
  const id = 'rules-clean'
  createSession(id, 'Rules', null)
  // Whatever a caller hands in, a later read cannot be surprised by it.
  setRules(id, { run: 'host' } as never)
  const back = getRules(id)
  assert.equal(back.run, 'host')
  assert.equal(back.files, 'room')
  assert.equal(back.model, null)
})

test('rules are written once, at creation, and read back exactly as written', () => {
  /*
   * The title here used to be about the GitHub import — "the import route did
   * not read rules, and 'Teacher only' + 'Oracle: off' gave a room where Run
   * was open to everyone" — while the body called `setRules` and `getRules`
   * directly and would have missed that very regression entirely. The route is
   * tested through the route: `tests/import-github.test.mts`. What stays here
   * is what the body really pins: rules are laid down at creation (there is
   * nowhere to edit them afterwards) and come back exactly as they were laid.
   */
  const id = 'rules-import'
  createSession(id, 'Импорт', null)
  setRules(id, readRules({ run: 'host', oracle: 'off' }))
  assert.equal(getRules(id).run, 'host')
  assert.equal(getRules(id).oracle, 'off')
})
