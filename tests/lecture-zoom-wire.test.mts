/**
 * The zoom: the presenter magnifies part of the page, and the hall sees the
 * same part.
 *
 * The owner asked for it in these words: zoom on the console, mirrored to the
 * projector, to point something out up close or look at a picture closer.
 * Each check below stands for a way it goes wrong in front of the hall:
 *
 *   — a value meant for the slide before a turn magnifies the next slide;
 *   — the zoom survives a turn, and the next slide comes up magnified at the
 *     spot of the previous one;
 *   — a lagging projector skips the frames of a pinch (they are stream
 *     frames, like the pointer) and never learns where the hand settled, so
 *     it stays magnified on a stale spot for the rest of the slide;
 *   — a pinch of twenty-five frames a second goes out as whole `lecture`
 *     frames, which every tab treats as a change of lecture;
 *   — a held value goes out after the turn that reset it.
 *
 * No network: the memory directly, then fake sockets and the real dispatcher.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createSession } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import {
  addSheet,
  handOver,
  lectureOf,
  setBlank,
  setZoom,
  startLecture,
  stopLecture,
  turnTo,
} from '../server/src/lecture.js'
import {
  LASER_HOLD_MS,
  ZOOM_MAX,
  ZOOM_MIN_SHOWN,
  readZoom,
  sameZoom,
  type LectureZoom,
} from '../shared/lecture.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

const CLOSER: LectureZoom = { x: 0.25, y: 0.25, z: 2 }
const CORNER: LectureZoom = { x: 0.5, y: 0.5, z: 2 }
const DEEP: LectureZoom = { x: 0.6, y: 0.1, z: 3 }

let n = 0
function lecture(): string {
  const id = `zoom-${++n}`
  startLecture(id, { file: 'slides.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  return id
}

/* --------------------------------------------------------- the reading */

test('a zoom from the wire is read by one rule: clamped to the page, rounded, or the whole page', () => {
  assert.deepEqual(readZoom({ x: 0.123456, y: 0.2, z: 2.34567 }), { x: 0.1235, y: 0.2, z: 2.346 })
  // Closer than the limit is the limit, and the corner keeps the region on the page.
  assert.deepEqual(readZoom({ x: 2, y: -1, z: 10 }), { x: 1 - 1 / ZOOM_MAX, y: 0, z: ZOOM_MAX })
  // Almost ×1 is ×1: a pinch rarely lands exactly on it.
  assert.equal(readZoom({ x: 0, y: 0, z: ZOOM_MIN_SHOWN - 0.01 }), null)
  assert.equal(readZoom({ x: 0, y: 0, z: 0.5 }), null)
  // Anything that is not a zoom is the whole page.
  const junk = [
    null,
    undefined,
    'x2',
    3,
    { x: 0, y: 0 },
    { x: Number.NaN, y: 0, z: 2 },
    { x: 0, y: 0, z: Infinity },
  ]
  for (const raw of junk) assert.equal(readZoom(raw), null, `${JSON.stringify(raw)} was read as a zoom`)
  assert.equal(sameZoom(null, undefined), true)
  assert.equal(sameZoom(CLOSER, { ...CLOSER }), true)
  assert.equal(sameZoom(CLOSER, CORNER), false)
})

test('a zoom read once reads the same again: the console recognises its own echo', () => {
  /*
   * The server stores what it read, the screens read the stored value again,
   * and the console compares the echo with what it sent. The corner used to
   * be clamped by the room of the UNROUNDED z: at the page's edge the second
   * read came back 1e-4 off, and `sameZoom` said "someone else's zoom".
   */
  // z rounds down to 3.524, and the corner is clamped by 3.524's room, not 3.5244's.
  assert.deepEqual(readZoom({ x: 0.7441, y: 1.0982, z: 3.5244 }), { x: 0.7162, y: 0.7162, z: 3.524 })
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let i = 0; i < 20_000; i += 1) {
    const once = readZoom({ x: random() * 1.2, y: random() * 1.2, z: 1 + random() * 3.5 })
    assert.ok(sameZoom(readZoom(once), once), `${JSON.stringify(once)} reads differently the second time`)
  }
})

