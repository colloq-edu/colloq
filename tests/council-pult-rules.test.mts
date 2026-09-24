/**
 * Council rules — the arithmetic of the sentence, the sheet and the stopped
 * runs.
 *
 * A cell's rules are gathered in one place (PultRules.svelte), and in the
 * header they stand as a sentence: "Runs on request · each run capped at
 * 30 s · rerun after 30 s · on screen with names". The sentence is not markup
 * but a conclusion drawn from four settings, and it lies silently — so it is
 * checked here:
 *
 *   the "rerun" piece  DISAPPEARS when students do not run: a pause for
 *                      someone who does not run means nothing, and a grey
 *                      word gets read every time;
 *   yellow             exactly one, and only on "uncapped": the queue gets
 *                      stuck dead on it;
 *   a stray number     (the server accepts any) gets a button of its own in
 *                      the row, otherwise the row looks as if the setting
 *                      were broken;
 *   duration words     one function for the sentence, the sheet, the run bar
 *                      and the "Stopped: longer than 30 s" line: once they
 *                      diverged, they would start naming the same limit
 *                      differently;
 *   the numbers        under the limit choice come from FINISHED runs: a run
 *                      stopped by the limit has no duration, what is measured
 *                      there is the limit itself;
 *   the "With an       also catches the stopped ones: the run failed, though
 *   error" filter      there was no error in the code.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver, translate } from '../shared/i18n.js'
import { COUNCIL_RERUN_PAUSES, COUNCIL_RUN_LIMITS, DEFAULT_COUNCIL } from '../shared/notebook.js'
import type { CouncilSettings } from '../shared/notebook.js'
import type { CouncilAttempt } from '../shared/protocol.js'
import {
  attemptExecution,
  limitOptions,
  matchesFilter,
  pauseOptions,
  pultDuration,
  rulesSentence,
  runStats,
  timedOutAttempts,
  timedOutLimit,
} from '../web/src/lib/council-pult.js'

const settings = (patch: Partial<CouncilSettings> = {}): CouncilSettings => ({ ...DEFAULT_COUNCIL, ...patch })
const rules = (patch: Partial<CouncilSettings> = {}) => rulesSentence(settings(patch))
const sentence = (patch: Partial<CouncilSettings> = {}): string =>
  rules(patch).map((part) => `${part.lead} ${part.value}`).join(' · ')

/** An attempt with exactly the fields the rules read. */
function attempt(id: string, run: Partial<NonNullable<CouncilAttempt['run']>> | null): CouncilAttempt {
  return {
    participantId: id,
    name: id,
    color: '#000',
    avatar: null,
    text: `print(${id})`,
    groupKey: id,
    submittedAt: 1,
    updatedAt: 1,
    correct: null,
    status: 'ran',
    run: run === null ? null : { state: 'ok', outputs: [], execCount: 1, ranMs: 1000, startedAt: 1, by: 'host', ...run },
  } as unknown as CouncilAttempt
}

/* ------------------------------------------------------------ words */

test('rules durations: seconds, whole minutes, and minutes with seconds', () => {
  assert.equal(pultDuration(5), '5 с')
  assert.equal(pultDuration(30), '30 с')
  assert.equal(pultDuration(60), '1 мин')
  assert.equal(pultDuration(300), '5 мин')
  // "1 min 30 s" was chosen, and that is how it reads: rounding to "2 min"
  // would lie about the setting, not about what happened.
  assert.equal(pultDuration(90), '1 мин 30 с')
  assert.equal(pultDuration(0), '0 с')
  setLocaleResolver(() => 'en')
  assert.equal(pultDuration(30), '30 s')
  assert.equal(pultDuration(90), '1 min 30 s')
  setLocaleResolver(() => 'ru')
})

/* ---------------------------------------------------------- sentence */

test('the sentence reads differently at each position of the run control', () => {
  assert.match(sentence({ studentRun: 'request' }), /^Запускают по просьбе · /)
  assert.match(sentence({ studentRun: true }), /^Запускают все по очереди · /)
  assert.match(sentence({ studentRun: false }), /^Запускаю только я · /)
  assert.equal(new Set([
    sentence({ studentRun: false }), sentence({ studentRun: true }), sentence({ studentRun: 'request' }),
  ]).size, 3)
})

