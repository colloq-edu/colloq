/**
 * The 0.12 addresses after steps are gone.
 *
 * A page used to be a rail of steps at `/p/<h>/<n>`, with `/api/p/:id/step/:seq`
 * behind each and one `notebook.ipynb` link printed under them. Those links
 * are in group chats and bookmarks. A step address has nothing left to lead
 * to, so it answers 410 with the page's address, and the reader goes there;
 * the notebook link still downloads, now the first notebook with its outputs.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession, db } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { newBlobBag, pageOfDoc } from '../server/src/publish/build.js'
import { notebookMaterial } from '../server/src/publish/materials.js'
import {
  setPublicationSlug,
  setPublicationState,
  writePublication,
} from '../server/src/publish/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { STEPS_GONE } from '../shared/publish.js'

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
  const material = notebookMaterial({
    key: 'shagi',
    name: 'Шаги',
    path: 'shagi.ipynb',
    cells: pageOfDoc(doc, bag),
    blob: () => null,
  })
  pubId = writePublication({
    sessionId: ROOM,
    title: 'Шаги',
    by: 'Ада',
    materials: [material],
    blobs: bag.all(),
  }).id
  assert.equal(setPublicationSlug(pubId, 'shagi-01'), 'ok')

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

async function step(handle: string, seq: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/p/${handle}/step/${encodeURIComponent(seq)}`)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

test('every step address answers 410 with the page to go to', async () => {
  for (const seq of ['0', '3', '-1', 'first', 'первый']) {
    const { status, body } = await step(pubId, seq)
    assert.equal(status, 410, `step ${seq}`)
    assert.equal(body.error, STEPS_GONE)
    // The page's own address, not the id the old link happened to carry.
    assert.equal(body.address, 'shagi-01')
  }
})

test('a withdrawn page still names itself; an unknown one is a 404', async () => {
  setPublicationState(pubId, 'withdrawn')
  try {
    const { status, body } = await step('shagi-01', '0')
    assert.equal(status, 410)
    assert.equal(body.address, 'shagi-01')
  } finally {
    setPublicationState(pubId, 'published')
  }
  const missing = await step('no-such-page', '0')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'publication not found')
})

test('the notebook link redirects to the first notebook’s download', async () => {
  const hop = await fetch(`${base}/api/p/${pubId}/notebook.ipynb?step=4`, { redirect: 'manual' })
  assert.equal(hop.status, 302)
  assert.equal(hop.headers.get('location'), '/api/p/shagi-01/m/shagi/download')
  const file = await fetch(`${base}${hop.headers.get('location')}`)
  assert.equal(file.status, 200)
  assert.match(file.headers.get('content-disposition') ?? '', /filename\*=UTF-8''shagi\.ipynb/)
})

test('the rollback copy is still written for 0.12', () => {
  // A 0.12 brought back renders every page from step 0; the store keeps it.
  const row = db
    .prepare('SELECT label, page FROM publication_steps WHERE pub = ? AND seq = 0')
    .get(pubId) as { label: string; page: string }
  assert.equal(row.label, 'Тетрадь на момент публикации')
  const cells = JSON.parse(row.page) as { source: string }[]
  assert.ok(cells.some((c) => c.source.startsWith('import pandas as pd')))
})
