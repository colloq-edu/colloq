/**
 * Moments that can become steps.
 *
 * A step is a version named by a person: "before the exercise", "the version
 * that kept breaking". Technically it is a history row, but not just any: only
 * one that unfolds into at least one cell will do, and that is checked here,
 * on a handful of rows, not later when a student opens an empty page.
 *
 * Bursts of edits (`edit`, `quiet`) are never candidates. There are dozens of
 * them per lesson, nobody named them, and a "step" made from them would be
 * mechanical: a moment when people simply stopped typing.
 */
import { db } from '../db.js'
import { getCells } from '@shared/notebook'
import { openReplay } from './replay.js'

/**
 * Rows backed by a whole document.
 *
 * As strings, not `VersionKind`: `keyframe` exists in the database but not in
 * the union type, since it is internal and not shown in the feed. Casting it
 * to a type that does not know it would mean lying to the compiler for the
 * sake of a pretty import.
 */
const NAMED: ReadonlySet<string> = new Set(['opened', 'checkpoint', 'restore', 'keyframe'])

export interface Candidate {
  seq: number
  /** What is offered as the name. Empty means the moment is unnamed and needs a name. */
  label: string
  at: number
  cellCount: number
  kind: string
}

/**
 * How many NAMED rows to take. A semester in one room is an outlier.
 *
 * There used to be a window of four hundred rows of ANY kind here, with what
 * had already been fetched filtered by `kind`. An edit burst is closed every
 * four kilobytes of updates, on any change to the notebook's structure and
 * after twelve seconds of silence; a room of thirty people produces hundreds
 * of them per lesson, and a checkpoint set in the fifteenth minute fell out of
 * the window. The row itself was alive in the database: what got lost was
 * exactly the function it had been set for.
 */
const MAX_NAMED = 400

/**
 * Named history rows, by query rather than by filtering what was fetched.
 *
 * The kinds are listed by `NAMED` so that there is one list: the
 * `doc_history_session` index covers this query entirely.
 */
const selectNamed = db.prepare(`
  SELECT seq, kind, created_at, label
  FROM doc_history
  WHERE session_id = ? AND kind IN (${[...NAMED].map(() => '?').join(', ')})
  ORDER BY seq DESC LIMIT ?
`)

interface NamedRow {
  seq: number
  kind: string
  created_at: number
  label: string | null
}

/**
 * What has already been counted, by room and row.
 *
 * History is immutable: a row unfolded once gives the same number of cells an
 * hour later. The publication panel is re-read on every keystroke in the step
 * name field, and without this the whole unfolding would be paid for again
 * each time.
 *
 * In memory, not in the database: a table of its own would survive the
 * seminar's deletion (`discardHistory`) and stay behind as garbage nobody
 * comes for. There is no need to forget the counts even after a deletion:
 * `seq` is an AUTOINCREMENT across the whole database, a deleted row's number
 * never goes to anyone else, and the memory itself is evicted by room.
 */
const MEMO_ROOMS = 16
const memos = new Map<string, Map<number, number>>()

function memoFor(sessionId: string): Map<number, number> {
  const found = memos.get(sessionId)
  if (found) {
    // Move it to the end: the room evicted is the one not opened for the
    // longest, not the one opened first.
    memos.delete(sessionId)
    memos.set(sessionId, found)
    return found
  }
  const fresh = new Map<number, number>()
  memos.set(sessionId, fresh)
  for (const key of memos.keys()) {
    if (memos.size <= MEMO_ROOMS) break
    memos.delete(key)
  }
  return fresh
}

/**
 * A cell counter that walks the rows FORWARD with one document.
 *
 * The pass itself is in `replay.ts`, shared with the publication: unfolding a
 * new `Y.Doc` for every row meant paying for the whole snapshot (with outputs,
 * megabytes) plus every delta after it, up to four hundred times in a row,
 * synchronously, in the process that holds the room's sockets at that minute.
 * What stays here is only what is our own: counting cells and remembering the
 * counts.
 */
interface Walk {
  count(seq: number): number
  close(): void
}

function walk(sessionId: string): Walk {
  const memo = memoFor(sessionId)
  const replay = openReplay(sessionId)

  return {
    count(seq) {
      const known = memo.get(seq)
      if (known !== undefined) return known
      let n = 0
      try {
        n = getCells(replay.at(seq)).length
      } catch (err) {
        // The row does not unfold, so it cannot be a step, and the pass
        // restarts from a clean document after it by itself (replay.ts).
        console.error(`publish: history row ${sessionId}#${seq} does not unfold`, err)
      }
      memo.set(seq, n)
      return n
    },
    close: replay.close,
  }
}

function namedRows(sessionId: string): NamedRow[] {
  return (
    (selectNamed.all(sessionId, ...NAMED, MAX_NAMED) as NamedRow[])
      // The query returns the newest first, while a student goes forward in
      // time. And an ascending pass is what counting with one document relies
      // on.
      .sort((a, b) => a.seq - b.seq)
  )
}

function candidateOf(row: NamedRow, cellCount: number): Candidate {
  return {
    seq: row.seq,
    /*
     * A name is offered only where a person wrote it. `keyframe` and `opened`
     * have none and cannot have one: they are internal snapshots, and
     * "Snapshot #14" on a student's rail is not the name of a moment but an
     * admission that somebody forgot to name it.
     */
    label: row.kind === 'checkpoint' ? (row.label ?? '') : '',
    at: row.created_at,
    cellCount,
    kind: row.kind,
  }
}

export function candidatesFor(sessionId: string): Candidate[] {
  const rows = namedRows(sessionId)
  const walker = walk(sessionId)
  const out: Candidate[] = []
  try {
    for (const row of rows) {
      const cellCount = walker.count(row.seq)
      // A version that does not unfold into a notebook cannot be a step.
      if (cellCount === 0) continue
      out.push(candidateOf(row, cellCount))
    }
  } finally {
    walker.close()
  }
  return out
}

/** How many rows to go through between breaths. */
const CHUNK = 8

/**
 * The same, but with pauses: between chunks of work the process gets to send
 * out frames.
 *
 * The first unfolding of a room's semester-long history still takes seconds,
 * and spending them all on the event loop means stopping sync and cursors for
 * everyone in the room for those seconds. The publication panel can wait; the
 * class cannot.
 */
export async function candidatesForAsync(sessionId: string): Promise<Candidate[]> {
  const rows = namedRows(sessionId)
  const walker = walk(sessionId)
  const out: Candidate[] = []
  try {
    for (let i = 0; i < rows.length; i += 1) {
      if (i > 0 && i % CHUNK === 0) await new Promise((done) => setImmediate(done))
      const cellCount = walker.count(rows[i].seq)
      if (cellCount === 0) continue
      out.push(candidateOf(rows[i], cellCount))
    }
  } finally {
    walker.close()
  }
  return out
}
