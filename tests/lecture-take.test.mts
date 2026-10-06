/**
 * Taking the console of a running lecture — the server half.
 *
 * The take-over used to be a second `lecture:start` on the same file, and
 * that made one press do three different things depending on what the room
 * had become by the time it arrived: hand the console over, start a new
 * lecture for the whole hall (when the old one had ended while the press sat
 * in an offline queue), or silently take it from a third person. Now it is
 * its own message that names what it expects, and every promise below is one
 * whose absence costs a class:
 *
 *  • a take-over keeps the page, the ink and the clock, and names the new
 *    hands (device, person, since when);
 *  • it never starts anything, and refuses in words when the room moved on;
 *  • it is the teacher's, whatever the `board` rule says;
 *  • "give it back" is the same message the other way;
 *  • a start no longer takes anything;
 *  • a holder who left is shown as gone, and comes back as soon as they do;
 *  • the same teacher in two browsers is one person to the room's words.
 *
 * Neither network nor browser: the sockets are fake, the room is real.
 */
import './_env.mts'
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import {
  addInk,
  inkOf,
  lectureOf,
  startLecture,
  stopLecture,
  turnTo,
} from '../server/src/lecture.js'
import { makeFile } from '../server/src/workspace.js'
import { AWAY_GRACE_MS, type LectureState } from '../shared/lecture.js'
import { OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'
import { createTeacher } from '../server/src/admin/store.js'
import { addRoomTeacher } from '../server/src/admin/access.js'

interface Fake {
  ws: WebSocket
  heard: ControlServerMessage[]
  /** Close it the way the network does: the server's own handlers run. */
  close: () => void
}

function socket(): Fake {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, Array<() => void>>()
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on(event: string, handler: () => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
    },
  }
  const close = () => {
    fake.readyState = WebSocket.CLOSED
    for (const handler of handlers.get('close') ?? []) handler()
  }
  return { ws: fake as unknown as WebSocket, heard, close }
}

let rooms = 0

/*
 * Two real staff rows. A tablet's `staff` claim counts as "the same teacher"
 * only for someone who teaches the room (0.19), so every room below is
 * taught by both of them.
 */
const ADA = createTeacher({ name: 'Ада', email: `take-ada-${process.pid}@example.edu`, role: 'teacher' })!.id
const BORIS = createTeacher({ name: 'Борис', email: `take-boris-${process.pid}@example.edu`, role: 'teacher' })!.id

function room(rules: Partial<RoomRules> = {}): string {
  const id = `take-${++rooms}`
  createSession(id, 'Лекция', null)
  setRules(id, { ...OPEN_ROOM, ...rules })
  makeFile(id, 'slides.pdf', '%PDF-1.4')
  makeFile(id, 'other.pdf', '%PDF-1.4')
  addRoomTeacher(id, ADA, null)
  addRoomTeacher(id, BORIS, null)
  return id
}

function host(sessionId: string, participantId: string, staff?: string): TokenPayload {
  return { sessionId, participantId, role: 'host', ...(staff ? { staff } : {}) }
}

function student(sessionId: string, participantId: string): TokenPayload {
  return { sessionId, participantId, role: 'participant' }
}

/** What the server said to this socket in words; the last refusal or `null`. */
function said(sock: Fake): string | null {
  for (let i = sock.heard.length - 1; i >= 0; i--) {
    const m = sock.heard[i]
    if (m.t === 'error') return m.message
  }
  return null
}

/** The last lecture state this socket heard. */
function heardLecture(sock: Fake): LectureState | null | undefined {
  for (let i = sock.heard.length - 1; i >= 0; i--) {
    const m = sock.heard[i]
    if (m.t === 'lecture') return m.state
  }
  return undefined
}

function take(
  going: LectureState,
  extra: Partial<ControlClientMessage & { t: 'lecture:take' }> = {},
) {
  return {
    t: 'lecture:take',
    file: going.file,
    from: going.by,
    startedAt: going.startedAt,
    ...extra,
  } as ControlClientMessage
}

/** A lecture by p_ada on page 14 with a stroke on it — forty minutes in. */
function running(id: string): LectureState {
  const state = startLecture(id, {
    file: 'slides.pdf',
    by: 'p_ada',
    byName: 'Ада',
    color: '#d4162f',
  })
  turnTo(id, 14)
  addInk(id, { id: 's1', page: 14, color: '#d4162f', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] })
  return { ...state, page: 14 }
}

/* -------------------------------------------------------------- the take */

