/**
 * Which exit a notebook guest leaves by.
 *
 * `visitSessionDoc` (server/src/routes/doc-visit.ts) brings up the document
 * of an empty room for the sake of one line — a rename in the panel, reading
 * the feed, publishing — and must let it go by eviction without closing
 * anything (`releaseSessionDoc`), not by the seminar-deletion door
 * (`dropSessionDoc`). The difference shows in exactly one place: file
 * sockets live in their own map (collab/files.ts), do not bring up the room
 * document and survive the idle clean-up — so a `.py` open in the editor
 * lives on until the end of the class. The deletion door would slam it with
 * code 1001 "room closed", and a person typing a function would see the
 * connection drop because someone in the panel renamed the neighbouring
 * seminar.
 *
 * The test guards exactly the choice of door: `tests/collab-release.test.mts`
 * pins the doors themselves, and here — that the visit goes through the
 * right one.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { WebSocket } from 'ws'
import { createSession, getSession } from '../server/src/db.js'
import { sessionDir } from '../server/src/workspace.js'
import { getSessionDoc, peekSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { getFileDoc, handleFileSocket } from '../server/src/collab/files.js'
import { visitSessionDoc } from '../server/src/routes/doc-visit.js'
import { cellSource, createCell, getCells, getMeta } from '../shared/notebook.js'

after(() => shutdownCollab())

/** A socket recording frames instead of a real one: all that matters is whether it was closed. */
function fakeSocket() {
  const sent: Uint8Array[] = []
  let closed: { code: number; reason: string } | null = null
  const ws = {
    readyState: 1,
    binaryType: '',
    on() {
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
    get closed() {
      return closed
    },
  }
}

test('a visit to an empty room does not slam an open file socket', () => {
  const id = 'visit-release'
  createSession(id, 'Прошлогодний семинар', null)

  // The class's work in the notebook, and the cold path: nothing of the
  // document in memory, everything on disk. Exactly the state a rename
  // finds the room in.
  {
    const { doc } = getSessionDoc(id)
    const cells = getCells(doc)
    cells.delete(0, cells.length)
    const cell = createCell('code', '')
    cells.push([cell])
    cellSource(cell).insert(0, 'x = 1')
    shutdownCollab()
  }
  assert.equal(peekSessionDoc(id), null, 'the room stayed in memory — the test checks nothing')

  // And next door a class is going on: someone is editing a room file in the
  // editor.
  const file = 'utils.py'
  fs.writeFileSync(path.join(sessionDir(id), file), 'def f():\n    return 1\n')
  assert.ok(getFileDoc(id, file), 'the room file did not open — the test checks nothing')
  const editor = fakeSocket()
  handleFileSocket(editor.ws, id, file, 'host', 'p_host')
  assert.equal(editor.closed, null, 'the file socket closed already at the handshake')
  assert.equal(peekSessionDoc(id), null, 'an open file brought up the room document')

  // The same thing a rename in the panel does (routes/admin-instance.ts).
  visitSessionDoc(id, (doc) => getMeta(doc).set('title', 'Семинар 3'))

  assert.equal(editor.closed, null, 'the visit went through the deletion door and closed someone else\'s editor')
  assert.equal(peekSessionDoc(id), null, 'the visit settled the notebook in memory')
  assert.ok(getSession(id), 'the visit deleted the seminar itself')

  // And what was written reached the disk — the eviction leaves silently.
  const { doc } = getSessionDoc(id)
  assert.equal(getMeta(doc).get('title'), 'Семинар 3')
  const cells = getCells(doc)
  assert.equal(cells.length, 1, 'the notebook came up not from its own snapshot')
  assert.equal(cellSource(cells.get(0)).toString(), 'x = 1')
})
