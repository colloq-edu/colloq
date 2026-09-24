/**
 * "The room is gone" — in the same words at every Oracle door.
 *
 * On this string the client does something irreversible: it wipes the room's
 * y-indexeddb database together with whatever was typed offline and writes
 * "This seminar has been deleted" (shared/protocol.ts · saysSessionMissing). A
 * bare 404 is not enough for that — the relay also returns one when no frpc is
 * connected — so the decision is made BY THE WORDS, and if they diverged at
 * even one door, a deleted room would no longer be recognized and the tab
 * would spin "Reconnecting" until the end of the class.
 *
 * The doors here are the Oracle's: a question, "Stop", clearing the feed and
 * the Oracle on solutions. The room's neighbouring doors (files, history,
 * bans, courses) belong to routes/sessions.
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

/** No seminar with this name exists or ever did — the token is signed, the door is real. */
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
  // And the same through the client's eyes — with the very function that
  // decides to wipe the cache.
  assert.equal(saysSessionMissing(new ApiError(body.error ?? '', res.status)), true, path)
}

test('a question to the Oracle in a deleted room is answered with words, not a bare code', async () => {
  await door('POST', `/api/sessions/${GONE}/ai/ask`)
})

test('"Stop" and clearing the feed — in the same words', async () => {
  await door('POST', `/api/sessions/${GONE}/ai/cancel`)
  await door('DELETE', `/api/sessions/${GONE}/ai/thread`)
})

test('the Oracle on solutions — the same words on both handlers', async () => {
  await door('POST', `/api/sessions/${GONE}/council/c1/oracle`)
  await door('DELETE', `/api/sessions/${GONE}/council/c1/oracle`)
})
