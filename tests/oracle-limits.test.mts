/**
 * Предел вопросов к оракулу — единственное, что стоит между чужим ключом и
 * чьим-то счётом. Личный предел обходится перезаходом: имя в комнате ничем не
 * подтверждено, и новая вкладка инкогнито — это новый участник со свежими N
 * вопросами. Поэтому есть второй потолок, на всю комнату; проверяется он, а
 * не личный, потому что дыра была именно здесь.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import {
  countRecentQuestions,
  countRoomQuestions,
  noteTokens,
  recordQuestion,
} from '../server/src/admin/usage.js'
import { signToken } from '../server/src/auth.js'
import { createSession, db, getRules, setRules } from '../server/src/db.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { aiRoutes } from '../server/src/routes/ai.js'

const HOUR = 60 * 60 * 1000

test('перезаход обнуляет личный счёт и не обнуляет комнатный', () => {
  const room = 'limits-room'

  // Один человек задал три вопроса.
  for (let i = 0; i < 3; i++) {
    recordQuestion({ sessionId: room, participantId: 'p_one', action: 'ask' })
  }
  assert.equal(countRecentQuestions(room, 'p_one', HOUR), 3)
  assert.equal(countRoomQuestions(room, HOUR), 3)

  // Он же перезашёл: новая вкладка — новый participantId, личный счёт пуст.
  assert.equal(countRecentQuestions(room, 'p_one_again', HOUR), 0)
  recordQuestion({ sessionId: room, participantId: 'p_one_again', action: 'ask' })

  // А комната помнит всё, что в ней спросили, кем бы он ни назвался.
  assert.equal(countRoomQuestions(room, HOUR), 4)
})

test('счёт одной комнаты не течёт в другую', () => {
  const a = 'limits-a'
  const b = 'limits-b'
  recordQuestion({ sessionId: a, participantId: 'p_x', action: 'ask' })
  recordQuestion({ sessionId: a, participantId: 'p_y', action: 'ask' })
  assert.equal(countRoomQuestions(a, HOUR), 2)
  assert.equal(countRoomQuestions(b, HOUR), 0)
})

test('комнатный счёт считает всех, включая тех, кто больше не вернётся', () => {
  const room = 'limits-crowd'
  for (const who of ['p_a', 'p_b', 'p_c', 'p_d']) {
    recordQuestion({ sessionId: room, participantId: who, action: 'ask' })
  }
  // Ровно то, чем этот потолок отличается от личного: он не про человека.
  assert.equal(countRoomQuestions(room, HOUR), 4)
  for (const who of ['p_a', 'p_b', 'p_c', 'p_d']) {
    assert.equal(countRecentQuestions(room, who, HOUR), 1)
  }
})

/* ------------------------------------------------- сам отказ, а не счётчики */

/**
 * Три теста выше проверяют счёт, а дыру закрыл маршрут — и его можно было
 * удалить целиком, не уронив ни одного из них. Ниже спрашивают так, как
 * спрашивает панель: через HTTP, с токеном комнаты.
 */
const app = express()
app.use(express.json())
app.use(aiRoutes())
let base = ''
let server: http.Server

before(async () => {
  // Оракул должен быть настроен, иначе маршрут отвечает 503 до потолков.
  updateOracleSettings({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:1/v1',
  })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  updateOracleSettings({ questionsPerHour: 20 })
})

function askAs(
  room: string,
  participantId: string,
  options: { mode?: 'agent' } = {},
): Promise<Response> {
  const token = signToken({ sessionId: room, participantId, role: 'participant' })
  return fetch(`${base}/api/sessions/${room}/ai/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'почему тут падает?', mode: options.mode }),
  })
}

test('комната упирается в свой потолок, даже когда каждый спрашивает под своим именем', async () => {
  const room = 'limits-route-room'
  createSession(room, 'Room ceiling', null)
  updateOracleSettings({ questionsPerHour: 1 })

  // Тридцать личных пределов — по одному вопросу от тридцати «новых» вкладок.
  for (let i = 0; i < 30; i++) {
    recordQuestion({ sessionId: room, participantId: `p_tab_${i}`, action: 'ask' })
  }

  // Спрашивает тот, у кого личный счёт пуст: отказать может только комнатный.
  const res = await askAs(room, 'p_fresh')
  assert.equal(res.status, 429)
  assert.equal(res.headers.get('retry-after'), '600')
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /seminar has used all 30/)
})

test('личный потолок говорит, через сколько можно снова', async () => {
  const room = 'limits-route-person'
  createSession(room, 'Personal ceiling', null)
  updateOracleSettings({ questionsPerHour: 2 })
  recordQuestion({ sessionId: room, participantId: 'p_ada', action: 'ask' })
  recordQuestion({ sessionId: room, participantId: 'p_ada', action: 'ask' })

  const res = await askAs(room, 'p_ada')
  assert.equal(res.status, 429)
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /used all 2 of your oracle questions/)
  // Окно скользит: срок берётся из windowResetAt, а не из «начала следующего часа».
  assert.match(body.error, /again in 60 minutes/)
  assert.ok(Number(res.headers.get('retry-after')) > 0)
})

/**
 * Вопрос и поручение — разные строки в разбивке панели.
 *
 * Пока ход «сделать» писался под тем же 'ask', самый дорогой режим был в
 * таблице неотличим от «объясни»: один ход ходит к модели до двенадцати раз и
 * тащит с собой файлы. Владелец ключа видел ровный столбик вопросов там, где
 * полсеместра стоила пара поручений.
 */
test('ход «сделать» пишется в учёт своим действием, а вопрос — своим', async () => {
  const room = 'limits-work-action'
  createSession(room, 'Agent action', null)
  updateOracleSettings({ questionsPerHour: 20 })

  // Комната с `agent: 'room'` — та, где просить о правках может любой. Право
  // преподавателя даёт кука штата, а её через HTTP здесь ни у кого нет.
  setRules(room, { ...getRules(room), agent: 'room' })

  assert.equal((await askAs(room, 'p_ada')).status, 202)
  assert.equal((await askAs(room, 'p_ada', { mode: 'agent' })).status, 202)

  const rows = db
    .prepare('SELECT action FROM ai_usage WHERE session_id = ? ORDER BY id')
    .all(room) as { action: string }[]
  assert.deepEqual(
    rows.map((row) => row.action),
    ['ask', 'work'],
  )
})

/**
 * Расход хода складывается, а не перезаписывается: строка одна на вопрос, а
 * режим «сделать» ходит к модели до двенадцати раз. Пока считался последний
 * шаг, самый дорогой режим выглядел в панели самым дешёвым.
 */
test('токены за один вопрос складываются по шагам', () => {
  const room = 'limits-tokens'
  const id = recordQuestion({ sessionId: room, participantId: 'p_ada', action: 'ask' })
  noteTokens(id, 900)
  noteTokens(id, 1_200)
  const spent = db.prepare('SELECT tokens AS n FROM ai_usage WHERE id = ?').get(id) as {
    n: number | null
  }
  assert.equal(spent.n, 2_100)
})
