/**
 * Две двери наружу из памяти: отпустить комнату и снести семинар.
 *
 * `dropSessionDoc` написан для СНОСА: он закрывает сокеты комнаты и её открытые
 * файлы. Но выселить документ хочет и тот, кто просто заглянул в тетрадь ради
 * одной строки (routes/doc-visit.ts) — переименование в панели, чтение ленты,
 * публикация. Ему нужна дверь, которая ничего не закрывает: файловые сокеты
 * живут в своей карте и документ комнаты не поднимают, так что открытый в
 * редакторе `.py` спокойно переживает выселение — а дверь сноса хлопнула бы ему
 * кодом 1001 «комната закрыта» посреди живого семинара.
 *
 * Здесь прибито ровно это различие: что отпускает `releaseSessionDoc` (и что
 * при этом обязано доехать до диска), чего он не трогает и чего не делает с
 * комнатой, в которой сидят люди.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { WebSocket } from 'ws'
import { createSession, getSession } from '../server/src/db.js'
import { sessionDir } from '../server/src/workspace.js'
import {
  dropSessionDoc,
  getSessionDoc,
  handleCollabSocket,
  peekSessionDoc,
  releaseSessionDoc,
  shutdownCollab,
} from '../server/src/collab/index.js'
import { getFileDoc, handleFileSocket } from '../server/src/collab/files.js'
import { cellSource, createCell, getCells } from '../shared/notebook.js'

after(() => shutdownCollab())

/**
 * Сокет с записанными кадрами вместо настоящего.
 *
 * `send` зовут и на два аргумента, и на три (сообщение, настройки сжатия,
 * обратный вызов) — последний аргумент и есть тот, кого надо позвать.
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
    terminate() {},
    send(message: Uint8Array, ...rest: unknown[]) {
      sent.push(message)
      const done = rest[rest.length - 1]
      if (typeof done === 'function') (done as (err?: Error) => void)()
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
    handlers,
  }
}

/** Работа класса: ячейка в тетради и открытый рядом файл. */
function room(id: string, file: string): ReturnType<typeof fakeSocket> {
  createSession(id, 'Прошлогодний семинар', null)
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  cells.delete(0, cells.length)
  const cell = createCell('code', '')
  cells.push([cell])
  cellSource(cell).insert(0, 'x = 1')

  fs.writeFileSync(path.join(sessionDir(id), file), 'def f():\n    return 1\n')
  assert.ok(getFileDoc(id, file), 'файл комнаты не открылся — тест ничего не проверяет')
  const socket = fakeSocket()
  handleFileSocket(socket.ws, id, file, 'host', 'p_host')
  assert.equal(socket.closed, null, 'файловый сокет закрылся ещё на рукопожатии')
  return socket
}

test('выселение отпускает документ, дописав его, и не закрывает открытый файл', () => {
  const id = 'release-cold'
  const editor = room(id, 'utils.py')

  assert.equal(releaseSessionDoc(id), true)
  assert.equal(peekSessionDoc(id), null, 'документ остался в памяти')
  assert.equal(editor.closed, null, 'выселение хлопнуло сокетом открытого файла')
  assert.ok(getSession(id), 'выселение снесло сам семинар')

  /*
   * И записанное доехало до диска: выселение уходит молча, и если снимок не
   * дописан, следующий вошедший поднимет тетрадь без последней правки — правка
   * была, а после перезапуска её нет.
   */
  const cells = getCells(getSessionDoc(id).doc)
  assert.equal(cells.length, 1, 'тетрадь поднялась не из своего снимка')
  assert.equal(cellSource(cells.get(0)).toString(), 'x = 1')
})

test('снос семинара, наоборот, закрывает файловый сокет — тем двери и отличаются', () => {
  const id = 'release-drop'
  const editor = room(id, 'utils.py')

  dropSessionDoc(id)
  assert.equal(peekSessionDoc(id), null)
  assert.equal(editor.closed?.code, 1001, 'снос оставил открытым файл снесённой комнаты')
})

test('комнату, в которой сидят, выселение не трогает', () => {
  const id = 'release-live'
  createSession(id, 'Идущая пара', null)
  const { doc } = getSessionDoc(id)
  const tab = fakeSocket()
  handleCollabSocket(tab.ws, id, 'host', 'p_host')

  assert.equal(releaseSessionDoc(id), false, 'документ выселен из-под живого сокета')
  assert.equal(peekSessionDoc(id)?.doc, doc, 'комната с людьми потеряла свой документ')
  assert.equal(tab.closed, null)
})

test('комната, которой в памяти нет, — не ошибка, а «нечего отпускать»', () => {
  assert.equal(releaseSessionDoc('release-never-opened'), false)
})
