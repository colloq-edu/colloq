/**
 * The zoom's arithmetic and its motion: one module for the page, the ink and
 * the console, so that the picture and the ink move as one.
 *
 * WHAT A ZOOM IS lives in shared (`LectureZoom`): the region
 * `[x, x + 1/z] × [y, y + 1/z]` of the page, magnified INSIDE the page's own
 * frame. Every screen fits the page by "contain", so every screen shows the
 * same region. Here are the operations on it — zoom about a point, fit a
 * rectangle, pan — and the conversions between the frame ("box", 0..1 across
 * what is visible) and the page.
 *
 * WHY A MOTION, AND WHY TWO ZOOMS. Re-rendering a PDF region and repainting
 * six hundred strokes is far too slow for every frame of a pinch, and a
 * projector may have a software rasteriser. So each screen keeps two zooms:
 * `painted` — the one its bitmaps (the page and the ink) were last drawn at —
 * and `shown` — the one the hall should see right now. In between, the
 * bitmaps are moved by a CSS transform (`zoomCss`), which costs nothing;
 * once the motion has rested for `SETTLE_MS`, the bitmaps are drawn again,
 * sharp, at the shown zoom, and the transform returns to identity. Both the
 * page and the ink read the same `ZoomView`, so they cannot drift apart.
 *
 * Pure logic, no runes and no DOM: checked without a browser
 * (tests/lecture-zoom.test.mts).
 */
import { readZoom, ZOOM_MAX, type LectureZoom } from '@shared/lecture'

export { ZOOM_MAX }

/** A rectangle in page fractions. */
export interface PageRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * What a page and its ink are given to draw with.
 *
 * `painted` is the zoom the bitmaps are drawn at; `shown` is where the view
 * is right now; `css` moves a bitmap painted at `painted` to look like
 * `shown` (an empty string when they are the same).
 */
export interface ZoomView {
  painted: LectureZoom | null
  shown: LectureZoom | null
  css: string
}

/** The whole page, as a view: nothing to move. */
export const WHOLE: ZoomView = { painted: null, shown: null, css: '' }

const ONE: LectureZoom = { x: 0, y: 0, z: 1 }

function full(zoom: LectureZoom | null | undefined): LectureZoom {
  return zoom ?? ONE
}

/** Clamp and round, as the wire would; `null` for the whole page. */
export function clampZoom(zoom: LectureZoom | null | undefined): LectureZoom | null {
  return readZoom(zoom ?? null)
}

/* ------------------------------------------------------- conversions */

/** A point of the frame (0..1 across what is visible) to a page point. */
export function boxToPage(zoom: LectureZoom | null | undefined, u: number, v: number): { x: number; y: number } {
  const at = full(zoom)
  return { x: at.x + u / at.z, y: at.y + v / at.z }
}

/** A page point to a point of the frame; outside 0..1 when it is not visible. */
export function pageToBox(zoom: LectureZoom | null | undefined, x: number, y: number): { u: number; v: number } {
  const at = full(zoom)
  return { u: (x - at.x) * at.z, v: (y - at.y) * at.z }
}

/** The visible region in page fractions. */
export function visibleRect(zoom: LectureZoom | null | undefined): PageRect {
  const at = full(zoom)
  return { x: at.x, y: at.y, w: 1 / at.z, h: 1 / at.z }
}

/* -------------------------------------------------------- operations */

/**
 * Zoom so that the page point under the frame point `(u, v)` stays under it,
 * and the magnification becomes `z`. This is what a pinch does: the place
 * between the fingers does not slide away while the fingers spread.
 */
export function zoomAround(
  zoom: LectureZoom | null | undefined,
  u: number,
  v: number,
  z: number,
): LectureZoom | null {
  const at = full(zoom)
  const near = Math.min(ZOOM_MAX, Math.max(1, z))
  const px = at.x + u / at.z
  const py = at.y + v / at.z
  return clampZoom({ x: px - u / near, y: py - v / near, z: near })
}

