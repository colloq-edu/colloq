/**
 * Что комната уносит с собой, когда её выселяют из памяти.
 *
 * Снимок «как было до хода» оракула лежит в памяти процесса, а кнопка «Отменить»
 * — в треде, то есть в документе, который переживает и выселение, и перезапуск.
 * Пока выселение не забывало этот снимок, карта росла вместе с брошенными
 * комнатами; забыть её надо ровно там же, где комната забывает свои удалённые
 * ячейки, — иначе отмена дотягивалась бы до памяти комнаты, пустой уже десять
 * минут.
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

/** Пустая комната отпускается через десять минут; берём с запасом. */
const LATER = 11 * 60 * 1000

/** Ход в треде, к которому привязана отмена, — уже законченный. */
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
    // Идущий ответ держит комнату от выселения — а этот уже дописан.
    entry.set('state', 'done')
    entry.set('undo', 'available')
  })
  return entry.get('id') as string
}

test('выселение уносит с собой память отмены оракула', async () => {
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
    'пустая комната осталась в памяти',
  )
  assert.equal(peekSessionDoc(ROOM), null, 'комната осталась в памяти')

  // Кнопка в треде возвращается из снимка — тред живёт в документе.
  const again = getSessionDoc(ROOM).doc
  assert.equal(findChatEntry(again, turn)?.get('undo'), 'available', 'ход не вернулся из снимка')

  // А возвращать уже нечего, и отказ у кнопки на этот случай написан словами
  // («сервер помнит прежние файлы только до перезапуска»).
  assert.equal(undoTurn(ROOM, turn, 'Ада'), null, 'отмена дотянулась до памяти выселенной комнаты')
  flushAllFiles()
  assert.equal(
    readText(ROOM, 'plan.py')?.text,
    'оракул\n',
    'файл откатили через десять минут после того, как из комнаты ушли',
  )
})
