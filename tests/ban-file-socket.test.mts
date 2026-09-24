/**
 * The third door of a ban: a file open in the editor.
 *
 * `evictBanned` closes the notebook and the control socket with its own
 * hands: it holds their sockets itself. The file socket is held by another
 * module (collab/files.ts), and before this change nobody closed it: a
 * banned student kept receiving and broadcasting edits of the shared
 * `utils.py` to the whole room until they reloaded the page themselves.
 * Exactly the spam people get banned for, through a shared file rather than
 * the notebook.
 *
 * The neighbour `ban-evict.test.mts` checks the announcement (bans.ts ·
 * onEviction); here we check that the wire it names really closes, and that
 * exactly that wire closes.
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

/** A socket with a recorded close instead of a real one. */
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

test('a ban closes the file socket of the banned person, and only that one', () => {
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
  assert.equal(entry.conns.size, 2, 'the sockets did not join the file document')

  evictBanned(ROOM, 'p_petya', Date.now() + 60_000)

  assert.equal(
    petya.closed?.code,
    1008,
    'the tab of the banned person with the file open kept editing along with everyone',
  )
  assert.equal(ada.closed, null, 'the wrong socket was closed')
  assert.deepEqual(
    [...entry.conns.values()].map((state) => state.participantId),
    ['p_ada'],
    'someone extra stayed in the file document',
  )
})

test('a second eviction of the same person breaks nothing and leaves other rooms alone', () => {
  const other = 'ban-files-other'
  createSession(other, 'Соседняя комната', null)
  const full = path.join(sessionDir(other), 'utils.py')
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, 'x = 1\n')

  const elsewhere = fakeSocket()
  handleFileSocket(elsewhere.ws, other, 'utils.py', 'participant', 'p_petya')

  // The same person, the same room as in the first check: a repeat must
  // neither throw nor reach a namesake participant in a neighbouring seminar;
  // `participantId` is unique, but looking it up without the room would be
  // wrong.
  dropFileParticipant(ROOM, 'p_petya')

  assert.equal(elsewhere.closed, null, 'a file of this person in another room was closed')
  const entry = getFileDoc(other, 'utils.py')
  assert.equal(entry?.conns.size, 1)
})
