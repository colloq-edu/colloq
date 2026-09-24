/**
 * The shared document is the contract between browser and server, and the two
 * read it with the same functions. What is pinned here is the shape: a cell
 * created on one side has to be readable on the other, and merging two people's
 * edits has to end in one notebook rather than two.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  addBook,
  bookKernel,
  CELLS_KEY,
  cellId,
  cellOutputs,
  cellSource,
  cloneCell,
  clearStaleExecution,
  createCell,
  createChatEntry,
  createTerminalLine,
  chatAnswer,
  ensureInitialNotebook,
  findCell,
  kernelEntry,
  KERNEL_STATUS_FIELD,
  legacyKernelStatus,
  findChatEntry,
  getCells,
  getChat,
  getMeta,
  getTerminal,
  readCell,
  readChatEntry,
  readNotebook,
  readOutput,
  readTerminalLine,
  replaceText,
  terminalText,
} from '../shared/notebook.js'

/** Roots have to exist before anything can be read out of them. */
function blank(): Y.Doc {
  const doc = new Y.Doc()
  getCells(doc)
  getMeta(doc)
  getChat(doc)
  getTerminal(doc)
  return doc
}

test('a cell is readable only once it has joined a document', () => {
  const doc = blank()
  const cell = createCell('code', 'print(1)')
  getCells(doc).push([cell])
  const snapshot = readCell(cell)
  assert.equal(snapshot.type, 'code')
  assert.equal(snapshot.source, 'print(1)')
  assert.equal(snapshot.state, 'idle')
  assert.equal(snapshot.execCount, null)
  assert.equal(snapshot.outputs.length, 0)
  assert.equal(cellId(cell), snapshot.id)
})

test('cell ids are unique across a notebook', () => {
  const doc = blank()
  const cells = getCells(doc)
  cells.push(Array.from({ length: 200 }, () => createCell('code', '')))
  const ids = readNotebook(doc).map((c) => c.id)
  assert.equal(new Set(ids).size, 200)
})

test('findCell reports the position, and nothing for an id that has gone', () => {
  const doc = blank()
  const cells = getCells(doc)
  const a = createCell('code', 'a')
  const b = createCell('markdown', 'b')
  cells.push([a, b])
  const idA = cellId(a)
  assert.equal(findCell(doc, idA)?.index, 0)
  assert.equal(findCell(doc, cellId(b))?.index, 1)
  cells.delete(0, 1)
  assert.equal(findCell(doc, idA), null)
  assert.equal(findCell(doc, 'never-existed'), null)
})

test('a stream output accumulates rather than being replaced', () => {
  const doc = blank()
  const cell = createCell('code', '')
  getCells(doc).push([cell])
  const text = new Y.Text()
  cellOutputs(cell).push([new Y.Map(Object.entries({ kind: 'stream', name: 'stdout', text }))])
  // The kernel streams chunk by chunk; a reader must see the whole run so far.
  text.insert(text.length, 'first\n')
  text.insert(text.length, 'second\n')
  const out = readOutput(cellOutputs(cell).get(0))
  assert.ok(out && out.kind === 'stream')
  assert.equal(out.text, 'first\nsecond\n')
})

test('an output that makes no sense is dropped, not thrown over', () => {
  const doc = blank()
  const cell = createCell('code', '')
  getCells(doc).push([cell])
  cellOutputs(cell).push([new Y.Map(Object.entries({ kind: 'nonsense' }))])
  cellOutputs(cell).push([new Y.Map(Object.entries({ kind: 'error', json: '{not json' }))])
  // A malformed entry from a future version, or a corrupted snapshot, must not
  // take the whole notebook down with it.
  assert.doesNotThrow(() => readCell(cell))
  assert.equal(readCell(cell).outputs.length, 0)
})

