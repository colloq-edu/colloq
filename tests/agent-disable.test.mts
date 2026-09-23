import './_env.mts'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import OpenAI from 'openai'
import { createSession, setRules } from '../server/src/db.js'
import { work, turnsInRoom, stopAll } from '../server/src/ai/agent.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { readText } from '../server/src/workspace.js'
import { findChatEntry, chatAnswer } from '../shared/notebook.js'
import { OPEN_ROOM } from '../shared/rules.js'

async function settled(id: string, entryId: string) {
  const doc = getSessionDoc(id).doc
  for (let i = 0; i < 200; i++) {
    const entry = findChatEntry(doc, entryId)!
    if (entry.get('state') !== 'streaming' && turnsInRoom(id) === 0) return entry
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('agent did not settle')
}
function start(id: string) {
  createSession(id, 'Agent cancellation', null)
  setRules(id, { ...OPEN_ROOM, agent: 'room' })
  updateOracleSettings({provider:'custom',baseUrl:'http://provider.invalid/v1',apiKey:'test-only',model:id})
  return work({sessionId:id,participantId:'temporary',participantName:'Tester',participantColor:'#123456',role:'participant',message:'Update files'})
}

test('agent off aborts the in-flight provider request and does not apply its late tools', async () => {
  const id = 'agent-disable-provider'
  let requestSignal: AbortSignal | undefined
  let calls = 0
  let started!: () => void
  const requested = new Promise<void>(resolve => { started = resolve })
  const transport = mock.method(OpenAI.Chat.Completions.prototype, 'create', (async (_input: unknown, init?: {signal?: AbortSignal}) => {
    calls += 1
    requestSignal = init?.signal ?? undefined
    started()
    // Resolve only on abort, deliberately with a late tool reply.
    await new Promise<void>(resolve => requestSignal!.addEventListener('abort', () => resolve(), {once:true}))
    return ({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'late',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'late.txt',content:'must not appear'})}}]}}]})
  }) as any)
  let entryId = ''
  try {
    entryId = start(id)
    await requested
    setRules(id, { ...OPEN_ROOM, agent: 'off' })
    assert.equal(requestSignal?.aborted, true)
    const entry = await settled(id, entryId)
    assert.equal(calls, 1)
    assert.equal(readText(id, 'late.txt'), null)
    assert.match(chatAnswer(entry).toString(), /остановлено|stopped/i)
  } finally { stopAll(id); transport.mock.restore() }
})

test('agent off after the first tool suppresses the rest of the batch and the next provider request', async () => {
  const id = 'agent-disable-batch'
  let calls = 0
  const transport = mock.method(OpenAI.Chat.Completions.prototype, 'create', (async () => {
    calls += 1
    return ({choices:[{message:{role:'assistant',content:null,tool_calls:['first','second'].map(name => ({id:name,type:'function',function:{name:'write_file',arguments:JSON.stringify({path:`${name}.txt`,content:name})}}))}}]})
  }) as any)
  const rename = fs.renameSync
  const changeRules = mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    const result = rename(...args)
    if (String(args[1]).endsWith('/first.txt')) setRules(id, { ...OPEN_ROOM, agent:'off' })
    return result
  })
  try {
    const entryId = start(id)
    await settled(id, entryId)
    assert.equal(calls, 1)
    assert.equal(readText(id, 'first.txt')?.text, 'first')
    assert.equal(readText(id, 'second.txt'), null)
  } finally { stopAll(id); changeRules.mock.restore(); transport.mock.restore() }
})
