/**
 * The words of the participant's pages for late intake, the free failures and
 * the hidden test (Paper 07 · C1, C3).
 *
 * Each of them is a sentence a student reads at the moment of deciding
 * something — whether to send again, whether a result counts, why a failure
 * shows so little — and each has a quiet way to be wrong: a count that reads
 * as the limit when it is the ceiling on failures, "the deadline passed" when
 * the teacher ended intake early, a "better than the counted one" under a
 * worse score, rows of the hidden test named off the wrong file.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver, tr } from '../shared/i18n.js'
import type { EntrantSubmission } from '../shared/competitions.js'
import type { EntrantCompetitionView } from '../shared/competitions-entrant.js'
import {
  attemptFreeWords,
  attemptsExhausted,
  attemptsNote,
  attemptsSpentWords,
  bestLateScore,
  blindCellLine,
  blindHead,
  blindWhy,
  clockOf,
  dateOf,
  dayWord,
  deadlineDividerWords,
  deadlineSplit,
  lateBetterNote,
  passedDeadline,
  phoneQuota,
  quotaCells,
  quotaLead,
  quotaMeterWords,
  sealedColumnsWords,
  sealedSwapWords,
  sealedTarget,
  standingsClosed,
  type QuotaState,
} from '../web/src/lib/competition-words.js'

afterEach(() => setLocaleResolver(() => 'ru'))

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** 4 October, 14:40 on the reader's clock. */
const NOW = new Date(2026, 9, 4, 14, 40, 0).getTime()
/** The next midnight in Moscow: 21:00 UTC of the same day. */
const MIDNIGHT = Date.UTC(2026, 9, 4, 21)

/** Digits are grouped with a narrow no-break space (formatNumber); the assertions read plain spaces. */
const plain = (text: string | null) => (text ?? '').replace(/[\u00a0\u202f]/g, ' ')

const quota = (patch: Partial<QuotaState> = {}): QuotaState => ({
  leftToday: 3, perDay: 5, resetsAt: MIDNIGHT, dayZone: 'Europe/Moscow', failedAttempts: { used: 3, ceiling: 15 }, ...patch,
})

function submission(patch: Partial<EntrantSubmission> = {}): EntrantSubmission {
  return {
    id: 's1', competitionId: 'c1', entrantId: 'e1', number: 18, fileName: 'door_events_v7.ipynb', bytes: 4096,
    acceptedAt: NOW - 10 * MINUTE, state: 'scored', stage: 'score', publicScore: 0.9261, privateScore: null,
    durationMs: 188_000, cellsDone: 15, cellsTotal: 15, participantError: null, chosen: false, ...patch,
  }
}

/* ------------------------------------------------------- the day's limit */

test('the quota lead puts the rule first, then the count and the zoned reset', () => {
  assert.equal(quotaLead(quota()), 'Лимит тратят только посылки с оценкой — сегодня осталось 3 из 5, обновится в 00:00 GMT+3.')
  // One left reads "осталась", as Russian says it.
  assert.equal(quotaLead(quota({ leftToday: 1 })), 'Лимит тратят только посылки с оценкой — сегодня осталась 1 из 5, обновится в 00:00 GMT+3.')
  // An older server names no reset: the sentence ends at the count.
  assert.equal(quotaLead(quota({ resetsAt: undefined })), 'Лимит тратят только посылки с оценкой — сегодня осталось 3 из 5.')
  // Spent: the door's own refusal, and when it starts over.
  assert.equal(quotaLead(quota({ leftToday: 0 })), 'На сегодня посылки кончились: 5 в день на участника. Лимит обновится в 00:00 GMT+3.')
  assert.equal(quotaLead(quota({ leftToday: null, perDay: 0, resetsAt: null })), tr('competitions.p.dropNoLimit'))
  setLocaleResolver(() => 'en')
  assert.equal(quotaLead(quota()), 'Only scored submissions spend the limit: 3 of 5 left today, resets at 00:00 GMT+3.')
})

