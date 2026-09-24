/**
 * Notebooks became files, and here is the seam that holds it together.
 *
 * The document is the truth, the file is a projection. Everything below
 * breaks quietly: a notebook that did not reach the disk is invisible in the
 * tree; a notebook read back from disk loses cell names and other people's
 * carets; a notebook overwritten by an upload brings its own content back a
 * second later and looks like a loss.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { listFiles, readText, sessionDir } from '../server/src/workspace.js'
import { dropSessionDoc, getSessionDoc, peekSessionDoc } from '../server/src/collab/index.js'
import { restoreInto } from '../server/src/collab/history.js'
import {
  bookText,
  createBook,
  dropBook,
  isBookFile,
  moveBook,
  forgetMissingBooks,
  openBook,
  projectBooks,
} from '../server/src/collab/books.js'
import { parseIpynb, writeIpynb } from '../shared/ipynb.js'
import {
  allBooks,
  bookAt,
  bookCells,
  cellSource,
  createCell,
  ensureInitialNotebook,
  findCell,
  getCells,
} from '../shared/notebook.js'

const ROOM = 'books-room'

test('a new room has one notebook, and it lies in the folder as a file', () => {
  createSession(ROOM, 'Тетради', null)
  const { doc } = getSessionDoc(ROOM)
  const books = allBooks(doc)
  assert.equal(books.length, 1)
  assert.equal(books[0].book.path, 'Тетрадь.ipynb')
  // The first notebook's root stayed the same: it holds the whole history and
  // the whole cache of those already in the room.
  assert.equal(books[0].book.root, 'cells')

  projectBooks(ROOM)
  const listed = listFiles(ROOM).map((entry) => entry.path)
  assert.ok(listed.includes('Тетрадь.ipynb'), 'the notebook is not in the tree')
})

test("the notebook's file is a real .ipynb that reads back", () => {
  projectBooks(ROOM)
  const text = readText(ROOM, 'Тетрадь.ipynb')?.text ?? ''
  const flat = parseIpynb(text)
  assert.ok(flat, 'what was written does not parse as a notebook')
  assert.equal(flat.length, 2, 'the starting cells did not reach the file')
  assert.equal(flat[0].type, 'markdown')
})

test("outputs do not go into the notebook's file, however many there are in the room", () => {
  /*
   * The file is the notebook's SOURCE, not its snapshot (see shared/ipynb.ts):
   * with outputs it weighs megabytes of base64, and those megabytes then
   * travel in uploads, into the Oracle's context and to GitHub.
   *
   * The check here used to be a tautology: `!text.includes('"outputs":[') ||
   * !text.includes('image/png')` — the second half is true for the starting
   * notebook whatever the file contains, so the expression never failed. Now
   * the room does have an output, and its absence in the file is a real fact.
   */
  const { doc } = getSessionDoc(ROOM)
  const cell = getCells(doc).get(1)
  const base64 = 'iVBORw0KGgo' + 'A'.repeat(4096)
  doc.transact(() => {
    const png = new Y.Map<unknown>()
    png.set('kind', 'data')
    png.set('json', JSON.stringify({ data: { 'image/png': base64 }, execCount: 3 }))
    ;(cell.get('outputs') as Y.Array<unknown>).push([png])
    cell.set('execCount', 3)
  }, 'server')
  assert.equal((cell.get('outputs') as Y.Array<unknown>).length, 1, 'the output did not land in the document')

  projectBooks(ROOM)
  const text = readText(ROOM, 'Тетрадь.ipynb')?.text ?? ''
  const written = JSON.parse(text) as { cells: { outputs?: unknown[] }[] }
  assert.ok(written.cells.length > 0, 'no cells are left in the file')
  for (const [i, inFile] of written.cells.entries()) {
    assert.deepEqual(inFile.outputs ?? [], [], `the output of cell ${i} went into the file`)
  }
  // And the same as a string: the set of keys could match while the image
  // arrived somewhere in the metadata.
  assert.ok(!text.includes('image/png'), "the output's mime type went into the file")
  assert.ok(!text.includes(base64.slice(0, 64)), "the output's base64 went into the file")

  // The same file taken straight from the room (the Oracle and the download go
  // here).
  const direct = bookText(ROOM, 'Тетрадь.ipynb') ?? ''
  assert.ok(!direct.includes('image/png'), 'the output went into the notebook text for the Oracle')
})