/* ----------------------------------------------------------- the memory */

test('the zoom is kept for the page it was made on, and a frame for another page is dropped', () => {
  const id = lecture()
  assert.deepEqual(setZoom(id, 1, CLOSER)?.zoom, CLOSER)
  assert.equal(setZoom(id, 2, DEEP), null, 'a zoom for another page was applied')
  assert.deepEqual(lectureOf(id)?.zoom, CLOSER)
  assert.equal(setZoom(id, 1, { ...CLOSER }), null, 'the same region again was a change')
  // The whole page again.
  assert.equal(setZoom(id, 1, null)?.zoom, null)
  assert.equal(setZoom('no such lecture', 1, CLOSER), null)
  stopLecture(id)
})

test('the stored zoom is read by the same rule as the wire', () => {
  const id = lecture()
  assert.deepEqual(setZoom(id, 1, { x: 0.9, y: 0.9, z: 2 })?.zoom, CORNER)
  // ×1 is the whole page: a change from the corner, stored as `null`.
  assert.ok(setZoom(id, 1, { x: 0, y: 0, z: 1 }), 'going back to ×1 was not a change')
  assert.equal(lectureOf(id)?.zoom, null, 'a zoom of ×1 was not the whole page')
  stopLecture(id)
})

test('a turn brings the next page up whole; a blank screen and a take-over keep the zoom', () => {
  const id = lecture()
  setZoom(id, 1, CLOSER)
  assert.deepEqual(setBlank(id, true)?.zoom, CLOSER, 'the black screen dropped the zoom')
  assert.deepEqual(handOver(id, 'slides.pdf', 'p_boris', 'Борис', '#0c7a64')?.zoom, CLOSER)
  assert.equal(turnTo(id, 2)?.zoom, null, 'the next slide came up magnified')
  // A sheet is a turn too.
  setZoom(id, 2, DEEP)
  assert.equal(addSheet(id, 2)?.state?.zoom, null)
  // A turn to the same page is no turn and keeps it.
  setZoom(id, -1, DEEP)
  assert.equal(turnTo(id, -1), null)
  assert.deepEqual(lectureOf(id)?.zoom, DEEP)
  stopLecture(id)
})

/* ------------------------------------------------------------- the wire */

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
    terminate() {},
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

let wires = 0

/**
 * The presenter's console, a projector that keeps up and one that is far
 * behind (past the stream mark, short of being dropped). The lecture is on
 * slide 1.
 */
function wired(): { id: string; who: TokenPayload; pen: Fake; hall: Fake; slow: Fake } {
  const id = `zoom-wire-${++wires}`
  createSession(id, 'Лупа', null)
  const who: TokenPayload = { sessionId: id, participantId: 'p_host', role: 'host' }
  const pen = socket()
  const hall = socket()
  const slow = socket()
  handleControlSocket(pen.ws, id, who)
  handleControlSocket(hall.ws, id, { sessionId: id, participantId: 'p_hall', role: 'participant' })
  handleControlSocket(slow.ws, id, { sessionId: id, participantId: 'p_slow', role: 'participant' })
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  slow.stall(2 * 1024 * 1024)
  pen.heard.length = 0
  hall.heard.length = 0
  slow.heard.length = 0
  return { id, who, pen, hall, slow }
}

function done(id: string): void {
  stopLecture(id)
  closeControlRoom(id)
}

type ZoomFrame = Extract<ControlServerMessage, { t: 'lecture:zoom' }>
const zooms = (heard: ControlServerMessage[]): ZoomFrame[] =>
  heard.filter((frame): frame is ZoomFrame => frame.t === 'lecture:zoom')

