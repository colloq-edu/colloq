import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { addBook, cellsAt, createCell, createChatEntry, getCells, getChat, cellSource } from '../shared/notebook.js'
import { beginHistory, flushHistory, flushAllHistory, record } from '../server/src/collab/history.js'
import { createSession, getVersion } from '../server/src/db.js'
import { listActivity, activitySummary } from '../server/src/activity.js'

after(() => flushAllHistory())

test('editing a secondary notebook records participation even when the primary notebook digest is unchanged', () => {
  const id = 'activity-secondary-notebook'
  createSession(id, 'Multiple notebooks')
  const doc = new Y.Doc()
  doc.transact(() => {
    getCells(doc).push([createCell('code', 'main', 'c_main')])
    addBook(doc, 'exercise.ipynb', 'exercise')
    cellsAt(doc, 'exercise.ipynb')!.push([createCell('code', 'task', 'c_exercise')])
  })
  beginHistory(id, doc)
  doc.on('update', (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
    record(id, doc, update, 'p_student', transaction, { participantId: 'p_student', role: 'participant' })
  })
  const text = cellSource(cellsAt(doc, 'exercise.ipynb')!.get(0))
  doc.transact(() => text.insert(text.length, ' solution'))
  flushHistory(id)
  const events = listActivity(id, { level: 'detailed', category: 'notebook' }).events
  assert.equal(events.length, 1)
  assert.equal(events[0].actor?.id, 'p_student')
  assert.equal(getVersion(id, events[0].details.versionSeq!)?.kind, 'quiet')
  assert.equal(activitySummary(id).summaries[0].events, 1)
  doc.destroy()
})

test('committed mixed-author burst counts direct contributors once without assigning the shared diff', () => {
  const id = 'activity-notebook-mixed'
  createSession(id, 'Notebook participation')
  const doc = new Y.Doc()
  doc.transact(() => getCells(doc).push([createCell('code', 'original', 'c_activity')]))
  beginHistory(id, doc)
  doc.on('update', (update: Uint8Array, origin: string, _doc: Y.Doc, transaction: Y.Transaction) => {
    const participantId = origin === 'oracle' ? 'p_oracle_requester' : origin
    record(id, doc, update, participantId, transaction, origin.startsWith('p_')
      ? { participantId: origin, role: 'participant' } : undefined)
  })
  const text = getCells(doc).get(0).get('source') as Y.Text
  for (let index = 0; index < 20; index++) {
    doc.transact(() => text.insert(text.length, 'a'), 'p_one')
    doc.transact(() => text.insert(text.length, 'b'), 'p_two')
  }
  doc.transact(() => text.insert(text.length, 'SECRET GENERATED CODE'), 'oracle')
  assert.equal(listActivity(id, { level: 'detailed' }).events.length, 0, 'uncommitted keystrokes must not generate activity rows')
  flushHistory(id)
  const events = listActivity(id, { level: 'detailed', category: 'notebook' }).events
  assert.equal(events.length, 2)
  assert.deepEqual(events.map(event => event.actor?.id).sort(), ['p_one', 'p_two'])
  assert.equal(events[0].details.versionSeq, events[1].details.versionSeq)
  assert.equal(getVersion(id, events[0].details.versionSeq!)?.kind, 'edit')
  for (const event of events) assert.deepEqual(event.details, { versionSeq: event.details.versionSeq, count: 1, source: 'participant' })
  assert.ok(!JSON.stringify(events).includes('SECRET'))
  assert.equal(activitySummary(id).summaries.length, 2)
  doc.destroy()
})

test('chat, runtime state and on-behalf source changes never manufacture a direct notebook contribution', () => {
  const id = 'activity-notebook-noise'
  createSession(id, 'Notebook participation')
  const doc = new Y.Doc()
  doc.transact(() => getCells(doc).push([createCell('code', 'before', 'c_noise')]))
  beginHistory(id, doc)
  doc.on('update', (update: Uint8Array, origin: string, _doc: Y.Doc, transaction: Y.Transaction) => {
    record(id, doc, update, 'p_one', transaction, origin === 'direct' ? { participantId: 'p_one', role: 'participant' } : undefined)
  })
  doc.transact(() => getChat(doc).push([createChatEntry({ participantId: 'p_one', name: 'Nina', color: '#123456', question: 'Help' })]), 'direct')
  doc.transact(() => getCells(doc).get(0).set('state', 'running'), 'direct')
  const text = getCells(doc).get(0).get('source') as Y.Text
  doc.transact(() => text.insert(text.length, ' generated'), 'on-behalf:p_one')
  flushHistory(id)
  assert.equal(listActivity(id, { level: 'detailed' }).events.length, 0)
  assert.equal(cellSource(getCells(doc).get(0)).toString(), 'before generated')
  doc.destroy()
})
