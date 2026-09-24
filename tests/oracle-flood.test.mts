/**
 * Protecting the oracle from a script (13 Sep 2026, an open class): five hundred
 * "participants" came from one address in two hours, one question each, and
 * the slow mode, which counts per person, did not notice them. Three rules: a
 * newcomer waits two minutes, an address is limited across all its names at
 * once, joining a room is limited per address — and one request from the
 * teacher removes the entries of a hundred names from the thread.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { signToken } from '../server/src/auth.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { createChatEntry, getChat } from '../shared/notebook.js'
import { app } from '../server/src/app.js'

let base = ''
let server: http.Server

before(async () => {
  updateOracleSettings({ apiKey: 'test-key', model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', questionsPerHour: 100, slowModeSeconds: 0 })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  updateOracleSettings({ questionsPerHour: 20, slowModeSeconds: 0 })
})

const OLD = () => Date.now() - 3 * 60_000

function ask(room: string, participantId: string, iat: number, address: string): Promise<Response> {
  const token = signToken({ sessionId: room, participantId, role: 'participant', iat })
  return fetch(`${base}/api/sessions/${room}/ai/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-forwarded-for': address },
    body: JSON.stringify({ message: 'что такое DataFrame?' }),
  })
}

test('a newcomer does not ask: a question with a freshly issued token waits', async () => {
  const room = 'flood-new'
  createSession(room, 'Новички', null)
  upsertParticipant({ id: 'p_fresh', sessionId: room, name: 'Свежий', avatar: null, role: 'participant' })
  const fresh = await ask(room, 'p_fresh', Date.now(), '10.0.0.1')
  assert.equal(fresh.status, 429, await fresh.clone().text())
  const body = (await fresh.json()) as { error: string; retryAfter: number }
  assert.match(body.error, /пару минут/)
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 120)
  assert.ok(fresh.headers.get('retry-after'))
  // The same person with an older token gets through this door.
  const settled = await ask(room, 'p_fresh', OLD(), '10.0.0.1')
  assert.notEqual(settled.status, 429)
})

test('an address is limited across all names at once: the twenty-first name within a minute waits', async () => {
  const room = 'flood-addr'
  createSession(room, 'Адрес', null)
  for (let i = 0; i < 20; i++) {
    upsertParticipant({ id: `p_a${i}`, sessionId: room, name: `User${i}`, avatar: null, role: 'participant' })
    // The room queue (a dozen in flight) may refuse earlier — that is not the address.
    const res = await ask(room, `p_a${i}`, OLD(), '10.0.0.7')
    assert.doesNotMatch(await res.text(), /адреса/, `question ${i} was turned away by address too early`)
  }
  upsertParticipant({ id: 'p_a20', sessionId: room, name: 'User20', avatar: null, role: 'participant' })
  const extra = await ask(room, 'p_a20', OLD(), '10.0.0.7')
  assert.equal(extra.status, 429)
  assert.match(((await extra.json()) as { error: string }).error, /адреса/)
  // A neighbouring address in the same minute is free.
  upsertParticipant({ id: 'p_b0', sessionId: room, name: 'Другой', avatar: null, role: 'participant' })
  // A neighbouring address in the same minute does not hit the address limit (it
  // may hit the room queue: the questions above are still waiting for the model).
  const other = await ask(room, 'p_b0', OLD(), '10.0.0.8')
  assert.doesNotMatch(await other.text(), /адреса/)
})

test('the teacher removes the entries of a hundred names in one request, the others stay', async () => {
  const room = 'flood-prune'
  createSession(room, 'Чистка', null)
  // The server takes the host role from the database (token_host), not from the token signature.
  upsertParticipant({ id: 'p_host', sessionId: room, name: 'Преподаватель', avatar: null, role: 'host', tokenHost: true })
  const { doc } = getSessionDoc(room)
  const chat = getChat(doc)
  const bots: string[] = []
  doc.transact(() => {
    chat.push([createChatEntry({ participantId: 'p_real', name: 'Маша', color: '#000', question: 'а почему так?' })])
    for (let i = 0; i < 120; i++) {
      bots.push(`p_bot${i}`)
      chat.push([createChatEntry({ participantId: `p_bot${i}`, name: `UserX${i}`, color: '#000', question: 'ААААААААА' })])
    }
    chat.push([createChatEntry({ participantId: 'p_real2', name: 'Петя', color: '#000', question: 'и это тоже' })])
  })
  const token = signToken({ sessionId: room, participantId: 'p_host', role: 'host' })
  const res = await fetch(`${base}/api/sessions/${room}/ai/thread`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ participantIds: bots }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.deepEqual(await res.json(), { ok: true, removed: 120 })
  assert.equal(chat.length, 2)
  assert.deepEqual(chat.toArray().map((e) => e.get('name')), ['Маша', 'Петя'])
  // Without a list, the old behaviour: the whole thread.
  const all = await fetch(`${base}/api/sessions/${room}/ai/thread`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
  assert.equal(all.status, 200)
  assert.equal(chat.length, 0)
})

test('joining a room is limited per address: the sixty-first newcomer from one address waits', async () => {
  const room = 'flood-join'
  createSession(room, 'Входы', null)
  const join = (i: number, address: string) =>
    fetch(`${base}/api/sessions/${room}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
      body: JSON.stringify({ name: `Гость ${i}` }),
    })
  for (let i = 0; i < 60; i++) assert.equal((await join(i, '10.1.0.1')).status, 200, `join ${i}`)
  assert.equal((await join(60, '10.1.0.1')).status, 429)
  assert.equal((await join(61, '10.1.0.2')).status, 200)
})
