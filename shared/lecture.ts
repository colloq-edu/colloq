import { tr } from './i18n.js'
/**
 * What the room shows during a lecture — a vocabulary shared by the browser
 * and the server.
 *
 * A lecture: one page on the projector and the teacher's hand on top of it.
 *
 * The room can already look at a document together: it has a shared screen
 * (`boards`) and following the teacher through presence. A lecture is a
 * different kind of class, and the difference is not one of volume: there
 * EVERYONE looks at the document on their own and can run ahead, here there
 * is ONE projection the hall sees, and one person who controls it from a
 * tablet in their hands.
 *
 * Hence three things the shared screen does not have: the projection page
 * (one for everyone and nobody's but the presenter's), ink on top of it, and
 * the pointer.
 *
 * WHERE THIS LIVES. In process memory, next to the shared screen and the run
 * queue, not in the room's document. The argument is the same as for the
 * board, and it is stronger here: a lecture is an hour of the room's life,
 * not its content. A pencil stroke that got into the shared document would
 * become a version in the history, travel into a snapshot and come back on
 * Ctrl+Z — three ways to spoil what a lecture is given for. The price is
 * named out loud: a server restart turns off the projection and erases the
 * ink, just as it turns off the shared screen and the queue.
 *
 * COORDINATES ARE NORMALIZED to the page: 0..1 across its width and 0..1
 * down its height. The projector has 1920 pixels, the tablet 1180, a student
 * one and a half megabytes of browser in half a screen — the presenter's
 * pixel means nothing to any of them. A fraction means the same everywhere.
 */

/** What the room is showing right now. `null` — there is no lecture. */
export interface LectureState {
  /** The document's path in the seminar folder. */
  file: string
  /** Who presents: their tablet controls the projection. */
  by: string
  byName: string
  /**
   * The presenter's color — the pen draws with it by default.
   *
   * The pointer is NOT colored with it: it is red for everyone, always (see
   * `laser` in protocol.ts), otherwise at a second teacher's lecture the beam
   * turned out blue and could no longer be told apart from the ink.
   */
  color: string
  /**
   * The page on the projector, counting from one.
   *
   * NEGATIVE means a blank sheet: −1, −2 and so on. They are not in the
   * document; the teacher creates them in the middle of a lecture when the
   * slide has ended but the derivation of a formula has not; on the projector
   * it is a white field across the whole screen, on the console the same
   * field under the pen. As a separate field this would be two sources of
   * truth about what is on the screen now, and they would drift apart at the
   * very first page turn — this way a blank sheet is no different from a
   * page: it has the same number, the same ink, the same strip and the same
   * "next".
   */
  page: number
  /**
   * When it started, by the server's clock.
   *
   * The clock on the console must show the LECTURE's time, not the tab's: the
   * tablet gets picked up at minute twenty, and a stopwatch started when it
   * opened would show a cheerful "00:14" in the middle of the class. There is
   * one server for everyone, and its timestamp is the only one everybody
   * agrees on.
   */
  startedAt: number
  /**
   * A black screen.
   *
   * The button everyone lacks: the teacher walks over to the blackboard, and
   * the slide left hanging keeps answering a question that has already been
   * settled. It turns off the PROJECTION, not the console: the presenter
   * still has the page in front of them.
   */
  blank: boolean
  /*
   * WHO HOLDS THE CONSOLE, said so that a person can act on it.
   *
   * `by` alone names a participant, and a participant is a browser: the
   * same teacher opening the room in a second browser is a second
   * participant with the same name. Their screen used to read "the lecture
   * is presented by Ada" about Ada herself, with no way to take it back, and
   * a holder who closed the lid kept the lecture "presented" forever. The
   * fields below are what the room needs to say "you, from the iPad, acted
   * 12 s ago" or "offline for 4 min", and to make the take-over safe.
   *
   * All optional: a lecture started by a test or an older server has none
   * of them, and every reader treats a missing field as "unknown", never as
   * a reason to refuse.
   */
  /** The device the console is held from: what the room names it by. */
  device?: LectureDevice | null
  /**
   * The presenter's staff account as an opaque per-room key, or `null` for
   * someone signed in only by the room's link. A tab compares it with its
   * own (the `role` frame) to tell "you, on another device" from a colleague
   * with the same name. Opaque because the state goes to every student.
   */
  byPerson?: string | null
  /** When these hands took the console: the start, or the last take-over. Server clock. */
  since?: number
  /** When the presenter last did something the hall saw: a page, a stroke, the pointer. */
  actedAt?: number
  /**
   * Since when the presenter has had no open connection to the room, or
   * `null` while they have one. Set after a short grace (`AWAY_GRACE_MS`),
   * so an iPad waking from sleep does not flash "offline" at everyone.
   */
  awaySince?: number | null
  /**
   * The part of the page the hall sees, or `null` / absent for the whole
   * page (see `LectureZoom`). It belongs to `page`: turning the page resets
   * it on the server, so a latecomer never gets one page's zoom applied to
   * another.
   *
   * The state carries the SETTLED value for whoever connects; the live
   * motion of a pinch travels as `lecture:zoom` frames and never as whole
   * `lecture` frames, which every tab reacts to as a change of lecture.
   */
  zoom?: LectureZoom | null
  /**
   * The blank sheets of this lecture, in the order they stand in the deck
   * (see `LectureSheet` and `lectureSequence`). Absent from an older server:
   * read as "no sheets".
   */
  sheets?: LectureSheet[]
}

