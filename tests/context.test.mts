/**
 * What the oracle is told about the notebook.
 *
 * This is the part of the feature that fails silently: the context is trimmed
 * to fit a window, and if the trimming drops the cell the student selected or
 * the traceback they are staring at, the answer is confidently about the wrong
 * thing. Nobody sees a bug; they see a bad oracle.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import {
  bookCells,
  cellOutputs,
  cellSource,
  createCell,
  getCells,
  getMeta,
} from '../shared/notebook.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { createBook } from '../server/src/collab/books.js'
import { buildContext } from '../server/src/ai/context.js'
import { updateOracleSettings } from '../server/src/admin/settings.js'
import { sessionDir } from '../server/src/workspace.js'

/** Announce through the room's presence which file a person has open. */
function editing(sessionId: string, participantId: string, path: string): void {
  getSessionDoc(sessionId).awareness.setLocalState({ user: { id: participantId, editing: path } })
}

/*
 * Binding a document starts a snapshot timer per seminar. Without this the
 * process never exits, and `node --test` — which buffers a file's output until
 * the file finishes — prints nothing at all and looks like a hang.
 */
after(() => shutdownCollab())

let seq = 0
/** A seminar with `count` code cells, each a distinctive block of source. */
function seminar(count: number, big = false): { id: string; doc: Y.Doc; ids: string[] } {
  const id = `ctx${seq++}`
  createSession(id, `Context seminar ${id}`)
  const { doc } = getSessionDoc(id)
  getMeta(doc).set('kernelStatus', 'idle')
  const cells = getCells(doc)
  // getSessionDoc seeds the welcome notebook. These tests are about what the
  // budget keeps and drops, so the notebook has to be exactly what they say.
  cells.delete(0, cells.length)
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const cell = createCell('code', '')
    cells.push([cell])
    const line = big ? `x${i} = "${'p'.repeat(400)}"\n` : `marker_${i} = ${i}\n`
    const source = cellSource(cell)
    source.insert(0, line.repeat(big ? 6 : 1))
    ids.push(cell.get('id') as string)
  }
  return { id, doc, ids }
}

function failAt(doc: Y.Doc, index: number, ename: string): void {
  const cell = getCells(doc).get(index)
  cell.set('state', 'error')
  cell.set('execCount', 40 + index)
  cellOutputs(cell).push([
    new Y.Map(
      Object.entries({
        kind: 'error',
        json: JSON.stringify({
          ename,
          evalue: 'CUDA out of memory',
          traceback: [`Tried to allocate 2.00 GiB — ${ename}`],
        }),
      }),
    ),
  ])
}