test('the phone says the count first and the rule in one short sentence after it', () => {
  assert.equal(phoneQuota(quota()), 'Сегодня осталось 3 посылки из 5. Лимит обновится в 00:00 GMT+3. Лимит тратят только посылки с оценкой.')
  assert.equal(phoneQuota(quota({ leftToday: 0 })), 'На сегодня посылки кончились: 5 в день на участника. Лимит обновится в 00:00 GMT+3.')
  setLocaleResolver(() => 'en')
  assert.match(phoneQuota(quota()), /Only scored submissions spend the limit\.$/)
})

test('what is free is named by what happened, in both languages', () => {
  assert.equal(
    tr('competitions.p.quotaFree'),
    'Упавшие не считаются: ошибка в тетради, нехватка времени или памяти, ответ не принят, сбой проверки. Посылка в работе держит место и вернёт его, если упадёт.',
  )
  setLocaleResolver(() => 'en')
  assert.match(tr('competitions.p.quotaFree'), /^Failed ones are free: /)
})

test('the meter has a cell per submission of the day, filled while it is left, and none past ten', () => {
  assert.deepEqual(quotaCells(3, 5), [true, true, true, false, false])
  assert.deepEqual(quotaCells(0, 2), [false, false])
  assert.equal(quotaCells(3, 30), null)
  assert.equal(quotaCells(null, 0), null)
  assert.equal(quotaMeterWords(3, 5), 'осталось 3 из 5')
  assert.equal(quotaMeterWords(1, 5), 'осталась 1 из 5')
  setLocaleResolver(() => 'en')
  assert.equal(quotaMeterWords(3, 5), '3 of 5 left')
})

test('the ceiling on failures is its own quiet line, never called the limit', () => {
  assert.equal(attemptsNote({ used: 3, ceiling: 15 }), 'Неудачных попыток — не больше 15 в день; сегодня 3.')
  assert.equal(attemptsNote({ used: 0, ceiling: 15 }), 'Неудачных попыток — не больше 15 в день.')
  assert.equal(attemptsNote(null), '')
  assert.doesNotMatch(attemptsNote({ used: 3, ceiling: 15 }), /лимит/i)
  setLocaleResolver(() => 'en')
  assert.equal(attemptsNote({ used: 3, ceiling: 15 }), 'Failed attempts: at most 15 a day; 3 today.')
})

test('a reached ceiling stops the box with the door\'s own words and its own reset', () => {
  assert.equal(attemptsExhausted({ used: 14, ceiling: 15 }), false)
  assert.equal(attemptsExhausted({ used: 15, ceiling: 15 }), true)
  assert.equal(attemptsExhausted(null), false)
  assert.equal(attemptsSpentWords({ used: 14, ceiling: 15 }, MIDNIGHT, 'Europe/Moscow'), '')
  const spent = attemptsSpentWords({ used: 15, ceiling: 15 }, MIDNIGHT, 'Europe/Moscow')
  assert.ok(spent.startsWith(tr('competitions.refusal.dailyAttempts', { count: 15 })), spent)
  assert.match(spent, /Это не лимит посылок/)
  assert.match(spent, /Счёт упавших начнётся заново в 00:00 GMT\+3\.$/)
})

test('a failed run\'s details say it was free, and how many are left', () => {
  assert.equal(attemptFreeWords(3, 5), 'Попытка лимит не потратила — сегодня осталось 3 из 5')
  assert.equal(attemptFreeWords(1, 5), 'Попытка лимит не потратила — сегодня осталась 1 из 5')
  assert.equal(attemptFreeWords(null, 0), '', 'no limit, nothing it could have spent')
  setLocaleResolver(() => 'en')
  assert.equal(attemptFreeWords(3, 5), 'This attempt did not spend the limit: 3 of 5 left today')
})

/* ------------------------------------------------- after the deadline */

