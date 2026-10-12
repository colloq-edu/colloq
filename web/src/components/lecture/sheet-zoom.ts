/**
 * The zoom of one sheet: where its view is going, what to render next, and
 * what to hand the ink, decided apart from the canvas that LecturePage
 * draws. Pure state, no DOM and no runes: the page drives it with its own
 * frames and timers, and tests/lecture-hall-zoom.test.mts drives it with a
 * clock of its own.
 *
 * THREE ZOOMS, AND WHY. The target is where the view is going; the motion's
 * `shown` is where it is on the way there, this very frame; the canvas zoom
 * is the zoom the picture now on the canvas was drawn at. A region of a page
 * costs a whole render (on the projector's main thread), far too slow for
 * every frame of a pinch, so between renders the picture is moved by a CSS
 * transform from where it was drawn to where the view is (zoom.ts ·
 * `zoomCss`), and drawn again, sharp, once there is something to draw.
 *
 * The ink gets the same zooms through the same `view`, so a stroke never
 * slides off the formula it circles: both bitmaps move by one transform, and
 * both are redrawn when the new picture LANDS, not when it is asked for. The
 * view's `painted` changes only through `holds`, by design.
 */
import type { LectureZoom } from '@shared/lecture'
import { coversRegion } from './page-region'
import { clampZoom, sameRegion, ZoomMotion, zoomCss, type ZoomHow, type ZoomView } from './zoom'

/**
 * A target that comes within this long of the previous one belongs to a
 * stream: a pinch in motion, sent at the pointer's tick (40 ms) and
 * stretched a little by the network. Chased exponentially, it reads as one
 * motion a tick behind the hand; eased one by one, as a stutter. A target
 * that comes alone is a deliberate jump (the magnifier, "whole slide"), and
 * gets the quarter-second ease the console gave it.
 */
export const STREAM_MS = 150

/**
 * How long a target must stand before its region is drawn ahead of the view
 * (see `drawAhead`). The hall gets a remote pinch as a stream of targets,
 * and a render started for each would be cancelled by the next: ninety
 * milliseconds is two of the pointer's ticks plus some, so a stream keeps
 * postponing it while a single jump starts it almost at once.
 */
export const EARLY_MS = 90

export class SheetZoom {
  readonly motion: ZoomMotion
  /** The page the motion belongs to: a new one starts at its own zoom, without a motion. */
  #page: number
  #paintAt: LectureZoom | null
  /** The page whose picture the canvas holds, `null` for nothing, and the zoom it was drawn at. */
  #canvasPage: number | null = null
  #canvasZoom: LectureZoom | null = null
  /**
   * The canvas holds THIS page, but a picture from before its last reset, at
   * a zoom the page no longer has: the view is held still as if it were
   * another page (see `aim`), until the canvas is reported again (`holds`).
   */
  #outdated = false
  #aimedAt = Number.NEGATIVE_INFINITY
  #view: ZoomView

  constructor(page: number, zoom: LectureZoom | null | undefined) {
    this.motion = new ZoomMotion(zoom)
    this.#page = page
    this.#paintAt = this.motion.painted
    this.#view = { painted: this.#paintAt, shown: this.motion.shown, css: '' }
  }

  /** The page the motion belongs to. */
  get page(): number {
    return this.#page
  }

  /** The zoom the next picture is to be drawn at. A new object only when the region changed. */
  get paintAt(): LectureZoom | null {
    return this.#paintAt
  }

  /** What the picture and everything over it are given. A new object only when something changed. */
  get view(): ZoomView {
    return this.#view
  }

  /**
   * The page or the target changed. `true` when a motion started: the owner
   * runs its frames, and arms the timer that draws ahead (`EARLY_MS`) unless
   * `how` is a jump, whose target moves with every frame of the fingers.
   *
   * A page turn resets everything at once (the server resets the zoom on a
   * turn, and a new page is not "the old one moving"): the next picture is
   * simply drawn at the new page's zoom, and goes up whole. A `glide` target
   * that comes alone is eased (`STREAM_MS`).
   *
   * A TURN AWAY AND BACK before either page rendered (Next, Back on a heavy
   * slide) finds the canvas still holding this very page, at the zoom it had
   * before the turns, ×3 say, while the page now opens at the whole slide.
   * Moved by CSS to the new zoom, that picture is a small patch in a white
   * field, the ink only inside it, for the length of a render. It is treated
   * like the previous page's picture instead: held still, as it was, until
   * the new one lands.
   */
  aim(page: number, zoom: LectureZoom | null | undefined, how: ZoomHow, now: number): boolean {
    const target = clampZoom(zoom)
    if (page !== this.#page) {
      this.#page = page
      this.#aimedAt = Number.NEGATIVE_INFINITY
      this.motion.reset(target)
      this.#repaintAt(this.motion.painted)
      this.#outdated = this.#canvasPage === page && !sameRegion(this.#canvasZoom, this.#paintAt)
      this.#publish()
      return false
    }
    if (sameRegion(target, this.motion.target)) return false
    const alone = now - this.#aimedAt >= STREAM_MS
    this.#aimedAt = now
    this.motion.aim(target, now, how === 'glide' && alone ? 'ease' : how)
    // A jump is already there: shown at once, not at the next step (which
    // reports only the moves it makes itself).
    this.#publish()
    return true
  }

