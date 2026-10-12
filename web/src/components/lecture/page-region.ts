/**
 * The page's own pixels under a zoom: which part of a PDF page is rendered
 * into the sheet's canvas, how a blank sheet's paper is ruled, when a
 * picture drawn for one view can stand in for another, and whether the
 * picture is light or dark under the highlighter.
 *
 * WHY A REGION, NOT A BIGGER PAGE. Rendering the whole page `z` times larger
 * and showing a piece of it is the obvious way, and it does not survive the
 * projector: a 4K sheet at ×3 is some seventy megapixels, past WebKit's
 * canvas limits and far past the iPad's canvas budget, where an overflow
 * turns canvases transparent. pdf.js can draw any region instead: the
 * viewport of the WHOLE page at the zoomed scale, shifted so the region's
 * corner lands on the canvas origin, into a canvas the size of the frame.
 * The bitmap is never bigger than the frame, so memory does not grow with
 * the zoom, and text and formulas are rasterised sharp at the new scale, up
 * to the scale pdf.js can afford (`REGION_BUDGET`).
 *
 * Pure arithmetic, no DOM: LecturePage draws with it, and
 * tests/lecture-hall-zoom.test.mts checks it against pdf.js's own viewport.
 */
import type { DeviceKind, LectureZoom, SheetPaper } from '@shared/lecture'

/* ----------------------------------------------------------- region */

/**
 * How many device pixels the WHOLE page may span at the scale a region is
 * rendered at. Past it the region is rendered at a lower scale, into a
 * smaller bitmap, and the browser stretches that over the frame: a little
 * soft at the closest zooms, but whole.
 *
 * WHY THE WHOLE PAGE, when only the frame is drawn into. Not everything
 * pdf.js draws is clipped to the canvas. An image mask (`/ImageMask`: the
 * text layer of a compressed scan, a one-bit figure) is first painted into
 * a scratch canvas the size of the whole mask at the render's scale (pdf.js
 * 6 · `_createMaskCanvas`, never intersected with the canvas, unlike a
 * group). A page-wide mask at ×4 on the iPad console is 8672 × 4880, 42
 * megapixels and 170 MB. iPadOS 17 and older give a canvas past 4096² no
 * backing store at all, and the slide's text silently vanishes at every
 * zoom past ×2.5; a newer iPad draws it, out of the same per-process canvas
 * memory whose overflow turns other canvases transparent, the ink's
 * included.
 *
 * Sixteen megapixels on a phone or a tablet: under 4096², 64 MB at most for
 * that scratch canvas. A computer has the memory, and canvas caps past a
 * hundred megapixels, and it is usually the projector, where sharpness shows
 * most: sixty-four there keeps a 1080p projector sharp all the way to ×4,
 * and bounds the scratch canvas at 256 MB on a 4K one.
 */
export const REGION_BUDGET = { touch: 16_000_000, desktop: 64_000_000 } as const

/**
 * The budget of a device (lib/device.ts · `deviceKind`): a computer gets the
 * large one, and everything else, a device nobody could name included, the
 * small one.
 */
export function regionBudget(kind: DeviceKind): number {
  const computer = kind === 'mac' || kind === 'windows' || kind === 'linux' || kind === 'chromebook'
  return computer ? REGION_BUDGET.desktop : REGION_BUDGET.touch
}

/** What `PDFPageProxy.getViewport` is asked for, and the canvas it draws into. */
export interface RegionViewport {
  /** The scale of the WHOLE page at this zoom: device px per PDF unit. */
  scale: number
  /**
   * The shift that brings the region's top-left corner to the canvas origin,
   * in device px (pdf.js adds it after its own transform, so it is the same
   * for a rotated page: it is measured on the canvas, not on the page).
   */
  offsetX: number
  offsetY: number
  /**
   * The canvas, in device px: the frame's size whatever the zoom, unless the
   * budget lowered the scale; then smaller by as much, in the frame's
   * proportions, and stretched over the frame by its CSS size.
   */
  width: number
  height: number
}