/**
 * Move the view by a distance measured in the frame (fractions of what is
 * visible): fingers that moved right by a tenth of the sheet bring in what
 * was a tenth to the left.
 */
export function panZoom(zoom: LectureZoom | null | undefined, du: number, dv: number): LectureZoom | null {
  const at = full(zoom)
  if (at.z <= 1) return null
  return clampZoom({ x: at.x - du / at.z, y: at.y - dv / at.z, z: at.z })
}

/**
 * The zoom that shows a page rectangle as large as possible: the rectangle
 * drawn with the magnifier. It is centred, and its longer side (in the page's
 * own proportions) fills the frame; a rectangle too small to matter gives
 * the closest zoom around its centre.
 */
export function zoomToRect(rect: PageRect): LectureZoom | null {
  const w = Math.max(1e-6, Math.abs(rect.w))
  const h = Math.max(1e-6, Math.abs(rect.h))
  const left = Math.min(rect.x, rect.x + rect.w)
  const top = Math.min(rect.y, rect.y + rect.h)
  const z = Math.min(ZOOM_MAX, Math.max(1, 1 / Math.max(w, h)))
  const cx = left + w / 2
  const cy = top + h / 2
  return clampZoom({ x: cx - 0.5 / z, y: cy - 0.5 / z, z })
}

/** Twice as close around a page point: a tap with the magnifier. */
export function zoomStep(zoom: LectureZoom | null | undefined, x: number, y: number, factor = 2): LectureZoom | null {
  const at = full(zoom)
  const z = Math.min(ZOOM_MAX, Math.max(1, at.z * factor))
  return clampZoom({ x: x - 0.5 / z, y: y - 0.5 / z, z })
}

/* -------------------------------------------------------------- css */

/**
 * The CSS transform that makes a bitmap painted at `painted` look like
 * `shown`, for an element of the frame's size with `transform-origin: 0 0`.
 *
 * A page point p is drawn at box coordinate `(p − painted.xy) · painted.z`
 * and must appear at `(p − shown.xy) · shown.z`, so the bitmap is scaled by
 * `s = shown.z / painted.z` and shifted by `(painted.xy − shown.xy) · shown.z`
 * of the frame. Percentages of the element's own size, so the same string
 * works for every screen.
 */
export function zoomCss(painted: LectureZoom | null | undefined, shown: LectureZoom | null | undefined): string {
  /*
   * Two zooms of the same region (`sameRegion`) need no transform, however
   * they differ in the last digits. A canvas moved by a fraction of a pixel
   * is resampled, and the resampling blurs the very picture that was just
   * drawn sharp. A region a hair off, drawn sharp, is the better of the two.
   */
  if (sameRegion(painted, shown)) return ''
  const from = full(painted)
  const to = full(shown)
  const s = to.z / from.z
  const tx = (from.x - to.x) * to.z
  const ty = (from.y - to.y) * to.z
  const pct = (n: number) => `${Math.round(n * 1e6) / 1e4}%`
  return `translate(${pct(tx)}, ${pct(ty)}) scale(${Math.round(s * 1e5) / 1e5})`
}

/* ----------------------------------------------------------- motion */

/**
 * How long a jump of the view takes: the magnifier's rectangle, "whole
 * slide", a key. A quarter of a second with an ease-out reads as "the camera
 * moved there" in the hall, and is short enough that the presenter never
 * waits for it before writing.
 */
export const EASE_MS = 240

/**
 * How quickly the shown zoom glides after a target that keeps moving (the
 * frames of someone else's pinch, 25 a second): the time constant of the
 * exponential. Fifty turns the steps into one motion about a tick behind.
 */
export const FOLLOW_MS = 50

/** How long the view must rest before the bitmaps are redrawn sharp. */
export const SETTLE_MS = 120

