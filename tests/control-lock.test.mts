/**
 * The lock on a cell.
 *
 * A lecture is a room where the teacher types and runs code; the lock is the
 * one cell where the audience does it. Both sides of the deal are checked
 * here: that the `open` field is set by the server and only for the teacher,
 * and that an open cell opens EXACTLY itself — not the sheet, not the
 * terminal, not a finished class.
 *
 * No network, no kernel: the socket is fake, the room is real. The promise
 * that a missed check "would fail with an attempt to reach a nonexistent
 * Jupyter" is gone from here — it was untrue: `JUPYTER_URL` points at a dead
 * port, the connection refusal is swallowed, and the test stays green. Misses
 * are caught by assertions: that the refusal was sent, and that the room's
 * document did not change after it.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setFinished, setRules } from '../server/src/db.js'
import { dispatch } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import {
  cellId,
  cellLock,
  cellSource,
  createCell,
  createChatEntry,
  findCell,
  getCells,
  getChat,
  isCellOpen,
} from '../shared/notebook.js'
import { COUNCIL_ROOM, LECTURE_ROOM, OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import type { ControlClientMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Exactly what `send` reads: the state and taking in a frame. */
function socket(): { ws: WebSocket; said: string[] } {
  const said: string[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => {
      const message = JSON.parse(frame) as { t: string; message?: string }
      if (message.t === 'error') said.push(message.message ?? '')
    },
  } as unknown as WebSocket
  return { ws, said }
}

let rooms = 0

/** A room with these rules; a lecture room by default. */
function room(rules: Partial<RoomRules> = {}): string {
  const id = `lock-${++rooms}`
  createSession(id, 'Лекция', null)
  setRules(id, { ...LECTURE_ROOM, ...rules })
  return id
}

function who(role: 'host' | 'participant', sessionId: string): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/** What the server said in reply to this message; `null` if it said nothing. */
function say(
  sessionId: string,
  role: 'host' | 'participant',
  message: ControlClientMessage,
): string | null {
  const { ws, said } = socket()
  dispatch(ws, sessionId, who(role, sessionId), message)
  return said[0] ?? null
}

/** A code cell in the room's notebook, and its name. */
function cell(sessionId: string, source: string): string {
  const { doc } = getSessionDoc(sessionId)
  const made = createCell('code', source)
  doc.transact(() => getCells(doc).push([made]))
  return cellId(made)
}

function opened(sessionId: string, id: string): boolean {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return found ? isCellOpen(found.cell) : false
}

/** An Oracle proposal for this cell, and its name. */
function propose(sessionId: string, id: string, text: string): string {
  const { doc } = getSessionDoc(sessionId)
  const entry = createChatEntry({
    participantId: 'p_participant',
    name: 'Аня',
    color: '#c273e6',
    question: 'перепиши',
    cellId: id,
  })
  doc.transact(() => {
    entry.set('patch', text)
    entry.set('state', 'done')
    getChat(doc).push([entry])
  })
  return entry.get('id') as string
}

function sourceOf(sessionId: string, id: string): string {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return found ? cellSource(found.cell).toString() : 'no such cell'
}

function stateOf(sessionId: string, id: string): string {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return (found?.cell.get('state') as string) ?? 'no such cell'
}

/* ---------------------------------------------------------------- who opens */

test('the teacher opens the lock, and the audience cannot, not even for itself', () => {
  /*
   * The server writes the field, and that is the whole protection: if the
   * browser wrote it, the right would be handed out by the same hand it is
   * checked against, and "I am allowed here" would be declared by the very
   * one being asked.
   */
  const id = room()
  const c = cell(id, 'x = 1')

  assert.match(
    say(id, 'participant', { t: 'cell:open', cellId: c, open: true }) ?? '',
    /преподавател/i,
  )
  assert.equal(opened(id, c), false, 'a participant opened a cell for themselves')

  assert.equal(say(id, 'host', { t: 'cell:open', cellId: c, open: true }), null)
  assert.equal(opened(id, c), true)

  // And closes it again with the same message.
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: c, open: false }), null)
  assert.equal(opened(id, c), false)
})

