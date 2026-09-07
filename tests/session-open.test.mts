/**
 * Как заводится комната и что происходит на входе в неё.
 *
 * Три вещи, которые двери комнаты делали по-разному:
 *
 *  - `POST /api/sessions` записывал окружение NULL, а NULL для ядра значит
 *    «следуй за инстансом»: следующее «Make default» уводило Python такой
 *    комнаты на другой образ. Панель это состояние отменила и записывает
 *    конкретное имя всегда — а скриптовая дверь жила по старому правилу.
 *  - `/join` грел ядро безусловно, то есть поднимал контейнер комнаты (два
 *    гигабайта, два часа простоя) КАЖДОМУ, кто открыл ссылку на законченный
 *    семинар перечитать разбор.
 *  - имя чистили тремя дословными копиями одной функции, а четвёртая дверь —
 *    импорт — обходилась `trim()`, и в список панели уезжали переводы строк.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { normalizeLabel } from '../shared/text.js'
import { createSession, getSession, sessionEnvironment, setFinished } from '../server/src/db.js'
import { activeName } from '../server/src/environments.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { app } from '../server/src/app.js'
import { warmsKernel } from '../server/src/routes/sessions.js'

let base = ''
let server: http.Server
let cookie = ''

before(async () => {
  const owner = createTeacher({ name: 'Ада', email: 'ada.open@test.local', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as Response, owner)
  cookie = `${STAFF_COOKIE}=${value}`

  /*
   * Приложение целиком (server/src/app.ts), а не свой express рядом: копия
   * порядка middleware расхождений с продуктом не ловит, она их повторяет.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  shutdownCollab()
})

/* ------------------------------------------------------------- окружение */

test('семинар, заведённый через API, помнит имя окружения, а не «как инстанс»', async () => {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Скриптовый семинар' }),
  })
  assert.equal(res.status, 201)
  const { session } = (await res.json()) as { session: { id: string } }
  /*
   * NULL здесь означал бы «спрашивать инстанс на каждом старте ядра»: комната
   * уезжала бы на другой образ при следующей смене умолчания, а панель не
   * считала бы её среди тех, кто держит окружение от удаления.
   */
  assert.equal(sessionEnvironment(session.id), activeName())
})

test('несуществующее окружение — отказ, а не имя образа, которого нет', async () => {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'На чужом образе', environment: 'no-such-env' }),
  })
  assert.equal(res.status, 400)
})

/* ------------------------------------------------------------ прогрев ядра */

test('ядро греется живой комнате, а законченной — только преподавателю', () => {
  const id = 'warm-finished'
  createSession(id, 'Прошлая пара', 'base')
  assert.equal(warmsKernel(id, 'participant'), true, 'живая комната не греет ядро')

  setFinished(id, Date.now())
  assert.equal(
    warmsKernel(id, 'participant'),
    false,
    'вход в законченный семинар поднял контейнер студенту',
  )
  // Преподаватель приходит в законченную комнату, чтобы что-то пересчитать.
  assert.equal(warmsKernel(id, 'host'), true)

  setFinished(id, null)
  assert.equal(warmsKernel(id, 'participant'), true, 'открытая заново комната не греется')
})

test('архивный семинар ядро тоже не поднимает', async () => {
  const id = 'warm-archived'
  createSession(id, 'Прошлый семестр', 'base')
  const res = await fetch(`${base}/api/admin/seminars/${id}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ archived: true }),
  })
  assert.equal(res.status, 200)
  assert.equal(warmsKernel(id, 'participant'), false)
  assert.equal(warmsKernel(id, 'host'), true)
})

/* ------------------------------------------------------------------- имена */

test('перевод строки в имени — пробел, а не разрыв вёрстки', () => {
  assert.equal(normalizeLabel('a\nb\tc'), 'a b c')
  assert.equal(normalizeLabel('  Нина   Петрова  '), 'Нина Петрова')
  assert.equal(normalizeLabel(42), '')
})

test('импорт меряет имя той же меркой, что и остальные три двери', async () => {
  const res = await fetch(`${base}/api/admin/import/notebook`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Неделя\n4\tДеревья',
      cells: [{ cell_type: 'code', source: 'print(1)' }],
    }),
  })
  assert.equal(res.status, 201)
  const { id } = (await res.json()) as { id: string }
  assert.equal(getSession(id)?.name, 'Неделя 4 Деревья')
})

test('комната из API тоже чистит имя', async () => {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Семинар\nвторой' }),
  })
  assert.equal(res.status, 201)
  const { session } = (await res.json()) as { session: { id: string; name: string } }
  assert.equal(session.name, 'Семинар второй')
})
