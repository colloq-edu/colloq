/**
 * Консилиум на клиенте: очередь черновиков и разбор кадров сокета.
 *
 * Проверяется то, из-за чего такие очереди врут молча: два быстрых нажатия —
 * одна отправка; «Сдать» до истечения паузы уносит свежий текст, а не прошлый;
 * закрытый консилиум не досылает придержанное. И разбор кадров: оракул,
 * приехавший раньше стопки, не теряется, а стопка ячейки, которую не трогали,
 * остаётся той же ссылкой — на этом стоит перерисовка одной ячейки, а не всех.
 *
 * Компилятора Svelte здесь нет: `$state` — подделка, возвращающая значение как
 * есть (как в tests/panels.test.mts). Реактивность не проверяется — арифметика.
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import type {
  CouncilAttempt,
  CouncilBoard,
  CouncilMine,
  CouncilOracle,
  CouncilRun,
} from '../shared/protocol.js'

const shim = <T,>(value: T): T => value
shim.raw = <T,>(value: T): T => value
;(globalThis as { $state?: unknown }).$state = shim

const {
  CouncilState,
  DraftOutbox,
  councilStripText,
  countLine,
  queueWords,
  ranByLine,
  sheetSeed,
  shownOutputLines,
  withOracle,
  withPatch,
} = await import('../web/src/lib/council.svelte.js')

/* ------------------------------------------------------------ черновики */

test('очередь черновиков: последний текст побеждает, одна отправка на паузу', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sent: [string, string][] = []
    const outbox = new DraftOutbox((cellId, text) => sent.push([cellId, text]), 800)
    outbox.hold('c1', 'x =')
    mock.timers.tick(500)
    outbox.hold('c1', 'x = 1')
    mock.timers.tick(500)
    // Пауза считается от последнего нажатия: первое ещё не уехало.
    assert.deepEqual(sent, [])
    mock.timers.tick(300)
    assert.deepEqual(sent, [['c1', 'x = 1']])
    assert.equal(outbox.has('c1'), false)
  } finally {
    mock.timers.reset()
  }
})

test('flush уносит придержанное сразу и один раз; пустая очередь молчит', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sent: string[] = []
    const outbox = new DraftOutbox((_cellId, text) => sent.push(text))
    assert.equal(outbox.flush('c1'), false)
    outbox.hold('c1', 'a')
    assert.equal(outbox.flush('c1'), true)
    mock.timers.tick(5_000)
    assert.deepEqual(sent, ['a'])
  } finally {
    mock.timers.reset()
  }
})

test('drop забывает текст без отправки; clear снимает все таймеры', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sent: string[] = []
    const outbox = new DraftOutbox((_cellId, text) => sent.push(text))
    outbox.hold('c1', 'a')
    outbox.drop('c1')
    outbox.hold('c2', 'b')
    outbox.hold('c3', 'c')
    outbox.clear()
    mock.timers.tick(5_000)
    assert.deepEqual(sent, [])
  } finally {
    mock.timers.reset()
  }
})

/* ------------------------------------------------------------- состояние */

const MINE: CouncilMine = {
  text: 'x = 1',
  submittedAt: null,
  updatedAt: 1,
  shown: false,
  correct: null,
  reply: null,
  run: null,
  queue: null,
  closed: false,
}

const ORACLE: CouncilOracle = {
  state: 'ready',
  askedAt: 10,
  basedOn: 3,
  summary: ['верно', 'ошибка', 'показать'],
  groupLabels: {},
  drafts: {},
  error: null,
}

function board(): CouncilBoard {
  return {
    lock: 'council',
    settings: { studentRun: false, namesOnProjector: true },
    counts: { attempts: 3, submitted: 2, writing: 1, groups: 2 },
    attempts: [],
    groups: [],
    oracle: null,
  }
}

