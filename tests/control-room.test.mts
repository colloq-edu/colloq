/**
 * Что помнит путь и что переживает комнату.
 *
 * Управляющий сокет держит рядом четыре вещи, у которых нет места в общем
 * документе: список файлов, доску, лекцию и заметки спикера. Три из них знают
 * путь документа наизусть, и ломается это молча: переименовали ПАПКУ — проектор
 * показывает файл, которого нет, речь к двадцати четырём страницам осталась под
 * ключом, которого не существует, а тетрадь внутри воскрешает удалённую папку
 * своей же проекцией.
 *
 * Ни сети, ни ядра: сокет поддельный, комната настоящая. Всё, что здесь
 * проверяется, обязано случиться раньше, чем кто-нибудь что-нибудь нажмёт.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createSession, notesOf, setNote } from '../server/src/db.js'
import { makeDir, makeFile, sessionDir, statPath } from '../server/src/workspace.js'
import { boardOf, closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { addBook, bookAt } from '../shared/notebook.js'
import { addInk, inkOf, lectureOf, startLecture, stopLecture } from '../server/src/lecture.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Ровно то, что читает `send`: состояние и приём кадра. */
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
    // Закрытие обязано дойти до обработчика: в нём гасится сердцебиение, а без
    // него интервал переживёт тест и потащит за собой всю сюиту.
    close: () => {
      for (const fn of handlers.get('close') ?? []) fn()
    },
  } as unknown as WebSocket
  return { ws, heard }
}

let rooms = 0

function room(): { id: string; host: TokenPayload; ws: WebSocket } {
  const id = `ctl-room-${++rooms}`
  createSession(id, 'Управление', null)
  return { id, host: { sessionId: id, participantId: 'p_host', role: 'host' }, ws: socket().ws }
}

function say(ws: WebSocket, id: string, who: TokenPayload, message: ControlClientMessage): void {
  dispatch(ws, id, who, message)
}

/* ------------------------------------------------------- переезд папки */

