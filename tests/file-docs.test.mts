/**
 * The seam between a Yjs document and bytes on disk.
 *
 * While a file is open, the truth is in the document; when closed — on disk.
 * Everything checked here breaks quietly: text is saved to the wrong place,
 * someone else's edit wipes what was typed, the cursor jumps to the other
 * end of the file, and a renamed file comes back to life under its old name
 * half a second after the rename.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import type { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { OPEN_ROOM } from '../shared/rules.js'
import { MAX_TEXT_BYTES, readText, sessionDir, writeText } from '../server/src/workspace.js'
import {
  TEXT_KEY,
  currentText,
  flushAllFiles,
  flushFile,
  flushSessionFiles,
  forgetFile,
  getFileDoc,
  handleFileSocket,
  openFileDoc,
  pollFilesNow,
  putText,
  spliceText,
} from '../server/src/collab/files.js'

const ROOM = 'docs-room'

function seed(name: string, text: string): void {
  const full = path.join(sessionDir(ROOM), name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text)
}

test('the room is created', () => {
  createSession(ROOM, 'File docs', null)
})

/* ------------------------------------------------------------ splicing */

test('splicing changes only what differs', () => {
  const doc = new Y.Doc()
  const text = doc.getText(TEXT_KEY)
  text.insert(0, 'один\nдва\nтри\n')

  /*
   * The mark stands in the word "два". If splicing rewrote the text
   * wholesale, the mark would move to the start of the document — and in a
   * live editor that is someone else's cursor jumping from the middle of the
   * file to the first line because a cell appended a line at the end.
   */
  const mark = Y.createRelativePositionFromTypeIndex(text, 6)
  spliceText(text, 'один\nдва\nтри\nчетыре\n')
  assert.equal(text.toString(), 'один\nдва\nтри\nчетыре\n')
  const after = Y.createAbsolutePositionFromRelativePosition(mark, doc)
  assert.equal(after?.index, 6, 'the mark moved even though its piece of text did not change')
})

test('splicing does nothing when the text is the same', () => {
  const doc = new Y.Doc()
  const text = doc.getText(TEXT_KEY)
  text.insert(0, 'x = 1\n')
  let updates = 0
  doc.on('update', () => (updates += 1))
  assert.equal(spliceText(text, 'x = 1\n'), false)
  assert.equal(updates, 0, 'an empty edit would still have gone to the room and into the history')
})

test('splicing survives a full replacement', () => {
  const doc = new Y.Doc()
  const text = doc.getText(TEXT_KEY)
  text.insert(0, 'старое целиком')
  spliceText(text, 'новое целиком')
  assert.equal(text.toString(), 'новое целиком')
  spliceText(text, '')
  assert.equal(text.toString(), '')
  spliceText(text, 'снова текст')
  assert.equal(text.toString(), 'снова текст')
})

/* ------------------------------------------------------- file document */

test('the document is created from disk', () => {
  seed('train.py', 'print(1)\n')
  const entry = getFileDoc(ROOM, 'train.py')
  assert.ok(entry)
  assert.equal(entry.doc.getText(TEXT_KEY).toString(), 'print(1)\n')
})

test('the second opening gets the same document, not a second instance of it', () => {
  const first = getFileDoc(ROOM, 'train.py')
  const second = getFileDoc(ROOM, 'train.py')
  assert.equal(first, second, 'two tabs would type into different copies of one file')
})

test('a document edit reaches the disk', () => {
  const entry = getFileDoc(ROOM, 'train.py')
  assert.ok(entry)
  entry.doc.getText(TEXT_KEY).insert(0, '# заголовок\n')
  // Saving is deferred by seven hundred milliseconds; the test does not wait
  // for them but asks to write everything at once — the same way a process
  // shutdown does it.
  flushAllFiles()
  assert.equal(readText(ROOM, 'train.py')?.text, '# заголовок\nprint(1)\n')
})

test('"save now" brings one open file to disk', () => {
  /*
   * Running and renaming are not entitled to wait for a pause in typing:
   * `python` reads the disk, and `forgetFile` takes the document away
   * together with the deferred write.
   */
  seed('run-me.py', 'x = 1\n')
  const entry = getFileDoc(ROOM, 'run-me.py')
  assert.ok(entry)
  entry.doc.getText(TEXT_KEY).insert(0, '# последняя строка\n')
  flushFile(ROOM, 'run-me.py')
  assert.equal(readText(ROOM, 'run-me.py')?.text, '# последняя строка\nx = 1\n')

  // A file nobody opened is not affected — and it is not created either.
  flushFile(ROOM, 'never-open.py')
  assert.equal(fs.existsSync(path.join(sessionDir(ROOM), 'never-open.py')), false)
})

