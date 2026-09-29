/**
 * Words and numbers of the entrant pages (P1–P4), without a browser.
 *
 * Everything checked here looks equally plausible on screen whatever the
 * answer: "0.046" instead of "0.0455" is a different place on the
 * leaderboard, "1 h" instead of "1 h 12 min" is a missed deadline, a green
 * stage instead of the current one is "where is it stuck?" instead of "it is
 * running". None of that can be caught by eye, so every rule gets a line of
 * its own.
 *
 * English is checked on a par with Russian: the catalog must carry both
 * sides, and `{count}` picks the form by different rules in the two
 * languages.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readCompetitionRoute } from '../web/src/lib/routes.js'
import { setLocaleResolver, tr } from '../shared/i18n.js'
import type { EntrantSubmission } from '../shared/competitions.js'
import type { SubmissionLive } from '../shared/competitions-entrant.js'
import {
  avatarLetter,
  avatarTint,
  AVATAR_TINTS,
  boardPlaces,
  clockOf,
  clockStep,
  dateOf,
  deadlineNote,
  deadlineUrgent,
  elapsedClock,
  fileSize,
  formatScore,
  lastScoringNote,
  metricArrow,
  ordinalPlace,
  outsideQuota,
  ownOrdinals,
  placeWithScore,
  queueNote,
  queueOrdinal,
  remainingClock,
  remainingWords,
  rowWords,
  runProgress,
  sameDay,
  scoreWithPlace,
  shortName,
  spellDuration,
  splitError,
  stageStrip,
  submissionOrdinal,
  URGENT_MS,
  whenWords,
} from '../web/src/lib/competition-words.js'

afterEach(() => setLocaleResolver(() => 'ru'))

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 20 September, 18:40 on the reader's clock: the time of every caption below. */
const NOW = new Date(2026, 8, 20, 18, 40, 0).getTime()

function submission(patch: Partial<EntrantSubmission> = {}): EntrantSubmission {
  return {
    id: 's1',
    competitionId: 'c1',
    entrantId: 'e1',
    number: 12,
    fileName: 'lgbm_lags_v3.ipynb',
    bytes: 4096,
    acceptedAt: NOW - 3 * MINUTE,
    state: 'scored',
    stage: 'score',
    publicScore: 0.0455,
    privateScore: null,
    durationMs: 171_000,
    cellsDone: 14,
    cellsTotal: 14,
    participantError: null,
    chosen: false,
    ...patch,
  }
}

function live(patch: Partial<SubmissionLive> = {}): SubmissionLive {
  return {
    submissionId: 's1',
    place: null,
    etaMs: null,
    startedAt: null,
    limitMs: 600_000,
    aheadNumber: null,
    stage: 'notebook',
    cellsDone: 0,
    cellsTotal: 0,
    ...patch,
  }
}

/* ----------------------------------------------------------------- number */

test('the metric keeps significant digits, not a number of decimals', () => {
  assert.equal(formatScore(0.0455), '0.0455')
  assert.equal(formatScore(0.7034), '0.7034')
  // An RMSE in thousands of roubles: four decimals here are noise that breaks
  // the column.
  assert.equal(formatScore(1234.5), '1234.50')
  assert.equal(formatScore(-0.5), '-0.5000')
  assert.equal(formatScore(0), '0.0000')
  // Millionths and millions go exponential: otherwise they are "0.0000" and
  // "1200000.00".
  assert.equal(formatScore(0.0000012), '1.20e-6')
  assert.equal(formatScore(2_500_000), '2.50e+6')
  // A number that does not exist must not be shown: a metric that divided by
  // zero did not crash.
  assert.equal(formatScore(Number.NaN), '—')
  assert.equal(formatScore(Number.POSITIVE_INFINITY), '—')
  assert.equal(formatScore(null), '—')
  assert.equal(formatScore(undefined), '—')
})

