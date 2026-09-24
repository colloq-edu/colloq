/**
 * Presence bookkeeping: what reaches the screen and what does not.
 *
 * Presence is the chattiest wire in the product: the cursor is published on
 * every keystroke by each of five hundred people, and previously every such
 * frame rebuilt the people list as a new array. A new array wakes ALL of its
 * readers: the counter in the header, the people panel, the Oracle's avatars
 * and the "who ran this" lookup in every mounted cell — that is, hundreds of
 * rebuilds a second on every laptop in the room.
 *
 * This breaks silently: the interface stays correct, typing just lags for
 * everyone. So what is checked here is not "what is drawn" but "what got
 * through": the identity of the array after a frame in which nothing drawn
 * has changed — the only thing that tells the fixed from the broken.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextPeers,
  peersById,
  samePeerUser,
  PRESENCE_TICK_MS,
  type Peer,
} from '../web/src/lib/peers.js'
import type { AwarenessUser } from '../shared/protocol.js'

function user(over: Partial<AwarenessUser> = {}): AwarenessUser {
  return {
    id: 'p1',
    name: 'Ада',
    avatar: null,
    color: '#0FA0D7',
    role: 'participant',
    activeCellId: null,
    ...over,
  }
}

/** Presence states as `awareness.getStates()` returns them. */
function states(...rows: [number, AwarenessUser][]): Map<number, { user: AwarenessUser }> {
  return new Map(rows.map(([id, u]) => [id, { user: u }]))
}

test('a frame in which nothing drawn has changed reaches no one', () => {
  const self = 7
  const first = nextPeers(states([self, user({ id: 'me', name: 'Я' })], [8, user()]), self, [])
  assert.equal(first.length, 2)

  // The same line-up, but the presence objects are DIFFERENT: they are
  // decoded anew on every frame, and identity by itself means nothing.
  const again = nextPeers(states([self, user({ id: 'me', name: 'Я' })], [8, user()]), self, first)
  assert.equal(again, first, 'a new array came back — all readers woke up')
})

test('a cursor that moved within the same cell does not count as a change', () => {
  const before = nextPeers(states([8, user({ activeCellId: 'c1' })]), 7, [])
  const after = nextPeers(states([8, user({ activeCellId: 'c1' })]), 7, before)
  assert.equal(after, before)
})

test('moving to another cell gets through, and the previous tabs keep themselves', () => {
  const start = nextPeers(
    states([8, user({ id: 'a', name: 'Ада' })], [9, user({ id: 'b', name: 'Боря' })]),
    7,
    [],
  )
  const moved = nextPeers(
    states(
      [8, user({ id: 'a', name: 'Ада' })],
      [9, user({ id: 'b', name: 'Боря', activeCellId: 'c4' })],
    ),
    7,
    start,
  )
  assert.notEqual(moved, start, 'the "editing a cell" label did not reach the screen')
  assert.equal(moved[0], start[0], 'the unchanged neighbour lost its identity')
  assert.equal(moved[1].user.activeCellId, 'c4')
})

test('someone leaving and someone arriving is a change', () => {
  const two = nextPeers(states([8, user({ id: 'a' })], [9, user({ id: 'b' })]), 7, [])
  const one = nextPeers(states([8, user({ id: 'a' })]), 7, two)
  assert.equal(one.length, 1)
  const three = nextPeers(
    states([8, user({ id: 'a' })], [9, user({ id: 'b' })], [10, user({ id: 'c' })]),
    7,
    one,
  )
  assert.equal(three.length, 3)
})

test('oneself first, the rest by name, regardless of frame order', () => {
  const self = 7
  const order = nextPeers(
    states(
      [8, user({ id: 'b', name: 'Яна' })],
      [self, user({ id: 'me', name: 'Ярослав' })],
      [9, user({ id: 'c', name: 'Ада' })],
    ),
    self,
    [],
  )
  assert.deepEqual(
    order.map((peer) => peer.user.name),
    ['Ярослав', 'Ада', 'Яна'],
  )
  assert.equal(order[0].isSelf, true)
})

test('reordering people is a change too: the list is drawn in this order', () => {
  const before = nextPeers(
    states([8, user({ id: 'a', name: 'Ада' })], [9, user({ id: 'b', name: 'Боря' })]),
    7,
    [],
  )
  // Ada renamed herself to Yana — the order must change.
  const after = nextPeers(
    states([8, user({ id: 'a', name: 'Яна' })], [9, user({ id: 'b', name: 'Боря' })]),
    7,
    before,
  )
  assert.notEqual(after, before)
  assert.deepEqual(
    after.map((peer) => peer.user.name),
    ['Боря', 'Яна'],
  )
})

test('a socket without an identity is a page still entering, not a person', () => {
  const list = nextPeers(
    new Map([
      [8, { user: undefined }],
      [9, { user: user({ id: '' }) }],
      [10, { user: user({ id: 'a' }) }],
    ]) as Map<number, { user?: unknown }>,
    7,
    [],
  )
  assert.equal(list.length, 1)
})

test('every field that is drawn counts as a change', () => {
  const base = user({ id: 'a' })
  const changes: Partial<AwarenessUser>[] = [
    { name: 'Боря' },
    { color: '#000000' },
    { avatar: 'data:image/png;base64,x' },
    { role: 'host' },
    { activeCellId: 'c1' },
    { editing: 'utils.py' },
    { composing: true },
    { inTerminal: true },
    { viewing: { file: 'lecture.pdf', page: 3, y: 0.2 } },
  ]
  for (const over of changes) {
    assert.equal(
      samePeerUser(base, { ...base, ...over }),
      false,
      `a change to ${Object.keys(over)[0]} would not reach the screen`,
    )
  }
  // And the position on the page is a field too: the same page, a different
  // fraction of the height.
  const at = user({ id: 'a', viewing: { file: 'lecture.pdf', page: 3, y: 0.2 } })
  assert.equal(
    samePeerUser(at, { ...at, viewing: { file: 'lecture.pdf', page: 3, y: 0.7 } }),
    false,
  )
  // A missing field and its empty value are the same thing: a neighbour's old
  // build does not send `composing` at all, and that is no reason to redraw
  // the room.
  assert.equal(samePeerUser(base, { ...base, composing: false, inTerminal: false }), true)
  assert.equal(samePeerUser(base, { ...base, viewing: null }), true)
})

test('the per-participant map merges the tabs of one person into one face', () => {
  const peers: Peer[] = [
    { clientId: 1, isSelf: false, user: user({ id: 'a', name: 'Ада' }) },
    { clientId: 2, isSelf: false, user: user({ id: 'a', name: 'Ада', activeCellId: 'c1' }) },
    { clientId: 3, isSelf: false, user: user({ id: 'b', name: 'Боря' }) },
  ]
  const byId = peersById(peers)
  assert.equal(byId.size, 2)
  assert.equal(byId.get('a')?.name, 'Ада')
  assert.equal(byId.get('b')?.name, 'Боря')
  assert.equal(byId.get('нет такого'), undefined)
})

test('the coalescing tick is a hundred milliseconds: not "on every keystroke" and not yet noticeable', () => {
  assert.ok(PRESENCE_TICK_MS >= 50, 'too often — there is almost no coalescing')
  assert.ok(PRESENCE_TICK_MS <= 200, 'the "editing here" label will start lagging noticeably')
})
