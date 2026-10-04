/**
 * Decisions of the "Competitions" tab, the ones the browser makes.
 *
 * No browser and no Svelte: everything that has a right and a wrong answer
 * lives in `web/src/admin/competitions.ts` precisely so that it can be
 * checked from here. What is checked is not "the function returned a string"
 * but the particular cases where the screen starts lying: a metric on
 * another scale, a deadline that is about to hit, a preset over someone
 * else's code, a leaderboard from a feed that contains the baseline.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver, tr } from '../shared/i18n.js'
import {
  METRIC_PRESETS,
  answerColumns,
  applyPreset,
  baselineNote,
  boardFromFeed,
  clock,
  columnsCheck,
  deadlineDividerAt,
  deadlineLine,
  etaWords,
  feedWhen,
  inFlight,
  isUntouchedPreset,
  lateQuery,
  leftWords,
  limitNote,
  metricLine,
  metricNumber,
  moment,
  outcomeLine,
  presetCode,
  refusalSection,
  refusalText,
  runnerLine,
  sealedErrorBox,
  sealedPath,
  sealedTarget,
  sinceWords,
  spanWords,
  stateTone,
  stateWord,
  withNewKey,
  worstCell,
} from '../web/src/admin/competitions.js'
import type { Competition, Submission } from '../shared/competitions.js'
import type {
  CompetitionRow,
  EntrantRow,
  FileView,
  OpenRefusal,
  QueueSnapshot,
  SealedFileView,
  SubmissionRow,
} from '../shared/competitions-api.js'

afterEach(() => setLocaleResolver(() => 'ru'))

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A template competition: the tests change one field in it at a time. */
function competition(over: Partial<Competition> = {}): Competition {
  return {
    id: 'k1',
    slug: 'rohlik',
    title: 'Rohlik: сколько заказов будет завтра',
    blurb: '',
    description: '',
    state: 'live',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(): ...' },
    publicPercent: 30,
    splitSeed: 'seed',
    limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 },
    environment: 'base',
    startsAt: null,
    deadlineAt: null,
    privateRelease: 'auto',
    scoring: 'chosen',
    privateOpenedAt: null,
    baselineSubmissionId: null,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function row(over: Partial<CompetitionRow> = {}): CompetitionRow {
  return {
    competition: competition(),
    entrants: 28,
    submissions: 143,
    bestPublic: 0.0412,
    baselineScore: 0.0587,
    baselineState: 'scored',
    ready: null,
    ...over,
  }
}

function submission(over: Partial<Submission> = {}): Submission {
  return {
    id: 's1',
    competitionId: 'k1',
    entrantId: 'e1',
    number: 1,
    fileName: 'run.ipynb',
    bytes: 1000,
    acceptedAt: 1000,
    state: 'scored',
    stage: 'score',
    publicScore: 0.05,
    privateScore: 0.06,
    durationMs: 60_000,
    cellsDone: 14,
    cellsTotal: 14,
    participantError: null,
    teacherError: null,
    chosen: false,
    ...over,
  }
}

function feedRow(over: Partial<Submission>, extra: Partial<SubmissionRow> = {}): SubmissionRow {
  return {
    submission: submission(over),
    entrantName: 'Анна Ким',
    baseline: false,
    best: false,
    ...extra,
  }
}

/* ---------------------------------------------------------------- numbers */

test('a metric is printed so that different numbers look different', () => {
  assert.equal(metricNumber(0.0412), '0.0412')
  // The same number of digits for numbers of the same kind: the column reads as a column.
  assert.equal(metricNumber(0.7034), '0.7034')
  // A large number loses digits, not the column: 96 pixels of monospace
  // cannot hold "1234.5678".
  assert.equal(metricNumber(1234.5678), '1234.6')
  assert.equal(metricNumber(12.3456789), '12.346')
  // A tiny one goes to an exponent rather than "0.0000" for everyone: a
  // leaderboard whose first ten places are equal is a leaderboard without places.
  assert.equal(metricNumber(0.00005), '5.00e-5')
  assert.equal(metricNumber(1.5e7), '1.50e+7')
  assert.equal(metricNumber(0), '0.0000')
  assert.equal(metricNumber(-0.25), '-0.2500')
})

test('what is missing is a dash, not a zero', () => {
  assert.equal(metricNumber(null), '—')
  assert.equal(metricNumber(undefined), '—')
  assert.equal(metricNumber(Number.NaN), '—')
  assert.equal(metricNumber(Number.POSITIVE_INFINITY), '—')
})

test('duration in words: seconds for short ones, hours for long ones', () => {
  assert.equal(spanWords(160_000), '2 мин 40 с')
  assert.equal(spanWords(108_000), '1 мин 48 с')
  assert.equal(spanWords(41_000), '41 с')
  assert.equal(spanWords(2 * HOUR + 12 * MINUTE), '2 ч 12 мин')
  assert.equal(spanWords(null), '—')
})

test('the run stopwatch is compared at a glance, not by reading', () => {
  // A leading zero only where a limit stands next to it: "01:12 of 10:00".
  assert.equal(clock(72_000, true), '01:12')
  assert.equal(clock(600_000, true), '10:00')
  // In the "RAN" column it is superfluous: that is how the mockup draws it.
  assert.equal(clock(185_000), '3:05')
  assert.equal(clock(41_000), '0:41')
  assert.equal(clock(3 * HOUR + 5_000), '3:00:05')
  assert.equal(clock(null), '—')
})

test('time left uses two units, never three', () => {
  assert.equal(leftWords(6 * DAY + 4 * HOUR + 17 * MINUTE), '6 дн 4 ч')
  assert.equal(leftWords(6 * DAY), '6 дн')
  assert.equal(leftWords(HOUR + 12 * MINUTE), '1 ч 12 мин')
  assert.equal(leftWords(40 * MINUTE), '40 мин')
  assert.equal(leftWords(30_000), '30 с')
  assert.equal(leftWords(0), 'срок вышел')
  assert.equal(leftWords(-1), 'срок вышел')
})

test('time elapsed: the scale goes up to months, since the list lives a semester', () => {
  const now = Date.UTC(2026, 8, 20, 12)
  assert.equal(sinceWords(now - 30_000, now), 'только что')
  assert.equal(sinceWords(now - 5 * MINUTE, now), '5 мин назад')
  assert.equal(sinceWords(now - 5 * HOUR, now), '5 ч назад')
  assert.equal(sinceWords(now - DAY, now), 'вчера')
  assert.equal(sinceWords(now - 3 * DAY, now), '3 дн назад')
  // "7 days ago" is a number nobody converts into weeks in their head.
  assert.equal(sinceWords(now - 7 * DAY, now), 'неделю назад')
  assert.equal(sinceWords(now - 14 * DAY, now), '2 недели назад')
  assert.equal(sinceWords(now - 60 * DAY, now), '2 месяца назад')
})

/* --------------------------------------------------------------- deadline */

test('the deadline lights up half a day ahead and stays quiet a week ahead', () => {
  const now = Date.UTC(2026, 8, 20, 12)
  const far = deadlineLine(competition({ deadlineAt: now + 6 * DAY + 4 * HOUR }), now)
  assert.equal(far.note, 'осталось 6 дн 4 ч')
  assert.equal(far.hot, false)
  const soon = deadlineLine(competition({ deadlineAt: now + HOUR + 12 * MINUTE }), now)
  assert.equal(soon.note, 'осталось 1 ч 12 мин')
  assert.equal(soon.hot, true)
})

test('a draft shows what happens next in place of the deadline', () => {
  const now = Date.UTC(2026, 8, 20, 12)
  const waiting = deadlineLine(competition({ state: 'draft', deadlineAt: null }), now, 'noBaseline')
  assert.equal(waiting.when, 'не назначен')
  assert.equal(waiting.note, 'откроется после проверки')
  const ready = deadlineLine(competition({ state: 'draft', deadlineAt: null }), now, null)
  assert.equal(ready.note, 'готово к открытию')
})

test('a finished one shows how long ago, and has nothing to light up for', () => {
  const now = Date.UTC(2026, 8, 20, 12)
  const done = deadlineLine(competition({ state: 'finished', deadlineAt: now - 7 * DAY }), now)
  assert.equal(done.note, 'неделю назад')
  assert.equal(done.hot, false)
  // A live one whose deadline has already passed says the same: submissions
  // are closed, and "−3 h left" is not a number but an accusation.
  const late = deadlineLine(competition({ deadlineAt: now - 2 * HOUR }), now)
  assert.equal(late.note, '2 ч назад')
  assert.equal(late.hot, false)
})

test('the "WHEN" column shows the time for a row from today and the date for one from yesterday', () => {
  const now = new Date(2026, 8, 20, 18, 58).getTime()
  assert.match(feedWhen(now, now), /^\d{2}:\d{2}$/)
  assert.match(feedWhen(now - 7 * DAY, now), /^\d{2}\.\d{2}$/)
  // "today, 21:00" is the header form, not the column form: there is room there.
  assert.match(moment(now, now), /^сегодня, \d{2}:\d{2}$/)
})

/* ---------------------------------------------------------------- A1 rows */

test('the second line of the title answers "what is wrong with it right now"', () => {
  const now = Date.UTC(2026, 8, 20, 12)
  assert.equal(metricLine(row(), now), 'MAPE · меньше — лучше · публичная часть 30 %')
  const draft = row({
    competition: competition({ state: 'draft' }),
    ready: 'baselineNotChecked',
  })
  assert.equal(metricLine(draft, now), 'MAPE · меньше — лучше · бейзлайн ещё не прошёл проверку')
  const finished = row({
    competition: competition({ state: 'finished', privateOpenedAt: now - HOUR }),
  })
  assert.equal(metricLine(finished, now), 'MAPE · меньше — лучше · приватный лидерборд открыт')
})

test('under the best result stands the baseline, and its trouble if there is one', () => {
  assert.deepEqual(baselineNote(row()), { text: 'бейзлайн 0.0587', bad: false })
  assert.deepEqual(baselineNote(row({ baselineState: null })), {
    text: 'бейзлайн не проверяли',
    bad: false,
  })
  // A failed metric is the teacher's fault, and it is named separately from "did not reach".
  assert.deepEqual(baselineNote(row({ baselineState: 'metricFailed' })), {
    text: 'бейзлайн: ошибка метрики',
    bad: true,
  })
  assert.equal(baselineNote(row({ baselineState: 'notebookFailed' })).bad, true)
})

/* ------------------------------------------------------------ runner strip */

function queue(over: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    paused: false,
    pausedAt: null,
    running: [],
    waiting: 0,
    slots: 1,
    doneToday: 37,
    averageMs: 160_000,
    ...over,
  }
}