/**
 * The viewport that draws the visible region of a page into a canvas the
 * size of the frame, or a smaller one where the frame's full sharpness
 * would cost more than `budget` (`REGION_BUDGET`).
 *
 * `base` is the page's viewport at scale 1 (its size in PDF units, rotation
 * applied), `w` the frame's width in CSS px, `ratio` the device pixel ratio
 * used for the canvas. At the whole page (`zoom` null) this is exactly the
 * render the sheet always did, whatever the budget: scale
 * `w / base.width · ratio`, no offsets. A zoom is never rendered coarser
 * than that.
 */
export function regionViewport(
  base: { width: number; height: number },
  w: number,
  zoom: LectureZoom | null | undefined,
  ratio: number,
  budget: number = REGION_BUDGET.touch,
): RegionViewport {
  const z = zoom?.z ?? 1
  const x = zoom?.x ?? 0
  const y = zoom?.y ?? 0
  const fitted = (w / base.width) * ratio
  const scale = Math.max(
    fitted,
    Math.min(fitted * z, Math.sqrt(budget / (base.width * base.height))),
  )
  // Exactly 1 within the budget: the frame's own size, as before the cap.
  const shrink = scale / (fitted * z)
  return {
    scale,
    // The whole page is `base · scale` device px now; the region starts x and
    // y of the way across it.
    offsetX: -x * base.width * scale,
    offsetY: -y * base.height * scale,
    width: Math.round(base.width * fitted * shrink),
    height: Math.round(base.height * fitted * shrink),
  }
}

/**
 * Whether a picture drawn for the region of `painted` covers the whole
 * region of `shown`: moved and scaled by CSS to the shown view, it then fills
 * the frame with no empty margin.
 *
 * This is what decides when a fresh render may go on screen in the middle of
 * a motion. Zooming OUT, the target region contains every view on the way to
 * it (the centre moves linearly and the half-size geometrically, which never
 * leaves the hull of the two), so the target's picture goes up at once,
 * soft for the rest of the motion but whole. Zooming IN, it covers nothing
 * until the motion arrives, and the old picture, enlarged, is the better one
 * until then.
 *
 * `slack` is in page fractions, and small on purpose: a picture that falls
 * short of the view by 1e-3 of the page leaves a white sliver eight pixels
 * wide down each side of a projector at ×4, for the last frames of every
 * zoom-in. 1e-4 is under a pixel there, and above the noise of the arithmetic.
 */
export function coversRegion(
  painted: LectureZoom | null | undefined,
  shown: LectureZoom | null | undefined,
  slack = 1e-4,
): boolean {
  const a = painted ?? WHOLE_PAGE
  const b = shown ?? WHOLE_PAGE
  return (
    a.x <= b.x + slack &&
    a.y <= b.y + slack &&
    a.x + 1 / a.z >= b.x + 1 / b.z - slack &&
    a.y + 1 / a.z >= b.y + 1 / b.z - slack
  )
}

const WHOLE_PAGE: LectureZoom = { x: 0, y: 0, z: 1 }

/* ------------------------------------------------------------ paper */

/**
 * Squares across the page's width, for both the grid and the dot grid. A
 * 16:9 slide gets 32 × 18 squares, a cell the size of a written digit on
 * the projector; a 4:3 one 32 × 24.
 */
export const PAPER_SQUARES = 32
/** Rules down the page's height on lined paper: a line of handwriting each. */
export const PAPER_RULES = 24
/** Where lined paper's margin stands, in page widths from the left edge. */
export const PAPER_MARGIN = 1 / 12

/**
 * The paper itself: the colour of a blank sheet under its rules, a little
 * darker than a slide's white (LecturePage explains why).
 */
export const PAPER_GROUND = '#F4F6FA'
/** What lies under a slide's picture: pdf.js paints the page opaque over it anyway. */
export const SLIDE_GROUND = '#FFFFFF'

