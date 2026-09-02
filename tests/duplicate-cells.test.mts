/**
 * A cell id appears once.
 *
 * Y.Array has no move, so the editor moves a cell by cloning it and deleting
 * the original. Two people nudging the same cell at the same moment merge into
 * two deletes — which collapse into one — and two inserts, which do not: the
 * notebook ends up holding the same cell twice under one id. Running it,
 * attributing it and asking the oracle about it are all keyed by that id.
 *
 * The server drops the copy THIS transaction brought and keeps the cell that
 * was already in the notebook; among copies that all arrived at once, the first
 * one stays. It decides, for the reason it also owns the seminar's title: there
 * is one of it, and it cannot be a stale client racing another.
 *
 * Порядок предпочтения — не вкусовщина. Совпавшее имя бывает законным: кто-то
 * вернул удалённую ячейку из истории — возврат воссоздаёт её с ПРЕЖНИМ именем,
 * — а тот, кто её удалял, нажал Ctrl+Z, и Yjs отменил удаление копией. Выкинуть
 * надо копию: оставь её вместо живой ячейки, и подменить чужую работу своей
 * можно было бы одним совпадением имени.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { cellSource, createCell, getCells } from '../shared/notebook.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

let seq = 0
function room(sources: string[]) {
  const id = `dup${seq++}`
  createSession(id, `Duplicates ${id}`)
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  doc.transact(() => {
    cells.delete(0, cells.length)
    cells.push(sources.map((source) => createCell('code', source)))
  })
  return { id, doc, cells, ids: cells.toArray().map((c) => c.get('id') as string) }
}

const ids = (cells: Y.Array<Y.Map<unknown>>) => cells.toArray().map((c) => c.get('id') as string)

/** What a clone-based move produces, without going through the editor. */
function cloneOf(cell: Y.Map<unknown>): Y.Map<unknown> {
  const copy = new Y.Map<unknown>()
  copy.set('id', cell.get('id'))
  copy.set('type', cell.get('type'))
  const text = new Y.Text()
  text.insert(0, cellSource(cell as never).toString())
  copy.set('source', text)
  copy.set('outputs', new Y.Array())
  copy.set('state', cell.get('state') ?? 'idle')
  copy.set('execCount', null)
  return copy
}

test('a copy that arrives beside a living cell is the one that goes', async () => {
  const { doc, cells } = room(['one', 'two', 'three'])
  // Ctrl+Z после чужого возврата версии выглядит ровно так: ячейка на месте, и
  // рядом встаёт её копия — с текстом на момент удаления.
  const copy = cloneOf(cells.get(2))
  copy.set('source', new Y.Text('другое'))
  doc.transact(() => cells.insert(1, [copy]))
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(new Set(ids(cells)).size, cells.length, `ids are not unique: ${ids(cells)}`)
  assert.equal(cells.length, 3, 'the notebook grew or shrank')
  // Живая ячейка осталась на месте со своим текстом: подменить её по имени
  // нельзя, и Ctrl+Z у соседа не стоил ему закрытого сокета.
  assert.deepEqual(
    cells.toArray().map((c) => cellSource(c as never).toString()),
    ['one', 'two', 'three'],
  )
})

test('the first copy is the one that stays, when the original is gone', async () => {
  // Что оставляют две слитые перестановки: удаление у обеих одно и то же и
  // применяется однажды, а вставок две — и обе новые.
  const { doc, cells } = room(['one', 'two'])
  // Клоны снимаются до удаления: у удалённой Y.Map ключей уже не прочитать.
  const copies = [cloneOf(cells.get(1)), cloneOf(cells.get(1))]
  doc.transact(() => {
    cells.delete(1, 1)
    for (const copy of copies) cells.insert(0, [copy])
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(cells.length, 2)
  assert.deepEqual(ids(cells).length, new Set(ids(cells)).size)
  assert.equal(cellSource(cells.get(0) as never).toString(), 'two')
})

test('cells that merely look alike are left alone', async () => {
  // Same source, same everything except the id: two people typing the same
  // line is not a duplicate.
  const { doc, cells } = room(['import torch'])
  doc.transact(() => cells.push([createCell('code', 'import torch')]))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(cells.length, 2, 'a legitimate second cell was eaten')
})

test('deleting cells never triggers the repair', async () => {
  const { doc, cells } = room(['one', 'two', 'three'])
  doc.transact(() => cells.delete(1, 1))
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(
    cells.toArray().map((c) => cellSource(c as never).toString()),
    ['one', 'three'],
  )
})

test('a cell with no id at all does not take the others down with it', async () => {
  const { doc, cells } = room(['one'])
  doc.transact(() => {
    const odd = new Y.Map<unknown>()
    odd.set('type', 'code')
    odd.set('source', new Y.Text())
    cells.push([odd])
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(cells.length, 2, 'the repair ate a cell it could not identify')
})
