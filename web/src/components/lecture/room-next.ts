/**
 * "NEXT" ON THE ROOM'S SCREENS: the thumbnail in the presenter's column, the
 * line in the header of the notes under the slide, and the captions of a
 * student who presents and of a teacher watching.
 *
 * WHY THIS EXISTS. They used to say "the page after this one", page + 1,
 * while the bar's ›, Space and the clicker walk the lecture's order
 * (walk.ts · `walkStep`), sheets in place. On slide 14 with a sheet after it
 * the column showed slide 15, the notes header said "NEXT 15" and a teacher
 * watching read "next 15 · Title", and the arrow right beside them put the
 * blank sheet on the projector. On the sheet the room said nothing at all,
 * while the arrow went on to 15. The console's footer already named the
 * item the arrow really goes to (ConsoleView · `nextTo`), so the teacher's
 * two screens disagreed about what comes next. Now "next" is that item,
 * worked out by the same walk.
 *
 * Pure logic and words, no runes: tests/lecture-room-next.test.mts walks it.
 */
import { tr } from '@shared/i18n'
import { itemMark } from './film'
import { sheetPlace, walkStep } from './walk'

/** What comes after the page on screen, as the room names it. */
export interface RoomNext {
  /** The page the arrow goes to: a slide's number, or a sheet's (negative) page. */
  page: number
  /** A sheet's place among the lecture's sheets, for "sheet 1 of 2"; `null` for a slide. */
  sheet: { n: number; total: number } | null
}

/**
 * Where ›, Space and the clicker go from `from` (the page on screen), as
 * something to name, or `null` where nothing comes.
 *
 * `sequence` and `length` are the bar's own (lectureSequence over
 * walk.ts · `walkLength`), so the words can never name another page than the
 * arrow next to them goes to. One thing is held back that the arrow would
 * still do: a slide of a deck this screen has not opened (`pages` 0). The
 * walk lets the arrow go one past the furthest slide anybody has seen, and
 * that slide may not exist; a thumbnail and a number for it would be a
 * promise the deck does not keep, so nothing is said until the deck is open.
 */
export function roomNext(
  sequence: readonly number[],
  length: number,
  pages: number,
  from: number,
  lastSlide: number,
): RoomNext | null {
  const to = walkStep(sequence, length, from, 1, lastSlide)
  if (to === null) return null
  if (to < 0) {
    // The walk only ever steps onto a sheet the list has, so it has a place.
    const sheet = sheetPlace(sequence, to)
    return sheet === null ? null : { page: to, sheet }
  }
  return pages > 0 && to <= pages ? { page: to, sheet: null } : null
}

/**
 * The mark written in mono after "NEXT": "15" for a slide, "Л1" for a sheet,
 * the mark the console's strip and ribbon carry (film.ts · `itemMark`). A
 * sheet goes by its place among the sheets, never by its page number: the
 * server hands numbers out and never reuses them, so the second sheet of a
 * lecture with deletions may well be page −7.
 */
export function nextMarkOf(next: RoomNext): string {
  return next.sheet ? itemMark({ kind: 'sheet', n: next.sheet.n }) : String(next.page)
}

/**
 * What follows the mark: the slide's title (read from the PDF, empty until
 * it is), or, since a blank sheet has no title to read, the sheet's place in
 * words, "лист 1 из 2", the reading of the bar's counter on that sheet.
 */
export function nextWordsOf(next: RoomNext, title: string): string {
  return next.sheet ? tr('room.lecture4.sheetOf', { n: next.sheet.n, total: next.sheet.total }) : title
}
