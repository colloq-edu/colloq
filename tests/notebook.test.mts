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
  cellId,
  cellOutputs,
  cellSource,
  createCell,
  createChatEntry,
  createTerminalLine,
  chatAnswer,
  ensureInitialNotebook,
  findCell,
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

test('принятая правка переписывает только то, что изменилось', () => {
  const doc = new Y.Doc()
  const text = new Y.Text()
  doc.getMap('holder').set('t', text)
  text.insert(0, 'import pandas as pd\ndf = pd.read_csv("a.csv")\nprint(df)\n')

  // Курсор соседа — то, ради чего всё это. Y.RelativePosition переживает
  // правку соседних строк и не переживает «удалить всё и вставить заново».
  const caret = Y.createRelativePositionFromTypeIndex(text, text.length - 1)

  replaceText(text, 'import pandas as pd\ndf = pd.read_csv("b.csv")\nprint(df)\n')

  assert.equal(text.toString(), 'import pandas as pd\ndf = pd.read_csv("b.csv")\nprint(df)\n')
  const after = Y.createAbsolutePositionFromRelativePosition(caret, doc)
  assert.equal(after?.index, text.length - 1)
})

test('replaceText на одинаковом тексте не пишет ничего', () => {
  const doc = new Y.Doc()
  const text = new Y.Text()
  doc.getMap('holder').set('t', text)
  text.insert(0, 'x = 1\n')

  let updates = 0
  doc.on('update', () => updates++)
  replaceText(text, 'x = 1\n')
  assert.equal(updates, 0)
})

test('replaceText справляется с дописыванием и с полной заменой', () => {
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
