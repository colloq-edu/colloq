import { translate, tr } from '../shared/i18n.js'
/**
 * Notebook details that can only be seen with the eyes — and one word without
 * which the council lies.
 *
 * Rules, each of which reverts with one line and each of which stays silent
 * about it: the "Run" button above a file animates via the `transition`
 * shortcut (all properties, including the focus ring) instead of a positional
 * list; "who ran it" is looked up by going through all the room's tabs in
 * EVERY cell with output; the shared kernel for attempts is not mentioned
 * where the switch is turned on; the kernel state slides off into the bar's
 * scroll, and the cell counter hides again behind a media query about the
 * window, which knows nothing about panels or zoom.
 *
 * It is read straight from the components — the same trick as in
 * panels-craft: a test with its own copy of the rule passes forever while the
 * file drifts away.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { COUNCIL_SHARED_KERNEL_NOTE } from '../shared/notebook.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup and styles without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const CELL = read('web/src/components/notebook/CellView.svelte')
const FILEBAR = read('web/src/components/editor/FileBar.svelte')
const NOTEBOOK = read('web/src/components/notebook/Notebook.svelte')

/* ------------------------------------------------------------- transitions */

test('"Run" above a file animates two properties, not everything', () => {
  const bar = code(FILEBAR)
  // `transition` without a list animates both border-color and box-shadow:
  // the focus ring arrived after the key press instead of appearing at once.
  assert.doesNotMatch(bar, /class="[^"]*\btransition\s/, 'the `transition` shortcut is back')
  assert.match(bar, /transition-\[filter,transform\]/, 'the property list is positional')
  // The ladder of speeds and curves (index.css) exists precisely so that
  // literals like "100ms ease-out" do not appear here.
  assert.match(bar, /duration-press ease-out/, 'the speed and the curve come from the ladder')
  // What is pressable answers the finger: the same press as this button's
  // twin — "To the shared screen" in SessionScreen.
  assert.match(bar, /enabled:active:scale-\[0\.97\]/, 'the button does not press')
})

/* --------------------------------------------------------- presence */

test('"who ran it" is looked up in a map, not by going through the whole room', () => {
  const at = CELL.indexOf('const runner = $derived.by')
  assert.ok(at > 0, 'the face of whoever ran it is gone from the cell')
  const runner = CELL.slice(at, at + 300)
  assert.match(runner, /session\.peersById\.get\(who\)/)
  // Two hundred cells times five hundred tabs is a hundred thousand
  // comparisons per presence frame.
  assert.doesNotMatch(code(CELL), /session\.peers\.find\(/, 'going through the tabs is back')
})

/* ------------------------------------------------------------ shared kernel */

test('the shared kernel is mentioned at the attempt button — and where the switch is turned on', () => {
  // One copy for the whole product: the line lives in shared rather than being
  // rewritten here in other words — otherwise the button hint and the switch
  // will drift apart.
  assert.match(CELL, /COUNCIL_SHARED_KERNEL_NOTE/)
  assert.doesNotMatch(CELL, /Попытки считаются в общем ядре/, 'the line was rewritten as a copy')

  // The "who may run" switch moved from the lock menu to the console's queue
  // strip, and the line moved with it: council-strip-note.test.mts.
  assert.doesNotMatch(CELL, /tr\('room\.ui\.335'\)/, 'the studentRun switch is back in the notebook')

  const run = CELL.indexOf("tr('room.extra.138'")
  assert.ok(run > 0, 'the attempt run button is gone')
  assert.match(
    CELL.slice(run - 200, run + 300),
    /p0: tr\(COUNCIL_SHARED_KERNEL_NOTE\)/,
    'the button hint is about the queue, not the state',
  )
})

test('the shared kernel line speaks of both the personal copies and what stayed shared', () => {
  /*
   * Three halves of the truth, and none of them may be lost.
   *
   * Attempts are computed in turn in one kernel; each gets its own data
   * (kernel/council-isolation.ts), and the names it created are removed
   * (kernel/index.ts · COUNCIL_ENTER_SOURCE). But files, module settings and
   * whatever could not be copied stay shared — without this part the phrase
   * would promise exam-grade isolation that does not and will not exist.
   */
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /по очереди/)
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /личные копии данных/)
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /удаляются после запуска/)
  // The two ways to end the class for everyone at once through the same door
  // are closed as well.
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /ядро завершить нельзя/)
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /память решения ограничена/)
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /Общими остаются файлы/)
})

/* ------------------------------------------------------- notebook bar */

test('the kernel state in the bar sits outside the scroll and is not cut off', () => {
  const bar = code(NOTEBOOK)
  // The right corner is a separate slot, not the tail of the scrolling row:
  // while it lay inside `overflow-x-auto`, "kernel stopped" slid off the edge
  // together with "Format", and the fade hinting at scrolling dimmed exactly
  // it.
  const scroller = bar.indexOf('overflow-x-auto')
  const corner = bar.indexOf('max-w-[70%]')
  assert.ok(scroller > 0 && corner > scroller, 'the right corner of the bar is gone or back in the scroll')
  const cornerClass = bar.slice(bar.lastIndexOf('class=', corner), bar.indexOf('>', corner))
  assert.doesNotMatch(cornerClass, /mask-image/, 'the corner with the state is under the gradient again')
  assert.doesNotMatch(cornerClass, /overflow-x/, 'the corner with the state scrolls again')

  // The badge flexes, the word in it goes into an ellipsis and lives in full in
  // the title: `shrink-0` brought back a rigid box that `contain: paint` cut
  // off.
  assert.match(bar, /const PILL = '[^']*min-w-0/, 'the badge is rigid again')
  assert.doesNotMatch(bar, /const PILL = '[^']*shrink-0/, 'the badge is rigid again')
})

