/**
 * Двери панели против комнаты, которая лежит в памяти.
 *
 * `getSession` отвечает из кэша (db.ts · roomCache): «жив ли ещё семинар,
 * который назвал токен» — единственное, что спрашивает рукопожатие каждого
 * сокета, а после перезапуска сервера или моргания ретранслятора пятьсот
 * вкладок задают этот вопрос за одну-две секунды. Цена такого кэша ровно одна:
 * он обязан замечать, когда комната меняется, — а меняет её панель, и обе её
 * двери писали в таблицу своим SQL, мимо db.ts.
 *
 * Кэш здесь ПРОГРЕТ нарочно: холодный отвечает из базы и расхождения не
 * показывает вовсе, так что тест без прогрева зелен при любой поломке.
 *
 * Проверяется видимый исход, а не механизм: у имени семинара два хранилища —
 * строка и `meta.title` тетради, — и панель обязана оставить их согласованными.
 * Сегодня это держится двумя путями сразу (строку пишет `renameSession`, а
 * тетрадь — тот же обработчик, чей наблюдатель зеркалит её обратно в строку);
 * тест падает, когда пропадёт последний.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, oldestOwner } from '../server/src/admin/store.js'
import { app } from '../server/src/app.js'
import { createSession, getSession } from '../server/src/db.js'
import { getMeta } from '../shared/notebook.js'
import { visitSessionDoc } from '../server/src/routes/doc-visit.js'

let base = ''
let server: http.Server

before(async () => {
  // Удаление семинара — только владельцу, и в пустом инстансе его нет.
  createTeacher({ name: 'Ада', email: 'ada@room-cache.test', role: 'owner' })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

/** Печенье владельца: issueStaffCookie пишет в ответ express, это его подобие. */
function ownerCookie(): string {
  const owner = oldestOwner()
  assert.ok(owner, 'инстанс без владельца — тест не о том')
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, owner)
  return `${STAFF_COOKIE}=${value}`
}

function call(
  method: string,
  path: string,
  init: { body?: unknown } = {},
): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: ownerCookie() },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

test('переименование из панели доезжает до комнаты, а не только до таблицы', async () => {
  const room = 'panel-rename-cache'
  createSession(room, 'Неделя первая', null)
  // Прогрев: ровно то чтение, которым живёт карточка комнаты и дверь сокета.
  assert.equal(getSession(room)?.name, 'Неделя первая')

  const res = await call('PATCH', `/api/admin/seminars/${room}`, { body: { name: 'Неделя вторая' } })
  assert.equal(res.status, 200)

  assert.equal(
    getSession(room)?.name,
    'Неделя вторая',
    'панель переименовала семинар, а сервер до перезапуска отдаёт прежнее имя',
  )
  // И второе место, где у семинара есть имя: шапка комнаты читает тетрадь.
  assert.equal(
    visitSessionDoc(room, (doc) => getMeta(doc).get('title')),
    'Неделя вторая',
    'в панели одно имя, а у людей в комнате другое',
  )
})

test('удалённый семинар не остаётся живым в памяти', async () => {
  const room = 'panel-delete-cache'
  createSession(room, 'Под снос', null)
  assert.ok(getSession(room), 'комната не завелась — проверять нечего')

  const res = await call('DELETE', `/api/admin/seminars/${room}`)
  assert.equal(res.status, 204)

  /*
   * Не «строки нет в таблице» — это спрашивает с маршрута каскад
   * (seminar-delete.test.mts), — а «сервер больше не считает комнату живой»:
   * забытый в браузере токен живёт до тридцати суток и стучится именно в эту
   * дверь, а она отвечает из памяти, и прогрев выше её туда положил.
   */
  assert.equal(
    getSession(room),
    null,
    'удаление не забыло комнату: старый токен открывал бы сокет до перезапуска',
  )
})
