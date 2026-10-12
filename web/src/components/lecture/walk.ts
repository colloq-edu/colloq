/**
 * Walking the lecture from a screen in the room: the laptop bar's arrows and
 * the words "sheet 2 of 3".
 *
 * The order is the console's (shared/lecture.ts · `lectureSequence`,
 * `stepIn`): slides with their sheets in place, so "next" means the same on
 * the tablet, on the laptop and on the clicker at the projector. They used
 * to disagree: forward from any sheet took the laptop back to the slides
 * while the console went on to the next sheet, and the same press moved the
 * hall to two different places depending on which hand made it.
 *
 * On top of the shared order, two things only a screen in the room meets:
 * a deck it has not opened (its length unknown), and a sheet the list does
 * not know (deleted a moment ago, or an older server that keeps no list).
 * The laptop bar does not create sheets: it walks the ones there are.
 *
 * And one thing only the console meets: it turns its own sheet at once and
 * tells the server after, so it has to tell the echoes of its own turns from
 * someone else's (`askTurn`, `hearTurn`), across a dropped connection too
 * (`hearWelcome`).
 *
 * Pure logic, no runes: tests/lecture-hall-zoom.test.mts and
 * tests/lecture-console-converge.test.mts walk it.
 */
import { MAX_SLIDES, sheetNumber, stepIn, type LectureSheet } from '@shared/lecture'

/**
 * The deck's length to walk by.
 *
 * The real one once this screen's copy of the document has opened. Until
 * then, or when it failed to open and the lecture is carried through with
 * the bar and the notes, one past the furthest slide anything here knows
 * of: the page on screen, the slide last seen, the slides sheets stand
 * after. A held arrow must not drive the hall past the end of a deck nobody
 * here has seen (the server accepts any page up to `MAX_SLIDES`, and getting
 * back took sixty presses), and a slide a sheet stands after exists. Never
 * past `MAX_SLIDES` either: the walk is built slide by slide.
 */
export function walkLength(
  pages: number,
  sheets: readonly LectureSheet[] | null | undefined,
  onScreen: number,
  lastSlide: number,
): number {
  if (pages > 0) return pages
  let known = Math.max(1, onScreen, lastSlide)
  for (const sheet of sheets ?? []) {
    if (Number.isFinite(sheet.after)) known = Math.max(known, Math.floor(sheet.after))
  }
  return Math.min(MAX_SLIDES, known + 1)
}

/**
 * Where an arrow goes from `from` along `sequence` (built for `length`
 * slides), or `null` at an end.
 *
 * A sheet that is not in the sequence goes back to `lastSlide`, the slide
 * the hall last saw, either way: stepping from a place that is not on the
 * map has no "next", and the slides are where the lecture is. A slide past
 * the end of the deck (the server stands on one after the document was
 * replaced by a shorter one) goes back to the last slide and no further.
 */
export function walkStep(
  sequence: readonly number[],
  length: number,
  from: number,
  dir: 1 | -1,
  lastSlide: number,
): number | null {
  if (from < 0 && !sequence.includes(from)) return lastSlide
  const next = stepIn(sequence, from, dir)
  if (next === null || next < 0) return next
  if (next > length) return dir < 0 ? length : null
  return next
}

/**
 * The sheet's number among the lecture's sheets and how many there are, for
 * "sheet 2 of 3"; `null` on a slide, or on a sheet the list does not know
 * (the bare word "blank sheet" says the rest).
 */
export function sheetPlace(sequence: readonly number[], page: number): { n: number; total: number } | null {
  const n = sheetNumber(sequence, page)
  if (n === 0) return null
  let total = 0
  for (const at of sequence) if (at < 0) total += 1
  return { n, total }
}

/**
 * Where a turn to `next` lands on a deck walked as `length` slides long
 * (`walkLength`): a sheet as it is (the server holds it against its list),
 * a slide inside the deck, never past its end and never at 0 or below.
 *
 * The console used to bound a slide by the page the hall stood on, plus one,
 * whenever its own copy of the deck had not opened. On a sheet that page is
 * negative: Next and Back from "Л1" asked the server for page 0, which it
 * ignores, and from the third sheet on they asked for the sheet numbered one
 * higher, which it turned the projector to. The walk's own length is that
 * bound done right: one past the furthest slide anything here has seen.
 */
