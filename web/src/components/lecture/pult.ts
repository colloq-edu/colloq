import { tr } from '@shared/i18n'
/**
 * Rules the three lecture screens must agree on in advance.
 *
 * The projection, the console and the presenter's column are built from the
 * same components for exactly one reason: once they drift apart, they show
 * the presenter one thing and the audience another, and nobody can notice it
 * anywhere but in the lecture hall. Everything here has already drifted apart
 * at least once, and it lives here so that it cannot again:
 *
 *  • the PALETTE was written twice, and the copies disagreed: the console
 *    explained with measured numbers why there is no blue pen in the set and
 *    still kept blue as the default, while the bar on the laptop had it as
 *    the second of four circles;
 *  • the STOPWATCH was copied word for word into the console and into the
 *    notes header, with the remark "same as in the instrument", that is, with
 *    a promise nothing kept;
 *  • only the server knew the INK CEILINGS, and a refusal at the 601st stroke
 *    looked on the tablet like a lost frame;
 *  • the COUNT OF BLANK SHEETS lived in the tab's memory, and reloading the
 *    console mid-class lost the inked sheets from the page strip.
 *
 * There is not a single rune and not a single network call here: this is
 * arithmetic and agreements that can be checked without a browser.
 */
import { MAX_INKED_PAGES, MAX_STROKES_PER_PAGE, type InkFull } from '@shared/lecture'

/* ------------------------------------------------------------- palette */

/**
 * FOUR PEN COLOURS, AND BLUE IS NOT ONE OF THEM.
 *
 * Both reasons are measurable. On a projector with ~300:1 in-room contrast,
 * blue #0f2d69 and black #101a33 both fall into the bottom 8 % of the scale
 * and cannot be told apart from the eighth row, so choosing between them
 * changes nothing for the people the choice is made for. And on the console's
 * night-mode body the #0f2d69 disc gives 1.5:1: the key shows a dab that
 * cannot be seen at all.
 *
 * Orange stands where blue stood: it reads on a white slide and on a dark
 * full-sheet picture, and it is distinct from red — red is for underlining,
 * orange for marking.
 *
 * THE NAMES ARE A CONTRACT WITH THE INTERFACE CHECK, do not change them. There
 * are two kinds, and that is not carelessness: `name` is the control's full
 * name ("Pen, black"), `short` is the adjective the laptop bar puts into its
 * own title.
 */
export interface Ink {
  color: string
  /** The control's full name, as the console rail and the UI check call it. */
  name: string
  /** The adjective for the laptop bar: it builds "Pen, red" by itself. */
  short: string
}

export const INKS: readonly Ink[] = [
  { color: '#101a33', get name() { return tr('room.ui.320') }, get short() { return tr('room.ui.321') } },
  { color: '#d4162f', get name() { return tr('room.ui.322') }, get short() { return tr('room.ui.323') } },
  { color: '#0c7a64', get name() { return tr('room.ui.324') }, get short() { return tr('room.ui.325') } },
  { color: '#9b5a08', get name() { return tr('room.ui.326') }, get short() { return tr('room.ui.327') } },
]

/* -------------------------------------------------------------- clock */

/**
 * The lecture stopwatch, AND AFTER AN HOUR IT DROPS THE SECONDS: "1:02", not
 * "1:02:15". After an hour the seconds mean nothing: the question at that
 * point is "how much is left", not "how much has passed".
 */
export function stopwatch(ms: number): string {
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const mm = String(Math.floor(total / 60) % 60).padStart(2, '0')
  if (hours > 0) return `${hours}:${mm}`
  return `${mm}:${String(total % 60).padStart(2, '0')}`
}

/* ------------------------------------------------------------ sheets */

/** What ink is measured by from outside: page and id; nothing else is needed. */
export interface InkMark {
  id: string
  page: number
}

/**
 * How many blank sheets have been started, from the numbers of inked pages.
 *
 * Only the console kept the sheet count, in the tab's memory, and iPad Safari
 * unloads background tabs regularly. After a reload mid-class `boards` reset
 * to zero: inked sheets vanished from the page strip, the arrows could not
 * reach them, and "Sheet" opened an OLD sheet with ink on it under the label
 * "new". The ink itself never went anywhere (it sits in the server's memory),
 * so a sheet that was started is recognised by its ink.
 *
 * Returns the number of the LATEST sheet with ink: sheets are numbered
 * consecutively from −1, and sheet number N proves that every sheet before it
 * was started too.
 *
 * Counts by page NUMBERS, not by strokes, and this is not a detail of the
 * signature: the welcome batch no longer has to carry all of the lecture's
 * writing, and a tab holding the ink of one page knows exactly as much about
 * sheets as one holding all of it, from the inventory (ink.ts · `inkedPages`).
 */
export function boardsInked(pages: Iterable<number>): number {
  let deepest = 0
  for (const page of pages) {
    if (page < 0 && -page > deepest) deepest = -page
  }
  return deepest
}

/* ---------------------------------------------------------- ceilings */

/**
 * Why the next stroke will not start. `null` means it will.
 *
 * This is a NARROWING of `InkFull` from shared, not a pair of strings of our
 * own next to it. The third ceiling there ("the stroke ran out of points") is
 * not counted by the console: it is about a stroke already under way, and the
 * server names it. `Extract` on purpose, not retyped literals: a refusal
 * renamed in shared must break the build here rather than drift apart
 * silently.
 */
export type InkRefusal = Extract<InkFull, 'page-full' | 'too-many-pages'>

/**
 * Whether there is still room for a stroke on this page.
 *
 * At the 601st stroke (and at the 201st inked page) the server simply returns
 * `null` and sends nothing. The ink layer could not tell that from a lost
 * frame: it resent the stroke WHOLE eight times and removed it from the sheet
 * four seconds later, without a line of explanation, while the audience never
 * had the line at all. Counting the same thing here is cheaper than guessing:
 * we hold all of the room's ink anyway.
 *
 * `mine` is our own strokes the server has not confirmed yet: without them
 * the last few strokes on a full page would be miscounted twice over, in the
 * wrong direction.
 */
export function inkRefusal(
  known: readonly InkMark[],
  mine: readonly InkMark[],
  page: number,
): InkRefusal | null {
  const seen = new Set<string>()
  const pages = new Set<number>()
  let onPage = 0
  // Two passes rather than one over a concatenated array: a lecture's ink can
  // run to nearly a hundred thousand strokes, and the extra copy would be made
  // on EVERY touch of the pen.
  for (const list of [known, mine]) {
    for (const stroke of list) {
      if (seen.has(stroke.id)) continue
      seen.add(stroke.id)
      pages.add(stroke.page)
      if (stroke.page === page) onPage += 1
    }
  }
  if (onPage >= MAX_STROKES_PER_PAGE) return 'page-full'
  if (!pages.has(page) && pages.size >= MAX_INKED_PAGES) return 'too-many-pages'
  return null
}

/*
 * THE REFUSAL WORDS ARE NOT HERE — they are in `@shared/lecture` ·
 * `inkFullSays`, and the ink layer calls them from there.
 *
 * A pair of strings of our own used to stand here and matched the server's
 * word for word, until the first edit of the wording. And wording gets edited
 * precisely because a phrase is poor, and a person edits whichever copy they
 * found: after that the same refusal speaks in two voices on the console,
 * depending on who noticed it first — the console itself before the stroke,
 * or the server after a reconnect.
 */
