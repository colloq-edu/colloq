import { translate, tr } from '../shared/i18n.js'
/**
 * Два «нет» на один код — глазами читалки.
 *
 * Сервер отказывает в шаге по двум разным поводам и различает их только телом
 * ответа: `step not found` — промах мимо номера при живой странице,
 * `publication not found` — страницу сняли или опубликовали заново. Читалка
 * смотрела на голый статус и печатала «Этой страницы семинара больше нет — его
 * опубликовали заново» на оба: студент, ошибшийся цифрой в адресе (или
 * прошедший по ссылке на `-1`, который регулярка роутера до сих пор пропускает
 * как «шаг с конца»), уходил уверенный, что страницы больше нет.
 *
 * `tests/public-step.test.mts` закрепляет слова сервера. Здесь проверяется
 * недостающее звено — что по этим словам выносится правильный вердикт, и что
 * читалка выносит его именно так, а не по коду. Правило живёт одной копией в
 * `shared/publish.ts`: разъехаться двум сторонам негде, а если разъедутся —
 * различать случаи будет уже нечем.
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

/** Тот же путь, каким это узнаёт клиент: код ответа и поле `error` из тела. */
async function verdict(seq: string): Promise<'step' | 'publication' | null> {
  const res = await fetch(`${base}/api/p/${pubId}/step/${encodeURIComponent(seq)}`)
  const body = (await res.json()) as { error?: string }
  return refusedStep(res.status, body.error ?? '')
}

test('промах мимо номера — это «нет шага», а страница жива', async () => {
  assert.equal(await verdict('99'), 'step')
  // Минус читалка теперь и не пропустит (`PUBLIC_PATH` в web/src/lib/routes.ts),
  // но API о нём отвечает тем же «нет шага» — «шага с конца» не умеет никто.
  assert.equal(await verdict('-1'), 'step')
})

test('снятая страница — это «нет страницы»', async () => {
  setPublicationState(pubId, 'withdrawn')
  try {
    assert.equal(await verdict('0'), 'publication')
  } finally {
    setPublicationState(pubId, 'published')
  }
})

test('семинар, опубликованный заново, — это «нет шага», а не «нет страницы»', async () => {
  /*
   * Публикация переживает переиздание: `writePublication` находит её по
   * семинару, оставляет id и переписывает шаги. Значит, ссылка на прежнюю
   * отметку упирается в живую страницу без этого `seq` — тот же `step not
   * found`, что и опечатка в номере. Ровно поэтому текст на экране не имеет
   * права называть одну из двух причин: он говорит, что страницы нет и что
   * ссылка могла устареть, и уводит на первую.
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
  assert.equal(again.id, pubId, 'переиздание сменило адрес страницы — тогда это другой случай')
  assert.equal(await verdict('4'), 'step')
  assert.equal(await verdict('0'), null, 'уцелевший шаг вдруг перестал открываться')
})

test('404 без знакомых слов — это «не знаю», а не «нет»', () => {
  /*
   * Заглушка прокси, чужой ответ, HTTP/2 с пустым statusText: такое 404 не
   * доказывает ни того, что шага нет, ни того, что страницу сняли, — и вести
   * себя по нему как по приговору нельзя.
   */
  assert.equal(refusedStep(404, 'Not found (404)'), null)
  assert.equal(refusedStep(404, ''), null)
  // И наоборот: знакомые слова под чужим кодом ничего не решают.
  assert.equal(refusedStep(500, STEP_NOT_FOUND), null)
  assert.equal(refusedStep(503, PUBLICATION_NOT_FOUND), null)
})

/* ----------------------------------------------------- сторона читалки */

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка и код без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('читалка выбирает по телу отказа, а не по коду', () => {
  const screen = code(read('web/src/screens/ReaderScreen.svelte'))
  assert.match(screen, /refusedStep\(/, 'вердикт снова выносится на месте, своей копией правила')
  assert.doesNotMatch(
    screen,
    /status === 404\)\s*gone = true/,
    'любой 404 снова означает «его опубликовали заново»',
  )
  assert.match(screen, /noSuchStep/, 'состояния «такого шага нет» у экрана нет')
  assert.match(
    screen,
    /tr\('room\.ui\.876'\)/,
    'устаревшей ссылке на шаг снова нечего сказать своими словами',
  )
  /*
   * И главное: слова о переиздании больше не выносятся как факт. Сервер этой
   * причины не знает — `step not found` приходит и на опечатку в номере.
   */
  assert.doesNotMatch(screen, /опубликовали заново/, 'причина снова названа за сервер')
  assert.match(translate('ru', 'room.ui.876'), /Такой страницы у этого занятия нет/)
  assert.doesNotMatch(translate('ru', 'room.ui.876'), /опубликовали заново/)
})

test('тело отказа доезжает до экрана', () => {
  /*
   * Всё это держится на одной строке в api.ts: без неё в `ApiError.message`
   * остаётся `statusMessage(res)` — «Not found (404)» на оба случая, и
   * различать их станет нечем.
   */
  const api = read('web/src/lib/api.ts')
  assert.match(
    api,
    /body\?\.error\)\s*message = body\.error/,
    'слова сервера больше не доезжают до ApiError.message',
  )
})
