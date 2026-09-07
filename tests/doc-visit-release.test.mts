/**
 * Каким выходом уходит гость тетради.
 *
 * `visitSessionDoc` (server/src/routes/doc-visit.ts) поднимает документ пустой
 * комнаты ради одной строки — переименования в панели, чтения ленты,
 * публикации — и обязан отпустить его выселением без закрытий
 * (`releaseSessionDoc`), а не дверью сноса семинара (`dropSessionDoc`). Разница
 * видна ровно в одном месте: файловые сокеты живут в своей карте
 * (collab/files.ts), документ комнаты не поднимают и уборку простаивающих
 * переживают — так что открытый в редакторе `.py` доживает до конца пары. Дверь
 * сноса хлопнула бы ему кодом 1001 «комната закрыта», и человек, набирающий
 * функцию, увидел бы обрыв связи из-за того, что кто-то в панели переименовал
 * соседний семинар.
 *
 * Тест сторожит именно выбор двери: `tests/collab-release.test.mts` прибивает
 * сами двери, а здесь — что визит ходит в правильную.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { WebSocket } from 'ws'
import { createSession, getSession } from '../server/src/db.js'
import { sessionDir } from '../server/src/workspace.js'
import { getSessionDoc, peekSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { getFileDoc, handleFileSocket } from '../server/src/collab/files.js'
import { visitSessionDoc } from '../server/src/routes/doc-visit.js'
import { cellSource, createCell, getCells, getMeta } from '../shared/notebook.js'

after(() => shutdownCollab())

/** Сокет с записанными кадрами вместо настоящего: важно только, закрыли ли его. */
function fakeSocket() {
  const sent: Uint8Array[] = []
  let closed: { code: number; reason: string } | null = null
  const ws = {
    readyState: 1,
    binaryType: '',
    on() {
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
    get closed() {
      return closed
    },
  }
}

test('визит в пустую комнату не хлопает открытым файловым сокетом', () => {
  const id = 'visit-release'
  createSession(id, 'Прошлогодний семинар', null)

  // Работа класса в тетради, и — холодный путь: в памяти документа нет, на
  // диске всё. Ровно то состояние, в котором комнату застаёт переименование.
  {
    const { doc } = getSessionDoc(id)
    const cells = getCells(doc)
    cells.delete(0, cells.length)
    const cell = createCell('code', '')
    cells.push([cell])
    cellSource(cell).insert(0, 'x = 1')
    shutdownCollab()
  }
  assert.equal(peekSessionDoc(id), null, 'комната осталась в памяти — тест ничего не проверяет')

  // А рядом идёт пара: кто-то правит файл комнаты в редакторе.
  const file = 'utils.py'
  fs.writeFileSync(path.join(sessionDir(id), file), 'def f():\n    return 1\n')
  assert.ok(getFileDoc(id, file), 'файл комнаты не открылся — тест ничего не проверяет')
  const editor = fakeSocket()
  handleFileSocket(editor.ws, id, file, 'host', 'p_host')
  assert.equal(editor.closed, null, 'файловый сокет закрылся ещё на рукопожатии')
  assert.equal(peekSessionDoc(id), null, 'открытый файл поднял документ комнаты')

  // То же, что делает переименование в панели (routes/admin-instance.ts).
  visitSessionDoc(id, (doc) => getMeta(doc).set('title', 'Семинар 3'))

  assert.equal(editor.closed, null, 'визит ушёл дверью сноса и закрыл чужой редактор')
  assert.equal(peekSessionDoc(id), null, 'визит поселил тетрадь в памяти')
  assert.ok(getSession(id), 'визит снёс сам семинар')

  // И записанное доехало до диска — выселение уходит молча.
  const { doc } = getSessionDoc(id)
  assert.equal(getMeta(doc).get('title'), 'Семинар 3')
  const cells = getCells(doc)
  assert.equal(cells.length, 1, 'тетрадь поднялась не из своего снимка')
  assert.equal(cellSource(cells.get(0)).toString(), 'x = 1')
})
