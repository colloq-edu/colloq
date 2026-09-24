/**
 * A room's lecture state. The vocabulary is in shared/lecture.ts; this is
 * only the memory.
 *
 * In process memory, next to the shared screen and the run queue, not in the
 * room's document: a lecture is an hour of the room's life, not its content.
 * A pencil stroke that landed in the shared document would become a version
 * in the history, travel into the snapshot and come back on Ctrl+Z: three
 * ways to spoil what the lecture is given for. The price is stated out loud:
 * a server restart turns off the projection and erases the ink, just as it
 * turns off the shared screen and the queue.
 */
import {
  MAX_INKED_PAGES,
  MAX_POINTS_PER_MESSAGE,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_PAGE,
  type InkFull,
  type InkStroke,
  type LectureState,
} from '@shared/lecture'

interface Room {
  state: LectureState
  /** Strokes by page. A page without ink gets no entry in the map. */
  ink: Map<number, InkStroke[]>
  /**
   * The number of the last change to the ink, process-wide rather than per
   * room.
   *
   * The welcome batch carries the page being shown to a latecomer, and it is
   * assembled by `inkPageOf` + `JSON.stringify`. While the audience connects
   * one by one the cost goes unnoticed; after a network failure five hundred
   * tabs come back within one second, and all of them look at the same page,
   * the one the presenter shows, so five hundred identical assemblies land in
   * the event loop where one would do. control.ts caches the frame by the pair
   * "this number + page"; a global counter (rather than a "room version") is
   * needed so that a restarted lecture does not match the previous one's
   * number.
   */
  rev: number
}

const rooms = new Map<string, Room>()

let revisions = 0

/*
 * The ink caps live in shared/lecture.ts, all four of them, with the same
 * numbers.
 *
 * That is not a move for tidiness: whoever draws has to know them too. While
 * their only copy stood here, the console could not tell a refusal from a
 * lost frame: it resent the whole stroke eight times and four seconds later
 * silently removed it from the sheet, while the audience never had the line
 * at all.
 */

export function lectureOf(sessionId: string): LectureState | null {
  return rooms.get(sessionId)?.state ?? null
}

/** All of the room's ink, whole, every page at once. */
export function inkOf(sessionId: string): InkStroke[] {
  const room = rooms.get(sessionId)
  if (!room) return []
  return [...room.ink.values()].flat()
}

/**
 * The ink of ONE page, for whoever is looking at it.
 *
 * The measure of the welcome batch and of the answer to a tab's question
 * (`ink:page`): a lecture has up to two hundred pages, while one is looked at
 * at any moment, and shipping all of them is about a megabyte per socket
 * where kilobytes are needed. Whoever came in on a different page or opened
 * the thumbnail strip asks for the missing ones themselves.
 *
 * A copy of the list, not the room's memory itself: it goes out in a frame,
 * and a pen that adds a point at the same instant must not change what has
 * already been handed out.
 */
export function inkPageOf(sessionId: string, page: number): InkStroke[] {
  const strokes = rooms.get(sessionId)?.ink.get(Math.trunc(page))
  return strokes ? [...strokes] : []
}

/**
 * An INVENTORY of the inked pages: their numbers, without a single stroke.
 *
 * It travels next to every full ink frame and costs tens of bytes where the
 * ink itself costs a megabyte. Without it a tab that received one page cannot
 * tell "the others are empty" from "the others have not arrived": the console
 * counts from the ink how many blank sheets have been created, and the
 * thumbnail strip uses the same to know what to ask for.
 *
 * The rule is the same on both ends, "has at least one stroke"
 * (shared/lecture.ts · `inkPagesOf`, which also computes the inventory in the
 * tab). The map keys alone are no measure: a page is created for its first
 * stroke, and the eraser that removes the last one leaves the key, and such a
 * page, left in the inventory, would make the console keep an extra sheet and
 * ask again and again for ink that does not exist. Hence
 * `strokes.length > 0`, not `[...room.ink.keys()]`.
 *
 * In ascending order: the inventory is read by a person in the log, and the
 * order of the map keys is the order of first strokes, not of pages.
 */
