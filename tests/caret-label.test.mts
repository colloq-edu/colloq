/**
 * The name label above someone else's caret: whose style it wears and what
 * clips it.
 *
 * This broke in two ways at once, and both were silent.
 *
 * THE FIRST is precedence. y-codemirror.next declares the label in its BASE
 * theme, and a CodeMirror base theme is `.ͼ1 .cm-ySelectionInfo`, two classes.
 * A one-class rule lost to it by half: the label height, small caps and
 * letter spacing came from index.css, while the font family, size, weight,
 * line height, padding and lift stayed foreign. On screen was a 14 px label
 * with SERIF text of 9.75 px at regular weight, pressed against the top edge —
 * although index.css says 8.5 px, sans, 700 and a line height of the full
 * label.
 *
 * THE SECOND is clipping. The label hangs ABOVE the line, and the cell's
 * `.cm-scroller` clipped everything above the first line: `overflow-x: auto`
 * from index.css makes the other axis clip too, and `overflow-y: hidden`
 * sealed it. Nine pixels out of fourteen were left of the label — the letters
 * cut off along a horizontal line. In a file the scroller is real and has to
 * clip, so there the label is given room above.
 *
 * Both were measured live (Chrome over CDP, two people in a room, hovering
 * with a real mouse): before the fix `serif · 9.75px · 400` and a 5 px cut,
 * after it `HSE Sans · 8.5px · 700`, nothing clips, 18 px above the first line
 * of a file.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

const CSS = read('web/src/index.css')
const CELL = read('web/src/components/notebook/CodeEditor.svelte')
const FILE_THEME = read('web/src/components/editor/editor-theme.ts')

/** A rule's body, found by the start of its selector. */
function ruleFor(css: string, selector: string): string {
  const at = css.indexOf(selector)
  assert.ok(at > 0, `no ${selector} rule at all`)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

const LABEL = '.cm-editor .cm-ySelectionCaret > .cm-ySelectionInfo'
const label = ruleFor(CSS, LABEL)

/** A property's number: `top: -14px` → -14. */
function px(rule: string, prop: string): number {
  const found = rule.match(new RegExp(`(?:^|\\s)${prop}:\\s*(-?[\\d.]+)px`))
  assert.ok(found, `${prop} is not set in pixels`)
  return Number(found[1])
}

/* -------------------------------------------------------------- precedence */

test("the label rule outranks y-codemirror's base theme", () => {
  // Three classes against the two of `.ͼ1 .cm-ySelectionInfo`, and no
  // !important.
  assert.ok(CSS.includes(LABEL), 'the selector got weaker: the base theme will win again')
  // No one-class rule may remain: it was exactly the one that lost.
  assert.doesNotMatch(CSS, /^\.cm-ySelectionInfo\s*\{/m, 'the one-class rule is back')
})

test('the label declares everything the base theme declares, or deliberately yields', () => {
  /*
   * The property list is taken from the base theme ITSELF, not from memory:
   * should a new y-codemirror version add a font or a padding there, the test
   * fails and someone looks at the label, instead of discovering a foreign
   * style on screen.
   */
  const source = read('node_modules/y-codemirror.next/dist/y-codemirror.cjs')
  const at = source.indexOf("'.cm-ySelectionInfo': {")
  assert.ok(at > 0, 'y-codemirror no longer has a base label style; check the rule by hand')
  const base = source.slice(at, source.indexOf('}', at))
  const declared = [...base.matchAll(/(\w+):/g)].map(([, name]) =>
    name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`),
  )
  /*
   * What is left to the base on purpose: placement (the label is positioned
   * relative to the caret), the background (it inherits the neighbour's
   * colour, which is what paints the label), and appearing on hover together
   * with its easing.
   */
  const toBase = new Set([
    'position',
    'background-color',
    'opacity',
    'transition',
    'transition-delay',
    'user-select',
    'left',
  ])
  for (const prop of declared) {
    if (toBase.has(prop)) continue
    // The base writes `paddingLeft`/`paddingRight`, while our rule uses the
    // `padding` shorthand: it covers both sides, and that is enough.
    const dash = prop.indexOf('-')
    const short = dash > 0 ? prop.slice(0, dash) : prop
    const declares = new RegExp(`(?:^|\\s)(?:${prop}|${short}):`)
    assert.match(label, declares, `${prop} stays foreign`)
  }
})

test('the label sits exactly on the line, and it is measured in pixels, not em', () => {
  /*
   * `em` here is counted from the font size of the label ITSELF (8.5 px), not
   * from the code line: "-1.2em" lifted it by 10 px instead of its own 14, and
   * the bottom overlapped the code.
   */
  assert.doesNotMatch(label, /top:\s*-?[\d.]+em/, 'the lift is in em again')
  assert.equal(px(label, 'top'), -px(label, 'height'), 'the lift no longer matches the label height')
  // Line height of the full label, or the text is pressed against its top
  // edge.
  assert.equal(px(label, 'line-height'), px(label, 'height'))
})

/* ---------------------------------------------------------------- clipping */

test('the cell clips nothing: the label has room to rise above the first line', () => {
  const scroller = ruleFor(CELL, '.cm-cell :global(.cm-scroller)')
  assert.match(scroller, /overflow:\s*visible/, "the cell's scroller clips again")
  assert.doesNotMatch(scroller, /overflow-y:\s*hidden/)
})

test('in a file the scroller clips, so the label is given room above', () => {
  // There it is a window into a long file: it cannot help clipping, so room
  // has to be given.
  const found = FILE_THEME.match(/paddingTop:\s*'(\d+)px'/)
  assert.ok(found, 'the file editor has no room above')
  assert.ok(
    Number(found[1]) >= px(label, 'height'),
    `room of ${found[1]}px is less than the ${px(label, 'height')}px label`,
  )
})
