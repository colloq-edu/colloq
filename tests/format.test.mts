/**
 * Formatting the room's code with black.
 *
 * The behaviour worth pinning is not "black works" — it is what happens to the
 * cells black REFUSES. Half a seminar's cells are not valid Python when
 * somebody presses the button: `%matplotlib inline`, `!pip install`, a line
 * being typed. A formatter that stopped at the first of those would be useless
 * exactly when a notebook most needs tidying.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createCell, getCells } from '../shared/notebook.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { formatNotebook, LINE_LENGTH } from '../server/src/kernel/format.js'

after(() => shutdownCollab())

/**
 * A kernel that answers the way a real one does, without Python.
 *
 * It reads the base64 payload back out of the program, so the test exercises
 * the real encoding — the part where a cell full of quotes and backslashes
 * would otherwise turn into Python that means something else.
 */
function fakeKernel(format: (source: string) => string | null) {
  let seenSilent: boolean | undefined
  return {
    get silent() {
      return seenSilent
    },
    async execute(
      code: string,
      handlers: { onStream(name: 'stdout' | 'stderr', text: string): void },
      opts?: { silent?: boolean },
    ) {
      seenSilent = opts?.silent
      const payload = /b64decode\("([^"]+)"\)/.exec(code)?.[1] ?? ''
      const sources = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as string[]
      handlers.onStream('stdout', JSON.stringify({ formatted: sources.map(format) }) + '\n')
      return 'ok' as const
    },
  }
}

let seq = 0
function room(cells: { type: 'code' | 'markdown'; source: string }[]) {
  const id = `fmt${seq++}`
  createSession(id, 'Formatting')
  const { doc } = getSessionDoc(id)
  const list = getCells(doc)
  doc.transact(() => {
    if (list.length > 0) list.delete(0, list.length)
    list.push(cells.map((c) => createCell(c.type, c.source)))
  })
  const text = () =>
    list.toArray().map((c) => (c.get('source') as Y.Text).toString())
  return { id, text }
}

test('a cell the formatter refuses is left exactly as it was', async () => {
  const { id, text } = room([
    { type: 'code', source: 'x   =    1' },
    { type: 'code', source: '%matplotlib inline' },
    { type: 'code', source: 'y=2' },
  ])
  // null is what the kernel returns for a cell black could not parse.
  const kernel = fakeKernel((s) => (s.startsWith('%') ? null : `formatted:${s}`))
  const out = await formatNotebook(id, kernel)

  assert.equal(text()[1], '%matplotlib inline', 'the magic was rewritten')
  assert.equal(out.skipped, 1)
  assert.equal(out.changed, 2, 'the cells around it were not formatted')
  assert.deepEqual(text(), ['formatted:x   =    1', '%matplotlib inline', 'formatted:y=2'])
})

test('one broken cell does not stop the cells after it', async () => {
  // The naive implementation — one black run over the whole notebook — fails
  // the entire file because of a line somebody is still writing.
  const { id, text } = room([
    { type: 'code', source: 'def f(  ):pass' },
    { type: 'code', source: '!pip install seaborn' },
    { type: 'code', source: 'g=1' },
    { type: 'code', source: 'h = (' },
    { type: 'code', source: 'k=2' },
  ])
  const kernel = fakeKernel((s) => (/^[!%]/.test(s) || s.endsWith('(') ? null : `formatted:${s}`))
  const out = await formatNotebook(id, kernel)

  assert.deepEqual(
    text(),
    ['formatted:def f(  ):pass', '!pip install seaborn', 'formatted:g=1', 'h = (', 'formatted:k=2'],
  )
  assert.equal(out.changed, 3)
  assert.equal(out.skipped, 2)
})

test('text cells are not code and are never touched', async () => {
  const { id, text } = room([
    { type: 'markdown', source: '## Заголовок' },
    { type: 'code', source: 'a=1' },
  ])
  await formatNotebook(id, fakeKernel(() => 'CHANGED'))
  assert.equal(text()[0], '## Заголовок')
  assert.equal(text()[1], 'CHANGED')
})

