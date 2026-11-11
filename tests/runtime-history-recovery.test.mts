import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { appendVersion, createSession, db, getSession, saveDocSnapshot, versionCount } from '../server/src/db.js'
import { getSessionDoc, handleCollabSocket, shutdownCollab } from '../server/src/collab/index.js'
import { cellsAt, flushHistory } from '../server/src/collab/history.js'
import { ensureInitialNotebook, getCells, cellSource, getMeta } from '../shared/notebook.js'

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN
  bufferedAmount = 0
  binaryType = 'arraybuffer'
  frames: Uint8Array[] = []
  send(frame: Uint8Array, _options: unknown, done?: (err?: Error) => void) { this.frames.push(frame); done?.() }
  ping() {}
  terminate() { this.close() }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close') }
}
after(() => shutdownCollab())

for (const failure of ['readonly', 'full']) for (const repair of [false, true]) test(`history ${repair ? 'repair' : 'initial base'} ${failure} failure does not leave a partially admitted room`, async (t) => {
  const id = `runtime-history-${failure}-${repair}`
  createSession(id, 'before')
  const seed = new Y.Doc()
  ensureInitialNotebook(seed, 'before')
  if (repair) {
    appendVersion({ sessionId: id, update: Y.encodeStateAsUpdate(seed), kind: 'opened', authorId: null, createdAt: Date.now(), label: null, summary: 'base', added: 0, removed: 0, cells: [] })
    cellSource(getCells(seed).get(0)).insert(0, 'unrecorded before restart\n')
  }
  saveDocSnapshot(id, Y.encodeStateAsUpdate(seed))
  seed.destroy()
  t.mock.method(console, 'error', () => {})
  if (failure === 'readonly') db.pragma('query_only = ON')
  else db.exec("CREATE TEMP TRIGGER runtime_full_history BEFORE INSERT ON doc_history BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END")
  try { assert.doesNotThrow(() => getSessionDoc(id), 'unavailable history must not interrupt room admission') }
  finally {
    db.pragma('query_only = OFF')
    if (failure === 'full') db.exec('DROP TRIGGER runtime_full_history')
  }
  const { doc } = getSessionDoc(id)
  const socket = new Socket()
  handleCollabSocket(socket as unknown as WebSocket, id, 'host')
  socket.frames.length = 0
  doc.transact(() => {
    cellSource(getCells(doc).get(0)).insert(0, 'edited after recovery\n')
    getMeta(doc).set('title', 'after')
  })
  await new Promise(resolve => setImmediate(resolve))
  flushHistory(id)
  assert.ok(socket.frames.length > 0, 'edits still broadcast after history storage recovers')
  assert.equal(getSession(id)?.name, 'after', 'title observer is installed')
  assert.ok(versionCount(id) >= 2)
  const visible = db.prepare("SELECT MAX(seq) AS seq FROM doc_history WHERE session_id = ? AND kind = 'edit'").get(id) as { seq: number }
  assert.equal(cellsAt(id, visible.seq)[0]?.source, cellSource(getCells(doc).get(0)).toString(), 'the first visible recovered version must restore the full notebook, before any hidden keyframe')
  const row = db.prepare('SELECT MAX(seq) AS seq FROM doc_history WHERE session_id = ?').get(id) as { seq: number }
  const restored = cellsAt(id, row.seq)
  assert.equal(restored[0].source, cellSource(getCells(doc).get(0)).toString(), 'recovery writes a complete base rather than unreplayable deltas')
  socket.close()
})
