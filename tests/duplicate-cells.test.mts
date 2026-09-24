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
 * The order of preference is not a matter of taste. A matching id can be
 * legitimate: someone brought a deleted cell back from history — the restore
 * recreates it with the OLD id — and the one who had deleted it pressed
 * Ctrl+Z, and Yjs undid the deletion with a copy. The copy is what must be
 * thrown out: keep it instead of the living cell, and someone else's work
 * could be replaced with one's own by a single id match.
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

/*
 * We wait for nothing, and that is a statement about the repair, not a
 * saving.
 *
 * The observer is `afterTransaction`, that is, the copy disappears INSIDE
 * the same transaction that brought it: the notebook never has a twin for a
 * single tick. There used to be `await setTimeout(10)` here, which waited
 * for nothing (the transaction had already ended) and would also hide the
 * intent: delay the repair by even one frame — and the cell would have time
 * to reach the kernel, the oracle and the projector under someone else's
 * id. The test checks the state right after `transact`, so a deferred repair
 * fails here instead of becoming flaky.
 */

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

test('a copy that arrives beside a living cell is the one that goes', () => {
  const { doc, cells } = room(['one', 'two', 'three'])
  // Ctrl+Z after someone else's version restore looks exactly like this: the
  // cell is in place, and its copy stands next to it — with the text as of
  // the deletion.
  const copy = cloneOf(cells.get(2))
  copy.set('source', new Y.Text('другое'))
  doc.transact(() => cells.insert(1, [copy]))

  assert.equal(new Set(ids(cells)).size, cells.length, `ids are not unique: ${ids(cells)}`)
  assert.equal(cells.length, 3, 'the notebook grew or shrank')
  // The living cell stayed in place with its text: it cannot be replaced by
  // id, and Ctrl+Z did not cost the neighbour a closed socket.
  assert.deepEqual(
    cells.toArray().map((c) => cellSource(c as never).toString()),
    ['one', 'two', 'three'],
  )
})

test('the first copy is the one that stays, when the original is gone', () => {
  // What two merged moves leave: the deletion is the same for both and is
  // applied once, while there are two inserts — and both are new.
  const { doc, cells } = room(['one', 'two'])
  // The clones are taken before the deletion: the keys of a deleted Y.Map
  // can no longer be read.
  const copies = [cloneOf(cells.get(1)), cloneOf(cells.get(1))]
  doc.transact(() => {
    cells.delete(1, 1)
    for (const copy of copies) cells.insert(0, [copy])
  })
  assert.equal(cells.length, 2)
  assert.deepEqual(ids(cells).length, new Set(ids(cells)).size)
  assert.equal(cellSource(cells.get(0) as never).toString(), 'two')
})

test('cells that merely look alike are left alone', () => {
  // Same source, same everything except the id: two people typing the same
  // line is not a duplicate.
  const { doc, cells } = room(['import torch'])
  doc.transact(() => cells.push([createCell('code', 'import torch')]))
  assert.equal(cells.length, 2, 'a legitimate second cell was eaten')
})

test('deleting cells never triggers the repair', () => {
  const { doc, cells } = room(['one', 'two', 'three'])
  doc.transact(() => cells.delete(1, 1))
  assert.deepEqual(
    cells.toArray().map((c) => cellSource(c as never).toString()),
    ['one', 'three'],
  )
})

test('a cell with no id at all does not take the others down with it', () => {
  const { doc, cells } = room(['one'])
  doc.transact(() => {
    const odd = new Y.Map<unknown>()
    odd.set('type', 'code')
    odd.set('source', new Y.Text())
    cells.push([odd])
  })
  assert.equal(cells.length, 2, 'the repair ate a cell it could not identify')
})
