import { tr } from '@shared/i18n'
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
  KEYFRAME_MIN_BYTES,
  type HistoricCell,
  type VersionKind,
} from '@shared/history'
import {
  addBook,
  allCellArrays,
  bookList,
  BOOKS_KEY,
  cloneCell,
  CELLS_KEY,
  createCell,
  defaultBookName,
  getMeta,
  replaceText,
  type YCell,
} from '@shared/notebook'
import { plural } from '@shared/plural'
import { appendVersion, hasHistoryBase, trimHistory, updatesUpTo, versionCount } from '../db.js'
import { appendActivity } from '../activity.js'
import type { ParticipantRole } from '@shared/protocol'

/** Marks writes this module makes into a live doc, so they are not re-recorded twice. */
export const RESTORE_ORIGIN = 'history-restore'

interface Burst {
  sessionId: string
  /**
   * Who typed. A set, not one: see `record`. Only people — the server (the
   * kernel, the oracle) writes into a burst but does not become an author.
   *
   * While it was one person, a change of author closed the burst — and two
   * students typing in one room at the same time produced a version per
   * keystroke. Forty keystrokes gave forty history rows and six megabytes of
   * bytes, and a "before the exercise" checkpoint fell out of a four-hundred-row
   * window within tens of seconds. A burst two people wrote into is recorded as
   * such — "the room".
   */
  authors: Set<string>
  /** Only authenticated direct edits; on-behalf Oracle operations are not independent participation. */
  contributors: Map<string, ParticipantRole>
  updates: Uint8Array[]
  /**
   * State of the document when the burst opened, for the summary and the counts.
   *
   * `null` means "there is a shadow document, nothing to ask": it is this very
   * state, and its bytes are needed by nobody unless the burst has to be
   * rebuilt the fallback way (see `close`).
   */
  before: Uint8Array | null
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

/**
 * The same baseline, but as a live document — one per room.
 *
 * Closing a burst has to know what the notebook looks like AFTER it, and it
 * knew in the only way it had: rebuilding the document from the baseline and
 * the merged update. That is a full parse of two megabytes per burst — a
 * measurement on a 2.2 MB notebook gave 37 milliseconds of blocked event loop
 * to write a kilobyte and a half of difference. And a burst closes not only on
 * silence: any addition, deletion or drag of a cell closes it immediately, so
 * in a room where cells are being moved, those 37 milliseconds stand between
 * everyone else's keystrokes.
 *
 * The document is kept alive and advanced by THE SAME merged update: a
 * millisecond instead of thirty-seven. The full rebuild remains the fallback —
 * for a room that was just brought up, and for the case when applying failed
 * for some reason.
 *
 * The price is a copy of the notebook in memory per active room. It is also the
 * first thing released: `forgetHistory` drops it together with the room's
 * eviction, and rooms are evicted after ten minutes of emptiness.
 */
const shadows = new Map<string, Y.Doc>()

/** How much the last computed full copy weighed — an estimate for keyframes. */
const sizes = new Map<string, number>()

/**
 * The baseline's bytes — if and only if someone really asked for them.
 *
 * Two parties ask: a room without a shadow document (its burst will have to be
 * rebuilt) and the history repair. Everyone else is fine with the shadow
 * document itself, and unfolding a notebook into bytes costs milliseconds per
 * megabyte.
 */
function baselineBytes(sessionId: string): Uint8Array {
  const cached = baselines.get(sessionId)
  if (cached) return cached
  const shadow = shadows.get(sessionId)
  const empty = shadow ? null : new Y.Doc()
  const bytes = Y.encodeStateAsUpdate(shadow ?? empty!)
  empty?.destroy()
  baselines.set(sessionId, bytes)
  if (shadow) sizes.set(sessionId, bytes.byteLength)
  return bytes
}

/** Set the room's shadow document, dropping the previous one. */
function setShadow(sessionId: string, doc: Y.Doc | null): void {
  const had = shadows.get(sessionId)
  if (had && had !== doc) {
    shadows.delete(sessionId)
    had.destroy()
  }
  if (doc) shadows.set(sessionId, doc)
}

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
 * The cell texts as of the last close — what the next burst is compared with.
 *
 * Before, every close unfolded the document twice: once "before", once
 * "after". On a three-megabyte notebook that is seven milliseconds of blocked
 * event loop per keystroke — while "before" had already been unfolded last
 * time and could have been remembered. Here we remember it; if there is no
 * entry (the server has just started), we unfold as before.
 */
const digests = new Map<string, Map<string, string>>()

/**
 * Rooms whose history chain is missing a row.
 *
 * In memory, because the cure is in memory too: the next successful burst close
 * writes a full snapshot. A server restart clears the mark by itself —
 * `beginHistory` checks the live document against the history and writes the
 * same snapshot.
 */
const gaps = new Set<string>()

/**
 * Start recording a room, measuring from the state it currently holds.
 *
 * Called once the document is hydrated and before it is seeded, so a brand-new
 * seminar records its starter cells as its first version and a restarted one
 * does not record its whole notebook as somebody's edit.
 */
export function beginHistory(sessionId: string, doc: Y.Doc): void {
  const snapshot = Y.encodeStateAsUpdate(doc)
  baselines.set(sessionId, snapshot)
  sizes.set(sessionId, snapshot.byteLength)
  // The shadow document comes from the same bytes: one parse per room open
  // instead of one per closed burst. See `shadows`.
  setShadow(sessionId, docFrom([snapshot]))
  shapes.set(sessionId, shapeOf(doc))
  // The remembered texts keep step with the baseline: comparing the next burst
  // with someone else's cast means attributing to it everything that came
  // before it.
  digests.set(sessionId, new Map(cellsOf(doc).map((c) => [c.id, c.source])))

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
  if (hasHistoryBase(sessionId)) {
    repairHistory(sessionId, doc)
    return
  }
  appendVersion({
    sessionId,
    update: Y.encodeStateAsUpdate(doc),
    kind: 'opened',
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: versionCount(sessionId) > 0 ? tr("server.notebookAtThisPoint.ccc077") : tr("server.opened.e716b0"),
    added: 0,
    removed: 0,
    cells: [],
  })
}

/** "Everything recorded": the `updatesUpTo` address is a ceiling, not an exact row. */
const LATEST = Number.MAX_SAFE_INTEGER

/**
 * Repair a history that has drifted apart from the room's notebook.
 *
 * It can drift apart in two ways, and both end equally silently.
 *
 * The first: rooms recorded before the order "seed first, then history" was
 * fixed have a base row taken from an EMPTY document. The row exists,
 * `hasHistoryBase` is satisfied, and everything unfolds into zero cells.
 *
 * The second: a hard end of the process — kill -9, OOM, a power cut. The
 * document snapshot is written after 4–15 seconds, and a history row when a
 * burst closes (up to ninety seconds); a regular exit writes out the open burst
 * itself (flushAllHistory), a sudden one does not manage to. On disk there
 * remains text that is not in the history, and all later deltas refer to
 * clocks that will not be in the chain: Yjs puts them into pending and
 * silently does not apply them. The timeline freezes at the pre-crash state,
 * and "Restore" writes it over the live notebook — for the whole room and with
 * no way back.
 *
 * The past cannot be restored this way: those bytes do not exist anywhere. But
 * the future is saved by one row — a snapshot of what is in the room now. All
 * later replays will start from it.
 *
 * The price: one rebuild of the latest version per room open — the same work
 * as one click on the timeline, because the replay goes from the freshest
 * snapshot, not from the start of the seminar.
 */
function repairHistory(sessionId: string, doc: Y.Doc): void {
  // The live document is empty — there is nothing to compare with, and the
  // repair would be writing emptiness over emptiness.
  if (cellsOf(doc).length === 0) return

  const replay = new Y.Doc()
  let damage: 'unreadable' | 'behind' | null = null
  try {
    replay.transact(() => {
      for (const update of updatesUpTo(sessionId, LATEST)) Y.applyUpdate(replay, update, 'history')
    })
    if (replay.getArray(CELLS_KEY).length === 0) damage = 'unreadable'
    else if (behind(replay, doc)) damage = 'behind'
  } catch {
    damage = 'unreadable'
  }
  replay.destroy()
  if (damage === null) return

  appendVersion({
    sessionId,
    update: Y.encodeStateAsUpdate(doc),
    kind: 'keyframe',
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: tr("server.notebookAtThisPoint.ccc077"),
    added: 0,
    removed: 0,
    cells: [],
  })
  forgetCache(sessionId)
  console.warn(
    damage === 'unreadable'
      ? `[history] ${sessionId}: the history base was taken from an empty document — ` +
          `no version could be rebuilt. Wrote a snapshot of the current notebook; ` +
          `versions before it remain unreadable.`
      : `[history] ${sessionId}: the history fell behind the notebook on disk — the process ` +
          `died with an unclosed burst. Wrote a snapshot of the current notebook; ` +
          `edits that never reached the history cannot be recovered.`,
  )
}

/**
 * Whether the live document has something the history does not.
 *
 * Two questions, because Yjs answers "what changed" in two places. What is
 * written raises its client's counter, so a higher counter means bytes the
 * history has not reached. Deletion does not move clocks — it lives in the
 * delete set — so the notebook's cell list is compared separately.
 */
function behind(replay: Y.Doc, doc: Y.Doc): boolean {
  const known = Y.decodeStateVector(Y.encodeStateVector(replay))
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
    if ((known.get(client) ?? 0) < clock) return true
  }
  const live = cellsOf(doc)
  const stored = cellsOf(replay)
  if (live.length !== stored.length) return true
  return live.some(
    (cell, i) =>
      cell.id !== stored[i].id || cell.type !== stored[i].type || cell.source !== stored[i].source,
  )
}

