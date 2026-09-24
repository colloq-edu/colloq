/**
 * Council queue positions — in one pass, and exactly those travel into the
 * sheets.
 *
 * The queue is poked twice for every kernel job, and there are as many
 * waiting in a class as there are people. `tellQueued` used to ask for the
 * position one by one — a search through the whole queue for each of its
 * members — and `mineMessage` did the same once more inside the sheet: two
 * squares for one shift. Now the positions are counted at once
 * (`kernel/index.ts · councilQueuePositions`) and handed to the sheet ready.
 *
 * What is checked is not the speed but what the speed was changed for: the
 * number in the sheet is the same one the bulk count gives, and it still
 * moves when a cell ahead is cancelled.
 *
 * No network, no kernel: the sockets are fake, the room is real, the
 * dispatcher is the same one that listens to the wire.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createSession, setRules, upsertParticipant } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { councilQueuePositions } from '../server/src/kernel/index.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { cellId, createCell, getCells } from '../shared/notebook.js'
import { LECTURE_ROOM } from '../shared/rules.js'
import { withQueuePosition } from '../web/src/lib/council-queue.js'
import type {
  ControlClientMessage,
  ControlServerMessage,
  CouncilMine,
} from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

interface Person {
  payload: TokenPayload
  heard: ControlServerMessage[]
  ws: WebSocket
}

function join(
  sessionId: string,
  participantId: string,
  name: string,
  role: 'host' | 'participant',
): Person {
  upsertParticipant({ id: participantId, sessionId, name, avatar: null, role })
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
  const ws = fake as unknown as WebSocket
  const payload: TokenPayload = { sessionId, participantId, role }
  handleControlSocket(ws, sessionId, payload)
  return { payload, heard, ws }
}

test('the number in the sheet is the one the bulk count gave, and it moves with the queue', async () => {
  const id = 'queue-bulk-1'
  createSession(id, 'Консилиум', null)
  setRules(id, { ...LECTURE_ROOM })
  const { doc } = getSessionDoc(id)
  const task = createCell('code', '# задание: посчитайте x')
  const plain = createCell('code', 'x = 1')
  doc.transact(() => getCells(doc).push([task, plain]))
  const cell = cellId(task)

  const teacher = join(id, `${id}_t`, 'Ада', 'host')
  const class_ = [0, 1, 2].map((i) => join(id, `${id}_s${i}`, `Студент ${i}`, 'participant'))

  const say = (who: Person, message: ControlClientMessage): string | null => {
    const before = who.heard.length
    dispatch(who.ws, id, who.payload, message)
    const error = who.heard.slice(before).find((m) => m.t === 'error')
    return error && error.t === 'error' ? error.message : null
  }

  assert.equal(
    say(teacher, {
      t: 'cell:lock',
      cellId: cell,
      state: 'council',
      settings: { studentRun: true },
    }),
    null,
  )

  // The teacher's cell got into the queue first — all three attempts are
  // behind it.
  assert.equal(say(teacher, { t: 'run', cellId: cellId(plain) }), null)
  for (const [i, student] of class_.entries()) {
    assert.equal(say(student, { t: 'council:draft', cellId: cell, text: `x = ${i}` }), null)
    assert.equal(say(student, { t: 'council:run', cellId: cell }), null)
  }

  /**
   * The number this person sees right now — computed the same way the tab
   * does.
   *
   * The sheet (`council:mine`) brings the number as of its sending; after
   * that the room's queue (`council:queue`) moves it, with one frame for
   * everyone: each reads their own number in it
   * (web/src/lib/council-queue.ts). The assembly here is the very same,
   * otherwise it would test a different path from the one by which the
   * number reaches the eyes.
   */
  const queue = (who: Person): number | null | 'no frame' => {
    let mine: Record<string, CouncilMine> = {}
    let seen = false
    for (const m of who.heard) {
      if (m.t === 'council:mine') {
        mine = { ...mine, [m.cellId]: m.state }
        seen = true
      } else if (m.t === 'council:queue') {
        mine = withQueuePosition(mine, m.cellId, m.at)
      }
    }
    return seen ? (mine[cell]?.queue ?? null) : 'no frame'
  }

  const bulk = (who: Person): number | undefined =>
    councilQueuePositions(id).find(
      (item) => item.cellId === cell && item.participantId === who.payload.participantId,
    )?.position

  // The bulk count sees all three in order — and the teacher's cell ahead.
  assert.deepEqual(class_.map(bulk), [2, 3, 4], 'the bulk count diverged from the queue')
  // And exactly these numbers arrived in the sheets: the sheet takes the
  // ready number instead of counting it again.
  assert.deepEqual(class_.map(queue), [2, 3, 4], 'the sheet got a different number from the one counted at once')

  // The cell was cancelled — nobody is ahead, and everyone got a NEW number,
  // although not a single council event happened.
  assert.equal(say(teacher, { t: 'cancel', cellId: cellId(plain) }), null)
  await sleep(400)
  assert.deepEqual(class_.map(bulk), [1, 2, 3])
  assert.deepEqual(
    class_.map(queue),
    [1, 2, 3],
    'after the queue shifted, the numbers in the sheets stayed old',
  )

  closeControlRoom(id)
})