test('two people editing the same cell converge on one text', () => {
  const a = blank()
  const b = blank()
  const cell = createCell('code', '')
  getCells(a).push([cell])
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

  const idOf = cellId(cell)
  const inA = findCell(a, idOf)!.cell
  const inB = findCell(b, idOf)!.cell
  cellSource(inA).insert(0, 'import pandas')
  cellSource(inB).insert(0, 'import numpy')

  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))

  const left = cellSource(findCell(a, idOf)!.cell).toString()
  const right = cellSource(findCell(b, idOf)!.cell).toString()
  assert.equal(left, right, 'the two clients disagree about the cell')
  assert.ok(left.includes('pandas') && left.includes('numpy'), left)
})

test('two people inserting cells at once keep every cell', () => {
  const a = blank()
  const b = blank()
  getCells(a).push([createCell('code', 'a1')])
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  getCells(a).push([createCell('code', 'a2')])
  getCells(b).push([createCell('code', 'b1')])
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))

  const left = readNotebook(a).map((c) => c.source)
  const right = readNotebook(b).map((c) => c.source)
  assert.deepEqual(left, right)
  assert.equal(left.length, 3, left.join())
})

test('seeding a notebook is safe to repeat', () => {
  const doc = blank()
  ensureInitialNotebook(doc, 'Computer Vision Seminar')
  const first = readNotebook(doc).map((c) => c.id)
  ensureInitialNotebook(doc, 'A different name')
  const second = readNotebook(doc).map((c) => c.id)
  // Every reconnecting client calls this. A second seeding would duplicate the
  // welcome cells for the whole room, and rename the seminar under them.
  assert.deepEqual(first, second)
  assert.equal(getMeta(doc).get('title'), 'Computer Vision Seminar')
})

test('an empty title is not "the document is empty", and a participant does not write it in', () => {
  /*
   * The host selected the seminar name in the header and erased it — '' was
   * left in the document. EVERY browser calls this function on every sync,
   * and by value the condition is true again: a student would write the
   * title, while the gate refuses the title to a non-host — a closed socket, a
   * wiped cache, a reload, sync again, write again. A loop the tab got out of
   * only when the host finished typing the name.
   */
  const doc = blank()
  ensureInitialNotebook(doc, 'Семинар')
  getMeta(doc).set('title', '')
  ensureInitialNotebook(doc, 'Семинар')
  assert.equal(getMeta(doc).get('title'), '', 'a participant wrote the title back in')
})

test('seeding never overwrites a notebook that has content', () => {
  const doc = blank()
  getCells(doc).push([createCell('code', 'the students work')])
  ensureInitialNotebook(doc, 'Seminar')
  const cells = readNotebook(doc)
  assert.equal(cells.length, 1)
  assert.equal(cells[0].source, 'the students work')
})

test('a chat entry carries who asked and streams its answer', () => {
  const doc = blank()
  const entry = createChatEntry({
    participantId: 'p_1',
    name: 'Maria',
    color: '#f97362',
    question: 'why does it run out of memory?',
    action: 'ask',
    cellId: 'c_4',
  })
  getChat(doc).push([entry])
  const id = readChatEntry(entry).id
  assert.equal(readChatEntry(entry).name, 'Maria')
  assert.equal(readChatEntry(entry).state, 'streaming')
  assert.equal(findChatEntry(doc, id), entry)

  const answer = chatAnswer(entry)
  answer.insert(answer.length, 'The batch is not what fills the card.')
  assert.match(readChatEntry(entry).answer, /fills the card/)
  assert.equal(findChatEntry(doc, 'no-such-entry'), null)
})

test('a terminal line streams its output the way a shell does', () => {
  const doc = blank()
  const line = createTerminalLine({ kind: 'command', text: 'pip install timm', name: 'John', color: '#4aa8f0' })
  getTerminal(doc).push([line])
  const out = createTerminalLine({ kind: 'output' })
  getTerminal(doc).push([out])
  const text = terminalText(out)
  text.insert(text.length, 'Collecting timm\n')
  text.insert(text.length, 'Successfully installed timm-1.0.15\n')
  assert.equal(readTerminalLine(line).kind, 'command')
  assert.equal(readTerminalLine(line).name, 'John')
  assert.match(readTerminalLine(out).text, /Successfully installed/)
})

