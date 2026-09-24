/**
 * The oracle from the press to the entry in the notebook — the whole path, not
 * just the response status.
 *
 * Two tests in the suite sent POST `ai/ask` and looked at 202/403/429; beyond
 * that lay darkness. Break `settle` — not set the `done` state, not pull the
 * proposal out of the last block, not write "(stopped)" — and the suite stayed
 * green, although not a single answer appeared in the room. What is checked
 * here is what the class sees: the entry in the shared document, its text, its
 * state and the proposal under the cell.
 *
 * The gateway is fake, the room is real, the document is real: exactly one
 * layer is faked — the one behind which someone else's model lives.
 */
import './_env.mts'
import { after, test } from 'node:test'
import { tr } from '../shared/i18n.js'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { getChat, createCell, getCells, chatAnswer, createChatEntry } from '@shared/notebook'
import type { ChatState } from '@shared/notebook'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { recordQuestion } from '../server/src/admin/usage.js'
import { signToken } from '../server/src/auth.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { recentTurns } from '../server/src/ai/index.js'
import { aiRoutes, roomQuestionCeiling } from '../server/src/routes/ai.js'

after(() => shutdownCollab())

/* ---------------------------------------------------------------- fakes */

interface Gateway {
  base: string
  /** Request bodies exactly as they were sent: they show what went to the endpoint. */
  seen: Record<string, unknown>[]
  /** Release the held responses. */
  release: () => void
  close: () => Promise<void>
}

/**
 * An OpenAI-compatible gateway the test controls.
 *
 * `answer` is what to send in one SSE frame. `refuse` decides which bodies get
 * a 400 (that is how the "bare" retry is checked). `hold` means not answering
 * at all until released: that is how concurrent streams are kept open.
 */
async function gateway(options: {
  answer?: string
  refuse?: (body: Record<string, unknown>) => boolean
  hold?: boolean
}): Promise<Gateway> {
  const seen: Record<string, unknown>[] = []
  const waiting: express.Response[] = []
  // A 202 app response can arrive before its outbound model request reaches this fixture.
  let released = false
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.post('/v1/chat/completions', (req, res) => {
    const body = req.body as Record<string, unknown>
    seen.push(body)
    if (options.refuse?.(body)) {
      res.status(400).json({ error: { message: 'unknown field' } })
      return
    }
    res.setHeader('content-type', 'text/event-stream')
    if (options.hold && !released) {
      waiting.push(res)
      return
    }
    if (options.answer) {
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: options.answer } }] })}\n\n`,
      )
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const server = http.createServer(app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  updateOracleSettings({
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'test-model',
    apiKey: 'test-key',
    questionsPerHour: 20,
    slowModeSeconds: 0,
  })
  return {
    base: `http://127.0.0.1:${port}/v1`,
    seen,
    release: () => {
      released = true
      for (const held of waiting.splice(0)) {
        held.write('data: [DONE]\n\n')
        held.end()
      }
    },
    close: async () => {
      released = true
      for (const held of waiting.splice(0)) held.end()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

let seq = 0

interface Room {
  id: string
  cellId: string
  teacher: string
  student: string
  base: string
  close: () => void
}

async function room(): Promise<Room> {
  const id = `oracle-flow-${++seq}`
  createSession(id, 'Оракул', null)
  const teacher = `p_teacher_${seq}`
  const student = `p_student_${seq}`
  upsertParticipant({
    id: teacher,
    sessionId: id,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  upsertParticipant({
    id: student,
    sessionId: id,
    name: 'Петя',
    avatar: null,
    role: 'participant',
    tokenHost: false,
  })
  const cellId = `c_task_${seq}`
  const { doc } = getSessionDoc(id)
  doc.transact(() => {
    getCells(doc).push([createCell('code', 'total = sum(xs)', cellId)])
  })
  const app = express()
  // The same body ceiling as the real server: the count of "how much junk one
  // question can carry" rests on it.
  app.use(express.json({ limit: '1mb' }))
  app.use(aiRoutes())
  const server = http.createServer(app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  return {
    id,
    cellId,
    teacher,
    student,
    base: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  }
}

function ask(r: Room, who: string, body: unknown): Promise<Response> {
  const token = signToken({ sessionId: r.id, participantId: who, role: 'participant', iat: Date.now() - 3 * 60_000 })
  return fetch(`${r.base}/api/sessions/${r.id}/ai/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** A thread entry by id: what the whole room sees. */
function entryOf(r: Room, entryId: string) {
  const chat = getChat(getSessionDoc(r.id).doc)
  for (let i = 0; i < chat.length; i++) {
    const entry = chat.get(i)
    if (entry.get('id') === entryId) return entry
  }
  return null
}

/** Wait until the answer stops being written. */
async function settled(r: Room, entryId: string) {
  for (let i = 0; i < 300; i++) {
    const entry = entryOf(r, entryId)
    if (entry && (entry.get('state') as ChatState) !== 'streaming') return entry
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('the answer never finished')
}

/* ------------------------------------------------------- the whole path */

test('a question reaches the document: the answer, the state and the proposal under the cell', async () => {
  const gate = await gateway({
    answer:
      'Складывать надо после проверки на пустоту.\n\n```python\ntotal = sum(xs) if xs else 0\n```',
  })
  const r = await room()
  try {
    const res = await ask(r, r.student, {
      message: 'почини',
      action: 'edit',
      cellId: r.cellId,
      cellIds: [r.cellId],
    })
    assert.equal(res.status, 202)
    const { entryId } = (await res.json()) as { entryId: string }
    assert.ok(entryId, 'the route did not name the entry')

    // The question is visible in the same second, before any answer: that is the
    // whole point of the 202 — the room watches the answer fill in instead of
    // waiting on someone else's HTTP.
    const asked = entryOf(r, entryId)
    assert.equal(asked?.get('question'), 'почини')
    assert.equal(asked?.get('name'), 'Петя')

    const entry = await settled(r, entryId)
    assert.equal(entry!.get('state'), 'done')
    assert.match(chatAnswer(entry!).toString(), /после проверки на пустоту/)
    // The proposal is extracted at the end and only for an `edit` turn: half a
    // block is not a patch but a cell offering to break itself.
    assert.equal(entry!.get('patch'), 'total = sum(xs) if xs else 0')
    assert.equal(entry!.get('patchBase'), 'total = sum(xs)')
  } finally {
    r.close()
    await gate.close()
  }
})

test('"Stop" puts "(stopped)" on the entry, not emptiness', async () => {
  const gate = await gateway({ hold: true })
  const r = await room()
  try {
    const res = await ask(r, r.student, { message: 'долгий вопрос' })
    const { entryId } = (await res.json()) as { entryId: string }

    const token = signToken({ sessionId: r.id, participantId: r.student, role: 'participant', iat: Date.now() - 3 * 60_000 })
    const stop = await fetch(`${r.base}/api/sessions/${r.id}/ai/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ entryId }),
    })
    assert.equal(stop.status, 200)

    const entry = await settled(r, entryId)
    assert.equal(entry!.get('state'), 'done')
    assert.equal(chatAnswer(entry!).toString(), tr('server.aiStopped'))
  } finally {
    r.close()
    gate.release()
    await gate.close()
  }
})

