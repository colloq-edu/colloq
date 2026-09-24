import { translate, tr } from '../shared/i18n.js'
/**
 * Two "no"s for one code — through the reader's eyes.
 *
 * The server refuses a step for two different reasons and tells them apart only
 * by the response body: `step not found` is a missed number on a live page,
 * `publication not found` means the page was withdrawn or published again. The
 * reader looked at the bare status and printed "This seminar page no longer
 * exists — it was published again" for both: a student who got a digit wrong
 * in the address (or followed a link to `-1`, which the router's regex still
 * lets through as a "step from the end") left sure that the page was gone.
 *
 * `tests/public-step.test.mts` pins the server's words. What is checked here is
 * the missing link — that the right verdict is reached from those words, and
 * that the reader reaches it exactly that way, not by the code. The rule lives
 * as one copy in `shared/publish.ts`: the two sides have nowhere to drift
 * apart, and if they did, there would be nothing left to tell the cases apart.
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
import { courseRoutes } from '../server/src/routes/courses.js'
import { PUBLICATION_NOT_FOUND, refusedStep, STEP_NOT_FOUND } from '../shared/publish.js'

const ROOM = 'reader-refusal-room'
let pubId = ''
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Отказы', null)
  const { doc } = getSessionDoc(ROOM)
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'print(1)'))
  const bag = newBlobBag()
  const at = Date.now()
  pubId = writePublication({
    sessionId: ROOM,
    title: 'Отказы',
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

/** The path by which the client learns it: the status code and the body's `error` field. */
async function verdict(seq: string): Promise<'step' | 'publication' | null> {
  const res = await fetch(`${base}/api/p/${pubId}/step/${encodeURIComponent(seq)}`)
  const body = (await res.json()) as { error?: string }
  return refusedStep(res.status, body.error ?? '')
}

test('a missed number means "no step", and the page is alive', async () => {
  assert.equal(await verdict('99'), 'step')
  // The reader no longer lets a minus through at all (`PUBLIC_PATH` in web/src/lib/routes.ts),
  // but the API answers it with the same "no step" — nothing can serve a "step from the end".
  assert.equal(await verdict('-1'), 'step')
})

test('a withdrawn page means "no page"', async () => {
  setPublicationState(pubId, 'withdrawn')
  try {
    assert.equal(await verdict('0'), 'publication')
  } finally {
    setPublicationState(pubId, 'published')
  }
})

test('a seminar published again means "no step", not "no page"', async () => {
  /*
   * A publication survives a republish: `writePublication` finds it by seminar,
   * keeps the id and rewrites the steps. So a link to a former mark hits a live
   * page without that `seq` — the same `step not found` as a typo in the number.
   * That is exactly why the text on screen has no right to name one of the two
   * reasons: it says that there is no such page and that the link may be out of
   * date, and leads to the first step.
   */
  const { doc } = getSessionDoc(ROOM)
  const bag = newBlobBag()
  const again = writePublication({
    sessionId: ROOM,
    title: 'Отказы',
    by: 'Ада',
    steps: [{ seq: 0, label: 'начало', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  assert.equal(again.id, pubId, 'the republish changed the page address: then this is a different case')
  assert.equal(await verdict('4'), 'step')
  assert.equal(await verdict('0'), null, 'a surviving step suddenly stopped opening')
})

test('a 404 without familiar words means "do not know", not "no"', () => {
  /*
   * A proxy stub, a foreign response, HTTP/2 with an empty statusText: such a
   * 404 proves neither that the step does not exist nor that the page was
   * withdrawn — and it must not be treated as a verdict.
   */
  assert.equal(refusedStep(404, 'Not found (404)'), null)
  assert.equal(refusedStep(404, ''), null)
  // And the other way round: familiar words under another code decide nothing.
  assert.equal(refusedStep(500, STEP_NOT_FOUND), null)
  assert.equal(refusedStep(503, PUBLICATION_NOT_FOUND), null)
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
  const screen = code(read('web/src/screens/ReaderScreen.svelte'))
  assert.match(screen, /refusedStep\(/, 'the verdict is again reached on the spot, with a local copy of the rule')
  assert.doesNotMatch(
    screen,
    /status === 404\)\s*gone = true/,
    'any 404 again means "it was published again"',
  )
  assert.match(screen, /noSuchStep/, 'the screen has no "no such step" state')
  assert.match(
    screen,
    /tr\('room\.ui\.876'\)/,
    'an outdated step link again has nothing to say in its own words',
  )
  /*
   * And most importantly: the words about republishing are no longer stated as
   * fact. The server does not know that reason — `step not found` also comes
   * for a typo in the number.
   */
  assert.doesNotMatch(screen, /опубликовали заново/, 'the reason is again named on behalf of the server')
  assert.match(translate('ru', 'room.ui.876'), /Такой страницы у этого занятия нет/)
  assert.doesNotMatch(translate('ru', 'room.ui.876'), /опубликовали заново/)
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
