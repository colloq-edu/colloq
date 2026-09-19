/**
 * Пауза между запусками у студента: отсчёт на месте кнопки.
 *
 * Правило держит сервер (`CouncilSettings.rerunPauseSec`), но кнопка, которая
 * молча получает отказ, читается как поломка связи — поэтому на её месте стоит
 * отсчёт, а `CouncilMine.nextRunAt` возит секунду, с которой можно снова.
 *
 * Ломается такой отсчёт тихо, и проверяется здесь ровно это:
 *
 *   — часы. `nextRunAt` отмерен СЕРВЕРОМ, а тикает браузер. Без поправки
 *     ноутбук, ушедший на минуту вперёд, показывает минуту лишней паузы; без
 *     потолка в само правило — вкладка, не успевшая получить первый понг
 *     (поправка ещё ноль), рисует «Запуск через 8:03» там, где преподаватель
 *     поставил тридцать секунд;
 *   — ноль. Пауза, снятая преподавателем, обязана погасить отсчёт той же
 *     секундой, не дожидаясь свежего листа;
 *   — цифра. Округление вниз держало бы «0:00» целую секунду — отсчёт, замерший
 *     на нуле, читается как зависший ровно тогда, когда он работает.
 *
 * И разметка подвала: отсчёт стоит В ТОМ ЖЕ месте, что «В очереди: 3», клавиша
 * запуска во время паузы на сервер не ходит, а у остановленного пределом
 * запуска нет кнопки оракула — подсказывать по серверному пределу нечего.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate } from '../shared/i18n.js'
import { COUNCIL_RERUN_PAUSE_MAX, DEFAULT_COUNCIL } from '../shared/notebook.js'
import { pauseClock, pauseLeftMs, pausePending } from '../web/src/lib/council-pause.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const NOW = 1_800_000_000_000

/* ------------------------------------------------------------ остаток */

test('остаток считается от серверных часов, а не от часов ноутбука', () => {
  // Часы браузера совпали с серверными: двенадцать секунд и есть двенадцать.
  assert.equal(pauseLeftMs(NOW + 12_000, NOW, 0, 30), 12_000)
  // Браузер ушёл на минуту ВПЕРЁД: без поправки остаток был бы отрицательным и
  // кнопка вернулась бы, пока сервер ещё отказывает.
  assert.equal(pauseLeftMs(NOW + 12_000, NOW + 60_000, 60_000, 30), 12_000)
  // И на минуту НАЗАД: без поправки отсчёт показывал бы минуту с лишним.
  assert.equal(pauseLeftMs(NOW + 12_000, NOW - 60_000, -60_000, 30), 12_000)
})

test('дольше самого правила отсчёт не показывает никогда', () => {
  // Поправка ещё ноль (первый понг не доехал), часы вкладки на четверть суток
  // вперёд… а пауза всё равно не больше тридцати секунд.
  assert.equal(pauseLeftMs(NOW + 6 * 3600_000, NOW, 0, 30), 30_000)
  // Потолок — само правило, каким бы оно ни было.
  assert.equal(pauseLeftMs(NOW + 6 * 3600_000, NOW, 0, 120), 120_000)
  assert.equal(
    pauseLeftMs(NOW + 10 * 3600_000, NOW, 0, COUNCIL_RERUN_PAUSE_MAX),
    COUNCIL_RERUN_PAUSE_MAX * 1000,
  )
  // Ошибается он в сторону сервера: кнопка вернётся раньше, а не позже.
  assert.ok(pauseLeftMs(NOW + 90_000, NOW, 0, 30) < 90_000)
})

test('паузы нет — нуль, и молча: ни NaN, ни отрицательных', () => {
  assert.equal(pauseLeftMs(null, NOW, 0, 30), 0, 'сервер паузы не назначал')
  assert.equal(pauseLeftMs(undefined, NOW, 0, 30), 0, 'старый сервер поля не шлёт')
  assert.equal(pauseLeftMs(NOW - 1, NOW, 0, 30), 0, 'секунда прошла')
  assert.equal(pauseLeftMs(NOW, NOW, 0, 30), 0, 'ровно та секунда — уже можно')
  // Правило снято прямо сейчас: лист со старым `nextRunAt` ещё не переехал, а
  // отсчёта уже нет — кнопка на месте той же секундой.
  assert.equal(pauseLeftMs(NOW + 25_000, NOW, 0, 0), 0)
  assert.equal(DEFAULT_COUNCIL.rerunPauseSec, 0, 'умолчание регламента — без паузы')
  // Мусор в числах значит «паузы нет», а не «пауза навсегда».
  assert.equal(pauseLeftMs(Number.NaN, NOW, 0, 30), 0)
  assert.equal(pauseLeftMs(NOW + 12_000, Number.NaN, 0, 30), 0)
  assert.equal(pauseLeftMs(NOW + 12_000, NOW, 0, Number.NaN), 0)
})

