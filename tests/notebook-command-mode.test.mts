/**
 * The notebook's command mode: a selection from another notebook and a step
 * past the last cell.
 *
 * Two troubles in one place. First: `selectedCellId` is one per room and is
 * not reset when switching tabs — `d d`, `m`, `y` and Shift+Enter in the OPEN
 * notebook acted on a cell in the hidden one, and whoever pressed saw nothing.
 * Second: Shift+Enter on the last cell, in a room where the notebook's
 * structure belongs to the teacher, answered every run with a red toast — even
 * though the run did happen.
 *
 * Both break silently, and both are checked here on pure decisions, without a
 * browser.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectionHere, stepPlan } from '../web/src/components/notebook/command-mode.js'

const LIST = ['a', 'b', 'c']

test('a selection from this notebook is taken as is', () => {
  assert.deepEqual(selectionHere('b', LIST), { id: 'b', at: 1 })
  assert.deepEqual(selectionHere('a', LIST), { id: 'a', at: 0 })
})

test('a selection from ANOTHER notebook counts as empty', () => {
  // The cell exists — but not here. `d d` must not delete it, `m` must not
  // change its type, Shift+Enter must not send it to run in the hidden tab.
  assert.deepEqual(selectionHere('чужая', LIST), { id: null, at: -1 })
  assert.deepEqual(selectionHere(null, LIST), { id: null, at: -1 })
})

test('an empty notebook does not hand out a cell from another one', () => {
  assert.deepEqual(selectionHere('b', []), { id: null, at: -1 })
})

test('a step goes to the neighbour in both directions', () => {
  assert.deepEqual(stepPlan(LIST, 'a', 1), { kind: 'move', cellId: 'b' })
  assert.deepEqual(stepPlan(LIST, 'c', -1), { kind: 'move', cellId: 'b' })
})

test('deleting the first cell picks up the neighbour on the other side', () => {
  // fallback: there is nowhere to go up, so the selection goes down.
  assert.deepEqual(stepPlan(LIST, 'a', -1, { fallback: true }), { kind: 'move', cellId: 'b' })
  assert.deepEqual(stepPlan(LIST, 'a', -1), { kind: 'stay' })
})

test('Shift+Enter on the last cell appends a cell — if adding is allowed', () => {
  assert.deepEqual(stepPlan(LIST, 'c', 1, { grow: true, mayAdd: true }), { kind: 'grow', at: 3 })
})

test('without the right to add, Shift+Enter on the last cell just stays in place', () => {
  /*
   * A room with `run: room, structure: host`: everyone may compute, the
   * skeleton belongs to the teacher. The run happened and was correct — the
   * toast "In this seminar the notebook's structure is the teacher's" on every
   * press read as "the run failed".
   */
  assert.deepEqual(stepPlan(LIST, 'c', 1, { grow: true, mayAdd: false }), { kind: 'stay' })
  // Still less should it try to insert: `grow` without the right is not a
  // refusal but "run and stay", as with ⌘↵.
  assert.notEqual(stepPlan(LIST, 'c', 1, { grow: true, mayAdd: false }).kind, 'grow')
})

test('a step from a cell that is not in the list moves nothing', () => {
  assert.deepEqual(stepPlan(LIST, 'нет такой', 1, { grow: true, mayAdd: true }), { kind: 'stay' })
})

test('without grow the last cell appends nothing', () => {
  assert.deepEqual(stepPlan(LIST, 'c', 1, { mayAdd: true }), { kind: 'stay' })
})
