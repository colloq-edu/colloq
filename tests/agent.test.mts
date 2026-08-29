/**
 * Границы режима «сделать».
 *
 * Модель здесь не участвует: проверяются руки, а не голова. Всё, что ниже,
 * ломается тихо — оракул сообщает об успехе, а в файле не то, что он думает,
 * или отмена возвращает не туда, где были.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSession } from '../server/src/db.js'
import { readText, sessionDir } from '../server/src/workspace.js'
import { getFileDoc, flushAllFiles, TEXT_KEY } from '../server/src/collab/files.js'
import { useTool, undoTurn, type Hands } from '../server/src/ai/agent.js'
import { findChatEntry, getChat, createChatEntry } from '@shared/notebook'
import { getSessionDoc } from '../server/src/collab/index.js'

const ROOM = 'agent-room'
const BY = { name: 'Оракул', color: '#0FA0D7', participantId: 'p_oracle' }

function hands(entryId: string): Hands {
  return { sessionId: ROOM, entryId, by: BY }
}

/** Завести запись треда, к которой привязывается отмена. */
function turn(): string {
  const doc = getSessionDoc(ROOM).doc
  const entry = createChatEntry({
    participantId: 'p_ada',
    name: 'Ада',
    color: '#F97362',
    question: 'сделай',
    mode: 'agent',
  })
  doc.transact(() => getChat(doc).push([entry]))
  const id = entry.get('id') as string
  doc.transact(() => entry.set('undo', 'available'))
  return id
}

test('комната заводится', () => {
  createSession(ROOM, 'Agent', null)
  fs.writeFileSync(path.join(sessionDir(ROOM), 'train.py'), 'x = 1\ny = 2\n')
})

test('читает то, что есть, и честно отказывает в том, чего нет', async () => {
  const id = turn()
  const read = await useTool(hands(id), 'read_file', JSON.stringify({ path: 'train.py' }))
  assert.equal(read.said, 'x = 1\ny = 2\n')
  assert.equal(read.step.kind, 'read')

  const missing = await useTool(hands(id), 'read_file', JSON.stringify({ path: 'nope.py' }))
  assert.match(missing.said, /нет или он не текст/)
  assert.equal(missing.step.kind, 'note')
})

test('наружу папки семинара не выходит', async () => {
  const id = turn()
  for (const wanted of ['../secret', '/etc/passwd', 'src/../../out']) {
    const tried = await useTool(hands(id), 'read_file', JSON.stringify({ path: wanted }))
    assert.equal(tried.step.kind, 'note', wanted)
    assert.match(tried.said, /невозможен/, wanted)
  }
})

test('точечная правка требует однозначного куска', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'twice.py'), 'a = 1\nb = 1\n')

  const ambiguous = await useTool(
    hands(id),
    'edit_file',
    JSON.stringify({ path: 'twice.py', find: '= 1', replace: '= 2' }),
  )
  assert.match(ambiguous.said, /больше одного раза/)
  assert.equal(
    readText(ROOM, 'twice.py')?.text,
    'a = 1\nb = 1\n',
    'неоднозначная правка всё-таки записалась',
  )

  const exact = await useTool(
    hands(id),
    'edit_file',
    JSON.stringify({ path: 'twice.py', find: 'b = 1', replace: 'b = 2' }),
  )
  assert.equal(exact.step.kind, 'write')
  flushAllFiles()
  assert.equal(readText(ROOM, 'twice.py')?.text, 'a = 1\nb = 2\n')
})

test('правка, которой некуда лечь, не выдаёт себя за удачу', async () => {
  const id = turn()
  const nowhere = await useTool(
    hands(id),
    'edit_file',
    JSON.stringify({ path: 'train.py', find: 'этого там нет', replace: 'x' }),
  )
  assert.equal(nowhere.step.kind, 'note')
  assert.match(nowhere.said, /нет такого текста/)
})

test('счёт строк в ленте — про то, что правда изменилось', async () => {
  const id = turn()
  const wrote = await useTool(
    hands(id),
    'write_file',
    JSON.stringify({ path: 'train.py', content: 'x = 1\ny = 2\nz = 3\n' }),
  )
  assert.equal(wrote.step.added, 1, 'прибавилась одна строка, а не весь файл')
  assert.equal(wrote.step.removed, 0)
})

test('отмена возвращает файл к тому, что было до хода', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'undo.py'), 'исходное\n')

  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'undo.py', content: 'первое\n' }))
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'undo.py', content: 'второе\n' }))
  flushAllFiles()
  assert.equal(readText(ROOM, 'undo.py')?.text, 'второе\n')

  // К исходному, а не к предыдущей правке того же хода: отменяют решение
  // целиком, а не последний шаг.
  assert.equal(undoTurn(ROOM, id, 'Ада'), 1)
  flushAllFiles()
  assert.equal(readText(ROOM, 'undo.py')?.text, 'исходное\n')

  const entry = findChatEntry(getSessionDoc(ROOM).doc, id)
  assert.equal(entry?.get('undo'), 'done')
  assert.equal(entry?.get('undoBy'), 'Ада')
})

test('отменить дважды нельзя', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'once.py'), 'было\n')
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'once.py', content: 'стало\n' }))
  assert.equal(undoTurn(ROOM, id, 'Ада'), 1)
  assert.equal(undoTurn(ROOM, id, 'Ада'), null, 'вторая отмена вернула бы файл к «стало»')
})

test('правка открытого файла идёт в документ, а не мимо редактора', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'open.py'), 'a = 1\n')
  const doc = getFileDoc(ROOM, 'open.py')
  assert.ok(doc)
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'open.py', content: 'a = 2\n' }))
  assert.equal(
    doc.doc.getText(TEXT_KEY).toString(),
    'a = 2\n',
    'редактор показывал бы старое, а на диске лежало бы новое',
  )
})

test('запускается только то, чем есть что запустить', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'data.csv'), 'a,b\n')
  const tried = await useTool(hands(id), 'run_file', JSON.stringify({ path: 'data.csv' }))
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /не скрипт/)
})

test('несуществующего инструмента нет', async () => {
  const id = turn()
  const tried = await useTool(hands(id), 'delete_file', JSON.stringify({ path: 'train.py' }))
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /нет/)
  assert.ok(readText(ROOM, 'train.py'), 'файл всё-таки исчез')
})
