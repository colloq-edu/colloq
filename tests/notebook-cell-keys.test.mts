/**
 * The Backspace that deletes a cell for the whole room.
 *
 * A held key ate cells UPWARD through the notebook: the document went empty,
 * a repeat ~30 ms later took the cell away, focus synchronously moved to the
 * previous one (CodeMirror restores its last cursor), and the following
 * repeats erased its tail and, once it was empty, deleted it too. In an open
 * room any student can do this, and the cell goes away together with its
 * output.
 *
 * The bug is silent both ways: with it everything "works" until the first
 * held key, and with too much strictness Backspace on an empty cell stops
 * working at all.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backspaceRemovesCell,
  emptyCellIsRemovable,
} from '../web/src/components/notebook/cell-keys.js'

test('Backspace on an empty cell — a deliberate press — deletes it', () => {
  assert.equal(backspaceRemovesCell({ empty: true, repeat: false }), true)
})

test('auto-repeat on a cell that has just gone empty deletes nothing', () => {
  // That very frame: the previous repeat erased the last letter, and the
  // finger is still on the key.
  assert.equal(backspaceRemovesCell({ empty: true, repeat: true }), false)
})

test('in a non-empty cell Backspace stays Backspace', () => {
  assert.equal(backspaceRemovesCell({ empty: false, repeat: false }), false)
  assert.equal(backspaceRemovesCell({ empty: false, repeat: true }), false)
})

test('empty text with output under it is not yet an empty cell', () => {
  assert.equal(emptyCellIsRemovable(0), true)
  assert.equal(emptyCellIsRemovable(1), false)
  assert.equal(emptyCellIsRemovable(12), false)
})
