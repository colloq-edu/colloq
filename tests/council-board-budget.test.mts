/**
 * What travels to the console in the council stack — and what no longer does.
 *
 * Three things, each costing megabytes in a class of five hundred people. The
 * full stack carried the output of EVERY attempt — up to 64 KB of text and up
 * to 2 MB of images per card — and it went out on every click of a settings
 * knob, on every reconnect of the console, and twice for every Oracle
 * question. Now the frame has an output budget, a single card's output is
 * requested separately (`council:attempt`), and the Oracle travels in its own
 * frame without dragging the stack along.
 *
 * And a fourth, not about size: the queue number. It counts ordinary cells
 * ahead as well, yet it was resent only when someone else's ATTEMPT finished —
 * that is, the teacher's Run All moved a student from sixth place to first
 * silently.
 *
 * No network, no kernel: the sockets are fake, the room is real, and the
 * dispatcher is the same one that listens to the wire.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createSession, setRules, upsertParticipant } from '../server/src/db.js'
import {
  closeControlRoom,
  dispatch,
  flushCouncilBoards,
  handleControlSocket,
} from '../server/src/control.js'
import { attemptsOf, recordRun } from '../server/src/council.js'
import { askCouncilOracle } from '../server/src/ai/council.js'
import { oracleOf, setOracle } from '../server/src/council.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { cellId, createCell, getCells } from '../shared/notebook.js'
import { LECTURE_ROOM } from '../shared/rules.js'
import { withQueuePosition } from '../web/src/lib/council-queue.js'
import type {
  ControlClientMessage,
  ControlServerMessage,
  CouncilAttempt,
  CouncilBoard,
  CouncilMine,
  CouncilRun,
} from '../shared/protocol.js'
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
      // As a string or as bytes: the frames the server builds once per room
      // (the broadcast, the tree, the ink) go out already encoded — see
      // control.ts · sendFrame. A real socket makes no difference here.
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

let rooms = 0

function join(
  sessionId: string,
  participantId: string,
  name: string,
  role: 'host' | 'participant',
): Person {
  upsertParticipant({ id: participantId, sessionId, name, avatar: null, role })
  const payload: TokenPayload = { sessionId, participantId, role }
  const sock = socket()
  handleControlSocket(sock.ws, sessionId, payload)
  return { payload, sock }
}

interface Room {
  id: string
  /** The council cell. */
  cell: string
  /** An ordinary cell, used to fill up the queue ahead. */
  plain: string
  teacher: Person
  class: Person[]
}

function room(students = 5): Room {
  const id = `budget-${++rooms}`
  createSession(id, 'Консилиум', null)
  setRules(id, { ...LECTURE_ROOM })
  const { doc } = getSessionDoc(id)
  const task = createCell('code', '# задание: посчитайте x')
  const plain = createCell('code', 'x = 1')
  doc.transact(() => getCells(doc).push([task, plain]))
  const teacher = join(id, `${id}_t`, 'Ада', 'host')
  const class_ = []
  for (let i = 0; i < students; i++) {
    class_.push(join(id, `${id}_s${i}`, `Студент ${i}`, 'participant'))
  }
  return { id, cell: cellId(task), plain: cellId(plain), teacher, class: class_ }
}

function say(at: Room, who: Person, message: ControlClientMessage): string | null {
  const before = who.sock.heard.length
  dispatch(who.sock.ws, at.id, who.payload, message)
  const error = who.sock.heard.slice(before).find((m) => m.t === 'error')
  return error && error.t === 'error' ? error.message : null
}

function lastBoard(at: Room): CouncilBoard {
  flushCouncilBoards(at.id)
  for (let i = at.teacher.sock.heard.length - 1; i >= 0; i--) {
    const m = at.teacher.sock.heard[i]
    if (m.t === 'council:board' && m.cellId === at.cell) return m.board
  }
  assert.fail('the stack never reached the host')
}

function boards(at: Room): number {
  flushCouncilBoards(at.id)
  return at.teacher.sock.heard.filter((m) => m.t === 'council:board' && m.cellId === at.cell).length
}