function zoom(value: LectureZoom | null, final?: boolean, page = 1): ControlClientMessage {
  const frame = { t: 'lecture:zoom' as const, page, zoom: value }
  return final ? { ...frame, final: true } : frame
}

/** Long enough for every open window to close and flush its tail. */
const settle = () => sleep(LASER_HOLD_MS * 4)

test('the motion goes out at once as stream frames, where it settled reaches even a lagging projector', async () => {
  const { id, who, pen, hall, slow } = wired()
  dispatch(pen.ws, id, who, zoom(CLOSER))
  const first = { t: 'lecture:zoom', page: 1, zoom: CLOSER }
  assert.deepEqual(zooms(hall.heard), [first], 'the first value was held back')
  assert.deepEqual(zooms(slow.heard), [], 'the motion is not a stream frame: it piles up')
  await settle()

  dispatch(pen.ws, id, who, zoom(CORNER, true))
  const settled = { t: 'lecture:zoom', page: 1, zoom: CORNER }
  assert.deepEqual(zooms(slow.heard), [settled], 'a lagging projector stayed on a stale zoom')
  assert.deepEqual(zooms(hall.heard).at(-1)?.zoom, CORNER)
  assert.deepEqual(lectureOf(id)?.zoom, CORNER)
  await settle()
  done(id)
})

test('within a window the last value wins, and the tail of the window reaches everyone', async () => {
  const { id, who, pen, hall, slow } = wired()
  // A burst: three values inside one window.
  dispatch(pen.ws, id, who, zoom(CLOSER))
  dispatch(pen.ws, id, who, zoom(CORNER))
  dispatch(pen.ws, id, who, zoom(DEEP))
  assert.equal(zooms(hall.heard).length, 1, 'every value of the burst went out on its own')
  await settle()
  assert.deepEqual(
    zooms(hall.heard).map((frame) => frame.zoom),
    [CLOSER, DEEP],
    'the window did not send the newest value, or sent the ones in between',
  )
  // The tail may be the last value of the motion: it is essential.
  assert.deepEqual(zooms(slow.heard).map((frame) => frame.zoom), [DEEP])
  assert.deepEqual(lectureOf(id)?.zoom, DEEP)
  done(id)
})

test('a final value inside an open window waits for its tail and still goes as essential', async () => {
  const { id, who, pen, hall, slow } = wired()
  dispatch(pen.ws, id, who, zoom(CLOSER))
  dispatch(pen.ws, id, who, zoom(DEEP, true))
  await settle()
  assert.deepEqual(zooms(hall.heard).map((frame) => frame.zoom), [CLOSER, DEEP])
  assert.deepEqual(zooms(slow.heard).map((frame) => frame.zoom), [DEEP])
  done(id)
})

test('an unchanged value is not relayed again, unless it is where the hand settled', async () => {
  const { id, who, pen, hall, slow } = wired()
  dispatch(pen.ws, id, who, zoom(CLOSER))
  await settle()
  dispatch(pen.ws, id, who, zoom(CLOSER))
  await settle()
  assert.equal(zooms(hall.heard).length, 1, 'the same region went out twice')
  // The lagging projector skipped the stream frame that carried it: the
  // final one must still reach it, though it changes nothing on the server.
  dispatch(pen.ws, id, who, zoom(CLOSER, true))
  assert.deepEqual(zooms(slow.heard), [{ t: 'lecture:zoom', page: 1, zoom: CLOSER }])
  await settle()
  done(id)
})

test('a zoom for a page other than the one shown reaches nobody', async () => {
  const { id, who, pen, hall } = wired()
  dispatch(pen.ws, id, who, zoom(CLOSER, true, 2))
  const garbage = { t: 'lecture:zoom', page: 'one', zoom: CLOSER } as unknown as ControlClientMessage
  dispatch(pen.ws, id, who, garbage)
  await settle()
  assert.deepEqual(hall.heard, [])
  assert.equal(lectureOf(id)?.zoom, null)
  done(id)
})

