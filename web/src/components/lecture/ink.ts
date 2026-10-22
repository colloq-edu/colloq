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
 *  • THE INVENTORY. Which pages have ink somewhere, the tab's or not. The
 *    sheets themselves are the server's list (`lecture.sheets`), and the
 *    console's strip lays them out from it; their ink is what the tab may
 *    not hold. Holding one page, a tab cannot tell a blank sheet from one
 *    whose ink it has not been sent, so the inventory is what says which
 *    page is worth a question (the strip's sheet thumbnails, the page on
 *    screen).
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
import { INK_WIDTH_MAX, INK_WIDTH_MIN, inkPagesOf, type InkStroke, type LectureZoom } from '@shared/lecture'
import { panZoom, zoomAround, zoomStep, zoomToRect } from './zoom'

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
 * own, and "I don't know" costs more here than an extra question: a page
 * left out is never asked for and stays blank, while an extra one costs a
 * frame answered with an empty page.
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
 *
 * `sheetWidth` is how wide the WHOLE page is on screen: the sheet times the
 * zoom. The ring keeps its size on the glass under a magnified detail, so it
 * covers a quarter of the page distance at ×4, and so does the reach.
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

/* ------------------------------------------- the start of a gesture */

/** A finger stroke younger than this may still be the start of something else. */
export const PALM_YOUNG_MS = 300
/** A finger stroke that has travelled less than this on the glass, in px, may too. */
export const PALM_TRAVEL_PX = 10

/**
 * Whether a finger's stroke may be taken back from the room: it is young, or
 * it has hardly moved on the glass. `age` is in ms; `px` and `py` turn page
 * fractions into px of the glass (the sheet times the zoom).
 *
 * Two things can turn out, a moment late, to have begun with a finger's
 * stroke: the palm under a pen that is landing (InkLayer · `dropPalm`), and
 * the first finger of a pinch (`commitPinch`). Either may take back what that
 * finger had drawn so far, and ONLY that much: a stroke a second old and an
 * inch long is ink the hall has been watching being written. A thumb coming
 * to rest beside a drawing finger once turned the finger into a pinch, and
 * two seconds of a curve vanished from the projector, with no trace for
 * Undo to bring back.
 */
export function mayTakeBack(
  points: readonly number[],
  age: number,
  px: number,
  py: number,
): boolean {
  if (age < PALM_YOUNG_MS) return true
  let travel = 0
  for (let i = 2; i + 1 < points.length; i += 2) {
    travel += Math.hypot((points[i] - points[i - 2]) * px, (points[i + 1] - points[i - 1]) * py)
    if (travel >= PALM_TRAVEL_PX) return false
  }
  return true
}

/* ------------------------------------------------------------ the zoom */

/**
 * A new stroke's thickness under the zoom, in page widths.
 *
 * The chosen width divided by the magnification: a line written on a
 * magnified detail looks on the console exactly as thick as the same pen at
 * ×1, which is what the hand expects, and lies on the page that much finer,
 * which is what writing on a detail is for. Clamped into the server's range
 * HERE, before sending: a stroke the server clamped quietly would come back
 * in the echo thicker than the presenter drew it, and the hall would have a
 * different line.
 */
export function inkWidthAt(width: number, zoom: LectureZoom | null | undefined): number {
  const thin = width / Math.max(1, zoom?.z ?? 1)
  return Math.round(Math.min(INK_WIDTH_MAX, Math.max(INK_WIDTH_MIN, thin)) * 1e6) / 1e6
}

/** Two fingers as a pinch sees them: their midpoint and the distance between them, in screen px. */
export interface FingerPair {
  x: number
  y: number
  d: number
}

export function fingerPair(a: { x: number; y: number }, b: { x: number; y: number }): FingerPair {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(b.x - a.x, b.y - a.y) }
}

/** How much the fingers must spread or close, as a share of where they started, to be a pinch. */
export const PINCH_SPREAD = 0.1
/** And by how much at least, in screen px, whatever the share: see `pinchCommits`. */
export const PINCH_SPREAD_PX = 12
/** How far their midpoint must travel, in screen px, to be a two-finger pan. */
export const PINCH_SLIDE_PX = 16

