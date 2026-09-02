/**
 * Стык между документом Yjs и байтами на диске.
 *
 * Пока файл открыт, правда в документе; когда закрыт — на диске. Всё, что здесь
 * проверяется, ломается тихо: текст сохраняется не туда, чужая правка стирает
 * набранное, курсор уезжает на другой конец файла, а переименованный файл
 * воскресает под старым именем через полсекунды после переименования.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import type { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { OPEN_ROOM } from '../shared/rules.js'
import { MAX_TEXT_BYTES, readText, sessionDir, writeText } from '../server/src/workspace.js'
import {
  TEXT_KEY,
  currentText,
  flushAllFiles,
  flushFile,
  flushSessionFiles,
  forgetFile,
  getFileDoc,
  handleFileSocket,
  openFileDoc,
  putText,
  spliceText,
} from '../server/src/collab/files.js'

const ROOM = 'docs-room'

function seed(name: string, text: string): void {
  const full = path.join(sessionDir(ROOM), name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text)
}

test('комната заводится', () => {
  createSession(ROOM, 'File docs', null)
})

/* ------------------------------------------------------------- склейка */

test('склейка меняет только то, что отличается', () => {
  const doc = new Y.Doc()
  const text = doc.getText(TEXT_KEY)
  text.insert(0, 'один\nдва\nтри\n')

  /*
   * Метка стоит в слове «два». Если склейка перепишет текст целиком, метка
   * уедет в начало документа — а в живом редакторе это чужой курсор, который
   * прыгнул с середины файла на первую строку от того, что ячейка дописала
   * строку в конец.
   */
  const mark = Y.createRelativePositionFromTypeIndex(text, 6)
  spliceText(text, 'один\nдва\nтри\nчетыре\n')
  assert.equal(text.toString(), 'один\nдва\nтри\nчетыре\n')
  const after = Y.createAbsolutePositionFromRelativePosition(mark, doc)
  assert.equal(after?.index, 6, 'метка съехала, хотя её кусок текста не менялся')
})

test('склейка ничего не делает, когда текст тот же', () => {
  const doc = new Y.Doc()
  const text = doc.getText(TEXT_KEY)
  text.insert(0, 'x = 1\n')
  let updates = 0
  doc.on('update', () => (updates += 1))
  assert.equal(spliceText(text, 'x = 1\n'), false)
  assert.equal(updates, 0, 'пустая правка всё-таки уехала бы в комнату и в историю')
})

test('склейка переживает полную замену', () => {
  const doc = new Y.Doc()
  const text = doc.getText(TEXT_KEY)
  text.insert(0, 'старое целиком')
  spliceText(text, 'новое целиком')
  assert.equal(text.toString(), 'новое целиком')
  spliceText(text, '')
  assert.equal(text.toString(), '')
  spliceText(text, 'снова текст')
  assert.equal(text.toString(), 'снова текст')
})

/* ------------------------------------------------------ документ файла */

test('документ заводится из диска', () => {
  seed('train.py', 'print(1)\n')
  const entry = getFileDoc(ROOM, 'train.py')
  assert.ok(entry)
  assert.equal(entry.doc.getText(TEXT_KEY).toString(), 'print(1)\n')
})

test('второй раз открывается тот же документ, а не второй его экземпляр', () => {
  const first = getFileDoc(ROOM, 'train.py')
  const second = getFileDoc(ROOM, 'train.py')
  assert.equal(first, second, 'две вкладки печатали бы в разные копии одного файла')
})

test('правка документа доезжает до диска', () => {
  const entry = getFileDoc(ROOM, 'train.py')
  assert.ok(entry)
  entry.doc.getText(TEXT_KEY).insert(0, '# заголовок\n')
  // Сохранение отложено на семьсот миллисекунд; тест не ждёт их, а просит
  // дописать всё немедленно — тем же путём, каким это делает остановка процесса.
  flushAllFiles()
  assert.equal(readText(ROOM, 'train.py')?.text, '# заголовок\nprint(1)\n')
})

test('«сохрани сейчас» доносит один открытый файл до диска', () => {
  /*
   * Запуск и переименование не вправе ждать паузы в наборе: `python` читает
   * диск, а `forgetFile` уносит документ вместе с отложенной записью.
   */
  seed('run-me.py', 'x = 1\n')
  const entry = getFileDoc(ROOM, 'run-me.py')
  assert.ok(entry)
  entry.doc.getText(TEXT_KEY).insert(0, '# последняя строка\n')
  flushFile(ROOM, 'run-me.py')
  assert.equal(readText(ROOM, 'run-me.py')?.text, '# последняя строка\nx = 1\n')

  // Файла, который никто не открывал, это не касается — и не заводит его.
  flushFile(ROOM, 'never-open.py')
  assert.equal(fs.existsSync(path.join(sessionDir(ROOM), 'never-open.py')), false)
})