test('a value held in the window does not arrive after the turn that reset the zoom', async () => {
  const { id, who, pen, hall } = wired()
  dispatch(pen.ws, id, who, zoom(CLOSER))
  dispatch(pen.ws, id, who, zoom(DEEP, true))
  dispatch(pen.ws, id, who, { t: 'lecture:page', page: 2 })
  await settle()
  const turn = hall.heard.findIndex((frame) => frame.t === 'lecture')
  assert.ok(turn >= 0)
  const state = hall.heard[turn]
  assert.ok(state.t === 'lecture')
  assert.equal(state.state?.page, 2)
  assert.equal(state.state?.zoom, null, 'the turn did not tell the hall "whole page"')
  assert.deepEqual(zooms(hall.heard.slice(turn)), [], "the previous slide's zoom arrived after the turn")
  // And a frame the console sent before it learned of the turn is dropped too.
  dispatch(pen.ws, id, who, zoom(CORNER, true, 1))
  assert.deepEqual(zooms(hall.heard.slice(turn)), [])
  assert.equal(lectureOf(id)?.zoom, null)
  done(id)
})

test('a pinch is never a stream of whole lecture frames', async () => {
  const { id, who, pen, hall } = wired()
  // Spaced past the window, as a console sending at its tick: each value goes on its own.
  for (let i = 0; i < 10; i += 1) {
    dispatch(pen.ws, id, who, zoom({ x: 0.1, y: 0.1, z: 1.5 + i / 10 }))
    await sleep(LASER_HOLD_MS * 2)
  }
  dispatch(pen.ws, id, who, zoom({ x: 0.1, y: 0.1, z: 2.4 }, true))
  await settle()
  assert.equal(hall.heard.filter((frame) => frame.t === 'lecture').length, 0)
  assert.equal(zooms(hall.heard).length, 11)
  done(id)
})

test('the zoom is the presenter\'s: anyone else is refused, silently', async () => {
  const { id, hall } = wired()
  const student: TokenPayload = { sessionId: id, participantId: 'p_hall', role: 'participant' }
  dispatch(hall.ws, id, student, zoom(CLOSER, true))
  await settle()
  assert.deepEqual(hall.heard, [])
  assert.equal(lectureOf(id)?.zoom, null)
  done(id)
})

test('a latecomer gets the zoom with the lecture, in the welcome batch', () => {
  const { id } = wired()
  setZoom(id, 1, DEEP)
  const late = socket()
  handleControlSocket(late.ws, id, { sessionId: id, participantId: 'p_late', role: 'participant' })
  const state = late.heard.find((frame) => frame.t === 'lecture')
  assert.ok(state && state.t === 'lecture')
  assert.deepEqual(state.state?.zoom, DEEP)
  done(id)
})

test('a room that empties with a value in the window sends nothing to the next one in', async () => {
  /*
   * The lecture outlives its sockets (an iPad and a projector reconnecting
   * after a Wi-Fi drop), the coalescing window must not: the newcomer gets
   * the zoom in the state, and a stray tail of the old window would arrive
   * on top of it.
   */
  const { id, who, pen, hall, slow } = wired()
  dispatch(pen.ws, id, who, zoom(CLOSER))
  dispatch(pen.ws, id, who, zoom(DEEP))
  for (const seat of [pen, hall, slow]) seat.ws.close()
  const late = socket()
  handleControlSocket(late.ws, id, { sessionId: id, participantId: 'p_late', role: 'participant' })
  await settle()
  const state = late.heard.find((frame) => frame.t === 'lecture')
  assert.ok(state && state.t === 'lecture')
  assert.deepEqual(state.state?.zoom, DEEP)
  assert.deepEqual(zooms(late.heard), [], 'the window outlived the room it was opened in')
  done(id)
})
