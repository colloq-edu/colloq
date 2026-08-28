import * as Y from 'yjs'
import {
  cellId,
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

/**
 * Можно ли двигать эту ячейку — только чтобы не рисовать мёртвую кнопку.
 *
 * Сама перестановка делается на сервере (`cells:move`): у Y.Array нет
 * перемещения, так что соседнюю ячейку приходится пересоздать клоном, а клон
 * несёт её вывод — и запись чужого вывода из браузера закрыта в любой комнате.
 * Переупорядочить тетрадь не повод выбрасывать то, что она напечатала, поэтому
 * уехала операция, а не свойство.
 */
export function canMoveCell(doc: Y.Doc, id: string, direction: -1 | 1): boolean {
  const from = indexOf(doc, id)
  if (from === -1) return false
  const to = from + direction
  return to >= 0 && to < getCells(doc).length
}

export function setCellType(doc: Y.Doc, id: string, type: CellType): void {
  const index = indexOf(doc, id)
  if (index === -1) return
  const cell = getCells(doc).get(index)
  /*
   * Пишется только вид. Гашение секундомера и вывода — забота сервера: он
   * делает это, увидев принятую смену вида (`collab/ops.ts · resetAfterRetype`).
   *
   * Здесь было единственное место, где состояние выполнения писал браузер, и
   * пока оно было, правило «вывод и состояние пишет только сервер» имело
   * исключение — то есть не было правилом.
   */
  doc.transact(() => cell.set('type', type))
}

export function duplicateCell(doc: Y.Doc, id: string): string | null {
  const cells = getCells(doc)
  const index = indexOf(doc, id)
  if (index === -1) return null
  const source = cellSource(cells.get(index)).toString()
  return insertCell(doc, cellType(cells.get(index)), index + 1, source)
}
