/**
 * Решения вкладки «Соревнования» — те, что принимает браузер.
 *
 * Без браузера и без Svelte: всё, у чего есть правильный и неправильный
 * ответ, живёт в `web/src/admin/competitions.ts` ровно затем, чтобы
 * проверяться отсюда. Проверяются не «функция вернула строку», а частные
 * случаи, на которых экран начинает врать: метрика в другом масштабе,
 * дедлайн, который вот-вот, заготовка поверх чужого кода, лидерборд из
 * ленты, в которой есть базовое решение.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.js'
import {
  METRIC_PRESETS,
  answerColumns,
  applyPreset,
  baselineNote,
  boardFromFeed,
  clock,
  deadlineLine,
  etaWords,
  feedWhen,
  inFlight,
  isUntouchedPreset,
  leftWords,
  metricLine,
  metricNumber,
  moment,
  outcomeLine,
  presetCode,
  refusalSection,
  refusalText,
  runnerLine,
  sinceWords,
  spanWords,
  stateTone,
  stateWord,
  worstCell,
} from '../web/src/admin/competitions.js'
import type { Competition, Submission } from '../shared/competitions.js'
import type {
  CompetitionRow,
  OpenRefusal,
  QueueSnapshot,
  SubmissionRow,
} from '../shared/competitions-api.js'

afterEach(() => setLocaleResolver(() => 'ru'))

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Соревнование-заготовка: тесты меняют в нём одно поле за раз. */
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

/* ------------------------------------------------------------------ числа */

test('метрика печатается так, чтобы разные числа выглядели по-разному', () => {
  assert.equal(metricNumber(0.0412), '0.0412')
  // Столько же знаков у одинаковых по смыслу чисел — колонка читается в столбик.
  assert.equal(metricNumber(0.7034), '0.7034')
  // Крупное число теряет знаки, а не колонку: 96 пикселей моноширинного не
  // держат «1234.5678».
  assert.equal(metricNumber(1234.5678), '1234.6')
  assert.equal(metricNumber(12.3456789), '12.346')
  // Мелкое уходит в экспоненту, а не в «0.0000» у всех подряд: лидерборд, где
  // первые десять мест одинаковы, — это лидерборд без мест.
  assert.equal(metricNumber(0.00005), '5.00e-5')
  assert.equal(metricNumber(1.5e7), '1.50e+7')
  assert.equal(metricNumber(0), '0.0000')
  assert.equal(metricNumber(-0.25), '-0.2500')
})

test('чего нет — прочерк, а не ноль', () => {
  assert.equal(metricNumber(null), '—')
  assert.equal(metricNumber(undefined), '—')
  assert.equal(metricNumber(Number.NaN), '—')
  assert.equal(metricNumber(Number.POSITIVE_INFINITY), '—')
})

test('длительность словами: секунды у коротких, часы у длинных', () => {
  assert.equal(spanWords(160_000), '2 мин 40 с')
  assert.equal(spanWords(108_000), '1 мин 48 с')
  assert.equal(spanWords(41_000), '41 с')
  assert.equal(spanWords(2 * HOUR + 12 * MINUTE), '2 ч 12 мин')
  assert.equal(spanWords(null), '—')
})

test('секундомер прогона сравнивается взглядом, а не чтением', () => {
  // Ведущий ноль — только там, где рядом стоит предел: «01:12 из 10:00».
  assert.equal(clock(72_000, true), '01:12')
  assert.equal(clock(600_000, true), '10:00')
  // В колонке «ШЛА» он лишний — так нарисовано в макете.
  assert.equal(clock(185_000), '3:05')
  assert.equal(clock(41_000), '0:41')
  assert.equal(clock(3 * HOUR + 5_000), '3:00:05')
  assert.equal(clock(null), '—')
})