test('only the teacher runs — the sentence has no rerun piece at all', () => {
  // Not grey and not "rerun right away": a pause between runs means nothing
  // for someone who does not run, and an extra word in the line gets read
  // every time.
  const off = rules({ studentRun: false, rerunPauseSec: 30 })
  assert.deepEqual(off.map((part) => part.rule), ['studentRun', 'runLimit', 'names'])
  for (const run of [true, 'request'] as const) {
    assert.deepEqual(
      rules({ studentRun: run, rerunPauseSec: 30 }).map((part) => part.rule),
      ['studentRun', 'runLimit', 'rerunPause', 'names'],
    )
  }
})

test('in a narrow window the connectives go, and "rerun" moves inside the value', () => {
  const parts = rules({ studentRun: 'request', rerunPauseSec: 30 })
  const pause = parts.find((part) => part.rule === 'rerunPause')!
  assert.equal(pause.value, 'через 30 с')
  assert.equal(pause.short, 'повтор через 30 с', '"after 30 s" without the lead-in reads as a second limit')
  // For the rest, the short and the full form coincide: their values stand on
  // their own.
  for (const part of parts.filter((one) => one.rule !== 'rerunPause')) assert.equal(part.short, part.value)
  assert.equal(rules({ studentRun: true, rerunPauseSec: 0 }).find((p) => p.rule === 'rerunPause')!.short, 'повтор сразу')
})

test('"uncapped" is the only yellow value in the sentence', () => {
  const none = rules({ studentRun: true, runLimitSec: null })
  assert.deepEqual(none.filter((part) => part.warn).map((part) => part.rule), ['runLimit'])
  assert.equal(none.find((part) => part.rule === 'runLimit')!.value, 'без предела')
  // With a limit there is no yellow at all: there is nothing to warn about.
  assert.equal(rules({ studentRun: true, runLimitSec: 30 }).some((part) => part.warn), false)
})

test('the pause and the names read as words, not as numbers and ticks', () => {
  const value = (patch: Partial<CouncilSettings>, rule: string): string =>
    rules(patch).find((part) => part.rule === rule)!.value
  assert.equal(value({ studentRun: true, rerunPauseSec: 0 }, 'rerunPause'), 'сразу')
  assert.equal(value({ studentRun: true, rerunPauseSec: 60 }, 'rerunPause'), 'через 1 мин')
  assert.equal(value({ namesOnProjector: true }, 'names'), 'с именами')
  assert.equal(value({ namesOnProjector: false }, 'names'), 'без имён')
  assert.equal(value({ runLimitSec: 300 }, 'runLimit'), 'до 5 мин')
})

test('the sentence spells out a stray number in the settings instead of hiding it', () => {
  // The server accepts any integer within bounds: 90 s may have been set from
  // another build or sent via history, and "capped at 90 s" is more honest
  // than an empty spot.
  assert.equal(rules({ runLimitSec: 90 }).find((part) => part.rule === 'runLimit')!.value, 'до 1 мин 30 с')
  assert.equal(
    rules({ studentRun: true, rerunPauseSec: 45 }).find((part) => part.rule === 'rerunPause')!.value,
    'через 45 с',
  )
})

test('in English the sentence reads as a sentence, not as a word-for-word gloss', () => {
  setLocaleResolver(() => 'en')
  assert.equal(
    sentence({ studentRun: 'request', runLimitSec: 30, rerunPauseSec: 30, namesOnProjector: true }),
    'Runs on request · each run capped at 30 s · rerun after 30 s · on screen with names',
  )
  assert.equal(sentence({ studentRun: false, runLimitSec: null }), 'Runs by me only · each run uncapped · on screen with names')
  setLocaleResolver(() => 'ru')
})

/* ------------------------------------------------------------- rows */

test('the button row always shows the current value — even one not in the list', () => {
  assert.deepEqual(limitOptions(30), [...COUNCIL_RUN_LIMITS])
  assert.deepEqual(limitOptions(null), [...COUNCIL_RUN_LIMITS])
  // A number of its own takes its place by size, "uncapped" stays last.
  assert.deepEqual(limitOptions(90), [5, 15, 30, 60, 90, 300, null])
  assert.deepEqual(pauseOptions(0), [...COUNCIL_RERUN_PAUSES])
  assert.deepEqual(pauseOptions(45), [0, 15, 30, 45, 60, 120])
  for (const current of [90, 7, 3600]) assert.ok(limitOptions(current).includes(current))
})