test('a place is an ordinal, and in English by its own rules', () => {
  assert.equal(ordinalPlace(7), '7-й')
  assert.equal(ordinalPlace(11), '11-й')
  assert.equal(scoreWithPlace(0.0412, 1), '0.0412 · 1-й')
  assert.equal(scoreWithPlace(0.0412, null), '0.0412')
  // On P1 the order is reversed: a person looks for their PLACE on the card,
  // not the score.
  assert.equal(placeWithScore(7, 0.0455), '7-й · 0.0455')
  assert.equal(placeWithScore(null, 0.0455), '0.0455')
  setLocaleResolver(() => 'en')
  assert.equal(ordinalPlace(1), '1st')
  assert.equal(ordinalPlace(2), '2nd')
  assert.equal(ordinalPlace(3), '3rd')
  assert.equal(ordinalPlace(4), '4th')
  assert.equal(ordinalPlace(11), '11th')
  assert.equal(ordinalPlace(12), '12th')
  assert.equal(ordinalPlace(13), '13th')
  assert.equal(ordinalPlace(21), '21st')
})

test('the arrow on a metric is a direction sign, not a translation', () => {
  assert.equal(metricArrow('MAPE', 'lower'), 'MAPE ↓')
  assert.equal(metricArrow('ROC AUC', 'higher'), 'ROC AUC ↑')
  setLocaleResolver(() => 'en')
  assert.equal(metricArrow('MAPE', 'lower'), 'MAPE ↓')
})

/* ------------------------------------------------------------------- time */

test('a finished duration: seconds, minutes with seconds, hours without seconds', () => {
  assert.equal(spellDuration(41_000), '41 с')
  assert.equal(spellDuration(171_000), '2 мин 51 с')
  assert.equal(spellDuration(6 * MINUTE), '6 мин')
  assert.equal(spellDuration(HOUR + 12 * MINUTE + 3000), '1 ч 12 мин')
  assert.equal(spellDuration(null), '—')
  setLocaleResolver(() => 'en')
  assert.equal(spellDuration(171_000), '2 min 51 s')
})

test('time left until the deadline: two units in words and as a clock', () => {
  assert.equal(remainingWords(6 * DAY + 4 * HOUR + 12 * MINUTE), '6 дн 4 ч')
  assert.equal(remainingWords(HOUR + 12 * MINUTE), '1 ч 12 мин')
  assert.equal(remainingWords(12 * MINUTE), '12 мин')
  assert.equal(remainingWords(30_000), 'меньше минуты')
  assert.equal(remainingWords(0), 'приём закрыт')

  assert.equal(remainingClock(6 * DAY + 4 * HOUR + 12 * MINUTE), '6 дн 04:12:00')
  assert.equal(remainingClock(4 * HOUR + 12 * MINUTE), '4:12:00')
  assert.equal(remainingClock(-1), '00:00')
})

test('the countdown under an hour is minutes and seconds, from an hour up it gains hours', () => {
  // Eleven minutes once read "00:11", and the class took it for eleven seconds.
  assert.equal(remainingClock(11 * MINUTE), '11:00')
  assert.equal(remainingClock(10 * MINUTE + 52_000), '10:52')
  assert.equal(remainingClock(7 * MINUTE), '07:00')
  assert.equal(remainingClock(7_000), '00:07')
  assert.equal(remainingClock(HOUR + 5 * MINUTE), '1:05:00')
  assert.equal(remainingClock(HOUR), '1:00:00')
  assert.equal(remainingClock(HOUR - 1000), '59:59')
  // Rounded up: "00:00" is the deadline itself, not its last second.
  assert.equal(remainingClock(400), '00:01')
  assert.equal(remainingClock(59 * MINUTE + 59_500), '1:00:00')
  assert.equal(remainingClock(0), '00:00')
  setLocaleResolver(() => 'en')
  assert.equal(remainingClock(2 * DAY + 5 * MINUTE + 3000), '2 d 00:05:03')
  assert.equal(remainingClock(10 * MINUTE + 52_000), '10:52')
})

test('the page clock ticks every second while the header counts down, and in the last hour above all', () => {
  const deadline = NOW + 11 * MINUTE
  assert.equal(clockStep(false, deadline, NOW), 1000)
  assert.equal(clockStep(false, NOW + 3 * DAY, NOW), 1000, 'the countdown shows seconds at any distance')
  assert.equal(clockStep(true, null, NOW), 1000, "a run's stopwatch shows seconds too")
  // Nothing on screen moves by the second: no countdown, or it is over.
  assert.equal(clockStep(false, null, NOW), 30_000)
  assert.equal(clockStep(false, NOW - MINUTE, NOW), 30_000)
})