test('the lock is not created for a cell that is not in the room', () => {
  // A neighbour's tab outlives the cell; it would explain silence to itself,
  // and explain it wrongly.
  const id = room()
  assert.match(say(id, 'host', { t: 'cell:open', cellId: 'c_nope', open: true }) ?? '', /ячейки/i)
})

/* ------------------------------------------------------------------- run */

test('the audience computes in an open cell, but not in the neighbouring one', () => {
  const id = room()
  const open = cell(id, 'открыто = 1')
  const shut = cell(id, 'закрыто = 1')
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: open, open: true }), null)

  // It passed, and it reached the queue: the right is checked before, not
  // instead.
  assert.equal(say(id, 'participant', { t: 'run', cellId: open }), null)
  assert.equal(stateOf(id, open), 'queued')

  assert.match(say(id, 'participant', { t: 'run', cellId: shut }) ?? '', /teacher|преподавател/i)
  assert.equal(stateOf(id, shut), 'idle', 'the closed cell got into the queue after all')
})

test('an open cell opens itself, not the sheet, not a file and not the shell', () => {
  /*
   * The lock is one cell. Run All, a script from the tree and a shell command
   * go by the `run` rule and stay the teacher's: otherwise one open cell would
   * hand the whole container to the audience.
   */
  const id = room()
  const open = cell(id, 'открыто = 1')
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: open, open: true }), null)

  assert.ok(say(id, 'participant', { t: 'runAll' }), 'the whole sheet went through for a participant')
  assert.ok(say(id, 'participant', { t: 'runAbove', cellId: open }), 'the sheet above went through')
  assert.ok(say(id, 'participant', { t: 'term:run', command: 'ls' }), 'the shell went through')
  assert.ok(say(id, 'participant', { t: 'file:run', path: 'train.py' }), 'the script went through')
})

test('whoever put something in the queue is the one who removes it', () => {
  /*
   * Cancelling goes by who queued it, not by the rule — and the lock did not
   * affect that: the person a cell was opened for queued it themselves and
   * removes it themselves. Interrupting and answering `input()` rest on the
   * same authorship (`startedTheRunningCell`), only on the running cell, which
   * cannot be reached without a kernel.
   */
  const id = room()
  const c = cell(id, 'долго = 1')
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: c, open: true }), null)
  assert.equal(say(id, 'participant', { t: 'run', cellId: c }), null)
  assert.equal(stateOf(id, c), 'queued')

  assert.equal(say(id, 'participant', { t: 'cancel', cellId: c }), null)
  assert.equal(stateOf(id, c), 'idle', "one's own cell did not come off the queue")
})

test('interrupting and answering are still about who started the run, not about the lock', () => {
  /*
   * Neither is governed by the room rule, and the refusal to someone who has
   * nothing running talks about the author. If the lock drifted apart from
   * these two, the phrase here would change to the rule.
   */
  const id = room()
  assert.match(
    say(id, 'participant', { t: 'interrupt' }) ?? '',
    /преподаватель или тот, кто запустил выполняющуюся ячейку/i,
  )
  assert.match(say(id, 'participant', { t: 'input', value: 'да' }) ?? '', /участник, запустивший ячейку/i)
})

/* ---------------------------------------------------------- after the bell */

