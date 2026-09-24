/**
 * The council store: whose output under whose text, what the bar's numbers
 * cost, and what happens to the oracle of a deleted room.
 *
 * There are no sockets, no kernel, no model here — only
 * `server/src/council.ts` and what it must not mix up. Three things break
 * silently and expensively.
 *
 * First: the kernel queue is one per room, waiting a minute in a cohort of
 * five hundred people is normal, and editing the sheet during that time is
 * normal too. A frame of a run computed from the PREVIOUS text used to land
 * under the new one: the card showed the traceback of a program that is not
 * on it, and the teacher marked "correct" based on output of other text.
 *
 * Second: the bar's numbers travel to the host three times a second while
 * the class types, and they were computed through a full stack build — a
 * SELECT of the participant and normalization of the whole text for each of
 * five hundred attempts, for the sake of four numbers without a single name.
 *
 * Third: a deleted seminar. An oracle answer that arrived after the deletion
 * set up the room's cache anew and wrote a row into `council_oracle` for a
 * session that is no longer in the list.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, db, forgetRules } from '../server/src/db.js'
import {
  attemptsOf,
  boardFor,
  countsFor,
  discardCouncil,
  oracleOf,
  recordRun,
  saveDraft,
  setOracle,
  submitAttempt,
} from '../server/src/council.js'
import { idleOracle } from '../server/src/ai/council.js'
import { normalizeAttempt, DEFAULT_COUNCIL } from '@shared/notebook'
import type { CouncilRun } from '@shared/protocol'

const CELL = 'c_task'
const SHEET = { lock: 'council' as const, settings: DEFAULT_COUNCIL }

let seq = 0
function room(): string {
  const id = `council-runs-${++seq}`
  createSession(id, 'Консилиум', null)
  return id
}

const queued: CouncilRun = {
  state: 'queued',
  outputs: [],
  execCount: null,
  ranMs: null,
  startedAt: 1_000,
  by: 'author',
}

function finished(text: string): CouncilRun {
  return {
    state: 'ok',
    outputs: [{ kind: 'stream', name: 'stdout', text }],
    execCount: 1,
    ranMs: 12,
    startedAt: 1_000,
    by: 'author',
  }
}

const crashed: CouncilRun = {
  state: 'error',
  outputs: [
    { kind: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: [] },
  ],
  execCount: 1,
  ranMs: null,
  startedAt: 1_000,
  by: 'author',
}

/* ----------------------------------------------- output under its own text */

test('output of the old text does not land under the new one', () => {
  const id = room()
  saveDraft(id, CELL, 'p_petya', 'import time; time.sleep(20); 1/0', 1_000)
  assert.equal(recordRun(id, CELL, 'p_petya', queued), true, 'the run request was not accepted')
  assert.equal(attemptsOf(id, CELL)[0].run?.state, 'queued')

  // While the attempt waits in the queue, the author edits the sheet. The
  // edit itself drops the run — that is already checked in
  // council-server.test.mts.
  saveDraft(id, CELL, 'p_petya', 'x = 1', 2_000)
  assert.equal(attemptsOf(id, CELL)[0].run, null)

  // …and twenty seconds later the kernel finishes the OLD source.
  assert.equal(recordRun(id, CELL, 'p_petya', crashed), false, 'the late frame was accepted')
  const mine = attemptsOf(id, CELL)[0]
  assert.equal(mine.run, null, 'ZeroDivisionError landed under "x = 1"')

  submitAttempt(id, CELL, 'p_petya', 3_000)
  const card = boardFor(id, CELL, SHEET).attempts[0]
  assert.equal(card.status, 'unrun', 'unchecked text is marked "failed"')
})

test('frames of one\'s own run arrive, every single one', () => {
  const id = room()
  saveDraft(id, CELL, 'p_petya', 'print(1)', 1_000)
  recordRun(id, CELL, 'p_petya', queued)
  assert.equal(
    recordRun(id, CELL, 'p_petya', { ...queued, state: 'running' }),
    true,
    'a frame of a running run was thrown away',
  )
  assert.equal(recordRun(id, CELL, 'p_petya', finished('1\n')), true)
  assert.equal(attemptsOf(id, CELL)[0].run?.state, 'ok')

  // An echo of the same text drops nothing: the text did not change.
  saveDraft(id, CELL, 'p_petya', 'print(1)', 2_000)
  assert.equal(attemptsOf(id, CELL)[0].run?.state, 'ok')
})

test('after an edit a new run is counted afresh and arrives', () => {
  const id = room()
  saveDraft(id, CELL, 'p_petya', 'print(1)', 1_000)
  recordRun(id, CELL, 'p_petya', queued)
  saveDraft(id, CELL, 'p_petya', 'print(2)', 2_000)
  recordRun(id, CELL, 'p_petya', finished('1\n')) // a late one — thrown away

  recordRun(id, CELL, 'p_petya', queued)
  assert.equal(recordRun(id, CELL, 'p_petya', finished('2\n')), true)
  const run = attemptsOf(id, CELL)[0].run
  assert.equal(run?.state, 'ok')
  assert.deepEqual(run?.outputs, [{ kind: 'stream', name: 'stdout', text: '2\n' }])
})

