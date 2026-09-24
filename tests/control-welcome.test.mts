/**
 * The control socket's welcome batch — and its caches.
 *
 * The file tree and the lecture ink were rebuilt for EVERY connection: a walk
 * of the folder with an lstat per entry, and a flat list of every stroke on
 * every page plus `JSON.stringify` — up to a megabyte. While people come in one
 * at a time, the cost goes unnoticed; after a server restart five hundred tabs
 * come back within one second, and five hundred identical builds land on the
 * event loop exactly where everyone is waiting to get back in. Now the frame is
 * built once per room.
 *
 * What is checked here is not speed (an assertion has nothing to measure it
 * with) but the very thing that makes a cache dangerous: it must go stale. A
 * room where a file was created or a stroke added gives the next person to
 * join the new state, not yesterday's.
 *
 * Since then the ink in the batch is cut down to the page being shown, while an
 * inventory travels for the rest — and the cache became keyed on the pair
 * "change + page". The per-page delivery itself is checked separately
 * (lecture-ink-server); here, only going stale.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { addInk, startLecture, stopLecture } from '../server/src/lecture.js'
import { OPEN_ROOM } from '../shared/rules.js'
import type { ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

interface Fake {
  ws: WebSocket
  heard: ControlServerMessage[]
}

function socket(): Fake {
  const heard: ControlServerMessage[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      // As a string or as bytes: the frames the server builds once per room
      // (the tree, the ink) go out already encoded — see control.ts ·
      // sendFrame. A real socket makes no difference here, and neither does
      // the fake.
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on() {
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
    },
  }
  return { ws: fake as unknown as WebSocket, heard }
}

let rooms = 0

function room(): string {
  const id = `welcome-${++rooms}`
  createSession(id, 'Пачка', null)
  setRules(id, { ...OPEN_ROOM })
  return id
}

function who(sessionId: string, participantId: string): TokenPayload {
  return { sessionId, participantId, role: 'host' }
}

/** One more person joining the same room. */
function enter(sock: Fake, sessionId: string, participantId: string): void {
  handleControlSocket(sock.ws, sessionId, who(sessionId, participantId))
}

/** The file list this socket received; `null` if it received none at all. */
function files(sock: Fake): string[] | null {
  for (let i = sock.heard.length - 1; i >= 0; i--) {
    const m = sock.heard[i]
    if (m.t === 'files') return m.files.map((f) => f.path).sort()
  }
  return null
}

/** The ink this socket received. */
function ink(sock: Fake): number {
  for (let i = sock.heard.length - 1; i >= 0; i--) {
    const m = sock.heard[i]
    if (m.t === 'ink') return m.strokes.length
  }
  return -1
}

test('the tree comes from the cache, yet the next person to join sees a new file', () => {
  const id = room()
  const first = socket()
  enter(first, id, 'p_1')
  assert.deepEqual(files(first), [], 'an empty room means an empty list, not silence')

  // A second socket in the same window: the same frame, built once.
  const second = socket()
  enter(second, id, 'p_2')
  assert.deepEqual(files(second), [])

  // A file is created through the control channel: the broadcast recomputes
  // the tree and stores the fresh one.
  dispatch(first.ws, id, who(id, 'p_1'), { t: 'tree:new', path: 'разбор.py' })
  const third = socket()
  enter(third, id, 'p_3')
  assert.deepEqual(files(third), ['разбор.py'], 'the newcomer received the tree from before the edit')
  // And to the whole room, with the same broadcast frame.
  assert.deepEqual(files(second), ['разбор.py'])
  closeControlRoom(id)
})

test('the ink comes from the cache, yet the next person to join sees an added stroke', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  addInk(id, { id: 's1', page: 1, color: '#000', width: 2, points: [1, 1, 2, 2] })

  const first = socket()
  enter(first, id, 'p_1')
  assert.equal(ink(first), 1)

  const second = socket()
  enter(second, id, 'p_2')
  assert.equal(ink(second), 1, 'the latecomer did not see what had already been drawn')

  // A stroke on the SAME page is the one the cache has to go stale for. A
  // neighbouring page no longer travels in this frame at all: the inventory
  // (`ink:pages`) speaks for it, and the tab asks for it separately — see
  // lecture-ink-server.
  addInk(id, { id: 's2', page: 1, color: '#000', width: 2, points: [3, 3, 4, 4] })
  const third = socket()
  enter(third, id, 'p_3')
  assert.equal(ink(third), 2, "the newcomer was sent yesterday's ink")

  stopLecture(id)
  closeControlRoom(id)
})

