import { test } from 'node:test'
import assert from 'node:assert/strict'
import { languageMenuPosition } from '../web/src/admin/language-menu.js'

test('desktop menu aligns inside the rail and opens above its trigger', () => {
  assert.deepEqual(languageMenuPosition(
    { left: 0, right: 236, top: 792, width: 236 },
    { width: 252, height: 188 }, { width: 1440, height: 900 },
  ), { left: 12, top: 596 })
})

test('compact menu clears the rail and fits a 320px viewport', () => {
  assert.deepEqual(languageMenuPosition(
    { left: 0, right: 56, top: 736, width: 56 },
    { width: 252, height: 188 }, { width: 320, height: 844 },
  ), { left: 60, top: 540 })
})

test('a taller error message stays within a short or scrolled viewport', () => {
  const menu = { width: 252, height: 270 }
  for (const top of [20, 260, 600]) {
    const point = languageMenuPosition(
      { left: -10, right: 226, top, width: 236 }, menu, { width: 390, height: 400 },
    )
    assert.ok(point.left >= 8 && point.left + menu.width <= 382)
    assert.ok(point.top >= 8 && point.top + menu.height <= 392)
  }
})
