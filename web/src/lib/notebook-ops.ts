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

export function insertCellBefore(doc: Y.Doc, beforeId: string, type: CellType): string {
  const index = indexOf(doc, beforeId)
  return insertCell(doc, type, Math.max(0, index))
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
    // Y.Array has no move: clone the cell, then delete the original.
    const source = cells.get(from)
    const clone = cloneCell(source)
    cells.delete(from, 1)
    cells.insert(to, [clone])
  })
}

/** Y.Map instances cannot be re-parented, so a move copies the content. */
function cloneCell(cell: YCell): YCell {
  const copy = new Y.Map<any>()
  copy.set('id', cellId(cell))
  copy.set('type', cellType(cell))
  const text = new Y.Text()
  const source = cellSource(cell).toString()
  if (source) text.insert(0, source)
  copy.set('source', text)
  copy.set('outputs', new Y.Array())
  copy.set('state', cell.get('state') ?? 'idle')
  copy.set('execCount', cell.get('execCount') ?? null)
  copy.set('runBy', cell.get('runBy') ?? null)
  return copy
}

export function setCellType(doc: Y.Doc, id: string, type: CellType): void {
  const index = indexOf(doc, id)
  if (index === -1) return
  const cell = getCells(doc).get(index)
  doc.transact(() => {
    cell.set('type', type)
    if (type === 'markdown') {
      cell.set('state', 'idle')
      cell.set('execCount', null)
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

export function replaceCellSource(doc: Y.Doc, id: string, next: string): void {
  const index = indexOf(doc, id)
  if (index === -1) return
  const text = cellSource(getCells(doc).get(index))
  doc.transact(() => {
    text.delete(0, text.length)
    text.insert(0, next)
  })
}