test('after the bell an open cell neither runs nor opens', () => {
  /*
   * An open cell is a promise to the room that it may act here; after the bell
   * it may act nowhere. The lock stays in place (the class is reopened with
   * one press) but has no effect, and no new lock can be set in a finished
   * class: an empty promise is worse than a refusal — people follow it and hit
   * a wall.
   */
  const id = room()
  const c = cell(id, 'x = 1')
  const other = cell(id, 'y = 2')
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: c, open: true }), null)

  setFinished(id, Date.now())
  assert.match(say(id, 'participant', { t: 'run', cellId: c }) ?? '', /Занятие закончено/)
  assert.equal(stateOf(id, c), 'idle', 'the open cell ran after the bell')
  assert.match(
    say(id, 'host', { t: 'cell:open', cellId: other, open: true }) ?? '',
    /Занятие закончено/,
  )
  assert.equal(opened(id, other), false)

  // The class was reopened, and the lock that survived the bell works again.
  setFinished(id, null)
  assert.equal(opened(id, c), true)
  assert.equal(say(id, 'participant', { t: 'run', cellId: c }), null)
  assert.equal(stateOf(id, c), 'queued')
})

/* --------------------------------------------------------- ordinary room */

test('in an open room the lock changes nothing', () => {
  // A rule that refuses everyone is not a rule; and a lab where everyone
  // computes should know nothing about locks.
  const id = room(OPEN_ROOM)
  const c = cell(id, 'x = 1')
  assert.equal(say(id, 'participant', { t: 'run', cellId: c }), null)
  assert.equal(stateOf(id, c), 'queued')
})

/* ------------------------------------------------ Oracle proposal in a cell */

test('in an open cell the person it was opened for may accept a proposal', () => {
  /*
   * Otherwise the lock would read as a malfunction: a cell was opened for a
   * student, who types and runs in it, asks the Oracle — and cannot press
   * "accept" on a proposal made for that very cell. In a closed cell
   * everything is as before: the teacher accepts.
   */
  const id = room()
  const open = cell(id, 'x = 1')
  const shut = cell(id, 'y = 2')
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: open, open: true }), null)

  assert.equal(
    say(id, 'participant', { t: 'ai:decide', entryId: propose(id, open, 'x = 42'), accept: true }),
    null,
    'accepting in an open cell was not allowed',
  )
  assert.equal(sourceOf(id, open), 'x = 42')

  assert.match(
    say(id, 'participant', {
      t: 'ai:decide',
      entryId: propose(id, shut, 'y = 42'),
      accept: true,
    }) ?? '',
    /преподавател/i,
  )
  assert.equal(sourceOf(id, shut), 'y = 2', 'a proposal was accepted into a closed cell')
})

/* ------------------------------------------------------ council mode */

test('in a council room a click on the lock opens a sheet for each person', () => {
  /*
   * The whole difference between lecture and council as modes: the rights are
   * the same, but "open a cell" means different things. One click is
   * `cell:open`, and it must read the room rule; otherwise a teacher who chose
   * council at creation would open the shared text to five hundred people with
   * the very first press.
   */
  const id = room(COUNCIL_ROOM)
  const c = cell(id, 'x = 1')
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: c, open: true }), null)
  const found = findCell(getSessionDoc(id).doc, c)
  assert.equal(found && cellLock(found.cell), 'council')
  // The shared text stays closed: a council is not an open cell.
  assert.equal(found && isCellOpen(found.cell), false)
  // The same click closes it again.
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: c, open: false }), null)
  assert.equal(found && cellLock(found.cell), 'closed')
})

test('the lock menu does not ask the room rule: an explicit position wins', () => {
  const id = room(COUNCIL_ROOM)
  const c = cell(id, 'x = 1')
  assert.equal(say(id, 'host', { t: 'cell:lock', cellId: c, state: 'open' }), null)
  const found = findCell(getSessionDoc(id).doc, c)
  assert.equal(found && cellLock(found.cell), 'open')
  // In a lecture a click opens it for everyone, as before.
  const lecture = room(LECTURE_ROOM)
  const d = cell(lecture, 'y = 2')
  assert.equal(say(lecture, 'host', { t: 'cell:open', cellId: d, open: true }), null)
  const other = findCell(getSessionDoc(lecture).doc, d)
  assert.equal(other && cellLock(other.cell), 'open')
})
