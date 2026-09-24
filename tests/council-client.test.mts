/**
 * The council on the client: the draft queue and parsing socket frames.
 *
 * What is checked is what makes such queues lie silently: two quick presses
 * are one send; "Submit" before the pause runs out takes the fresh text, not
 * the previous one; a closed council does not send what was held back. And
 * frame parsing: an oracle answer that arrives before the stack is not lost,
 * and the stack of a cell that was not touched stays the same reference —
 * re-rendering one cell rather than all of them rests on that.
 *
 * There is no Svelte compiler here: `$state` is a fake that returns the value
 * as is (as in tests/panels.test.mts). Reactivity is not checked — the
 * arithmetic is.
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

/* --------------------------------------------------------------- drafts */

test('the draft queue: the last text wins, one send per pause', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sent: [string, string][] = []
    const outbox = new DraftOutbox((cellId, text) => sent.push([cellId, text]), 800)
    outbox.hold('c1', 'x =')
    mock.timers.tick(500)
    outbox.hold('c1', 'x = 1')
    mock.timers.tick(500)
    // The pause counts from the last keystroke: the first has not gone out yet.
    assert.deepEqual(sent, [])
    mock.timers.tick(300)
    assert.deepEqual(sent, [['c1', 'x = 1']])
    assert.equal(outbox.has('c1'), false)
  } finally {
    mock.timers.reset()
  }
})