test('a take-over changes the hands and nothing else', () => {
  const id = room()
  const going = running(id)
  const hall = socket()
  handleControlSocket(hall.ws, id, student(id, 'p_hall'))
  const mac = socket()
  handleControlSocket(mac.ws, id, host(id, 'p_mac'))

  dispatch(mac.ws, id, host(id, 'p_mac'), take(going, { device: { kind: 'mac', console: false } }))

  const now = lectureOf(id)
  assert.equal(now?.by, 'p_mac', 'the console did not change hands')
  assert.equal(now?.page, 14, 'the page went back to the start')
  assert.equal(now?.startedAt, going.startedAt, 'the lecture clock restarted')
  assert.equal(inkOf(id).length, 1, 'the markup was erased')
  assert.deepEqual(
    now?.device,
    { kind: 'mac', console: false },
    'the room cannot say where it is presented from',
  )
  assert.ok((now?.since ?? 0) >= going.startedAt, 'the take has no time for "taken over at 21:14"')
  assert.equal(now?.awaySince, null)
  // The hall hears it — that is also how the previous hands learn they lost it.
  assert.equal(heardLecture(hall)?.by, 'p_mac', 'the room was not told who presents now')
  closeControlRoom(id)
})

test('"give it back" is the same message the other way', () => {
  const id = room()
  const going = running(id)
  const ipad = socket()
  handleControlSocket(ipad.ws, id, host(id, 'p_ada'))
  const mac = socket()
  handleControlSocket(mac.ws, id, host(id, 'p_mac'))

  dispatch(mac.ws, id, host(id, 'p_mac'), take(going))
  const taken = lectureOf(id)!
  assert.equal(taken.by, 'p_mac')
  assert.equal(heardLecture(ipad)?.by, 'p_mac', 'the old console was not told')

  dispatch(ipad.ws, id, host(id, 'p_ada'), take(taken, { device: { kind: 'ipad', console: true } }))
  assert.equal(lectureOf(id)?.by, 'p_ada', 'the console did not come back')
  assert.equal(lectureOf(id)?.page, 14)
  assert.deepEqual(lectureOf(id)?.device, { kind: 'ipad', console: true })
  closeControlRoom(id)
})

test('the held pieces of a stroke reach the hall before the new hands do', () => {
  /*
   * "The line you were drawing was kept up to the moment of the take": the
   * hall must get every point the old console sent before the take, and only
   * then hear that someone else presents.
   */
  const id = room()
  const going = running(id)
  const hall = socket()
  handleControlSocket(hall.ws, id, student(id, 'p_hall'))
  const ipad = socket()
  handleControlSocket(ipad.ws, id, host(id, 'p_ada'))
  const mac = socket()
  handleControlSocket(mac.ws, id, host(id, 'p_mac'))
  hall.heard.length = 0

  dispatch(ipad.ws, id, host(id, 'p_ada'), {
    t: 'ink',
    page: 14,
    id: 's2',
    color: '#d4162f',
    width: 0.005,
    points: [0.3, 0.3, 0.4, 0.4],
    from: 0,
  } as ControlClientMessage)
  dispatch(mac.ws, id, host(id, 'p_mac'), take(going))

  const order = hall.heard.map((m) => m.t).filter((t) => t === 'ink:add' || t === 'lecture')
  assert.ok(order.includes('ink:add'), 'the stroke in progress never reached the hall')
  assert.ok(order.indexOf('ink:add') < order.lastIndexOf('lecture'), 'the take overtook the stroke')
  assert.ok(
    inkOf(id).some((stroke) => stroke.id === 's2'),
    'the half-drawn line was dropped',
  )

  // And after the take the old console's pen no longer reaches anyone.
  dispatch(ipad.ws, id, host(id, 'p_ada'), {
    t: 'ink',
    page: 14,
    id: 's2',
    color: '#d4162f',
    width: 0.005,
    points: [0.4, 0.4, 0.5, 0.5],
    from: 4,
  } as ControlClientMessage)
  assert.equal(
    inkOf(id).find((stroke) => stroke.id === 's2')?.points.length,
    4,
    'the old hands drew after the take',
  )
  closeControlRoom(id)
})

/* ------------------------------------------------------- what it refuses */

