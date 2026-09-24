/**
 * What a broadcast costs a room of five hundred — in numbers, not by eye.
 *
 * Four things, each invisible with twenty listeners and taking up the whole
 * event loop with five hundred:
 *
 *   — merging edits was computed ANEW for every author (500 authors in one
 *     burst meant 1.4 s for a single broadcast);
 *   — presence went out as a frame per movement, to the sender as well, and
 *     `y-protocols` renews its state every 15 s even in a silent room;
 *   — the full list of faces was encoded anew for every newcomer (75 KB and
 *     5.5 ms per person, that is, 37 MB when the whole hall comes back);
 *   — the whole document for a cold tab was built anew for everyone and went
 *     out UNCOMPRESSED (the compression ceiling was written for kernel images,
 *     not for this).
 *
 * The sockets here are fake and remember THE buffer itself, not a copy: the
 * sameness of the reference is exactly the proof that it was encoded once.
 */
import './_env.mts'
import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { WebSocket } from 'ws'
import { createSession } from '../server/src/db.js'
import {
  FACES_WINDOW_MS,
  getSessionDoc,
  handleCollabSocket,
  onlineCount,
  shutdownCollab,
} from '../server/src/collab/index.js'
import { cellSource, getCells } from '../shared/notebook.js'

after(() => shutdownCollab())

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const faceWindow = (): Promise<void> => wait(FACES_WINDOW_MS + 50)

interface Sent {
  frame: Uint8Array
  compress: boolean
}

interface Fake {
  ws: WebSocket
  sent: Sent[]
  /** How many times the room asked this socket whether it is alive. */
  pings: number
  /** Tell the server what a tab would tell it. */
  fire(event: string, ...args: unknown[]): void
  pong(): void
  close(): void
}

/**
 * Exactly what `handleCollabSocket` reads — and WITHOUT copying the frame.
 *
 * A copy here would not be a detail: half of the checks below are about the
 * room building a frame once for everyone, and that can only be seen through
 * the reference.
 */
