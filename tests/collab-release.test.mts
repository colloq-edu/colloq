/**
 * Two doors out of memory: releasing a room and deleting a class.
 *
 * `dropSessionDoc` is written for DELETION: it closes the room's sockets and
 * its open files. But whoever merely looked into the notebook for one line
 * (routes/doc-visit.ts) — a rename in the panel, reading the feed,
 * publishing — also wants to evict the document. That caller needs a door that
 * closes nothing: file sockets live in their own map and do not load the room
 * document, so a `.py` open in the editor calmly survives eviction — while the
 * deletion door would slam it with code 1001 "room closed" in the middle of a
 * live class.
 *
 * Exactly this difference is pinned down here: what `releaseSessionDoc`
 * releases (and what must reach the disk as it does), what it leaves alone,
 * and what it does not do to a room with people in it.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { WebSocket } from 'ws'
import { createSession, getSession } from '../server/src/db.js'
import { sessionDir } from '../server/src/workspace.js'
import {
  dropSessionDoc,
  getSessionDoc,
  handleCollabSocket,
  peekSessionDoc,
  releaseSessionDoc,
  shutdownCollab,
} from '../server/src/collab/index.js'
import { getFileDoc, handleFileSocket } from '../server/src/collab/files.js'
import { cellSource, createCell, getCells } from '../shared/notebook.js'

after(() => shutdownCollab())

/**
 * A socket that records its frames instead of a real one.
 *
 * `send` is called with two arguments and with three (message, compression
 * options, callback); the last argument is the one that has to be called.
 */
function fakeSocket() {
  const handlers = new Map<string, (arg?: unknown) => void>()
  const sent: Uint8Array[] = []
  let closed: { code: number; reason: string } | null = null
  const ws = {
    readyState: 1,
    binaryType: '',
    on(event: string, handler: (arg?: unknown) => void) {
      handlers.set(event, handler)
      return ws
    },
    ping() {},
    terminate() {},
    send(message: Uint8Array, ...rest: unknown[]) {
      sent.push(message)
      const done = rest[rest.length - 1]
      if (typeof done === 'function') (done as (err?: Error) => void)()
    },
    close(code: number, reason: string) {
      closed ??= { code, reason }
      ws.readyState = 3
    },
  }
  return {
    ws: ws as unknown as WebSocket,
    sent,
    get closed() {
      return closed
    },
    handlers,
  }
}

/** The class's work: a cell in the notebook and a file open next to it. */
function room(id: string, file: string): ReturnType<typeof fakeSocket> {
  createSession(id, 'Прошлогодний семинар', null)
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  cells.delete(0, cells.length)
  const cell = createCell('code', '')
  cells.push([cell])
  cellSource(cell).insert(0, 'x = 1')

  fs.writeFileSync(path.join(sessionDir(id), file), 'def f():\n    return 1\n')
  assert.ok(getFileDoc(id, file), "the room's file did not open, so the test checks nothing")
  const socket = fakeSocket()
  handleFileSocket(socket.ws, id, file, 'host', 'p_host')
  assert.equal(socket.closed, null, 'the file socket closed already during the handshake')
  return socket
}

test('eviction releases the document after flushing it and does not close the open file', () => {
  const id = 'release-cold'
  const editor = room(id, 'utils.py')

  assert.equal(releaseSessionDoc(id), true)
  assert.equal(peekSessionDoc(id), null, 'the document stayed in memory')
  assert.equal(editor.closed, null, "eviction slammed the open file's socket")
  assert.ok(getSession(id), 'eviction deleted the class itself')

  /*
   * And what was written reached the disk: eviction leaves silently, and if the
   * snapshot is not flushed, the next person to join loads the notebook without
   * the last edit — the edit happened, and after a restart it is gone.
   */
  const cells = getCells(getSessionDoc(id).doc)
  assert.equal(cells.length, 1, 'the notebook was not loaded from its own snapshot')
  assert.equal(cellSource(cells.get(0)).toString(), 'x = 1')
})

test('deleting a class, by contrast, closes the file socket; that is how the doors differ', () => {
  const id = 'release-drop'
  const editor = room(id, 'utils.py')

  dropSessionDoc(id)
  assert.equal(peekSessionDoc(id), null)
  assert.equal(editor.closed?.code, 1001, 'deletion left the file of the deleted room open')
})

test('eviction leaves a room with people in it alone', () => {
  const id = 'release-live'
  createSession(id, 'Идущая пара', null)
  const { doc } = getSessionDoc(id)
  const tab = fakeSocket()
  handleCollabSocket(tab.ws, id, 'host', 'p_host')

  assert.equal(releaseSessionDoc(id), false, 'the document was evicted from under a live socket')
  assert.equal(peekSessionDoc(id)?.doc, doc, 'a room with people in it lost its document')
  assert.equal(tab.closed, null)
})

test('a room that is not in memory is not an error but "nothing to release"', () => {
  assert.equal(releaseSessionDoc('release-never-opened'), false)
})
