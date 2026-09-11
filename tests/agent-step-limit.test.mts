import './_env.mts'
import http from 'node:http'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { work, stopAll } from '../server/src/ai/agent.js'
import { createSession, setRules } from '../server/src/db.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { findChatEntry, chatAnswer, chatSteps } from '../shared/notebook.js'
import { getOracleSettings, parseOraclePatch, updateOracleSettings } from '../server/src/admin/settings.js'

let server: http.Server
let rounds = 0
let toolsWanted = 16
let batchSize = 1
let stopAt = 0
let activeRoom = ''
before(async () => {
  server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const call = rounds++ < toolsWanted
      if (stopAt && rounds === stopAt) queueMicrotask(() => stopAll(activeRoom))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: call
        ? { role: 'assistant', content: null, tool_calls: Array.from({ length: batchSize }, (_, index) => ({ id: `call-${rounds}-${index}`, type: 'function', function: { name: 'list_files', arguments: '{}' } })) }
        : { role: 'assistant', content: 'Задача завершена' } }] }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  updateOracleSettings({ provider: 'custom', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'test-only', model: 'test-model' })
})
after(() => server.close())

async function run(id: string, roomLimit?: number) {
  rounds = 0
  activeRoom = id
  createSession(id, 'Step limit test')
  if (roomLimit !== undefined) setRules(id, { agentSteps: roomLimit } as any)
  const entryId = work({ sessionId: id, participantId: 'teacher', participantName: 'Teacher', participantColor: '#123456', role: 'host', message: 'Make a notebook' })
  const doc = getSessionDoc(id).doc
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const entry = findChatEntry(doc, entryId)!
    if (entry.get('state') !== 'streaming') return { entry, answer: chatAnswer(entry).toString() }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  stopAll(id)
  throw new Error('Agent did not finish')
}

test('default agent work completes beyond the old twelve-tool ceiling', async () => {
  assert.equal(getOracleSettings().agentSteps, 0)
  const result = await run('no-step-limit')
  assert.equal(result.answer, 'Задача завершена')
  assert.equal(rounds, 17)
})

test('a saved server limit is applied to actual tool actions', async () => {
  updateOracleSettings({ agentSteps: 4 })
  assert.equal(getOracleSettings().agentSteps, 4)
  const result = await run('four-actions')
  assert.equal(chatSteps(result.entry).length, 4)
  assert.equal(rounds, 4)
  assert.match(result.answer, /4/)
  assert.match(result.answer, /правилах занятия/)
})

test('class limit can tighten the server and zero cannot override a finite server ceiling', async () => {
  updateOracleSettings({ agentSteps: 5 })
  assert.equal(chatSteps((await run('two-actions', 2)).entry).length, 2)
  assert.equal(chatSteps((await run('server-ceiling', 0)).entry).length, 5)
  updateOracleSettings({ agentSteps: 0 })
  assert.equal(chatSteps((await run('class-only-limit', 3)).entry).length, 3)
  assert.equal((await run('explicit-unlimited', 0)).answer, 'Задача завершена')
})

test('unlimited work still responds to manual stop', async () => {
  updateOracleSettings({ agentSteps: 0 })
  toolsWanted = Infinity
  stopAt = 4
  try {
    const result = await run('manual-stop')
    assert.match(result.answer, /Остановлено/)
    assert.equal(rounds, 4)
  } finally { stopAt = 0; toolsWanted = 16 }
})

test('a batch of tool calls cannot overrun the selected limit', async () => {
  updateOracleSettings({ agentSteps: 4 })
  batchSize = 3
  try {
    const result = await run('batch-limit')
    assert.equal(chatSteps(result.entry).length, 4)
    assert.equal(rounds, 2)
  } finally { batchSize = 1; updateOracleSettings({ agentSteps: 0 }) }
})

test('settings reject invalid values rather than accidentally disabling the limit', () => {
  for (const agentSteps of [-1, 0.5, 10001, Infinity, '12', null]) {
    assert.ok('error' in parseOraclePatch({ agentSteps }))
  }
  assert.deepEqual(parseOraclePatch({ agentSteps: 0 }), { patch: { agentSteps: 0 } })
  assert.deepEqual(parseOraclePatch({ agentSteps: 72 }), { patch: { agentSteps: 72 } })
  assert.throws(() => updateOracleSettings({ agentSteps: -1 }))
  assert.equal(getOracleSettings().agentSteps, 0)
})
