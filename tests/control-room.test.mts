/**
 * What remembers a path, and what outlives the room.
 *
 * The control socket keeps four things close at hand that have no place in
 * the shared document: the file list, the board, the lecture and the speaker
 * notes. Three of them know the document's path by heart, and this breaks
 * silently: rename a FOLDER, and the projector shows a file that does not
 * exist, the speech for twenty-four pages is left under a key that does not
 * exist, and a notebook inside resurrects the deleted folder with its own
 * projection.
 *
 * No network, no kernel: the socket is fake, the room is real. Everything
 * checked here must happen before anyone presses anything.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createSession, notesOf, setNote } from '../server/src/db.js'
import { makeDir, makeFile, sessionDir, statPath } from '../server/src/workspace.js'
import { boardOf, closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { addBook, bookAt } from '../shared/notebook.js'
import { addInk, inkOf, lectureOf, startLecture, stopLecture } from '../server/src/lecture.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Exactly what `send` reads: the state and taking in a frame. */
function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => heard.push(JSON.parse(frame) as ControlServerMessage),
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping: () => {},
    terminate: () => {},
    // The close must reach the handler: the heartbeat is stopped there, and
    // without it the interval outlives the test and drags the whole suite along.
    close: () => {
      for (const fn of handlers.get('close') ?? []) fn()
    },
  } as unknown as WebSocket
  return { ws, heard }
}

let rooms = 0

function room(): { id: string; host: TokenPayload; ws: WebSocket } {
  const id = `ctl-room-${++rooms}`
  createSession(id, 'Управление', null)
  return { id, host: { sessionId: id, participantId: 'p_host', role: 'host' }, ws: socket().ws }
}

function say(ws: WebSocket, id: string, who: TokenPayload, message: ControlClientMessage): void {
  dispatch(ws, id, who, message)
}

/* ----------------------------------------------------- moving a folder */