test('the runner strip says what is running and on what terms', () => {
  const line = runnerLine(
    queue({
      running: [{} as never],
      waiting: 2,
    }),
  )
  assert.equal(line.head, 'исполняет 1 посылку · 2 ждут')
  assert.equal(line.tail, 'по одной за раз · без сети · сегодня исполнено 37, в среднем 2 мин 40 с')
})

test('a paused queue is named in words: otherwise it cannot be told from an empty one', () => {
  const line = runnerLine(queue({ paused: true }))
  assert.equal(line.head, 'очередь приостановлена · ничего не исполняется')
})

test('no average, no promise', () => {
  const line = runnerLine(queue({ averageMs: null, doneToday: 0 }))
  assert.match(line.tail, /сегодня исполнено 0$/)
})

test('the wait estimate: "≈ 0 min" is a promise, and it never appears', () => {
  assert.equal(etaWords(3 * MINUTE), '≈ 3 мин')
  assert.equal(etaWords(20_000), 'вот-вот')
  assert.equal(etaWords(null), 'неизвестно')
})

/* ------------------------------------------------------------------ gate */

test('every refusal to open points to its own section of the form', () => {
  const where: Record<OpenRefusal, string> = {
    noData: 'data',
    noSolution: 'data',
    noMetric: 'metric',
    noBaseline: 'baseline',
    baselineNotChecked: 'baseline',
    noDeadline: 'terms',
  }
  for (const [refusal, section] of Object.entries(where)) {
    assert.equal(refusalSection(refusal as OpenRefusal), section, refusal)
    // The phrase is the same the door refuses with: a retelling of our own would drift from it.
    assert.notEqual(refusalText(refusal as OpenRefusal), `competitions.refusal.open.${refusal}`)
  }
})