/**
 * Whether two fingers on the sheet have become a pinch.
 *
 * Until they have, the two-finger TAP owns them: that is Undo, and it is
 * strict about movement (`TAP_SLACK_PX` in the ink layer) but not about these
 * few pixels. A tap's fingers land and lift within a quarter of a second and
 * barely move; the stand's tap is two touches 56 px apart that do not move at
 * all. A tenth of the spread is six pixels of such a tap, more than a real
 * tap's wobble and less than any deliberate pinch, and sixteen pixels of
 * slide is a pan nobody makes by accident. Once a pinch, always a pinch: the
 * tap is cancelled. What the first finger began never reached the room: the
 * pair landed together (`pinchMayStart`), within the window for which a
 * finger's work is held back.
 *
 * THE SPREAD IS COUNTED IN PIXELS TOO, not only as a share. The pinky and a
 * knuckle of a resting hand touch the glass a finger's width apart, and a
 * tenth of fifty pixels is the five a settling hand rolls by at once: the
 * hall zoomed ×1.13 around the palm. Twelve pixels is more than a hand
 * settles and less than the first moment of any deliberate pinch; fingers
 * that start far apart still need their tenth.
 */
export function pinchCommits(start: FingerPair, now: FingerPair): boolean {
  const spread = Math.abs(now.d - start.d)
  if (start.d > 0 && spread >= PINCH_SPREAD_PX && spread / start.d >= PINCH_SPREAD) return true
  return Math.hypot(now.x - start.x, now.y - start.y) >= PINCH_SLIDE_PX
}

/**
 * How long a palm on the glass counts without a word from it, in ms: see
 * `RestingPalms`.
 */
export const PALM_QUIET_MS = 5000

/**
 * The palm-sized contacts on the glass: wherever they lie, the sheet, the
 * armrest under it or the rail, and whatever stops them on their way to the
 * sheet. While one rests, no two fingers start a pinch (`pinchMayStart`).
 *
 * The ink layer counts them from the whole window, before anyone else hears
 * of them: the console's root swallows a palm-sized touch the moment it
 * lands, so that the heel presses nothing, and a layer that counted palms
 * from its own sheet never saw one. The pinky and a knuckle of the resting
 * hand then made a pinch and zoomed the hall.
 *
 * A count that never forgets is worse than none: a palm whose lift the page
 * missed would forbid every pinch until the console went dark. So a palm
 * counts while it says something: landing, moving or changing its size; one
 * silent for `PALM_QUIET_MS` has gone, and comes back with its next word if
 * it was only lying still.
 */
export class RestingPalms {
  readonly #heard = new Map<number, number>()

  /** A palm-sized contact landed, grew so, or stirred at `now`. */
  rest(pointer: number, now: number): void {
    this.#heard.set(pointer, now)
  }

  /** Whether `pointer` is a palm. */
  has(pointer: number): boolean {
    return this.#heard.has(pointer)
  }

  /** The contact lifted, or the browser took it away. */
  lift(pointer: number): void {
    this.#heard.delete(pointer)
  }

  /** How many palms rest at `now`: a silent one has gone, see above. */
  count(now: number): number {
    for (const [pointer, heard] of this.#heard) {
      if (now - heard >= PALM_QUIET_MS) this.#heard.delete(pointer)
    }
    return this.#heard.size
  }

  clear(): void {
    this.#heard.clear()
  }
}

/**
 * How a spell of the ink layer holding the pointer ended (InkLayer ·
 * `onbusy`): with work that stood (`ink`: the pen's, or a finger's that
 * reached the room), or as a two-finger gesture (`gesture`: a pinch, or a
 * first finger whose held work a second finger made never happen). The
 * console guards its rail against the writing hand's heel after the one, and
 * not after the other: after a pinch the thumb's next tap is meant.
 */
export type BusyKind = 'ink' | 'gesture'

