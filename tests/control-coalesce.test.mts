/**
 * Что комната получает и чего НЕ получает: склейка кадров и потолки вслух.
 *
 * Управляющий сокет — единственное место, где один жест превращается в цикл
 * `ws.send` по всем сокетам комнаты. На двадцати это никто не замечал; на
 * пятистах каждый лишний кадр — это пятьсот отправок и пятьсот отдельных
 * сжатий. Три вещи проверяются здесь утверждениями, а не на глаз:
 *
 *   — список файлов, не изменившийся с прошлой рассылки, не уезжает вовсе
 *     (тик взводится от автосохранения и от вывода ядра, а дерево при этом
 *     чаще всего то же самое);
 *   — уже построенное дерево берётся как есть, без второго обхода папки;
 *   — указка склеивается на такт, и за такт побеждает последняя точка;
 *   — потолок чернил отвечает СЛОВАМИ, а не молчанием: молчание пульт не
 *     отличал от потерянного кадра и восемь раз досылал штрих целиком.
 *
 * Ни сети, ни ядра: сокеты поддельные, комната настоящая, диспетчер тот же,
 * что слушает провод.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession } from '../server/src/db.js'
import { makeFile } from '../server/src/workspace.js'
import {
  broadcastFiles,
  closeControlRoom,
  dispatch,
  handleControlSocket,
} from '../server/src/control.js'
import { startLecture, stopLecture } from '../server/src/lecture.js'
import { MAX_POINTS_PER_STROKE, inkFullSays } from '../shared/lecture.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      // Строкой или байтами: кадры, которые сервер собирает раз на комнату
      // (дерево, чернила), уходят уже закодированными — см. control.ts ·
      // sendFrame. Настоящий сокет тут разницы не делает, и подделка не делает.
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping() {},
    terminate() {},
    // Закрытие обязано дойти до обработчика: комната узнаёт, что опустела,
    // только из него — а на этом стоит половина проверок ниже.
    close() {
      fake.readyState = WebSocket.CLOSED
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  return { ws: fake as unknown as WebSocket, heard }
}

let rooms = 0

function room(): { id: string; host: TokenPayload; seat: ReturnType<typeof socket> } {
  const id = `coalesce-${++rooms}`
  createSession(id, 'Склейка', null)
  const host: TokenPayload = { sessionId: id, participantId: 'p_host', role: 'host' }
  const seat = socket()
  handleControlSocket(seat.ws, id, host)
  return { id, host, seat }
}

function say(id: string, who: TokenPayload, ws: WebSocket, message: ControlClientMessage): void {
  dispatch(ws, id, who, message)
}

const filesFrames = (heard: ControlServerMessage[]): ControlServerMessage[] =>
  heard.filter((frame) => frame.t === 'files')

const laserFrames = (heard: ControlServerMessage[]): ControlServerMessage[] =>
  heard.filter((frame) => frame.t === 'laser')

/* ------------------------------------------------------------ дерево */

test('одно и то же дерево второй раз никуда не уезжает', () => {
  /*
   * Тик рассылки взводится от всего, что ТРОГАЕТ папку: автосохранение
   * редактора, проекция тетради, запись из ячейки. Пока считается ячейка с
   * `print` в цикле, это дважды в секунду — при неподвижном диске.
   */
  const { id, seat } = room()
  makeFile(id, 'model.py', 'x = 1')
  seat.heard.length = 0

  broadcastFiles(id)
  assert.equal(filesFrames(seat.heard).length, 1, 'первая рассылка не уехала')

  broadcastFiles(id)
  broadcastFiles(id)
  assert.equal(filesFrames(seat.heard).length, 1, 'неизменившееся дерево уехало ещё раз')

  // А настоящая перемена — уезжает: молчание здесь про повтор, а не про кэш.
  makeFile(id, 'data.csv', 'a,b')
  broadcastFiles(id)
  assert.equal(filesFrames(seat.heard).length, 2, 'новый файл до комнаты не доехал')
  closeControlRoom(id)
})

test('опустевшая комната не уносит расписку с собой в следующую пару', () => {
  /*
   * `treeSent` держит обещание «этот список видели ВСЕ в комнате». Пока комната
   * стоит пустой, дерево может измениться и вернуться обратно, и расписка,
   * пережившая последнего ушедшего, заставила бы следующую рассылку промолчать
   * перед людьми, которые ничего этого не видели.
   */
  const { id, seat } = room()
  makeFile(id, 'model.py', 'x = 1')
  broadcastFiles(id)

  seat.ws.close()
  const second = socket()
  handleControlSocket(second.ws, id, { sessionId: id, participantId: 'p_two', role: 'participant' })
  second.heard.length = 0

  broadcastFiles(id)
  assert.equal(filesFrames(second.heard).length, 1, 'расписка пережила пустую комнату')
  closeControlRoom(id)
})

