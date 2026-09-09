import { tr } from '../shared/i18n.js'
/**
 * Занятие закончено.
 *
 * Преподаватель нажал одну кнопку, и комната осталась жива: тетрадь, файлы,
 * лента терминала и ответы оракула на месте — но участник в ней с этой минуты
 * только читает. Обещание держит сервер, и держит его в одном месте: `getRules`
 * отдаёт действующие правила, а не хранимые, так что каждая проверка прав
 * ужесточается сама. Здесь проверяется, что она ужесточается — и что открыть
 * занятие обратно значит вернуться ровно в ту настройку, из которой его
 * закончили.
 *
 * Главная ловушка проверяется отдельно и через настоящий маршрут: PATCH правил
 * накладывает присланное на ТЕКУЩЕЕ, и один переключатель, нажатый после
 * звонка, записал бы ужесточение в базу навсегда — открывать занятие было бы
 * уже не во что.
 *
 * Ни сети, ни ядра: сокет поддельный, комната настоящая.
 *
 * Здесь стояло обещание, что промах проверки «упал бы попыткой сходить в
 * несуществующий Jupyter». Это неправда: `JUPYTER_URL` смотрит в мёртвый порт,
 * отказ соединения глотается, и до утверждения дело не доходит вовсе — а у
 * преподавателя те же нажатия туда и уходят штатно. Промах ловит другое:
 * `assert.ok(said)` — то, что отказ ПРОЗВУЧАЛ, — и отдельная проверка ниже, что
 * от нажатия не осталось следа: ячейки не переставлены, вывод не стёрт, файла
 * не завелось, документ на экран не встал.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import {
  createSession,
  finishedAt,
  getRules,
  getSession,
  isFinished,
  setFinished,
  setRules,
  storedRules,
  upsertParticipant,
} from '../server/src/db.js'
import { listFiles, makeFile } from '../server/src/workspace.js'
import { boardOf, closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import {
  addInk,
  inkOf,
  lectureOf,
  startLecture,
  stopLecture,
  turnTo,
} from '../server/src/lecture.js'
import { terminalPhase } from '../server/src/kernel/terminal.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { createChatEntry, findChatEntry, getCells, getChat } from '../shared/notebook.js'
import { app } from '../server/src/app.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { signToken, type TokenPayload } from '../server/src/auth.js'
import {
  actsAfterClass,
  CLASS_IS_OVER,
  OPEN_ROOM,
  rulesAfterClass,
  type RoomRules,
} from '../shared/rules.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'

/** Комната, где решили всё в пользу студентов: строже её сделать нечем. */
const WIDE_OPEN: RoomRules = {
  ...OPEN_ROOM,
  run: 'room',
  edit: 'room',
  structure: 'room',
  board: 'room',
  files: 'room',
  wipe: 'room',
  restart: 'room',
  agent: 'room',
  history: 'room',
}

/* ------------------------------------------------------------- сами правила */

test('конец занятия закрывает семь прав и не трогает три поля', () => {
  const after = rulesAfterClass({ ...WIDE_OPEN, oracle: 'hints', model: 'gpt-4o-mini' })
  for (const field of ['run', 'edit', 'structure', 'board', 'files', 'wipe', 'restart'] as const) {
    assert.equal(after[field], 'host', `${field} остался открытым после звонка`)
  }
  assert.equal(after.agent, 'host', 'оракул продолжает править файлы по просьбе студента')
  /*
   * И три поля, которых конец занятия не касается. `history` — это чтение, а
   * ради чтения комната и остаётся открытой; `oracle` и `model` описывают не
   * право действовать, а модель и её подробность.
   */
  assert.equal(after.history, 'room', 'историю версий закрыли вместе с занятием')
  assert.equal(after.oracle, 'hints')
  assert.equal(after.model, 'gpt-4o-mini')
})

test('выключенный агент концом занятия не включается', () => {
  // `off` — свойство комнаты, а не чьё-то право: смягчать его нечему.
  assert.equal(rulesAfterClass({ ...WIDE_OPEN, agent: 'off' }).agent, 'off')
})