test('«Сдать» сначала досылает свежий снимок, потом сдаёт', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const wire: { t: string; text?: string }[] = []
    const council = new CouncilState((message) => wire.push(message))
    council.draft('c1', 'x = ')
    council.draft('c1', 'x = 2')
    council.submit('c1')
    assert.deepEqual(
      wire.map((m) => m.t),
      ['council:draft', 'council:submit'],
    )
    assert.equal(wire[0].text, 'x = 2')
    mock.timers.tick(5_000)
    // Таймер снят вместе с flush: второго снимка нет.
    assert.equal(wire.length, 2)
  } finally {
    mock.timers.reset()
  }
})

test('закрытый консилиум (mine.closed) роняет придержанный снимок', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const wire: { t: string }[] = []
    const council = new CouncilState((message) => wire.push(message))
    council.draft('c1', 'x = 1')
    council.receive({ t: 'council:mine', cellId: 'c1', state: { ...MINE, closed: true } })
    mock.timers.tick(5_000)
    assert.deepEqual(wire, [])
    assert.equal(council.mine.c1?.closed, true)
  } finally {
    mock.timers.reset()
  }
})

test('оракул, приехавший раньше стопки, ложится в неё, когда она приезжает', () => {
  const council = new CouncilState(() => {})
  council.receive({ t: 'council:oracle', cellId: 'c1', oracle: ORACLE })
  assert.equal('c1' in council.boards, false)
  council.receive({ t: 'council:board', cellId: 'c1', board: board() })
  assert.equal(council.boards.c1?.oracle?.state, 'ready')
  // Стопка со своим оракулом сильнее раннего: она свежее.
  const later: CouncilBoard = { ...board(), oracle: { ...ORACLE, basedOn: 4 } }
  council.receive({ t: 'council:oracle', cellId: 'c2', oracle: ORACLE })
  council.receive({ t: 'council:board', cellId: 'c2', board: later })
  assert.equal(council.boards.c2?.oracle?.basedOn, 4)
})

test('оракул поверх стопки меняет только оракула; чужая стопка — та же ссылка', () => {
  const council = new CouncilState(() => {})
  council.receive({ t: 'council:board', cellId: 'c1', board: board() })
  council.receive({ t: 'council:board', cellId: 'c2', board: board() })
  const untouched = council.boards.c2
  council.receive({ t: 'council:oracle', cellId: 'c1', oracle: ORACLE })
  assert.equal(council.boards.c1?.oracle, ORACLE)
  assert.deepEqual(council.boards.c1?.counts, board().counts)
  assert.equal(council.boards.c2, untouched)
})

test('счётчик кладётся по ячейке, соседний не трогается', () => {
  const council = new CouncilState(() => {})
  council.receive({ t: 'council:count', cellId: 'c1', submitted: 1, total: 5 })
  const first = council.counts.c1
  council.receive({ t: 'council:count', cellId: 'c2', submitted: 3, total: 3 })
  assert.equal(council.counts.c1, first)
  assert.deepEqual(council.counts.c2, { submitted: 3, total: 3 })
})

test('«что на экране» кладётся по ячейке, а null — это «убрали», а не «не было»', () => {
  const council = new CouncilState(() => {})
  const shown = {
    participantId: 'p_2',
    variant: 3,
    name: 'Петя',
    color: '#123456',
    avatar: null,
    shownBy: 'Ада',
    shownAt: 1_700_000_000_000,
    text: 'x = 42',
    run: null,
    alsoWrote: 4,
    correct: null,
  }
  council.receive({ t: 'council:shown', cellId: 'c1', shown })
  assert.equal(council.shown.c1?.name, 'Петя')
  assert.equal(council.shown.c2, undefined, 'плашка уехала в соседнюю ячейку')
  council.receive({ t: 'council:shown', cellId: 'c1', shown: null })
  assert.equal(council.shown.c1, null)
  assert.ok('c1' in council.shown, 'ключ пропал вместе с плашкой')
})

