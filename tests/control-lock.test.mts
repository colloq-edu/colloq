/**
 * Замок на ячейке.
 *
 * Лекция — это комната, где печатает и запускает преподаватель; замок — та одна
 * ячейка, в которой это делает зал. Здесь проверяется обе стороны сделки: что
 * поле `open` выставляет сервер и только преподавателю, и что открытая ячейка
 * открывает РОВНО себя — ни листа, ни терминала, ни законченного занятия.
 *
 * Ни сети, ни ядра: сокет поддельный, комната настоящая. Отказ обязан
 * прозвучать раньше действия, поэтому промах проверки упал бы не утверждением,
 * а попыткой сходить в несуществующий Jupyter.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setFinished, setRules } from '../server/src/db.js'
import { dispatch } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import {
  cellId,
  cellSource,
  createCell,
  createChatEntry,
  findCell,
  getCells,
  getChat,
  isCellOpen,
} from '../shared/notebook.js'
import { LECTURE_ROOM, OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import type { ControlClientMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Ровно то, что читает `send`: состояние и приём кадра. */
function socket(): { ws: WebSocket; said: string[] } {
  const said: string[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => {
      const message = JSON.parse(frame) as { t: string; message?: string }
      if (message.t === 'error') said.push(message.message ?? '')
    },
  } as unknown as WebSocket
  return { ws, said }
}

let rooms = 0

/** Комната с этими правилами — по умолчанию лекционная. */
function room(rules: Partial<RoomRules> = {}): string {
  const id = `lock-${++rooms}`
  createSession(id, 'Лекция', null)
  setRules(id, { ...LECTURE_ROOM, ...rules })
  return id
}

function who(role: 'host' | 'participant', sessionId: string): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/** Что сказал сервер в ответ на это сообщение. `null` — не сказал ничего. */
function say(
  sessionId: string,
  role: 'host' | 'participant',
  message: ControlClientMessage,
): string | null {
  const { ws, said } = socket()
  dispatch(ws, sessionId, who(role, sessionId), message)
  return said[0] ?? null
}

/** Ячейка с кодом в тетради комнаты — и её имя. */
function cell(sessionId: string, source: string): string {
  const { doc } = getSessionDoc(sessionId)
  const made = createCell('code', source)
  doc.transact(() => getCells(doc).push([made]))
  return cellId(made)
}

function opened(sessionId: string, id: string): boolean {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return found ? isCellOpen(found.cell) : false
}

/** Предложение оракула на эту ячейку — и его имя. */
function propose(sessionId: string, id: string, text: string): string {
  const { doc } = getSessionDoc(sessionId)
  const entry = createChatEntry({
    participantId: 'p_participant',
    name: 'Аня',
    color: '#c273e6',
    question: 'перепиши',
    cellId: id,
  })
  doc.transact(() => {
    entry.set('patch', text)
    entry.set('state', 'done')
    getChat(doc).push([entry])
  })
  return entry.get('id') as string
}

function sourceOf(sessionId: string, id: string): string {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return found ? cellSource(found.cell).toString() : 'нет такой'
}

function stateOf(sessionId: string, id: string): string {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return (found?.cell.get('state') as string) ?? 'нет такой'
}

/* ------------------------------------------------------------ кто открывает */

test('замок открывает преподаватель, а зал — не может даже себе', () => {
  /*
   * Поле пишет сервер, и это вся защита: напиши его браузер — право раздавала
   * бы та же рука, которой его проверяют, и «мне здесь можно» объявлял бы себе
   * тот, у кого спрашивают.
   */
  const id = room()
  const c = cell(id, 'x = 1')

  assert.match(
    say(id, 'participant', { t: 'cell:open', cellId: c, open: true }) ?? '',
    /преподавател/i,
  )
  assert.equal(opened(id, c), false, 'участник открыл себе ячейку')

  assert.equal(say(id, 'host', { t: 'cell:open', cellId: c, open: true }), null)
  assert.equal(opened(id, c), true)

  // И закрывает обратно — тем же сообщением.
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: c, open: false }), null)
  assert.equal(opened(id, c), false)
})

test('ячейки, которой в комнате нет, замок не заводит', () => {
  // Вкладка соседа живёт дольше ячейки; молчание она объяснила бы себе сама и
  // объяснила бы неверно.
  const id = room()
  assert.match(say(id, 'host', { t: 'cell:open', cellId: 'c_nope', open: true }) ?? '', /ячейки/i)
})

/* ---------------------------------------------------------------- запуск */

test('в открытой ячейке зал считает, в соседней — нет', () => {
  const id = room()
  const open = cell(id, 'открыто = 1')
  const shut = cell(id, 'закрыто = 1')
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: open, open: true }), null)

  // Прошло — и дошло до очереди: право проверяется раньше, но не вместо.
  assert.equal(say(id, 'participant', { t: 'run', cellId: open }), null)
  assert.equal(stateOf(id, open), 'queued')

  assert.match(say(id, 'participant', { t: 'run', cellId: shut }) ?? '', /teacher|преподавател/i)
  assert.equal(stateOf(id, shut), 'idle', 'закрытая ячейка всё-таки попала в очередь')
})

