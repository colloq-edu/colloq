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
import { createSession } from '../server/src/db.js'
import { readText, sessionDir, writeText } from '../server/src/workspace.js'
import {
  TEXT_KEY,
  currentText,
  flushAllFiles,
  forgetFile,
  getFileDoc,
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
