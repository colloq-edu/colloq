/**
 * The pointer and the ink on the wire: what the hall receives when the
 * network is not perfect, and what Undo takes back.
 *
 * Every case here was seen in a lecture hall or reproduced on a stand:
 *
 *   — a resend after a slow echo was appended a second time, and the hall's
 *     copy of an ordinary line got a straight chord back across the slide;
 *   — a frame lost with a dying socket glued the next piece on with a chord;
 *   — one Undo took back only the last piece of a long motion;
 *   — Undo after an accidental erase removed ANOTHER stroke instead of
 *     bringing the erased one back;
 *   — the pointer window kept only the last position, so a Wi-Fi burst
 *     reached the hall as one point, and the release threw away the end of the
 *     shape;
 *   — the pointer's "off" was a stream frame, skipped for a socket far behind:
 *     a stuck red dot, then a straight line from it on the next press.
 *
 * No network, no kernel: fake sockets, the real room and dispatcher.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createSession } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import {
  addInk,
  clearInk,
  eraseInk,
  inkOf,
  startLecture,
  stopLecture,
  undoInk,
} from '../server/src/lecture.js'
import { LASER_HOLD_MS } from '../shared/lecture.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

interface Fake {
  ws: WebSocket
  heard: ControlServerMessage[]
  stall: (bytes: number) => void
}

function socket(): Fake {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const fake = {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(frame: unknown) {
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {
      fake.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
    close() {
      fake.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  return {
    ws: fake as unknown as WebSocket,
    heard,
    stall: (bytes: number) => {
      fake.bufferedAmount = bytes
    },
  }
}

let rooms = 0
const host = (id: string): TokenPayload => ({
  sessionId: id,
  participantId: 'p_host',
  role: 'host',
})

function room(): { id: string; who: TokenPayload; pen: Fake; hall: Fake } {
  const id = `wire-repair-${++rooms}`
  createSession(id, 'Провод', null)
  const who = host(id)
  const pen = socket()
  const hall = socket()
  handleControlSocket(pen.ws, id, who)
  handleControlSocket(hall.ws, id, { sessionId: id, participantId: 'p_student', role: 'guest' })
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  pen.heard.length = 0
  hall.heard.length = 0
  return { id, who, pen, hall }
}

function done(id: string): void {
  stopLecture(id)
  closeControlRoom(id)
}

function piece(id: string, points: number[], from?: number): ControlClientMessage {
  return { t: 'ink', id, page: 1, color: '#101a33', width: 0.004, points, from }
}

/** What the hall would hold, laid by position exactly as the tab lays it. */
function hallCopy(heard: ControlServerMessage[], strokeId: string): number[] {
  let points: number[] = []
  for (const frame of heard) {
    if (frame.t !== 'ink:add' || frame.stroke.id !== strokeId) continue
    const from = frame.from ?? points.length
    assert.ok(from <= points.length, 'the hall got a piece beyond its copy: a hole')
    points = [...points, ...frame.stroke.points.slice(points.length - from)]
  }
  return points
}

/* ------------------------------------------------------- positional ink */

test('a late original and its resend are appended once: no chord back across the slide', async () => {
  const { id, who, pen, hall } = room()
  // An ordinary left-to-right line, in three pieces.
  const line = Array.from({ length: 30 }, (_, i) => [0.1 + i * 0.02, 0.5]).flat()
  dispatch(pen.ws, id, who, piece('s1', line.slice(0, 20), 0))
  dispatch(pen.ws, id, who, piece('s1', line.slice(20, 40), 20))
  dispatch(pen.ws, id, who, piece('s1', line.slice(40), 40))
  // The echo was late, so the console resent everything from where it had
  // confirmation: from zero. TCP delivered the originals all the same.
  dispatch(pen.ws, id, who, piece('s1', line, 0))
  dispatch(pen.ws, id, who, piece('s1', line.slice(20), 20))
  await sleep(120)

  const stored = inkOf(id).find((stroke) => stroke.id === 's1')
  assert.deepEqual(stored?.points, line, 'the server stroke holds a piece twice')
  const xs = hallCopy(hall.heard, 's1').filter((_, i) => i % 2 === 0)
  for (let i = 1; i < xs.length; i += 1) {
    assert.ok(xs[i] >= xs[i - 1], `x jumped back at point ${i}: a chord across the slide`)
  }
  assert.equal(xs.length, 30)
  done(id)
})

