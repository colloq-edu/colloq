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
import { cloneCell, createCell, getCells } from '../shared/notebook.js'
import { createSession } from '../server/src/db.js'
import { db, listStoryVersions, listVersions } from '../server/src/db.js'
import {
  beginHistory,
  cellsAt,
  discardBurst,
  flushHistory,
  mark,
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
  assert.match(versions[0].summary, /правил ячейку/)
})

test('two people typing at the same time make one room version, not one per keystroke', () => {
  const id = 'hist-authors'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  let author = 'p_alexander'
  doc.on('update', (update: Uint8Array) => record(id, doc, update, author))

  doc.transact(() => getCells(doc).push([createCell('code', 'a = 1')]))
  flushHistory(id)
  const seeded = listVersions(id, 20).filter((v) => v.kind === 'edit').length

  // Previously a change of author closed the burst, and alternating keystrokes
  // gave a version each: forty rows for a minute of two people working.
  write(doc, 0, '\nb = 2')
  author = 'p_john'
  write(doc, 0, '\nc = 3')
  author = 'p_alexander'
  write(doc, 0, '\nd = 4')
  flushHistory(id)

  const versions = listVersions(id, 20).filter((v) => v.kind === 'edit')
  assert.equal(versions.length, seeded + 1)
  // A burst two people wrote into belongs to neither of them.
  assert.equal(versions[0].author_id, null)
})

test('a burst by one person is still signed by them', () => {
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
  assert.deepEqual(
    lines.map((l) => l.kind),
    ['added', 'added'],
  )
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

  const changed = restoreInto(id, doc, good, 'p_alexander', null)
  assert.equal(changed, 1)
  assert.equal(source.toString(), 'model = Net(64)', 'the text did not come back')

  const rows = listVersions(id, 10)
  assert.equal(rows[0].kind, 'restore', 'the restore left no trace of itself')
  assert.equal(rows[0].author_id, 'p_alexander')
  assert.match(rows[0].summary, /вернул версию/)
  // There is no time in the caption: the viewer draws it, going by this
  // reference.
  assert.equal(rows[0].target_seq, good, 'the restore did not name the version it brought back')
  assert.ok(!/\d\d:\d\d/.test(rows[0].summary), 'the server wrote the time into the caption again')
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
  assert.equal(restoreInto(id, doc, seq, 'p_alexander', null), 0)
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

  restoreInto(id, doc, both, 'p_alexander', null)
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
  assert.match(afterDelete[0].summary, /удалил ячейку/)
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
  const live = getCells(doc)
    .toArray()
    .map((c) => (c.get('source') as Y.Text).toString())
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
  const changed = restoreInto(id, doc, latest.seq, 'p_alexander', null)
  assert.equal(changed, 0, 'restoring the current state changed the document')
  assert.equal((getCells(doc).get(0).get('source') as Y.Text).toString(), 'x = 1')
})

test('restoring the whole notebook brings back the order too', () => {
  /*
   * "Restore the whole notebook" brought back only the texts and left the
   * cells where they had been dragged since — that is not the notebook the
   * button was pressed for.
   */
  const id = 'hist-order'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'one'), createCell('code', 'two')]))
  flushHistory(id)
  const good = listVersions(id, 20).filter((v) => v.kind === 'edit')[0].seq

  // Reorder the way the editor does it: a clone with the same id.
  doc.transact(() => {
    const cells = getCells(doc)
    const moved = cells.get(1)
    const clone = createCell(
      'code',
      (moved.get('source') as Y.Text).toString(),
      moved.get('id') as string,
    )
    cells.delete(1, 1)
    cells.insert(0, [clone])
  })
  flushHistory(id)
  assert.deepEqual(
    getCells(doc)
      .toArray()
      .map((c) => (c.get('source') as Y.Text).toString()),
    ['two', 'one'],
    'the reordering did not apply',
  )

  restoreInto(id, doc, good, 'p_alexander', null)
  assert.deepEqual(
    getCells(doc)
      .toArray()
      .map((c) => (c.get('source') as Y.Text).toString()),
    ['one', 'two'],
    'the order did not come back',
  )
})

test('a deleted cell comes back with its own id, and a repeat does not duplicate it', () => {
  const id = 'hist-reid'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'keep'), createCell('code', 'gone')]))
  flushHistory(id)
  const good = listVersions(id, 20).filter((v) => v.kind === 'edit')[0].seq

  doc.transact(() => getCells(doc).delete(1, 1))
  flushHistory(id)

  restoreInto(id, doc, good, 'p_alexander', null)
  restoreInto(id, doc, good, 'p_alexander', null)
  assert.equal(getCells(doc).length, 2, 'the second restore made a copy')
})

