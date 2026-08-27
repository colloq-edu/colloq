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
  flushHistory,
  record,
  restoreInto,
} from '../server/src/collab/history.js'
import { diffLines } from '../shared/diff.js'
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
  // Adding the cell is its own version — a change of shape closes the burst.
  doc.transact(() => getCells(doc).push([createCell('code', 'x = 1')]))
  const before = listVersions(id, 20).filter((v) => v.kind === 'edit').length

  // Sixteen separate transactions, the way sixteen keystrokes arrive.
  for (const ch of '\nprint(x)\ny = 2\n') write(doc, 0, ch)
  flushHistory(id)

  const versions = listVersions(id, 20).filter((v) => v.kind === 'edit')
  assert.equal(versions.length, before + 1, 'sixteen keystrokes made more than one version')
  assert.equal(versions[0].author_id, 'p_maria')
  assert.match(versions[0].summary, /edited cell/)
})

test('двое, печатающие одновременно, дают одну версию комнаты, а не по одной на нажатие', () => {
  const id = 'hist-authors'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  let author = 'p_alexander'
  doc.on('update', (update: Uint8Array) => record(id, doc, update, author))

  doc.transact(() => getCells(doc).push([createCell('code', 'a = 1')]))
  flushHistory(id)
  const seeded = listVersions(id, 20).filter((v) => v.kind === 'edit').length

  // Раньше смена автора закрывала всплеск, и чередующиеся нажатия давали по
  // версии на каждое: сорок строк за минуту работы вдвоём.
  write(doc, 0, '\nb = 2')
  author = 'p_john'
  write(doc, 0, '\nc = 3')
  author = 'p_alexander'
  write(doc, 0, '\nd = 4')
  flushHistory(id)

  const versions = listVersions(id, 20).filter((v) => v.kind === 'edit')
  assert.equal(versions.length, seeded + 1)
  // Всплеск, в который писали двое, не принадлежит никому из них.
  assert.equal(versions[0].author_id, null)
})

test('всплеск одного человека по-прежнему подписан им', () => {
  const id = 'hist-one-author'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  doc.on('update', (update: Uint8Array) => record(id, doc, update, 'p_maria'))

  doc.transact(() => getCells(doc).push([createCell('code', 'a = 1')]))
  flushHistory(id)

  write(doc, 0, '\nb = 2')
  flushHistory(id)

  const versions = listVersions(id, 20).filter((v) => v.kind === 'edit')
  assert.equal(versions[0].author_id, 'p_maria')
})

test('output and run state are not versions', () => {
  const id = 'hist-noise'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'print(1)')]))
  flushHistory(id)
  // What the room reads: the list the route serves, which hides bookkeeping
  // rows. The raw table may well grow — a burst with nothing to say still
  // stores its bytes — and that is the point of the test after this one.
  const told = () => listVersions(id, 20).filter((v) => v.kind !== 'keyframe' && v.kind !== 'quiet')
  const before = told().length

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

  assert.equal(told().length, before, 'the kernel wrote itself into the timeline')
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

test('deleting a cell lands in the history at once, not after the silence', () => {
  /*
   * Typing is a stream and wants grouping; removing a cell is a discrete act,
   * and it is the act people open this panel to undo. Waiting out the idle
   * timer would hide it for twelve seconds — exactly while it is being looked
   * for.
   */
  const id = 'hist-structure'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  beginHistory(id, doc)
  doc.on('update', (update: Uint8Array) => record(id, doc, update, 'p_sofia'))

  doc.transact(() => getCells(doc).push([createCell('code', 'a'), createCell('code', 'b')]))
  const afterAdd = listVersions(id, 20).filter((v) => v.kind === 'edit').length
  assert.equal(afterAdd, 1, 'adding cells waited for the idle timer')

  doc.transact(() => getCells(doc).delete(1, 1))
  const afterDelete = listVersions(id, 20).filter((v) => v.kind === 'edit')
  assert.equal(afterDelete.length, 2, 'the deletion waited for the idle timer')
  assert.match(afterDelete[0].summary, /deleted a cell/)
})

/* ------------------------------------------- a quiet burst is still bytes */

/**
 * Yjs replay cannot skip an update: every later one names the clocks it was
 * built on. A burst that changed no text used to be dropped whole — row and
 * bytes — and every version rebuilt across that gap came out wrong. Two ways to
 * make such a burst, and both are ordinary seminar traffic.
 */
