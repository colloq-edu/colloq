import './_env.mts'
import http from 'node:http'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { work, stopAll } from '../server/src/ai/agent.js'
import { createSession, setRules } from '../server/src/db.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { findChatEntry, chatAnswer, chatSteps } from '../shared/notebook.js'
import { getOracleSettings, parseOraclePatch, updateOracleSettings } from '../server/src/admin/settings.js'
import { LIMITS } from '../shared/admin.js'

let server: http.Server
let rounds = 0
let toolsWanted = 16
let batchSize = 1
let stopAt = 0
/** Every call with the same arguments: that is how the loop guard is tested. */
let sameArgs = false
/** On this round the model answers with words and no call: the nudge check. */
let talkAt = 0
/** On this round the model answers with nothing: no text, no call. */
let emptyAt = 0
let activeRoom = ''
before(async () => {
  server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const call = rounds++ < toolsWanted && rounds !== talkAt && rounds !== emptyAt
      if (stopAt && rounds === stopAt) queueMicrotask(() => stopAll(activeRoom))
      response.setHeader('content-type', 'application/json')
      /*
       * Every call has its own arguments, and this is not decoration.
       *
       * What is measured here is the ACTION CEILING, and a turn has a second
       * limit that catches something else: the same call with the same
       * arguments stops the turn on the third repeat (`fingerprint` in
       * agent.ts). With `arguments: '{}'` twenty calls in a row would count
       * as a loop and be cut off on the third, that is, this file would be
       * testing the loop guard instead of the ceiling. `list_files` does not
       * read extra fields.
       */
      response.end(JSON.stringify({ choices: [{ message: call
        ? { role: 'assistant', content: null, tool_calls: Array.from({ length: batchSize }, (_, index) => ({ id: `call-${rounds}-${index}`, type: 'function', function: { name: 'list_files', arguments: sameArgs ? '{}' : JSON.stringify({ nth: `${rounds}-${index}` }) } })) }
        : { role: 'assistant', content: rounds === emptyAt ? '' : 'Задача завершена' } }] }))
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
  // The default is no longer zero: a turn without a ceiling, stuck on a model
  // that describes a call in prose, keeps going to the provider until someone
  // presses "Stop". Zero is still available to the operator: see the check
  // below.
  assert.equal(getOracleSettings().agentSteps, 24)
  updateOracleSettings({ agentSteps: 0 })
  const result = await run('no-step-limit')
  assert.equal(result.answer, 'Задача завершена')
  /*
   * Eighteen, not seventeen: sixteen calls, an answer in words, the nudge
   * ("call a tool or finish with a summary") and a second answer in words,
   * on which the turn ends. The nudge costs one request and saves turns
   * where the model DESCRIBES the next call instead of making it; a second
   * answer without a call in a row really is the summary.
   */
  assert.equal(rounds, 18)
})

test('a reply without a tool call is nudged once, and a call after the nudge carries on', async () => {
  updateOracleSettings({ agentSteps: 0 })
  talkAt = 3
  try {
    const result = await run('nudge-once')
    // The third round is words without a call; after the nudge the turn went
    // on and reached the end of the call list instead of breaking off midway.
    assert.equal(result.answer, 'Задача завершена')
    assert.equal(chatSteps(result.entry).length, 15, 'the nudge cut the turn off instead of continuing it')
  } finally { talkAt = 0 }
})

test('a model that answers with nothing at all says so instead of signing off blank', async () => {
  updateOracleSettings({ agentSteps: 0 })
  emptyAt = 2
  try {
    const result = await run('said-nothing')
    assert.match(result.answer, /ничего не ответила|answered with nothing/)
  } finally { emptyAt = 0 }
})

test('the shipped default stops a runaway turn at twenty-four actions', async () => {
  updateOracleSettings({ agentSteps: LIMITS.agentSteps.default })
  toolsWanted = Infinity
  try {
    const result = await run('default-ceiling')
    assert.equal(chatSteps(result.entry).length, 24)
    assert.match(result.answer, /24/)
  } finally { toolsWanted = 16; updateOracleSettings({ agentSteps: 0 }) }
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

test('the same call with the same arguments answers from memory once and then ends the turn', async () => {
  updateOracleSettings({ agentSteps: 0 })
  toolsWanted = Infinity
  sameArgs = true
  try {
    const result = await run('loop-guard')
    // The first call is real, the second comes from memory, the third ends the turn.
    assert.equal(rounds, 3)
    const notes = chatSteps(result.entry).map(step => String(step.get('note')))
    assert.equal(notes.length, 3)
    assert.match(notes[1], /Повтор|повтор/)
    assert.match(result.answer, /трижды|three times/)
  } finally { sameArgs = false; toolsWanted = 16 }
})

test('every step carries the moment it was recorded', async () => {
  updateOracleSettings({ agentSteps: 2 })
  try {
    const began = Date.now()
    const result = await run('step-clock')
    for (const step of chatSteps(result.entry)) {
      const at = step.get('at')
      assert.equal(typeof at, 'number')
      assert.ok(at >= began && at <= Date.now(), `step recorded outside the turn: ${at}`)
    }
  } finally { updateOracleSettings({ agentSteps: 0 }) }
})
