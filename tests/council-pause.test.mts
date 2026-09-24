/**
 * The pause between a student's runs: a countdown in place of the button.
 *
 * The server holds the rule (`CouncilSettings.rerunPauseSec`), but a button
 * that silently gets refused reads as a broken connection — so a countdown
 * stands in its place, and `CouncilMine.nextRunAt` carries the second from
 * which running is allowed again.
 *
 * Such a countdown breaks quietly, and exactly this is checked here:
 *
 *   — the clock. `nextRunAt` is measured by the SERVER, while the browser
 *     does the ticking. Without a correction, a laptop running a minute fast
 *     shows a minute of extra pause; without a cap at the rule itself, a tab
 *     that has not yet received its first pong (the correction is still zero)
 *     draws "Run in 8:03" where the teacher set thirty seconds;
 *   — zero. A pause removed by the teacher must switch the countdown off in
 *     the same second, without waiting for a fresh sheet;
 *   — the digits. Rounding down would hold "0:00" for a whole second — a
 *     countdown frozen at zero reads as hung exactly when it is working.
 *
 * And the footer markup: the countdown stands IN THE SAME place as
 * "Queued: 3", the run key does not go to the server during the pause, and a
 * run stopped by the limit has no oracle button — there is nothing to hint
 * about for a server-side limit.
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

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const NOW = 1_800_000_000_000

/* ---------------------------------------------------------- remainder */

test('the remainder is counted from the server clock, not the laptop clock', () => {
  // The browser clock matches the server's: twelve seconds are twelve.
  assert.equal(pauseLeftMs(NOW + 12_000, NOW, 0, 30), 12_000)
  // The browser is a minute AHEAD: without the correction the remainder would
  // be negative and the button would come back while the server still
  // refuses.
  assert.equal(pauseLeftMs(NOW + 12_000, NOW + 60_000, 60_000, 30), 12_000)
  // And a minute BEHIND: without the correction the countdown would show a
  // minute and more.
  assert.equal(pauseLeftMs(NOW + 12_000, NOW - 60_000, -60_000, 30), 12_000)
})

test('the countdown never shows more than the rule itself', () => {
  // The correction is still zero (the first pong has not arrived), the tab's
  // clock is a quarter of a day ahead… and the pause is still no more than
  // thirty seconds.
  assert.equal(pauseLeftMs(NOW + 6 * 3600_000, NOW, 0, 30), 30_000)
  // The cap is the rule itself, whatever it is.
  assert.equal(pauseLeftMs(NOW + 6 * 3600_000, NOW, 0, 120), 120_000)
  assert.equal(
    pauseLeftMs(NOW + 10 * 3600_000, NOW, 0, COUNCIL_RERUN_PAUSE_MAX),
    COUNCIL_RERUN_PAUSE_MAX * 1000,
  )
  // It errs on the server's side: the button comes back earlier, not later.
  assert.ok(pauseLeftMs(NOW + 90_000, NOW, 0, 30) < 90_000)
})

test('no pause — zero, and silently: no NaN, no negatives', () => {
  assert.equal(pauseLeftMs(null, NOW, 0, 30), 0, 'the server did not set a pause')
  assert.equal(pauseLeftMs(undefined, NOW, 0, 30), 0, 'an old server does not send the field')
  assert.equal(pauseLeftMs(NOW - 1, NOW, 0, 30), 0, 'the second has passed')
  assert.equal(pauseLeftMs(NOW, NOW, 0, 30), 0, 'exactly that second — already allowed')
  // The rule was removed just now: the sheet with the old `nextRunAt` has not
  // arrived yet, but the countdown is already gone — the button is back in
  // the same second.
  assert.equal(pauseLeftMs(NOW + 25_000, NOW, 0, 0), 0)
  assert.equal(DEFAULT_COUNCIL.rerunPauseSec, 0, 'the rules default is no pause')
  // Garbage in the numbers means "no pause", not "pause forever".
  assert.equal(pauseLeftMs(Number.NaN, NOW, 0, 30), 0)
  assert.equal(pauseLeftMs(NOW + 12_000, Number.NaN, 0, 30), 0)
  assert.equal(pauseLeftMs(NOW + 12_000, NOW, 0, Number.NaN), 0)
})

