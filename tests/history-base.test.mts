/**
 * A room's history must be possible to unfold back into a notebook.
 *
 * This broke silently and completely. The base row was taken from the
 * document BEFORE the starting cells were seeded, and the update observer was
 * attached even later — so the cells never got into the history at all. Every
 * following row was a delta against a document the history had never seen:
 * Yjs put such deltas into pending, and ANY version unfolded into an empty
 * notebook. The "History" tab showed zero cells and did not complain.
 *
 * On the live database a seminar with twenty-one rows gave zero cells for all
 * twenty-one. Hence two checks here: that a new room writes its cells in the
 * very first version, and that a room broken by an old build is repaired on
 * the next open.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { appendVersion, createSession, db } from '../server/src/db.js'
import { dropSessionDoc, getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { cellsAt } from '../server/src/collab/history.js'

after(() => shutdownCollab())

const latestSeq = (id: string): number =>
  (db.prepare('SELECT MAX(seq) AS s FROM doc_history WHERE session_id = ?').get(id) as { s: number })
    .s

test('the very first version of a new room unfolds into its notebook', () => {
  const id = 'hist-fresh'
  createSession(id, 'Свежий', null)
  getSessionDoc(id, 'Свежий')
  const cells = cellsAt(id, latestSeq(id))
  assert.ok(cells.length > 0, 'the history of a new room unfolds into an empty notebook')
})

test('a room with a broken base is repaired on the next open', () => {
  const id = 'hist-broken'
  createSession(id, 'Сломанный', null)

  /*
   * Exactly what the old build left behind: an `opened` row taken from an
   * empty document. It exists, `hasHistoryBase` is satisfied — and it unfolds
   * into nothing.
   */
  const empty = new Y.Doc()
  appendVersion({
    sessionId: id,
    update: Y.encodeStateAsUpdate(empty),
    kind: 'opened',
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: 'opened the seminar',
    added: 0,
    removed: 0,
    cells: [],
  })
  empty.destroy()
  assert.equal(cellsAt(id, latestSeq(id)).length, 0, 'faking the broken base did not work')

  // Opening the room is the only moment when this can be noticed and repaired.
  getSessionDoc(id, 'Сломанный')
  assert.ok(
    cellsAt(id, latestSeq(id)).length > 0,
    'the history still cannot be unfolded after the room was opened',
  )
})

test('the repair does not touch a healthy history', () => {
  // An extra row on every room open would be a history that grows from being
  // looked at.
  const id = 'hist-fine'
  createSession(id, 'Целый', null)
  getSessionDoc(id, 'Целый')
  const after = latestSeq(id)
  dropSessionDoc(id)
  getSessionDoc(id, 'Целый')
  assert.equal(latestSeq(id), after, 'opening a healthy room appended a version')
})
