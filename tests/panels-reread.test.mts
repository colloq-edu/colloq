/**
 * Rereading the feed and the transcript frame by frame, not as a whole.
 *
 * The oracle feed and the terminal grow by appending to a Y.Text INSIDE a row:
 * one chunk of an answer is one `observeDeep` frame. The old panels rebuilt the
 * whole array on every such frame (`chat.map(readChatEntry)`,
 * `terminal.map(readTerminalLine)`), that is, they read `toString()` of every
 * answer and every command on EVERY token: work proportional to the whole
 * thread per character, for everyone with the panel open. On top of that the
 * objects came out new, so the derived values of every turn (the patch diff,
 * the markdown parse, the author's role) and the `{@const}` of every terminal
 * line were recomputed along with them.
 *
 * What is checked here is exactly what this rests on: only what was touched is
 * reread, the snapshots of the rest are THE SAME objects, and anything that
 * makes row numbers unreliable (insertion, deletion, reordering) sends the
 * panel back to a full reread. Erring towards extra work is allowed; erring
 * towards a stale snapshot is not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  changedRows,
  createChatEntry,
  createTerminalLine,
  chatAnswer,
  getChat,
  getTerminal,
  readChatEntry,
  readTerminalLine,
  rereadRows,
  terminalText,
  type ChatSnapshot,
} from '../shared/notebook.js'

/** The whole panel: an array of snapshots updated by document frames. */
function panel<Row extends Y.Map<any>, Snapshot>(
  array: Y.Array<Row>,
  read: (row: Row) => Snapshot,
): { rows: Snapshot[]; frames: number; stop: () => void } {
  const state = { rows: array.map(read), frames: 0, stop: () => {} }
  const onFrame = (events: Y.YEvent<any>[]) => {
    state.frames++
    state.rows = rereadRows(state.rows, array, read, events)
  }
  array.observeDeep(onFrame)
  state.stop = () => array.unobserveDeep(onFrame)
  return state
}

function ask(doc: Y.Doc, question: string): void {
  getChat(doc).push([createChatEntry({ participantId: 'p1', name: 'Нина', color: '#000', question })])
}

/* ---------------------------------------------------------- the oracle feed */

test('an answer is appended to: only the turn being written into is reread', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  ask(doc, 'второй')
  ask(doc, 'третий')

  const view = panel(getChat(doc), readChatEntry)
  const before = [...view.rows]

  // Twenty chunks of answer into the middle turn: the way streaming arrives.
  const entry = getChat(doc).get(1)
  for (let i = 0; i < 20; i++) chatAnswer(entry).insert(chatAnswer(entry).length, 'слово ')

  assert.equal(view.frames, 20, 'every chunk is its own frame')
  assert.equal(view.rows.length, 3)
  assert.notEqual(view.rows[1], before[1], 'the turn that grew is reread')
  assert.equal(view.rows[1].answer, 'слово '.repeat(20))
  // The main thing: the neighbours are untouched, so their derived values will not wake up.
  assert.equal(view.rows[0], before[0], 'the neighbouring turn stayed the same snapshot')
  assert.equal(view.rows[2], before[2], 'and so did the last one')
  view.stop()
})

test('a new question means a full reread: the row numbers shifted', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  const view = panel(getChat(doc), readChatEntry)
  const before = [...view.rows]

  // An insertion at the START: the old turn's number changed, and its snapshot
  // cannot be reused by index.
  getChat(doc).insert(0, [
    createChatEntry({ participantId: 'p2', name: 'Пётр', color: '#111', question: 'нулевой' }),
  ])

  assert.equal(view.rows.length, 2)
  assert.equal(view.rows[0].question, 'нулевой')
  assert.equal(view.rows[1].question, 'первый')
  assert.notEqual(view.rows[1], before[0], 'after the shift the snapshots are rebuilt')
  view.stop()
})

test('deleting a turn leaves no snapshot of the vanished one in the feed', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  ask(doc, 'второй')
  const view = panel(getChat(doc), readChatEntry)

  getChat(doc).delete(0, 1)

  assert.deepEqual(
    view.rows.map((row: ChatSnapshot) => row.question),
    ['второй'],
  )
  view.stop()
})

test('a turn field (state, patch) is a frame too, and a targeted one too', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  ask(doc, 'второй')
  const view = panel(getChat(doc), readChatEntry)
  const before = [...view.rows]

  getChat(doc).get(0).set('state', 'done')

  assert.equal(view.rows[0].state, 'done')
  assert.equal(view.rows[1], before[1], 'the second turn is not reread')
  view.stop()
})

/* ----------------------------------------------------------- the terminal */

test('as a command output grows, the other transcript lines are not rebuilt', () => {
  const doc = new Y.Doc()
  const terminal = getTerminal(doc)
  terminal.push([createTerminalLine({ kind: 'command', text: 'pip install torch', name: 'Нина' })])
  terminal.push([createTerminalLine({ kind: 'output', text: '' })])

  const view = panel(terminal, readTerminalLine)
  const before = [...view.rows]

  const out = terminalText(terminal.get(1))
  for (let i = 0; i < 50; i++) out.insert(out.length, `Downloading ${i}\n`)

  assert.equal(view.rows[0], before[0], 'the command line stayed the same snapshot')
  assert.notEqual(view.rows[1], before[1])
  assert.match(view.rows[1].text, /Downloading 49/)
  view.stop()
})

/* ----------------------------------------------------- the parsing itself */

test('an empty event path is the array itself, and it means "reread everything"', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  const chat = getChat(doc)

  let seen: Set<number> | null | undefined
  const onFrame = (events: Y.YEvent<any>[]) => (seen = changedRows(events))

  chat.observeDeep(onFrame)
  ask(doc, 'второй')
  assert.equal(seen, null, 'an insertion into the array gives null, that is, a full reread')

  chat.get(0).set('state', 'done')
  assert.deepEqual(seen, new Set([0]), 'an edit of a card names its number')

  const answer = chatAnswer(chat.get(1))
  answer.insert(0, 'да')
  assert.deepEqual(seen, new Set([1]), 'text inside a card gives that same number')
  chat.unobserveDeep(onFrame)
})

test('the first read (no frame yet) builds everything', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  const rows = rereadRows<Y.Map<any>, ChatSnapshot>([], getChat(doc), readChatEntry, null)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].question, 'первый')
})

test('when there is nothing to touch, THE SAME array comes back', () => {
  const doc = new Y.Doc()
  ask(doc, 'первый')
  const rows = getChat(doc).map(readChatEntry)
  // An empty set of events: a panel that compares by reference must not write a
  // new value — one such extra round once cost a room an endless loop of
  // effects.
  assert.equal(rereadRows(rows, getChat(doc), readChatEntry, []), rows)
})
