/**
 * Чего стоит один жест на управляющем сокете — и что происходит, когда провод
 * не успевает.
 *
 * Управляющий сокет — единственное место, где одно движение руки превращается
 * в цикл `ws.send` по всем сокетам комнаты, и по нему едет всё самое крупное:
 * дерево файлов, стопка консилиума (до четырёх мегабайт) и чернила лекции
 * тридцать раз в секунду. Три вещи проверяются здесь утверждениями:
 *
 *   — ОБРАТНОЕ ДАВЛЕНИЕ. Пока `send` смотрел только на `readyState`, всё, что
 *     не влезло в провод, складывалось в память процесса — по копии на каждый
 *     отставший сокет. Теперь у очереди две черты, ровно как у общего документа
 *     (collab/index.ts): за первой перестают ехать кадры, которые имеют смысл
 *     только сейчас, за второй сокет рвётся и вкладка возвращается сама.
 *   — СКЛЕЙКА ЧЕРНИЛ. Кусок штриха уезжал своим кадром: 89.6 КБ на комнату в
 *     пятьсот человек, тридцать раз в секунду. Куски одного штриха склеиваются
 *     на такт — и всё, что говорит о чернилах что-то ещё, обязано ехать ПОСЛЕ
 *     придержанного, иначе зал стирает штрих, к которому в очереди лежат точки.
 *   — ОДИН ТАКТ ПИНГА НА КОМНАТУ, а не таймер на каждый из пятисот сокетов.
 *
 * Ни сети, ни ядра: сокеты поддельные, комната настоящая, диспетчер тот же, что
 * слушает провод.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createSession } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { startLecture, stopLecture } from '../server/src/lecture.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

interface Fake {
  ws: WebSocket
  /** Кадры как их разобрал бы браузер. */
  heard: ControlServerMessage[]
  /** Кадры как они ушли в провод: строкой или уже байтами. */
  raw: (string | Buffer)[]
  pings: number
  killed: boolean
  stall: (bytes: number) => void
}