test('наложить конец занятия дважды — то же, что один раз', () => {
  // Клиент накладывает его сам, поверх хранимых правил; кадр, приехавший уже
  // ужесточённым, не должен давать другого ответа.
  const once = rulesAfterClass(WIDE_OPEN)
  assert.deepEqual(rulesAfterClass(once), once)
})

test('после звонка действует преподаватель, а участник смотрит', () => {
  // Для того, что правилами не выражается: спросить оракула, ответить на input().
  assert.equal(actsAfterClass(false, 'participant'), true)
  assert.equal(actsAfterClass(false, 'host'), true)
  assert.equal(actsAfterClass(true, 'host'), true)
  assert.equal(actsAfterClass(true, 'participant'), false)
})

/* ------------------------------------------------------------------- база */

test('конец занятия записывается, читается и снимается', () => {
  const id = 'class-db-flag'
  createSession(id, 'Занятие', null)
  assert.equal(isFinished(id), false)
  assert.equal(finishedAt(id), null)
  assert.equal(getSession(id)?.finishedAt, null, 'новая комната пришла законченной')

  const at = Date.now()
  setFinished(id, at)
  assert.equal(isFinished(id), true)
  assert.equal(finishedAt(id), at)
  // То же время едет в GET /api/sessions/:id и в ответ на вход.
  assert.equal(getSession(id)?.finishedAt, at, 'время не доехало до карточки комнаты')

  setFinished(id, null)
  assert.equal(isFinished(id), false)
  assert.equal(getSession(id)?.finishedAt, null)
})

test('кэш правил узнаёт про звонок сразу, а не после перезапуска сервера', () => {
  /*
   * Правила спрашиваются на каждый кадр, поэтому они в кэше. Кэш, прогретый до
   * звонка, — это и есть тот случай, когда конец занятия вступал бы в силу
   * только после перезапуска: комната на паре уже закончена, а права в ней
   * прежние.
   */
  const id = 'class-db-cache'
  createSession(id, 'Кэш', null)
  setRules(id, WIDE_OPEN)
  assert.equal(getRules(id).run, 'room')

  setFinished(id, Date.now())
  assert.equal(getRules(id).run, 'host', 'кэш отдал вчерашние права')
  assert.equal(getRules(id).edit, 'host')
  // А выбранное преподавателем лежит рядом и цело: его показывают в настройках.
  assert.equal(storedRules(id).run, 'room', 'настройка потерялась')

  // Правка правила посреди законченного занятия не должна стирать сам звонок.
  setRules(id, { ...storedRules(id), history: 'host' })
  assert.equal(isFinished(id), true, 'setRules забыл, что занятие закончено')
  assert.equal(getRules(id).run, 'host')

  setFinished(id, null)
  assert.equal(getRules(id).run, 'room', 'комната вернулась не в ту настройку')
  assert.equal(getRules(id).history, 'host', 'правка, сделанная после звонка, пропала')
})

/* ------------------------------------------------- маршруты: правила и вход */

/*
 * Двери комнаты и оракула — приложением (server/src/app.ts): звонок должен
 * закрывать их там, где они стоят на паре, а не в собранной рядом копии.
 */
let base = ''
let server: http.Server

