/**
 * "Rewrite the cell" asks the CELL, not just the room's rule.
 *
 * The `edit` action is the only one that ends in a proposal with an "Apply"
 * button, that is, an edit of the shared notebook. The others (`ask`,
 * `explain`, `fix`, `debug`, `improve`, `hint`) tell about the cell, and in a
 * lecture they are not closed to a student: asking about a locked cell is
 * allowed and encouraged.
 *
 * Two holes are closed here.
 *
 * The lecture. The `edit: host` rule dimmed the "Apply" button — and only it.
 * A participant could ask for the cell to be rewritten: they wrote a phrase,
 * spent a question from the room's hourly limit, got a proposal and ran into
 * their own powerlessness. The question is spent by then, and there is no way
 * to give it back.
 *
 * The council. There the `edit` rule is beside the point: in an open room it
 * lets a participant edit cells, but the shared council cell is an
 * ASSIGNMENT. The lock does not count it as "open" (`open === 'council'`), so
 * the old `mayEditCell` check simply did not notice it: both asking for a
 * rewrite and accepting the proposal took one press — on an assignment for the
 * whole class.
 *
 * The gateway is fake, the room and the document are real — as in
 * oracle-flow.test.mts.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { WebSocket } from 'ws'
import { createCell, getCells, getChat, createChatEntry, findCell } from '@shared/notebook'
import { LECTURE_ROOM, OPEN_ROOM } from '../shared/rules.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { signToken } from '../server/src/auth.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { dispatch } from '../server/src/control.js'
import { createSession, setRules, upsertParticipant } from '../server/src/db.js'
import { aiRoutes } from '../server/src/routes/ai.js'
import type { TokenPayload } from '../server/src/auth.js'

const closers: (() => void)[] = []
after(() => {
  for (const close of closers.splice(0)) close()
  shutdownCollab()
})

/** A gateway that has no time to answer anything: the doors are checked, not the model. */
async function gateway(): Promise<void> {
  const app = express()
  app.use(express.json())
  app.post('/v1/chat/completions', (_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const server = http.createServer(app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  closers.push(() => {
    server.closeAllConnections()
    server.close()
  })
  updateOracleSettings({
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'test-model',
    apiKey: 'test-key',
    questionsPerHour: 50,
    slowModeSeconds: 0,
    defaultMode: 'full',
  })
}

let seq = 0

interface Room {
  id: string
  cellId: string
  base: string
}

/** A room with these rules and one code cell in this lock position. */
async function room(rules: typeof LECTURE_ROOM, lock: 'closed' | 'open' | 'council'): Promise<Room> {
  const id = `edit-gate-${++seq}`
  createSession(id, 'Тетрадь', null)
  setRules(id, rules)
  for (const [pid, role] of [['p_teacher', 'host'], ['p_student', 'participant']] as const) {
    upsertParticipant({
      id: pid,
      sessionId: id,
      name: role === 'host' ? 'Ада' : 'Петя',
      avatar: null,
      role,
      tokenHost: role === 'host',
    })
  }
  const cellId = `c_task_${seq}`
  const { doc } = getSessionDoc(id)
  const made = createCell('code', 'total = sum(xs)', cellId)
  doc.transact(() => {
    // The lock position lives in the `open` key (notebook.ts · cellLock).
    if (lock === 'open') made.set('open', true)
    if (lock === 'council') made.set('open', 'council')
    getCells(doc).push([made])
  })
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(aiRoutes())
  const server = http.createServer(app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  closers.push(() => server.close())
  return { id, cellId, base: `http://127.0.0.1:${port}` }
}

function ask(r: Room, who: 'p_teacher' | 'p_student', body: unknown): Promise<Response> {
  const token = signToken({
    sessionId: r.id,
    participantId: who,
    role: 'participant',
    iat: Date.now() - 10 * 60_000,
  })
  return fetch(`${r.base}/api/sessions/${r.id}/ai/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/* ----------------------------------------------------------------- ask */

test('in a lecture a participant asks about a cell but does not ask to rewrite it', async () => {
  await gateway()
  const r = await room(LECTURE_ROOM, 'closed')

  const edit = await ask(r, 'p_student', { message: 'перепиши', action: 'edit', cellId: r.cellId })
  assert.equal(edit.status, 403, 'a participant in a lecture ordered a cell edit')
  const said = (await edit.json()) as { error: string }
  assert.match(said.error, /менять её может преподаватель/)

  // But a question about the same cell goes through: the rule is about EDITING, not about talking.
  const asked = await ask(r, 'p_student', { message: 'что тут не так?', cellId: r.cellId })
  assert.equal(asked.status, 202, 'a participant in a lecture was forbidden to ask')

  // And the teacher may edit the cell in the same room.
  const mine = await ask(r, 'p_teacher', { message: 'перепиши', action: 'edit', cellId: r.cellId })
  assert.equal(mine.status, 202, 'the teacher was refused in their own notebook')
})

test('an open cell gives the participant editing back too: the lock beats the rule', async () => {
  await gateway()
  const r = await room(LECTURE_ROOM, 'open')
  const edit = await ask(r, 'p_student', { message: 'перепиши', action: 'edit', cellId: r.cellId })
  assert.equal(edit.status, 202, 'editing was refused in an open cell')
})

test('a participant does not rewrite the shared council cell even in an open room', async () => {
  await gateway()
  const r = await room(OPEN_ROOM, 'council')

  // The `edit` rule allows the participant everything here — which is exactly why
  // the lock check has to stand on its own: the cell holds the assignment.
  const edit = await ask(r, 'p_student', { message: 'перепиши', action: 'edit', cellId: r.cellId })
  assert.equal(edit.status, 403, 'a participant rewrote the council assignment')

  // The teacher may: the reference solution in the shared cell is theirs.
  const mine = await ask(r, 'p_teacher', { message: 'перепиши', action: 'edit', cellId: r.cellId })
  assert.equal(mine.status, 202)

  // A question about the same cell can still be asked: talking is not locked.
  const asked = await ask(r, 'p_student', { message: 'о чём задание?', cellId: r.cellId })
  assert.equal(asked.status, 202)
})

/* -------------------------------------------------------------- accept */

/** Exactly what `send` reads: the state and refusals in words. */
function socket(): { ws: WebSocket; said: string[] } {
  const said: string[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (frame: string) => {
      const message = JSON.parse(frame) as { t: string; message?: string }
      if (message.t === 'error') said.push(message.message ?? '')
    },
  } as unknown as WebSocket
  return { ws, said }
}

function who(role: 'host' | 'participant', sessionId: string): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/** A ready oracle proposal for this cell — and its id. */
function propose(sessionId: string, cellId: string, text: string): string {
  const { doc } = getSessionDoc(sessionId)
  const entry = createChatEntry({
    participantId: 'p_participant',
    name: 'Петя',
    color: '#c273e6',
    question: 'перепиши',
    cellId,
  })
  doc.transact(() => {
    entry.set('patch', text)
    entry.set('state', 'done')
    getChat(doc).push([entry])
  })
  return entry.get('id') as string
}

function sourceOf(sessionId: string, cellId: string): string {
  const found = findCell(getSessionDoc(sessionId).doc, cellId)
  return found ? (found.cell.get('source') as { toString(): string }).toString() : 'no such cell'
}

test('a participant cannot accept a proposal into the council cell on the server either', async () => {
  await gateway()
  const r = await room(OPEN_ROOM, 'council')
  const entryId = propose(r.id, r.cellId, 'total = 0')

  const student = socket()
  dispatch(student.ws, r.id, who('participant', r.id), { t: 'ai:decide', entryId, accept: true })
  assert.match(student.said[0] ?? '', /преподавател/i, 'a participant accepted an edit into the assignment')
  assert.equal(sourceOf(r.id, r.cellId), 'total = sum(xs)', 'the assignment text was rewritten after all')

  // The teacher accepts, and the cell changes.
  const teacher = socket()
  dispatch(teacher.ws, r.id, who('host', r.id), { t: 'ai:decide', entryId, accept: true })
  assert.deepEqual(teacher.said, [], 'the teacher was refused in their own notebook')
  assert.equal(sourceOf(r.id, r.cellId), 'total = 0')
})
