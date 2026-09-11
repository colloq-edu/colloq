import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextBuiltCells } from '../web/src/components/notebook/first-mount.js'

test('a large notebook initially constructs only near, selected, and running cells', () => {
  const ids = Array.from({ length: 279 }, (_, i) => `cell-${i}`)
  const first = nextBuiltCells(new Set(), ids, (id, index) => index < 10 || id === 'cell-200' || id === 'cell-250')
  assert.equal(first.size, 12)
  assert.ok(first.has('cell-200'))
  assert.ok(first.has('cell-250'))
  assert.ok(!first.has('cell-150'))
  const scrolled = nextBuiltCells(first, ids, (_, index) => index >= 140 && index < 150)
  assert.equal(scrolled.size, 22)
  assert.ok(scrolled.has('cell-0'), 'visited components retain editing state and subscriptions')
  assert.ok(scrolled.has('cell-149'))
  assert.equal(nextBuiltCells(scrolled, ids, () => false), scrolled, 'unchanged viewport preserves the set')
  assert.ok(!nextBuiltCells(scrolled, ids.filter((id) => id !== 'cell-0'), () => false).has('cell-0'))
})

test('a hidden notebook can defer every new cell while retaining existing ones', () => {
  const ids = ['first', 'second']
  assert.equal(nextBuiltCells(new Set(), ids, () => false).size, 0)
  assert.deepEqual([...nextBuiltCells(new Set(['first']), ids, () => false)], ['first'])
})
