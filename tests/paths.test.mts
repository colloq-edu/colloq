/**
 * The seminar folder is no longer flat, and every line here is an attempt to
 * get out of it or to put into it something that will not be shown later.
 *
 * The check is one for both: the browser calls it to refuse before the
 * network, the server to refuse on the merits. Once they diverge, they give
 * the worst kind of error: the panel is sure the name is fine, and the server
 * silently does not accept it.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  MAX_DEPTH,
  baseOf,
  extOf,
  highlightFor,
  kindOf,
  normalizePath,
  parentOf,
  runnerFor,
  safeSegment,
} from '../shared/paths.js'
import { createSession } from '../server/src/db.js'
import {
  listFiles,
  listTree,
  makeDir,
  makeFile,
  movePath,
  readText,
  resolveInSession,
  sessionDir,
  writeText,
} from '../server/src/workspace.js'

test('a path outward does not turn into a path inward', () => {
  for (const raw of [
    '../secret',
    '../../etc/passwd',
    'src/../../out',
    '/etc/passwd',
    '/',
    './../x',
    'a/./b',
    'a/../b',
    'src/..',
  ]) {
    assert.equal(normalizePath(raw), null, raw)
  }
})

test('an absolute path is rejected, not trimmed down to a relative one', () => {
  // Trimming would be safe and dishonest: the person meant a file on the machine
  // and would get a new `etc` folder inside the seminar with nothing in it.
  assert.equal(normalizePath('/data/train.csv'), null)
  assert.equal(normalizePath('data/train.csv'), 'data/train.csv')
})

test('extra separators are removed, names are not', () => {
  assert.equal(normalizePath('src//model.py'), 'src/model.py')
  assert.equal(normalizePath('src/model.py/'), 'src/model.py')
  assert.equal(normalizePath('данные/пример данных.csv'), 'данные/пример данных.csv')
  assert.equal(normalizePath(''), '', 'the root is an empty string, not a refusal')
})

test('nothing deeper than the ceiling is let in', () => {
  const ok = Array.from({ length: MAX_DEPTH }, (_, i) => `d${i}`).join('/')
  assert.equal(normalizePath(ok), ok)
  assert.equal(normalizePath(`${ok}/one-too-deep`), null)
})

test('a hidden name is rejected rather than accepted and hidden', () => {
  for (const name of ['.env', '.git', '.ipynb_checkpoints']) {
    assert.equal(safeSegment(name), false, name)
    assert.equal(normalizePath(`src/${name}`), null, name)
  }
})

test('a space at the edge does not pass: such a name cannot be typed later', () => {
  assert.equal(safeSegment('model.py '), false)
  assert.equal(safeSegment(' model.py'), false)
  assert.equal(safeSegment('my model.py'), true)
})

test('splitting a path into parts', () => {
  assert.equal(parentOf('src/deep/model.py'), 'src/deep')
  assert.equal(parentOf('model.py'), '')
  assert.equal(baseOf('src/model.py'), 'model.py')
  assert.equal(extOf('src/model.PY'), 'py')
  assert.equal(extOf('Makefile'), '')
  assert.equal(extOf('.hidden'), '', 'a leading dot is not an extension')
})

test('what a file turns out to be on screen', () => {
  assert.equal(kindOf('train.py'), 'text')
  assert.equal(kindOf('data/train.csv'), 'text')
  assert.equal(kindOf('lecture.pdf'), 'pdf')
  assert.equal(kindOf('plot.png'), 'image')
  assert.equal(kindOf('seminar.ipynb'), 'notebook', 'a notebook is not edited as JSON')
  assert.equal(kindOf('model.pkl'), 'binary')
  assert.equal(kindOf('Makefile'), 'text')
})

test('only what there is something to run it with is runnable', () => {
  assert.equal(runnerFor('train.py'), 'python')
  assert.equal(runnerFor('setup.sh'), 'shell')
  assert.equal(runnerFor('data.csv'), null)
  assert.equal(runnerFor('seminar.ipynb'), null, 'a notebook is run cell by cell')
})

test('highlighting by extension, and silence where there is no grammar', () => {
  assert.equal(highlightFor('train.py'), 'python')
  assert.equal(highlightFor('README.md'), 'markdown')
  assert.equal(highlightFor('data.csv'), null)
})

/* --------------------------------------------------- the tree on disk */

const ROOM = 'tree-room'

test('the tree is read in the order it is drawn', () => {
  createSession(ROOM, 'Tree', null)
  const root = sessionDir(ROOM)
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n')
  fs.writeFileSync(path.join(root, 'src', 'model.py'), 'x = 1\n')
  fs.writeFileSync(path.join(root, 'data', 'train.csv'), 'a,b\n')

  const listed = listFiles(ROOM).map((entry) => `${entry.dir ? 'd ' : 'f '}${entry.path}`)
  assert.deepEqual(listed, ['d data', 'f data/train.csv', 'd src', 'f src/model.py', 'f README.md'])
  assert.equal(listTree(ROOM).truncated, false, 'an ordinary folder was declared truncated')
})

