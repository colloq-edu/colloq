/**
 * Что бан делает, кроме закрытой двери.
 *
 * Дверь — это половина: забанили того, кто уже сидит внутри и прямо сейчас
 * пишет в общую ленту. Значит, надо убрать написанное, оборвать то, что ему
 * дописывает модель, и выставить его из комнаты — не тронув остальных
 * девятнадцать, у которых идёт пара.
 *
 * И три вещи, которые ломаются молча. Вычистка, взявшая лишнюю запись, стирает
 * чужой вопрос с ответом на две страницы. Вычистка без отметки в истории стирает
 * его насовсем — вернуть ленту из документа больше нечем. А выселение,
 * закрывшее сокет раньше кадра, показывает человеку «нет соединения» вместо
 * причины и срока, и вкладка молча уходит стучаться обратно.
 *
 * Ни сети, ни ядра: сокеты поддельные, комната настоящая.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import * as Y from 'yjs'
import { WebSocket } from 'ws'
import { createChatEntry, getChat } from '../shared/notebook.js'
import {
  createSession,
  listStoryVersions,
  updatesUpTo,
  upsertParticipant,
} from '../server/src/db.js'
import { banFor } from '../server/src/bans.js'
import {
  getSessionDoc,
  handleCollabSocket,
  onlineCount,
  shutdownCollab,
} from '../server/src/collab/index.js'
import { closeControlRoom, evictBanned, handleControlSocket } from '../server/src/control.js'
import { purgeQuestions } from '../server/src/routes/ai.js'
import { banRoutes } from '../server/src/routes/bans.js'
import { signToken } from '../server/src/auth.js'
import type { ControlServerMessage } from '../shared/protocol.js'

after(() => shutdownCollab())

let seq = 0

interface Room {
  id: string
  /** Ада — ведущая по хост-токену: роль ей даёт `roleFor`, а не токен запроса. */
  teacher: string
  /** Петя — тот, кого сейчас закроют. */
  loud: string
  /** Мария — та, кого происходящее не касается вовсе. */
  quiet: string
}

/**
 * Комната с преподавателем, крикуном и той, кто спрашивает по делу.
 *
 * Идентификаторы участников — сквозные по всей базе (`participants.id` —
 * первичный ключ), поэтому у каждой комнаты они свои. Одинаковые `p_loud` в
 * двух комнатах — это ОДНА строка, привязанная к первой из них, и тест на
 * второй комнате молча проверял бы пустоту.
 */
