/**
 * The styling a text cell brings into other people's browsers.
 *
 * The `style` attribute was banned outright, and the ban cost all the usual
 * markup of a course notebook: `<div style="background:#eef;padding:8px">`
 * arrived as a bare div, that is, indistinguishable from a paragraph. Now
 * PROPERTIES are banned, and the whole boundary sits in one pure function
 * that can be checked without a browser.
 *
 * Both sides of the boundary are checked at once: that familiar styling gets
 * through (without that the fix fixes nothing) and that levers on someone
 * else's screen do not (without that it opens the hole the ban was there to
 * close).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTE_CSS_PROPS, safeStyle } from '../shared/note-css.js'

/** The properties named in the surviving declaration. */
const props = (value: string): string[] =>
  safeStyle(value)
    .split(';')
    .map((decl) => decl.split(':')[0].trim())
    .filter(Boolean)

test('a "Note" callout arrives whole', () => {
  const kept = safeStyle('background:#eef;padding:8px;border-left:3px solid #66f')
  assert.match(kept, /background: #eef/)
  assert.match(kept, /padding: 8px/)
  assert.match(kept, /border-left: 3px solid #66f/)
})

test('ordinary note styling gets through', () => {
  for (const decl of [
    'color: #c33',
    'background-color: rgba(0,0,0,.05)',
    'text-align: center',
    'font-weight: 600',
    'font-family: Georgia, serif',
    'margin: 12px auto',
    'width: 420px',
    'max-width: 100%',
    'border-radius: 6px',
    'display: flex',
    'gap: 8px',
    'line-height: 1.5',
    'opacity: 0.8',
    'float: right',
    'background: linear-gradient(90deg, #fff, #eef)',
  ]) {
    assert.equal(props(decl).length, 1, `${decl} is ordinary styling, yet it did not get through`)
  }
})

test('a black screen for the whole room cannot be assembled', () => {
  // That very measure from sanitize.ts: an overlay over the interface, after
  // which the cell cannot be deleted with the mouse, and a reload brings the
  // same cell back.
  assert.equal(safeStyle('position:fixed;inset:0;background:#000;z-index:9999'), 'background: #000')
  for (const decl of [
    'position: absolute',
    'position: sticky',
    'top: 0',
    'left: 0',
    'inset: 0',
    'z-index: 9999',
    'transform: scale(40)',
    'translate: 0 -400px',
    'scale: 30',
    'rotate: 45deg',
    'filter: invert(1)',
    'backdrop-filter: blur(20px)',
    'mix-blend-mode: difference',
    'clip-path: circle(99%)',
    'pointer-events: none',
    'cursor: none',
    'animation: spin 1s infinite',
    'transition: all 9s',
    'content: "x"',
    'will-change: transform',
    'contain: none',
    'zoom: 40',
    'user-select: none',
    'all: unset',
    'view-transition-name: x',
    'anchor-name: --x',
  ]) {
    assert.deepEqual(props(decl), [], `${decl} is a lever on someone else's screen, yet it got through`)
  }
})

test('a shadow does not paint outside its own element', () => {
  // `box-shadow: 0 0 0 100vmax #000` paints the whole screen, and does it
  // without `position` — that is, past everything that guarded against an
  // overlay.
  assert.deepEqual(props('box-shadow: 0 0 0 100vmax #000'), [])
  assert.deepEqual(props('text-shadow: 1500px 0 0 #000'), [])
  assert.deepEqual(props('outline: 9999px solid #000'), [])
})

test('nobody fetches an address from a note', () => {
  // The same argument as for `@import` in the output's shadow root: a rule can
  // be confined to an element, but a request from the browser of everyone in
  // the room cannot.
  assert.deepEqual(props('background: url(http://tracker.example/x.png)'), [])
  assert.deepEqual(props('background-image: url("data:image/svg+xml,<svg/>")'), [])
  assert.deepEqual(props('list-style-image: url(x.png)'), [])
  assert.deepEqual(props('background: #fff url(x.png) no-repeat'), [])
})

test('computation does not sneak past the ceiling', () => {
  // calc/var/env compute, which means they can produce a number that is not
  // in the source: `calc(100vw * 40)` will not fall under the length parsing.
  assert.deepEqual(props('width: calc(100vw * 40)'), [])
  assert.deepEqual(props('color: var(--bg)'), [])
  assert.deepEqual(props('padding: max(9999px, 1px)'), [])
  assert.deepEqual(props('width: env(safe-area-inset-left)'), [])
})

test('a length hits the ceiling whatever unit it is written in', () => {
  assert.deepEqual(props('width: 420px'), ['width'])
  assert.deepEqual(props('width: 5000px'), [])
  assert.deepEqual(props('border: 9999px solid #000'), [])
  assert.deepEqual(props('margin-left: -9999px'), [])
  assert.deepEqual(props('width: 300em'), [])
  assert.deepEqual(props('height: 200in'), [])
  assert.deepEqual(props('width: 100vw'), [])
  assert.deepEqual(props('width: 900%'), [])
  // Percentages stay percentages: without them neither a width nor a font
  // size can be written.
  assert.deepEqual(props('width: 100%'), ['width'])
  assert.deepEqual(props('font-size: 150%'), ['font-size'])
  // A negative margin as a layout trick — yes; to carry a block out of the
  // cell — no.
  assert.deepEqual(props('margin-top: -6px'), ['margin-top'])
  assert.deepEqual(props('margin-top: -900px'), [])
})

test('a font size does not take over the screen', () => {
  assert.deepEqual(props('font-size: 28px'), ['font-size'])
  assert.deepEqual(props('font-size: 400px'), [])
})

test('nobody will parse an escape in a value', () => {
  // The browser reads `\70 osition` as `position`. Parsing that means writing
  // a second CSS parser; a real note never contains an escape at all.
  assert.equal(safeStyle('\\70 osition: fixed; inset: 0'), '')
  assert.equal(safeStyle('color: red; <script>'), '')
  assert.equal(safeStyle('color: red } * { display: none'), '')
})

test('a neighbour is not punished', () => {
  // The declaration is dropped, not the whole attribute: a callout must not
  // disappear because something forbidden was written next to it.
  assert.deepEqual(props('background:#eef;position:fixed;padding:8px'), ['background', 'padding'])
})

test('!important is stripped rather than cancelling the declaration', () => {
  // An inline style is stronger than the `.prose-note` rules anyway, so it
  // gives the author nothing — and a note copied from someone else's notebook
  // carries it everywhere.
  assert.equal(safeStyle('color: red !important'), 'color: red')
})

test('an empty answer means "remove the attribute"', () => {
  assert.equal(safeStyle(''), '')
  assert.equal(safeStyle('position: fixed'), '')
  assert.equal(safeStyle('x'.repeat(3000)), '')
})

test('the allow list has nothing that can cover the screen', () => {
  for (const prop of [
    'position',
    'z-index',
    'top',
    'right',
    'bottom',
    'left',
    'inset',
    'transform',
    'translate',
    'rotate',
    'scale',
    'filter',
    'backdrop-filter',
    'box-shadow',
    'text-shadow',
    'outline',
    'clip-path',
    'mask',
    'animation',
    'transition',
    'content',
    'cursor',
    'pointer-events',
    'user-select',
    'will-change',
    'contain',
    'zoom',
    'all',
    'background-attachment',
  ]) {
    assert.ok(!NOTE_CSS_PROPS.has(prop), `${prop} is in the note allow list`)
  }
})