test('«убрать с экрана» — одно сообщение без адресата: на экране всегда один', () => {
  const wire: unknown[] = []
  const council = new CouncilState((message) => wire.push(message))
  council.show('c1', 'p_2')
  council.clearShown('c1')
  assert.deepEqual(wire, [
    { t: 'council:show', cellId: 'c1', participantId: 'p_2' },
    { t: 'council:show:clear', cellId: 'c1' },
  ])
})

test('вывод для проектора: строки, хвост отрезан, картинок нет', () => {
  const run = {
    state: 'ok',
    execCount: 1,
    ranMs: 400,
    startedAt: 0,
    by: 'host',
    outputs: [
      { kind: 'stream', name: 'stdout', text: 'первая\nвторая\n' },
      { kind: 'data', data: { 'image/png': 'AAAA', 'text/plain': 'третья' }, execCount: 1 },
      { kind: 'error', ename: 'ValueError', evalue: 'плохо', traceback: ['…'] },
    ],
  } as unknown as CouncilRun
  assert.deepEqual(shownOutputLines(run, 4), ['первая', 'вторая', 'третья', 'ValueError: плохо'])
  assert.deepEqual(shownOutputLines(run, 2), ['первая', 'вторая'])
  assert.deepEqual(shownOutputLines(null), [], 'запуска не было — и строк нет')
  // Картинка в ленту проектора не едет: там на неё нет ни места, ни повода.
  assert.ok(!shownOutputLines(run, 9).some((line) => line.includes('AAAA')))
})

test('замок и ручки — одним сообщением cell:lock', () => {
  const wire: unknown[] = []
  const council = new CouncilState((message) => wire.push(message))
  council.lock('c1', 'council')
  council.lock('c1', 'council', { studentRun: true })
  council.lock('c1', 'closed')
  assert.deepEqual(wire, [
    { t: 'cell:lock', cellId: 'c1', state: 'council' },
    { t: 'cell:lock', cellId: 'c1', state: 'council', settings: { studentRun: true } },
    { t: 'cell:lock', cellId: 'c1', state: 'closed' },
  ])
})

test('запуск своей попытки идёт без participantId и после снимка', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const wire: Record<string, unknown>[] = []
    const council = new CouncilState((message) => wire.push(message))
    council.draft('c1', 'print(1)')
    council.run('c1')
    council.run('c1', 'p_2')
    assert.deepEqual(wire, [
      { t: 'council:draft', cellId: 'c1', text: 'print(1)' },
      { t: 'council:run', cellId: 'c1' },
      { t: 'council:run', cellId: 'c1', participantId: 'p_2' },
    ])
    assert.equal('participantId' in wire[1], false)
  } finally {
    mock.timers.reset()
  }
})

/* ----------------------------------------------------------------- слова */

test('полоса режима: числительные и пропуск пустых кусков', () => {
  assert.equal(
    councilStripText({ attempts: 487, submitted: 446, writing: 41, groups: 6 }),
    '487 попыток · 446 сдали · 41 ещё пишет · 6 разных ответов',
  )
  assert.equal(
    councilStripText({ attempts: 1, submitted: 1, writing: 0, groups: 1 }),
    '1 попытка · 1 сдал · 1 разный ответ',
  )
  assert.equal(
    councilStripText({ attempts: 2, submitted: 0, writing: 2, groups: 0 }),
    '2 попытки · 0 сдали · 2 ещё пишут',
  )
})

test('«N сдали из M», очередь и подпись под выводом', () => {
  assert.equal(countLine({ submitted: 446, total: 487 }), '446 сдали из 487')
  assert.equal(countLine({ submitted: 1, total: 1 }), '1 сдал из 1')
  assert.equal(queueWords(37), 'вы 37-й в очереди')
  const spell = (ms: number) => `${ms} ms`
  const run: CouncilRun = {
    state: 'ok',
    outputs: [],
    execCount: 1,
    ranMs: 400,
    startedAt: 0,
    by: 'host',
  }
  assert.equal(ranByLine(run, spell), 'запускал преподаватель · 400 ms')
  assert.equal(ranByLine({ ...run, by: 'author', ranMs: null }, spell), 'запускали вы')
  assert.equal(ranByLine({ ...run, state: 'running' }, spell), 'выполняется')
  assert.equal(ranByLine({ ...run, state: 'queued' }, spell), 'в очереди на запуск')
})

