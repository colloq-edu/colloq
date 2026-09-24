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
import { peopleInRoom, whereabouts, type RoomPeer, type RoomView } from '../web/src/lib/room.js'
import type { AwarenessUser } from '../shared/protocol.js'

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

/* ---------------------------------------- where a person is, and where to lead */

/**
 * The row in the people list has long said where a person is, but led nowhere:
 * you could see it, but not get there. Now it leads — and all its value rests
 * on one thing: the phrase and the place must agree. "Editing cell 04" that
 * leads to the terminal is worse than a row that leads nowhere.
 */

const room = (over: Partial<RoomView> = {}): RoomView => ({
  numbers: new Map([
    ['c1', 1],
    ['c2', 2],
    ['c3', 3],
  ]),
  runningCellId: null,
  runBy: null,
  ...over,
})

const who = (over: Partial<AwarenessUser> = {}, tabs = 1) => ({
  user: {
    id: 'p1',
    name: 'Мария',
    avatar: null,
    color: '#c273e6',
    role: 'participant' as const,
    ...over,
  },
  isSelf: false,
  tabs,
})

test('a person in a cell: the phrase and the place are about the same cell', () => {
  const seen = whereabouts(who({ activeCellId: 'c2' }), room())
  assert.equal(seen.line, 'правит ячейку 02')
  assert.deepEqual(seen.place, { where: 'cell', cellId: 'c2' })
})

test('a run overrides the cursor position, in both the phrase and the jump', () => {
  // While a cell is computing, the person is busy with exactly that cell, wherever the cursor is.
  const seen = whereabouts(who({ activeCellId: 'c1' }), room({ runningCellId: 'c3', runBy: 'Мария' }))
  assert.equal(seen.line, 'запускает ячейку 03')
  assert.deepEqual(seen.place, { where: 'cell', cellId: 'c3' })
})

test('the terminal and the oracle lead to their own panels', () => {
  assert.deepEqual(whereabouts(who({ inTerminal: true }), room()).place, { where: 'terminal' })
  assert.deepEqual(whereabouts(who({ composing: true }), room()).place, { where: 'oracle' })
})

test('the terminal overrides the cell, and the oracle gives way to the terminal', () => {
  const both = who({ activeCellId: 'c1', inTerminal: true, composing: true })
  const seen = whereabouts(both, room())
  assert.equal(seen.line, 'в терминале')
  assert.deepEqual(seen.place, { where: 'terminal' })
})

test('a deleted cell is not a place: no phrase, no jump', () => {
  /*
   * The cursor may have stayed on a cell that has been erased since. Leading to
   * what is not there is worse than leading nowhere — and there is nothing to say about it either.
   */
  const seen = whereabouts(who({ activeCellId: 'ушла' }), room())
  assert.equal(seen.line, null)
  assert.equal(seen.place, null)
})

test('tabs can be mentioned, but there is nowhere to lead', () => {
  const seen = whereabouts(who({}, 3), room())
  // The numeral follows the plural rule, not a ternary: "3 вкладки" but "5 вкладок".
  assert.equal(seen.line, '3 вкладки')
  assert.equal(whereabouts(who({}, 5), room()).line, '5 вкладок')
  assert.equal(whereabouts(who({}, 21), room()).line, '21 вкладка')
  assert.equal(seen.place, null, 'tabs are not a place in the room')
})

test('about a silent person there is nothing to say and nowhere to lead', () => {
  const seen = whereabouts(who(), room())
  assert.equal(seen.line, null)
  assert.equal(seen.place, null)
})

test('the phrase and the place agree in every combination', () => {
  /*
   * Exactly why they are computed by one function. We go through every
   * meaningful state and check: if the phrase names a cell, the jump leads to
   * the cell with the same number; if it speaks of the terminal or the oracle,
   * the jump leads there too; if the phrase is silent or about tabs, there is no jump.
   */
  const flags = [true, false]
  for (const inTerminal of flags)
    for (const composing of flags)
      for (const activeCellId of ['c1', 'c2', null])
        for (const runningCellId of ['c3', null])
          for (const tabs of [1, 2]) {
            const person = who({ inTerminal, composing, activeCellId }, tabs)
            const view = room({ runningCellId, runBy: runningCellId ? 'Мария' : null })
            const { line, place } = whereabouts(person, view)

            if (line === null) {
              assert.equal(place, null, 'silent, yet leads somewhere')
              continue
            }
            if (line === 'в терминале') assert.deepEqual(place, { where: 'terminal' })
            else if (line === 'спрашивает оракула') assert.deepEqual(place, { where: 'oracle' })
            else if (/вкладк/.test(line)) assert.equal(place, null)
            else {
              const no = line.slice(-2)
              assert.ok(place && place.where === 'cell', `"${line}" does not lead to a cell`)
              const number = view.numbers.get((place as { cellId: string }).cellId)
              assert.equal(String(number).padStart(2, '0'), no, `"${line}" leads to a different cell`)
            }
          }
})
