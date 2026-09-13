/**
 * Задание консилиума: чем сервер сеет пустой лист.
 *
 * Лист студента засевался общим текстом ячейки «на момент открытия листа», и
 * это разъезжалось с заданием всякий раз, когда общий текст после открытия
 * менялся: опоздавший (или просто перезагрузивший страницу) получал в свой
 * лист не задачу, а то, что лежит в ячейке сейчас. Прежде это делал сам показ
 * — «Показать классу» переписывало ячейку чужим решением, — теперь показ
 * текста не трогает вовсе (protocol · CouncilShown), а править заготовку
 * посреди консилиума преподаватель по-прежнему вправе: ячейка его.
 *
 * Поэтому текст ячейки снимается один раз, на самом переходе замка в консилиум
 * (control.ts · `cell:lock`), и едет каждому в `CouncilMine.seed`. Проверяется
 * здесь серверная половина: что снимок берётся вовремя, что правка общей
 * ячейки его не подменяет и что переключение ручки не переписывает задание.
 * Клиентская половина — tests/notebook-council-seed.test.mts.
 *
 * Ни сети, ни ядра: сокеты поддельные, комната настоящая, диспетчер тот же.
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

test('задание снимается на переходе в консилиум и едет каждому', () => {
  const at = room()
  say(at.id, at.teacher, { t: 'cell:lock', cellId: at.cell, state: 'council' })
  assert.equal(lastMine(at.petya, at.cell)?.seed, TASK)
  closeControlRoom(at.id)
})

test('показ не трогает общий текст — и задание тем более', () => {
  /*
   * Тот самый случай, ради которого всё и написано, — только наизнанку: показ
   * БОЛЬШЕ не кладёт код Пети в общую ячейку. Проверяются оба конца: текст
   * ячейки после показа тот же, и опоздавшая Маша получает задание.
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
  assert.equal(cellSource(found!.cell).toString(), TASK, 'показ переписал общую ячейку')

  const masha = join(at.id, `${at.id}_masha`, 'Маша', 'participant')
  assert.equal(lastMine(masha, at.cell)?.seed, TASK, 'опоздавшей уехало показанное решение')
  closeControlRoom(at.id)
})

test('заготовку правит преподаватель — задание остаётся тем, с чего начали', () => {
  /*
   * Общий текст в консилиуме менять некому, кроме преподавателя, — и он вправе:
   * дописал условие, стёр подсказку. Лист опоздавшего сеется тем, с чего
   * консилиум начинали: иначе полкласса решает одну задачу, а вошедший
   * последним — другую.
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

test('переключение ручки задание не переписывает', () => {
  /*
   * Повторный `cell:lock` в то же положение — это меню замка, а не новая
   * задача. Переписывать им задание значило бы вернуть ту же подмену другой
   * дорогой: после показа галочка «студенты запускают» стирала бы задание.
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

test('пустая ячейка — пустое задание, а не отсутствие задания', () => {
  /*
   * «Напишите сами» — законный консилиум, и пустая строка здесь ЗНАНИЕ:
   * отсутствие поля клиент читает как «старый сервер» и сеет общим текстом,
   * то есть после показа — чужим решением.
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
  assert.ok(mine && 'seed' in mine, 'поле обязано присутствовать, а не отсутствовать')
  closeControlRoom(id)
})
