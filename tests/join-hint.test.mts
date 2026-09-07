/**
 * Подсказка на экране входа: она ведёт по тому адресу, который диктовали классу.
 *
 * Ссылка, которая у студента правда есть, — это `/s/<комната>`, и через неделю
 * он вводит по ней имя в закончившееся занятие. Экран входа поэтому показывает
 * опубликованную версию и курс — и адрес страницы у неё `/p/<slug>`, а не
 * `/p/<id>`: имя ей дали ровно затем, чтобы называть его вслух. Пока сервер
 * присылал только идентификатор, подсказка уводила класс на запасной вход.
 *
 * Рядом — цена этого ответа. Курс искался перебором ВСЕХ курсов семестра с
 * разбором JSON состава у каждого, и делалось это на каждый вход и каждое
 * обновление страницы: до пятисот раз в первую минуту пары.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionInfo } from '../shared/protocol.js'
import { publicationAddress } from '../shared/publish.js'
import { createSession } from '../server/src/db.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import {
  createCourse,
  setCourseItems,
  setPublicationSlug,
  writePublication,
} from '../server/src/publish/store.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'

const ROOM = 'join-hint-room'
const LONELY = 'join-hint-lonely'
let base = ''
let server: http.Server
let pubId = ''

before(async () => {
  createSession(ROOM, 'Неделя 4', null)
  createSession(LONELY, 'Никем не изданная', null)
  pubId = writePublication({
    sessionId: ROOM,
    title: 'Неделя 4',
    by: 'Ада',
    steps: [{ seq: 0, label: 'разбор', at: Date.now(), cells: [] }],
    blobs: [],
  }).id
  assert.equal(setPublicationSlug(pubId, 'week-4'), 'ok')

  const course = createCourse('Машинное обучение', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'planned', name: 'Неделя 5', when: 'через неделю' },
    { kind: 'seminar', sessionId: ROOM, name: 'Неделя 4', publication: null },
  ])

  const app = express()
  app.use(express.json())
  app.use(sessionRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

const info = async (id: string): Promise<SessionInfo> =>
  (await (await fetch(`${base}/api/sessions/${id}`)).json()) as SessionInfo

test('подсказка называет адрес страницы, а не запасной вход по идентификатору', async () => {
  const body = await info(ROOM)
  assert.equal(body.published?.id, pubId)
  assert.equal(body.published?.slug, 'week-4', 'подсказка снова уводит класс на /p/<id>')
  // Собирает адрес одна функция на весь продукт — и с этим полем ей есть из
  // чего его собрать.
  assert.equal(publicationAddress({ id: pubId, slug: body.published?.slug ?? null }), 'week-4')
  assert.equal(body.course?.name, 'Машинное обучение', 'путь наверх с экрана входа пропал')
})

test('комната без публикации ничего не обещает', async () => {
  const body = await info(LONELY)
  assert.equal(body.published, null)
  assert.equal(body.course, null)
})
