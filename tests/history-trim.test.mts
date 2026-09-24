/**
 * The history ceiling: it no longer grows without bound — and replay is
 * still intact.
 *
 * `doc_history` grew until the seminar was deleted: the only DELETE in all of
 * db.ts was in `discardHistory`. In a lively class a burst closes several
 * times a second, and a full snapshot comes every time the deltas catch up
 * with the notebook's size — a semester-long room wrote hundreds of megabytes
 * into a database that sits on the same disk as the files of all other rooms.
 *
 * Not just anything can be cut, though. Replaying a version starts from the
 * nearest snapshot NO LATER than it and applies all rows in between
 * (`updatesUpTo`), so a dropped row breaks restoring not itself but everyone
 * behind it up to the next snapshot. Hence the rule: the boundary is exactly
 * at a keyframe, and everything older than it goes as a whole. That is what
 * is checked here — together with a room below the ceiling not losing a
 * single row.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendVersion,
  createSession,
  db,
  historyTrimmed,
  trimHistory,
  updatesUpTo,
} from '../server/src/db.js'

/** A history row with a body of the given size; returns its seq. */
function row(sessionId: string, kind: string, bytes: number): number {
  return appendVersion({
    sessionId,
    update: new Uint8Array(bytes),
    kind,
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: kind,
    added: 0,
    removed: 0,
    cells: [],
  })
}

const seqs = (sessionId: string): number[] =>
  (
    db.prepare('SELECT seq FROM doc_history WHERE session_id = ? ORDER BY seq').all(sessionId) as {
      seq: number
    }[]
  ).map((r) => r.seq)

test('a history under the ceiling does not lose a single row', () => {
  const id = 'trim-under'
  createSession(id, 'Под потолком', null)
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)

  row(id, 'opened', 64)
  row(id, 'edit', 64)
  row(id, 'keyframe', 64)
  row(id, 'edit', 64)
  const before = seqs(id)

  // The ceiling is a megabyte, the room holds a quarter of a kilobyte: there
  // is nothing to cut.
  assert.equal(trimHistory(id, 1024 * 1024), 0)
  assert.deepEqual(seqs(id), before)
})

test('the ceiling cuts in whole segments — up to a snapshot, not up to a row', () => {
  const id = 'trim-over'
  createSession(id, 'За потолком', null)
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)

  row(id, 'opened', 1000)
  const oldQuiet = row(id, 'quiet', 1000)
  const oldEdit = row(id, 'edit', 1000)
  const secondBase = row(id, 'keyframe', 1000)
  const kept = row(id, 'quiet', 1000)
  const last = row(id, 'edit', 1000)

  // A ceiling of 3500 bytes: the last segment (snapshot + two rows, 3000)
  // fits, the one before it (another 3000) no longer does.
  const dropped = trimHistory(id, 3500)
  assert.equal(dropped, 3, 'exactly the rows older than the snapshot went away')
  assert.deepEqual(seqs(id), [secondBase, kept, last])
  assert.ok(oldQuiet < secondBase && oldEdit < secondBase)

  /*
   * And the main thing: what remains still unfolds. Replaying the last version
   * starts from the snapshot and takes everything in between — not a single
   * hole.
   */
  assert.equal(updatesUpTo(id, last).length, 3)
  assert.equal(updatesUpTo(id, kept).length, 2)
})

test('the only snapshot is not cut, even if it alone exceeds the ceiling', () => {
  const id = 'trim-one'
  createSession(id, 'Один снимок', null)
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)

  const opened = row(id, 'opened', 10)
  const base = row(id, 'keyframe', 9000)
  const tail = row(id, 'edit', 10)

  // Nothing can fit, but there must be something to replay the room from.
  assert.equal(trimHistory(id, 100), 1)
  assert.deepEqual(seqs(id), [base, tail])
  assert.ok(opened < base)
  assert.equal(updatesUpTo(id, tail).length, 2)
})

test('without a single snapshot nothing is cut: there would be nothing to replay from', () => {
  const id = 'trim-none'
  createSession(id, 'Без снимка', null)
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)

  row(id, 'opened', 5000)
  row(id, 'edit', 5000)
  const before = seqs(id)

  assert.equal(trimHistory(id, 100), 0)
  assert.deepEqual(seqs(id), before)
})

/**
 * Trimming cannot be silent: the history panel shows the remainder the same
 * way it would show a whole feed, and from it one cannot tell "nothing was
 * written here" from "nothing before this point survived". The flag is state,
 * not memory of an event: the room's oldest row is either `opened`, or the
 * beginning was cut off.
 */
test('a trimmed history says itself that it starts later than the room', () => {
  const id = 'trim-says'
  createSession(id, 'Про начало', null)
  db.prepare('DELETE FROM doc_history WHERE session_id = ?').run(id)

  // Empty is not trimmed: for a room where nothing has been written yet, the
  // panel has words of its own.
  assert.equal(historyTrimmed(id), false)

  row(id, 'opened', 1000)
  row(id, 'edit', 1000)
  assert.equal(historyTrimmed(id), false, 'the feed starts with the opening — it is whole')

  row(id, 'keyframe', 1000)
  row(id, 'edit', 1000)
  assert.ok(trimHistory(id, 2500) > 0, 'the probe must hit the ceiling')
  assert.equal(historyTrimmed(id), true, 'the beginning is gone — this must be said in words')
})