/**
 * Whether the second finger to land makes a pinch with the first: a
 * candidate, which still has to move before it zooms (`pinchCommits`).
 *
 * The palm must zoom no more than it may write or undo, and a pinch's own
 * test is a few pixels of spread: a settling hand gives that at once. So the
 * pair is judged by how it LANDED, and all three must hold:
 *  — TOGETHER: `apart`, the ms between the two landings, is within
 *    `TAP_TOGETHER_MS`. A pinch is two fingers put down as one. A finger
 *    that has been drawing for a second and a thumb that comes to rest
 *    beside it are not a pinch, and used to be one: the drawing finger alone
 *    moved the pair's midpoint, the hall zoomed after it, and the stroke was
 *    taken back. It is also the window for which a finger's stroke, erase
 *    and beam are held back from the room (InkLayer · `forgetFirst`), so the
 *    first finger of a pinch never had time to show the hall anything;
 *  — NO PALM ON THE GLASS: `palms` palm-sized contacts are down, anywhere on
 *    it (`RestingPalms`). The heel rests while the pinky and the knuckles of
 *    the same hand touch as small contacts and creep, and those are exactly
 *    two "fingers";
 *  — THE PEN NOT NEAR (`penNear`): not touching, and neither touching nor
 *    HOVERING a moment ago. Unlike the tap's, this guard counts hover: a hand
 *    resting while the presenter talks keeps the Pencil hovering, and its
 *    small contacts used to pass a guard of contact alone and zoom the hall
 *    around the palm.
 */
export function pinchMayStart(apart: number, palms: number, penNear: boolean): boolean {
  return !penNear && palms === 0 && Math.abs(apart) <= TAP_TOGETHER_MS
}

/**
 * Where a pinch has taken the view.
 *
 * Computed from the view at the START of the gesture each time, never from
 * the previous step: the rounding a zoom gets on its way to the wire would
 * otherwise pile up, and the page would creep under resting fingers. The
 * place under the fingers' first midpoint stays under their midpoint: it
 * grows with their spread (`zoomAround`) and travels with the midpoint
 * (`panZoom`). `frame` is the sheet on screen, which does not move with the
 * zoom: the zoom happens inside it.
 */
export function pinchZoom(
  from: LectureZoom | null | undefined,
  frame: { left: number; top: number; width: number; height: number },
  start: FingerPair,
  now: FingerPair,
): LectureZoom | null {
  if (frame.width <= 0 || frame.height <= 0 || start.d <= 0) return from ?? null
  const u0 = (start.x - frame.left) / frame.width
  const v0 = (start.y - frame.top) / frame.height
  const u1 = (now.x - frame.left) / frame.width
  const v1 = (now.y - frame.top) / frame.height
  const grown = zoomAround(from, u0, v0, (from?.z ?? 1) * (now.d / start.d))
  return panZoom(grown, u1 - u0, v1 - v0)
}

/**
 * How far a magnifier press may travel, in screen px, and still be a tap:
 * twice as close around the point instead of a frame.
 */
export const FRAME_TAP_PX = 10

/**
 * What the magnifier asks for: a dragged frame from `a` to `b` fills the
 * sheet (`zoomToRect`); a tap (`b` is `null`) comes twice as close around `a`
 * (`zoomStep`). Points are page fractions, taken through the view the
 * presenter sees, so the frame is relative to the CURRENT zoom: a frame drawn
 * on a magnified detail magnifies further.
 */
export function frameZoom(
  view: LectureZoom | null | undefined,
  a: { x: number; y: number },
  b: { x: number; y: number } | null,
): LectureZoom | null {
  if (!b) return zoomStep(view, a.x, a.y)
  return zoomToRect({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) })
}

/* ------------------------------------------------- straight on hold */

/** How long the pen must rest, still pressed, before the stroke straightens. */
export const STRAIGHT_HOLD_MS = 550
/** How far the resting pen may tremble, in screen px, and still be resting. */
export const STRAIGHT_STILL_PX = 4
/** How far from its start the stroke must reach, in screen px: a dot or a tick does not become a line. */
export const STRAIGHT_MIN_PX = 24
/**
 * How far the stroke may stray from the straight line between its ends and
 * still be meant as a line: 8 % of its length, but never less than the
 * three pixels a steady hand trembles by. A bracket bows by a sixth of its
 * height and more, a ruled-looking freehand line by a few percent.
 */