/* ----------------------------------------------------------- metric presets */

test('preset columns are taken from the answers header, and Usage is not a prediction', () => {
  assert.deepEqual(answerColumns(['id', 'orders']), { id: 'id', target: 'orders' })
  // Usage marks the row split and sits next to the target (shared · splitByUsage).
  assert.deepEqual(answerColumns(['row_id', 'Usage', 'target']), {
    id: 'row_id',
    target: 'target',
  })
  assert.deepEqual(answerColumns(null), { id: 'id', target: 'target' })
  assert.deepEqual(answerColumns([]), { id: 'id', target: 'target' })
})

test('the preset is written for the real columns of this competition', () => {
  const code = presetCode('MAPE', { id: 'id', target: 'orders' })
  assert.match(code, /def score\(solution: pd\.DataFrame, submission: pd\.DataFrame\) -> float:/)
  assert.match(code, /!= \["id", "orders"\]/)
  assert.match(code, /merged\["orders_pred"\]/)
  // A substituted `target` where the answers say `orders` fails at the very
  // first check, with a trace that is read as a product error.
  assert.doesNotMatch(code, /"target"/)
})

test('every preset has its own code and its own direction', () => {
  const columns = { id: 'id', target: 'y' }
  const codes = METRIC_PRESETS.map((preset) => presetCode(preset.name, columns))
  assert.equal(new Set(codes).size, METRIC_PRESETS.length)
  assert.equal(METRIC_PRESETS.find((p) => p.name === 'MAPE')?.direction, 'lower')
  assert.equal(METRIC_PRESETS.find((p) => p.name === 'ROC AUC')?.direction, 'higher')
  // Whoever needs sklearn asks for it; plain arithmetic has numpy.
  assert.match(presetCode('QWK', columns), /from sklearn\.metrics import cohen_kappa_score/)
  assert.match(presetCode('RMSE', columns), /np\.sqrt/)
})

