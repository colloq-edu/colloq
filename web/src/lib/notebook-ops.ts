import * as Y from 'yjs'
import {
  cellId,
  cloneCell,
  cellSource,
  cellType,
  createCell,
  getCells,
  type CellType,
  type YCell,
} from '@shared/notebook'

/**
 * Structural edits to the notebook.
 *
 * Every mutation is wrapped in a transaction so remote peers see one atomic
 * change instead of a flicker of intermediate states, and undo groups sensibly.
 */

function indexOf(doc: Y.Doc, id: string): number {
  const cells = getCells(doc)
  for (let i = 0; i < cells.length; i++) if (cellId(cells.get(i)) === id) return i
  return -1
}

export function insertCell(
  doc: Y.Doc,
  type: CellType,
  at: number,
  source = '',
): string {
  const cells = getCells(doc)
  const cell = createCell(type, source)
  const index = Math.max(0, Math.min(at, cells.length))
  doc.transact(() => cells.insert(index, [cell]))
  return cellId(cell)
}

export function insertCellAfter(doc: Y.Doc, afterId: string | null, type: CellType): string {
  const cells = getCells(doc)
  const index = afterId ? indexOf(doc, afterId) : cells.length - 1
  return insertCell(doc, type, index + 1)
}

export function deleteCell(doc: Y.Doc, id: string): void {
  const cells = getCells(doc)
  const index = indexOf(doc, id)
  if (index === -1) return
  doc.transact(() => {
    cells.delete(index, 1)
    // Never leave the room staring at an empty page.
    if (cells.length === 0) cells.push([createCell('code')])
  })
}

export function moveCell(doc: Y.Doc, id: string, direction: -1 | 1): void {
  const cells = getCells(doc)
  const from = indexOf(doc, id)
  if (from === -1) return
  const to = from + direction
  if (to < 0 || to >= cells.length) return

  doc.transact(() => {
    /*
     * Переезжает сосед, а не та ячейка, которую двигают.
     *
     * У Y.Array нет перемещения: одну из двух ячеек всё равно придётся
     * пересоздать клоном, и всё, что к ней привязано, пересоздастся вместе с
     * ней — редактор, курсор, выделение, буквы, набранные в этот миг. Раньше
     * это была та самая ячейка, на кнопке которой стоял палец и в которой
     * стоял курсор: человек нажимал «вниз» и терял место в строке, а иногда
     * пару символов.
     *
     * Поменять ячейки местами можно, двигая любую из двух: результат тот же.
     * Так что пересоздаётся соседняя — та, в которую только что заведомо никто
     * не печатал, потому что печатали в этой.
     */
    const neighbour = cloneCell(cells.get(to))
    cells.delete(to, 1)
    cells.insert(from, [neighbour])
  })
}

/**
 * Y.Map instances cannot be re-parented, so a move copies the content.
 *
 * Everything the cell was carrying comes with it. The outputs used to be left
 * behind — a fresh empty array — while `state` and `execCount` were copied, so
 * a cell that had just printed a number arrived at its new position still
 * claiming to have run as [3] with nothing under it. Reordering a notebook is
 * not a reason to throw away what it printed.
 *
 * What a copy cannot carry is a *concurrent* edit: somebody typing into the
 * copied cell at that moment is typing into the original, and the original is
 * about to be deleted. That is inherent to a list with no move operation, and
 * the window is one sync round — which is why `moveCell` copies the neighbour
 * rather than the cell whose button was just pressed.
 */


/** Outputs are Y types too, so they are rebuilt rather than referenced. */

export function setCellType(doc: Y.Doc, id: string, type: CellType): void {
  const index = indexOf(doc, id)
  if (index === -1) return
  const cell = getCells(doc).get(index)
  doc.transact(() => {
    cell.set('type', type)
    if (type === 'markdown') {
      cell.set('state', 'idle')
      cell.set('execCount', null)
      /*
       * Единственное место, где состояние выполнения пишет клиент.
       *
       * «Превратить в текст» стоит в том же тулбаре, что и «стоп», — одно
       * нажатие от работающей ячейки. Не погасить здесь секундомер значит
       * оставить его идти на ячейке, которая больше не ячейка с кодом.
       */
      cell.set('startedAt', null)
      cell.set('ranMs', null)
      const outputs = cell.get('outputs')
      if (outputs instanceof Y.Array && outputs.length > 0) outputs.delete(0, outputs.length)
    }
  })
}

export function duplicateCell(doc: Y.Doc, id: string): string | null {
  const cells = getCells(doc)
  const index = indexOf(doc, id)
  if (index === -1) return null
  const source = cellSource(cells.get(index)).toString()
  return insertCell(doc, cellType(cells.get(index)), index + 1, source)
}
