/**
 * A publication walks the history with one document — and builds the same
 * thing.
 *
 * Forty publication steps used to unfold into forty new `Y.Doc`s, each from the
 * nearest keyframe: a notebook with images means megabytes per step, and all of
 * it synchronous, in the process where a colleague is teaching a class at that
 * very minute. A forward pass with one document (`publish/replay.ts`) removes
 * the repetition, but pays for it with state that lives between steps — and so
 * it has to prove that the page at every step is exactly the one a build from
 * scratch gives.
 *
 * Here are three properties of that pass: sameness with a full build,
 * resilience to order and repeats in the request, and that going back it does
 * not pass the future off as the past.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { mark } from '../server/src/collab/history.js'
import { candidatesFor } from '../server/src/publish/candidates.js'
import { newBlobBag, pagesAt, pagesAtAsync, type BuiltPage } from '../server/src/publish/build.js'
import { openReplay } from '../server/src/publish/replay.js'
import { readNotebook } from '../shared/notebook.js'

after(() => shutdownCollab())

/** A room with three named moments: a clean notebook, code, code with output. */
function taught(id: string): Y.Doc {
  createSession(id, 'Градиентный спуск', null)
  const { doc } = getSessionDoc(id, 'Градиентный спуск')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  mark(id, doc, 'checkpoint' as never, null, 'чистая тетрадь', 'moment marked')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'import numpy as np'))
  mark(id, doc, 'checkpoint' as never, null, 'перед упражнением', 'moment marked')
  doc.transact(() => {
    const cell = cells.get(1)
    ;(cell.get('source') as Y.Text).insert(0, 'grad(x)')
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'text/plain': '0.014' }, execCount: 2 }))
    ;(cell.get('outputs') as Y.Array<unknown>).push([out])
    cell.set('execCount', 2)
  }, 'server')
  mark(id, doc, 'checkpoint' as never, null, 'решение', 'moment marked')
  return doc
}

/** All the room's moments in ascending order: what the publish panel asks for. */
const moments = (id: string): number[] =>
  candidatesFor(id)
    .map((c) => c.seq)
    .sort((a, b) => a - b)

/** A step's page built from scratch: a pass one step long is exactly that. */
const alone = (id: string, seq: number): BuiltPage =>
  pagesAt(id, [seq], newBlobBag()).get(seq) ?? { ok: false, reason: 'broken' }

test('steps built in one pass are the same as steps built one at a time', () => {
  const id = 'replay-same'
  const doc = taught(id)
  const seqs = moments(id)
  assert.ok(seqs.length >= 3, 'the moments were not recorded')

  const together = pagesAt(id, seqs, newBlobBag())
  assert.deepEqual([...together.keys()], seqs, 'the pass returned other steps than those asked for')
  for (const seq of seqs) {
    assert.deepEqual(
      together.get(seq),
      alone(id, seq),
      `step ${seq} in the shared pass diverged from the build from scratch`,
    )
  }

  // And this is not the tautology "empty equals empty": the moments really differ.
  const pages = seqs.map((seq) => together.get(seq)!)
  assert.notDeepEqual(
    pages[0],
    pages[pages.length - 1],
    'all steps came out the same: the test notebook was built wrong',
  )
  const outputs = pages.map((p) => (p.ok ? p.cells.flatMap((c) => c.outputs).length : -1))
  assert.ok(outputs.includes(0) && outputs.some((n) => n > 0), 'the output is visible at every step at once')
  doc.destroy()
})

test('order and repeats in the request change nothing', async () => {
  const id = 'replay-order'
  const doc = taught(id)
  const seqs = moments(id)

  const straight = pagesAt(id, seqs, newBlobBag())
  // The panel sends the moments in the order the teacher named them, and one
  // moment may come twice: the order of the rail is the teacher's business, not arithmetic's.
  const shuffled = pagesAt(id, [...seqs].reverse().concat(seqs[0]), newBlobBag())
  assert.deepEqual([...shuffled.keys()], seqs, 'the pass did not sort the steps in ascending order')
  assert.deepEqual(shuffled, straight)

  // Yielding to the event loop between steps does not affect the result — it
  // exists precisely so as to affect nothing but the class next door.
  assert.deepEqual(await pagesAtAsync(id, seqs, newBlobBag()), straight)
  doc.destroy()
})

test('the pass does not pass the future off as the past', () => {
  /*
   * The document moves forward and does not rewind — a CRDT cannot do that. A
   * request for a row below one already passed has to build a new document,
   * otherwise the "before the exercise" step would show the solution: the page
   * would be not empty but wrong, and a student would have no way to notice.
   */
  const id = 'replay-back'
  const doc = taught(id)
  const seqs = moments(id)
  const first = seqs[0]
  const last = seqs[seqs.length - 1]

  const replay = openReplay(id)
  const solo = openReplay(id)
  try {
    const ahead = readNotebook(replay.at(last))
    const back = readNotebook(replay.at(first))
    assert.deepEqual(
      back,
      readNotebook(solo.at(first)),
      'a step back built something other than the build from scratch',
    )
    assert.notDeepEqual(back, ahead, 'an early moment showed the notebook of a later one')
  } finally {
    replay.close()
    solo.close()
  }
  doc.destroy()
})
