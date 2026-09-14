/**
 * «Переписать ячейку» спрашивает у ЯЧЕЙКИ, а не только у правила комнаты.
 *
 * Действие `edit` — единственное, которое кончается предложением с кнопкой
 * «Применить», то есть правкой общей тетради. Остальные (`ask`, `explain`,
 * `fix`, `debug`, `improve`, `hint`) про ячейку рассказывают, и в лекции они
 * студенту не заказаны: спрашивать про запертую ячейку можно и нужно.
 *
 * Две дыры, которые здесь закрыты.
 *
 * Лекция. Правило `edit: host` гасило кнопку «Применить» — и только её. Просить
 * переписать ячейку участник мог: писал фразу, тратил вопрос из часового лимита
 * комнаты, получал предложение и упирался в собственное бессилие. Вопрос при
 * этом уже потрачен, и вернуть его нечем.
 *
 * Консилиум. Там правило `edit` вообще ни при чём: в открытой комнате оно
 * разрешает участнику править ячейки, а общая ячейка консилиума — это ЗАДАНИЕ.
 * Замок «открытой» её не считает (`open === 'council'`), поэтому прежняя
 * проверка `mayEditCell` её попросту не замечала: и попросить переписать, и
 * принять предложение можно было одним нажатием — на задание всему классу.
 *
 * Шлюз поддельный, комната и документ настоящие — как в oracle-flow.test.mts.
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

/** Шлюз, который ничего не успеет ответить: проверяются двери, а не модель. */
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

/** Комната с этими правилами и одной ячейкой кода в этом положении замка. */
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
    // Положение замка живёт в ключе `open` (notebook.ts · cellLock).
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

test('в лекции участник спрашивает про ячейку, но переписать её не просит', async () => {
  await gateway()
  const r = await room(LECTURE_ROOM, 'closed')

  const edit = await ask(r, 'p_student', { message: 'перепиши', action: 'edit', cellId: r.cellId })
  assert.equal(edit.status, 403, 'участник в лекции заказал правку ячейки')
  const said = (await edit.json()) as { error: string }
  assert.match(said.error, /менять её может преподаватель/)

  // А вопрос про ту же ячейку проходит: правило про ПРАВКУ, а не про разговор.
  const asked = await ask(r, 'p_student', { message: 'что тут не так?', cellId: r.cellId })
  assert.equal(asked.status, 202, 'участнику в лекции запретили спрашивать')

  // И преподавателю правка ячейки в той же комнате разрешена.
  const mine = await ask(r, 'p_teacher', { message: 'перепиши', action: 'edit', cellId: r.cellId })
  assert.equal(mine.status, 202, 'преподавателю отказали в его же тетради')
})

test('открытая ячейка возвращает участнику и правку: замок сильнее правила', async () => {
  await gateway()
  const r = await room(LECTURE_ROOM, 'open')
  const edit = await ask(r, 'p_student', { message: 'перепиши', action: 'edit', cellId: r.cellId })
  assert.equal(edit.status, 202, 'в открытой ячейке правку не дали')
})

test('общую ячейку консилиума участник не переписывает даже в открытой комнате', async () => {
  await gateway()
  const r = await room(OPEN_ROOM, 'council')

  // Правило `edit` здесь разрешает участнику всё — и именно поэтому проверка
  // замка обязана стоять отдельно: в ячейке лежит задание.
  const edit = await ask(r, 'p_student', { message: 'перепиши', action: 'edit', cellId: r.cellId })
  assert.equal(edit.status, 403, 'участник переписал задание консилиума')

  // Преподавателю — можно: эталон в общей ячейке его.
  const mine = await ask(r, 'p_teacher', { message: 'перепиши', action: 'edit', cellId: r.cellId })
  assert.equal(mine.status, 202)

  // Той же ячейке вопрос по-прежнему задаётся: разговор не заперт.
  const asked = await ask(r, 'p_student', { message: 'о чём задание?', cellId: r.cellId })
  assert.equal(asked.status, 202)
})

/* -------------------------------------------------------------- accept */

/** Ровно то, что читает `send`: состояние и отказы словами. */
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

/** Готовое предложение оракула на эту ячейку — и его имя. */
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
  return found ? (found.cell.get('source') as { toString(): string }).toString() : 'нет такой'
}

test('принять предложение в ячейку консилиума участник не может и на сервере', async () => {
  await gateway()
  const r = await room(OPEN_ROOM, 'council')
  const entryId = propose(r.id, r.cellId, 'total = 0')

  const student = socket()
  dispatch(student.ws, r.id, who('participant', r.id), { t: 'ai:decide', entryId, accept: true })
  assert.match(student.said[0] ?? '', /преподавател/i, 'участник принял правку в задание')
  assert.equal(sourceOf(r.id, r.cellId), 'total = sum(xs)', 'текст задания всё-таки переписали')

  // Преподаватель принимает — и ячейка меняется.
  const teacher = socket()
  dispatch(teacher.ws, r.id, who('host', r.id), { t: 'ai:decide', entryId, accept: true })
  assert.deepEqual(teacher.said, [], 'преподавателю отказали в его же тетради')
  assert.equal(sourceOf(r.id, r.cellId), 'total = 0')
})