function socket(): Fake {
  const heard: ControlServerMessage[] = []
  const raw: (string | Buffer)[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const fake = {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(frame: unknown) {
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        raw.push(frame as string | Buffer)
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {
      out.pings++
    },
    // Настоящий `terminate` рвёт соединение и поднимает `close`; комната узнаёт,
    // что опустела, только оттуда.
    terminate() {
      out.killed = true
      fake.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
    close() {
      fake.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  const out: Fake = {
    ws: fake as unknown as WebSocket,
    heard,
    raw,
    pings: 0,
    killed: false,
    stall: (bytes: number) => {
      fake.bufferedAmount = bytes
    },
  }
  return out
}

let rooms = 0

function room(): { id: string; host: TokenPayload; seat: Fake } {
  const id = `backpressure-${++rooms}`
  createSession(id, 'Давление', null)
  const host: TokenPayload = { sessionId: id, participantId: 'p_host', role: 'host' }
  const seat = socket()
  handleControlSocket(seat.ws, id, host)
  return { id, host, seat }
}

function say(id: string, who: TokenPayload, ws: WebSocket, message: ControlClientMessage): void {
  dispatch(ws, id, who, message)
}

/** Кусок штриха — так, как его шлёт перо: точками по мере рисования. */
function stroke(id: string, points: number[]): ControlClientMessage {
  return { t: 'ink', id, page: 1, color: '#101a33', width: 0.004, points }
}

const inkAdds = (heard: ControlServerMessage[]) => heard.filter((frame) => frame.t === 'ink:add')

/* ------------------------------------------------------- обратное давление */

test('отставшему не шлют указку и чернила — а правила и конец занятия шлют', () => {
  const { id, host, seat } = room()
  startLecture(id, { file: 'л.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  const slow = socket()
  handleControlSocket(slow.ws, id, { sessionId: id, participantId: 'p_slow', role: 'participant' })

  // Два мегабайта в очереди: за первой чертой (1 МБ), далеко до второй (8 МБ).
  slow.stall(2 * 1024 * 1024)
  seat.heard.length = 0
  slow.heard.length = 0

  say(id, host, seat.ws, { t: 'laser', page: 1, x: 0.5, y: 0.5 })
  say(id, host, seat.ws, stroke('s1', [0, 0, 0.1, 0.1]))
  assert.equal(
    slow.heard.filter((frame) => frame.t === 'laser' || frame.t === 'ink:add').length,
    0,
    'отставшему уехало то, что имеет смысл только сейчас',
  )
  assert.ok(
    seat.heard.some((frame) => frame.t === 'laser'),
    'вместе с отставшим замолчали перед всеми',
  )

  // А кадр, который не повторится, — уезжает: потерять его значит оставить
  // человека с комнатой, которой нет.
  slow.heard.length = 0
  say(id, host, seat.ws, { t: 'class:finish' })
  assert.ok(
    slow.heard.some((frame) => frame.t === 'class'),
    'отставшему не сказали, что занятие кончилось',
  )
  assert.equal(slow.killed, false, 'сокет разорвали, не дождавшись второй черты')

  stopLecture(id)
  closeControlRoom(id)
})

test('безнадёжно отставший сокет рвётся, и комната его забывает', () => {
  const { id, host, seat } = room()
  const slow = socket()
  handleControlSocket(slow.ws, id, { sessionId: id, participantId: 'p_slow', role: 'participant' })

  // Восемь мегабайт очереди — это не медленная сеть, а закрытая крышка: всё,
  // что комната скажет дальше, ляжет в память процесса и никуда не уедет.
  slow.stall(9 * 1024 * 1024)
  say(id, host, seat.ws, { t: 'class:finish' })

  assert.equal(slow.killed, true, 'сокет с девятью мегабайтами очереди оставили жить')
  // И комната узнала об уходе: `terminate` поднимает `close`, а на нём стоит
  // вся уборка. Иначе рассылка до конца пары ходила бы по мёртвому сокету.
  slow.heard.length = 0
  say(id, host, seat.ws, { t: 'class:resume' })
  assert.deepEqual(slow.heard, [])

  closeControlRoom(id)
})

test('кадр рассылки кодируется раз на комнату, а не на каждый сокет', () => {
  /*
   * `ws.send(строка)` кодирует её в UTF-8 заново на КАЖДЫЙ сокет — около
   * миллисекунды на мегабайт. Кадр пера на комнату в пятьсот человек — 89.6 КБ
   * тридцать раз в секунду: 4.9 МБ/с одного только кодирования, которое можно
   * сделать один раз. Доказательство — тождество: все получили ОДИН объект.
   */
  const { id, host, seat } = room()
  const second = socket()
  handleControlSocket(second.ws, id, {
    sessionId: id,
    participantId: 'p_two',
    role: 'participant',
  })
  seat.raw.length = 0
  second.raw.length = 0

  say(id, host, seat.ws, { t: 'class:finish' })
  const mine = seat.raw.at(-1)
  const theirs = second.raw.at(-1)
  assert.ok(Buffer.isBuffer(mine), 'кадр уехал строкой — ws закодирует его каждому заново')
  assert.equal(mine, theirs, 'каждому сокету собрали свою копию кадра')

  closeControlRoom(id)
})

/* ------------------------------------------------------------ склейка чернил */

test('куски одного штриха склеиваются на такт, и точки не теряются', async () => {
  const { id, host, seat } = room()
  startLecture(id, { file: 'л.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  // Тридцать кусков подряд — столько перо шлёт за секунду рисования.
  for (let i = 0; i < 30; i++) say(id, host, seat.ws, stroke('s1', [i / 100, i / 100]))
  assert.equal(inkAdds(seat.heard).length, 1, 'первый кусок не уехал сразу или уехали все тридцать')

  await sleep(90)
  const frames = inkAdds(seat.heard)
  assert.ok(frames.length >= 2, 'придержанные куски так и не уехали')
  assert.ok(frames.length <= 4, `тридцать кусков уехали ${frames.length} кадрами`)

  // И ни одна точка не потерялась и не переставилась: зал видит ту же линию.
  const drawn: number[] = []
  for (const frame of frames) {
    assert.equal(frame.t === 'ink:add' && frame.stroke.id, 's1')
    if (frame.t === 'ink:add') drawn.push(...frame.stroke.points)
  }
  const expected: number[] = []
  for (let i = 0; i < 30; i++) expected.push(i / 100, i / 100)
  assert.deepEqual(drawn, expected, 'склейка нарисовала залу не то, что рисовали')

  stopLecture(id)
  closeControlRoom(id)
})

test('«сотрите штрих» едет ПОСЛЕ придержанных точек, а не перед ними', async () => {
  /*
   * Иначе зал стирает штрих, к которому в очереди лежат точки, — и они
   * дописываются к пустому месту заново. То же и с «вот вся страница целиком».
   */
  const { id, host, seat } = room()
  startLecture(id, { file: 'л.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  say(id, host, seat.ws, stroke('s1', [0, 0, 0.1, 0.1]))
  seat.heard.length = 0
  // Пока окно открыто — второй кусок придержан.
  say(id, host, seat.ws, stroke('s1', [0.2, 0.2]))
  assert.equal(inkAdds(seat.heard).length, 0, 'кусок уехал, не дождавшись такта')

  say(id, host, seat.ws, { t: 'ink:undo', page: 1 })
  const order = seat.heard.map((frame) => frame.t)
  assert.deepEqual(order, ['ink:add', 'ink:drop'], 'отмена обогнала придержанные точки')

  // И хвост такта не дошлёт их следом: они уже уехали.
  seat.heard.length = 0
  await sleep(90)
  assert.deepEqual(inkAdds(seat.heard), [], 'придержанное уехало дважды')

  stopLecture(id)
  closeControlRoom(id)
})

test('штрихи разных рук не меняются местами в одном такте', async () => {
  const { id, host, seat } = room()
  startLecture(id, { file: 'л.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  say(id, host, seat.ws, stroke('a', [0, 0, 0.1, 0.1]))
  seat.heard.length = 0

  say(id, host, seat.ws, stroke('b', [0.2, 0.2, 0.3, 0.3]))
  say(id, host, seat.ws, stroke('a', [0.4, 0.4]))
  say(id, host, seat.ws, stroke('b', [0.5, 0.5]))
  await sleep(90)

  const ids = inkAdds(seat.heard).map((frame) => (frame.t === 'ink:add' ? frame.stroke.id : ''))
  assert.deepEqual(ids, ['b', 'a', 'b'], 'склейка переставила штрихи двух рук')

  stopLecture(id)
  closeControlRoom(id)
})

/* ------------------------------------------------------------------ пинг */

test('такт пинга — один на комнату, а не на каждый сокет', () => {
  /*
   * Пинг — это два счётчика и `ws.ping()`; таймер вокруг него на одном сокете
   * не виден. На пятистах это пятьсот таймеров в куче node, просыпающихся
   * вразнобой по всей минуте, — то есть пятьсот пробуждений цикла событий там,
   * где хватает одного обхода набора, который и так лежит рядом.
   */
  const id = `ping-${++rooms}`
  createSession(id, 'Пинг', null)
  const real = globalThis.setInterval
  const ticks: (() => void)[] = []
  let started = 0
  ;(globalThis as { setInterval: typeof setInterval }).setInterval = ((
    fn: () => void,
    ms?: number,
  ) => {
    // Только такт пинга: всё прочее в комнате заводит свои таймеры на своих
    // сроках, и считать их здесь не о чем.
    if (ms === 25_000) {
      started++
      ticks.push(fn)
    }
    return real(() => {}, 1_000_000)
  }) as typeof setInterval

  const seats: Fake[] = []
  try {
    for (let i = 0; i < 5; i++) {
      const seat = socket()
      seats.push(seat)
      handleControlSocket(seat.ws, id, {
        sessionId: id,
        participantId: `p_${i}`,
        role: 'participant',
      })
    }
  } finally {
    ;(globalThis as { setInterval: typeof setInterval }).setInterval = real
  }

  assert.equal(started, 1, `на пять сокетов завели ${started} тактов пинга`)

  // Сроки те же, что были: два молчания подряд — и сокет рвётся.
  ticks[0]()
  assert.deepEqual(seats.map((seat) => seat.pings), [1, 1, 1, 1, 1])
  ticks[0]()
  assert.deepEqual(seats.map((seat) => seat.pings), [2, 2, 2, 2, 2])
  assert.equal(seats.some((seat) => seat.killed), false, 'сокет разорвали на втором пинге')
  ticks[0]()
  assert.equal(
    seats.every((seat) => seat.killed),
    true,
    'сокет, промолчавший два пинга подряд, оставили жить',
  )

  closeControlRoom(id)
})
