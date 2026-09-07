/**
 * Оракул от нажатия до записи в тетради — весь путь, а не только статус ответа.
 *
 * Два теста в сюите слали POST `ai/ask` и смотрели на 202/403/429; дальше
 * начиналась темнота. Сломать `settle` — не ставить состояние `done`, не
 * вытащить предложение из последнего блока, не написать «(stopped)» — и сюита
 * оставалась зелёной, хотя в комнате не появлялось ни одного ответа. Здесь
 * проверяется то, что видит класс: запись в общем документе, её текст,
 * состояние и предложение под ячейкой.
 *
 * Шлюз поддельный, комната настоящая, документ настоящий: подделан ровно один
 * слой — тот, за которым живёт чужая модель.
 */
import './_env.mts'
import { after, test } from 'node:test'
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

/* ------------------------------------------------------------- подделки */

interface Gateway {
  base: string
  /** Тела запросов, как их правда прислали: по ним видно, что ушло эндпоинту. */
  seen: Record<string, unknown>[]
  /** Отпустить зависшие ответы. */
  release: () => void
  close: () => Promise<void>
}

/**
 * OpenAI-совместимый шлюз, которым правит тест.
 *
 * `answer` — что отдать одним кадром SSE. `refuse` — на какие тела отвечать 400
 * (так проверяется «голая» повторная попытка). `hold` — не отвечать вовсе, пока
 * не отпустят: так держатся одновременные потоки.
 */
async function gateway(options: {
  answer?: string
  refuse?: (body: Record<string, unknown>) => boolean
  hold?: boolean
}): Promise<Gateway> {
  const seen: Record<string, unknown>[] = []
  const waiting: express.Response[] = []
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
    if (options.hold) {
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
      for (const held of waiting.splice(0)) {
        held.write('data: [DONE]\n\n')
        held.end()
      }
    },
    close: async () => {
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
  // Тот же потолок тела, что у настоящего сервера: на нём и держится счёт
  // «сколько мусора может унести один вопрос».
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
  const token = signToken({ sessionId: r.id, participantId: who, role: 'participant' })
  return fetch(`${r.base}/api/sessions/${r.id}/ai/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Запись треда по идентификатору — то, что видит вся комната. */
function entryOf(r: Room, entryId: string) {
  const chat = getChat(getSessionDoc(r.id).doc)
  for (let i = 0; i < chat.length; i++) {
    const entry = chat.get(i)
    if (entry.get('id') === entryId) return entry
  }
  return null
}

/** Дождаться, пока ответ перестанет писаться. */
async function settled(r: Room, entryId: string) {
  for (let i = 0; i < 300; i++) {
    const entry = entryOf(r, entryId)
    if (entry && (entry.get('state') as ChatState) !== 'streaming') return entry
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('ответ так и не дописался')
}

/* ------------------------------------------------------------ весь путь */

test('вопрос доезжает до документа: ответ, состояние и предложение под ячейкой', async () => {
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
    assert.ok(entryId, 'маршрут не назвал запись')

    // Вопрос виден в ту же секунду, ещё до всякого ответа: в этом весь смысл
    // 202 — комната смотрит, как ответ наливается, а не ждёт чужой HTTP.
    const asked = entryOf(r, entryId)
    assert.equal(asked?.get('question'), 'почини')
    assert.equal(asked?.get('name'), 'Петя')

    const entry = await settled(r, entryId)
    assert.equal(entry!.get('state'), 'done')
    assert.match(chatAnswer(entry!).toString(), /после проверки на пустоту/)
    // Предложение вынимается в конце и только у хода `edit`: половина блока —
    // не патч, а ячейка, предлагающая сломать себя.
    assert.equal(entry!.get('patch'), 'total = sum(xs) if xs else 0')
    assert.equal(entry!.get('patchBase'), 'total = sum(xs)')
  } finally {
    r.close()
    await gate.close()
  }
})

test('«Стоп» ставит на запись «(stopped)», а не пустоту', async () => {
  const gate = await gateway({ hold: true })
  const r = await room()
  try {
    const res = await ask(r, r.student, { message: 'долгий вопрос' })
    const { entryId } = (await res.json()) as { entryId: string }

    const token = signToken({ sessionId: r.id, participantId: r.student, role: 'participant' })
    const stop = await fetch(`${r.base}/api/sessions/${r.id}/ai/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ entryId }),
    })
    assert.equal(stop.status, 200)

    const entry = await settled(r, entryId)
    assert.equal(entry!.get('state'), 'done')
    assert.equal(chatAnswer(entry!).toString(), '(stopped)')
  } finally {
    r.close()
    gate.release()
    await gate.close()
  }
})

test('пустой ответ модели не советует комнате чинить переменную окружения', async () => {
  const gate = await gateway({ answer: '' })
  const r = await room()
  try {
    const res = await ask(r, r.student, { message: 'что тут' })
    const { entryId } = (await res.json()) as { entryId: string }
    const entry = await settled(r, entryId)
    assert.equal(entry!.get('state'), 'error')
    const said = chatAnswer(entry!).toString()
    // Текст читают студенты: переменной окружения им не видно, а панель — не их
    // дверь. То же разделение, что у отказа про ключ в routes/ai.ts.
    assert.doesNotMatch(said, /OPENAI_MODEL/)
    assert.match(said, /whoever runs this Colloq/i)
  } finally {
    r.close()
    await gate.close()
  }
})

