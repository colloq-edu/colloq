/**
 * Консилиум на сервере: замок в третьем положении, попытки, стопка, лист.
 *
 * Три правила дизайна, каждое — утверждением: у каждого свой лист (чужую
 * попытку студент не видит никогда, стопку — только преподаватель); запускает
 * тот, кто ведёт (студенту — только по ручке, с номером в очереди); класс видит
 * то, что показал преподаватель (текст ложится в общую ячейку его рукой).
 *
 * Ни сети, ни ядра: сокеты поддельные, комната настоящая, диспетчер тот же, что
 * слушает провод. Попытки идут через настоящую SQLite во временной папке — на
 * этом держится проверка «переживают перезапуск».
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setFinished, setRules, upsertParticipant } from '../server/src/db.js'
import {
  closeControlRoom,
  dispatch,
  flushCouncilBoards,
  handleControlSocket,
  purgeCouncilOf,
} from '../server/src/control.js'
import { attemptsOf, oracleOf, resetCouncilCache, setOracle } from '../server/src/council.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import {
  cellId,
  cellLock,
  cellSource,
  councilSettingsOf,
  createCell,
  findCell,
  getCells,
} from '../shared/notebook.js'
import { LECTURE_ROOM } from '../shared/rules.js'
import { groupAttempts } from '../web/src/lib/council-board.js'
import type {
  ControlClientMessage,
  ControlServerMessage,
  CouncilBoard,
  CouncilMine,
  CouncilOracle,
} from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

interface Fake {
  ws: WebSocket
  heard: ControlServerMessage[]
}

/** Ровно то, что читают `send` и `handleControlSocket`: состояние, приём, подписки. */
function socket(): Fake {
  const heard: ControlServerMessage[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      if (typeof frame === 'string') heard.push(JSON.parse(frame) as ControlServerMessage)
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

interface Room {
  id: string
  cell: string
  teacher: Person
  petya: Person
  masha: Person
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

/** Лекционная комната с одной ячейкой и тремя людьми, все на проводе. */
function room(): Room {
  const id = `council-${++rooms}`
  createSession(id, 'Консилиум', null)
  setRules(id, { ...LECTURE_ROOM })
  const { doc } = getSessionDoc(id)
  const made = createCell('code', '# задание: посчитайте x')
  doc.transact(() => getCells(doc).push([made]))
  return {
    id,
    cell: cellId(made),
    // Идентификаторы — с именем комнаты: строка участника одна на инстанс
    // (participants.id — ключ), и «Петя» из соседнего теста иначе остался бы
    // прописан в прошлой комнате, а здесь читался бы «Someone».
    teacher: join(id, `${id}_teacher`, 'Ада', 'host'),
    petya: join(id, `${id}_petya`, 'Петя', 'participant'),
    masha: join(id, `${id}_masha`, 'Маша', 'participant'),
  }
}

/** Что сервер ответил ошибкой на это сообщение; `null` — не ответил ничего. */
function say(at: Room, who: Person, message: ControlClientMessage): string | null {
  const before = who.sock.heard.length
  dispatch(who.sock.ws, at.id, who.payload, message)
  const fresh = who.sock.heard.slice(before)
  const error = fresh.find((m) => m.t === 'error')
  return error && error.t === 'error' ? error.message : null
}

function lastBoard(who: Person, cell: string): CouncilBoard | null {
  for (let i = who.sock.heard.length - 1; i >= 0; i--) {
    const m = who.sock.heard[i]
    if (m.t === 'council:board' && m.cellId === cell) return m.board
  }
  return null
}

function lastMine(who: Person, cell: string): CouncilMine | null {
  for (let i = who.sock.heard.length - 1; i >= 0; i--) {
    const m = who.sock.heard[i]
    if (m.t === 'council:mine' && m.cellId === cell) return m.state
  }
  return null
}

function lastCount(who: Person, cell: string): { submitted: number; total: number } | null {
  for (let i = who.sock.heard.length - 1; i >= 0; i--) {
    const m = who.sock.heard[i]
    if (m.t === 'council:count' && m.cellId === cell) {
      return { submitted: m.submitted, total: m.total }
    }
  }
  return null
}

function lockOf(at: Room): string {
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  return found ? cellLock(found.cell) : 'нет такой'
}

/**
 * Стопка после всех отложенных кадров, как её видит пульт: последняя полная и
 * дельты поверх неё (тем же слиянием, что у клиента — council.svelte.ts ·
 * withPatch, здесь руками: компилятора Svelte в тесте нет). Тест не ждёт окна склейки.
 */
function board(at: Room): CouncilBoard {
  flushCouncilBoards(at.id)
  const heard = at.teacher.sock.heard
  let start = -1
  for (let i = heard.length - 1; i >= 0; i--) {
    const m = heard[i]
    if (m.t === 'council:board' && m.cellId === at.cell) {
      start = i
      break
    }
  }
  assert.ok(start >= 0, 'хосту не приехала стопка')
  const full = heard[start] as Extract<ControlServerMessage, { t: 'council:board' }>
  let got = full.board
  for (const m of heard.slice(start + 1)) {
    if (m.t !== 'council:patch' || m.cellId !== at.cell) continue
    const fresh = new Map(m.attempts.map((a) => [a.participantId, a]))
    const attempts = got.attempts
      .filter((a) => !m.removed.includes(a.participantId))
      .map((a) => fresh.get(a.participantId) ?? a)
    for (const a of m.attempts)
      if (!attempts.some((x) => x.participantId === a.participantId)) attempts.push(a)
    // Группы дельта не везёт — их пульт считает сам по полному списку.
    got = {
      ...got,
      attempts,
      groups: groupAttempts(attempts, got.oracle?.groupLabels ?? {}),
      counts: m.counts,
      lock: m.lock,
      settings: m.settings,
    }
  }
  return got
}

/** Сколько кадров стопки каждого вида уехало хосту по ячейке. */
function frames(at: Room): { full: number; patch: number } {
  flushCouncilBoards(at.id)
  let full = 0
  let patch = 0
  for (const m of at.teacher.sock.heard) {
    if (m.t === 'council:board' && m.cellId === at.cell) full++
    if (m.t === 'council:patch' && m.cellId === at.cell) patch++
  }
  return { full, patch }
}

function council(at: Room, settings?: { studentRun?: boolean }): void {
  assert.equal(
    say(at, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council', settings }),
    null,
  )
}

/* ---------------------------------------------------------------- замок */

test('в консилиум ячейку ставит преподаватель — и комната узнаёт об этом проводом', () => {
  const at = room()
  assert.match(
    say(at, at.petya, { t: 'cell:lock', cellId: at.cell, state: 'council' }) ?? '',
    /преподавател/i,
  )
  assert.equal(lockOf(at), 'closed', 'участник открыл консилиум сам себе')

  council(at)
  assert.equal(lockOf(at), 'council')
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  assert.deepEqual(councilSettingsOf(found!.cell), { studentRun: false, namesOnProjector: true })

  // Хосту — стопка, каждому — свой пустой лист, комнате — счётчик.
  assert.equal(board(at).lock, 'council')
  assert.deepEqual(lastMine(at.petya, at.cell)?.closed, false)
  assert.deepEqual(lastMine(at.masha, at.cell)?.closed, false)
  assert.deepEqual(lastCount(at.masha, at.cell), { submitted: 0, total: 0 })

  // `cell:open` остался частным случаем на два положения — и читается тем же кодом.
  assert.equal(say(at, at.teacher, { t: 'cell:open', cellId: at.cell, open: true }), null)
  assert.equal(lockOf(at), 'open')
  closeControlRoom(at.id)
})

/* ------------------------------------------------------------ свой лист */

test('снимок уезжает хосту стопкой и автору листом — и никому больше', () => {
  const at = room()
  council(at)
  assert.equal(
    say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1  # ответ' }),
    null,
  )

  const stack = board(at)
  assert.equal(stack.counts.attempts, 1)
  assert.equal(stack.counts.writing, 1)
  assert.equal(stack.attempts[0].text, 'x = 1  # ответ')
  assert.equal(stack.attempts[0].name, 'Петя')
  assert.equal(stack.attempts[0].groupKey, 'x=1', 'ключ группы ставит сервер нормализацией')
  assert.equal(stack.groups.length, 0, 'пишущий попал в группы — там только сданные')

  assert.equal(lastMine(at.petya, at.cell)?.text, 'x = 1  # ответ')
  assert.deepEqual(lastCount(at.masha, at.cell), { submitted: 0, total: 1 })

  // Маша — участник: ни стопки, ни чужого листа. Никогда.
  assert.equal(
    at.masha.sock.heard.some((m) => m.t === 'council:board'),
    false,
    'стопка уехала участнику',
  )
  assert.equal(
    at.masha.sock.heard.some((m) => m.t === 'council:mine' && m.state.text.length > 0),
    false,
    'чужая попытка уехала участнику',
  )
  closeControlRoom(at.id)
})

test('сдать и изменить: группы считаются только по сданным', () => {
  const at = room()
  council(at)
  assert.match(
    say(at, at.petya, { t: 'council:submit', cellId: at.cell }) ?? '',
    /нечего/i,
    'сдали пустое место',
  )
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x=1 # тоже' })
  assert.equal(say(at, at.petya, { t: 'council:submit', cellId: at.cell }), null)
  assert.equal(say(at, at.masha, { t: 'council:submit', cellId: at.cell }), null)

  assert.equal(typeof lastMine(at.petya, at.cell)?.submittedAt, 'number')
  const stack = board(at)
  assert.equal(stack.counts.submitted, 2)
  assert.equal(stack.groups.length, 1, 'одинаковые после нормализации — одна группа')
  assert.equal(stack.groups[0].count, 2)
  // Сдали в одну миллисекунду — «самый ранний» решает разрыв по времени
  // набора и id; важно, что он один из двух и один и тот же от кадра к кадру.
  assert.ok(
    stack.groups[0].members.includes(stack.groups[0].representative),
    'представитель — из группы',
  )
  assert.equal(stack.groups[0].representative, board(at).groups[0].representative)
  assert.deepEqual(lastCount(at.masha, at.cell), { submitted: 2, total: 2 })

  assert.equal(say(at, at.petya, { t: 'council:withdraw', cellId: at.cell }), null)
  assert.equal(lastMine(at.petya, at.cell)?.submittedAt, null)
  assert.equal(board(at).groups[0].count, 1)
  closeControlRoom(at.id)
})

/* -------------------------------------------------------- действия ведущего */

test('«показать классу» кладёт текст в общую ячейку рукой преподавателя', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })

  assert.match(
    say(at, at.masha, {
      t: 'council:show',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
    }) ?? '',
    /преподавател/i,
  )
  assert.equal(
    say(at, at.teacher, {
      t: 'council:show',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
    }),
    null,
  )
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  assert.equal(cellSource(found!.cell).toString(), 'x = 42')
  assert.equal(lastMine(at.petya, at.cell)?.shown, true)
  assert.equal(board(at).attempts[0].shown, true)

  // Общий текст в консилиуме по-прежнему закрыт: показанное правит преподаватель.
  assert.equal(lockOf(at), 'council')
  closeControlRoom(at.id)
})

test('«на экране» и «верно» приклеены к тексту: сменился текст — сняты, ответ остался', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  const petya = at.petya.payload.participantId
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: petya })
  say(at, at.teacher, { t: 'council:mark', cellId: at.cell, participantId: petya, correct: true })
  say(at, at.teacher, {
    t: 'council:reply',
    cellId: at.cell,
    to: { participantId: petya },
    text: 'Хорошо',
  })
  assert.equal(lastMine(at.petya, at.cell)?.shown, true)
  assert.equal(lastMine(at.petya, at.cell)?.correct, true)

  // «Изменить» и эхо того же текста ничего не снимают: текст тот же.
  say(at, at.petya, { t: 'council:withdraw', cellId: at.cell })
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  assert.equal(lastMine(at.petya, at.cell)?.shown, true)
  assert.equal(lastMine(at.petya, at.cell)?.correct, true)

  // Другой текст — в общей ячейке его нет и никто его не проверял.
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 43' })
  const mine = lastMine(at.petya, at.cell)
  assert.equal(mine?.shown, false, '«На экране» над текстом, которого на экране нет')
  assert.equal(mine?.correct, null, '«верно» над непроверенным кодом')
  assert.equal(mine?.reply?.text, 'Хорошо', 'ответ — письмо человеку, он остаётся')
  const card = board(at).attempts.find((a) => a.participantId === petya)
  assert.equal(card?.shown, false)
  assert.equal(card?.status, 'unrun')
  closeControlRoom(at.id)
})