test('переименование папки уводит за собой лекцию, доску и заметки', () => {
  /*
   * Двойной щелчок в панели заводит правку имени на любой строке дерева, папку
   * включая, а `movePath` переносит каталог целиком. Раньше каскад сравнивал
   * путь точно с `from`, и после переезда папки лекция продолжала называть
   * `slides/l3.pdf`: проекция гасла у всех, кроме тех, у кого документ уже был
   * открыт, а речь к нему теряла ключ.
   */
  const { id, host, ws } = room()
  makeDir(id, 'slides')
  makeFile(id, 'slides/l3.pdf', '%PDF-1.4')
  setNote(id, 'slides/l3.pdf', 7, 'спросить про поток')
  say(ws, id, host, { t: 'board:open', name: 'slides/l3.pdf' })
  startLecture(id, { file: 'slides/l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })

  say(ws, id, host, { t: 'tree:move', from: 'slides', to: 'lectures' })

  assert.ok(statPath(id, 'lectures/l3.pdf'), 'файл не переехал')
  assert.equal(lectureOf(id)?.file, 'lectures/l3.pdf', 'лекция осталась на мёртвом пути')
  assert.equal(boardOf(id), 'lectures/l3.pdf', 'доска осталась на мёртвом пути')
  assert.deepEqual(notesOf(id, 'lectures/l3.pdf'), { 7: 'спросить про поток' })
  assert.deepEqual(notesOf(id, 'slides/l3.pdf'), {}, 'заметки остались под старым ключом')

  stopLecture(id)
  closeControlRoom(id)
})

test('переименование папки уводит и тетрадь внутри неё', () => {
  // Иначе тетрадь остаётся в комнате со старым путём, и проекция через полторы
  // секунды пишет её файл обратно — рядом с переехавшим, в воскресшую папку.
  const { id, host, ws } = room()
  const { doc } = getSessionDoc(id)
  makeDir(id, 'hw')
  makeFile(id, 'hw/task.ipynb', '{}')
  addBook(doc, 'hw/task.ipynb')

  say(ws, id, host, { t: 'tree:move', from: 'hw', to: 'домашка' })

  assert.equal(bookAt(doc, 'hw/task.ipynb'), null, 'тетрадь осталась на старом пути')
  assert.ok(bookAt(doc, 'домашка/task.ipynb'), 'тетрадь не переехала за своим файлом')
  closeControlRoom(id)
})

test('удаление папки убирает и тетрадь внутри неё, и доску', () => {
  /*
   * Панель спрашивает «Убрать папку со всем, что в ней?» — и обещание держится
   * только если тетрадь уходит из комнаты вместе с папкой. Оставшись, она
   * заводила бы папку и файл заново своей же проекцией, и удаление выглядело бы
   * не сработавшим.
   */
  const { id, host, ws } = room()
  const { doc } = getSessionDoc(id)
  makeDir(id, 'hw')
  makeFile(id, 'hw/task.ipynb', '{}')
  makeFile(id, 'hw/l3.pdf', '%PDF-1.4')
  addBook(doc, 'hw/task.ipynb')
  say(ws, id, host, { t: 'board:open', name: 'hw/l3.pdf' })

  say(ws, id, host, { t: 'tree:remove', path: 'hw' })

  assert.equal(statPath(id, 'hw/task.ipynb'), null)
  assert.equal(bookAt(doc, 'hw/task.ipynb'), null, 'тетрадь пережила свою папку')
  assert.equal(boardOf(id), null, 'на экране остался файл, которого нет')
  closeControlRoom(id)
})

/* ------------------------------------------------- потолок обхода папки */

test('обрезанное дерево не гасит доску и говорит комнате, что оно неполное', () => {
  /*
   * Обход папки упирается в потолок в две тысячи строк, и `pip install -t .`
   * или распакованный датасет выедают его целиком. Пока «файла нет в списке»
   * значило «файла нет», проектор гас посреди лекции — при том, что документ
   * спокойно лежал на диске. Теперь пропажу решает один `lstat` по самому пути,
   * а комната узнаёт, что список показан не целиком.
   */
  const { id, host } = room()
  const seat = socket()
  makeFile(id, 'data.csv', 'a,b')
  // Имя на «z» — чтобы обрезка добралась именно до документа лекции: список
  // отсортирован, и режется его хвост.
  makeFile(id, 'zz.pdf', '%PDF-1.4')
  const dir = sessionDir(id)
  for (let i = 0; i < 2005; i++) fs.writeFileSync(path.join(dir, `f${i}.csv`), '')

  handleControlSocket(seat.ws, id, host)
  const welcome = seat.heard.filter((frame) => frame.t === 'files').at(-1)
  assert.equal(welcome?.truncated, true, 'комната не узнала, что дерево неполное')
  assert.ok(
    !welcome?.files.some((file) => file.path === 'zz.pdf'),
    'документ всё ещё в списке — потолок не сработал, тест ничего не проверяет',
  )

  say(seat.ws, id, host, { t: 'board:open', name: 'zz.pdf' })
  assert.equal(boardOf(id), 'zz.pdf', 'документа нет в списке — и его отказались показать')

  // Любая уборка в дереве проверяет, жив ли документ на экране.
  seat.heard.length = 0
  say(seat.ws, id, host, { t: 'tree:remove', path: 'data.csv' })
  assert.equal(boardOf(id), 'zz.pdf', 'доска погасла из-за неполного списка')
  assert.equal(
    seat.heard.filter((frame) => frame.t === 'files').at(-1)?.truncated,
    true,
    'обрезка потерялась по дороге до комнаты',
  )

  closeControlRoom(id)
})

/* ------------------------------------------------------------- указка */

test('указка без страницы не уезжает в зал', () => {
  /*
   * `page` уходил в кадр без проверки, а NaN в JSON — это `null`: зал рисовал
   * указку на своей текущей странице, хотя ведущий говорил про другую.
   */
  const { id, host } = room()
  const seat = socket()
  handleControlSocket(seat.ws, id, host)
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  dispatch(seat.ws, id, host, { t: 'laser', x: 0.5, y: 0.5 } as unknown as ControlClientMessage)
  assert.deepEqual(
    seat.heard.filter((frame) => frame.t === 'laser'),
    [],
    'кадр без страницы доехал до зала',
  )

  dispatch(seat.ws, id, host, { t: 'laser', page: 3, x: 0.5, y: 0.5 })
  assert.deepEqual(
    seat.heard.filter((frame) => frame.t === 'laser'),
    [{ t: 'laser', at: { page: 3, x: 0.5, y: 0.5, shape: 'line' } }],
  )

  stopLecture(id)
  closeControlRoom(id)
})

test('пульт ведущего пропал молча — указка гаснет у зала', () => {
  /*
   * Указка нигде не хранится и держится ровно тем, что кадры идут. Пульт на
   * iPad выгружают из памяти, не сказав «off», — и красное пятно висело на
   * слайде до конца лекции, показывая туда, где ведущий был минуту назад.
   * Гасить приходится за него; но только когда у него не осталось ни одного
   * сокета: уход второй вкладки не должен гасить пятно, которое держит первая.
   */
  const { id, host } = room()
  const seat = socket()
  const pult = socket()
  const laptop = socket()
  handleControlSocket(seat.ws, id, { sessionId: id, participantId: 'p_guest', role: 'participant' })
  handleControlSocket(pult.ws, id, host)
  handleControlSocket(laptop.ws, id, host)
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  laptop.ws.close()
  assert.deepEqual(
    seat.heard.filter((frame) => frame.t === 'laser'),
    [],
    'вторая вкладка ведущего погасила указку первой',
  )

  pult.ws.close()
  assert.deepEqual(
    seat.heard.filter((frame) => frame.t === 'laser'),
    [{ t: 'laser', at: null }],
  )

  stopLecture(id)
  closeControlRoom(id)
})

test('лекция кончилась — указка гаснет вместе с ней', () => {
  // Зал узнаёт об этом словами, а не выводом из `lecture: null`: указку рисует
  // не только тетрадь-читалка, и гадать про неё никому не полагается.
  const { id, host } = room()
  const seat = socket()
  handleControlSocket(seat.ws, id, host)
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  seat.heard.length = 0

  dispatch(seat.ws, id, host, { t: 'lecture:stop' })
  assert.deepEqual(
    seat.heard.filter((frame) => frame.t === 'laser'),
    [{ t: 'laser', at: null }],
  )

  closeControlRoom(id)
})

/* --------------------------------------------------------------- уборка */

test('удаление семинара уносит доску и чернила, даже если в комнате никого нет', () => {
  /*
   * `rooms` чистится, как только уходит последний сокет, а доска и лекция
   * намеренно переживают уход людей. Преподаватель закрыл ноутбук, не нажав
   * «Закончить», а вечером удалил семинар — и двести исписанных страниц лежали
   * в памяти процесса до перезапуска.
   */
  const { id, host, ws } = room()
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  say(ws, id, host, { t: 'board:open', name: 'l3.pdf' })
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  addInk(id, { id: 's1', page: 1, color: '#d4162f', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] })
  assert.equal(boardOf(id), 'l3.pdf')

  closeControlRoom(id)

  assert.equal(boardOf(id), null)
  assert.equal(lectureOf(id), null)
  assert.deepEqual(inkOf(id), [])
})
