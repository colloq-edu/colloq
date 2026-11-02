/**
 * The cache of rebuilt versions has a weight, not only a count.
 *
 * Scrolling the history feed rebuilds a version per click and keeps it, so
 * clicking back costs nothing. Sixty-four of them used to be kept whatever
 * they weighed — for a notebook of a few megabytes that is hundreds of
 * megabytes held because someone looked at the timeline (the 3 Nov 2026 audit
 * measured ~170 MB walking 64 versions of a 2 MB notebook).
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { cellsAt, historyCache, mark } from '../server/src/collab/history.js'
import { cellSource, createCell, getCells } from '../shared/notebook.js'

after(() => shutdownCollab())

const BUDGET = 32 * 1024 * 1024

/** A checkpoint whose notebook is one cell of `chars` characters. */
function version(id: string, n: number, chars: number): number {
  const { doc } = getSessionDoc(id)
  doc.transact(() => {
    const cells = getCells(doc)
    cells.delete(0, cells.length)
    const cell = createCell('code', '')
    cells.push([cell])
    cellSource(cell).insert(0, `${n} `.padEnd(chars, 'x'))
  })
  return mark(id, doc, 'checkpoint', null, `v${n}`, `v${n}`)
}

test('heavy versions share a budget, and the ones kept are the ones used last', () => {
  const id = 'cache-weight'
  createSession(id, 'Тяжёлая тетрадь', null)
  // ~3 MB each in memory (UTF-16): twelve of them are over the budget.
  const seqs = Array.from({ length: 12 }, (_, n) => version(id, n, 1_500_000))
  const key = (seq: number) => `${id}:${seq}`

  for (const seq of seqs) cellsAt(id, seq)
  const filled = historyCache()
  assert.ok(filled.bytes <= BUDGET, `the cache holds ${filled.bytes} bytes`)
  assert.ok(filled.keys.length > 1 && filled.keys.length < seqs.length, filled.keys.join(' '))
  assert.deepEqual(filled.keys, seqs.slice(-filled.keys.length).map(key), 'the newest visits are the ones kept')

  // A hit is use: the oldest entry, touched, outlives the next insertion.
  const touched = filled.keys[0]!
  const touchedSeq = Number(touched.split(':')[1])
  const cached = cellsAt(id, touchedSeq)
  assert.equal(historyCache().keys.at(-1), touched, 'a hit did not count as use')
  cellsAt(id, seqs[0]!)
  const after = historyCache()
  assert.ok(after.keys.includes(touched), 'the version used last was pushed out first')
  assert.ok(!after.keys.includes(filled.keys[1]!), 'the least recently used one should have gone')
  assert.equal(cellsAt(id, touchedSeq), cached, 'a cached version was rebuilt')
  assert.ok(after.bytes <= BUDGET)
})

test('a version too heavy for a quarter of the budget is rebuilt every time, not kept', () => {
  const id = 'cache-giant'
  createSession(id, 'Огромная тетрадь', null)
  const seq = version(id, 0, 5_000_000)
  const before = historyCache()
  const first = cellsAt(id, seq)
  assert.equal(first[0]!.source.length, 5_000_000)
  assert.notEqual(cellsAt(id, seq), first, 'a giant version was cached')
  assert.deepEqual(historyCache(), before)
})