/** An image of N base64 chars: exactly what a card with a plot weighs. */
function ran(chars: number): CouncilRun {
  return {
    state: 'ok',
    outputs: [{ kind: 'data', data: { 'image/png': 'A'.repeat(chars) }, execCount: 1 }],
    execCount: 1,
    ranMs: 12,
    startedAt: Date.now(),
    by: 'host',
  }
}

/** How many characters of output this card holds. */
function weight(attempt: CouncilAttempt): number {
  let total = 0
  for (const output of attempt.run?.outputs ?? []) {
    if (output.kind === 'data') for (const value of Object.values(output.data)) total += value.length
  }
  return total
}

/* -------------------------------------------------------------- budget */

test('the stack does not carry megabytes of output, and hands them out one card at a time', () => {
  const at = room(5)
  assert.equal(say(at, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council' }), null)

  // Five have submitted, and all five were run with a one-megabyte plot each —
  // the image ceiling for an attempt is exactly two (kernel/council.ts).
  for (const [i, student] of at.class.entries()) {
    assert.equal(say(at, student, { t: 'council:draft', cellId: at.cell, text: `x = ${i}` }), null)
    assert.equal(say(at, student, { t: 'council:submit', cellId: at.cell }), null)
    // The first frame is "queued": it is the very request to run this text,
    // and without it the output counts as late (council.ts · recordRun).
    recordRun(at.id, at.cell, student.payload.participantId, { ...ran(0), state: 'queued' })
    assert.equal(
      recordRun(at.id, at.cell, student.payload.participantId, ran(1024 * 1024)),
      true,
      'the output was not recorded for the attempt',
    )
  }

  // A shared setting changed (a knob): the whole stack travels.
  assert.equal(
    say(at, at.teacher, {
      t: 'cell:lock',
      cellId: at.cell,
      state: 'council',
      settings: { studentRun: true },
    }),
    null,
  )
  const board = lastBoard(at)
  assert.equal(board.attempts.length, 5)

  const total = board.attempts.reduce((n, a) => n + weight(a), 0)
  assert.ok(total <= 4 * 1024 * 1024, `the stack carried ${total} characters of output: the budget was not kept`)
  const omitted = board.attempts.filter((a) => a.run?.outputsOmitted === true)
  assert.equal(omitted.length, 1, 'of five one-megabyte cards, exactly one must not fit')
  assert.deepEqual(omitted[0].run?.outputs, [], 'the flag is set, yet the output travelled anyway')
  // The rest are as they were: the budget cuts the tail, not the whole frame.
  assert.equal(board.attempts.filter((a) => weight(a) === 1024 * 1024).length, 4)

  // And this is ONLY about the frame: the attempt keeps its output in the
  // database, and its author sees it.
  const stored = attemptsOf(at.id, at.cell).find(
    (a) => a.participantId === omitted[0].participantId,
  )
  assert.equal(weight({ run: stored?.run ?? null } as CouncilAttempt), 1024 * 1024)
  const mine = [...at.class[4].sock.heard]
    .reverse()
    .find((m) => m.t === 'council:mine' && m.cellId === at.cell)
  assert.ok(mine && mine.t === 'council:mine')
  assert.notEqual(mine.state.run?.outputsOmitted, true, "the author's own sheet had its output cut")

  // The other half of the deal: "show me this one", with the full output.
  const before = at.teacher.sock.heard.length
  assert.equal(
    say(at, at.teacher, {
      t: 'council:attempt',
      cellId: at.cell,
      participantId: omitted[0].participantId,
    }),
    null,
  )
  const patch = at.teacher.sock.heard.slice(before).find((m) => m.t === 'council:patch')
  assert.ok(patch && patch.t === 'council:patch', 'the requested attempt did not arrive')
  assert.equal(patch.attempts.length, 1)
  assert.equal(patch.attempts[0].participantId, omitted[0].participantId)
  assert.equal(weight(patch.attempts[0]), 1024 * 1024, 'the request brought the same trimmed version')
  assert.notEqual(patch.attempts[0].run?.outputsOmitted, true)

  // Only the host gets someone else's attempt on request.
  assert.match(
    say(at, at.class[0], {
      t: 'council:attempt',
      cellId: at.cell,
      participantId: at.class[1].payload.participantId,
    }) ?? '',
    /Консилиум ведёт/,
  )
  closeControlRoom(at.id)
})

/* -------------------------------------------------------------- oracle */

test("the Oracle's answer does not drag the whole stack along", async () => {
  const at = room(1)
  assert.equal(say(at, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council' }), null)
  assert.equal(say(at, at.class[0], { t: 'council:draft', cellId: at.cell, text: 'x = 1' }), null)
  assert.equal(say(at, at.class[0], { t: 'council:submit', cellId: at.cell }), null)
  const was = boards(at)

  /*
   * The Oracle's real path: `askCouncilOracle` announces "reading" right away,
   * and the answer (here a refusal, since tests have no gateway) arrives after
   * it. Both announcements go through the control.ts listener — the very one
   * that used to send the full stack after each of them as well.
   */
  askCouncilOracle({
    sessionId: at.id,
    cellId: at.cell,
    task: { source: '# задание', before: null, reference: null },
    attempts: attemptsOf(at.id, at.cell).map((a) => ({
      participantId: a.participantId,
      text: a.text,
      submittedAt: a.submittedAt,
      run: a.run,
      correct: a.correct,
      updatedAt: a.updatedAt,
    })),
    store: { oracleOf, setOracle },
    question: 'Как класс?',
  })
  // Let the answer arrive: it comes as a separate frame, and no stack should
  // follow it either.
  await sleep(200)

  const oracles = at.teacher.sock.heard.filter((m) => m.t === 'council:oracle')
  assert.ok(oracles.length >= 1, 'the console was not told that the Oracle is reading')
  assert.equal(boards(at), was, "the whole stack went out after the Oracle's frame again")
  closeControlRoom(at.id)
})

/* --------------------------------------------------------------- queue */

test('"you are 2nd" becomes "you are 1st" when an ordinary cell ahead is cancelled', async () => {
  /*
   * There is one queue for cells and attempts, and a student's number counts
   * the cells ahead. It was resent only when SOMEONE ELSE'S ATTEMPT finished —
   * that is, five cells of the teacher's Run All, once done, moved the student
   * silently.
   */
  const at = room(1)
  const student = at.class[0]
  assert.equal(
    say(at, at.teacher, {
      t: 'cell:lock',
      cellId: at.cell,
      state: 'council',
      settings: { studentRun: true },
    }),
    null,
  )
  assert.equal(say(at, student, { t: 'council:draft', cellId: at.cell, text: 'print(1)' }), null)
  // The teacher's cell went into the queue first, the attempt after it.
  assert.equal(say(at, at.teacher, { t: 'run', cellId: at.plain }), null)
  assert.equal(say(at, student, { t: 'council:run', cellId: at.cell }), null)

  /*
   * The number is computed the same way the tab does it: the sheet
   * (`council:mine`) brings it as of submission, and from then on the room's
   * queue (`council:queue`) moves it, in one frame for everyone. Each reads
   * their own number from it (web/src/lib/council-queue.ts).
   */
  const queue = () => {
    let mine: Record<string, CouncilMine> = {}
    let seen = false
    for (const m of student.sock.heard) {
      if (m.t === 'council:mine') {
        mine = { ...mine, [m.cellId]: m.state }
        seen = true
      } else if (m.t === 'council:queue') {
        mine = withQueuePosition(mine, m.cellId, m.at)
      }
    }
    return seen ? (mine[at.cell]?.queue ?? null) : 'no frame'
  }
  assert.equal(queue(), 2, "the number behind the teacher's cell was computed wrong")

  // The cell was taken off the queue, so nobody is ahead. Not a single council
  // event happened meanwhile.
  assert.equal(say(at, at.teacher, { t: 'cancel', cellId: at.plain }), null)
  await sleep(400)
  assert.equal(queue(), 1, 'the queue number did not move')
  closeControlRoom(at.id)
})
