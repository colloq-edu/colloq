/**
 * What the return of a whole hall costs the database: the room row and the
 * host right behind a token.
 *
 * After a server restart or a relay blink, five hundred tabs come back within a
 * second or two, two sockets each, and on every handshake the server asked the
 * same thing: is the seminar still alive (`getSession`) and is this person the
 * host (`isTokenHost`). A thousand primary-key SELECTs — microseconds each, and
 * half a second of a busy event loop exactly in the minute when everyone is
 * waiting for the room to come back.
 *
 * This pins that the answer now comes from memory — and, more importantly, that
 * it is forgotten EVERYWHERE it changes: a rights cache that survived the end
 * of a class or the deletion of a seminar is not slow, it is wrong.
 *
 * Measurement (this machine, a room of 500 people, a thousand handshakes in a
 * row):
 *
 *   from the database, as before ...... 6.59 ms
 *   from memory, as now ............... 0.08 ms
 *
 * The ceiling in the test has an order of magnitude of headroom: on a loaded
 * machine timings drift, and a test that fails because of a neighbouring
 * process is worse than no test at all.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSession,
  db,
  forgetRoom,
  forgetRules,
  getRules,
  getSession,
  isTokenHost,
  renameSession,
  setFinished,
  setRules,
  storedRules,
  upsertParticipant,
} from '../server/src/db.js'

/**
 * A write that bypasses this module — by hand in sqlite3, as in the comment at
 * the cache — is the proof: if the question still reached the database, the new
 * value would show up. No product path writes this way.
 */
const renameBehindTheBack = db.prepare('UPDATE sessions SET name = ? WHERE id = ?')
const rulesBehindTheBack = db.prepare('UPDATE sessions SET rules = ? WHERE id = ?')
const hostBehindTheBack = db.prepare('UPDATE participants SET token_host = 1 WHERE id = ?')

/** How many milliseconds it took: the best of the runs, not the first. */
function fastest(times: number, run: () => void): number {
  let best = Infinity
  for (let i = 0; i < times; i++) {
    const at = process.hrtime.bigint()
    run()
    best = Math.min(best, Number(process.hrtime.bigint() - at) / 1e6)
  }
  return best
}

test('the room row is read once, not on every handshake', () => {
  const id = 'cache-room'
  createSession(id, 'Комната', null)
  assert.equal(getSession(id)?.name, 'Комната')

  renameBehindTheBack.run('Мимо кэша', id)
  assert.equal(getSession(id)?.name, 'Комната', 'the room row is read on every question')

  // There is one write door, and it forgets: a name changed by the product is
  // visible at once — otherwise the panel would rename the seminar and the room
  // would answer with the old name until a restart.
  renameSession(id, 'Переименована')
  assert.equal(getSession(id)?.name, 'Переименована')
})

test('one row fills both caches: the rules arrive with it, not in a second query', () => {
  const id = 'cache-one-read'
  createSession(id, 'Одно чтение', null)
  setRules(id, { ...storedRules(id), run: 'host' })
  forgetRoom(id)

  // The very first question about the room reads the whole row, rules included.
  assert.equal(getSession(id)?.rules.run, 'host')
  rulesBehindTheBack.run(JSON.stringify({ ...storedRules(id), run: 'room' }), id)
  assert.equal(getRules(id).run, 'host', 'the rules were fetched from the database a second time')
})

test('rules go out as their own copy', () => {
  const id = 'cache-copy'
  createSession(id, 'Копия', null)
  const seen = getSession(id)
  assert.ok(seen)
  seen.rules.run = 'host'
  assert.equal(storedRules(id).run, 'room', 'the whole room saw an edit made to a handed-out copy')
})

test('the end of a class is visible at once, not after a restart', () => {
  const id = 'cache-finished'
  createSession(id, 'Занятие', null)
  assert.equal(getSession(id)?.finishedAt, null)

  setFinished(id, 1_700_000_000_000)
  assert.equal(getSession(id)?.finishedAt, 1_700_000_000_000)
  setFinished(id, null)
  assert.equal(getSession(id)?.finishedAt, null)
})

test('"no such room" does not survive the room being created', () => {
  const id = 'cache-later'
  // A student opened the link before the teacher pressed "Create".
  assert.equal(getSession(id), null)

  createSession(id, 'Появилась', null)
  assert.equal(getSession(id)?.name, 'Появилась')
})

test('a deleted seminar stops opening the door', () => {
  const id = 'cache-gone'
  createSession(id, 'Удалённый', null)
  upsertParticipant({
    id: 'p_host',
    sessionId: id,
    name: 'Ведущий',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  assert.ok(getSession(id))
  assert.equal(isTokenHost(id, 'p_host'), true)

  // Exactly what the deletion route does (routes/admin-instance.ts): the row is
  // gone, the room is forgotten. A cache that outlived it would let an old token
  // through a door that no longer exists, until the token itself expires.
  db.prepare('DELETE FROM participants WHERE session_id = ?').run(id)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  forgetRules(id)

  assert.equal(getSession(id), null)
  assert.equal(isTokenHost(id, 'p_host'), false)
})

test('the token right is remembered per person and refreshed by a join', () => {
  const id = 'cache-host'
  createSession(id, 'Права', null)
  upsertParticipant({
    id: 'p_student',
    sessionId: id,
    name: 'Студент',
    avatar: null,
    role: 'participant',
  })
  assert.equal(isTokenHost(id, 'p_student'), false)

  hostBehindTheBack.run('p_student')
  assert.equal(isTokenHost(id, 'p_student'), false, 'the right is asked of the database on every socket')

  // A join with the host key is that very write door, and it puts the new right
  // into the cache at once: the very first handshake will ask for exactly that.
  upsertParticipant({
    id: 'p_student',
    sessionId: id,
    name: 'Студент',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  assert.equal(isTokenHost(id, 'p_student'), true)

  // A stranger who is not in the room: the same answer, and also only once.
  assert.equal(isTokenHost(id, 'p_ghost'), false)
  // And the right in one room does not speak for the next one: a room key stays
  // a key to that room only.
  const other = 'cache-host-other'
  createSession(other, 'Соседняя', null)
  assert.equal(isTokenHost(other, 'p_student'), false)
})

test('the return storm: a thousand handshakes cost one hall, not a thousand reads', () => {
  const id = 'cache-storm'
  createSession(id, 'Зал', null)
  const people: string[] = []
  for (let i = 0; i < 500; i++) {
    const who = `p_${i}`
    people.push(who)
    upsertParticipant({
      id: `${id}-${who}`,
      sessionId: id,
      name: `Студент ${i}`,
      avatar: null,
      role: 'participant',
    })
  }
  const ids = people.map((who) => `${id}-${who}`)

  // A handshake: is the seminar alive (index.ts) and who is this (routes/sessions.ts ·
  // roleFor). Two sockets per tab make a thousand per hall.
  const handshakes = (forget: boolean) => () => {
    for (let i = 0; i < 1000; i++) {
      if (forget) forgetRoom(id)
      getSession(id)
      isTokenHost(id, ids[i % ids.length])
    }
  }
  const warm = fastest(3, handshakes(false))
  const cold = fastest(3, handshakes(true))

  assert.ok(
    warm * 3 < cold,
    `from memory ${warm.toFixed(2)} ms against ${cold.toFixed(2)} ms from the database: the cache stopped working`,
  )
  assert.ok(warm < 20, `a thousand handshakes took ${warm.toFixed(2)} ms`)
})