export function turnTarget(next: number, length: number): number {
  if (next < 0) return next
  return Math.min(Math.max(1, next), Math.max(1, length))
}

/* ---------------------------------------------- the console's own turns */

/** A turn the console asked the server for, and when the request last went out. */
export interface AskedTurn {
  page: number
  at: number
}

/**
 * How long a request is waited for: a little past the console's repeats
 * (one every 600 ms, five of them, then it gives up and follows the hall).
 * A request older than this was lost, and must not pass a later move of
 * someone else's to the same page off as its echo.
 */
export const ASKED_FOR_MS = 4000

/**
 * A request for `page` went out at `now`: the list of turns still waited
 * for, in the order they were asked.
 *
 * A repeat of the last request (the console resends its page every 600 ms
 * while the hall lags) is the same turn asked again, not another one: of the
 * two, only the first to reach the server moves it, and only that one is
 * echoed. So it refreshes the last entry instead of adding one that no echo
 * would ever take away.
 */
export function askTurn(asked: readonly AskedTurn[], page: number, now: number): AskedTurn[] {
  const last = asked[asked.length - 1]
  if (last && last.page === page) return [...asked.slice(0, -1), { page, at: now }]
  return [...asked, { page, at: now }]
}

/**
 * The server's page CHANGED to `page`: whether that is the echo of a turn
 * this console asked for, and the turns still on their way after it.
 *
 * The server takes the requests in the order they were sent and answers only
 * those that move it, so the echo of `page` settles every request up to and
 * including the first one for `page`: anything asked before it was either
 * answered already or never moved the hall. "Next, Next, Back" asks for 7, 8
 * and 7 again, and the echoes 7, 8, 7 then take the list down one at a time,
 * all three the console's own. An unordered set could not do that: the first
 * echo of 7 emptied it, and the 8 behind it read as someone else's move,
 * the console jumped to 8 and back after the hand had stopped.
 *
 * A change to a page no request names is someone else's move (the laptop
 * bar, the clicker, or the server itself turning the hall to a new sheet),
 * and then nothing is waited for any more: the hall has moved past our
 * requests. Requests older than `ASKED_FOR_MS` are dropped first.
 */
export function hearTurn(
  asked: readonly AskedTurn[],
  page: number,
  now: number,
): { ours: boolean; left: AskedTurn[] } {
  const fresh = asked.filter((turn) => now - turn.at <= ASKED_FOR_MS)
  const hit = fresh.findIndex((turn) => turn.page === page)
  if (hit < 0) return { ours: false, left: [] }
  return { ours: true, left: fresh.slice(hit + 1) }
}

/**
 * The first `lecture` frame after the control socket reopened at `reopened`
 * (the welcome) shows `page` (`null`: no lecture): whether that is a turn
 * this console asked for, and the turns still waited for.
 *
 * NOTHING ASKED BEFORE THE DROP WILL EVER BE ECHOED: whatever the server did
 * with it, its answer went down the dead socket. So the welcome settles all of
 * it at once, and by what was asked, not by when. The time offline is not
 * time a request was waited for (`ASKED_FOR_MS`), and counted as such it made
 * the console's own last turn someone else's: a turn that reached the server
 * just before the Wi-Fi went, and an outage past four seconds, and the welcome
 * showing that very page read as a foreign move. The console followed it and
 * dropped the pages pressed offline, which the convergence was to deliver.
 * Turns asked on the new socket, before the welcome came, are still on their
 * way, unless they ask for the page the welcome already shows: a server
 * already there stays silent.
 */
export function hearWelcome(
  asked: readonly AskedTurn[],
  page: number | null,
  reopened: number,
): { ours: boolean; left: AskedTurn[] } {
  if (page === null) return { ours: false, left: [] }
  return {
    ours: asked.some((turn) => turn.page === page),
    left: asked.filter((turn) => turn.at > reopened && turn.page !== page),
  }
}
