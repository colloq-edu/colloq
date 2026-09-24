/**
 * Indentation in a cell and in a file: Tab, its size, and what exactly it
 * moves.
 *
 * CodeMirror has no Tab of its own: the press goes to the browser, and focus
 * leaves the cell for the nearest toolbar button. In a notebook where people
 * write Python, that means there is no way to type an indent: whatever is
 * typed after Tab misses the code, and the person only sees that "tab does not
 * work".
 *
 * The ready-made `indentWithTab` from the CodeMirror kit plugs this hole the
 * wrong way: it moves THE WHOLE LINE. Tab pressed in the middle of a typed
 * line pushed everything already written to the right — so instead of an
 * indent you got the existing code shifted around. What is needed is a soft
 * tab: spaces at the cursor, up to the next tab stop; whole lines are moved by
 * a selection and by Shift-Tab.
 *
 * And the size. Without `indentUnit` CodeMirror takes its own two spaces:
 * Enter after `def f():` put in two, while code from a file or from an Oracle
 * answer came with four, and one function ended up with two different
 * indents — an IndentationError in a place the eye cannot tell apart.
 *
 * The rule is shared by the two editors (lib/indent.ts) precisely because they
 * had already diverged: the file had the binding, the cell did not. The pure
 * half is checked by calls, the wiring by reading the components, as in
 * panels-craft. Live (Chrome over CDP) it was verified that Tab does not move
 * the line, Shift-Tab removes the indent, focus stays in the cell, and with a
 * selection all the lines move.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { INDENT, columnOf, tabInsert } from '../web/src/lib/indent.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const CELL_EDITOR = code(read('web/src/components/notebook/CodeEditor.svelte'))
const FILE_EDITOR = code(read('web/src/components/editor/FileEditor.svelte'))

/* ---------------------------------------------------------------- the rule */

test('an indent is four spaces', () => {
  assert.equal(INDENT, '    ')
})

test('on an empty spot Tab puts in a whole indent', () => {
  assert.equal(tabInsert('', 4), '    ')
  assert.equal(tabInsert('    ', 4), '    ')
  assert.equal(tabInsert('def f():', 4), '    ')
})

test('in the middle of a line Tab pads to the next tab stop instead of adding four', () => {
  // `x=` ends at column two: two spaces to the tab stop, not four.
  assert.equal(tabInsert('x=', 4), '  ')
  assert.equal(tabInsert('    return', 4), '  ')
  assert.equal(tabInsert('a', 4), '   ')
})

test('a foreign tab in the line counts up to the tab stop, not as one character', () => {
  // The editors never insert tabs themselves, but nothing stops anyone from
  // pasting foreign text.
  assert.equal(columnOf('\t', 4), 4)
  assert.equal(columnOf('ab\t', 4), 4)
  assert.equal(columnOf('\tx', 4), 5)
  assert.equal(tabInsert('\t', 4), '    ')
})

test("the document's tab size does not change the indent size", () => {
  // tabSize is the WIDTH of a foreign tab on screen; we still put in our own
  // four.
  assert.equal(tabInsert('', 8), '    ')
  assert.equal(columnOf('\t', 8), 8)
})

/* ------------------------------------------------------------- the editors */

test('both editors bind the shared rule to Tab, not indentWithTab', () => {
  for (const [what, source] of [
    ['cell', CELL_EDITOR],
    ['file', FILE_EDITOR],
  ] as const) {
    assert.match(source, /keymap\.of\(\[\s*tabKey\(\{/, `${what}: Tab is left to the browser`)
    assert.doesNotMatch(source, /indentWithTab/, `${what}: whole-line shifting is back`)
    // Whole lines are moved by a selection and by Shift-Tab: the rule needs
    // both commands.
    assert.match(source, /indentMore: cm\.commands\.indentMore/, `${what}: nothing to move lines with`)
    assert.match(source, /indentLess: cm\.commands\.indentLess/, `${what}: nothing to remove an indent with`)
  }
})

test('the indent size is the same in both editors, from the shared rule', () => {
  assert.match(CELL_EDITOR, /indentUnit\.of\(INDENT\)/, 'the cell went back to two spaces')
  assert.match(FILE_EDITOR, /indentUnit\.of\(INDENT\)/, 'the file went back to two spaces')
})

test('Tab comes last and so loses to whoever has already claimed it', () => {
  for (const [what, source] of [
    ['cell', CELL_EDITOR],
    ['file', FILE_EDITOR],
  ] as const) {
    const general = source.indexOf('cm.commands.defaultKeymap')
    const tab = source.indexOf('tabKey({')
    assert.ok(general > 0 && tab > 0, `${what}: one of the two keymaps is missing entirely`)
    // Earlier in the list means higher precedence: the completer and the
    // command keys take Tab first, and the indent gets the press nobody else
    // wants.
    assert.ok(tab > general, `${what}: the indent outranked the general keys`)
  }
})

test('there is a way out of the cell without Tab', () => {
  // A keyboard trap is the price of the indent, and Escape pays it: it leads
  // to command mode and has higher precedence (Prec.highest).
  assert.match(CELL_EDITOR, /key: 'Escape'/)
  assert.match(CELL_EDITOR, /handlers\.onescape/)
})