test('a room\'s "save now" does not touch the files of the room next door', () => {
  /*
   * The map of open files is one per process, while a cell is run in one
   * room. Without this boundary every run in one class would write out what
   * was half-typed in all the others — and do it at the worst possible
   * moment.
   */
  const other = 'docs-room-next-door'
  createSession(other, 'Соседняя комната', null)
  fs.writeFileSync(path.join(sessionDir(other), 'notes.md'), 'заметка\n')
  seed('mine.py', 'x = 1\n')
  const mine = getFileDoc(ROOM, 'mine.py')
  const theirs = getFileDoc(other, 'notes.md')
  assert.ok(mine)
  assert.ok(theirs)
  mine.doc.getText(TEXT_KEY).insert(0, '# моё\n')
  theirs.doc.getText(TEXT_KEY).insert(0, '# чужое\n')
  flushSessionFiles(ROOM)
  assert.equal(readText(ROOM, 'mine.py')?.text, '# моё\nx = 1\n')
  assert.equal(readText(other, 'notes.md')?.text, 'заметка\n', 'someone else\'s room was written')
  flushAllFiles()
})

test('a binary file is not opened at all', () => {
  fs.writeFileSync(path.join(sessionDir(ROOM), 'model.pkl'), Buffer.from([0x80, 0x00, 0x04]))
  assert.equal(getFileDoc(ROOM, 'model.pkl'), null)
})

test('a non-existent file is not created empty', () => {
  // Otherwise an open tab would create a file by the very fact of opening —
  // and the seminar folder would fill up with empty files from mere misses
  // in the tree.
  assert.equal(getFileDoc(ROOM, 'no-such-file.py'), null)
  assert.equal(fs.existsSync(path.join(sessionDir(ROOM), 'no-such-file.py')), false)
})

test('a write in the server\'s name goes into the open document, not past it', () => {
  const entry = getFileDoc(ROOM, 'train.py')
  assert.ok(entry)
  putText(ROOM, 'train.py', 'print(2)\n')
  assert.equal(
    entry.doc.getText(TEXT_KEY).toString(),
    'print(2)\n',
    'the oracle wrote to disk past the editor — it would show the old text',
  )
  assert.equal(readText(ROOM, 'train.py')?.text, 'print(2)\n')
})

test('a write into a closed file goes straight to disk', () => {
  seed('closed.py', 'a = 1\n')
  assert.equal(putText(ROOM, 'closed.py', 'a = 2\n'), true)
  assert.equal(readText(ROOM, 'closed.py')?.text, 'a = 2\n')
  assert.equal(currentText(ROOM, 'closed.py'), 'a = 2\n')
})

test('a forgotten file is no longer written to disk', () => {
  /*
   * Rename and delete call `forgetFile`. Without it the document would
   * outlive its own file: the deferred save half a second later would bring
   * it back to life under the old name, and the rename would undo itself.
   */
  seed('doomed.py', 'x = 1\n')
  const entry = getFileDoc(ROOM, 'doomed.py')
  assert.ok(entry)
  entry.doc.getText(TEXT_KEY).insert(0, '# не должно уцелеть\n')
  fs.rmSync(path.join(sessionDir(ROOM), 'doomed.py'))
  forgetFile(ROOM, 'doomed.py')
  flushAllFiles()
  assert.equal(fs.existsSync(path.join(sessionDir(ROOM), 'doomed.py')), false)
})

test('someone else\'s write to disk reaches the open document', () => {
  seed('watched.py', 'первая строка\n')
  const entry = getFileDoc(ROOM, 'watched.py')
  assert.ok(entry)
  // A cell appended a line: `open('watched.py','a')` in the same container.
  // The modification time is rounded to a second on some file systems, so
  // the fingerprint must catch the size too — here both change.
  writeText(ROOM, 'watched.py', 'первая строка\nвторая строка\n')
  /*
   * Polling the disk on demand, not by sleeping a bit longer than the poll.
   *
   * The disk is watched by a two-second `setInterval` (collab/files.ts ·
   * WATCH_EVERY_MS), and there used to be a `setTimeout(2400)` here: four
   * hundred milliseconds of margin and five seconds of pure sleep for two
   * such cases. Under load (the whole suite runs, kernel.test computes next
   * door) the timer shifts, and the test goes red without saying a word
   * about the product. `pollFilesNow` does the same walk as the timer, but
   * now: there is nothing to wait for, and exactly the same `watchDisk` is
   * checked.
   */
  pollFilesNow(ROOM)
  assert.equal(
    entry.doc.getText(TEXT_KEY).toString(),
    'первая строка\nвторая строка\n',
    'the appended line did not reach the open document',
  )
})

