/**
 * Turning a stream of CRDT updates into a history a person can read.
 *
 * Yjs hands us an update per keystroke. A history made of those is not a
 * history — it is a log, and nobody scrolls a log of four thousand rows looking
 * for the moment before the cell broke. So updates are grouped into bursts: one
 * burst is one thing one person did, and one burst is one row in the timeline.
 *
 * A burst closes when the person stops typing (BURST_IDLE_MS), when somebody
 * else starts (a different author is a different thing done), when it has grown
 * past BURST_MAX_CHARS, or when it has simply run too long (BURST_MAX_MS) —
 * that last one exists so a teacher writing one long cell for four minutes
 * still leaves a point to come back to in the middle of it.
 *
 * Cost. The merge happens in memory and touches SQLite once per burst, which
 * for a ninety-minute seminar is a few dozen writes. Reading is the mirror
 * image: a keyframe every KEYFRAME_EVERY rows means rebuilding any version
 * replays a bounded number of updates rather than the whole seminar, and the
 * result is cached, so scrubbing the timeline costs one rebuild per version
 * visited rather than one per render.
 */
import * as Y from 'yjs'
import {
  BURST_IDLE_MS,
  BURST_MAX_CHARS,
  BURST_MAX_MS,
  KEYFRAME_EVERY,
  type HistoricCell,
  type VersionKind,
} from '@shared/history'
import { CELLS_KEY, createCell, getCells, type YCell } from '@shared/notebook'
import { appendVersion, hasHistoryBase, updatesUpTo, versionCount } from '../db.js'

/** Marks writes this module makes into a live doc, so they are not re-recorded twice. */
export const RESTORE_ORIGIN = 'history-restore'

interface Burst {
  sessionId: string
  authorId: string | null
  updates: Uint8Array[]
  /** State of the document when the burst opened, for the summary and the counts. */
  before: Uint8Array
  openedAt: number
  lastAt: number
  chars: number
  timer: NodeJS.Timeout | null
  /** Which cells existed, and in what order, when the burst opened. */
  shape: string
}

const bursts = new Map<string, Burst>()

/*
 * The state each session's next version will be measured against.
 *
 * It cannot be read off the document when a burst opens: `doc.on('update')`
 * fires *after* the update has been applied, so by then the change we are about
 * to describe is already in there and the comparison finds nothing. That was
 * not a subtle bug — it silently dropped the first version of every burst,
 * which is most of them.
 *
 * So the baseline is carried forward instead: set when the room is bound (to
 * whatever was on disk), and advanced to the new state every time a version is
 * written. A version is then exactly "the difference between the last thing we
 * recorded and now", which is what it claims to be.
 */
const baselines = new Map<string, Uint8Array>()

/*
 * The notebook's shape as of each baseline: which cells existed, in what order.
 *
 * Carried forward with the baseline for the same reason the baseline is: the
 * update handler runs *after* the change has landed, so reading the shape off
 * the live document when a burst opens reads the shape the burst just produced,
 * and the comparison below can never be true.
 */
const shapes = new Map<string, string>()

/**
 * Start recording a room, measuring from the state it currently holds.
 *
 * Called once the document is hydrated and before it is seeded, so a brand-new
 * seminar records its starter cells as its first version and a restarted one
 * does not record its whole notebook as somebody's edit.
 */
export function beginHistory(sessionId: string, doc: Y.Doc): void {
  baselines.set(sessionId, Y.encodeStateAsUpdate(doc))
  shapes.set(sessionId, shapeOf(doc))

  /*
   * A room with no history yet gets a first row carrying the whole document.
   *
   * It is the timeline's "opened the seminar", and it is also the thing every
   * replay starts from. Without it the oldest row is a delta with nothing
   * underneath, and rebuilding any version means applying a change to a
   * document that was never there — which produces an empty notebook, silently.
   *
   * The test is for a base specifically, not for an empty history. A room
   * recorded by a build that predates this row has deltas and nothing to apply
   * them to, and would rebuild to an empty notebook for ever; giving it a base
   * now costs one row and makes everything from this moment on readable.
   */
  if (hasHistoryBase(sessionId)) return
  appendVersion({
    sessionId,
    update: Y.encodeStateAsUpdate(doc),
    kind: 'opened',
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: versionCount(sessionId) > 0 ? 'the notebook as it stood' : 'opened the seminar',
    added: 0,
    removed: 0,
    cells: [],
  })
}

