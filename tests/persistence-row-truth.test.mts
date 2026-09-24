/**
 * The last barrier before a resurrected seminar asks the row, not memory.
 *
 * The room row now answers from a cache (db.ts · roomCache) — that is how the
 * handshake of five hundred tabs stopped costing a thousand SELECTs. But
 * `write` in collab/persistence.ts asks the same thing for another reason:
 * "does this seminar still exist" is the only thing that stops a tab forgotten
 * on a deleted room from putting its notebook back on disk. A snapshot without
 * a seminar row is a file no door leads to: it cannot be opened or deleted
 * from the panel.
 *
 * If this check went through the cache, it would rest on EVERY deletion path
 * remembering to invalidate. Today there is one such path
 * (routes/admin-instance.ts), and it remembers; tomorrow a second one will
 * appear. Exactly that case is reproduced here — the row is gone, the memory
 * of it is intact — and the snapshot still must not get out.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCell, getCells } from '../shared/notebook.js'
import { createSession, db, getSession, loadDocSnapshot } from '../server/src/db.js'
import { dropSessionDoc, getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

test('a deleted room writes no snapshot even if the cache has not forgotten it', () => {
  const id = 'persist-row-truth'
  createSession(id, 'Забытая инвалидация')

  const { doc } = getSessionDoc(id)
  getCells(doc).push([createCell('code', 'x = 1')])
  shutdownCollab()
  assert.ok(loadDocSnapshot(id), 'nothing was written: the test proves nothing')

  // The cache is warmed before the deletion: that is the starting state of a live room.
  assert.ok(getSession(id), 'the row is gone even before the deletion: the test is set up wrong')

  // A deletion path that forgot to tell db.ts about the cache: the row is no
  // longer on disk, but `getSession` does not know it.
  dropSessionDoc(id)
  db.prepare('DELETE FROM doc_snapshots WHERE session_id = ?').run(id)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  assert.ok(
    getSession(id),
    'the cache is already forgotten: the test does not reproduce a forgotten invalidation, and the check below is worth nothing',
  )

  // A tab left open comes back and keeps typing.
  const { doc: ghost } = getSessionDoc(id)
  getCells(ghost).push([createCell('code', 'still here?')])
  shutdownCollab()

  assert.equal(loadDocSnapshot(id), null, 'a snapshot of the deleted seminar went to disk')
})

test('for a live room the honest SELECT forbids nothing', () => {
  /*
   * The flip side of the same check: it stands in the way of EVERY snapshot, and
   * a mistake in it would cost not one resurrected seminar but all of them at
   * once — the server would silently stop saving live rooms.
   */
  const id = 'persist-row-alive'
  createSession(id, 'Живая комната')

  const { doc } = getSessionDoc(id)
  getCells(doc).push([createCell('code', 'answer = 42')])
  shutdownCollab()

  assert.ok(loadDocSnapshot(id), 'the live room stopped being saved')
})
