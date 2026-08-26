/**
 * The room's history of itself.
 *
 * Two things have to hold for this to be worth having. A version has to be one
 * thing somebody did — not one keystroke, which is a log nobody reads, and not
 * a whole lesson, which hides the moment worth going back to. And the timeline
 * has to be about what the room *wrote*: the document also carries every line a
 * cell prints and every token the oracle streams, and a history buried under
 * those is a history nobody can find anything in.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createCell, getCells } from '../shared/notebook.js'
import { createSession } from '../server/src/db.js'
import { listVersions } from '../server/src/db.js'
import {
  beginHistory,
  cellsAt,
  diffLines,
  flushHistory,
  record,
  restoreInto,
} from '../server/src/collab/history.js'
import { shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

/**
 * A document wired the way the live one is: every update goes to the recorder,
 * tagged with whoever made it. This is the same hook collab/index.ts installs.
 */
function room(sessionId: string, author: string | null): Y.Doc {
  createSession(sessionId, 'History test', null)
  const doc = new Y.Doc()
  doc.on('update', (update: Uint8Array) => record(sessionId, doc, update, author))
  return doc
}

function write(doc: Y.Doc, index: number, text: string): void {
  const cells = getCells(doc)
  const source = cells.get(index).get('source') as Y.Text
  source.insert(source.length, text)
}

test('a burst of typing is one version, not one per keystroke', () => {
  const id = 'hist-burst'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'x = 1')]))
  // Twenty separate transactions, the way twenty keystrokes arrive.
  for (const ch of '\nprint(x)\ny = 2\n') write(doc, 0, ch)
  flushHistory(id)

  const versions = listVersions(id, 10).filter((v) => v.kind !== 'keyframe')
  assert.equal(versions.length, 1, 'twenty keystrokes made more than one version')
  assert.equal(versions[0].author_id, 'p_maria')
  assert.match(versions[0].summary, /added a cell|edited cell/)
})

test('a different author closes the burst, because it is a different thing done', () => {
  const id = 'hist-authors'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  let author = 'p_alexander'
  doc.on('update', (update: Uint8Array) => record(id, doc, update, author))

  doc.transact(() => getCells(doc).push([createCell('code', 'a = 1')]))
  write(doc, 0, '\nb = 2')
  author = 'p_john'
  write(doc, 0, '\nc = 3')
  flushHistory(id)

  const versions = listVersions(id, 10).filter((v) => v.kind !== 'keyframe')
  assert.equal(versions.length, 2)
  // Newest first.
  assert.equal(versions[0].author_id, 'p_john')
  assert.equal(versions[1].author_id, 'p_alexander')
})

test('output and run state are not versions', () => {
  const id = 'hist-noise'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'print(1)')]))
  flushHistory(id)
  const before = listVersions(id, 20).length

  // The kernel writing back: a run count, a state, a stream of output. All of
  // it is a real change to the document and none of it is something a person
  // wrote, so none of it belongs in a list of what people did.
  doc.transact(() => {
    const cell = getCells(doc).get(0)
    cell.set('state', 'running')
    cell.set('execCount', 7)
  })
  doc.transact(() => {
    const cell = getCells(doc).get(0)
    cell.set('state', 'ok')
  })
  flushHistory(id)

  assert.equal(listVersions(id, 20).length, before, 'the kernel wrote itself into the timeline')
})

test('a version can be read back as the notebook it was', () => {
  const id = 'hist-read'
  const doc = room(id, 'p_alexander')
  doc.transact(() => getCells(doc).push([createCell('code', 'first')]))
  flushHistory(id)
  const first = listVersions(id, 10).filter((v) => v.kind !== 'keyframe')[0].seq

  write(doc, 0, ' and second')
  flushHistory(id)
  const second = listVersions(id, 10).filter((v) => v.kind !== 'keyframe')[0].seq

  assert.notEqual(first, second)
  assert.equal(cellsAt(id, first)[0].source, 'first')
  assert.equal(cellsAt(id, second)[0].source, 'first and second')
})

test('a deleted cell is still in the version that had it', () => {
  const id = 'hist-deleted'
  const doc = room(id, 'p_sofia')
  doc.transact(() => getCells(doc).push([createCell('code', 'keep'), createCell('code', 'doomed')]))
  flushHistory(id)
  const both = listVersions(id, 10).filter((v) => v.kind !== 'keyframe')[0].seq

  doc.transact(() => getCells(doc).delete(1, 1))
  flushHistory(id)

  const then = cellsAt(id, both)
  assert.equal(then.length, 2, 'the version lost the cell that was deleted after it')
  assert.equal(then[1].source, 'doomed')
})

