/**
 * Шаг, которого не было, — не то же самое, что страница, которой не стало.
 *
 * Читалка знает про публикацию два плохих исхода и путает их. «Этой страницы
 * семинара больше нет — его опубликовали заново» она печатает на ЛЮБОЙ 404 при
 * запросе шага: студент, промахнувшийся мимо номера в адресе (или прошедший по
 * ссылке на `-1`, который маршрутизатор клиента до сих пор считает шагом «с
 * конца», хотя такого шага не умеет никто), получает известие о том, что его
 * страницу переопубликовали, — при живой, ничем не тронутой публикации.
 *
 * Сервер различает эти два случая и всегда различал: у него разные тела ответа
 * на одном и том же коде. Здесь это закрепляется как контракт — потому что
 * различить их в читалке можно только по телу, и стоит его убрать, чинить будет
 * уже нечем.
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

test('шаги публикации читаются по своим номерам, а «первый» — по слову', () => {
  assert.deepEqual(
    stepHeadings(pubId).map((h) => h.seq),
    [0, 4],
  )
  assert.equal(readStep(pubId, 0)?.label, 'начало')
  assert.equal(readStep(pubId, 4)?.label, 'решение')
  assert.equal(readStep(pubId, null)?.label, 'начало', 'первый шаг перестал быть первым')
})

test('отрицательный номер — не «шаг с конца», а несуществующий шаг', () => {
  /*
   * `readStep` ищет `seq` буквально, так что −1 — это просто номер, которого
   * нет. Обратное обещано в двух местах: регулярка адресов на клиенте
   * (`web/src/lib/routes.ts`, `PUBLIC_PATH` с `-?\\d+`) и комментарий в
   * `shell.test.mts` — «отрицательный шаг это „с конца“, и он тоже шаг».
   * Реализации нет ни одной. Пока её нет, это утверждение и есть правда о
   * продукте; появится — падение здесь будет ровно тем местом, где решают, чем
   * −1 становится.
   */
  assert.equal(readStep(pubId, -1), null)
  assert.equal(readStep(pubId, 99), null)
})

test('живая страница со сломанным шагом говорит «нет шага», а не «нет страницы»', async () => {
  // Ровно та пара ответов, по которой читалка обязана выбирать между «такого
  // шага нет» и «страницу опубликовали заново». Код у них один — 404, — и
  // отличаются они только телом.
  const missing = await step('99')
  assert.equal(missing.status, 404)
  assert.equal(missing.error, 'step not found')

  const negative = await step('-1')
  assert.equal(negative.status, 404)
  assert.equal(negative.error, 'step not found', 'отрицательный шаг отвечает как пропавшая страница')

  // А сама публикация при этом жива и отдаёт свои шаги.
  const page = await fetch(`${base}/api/p/${pubId}`)
  assert.equal(page.status, 200)
  const seen = (await page.json()) as { seminar: { steps: { seq: number }[] } }
  assert.deepEqual(seen.seminar.steps.map((s) => s.seq), [0, 4])
})

test('не-число шагом не притворяется', async () => {
  const nonsense = await step('первый')
  assert.equal(nonsense.status, 400, 'мусор в адресе прошёл как номер шага')
})

test('снятая страница — это уже «нет страницы», и так и отвечает', async () => {
  setPublicationState(pubId, 'withdrawn')
  const withdrawn = await step('0')
  assert.equal(withdrawn.status, 404)
  assert.equal(
    withdrawn.error,
    'publication not found',
    'снятая страница отвечает как живая с плохим номером',
  )
  setPublicationState(pubId, 'published')
})