test('a full snapshot is written by accumulated bytes, not every twenty-five rows', () => {
  const id = 'hist-keyframes'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  doc.on('update', (update: Uint8Array) => record(id, doc, update, 'p_alexander'))

  doc.transact(() => getCells(doc).push([createCell('code', 'a = 1')]))
  flushHistory(id)

  // Thirty small edits — more than the old threshold of twenty-five rows, but
  // with orders of magnitude fewer bytes than sixty-four kilobytes.
  for (let i = 0; i < 30; i++) {
    write(doc, 0, `\n# ${i}`)
    flushHistory(id)
  }

  const frames = listVersions(id, 200).filter((v) => v.kind === 'keyframe')
  // The row cap was kept, so one or two snapshots are legitimate here; the
  // point of the check is that there is not one per every twenty-five bytes
  // of edits.
  assert.ok(frames.length <= 2, `${frames.length} snapshots, expected no more than two`)
})

/* -------------------------------------- authorship, the feed and repair */

test('kernel output in the middle of typing does not take the author away from the edit', () => {
  /*
   * Server writes — outputs, the run number, the state, the Oracle stream —
   * arrive without an author and joined the burst on a par with people: two
   * authors, and the version became "the room · edited cell 01" with no name
   * and no colour. There were not two: one person was typing, and a cell was
   * running next to it.
   */
  const id = 'hist-kernel-author'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  let author: string | null = 'p_maria'
  doc.on('update', (update: Uint8Array) => record(id, doc, update, author))

  doc.transact(() => getCells(doc).push([createCell('code', 'train()')]))
  flushHistory(id)

  // The kernel prints, a person edits the neighbouring text — all in one
  // burst.
  author = null
  doc.transact(() => {
    const cell = getCells(doc).get(0)
    cell.set('state', 'running')
    cell.set('execCount', 3)
  })
  author = 'p_maria'
  write(doc, 0, '\n# ещё строка')
  flushHistory(id)

  const versions = listVersions(id, 20).filter((v) => v.kind === 'edit')
  assert.equal(versions[0].author_id, 'p_maria', 'the edit was attributed to the room')
})

test('the feed does not drown in bookkeeping rows', () => {
  /*
   * The four-hundred-row window was cut before the filter, and during a class
   * with running cells there are more quiet rows than edits: the edits of the
   * first hour and the "before the exercise" checkpoint disappeared from the
   * panel while staying in the database.
   */
  const id = 'hist-window'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  let author: string | null = 'p_maria'
  doc.on('update', (update: Uint8Array) => record(id, doc, update, author))

  doc.transact(() => getCells(doc).push([createCell('code', 'x = 1')]))
  flushHistory(id)

  // Twenty bursts in a row in which only the kernel printed.
  author = null
  for (let i = 0; i < 20; i++) {
    doc.transact(() => getCells(doc).get(0).set('execCount', i))
    flushHistory(id)
  }

  const window = 5
  const story = listStoryVersions(id, window)
  assert.ok(story.length > 0, 'the edit fell out of the feed window')
  assert.ok(
    story.every((v) => v.kind !== 'quiet' && v.kind !== 'keyframe'),
    'a bookkeeping row got into the feed',
  )
  // While in the raw table the same five rows are almost all bookkeeping.
  assert.ok(
    listVersions(id, window).some((v) => v.kind === 'quiet'),
    'no quiet rows appeared — the check proves nothing',
  )
})

test('a checkpoint is not pushed out of the feed by edits', () => {
  /*
   * Filtering out bookkeeping rows is not enough: during an active class
   * there are hundreds of edits, and the feed window fills up with them alone.
   * A checkpoint is set in order to return to it at the end of class — it must
   * stay visible even after more has been typed on top of it than fits in the
   * window.
   */
  const id = 'hist-checkpoint-window'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'x = 1')]))
  flushHistory(id)
  const seq = mark(id, doc, 'checkpoint', 'p_maria', 'before the exercise', '')

  // Edits on top of the checkpoint — more than the feed window.
  for (let i = 0; i < 10; i++) {
    write(doc, 0, `\ny = ${i}`)
    flushHistory(id)
  }

  const window = 3
  const story = listStoryVersions(id, window)
  assert.ok(
    story.some((v) => v.seq === seq && v.kind === 'checkpoint'),
    'the checkpoint was pushed out of the feed by edits',
  )
  // The check proves something only while there really are more edits than
  // the window holds.
  assert.equal(
    story.filter((v) => v.kind === 'edit').length,
    window,
    'fewer edits than the window — there was nothing to push it out with',
  )
})

