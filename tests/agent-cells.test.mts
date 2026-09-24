/**
 * The oracle that edits the notebook.
 *
 * The model takes no part here: the hands are checked. Everything below
 * breaks quietly: the oracle reports success, while the edit went into a
 * file the projection will overwrite a second and a half later; or it went
 * into the document, but there is no way back from it; or a participant in
 * a lecture edited someone else's notebook with someone else's hands.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bookCells,
  bookList,
  cellId,
  cellsAt,
  cellOutputs,
  cellSource,
  createChatEntry,
  getChat,
  readCell,
  writeOutput,
  type YCell,
} from '@shared/notebook'
import { LECTURE_ROOM } from '@shared/rules'
import { createSession, listVersions, setFinished, setRules } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { flushHistory, restoreInto } from '../server/src/collab/history.js'
import { bookText, createBook, projectBooks } from '../server/src/collab/books.js'
import { flushAllFiles } from '../server/src/collab/files.js'
import { readText, sessionDir, writeText } from '../server/src/workspace.js'
import {
  movedFiles,
  saidAboutCells,
  toolsFor,
  treePrint,
  undoTurn,
  useTool,
  type Hands,
} from '../server/src/ai/agent.js'
import { rmSync } from 'node:fs'
import path from 'node:path'

after(() => shutdownCollab())

const BY = { name: 'Ада', color: '#F97362', participantId: 'p_ada' }

let seq = 0
/** A room of its own per test: checkpoints and restores of different tests do not mix. */
function room(): string {
  const id = `cells${seq++}`
  createSession(id, `Cells ${id}`)
  // Creates the document, and with it the starting notebook: a markdown
  // heading and a code cell, exactly what a room opened for the first time
  // shows.
  getSessionDoc(id)
  return id
}

function turn(sessionId: string): string {
  const doc = getSessionDoc(sessionId).doc
  const entry = createChatEntry({
    participantId: BY.participantId,
    name: BY.name,
    color: BY.color,
    question: 'подготовь тетрадь',
    mode: 'agent',
  })
  doc.transact(() => getChat(doc).push([entry]))
  const id = entry.get('id') as string
  doc.transact(() => entry.set('undo', 'available'))
  return id
}

function hands(sessionId: string, entryId: string, role: 'host' | 'participant' = 'host'): Hands {
  return { sessionId, entryId, by: BY, role }
}

/** The cells of the room's notebook, as a person sees them. */
function cells(sessionId: string): YCell[] {
  return bookCells(getSessionDoc(sessionId).doc, 'cells').toArray()
}

function source(sessionId: string, at: number): string {
  return cellSource(cells(sessionId)[at]).toString()
}

function call(hands: Hands, name: string, args: Record<string, unknown>) {
  return useTool(hands, name, JSON.stringify(args))
}

/* ---------------------------------------------------------------- reads */

test('read_notebook shows cell names, types and whether there is output', async () => {
  const id = room()
  const doc = getSessionDoc(id).doc
  const first = cells(id)[0]
  doc.transact(() =>
    cellOutputs(cells(id)[1]).push([writeOutput({ kind: 'stream', name: 'stdout', text: '42\n' })]),
  )

  const listed = await call(hands(id, turn(id)), 'read_notebook', {})
  assert.equal(listed.step.kind, 'read')
  assert.equal(listed.step.target, 'Тетрадь.ipynb')
  assert.match(listed.said, new RegExp(cellId(first)), 'the cell name is not in the list')
  assert.match(listed.said, /markdown/)
  assert.match(listed.said, /print\("hello, seminar"\)/)
  assert.match(listed.said, /вывод есть/, 'nothing is said about output, so there will be nothing to rerun')
})

test('no notebook with that name: a humane refusal', async () => {
  const id = room()
  const tried = await call(hands(id, turn(id)), 'read_notebook', { path: 'Разбор.ipynb' })
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /не тетрадь этой комнаты/)
  assert.match(tried.said, /Тетрадь\.ipynb/, 'it does not say which notebooks exist')
})

test('read_notebook names the other notebooks of the room', async () => {
  const id = room()
  assert.equal(createBook(id, 'Разбор.ipynb').ok, true)

  const listed = await call(hands(id, turn(id)), 'read_notebook', {})
  assert.equal(listed.step.target, 'Тетрадь.ipynb', 'without a path, something other than the room notebook is read')
  assert.match(listed.said, /Ещё тетради в комнате: Разбор\.ipynb/, 'the second notebook is not named')
})

