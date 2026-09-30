/**
 * "Student names in model requests" governs every request, not only the council.
 *
 * Until 0.9 the switch was read by the council alone: an oracle question still
 * carried the asker's name, every earlier asker's name and "run by <name>" on
 * each cell, and a turn of the "Act" mode the same — whatever the switch said.
 * What is checked here is what actually reaches the provider: the request
 * bodies as a fake endpoint received them, with the switch off (pseudonyms,
 * not one real name anywhere) and on (the names, as before).
 *
 * The provider is fake, the room, the thread and the rules are real: exactly
 * the layer behind which someone else's model lives is replaced.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import {
  bookCells,
  chatAnswer,
  createCell,
  createChatEntry,
  findChatEntry,
  getCells,
  getChat,
  type ChatState,
} from '../shared/notebook.js'
import { OPEN_ROOM } from '../shared/rules.js'
import { getOracleSettings, updateOracleSettings } from '../server/src/admin/settings.js'
import { signToken } from '../server/src/auth.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { createBook } from '../server/src/collab/books.js'
import { createSession, setRules, upsertParticipant } from '../server/src/db.js'
import { stopAll, work } from '../server/src/ai/agent.js'
import { recentTurns } from '../server/src/ai/index.js'
import { modelNames } from '../server/src/ai/names.js'
import { aiRoutes } from '../server/src/routes/ai.js'

/* ------------------------------------------------------------ the fake */

/** Request bodies exactly as the "provider" received them. */
let heard: Record<string, unknown>[] = []
/** What an Act turn is told to do next; a streamed question always gets `ANSWER`. */
let script: ({ tool: string; args: unknown } | { text: string })[] = []
let round = 0
const ANSWER = 'Проверьте размерность.'

let provider: http.Server
let routes: http.Server
let base = ''
let saved: { sendNames: boolean; contextChars: number; agentSteps: number }

