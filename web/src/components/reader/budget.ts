/**
 * How many device pixels a single PDF page may spend.
 *
 * The canvas buffer grows QUADRATICALLY with scale, and scale in the reader is
 * the column width: at 300% an A4 page in a 1400 px column asks to be drawn at
 * 8400×11900 ≈ 100 Mpx — four hundred megabytes per page. The observer keeps
 * the neighbouring pages drawn (`rootMargin: '1200px'`), that is, three or four
 * of those at once.
 *
 * On iPad the canvas memory budget is one PER PROCESS, and once it overflows,
 * WebKit starts handing canvases back transparent — arbitrary ones, not
 * necessarily those that overflowed it: the page of a running lecture in a
 * neighbouring tab can be blanked. Releasing invisible pages (`release`) is not
 * enough for this: at 250–300% the two or three visible ones already use up the
 * budget.
 *
 * So screen density here is a wish, not an entitlement: if the page does not
 * fit into the budget with it, the multiplier is lowered just enough for it to
 * fit. At 300% the page gets blurrier as a result — but a blurry page can be
 * read, and an empty one cannot.
 */

/**
 * The canvas area that must never be exceeded.
 *
 * 16 Mpx is 4096×4096, Safari's historical limit on the devices with the
 * smallest budget; 64 MB of buffer per page.
 */
export const MAX_CANVAS_PX = 16_000_000

/** And the side: a long narrow page may be fine by area but not by side. */
export const MAX_CANVAS_SIDE = 8192

/**
 * Density multiplier for a page `width` wide and `height` tall in CSS pixels.
 *
 * Returns `density` while the page fits into the budget, and less when it does
 * not. Never more than requested: sharpness beyond the screen density cannot be
 * seen.
 */
export function fits(width: number, height: number, density: number): number {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const byArea = Math.sqrt(MAX_CANVAS_PX / (w * h))
  const bySide = Math.min(MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h)
  return Math.max(0.1, Math.min(density, byArea, bySide))
}