test('сколько осталось — две единицы, никогда три', () => {
  assert.equal(leftWords(6 * DAY + 4 * HOUR + 17 * MINUTE), '6 дн 4 ч')
  assert.equal(leftWords(6 * DAY), '6 дн')
  assert.equal(leftWords(HOUR + 12 * MINUTE), '1 ч 12 мин')
  assert.equal(leftWords(40 * MINUTE), '40 мин')
  assert.equal(leftWords(30_000), '30 с')
  assert.equal(leftWords(0), 'срок вышел')
  assert.equal(leftWords(-1), 'срок вышел')
})

test('сколько прошло — шкала доведена до месяцев: список живёт семестр', () => {
  const now = Date.UTC(2026, 8, 20, 12)
  assert.equal(sinceWords(now - 30_000, now), 'только что')
  assert.equal(sinceWords(now - 5 * MINUTE, now), '5 мин назад')
  assert.equal(sinceWords(now - 5 * HOUR, now), '5 ч назад')
  assert.equal(sinceWords(now - DAY, now), 'вчера')
  assert.equal(sinceWords(now - 3 * DAY, now), '3 дн назад')
  // «7 дн назад» — число, которое никто не переводит в недели в уме.
  assert.equal(sinceWords(now - 7 * DAY, now), 'неделю назад')
  assert.equal(sinceWords(now - 14 * DAY, now), '2 недели назад')
  assert.equal(sinceWords(now - 60 * DAY, now), '2 месяца назад')
})

/* ---------------------------------------------------------------- дедлайн */

test('дедлайн горит за полсуток и молчит за неделю', () => {
  const now = Date.UTC(2026, 8, 20, 12)
  const far = deadlineLine(competition({ deadlineAt: now + 6 * DAY + 4 * HOUR }), now)
  assert.equal(far.note, 'осталось 6 дн 4 ч')
  assert.equal(far.hot, false)
  const soon = deadlineLine(competition({ deadlineAt: now + HOUR + 12 * MINUTE }), now)
  assert.equal(soon.note, 'осталось 1 ч 12 мин')
  assert.equal(soon.hot, true)
})

test('у черновика на месте срока — что с ним будет дальше', () => {
  const now = Date.UTC(2026, 8, 20, 12)
  const waiting = deadlineLine(competition({ state: 'draft', deadlineAt: null }), now, 'noBaseline')
  assert.equal(waiting.when, 'не назначен')
  assert.equal(waiting.note, 'откроется после проверки')
  const ready = deadlineLine(competition({ state: 'draft', deadlineAt: null }), now, null)
  assert.equal(ready.note, 'готово к открытию')
})

test('у завершённого — сколько прошло, и гореть ему нечем', () => {
  const now = Date.UTC(2026, 8, 20, 12)
  const done = deadlineLine(competition({ state: 'finished', deadlineAt: now - 7 * DAY }), now)
  assert.equal(done.note, 'неделю назад')
  assert.equal(done.hot, false)
  // Идущее, у которого срок уже вышел, говорит то же самое: приём закрыт,
  // и «осталось −3 ч» — это не число, а обвинение.
  const late = deadlineLine(competition({ deadlineAt: now - 2 * HOUR }), now)
  assert.equal(late.note, '2 ч назад')
  assert.equal(late.hot, false)
})

test('в колонке «КОГДА» время у сегодняшней строки и дата у вчерашней', () => {
  const now = new Date(2026, 8, 20, 18, 58).getTime()
  assert.match(feedWhen(now, now), /^\d{2}:\d{2}$/)
  assert.match(feedWhen(now - 7 * DAY, now), /^\d{2}\.\d{2}$/)
  // «сегодня, 21:00» — форма шапки, а не колонки: там место есть.
  assert.match(moment(now, now), /^сегодня, \d{2}:\d{2}$/)
})

/* -------------------------------------------------------------- строки A1 */