test('a take-over never starts a lecture that has ended', () => {
  /*
   * The press sat in an offline queue while the presenter finished at the
   * lectern; the iPad came back fifteen seconds later. It used to start a
   * NEW lecture for the whole hall and pull students out of their notebooks.
   */
  const id = room()
  const going = running(id)
  stopLecture(id)
  const ipad = socket()
  handleControlSocket(ipad.ws, id, host(id, 'p_ipad'))

  dispatch(ipad.ws, id, host(id, 'p_ipad'), take(going))
  assert.equal(lectureOf(id), null, 'a finished lecture was restarted by a late press')
  assert.match(said(ipad) ?? '', /закончилась/, 'the refusal said nothing')

  // Nor one that ended and was started again on the same file: it is another lecture.
  startLecture(id, { file: 'slides.pdf', by: 'p_ada', byName: 'Ада', color: '#d4162f' })
  const restarted = lectureOf(id)!
  dispatch(ipad.ws, id, host(id, 'p_ipad'), take({ ...going, startedAt: going.startedAt - 1000 }))
  assert.equal(lectureOf(id)?.by, 'p_ada', 'a press meant for the previous lecture took this one')
  assert.equal(lectureOf(id)?.startedAt, restarted.startedAt)
  closeControlRoom(id)
})

test('a take-over meant for one holder does not take the console from another', () => {
  const id = room()
  const going = running(id)
  const boris = socket()
  handleControlSocket(boris.ws, id, host(id, 'p_boris'))
  const ipad = socket()
  handleControlSocket(ipad.ws, id, host(id, 'p_ipad'))

  // Boris took it first; the iPad's press still names Ada.
  dispatch(boris.ws, id, host(id, 'p_boris'), take(going))
  dispatch(ipad.ws, id, host(id, 'p_ipad'), take(going))

  assert.equal(lectureOf(id)?.by, 'p_boris', 'the console was silently taken from the second taker')
  assert.match(said(ipad) ?? '', /перешёл/, 'the refusal did not say who has it now')
  closeControlRoom(id)
})

test('taking the console is the teacher’s, not anyone’s who may use the board', () => {
  const id = room({ board: 'room' })
  const going = running(id)
  const sock = socket()
  handleControlSocket(sock.ws, id, student(id, 'p_student'))

  dispatch(sock.ws, id, student(id, 'p_student'), take(going))
  assert.equal(lectureOf(id)?.by, 'p_ada', 'a student took the console')
  assert.match(said(sock) ?? '', /преподаватель/)
  closeControlRoom(id)
})

test('a start no longer takes the console of a running lecture', () => {
  const id = room()
  running(id)
  const sock = socket()
  handleControlSocket(sock.ws, id, host(id, 'p_boris'))

  dispatch(sock.ws, id, host(id, 'p_boris'), { t: 'lecture:start', file: 'slides.pdf' })
  assert.equal(lectureOf(id)?.by, 'p_ada', 'a start took the console')
  assert.equal(lectureOf(id)?.page, 14, 'a start restarted the lecture')
  assert.equal(inkOf(id).length, 1)
  assert.match(
    said(sock) ?? '',
    /Перехватить лекцию/,
    'the refusal did not say where the take-over is',
  )
  closeControlRoom(id)
})

/* -------------------------------------------------------------- presence */

test('a holder who left is shown as gone after the grace, and back as soon as they return', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    const id = room()
    const ipadSock = socket()
    handleControlSocket(ipadSock.ws, id, host(id, 'p_ada'))
    const hall = socket()
    handleControlSocket(hall.ws, id, host(id, 'p_mac'))
    startLecture(id, { file: 'slides.pdf', by: 'p_ada', byName: 'Ада', color: '#d4162f' })

    ipadSock.close()
    // An iPad that locked its screen comes back within the grace: nobody is told.
    mock.timers.tick(AWAY_GRACE_MS - 1)
    assert.equal(lectureOf(id)?.awaySince, null, 'a blink was announced as a departure')

    mock.timers.tick(1)
    assert.equal(
      lectureOf(id)?.awaySince,
      1_000_000,
      '"offline" does not count from the moment they went',
    )
    assert.equal(
      heardLecture(hall)?.awaySince,
      1_000_000,
      'the room was not told the holder is gone',
    )
    assert.equal(lectureOf(id)?.by, 'p_ada', 'the console moved by itself')

    // Back on any device: the room hears it at once.
    const back = socket()
    handleControlSocket(back.ws, id, host(id, 'p_ada'))
    assert.equal(lectureOf(id)?.awaySince, null)
    assert.equal(heardLecture(hall)?.awaySince, null, 'the return was not told')
    closeControlRoom(id)
  } finally {
    mock.timers.reset()
  }
})

