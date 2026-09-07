/**
 * «Комнаты нет» — теми же словами на каждой двери оракула.
 *
 * По этой строке клиент делает необратимое: стирает базу y-indexeddb комнаты
 * вместе с набранным офлайн и пишет «Этот семинар удалён» (shared/protocol.ts ·
 * saysSessionMissing). Голого 404 для этого мало — его отдаёт и ретранслятор
 * без подключённого frpc, — так что решение принимается ПО СЛОВАМ, и разойдись
 * они хоть на одной двери, удалённая комната перестала бы узнаваться и вкладка
 * крутила бы «Reconnecting» до конца пары.
 *
 * Здесь двери оракула: вопрос, «Стоп», очистка ленты и оракул о решениях.
 * Соседние двери комнаты (файлы, история, баны, курсы) — у routes/sessions.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { SESSION_MISSING, saysSessionMissing } from '../shared/protocol.js'
import { ApiError } from '../web/src/lib/api.js'
import { signToken } from '../server/src/auth.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { aiRoutes } from '../server/src/routes/ai.js'
import { councilRoutes } from '../server/src/routes/council.js'

after(() => shutdownCollab())

const app = express()
app.use(express.json())
app.use(aiRoutes())
app.use(councilRoutes({ attemptsOf: () => [], oracleOf: () => null, setOracle: () => {} }))

const server = http.createServer(app)
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
after(() => server.close())
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

/** Семинара с таким именем нет и не было — токен подписан, дверь настоящая. */
const GONE = 'session-that-never-was'
const token = signToken({ sessionId: GONE, participantId: 'p_ada', role: 'participant' })

async function door(method: string, path: string): Promise<void> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify({ question: 'что тут?', entryId: 'e1' }) : undefined,
  })
  assert.equal(res.status, 404, `${method} ${path}`)
  const body = (await res.json()) as { error?: string }
  assert.equal(body.error, SESSION_MISSING, `${method} ${path}`)
  // И то же самое глазами клиента — той функцией, что решает стирать кэш.
  assert.equal(saysSessionMissing(new ApiError(body.error ?? '', res.status)), true, path)
}

test('вопрос оракулу в удалённой комнате отвечает словами, а не голым кодом', async () => {
  await door('POST', `/api/sessions/${GONE}/ai/ask`)
})

test('«Стоп» и очистка ленты — теми же словами', async () => {
  await door('POST', `/api/sessions/${GONE}/ai/cancel`)
  await door('DELETE', `/api/sessions/${GONE}/ai/thread`)
})

test('оракул о решениях — теми же словами на обеих ручках', async () => {
  await door('POST', `/api/sessions/${GONE}/council/c1/oracle`)
  await door('DELETE', `/api/sessions/${GONE}/council/c1/oracle`)
})