test('«сохрани сейчас» комнаты не трогает файлы соседней', () => {
  /*
   * Карта открытых файлов одна на весь процесс, а ячейку запускают в одной
   * комнате. Без этой границы каждый запуск в одной паре дописывал бы
   * недонабранное во всех остальных — и делал это в самый неподходящий момент.
   */
  const other = 'docs-room-next-door'
  createSession(other, 'Соседняя комната', null)
  fs.writeFileSync(path.join(sessionDir(other), 'notes.md'), 'заметка\n')
  seed('mine.py', 'x = 1\n')
  const mine = getFileDoc(ROOM, 'mine.py')
  const theirs = getFileDoc(other, 'notes.md')
  assert.ok(mine)
  assert.ok(theirs)
  mine.doc.getText(TEXT_KEY).insert(0, '# моё\n')
  theirs.doc.getText(TEXT_KEY).insert(0, '# чужое\n')
  flushSessionFiles(ROOM)
  assert.equal(readText(ROOM, 'mine.py')?.text, '# моё\nx = 1\n')
  assert.equal(readText(other, 'notes.md')?.text, 'заметка\n', 'дописали чужую комнату')
  flushAllFiles()
})

test('двоичный файл не открывается вовсе', () => {
  fs.writeFileSync(path.join(sessionDir(ROOM), 'model.pkl'), Buffer.from([0x80, 0x00, 0x04]))
  assert.equal(getFileDoc(ROOM, 'model.pkl'), null)
})

test('несуществующий файл не заводится пустым', () => {
  // Иначе открытая вкладка создавала бы файл самим фактом открытия — и папка
  // семинара наполнялась бы пустыми файлами от одних промахов по дереву.
  assert.equal(getFileDoc(ROOM, 'no-such-file.py'), null)
  assert.equal(fs.existsSync(path.join(sessionDir(ROOM), 'no-such-file.py')), false)
})

test('запись от имени сервера идёт в открытый документ, а не мимо него', () => {
  const entry = getFileDoc(ROOM, 'train.py')
  assert.ok(entry)
  putText(ROOM, 'train.py', 'print(2)\n')
  assert.equal(
    entry.doc.getText(TEXT_KEY).toString(),
    'print(2)\n',
    'оракул написал на диск мимо редактора — тот показывал бы старое',
  )
  assert.equal(readText(ROOM, 'train.py')?.text, 'print(2)\n')
})

test('запись в закрытый файл идёт прямо на диск', () => {
  seed('closed.py', 'a = 1\n')
  assert.equal(putText(ROOM, 'closed.py', 'a = 2\n'), true)
  assert.equal(readText(ROOM, 'closed.py')?.text, 'a = 2\n')
  assert.equal(currentText(ROOM, 'closed.py'), 'a = 2\n')
})

test('забытый файл больше не пишется на диск', () => {
  /*
   * Переименование и удаление зовут `forgetFile`. Без этого документ пережил бы
   * собственный файл: отложенное сохранение через полсекунды воскресило бы его
   * под прежним именем, и переименование отменилось бы само.
   */
  seed('doomed.py', 'x = 1\n')
  const entry = getFileDoc(ROOM, 'doomed.py')
  assert.ok(entry)
  entry.doc.getText(TEXT_KEY).insert(0, '# не должно уцелеть\n')
  fs.rmSync(path.join(sessionDir(ROOM), 'doomed.py'))
  forgetFile(ROOM, 'doomed.py')
  flushAllFiles()
  assert.equal(fs.existsSync(path.join(sessionDir(ROOM), 'doomed.py')), false)
})

test('чужая запись на диск доезжает до открытого документа', async () => {
  seed('watched.py', 'первая строка\n')
  const entry = getFileDoc(ROOM, 'watched.py')
  assert.ok(entry)
  // Ячейка дописала строку: `open('watched.py','a')` в том же контейнере.
  // Время изменения на некоторых файловых системах округляется до секунды, так
  // что отпечаток должен ловить и размер тоже — здесь меняются оба.
  writeText(ROOM, 'watched.py', 'первая строка\nвторая строка\n')
  await new Promise((resolve) => setTimeout(resolve, 2_400))
  assert.equal(entry.doc.getText(TEXT_KEY).toString(), 'первая строка\nвторая строка\n')
})

