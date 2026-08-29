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

/* --------------------------------------------------- где человек, и куда вести */

/**
 * Строка в списке людей давно говорила, где человек, но никуда не вела:
 * увидеть было можно, дойти нельзя. Теперь ведёт — и вся ценность держится на
 * одном: фраза и место должны сходиться. «Правит ячейку 04», приводящее в
 * терминал, хуже, чем строка, которая никуда не ведёт.
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

test('человек в ячейке — фраза и место про одну и ту же ячейку', () => {
  const seen = whereabouts(who({ activeCellId: 'c2' }), room())
  assert.equal(seen.line, 'editing cell 02')
  assert.deepEqual(seen.place, { where: 'cell', cellId: 'c2' })
})

test('запуск перебивает место курсора — и фраза, и переход', () => {
  // Пока ячейка считается, человек занят именно ею, где бы ни стоял курсор.
  const seen = whereabouts(who({ activeCellId: 'c1' }), room({ runningCellId: 'c3', runBy: 'Мария' }))
  assert.equal(seen.line, 'running cell 03')
  assert.deepEqual(seen.place, { where: 'cell', cellId: 'c3' })
})

test('терминал и оракул ведут в свои панели', () => {
  assert.deepEqual(whereabouts(who({ inTerminal: true }), room()).place, { where: 'terminal' })
  assert.deepEqual(whereabouts(who({ composing: true }), room()).place, { where: 'oracle' })
})

test('терминал перебивает ячейку, а оракул уступает терминалу', () => {
  const both = who({ activeCellId: 'c1', inTerminal: true, composing: true })
  const seen = whereabouts(both, room())
  assert.equal(seen.line, 'in the terminal')
  assert.deepEqual(seen.place, { where: 'terminal' })
})

test('удалённая ячейка не место: ни фразы, ни перехода', () => {
  /*
   * Курсор мог остаться на ячейке, которую с тех пор стёрли. Вести к тому,
   * чего нет, хуже, чем не вести никуда, — и говорить про это тоже нечего.
   */
  const seen = whereabouts(who({ activeCellId: 'ушла' }), room())
  assert.equal(seen.line, null)
  assert.equal(seen.place, null)
})

test('про вкладки сказать можно, а вести некуда', () => {
  const seen = whereabouts(who({}, 3), room())
  assert.equal(seen.line, '3 tabs open')
  assert.equal(seen.place, null, 'вкладки — не место в комнате')
})

test('про молчащего человека нечего сказать и некуда вести', () => {
  const seen = whereabouts(who(), room())
  assert.equal(seen.line, null)
  assert.equal(seen.place, null)
})

test('фраза и место не расходятся ни в одном сочетании', () => {
  /*
   * Ровно то, ради чего они считаются одной функцией. Перебираем все
   * осмысленные состояния и проверяем: если фраза называет ячейку — переход
   * ведёт в ячейку с тем же номером; если говорит про терминал или оракула —
   * переход туда же; если фраза молчит или про вкладки — перехода нет.
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
              assert.equal(place, null, 'молчит, но куда-то ведёт')
              continue
            }
            if (line === 'in the terminal') assert.deepEqual(place, { where: 'terminal' })
            else if (line === 'asking the oracle') assert.deepEqual(place, { where: 'oracle' })
            else if (line.endsWith('tabs open')) assert.equal(place, null)
            else {
              const no = line.slice(-2)
              assert.ok(place && place.where === 'cell', `«${line}» ведёт не в ячейку`)
              const number = view.numbers.get((place as { cellId: string }).cellId)
              assert.equal(String(number).padStart(2, '0'), no, `«${line}» ведёт в другую ячейку`)
            }
          }
})
