/**
 * A turn as a whole: the clock, the conversation and a second "do" button.
 *
 * What is checked here is not a tool (that is `agent-cells`) and not the
 * action ceiling (that is `agent-step-limit`), but what keeps a turn within
 * bounds when the model behaves differently from the example in the docs:
 * writes a call as text, thinks longer than a class, gets a refusal and
 * forgets it ten steps later. The model is a fake: a real one would answer
 * differently every time, and it is the model that would have to be tested.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { work, stopAll } from '../server/src/ai/agent.js'
import { aiRoutes } from '../server/src/routes/ai.js'
import { signToken } from '../server/src/auth.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { writeText } from '../server/src/workspace.js'
import { chatAnswer, chatSteps, findChatEntry } from '../shared/notebook.js'
import { getOracleSettings, updateOracleSettings } from '../server/src/admin/settings.js'

/** What the fake answers to the next request; `null` means "in words, with no calls". */
type Reply = { tool: string; args?: unknown } | { text: string } | null

let script: Reply[] = []
let round = 0
/** Request bodies as the "provider" received them: they show what got through. */
let heard: string[] = []
/** How long the fake delays its answer: this keeps a turn running. */
let delayMs = 0
/** How far the fake moves the clock before answering: this tests the turn deadline. */
let tickMs = 0
let was = 0

let model: http.Server
let routes: http.Server
let base = ''

before(async () => {
  model = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      heard.push(body)
      const step: Reply = script[round] ?? { text: 'Готово' }
      round += 1
      const message =
        step === null || 'text' in step
          ? { role: 'assistant', content: step === null ? '' : step.text }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call-${round}`,
                  type: 'function',
                  function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) },
                },
              ],
            }
      // From the second round on: the first call must have time to run,
      // otherwise the test would check "the turn did not start" rather than
      // "the turn ran out of time".
      if (tickMs > 0 && round > 1) mock.timers.tick(tickMs)
      const send = () => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message }] }))
      }
      if (delayMs > 0) setTimeout(send, delayMs).unref?.()
      else send()
    })
  })
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
  was = getOracleSettings().contextChars
  updateOracleSettings({
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    apiKey: 'test-only',
    model: 'test-model',
    agentSteps: 0,
  })

  const app = express()
  app.use(express.json())
  app.use(aiRoutes())
  routes = http.createServer(app)
  await new Promise<void>((resolve) => routes.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(routes.address() as { port: number }).port}`
})

after(() => {
  model?.close()
  routes?.close()
  updateOracleSettings({ contextChars: was, agentSteps: 0 })
})