test('a cell already in shape is not rewritten', async () => {
  // Rewriting with identical text is still an edit to a shared document: it
  // would move everybody's cursor for a change nobody made.
  const { id } = room([{ type: 'code', source: 'x = 1' }])
  const out = await formatNotebook(id, fakeKernel((s) => s))
  assert.equal(out.unchanged, 1)
  assert.equal(out.changed, 0)
})

test('an empty cell is not sent to the formatter at all', async () => {
  const { id } = room([{ type: 'code', source: '   \n  ' }, { type: 'code', source: 'x=1' }])
  let sent = 0
  const kernel = fakeKernel((s) => { sent += 1; return s })
  await formatNotebook(id, kernel)
  assert.equal(sent, 1, 'the blank cell was sent')
})

test('a notebook with nothing to format asks the kernel nothing', async () => {
  const { id } = room([{ type: 'markdown', source: 'just prose' }])
  let called = false
  const out = await formatNotebook(id, {
    async execute() { called = true; return 'ok' as const },
  } as never)
  assert.equal(called, false)
  assert.deepEqual(out, { changed: 0, skipped: 0, edited: 0, unchanged: 0, error: null })
})

test('code with quotes and backslashes survives the trip', async () => {
  // The sources travel as base64 precisely so that this cannot break.
  const tricky = 'p = "a\\"b"\nq = \'\'\'triple\'\'\'\nr = "\\\\n"'
  const { id, text } = room([{ type: 'code', source: tricky }])
  await formatNotebook(id, fakeKernel((s) => (s === tricky ? 'ROUNDTRIPPED' : `WRONG:${s}`)))
  assert.equal(text()[0], 'ROUNDTRIPPED')
})

test('formatting runs silently, leaving no execution count behind', async () => {
  // It is a tool, not a cell: thirty people are looking at this notebook.
  const { id } = room([{ type: 'code', source: 'x=1' }])
  const kernel = fakeKernel((s) => s)
  await formatNotebook(id, kernel)
  assert.equal(kernel.silent, true)
})

test('a kernel that answers with nothing readable is reported, not guessed at', async () => {
  const { id, text } = room([{ type: 'code', source: 'x=1' }])
  const out = await formatNotebook(id, {
    async execute(_code: string, handlers: { onStream(n: 'stdout', t: string): void }) {
      handlers.onStream('stdout', 'Traceback (most recent call last):\n')
      return 'ok' as const
    },
  } as never)
  assert.ok(out.error)
  assert.equal(text()[0], 'x=1', 'the cell was touched despite the failure')
})

test('a cell edited while black was running is not overwritten', async () => {
  /*
   * Between the snapshot of the texts and the write there is a round trip to
   * the kernel, and if the kernel is busy with a cell, that whole cell too: up
   * to minutes. Replacing the text wholesale erased everything typed in that
   * time without a trace — the `format` origin is someone else's, and Ctrl+Z
   * does not reach it. This is what is checked here: a student keeps typing in
   * the cell while black is "thinking".
   */
  const { id, text } = room([
    { type: 'code', source: 'x=1' },
    { type: 'code', source: 'y=2' },
  ])
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { getCells } = await import('../shared/notebook.js')
  const cells = getCells(getSessionDoc(id).doc)

  const out = await formatNotebook(id, {
    async execute(code: string, handlers: { onStream(n: 'stdout', t: string): void }) {
      const payload = /b64decode\("([^"]+)"\)/.exec(code)?.[1] ?? ''
      const sources = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as string[]
      // While the kernel is busy, another person edits the second cell.
      const live = cells.get(1).get('source') as Y.Text
      live.insert(live.length, ' + 40')
      const formatted = sources.map((s) => `f:${s}`)
      handlers.onStream('stdout', JSON.stringify({ formatted }) + '\n')
      return 'ok' as const
    },
  } as never)

  assert.equal(text()[0], 'f:x=1', 'the untouched cell was not formatted')
  assert.equal(text()[1], 'y=2 + 40', 'what was typed during formatting was erased')
  assert.equal(out.changed, 1)
  assert.equal(out.edited, 1, 'the skipped cell was not reported')
  assert.equal(out.skipped, 1, 'the skipped cell is not counted among those left alone')
})

test('the width is the one a lecture hall can read, not black default', () => {
  // black's own default is 88, sized for a code review on a laptop.
  assert.equal(LINE_LENGTH, 100)
})
