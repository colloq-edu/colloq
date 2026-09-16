/**
 * Бан — глазами интерфейса.
 *
 * Не пускает сервер, и проверять здесь нечего: у него таблица и рукопожатие.
 * Проверяется то, что видит человек, — а видит он в этой истории две вещи,
 * каждую ровно один раз, и обе необратимы по-своему.
 *
 * Первая — окно подтверждения. Преподаватель читает его секунду и жмёт;
 * умолчав в нём про стёртые вопросы, продукт стёр бы их молча, а пообещав
 * «больше не войдёт», соврал бы про инкогнито в тот единственный момент, когда
 * ему верят.
 *
 * Вторая — пометки в списке людей. Они никого не блокируют и ошибаются: метка
 * устройства не переживает инкогнито, а один адрес — это вся аудитория за одним
 * вайфаем. Поэтому проверяется не только когда подсказка появляется, но и когда
 * она молчит: догадка «возможно, вернулся» про человека, которого никто не
 * банил, — это обвинение из ничего.
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

/* ------------------------------------------------------------------ сроки */

test('срок называется часами, а не локалью браузера', () => {
  const now = new Date(2026, 8, 6, 18, 40).getTime()
  // Тот же день: бан сняли и поставили заново под вечер.
  assert.equal(untilWords(new Date(2026, 8, 6, 23, 5).getTime(), now), 'сегодня в 23:05')
  // Обычный случай: сутки с любого часа пары — это завтра.
  assert.equal(untilWords(new Date(2026, 8, 7, 18, 40).getTime(), now), 'завтра в 18:40')
})

test('дальше завтра — числом, потому что «послезавтра» уже не считают', () => {
  const now = new Date(2026, 8, 6, 18, 40).getTime()
  assert.equal(untilWords(new Date(2026, 8, 9, 9, 5).getTime(), now), '09.09 в 09:05')
})

test('полночь между сегодня и завтра — это завтра', () => {
  // Пара кончается в 23:50, бан живёт сутки: «сегодня в 00:30» указало бы на
  // час, который уже прошёл.
  const now = new Date(2026, 8, 6, 23, 50).getTime()
  assert.equal(untilWords(new Date(2026, 8, 7, 0, 30).getTime(), now), 'завтра в 00:30')
})

/* -------------------------------------------------------------- список */

test('кончившийся бан уходит из списка сам', () => {
  const now = 1_000_000
  const live = activeBans(
    [ban({ id: 'b_1', until: now - 1 }), ban({ id: 'b_2', until: now + 1 })],
    now,
  )
  assert.deepEqual(
    live.map((one) => one.id),
    ['b_2'],
    'строка «до 18:40» в семь вечера предлагает снять снятое',
  )
})

test('сверху — тот, кого удалили только что: его и снимают, если промахнулись', () => {
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

/* ---------------------------------------------------------------- право */

test('штат не банится, и кнопки ему не рисуют', () => {
  assert.equal(mayBan('host', 'participant'), true)
  assert.equal(mayBan('host', 'host'), false, 'преподаватель над коллегой не властен')
  assert.equal(mayBan('participant', 'participant'), false)
  assert.equal(mayBan('participant', 'host'), false)
})

/* -------------------------------------------------------- подтверждение */

test('пульт передаёт в бан настоящего автора, даже когда на экране имя скрыто', () => {
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

test('окно подтверждения называет всё, что случится, и ничего сверх', () => {
  const said = banConsequences('Иван').join(' ')
  assert.match(said, /Иван/, 'кого удаляют — имя, а не «этого участника»')
  assert.match(said, /24 часа/, 'на сколько')
  assert.match(said, /[Пп]опытки консилиума/, 'попытки и очередь тоже очищаются')
  assert.match(said, /будет прервана/, 'выполняющаяся попытка останавливается')
  assert.match(said, /других участников останутся/, 'чужая очередь сохраняется')
  assert.match(said, /[Вв]опрос/, 'вопросы к оракулу пропадут — сам об этом никто не догадается')
  // Обратное прежнему: окно обещало возврат вопросов восстановлением версии,
  // а возврат кладёт обратно одни ячейки (tests/panels-ban-promise.test.mts).
  assert.match(said, /без возможности восстановления/i, 'и что вернуть их нечем')
  assert.doesNotMatch(said, /вопросы вернутся/i, 'обещания возврата больше нет')
  // Единственное обещание, которое продукт сдержать не может.
  assert.match(said, /инкогнито/i, 'бан держится на браузере, и об этом сказано')
})

/* ------------------------------------------------------------- пометки */

test('без пометок от сервера список людей остаётся прежним', () => {
  assert.deepEqual(personNotes(undefined, { bansActive: true }), [])
  assert.deepEqual(personNotes({}, { bansActive: true }), [])
})

test('«впервые, только что» живёт пять минут и уходит само', () => {
  const now = 10_000_000
  const fresh = personNotes({ firstSeenAt: now - 60_000 }, { bansActive: false, now })
  assert.deepEqual(
    fresh.map((note) => note.text),
    ['недавно вошёл'],
  )
  const settled = personNotes({ firstSeenAt: now - FRESH_MS - 1 }, { bansActive: false, now })
  assert.deepEqual(settled, [], 'через полпары «только что» — уже неправда')
})

test('браузер без метки помечен и без всяких банов', () => {
  const notes = personNotes({ device: false }, { bansActive: false })
  assert.deepEqual(
    notes.map((note) => note.text),
    ['браузер без метки'],
  )
})

test('«возможно, вернулся» — только пока чей-то бан действует', () => {
  const mark = { device: false, sameIp: true }
  assert.deepEqual(
    personNotes(mark, { bansActive: true }).map((note) => note.text),
    ['совпадает IP-адрес'],
    'без метки он и так — говорить это второй раз незачем',
  )
  assert.deepEqual(
    personNotes(mark, { bansActive: false }).map((note) => note.text),
    ['браузер без метки'],
    'один адрес — это вся аудитория за одним вайфаем, и сам по себе он не значит ничего',
  )
})

test('у браузера с меткой совпавший адрес не значит ничего', () => {
  assert.deepEqual(personNotes({ device: true, sameIp: true }, { bansActive: true }), [])
})

test('догадка и новичок стоят рядом: вместе они и складываются в того, кого ищут', () => {
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

test('подсказка сама говорит, что может ошибаться', () => {
  const [hint] = personNotes({ device: false, sameIp: true }, { bansActive: true })
  assert.match(
    hint.why,
    /не подтверждает/i,
    'она никого не блокирует, и человек, который по ней банит, должен это знать',
  )
})
