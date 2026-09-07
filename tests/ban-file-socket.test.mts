/**
 * Третья дверь бана: открытый в редакторе файл.
 *
 * Тетрадь и пульт `evictBanned` закрывает своими руками — их сокеты он держит
 * сам. Файловый сокет держит другой модуль (collab/files.ts), и до этой правки
 * его не закрывал никто: забаненный студент продолжал принимать и рассылать
 * правки общего `utils.py` всей комнате, пока сам не перезагрузит страницу.
 * Ровно тот спам, за который банят, — по общему файлу, а не по тетради.
 *
 * Сосед `ban-evict.test.mts` проверяет объявление (bans.ts · onEviction); здесь
 * — что провод по нему правда закрывается и что закрывается ровно он.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { WebSocket } from 'ws'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { evictBanned } from '../server/src/control.js'
import {
  dropFileParticipant,
  getFileDoc,
  handleFileSocket,
} from '../server/src/collab/files.js'
import { sessionDir } from '../server/src/workspace.js'

const ROOM = 'ban-files'

function seed(name: string, text: string): void {
  const full = path.join(sessionDir(ROOM), name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text)
}

/** Сокет с записанным закрытием вместо настоящего. */
function fakeSocket() {
  let closed: { code: number; reason: string } | null = null
  const ws = {
    readyState: 1,
    binaryType: '',
    on() {
      return ws
    },
    ping() {},
    send(_message: Uint8Array, ...rest: unknown[]) {
      const cb = rest.find((it) => typeof it === 'function') as
        | ((err?: Error) => void)
        | undefined
      cb?.()
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

test('бан закрывает файловый сокет забаненного и только его', () => {
  createSession(ROOM, 'Бан и файлы', null)
  upsertParticipant({
    id: 'p_petya',
    sessionId: ROOM,
    name: 'Петя',
    avatar: null,
    role: 'participant',
  })
  upsertParticipant({ id: 'p_ada', sessionId: ROOM, name: 'Ада', avatar: null, role: 'host' })
  seed('utils.py', 'def helper():\n    return 1\n')

  const petya = fakeSocket()
  const ada = fakeSocket()
  handleFileSocket(petya.ws, ROOM, 'utils.py', 'participant', 'p_petya')
  handleFileSocket(ada.ws, ROOM, 'utils.py', 'host', 'p_ada')

  const entry = getFileDoc(ROOM, 'utils.py')
  assert.ok(entry)
  assert.equal(entry.conns.size, 2, 'сокеты не встали в документ файла')

  evictBanned(ROOM, 'p_petya', Date.now() + 60_000)

  assert.equal(
    petya.closed?.code,
    1008,
    'вкладка забаненного с открытым файлом осталась править вместе со всеми',
  )
  assert.equal(ada.closed, null, 'закрыли не того')
  assert.deepEqual(
    [...entry.conns.values()].map((state) => state.participantId),
    ['p_ada'],
    'в документе файла остался кто-то лишний',
  )
})

test('второе выселение того же человека ничего не ломает и не трогает чужие комнаты', () => {
  const other = 'ban-files-other'
  createSession(other, 'Соседняя комната', null)
  const full = path.join(sessionDir(other), 'utils.py')
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, 'x = 1\n')

  const elsewhere = fakeSocket()
  handleFileSocket(elsewhere.ws, other, 'utils.py', 'participant', 'p_petya')

  // Тот же человек, та же комната, что и в первой проверке: повтор не должен
  // ни бросать, ни доставать одноимённого участника из соседнего семинара —
  // `participantId` уникален, но искать по нему без комнаты было бы неверно.
  dropFileParticipant(ROOM, 'p_petya')

  assert.equal(elsewhere.closed, null, 'закрыли файл человека в чужой комнате')
  const entry = getFileDoc(other, 'utils.py')
  assert.equal(entry?.conns.size, 1)
})