test('the cell counter gives way in steps, not by a media query', () => {
  const bar = code(NOTEBOOK)
  // `xl:` is about the window width, while the bar is narrowed by panels and
  // browser zoom, which the window knows nothing about: the counter vanished on
  // a wide screen with the terminal open and stayed on a narrow one with the
  // panels closed.
  assert.doesNotMatch(bar, /xl:inline/, 'the counter hides behind a media query again')
  assert.match(bar, /bind:clientWidth=\{barWidth\}/, 'the bar no longer measures itself')
  // Three steps: the full line → a single number with a hint → nothing.
  assert.match(
    bar,
    /countMode === 'short'\s*\?\s*tr\('room\.notebook\.cellCount'/,
    'the number lost its hint',
  )
  for (const step of ["return 'full'", "return 'short'", "return 'none'"]) {
    assert.ok(bar.includes(step), `step ${step} is gone`)
  }
})

test('the anchor does not measure a hidden tab, and the move after a run goes through one calculation', () => {
  const settle = NOTEBOOK.slice(NOTEBOOK.indexOf('function settle(): void'))
  const body = settle.slice(0, settle.indexOf('\n  }'))
  /*
   * The check must come BEFORE the first measurement: what poisons things is
   * not the correction but the height memory — a single recorded zero throws
   * the screen off on the next frame, when the notebook is already visible. So
   * we look for `measurable` before `slotHeights.set`.
   */
  const guard = body.indexOf('measurable(')
  assert.ok(guard > 0, 'the anchor measures everything again, including a hidden tab')
  assert.ok(guard < body.indexOf('slotHeights.set'), 'a zero manages to get into the height memory')

  // The move arithmetic lives in cell-scroll (the tests and both complaints
  // are there), not as a second list of numbers in the component.
  const show = code(NOTEBOOK).slice(code(NOTEBOOK).indexOf('function show(id: string)'))
  assert.match(show.slice(0, 500), /afterRun\(frameOf\(box\), boxOf\(cell\)\)/)
  assert.doesNotMatch(
    show.slice(0, 500),
    /scrollTo\(/,
    "a smooth move bypassing steerTo is not interrupted by someone else's scroll",
  )
})

test('the sheet does not follow "Run all" at all, and whoever scrolled it away stays in charge', () => {
  const body = code(NOTEBOOK)

  /*
   * A batch run differs from a single run by the PEAK of the queue, not by its
   * current length: by the end of "Run all" the queue is empty, and by it the
   * last cell is indistinguishable from a single one — the sheet would jerk
   * exactly once, at the very end. And the decision is made synchronously with
   * the transition: the move is deferred by a tick and a frame, and by then
   * the peak has already been reset.
   */
  const run = body.slice(body.indexOf('let peak = 0'))
  const head = run.slice(0, run.indexOf('\n  })'))
  assert.match(head, /if \(queued > peak\) peak = queued/, 'the queue peak is no longer counted')
  assert.match(head, /const batch = peak >= 2/, 'a batch run is mistaken for a single run again')
  assert.ok(
    head.indexOf('const batch = peak >= 2') < head.indexOf('if (now === null) peak = 0'),
    'the peak is reset before the decision — the last cell of the run will drag the sheet',
  )
  assert.match(head, /if \(batch\) return/)

  // Exactly one move is left, and it is smooth: instant travel along the queue
  // was needed while the queue was being followed at all.
  const show = body.slice(body.indexOf('function show(id: string)'))
  const inside = show.slice(0, show.indexOf('\n  }'))
  assert.doesNotMatch(inside, /box\.scrollTop = target/, 'instant travel is back without a queue')
  assert.match(inside, /steerTo\(box, id, target\)/)
  assert.match(
    inside,
    /steering && Math\.abs\(steering\.top - target\) < 2/,
    'the glide restarts from scratch',
  )

  // Requests within a frame are still merged: Shift+Enter in a row is a
  // common move too.
  const follow = body.slice(body.indexOf('function follow(id: string)'))
  assert.match(
    follow.slice(0, 500),
    /requestAnimationFrame/,
    'requests within a frame are no longer merged',
  )

  // Scrolled away yourself — we do not lead. Scrolling counts as taking over,
  // a press does not: one can select a cell while working without giving up
  // being shown.
  assert.match(body, /onwheelcapture=\{\(\) => \{[\s\S]{0,120}handedOver = true/)
  assert.match(body, /ontouchmovecapture=\{\(\) => \{[\s\S]{0,120}handedOver = true/)
  const down = body.slice(body.indexOf('onpointerdowncapture'))
  assert.doesNotMatch(down.slice(0, 80), /handedOver/, 'a press on a cell turns off the showing')
})