test('a preset chip does not erase what was written by hand', () => {
  const columns = { id: 'id', target: 'orders' }
  const mine = 'def score(solution, submission):\n    return 0.0\n'
  const after = applyPreset({ name: 'MAPE', direction: 'lower', code: mine }, 'ROC AUC', columns)
  // The name and the direction always change: that is what the chip is pressed for.
  assert.equal(after.name, 'ROC AUC')
  assert.equal(after.direction, 'higher')
  // But half an hour of work on one's own metric cannot be brought back.
  assert.equal(after.code, mine)
})

test('code is filled in over an empty field and over an untouched preset', () => {
  const columns = { id: 'id', target: 'orders' }
  const empty = applyPreset({ name: '', direction: 'lower', code: '   ' }, 'MAE', columns)
  assert.equal(empty.code, presetCode('MAE', columns))
  const swapped = applyPreset(
    { name: 'MAE', direction: 'lower', code: presetCode('MAE', columns) },
    'F1',
    columns,
  )
  assert.equal(swapped.code, presetCode('F1', columns))
  assert.equal(swapped.direction, 'higher')
})

test('an unknown chip name changes nothing', () => {
  const columns = { id: 'id', target: 'orders' }
  const before = { name: 'MAPE', direction: 'lower' as const, code: 'x' }
  assert.deepEqual(applyPreset(before, 'LogLoss', columns), before)
})

test('"this is still a preset" is about the code, not the name', () => {
  const columns = { id: 'id', target: 'orders' }
  assert.equal(isUntouchedPreset(presetCode('QWK', columns), columns), true)
  assert.equal(isUntouchedPreset(`${presetCode('QWK', columns)}\n# моё\n`, columns), false)
  assert.equal(isUntouchedPreset('', columns), false)
  // Columns of the same kind, but different ones: code for another header is no longer this preset.
  assert.equal(isUntouchedPreset(presetCode('QWK', columns), { id: 'id', target: 'y' }), false)
})

/* --------------------------------------------------------------- A3 summary */

test('the cell the class stumbles on is about the task, not about people', () => {
  const rows = [
    feedRow({ id: 'a', state: 'notebookFailed', cellsDone: 7 }),
    feedRow({ id: 'b', state: 'notebookFailed', cellsDone: 7 }),
    feedRow({ id: 'c', state: 'notebookFailed', cellsDone: 7 }),
    feedRow({ id: 'd', state: 'notebookFailed', cellsDone: 12 }),
    feedRow({ id: 'e', state: 'scored', cellsDone: 14 }),
  ]
  assert.deepEqual(worstCell(rows), { cell: 7, hits: 3, total: 4 })
})

test('one or two failures are not declared a pattern', () => {
  const rows = [
    feedRow({ id: 'a', state: 'notebookFailed', cellsDone: 7 }),
    feedRow({ id: 'b', state: 'notebookFailed', cellsDone: 3 }),
  ]
  assert.equal(worstCell(rows), null)
  assert.equal(worstCell([]), null)
})

test('the baseline solution does not count in the failure statistics: it is not the class', () => {
  const rows = [
    feedRow({ id: 'a', state: 'notebookFailed', cellsDone: 7 }, { baseline: true }),
    feedRow({ id: 'b', state: 'notebookFailed', cellsDone: 7 }, { baseline: true }),
    feedRow({ id: 'c', state: 'notebookFailed', cellsDone: 7 }, { baseline: true }),
  ]
  assert.equal(worstCell(rows), null)
})

test('a notebook that did not reach its first cell points at nothing', () => {
  const rows = [
    feedRow({ id: 'a', state: 'notebookFailed', cellsDone: 0 }),
    feedRow({ id: 'b', state: 'notebookFailed', cellsDone: 0 }),
    feedRow({ id: 'c', state: 'notebookFailed', cellsDone: 0 }),
  ]
  assert.equal(worstCell(rows), null)
})

/* ------------------------------------------------ leaderboard from the feed */

