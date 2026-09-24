/**
 * What a tab announces to the room.
 *
 * Presence is the only wire over which a tab speaks about ITSELF, and both
 * decisions in web/src/lib/presence.ts are about it: whom it names and what it
 * claims about them. A mistake in the first is invisible — it costs the server
 * an extra half of the stream; a mistake in the second is visible to everyone
 * except the one it lies about.
 *
 * There is no provider here on purpose: `y-websocket` encodes and sends, but
 * this layer decides, and it has to be checked on a real `Awareness`, just
 * without a socket.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import { CELLS_KEY, createCell } from '../shared/notebook.js'
import { LECTURE_ROOM, OPEN_ROOM } from '../shared/rules.js'
import { permitsIn } from '../web/src/lib/may.js'
import { cellToAnnounce, ownChanges, type AwarenessChanges } from '../web/src/lib/presence.js'

/* -------------------------------------------------------------- echo */

/** The frames the tab would send to the server, with the same filter. */
function wiretap(awareness: Awareness, self: number): AwarenessChanges[] {
  const sent: AwarenessChanges[] = []
  awareness.on('update', (changes: AwarenessChanges) => {
    const own = ownChanges(changes, self)
    if (own) sent.push(own)
  })
  return sent
}

test('a tab announces only its own face to the server', () => {
  /*
   * `y-websocket` sends back every presence change it has applied — including
   * one that has just arrived from the server. The server rejects those
   * (`ownAwareness`, see room-gate), but it has to parse them to reject them:
   * at 500 tabs that was half of the whole presence stream.
   */
  const doc = new Y.Doc()
  const me = new Awareness(doc)
  const sent = wiretap(me, doc.clientID)

  me.setLocalStateField('user', { name: 'Я' })
  assert.deepEqual(
    sent,
    [{ added: [], updated: [doc.clientID], removed: [] }],
    'its own state did not reach the server',
  )

  const peer = new Awareness(new Y.Doc())
  peer.setLocalStateField('user', { name: 'Сосед' })
  applyAwarenessUpdate(me, encodeAwarenessUpdate(peer, [peer.clientID]), 'server')

  assert.equal(sent.length, 1, 'the state of a peer went back to the server')
  // And the peer is still in place: the filter sits on sending, not on receiving —
  // otherwise there would be neither a roster nor other people's cursors.
  assert.equal(me.getStates().has(peer.clientID), true, 'the peer did not reach the tab')

  // A peer leaving is not our news either: the server keeps its own count of the silent.
  removeAwarenessStates(me, [peer.clientID], 'server')
  assert.equal(sent.length, 1, 'the peer leaving went back to the server')
  assert.equal(me.getStates().has(peer.clientID), false, 'the peer did not leave the roster')

  // But its own leaving is announced: that is how a tab closes.
  removeAwarenessStates(me, [doc.clientID], 'tab closed')
  assert.deepEqual(sent.at(-1), { added: [], updated: [], removed: [doc.clientID] })

  peer.destroy()
  me.destroy()
})

test('a frame about itself and others at once leaves without the others', () => {
  // The provider folds added+updated+removed into one list, and the server
  // rejects such a mix WHOLESALE — together with our own state.
  const mine = 7
  assert.deepEqual(ownChanges({ added: [9], updated: [mine], removed: [3] }, mine), {
    added: [],
    updated: [mine],
    removed: [],
  })
  assert.equal(
    ownChanges({ added: [9], updated: [], removed: [3] }, mine),
    null,
    'a frame without a single face of its own would still have gone out',
  )
})

/* ---------------------------------------------- the "editing cell" badge */

function room(): { doc: Y.Doc; open: string; shut: string } {
  const doc = new Y.Doc()
  doc.transact(() => {
    const open = createCell('code', 'print(1)', 'c_open')
    doc.getArray(CELLS_KEY).push([open, createCell('code', 'print(2)', 'c_shut')])
    open.set('open', true)
  })
  return { doc, open: 'c_open', shut: 'c_shut' }
}

test('selecting a closed cell does not announce an edit', () => {
  /*
   * A student clicks a closed cell to read it or to ask about it — and the whole
   * room saw their "editing here" badge next to it. They cannot type there: the
   * badge was a lie.
   */
  const { doc, open, shut } = room()
  const student = permitsIn(LECTURE_ROOM, 'participant', false)
  assert.equal(cellToAnnounce(doc, shut, student), null)
  assert.equal(cellToAnnounce(doc, open, student), open, 'the person really is editing the open cell')
  doc.destroy()
})

test('the lock does not take the badge from the teacher: the teacher types everywhere', () => {
  const { doc, shut } = room()
  assert.equal(cellToAnnounce(doc, shut, permitsIn(LECTURE_ROOM, 'host', false)), shut)
  doc.destroy()
})

test('in an open lab the badge sits on any cell', () => {
  // There is no lock there at all, and nothing to ask: the room types everywhere.
  const { doc, shut } = room()
  assert.equal(cellToAnnounce(doc, shut, permitsIn(OPEN_ROOM, 'participant', false)), shut)
  doc.destroy()
})

test('after the bell nobody edits, and the badge goes out together with the right', () => {
  const { doc, open } = room()
  assert.equal(cellToAnnounce(doc, open, permitsIn(LECTURE_ROOM, 'participant', true)), null)
  assert.equal(cellToAnnounce(doc, open, permitsIn(OPEN_ROOM, 'participant', true)), null)
  doc.destroy()
})

test('a cell that does not exist is not in presence either', () => {
  // It may have been deleted right under the person's cursor: pointing the room
  // at an empty spot is just as much a lie, only of another kind.
  const { doc } = room()
  const student = permitsIn(OPEN_ROOM, 'participant', false)
  assert.equal(cellToAnnounce(doc, 'c_ушла', student), null)
  assert.equal(cellToAnnounce(doc, null, student), null)
  doc.destroy()
})