  /** One step of the motion. `true` while there is more to come: a move, or the sharp redraw after it. */
  step(now: number): boolean {
    /*
     * A motion lands EXACTLY on its target (zoom.ts · `ZoomMotion.step`), and
     * two zooms of the same region make no transform (`zoomCss`). Both
     * matter here: an ease once stopped a hair short of its target, and the
     * hair stayed on every bitmap as a sub-pixel `translate` for as long as
     * the view rested (measured in the browser: `translate(-0.003%, 0.003%)`
     * after a pan), blurring the very picture that was just drawn sharp.
     */
    const moved = this.motion.step(now)
    // The view rested (zoom.ts · SETTLE_MS): draw it sharp.
    if (moved.painted) this.#repaintAt(this.motion.painted)
    if (moved.shown || moved.painted) this.#publish()
    return this.motion.busy
  }

  /**
   * A DELIBERATE MOVE IS DRAWN AHEAD (the owner calls this `EARLY_MS` after
   * the last target). A target known before the view gets there is rendered
   * while the view travels, not after it has rested: on a heavy slide that is
   * the difference between a sharp picture at the end of the motion and half
   * a second of a blurry one after it. Zooming out, the new picture may go up
   * at once (`fits`); zooming in, it waits for the view to arrive.
   *
   * The motion is told, too (`painted`): the sharp redraw after a rest comes
   * only when the view rests somewhere other than what the motion thinks is
   * painted. Left at the old zoom, it once took a pinch that returned there
   * (frame a formula, then pinch straight back out to the whole slide, all
   * within the settle) for "nothing to redraw", and the console stayed on
   * the framed region alone, shrunk into a white sheet, with every stroke
   * outside it invisible, until the next zoom or page turn.
   */
  drawAhead(): void {
    if (!this.motion.moving) return
    this.#repaintAt(this.motion.target)
    this.motion.painted = this.#paintAt
  }

  /**
   * Whether a picture drawn at `at` may go up now: it covers the view
   * (page-region.ts · `coversRegion`: the old picture, enlarged, beats a
   * small sharp one in a white field), or it is the view to within what
   * anybody could see. The second half is the tolerance by which a new
   * target counts as no change at all (zoom.ts · `sameRegion`): without it a
   * picture could wait forever for a view that will come no closer.
   */
  fits(at: LectureZoom | null): boolean {
    return coversRegion(at, this.motion.shown) || sameRegion(at, this.motion.shown)
  }

  /** The canvas now holds `page` drawn at `at`, or nothing (`page` null). */
  holds(page: number | null, at: LectureZoom | null): void {
    this.#canvasPage = page
    this.#canvasZoom = at
    // Any report ends the hold, even of the picture already there: the page
    // keeps it when a render fails, and then it must move with the view.
    this.#outdated = false
    this.#publish()
  }

  #repaintAt(at: LectureZoom | null): void {
    if (!sameRegion(at, this.#paintAt)) this.#paintAt = at
  }

  /**
   * The view, from what the canvas actually holds.
   *
   * The motion moves only THIS page's picture. While the canvas still holds
   * the previous page (a turn, the new page rendering), or this page from
   * before a turn away and back (`#outdated`), the view stays exactly where
   * it was: the old slide must not be dragged to the new page's zoom, the
   * ink of the old page with it, for the length of a render. With nothing
   * on the canvas, the ink is drawn at the zoom the picture is about to
   * arrive at, so its arrival repaints nothing.
   */
  #publish(): void {
    const empty = this.#canvasPage === null
    if (!empty && (this.#canvasPage !== this.#page || this.#outdated)) return
    const painted = empty ? this.#paintAt : this.#canvasZoom
    const shown = this.motion.shown
    const css = zoomCss(painted, shown)
    const was = this.#view
    if (css === was.css && sameRegion(painted, was.painted) && sameRegion(shown, was.shown)) return
    this.#view = { painted, shown, css }
  }
}
