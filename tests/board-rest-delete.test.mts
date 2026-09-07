/**
 * Документ убрали — общий экран обязан погаснуть, какой бы дверью его ни убрали.
 *
 * Дверей две: сокет комнаты (`tree:remove`) и REST панели файлов
 * (`DELETE /api/sessions/:id/file`). Первая гасила доску, вторая — нет: PDF,
 * удалённый из панели, оставался на общем экране у всей комнаты и на проекторе
 * до перезагрузки страницы. Пустая область без единого слова — и никто не может
 * понять, почему.
 *
 * Клиентская страховка это больше не ловит и не должна: она считает пропажу
 * доказанной только на ПОЛНОМ списке файлов (web/src/lib/board.ts), потому что
 * обрезанный список — не доказательство, что файла нет, и по нему доска гасла
 * у всего зала посреди лекции.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import type { ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'
import { signToken } from '../server/src/auth.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { boardOf, closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { makeFile } from '../server/src/workspace.js'
import { fileRoutes } from '../server/src/routes/files.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'

const ROOM = 'board-rest'
const HOST: TokenPayload = { sessionId: ROOM, participantId: 'p_teacher', role: 'host' }
let base = ''
let server: http.Server

/** Ровно то, что читает `send` управляющего сокета. */
function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => heard.push(JSON.parse(frame) as ControlServerMessage),
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping: () => {},
    terminate: () => {},
    close: () => {
      for (const fn of handlers.get('close') ?? []) fn()
    },
  } as unknown as WebSocket
  return { ws, heard }
}

before(async () => {
  createSession(ROOM, 'Лекция с документом', null)
  // Ведущий по токену: `roleFor` спрашивает про это на каждом запросе, и без
  // строки в базе REST-дверь ответила бы «файл убирает преподаватель».
  upsertParticipant({
    id: 'p_teacher',
    sessionId: ROOM,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  makeFile(ROOM, 'lecture.pdf', '%PDF-1.4')

  const app = express()
  app.use(express.json())
  app.use(sessionRoutes())
  app.use(fileRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  closeControlRoom(ROOM)
  server?.close()
  shutdownCollab()
})

test('удаление файла через панель гасит общий экран у всей комнаты', async () => {
  const seat = socket()
  handleControlSocket(seat.ws, ROOM, HOST)
  dispatch(seat.ws, ROOM, HOST, { t: 'board:open', name: 'lecture.pdf' })
  assert.equal(boardOf(ROOM), 'lecture.pdf', 'документ не встал на общий экран — проверять нечего')

  seat.heard.length = 0
  const res = await fetch(`${base}/api/sessions/${ROOM}/file?path=lecture.pdf`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${signToken(HOST)}` },
  })
  assert.equal(res.status, 200)

  assert.equal(boardOf(ROOM), null, 'удалённый документ остался на общем экране')
  const told = seat.heard.filter((frame) => frame.t === 'board').at(-1)
  assert.deepEqual(told, { t: 'board', open: null }, 'комнате не сказали, что экран погас')
})