export function inkedPagesOf(sessionId: string): number[] {
  const room = rooms.get(sessionId)
  if (!room) return []
  const pages: number[] = []
  for (const [page, strokes] of room.ink) if (strokes.length > 0) pages.push(page)
  return pages.sort((a, b) => a - b)
}

/**
 * The number of the last change to the ink. When it changes, the previous
 * frame is stale.
 *
 * Zero means there is no ink at all (no lecture): nothing to cache.
 */
export function inkRevision(sessionId: string): number {
  return rooms.get(sessionId)?.rev ?? 0
}

export function startLecture(
  sessionId: string,
  state: Omit<LectureState, 'page' | 'blank' | 'startedAt'>,
): LectureState {
  const room: Room = {
    state: { ...state, page: 1, blank: false, startedAt: Date.now() },
    ink: new Map(),
    rev: ++revisions,
  }
  rooms.set(sessionId, room)
  return room.state
}

/** The lecture is over: the projection goes off and the ink is erased. */
export function stopLecture(sessionId: string): void {
  rooms.delete(sessionId)
}

/**
 * Whether this person is presenting the lecture.
 *
 * A fact, not a right: the right is checked separately (the `board` rule);
 * this is about the page being moved by THE ONE who presents it, otherwise
 * two teachers in one room would keep turning each other's pages.
 */
export function isPresenter(sessionId: string, participantId: string): boolean {
  return rooms.get(sessionId)?.state.by === participantId
}

/**
 * Hand the console over to another teacher WITHOUT restarting the lecture.
 *
 * The second presenter takes control with the same `lecture:start` on the
 * same file; they have no other message. Without this branch such a press
 * would go to `startLecture`, which sets the room up from scratch: the page
 * goes back to the first, every last bit of ink is erased, the lecture clock
 * starts over. That is, pressing "take the console" in the fortieth minute
 * would erase forty minutes of markup, and do it on the projector, in front
 * of everyone.
 *
 * So exactly what "who presents" means is changed: the name, the caption and
 * the pointer color. The page, the ink, the pause and the start mark are not
 * ours to change: they are about the lecture, not about the hands that
 * present it.
 *
 * On THE SAME file: another document is another lecture, and it has to start
 * clean. Returns the new state, or `null` if there is nothing to hand over,
 * like the other state changes in this file.
 */
export function handOver(
  sessionId: string,
  file: string,
  by: string,
  byName: string,
  color: string,
): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room || room.state.file !== file) return null
  room.state = { ...room.state, by, byName, color }
  return room.state
}

/**
 * How many blank sheets may be created.
 *
 * Their numbers are negative and they are created by a press, so their count
 * is how many times the teacher pressed the button. The cap is not about
 * malice but about a stuck button: pages with ink are kept in memory, and the
 * memory they take has to be finite.
 */
const MAX_BOARDS = 50

export function turnTo(sessionId: string, page: number): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room) return null
  // Zero is not a page: it is garbage from a tab. A negative number is a blank sheet (see the vocabulary).
  const asked = Math.trunc(page)
  if (asked === 0 || !Number.isFinite(asked)) return null
  const wanted = asked < 0 ? Math.max(-MAX_BOARDS, asked) : asked
  if (room.state.page === wanted) return null
  room.state = { ...room.state, page: wanted }
  return room.state
}

export function setBlank(sessionId: string, blank: boolean): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room || room.state.blank === blank) return null
  room.state = { ...room.state, blank }
  return room.state
}