test('готовое дерево берётся как есть — второй обход папки не нужен', () => {
  /*
   * На одну загрузку файла обход папки шёл дважды: один раз на ответ, второй —
   * внутри рассылки. Дерево, отданное вызывающим, отличается здесь от того, что
   * лежит на диске, — именно этим и доказывается, что `listTree` не звали.
   */
  const { id, seat } = room()
  makeFile(id, 'real.py', 'x = 1')
  seat.heard.length = 0

  broadcastFiles(id, {
    files: [{ name: 'given.py', path: 'given.py', dir: false, size: 3, modifiedAt: 0 }],
    truncated: false,
  })
  const frame = filesFrames(seat.heard).at(-1)
  assert.ok(frame && frame.t === 'files')
  assert.deepEqual(
    frame.files.map((entry) => entry.path),
    ['given.py'],
    'дерево пересчитали заново, хотя его дали готовым',
  )
  closeControlRoom(id)
})

/* ------------------------------------------------------------ указка */

test('указка склеивается на такт, и за такт побеждает последняя точка', async () => {
  const { id, host, seat } = room()
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  // Первый кадр — сразу: указка обязана появиться там, куда показали.
  say(id, host, seat.ws, { t: 'laser', page: 1, x: 0.1, y: 0.1 })
  assert.equal(laserFrames(seat.heard).length, 1, 'первый кадр указки задержали')

  // Всё, что пришло за такт, — одним кадром, и это последнее положение руки.
  for (let i = 0; i < 20; i += 1) {
    say(id, host, seat.ws, { t: 'laser', page: 1, x: 0.2 + i / 100, y: 0.2 })
  }
  assert.equal(laserFrames(seat.heard).length, 1, 'каждое движение руки ушло отдельным кадром')

  await new Promise((done) => setTimeout(done, 120))
  const frames = laserFrames(seat.heard)
  assert.equal(frames.length, 2, 'хвост такта не уехал или уехал не один')
  const last = frames[1]
  assert.ok(last.t === 'laser' && last.at)
  assert.equal(last.at.x, 0.2 + 19 / 100, 'уехала не последняя точка')

  stopLecture(id)
  closeControlRoom(id)
})

test('погашенная указка не зажигается хвостом такта', async () => {
  /*
   * Придержанная точка обязана уйти вместе с рукой. Иначе «off» гасит пятно, а
   * через шестьдесят миллисекунд оно возвращается туда, где рука была.
   */
  const { id, host, seat } = room()
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  say(id, host, seat.ws, { t: 'laser', page: 1, x: 0.1, y: 0.1 })
  say(id, host, seat.ws, { t: 'laser', page: 1, x: 0.9, y: 0.9 })
  say(id, host, seat.ws, { t: 'laser:off' })
  await new Promise((done) => setTimeout(done, 120))

  const frames = laserFrames(seat.heard)
  const last = frames.at(-1)
  assert.ok(last && last.t === 'laser')
  assert.equal(last.at, null, 'после «off» указка зажглась обратно')

  stopLecture(id)
  closeControlRoom(id)
})

/* ----------------------------------------------------------- чернила */

test('потолок штриха отвечает словами, а не молчанием', () => {
  /*
   * Пульт свои два потолка считает сам и штрих на полной странице не открывает
   * вовсе; точки, кончившиеся ПОСРЕДИ штриха, он посчитать не может — про них
   * говорит сервер. Молчание здесь стоило четырёх секунд и восьми досылок
   * штриха целиком.
   */
  const { id, host, seat } = room()
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })

  const chunk = Array.from({ length: 512 }, () => 0.5)
  for (let i = 0; i < MAX_POINTS_PER_STROKE / 512 + 2; i += 1) {
    say(id, host, seat.ws, {
      t: 'ink',
      id: 'long',
      page: 1,
      color: '#111',
      width: 0.004,
      points: chunk,
    })
  }
  seat.heard.length = 0
  say(id, host, seat.ws, {
    t: 'ink',
    id: 'long',
    page: 1,
    color: '#111',
    width: 0.004,
    points: [0.1, 0.1],
  })

  const refusal = seat.heard.find((frame) => frame.t === 'error')
  assert.ok(refusal && refusal.t === 'error', 'переполненный штрих отказали молча')
  assert.equal(refusal.message, inkFullSays('stroke-full'))
  assert.ok(
    !seat.heard.some((frame) => frame.t === 'ink:add'),
    'отказанный штрих всё-таки разослали',
  )

  stopLecture(id)
  closeControlRoom(id)
})

test('точки без пары — по-прежнему молчание: добавлять нечего, а не потолок', () => {
  // Различать «нечего добавить» и «упёрлись» обязан именно сервер: первое —
  // мусор из вкладки, о котором человеку сказать нечего.
  const { id, host, seat } = room()
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  say(id, host, seat.ws, {
    t: 'ink',
    id: 's1',
    page: 1,
    color: '#111',
    width: 0.004,
    points: [0.5],
  })
  assert.deepEqual(seat.heard, [], 'на пустой кадр ответили словами')

  stopLecture(id)
  closeControlRoom(id)
})