test("a run's stopwatch counts in minutes, and hours appear only when needed", () => {
  assert.equal(elapsedClock(72_000), '01:12')
  assert.equal(elapsedClock(600_000), '10:00')
  assert.equal(elapsedClock(0), '00:00')
  assert.equal(elapsedClock(3 * HOUR + 4 * MINUTE + 5000), '3:04:05')
})

test('the deadline lights up six hours ahead, and not a minute earlier', () => {
  assert.equal(deadlineUrgent(NOW + URGENT_MS - MINUTE, NOW), true)
  assert.equal(deadlineUrgent(NOW + URGENT_MS + MINUTE, NOW), false)
  // A passed deadline is not an alarm but a fact: it can no longer help
  // anyone.
  assert.equal(deadlineUrgent(NOW - MINUTE, NOW), false)
  assert.equal(deadlineUrgent(null, NOW), false)
})

test('the caption under the timer distinguishes "today" from a date', () => {
  const todayAt21 = new Date(2026, 8, 20, 21, 0).getTime()
  const later = new Date(2026, 8, 27, 23, 59).getTime()
  assert.equal(deadlineNote(todayAt21, NOW), `сегодня до ${clockOf(todayAt21)}`)
  assert.equal(deadlineNote(later, NOW), `до 27.09, ${clockOf(later)}`)
  assert.equal(deadlineNote(null, NOW), 'без дедлайна')
  assert.equal(deadlineNote(NOW - HOUR, NOW), 'приём закрыт')
  assert.equal(dateOf(later), '27.09')
})

test('"Today at 18:40", "Yesterday at 22:14", and a date before that', () => {
  const yesterday = new Date(2026, 8, 19, 22, 14).getTime()
  const older = new Date(2026, 8, 13, 20, 5).getTime()
  assert.equal(whenWords(NOW, NOW), `Сегодня в ${clockOf(NOW)}`)
  assert.equal(whenWords(yesterday, NOW), `Вчера в ${clockOf(yesterday)}`)
  assert.equal(whenWords(older, NOW), `13.09 в ${clockOf(older)}`)
  assert.equal(sameDay(NOW, NOW + MINUTE), true)
  assert.equal(sameDay(NOW, NOW + DAY), false)
})

/* -------------------------------------------------------------- stage strip */

test('the stage strip colours what is done, current and ahead', () => {
  const running = stageStrip('running', 'notebook')
  assert.deepEqual(
    running.map((cell) => cell.position),
    ['done', 'done', 'done', 'current', 'ahead', 'ahead'],
  )
  assert.deepEqual(running.map((cell) => cell.word), [
    'ПРИНЯТА',
    'ОЧЕРЕДЬ',
    'Установка пакетов',
    'ЗАПУСК ТЕТРАДИ',
    'ПРОВЕРКА CSV',
    'ОЦЕНКА',
  ])
  // One that reached a score is green all over: its "scoring" stage is done,
  // not running.
  assert.deepEqual(
    stageStrip('scored', 'score').map((cell) => cell.position),
    ['done', 'done', 'done', 'done', 'done', 'done'],
  )
  // A failed one keeps current the stage where it died: that is where the
  // reason is.
  assert.deepEqual(
    stageStrip('notebookFailed', 'notebook').map((cell) => cell.position),
    ['done', 'done', 'done', 'current', 'ahead', 'ahead'],
  )
})

test('the progress bar counts in cells, and without them in stages, but never shows zero', () => {
  assert.equal(runProgress(live({ cellsDone: 9, cellsTotal: 14 })), 63)
  assert.equal(runProgress(live({ cellsDone: 0, cellsTotal: 14 })), 5)
  assert.equal(runProgress(live({ cellsDone: 14, cellsTotal: 14 })), 95)
  // The number of cells is not known yet — the bar shows the stage, not zero:
  // zero under the word "RUNNING" reads as "stuck".
  assert.equal(runProgress(live({ stage: 'queue', cellsTotal: 0 })), 33)
  assert.equal(runProgress(live({ stage: 'score', cellsTotal: 0 })), 100)
})

/* ------------------------------------------------------------------ queue */

test('a queue place is a word up to the tenth and a number after that', () => {
  assert.equal(queueOrdinal(1), 'Первая')
  assert.equal(queueOrdinal(3), 'Третья')
  assert.equal(queueOrdinal(10), 'Десятая')
  assert.equal(queueOrdinal(11), '11-я')
  setLocaleResolver(() => 'en')
  assert.equal(queueOrdinal(3), 'Third')
  assert.equal(queueOrdinal(11), '11th')
})

