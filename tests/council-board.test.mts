/**
 * Консилиум на клиенте — арифметика, общая для окна пульта и плашки показа.
 *
 * Всё, что здесь проверяется, ломается молча: группа, склеенная не по тому
 * ключу, выглядит как ещё одно решение; представитель не тот — преподаватель
 * отвечает «всем 311» тому, кто сдал последним; чип упавшей попытки без имени
 * исключения не говорит, что показывать классу. Ни одна из этих ошибок не
 * падает и не краснеет.
 *
 * Порядка стопки, сегментов полосы, соседей по стрелкам и «редких групп»
 * здесь больше нет: консоль под ячейкой с карточкой и «‹ ›» уехала в окно
 * пульта и стала лентой, и её арифметику проверяет council-pult.test.mts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CouncilAttempt, CouncilOracle } from '../shared/protocol.js'
import { attemptStatus, groupStatus } from '../shared/protocol.js'
import {
  groupAttempts,
  groupTitle,
  normalizeAttempt,
  oracleState,
  staleBy,
  statusLabel,
} from '../web/src/lib/council-board.js'

/** Попытка с ключом, посчитанным той же функцией, что и на сервере. */
function attempt(id: string, text: string, over: Partial<CouncilAttempt> = {}): CouncilAttempt {
  return {
    participantId: id,
    name: id,
    color: '#000',
    avatar: null,
    text,
    submittedAt: 1000,
    updatedAt: 1000,
    status: 'unrun',
    run: null,
    reply: null,
    correct: null,
    shown: false,
    groupKey: normalizeAttempt(text),
    ...over,
  }
}

test('группа не различает пробелы, пустые строки и комментарии', () => {
  const a = attempt('a', 'x = 1\nprint(x)', { submittedAt: 10 })
  const b = attempt('b', 'x=1   # единица\n\n\nprint( x )\r\n', { submittedAt: 20 })
  // Решётка в строке — не комментарий: ключ другой, группа другая.
  const c = attempt('c', 'x = 1\nprint("#x")', { submittedAt: 30 })
  const groups = groupAttempts([a, b, c])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].members, ['a', 'b'])
  assert.deepEqual(groups[1].members, ['c'])
  // Регистр — часть решения: Print и print не одно и то же.
  assert.notEqual(normalizeAttempt('Print(x)'), normalizeAttempt('print(x)'))
})

test('представитель — самый ранний сдавший, статус и «на экране» группы — по всем членам', () => {
  const late = attempt('late', 'y = 2', { submittedAt: 300, status: 'correct' })
  const early = attempt('early', 'y=2', { submittedAt: 100, status: 'failed' })
  const mid = attempt('mid', 'y =2', { submittedAt: 200, shown: true })
  const [group] = groupAttempts([late, early, mid])
  assert.equal(group.representative, 'early')
  // Отметка преподавателя на карточке НЕ представителя — всё равно отметка группы.
  assert.equal(group.status, 'correct')
  assert.equal(group.shown, true, 'показали члена группы — текст группы на экране')
  assert.equal(group.sample, 'y=2')
  assert.equal(group.count, 3)
  assert.deepEqual(group.members, ['early', 'mid', 'late'])

  // Без отметки — громче падение: у одного текста в общем ядре исход зависит от состояния.
  assert.equal(groupStatus(['unrun', 'ran', 'failed']), 'failed')
  assert.equal(groupStatus(['unrun', 'ran']), 'ran')
  assert.equal(groupStatus(['unrun', 'wrong', 'failed']), 'wrong')
  assert.equal(groupStatus([]), 'unrun')
  const [plain] = groupAttempts([
    attempt('a', 'z', { status: 'unrun' }),
    attempt('b', 'z', { status: 'failed' }),
  ])
  assert.equal(plain.status, 'failed')
  assert.equal(plain.shown, false)
})

