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
import type { DiffLine } from './diff.js'

/*
 * The diff line is one for the whole product, and it is declared where it is
 * computed.
 *
 * A second copy of the same interface stood here, word for word. Copies drift
 * apart at the very first added field: `CellDiff.lines` is typed by this, and
 * routes/history.ts puts the result of `diffLines` from diff.ts into it — and
 * the divergence would surface not as a type error but as a blank spot on the
 * screen.
 */
export type { DiffLine }

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
  /**
   * Only on a restore: the version it brought back.
   *
   * An address, not a time. The server used to build the label "restored the
   * version from 15:04" in its own time zone — in the container that is UTC —
   * while the browser draws the timeline rows in its own: in a classroom at
   * UTC+3 the label pointed at a row that is not in the list. The clock is
   * drawn by whoever is looking, from this version's `createdAt`.
   */
  targetSeq: number | null
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

/**
 * The timeline response: the rows — and whether it is whole.
 *
 * A room's history is capped in size, and a very long seminar has its
 * beginning cut off as one whole segment (server/src/db.ts · trimHistory).
 * Without this field the panel shows the remainder exactly as it would show
 * the full timeline, and nothing in it tells "nothing was written here" from
 * "nothing before this point was kept" — and people look at the history
 * precisely when they have lost something.
 *
 * The flag is about exactly that and nothing else: the list can also be
 * incomplete because the timeline window is four hundred rows
 * (routes/history.ts · MAX_VERSIONS), but those versions are in the database,
 * and they call for different words.
 *
 * Computed by the server, `db.ts · historyTrimmed`, from the room's oldest
 * row.
 */
export interface VersionList {
  versions: Version[]
  trimmed: boolean
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
 * Cap on the number of rows between full snapshots.
 *
 * Building version N means replaying the updates on top of the nearest
 * snapshot at or below it, and this number caps that work; it is not the
 * length of the history.
 *
 * It bounds the length of the replay, not the space: space is counted in
 * bytes (see maybeKeyframe). Without the cap a tiny notebook with a thousand
 * small edits would be assembled from a thousand pieces.
 *
 * It used to be 25 — and that was the only threshold, which is why a
 * three-megabyte notebook wrote a snapshot every twenty-five keystrokes. Now
 * bytes decide, by the "deltas cost more than the document" rule, and this
 * threshold has stayed what it should have been from the start: a guard
 * against a long replay. Two hundred updates take a fraction of a second to
 * assemble, and that is certainly rarer than the byte rule fires on any
 * notebook worth keeping.
 */
export const KEYFRAME_EVERY = 200

/**
 * Below this no full snapshot is written, however many deltas have piled up.
 *
 * For an empty notebook "as many deltas have piled up as the document weighs"
 * is two keystrokes, and a snapshot on every second one. Sixty-four kilobytes
 * is certainly less than any reasonable seminar and certainly more than any
 * noise.
 */
export const KEYFRAME_MIN_BYTES = 64 * 1024