test('the leaderboard is computed by the same rule as on the server, and without the baseline', () => {
  const rows = [
    feedRow({ id: 's1', entrantId: 'a', publicScore: 0.05, privateScore: 0.051, acceptedAt: 1 }),
    feedRow({ id: 's2', entrantId: 'a', publicScore: 0.04, privateScore: 0.061, acceptedAt: 2 }),
    feedRow({ id: 's3', entrantId: 'b', publicScore: 0.045, privateScore: 0.044, acceptedAt: 3 }),
    feedRow({ id: 's9', entrantId: 'z', publicScore: 0.001, privateScore: 0.001 }, { baseline: true }),
  ]
  const c = competition()
  const board = boardFromFeed(rows, c, 'public')
  // The baseline solution is not a participant, and it gets no place.
  assert.deepEqual(
    board.map((r) => r.entrantId),
    ['a', 'b'],
  )
  assert.equal(board[0].score, 0.04)
  // The private table takes THE SAME submission as the public one: the
  // scoring rule chooses by what the participant saw.
  const priv = boardFromFeed(rows, c, 'private')
  assert.equal(priv.find((r) => r.entrantId === 'a')?.score, 0.061)
  assert.equal(priv[0].entrantId, 'b')
})

test('a submission chosen by its author beats the best public one', () => {
  const rows = [
    feedRow({ id: 's1', entrantId: 'a', publicScore: 0.05, acceptedAt: 1, chosen: true }),
    feedRow({ id: 's2', entrantId: 'a', publicScore: 0.04, acceptedAt: 2 }),
  ]
  assert.equal(boardFromFeed(rows, competition(), 'public')[0].score, 0.05)
  // But under the "best public" rule the author's choice is not consulted.
  assert.equal(
    boardFromFeed(rows, competition({ scoring: 'bestPublic' }), 'public')[0].score,
    0.04,
  )
})

test("a tie on the teacher's board takes a place per row, the earlier submission higher, the same as on the class's", () => {
  const tie = 0.6722222222222224
  // The feed runs newest first: the tie arrives in the reverse of the order it
  // ranks in, so the order below is time's, not the feed's.
  const rows = [
    feedRow({ id: 's1', entrantId: 'a', publicScore: 0.9, privateScore: 0.9, acceptedAt: 1 }),
    ...['d', 'c', 'b'].map((entrantId, i) =>
      feedRow({ id: `t${i}`, entrantId, publicScore: tie, privateScore: 0.5, acceptedAt: 12 - i }),
    ),
    feedRow({ id: 's5', entrantId: 'e', publicScore: 0.1, privateScore: 0.1, acceptedAt: 2 }),
    feedRow({ id: 's9', entrantId: 'z', publicScore: tie, privateScore: tie }, { baseline: true }),
  ]
  const c = competition({ metric: { name: 'Accuracy', direction: 'higher', code: '' } })
  // The baseline sits in the tie by score, and still takes nobody's place.
  assert.deepEqual(
    boardFromFeed(rows, c, 'public').map((r) => [r.entrantId, r.place]),
    [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]],
  )
  // The final scores tie the three again: the same order by time, the same
  // places.
  assert.deepEqual(
    boardFromFeed(rows, c, 'private').map((r) => [r.entrantId, r.place]),
    [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]],
  )
})

test('only what reached a number goes into the leaderboard', () => {
  const rows = [
    feedRow({ id: 's1', entrantId: 'a', state: 'notebookFailed', publicScore: null }),
    feedRow({ id: 's2', entrantId: 'b', state: 'rejected', publicScore: null }),
  ]
  assert.deepEqual(boardFromFeed(rows, competition(), 'public'), [])
})

/* ----------------------------------------------------------------- words */

test('the "WHAT HAPPENED" column talks about the submission, not about the check', () => {
  assert.equal(
    outcomeLine(feedRow({ state: 'scored' }), true),
    'новый лучший результат соревнования',
  )
  assert.equal(outcomeLine(feedRow({ state: 'scored', chosen: true }), false), 'выбрана автором в зачёт')
  assert.equal(outcomeLine(feedRow({ state: 'scored' }), false), '')
  assert.match(outcomeLine(feedRow({ state: 'metricFailed' }), false), /Ошибка в вашем коде/)
  // The participant's text is read verbatim: it is what they will see.
  assert.equal(
    outcomeLine(feedRow({ state: 'rejected', participantError: 'Нет колонки id' }), false),
    'Нет колонки id',
  )
  assert.equal(
    outcomeLine(feedRow({ state: 'notebookFailed', cellsDone: 7, participantError: null }), false),
    'ячейка 7',
  )
})