/**
 * Append to a stroke.
 *
 * Points arrive in batches as the drawing goes, not as a whole stroke at the
 * end: the audience has to see the line while it is being drawn, otherwise
 * the pointer on the slide appears a second after it was mentioned out loud.
 *
 * Returns what has to be broadcast: only the NEW points, not the whole stroke.
 * A stroke of a thousand points broadcast on every twentieth is gigabytes of
 * traffic per lecture.
 *
 * And it tells two kinds of "no" apart. `null`: nothing to add, no lecture,
 * no page, fewer than two points. `full`: a cap was hit, and that has to be
 * SAID: both cases used to return `null`, the server stayed silent, and the
 * console resent the whole stroke eight times and four seconds later removed
 * it from the sheet without a single word. Who exactly says it is up to the
 * caller (control.ts · `case 'ink'`).
 */
export type InkAdded =
  | { stroke: InkStroke; full?: undefined }
  | { stroke?: undefined; full: InkFull }

export function addInk(
  sessionId: string,
  patch: { id: string; page: number; color: string; width: number; points: number[] },
): InkAdded | null {
  const room = rooms.get(sessionId)
  if (!room) return null
  // A blank sheet is a page like any other, only with a negative number.
  const page = Math.trunc(patch.page)
  if (page === 0 || !Number.isFinite(page)) return null
  const points = patch.points.slice(0, MAX_POINTS_PER_MESSAGE).filter(Number.isFinite)
  if (points.length < 2) return null

  const strokes = room.ink.get(page) ?? []
  if (!room.ink.has(page)) {
    if (room.ink.size >= MAX_INKED_PAGES) return { full: 'too-many-pages' }
    room.ink.set(page, strokes)
  }

  const existing = strokes.find((stroke) => stroke.id === patch.id)
  if (existing) {
    if (existing.points.length >= MAX_POINTS_PER_STROKE) return { full: 'stroke-full' }
    existing.points.push(...points)
    room.rev = ++revisions
    return { stroke: { ...existing, points } }
  }
  if (strokes.length >= MAX_STROKES_PER_PAGE) return { full: 'page-full' }
  const made: InkStroke = {
    id: patch.id,
    page,
    color: patch.color,
    width: patch.width,
    points: [...points],
  }
  strokes.push(made)
  room.rev = ++revisions
  return { stroke: made }
}

/** Remove the last stroke on this page. Returns its name if there was something to remove. */
export function undoInk(sessionId: string, page: number): string | null {
  const room = rooms.get(sessionId)
  const strokes = room?.ink.get(page)
  if (!room || !strokes || strokes.length === 0) return null
  room.rev = ++revisions
  return strokes.pop()?.id ?? null
}

/**
 * Erase one stroke: the one the eraser went over.
 *
 * Separate from `undoInk`: undo removes the LAST one, the eraser removes the
 * one it touched, and those are different gestures. Returns whether it was
 * there: broadcasting "erase a stroke that does not exist" means making
 * twenty browsers redraw the page for nothing.
 */
export function eraseInk(sessionId: string, page: number, id: string): boolean {
  const room = rooms.get(sessionId)
  const strokes = room?.ink.get(page)
  if (!room || !strokes) return false
  const at = strokes.findIndex((stroke) => stroke.id === id)
  if (at === -1) return false
  strokes.splice(at, 1)
  room.rev = ++revisions
  return true
}

/** Erase a whole page, or the whole lecture if no page is named. */
export function clearInk(sessionId: string, page?: number): void {
  const room = rooms.get(sessionId)
  if (!room) return
  if (page === undefined) room.ink.clear()
  else room.ink.delete(page)
  room.rev = ++revisions
}

/**
 * The lecture's file has moved.
 *
 * A rename is business as usual: the teacher edits the name in the tree while
 * the lecture goes on. Without this line the projection would keep showing a
 * path that no longer exists on disk, that is, it would go dark for everyone
 * except those who already have the document open.
 */
export function moveLecture(sessionId: string, from: string, to: string): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room || room.state.file !== from) return null
  room.state = { ...room.state, file: to }
  return room.state
}

/** The room was deleted or the process is stopping. */
export function forgetLecture(sessionId: string): void {
  rooms.delete(sessionId)
}