/**
 * The colour and weight of the rules, at ×1, in device px.
 *
 * A light blue-grey on the sheet's #F4F6FA: quiet enough to write over and
 * never be mistaken for ink, and present enough to keep a column straight.
 * The projector gets them a little stronger: at 300:1 with the room lights
 * on, a one-pixel #c9d3e6 line on a 3-metre screen is gone by the fifth row.
 */
const PAPER_INK = {
  screen: { color: '#c9d3e6', width: 1 },
  projector: { color: '#b4c1da', width: 1.5 },
} as const

/** A blank sheet's rules, ready to stroke and fill on the sheet's canvas. */
export interface PaperMarks {
  /** Straight rules as `x0, y0, x1, y1` quadruples, in canvas device px. */
  lines: number[]
  /** Dot centres as `x, y` pairs, in canvas device px. */
  dots: number[]
  /** Line width, device px. */
  width: number
  /** Dot radius, device px. */
  radius: number
  color: string
}

/**
 * The rules of a blank sheet, as they fall on a `W × H` canvas showing the
 * region of `zoom`.
 *
 * The paper is part of the page: it is laid out in page fractions, so the
 * squares zoom with the page and stay under the ink written on them. The
 * weight grows more gently, by the square root of the zoom: a rule scaled
 * like the ink is six pixels thick on a projector at ×4, a grid that shouts
 * over the writing, and the writing done while zoomed is thinned to look
 * like ordinary writing (ink.ts · `inkWidthAt`). A weight that
 * did not grow at all would jump the most when the sharp picture replaces
 * the one scaled by CSS during the motion; the root halves that jump. Only
 * what the region shows is listed, so a ×4 view costs no more than the
 * whole page.
 *
 * Positions are snapped so that a rule's edge falls on a device pixel: a
 * one-pixel rule drawn between two pixels comes out as two half-grey ones.
 */
export function paperMarks(
  paper: SheetPaper,
  W: number,
  H: number,
  zoom: LectureZoom | null | undefined,
  projector = false,
): PaperMarks {
  const ink = projector ? PAPER_INK.projector : PAPER_INK.screen
  const z = zoom?.z ?? 1
  const x0 = zoom?.x ?? 0
  const y0 = zoom?.y ?? 0
  const width = ink.width * Math.sqrt(z)
  // A dot needs more body than a rule to be seen at all: on an iPad a dot of
  // a rule's width is a speck of half a CSS pixel.
  const marks: PaperMarks = { lines: [], dots: [], width, radius: width * 1.75, color: ink.color }
  if (paper === 'plain' || W <= 0 || H <= 0) return marks

  // Page fractions to canvas device px, and back for the visible range.
  const toX = (fx: number) => (fx - x0) * z * W
  const toY = (fy: number) => (fy - y0) * z * H
  const snap = (v: number) => Math.round(v - width / 2) + width / 2
  // The page's edges on the canvas, clipped to the canvas: rules run across
  // the visible part of the page only.
  const left = Math.max(-width, toX(0))
  const right = Math.min(W + width, toX(1))
  const top = Math.max(-width, toY(0))
  const bottom = Math.min(H + width, toY(1))
  const seen = (v: number, size: number) => v >= -width && v <= size + width

  // Squares: the step across is a fraction of the width, the step down the
  // same length in pixels, so the cells are square on every page shape.
  const across = 1 / PAPER_SQUARES
  const down = W / H / PAPER_SQUARES
  // Every step from the near edge on; none within half a step of the far
  // one, where a rule would hug the edge of the sheet (a pixel of rounding
  // in W / H is enough to put one there).
  const rows = (step: number) => {
    const out: number[] = []
    for (let k = 1; k * step <= 1 - step / 2; k += 1) out.push(k * step)
    return out
  }

  if (paper === 'grid') {
    for (const fx of rows(across)) {
      const x = toX(fx)
      if (seen(x, W)) marks.lines.push(snap(x), top, snap(x), bottom)
    }
    for (const fy of rows(down)) {
      const y = toY(fy)
      if (seen(y, H)) marks.lines.push(left, snap(y), right, snap(y))
    }
  } else if (paper === 'lines') {
    for (const fy of rows(1 / PAPER_RULES)) {
      const y = toY(fy)
      if (seen(y, H)) marks.lines.push(left, snap(y), right, snap(y))
    }
    const margin = toX(PAPER_MARGIN)
    if (seen(margin, W)) marks.lines.push(snap(margin), top, snap(margin), bottom)
  } else if (paper === 'dots') {
    const columns = rows(across)
      .map(toX)
      .filter((x) => seen(x, W))
    for (const fy of rows(down)) {
      const y = toY(fy)
      if (!seen(y, H)) continue
      for (const x of columns) marks.dots.push(x, y)
    }
  }
  return marks
}

