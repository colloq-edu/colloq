/**
 * The room a cell does not give up while it computes.
 *
 * Rerunning a cell with output looked like a jerk: the output is wiped at the
 * start, the block disappears, the cell collapses — and a moment later grows
 * back. Classic Jupyter does the same, and that is no excuse: nothing changed
 * on screen in substance, yet the page moved twice.
 *
 * Keeping the previous output until the new one arrives is a tempting move,
 * and it was rejected: on a projector an old number that looks fresh is worse
 * than any jerk. So the output is still wiped at once, but the HEIGHT stays.
 * The area does not shrink while there is nothing to put into it, and it
 * releases exactly once — when the content appears.
 *
 * A cell that had no output reserves nothing: pressing Run cannot make a cell
 * grow. It is a floor, not a promise — an area with no bounds of its own that
 * simply has not had time to shrink yet.
 *
 * The module is pure and has no DOM: a test comes here too. There are no
 * imports from `@/` here — the bundler knows that path and tsx does not.
 */
import type { CellState } from '@shared/notebook'

/**
 * What the area took up last time — and what it was.
 *
 * `fromError` is not decoration: room is reserved on the assumption that the
 * new output will be about the same size. For a cell rerun without changes
 * that holds. For a cell that failed it is exactly the opposite: it is rerun
 * BECAUSE something in it was changed, and there is no reason to expect a
 * traceback of the same height. And tracebacks are tall, so a mistake here
 * costs the most: half a thousand pixels of emptiness reserved for what will
 * not come.
 */
export interface Held {
  px: number
  fromError: boolean
}

export const NO_HELD: Held = { px: 0, fromError: false }

export interface SeatInput {
  /** The real execution state, not what is drawn: this is about layout. */
  running: boolean
  /** How many outputs are in the document now. */
  outputs: number
  /** How many images have not reported their size yet. */
  pendingImages: number
  held: Held
}

/** The floor in pixels: how much room the area does not give up right now. */
export function outputSeat(input: SeatInput): number {
  if (!input.running) return 0
  // A failed output holds no room: see Held.fromError.
  if (input.held.fromError) return 0
  // Hold while there is nothing to show — and while what is shown has not been
  // measured yet.
  if (input.outputs === 0 || input.pendingImages > 0) return input.held.px
  return 0
}

export interface RatchetInput {
  running: boolean
  outputs: number
  pendingImages: number
  /** How much the area measured itself at just now. */
  measured: number
  /** Whether what was measured includes a traceback. */
  hasError: boolean
}

/**
 * The new remembered height.
 *
 * Both checks inside are load-bearing, and both catch a silent failure.
 *
 * `outputs > 0` (not `measured > 0`): an empty area measures its own padding
 * — a dozen pixels — and writing that down would overwrite a nine-hundred-pixel
 * reserve with its own emptiness. Next time the cell would reserve nothing.
 *
 * `pendingImages === 0`: a freshly created `<img>` with a data URI has zero
 * height until it is decoded. Remembering that is the same thing, only
 * quieter: a nine-hundred-pixel plot would be remembered as eight.
 */
export function nextHeld(held: Held, input: RatchetInput): Held {
  if (input.outputs > 0 && input.pendingImages === 0 && input.measured > 0) {
    return { px: input.measured, fromError: input.hasError }
  }
  // The output was cleared by hand and nothing is running — forget it, otherwise
  // the next run would reserve room for what has long been gone from the cell.
  if (input.outputs === 0 && !input.running) return NO_HELD
  return held
}

/**
 * A result whose execution number has been taken away.
 *
 * We refused to keep the previous output during execution, so there is
 * nothing to mark — except four cases where a real result stays on screen
 * while the execution responsible for it no longer exists: a kernel restart,
 * a version restore, the kernel dying under a cell that was only queued, and
 * an old notebook in the same shape.
 *
 * `state === 'idle'` cuts off what would be untrue to mark: an execution whose
 * kernel died before execute_input ends in 'error' with a fresh traceback and
 * no number — but it did take place.
 */
export function unnumberedResult(input: {
  state: CellState
  execCount: number | null
  outputs: number
}): boolean {
  return input.outputs > 0 && input.execCount === null && input.state === 'idle'
}

/**
 * The execution mark — what stands in the gutter under the cell number.
 *
 * The question "has it even been run?" is asked out loud at every seminar,
 * and it could not be answered from the screen: the gutter shows the ORDINAL
 * NUMBER, which is the same for a computed cell and an untouched one, and the
 * `Out [n]` line was drawn only under output — that is, for half of the
 * notebook (imports, reading a file, function definitions) it was not drawn
 * at all.
 *
 * The form is Jupyter's: empty brackets versus brackets with a number. Not
 * because "everyone does it" but because it is the only notation the class
 * already knows how to read, and it answers two questions at once — whether
 * it ran and in what order. The second matters no less: a cell computed
 * before the one standing above it is otherwise not visible at all, and it is
 * exactly the cause of "it doesn't work for me".
 *
 * Computed from the document, not from this tab: both `execCount` and the
 * state are the room's shared truth, so someone who joined mid-class sees the
 * same as everyone.
 */
export interface RunMark {
  /** Exactly three monospace characters: the brackets keep a common vertical line. */
  label: string
  tone: 'idle' | 'busy' | 'done' | 'error' | 'lost'
}

/**
 * `null` — no mark at all: a note never runs, and empty brackets under its
 * number would promise a button it does not have.
 */
export function runMark(input: {
  type: 'code' | 'markdown'
  state: CellState
  execCount: number | null
  outputs: number
  running: boolean
}): RunMark | null {
  if (input.type !== 'code') return null
  // An asterisk for both the computing one and the queued one: the kernel will
  // give the number when it gets there, and until then neither has one.
  if (input.running || input.state === 'queued') return { label: '[*]', tone: 'busy' }
  if (input.execCount !== null) {
    return { label: `[${input.execCount}]`, tone: input.state === 'error' ? 'error' : 'done' }
  }
  /*
   * It ran, but there is no number: the kernel was restarted, a version was
   * restored, or the cell is empty — Jupyter gives an empty cell no number at
   * all. A dash, not empty brackets: the output on screen is real, and saying
   * "not run" above it would mean arguing with what the person sees.
   */
  if (input.outputs > 0 || input.state === 'ok' || input.state === 'error') {
    return { label: '[—]', tone: input.state === 'error' ? 'error' : 'lost' }
  }
  return { label: '[ ]', tone: 'idle' }
}

/**
 * The output key for `{#each}`.
 *
 * The slot number is not enough: `clear_output(wait=True)` replaces N entries
 * with M in one transaction, and slot 0, where a nine-hundred-pixel traceback
 * lay, becomes a two-hundred-pixel plot — inside the same wrappers, with the
 * previously remembered `heights[0]`. The plot is drawn cut off, and under it
 * hangs a "Show more" that there is no reason to press.
 *
 * The MIME type is deliberately not part of the key: the MIME choice depends
 * on whether the renderers chunk has arrived, and a key based on it would
 * re-create every output in the notebook the moment they loaded.
 */
export function outputKey(index: number, output: { kind: string; name?: string }): string {
  return `${index}:${output.kind}:${output.kind === 'stream' ? (output.name ?? '') : ''}`
}
