/**
 * What the assistant is told about the notebook.
 *
 * This is the part of the feature that fails silently: the context is trimmed
 * to fit a window, and if the trimming drops the cell the student selected or
 * the traceback they are staring at, the answer is confidently about the wrong
 * thing. Nobody sees a bug; they see a bad assistant.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { cellOutputs, cellSource, createCell, getCells, getMeta } from '../shared/notebook.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { buildContext } from '../server/src/ai/context.js'
import { updateAssistantSettings } from '../server/src/admin/settings.js'

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
  const text = buildContext(id, ids[1])
  assert.match(text, /SESSION: Context seminar/)
  assert.match(text, /KERNEL: idle/)
  assert.match(text, /NOTEBOOK \(3 cells/)
  assert.match(text, /marker_0/)
  assert.match(text, /marker_2/)
})

test('the selected cell is pointed at, so the model knows what "this" means', () => {
  const { id, ids } = seminar(3)
  const text = buildContext(id, ids[2])
  assert.match(text, /SELECTED CELL: 2/)
  assert.match(text, /the student has this cell selected/)
})

test('no selection is stated rather than guessed', () => {
  const { id } = seminar(2)
  assert.match(buildContext(id, null), /SELECTED CELL: none/)
})

test('a traceback reaches the model', () => {
  const { id, doc, ids } = seminar(3)
  failAt(doc, 1, 'RuntimeError')
  const text = buildContext(id, ids[1])
  assert.match(text, /RuntimeError: CUDA out of memory/)
  assert.match(text, /Tried to allocate/)
})

test('a big notebook is trimmed, but never the cell the question is about', () => {
  const { id, doc, ids } = seminar(40, true)
  failAt(doc, 7, 'ValueError')
  const selected = 33
  const text = buildContext(id, ids[selected])

  // The budget is real: this notebook does not fit whole.
  assert.ok(text.length <= 20_000, `context is ${text.length} chars`)
  assert.match(text, /truncated|elided/, 'nothing was trimmed, so this proves nothing')

  // ...and the two things the question depends on survived it.
  assert.match(text, new RegExp(`SELECTED CELL: ${selected}`))
  assert.match(text, /x33 = /, 'the selected cell was elided')
  assert.match(text, /ValueError/, 'the newest traceback was elided')
})

test('the newest failure wins when several cells have failed', () => {
  const { id, doc, ids } = seminar(30, true)
  failAt(doc, 2, 'OldestError')
  failAt(doc, 20, 'NewestError')
  // Seminars run cells out of order all the time; "newest" is the highest
  // execution count, not the lowest cell on the page.
  const text = buildContext(id, ids[29])
  assert.match(text, /NewestError/)
})

test('an empty notebook still produces a usable context', () => {
  const { id } = seminar(0)
  const text = buildContext(id, null)
  assert.match(text, /NOTEBOOK \(0 cells/)
  assert.ok(text.length > 0)
})

test('a selected id that no longer exists does not break the context', () => {
  const { id } = seminar(3)
  assert.doesNotThrow(() => buildContext(id, 'c_deleted'))
  assert.match(buildContext(id, 'c_deleted'), /SELECTED CELL: none/)
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

  const text = buildContext(id, cell.get('id') as string)
  assert.ok(text.length <= 20_000, `context is ${text.length} chars, over the 20000 budget`)
  // And it is still a usable context, not just a short one.
  assert.match(text, /SESSION: One enormous cell/)
  assert.match(text, /SELECTED CELL: 0/)
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

  updateAssistantSettings({ contextChars: 100_000 })
  const whole = buildContext(id, cellId).length
  updateAssistantSettings({ contextChars: 20_000 })
  const text = buildContext(id, cellId)

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

  const text = buildContext(a.id, a.ids[0])
  assert.ok(!text.includes('SECRET_FROM_THE_OTHER_ROOM'), "another seminar's notebook was in the context")
  assert.match(text, new RegExp(`Context seminar ${a.id}`))
})
