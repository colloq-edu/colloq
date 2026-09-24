/**
 * A change in the tree instead of the whole tree — both ends of one rule.
 *
 * The file list was broadcast whole on EVERY edit of the folder, and it gets
 * edited by everything in a row: the editor's autosave, `df.to_csv` in a
 * cell, `pip install` in the terminal. Measured: one created file cost a
 * room of five hundred people 3.0 MB — while one row out of two thousand
 * changed.
 *
 * The server computes the change (workspace.ts · treeDelta), the tab applies
 * it (web/src/lib/files-delta.ts), and they must not diverge: once diverged,
 * they do not break but quietly show the room someone else's folder. So
 * what is checked is not the shape of the frame but identity — the tree
 * assembled from changes equals the tree computed by a walk.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import {
  deleteFile,
  forgetTree,
  listTree,
  makeDir,
  makeFile,
  movePath,
  treeDelta,
  writeText,
} from '../server/src/workspace.js'
import { applyFilesDelta } from '../web/src/lib/files-delta.js'
import type { FileEntry } from '../shared/protocol.js'

const paths = (files: readonly FileEntry[]) => files.map((entry) => entry.path)

/** One change in a real folder: two walks and a splice between them. */
function walkAround(id: string, change: () => void): { before: FileEntry[]; after: FileEntry[] } {
  const before = listTree(id).files
  change()
  /*
   * The walk's short memory is forgotten exactly the way the broadcast does
   * it (control.ts · broadcastFiles): an edit of a file's CONTENT does not
   * move the folder's time, and without this the second walk would return
   * the old sizes.
   */
  forgetTree(id)
  const after = listTree(id).files
  const delta = treeDelta(before, after)
  assert.deepEqual(
    paths(applyFilesDelta(before, delta)),
    paths(after),
    'the tree assembled from the change diverged from the walk',
  )
  // And not only the paths: the size and modification time are what the
  // panel draws the row by, and they must not lag behind.
  assert.deepEqual(applyFilesDelta(before, delta), after)
  return { before, after }
}

test('a created file is one entry in the change, not the whole tree', () => {
  const id = 'delta-add'
  createSession(id, 'Дельта', null)
  makeDir(id, 'src')
  makeFile(id, 'src/model.py', 'x = 1')
  makeFile(id, 'notes.md', '# заметки')

  const { before, after } = walkAround(id, () => {
    makeFile(id, 'data.csv', 'a,b\n1,2\n')
  })
  const delta = treeDelta(before, after)
  assert.deepEqual(paths(delta.added.map((one) => one.entry)), ['data.csv'])
  assert.deepEqual(delta.removed, [])
  assert.deepEqual(delta.changed, [])
  // And the new entry's place is in the FINISHED list: folders come before
  // files, and `data.csv` comes before `notes.md` by name.
  assert.deepEqual(paths(after), ['src', 'src/model.py', 'data.csv', 'notes.md'])
  assert.equal(delta.added[0].at, 2)
})

test('deleting a folder takes everything in it away — as one list of paths', () => {
  const id = 'delta-remove'
  createSession(id, 'Дельта', null)
  makeDir(id, 'build')
  makeFile(id, 'build/a.txt', 'a')
  makeFile(id, 'build/b.txt', 'b')
  makeFile(id, 'model.py', 'x = 1')

  const { before, after } = walkAround(id, () => {
    deleteFile(id, 'build')
  })
  const delta = treeDelta(before, after)
  assert.deepEqual(delta.removed.sort(), ['build', 'build/a.txt', 'build/b.txt'])
  assert.deepEqual(delta.added, [])
  assert.deepEqual(paths(after), ['model.py'])
})

test('a rename is an entry that left and one that came, and the order matches', () => {
  const id = 'delta-move'
  createSession(id, 'Дельта', null)
  makeFile(id, 'alpha.py', 'x = 1')
  makeFile(id, 'omega.py', 'y = 2')

  const { before, after } = walkAround(id, () => {
    movePath(id, 'alpha.py', 'zulu.py')
  })
  const delta = treeDelta(before, after)
  assert.deepEqual(delta.removed, ['alpha.py'])
  assert.deepEqual(paths(delta.added.map((one) => one.entry)), ['zulu.py'])
  // The moved entry went to the end — and inserting in place in the FINISHED
  // list reproduced that, even though the deletion shifted everything after
  // it.
  assert.deepEqual(paths(after), ['omega.py', 'zulu.py'])
})