test('the second notebook gets edited, and a pre-edit copy lands next to it', async () => {
  const id = room()
  const entry = turn(id)
  assert.equal(createBook(id, 'Разбор.ipynb').ok, true)
  const doc = getSessionDoc(id).doc
  const other = cellsAt(doc, 'Разбор.ipynb')
  assert.ok(other && other.length > 0, 'the second notebook was created without cells')
  doc.transact(() => cellSource(other.get(0)).insert(0, 'решение = 42'))

  // The cell name is taken from read_notebook and works for edit_cell:
  // otherwise the model would miss in a notebook it has just read.
  const name = cellId(other.get(0))
  const listed = await call(hands(id, entry), 'read_notebook', { path: 'Разбор.ipynb' })
  assert.equal(listed.step.target, 'Разбор.ipynb')
  assert.match(listed.said, new RegExp(name), 'the cell name of the second notebook is not in the list')

  const wrote = await call(hands(id, entry), 'edit_cell', { cellId: name, source: 'x = 1' })
  assert.equal(wrote.step.kind, 'write')
  assert.equal(cellSource(other.get(0)).toString(), 'x = 1', 'the second notebook was never edited')

  // Its way back is not a button but a copy next to it, holding what was there BEFORE the edit.
  const copy = readText(id, 'Разбор.before-oracle.ipynb')
  assert.ok(copy && !copy.binary, 'there was no pre-edit copy next to it')
  assert.match(copy.text, /решение = 42/, 'the copy got the already edited version')

  const said = saidAboutCells(id, entry)
  assert.match(said, /Разбор\.before-oracle\.ipynb/, 'it does not say where the copy is')
  assert.match(said, /не возвращается/, 'the version history was lied about by omission')
  assert.ok(!/до правки оракула/.test(said), 'the second notebook was promised a button in the history')
  assert.equal(
    listVersions(id, 50).filter((row) => row.kind === 'checkpoint').length,
    0,
    'a history mark for a notebook the history will not restore',
  )
})

test('a copy does not overwrite the previous one: the next turn lays down its own', async () => {
  const id = room()
  assert.equal(createBook(id, 'Разбор.ipynb').ok, true)
  const other = cellsAt(getSessionDoc(id).doc, 'Разбор.ipynb')!
  const name = cellId(other.get(0))

  await call(hands(id, turn(id)), 'edit_cell', { cellId: name, source: 'первое' })
  const second = turn(id)
  await call(hands(id, second), 'edit_cell', { cellId: name, source: 'второе' })

  assert.match(readText(id, 'Разбор.before-oracle.ipynb')?.text ?? '', /"cells"/)
  const next = readText(id, 'Разбор.before-oracle 2.ipynb')
  assert.ok(next, 'the second turn overwrote the copy of the first')
  assert.match(next.text, /первое/, 'the second copy does not hold what was there before the second turn')
  assert.match(saidAboutCells(id, second), /Разбор\.before-oracle 2\.ipynb/)
})

test('add_cell puts the cell into the named notebook, not the room notebook', async () => {
  const id = room()
  const entry = turn(id)
  assert.equal(createBook(id, 'Разбор.ipynb').ok, true)
  const other = cellsAt(getSessionDoc(id).doc, 'Разбор.ipynb')!
  const was = other.length

  const added = await call(hands(id, entry), 'add_cell', {
    path: 'Разбор.ipynb',
    type: 'code',
    source: 'print(1)',
  })
  assert.equal(added.step.kind, 'new')
  assert.match(added.step.target, /^Разбор\.ipynb/)
  assert.equal(other.length, was + 1)
  assert.equal(cells(id).length, 2, 'the cell went into the room notebook')

  const gone = await call(hands(id, entry), 'remove_cell', { cellId: cellId(other.get(0)) })
  assert.equal(gone.step.removed, 1)
  assert.equal(other.length, was)
  const said = saidAboutCells(id, entry)
  assert.match(said, /^Разбор\.ipynb: добавил \d\d; убрал 1 ячейка\./, said)
  assert.ok(!/Тетрадь\.ipynb/.test(said), 'the answer attributed the edit to the room notebook')
})