const STRAIGHT_BEND = 0.08
const STRAIGHT_SLACK_PX = 3

/**
 * Whether a stroke the pen has come to rest on becomes a straight line from
 * its first point to `end` (where the pen rests now).
 *
 * The rule from the lecture hall is "hold the pen at the end and the line
 * straightens", the way drawing apps do it. But a pen also rests mid-letter
 * while the presenter thinks, and a bracket or an arc that turned into a
 * straight bar under a resting hand would be ink the presenter never meant,
 * in front of everyone. So the stroke must already BE a line: long enough to
 * be one (`STRAIGHT_MIN_PX`) and never further from the straight segment than
 * a hand that meant a line strays (`STRAIGHT_BEND`). An underline, an axis,
 * a fraction bar, an arrow's shaft pass; a bracket, an arc, a tick or a
 * letter do not.
 *
 * `px`, `py` turn page fractions into screen px: the sheet's size times the
 * zoom, because the thresholds are about what the hand did on the glass.
 */
export function straightens(
  points: readonly number[],
  end: { x: number; y: number },
  px: number,
  py: number,
): boolean {
  if (points.length < 2) return false
  const ax = points[0] * px
  const ay = points[1] * py
  const bx = end.x * px
  const by = end.y * py
  const dx = bx - ax
  const dy = by - ay
  const chord = Math.hypot(dx, dy)
  if (chord < STRAIGHT_MIN_PX) return false
  const slack = Math.max(STRAIGHT_SLACK_PX, chord * STRAIGHT_BEND)
  const near = slack * slack
  for (let i = 2; i + 1 < points.length; i += 2) {
    const x = points[i] * px - ax
    const y = points[i + 1] * py - ay
    const along = Math.max(0, Math.min(1, (x * dx + y * dy) / (chord * chord)))
    const ox = x - along * dx
    const oy = y - along * dy
    if (ox * ox + oy * oy > near) return false
  }
  return true
}

/* ---------------------------------------------- a rectangle on hold */

/**
 * How near its beginning a closed stroke must end, in screen px: a fifth of
 * the rectangle's shorter side, never less than sixteen pixels. A hand
 * closing a box lands a little short of where it began or runs a little past
 * it; an open U or an L ends a whole side away.
 */
const RECT_CLOSE = 0.2
const RECT_CLOSE_PX = 16
/**
 * How far into the stroke, as a share of its length, the end may land and
 * still close it: a hand that overshoots its start runs on along the
 * stroke's first stretch, not back to its very first point.
 */
const RECT_CLOSE_REACH = 0.25
/**
 * How far a point may stray from the rectangle's border, in screen px, and
 * how near each corner the stroke must pass: a tenth of the shorter side,
 * never less than the four pixels a steady hand trembles by. A circle's
 * points at 45° stand about a fifth of its radius inside the frame fitted
 * round it, and the frame's corners a third of the radius beyond the circle;
 * a hand that meant a box keeps to its sides and turns at its corners.
 */
const RECT_NEAR = 0.1
const RECT_NEAR_PX = 4
/**
 * How far a long side may run off true, as a share of its own length, when
 * that is more than `RECT_NEAR`: a box round a formula is wide and low, and
 * a hand draws its 400 px sides a degree or two aslant and sagging, which
 * a tenth of its 60 px height would refuse. Half the line's `STRAIGHT_BEND`:
 * each side is a line, and the box's corners hold its ends. Along the other
 * axis a corner keeps the short side's tolerance, so a flat ellipse, whose
 * ends are round, still runs along too little of its short sides.
 */
const RECT_BEND = 0.05
/**
 * How long the shorter side must be on the glass, in screen px: a box round
 * a symbol or a line of a formula is bigger than its letters, and a squarish
 * "0", "O" or "D" a presenter rests on at lecture letter size stays a
 * letter. Not more: on an 11-inch iPad beside the notes the sheet is about
 * 400 px tall, and a box round a formula there is some forty.
 */
