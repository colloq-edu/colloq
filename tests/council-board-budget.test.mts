/**
 * Что едет пульту в стопке консилиума — и чего в ней больше нет.
 *
 * Три вещи, каждая ценой в мегабайты на паре из пятисот человек. Полная стопка
 * везла вывод КАЖДОЙ попытки — до 64 КБ текста и до 2 МБ картинок на карточку,
 * — и уходила она на каждый щелчок ручки, на каждое переподключение пульта и
 * дважды на каждый вопрос оракула. Теперь у кадра бюджет вывода, вывод одной
 * карточки просят отдельно (`council:attempt`), а оракул едет своим кадром и
 * стопку за собой не тащит.
 *
 * И четвёртое, не про размер: номер в очереди. Он считает и обычные ячейки
 * впереди, а пересылался только на конце чужой ПОПЫТКИ — то есть Run All
 * преподавателя двигал студента с шестого места на первое молча.
 *
 * Ни сети, ни ядра: сокеты поддельные, комната настоящая, диспетчер тот же, что
 * слушает провод.
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
      // Строкой или байтами: кадры, которые сервер собирает раз на комнату
      // (рассылка, дерево, чернила), уходят уже закодированными — см.
      // control.ts · sendFrame. Настоящий сокет тут разницы не делает.
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
  /** Ячейка консилиума. */
  cell: string
  /** Обычная ячейка — ею забивается очередь впереди. */
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
  assert.fail('хосту не приехала стопка')
}

function boards(at: Room): number {
  flushCouncilBoards(at.id)
  return at.teacher.sock.heard.filter((m) => m.t === 'council:board' && m.cellId === at.cell).length
}

/** Картинка на N знаков base64 — ровно то, чем весит карточка с графиком. */
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

/** Сколько знаков вывода в этой карточке. */
function weight(attempt: CouncilAttempt): number {
  let total = 0
  for (const output of attempt.run?.outputs ?? []) {
    if (output.kind === 'data') for (const value of Object.values(output.data)) total += value.length
  }
  return total
}

/* -------------------------------------------------------------- бюджет */

test('стопка не везёт мегабайты вывода — и отдаёт их по одной карточке', () => {
  const at = room(5)
  assert.equal(say(at, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council' }), null)

  // Пятеро сдали, и все пятеро прогнаны с графиком по мегабайту — потолок
  // картинки у попытки как раз два (kernel/council.ts).
  for (const [i, student] of at.class.entries()) {
    assert.equal(say(at, student, { t: 'council:draft', cellId: at.cell, text: `x = ${i}` }), null)
    assert.equal(say(at, student, { t: 'council:submit', cellId: at.cell }), null)
    // Первый кадр — «в очереди»: он и есть заявка на запуск под этим текстом,
    // без неё вывод считается опоздавшим (council.ts · recordRun).
    recordRun(at.id, at.cell, student.payload.participantId, { ...ran(0), state: 'queued' })
    assert.equal(
      recordRun(at.id, at.cell, student.payload.participantId, ran(1024 * 1024)),
      true,
      'вывод не записался к попытке',
    )
  }

  // Общее сменилось (ручка) — едет вся стопка.
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
  assert.ok(total <= 4 * 1024 * 1024, `стопка увезла ${total} знаков вывода — бюджет не соблюдён`)
  const omitted = board.attempts.filter((a) => a.run?.outputsOmitted === true)
  assert.equal(omitted.length, 1, 'из пяти карточек по мегабайту должна не поместиться одна')
  assert.deepEqual(omitted[0].run?.outputs, [], 'признак есть, а вывод всё равно поехал')
  // Остальные — как были: бюджет режет хвост, а не весь кадр.
  assert.equal(board.attempts.filter((a) => weight(a) === 1024 * 1024).length, 4)

  // И это ТОЛЬКО про кадр: у попытки в базе вывод на месте, и автор его видит.
  const stored = attemptsOf(at.id, at.cell).find(
    (a) => a.participantId === omitted[0].participantId,
  )
  assert.equal(weight({ run: stored?.run ?? null } as CouncilAttempt), 1024 * 1024)
  const mine = [...at.class[4].sock.heard]
    .reverse()
    .find((m) => m.t === 'council:mine' && m.cellId === at.cell)
  assert.ok(mine && mine.t === 'council:mine')
  assert.notEqual(mine.state.run?.outputsOmitted, true, 'своему листу вывод обрезали')

  // Вторая половина сделки: «покажи вот эту» — с выводом целиком.
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
  assert.ok(patch && patch.t === 'council:patch', 'попытка по запросу не приехала')
  assert.equal(patch.attempts.length, 1)
  assert.equal(patch.attempts[0].participantId, omitted[0].participantId)
  assert.equal(weight(patch.attempts[0]), 1024 * 1024, 'по запросу приехала та же обрезка')
  assert.notEqual(patch.attempts[0].run?.outputsOmitted, true)

  // Чужую попытку по запросу получает только ведущий.
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

/* -------------------------------------------------------------- оракул */

test('ответ оракула не тащит за собой всю стопку', async () => {
  const at = room(1)
  assert.equal(say(at, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council' }), null)
  assert.equal(say(at, at.class[0], { t: 'council:draft', cellId: at.cell, text: 'x = 1' }), null)
  assert.equal(say(at, at.class[0], { t: 'council:submit', cellId: at.cell }), null)
  const was = boards(at)

  /*
   * Настоящий путь оракула: `askCouncilOracle` объявляет «читаю» сразу, а
   * ответ (здесь — отказ, шлюза в тестах нет) приезжает следом. Оба объявления
   * идут через слушателя control.ts — того самого, что раньше слал за каждым
   * ещё и полную стопку.
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
  })
  // Ответу дать доехать: он приходит отдельным кадром, и стопки за ним тоже
  // быть не должно.
  await sleep(200)

  const oracles = at.teacher.sock.heard.filter((m) => m.t === 'council:oracle')
  assert.ok(oracles.length >= 1, 'пульт не узнал, что оракул читает')
  assert.equal(boards(at), was, 'за кадром оракула снова уехала вся стопка')
  closeControlRoom(at.id)
})

/* ------------------------------------------------------------- очередь */

test('«вы 2-й» становится «вы 1-й», когда впереди снялась обычная ячейка', async () => {
  /*
   * Очередь одна на ячейки и попытки, и номер студенту считает ячейки впереди.
   * Пересылался он только на конце ЧУЖОЙ ПОПЫТКИ — то есть пять ячеек Run All
   * преподавателя, досчитавшись, двигали студента молча.
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
  // Ячейка преподавателя встала в очередь первой, попытка — за ней.
  assert.equal(say(at, at.teacher, { t: 'run', cellId: at.plain }), null)
  assert.equal(say(at, student, { t: 'council:run', cellId: at.cell }), null)

  /*
   * Номер — тем же способом, что и вкладка: лист (`council:mine`) привозит его
   * на момент отправки, а дальше двигает очередь комнаты (`council:queue`),
   * одним кадром на всех. Свой номер в ней каждый читает сам
   * (web/src/lib/council-queue.ts).
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
    return seen ? (mine[at.cell]?.queue ?? null) : 'кадра нет'
  }
  assert.equal(queue(), 2, 'номер за ячейкой преподавателя посчитан неверно')

  // Ячейку сняли с очереди — впереди никого. Ни одного события консилиума при
  // этом не произошло.
  assert.equal(say(at, at.teacher, { t: 'cancel', cellId: at.plain }), null)
  await sleep(400)
  assert.equal(queue(), 1, 'номер в очереди не сдвинулся')
  closeControlRoom(at.id)
})
