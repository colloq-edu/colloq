import './_env.mts'
import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import fs from 'node:fs'
import { createSession, setRules, getRules } from '../server/src/db.ts'
import { OPEN_ROOM, allowsAgent } from '../shared/rules.ts'
import { createChatEntry, getChat } from '../shared/notebook.ts'
import { getSessionDoc } from '../server/src/collab/index.ts'
import { getFileDoc, currentText, flushSessionFiles } from '../server/src/collab/files.ts'
import { readText, writeText } from '../server/src/workspace.ts'
import { useTool, undoTurn, type Hands } from '../server/src/ai/agent.ts'

function fixture(id:string):Hands {
  createSession(id, 'Temporary AI correctness fixture', null)
  setRules(id,{...OPEN_ROOM,agent:'room'})
  const doc=getSessionDoc(id).doc
  const entry=createChatEntry({participantId:'temporary-user',name:'Tester',color:'#123456',question:'Update fixture',mode:'agent'})
  doc.transact(()=>getChat(doc).push([entry]))
  return {sessionId:id,entryId:String(entry.get('id')),role:'participant',by:{participantId:'temporary-user',name:'Tester',color:'#123456'}}
}

test('an accepted tool call is refused after the agent rule is turned off',async()=>{
  const hands=fixture('audit-agent-rule')
  setRules(hands.sessionId,{...OPEN_ROOM,agent:'off'})
  assert.equal(allowsAgent(getRules(hands.sessionId).agent,hands.role),false)
  const result=await useTool(hands,'write_file',JSON.stringify({path:'ordinary.txt',content:'ordinary static text'}))
  assert.equal(result.step.kind,'note')
  assert.equal(readText(hands.sessionId,'ordinary.txt'),null)
})

test('a failed save leaves the shared document and disk unchanged without an undo snapshot',async()=>{
  const hands=fixture('audit-agent-rollback')
  assert.equal(writeText(hands.sessionId,'ordinary.txt','before'),true)
  const file=getFileDoc(hands.sessionId,'ordinary.txt')!
  assert(file)
  const original=fs.renameSync
  const failing=mock.method(fs,'renameSync',(...args:Parameters<typeof fs.renameSync>)=>{
    if(String(args[1]).endsWith('/ordinary.txt'))throw Object.assign(new Error('simulated temporary I/O failure'),{code:'EIO'})
    return original(...args)
  })
  let updates = 0
  file.doc.on('update', () => { updates += 1 })
  let result
  try {result=await useTool(hands,'write_file',JSON.stringify({path:'ordinary.txt',content:'after'}))}
  finally {failing.mock.restore()}
  assert.equal(result.step.kind,'note')
  assert.equal(updates, 0, 'failed server changes must not broadcast')
  assert.equal(readText(hands.sessionId,'ordinary.txt')?.text,'before')
  assert.equal(currentText(hands.sessionId,'ordinary.txt'),'before')
  assert.equal(undoTurn(hands.sessionId,hands.entryId,'Tester'),null)
  flushSessionFiles(hands.sessionId)
  assert.equal(readText(hands.sessionId,'ordinary.txt')?.text,'before')
})


test('failed undo retains its snapshot and is retryable after disk recovery', async () => {
  const hands = fixture('undo-save-failure')
  writeText(hands.sessionId, 'ordinary.txt', 'before')
  getFileDoc(hands.sessionId, 'ordinary.txt')
  const result = await useTool(hands, 'write_file', JSON.stringify({path:'ordinary.txt',content:'after'}))
  assert.equal(result.step.kind, 'write')
  const entry = getChat(getSessionDoc(hands.sessionId).doc).toArray().find(e => e.get('id') === hands.entryId)!
  entry.set('undo', 'available')
  const original = fs.renameSync
  const failing = mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]).endsWith('/ordinary.txt')) throw Object.assign(new Error('temporary EIO'), {code:'EIO'})
    return original(...args)
  })
  try { assert.equal(undoTurn(hands.sessionId, hands.entryId, 'Tester'), 0) }
  finally { failing.mock.restore() }
  assert.equal(currentText(hands.sessionId, 'ordinary.txt'), 'after')
  assert.equal(readText(hands.sessionId, 'ordinary.txt')?.text, 'after')
  assert.equal(entry.get('undo'), 'available')
  assert.equal(undoTurn(hands.sessionId, hands.entryId, 'Tester'), 1)
  assert.equal(currentText(hands.sessionId, 'ordinary.txt'), 'before')
  assert.equal(entry.get('undo'), 'done')
})

test('a failed first save does not leave an empty file behind', async () => {
  const hands = fixture('agent-failed-create')
  const original = fs.renameSync
  const failing = mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]).endsWith('/new.txt')) throw Object.assign(new Error('temporary EIO'), {code:'EIO'})
    return original(...args)
  })
  try {
    const result = await useTool(hands, 'write_file', JSON.stringify({path:'new.txt',content:'after'}))
    assert.equal(result.step.kind, 'note')
  } finally { failing.mock.restore() }
  assert.equal(readText(hands.sessionId, 'new.txt'), null)
  assert.equal(undoTurn(hands.sessionId, hands.entryId, 'Tester'), null)
})