test('a passed deadline is named by its day and clock, and not when intake ended early', () => {
  const noon = new Date(2026, 9, 4, 12, 0).getTime()
  assert.deepEqual(passedDeadline(noon, NOW), { day: 'сегодня', time: clockOf(noon) })
  assert.equal(dayWord(noon - DAY, NOW), 'вчера')
  assert.equal(dayWord(noon - 3 * DAY, NOW), dateOf(noon - 3 * DAY))
  // «Завершить сейчас» before the deadline: "the deadline passed" would be untrue.
  assert.equal(passedDeadline(NOW + HOUR, NOW), null)
  assert.equal(passedDeadline(null, NOW), null)
  assert.equal(deadlineDividerWords(noon, NOW), `ДЕДЛАЙН · сегодня ${clockOf(noon)}`)
  assert.equal(deadlineDividerWords(NOW + HOUR, NOW), 'ДЕДЛАЙН')
  setLocaleResolver(() => 'en')
  assert.equal(deadlineDividerWords(noon, NOW), `DEADLINE · today ${clockOf(noon)}`)
})

test('the deadline line goes under the late rows on top, and nowhere without both sides', () => {
  const late = { late: true }
  const onTime = { late: false }
  assert.equal(deadlineSplit([late, late, onTime, onTime]), 2)
  assert.equal(deadlineSplit([late, onTime, { late: undefined }]), 1)
  assert.equal(deadlineSplit([onTime, onTime]), -1, 'no late rows')
  assert.equal(deadlineSplit([late, late]), -1, 'nothing on time below')
  assert.equal(deadlineSplit([]), -1)
})

test('a late score better than the counted one says it changes nothing; a worse one says nothing', () => {
  const counted = { number: 14, publicScore: 0.9204 }
  assert.equal(
    lateBetterNote(submission({ late: true, publicScore: 0.9261 }), counted, 'higher'),
    'Лучше зачётной #14 на 0.0057, но место и зачёт не меняет.',
  )
  // Lower is better: 0.0412 against 0.0455 is the better one.
  assert.match(lateBetterNote(submission({ late: true, publicScore: 0.0412 }), { number: 3, publicScore: 0.0455 }, 'lower') ?? '', /на 0\.0043/)
  assert.equal(lateBetterNote(submission({ late: true, publicScore: 0.91 }), counted, 'higher'), null)
  assert.equal(lateBetterNote(submission({ late: true, publicScore: 0.9204 }), counted, 'higher'), null, 'equal is not better')
  assert.equal(lateBetterNote(submission({ publicScore: 0.95 }), counted, 'higher'), null, 'on time: it may well count')
  assert.equal(lateBetterNote(submission({ late: true, publicScore: 0.95 }), null, 'higher'), null)
  assert.equal(lateBetterNote(submission({ late: true, state: 'notebookFailed', publicScore: null }), counted, 'higher'), null)
})

test('the best late score is picked by the board\'s own comparison, among scored late rows only', () => {
  const rows = [
    submission({ id: 'a', late: true, publicScore: 0.91 }),
    submission({ id: 'b', late: true, publicScore: 0.93 }),
    submission({ id: 'c', publicScore: 0.99 }),
    submission({ id: 'd', late: true, state: 'notebookFailed', publicScore: null }),
  ]
  assert.equal(bestLateScore(rows, 'higher'), 0.93)
  assert.equal(bestLateScore(rows, 'lower'), 0.91)
  assert.equal(bestLateScore([submission({ publicScore: 0.5 })], 'higher'), null)
})

test('the standings are closed both when the door is shut and when it takes late notebooks only', () => {
  assert.equal(standingsClosed('closed'), true)
  assert.equal(standingsClosed('late'), true)
  assert.equal(standingsClosed('open'), false)
  assert.equal(standingsClosed('not_open'), false)
})

/* ------------------------------------------------------- the hidden test */

