/**
 * Which materials read on their page as a tab (shared/materials.ts ·
 * readsOnPage): Markdown, and nothing else that merely is text.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { materialKind, readsOnPage } from '../shared/materials.js'

test('Markdown reads on its page; plain text, code and data download', () => {
  for (const path of ['Что почитать.md', 'notes/README.MD', 'guide.markdown']) {
    assert.equal(readsOnPage(materialKind(path), path), true, path)
  }
  for (const path of ['notes.txt', 'solution.py', 'data/train.csv', 'slides.pdf', 'lecture.ipynb', 'data/']) {
    assert.equal(readsOnPage(materialKind(path), path), false, path)
  }
})