/* ------------------------------------------------------------- zoom */

/**
 * WHAT PART OF THE PAGE THE HALL SEES: `z` times closer, starting at `x, y`.
 *
 * The zoom happens INSIDE the page's own frame. The frame keeps its size and
 * place on every screen, and what is magnified is the page under it, so the
 * visible region is always `[x, x + 1/z] × [y, y + 1/z]` in page fractions —
 * a rectangle of the page's own proportions. That is the whole point: the
 * console is a 4:3 tablet, the projector 16:9, a student's laptop anything,
 * but each of them fits the PAGE by "contain", and so each of them shows
 * exactly the same region at exactly the same magnification. A rectangle of
 * the console's own proportions would have to be cut or padded somewhere,
 * and the presenter would circle a detail the hall cannot see.
 *
 * Coordinates are page fractions, like ink and the pointer.
 */
export interface LectureZoom {
  /** The left edge of the visible region, in page widths: 0 … 1 − 1/z. */
  x: number
  /** The top edge of the visible region, in page heights: 0 … 1 − 1/z. */
  y: number
  /** How many times closer: 1 … ZOOM_MAX. */
  z: number
}

/**
 * How close the zoom goes.
 *
 * Coordinates travel rounded to 1e-4 of the page. At ×4 one such step is
 * under a pixel on an iPad sheet and about three on a 4K projector filled
 * edge to edge: past that a careful line would show its steps. Four times
 * is also enough for the purpose — a detail of a picture, a subscript in a
 * formula — and it keeps the region re-render on the projector cheap.
 */
export const ZOOM_MAX = 4

/** Below this the zoom is "the whole page": a pinch rarely lands on exactly 1. */
export const ZOOM_MIN_SHOWN = 1.02

/**
 * Read a zoom from the wire or from a gesture: finite numbers, `z` clamped
 * to `[1, ZOOM_MAX]`, the corner clamped so the region stays on the page,
 * rounded like ink. `null` means the whole page, and so does anything below
 * `ZOOM_MIN_SHOWN` or anything that is not a zoom at all.
 *
 * One function for both ends, like `laserSamples`: the server validates a
 * console's frame with it, and every screen reads the same rule.
 */
export function readZoom(raw: unknown): LectureZoom | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { x, y, z } = raw as { x?: unknown; y?: unknown; z?: unknown }
  const zoom = Number(z)
  if (!Number.isFinite(zoom) || zoom < ZOOM_MIN_SHOWN) return null
  /*
   * `z` is rounded BEFORE the room for the corner is measured from it, so a
   * value read once reads the same the second time. The server stores what it
   * read, every screen reads the stored value again, and the console compares
   * the echo with what it sent (`sameZoom`). Measured from the unrounded `z`,
   * a corner clamped at the edge of the page often came back 1e-4 off on the
   * second read, and the console would not recognise its own echo.
   */
  const near = Math.round(Math.min(ZOOM_MAX, zoom) * 1e3) / 1e3
  const room = 1 - 1 / near
  const left = Number(x)
  const top = Number(y)
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null
  return {
    x: Math.round(Math.min(room, Math.max(0, left)) * 1e4) / 1e4,
    y: Math.round(Math.min(room, Math.max(0, top)) * 1e4) / 1e4,
    z: near,
  }
}

