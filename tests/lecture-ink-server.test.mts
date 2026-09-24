/**
 * Per-page lecture ink — the server half.
 *
 * Ink used to travel in one measure: ALL pages of the lecture in one frame in
 * the welcome batch. Twenty minutes of writing is about a megabyte per
 * socket, while whoever joins looks at one page; after a Wi-Fi drop the whole
 * hall comes back at once, and the megabyte is multiplied by five hundred
 * (audit · core-9). Now the batch carries the page the host is showing and an
 * INVENTORY of the rest (`ink:pages`), and the tab asks for what is missing
 * (`ink:page`).
 *
 * The tab is checked separately (lecture-ink-page), and that is also where it
 * says what it expects from the server. Here are exactly those promises, and
 * each of them is such that without it the ink goes dark silently:
 *
 *  • the batch does not carry other pages, but it does not keep quiet about
 *    them either;
 *  • the inventory is "has at least one stroke", by the same rule as on the
 *    tab (shared/lecture.ts · `inkPagesOf`), otherwise an erased page stays as
 *    an extra sheet in the strip and a request for ink that does not exist;
 *  • a request is always answered, and an empty answer is an answer too;
 *  • a page turn by the host sends the markup ON ITS OWN: otherwise each one
 *    collects five hundred requests — the very broadcast round the batch was
 *    trimmed to avoid;
 *  • the frame cache remembers the page, not just the change number.
 *
 * Neither network nor browser: the socket is fake, the room is real.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import {
  addInk,
  clearInk,
  eraseInk,
  inkOf,
  inkedPagesOf,
  inkPageOf,
  startLecture,
  stopLecture,
} from '../server/src/lecture.js'
import { makeFile } from '../server/src/workspace.js'
import { inkPagesOf } from '../shared/lecture.js'
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
      // As a string or as bytes: the ink frame is built once per room and
      // goes out already encoded (control.ts · sendFrame).
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
  const id = `ink-page-${++rooms}`
  createSession(id, 'Лекция', null)
  setRules(id, { ...OPEN_ROOM })
  return id
}

function who(sessionId: string, participantId: string): TokenPayload {
  return { sessionId, participantId, role: 'host' }
}

function enter(sock: Fake, sessionId: string, participantId: string): void {
  handleControlSocket(sock.ws, sessionId, who(sessionId, participantId))
}

function draw(sessionId: string, page: number, id: string): void {
  addInk(sessionId, { id, page, color: '#101a33', width: 0.004, points: [0, 0, 0.1, 0.1] })
}

/** The full ink frame this socket received: the pages of its strokes. */
function inkPages(sock: Fake): number[] | null {
  for (let i = sock.heard.length - 1; i >= 0; i--) {
    const m = sock.heard[i]
    if (m.t === 'ink') return m.strokes.map((stroke) => stroke.page)
  }
  return null
}

/** The last inventory this socket received; `null` means it received none. */
function listed(sock: Fake): number[] | null {
  for (let i = sock.heard.length - 1; i >= 0; i--) {
    const m = sock.heard[i]
    if (m.t === 'ink:pages') return m.pages
  }
  return null
}

/** All page frames this socket received, in order. */
function pageFrames(sock: Fake): { page: number; strokes: number }[] {
  const out: { page: number; strokes: number }[] = []
  for (const m of sock.heard) {
    if (m.t === 'ink:page') out.push({ page: m.page, strokes: m.strokes.length })
  }
  return out
}

test('the welcome batch carries the shown page — and an inventory of the rest', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 1, 's1')
  draw(id, 2, 's2')
  draw(id, 2, 's3')
  draw(id, -1, 's4')

  const first = socket()
  enter(first, id, 'p_1')
  assert.deepEqual(inkPages(first), [1], 'the newcomer was sent other pages')
  assert.deepEqual(listed(first), [-1, 1, 2], 'without an inventory the tab does not know what it is missing')

  // The host moved the hall to page two — the next newcomer gets that one.
  dispatch(first.ws, id, who(id, 'p_1'), { t: 'lecture:page', page: 2 })
  const second = socket()
  enter(second, id, 'p_2')
  assert.deepEqual(inkPages(second), [2, 2], 'the frame cache did not notice the page change')
  assert.deepEqual(listed(second), [-1, 1, 2])

  stopLecture(id)
  closeControlRoom(id)
})

test('the page frame is built once for everyone but goes stale with a new stroke', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 1, 's1')

  const first = socket()
  enter(first, id, 'p_1')
  assert.deepEqual(inkPages(first), [1])

  const second = socket()
  enter(second, id, 'p_2')
  assert.deepEqual(inkPages(second), [1], 'the second one in the same window was sent something different')

  draw(id, 1, 's2')
  const third = socket()
  enter(third, id, 'p_3')
  assert.deepEqual(inkPages(third), [1, 1], 'the newcomer was sent stale ink')

  stopLecture(id)
  closeControlRoom(id)
})

