/**
 * Слова и числа страниц участника (P1–P4) — без браузера.
 *
 * Всё, что здесь проверяется, на экране выглядит одинаково правдоподобно при
 * любом ответе: «0.046» вместо «0.0455» — это другое место в лидерборде,
 * «1 ч» вместо «1 ч 12 мин» — это пропущенный дедлайн, зелёный этап вместо
 * текущего — это «где оно стоит?» вместо «оно идёт». Поймать такое глазами
 * нельзя, поэтому каждое правило стоит своей строкой.
 *
 * Английский проверяется наравне с русским: каталог обязан вести обе стороны,
 * и `{count}` в двух языках выбирает форму разными правилами.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { setLocaleResolver } from '../shared/i18n.js'
import type { EntrantSubmission } from '../shared/competitions.js'
import type { SubmissionLive } from '../shared/competitions-entrant.js'
import {
  avatarLetter,
  avatarTint,
  AVATAR_TINTS,
  boardPlaces,
  clockOf,
  dateOf,
  deadlineNote,
  deadlineUrgent,
  elapsedClock,
  fileSize,
  formatScore,
  metricArrow,
  ordinalPlace,
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
  URGENT_MS,
  whenWords,
} from '../web/src/lib/competition-words.js'

afterEach(() => setLocaleResolver(() => 'ru'))

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Двадцатое сентября, 18:40 по часам читателя — время всех подписей ниже. */
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

/* ------------------------------------------------------------------ число */

test('метрика держит значащие цифры, а не число знаков', () => {
  assert.equal(formatScore(0.0455), '0.0455')
  assert.equal(formatScore(0.7034), '0.7034')
  // Тысячи рублей RMSE: четыре знака после точки тут — шум, который ломает колонку.
  assert.equal(formatScore(1234.5), '1234.50')
  assert.equal(formatScore(-0.5), '-0.5000')
  assert.equal(formatScore(0), '0.0000')
  // Миллионные доли и миллионы — экспонентой: иначе это «0.0000» и «1200000.00».
  assert.equal(formatScore(0.0000012), '1.20e-6')
  assert.equal(formatScore(2_500_000), '2.50e+6')
  // Числа, которого нет, быть не должно: метрика, поделившая на ноль, не упала.
  assert.equal(formatScore(Number.NaN), '—')
  assert.equal(formatScore(Number.POSITIVE_INFINITY), '—')
  assert.equal(formatScore(null), '—')
  assert.equal(formatScore(undefined), '—')
})