const view = (patch: Partial<EntrantCompetitionView> = {}) => ({
  files: [
    { name: 'train.csv', bytes: 100, rows: 48_600 },
    { name: 'test.csv', bytes: 90_000, rows: 200, sealed: true },
  ],
  sealedFiles: [{ name: 'test.csv', rows: 2140, replaces: 'test.csv', columns: ['id', 'feature'] }],
  ...patch,
})

test('the hidden file the words name is the one standing in for an example, with both row counts', () => {
  assert.deepEqual(sealedTarget(view()), { file: 'data/test.csv', rows: 2140, exampleRows: 200, replaces: true })
  // A file new to data/ is named only when nothing stands in for an example.
  const both = view({ sealedFiles: [
    { name: 'extra.csv', rows: 10, replaces: null, columns: null },
    { name: 'test.csv', rows: 2140, replaces: 'test.csv', columns: null },
  ] })
  assert.equal(sealedTarget(both)?.file, 'data/test.csv')
  assert.deepEqual(sealedTarget(view({ sealedFiles: [{ name: 'extra.csv', rows: null, replaces: null, columns: null }] })),
    { file: 'data/extra.csv', rows: null, exampleRows: null, replaces: false })
  assert.equal(sealedTarget(view({ sealedFiles: [] })), null)
  assert.equal(sealedTarget({ files: [] }), null, 'an older server sends no list at all')
})

test('a blind failure is said with the cell and the allowed exception class, and why the rest is missing', () => {
  const failed = submission({ state: 'notebookFailed', cellsDone: 12, cellsTotal: 15, errorType: 'ValueError', publicScore: null, blind: true })
  assert.equal(blindHead(failed), 'Проверка на скрытом тесте: ячейка 12 · ValueError · вывод скрыт')
  assert.equal(blindHead({ ...failed, errorType: null }), 'Проверка на скрытом тесте: ячейка 12 · вывод скрыт')
  assert.equal(blindHead({ ...failed, state: 'rejected' }), 'Проверка на скрытом тесте · вывод скрыт')
  assert.equal(blindCellLine(failed), 'ячейка 12 из 15 · ValueError')
  assert.equal(
    plain(blindWhy(failed, sealedTarget(view()))),
    'Тетрадь работала с настоящим data/test.csv — 2 140 строк вместо 200 в примере, — поэтому текст ошибки, трассировка и вывод ячеек не показываются. '
      + 'Если на примере ячейка 12 проходит, проверьте, не рассчитан ли код на число строк, конкретные id или значения из примера.',
  )
  // Without counts, the file; without an example, the hidden test; no cell, no cell advice.
  assert.match(blindWhy(failed, { file: 'data/test.csv', rows: null, exampleRows: 200, replaces: true }), /^Тетрадь работала с настоящим data\/test\.csv, поэтому/)
  assert.match(blindWhy(failed, null), /^Тетрадь работала со скрытым тестом, поэтому/)
  assert.doesNotMatch(blindWhy({ ...failed, state: 'rejected' }, sealedTarget(view())), /ячейка/)
  setLocaleResolver(() => 'en')
  assert.equal(blindHead(failed), 'Checked on the hidden test: cell 12 · ValueError · output hidden')
  assert.match(blindWhy(failed, sealedTarget(view())), /^The notebook worked with the real data\/test\.csv — 2,140 rows instead of 200 in the example —/)
})

test('the example in the data list promises the same path and says how big the hidden test is', () => {
  assert.equal(plain(sealedSwapWords(2000)), 'при проверке заменяется скрытым тестом (2 000 строк) по тому же пути')
  assert.equal(sealedSwapWords(null), 'при проверке заменяется скрытым тестом по тому же пути')
  assert.equal(sealedColumnsWords(['id', 'feature']), '2 столбца: id, feature')
  assert.equal(
    sealedColumnsWords(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
    '8 столбцов: a, b, c, d, e, f …',
  )
  assert.equal(sealedColumnsWords(null), '')
  setLocaleResolver(() => 'en')
  assert.equal(sealedSwapWords(2000), 'during the check it is swapped for the hidden test (2,000 rows) at the same path')
})
