/**
 * Регламент консилиума — арифметика предложения, листа и остановленных.
 *
 * Правила ячейки собраны в одно место (PultRules.svelte), а в шапке они стоят
 * предложением: «Запускают по просьбе · каждый запуск до 30 с · повтор через
 * 30 с · на экране с именами». Предложение это не разметка, а вывод из четырёх
 * настроек, и врёт оно молча — поэтому проверяется здесь:
 *
 *   кусок «повтор» ИСЧЕЗАЕТ, когда студенты не запускают: пауза у того, кто не
 *           запускает, не означает ничего, а серое слово читают каждый раз;
 *   жёлтый  ровно один и только у «без предела»: очередь на нём встаёт насмерть;
 *   чужое   число (сервер принимает любое) встаёт своей кнопкой в ряду, иначе
 *           ряд выглядит так, будто настройка сломана;
 *   слова   длительности — одной функцией на предложение, лист, полосу запуска
 *           и строку «Остановлен: дольше 30 с»: разойдясь, они начали бы
 *           называть один и тот же предел по-разному;
 *   числа   под выбором предела — по ЗАКОНЧЕННЫМ запускам: у остановленного
 *           пределом длительности нет, там измерен сам предел;
 *   отбор   «с ошибкой» ловит и остановленных: запуск не удался, хотя ошибки в
 *           коде не было.
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

/** Попытка ровно с теми полями, которые читают правила. */
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

/* ------------------------------------------------------------ слова */

test('длительность регламента: секунды, ровные минуты и минуты с секундами', () => {
  assert.equal(pultDuration(5), '5 с')
  assert.equal(pultDuration(30), '30 с')
  assert.equal(pultDuration(60), '1 мин')
  assert.equal(pultDuration(300), '5 мин')
  // Выбирали «1 мин 30 с» — так и читается: округление до «2 мин» соврало бы
  // о настройке, а не о случившемся.
  assert.equal(pultDuration(90), '1 мин 30 с')
  assert.equal(pultDuration(0), '0 с')
  setLocaleResolver(() => 'en')
  assert.equal(pultDuration(30), '30 s')
  assert.equal(pultDuration(90), '1 min 30 s')
  setLocaleResolver(() => 'ru')
})

/* ------------------------------------------------------- предложение */

test('предложение читается по-разному на каждом положении ручки запуска', () => {
  assert.match(sentence({ studentRun: 'request' }), /^Запускают по просьбе · /)
  assert.match(sentence({ studentRun: true }), /^Запускают все по очереди · /)
  assert.match(sentence({ studentRun: false }), /^Запускаю только я · /)
  assert.equal(new Set([
    sentence({ studentRun: false }), sentence({ studentRun: true }), sentence({ studentRun: 'request' }),
  ]).size, 3)
})

test('запускает только преподаватель — куска про повтор в предложении нет вовсе', () => {
  // Не серым и не «повтор сразу»: пауза между запусками у того, кто не
  // запускает, не значит ничего, а лишнее слово в строке читают каждый раз.
  const off = rules({ studentRun: false, rerunPauseSec: 30 })
  assert.deepEqual(off.map((part) => part.rule), ['studentRun', 'runLimit', 'names'])
  for (const run of [true, 'request'] as const) {
    assert.deepEqual(
      rules({ studentRun: run, rerunPauseSec: 30 }).map((part) => part.rule),
      ['studentRun', 'runLimit', 'rerunPause', 'names'],
    )
  }
})

test('в узком окне связки уходят, а «повтор» переезжает внутрь значения', () => {
  const parts = rules({ studentRun: 'request', rerunPauseSec: 30 })
  const pause = parts.find((part) => part.rule === 'rerunPause')!
  assert.equal(pause.value, 'через 30 с')
  assert.equal(pause.short, 'повтор через 30 с', '«через 30 с» без связки читается как второй предел')
  // У остальных короткое и полное совпадают: их значения самодостаточны.
  for (const part of parts.filter((one) => one.rule !== 'rerunPause')) assert.equal(part.short, part.value)
  assert.equal(rules({ studentRun: true, rerunPauseSec: 0 }).find((p) => p.rule === 'rerunPause')!.short, 'повтор сразу')
})

test('без предела — единственное жёлтое значение в предложении', () => {
  const none = rules({ studentRun: true, runLimitSec: null })
  assert.deepEqual(none.filter((part) => part.warn).map((part) => part.rule), ['runLimit'])
  assert.equal(none.find((part) => part.rule === 'runLimit')!.value, 'без предела')
  // С пределом жёлтого нет ни одного: предупреждать не о чем.
  assert.equal(rules({ studentRun: true, runLimitSec: 30 }).some((part) => part.warn), false)
})

test('пауза и имена читаются словами, а не числами и галочками', () => {
  const value = (patch: Partial<CouncilSettings>, rule: string): string =>
    rules(patch).find((part) => part.rule === rule)!.value
  assert.equal(value({ studentRun: true, rerunPauseSec: 0 }, 'rerunPause'), 'сразу')
  assert.equal(value({ studentRun: true, rerunPauseSec: 60 }, 'rerunPause'), 'через 1 мин')
  assert.equal(value({ namesOnProjector: true }, 'names'), 'с именами')
  assert.equal(value({ namesOnProjector: false }, 'names'), 'без имён')
  assert.equal(value({ runLimitSec: 300 }, 'runLimit'), 'до 5 мин')
})