test('состояние группы — по всем членам: отметка на карточке не представителя красит группу', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x = 1  # тоже' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.masha, { t: 'council:submit', cellId: at.cell })
  // Сдали в одну миллисекунду — кто представитель, решает разрыв по id; отметка
  // ставится тому, кто им НЕ стал.
  const [before] = board(at).groups
  const other = before.members.find((id) => id !== before.representative)!
  say(at, at.teacher, { t: 'council:mark', cellId: at.cell, participantId: other, correct: true })
  say(at, at.teacher, { t: 'council:show', cellId: at.cell, participantId: other })
  const [group] = board(at).groups
  assert.equal(group.representative, before.representative)
  assert.equal(group.status, 'correct')
  assert.equal(group.shown, true)
  closeControlRoom(at.id)
})

test('ответ доходит автору и группе с подписью преподавателя', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.masha, { t: 'council:submit', cellId: at.cell })

  assert.equal(
    say(at, at.teacher, {
      t: 'council:reply',
      cellId: at.cell,
      to: { participantId: at.petya.payload.participantId },
      text: 'Проверьте знак',
    }),
    null,
  )
  assert.equal(lastMine(at.petya, at.cell)?.reply?.text, 'Проверьте знак')
  assert.equal(lastMine(at.petya, at.cell)?.reply?.by, 'Ада')
  assert.equal(lastMine(at.masha, at.cell)?.reply, null, 'ответ одному уехал соседу')

  assert.equal(
    say(at, at.teacher, {
      t: 'council:reply',
      cellId: at.cell,
      to: { groupKey: 'x=1' },
      text: 'Всем: так и надо',
    }),
    null,
  )
  assert.equal(lastMine(at.masha, at.cell)?.reply?.text, 'Всем: так и надо')
  assert.equal(lastMine(at.masha, at.cell)?.reply?.to, 'group')
  /*
   * У Пети письмо было личным — и групповое его не стирает: письма лежат рядом,
   * каждое в своём месте.
   *
   * Здесь стояло «у Пети теперь только групповой ответ», то есть тест закреплял
   * потерю: преподаватель ответил человеку лично, через минуту отправил группе
   * черновик оракула — и личная строка исчезала, прочитал он её или нет.
   * Вернуть её нечем: у попыток истории версий нет.
   */
  assert.deepEqual(
    lastMine(at.petya, at.cell)?.replies?.map((one) => [one.to, one.text]),
    [
      ['person', 'Проверьте знак'],
      ['group', 'Всем: так и надо'],
    ],
  )
  // И старому клиенту, который читает одно поле, едут оба письма склейкой.
  assert.equal(lastMine(at.petya, at.cell)?.reply?.text, 'Проверьте знак\n\nВсем: так и надо')

  /*
   * Второе групповое письмо переписывает рассылку — и только её.
   *
   * Поправка вслед рассылке — дело обычное, и раньше она уносила с собой
   * личный ответ: письмо было одно на попытку, а склейка ложилась в то же поле
   * и стиралась следующим же групповым. Теперь у Пети остаётся «Проверьте
   * знак», у Маши — только рассылка.
   */
  assert.equal(
    say(at, at.teacher, {
      t: 'council:reply',
      cellId: at.cell,
      to: { groupKey: 'x=1' },
      text: 'Всем: поправка',
    }),
    null,
  )
  assert.deepEqual(
    lastMine(at.petya, at.cell)?.replies?.map((one) => one.text),
    ['Проверьте знак', 'Всем: поправка'],
  )
  assert.equal(lastMine(at.petya, at.cell)?.reply?.text, 'Проверьте знак\n\nВсем: поправка')
  assert.deepEqual(
    lastMine(at.masha, at.cell)?.replies?.map((one) => one.text),
    ['Всем: поправка'],
  )
  assert.equal(lastMine(at.masha, at.cell)?.reply?.text, 'Всем: поправка')

  // Личное письмо переписывает личное — рассылка остаётся на месте: две
  // ячейки, и в каждой не больше одного письма.
  assert.equal(
    say(at, at.teacher, {
      t: 'council:reply',
      cellId: at.cell,
      to: { participantId: at.petya.payload.participantId },
      text: 'И ещё: назовите переменную',
    }),
    null,
  )
  assert.deepEqual(
    lastMine(at.petya, at.cell)?.replies?.map((one) => one.text),
    ['Всем: поправка', 'И ещё: назовите переменную'],
  )

  assert.equal(
    say(at, at.teacher, {
      t: 'council:mark',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
      correct: true,
    }),
    null,
  )
  assert.equal(lastMine(at.petya, at.cell)?.correct, true)
  assert.equal(
    board(at).attempts.find((a) => a.participantId === at.petya.payload.participantId)?.status,
    'correct',
  )
  closeControlRoom(at.id)
})

