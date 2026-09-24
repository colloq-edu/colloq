/**
 * The history's base point is a live document, not a rebuild on every burst.
 *
 * Closing a burst has to know what the notebook looks like after it. It knew
 * this in only one way: rebuild the document from the base point and the
 * merged update — a full parse of the whole notebook; a measurement on 2.2 MB
 * gave 37 ms of blocked event loop for the sake of a kilobyte and a half of
 * difference. And it was not the history write that paid for it but the room:
 * a burst closes on every add, delete and drag of a cell, so those
 * milliseconds stand between everyone else's keystrokes.
 *
 * The shadow notebook is kept alive and moves with the same update. This can
 * break quietly and equally badly in both directions: the version's word
 * counts get computed against a SHIFTED notebook ("nothing changed"), or a
 * full snapshot gets written from one burst instead of the whole notebook —
 * and "Restore" hands the room an empty page. Both are checked here.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createCell, getCells } from '../shared/notebook.js'
import { createSession, listVersions } from '../server/src/db.js'
import {
  beginHistory,
  cellsAt,
  flushHistory,
  forgetHistory,
  record,
} from '../server/src/collab/history.js'
import { shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

function room(sessionId: string, author: string | null = 'p_maria'): Y.Doc {
  createSession(sessionId, 'Shadow test', null)
  const doc = new Y.Doc()
  doc.on('update', (update: Uint8Array, _origin, _doc, tr: Y.Transaction) =>
    record(sessionId, doc, update, author, tr),
  )
  return doc
}

function write(doc: Y.Doc, index: number, text: string): void {
  const source = getCells(doc).get(index).get('source') as Y.Text
  source.insert(source.length, text)
}

/** A feed row keeps the cell list as text — the way it lies in the database. */
const touched = (row: { cells: string | string[] }): string[] =>
  typeof row.cells === 'string' ? (JSON.parse(row.cells) as string[]) : row.cells

const sources = (doc: Y.Doc) =>
  getCells(doc)
    .toArray()
    .map((cell) => (cell.get('source') as Y.Text).toString())

test('twenty bursts in a row: each version is about its own change, and the feed matches the notebook', () => {
  const id = 'shadow-steps'
  const doc = room(id)
  beginHistory(id, doc)
  doc.transact(() => getCells(doc).push([createCell('code', 'x = 1')]))
  flushHistory(id)

  for (let i = 0; i < 20; i++) {
    write(doc, 0, `\nstep ${i}`)
    flushHistory(id)
    const rows = listVersions(id, 40).filter((v) => v.kind === 'edit')
    const last = rows[0]
    assert.ok(last, `burst ${i} was not recorded`)
    assert.equal(touched(last).length, 1, `burst ${i} is not described by a single cell`)
    assert.ok(last.added > 0, `burst ${i} is recorded as "nothing changed"`)
  }

  // And most importantly: the last version is exactly what the notebook holds
  // now.
  const rows = listVersions(id, 40)
  assert.deepEqual(
    cellsAt(id, rows[0].seq).map((c) => c.source),
    sources(doc),
  )
})

test('a burst after the room was evicted is rebuilt and loses nothing', () => {
  const id = 'shadow-evicted'
  const doc = room(id)
  beginHistory(id, doc)
  doc.transact(() => getCells(doc).push([createCell('code', 'первая ячейка')]))
  doc.transact(() => getCells(doc).push([createCell('code', 'вторая ячейка')]))
  flushHistory(id)

  /*
   * The room was evicted from memory (ten minutes of emptiness) — the shadow
   * notebook is gone. The next edit must be described against the whole
   * notebook, not against emptiness: that is exactly the fallback path.
   */
  forgetHistory(id)
  beginHistory(id, doc)
  write(doc, 1, ' с дополнением')
  flushHistory(id)

  const rows = listVersions(id, 40)
  const last = rows[0]
  assert.equal(touched(last).length, 1, 'the edit touched one cell')
  assert.deepEqual(cellsAt(id, last.seq).map((c) => c.source), [
    'первая ячейка',
    'вторая ячейка с дополнением',
  ])
})

test('a full snapshot contains the whole notebook, not the last burst', () => {
  const id = 'shadow-keyframe'
  const doc = room(id)
  beginHistory(id, doc)
  doc.transact(() => getCells(doc).push([createCell('code', 'начало')]))
  flushHistory(id)

  // Many small edits in a row: a full snapshot will land somewhere in here.
  for (let i = 0; i < 40; i++) {
    write(doc, 0, `\nстрока ${i} ${'y'.repeat(2048)}`)
    flushHistory(id)
  }

  const rows = listVersions(id, 200)
  const keyframes = rows.filter((v) => v.kind === 'keyframe')
  assert.ok(keyframes.length > 0, 'a full snapshot never landed — nothing to check')

  /*
   * A snapshot is read on its own: `cellsAt` for its version starts the replay
   * right from it. Had it been written from one burst, here there would be a
   * one-line notebook — and "Restore" would hand that to the room.
   */
  const at = cellsAt(id, keyframes[0].seq)
  assert.equal(at.length, 1)
  assert.ok(
    at[0].source.startsWith('начало') && at[0].source.includes('строка 0'),
    'the snapshot lost everything before the last burst',
  )
})