before(async () => {
  provider = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      heard.push(body)
      if (Array.isArray(body.tools)) {
        // An Act turn: plain JSON with an optional tool call, as agent-turn.test does.
        const step = script[round] ?? { text: 'Готово.' }
        round += 1
        const message =
          'text' in step
            ? { role: 'assistant', content: step.text }
            : {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: `call-${round}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } },
                ],
              }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message }] }))
        return
      }
      response.setHeader('content-type', 'text/event-stream')
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER } }] })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done))
  const settings = getOracleSettings()
  saved = { sendNames: settings.sendNames, contextChars: settings.contextChars, agentSteps: settings.agentSteps }
  updateOracleSettings({
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    model: 'test-model',
    apiKey: 'test-key',
    questionsPerHour: 100,
    slowModeSeconds: 0,
    agentSteps: 0,
  })
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(aiRoutes())
  routes = http.createServer(app)
  await new Promise<void>((done) => routes.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(routes.address() as { port: number }).port}`
})

after(() => {
  updateOracleSettings(saved)
  provider?.close()
  routes?.close()
  shutdownCollab()
})

/* ------------------------------------------------------------ the room */

/** Every real name in the room: none of them may appear in a request with the switch off. */
const NAMES = ['Ада', 'Лавлейс', 'Пётр', 'Смирнов', 'Анна', 'Белая', 'Аким', 'Петров']

let seq = 0

interface Room {
  id: string
  teacher: string
  petr: string
  anna: string
  akim: string
  /** The cell Anna ran. */
  ranCell: string
  /** A cell in Akim's personal notebook. */
  akimCell: string
}

/**
 * A room as a class leaves it: a teacher who came first, three students, a cell
 * Anna ran, an earlier answer that names her (written while names were on), and
 * a personal notebook of Akim's.
 */
function room(): Room {
  const id = `names-${++seq}`
  createSession(id, 'Семинар', null)
  const teacher = `p_teacher_${seq}`
  const petr = `p_petr_${seq}`
  const anna = `p_anna_${seq}`
  const akim = `p_akim_${seq}`
  // Join order is the pseudonym order: the teacher is "Teacher", then 2, 3, 4.
  upsertParticipant({ id: teacher, sessionId: id, name: 'Ада Лавлейс', avatar: null, role: 'host', tokenHost: true })
  upsertParticipant({ id: petr, sessionId: id, name: 'Пётр Смирнов', avatar: null, role: 'participant' })
  upsertParticipant({ id: anna, sessionId: id, name: 'Анна Белая', avatar: null, role: 'participant' })
  upsertParticipant({ id: akim, sessionId: id, name: 'Аким Петров', avatar: null, role: 'participant' })

  const { doc } = getSessionDoc(id)
  const ranCell = `c_ran_${seq}`
  doc.transact(() => {
    const cell = createCell('code', 'model.fit(X, y)', ranCell)
    cell.set('runBy', 'Анна Белая')
    cell.set('runById', anna)
    cell.set('execCount', 3)
    getCells(doc).push([cell])
  })
  const earlier = createChatEntry({ participantId: anna, name: 'Анна Белая', color: '#888', question: 'почему падает fit?' })
  doc.transact(() => getChat(doc).push([earlier]))
  doc.transact(() => {
    chatAnswer(earlier).insert(0, 'Анна Белая, у вас X и y разной длины.')
    earlier.set('state', 'done' as ChatState)
  })

  const made = createBook(id, `akim-${seq}.ipynb`)
  assert.ok(made.ok, 'the personal notebook was not created')
  const akimCell = `c_akim_${seq}`
  doc.transact(() => bookCells(doc, made.book.root).push([createCell('code', 'x = 1', akimCell)]))
  // Akim's, and personal: only he and the teacher may edit it. "Act" is open
  // to students here, so a student's turn is what meets the refusal.
  setRules(id, {
    ...OPEN_ROOM,
    agent: 'room',
    books: { [made.book.root]: { access: 'owner', owner: akim, ownerName: 'Аким Петров' } },
  })
  return { id, teacher, petr, anna, akim, ranCell, akimCell }
}

async function ask(r: Room, who: string, message: string, extra: Record<string, unknown> = {}): Promise<string> {
  heard = []
  const token = signToken({ sessionId: r.id, participantId: who, role: 'participant', iat: Date.now() - 3 * 60_000 })
  const res = await fetch(`${base}/api/sessions/${r.id}/ai/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message, ...extra }),
  })
  assert.equal(res.status, 202)
  const { entryId } = (await res.json()) as { entryId: string }
  const doc = getSessionDoc(r.id).doc
  for (let i = 0; i < 300; i++) {
    if (findChatEntry(doc, entryId)?.get('state') !== 'streaming' && heard.length > 0) break
    await new Promise((done) => setTimeout(done, 10))
  }
  assert.equal(heard.length, 1, 'the question did not reach the provider')
  return JSON.stringify(heard[0].messages)
}

async function act(r: Room, who: string, name: string): Promise<string[]> {
  heard = []
  round = 0
  script = [{ tool: 'edit_cell', args: { cellId: r.akimCell, source: 'x = 2' } }, { text: 'Не получилось.' }]
  const entryId = work({
    sessionId: r.id,
    participantId: who,
    participantName: name,
    participantColor: '#123456',
    role: 'participant',
    message: 'поправь ячейку',
  })
  const doc = getSessionDoc(r.id).doc
  for (let i = 0; i < 500; i++) {
    if (findChatEntry(doc, entryId)?.get('state') !== 'streaming') return heard.map((body) => JSON.stringify(body.messages))
    await new Promise((done) => setTimeout(done, 10))
  }
  stopAll(r.id)
  throw new Error('the turn did not finish')
}

function noRealNames(text: string, where: string): void {
  for (const name of NAMES) assert.equal(text.includes(name), false, `${where}: "${name}" went to the provider`)
}

/* ----------------------------------------------------- the names module */

test('pseudonyms follow join order, a host is the teacher, and they do not move', () => {
  const r = room()
  const names = modelNames(r.id, false)
  assert.equal(names.real, false)
  assert.equal(names.call(r.teacher, 'Ада Лавлейс'), 'Преподаватель')
  assert.equal(names.call(r.petr, 'Пётр Смирнов'), 'Студент 2')
  assert.equal(names.call(r.anna, 'Анна Белая'), 'Студент 3')
  assert.equal(names.call(r.akim), 'Студент 4')
  // A stranger is nobody in particular, never a guessed name.
  assert.equal(names.call('p_stranger', 'Кто-то'), null)
  assert.equal(names.call(null, 'Анна Белая'), null)

  // A newcomer does not renumber anyone, and the next request reads the same labels.
  upsertParticipant({ id: `p_late_${seq}`, sessionId: r.id, name: 'Опоздавший', avatar: null, role: 'participant' })
  const again = modelNames(r.id, false)
  assert.equal(again.call(r.anna), 'Студент 3')
  assert.equal(again.call(`p_late_${seq}`), 'Студент 5')

  // With the switch on the name is the one the room shows, as before.
  const real = modelNames(r.id, true)
  assert.equal(real.call(r.anna, 'Анна Белая'), 'Анна Белая')
  assert.equal(real.scrub('Анна Белая, привет'), 'Анна Белая, привет')
})

test('scrubbing replaces whole names in the model’s words, and nothing that merely looks like one', () => {
  const r = room()
  upsertParticipant({ id: `p_li_${seq}`, sessionId: r.id, name: 'Ли', avatar: null, role: 'participant' })
  upsertParticipant({ id: `p_np_${seq}`, sessionId: r.id, name: 'numpy', avatar: null, role: 'participant' })
  upsertParticipant({ id: `p_an_${seq}`, sessionId: r.id, name: 'Анна', avatar: null, role: 'participant' })
  const names = modelNames(r.id, false)
  assert.equal(
    names.scrub('Анна Белая и Анна: верно ли, что numpy быстрее? Аннушка ждёт.'),
    // The longer name goes whole; "Ли" is a particle and "numpy" a library, so
    // both stay; "Аннушка" is another word, not "Анна" with a tail.
    'Студент 3 и Студент 7: верно ли, что numpy быстрее? Аннушка ждёт.',
  )
})

/* ----------------------------------------------------- an oracle question */

test('with names off an oracle question carries pseudonyms and not one real name', async () => {
  updateOracleSettings({ sendNames: false })
  const r = room()
  // An action, so the question goes out in its "<asker> wrote: …" form too.
  const sent = await ask(r, r.petr, 'как исправить?', { action: 'explain', cellId: r.ranCell, cellIds: [r.ranCell] })
  noRealNames(sent, 'oracle question')
  // The asker, in the frame and in the question itself.
  assert.match(sent, /WHO IS ASKING ---\\nСтудент 2 asked this question\./)
  assert.match(sent, /Студент 2 wrote: \\"как исправить\?\\"/)
  // "Run by" on the cell, by id.
  assert.match(sent, /run by Студент 3/)
  // The earlier asker, and her name inside the earlier answer.
  assert.match(sent, /Студент 3 asked: почему падает fit\?/)
  assert.match(sent, /Студент 3, у вас X и y разной длины\./)
  // And the model is told what the labels are and not to write them back.
  assert.match(sent, /never write labels in your reply/)
})

test('with names on the same question carries the names, as it always did', async () => {
  updateOracleSettings({ sendNames: true })
  const r = room()
  const sent = await ask(r, r.petr, 'как исправить?')
  assert.match(sent, /Пётр Смирнов asked this question; name them when it helps/)
  assert.match(sent, /run by Анна Белая/)
  assert.match(sent, /Анна Белая asked: почему падает fit\?/)
  assert.equal(sent.includes('Студент'), false)
  assert.equal(sent.includes('never write labels'), false)
})

test('the thread calls a person the same way from one request to the next', () => {
  const r = room()
  const doc = getSessionDoc(r.id).doc
  const first = recentTurns(doc, modelNames(r.id, false))
  const second = recentTurns(doc, modelNames(r.id, false))
  assert.deepEqual(first, second)
  assert.match(first[0].content, /^Студент 3 asked:/)
})

/* ------------------------------------------------------------ an Act turn */

test('with names off an Act turn sends pseudonyms, including a personal notebook’s author', async () => {
  updateOracleSettings({ sendNames: false })
  const r = room()
  const requests = await act(r, r.petr, 'Пётр Смирнов')
  assert.ok(requests.length >= 2, 'the turn did not come back after the refused call')
  for (const [i, sent] of requests.entries()) noRealNames(sent, `act request ${i + 1}`)
  // The frame and the thread of the first request.
  assert.match(requests[0], /run by Студент 3/)
  assert.match(requests[0], /Студент 3 asked: почему падает fit\?/)
  // The refusal the model gets back names the notebook's author by pseudonym.
  assert.match(requests[1], /личная тетрадь: Студент 4\./)
})

test('with names on the refusal names the author, as before', async () => {
  updateOracleSettings({ sendNames: true })
  const r = room()
  const requests = await act(r, r.petr, 'Пётр Смирнов')
  assert.match(requests[0], /run by Анна Белая/)
  assert.match(requests[1], /личная тетрадь: Аким Петров\./)
})