test('the diff is by line, so a changed argument shows as a changed line', () => {
  const lines = diffLines('model = Net(64)\nmodel.cuda()', 'model = Net(32)\nmodel.cuda()')
  assert.deepEqual(
    lines.map((l) => l.kind),
    ['removed', 'added', 'same'],
  )
  assert.equal(lines[0].text, 'model = Net(64)')
  assert.equal(lines[1].text, 'model = Net(32)')
})

test('a diff against nothing is all additions', () => {
  const lines = diffLines('', 'one\ntwo')
  assert.deepEqual(lines.map((l) => l.kind), ['added', 'added'])
})

test('a version can be rebuilt in a room that has no keyframe yet', () => {
  /*
   * The failure this guards against was silent and total: with no row carrying
   * a whole document, replaying the oldest version applied a delta to an empty
   * notebook and returned no cells at all — the history looked like it worked
   * and gave back nothing.
   */
  const id = 'hist-base'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  beginHistory(id, doc)
  doc.on('update', (update: Uint8Array) => record(id, doc, update, 'p_alexander'))

  doc.transact(() => getCells(doc).push([createCell('code', 'import pandas as pd')]))
  flushHistory(id)

  const versions = listVersions(id, 10).filter((v) => v.kind === 'edit')
  assert.equal(versions.length, 1)
  const cells = cellsAt(id, versions[0].seq)
  assert.equal(cells.length, 1, 'the version rebuilt to an empty notebook')
  assert.equal(cells[0].source, 'import pandas as pd')
})

test('the room opening is the first thing in its history', () => {
  const id = 'hist-opened'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  doc.transact(() => getCells(doc).push([createCell('markdown', 'Week 1')]))
  beginHistory(id, doc)

  const rows = listVersions(id, 10)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'opened')
  // And it carries the notebook, not a delta.
  assert.equal(cellsAt(id, rows[0].seq)[0].source, 'Week 1')
})

test('a restore puts the old text back, and is itself a version', () => {
  const id = 'hist-restore'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  beginHistory(id, doc)
  doc.on('update', (update: Uint8Array) => record(id, doc, update, 'p_maria'))

  doc.transact(() => getCells(doc).push([createCell('code', 'model = Net(64)')]))
  flushHistory(id)
  const good = listVersions(id, 10).filter((v) => v.kind === 'edit')[0].seq

  // Somebody breaks it.
  const source = getCells(doc).get(0).get('source') as Y.Text
  doc.transact(() => {
    source.delete(0, source.length)
    source.insert(0, 'model = Net(999999)')
  })
  flushHistory(id)
  assert.equal(source.toString(), 'model = Net(999999)')

  const changed = restoreInto(id, doc, good, 'p_alexander', null, '18:04')
  assert.equal(changed, 1)
  assert.equal(source.toString(), 'model = Net(64)', 'the text did not come back')

  const rows = listVersions(id, 10)
  assert.equal(rows[0].kind, 'restore', 'the restore left no trace of itself')
  assert.equal(rows[0].author_id, 'p_alexander')
  assert.match(rows[0].summary, /restored the version from 18:04/)
})

test('a restore of an unchanged version writes nothing', () => {
  const id = 'hist-noop'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  beginHistory(id, doc)
  doc.on('update', (update: Uint8Array) => record(id, doc, update, 'p_maria'))
  doc.transact(() => getCells(doc).push([createCell('code', 'unchanged')]))
  flushHistory(id)

  const seq = listVersions(id, 10).filter((v) => v.kind === 'edit')[0].seq
  const before = listVersions(id, 20).length
  assert.equal(restoreInto(id, doc, seq, 'p_alexander', null, '18:04'), 0)
  assert.equal(listVersions(id, 20).length, before, 'a restore that changed nothing left a row')
})

test('a deleted cell comes back when its version is restored', () => {
  const id = 'hist-revive'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  beginHistory(id, doc)
  doc.on('update', (update: Uint8Array) => record(id, doc, update, 'p_sofia'))

  doc.transact(() => getCells(doc).push([createCell('code', 'keep'), createCell('code', 'doomed')]))
  flushHistory(id)
  const both = listVersions(id, 10).filter((v) => v.kind === 'edit')[0].seq

  doc.transact(() => getCells(doc).delete(1, 1))
  flushHistory(id)
  assert.equal(getCells(doc).length, 1)

  restoreInto(id, doc, both, 'p_alexander', null, '18:12')
  const sources = getCells(doc)
    .toArray()
    .map((c) => (c.get('source') as Y.Text).toString())
  assert.ok(sources.includes('doomed'), 'the deleted cell stayed deleted')
})