async function turn(id: string, plan: Reply[], message = 'сделай тетрадь') {
  script = plan
  round = 0
  heard = []
  try {
    createSession(id, `Turn ${id}`)
  } catch {
    /* the room was already created by this same file; that is intended */
  }
  const entryId = work({
    sessionId: id,
    participantId: 'teacher',
    participantName: 'Teacher',
    participantColor: '#123456',
    role: 'host',
    message,
  })
  const doc = getSessionDoc(id).doc
  // By counting rounds, not by the clock: one of the tests below moves the
  // process clock six minutes ahead, and waiting "until Date.now() + 8 s"
  // would end before the turn had time to answer.
  for (let waited = 0; waited < 800; waited++) {
    const entry = findChatEntry(doc, entryId)!
    if (entry.get('state') !== 'streaming') {
      return { entry, answer: chatAnswer(entry).toString(), steps: chatSteps(entry) }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  stopAll(id)
  throw new Error('the turn did not finish')
}

test('a call written as text instead of the tool_calls field is still a call', async () => {
  const result = await turn('text-call', [
    { text: '```json\n{"name": "list_files", "arguments": {}}\n```' },
    // Twice: to the first answer without a call the turn replies with a nudge, not an end.
    { text: 'Посмотрел папку.' },
    { text: 'Посмотрел папку.' },
  ])
  assert.equal(result.steps.length, 1, 'the call in the text stayed words')
  assert.equal(result.steps.get(0)!.get('kind'), 'read')
  assert.equal(result.answer, 'Посмотрел папку.')
})

test('JSON that does not name a known tool does not become a call', async () => {
  const result = await turn('text-data', [{ text: '{"path": "train.py", "lines": 40}' }])
  assert.equal(result.steps.length, 0, 'a piece of data was taken for a call')
})

test('a refusal stays in the conversation after the files that were read have dropped out of it', async () => {
  const id = 'keep-refusals'
  createSession(id, 'Refusals')
  // Short lines, not one long one: reading goes page by page, and a file of
  // one thirty-thousand-character line would arrive in the conversation as
  // one line.
  for (const name of ['a', 'b']) {
    const lines = Array.from({ length: 400 }, (_, i) => `МЕТКА_${name.toUpperCase()} ${i} ${'x'.repeat(50)}`)
    writeText(id, `${name}.py`, lines.join('\n'))
  }
  // A narrow window: the conversation stops fitting right after the first read.
  updateOracleSettings({ contextChars: 2_000 })
  try {
    const result = await turn(id, [
      { tool: 'read_file', args: { path: 'a.py' } },
      { tool: 'no_such_tool' },
      { tool: 'read_file', args: { path: 'b.py' } },
      { text: 'Готово' },
      { text: 'Готово' },
    ])
    assert.equal(result.steps.length, 3)
    /*
     * By flags, not by the request bodies themselves: `assert.match` on a
     * twelve-thousand-character string prints it whole into the report, and
     * on failure that hangs the run itself.
     */
    /*
     * The fourth request: it already has both the refusal and the fresh read,
     * and the old one has dropped out of it. The last one cannot be taken: the
     * turn appends a nudge to it, and the fresh batch stops being the last,
     * that is, it also becomes droppable.
     */
    const last = heard[3] ?? ''
    const kept = {
      refusal: last.includes('no_such_tool'),
      oldRead: last.includes('МЕТКА_A'),
      freshRead: last.includes('МЕТКА_B'),
    }
    assert.deepEqual(kept, { refusal: true, oldRead: false, freshRead: true })
  } finally {
    updateOracleSettings({ contextChars: was })
  }
})

test('a turn that did not fit into its allotted time names what was done and stops', async () => {
  mock.timers.enable({ apis: ['Date'] })
  tickMs = 6 * 60_000
  try {
    const result = await turn('out-of-time', [
      { tool: 'list_files' },
      // The second round will start already past the allotted time: the fake
      // itself moves the clock, between the answer and the next question.
      { tool: 'list_files', args: { nth: 2 } },
    ])
    assert.equal(result.steps.length, 1, 'the turn went on after the end of its allotted time')
    assert.match(result.answer, /5 мин/)
  } finally {
    tickMs = 0
    mock.timers.reset()
  }
})

test('a second turn in the same room does not start while the first one runs, even for the host', async () => {
  const id = 'one-turn-room'
  createSession(id, 'One turn')
  // `tokenHost`: the role is decided on every request from the table, not
  // from the token (routes/sessions.ts · roleFor); without this mark the host
  // would arrive as a participant.
  upsertParticipant({ id: 'teacher', sessionId: id, name: 'Teacher', avatar: null, role: 'host', tokenHost: true })
  const token = signToken({ sessionId: id, participantId: 'teacher', role: 'host' })
  const ask = () =>
    fetch(`${base}/api/sessions/${id}/ai/ask`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'сделай тетрадь', mode: 'agent' }),
    })

  script = [{ tool: 'list_files' }, { text: 'Готово' }]
  round = 0
  heard = []
  delayMs = 600
  try {
    const first = await ask()
    assert.equal(first.status, 202, await first.clone().text())
    const second = await ask()
    assert.equal(second.status, 409)
    const body = (await second.json()) as { error: string }
    assert.match(body.error, /уже выполняет поручение/)
  } finally {
    delayMs = 0
    stopAll(id)
  }
})