/* ----------------------------------------------------------------- edits */

test('edit_cell changes the room document, not the notebook file', async () => {
  const id = room()
  const entry = turn(id)
  const target = cells(id)[1]

  const wrote = await call(hands(id, entry), 'edit_cell', {
    cellId: cellId(target),
    source: 'print("готово к практике")',
  })
  assert.equal(wrote.step.kind, 'write')
  assert.equal(source(id, 1), 'print("готово к практике")')

  // The file is a projection: a write into it would be accepted and silently
  // lost, so the refusal stayed, but it now leads to the cells.
  const toFile = await call(hands(id, entry), 'write_file', {
    path: 'Тетрадь.ipynb',
    content: '{}',
  })
  assert.equal(toFile.step.kind, 'note')
  assert.match(toFile.said, /edit_cell/, 'the refusal for the notebook file stayed a dead end')
})

test('an edit does not erase the output but calls it stale', async () => {
  const id = room()
  const doc = getSessionDoc(id).doc
  const target = cells(id)[1]
  doc.transact(() =>
    cellOutputs(target).push([writeOutput({ kind: 'stream', name: 'stdout', text: 'старое\n' })]),
  )

  const wrote = await call(hands(id, turn(id)), 'edit_cell', {
    cellId: cellId(target),
    source: 'print("новое")',
  })
  assert.equal(readCell(target).outputs.length, 1, 'the output was erased, so the room will not learn what was there')
  assert.match(wrote.said, /устаревш/i, 'nothing is said about the stale output')
})

test('add_cell goes after the given cell, and without one to the end', async () => {
  const id = room()
  const entry = turn(id)
  const first = cellId(cells(id)[0])

  const added = await call(hands(id, entry), 'add_cell', {
    after: first,
    type: 'markdown',
    source: '## Задание 1',
  })
  assert.equal(added.step.kind, 'new')
  assert.equal(cells(id).length, 3)
  assert.equal(source(id, 1), '## Задание 1')

  await call(hands(id, entry), 'add_cell', { type: 'code', source: '# ваш код' })
  assert.equal(cells(id).length, 4)
  assert.equal(source(id, 3), '# ваш код')
})

test('remove_cell removes a cell, but not one that is computing', async () => {
  const id = room()
  const entry = turn(id)
  const doomed = cells(id)[1]

  const doc = getSessionDoc(id).doc
  doc.transact(() => doomed.set('state', 'running'))
  const busy = await call(hands(id, entry), 'remove_cell', { cellId: cellId(doomed) })
  assert.equal(busy.step.kind, 'note')
  assert.match(busy.said, /в очереди на ядро/)
  assert.equal(cells(id).length, 2, 'the computing cell was removed anyway')

  doc.transact(() => doomed.set('state', 'idle'))
  const gone = await call(hands(id, entry), 'remove_cell', { cellId: cellId(doomed) })
  assert.equal(gone.step.removed, 1)
  assert.equal(cells(id).length, 1)
})

test('a nonexistent cell gets a humane refusal, not silence', async () => {
  const id = room()
  const entry = turn(id)
  for (const name of ['edit_cell', 'remove_cell']) {
    const tried = await call(hands(id, entry), name, { cellId: 'c_нетакой', source: 'x' })
    assert.equal(tried.step.kind, 'note', name)
    assert.match(tried.said, /в комнате нет/, name)
    assert.match(tried.said, /read_notebook/, name)
  }
  assert.equal(cells(id).length, 2)
})

/* ------------------------------------------------------ around the room */