/**
 * What a version did, in the words the timeline shows.
 *
 * Computed by comparing the document before the burst with the document after
 * it — not by inspecting the update bytes. The bytes say which items changed;
 * the reader wants to know that cell 04 was edited, and only the two documents
 * can say that.
 */
function describe(before: Y.Doc, after: Y.Doc): {
  summary: string
  added: number
  removed: number
  cells: string[]
} {
  const was = new Map(cellsOf(before).map((c) => [c.id, c.source]))
  const now = new Map(cellsOf(after).map((c) => [c.id, c.source]))

  const created: string[] = []
  const deleted: string[] = []
  const changed: string[] = []
  let added = 0
  let removed = 0

  for (const [id, source] of now) {
    const old = was.get(id)
    if (old === undefined) {
      created.push(id)
      added += source.length
    } else if (old !== source) {
      changed.push(id)
      const gain = source.length - old.length
      // Net, not a real diff: a burst that replaces a word both adds and
      // removes, and counting only the balance would report it as nothing.
      if (gain >= 0) added += gain
      else removed += -gain
      if (gain === 0 && old !== source) added += source.length
    }
  }
  for (const [id, source] of was) {
    if (!now.has(id)) {
      deleted.push(id)
      removed += source.length
    }
  }

  const order = [...now.keys()]
  const number = (id: string) => String(order.indexOf(id) + 1).padStart(2, '0')

  let summary: string
  if (created.length > 0 && changed.length === 0 && deleted.length === 0) {
    summary = created.length === 1 ? 'added a cell' : `added ${created.length} cells`
  } else if (deleted.length > 0 && created.length === 0 && changed.length === 0) {
    summary = deleted.length === 1 ? 'deleted a cell' : `deleted ${deleted.length} cells`
  } else if (changed.length === 1 && created.length === 0 && deleted.length === 0) {
    summary = `edited cell ${number(changed[0])}`
  } else if (changed.length > 1 && created.length === 0 && deleted.length === 0) {
    summary = `edited ${changed.length} cells`
  } else if (created.length + changed.length + deleted.length === 0) {
    // Nothing anybody wrote changed. The caller drops these — see close().
    summary = ''
  } else {
    summary = 'reworked the notebook'
  }

  return { summary, added, removed, cells: [...new Set([...created, ...changed, ...deleted])] }
}

/** The cells of a document, flattened to what the history cares about. */
export function cellsOf(doc: Y.Doc): HistoricCell[] {
  const cells = doc.getArray<Y.Map<unknown>>(CELLS_KEY)
  const out: HistoricCell[] = []
  for (const cell of cells.toArray()) {
    const id = cell.get('id')
    if (typeof id !== 'string') continue
    const source = cell.get('source')
    out.push({
      id,
      type: cell.get('type') === 'code' ? 'code' : 'markdown',
      source: source instanceof Y.Text ? source.toString() : String(source ?? ''),
    })
  }
  return out
}

/** Which cells exist and in what order — the notebook's shape, not its text. */
function shapeOf(doc: Y.Doc): string {
  return doc
    .getArray<Y.Map<unknown>>(CELLS_KEY)
    .toArray()
    .map((cell) => String(cell.get('id') ?? ''))
    .join(',')
}

function docFrom(updates: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc()
  // One transaction for the whole replay: applying twenty updates separately
  // fires twenty rounds of observers on a document nobody is watching.
  doc.transact(() => {
    for (const update of updates) Y.applyUpdate(doc, update, 'history')
  })
  return doc
}

