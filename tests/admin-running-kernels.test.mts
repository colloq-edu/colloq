/**
 * «Работают сейчас» (web/src/admin/running-kernels.ts): the words and numbers
 * the owner decides a stop by.
 *
 * The cases are the ones a full machine would expose too late: an idle row
 * whose two lines must add up to the room setting, a countdown that has run
 * out (the sweep's next pass, not "never"), a header that must not call a
 * run's reservation "really in use", another course's room that must not
 * name its people, and a batch stop where somebody walked into a room in the
 * meantime.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.js'
import type { RunningClass, RunningContainer, RunningKernels } from '../shared/admin.js'
import {
  bulkOutcome,
  busyOf,
  clock,
  coresLane,
  countdown,
  duration,
  emptyLine,
  freedMb,
  idleClasses,
  memoryLane,
  shortName,
  statusLines,
  stopBody,
  totals,
} from '../web/src/admin/running-kernels.js'

afterEach(() => setLocaleResolver(() => 'ru'))

/** The copy keeps non-breaking spaces between numbers and units; compare the words. */
const plain = (text: string | null): string | null => (text === null ? null : text.replace(/ /g, ' '))

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
const MIN = 60_000
const iso = (ms: number): string => new Date(ms).toISOString()

function container(fields: Partial<RunningContainer> = {}): RunningContainer {
  return { role: 'room', state: 'running', reservedMb: 4096, usedMb: 100, cpus: 2, cpuPercent: 0, startedAt: null, ...fields }
}

function row(fields: Partial<RunningClass> = {}): RunningClass {
  return {
    id: 'eda',
    hidden: false,
    name: 'EDA',
    course: null,
    environment: 'base',
    gpu: null,
    online: 0,
    liveSince: null,
    busy: null,
    idleSince: iso(NOW - 70 * MIN),
    stopsAt: iso(NOW + 50 * MIN),
    room: container(),
    own: null,
    books: [],
    canStop: true,
    idle: true,
    ...fields,
  }
}

function kernels(fields: Partial<RunningKernels> = {}): RunningKernels {
  return {
    backend: 'docker',
    complete: true,
    sampledAt: iso(NOW),
    usage: 'live',
    reservedMb: 0,
    usedMb: 0,
    classes: [],
    runs: [],
    preparations: [],
    ...fields,
  }
}

test('a stretch of time reads as the room does, and a countdown rounds up', () => {
  assert.equal(plain(duration(20_000)), 'меньше минуты')
  assert.equal(plain(duration(40 * MIN)), '40 мин')
  assert.equal(plain(duration(70 * MIN)), '1 ч 10 мин')
  assert.equal(plain(duration(120 * MIN)), '2 ч')
  // 49 min 12 s left of a two-hour limit is "50", so the two lines of an idle
  // row add up to the setting instead of losing a minute between them.
  assert.equal(plain(duration(49.2 * MIN, true)), '50 мин')
  assert.equal(plain(duration(49.2 * MIN)), '49 мин')
  setLocaleResolver(() => 'en')
  assert.equal(plain(duration(70 * MIN)), '1 h 10 min')
})

test('the run lane and the busy dialog tick in seconds', () => {
  assert.equal(clock(134_000), '2:14')
  assert.equal(clock(600_000), '10:00')
  assert.equal(clock(3_729_000), '1:02:09')
  assert.equal(clock(-5), '0:00')
})

test('an idle row says how long it has been empty and when it lets go', () => {
  const lines = statusLines(row(), NOW)
  assert.equal(lines.tone, 'warning')
  assert.equal(plain(lines.first), 'пусто 1 ч 10 мин')
  assert.equal(plain(lines.second), 'сам остановится через 50 мин')
  // stopsAt null on an IDLE row is the setting's "never" (roomIdleMin = 0).
  assert.equal(countdown(row({ stopsAt: null }), NOW), 'не остановится сам')
  // A countdown already run out is the sweep's next pass, not "never".
  assert.equal(countdown(row({ stopsAt: iso(NOW - 2 * MIN) }), NOW), 'остановится с минуты на минуту')
  // Before the sweep's first look there is no idle mark yet: no made-up time.
  assert.equal(statusLines(row({ idleSince: null }), NOW).first, 'пусто')
})