test('a notebook file rewritten around the room is named out loud by the turn', async () => {
  const id = room()
  const entry = turn(id)
  projectBooks(id)
  const was = source(id, 1)

  /*
   * The order is the same as it came out at a live class: the turn takes a
   * fingerprint of the file, a step runs, and during it a script rewrites the
   * .ipynb. There is no script here (the suite has no kernel at all), but the
   * write lands in exactly the same place, between the fingerprints:
   * `useTool` takes the first one before handing control to the step.
   */
  const step = call(hands(id, entry), 'list_files', {})
  writeText(id, 'Тетрадь.ipynb', '{"cells": [], "nbformat": 4, "nbformat_minor": 5}')
  const ran = await step

  assert.match(ran.said, /мимо комнаты/, 'the model was not told that the write did not apply')
  assert.match(ran.said, /edit_cell/, 'it does not say how to really apply it')
  /*
   * And as a separate row in the feed, not only in the model's answer.
   *
   * "Looked at the folder" and "the notebook file was rewritten around the
   * room" are two different rows: glued into one, the second reads as a
   * detail of the first, while it is about what this whole check was written
   * for.
   */
  assert.equal(ran.also?.kind, 'note')
  assert.match(ran.also!.target, /Тетрадь\.ipynb/)
  assert.equal(source(id, 1), was, 'the write to the file reached the cells anyway')

  const said = saidAboutCells(id, entry)
  assert.match(said, /Тетрадь\.ipynb/, 'the room was not told about the rewritten file')
  assert.match(said, /не изменилось ничего/)
})

test('our own projection does not count as a deception', async () => {
  const id = room()
  const entry = turn(id)
  projectBooks(id)
  const doc = getSessionDoc(id).doc
  doc.transact(() => cellSource(cells(id)[1]).insert(0, '# правка руками\n'))

  // The projection writes the file a second and a half after a cell edit,
  // that is, in the middle of someone else's step. The file changes, but it
  // becomes exactly what the room writes into it: there is no deception
  // here, and nothing to say about it.
  const step = call(hands(id, entry), 'list_files', {})
  writeText(id, 'Тетрадь.ipynb', bookText(id, 'Тетрадь.ipynb')!)
  const ran = await step

  assert.ok(!/мимо комнаты/.test(ran.said), 'the projection was taken for a forgery')
  assert.equal(saidAboutCells(id, entry), '')
})

/* ------------------------------------------------------ what we pay with */

test('a checkpoint is set once per turn and restores the notebook', async () => {
  const id = room()
  const was = [source(id, 0), source(id, 1)]
  const first = turn(id)

  await call(hands(id, first), 'edit_cell', { cellId: cellId(cells(id)[0]), source: '# Практика' })
  await call(hands(id, first), 'edit_cell', { cellId: cellId(cells(id)[1]), source: '# TODO' })

  const marks = listVersions(id, 50).filter((row) => row.kind === 'checkpoint')
  assert.equal(marks.length, 1, 'a mark per cell would push the one that is needed out of the panel')
  assert.equal(marks[0].label, 'до правки оракула')
  assert.equal(marks[0].author_id, BY.participantId, 'the mark belongs to nobody')

  // One button, and the notebook is as it was before the turn.
  const doc = getSessionDoc(id).doc
  assert.ok(restoreInto(id, doc, marks[0].seq, BY.participantId, null) > 0)
  assert.deepEqual([source(id, 0), source(id, 1)], was)

  // The next turn gets its own mark: coming back from it must not land at someone else's point.
  const second = turn(id)
  await call(hands(id, second), 'edit_cell', { cellId: cellId(cells(id)[1]), source: 'x = 1' })
  assert.equal(listVersions(id, 50).filter((row) => row.kind === 'checkpoint').length, 2)
})

test('the edit is made in the name of whoever asked for the turn', async () => {
  const id = room()
  await call(hands(id, turn(id)), 'edit_cell', {
    cellId: cellId(cells(id)[1]),
    source: 'print("от имени Ады")',
  })
  flushHistory(id)
  const newest = listVersions(id, 5).find((row) => row.kind === 'edit')
  assert.ok(newest, 'the edit did not get into the version history')
  assert.equal(newest.author_id, BY.participantId, 'the version belongs to nobody: "the room"')
})

test('the answer names the cells that would have to be rerun', async () => {
  const id = room()
  const entry = turn(id)
  await call(hands(id, entry), 'edit_cell', { cellId: cellId(cells(id)[1]), source: 'x = 1' })
  await call(hands(id, entry), 'add_cell', { type: 'code', source: 'y = 2' })

  const said = saidAboutCells(id, entry)
  assert.match(said, /поправил 02/)
  assert.match(said, /добавил 03/)
  assert.match(said, /перезапустите/)
  assert.match(said, /до правки оракула/, 'it does not say where to go back to')
})

