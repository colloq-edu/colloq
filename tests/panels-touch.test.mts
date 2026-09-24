/**
 * Input by finger and by keyboard — where there was none until now.
 *
 * `future.hoverOnlyWhenSupported` (tailwind.config.js) wraps every `hover:`
 * utility in `@media (hover: hover)`, and that is right: a tap on an iPad no
 * longer leaves a "hovered" button hanging until the next touch. But the flag
 * has a price — where hover was the ONLY way in, a finger now cannot get there
 * at all. This checks that a second path exists.
 *
 * And the other side of the same conversation: a keyboard action must not be
 * animated. People press Escape to get the panel OUT OF THE WAY, not to watch
 * it slide off.
 *
 * It is read straight from the components, as in `panels-craft.test.mts`: a
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

const FILES = 'web/src/components/panels/FilesPanel.svelte'
const BAN = 'web/src/components/panels/BanMenu.svelte'
const AI = 'web/src/components/panels/AiPanel.svelte'
const SESSION = 'web/src/screens/SessionScreen.svelte'
const TAILWIND = 'web/tailwind.config.js'

/* ----------------------------------------------------------------- finger */

test('the hover gate flag is set: without it there is no point checking a second path', () => {
  assert.match(code(read(TAILWIND)), /hoverOnlyWhenSupported:\s*true/)
})

/** The spot where a strip of three icons used to lie and a "⋯" now stands. */
function laneOf(files: string): string {
  const at = files.indexOf('absolute inset-y-0 right-0 flex items-center')
  assert.ok(at > 0, 'the action strip in a tree row was not found')
  return files.slice(at)
}

test('tree row actions open not only on hover', () => {
  const files = code(read(FILES))
  // Hover stays with the pointer, the selected row goes to the finger; the same
  // answer as the cell toolbar (CellView · `selected && opacity-100`).
  const lane = laneOf(files)
  assert.match(lane, /group-hover:opacity-100/, 'for the pointer, on hover')
  assert.match(lane, /group-focus-within:opacity-100/, 'for the keyboard, on focus')
  assert.match(lane, /picked === entry\.path \? 'opacity-100'/, 'for the finger, on the selected row')

  // And the row is selected by the same press that opens it: the tree has no
  // separate "select" gesture.
  assert.match(files, /let picked = \$state<string \| null>\(null\)/)
  assert.match(
    files.slice(files.indexOf('function pick(entry: FileEntry')),
    /picked = entry\.path/,
    'a press on the name selects the row',
  )
  assert.match(
    files.slice(files.indexOf('function toggle(path: string)'), files.indexOf('function pick(')),
    /picked = path/,
    'so does a press on the folder arrow',
  )
})

test('the invisible menu button does not catch a tap at the right edge of the row', () => {
  const files = code(read(FILES))
  const lane = laneOf(files)
  // The button lies over the file size: with `opacity-0`, but without this line
  // the invisible "⋯" took the press instead of the row under it.
  assert.match(lane, /pointer-events-none opacity-0/, 'while invisible it cannot be pressed')
  assert.match(lane, /group-hover:pointer-events-auto/)
  assert.match(lane, /group-focus-within:pointer-events-auto/)
})

test('a tree row has one "⋯" button, not a strip of icons', () => {
  /*
   * The strip of three icons (a line for the cell, download, remove) took the
   * place of the file size, could do exactly three things and on a tablet went
   * only to the selected row. Everything it could do went into the menu; one
   * button remained in the row, and a fourth action no longer demands a fourth
   * icon from a row 26 pixels tall.
   */
  const files = code(read(FILES))
  const lane = laneOf(files)
  const row = lane.slice(0, lane.indexOf('</span>'))
  assert.equal(
    [...row.matchAll(/<button/g)].length,
    1,
    'more than one button in the strip: the icon strip is back',
  )
  assert.match(row, /data-menu-button/, 'the button is not marked as opening a menu')
  assert.match(row, /aria-haspopup="menu"/)
  assert.match(row, /name="more"/)
  // And none of the old icons: they must live only as menu items.
  for (const gone of ['name="trash"', 'name="download"', 'name="copy"']) {
    assert.ok(!row.includes(gone), `${gone} stayed in the row instead of the menu`)
  }
})