test('склейка не режет суррогатную пару пополам', () => {
  /*
   * У соседних эмодзи старшая половина общая, и граница общей головы встаёт
   * ровно посередине пары. Yjs подменяет разорванную половину на U+FFFD, а по
   * дороге к браузерам одиночный суррогат становится ещё одним — сервер и
   * клиенты расходятся навсегда, и порча уходит на диск.
   */
  const doc = new Y.Doc()
  const text = doc.getText(TEXT_KEY)
  text.insert(0, 'x = "\u{1F600}"\n')
  spliceText(text, 'x = "\u{1F601}"\n')
  assert.equal(text.toString(), 'x = "\u{1F601}"\n')
  const other = new Y.Doc()
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
  assert.equal(
    other.getText(TEXT_KEY).toString(),
    'x = "\u{1F601}"\n',
    'у соседа в редакторе оказался другой текст',
  )

  // И то же самое с хвоста: у этих двух общая младшая половина.
  const tailDoc = new Y.Doc()
  const tail = tailDoc.getText(TEXT_KEY)
  tail.insert(0, 'a\u{1F600}')
  spliceText(tail, 'b\u{1FA00}')
  assert.equal(tail.toString(), 'b\u{1FA00}')
})

/* --------------------------------------------------------------- потолок */

test('файл больше потолка не отдаётся началом и не переписывается обрезком', () => {
  // Три мегабайта метрик: редактор такой не открывает, а оракул в режиме
  // «сделать» брал его начало за файл целиком и клал это начало на его место.
  const whole = 'a,b\n' + 'x'.repeat(MAX_TEXT_BYTES) + 'ХВОСТ\n'
  seed('metrics.csv', whole)
  assert.equal(currentText(ROOM, 'metrics.csv'), null, 'начало файла выдали за файл')
  assert.equal(putText(ROOM, 'metrics.csv', 'a,b\n1,2\n'), false)
  assert.equal(readText(ROOM, 'metrics.csv')?.size, Buffer.byteLength(whole), 'хвост срезали')
})

test('putText отвечает «нет», когда текст в потолок не помещается', () => {
  // Раньше здесь было «да»: документ принимал текст, сохранение молча
  // отказывало по потолку, а оракул рапортовал «Готово» при нетронутом файле.
  seed('grows.py', 'x = 1\n')
  const entry = getFileDoc(ROOM, 'grows.py')
  assert.ok(entry)
  assert.equal(putText(ROOM, 'grows.py', 'y'.repeat(MAX_TEXT_BYTES + 1)), false)
  assert.equal(
    entry.doc.getText(TEXT_KEY).toString(),
    'x = 1\n',
    'в документе остался текст, которого никогда не будет на диске',
  )
  assert.equal(readText(ROOM, 'grows.py')?.text, 'x = 1\n')

  // И в файл, которого никто не открывал: потолком мерили старый файл на диске,
  // а не новый текст, — на диске заводился файл, который потом не открыть ни
  // редактором, ни следующим шагом того же оракула.
  assert.equal(putText(ROOM, 'huge-new.py', 'y'.repeat(MAX_TEXT_BYTES + 1)), false)
  assert.equal(fs.existsSync(path.join(sessionDir(ROOM), 'huge-new.py')), false)
})

test('файл, выросший за потолок под открытым редактором, не переписывается старым текстом', async () => {
  seed('train.log', 'первая строка\n')
  const entry = getFileDoc(ROOM, 'train.log')
  assert.ok(entry)
  const socket = fakeSocket()
  handleFileSocket(socket.ws, ROOM, 'train.log', 'host', 'p_host')
  // Обучающий скрипт дописывает лог, и файл перешагивает потолок.
  fs.writeFileSync(
    path.join(sessionDir(ROOM), 'train.log'),
    'первая строка\n' + 'x'.repeat(MAX_TEXT_BYTES),
  )
  await new Promise((resolve) => setTimeout(resolve, 2_400))
  assert.equal(
    openFileDoc(ROOM, 'train.log'),
    null,
    'документ остался жить на тексте, каким файл был при открытии',
  )
  assert.equal(
    socket.closed?.code,
    4413,
    'вкладку закрыли как на пропавший файл — человеку сказали бы, что лога больше нет',
  )
  flushAllFiles()
  const size = readText(ROOM, 'train.log')?.size ?? 0
  assert.ok(size > MAX_TEXT_BYTES, `лог обрезали до ${size} байт`)
})

/* ------------------------------------------------------ файл уехал мимо */

test('переименованная ПАПКА не возвращается вместе с открытым в ней файлом', () => {
  seed('src/model.py', 'x = 1\n')
  const entry = getFileDoc(ROOM, 'src/model.py')
  assert.ok(entry)
  entry.doc.getText(TEXT_KEY).insert(0, '# правка студента\n')
  // Преподаватель переименовал в дереве папку: `forgetFile` зовут для неё, а
  // документы лежат под путями файлов внутри.
  fs.renameSync(path.join(sessionDir(ROOM), 'src'), path.join(sessionDir(ROOM), 'lib'))
  forgetFile(ROOM, 'src')
  flushAllFiles()
  assert.equal(
    fs.existsSync(path.join(sessionDir(ROOM), 'src')),
    false,
    'папка вернулась через полсекунды, и переименование отменилось само',
  )
})