function socket(): Fake {
  const sent: Sent[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const out: Fake = {
    ws: null as unknown as WebSocket,
    sent,
    pings: 0,
    fire(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
    pong() {
      out.fire('pong')
    },
    close() {
      fake.close()
    },
  }
  const fake = {
    binaryType: 'arraybuffer',
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(frame: unknown, ...rest: unknown[]) {
      const options = rest.find((it) => it && typeof it === 'object') as
        | { compress?: boolean }
        | undefined
      if (frame instanceof Uint8Array) sent.push({ frame, compress: options?.compress === true })
      const done = rest.find((it) => typeof it === 'function') as ((err?: Error) => void) | undefined
      done?.()
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {
      out.pings += 1
    },
    terminate() {
      fake.readyState = WebSocket.CLOSED
    },
    close() {
      fake.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  out.ws = fake as unknown as WebSocket
  return out
}

const syncSent = (fake: Fake): Sent[] => fake.sent.filter((it) => it.frame[0] === 0)
const faceSent = (fake: Fake): Sent[] => fake.sent.filter((it) => it.frame[0] === 1)

/** The update bytes from a sync frame: type, subtype, payload. */
function updateIn(frame: Uint8Array): Uint8Array {
  const decoder = decoding.createDecoder(frame)
  decoding.readVarUint(decoder)
  decoding.readVarUint(decoder)
  return decoding.readVarUint8Array(decoder)
}

/** A presence frame from a tab, exactly as `y-websocket` sends it. */
function faceFrame(face: Awareness): Buffer {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(face, [face.clientID]))
  return Buffer.from(encoding.toUint8Array(encoder))
}

/** The first frame of a COLD tab: "I have nothing, give me everything". */
function coldStep1(): Buffer {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  const empty = new Y.Doc()
  syncProtocol.writeSyncStep1(encoder, empty)
  empty.destroy()
  return Buffer.from(encoding.toUint8Array(encoder))
}

/* ------------------------------------------------------------ S-2: merging */

test('a burst from five hundred authors goes to the room as ONE merged frame', async () => {
  const id = 'fanout-authors'
  createSession(id, 'Пятьсот', null)
  const { doc } = getSessionDoc(id)
  const room = Array.from({ length: 500 }, () => socket())
  for (const seat of room) handleCollabSocket(seat.ws, id, 'participant', null)
  await tick()
  for (const seat of room) seat.sent.length = 0
  // A tab in sync with the room before the burst.
  const tab = new Y.Doc()
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(doc))

  // Everyone types their own, and each edit arrives over its own socket.
  for (const seat of room) {
    doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'x'), seat.ws)
  }
  await tick()

  const first = syncSent(room[0])
  assert.equal(first.length, 1, 'more than one frame went out for the burst')
  for (const seat of room) {
    const frames = syncSent(seat)
    assert.equal(frames.length, 1, 'someone was sent more than one frame')
    // The very same buffer, not an equal one: merging and encoding happened
    // once for everyone.
    assert.equal(frames[0].frame, first[0].frame, 'the frame was built anew: merging is computed per author')
  }

  // And this frame is the whole burst: the tab arrives at the same text.
  Y.applyUpdate(tab, updateIn(first[0].frame))
  assert.equal(
    cellSource(getCells(tab).get(0)).toString(),
    cellSource(getCells(doc).get(0)).toString(),
    'the merged frame did not carry the whole burst',
  )

  for (const seat of room) seat.close()
})

/* ------------------------------------------------------------ S-1: presence */

test('presence renewals within a window go out as one frame per recipient', async () => {
  const id = 'fanout-faces'
  createSession(id, 'Курсоры', null)
  getSessionDoc(id)
  const room = Array.from({ length: 50 }, () => socket())
  const faces = room.map(() => new Awareness(new Y.Doc()))
  for (const [i, seat] of room.entries()) {
    handleCollabSocket(seat.ws, id, 'participant', `p_${i}`)
    faces[i].setLocalStateField('user', { id: `p_${i}`, name: `Вкладка ${i}` })
    seat.fire('message', faceFrame(faces[i]))
  }
  await faceWindow()
  for (const seat of room) seat.sent.length = 0

  /*
   * Everyone announces themselves again — this is how `y-protocols` extends
   * the life of a state every fifteen seconds, even when nobody in the room is
   * doing anything. And these renewals arrive SCATTERED, each in its own tick:
   * without the window that is fifty broadcasts to fifty sockets.
   */
  for (const [i, seat] of room.entries()) {
    faces[i].setLocalStateField('user', { id: `p_${i}`, name: `Вкладка ${i}`, at: Date.now() })
    seat.fire('message', faceFrame(faces[i]))
    await tick()
  }
  await faceWindow()

  const total = room.reduce((sum, seat) => sum + faceSent(seat).length, 0)
  assert.equal(total, room.length, `the window let out ${total} frames instead of ${room.length}`)
  const one = faceSent(room[0])[0].frame
  for (const seat of room) {
    assert.equal(faceSent(seat)[0].frame, one, 'a separate presence frame was built for everyone')
  }

  for (const seat of room) seat.close()
  for (const face of faces) face.destroy()
})

test('a lone announcer gets its own face back, otherwise the tab drops the socket', async () => {
  /*
   * WebsocketProvider closes the connection if it has received nothing from
   * the server for thirty seconds: protocol pings are invisible to the
   * browser, and in a silent room the only thing keeping it alive is the echo
   * of its own presence renewal. A single tab in a room without the echo
   * reconnected every thirty seconds.
   */
  const id = 'fanout-self'
  createSession(id, 'Сам себе', null)
  getSessionDoc(id)
  const lone = socket()
  handleCollabSocket(lone.ws, id, 'participant', 'p_self_lone')
  const loneFace = new Awareness(new Y.Doc())
  loneFace.setLocalStateField('user', { id: 'p_self_lone', name: 'Одна вкладка' })
  lone.fire('message', faceFrame(loneFace))
  await faceWindow()
  assert.equal(faceSent(lone).length, 1, 'the lone tab did not get its face back')

  // The same in company: one's own comes back, the neighbours get it once
  // each.
  const room = Array.from({ length: 2 }, () => socket())
  const faces = room.map(() => new Awareness(new Y.Doc()))
  for (const [i, seat] of room.entries()) {
    handleCollabSocket(seat.ws, id, 'participant', `p_self_${i}`)
    faces[i].setLocalStateField('user', { id: `p_self_${i}`, name: `Вкладка ${i}` })
    seat.fire('message', faceFrame(faces[i]))
  }
  await faceWindow()
  for (const seat of [lone, ...room]) seat.sent.length = 0

  loneFace.setLocalStateField('user', { id: 'p_self_lone', name: 'Одна вкладка', at: 1 })
  lone.fire('message', faceFrame(loneFace))
  await faceWindow()

  assert.equal(faceSent(lone).length, 1, 'the announcer did not get its face back')
  assert.equal(faceSent(room[0]).length, 1, 'the face did not reach the neighbour')
  assert.equal(faceSent(room[1]).length, 1, 'the face did not reach the second neighbour')

  for (const seat of [lone, ...room]) seat.close()
  for (const face of [loneFace, ...faces]) face.destroy()
})

/* --------------------------------------------- S-7: face list for a newcomer */

test('the full face list for a newcomer is taken ready-made while presence has not changed', async () => {
  const id = 'fanout-welcome'
  createSession(id, 'Список', null)
  getSessionDoc(id)
  const first = socket()
  handleCollabSocket(first.ws, id, 'participant', 'p_w0')
  const face = new Awareness(new Y.Doc())
  face.setLocalStateField('user', { id: 'p_w0', name: 'Первый' })
  first.fire('message', faceFrame(face))
  await faceWindow()

  const second = socket()
  handleCollabSocket(second.ws, id, 'participant', 'p_w1')
  const third = socket()
  handleCollabSocket(third.ws, id, 'participant', 'p_w2')

  const welcomeSecond = faceSent(second)
  const welcomeThird = faceSent(third)
  assert.equal(welcomeSecond.length, 1, "the newcomer was not given the room's face list")
  assert.equal(welcomeThird.length, 1, "the second newcomer was not given the room's face list")
  assert.equal(welcomeThird[0].frame, welcomeSecond[0].frame, 'the face list was built anew')

  // Presence changed, so the list must become different.
  face.setLocalStateField('user', { id: 'p_w0', name: 'Первый', at: 2 })
  first.fire('message', faceFrame(face))
  await faceWindow()
  const fourth = socket()
  handleCollabSocket(fourth.ws, id, 'participant', 'p_w3')
  assert.notEqual(
    faceSent(fourth)[0].frame,
    welcomeSecond[0].frame,
    "the newcomer was given yesterday's face list",
  )

  first.close()
  second.close()
  third.close()
  fourth.close()
  face.destroy()
})

/* ----------------------------- CL-2/S-5: the whole document for a cold tab */

test('a cold tab gets the ready-made document frame, and it is compressed', async () => {
  const id = 'fanout-cold'
  createSession(id, 'Холодная', null)
  const { doc } = getSessionDoc(id)
  // A document larger than the compression ceiling: this is exactly where the
  // ceiling lied.
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'ы'.repeat(300_000)))

  const first = socket()
  handleCollabSocket(first.ws, id, 'participant', 'p_c0')
  first.sent.length = 0
  first.fire('message', coldStep1())

  const second = socket()
  handleCollabSocket(second.ws, id, 'participant', 'p_c1')
  second.sent.length = 0
  second.fire('message', coldStep1())

  const one = syncSent(first)
  const two = syncSent(second)
  assert.equal(one.length, 1, 'the cold tab was not answered with the document')
  assert.equal(two.length, 1, 'the second cold tab was not answered with the document')
  assert.equal(one[0].frame, two[0].frame, 'the document was built anew for everyone')
  assert.ok(one[0].frame.byteLength > 256 * 1024, 'the document turned out smaller than the compression ceiling')
  assert.equal(one[0].compress, true, 'the whole document went out UNCOMPRESSED')

  // And it really is the whole document: an empty tab arrives at the same
  // text.
  const tab = new Y.Doc()
  Y.applyUpdate(tab, updateIn(one[0].frame))
  assert.equal(
    cellSource(getCells(tab).get(0)).toString(),
    cellSource(getCells(doc).get(0)).toString(),
  )

  // An edit in the room, and the next cold tab gets a different frame.
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'я'))
  await tick()
  const third = socket()
  handleCollabSocket(third.ws, id, 'participant', 'p_c2')
  third.sent.length = 0
  third.fire('message', coldStep1())
  const fresh = syncSent(third)[0]
  assert.notEqual(fresh.frame, one[0].frame, "the newcomer was given yesterday's document")
  const late = new Y.Doc()
  Y.applyUpdate(late, updateIn(fresh.frame))
  assert.equal(
    cellSource(getCells(late).get(0)).toString(),
    cellSource(getCells(doc).get(0)).toString(),
    'the ready-made frame lagged behind the document',
  )

  first.close()
  second.close()
  third.close()
})

