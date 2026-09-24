/**
 * What a single gesture on the control socket costs — and what happens when
 * the wire cannot keep up.
 *
 * The control socket is the only place where one movement of a hand turns
 * into a `ws.send` loop over all of the room's sockets, and it carries all the
 * biggest things: the file tree, the council stack (up to four megabytes) and
 * the lecture ink thirty times a second. Three things are checked here with
 * assertions:
 *
 *   — BACKPRESSURE. While `send` looked only at `readyState`, everything that
 *     did not fit into the wire piled up in process memory — a copy for every
 *     lagging socket. Now the queue has two marks, just like the shared
 *     document (collab/index.ts): past the first, frames that matter only
 *     right now stop being sent; past the second, the socket is dropped and
 *     the tab comes back by itself.
 *   — INK COALESCING. Every piece of a stroke went out in its own frame:
 *     89.6 KB for a room of five hundred people, thirty times a second. The
 *     pieces of one stroke are glued together per tick — and everything else
 *     that says something about the ink must travel AFTER the held-back part,
 *     otherwise the audience erases a stroke that still has points waiting in
 *     the queue.
 *   — ONE PING TICK PER ROOM, not a timer for each of five hundred sockets.
 *
 * No network, no kernel: the sockets are fake, the room is real, and the
 * dispatcher is the same one that listens to the wire.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createSession } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { startLecture, stopLecture } from '../server/src/lecture.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

interface Fake {
  ws: WebSocket
  /** Frames as a browser would parse them. */
  heard: ControlServerMessage[]
  /** Frames as they went into the wire: as a string or already as bytes. */
  raw: (string | Buffer)[]
  pings: number
  killed: boolean
  stall: (bytes: number) => void
}