export const RECT_MIN_PX = 36
/**
 * How much of each side's length the stroke must run along: all four sides
 * drawn, not three sides closed by a diagonal, and not a rounded blob.
 */
const RECT_COVER = 0.75

/** An axis-aligned rectangle in page fractions: (x0, y0) is its top left corner, (x1, y1) its bottom right. */
export interface InkRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The middle value of a list (the upper one of an even pair). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/** How far the point (x, y) lies from the segment (ax, ay)–(bx, by). */
function toSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const span = dx * dx + dy * dy
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / span))
  return Math.hypot(x - ax - t * dx, y - ay - t * dy)
}

/**
 * The rectangle frame a stroke the pen has come to rest on becomes, or
 * `null` when it stays as drawn.
 *
 * The second half of "hold the pen and the stroke straightens", the way notes
 * apps do it: a box drawn round a formula and held where it closes becomes a
 * clean frame. The caution is the line's (`straightens`): a pen also rests in
 * the middle of a loop, a letter, a circle round a word, and those must stay
 * as drawn. So the stroke must already BE a rectangle:
 *
 *  — closed: its end back near its beginning (`RECT_CLOSE`), whichever corner
 *    or side it started at, in either direction;
 *  — big enough on the glass: both sides at least `RECT_MIN_PX`, so an
 *    "o", a "0" or a "□" written at letter size stays a letter;
 *  — on its border: no point further from it than `RECT_NEAR` (a long side
 *    `RECT_BEND` of its length), and past each corner (a circle, an
 *    ellipse, a triangle, a zigzag are not);
 *  — along all four sides (`RECT_COVER`): an L, a U, three sides closed by a
 *    diagonal are not.
 *
 * A stroke that straightens is a line, and the line wins.
 *
 * The sides are fitted to the points that run along each of them (the
 * median of where they run), not taken from the stroke's bounding box: the
 * overshoot of a hand closing the box at a corner pokes out past it, and
 * would make the frame bigger than the box the hand drew.
 *
 * `px`, `py` as for `straightens`: the sheet's size on the glass.
 */