test('a piece beyond the server copy is not glued on: the sender alone is told where to resend from', () => {
  const { id, who, pen, hall } = room()
  dispatch(pen.ws, id, who, piece('s1', [0.1, 0.1, 0.2, 0.2], 0))
  // The frame with numbers 4..8 died with the socket; the next one arrives.
  dispatch(pen.ws, id, who, piece('s1', [0.5, 0.5, 0.6, 0.6], 8))
  const need = pen.heard.find((frame) => frame.t === 'ink:need')
  assert.deepEqual(need, { t: 'ink:need', page: 1, id: 's1', have: 4 })
  assert.ok(!hall.heard.some((frame) => frame.t === 'ink:need'), 'the hall was told about our gap')
  assert.deepEqual(
    inkOf(id)[0].points,
    [0.1, 0.1, 0.2, 0.2],
    'the far piece was glued on with a chord',
  )

  // The resend from where the server stopped fills the hole in order.
  dispatch(pen.ws, id, who, piece('s1', [0.3, 0.3, 0.4, 0.4, 0.5, 0.5, 0.6, 0.6], 4))
  assert.deepEqual(
    inkOf(id)[0].points,
    [0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4, 0.5, 0.5, 0.6, 0.6],
  )
  done(id)
})

test("a stroke's beginning is required to create it", () => {
  const { id } = room()
  const lost = { id: 'x', page: 1, color: '#111', width: 0.004, points: [0.5, 0.5], from: 6 }
  assert.deepEqual(addInk(id, lost), { need: 0 })
  assert.deepEqual(inkOf(id), [])
  done(id)
})

test('the hall is told where every piece starts, and a glued run starts at its first piece', async () => {
  const { id, who, pen, hall } = room()
  dispatch(pen.ws, id, who, piece('s1', [0.1, 0.1], 0))
  dispatch(pen.ws, id, who, piece('s1', [0.2, 0.2], 2))
  dispatch(pen.ws, id, who, piece('s1', [0.3, 0.3], 4))
  await sleep(120)
  const adds = hall.heard.filter((frame) => frame.t === 'ink:add')
  assert.deepEqual(
    adds.map((frame) => (frame.t === 'ink:add' ? [frame.from, frame.stroke.points.length] : null)),
    [
      [0, 2],
      [2, 4],
    ],
  )
  done(id)
})

test('a stroke that ran out of points is not refused again for a resend it already has', () => {
  const { id } = room()
  const chunk = Array.from({ length: 512 }, () => 0.5)
  let from = 0
  for (let i = 0; i < 9; i += 1) {
    addInk(id, { id: 'long', page: 1, color: '#111', width: 0.004, points: chunk, from })
    from += 512
  }
  // A resend of the tail it already holds is news to nobody, not a ceiling.
  assert.equal(
    addInk(id, { id: 'long', page: 1, color: '#111', width: 0.004, points: chunk, from: 512 }),
    null,
  )
  done(id)
})

/* ------------------------------------------------------------------ undo */

