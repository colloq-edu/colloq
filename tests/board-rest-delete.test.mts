/**
 * The document was removed, so the shared screen must go dark, whichever
 * door it was removed through.
 *
 * There are two doors: the room socket (`tree:remove`) and the files panel
 * REST (`DELETE /api/sessions/:id/file`). The first turned the board off,
 * the second did not: a PDF deleted from the panel stayed on the shared
 * screen for the whole room and on the projector until the page was
 * reloaded. An empty area without a single word, and nobody can understand
 * why.
 *
 * The client-side safety net no longer catches this and must not: it
 * considers a disappearance proven only on the FULL file list
 * (web/src/lib/board.ts), because a truncated list is no proof that the file
 * is gone, and on such a list the board went dark for the whole hall in the
 * middle of a lecture.
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

/** Exactly what the control socket's `send` reads. */
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
  // The host by token: `roleFor` asks about this on every request, and
  // without a database row the REST door would answer "the teacher removes
  // files".
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

test('deleting a file through the panel turns off the shared screen for the whole room', async () => {
  const seat = socket()
  handleControlSocket(seat.ws, ROOM, HOST)
  dispatch(seat.ws, ROOM, HOST, { t: 'board:open', name: 'lecture.pdf' })
  assert.equal(boardOf(ROOM), 'lecture.pdf', 'the document did not go up on the shared screen, so there is nothing to check')

  seat.heard.length = 0
  const res = await fetch(`${base}/api/sessions/${ROOM}/file?path=lecture.pdf`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${signToken(HOST)}` },
  })
  assert.equal(res.status, 200)

  assert.equal(boardOf(ROOM), null, 'the deleted document stayed on the shared screen')
  const told = seat.heard.filter((frame) => frame.t === 'board').at(-1)
  assert.deepEqual(told, { t: 'board', open: null }, 'the room was not told that the screen went dark')
})
