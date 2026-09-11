/**
 * Что стоит рассылка комнате на пятистах — числом, а не на глаз.
 *
 * Четыре вещи, каждая из которых на двадцати слушателях не видна вовсе, а на
 * пятистах занимает цикл событий целиком:
 *
 *   — склейка правок считалась ЗАНОВО на каждого автора (500 авторов в одном
 *     всплеске — 1.4 с на одну рассылку);
 *   — присутствие уезжало кадром на движение и отправителю в том числе, а
 *     `y-protocols` продлевает состояние каждые 15 с даже в молчащей комнате;
 *   — полный список лиц кодировался заново каждому входящему (75 КБ и 5.5 мс
 *     на человека, то есть 37 МБ на возврат зала);
 *   — весь документ холодной вкладке собирался заново каждому и уезжал НЕ
 *     сжатым (потолок сжатия написан про картинки ядра, а не про это).
 *
 * Сокеты здесь поддельные и запоминают САМ буфер, а не копию: одинаковость
 * ссылки — это и есть доказательство того, что кодировали один раз.
 */
import './_env.mts'
import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { WebSocket } from 'ws'
import { createSession } from '../server/src/db.js'
import {
  FACES_WINDOW_MS,
  getSessionDoc,
  handleCollabSocket,
  onlineCount,
  shutdownCollab,
} from '../server/src/collab/index.js'
import { cellSource, getCells } from '../shared/notebook.js'

after(() => shutdownCollab())

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const faceWindow = (): Promise<void> => wait(FACES_WINDOW_MS + 50)

interface Sent {
  frame: Uint8Array
  compress: boolean
}

interface Fake {
  ws: WebSocket
  sent: Sent[]
  /** Сколько раз комната спросила этот сокет, жив ли он. */
  pings: number
  /** Сказать серверу то же, что сказала бы вкладка. */
  fire(event: string, ...args: unknown[]): void
  pong(): void
  close(): void
}

/**
 * Ровно то, что читает `handleCollabSocket`, — и БЕЗ копирования кадра.
 *
 * Копия здесь была бы не мелочью: половина проверок ниже про то, что комната
 * собрала кадр один раз на всех, а увидеть это можно только по ссылке.
 */
