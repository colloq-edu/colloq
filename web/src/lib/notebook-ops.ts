import * as Y from 'yjs'
import {
  bookCells,
  cellId,
  cellSource,
  cellType,
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
 * Тетрадей в комнате несколько, и каждая правка называет свою: `root` — имя
 * корня той тетради, в которой нажали. Единственное исключение — то, что
 * адресуется ИМЕНЕМ ячейки: имя в комнате одно, и по нему тетрадь находится
 * сама (см. `findCell`). Так вызывающему не приходится помнить, из какой
 * тетради ячейка, ради операции, которой это всё равно.
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

export function insertCellAfter(doc: Y.Doc, root: string, afterId: string | null, type: CellType): string {
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
  const found = findCell(doc, id)
  if (!found) return false
  const to = found.index + direction
  return to >= 0 && to < found.cells.length
}

export function setCellType(doc: Y.Doc, id: string, type: CellType): void {
  const found = findCell(doc, id)
  if (!found) return
  /*
   * Пишется только вид. Гашение секундомера и вывода — забота сервера: он
   * делает это, увидев принятую смену вида (`collab/ops.ts · resetAfterRetype`).
   *
   * Здесь было единственное место, где состояние выполнения писал браузер, и
   * пока оно было, правило «вывод и состояние пишет только сервер» имело
   * исключение — то есть не было правилом.
   */
  doc.transact(() => found.cell.set('type', type))
}

export function duplicateCell(doc: Y.Doc, root: string, id: string): string | null {
  const found = findCell(doc, id)
  if (!found) return null
  const source = cellSource(found.cell).toString()
  return insertCell(doc, root, cellType(found.cell), found.index + 1, source)
}
