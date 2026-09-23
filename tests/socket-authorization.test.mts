import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as sync from 'y-protocols/sync'
import { createSession, isFinished, setRules, db } from '../server/src/db.js'
import { createTeacher, rotateLinkKey, deleteTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { signToken, verifyToken, signHandoffToken, verifyHandoffToken } from '../server/src/auth.js'
import { roleFor } from '../server/src/routes/sessions.js'
import { handleControlSocket, closeControlRoom } from '../server/src/control.js'
import { handleCollabSocket, getSessionDoc } from '../server/src/collab/index.js'
import { handleFileSocket, getFileDoc, currentText, forgetFiles } from '../server/src/collab/files.js'
import { writeText } from '../server/src/workspace.js'
import { LECTURE_ROOM } from '../shared/rules.js'
import { META_KEY } from '../shared/notebook.js'

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN; bufferedAmount = 0; heard: unknown[] = []; closed: number | null = null
  send(frame: unknown, ...args: unknown[]) { this.heard.push(frame); for (const arg of args) if (typeof arg === 'function') arg() }
  ping() {}
  terminate() { this.readyState = WebSocket.CLOSED; this.emit('close') }
  close(code: number) { this.closed ??= code; if (this.readyState !== WebSocket.CLOSED) this.terminate() }
}
function frame(update: Uint8Array) { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); sync.writeUpdate(enc, update); return encoding.toUint8Array(enc) }

for (const action of ['remove', 'rotate', 'external-rotate'] as const) test(`staff ${action} revokes already-open control, notebook and file sockets`, () => {
  const id = `socket-auth-${action}`
  createSession(id, 'Authorization regression', null)
  setRules(id, LECTURE_ROOM)
  const teacher = createTeacher({name:'Temporary',email:`${id}@test.local`,role:'teacher'})!
  let cookie = ''
  issueStaffCookie({cookie:(name:string,value:string)=>{cookie=`${name}=${value}`}} as any, teacher)
  const payload = {sessionId:id,participantId:'temporary',role:roleFor(cookie,{sessionId:id,participantId:'temporary'})}
  const credentials = {cookieHeader:cookie,payload}
  assert.equal(payload.role, 'host')
  const control = new Socket(), notebook = new Socket(), file = new Socket()
  ;(handleControlSocket as any)(control,id,payload,credentials)
  ;(handleCollabSocket as any)(notebook,id,payload.role,payload.participantId,credentials)
  writeText(id,'ordinary.txt','before')
  ;(handleFileSocket as any)(file,id,'ordinary.txt',payload.role,payload.participantId,credentials)
  const doc = getSessionDoc(id).doc
  const clone = new Y.Doc(); Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc))
  const before = Y.encodeStateVector(clone); clone.getMap(META_KEY).set('title','revoked edit')
  const fileClone = new Y.Doc(); Y.applyUpdate(fileClone, Y.encodeStateAsUpdate(getFileDoc(id,'ordinary.txt')!.doc))
  const beforeFile = Y.encodeStateVector(fileClone); fileClone.getText('text').insert(0,'revoked ')
  if (action === 'remove') deleteTeacher(teacher.id)
  else if (action === 'rotate') rotateLinkKey(teacher.id)
  else db.prepare('UPDATE staff SET auth_version = auth_version + 1 WHERE id = ?').run(teacher.id)
  control.emit('message',Buffer.from(JSON.stringify({t:'class:finish'})),false)
  notebook.emit('message',frame(Y.encodeStateAsUpdate(clone,before)))
  file.emit('message',frame(Y.encodeStateAsUpdate(fileClone,beforeFile)))
  assert.equal(isFinished(id),false, 'stale host control command was accepted')
  assert.notEqual(doc.getMap(META_KEY).get('title'),'revoked edit')
  assert.equal(currentText(id,'ordinary.txt'),'before')
  assert.deepEqual([control.closed,notebook.closed,file.closed],[4401,4401,4401])
  closeControlRoom(id); forgetFiles(id); clone.destroy(); fileClone.destroy()
})

test('rotating a staff link durably invalidates handed-off tokens and unclaimed links', () => {
  const teacher = createTeacher({name:'Temporary',email:'handoff-version@test.local',role:'teacher'})!
  const payload = {sessionId:'handoff-version',participantId:'temporary',role:'host' as const,staff:teacher.id}
  const token = signToken(payload)
  const handoff = signHandoffToken(payload.sessionId,payload.participantId,teacher.id)
  assert.equal(roleFor(undefined,verifyToken(token)!), 'host')
  assert.ok(verifyHandoffToken(payload.sessionId,handoff))
  rotateLinkKey(teacher.id)
  assert.equal(roleFor(undefined,verifyToken(token)!), 'participant')
  assert.equal(verifyHandoffToken(payload.sessionId,handoff),null)
  assert.equal(roleFor(undefined,verifyToken(signToken(payload))!), 'host')
})
