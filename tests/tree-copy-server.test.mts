/**
 * Дублирование файла — четвёртый глагол дерева рядом с «завести», «переехать»
 * и «убрать».
 *
 * Ломается оно теми же способами, что и соседи, и ещё одним своим: копия — это
 * ЗАПИСЬ на диск, которой никто не заказывал размера. Поэтому здесь про право
 * (копия добавляет, значит правило `files`, а не роль), про имя (занятое —
 * обычное дело, а не отказ), про границы папки занятия и про оба потолка:
 * на один файл и на комнату целиком.
 *
 * Ни сети, ни ядра: сокет поддельный, комната настоящая — тот же приём, что в
 * `tree-move-server.test.mts`.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import {
  freeCopyName,
  listFiles,
  makeDir,
  makeFile,
  readText,
  resolveInSession,
  sessionDir,
  statPath,
} from '../server/src/workspace.js'
import { closeControlRoom, dispatch } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { addBook, bookAt, bookCells, createCell } from '../shared/notebook.js'
import { config } from '../server/src/config.js'
import { setLocaleResolver } from '../shared/i18n.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Ровно то, что читает `send`: состояние и приём кадра. */
function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => heard.push(JSON.parse(frame) as ControlServerMessage),
    on() {
      return this
    },
    ping: () => {},
    terminate: () => {},
    close: () => {},
  } as unknown as WebSocket
  return { ws, heard }
}

let rooms = 0

function room(): string {
  const id = `copy-${++rooms}`
  createSession(id, 'Копия', null)
  return id
}

function who(sessionId: string, role: 'host' | 'participant'): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/** Что сервер сказал в ответ; `null` — не сказал ничего. */
function say(
  sessionId: string,
  role: 'host' | 'participant',
  message: ControlClientMessage,
): string | null {
  const { ws, heard } = socket()
  dispatch(ws, sessionId, who(sessionId, role), message)
  const refusal = heard.find(
    (frame): frame is Extract<ControlServerMessage, { t: 'error' }> => frame.t === 'error',
  )
  return refusal?.message ?? null
}

/* ------------------------------------------------------------ имя копии */

test('копия называется копией, а следующая — второй: имя видит человек', () => {
  const id = room()
  makeFile(id, 'train.py', 'x = 1\n')

  assert.equal(say(id, 'host', { t: 'tree:copy', path: 'train.py' }), null)
  assert.ok(statPath(id, 'train (копия).py'), 'копии нет рядом с оригиналом')
  assert.ok(statPath(id, 'train.py'), 'оригинал пропал — это не копирование')

  assert.equal(say(id, 'host', { t: 'tree:copy', path: 'train.py' }), null)
  assert.ok(statPath(id, 'train (копия 2).py'), 'вторая копия не получила своего номера')
  closeControlRoom(id)
})

test('расширение остаётся расширением, а имя без точки остаётся именем', () => {
  const id = room()
  makeFile(id, 'данные.tar.gz', 'x')
  makeFile(id, 'Makefile', 'all:\n')

  say(id, 'host', { t: 'tree:copy', path: 'данные.tar.gz' })
  say(id, 'host', { t: 'tree:copy', path: 'Makefile' })

  // Точка берётся ПОСЛЕДНЯЯ: «данные.tar (копия).gz» открывался бы архиватором,
  // а «данные.tar.gz (копия)» — ничем.
  assert.ok(statPath(id, 'данные.tar (копия).gz'), 'копия архива названа не так')
  assert.ok(statPath(id, 'Makefile (копия)'), 'файлу без точки приписали расширение')
  closeControlRoom(id)
})

test('копия ложится в ту же папку, что и оригинал', () => {
  const id = room()
  makeDir(id, 'src')
  makeFile(id, 'src/model.py', 'import torch\n')

  assert.equal(say(id, 'host', { t: 'tree:copy', path: 'src/model.py' }), null)

  assert.ok(statPath(id, 'src/model (копия).py'), 'копия уехала из своей папки')
  assert.equal(statPath(id, 'model (копия).py'), null, 'копия легла в корень')
  closeControlRoom(id)
})

test('слово «копия» берётся из словаря: в английской комнате имя английское', () => {
  const id = room()
  makeFile(id, 'train.py', 'x = 1\n')
  setLocaleResolver(() => 'en')
  try {
    assert.equal(say(id, 'host', { t: 'tree:copy', path: 'train.py' }), null)
    assert.ok(statPath(id, 'train copy.py'), 'в английской комнате копия названа по-русски')
  } finally {
    setLocaleResolver(() => 'ru')
  }
  closeControlRoom(id)
})