test('one Undo takes back a whole long motion, however many pieces the ceiling cut it into', () => {
  const { id } = room()
  addInk(id, { id: 'before', page: 1, color: '#111', width: 0.004, points: [0, 0, 0.1, 0.1] })
  addInk(id, { id: 'm1', page: 1, color: '#111', width: 0.004, points: [0.2, 0.2, 0.3, 0.3] })
  const more = { page: 1, color: '#111', width: 0.004, group: 'm1' }
  addInk(id, { ...more, id: 'm2', points: [0.3, 0.3, 0.4, 0.4] })
  addInk(id, { ...more, id: 'm3', points: [0.4, 0.4, 0.5, 0.5] })
  assert.equal(inkOf(id).find((stroke) => stroke.id === 'm2')?.group, 'm1')

  assert.deepEqual(undoInk(id, 1), { dropped: ['m3', 'm2', 'm1'] })
  assert.deepEqual(inkOf(id).map((stroke) => stroke.id), ['before'])
  done(id)
})

test('Undo after an accidental erase brings the erased strokes back, in their places', () => {
  const { id } = room()
  for (const name of ['a', 'b', 'c', 'd']) {
    addInk(id, { id: name, page: 1, color: '#111', width: 0.004, points: [0, 0, 0.1, 0.1] })
  }
  // One sweep caught b and d.
  eraseInk(id, 1, 'b', { gesture: 'sweep1' })
  eraseInk(id, 1, 'd', { gesture: 'sweep1' })
  assert.deepEqual(inkOf(id).map((stroke) => stroke.id), ['a', 'c'])

  const undone = undoInk(id, 1)
  assert.ok(
    undone && 'restored' in undone,
    'Undo removed another stroke instead of bringing the erased back',
  )
  assert.deepEqual(inkOf(id).map((stroke) => stroke.id), ['a', 'b', 'c', 'd'])
  // And the next Undo goes on to the strokes, newest first.
  assert.deepEqual(undoInk(id, 1), { dropped: ['d'] })
  done(id)
})

test('"erase page" pressed on the wrong slide is taken back by Undo', () => {
  const { id } = room()
  addInk(id, { id: 'a', page: 2, color: '#111', width: 0.004, points: [0, 0, 0.1, 0.1] })
  addInk(id, { id: 'b', page: 2, color: '#111', width: 0.004, points: [0, 0, 0.1, 0.1] })
  clearInk(id, 2)
  assert.deepEqual(inkOf(id), [])
  const undone = undoInk(id, 2)
  assert.ok(undone && 'restored' in undone)
  assert.deepEqual(inkOf(id).map((stroke) => stroke.id), ['a', 'b'])
  done(id)
})

test('a retracted palm leaves no trace: Undo does not bring it back', () => {
  const { id } = room()
  addInk(id, { id: 'line', page: 1, color: '#111', width: 0.004, points: [0, 0, 0.1, 0.1] })
  addInk(id, { id: 'palm', page: 1, color: '#111', width: 0.004, points: [0.8, 0.85] })
  eraseInk(id, 1, 'palm', { retract: true })
  assert.deepEqual(undoInk(id, 1), { dropped: ['line'] })
  assert.deepEqual(inkOf(id), [])
  done(id)
})

test('Undo of an erase reaches the hall as the page whole, with the inventory', () => {
  const { id, who, pen, hall } = room()
  dispatch(pen.ws, id, who, piece('a', [0, 0, 0.1, 0.1], 0))
  dispatch(pen.ws, id, who, piece('b', [0.2, 0.2, 0.3, 0.3], 0))
  dispatch(pen.ws, id, who, { t: 'ink:erase', page: 1, id: 'a', gesture: 'g1' })
  hall.heard.length = 0
  dispatch(pen.ws, id, who, { t: 'ink:undo', page: 1 })
  const page = hall.heard.find((frame) => frame.t === 'ink:page')
  assert.ok(page && page.t === 'ink:page', 'the restored stroke never reached the hall')
  assert.deepEqual(page.strokes.map((stroke) => stroke.id), ['a', 'b'])
  assert.ok(hall.heard.some((frame) => frame.t === 'ink:pages'))
  assert.ok(!hall.heard.some((frame) => frame.t === 'ink:drop'), 'Undo removed a stroke instead')
  done(id)
})