function room(): Room {
  const n = seq++
  const id = `ban${n}`
  const at = { id, teacher: `p_teacher${n}`, loud: `p_loud${n}`, quiet: `p_quiet${n}` }
  createSession(id, 'Бан', null)
  upsertParticipant({
    id: at.teacher,
    sessionId: id,
    name: 'Ада',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  upsertParticipant({ id: at.loud, sessionId: id, name: 'Петя', avatar: null, role: 'participant' })
  upsertParticipant({
    id: at.quiet,
    sessionId: id,
    name: 'Мария',
    avatar: null,
    role: 'participant',
  })
  return at
}

/** Вопрос в ленту — той же записью, что кладёт туда оракул. */
function ask(id: string, participantId: string, question: string): string {
  const doc = getSessionDoc(id).doc
  const entry = createChatEntry({ participantId, name: participantId, color: '#7e82f0', question })
  doc.transact(() => getChat(doc).push([entry]))
  return entry.get('id') as string
}

const banLabel = 'до бана Петя'

/* ------------------------------------------------------------- вычистка */

test('вычистка убирает вопросы забаненного и не трогает чужие', () => {
  const at = room()
  ask(at.id, at.loud, 'ааааааа')
  const hers = ask(at.id, at.quiet, 'почему loss стал nan?')
  ask(at.id, at.loud, 'ещё раз ааааааа')

  const gone = purgeQuestions(at.id, { participantId: at.loud, name: 'Петя' }, at.teacher)

  assert.equal(gone, 2)
  const chat = getChat(getSessionDoc(at.id).doc)
  assert.equal(chat.length, 1, 'из ленты убрали не только его')
  assert.equal(chat.get(0).get('id'), hers)
})

test('вычистка называет момент в истории — и называет его до удаления', () => {
  const at = room()
  ask(at.id, at.loud, 'ааааааа')

  purgeQuestions(at.id, { participantId: at.loud, name: 'Петя' }, at.teacher)

  const marks = listStoryVersions(at.id, 400).filter((v) => v.kind === 'checkpoint')
  assert.equal(marks.length, 1, 'названного момента в ленте версий нет')
  assert.equal(marks[0].label, banLabel)
  // Подпись — того, кто банил: строка «до бана Петя» без имени преподавателя
  // читается как ничья правка на дюжину записей.
  assert.equal(marks[0].author_id, at.teacher)
})

test('стёртое возвращается версией', () => {
  const at = room()
  const his = ask(at.id, at.loud, 'ааааааа')
  const hers = ask(at.id, at.quiet, 'почему loss стал nan?')

  purgeQuestions(at.id, { participantId: at.loud, name: 'Петя' }, at.teacher)

  const named = listStoryVersions(at.id, 400).find((v) => v.kind === 'checkpoint')
  assert.ok(named, 'возвращаться неоткуда: момент не назван')
  const back = new Y.Doc()
  for (const update of updatesUpTo(at.id, named.seq)) Y.applyUpdate(back, update)
  const ids = getChat(back)
    .toArray()
    .map((entry) => entry.get('id') as string)
  assert.deepEqual(ids, [his, hers], 'версия «до бана» не вернула стёртые вопросы')
  back.destroy()
})

test('вычищать нечего — и в истории тогда пусто', () => {
  const at = room()
  ask(at.id, at.quiet, 'почему loss стал nan?')

  assert.equal(purgeQuestions(at.id, { participantId: at.loud, name: 'Петя' }, at.teacher), 0)
  // Иначе лента версий забивается пустыми «до бана» — по одному на каждого
  // закрытого, кто в оракула ни разу не написал.
  assert.deepEqual(
    listStoryVersions(at.id, 400).filter((v) => v.kind === 'checkpoint'),
    [],
  )
})

/* ------------------------------------------------------------- выселение */

interface Fake {
  ws: WebSocket
  heard: ControlServerMessage[]
  closed: boolean
}

/**
 * Ровно то, что читают оба провода: состояние, приём кадра и закрытие.
 *
 * Закрытие ставит `readyState`, а не только флаг, — на этом держится проверка
 * порядка: кадр, отправленный после закрытия, до `heard` уже не доедет, потому
 * что обе отправки сперва спрашивают состояние.
 */
function socket(): Fake {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const fake = {
    binaryType: 'arraybuffer',
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      // Строкой или байтами: кадры, которые сервер собирает раз на комнату
      // (рассылка, дерево, чернила), уходят уже закодированными — см.
      // control.ts · sendFrame. Настоящий сокет тут разницы не делает.
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
    close() {
      fake.readyState = WebSocket.CLOSED
      out.closed = true
      // Обработчик обязан отработать: в нём гасится сердцебиение, а без него
      // интервал переживёт тест и потащит за собой всю сюиту.
      for (const fn of handlers.get('close') ?? []) fn()
    },
  }
  const out: Fake = { ws: fake as unknown as WebSocket, heard, closed: false }
  return out
}

test('забаненный вылетает сразу — и вылетает он один', () => {
  const at = room()
  const his = socket()
  const hers = socket()
  handleControlSocket(his.ws, at.id, {
    sessionId: at.id,
    participantId: at.loud,
    role: 'participant',
  })
  handleControlSocket(hers.ws, at.id, {
    sessionId: at.id,
    participantId: at.quiet,
    role: 'participant',
  })
  const hisDoc = socket()
  const hersDoc = socket()
  handleCollabSocket(hisDoc.ws, at.id, 'participant', at.loud)
  handleCollabSocket(hersDoc.ws, at.id, 'participant', at.quiet)
  assert.equal(onlineCount(at.id), 2)

  const until = Date.now() + 24 * 60 * 60 * 1000
  evictBanned(at.id, at.loud, until)

  // Кадр — раньше закрытия: поддельный сокет после close() ничего не принимает,
  // так что «услышал» здесь означает «услышал, пока был открыт».
  assert.deepEqual(
    his.heard.filter((m) => m.t === 'banned'),
    [{ t: 'banned', until }],
    'забаненному не сказали ни причины, ни срока',
  )
  assert.ok(his.closed, 'управляющий сокет забаненного остался открытым')
  assert.ok(hisDoc.closed, 'общая тетрадь у забаненного осталась открытой')

  assert.equal(
    hers.heard.some((m) => m.t === 'banned'),
    false,
    'кадр о бане уехал всей комнате',
  )
  assert.equal(hers.closed, false, 'выселили не того')
  assert.equal(onlineCount(at.id), 1, 'из документа выпал не только он')

  closeControlRoom(at.id)
})

/* ----------------------------------------------------------- три двери */

const app = express()
app.use(express.json())
app.use(banRoutes())
const server = http.createServer(app)
after(() => server.close())

async function listening(): Promise<string> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  }
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}

