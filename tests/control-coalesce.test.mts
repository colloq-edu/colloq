/**
 * What the room receives and what it does NOT: frame coalescing and ceilings
 * said out loud.
 *
 * The control socket is the only place where one gesture turns into a
 * `ws.send` loop over all of the room's sockets. With twenty people nobody
 * noticed; with five hundred every extra frame means five hundred sends and
 * five hundred separate compressions. Three things are checked here with
 * assertions rather than by eye:
 *
 *   — a file list unchanged since the last broadcast does not go out at all
 *     (the tick is armed by autosave and by kernel output, while the tree is
 *     most often the same);
 *   — an already built tree is taken as is, without a second walk of the
 *     folder;
 *   — the laser pointer is coalesced per tick, and within a tick the last
 *     point wins;
 *   — the ink ceiling answers IN WORDS, not with silence: the console could
 *     not tell silence from a lost frame and resent the whole stroke eight
 *     times.
 *
 * No network, no kernel: the sockets are fake, the room is real, and the
 * dispatcher is the same one that listens to the wire.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession } from '../server/src/db.js'
import { makeFile } from '../server/src/workspace.js'
import {
  broadcastFiles,
  closeControlRoom,
  dispatch,
  handleControlSocket,
} from '../server/src/control.js'
import { startLecture, stopLecture } from '../server/src/lecture.js'
import { MAX_POINTS_PER_STROKE, inkFullSays } from '../shared/lecture.js'
import { applyFilesDelta } from '../web/src/lib/files-delta.js'
import type {
  ControlClientMessage,
  ControlServerMessage,
  FileEntry,
} from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
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
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {},
    // The close must reach the handler: it is the only way the room learns it
    // has emptied — and half of the checks below rest on that.
    close() {
      fake.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  return { ws: fake as unknown as WebSocket, heard }
}

let rooms = 0

function room(): { id: string; host: TokenPayload; seat: ReturnType<typeof socket> } {
  const id = `coalesce-${++rooms}`
  createSession(id, 'Склейка', null)
  const host: TokenPayload = { sessionId: id, participantId: 'p_host', role: 'host' }
  const seat = socket()
  handleControlSocket(seat.ws, id, host)
  return { id, host, seat }
}

function say(id: string, who: TokenPayload, ws: WebSocket, message: ControlClientMessage): void {
  dispatch(ws, id, who, message)
}

/**
 * Everything the room was told about the tree, as full frames and as changes.
 *
 * A change in the tree travels as a delta (`files:delta`), not as the whole
 * list: one new file cost a room of five hundred people 3.0 MB. BOTH kinds
 * still have to be counted — silence is checked against their sum.
 */
const filesFrames = (heard: ControlServerMessage[]): ControlServerMessage[] =>
  heard.filter((frame) => frame.t === 'files' || frame.t === 'files:delta')

/** The tree as a client would assemble it from what it was told. */
function treeOf(heard: ControlServerMessage[]): string[] {
  let files: FileEntry[] = []
  for (const frame of heard) {
    if (frame.t === 'files') files = frame.files
    else if (frame.t === 'files:delta') files = applyFilesDelta(files, frame)
  }
  return files.map((entry) => entry.path)
}

const laserFrames = (heard: ControlServerMessage[]): ControlServerMessage[] =>
  heard.filter((frame) => frame.t === 'laser')

/* -------------------------------------------------------------- tree */

test('the same tree does not go out a second time', () => {
  /*
   * The broadcast tick is armed by everything that TOUCHES the folder: editor
   * autosave, the notebook projection, a write from a cell. While a cell with
   * `print` in a loop is running, that is twice a second — with the disk
   * standing still.
   */
  const { id, seat } = room()
  makeFile(id, 'model.py', 'x = 1')
  seat.heard.length = 0

  broadcastFiles(id)
  assert.equal(filesFrames(seat.heard).length, 1, 'the first broadcast did not go out')

  broadcastFiles(id)
  broadcastFiles(id)
  assert.equal(filesFrames(seat.heard).length, 1, 'an unchanged tree went out again')

  // But a real change does go out: the silence here is about repetition, not
  // about caching.
  makeFile(id, 'data.csv', 'a,b')
  broadcastFiles(id)
  assert.equal(filesFrames(seat.heard).length, 2, 'the new file did not reach the room')
  // And it goes out as a CHANGE, not as the whole list: one entry in the frame,
  // not the whole folder.
  const change = seat.heard.at(-1)
  assert.ok(change && change.t === 'files:delta', 'a new file carried the whole tree along')
  assert.deepEqual(
    change.added.map((one) => one.entry.path),
    ['data.csv'],
  )
  assert.deepEqual(change.removed, [])
  assert.deepEqual(treeOf(seat.heard), ['data.csv', 'model.py'], 'the tree assembled from the changes came out wrong')
  closeControlRoom(id)
})

