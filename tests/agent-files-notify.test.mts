import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession } from '../server/src/db.js'
import { closeControlRoom, handleControlSocket } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { getFileDoc, flushFile, TEXT_KEY } from '../server/src/collab/files.js'
import { useTool, type Hands } from '../server/src/ai/agent.js'
import { createChatEntry, getChat } from '../shared/notebook.js'
import { readText } from '../server/src/workspace.js'
import type { ControlServerMessage } from '../shared/protocol.js'

function seat(id: string, participantId: string) {
  const heard: ControlServerMessage[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: unknown) => heard.push(JSON.parse(String(frame))),
    on() { return this }, ping() {}, close() {}, terminate() {},
  } as unknown as WebSocket
  handleControlSocket(ws, id, { sessionId: id, participantId, role: 'host' })
  heard.length = 0
  return heard
}

test('agent file creation and updates reach every file panel before the tool reports success', async () => {
  const id = 'agent-files-now'
  createSession(id, 'Immediate files')
  const { doc } = getSessionDoc(id)
  const entry = createChatEntry({ participantId: 'teacher', name: 'Teacher', color: '#123456', question: 'Create notebook', mode: 'agent' })
  getChat(doc).push([entry])
  const hands: Hands = { sessionId: id, entryId: entry.get('id'), by: { name: 'Teacher', color: '#123456', participantId: 'teacher' }, role: 'host' }
  const teacher = seat(id, 'teacher'), student = seat(id, 'student')
  const name = '02_Mini_proekt_recommender.ipynb'
  const content = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Рекомендатель'] }], nbformat: 4 })
  try {
    const made = await useTool(hands, 'write_file', JSON.stringify({ path: name, content }))
    assert.equal(made.step.kind, 'new')
    for (const messages of [teacher, student]) {
      const file = messages.flatMap(message => message.t === 'files' ? message.files : []).find(file => file.path === name)
      assert.ok(file, 'new file did not arrive until an unrelated background event')
      assert.equal(file.size, Buffer.byteLength(content), 'file was announced while still empty')
    }
    assert.equal(readText(id, name)?.text, content)

    for (const open of [false, true]) {
      if (open) getFileDoc(id, name)
      teacher.length = 0; student.length = 0
      const next = content + (open ? '\n\n' : '\n')
      const result = await useTool(hands, 'write_file', JSON.stringify({ path: name, content: next }))
      assert.equal(result.step.kind, 'write')
      for (const messages of [teacher, student]) {
        const file = messages.flatMap(message => message.t === 'files' ? message.files : []).find(file => file.path === name)
        assert.equal(file?.size, Buffer.byteLength(next), 'explicit write was delayed by editor autosave throttling')
      }
    }

    // Typing in the editor still coalesces list refreshes; it must not gain the
    // per-action broadcast used by the agent.
    teacher.length = 0; student.length = 0
    const editor = getFileDoc(id, name)
    const text = editor.doc.getText(TEXT_KEY)
    text.insert(text.length, '\n')
    flushFile(id, name)
    assert.equal(teacher.some(message => message.t === 'files'), false)
    await new Promise(resolve => setTimeout(resolve, 450))
    const refreshed = teacher.flatMap(message => message.t === 'files' ? message.files : []).find(file => file.path === name)
    assert.equal(refreshed?.size, Buffer.byteLength(text.toString()))
  } finally { closeControlRoom(id) }
})
