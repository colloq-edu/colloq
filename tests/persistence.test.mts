/**
 * A seminar has to survive the server being restarted, and a seminar that was
 * deleted has to stay deleted.
 *
 * Both are easy to break silently: a snapshot that never lands loses an hour of
 * a class, and a snapshot written *after* a deletion resurrects a room the
 * teacher destroyed on purpose. The timers behind this were changed to stop
 * holding the process open, which is exactly the kind of change that turns the
 * first one off without anybody noticing.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { cellSource, createCell, getCells, readNotebook } from '../shared/notebook.js'
import { createSession, db, forgetRules, loadDocSnapshot } from '../server/src/db.js'
import { flushPersistence } from '../server/src/collab/persistence.js'
import { dropSessionDoc, getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

let seq = 0
function room(): string {
  const id = `persist${seq++}`
  createSession(id, `Persisted ${id}`)
  return id
}

test('what the room typed is on disk after a clean shutdown', () => {
  const id = room()
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  cells.delete(0, cells.length)
  const cell = createCell('code', '')
  cells.push([cell])
  cellSource(cell).insert(0, 'the whole seminar depends on this line')

  // The write is deferred by design — nothing is on disk yet.
  shutdownCollab()

  const bytes = loadDocSnapshot(id)
  assert.ok(bytes, 'no snapshot was written for a room that was edited')

  // And it has to reload into the same notebook, not merely be non-empty.
  const restored = new Y.Doc()
  Y.applyUpdate(restored, bytes)
  const cellsAfter = readNotebook(restored)
  assert.equal(cellsAfter.length, 1)
  assert.equal(cellsAfter[0].source, 'the whole seminar depends on this line')
})

test('a reopened seminar comes back with its notebook', () => {
  const id = room()
  {
    const { doc } = getSessionDoc(id)
    const cells = getCells(doc)
    cells.delete(0, cells.length)
    const cell = createCell('markdown', '')
    cells.push([cell])
    cellSource(cell).insert(0, '# Week 3')
    shutdownCollab()
  }
  // shutdownCollab evicts everything, so this is the cold path a restart takes.
  const { doc } = getSessionDoc(id)
  const cells = readNotebook(doc)
  assert.equal(cells.length, 1)
  assert.equal(cells[0].source, '# Week 3')
  assert.equal(cells[0].type, 'markdown')
})

test('a browser standing in a deleted room cannot write it back', () => {
  const id = room()
  const { doc } = getSessionDoc(id)
  getCells(doc).push([createCell('code', 'x = 1')])
  shutdownCollab()
  assert.ok(loadDocSnapshot(id), 'nothing was saved — the test proves nothing')

  // Exactly what the delete route does, in its order: evict the live document
  // without flushing it, then drop the rows.
  dropSessionDoc(id)
  db.prepare('DELETE FROM doc_snapshots WHERE session_id = ?').run(id)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  // ...and the last line of the route: the room row is answered from memory on
  // every handshake, so a deletion that forgot to say so would leave the door
  // open until the next restart.
  forgetRules(id)

  // A tab left open reconnects a moment later and starts editing again. It must
  // not be able to recreate the room: the snapshot row is the thing that would
  // make the deletion undo itself on the next restart.
  const { doc: ghost } = getSessionDoc(id)
  getCells(ghost).push([createCell('code', 'still here?')])
  shutdownCollab()

  assert.equal(loadDocSnapshot(id), null, 'a deleted seminar wrote itself back to disk')
})

test('снимок, который не записался, не считается записанным', () => {
  /*
   * `dirtySince` обнулялся до попытки записи, и ошибка sqlite (полный диск,
   * ошибка ввода-вывода, занятая база) молча делала комнату «сохранённой»: ни
   * таймер, ни flush на выходе к ней больше не возвращались. Класс, в котором
   * после сбоя никто не напечатал ни символа, доезжал до `make down` без
   * последних правок.
   */
  const id = room()
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  cells.delete(0, cells.length)
  const cell = createCell('code', '')
  cells.push([cell])
  cellSource(cell).insert(0, 'последняя строка перед сбоем')

  db.pragma('query_only = ON')
  flushPersistence(id)
  db.pragma('query_only = OFF')

  // Больше никто не печатает: сохранить это может только повтор.
  flushPersistence(id)

  const bytes = loadDocSnapshot(id)
  assert.ok(bytes, 'снимка нет вовсе')
  const restored = new Y.Doc()
  Y.applyUpdate(restored, bytes)
  assert.deepEqual(
    readNotebook(restored).map((c) => c.source),
    ['последняя строка перед сбоем'],
    'правки после неудачной записи не попали на диск',
  )
})
