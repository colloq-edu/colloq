import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { ask, cancel } from '../server/src/ai/index.js'
import { work, stopAll } from '../server/src/ai/agent.js'
import { listActivity } from '../server/src/activity.js'
import { shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

test('Oracle lifecycle records requests, completion, failure and stop without question text', async () => {
  let mode: 'answer' | 'empty' | 'hold' = 'answer'
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (mode === 'hold') return
      const agent = !JSON.parse(body).stream
      if (agent) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done.' } }] }))
        return
      }
      res.setHeader('content-type', 'text/event-stream')
      if (mode === 'answer') res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'An answer.' } }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  updateOracleSettings({ provider: 'custom', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'secret-key', model: 'test-model' })
  async function waitFor(id: string, kind: 'oracle.finished' | 'oracle.work_finished') {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const event = listActivity(id).events.find(event => event.kind === kind)
      if (event) return event
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`No ${kind} event`)
  }
  try {
    for (const [id, useAgent, response, expected] of [
      ['activity-answer', false, 'answer', 'completed'],
      ['activity-error', false, 'empty', 'error'],
      ['activity-stop', false, 'hold', 'cancelled'],
      ['activity-work', true, 'answer', 'completed'],
      ['activity-work-stop', true, 'hold', 'cancelled'],
    ] as const) {
      createSession(id, id)
      const participantId = `${id}-student`
      upsertParticipant({ id: participantId, sessionId: id, name: 'Nina', avatar: null, role: 'participant' })
      mode = response
      const options = { sessionId: id, participantId, participantName: 'Nina', participantColor: '#123456', message: 'PRIVATE QUESTION', role: 'participant' as const }
      const entryId = useAgent ? work(options) : ask(options)
      if (mode === 'hold') { if (useAgent) stopAll(id); else cancel(id, entryId) }
      const event = await waitFor(id, useAgent ? 'oracle.work_finished' : 'oracle.finished')
      assert.equal(event.details.entryId, entryId)
      assert.equal(event.details.outcome, expected)
      assert.equal(event.details.source, 'oracle')
      assert.ok(event.details.durationMs! >= 0)
      const events = listActivity(id).events
      assert.equal(events.length, 2)
      assert.equal(events[1].kind, useAgent ? 'oracle.work_started' : 'oracle.asked')
      assert.equal(events[1].actor?.name, 'Nina')
      assert.ok(!JSON.stringify(events).includes('PRIVATE QUESTION'))
      assert.ok(!JSON.stringify(events).includes('secret-key'))
    }
  } finally { server.closeAllConnections(); server.close() }
})

/**
 * Every tool call is its own row in the class log.
 *
 * The step feed lives in the room document and goes away with it; the log
 * stays. Until now a whole turn had two rows in it, "started" and
 * "finished", and there was nothing to ask the question "the oracle read
 * files seventeen times and never wrote" of. The level is "Detailed",
 * because this is a detail of the turn, not a class event.
 */
test('each tool call of a work turn is its own detailed row, named and with an outcome', async () => {
  let round = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const call = round++ < 2
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: call
        ? { role: 'assistant', content: null, tool_calls: [{ id: `c${round}`, type: 'function', function: { name: round === 1 ? 'list_files' : 'no_such_tool', arguments: '{}' } }] }
        : { role: 'assistant', content: 'Готово' } }] }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  updateOracleSettings({ provider: 'custom', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'secret-key', model: 'test-model' })
  const id = 'activity-work-steps'
  createSession(id, id)
  upsertParticipant({ id: 'teacher', sessionId: id, name: 'Ада', avatar: null, role: 'host' })
  try {
    const entryId = work({ sessionId: id, participantId: 'teacher', participantName: 'Ада', participantColor: '#123456', message: 'сделай тетрадь', role: 'host' })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (listActivity(id, { level: 'detailed' }).events.some(e => e.kind === 'oracle.work_finished')) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const steps = listActivity(id, { level: 'detailed', category: 'oracle' }).events
      .filter(event => event.kind === 'oracle.work_step')
      .reverse()
    assert.equal(steps.length, 2)
    assert.deepEqual(steps.map(s => [s.details.subjectId, s.details.outcome]), [
      ['list_files', 'completed'],
      // There is no tool with that name: the step is spent, and the log shows it.
      ['no_such_tool', 'error'],
    ])
    for (const step of steps) {
      assert.equal(step.level, 'detailed')
      assert.equal(step.details.entryId, entryId)
      assert.equal(step.details.source, 'oracle')
      assert.ok(step.details.durationMs! >= 0)
    }
    // The normal level does not show the turn's details: there are two of them per step.
    assert.ok(!listActivity(id).events.some(event => event.kind === 'oracle.work_step'))
  } finally { stopAll(id); server.closeAllConnections(); server.close() }
})
