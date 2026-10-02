/**
 * The public half under load: what it serves twice and what it does not
 * recompute.
 *
 * A class page is opened by five hundred people within one minute, from
 * phones. Every response carries a version tag, so the second visit costs a
 * 304, and a rebuild changes the tag, so nobody is shown last week. The page
 * and the course are tagged by their body and asked again each time (they
 * depend on the course rows and the neighbours); a notebook tab is tagged by
 * the page's materials revision and kept for five minutes.
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
import { notebookMaterial } from '../server/src/publish/materials.js'
import { createCourse, setCourseItems, writePublication } from '../server/src/publish/store.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import type { PublicCell } from '../shared/publish.js'

const ROOM = 'public-cache-room'
let pubId = ''
let courseId = ''
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Разбор', null)
  const { doc } = getSessionDoc(ROOM)
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'import numpy as np'))
  pubId = publish(pageOfDoc(doc, newBlobBag())).id
  const course = createCourse('Кэш', null, null)
  courseId = course.id
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', id: 'rcache01', sessionId: ROOM, name: 'Разбор', publication: null },
  ])

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

function publish(cells: PublicCell[]) {
  const material = notebookMaterial({
    key: 'razbor',
    name: 'Разбор',
    path: 'razbor.ipynb',
    cells,
    blob: () => null,
  })
  return writePublication({
    sessionId: ROOM,
    title: 'Разбор',
    by: 'Ада',
    materials: [material],
    blobs: [],
  })
}

/* ------------------------------------------------------------- version tag */

for (const [what, path] of [
  ['the page', () => `/api/p/${pubId}`],
  ['the course', () => `/api/c/${courseId}`],
] as const) {
  test(`${what} is tagged by its body and asked again every time`, async () => {
    const res = await fetch(`${base}${path()}`)
    assert.equal(res.status, 200)
    const tag = res.headers.get('etag')
    assert.ok(tag, 'a response without a version tag: the second visit costs as much as the first')
    assert.match(tag, /^W\//)
    assert.equal(res.headers.get('cache-control'), 'no-cache')

    const again = await fetch(`${base}${path()}`, { headers: { 'if-none-match': tag } })
    assert.equal(again.status, 304, 'the same body arrived in full a second time')
    assert.equal(await again.text(), '', 'a 304 with a body is not a 304')
  })
}

test('a notebook tab has a tag of its own and a lifetime', async () => {
  const first = await fetch(`${base}/api/p/${pubId}/m/razbor`)
  assert.equal(first.status, 200)
  const tag = first.headers.get('etag') ?? ''
  assert.ok(tag)
  assert.match(first.headers.get('cache-control') ?? '', /max-age=300/)
  const same = await fetch(`${base}/api/p/${pubId}/m/razbor`, { headers: { 'if-none-match': tag } })
  assert.equal(same.status, 304)
  // The page's tag is not the tab's.
  const pageTag = (await fetch(`${base}/api/p/${pubId}`)).headers.get('etag')
  assert.notEqual(pageTag, tag)
})

/* ----------------------------------------------- a republish cancels it all */

test('a rebuilt page answers with the new: the page, the tab and the course', async () => {
  const oldPage = (await fetch(`${base}/api/p/${pubId}`)).headers.get('etag') ?? ''
  const oldTab = (await fetch(`${base}/api/p/${pubId}/m/razbor`)).headers.get('etag') ?? ''
  const oldCourse = (await fetch(`${base}/api/c/${courseId}`)).headers.get('etag') ?? ''
  publish([
    {
      id: 'c-late',
      type: 'code',
      source: 'print("разобрали заново")',
      outputs: [],
      execCount: null,
      ranMs: null,
    },
  ])
  const page = await fetch(`${base}/api/p/${pubId}`, { headers: { 'if-none-match': oldPage } })
  assert.equal(page.status, 200, 'the old tag matched the rebuilt page')
  const tab = await fetch(`${base}/api/p/${pubId}/m/razbor`, { headers: { 'if-none-match': oldTab } })
  assert.equal(tab.status, 200, 'the old tag matched the rebuilt notebook')
  const body = (await tab.json()) as { notebook: { key: string; cells: PublicCell[] } }
  assert.equal(body.notebook.key, 'razbor')
  assert.equal(body.notebook.cells[0].source, 'print("разобрали заново")')
  const course = await fetch(`${base}/api/c/${courseId}`, { headers: { 'if-none-match': oldCourse } })
  assert.equal(course.status, 200, 'the course kept the date of the page from before the rebuild')
})

/* ------------------------------------------------------- the notebook file */

test('the old notebook link leads to the first notebook, with outputs, whatever step it names', async () => {
  publish([
    {
      id: 'c-out',
      type: 'code',
      source: 'print("с выводом")',
      outputs: [{ kind: 'stream', name: 'stdout', text: 'с выводом\n' }],
      execCount: 4,
      ranMs: 10,
    },
  ])
  for (const query of ['', '?step=3', '?step=99']) {
    const hop = await fetch(`${base}/api/p/${pubId}/notebook.ipynb${query}`, { redirect: 'manual' })
    assert.equal(hop.status, 302)
    assert.equal(hop.headers.get('location'), `/api/p/${pubId}/m/razbor/download`)
    const res = await fetch(`${base}/api/p/${pubId}/notebook.ipynb${query}`)
    assert.equal(res.status, 200)
    const nb = (await res.json()) as { cells: { outputs: { text: string }[] }[] }
    assert.equal(nb.cells[0].outputs[0].text, 'с выводом\n')
  }
})

test('a download is tagged by its content hash', async () => {
  const res = await fetch(`${base}/api/p/${pubId}/m/razbor/download`)
  const tag = res.headers.get('etag') ?? ''
  assert.match(tag, /^"[0-9a-f]{64}"$/)
  const again = await fetch(`${base}/api/p/${pubId}/m/razbor/download`, {
    headers: { 'if-none-match': tag },
  })
  assert.equal(again.status, 304)
})