test('the context names the seminar, the kernel and every cell', () => {
  const { id, ids } = seminar(3)
  const text = buildContext(id, [ids[1]])
  assert.match(text, /SESSION: Context seminar/)
  assert.match(text, /KERNEL: idle/)
  assert.match(text, /NOTEBOOKS \(3 cells/)
  assert.match(text, /marker_0/)
  assert.match(text, /marker_2/)
})

test('the selected cell is pointed at, so the model knows what "this" means', () => {
  const { id, ids } = seminar(3)
  const text = buildContext(id, [ids[2]])
  // The number is the one a person sees in the cell's gutter: 1-based, with a
  // leading zero. A zero-based index silently disagreed with everything else.
  assert.match(text, /ASKING ABOUT: cell 03/)
  assert.match(text, /ASKED ABOUT/)
})

test('no selection is stated rather than guessed', () => {
  const { id } = seminar(2)
  assert.match(buildContext(id, []), /nothing in particular/)
})

test('a traceback reaches the model', () => {
  const { id, doc, ids } = seminar(3)
  failAt(doc, 1, 'RuntimeError')
  const text = buildContext(id, [ids[1]])
  assert.match(text, /RuntimeError: CUDA out of memory/)
  assert.match(text, /Tried to allocate/)
})

test('a big notebook is trimmed, but never the cell the question is about', () => {
  const { id, doc, ids } = seminar(40, true)
  failAt(doc, 7, 'ValueError')
  const selected = 33
  const text = buildContext(id, [ids[selected]])

  // The budget is real: this notebook does not fit whole.
  assert.ok(text.length <= 20_000, `context is ${text.length} chars`)
  assert.match(text, /truncated|elided/, 'nothing was trimmed, so this proves nothing')

  // ...and the two things the question depends on survived it.
  assert.match(text, new RegExp(`ASKING ABOUT: cell ${String(selected + 1).padStart(2, '0')}`))
  assert.match(text, /x33 = /, 'the selected cell was elided')
  assert.match(text, /ValueError/, 'the newest traceback was elided')
})

test('the newest failure wins when several cells have failed', () => {
  const { id, doc, ids } = seminar(30, true)
  failAt(doc, 2, 'OldestError')
  failAt(doc, 20, 'NewestError')
  // Seminars run cells out of order all the time; "newest" is the highest
  // execution count, not the lowest cell on the page.
  const text = buildContext(id, [ids[29]])
  assert.match(text, /NewestError/)
})

test('an empty notebook still produces a usable context', () => {
  const { id } = seminar(0)
  const text = buildContext(id, [])
  assert.match(text, /NOTEBOOKS \(0 cells/)
  assert.ok(text.length > 0)
})

test('a selected id that no longer exists does not break the context', () => {
  const { id } = seminar(3)
  assert.doesNotThrow(() => buildContext(id, ['c_deleted']))
  assert.match(buildContext(id, ['c_deleted']), /nothing in particular/)
})

/* ------------------------------------------------- the budget is a budget */

/**
 * One cell can be bigger than the whole allowance — a student pastes a CSV into
 * a notebook and that is the cell they ask about, so it can never be dropped.
 * The context still has to come in under the number the teacher typed, and it
 * used to come in 28 characters over: the sentence explaining the truncation
 * was added after the limit was applied.
 */
test('a single cell larger than the whole budget still fits the budget', () => {
  const id = `ctxbig${seq++}`
  createSession(id, 'One enormous cell')
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  cells.delete(0, cells.length)
  const cell = createCell('code', '')
  cells.push([cell])
  cellSource(cell).insert(0, `data = "${'q'.repeat(200_000)}"`)

  const text = buildContext(id, [cell.get('id') as string])
  assert.ok(text.length <= 20_000, `context is ${text.length} chars, over the 20000 budget`)
  // And it is still a usable context, not just a short one.
  assert.match(text, /SESSION: One enormous cell/)
  assert.match(text, /ASKING ABOUT: cell 01/)
})

/**
 * The model reads that number and can reason with it — "half the file is
 * missing" is a different situation from "two lines are missing". Making the
 * marker fit inside the budget is exactly the change that could have made this
 * figure a lie, since what is kept is now shorter than the limit; this is here
 * so that it did not.
 */
test('the truncation marker says how much really went', () => {
  const id = `ctxmark${seq++}`
  createSession(id, 'Marked')
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  cells.delete(0, cells.length)
  const cell = createCell('code', '')
  cells.push([cell])
  // 60k, so the whole thing fits inside the largest budget a teacher can set
  // and the untruncated length below is the real one rather than another clip.
  cellSource(cell).insert(0, `data = "${'q'.repeat(60_000)}"`)
  const cellId = cell.get('id') as string

  updateOracleSettings({ contextChars: 100_000 })
  const whole = buildContext(id, [cellId]).length
  updateOracleSettings({ contextChars: 20_000 })
  const text = buildContext(id, [cellId])

  const claimed = /… truncated (\d+) chars …/.exec(text)
  assert.ok(claimed, 'nothing said anything had been truncated')
  const dropped = Number(claimed[1])
  const marker = claimed[0].length + 2 // the marker sits between two newlines
  const accounted = text.length - marker + dropped
  // Whitespace at the two cut edges is trimmed, so a few characters go
  // unaccounted; anything more than that means the figure is made up.
  assert.ok(
    Math.abs(accounted - whole) <= 8,
    `the marker claims ${dropped} dropped, which leaves ${accounted} of ${whole} accounted for`,
  )
})

test('one seminar never sees another one', () => {
  const a = seminar(3)
  const b = seminar(3)
  getCells(b.doc).get(0).get('source')
  const cell = getCells(b.doc).get(1)
  cellSource(cell).insert(0, 'SECRET_FROM_THE_OTHER_ROOM = 1\n')

  const text = buildContext(a.id, [a.ids[0]])
  assert.ok(
    !text.includes('SECRET_FROM_THE_OTHER_ROOM'),
    "another seminar's notebook was in the context",
  )
  assert.match(text, new RegExp(`Context seminar ${a.id}`))
})

test('in a large notebook the selected cell arrives whole', () => {
  /*
   * One-line placeholders per cell ate the budget by themselves, and the final
   * trim cut the text in the middle — exactly where the anchor is. A question
   * about a cell went out without it, while the "Sees cell NN" chip in the
   * panel stayed lit.
   */
  const { id, doc, ids } = seminar(40)
  const source = cellSource(getCells(doc).get(35))
  source.delete(0, source.length)
  source.insert(0, 'THE_ONE_THEY_ASKED_ABOUT = 1\n')
  updateOracleSettings({ contextChars: 900 })
  try {
    const text = buildContext(id, [ids[35]])
    assert.ok(text.includes('THE_ONE_THEY_ASKED_ABOUT'), 'the selected cell did not arrive')
    assert.match(text, /cells \d+–\d+/, 'the gaps were not folded into ranges')
  } finally {
    updateOracleSettings({ contextChars: 20_000 })
  }
})

test('when even the folded version does not fit, the selected cell still arrives', () => {
  /*
   * Folding the gaps into ranges saves the day almost always — but not when
   * the budget is smaller than the pinned blocks themselves: a cell with a
   * large output, two pinned ones in a row. Then the old trim cut the middle,
   * and the middle is exactly the cell being asked about. Better to drop the
   * overview and keep it.
   */
  const { id, doc, ids } = seminar(40)
  const source = cellSource(getCells(doc).get(20))
  source.delete(0, source.length)
  source.insert(0, `NEEDLE = 1\n${'# заполнитель\n'.repeat(40)}`)

  updateOracleSettings({ contextChars: 400 })
  try {
    const text = buildContext(id, [ids[20]])
    assert.ok(text.includes('NEEDLE'), 'the selected cell did not arrive under a tight budget')
  } finally {
    updateOracleSettings({ contextChars: 20_000 })
  }
})

/* ------------------------------------------ several notebooks and cells */

test("ALL of the room's notebooks get into the frame, not just the first", () => {
  const { id, doc } = seminar(2)
  const second = createBook(id, 'вторая.ipynb')
  assert.ok(second.ok)
  doc.transact(() => bookCells(doc, second.book.root).push([createCell('code', 'ИЗ_ВТОРОЙ = 1')]))

  const text = buildContext(id, [])
  assert.match(text, /marker_0/, 'the first notebook went missing')
  assert.match(text, /ИЗ_ВТОРОЙ/, 'the second notebook did not arrive, so a question about it went into the void')
  assert.match(text, /### notebook вторая\.ipynb/, 'it does not say which cells belong where')
})

test('you can ask about several cells at once', () => {
  const { id, ids } = seminar(5)
  const text = buildContext(id, [ids[1], ids[3]])
  assert.match(text, /ASKING ABOUT: cell 02[^\n]*cell 04/)
  // Both are pinned: the budget will not drop them, even when it has to drop
  // something.
  assert.match(text, /marker_1/)
  assert.match(text, /marker_3/)
})

test("another notebook leaves the frame before the asker's own", () => {
  /*
   * When the budget is tight, whatever is furthest from the question goes
   * first: the contents of the SAME notebook may still come in handy, the
   * contents of a neighbouring one almost certainly will not.
   */
  const { id, doc, ids } = seminar(6, true)
  const second = createBook(id, 'соседняя.ipynb')
  assert.ok(second.ok)
  doc.transact(() => {
    for (let i = 0; i < 6; i++) {
      bookCells(doc, second.book.root).push([
        createCell('code', `СОСЕД_${i} = "${'q'.repeat(400)}"`),
      ])
    }
  })

  updateOracleSettings({ contextChars: 4_000 })
  try {
    const text = buildContext(id, [ids[0]])
    assert.match(text, /x0 = /, 'the cell being asked about did not arrive')
    assert.ok(!text.includes('СОСЕД_3 = "qqq'), "the neighbouring notebook ate the budget of the asker's own")
  } finally {
    updateOracleSettings({ contextChars: 20_000 })
  }
})

test('an open notebook does not travel a second time as a file', () => {
  /*
   * A notebook is an "open file" exactly like a .py, and until now its JSON
   * went into the frame whole: up to eight thousand characters of the same
   * thing, but without outputs and a second and a half stale — and it pushed
   * out the real cells, because the budget does not trim the header.
   */
  const { id } = seminar(2)
  /*
   * The notebook is put on disk and announced as open — both steps are there
   * so that the test can fail at all.
   *
   * `setLocalStateField` on the server awareness is a no-op: the state there
   * is `null` (collab/index.ts), and y-protocols updates a field only on a
   * non-empty one. The participant would not be found, and OPEN FILE would not
   * appear under any logic; without a file on disk, neither, simply because
   * there is nothing to read.
   */
  fs.writeFileSync(path.join(sessionDir(id), 'Тетрадь.ipynb'), '{"cells": [], "metadata": {}}')
  editing(id, 'p_ada', 'Тетрадь.ipynb')
  const text = buildContext(id, [], 'p_ada')
  assert.ok(!text.includes('OPEN FILE'), 'the notebook went out as a file as well')
})

test('an open .py, by contrast, does travel; otherwise the previous test checks nothing', () => {
  const { id } = seminar(2)
  fs.writeFileSync(path.join(sessionDir(id), 'train.py'), 'РОВНО_ЭТОТ_ФАЙЛ = 1\n')
  editing(id, 'p_ada', 'train.py')
  const text = buildContext(id, [], 'p_ada')
  assert.match(text, /OPEN FILE \(train\.py\)/)
  assert.match(text, /РОВНО_ЭТОТ_ФАЙЛ/)
})

test('an open file does not push the cell being asked about out of the frame', () => {
  /*
   * The open-file block lives in the header, while all three savings stages
   * trim only cells. With a small budget — a local model on the teacher's
   * machine — the file ate both the selected cell and the "ASKING ABOUT" line,
   * that is, the question itself; the panel meanwhile honestly said
   * "Especially: cell 06".
   */
  const { id, doc, ids } = seminar(30, true)
  const source = cellSource(getCells(doc).get(5))
  source.delete(0, source.length)
  source.insert(0, `ВЫБРАННАЯ_ЯЧЕЙКА = "${'q'.repeat(400)}"\n`.repeat(6))
  failAt(doc, 25, 'ValueError')
  // Three hundred lines: that is how much a person keeps open when asking.
  fs.writeFileSync(path.join(sessionDir(id), 'train.py'), 'import torch\n'.repeat(300))
  editing(id, 'p_ada', 'train.py')

  updateOracleSettings({ contextChars: 4_000 })
  try {
    const text = buildContext(id, [ids[5]], 'p_ada')
    assert.ok(text.length <= 4_000, `${text.length} characters in the frame`)
    assert.match(text, /ASKING ABOUT: cell 06/, 'the "what is being asked about" line did not arrive')
    assert.ok(text.includes('ВЫБРАННАЯ_ЯЧЕЙКА'), 'the selected cell did not arrive')
    assert.match(text, /OPEN FILE \(train\.py\)/, 'the open file was dropped entirely')
  } finally {
    updateOracleSettings({ contextChars: 20_000 })
  }
})