test('splicing does not cut a surrogate pair in half', () => {
  /*
   * Neighbouring emoji share the high half, and the boundary of the common
   * head falls exactly in the middle of the pair. Yjs replaces a torn half
   * with U+FFFD, and on the way to the browsers a lone surrogate becomes yet
   * another one — the server and the clients diverge for good, and the
   * corruption goes to disk.
   */
  const doc = new Y.Doc()
  const text = doc.getText(TEXT_KEY)
  text.insert(0, 'x = "\u{1F600}"\n')
  spliceText(text, 'x = "\u{1F601}"\n')
  assert.equal(text.toString(), 'x = "\u{1F601}"\n')
  const other = new Y.Doc()
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
  assert.equal(
    other.getText(TEXT_KEY).toString(),
    'x = "\u{1F601}"\n',
    'the neighbour\'s editor ended up with a different text',
  )

  // And the same from the tail: these two share the low half.
  const tailDoc = new Y.Doc()
  const tail = tailDoc.getText(TEXT_KEY)
  tail.insert(0, 'a\u{1F600}')
  spliceText(tail, 'b\u{1FA00}')
  assert.equal(tail.toString(), 'b\u{1FA00}')
})

/* --------------------------------------------------------------- ceiling */

test('a file over the ceiling is not served by its beginning and not overwritten with a fragment', () => {
  // Three megabytes of metrics: the editor does not open such a file, while
  // the oracle in "do" mode took its beginning for the whole file and put
  // that beginning in its place.
  const whole = 'a,b\n' + 'x'.repeat(MAX_TEXT_BYTES) + 'ХВОСТ\n'
  seed('metrics.csv', whole)
  assert.equal(currentText(ROOM, 'metrics.csv'), null, 'the beginning of the file was passed off as the file')
  assert.equal(putText(ROOM, 'metrics.csv', 'a,b\n1,2\n'), false)
  assert.equal(readText(ROOM, 'metrics.csv')?.size, Buffer.byteLength(whole), 'the tail was cut off')
})

test('putText answers "no" when the text does not fit the ceiling', () => {
  // It used to be "yes" here: the document accepted the text, saving
  // silently refused because of the ceiling, and the oracle reported "Done"
  // with the file untouched.
  seed('grows.py', 'x = 1\n')
  const entry = getFileDoc(ROOM, 'grows.py')
  assert.ok(entry)
  assert.equal(putText(ROOM, 'grows.py', 'y'.repeat(MAX_TEXT_BYTES + 1)), false)
  assert.equal(
    entry.doc.getText(TEXT_KEY).toString(),
    'x = 1\n',
    'the document kept text that will never be on disk',
  )
  assert.equal(readText(ROOM, 'grows.py')?.text, 'x = 1\n')

  // And into a file nobody opened: the ceiling was measured against the old
  // file on disk, not the new text — a file got created on disk that then
  // could not be opened either by the editor or by the same oracle's next
  // step.
  assert.equal(putText(ROOM, 'huge-new.py', 'y'.repeat(MAX_TEXT_BYTES + 1)), false)
  assert.equal(fs.existsSync(path.join(sessionDir(ROOM), 'huge-new.py')), false)
})

test('a file that grew past the ceiling under an open editor is not overwritten with the old text', () => {
  seed('train.log', 'первая строка\n')
  const entry = getFileDoc(ROOM, 'train.log')
  assert.ok(entry)
  const socket = fakeSocket()
  handleFileSocket(socket.ws, ROOM, 'train.log', 'host', 'p_host')
  // A training script appends to the log, and the file crosses the ceiling.
  fs.writeFileSync(
    path.join(sessionDir(ROOM), 'train.log'),
    'первая строка\n' + 'x'.repeat(MAX_TEXT_BYTES),
  )
  pollFilesNow(ROOM)
  assert.ok(socket.closed !== null, 'the tab was not closed, the file grew silently')
  assert.equal(
    openFileDoc(ROOM, 'train.log'),
    null,
    'the document stayed alive on the text the file had when it was opened',
  )
  assert.equal(
    socket.closed?.code,
    4413,
    'the tab was closed as for a missing file — the person would be told the log is gone',
  )
  flushAllFiles()
  const size = readText(ROOM, 'train.log')?.size ?? 0
  assert.ok(size > MAX_TEXT_BYTES, `the log was cut to ${size} bytes`)
})

/* --------------------------------------- the file moved around the tree */

test('a renamed FOLDER does not come back together with a file open in it', () => {
  seed('src/model.py', 'x = 1\n')
  const entry = getFileDoc(ROOM, 'src/model.py')
  assert.ok(entry)
  entry.doc.getText(TEXT_KEY).insert(0, '# правка студента\n')
  // The teacher renamed a folder in the tree: `forgetFile` is called for it,
  // while the documents sit under the paths of the files inside.
  fs.renameSync(path.join(sessionDir(ROOM), 'src'), path.join(sessionDir(ROOM), 'lib'))
  forgetFile(ROOM, 'src')
  flushAllFiles()
  assert.equal(
    fs.existsSync(path.join(sessionDir(ROOM), 'src')),
    false,
    'the folder came back half a second later, and the rename undid itself',
  )
})

