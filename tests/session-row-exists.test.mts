/**
 * "Does the room's row still exist?" — a question answered by the database,
 * not by memory.
 *
 * The seminar row is now answered from a cache (`db.ts` · roomCache): a hall
 * of five hundred people makes a thousand handshakes a second, and each one
 * asked the same thing. But the same question has a second, rare reader — the
 * document snapshot flush (`collab/persistence.ts`): it does not write the
 * room's notebook to disk if the room is gone, and that is the last line of
 * defence against a seminar resurrected a few seconds after deletion. If the
 * cache answered it, the protection would rest not on the database but on
 * every deletion path remembering to call `forgetRoom`.
 *
 * So db.ts has two doors for one question, and here it is pinned down how
 * they differ: `getSession` is fast and remembers, `sessionRowExists` is slow
 * (one SELECT by primary key every few seconds per room) and remembers
 * nothing.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, db, forgetRoom, getSession, sessionRowExists } from '../server/src/db.js'

/**
 * A write that bypasses this module — the very forgotten invalidation, only
 * arranged on purpose: the product's deletion path calls `forgetRules` and
 * through it `forgetRoom`, and this test checks what happens when someone one
 * day does not.
 */
const deleteBehindTheBack = db.prepare('DELETE FROM sessions WHERE id = ?')

test('answers "no" about a room that never existed', () => {
  assert.equal(sessionRowExists('никогда-не-заводили'), false)
})

test('the row was deleted behind the cache: memory still remembers the room, the database does not', () => {
  const id = 'row-exists-room'
  createSession(id, 'Комната', null)
  assert.equal(sessionRowExists(id), true)
  // The same question through the cache — so that this room is sure to be in
  // it.
  assert.equal(getSession(id)?.name, 'Комната')

  deleteBehindTheBack.run(id)

  assert.equal(sessionRowExists(id), false, 'the answer came from memory, not from the database')
  assert.ok(
    getSession(id),
    'the cache suddenly learned about the deletion by itself — then this test checks the wrong thing',
  )

  // And the product's deletion path agrees with the database: it forgets the
  // room entirely.
  forgetRoom(id)
  assert.equal(getSession(id), null)
  assert.equal(sessionRowExists(id), false)
})