/*
 * Роль в токене — всегда 'participant', и это не небрежность: `sessionAuth`
 * пересчитывает её на каждом запросе (`roleFor`), и преподавателем Аду делает
 * хост-токен в её строке, а не слово в подписи. Токен, называющий себя хостом,
 * не открыл бы ничего.
 */
function as(sessionId: string, participantId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signToken({ sessionId, participantId, role: 'participant' })}`,
    'content-type': 'application/json',
  }
}

/** То же, что спрашивают у бана дверь комнаты и каждое рукопожатие. */
const stopped = (id: string, participantId: string) => banFor(id, participantId, undefined)

test('снятие бана пускает обратно', async () => {
  const base = await listening()
  const at = room()
  ask(at.id, at.loud, 'ааааааа')

  const made = await fetch(`${base}/api/sessions/${at.id}/bans`, {
    method: 'POST',
    headers: as(at.id, at.teacher),
    body: JSON.stringify({ participantId: at.loud }),
  })
  assert.equal(made.status, 201)
  const { ban } = (await made.json()) as { ban: { id: string; name: string; byTeacher: string } }
  assert.equal(ban.name, 'Петя')
  assert.equal(ban.byTeacher, 'Ада')
  assert.ok(stopped(at.id, at.loud), 'дверь его пускает — бан не заведён')
  // И лента прибрана тем же нажатием, а не отдельной кнопкой.
  assert.equal(getChat(getSessionDoc(at.id).doc).length, 0)

  const listed = await fetch(`${base}/api/sessions/${at.id}/bans`, {
    headers: as(at.id, at.teacher),
  })
  assert.deepEqual(
    ((await listed.json()) as { bans: { name: string }[] }).bans.map((b) => b.name),
    ['Петя'],
  )

  const lifted = await fetch(`${base}/api/sessions/${at.id}/bans/${ban.id}`, {
    method: 'DELETE',
    headers: as(at.id, at.teacher),
  })
  assert.equal(lifted.status, 200)
  assert.equal(stopped(at.id, at.loud), null, 'снятый бан всё ещё держит дверь')
  // Второе снятие — уже нечего снимать, и это не молчание.
  const again = await fetch(`${base}/api/sessions/${at.id}/bans/${ban.id}`, {
    method: 'DELETE',
    headers: as(at.id, at.teacher),
  })
  assert.equal(again.status, 404)
})

test('преподавателя забанить нельзя', async () => {
  const base = await listening()
  const at = room()

  const refused = await fetch(`${base}/api/sessions/${at.id}/bans`, {
    method: 'POST',
    headers: as(at.id, at.teacher),
    body: JSON.stringify({ participantId: at.teacher }),
  })

  assert.equal(refused.status, 403)
  assert.equal(stopped(at.id, at.teacher), null, 'преподаватель запер себя снаружи')
})

test('банит преподаватель, а не всякий вошедший', async () => {
  const base = await listening()
  const at = room()
  const his = ask(at.id, at.loud, 'ааааааа')

  const refused = await fetch(`${base}/api/sessions/${at.id}/bans`, {
    method: 'POST',
    headers: as(at.id, at.quiet),
    body: JSON.stringify({ participantId: at.loud }),
  })

  assert.equal(refused.status, 403)
  assert.equal(stopped(at.id, at.loud), null)
  // И лента цела: отказ обязан случиться раньше любого последствия.
  assert.equal(getChat(getSessionDoc(at.id).doc).get(0).get('id'), his)
})
