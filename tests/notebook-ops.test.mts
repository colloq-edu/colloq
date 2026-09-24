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
import { CELLS_KEY, cellOutputs, cellSource, createCell, getCells } from '../shared/notebook.js'
import {
  deleteCell,
  hasPendingRun,
  insertCellAfter,
  setCellType,
} from '../web/src/lib/notebook-ops.js'
/*
 * A move is done on the server, not in the browser: the neighbour's clone
 * carries its output, and writing output from the browser is closed in every
 * room. The move's properties did not change with the relocation, and they are
 * checked right here.
 */
import { moveInCells, resetRetyped } from '../server/src/collab/ops.js'

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

  moveInCells(doc, ids[0], 1)
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
  moveInCells(doc, ids[0], 1)
  const moved = cells.toArray().find((c) => (c.get('id') as string) === ids[0])!
  const text = (moved.get('outputs') as Y.Array<Y.Map<unknown>>).get(0).get('text') as Y.Text
  text.insert(text.length, 'after\n')
  assert.equal(text.toString(), 'before\nafter\n')
})

test('a move at the edge of the notebook does nothing', () => {
  const { doc, cells, ids } = notebook(['one', 'two'])
  moveInCells(doc, ids[0], -1)
  moveInCells(doc, ids[1], 1)
  assert.deepEqual(order(cells), ['one', 'two'])
})

/* ---------------------------------------------------------------- the rest */

test('the notebook is never left with nothing in it', () => {
  const { doc, cells, ids } = notebook(['only one'])
  deleteCell(doc, ids[0])
  assert.equal(cells.length, 1, 'the room was left staring at an empty page')
  assert.equal(cellSource(cells.get(0) as never).toString(), '')
})

test('a cell turned into text loses its output — but the server clears it', () => {
  /*
   * Two halves of one action. The browser writes only the type: while it
   * cleared the execution state here, the rule "output and state are written
   * only by the server" had an exception — that is, it was not a rule. The
   * server clears the stopwatch and the output once it sees the accepted type
   * change.
   */
  const { doc, cells, made, ids } = notebook(['print(1)'])
  doc.transact(() => {
    made[0].set('state', 'ok')
    made[0].set('execCount', 7)
  })
  printed(made[0], '1\n')

  setCellType(doc, ids[0], 'markdown')
  const cell = cells.get(0)
  assert.equal(cell.get('type'), 'markdown')
  assert.equal(
    (cell.get('outputs') as Y.Array<unknown>).length,
    1,
    'the browser cleared the output itself — so it still writes server fields',
  )

  doc.transact(() => resetRetyped(doc, [ids[0]]))
  assert.equal((cell.get('outputs') as Y.Array<unknown>).length, 0)
  assert.equal(cell.get('execCount'), null)
  assert.equal(cell.get('state'), 'idle')
})

test('the server does not clear execution on a cell that stayed code', () => {
  // A cell made text and turned right back within one round: its name is in
  // the list, but the type is 'code' again — there is nothing to clear.
  const { doc, cells, made, ids } = notebook(['print(1)'])
  doc.transact(() => made[0].set('state', 'ok'))
  printed(made[0], '1\n')
  doc.transact(() => resetRetyped(doc, [ids[0]]))
  assert.equal((cells.get(0).get('outputs') as Y.Array<unknown>).length, 1)
  assert.equal(cells.get(0).get('state'), 'ok')
})

test('inserting after a cell puts it next, not at the end', () => {
  const { doc, cells, ids } = notebook(['one', 'two', 'three'])
  const id = insertCellAfter(doc, CELLS_KEY, ids[0], 'code')
  assert.equal(cells.toArray().findIndex((c) => (c.get('id') as string) === id), 1)
})

test('an operation on a cell that is gone is a no-op, not a crash', () => {
  const { doc, cells } = notebook(['one', 'two'])
  const before = order(cells)
  moveInCells(doc, 'c_never_existed', 1)
  deleteCell(doc, 'c_never_existed')
  setCellType(doc, 'c_never_existed', 'markdown')
  assert.deepEqual(order(cells), before)
})

test('moving a cell recreates the neighbour, not the cell itself', () => {
  const { doc, cells, made, ids } = notebook(['a = 1', 'b = 2'])
  const moving = made[0]
  const movingText = moving.get('source') as Y.Text

  moveInCells(doc, ids[0], 1)

  // The order is the same as it would be with any method.
  assert.equal(order(cells).join(','), 'b = 2,a = 1')

  /*
   * The cell whose button the finger was on is the very same object.
   *
   * Y.Array has no move, so one of the two has to be recreated as a clone, and
   * everything bound to it — the editor, the cursor, what is being typed at
   * that instant — is recreated along with it. Let that be the neighbour.
   */
  const after = cells.toArray().find((c) => (c.get('id') as string) === ids[0])!
  assert.equal(after, moving, 'the cell itself was moved instead of the neighbour')

  // And its Y.Text is still alive: what CodeMirror writes into it gets
  // through.
  movingText.insert(movingText.length, ' + 1')
  assert.equal(order(cells).join(','), 'b = 2,a = 1 + 1')
})

test('moving a neighbour does not reset the stopwatch of a running cell', () => {
  /*
   * The real path of the same trouble: the fifth cell is moved, the sixth is
   * recreated. While a cell is computing, its `startedAt` is what the
   * stopwatch figure in the room grows from; when it disappears, the clock
   * stops on a running cell.
   */
  const { doc, cells, made, ids } = notebook(['a = 1', 'b = 2'])
  doc.transact(() => {
    made[1].set('state', 'running')
    made[1].set('startedAt', 1_700_000_000_000)
  })

  moveInCells(doc, ids[0], 1)

  const still = cells.toArray().find((c) => (c.get('id') as string) === ids[1])!
  assert.equal(still.get('state'), 'running')
  assert.equal(still.get('startedAt'), 1_700_000_000_000, 'the stopwatch was lost in the move')
})

/*
 * The "one at a time" ceiling lives on the server, and the Shift+Enter step
 * in the browser, and until now they knew nothing of each other: a refused
 * run still stepped down and appended an empty cell to the class's shared
 * notebook. The client counts its own cells the same way `requestRun` does:
 * the queue plus the one already computing.
 */
test('your own cell in the queue or in work is visible to the client', () => {
  const { doc, made } = notebook(['a = 1', 'b = 2', 'c = 3'])
  assert.equal(hasPendingRun(doc, 'anna'), false)

  doc.transact(() => {
    made[0].set('state', 'queued')
    made[0].set('runById', 'petya')
  })
  // Someone else's queue does not take up the ceiling — otherwise your own
  // cell would never run while the teacher holds the kernel.
  assert.equal(hasPendingRun(doc, 'anna'), false)
  assert.equal(hasPendingRun(doc, 'petya'), true)

  doc.transact(() => {
    made[1].set('state', 'running')
    made[1].set('runById', 'anna')
  })
  assert.equal(hasPendingRun(doc, 'anna'), true)

  // Done computing — the ceiling is free again.
  doc.transact(() => made[1].set('state', 'ok'))
  assert.equal(hasPendingRun(doc, 'anna'), false)
})
