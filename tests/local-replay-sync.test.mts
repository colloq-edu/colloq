import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { WebsocketProvider, messageSync } from 'y-websocket'
import * as decoding from 'lib0/decoding'
import { messageYjsSyncStep2, messageYjsUpdate } from 'y-protocols/sync'
import { createCell, getCells, cellSource } from '../shared/notebook.js'
import { classify, permits, MAX_SYNC_FRAME_BYTES, MAX_SYNC_STEP2_BYTES } from '../server/src/collab/gate.js'
import { syncLocalReplay } from '../web/src/lib/local-replay-sync.js'
import { OPEN_ROOM } from '../shared/rules.js'

function harness() {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider('ws://127.0.0.1', 'replay-test', doc, { connect:false, disableBc:true })
  const origin = {}
  syncLocalReplay(provider, {isReplay: (value) => value === origin})
  const frames: Uint8Array[] = []
  provider.ws = { OPEN:1, readyState:1, send:(frame:Uint8Array)=>frames.push(frame), close() {} } as unknown as WebSocket
  provider.wsconnected = true
  return {doc,provider,origin,frames,close(){provider.wsconnected=false;provider.ws=null;provider.destroy();doc.destroy()}}
}
function read(frame: Uint8Array) {
  const decoder = decoding.createDecoder(frame)
  assert.equal(decoding.readVarUint(decoder), messageSync)
  return {type:decoding.readVarUint(decoder),update:decoding.readVarUint8Array(decoder)}
}
function notebook(text: string) {
  const doc = new Y.Doc()
  getCells(doc).push([createCell('markdown', text)])
  return doc
}

test('a slow local cache replay on an open socket uses the sync budget, not the keystroke budget',()=>{
  const server=notebook('Cached course material. '.repeat(14000))
  const h=harness()
  try {
    Y.applyUpdate(h.doc,Y.encodeStateAsUpdate(server),h.origin)
    const frame=read(h.frames[0])
    assert.ok(frame.update.length>MAX_SYNC_FRAME_BYTES)
    assert.equal(frame.type,messageYjsSyncStep2)
    const result=classify(server,frame.update,MAX_SYNC_STEP2_BYTES)
    assert.equal(result.ok,true)
    if(result.ok)assert.deepEqual(result.verdicts,[])
  } finally {h.close();server.destroy()}
})

test('offline edits in a replay remain subject to the server rules and protected fields',()=>{
  const server=notebook('Original')
  const cached=new Y.Doc();Y.applyUpdate(cached,Y.encodeStateAsUpdate(server))
  cellSource(getCells(cached).get(0)).insert(0,'Offline edit. ')
  const h=harness()
  try {
    Y.applyUpdate(h.doc,Y.encodeStateAsUpdate(cached),h.origin)
    const frame=read(h.frames[0]);assert.equal(frame.type,messageYjsSyncStep2)
    const judged=classify(server,frame.update,MAX_SYNC_STEP2_BYTES);assert.equal(judged.ok,true)
    if(judged.ok){assert.equal(permits(judged.verdicts,OPEN_ROOM,'participant').ok,true);assert.equal(permits(judged.verdicts,{...OPEN_ROOM,edit:'host'},'participant',true).ok,false)}
    getCells(cached).get(0).set('runBy','forged')
    Y.applyUpdate(h.doc,Y.encodeStateAsUpdate(cached),h.origin)
    const forged=read(h.frames.at(-1)!);assert.equal(classify(server,forged.update,MAX_SYNC_STEP2_BYTES).ok,false)
  } finally {h.close();cached.destroy();server.destroy()}
})

test('ordinary edits keep the 256KB limit and server-origin updates are never echoed',()=>{
  const server=notebook('Original'),h=harness()
  try {
    Y.applyUpdate(h.doc,Y.encodeStateAsUpdate(server),h.provider)
    assert.equal(h.frames.length,0)
    cellSource(getCells(h.doc).get(0)).insert(0,'x'.repeat(MAX_SYNC_FRAME_BYTES+1))
    const frame=read(h.frames[0]);assert.equal(frame.type,messageYjsUpdate)
    assert.equal(classify(server,frame.update).ok,false)
  } finally {h.close();server.destroy()}
})

test('cache replay while disconnected waits for the normal handshake, and later replays remain sync messages',()=>{
  const server=notebook('Cached'),h=harness()
  try {
    h.provider.wsconnected=false
    Y.applyUpdate(h.doc,Y.encodeStateAsUpdate(server),h.origin)
    assert.equal(h.frames.length,0)
    h.provider.wsconnected=true
    cellSource(getCells(server).get(0)).insert(0,'Another tab. ')
    Y.applyUpdate(h.doc,Y.encodeStateAsUpdate(server),h.origin)
    assert.equal(read(h.frames[0]).type,messageYjsSyncStep2)
    h.frames.length=0
    h.provider.destroy()
    h.frames.length=0
    cellSource(getCells(server).get(0)).insert(0,'After teardown. ')
    Y.applyUpdate(h.doc,Y.encodeStateAsUpdate(server),h.origin)
    assert.equal(h.frames.length,0)
  } finally {h.close();server.destroy()}
})
