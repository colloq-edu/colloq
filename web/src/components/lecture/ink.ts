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

/* ------------------------------------------------- positional appends */

/**
 * Lay a piece of a stroke onto the tab's copy BY POSITION. Returns the new
 * ink, the same array when there was nothing new, or `null`: a gap.
 *
 * `from` is where the piece starts in the server's stroke (`ink:add`). Points
 * used to be appended to whatever the tab had, and two things went wrong with
 * that, both on the projector. A frame the server skipped for a socket that
 * was far behind left a permanent hole, the next piece glued on with a chord;
 * and a page fetched while pieces were still on the wire got those pieces a
 * second time. Now a copy that already holds part of the piece keeps only the
 * new tail, and a copy that is SHORTER than where the piece starts says so
 * instead of drawing a line across the slide: the caller asks for the page
 * again (`repairInkPage`).
 *
 * Without `from` (an older server) it appends as before.
 */
export function mergeInkPiece(
  ink: InkStroke[],
  piece: InkStroke,
  from: number | undefined,
): InkStroke[] | null {
  const at = ink.findIndex((known) => known.id === piece.id)
  const have = at === -1 ? 0 : ink[at].points.length
  let points = piece.points
  if (from !== undefined) {
    if (from > have) return null
    points = points.slice(have - from)
    if (points.length === 0) return ink
  }
  if (at === -1) return [...ink, { ...piece, points: [...points] }]
  const grown = { ...ink[at], points: [...ink[at].points, ...points] }
  return [...ink.slice(0, at), grown, ...ink.slice(at + 1)]
}

/**
 * How often one page may be asked for again to repair a gap. One question
 * answers it, and the pieces still on the wire meanwhile would each ask
 * again; a second later, if the answer was lost, asking once more is right.
 */
const REPAIR_EVERY_MS = 1000
const repairs = new WeakMap<SessionState, Map<number, number>>()

/** A piece did not fit (see `mergeInkPiece`): ask for the page whole, once a second at most. */
export function repairInkPage(session: SessionState, page: number): void {
  if (!session.connected) return
  const asked = repairs.get(session) ?? new Map<number, number>()
  repairs.set(session, asked)
  const now = Date.now()
  if (now - (asked.get(page) ?? Number.NEGATIVE_INFINITY) < REPAIR_EVERY_MS) return
  asked.set(page, now)
  session.send({ t: 'ink:page', page })
}

/** What the server is missing of one of our strokes (`ink:need`). */
export interface InkNeed {
  page: number
  id: string
  have: number
}
const needHearers = new WeakMap<SessionState, Set<(need: InkNeed) => void>>()

/**
 * Listen for `ink:need`. Returns the unsubscribe.
 *
 * The frame is parsed by the session, but only the ink layer holds the
 * strokes it is about: the wet ones, not yet confirmed. A listener rather
 * than a field: two frames in one tick must not overwrite each other.
 */
export function hearInkNeed(session: SessionState, hear: (need: InkNeed) => void): () => void {
  const set = needHearers.get(session) ?? new Set()
  needHearers.set(session, set)
  set.add(hear)
  return () => set.delete(hear)
}

/** Called by the session's parsing of `ink:need`. */
export function inkNeeded(session: SessionState, need: InkNeed): void {
  for (const hear of needHearers.get(session) ?? []) hear(need)
}

/* ---------------------------------------------------------- geometry */

/** Whatever a path can be laid into: a canvas context or a `Path2D`. */
export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
}

/**
 * Lay the body of a curve through points: quadratic curves through the
 * midpoints of the segments, from piece `from` up to the midpoint before the
 * last point. Returns the piece to continue from.
 *
 * THE ONE PLACE WHERE A LINE'S SHAPE IS DECIDED, for ink and for the pointer
 * alike. The caller ends the path with `lineTo` to the last point (the tail
 * changes with every new sample, the body does not), and a body laid piece by
 * piece is exactly the body laid whole: the pointer grows its path as samples
 * come instead of rebuilding a thousand points every frame.
 *
 * The pointer used to have its own geometry: a Catmull–Rom refinement thinned
 * to a hundred and twenty vertices by a stride, joined with straight lines.
 * A long circle became a twenty-sided polygon whose corners jumped every time
 * the stride changed: "a long line becomes a jagged polyline".
 */