/* ---------------------------------------------------------------- дельты */

function attemptOf(id: string, text: string): CouncilAttempt {
  return {
    participantId: id,
    name: id,
    color: '#000',
    avatar: null,
    text,
    submittedAt: null,
    updatedAt: 1,
    status: 'unrun',
    run: null,
    reply: null,
    correct: null,
    shown: false,
    groupKey: text,
  }
}

test('дельта стопки: заменяет своих, добавляет новых, убирает removed, числа из кадра', () => {
  const council = new CouncilState(() => {})
  const full: CouncilBoard = {
    ...board(),
    attempts: [attemptOf('a', 'x = 1'), attemptOf('b', 'x = 2'), attemptOf('c', 'x = 3')],
  }
  council.receive({ t: 'council:board', cellId: 'c1', board: full })
  council.receive({ t: 'council:board', cellId: 'c2', board: board() })
  const untouched = council.boards.c2
  council.receive({
    t: 'council:patch',
    cellId: 'c1',
    attempts: [attemptOf('b', 'x = 22'), attemptOf('d', 'x = 4')],
    removed: ['c'],
    counts: { attempts: 3, submitted: 0, writing: 3, groups: 0 },
    lock: 'council',
    settings: { studentRun: true, namesOnProjector: true },
  })
  const after = council.boards.c1!
  assert.deepEqual(
    after.attempts.map((a) => [a.participantId, a.text]),
    [
      ['a', 'x = 1'],
      ['b', 'x = 22'],
      ['d', 'x = 4'],
    ],
  )
  assert.equal(after.counts.writing, 3)
  assert.equal(after.settings.studentRun, true)
  assert.equal(council.boards.c2, untouched, 'дельта одной ячейки перерисовала соседнюю')
  // Дельта по ячейке без стопки — некуда: стопка из одного человека за весь класс хуже пустой.
  council.receive({
    t: 'council:patch',
    cellId: 'c9',
    attempts: [attemptOf('z', 'x')],
    removed: [],
    counts: { attempts: 1, submitted: 0, writing: 1, groups: 0 },
    lock: 'council',
    settings: { studentRun: false, namesOnProjector: true },
  })
  assert.equal('c9' in council.boards, false)
})

test('withPatch оставляет оракула и не трогает попытки, которых кадр не называл', () => {
  const before: CouncilBoard = { ...board(), oracle: ORACLE, attempts: [attemptOf('a', 'x')] }
  const after = withPatch(before, {
    t: 'council:patch',
    cellId: 'c1',
    attempts: [],
    removed: ['nobody'],
    counts: before.counts,
    lock: 'closed',
    settings: before.settings,
  })
  assert.equal(after.oracle, ORACLE)
  assert.equal(after.attempts[0], before.attempts[0], 'нетронутая попытка — та же ссылка')
  assert.equal(after.lock, 'closed')
})

/* ------------------------------------------------------------ свой лист */

test('лист заводится со своей попытки, а пустая строка от сервера — не попытка', () => {
  assert.equal(sheetSeed('x = 1', '# задание'), 'x = 1')
  // `council:mine` с text '' при открытом консилиуме — «попытки ещё нет»: задание остаётся.
  assert.equal(sheetSeed('', '# задание'), '# задание')
  assert.equal(sheetSeed(null, '# задание'), '# задание')
  assert.equal(sheetSeed(undefined, '# задание'), '# задание')
  assert.equal(sheetSeed('', ''), '')
})

test('withOracle не трогает остальное', () => {
  const before = board()
  const after = withOracle(before, ORACLE)
  assert.equal(after.oracle, ORACLE)
  assert.equal(after.attempts, before.attempts)
  assert.equal(before.oracle, null)
})