/* ---------------------------------------------- how long runs take */

test('the numbers under the limit come from finished runs: the median and the longest', () => {
  const board = [
    attempt('a', { ranMs: 400 }),
    attempt('b', { ranMs: 3100 }),
    attempt('c', { ranMs: 800 }),
  ]
  assert.deepEqual(runStats(board), { median: 800, max: 3100, count: 3 })
  // An even count gives the middle between the two central ones: there is no
  // reason to pick either of them.
  assert.equal(runStats([...board, attempt('d', { ranMs: 1200 })])?.median, 1000)
})

test('running, interrupted and limit-stopped runs do not get into the statistics', () => {
  /*
   * A running one has no duration yet, one interrupted by hand will never
   * have it (ranMs null), and for one stopped by the limit it is NOT REAL:
   * what was measured there is the limit itself. Otherwise the median would
   * creep up because of the very rule it is used to choose: set 5 s —
   * "usually 5 s" — set 15 s.
   */
  const board = [
    attempt('ok', { ranMs: 400 }),
    attempt('running', { state: 'running', ranMs: null }),
    attempt('killed', { ranMs: null }),
    attempt('slow', { state: 'error', ranMs: 30_000, timedOut: 30 }),
    attempt('writing', null),
  ]
  assert.deepEqual(runStats(board), { median: 400, max: 400, count: 1 })
  assert.equal(runStats([attempt('slow', { state: 'error', ranMs: 30_000, timedOut: 30 })]), null)
  assert.equal(runStats([]), null)
})

/* ---------------------------------------------- stopped by the limit */

test('those stopped by the limit — the freshest on top, by run start', () => {
  const board = [
    attempt('early', { state: 'error', startedAt: 100, timedOut: 30 }),
    attempt('ok', { startedAt: 300 }),
    attempt('late', { state: 'error', startedAt: 200, timedOut: 5 }),
  ]
  assert.deepEqual(timedOutAttempts(board).map((one) => one.participantId), ['late', 'early'])
  assert.deepEqual(timedOutAttempts([attempt('ok', {})]), [])
  // The limit speaks about ITS OWN run: the rules may have changed since.
  assert.equal(timedOutLimit(board[0]), 30)
  assert.equal(timedOutLimit(board[2]), 5)
  assert.equal(timedOutLimit(board[1]), null)
  assert.equal(timedOutLimit({ run: null }), null)
})

test('stopped by the limit is not a "run error", but it gets into the "With an error" filter', () => {
  const slow = attempt('slow', { state: 'error', timedOut: 30, ranMs: null })
  const broken = attempt('broken', { state: 'error', ranMs: 120 })
  const badge = attemptExecution(slow)
  assert.equal(badge.tone, 'danger', 'the same colour: the run failed')
  assert.equal(badge.label, 'Остановлен: дольше 30 с')
  assert.equal(badge.icon, '◷', 'a clock instead of a cross: there was no error in the code')
  assert.notEqual(badge.label, attemptExecution(broken).label)
  // The filter catches both: the chip is about a failed run, not about the
  // error name.
  for (const one of [slow, broken]) assert.equal(matchesFilter(one, 'error', new Set()), true)
  assert.equal(matchesFilter(attempt('ok', {}), 'error', new Set()), false)
})

test('"limit 30 s" and "Stopped: longer than 30 s" use the same words in both languages', () => {
  for (const locale of ['ru', 'en'] as const) {
    setLocaleResolver(() => locale)
    const duration = pultDuration(30)
    for (const key of ['room.pult.v2.execution.timedOut', 'room.pult.v2.rules.workTimedOut', 'room.pult.v2.rules.limitLink', 'room.pult.v2.queue.limitStops']) {
      assert.ok(translate(locale, key, { duration }).includes(duration), `${key} (${locale}) names the limit in its own words`)
    }
  }
  setLocaleResolver(() => 'ru')
})
