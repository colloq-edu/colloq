/**
 * Two things about notebook scrolling that are computed with numbers, not left
 * to the browser.
 *
 * THE FIRST — where to take the screen when someone MOVES to a neighbouring
 * cell with an arrow key. Not when they run it: running does not move the
 * screen at all and never comes here. This is a complaint from a class, and it
 * is about the same thing an earlier complaint about `scrollIntoView` was
 * about, only from the other side: "I run a cell, I want to look at its output,
 * and I get thrown down". The output appears under the code of the cell that
 * was run — so the place to look is where the person already is, and the best
 * thing scrolling can do on a run is nothing.
 *
 * Moving with an arrow has a different rule, the most modest there is: a cell
 * that is visible even by an edge is not touched at all; a cell that is not on
 * screen at all is brought in by the minimum. Below the screen — bottom edge to
 * the bottom (except a long one, which would otherwise arrive last line first);
 * above the screen — top to the top, with room for the toolbar, which hangs
 * ABOVE the cell and is not part of its rectangle.
 *
 * THE SECOND — how far to shift the scroll when something above the screen has
 * changed height. That is the job of browser scroll anchoring, and in the
 * notebook it does not do it (measured: a deferred cell above the screen
 * unfolds from 240 px to 809, `scrollTop` does not change by a single pixel,
 * the whole screen drifts by 569). So the anchor is our own, and the browser's
 * is switched off explicitly — otherwise one day both would correct and it
 * would drift twice as far. It is exactly what makes a run truly still: output
 * that grew above the screen does not pull the sheet from under your eyes.
 *
 * The module is pure and has no DOM: a test comes here. The caller collects the
 * geometry.
 */

/** A gap between the toolbar and the container's top: the cell must not butt up. */
export const BREATH = 14

/**
 * How much room the toolbar takes for a cell that is not built yet.
 *
 * A parked or a deferred cell has no toolbar in the DOM at all, but room for it
 * is needed already. The number is the height of the real row (24 px buttons
 * plus `py-0.5` on both sides), checked on a test bench.
 */
export const TOOLBAR_FALLBACK = 28

/** The scroll window: edges in screen coordinates and the current offset. */
export interface Frame {
  top: number
  bottom: number
  scrollTop: number
}

/** The cell we are heading to: edges in screen coordinates and its toolbar height. */
export interface CellBox {
  top: number
  bottom: number
  toolbar: number
}

/**
 * The target `scrollTop` for an arrow move — or `null` if the screen should not
 * be touched.
 *
 * Not touching is the main answer, not a caveat: a cell visible even by an edge
 * has already been found by the eye, and bringing it in means moving the whole
 * sheet under the person for something they already see. This used to compute
 * "cell top under screen top" on EVERY move, and on a run it looked as if the
 * notebook were running away downward from its own output.
 *
 * Room for the toolbar counts only where the cell is brought in by its top: the
 * row with "run" hangs above the cell and is not part of its rectangle, so a
 * cell brought in flush arrives with its toolbar cut off — that is, without
 * exactly the thing the person is about to reach for.
 */
export function nearestTarget(frame: Frame, cell: CellBox): number | null {
  // Visible even partly — do not move at all.
  if (cell.bottom > frame.top && cell.top < frame.bottom) return null

  const underTop = frame.scrollTop + (cell.top - frame.top) - (cell.toolbar + BREATH)
  const wanted =
    cell.top >= frame.bottom
      ? // Below the screen: bottom edge to the bottom. But no further than top to
        // top — otherwise a long cell arrives showing the last of forty lines.
        Math.min(frame.scrollTop + (cell.bottom - frame.bottom), underTop)
      : // Above the screen: top to the top. "The least" here would be "bottom
        // edge to the top", that is, last line first again.
        underTop

  const target = Math.max(0, wanted)
  // Already where it would be taken: rounding is no reason for an animation.
  if (Math.abs(target - frame.scrollTop) <= 1) return null
  return target
}