test('flush sends what was held back at once and only once; an empty queue stays silent', () => {
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

test('drop forgets the text without sending; clear removes all timers', () => {
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

/* ----------------------------------------------------------------- state */

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

test('"Submit" first sends the fresh snapshot, then submits', () => {
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
    // The timer went away with the flush: there is no second snapshot.
    assert.equal(wire.length, 2)
  } finally {
    mock.timers.reset()
  }
})

test('a closed council (mine.closed) drops the held-back snapshot', () => {
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

test('an oracle that arrives before the stack goes into it when the stack arrives', () => {
  const council = new CouncilState(() => {})
  council.receive({ t: 'council:oracle', cellId: 'c1', oracle: ORACLE })
  assert.equal('c1' in council.boards, false)
  council.receive({ t: 'council:board', cellId: 'c1', board: board() })
  assert.equal(council.boards.c1?.oracle?.state, 'ready')
  // A stack with its own oracle beats the early one: it is fresher.
  const later: CouncilBoard = { ...board(), oracle: { ...ORACLE, basedOn: 4 } }
  council.receive({ t: 'council:oracle', cellId: 'c2', oracle: ORACLE })
  council.receive({ t: 'council:board', cellId: 'c2', board: later })
  assert.equal(council.boards.c2?.oracle?.basedOn, 4)
})

test("an oracle on top of a stack changes only the oracle; another cell's stack stays the same reference", () => {
  const council = new CouncilState(() => {})
  council.receive({ t: 'council:board', cellId: 'c1', board: board() })
  council.receive({ t: 'council:board', cellId: 'c2', board: board() })
  const untouched = council.boards.c2
  council.receive({ t: 'council:oracle', cellId: 'c1', oracle: ORACLE })
  assert.equal(council.boards.c1?.oracle, ORACLE)
  assert.deepEqual(council.boards.c1?.counts, board().counts)
  assert.equal(council.boards.c2, untouched)
})

test('a counter is stored per cell, the neighbouring one is left alone', () => {
  const council = new CouncilState(() => {})
  council.receive({ t: 'council:count', cellId: 'c1', submitted: 1, total: 5 })
  const first = council.counts.c1
  council.receive({ t: 'council:count', cellId: 'c2', submitted: 3, total: 3 })
  assert.equal(council.counts.c1, first)
  assert.deepEqual(council.counts.c2, { submitted: 3, total: 3 })
})

test('"what is on screen" is stored per cell, and null means "removed", not "never was"', () => {
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
  assert.equal(council.shown.c2, undefined, 'the banner went to the neighbouring cell')
  council.receive({ t: 'council:shown', cellId: 'c1', shown: null })
  assert.equal(council.shown.c1, null)
  assert.ok('c1' in council.shown, 'the key vanished along with the banner')
})

test('"remove from screen" is one message without an addressee: there is always one on screen', () => {
  const wire: unknown[] = []
  const council = new CouncilState((message) => wire.push(message))
  council.show('c1', 'p_2')
  council.clearShown('c1')
  assert.deepEqual(wire, [
    { t: 'council:show', cellId: 'c1', participantId: 'p_2' },
    { t: 'council:show:clear', cellId: 'c1' },
  ])
})

test('output for the projector: lines, the tail cut off, no images', () => {
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
  assert.deepEqual(shownOutputLines(null), [], 'no run, no lines')
  // An image does not go into the projector feed: there is neither room nor
  // reason for it there.
  assert.ok(!shownOutputLines(run, 9).some((line) => line.includes('AAAA')))
})

test('the lock and the knobs go in one cell:lock message', () => {
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

test("running one's own attempt goes without participantId and after the snapshot", () => {
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

/* ----------------------------------------------------------------- words */

test('the mode strip: numerals and skipping empty pieces', () => {
  assert.equal(
    councilStripText({ attempts: 487, submitted: 446, writing: 41, groups: 6 }),
    '487 попыток · 446 сдали · 41 черновик · 6 разных ответов',
  )
  assert.equal(
    councilStripText({ attempts: 1, submitted: 1, writing: 0, groups: 1 }),
    '1 попытка · 1 сдал · 1 разный ответ',
  )
  assert.equal(
    councilStripText({ attempts: 2, submitted: 0, writing: 2, groups: 0 }),
    '2 попытки · 0 сдали · 2 черновика',
  )
})

test('"N of M submitted", the queue and the caption under the output', () => {
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

/* ---------------------------------------------------------------- deltas */

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

test('a stack delta replaces its own, adds new ones, drops removed, takes numbers from the frame', () => {
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
  assert.equal(council.boards.c2, untouched, "one cell's delta re-rendered the neighbouring one")
  // A delta for a cell without a stack has nowhere to go: a stack of one person
  // standing for the whole class is worse than an empty one.
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

test('withPatch keeps the oracle and leaves alone the attempts the frame did not name', () => {
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
  assert.equal(after.attempts[0], before.attempts[0], 'an untouched attempt is the same reference')
  assert.equal(after.lock, 'closed')
})

/* ------------------------------------------------------ one's own sheet */

test("a sheet starts from one's own attempt, and an empty string from the server is not an attempt", () => {
  assert.equal(sheetSeed('x = 1', '# задание'), 'x = 1')
  // `council:mine` with text '' in an open council means "no attempt yet": the
  // task stays.
  assert.equal(sheetSeed('', '# задание'), '# задание')
  assert.equal(sheetSeed(null, '# задание'), '# задание')
  assert.equal(sheetSeed(undefined, '# задание'), '# задание')
  assert.equal(sheetSeed('', ''), '')
})

test('withOracle leaves everything else alone', () => {
  const before = board()
  const after = withOracle(before, ORACLE)
  assert.equal(after.oracle, ORACLE)
  assert.equal(after.attempts, before.attempts)
  assert.equal(before.oracle, null)
})

test('a run request sends the fresh draft before the request; decisions are tied to the id', () => {
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
    assert.deepEqual(council.mine, {}, 'sending does not pass the request off as accepted')
  } finally {
    mock.timers.reset()
  }
})

test('a request and a refusal arrive in mine and patch regardless of submitting and running', () => {
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

test('the request list includes all 100 drafts and submitted ones, without refusals and finished ones', async () => {
  // The pending list is built by the console (`kernelView`): the old
  // `pendingRunRequests` lived in the stack under the cell and moved out with
  // it — the rule stayed the same.
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
  assert.deepEqual(attempts, before, 'the order of the shared stack does not change')
})

test('all three run modes go into the settings without being cast to boolean', () => {
  const wire: unknown[] = []
  const council = new CouncilState((message) => wire.push(message))
  for (const studentRun of [false, 'request', true] as const) council.lock('c1', 'council', { studentRun })
  assert.deepEqual(wire, [false, 'request', true].map((studentRun) => ({
    t: 'cell:lock', cellId: 'c1', state: 'council', settings: { studentRun },
  })))
})

/* ------------------------------------------ people labels in an answer */

/**
 * The Oracle's answer about the class names people by labels `S1…SN` — it
 * knows no other names (server/src/ai/council.ts). The console draws a chip
 * with the name in place of a label, and this breaks silently: a naive
 * substring replacement would eat `S7` inside `CSS7` and swap the start of
 * `S70` for someone else. A class of seventy is nothing unusual, and the
 * teacher would open the wrong work without noticing anything.
 */
test('labels in an answer become people only through the dictionary and only as whole words', async () => {
  const { splitAnswer } = await import('../web/src/lib/council-oracle-answer.js')
  const people = { S7: 'p_seven', S2: 'p_two' }

  assert.deepEqual(splitAnswer('Застрял S7, помогите.', people), [
    { kind: 'text', text: 'Застрял ' },
    { kind: 'person', label: 'S7', participantId: 'p_seven' },
    { kind: 'text', text: ', помогите.' },
  ])
  assert.deepEqual(splitAnswer('(S7) и S2', people), [
    { kind: 'text', text: '(' },
    { kind: 'person', label: 'S7', participantId: 'p_seven' },
    { kind: 'text', text: ') и ' },
    { kind: 'person', label: 'S2', participantId: 'p_two' },
  ])

  // Neither `CSS7` nor `S70` is a label: the first is not a separate word, the
  // second is not in this answer's dictionary.
  for (const text of ['правило CSS7 сломано', 'у S70 всё хорошо', 'смотрите S7x']) {
    assert.deepEqual(splitAnswer(text, people), [{ kind: 'text', text }], text)
  }
  // Labels from a previous answer stay text: the numbering lives for one
  // question.
  assert.deepEqual(splitAnswer('а S9 кто?', people), [{ kind: 'text', text: 'а S9 кто?' }])
  assert.deepEqual(splitAnswer('', people), [])
  assert.deepEqual(splitAnswer('S7', people), [
    { kind: 'person', label: 'S7', participantId: 'p_seven' },
  ])
})
