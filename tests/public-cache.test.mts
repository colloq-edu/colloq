/**
 * Публичная половина под потоком: что она отдаёт дважды и чего не считает заново.
 *
 * Страницу разбора открывают пятьсот человек в одну минуту, с телефонов, и
 * каждый листает шаги. До этого каждый такой заход шёл в базу целиком: рельса
 * шагов считалась разбором ПОЛНОГО текста каждой страницы (все текстовые
 * выводы шага — лог обучения на мегабайты) ради сорока маленьких чисел, а
 * ответы не несли ни метки версии, ни срока жизни, так что второй заход стоил
 * ровно столько же, сколько первый.
 *
 * Опасность починки — противоположная: кэш, переживший переиздание, показывает
 * классу прошлую неделю. Поэтому здесь проверяется и то, и другое: что
 * неизменившееся отвечает 304, и что переизданное отвечает новым.
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

/* ------------------------------------------------------------ метка версии */

test('страница отдаётся с меткой версии и сроком жизни', async () => {
  const res = await fetch(`${base}/api/p/${pubId}`)
  assert.equal(res.status, 200)
  const tag = res.headers.get('etag')
  assert.ok(tag, 'ответ без метки версии — второй заход стоит столько же, сколько первый')
  assert.match(res.headers.get('cache-control') ?? '', /max-age=\d+/)

  const again = await fetch(`${base}/api/p/${pubId}`, { headers: { 'if-none-match': tag } })
  assert.equal(again.status, 304, 'та же страница приехала вторично целиком')
  assert.equal(await again.text(), '', '304 с телом — это не 304')
})

test('шаг — самое тяжёлое, и у него метка своя', async () => {
  const first = await fetch(`${base}/api/p/${pubId}/step/3`)
  assert.equal(first.status, 200)
  const tag = first.headers.get('etag') ?? ''
  assert.ok(tag)

  const same = await fetch(`${base}/api/p/${pubId}/step/3`, { headers: { 'if-none-match': tag } })
  assert.equal(same.status, 304)

  // Метка шага — про ЭТОТ шаг: соседний по ней отвечать не должен.
  const other = await fetch(`${base}/api/p/${pubId}/step/0`, { headers: { 'if-none-match': tag } })
  assert.equal(other.status, 200, 'метка одного шага сошлась с другим — читателю уехал не тот шаг')
})

/* ------------------------------------------------- переиздание всё отменяет */

test('переизданная страница отвечает новым — и метка, и рельса', async () => {
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

  // Рельса шагов кэширована в памяти — и обязана была забыться при записи.
  assert.deepEqual(
    stepHeadings(pubId).map((h) => h.label),
    ['разобрали заново'],
    'кэш рельсы пережил переиздание и показывает прошлую неделю',
  )

  const after = await fetch(`${base}/api/p/${pubId}`, { headers: { 'if-none-match': oldTag } })
  assert.equal(after.status, 200, 'прошлая метка сошлась с переизданной страницей')
  const now = (await after.json()) as { seminar: { steps: { label: string }[] } }
  assert.deepEqual(
    now.seminar.steps.map((s) => s.label),
    ['разобрали заново'],
  )
})

/* ------------------------------------------------------- тетрадь по шагам */

test('тетрадь скачивается по шагу, а незнакомый номер — это последний шаг', async () => {
  const at = Date.now()
  const other: PublicCell[] = [
    // Ячейка страницы всегда несёт вывод и номер запуска: страница — это снимок
    // тетради, а не её исходник (shared/publish.ts · PublicCell).
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
  assert.match(await asked.text(), /import numpy as np/, 'скачался не тот шаг, на котором стоят')

  // Без номера — как было всегда: тетрадь на момент публикации.
  const last = await fetch(`${base}/api/p/${pubId}/notebook.ipynb`)
  assert.match(await last.text(), /поздний шаг/)

  // Промах мимо номера — не место для объяснений про адреса: файл в руках
  // лучше пустого отказа.
  const nonsense = await fetch(`${base}/api/p/${pubId}/notebook.ipynb?step=99`)
  assert.equal(nonsense.status, 200)
  assert.match(await nonsense.text(), /поздний шаг/)
})