test('a change applies only to the list it was computed from', () => {
  /*
   * The list number is the only way a delta proves there is something to merge
   * it with. The room stood empty, a newcomer recomputed the tree — the number
   * moved, and for those who did not see that the delta will not fit: they
   * will ask for the whole tree (`files:ask`) instead of applying the change to
   * someone else's list.
   */
  const { id, host, seat } = room()
  makeFile(id, 'model.py', 'x = 1')
  broadcastFiles(id)
  const first = seat.heard.filter((frame) => frame.t === 'files').at(-1)
  assert.ok(first && first.t === 'files')
  assert.equal(typeof first.rev, 'number', 'the full list arrived without a number')

  seat.heard.length = 0
  makeFile(id, 'data.csv', 'a,b')
  broadcastFiles(id)
  const delta = seat.heard.at(-1)
  assert.ok(delta && delta.t === 'files:delta')
  assert.equal(delta.from, first.rev, 'the change was computed from the wrong list')
  assert.equal(delta.rev, (first.rev ?? 0) + 1, 'the number did not grow by one')

  // And a question about the full tree gets an answer, with the same frame as
  // in the batch.
  seat.heard.length = 0
  say(id, host, seat.ws, { t: 'files:ask' })
  const full = seat.heard.at(-1)
  assert.ok(full && full.t === 'files', 'the question about the tree was answered with silence')
  assert.equal(full.rev, delta.rev, 'the answer came with the number of the wrong change')
  assert.deepEqual(full.files.map((entry) => entry.path), ['data.csv', 'model.py'])
  closeControlRoom(id)
})

test('a truncated tree travels whole: in it "missing" and "did not fit" are indistinguishable', () => {
  const { id, seat } = room()
  makeFile(id, 'model.py', 'x = 1')
  broadcastFiles(id)
  seat.heard.length = 0

  // A ready tree with the truncation flag, as the walk returns it on hitting
  // the ceiling.
  broadcastFiles(id, {
    files: [{ name: 'model.py', path: 'model.py', dir: false, size: 5, modifiedAt: 1 }],
    truncated: true,
  })
  const frame = seat.heard.at(-1)
  assert.ok(frame && frame.t === 'files', 'a truncated tree was described as a change')
  assert.equal(frame.truncated, true)

  // And back: from truncated to full also goes whole, there is nothing to
  // merge with.
  seat.heard.length = 0
  broadcastFiles(id, {
    files: [{ name: 'model.py', path: 'model.py', dir: false, size: 5, modifiedAt: 2 }],
    truncated: false,
  })
  const back = seat.heard.at(-1)
  assert.ok(back && back.t === 'files', 'the change was computed from the truncated list')
  assert.equal(back.truncated, false)
  closeControlRoom(id)
})

test('an emptied room does not carry its tree memo into the next class', () => {
  /*
   * The room's memo holds both the list and its number, and the broadcast's
   * silence rests on it. While the room stands empty the tree may change —
   * and a memo that outlived the last person to leave would make the next
   * broadcast stay silent before people who saw none of it.
   *
   * A newcomer gets the list in the welcome batch, so there is no need to
   * repeat it with the same frame: that is exactly what is checked — first
   * silence for an unchanged tree, then a real change reaching the newcomer.
   */
  const { id, seat } = room()
  makeFile(id, 'model.py', 'x = 1')
  broadcastFiles(id)

  seat.ws.close()
  makeFile(id, 'while-empty.txt', 'пока никого не было')
  const second = socket()
  handleControlSocket(second.ws, id, { sessionId: id, participantId: 'p_two', role: 'participant' })
  assert.deepEqual(
    treeOf(second.heard),
    ['model.py', 'while-empty.txt'],
    'the newcomer got a tree without the file put into the empty room',
  )

  const told = filesFrames(second.heard).length
  broadcastFiles(id)
  assert.equal(
    filesFrames(second.heard).length,
    told,
    'an unchanged tree went to the newcomer a second time',
  )

  makeFile(id, 'data.csv', 'a,b')
  broadcastFiles(id)
  assert.deepEqual(
    treeOf(second.heard),
    ['data.csv', 'model.py', 'while-empty.txt'],
    'the change after the empty room did not reach the newcomer',
  )
  closeControlRoom(id)
})