test('чужое число в настройках предложение выговаривает, а не прячет', () => {
  // Сервер принимает любое целое в границах: 90 с могли поставить из другой
  // сборки или прислать историей, и «до 90 с» честнее пустого места.
  assert.equal(rules({ runLimitSec: 90 }).find((part) => part.rule === 'runLimit')!.value, 'до 1 мин 30 с')
  assert.equal(
    rules({ studentRun: true, rerunPauseSec: 45 }).find((part) => part.rule === 'rerunPause')!.value,
    'через 45 с',
  )
})

test('по-английски предложение читается предложением, а не подстрочником', () => {
  setLocaleResolver(() => 'en')
  assert.equal(
    sentence({ studentRun: 'request', runLimitSec: 30, rerunPauseSec: 30, namesOnProjector: true }),
    'Runs on request · each run capped at 30 s · rerun after 30 s · on screen with names',
  )
  assert.equal(sentence({ studentRun: false, runLimitSec: null }), 'Runs by me only · each run uncapped · on screen with names')
  setLocaleResolver(() => 'ru')
})

/* ------------------------------------------------------------- ряды */

test('ряд кнопок всегда показывает действующее значение — даже не из списка', () => {
  assert.deepEqual(limitOptions(30), [...COUNCIL_RUN_LIMITS])
  assert.deepEqual(limitOptions(null), [...COUNCIL_RUN_LIMITS])
  // Своё число встаёт по величине, «без предела» остаётся последним.
  assert.deepEqual(limitOptions(90), [5, 15, 30, 60, 90, 300, null])
  assert.deepEqual(pauseOptions(0), [...COUNCIL_RERUN_PAUSES])
  assert.deepEqual(pauseOptions(45), [0, 15, 30, 45, 60, 120])
  for (const current of [90, 7, 3600]) assert.ok(limitOptions(current).includes(current))
})

/* ------------------------------------------------- сколько считают */

test('числа под пределом — по законченным запускам: медиана и самый долгий', () => {
  const board = [
    attempt('a', { ranMs: 400 }),
    attempt('b', { ranMs: 3100 }),
    attempt('c', { ranMs: 800 }),
  ]
  assert.deepEqual(runStats(board), { median: 800, max: 3100, count: 3 })
  // Чётное число — середина между двумя средними: одно из них выбирать не за что.
  assert.equal(runStats([...board, attempt('d', { ranMs: 1200 })])?.median, 1000)
})

test('идущие, прерванные и остановленные пределом в статистику не попадают', () => {
  /*
   * У идущего длительности ещё нет, у прерванного рукой её не будет (ranMs
   * null), а у остановленного пределом она НЕ НАСТОЯЩАЯ: там измерен сам
   * предел. Иначе медиана ползла бы вверх ровно от того правила, которое по
   * ней и выбирают: поставили 5 с — «обычно 5 с» — поставили 15 с.
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

/* -------------------------------------------- остановленные пределом */

test('остановленные пределом — свежие сверху, по началу запуска', () => {
  const board = [
    attempt('early', { state: 'error', startedAt: 100, timedOut: 30 }),
    attempt('ok', { startedAt: 300 }),
    attempt('late', { state: 'error', startedAt: 200, timedOut: 5 }),
  ]
  assert.deepEqual(timedOutAttempts(board).map((one) => one.participantId), ['late', 'early'])
  assert.deepEqual(timedOutAttempts([attempt('ok', {})]), [])
  // Предел говорит про СВОЙ запуск: регламент с тех пор могли поменять.
  assert.equal(timedOutLimit(board[0]), 30)
  assert.equal(timedOutLimit(board[2]), 5)
  assert.equal(timedOutLimit(board[1]), null)
  assert.equal(timedOutLimit({ run: null }), null)
})

test('остановленный пределом — не «ошибка запуска», но в отбор «с ошибкой» попадает', () => {
  const slow = attempt('slow', { state: 'error', timedOut: 30, ranMs: null })
  const broken = attempt('broken', { state: 'error', ranMs: 120 })
  const badge = attemptExecution(slow)
  assert.equal(badge.tone, 'danger', 'цвет тот же: запуск не удался')
  assert.equal(badge.label, 'Остановлен: дольше 30 с')
  assert.equal(badge.icon, '◷', 'часы вместо крестика: ошибки в коде не было')
  assert.notEqual(badge.label, attemptExecution(broken).label)
  // Отбор ловит и то и другое: чип про неудавшийся запуск, а не про имя ошибки.
  for (const one of [slow, broken]) assert.equal(matchesFilter(one, 'error', new Set()), true)
  assert.equal(matchesFilter(attempt('ok', {}), 'error', new Set()), false)
})

test('«предел 30 с» и «Остановлен: дольше 30 с» говорят одними словами на обоих языках', () => {
  for (const locale of ['ru', 'en'] as const) {
    setLocaleResolver(() => locale)
    const duration = pultDuration(30)
    for (const key of ['room.pult.v2.execution.timedOut', 'room.pult.v2.rules.workTimedOut', 'room.pult.v2.rules.limitLink', 'room.pult.v2.queue.limitStops']) {
      assert.ok(translate(locale, key, { duration }).includes(duration), `${key} (${locale}) называет предел своими словами`)
    }
  }
  setLocaleResolver(() => 'ru')
})
