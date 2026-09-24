/**
 * Evicting a banned person: over all wires at once.
 *
 * A ban closes three doors: the notebook, the control socket and the file.
 * `evictBanned` closes the first two with its own hands; the third, the
 * editor's file socket, is held by another module, and it learns about the
 * eviction from an event (bans.ts · onEviction). Before the event existed,
 * a banned student kept typing into the shared `utils.py` until they
 * reloaded the page themselves: the close reached the notebook and the
 * control socket, but not the editor tab.
 *
 * What is checked here is the announcement itself: that it goes out, that
 * it carries the room and the person, and that a failing listener does not
 * take the others down with it: the ban is already in the database, and a
 * wire that did not close is no reason to cancel it.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { onEviction } from '../server/src/bans.js'
import { closeControlRoom, evictBanned, handleControlSocket } from '../server/src/control.js'
import type { ControlServerMessage } from '../shared/protocol.js'

const heardEvictions: { sessionId: string; participantId: string }[] = []
let brokenCalled = 0

// Both listeners are for the whole file: a subscription lives as long as the process.
onEviction(() => {
  brokenCalled += 1
  throw new Error('this wire fails today')
})
onEviction((sessionId, participantId) => heardEvictions.push({ sessionId, participantId }))

function socket(): { ws: WebSocket; heard: ControlServerMessage[]; closed: number[] } {
  const heard: ControlServerMessage[] = []
  const closed: number[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      // As a string or as bytes: frames the server builds once per room
      // (broadcast, tree, ink) go out already encoded; see
      // control.ts · sendFrame. A real socket makes no difference here.
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on() {
      return this
    },
    ping() {},
    terminate() {},
    close(code: number) {
      closed.push(code)
      fake.readyState = WebSocket.CLOSED
    },
  }
  return { ws: fake as unknown as WebSocket, heard, closed }
}

test('a ban is announced to every wire, and a failing listener does not take the others down', () => {
  const id = 'evict-1'
  createSession(id, 'Бан', null)
  upsertParticipant({ id: 'p_petya', sessionId: id, name: 'Петя', avatar: null, role: 'participant' })
  upsertParticipant({ id: 'p_ada', sessionId: id, name: 'Ада', avatar: null, role: 'host' })
  const petya = socket()
  const ada = socket()
  handleControlSocket(petya.ws, id, { sessionId: id, participantId: 'p_petya', role: 'participant' })
  handleControlSocket(ada.ws, id, { sessionId: id, participantId: 'p_ada', role: 'host' })

  const until = Date.now() + 60_000
  evictBanned(id, 'p_petya', until)

  // The frame comes BEFORE the close: otherwise the tab sees a drop and silently goes to reconnect.
  const banned = petya.heard.find((m) => m.t === 'banned')
  assert.ok(banned && banned.t === 'banned', 'the banned person was not told what happened')
  assert.equal(banned.until, until)
  assert.deepEqual(petya.closed, [1008], 'the control socket of the banned person stayed open')
  assert.deepEqual(ada.closed, [], 'the wrong socket was closed')

  assert.equal(brokenCalled, 1, 'the failing listener was not called')
  assert.deepEqual(
    heardEvictions,
    [{ sessionId: id, participantId: 'p_petya' }],
    'the second wire did not learn about the eviction',
  )
  closeControlRoom(id)
})