test('длинное имя подрезается, а не отвергается за длину', () => {
  /*
   * `safeSegment` отвергает сегмент длиннее 120 знаков целиком, и без подрезки
   * дублирование файла со стосемнадцатибуквенным именем — обычной выгрузки из
   * LMS — отвечало бы «имя не годится» про имя, которого человек не набирал.
   */
  const id = room()
  const long = 'о'.repeat(112) + '.csv'
  makeFile(id, long, 'a,b\n')

  assert.equal(say(id, 'host', { t: 'tree:copy', path: long }), null)

  const copy = listFiles(id).find((entry) => entry.name !== long)
  assert.ok(copy, 'копии длинного имени не появилось')
  assert.ok(copy.name.length <= 120, `имя копии длиннее предела: ${copy.name.length}`)
  assert.match(copy.name, /\(копия\)\.csv$/)
  closeControlRoom(id)
})

/* --------------------------------------------------------------- право */

test('дублирует тот, кому правило комнаты разрешает файлы, — а не только преподаватель', () => {
  /*
   * Копия ДОБАВЛЯЕТ файл, как «новый файл» и как загрузка, поэтому правило у
   * неё `files`, а не роль. Переименование и удаление остаются
   * преподавательскими: они убирают прежний путь, а это нет.
   */
  const open = room()
  makeFile(open, 'решение.py', 'print(1)\n')
  assert.equal(say(open, 'participant', { t: 'tree:copy', path: 'решение.py' }), null)
  assert.ok(statPath(open, 'решение (копия).py'), 'студент не смог продублировать в открытой комнате')
  closeControlRoom(open)

  const closed = room()
  setRules(closed, { files: 'host' })
  makeFile(closed, 'раздатка.csv', 'a,b\n')
  const refusal = say(closed, 'participant', { t: 'tree:copy', path: 'раздатка.csv' })
  assert.match(refusal ?? '', /преподаватель/i)
  assert.equal(statPath(closed, 'раздатка (копия).csv'), null, 'файл всё-таки скопировался')
  // А преподавателю в той же комнате — можно.
  assert.equal(say(closed, 'host', { t: 'tree:copy', path: 'раздатка.csv' }), null)
  assert.ok(statPath(closed, 'раздатка (копия).csv'))
  closeControlRoom(closed)
})

/* ------------------------------------------------------------- границы */

test('за папку занятия копия не выходит: ни «..», ни абсолютным путём', () => {
  const id = room()
  makeFile(id, 'train.py', 'x = 1\n')
  const outside = path.join(sessionDir(id), '..', 'чужое.txt')
  fs.writeFileSync(outside, 'секрет')

  for (const wanted of ['../чужое.txt', '/etc/hosts', 'src/../../чужое.txt']) {
    const refusal = say(id, 'host', { t: 'tree:copy', path: wanted })
    assert.ok(refusal, `путь «${wanted}» прошёл молча`)
  }
  // И ничего не завелось ни рядом с папкой, ни внутри неё.
  assert.equal(fs.readFileSync(outside, 'utf8'), 'секрет')
  assert.deepEqual(
    listFiles(id).map((entry) => entry.path),
    ['train.py'],
  )
  fs.rmSync(outside, { force: true })
  closeControlRoom(id)
})

test('символическая ссылка наружу не копируется, даже если она видна в папке', () => {
  /*
   * Ячейка может позвать `os.symlink('/etc/hosts', 'hosts.txt')`. В дереве
   * такой записи нет (`listTree` ходит lstat-ом), но кадр можно послать и
   * руками. Копирование обязано отказать, а не вынести содержимое цели внутрь
   * комнаты обычным файлом.
   */
  const id = room()
  const link = path.join(sessionDir(id), 'hosts.txt')
  try {
    fs.symlinkSync('/etc/hosts', link)
  } catch {
    return // на файловой системе без ссылок проверять нечего
  }
  const refusal = say(id, 'host', { t: 'tree:copy', path: 'hosts.txt' })
  assert.ok(refusal, 'ссылку скопировали молча')
  assert.equal(statPath(id, 'hosts (копия).txt'), null, 'содержимое цели ссылки легло в комнату')
  fs.rmSync(link, { force: true })
  closeControlRoom(id)
})