test('moving a cell does not corrupt the versions after it', () => {
  const id = 'hist-quiet-move'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'one'), createCell('code', 'two')]))
  flushHistory(id)

  // A move is a clone with the same id and text — Y.Array has no move — so
  // describe() sees nothing written and the burst is "quiet".
  doc.transact(() => {
    const cells = getCells(doc)
    const moved = cells.get(1)
    const clone = createCell('code', (moved.get('source') as Y.Text).toString())
    clone.set('id', moved.get('id'))
    cells.delete(1, 1)
    cells.insert(0, [clone])
  })
  flushHistory(id)

  // Typing after the move: this version is built on the move's clocks.
  write(doc, 0, ' more')
  flushHistory(id)

  const latest = listVersions(id, 50).filter((v) => v.kind === 'edit')[0]
  const rebuilt = cellsAt(id, latest.seq).map((c) => c.source)
  const live = getCells(doc).toArray().map((c) => (c.get('source') as Y.Text).toString())
  assert.deepEqual(rebuilt, live, 'the version rebuilt across the move is not the document')

  // The list still says nothing about it: quiet rows are stored, not shown.
  assert.ok(listVersions(id, 50).every((v) => v.kind !== 'quiet' || v.summary === ''))
})

test('the server writing an output before an edit does not corrupt the edit', () => {
  const id = 'hist-quiet-output'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'x=1')]))
  flushHistory(id)

  // An output landing: bytes in the document, nothing the timeline should say.
  doc.transact(() => {
    const cell = getCells(doc).get(0)
    cell.set('state', 'done')
    cell.set('execCount', 1)
  })
  flushHistory(id)

  // A real edit on top of it — say the formatter rewrote the cell.
  doc.transact(() => {
    const source = getCells(doc).get(0).get('source') as Y.Text
    source.delete(0, source.length)
    source.insert(0, 'x = 1')
  })
  flushHistory(id)

  const latest = listVersions(id, 50).filter((v) => v.kind === 'edit')[0]
  assert.deepEqual(
    cellsAt(id, latest.seq).map((c) => c.source),
    ['x = 1'],
    'the edit after an output-only burst rebuilt as something else',
  )

  // And restoring it is a no-op, not a wipe.
  const changed = restoreInto(id, doc, latest.seq, 'p_alexander', null, '18:04')
  assert.equal(changed, 0, 'restoring the current state changed the document')
  assert.equal((getCells(doc).get(0).get('source') as Y.Text).toString(), 'x = 1')
})

test('откат всего ноутбука возвращает и порядок', () => {
  /*
   * «Restore the whole notebook» возвращал только тексты и оставлял ячейки
   * там, куда их с тех пор перетащили, — это не тот ноутбук, ради которого
   * нажимали кнопку.
   */
  const id = 'hist-order'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'one'), createCell('code', 'two')]))
  flushHistory(id)
  const good = listVersions(id, 20).filter((v) => v.kind === 'edit')[0].seq

  // Переставляем так, как это делает редактор: клон с тем же id.
  doc.transact(() => {
    const cells = getCells(doc)
    const moved = cells.get(1)
    const clone = createCell('code', (moved.get('source') as Y.Text).toString(), moved.get('id') as string)
    cells.delete(1, 1)
    cells.insert(0, [clone])
  })
  flushHistory(id)
  assert.deepEqual(
    getCells(doc).toArray().map((c) => (c.get('source') as Y.Text).toString()),
    ['two', 'one'],
    'перестановка не применилась',
  )

  restoreInto(id, doc, good, 'p_alexander', null, '18:04')
  assert.deepEqual(
    getCells(doc).toArray().map((c) => (c.get('source') as Y.Text).toString()),
    ['one', 'two'],
    'порядок не вернулся',
  )
})

test('удалённая ячейка возвращается со своим id, и повтор не двоит', () => {
  const id = 'hist-reid'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'keep'), createCell('code', 'gone')])) 
  flushHistory(id)
  const good = listVersions(id, 20).filter((v) => v.kind === 'edit')[0].seq

  doc.transact(() => getCells(doc).delete(1, 1))
  flushHistory(id)

  restoreInto(id, doc, good, 'p_alexander', null, '18:04')
  restoreInto(id, doc, good, 'p_alexander', null, '18:05')
  assert.equal(getCells(doc).length, 2, 'второй откат сделал копию')
})

test('полный снимок пишется по накопленным байтам, а не каждые двадцать пять строк', () => {
  const id = 'hist-keyframes'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  doc.on('update', (update: Uint8Array) => record(id, doc, update, 'p_alexander'))

  doc.transact(() => getCells(doc).push([createCell('code', 'a = 1')]))
  flushHistory(id)

  // Тридцать маленьких правок — больше старого порога в двадцать пять строк, но
  // байтов в них на порядки меньше шестидесяти четырёх килобайт.
  for (let i = 0; i < 30; i++) {
    write(doc, 0, `\n# ${i}`)
    flushHistory(id)
  }

  const frames = listVersions(id, 200).filter((v) => v.kind === 'keyframe')
  // Потолок по строкам оставлен, так что один-два снимка здесь законны; смысл
  // проверки в том, что их не по одному на каждые двадцать пять байт правок.
  assert.ok(frames.length <= 2, `снимков ${frames.length}, ожидалось не больше двух`)
})
