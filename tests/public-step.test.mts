/**
 * A step that never existed is not the same as a page that is gone.
 *
 * The reader knows two bad outcomes of a publication and mixes them up. It
 * prints "This seminar page no longer exists — it was published again" on ANY
 * 404 for a step request: a student who missed the number in the address (or
 * followed a link to `-1`, which the client router still treats as a step
 * "from the end", although nothing can serve such a step) is told that their
 * page was republished — while the publication is alive and untouched.
 *
 * The server tells these two cases apart and always has: it has different
 * response bodies for the same code. This pins it as a contract — because the
 * reader can tell them apart only by the body, and once the body is gone there
 * will be nothing left to fix it with.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { newBlobBag, pageOfDoc } from '../server/src/publish/build.js'
import {
  readStep,
  setPublicationState,
  stepHeadings,
  writePublication,
} from '../server/src/publish/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'

const ROOM = 'pub-steps-room'
let pubId = ''
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Шаги', null)
  const { doc } = getSessionDoc(ROOM)
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'import pandas as pd'))
  const bag = newBlobBag()
  const at = Date.now()
  pubId = writePublication({
    sessionId: ROOM,
    title: 'Шаги',
    by: 'Ада',
    steps: [
      { seq: 0, label: 'начало', at, cells: pageOfDoc(doc, bag) },
      { seq: 4, label: 'решение', at, cells: pageOfDoc(doc, bag) },
    ],
    blobs: bag.all(),
  }).id

  const app = express()
  app.use(courseRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

async function step(seq: string): Promise<{ status: number; error: string }> {
  const res = await fetch(`${base}/api/p/${pubId}/step/${encodeURIComponent(seq)}`)
  const body = (await res.json()) as { error?: string }
  return { status: res.status, error: body.error ?? '' }
}

test('publication steps are read by their numbers, and "first" by the word', () => {
  assert.deepEqual(
    stepHeadings(pubId).map((h) => h.seq),
    [0, 4],
  )
  assert.equal(readStep(pubId, 0)?.label, 'начало')
  assert.equal(readStep(pubId, 4)?.label, 'решение')
  assert.equal(readStep(pubId, null)?.label, 'начало', 'the first step stopped being first')
})

test('a negative number is not a "step from the end" but a step that does not exist', () => {
  /*
   * `readStep` looks `seq` up literally, so −1 is just a number that is not
   * there. The opposite is promised in two places: the client's address regex
   * (`web/src/lib/routes.ts`, `PUBLIC_PATH` with `-?\\d+`) and a comment in
   * `shell.test.mts` — "a negative step is 'from the end', and it is a step
   * too". There is no implementation anywhere. As long as there is none, this
   * assertion is the truth about the product; once one appears, the failure
   * here will be exactly the place where it is decided what −1 becomes.
   */
  assert.equal(readStep(pubId, -1), null)
  assert.equal(readStep(pubId, 99), null)
})

test('a live page with a broken step says "no step", not "no page"', async () => {
  // Exactly the pair of answers by which the reader has to choose between "there
  // is no such step" and "the page was published again". They share one code —
  // 404 — and differ only in the body.
  const missing = await step('99')
  assert.equal(missing.status, 404)
  assert.equal(missing.error, 'step not found')

  const negative = await step('-1')
  assert.equal(negative.status, 404)
  assert.equal(negative.error, 'step not found', 'a negative step answers like a vanished page')

  // And the publication itself is alive meanwhile and serves its steps.
  const page = await fetch(`${base}/api/p/${pubId}`)
  assert.equal(page.status, 200)
  const seen = (await page.json()) as { seminar: { steps: { seq: number }[] } }
  assert.deepEqual(seen.seminar.steps.map((s) => s.seq), [0, 4])
})

test('a non-number does not pass itself off as a step', async () => {
  const nonsense = await step('первый')
  assert.equal(nonsense.status, 400, 'garbage in the address passed as a step number')
})

test('a withdrawn page is "no page" by now, and answers exactly so', async () => {
  setPublicationState(pubId, 'withdrawn')
  const withdrawn = await step('0')
  assert.equal(withdrawn.status, 404)
  assert.equal(
    withdrawn.error,
    'publication not found',
    'a withdrawn page answers like a live one with a bad number',
  )
  setPublicationState(pubId, 'published')
})
