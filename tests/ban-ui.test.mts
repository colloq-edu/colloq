/**
 * A ban through the eyes of the interface.
 *
 * The server does the refusing, and there is nothing to check here: it has
 * the table and the handshake. What is checked is what a person sees, and
 * in this story they see two things, each exactly once, and both
 * irreversible in their own way.
 *
 * The first is the confirmation dialog. The teacher reads it for a second
 * and presses; had it kept quiet about the erased questions, the product
 * would erase them silently, and had it promised "will not get in again", it
 * would lie about incognito at the one moment it is believed.
 *
 * The second is the marks in the people list. They block nobody and they
 * make mistakes: a device mark does not survive incognito, and one address
 * is the whole audience behind one Wi-Fi. So it is checked not only when
 * the hint appears but also when it stays quiet: a guess "possibly came
 * back" about a person nobody banned is an accusation out of nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Ban } from '../shared/protocol.js'
import {
  activeBans,
  banConsequences,
  banTargetOf,
  FRESH_MS,
  mayBan,
  personNotes,
  untilWords,
} from '../web/src/lib/bans.js'

const ban = (over: Partial<Ban> = {}): Ban => ({
  id: 'b_1',
  name: 'Иван',
  until: Date.now() + 86_400_000,
  createdAt: Date.now(),
  byTeacher: 'Мария',
  mine: false,
  ...over,
})

/* ------------------------------------------------------------------ terms */

test('the term is named by the clock, not by the browser locale', () => {
  const now = new Date(2026, 8, 6, 18, 40).getTime()
  // The same day: the ban was lifted and set again towards the evening.
  assert.equal(untilWords(new Date(2026, 8, 6, 23, 5).getTime(), now), 'сегодня в 23:05')
  // The usual case: a day from any hour of the class is tomorrow.
  assert.equal(untilWords(new Date(2026, 8, 7, 18, 40).getTime(), now), 'завтра в 18:40')
})

test('beyond tomorrow it is a date, because nobody counts "the day after tomorrow"', () => {
  const now = new Date(2026, 8, 6, 18, 40).getTime()
  assert.equal(untilWords(new Date(2026, 8, 9, 9, 5).getTime(), now), '09.09 в 09:05')
})

test('midnight between today and tomorrow is tomorrow', () => {
  // The class ends at 23:50 and the ban lives a day: "today at 00:30" would
  // point to an hour that has already passed.
  const now = new Date(2026, 8, 6, 23, 50).getTime()
  assert.equal(untilWords(new Date(2026, 8, 7, 0, 30).getTime(), now), 'завтра в 00:30')
})

/* ---------------------------------------------------------------- list */

test('an expired ban leaves the list by itself', () => {
  const now = 1_000_000
  const live = activeBans(
    [ban({ id: 'b_1', until: now - 1 }), ban({ id: 'b_2', until: now + 1 })],
    now,
  )
  assert.deepEqual(
    live.map((one) => one.id),
    ['b_2'],
    'a "until 18:40" row at seven in the evening offers to lift what is already lifted',
  )
})

test('on top is the one removed just now: that is who gets lifted after a slip', () => {
  const now = 1_000_000
  const live = activeBans(
    [
      ban({ id: 'b_old', createdAt: now - 5000, until: now + 10_000 }),
      ban({ id: 'b_new', createdAt: now - 10, until: now + 10_000 }),
    ],
    now,
  )
  assert.deepEqual(
    live.map((one) => one.id),
    ['b_new', 'b_old'],
  )
})

/* ---------------------------------------------------------------- right */

test('staff cannot be banned, and no button is drawn for them', () => {
  assert.equal(mayBan('host', 'participant'), true)
  assert.equal(mayBan('host', 'host'), false, 'a teacher has no power over a colleague')
  assert.equal(mayBan('participant', 'participant'), false)
  assert.equal(mayBan('participant', 'host'), false)
})

/* --------------------------------------------------------- confirmation */

