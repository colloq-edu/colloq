/**
 * A pass over a room's history with one document.
 *
 * Unfolding the notebook "as of row N" costs the whole snapshot (with
 * outputs, megabytes) plus every delta after it. While this was done afresh
 * for every row, it cost that much every time: up to four hundred times for
 * the candidates panel and up to forty for a publication, synchronously, in
 * the process that holds the sockets of someone else's class at that minute.
 *
 * Here the snapshot and each delta are applied once for the whole pass: the
 * document moves forward from row to row and is rebuilt only where a new
 * snapshot appeared in between, since then it is cheaper than the deltas it
 * replaced. The same condition saves us from a history trimmed mid-way
 * (db.ts · trimHistory): it leaves a keyframe behind, and the pass, seeing it
 * ahead of its own state, starts from it instead of counting on through rows
 * that no longer exist.
 *
 * The order is ascending `seq`, and only that: the document does not rewind
 * (a CRDT cannot do that), and a request for a row below one already passed
 * builds a new document.
 *
 * A row that does not unfold makes `at` throw, and the document is dropped:
 * it holds half of what was applied, and the next row has to start clean.
 * What such a row means is for the caller to decide: the candidates panel
 * treats it as empty, the publication as a broken step.
 *
 * The rule "a replay starts from the nearest keyframe" lives in db.ts
 * (`updatesUpTo`) and is not repeated here: the pass takes its start from
 * there, and the query below is only its continuation on top of the state
 * already built.
 */
import * as Y from 'yjs'
import { db, updatesUpTo } from '../db.js'

/** The nearest whole-document snapshot not above the row. */
const selectKeyframeAt = db.prepare(`
  SELECT seq FROM doc_history
  WHERE session_id = ? AND seq <= ? AND kind = 'keyframe'
  ORDER BY seq DESC LIMIT 1
`)

/** Rows not yet in the document built so far. */
const selectAfter = db.prepare(`
  SELECT update_blob FROM doc_history
  WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC
`)

/** Marks writes made by the replay, as in the rest of the publication. */
const ORIGIN = 'publish'

export interface Replay {
  /** The notebook as of the row: the same document, moved forward. */
  at(seq: number): Y.Doc
  /** Release the document: while the pass is open it holds the whole notebook in memory. */
  close(): void
}

export function openReplay(sessionId: string): Replay {
  let doc: Y.Doc | null = null
  /** The row up to which the document has been computed. */
  let applied = -1

  const drop = (): void => {
    doc?.destroy()
    doc = null
    applied = -1
  }

  const keyframeAt = (seq: number): number => {
    const row = selectKeyframeAt.get(sessionId, seq) as { seq: number } | undefined
    return row ? row.seq : 0
  }

  return {
    at(seq) {
      try {
        if (doc === null || seq < applied || keyframeAt(seq) > applied) {
          drop()
          const fresh = new Y.Doc()
          fresh.transact(() => {
            for (const update of updatesUpTo(sessionId, seq)) Y.applyUpdate(fresh, update, ORIGIN)
          })
          doc = fresh
        } else {
          const rows = selectAfter.all(sessionId, applied, seq) as { update_blob: Buffer }[]
          const same = doc
          same.transact(() => {
            for (const row of rows) Y.applyUpdate(same, new Uint8Array(row.update_blob), ORIGIN)
          })
        }
        applied = seq
        return doc
      } catch (err) {
        drop()
        throw err
      }
    },
    close: drop,
  }
}