test('папка не дублируется, и отказ говорит именно это', () => {
  const id = room()
  makeDir(id, 'данные')
  makeFile(id, 'данные/train.csv', 'a,b\n')

  const refusal = say(id, 'host', { t: 'tree:copy', path: 'данные' })
  assert.match(refusal ?? '', /Папки не дублируются/)
  assert.equal(statPath(id, 'данные (копия)'), null)
  closeControlRoom(id)
})

test('исчезнувший файл отвечает «его больше нет», а не «не получилось»', () => {
  const id = room()
  const refusal = say(id, 'host', { t: 'tree:copy', path: 'которого.нет' })
  assert.match(refusal ?? '', /уже нет|no longer/i)
  closeControlRoom(id)
})

/* -------------------------------------------------------------- потолки */

test('файл крупнее потолка загрузки не дублируется, и отказ называет мегабайты', () => {
  const id = room()
  const full = resolveInSession(id, 'big.bin')
  assert.ok(full)
  // Больше потолка на один файл, но заведомо меньше потолка комнаты: проверить
  // надо именно первую границу.
  fs.writeFileSync(full, Buffer.alloc(config.maxUploadBytes + 1024))

  const refusal = say(id, 'host', { t: 'tree:copy', path: 'big.bin' })
  assert.match(refusal ?? '', /МБ|MB/)
  assert.equal(statPath(id, 'big (копия).bin'), null, 'копия крупного файла всё-таки легла')
  fs.rmSync(full, { force: true })
  closeControlRoom(id)
})

test('копия, не помещающаяся в потолок комнаты, не пишется вовсе', () => {
  const id = room()
  const full = resolveInSession(id, 'dataset.bin')
  assert.ok(full)
  // Один файл в половину потолка комнаты проходит по своему потолку, а вот
  // его копия рядом с ним — уже нет.
  const half = Math.floor(config.maxSessionBytes / 2) + 1024
  const was = config.maxUploadBytes
  try {
    ;(config as { maxUploadBytes: number }).maxUploadBytes = config.maxSessionBytes
    fs.writeFileSync(full, Buffer.alloc(half))
    const refusal = say(id, 'host', { t: 'tree:copy', path: 'dataset.bin' })
    assert.match(refusal ?? '', /вмещает|room for/i)
    assert.equal(statPath(id, 'dataset (копия).bin'), null)
    // И ни одного недописанного хвоста: временные имена начинаются с точки и
    // в дерево не попадают, а место занимают.
    const left = fs.readdirSync(sessionDir(id)).filter((name) => name.startsWith('.'))
    assert.deepEqual(left, [], `после отказа остались временные файлы: ${left.join(', ')}`)
  } finally {
    ;(config as { maxUploadBytes: number }).maxUploadBytes = was
    fs.rmSync(full, { force: true })
  }
  closeControlRoom(id)
})

/* -------------------------------------------------------------- тетрадь */

test('тетрадь комнаты копируется свежей — проекция дописывается до копирования', () => {
  /*
   * Файл тетради пишется с задержкой в полторы секунды после последней правки
   * (collab/books.ts). Скопировать его, не дописав проекцию, значит отдать
   * человеку тетрадь без той ячейки, которую он только что набрал, — и молча.
   *
   * Копия при этом остаётся обычным .ipynb в папке: внести её в комнату —
   * отдельное действие с отдельным правилом.
   */
  const id = room()
  const { doc } = getSessionDoc(id)
  makeFile(id, 'занятие.ipynb', '{}')
  const book = addBook(doc, 'занятие.ipynb')
  bookCells(doc, book.root).push([createCell('code', 'import pandas as pd')])

  assert.equal(say(id, 'host', { t: 'tree:copy', path: 'занятие.ipynb' }), null)

  const copy = readText(id, 'занятие (копия).ipynb')
  assert.ok(copy, 'копии тетради нет')
  assert.match(copy.text, /import pandas as pd/, 'копия отстала от документа на последнюю ячейку')
  // И это файл, а не вторая тетрадь комнаты: внести его — отдельное действие.
  assert.equal(bookAt(doc, 'занятие (копия).ipynb'), null)
  closeControlRoom(id)
})

/* ------------------------------------------------------- прямое обращение */

test('freeCopyName не предлагает занятое имя', () => {
  const id = room()
  makeFile(id, 'a.txt', '1')
  makeFile(id, 'a (копия).txt', '1')
  makeFile(id, 'a (копия 2).txt', '1')

  assert.equal(freeCopyName(id, 'a.txt'), 'a (копия 3).txt')
  closeControlRoom(id)
})
