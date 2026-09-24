/**
 * The public half under load: what it serves twice and what it does not
 * recompute.
 *
 * A walkthrough page is opened by five hundred people within one minute, from
 * phones, and every one of them flips through the steps. Before this, every
 * such visit went all the way to the database: the rail of steps was computed
 * by parsing the FULL text of every page (all the text outputs of a step — a
 * training log of megabytes) for the sake of forty small numbers, and the
 * responses carried neither a version tag nor a lifetime, so the second visit
 * cost exactly as much as the first.
 *
 * The danger of the fix is the opposite: a cache that survives a republish
 * shows the class last week. So both are checked here: that what has not
 * changed answers 304, and that what was republished answers with the new.
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
import { stepHeadings, writePublication } from '../server/src/publish/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import type { PublicCell } from '../shared/publish.js'

const ROOM = 'public-cache-room'
let pubId = ''
let base = ''
let server: http.Server
let page: PublicCell[] = []

before(async () => {
  createSession(ROOM, 'Разбор', null)
  const { doc } = getSessionDoc(ROOM)
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'import numpy as np'))
  const bag = newBlobBag()
  page = pageOfDoc(doc, bag)
  const at = Date.now()
  pubId = writePublication({
    sessionId: ROOM,
    title: 'Разбор',
    by: 'Ада',
    steps: [
      { seq: 3, label: 'первая попытка', at, cells: page },
      { seq: 0, label: 'тетрадь на момент публикации', at, cells: page },
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

/* ------------------------------------------------------------- version tag */

test('the page is served with a version tag and a lifetime', async () => {
  const res = await fetch(`${base}/api/p/${pubId}`)
  assert.equal(res.status, 200)
  const tag = res.headers.get('etag')
  assert.ok(tag, 'a response without a version tag: the second visit costs as much as the first')
  assert.match(res.headers.get('cache-control') ?? '', /max-age=\d+/)

  const again = await fetch(`${base}/api/p/${pubId}`, { headers: { 'if-none-match': tag } })
  assert.equal(again.status, 304, 'the same page arrived in full a second time')
  assert.equal(await again.text(), '', 'a 304 with a body is not a 304')
})

test('a step is the heaviest part, and it has its own tag', async () => {
  const first = await fetch(`${base}/api/p/${pubId}/step/3`)
  assert.equal(first.status, 200)
  const tag = first.headers.get('etag') ?? ''
  assert.ok(tag)

  const same = await fetch(`${base}/api/p/${pubId}/step/3`, { headers: { 'if-none-match': tag } })
  assert.equal(same.status, 304)

  // A step tag is about THIS step: the neighbouring one must not answer to it.
  const other = await fetch(`${base}/api/p/${pubId}/step/0`, { headers: { 'if-none-match': tag } })
  assert.equal(other.status, 200, 'the tag of one step matched another: the reader got the wrong step')
})

/* ----------------------------------------------- a republish cancels it all */

test('a republished page answers with the new: both the tag and the rail', async () => {
  const before = await fetch(`${base}/api/p/${pubId}`)
  const oldTag = before.headers.get('etag') ?? ''
  const seen = (await before.json()) as { seminar: { steps: { label: string }[] } }
  assert.deepEqual(
    seen.seminar.steps.map((s) => s.label),
    ['первая попытка', 'тетрадь на момент публикации'],
  )

  writePublication({
    sessionId: ROOM,
    title: 'Разбор',
    by: 'Ада',
    steps: [{ seq: 3, label: 'разобрали заново', at: Date.now(), cells: page }],
    blobs: [],
  })

  // The rail of steps is cached in memory — and had to be forgotten on write.
  assert.deepEqual(
    stepHeadings(pubId).map((h) => h.label),
    ['разобрали заново'],
    'the rail cache survived the republish and shows last week',
  )

  const after = await fetch(`${base}/api/p/${pubId}`, { headers: { 'if-none-match': oldTag } })
  assert.equal(after.status, 200, 'the old tag matched the republished page')
  const now = (await after.json()) as { seminar: { steps: { label: string }[] } }
  assert.deepEqual(
    now.seminar.steps.map((s) => s.label),
    ['разобрали заново'],
  )
})

/* ------------------------------------------------------- notebook by step */

test('the notebook downloads by step, and an unknown number means the last step', async () => {
  const at = Date.now()
  const other: PublicCell[] = [
    // A page cell always carries output and a run number: a page is a snapshot of
    // the notebook, not its source (shared/publish.ts · PublicCell).
    {
      id: 'c-late',
      type: 'code',
      source: 'print("поздний шаг")',
      outputs: [],
      execCount: null,
      ranMs: null,
    },
  ]
  writePublication({
    sessionId: ROOM,
    title: 'Разбор',
    by: 'Ада',
    steps: [
      { seq: 3, label: 'ранний', at, cells: page },
      { seq: 0, label: 'последний', at, cells: other },
    ],
    blobs: [],
  })

  const asked = await fetch(`${base}/api/p/${pubId}/notebook.ipynb?step=3`)
  assert.equal(asked.status, 200)
  assert.match(await asked.text(), /import numpy as np/, 'the downloaded step is not the one being viewed')

  // Without a number, as always: the notebook at the time of publication.
  const last = await fetch(`${base}/api/p/${pubId}/notebook.ipynb`)
  assert.match(await last.text(), /поздний шаг/)

  // A missed number is no place for explanations about addresses: a file in hand
  // beats an empty refusal.
  const nonsense = await fetch(`${base}/api/p/${pubId}/notebook.ipynb?step=99`)
  assert.equal(nonsense.status, 200)
  assert.match(await nonsense.text(), /поздний шаг/)
})