/* ---------------------------------------------------------------- запуск */

test('запуск: студенту закрыт по умолчанию, ручка открывает, очередь считает', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'print(1)' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'print(2)' })

  assert.match(
    say(at, at.petya, { t: 'council:run', cellId: at.cell }) ?? '',
    /преподавател/i,
    'студент запустил при выключенной ручке',
  )
  assert.match(
    say(at, at.petya, {
      t: 'council:run',
      cellId: at.cell,
      participantId: at.masha.payload.participantId,
    }) ?? '',
    /преподавател/i,
    'студент запустил чужую попытку',
  )

  council(at, { studentRun: true })
  assert.equal(board(at).settings.studentRun, true)
  assert.equal(say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.equal(say(at, at.masha, { t: 'council:run', cellId: at.cell }), null)
  assert.equal(lastMine(at.petya, at.cell)?.run?.state, 'queued')
  assert.equal(lastMine(at.petya, at.cell)?.run?.by, 'author')
  assert.equal(lastMine(at.masha, at.cell)?.queue, 2, 'второй в очереди не узнал своего номера')
  assert.match(
    say(at, at.masha, { t: 'council:run', cellId: at.cell }) ?? '',
    /уже в очереди/i,
    'одна попытка встала в очередь дважды',
  )
  // Вывод — к попытке, не в общую ячейку: та в покое.
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  assert.equal(found!.cell.get('state') ?? 'idle', 'idle')
  closeControlRoom(at.id)
})

