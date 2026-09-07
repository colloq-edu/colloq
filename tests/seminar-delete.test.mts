/**
 * Что именно уносит с собой удалённый семинар.
 *
 * Каскад проверялся только со стороны клиента — что кнопка зовёт тот URL, — а
 * порядок шагов был переписан руками в persistence.test («Exactly what the
 * delete route does, in its order»). То есть маршрут можно было переставить
 * местами — снести документ ПОСЛЕ сноса снимка, — и комната воскресала после
 * перезапуска при зелёной сюите.
 *
 * Здесь проверяется сам маршрут: строки, файлы, история, надгробие в курсе и
 * судьба опубликованной страницы — и то, что после ответа снимок не появляется
 * заново.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { createCell, getCells } from '../shared/notebook.js'
import {
  createSession,
  getSession,
  listParticipants,
  loadDocSnapshot,
  upsertParticipant,
  versionCount,
} from '../server/src/db.js'
import { getSessionDoc, peekSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { flushPersistence } from '../server/src/collab/persistence.js'
import {
  createCourse,
  getCourse,
  getPublication,
  publicationOf,
  setCourseItems,
  writePublication,
} from '../server/src/publish/store.js'
import { adminInstanceRoutes } from '../server/src/routes/admin-instance.js'
import { sessionDir } from '../server/src/workspace.js'

let base = ''
let server: http.Server
let cookie = ''

before(async () => {
  const owner = createTeacher({ name: 'Ада', email: 'ada.delete@test.local', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as Response, owner)
  cookie = `${STAFF_COOKIE}=${value}`

  const app = express()
  app.use(express.json())
  app.use(adminInstanceRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/** Семинар со всем, что за ним тянется: человек, файл, тетрадь, история, страница. */
function seminarWithEverything(id: string, name: string): void {
  createSession(id, name, 'base')
  upsertParticipant({ id: 'p_1', sessionId: id, name: 'Нина', avatar: null, role: 'participant' })
  fs.writeFileSync(path.join(sessionDir(id), 'handout.csv'), 'a,b\n1,2\n')
  const { doc } = getSessionDoc(id)
  doc.transact(() => {
    getCells(doc).push([createCell('code', 'print(1)')])
  })
  flushPersistence(id)
  writePublication({
    sessionId: id,
    title: name,
    by: 'Ада',
    steps: [{ seq: 0, label: 'Тетрадь', at: Date.now(), cells: [] }],
    blobs: [],
  })
}

const remove = (id: string, query = '') =>
  fetch(`${base}/api/admin/seminars/${id}${query}`, { method: 'DELETE', headers: { cookie } })

test('удаление уносит строки, файлы и историю, а чтение оставляет', async () => {
  const id = 'delete-keep'
  seminarWithEverything(id, 'Четвёртая неделя')
  const pub = publicationOf(id)
  assert.ok(pub)
  // И курс, в котором он состоит: на его месте должно остаться надгробие.
  const course = createCourse('Матстат', null, 'Ада')
  assert.ok(setCourseItems(course.id, course.rev, [{ kind: 'seminar', sessionId: id, name: 'Четвёртая неделя', publication: null }]))

  assert.ok(loadDocSnapshot(id), 'снимка не было — проверять нечего')
  assert.ok(versionCount(id) > 0, 'истории не было — проверять нечего')

  const res = await remove(id)
  assert.equal(res.status, 204)

  assert.equal(getSession(id), null, 'строка семинара пережила удаление')
  assert.deepEqual(listParticipants(id), [])
  assert.equal(loadDocSnapshot(id), null, 'снимок тетради остался лежать')
  assert.equal(versionCount(id), 0, 'история осталась, а в ней вся тетрадь целиком')
  // Не `sessionDir`: она заводит папку, если её нет, — спрашиваем путь сами.
  assert.equal(
    fs.existsSync(path.join(process.env.WORKSPACE_DIR ?? '', id, 'handout.csv')),
    false,
    'файлы комнаты остались на диске',
  )
  assert.equal(peekSessionDoc(id), null, 'документ комнаты остался в памяти')

  // Страница живёт дальше, но уже без комнаты: ссылку у студентов не отозвать.
  const after = getPublication(pub.id)
  assert.ok(after, 'чтение стёрли вместе с комнатой')
  assert.equal(after.sessionId, null, 'страница всё ещё держится за снесённую комнату')

  // А в курсе — надгробие со ссылкой на это чтение, а не пропавшая неделя.
  const now = getCourse(course.id)
  assert.ok(now)
  const [row] = now.items
  assert.equal(row?.kind, 'gone')
  assert.equal(row?.kind === 'gone' ? row.name : '', 'Четвёртая неделя')
  assert.equal(row?.kind === 'gone' ? row.publication?.id : null, pub.id)
})

test('снимок не возвращается после ответа', async () => {
  /*
   * Тот самый порядок: сокеты закрыты и документ выселен ДО сноса строк, а
   * ядро гасится после — и всё, что могло воскреснуть, пока оно гасло,
   * сносится вторым проходом. Если снимок пишется после удаления строк,
   * комната возвращается на ближайшем перезапуске сервера — с ростером,
   * которого уже нет.
   */
  const id = 'delete-snapshot'
  seminarWithEverything(id, 'Пятая неделя')
  assert.equal((await remove(id)).status, 204)

  // Полсекунды — больше, чем debounce снимка (persistence.ts).
  await new Promise<void>((resolve) => setTimeout(resolve, 500))
  assert.equal(loadDocSnapshot(id), null, 'снимок удалённой комнаты появился заново')
  assert.equal(versionCount(id), 0, 'лента удалённой комнаты дописалась после ответа')
})

test('«удалить и чтение» стирает страницу насовсем', async () => {
  const id = 'delete-drop'
  seminarWithEverything(id, 'Шестая неделя')
  const pub = publicationOf(id)
  assert.ok(pub)

  assert.equal((await remove(id, '?reading=drop')).status, 204)
  assert.equal(getPublication(pub.id), null, 'страница пережила «удалить и чтение»')
})

test('удаляет владелец, и только он', async () => {
  const id = 'delete-teacher'
  seminarWithEverything(id, 'Седьмая неделя')
  const teacher = createTeacher({ name: 'Нина', email: 'nina.delete@test.local', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie(
    { cookie: (_n: string, v: string) => (value = v) } as unknown as Response,
    teacher,
  )

  const res = await fetch(`${base}/api/admin/seminars/${id}`, {
    method: 'DELETE',
    headers: { cookie: `${STAFF_COOKIE}=${value}` },
  })
  assert.equal(res.status, 403)
  assert.ok(getSession(id), 'семинар удалил не владелец')
})

test('семинара нет — 404, а не бодрое «удалено»', async () => {
  const res = await remove('no-such-seminar')
  assert.equal(res.status, 404)
})