test('the tree ceiling cuts depth, not the root, and says so', () => {
  /*
   * `!unzip data.zip` in a cell is over two thousand images in one go. A
   * depth-first walk spent the whole ceiling on them before reaching the root
   * files, and the room's notebook disappeared from the list; everything that
   * detects a disappearance by this list deleted it for everyone, cells included.
   */
  const id = 'tree-cap'
  createSession(id, 'Потолок', null)
  const root = sessionDir(id)
  fs.mkdirSync(path.join(root, 'images'), { recursive: true })
  for (let i = 0; i < 2100; i++) fs.writeFileSync(path.join(root, 'images', `p${i}.png`), '')
  fs.writeFileSync(path.join(root, 'Тетрадь.ipynb'), '{}')
  fs.writeFileSync(path.join(root, 'train.py'), 'x = 1\n')

  const tree = listTree(id)
  const listed = tree.files.map((entry) => entry.path)
  assert.ok(listed.includes('Тетрадь.ipynb'), 'the room notebook fell out of the list')
  assert.ok(listed.includes('train.py'), 'the root files fell out of the list')
  assert.ok(listed.includes('images'))
  assert.ok(tree.files.length <= 2000, `${tree.files.length} rows: the ceiling did not work`)
  assert.equal(tree.truncated, true, 'the list was truncated silently')
})

test('a file name and its path are different fields, and at the root they coincide', () => {
  const listed = listFiles(ROOM)
  const nested = listed.find((entry) => entry.path === 'src/model.py')
  assert.equal(nested?.name, 'model.py')
  const root = listed.find((entry) => entry.path === 'README.md')
  assert.equal(root?.name, root?.path, 'for a file at the root, path and name are the same')
})

test('a symbolic link to an outside folder does not become a room folder', () => {
  // A cell runs any Python in the same folder: `os.symlink('/', 'all')` is one
  // line. The lstat-based walk refuses it both as a file and as a folder.
  const root = sessionDir(ROOM)
  const outside = fs.mkdtempSync(path.join(root, '..', 'outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'ключ')
  const link = path.join(root, 'elsewhere')
  fs.symlinkSync(outside, link)
  try {
    const listed = listFiles(ROOM).map((entry) => entry.path)
    assert.ok(!listed.includes('elsewhere'), 'a link to a foreign folder got into the tree')
    assert.ok(!listed.some((p) => p.startsWith('elsewhere/')), 'foreign content was read through the link')
    assert.equal(resolveInSession(ROOM, 'elsewhere/secret.txt'), null)
  } finally {
    fs.unlinkSync(link)
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('a new file does not land on top of an existing one', () => {
  assert.equal(makeFile(ROOM, 'src/model.py'), 'exists')
  assert.equal(readText(ROOM, 'src/model.py')?.text, 'x = 1\n', 'the file was overwritten after all')
  assert.equal(makeFile(ROOM, 'src/other.py', 'y = 2\n'), 'ok')
  assert.equal(readText(ROOM, 'src/other.py')?.text, 'y = 2\n')
})

test('a folder cannot be moved inside itself', () => {
  assert.equal(makeDir(ROOM, 'src/deep'), 'ok')
  assert.equal(movePath(ROOM, 'src', 'src/deep/src'), 'bad-name')
  assert.ok(readText(ROOM, 'src/model.py'), 'the subtree left the tree')
})

test('a rename moves both the content and the path', () => {
  assert.equal(movePath(ROOM, 'src/other.py', 'src/renamed.py'), 'ok')
  assert.equal(readText(ROOM, 'src/renamed.py')?.text, 'y = 2\n')
  assert.equal(readText(ROOM, 'src/other.py'), null)
})

test('a binary file does not open as text', () => {
  const root = sessionDir(ROOM)
  fs.writeFileSync(path.join(root, 'model.pkl'), Buffer.from([0x80, 0x04, 0x00, 0x95, 0x01]))
  const read = readText(ROOM, 'model.pkl')
  assert.equal(read?.binary, true)
  assert.equal(read?.text, '', 'garbage would get into the editor and offer to be saved')
})

test('a write goes next to the file and renames, not over it', () => {
  // The same argument as for uploads: `writeFileSync` first truncates the file to
  // zero, and a cell reading it at that moment reads half of it without an error.
  writeText(ROOM, 'data/train.csv', 'a,b\n1,2\n')
  assert.equal(readText(ROOM, 'data/train.csv')?.text, 'a,b\n1,2\n')
  const leftovers = fs
    .readdirSync(path.join(sessionDir(ROOM), 'data'))
    .filter((n) => n.startsWith('.'))
  assert.deepEqual(leftovers, [], 'a temporary file was left lying next to it')
})