before(async () => {
  // Оракул должен быть настроен, иначе его дверь отвечает 503 до всяких прав.
  updateOracleSettings({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:1/v1',
    questionsPerHour: 20,
  })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

/**
 * Токен того, кем сервер его и признает.
 *
 * Роль решается на каждом запросе по строке участника, а не по тому, что
 * написано в токене (routes/sessions.ts · roleFor), — поэтому преподавателя
 * приходится завести по-настоящему. Идентификатор — ключ во всей таблице, а не
 * в комнате, так что он несёт имя комнаты.
 */
function tokenFor(sessionId: string, role: 'host' | 'participant'): string {
  const participantId = `p_${sessionId}_${role}`
  upsertParticipant({
    id: participantId,
    sessionId,
    name: role === 'host' ? 'Ада' : 'Нина',
    avatar: null,
    role,
    tokenHost: role === 'host',
  })
  return signToken({ sessionId, participantId, role })
}

test('патч правил после звонка правит выбранное, а не ужесточённое', async () => {
  /*
   * Та самая ловушка. Маршрут накладывает присланное на текущее — и если
   * «текущее» будет означать действующие правила, то один переключатель,
   * нажатый после занятия, запишет `host` во все семь полей навсегда.
   */
  const id = 'class-patch'
  createSession(id, 'Правила после звонка', null)
  setRules(id, WIDE_OPEN)
  setFinished(id, Date.now())

  const res = await fetch(`${base}/api/sessions/${id}/rules`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${tokenFor(id, 'host')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ rules: { history: 'host' } }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { rules: RoomRules }
  assert.equal(body.rules.history, 'host', 'переключатель не сохранился')
  assert.equal(body.rules.run, 'room', 'ответ вернул ужесточение вместо настройки')

  // В базе — выбранное; действующее по-прежнему строгое.
  assert.equal(storedRules(id).run, 'room', 'ужесточение записалось в настройку')
  assert.equal(getRules(id).run, 'host')

  // И занятие можно открыть обратно — комната возвращается туда, откуда ушла.
  setFinished(id, null)
  assert.equal(getRules(id).run, 'room')
  assert.equal(getRules(id).edit, 'room')
  assert.equal(getRules(id).history, 'host')
})

test('карточка комнаты называет время конца занятия', async () => {
  const id = 'class-card'
  createSession(id, 'Карточка', null)
  const at = Date.now()
  setFinished(id, at)

  const res = await fetch(`${base}/api/sessions/${id}`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { finishedAt: number | null }
  assert.equal(body.finishedAt, at, 'экран входа не узнает, что занятие кончилось')
})

test('оракула в законченной комнате спрашивает преподаватель', async () => {
  /*
   * У `oracle` нет измерения «кто» — оно про подробность ответа для всей
   * комнаты, — поэтому право спрашивать закрывает не правило, а роль
   * (shared/rules.ts · actsAfterClass). Отказ приходит статусом, который панель
   * умеет объяснить, а не ошибкой в треде, которую смотрит вся комната.
   */
  const id = 'class-ai'
  createSession(id, 'Оракул после звонка', null)
  setFinished(id, Date.now())

  const denied = await askOracle(id, 'participant')
  assert.equal(denied.status, 403, 'участник спросил оракула после звонка')
  const body = (await denied.json()) as { error: string }
  assert.ok(body.error.includes(tr(CLASS_IS_OVER)), `отказ говорит не про конец занятия: ${body.error}`)

  // Преподавателю — та же дверь, что и до звонка: разбор он дописывает сам.
  assert.equal((await askOracle(id, 'host')).status, 202)
})

function askOracle(sessionId: string, role: 'host' | 'participant'): Promise<Response> {
  return fetch(`${base}/api/sessions/${sessionId}/ai/ask`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenFor(sessionId, role)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message: 'почему тут падает?' }),
  })
}

/* ----------------------------------------------------- управляющий сокет */

/** Ровно то, что читает `send`: состояние, приём кадра и подписка на закрытие. */
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
    close: () => {
      for (const fn of handlers.get('close') ?? []) fn()
    },
  } as unknown as WebSocket
  return { ws, heard }
}

const who = (sessionId: string, role: 'host' | 'participant'): TokenPayload => ({
  sessionId,
  participantId: `p_${role}`,
  role,
})

/** Что сказал сервер в ответ на это сообщение. `null` — не сказал ничего. */
function say(sessionId: string, role: 'host' | 'participant', message: ControlClientMessage) {
  const seat = socket()
  dispatch(seat.ws, sessionId, who(sessionId, role), message)
  const refusal = seat.heard.find(
    (frame): frame is Extract<ControlServerMessage, { t: 'error' }> => frame.t === 'error',
  )
  return refusal?.message ?? null
}