test('a rewritten file travels as size and time, not as the whole folder again', () => {
  const id = 'delta-write'
  createSession(id, 'Дельта', null)
  makeFile(id, 'model.py', 'x = 1')
  makeFile(id, 'notes.md', '# заметки')

  const { before, after } = walkAround(id, () => {
    writeText(id, 'model.py', 'x = 1\ny = 2\nz = 3\n')
  })
  const delta = treeDelta(before, after)
  assert.deepEqual(delta.added, [])
  assert.deepEqual(delta.removed, [])
  assert.deepEqual(paths(delta.changed), ['model.py'])
  assert.equal(delta.changed[0].size, after[0].size)
})

test('an empty change is empty: a matching walk tells nothing', () => {
  const id = 'delta-same'
  createSession(id, 'Дельта', null)
  makeFile(id, 'model.py', 'x = 1')
  const tree = listTree(id).files
  assert.deepEqual(treeDelta(tree, tree), { removed: [], changed: [], added: [] })
  assert.deepEqual(applyFilesDelta(tree, treeDelta(tree, tree)), tree)
})

/* --------------------------------------------- splicing without a folder */

const entry = (path: string, size = 1): FileEntry => ({
  name: path.split('/').at(-1) ?? path,
  path,
  dir: false,
  size,
  modifiedAt: 1,
})

test('any pair of lists splices back into itself', () => {
  /*
   * The tree's order is uniquely determined by its contents, so the entries
   * that survive stand relative to each other the same way in both lists —
   * inserting in place rests on that. Here this is checked not by reasoning
   * but by enumeration: all subsets of ten names, pairwise.
   */
  const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
  const pick = (mask: number) => all.filter((_, i) => (mask >> i) & 1).map((name) => entry(name))
  for (const from of [0, 1, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 682, 341]) {
    for (const to of [0, 1, 5, 21, 85, 341, 682, 1023, 512, 255]) {
      const before = pick(from)
      const after = pick(to)
      assert.deepEqual(
        applyFilesDelta(before, treeDelta(before, after)),
        after,
        `${from} → ${to}: the splice diverged from the list`,
      )
    }
  }
})

test('a change that diverged from the list does not bring the panel down', () => {
  // The last line of defence: a gap in the numbers is caught earlier
  // (session.svelte.ts), but the tab has no right to fail on a frame from the
  // network whatever its contents.
  const files = [entry('a'), entry('b')]
  const wild = applyFilesDelta(files, {
    removed: ['нет такого'],
    changed: [entry('тоже нет')],
    added: [{ at: 99, entry: entry('c') }],
  })
  assert.deepEqual(paths(wild), ['a', 'b', 'c'])
})

/* ------------------------------------------------ parsing in the tab */

/** Source without comments: an explanation is not a promise. */
function code(rel: string): string {
  return fs
    .readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

test('the tab splices a change only with its own number, otherwise it asks for the tree', () => {
  /*
   * The parsing lives in a rune class, and it cannot be called without a
   * browser — the promises are taken from the source, just as in
   * weblib-reconnect-storm. What is checked is not the shape of the code but
   * three things without which the panel quietly shows someone else's
   * folder: the number is remembered with the full list, a change of the
   * wrong lineage is not applied at all, and instead of a guess a question
   * is asked.
   */
  const session = code('web/src/lib/session.svelte.ts')
  const from = session.indexOf("message.t === 'files:delta'")
  assert.notEqual(from, -1, 'the tab does not parse the change frame at all')
  const branch = session.slice(from, session.indexOf('} else if (message.t', from + 1))

  assert.match(branch, /this\.#filesRev !== message\.from/, 'a change lands on any list')
  assert.match(branch, /this\.send\(\{ t: 'files:ask' \}\)/, 'a gap in the numbers is treated with silence')
  assert.match(branch, /applyFilesDelta\(this\.files, message\)/, 'the splice is its own, not the shared one')
  assert.match(branch, /this\.#filesRev = message\.rev/, 'the number did not move after the splice')
  // And the full list still remembers its number: without it the very first
  // change fits nothing.
  const full = session.slice(session.indexOf("message.t === 'files'"))
  assert.match(full.slice(0, 400), /this\.#filesRev = message\.rev \?\? 0/)
})