test("a waiting submission's caption names only one's OWN submission ahead", () => {
  assert.equal(
    queueNote({ place: 3, aheadNumber: 12, paused: false }),
    'Третья в очереди · запуск после завершения посылки #12',
  )
  // The phone version is one word shorter — as in mockup P4.
  assert.equal(
    queueNote({ place: 3, aheadNumber: 12, paused: false, short: true }),
    'Третья в очереди · запуск после посылки #12',
  )
  // Other people's are ahead: their numbers are not shown to the entrant at
  // all.
  assert.equal(queueNote({ place: 3, aheadNumber: null, paused: false }), 'Третья в очереди')
  assert.equal(
    queueNote({ place: 1, aheadNumber: null, paused: true }),
    'Первая в очереди · очередь приостановлена преподавателем',
  )
})

/* ------------------------------------------------------ submission rows */

test("a refusal's first sentence goes into the title, the rest into the caption", () => {
  const { head, rest } = splitError(
    'Не для всех строк test.csv есть прогноз. В submission.csv 391 строка вместо 397. Добавьте недостающие прогнозы.',
  )
  assert.equal(head, 'Не для всех строк test.csv есть прогноз.')
  assert.equal(rest, 'В submission.csv 391 строка вместо 397. Добавьте недостающие прогнозы.')
  assert.deepEqual(splitError('Одна фраза без точки'), {
    head: 'Одна фраза без точки',
    rest: '',
  })
  assert.deepEqual(splitError(null), { head: '', rest: '' })
})

test('a running submission: the cell, the time sent and the wait in the queue', () => {
  const words = rowWords({
    submission: submission({ state: 'running', stage: 'notebook', cellsDone: 9, cellsTotal: 14, publicScore: null, durationMs: null }),
    live: live({ startedAt: NOW - 72_000, cellsDone: 9, cellsTotal: 14 }),
    best: false,
    paused: false,
    now: NOW,
  })
  assert.equal(words.title, 'lgbm_lags_v3.ipynb')
  assert.equal(
    words.lines[0],
    `Ячейка 9 из 14 · отправлена в ${clockOf(NOW - 3 * MINUTE)} · ожидание 1 мин 48 с`,
  )
})

test('a running submission on a phone: one sentence instead of the stage strip', () => {
  const words = rowWords({
    submission: submission({ state: 'running', cellsDone: 9, cellsTotal: 14 }),
    live: live({ startedAt: NOW - 72_000 }),
    best: false,
    paused: false,
    now: NOW,
    phone: true,
  })
  assert.deepEqual(words.lines, ['Выполняется ячейка 9 из 14'])
})

test('a lack of resources is explained on a waiting submission without a false time estimate', () => {
  const words = rowWords({
    submission: submission({ state: 'queued' }),
    live: live({ resourcePending: true, etaMs: 42_000 }),
    best: false,
    paused: false,
    now: NOW,
  })
  assert.equal(words.title, 'lgbm_lags_v3.ipynb')
  assert.match(words.lines.join(' '), /не хватает ресурсов/)
  assert.match(words.lines.join(' '), /очереди/)
})

test('a finished submission: the best one without the word "completed", the others with it', () => {
  const best = rowWords({ submission: submission(), live: null, best: true, paused: false, now: NOW })
  assert.equal(best.lines[0], `Сегодня в ${clockOf(NOW - 3 * MINUTE)} · 2 мин 51 с · лучший результат`)
  const plain = rowWords({
    submission: submission({ durationMs: 72_000 }),
    live: null,
    best: false,
    paused: false,
    now: NOW,
  })
  assert.equal(plain.lines[0], `Сегодня в ${clockOf(NOW - 3 * MINUTE)} · выполнена за 1 мин 12 с`)
  // The phone does not show the duration at all — as in mockup P4.
  const phone = rowWords({ submission: submission(), live: null, best: true, paused: false, now: NOW, phone: true })
  assert.equal(phone.lines[0], `Сегодня в ${clockOf(NOW - 3 * MINUTE)} · лучший результат`)
})