test('an accepted edit rewrites only what changed', () => {
  const doc = new Y.Doc()
  const text = new Y.Text()
  doc.getMap('holder').set('t', text)
  text.insert(0, 'import pandas as pd\ndf = pd.read_csv("a.csv")\nprint(df)\n')

  // A neighbour's cursor is what all this is for. Y.RelativePosition survives
  // an edit of adjacent lines and does not survive "delete everything and
  // insert again".
  const caret = Y.createRelativePositionFromTypeIndex(text, text.length - 1)

  replaceText(text, 'import pandas as pd\ndf = pd.read_csv("b.csv")\nprint(df)\n')

  assert.equal(text.toString(), 'import pandas as pd\ndf = pd.read_csv("b.csv")\nprint(df)\n')
  const after = Y.createAbsolutePositionFromRelativePosition(caret, doc)
  assert.equal(after?.index, text.length - 1)
})

test('replaceText on identical text writes nothing', () => {
  const doc = new Y.Doc()
  const text = new Y.Text()
  doc.getMap('holder').set('t', text)
  text.insert(0, 'x = 1\n')

  let updates = 0
  doc.on('update', () => updates++)
  replaceText(text, 'x = 1\n')
  assert.equal(updates, 0)
})

test('replaceText handles appending and full replacement', () => {
  const doc = new Y.Doc()
  const text = new Y.Text()
  doc.getMap('holder').set('t', text)
  text.insert(0, 'a\n')

  replaceText(text, 'a\nb\n')
  assert.equal(text.toString(), 'a\nb\n')

  replaceText(text, 'совсем другое')
  assert.equal(text.toString(), 'совсем другое')

  replaceText(text, '')
  assert.equal(text.toString(), '')
})

test('a clone carries the stopwatch, the run time and the input form', () => {
  /*
   * `moveCell` recreates the neighbouring cell as a clone, not the one being
   * moved: moving the fifth while the sixth is computing means rebuilding the
   * sixth entirely. A key forgotten in cloneCell vanishes from it mid-run —
   * with `startedAt` that is a stopped stopwatch on a running cell, and with
   * `stdin` an input form gone for the whole room while the kernel waits for
   * an answer.
   *
   * The clone is read after it has landed in the document: Yjs does not
   * answer get() on a type that has not been inserted anywhere yet and
   * silently returns undefined.
   */
  const doc = blank()
  const cell = createCell('code', 'x = 1')
  doc.transact(() => getCells(doc).push([cell]))
  doc.transact(() => {
    cell.set('state', 'running')
    cell.set('startedAt', 1_700_000_000_000)
    cell.set('ranMs', 4_200)
    cell.set('stdin', { prompt: 'Имя: ', password: false })
  })

  const copy = cloneCell(cell)
  doc.transact(() => getCells(doc).push([copy]))

  assert.equal(copy.get('startedAt'), 1_700_000_000_000)
  assert.equal(copy.get('ranMs'), 4_200)
  assert.deepEqual(copy.get('stdin'), { prompt: 'Имя: ', password: false })
})

test('a fresh cell is created without a stopwatch, and an old one reads without it', () => {
  const doc = blank()
  const fresh = createCell('code', 'x = 1')
  doc.transact(() => getCells(doc).push([fresh]))
  assert.equal(readCell(fresh).startedAt, null)
  assert.equal(readCell(fresh).ranMs, null)

  // A notebook written before these keys existed: get() returns undefined,
  // while the whole view compares with null.
  const old = createCell('code', 'y = 2')
  doc.transact(() => {
    getCells(doc).push([old])
    old.delete('startedAt')
    old.delete('ranMs')
  })
  assert.equal(readCell(old).startedAt, null)
  assert.equal(readCell(old).ranMs, null)
})

/*
 * "STARTING python3" in a room where nothing is starting.
 *
 * The kernel comes up lazily — on the first Run or the first hover for help —
 * that is, a freshly created room and a room after a server restart have none,
 * and nobody brings one up. While that state was called `starting`, the
 * header promised for hours a start that was not happening; the complaint
 * from the class of 20 Sep 2026 went like this: "it is not really starting,
 * because it does not start anything, it just hangs".
 */