test('a ready tree is taken as is: no second walk of the folder is needed', () => {
  /*
   * One file upload walked the folder twice: once for the reply, a second time
   * inside the broadcast. The tree handed in by the caller differs here from
   * what is on disk — and that is exactly what proves `listTree` was not
   * called.
   */
  const { id, seat } = room()
  makeFile(id, 'real.py', 'x = 1')
  seat.heard.length = 0

  broadcastFiles(id, {
    files: [{ name: 'given.py', path: 'given.py', dir: false, size: 3, modifiedAt: 0 }],
    truncated: false,
  })
  const frame = filesFrames(seat.heard).at(-1)
  assert.ok(frame && frame.t === 'files')
  assert.deepEqual(
    frame.files.map((entry) => entry.path),
    ['given.py'],
    'the tree was recomputed although it was given ready',
  )
  closeControlRoom(id)
})

/* ----------------------------------------------------- laser pointer */

test('the laser pointer is coalesced per tick, and within a tick the last point wins', async () => {
  const { id, host, seat } = room()
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  // The first frame goes at once: the pointer must appear where it was
  // pointed.
  say(id, host, seat.ws, { t: 'laser', page: 1, x: 0.1, y: 0.1 })
  assert.equal(laserFrames(seat.heard).length, 1, "the pointer's first frame was held back")

  // Everything that arrived within the tick goes as one frame, and it is the
  // hand's last position.
  for (let i = 0; i < 20; i += 1) {
    say(id, host, seat.ws, { t: 'laser', page: 1, x: 0.2 + i / 100, y: 0.2 })
  }
  assert.equal(laserFrames(seat.heard).length, 1, 'every movement of the hand went out as a separate frame')

  await new Promise((done) => setTimeout(done, 120))
  const frames = laserFrames(seat.heard)
  assert.equal(frames.length, 2, 'the tail of the tick did not go out, or more than one did')
  const last = frames[1]
  assert.ok(last.t === 'laser' && last.at)
  assert.equal(last.at.x, 0.2 + 19 / 100, 'the point sent was not the last one')

  stopLecture(id)
  closeControlRoom(id)
})

test('a pointer that was turned off is not relit by the tail of a tick', async () => {
  /*
   * A held-back point must leave together with the hand. Otherwise "off" turns
   * the dot off, and sixty milliseconds later it comes back to where the hand
   * was.
   */
  const { id, host, seat } = room()
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  say(id, host, seat.ws, { t: 'laser', page: 1, x: 0.1, y: 0.1 })
  say(id, host, seat.ws, { t: 'laser', page: 1, x: 0.9, y: 0.9 })
  say(id, host, seat.ws, { t: 'laser:off' })
  await new Promise((done) => setTimeout(done, 120))

  const frames = laserFrames(seat.heard)
  const last = frames.at(-1)
  assert.ok(last && last.t === 'laser')
  assert.equal(last.at, null, 'after "off" the pointer lit up again')

  stopLecture(id)
  closeControlRoom(id)
})

/* --------------------------------------------------------------- ink */

test('the stroke ceiling answers in words, not with silence', () => {
  /*
   * The console counts its two ceilings itself and does not even start a
   * stroke on a full page; points that run out IN THE MIDDLE of a stroke it
   * cannot count — the server speaks about those. Silence here cost four
   * seconds and eight resends of the whole stroke.
   */
  const { id, host, seat } = room()
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })

  const chunk = Array.from({ length: 512 }, () => 0.5)
  for (let i = 0; i < MAX_POINTS_PER_STROKE / 512 + 2; i += 1) {
    say(id, host, seat.ws, {
      t: 'ink',
      id: 'long',
      page: 1,
      color: '#111',
      width: 0.004,
      points: chunk,
    })
  }
  seat.heard.length = 0
  say(id, host, seat.ws, {
    t: 'ink',
    id: 'long',
    page: 1,
    color: '#111',
    width: 0.004,
    points: [0.1, 0.1],
  })

  const refusal = seat.heard.find((frame) => frame.t === 'error')
  assert.ok(refusal && refusal.t === 'error', 'the overflowing stroke was refused silently')
  assert.equal(refusal.message, inkFullSays('stroke-full'))
  assert.ok(
    !seat.heard.some((frame) => frame.t === 'ink:add'),
    'the refused stroke was broadcast anyway',
  )

  stopLecture(id)
  closeControlRoom(id)
})

test('unpaired points still get silence: nothing to add, not a ceiling', () => {
  // Telling "nothing to add" from "hit the ceiling" is the server's job: the
  // first is garbage from a tab that there is nothing to tell a person about.
  const { id, host, seat } = room()
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  say(id, host, seat.ws, {
    t: 'ink',
    id: 's1',
    page: 1,
    color: '#111',
    width: 0.004,
    points: [0.5],
  })
  assert.deepEqual(seat.heard, [], 'an empty frame was answered with words')

  stopLecture(id)
  closeControlRoom(id)
})
