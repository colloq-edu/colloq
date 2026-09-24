/**
 * What a room takes with it when it is evicted from memory.
 *
 * The Oracle's "as it was before the turn" snapshot lives in process memory,
 * while the "Undo" button lives in the thread, that is, in the document, which
 * survives both eviction and a restart. While eviction did not forget this
 * snapshot, the map grew along with abandoned rooms; it has to be forgotten in
 * exactly the place where the room forgets its deleted cells — otherwise undo
 * would reach into the memory of a room that has been empty for ten minutes.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSession } from '../server/src/db.js'
import { readText, sessionDir } from '../server/src/workspace.js'
import { flushAllFiles } from '../server/src/collab/files.js'
import { useTool, undoTurn, type Hands } from '../server/src/ai/agent.js'
import { createChatEntry, findChatEntry, getChat } from '@shared/notebook'
import {
  getSessionDoc,
  peekSessionDoc,
  shutdownCollab,
  sweepIdleRooms,
} from '../server/src/collab/index.js'

after(() => shutdownCollab())

const ROOM = 'evict-undo'
const BY = { name: 'Оракул', color: '#0FA0D7', participantId: 'p_oracle' }

/** An empty room is released after ten minutes; we take a margin. */
const LATER = 11 * 60 * 1000

/** A turn in the thread that the undo is tied to, already finished. */
function finishedTurn(): string {
  const doc = getSessionDoc(ROOM).doc
  const entry = createChatEntry({
    participantId: 'p_ada',
    name: 'Ада',
    color: '#F97362',
    question: 'перепиши план',
    mode: 'agent',
  })
  doc.transact(() => {
    getChat(doc).push([entry])
    // An answer in progress keeps the room from eviction, but this one is done.
    entry.set('state', 'done')
    entry.set('undo', 'available')
  })
  return entry.get('id') as string
}

test("eviction takes the Oracle's undo memory with it", async () => {
  createSession(ROOM, 'Отмена после выселения', null)
  const turn = finishedTurn()
  const hands: Hands = { sessionId: ROOM, entryId: turn, by: BY, role: 'host' }

  fs.mkdirSync(sessionDir(ROOM), { recursive: true })
  fs.writeFileSync(path.join(sessionDir(ROOM), 'plan.py'), 'исходное\n')
  const wrote = await useTool(
    hands,
    'write_file',
    JSON.stringify({ path: 'plan.py', content: 'оракул\n' }),
  )
  assert.equal(wrote.step.kind, 'write')
  flushAllFiles()
  assert.equal(readText(ROOM, 'plan.py')?.text, 'оракул\n')

  assert.equal(
    sweepIdleRooms(Date.now() + LATER).includes(ROOM),
    true,
    'the empty room stayed in memory',
  )
  assert.equal(peekSessionDoc(ROOM), null, 'the room stayed in memory')

  // The button in the thread comes back from the snapshot: the thread lives in
  // the document.
  const again = getSessionDoc(ROOM).doc
  assert.equal(findChatEntry(again, turn)?.get('undo'), 'available', 'the turn did not come back from the snapshot')

  // But there is nothing left to restore, and the button's refusal for this
  // case is spelled out in words ("previous file versions are retained only
  // until the server restarts").
  assert.equal(undoTurn(ROOM, turn, 'Ада'), null, 'undo reached into the memory of an evicted room')
  flushAllFiles()
  assert.equal(
    readText(ROOM, 'plan.py')?.text,
    'оракул\n',
    'the file was rolled back ten minutes after everyone had left the room',
  )
})