test('a busy row names what computes and who, and the people inside', () => {
  const busy = row({
    idle: false,
    online: 18,
    idleSince: null,
    stopsAt: null,
    busy: { kind: 'cell', who: 'Мария С.', book: 'Семинар.ipynb', since: iso(NOW - 3 * MIN) },
  })
  const lines = statusLines(busy, NOW)
  assert.equal(lines.tone, 'accent')
  assert.equal(lines.first, 'считает · Мария С., Семинар.ipynb')
  assert.equal(plain(lines.second), 'идёт 3 мин · в комнате 18 человек')
  const terminal = statusLines(row({ idle: false, busy: { kind: 'terminal', who: null, book: null, since: null } }), NOW)
  assert.equal(terminal.first, 'терминал занят')
  assert.equal(terminal.second, null)
  const occupied = statusLines(row({ idle: false, online: 2, idleSince: null, stopsAt: null, liveSince: iso(NOW - 25 * MIN) }), NOW)
  assert.equal(plain(occupied.first), 'в комнате 2 человека')
  assert.equal(plain(occupied.second), 'занятие идёт 25 мин')
})

test('another course\'s room keeps its numbers but not its story', () => {
  const hidden = row({
    id: null,
    hidden: true,
    name: null,
    idle: false,
    online: 3,
    busy: { kind: 'cell', who: null, book: null, since: iso(NOW - MIN) },
    canStop: false,
  })
  const lines = statusLines(hidden, NOW)
  assert.deepEqual(lines, { first: 'считает', tone: 'muted', second: null })
  assert.equal(statusLines({ ...hidden, busy: null }, NOW).first, 'идёт')
  // Never in the batch: it cannot be stopped by this viewer, and has no id.
  assert.deepEqual(idleClasses(kernels({ classes: [{ ...hidden, busy: null, online: 0, idle: true }] })), [])
})

test('the header counts every container but calls only measured use real', () => {
  const data = kernels({
    reservedMb: 3 * 4096,
    usedMb: 2970,
    classes: [row({ id: 'a' }), row({ id: 'b', own: container({ role: 'own', reservedMb: 4096 }) }), row({ id: 'c' })],
    runs: [
      {
        submissionId: 's1',
        competitionId: 'k1',
        competition: 'Дефекты деталей',
        hidden: false,
        kind: 'run',
        startedAt: iso(NOW - 134_000),
        limitSec: 600,
        reservedMb: 2048,
        canStop: true,
      },
    ],
  })
  const sum = totals(data)
  assert.equal(sum.containers, 5, 'three rooms, one personal container, one run')
  assert.equal(sum.reservedMb, 3 * 4096 + 2048, 'the run reserves memory too')
  assert.equal(sum.usedMb, 2970, 'but its reservation is not use')
  assert.equal(totals({ ...data, usage: 'unknown' }).usedMb, null)
})

test('the batch takes idle stoppable classes and frees both of their containers', () => {
  const both = row({ id: 'b', own: container({ role: 'own', reservedMb: 2048 }) })
  const data = kernels({ classes: [row({ id: 'a' }), both, row({ id: 'c', idle: false, online: 4 })] })
  assert.deepEqual(idleClasses(data).map((r) => r.id), ['a', 'b'])
  assert.equal(freedMb(both, 'class'), 4096 + 2048)
  assert.equal(freedMb(both, 'own'), 2048)
  // A teacher's list: the same idle rooms, none of them theirs to stop.
  assert.deepEqual(idleClasses(kernels({ classes: [row({ canStop: false })] })), [])
})

test('memory reads real use against the reservation, and amber near the limit', () => {
  const lane = memoryLane(container())
  assert.equal(plain(lane.text), '0,1 из 4 ГБ')
  assert.ok(lane.share !== null && lane.share > 0.02 && lane.share < 0.03)
  assert.equal(lane.tight, false)
  assert.equal(memoryLane(container({ usedMb: 3600 })).tight, true)
  const unknown = memoryLane(container({ usedMb: null }))
  assert.deepEqual({ ...unknown, text: plain(unknown.text) }, { text: '4 ГБ', share: null, tight: false, reserveOnly: true })
  assert.equal(memoryLane(null).text, null)
  assert.equal(plain(coresLane(container({ cpuPercent: 140 }))), '2 ядра · 140 %')
  assert.equal(plain(coresLane(container({ cpus: 5, cpuPercent: null }))), '5 ядер')
  setLocaleResolver(() => 'en')
  assert.equal(plain(coresLane(container({ cpuPercent: 140 }))), '2 cores · 140%')
})