/* ------------------------------------------------------------ бан и база */

test('бан вычищает попытки, и стопка без него уезжает хосту', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'спам' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  assert.equal(board(at).counts.attempts, 2)

  assert.equal(purgeCouncilOf(at.id, at.petya.payload.participantId), 1)
  assert.deepEqual(
    attemptsOf(at.id, at.cell).map((a) => a.participantId),
    [at.masha.payload.participantId],
  )
  assert.deepEqual(
    board(at).attempts.map((a) => a.participantId),
    [at.masha.payload.participantId],
  )
  assert.deepEqual(lastCount(at.masha, at.cell), { submitted: 0, total: 1 })
  closeControlRoom(at.id)
})

test('перемены едут дельтой, а не всей стопкой; бан — в removed', () => {
  const at = room()
  council(at)
  const before = frames(at)
  assert.equal(before.full, 1, 'замок — одна полная стопка')
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'x = 2' })
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 11' })
  const after = frames(at)
  assert.equal(after.full, before.full, 'снимок увёз хосту всю стопку')
  assert.ok(after.patch > 0, 'снимок не уехал дельтой')
  const last = [...at.teacher.sock.heard]
    .reverse()
    .find((m) => m.t === 'council:patch' && m.cellId === at.cell)
  assert.ok(last && last.t === 'council:patch')
  assert.deepEqual(
    last.attempts.map((a) => a.participantId).sort(),
    [at.masha.payload.participantId, at.petya.payload.participantId].sort(),
    'в дельте — только те, кого трогали за окно',
  )
  assert.equal(last.counts.attempts, 2)
  assert.deepEqual(
    board(at)
      .attempts.map((a) => a.text)
      .sort(),
    ['x = 11', 'x = 2'],
  )

  purgeCouncilOf(at.id, at.petya.payload.participantId)
  flushCouncilBoards(at.id)
  const gone = [...at.teacher.sock.heard]
    .reverse()
    .find((m) => m.t === 'council:patch' && m.cellId === at.cell)
  assert.ok(gone && gone.t === 'council:patch')
  assert.deepEqual(gone.removed, [at.petya.payload.participantId])
  assert.deepEqual(
    board(at).attempts.map((a) => a.text),
    ['x = 2'],
  )

  // Смена ручки — общее: снова вся стопка.
  council(at, { studentRun: true })
  assert.equal(frames(at).full, before.full + 1)
  closeControlRoom(at.id)
})

