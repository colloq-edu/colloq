/**
 * Стопка консилиума — арифметика пульта.
 *
 * Пульт рисует одну карточку из сотен попыток, и всё, что здесь проверяется,
 * ломается молча: группа, склеенная не по тому ключу, выглядит как ещё одно
 * решение; представитель не тот — преподаватель отвечает «всем 311» тому, кто
 * сдал последним; сегмент полосы без хвоста — «все сдали», когда сорок человек
 * ещё печатают. Ни одна из этих ошибок не падает и не краснеет.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CouncilAttempt, CouncilOracle } from '../shared/protocol.js'
import { groupStatus } from '../shared/protocol.js'
import {
  groupAttempts,
  groupTitle,
  neighbours,
  normalizeAttempt,
  oracleState,
  placeOf,
  splitRare,
  stackKeyAction,
  stackOrder,
  staleBy,
  statusLabel,
  stripSegments,
  toneOf,
  WRITING_KEY,
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

test('порядок стопки: представители, потом остальные по сдаче, пишущие в конце', () => {
  const attempts = [
    attempt('big1', 'a', { submittedAt: 30 }),
    attempt('big2', 'a', { submittedAt: 10 }),
    attempt('big3', 'a', { submittedAt: 20 }),
    attempt('small', 'b', { submittedAt: 5 }),
    attempt('typing-old', 'c', { submittedAt: null, updatedAt: 100 }),
    attempt('typing-new', 'd', { submittedAt: null, updatedAt: 200 }),
  ]
  const groups = groupAttempts(attempts)
  const order = stackOrder(groups, attempts).map((a) => a.participantId)
  assert.deepEqual(order, ['big2', 'small', 'big3', 'big1', 'typing-new', 'typing-old'])
})

test('пишущие в стопке не переставляются от набора: кадр за кадром — тот же порядок', () => {
  const writers = ['w-b', 'w-a', 'w-c'].map((id, i) =>
    attempt(id, `x = ${i}`, { submittedAt: null, updatedAt: 100 + i }),
  )
  const before = stackOrder([], writers).map((a) => a.participantId)
  // Следующий кадр: печатал w-a, потом w-c — самые свежие правки у них.
  const later = writers.map((a) =>
    a.participantId === 'w-a'
      ? { ...a, updatedAt: 900 }
      : a.participantId === 'w-c'
        ? { ...a, updatedAt: 950 }
        : a,
  )
  const after = stackOrder([], later).map((a) => a.participantId)
  assert.deepEqual(before, ['w-a', 'w-b', 'w-c'])
  assert.deepEqual(after, before, 'карточка без выбранной позиции перескочила бы на другого')
})

test('сегменты: ширина по людям, тон по статусу, текущая группа, хвост пишущих', () => {
  const attempts = [
    attempt('a1', 'a', { status: 'correct' }),
    attempt('a2', 'a', { status: 'unrun' }),
    attempt('b1', 'b', { status: 'failed' }),
    attempt('c1', 'c', { status: 'wrong' }),
  ]
  const groups = groupAttempts(attempts)
  const segments = stripSegments(groups, 41, 'b')
  assert.deepEqual(
    segments.map((s) => [s.key, s.count, s.tone, s.current, s.writing ?? false]),
    [
      ['a', 2, 'ok', false, false],
      ['b', 1, 'fail', true, false],
      ['c', 1, 'error', false, false],
      [WRITING_KEY, 41, 'none', false, true],
    ],
  )
  // Никто не пишет — хвоста нет.
  assert.equal(stripSegments(groups, 0, null).length, 3)
})

test('сданный пустой лист — группа со своим ключом, хвост пишущих — с другим', () => {
  // Один комментарий нормализуется в пустую строку — и это сдают.
  const empty = attempt('e', '# не знаю', { submittedAt: 10 })
  assert.equal(empty.groupKey, '')
  const groups = groupAttempts([empty])
  assert.equal(groups.length, 1)
  assert.equal(groupTitle(groups[0]), '# не знаю')
  const segments = stripSegments(groups, 1, null)
  const keys = segments.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length, 'два сегмента с одним ключом — падение keyed each')
  // Ключ хвоста непроизводим нормализацией: в нём есть пробел, а она пробелы выбрасывает все.
  assert.match(WRITING_KEY, / /)
  assert.notEqual(normalizeAttempt(WRITING_KEY), WRITING_KEY)
  assert.notEqual(normalizeAttempt(''), WRITING_KEY)
})

test('клавиши стопки: стрелки — и с кнопки, Enter — только с самой стопки, из поля — ничего', () => {
  assert.equal(stackKeyAction('ArrowRight', false, 'stack'), 'next')
  assert.equal(stackKeyAction('ArrowLeft', true, 'stack'), 'prevGroup')
  assert.equal(stackKeyAction('Enter', false, 'stack'), 'show')
  // Щёлкнули по сегменту полосы — фокус на кнопке; стрелки обязаны листать дальше.
  assert.equal(stackKeyAction('ArrowRight', false, 'control'), 'next')
  assert.equal(stackKeyAction('ArrowLeft', false, 'control'), 'prev')
  assert.equal(stackKeyAction('ArrowRight', true, 'control'), 'nextGroup')
  // А Enter на кнопке — её нажатие, не «показать классу».
  assert.equal(stackKeyAction('Enter', false, 'control'), null)
  assert.equal(stackKeyAction('ArrowRight', false, 'field'), null)
  assert.equal(stackKeyAction('Enter', false, 'field'), null)
  assert.equal(stackKeyAction('a', false, 'stack'), null)
})

test('тон черты: верно зелёная, неверно охра, упала красная, остальное серое', () => {
  assert.equal(toneOf('correct'), 'ok')
  assert.equal(toneOf('wrong'), 'error')
  assert.equal(toneOf('failed'), 'fail')
  assert.equal(toneOf('ran'), 'none')
  assert.equal(toneOf('unrun'), 'none')
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

test('соседи: стрелка — по попыткам, Shift — по группам, с пишущего вперёд некуда', () => {
  const attempts = [
    attempt('a1', 'a', { submittedAt: 1 }),
    attempt('a2', 'a', { submittedAt: 2 }),
    attempt('b1', 'b', { submittedAt: 3 }),
    attempt('w', 'c', { submittedAt: null }),
  ]
  const groups = groupAttempts(attempts)
  const order = stackOrder(groups, attempts) // a1, b1, a2, w

  assert.deepEqual(neighbours(order, groups, null), {
    prev: null,
    next: 'a1',
    prevGroup: null,
    nextGroup: 'a1',
  })
  assert.deepEqual(neighbours(order, groups, 'a1'), {
    prev: null,
    next: 'b1',
    prevGroup: null,
    nextGroup: 'b1',
  })
  // Внутри группы «a» Shift+← ведёт не к своему представителю, а к соседней группе.
  assert.deepEqual(neighbours(order, groups, 'a2'), {
    prev: 'b1',
    next: 'w',
    prevGroup: null,
    nextGroup: 'b1',
  })
  assert.deepEqual(neighbours(order, groups, 'w'), {
    prev: 'a2',
    next: null,
    prevGroup: 'b1',
    nextGroup: null,
  })
  // Позиция, которой в стопке уже нет (забанили), — как пустая.
  assert.equal(neighbours(order, groups, 'gone').next, 'a1')
})

test('плашка: «группа 1 из 2 · 3 / 4», «так же ещё N»', () => {
  const attempts = [
    attempt('a1', 'a', { submittedAt: 1 }),
    attempt('a2', 'a', { submittedAt: 2 }),
    attempt('b1', 'b', { submittedAt: 3 }),
    attempt('w', 'c', { submittedAt: null }),
  ]
  const groups = groupAttempts(attempts)
  const order = stackOrder(groups, attempts)
  assert.deepEqual(placeOf(order, groups, 'a2'), {
    index: 3,
    total: 4,
    group: 1,
    groups: 2,
    same: 1,
  })
  assert.deepEqual(placeOf(order, groups, 'w'), {
    index: 4,
    total: 4,
    group: 0,
    groups: 2,
    same: 0,
  })
  assert.equal(placeOf(order, groups, null).index, 0)
})

test('редкие — меньше одной двадцатой сдавших; на малый класс редких нет', () => {
  const groups = groupAttempts([
    ...Array.from({ length: 40 }, (_, i) => attempt(`a${i}`, 'a')),
    ...Array.from({ length: 9 }, (_, i) => attempt(`b${i}`, 'b')),
    ...Array.from({ length: 3 }, (_, i) => attempt(`c${i}`, 'c')),
  ])
  const big = splitRare(groups, 487)
  assert.deepEqual(
    big.main.map((g) => g.key),
    ['a'],
  )
  assert.deepEqual(
    big.rare.map((g) => g.count),
    [9, 3],
  )
  const small = splitRare(groups, 52)
  assert.equal(small.rare.length, 0)
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