test('the stop confirmation is built from the room\'s real numbers', () => {
  const books = [
    { root: 'r1', path: 'EDA.ipynb', role: 'room' as const, phase: 'idle' as const, owner: null, lastWorkAt: null },
    { root: 'r2', path: 'домашка/titanic.ipynb', role: 'room' as const, phase: 'idle' as const, owner: null, lastWorkAt: null },
  ]
  const body = plain(stopBody(row({ books }), 'class', NOW))
  assert.match(body ?? '', /^В комнате никого нет уже 1 ч 10 мин\./)
  assert.match(body ?? '', /Переменные 2 тетрадей пропадут, файлы останутся\./)
  assert.match(body ?? '', /Общий терминал закроется\./)
  assert.match(body ?? '', /Освободится 4 ГБ\./)
  const crowded = plain(stopBody(row({ online: 24, idle: false, books: books.slice(0, 1) }), 'class', NOW))
  assert.match(crowded ?? '', /^Сейчас в комнате 24 человека\./)
  assert.match(crowded ?? '', /Переменные 1 тетради пропадут/)
  // Only the personal container: no terminal, and only its own memory.
  const own = plain(stopBody(row({ own: container({ role: 'own', reservedMb: 2048 }) }), 'own', NOW))
  assert.doesNotMatch(own ?? '', /терминал/)
  assert.match(own ?? '', /Освободится 2 ГБ\./)
})

test('a busy refusal is read defensively', () => {
  assert.deepEqual(busyOf({ error: 'x', reason: 'busy', busy: { kind: 'cell', who: 'Мария С.', book: 'a.ipynb', since: null } }), {
    kind: 'cell',
    who: 'Мария С.',
    book: 'a.ipynb',
    since: null,
  })
  assert.equal(busyOf({ reason: 'stopping' }), null)
  assert.equal(busyOf({ reason: 'busy', busy: { kind: 'dancing' } }), null)
  assert.equal(busyOf(null), null)
})

test('a long name is cut at a word inside «…»', () => {
  assert.equal(shortName('EDA'), 'EDA')
  assert.equal(shortName('Оптимизация функций через градиенты'), 'Оптимизация функций через…')
  assert.equal(shortName(null), 'без названия')
})

test('a batch stop that skipped a room says which one and why', () => {
  const names = new Map<string, string | null>([
    ['eda', 'EDA'],
    ['torch', 'Торч: тензоры, автодифф, свой цикл обучения'],
  ])
  const partial = bulkOutcome(
    { stopped: [{ id: 'eda', freedMb: 4096 }], skipped: [{ id: 'torch', reason: 'busy' }], freedMb: 4096 },
    names,
  )
  assert.equal(partial.tone, 'warning')
  assert.equal(
    plain(partial.text),
    'Остановлено 1 из 2 · освобождено 4 ГБ. В «Торч: тензоры, автодифф…» только что запустили ячейку — его не тронули.',
  )
  const whole = bulkOutcome(
    { stopped: [{ id: 'eda', freedMb: 4096 }, { id: 'torch', freedMb: 4096 }], skipped: [], freedMb: 8192 },
    names,
  )
  assert.deepEqual({ ...whole, text: plain(whole.text) }, { tone: 'positive', text: 'Остановлено 2 занятия · освобождено 8 ГБ' })
  setLocaleResolver(() => 'en')
  assert.equal(
    plain(bulkOutcome({ stopped: [], skipped: [{ id: 'eda', reason: 'online' }], freedMb: 0 }, names).text),
    'No class was stopped. Someone came into “EDA”, so it was left alone.',
  )
})

test('an empty list says "nothing runs" only when the runtime answered in full', () => {
  assert.deepEqual(emptyLine({ complete: true }), { tone: 'muted', text: 'Сейчас ни одно ядро не запущено.' })
  // `docker ps` timed out: containers this process does not track may be holding the memory.
  const partial = emptyLine({ complete: false })
  assert.equal(partial.tone, 'warning')
  assert.doesNotMatch(partial.text, /ни одно ядро/)
  assert.match(partial.text, /не полностью/)
})