const classFrame = (heard: ControlServerMessage[]) =>
  heard.find((frame): frame is Extract<ControlServerMessage, { t: 'class' }> => frame.t === 'class')

let rooms = 0

/** Комната, где разрешено всё, что можно разрешить, — и с файлами для нажатий. */
function room(): string {
  const id = `class-ctl-${++rooms}`
  createSession(id, 'Занятие', null)
  setRules(id, WIDE_OPEN)
  makeFile(id, 'main.py', 'print(1)')
  makeFile(id, 'lecture.pdf', '%PDF-1.4')
  return id
}

/**
 * Всё, что меняет комнату или будит ядро. Ни одно из них не должно дойти до
 * действия: ячейка не встанет в очередь, оболочка не откроется, файл не
 * заведётся.
 */
const CLOSED: ControlClientMessage[] = [
  { t: 'run', cellId: 'c_nope' },
  { t: 'runAll' },
  { t: 'format' },
  { t: 'cells:move', cellId: 'c_nope', direction: 1 },
  { t: 'tree:new', path: 'заметка.txt' },
  { t: 'term:run', command: 'ls' },
  { t: 'file:run', path: 'main.py' },
  { t: 'board:open', name: 'lecture.pdf' },
  { t: 'clearOutputs' },
  { t: 'restart' },
]

test('после звонка участник упирается во всё, чем комната меняется', () => {
  const id = room()
  setFinished(id, Date.now())
  for (const message of CLOSED) {
    const said = say(id, 'participant', message)
    assert.ok(said, `${message.t} прошло у участника`)
    /*
     * И фраза одна на все отказы. Человеку сейчас неинтересно, какое правило
     * его остановило: услышать «в этом семинаре запускает преподаватель» —
     * значит пойти искать преподавателя, который ничего не менял.
     */
    assert.ok(
      said.includes(tr(CLASS_IS_OVER)),
      `${message.t} отказал правилом, а не концом занятия: ${said}`,
    )
  }
})

test('отказ после звонка — это ещё и отсутствие следа, а не только слово', () => {
  /*
   * Слово легко: `assert.ok(said)` ловит промах проверки, но не ловит проверку,
   * которая ОТКАЗАЛА ПОСЛЕ действия. Здесь нажимают по настоящей ячейке и по
   * настоящему файлу, а потом смотрят на комнату: она обязана быть той же,
   * какой была до нажатий.
   */
  const id = room()
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  const before = cells.toArray().map((cell) => cell.get('id') as string)
  assert.ok(before.length >= 2, 'в стартовой тетради нечего переставлять')
  doc.transact(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'stream')
    out.set('json', JSON.stringify({ name: 'stdout', text: 'посчитано на паре\n' }))
    ;(cells.get(0).get('outputs') as Y.Array<unknown>).push([out])
  }, 'server')

  setFinished(id, Date.now())
  for (const message of [
    { t: 'run', cellId: before[0] },
    { t: 'cells:move', cellId: before[0], direction: 1 },
    { t: 'tree:new', path: 'заметка.txt' },
    { t: 'clearOutputs' },
    { t: 'board:open', name: 'lecture.pdf' },
  ] as ControlClientMessage[]) {
    assert.ok(say(id, 'participant', message), `${message.t} прошло у участника`)
  }

  assert.deepEqual(
    cells.toArray().map((cell) => cell.get('id') as string),
    before,
    'ячейки переставились, а отказ прозвучал',
  )
  assert.equal(cells.get(0).get('state'), 'idle', 'ячейка встала в очередь после отказа')
  assert.equal(
    (cells.get(0).get('outputs') as Y.Array<unknown>).length,
    1,
    'вывод пары стёрт после отказа',
  )
  assert.equal(
    listFiles(id).some((entry) => entry.path === 'заметка.txt'),
    false,
    'файл завёлся после отказа',
  )
  assert.equal(boardOf(id), null, 'документ встал на общий экран после отказа')
})