test('the inventory is the pages with at least one stroke, by the same rule as on the tab', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 3, 's1')
  draw(id, 1, 's2')
  draw(id, 3, 's3')
  assert.deepEqual(inkedPagesOf(id), [1, 3], 'the inventory is not ascending or has repeats')
  assert.deepEqual(inkedPagesOf(id), inkPagesOf(inkOf(id)), 'two measures of a written-on page')

  // The eraser removed the page's last stroke: the key stayed in the room's
  // memory, but the page is no longer written on — otherwise the console keeps
  // an extra sheet and asks for ink that does not exist.
  assert.equal(eraseInk(id, 1, 's2'), true)
  assert.deepEqual(inkedPagesOf(id), [3])
  assert.deepEqual(inkedPagesOf(id), inkPagesOf(inkOf(id)))

  assert.deepEqual(inkedPagesOf('лекции-нет'), [])
  assert.deepEqual(inkPageOf('лекции-нет', 1), [])

  stopLecture(id)
})

test('a request for a page is answered to the asker — and an empty answer is an answer too', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 2, 's1')
  draw(id, 2, 's2')

  const asker = socket()
  enter(asker, id, 'p_2')
  const other = socket()
  enter(other, id, 'p_3')
  const heardBefore = other.heard.length

  // The one asking is NOT the host: the whole room sees the ink, not only the
  // console.
  const student: TokenPayload = { sessionId: id, participantId: 'p_2', role: 'participant' }
  dispatch(asker.ws, id, student, { t: 'ink:page', page: 2 })
  assert.deepEqual(pageFrames(asker), [{ page: 2, strokes: 2 }])
  assert.equal(other.heard.length, heardBefore, "the answer to someone else's request went to the whole room")

  // A blank sheet: an empty list means "the page is blank", and the tab closes
  // the request on it. Silence would leave it waiting for ink until the end of
  // the lecture.
  dispatch(asker.ws, id, who(id, 'p_2'), { t: 'ink:page', page: -1 })
  assert.deepEqual(pageFrames(asker).at(-1), { page: -1, strokes: 0 })

  // Junk from the tab: `Number` gives NaN, and `JSON.stringify` writes it as
  // `null` — the tab would take such an answer for an answer about its page.
  const before = pageFrames(asker).length
  dispatch(asker.ws, id, who(id, 'p_2'), {
    t: 'ink:page',
    page: 'вторая',
  } as unknown as { t: 'ink:page'; page: number })
  assert.equal(pageFrames(asker).length, before)

  stopLecture(id)
  closeControlRoom(id)
})

test('a page turn by the host sends the markup on its own — to the hall, not on request', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 5, 's1')

  const hall = socket()
  enter(hall, id, 'p_2')
  const before = pageFrames(hall).length

  dispatch(hall.ws, id, who(id, 'p_2'), { t: 'lecture:page', page: 5 })
  assert.equal(pageFrames(hall).length, before, 'the page is moved by someone other than the host')

  dispatch(hall.ws, id, who(id, 'p_1'), { t: 'lecture:page', page: 5 })
  assert.deepEqual(pageFrames(hall).at(-1), { page: 5, strokes: 1 })

  // And to a blank page too: an empty frame costs tens of bytes, while without
  // it the tab waits half a second and then asks itself, all five hundred of
  // them.
  dispatch(hall.ws, id, who(id, 'p_1'), { t: 'lecture:page', page: 6 })
  assert.deepEqual(pageFrames(hall).at(-1), { page: 6, strokes: 0 })

  stopLecture(id)
  closeControlRoom(id)
})

test('the inventory rides next to every full ink frame: lecture start and "erase"', () => {
  const id = room()
  makeFile(id, 'первая.pdf', '%PDF-1.4')
  makeFile(id, 'вторая.pdf', '%PDF-1.4')
  startLecture(id, { file: 'первая.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 1, 's1')
  draw(id, 4, 's2')

  const hall = socket()
  enter(hall, id, 'p_2')
  assert.deepEqual(listed(hall), [1, 4])

  // A page was erased — the inventory shrank.
  dispatch(hall.ws, id, who(id, 'p_1'), { t: 'ink:clear', page: 4 })
  assert.deepEqual(listed(hall), [1], 'the erased page stayed in the inventory as an extra sheet')

  // Everything was erased — the inventory is empty.
  dispatch(hall.ws, id, who(id, 'p_1'), { t: 'ink:clear' })
  assert.deepEqual(listed(hall), [])

  // A new lecture: an empty ink frame and an empty inventory next to it — the
  // inventory lives on the tab longer than the ink, and sheets from the
  // previous lecture would remain in the strip.
  draw(id, 2, 's3')
  dispatch(hall.ws, id, who(id, 'p_1'), { t: 'lecture:start', file: 'вторая.pdf' })
  assert.deepEqual(inkPages(hall), [], 'the new lecture did not clear the ink for the hall')
  assert.deepEqual(listed(hall), [])

  clearInk(id)
  stopLecture(id)
  closeControlRoom(id)
})