/* --------------------------------------------------------------- pointer */

type LaserFrame = Extract<ControlServerMessage, { t: 'laser' }>
const lasers = (heard: ControlServerMessage[]) =>
  heard.filter((frame): frame is LaserFrame => frame.t === 'laser')

function beam(mark: number, pts: number[]): ControlClientMessage {
  const [x, y] = pts.slice(-3)
  return { t: 'laser', page: 1, x, y, shape: 'line', mark, pts }
}

test('every sample in a window reaches the hall, glued, not just the last one', async () => {
  const { id, who, pen, hall } = room()
  dispatch(pen.ws, id, who, beam(7, [0.1, 0.1, 0]))
  // A Wi-Fi burst: four frames back to back inside one window.
  dispatch(pen.ws, id, who, beam(7, [0.2, 0.1, 40, 0.3, 0.1, 50]))
  dispatch(pen.ws, id, who, beam(7, [0.4, 0.2, 80]))
  dispatch(pen.ws, id, who, beam(7, [0.5, 0.3, 120, 0.6, 0.4, 130]))
  await sleep(LASER_HOLD_MS * 3)
  const frames = lasers(hall.heard)
  const samples = frames.flatMap((frame) => frame.at?.pts ?? [])
  assert.deepEqual(
    samples.filter((_, i) => i % 3 === 0),
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    'samples inside the window were thrown away: the hall flies a chord',
  )
  assert.equal(frames.length, 2, 'the window did not glue the burst into one frame')
  assert.equal(frames[1].at?.mark, 7)
  done(id)
})

test('the release sends the held end of the shape first, then "off", and the next press goes at once', async () => {
  const { id, who, pen, hall } = room()
  dispatch(pen.ws, id, who, beam(1, [0.1, 0.1, 0]))
  dispatch(pen.ws, id, who, beam(1, [0.9, 0.9, 30]))
  dispatch(pen.ws, id, who, { t: 'laser:off' })
  const frames = lasers(hall.heard)
  assert.deepEqual(
    frames.map((frame) => frame.at?.x ?? null),
    [0.1, 0.9, null],
    'the end of the shape was thrown away, or came after the "off"',
  )
  // The window closed with the release: a new press does not wait for it.
  dispatch(pen.ws, id, who, beam(2, [0.5, 0.5, 0]))
  assert.equal(lasers(hall.heard).at(-1)?.at?.mark, 2, 'the next press waited for a dead window')
  await sleep(LASER_HOLD_MS * 3)
  assert.equal(lasers(hall.heard).length, 4, 'the old window relit the pointer')
  done(id)
})

test('"off" reaches a socket that is far behind: it is not a stream frame', () => {
  const { id, who, pen, hall } = room()
  dispatch(pen.ws, id, who, beam(1, [0.1, 0.1, 0]))
  hall.stall(2 * 1024 * 1024)
  hall.heard.length = 0
  dispatch(pen.ws, id, who, beam(1, [0.2, 0.2, 100]))
  dispatch(pen.ws, id, who, { t: 'laser:off' })
  // Samples are skipped for the lagging socket, the release is not.
  assert.deepEqual(
    lasers(hall.heard).map((frame) => frame.at),
    [null],
    'the lagging projector kept a lit red dot',
  )
  done(id)
})

test('a frame of garbage samples is read by the shared rule: clamped, rounded, never backwards in time', () => {
  const { id, who, pen, hall } = room()
  dispatch(pen.ws, id, who, {
    t: 'laser',
    page: 1,
    x: 0.5,
    y: 0.5,
    mark: 3,
    pts: [1.7, -2, 10, 'x', 0, 0, 0.123456, 0.5, 5],
  } as unknown as ControlClientMessage)
  assert.deepEqual(lasers(hall.heard)[0]?.at?.pts, [1, 0, 10, 0.1235, 0.5, 10])
  done(id)
})