function socket(): Fake {
  const sent: Sent[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const out: Fake = {
    ws: null as unknown as WebSocket,
    sent,
    pings: 0,
    fire(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
    pong() {
      out.fire('pong')
    },
    close() {
      fake.close()
    },
  }
  const fake = {
    binaryType: 'arraybuffer',
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(frame: unknown, ...rest: unknown[]) {
      const options = rest.find((it) => it && typeof it === 'object') as
        | { compress?: boolean }
        | undefined
      if (frame instanceof Uint8Array) sent.push({ frame, compress: options?.compress === true })
      const done = rest.find((it) => typeof it === 'function') as ((err?: Error) => void) | undefined
      done?.()
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {
      out.pings += 1
    },
    terminate() {
      fake.readyState = WebSocket.CLOSED
    },
    close() {
      fake.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  out.ws = fake as unknown as WebSocket
  return out
}

const syncSent = (fake: Fake): Sent[] => fake.sent.filter((it) => it.frame[0] === 0)
const faceSent = (fake: Fake): Sent[] => fake.sent.filter((it) => it.frame[0] === 1)

/** Байты правки из кадра синхронизации: тип, подтип, содержимое. */
function updateIn(frame: Uint8Array): Uint8Array {
  const decoder = decoding.createDecoder(frame)
  decoding.readVarUint(decoder)
  decoding.readVarUint(decoder)
  return decoding.readVarUint8Array(decoder)
}

/** Кадр присутствия от вкладки — ровно такой, какой шлёт `y-websocket`. */
function faceFrame(face: Awareness): Buffer {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(face, [face.clientID]))
  return Buffer.from(encoding.toUint8Array(encoder))
}

/** Первый кадр ХОЛОДНОЙ вкладки: «у меня нет ничего, дайте всё». */
function coldStep1(): Buffer {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  const empty = new Y.Doc()
  syncProtocol.writeSyncStep1(encoder, empty)
  empty.destroy()
  return Buffer.from(encoding.toUint8Array(encoder))
}

/* ------------------------------------------------------------ S-2: склейка */

test('всплеск пятисот авторов уезжает комнате ОДНИМ склеенным кадром', async () => {
  const id = 'fanout-authors'
  createSession(id, 'Пятьсот', null)
  const { doc } = getSessionDoc(id)
  const room = Array.from({ length: 500 }, () => socket())
  for (const seat of room) handleCollabSocket(seat.ws, id, 'participant', null)
  await tick()
  for (const seat of room) seat.sent.length = 0
  // Вкладка, синхронная с комнатой до всплеска.
  const tab = new Y.Doc()
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(doc))

  // Каждый печатает своё, и каждая правка приходит по своему сокету.
  for (const seat of room) {
    doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'x'), seat.ws)
  }
  await tick()

  const first = syncSent(room[0])
  assert.equal(first.length, 1, 'на всплеск уехал не один кадр')
  for (const seat of room) {
    const frames = syncSent(seat)
    assert.equal(frames.length, 1, 'кому-то уехало больше одного кадра')
    // Тот же самый буфер, а не такой же: склейка и кодирование были одни на всех.
    assert.equal(frames[0].frame, first[0].frame, 'кадр собрали заново — склейка считается на автора')
  }

  // И кадр этот — весь всплеск: вкладка приходит к тому же тексту.
  Y.applyUpdate(tab, updateIn(first[0].frame))
  assert.equal(
    cellSource(getCells(tab).get(0)).toString(),
    cellSource(getCells(doc).get(0)).toString(),
    'склеенный кадр донёс не весь всплеск',
  )

  for (const seat of room) seat.close()
})

/* --------------------------------------------------------- S-1: присутствие */

test('продления присутствия за окно уезжают одним кадром на получателя', async () => {
  const id = 'fanout-faces'
  createSession(id, 'Курсоры', null)
  getSessionDoc(id)
  const room = Array.from({ length: 50 }, () => socket())
  const faces = room.map(() => new Awareness(new Y.Doc()))
  for (const [i, seat] of room.entries()) {
    handleCollabSocket(seat.ws, id, 'participant', `p_${i}`)
    faces[i].setLocalStateField('user', { id: `p_${i}`, name: `Вкладка ${i}` })
    seat.fire('message', faceFrame(faces[i]))
  }
  await faceWindow()
  for (const seat of room) seat.sent.length = 0

  /*
   * Каждый объявляет себя заново — так `y-protocols` продлевает жизнь состояния
   * каждые пятнадцать секунд, даже когда в комнате никто ничего не делает. И
   * приходят эти продления ВРАЗБРОС, каждое своим тактом: без окна это
   * пятьдесят рассылок по пятьдесят сокетов.
   */
  for (const [i, seat] of room.entries()) {
    faces[i].setLocalStateField('user', { id: `p_${i}`, name: `Вкладка ${i}`, at: Date.now() })
    seat.fire('message', faceFrame(faces[i]))
    await tick()
  }
  await faceWindow()

  const total = room.reduce((sum, seat) => sum + faceSent(seat).length, 0)
  assert.equal(total, room.length, `окно выпустило ${total} кадров вместо ${room.length}`)
  const one = faceSent(room[0])[0].frame
  for (const seat of room) {
    assert.equal(faceSent(seat)[0].frame, one, 'кадр присутствия собрали каждому свой')
  }

  for (const seat of room) seat.close()
  for (const face of faces) face.destroy()
})

test('в окне с одним объявившимся его собственное лицо ему обратно не едет', async () => {
  const id = 'fanout-self'
  createSession(id, 'Сам себе', null)
  getSessionDoc(id)
  const room = Array.from({ length: 3 }, () => socket())
  const faces = room.map(() => new Awareness(new Y.Doc()))
  for (const [i, seat] of room.entries()) {
    handleCollabSocket(seat.ws, id, 'participant', `p_self_${i}`)
    faces[i].setLocalStateField('user', { id: `p_self_${i}`, name: `Вкладка ${i}` })
    seat.fire('message', faceFrame(faces[i]))
  }
  await faceWindow()
  for (const seat of room) seat.sent.length = 0

  faces[0].setLocalStateField('user', { id: 'p_self_0', name: 'Вкладка 0', at: 1 })
  room[0].fire('message', faceFrame(faces[0]))
  await faceWindow()

  assert.equal(faceSent(room[0]).length, 0, 'объявившемуся вернули его же лицо')
  assert.equal(faceSent(room[1]).length, 1, 'соседу лицо не доехало')
  assert.equal(faceSent(room[2]).length, 1, 'второму соседу лицо не доехало')

  for (const seat of room) seat.close()
  for (const face of faces) face.destroy()
})

/* ------------------------------------------------- S-7: список лиц вошедшему */

test('полный список лиц вошедшему берётся готовым, пока присутствие не менялось', async () => {
  const id = 'fanout-welcome'
  createSession(id, 'Список', null)
  getSessionDoc(id)
  const first = socket()
  handleCollabSocket(first.ws, id, 'participant', 'p_w0')
  const face = new Awareness(new Y.Doc())
  face.setLocalStateField('user', { id: 'p_w0', name: 'Первый' })
  first.fire('message', faceFrame(face))
  await faceWindow()

  const second = socket()
  handleCollabSocket(second.ws, id, 'participant', 'p_w1')
  const third = socket()
  handleCollabSocket(third.ws, id, 'participant', 'p_w2')

  const welcomeSecond = faceSent(second)
  const welcomeThird = faceSent(third)
  assert.equal(welcomeSecond.length, 1, 'вошедшему не отдали список лиц комнаты')
  assert.equal(welcomeThird.length, 1, 'второму вошедшему не отдали список лиц комнаты')
  assert.equal(welcomeThird[0].frame, welcomeSecond[0].frame, 'список лиц собрали заново')

  // Присутствие изменилось — список обязан стать другим.
  face.setLocalStateField('user', { id: 'p_w0', name: 'Первый', at: 2 })
  first.fire('message', faceFrame(face))
  await faceWindow()
  const fourth = socket()
  handleCollabSocket(fourth.ws, id, 'participant', 'p_w3')
  assert.notEqual(
    faceSent(fourth)[0].frame,
    welcomeSecond[0].frame,
    'вошедшему отдали вчерашний список лиц',
  )

  first.close()
  second.close()
  third.close()
  fourth.close()
  face.destroy()
})

/* --------------------------------------- CL-2/S-5: весь документ холодному */

test('холодной вкладке уезжает готовый кадр документа, и он сжимается', async () => {
  const id = 'fanout-cold'
  createSession(id, 'Холодная', null)
  const { doc } = getSessionDoc(id)
  // Документ крупнее потолка сжатия: именно на нём потолок и врал.
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'ы'.repeat(300_000)))

  const first = socket()
  handleCollabSocket(first.ws, id, 'participant', 'p_c0')
  first.sent.length = 0
  first.fire('message', coldStep1())

  const second = socket()
  handleCollabSocket(second.ws, id, 'participant', 'p_c1')
  second.sent.length = 0
  second.fire('message', coldStep1())

  const one = syncSent(first)
  const two = syncSent(second)
  assert.equal(one.length, 1, 'холодной вкладке не ответили документом')
  assert.equal(two.length, 1, 'второй холодной вкладке не ответили документом')
  assert.equal(one[0].frame, two[0].frame, 'документ собрали каждому заново')
  assert.ok(one[0].frame.byteLength > 256 * 1024, 'документ оказался мельче потолка сжатия')
  assert.equal(one[0].compress, true, 'весь документ уехал НЕ сжатым')

  // И это правда весь документ: пустая вкладка приходит к тому же тексту.
  const tab = new Y.Doc()
  Y.applyUpdate(tab, updateIn(one[0].frame))
  assert.equal(
    cellSource(getCells(tab).get(0)).toString(),
    cellSource(getCells(doc).get(0)).toString(),
  )

  // Правка в комнате — и следующему холодному едет уже другой кадр.
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'я'))
  await tick()
  const third = socket()
  handleCollabSocket(third.ws, id, 'participant', 'p_c2')
  third.sent.length = 0
  third.fire('message', coldStep1())
  const fresh = syncSent(third)[0]
  assert.notEqual(fresh.frame, one[0].frame, 'вошедшему отдали вчерашний документ')
  const late = new Y.Doc()
  Y.applyUpdate(late, updateIn(fresh.frame))
  assert.equal(
    cellSource(getCells(late).get(0)).toString(),
    cellSource(getCells(doc).get(0)).toString(),
    'готовый кадр отстал от документа',
  )

  first.close()
  second.close()
  third.close()
})