test('undoing a turn still restores files', async () => {
  const id = room()
  const entry = turn(id)
  await call(hands(id, entry), 'write_file', { path: 'train.py', content: 'x = 1\n' })
  await call(hands(id, entry), 'edit_cell', { cellId: cellId(cells(id)[1]), source: 'x = 1' })
  flushAllFiles()
  assert.equal(readText(id, 'train.py')?.text, 'x = 1\n')

  assert.equal(undoTurn(id, entry, 'Ада'), 1, 'the button under the turn stopped restoring files')
  flushAllFiles()
  assert.equal(readText(id, 'train.py')?.text, '')
  // Undo does not touch the notebook: the version history restores it, and
  // the turn's own answer says so.
  assert.equal(source(id, 1), 'x = 1')
})

/* ----------------------------------------------------------------- rights */

test('a participant in a lecture is given no cell tools at all', async () => {
  const id = room()
  setRules(id, { ...LECTURE_ROOM, agent: 'room' })
  const entry = turn(id)

  const theirs = toolsFor(hands(id, entry, 'participant')).map((tool) => tool.name)
  assert.ok(theirs.includes('read_notebook'), 'everyone may look at the notebook: it is on screen anyway')
  for (const name of ['edit_cell', 'add_cell', 'remove_cell']) {
    assert.ok(!theirs.includes(name), `${name} was offered to someone who may not use it`)
  }
  const hosts = toolsFor(hands(id, entry, 'host')).map((tool) => tool.name)
  for (const name of ['edit_cell', 'add_cell', 'remove_cell']) {
    assert.ok(hosts.includes(name), `${name} was not given to the teacher in their own lecture`)
  }

  // And not only in the list: the refusal comes on a direct call too.
  const target = cells(id)[1]
  const tried = await call(hands(id, entry, 'participant'), 'edit_cell', {
    cellId: cellId(target),
    source: 'решение = 42',
  })
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /преподавател/i)
  assert.equal(source(id, 1), 'print("hello, seminar")', 'a participant edited the lecture notebook')

  const added = await call(hands(id, entry, 'participant'), 'add_cell', {
    type: 'code',
    source: 'x',
  })
  assert.match(added.said, /преподавател/i)
  assert.equal(cells(id).length, 2)
})

test('the cell lock: one cell is open to a participant, the whole notebook to the teacher', async () => {
  const id = room()
  setRules(id, { ...LECTURE_ROOM, agent: 'room' })
  const entry = turn(id)
  const doc = getSessionDoc(id).doc
  const open = cells(id)[1]
  const closed = cells(id)[0]
  doc.transact(() => open.set('open', true))

  const theirs = toolsFor(hands(id, entry, 'participant')).map((tool) => tool.name)
  assert.ok(theirs.includes('edit_cell'), 'there is an open cell but no tool for it')

  const allowed = await call(hands(id, entry, 'participant'), 'edit_cell', {
    cellId: cellId(open),
    source: 'мой ответ',
  })
  assert.equal(allowed.step.kind, 'write')
  assert.equal(source(id, 1), 'мой ответ')

  const refused = await call(hands(id, entry, 'participant'), 'edit_cell', {
    cellId: cellId(closed),
    source: 'и тут тоже',
  })
  assert.equal(refused.step.kind, 'note')
  assert.match(refused.said, /преподавател/i)

  const theirCell = await call(hands(id, entry, 'participant'), 'remove_cell', {
    cellId: cellId(open),
  })
  assert.match(theirCell.said, /убирает преподаватель/, 'an open cell gave the right to remove it')

  const host = await call(hands(id, entry, 'host'), 'edit_cell', {
    cellId: cellId(closed),
    source: '# Разбор',
  })
  assert.equal(host.step.kind, 'write')
  assert.equal(source(id, 0), '# Разбор')
})

test('after the bell even a teacher-style turn of a participant does not edit the notebook', async () => {
  const id = room()
  const entry = turn(id)
  setFinished(id, Date.now())

  const tried = await call(hands(id, entry, 'participant'), 'edit_cell', {
    cellId: cellId(cells(id)[1]),
    source: 'x = 1',
  })
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /Занятие закончено/)
  assert.equal(source(id, 1), 'print("hello, seminar")')

  // The teacher may: the room stays theirs after the bell.
  const host = await call(hands(id, entry, 'host'), 'edit_cell', {
    cellId: cellId(cells(id)[1]),
    source: 'x = 1',
  })
  assert.equal(host.step.kind, 'write')
  setFinished(id, null)
})

