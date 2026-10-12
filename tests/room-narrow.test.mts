/**
 * The room on a phone: nothing slides past the edge of the screen.
 *
 * The room root hides overflow, so "did not fit" looks here not like a
 * scrollbar but like something CUT OFF: at 360 px two letters were left of the
 * "Скопировать" (Copy) button, and a lost connection ("ВОССТАНАВЛИВАЕМ СВЯЗЬ",
 * 185 px of letter-spaced caps) carried both it and the theme switch past the
 * right edge. So what is checked is not "pretty" but three rules that
 * prettiness follows from:
 *
 *   1. a bar that ran out of width WRAPS instead of pushing things out;
 *   2. what people READ shrinks and truncates; what people PRESS stays whole;
 *   3. a button that gave up its caption for space keeps its name for screen
 *      readers.
 *
 * It is read straight from the components, as in `panels-touch.test.mts`: a
 * test with its own copy of the rule passes forever while the file drifts away.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const SESSION = 'web/src/screens/SessionScreen.svelte'
const FILE_BAR = 'web/src/components/editor/FileBar.svelte'
const LECTURE = 'web/src/components/lecture/LectureView.svelte'

/** The room status bar: from `border-t border-brand-2` to the end of the header. */
function band(source: string): string {
  const at = source.indexOf('border-t border-brand-2')
  assert.notEqual(at, -1, 'the status bar is in place')
  // From the tag itself, not from the matched word: the bar's class spans two
  // lines, and `border-t` sits at the end of the first.
  return source.slice(source.lastIndexOf('<div', at), source.indexOf('</header>'))
}

/* ----------------------------------------------------------------- overflow */

test('the room root clips but does not scroll sideways', () => {
  const session = code(read(SESSION))
  // `overflow-hidden` is an INVISIBLE scroll container: the browser scrolls it
  // sideways on its own to show focus on a button past the edge, and the room
  // stays shifted for good — there is nothing to bring it back with. `clip` cuts
  // the same way and creates no container.
  assert.match(session, /flex h-full min-h-0 flex-col overflow-clip bg-canvas/)
  assert.doesNotMatch(session, /flex h-full min-h-0 flex-col overflow-hidden/)
})

test('the status bar wraps instead of pushing its content out', () => {
  const strip = band(code(read(SESSION)))
  // Eight controls in one line come to about 520 px in a 360 window.
  assert.match(strip, /flex-wrap/, 'the bar is allowed to wrap')
  assert.match(strip, /min-h-\[45px\]/, 'the height is a floor, not a ceiling')
  assert.doesNotMatch(strip, /\bflex-nowrap\b/, 'wrapping is not forbidden at any width')
  assert.doesNotMatch(
    strip.slice(0, strip.indexOf('{#if room.length')),
    /\sh-\[45px\]/,
    'the bar has no fixed height: a second line has to fit',
  )
})

test('the room buttons wrap as one group and hug the right', () => {
  const strip = band(code(read(SESSION)))
  const group = strip.slice(strip.indexOf('ml-auto flex shrink-0 items-center'))
  assert.notEqual(group, '', 'the button group exists')
  // Wrapped separately, they tore the bar apart: the toggles on the first line,
  // the theme and "Copy" on the second.
  for (const inside of ['aria-pressed={leftShown}', '<ThemeSwitch', 'onclick={copyLink}']) {
    assert.ok(group.includes(inside), `${inside} is inside the group`)
  }
})

/* ----------------------------------- what is read shrinks, not what is pressed */