test('a blink inside the grace is never announced', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000 })
  try {
    const id = room()
    const first = socket()
    handleControlSocket(first.ws, id, host(id, 'p_ada'))
    startLecture(id, { file: 'slides.pdf', by: 'p_ada', byName: 'Ада', color: '#d4162f' })
    first.close()
    mock.timers.tick(1000)
    const again = socket()
    handleControlSocket(again.ws, id, host(id, 'p_ada'))
    mock.timers.tick(AWAY_GRACE_MS * 2)
    assert.equal(
      lectureOf(id)?.awaySince,
      null,
      'a reconnect inside the grace was announced as gone',
    )
    closeControlRoom(id)
  } finally {
    mock.timers.reset()
  }
})

test('the console of an absent holder is taken at once, and the "offline" goes with them', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 3_000_000 })
  try {
    const id = room()
    const lid = socket()
    handleControlSocket(lid.ws, id, host(id, 'p_ada'))
    const going = startLecture(id, {
      file: 'slides.pdf',
      by: 'p_ada',
      byName: 'Ада',
      color: '#d4162f',
    })
    lid.close()
    mock.timers.tick(AWAY_GRACE_MS)
    assert.equal(lectureOf(id)?.awaySince, 3_000_000)

    const mac = socket()
    handleControlSocket(mac.ws, id, host(id, 'p_mac'))
    dispatch(mac.ws, id, host(id, 'p_mac'), take(going))
    assert.equal(lectureOf(id)?.by, 'p_mac', 'the take-over waited for an absent holder')
    assert.equal(
      lectureOf(id)?.awaySince,
      null,
      "the previous holder's absence stuck to the new one",
    )
    closeControlRoom(id)
  } finally {
    mock.timers.reset()
  }
})

/* ------------------------------------------------- one teacher, two screens */

test('the same teacher in two browsers is one person to the room, and nobody else is', () => {
  const id = room()
  const a = socket()
  handleControlSocket(a.ws, id, host(id, 'p_chrome', ADA))
  const b = socket()
  handleControlSocket(b.ws, id, host(id, 'p_safari', ADA))
  const c = socket()
  handleControlSocket(c.ws, id, host(id, 'p_boris', BORIS))
  const d = socket()
  handleControlSocket(d.ws, id, student(id, 'p_student'))

  const person = (sock: Fake) => {
    const role = sock.heard.find((m) => m.t === 'role')
    return role && role.t === 'role' ? (role.person ?? null) : undefined
  }
  assert.ok(person(a), 'a teacher connection has no person key')
  assert.equal(person(a), person(b), 'two browsers of one teacher are two people')
  assert.notEqual(person(a), person(c), 'two teachers are one person')
  assert.equal(person(d), null, 'a student got a person key')
  assert.ok(!String(person(a)).includes(ADA), 'the key gives away the staff id')

  dispatch(a.ws, id, host(id, 'p_chrome', ADA), {
    t: 'lecture:start',
    file: 'slides.pdf',
    device: { kind: 'ipad', console: true },
  })
  assert.equal(lectureOf(id)?.byPerson, person(a), 'the lecture does not say whose it is')
  assert.equal(
    heardLecture(b)?.byPerson,
    person(b),
    'the second browser cannot tell the lecture is its own',
  )
  closeControlRoom(id)
})

test('each teacher connection is told which participants are its own other browsers, and nobody else is', () => {
  const id = room()
  const devices = (sock: Fake) => {
    for (let i = sock.heard.length - 1; i >= 0; i--) {
      const m = sock.heard[i]
      if (m.t === 'person:devices') return [...m.ids].sort()
    }
    return null
  }
  const chrome = socket()
  handleControlSocket(chrome.ws, id, host(id, 'p_chrome', ADA))
  const boris = socket()
  handleControlSocket(boris.ws, id, host(id, 'p_boris', BORIS))
  const safari = socket()
  handleControlSocket(safari.ws, id, host(id, 'p_safari', ADA))
  const student = socket()
  handleControlSocket(student.ws, id, {
    sessionId: id,
    participantId: 'p_student',
    role: 'participant',
  })

  assert.deepEqual(
    devices(chrome),
    ['p_chrome', 'p_safari'],
    'the first browser was not told about the second',
  )
  assert.deepEqual(devices(safari), ['p_chrome', 'p_safari'])
  assert.deepEqual(
    devices(boris),
    ['p_boris'],
    'a colleague was told about someone else’s browsers',
  )
  assert.equal(devices(student), null, 'a student was told who is whose')

  safari.close()
  assert.deepEqual(devices(chrome), ['p_chrome'], 'the second browser leaving was not told')
  closeControlRoom(id)
})