test('a room without a kernel is "not started", not "starting"', () => {
  const doc = blank()
  ensureInitialNotebook(doc, 'ZZ')
  // A new tab reads the notebook map; there is no entry there at all yet.
  assert.equal(bookKernel(doc, CELLS_KEY).status, 'off')
  // The old key is not seeded at all: empty reads as "not started", and an
  // old tab sees its former default and loses nothing.
  assert.equal(getMeta(doc).has('kernelStatus'), false)
  // And when the server writes `off`, the old key gets a word from the old
  // tab's vocabulary — otherwise its badge would stay empty.
  assert.equal(legacyKernelStatus('off'), 'idle')
  // The other states pass through the mirror as they are.
  for (const status of ['starting', 'idle', 'busy', 'restarting', 'dead'] as const) {
    assert.equal(legacyKernelStatus(status), status)
  }
})

test('a server restart clears the kernel state too: no notebook has a process', () => {
  const doc = blank()
  ensureInitialNotebook(doc, 'ZZ')
  const second = addBook(doc, 'Семинар.ipynb')
  doc.transact(() => {
    // This is how the document looks on disk after a crash: the lecture was
    // computing, the seminar was ready, and a kernel death is a fact that a
    // restart does not undo.
    kernelEntry(doc, CELLS_KEY).set(KERNEL_STATUS_FIELD, 'busy')
    kernelEntry(doc, second.root).set(KERNEL_STATUS_FIELD, 'idle')
    getMeta(doc).set('kernelStatus', 'busy')
  })

  clearStaleExecution(doc)

  assert.equal(bookKernel(doc, CELLS_KEY).status, 'off')
  assert.equal(bookKernel(doc, second.root).status, 'off', 'the second notebook stayed "ready" without a kernel')
  assert.equal(getMeta(doc).get('kernelStatus'), 'idle', 'an old tab was sent an unfamiliar word')
})

test('a real kernel death is not erased by a server restart', () => {
  const doc = blank()
  ensureInitialNotebook(doc, 'ZZ')
  doc.transact(() => kernelEntry(doc, CELLS_KEY).set(KERNEL_STATUS_FIELD, 'dead'))
  clearStaleExecution(doc)
  /*
   * `dead` is an OOM, a crash or "did not come up", and it has its own red
   * badge with a button and its own advice for the teacher. Repainting it as
   * "not started" would hide the very reason this status exists.
   */
  assert.equal(bookKernel(doc, CELLS_KEY).status, 'dead')
})

test('a server restart clears the stopwatch but does not erase the measured time', () => {
  const doc = blank()
  const wasRunning = createCell('code', 'a')
  const wasDone = createCell('code', 'b')
  doc.transact(() => {
    getCells(doc).push([wasRunning, wasDone])
    wasRunning.set('state', 'running')
    wasRunning.set('startedAt', 1_700_000_000_000)
    wasDone.set('state', 'ok')
    wasDone.set('ranMs', 4_200)
    // A stale mark on a cell that has settled: this is what a merge from a tab
    // that survived a server crash looks like.
    wasDone.set('startedAt', 1_700_000_000_000)
  })

  const cleared = clearStaleExecution(doc)

  assert.equal(wasRunning.get('state'), 'idle')
  assert.equal(wasRunning.get('startedAt'), null)
  // The mark is cleared on the second one too, but it does not count as
  // interrupted work: `cleared` goes into the line "Cells that were running or
  // queued were put back to rest", and adding an extra cell there would mean
  // telling the class something untrue.
  assert.equal(wasDone.get('startedAt'), null)
  assert.equal(wasDone.get('state'), 'ok')
  assert.equal(cleared, 1)
  // The measured time is a fact from a single server clock; a restart does
  // not undo it.
  assert.equal(wasDone.get('ranMs'), 4_200)
})
