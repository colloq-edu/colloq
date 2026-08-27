/**
 * What the room did to its notebook, and how to get any of it back.
 *
 * A seminar notebook is edited by twenty people at once, live, on a projector.
 * That is exactly the situation where somebody deletes the cell everyone was
 * looking at, or pastes over a working example, and the room stops while the
 * teacher tries to remember what was there. Ctrl+Z does not help: the person
 * who has to undo it is rarely the person who did it.
 *
 * So the room keeps a history, and the history answers two questions — who
 * changed this, and what did it look like before.
 */

/** What kind of moment this is. Ordinary typing is an `edit`. */
export type VersionKind =
  /** A burst of edits by one person, closed by silence or by somebody else typing. */
  | 'edit'
  /** A point somebody named on purpose: "before the exercise". */
  | 'checkpoint'
  /** Somebody put an older version back. Recorded so it can itself be undone. */
  | 'restore'
  /** The room's first state — the notebook it opened with. */
  | 'opened'
  /**
   * A burst that changed no text — outputs, run states, a moved cell.
   *
   * Never shown: the timeline is the history of what the room wrote. But
   * always stored, because Yjs replay cannot skip an update — every later one
   * names the clocks it was built on. A skipped burst is a hole, and every
   * version rebuilt across the hole came out wrong.
   */
  | 'quiet'

/*
 * A history holds finished facts and nothing else. There is deliberately no
 * "somebody is typing right now" here: an unfinished edit is not a version, it
 * is a rumour about one, and a log that reports rumours is a log you cannot
 * trust the rest of. What is in flight is visible where it belongs — in the
 * notebook, under that person's cursor.
 */

/** One line of the timeline. Deliberately small: the list is loaded whole. */
export interface Version {
  /** Monotonic within a session. Also the address of the state after this edit. */
  seq: number
  kind: VersionKind
  /** Who did it. Null for the server's own writes — seeding, an import. */
  authorId: string | null
  authorName: string | null
  authorColor: string | null
  createdAt: number
  /** Only a checkpoint has one. */
  label: string | null
  /** What it touched, already in words: "edited cell 04", "added 3 cells". */
  summary: string
  /** Characters written and removed, for the two numbers at the end of the row. */
  added: number
  removed: number
  /** Cell ids this version touched, so the sheet can mark them. */
  cells: string[]
}

/** A cell as of some version. Enough to render it read-only and to diff it. */
export interface HistoricCell {
  id: string
  type: 'code' | 'markdown'
  source: string
}

export interface VersionContent {
  seq: number
  cells: HistoricCell[]
}

/** One line of a diff between two versions of a cell. */
export interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
}

export interface CellDiff {
  cellId: string
  /** Null when the cell did not exist yet — the whole thing is an addition. */
  before: string | null
  /** Null when the cell was deleted. */
  after: string | null
  lines: DiffLine[]
}

export interface VersionDetail {
  version: Version
  diffs: CellDiff[]
}

/** How many characters a burst may accumulate before it is closed on size alone. */
export const BURST_MAX_CHARS = 4_000

/**
 * How long one person may keep typing before the burst is closed anyway.
 *
 * A burst is meant to be "one thing somebody did". Left unbounded, a teacher
 * writing a long cell for four minutes produces a single version covering the
 * whole thing, and the one state worth going back to — the moment before the
 * paragraph that broke it — is not in the list.
 */
export const BURST_MAX_MS = 90_000

/** Silence after which a burst is considered finished. */
export const BURST_IDLE_MS = 12_000

/**
 * Versions between full snapshots.
 *
 * Materialising version N means replaying updates onto the nearest keyframe at
 * or below it, so this number is the ceiling on that work — never the length of
 * the history. Twenty-five is chosen against the shape of a seminar rather than
 * a benchmark: a ninety-minute class produces a few dozen versions, so the
 * whole history is two or three keyframes and the deepest replay is a couple of
 * dozen small updates, which is milliseconds.
 */
export const KEYFRAME_EVERY = 25