function socket(): Fake {
  const heard: ControlServerMessage[] = []
  const raw: (string | Buffer)[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const fake = {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(frame: unknown) {
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        raw.push(frame as string | Buffer)
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {
      out.pings++
    },
    // A real `terminate` drops the connection and raises `close`; that is the
    // only place the room learns it has emptied.
    terminate() {
      out.killed = true
      fake.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
    close() {
      fake.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  const out: Fake = {
    ws: fake as unknown as WebSocket,
    heard,
    raw,
    pings: 0,
    killed: false,
    stall: (bytes: number) => {
      fake.bufferedAmount = bytes
    },
  }
  return out
}

let rooms = 0

function room(): { id: string; host: TokenPayload; seat: Fake } {
  const id = `backpressure-${++rooms}`
  createSession(id, 'Давление', null)
  const host: TokenPayload = { sessionId: id, participantId: 'p_host', role: 'host' }
  const seat = socket()
  handleControlSocket(seat.ws, id, host)
  return { id, host, seat }
}

function say(id: string, who: TokenPayload, ws: WebSocket, message: ControlClientMessage): void {
  dispatch(ws, id, who, message)
}

/** A piece of a stroke, as the pen sends it: points as they are drawn. */
function stroke(id: string, points: number[]): ControlClientMessage {
  return { t: 'ink', id, page: 1, color: '#101a33', width: 0.004, points }
}

const inkAdds = (heard: ControlServerMessage[]) => heard.filter((frame) => frame.t === 'ink:add')

/* ------------------------------------------------------------ backpressure */

test('a lagging socket is not sent the pointer and ink, but is sent the rules and the end of class', () => {
  const { id, host, seat } = room()
  startLecture(id, { file: 'л.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  const slow = socket()
  handleControlSocket(slow.ws, id, { sessionId: id, participantId: 'p_slow', role: 'participant' })

  // Two megabytes queued: past the first mark (1 MB), far from the second
  // (8 MB).
  slow.stall(2 * 1024 * 1024)
  seat.heard.length = 0
  slow.heard.length = 0

  say(id, host, seat.ws, { t: 'laser', page: 1, x: 0.5, y: 0.5 })
  say(id, host, seat.ws, stroke('s1', [0, 0, 0.1, 0.1]))
  assert.equal(
    slow.heard.filter((frame) => frame.t === 'laser' || frame.t === 'ink:add').length,
    0,
    'the lagging socket was sent something that matters only right now',
  )
  assert.ok(
    seat.heard.some((frame) => frame.t === 'laser'),
    'along with the lagging socket, everyone else went silent too',
  )

  // But a frame that will not be repeated goes out: losing it means leaving a
  // person with a room that does not exist.
  slow.heard.length = 0
  say(id, host, seat.ws, { t: 'class:finish' })
  assert.ok(
    slow.heard.some((frame) => frame.t === 'class'),
    'the lagging socket was not told that the class had ended',
  )
  assert.equal(slow.killed, false, 'the socket was dropped before reaching the second mark')

  stopLecture(id)
  closeControlRoom(id)
})

test('a hopelessly lagging socket is dropped, and the room forgets it', () => {
  const { id, host, seat } = room()
  const slow = socket()
  handleControlSocket(slow.ws, id, { sessionId: id, participantId: 'p_slow', role: 'participant' })

  // Eight megabytes queued is not a slow network but a closed laptop lid:
  // everything the room says from now on lands in process memory and goes
  // nowhere.
  slow.stall(9 * 1024 * 1024)
  say(id, host, seat.ws, { t: 'class:finish' })

  assert.equal(slow.killed, true, 'a socket with nine megabytes queued was left alive')
  // And the room learned about the departure: `terminate` raises `close`, and
  // all the cleanup hangs on it. Otherwise broadcasts would keep going to a
  // dead socket until the end of the class.
  slow.heard.length = 0
  say(id, host, seat.ws, { t: 'class:resume' })
  assert.deepEqual(slow.heard, [])

  closeControlRoom(id)
})

test('a broadcast frame is encoded once per room, not once per socket', () => {
  /*
   * `ws.send(string)` encodes it to UTF-8 anew for EVERY socket — about a
   * millisecond per megabyte. A pen frame for a room of five hundred people is
   * 89.6 KB thirty times a second: 4.9 MB/s of encoding alone, which could be
   * done once. The proof is identity: everyone received the SAME object.
   */
  const { id, host, seat } = room()
  const second = socket()
  handleControlSocket(second.ws, id, {
    sessionId: id,
    participantId: 'p_two',
    role: 'participant',
  })
  seat.raw.length = 0
  second.raw.length = 0

  say(id, host, seat.ws, { t: 'class:finish' })
  const mine = seat.raw.at(-1)
  const theirs = second.raw.at(-1)
  assert.ok(Buffer.isBuffer(mine), 'the frame went out as a string, so ws will encode it anew for everyone')
  assert.equal(mine, theirs, 'each socket got its own copy of the frame')

  closeControlRoom(id)
})

/* ------------------------------------------------------------ ink coalescing */

test('pieces of one stroke are glued per tick, and no points are lost', async () => {
  const { id, host, seat } = room()
  startLecture(id, { file: 'л.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  // Thirty pieces in a row: that is what the pen sends in a second of drawing.
  for (let i = 0; i < 30; i++) say(id, host, seat.ws, stroke('s1', [i / 100, i / 100]))
  assert.equal(inkAdds(seat.heard).length, 1, 'the first piece did not go out at once, or all thirty went out')

  await sleep(90)
  const frames = inkAdds(seat.heard)
  assert.ok(frames.length >= 2, 'the held-back pieces never went out')
  assert.ok(frames.length <= 4, `thirty pieces went out in ${frames.length} frames`)

  // And not a single point was lost or reordered: the audience sees the same
  // line.
  const drawn: number[] = []
  for (const frame of frames) {
    assert.equal(frame.t === 'ink:add' && frame.stroke.id, 's1')
    if (frame.t === 'ink:add') drawn.push(...frame.stroke.points)
  }
  const expected: number[] = []
  for (let i = 0; i < 30; i++) expected.push(i / 100, i / 100)
  assert.deepEqual(drawn, expected, 'coalescing drew something other than what was drawn')

  stopLecture(id)
  closeControlRoom(id)
})

test('"erase the stroke" travels AFTER the held-back points, not before them', async () => {
  /*
   * Otherwise the audience erases a stroke that still has points waiting in
   * the queue — and they get drawn onto the empty spot anew. The same goes for
   * "here is the whole page".
   */
  const { id, host, seat } = room()
  startLecture(id, { file: 'л.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  say(id, host, seat.ws, stroke('s1', [0, 0, 0.1, 0.1]))
  seat.heard.length = 0
  // While the window is open, the second piece is held back.
  say(id, host, seat.ws, stroke('s1', [0.2, 0.2]))
  assert.equal(inkAdds(seat.heard).length, 0, 'the piece went out without waiting for the tick')

  say(id, host, seat.ws, { t: 'ink:undo', page: 1 })
  const order = seat.heard.map((frame) => frame.t)
  assert.deepEqual(order, ['ink:add', 'ink:drop'], 'the undo overtook the held-back points')

  // And the end of the tick will not send them again: they are already gone.
  seat.heard.length = 0
  await sleep(90)
  assert.deepEqual(inkAdds(seat.heard), [], 'the held-back part went out twice')

  stopLecture(id)
  closeControlRoom(id)
})

test('strokes from different hands do not swap places within one tick', async () => {
  const { id, host, seat } = room()
  startLecture(id, { file: 'л.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  say(id, host, seat.ws, stroke('a', [0, 0, 0.1, 0.1]))
  seat.heard.length = 0

  say(id, host, seat.ws, stroke('b', [0.2, 0.2, 0.3, 0.3]))
  say(id, host, seat.ws, stroke('a', [0.4, 0.4]))
  say(id, host, seat.ws, stroke('b', [0.5, 0.5]))
  await sleep(90)

  const ids = inkAdds(seat.heard).map((frame) => (frame.t === 'ink:add' ? frame.stroke.id : ''))
  assert.deepEqual(ids, ['b', 'a', 'b'], 'coalescing reordered the strokes of two hands')

  stopLecture(id)
  closeControlRoom(id)
})

/* ------------------------------------------------------------------ ping */

test('one ping tick per room, not one per socket', () => {
  /*
   * A ping is two counters and `ws.ping()`; the timer around it is invisible
   * on one socket. On five hundred it is five hundred timers in node's heap,
   * waking up at random throughout the minute — that is, five hundred
   * event-loop wakeups where one pass over a set that is already at hand would
   * do.
   */
  const id = `ping-${++rooms}`
  createSession(id, 'Пинг', null)
  const real = globalThis.setInterval
  const ticks: (() => void)[] = []
  let started = 0
  ;(globalThis as { setInterval: typeof setInterval }).setInterval = ((
    fn: () => void,
    ms?: number,
  ) => {
    // Only the ping tick: everything else in the room sets its own timers on
    // its own schedule, and there is nothing to count about them here.
    if (ms === 25_000) {
      started++
      ticks.push(fn)
    }
    return real(() => {}, 1_000_000)
  }) as typeof setInterval

  const seats: Fake[] = []
  try {
    for (let i = 0; i < 5; i++) {
      const seat = socket()
      seats.push(seat)
      handleControlSocket(seat.ws, id, {
        sessionId: id,
        participantId: `p_${i}`,
        role: 'participant',
      })
    }
  } finally {
    ;(globalThis as { setInterval: typeof setInterval }).setInterval = real
  }

  assert.equal(started, 1, `five sockets started ${started} ping ticks`)

  // The timing is the same as before: two silences in a row, and the socket
  // is dropped.
  ticks[0]()
  assert.deepEqual(seats.map((seat) => seat.pings), [1, 1, 1, 1, 1])
  ticks[0]()
  assert.deepEqual(seats.map((seat) => seat.pings), [2, 2, 2, 2, 2])
  assert.equal(seats.some((seat) => seat.killed), false, 'the socket was dropped on the second ping')
  ticks[0]()
  assert.equal(
    seats.every((seat) => seat.killed),
    true,
    'a socket that stayed silent for two pings in a row was left alive',
  )

  closeControlRoom(id)
})