test('вторая строка названия отвечает на «что с ним сейчас не так»', () => {
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

test('под лучшим результатом стоит бейзлайн — и его беда, если она есть', () => {
  assert.deepEqual(baselineNote(row()), { text: 'бейзлайн 0.0587', bad: false })
  assert.deepEqual(baselineNote(row({ baselineState: null })), {
    text: 'бейзлайн не проверяли',
    bad: false,
  })
  // Упавшая метрика — вина преподавателя, и она названа отдельно от «не дошёл».
  assert.deepEqual(baselineNote(row({ baselineState: 'metricFailed' })), {
    text: 'бейзлайн: ошибка метрики',
    bad: true,
  })
  assert.equal(baselineNote(row({ baselineState: 'notebookFailed' })).bad, true)
})

/* ------------------------------------------------------ полоса исполнителя */

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

test('полоса исполнителя говорит, что идёт и на каких условиях', () => {
  const line = runnerLine(
    queue({
      running: [{} as never],
      waiting: 2,
    }),
  )
  assert.equal(line.head, 'исполняет 1 посылку · 2 ждут')
  assert.equal(line.tail, 'по одной за раз · без сети · сегодня исполнено 37, в среднем 2 мин 40 с')
})

test('приостановленная очередь названа словом: от пустой её не отличить иначе', () => {
  const line = runnerLine(queue({ paused: true }))
  assert.equal(line.head, 'очередь приостановлена · ничего не исполняется')
})

test('без среднего — без обещания', () => {
  const line = runnerLine(queue({ averageMs: null, doneToday: 0 }))
  assert.match(line.tail, /сегодня исполнено 0$/)
})

test('оценка ожидания: «≈ 0 мин» — обещание, и его не бывает', () => {
  assert.equal(etaWords(3 * MINUTE), '≈ 3 мин')
  assert.equal(etaWords(20_000), 'вот-вот')
  assert.equal(etaWords(null), 'неизвестно')
})

/* ------------------------------------------------------------------ гейт */

test('каждый отказ открыть указывает на свою секцию формы', () => {
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
    // Фраза — та же, которой отказывает дверь: свой пересказ разошёлся бы с ней.
    assert.notEqual(refusalText(refusal as OpenRefusal), `competitions.refusal.open.${refusal}`)
  }
})

/* -------------------------------------------------------- заготовки метрики */

test('колонки заготовки берутся из шапки ответов, а Usage — не предсказание', () => {
  assert.deepEqual(answerColumns(['id', 'orders']), { id: 'id', target: 'orders' })
  // Usage размечает деление строк и лежит рядом с целевой (shared · splitByUsage).
  assert.deepEqual(answerColumns(['row_id', 'Usage', 'target']), {
    id: 'row_id',
    target: 'target',
  })
  assert.deepEqual(answerColumns(null), { id: 'id', target: 'target' })
  assert.deepEqual(answerColumns([]), { id: 'id', target: 'target' })
})

test('заготовка написана про настоящие колонки этого соревнования', () => {
  const code = presetCode('MAPE', { id: 'id', target: 'orders' })
  assert.match(code, /def score\(solution: pd\.DataFrame, submission: pd\.DataFrame\) -> float:/)
  assert.match(code, /!= \["id", "orders"\]/)
  assert.match(code, /merged\["orders_pred"\]/)
  // Подставленный `target` там, где в ответах написано `orders`, падает на
  // первой же проверке — с трейсом, который читают как ошибку продукта.
  assert.doesNotMatch(code, /"target"/)
})

test('у каждой заготовки свой код и своё направление', () => {
  const columns = { id: 'id', target: 'y' }
  const codes = METRIC_PRESETS.map((preset) => presetCode(preset.name, columns))
  assert.equal(new Set(codes).size, METRIC_PRESETS.length)
  assert.equal(METRIC_PRESETS.find((p) => p.name === 'MAPE')?.direction, 'lower')
  assert.equal(METRIC_PRESETS.find((p) => p.name === 'ROC AUC')?.direction, 'higher')
  // Кому нужен sklearn — тот его и просит; numpy у чистой арифметики.
  assert.match(presetCode('QWK', columns), /from sklearn\.metrics import cohen_kappa_score/)
  assert.match(presetCode('RMSE', columns), /np\.sqrt/)
})

test('чип заготовки не стирает написанное руками', () => {
  const columns = { id: 'id', target: 'orders' }
  const mine = 'def score(solution, submission):\n    return 0.0\n'
  const after = applyPreset({ name: 'MAPE', direction: 'lower', code: mine }, 'ROC AUC', columns)
  // Имя и направление меняются всегда — за этим чип и нажимают.
  assert.equal(after.name, 'ROC AUC')
  assert.equal(after.direction, 'higher')
  // А полчаса работы над своей метрикой назад не вернёшь.
  assert.equal(after.code, mine)
})

test('поверх пустого места и поверх нетронутой заготовки код подставляется', () => {
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

test('незнакомое имя чипа не меняет ничего', () => {
  const columns = { id: 'id', target: 'orders' }
  const before = { name: 'MAPE', direction: 'lower' as const, code: 'x' }
  assert.deepEqual(applyPreset(before, 'LogLoss', columns), before)
})

test('«это ещё заготовка» — про код, а не про имя', () => {
  const columns = { id: 'id', target: 'orders' }
  assert.equal(isUntouchedPreset(presetCode('QWK', columns), columns), true)
  assert.equal(isUntouchedPreset(`${presetCode('QWK', columns)}\n# моё\n`, columns), false)
  assert.equal(isUntouchedPreset('', columns), false)
  // Те же колонки, но другие: код под чужую шапку уже не заготовка этой.
  assert.equal(isUntouchedPreset(presetCode('QWK', columns), { id: 'id', target: 'y' }), false)
})

/* ---------------------------------------------------------------- сводка A3 */

test('ячейка, на которой спотыкается класс, — это про задачу, а не про людей', () => {
  const rows = [
    feedRow({ id: 'a', state: 'notebookFailed', cellsDone: 7 }),
    feedRow({ id: 'b', state: 'notebookFailed', cellsDone: 7 }),
    feedRow({ id: 'c', state: 'notebookFailed', cellsDone: 7 }),
    feedRow({ id: 'd', state: 'notebookFailed', cellsDone: 12 }),
    feedRow({ id: 'e', state: 'scored', cellsDone: 14 }),
  ]
  assert.deepEqual(worstCell(rows), { cell: 7, hits: 3, total: 4 })
})

test('одно-два падения закономерностью не объявляются', () => {
  const rows = [
    feedRow({ id: 'a', state: 'notebookFailed', cellsDone: 7 }),
    feedRow({ id: 'b', state: 'notebookFailed', cellsDone: 3 }),
  ]
  assert.equal(worstCell(rows), null)
  assert.equal(worstCell([]), null)
})

test('базовое решение в статистику падений не идёт: это не класс', () => {
  const rows = [
    feedRow({ id: 'a', state: 'notebookFailed', cellsDone: 7 }, { baseline: true }),
    feedRow({ id: 'b', state: 'notebookFailed', cellsDone: 7 }, { baseline: true }),
    feedRow({ id: 'c', state: 'notebookFailed', cellsDone: 7 }, { baseline: true }),
  ]
  assert.equal(worstCell(rows), null)
})

test('тетрадь, не дошедшая до первой ячейки, ни на что не указывает', () => {
  const rows = [
    feedRow({ id: 'a', state: 'notebookFailed', cellsDone: 0 }),
    feedRow({ id: 'b', state: 'notebookFailed', cellsDone: 0 }),
    feedRow({ id: 'c', state: 'notebookFailed', cellsDone: 0 }),
  ]
  assert.equal(worstCell(rows), null)
})

/* ------------------------------------------------------- лидерборд из ленты */

test('лидерборд считается тем же правилом, что у сервера, и без бейзлайна', () => {
  const rows = [
    feedRow({ id: 's1', entrantId: 'a', publicScore: 0.05, privateScore: 0.051, acceptedAt: 1 }),
    feedRow({ id: 's2', entrantId: 'a', publicScore: 0.04, privateScore: 0.061, acceptedAt: 2 }),
    feedRow({ id: 's3', entrantId: 'b', publicScore: 0.045, privateScore: 0.044, acceptedAt: 3 }),
    feedRow({ id: 's9', entrantId: 'z', publicScore: 0.001, privateScore: 0.001 }, { baseline: true }),
  ]
  const c = competition()
  const board = boardFromFeed(rows, c, 'public')
  // Базовое решение не участник, и места ему не полагается.
  assert.deepEqual(
    board.map((r) => r.entrantId),
    ['a', 'b'],
  )
  assert.equal(board[0].score, 0.04)
  // Приватная таблица берёт ТУ ЖЕ посылку, что и публичная: правило зачёта
  // выбирает по тому, что участник видел.
  const priv = boardFromFeed(rows, c, 'private')
  assert.equal(priv.find((r) => r.entrantId === 'a')?.score, 0.061)
  assert.equal(priv[0].entrantId, 'b')
})

test('выбранная автором посылка бьёт лучшую по публичной', () => {
  const rows = [
    feedRow({ id: 's1', entrantId: 'a', publicScore: 0.05, acceptedAt: 1, chosen: true }),
    feedRow({ id: 's2', entrantId: 'a', publicScore: 0.04, acceptedAt: 2 }),
  ]
  assert.equal(boardFromFeed(rows, competition(), 'public')[0].score, 0.05)
  // А по правилу «лучшая по публичной» выбор автора не спрашивают.
  assert.equal(
    boardFromFeed(rows, competition({ scoring: 'bestPublic' }), 'public')[0].score,
    0.04,
  )
})

test('в лидерборд идёт только дошедшее до числа', () => {
  const rows = [
    feedRow({ id: 's1', entrantId: 'a', state: 'notebookFailed', publicScore: null }),
    feedRow({ id: 's2', entrantId: 'b', state: 'rejected', publicScore: null }),
  ]
  assert.deepEqual(boardFromFeed(rows, competition(), 'public'), [])
})

/* ----------------------------------------------------------------- слова */

test('колонка «ЧТО СЛУЧИЛОСЬ» говорит про посылку, а не про проверку', () => {
  assert.equal(
    outcomeLine(feedRow({ state: 'scored' }), true),
    'новый лучший результат соревнования',
  )
  assert.equal(outcomeLine(feedRow({ state: 'scored', chosen: true }), false), 'выбрана автором в зачёт')
  assert.equal(outcomeLine(feedRow({ state: 'scored' }), false), '')
  assert.match(outcomeLine(feedRow({ state: 'metricFailed' }), false), /Ошибка в вашем коде/)
  // Текст участника читается дословно: это то, что он и увидит.
  assert.equal(
    outcomeLine(feedRow({ state: 'rejected', participantError: 'Нет колонки id' }), false),
    'Нет колонки id',
  )
  assert.equal(
    outcomeLine(feedRow({ state: 'notebookFailed', cellsDone: 7, participantError: null }), false),
    'ячейка 7',
  )
})

test('тон плашки соревнования — по таблице макета', () => {
  assert.equal(stateTone('live'), 'accent')
  assert.equal(stateTone('draft'), 'warning')
  assert.equal(stateTone('finished'), 'neutral')
  assert.equal(stateWord('live'), 'ИДЁТ')
  assert.equal(stateWord('draft'), 'ЧЕРНОВИК')
  assert.equal(stateWord('finished'), 'ЗАВЕРШЕНО')
})

test('идущая и стоящая в очереди живут в блоке очереди, а не в ленте', () => {
  assert.equal(inFlight('queued'), true)
  assert.equal(inFlight('running'), true)
  assert.equal(inFlight('scored'), false)
  assert.equal(inFlight('metricFailed'), false)
})

/* ------------------------------------------------------------------- язык */

test('вкладка говорит на языке инстанса, и по-английски — переводом', () => {
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
  // Транслитерации здесь нет и быть не должно: плашка «UPALA TETRAD» хуже
  // отсутствия перевода.
  assert.doesNotMatch(line.tail, /[а-яА-Я]/)
  locale = 'ru'
  assert.equal(leftWords(6 * DAY + 4 * HOUR), '6 дн 4 ч')
})