test('открытая ячейка открывает себя, а не лист, не файл и не оболочку', () => {
  /*
   * Замок — это одна ячейка. Run All, скрипт из дерева и команда в оболочке
   * идут по правилу `run` и остаются преподавательскими: иначе одна открытая
   * ячейка отдавала бы залу весь контейнер.
   */
  const id = room()
  const open = cell(id, 'открыто = 1')
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: open, open: true }), null)

  assert.ok(say(id, 'participant', { t: 'runAll' }), 'весь лист прошёл у участника')
  assert.ok(say(id, 'participant', { t: 'runAbove', cellId: open }), 'лист сверху прошёл')
  assert.ok(say(id, 'participant', { t: 'term:run', command: 'ls' }), 'оболочка прошла')
  assert.ok(say(id, 'participant', { t: 'file:run', path: 'train.py' }), 'скрипт прошёл')
})

test('своё из очереди убирает тот, кто его туда поставил', () => {
  /*
   * Отмена идёт по автору очереди, а не по правилу, — и замок этого не задел:
   * человек, которому открыли ячейку, поставил её сам и снимает сам. Прервать
   * и ответить на `input()` держатся на том же авторстве (`startedTheRunningCell`),
   * только на выполняющейся ячейке, до которой без ядра не добраться.
   */
  const id = room()
  const c = cell(id, 'долго = 1')
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: c, open: true }), null)
  assert.equal(say(id, 'participant', { t: 'run', cellId: c }), null)
  assert.equal(stateOf(id, c), 'queued')

  assert.equal(say(id, 'participant', { t: 'cancel', cellId: c }), null)
  assert.equal(stateOf(id, c), 'idle', 'своя ячейка не снялась с очереди')
})

test('прервать и ответить — по-прежнему про автора запуска, а не про замок', () => {
  /*
   * Ни то ни другое правилом комнаты не управляется, и отказ тому, у кого
   * ничего не считается, говорит про автора. Если бы замок разъехался с этими
   * двумя, фраза здесь сменилась бы на правило.
   */
  const id = room()
  assert.match(say(id, 'participant', { t: 'interrupt' }) ?? '', /host/i)
  assert.match(say(id, 'participant', { t: 'input', value: 'да' }) ?? '', /чья ячейка/i)
})

/* ------------------------------------------------------------ после звонка */

test('после звонка открытая ячейка не запускается и не открывается', () => {
  /*
   * Открытая ячейка — обещание комнате, что здесь ей можно; после звонка нельзя
   * нигде. Замок остаётся на месте (занятие открывают обратно одним нажатием),
   * но не действует, и нового замка в законченном занятии не поставить: пустое
   * обещание хуже отказа — по нему идут и упираются.
   */
  const id = room()
  const c = cell(id, 'x = 1')
  const other = cell(id, 'y = 2')
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: c, open: true }), null)

  setFinished(id, Date.now())
  assert.match(say(id, 'participant', { t: 'run', cellId: c }) ?? '', /Занятие закончено/)
  assert.equal(stateOf(id, c), 'idle', 'открытая ячейка запустилась после звонка')
  assert.match(
    say(id, 'host', { t: 'cell:open', cellId: other, open: true }) ?? '',
    /Занятие закончено/,
  )
  assert.equal(opened(id, other), false)

  // Занятие открыли обратно — и замок, который пережил звонок, снова работает.
  setFinished(id, null)
  assert.equal(opened(id, c), true)
  assert.equal(say(id, 'participant', { t: 'run', cellId: c }), null)
  assert.equal(stateOf(id, c), 'queued')
})

/* ------------------------------------------------------- обычная комната */

test('в открытой комнате замок ничего не меняет', () => {
  // Правило, которое отказывает всем, — не правило; и лаборатория, где считают
  // все, ничего не должна знать про замки.
  const id = room(OPEN_ROOM)
  const c = cell(id, 'x = 1')
  assert.equal(say(id, 'participant', { t: 'run', cellId: c }), null)
  assert.equal(stateOf(id, c), 'queued')
})

/* --------------------------------------------- предложение оракула в ячейке */

test('в открытой ячейке принять предложение может тот, кому её открыли', () => {
  /*
   * Замок иначе читался бы как поломка: ячейку студенту открыли, он в ней
   * печатает и запускает, спрашивает оракула — и не может нажать «принять» на
   * предложение, сделанное для этой самой ячейки. В закрытой всё как было:
   * принимает преподаватель.
   */
  const id = room()
  const open = cell(id, 'x = 1')
  const shut = cell(id, 'y = 2')
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: open, open: true }), null)

  assert.equal(
    say(id, 'participant', { t: 'ai:decide', entryId: propose(id, open, 'x = 42'), accept: true }),
    null,
    'принять в открытой ячейке не дали',
  )
  assert.equal(sourceOf(id, open), 'x = 42')

  assert.match(
    say(id, 'participant', {
      t: 'ai:decide',
      entryId: propose(id, shut, 'y = 42'),
      accept: true,
    }) ?? '',
    /преподавател/i,
  )
  assert.equal(sourceOf(id, shut), 'y = 2', 'предложение приняли в закрытую ячейку')
})