test('а преподаватель в законченной комнате может всё то же, что и до звонка', () => {
  // Разбор дописывают после пары, и дописывает его тот, кто её вёл.
  const id = room()
  setFinished(id, Date.now())
  for (const message of CLOSED) {
    assert.equal(say(id, 'host', message), null, `${message.t} отказано преподавателю`)
  }
})

test('пока занятие идёт, ни один из этих отказов не звучит', () => {
  // Правило, которое отказывает всем, — не правило: те же десять нажатий в той
  // же комнате обязаны проходить, пока звонка не было.
  const id = room()
  for (const message of CLOSED) {
    assert.equal(say(id, 'participant', message), null, `${message.t} отказано до звонка`)
  }
})

test('закончить занятие может преподаватель, а участник — нет', () => {
  const id = room()

  assert.ok(say(id, 'participant', { t: 'class:finish' }), 'участник закончил занятие молча')
  assert.equal(isFinished(id), false, 'занятие закончил участник')

  assert.equal(say(id, 'host', { t: 'class:finish' }), null)
  assert.equal(isFinished(id), true, 'преподаватель нажал, а занятие идёт')
  assert.ok(say(id, 'participant', { t: 'run', cellId: 'c_nope' }), 'запуск остался открытым')

  // Обратное движение — одним нажатием, и тоже преподавательское: пара
  // заканчивается раньше, чем понадобилось дописать одну ячейку.
  assert.ok(say(id, 'participant', { t: 'class:resume' }), 'участник открыл занятие сам')
  assert.equal(say(id, 'host', { t: 'class:resume' }), null)
  assert.equal(isFinished(id), false)
  assert.equal(say(id, 'participant', { t: 'run', cellId: 'c_nope' }), null, 'права не вернулись')
  assert.equal(storedRules(id).run, 'room', 'настройка не пережила конца занятия')
})

test('о звонке комната узнаёт кадром, а опоздавший — из приветствия', () => {
  /*
   * Отдельным кадром, а не полем в `rules`: хранимые правила при этом не
   * меняются. И в приветственной пачке — иначе вкладка, чей сокет моргнул
   * поперёк звонка, живёт с открытыми кнопками до конца дня.
   */
  const id = room()
  const seat = socket()
  const desk = socket()
  handleControlSocket(seat.ws, id, who(id, 'participant'))
  handleControlSocket(desk.ws, id, who(id, 'host'))

  const greeting = classFrame(seat.heard)
  assert.ok(greeting, 'в приветственной пачке нет кадра о занятии')
  assert.equal(greeting.finishedAt, null, 'идущее занятие приехало законченным')

  seat.heard.length = 0
  dispatch(desk.ws, id, who(id, 'host'), { t: 'class:finish' })

  const told = classFrame(seat.heard)
  assert.ok(told, 'комнате не сказали, что занятие кончилось')
  assert.equal(typeof told.finishedAt, 'number')
  assert.equal(told.finishedAt, finishedAt(id))

  // И тот, кто зашёл после звонка, узнаёт то же самое из приветствия.
  const late = socket()
  handleControlSocket(late.ws, id, who(id, 'participant'))
  assert.equal(classFrame(late.heard)?.finishedAt, finishedAt(id))

  closeControlRoom(id)
})

/* --------------------------------------------------------- пульт лекции */

/** Все восемь сообщений пульта — то, чем ведущий двигает лекцию всему залу. */
const REMOTE: ControlClientMessage[] = [
  { t: 'lecture:page', page: 8 },
  { t: 'lecture:blank', on: true },
  { t: 'ink', page: 7, id: 's_new', color: '#000000', width: 0.004, points: [0.3, 0.3, 0.4, 0.4] },
  { t: 'ink:undo', page: 7 },
  { t: 'ink:erase', page: 7, id: 's_first' },
  { t: 'ink:clear' },
  { t: 'laser', page: 7, x: 0.5, y: 0.5 },
  { t: 'laser:off' },
]