test('"is a pause on" is the same count, in one word', () => {
  assert.equal(pausePending(NOW + 1, NOW, 0, 30), true)
  assert.equal(pausePending(NOW, NOW, 0, 30), false)
  assert.equal(pausePending(NOW + 25_000, NOW, 0, 0), false)
  assert.equal(pausePending(null, NOW, 0, 30), false)
})

/* ------------------------------------------------------------- digits */

test('m:ss rounded up: "0:00" is never shown', () => {
  assert.equal(pauseClock(12_000), '0:12')
  assert.equal(pauseClock(11_001), '0:12', 'rounding down would show 0:11 too early')
  assert.equal(pauseClock(1), '0:01', 'the last instant is still a second')
  assert.equal(pauseClock(60_000), '1:00')
  assert.equal(pauseClock(59_999), '1:00')
  assert.equal(pauseClock(65_500), '1:06')
  assert.equal(pauseClock(9_000), '0:09', 'seconds always have two digits')
  // Zero only happens as a real zero, and by then the chip is gone.
  assert.equal(pauseClock(0), '0:00')
  assert.equal(pauseClock(-5_000), '0:00')
  // The pause cap is an hour, and it stays in minutes: the chip has no hours.
  assert.equal(pauseClock(COUNCIL_RERUN_PAUSE_MAX * 1000), '60:00')
})

test('the chip is built from the catalogue, not from glued words', () => {
  assert.equal(translate('ru', 'room.council.nextRun', { p0: pauseClock(12_000) }), 'Запуск через 0:12')
  assert.equal(translate('en', 'room.council.nextRun', { p0: pauseClock(12_000) }), 'Run in 0:12')
  // The hint explains the RULE, not the refusal: a notebook has one kernel
  // for everyone.
  assert.match(translate('ru', 'room.council.nextRunWhy'), /правило преподавателя/)
  assert.match(translate('ru', 'room.council.nextRunWhy'), /ядро у тетради одно/)
})

/* ------------------------------------------------------------ footer */

const CELL = code(read('web/src/components/notebook/CellView.svelte'))
const SHEET = CELL.slice(CELL.indexOf('{#if ownSheet && sheet}'), CELL.indexOf('{:else if showEditor}'))
const FOOTER = SHEET.slice(SHEET.indexOf('<span class="ml-auto flex'))

