/**
 * Two notebook decisions that had already drifted out of step with reality.
 *
 * Both are about the same thing: a key pressed in the notebook must act on the
 * notebook the person sees, and has no business changing its make-up on their
 * behalf when they may not change it.
 */

/** The selection — but only if it is HERE. */
export interface Here {
  /** The cell the keys act on; `null`: the selection is in another notebook. */
  id: string | null
  /** Its position in this sheet; -1 when it is not here. */
  at: number
}

/**
 * The selection that belongs to THIS sheet.
 *
 * `session.selectedCellId` is one per room, and switching tabs does not touch
 * it. While the handlers took it as is, `d d` in the open notebook deleted a
 * cell that was not on screen, `m`/`y` changed its type, and Shift+Enter sent
 * it to run — the output showed up in a hidden tab. The person who pressed the
 * keys saw none of it.
 *
 * A selection somewhere else counts as empty: `a`/`b` then insert at the start
 * and at the end, as in a notebook where nothing is selected yet, and
 * everything else simply does nothing.
 */
export function selectionHere(selected: string | null, list: readonly string[]): Here {
  const at = selected ? list.indexOf(selected) : -1
  return { id: at === -1 ? null : selected, at }
}

/** Where to step after a run — and whether to grow the sheet. */
export type StepPlan =
  | { kind: 'move'; cellId: string }
  /** Nowhere to step, but Shift+Enter appends a cell: right here. */
  | { kind: 'grow'; at: number }
  | { kind: 'stay' }

export interface StepOptions {
  /** Deleting the first cell: pick up the neighbour on the OTHER side. */
  fallback?: boolean
  /** Shift+Enter: add a new cell after the last one. */
  grow?: boolean
  /** Whether cells may be added in this room. */
  mayAdd?: boolean
}

/**
 * A step from a cell to its neighbour.
 *
 * `grow` without the right to add is not a refusal but "stay where you are".
 *
 * While it was a refusal, a room with `run: room, structure: host` (the teacher
 * fixed the skeleton and let everyone run) answered with a red toast "The
 * notebook's make-up in this seminar is up to the teacher" to EVERY Shift+Enter
 * in the last cell — even though the run had happened and was correct. Someone
 * editing and re-running the last cell read it as "the run failed". This is
 * exactly the behaviour of Cmd+Enter — "run and stay" — and it promises nothing
 * beyond what was done.
 */
export function stepPlan(
  list: readonly string[],
  from: string,
  direction: -1 | 1,
  options: StepOptions = {},
): StepPlan {
  const at = list.indexOf(from)
  if (at === -1) return { kind: 'stay' }
  const target = list[at + direction] ?? (options.fallback ? list[at - direction] : undefined)
  if (target) return { kind: 'move', cellId: target }
  if (options.grow && options.mayAdd) return { kind: 'grow', at: at + 1 }
  return { kind: 'stay' }
}