test('«идёт ли пауза» — тот же счёт, одним словом', () => {
  assert.equal(pausePending(NOW + 1, NOW, 0, 30), true)
  assert.equal(pausePending(NOW, NOW, 0, 30), false)
  assert.equal(pausePending(NOW + 25_000, NOW, 0, 0), false)
  assert.equal(pausePending(null, NOW, 0, 30), false)
})

/* -------------------------------------------------------------- цифра */

test('m:ss с округлением вверх: «0:00» не показывается никогда', () => {
  assert.equal(pauseClock(12_000), '0:12')
  assert.equal(pauseClock(11_001), '0:12', 'вниз показало бы 0:11 раньше времени')
  assert.equal(pauseClock(1), '0:01', 'последний миг — всё ещё секунда')
  assert.equal(pauseClock(60_000), '1:00')
  assert.equal(pauseClock(59_999), '1:00')
  assert.equal(pauseClock(65_500), '1:06')
  assert.equal(pauseClock(9_000), '0:09', 'секунды всегда двумя знаками')
  // Ноль бывает только настоящим нулём, и чипа в этот момент уже нет.
  assert.equal(pauseClock(0), '0:00')
  assert.equal(pauseClock(-5_000), '0:00')
  // Потолок паузы — час, и он остаётся в минутах: часов в чипе нет.
  assert.equal(pauseClock(COUNCIL_RERUN_PAUSE_MAX * 1000), '60:00')
})

test('чип собирается из каталога, а не из склеенных слов', () => {
  assert.equal(translate('ru', 'room.council.nextRun', { p0: pauseClock(12_000) }), 'Запуск через 0:12')
  assert.equal(translate('en', 'room.council.nextRun', { p0: pauseClock(12_000) }), 'Run in 0:12')
  // Подсказка объясняет ПРАВИЛО, а не отказ: ядро у тетради одно на всех.
  assert.match(translate('ru', 'room.council.nextRunWhy'), /правило преподавателя/)
  assert.match(translate('ru', 'room.council.nextRunWhy'), /ядро у тетради одно/)
})

/* ------------------------------------------------------------ подвал */

const CELL = code(read('web/src/components/notebook/CellView.svelte'))
const SHEET = CELL.slice(CELL.indexOf('{#if ownSheet && sheet}'), CELL.indexOf('{:else if showEditor}'))
const FOOTER = SHEET.slice(SHEET.indexOf('<span class="ml-auto flex'))