/**
 * Closer than this a glide just arrives: a five-hundredth of what the frame
 * shows, a few pixels of a big projector, invisible in the last frame of a
 * motion. Without it the exponential would creep for half a second over
 * distances nobody can see, and keep the sharp redraw waiting.
 *
 * Of the FRAME, not of the page (`step` multiplies the centre's distance by
 * the magnification). A five-hundredth of the page is four times as many
 * pixels at ×4: the hall saw every pan and pinch at high zoom end with a
 * jump of 18 px on a 1920-px projector, after steps of 13, 9.5 and 6.9 px
 * that were settling smoothly. The magnification itself is compared in log
 * scale, which is a fraction of the frame already.
 */
const ARRIVE = 0.002

/** Two zooms closer than this show the same region, as far as anybody could see. */
const EPSILON = 1e-4

/** The point of the page at the centre of the frame, and the magnification in log scale. */
function centreOf(zoom: LectureZoom | null | undefined): { cx: number; cy: number; lz: number } {
  const at = full(zoom)
  return { cx: at.x + 0.5 / at.z, cy: at.y + 0.5 / at.z, lz: Math.log(at.z) }
}

/**
 * A zoom from a centre and a log-magnification, clamped to the page but NOT
 * rounded: the view in motion is drawn, never sent, and rounding each frame
 * would stall a glide a rounding step short of where it is going.
 */
function fromCentre(cx: number, cy: number, lz: number): LectureZoom | null {
  const z = Math.min(ZOOM_MAX, Math.max(1, Math.exp(lz)))
  if (z < 1 + EPSILON) return null
  const room = 1 - 1 / z
  return {
    x: Math.min(room, Math.max(0, cx - 0.5 / z)),
    y: Math.min(room, Math.max(0, cy - 0.5 / z)),
    z,
  }
}

function between(
  a: { cx: number; cy: number; lz: number },
  b: { cx: number; cy: number; lz: number },
  k: number,
): LectureZoom | null {
  return fromCentre(a.cx + (b.cx - a.cx) * k, a.cy + (b.cy - a.cy) * k, a.lz + (b.lz - a.lz) * k)
}

/** How a new target is reached. */
export type ZoomHow = 'jump' | 'ease' | 'glide'

/**
 * The shown zoom moving toward a target, and the zoom the bitmaps are
 * painted at. The owner calls `aim` when the target changes and `step` on
 * every animation frame (or on a timer: a projector window that is not being
 * painted gets no animation frames, and must still arrive), and redraws its
 * bitmaps when `step` reports that `painted` changed.
 *
 * Three ways to reach a target: `jump` (a finger is moving the view, and any
 * lag would feel like dragging through syrup), `ease` (a deliberate jump —
 * the magnifier, "whole slide" — over `EASE_MS`), `glide` (a target that
 * keeps moving, chased exponentially).
 *
 * Interpolation is of the centre and of the logarithm of the magnification:
 * zooming from ×1 to ×4 then passes ×2 halfway, as the eye expects, instead
 * of rushing through the first doubling.
 */
export class ZoomMotion {
  target: LectureZoom | null = null
  shown: LectureZoom | null = null
  /**
   * The zoom the bitmaps are drawn at, or are being drawn at. `step` moves it
   * to the view once the view has rested; an owner that draws a target
   * ahead of the view moves it there itself (sheet-zoom.ts · `drawAhead`),
   * so that the rest is compared with the picture actually on its way.
   */
  painted: LectureZoom | null = null
  /** When the shown zoom last changed; the bitmaps follow `SETTLE_MS` later. */
  #movedAt = 0
  #lastStep = 0
  #ease: { from: ReturnType<typeof centreOf>; to: ReturnType<typeof centreOf>; start: number } | null = null

  constructor(start: LectureZoom | null = null) {
    this.reset(start)
  }