test('the connection state shrinks to an ellipsis instead of shoving its neighbours', () => {
  const strip = band(code(read(SESSION)))
  for (const key of ['room.ui.898', 'room.ui.899']) {
    const at = strip.indexOf(`title={tr('${key}')}`)
    assert.notEqual(at, -1, `${key}: the whole phrase stayed in title`)
    const block = strip.slice(strip.lastIndexOf('<div', at), strip.indexOf('</div>', at))
    assert.match(block, /min-w-0 shrink /, 'the state block shrinks')
    assert.doesNotMatch(block, /class="flex shrink-0 items-center gap-2 text-white"/)
    assert.match(block, /truncate text-2xs font-bold uppercase tracking-label/, 'the word gets an ellipsis')
    assert.match(block, /size=\{12\} class="shrink-0/, 'the icon never shrinks')
  }
})

test('"Copy" on a narrow bar is an icon with a name, not two letters', () => {
  const strip = band(code(read(SESSION)))
  const button = strip.slice(strip.indexOf('onclick={copyLink}'))
  // `sr-only`, not `hidden`: an icon-only button has to stay named.
  assert.match(button, /class="sr-only text-2xs font-bold uppercase tracking-label sm:not-sr-only"/)
  assert.ok(!/class="hidden[^"]*"[^>]*>\s*\{copied/.test(button), 'the caption is not switched off for good')
  assert.match(strip, /onclick=\{copyLink\}[\s\S]{0,200}title=\{tr\('room\.ui\.904'\)\}/, 'and the title is in place')
})

test('the file bar: the refusal reason shrinks, not the "Run" button', () => {
  const bar = code(read(FILE_BAR))
  assert.match(bar, /flex min-w-0 shrink items-center gap-2\.5/, 'the right half shrinks')
  assert.doesNotMatch(bar, /flex shrink-0 items-center gap-2\.5 px-5/, 'the old shrink-0 is gone')
  const why = bar.slice(bar.indexOf('title={mayEdit ? '))
  assert.match(why, /<span class="truncate">\{mayEdit \? /, 'the phrase is truncated with an ellipsis')
  assert.match(bar, /class="truncate text-2xs text-muted">\{user\.name\}/, 'so are the names of the others')
})

/** The presenter's bar in LectureView: from its marker to the next branch of the bar. */
function presenterBar(view: string): string {
  const at = view.indexOf('data-lecture-bar')
  assert.notEqual(at, -1, 'the presenter bar is marked')
  return view.slice(view.lastIndexOf('<div', at), view.indexOf('{:else if presenting}', at))
}

test('the presenter bar: the strip gives way and End stays whole at the edge', () => {
  const bar = presenterBar(code(read(LECTURE)))
  /*
   * Every word and four pens came to 1117 px, while a laptop with the room's
   * panels open leaves the bar 660–820: "Project" and "End" stood past the
   * right edge, out of reach, and "1 / 12" stood in three lines. Wrapping
   * would take a second row from the slide on every such laptop; the bar
   * gives way in steps instead (see the next test), and where even the steps
   * run out (a phone) the strip scrolls under a fade, as the notebook's run
   * bar does. Nothing is squeezed: the keys keep their width.
   */
  assert.match(bar, /class="min-w-0 flex-1 overflow-x-auto overflow-y-hidden[^"]*"/, 'the strip does not scroll')
  assert.match(
    bar,
    /<div class="flex h-full w-max min-w-full items-stretch">/,
    'the keys are squeezed instead of keeping their width',
  )
  assert.match(bar, /\{#if stripMore\}/, 'nothing says the strip runs on')
  // End is outside the strip: never scrolled away, and a question that widens
  // it squeezes the strip rather than moving the key from under the pointer.
  const strip = bar.slice(0, bar.indexOf('{#if stripMore}'))
  assert.doesNotMatch(strip, /onclick=\{askStop\}/, 'End scrolls with the strip')
  assert.match(
    bar.slice(bar.indexOf('{#if stripMore}')),
    /<div class="flex shrink-0 items-stretch whitespace-nowrap">[\s\S]*onclick=\{askStop\}/,
    'End is not pinned at the edge',
  )
})

test('the presenter bar gives way by its own width, and a key that lost its word keeps it as its name', () => {
  const view = code(read(LECTURE))
  // The bar's width, not the window's: the room's panels narrow it, not the
  // screen. And the row of pens is counted by the pens, not by a number that
  // was right for four.
  assert.match(view, /const spelled = \$derived\(areaW >= [^)]*PENS_ROW_PX[^)]*\)/)
  assert.match(view, /const pensOut = \$derived\(areaW >= [^)]*PENS_ROW_PX[^)]*\)/)
  assert.match(view, /const PENS_ROW_PX = INKS\.length \* 24 \+ 8/)
  const bar = presenterBar(view)
  // `sr-only`, not `{#if}`: screen readers and the stands press the same names.
  assert.match(bar, /<span class=\{spelled \? '' : 'sr-only'\}>\{tr\('room\.ui\.165'\)\}<\/span>/, 'the pointer lost its name')
  assert.match(bar, /aria-label=\{tr\('room\.ui\.166'\)\}/, 'undo lost its name')
  // The question is read even where the key at rest is a glyph.
  assert.match(
    bar,
    /<span class=\{spelled \|\| wipeAsked \? '' : 'sr-only'\}>\{wipeAsked \? tr\('room\.ui\.288'\) : tr\('room\.ui\.221'\)\}<\/span>/,
    'erase lost its name, or its question is no longer spelled out',
  )
  assert.match(bar, /<ConsoleLink class="\{TOOL\} text-muted hover:text-ink" caption=\{spelled\} \/>/)
  assert.match(bar, /\{@render projectButton\(!spelled\)\}/)
  assert.match(view, /<span class=\{glyph \? 'sr-only' : ''\}>\{tr\('room\.ui\.301'\)\}<\/span>/, 'the projector lost its name')
})

test('the lecture bar: the presenter name does not push out the page counter', () => {
  const view = code(read(LECTURE))
  const at = view.indexOf("{tr('room.ui.297')}")
  assert.notEqual(at, -1, 'the "lecture in progress" line is in place')
  // From the start of the bar, not from the matched phrase: the group opens above it.
  const row = view.slice(view.lastIndexOf('<div', at))
  assert.match(row, /<span class="flex min-w-0 flex-1 items-center gap-2">/, 'who presents and what is on both shrink')
  assert.match(row, /<span class="shrink-0 font-mono tabular-nums">/, 'the page counter is intact')
})

/* -------------------------------------------------------- height and wrapping */

test('the rules control is no taller than the window, and the list inside it scrolls', () => {
  const session = code(read(SESSION))
  const pult = session.slice(session.indexOf('fixed right-3 top-[104px]'))
  // In a phone's landscape orientation (390 px tall) "End class" ended up below
  // the edge of the screen, and there was no way to scroll down to it.
  assert.match(pult, /max-h-\[calc\(100dvh-7\.5rem\)\]/, 'the sheet is no taller than the window')
  assert.match(pult, /flex max-h-\[calc\(100dvh-7\.5rem\)\] flex-col/, 'a column: header, list, footer')
  assert.match(pult, /min-h-0 flex-1 overflow-y-auto px-4/, 'the list scrolls')
  assert.doesNotMatch(pult.slice(0, pult.indexOf('RoomRulesRows')), /max-h-\[min\(60vh,32rem\)\] overflow-y-auto/)
})

test('the "class is over" bar: the explanation wraps as a whole line', () => {
  const session = code(read(SESSION))
  const banner = session.slice(session.indexOf('bg-warning/[0.08]'))
  // `flex-1` with a zero basis took the 30 px left in the row and stacked the
  // phrase one word per line.
  assert.match(banner, /class="min-w-0 flex-1 basis-56 text-2xs leading-snug text-muted"/)
})