test('an empty model answer does not advise the room to fix an environment variable', async () => {
  const gate = await gateway({ answer: '' })
  const r = await room()
  try {
    const res = await ask(r, r.student, { message: 'что тут' })
    const { entryId } = (await res.json()) as { entryId: string }
    const entry = await settled(r, entryId)
    assert.equal(entry!.get('state'), 'error')
    const said = chatAnswer(entry!).toString()
    // Students read this text: they cannot see the environment variable, and the
    // panel is not their door. The same split as for the key refusal in routes/ai.ts.
    assert.doesNotMatch(said, /OPENAI_MODEL/)
    assert.match(said, /владельца Colloq/i)
  } finally {
    r.close()
    await gate.close()
  }
})

test('a gateway that does not know stream_options gets a second attempt without it', async () => {
  const gate = await gateway({
    answer: 'Ответ есть.',
    refuse: (body) => 'stream_options' in body,
  })
  const r = await room()
  try {
    const res = await ask(r, r.student, { message: 'вопрос' })
    const { entryId } = (await res.json()) as { entryId: string }
    const entry = await settled(r, entryId)
    /*
     * The comment above `usage` in provider.ts promised exactly this: whoever does
     * not understand the field answers 400, and the bare attempt kicks in. It was
     * not bare — `stream_options` went into both — so on such a gateway the oracle
     * did not work at all, and the room read "rejected the request … stream_options".
     */
    assert.equal(entry!.get('state'), 'done', chatAnswer(entry!).toString())
    assert.match(chatAnswer(entry!).toString(), /Ответ есть/)
    assert.equal(gate.seen.length, 2, 'there was no retry')
    assert.ok('stream_options' in gate.seen[0])
    assert.ok(!('stream_options' in gate.seen[1]), 'the bare attempt carries stream_options again')
  } finally {
    r.close()
    await gate.close()
  }
})

/* --------------------------------------------------------------- ceilings */