test('broadcasting positions does not search the queue for every waiting person', () => {
  /*
   * The numbers above would match with a one-by-one search as well — it
   * gives the same answer, only more expensively. So the text of the
   * broadcast itself is read here: in the body of `tellQueued` there must be
   * no one-by-one `councilQueuePosition`, neither on a direct line nor inside
   * the sheet (the number goes into `mineOut` ready), and `councilQueued`,
   * which handed out the waiting without numbers, is not needed anywhere in
   * the server.
   */
  const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
  const source = fs.readFileSync(path.join(root, 'server/src/control.ts'), 'utf8')

  const from = source.indexOf('function tellQueued(')
  assert.ok(from > 0, 'tellQueued was not found in control.ts')
  const to = source.indexOf('\n}\n', from)
  const body = source.slice(from, to)

  assert.match(body, /councilQueuePositions\(sessionId\)/, 'the numbers are not counted in one pass')
  assert.doesNotMatch(
    body.replace(/councilQueuePositions/g, ''),
    /councilQueuePosition\(/,
    'the number is again searched in the queue for every waiting person',
  )
  /*
   * And the sheet is no longer built for the sake of the number at all. It
   * cost reading the attempt from the database and carried its whole text —
   * for each of five hundred waiting, on every end of any kernel job. The
   * queue travels as one frame per room.
   */
  assert.doesNotMatch(body, /mineOut\(/, 'the number is again carried in a full sheet')
  assert.match(body, /t: 'council:queue'/, 'the queue number does not go anywhere')
  assert.equal(
    /\bcouncilQueued\b/.test(source),
    false,
    'councilQueued belongs to no one — there is no reason to call it',
  )
})

/* ---------------------------------------- your number in a shared queue */

const sheet = (queue: number | null): CouncilMine => ({
  text: '',
  submittedAt: null,
  updatedAt: 0,
  shown: false,
  correct: null,
  reply: null,
  run: null,
  queue,
  closed: false,
})

test('the number lands in this cell\'s sheet — and does not touch the neighbouring ones', () => {
  const mine = { c1: sheet(null), c2: sheet(7) }
  const next = withQueuePosition(mine, 'c1', 5)
  assert.equal(next.c1.queue, 5)
  assert.equal(next.c2.queue, 7, 'the number went to the wrong cell')
})

test('null is an answer: the person is no longer in the queue', () => {
  // Their attempt has reached the kernel, and "running now" is said by
  // `run.state`, not by the place in the queue. Nobody used to say so — the
  // broadcast went only to those who stayed in the queue — and "you are 1st"
  // hung over a running attempt.
  assert.equal(withQueuePosition({ c1: sheet(1) }, 'c1', null).c1.queue, null)
})

test('a frame without changes does not wake a re-render of the stack', () => {
  /*
   * The sheets snapshot is replaced as a whole and wakes all council cards,
   * while the queue is poked four times a second: on their own cell a
   * student would re-render the editor under their own hands.
   */
  const mine = { c1: sheet(3) }
  assert.equal(withQueuePosition(mine, 'c1', 3), mine, 'the sheets snapshot was replaced without changes')
})

test('a sheet that does not exist yet is not created by a number', () => {
  // The sheet will arrive in its own frame and bring the number with it;
  // creating it here would mean showing the person an empty attempt with a
  // queue number.
  assert.deepEqual(withQueuePosition({}, 'c1', 2), {})
})
