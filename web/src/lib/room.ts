import { tr } from '@shared/i18n'
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
import { plural } from './plural'

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

/* -------------------------------------------------- where the person is now */

/**
 * A place in the room one can be taken to.
 *
 * `file` appeared together with go-to-definition and differs from the rest:
 * it is not "show the panel" but "open a tab". It deliberately has no line —
 * where to look inside the file is remembered by lib/goto.svelte.ts, and
 * remembered as STATE: the file editor is not built in the same frame the tab
 * opens in, and a number sent in an event would no longer exist by the time
 * it is built.
 */
export type RevealTarget =
  | { where: 'cell'; cellId: string }
  | { where: 'file'; path: string }
  | { where: 'terminal' }
  | { where: 'oracle' }

/** What is visible about a person: a phrase for the row and the place it leads to. */
export interface Whereabouts {
  /** One sentence, or null — there is nothing to say about this person. */
  line: string | null
  /** Where a press takes you, or null — there is nowhere to go. */
  place: RevealTarget | null
}

/** The room state that "who is where" is computed from. */
export interface RoomView {
  /**
   * The number of each cell — the same one drawn in its left gutter.
   *
   * A map, not a list in document order: a room has several notebooks, each
   * with its own count, and "cell 04" must mean that very fourth one the
   * person sees — whichever notebook it lies in. It also shows that the cell
   * still exists.
   */
  numbers: ReadonlyMap<string, number>
  runningCellId: string | null
  /** The display name of whoever pressed Run. */
  runBy: string | null
}

/** Cell numbers read the same as in the gutter at the edge: 01, 02, 03. */
function cellNumber(view: RoomView, id: string | null | undefined): string | null {
  if (!id) return null
  const number = view.numbers.get(id)
  return number === undefined ? null : String(number).padStart(2, '0')
}

/**
 * One phrase about a person and one place it leads to.
 *
 * Computed together on purpose. These used to be two identical ladders of
 * conditions — one assembled the sentence, the other chose the place — and it
 * was enough for them to diverge in one step: the row would say "editing cell
 * 04" and lead to the terminal. A row that lies about where it leads is worse
 * than a row that leads nowhere.
 *
 * The order follows what overrides what. A run matters more than the cursor's
 * position: while a cell is computing, the person is busy with exactly that
 * cell. "N tabs" is worth saying only when nothing is happening in any of
 * them, and there is, of course, nowhere to lead to.
 *
 * The phrases are in Russian because they are drawn as the person's second
 * line in the panel — next to "Teacher · you" and the hint "To Nina in the
 * terminal". The panel is translated in full, and a single English line in
 * the middle of it reads as a foreign patch rather than a choice.
 */
export function whereabouts(person: Person, view: RoomView): Whereabouts {
  const runningNo = cellNumber(view, view.runningCellId)
  /*
   * Both the one who pressed Run and the one standing in the cell while it
   * computes are equally honestly running it. runBy is a display name, so two
   * students with the same name would both claim the run; usually the cursor
   * settles it, and a wrong guess here costs a word, not state.
   */
  const runs =
    runningNo !== null &&
    (view.runBy === person.user.name || person.user.activeCellId === view.runningCellId)
  if (runs && view.runningCellId) {
    return {
      get line() { return tr('room.ui.1112', { p0: runningNo }) },
      place: { where: 'cell', cellId: view.runningCellId },
    }
  }

  if (person.user.inTerminal) return { get line() { return tr('room.ui.1113') }, place: { where: 'terminal' } }
  if (person.user.composing) return { get line() { return tr('room.ui.1114') }, place: { where: 'oracle' } }

  const at = person.user.activeCellId
  const atNo = cellNumber(view, at)
  // The cell may have been deleted since the person stood in it: leading to
  // what does not exist is worse than leading nowhere — and there is nothing to
  // say about it either.
  if (at && atNo) return { get line() { return tr('room.ui.1115', { p0: atNo }) }, place: { where: 'cell', cellId: at } }

  if (person.tabs > 1) {
    const word = plural(person.tabs, tr('room.ui.1116'), tr('room.ui.1117'), tr('room.ui.1118'))
    return { line: `${person.tabs} ${word}`, place: null }
  }
  return { line: null, place: null }
}