test('оракул, «читавший» в момент перезапуска, после него не читает вечно', () => {
  const at = room()
  const reading: CouncilOracle = {
    state: 'reading',
    askedAt: 5,
    basedOn: 3,
    summary: [],
    groupLabels: {},
    drafts: {},
    error: null,
  }
  setOracle(at.id, at.cell, reading)
  resetCouncilCache(at.id)
  const fresh = oracleOf(at.id, at.cell)
  assert.equal(fresh?.state, 'idle', 'спиннер до конца пары, «Стоп» ничего не останавливает')
  assert.match(fresh?.error ?? '', /перезапустился/)

  // Была сводка — она возвращается готовой, с причиной рядом.
  setOracle(at.id, at.cell, { ...reading, summary: ['а', 'б', 'в'] })
  resetCouncilCache(at.id)
  const kept = oracleOf(at.id, at.cell)
  assert.equal(kept?.state, 'ready')
  assert.deepEqual(kept?.summary, ['а', 'б', 'в'])
  assert.match(kept?.error ?? '', /перезапустился/)
  closeControlRoom(at.id)
})

test('попытки переживают перезапуск: кэш пересобирается из базы', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 7' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  const before = attemptsOf(at.id, at.cell)[0]

  resetCouncilCache(at.id)
  const after = attemptsOf(at.id, at.cell)
  assert.equal(after.length, 1)
  assert.equal(after[0].text, 'x = 7')
  assert.equal(after[0].submittedAt, before.submittedAt)

  // И новому подключению хоста стопка приезжает пачкой — из базы.
  const late = join(at.id, at.teacher.payload.participantId, 'Ада', 'host')
  assert.equal(lastBoard(late, at.cell)?.attempts[0]?.text, 'x = 7')
  closeControlRoom(at.id)
})