test('the competition badge tone follows the mockup table', () => {
  assert.equal(stateTone('live'), 'accent')
  assert.equal(stateTone('draft'), 'warning')
  assert.equal(stateTone('finished'), 'neutral')
  assert.equal(stateWord('live'), 'ИДЁТ')
  assert.equal(stateWord('draft'), 'ЧЕРНОВИК')
  assert.equal(stateWord('finished'), 'ЗАВЕРШЕНО')
})

test('running and queued submissions live in the queue block, not in the feed', () => {
  assert.equal(inFlight('queued'), true)
  assert.equal(inFlight('running'), true)
  assert.equal(inFlight('scored'), false)
  assert.equal(inFlight('metricFailed'), false)
})

/* ----------------------------------------------------------- participants */

test('a new key changes the key in the Participants row, and keeps its place and submissions', () => {
  const person: EntrantRow = {
    id: 'e1', name: '@lost_key', createdAt: 1, lastSeenAt: 5, disabled: true,
    key: 'K7Q-M2X-9FD', submissions: 7, place: 3, baseline: false,
  }
  // What the rotate door answers: the instance-wide row, with no place and no
  // count for this competition, and the key turned back on.
  const answer = { entrant: { ...person, disabled: false, submissions: 0, place: null }, key: 'A2B-C3D-4EF' }
  assert.deepEqual(withNewKey(person, answer), { ...person, key: 'A2B-C3D-4EF', disabled: false })
})

/* --------------------------------------------------------------- language */

test('the limits block says only a score spends one, and names the ceiling apart', () => {
  // Since 4 Oct 2026 failures are free: the teacher's form says so in three
  // columns the way the send box does, and names the separate ceiling on
  // failed ones with the very formula the server counts by.
  assert.equal(tr('admin.competitions.rule.spendsText'), 'Только посылка, получившая число.')
  assert.match(tr('admin.competitions.rule.holdsText'), /Упадёт — место вернётся/)
  assert.match(tr('admin.competitions.rule.freeText'), /вышло время, не хватило памяти, ответ не принят/)
  assert.match(tr('admin.competitions.rule.freeText'), /сбой метрики или сервера/)
  assert.match(tr('admin.competitions.ceiling.text', { perDay: 5 }), /max\(10, 3 × 5\)/)
  assert.match(tr('admin.competitions.ceiling.text', { perDay: 5 }), /Сбои метрики и сервера в него не считаются/)
  assert.match(tr('admin.competitions.ceiling.hit'), /Лимит посылок при этом не тронут/)
  setLocaleResolver(() => 'en')
  assert.equal(tr('admin.competitions.rule.spendsText'), 'Only a submission that gets a score.')
  assert.match(tr('admin.competitions.ceiling.text', { perDay: 5 }), /max\(10, 3 × 5\)/)
  assert.doesNotMatch(tr('admin.competitions.rule.freeText'), /[а-яА-Я]/)
})

test('the late strip answers taken, cost and standing, with the limit spelled for the day', () => {
  assert.match(tr('admin.competitions.late.acceptedText'), /после «Завершить сейчас»/)
  assert.equal(
    tr('admin.competitions.late.sameLimitText', { count: 5 }),
    '5 посылок с числом в день на участника, вместе с обычными. Неудачи и тут бесплатны.',
  )
  assert.match(tr('admin.competitions.late.sameLimitText', { count: 2 }), /^2 посылки с числом/)
  assert.match(tr('admin.competitions.late.sameLimitText', { count: 1 }), /^1 посылка с числом/)
  assert.match(tr('admin.competitions.late.outsideText'), /Не идут в места, лидерборд, зачёт, сводку и ожидание итогов/)
  // The deadline move frees late work, and only one way: the screen says both halves.
  assert.match(tr('admin.competitions.late.moveNote'), /перестанут быть поздними/)
  assert.match(tr('admin.competitions.late.moveNote'), /никого задним числом поздним не сделает/)
  setLocaleResolver(() => 'en')
  assert.equal(
    tr('admin.competitions.late.sameLimitText', { count: 1 }),
    '1 scored submission a day per participant, shared with the on-time ones. Failures are free here too.',
  )
})

/* ------------------------------------------------------- late and hidden */

