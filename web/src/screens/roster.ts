import { tr } from '@shared/i18n'
/**
 * The faces in the status bar — and how not to rebuild them on every other
 * person's cursor.
 *
 * `yCollab` announces the cursor position through presence on every
 * selection move: with a hundred people typing that is hundreds of presence
 * frames a second, and each of them woke the room's whole people bookkeeping
 * — a new array of 500 objects, joining 500 names into `title`, redrawing
 * the avatar stack. None of that changes because of a cursor: the bar draws
 * the NAME, the MARK and the COLOR, and those do not change at all during a
 * class.
 *
 * Hence two pure pieces here: an "are we drawing the same thing" comparison
 * without a single allocation (it is enough to return THE SAME array and
 * stop everything downstream) and a names line with a cap — nobody reads
 * 500 names in a `title`, yet they had to be joined on every frame.
 *
 * The real fix is upstream, in presence coalescing (see the handoff on
 * `#readPeers`); this is what can be done from the screen's side, and it
 * removes everything that happens AFTER a frame arrives.
 */

/** A person as the status bar draws them. */
export interface Face {
  id: string
  name: string
  avatar: string | null
  color: string
  /** The hover caption: the name, plus "(you)" if it is you. */
  title: string
}

/** The little from presence that a face in the bar depends on. */
export interface Someone {
  user: { id: string; name: string; avatar: string | null; color: string }
  isSelf: boolean
}

export function faceOf(person: Someone): Face {
  return {
    id: person.user.id,
    name: person.user.name,
    avatar: person.user.avatar,
    color: person.user.color,
    get title() { return person.isSelf ? tr('room.person.self', { name: person.user.name }) : person.user.name },
  }
}

/**
 * Whether we are drawing the same thing as last time.
 *
 * Not a single allocation: four primitives per person are compared rather
 * than a string key built. The order matters, and that is right — the list
 * arrives sorted, and swapping two names in the stack is visible.
 */
export function sameFaces(prev: readonly Face[], people: readonly Someone[]): boolean {
  if (prev.length !== people.length) return false
  for (let i = 0; i < people.length; i++) {
    const was = prev[i]
    const now = people[i]
    if (
      was.id !== now.user.id ||
      was.name !== now.user.name ||
      was.avatar !== now.user.avatar ||
      was.color !== now.user.color ||
      // "(you)" in the caption is also something visible.
      was.title !== (now.isSelf ? tr('room.person.self', { name: now.user.name }) : now.user.name)
    ) {
      return false
    }
  }
  return true
}

/**
 * Names on hover — with a cap.
 *
 * A tooltip of five hundred names is unreadable and does not fit: the
 * browser truncates it itself, but the string still has to be joined. Twenty
 * names is already more than anyone manages to read, and the tail is given
 * as a number.
 */
export function namesLine(faces: readonly Face[], cap = 20): string {
  if (faces.length <= cap) return faces.map((face) => face.title).join(', ')
  const shown = faces.slice(0, cap).map((face) => face.title)
  return tr('room.people.more', { names: shown.join(', '), count: faces.length - cap })
}
