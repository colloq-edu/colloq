/**
 * A question appears in the feed on pressing Enter, not after a round trip
 * to the server.
 *
 * What is checked is the substitution: the tab's row must disappear exactly
 * when its place has been taken by the real record, neither earlier nor
 * later. Earlier, and the person again looks at emptiness and presses Enter
 * a second time; later, and one question stands in the feed twice.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outgoingRow, settleOutbox, type Outgoing } from '../web/src/lib/ask-outbox.js'
import type { ChatSnapshot } from '../shared/notebook.js'

const ME = { id: 'p_ada', name: 'Ада', color: '#7e82f0' }

let seq = 0
function mine(question: string, before: ChatSnapshot[] = []): Outgoing {
  return {
    row: outgoingRow({ id: `outgoing:${++seq}`, me: ME, question, at: 1000 }),
    before: new Set(before.map((entry) => entry.id)),
  }
}

/** A record as the server puts it into the feed. */
function real(id: string, question: string, who = ME.id): ChatSnapshot {
  return { ...outgoingRow({ id, me: ME, question, at: 2000 }), id, participantId: who }
}

test('the tab row looks like the record it will become', () => {
  const row = outgoingRow({ id: 'outgoing:1', me: ME, question: 'почему nan?', at: 7 })
  // The spinner and "Stop" are the same as on a real, freshly created record:
  // the swap must not be noticeable as a jerk.
  assert.equal(row.state, 'streaming')
  assert.equal(row.answer, '')
  assert.equal(row.reasoning, '')
  assert.equal(row.thoughtMs, null)
  assert.deepEqual(row.steps, [])
  assert.equal(row.patch, null)
  assert.equal(row.undo, 'none')
  assert.equal(row.participantId, ME.id)
  assert.equal(row.createdAt, 7)
})

test('a "do" turn stays a "do" turn, and the cell is taken from the selection', () => {
  const row = outgoingRow({
    id: 'outgoing:1',
    me: ME,
    question: 'перепиши',
    mode: 'agent',
    cellIds: ['c7', 'c8'],
    at: 0,
  })
  assert.equal(row.mode, 'agent')
  // There is one binding, the one where the suggestion will land; both were asked about.
  assert.equal(row.cellId, 'c7')
  assert.deepEqual(row.cellIds, ['c7', 'c8'])
})

test('a record that arrived removes its row', () => {
  const pending = [mine('почему nan?')]
  assert.equal(settleOutbox(pending, []).length, 1, 'removed too early')
  assert.deepEqual(settleOutbox(pending, [real('q1', 'почему nan?')]), [])
})

test('a confirmed "fix" request is replaced by a record with the server text', () => {
  const pending = [{ ...mine(''), entryId: 'fix1' }]
  assert.equal(settleOutbox(pending, []), pending, 'HTTP before the document does not remove the row')
  assert.deepEqual(settleOutbox(pending, [real('fix1', 'Исправь эту ячейку')]), [])
})

test('a confirmation after the document removes the temporary row without the next frame', () => {
  const pending = [mine('')]
  const fresh = [real('fix1', 'Исправь эту ячейку')]
  assert.equal(settleOutbox(pending, fresh), pending)
  assert.deepEqual(settleOutbox([{ ...pending[0]!, entryId: 'fix1' }], fresh), [])
})

test('the confirmation id keeps another identical question from removing the row', () => {
  const pending = [{ ...mine('почему nan?'), entryId: 'q2' }]
  assert.equal(settleOutbox(pending, [real('q1', 'почему nan?')]), pending)
  assert.deepEqual(settleOutbox(pending, [real('q1', 'почему nan?'), real('q2', 'почему nan?')]), [])
})

test('a record of another person with the same text does not remove my row', () => {
  // The question "why nan?" is asked by three people at a seminar, and
  // removing the row by someone else's record would mean my question vanished
  // from the screen before it got through.
  const pending = [mine('почему nan?')]
  assert.equal(settleOutbox(pending, [real('q1', 'почему nan?', 'p_petya')]).length, 1)
})

test('my own old identical question does not remove the new row', () => {
  /*
   * That is exactly what Retry does: the same text, the same author, the
   * record is already in the feed. They are told apart only by the old
   * record having been there BEFORE sending.
   */
  const old = real('q1', 'почему nan?')
  const pending = [mine('почему nan?', [old])]
  assert.equal(settleOutbox(pending, [old]).length, 1, 'the row was removed by a question from ten minutes ago')
  assert.deepEqual(settleOutbox(pending, [old, real('q2', 'почему nan?')]), [])
})

test('two identical questions in a row are resolved in turn', () => {
  const first = mine('ещё раз?')
  const second = mine('ещё раз?')
  const landed = real('q1', 'ещё раз?')
  const left = settleOutbox([first, second], [landed])
  assert.equal(left.length, 1, 'one record removed both rows')
  assert.equal(left[0].row.id, second.row.id, 'the wrong one was removed: the first one arrived first')
  assert.deepEqual(settleOutbox(left, [landed, real('q2', 'ещё раз?')]), [])
})

test('an empty queue means no work', () => {
  assert.deepEqual(settleOutbox([], [real('q1', 'что угодно')]), [])
})

test('nothing to remove: the same array comes back, not a copy', () => {
  /*
   * Not nitpicking about allocation but the cause of a real breakage: the
   * caller compares by reference and writes state on a new array. One such
   * `filter` inside an effect that itself reads this state brought down the
   * whole room: `effect_update_depth_exceeded` instead of a notebook.
   */
  const pending = [mine('почему nan?')]
  assert.equal(settleOutbox(pending, []), pending)
  assert.equal(settleOutbox(pending, [real('q1', 'чужой вопрос', 'p_petya')]), pending)
  assert.equal(settleOutbox([], []).length, 0)
  // And when there is something to remove, the array is of course new.
  assert.notEqual(settleOutbox(pending, [real('q1', 'почему nan?')]), pending)
})