test('no more than a dozen concurrent answers in a room', async () => {
  const gate = await gateway({ hold: true })
  const r = await room()
  try {
    for (let i = 0; i < 12; i++) {
      const res = await ask(r, r.student, { message: `вопрос ${i}` })
      assert.equal(res.status, 202, `refused on question ${i}`)
    }
    /*
     * The thirteenth is a wait, not an error: at the teacher's "ask the oracle"
     * two hundred people press at once, and without this ceiling the room sends
     * hundreds of thousands of frames a second over five hundred sockets, misses
     * pings and falls apart — precisely with the largest audience.
     */
    const refused = await ask(r, r.student, { message: 'тринадцатый' })
    assert.equal(refused.status, 429)
    const body = (await refused.json()) as { error: string; retryAfter?: number }
    assert.match(body.error, /выполняется 12 запросов/)
    assert.ok((body.retryAfter ?? 0) > 0, 'the panel would draw this as a red error instead of a countdown')
    assert.equal(refused.headers.get('retry-after'), String(body.retryAfter))
  } finally {
    r.close()
    gate.release()
    await gate.close()
  }
})

test('the hourly room ceiling scales with its size and promises no control the teacher lacks', async () => {
  const gate = await gateway({ answer: 'ответ' })
  const r = await room()
  try {
    // An empty room gets the former thirty personal limits: a small room gets
    // exactly as much as it used to.
    assert.equal(roomQuestionCeiling(r.id, 20), 600)

    /*
     * And now the room holds a whole cohort. Presence is the same one the room
     * draws people from; the participants table will not do, it remembers
     * everyone who came in over all the classes of this seminar.
     */
    const { awareness } = getSessionDoc(r.id)
    const states = awareness.getStates()
    for (let i = 0; i < 500; i++) states.set(1_000 + i, { user: { id: `p_hall_${i}` } })
    assert.equal(
      roomQuestionCeiling(r.id, 20),
      5_000,
      'a hall of 500 people lives by the measure of a hall of 30',
    )
    for (let i = 0; i < 500; i++) states.delete(1_000 + i)

    // The refusal wording. The old one promised "ask the teacher, they will raise
    // the limit in the panel" — a control the teacher does not have.
    updateOracleSettings({ questionsPerHour: 1 })
    for (let i = 0; i < 30; i++) {
      recordQuestion({ sessionId: r.id, participantId: `p_ghost_${i}`, action: 'ask' })
    }
    const refused = await ask(r, r.student, { message: 'ещё один' })
    assert.equal(refused.status, 429)
    const body = (await refused.json()) as { error: string }
    assert.match(body.error, /все 30 вопросов оракулу за час/)
    assert.doesNotMatch(body.error, /raise the limit in the panel/)
    assert.match(body.error, /Повторите позже/i)
  } finally {
    updateOracleSettings({ questionsPerHour: 20 })
    r.close()
    await gate.close()
  }
})

test('cell names do not smuggle megabytes of junk into the shared document', async () => {
  const gate = await gateway({ answer: 'ответ' })
  const r = await room()
  try {
    const junk = 'z'.repeat(50_000)
    const res = await ask(r, r.student, {
      message: 'вопрос',
      cellId: junk,
      cellIds: [junk, junk, r.cellId],
    })
    assert.equal(res.status, 202)
    const { entryId } = (await res.json()) as { entryId: string }
    const entry = entryOf(r, entryId)
    // They are dropped, not cut: a cell name is a key, and a truncated key is no
    // longer the one asked for.
    assert.equal(entry!.get('cellId'), null)
    assert.deepEqual((entry!.get('cellIds') as string[]) ?? [], [r.cellId])
    await settled(r, entryId)
  } finally {
    r.close()
    await gate.close()
  }
})

/* --------------------------------------------------------------- history */

test('only completed turns go into the history, as pairs of lines, not two questions in a row', () => {
  const id = `oracle-history-${++seq}`
  createSession(id, 'История', null)
  const { doc } = getSessionDoc(id)
  const chat = getChat(doc)

  const add = (name: string, question: string, answer: string, state: ChatState) => {
    const entry = createChatEntry({ participantId: `p_${name}`, name, color: '#888', question })
    doc.transact(() => chat.push([entry]))
    if (answer) doc.transact(() => chatAnswer(entry).insert(0, answer))
    doc.transact(() => entry.set('state', state))
  }

  add('Аня', 'первый', 'первый ответ', 'done')
  add('Боря', 'упал', 'The AI endpoint rejected the API key', 'error')
  add('Вера', 'остановили', '(stopped)', 'done')
  add('Гоша', 'ещё пишется', '', 'streaming')
  add('Дима', 'второй', 'второй ответ', 'done')

  const turns = recentTurns(doc)
  /*
   * The roles have to alternate: strict chat templates (vLLM with Mistral or
   * Llama-2) answer two user turns in a row with a 400 — "Conversation roles
   * must alternate" — and the free retry sends the same history and gets the
   * same 400. In a big room two questions a minute is normal, so every other
   * question would fail.
   */
  assert.deepEqual(
    turns.map((turn) => turn.role),
    ['user', 'assistant', 'user', 'assistant'],
  )
  assert.match(turns[0].content, /Аня asked: первый/)
  assert.equal(turns[1].content, 'первый ответ')
  assert.match(turns[2].content, /Дима asked: второй/)
  assert.equal(turns[3].content, 'второй ответ')
})