/* ---------------------------------------------------- creates a notebook */

test('create_notebook creates a room notebook, and add_cell writes into it right away', async () => {
  const id = room()
  const entry = turn(id)

  const made = await call(hands(id, entry), 'create_notebook', { path: 'Сирена' })
  assert.equal(made.step.kind, 'new')
  // The extension is added by itself: "make a Сирена notebook" is an ordinary request.
  assert.equal(made.step.target, 'Сирена.ipynb')
  assert.ok(bookList(getSessionDoc(id).doc).some((book) => book.path === 'Сирена.ipynb'))
  // The cell list arrives with the same step: the cell name is needed right away.
  assert.match(made.said, /Сирена\.ipynb/)
  assert.match(made.said, /c_[0-9a-z]+/)

  const added = await call(hands(id, entry), 'add_cell', {
    path: 'Сирена.ipynb',
    type: 'code',
    source: 'print(1)',
  })
  assert.equal(added.step.kind, 'new')
  assert.match(added.step.target, /Сирена\.ipynb/)

  // And the file on disk is a real notebook, not a stub next to the room.
  projectBooks(id)
  assert.match(readText(id, 'Сирена.ipynb')?.text ?? '', /"nbformat"/)

  /*
   * And no "as it was before the turn" copy next to it.
   *
   * The first real run put an empty `…before-oracle.ipynb` next to the brand
   * new notebook and added to the answer that it could not remove it, ask
   * the teacher. Before the turn this notebook did not exist at all: there is
   * nowhere to go back to.
   */
  assert.equal(readText(id, 'Сирена.before-oracle.ipynb'), null)
  const said = saidAboutCells(id, entry)
  assert.doesNotMatch(said, /before-oracle/)
  // And the truth is told about going back: there is nowhere to go, not "in the version history".
  assert.match(said, /до хода не было/)
})

test('a notebook is not written as a file, neither one known to the room nor one not created yet', async () => {
  const id = room()
  const entry = turn(id)

  // Not a room notebook yet: the write used to pass silently and lead the turn into a dead end.
  const unknown = await call(hands(id, entry), 'write_file', {
    path: '03_Sirena.ipynb',
    content: '{"cells": [], "nbformat": 4}',
  })
  assert.equal(unknown.step.kind, 'note')
  assert.match(unknown.said, /create_notebook/)
  assert.equal(readText(id, '03_Sirena.ipynb'), null, 'the file got written anyway')

  // A notebook known to the room: the refusal leads to the cells.
  const mine = await call(hands(id, entry), 'write_file', {
    path: bookList(getSessionDoc(id).doc)[0].path,
    content: '{}',
  })
  assert.equal(mine.step.kind, 'note')
  assert.match(mine.said, /read_notebook|edit_cell/)

  // And an edit by a piece too.
  const edited = await call(hands(id, entry), 'edit_file', {
    path: '04_Drugaya.ipynb',
    find: 'a',
    replace: 'b',
  })
  assert.equal(edited.step.kind, 'note')
  assert.match(edited.said, /create_notebook/)
})

test('for a missing notebook the refusal names a way out, not only the absence', async () => {
  const id = room()
  const entry = turn(id)
  const asked = await call(hands(id, entry), 'add_cell', {
    path: 'Нет такой.ipynb',
    type: 'code',
    source: 'x = 1',
  })
  assert.equal(asked.step.kind, 'note')
  assert.match(asked.said, /create_notebook/)

  // A participant in a lecture has nothing to create it with, and is told to go to the teacher.
  setRules(id, { ...LECTURE_ROOM })
  const student = await call(hands(id, entry, 'participant'), 'add_cell', {
    path: 'Нет такой.ipynb',
    type: 'code',
    source: 'x = 1',
  })
  assert.match(student.said, /преподавател/i)
  assert.doesNotMatch(student.said, /create_notebook/)
  setRules(id, {} as never)
})