test('a person key is per room: the same teacher reads differently next door', () => {
  const first = room()
  const second = room()
  const a = socket()
  handleControlSocket(a.ws, first, host(first, 'p_1', ADA))
  const b = socket()
  handleControlSocket(b.ws, second, host(second, 'p_1', ADA))
  const key = (sock: Fake) => sock.heard.find((m) => m.t === 'role')
  assert.notEqual(
    JSON.stringify(key(a)),
    JSON.stringify(key(b)),
    'one key follows a teacher across rooms',
  )
  closeControlRoom(first)
  closeControlRoom(second)
})

test('a teacher who does not teach the room gets no person key: their browsers stay two participants', () => {
  const guest = createTeacher({ name: 'Глеб', email: `take-guest-${process.pid}@example.edu`, role: 'teacher' })!.id
  const id = room()
  const a = socket()
  handleControlSocket(a.ws, id, host(id, 'p_g1', guest))
  const role = a.heard.find((m) => m.t === 'role')
  assert.ok(role && role.t === 'role')
  assert.equal(role.person ?? null, null, 'a guest teacher was merged as the room’s presenter')
  closeControlRoom(id)
})

test('the device follows the hand that acts', () => {
  /*
   * The laptop started the lecture; then the same person picked up the iPad
   * (the handoff link makes it the same participant) and turns the pages
   * from there. "Presented from the Mac" would be a wrong sentence for the
   * rest of the class.
   */
  const id = room()
  const laptop = socket()
  handleControlSocket(laptop.ws, id, host(id, 'p_ada'))
  const ipad = socket()
  handleControlSocket(ipad.ws, id, host(id, 'p_ada'))
  dispatch(laptop.ws, id, host(id, 'p_ada'), {
    t: 'lecture:start',
    file: 'slides.pdf',
    device: { kind: 'mac', console: false },
  })
  dispatch(ipad.ws, id, host(id, 'p_ada'), { t: 'device', device: { kind: 'ipad', console: true } })
  const before = lectureOf(id)!.actedAt ?? 0
  dispatch(ipad.ws, id, host(id, 'p_ada'), { t: 'lecture:page', page: 2 })

  assert.deepEqual(
    lectureOf(id)?.device,
    { kind: 'ipad', console: true },
    'the device stayed with the laptop',
  )
  assert.ok((lectureOf(id)?.actedAt ?? 0) >= before, '"last action" did not move')
  assert.deepEqual(heardLecture(laptop)?.device, { kind: 'ipad', console: true })

  // A device the server cannot name is not taken.
  dispatch(ipad.ws, id, host(id, 'p_ada'), {
    t: 'device',
    device: { kind: 'toaster', console: true },
  } as never)
  dispatch(ipad.ws, id, host(id, 'p_ada'), { t: 'lecture:page', page: 3 })
  assert.deepEqual(lectureOf(id)?.device, { kind: 'ipad', console: true })
  closeControlRoom(id)
})

test('only the holder’s actions move "last action"', () => {
  const id = room()
  const going = startLecture(id, {
    file: 'slides.pdf',
    by: 'p_ada',
    byName: 'Ада',
    color: '#d4162f',
  })
  const other = socket()
  handleControlSocket(other.ws, id, host(id, 'p_boris'))
  dispatch(other.ws, id, host(id, 'p_boris'), {
    t: 'device',
    device: { kind: 'windows', console: false },
  })
  dispatch(other.ws, id, host(id, 'p_boris'), { t: 'lecture:page', page: 5 })
  assert.equal(
    lectureOf(id)?.actedAt,
    going.actedAt,
    "someone else's press counted as the holder acting",
  )
  assert.equal(lectureOf(id)?.device ?? null, null)
  closeControlRoom(id)
})

test('another document is still another lecture, ended only by its presenter', () => {
  // The refusal for a running lecture on another file is unchanged.
  const id = room()
  running(id)
  const sock = socket()
  handleControlSocket(sock.ws, id, host(id, 'p_boris'))
  dispatch(sock.ws, id, host(id, 'p_boris'), { t: 'lecture:start', file: 'other.pdf' })
  assert.equal(lectureOf(id)?.file, 'slides.pdf')
  assert.match(said(sock) ?? '', /Идёт лекция/)
  closeControlRoom(id)
})
