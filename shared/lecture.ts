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
}

/** One pencil stroke. Points are pairs of fractions: x0,y0,x1,y1… */
export interface InkStroke {
  id: string
  page: number
  color: string
  /** Thickness as a fraction of the page width: it looks the same on the projector and the tablet. */
  width: number
  points: number[]
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
 * The pointer's tick — ONE window for both ends.
 *
 * The pointer is not an event but the position of a hand: only the last
 * point matters, and every viewer fills the gap between two sparse samples
 * with a spring on their own side. That is why its frames are cut by a tick
 * on both sides at once: the console sends no more often than that (a pen
 * hands over a hundred and twenty positions a second, and each one cost a
 * round of broadcasting to every socket in the room), and the server holds
 * the point back with the same window and broadcasts the last one — with five
 * hundred listeners, one presenter's hand cost tens of thousands of `ws.send`
 * calls a second.
 *
 * One number for both is not for tidiness. A server that holds the point
 * longer than the console adds to every frame a delay the presenter did not
 * ask for; shorter, and it opens a window with nothing to put in it and pays
 * a full round for every sample. While there were two copies, they had
 * already managed to drift apart in words: the server's explained itself by
 * referring to the INK tick — that is, to a different number.
 *
 * The INK tick is deliberately not here: it lives in the ink layer and does
 * not have to be shared. An ink frame carries ALL the points gathered since
 * the last send, so the tick only affects the delay of the tail, and the
 * server has nothing to check it against.
 */
export const LASER_EVERY_MS = 66

/**
 * Speaker notes for one page — a paragraph, not a chapter.
 *
 * Three thousand characters come not from taste but from the frame ceiling
 * of the control socket: Cyrillic in UTF-8 is two bytes per letter, and six
 * thousand bytes of text together with the path and the wrapping must fit
 * into a frame with room to spare. The server drops a heavier frame SILENTLY,
 * and a page of notes that vanishes without a single word in the middle of a
 * class is the worst thing this wire can do. So there is one ceiling for both
 * ends: the field cuts exactly where the server cuts, and a refusal on it
 * speaks.
 */
export const MAX_NOTE_CHARS = 3000