test('after a hard process exit the history catches up with the notebook', () => {
  /*
   * The document snapshot is written after seconds, while the history row is
   * written when the burst closes. Kill the process between them (kill -9,
   * OOM, a power cut) — and text remains on disk that is not in the history:
   * all further deltas refer to clocks that will not be in the chain, Yjs puts
   * them in pending, and the feed freezes at the pre-crash state, while
   * "Restore" writes it over the live notebook.
   */
  const id = 'hist-crash'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  beginHistory(id, doc)
  doc.on('update', (update: Uint8Array) => record(id, doc, update, 'p_maria'))

  doc.transact(() => getCells(doc).push([createCell('code', 'a = 1')]))
  flushHistory(id)

  // Typed but not written: the burst is open, and the process is gone.
  write(doc, 0, '\nb = 2\nc = 3')
  discardBurst(id)

  // The server came up: the document came from the snapshot, the history from
  // the database.
  beginHistory(id, doc)
  doc.on('update', (update: Uint8Array) => record(id, doc, update, 'p_maria'))
  write(doc, 0, '\nd = 4')
  flushHistory(id)

  const latest = listVersions(id, 50)[0]
  const live = (getCells(doc).get(0).get('source') as Y.Text).toString()
  assert.equal(cellsAt(id, latest.seq)[0].source, live, 'the version after the crash is not the notebook')
})

test('a version that failed to be written does not cut off the history forever', () => {
  /*
   * The burst's bytes are thrown away together with the row, and the next
   * delta refers to clocks that are not in the chain. Previously the feed
   * after that kept filling up with unreadable rows until the end of the
   * seminar.
   */
  const id = 'hist-write-fail'
  createSession(id, 'History test', null)
  const doc = new Y.Doc()
  beginHistory(id, doc)
  doc.on('update', (update: Uint8Array) => record(id, doc, update, 'p_maria'))

  doc.transact(() => getCells(doc).push([createCell('code', 'a = 1')]))
  flushHistory(id)

  // For a second the database does not accept writes: a full disk, an I/O
  // error.
  write(doc, 0, '\nb = 2')
  db.pragma('query_only = ON')
  flushHistory(id)
  db.pragma('query_only = OFF')

  write(doc, 0, '\nc = 3')
  flushHistory(id)

  const latest = listVersions(id, 50)[0]
  const live = (getCells(doc).get(0).get('source') as Y.Text).toString()
  assert.equal(cellsAt(id, latest.seq)[0].source, live, 'the history stayed in the past')
})

/* -------------------------------------------------- restoring a version */

test('restoring a version brings back the cell type too', () => {
  const id = 'hist-type'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'model.fit()')]))
  flushHistory(id)
  const good = listVersions(id, 20).filter((v) => v.kind === 'edit')[0].seq

  // Someone pressed "to markdown" — the same text, a different type.
  doc.transact(() => getCells(doc).get(0).set('type', 'markdown'))
  flushHistory(id)

  const changed = restoreInto(id, doc, good, 'p_alexander', null)
  assert.equal(changed, 1, 'restoring just the type did nothing')
  assert.equal(getCells(doc).get(0).get('type'), 'code', 'the cell stayed markdown')
})

test('"restore this cell" puts it back in its old place, not at the end', () => {
  const id = 'hist-place'
  const doc = room(id, 'p_maria')
  doc.transact(() =>
    getCells(doc).push([
      createCell('code', 'one'),
      createCell('code', 'two'),
      createCell('code', 'three'),
    ]),
  )
  flushHistory(id)
  const all = listVersions(id, 20).filter((v) => v.kind === 'edit')[0].seq
  const middle = getCells(doc).get(1).get('id') as string

  doc.transact(() => getCells(doc).delete(1, 1))
  flushHistory(id)

  restoreInto(id, doc, all, 'p_alexander', middle)
  assert.deepEqual(
    getCells(doc)
      .toArray()
      .map((c) => (c.get('source') as Y.Text).toString()),
    ['one', 'two', 'three'],
    'the cell came back to the wrong place',
  )
})

