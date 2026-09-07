/**
 * Постраничные чернила лекции — серверная половина.
 *
 * Чернила ездили одной мерой: ВСЕ страницы лекции одним кадром в
 * приветственной пачке. Двадцать минут письма — около мегабайта на сокет, а
 * смотрит вошедший одну страницу; после сбоя Wi-Fi зал возвращается весь сразу,
 * и мегабайт умножается на пятьсот (аудит · core-9). Теперь пачка везёт
 * страницу, которую показывает ведущий, и ОПИСЬ остальных (`ink:pages`), а
 * недостающее вкладка спрашивает (`ink:page`).
 *
 * Вкладка проверена отдельно (lecture-ink-page), и там же сказано, чего она
 * ждёт от сервера. Здесь — ровно эти обещания, и каждое из них такое, что без
 * него чернила гаснут молча:
 *
 *  • пачка не возит чужие страницы, но и не молчит о них;
 *  • опись — «есть хоть один штрих», тем же правилом, что и на вкладке
 *    (shared/lecture.ts · `inkPagesOf`), иначе стёртая страница остаётся
 *    лишним листом в ленте и вопросом про чернила, которых нет;
 *  • на вопрос отвечают всегда, и пустой ответ — тоже ответ;
 *  • перелистывание ведущего досылает разметку САМО: иначе каждое из них
 *    собирает пятьсот вопросов — тот самый круг рассылки, ради которого пачку
 *    и обрезали;
 *  • кэш кадра помнит страницу, а не только номер перемены.
 *
 * Ни сети, ни браузера: сокет поддельный, комната настоящая.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import {
  addInk,
  clearInk,
  eraseInk,
  inkOf,
  inkedPagesOf,
  inkPageOf,
  startLecture,
  stopLecture,
} from '../server/src/lecture.js'
import { makeFile } from '../server/src/workspace.js'
import { inkPagesOf } from '../shared/lecture.js'
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
      // Строкой или байтами: кадр чернил собирается раз на комнату и уходит
      // уже закодированным (control.ts · sendFrame).
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
  const id = `ink-page-${++rooms}`
  createSession(id, 'Лекция', null)
  setRules(id, { ...OPEN_ROOM })
  return id
}

function who(sessionId: string, participantId: string): TokenPayload {
  return { sessionId, participantId, role: 'host' }
}

function enter(sock: Fake, sessionId: string, participantId: string): void {
  handleControlSocket(sock.ws, sessionId, who(sessionId, participantId))
}

function draw(sessionId: string, page: number, id: string): void {
  addInk(sessionId, { id, page, color: '#101a33', width: 0.004, points: [0, 0, 0.1, 0.1] })
}

/** Полный кадр чернил, который получил этот сокет: страницы его штрихов. */
function inkPages(sock: Fake): number[] | null {
  for (let i = sock.heard.length - 1; i >= 0; i--) {
    const m = sock.heard[i]
    if (m.t === 'ink') return m.strokes.map((stroke) => stroke.page)
  }
  return null
}

/** Последняя опись, которую получил этот сокет; `null` — не получал вовсе. */
function listed(sock: Fake): number[] | null {
  for (let i = sock.heard.length - 1; i >= 0; i--) {
    const m = sock.heard[i]
    if (m.t === 'ink:pages') return m.pages
  }
  return null
}

/** Все страничные кадры, которые получил этот сокет, по порядку. */
function pageFrames(sock: Fake): { page: number; strokes: number }[] {
  const out: { page: number; strokes: number }[] = []
  for (const m of sock.heard) {
    if (m.t === 'ink:page') out.push({ page: m.page, strokes: m.strokes.length })
  }
  return out
}

test('приветственная пачка везёт показываемую страницу — и опись остальных', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 1, 's1')
  draw(id, 2, 's2')
  draw(id, 2, 's3')
  draw(id, -1, 's4')

  const first = socket()
  enter(first, id, 'p_1')
  assert.deepEqual(inkPages(first), [1], 'вошедшему уехали чужие страницы')
  assert.deepEqual(listed(first), [-1, 1, 2], 'без описи вкладка не знает, чего ей не хватает')

  // Ведущий перевёл зал на вторую — следующий вошедший получает уже её.
  dispatch(first.ws, id, who(id, 'p_1'), { t: 'lecture:page', page: 2 })
  const second = socket()
  enter(second, id, 'p_2')
  assert.deepEqual(inkPages(second), [2, 2], 'кэш кадра не заметил смены страницы')
  assert.deepEqual(listed(second), [-1, 1, 2])

  stopLecture(id)
  closeControlRoom(id)
})

test('кадр страницы собирается один на всех, но устаревает от нового штриха', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 1, 's1')

  const first = socket()
  enter(first, id, 'p_1')
  assert.deepEqual(inkPages(first), [1])

  const second = socket()
  enter(second, id, 'p_2')
  assert.deepEqual(inkPages(second), [1], 'второму в том же окне уехало не то же самое')

  draw(id, 1, 's2')
  const third = socket()
  enter(third, id, 'p_3')
  assert.deepEqual(inkPages(third), [1, 1], 'вошедшему уехали вчерашние чернила')

  stopLecture(id)
  closeControlRoom(id)
})