  /** A new target, reached as `how` says. The bitmaps are redrawn only once the view has rested. */
  aim(target: LectureZoom | null | undefined, now: number, how: ZoomHow = 'glide'): void {
    this.target = clampZoom(target)
    this.#lastStep = now
    if (how === 'jump') {
      this.#ease = null
      this.shown = this.target
      this.#movedAt = now
    } else if (how === 'ease') {
      this.#ease = sameRegion(this.shown, this.target)
        ? null
        : { from: centreOf(this.shown), to: centreOf(this.target), start: now }
    } else {
      this.#ease = null
    }
  }

  /** The whole thing at once, bitmaps included: a page turn or a fresh mount. */
  reset(zoom: LectureZoom | null | undefined): void {
    this.target = clampZoom(zoom)
    this.shown = this.target
    this.painted = this.target
    this.#ease = null
  }

  /**
   * Whether the shown zoom still has somewhere to go. An ease counts until
   * its last frame: its final stretch is within a hair of the target
   * (`sameRegion`), and a motion that stopped there would rest a hair short
   * of it for good.
   */
  get moving(): boolean {
    return this.#ease !== null || !sameRegion(this.shown, this.target)
  }

  /** Whether the bitmaps lag behind the view. */
  get stale(): boolean {
    return !sameRegion(this.painted, this.shown)
  }

  /** Whether anything is still due: a motion, or the sharp redraw after it. */
  get busy(): boolean {
    return this.moving || this.stale
  }

  /**
   * Advance to `now`. Returns what changed, so the owner knows whether to
   * move the bitmaps (`shown`) or draw them again (`painted`).
   */
  step(now: number): { shown: boolean; painted: boolean } {
    let shownChanged = false
    let paintedChanged = false
    const dt = Math.max(0, Math.min(250, now - (this.#lastStep || now)))
    this.#lastStep = now
    if (this.moving) {
      const ease = this.#ease
      if (ease) {
        const t = Math.min(1, (now - ease.start) / EASE_MS)
        const k = 1 - (1 - t) ** 3
        this.shown = t >= 1 ? this.target : between(ease.from, ease.to, k)
        if (t >= 1) this.#ease = null
      } else {
        const from = centreOf(this.shown)
        const to = centreOf(this.target)
        const k = 1 - Math.exp(-dt / FOLLOW_MS)
        const next = { cx: from.cx + (to.cx - from.cx) * k, cy: from.cy + (to.cy - from.cy) * k, lz: from.lz + (to.lz - from.lz) * k }
        // The distance left, in frames of the closer of the two views (ARRIVE).
        const z = Math.exp(Math.max(to.lz, next.lz))
        const arrived =
          Math.abs(to.cx - next.cx) * z < ARRIVE &&
          Math.abs(to.cy - next.cy) * z < ARRIVE &&
          Math.abs(to.lz - next.lz) < ARRIVE
        this.shown = arrived ? this.target : fromCentre(next.cx, next.cy, next.lz)
      }
      this.#movedAt = now
      shownChanged = true
    } else if (this.shown !== this.target) {
      /*
       * Within a hair of the target but not on it: a new target that differs
       * from the view by less than `sameRegion` sees (a rounding step on the
       * wire). The view lands exactly on it, so that a resting view is the
       * target itself, and whatever compares the two finds them equal.
       */
      this.shown = this.target
      shownChanged = true
    }
    if (!this.moving && this.stale && now - this.#movedAt >= SETTLE_MS) {
      this.painted = this.shown
      paintedChanged = true
    }
    return { shown: shownChanged, painted: paintedChanged }
  }

  /** What the page and the ink are given. */
  view(): ZoomView {
    return { painted: this.painted, shown: this.shown, css: zoomCss(this.painted, this.shown) }
  }
}

/** Two zooms showing the same region to within a hundredth of a percent of the page. */
export function sameRegion(a: LectureZoom | null | undefined, b: LectureZoom | null | undefined): boolean {
  const p = full(a)
  const q = full(b)
  return Math.abs(p.x - q.x) < EPSILON && Math.abs(p.y - q.y) < EPSILON && Math.abs(p.z - q.z) < EPSILON
}