test('under each row: what the submission did to its author\'s limit, by the server\'s rule', () => {
  const note = (over: Partial<Submission>, perDay = 5, extra: Partial<SubmissionRow> = {}) =>
    limitNote(feedRow(over, extra), perDay)
  assert.deepEqual(note({ state: 'scored' }), { text: 'в счёт лимита', tone: 'muted' })
  for (const state of ['notebookFailed', 'timedOut', 'outOfMemory', 'rejected', 'cancelled'] as const) {
    assert.deepEqual(note({ state, publicScore: null }), { text: 'лимит не потрачен', tone: 'positive' }, state)
  }
  // The teacher's metric is never the participant's doing: not toward the ceiling either.
  assert.deepEqual(note({ state: 'metricFailed' }), {
    text: 'лимит не потрачен · в потолок неудач не идёт',
    tone: 'positive',
  })
  // In flight it holds a place, and gives it back if it fails.
  assert.deepEqual(note({ state: 'queued' }), { text: 'держит место в лимите', tone: 'muted' })
  assert.deepEqual(note({ state: 'running' }), { text: 'держит место в лимите', tone: 'muted' })
  // A late score spends the same limit and says it is outside the standings.
  assert.deepEqual(note({ state: 'scored', late: true }), {
    text: 'в места и итоги не идёт · в счёт лимита',
    tone: 'muted',
  })
  // With the limit off there is nothing to spend; only the late note stays.
  assert.equal(note({ state: 'notebookFailed' }, 0), null)
  assert.deepEqual(note({ state: 'scored', late: true }, 0), { text: 'в места и итоги не идёт', tone: 'muted' })
  // The baseline is the teacher's, and has no limit.
  assert.equal(note({ state: 'notebookFailed' }, 5, { baseline: true }), null)
})

test('a late score is "not counted" before it is anything else', () => {
  assert.equal(outcomeLine(feedRow({ state: 'scored', late: true }), true), 'вне зачёта')
  assert.equal(outcomeLine(feedRow({ state: 'scored', late: true, chosen: true }), false), 'вне зачёта')
  setLocaleResolver(() => 'en')
  assert.equal(outcomeLine(feedRow({ state: 'scored', late: true }), false), 'not counted')
})

test('a failure on the hidden test is summed up in the column, and its full text goes in the box', () => {
  const trace = "ячейка 9, строка 3:  X['t_door'] = X['t_door'].astype(float)\nValueError: could not convert string to float: 'н/д'"
  const sealed = feedRow({
    state: 'notebookFailed',
    cellsDone: 9,
    publicScore: null,
    sealedInputs: true,
    errorType: 'ValueError',
    participantError: trace,
    briefError: 'Тетрадь упала на ячейке 9 из 16: ValueError.',
  })
  assert.equal(outcomeLine(sealed, false), 'ячейка 9 · ValueError')
  assert.equal(sealedErrorBox(sealed), trace, 'the teacher always reads the whole text')
  const untyped = feedRow({ ...sealed.submission, errorType: null })
  assert.equal(outcomeLine(untyped, false), 'ячейка 9')
  // A one-line refusal is already the column: no box repeating it.
  const rejected = feedRow({ state: 'rejected', sealedInputs: true, participantError: 'В ответе 1 990 строк вместо 2 000' })
  assert.equal(outcomeLine(rejected, false), 'В ответе 1 990 строк вместо 2 000')
  assert.equal(sealedErrorBox(rejected), null)
  // Without the hidden test nothing changes: the text is the column.
  const open = feedRow({ state: 'notebookFailed', cellsDone: 9, participantError: 'KeyError: id', errorType: 'KeyError' })
  assert.equal(outcomeLine(open, false), 'KeyError: id')
  assert.equal(sealedErrorBox(open), null)
})

test('the deadline rule sits under the late rows, judged by when the upload began', () => {
  const deadline = 10 * HOUR
  const rows = [
    feedRow({ id: 'l2', late: true, acceptedAt: deadline + 2 * HOUR, sentAt: deadline + 2 * HOUR }),
    feedRow({ id: 'l1', late: true, acceptedAt: deadline + HOUR, sentAt: deadline + HOUR }),
    // Began at 23:59:50, arrived within the grace: on time, and under the rule.
    feedRow({ id: 'g', late: false, acceptedAt: deadline + 40_000, sentAt: deadline - 10_000 }),
    feedRow({ id: 'o', late: false, acceptedAt: deadline - HOUR, sentAt: deadline - HOUR }),
  ]
  assert.equal(deadlineDividerAt(rows, deadline), 2)
  // Nothing late above: no rule, however the dates fall.
  assert.equal(deadlineDividerAt(rows.slice(2), deadline), -1)
  assert.equal(deadlineDividerAt(rows, null), -1)
  // Only late rows: nothing under the rule to separate them from.
  assert.equal(deadlineDividerAt(rows.slice(0, 2), deadline), -1)
  // Rows from before the column existed are judged by when they arrived.
  assert.equal(deadlineDividerAt([rows[0], feedRow({ id: 'old', acceptedAt: deadline - 1 })], deadline), 1)
})

test('the late switch asks the feed door for exactly one side', () => {
  assert.equal(lateQuery('late'), '1')
  assert.equal(lateQuery('onTime'), '0')
  assert.equal(lateQuery('all'), undefined)
})

