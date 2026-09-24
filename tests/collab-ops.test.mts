/**
 * Edits to a notebook's cell list that the server makes itself.
 *
 * Two things here break silently and cost someone else's work. A move
 * recreates one of the two neighbouring cells as a clone, and everything its
 * editor sent during the round trip to the server lands in a tombstone: the
 * characters vanish for the person typing, and Ctrl+Z will not bring them
 * back. And settling a new cell to a clean state used to write six keys over
 * the same values — that is, a server-side update for every added cell, which
 * made the history attribute a person's edit to "the room".
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { moveInCells, onCarets, settleFresh } from '../server/src/collab/ops.js'
import { cellId, cellSource, createCell, getCells, type YCell } from '../shared/notebook.js'

function sheet(sources: string[]): { doc: Y.Doc; cells: Y.Array<YCell> } {
  const doc = new Y.Doc()
  const cells = getCells(doc)
  doc.transact(() => cells.push(sources.map((source) => createCell('code', source))))
  return { doc, cells }
}

const at = (cells: Y.Array<YCell>, i: number): string => cellSource(cells.get(i)).toString()

test('a move changes the order', () => {
  const { doc, cells } = sheet(['a', 'b'])
  onCarets(() => new Set())
  assert.equal(moveInCells(doc, cellId(cells.get(0)), 1), true)
  assert.deepEqual([at(cells, 0), at(cells, 1)], ['b', 'a'])
})

test('a cell does not move past the edge of the notebook', () => {
  const { doc, cells } = sheet(['a', 'b'])
  onCarets(() => new Set())
  assert.equal(moveInCells(doc, cellId(cells.get(0)), -1), false)
  assert.equal(moveInCells(doc, cellId(cells.get(1)), 1), false)
  assert.equal(moveInCells(doc, 'c_нет', 1), false)
})

test('the neighbour is recreated, so the caret of whoever pressed stays alive', () => {
  const { doc, cells } = sheet(['a', 'b'])
  onCarets(() => new Set())
  const mover = cellSource(cells.get(0))
  moveInCells(doc, cellId(cells.get(0)), 1)
  assert.equal(cellSource(cells.get(1)) === mover, true, 'recreated the cell whose button was pressed')
})

test("a move does not recreate a cell that holds someone else's caret", () => {
  /*
   * A clone loses the keystrokes that went into the old Y.Text during the
   * round trip to the server: they are addressed to a deleted structure, the
   * gate lets them through, and the characters vanish silently. The caret of
   * whoever pressed is cheaper: at that moment they are clicking, not typing.
   */
  const { doc, cells } = sheet(['a', 'b'])
  const typing = cellSource(cells.get(1))
  onCarets(() => new Set([cellId(cells.get(1))]))
  moveInCells(doc, cellId(cells.get(0)), 1)
  assert.deepEqual([at(cells, 0), at(cells, 1)], ['b', 'a'], 'the order came out wrong')
  assert.equal(cellSource(cells.get(0)) === typing, true, 'recreated the cell someone is typing in')
})

test('settling a new cell writes nothing when it is already clean', () => {
  const { doc, cells } = sheet(['x = 1'])
  const id = cellId(cells.get(0))
  let updates = 0
  doc.on('update', () => (updates += 1))
  doc.transact(() => settleFresh('ops-test', doc, [id]), 'server')
  assert.equal(updates, 0, 'the server rewrote keys with the same values')
})