test('вернувшейся вкладке отвечают тем, чего у неё нет, и тоже сжимают', async () => {
  const id = 'fanout-warm'
  createSession(id, 'Вернувшаяся', null)
  const { doc } = getSessionDoc(id)
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, 'первое слово'))

  // Вкладка знает комнату по состоянию на минуту назад.
  const tab = new Y.Doc()
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(doc))
  doc.transact(() => cellSource(getCells(doc).get(0)).insert(0, ' и второе'))

  const seat = socket()
  handleCollabSocket(seat.ws, id, 'participant', 'p_warm')
  seat.sent.length = 0
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  syncProtocol.writeSyncStep1(encoder, tab)
  seat.fire('message', Buffer.from(encoding.toUint8Array(encoder)))

  const answer = syncSent(seat)
  assert.equal(answer.length, 1, 'вернувшейся вкладке не ответили')
  assert.equal(answer[0].compress, true, 'ответ первой синхронизации уехал НЕ сжатым')
  Y.applyUpdate(tab, updateIn(answer[0].frame))
  assert.equal(
    cellSource(getCells(tab).get(0)).toString(),
    cellSource(getCells(doc).get(0)).toString(),
    'вкладка не догнала комнату',
  )

  seat.close()
})

/* ------------------------------------------------- S-15: одно сердцебиение */

