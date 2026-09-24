import { tr } from '@shared/i18n'
/**
 * Where a tree row dragged into a folder will land — and why sometimes
 * nowhere.
 *
 * Dragging inside the panel is the only way to move a file into a folder: a
 * slash in a name is rejected on purpose (shared/paths.ts), so "rename a.py
 * to src/a.py" is not an option. So all the moving rules converge here, and
 * the test comes here too: in a .svelte file there is nothing to check them
 * with.
 *
 * Why the decision is computed in the browser rather than left to the server:
 *
 * — The server rejects a folder moved into itself, but explains it by the
 *   target's NAME ("'deep' is not a valid name"), although the name is fine —
 *   the place is not. A refusal that explains the wrong thing is worse than a
 *   refusal without explanation.
 * — A move that takes a folder's contents beyond what is addressable — deeper
 *   than the eighth level or longer than four hundred characters — used to
 *   pass silently: the tree walk simply ends there, sets no "not shown in
 *   full" flag, and the subtree disappears from the panel as if it never
 *   existed. The server refuses in both cases, but the highlight promises the
 *   move before the request gets there — so it has to be computed here,
 *   BEFORE sending, and in the same words.
 * — Half of the gestures mean nothing: an entry dropped into its own folder
 *   goes nowhere, and saying so in words means scolding where the person
 *   simply missed with a finger. Hence three outcomes, not two.
 *
 * Refusal phrases use the same words the server would refuse with
 * (control.ts, `treeTrouble`): there is one check, and there must be one
 * explanation.
 *
 * The module is pure: no socket, no document. There are no roles or room
 * rules here either — `tree:move` on the server is teacher-only, and the tree
 * does not know about it; the permission is asked in the panel, before the
 * row is even allowed to be picked up.
 */
import type { FileEntry } from '@shared/protocol'
import {
  MAX_DEPTH,
  MAX_PATH,
  baseOf,
  isInside,
  joinPath,
  normalizePath,
  parentOf,
} from '@shared/paths'

/** A tree row as the move sees it: there is nothing else to know about it. */
export interface Row {
  path: string
  dir: boolean
}

/**
 * The folder the dropped item will land in. The root is the empty string.
 *
 * `null` — dropped past the rows, onto the empty part of the panel or its
 * header: that is the root, not a refusal.
 *
 * The rule "something dropped on a file lands in its folder, not on top of
 * it" lives here, one for everyone. It was already written in the markup — for
 * a file from disk — and a second copy of it sooner or later yields a panel
 * where the same gesture puts the room's own entries and files from outside
 * in different places.
 */
export function dropFolder(onto: Row | null): string {
  if (!onto) return ''
  return onto.dir ? onto.path : parentOf(onto.path)
}

/** The path the entry will end up at: the new folder plus the old name. */
export function landingPath(dragged: Row, onto: Row | null): string {
  return joinPath(dropFolder(onto), baseOf(dragged.path))
}

/** Number of segments in a path. The root has zero. */
function segments(path: string): number {
  return path === '' ? 0 : path.split('/').length
}

/**
 * Whether the server looks inside this folder.
 *
 * `listTree` reads directories while their contents fit into MAX_DEPTH
 * segments: a folder at the very bottom is in the list, but what is inside it
 * never is. And "not shown in full" says nothing about it: the flag is set
 * only by the number of rows. Without this question the panel declared such
 * a folder empty, although files do lie in it and take up space — the room
 * simply can no longer name them by a path, and only a cell can see them.
 */
export function readsInside(dir: string): boolean {
  return segments(dir) < MAX_DEPTH
}

/**
 * What moved together with the entry — as "before → after" pairs.
 *
 * A folder move stated by the folder's name alone says nothing about what is
 * inside it: tabs know the EXACT path, and an open `src/model.py` stayed on a
 * dead address until the next file list closed it as a tab for a vanished
 * file — together with its document, that is, with its undo history. The
 * server moves the contents honestly (`pathsInside` in control.ts), and the
 * panel must say the same.
 */
export function movedPaths(
  from: string,
  to: string,
  files: readonly FileEntry[],
): { from: string; to: string }[] {
  const out = [{ from, to }]
  for (const entry of files) {
    if (entry.path === from || !isInside(entry.path, from)) continue
    out.push({ from: entry.path, to: to + entry.path.slice(from.length) })
  }
  return out
}

/**
 * The depth of the deepest item being moved — already at the new place.
 *
 * Computed over the whole subtree, not the folder itself: a folder whose
 * contents already reach the eighth level does not fit one level lower, and
 * its own path says nothing about that. The server looks inside and will
 * refuse (`outgrows` in workspace.ts), but the highlight promises the move
 * before the gesture gets there. The file list here is the same one drawn in
 * the panel — if it is cut off by the cap, the deepest item may be missing
 * from it; that is no reason not to check what is there.
 */
export function deepestAfter(dragged: Row, into: string, files: readonly FileEntry[]): number {
  const to = joinPath(into, baseOf(dragged.path))
  let deepest = segments(to)
  if (!dragged.dir) return deepest
  for (const entry of files) {
    if (entry.path === dragged.path || !isInside(entry.path, dragged.path)) continue
    deepest = Math.max(deepest, segments(to + entry.path.slice(dragged.path.length)))
  }
  return deepest
}