test('опись — страницы с хотя бы одним штрихом, тем же правилом, что на вкладке', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 3, 's1')
  draw(id, 1, 's2')
  draw(id, 3, 's3')
  assert.deepEqual(inkedPagesOf(id), [1, 3], 'опись не по возрастанию или с повторами')
  assert.deepEqual(inkedPagesOf(id), inkPagesOf(inkOf(id)), 'две меры исписанной страницы')

  // Ластик снял последний штрих страницы: ключ в памяти комнаты остался, а
  // страница исписанной быть перестала — иначе пульт держит лишний лист и
  // спрашивает чернила, которых нет.
  assert.equal(eraseInk(id, 1, 's2'), true)
  assert.deepEqual(inkedPagesOf(id), [3])
  assert.deepEqual(inkedPagesOf(id), inkPagesOf(inkOf(id)))

  assert.deepEqual(inkedPagesOf('лекции-нет'), [])
  assert.deepEqual(inkPageOf('лекции-нет', 1), [])

  stopLecture(id)
})

test('на вопрос про страницу отвечают спрашивающему — и пустой ответ тоже ответ', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 2, 's1')
  draw(id, 2, 's2')

  const asker = socket()
  enter(asker, id, 'p_2')
  const other = socket()
  enter(other, id, 'p_3')
  const heardBefore = other.heard.length

  // Спрашивает НЕ ведущий: чернила видит вся комната, а не только пульт.
  const student: TokenPayload = { sessionId: id, participantId: 'p_2', role: 'participant' }
  dispatch(asker.ws, id, student, { t: 'ink:page', page: 2 })
  assert.deepEqual(pageFrames(asker), [{ page: 2, strokes: 2 }])
  assert.equal(other.heard.length, heardBefore, 'ответ на чужой вопрос уехал всей комнате')

  // Чистый лист: пустой список — это «страница чистая», и по нему вкладка
  // закрывает вопрос. Молчание оставило бы её ждать чернил до конца лекции.
  dispatch(asker.ws, id, who(id, 'p_2'), { t: 'ink:page', page: -1 })
  assert.deepEqual(pageFrames(asker).at(-1), { page: -1, strokes: 0 })

  // Мусор из вкладки: `Number` даёт NaN, а `JSON.stringify` пишет его `null` —
  // такой ответ вкладка приняла бы за ответ про свою страницу.
  const before = pageFrames(asker).length
  dispatch(asker.ws, id, who(id, 'p_2'), {
    t: 'ink:page',
    page: 'вторая',
  } as unknown as { t: 'ink:page'; page: number })
  assert.equal(pageFrames(asker).length, before)

  stopLecture(id)
  closeControlRoom(id)
})

test('перелистывание ведущего досылает разметку само — залу, а не по вопросу', () => {
  const id = room()
  startLecture(id, { file: 'лекция.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 5, 's1')

  const hall = socket()
  enter(hall, id, 'p_2')
  const before = pageFrames(hall).length

  dispatch(hall.ws, id, who(id, 'p_2'), { t: 'lecture:page', page: 5 })
  assert.equal(pageFrames(hall).length, before, 'страницу двигает не тот, кто ведёт')

  dispatch(hall.ws, id, who(id, 'p_1'), { t: 'lecture:page', page: 5 })
  assert.deepEqual(pageFrames(hall).at(-1), { page: 5, strokes: 1 })

  // И на чистую страницу — тоже: пустой кадр стоит десятки байт, а его
  // отсутствие вкладка ждёт полсекунды и потом спрашивает сама, все пятьсот.
  dispatch(hall.ws, id, who(id, 'p_1'), { t: 'lecture:page', page: 6 })
  assert.deepEqual(pageFrames(hall).at(-1), { page: 6, strokes: 0 })

  stopLecture(id)
  closeControlRoom(id)
})

test('опись едет рядом с каждым полным кадром чернил: начало лекции и «стереть»', () => {
  const id = room()
  makeFile(id, 'первая.pdf', '%PDF-1.4')
  makeFile(id, 'вторая.pdf', '%PDF-1.4')
  startLecture(id, { file: 'первая.pdf', by: 'p_1', byName: 'Ада', color: '#c273e6' })
  draw(id, 1, 's1')
  draw(id, 4, 's2')

  const hall = socket()
  enter(hall, id, 'p_2')
  assert.deepEqual(listed(hall), [1, 4])

  // Стёрли страницу — опись убавилась.
  dispatch(hall.ws, id, who(id, 'p_1'), { t: 'ink:clear', page: 4 })
  assert.deepEqual(listed(hall), [1], 'стёртая страница осталась в описи лишним листом')

  // Стёрли всё — опись пустая.
  dispatch(hall.ws, id, who(id, 'p_1'), { t: 'ink:clear' })
  assert.deepEqual(listed(hall), [])

  // Новая лекция: пустой кадр чернил и пустая опись рядом с ним — опись живёт
  // у вкладки дольше чернил, и от прошлой лекции в ленте остались бы листы.
  draw(id, 2, 's3')
  dispatch(hall.ws, id, who(id, 'p_1'), { t: 'lecture:start', file: 'вторая.pdf' })
  assert.deepEqual(inkPages(hall), [], 'начатая лекция не стёрла чернила у зала')
  assert.deepEqual(listed(hall), [])

  clearInk(id)
  stopLecture(id)
  closeControlRoom(id)
})
