/**
 * A teacher's worksheet survives import.
 *
 * Half of a teaching notebook is empty cells: "# Task 1 → an empty cell for
 * the answer → # Task 2 → …". The parser threw ALL of them away, though it
 * promised to throw away only the trailing ones — and only the task statements
 * arrived in the room. Silently: the import preview already shows the reduced
 * count, and in a lecture (structure: host) a student has no way to add the
 * cell back.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIpynb, readIpynb, writeIpynb } from '../shared/ipynb.js'

/** A worksheet notebook of exactly the kind handed out to a class. */
function worksheet(): unknown {
  return {
    cells: [
      { cell_type: 'markdown', source: '# Задание 1\n' },
      { cell_type: 'code', source: '' },
      { cell_type: 'markdown', source: '# Задание 2\n' },
      { cell_type: 'code', source: '\n  \n' },
      { cell_type: 'markdown', source: '# Задание 3\n' },
      { cell_type: 'code', source: '' },
    ],
  }
}

test('empty answer cells make it to the room', () => {
  const cells = readIpynb(worksheet())
  assert.equal(cells.length, 5, 'the answer cells were dropped from the worksheet')
  assert.deepEqual(
    cells.map((cell) => cell.type),
    ['markdown', 'code', 'markdown', 'code', 'markdown'],
  )
  // And the empty ones are exactly empty: nothing is substituted for the text.
  assert.equal(cells[1].source, '')
  assert.equal(cells[3].source, '\n  \n')
})

test('an empty cell at the end is an editor leftover, and it is still dropped', () => {
  const cells = readIpynb({
    cells: [
      { cell_type: 'code', source: 'x = 1' },
      { cell_type: 'code', source: '' },
      { cell_type: 'code', source: '\n  \n' },
    ],
  })
  assert.equal(cells.length, 1, 'the tail of empty cells made it into the room')
})

test('a notebook of nothing but empty cells is still nothing', () => {
  // The import refusal rests on this: "this notebook has no cells with
  // content".
  assert.deepEqual(readIpynb({ cells: [{ cell_type: 'code', source: '   ' }] }), [])
  assert.deepEqual(readIpynb({ cells: [] }), [])
})

test('the worksheet survives a round trip through a file', () => {
  /*
   * The room's notebooks lie on disk as files, and this same module writes
   * them. The round trip "read → write → read" is exactly what happens to a
   * worksheet opened in the room and projected back into a file.
   */
  const once = readIpynb(worksheet())
  const twice = parseIpynb(writeIpynb(once))
  assert.deepEqual(twice, once, 'the round trip through a file lost the answer cells')
})

/**
 * Schema 4.5 requires an `id` on every cell, and requires it from BOTH writers.
 *
 * There were two writers: the publication export (publish/notebook.ts) set
 * `id`, while the projection of the room's notebooks to disk did not, even
 * though both declared `nbformat_minor: 5`. A file from the room failed
 * `nbformat.validate`, and `nbformat.read` filled in its own names — so a
 * student who opened their own notebook on their machine got a warning and
 * someone else's identifiers. Now a single `writeIpynb` does the writing, and
 * it has one rule.
 */
test('every cell in a written .ipynb has an id', () => {
  const notebook = JSON.parse(
    writeIpynb([
      { id: 'c_ok', type: 'code', source: 'x = 1\n' },
      { id: 'плохой id', type: 'markdown', source: '# Заголовок\n' },
      { type: 'code', source: 'y = 2\n' },
    ]),
  ) as { nbformat_minor: number; cells: { id: string }[] }
  assert.equal(notebook.nbformat_minor, 5)
  // Its own name if it fits the schema; the ordinal number if not, or if none
  // was passed at all.
  assert.deepEqual(
    notebook.cells.map((cell) => cell.id),
    ['c_ok', 'cell-2', 'cell-3'],
  )
  for (const cell of notebook.cells) assert.match(cell.id, /^[a-zA-Z0-9-_]{1,64}$/)
})