test('сердцебиение одно на комнату, и пропустивший два пинга закрыт', () => {
  const id = 'fanout-ping'
  createSession(id, 'Сердце', null)
  getSessionDoc(id)
  /*
   * Часы подменяются ДО первого сокета: таймер сердцебиения комната заводит
   * вместе с ним, а подменённые часы видят только то, что заведено при них.
   * Подменяется один `setInterval`: на `setTimeout` и `setImmediate` держится
   * склейка кадров, и без них рассылка не доедет никуда.
   */
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const alive = socket()
    const dead = socket()
    handleCollabSocket(alive.ws, id, 'participant', 'p_alive')
    handleCollabSocket(dead.ws, id, 'participant', 'p_dead')
    assert.equal(onlineCount(id), 2)

    // Один такт таймера — по пингу каждому: обход карты сокетов, а не таймер
    // на сокет.
    mock.timers.tick(25_000)
    assert.equal(alive.pings, 1, 'живому сокету не пришёл пинг')
    assert.equal(dead.pings, 1, 'молчащему сокету не пришёл пинг')

    alive.pong()
    mock.timers.tick(25_000)
    alive.pong()
    assert.equal(onlineCount(id), 2, 'закрыли того, кто отвечает')

    // Третий такт: у молчащего два пропущенных ответа подряд.
    mock.timers.tick(25_000)
    assert.equal(onlineCount(id), 1, 'сокет с закрытой крышкой ноутбука остался в комнате')
    assert.equal(alive.pings, 3, 'отвечающему перестали слать пинги')

    alive.close()
    assert.equal(onlineCount(id), 0)
  } finally {
    mock.timers.reset()
  }
})