test('restoring a version moves only the cells that shifted, not the whole sheet', () => {
  /*
   * Recreating a cell carries off keystrokes that went into its old `Y.Text`
   * one round trip before reaching the server: the gate lets a write into a
   * tombstone through, and the characters vanish silently. A version restore
   * that rebuilt the whole sheet with clones robbed everyone who was typing at
   * that second in this way — for the sake of one cell that had moved.
   */
  const id = 'hist-reorder'
  const doc = room(id, 'p_maria')
  doc.transact(() =>
    getCells(doc).push([
      createCell('code', 'a'),
      createCell('code', 'b'),
      createCell('code', 'c'),
      createCell('code', 'd'),
    ]),
  )
  flushHistory(id)
  const good = listVersions(id, 20).filter((v) => v.kind === 'edit')[0].seq

  // The last one was lifted to the top — as a clone, the way reordering does
  // it.
  doc.transact(() => {
    const cells = getCells(doc)
    const moved = cloneCell(cells.get(3))
    cells.delete(3, 1)
    cells.insert(0, [moved])
  })
  flushHistory(id)
  const before = getCells(doc)
    .toArray()
    .map((cell) => cell.get('source') as Y.Text)

  restoreInto(id, doc, good, 'p_alexander', null)

  const cells = getCells(doc)
  assert.deepEqual(
    cells.toArray().map((c) => (c.get('source') as Y.Text).toString()),
    ['a', 'b', 'c', 'd'],
    'the order did not come back',
  )
  // Through `ok`, not `equal`: when two `Y.Text` are unequal, node prints a
  // dump of both, and the whole notebook is visible from them.
  assert.ok(cells.get(0).get('source') === before[1], 'cell "a" was recreated for nothing')
  assert.ok(cells.get(1).get('source') === before[2], 'cell "b" was recreated for nothing')
  assert.ok(cells.get(2).get('source') === before[3], 'cell "c" was recreated for nothing')
  assert.ok(cells.get(3).get('source') !== before[0], 'cell "d" did not move')
})

test('of two swapped cells, the one with the caret in it stays', () => {
  const id = 'hist-reorder-caret'
  const doc = room(id, 'p_maria')
  doc.transact(() => getCells(doc).push([createCell('code', 'a'), createCell('code', 'b')]))
  flushHistory(id)
  const good = listVersions(id, 20).filter((v) => v.kind === 'edit')[0].seq

  // The first one was moved down: now the order is reversed, and only one of
  // the two can stay in place.
  doc.transact(() => {
    const cells = getCells(doc)
    const moved = cloneCell(cells.get(0))
    cells.delete(0, 1)
    cells.insert(1, [moved])
  })
  flushHistory(id)
  const typing = getCells(doc).get(1)
  const text = typing.get('source') as Y.Text

  restoreInto(id, doc, good, 'p_alexander', null, new Set([typing.get('id') as string]))

  const cells = getCells(doc)
  assert.deepEqual(
    cells.toArray().map((c) => (c.get('source') as Y.Text).toString()),
    ['a', 'b'],
    'the order did not come back',
  )
  assert.ok(cells.get(0).get('source') === text, 'the cell being typed in was recreated')
})

/* ---------------------------------------------------------- large diff */

test('the diff of a long cell does not compute the whole quadratic table', () => {
  /*
   * A cell of ten thousand lines — a log or a CSV — was diffed synchronously
   * in the request handler: seconds of blocking the whole instance and
   * hundreds of megabytes of heap on every click on a feed row.
   */
  const lines = Array.from({ length: 20_000 }, (_, i) => `row ${i}`)
  const before = lines.join('\n')
  lines[10_000] = 'row 10000 — правка'
  const after = lines.join('\n')

  const began = Date.now()
  const diff = diffLines(before, after)
  assert.ok(Date.now() - began < 1_000, `the diff took ${Date.now() - began} ms`)
  assert.deepEqual(
    diff.filter((l) => l.kind !== 'same').map((l) => l.text),
    ['row 10000', 'row 10000 — правка'],
  )
  assert.equal(diff.filter((l) => l.kind === 'same').length, 19_999)
})

test('a whole replacement comes out as one chunk, not as a table of four hundred million cells', () => {
  const before = Array.from({ length: 3_000 }, (_, i) => `old ${i}`).join('\n')
  const after = Array.from({ length: 3_000 }, (_, i) => `new ${i}`).join('\n')
  const began = Date.now()
  const diff = diffLines(before, after)
  assert.ok(Date.now() - began < 1_000, `the diff took ${Date.now() - began} ms`)
  assert.equal(diff.filter((l) => l.kind === 'removed').length, 3_000)
  assert.equal(diff.filter((l) => l.kind === 'added').length, 3_000)
})