test('пишущие в группы не попадают, имя группы — от оракула или первая строка', () => {
  const writing = attempt('w', 'z = 3', { submittedAt: null })
  const done = attempt('d', '\n\n  z = 3  # done', { submittedAt: 5 })
  const groups = groupAttempts([writing, done], { [done.groupKey]: 'через z' })
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].members, ['d'])
  assert.equal(groups[0].label, 'через z')
  assert.equal(groupTitle(groups[0]), 'через z')
  assert.equal(groupTitle({ label: null, sample: done.text }), 'z = 3  # done')
  assert.equal(groupAttempts([writing]).length, 0)
})

test('группы идут от большой к малой, при равенстве — чья раньше сдана', () => {
  const attempts = [
    attempt('p1', 'a', { submittedAt: 50 }),
    attempt('q1', 'b', { submittedAt: 10 }),
    attempt('q2', 'b', { submittedAt: 60 }),
    attempt('r1', 'c', { submittedAt: 20 }),
  ]
  const groups = groupAttempts(attempts)
  assert.deepEqual(
    groups.map((g) => g.key),
    ['b', 'c', 'a'],
  )
})

test('сданный пустой лист — это группа со своим ключом и своим именем', () => {
  // Один комментарий нормализуется в пустую строку — и это сдают.
  const empty = attempt('e', '# не знаю', { submittedAt: 10 })
  assert.equal(empty.groupKey, '')
  const groups = groupAttempts([empty])
  assert.equal(groups.length, 1)
  // Имя группы шапка в пульте и печатает: «Группа 2 · 87 одинаковых» не
  // говорит, ЧТО написали эти восемьдесят семь.
  assert.equal(groupTitle(groups[0]), '# не знаю')
})

test('чип упавшей попытки называет исключение', () => {
  const run = {
    state: 'error' as const,
    outputs: [
      { kind: 'stream' as const, name: 'stdout' as const, text: 'hi' },
      { kind: 'error' as const, ename: 'TypeError', evalue: 'bad', traceback: [] },
    ],
    execCount: 1,
    ranMs: 400,
    startedAt: 0,
    by: 'host' as const,
  }
  assert.equal(statusLabel({ status: 'failed', run }), 'TypeError')
  assert.equal(statusLabel({ status: 'failed', run: null }), 'ошибка запуска')
  // Отметка преподавателя сильнее запуска.
  assert.equal(statusLabel({ status: 'correct', run }), 'верно')
  assert.equal(statusLabel({ status: 'unrun', run: null }), 'не запускали')
})

test('«неверно» — отметка сильнее запуска, и в чипе она тем же словом', () => {
  /*
   * Статус `wrong` знает весь продукт (чип, отметка сильнее запуска у оракула),
   * а поставить его было нечем: прежняя консоль слала только `true` и `null`.
   * Кнопку ✗ носит полоса действий пульта (council-pult-craft), здесь — цепочка
   * «что кнопка шлёт → какой это статус → каким словом он выйдет».
   */
  const run = {
    state: 'ok' as const,
    outputs: [],
    execCount: 1,
    ranMs: 12,
    startedAt: 0,
    by: 'host' as const,
  }
  assert.equal(attemptStatus({ run: null, correct: false }), 'wrong')
  assert.equal(statusLabel({ status: 'wrong', run: null }), 'неверно')
  assert.equal(attemptStatus({ run, correct: false }), 'wrong', 'отметка слабее запуска')
  assert.equal(attemptStatus({ run, correct: null }), 'ran')
})

test('оракул устаревает по числу сдавших — сервер об этом не говорит вовсе', () => {
  const oracle: CouncilOracle = {
    state: 'ready',
    askedAt: 1,
    basedOn: 100,
    summary: ['a', 'b', 'c'],
    groupLabels: {},
    drafts: {},
    error: null,
  }
  assert.equal(oracleState(null, 5), 'idle')
  assert.equal(oracleState({ ...oracle, state: 'idle' }, 500), 'idle')
  assert.equal(oracleState({ ...oracle, state: 'reading' }, 500), 'reading')
  assert.equal(oracleState(oracle, 100), 'ready')
  assert.equal(oracleState(oracle, 112), 'stale')
  assert.equal(staleBy(oracle, 112), 12)
  // Сдавших стало меньше (бан) — не «минус три», а ноль.
  assert.equal(staleBy(oracle, 97), 0)
})
