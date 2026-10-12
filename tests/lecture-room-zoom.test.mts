/**
 * The laptop can give a zoomed hall its whole slide back.
 *
 * The zoom outlives a take-over, and every screen of the room shows it, yet
 * only the console could change it: a teacher who took the lecture over on
 * the laptop after the iPad died at ×4 on a detail had the projector and
 * every student stuck on that detail, with nothing but "next" and "back"
 * again to get out. Now, while the hall is zoomed and this screen leads:
 *
 *  • the bar carries a key with the zoom in figures and "whole slide", after
 *    "Pause" and inside the scrolling strip, so nothing to its left moves and
 *    the bar's fold steps stay as they were;
 *  • 0, with no modifier and not while typing, does the same from the bar's
 *    keyboard and from the projector's;
 *  • both send the console's own frame, a final `lecture:zoom` to `null`,
 *    and a press offline says so instead of doing nothing;
 *  • neither while the console's hands hold the lecture (the device of the
 *    presenter's last act): a console in a second window of the same browser
 *    leads too and keeps its own view, so a press here would leave it
 *    magnified over a whole hall.
 *
 * Held by the source, the way lecture-hall-zoom holds the room's wiring; the
 * frame itself is the server's (tests/lecture-zoom-wire.test.mts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate } from '../shared/i18n.js'
import { roomMessages } from '../shared/locales/room.js'

function code(rel: string): string {
  // Markup without comments: an explanation is not a promise.
  return fs
    .readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

const VIEW = code('web/src/components/lecture/LectureView.svelte')

/** The presenter's bar, from its marker to the next branch of the bar. */
function bar(): string {
  const at = VIEW.indexOf('data-lecture-bar')
  assert.notEqual(at, -1, 'the presenter bar is marked')
  return VIEW.slice(VIEW.lastIndexOf('<div', at), VIEW.indexOf('{:else if presenting}', at))
}

test('the key is there only while the hall is zoomed and this screen leads', () => {
  assert.match(VIEW, /const zoomBack = \$derived\(pult && zoom !== null && !consoleHands \? zoom : null\)/)
  // Not over a console that zoomed: the server keeps the device of the last act.
  assert.match(VIEW, /const consoleHands = \$derived\(lecture\.device\?\.console === true\)/)
  // `zoom` is the hall's zoom of the page on screen, from the server's word.
  assert.match(
    VIEW,
    /const zoom = \$derived\(session\.zoomNow !== null && session\.zoomNow\.page === page \? session\.zoomNow\.zoom : null\)/,
  )
})

test('the key gives the whole slide back the way the console does, and says so offline', () => {
  const whole = /function wholeSlide\(\): void \{([\s\S]*?)\n  \}/.exec(VIEW)?.[1] ?? ''
  assert.match(whole, /if \(zoom === null\) return/)
  assert.match(
    whole,
    /if \(!session\.zoomTo\(page, null, true\)\) refuse\(tr\('room\.lecture5\.zoomOffline'\)\)/,
    'the whole slide is not a final frame to null, or a press offline goes nowhere silently',
  )
})

test('on the bar: after "Pause", inside the scrolling strip, the zoom in figures and its name', () => {
  const strip = bar().slice(0, bar().indexOf('{#if stripMore}'))
  const pause = strip.indexOf("{tr('room.ui.291')}")
  const key = strip.indexOf('{#if zoomBack}')
  const spring = strip.indexOf('<span class="flex-1"></span>')
  assert.ok(pause > 0 && key > pause && spring > key, 'the key moves the keys to its left, or left the strip')
  const button = strip.slice(key, spring)
  assert.match(button, /onclick=\{wholeSlide\}/)
  assert.match(button, /aria-label=\{tr\('room\.pult4\.zoomWhole'\)\}/, 'the key lost its name')
  assert.match(button, /title=\{tr\('room\.lecture5\.zoomBack', \{ n: zoomTimes\(zoomBack\.z\) \}\)\}/)
  assert.match(button, /\{zoomTimes\(zoomBack\.z\)\}/, 'the key does not show how close the hall is')
  // The words where the bar has room for them, the name always.
  assert.match(button, /<span class=\{zoomWords \? '' : 'sr-only'\}>\{tr\('room\.pult4\.zoomWhole'\)\}<\/span>/)
})

test('the fold steps of the bar are counted without the key: a zoom never refolds the bar', () => {
  assert.match(VIEW, /const spelled = \$derived\(areaW >= KEYS_SPELLED_PX \+ PENS_ROW_PX \+ READING_PX\)/)
  assert.match(VIEW, /const pensOut = \$derived\(areaW >= KEYS_GLYPHS_PX \+ PENS_ROW_PX \+ READING_PX\)/)
  assert.match(
    VIEW,
    /const zoomWords = \$derived\(\s*spelled && areaW >= KEYS_SPELLED_PX \+ PENS_ROW_PX \+ READING_PX \+ ZOOM_KEY_PX \+ ZOOM_WORDS_PX,?\s*\)/,
  )
})

test('0 gives the whole slide back from the bar and from the projector, never while typing', () => {
  const keys = VIEW.slice(VIEW.indexOf('function onkeydown('), VIEW.indexOf('const BANNER'))
  const guard = keys.indexOf("if (!pult && !(role === 'projection' && mine && acts)) return")
  const typing = keys.indexOf("if (target?.closest('input, textarea, [contenteditable]')) return")
  const zero = keys.indexOf("event.code === 'Digit0' || event.code === 'Numpad0'")
  assert.ok(guard > 0 && typing > guard && zero > typing, '0 is read before the screen is known to lead, or while typing')
  const branch = keys.slice(zero, keys.indexOf('} else if', zero))
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
    assert.match(branch, new RegExp(`!event\\.${modifier}`), `0 with ${modifier} is taken from the browser`)
  }
  assert.match(
    branch,
    /if \(zoom === null \|\| consoleHands\) return/,
    '0 is swallowed on a slide that is not zoomed, or taken from the console that zoomed',
  )
  assert.match(branch, /wholeSlide\(\)/)
})

test('the words exist in both languages, the zoom in each one\'s own figures', () => {
  for (const key of ['room.lecture5.zoomBack', 'room.lecture5.zoomOffline']) {
    const pair = roomMessages[key] as { ru: string; en: string } | undefined
    assert.ok(pair, `${key} is missing`)
    assert.doesNotMatch(pair.en, /[А-Яа-яЁё]/, `${key} has Russian in English`)
  }
  assert.equal(translate('ru', 'room.lecture5.zoomBack', { n: '×2,5' }), 'Зал видит ×2,5. Вернуть весь слайд — 0')
  assert.equal(translate('en', 'room.lecture5.zoomBack', { n: '×2.5' }), 'The hall sees ×2.5. Back to the whole slide — 0')
})
