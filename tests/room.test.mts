/**
 * How many people are in the room.
 *
 * Awareness lists sockets, and a seminar is full of people who are more than
 * one socket: a second tab, a reload whose old connection has not timed out, a
 * phone open on the same link. Two places in the same bar answered this
 * differently — the People panel counted participants, the header's avatar row
 * counted client ids — so the room could read "4 in the room" above a list of
 * three, one of them printed twice.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { peopleInRoom, type RoomPeer } from '../web/src/lib/room.js'

let clientId = 1
function socket(id: string, name: string, extra: Partial<RoomPeer['user']> = {}, isSelf = false): RoomPeer {
  return {
    clientId: clientId++,
    isSelf,
    user: { id, name, avatar: null, color: '#7e82f0', role: 'participant', ...extra },
  }
}

test('one person on one socket is one person', () => {
  const people = peopleInRoom([socket('p_1', 'Maria')])
  assert.equal(people.length, 1)
  assert.equal(people[0].tabs, 1)
})

test('a second tab is the same student, not a second one', () => {
  const people = peopleInRoom([socket('p_1', 'Maria'), socket('p_1', 'Maria')])
  assert.equal(people.length, 1, 'the room grew by opening a tab')
  assert.equal(people[0].tabs, 2)
})

test('two students who share a name are still two students', () => {
  // Names are not unique in a seminar. Ids are.
  const people = peopleInRoom([socket('p_1', 'Anna'), socket('p_2', 'Anna')])
  assert.equal(people.length, 2)
})

test('the tab that is doing something is the one reported', () => {
  const people = peopleInRoom([
    socket('p_1', 'Maria'),
    socket('p_1', 'Maria', { activeCellId: 'c_7' }),
  ])
  assert.equal(people.length, 1)
  assert.equal(people[0].user.activeCellId, 'c_7', 'the idle tab spoke for the busy one')
})

test('an active tab is not overwritten by an idle one that arrives later', () => {
  const people = peopleInRoom([
    socket('p_1', 'Maria', { activeCellId: 'c_7' }),
    socket('p_1', 'Maria'),
  ])
  assert.equal(people[0].user.activeCellId, 'c_7')
})

test('you are yourself even when your other tab arrived first', () => {
  const people = peopleInRoom([socket('p_1', 'Maria'), socket('p_1', 'Maria', {}, true)])
  assert.equal(people.length, 1)
  assert.equal(people[0].isSelf, true, 'the room stopped recognising you')
})

test('a socket that has not said who it is yet is not a person', () => {
  // A page mid-join has an awareness entry before it has an identity.
  const half = { clientId: 99, isSelf: false, user: undefined as unknown as RoomPeer['user'] }
  assert.deepEqual(peopleInRoom([half]), [])
  assert.equal(peopleInRoom([socket('', 'Nobody')]).length, 0)
})

test('an empty room is empty', () => {
  assert.deepEqual(peopleInRoom([]), [])
})

test('order follows arrival, so the list does not reshuffle as people type', () => {
  const people = peopleInRoom([socket('p_1', 'Anna'), socket('p_2', 'Boris'), socket('p_1', 'Anna')])
  assert.deepEqual(people.map((p) => p.user.name), ['Anna', 'Boris'])
})