test('a file moved around the tree does not come back to life with the next save', () => {
  seed('draft.py', 'x = 1\n')
  const entry = getFileDoc(ROOM, 'draft.py')
  assert.ok(entry)
  // `mv draft.py final.py` in the shared terminal: the server knows nothing
  // about it.
  fs.renameSync(path.join(sessionDir(ROOM), 'draft.py'), path.join(sessionDir(ROOM), 'final.py'))
  entry.doc.getText(TEXT_KEY).insert(0, '# ещё строка\n')
  flushAllFiles()
  assert.equal(
    fs.existsSync(path.join(sessionDir(ROOM), 'draft.py')),
    false,
    'two diverging copies in the room, and the rename looks undone',
  )
})

/* ------------------------------------------------------------ file gate */

/**
 * A socket recording frames instead of a real one.
 *
 * The file gate is checked here and not over the network, because exactly
 * one thing needs checking: that the client's empty answer to the server's
 * step 1 does not count as an edit.
 */
function fakeSocket() {
  const handlers = new Map<string, (arg?: unknown) => void>()
  const sent: Uint8Array[] = []
  let closed: { code: number; reason: string } | null = null
  const ws = {
    readyState: 1,
    binaryType: '',
    on(event: string, handler: (arg?: unknown) => void) {
      handlers.set(event, handler)
      return ws
    },
    ping() {},
    send(message: Uint8Array, cb?: (err?: Error) => void) {
      sent.push(message)
      cb?.()
    },
    close(code: number, reason: string) {
      closed ??= { code, reason }
      ws.readyState = 3
    },
  }
  return {
    ws: ws as unknown as WebSocket,
    sent,
    get closed() {
      return closed
    },
    message(frame: Uint8Array) {
      handlers.get('message')?.(frame)
    },
  }
}

function syncFrame(subtype: number, update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0 /* MESSAGE_SYNC */)
  encoding.writeVarUint(encoder, subtype)
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

test('in a room with files: host a student reads the file instead of getting a refusal at the handshake', () => {
  /*
   * The server sends step 1 itself, and y-websocket ALWAYS answers it with
   * step 2 — even an empty one. Refusing by frame subtype broke this
   * handshake: a student saw "The edit was not accepted — read-only from now
   * on" without having written anything, and their file froze at the
   * snapshot of the opening moment.
   */
  const id = 'files-host'
  createSession(id, 'Файлы преподавательские', null)
  setRules(id, { ...OPEN_ROOM, files: 'host' })
  fs.writeFileSync(path.join(sessionDir(id), 'train.py'), 'x = 1\n')

  const socket = fakeSocket()
  handleFileSocket(socket.ws, id, 'train.py', 'participant', 'p_student')
  assert.ok(socket.sent.length > 0, 'the server did not send step 1')
  socket.message(syncFrame(1 /* SYNC_STEP2 */, Y.encodeStateAsUpdate(new Y.Doc())))
  const afterHandshake = socket.closed
  assert.equal(afterHandshake, null, 'the student was refused their own empty answer')

  // While a real edit in such a room still does not get through.
  const client = new Y.Doc()
  client.getText(TEXT_KEY).insert(0, '# правка студента\n')
  socket.message(syncFrame(2 /* SYNC_UPDATE */, Y.encodeStateAsUpdate(client)))
  assert.equal(socket.closed?.code, 4403, 'the edit was accepted from someone not allowed to edit files')
  assert.equal(readText(id, 'train.py')?.text, 'x = 1\n')
})

/* --------------------------------------------- what the socket closes with */

test('for a file over the ceiling the socket answers with its own code, not "no such file"', () => {
  /*
   * The client reads 4404 as a loss and closes the tab silently: a click on
   * a three-megabyte CSV looked like a tab that blinked and vanished without
   * a word. A separate code is the only way to explain to it that the file
   * is in place, just too big for the editor.
   */
  seed('dataset.csv', 'a,b\n' + 'x'.repeat(MAX_TEXT_BYTES))
  const big = fakeSocket()
  handleFileSocket(big.ws, ROOM, 'dataset.csv', 'host', 'p_host')
  assert.equal(big.closed?.code, 4413, 'a big file was passed off as a missing one')

  // While a loss stays a loss: closing the tab on a file that does not exist
  // is right.
  const ghost = fakeSocket()
  handleFileSocket(ghost.ws, ROOM, 'ghost.py', 'host', 'p_host')
  assert.equal(ghost.closed?.code, 4404)
})
