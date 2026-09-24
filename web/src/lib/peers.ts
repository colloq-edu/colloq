/**
 * Who is in the room — as a snapshot that changes only when what is drawn
 * changes.
 *
 * Presence is the chattiest wire in the product: y-codemirror publishes the
 * cursor on every keystroke, the server broadcasts it to everyone, and with
 * five hundred tabs frames arrive by the hundreds per second. Each such frame
 * used to build five hundred new objects, sort them with `localeCompare` and
 * put a NEW array into `session.peers` — after which all its readers woke up:
 * the counter in the header, the people panel, the oracle avatars and the "who
 * ran it" lookup in every mounted cell. Forty cells with five hundred people
 * is twenty thousand comparisons for one other person's cursor.
 *
 * The same rule applies here as in the yreactive header: **a snapshot is
 * passed on only if it differs from the previous one, and unchanged pieces
 * keep their identity**. A cursor moving within the same cell changes nothing
 * of what the room draws — and must not reach anyone.
 *
 * No runes and no Yjs, so that the rule can be checked without a browser: it
 * draws a number that a person reads off the screen and trusts.
 */
import type { AwarenessUser } from '@shared/protocol'

/** One tab in the room: whose it is and whether it is ours. */
export interface Peer {
  clientId: number
  user: AwarenessUser
  isSelf: boolean
}

/**
 * How often the list of people is rebuilt, milliseconds.
 *
 * A hundred milliseconds is still "at once" for the "editing cell 04" mark and
 * no longer "on every keystroke": a hundred typists produce hundreds of frames
 * per second, while the recount runs ten times. Exactly the same tick sits on
 * the cell index (yreactive · PeerIndex), so that both lists of people on
 * screen update at the same moment, not one after the other.
 */
export const PRESENCE_TICK_MS = 100

/**
 * The order of names — with one comparator for the whole app.
 *
 * `String.prototype.localeCompare` sets up comparison rules on EVERY call, and
 * there are N·logN of them here: five hundred people is about four and a half
 * thousand comparisons per rebuild. A single `Intl.Collator` gives the same
 * order several times cheaper.
 */
const byName = new Intl.Collator()

function sameViewing(a: AwarenessUser['viewing'], b: AwarenessUser['viewing']): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null)
  return a.file === b.file && a.page === b.page && a.y === b.y
}

/**
 * Whether this is the same person in the same state — by what is DRAWN.
 *
 * The presence state is decoded anew on every frame, so object identity says
 * nothing: the fields have to be compared. All of them are listed here by
 * name, and on purpose — a new field that is drawn must get into the list,
 * otherwise it will quietly stop reaching the screen.
 */
export function samePeerUser(a: AwarenessUser, b: AwarenessUser): boolean {
  if (a === b) return true
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.color === b.color &&
    a.avatar === b.avatar &&
    a.role === b.role &&
    (a.activeCellId ?? null) === (b.activeCellId ?? null) &&
    (a.editing ?? null) === (b.editing ?? null) &&
    (a.composing ?? false) === (b.composing ?? false) &&
    (a.inTerminal ?? false) === (b.inTerminal ?? false) &&
    sameViewing(a.viewing, b.viewing)
  )
}

/**
 * Build the list of people from presence states — or return the previous one.
 *
 * THE SAME previous array IS RETURNED when nothing drawn has changed:
 * assigning the same value to a rune wakes no `$derived`, while a new array
 * with the same contents wakes all of them. Separately, the identity of every
 * unchanged tab is kept — for `{#each}` by clientId and for those who build
 * derived lists per person.
 *
 * Oneself first, the rest by name: both the header and the people panel read
 * this order, and it must not depend on the order the frames arrived in.
 */
export function nextPeers(
  states: Iterable<readonly [number, { user?: unknown } | undefined]>,
  self: number,
  previous: readonly Peer[],
): readonly Peer[] {
  const next: Peer[] = []
  for (const [clientId, state] of states) {
    const user = state?.user as AwarenessUser | undefined
    // A socket without an identity is a page still entering, not a person.
    if (!user?.id) continue
    next.push({ clientId, user, isSelf: clientId === self })
  }
  next.sort(
    (a, b) => Number(b.isSelf) - Number(a.isSelf) || byName.compare(a.user.name, b.user.name),
  )

  const kept = new Map<number, Peer>()
  for (const peer of previous) kept.set(peer.clientId, peer)
  let same = next.length === previous.length
  for (let i = 0; i < next.length; i++) {
    const was = kept.get(next[i].clientId)
    if (was && was.isSelf === next[i].isSelf && samePeerUser(was.user, next[i].user)) next[i] = was
    // A reordering is a change too: the list is drawn in this order.
    if (same && previous[i] !== next[i]) same = false
  }
  return same ? previous : next
}

/**
 * People by participant, not by tab: `runById` → whose face it is.
 *
 * A map, not a search: EVERY cell with output asks "who ran it", and with two
 * hundred cells and five hundred tabs a linear search is a hundred thousand
 * comparisons per presence frame. The key is the participant id: names in a
 * room are not unique, two Annas are two people.
 *
 * A person's first tab wins: the name, colour and face are the same across
 * all their tabs, and nothing else is read from here.
 */
export function peersById(peers: readonly Peer[]): ReadonlyMap<string, AwarenessUser> {
  const byId = new Map<string, AwarenessUser>()
  for (const peer of peers) if (!byId.has(peer.user.id)) byId.set(peer.user.id, peer.user)
  return byId
}
