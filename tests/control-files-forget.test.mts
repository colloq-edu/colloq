/**
 * Broadcasting the file list forgets both memos, even when there is nobody to
 * broadcast to.
 *
 * `broadcastFiles` is called precisely because the folder changed. While both
 * memos (the per-room frame here and the short walk memo in workspace.ts) were
 * reset AFTER the "the room has sockets" check, a room without a single
 * listener kept the previous answer: files get added before anyone has joined
 * — the teacher prepares the class the evening before — and the very same
 * request right after that answered `listTree` without the file just added.
 *
 * This is exactly what is checked here: an empty room is not "nothing changed".
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import { broadcastFiles, closeControlRoom } from '../server/src/control.js'
import { listTree, makeFile } from '../server/src/workspace.js'

test('a room without sockets is no reason to keep the old tree', () => {
  const id = 'forget-empty'
  createSession(id, 'Пустая', null)
  makeFile(id, 'model.py', 'x = 1')

  const first = listTree(id)
  assert.deepEqual(
    first.files.map((entry) => entry.path),
    ['model.py'],
  )

  // Not a single `handleControlSocket`: there is nobody to broadcast to.
  broadcastFiles(id)

  /*
   * The same list, but as a DIFFERENT array: the walk memo was reset and the
   * tree computed anew. Equal paths would prove nothing here — they would match
   * from the memo as well; what proves it is precisely the lost identity (see
   * tests/workspace-memo.test.mts, "while the folder has not changed, a second
   * question in a row does not cost a second walk").
   */
  const second = listTree(id)
  assert.notEqual(second.files, first.files, 'the walk memo survived a broadcast to an empty room')
  assert.deepEqual(
    second.files.map((entry) => entry.path),
    ['model.py'],
  )
  closeControlRoom(id)
})