test('a returning tab is answered with what it lacks, compressed as well', async () => {
  const id = 'fanout-warm'
  createSession(id, 'Вернувшаяся', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'первое слово'))

  // The tab knows the room as of a minute ago.
  const tab = new Y.Doc()
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(doc))
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, ' и второе'))

  const seat = socket()
  handleCollabSocket(seat.ws, id, 'participant', 'p_warm')
  seat.sent.length = 0
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  syncProtocol.writeSyncStep1(encoder, tab)
  seat.fire('message', Buffer.from(encoding.toUint8Array(encoder)))

  const answer = syncSent(seat)
  assert.equal(answer.length, 1, 'the returning tab got no answer')
  assert.equal(answer[0].compress, true, 'the first sync answer went out UNCOMPRESSED')
  Y.applyUpdate(tab, updateIn(answer[0].frame))
  assert.equal(
    cellSource(getCells(tab).get(0)).toString(),
    cellSource(getCells(doc).get(0)).toString(),
    'the tab did not catch up with the room',
  )

  seat.close()
})

/* ----------------------------------------------------- S-15: one heartbeat */

test('one heartbeat per room, and whoever misses two pings is closed', () => {
  const id = 'fanout-ping'
  createSession(id, 'Сердце', null)
  getSessionDoc(id)
  /*
   * The clock is faked BEFORE the first socket: the room starts the heartbeat
   * timer together with it, and a faked clock sees only what was started
   * under it. Only `setInterval` is faked: frame merging relies on
   * `setTimeout` and `setImmediate`, and without them the broadcast would go
   * nowhere.
   */
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const alive = socket()
    const dead = socket()
    handleCollabSocket(alive.ws, id, 'participant', 'p_alive')
    handleCollabSocket(dead.ws, id, 'participant', 'p_dead')
    assert.equal(onlineCount(id), 2)

    // One timer tick means a ping for everyone: a pass over the socket map,
    // not a timer per socket.
    mock.timers.tick(25_000)
    assert.equal(alive.pings, 1, 'the live socket got no ping')
    assert.equal(dead.pings, 1, 'the silent socket got no ping')

    alive.pong()
    mock.timers.tick(25_000)
    alive.pong()
    assert.equal(onlineCount(id), 2, 'the one who answers was closed')

    // The third tick: the silent one has missed two answers in a row.
    mock.timers.tick(25_000)
    assert.equal(onlineCount(id), 1, 'a socket with its laptop lid closed stayed in the room')
    assert.equal(alive.pings, 3, 'pings stopped going to the one that answers')

    alive.close()
    assert.equal(onlineCount(id), 0)
  } finally {
    mock.timers.reset()
  }
})