/**
 * What a version did, in the words the timeline shows.
 *
 * Computed by comparing the document before the burst with the document after
 * it — not by inspecting the update bytes. The bytes say which items changed;
 * the reader wants to know that cell 04 was edited, and only the two documents
 * can say that.
 */
function describe(
  was: Map<string, string>,
  now: Map<string, string>,
): {
  summary: string
  added: number
  removed: number
  cells: string[]
} {
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

  /*
   * The version's words — in Russian, because nobody parses them: the server
   * composes the line, and the feed (web/src/components/panels/HistoryTab.svelte
   * · saying) prints it as is. The panel speaks to the class in Russian, and an
   * English caption stood in it next to the author's Russian name.
   *
   * The number goes through the shared numeral rule, not "N cells" by
   * substitution: "21 ячеек" and "2 ячеек" are exactly the mistake that
   * `plural` lives in shared for.
   */
  const cells = (n: number): string => tr('server.historyCells', { count: n })

  let summary: string
  if (created.length > 0 && changed.length === 0 && deleted.length === 0) {
    summary = created.length === 1 ? tr("server.addedACell.b6ba53") : tr("server.added.f985c7", { p0: cells(created.length) })
  } else if (deleted.length > 0 && created.length === 0 && changed.length === 0) {
    summary = deleted.length === 1 ? tr("server.deletedACell.e08aef") : tr("server.deleted.9e3b01", { p0: cells(deleted.length) })
  } else if (changed.length === 1 && created.length === 0 && deleted.length === 0) {
    summary = tr("server.editedCell.58cff0", { p0: number(changed[0]) })
  } else if (changed.length > 1 && created.length === 0 && deleted.length === 0) {
    summary = tr("server.edited.50f36f", { p0: cells(changed.length) })
  } else if (created.length + changed.length + deleted.length === 0) {
    // Nothing anybody wrote changed. The caller drops these — see close().
    summary = ''
  } else {
    summary = tr("server.reworkedTheNotebook.c8708b")
  }

  return { summary, added, removed, cells: [...new Set([...created, ...changed, ...deleted])] }
}