/** Лекция, которую ведёт студент: ровно то, ради чего есть `board: 'room'`. */
function lecture(id: string): void {
  startLecture(id, { file: 'lecture.pdf', by: 'p_participant', byName: 'Нина', color: '#d4162f' })
  turnTo(id, 7)
  addInk(id, {
    id: 's_first',
    page: 7,
    color: '#d4162f',
    width: 0.004,
    points: [0.1, 0.1, 0.2, 0.2],
  })
}

test('после звонка пульт у студента-ведущего отбирают, а лекцию не гасят', () => {
  /*
   * Комната, где студенты по очереди показывают своё, — не выдумка, и ведущим
   * в ней бывает студент. Роль на пульте поэтому не спрашивается вовсе, и без
   * звонка это правильно: страницу двигает тот, кто ведёт.
   */
  const id = room()
  lecture(id)
  assert.equal(say(id, 'participant', { t: 'lecture:page', page: 8 }), null)
  assert.equal(lectureOf(id)?.page, 8, 'ведущий студент не листает и до звонка')
  turnTo(id, 7)

  setFinished(id, Date.now())
  for (const message of REMOTE) {
    // Отказ здесь молчаливый, как и все отказы этого блока: кадр прилетает от
    // вкладки, которая ещё не знает, что пара кончилась.
    assert.equal(say(id, 'participant', message), null, `${message.t} ответил словами`)
  }
  // Лекцию звонок не гасит: сорок минут разметки живут только в памяти.
  assert.equal(lectureOf(id)?.file, 'lecture.pdf', 'лекция погасла вместе с занятием')
  assert.equal(lectureOf(id)?.page, 7, 'студент листал зал после звонка')
  assert.equal(lectureOf(id)?.blank, false, 'студент погасил экран после звонка')
  assert.equal(inkOf(id).length, 1, 'разметку тронули после звонка')
  assert.equal(inkOf(id)[0]?.id, 's_first', 'штрих подменили после звонка')

  // Занятие открыли обратно — пульт вернулся тому же студенту.
  setFinished(id, null)
  assert.equal(say(id, 'participant', { t: 'lecture:page', page: 9 }), null)
  assert.equal(lectureOf(id)?.page, 9, 'пульт не вернулся вместе с занятием')
  stopLecture(id)
})

test('после звонка лекцию ведёт преподаватель — перехватив пульт, как и раньше', () => {
  const id = room()
  lecture(id)
  setFinished(id, Date.now())

  // Пульт не переезжает к преподавателю сам собой: ведущий по-прежнему один.
  assert.equal(say(id, 'host', { t: 'lecture:page', page: 4 }), null)
  assert.equal(lectureOf(id)?.page, 7, 'пульт достался тому, кто его не брал')

  // Перехват — тем же `lecture:start` по тому же файлу, и разметка цела.
  assert.equal(say(id, 'host', { t: 'lecture:start', file: 'lecture.pdf' }), null)
  assert.equal(lectureOf(id)?.by, 'p_host', 'пульт не перешёл преподавателю')
  assert.equal(lectureOf(id)?.page, 7, 'перехват начал лекцию заново')
  assert.equal(inkOf(id).length, 1, 'перехват стёр разметку')

  assert.equal(say(id, 'host', { t: 'lecture:page', page: 8 }), null)
  assert.equal(lectureOf(id)?.page, 8, 'преподаватель не листает свою же лекцию')
  assert.equal(say(id, 'host', { t: 'ink:clear' }), null)
  assert.equal(inkOf(id).length, 0, 'преподаватель не стирает разметку после звонка')
  stopLecture(id)
})

