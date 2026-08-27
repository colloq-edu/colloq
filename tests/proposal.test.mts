/**
 * A proposal the room can see, argue with, and apply.
 *
 * The whole point of putting it in the shared document rather than in the
 * asker's browser: everyone watches it arrive, anyone can read what it would
 * do, and whoever accepts it does so in front of the class. These pin the parts
 * that would otherwise quietly lose somebody's work.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  acceptPatch,
  chatAnswer,
  clearStaleExecution,
  createCell,
  createChatEntry,
  findChatEntry,
  getCells,
  getChat,
  openPatchFor,
  patchIsStale,
  rejectPatch,
} from '../shared/notebook.js'

function room(): { doc: Y.Doc; cellId: string } {
  const doc = new Y.Doc()
  const cell = createCell('code', 'model = Net(64)')
  doc.transact(() => getCells(doc).push([cell]))
  return { doc, cellId: cell.get('id') as string }
}

function propose(doc: Y.Doc, cellId: string, patch: string | null, base: string | null) {
  const entry = createChatEntry({
    participantId: 'p_maria',
    name: 'Maria',
    color: '#8b6bd9',
    question: 'make the batch smaller',
    action: 'edit',
    cellId,
    patchBase: base,
  })
  doc.transact(() => getChat(doc).push([entry]))
  if (patch !== null) doc.transact(() => entry.set('patch', patch))
  return entry
}

test('an open proposal is the one the cell offers', () => {
  const { doc, cellId } = room()
  propose(doc, cellId, 'model = Net(32)', 'model = Net(64)')
  const found = openPatchFor(doc, cellId)
  assert.ok(found)
  assert.equal(found.get('patch'), 'model = Net(32)')
})

test('a turn that proposed nothing is not an offer', () => {
  const { doc, cellId } = room()
  propose(doc, cellId, null, 'model = Net(64)')
  assert.equal(openPatchFor(doc, cellId), null)
})

test('accepting writes the cell and signs who did it', () => {
  const { doc, cellId } = room()
  const entry = propose(doc, cellId, 'model = Net(32)', 'model = Net(64)')
  assert.equal(acceptPatch(doc, entry, 'Alexander'), true)

  const source = (getCells(doc).get(0).get('source') as Y.Text).toString()
  assert.equal(source, 'model = Net(32)')
  assert.equal(entry.get('patchState'), 'accepted')
  // Signed by the person, not by the oracle: a human decided.
  assert.equal(entry.get('patchBy'), 'Alexander')
  assert.equal(openPatchFor(doc, cellId), null, 'a decided proposal is still on offer')
})

test('the same proposal cannot be accepted twice', () => {
  const { doc, cellId } = room()
  const entry = propose(doc, cellId, 'model = Net(32)', 'model = Net(64)')
  assert.equal(acceptPatch(doc, entry, 'Alexander'), true)
  // Two people pressing Accept a moment apart is a race, not an error — but the
  // second press must not rewrite a cell that has moved on since.
  assert.equal(acceptPatch(doc, entry, 'Maria'), false)
  assert.equal(entry.get('patchBy'), 'Alexander')
})

test('rejecting writes nothing to the cell', () => {
  const { doc, cellId } = room()
  const entry = propose(doc, cellId, 'model = Net(32)', 'model = Net(64)')
  rejectPatch(doc, entry, 'Alexander')
  assert.equal((getCells(doc).get(0).get('source') as Y.Text).toString(), 'model = Net(64)')
  assert.equal(entry.get('patchState'), 'rejected')
  assert.equal(openPatchFor(doc, cellId), null)
})

test('a proposal for a cell somebody deleted applies to nothing', () => {
  const { doc, cellId } = room()
  const entry = propose(doc, cellId, 'model = Net(32)', 'model = Net(64)')
  doc.transact(() => getCells(doc).delete(0, 1))
  assert.equal(acceptPatch(doc, entry, 'Alexander'), false)
})

test('a cell that moved under the proposal is called stale', () => {
  const { doc, cellId } = room()
  const entry = propose(doc, cellId, 'model = Net(32)', 'model = Net(64)')
  assert.equal(patchIsStale(doc, entry), false)

  const source = getCells(doc).get(0).get('source') as Y.Text
  doc.transact(() => source.insert(source.length, '\nmodel.cuda()'))
  assert.equal(patchIsStale(doc, entry), true, 'the room was not warned it would lose that line')
})

test('двое приняли одновременно — ячейка получает патч один раз', () => {
  /*
   * Панель и ячейка показывают Accept обе, и проверка «ещё open» читала
   * значение, которому могли быть секунды. Преподаватель жмёт в панели,
   * студент под ячейкой — Yjs честно сливал обе записи, и в ячейке
   * оказывался патч дважды.
   */
  const doc = new Y.Doc()
  const cell = createCell('code', 'x = 1')
  getCells(doc).push([cell])
  const entry = createChatEntry({
    participantId: 'p1',
    name: 'Мария',
    color: '#c273e6',
    question: 'перепиши',
    action: 'edit',
    cellId: cell.get('id') as string,
    patchBase: 'x = 1',
  })
  entry.set('patch', 'x = 2')
  getChat(doc).push([entry])

  const first = acceptPatch(doc, entry, 'Мария')
  const second = acceptPatch(doc, entry, 'Джон')

  assert.equal(first, true, 'первое принятие не сработало')
  assert.equal(second, false, 'второе принятие прошло тоже')
  assert.equal((cell.get('source') as Y.Text).toString(), 'x = 2')
  assert.equal(entry.get('patchBy'), 'Мария', 'решение приписано не тому')
})