test('notebooks may be created by whoever may both write files and change structure', () => {
  const id = room()
  const names = () => toolsFor(hands(id, turn(id))).map((tool) => tool.name)
  assert.ok(names().includes('create_notebook'))
  assert.ok(names().includes('run_cell'))
  setRules(id, { ...LECTURE_ROOM })
  const student = toolsFor(hands(id, turn(id), 'participant')).map((tool) => tool.name)
  assert.ok(!student.includes('create_notebook'), 'a participant in a lecture was allowed to create notebooks')
  assert.ok(!student.includes('run_cell'), 'a participant in a lecture was allowed to run cells')
  setRules(id, {} as never)
})

/* ------------------------------------------------------- looks at output */

test('read_notebook returns a page and, if asked, the outputs themselves', async () => {
  const id = room()
  const entry = turn(id)
  const doc = getSessionDoc(id).doc
  doc.transact(() =>
    cellOutputs(cells(id)[1]).push([
      writeOutput({ kind: 'stream', name: 'stdout', text: 'сирена 07:14\n' }),
    ]),
  )
  for (let i = 0; i < 8; i++) {
    await call(hands(id, entry), 'add_cell', { type: 'code', source: `x = ${i}` })
  }

  const page = await call(hands(id, entry), 'read_notebook', { from: 3, count: 2 })
  assert.match(page.said, /Показаны ячейки 3–4 из 10/)
  assert.match(page.said, /read_notebook по .+ с from: 5/)

  const plain = await call(hands(id, entry), 'read_notebook', {})
  assert.doesNotMatch(plain.said, /сирена 07:14/, 'the outputs went along without being asked for')
  const withOut = await call(hands(id, entry), 'read_notebook', { outputs: true })
  assert.match(withOut.said, /out\[stdout\]/)
  assert.match(withOut.said, /сирена 07:14/)
})

test('run_cell refuses humanely where running is not allowed', async () => {
  const id = room()
  const entry = turn(id)
  const markdown = cellId(cells(id)[0])

  const notCode = await call(hands(id, entry), 'run_cell', { cell: markdown })
  assert.equal(notCode.step.kind, 'note')
  assert.match(notCode.said, /не ячейка с кодом/)

  const missing = await call(hands(id, entry), 'run_cell', { cell: 'c_нет' })
  assert.equal(missing.step.kind, 'note')

  // Already computing: it is not queued a second time, and the output of someone else's run is not appropriated.
  const code = cells(id)[1]
  getSessionDoc(id).doc.transact(() => code.set('state', 'running'))
  const busy = await call(hands(id, entry), 'run_cell', { cell: cellId(code) })
  assert.equal(busy.step.kind, 'note')
  assert.match(busy.said, /очеред|считается/)
  getSessionDoc(id).doc.transact(() => code.set('state', 'idle'))

  // The `run` rule is the same as for the fingers of the person asking.
  setRules(id, { ...LECTURE_ROOM })
  const student = await call(hands(id, entry, 'participant'), 'run_cell', { cell: cellId(code) })
  assert.equal(student.step.kind, 'note')
  assert.match(student.said, /преподавател/i)
  setRules(id, {} as never)
})

/* ----------------------------------- what a script did behind the hands */

test('script edits made around the tools are named one by one', () => {
  const id = room()
  writeText(id, 'data.csv', 'a,b\n1,2\n')
  writeText(id, 'train.py', 'print(1)\n')
  const was = treePrint(id)
  assert.equal(movedFiles(id, was), '', 'nothing was moved, yet it says something was')

  writeText(id, 'train.py', 'print(2)\nprint(3)\n')
  writeText(id, '_archive.py', 'import os\n')
  rmSync(path.join(sessionDir(id), 'data.csv'))
  const said = movedFiles(id, was)
  assert.match(said, /data\.csv \(удалён\)/)
  assert.match(said, /train\.py \(переписан\)/)
  assert.match(said, /_archive\.py \(заведён\)/)
})

test('an unknown tool names the ones that exist, and malformed JSON names its schema', async () => {
  const id = room()
  const entry = turn(id)
  const missing = await useTool(hands(id, entry), 'read_the_notebook', '{}')
  assert.equal(missing.step.kind, 'note')
  assert.match(missing.said, /read_notebook/)
  assert.match(missing.said, /list_files/)

  const broken = await useTool(hands(id, entry), 'read_file', '{path: train.py}')
  assert.equal(broken.step.kind, 'note')
  assert.match(broken.said, /"offset"/, 'the tool schema is not named in the refusal')
})