test('после звонка указка студента до зала не доходит', () => {
  // У указки нет состояния — она только рассылается, и проверить её можно
  // единственным способом: тем, что зал её не увидел.
  const id = room()
  const hall = socket()
  handleControlSocket(hall.ws, id, who(id, 'host'))
  lecture(id)

  hall.heard.length = 0
  say(id, 'participant', { t: 'laser', page: 7, x: 0.5, y: 0.5 })
  assert.ok(
    hall.heard.some((frame) => frame.t === 'laser'),
    'пятно ведущего не доехало до зала и до звонка',
  )

  setFinished(id, Date.now())
  hall.heard.length = 0
  say(id, 'participant', { t: 'laser', page: 7, x: 0.6, y: 0.6 })
  assert.ok(
    !hall.heard.some((frame) => frame.t === 'laser'),
    'указка студента светит залу после звонка',
  )

  stopLecture(id)
  closeControlRoom(id)
})

/* -------------------------------------------------- предложение оракула */

/** Предложение в треде комнаты — то, у которого есть «принять» и «отклонить». */
function propose(sessionId: string, participantId: string): string {
  const doc = getSessionDoc(sessionId).doc
  const entry = createChatEntry({
    participantId,
    name: 'Нина',
    color: '#d4162f',
    question: 'почини это',
    action: 'edit',
    cellId: 'c_nope',
  })
  doc.transact(() => getChat(doc).push([entry]))
  return entry.get('id') as string
}

/** Что стало с плашкой: `open`, пока её никто не тронул. */
function patchStateOf(sessionId: string, entryId: string): unknown {
  return findChatEntry(getSessionDoc(sessionId).doc, entryId)?.get('patchState')
}

test('пока занятие идёт, отклонить предложение может кто угодно', () => {
  // Снятая плашка ничего не разрушает: оракула спрашивают заново.
  const id = room()
  const entryId = propose(id, 'p_host')
  assert.equal(say(id, 'participant', { t: 'ai:decide', entryId, accept: false }), null)
  assert.equal(patchStateOf(id, entryId), 'rejected', 'отклонить не вышло и до звонка')
})

test('после звонка участник не отклоняет предложение — вернуть его нечем', () => {
  /*
   * `rejected` ставится навсегда, а спросить оракула заново участник уже не
   * может: снятая им плашка — это стёртая чужая работа, а не убранная подсказка.
   */
  const id = room()
  const entryId = propose(id, 'p_host')
  setFinished(id, Date.now())

  const denied = say(id, 'participant', { t: 'ai:decide', entryId, accept: false })
  assert.ok(denied?.includes(tr(CLASS_IS_OVER)), `отказ говорит не про конец занятия: ${denied}`)
  assert.equal(patchStateOf(id, entryId), 'open', 'плашку сняли после звонка')

  // «Принять» закрыто правилом `edit`, и фраза у него та же.
  const accept = say(id, 'participant', { t: 'ai:decide', entryId, accept: true })
  assert.ok(accept?.includes(tr(CLASS_IS_OVER)), `принять отказало правилом: ${accept}`)
  assert.equal(patchStateOf(id, entryId), 'open')

  // Преподаватель решает и после звонка: разбор дописывает он.
  assert.equal(say(id, 'host', { t: 'ai:decide', entryId, accept: false }), null)
  assert.equal(patchStateOf(id, entryId), 'rejected', 'преподавателю отказали')

  // И занятие можно открыть обратно — право вернётся вместе с ним.
  const second = propose(id, 'p_host')
  setFinished(id, null)
  assert.equal(say(id, 'participant', { t: 'ai:decide', entryId: second, accept: false }), null)
  assert.equal(patchStateOf(id, second), 'rejected', 'право не вернулось с занятием')
})

/* ----------------------------------------------------- ящик терминала */

