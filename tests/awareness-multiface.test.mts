/**
 * A presence frame with SEVERAL faces.
 *
 * The ownership check (`ownAwareness`) walks the wire by hand: it reads the
 * clientID and the clock and skips over the state. While a frame has one
 * face, any mistake in the step is invisible: nobody reads anything after
 * the loop, and all the earlier presence tests have a single face. From the
 * second face on, an offset of a couple of bytes turns the clientID into a
 * random byte of someone else's JSON, and the check starts letting someone
 * else's presence into the room, exactly what it was written against.
 *
 * So the frames here are real and always multi-face:
 * `encodeAwarenessUpdate` over a bag of states, not over one.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { WebSocket } from 'ws'
import { ownAwareness } from '../server/src/collab/index.js'

/** A face with its own clientID and a state of a given size. */
function face(name: string): Awareness {
  const it = new Awareness(new Y.Doc())
  it.setLocalStateField('user', { name, color: '#8b5cf6' })
  return it
}

/**
 * A bag of states from which a frame for several faces is built.
 *
 * That is how a real client sends them: `y-websocket` returns every applied
 * presence update to the server, and applyAwarenessUpdate manages to gather
 * in one tick both its own face and someone else's that arrived from the
 * server.
 */
function bagOf(...faces: Awareness[]): Awareness {
  const bag = new Awareness(new Y.Doc())
  for (const it of faces) applyAwarenessUpdate(bag, encodeAwarenessUpdate(it, [it.clientID]), 'bag')
  return bag
}

function frame(bag: Awareness, faces: Awareness[]): Uint8Array {
  return encodeAwarenessUpdate(
    bag,
    faces.map((it) => it.clientID),
  )
}

test('two own faces in one frame land in the socket as they are', () => {
  /*
   * A name longer than a hundred characters is not showing off: the state
   * length is on the wire as a varint, and up to 127 bytes it is one byte.
   * On a short state an offset of one byte coincides with the start of the
   * next record and may go unnoticed; on a long one the varint is two bytes,
   * and the misalignment shows at once.
   */
  const room = new Awareness(new Y.Doc())
  const first = face(`Анна Каренина, ${'очень длинное имя '.repeat(8)}`)
  const second = face('Пётр')
  const bag = bagOf(first, second)

  const socket = {} as WebSocket
  const state = { clientIds: new Set<number>() }
  const entry = { awareness: room, conns: new Map([[socket, state]]) }

  assert.equal(
    ownAwareness(entry, socket, frame(bag, [first, second])),
    true,
    'a frame with two own faces was rejected',
  )
  assert.deepEqual(
    [...state.clientIds].sort((a, b) => a - b),
    [first.clientID, second.clientID].sort((a, b) => a - b),
    'the socket remembered the wrong faces: the decoder drifted on the second',
  )

  first.destroy()
  second.destroy()
  bag.destroy()
  room.destroy()
})

test('a foreign face second in the frame does not slip past the ownership check', () => {
  /*
   * That very bypass: one's own face first, a foreign one second. If parsing
   * drifts, garbage is read second, the garbage passes the check (there is
   * no such clientID in the room), the frame is declared one's own and
   * applied WHOLE, that is, someone else's cursor, name and role are
   * rewritten from a foreign socket.
   */
  const room = new Awareness(new Y.Doc())
  const mine = face('Аня')
  const theirs = face('Пётр, которого сейчас перепишут')
  applyAwarenessUpdate(room, encodeAwarenessUpdate(theirs, [theirs.clientID]), 'peter')

  const socket = {} as WebSocket
  const state = { clientIds: new Set<number>() }
  const entry = { awareness: room, conns: new Map([[socket, state]]) }

  assert.equal(ownAwareness(entry, socket, encodeAwarenessUpdate(mine, [mine.clientID])), true)

  const bag = bagOf(mine, theirs)
  assert.equal(
    ownAwareness(entry, socket, frame(bag, [mine, theirs])),
    false,
    'the socket rewrote the presence of another person with the second face in the frame',
  )
  assert.deepEqual(
    [...state.clientIds],
    [mine.clientID],
    'the socket got a face it did not bring',
  )

  mine.destroy()
  theirs.destroy()
  bag.destroy()
  room.destroy()
})

test('the socket is credited with exactly the faces the frame will then apply', () => {
  /*
   * The main cross-check: `ownAwareness` reads the frame WITH ITS OWN HANDS,
   * and `applyAwarenessUpdate` then applies it by the protocol. The lists
   * must match, otherwise everything that relies on `state.clientIds` counts
   * the wrong ones: the face ceiling (:981) measures from garbage, and
   * `closeConn` on the way out removes presence by this same list and takes
   * out of the people panel an outsider whose clientID happened to match.
   *
   * Three faces in the frame, not two: decoder drift accumulates, and by the
   * third the records have diverged far.
   */
  const room = new Awareness(new Y.Doc())
  const faces = [face('Аня'), face('Аня с планшета'), face('Аня с проектора')]
  const bag = bagOf(...faces)

  const socket = {} as WebSocket
  const state = { clientIds: new Set<number>() }
  const entry = { awareness: room, conns: new Map([[socket, state]]) }

  assert.equal(ownAwareness(entry, socket, frame(bag, faces)), true, 'the frame was rejected')
  applyAwarenessUpdate(room, frame(bag, faces), socket)

  // The room's own face (`Awareness` creates it itself) did not come in the frame.
  const applied = [...room.getStates().keys()].filter((id) => id !== room.clientID)
  assert.deepEqual(
    [...state.clientIds].sort((a, b) => a - b),
    applied.sort((a, b) => a - b),
    'the socket was credited with faces other than the ones the frame put into the room',
  )

  for (const it of faces) it.destroy()
  bag.destroy()
  room.destroy()
})
