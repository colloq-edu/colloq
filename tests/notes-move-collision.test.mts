/**
 * Speaker notes when moving onto an occupied path.
 *
 * Notes live in the database under the key (room, file, page) and are NOT
 * deleted when the file is removed from the room — on purpose: re-uploading a
 * corrected PDF under the same name the day before class is more common than
 * starting the notes for twenty-four pages from scratch. The price of this
 * choice is a leftover under a path the file was removed from long ago, and a
 * move onto such a path hit the occupied key: in SQLite a conflict rolls back
 * the WHOLE statement, so not a single page moved, and the caller (control.ts,
 * `tree:move`) caught the exception and said nothing. An evening spent on the
 * notes stayed under a path that no longer exists on disk, and there was
 * nothing to bring it back with.
 *
 * Both sides of the deal are stitched down here: a move PUSHES OUT the
 * leftover, and whoever wants to erase the notes for a document on purpose
 * calls `discardNotesOf` — and erases only those.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSession,
  discardNotesOf,
  moveNotesTo,
  notesOf,
  setNote,
} from '../server/src/db.js'

let n = 0
function room(): string {
  const id = `notes-move-${(n += 1)}`
  createSession(id, 'Заметки при переезде', null)
  return id
}

test('a move onto a path with old notes wins over the leftover instead of failing', () => {
  const id = room()
  // Last autumn a draft lay here; it was annotated and removed. The rows
  // stayed.
  setNote(id, 'курс/лекция.pdf', 7, 'речь к прошлогоднему черновику')
  // Today's file, annotated last night.
  setNote(id, 'папка/лекция.pdf', 7, 'спросить про поток')
  setNote(id, 'папка/лекция.pdf', 12, 'вывести формулу на доске')

  moveNotesTo(id, 'папка/лекция.pdf', 'курс/лекция.pdf')

  assert.deepEqual(
    notesOf(id, 'курс/лекция.pdf'),
    { 7: 'спросить про поток', 12: 'вывести формулу на доске' },
    'the notes for the live file did not arrive, or arrived only in part',
  )
  assert.deepEqual(notesOf(id, 'папка/лекция.pdf'), {}, 'the notes also stayed on the old path')
})

test('undisputed pages move together with the disputed one instead of rolling back with it', () => {
  /*
   * Exactly the failure that cost the notes: ONE page was occupied, and a bare
   * UPDATE rolled back entirely, taking with it the ones nobody objected to.
   */
  const id = room()
  setNote(id, 'куда.pdf', 3, 'старое к третьей')
  setNote(id, 'откуда.pdf', 3, 'новое к третьей')
  setNote(id, 'откуда.pdf', 4, 'новое к четвёртой')
  setNote(id, 'откуда.pdf', 5, 'новое к пятой')

  moveNotesTo(id, 'откуда.pdf', 'куда.pdf')

  assert.deepEqual(notesOf(id, 'куда.pdf'), {
    3: 'новое к третьей',
    4: 'новое к четвёртой',
    5: 'новое к пятой',
  })
})

test('a move "onto itself" erases nothing', () => {
  // The same path — a degenerate case, but `UPDATE OR REPLACE` can delete,
  // and checking it is cheaper than explaining it one day.
  const id = room()
  setNote(id, 'l3.pdf', 1, 'начать с задачи про шар')

  moveNotesTo(id, 'l3.pdf', 'l3.pdf')

  assert.deepEqual(notesOf(id, 'l3.pdf'), { 1: 'начать с задачи про шар' })
})

test('another room and a neighbouring file do not notice the move', () => {
  const id = room()
  const other = room()
  setNote(id, 'a.pdf', 1, 'моя речь')
  setNote(id, 'сосед.pdf', 1, 'речь к соседнему файлу')
  setNote(other, 'b.pdf', 1, 'чужая речь')

  moveNotesTo(id, 'a.pdf', 'b.pdf')

  assert.deepEqual(notesOf(id, 'b.pdf'), { 1: 'моя речь' })
  assert.deepEqual(notesOf(id, 'сосед.pdf'), { 1: 'речь к соседнему файлу' })
  assert.deepEqual(notesOf(other, 'b.pdf'), { 1: 'чужая речь' }, 'the move reached into another room')
})

test('the notes for one document are erased separately from the whole room', () => {
  const id = room()
  setNote(id, 'l3.pdf', 1, 'про поток')
  setNote(id, 'l4.pdf', 1, 'про дивергенцию')

  discardNotesOf(id, 'l3.pdf')

  assert.deepEqual(notesOf(id, 'l3.pdf'), {})
  assert.deepEqual(notesOf(id, 'l4.pdf'), { 1: 'про дивергенцию' }, 'the neighbouring document was wiped')
})
