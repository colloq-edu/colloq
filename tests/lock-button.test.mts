/**
 * The lock on a cell through the teacher's eyes: what a click does and what
 * the hint promises.
 *
 * On `cell:open` the server opens the way the room is set up (control.ts ·
 * `opens`), and the button must read the same rule. Otherwise in a council
 * room the hint promised "open to the room" and implied that council is only
 * by holding, and after the first click the second one opened the menu
 * instead of closing the cell: "a mistake is fixed by the same press" stopped
 * being true exactly where people press mid-sentence.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lockHint, lockLabel, lockPress } from '../web/src/lib/lock-button.js'

test('in a lecture a click toggles closed ↔ open to all, council is behind the menu', () => {
  assert.deepEqual(lockPress('closed', 'shared'), { kind: 'open', open: true })
  assert.deepEqual(lockPress('open', 'shared'), { kind: 'open', open: false })
  // A click never led into council — a click on it opens the menu.
  assert.deepEqual(lockPress('council', 'shared'), { kind: 'menu' })

  /*
   * The two lock modes are named the same everywhere they are talked about:
   * in the rules line, in the lock menu and in the hint. Different names for
   * one and the same thing are exactly why "open cell" explained nothing.
   */
  assert.equal(lockLabel('closed', 'shared'), 'Открыть ячейку: пишут вместе')
  assert.equal(lockLabel('open', 'shared'), 'Закрыть ячейку')
  assert.equal(lockLabel('council', 'shared'), 'Изменить доступ к ячейке')
  assert.equal(lockHint('closed', 'shared'), 'Открыть ячейку: пишут вместе · удержать — выбрать доступ')
  assert.equal(lockHint('open', 'shared'), 'Закрыть ячейку · удержать — выбрать доступ')
  assert.equal(lockHint('council', 'shared'), 'Консилиум · щелчок — настроить доступ к ячейке')
})

test('in council a click toggles closed ↔ council, and the second press closes', () => {
  // The first click opens (the server turns it into council by the rule).
  assert.deepEqual(lockPress('closed', 'council'), { kind: 'open', open: true })
  // The second one closes rather than opening the menu: a miss is fixed by
  // the same press.
  assert.deepEqual(lockPress('council', 'council'), { kind: 'open', open: false })
  // A cell opened to all through the menu is also closed by a click.
  assert.deepEqual(lockPress('open', 'council'), { kind: 'open', open: false })

  // The hint promises exactly what will happen: council, not shared text.
  assert.equal(lockLabel('closed', 'council'), 'Открыть консилиум в этой ячейке')
  assert.equal(lockLabel('council', 'council'), 'Закрыть ячейку')
  assert.equal(lockLabel('open', 'council'), 'Закрыть ячейку')
  assert.equal(
    lockHint('closed', 'council'),
    'Открыть консилиум в этой ячейке · удержать — выбрать доступ',
  )
  assert.equal(lockHint('council', 'council'), 'Закрыть ячейку · удержать — выбрать доступ')
  assert.equal(lockHint('open', 'council'), 'Закрыть ячейку · удержать — выбрать доступ')
  // No hint in a council room promises shared text on a click.
  for (const state of ['closed', 'open', 'council'] as const) {
    assert.equal(lockHint(state, 'council').includes('комнате'), false)
    assert.equal(lockLabel(state, 'council').includes('комнате'), false)
  }
})