test('the "⋯" finger target is forty pixels while the drawing stays small', () => {
  // `after:-inset-2` grows the hit area by eight pixels on each side: 24 + 16 =
  // 40, and not a single layout pixel moves.
  const lane = laneOf(code(read(FILES)))
  const row = lane.slice(0, lane.indexOf('</span>'))
  assert.match(row, /h-6 w-6/, 'the drawing is no longer 24×24')
  assert.match(row, /after:absolute after:-inset-2/, 'the finger target did not grow')
})

test('on a phone the row menu opens with a long press', () => {
  /*
   * A phone has no right button at all, and "⋯" requires hitting the row first
   * and only then the icon. Without the timer nothing would open the menu on
   * iOS: `contextmenu` does not arrive there.
   */
  const files = code(read(FILES))
  assert.match(files, /onpointerdown=\{\(event\) => onRowPointerDown\(event, entry\)\}/)
  const hold = files.slice(
    files.indexOf('function onRowPointerDown'),
    files.indexOf('function onRowPointerMove'),
  )
  assert.match(hold, /event\.pointerType !== 'touch'/, 'the long press is caught for more than the finger')
  assert.match(hold, /\}, 500\)/, 'the long-press threshold moved off half a second')
  // A moving finger is a scroll, not a press.
  assert.match(
    files.slice(files.indexOf('function onRowPointerMove')),
    /endHold\(\)/,
    'finger movement does not cancel the long press',
  )
  // And the `click` that follows a long press does not open the file.
  assert.match(files.slice(files.indexOf('function pick(entry: FileEntry')), /if \(heldOpen\)/)
})

test('the row menu opens from the keyboard too: Shift+F10 and the "menu" key', () => {
  const files = code(read(FILES))
  const keys = files.slice(
    files.indexOf('function onRowKeydown'),
    files.indexOf('function step('),
  )
  assert.match(keys, /event\.key === 'ContextMenu'/)
  assert.match(keys, /event\.key === 'F10' && event\.shiftKey/)
  assert.match(keys, /event\.key === 'F2'/, 'F2 does not rename')
  assert.match(keys, /'Delete' \|\| event\.key === 'Backspace'/, 'Delete does not delete')
  assert.match(keys, /ArrowDown/, 'the arrows do not move between rows')
  // The handler sits on the name button itself — the element that receives focus.
  assert.match(files, /onkeydown=\{\(event\) => onRowKeydown\(event, entry\)\}/)
  assert.match(files, /data-row-name/)
})

/* --------------------------------------------------------------- keyboard */

test('the ban menu and its dialog leave instantly: they are closed with Escape', () => {
  const ban = code(read(BAN))
  // `transition:` is two-way — the exit was animated too, and Escape took the
  // panel away over 120 ms. The same decision as for the SessionScreen drawers,
  // and in words in admin/motion.css: exit is the one thing that must not exist.
  assert.doesNotMatch(ban, /transition:(fly|fade)/, 'no two-way directives are left')
  assert.match(ban, /in:fly=/, 'the menu has an entrance')
  assert.match(ban, /in:fade=/, 'and so does the dialog backdrop')
})

test('the ban menu moves on the house curve, not the svelte one', () => {
  const ban = read(BAN)
  // `--ease-out` = cubic-bezier(0.23, 1, 0.32, 1) (index.css); the closest in
  // svelte/easing is quintOut (1−(1−t)⁵). cubicOut is noticeably softer and reads
  // as foreign among all the other motion in the product.
  assert.doesNotMatch(code(ban), /cubicOut/)
  assert.match(ban, /import \{ quintOut \} from 'svelte\/easing'/)
})

test('"Ask the oracle" from the keyboard targets the field itself, not the panel', () => {
  const ai = code(read(AI))
  const composer = ai.slice(ai.indexOf('<textarea'), ai.indexOf('</textarea>'))
  assert.match(composer, /bind:this=\{composer\}/, 'the oracle input line was found')
  assert.match(composer, /data-oracle-composer/, 'and so was the tag on it')

  // The contract from the other side: ⌘/Ctrl+I and the palette row look for this
  // tag. The fallback via the panel relies on there being exactly one textarea in
  // it — the tag on the field decouples the shortcut from another panel's layout.
  assert.match(code(read(SESSION)), /\[data-oracle-composer\]/)
})