test('a notebook edit reaches the file', () => {
  const { doc } = getSessionDoc(ROOM)
  const cells = getCells(doc)
  doc.transact(() => cellSource(cells.get(1)).insert(0, '# добавлено\n'))
  projectBooks(ROOM)
  assert.match(readText(ROOM, 'Тетрадь.ipynb')?.text ?? '', /# добавлено/)
})

test('a second notebook is created alongside and gets its own root', () => {
  const made = createBook(ROOM, 'разбор.ipynb')
  assert.ok(made.ok && made.book.root !== 'cells')
  const { doc } = getSessionDoc(ROOM)
  assert.equal(allBooks(doc).length, 2)
  // And they are different sheets: a cell of one does not appear in the other.
  const second = bookAt(doc, 'разбор.ipynb')!
  doc.transact(() => bookCells(doc, second.root).push([createCell('code', 'x = 1')]))
  assert.ok(
    !getCells(doc)
      .toArray()
      .some((cell) => cellSource(cell).toString() === 'x = 1'),
  )
})

test('a foreign .ipynb is brought into the room with its own cells', () => {
  const dropped = writeIpynb([
    { type: 'markdown', source: '# Прошлая пара\n' },
    { type: 'code', source: 'import pandas as pd\n' },
  ])
  fs.writeFileSync(path.join(sessionDir(ROOM), 'прошлая.ipynb'), dropped)

  const opened = openBook(ROOM, 'прошлая.ipynb')
  assert.ok(opened.ok && opened.imported)
  const { doc } = getSessionDoc(ROOM)
  const book = bookAt(doc, 'прошлая.ipynb')!
  const sources = bookCells(doc, book.root)
    .toArray()
    .map((cell) => cellSource(cell).toString())
  assert.deepEqual(sources, ['# Прошлая пара\n', 'import pandas as pd\n'])
})

test('opening again does not bring the notebook in a second time', () => {
  const again = openBook(ROOM, 'прошлая.ipynb')
  assert.ok(again.ok && !again.imported, 'the cells would have doubled')
  assert.equal(allBooks(getSessionDoc(ROOM).doc).length, 3)
})

test('something that is not a notebook does not open as one', () => {
  fs.writeFileSync(path.join(sessionDir(ROOM), 'сломанная.ipynb'), 'это не json')
  const tried = openBook(ROOM, 'сломанная.ipynb')
  assert.ok(!tried.ok)
  assert.match(tried.why, /некорректные данные \.ipynb/)
})

test('an empty .ipynb file is a new notebook, not a broken one', () => {
  // "New file" in the tree creates an empty file; named .ipynb, it is a
  // request for a notebook, and refusing it would be formally right and
  // useless.
  fs.writeFileSync(path.join(sessionDir(ROOM), 'пустая.ipynb'), '')
  const opened = openBook(ROOM, 'пустая.ipynb')
  assert.ok(opened.ok)
  assert.equal(bookCells(getSessionDoc(ROOM).doc, opened.book.root).length, 1)
})

test('a notebook moves together with its file and loses no cells', () => {
  const { doc } = getSessionDoc(ROOM)
  const before = bookAt(doc, 'разбор.ipynb')!.root
  moveBook(ROOM, 'разбор.ipynb', 'семинары/разбор.ipynb')
  const after = bookAt(doc, 'семинары/разбор.ipynb')
  assert.ok(after, 'the notebook got lost in the rename')
  assert.equal(after.root, before, 'the root changed, and the cells would have gone with it')
  assert.equal(bookAt(doc, 'разбор.ipynb'), null)
})

test('a removed notebook stops being a notebook', () => {
  dropBook(ROOM, 'пустая.ipynb')
  assert.equal(bookAt(getSessionDoc(ROOM).doc, 'пустая.ipynb'), null)
  assert.equal(isBookFile(ROOM, 'пустая.ipynb'), false)
})

test('nobody writes over a notebook: both the upload and the Oracle know that', () => {
  assert.equal(isBookFile(ROOM, 'Тетрадь.ipynb'), true)
  assert.equal(isBookFile(ROOM, 'прошлая.ipynb'), true)
  // An ordinary .ipynb that just lies in the folder does not count as a
  // notebook — it can be written over.
  fs.writeFileSync(path.join(sessionDir(ROOM), 'просто.ipynb'), writeIpynb([]))
  assert.equal(isBookFile(ROOM, 'просто.ipynb'), false)
})

test("a notebook's text is taken from the room, not from a lagging file", () => {
  const { doc } = getSessionDoc(ROOM)
  doc.transact(() => getCells(doc).push([createCell('code', 'только_что = True')]))
  // The file has not been rewritten yet — the projection is deferred — while
  // the Oracle needs what is in the room right now.
  assert.match(bookText(ROOM, 'Тетрадь.ipynb') ?? '', /только_что/)
})

test('a removed notebook does not come back by itself', () => {
  /*
   * A room where the notebook was removed on purpose got it back with all its
   * cells on the next open: the list is empty, so one has to be created — and
   * the deletion undid itself as soon as the server restarted.
   */
  const { doc } = getSessionDoc(ROOM)
  const before = allBooks(doc).length
  dropBook(ROOM, 'прошлая.ipynb')
  ensureInitialNotebook(doc, 'Тетради')
  assert.equal(allBooks(doc).length, before - 1, 'the notebook came back to life')
  assert.equal(bookAt(doc, 'прошлая.ipynb'), null)
})

test('a removed notebook stops being visible to the room, but its cells are not erased', () => {
  /*
   * From the list — and that is enough: both `allBooks` and `findCell` go
   * through the list, so an abandoned root is no longer read by anything. And
   * an erase could not be undone: only the room notebook has a version
   * history, and a single click on a file in the tree — an accidental one
   * included — would take away an hour of the class's work forever.
   */
  const { doc } = getSessionDoc(ROOM)
  const flat = writeIpynb([{ type: 'code', source: 'останется_ли = True\n' }])
  fs.writeFileSync(path.join(sessionDir(ROOM), 'на-выброс.ipynb'), flat)
  const opened = openBook(ROOM, 'на-выброс.ipynb')
  assert.ok(opened.ok)
  const root = opened.book.root
  assert.equal(bookCells(doc, root).length, 1)
  const id = bookCells(doc, root).get(0).get('id') as string

  dropBook(ROOM, 'на-выброс.ipynb')
  assert.equal(bookAt(doc, 'на-выброс.ipynb'), null, 'the notebook stayed in the list')
  assert.equal(findCell(doc, id), null, "the removed notebook's cells are still visible to the room")
  assert.equal(bookCells(doc, root).length, 1, 'the cells are erased, and there is nothing to bring them back with')
})

test("a new notebook on a freed path does not sit on someone else's root", () => {
  /*
   * The root used to be derived from the path. Renaming a review notebook to an
   * archived one and putting a new file under the old name is a common habit,
   * and both ended up with the same root: the uploaded file was not read at
   * all, edits went to both tabs, and removing the "extra" one meant emptying
   * both.
   */
  const id = 'books-roots'
  createSession(id, 'Корни', null)
  const { doc } = getSessionDoc(id)
  ensureInitialNotebook(doc, 'Корни')

  createBook(id, 'разбор.ipynb')
  const first = bookAt(doc, 'разбор.ipynb')!
  doc.transact(() => bookCells(doc, first.root).push([createCell('code', 'ПРОШЛОЕ = 1')]))
  moveBook(id, 'разбор.ipynb', 'разбор-v1.ipynb')

  fs.writeFileSync(
    path.join(sessionDir(id), 'разбор.ipynb'),
    writeIpynb([{ type: 'code', source: 'НОВОЕ = 2\n' }]),
  )
  const opened = openBook(id, 'разбор.ipynb')
  assert.ok(opened.ok && opened.imported)
  assert.notEqual(opened.book.root, first.root, 'two notebooks sat on one root')
  const sources = bookCells(doc, opened.book.root)
    .toArray()
    .map((cell) => cellSource(cell).toString())
  assert.deepEqual(sources, ['НОВОЕ = 2\n'], 'the uploaded file was not read')

  // And removing one does not mean emptying the other.
  dropBook(id, 'разбор.ipynb')
  assert.ok(
    bookCells(doc, first.root)
      .toArray()
      .some((cell) => cellSource(cell).toString() === 'ПРОШЛОЕ = 1'),
    'the archived notebook was emptied along with the one removed',
  )
})

test('a folder moves together with the notebooks inside it', () => {
  /*
   * `tree:move` works on folders too, while a notebook inside was matched by
   * its exact path and kept the old one: a second and a half later the
   * projection wrote it back along with the folder that had just been removed.
   */
  const id = 'books-folder'
  createSession(id, 'Папки', null)
  const { doc } = getSessionDoc(id)
  ensureInitialNotebook(doc, 'Папки')
  createBook(id, 'семинары/разбор.ipynb')
  const root = bookAt(doc, 'семинары/разбор.ipynb')!.root

  moveBook(id, 'семинары', 'архив')
  assert.equal(bookAt(doc, 'семинары/разбор.ipynb'), null, 'the notebook stayed on the old path')
  assert.equal(bookAt(doc, 'архив/разбор.ipynb')?.root, root, 'the notebook did not move with the folder')

  dropBook(id, 'архив')
  assert.equal(bookAt(doc, 'архив/разбор.ipynb'), null, 'the removed folder left its notebook in the room')
})

test('the room does not forget a notebook that did not fit into the tree', () => {
  /*
   * `listFiles` is what the panel draws: it has a ceiling of two thousand
   * entries. A notebook that did not make it into the list had not gone
   * anywhere from the disk, yet the room removed it for everyone. Each path is
   * checked separately.
   */
  const id = 'books-crowded'
  createSession(id, 'Толпа', null)
  const { doc } = getSessionDoc(id)
  ensureInitialNotebook(doc, 'Толпа')
  projectBooks(id)
  assert.ok(bookAt(doc, 'Тетрадь.ipynb'), 'the room notebook is missing')

  const dir = sessionDir(id)
  for (let i = 0; i < 2100; i += 1) {
    fs.writeFileSync(path.join(dir, `f${String(i).padStart(5, '0')}.txt`), 'x')
  }
  assert.equal(listFiles(id).length, 2000, 'the tree ceiling changed, so the test is no longer about anything')

  assert.deepEqual(forgetMissingBooks(id), [], 'a live notebook was removed from the room')
  assert.ok(bookAt(doc, 'Тетрадь.ipynb'), 'the room notebook disappeared')

  // But one whose file really was removed behind the tree's back is
  // forgotten.
  fs.writeFileSync(
    path.join(dir, 'разбор.ipynb'),
    writeIpynb([{ type: 'code', source: 'x = 1\n' }]),
  )
  openBook(id, 'разбор.ipynb')
  fs.rmSync(path.join(dir, 'разбор.ipynb'))
  assert.deepEqual(forgetMissingBooks(id), ['разбор.ipynb'])
  assert.equal(bookAt(doc, 'разбор.ipynb'), null)
})

test('os.remove in a cell does not remove the room notebook from the room', () => {
  /*
   * The check for missing files runs after EVERY cell run, and removing the
   * room notebook means erasing its cells. `os.remove('Тетрадь.ipynb')` in
   * somebody's cell is not the room's consent to part with what it has been
   * writing for the whole hour: the file here is a projection, and the
   * projection comes back.
   */
  const id = 'books-selfremove'
  createSession(id, 'Уборка', null)
  const { doc } = getSessionDoc(id)
  ensureInitialNotebook(doc, 'Уборка')
  projectBooks(id)
  const file = path.join(sessionDir(id), 'Тетрадь.ipynb')
  assert.ok(fs.existsSync(file))
  const cells = bookCells(doc, 'cells').length
  assert.ok(cells > 0)

  fs.rmSync(file)
  assert.deepEqual(forgetMissingBooks(id), [], 'the room notebook was removed from the room')
  assert.ok(bookAt(doc, 'Тетрадь.ipynb'), 'the room notebook disappeared from the list')
  assert.equal(bookCells(doc, 'cells').length, cells, "the room's cells were erased")

  projectBooks(id)
  assert.ok(fs.existsSync(file), "the notebook's file did not come back to disk")
})

test('restoring a version does not write the history into another notebook', () => {
  /*
   * The room's history is about its own notebook, and its root is pinned. The
   * difference shows in exactly one case, and an expensive one: the room
   * notebook was removed, another one became first in the list — and
   * restoring a version would write another sheet's cells into it.
   */
  const id = 'books-history'
  createSession(id, 'История', null)
  const { doc } = getSessionDoc(id)
  ensureInitialNotebook(doc, 'История')
  const roomBook = bookAt(doc, 'Тетрадь.ipynb')!
  assert.equal(roomBook.root, 'cells')

  createBook(id, 'вторая.ipynb')
  const second = bookAt(doc, 'вторая.ipynb')!
  doc.transact(() => bookCells(doc, second.root).push([createCell('code', 'своё = 1')]))

  dropBook(id, 'Тетрадь.ipynb')
  assert.equal(allBooks(doc)[0].book.root, second.root, 'the second notebook became first')

  // Restoring a version where the room had its own notebook: the cells must
  // land in that one, not in whichever turned out first.
  restoreInto(id, doc, 1, null, null)
  const restored = allBooks(doc).find((entry) => entry.book.root === 'cells')
  assert.ok(restored, 'the room notebook did not come back')
  const inSecond = bookCells(doc, second.root)
    .toArray()
    .map((cell) => cellSource(cell).toString())
  assert.ok(inSecond.includes('своё = 1'), 'the second notebook lost its own content')
  assert.ok(
    !inSecond.some((source) => source.includes('hello, seminar')),
    "the room's cells were written into another notebook",
  )
})

test('a closed room does not come back to life from deferred work', () => {
  /*
   * Writing the notebook file is deferred by a second and a half, and in that
   * time the room may have been closed — the class deleted, the process
   * stopped. The deferred work called `getSessionDoc`, which honestly rebuilt
   * the room from the snapshot, the new room set up its timers, and the next
   * deferred work built it again: the process stopped exiting, and the deleted
   * room kept coming back.
   */
  const id = 'books-ghost'
  createSession(id, 'Призрак', null)
  getSessionDoc(id)
  dropSessionDoc(id)
  assert.equal(peekSessionDoc(id), null)

  projectBooks(id)
  forgetMissingBooks(id)
  moveBook(id, 'Тетрадь.ipynb', 'другая.ipynb')
  dropBook(id, 'Тетрадь.ipynb')
  assert.equal(peekSessionDoc(id), null, 'the room came back into memory by itself')
})