test('оба письма переживают перезапуск и едут в стопке', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.teacher, {
    t: 'council:reply',
    cellId: at.cell,
    to: { participantId: at.petya.payload.participantId },
    text: 'Проверьте знак',
  })
  say(at, at.teacher, {
    t: 'council:reply',
    cellId: at.cell,
    to: { groupKey: 'x=1' },
    text: 'Всем: так и надо',
  })

  // Перезапуск без процесса: кэш забыт, правда — в базе. Письмо там одно поле,
  // и список должен уехать в него целиком, а не последним письмом.
  resetCouncilCache(at.id)
  assert.deepEqual(
    attemptsOf(at.id, at.cell)[0]?.replies.map((one) => [one.to, one.text]),
    [
      ['person', 'Проверьте знак'],
      ['group', 'Всем: так и надо'],
    ],
  )

  // И на пульте у карточки — те же два письма (и склейка старому клиенту).
  const late = join(at.id, at.teacher.payload.participantId, 'Ада', 'host')
  const card = lastBoard(late, at.cell)?.attempts[0]
  assert.deepEqual(card?.replies?.map((one) => one.text), ['Проверьте знак', 'Всем: так и надо'])
  assert.equal(card?.reply?.text, 'Проверьте знак\n\nВсем: так и надо')
  closeControlRoom(at.id)
})