test('ход, брошенный на полуслове, не крутит спиннер вечно', () => {
  /*
   * Процесс, который писал ответ, ушёл вместе с сервером. Без этого тред
   * держал «thinking» до конца семинара — и, поскольку панель следует за
   * последним ходом, крутил его внизу у всех.
   */
  const doc = new Y.Doc()
  const entry = createChatEntry({
    participantId: 'p1',
    name: 'Мария',
    color: '#c273e6',
    question: 'почему падает?',
  })
  getChat(doc).push([entry])
  assert.equal(entry.get('state'), 'streaming')

  clearStaleExecution(doc)

  assert.equal(entry.get('state'), 'error')
  assert.match(chatAnswer(entry).toString(), /server restarted/)
})

test('два браузера, принявшие одно предложение, не вписывают патч дважды', () => {
  /*
   * Настоящая гонка — не два нажатия в одной вкладке (её ловила проверка
   * внутри транзакции), а две копии документа. Каждая читает `'open'`, каждая
   * пишет, Yjs добросовестно сливает обе правки — и ячейка получает патч
   * дважды. Здесь это и воспроизводится: два Y.Doc, синхронизируемых после.
   */
  const server = new Y.Doc()
  const cellIdValue = 'c_race'
  server.transact(() => {
    getCells(server).push([createCell('code', 'x = 1', cellIdValue)])
    getChat(server).push([
      createChatEntry({
        participantId: 'p_one',
        name: 'One',
        color: '#111111',
        question: 'перепиши',
        action: 'edit',
        cellId: cellIdValue,
        patchBase: 'x = 1',
      }),
    ])
  })
  const id = (getChat(server).get(0).get('id') as string) ?? ''
  server.transact(() => {
    const entry = findChatEntry(server, id)!
    entry.set('patch', 'x = 2')
    entry.set('patchState', 'open')
  })

  // Два клиента, каждый со своей копией.
  const a = new Y.Doc()
  const b = new Y.Doc()
  Y.applyUpdate(a, Y.encodeStateAsUpdate(server))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(server))

  // Так было раньше: каждый решает у себя.
  acceptPatch(a, findChatEntry(a, id)!, 'One')
  acceptPatch(b, findChatEntry(b, id)!, 'Two')
  Y.applyUpdate(server, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(server, Y.encodeStateAsUpdate(b))
  const both = (getCells(server).get(0).get('source') as Y.Text).toString()

  // А так теперь: решение идёт на сервер, и он применяет его к одной копии.
  const clean = new Y.Doc()
  clean.transact(() => {
    getCells(clean).push([createCell('code', 'x = 1', cellIdValue)])
    getChat(clean).push([
      createChatEntry({
        participantId: 'p_one',
        name: 'One',
        color: '#111111',
        question: 'перепиши',
        action: 'edit',
        cellId: cellIdValue,
        patchBase: 'x = 1',
      }),
    ])
  })
  const cleanId = getChat(clean).get(0).get('id') as string
  clean.transact(() => {
    const entry = findChatEntry(clean, cleanId)!
    entry.set('patch', 'x = 2')
    entry.set('patchState', 'open')
  })
  assert.equal(acceptPatch(clean, findChatEntry(clean, cleanId)!, 'One'), true)
  assert.equal(acceptPatch(clean, findChatEntry(clean, cleanId)!, 'Two'), false, 'второе решение прошло')
  assert.equal((getCells(clean).get(0).get('source') as Y.Text).toString(), 'x = 2')

  // И ради ясности: без сервера результат был другим.
  assert.notEqual(both, 'x = 2', 'гонка перестала воспроизводиться — проверка потеряла смысл')
})