/* --------------------------------------------------------- backdrop */

/**
 * WHAT THE HIGHLIGHTER LIES ON: a light page or a dark one.
 *
 * The ink layer lays every translucent stroke on a canvas of its own, under
 * the pen ink, blended with the page by `multiply` (InkLayer · `.ink-mark`):
 * on a light slide the text shows black through the yellow, as on paper.
 * Multiply can only darken, though. On a dark slide a 55 % highlighter
 * changes the navy under it by a contrast of 1.07 and black not at all, so
 * on a dark deck, or over a dark photograph, the highlighter drew nothing
 * anybody could see; 0.20.0, which laid it over the page as it was, drew a
 * plain yellow band there. A dark page is given `screen` instead, multiply's
 * mirror image: it can only lighten, so light text stays light under the
 * highlight and the dark ground lights up in the marker's colour.
 *
 * Every screen decides from its own picture of the same page and region, so
 * the console, the projector and the laptops agree without a word on the
 * wire.
 */
export type InkBackdrop = 'light' | 'dark'

/**
 * Below this mean relative luminance a page is dark.
 *
 * Measured for the five highlighters over greys: by contrast with the bare
 * page (WCAG), `screen` shows a highlight better than `multiply` below a
 * luminance of about 0.41; by colour difference (CIELAB ΔE), below about
 * 0.27. Between the two either blend shows it plainly (ΔE above 20 both
 * ways), so the line sits between them. Decks keep far from it: a light
 * theme averages above 0.7, a dark one below 0.1.
 */
export const DARK_BELOW = 0.35

/** The relative luminance of an sRGB colour (channels 0–255), as WCAG defines it. */
export function luminance(r: number, g: number, b: number): number {
  const linear = (c: number): number => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** `#rgb` or `#rrggbb` as channels; white, the light default, for anything else. */
function channels(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1]
  if (!hex) return [255, 255, 255]
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
}

/**
 * The mean relative luminance of RGBA pixels as `getImageData` hands them
 * out, each laid over `ground` the way the sheet lays its canvas over its
 * own colour: a canvas with nothing on it is its ground.
 */
export function meanLuminance(rgba: ArrayLike<number>, ground: string = SLIDE_GROUND): number {
  const [gr, gg, gb] = channels(ground)
  const count = Math.floor(rgba.length / 4)
  if (count === 0) return luminance(gr, gg, gb)
  let sum = 0
  for (let i = 0; i < count * 4; i += 4) {
    const a = rgba[i + 3] / 255
    sum += luminance(
      rgba[i] * a + gr * (1 - a),
      rgba[i + 1] * a + gg * (1 - a),
      rgba[i + 2] * a + gb * (1 - a),
    )
  }
  return sum / count
}

/** Light or dark, from a picture's mean luminance (`meanLuminance`). */
export function backdropOf(mean: number): InkBackdrop {
  return mean < DARK_BELOW ? 'dark' : 'light'
}

/** Light or dark, for a page of one colour: a blank sheet's paper, a wiped slide. */
export function backdropOfColor(color: string): InkBackdrop {
  const [r, g, b] = channels(color)
  return backdropOf(luminance(r, g, b))
}