/** Close a burst and write it as one version. */
function close(key: string): void {
  const burst = bursts.get(key)
  if (!burst) return
  bursts.delete(key)
  if (burst.timer) clearTimeout(burst.timer)
  if (burst.updates.length === 0) return

  const merged = Y.mergeUpdates(burst.updates)
  const before = docFrom([burst.before])
  const after = docFrom([burst.before, merged])
  const facts = describe(before, after)
  before.destroy()

  /*
   * A burst that changed no text is not a version.
   *
   * The document carries far more than what people write: every line a cell
   * prints, every run-state flip, every token the oracle streams. Recording
   * those would bury the timeline under "ran the notebook" — dozens of rows an
   * hour that nobody would ever want to go back to — and the one row that
   * matters, the edit before the cell broke, would be lost among them.
   *
   * So the filter is the whole point rather than an optimisation: history here
   * means the history of what the room wrote.
   */
  if (facts.cells.length === 0) {
    /*
     * Still advance the baseline. The outputs and run states in this burst are
     * now part of the document, and leaving them outside the baseline would
     * make the next real edit look like it changed them too.
     */
    baselines.set(burst.sessionId, Y.encodeStateAsUpdate(after))
    shapes.set(burst.sessionId, shapeOf(after))
    after.destroy()
    return
  }

  try {
    appendVersion({
      sessionId: burst.sessionId,
      update: merged,
      kind: 'edit',
      authorId: burst.authorId,
      createdAt: burst.lastAt,
      label: null,
      ...facts,
    })
    // The next version is measured from here, not from wherever the document
    // happens to be when somebody next presses a key.
    baselines.set(burst.sessionId, Y.encodeStateAsUpdate(after))
    shapes.set(burst.sessionId, shapeOf(after))
    maybeKeyframe(burst.sessionId, after)
  } catch (err) {
    // A history that cannot be written must not stop the seminar being taught.
    console.error(`[history] could not record a version for ${burst.sessionId}`, err)
  }
  after.destroy()
}

/**
 * Write the whole document every KEYFRAME_EVERY versions.
 *
 * Without this, rebuilding the state at version N costs N updates and the cost
 * grows all class. With it the cost is bounded by the interval, and the price
 * is one extra row of full-document bytes every twenty-five edits.
 */
function maybeKeyframe(sessionId: string, doc: Y.Doc): void {
  if (versionCount(sessionId) % KEYFRAME_EVERY !== 0) return
  appendVersion({
    sessionId,
    update: Y.encodeStateAsUpdate(doc),
    kind: 'keyframe',
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: '',
    added: 0,
    removed: 0,
    cells: [],
  })
}

/**
 * Record one update against a session.
 *
 * Called from the document's own update handler, so it sees every change the
 * room makes — including ones that arrive from a client the server never asked.
 */
export function record(
  sessionId: string,
  doc: Y.Doc,
  update: Uint8Array,
  authorId: string | null,
): void {
  const key = sessionId
  const existing = bursts.get(key)
  const now = Date.now()

  // A different person is a different thing done, so their first keystroke
  // closes whatever was open rather than joining it.
  if (existing && existing.authorId !== authorId) {
    close(key)
  }

  let burst = bursts.get(key)
  if (!burst) {
    burst = {
      sessionId,
      authorId,
      updates: [],
      before: baselines.get(key) ?? Y.encodeStateAsUpdate(new Y.Doc()),
      openedAt: now,
      lastAt: now,
      chars: 0,
      timer: null,
      shape: shapes.get(key) ?? '',
    }
    bursts.set(key, burst)
  }

  burst.updates.push(update)
  burst.lastAt = now
  burst.chars += update.byteLength

  /*
   * Adding, deleting or moving a cell closes the burst at once.
   *
   * Typing is a stream and wants grouping; changing the shape of the notebook
   * is a discrete act, and it is the act people come to this panel to undo. A
   * deleted cell that takes twelve seconds of silence to appear in the history
   * is missing exactly when it is being looked for — and the silence is not
   * even likely, because the person who deleted it usually keeps working.
   */
  if (shapeOf(doc) !== burst.shape) {
    close(key)
    return
  }

  if (burst.chars >= BURST_MAX_CHARS || now - burst.openedAt >= BURST_MAX_MS) {
    close(key)
    return
  }

  if (burst.timer) clearTimeout(burst.timer)
  burst.timer = setTimeout(() => close(key), BURST_IDLE_MS)
  // A pending burst must not be the reason the process stays alive; shutdown
  // flushes them all on the way out.
  burst.timer.unref?.()
}

/** Close whatever is open for one session — before a read, or on shutdown. */
export function flushHistory(sessionId: string): void {
  close(sessionId)
}

export function flushAllHistory(): void {
  for (const key of [...bursts.keys()]) close(key)
}

/** Drop a session's open burst without writing it. Used when a seminar is deleted. */
export function discardBurst(sessionId: string): void {
  baselines.delete(sessionId)
  shapes.delete(sessionId)
  const burst = bursts.get(sessionId)
  if (!burst) return
  bursts.delete(sessionId)
  if (burst.timer) clearTimeout(burst.timer)
}