/**
 * Whether there is anything to measure in this frame.
 *
 * A complaint from a class: "I jump to a script with cmd+click from the fourth
 * cell, close the script, come back — and the notebook has gone down to the
 * tenth". The anchor was to blame, and here is how.
 *
 * A tab that was switched away is not unmounted — it is hidden with
 * `display: none` (SessionScreen · main). On a hidden node ALL measurements
 * read as zeros: `getBoundingClientRect()` gives zeros, `scrollTop` gives zero.
 * Checked in Chrome on a separate page: 1500 → hidden → reads 0, content height
 * 0; shown again — the browser itself restored 1500, it does not lose the
 * scroll.
 *
 * And at that very moment the visibility observer declares every cell
 * invisible, and the anchor wakes up — on the hidden notebook. It diligently
 * records a height of ZERO for every cell. On return the heights become real
 * again, and to the anchor it looks as if the whole sheet grew above the screen
 * at once: it adds up the growth and takes the screen down by exactly the sum
 * of all cells above the target. Hence "the tenth instead of the fourth".
 *
 * The rule is simple: a frame that is not on screen has zero height, and it
 * must not be measured by — neither recorded nor corrected. Not "skip the
 * correction", but do not touch the height memory at all: a single recorded
 * zero poisons the next frame, when the notebook is already visible.
 */
export function measurable(frame: { top: number; bottom: number }): boolean {
  return frame.bottom > frame.top
}

/** A cell that changed height: where its top is in scroll coordinates, and by how much. */
export interface HeightChange {
  top: number
  delta: number
}

/**
 * How far to shift the scroll so that the screen stays in place.
 *
 * What counts is what STARTS above the top edge of the screen: a cell lays out
 * top to bottom, so everything after its top moved by exactly `delta` — the
 * visible part of the screen included. A cell whose top is on screen or below
 * grows before the person's eyes: nothing needs moving there, otherwise the
 * correction itself becomes a jerk.
 *
 * The strict "<" is not pedantry: a cell starting exactly at the top edge grows
 * entirely into the screen.
 */
export function anchorShift(changes: readonly HeightChange[], scrollTop: number): number {
  let shift = 0
  for (const change of changes) if (change.top < scrollTop) shift += change.delta
  return shift
}

/**
 * A gap under the cell after a run: it shows there is something after it.
 *
 * Not "bring the bottom in flush": a bottom flush with the bottom of the screen
 * reads as "nothing further", and the person goes scrolling to check. The
 * height is one row of the next cell's buttons, that is, exactly the "start of
 * the next one" that was asked for.
 */
export const TAIL = 28

/**
 * Where to take the screen when a cell has finished — or `null` if nowhere.
 *
 * Two complaints from classes meet here, and they are opposites.
 *
 * The first, old one: "I run a cell, I want to look at the output, and I get
 * thrown down". After it, running stopped moving the screen at all — and that
 * was exactly half right. Output grows UNDER the code: if it fits on screen,
 * the place to look is where the person already is, and the best movement is
 * none.
 *
 * The second, new one: "in Colab it goes down to the bottom of the output after
 * a run, and ours just stands still". And it is about the other case — when the
 * output does NOT fit: the screen stands still, the output is there but not
 * visible, and the person scrolls by hand for what they just asked to see.
 *
 * Hence the condition that reconciles both: move only if the bottom of the
 * output is not visible, and exactly as far as makes it visible. Visible — do
 * not touch.
 *
 * The ceiling is the same as for an arrow move (nearestTarget), and for the
 * same reason: for a cell with three screens of output, "the bottom of the
 * output" is its last line, and bringing it in means taking both the code and
 * the start of the output off past the top edge. Such a cell is placed top to
 * top: it will be read from the start.
 *
 * Only downward. A run that pulls the sheet UP is that very jerk from the first
 * complaint, just in the other direction.
 *
 * And only a SINGLE run: the sheet does not follow "Run all" at all. The
 * reasoning is in Notebook · follow, along with the flag that tells one from
 * the other. A run-all simply never comes here.
 */
export function afterRun(frame: Frame, cell: CellBox): number | null {
  if (!measurable(frame)) return null
  // The bottom is visible along with the gap — there is already something to look at.
  if (cell.bottom + TAIL <= frame.bottom) return null
  const toBottom = frame.scrollTop + (cell.bottom + TAIL - frame.bottom)
  const underTop = frame.scrollTop + (cell.top - frame.top) - (cell.toolbar + BREATH)
  const target = Math.max(0, Math.min(toBottom, underTop))
  return target > frame.scrollTop + 1 ? target : null
}