test('renaming a folder takes the lecture, the board and the notes along', () => {
  /*
   * A double click in the panel starts a rename on any row of the tree,
   * folders included, and `movePath` moves the whole directory. The cascade
   * used to compare the path exactly with `from`, and after a folder move the
   * lecture kept naming `slides/l3.pdf`: the projection went dark for everyone
   * except those who already had the document open, and its speech lost its
   * key.
   */
  const { id, host, ws } = room()
  makeDir(id, 'slides')
  makeFile(id, 'slides/l3.pdf', '%PDF-1.4')
  setNote(id, 'slides/l3.pdf', 7, 'спросить про поток')
  say(ws, id, host, { t: 'board:open', name: 'slides/l3.pdf' })
  startLecture(id, { file: 'slides/l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })

  say(ws, id, host, { t: 'tree:move', from: 'slides', to: 'lectures' })

  assert.ok(statPath(id, 'lectures/l3.pdf'), 'the file did not move')
  assert.equal(lectureOf(id)?.file, 'lectures/l3.pdf', 'the lecture stayed on a dead path')
  assert.equal(boardOf(id), 'lectures/l3.pdf', 'the board stayed on a dead path')
  assert.deepEqual(notesOf(id, 'lectures/l3.pdf'), { 7: 'спросить про поток' })
  assert.deepEqual(notesOf(id, 'slides/l3.pdf'), {}, 'the notes stayed under the old key')

  stopLecture(id)
  closeControlRoom(id)
})

test('renaming a folder also takes the notebook inside it along', () => {
  // Otherwise the notebook stays in the room with the old path, and a second
  // and a half later the projection writes its file back — next to the moved
  // one, into a resurrected folder.
  const { id, host, ws } = room()
  const { doc } = getSessionDoc(id)
  makeDir(id, 'hw')
  makeFile(id, 'hw/task.ipynb', '{}')
  addBook(doc, 'hw/task.ipynb')

  say(ws, id, host, { t: 'tree:move', from: 'hw', to: 'домашка' })

  assert.equal(bookAt(doc, 'hw/task.ipynb'), null, 'the notebook stayed on the old path')
  assert.ok(bookAt(doc, 'домашка/task.ipynb'), 'the notebook did not follow its file')
  closeControlRoom(id)
})

test('deleting a folder removes both the notebook inside it and the board', () => {
  /*
   * The panel asks "Remove the folder with everything in it?" — and the
   * promise holds only if the notebook leaves the room together with the
   * folder. Had it stayed, it would create the folder and the file anew with
   * its own projection, and the deletion would look as if it had not worked.
   */
  const { id, host, ws } = room()
  const { doc } = getSessionDoc(id)
  makeDir(id, 'hw')
  makeFile(id, 'hw/task.ipynb', '{}')
  makeFile(id, 'hw/l3.pdf', '%PDF-1.4')
  addBook(doc, 'hw/task.ipynb')
  say(ws, id, host, { t: 'board:open', name: 'hw/l3.pdf' })

  say(ws, id, host, { t: 'tree:remove', path: 'hw' })

  assert.equal(statPath(id, 'hw/task.ipynb'), null)
  assert.equal(bookAt(doc, 'hw/task.ipynb'), null, 'the notebook outlived its folder')
  assert.equal(boardOf(id), null, 'a file that does not exist stayed on screen')
  closeControlRoom(id)
})

/* -------------------------------------------------- folder walk ceiling */

test('a truncated tree does not blank the board and tells the room it is incomplete', () => {
  /*
   * The folder walk hits a ceiling of two thousand rows, and `pip install -t .`
   * or an unpacked dataset eats all of it. While "the file is not in the list"
   * meant "the file does not exist", the projector went dark in the middle of
   * a lecture — although the document was sitting safely on disk. Now a single
   * `lstat` on the path itself decides whether it is gone, and the room learns
   * that the list is not shown in full.
   */
  const { id, host } = room()
  const seat = socket()
  makeFile(id, 'data.csv', 'a,b')
  // A name starting with "z", so that the cut reaches the lecture document
  // itself: the list is sorted, and its tail is what gets cut.
  makeFile(id, 'zz.pdf', '%PDF-1.4')
  const dir = sessionDir(id)
  for (let i = 0; i < 2005; i++) fs.writeFileSync(path.join(dir, `f${i}.csv`), '')

  handleControlSocket(seat.ws, id, host)
  const welcome = seat.heard.filter((frame) => frame.t === 'files').at(-1)
  assert.equal(welcome?.truncated, true, 'the room was not told that the tree is incomplete')
  assert.ok(
    !welcome?.files.some((file) => file.path === 'zz.pdf'),
    'the document is still in the list: the ceiling did not trigger, so the test checks nothing',
  )

  say(seat.ws, id, host, { t: 'board:open', name: 'zz.pdf' })
  assert.equal(boardOf(id), 'zz.pdf', 'the document is not in the list, and showing it was refused')

  // Any cleanup in the tree checks whether the document on screen still exists.
  seat.heard.length = 0
  say(seat.ws, id, host, { t: 'tree:remove', path: 'data.csv' })
  assert.equal(boardOf(id), 'zz.pdf', 'the board went dark because of an incomplete list')
  assert.equal(
    seat.heard.filter((frame) => frame.t === 'files').at(-1)?.truncated,
    true,
    'the truncation flag got lost on the way to the room',
  )

  closeControlRoom(id)
})

/* ------------------------------------------------------ laser pointer */

test('a laser pointer without a page does not go out to the audience', () => {
  /*
   * `page` went into the frame unchecked, and NaN in JSON is `null`: the
   * audience drew the pointer on its current page, although the presenter was
   * talking about another one.
   */
  const { id, host } = room()
  const seat = socket()
  handleControlSocket(seat.ws, id, host)
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  dispatch(seat.ws, id, host, { t: 'laser', x: 0.5, y: 0.5 } as unknown as ControlClientMessage)
  assert.deepEqual(
    seat.heard.filter((frame) => frame.t === 'laser'),
    [],
    'a frame without a page reached the audience',
  )

  dispatch(seat.ws, id, host, { t: 'laser', page: 3, x: 0.5, y: 0.5 })
  assert.deepEqual(
    seat.heard.filter((frame) => frame.t === 'laser'),
    [{ t: 'laser', at: { page: 3, x: 0.5, y: 0.5, shape: 'line' } }],
  )

  stopLecture(id)
  closeControlRoom(id)
})

test("the presenter's console vanished silently, so the pointer goes out for the audience", () => {
  /*
   * The pointer is stored nowhere and lives exactly as long as frames keep
   * coming. The console on an iPad gets unloaded from memory without saying
   * "off" — and a red dot hung on the slide until the end of the lecture,
   * pointing where the presenter had been a minute ago. It has to be turned
   * off on the presenter's behalf; but only when they have no socket left: a
   * second tab leaving must not turn off the dot the first one holds.
   */
  const { id, host } = room()
  const seat = socket()
  const pult = socket()
  const laptop = socket()
  handleControlSocket(seat.ws, id, { sessionId: id, participantId: 'p_guest', role: 'participant' })
  handleControlSocket(pult.ws, id, host)
  handleControlSocket(laptop.ws, id, host)
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  laptop.ws.close()
  assert.deepEqual(
    seat.heard.filter((frame) => frame.t === 'laser'),
    [],
    "the presenter's second tab turned off the first tab's pointer",
  )

  pult.ws.close()
  assert.deepEqual(
    seat.heard.filter((frame) => frame.t === 'laser'),
    [{ t: 'laser', at: null }],
  )

  stopLecture(id)
  closeControlRoom(id)
})

test('the lecture ended, and the pointer goes out with it', () => {
  // The audience is told this in words rather than inferring it from
  // `lecture: null`: the reader notebook is not the only thing that draws the
  // pointer, and nobody should have to guess about it.
  const { id, host } = room()
  const seat = socket()
  handleControlSocket(seat.ws, id, host)
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  dispatch(seat.ws, id, host, { t: 'lecture:stop' })
  assert.deepEqual(
    seat.heard.filter((frame) => frame.t === 'laser'),
    [{ t: 'laser', at: null }],
  )

  closeControlRoom(id)
})

/* -------------------------------------------------------------- cleanup */

test('deleting a class takes the board and the ink with it, even if nobody is in the room', () => {
  /*
   * `rooms` is cleared as soon as the last socket leaves, while the board and
   * the lecture deliberately outlive people leaving. A teacher closed the
   * laptop without pressing "Finish" and deleted the class in the evening —
   * and two hundred inked pages sat in process memory until a restart.
   */
  const { id, host, ws } = room()
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  say(ws, id, host, { t: 'board:open', name: 'l3.pdf' })
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  addInk(id, { id: 's1', page: 1, color: '#d4162f', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] })
  assert.equal(boardOf(id), 'l3.pdf')

  closeControlRoom(id)

  assert.equal(boardOf(id), null)
  assert.equal(lectureOf(id), null)
  assert.deepEqual(inkOf(id), [])
})
