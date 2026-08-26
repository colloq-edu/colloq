/**
 * A filename in a lane too narrow for it.
 *
 * `text-overflow: ellipsis` always eats the tail, and the tail is the part that
 * says what the file *is*. In a 280px Files panel the list showed
 * `cifar10-validation` and `семинар 7 — заметк` — no ellipsis, no extension —
 * so an .npz and an .md read as the same kind of row. The name is split so the
 * stem can shrink and the extension cannot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitFileName } from '../web/src/lib/utils.js'

test('the extension is held back from the part that shrinks', () => {
  assert.deepEqual(splitFileName('cifar10-validation-features-2024-11.npz'), {
    stem: 'cifar10-validation-features-2024-11',
    ext: '.npz',
  })
})

test('a name in another alphabet splits the same way', () => {
  assert.deepEqual(splitFileName('семинар 7 — заметки.md'), {
    stem: 'семинар 7 — заметки',
    ext: '.md',
  })
})

test('a name with no extension is all stem', () => {
  assert.deepEqual(splitFileName('LICENSE'), { stem: 'LICENSE', ext: '' })
})

test('a dotfile is a name, not an extension', () => {
  // .gitignore must not render as an empty stem beside a fixed ".gitignore".
  assert.deepEqual(splitFileName('.gitignore'), { stem: '.gitignore', ext: '' })
})

test('only the last extension is held back', () => {
  assert.deepEqual(splitFileName('archive.tar.gz'), { stem: 'archive.tar', ext: '.gz' })
})

test('a sentence with a full stop does not reserve half the lane', () => {
  // Otherwise ". Ivanov notes" would be pinned open and the useful part cut.
  assert.deepEqual(splitFileName('Prof. Ivanov notes'), {
    stem: 'Prof. Ivanov notes',
    ext: '',
  })
})

test('a trailing dot is a typo, not an extension', () => {
  assert.deepEqual(splitFileName('data.'), { stem: 'data.', ext: '' })
})

test('an absurdly long extension is treated as part of the name', () => {
  const name = 'export.averylongsuffix'
  assert.deepEqual(splitFileName(name), { stem: name, ext: '' })
})

test('the two halves always rebuild the original', () => {
  for (const name of [
    'data.csv',
    'LICENSE',
    '.gitignore',
    'archive.tar.gz',
    'семинар 7 — заметки.md',
    'Prof. Ivanov notes',
    'data.',
    'a.b',
  ]) {
    const { stem, ext } = splitFileName(name)
    assert.equal(stem + ext, name, `${name} did not survive the split`)
  }
})