export function layCurve(
  sink: PathSink,
  points: readonly number[],
  count: number,
  from: number,
  px: number,
  py: number,
): number {
  if (count < 1) return from
  if (from === 0) {
    sink.moveTo(points[0] * px, points[1] * py)
    from = 1
  }
  for (let i = from; i < count - 1; i += 1) {
    const cx = points[i * 2] * px
    const cy = points[i * 2 + 1] * py
    const mx = (cx + points[i * 2 + 2] * px) / 2
    sink.quadraticCurveTo(cx, cy, mx, (cy + points[i * 2 + 3] * py) / 2)
  }
  return Math.max(from, count - 1)
}

/**
 * Whether a stroke is one spot: every point within half a pixel of the first.
 *
 * A tap is never two coordinates on the wire: the lift adds its point, and a
 * Pencil standing still keeps reporting pressure. Four identical numbers made
 * a zero-length path, and a canvas draws nothing for that: the dot on an i
 * showed under the pen and vanished with the echo, and in the hall with the
 * next full repaint. Leaves at the first point that is not the spot, so a
 * real line costs one comparison.
 */
export function isDot(points: readonly number[], px: number, py: number): boolean {
  if (points.length < 2) return false
  const x = points[0]
  const y = points[1]
  for (let i = 2; i + 1 < points.length; i += 2) {
    if (Math.hypot((points[i] - x) * px, (points[i + 1] - y) * py) > 0.5) return false
  }
  return true
}

/* ----------------------------------------------------- the eraser */

/**
 * The eraser's reach on screen, in CSS px: the ring that is drawn and the
 * area that erases are ONE number.
 *
 * The ring used to be a fixed sixteen pixels while the hit area was a share of
 * the page width: in portrait (an 810 px sheet) a line clearly inside the
 * ring, twelve pixels from its centre, survived the sweep. People look under
 * the ring to see what it will take, so the ring must not lie.
 */
export const ERASER_PX = 16

/**
 * How close to a stroke's centreline the eraser takes it, in page widths: the
 * ring, plus half the stroke's own thickness, since what the eye sees under
 * the ring is the stroke's edge, not its centreline.
 */
export function eraserReach(strokeWidth: number, sheetWidth: number): number {
  return ERASER_PX / Math.max(1, sheetWidth) + strokeWidth / 2
}

/* --------------------------------------------------- two-finger tap */

/** One finger on the sheet, as the two-finger tap sees it. */
export interface Tap {
  pointer: number
  x: number
  y: number
  down: number
  up: number | null
  moved: boolean
}

/** Two touches landing within this many ms count as "together". */
export const TAP_TOGETHER_MS = 250
/** Neither touch is held longer than this, and they lift within this of each other. */
export const TAP_HOLD_MS = 300

/**
 * Whether two finished touches are a two-finger tap (undo).
 *
 * BOTH FINGERS ON THE GLASS AT ONCE, and that is the condition that was
 * missing. Only the downs were compared, and a single finger tapping twice
 * (the iOS habit of double-tap to zoom), or the edge of the resting hand
 * touching the glass twice, read as two fingers: the last stroke vanished
 * from the projector without a word. Now the second must land while the first
 * is still down, the two must lift close together, and neither may be held:
 * a palm does not do all of that while one writes.
 */
export function twoFingerTap(a: Tap, b: Tap): boolean {
  const [first, second] = a.down <= b.down ? [a, b] : [b, a]
  if (first.up === null || second.up === null) return false
  if (first.moved || second.moved) return false
  if (second.down - first.down > TAP_TOGETHER_MS) return false
  if (second.down >= first.up) return false
  if (Math.abs(first.up - second.up) > TAP_HOLD_MS) return false
  return first.up - first.down <= TAP_HOLD_MS && second.up - second.down <= TAP_HOLD_MS
}
