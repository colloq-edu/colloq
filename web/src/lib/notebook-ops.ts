
import * as Y from 'yjs'
import {
  allCellArrays,
  bookCells,
  cellId,
  createCell,
  findCell,
  type CellType,
  type YCell,
} from '@shared/notebook'

/**
 * Structural edits to the notebook.
 *
 * Every mutation is wrapped in a transaction so remote peers see one atomic
 * change instead of a flicker of intermediate states, and undo groups sensibly.
 *
 * A room has several notebooks, and every edit names its own: `root` is the
 * root name of the notebook where the press happened. The only exception is
 * what is addressed by a cell's NAME (its id): a name is unique in the room,
 * and the notebook is found by it on its own (see `findCell`). This way the
 * caller does not have to remember which notebook a cell is from, for an
 * operation that does not care.
 */

function arrayOf(doc: Y.Doc, root: string): Y.Array<YCell> {
  return bookCells(doc, root)
}

export function insertCell(
  doc: Y.Doc,
  root: string,
  type: CellType,
  at: number,
  source = '',
): string {
  const cells = arrayOf(doc, root)
  const cell = createCell(type, source)
  const index = Math.max(0, Math.min(at, cells.length))
  doc.transact(() => cells.insert(index, [cell]))
  return cellId(cell)
}

export function insertCellAfter(
  doc: Y.Doc,
  root: string,
  afterId: string | null,
  type: CellType,
): string {
  const cells = arrayOf(doc, root)
  const found = afterId ? findCell(doc, afterId) : null
  const index = found ? found.index : cells.length - 1
  return insertCell(doc, root, type, index + 1)
}

export function deleteCell(doc: Y.Doc, id: string): void {
  const found = findCell(doc, id)
  if (!found) return
  const { cells, index } = found
  doc.transact(() => {
    cells.delete(index, 1)
    // Never leave the room staring at an empty page.
    if (cells.length === 0) cells.push([createCell('code')])
  })
}

/** In the server's words: exactly what `control.ts` answers to a second cell. */
export const ONE_AT_A_TIME = "В этом семинаре можно запускать по одной ячейке. Ваша ячейка уже выполняется или стоит в очереди."

/**
 * Whether this person has a cell that is computing now or waiting in the
 * queue.
 *
 * The queue ceiling under the "one at a time" rule lives on the server
 * (`runQueueCap`), and the client did not see it: it checked only the right to
 * run, sent the run, got a refusal — and still managed to step down and append
 * an empty cell to the shared notebook. Five presses — five empty cells for
 * the whole class.
 *
 * We count by the document, because the cell states in it are that queue:
 * `requestRun` measures the same thing with its own runtime (the queue plus
 * the same person's current cell). The server decides anyway — this is only
 * to avoid editing the shared document for a refused run.
 */
export function hasPendingRun(doc: Y.Doc, participantId: string): boolean {
  for (const cells of allCellArrays(doc)) {
    for (const cell of cells.toArray()) {
      const state = cell.get('state')
      if (state !== 'running' && state !== 'queued') continue
      if ((cell.get('runById') as string | null) === participantId) return true
    }
  }
  return false
}

/**
 * Whether this cell can be moved — only so as not to draw a dead button.
 *
 * The move itself happens on the server (`cells:move`): Y.Array has no move,
 * so the neighbouring cell has to be recreated as a clone, and the clone
 * carries its output — and writing someone else's output from the browser is
 * closed in every room. Reordering a notebook is no reason to throw away what
 * it printed, so it was the operation that moved, not the property.
 */
export function canMoveCell(doc: Y.Doc, id: string, direction: -1 | 1): boolean {
  const found = findCell(doc, id)
  if (!found) return false
  const to = found.index + direction
  return to >= 0 && to < found.cells.length
}

export function setCellType(doc: Y.Doc, id: string, type: CellType): void {
  const found = findCell(doc, id)
  if (!found) return
  /*
   * Only the type is written. Clearing the stopwatch and the output is the
   * server's job: it does this on seeing an accepted type change
   * (`collab/ops.ts · resetAfterRetype`).
   *
   * This was the only place where the browser wrote execution state, and while
   * it existed, the rule "only the server writes output and state" had an
   * exception — that is, it was not a rule.
   */
  doc.transact(() => found.cell.set('type', type))
}