/** The same region, as far as anybody could see. `null` and `null` are the same. */
export function sameZoom(a: LectureZoom | null | undefined, b: LectureZoom | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.x === b.x && a.y === b.y && a.z === b.z
}

/* ----------------------------------------------------------- sheets */

/**
 * What a blank sheet is ruled with. Plain paper, squares for a derivation,
 * lines for prose, a dot grid for a diagram.
 */
export const SHEET_PAPERS = ['plain', 'grid', 'lines', 'dots'] as const
export type SheetPaper = (typeof SHEET_PAPERS)[number]

/** A paper from the wire, or `plain` for anything that is not one. */
export function readPaper(raw: unknown): SheetPaper {
  return typeof raw === 'string' && (SHEET_PAPERS as readonly string[]).includes(raw) ? (raw as SheetPaper) : 'plain'
}

/**
 * A blank sheet of the lecture and where it stands.
 *
 * WHY A LIST, AND WHY ON THE SERVER. A sheet used to be nothing but a
 * negative page number the console made up (−1, −2, …), counted back from
 * the ink: "sheet N has strokes, so sheets 1 … N were started". It could not
 * be deleted (its number would come back from the ink of a later one), it
 * could not stand anywhere but after the whole deck, an empty one was known
 * only to the tab that started it, and the 51st landed silently on the 50th.
 * Now the server keeps the sheets, in deck order, and hands out their
 * numbers; a number is never reused within a lecture, so a frame late for a
 * deleted sheet cannot bring it back or write onto another one.
 *
 * `page` stays negative: everything that already treats a negative page as
 * a sheet (ink, the pointer, the projector's white field) keeps working.
 */
export interface LectureSheet {
  /** The sheet's page number: negative, unique in the lecture, never reused. */
  page: number
  /**
   * The slide this sheet follows; 0 puts it before the first slide. Sheets
   * that follow the same slide stand in the order of this list.
   */
  after: number
  /** Plain when absent. */
  paper?: SheetPaper
}

/**
 * Sheets per lecture, at most. They count toward `MAX_INKED_PAGES` too, and
 * fifty is already two per slide of a long lecture; past it the console says
 * so instead of quietly reusing the last sheet.
 */
export const MAX_SHEETS = 50

/**
 * The highest slide number the lecture takes for a slide. Far past any real
 * deck: an hour and a half of lecture is a hundred slides, a scanned
 * textbook a thousand pages.
 *
 * It is a bound on garbage, and the garbage is not harmless, because a slide
 * number is walked as a count. The sequence lists every slide up to the
 * furthest one anything names (`lectureSequence`), the server never learns
 * the deck's length, and a screen that has not opened the deck yet walks up
 * to the furthest slide a sheet follows. A sheet "after slide 1 000 000 000"
 * from a buggy or hostile tab froze every such screen in the hall, and the
 * server, building the same walk to move the hall off that sheet when it was
 * deleted, ran out of memory and took every room of the instance down with
 * it. So the server refuses a slide past this number the way it refuses
 * other garbage (a turn to it does nothing, a sheet after it goes after the
 * page being shown), and no walk is longer than this, whatever a list says.
 */
export const MAX_SLIDES = 10_000

/**
 * Where a sheet stands in the walk: after slide `after`, whole, with 0 for
 * the slot in front of the first slide, and no further than `last`.
 */
function anchorOf(sheet: LectureSheet, last: number): number {
  return Math.min(Math.max(0, Math.floor(sheet.after)), last)
}

