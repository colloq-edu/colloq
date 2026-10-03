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
  type LectureDevice,
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
  /** What was done to each page, newest last: what Undo takes back (see `InkAction`). */
  log: Map<number, InkAction[]>
}

/**
 * One thing done to a page's ink, as Undo sees it.
 *
 * Undo used to pop the newest stroke and nothing else, while the gesture is
 * documented as "undo, as in Procreate", that is, the last ACTION. After an
 * eraser sweep that caught the wrong formula the reflex press took away one
 * more stroke in front of the hall, and the erased one could never come back.
 * So the page keeps a short history: a stroke drawn (with its continuation
 * pieces), a sweep of the eraser, a page wiped.
 */
type InkAction =
  | { kind: 'add'; ids: string[] }
  | { kind: 'erase'; gesture: string | null; gone: { stroke: InkStroke; at: number }[] }
  | { kind: 'clear'; gone: InkStroke[] }

/**
 * How many actions a page remembers. Fifty presses of Undo is far beyond
 * what anyone does in a row, and the history is only process memory that a
 * lecture keeps for hours.
 */
const LOG_MAX = 50

function remember(room: Room, page: number, action: InkAction): void {
  const list = room.log.get(page) ?? []
  list.push(action)
  if (list.length > LOG_MAX) list.splice(0, list.length - LOG_MAX)
  room.log.set(page, list)
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
  const now = Date.now()
  const room: Room = {
    state: {
      ...state,
      page: 1,
      blank: false,
      startedAt: now,
      since: now,
      actedAt: now,
      awaySince: null,
    },
    ink: new Map(),
    rev: ++revisions,
    log: new Map(),
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
 * The press is `lecture:take` (control.ts), never a start: `startLecture`
 * sets the room up from scratch, the page goes back to the first, every last
 * bit of ink is erased, the lecture clock starts over. That is, a take-over
 * in the fortieth minute would erase forty minutes of markup, and do it on
 * the projector, in front of everyone.
 *
 * So exactly what "who presents" means is changed: the name, the caption,
 * the pointer color, the device and the presence. The page, the ink, the
 * pause and the start mark are not ours to change: they are about the
 * lecture, not about the hands that present it.
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
  hands: { device?: LectureDevice | null; byPerson?: string | null } = {},
): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room || room.state.file !== file) return null
  const now = Date.now()
  /*
   * The new hands are here and connected: whoever took the console pressed
   * a button a moment ago, so the "offline" of the previous holder must not
   * carry over to them, and "last action" starts at the take.
   */
  room.state = {
    ...room.state,
    by,
    byName,
    color,
    device: hands.device ?? null,
    byPerson: hands.byPerson ?? null,
    since: now,
    actedAt: now,
    awaySince: null,
  }
  return room.state
}

/**
 * The presenter did something the hall saw: note when, and from where.
 *
 * Returns the new state only when the DEVICE changed, which is what has to
 * be broadcast: the time alone travels with the next state anyway, and a
 * pen stroke is twenty-five frames a second, so a broadcast per frame would
 * double the lecture's traffic for a number shown in seconds. The device
 * changes when the same person picks up their other screen (the laptop
 * started, the iPad turns the pages), and then "presented from the Mac"
 * would be a wrong sentence until the next take-over.
 */
export function noteAct(sessionId: string, device: LectureDevice | null): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room) return null
  const before = room.state.device ?? null
  const moved =
    device !== null && (before === null || before.kind !== device.kind || before.console !== device.console)
  room.state = moved
    ? { ...room.state, actedAt: Date.now(), device }
    : { ...room.state, actedAt: Date.now() }
  return moved ? room.state : null
}

/**
 * The presenter lost (or got back) their last connection to the room.
 *
 * `since` is when they went, `null` when they are back. Returns the new
 * state when something changed, for the caller to broadcast. Nothing moves
 * by itself: the lecture stays theirs, and taking it is a person's press
 * (control.ts · `lecture:take`), only no longer one that waits for anybody.
 */
