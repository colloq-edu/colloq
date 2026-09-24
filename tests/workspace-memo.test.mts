/**
 * The short memory of the folder walk: what it was set up for and what it
 * must not do.
 *
 * The room tree is asked for twice in a row on every upload — the reply to
 * whoever pressed the button, and the broadcast to the whole room — and a walk
 * costs a `readdir` plus an `lstat` on each of two thousand entries, so the
 * memory is needed. But the folder is written to bypassing `workspace.ts`: an
 * upload puts the file in place with `rename`, a cell writes from the
 * container, the editor saves an open file. A memory that answers with a list
 * without the file just put there means a panel where the file is missing,
 * and a seminar card with zero files until the next change to the folder;
 * both times it lies to the very person who made that write.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { forgetTree, listTree, sessionDir } from '../server/src/workspace.js'

/** Put a file the way an upload does: bypassing the module and with `rename`. */
function drop(room: string, rel: string, text = 'x'): void {
  const full = path.join(sessionDir(room), rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  const temp = `${full}.uploading-a1b2c3`
  fs.writeFileSync(temp, text)
  fs.renameSync(temp, full)
}

function names(room: string): string[] {
  return listTree(room)
    .files.map((f) => f.path)
    .sort()
}

/**
 * The probe must fit in the memory window, otherwise it checks nothing:
 * beyond it the tree is recomputed anyway. Three hundred milliseconds for a
 * few writes and walks of an empty folder is a margin of hundreds of times,
 * and a red test here means not "broken" but "could not be checked".
 */
function withinWindow(startedAt: number): void {
  assert.ok(
    Date.now() - startedAt < 300,
    'the probe went past the walk memory window — it proves nothing',
  )
}

test('a file put in bypassing the module is visible at once, not when the memory expires', () => {
  const room = 'memo-upload'
  const startedAt = Date.now()
  drop(room, 'handout.csv')
  assert.deepEqual(names(room), ['handout.csv'])

  drop(room, 'src/nested/model.py')
  assert.equal(fs.existsSync(path.join(sessionDir(room), 'src/nested/model.py')), true)
  assert.deepEqual(names(room), ['handout.csv', 'src', 'src/nested', 'src/nested/model.py'])
  withinWindow(startedAt)
})

test('a file in an already walked subfolder — also at once', () => {
  const room = 'memo-nested'
  const startedAt = Date.now()
  drop(room, 'src/a.py')
  assert.deepEqual(names(room), ['src', 'src/a.py'])

  // The root does not change meanwhile: only the modification time of `src`
  // moves.
  drop(room, 'src/b.py')
  assert.deepEqual(names(room), ['src', 'src/a.py', 'src/b.py'])
  withinWindow(startedAt)
})

test('the memory does not survive a deletion that bypasses the module either', () => {
  const room = 'memo-delete'
  const startedAt = Date.now()
  drop(room, 'a.txt')
  drop(room, 'b.txt')
  assert.deepEqual(names(room), ['a.txt', 'b.txt'])

  fs.unlinkSync(path.join(sessionDir(room), 'b.txt'))
  assert.deepEqual(names(room), ['a.txt'])
  withinWindow(startedAt)
})

test('while the folder has not changed, a second question in a row does not cost a second walk', () => {
  const room = 'memo-hit'
  drop(room, 'a.txt')
  const first = listTree(room)
  const second = listTree(room)
  // The same array, not an equal one: there was no walk. That is what the
  // memory is for.
  assert.equal(second.files, first.files)

  forgetTree(room)
  const third = listTree(room)
  assert.notEqual(third.files, first.files)
  assert.deepEqual(
    third.files.map((f) => f.path),
    first.files.map((f) => f.path),
  )
})