test('запрос запуска отправляет свежий черновик раньше запроса; решения привязаны к id', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const wire: unknown[] = []
    const council = new CouncilState((message) => wire.push(message))
    council.draft('c1', 'print(2)')
    council.requestRun('c1')
    council.cancelRunRequest('c1', 'r1')
    council.approveRunRequest('c1', 'p1', 'r2')
    council.declineRunRequest('c1', 'p2', 'r3')
    mock.timers.tick(5_000)
    assert.deepEqual(wire, [
      { t: 'council:draft', cellId: 'c1', text: 'print(2)' },
      { t: 'council:run:request', cellId: 'c1' },
      { t: 'council:run:cancel', cellId: 'c1', requestId: 'r1' },
      { t: 'council:run:approve', cellId: 'c1', participantId: 'p1', requestId: 'r2' },
      { t: 'council:run:decline', cellId: 'c1', participantId: 'p2', requestId: 'r3' },
    ])
    assert.deepEqual(council.mine, {}, 'отправка не выдаёт запрос за принятый')
  } finally {
    mock.timers.reset()
  }
})

test('запрос и отказ приходят в mine и patch независимо от сдачи и запуска', () => {
  const council = new CouncilState(() => {})
  const pending = { id: 'r1', requestedAt: 12, status: 'pending' as const }
  const a = attemptOf('a', 'x')
  const untouched = attemptOf('b', 'y')
  council.receive({ t: 'council:board', cellId: 'c1', board: { ...board(), attempts: [a, untouched] } })
  for (const runRequest of [pending, { ...pending, status: 'declined' as const }, null]) {
    council.receive({ t: 'council:mine', cellId: 'c1', state: { ...MINE, runRequest } })
    council.receive({
      t: 'council:patch', cellId: 'c1', attempts: [{ ...a, runRequest }], removed: [],
      counts: board().counts, lock: 'council', settings: { ...board().settings, studentRun: 'request' },
    })
    assert.deepEqual(council.mine.c1.runRequest, runRequest)
    assert.deepEqual(council.boards.c1.attempts[0].runRequest, runRequest)
    assert.equal(council.boards.c1.attempts[0].submittedAt, null)
    assert.equal(council.boards.c1.attempts[0].run, null)
    assert.equal(council.boards.c1.attempts[1], untouched)
    assert.equal(council.boards.c1.settings.studentRun, 'request')
  }
})

test('список запросов включает все 100 черновиков и сданных, без отказов и завершённых', async () => {
  // Список ждущих собирает пульт (`kernelView`): прежняя `pendingRunRequests`
  // жила в стопке под ячейкой и уехала вместе с ней — правило осталось то же.
  const { kernelView } = await import('../web/src/lib/council-pult.js')
  const attempts: CouncilAttempt[] = Array.from({ length: 100 }, (_, i) => ({
    ...attemptOf(`p${i}`, String(i)),
    submittedAt: i % 2 ? 1 : null,
    runRequest: { id: `r${i}`, requestedAt: 100 - i, status: 'pending' },
  }))
  attempts.push({ ...attemptOf('declined', ''), runRequest: { id: 'old', requestedAt: 0, status: 'declined' } })
  attempts.push(attemptOf('no-request', ''))
  const before = [...attempts]
  const requests = kernelView(attempts).pending
  assert.equal(requests.length, 100)
  assert.equal(requests.filter((a) => a.submittedAt === null).length, 50)
  assert.equal(requests[0].participantId, 'p99')
  assert.equal(requests[99].participantId, 'p0')
  assert.deepEqual(attempts, before, 'порядок общей стопки не изменяется')
})

test('все три режима запуска уходят в настройки без приведения к boolean', () => {
  const wire: unknown[] = []
  const council = new CouncilState((message) => wire.push(message))
  for (const studentRun of [false, 'request', true] as const) council.lock('c1', 'council', { studentRun })
  assert.deepEqual(wire, [false, 'request', true].map((studentRun) => ({
    t: 'cell:lock', cellId: 'c1', state: 'council', settings: { studentRun },
  })))
})