/**
 * A free name for the room's notebook being brought back.
 *
 * The history does not store its former path — it stores cells — and the
 * default name may have gone to someone else in the meantime.
 */
function freeBookName(doc: Y.Doc): string {
  const taken = new Set(bookList(doc).map((book) => book.path))
  const preferred = defaultBookName()
  if (!taken.has(preferred)) return preferred
  for (let n = 2; n < 100; n++) {
    const candidate = tr("server.notebookIpynb.9616a7", { p0: n })
    if (!taken.has(candidate)) return candidate
  }
  return preferred
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

/**
 * Which cells exist and in what order — the notebook's shape, not its text.
 *
 * Over ALL of the room's notebooks, not one. It looked only at `CELLS_KEY`, and
 * moving a cell in the second notebook did not close the burst: the "moved a
 * cell" row reached the feed after twelve seconds of silence or never at all,
 * merged into someone else's typing.
 *
 * A separator between notebooks is mandatory: without it moving a cell from one
 * notebook to the next gave the very same string and looked like "nothing
 * changed".
 */
function shapeOf(doc: Y.Doc): string {
  const parts: string[] = []
  for (const cells of allCellArrays(doc)) {
    for (const cell of cells.toArray()) parts.push(String(cell.get('id') ?? ''))
    parts.push('|')
  }
  return parts.join(',')
}

/**
 * The arrays because of which the notebook's shape has to be recomputed.
 *
 * The cell lists themselves and the list of notebooks. The terminal and the
 * oracle feed are also `Y.Array`s in the same document, and the shape cannot
 * change through them: cells do not live in them. Without this distinction the
 * kernel's output stream would rebuild the shape on every buffer flush.
 */
function shapingArrays(doc: Y.Doc): Y.AbstractType<any>[] {
  const arrays: Y.AbstractType<any>[] = [...allCellArrays(doc)]
  const books = getMeta(doc).get(BOOKS_KEY)
  if (books instanceof Y.Array) arrays.push(books)
  return arrays
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

/**
 * The notebook after a burst, rebuilt from scratch — the fallback.
 *
 * Three sources, in decreasing accuracy: the baseline bytes taken when the
 * burst opened; the same bytes from the module's memory; the history itself.
 * The last one is for a room whose shadow notebook failed in the middle of
 * work: by that moment nobody holds the baseline bytes anymore, and assembling
 * "after" from one merged update would mean writing a keyframe of a notebook
 * made of that one edit. The replay goes from the nearest snapshot, not from
 * the start of the seminar.
 */
function rebuiltAfter(sessionId: string, before: Uint8Array | null, merged: Uint8Array): Y.Doc {
  const bytes = before ?? baselines.get(sessionId) ?? null
  if (bytes) return docFrom([bytes, merged])
  return docFrom([...updatesUpTo(sessionId, LATEST), merged])
}

/** Close a burst and write it as one version. */
function close(key: string): void {
  const burst = bursts.get(key)
  if (!burst) return
  bursts.delete(key)
  if (burst.timer) clearTimeout(burst.timer)
  if (burst.updates.length === 0) return

  const merged = Y.mergeUpdates(burst.updates)
  /*
   * "Before" is taken from memory, not unfolded again.
   *
   * It is the same document that was "after" last time: its texts were already
   * computed and put here. Unfolding it a second time is seven milliseconds of
   * blocked event loop per keystroke on a three-megabyte notebook. The entry
   * disappears only on a server restart, and then we unfold as before.
   *
   * And this is computed BEFORE the shadow document is advanced: it is the
   * "before", and advanced it would answer the question "what changed" with
   * "nothing".
   */
  const shadow = shadows.get(burst.sessionId) ?? null
  let was = digests.get(burst.sessionId)
  if (!was) {
    const before = shadow ?? docFrom([burst.before ?? baselineBytes(burst.sessionId)])
    was = new Map(cellsOf(before).map((c) => [c.id, c.source]))
    if (before !== shadow) before.destroy()
  }
  /*
   * "After" is the baseline advanced by this burst, and it is advanced in
   * place: the room's shadow document lives between closes (see `shadows`).
   * Rebuilding it is the fallback: a room brought up by this process for the
   * first time, and an apply that failed for some reason.
   */
  let after = shadow
  if (after) {
    try {
      Y.applyUpdate(after, merged, 'history')
    } catch (err) {
      console.error(`[history] the shadow notebook of ${burst.sessionId} rejected a burst`, err)
      setShadow(burst.sessionId, null)
      after = null
    }
  }
  if (!after) {
    after = rebuiltAfter(burst.sessionId, burst.before, merged)
    setShadow(burst.sessionId, after)
  }
  const now = new Map(cellsOf(after).map((c) => [c.id, c.source]))
  const facts = describe(was, now)

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
  /*
   * Filtered from the TIMELINE, never from the RECORD.
   *
   * These are different things and they used to be one. The bytes of a burst
   * that changed no text were thrown away with its row, and Yjs does not
   * forgive that: every later update names the clocks it was built on, so a
   * replay that skips a burst reaches an update whose predecessor is missing
   * and quietly applies nothing from there on. Rebuilding any version after
   * the gap gave a document with the old cell order and none of the typing
   * since — and restoring it wrote that document over the live one, for
   * everybody. The row was invisible; the hole it left was not.
   *
   * So a burst with nothing to say still writes its bytes, as a `quiet` row
   * the list does not show. Same trick as the keyframe: present for replay,
   * absent from the story.
   *
   * Two things land here that describe() cannot see and that are not noise:
   * moving a cell (a clone with the same id and text — Y.Array has no move)
   * and changing its type. Both are structural facts the timeline should tell,
   * and one day will; today the important thing is that they no longer
   * corrupt everything recorded after them.
   */
  const quiet = facts.cells.length === 0

  let wrote = false
  try {
    const versionSeq = appendVersion({
      sessionId: burst.sessionId,
      update: merged,
      kind: quiet ? 'quiet' : 'edit',
      // One author — their name; two or more — "the room", which is the truth.
      // An empty set means only the server wrote, and that is the room too.
      authorId: burst.authors.size === 1 ? [...burst.authors][0] : null,
      createdAt: burst.lastAt,
      label: null,
      ...facts,
    })
    // Participation comes from proven changed notebook types, not the primary
    // notebook's net diff: secondary books and edits later undone can be quiet.
    for (const [participantId, role] of burst.contributors) {
      appendActivity(burst.sessionId, participantId, 'notebook.contributed', {
        versionSeq, count: 1, source: 'participant',
      }, role)
    }
    wrote = true
  } catch (err) {
    // A history that cannot be written must not stop the seminar being taught.
    console.error(`[history] could not record a version for ${burst.sessionId}`, err)
    gaps.add(burst.sessionId)
  }
  // The next version is measured from here, not from wherever the document
  // happens to be when somebody next presses a key. It moves even after a
  // failure: the burst's bytes are gone anyway, and the next version must
  // describe the difference from what is really in the room.
  /*
   * Not a single unfolding of the document into bytes per close.
   *
   * Bytes were needed three times — for the baseline, for the "is it time for a
   * snapshot" estimate and for the snapshot itself — and were computed once.
   * Now the baseline is the shadow document itself, the estimate goes by the
   * remembered size, and the snapshot is computed where it is really written,
   * that is, rarely. On a 2.2 MB notebook that is seven milliseconds of event
   * loop taken off every close.
   *
   * The baseline bytes must not be older than the shadow document, though: by
   * forgetting them here we make the next one to ask compute them anew from it.
   */
  baselines.delete(burst.sessionId)
  shapes.set(burst.sessionId, shapeOf(after))
  digests.set(burst.sessionId, now)
  if (gaps.has(burst.sessionId)) {
    /*
     * An unwritten row is a hole in the chain.
     *
     * Its bytes no longer exist, and the next delta will refer to clocks that
     * are not in the history: the replay will silently put it into pending, the
     * feed will freeze at the pre-failure state, and "Restore" of any row after
     * the hole will write that state over the live notebook. Only a whole
     * document closes the hole, so the room is marked until the first
     * successful snapshot — an ordinary keyframe does not fit here, it comes by
     * byte count and may never come at all.
     */
    if (writeKeyframe(burst.sessionId, after)) gaps.delete(burst.sessionId)
  } else if (wrote) {
    // Quiet rows count toward the keyframe interval too: they are replayed
    // like any other, so they are exactly what the interval is bounding.
    maybeKeyframe(burst.sessionId, after, merged.byteLength)
  }
  // `after` is not destroyed: it is the room's shadow document, which the next
  // close will start from. Eviction drops it (`forgetHistory`).
}

/**
 * Bytes accumulated since the last full snapshot, per room.
 *
 * Lives in memory and does not survive everything: after a server restart the
 * counter starts anew, and the first snapshot in a room will come by row count.
 * That is cheaper than storing it in the database for the sake of an estimate
 * that is approximate anyway.
 */
const sinceKeyframe = new Map<string, number>()

/**
 * A full document snapshot — once the deltas already weigh as much as it does.
 *
 * The rule used to be "every twenty-five rows", and on a three-megabyte
 * notebook it meant three megabytes every twenty-five keystrokes: over a class
 * such a seminar wrote hundreds of megabytes of snapshots, with a hundred
 * kilobytes of real edits between them. What must be counted is not rows but
 * bytes: a full copy makes sense exactly when as many deltas have accumulated
 * since the last copy — then the history takes twice the document, not an
 * arbitrary multiple of it.
 *
 * The row threshold stays on top: it bounds not space but the length of a
 * replay, and without it a tiny notebook with a thousand small edits would be
 * assembled from a thousand pieces.
 */
function maybeKeyframe(sessionId: string, doc: Y.Doc, wrote: number): void {
  /*
   * The size comes from memory, not from a fresh unfolding of the document into
   * bytes.
   *
   * Before, every closed burst computed the bytes and answered this question for
   * free along the way. Now nobody computes them (see `close`), and the decision
   * "is it time for a snapshot" is not worth seven milliseconds of event loop:
   * it is approximate anyway. The remembered size is updated on every written
   * copy, that is, exactly when it changes noticeably.
   */
  const size = sizes.get(sessionId) ?? KEYFRAME_MIN_BYTES
  const grown = (sinceKeyframe.get(sessionId) ?? 0) + wrote
  sinceKeyframe.set(sessionId, grown)

  const byBytes = grown >= Math.max(size, KEYFRAME_MIN_BYTES)
  /*
   * The row ceiling — with a byte threshold of its own, not by itself.
   *
   * The rule "every two hundred rows" bounds the length of a replay, and that is
   * right. But two hundred rows in a live seminar are most often two hundred
   * QUIET rows: cell output, run state, the oracle's stream. Their deltas are
   * tiny, while a full copy is megabytes, and on a notebook with images that was
   * a megabyte of snapshot for every few kilobytes of difference. Replaying two
   * hundred small updates takes fractions of a millisecond, so the bound loses
   * nothing: a snapshot comes when at least some difference has accumulated.
   */
  const byRows = versionCount(sessionId) % KEYFRAME_EVERY === 0 && grown >= KEYFRAME_MIN_BYTES
  if (!byBytes && !byRows) return

  writeKeyframe(sessionId, doc)
}

/**
 * A full snapshot of the document as a separate row. Says whether it was
 * written.
 *
 * As a document, not bytes: unfolding into bytes is the most expensive work on
 * this path, and it is done exactly here, that is, only when a snapshot is
 * really written. The room's remembered size is updated here too (see
 * `maybeKeyframe`).
 */
function writeKeyframe(sessionId: string, doc: Y.Doc): boolean {
  const snapshot = Y.encodeStateAsUpdate(doc)
  sizes.set(sessionId, snapshot.byteLength)
  try {
    appendVersion({
      sessionId,
      update: snapshot,
      kind: 'keyframe',
      authorId: null,
      createdAt: Date.now(),
      label: null,
      summary: '',
      added: 0,
      removed: 0,
      cells: [],
    })
  } catch (err) {
    console.error(`[history] could not write a keyframe for ${sessionId}`, err)
    return false
  }
  sinceKeyframe.set(sessionId, 0)
  /*
   * The history ceiling — here and only here.
   *
   * The only moment when trimming is safe: a snapshot has just landed, and the
   * replay of everything after it does not look at any row thrown away.
   * `trimHistory` cuts whole segments between snapshots — why exactly so is
   * explained in detail at it; the database removes nothing by itself, because
   * "when it is allowed" is known by this side, not by it.
   */
  try {
    const dropped = trimHistory(sessionId)
    if (dropped > 0) {
      console.log(`[history ${sessionId}] history hit its ceiling: removed ${dropped} rows`)
    }
  } catch (err) {
    // Trimming failed: no harm to the class — space runs out later; the version is in.
    console.error(`[history] could not trim history for ${sessionId}`, err)
  }
  return true
}

/**
 * Whether this update could have changed the set or order of cells.
 *
 * Without a transaction the answer is "could have": not knowing is not the same
 * as "no".
 */
function mayHaveReshaped(doc: Y.Doc, transaction: Y.Transaction | undefined): boolean {
  if (!transaction) return true
  let arrays = false
  transaction.changed.forEach((_keys, type) => {
    if (type instanceof Y.Array) arrays = true
  })
  if (!arrays) return false
  return shapingArrays(doc).some((array) => transaction.changed.has(array))
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
  /*
   * The transaction that produced the update — if the caller knows it.
   *
   * Needed for exactly one thing: to understand whether the notebook's shape
   * could have changed, without rebuilding it. The shape is a string of the
   * names of all cells, and it used to be glued together on EVERY update: on
   * every keystroke of any participant and on every output buffer flush. On a
   * notebook of five hundred cells that is six kilobytes of garbage per frame
   * where frames are most numerous.
   *
   * Only a write into a cell list or the list of notebooks changes the shape;
   * typing goes into the `Y.Text` inside a cell and cannot touch it. If what
   * changed is not said (that is how tests call it), we count as before.
   */
  transaction?: Y.Transaction,
  directContributor?: { participantId: string; role: ParticipantRole },
): void {
  const key = sessionId
  const existing = bursts.get(key)
  const now = Date.now()

  /*
   * A second person joins the burst rather than closing it.
   *
   * "A different person is a different thing done" sounds right and costs a
   * lot: two people typing at the same time alternate keystrokes, each closes
   * the previous burst, and the result is a version per keystroke — forty
   * history rows per minute of work, out of which the "before the exercise"
   * checkpoint falls out of the window.
   *
   * A burst two people wrote into is recorded without an author and reads as
   * "the room" — that is more honest than attributing it to whoever pressed
   * last, and just as honest as a row the server writes itself.
   *
   * The server is not counted. The kernel writes outputs, the state and the run
   * number, the oracle streams its answer — all of this arrives here without an
   * author, and a burst with them used to become two-author: a student edits a
   * cell, someone else's loop is spinning nearby, and the feed says "the room ·
   * edited cell 03" with no name and no colour. There were no two people. The
   * room is when there are two people, not when a cell was working nearby.
   */
  if (existing && authorId !== null) existing.authors.add(authorId)

  let burst = bursts.get(key)
  if (!burst) {
    burst = {
      sessionId,
      authors: authorId === null ? new Set() : new Set([authorId]),
      contributors: new Map(),
      updates: [],
      before: shadows.has(key) ? null : baselineBytes(key),
      openedAt: now,
      lastAt: now,
      chars: 0,
      timer: null,
      shape: shapes.get(key) ?? '',
    }
    bursts.set(key, burst)
  }

  burst.updates.push(update)
  if (directContributor && changedNotebook(doc, transaction)) {
    burst.contributors.set(directContributor.participantId, directContributor.role)
  }
  burst.lastAt = now
  // The server's bytes do not grow a burst: the output stream chopped someone
  // else's typing into four-kilobyte rows, while "a person wrote a lot" is about
  // what a person wrote. BURST_MAX_MS still stands on top.
  if (authorId !== null) burst.chars += update.byteLength

  /*
   * Adding, deleting or moving a cell closes the burst at once.
   *
   * Typing is a stream and wants grouping; changing the shape of the notebook
   * is a discrete act, and it is the act people come to this panel to undo. A
   * deleted cell that takes twelve seconds of silence to appear in the history
   * is missing exactly when it is being looked for — and the silence is not
   * even likely, because the person who deleted it usually keeps working.
   */
  if (mayHaveReshaped(doc, transaction) && shapeOf(doc) !== burst.shape) {
    close(key)
    return
  }

  /*
   * The burst ceiling — per EACH person writing into it.
   *
   * There is one burst per room, and a threshold of four kilobytes of human
   * bytes is about a hundred and thirty keystrokes. One typist closes a burst
   * every half minute; five hundred people typing at once reach those hundred
   * and thirty keystrokes in a fraction of a second — and the room would pay
   * `mergeUpdates` + a full document unfold + an SQLite write a dozen times a
   * second, while the version feed would fill with "the room" rows faster than
   * they can be read.
   *
   * A history row is "one thing one person did"; when there are N people in it,
   * there are as many things, so the threshold grows with them. `BURST_MAX_MS`
   * still stands on top, so a burst does not live longer than its minute with
   * any number of authors.
   */
  const room = Math.max(1, burst.authors.size)
  if (burst.chars >= BURST_MAX_CHARS * room || now - burst.openedAt >= BURST_MAX_MS) {
    close(key)
    return
  }

  if (burst.timer) clearTimeout(burst.timer)
  /*
   * The burst's tail — under its own try/catch.
   *
   * This is the only path by which `close` is called from a timer: it merges
   * updates, unfolds the document and writes to SQLite, and all of this without
   * a caller who would catch a throw. From a `setTimeout` callback it goes to
   * `uncaughtException` (server/src/index.ts), which takes down the process with
   * ALL of the instance's rooms — because of one feed of one room.
   *
   * The burst counts as closed in any case: `close` removes it from the map on
   * its very first line, before any work — otherwise a failed write would lock
   * the room's feed forever, and the following edits would pile up in a dead
   * burst until a restart.
   */
  burst.timer = setTimeout(() => {
    try {
      close(key)
    } catch (err) {
      console.error(`[history] could not close the burst for ${key}`, err)
    }
  }, BURST_IDLE_MS)
  // A pending burst must not be the reason the process stays alive; shutdown
  // flushes them all on the way out.
  burst.timer.unref?.()
}

/** Read changed types, not full cell text, on the hot path. Chat and output updates do not qualify. */
function changedNotebook(doc: Y.Doc, transaction: Y.Transaction | undefined): boolean {
  if (!transaction) return false
  if (mayHaveReshaped(doc, transaction)) return true
  for (const [type, keys] of transaction.changed) {
    if (type instanceof Y.Text && type._item?.parentSub === 'source') {
      const cell = type._item.parent
      if (cell instanceof Y.Map && ['code', 'markdown'].includes(String(cell.get('type')))) return true
    }
    if (type instanceof Y.Map && (keys.has('source') || keys.has('type'))
      && ['code', 'markdown'].includes(String(type.get('type')))) return true
  }
  return false
}

/** Close whatever is open for one session — before a read, or on shutdown. */
export function flushHistory(sessionId: string): void {
  close(sessionId)
}

export function flushAllHistory(): void {
  for (const key of [...bursts.keys()]) close(key)
}

/**
 * Release the memory about a room's history without losing anything.
 *
 * Not the same as `discardBurst`: that one throws away the started row together
 * with the seminar, while here the seminar stays — only the room leaves the
 * process's memory (collab/index.ts · eviction of idle rooms). So the open
 * burst is first written out as a row: it is somebody's work.
 *
 * Everything released here the room will rebuild by itself on the next entry:
 * `beginHistory` takes the baseline, the shape and the texts anew from the
 * document brought up from the snapshot — exactly as after a server restart.
 */
export function forgetHistory(sessionId: string): void {
  close(sessionId)
  baselines.delete(sessionId)
  setShadow(sessionId, null)
  sizes.delete(sessionId)
  shapes.delete(sessionId)
  digests.delete(sessionId)
  sinceKeyframe.delete(sessionId)
  gaps.delete(sessionId)
  forgetCache(sessionId)
}

/** Drop a session's open burst without writing it. Used when a seminar is deleted. */
export function discardBurst(sessionId: string): void {
  baselines.delete(sessionId)
  setShadow(sessionId, null)
  sizes.delete(sessionId)
  shapes.delete(sessionId)
  digests.delete(sessionId)
  sinceKeyframe.delete(sessionId)
  gaps.delete(sessionId)
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
  targetSeq: number | null = null,
): number {
  flushHistory(sessionId)
  /*
   * Restoring a version has something to show, and it showed it as "nothing".
   *
   * `added: 0, removed: 0, cells: []` is true for a checkpoint: it is set on top
   * of the text without changing anything. For a restore it is untrue: it
   * rewrites cells, and the panel, whose list of changes was empty, honestly
   * printed "This moment was marked, not edited" — above a row that had just
   * replaced half the notebook. Exactly the edit people go into the history
   * for.
   *
   * It is computed the same way as for a burst: what was before, what came
   * after.
   */
  const now = new Map(cellsOf(doc).map((c) => [c.id, c.source]))
  const facts =
    kind === 'restore'
      ? describe(digests.get(sessionId) ?? new Map(), now)
      : { summary: '', added: 0, removed: 0, cells: [] as string[] }

  const snapshot = Y.encodeStateAsUpdate(doc)
  const seq = appendVersion({
    sessionId,
    update: snapshot,
    kind,
    authorId,
    createdAt: Date.now(),
    label,
    // A restore has words of its own ("restored the version"), not the ones
    // describe composed: what matters is that it is a restore, not "edited 3".
    summary,
    added: facts.added,
    removed: facts.removed,
    cells: facts.cells,
    targetSeq,
  })
  // A row with the whole document closes a hole no worse than a snapshot: the
  // replay starts anew from it.
  gaps.delete(sessionId)
  baselines.set(sessionId, snapshot)
  sizes.set(sessionId, snapshot.byteLength)
  /*
   * And the shadow notebook stands at the same point.
   *
   * Not "advanced": a checkpoint and a version restore come from the live
   * document, and how much has changed in it since the last close is not
   * visible from here. One full rebuild per checkpoint is exactly what a burst
   * close used to be, and checkpoints are set a few per class, not dozens per
   * minute.
   */
  setShadow(sessionId, docFrom([snapshot]))
  shapes.set(sessionId, shapeOf(doc))
  digests.set(sessionId, now)
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
/**
 * Put the cells named by `order` back in that order, in place.
 *
 * Cells the version did not have keep their relative places at the end: they
 * were written after it, and a restore is not a reason to throw them away.
 * Returns how many cells actually moved, so a restore that only reorders is
 * still recorded as having changed something.
 */
function reorder(cells: Y.Array<YCell>, order: string[], busy: ReadonlySet<string>): number {
  const wanted = new Map(order.map((id, i) => [id, i]))
  const current = cells.toArray()
  const target = [...current].sort((a, b) => {
    const ai = wanted.get(a.get('id') as string)
    const bi = wanted.get(b.get('id') as string)
    if (ai === undefined && bi === undefined) return current.indexOf(a) - current.indexOf(b)
    if (ai === undefined) return 1
    if (bi === undefined) return -1
    return ai - bi
  })
  const same = target.every((cell, i) => cell === current[i])
  if (same) return 0

  /*
   * A clone takes other people's keystrokes away with it.
   *
   * `Y.Array` has no move, so a cell can be rearranged only by recreating it as
   * a clone — and keystrokes that went into the old `Y.Text` one round trip
   * before the server are addressed to a deleted structure: the gate lets them
   * through (a write into a tombstone is visible to nobody), and the characters
   * vanish for the typist silently, and Ctrl+Z will not bring them back.
   * Rebuilding the WHOLE sheet with clones meant robbing everyone who was typing
   * at that second of this — although a version restore usually moves one or
   * two cells.
   *
   * So the longest chain of cells already standing in the right order relative
   * to each other stays in place (the longest increasing subsequence by target
   * position), and only the rest are recreated as clones. A cell with someone's
   * cursor weighs more than the whole sheet: where there is a choice — as when
   * two neighbours swap places — the one being typed in right now stays. The
   * sheet is short (dozens of cells), so a quadratic search here is cheaper
   * than one extra clone.
   */
  const place = new Map(target.map((cell, i) => [cell, i]))
  const weigh = (cell: YCell) => (busy.has(cell.get('id') as string) ? current.length + 1 : 1)
  const best = current.map((cell) => weigh(cell))
  const prev = current.map(() => -1)
  let tail = 0
  for (let i = 0; i < current.length; i++) {
    for (let j = 0; j < i; j++) {
      if (place.get(current[j])! > place.get(current[i])!) continue
      if (best[j] + weigh(current[i]) <= best[i]) continue
      best[i] = best[j] + weigh(current[i])
      prev[i] = j
    }
    if (best[i] > best[tail]) tail = i
  }
  const keep = new Set<YCell>()
  for (let i = tail; i >= 0; i = prev[i]) keep.add(current[i])

  // Clones come before deletion: a crossed-out cell has nothing left to read.
  const moving = target.filter((cell) => !keep.has(cell))
  const clones = new Map(moving.map((cell) => [cell, cloneCell(cell)]))
  for (let i = current.length - 1; i >= 0; i--) if (!keep.has(current[i])) cells.delete(i, 1)
  // Top to bottom: a cell arrives at its target place when everyone who should
  // stand to its left is already standing, so the place is the insertion index.
  for (const cell of moving) cells.insert(place.get(cell)!, [clones.get(cell)!])
  return moving.length
}

/**
 * Where to put back a cell that is no longer in the notebook.
 *
 * By its neighbours in the version: right after the nearest preceding one that
 * is still alive, and if there are none — before the nearest following one. If
 * none is found — at the end.
 */
function placeFor(wanted: HistoricCell[], id: string, live: Map<string, number>): number {
  const at = wanted.findIndex((cell) => cell.id === id)
  for (let i = at - 1; i >= 0; i--) {
    const index = live.get(wanted[i].id)
    if (index !== undefined) return index + 1
  }
  for (let i = at + 1; i < wanted.length; i++) {
    const index = live.get(wanted[i].id)
    if (index !== undefined) return index
  }
  return live.size
}

export function restoreInto(
  sessionId: string,
  doc: Y.Doc,
  seq: number,
  authorId: string | null,
  onlyCell: string | null,
  /*
   * Which cells have cursors in them right now — so that the rearrangement
   * (`reorder`) leaves in place the ones being typed in. A parameter, not an
   * import from `collab/index.ts`: presence lives in the sockets, and this
   * module is called both by tests and by the route; if nothing is said, we
   * assume there are no cursors, and length decides.
   */
  busy: ReadonlySet<string> = new Set(),
): number {
  const wanted = cellsAt(sessionId, seq)
  let changed = 0

  doc.transact(() => {
    /*
     * History is about the ROOM'S NOTEBOOK, and that is its root, not "the
     * first one on the list".
     *
     * The difference shows in exactly one case and costs a lot: the room's
     * notebook was removed, another became first — and a version restore would
     * write the cells of someone else's sheet into it. The root is hard-wired
     * here on purpose; everything this module reads and writes, it reads and
     * writes there.
     *
     * If the room's notebook is no longer on the list, a version restore brings
     * it back too: that is exactly what people ask for by pressing "restore".
     */
    if (!bookList(doc).some((book) => book.root === CELLS_KEY)) {
      addBook(doc, freeBookName(doc), CELLS_KEY)
    }
    const cells = doc.getArray<YCell>(CELLS_KEY)
    const live = new Map(cells.toArray().map((cell, index) => [cell.get('id') as string, index]))

    for (const want of wanted) {
      if (onlyCell && want.id !== onlyCell) continue
      const index = live.get(want.id)
      if (index === undefined) {
        /*
         * The cell was deleted after this version, so it is recreated — with
         * its own id, not a fresh one. A new id made the restore
         * unrepeatable: press it twice and the notebook had two copies,
         * because the second pass could not find what the first had put back.
         *
         * On a full rollback the place is decided by reorder below, once all
         * cells are there. reorder deliberately does not touch a single cell,
         * so its place is computed here: "Restore this cell" on the third of
         * twenty put it twentieth, under all the others, and it had to be
         * moved up by hand.
         */
        const revived = createCell(want.type, want.source, want.id)
        if (onlyCell) cells.insert(placeFor(wanted, want.id, live), [revived])
        else cells.push([revived])
        changed++
        continue
      }
      const cell = cells.get(index) as YCell
      const source = cell.get('source') as Y.Text | undefined
      let touched = false
      /*
       * The cell type is part of the version too.
       *
       * A cell with working code was switched to markdown, the rollback brought
       * back the text — and left markdown: Run does not work on it, "Run All"
       * skips it. And if only the type changed, the rollback left from here
       * having done nothing and left no row — the "restore" button stayed
       * silent.
       */
      if (cell.get('type') !== want.type) {
        cell.set('type', want.type)
        touched = true
      }
      if (source && source.toString() !== want.source) {
        // Not "all text vanished, other text appeared": everyone standing in
        // this cell would have their cursor jump to the start. Only what
        // differs is changed.
        replaceText(source, want.source)
        /*
         * Restoring a version takes the run number off the result.
         *
         * This was the most inconsistent place there was: a run, which may
         * well give the very same result, erased the output entirely, while a
         * version restore — an event that unambiguously devalues the result —
         * touched nothing. Now both say one thing: the output stays as
         * evidence of what the cell showed, and stops being credited to code
         * that is no longer in it.
         *
         * `state` too: an "ok" recorded about vanished code is not this cell's
         * outcome.
         */
        cell.set('execCount', null)
        cell.set('ranMs', null)
        cell.set('state', 'idle')
        touched = true
      }
      if (touched) changed++
    }

    /*
     * Order is part of the version too.
     *
     * "Restore the whole notebook" put every text back and left the cells
     * wherever they had since been dragged, which is not the notebook anybody
     * pressed the button for. Only for a whole restore: putting one cell back
     * is about that cell, and shuffling the sheet around it would be a
     * surprise nobody asked for.
     */
    if (!onlyCell)
      changed += reorder(
        cells,
        wanted.map((w) => w.id),
        busy,
      )
  }, RESTORE_ORIGIN)

  if (changed > 0) {
    /*
     * No time in the words: the server built it in its own time zone (UTC in a
     * container), while the feed rows are drawn by the browser in its own — the
     * caption "restored the version from 15:04" pointed at a row that is not in
     * the list. What exactly was restored is said by `targetSeq`; the clock is
     * drawn by whoever looks.
     */
    mark(
      sessionId,
      doc,
      'restore',
      authorId,
      null,
      onlyCell ? tr("server.restoredACell.0f74d0") : tr("server.restoredAVersion.80c38a"),
      seq,
    )
  }
  return changed
}
