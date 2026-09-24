/**
 * The council task: what the server seeds an empty sheet with.
 *
 * A student's sheet used to be seeded with the cell's shared text "as of the
 * moment the sheet opened", and that drifted away from the task every time
 * the shared text changed after opening: a latecomer (or someone who simply
 * reloaded the page) got in their sheet not the task but whatever lies in
 * the cell now. It used to be the show itself that did this — "Show to the
 * class" rewrote the cell with someone else's solution — now showing does
 * not touch the text at all (protocol · CouncilShown), while the teacher is
 * still entitled to edit the stub in the middle of a council: the cell is
 * theirs.
 *
 * So the cell's text is captured once, at the very moment the lock switches
 * to council (control.ts · `cell:lock`), and travels to everyone in
 * `CouncilMine.seed`. The server half is checked here: that the snapshot is
 * taken in time, that an edit of the shared cell does not replace it, and
 * that toggling a control does not rewrite the task. The client half is
 * tests/notebook-council-seed.test.mts.
 *
 * No network, no kernel: the sockets are fake, the room is real, the
 * dispatcher is the same.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setRules, upsertParticipant } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { cellId, cellSource, createCell, findCell, getCells } from '../shared/notebook.js'
import { LECTURE_ROOM } from '../shared/rules.js'
import type { ControlClientMessage, ControlServerMessage, CouncilMine } from '../shared/protocol.js'
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
      // As a string or as bytes: frames the server builds once per room
      // (broadcast, tree, ink) go out already encoded — see control.ts ·
      // sendFrame. A real socket makes no difference here.
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

interface Person {
  payload: TokenPayload
  sock: Fake
}

const TASK = '# задание: посчитайте среднее'

let rooms = 0

function join(sessionId: string, who: string, name: string, role: 'host' | 'participant'): Person {
  upsertParticipant({ id: who, sessionId, name, avatar: null, role })
  const payload: TokenPayload = { sessionId, participantId: who, role }
  const sock = socket()
  handleControlSocket(sock.ws, sessionId, payload)
  return { payload, sock }
}

function room(): { id: string; cell: string; teacher: Person; petya: Person } {
  const id = `seed-${++rooms}`
  createSession(id, 'Консилиум', null)
  setRules(id, { ...LECTURE_ROOM })
  const { doc } = getSessionDoc(id)
  const made = createCell('code', TASK)
  doc.transact(() => getCells(doc).push([made]))
  return {
    id,
    cell: cellId(made),
    teacher: join(id, `${id}_teacher`, 'Ада', 'host'),
    petya: join(id, `${id}_petya`, 'Петя', 'participant'),
  }
}

function say(id: string, who: Person, message: ControlClientMessage): void {
  dispatch(who.sock.ws, id, who.payload, message)
}

function lastMine(who: Person, cell: string): CouncilMine | null {
  for (let i = who.sock.heard.length - 1; i >= 0; i--) {
    const m = who.sock.heard[i]
    if (m.t === 'council:mine' && m.cellId === cell) return m.state
  }
  return null
}

test('the task is captured on switching to council and travels to everyone', () => {
  const at = room()
  say(at.id, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council' })
  assert.equal(lastMine(at.petya, at.cell)?.seed, TASK)
  closeControlRoom(at.id)
})

test('showing does not touch the shared text — let alone the task', () => {
  /*
   * The very case all this was written for — only inside out: showing NO
   * LONGER puts Petya's code into the shared cell. Both ends are checked: the
   * cell's text after showing is the same, and latecomer Masha gets the task.
   */
  const at = room()
  say(at.id, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council' })
  say(at.id, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at.id, at.teacher, {
    t: 'council:show',
    cellId: at.cell,
    participantId: at.petya.payload.participantId,
  })

  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  assert.equal(cellSource(found!.cell).toString(), TASK, 'showing rewrote the shared cell')

  const masha = join(at.id, `${at.id}_masha`, 'Маша', 'participant')
  assert.equal(lastMine(masha, at.cell)?.seed, TASK, 'the latecomer got the shown solution')
  closeControlRoom(at.id)
})

test('the teacher edits the stub — the task stays what it started with', () => {
  /*
   * Nobody but the teacher can change the shared text in a council — and they
   * are entitled to: they added to the problem statement, erased a hint. A
   * latecomer's sheet is seeded with what the council started with:
   * otherwise half the class solves one problem and the one who came in last
   * another.
   */
  const at = room()
  say(at.id, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council' })
  const { doc } = getSessionDoc(at.id)
  const found = findCell(doc, at.cell)
  assert.ok(found)
  doc.transact(() => {
    const source = cellSource(found.cell)
    source.delete(0, source.length)
    source.insert(0, '# задание: и ещё посчитайте y')
  })

  const masha = join(at.id, `${at.id}_masha`, 'Маша', 'participant')
  assert.equal(lastMine(masha, at.cell)?.seed, TASK)
  closeControlRoom(at.id)
})

test('toggling a control does not rewrite the task', () => {
  /*
   * A repeated `cell:lock` into the same position is the lock menu, not a new
   * task. Rewriting the task with it would bring back the same substitution
   * by another road: after a show, the "students run" tick would wipe the
   * task.
   */
  const at = room()
  say(at.id, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council' })
  say(at.id, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at.id, at.teacher, {
    t: 'council:show',
    cellId: at.cell,
    participantId: at.petya.payload.participantId,
  })
  say(at.id, at.teacher, {
    t: 'cell:lock',
    cellId: at.cell,
    state: 'council',
    settings: { studentRun: true },
  })

  const masha = join(at.id, `${at.id}_masha`, 'Маша', 'participant')
  assert.equal(lastMine(masha, at.cell)?.seed, TASK)
  closeControlRoom(at.id)
})

test('an empty cell is an empty task, not a missing task', () => {
  /*
   * "Write it yourself" is a legitimate council, and an empty string here is
   * KNOWLEDGE: the client reads a missing field as "old server" and seeds
   * with the shared text, that is, after a show, with someone else's
   * solution.
   */
  const id = `seed-empty-${++rooms}`
  createSession(id, 'Консилиум', null)
  setRules(id, { ...LECTURE_ROOM })
  const { doc } = getSessionDoc(id)
  const made = createCell('code', '')
  doc.transact(() => getCells(doc).push([made]))
  const teacher = join(id, `${id}_teacher`, 'Ада', 'host')
  const petya = join(id, `${id}_petya`, 'Петя', 'participant')

  dispatch(teacher.sock.ws, id, teacher.payload, {
    t: 'cell:lock',
    cellId: cellId(made),
    state: 'council',
  })
  const mine = lastMine(petya, cellId(made))
  assert.equal(mine?.seed, '')
  assert.ok(mine && 'seed' in mine, 'the field must be present, not absent')
  closeControlRoom(id)
})