/**
 * The longest path among the items being moved — already at the new place.
 *
 * The same argument as for `deepestAfter`, and the same hole: length is
 * measured only for the path that was sent — both by `normalizePath` on the
 * server and by the panel here. A folder with long names inside can be put
 * into a folder with a long name, and the contents go past MAX_PATH: they are
 * in the list, but there is no way left to open, download or remove them one
 * by one — `resolveInSession` does not let such a path through, and "Remove"
 * gets a complaint about a name that has nothing to do with it.
 */
export function longestAfter(dragged: Row, into: string, files: readonly FileEntry[]): number {
  const to = joinPath(into, baseOf(dragged.path))
  let longest = to.length
  if (!dragged.dir) return longest
  for (const entry of files) {
    if (entry.path === dragged.path || !isInside(entry.path, dragged.path)) continue
    longest = Math.max(longest, to.length + entry.path.length - dragged.path.length)
  }
  return longest
}

/**
 * The refusal over the path length of the contents — one phrase for both
 * sides.
 *
 * The server answers with the same one (`treeTrouble`, case `too-long`): there
 * is one check, and there must be one explanation. The culprit is not the
 * entry being moved — its path is short — but what lies inside, and the
 * phrase says exactly that.
 */
export function tooLong(from: string): string {
  return tr('room.ui.1177', { p0: baseOf(from), p1: MAX_PATH })
}

/**
 * What to do with the gesture.
 *
 * `nothing` — the gesture ended where it started: there is nothing to say,
 * and an error message would be untrue. `refuse` — the move looked real and
 * did not happen: staying silent is not an option, a released row after
 * which nothing happened reads as a breakage. A yes/no answer would merge
 * these two into one, and half of the gestures would get either needless
 * scolding or silence in place of a refusal.
 */
export type TreeMove =
  | { do: 'move'; from: string; to: string }
  | { do: 'nothing' }
  | { do: 'refuse'; why: string }

/**
 * The whole decision. The order of the checks here is load-bearing — see the
 * comments inside.
 *
 * The panel calls it twice: mid-drag, to highlight the target and show a
 * refusal with the cursor, and on release, to send. The same function on
 * purpose — a row that promises a move with the highlight and refuses on
 * release reads as a breakage.
 */
export function planMove(dragged: Row, onto: Row | null, files: readonly FileEntry[]): TreeMove {
  const from = dragged.path
  const into = dropFolder(onto)

  /*
   * The row was held while a new file list arrived, and what was being dragged
   * is no longer in the room. In the server's words: it would answer exactly
   * the same, only a round trip later.
   */
  if (!files.some((entry) => entry.path === from)) {
    return { do: 'refuse', get why() { return tr('room.ui.1178', { p0: baseOf(from) }) } }
  }

  // A folder dropped on its own row is a slip of the finger, not an error. It
  // comes BEFORE the check below: `isInside(dir, dir)` is true, and otherwise
  // a slip would be answered with a refusal.
  if (dragged.dir && into === from) return { do: 'nothing' }

  // A folder into itself. A drop onto a file inside it also ends up here:
  // `dropFolder` returns that file's folder, which is inside the one moving.
  if (dragged.dir && isInside(into, from)) {
    return { do: 'refuse', get why() { return tr('room.ui.1179', { p0: baseOf(from) }) } }
  }

  // A move to nowhere: the entry already lies in this folder. No message, no
  // words — otherwise every gesture that went nowhere means a network round
  // trip and a flicker of the list.
  if (into === parentOf(from)) return { do: 'nothing' }

  const to = joinPath(into, baseOf(from))

  /*
   * A taken name. `freeName` — the one that puts "data 2.csv" next to it — is
   * deliberately not used here: it is for the Oracle, which did not choose the
   * name. The person aimed at this folder themselves, and quietly swapping the
   * target on them is worse than refusing.
   *
   * The folder is called by its name, not by the word "this": for a move,
   * "this folder" points at the one being dragged FROM, while the clash
   * happened in the target — and a room can have several `data.csv` files of
   * the same name. The server answers in exactly the same words
   * (`treeTrouble`); there is no "in this folder" branch here, because a drop
   * into its own folder was handled above as "nothing happened".
   */
  if (files.some((entry) => entry.path === to)) {
    return {
      do: 'refuse',
      why: into
        ? tr('room.ui.1180', { p0: baseOf(to), p1: baseOf(into) })
        : tr('room.ui.1181', { p0: baseOf(to) }),
    }
  }

  // Depth is about the CONTENTS, not the entry itself: see `deepestAfter`.
  if (deepestAfter(dragged, into, files) > MAX_DEPTH) {
    return { do: 'refuse', get why() { return tr('room.ui.1182', { p0: MAX_DEPTH }) } }
  }
  if (normalizePath(to) === null) {
    return { do: 'refuse', get why() { return tr('room.ui.1183', { p0: baseOf(to), p1: MAX_PATH }) } }
  }
  // Length is about the CONTENTS too: see `longestAfter`. A separate phrase,
  // because the culprit is not the entry being dragged but the path to what
  // is inside it.
  if (longestAfter(dragged, into, files) > MAX_PATH) {
    return { do: 'refuse', why: tooLong(from) }
  }

  return { do: 'move', from, to }
}