test('файл, уехавший мимо дерева, не воскресает следующим сохранением', () => {
  seed('draft.py', 'x = 1\n')
  const entry = getFileDoc(ROOM, 'draft.py')
  assert.ok(entry)
  // `mv draft.py final.py` в общем терминале: сервер про это не знает вовсе.
  fs.renameSync(path.join(sessionDir(ROOM), 'draft.py'), path.join(sessionDir(ROOM), 'final.py'))
  entry.doc.getText(TEXT_KEY).insert(0, '# ещё строка\n')
  flushAllFiles()
  assert.equal(
    fs.existsSync(path.join(sessionDir(ROOM), 'draft.py')),
    false,
    'в комнате две расходящиеся копии, и переименование выглядит отменившимся',
  )
})

/* ----------------------------------------------------------- гейт файла */

/**
 * Сокет с записанными кадрами вместо настоящего.
 *
 * Гейт файла проверяется здесь, а не через сеть, потому что проверять надо
 * ровно одно: что пустой ответ клиента на серверный шаг 1 не считается правкой.
 */
function fakeSocket() {
  const handlers = new Map<string, (arg?: unknown) => void>()
  const sent: Uint8Array[] = []
  let closed: { code: number; reason: string } | null = null
  const ws = {
    readyState: 1,
    binaryType: '',
    on(event: string, handler: (arg?: unknown) => void) {
      handlers.set(event, handler)
      return ws
    },
    ping() {},
    send(message: Uint8Array, cb?: (err?: Error) => void) {
      sent.push(message)
      cb?.()
    },
    close(code: number, reason: string) {
      closed ??= { code, reason }
      ws.readyState = 3
    },
  }
  return {
    ws: ws as unknown as WebSocket,
    sent,
    get closed() {
      return closed
    },
    message(frame: Uint8Array) {
      handlers.get('message')?.(frame)
    },
  }
}

function syncFrame(subtype: number, update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0 /* MESSAGE_SYNC */)
  encoding.writeVarUint(encoder, subtype)
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

test('в комнате с files: host студент читает файл, а не получает отказ на рукопожатии', () => {
  /*
   * Сервер шлёт шаг 1 сам, и y-websocket отвечает на него шагом 2 ВСЕГДА —
   * даже пустым. Отказ по подтипу кадра рвал это рукопожатие: студент видел
   * «Правку не приняли — дальше только чтение», ничего не написав, и файл у
   * него замирал на снимке момента открытия.
   */
  const id = 'files-host'
  createSession(id, 'Файлы преподавательские', null)
  setRules(id, { ...OPEN_ROOM, files: 'host' })
  fs.writeFileSync(path.join(sessionDir(id), 'train.py'), 'x = 1\n')

  const socket = fakeSocket()
  handleFileSocket(socket.ws, id, 'train.py', 'participant', 'p_student')
  assert.ok(socket.sent.length > 0, 'сервер не прислал шаг 1')
  socket.message(syncFrame(1 /* SYNC_STEP2 */, Y.encodeStateAsUpdate(new Y.Doc())))
  const afterHandshake = socket.closed
  assert.equal(afterHandshake, null, 'студенту отказали в его же пустом ответе')

  // А настоящая правка в такой комнате по-прежнему не проходит.
  const client = new Y.Doc()
  client.getText(TEXT_KEY).insert(0, '# правка студента\n')
  socket.message(syncFrame(2 /* SYNC_UPDATE */, Y.encodeStateAsUpdate(client)))
  assert.equal(socket.closed?.code, 4403, 'правку приняли у того, кому файлы править нельзя')
  assert.equal(readText(id, 'train.py')?.text, 'x = 1\n')
})

/* --------------------------------------------------- чем закрывается сокет */

test('файлу больше потолка сокет отвечает своим кодом, а не «файла нет»', () => {
  /*
   * 4404 клиент читает как пропажу и закрывает вкладку молча: нажатие по
   * трёхмегабайтному CSV выглядело вкладкой, которая мигнула и исчезла, ничего
   * не сказав. Отдельный код — единственное, чем ей можно объяснить, что файл
   * на месте, просто велик для редактора.
   */
  seed('dataset.csv', 'a,b\n' + 'x'.repeat(MAX_TEXT_BYTES))
  const big = fakeSocket()
  handleFileSocket(big.ws, ROOM, 'dataset.csv', 'host', 'p_host')
  assert.equal(big.closed?.code, 4413, 'большой файл выдали за пропавший')

  // А пропажа остаётся пропажей: закрывать вкладку на файл, которого нет, — верно.
  const ghost = fakeSocket()
  handleFileSocket(ghost.ws, ROOM, 'ghost.py', 'host', 'p_host')
  assert.equal(ghost.closed?.code, 4404)
})