test('a failed notebook names the cell and the time, a rejected answer names the reason', () => {
  const failed = rowWords({
    submission: submission({
      state: 'notebookFailed',
      stage: 'notebook',
      cellsDone: 7,
      cellsTotal: 14,
      durationMs: 41_000,
      publicScore: null,
      fileName: 'lgbm_lags_v1.ipynb',
      participantError: "ячейка 7, строка 1\nKeyError: 'warehouse'",
    }),
    live: null,
    best: false,
    paused: false,
    now: NOW,
  })
  assert.equal(failed.title, 'lgbm_lags_v1.ipynb')
  assert.equal(
    failed.lines[0],
    `Сегодня в ${clockOf(NOW - 3 * MINUTE)} · ошибка в ячейке 7 из 14 через 41 с`,
  )

  const rejected = rowWords({
    submission: submission({
      state: 'rejected',
      stage: 'score',
      publicScore: null,
      durationMs: 58_000,
      fileName: 'naive_week.ipynb',
      participantError:
        'Не для всех строк test.csv есть прогноз. В submission.csv 391 строка вместо 397.',
    }),
    live: null,
    best: false,
    paused: false,
    now: NOW,
  })
  // The title is the reason, not the file name: to the entrant it matters more
  // why the answer did not fit.
  assert.equal(rejected.title, 'Не для всех строк test.csv есть прогноз.')
  assert.ok(rejected.lines[0].includes('naive_week.ipynb'))
  assert.equal(rejected.lines[1], 'В submission.csv 391 строка вместо 397.')
})

test('a failed metric gets a sentence about the checking code, not an accusation of the entrant', () => {
  const words = rowWords({
    submission: submission({ state: 'metricFailed', publicScore: null }),
    live: null,
    best: false,
    paused: false,
    now: NOW,
  })
  assert.equal(words.title, 'lgbm_lags_v3.ipynb')
  assert.match(words.lines[1], /Проверяющий код упал/)
})

test('a cancelled submission says that you cancelled it', () => {
  const words = rowWords({
    submission: submission({ state: 'cancelled', publicScore: null, durationMs: null }),
    live: null,
    best: false,
    paused: false,
    now: NOW,
  })
  assert.match(words.lines[0], /снята вами$/)
})

test('a waiting submission takes its caption from the queue', () => {
  const words = rowWords({
    submission: submission({ state: 'queued', stage: 'queue', publicScore: null, durationMs: null }),
    live: live({ place: 3, etaMs: 6 * MINUTE, aheadNumber: 12 }),
    best: false,
    paused: false,
    now: NOW,
  })
  assert.equal(words.lines[0], 'Третья в очереди · запуск после завершения посылки #12')
})

/* ------------------------------------------- own numbers and the quota */

