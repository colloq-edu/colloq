/**
 * Who is in the room, counted once each.
 *
 * Awareness is a list of *sockets*, not of people: a second tab, a reload whose
 * old connection has not timed out yet, a phone on the same link — each is its
 * own entry with its own client id. The room does not care about any of that.
 * It cares how many people are here and what each of them is doing.
 *
 * This exists because the two places that answer that question disagreed. The
 * People panel deduplicated by participant and the header's avatar row keyed on
 * the client id, so the same bar could read "4 in the room" beside a list of
 * three — the same person, twice, once with a cell badge and once without.
 *
 * Kept out of a `.svelte.ts` so it can be tested without a browser: what it
 * returns is a number people read off the screen and believe.
 */
import type { AwarenessUser } from '@shared/protocol'

export interface RoomPeer {
  clientId: number
  user: AwarenessUser
  isSelf: boolean
}

export interface Person {
  user: AwarenessUser
  isSelf: boolean
  /** Open tabs for this human; two tabs are still one person in the room. */
  tabs: number
}

export function peopleInRoom(peers: readonly RoomPeer[]): Person[] {
  const byId = new Map<string, Person>()
  for (const peer of peers) {
    // A socket with no identity yet is a page still joining, not a person.
    if (!peer.user?.id) continue
    const existing = byId.get(peer.user.id)
    if (!existing) {
      byId.set(peer.user.id, { user: peer.user, isSelf: peer.isSelf, tabs: 1 })
      continue
    }
    existing.tabs += 1
    existing.isSelf ||= peer.isSelf
    // Whichever tab is actually doing something is the one worth reporting.
    if (!existing.user.activeCellId && peer.user.activeCellId) existing.user = peer.user
  }
  return [...byId.values()]
}