/**
 * THE ORDER THE LECTURE IS WALKED IN: slides with their sheets in place.
 *
 * Slide 14, its two sheets, slide 15: "next" on the second sheet is slide
 * 15, "back" on the first is slide 14 — the derivation stands where it was
 * made, not in a pile after the deck. One order for the console, the laptop
 * bar, the strip and the server (which moves the hall off a deleted sheet,
 * see `stepOff`), so that "next" means the same thing everywhere.
 *
 * `pages` is the deck's length; 0 when it is not known yet. A sheet that
 * follows a slide past the end (the document was replaced by a shorter one)
 * stands after the last slide. The walk never goes past `MAX_SLIDES`,
 * whatever `pages` says: a screen without the deck passes a length worked out
 * from the sheets' slides (walk.ts · `walkLength`), and the list comes over
 * the wire.
 */
export function lectureSequence(pages: number, sheets: readonly LectureSheet[] | null | undefined): number[] {
  const list = sheets ?? []
  const last = Math.min(MAX_SLIDES, Math.max(0, Math.floor(pages)))
  const byAnchor = new Map<number, number[]>()
  for (const sheet of list) {
    const anchor = anchorOf(sheet, last)
    const group = byAnchor.get(anchor)
    if (group) group.push(sheet.page)
    else byAnchor.set(anchor, [sheet.page])
  }
  const out: number[] = [...(byAnchor.get(0) ?? [])]
  for (let slide = 1; slide <= last; slide += 1) {
    out.push(slide)
    out.push(...(byAnchor.get(slide) ?? []))
  }
  return out
}

/**
 * The page one step away along the sequence, or `null` at either end.
 *
 * A slide that is not in the sequence (the deck is still loading, so its
 * length is not known) steps by its own number, within 1 … `MAX_SLIDES`: a
 * step past the ceiling would be a turn the server refuses. A sheet that is
 * not in it (deleted a moment ago) has no place to step from: `null`, and
 * the server moves the hall off it by itself.
 */
export function stepIn(sequence: readonly number[], page: number, dir: 1 | -1): number | null {
  const at = sequence.indexOf(page)
  if (at >= 0) {
    const next = sequence[at + dir]
    return next === undefined ? null : next
  }
  if (page > 0) {
    const next = page + dir
    return next >= 1 && next <= MAX_SLIDES ? next : null
  }
  return null
}

/**
 * Where the hall goes when the sheet it is on is deleted, or `null` when the
 * list has no such sheet.
 *
 * One step back along the walk: the sheet before it at the same slide, else
 * that slide. A sheet in front of the first slide has nothing before it, so
 * the hall steps forward instead: to the next sheet in front of the first
 * slide, else to slide 1. That is `stepIn` back (then forward) along
 * `lectureSequence`, read straight off the list.
 *
 * Straight off the list, because the server does not know the deck's length.
 * It used to build the walk up to the furthest slide any sheet follows to take
 * this one step, so the cost was the largest slide number in the list rather
 * than the list, and one absurd number was enough to stop the process (see
 * `MAX_SLIDES`). Here it is two passes over the list at most, and the list
 * is fifty sheets.
 */
export function stepOff(sheets: readonly LectureSheet[] | null | undefined, page: number): number | null {
  const list = sheets ?? []
  const at = list.findIndex((sheet) => sheet.page === page)
  if (at < 0) return null
  // The walk keeps the sheets of one slide in the order of the list.
  const anchor = anchorOf(list[at], MAX_SLIDES)
  for (let i = at - 1; i >= 0; i -= 1) {
    if (anchorOf(list[i], MAX_SLIDES) === anchor) return list[i].page
  }
  if (anchor >= 1) return anchor
  for (let i = at + 1; i < list.length; i += 1) {
    if (anchorOf(list[i], MAX_SLIDES) === 0) return list[i].page
  }
  return 1
}

/** The sheet's place among the sheets, counting from one in deck order; 0 for a slide or an unknown sheet. */
export function sheetNumber(sequence: readonly number[], page: number): number {
  if (page >= 0) return 0
  let n = 0
  for (const p of sequence) {
    if (p < 0) n += 1
    if (p === page) return n
  }
  return 0
}

/**
 * Why a sheet was not added, in words: there are already `MAX_SHEETS`. One
 * copy for both ends, like `inkFullSays`. The number is filled in from the
 * constant, so the words cannot name a different ceiling from the one the
 * server enforces.
 */