test('шлюз, не знающий stream_options, получает вторую попытку без него', async () => {
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
     * Комментарий над `usage` в provider.ts обещал ровно это: кто не понимает
     * поля — ответит 400, и сработает голая попытка. Она не была голой —
     * `stream_options` ехало в обе, — так что на таком шлюзе оракул не работал
     * вовсе, а комната читала «rejected the request … stream_options».
     */
    assert.equal(entry!.get('state'), 'done', chatAnswer(entry!).toString())
    assert.match(chatAnswer(entry!).toString(), /Ответ есть/)
    assert.equal(gate.seen.length, 2, 'повторной попытки не было')
    assert.ok('stream_options' in gate.seen[0])
    assert.ok(!('stream_options' in gate.seen[1]), 'голая попытка снова со stream_options')
  } finally {
    r.close()
    await gate.close()
  }
})

/* ---------------------------------------------------------------- потолки */

test('одновременных ответов в комнате не больше дюжины', async () => {
  const gate = await gateway({ hold: true })
  const r = await room()
  try {
    for (let i = 0; i < 12; i++) {
      const res = await ask(r, r.student, { message: `вопрос ${i}` })
      assert.equal(res.status, 202, `отказ на ${i}-м вопросе`)
    }
    /*
     * Тринадцатый — ожидание, а не ошибка: по слову преподавателя «спросите
     * оракула» жмут двести человек разом, и без этого потолка комната шлёт
     * сотни тысяч кадров в секунду на пятистах сокетах, пропускает пинги и
     * разваливается — именно на самой большой аудитории.
     */
    const refused = await ask(r, r.student, { message: 'тринадцатый' })
    assert.equal(refused.status, 429)
    const body = (await refused.json()) as { error: string; retryAfter?: number }
    assert.match(body.error, /отвечает 12 людям/)
    assert.ok((body.retryAfter ?? 0) > 0, 'панель нарисует это красной ошибкой, а не отсчётом')
    assert.equal(refused.headers.get('retry-after'), String(body.retryAfter))
  } finally {
    r.close()
    gate.release()
    await gate.close()
  }
})

test('часовой потолок комнаты считается от её размера и не обещает чужой ручки', async () => {
  const gate = await gateway({ answer: 'ответ' })
  const r = await room()
  try {
    // Пустая комната — прежние тридцать личных пределов: маленькой комнате
    // достаётся ровно столько же, сколько доставалось.
    assert.equal(roomQuestionCeiling(r.id, 20), 600)

    /*
     * А теперь в комнате поток. Присутствие — то же, по которому комната
     * рисует людей; таблица участников не годится, она помнит всех, кто
     * заходил за все пары этого семинара.
     */
    const { awareness } = getSessionDoc(r.id)
    const states = awareness.getStates()
    for (let i = 0; i < 500; i++) states.set(1_000 + i, { user: { id: `p_hall_${i}` } })
    assert.equal(
      roomQuestionCeiling(r.id, 20),
      5_000,
      'зал в 500 человек живёт по мерке зала на 30',
    )
    for (let i = 0; i < 500; i++) states.delete(1_000 + i)

    // Слова отказа. Прежние обещали «попросите преподавателя, он поднимет
    // предел в панели» — ручки, которой у преподавателя нет.
    updateOracleSettings({ questionsPerHour: 1 })
    for (let i = 0; i < 30; i++) {
      recordQuestion({ sessionId: r.id, participantId: `p_ghost_${i}`, action: 'ask' })
    }
    const refused = await ask(r, r.student, { message: 'ещё один' })
    assert.equal(refused.status, 429)
    const body = (await refused.json()) as { error: string }
    assert.match(body.error, /all 30 of its oracle questions/)
    assert.doesNotMatch(body.error, /raise the limit in the panel/)
    assert.match(body.error, /nobody here can lift it/i)
  } finally {
    updateOracleSettings({ questionsPerHour: 20 })
    r.close()
    await gate.close()
  }
})

test('имена ячеек не проносят мегабайт мусора в общий документ', async () => {
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
    // Отбрасываются, а не режутся: имя ячейки — это ключ, и обрезанный ключ уже
    // не тот, что просили.
    assert.equal(entry!.get('cellId'), null)
    assert.deepEqual((entry!.get('cellIds') as string[]) ?? [], [r.cellId])
    await settled(r, entryId)
  } finally {
    r.close()
    await gate.close()
  }
})

/* --------------------------------------------------------------- история */

test('в историю едут только состоявшиеся ходы — по паре реплик, а не два вопроса подряд', () => {
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
   * Роли обязаны чередоваться: строгие шаблоны чата (vLLM с Mistral или
   * Llama-2) отвечают на два user-хода подряд 400 — «Conversation roles must
   * alternate» — и бесплатный повтор шлёт ту же историю и получает то же 400.
   * В большой комнате два вопроса в минуту — норма, так что каждый второй
   * вопрос падал бы.
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
