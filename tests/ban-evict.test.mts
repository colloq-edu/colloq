/**
 * Выселение забаненного — по всем проводам сразу.
 *
 * Бан закрывает три двери: тетрадь, пульт и файл. Первые две закрывает
 * `evictBanned` своими руками; третью — файловый сокет редактора — держит
 * другой модуль, и узнаёт он о выселении событием (bans.ts · onEviction).
 * Пока события не было, забаненный студент продолжал печатать в общий
 * `utils.py` до тех пор, пока сам не перезагрузит страницу: закрытие приходило
 * тетради и пульту, а вкладке редактора — нет.
 *
 * Проверяется здесь именно объявление: что оно уходит, что несёт комнату и
 * человека и что упавший слушатель не уносит с собой остальных, — бан уже
 * стоит в базе, и провод, который не закрылся, не повод отменять его.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { onEviction } from '../server/src/bans.js'
import { closeControlRoom, evictBanned, handleControlSocket } from '../server/src/control.js'
import type { ControlServerMessage } from '../shared/protocol.js'

const heardEvictions: { sessionId: string; participantId: string }[] = []
let brokenCalled = 0

// Оба слушателя — на весь файл: подписка живёт столько же, сколько процесс.
onEviction(() => {
  brokenCalled += 1
  throw new Error('этот провод сегодня падает')
})
onEviction((sessionId, participantId) => heardEvictions.push({ sessionId, participantId }))

function socket(): { ws: WebSocket; heard: ControlServerMessage[]; closed: number[] } {
  const heard: ControlServerMessage[] = []
  const closed: number[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      if (typeof frame === 'string') heard.push(JSON.parse(frame) as ControlServerMessage)
    },
    on() {
      return this
    },
    ping() {},
    terminate() {},
    close(code: number) {
      closed.push(code)
      fake.readyState = WebSocket.CLOSED
    },
  }
  return { ws: fake as unknown as WebSocket, heard, closed }
}

test('бан объявляется всем проводам, а упавший слушатель не уносит остальных', () => {
  const id = 'evict-1'
  createSession(id, 'Бан', null)
  upsertParticipant({ id: 'p_petya', sessionId: id, name: 'Петя', avatar: null, role: 'participant' })
  upsertParticipant({ id: 'p_ada', sessionId: id, name: 'Ада', avatar: null, role: 'host' })
  const petya = socket()
  const ada = socket()
  handleControlSocket(petya.ws, id, { sessionId: id, participantId: 'p_petya', role: 'participant' })
  handleControlSocket(ada.ws, id, { sessionId: id, participantId: 'p_ada', role: 'host' })

  const until = Date.now() + 60_000
  evictBanned(id, 'p_petya', until)

  // Кадр — ДО закрытия: иначе вкладка видит обрыв и молча идёт переподключаться.
  const banned = petya.heard.find((m) => m.t === 'banned')
  assert.ok(banned && banned.t === 'banned', 'забаненному не сказали, что произошло')
  assert.equal(banned.until, until)
  assert.deepEqual(petya.closed, [1008], 'пульт забаненного остался открытым')
  assert.deepEqual(ada.closed, [], 'закрыли не того')

  assert.equal(brokenCalled, 1, 'падающего слушателя не позвали')
  assert.deepEqual(
    heardEvictions,
    [{ sessionId: id, participantId: 'p_petya' }],
    'второй провод о выселении не узнал',
  )
  closeControlRoom(id)
})