function file(over: Partial<SealedFileView>): SealedFileView {
  return {
    competitionId: 'k1',
    name: 'test.csv',
    bytes: 319_488,
    rows: 2000,
    visibility: 'sealed',
    uploadedAt: 0,
    columns: ['id', 'feature'],
    replaces: 'test.csv',
    ...over,
  }
}

test('the hidden test is named by its path in data/, typed however the notebook reads it', () => {
  assert.equal(sealedTarget('data/test.csv'), 'test.csv')
  assert.equal(sealedTarget(' /data/test.csv '), 'test.csv')
  assert.equal(sealedTarget('test_full.csv'), 'test_full.csv')
  assert.equal(sealedTarget(''), '')
})

test('"what is at this path" pairs the example the class downloads with the file the check reads', () => {
  const example: FileView = { ...file({}), visibility: 'open', rows: 200, bytes: 31_000 }
  const sealed = file({})
  const view = { openFiles: [example], sealedFiles: [sealed] }
  // An empty field shows the first hidden file.
  assert.deepEqual(sealedPath(view, ''), { name: 'test.csv', open: example, sealed })
  assert.deepEqual(sealedPath(view, 'data/test.csv'), { name: 'test.csv', open: example, sealed })
  // A name not uploaded yet: the example is still what the check reads.
  assert.deepEqual(sealedPath(view, 'images.zip'), { name: 'images.zip', open: null, sealed: null })
  assert.equal(sealedPath({ openFiles: [example], sealedFiles: [] }, ''), null)
  assert.equal(sealedPath({ openFiles: [example] }, ''), null)
})

test('a hidden test with other columns than its example is caught before the class meets it', () => {
  const example: FileView = { ...file({}), visibility: 'open', rows: 200 }
  assert.deepEqual(columnsCheck(file({}), example), { same: true, count: 2 })
  assert.deepEqual(columnsCheck(file({ columns: ['id', 'feature', 'target'] }), example), {
    same: false,
    sealed: 'id, feature, target',
    open: 'id, feature',
  })
  // Order matters: notebooks read columns by position as often as by name.
  assert.equal(columnsCheck(file({ columns: ['feature', 'id'] }), example)?.same, false)
  assert.equal(columnsCheck(file({}), null), null)
  assert.equal(columnsCheck(file({ columns: null }), example), null)
})

test("a row's menu is named by what each item does, and the note under the feed names all of it", () => {
  const items = ['notebook', 'output', 'rerun', 'rescore', 'drop'].map((item) => `admin.competitions.menu.${item}`)
  let locale: 'ru' | 'en' = 'ru'
  setLocaleResolver(() => locale)
  // The Russian is the mockup's, proofread by the owner: it stays.
  assert.equal(tr('admin.competitions.menu.drop'), 'Не засчитывать')
  const note = (): string => tr('admin.competitions.feedNote').toLowerCase()
  for (const key of items) assert.ok(note().includes(tr(key).toLowerCase()), `ru: the note misses ${key}`)
  locale = 'en'
  // Dropping cancels the submission for good, and the entrant reads that it
  // was dropped from the standings: the teacher's item says the same.
  assert.equal(tr('admin.competitions.menu.drop'), 'Drop from the standings')
  assert.match(tr('competitions.note.droppedByTeacher'), /dropped this submission from the standings/)
  for (const key of items) assert.ok(note().includes(tr(key).toLowerCase()), `en: the note misses ${key}`)
})

test('the tab speaks the instance language, and in English it is a translation', () => {
  let locale: 'ru' | 'en' = 'en'
  setLocaleResolver(() => locale)
  assert.equal(leftWords(6 * DAY + 4 * HOUR), '6 d 4 h')
  assert.equal(spanWords(160_000), '2 min 40 s')
  assert.equal(etaWords(null), 'unknown')
  assert.equal(stateWord('live'), 'LIVE')
  assert.match(metricLine(row(), 0), /lower is better · public part 30%/)
  assert.deepEqual(baselineNote(row({ baselineState: 'metricFailed' })), {
    text: 'baseline: metric error',
    bad: true,
  })
  const line = runnerLine(queue({ running: [{} as never], waiting: 2 }))
  assert.equal(line.head, 'running 1 submission · 2 waiting')
  assert.match(line.tail, /^one at a time · no network · 37 run today/)
  // There is no transliteration here and must not be: a badge "UPALA TETRAD"
  // is worse than no translation.
  assert.doesNotMatch(line.tail, /[а-яА-Я]/)
  locale = 'ru'
  assert.equal(leftWords(6 * DAY + 4 * HOUR), '6 дн 4 ч')
})