/* ------------------------------------------------------------------ reading */

/**
 * The notebook as of one version.
 *
 * Cached by (session, seq) because the timeline is scrubbed: a person clicking
 * down the list would otherwise pay a rebuild per click, and clicking back up
 * would pay again for versions already visited. Entries are dropped when the
 * session's history grows, since a new version cannot change an old one but a
 * restore can add rows that shift what "latest" means.
 */
const rebuilt = new Map<string, { cells: HistoricCell[]; at: number }>()
const CACHE_MAX = 64

export function cellsAt(sessionId: string, seq: number): HistoricCell[] {
  const key = `${sessionId}:${seq}`
  const hit = rebuilt.get(key)
  if (hit) return hit.cells

  const doc = docFrom(updatesUpTo(sessionId, seq))
  const cells = cellsOf(doc)
  doc.destroy()

  if (rebuilt.size >= CACHE_MAX) {
    // Oldest first. A seminar visits versions in bursts of interest, so the
    // ones worth keeping are the ones touched most recently.
    let oldestKey: string | null = null
    let oldest = Infinity
    for (const [k, v] of rebuilt) {
      if (v.at < oldest) {
        oldest = v.at
        oldestKey = k
      }
    }
    if (oldestKey) rebuilt.delete(oldestKey)
  }
  rebuilt.set(key, { cells, at: Date.now() })
  return cells
}

/** Forget everything cached for a session — after a restore, or a delete. */
export function forgetCache(sessionId: string): void {
  for (const key of [...rebuilt.keys()]) {
    if (key.startsWith(`${sessionId}:`)) rebuilt.delete(key)
  }
}

/* -------------------------------------------------------------------- diff */


/** Record a version that is not a burst: a checkpoint, a restore, the first state. */
export function mark(
  sessionId: string,
  doc: Y.Doc,
  kind: VersionKind,
  authorId: string | null,
  label: string | null,
  summary: string,
): number {
  flushHistory(sessionId)
  const seq = appendVersion({
    sessionId,
    update: Y.encodeStateAsUpdate(doc),
    kind,
    authorId,
    createdAt: Date.now(),
    label,
    summary,
    added: 0,
    removed: 0,
    cells: [],
  })
  baselines.set(sessionId, Y.encodeStateAsUpdate(doc))
  shapes.set(sessionId, shapeOf(doc))
  forgetCache(sessionId)
  return seq
}

/**
 * Put a version's text back into the live document.
 *
 * The CRDT is not rewound. Rewinding means rolling back state vectors that
 * every browser in the room is holding, and the next keystroke from any of them
 * would arrive against a document that no longer matches — the room would tear.
 * So the old content is written as an ordinary edit: it merges the way every
 * edit merges, everybody sees it at once, and because it is an edit it becomes
 * a version itself, which is what makes a restore undoable.
 *
 * Returns how many cells actually changed, so a restore that would do nothing
 * does not leave a row in the timeline claiming it did something.
 */
export function restoreInto(
  sessionId: string,
  doc: Y.Doc,
  seq: number,
  authorId: string | null,
  onlyCell: string | null,
  at: string,
): number {
  const wanted = cellsAt(sessionId, seq)
  let changed = 0

  doc.transact(() => {
    const cells = getCells(doc)
    const live = new Map(cells.toArray().map((cell, index) => [cell.get('id') as string, index]))

    for (const want of wanted) {
      if (onlyCell && want.id !== onlyCell) continue
      const index = live.get(want.id)
      if (index === undefined) {
        /*
         * The cell was deleted after this version. It comes back at the end
         * rather than at its old index: the notebook has moved on, and guessing
         * where it belongs among cells that did not exist then is worse than
         * putting it somewhere obvious.
         */
        cells.push([createCell(want.type, want.source)])
        changed++
        continue
      }
      const cell = cells.get(index) as YCell
      const source = cell.get('source') as Y.Text | undefined
      if (!source || source.toString() === want.source) continue
      source.delete(0, source.length)
      source.insert(0, want.source)
      changed++
    }
  }, RESTORE_ORIGIN)

  if (changed > 0) {
    mark(
      sessionId,
      doc,
      'restore',
      authorId,
      null,
      onlyCell ? `restored one cell from ${at}` : `restored the version from ${at}`,
    )
  }
  return changed
}