test("a submission's own ordinal counts the person's list, not the competition's numbers", () => {
  const list = [
    submission({ id: 'c', number: 28, acceptedAt: NOW }),
    submission({ id: 'a', number: 8, acceptedAt: NOW - 20 * MINUTE }),
    submission({ id: 'b', number: 27, acceptedAt: NOW - 2 * MINUTE }),
  ]
  const ordinals = ownOrdinals(list)
  assert.deepEqual([ordinals.get('a'), ordinals.get('b'), ordinals.get('c')], [1, 2, 3])
  // The same second: the competition's number keeps the order the list shows.
  const tie = ownOrdinals([submission({ id: 'y', number: 31, acceptedAt: NOW }), submission({ id: 'x', number: 30, acceptedAt: NOW })])
  assert.deepEqual([tie.get('x'), tie.get('y')], [1, 2])

  assert.equal(submissionOrdinal(3), '3-я')
  assert.equal(tr('competitions.p.ownOrdinal', { ordinal: submissionOrdinal(3) }), '3-я посылка')
  assert.equal(tr('competitions.p.sentOk', { ordinal: submissionOrdinal(3) }), 'Принята ваша 3-я посылка')
  setLocaleResolver(() => 'en')
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(submissionOrdinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st'])
  assert.equal(tr('competitions.p.ownOrdinal', { ordinal: submissionOrdinal(3) }), '3rd submission')
  assert.equal(tr('competitions.p.sentOk', { ordinal: submissionOrdinal(3) }), 'Accepted: your 3rd submission')
  // The place keeps its own masculine Russian form and the shared English one.
  assert.equal(ordinalPlace(22), '22nd')
})

test('a finished submission that spent nothing of the day says so, by the quota rule itself', () => {
  const at = (patch: Partial<EntrantSubmission>) => outsideQuota(submission(patch), 5)
  assert.equal(at({ state: 'notebookFailed', cellsDone: 0 }), true)
  assert.equal(at({ state: 'rejected', cellsDone: 0 }), true)
  assert.equal(at({ state: 'cancelled', cellsDone: 4 }), true)
  assert.equal(at({ state: 'cancelled', cellsDone: 0, replacedBy: 29 }), true)
  // The notebook ran: a refused answer and a failed cell both spent one.
  assert.equal(at({ state: 'rejected', cellsDone: 9 }), false)
  assert.equal(at({ state: 'notebookFailed', cellsDone: 1 }), false)
  assert.equal(at({ state: 'scored' }), false)
  // In flight it does hold a place, so there is nothing to say yet.
  assert.equal(at({ state: 'queued', cellsDone: 0 }), false)
  assert.equal(at({ state: 'running', cellsDone: 0 }), false)
  // No limit, nothing to count against.
  assert.equal(outsideQuota(submission({ state: 'notebookFailed', cellsDone: 0 }), 0), false)
})

test('"not counted toward the limit" closes the caption, or stands alone when there is none', () => {
  const dead = submission({ state: 'notebookFailed', cellsDone: 0, cellsTotal: 0, publicScore: null })
  const desktop = rowWords({ submission: dead, live: null, best: false, paused: false, now: NOW, offQuota: true })
  assert.equal(desktop.lines[0], `Сегодня в ${clockOf(dead.acceptedAt)} · не в счёт лимита`)
  const replaced = rowWords({
    submission: submission({ state: 'cancelled', cellsDone: 0, replacedBy: 29, publicScore: null }),
    live: null, best: false, paused: false, now: NOW, offQuota: true,
  })
  assert.match(replaced.lines[0], /заменена посылкой #29 · не в счёт лимита$/)
  // A phone's refused answer puts the reason in the title and has no caption.
  const refused = submission({ state: 'rejected', cellsDone: 0, publicScore: null, participantError: 'Нет файла submission.csv.' })
  const phone = rowWords({ submission: refused, live: null, best: false, paused: false, now: NOW, phone: true, offQuota: true })
  assert.deepEqual(phone.lines, ['не в счёт лимита'])
  assert.doesNotMatch(rowWords({ submission: dead, live: null, best: false, paused: false, now: NOW }).lines.join(' '), /лимит/)
  setLocaleResolver(() => 'en')
  assert.match(rowWords({ submission: dead, live: null, best: false, paused: false, now: NOW, offQuota: true }).lines[0], /· not counted toward the limit$/)
})

test('the day-limit rule is one sentence in both languages', () => {
  assert.equal(
    tr('competitions.p.quotaRule'),
    'В счёт лимита идёт каждая посылка, чья тетрадь начала выполняться, даже если ответ не принят; упавшая до первой ячейки или отменённая — нет.',
  )
  setLocaleResolver(() => 'en')
  assert.equal(
    tr('competitions.p.quotaRule'),
    'Every submission whose notebook starts running counts toward the limit, even if its answer is rejected; one that fails before its first cell or is cancelled does not.',
  )
})

test('under scoring "last" the send box names the counted submission a new score would replace', () => {
  const last = { scoring: 'last' as const, metric: { name: 'ROC AUC', direction: 'higher' as const } }
  const list = [
    submission({ id: 'old', number: 12, acceptedAt: NOW - 30 * MINUTE, publicScore: 0.91 }),
    submission({ id: 'counted', number: 28, acceptedAt: NOW - 10 * MINUTE, publicScore: 0.8255 }),
    // Newer, but it never reached a number: "last" means the last SCORED one.
    submission({ id: 'failed', number: 29, acceptedAt: NOW - MINUTE, state: 'notebookFailed', publicScore: null }),
  ]
  assert.equal(lastScoringNote(last, list), 'Если эта посылка дойдёт до числа, в зачёт пойдёт она, а не #28 (0.8255).')
  setLocaleResolver(() => 'en')
  assert.equal(lastScoringNote(last, list), 'If this submission gets a score, it counts instead of #28 (0.8255).')
  // Nothing counts yet, or the rule is not "last": nothing to warn about.
  assert.equal(lastScoringNote(last, [list[2]]), null)
  assert.equal(lastScoringNote({ ...last, scoring: 'bestPublic' }, list), null)
  assert.equal(lastScoringNote({ ...last, scoring: 'chosen' }, list), null)
})

/* -------------------------------------------------------------- places */

test('places in the table count people, and the baseline stands where it ranks', () => {
  const rows = [
    { baseline: false, name: 'Марфа' },
    { baseline: false, name: 'Платон' },
    { baseline: true, name: 'Базовое решение' },
    { baseline: false, name: 'Тимур' },
  ]
  assert.deepEqual(
    boardPlaces(rows).map((line) => [line.name, line.place]),
    [
      ['Марфа', 1],
      ['Платон', 2],
      ['Базовое решение', 3],
      ['Тимур', 3],
    ],
  )
  // A baseline ahead of everyone takes no place at all: its "1" next to a
  // person's "1" reads as a tie that does not exist, while the header says
  // "1 of 2".
  assert.deepEqual(
    boardPlaces([
      { baseline: true, name: 'Базовое решение' },
      { baseline: false, name: 'Тимур' },
    ]).map((line) => [line.name, line.place]),
    [
      ['Базовое решение', null],
      ['Тимур', 1],
    ],
  )
})

/* ----------------------------------------------------- files and avatars */

test('file size: bytes, kilobytes, megabytes with one decimal below ten', () => {
  assert.equal(fileSize(512), '512 Б')
  assert.equal(fileSize(6 * 1024), '6 КБ')
  assert.equal(fileSize(212 * 1024), '212 КБ')
  assert.match(fileSize(4.1 * 1024 * 1024), /^4,1 МБ$/)
  assert.match(fileSize(40 * 1024 * 1024), /^40 МБ$/)
  setLocaleResolver(() => 'en')
  assert.equal(fileSize(6 * 1024), '6 KB')
})

test("the entrant's circle: colour from the name, letter from the name, the name shortened", () => {
  assert.ok(AVATAR_TINTS.includes(avatarTint('Тимур Ахметов')))
  // The same person gets the same colour on every device.
  assert.equal(avatarTint('Тимур Ахметов'), avatarTint('Тимур Ахметов'))
  assert.notEqual(avatarTint('Тимур Ахметов'), avatarTint('Марфа Соколова'))
  assert.equal(avatarLetter('тимур'), 'Т')
  assert.equal(avatarLetter('  '), '?')
  // A Telegram name is stored as "@login": the circle shows its letter, not the "@".
  assert.equal(avatarLetter('@max_zaitsev'), 'M')
  assert.equal(avatarLetter('@timur_a'), 'T')
  assert.equal(avatarLetter('boris.kuznetsov@mail.ru'), 'B')
  assert.equal(avatarLetter('@'), '?')
  assert.equal(shortName('Тимур Ахметов'), 'Тимур А.')
  assert.equal(shortName('Платон'), 'Платон')
})


test('dependency installation has its own current stage and phone wording', () => {
  const cells = stageStrip('running', 'dependencies')
  assert.equal(cells.find((cell) => cell.position === 'current')?.stage, 'dependencies')
  const result = rowWords({ submission: submission({ state: 'running', stage: 'dependencies', cellsTotal: 0 }), live: live({ stage: 'dependencies' }), best: false, paused: false, now: NOW, phone: true })
  assert.deepEqual(result.lines, ['Установка пакетов'])
  setLocaleResolver(() => 'en')
  assert.deepEqual(rowWords({ submission: submission({ state: 'running', stage: 'dependencies' }), live: null, best: false, paused: false, now: NOW, phone: true }).lines, ['Installing packages'])
})


test('package manager has a distinct route with an optional trailing slash', () => {
  assert.deepEqual(readCompetitionRoute('/k/rohlik/dependencies'), { slug: 'rohlik', view: 'dependencies', signInKey: null })
  assert.deepEqual(readCompetitionRoute('/k/rohlik/dependencies/'), { slug: 'rohlik', view: 'dependencies', signInKey: null })
  assert.equal(readCompetitionRoute('/k/rohlik/dependencies/screen'), null)
  assert.equal(readCompetitionRoute('/k/rohlik/leaderboard/screen')?.view, 'screen')
  assert.equal(readCompetitionRoute('/k/rohlik/submissions')?.view, 'submissions')
})