test('после звонка ящик терминала открывается, но оболочку не будит', () => {
  /*
   * Лента общая, и после пары за ней и приходят — поэтому отказа тут нет. А
   * поднимать контейнер и заводить новую оболочку ради чтения уже не за что.
   */
  const id = room()
  setFinished(id, Date.now())

  const seat = socket()
  dispatch(seat.ws, id, who(id, 'participant'), { t: 'term:open' })
  assert.ok(!seat.heard.some((frame) => frame.t === 'error'), 'ящик отказался открываться словами')
  assert.equal(terminalPhase(id), 'closed', 'чтение ленты подняло контейнер комнаты')
  // Статус всё равно уходит: без него вкладка ждёт запуска, которого никто не
  // начинал.
  const status = seat.heard.find(
    (frame): frame is Extract<ControlServerMessage, { t: 'terminal' }> => frame.t === 'terminal',
  )
  assert.equal(status?.status, 'closed', 'вкладке не сказали, что оболочка спит')
})

test('а преподавателю ящик по-прежнему заводит оболочку', () => {
  // Разбор после пары дописывает он же, и оболочка ему нужна настоящая.
  const id = room()
  setFinished(id, Date.now())
  dispatch(socket().ws, id, who(id, 'host'), { t: 'term:open' })
  assert.equal(terminalPhase(id), 'starting', 'преподавателю не завели оболочку')
})

/* ------------------------------------------------ обрыв работы оракула */

function cancelEntry(sessionId: string, role: 'host' | 'participant', entryId: string) {
  return fetch(`${base}/api/sessions/${sessionId}/ai/cancel`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenFor(sessionId, role)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ entryId }),
  })
}

/**
 * Кто останавливает — и это уже не про звонок.
 *
 * Тест живёт здесь, потому что здесь стоит единственная в сюите связка
 * «маршруты оракула + настоящий преподаватель», а правило одно на обе стороны
 * звонка, и проверять его врозь значило бы делать вид, что их две.
 */
test('свою запись останавливает автор, чужую — только преподаватель', async () => {
  /*
   * «Остановить может кто угодно, это ничего не разрушает» верно ровно для
   * своей записи. Оборвать чужой ответ — стереть работу, которую человек ждёт;
   * оборвать чужой ход агента — бросить правку файлов на середине.
   */
  const id = 'class-cancel-own'
  createSession(id, 'Чей вопрос', null)
  const mine = propose(id, `p_${id}_participant`)
  const theirs = propose(id, `p_${id}_host`)

  const denied = await cancelEntry(id, 'participant', theirs)
  assert.equal(denied.status, 403, 'участник оборвал чужую работу посреди пары')
  const body = (await denied.json()) as { error: string }
  assert.match(body.error, /свой вопрос/, `отказ не назвал правило: ${body.error}`)
  assert.ok(!body.error.includes(tr(CLASS_IS_OVER)), 'отказ сослался на звонок, которого не было')

  assert.equal(
    (await cancelEntry(id, 'participant', mine)).status,
    200,
    'свою запись не остановить',
  )
  // Преподавателю чужая нужна по-настоящему: разогнавшийся ответ висит на
  // проекторе у всей комнаты, а спросил его кто-то из зала.
  assert.equal((await cancelEntry(id, 'host', theirs)).status, 200, 'преподавателю отказали')
})

test('после звонка правило то же самое', async () => {
  // Звонок здесь ничего не добавляет и ничего не отнимает — и это проверяется,
  // потому что отдельная проверка на него из маршрута ушла как лишняя.
  const id = 'class-cancel'
  createSession(id, 'Обрыв', null)
  const mine = propose(id, `p_${id}_participant`)
  const theirs = propose(id, `p_${id}_host`)

  setFinished(id, Date.now())
  assert.equal(
    (await cancelEntry(id, 'participant', theirs)).status,
    403,
    'участник оборвал чужую работу после звонка',
  )
  assert.equal(
    (await cancelEntry(id, 'participant', mine)).status,
    200,
    'свою запись, спрошенную до звонка, не остановить',
  )
  assert.equal((await cancelEntry(id, 'host', theirs)).status, 200, 'преподавателю отказали')

  setFinished(id, null)
  assert.equal(
    (await cancelEntry(id, 'participant', theirs)).status,
    403,
    'открытое обратно занятие вернуло право на чужую запись',
  )
})
