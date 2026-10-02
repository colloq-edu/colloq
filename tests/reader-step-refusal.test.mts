import { translate, tr } from '../shared/i18n.js'
/**
 * Two "no"s for one code — through the reader's eyes.
 *
 * A notebook tab is refused for two different reasons, told apart only by
 * the response body: `material not found` is a tab the page does not have
 * (a link from before a rebuild that renamed or dropped it, or a typo), and
 * the page itself is alive; `publication not found` means the page was
 * withdrawn or erased. The steps had the same pair (`step not found`), and
 * the reader once printed "the page no longer exists" for both: a student who
 * mistyped the address left sure that the page was gone.
 *
 * What is checked here is that the right verdict is reached from the words,
 * by one copy of the rule in `shared/publish.ts`, not by the status code.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { newBlobBag, pageOfDoc } from '../server/src/publish/build.js'
import { setPublicationState, writePublication } from '../server/src/publish/store.js'
import { notebookMaterial } from '../server/src/publish/materials.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import {
  MATERIAL_NOT_FOUND,
  PUBLICATION_NOT_FOUND,
  refusedMaterial,
  refusedStep,
  STEP_NOT_FOUND,
} from '../shared/publish.js'

const ROOM = 'reader-refusal-room'
let pubId = ''
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Отказы', null)
  const { doc } = getSessionDoc(ROOM)
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'print(1)'))
  pubId = publish(pageOfDoc(doc, newBlobBag()), 'otkazy').id

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

/** A page as a build writes it: one notebook under `key`. */
function publish(cells: ReturnType<typeof pageOfDoc>, key: string) {
  const material = notebookMaterial({
    key,
    name: 'Отказы',
    path: `${key}.ipynb`,
    cells,
    blob: () => null,
  })
  return writePublication({
    sessionId: ROOM,
    title: 'Отказы',
    by: 'Ада',
    materials: [material],
    blobs: [],
  })
}

/** The path by which the client learns it: the status code and the body's `error` field. */
async function verdict(key: string): Promise<'material' | 'publication' | null> {
  const res = await fetch(`${base}/api/p/${pubId}/m/${encodeURIComponent(key)}`)
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return refusedMaterial(res.status, body.error ?? '')
}

test('a tab the page does not have means "no material", and the page is alive', async () => {
  assert.equal(await verdict('seminar'), 'material')
  // An all-digit tail is a 0.12 step address, never a material key.
  assert.equal(await verdict('12'), 'material')
  assert.equal(await verdict('otkazy'), null, 'the page’s own tab stopped opening')
})

test('a withdrawn page means "no page"', async () => {
  setPublicationState(pubId, 'withdrawn')
  try {
    assert.equal(await verdict('otkazy'), 'publication')
  } finally {
    setPublicationState(pubId, 'published')
  }
})

test('a page rebuilt with other tabs means "no material", not "no page"', async () => {
  /*
   * A page survives a rebuild: `writePublication` finds it by its room, keeps
   * the id and rewrites the materials. A tab link from before hits a live
   * page without that key: the same `material not found` as a typo, which
   * is exactly why the screen offers the first material instead of burying
   * the page.
   */
  const { doc } = getSessionDoc(ROOM)
  const again = publish(pageOfDoc(doc, newBlobBag()), 'lekciya')
  assert.equal(again.id, pubId, 'the rebuild changed the page address: then this is a different case')
  assert.equal(await verdict('otkazy'), 'material')
  assert.equal(await verdict('lekciya'), null)
})

test('a 404 without familiar words means "do not know", not "no"', () => {
  /*
   * A proxy stub, a foreign response, HTTP/2 with an empty statusText: such a
   * 404 proves neither that the tab does not exist nor that the page was
   * withdrawn — and it must not be treated as a verdict.
   */
  assert.equal(refusedMaterial(404, 'Not found (404)'), null)
  assert.equal(refusedMaterial(404, ''), null)
  assert.equal(refusedMaterial(500, MATERIAL_NOT_FOUND), null)
  assert.equal(refusedMaterial(503, PUBLICATION_NOT_FOUND), null)
  // The step rule stays for the reader until it moves to tabs.
  assert.equal(refusedStep(404, STEP_NOT_FOUND), 'step')
  assert.equal(refusedStep(404, 'Not found (404)'), null)
})

/* ----------------------------------------------------- the reader side */

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup and code without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('the reader decides by the refusal body, not by the code', () => {
  const page = code(read('web/src/components/reader/ClassPage.svelte'))
  assert.match(
    page,
    /refusedMaterial\(err\.status, err\.message\)/,
    'the verdict is again reached on the spot, with a local copy of the rule',
  )
  assert.doesNotMatch(page, /status === 404\)\s*\S+ = 'gone'/, 'any 404 again means "the page is gone"')
  // Each verdict has a state of its own, and «don't know» is a retry, not a verdict.
  assert.match(page, /what === 'publication' \? 'gone' : what === 'material' \? 'missing' : 'failed'/)
  assert.match(page, /tr\('room\.page\.noMaterial'\)/, 'a tab the page lacks has nothing to say')
  assert.match(page, /tr\('room\.page\.openFirst'\)/, 'and no way out to the first material')
  assert.match(page, /tr\('room\.page\.withdrawn'\)/)
  assert.match(translate('ru', 'room.page.noMaterial'), /В этом занятии нет такого материала/)
  // The steps are gone from the reader altogether.
  assert.doesNotMatch(code(read('web/src/screens/ReaderScreen.svelte')), /refusedStep|noSuchStep/)
})

test('the refusal body reaches the screen', () => {
  /*
   * All of this rests on one line in api.ts: without it `ApiError.message`
   * keeps `statusMessage(res)` — "Not found (404)" for both cases, and there
   * will be nothing to tell them apart with.
   */
  const api = read('web/src/lib/api.ts')
  assert.match(
    api,
    /body\?\.error\)\s*message = body\.error/,
    'the server words no longer reach ApiError.message',
  )
})