test('taking a run off the queue wipes it and removes its fingerprint too', () => {
  const id = room()
  saveDraft(id, CELL, 'p_petya', 'print(1)', 1_000)
  recordRun(id, CELL, 'p_petya', queued)
  assert.equal(recordRun(id, CELL, 'p_petya', null), true)
  assert.equal(attemptsOf(id, CELL)[0].run, null)
  // A frame of a run that was taken off does not come back to life.
  assert.equal(recordRun(id, CELL, 'p_petya', finished('1\n')), false)
})

/* ----------------------------------------------------- numbers for the bar */

test('the bar numbers match the full stack — and are counted without names', () => {
  const id = room()
  for (let i = 0; i < 40; i++) {
    // Three different solutions, each in several spellings: groups are
    // counted by normalized text, not by letters.
    const text = ['x = 1', 'x=1  # ответ', 'x = 2', 'y = 3'][i % 4]
    saveDraft(id, CELL, `p_${i}`, text, 1_000 + i)
    if (i % 5 !== 0) submitAttempt(id, CELL, `p_${i}`, 2_000 + i)
  }
  const board = boardFor(id, CELL, SHEET)
  assert.deepEqual(countsFor(id, CELL), board.counts)
  assert.equal(board.counts.attempts, 40)
  assert.equal(board.counts.groups, board.groups.length)
  assert.equal(board.counts.writing, board.counts.attempts - board.counts.submitted)

  // "x = 1" and "x=1  # ответ" are one group: the key on the row is the same
  // one normalizeAttempt computes, and it is not recomputed for every frame.
  assert.equal(attemptsOf(id, CELL)[0].groupKey, normalizeAttempt('x = 1'))
  assert.equal(attemptsOf(id, CELL)[1].groupKey, normalizeAttempt('x=1'))
  assert.equal(board.counts.groups, 3)
})

test('an empty cell is four zeros, not a refusal', () => {
  const id = room()
  assert.deepEqual(countsFor(id, 'c_nobody'), {
    attempts: 0,
    submitted: 0,
    writing: 0,
    groups: 0,
  })
})

/* --------------------------------------------------------------- grouping */

test('the stack folds identical solutions with the shared function and without the oracle', () => {
  const id = room()
  // Submitted in the same millisecond: the tie is decided by the time of the
  // last edit. The oracle has no groups at all any more — it reads the class
  // by name — but the stack still lives by them, and its tie-break must be
  // the same as the console's.
  saveDraft(id, CELL, 'p_zzz', 'x = 1', 1_000)
  saveDraft(id, CELL, 'p_aaa', 'x = 1', 2_000)
  submitAttempt(id, CELL, 'p_zzz', 5_000)
  submitAttempt(id, CELL, 'p_aaa', 5_000)

  const board = boardFor(id, CELL, SHEET)
  assert.equal(board.groups.length, 1)
  assert.equal(board.groups[0].representative, 'p_zzz', 'wrote earlier — so it is the representative')
  assert.deepEqual(board.groups[0].members, ['p_zzz', 'p_aaa'])
  // Groups no longer get labels from the oracle: it does not hand them out.
  assert.equal(board.groups[0].label, null)
})

/* -------------------------------------------------------------- deleted room */

test('the summary does not resurrect a deleted seminar', () => {
  const id = room()
  saveDraft(id, CELL, 'p_petya', 'x = 1', 1_000)
  const said = (text: string) => ({
    id: text,
    question: 'Как класс?',
    text,
    askedAt: 1,
    basedOn: { submitted: 0, drafts: 1 },
    people: {},
  })
  setOracle(id, CELL, { ...idleOracle(), state: 'ready', answers: [said('было')] })
  assert.equal(oracleOf(id, CELL)?.answers[0].text, 'было')

  /*
   * Exactly the order in which a seminar is deleted: first the room closes
   * (control.ts · closeControlRoom → discardCouncil), then the row goes
   * (routes/admin-instance.ts). The model's answer arrives after both: its
   * reading is cut off by `stopRoomOracles`, but there is a tick between the
   * cut-off and the answer, and for that tick there is a second lock.
   */
  discardCouncil(id)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  // And the last line of the same route: the room row answers from memory
  // (db.ts · forgetRoom), and a deletion that forgot to say so would leave
  // the seminar alive for everyone asking "is it still there?".
  forgetRules(id)

  setOracle(id, CELL, { ...idleOracle(), state: 'ready', answers: [said('опоздал')] })
  assert.equal(oracleOf(id, CELL), null, 'the row of the deleted seminar came back to life')
  const rows = db
    .prepare('SELECT COUNT(*) AS n FROM council_oracle WHERE session_id = ?')
    .get(id) as { n: number }
  assert.equal(rows.n, 0, 'a row of the deleted room remained in council_oracle')
})