test('место — порядковым, и в английском по его собственным правилам', () => {
  assert.equal(ordinalPlace(7), '7-й')
  assert.equal(ordinalPlace(11), '11-й')
  assert.equal(scoreWithPlace(0.0412, 1), '0.0412 · 1-й')
  assert.equal(scoreWithPlace(0.0412, null), '0.0412')
  // На P1 порядок обратный: человек ищет в карточке своё МЕСТО, а не число.
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

test('метрика со стрелкой — знак направления, а не перевод', () => {
  assert.equal(metricArrow('MAPE', 'lower'), 'MAPE ↓')
  assert.equal(metricArrow('ROC AUC', 'higher'), 'ROC AUC ↑')
  setLocaleResolver(() => 'en')
  assert.equal(metricArrow('MAPE', 'lower'), 'MAPE ↓')
})

/* ------------------------------------------------------------------ время */

test('законченная длительность: секунды, минуты с секундами, часы без секунд', () => {
  assert.equal(spellDuration(41_000), '41 с')
  assert.equal(spellDuration(171_000), '2 мин 51 с')
  assert.equal(spellDuration(6 * MINUTE), '6 мин')
  assert.equal(spellDuration(HOUR + 12 * MINUTE + 3000), '1 ч 12 мин')
  assert.equal(spellDuration(null), '—')
  setLocaleResolver(() => 'en')
  assert.equal(spellDuration(171_000), '2 min 51 s')
})

test('остаток до дедлайна: два разряда словами и часами', () => {
  assert.equal(remainingWords(6 * DAY + 4 * HOUR + 12 * MINUTE), '6 дн 4 ч')
  assert.equal(remainingWords(HOUR + 12 * MINUTE), '1 ч 12 мин')
  assert.equal(remainingWords(12 * MINUTE), '12 мин')
  assert.equal(remainingWords(30_000), 'меньше минуты')
  assert.equal(remainingWords(0), 'приём закрыт')

  assert.equal(remainingClock(6 * DAY + 4 * HOUR + 12 * MINUTE), '6 дн 04:12')
  assert.equal(remainingClock(4 * HOUR + 12 * MINUTE), '04:12')
  assert.equal(remainingClock(7 * MINUTE), '00:07')
  assert.equal(remainingClock(-1), '00:00')
})

test('секундомер прогона идёт минутами, а часы появляются, только если нужны', () => {
  assert.equal(elapsedClock(72_000), '01:12')
  assert.equal(elapsedClock(600_000), '10:00')
  assert.equal(elapsedClock(0), '00:00')
  assert.equal(elapsedClock(3 * HOUR + 4 * MINUTE + 5000), '3:04:05')
})

test('дедлайн горит за шесть часов, и ни минутой раньше', () => {
  assert.equal(deadlineUrgent(NOW + URGENT_MS - MINUTE, NOW), true)
  assert.equal(deadlineUrgent(NOW + URGENT_MS + MINUTE, NOW), false)
  // Прошедший дедлайн не тревога, а факт: он уже ничем не поможет.
  assert.equal(deadlineUrgent(NOW - MINUTE, NOW), false)
  assert.equal(deadlineUrgent(null, NOW), false)
})

test('подпись под таймером различает «сегодня» и дату', () => {
  const todayAt21 = new Date(2026, 8, 20, 21, 0).getTime()
  const later = new Date(2026, 8, 27, 23, 59).getTime()
  assert.equal(deadlineNote(todayAt21, NOW), `сегодня до ${clockOf(todayAt21)}`)
  assert.equal(deadlineNote(later, NOW), `до 27.09, ${clockOf(later)}`)
  assert.equal(deadlineNote(null, NOW), 'без дедлайна')
  assert.equal(deadlineNote(NOW - HOUR, NOW), 'приём закрыт')
  assert.equal(dateOf(later), '27.09')
})

test('«Сегодня в 18:40», «Вчера в 22:14», дата — раньше', () => {
  const yesterday = new Date(2026, 8, 19, 22, 14).getTime()
  const older = new Date(2026, 8, 13, 20, 5).getTime()
  assert.equal(whenWords(NOW, NOW), `Сегодня в ${clockOf(NOW)}`)
  assert.equal(whenWords(yesterday, NOW), `Вчера в ${clockOf(yesterday)}`)
  assert.equal(whenWords(older, NOW), `13.09 в ${clockOf(older)}`)
  assert.equal(sameDay(NOW, NOW + MINUTE), true)
  assert.equal(sameDay(NOW, NOW + DAY), false)
})

/* ------------------------------------------------------------ полоса этапов */

test('полоса этапов красит пройденное, текущее и будущее', () => {
  const running = stageStrip('running', 'notebook')
  assert.deepEqual(
    running.map((cell) => cell.position),
    ['done', 'done', 'current', 'ahead', 'ahead'],
  )
  assert.deepEqual(running.map((cell) => cell.word), [
    'ПРИНЯТА',
    'ОЧЕРЕДЬ',
    'ЗАПУСК ТЕТРАДИ',
    'ПРОВЕРКА CSV',
    'ОЦЕНКА',
  ])
  // Дошедшая до числа зелена целиком: «ОЦЕНКА» у неё пройдена, а не идёт.
  assert.deepEqual(
    stageStrip('scored', 'score').map((cell) => cell.position),
    ['done', 'done', 'done', 'done', 'done'],
  )
  // Упавшая оставляет текущим тот этап, на котором умерла: там и причина.
  assert.deepEqual(
    stageStrip('notebookFailed', 'notebook').map((cell) => cell.position),
    ['done', 'done', 'current', 'ahead', 'ahead'],
  )
})

test('полоса прогресса считает ячейками, а без них — этапами, и никогда не нулём', () => {
  assert.equal(runProgress(live({ cellsDone: 9, cellsTotal: 14 })), 63)
  assert.equal(runProgress(live({ cellsDone: 0, cellsTotal: 14 })), 5)
  assert.equal(runProgress(live({ cellsDone: 14, cellsTotal: 14 })), 95)
  // Число ячеек ещё неизвестно — полоса показывает этап, а не ноль: ноль под
  // словом «ВЫПОЛНЯЕТСЯ» читается как «висит».
  assert.equal(runProgress(live({ stage: 'queue', cellsTotal: 0 })), 40)
  assert.equal(runProgress(live({ stage: 'score', cellsTotal: 0 })), 100)
})

/* ---------------------------------------------------------------- очередь */

test('место в очереди — словом до десятого и числом дальше', () => {
  assert.equal(queueOrdinal(1), 'Первая')
  assert.equal(queueOrdinal(3), 'Третья')
  assert.equal(queueOrdinal(10), 'Десятая')
  assert.equal(queueOrdinal(11), '11-я')
  setLocaleResolver(() => 'en')
  assert.equal(queueOrdinal(3), 'Third')
  assert.equal(queueOrdinal(11), '11th')
})

test('подпись ждущей посылки называет только СВОЮ посылку впереди', () => {
  assert.equal(
    queueNote({ place: 3, aheadNumber: 12, paused: false }),
    'Третья в очереди · запуск после завершения посылки #12',
  )
  // Телефон короче на одно слово — так в макете P4.
  assert.equal(
    queueNote({ place: 3, aheadNumber: 12, paused: false, short: true }),
    'Третья в очереди · запуск после посылки #12',
  )
  // Впереди чужие: их номера участнику не показывают вовсе.
  assert.equal(queueNote({ place: 3, aheadNumber: null, paused: false }), 'Третья в очереди')
  assert.equal(
    queueNote({ place: 1, aheadNumber: null, paused: true }),
    'Первая в очереди · очередь приостановлена преподавателем',
  )
})

/* ------------------------------------------------------- строки посылок */

test('первая фраза отказа уходит в заголовок, остальное — в подпись', () => {
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

test('идущая посылка: ячейка, время отправки и ожидание в очереди', () => {
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

test('идущая посылка на телефоне: одна фраза вместо полосы этапов', () => {
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

test('готовая посылка: лучшая — без слова «выполнена», прочие — с ним', () => {
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
  // Телефон длительности не показывает вовсе — так в макете P4.
  const phone = rowWords({ submission: submission(), live: null, best: true, paused: false, now: NOW, phone: true })
  assert.equal(phone.lines[0], `Сегодня в ${clockOf(NOW - 3 * MINUTE)} · лучший результат`)
})

test('упавшая тетрадь называет ячейку и время, отвергнутый ответ — причину', () => {
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
  // Заголовок — причина, а не имя файла: участнику важнее, чем ответ не подошёл.
  assert.equal(rejected.title, 'Не для всех строк test.csv есть прогноз.')
  assert.ok(rejected.lines[0].includes('naive_week.ipynb'))
  assert.equal(rejected.lines[1], 'В submission.csv 391 строка вместо 397.')
})

test('упавшая метрика — фраза про проверяющий код, а не обвинение участнику', () => {
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

test('снятая посылка говорит, что сняли её вы', () => {
  const words = rowWords({
    submission: submission({ state: 'cancelled', publicScore: null, durationMs: null }),
    live: null,
    best: false,
    paused: false,
    now: NOW,
  })
  assert.match(words.lines[0], /снята вами$/)
})

test('ждущая посылка берёт подпись из очереди', () => {
  const words = rowWords({
    submission: submission({ state: 'queued', stage: 'queue', publicScore: null, durationMs: null }),
    live: live({ place: 3, etaMs: 6 * MINUTE, aheadNumber: 12 }),
    best: false,
    paused: false,
    now: NOW,
  })
  assert.equal(words.lines[0], 'Третья в очереди · запуск после завершения посылки #12')
})

/* --------------------------------------------------------------- места */

test('в таблице места считают людей, а базовое решение встаёт туда, где стоит', () => {
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
  // Бейзлайн впереди всех — места не занимает вовсе: «1» у него рядом с «1» у
  // человека читается как ничья, которой нет, а шапка при этом говорит «1 из 2».
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

/* ------------------------------------------------------- файлы и аватары */

test('размер файла: байты, килобайты, мегабайты с одной десятой до десяти', () => {
  assert.equal(fileSize(512), '512 Б')
  assert.equal(fileSize(6 * 1024), '6 КБ')
  assert.equal(fileSize(212 * 1024), '212 КБ')
  assert.match(fileSize(4.1 * 1024 * 1024), /^4,1 МБ$/)
  assert.match(fileSize(40 * 1024 * 1024), /^40 МБ$/)
  setLocaleResolver(() => 'en')
  assert.equal(fileSize(6 * 1024), '6 KB')
})

test('кружок участника: цвет из имени, буква из имени, имя — сокращением', () => {
  assert.ok(AVATAR_TINTS.includes(avatarTint('Тимур Ахметов')))
  // Один и тот же человек — один и тот же цвет на всех устройствах.
  assert.equal(avatarTint('Тимур Ахметов'), avatarTint('Тимур Ахметов'))
  assert.notEqual(avatarTint('Тимур Ахметов'), avatarTint('Марфа Соколова'))
  assert.equal(avatarLetter('тимур'), 'Т')
  assert.equal(avatarLetter('  '), '?')
  assert.equal(shortName('Тимур Ахметов'), 'Тимур А.')
  assert.equal(shortName('Платон'), 'Платон')
})