export function sheetsFullSays(): string {
  return tr('server.lectureSheetsFull', { p0: MAX_SHEETS })
}

/**
 * What a device is, in words the room can show. Read by the browser from
 * its own user agent (iPadOS Safari introduces itself as a Mac, so the
 * server cannot tell), and taken by the server only from this list.
 */
export const DEVICE_KINDS = [
  'ipad',
  'iphone',
  'android-tablet',
  'android',
  'mac',
  'windows',
  'linux',
  'chromebook',
  'other',
] as const
export type DeviceKind = (typeof DEVICE_KINDS)[number]

/** A device and whether it is the console screen (`/pult`) or the room. */
export interface LectureDevice {
  kind: DeviceKind
  console: boolean
}

/**
 * A device as it came over the wire, or `null` when it is not one. One
 * reader for both ends, so a label a tab sends is never one the other tabs
 * cannot name.
 */
export function readDevice(raw: unknown): LectureDevice | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { kind, console: pult } = raw as { kind?: unknown; console?: unknown }
  if (typeof kind !== 'string' || !(DEVICE_KINDS as readonly string[]).includes(kind)) return null
  return { kind: kind as DeviceKind, console: pult === true }
}

/**
 * How long a presenter may be without a connection before the room is told.
 *
 * An iPad that locks its screen drops its sockets and comes back within a
 * couple of seconds of being woken; "offline" flashing at the whole room on
 * every glance away would teach people to ignore it. Five seconds is past
 * that blink and far short of a closed lid, which the ping notices within a
 * minute anyway.
 */
export const AWAY_GRACE_MS = 5_000

/** One pencil stroke. Points are pairs of fractions: x0,y0,x1,y1… */
export interface InkStroke {
  id: string
  page: number
  color: string
  /** Thickness as a fraction of the page width: it looks the same on the projector and the tablet. */
  width: number
  points: number[]
  /**
   * The id of the first piece when this stroke continues one long motion of
   * the pen.
   *
   * A stroke has a point ceiling (`MAX_POINTS_PER_STROKE`), and a motion
   * longer than that is carried on under a new id from the same point. Without
   * this name the server could not tell the pieces from separate strokes, and
   * one Undo took back only the last piece: half of the line stayed on the
   * projector. Renderers draw a translucent group as one path for the same
   * reason: two marker pieces stroked apart overlap at the joint as a darker
   * blot.
   */
  group?: string
}

/*
 * THE INK LIMITS LIVE HERE, NOT IN THE SERVER'S MEMORY.
 *
 * None of them is about malice — all of them are about a finger forgotten on
 * the screen and a lecture going into its third hour. But whoever draws must
 * know them too: while the numbers lived as a single copy on the server, a
 * refusal at the 601st stroke looked on the console like a lost frame — the
 * layer resent the whole stroke eight times and four seconds later removed it
 * silently, and the presenter saw a line that was drawn and then vanished. To
 * say this in words, the client needs the same numbers as the server, and a
 * copy on each side is exactly the pair that drifts apart first.
 */
/** Strokes on one page. A letter is one to three strokes, a formula derivation a hundred. */
export const MAX_STROKES_PER_PAGE = 600
/** Points in one stroke. A long wavy line across the whole slide reaches it. */
export const MAX_POINTS_PER_STROKE = 4_000
/**
 * How many NUMBERS the server takes from one message; anything beyond is cut
 * off silently.
 *
 * The name dates from the time when a point was one number, and it is left as
 * it is: the server constant goes by it too. Points travel in pairs, so 512
 * is 256 points. A pen the system held back for half a second hands over its
 * samples in a batch, and whoever draws must slice it up themselves.
 */
export const MAX_POINTS_PER_MESSAGE = 512
/**
 * Inked pages per lecture.
 *
 * It was there for the sake of the welcome batch: a latecomer received ALL of
 * the lecture's ink in one frame, and a three-hundred-page handout marked up
 * from cover to cover would have become a megabyte that everyone coming in
 * waits for before the first page. The batch has since been cut down to the
 * page being shown (control.ts), and there is no megabyte in it any more —
 * but the ceiling stayed, and now it is about process memory and the length
 * of the inventory: the lecture's ink lives only there, and the lecture is
 * going into its third hour.
 */
