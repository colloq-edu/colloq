/**
 * Числа, которые панель обязана взять у сервера, а не выдумать.
 *
 * Два поля, и у обоих цена — строка на экране, которая звучит уверенно и врёт.
 *
 * Предел загрузки: форма создания семинара печатает его («Up to 50 MB each») и
 * по нему же отказывает слишком большому файлу ДО того, как комната появится.
 * Пока сервер его не присылал, панель держала копию умолчания — и оператор,
 * поднявший MAX_UPLOAD_MB до 200, читал на экране чужое число, а узнавал
 * правду загрузкой, которая не доехала.
 *
 * Часы занятия: строка списка пишет «Running now · started 25 min ago». Пока
 * этих часов не было, она считала их от создания комнаты — а комнату заводят за
 * неделю до пары и переиспользуют на второй, так что рядом со словом «сейчас»
 * стояло «6 days ago».
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { WebSocket } from 'ws'
import { STAFF_COOKIE, type AdminSeminar, type InstanceState } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { config } from '../server/src/config.js'
import { createSession } from '../server/src/db.js'
import { handleCollabSocket, liveSince, shutdownCollab } from '../server/src/collab/index.js'
import { adminAuthRoutes } from '../server/src/routes/admin-auth.js'
import { adminInstanceRoutes } from '../server/src/routes/admin-instance.js'

const ROOM = 'panel-clock'
let base = ''
let server: http.Server
let cookie = ''

function cookieFor(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

/** Ровно то, что читает `handleCollabSocket`, и ничего сверх. */
function seat(): { ws: WebSocket; close(): void } {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const fake = {
    binaryType: 'arraybuffer',
    readyState: WebSocket.OPEN as number,
    // Три аргумента, как их шлёт collab/index.ts: кадр, настройки сжатия и
    // колбэк. Двухаргументная подделка ловила настройки вместо колбэка, звала
    // их как функцию — и сервер, поймав исключение, закрывал сокет сразу же.
    send(_frame: unknown, _opts?: unknown, done?: (err?: Error) => void) {
      done?.()
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
      // Иначе сердцебиение переживёт тест и потащит за собой всю сюиту.
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  return { ws: fake as unknown as WebSocket, close: () => fake.close() }
}

before(async () => {
  const teacher = createTeacher({ name: 'Ада', email: 'ada.facts@test.local', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  cookie = cookieFor(teacher)
  createSession(ROOM, 'Пара, которая идёт', null)

  const app = express()
  app.use(express.json())
  app.use(adminAuthRoutes())
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

test('состояние инстанса называет предел загрузки числом', async () => {
  const res = await fetch(`${base}/api/admin/state`)
  assert.equal(res.status, 200)
  const state = (await res.json()) as InstanceState
  assert.equal(
    state.maxUploadBytes,
    config.maxUploadBytes,
    'панель снова угадывает предел вместо того, чтобы прочитать его',
  )
})

test('часы занятия идут от первого сокета, а не от создания комнаты', async () => {
  assert.equal(liveSince(ROOM), null, 'в пустой комнате занятие «идёт»')

  const opened = Date.now()
  const first = seat()
  handleCollabSocket(first.ws, ROOM, 'participant', 'p_first')
  const started = liveSince(ROOM)
  assert.ok(started !== null && Math.abs(started - opened) < 5_000)

  // Второй пришедший часов не переводит: занятие идёт с первого.
  const second = seat()
  handleCollabSocket(second.ws, ROOM, 'participant', 'p_second')
  assert.equal(liveSince(ROOM), started, 'опоздавший переставил начало пары на себя')

  const res = await fetch(`${base}/api/admin/seminars`, { headers: { cookie } })
  const rows = (await res.json()) as AdminSeminar[]
  const row = rows.find((one) => one.id === ROOM)
  assert.ok(row)
  assert.equal(row.liveSince, started, 'часы занятия до панели не доехали')
  assert.notEqual(row.liveSince, row.createdAt, 'снова часы комнаты вместо часов пары')

  first.close()
  second.close()
  // Комната опустела — часов больше нет: перерыв между парами ничем другим от
  // конца занятия не отличается.
  assert.equal(liveSince(ROOM), null)
})