test('the console passes the real author into the ban, even when the name is hidden on screen', () => {
  const target = banTargetOf(
    {
      participantId: 'participant-real-id',
      name: 'Настоящее имя',
      color: '#123456',
      avatar: 'avatar.png',
    },
    { clientX: 120, clientY: 240 },
  )

  assert.deepEqual(target, {
    id: 'participant-real-id',
    name: 'Настоящее имя',
    color: '#123456',
    avatar: 'avatar.png',
    x: 120,
    y: 240,
  })
})

test('the confirmation dialog names everything that will happen, and nothing more', () => {
  const said = banConsequences('Иван').join(' ')
  assert.match(said, /Иван/, 'who is removed: the name, not "this participant"')
  assert.match(said, /24 часа/, 'for how long')
  assert.match(said, /[Пп]опытки консилиума/, 'attempts and the queue are cleared too')
  assert.match(said, /будет прервана/, 'a running attempt is stopped')
  assert.match(said, /других участников останутся/, 'the queue of others is kept')
  assert.match(said, /[Вв]опрос/, 'questions to the oracle will vanish; nobody would guess that on their own')
  // The reverse of before: the dialog promised the questions would come back
  // with a version restore, while a restore puts back only the cells
  // (tests/panels-ban-promise.test.mts).
  assert.match(said, /без возможности восстановления/i, 'and that there is no way to bring them back')
  assert.doesNotMatch(said, /вопросы вернутся/i, 'the promise of a return is gone')
  // The only promise the product cannot keep.
  assert.match(said, /инкогнито/i, 'the ban relies on the browser, and that is said')
})

/* --------------------------------------------------------------- marks */

test('without marks from the server the people list stays as it was', () => {
  assert.deepEqual(personNotes(undefined, { bansActive: true }), [])
  assert.deepEqual(personNotes({}, { bansActive: true }), [])
})

test('"first time, just now" lives five minutes and goes away by itself', () => {
  const now = 10_000_000
  const fresh = personNotes({ firstSeenAt: now - 60_000 }, { bansActive: false, now })
  assert.deepEqual(
    fresh.map((note) => note.text),
    ['недавно вошёл'],
  )
  const settled = personNotes({ firstSeenAt: now - FRESH_MS - 1 }, { bansActive: false, now })
  assert.deepEqual(settled, [], 'half a class later "just now" is no longer true')
})

test('a browser without a mark is marked even with no bans at all', () => {
  const notes = personNotes({ device: false }, { bansActive: false })
  assert.deepEqual(
    notes.map((note) => note.text),
    ['браузер без метки'],
  )
})

test('"possibly came back" appears only while some ban is in effect', () => {
  const mark = { device: false, sameIp: true }
  assert.deepEqual(
    personNotes(mark, { bansActive: true }).map((note) => note.text),
    ['совпадает IP-адрес'],
    'he is unmarked anyway; there is no need to say it a second time',
  )
  assert.deepEqual(
    personNotes(mark, { bansActive: false }).map((note) => note.text),
    ['браузер без метки'],
    'one address is the whole audience behind one Wi-Fi, and by itself it means nothing',
  )
})

test('for a marked browser a matching address means nothing', () => {
  assert.deepEqual(personNotes({ device: true, sameIp: true }, { bansActive: true }), [])
})

test('the guess and the newcomer stand side by side: together they add up to the one being looked for', () => {
  const now = 10_000_000
  const notes = personNotes(
    { device: false, sameIp: true, firstSeenAt: now - 1000 },
    { bansActive: true, now },
  )
  assert.deepEqual(
    notes.map((note) => note.text),
    ['совпадает IP-адрес', 'недавно вошёл'],
  )
})

test('the hint itself says it may be wrong', () => {
  const [hint] = personNotes({ device: false, sameIp: true }, { bansActive: true })
  assert.match(
    hint.why,
    /не подтверждает/i,
    'it blocks nobody, and a person who bans by it must know that',
  )
})
