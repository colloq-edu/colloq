/**
 * What this tab announces to the room.
 *
 * Presence is the chattiest wire in the product, and lying over it is the
 * cheapest of all: a frame goes out on every keystroke, and everyone reads it.
 * Hence two decisions that have nowhere else to be made once.
 *
 * The first is about WHOM the tab speaks of. Of itself, and only of itself: it
 * tells the server its own state and receives other people's from the server.
 *
 * The second is about WHAT it says. The "editing this cell" mark is a
 * statement about a person, and if they cannot type there, the statement is
 * false.
 */
import type * as Y from 'yjs'
import { findCell, isCellOpen } from '@shared/notebook'
import { mayEditThisCell, type Permits } from './may'

/** A presence frame as y-protocols describes it: three lists of clientIDs. */
export interface AwarenessChanges {
  added: number[]
  updated: number[]
  removed: number[]
}

/**
 * Keep only ONE'S OWN clientID in the frame — or null if one's own is not in
 * it.
 *
 * `y-websocket` sends the server every changed clientID in a row, including
 * others' just received from it: applying someone else's state is a presence
 * change too, and the provider's handler does not look at where it came from.
 * The frame goes back through the same socket it arrived on.
 *
 * The server rejects such an echo — `ownAwareness` in
 * server/src/collab/index.ts knows whom each socket brought — but to reject
 * it, it has to parse it. On a test bench with 500 tabs the echo made up half
 * of sixteen thousand presence frames per second: work that should not have
 * existed on either side.
 *
 * null, not an empty frame: "nothing to say" and "saying that nothing has
 * changed" are different messages, and the second costs as much as the first.
 */
export function ownChanges(changes: AwarenessChanges, self: number): AwarenessChanges | null {
  const mine = (clients: number[]): number[] => clients.filter((id) => id === self)
  const added = mine(changes.added)
  const updated = mine(changes.updated)
  const removed = mine(changes.removed)
  if (added.length === 0 && updated.length === 0 && removed.length === 0) return null
  return { added, updated, removed }
}

/**
 * The cell about which the room can honestly be told "they are editing it" —
 * or null.
 *
 * Selecting and editing stopped being the same thing the day the lock
 * appeared: a student clicks a closed cell to read it or ask about it — and
 * for the whole room their "editing here" mark appeared next to it. They
 * cannot type there, and the mark was untrue.
 *
 * The selection stays, though: it is about where the person is looking, and
 * it lives in their browser. Only what they are entitled to do goes into
 * presence, and it is asked of the same `mayEditCell` the server answers with.
 */
export function cellToAnnounce(doc: Y.Doc, id: string | null, may: Permits): string | null {
  if (!id) return null
  const found = findCell(doc, id)
  // The cell may have been deleted right under our cursor: pointing at what
  // does not exist is the same untruth, only of another kind.
  if (!found) return null
  return mayEditThisCell(may, isCellOpen(found.cell)) ? id : null
}