export const MAX_INKED_PAGES = 200

/**
 * How thin and how thick a stroke may be, in page widths. The server clamps
 * every stroke into this range (control.ts · `case 'ink'`).
 *
 * Shared rather than two literals in the server, because the console now has
 * to know the floor as well. Under the zoom a new stroke is sent at the chosen
 * width divided by the magnification, so that it looks as thick on the
 * console as it would at ×1. The thinnest pen at ×4 is 0.000625, just above
 * the floor, and a thinner pen or a deeper zoom would go below it. If only the
 * server knew the floor, it would clamp that stroke quietly and the hall would
 * draw the line thicker than the presenter saw it. With the numbers shared,
 * the console clamps before sending, and both ends draw the same line.
 */
export const INK_WIDTH_MIN = 0.0005
export const INK_WIDTH_MAX = 0.05

/**
 * WHAT COUNTS AS AN INKED PAGE — one rule for both ends.
 *
 * Ink travels in two measures: all of the lecture's writing in one frame
 * (`ink`) and a single page (`ink:page`). What lies outside of what arrived, a
 * tab learns from the INVENTORY (`ink:pages`) — bare page numbers, not a
 * single stroke; from it the console counts the blank sheets that were
 * created, and from it too it decides what it is missing.
 *
 * The server builds the inventory, the tab reads it, and a measure of its own
 * on each side is exactly the pair that drifts apart first: a page whose last
 * stroke was erased, had it stayed in the inventory, would make the console
 * keep an extra sheet in the strip and ask again and again for ink that does
 * not exist. Hence "has at least one stroke" rather than "was once created".
 *
 * Ascending and without repeats: the inventory travels in a frame and is read
 * by a person in the log, and the order of a map's keys is not the order of
 * pages.
 */
export function inkPagesOf(strokes: readonly InkStroke[]): number[] {
  const pages = new Set<number>()
  for (const stroke of strokes) pages.add(stroke.page)
  return [...pages].sort((a, b) => a - b)
}

/**
 * Why the next portion of ink was not accepted. `null` at the caller — it was.
 *
 * The three ceilings above are three different refusals, and they tell a
 * person different things: create a blank sheet, erase pages you do not need,
 * lift the pen. The server used to answer `null` to all three and stay
 * SILENT, and the console could not tell a refusal from a lost frame: it
 * resent the whole stroke eight times and four seconds later removed it from
 * the sheet — the line was drawn and vanished, with not a word about why.
 */
export type InkFull = 'page-full' | 'too-many-pages' | 'stroke-full'

/**
 * What to say out loud. A refusal without words is that very vanished line.
 *
 * One copy for both ends: the console checks the first two ceilings itself
 * and does not open a stroke the hall will never get, while the third ("the
 * stroke has run out of points") and a mismatch after reconnecting are named
 * by the server. Either way the phrase must be the same — otherwise one and
 * the same refusal sounds on the console in two different voices depending
 * on who noticed it first.
 *
 * One copy in the literal sense: the console calls THIS function (pult.ts ·
 * `inkRefusal`, where the type is narrowed with `Extract` from `InkFull`),
 * and the server calls it too, from `case 'ink'`. The console used to have a
 * pair of strings of its own, and they matched these word for word right up
 * to the first change of wording.
 */
export function inkFullSays(why: InkFull): string {
  switch (why) {
    case 'page-full':
      return tr("server.thePageHasReachedItsStrokeLimit.748194")
    case 'too-many-pages':
      return tr("server.theLimitOfAnnotatedPagesHasBeen.8ca2af")
    case 'stroke-full':
      return tr("server.theStrokeLengthLimitHasBeenReached.2f95b5")
  }
}