export function markAway(sessionId: string, since: number | null): LectureState | null {
  const room = rooms.get(sessionId)
  if (!room || (room.state.awaySince ?? null) === since) return null
  room.state = { ...room.state, awaySince: since }
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
 * Returns what has to be broadcast: only the NEW points, not the whole stroke,
 * and `from`, where they start in the stroke. A stroke of a thousand points
 * broadcast on every twentieth is gigabytes of traffic per lecture.
 *
 * APPENDS ARE POSITIONAL. A piece says where it starts (`patch.from`: how many
 * numbers the console had handed over before it). The console resends what it
 * has no echo for after half a second, and on a live socket a missing echo
 * almost always means "late", not "lost": TCP delays, it does not drop. Bare
 * appends took the late original and the resend both, and the hall's copy got
 * a straight line back across the slide, up to eight times per stroke. Now
 * what the server already has is cut off, and a piece that starts beyond the
 * end (the frame before it died with a socket) is not glued on with a chord
 * but answered with `need`: "I have this many, send from there". A piece
 * without `from` is an old tab and is appended as before.
 *
 * And it tells the kinds of "no" apart. `null`: nothing to add, no lecture,
 * no page, fewer than two points, or nothing new. `full`: a cap was hit, and
 * that has to be SAID: both used to return `null`, the server stayed silent,
 * and the console resent the whole stroke eight times and four seconds later
 * removed it from the sheet without a single word. Who exactly says it is up
 * to the caller (control.ts · `case 'ink'`).
 */
export type InkAdded =
  | { stroke: InkStroke; from: number; full?: undefined; need?: undefined }
  | { stroke?: undefined; from?: undefined; full: InkFull; need?: undefined }
  | { stroke?: undefined; from?: undefined; full?: undefined; need: number }

export function addInk(
  sessionId: string,
  patch: {
    id: string
    page: number
    color: string
    width: number
    points: number[]
    from?: number
    group?: string
  },
): InkAdded | null {
  const room = rooms.get(sessionId)
  if (!room) return null
  // A blank sheet is a page like any other, only with a negative number.
  const page = Math.trunc(patch.page)
  if (page === 0 || !Number.isFinite(page)) return null
  let points = patch.points.slice(0, MAX_POINTS_PER_MESSAGE).filter(Number.isFinite)
  if (points.length % 2 === 1) points = points.slice(0, -1)
  if (points.length < 2) return null
  // Points travel in pairs, so a position is an even count; anything else is
  // garbage and is read as "no position" rather than guessed at.
  const asked = patch.from
  const even = asked !== undefined && Number.isInteger(asked) && asked >= 0 && asked % 2 === 0
  const from = even ? asked : undefined

  const strokes = room.ink.get(page) ?? []
  const existing = strokes.find((stroke) => stroke.id === patch.id)
  if (existing) {
    const have = existing.points.length
    if (from !== undefined) {
      if (from > have) return { need: have }
      points = points.slice(have - from)
      // All of it was here already: a resend of a late frame, not news.
      if (points.length < 2) return null
    }
    if (have >= MAX_POINTS_PER_STROKE) return { full: 'stroke-full' }
    existing.points.push(...points)
    room.rev = ++revisions
    return { stroke: { ...existing, points }, from: have }
  }
  // The stroke's beginning has not arrived: nothing to append to.
  if (from !== undefined && from > 0) return { need: 0 }
  if (!room.ink.has(page)) {
    if (room.ink.size >= MAX_INKED_PAGES) return { full: 'too-many-pages' }
    room.ink.set(page, strokes)
  }
  if (strokes.length >= MAX_STROKES_PER_PAGE) return { full: 'page-full' }
  const made: InkStroke = {
    id: patch.id,
    page,
    color: patch.color,
    width: patch.width,
    points: [...points],
  }
  if (patch.group && patch.group !== patch.id) made.group = patch.group
  strokes.push(made)
  /*
   * A continuation joins the action of the piece it continues: one motion of
   * the pen is one Undo, however many pieces the point ceiling cut it into.
   */
  const last = room.log.get(page)?.at(-1)
  if (made.group && last?.kind === 'add' && last.ids.includes(made.group)) last.ids.push(made.id)
  else remember(room, page, { kind: 'add', ids: [made.id] })
  room.rev = ++revisions
  return { stroke: made, from: 0 }
}

/**
 * What Undo did: strokes taken away, or the page's strokes after something
 * erased came back.
 *
 * Two different answers because they travel differently: a removal is a
 * `ink:drop` per stroke, and a return is the page whole (`ink:page`), since a
 * stroke must come back at its old place under the others, not on top.
 */
export type InkUndone = { dropped: string[] } | { restored: InkStroke[] }

/**
 * Take back the last ACTION on this page (see `InkAction`): a stroke with all
 * its continuation pieces, a whole eraser sweep, a wiped page.
 *
 * Without a history (older than fifty actions, or strokes from before the
 * history existed) it falls back to what Undo always did: the newest stroke,
 * together with the rest of its motion.
 */
export function undoInk(sessionId: string, page: number): InkUndone | null {
  const room = rooms.get(sessionId)
  if (!room) return null
  const list = room.log.get(page)
  while (list && list.length > 0) {
    const action = list.pop()!
    const strokes = room.ink.get(page) ?? []
    if (action.kind === 'add') {
      const dropped: string[] = []
      for (const id of [...action.ids].reverse()) {
        const at = strokes.findIndex((stroke) => stroke.id === id)
        if (at === -1) continue
        strokes.splice(at, 1)
        dropped.push(id)
      }
      // Its strokes are already gone (erased and that erase taken back by
      // hand is impossible, but a retracted palm is): look further back.
      if (dropped.length === 0) continue
      room.rev = ++revisions
      return { dropped }
    }
    const present = new Set(strokes.map((stroke) => stroke.id))
    if (action.kind === 'erase') {
      // In reverse order of erasing: every index was taken AFTER the ones
      // before it in the sweep were removed, so this puts the page back
      // exactly as it was.
      for (const { stroke, at } of [...action.gone].reverse()) {
        if (present.has(stroke.id)) continue
        strokes.splice(Math.min(at, strokes.length), 0, stroke)
        present.add(stroke.id)
      }
    } else {
      strokes.unshift(...action.gone.filter((stroke) => !present.has(stroke.id)))
    }
    room.ink.set(page, strokes)
    room.rev = ++revisions
    return { restored: [...strokes] }
  }
  const strokes = room.ink.get(page)
  if (!strokes || strokes.length === 0) return null
  const newest = strokes.pop()!
  const dropped = [newest.id]
  const group = newest.group
  while (group && strokes.length > 0) {
    const before = strokes[strokes.length - 1]
    if (before.id !== group && before.group !== group) break
    dropped.push(strokes.pop()!.id)
  }
  room.rev = ++revisions
  return { dropped }
}

/**
 * Erase one stroke: the one the eraser went over.
 *
 * Separate from `undoInk`: undo removes the LAST one, the eraser removes the
 * one it touched, and those are different gestures. Returns whether it was
 * there: broadcasting "erase a stroke that does not exist" means making
 * twenty browsers redraw the page for nothing.
 *
 * `gesture` names one sweep: its strokes form one action in the history, and
 * one Undo brings all of them back. `retract` is the console taking back a
 * stroke it started by mistake (the palm that landed a moment before the
 * pen): that is not an action of the presenter, and it leaves no trace for
 * Undo to bring back.
 */
export function eraseInk(
  sessionId: string,
  page: number,
  id: string,
  how: { gesture?: string; retract?: boolean } = {},
): boolean {
  const room = rooms.get(sessionId)
  const strokes = room?.ink.get(page)
  if (!room || !strokes) return false
  const at = strokes.findIndex((stroke) => stroke.id === id)
  if (at === -1) return false
  const [gone] = strokes.splice(at, 1)
  const list = room.log.get(page) ?? []
  if (how.retract) {
    for (const action of list) {
      if (action.kind === 'add') action.ids = action.ids.filter((known) => known !== id)
    }
    room.log.set(
      page,
      list.filter((action) => action.kind !== 'add' || action.ids.length > 0),
    )
  } else {
    const last = list.at(-1)
    const entry = { stroke: gone, at }
    if (how.gesture && last?.kind === 'erase' && last.gesture === how.gesture) last.gone.push(entry)
    else remember(room, page, { kind: 'erase', gesture: how.gesture ?? null, gone: [entry] })
  }
  room.rev = ++revisions
  return true
}

/**
 * Erase a whole page, or the whole lecture if no page is named.
 *
 * A page wiped by hand goes into its history: "erase page" pressed on the
 * wrong slide is taken back by Undo like any other action. Erasing the whole
 * lecture forgets the histories too: there is nothing left for them to
 * describe.
 */
export function clearInk(sessionId: string, page?: number): void {
  const room = rooms.get(sessionId)
  if (!room) return
  if (page === undefined) {
    room.ink.clear()
    room.log.clear()
  } else {
    const gone = room.ink.get(page) ?? []
    if (gone.length > 0) remember(room, page, { kind: 'clear', gone: [...gone] })
    room.ink.delete(page)
  }
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
