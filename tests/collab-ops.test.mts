/**
 * Правки состава тетради, которые делает сервер.
 *
 * Две вещи здесь ломаются молча и стоят чужой работы. Перестановка пересоздаёт
 * одну из двух соседних ячеек клоном, и всё, что её редактор отправил за круг
 * до сервера, ложится в надгробие: символы пропадают у печатающего, и Ctrl+Z их
 * не вернёт. А приведение новой ячейки к чистой писало шесть ключей поверх тех
 * же значений — то есть серверный такт на каждую добавленную ячейку, из-за
 * которого правка человека подписывалась в истории «the room».
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

test('перестановка меняет порядок', () => {
  const { doc, cells } = sheet(['a', 'b'])
  onCarets(() => new Set())
  assert.equal(moveInCells(doc, cellId(cells.get(0)), 1), true)
  assert.deepEqual([at(cells, 0), at(cells, 1)], ['b', 'a'])
})

test('за край тетради ячейка не переставляется', () => {
  const { doc, cells } = sheet(['a', 'b'])
  onCarets(() => new Set())
  assert.equal(moveInCells(doc, cellId(cells.get(0)), -1), false)
  assert.equal(moveInCells(doc, cellId(cells.get(1)), 1), false)
  assert.equal(moveInCells(doc, 'c_нет', 1), false)
})

test('пересоздаётся сосед — у нажавшего курсор остаётся живым', () => {
  const { doc, cells } = sheet(['a', 'b'])
  onCarets(() => new Set())
  const mover = cellSource(cells.get(0))
  moveInCells(doc, cellId(cells.get(0)), 1)
  assert.equal(cellSource(cells.get(1)) === mover, true, 'пересоздали ту, на кнопку которой нажали')
})

test('ячейку, в которой стоит чужой курсор, перестановка не пересоздаёт', () => {
  /*
   * Клон уносит с собой нажатия, ушедшие в старый Y.Text за круг до сервера:
   * они адресованы удалённой структуре, гейт их пропускает, и символы пропадают
   * молча. Курсор нажавшего дешевле: он в этот момент нажимает, а не печатает.
   */
  const { doc, cells } = sheet(['a', 'b'])
  const typing = cellSource(cells.get(1))
  onCarets(() => new Set([cellId(cells.get(1))]))
  moveInCells(doc, cellId(cells.get(0)), 1)
  assert.deepEqual([at(cells, 0), at(cells, 1)], ['b', 'a'], 'порядок вышел не тот')
  assert.equal(cellSource(cells.get(0)) === typing, true, 'пересоздали ячейку, в которой печатают')
})

test('приведение новой ячейки к чистой не пишет ничего, когда она и так чиста', () => {
  const { doc, cells } = sheet(['x = 1'])
  const id = cellId(cells.get(0))
  let updates = 0
  doc.on('update', () => (updates += 1))
  doc.transact(() => settleFresh('ops-test', doc, [id]), 'server')
  assert.equal(updates, 0, 'сервер переписал ключи теми же значениями')
})