/**
 * The pointer's tick — ONE number for both ends.
 *
 * The pointer used to travel as "the hand's last position" fifteen times a
 * second, and every viewer filled the gaps with a spring. The hall got a
 * rounded fifteen-sided copy of the presenter's circle: a kink at every wire
 * sample, zigzags flattened, and on release the end of the shape cut off,
 * because the spring had not yet arrived. So a pointer frame now carries
 * EVERY sample gathered since the previous one, each with its time
 * (`LaserSamples`), and the hall plays them back on a timeline instead of
 * guessing the curve: the projector draws the presenter's own line.
 *
 * The tick therefore no longer decides the shape, only the delay: the hall
 * plays the samples a little behind the presenter (`LASER_DELAY_MS`,
 * components/lecture/laser.ts) so that a frame arriving late still lands
 * before it is needed, and that margin is measured in ticks. Forty
 * milliseconds is the ink's own
 * rhythm: as many frames as a line being written costs the room, which is
 * the budget already paid for drawing.
 *
 * The console sends no more often than this (a pen hands over up to two
 * hundred and forty positions a second, and each frame costs a broadcast to
 * every socket in the room); the server's window is derived from the same
 * number (`LASER_HOLD_MS`). The INK tick is deliberately not here: an ink
 * frame carries all points gathered since the last send, and the server has
 * nothing to check it against.
 */
export const LASER_EVERY_MS = 40

/**
 * The server's window for the pointer, a little SHORTER than the console's
 * tick.
 *
 * The window exists against a tab that sends too often (an old one, or
 * someone else's): within it the server glues the batches together and
 * broadcasts them once. If it were as long as the tick, a well-behaved console
 * would hit an open window with every other frame and pick up up to a whole
 * tick of delay that nobody asked for; three quarters of it lets every
 * on-time frame straight through and still caps a runaway client.
 */
export const LASER_HOLD_MS = Math.round(LASER_EVERY_MS * 0.75)

/**
 * Samples in one pointer frame, at most. A pen held back by the system for a
 * quarter of a second hands over sixty samples at once, and the console cuts
 * a longer queue into several frames; the server trims anything beyond.
 */
export const MAX_LASER_SAMPLES = 64

/**
 * Pointer samples as they travel: flat triples `x, y, t`.
 *
 * `x` and `y` are page fractions, like ink. `t` is milliseconds since the
 * press began on the PRESENTER's clock: the hall does not need to know what
 * time it is there, only how far apart the samples were, to replay them at
 * the pace they were drawn.
 */
export type LaserSamples = number[]

/**
 * Read pointer samples from the wire: finite triples, coordinates clamped to
 * the page and rounded like ink, time never running backwards, at most
 * `limit` samples — the NEWEST ones, since where the hand is matters more than
 * where it was.
 *
 * One function for both ends: the server validates a console's frame with
 * it, and the hall reads the same rule it was written by. Anything that is
 * not a triple of numbers is dropped rather than fixed up.
 */
export function laserSamples(raw: unknown, limit = MAX_LASER_SAMPLES): LaserSamples {
  if (!Array.isArray(raw)) return []
  const out: number[] = []
  let last = Number.NEGATIVE_INFINITY
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const x = Number(raw[i])
    const y = Number(raw[i + 1])
    const t = Number(raw[i + 2])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) continue
    const at = Math.max(last, Math.round(t))
    last = at
    out.push(
      Math.round(Math.min(1, Math.max(0, x)) * 1e4) / 1e4,
      Math.round(Math.min(1, Math.max(0, y)) * 1e4) / 1e4,
      at,
    )
  }
  return out.length > limit * 3 ? out.slice(out.length - limit * 3) : out
}

/**
 * Speaker notes for one page — a paragraph, not a chapter.
 *
 * Three thousand characters come not from taste but from the frame ceiling
 * of the control socket: Cyrillic in UTF-8 is two bytes per letter, and six
 * thousand bytes of text together with the path and the wrapping must fit
 * into a frame with room to spare. The server drops a heavier frame SILENTLY,
 * and a page of notes that vanishes without a single word in the middle of a
 * class is the worst thing this wire can do. So there is one ceiling for all
 * ends: the editors stop sending exactly where the server refuses (keeping
 * the text on screen, never cutting it), the database refuses past it too,
 * and every refusal speaks.
 *
 * The frame has since grown to 32 KB, so the number could rise. It stays:
 * a page note is read on the console in half-second glances, and three
 * thousand characters are already about five screens of the console's notes
 * column at its default size. A longer note wants splitting, not room.
 */
export const MAX_NOTE_CHARS = 3000
