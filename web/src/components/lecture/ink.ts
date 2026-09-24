/**
 * What a tab knows about the lecture's ink that it does not have on hand.
 *
 * Ink used to arrive in a single helping: ALL pages in one frame of the
 * welcome batch. At a lecture with twenty minutes of writing that is about a
 * megabyte per socket, while at that moment people look at one page; after a
 * Wi-Fi drop the whole audience comes back at once, and the megabyte is
 * multiplied by five hundred. So the batch carries the current page and an
 * INVENTORY of the rest (`ink:pages`), their numbers without a single stroke,
 * and a page the tab moved to without asking is requested by the tab itself
 * (`ink:page`).
 *
 * That brings two things that did not exist before, and both live here:
 *
 *  • THE INVENTORY. The console counts from the ink how many blank sheets
 *    were started (sheet number N proves that every sheet before it was
 *    started too), and the thumbnail strip lays them out. A tab can no longer
 *    count this from what it has on hand: holding one page, it would count
 *    zero sheets and drop the inked ones from the strip, exactly the loss for
 *    which the count moved out of the tab's memory and into the ink (see
 *    `boardsInked` in pult.ts).
 *  • THE QUESTION. A page with no ink on hand is requested exactly once per
 *    welcome batch: a pen on a neighbouring page wakes a redraw twenty times a
 *    second, and a question with no memory of the ones already asked would
 *    become a queue of hundreds of identical frames.
 *
 * The server (control.ts, welcome batch) sends ink only for the page being
 * shown, followed by the inventory `ink:pages`: which pages have any ink at
 * all. Until the inventory is here (an old server, or the batch still on its
 * way), "how much is inked" = "how much is on hand", there is nothing to ask,
 * and not a single extra frame goes down the wire: the tab stays silent
 * exactly until it learns what it is missing.
 *
 * Not a single rune: the state here is not what gets drawn but what the tab
 * has managed to learn. Redraws are still ordered by `session.inkRevision`,
 * and the inventory arrives together with it (see `ink:pages` in
 * session.svelte.ts).
 */
import type { SessionState } from '@/lib/session.svelte'
import { inkPagesOf, type InkStroke } from '@shared/lecture'

/**
 * The inventory and the questions asked belong to one room.
 *
 * The owner is recorded explicitly: switching rooms changes the session
 * state, and the previous lecture's inventory in the new one would mean
 * sheets that are not there and questions nobody is going to answer.
 */
let owner: SessionState | null = null
/**
 * The server's latest inventory, or `null`: none has been sent. These are
 * DIFFERENT things.
 */
let listed: readonly number[] | null = null
/** Pages already asked about since the latest inventory. */
const asked = new Set<number>()

function own(session: SessionState): void {
  if (owner === session) return
  owner = session
  listed = null
  asked.clear()
}

/**
 * An inventory arrived: keep it.
 *
 * Called by the parsing of the `ink:pages` frame (session.svelte.ts). The
 * inventory travels next to every full `ink` frame, that is, with the welcome
 * batch and with "erase everything", so this is also where the questions
 * asked are forgotten: after a reconnect they are asked again, and answers to
 * the earlier ones will not come.
 */
export function noteInkedPages(session: SessionState, pages: readonly number[]): void {
  own(session)
  listed = [...pages]
  asked.clear()
}

/**
 * Which pages have ink: by the inventory and by what is on hand.
 *
 * The union, precisely. The inventory says what there was at the moment of
 * the welcome batch, while a stroke drawn on a new page a minute later
 * arrives as an echo (`ink:add`) and is not in the inventory; conversely, a
 * page the tab asked for and received is in the inventory, and after
 * `ink:clear` would remain only there. Neither source is complete on its
 * own, and "I don't know" costs more here than an extra sheet in the strip.
 */
export function inkedPages(session: SessionState): ReadonlySet<number> {
  own(session)
  const pages = new Set(inkPagesOf(session.ink))
  if (listed !== null) for (const page of listed) pages.add(page)
  return pages
}

/**
 * Ask for a page's ink if we do not have it and it exists somewhere.
 *
 * The checks go from cheap to expensive, and that is not a matter of taste:
 * this is called on every change in the ink, that is, twenty times a second
 * while the presenter writes. "Already holding it" comes before the
 * inventory: while someone writes on this same page, the check stops at the
 * first stroke, whereas the inventory is a pass over all of the tab's ink.
 *
 * Silence while offline is deliberate. The control queue holds sixteen
 * messages and throws out the old ones: a question about ink that pushed out
 * someone's stroke is a bad trade. It will be asked again when the
 * connection returns: the welcome batch will bring a fresh inventory, and the
 * questions asked will be forgotten along with it.
 */
export function askInkPage(session: SessionState, page: number): void {
  if (!session.connected) return
  if (session.ink.some((stroke) => stroke.page === page)) return
  own(session)
  if (asked.has(page)) return
  // Nobody has ink on this page, so there is nothing to ask about. Without an
  // inventory this rule shuts off questions by itself: "inked" then equals
  // "on hand", and we have already returned a line above.
  if (!inkedPages(session).has(page)) return
  asked.add(page)
  session.send({ t: 'ink:page', page })
}

/**
 * Replace the ink of ONE page without touching the others.
 *
 * Called by the parsing of the `ink:page` frame (session.svelte.ts). A
 * replacement, precisely, not a merge by stroke ids: a page is the unit of
 * delivery, and the server answers about it whole, including whatever was
 * erased on it. That is why an empty list wipes the page clean: it is a
 * legitimate answer "the page is blank", not a lost frame.
 */
export function replaceInkPage(
  ink: readonly InkStroke[],
  page: number,
  strokes: readonly InkStroke[],
): InkStroke[] {
  const rest = ink.filter((stroke) => stroke.page !== page)
  return strokes.length === 0 ? rest : [...rest, ...strokes]
}

/** For tests: forget everything the tab has learned about ink. */
export function forgetInkPages(): void {
  owner = null
  listed = null
  asked.clear()
}
