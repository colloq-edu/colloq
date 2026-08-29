/**
 * Пульт, переданный на планшет.
 *
 * Ссылка, по которой чужое устройство входит в комнату ВАМИ, — самая опасная
 * строка в продукте: она короче пароля, живёт в адресной строке и попадает на
 * снимок экрана. Здесь проверяется ровно то, из-за чего её вообще можно было
 * заводить: ключ живёт минуты, годится только на обмен и не годится ни на что
 * другое, а выдать его может только тот, кто уже ведущий.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  signHandoffToken,
  signToken,
  verifyHandoffToken,
  verifyToken,
} from '../server/src/auth.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'
import type { HandoffResponse, JoinResponse } from '../shared/protocol.js'

const ROOM = 'handoff-test'
const OTHER = 'handoff-other'
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Пульт', null)
  createSession(OTHER, 'Соседняя', null)
  upsertParticipant({
    id: 'p_teacher',
    sessionId: ROOM,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  upsertParticipant({
    id: 'p_student',
    sessionId: ROOM,
    name: 'Нина',
    avatar: null,
    role: 'participant',
  })

  const app = express()
  app.use(express.json())
  app.use(sessionRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

after(() => server?.close())

const asHost = () => signToken({ sessionId: ROOM, participantId: 'p_teacher', role: 'host' })
const asStudent = () =>
  signToken({ sessionId: ROOM, participantId: 'p_student', role: 'participant' })

function handoff(token: string | null, room = ROOM): Promise<Response> {
  return fetch(`${base}/api/sessions/${room}/handoff`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: '{}',
  })
}

function claim(key: unknown, room = ROOM): Promise<Response> {
  return fetch(`${base}/api/sessions/${room}/handoff/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  })
}

test('ведущий получает ключ, планшет меняет его на тот же вход', async () => {
  const made = await handoff(asHost())
  assert.equal(made.status, 200)
  const { key, livesMs } = (await made.json()) as HandoffResponse
  assert.ok(livesMs > 0 && livesMs <= 30 * 60_000, 'ключ живёт минуты, а не сутки')

  const claimed = await claim(key)
  assert.equal(claimed.status, 200)
  const body = (await claimed.json()) as JoinResponse
  // Тот же человек, а не второй с тем же именем: иначе в списке комнаты два
  // преподавателя, и лекцию ведёт не тот.
  assert.equal(body.participant.id, 'p_teacher')
  assert.equal(body.participant.name, 'Ада')
  assert.equal(body.participant.role, 'host')
  // И права переезжают: на планшете куки нет, а ведущим он остаётся.
  assert.equal(verifyToken(body.token)?.role, 'host')
})

test('студент пульт не отдаёт', async () => {
  const denied = await handoff(asStudent())
  assert.equal(denied.status, 403)
})

test('без токена ключ не выдаётся вовсе', async () => {
  assert.equal((await handoff(null)).status, 401)
})

test('токен чужой комнаты сюда не пускает', async () => {
  const stranger = signToken({ sessionId: OTHER, participantId: 'p_teacher', role: 'host' })
  assert.equal((await handoff(stranger)).status, 401)
})

test('ключ не годится как токен: им нельзя открыть ни одну дверь', async () => {
  const { key } = (await (await handoff(asHost())).json()) as HandoffResponse
  // Самое важное свойство: ключ на обмен — не удостоверение. Подставленный
  // вместо токена, он не должен открывать ничего, включая выдачу новых ключей.
  assert.equal(verifyToken(key), null)
  assert.equal((await handoff(key)).status, 401)
})

test('протухший ключ отвергается', () => {
  const key = signHandoffToken(ROOM, 'p_teacher')
  const [who, , sig] = key.split('.')
  const expired = `${who}.${(Date.now() - 1000).toString(36)}.${sig}`
  assert.equal(verifyHandoffToken(ROOM, expired), null)
})

test('ключ одной комнаты не открывает другую', async () => {
  const { key } = (await (await handoff(asHost())).json()) as HandoffResponse
  assert.equal(verifyHandoffToken(OTHER, key), null)
  assert.equal((await claim(key, OTHER)).status, 401)
})

test('подпись покрывает и имя, и срок', () => {
  const key = signHandoffToken(ROOM, 'p_teacher')
  const [who, until, sig] = key.split('.')
  const someoneElse = Buffer.from('p_student').toString('base64url')
  assert.equal(verifyHandoffToken(ROOM, `${someoneElse}.${until}.${sig}`), null)
  const later = (Date.now() + 60 * 60_000).toString(36)
  assert.equal(verifyHandoffToken(ROOM, `${who}.${later}.${sig}`), null)
  assert.equal(verifyHandoffToken(ROOM, key), 'p_teacher')
})

test('мусор вместо ключа не роняет обмен', async () => {
  for (const bad of ['', 'a.b', 'a.b.c', null, 42, { key: 1 }]) {
    const res = await claim(bad)
    assert.equal(res.status, 401, JSON.stringify(bad))
  }
})