export function rectangleOf(
  points: readonly number[],
  end: { x: number; y: number },
  px: number,
  py: number,
): InkRect | null {
  if (points.length < 8 || straightens(points, end, px, py)) return null
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i + 1 < points.length; i += 2) {
    xs.push(points[i] * px)
    ys.push(points[i + 1] * py)
  }
  xs.push(end.x * px)
  ys.push(end.y * py)
  const n = xs.length
  // Left, right, top, bottom, in screen px: from the bounding box, then each
  // side refitted to the points nearest it, until the overshoot no longer counts.
  const side = [Infinity, -Infinity, Infinity, -Infinity]
  for (let i = 0; i < n; i += 1) {
    side[0] = Math.min(side[0], xs[i])
    side[1] = Math.max(side[1], xs[i])
    side[2] = Math.min(side[2], ys[i])
    side[3] = Math.max(side[3], ys[i])
  }
  for (let round = 0; round < 3; round += 1) {
    const across: number[][] = [[], [], [], []]
    for (let i = 0; i < n; i += 1) {
      let nearest = 0
      let best = Infinity
      for (let k = 0; k < 4; k += 1) {
        const off = Math.abs((k < 2 ? xs[i] : ys[i]) - side[k])
        if (off < best) {
          best = off
          nearest = k
        }
      }
      across[nearest].push(nearest < 2 ? xs[i] : ys[i])
    }
    if (across.some((list) => list.length === 0)) return null
    for (let k = 0; k < 4; k += 1) side[k] = median(across[k])
  }
  const [left, right, top, bottom] = side
  const short = Math.min(right - left, bottom - top)
  if (!(short >= RECT_MIN_PX)) return null
  const near = Math.max(RECT_NEAR_PX, short * RECT_NEAR)
  const close = Math.max(RECT_CLOSE_PX, short * RECT_CLOSE)
  // Each side's own tolerance (left, right, top, bottom): a long side's by its length.
  const upright = Math.max(near, (bottom - top) * RECT_BEND)
  const level = Math.max(near, (right - left) * RECT_BEND)
  const slack = [upright, upright, level, level]

  // Closed: the end lands near the stroke's first stretch.
  const ex = xs[n - 1]
  const ey = ys[n - 1]
  let length = 0
  for (let i = 1; i < n; i += 1) length += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
  let closed = Math.hypot(ex - xs[0], ey - ys[0]) <= close
  for (let i = 1, run = 0; !closed && i < n - 1 && run <= length * RECT_CLOSE_REACH; i += 1) {
    closed = toSegment(ex, ey, xs[i - 1], ys[i - 1], xs[i], ys[i]) <= close
    run += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
  }
  if (!closed) return null

  // On the border: each side as a segment, run on past its corners by the
  // closing reach, so a corner overshot on the way round still counts.
  const past = (v: number, a: number, b: number) => Math.max(0, a - close - v, v - b - close)
  for (let i = 0; i < n; i += 1) {
    const x = xs[i]
    const y = ys[i]
    if (
      Math.hypot(past(y, top, bottom), x - left) > upright &&
      Math.hypot(past(y, top, bottom), x - right) > upright &&
      Math.hypot(past(x, left, right), y - top) > level &&
      Math.hypot(past(x, left, right), y - bottom) > level
    ) {
      return null
    }
  }

  // Through each corner: within each side's tolerance along its own axis
  // (an ellipse round the corner: a round one, `near`, unless a side is long).
  for (const [cx, cy] of [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ]) {
    let best = Infinity
    for (let i = 1; i < n && best > 1; i += 1) {
      best = Math.min(
        best,
        toSegment(
          cx / upright,
          cy / level,
          xs[i - 1] / upright,
          ys[i - 1] / level,
          xs[i] / upright,
          ys[i] / level,
        ),
      )
    }
    if (best > 1) return null
  }

  // Along each side: the pieces of the stroke that run along it cover most of it.
  for (let k = 0; k < 4; k += 1) {
    const vertical = k < 2
    const from = vertical ? top : left
    const to = vertical ? bottom : right
    const spans: [number, number][] = []
    for (let i = 1; i < n; i += 1) {
      const a = vertical ? xs[i - 1] : ys[i - 1]
      const b = vertical ? xs[i] : ys[i]
      if (Math.abs(a - side[k]) > slack[k] || Math.abs(b - side[k]) > slack[k]) continue
      const p = vertical ? ys[i - 1] : xs[i - 1]
      const q = vertical ? ys[i] : xs[i]
      const lo = Math.max(from, Math.min(p, q))
      const hi = Math.min(to, Math.max(p, q))
      if (hi > lo) spans.push([lo, hi])
    }
    spans.sort((s, t) => s[0] - t[0])
    let covered = 0
    let reach = from
    for (const [lo, hi] of spans) {
      if (hi <= reach) continue
      covered += hi - Math.max(lo, reach)
      reach = hi
    }
    if (covered < (to - from) * RECT_COVER) return null
  }
  return { x0: left / px, y0: top / py, x1: right / px, y1: bottom / py }
}

/**
 * A rectangle frame as one ordinary stroke: its four sides from the top left
 * corner round and back to it, every corner given twice.
 *
 * Every renderer draws a stroke as quadratic curves through the midpoints of
 * its segments (`layCurve`, and the ink layer's `growPath` for the hall).
 * Through a corner given once that is a curve cutting the corner off, a box
 * with rounded corners; through a corner given twice, the curves on either
 * side of it are straight and meet at it. So the frame needs no kind of
 * stroke of its own: not on the wire, not in the room's memory, not in saved
 * notes. Its inside is empty, as a box round a formula must be.
 */
export function framePoints(rect: InkRect): number[] {
  const { x0, y0, x1, y1 } = rect
  return [x0, y0, x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0, x0, y0]
}

