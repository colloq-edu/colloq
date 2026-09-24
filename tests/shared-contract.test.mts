/**
 * The shared contract: the promise matches the deed.
 *
 * Everything below breaks silently and for the whole room at once: the
 * "Lecture in progress" bar that disappeared because of a switch that did not
 * change any rights; a line in the kernel log telling five hundred people that
 * their work was cancelled; the address of a published page built from the
 * wrong field; a path that has two spellings.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  COUNCIL_ROOM,
  isCouncilRoom,
  isLectureRoom,
  LECTURE_ROOM,
  OPEN_ROOM,
  readRules,
  rulesAfterClass,
} from '../shared/rules.js'
import { LIMITS } from '../shared/admin.js'
import { normalizePath } from '../shared/paths.js'
import { publicationAddress } from '../shared/publish.js'
import {
  clearStaleExecution,
  clearStaleWork,
  createCell,
  createChatEntry,
  ensureInitialNotebook,
  getCells,
  getChat,
  getMeta,
} from '../shared/notebook.js'

/* ----------------------------------------------------------------- lecture */

test('a lecture stays a lecture under switches that did not change rights', () => {
  /*
   * The "Lecture in progress" bar above the notebook is the only explanation
   * of a greyed-out notebook for five hundred people. It went out because of a
   * quiz with the Oracle turned off, a closed history and its own cap on
   * questions: `isLectureRoom` compared ALL the fields of the preset, while a
   * lecture is about who types and runs.
   */
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, oracle: 'off' }), true, 'quiz')
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, history: 'host' }), true, 'closed history')
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, questionsPerHour: 5 }), true, 'own cap')
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, slowModeSeconds: 30 }), true, 'own interval')
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, model: 'gpt-4o-mini' }), true, 'own model')
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, opens: 'council' }), true, 'council')
  // An agent turned off is stricter than the lecture one, not softer: it does
  // not take the room out of the lectures.
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, agent: 'off' }), true, 'agent off')
  // And all of it together — what a real quiz looks like.
  assert.equal(
    isLectureRoom({
      ...LECTURE_ROOM,
      oracle: 'off',
      history: 'host',
      agent: 'off',
      questionsPerHour: 5,
    }),
    true,
  )
})

test('a released right is no longer a lecture', () => {
  for (const key of ['run', 'edit', 'structure', 'board', 'files', 'wipe', 'restart'] as const) {
    assert.equal(
      isLectureRoom({ ...LECTURE_ROOM, [key]: 'room' }),
      false,
      `rule ${key} was released, yet the room is still a lecture`,
    )
  }
  // An agent given to the room is the same: it is a right, not a property.
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, agent: 'room' }), false)
  assert.equal(isLectureRoom(OPEN_ROOM), false)
  assert.equal(isCouncilRoom({ ...COUNCIL_ROOM, oracle: 'off' }), true)
})

test('a finished class reads as a lecture — whatever rules it was finished from', () => {
  /*
   * This is worth knowing by sight: the rights after the bell are a fixed
   * point, so ANY finished room answers "yes" here. You cannot use this to ask
   * "is the class running lecture-style"; the end of class has its own sign.
   */
  assert.equal(isLectureRoom(rulesAfterClass(OPEN_ROOM)), true)
  assert.equal(isLectureRoom(rulesAfterClass({ ...OPEN_ROOM, agent: 'off' })), true)
  assert.equal(isLectureRoom(rulesAfterClass(COUNCIL_ROOM)), true)
})

test('the room model name is measured against the same cap as the instance model', () => {
  // Its own number cut the name to 80 characters versus 120 on the instance —
  // so a room that gets this switched on one day would ask for a stub.
  const long = 'm'.repeat(LIMITS.model + 10)
  assert.equal(readRules({ model: long }).model?.length, LIMITS.model)
  assert.equal(readRules({ model: 'a'.repeat(100) }).model?.length, 100)
})

/* ------------------------------------------------------------------ paths */

test('normalizePath collapses separators and does not touch a single name', () => {
  // The canonical spelling is about how the path is written, not about where
  // the file ends up.
  assert.equal(normalizePath('a//b'), 'a/b')
  assert.equal(normalizePath('data/'), 'data')
  assert.equal(normalizePath('a//b/'), 'a/b')
  // And a name is never repaired: if it does not fit, the whole path is
  // rejected.
  assert.equal(normalizePath('data/.env'), null)
  assert.equal(normalizePath('data/train .csv '), null)
  assert.equal(normalizePath('../etc/passwd'), null)
  assert.equal(normalizePath('/data/train.csv'), null)
  // The root is the empty string, and that is not a refusal.
  assert.equal(normalizePath(''), '')
})

/* --------------------------------------------------------------- publishing */

test('the page address is the name, if there is one', () => {
  assert.equal(publicationAddress({ id: 'x9tb4kwm', slug: 'ml-2026-w4' }), 'ml-2026-w4')
  assert.equal(publicationAddress({ id: 'x9tb4kwm', slug: null }), 'x9tb4kwm')
  // A server that does not send the field yet leaves a fallback entrance —
  // this is a fact, not a guess: `/p/<id>` opens.
  assert.equal(publicationAddress({ id: 'x9tb4kwm' }), 'x9tb4kwm')
})

/* ----------------------------------------------------------- server restart */

/** A room caught in the middle of an Oracle answer and without a single run. */
function midAnswer(): Y.Doc {
  const doc = new Y.Doc()
  ensureInitialNotebook(doc, 'Week 4')
  getChat(doc).push([
    createChatEntry({ participantId: 'p1', name: 'Мария', color: '#c273e6', question: 'почему?' }),
  ])
  return doc
}

test('an interrupted Oracle turn does not count as reset cells', () => {
  /*
   * `cells` goes into the kernel log line "Cells that were running or queued
   * were put back to rest". Under a single counter the Oracle's turn got there
   * too: not a single cell was running in the room, yet the class read that
   * its work had been cancelled.
   */
  const doc = midAnswer()
  const work = clearStaleWork(doc)
  assert.equal(work.cells, 0, 'cells that did not exist were counted as reset')
  assert.equal(work.turns, 1)
  // The turn itself is settled and has said so in words — right in the
  // thread.
  assert.equal(getChat(doc).get(0).get('state'), 'error')
})

test('cells and turns are counted separately, and the old name counts cells', () => {
  const doc = midAnswer()
  const cells = getCells(doc)
  doc.transact(() => {
    cells.push([createCell('code', 'train()')])
    cells.get(1).set('state', 'running')
    getMeta(doc).set('runningCell', cells.get(1).get('id'))
    cells.get(cells.length - 1).set('state', 'queued')
  })
  const work = clearStaleWork(doc)
  assert.equal(work.cells, 2, 'the running one and the queued one')
  assert.equal(work.turns, 1, 'the Oracle turn')

  // And the old name answers with the same number of cells — it is what
  // decides whether to explain it to the room with the line about cells.
  const again = midAnswer()
  const more = getCells(again)
  again.transact(() => more.get(1).set('state', 'running'))
  assert.equal(clearStaleExecution(again), 1)
})