/* --------------------------------------------------------- закрытие и звонок */

test('закрытие консилиума: лист с closed, попытки остаются, снимок — отказ', () => {
  const at = room()
  council(at)
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' })
  assert.equal(say(at, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'closed' }), null)
  assert.equal(lockOf(at), 'closed')

  assert.equal(lastMine(at.petya, at.cell)?.closed, true)
  assert.equal(lastMine(at.petya, at.cell)?.text, 'x = 1', 'текст пропал у автора')
  assert.equal(attemptsOf(at.id, at.cell).length, 1, 'закрытие стёрло попытки')
  assert.equal(board(at).lock, 'closed')

  assert.match(
    say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 2' }) ?? '',
    /Консилиум закрыт/,
  )
  closeControlRoom(at.id)
})

test('после звонка попытки не принимаются, а замок не ставится', () => {
  const at = room()
  council(at)
  setFinished(at.id, Date.now())
  assert.match(
    say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 1' }) ?? '',
    /Занятие закончено/,
  )
  assert.match(
    say(at, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'closed' }) ?? '',
    /Занятие закончено/,
  )
  // А просмотр стопки у преподавателя остаётся — сданное разбирают после пары.
  assert.equal(board(at).lock, 'council')
  closeControlRoom(at.id)
})

/* -------------------------------------------------------------- задание */

test('опоздавший сеется заданием, а не решением, которое показали классу', () => {
  const at = room()
  // Тот самый текст, что лежит в ячейке к моменту открытия консилиума.
  const task = '# задание: посчитайте x'
  council(at)

  // Петя сдал, преподаватель показал: общий текст ячейки — уже чужое решение.
  say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'x = 42' })
  say(at, at.petya, { t: 'council:submit', cellId: at.cell })
  say(at, at.teacher, {
    t: 'council:show',
    cellId: at.cell,
    participantId: at.petya.payload.participantId,
  })
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  assert.ok(found)
  assert.equal(cellSource(found.cell).toString(), 'x = 42', 'показ переписал общий текст')

  /*
   * Клава заходит по ссылке уже после показа. Раньше её лист сеялся общим
   * текстом — то есть решением Пети, — и одно нажатие «Сдать» отправляло её в
   * его группу. Теперь в приветственной пачке едет задание.
   */
  const late = join(at.id, `${at.id}_late`, 'Клава', 'participant')
  const mine = lastMine(late, at.cell)
  assert.equal(mine?.text, '', 'попытки у неё ещё нет')
  assert.equal(mine?.seed, task)

  // И тому, у кого попытка уже есть: лист мог не завестись, а страницу
  // перезагружают посреди пары.
  assert.equal(lastMine(at.petya, at.cell)?.seed, task)
  closeControlRoom(at.id)
})
