/**
 * A whole publication is one pass over the history, and the rail did not go
 * astray because of it.
 *
 * The route built the steps one at a time (`buildPageAt`), and every such call
 * meant a new `Y.Doc` and a replay of the whole history from a keyframe: up to
 * forty full replays per publication, synchronously, in the process where a
 * colleague is teaching a class at that very minute. A forward pass with one
 * document (`publish/build.ts` · pagesAtAsync) removes the replays but pays
 * with state that lives between steps — and so it has to prove that nothing
 * has changed from the outside.
 *
 * The properties of the pass itself are checked in `publish-replay.test.mts`;
 * here is what the route does through it: a step in the publication is exactly
 * the one built from scratch, the teacher still chooses the order of the rail,
 * and a dropped moment is still named out loud rather than lost in silence.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { mark } from '../server/src/collab/history.js'
import { candidatesFor } from '../server/src/publish/candidates.js'
import { newBlobBag, pagesAt } from '../server/src/publish/build.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import type { PublicCell, SkippedStep, StepHeading } from '../shared/publish.js'

const ROOM = 'publish-pass'
let base = ''
let server: http.Server
let cookie = ''
let doc: Y.Doc

function cookieFor(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

before(async () => {
  const owner = createTeacher({ name: 'Ада', email: 'ada.pass@test.local', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  cookie = cookieFor(owner)

  /* Three named moments: an empty notebook, code, code with output. The steps
   * have to come out different — otherwise "matched" means nothing. */
  createSession(ROOM, 'Градиентный спуск', null)
  doc = getSessionDoc(ROOM, 'Градиентный спуск').doc
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  mark(ROOM, doc, 'checkpoint' as never, null, 'чистая тетрадь', 'moment marked')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'import numpy as np'))
  mark(ROOM, doc, 'checkpoint' as never, null, 'перед упражнением', 'moment marked')
  doc.transact(() => {
    const cell = cells.get(1)
    ;(cell.get('source') as Y.Text).insert(0, 'grad(x)')
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'text/plain': '0.014' }, execCount: 2 }))
    ;(cell.get('outputs') as Y.Array<unknown>).push([out])
    cell.set('execCount', 2)
  }, 'server')
  mark(ROOM, doc, 'checkpoint' as never, null, 'решение', 'moment marked')

  const app = express()
  app.use(express.json())
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  doc?.destroy()
  server?.close()
  shutdownCollab()
})

/** The room's moments in ascending order, which is what the panel offers. */
const moments = (): number[] =>
  candidatesFor(ROOM)
    .map((c) => c.seq)
    .sort((a, b) => a - b)

/** A step's page built from scratch: a pass one step long. */
const alone = (seq: number): PublicCell[] => {
  const page = pagesAt(ROOM, [seq], newBlobBag()).get(seq)
  assert.ok(page?.ok, `step ${seq} did not build on its own: nothing to compare`)
  return page.cells
}

interface Published {
  publication: { id: string; steps: StepHeading[] }
  skipped: SkippedStep[]
}

async function publish(steps: unknown[]): Promise<Published> {
  const res = await fetch(`${base}/api/admin/seminars/${ROOM}/publish`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ steps }),
  })
  assert.equal(res.status, 200)
  return (await res.json()) as Published
}

async function stepOf(pub: string, seq: number): Promise<PublicCell[]> {
  const res = await fetch(`${base}/api/p/${pub}/step/${seq}`)
  assert.equal(res.status, 200, `step ${seq} is missing from the published page`)
  const body = (await res.json()) as { step: { cells: PublicCell[] } }
  return body.step.cells
}

test('every step of a publication is the same as one built from scratch', async () => {
  const seqs = moments()
  assert.ok(seqs.length >= 3, 'the moments were not recorded: nothing to publish')

  // The teacher chooses the order of the rail: ask for it reversed.
  const asked = [...seqs].reverse().map((seq, i) => ({ seq, label: `шаг ${i + 1}` }))
  const answer = await publish(asked)
  assert.deepEqual(answer.skipped, [], 'a step dropped out where nothing should drop')

  // The rail is in the order given, with the last page at the end.
  assert.deepEqual(
    answer.publication.steps.map((s) => s.seq),
    [...asked.map((s) => s.seq), 0],
    'the ascending pass reordered the rail instead of the teacher',
  )
  assert.deepEqual(
    answer.publication.steps.map((s) => s.label),
    [...asked.map((s) => s.label), 'Тетрадь на момент публикации'],
  )

  for (const seq of seqs) {
    assert.deepEqual(
      await stepOf(answer.publication.id, seq),
      alone(seq),
      `step ${seq} in the shared pass diverged from the build from scratch`,
    )
  }

  // And this is not "empty equals empty": the moments really differ.
  const first = await stepOf(answer.publication.id, seqs[0])
  const last = await stepOf(answer.publication.id, seqs[seqs.length - 1])
  assert.notDeepEqual(first, last, 'all steps came out the same: the notebook was built wrong')
})

test('a dropped moment is still named out loud', async () => {
  const seqs = moments()
  const answer = await publish([
    { seq: seqs[0], label: 'первый' },
    // An unnamed step is not published: "Snapshot #14" on a student's rail is
    // not a name but an admission that someone forgot to name it.
    { seq: seqs[1], label: '' },
    // And the same address twice is about the request, not about the class.
    { seq: seqs[0], label: 'первый ещё раз' },
  ])
  assert.deepEqual(
    answer.publication.steps.map((s) => s.seq),
    [seqs[0], 0],
    'a step nobody asked for got into the rail',
  )
  assert.deepEqual(
    answer.skipped,
    [
      { seq: seqs[1], label: '', reason: 'unnamed' },
      { seq: seqs[0], label: 'первый ещё раз', reason: 'duplicate' },
    ],
    'the panel has nothing to name the dropped moments with',
  )
})

test('a step with nothing to build from names a reason instead of vanishing', async () => {
  /*
   * The reason comes from the pass itself (`BuiltPage.reason`), not from parsing
   * the request — and that is exactly what could have been lost in the move to a
   * single pass: a room without history has an empty notebook at any step.
   */
  const empty = 'publish-pass-empty'
  createSession(empty, 'Комната без истории', null)
  const res = await fetch(`${base}/api/admin/seminars/${empty}/publish`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ seq: 1, label: 'которого не было' }] }),
  })
  assert.equal(res.status, 200)
  const answer = (await res.json()) as Published
  assert.deepEqual(answer.skipped, [{ seq: 1, label: 'которого не было', reason: 'empty' }])
  assert.deepEqual(
    answer.publication.steps.map((s) => s.seq),
    [0],
    'an unbuilt step got into the rail after all',
  )
})