/**
 * The frame while the pen still holds it after the snap: the corner nearest
 * where the pen was at the snap (`grip`) moves as the pen has moved since, to
 * `to`; the opposite corner stays, and the sides stay upright. A corner
 * dragged past the opposite one turns the frame over rather than inside out.
 *
 * By the pen's movement, not to the pen: a box closed mid-side would
 * otherwise jump its nearest corner onto the pen at the first tremble.
 */
export function dragFrame(rect: InkRect, grip: { x: number; y: number }, to: { x: number; y: number }): InkRect {
  // The nearest corner on the glass is the nearest along each axis: the scale does not change it.
  const right = Math.abs(grip.x - rect.x1) < Math.abs(grip.x - rect.x0)
  const below = Math.abs(grip.y - rect.y1) < Math.abs(grip.y - rect.y0)
  const fixedX = right ? rect.x0 : rect.x1
  const fixedY = below ? rect.y0 : rect.y1
  const movedX = (right ? rect.x1 : rect.x0) + to.x - grip.x
  const movedY = (below ? rect.y1 : rect.y0) + to.y - grip.y
  return {
    x0: Math.min(fixedX, movedX),
    y0: Math.min(fixedY, movedY),
    x1: Math.max(fixedX, movedX),
    y1: Math.max(fixedY, movedY),
  }
}

/* ------------------------------------------------------- the hold ring */

/**
 * How long the pen must rest before the hold ring shows.
 *
 * The ring answers a question the hand cannot see the answer to: "if I keep
 * holding, will this line straighten?" Without it the rule is invisible, and
 * a presenter who does not know it finds out by accident, in front of the
 * hall. But a pen also stops for a moment in the middle of handwriting, at
 * the turn of a letter or before the lift, and a ring that flickered at every
 * such stop would be noise under the pen all lecture long. So the ring keeps
 * out of the first moments of a rest: a writing hand's stop is over by then,
 * and a hand that holds on purpose is still there.
 */
export const HOLD_RING_AFTER_MS = 150
/**
 * How long the closed ring takes to go out once the line has straightened:
 * the snap of the line is the news, and the ring only steps aside for it. A
 * trace short enough not to lag behind the hand that already moves on.
 */
export const HOLD_RING_FADE_MS = 120

/** The hold ring as one frame draws it. */
export interface HoldRing {
  /** How much of the circle is closed, 0..1, clockwise from twelve o'clock. */
  closed: number
  /** How strongly the whole ring is drawn, 0..1: it fades only on its way out. */
  alpha: number
  /**
   * Whether it changes by itself: while it closes or fades, the next frame
   * draws it differently. A closed ring waiting for its line asks for none.
   */
  moving: boolean
}

/**
 * The hold ring at `now`: for a pen resting since `since`, or, once the line
 * has straightened at `snapped`, the closed ring going out. `null`: nothing
 * to draw. All three are `performance.now()` times.
 *
 * THE RING IS A COUNTDOWN TO THE SNAP, and it closes at exactly
 * `STRAIGHT_HOLD_MS` of rest, the moment the line straightens: the hand learns
 * how long to hold by watching, not from a manual. It shows up EMPTY after
 * `HOLD_RING_AFTER_MS` and closes from there, rather than appearing already a
 * quarter done: a ring that jumps in part-way reads as a glitch, one that
 * starts at the top and runs round reads as time. The pace is even, as the
 * clock it shows is.
 *
 * Pure time, so it can be checked without a pen: which stroke deserves a ring
 * at all, and where it is drawn, is the ink layer's business (`holdShown`).
 */
export function holdRingAt(now: number, since: number, snapped: number | null = null): HoldRing | null {
  if (snapped !== null) {
    const gone = Math.max(0, now - snapped) / HOLD_RING_FADE_MS
    return gone >= 1 ? null : { closed: 1, alpha: 1 - gone, moving: true }
  }
  const rested = now - since
  if (rested < HOLD_RING_AFTER_MS) return null
  const closed = Math.min(1, (rested - HOLD_RING_AFTER_MS) / (STRAIGHT_HOLD_MS - HOLD_RING_AFTER_MS))
  return { closed, alpha: 1, moving: closed < 1 }
}
