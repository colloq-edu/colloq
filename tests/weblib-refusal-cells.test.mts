/**
 * The refusal note: what a person will read after the tab has been rebuilt.
 *
 * The gate refuses a FRAME AS A WHOLE, and a frame after a dropped connection
 * is everything the person typed without the network: the product allows
 * typing offline on purpose. Then the tab wipes its cache and reloads, and
 * everything that did not reach the server disappears — forever and without a
 * single word, unless it is told about here.
 *
 * While the note held ONE cell (the one with the cursor), edits in the others
 * went away silently. So what is checked is not the text on the screen but
 * the decision: what went into the snapshot, what of it is really lost, and in
 * which case a window about it is shown at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/*
 * Node has no sessionStorage — and the note lives in it. A fake of exactly the
 * size the module reads, plus a quota: without it one cannot check that a
 * snapshot that did not fit does not carry away the note that fit before.
 */
const store = new Map<string, string>()
let quota = Number.POSITIVE_INFINITY
;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (v.length > quota) throw new Error('QuotaExceededError')
    store.set(k, v)
  },
  removeItem: (k: string) => void store.delete(k),
}

const { stashRefusal, takeRefusal, stillLost, refusalHasText } = await import(
  '../web/src/lib/refusal.js'
)

function note(over: Partial<Parameters<typeof stashRefusal>[0]> = {}) {
  return {
    sessionId: 'room1',
    kind: 'edit' as const,
    message: 'Эту правку не приняли.',
    text: 'печатал тут',
    cells: [
      { id: 'c03', text: 'df = read()' },
      { id: 'c07', text: 'print(df.head())' },
      { id: 'c12', text: 'plot(df)' },
    ],
    at: Date.now(),
    ...over,
  }
}

test('the note holds all the typed text, not just the one cell under the cursor', () => {
  store.clear()
  quota = Number.POSITIVE_INFINITY
  stashRefusal(note())
  const back = takeRefusal('room1')
  assert.ok(back)
  assert.equal(back.cells?.length, 3)
  assert.deepEqual(
    back.cells?.map((cell) => cell.id),
    ['c03', 'c07', 'c12'],
  )
})

test('after the reload only what the server did NOT get is shown', () => {
  // The tab was rebuilt from the server copy: two cells there are the same,
  // one the server did not accept, and one more had already been deleted.
  const server = new Map([
    ['c03', 'df = read()'],
    ['c07', 'print(df.head())'],
  ])
  const lost = stillLost(note(), (id) => server.get(id) ?? null)
  assert.deepEqual(
    lost.map((cell) => cell.id),
    ['c12'],
  )
})

test('a difference in the text is a loss too, not a match by name', () => {
  const server = new Map([['c03', 'df = read()  # старая строка сервера']])
  const lost = stillLost(
    note({ cells: [{ id: 'c03', text: 'df = read()' }] }),
    (id) => server.get(id) ?? null,
  )
  assert.equal(lost.length, 1)
})

test('empty cells do not count as losses: there is nothing to lose there', () => {
  const lost = stillLost(
    note({
      cells: [
        { id: 'c01', text: '   \n' },
        { id: 'c02', text: '' },
      ],
    }),
    () => null,
  )
  assert.deepEqual(lost, [])
})

test('the window is shown even when the cursor was outside the cells', () => {
  // Exactly the case because of which offline edits disappeared quietly:
  // `text` is empty because there was no anchor, while the work lies in three
  // other cells.
  assert.equal(refusalHasText(note({ text: '' })), true)
  assert.equal(refusalHasText(note({ text: '', cells: [] })), false)
  assert.equal(refusalHasText(note({ text: 'что-то', cells: [] })), true)
})

test('a snapshot that did not fit into storage does not take the note itself with it', () => {
  store.clear()
  // Exactly enough for the note to fit without the snapshot, but not with it.
  const small = JSON.stringify({ ...note(), cells: undefined })
  quota = small.length + 20
  stashRefusal(note())
  const back = takeRefusal('room1')
  assert.ok(back, 'the note is gone entirely — the person was left without a single word')
  assert.equal(back.message, 'Эту правку не приняли.')
  assert.deepEqual(back.cells, [], 'there is no snapshot — and that is more honest than half a snapshot')
  quota = Number.POSITIVE_INFINITY
})

test('a note from the previous build is read: it has no snapshot, and that is not garbage', () => {
  store.clear()
  quota = Number.POSITIVE_INFINITY
  store.set(
    'colloq.refused',
    JSON.stringify({
      sessionId: 'room1',
      kind: 'stale',
      message: 'Кэш этой вкладки разошёлся с сервером — она собрана заново.',
      text: '',
      at: Date.now(),
    }),
  )
  const back = takeRefusal('room1')
  assert.ok(back)
  assert.deepEqual(back.cells, [])
  assert.equal(refusalHasText(back), false)
  assert.deepEqual(
    stillLost(back, () => null),
    [],
  )
})
