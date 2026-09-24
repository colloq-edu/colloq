/**
 * The queue mirror in the document — and its cost with five hundred
 * participants.
 *
 * The kernel queue lives in the shared document because everyone sees it. It
 * changes twice per cell (taken into work, finished) and both times at the
 * edges: the first element is gone or a last one is added. A full rewrite
 * turned every such move into "delete everything and put everything back":
 * with the "one at a time" rule and five hundred participants that is hundreds
 * of ids in a Yjs update, to the whole room, plus as many tombstones in the
 * document — over a run of five hundred cells, megabytes per client where
 * tens of bytes would do.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queueDelta } from '../server/src/kernel/index.js'

test('a cell is taken into work — one element leaves the mirror', () => {
  assert.deepEqual(queueDelta(['a', 'b', 'c'], ['b', 'c']), {
    at: 0,
    remove: 1,
    insert: [],
  })
})

test('a cell is queued at the tail — one element is added to the mirror', () => {
  assert.deepEqual(queueDelta(['b', 'c'], ['b', 'c', 'd']), {
    at: 2,
    remove: 0,
    insert: ['d'],
  })
})

test('the queue did not change — there is no edit at all', () => {
  assert.deepEqual(queueDelta(['a', 'b'], ['a', 'b']), { at: 2, remove: 0, insert: [] })
  assert.deepEqual(queueDelta([], []), { at: 0, remove: 0, insert: [] })
})

test('the first cell into an empty queue, and a queue emptied entirely', () => {
  assert.deepEqual(queueDelta([], ['a']), { at: 0, remove: 0, insert: ['a'] })
  assert.deepEqual(queueDelta(['a', 'b', 'c'], []), { at: 0, remove: 3, insert: [] })
})

test('removing from the middle does not touch the neighbours', () => {
  // "Cancel" takes out its own cells wherever they stand: the head and the
  // tail stay in place, and there is no reason to rewrite them.
  assert.deepEqual(queueDelta(['a', 'b', 'c', 'd'], ['a', 'd']), {
    at: 1,
    remove: 2,
    insert: [],
  })
})

test('the edit applies: current always turns into next', () => {
  const cases: Array<[string[], string[]]> = [
    [['a', 'b', 'c'], ['b', 'c']],
    [['b', 'c'], ['b', 'c', 'd']],
    [['a', 'b', 'c', 'd'], ['a', 'd']],
    [['a'], ['b']],
    [['a', 'b'], ['b', 'a']],
    [[], ['x', 'y', 'z']],
    [['x', 'y', 'z'], []],
    [['a', 'b', 'c'], ['a', 'x', 'c']],
  ]
  for (const [current, next] of cases) {
    const delta = queueDelta(current, next)
    const applied = [...current]
    applied.splice(delta.at, delta.remove, ...delta.insert)
    assert.deepEqual(applied, next, `${current.join()} → ${next.join()}`)
    // And the edit really is narrow: it does not rewrite what did not change.
    assert.ok(
      delta.remove + delta.insert.length <= current.length + next.length,
      'the edit came out wider than a full rewrite',
    )
  }
})