test('отсчёт стоит на месте кнопки — в одной цепочке с очередью', () => {
  // Ровно одна ветка между ожиданием и кнопкой: иначе отсчёт оказался бы РЯДОМ
  // с живой кнопкой, то есть предлагал бы нажать её ещё раз.
  assert.match(
    FOOTER,
    /\{#if runWaiting\}[\s\S]*?\{:else if runPaused\}[\s\S]*?\{:else if mayRunAttempt \|\| mayRequestRun\}/,
    'отсчёт не встал на место кнопки',
  )
  // И только там, где кнопка вообще была бы: не у сданной, не в очереди и не
  // там, где запускает преподаватель.
  assert.match(
    CELL,
    /const runPaused = \$derived\(\s*pauseLeft > 0 && submittedAt === null && !runWaiting && \(mayRunAttempt \|\| mayRequestRun\),\s*\)/,
  )
  // Тот же чип, что «В очереди», и тот же рост — но приглушённый: это правило,
  // а не тревога и не акцентное ожидание.
  assert.match(FOOTER, /tr\('room\.council\.nextRun', \{ p0: pauseClock\(pauseLeft\) \}\)/)
  assert.match(FOOTER, /'inline-flex h-7 items-center border px-3 tabular-nums'/)
  assert.match(FOOTER, /'border-line text-muted'/)
  assert.doesNotMatch(
    FOOTER.slice(FOOTER.indexOf('{:else if runPaused}'), FOOTER.indexOf('{:else if mayRunAttempt')),
    /text-accent-text|border-accent|text-danger|text-warning/,
    'пауза покрасилась в тревогу или в акцент очереди',
  )
  // Причина — подсказкой, и она же в имени: диктору цифру не читают каждую
  // секунду, но, дойдя до чипа, он говорит и остаток, и правило.
  assert.match(FOOTER, /title=\{tr\('room\.council\.nextRunWhy'\)\}/)
  assert.match(FOOTER, /aria-live="off"/)
  assert.match(FOOTER, /aria-label=\{`\$\{tr\('room\.council\.nextRun'[\s\S]*?room\.council\.nextRunWhy'\)\}`\}/)
})

test('кнопка возвращается тиком, а тик живёт только во время паузы', () => {
  // Часы — серверные: поправка вкладки и потолок из регламента ячейки.
  assert.match(
    CELL,
    /pauseLeftMs\(mine\?\.nextRunAt, pauseNow, session\.clockSkewMs, councilSettings\.rerunPauseSec\)/,
  )
  assert.match(read('web/src/lib/session.svelte.ts'), /clockSkewMs = \$state\(0\)/)
  // Интервал заводится от самой паузы и снимается, когда она вышла: сорок
  // ячеек консилиума не должны держать сорок таймеров до конца пары.
  assert.match(CELL, /const pauseTicking = \$derived\(pauseLeft > 0\)/)
  const tick = CELL.slice(CELL.indexOf('const pauseTicking'), CELL.indexOf('const runPaused'))
  assert.match(tick, /if \(!pauseTicking\) return/)
  assert.match(tick, /window\.setInterval\(\(\) => \(pauseNow = Date\.now\(\)\), 500\)/)
  assert.match(tick, /return \(\) => window\.clearInterval\(id\)/, 'таймер переживает ячейку')
})

test('⇧↵ во время паузы не ходит на сервер, а мигает отсчётом', () => {
  const key = CELL.slice(CELL.indexOf('function sheetRunKey'), CELL.indexOf('$effect(() => () => window.clearTimeout(runHintTimer))'))
  // Пауза — раньше обеих веток запуска: ни `council:run`, ни просьбы.
  assert.match(key, /if \(runPaused\) \{\s*nudgePause\(\)\s*return\s*\}/)
  for (const sends of ['requestAttemptRun()', 'runAttempt()']) {
    assert.ok(
      key.indexOf('if (runPaused)') < key.indexOf(sends),
      `клавиша успевает вызвать ${sends} до проверки паузы`,
    )
  }
  assert.doesNotMatch(key, /showError/, 'отказ тостом поверх набора')
  // Вспышка — та же, что у кнопки сдачи на ⌘⇧↵, и гаснет сама.
  const nudge = CELL.slice(CELL.indexOf('function nudgePause'), CELL.indexOf('function nudgePause') + 300)
  assert.match(nudge, /pauseNudge = true/)
  assert.match(nudge, /setTimeout\(\(\) => \(pauseNudge = false\), FLASH_MS\)/)
  assert.match(CELL, /const FLASH_MS = 260/)
  assert.match(CELL, /\$effect\(\(\) => \(\) => window\.clearTimeout\(nudgeTimer\)\)/)
  // И чип показывает вспышку одной парой классов: два `text-*` рядом решал бы
  // порядок в собранном CSS, а не порядок здесь.
  assert.match(FOOTER, /pauseNudge \? 'border-ink text-ink' : 'border-line text-muted'/)
})

/* ------------------------------------------------- остановленный запуск */

test('остановленный пределом запуск — обычная неудача, без подсказки оракула', () => {
  // Сервер кладёт причину в сам вывод попытки, поэтому у подвала новых слов
  // нет: `state` остаётся 'error', и красная подложка берётся из него.
  assert.match(SHEET, /attemptRun\.state === 'error' \? 'bg-danger\/5' : 'bg-canvas'/)
  assert.doesNotMatch(CELL, /TimeLimit/, 'подвал разбирает вывод по имени ошибки')
  assert.doesNotMatch(SHEET, /\bename\b/, 'чип состояния смотрит на имя исключения')
  // А кнопки оракула у него нет: трейсбека не существует, и модели остаётся
  // гадать по тексту попытки — то есть решать за студента.
  assert.match(
    CELL,
    /const mayHint = \$derived\(\s*!councilClosed &&\s*mine\?\.run\?\.state === 'error' &&\s*!mine\.run\.timedOut &&/,
  )
  assert.match(read('shared/protocol.ts'), /timedOut\?: number/)
})
