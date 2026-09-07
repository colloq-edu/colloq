/**
 * Приветственная пачка управляющего сокета — и её кэши.
 *
 * Дерево файлов и чернила лекции собирались заново на КАЖДОЕ подключение:
 * обход папки с lstat на каждую запись и плоский список всех штрихов всех
 * страниц плюс `JSON.stringify` — до мегабайта. Пока входят по одному, цена
 * незаметна; после перезапуска сервера пятьсот вкладок возвращаются в одну
 * секунду, и пятьсот одинаковых сборок ложатся в цикл событий ровно там, где
 * все ждут возврата. Теперь кадр собирается один на комнату.
 *
 * Здесь проверяется не скорость (её нечем мерить утверждением), а то, ради
 * чего кэш и опасен: он обязан устаревать. Комната, в которой завели файл или
 * дорисовали штрих, отдаёт следующему вошедшему новое, а не вчерашнее.
 *
 * С тех пор чернила в пачке обрезаны до показываемой страницы, а про остальные
 * едет опись, — и кэш стал ключом на пару «перемена + страница». Сама
 * постраничная выдача проверяется отдельно (lecture-ink-server); здесь —
 * только устаревание.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { addInk, startLecture, stopLecture } from '../server/src/lecture.js'
import { OPEN_ROOM } from '../shared/rules.js'
import type { ControlServerMessage } from '../shared/protocol.js'
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
      // (дерево, чернила), уходят уже закодированными — см. control.ts ·
      // sendFrame. Настоящий сокет тут разницы не делает, и подделка не делает.
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

let rooms = 0

function room(): string {
  const id = `welcome-${++rooms}`
  createSession(id, 'Пачка', null)
  setRules(id, { ...OPEN_ROOM })
  return id
}

function who(sessionId: string, participantId: string): TokenPayload {
  return { sessionId, participantId, role: 'host' }
}

/** Ещё один вошедший в ту же комнату. */
function enter(sock: Fake, sessionId: string, participantId: string): void {
  handleControlSocket(sock.ws, sessionId, who(sessionId, participantId))
}

/** Список файлов, который получил этот сокет; `null` — не получил вовсе. */
function files(sock: Fake): string[] | null {
  for (let i = sock.heard.length - 1; i >= 0; i--) {
    const m = sock.heard[i]
    if (m.t === 'files') return m.files.map((f) => f.path).sort()
  }
  return null
}

/** Чернила, которые получил этот сокет. */
function ink(sock: Fake): number {
  for (let i = sock.heard.length - 1; i >= 0; i--) {
    const m = sock.heard[i]
    if (m.t === 'ink') return m.strokes.length
  }
  return -1
}

test('дерево из кэша — но новый файл видит следующий вошедший', () => {
  const id = room()
  const first = socket()
  enter(first, id, 'p_1')
  assert.deepEqual(files(first), [], 'пустая комната — пустой список, а не молчание')

  // Второй сокет в том же окне: тот же кадр, собранный один раз.
  const second = socket()
  enter(second, id, 'p_2')
  assert.deepEqual(files(second), [])

  // Файл завели через пульт — рассылка считает дерево заново и кладёт свежее.
  dispatch(first.ws, id, who(id, 'p_1'), { t: 'tree:new', path: 'разбор.py' })
  const third = socket()
  enter(third, id, 'p_3')
  assert.deepEqual(files(third), ['разбор.py'], 'вошедший получил дерево до правки')
  // И всей комнате — тем же кадром рассылки.
  assert.deepEqual(files(second), ['разбор.py'])
  closeControlRoom(id)
})

test('чернила из кэша — но дорисованный штрих видит следующий вошедший', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  addInk(id, { id: 's1', page: 1, color: '#000', width: 2, points: [1, 1, 2, 2] })

  const first = socket()
  enter(first, id, 'p_1')
  assert.equal(ink(first), 1)

  const second = socket()
  enter(second, id, 'p_2')
  assert.equal(ink(second), 1, 'опоздавший не увидел того, что уже нарисовано')

  // Штрих на ТОЙ ЖЕ странице — тот, ради которого кэш и обязан устаревать.
  // Соседняя страница в этом кадре больше не едет вовсе: про неё говорит опись
  // (`ink:pages`), и вкладка спрашивает её отдельно — см. lecture-ink-server.
  addInk(id, { id: 's2', page: 1, color: '#000', width: 2, points: [3, 3, 4, 4] })
  const third = socket()
  enter(third, id, 'p_3')
  assert.equal(ink(third), 2, 'вошедшему уехали вчерашние чернила')

  stopLecture(id)
  closeControlRoom(id)
})

