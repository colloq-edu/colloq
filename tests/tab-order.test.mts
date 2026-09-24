/**
 * Tab order: what dragging does.
 *
 * The decision is separate from the mouse — the same technique as dragging in
 * the file tree (web/src/lib/tree-move.ts): only one thing is worth checking —
 * WHERE the tab landed — and that needs neither a browser nor an event.
 *
 * The rule all of this was written for: insertion on the side that matches the
 * DIRECTION of the drag. Dragged left — the tab lands before the target;
 * right — after it. Take a single "always before", and half the gesture stops
 * working: a tab is dragged onto its right neighbour, it returns to its own
 * place, and the person drags again.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reordered, Tabs, type Room } from '../web/src/lib/tabs.svelte.js'

/*
 * The same two fakes as in panels.test.mts, and for the same reasons: there is
 * no Svelte compiler here, and `$state` stays an ordinary call; Node has no
 * storage, and without it the main thing cannot be checked — that the order
 * survives a reload.
 */
;(globalThis as { $state?: unknown }).$state = <T,>(value: T): T => value
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}

const ROW = ['a.py', 'b.py', 'c.py', 'd.py']

test('dragged right — it lands AFTER the target', () => {
  assert.deepEqual(reordered(ROW, 'a.py', 'c.py'), ['b.py', 'c.py', 'a.py', 'd.py'])
})

test('dragged left — it lands BEFORE the target', () => {
  assert.deepEqual(reordered(ROW, 'd.py', 'b.py'), ['a.py', 'd.py', 'b.py', 'c.py'])
})

test('neighbours swap places in one move', () => {
  // The most frequent gesture, and it must work in both directions.
  assert.deepEqual(reordered(ROW, 'a.py', 'b.py'), ['b.py', 'a.py', 'c.py', 'd.py'])
  assert.deepEqual(reordered(ROW, 'b.py', 'a.py'), ['b.py', 'a.py', 'c.py', 'd.py'])
})

test('a drop into the empty space on the right goes to the end of the row', () => {
  assert.deepEqual(reordered(ROW, 'a.py', null), ['b.py', 'c.py', 'd.py', 'a.py'])
  // And a tab that is already last does not move anywhere.
  assert.deepEqual(reordered(ROW, 'd.py', null), ROW)
})

test('a drop onto itself changes nothing', () => {
  assert.deepEqual(reordered(ROW, 'c.py', 'c.py'), ROW)
})

test('a foreign tab can be a target, but not the tab being moved', () => {
  // Tabs pinned by the room (the shared screen, the lecture) are not among
  // one's own. A drop ONTO them means "first among one's own", right after the
  // pinned ones.
  assert.deepEqual(reordered(ROW, 'c.py', 'лекция.pdf'), ['c.py', 'a.py', 'b.py', 'd.py'])
  // And the pinned one itself cannot be moved: it is not in the row of one's
  // own.
  assert.deepEqual(reordered(ROW, 'лекция.pdf', 'a.py'), ROW)
})

test('the order survives a tab reload', () => {
  /*
   * This is what the order is changed for: having arranged the files to their
   * liking, a person must not have to arrange them again after F5. The write
   * goes the same way as for opening and closing — `#remember`.
   */
  const room: Room = { alive: new Set(['a.py', 'b.py', 'c.py']), firstBook: 'a.py', board: null }
  const first = new Tabs('order-room')
  first.settle(room)
  first.open('b.py')
  first.open('c.py')
  assert.deepEqual(first.row(null), ['a.py', 'b.py', 'c.py'])
  first.reorder('c.py', 'a.py')
  assert.deepEqual(first.row(null), ['c.py', 'a.py', 'b.py'])

  const again = new Tabs('order-room')
  again.settle(room)
  assert.deepEqual(again.row(null), ['c.py', 'a.py', 'b.py'], 'the order was reset after the reload')
})

test('reordering does not switch the tab', () => {
  // A person is arranging tabs, not walking through them: taking them away
  // from the one they are reading means doing a second action for them that
  // they did not ask for.
  const room: Room = { alive: new Set(['a.py', 'b.py', 'c.py']), firstBook: 'a.py', board: null }
  const tabs = new Tabs('order-stay')
  tabs.settle(room)
  tabs.open('b.py')
  tabs.open('c.py')
  tabs.show('b.py')
  tabs.reorder('a.py', null)
  assert.equal(tabs.active, 'b.py')
})

test('a tab pinned by the room does not move even when asked', () => {
  const room: Room = { alive: new Set(['a.py', 'общий.pdf']), firstBook: 'a.py', board: 'общий.pdf' }
  const tabs = new Tabs('order-pinned')
  tabs.settle(room)
  assert.deepEqual(tabs.row('общий.pdf'), ['общий.pdf', 'a.py'])
  tabs.reorder('общий.pdf', 'a.py')
  assert.deepEqual(tabs.row('общий.pdf'), ['общий.pdf', 'a.py'], 'the shared screen was moved by one participant')
})
