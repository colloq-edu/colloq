/**
 * "Show me where it is" — one gesture for the whole seminar.
 *
 * There are already several places one wants to jump from to the work: a turn
 * in the oracle thread names the cell that was asked about; a row in the
 * people list says a person is editing cell 04 or sitting in the terminal. The
 * first used to be able to jump by itself, the second could not at all, and
 * had they diverged in some detail — one scrolls to the centre, the other to
 * the nearest edge — the same button would start behaving differently
 * depending on where it was pressed from.
 *
 * This function shows a cell: selection and scrolling are ordinary work with
 * the document, and there is no point waking the whole screen for it. But the
 * terminal and the oracle live in panels only SessionScreen knows about: an
 * event goes there.
 */
import type { RevealTarget } from './room'
import type { SessionState } from './session.svelte'

// The type lives in room.ts together with what computes it: it is also tested
// there, and neither Svelte nor the browser gets pulled in there.
export type { RevealTarget }

export const REVEAL_EVENT = 'colloq:reveal'

/**
 * How long to wait for the cells along the way to unfold before bringing the
 * screen in once more.
 *
 * A little longer than the browser's smooth scroll (it fits into half a
 * second) and surely less than it takes a person to start reading the wrong
 * thing.
 */
const SETTLE_MS = 700

/**
 * Select a cell and bring the screen to it.
 *
 * To the centre, not to the nearest edge: this is following someone's link,
 * not a cursor step. A cell brought in flush with the bottom edge is formally
 * visible and practically unnoticeable.
 *
 * The scroll happens on the next frame: the selection may unfold a collapsed
 * cell, and measuring its height before the redraw means taking the screen to
 * the wrong place.
 */
export function revealCell(session: SessionState, cellId: string): void {
  /*
   * First show the NOTEBOOK the cell is in, and only then the cell.
   *
   * A room has several notebooks, and all the open ones are mounted: inactive
   * ones are hidden by a class. `scrollIntoView` inside something hidden does
   * nothing — the "show where they are" jump from the people list or from the
   * thread silently selected something invisible.
   */
  session.showCell?.(cellId)
  session.selectCell(cellId)
  const bring = (behavior: ScrollBehavior): void => {
    document.querySelector(`[data-cell-id="${cellId}"]`)?.scrollIntoView({ block: 'center', behavior })
  }
  requestAnimationFrame(() => bring('smooth'))
  /*
   * And a second approach — this time without smoothness.
   *
   * A distant cell is not built yet at this moment: a placeholder of exactly
   * 240 px stands in its place (Notebook.svelte · data-cell-deferred). While
   * the screen travels to it, the neighbours along the way unfold into real
   * cells — with code, output and images — and the target drifts down by the
   * difference in heights. A jump across the whole notebook stopped a screen
   * and a half short of what was being looked for.
   *
   * The correction comes after the travel has ended: `scrollTop` must not be
   * touched in the middle of a smooth scroll — the browser treats it as
   * outside interference and cuts the travel off (Notebook.svelte ·
   * steering) — and for the same reason the correction itself is instant,
   * without a second smooth travel on top of the first.
   */
  setTimeout(() => bring('auto'), SETTLE_MS)
}

/**
 * Ask the screen to show a place.
 *
 * An event, not a call: panels open and close in SessionScreen, and passing
 * its state down through four layers for one button would tie the people
 * list to the layout of the whole workspace.
 */
export function reveal(target: RevealTarget): void {
  window.dispatchEvent(new CustomEvent<RevealTarget>(REVEAL_EVENT, { detail: target }))
}