test('the countdown stands in place of the button — in one chain with the queue', () => {
  // Exactly one branch between waiting and the button: otherwise the
  // countdown would end up NEXT TO a live button, that is, it would invite
  // pressing it once more.
  assert.match(
    FOOTER,
    /\{#if runWaiting\}[\s\S]*?\{:else if runPaused\}[\s\S]*?\{:else if mayRunAttempt \|\| mayRequestRun\}/,
    'the countdown did not take the button\'s place',
  )
  // And only where the button would be at all: not on a submitted sheet, not
  // in the queue and not where the teacher runs.
  assert.match(
    CELL,
    /const runPaused = \$derived\(\s*pauseLeft > 0 && submittedAt === null && !runWaiting && \(mayRunAttempt \|\| mayRequestRun\),\s*\)/,
  )
  // The same chip as "Queued" and the same height — but muted: this is a
  // rule, not an alarm and not an accented wait.
  assert.match(FOOTER, /tr\('room\.council\.nextRun', \{ p0: pauseClock\(pauseLeft\) \}\)/)
  assert.match(FOOTER, /'inline-flex h-7 items-center border px-3 tabular-nums'/)
  assert.match(FOOTER, /'border-line text-muted'/)
  assert.doesNotMatch(
    FOOTER.slice(FOOTER.indexOf('{:else if runPaused}'), FOOTER.indexOf('{:else if mayRunAttempt')),
    /text-accent-text|border-accent|text-danger|text-warning/,
    'the pause got painted as an alarm or as the queue accent',
  )
  // The reason goes in a tooltip, and in the name as well: a screen reader
  // does not announce the digits every second, but once it reaches the chip
  // it speaks both the remainder and the rule.
  assert.match(FOOTER, /title=\{tr\('room\.council\.nextRunWhy'\)\}/)
  assert.match(FOOTER, /aria-live="off"/)
  assert.match(FOOTER, /aria-label=\{`\$\{tr\('room\.council\.nextRun'[\s\S]*?room\.council\.nextRunWhy'\)\}`\}/)
})

test('the button comes back on a tick, and the tick lives only during a pause', () => {
  // The clock is the server's: the tab's correction and the cap from the
  // cell's rules.
  assert.match(
    CELL,
    /pauseLeftMs\(mine\?\.nextRunAt, pauseNow, session\.clockSkewMs, councilSettings\.rerunPauseSec\)/,
  )
  assert.match(read('web/src/lib/session.svelte.ts'), /clockSkewMs = \$state\(0\)/)
  // The interval is started by the pause itself and removed when it is over:
  // forty council cells must not hold forty timers until the end of the
  // class.
  assert.match(CELL, /const pauseTicking = \$derived\(pauseLeft > 0\)/)
  const tick = CELL.slice(CELL.indexOf('const pauseTicking'), CELL.indexOf('const runPaused'))
  assert.match(tick, /if \(!pauseTicking\) return/)
  assert.match(tick, /window\.setInterval\(\(\) => \(pauseNow = Date\.now\(\)\), 500\)/)
  assert.match(tick, /return \(\) => window\.clearInterval\(id\)/, 'the timer outlives the cell')
})

test('⇧↵ during a pause does not go to the server but flashes the countdown', () => {
  const key = CELL.slice(CELL.indexOf('function sheetRunKey'), CELL.indexOf('$effect(() => () => window.clearTimeout(runHintTimer))'))
  // The pause comes before both run branches: neither `council:run` nor a
  // request.
  assert.match(key, /if \(runPaused\) \{\s*nudgePause\(\)\s*return\s*\}/)
  for (const sends of ['requestAttemptRun()', 'runAttempt()']) {
    assert.ok(
      key.indexOf('if (runPaused)') < key.indexOf(sends),
      `the key manages to call ${sends} before the pause check`,
    )
  }
  assert.doesNotMatch(key, /showError/, 'a refusal as a toast on top of the typing')
  // The flash is the same as the submit button's on ⌘⇧↵, and it fades by
  // itself.
  const nudge = CELL.slice(CELL.indexOf('function nudgePause'), CELL.indexOf('function nudgePause') + 300)
  assert.match(nudge, /pauseNudge = true/)
  assert.match(nudge, /setTimeout\(\(\) => \(pauseNudge = false\), FLASH_MS\)/)
  assert.match(CELL, /const FLASH_MS = 260/)
  assert.match(CELL, /\$effect\(\(\) => \(\) => window\.clearTimeout\(nudgeTimer\)\)/)
  // And the chip shows the flash with a single pair of classes: with two
  // `text-*` side by side the order in the built CSS would decide, not the
  // order here.
  assert.match(FOOTER, /pauseNudge \? 'border-ink text-ink' : 'border-line text-muted'/)
})

/* -------------------------------------------------------- a stopped run */

test('a run stopped by the limit is an ordinary failure, without an oracle hint', () => {
  // The server puts the reason into the attempt's output itself, so the
  // footer has no new words: `state` stays 'error', and the red background
  // comes from it.
  assert.match(SHEET, /attemptRun\.state === 'error' \? 'bg-danger\/5' : 'bg-canvas'/)
  assert.doesNotMatch(CELL, /TimeLimit/, 'the footer parses the output by the error name')
  assert.doesNotMatch(SHEET, /\bename\b/, 'the state chip looks at the exception name')
  // And it has no oracle button: there is no traceback, and the model would
  // be left guessing from the attempt's text — that is, solving it for the
  // student.
  assert.match(
    CELL,
    /const mayHint = \$derived\(\s*!councilClosed &&\s*mine\?\.run\?\.state === 'error' &&\s*!mine\.run\.timedOut &&/,
  )
  assert.match(read('shared/protocol.ts'), /timedOut\?: number/)
})
