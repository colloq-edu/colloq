/**
 * The notebook as a document people rearrange while other people are in it.
 *
 * Y.Array has no move, so a cell is moved by cloning it and deleting the
 * original. Everything the cell was carrying has to come along — the outputs
 * were being left behind, so a cell that had just printed a number arrived at
 * its new position still claiming to have run as [3] with nothing under it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { cellOutputs, cellSource, createCell, getCells } from '../shared/notebook.js'
import {
  deleteCell,
  duplicateCell,
  insertCellAfter,
  moveCell,
  setCellType,
} from '../web/src/lib/notebook-ops.js'

function notebook(sources: string[]) {
  const doc = new Y.Doc()
  const cells = getCells(doc)
  const made = sources.map((source) => createCell('code', source))
  doc.transact(() => cells.push(made))
  return { doc, cells, made, ids: made.map((c) => c.get('id') as string) }
}

function printed(cell: Y.Map<unknown>, text: string): void {
  const output = new Y.Map<unknown>()
  output.set('kind', 'stream')
  output.set('name', 'stdout')
  const body = new Y.Text()
  body.insert(0, text)
  output.set('text', body)
  cellOutputs(cell as never).push([output as never])
}

const order = (cells: Y.Array<Y.Map<unknown>>) =>
  cells.toArray().map((c) => cellSource(c as never).toString())

/* ------------------------------------------------------------------ moving */

test('a cell keeps what it printed when it moves', () => {
  const { doc, cells, made, ids } = notebook(['a = 1', 'b = 2'])
  doc.transact(() => {
    made[0].set('state', 'ok')
    made[0].set('execCount', 3)
    made[0].set('runBy', 'Maria')
    made[0].set('runById', 'p_maria')
  })
  printed(made[0], '42\n')

  moveCell(doc, ids[0], 1)
  const moved = cells.toArray().find((c) => (c.get('id') as string) === ids[0])!
  assert.equal(order(cells).join(','), 'b = 2,a = 1', 'the cell did not move')
  const outputs = moved.get('outputs') as Y.Array<Y.Map<unknown>>
  assert.equal(outputs.length, 1, 'the output was left behind')
  assert.equal((outputs.get(0).get('text') as Y.Text).toString(), '42\n')
  // And the claim on the cell still matches what is under it.
  assert.equal(moved.get('state'), 'ok')
  assert.equal(moved.get('execCount'), 3)
  assert.equal(moved.get('runBy'), 'Maria')
  assert.equal(moved.get('runById'), 'p_maria', 'the run lost its owner')
})

test('the copied output is a copy, not the same object twice', () => {
  const { doc, cells, made, ids } = notebook(['x', 'y'])
  printed(made[0], 'before\n')
  moveCell(doc, ids[0], 1)
  const moved = cells.toArray().find((c) => (c.get('id') as string) === ids[0])!
  const text = (moved.get('outputs') as Y.Array<Y.Map<unknown>>).get(0).get('text') as Y.Text
  text.insert(text.length, 'after\n')
  assert.equal(text.toString(), 'before\nafter\n')
})

test('a move at the edge of the notebook does nothing', () => {
  const { doc, cells, ids } = notebook(['one', 'two'])
  moveCell(doc, ids[0], -1)
  moveCell(doc, ids[1], 1)
  assert.deepEqual(order(cells), ['one', 'two'])
})

/* ---------------------------------------------------------------- the rest */

test('the notebook is never left with nothing in it', () => {
  const { doc, cells, ids } = notebook(['only one'])
  deleteCell(doc, ids[0])
  assert.equal(cells.length, 1, 'the room was left staring at an empty page')
  assert.equal(cellSource(cells.get(0) as never).toString(), '')
})

test('turning a cell into prose drops the outputs it can no longer have', () => {
  const { doc, cells, made, ids } = notebook(['print(1)'])
  doc.transact(() => {
    made[0].set('state', 'ok')
    made[0].set('execCount', 7)
  })
  printed(made[0], '1\n')
  setCellType(doc, ids[0], 'markdown')
  const cell = cells.get(0)
  assert.equal(cell.get('type'), 'markdown')
  assert.equal((cell.get('outputs') as Y.Array<unknown>).length, 0)
  assert.equal(cell.get('execCount'), null)
  assert.equal(cell.get('state'), 'idle')
})

test('a duplicate is a new cell, not the same one twice', () => {
  const { doc, cells, ids } = notebook(['shared'])
  const copyId = duplicateCell(doc, ids[0])
  assert.ok(copyId)
  assert.notEqual(copyId, ids[0], 'the copy carries the original id')
  assert.equal(cells.length, 2)
  assert.equal(new Set(cells.toArray().map((c) => c.get('id'))).size, 2)
})

test('inserting after a cell puts it next, not at the end', () => {
  const { doc, cells, ids } = notebook(['one', 'two', 'three'])
  const id = insertCellAfter(doc, ids[0], 'code')
  assert.equal(cells.toArray().findIndex((c) => (c.get('id') as string) === id), 1)
})

test('an operation on a cell that is gone is a no-op, not a crash', () => {
  const { doc, cells } = notebook(['one', 'two'])
  const before = order(cells)
  moveCell(doc, 'c_never_existed', 1)
  deleteCell(doc, 'c_never_existed')
  setCellType(doc, 'c_never_existed', 'markdown')
  assert.equal(duplicateCell(doc, 'c_never_existed'), null)
  assert.deepEqual(order(cells), before)
})

test('двигают ячейку — пересоздают соседа, а не её', () => {
  const { doc, cells, made, ids } = notebook(['a = 1', 'b = 2'])
  const moving = made[0]
  const movingText = moving.get('source') as Y.Text

  moveCell(doc, ids[0], 1)

  // Порядок тот же, что и был бы при любом способе.
  assert.equal(order(cells).join(','), 'b = 2,a = 1')

  /*
   * Та ячейка, на кнопке которой стоял палец, — тот же самый объект.
   *
   * У Y.Array нет перемещения, так что одну из двух приходится пересоздавать
   * клоном, и всё привязанное к ней — редактор, курсор, набранное в этот миг —
   * пересоздаётся вместе с ней. Пусть это будет сосед.
   */
  const after = cells.toArray().find((c) => (c.get('id') as string) === ids[0])!
  assert.equal(after, moving, 'подвинули саму ячейку вместо соседа')

  // И её Y.Text по-прежнему живой: то, что в него пишет CodeMirror, доезжает.
  movingText.insert(movingText.length, ' + 1')
  assert.equal(order(cells).join(','), 'b = 2,a = 1 + 1')
})

test('перестановка соседа не сбивает секундомер работающей ячейки', () => {
  /*
   * Настоящий путь той же беды: двигают пятую, пересоздаётся шестая. Пока
   * ячейка считается, её `startedAt` — это то, из чего в комнате растёт цифра
   * секундомера; исчезнув, он останавливает часы на работающей ячейке.
   */
  const { doc, cells, made, ids } = notebook(['a = 1', 'b = 2'])
  doc.transact(() => {
    made[1].set('state', 'running')
    made[1].set('startedAt', 1_700_000_000_000)
  })

  moveCell(doc, ids[0], 1)

  const still = cells.toArray().find((c) => (c.get('id') as string) === ids[1])!
  assert.equal(still.get('state'), 'running')
  assert.equal(still.get('startedAt'), 1_700_000_000_000, 'секундомер потерялся при перестановке')
})
