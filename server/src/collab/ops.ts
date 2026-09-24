/**
 * Edits to a notebook's structure that the server makes, not the browser.
 *
 * This holds exactly what does not fit the rule "only the server writes
 * output". Moving a cell is the only client operation that is mixed by
 * nature: Y.Array has no move, so one of the two neighbouring cells has to be
 * recreated as a clone, and the clone carries along everything the cell
 * printed. Reordering a notebook is no reason to throw output away; writing
 * someone else's output from the browser is not allowed. The two cannot be
 * reconciled in the browser, so the whole operation moves here.
 *
 * Three consequences, and all three are needed: output survives a move
 * without ever being written by a client; the "append only" rule cannot be
 * bypassed by moving someone else's cell into oblivion; and the only mixed
 * client transaction in the product ceases to exist, so "a frame is judged as
 * a whole" costs nothing.
 */
import * as Y from 'yjs'
import {
  cellId,
  cloneCell,
  readCell,
  writeOutput,
  type CellSnapshot,
  type YCell,
  findCell,
} from '@shared/notebook'

const EMPTY: ReadonlySet<string> = new Set()

/**
 * Which cells currently have carets in them. The source is registered by
 * `collab/index.ts`.
 *
 * Through registration rather than an import: presence lives in the sockets,
 * while this module is the one the test goes to, and it has no reason to drag
 * the database and sockets along. If nobody has registered, we assume there
 * are no carets.
 */
let carets: ((doc: Y.Doc) => ReadonlySet<string>) | null = null

export function onCarets(source: (doc: Y.Doc) => ReadonlySet<string>): void {
  carets = source
}

/**
 * Write a cell key only if it really changes.
 *
 * `Y.Map.set` creates a new item even for the same value: that is a tick in
 * the document, an extra item in the snapshot and a server update — and a
 * server update opens a history burst with no author, so a person's edit that
 * landed in the same burst was signed "the room". Six such writes went out for
 * every added cell, which had nothing to change in the first place.
 */
function put(cell: YCell, key: string, value: unknown): void {
  if (cell.get(key) === value) return
  cell.set(key, value)
}

/**
 * Swap a cell with its neighbour.
 *
 * Opens no transaction of its own: the caller wraps it — in `applyOnBehalf` —
 * because the version in history must have an author, otherwise the move
 * reads as "the room" and Ctrl+Z of whoever pressed the button cannot reach
 * it.
 *
 * `false` is not an error but a race: the button was drawn from a document
 * that lags one round trip behind the server.
 */
export function moveInCells(doc: Y.Doc, id: string, direction: -1 | 1): boolean {
  // In the notebook where the cell lives: a room has several, and "above" and
  // "below" only make sense within one.
  const found = findCell(doc, id)
  if (!found) return false
  const cells = found.cells
  const from = found.index
  const to = from + direction
  if (to < 0 || to >= cells.length) return false

  /*
   * The neighbour moves, not the cell being moved: recreating a cell kills the
   * editor along with the caret, and the caret sits in the cell whose button
   * was pressed. The result of the swap does not depend on the choice.
   *
   * But a clone costs more than a caret, and it is not the presser who pays.
   * Keystrokes that went into the old `Y.Text` a round trip ahead of the
   * server are addressed to a removed structure: the gate lets them through (a
   * write into a tombstone is visible to no one), and the characters vanish
   * silently for the typist — Ctrl+Z will not bring them back, they lie in the
   * tombstone. So if someone's caret is in the neighbour, the cell being moved
   * is the one recreated: it holds the presser's caret, and at that moment the
   * presser is pressing, not typing.
   */
  const busy = carets?.(doc) ?? EMPTY
  if (busy.has(cellId(cells.get(to)))) {
    const moved = cloneCell(cells.get(from))
    cells.delete(from, 1)
    cells.insert(to, [moved])
    return true
  }

  const neighbour = cloneCell(cells.get(to))
  cells.delete(to, 1)
  cells.insert(from, [neighbour])
  return true
}

/**
 * Clear the execution state of cells that have become text.
 *
 * "Convert to text" sits in the same toolbar as "stop", one click away from a
 * running cell, and not clearing the stopwatch means leaving it ticking on a
 * cell that is no longer a code cell. The browser used to write this, and it
 * was the only place where it wrote execution state; while that existed, the
 * rule "only the server writes output and state" had an exception — that is,
 * it was not a rule.
 */
export function resetRetyped(doc: Y.Doc, cellIds: string[]): void {
  for (const id of cellIds) {
    const found = findCell(doc, id)
    if (!found) continue
    const cell = found.cell
    if (cell.get('type') !== 'markdown') continue
    put(cell, 'state', 'idle')
    put(cell, 'execCount', null)
    put(cell, 'startedAt', null)
    put(cell, 'ranMs', null)
    const outputs = cell.get('outputs')
    if (outputs instanceof Y.Array && outputs.length > 0) outputs.delete(0, outputs.length)
  }
}

/**
 * What the server remembers about deleted cells, so that undoing a deletion
 * brings them back whole.
 *
 * Otherwise Ctrl+Z after deleting a cell that had run broke in every room and
 * under any rules, and it would break silently and loudly at once: Yjs undoes
 * a deletion with a COPY, that is, the browser offers the server a new cell
 * carrying ready-made output — and the room's floor forbids the browser to
 * write output. Refusing would mean forcing the person to rebuild the document
 * over an ordinary Ctrl+Z.
 *
 * So the server returns the output, from its own record rather than from what
 * the browser sent: the floor stays intact — output the server did not
 * produce still never gets into the document — and the gesture works.
 */
interface Remembered {
  at: number
  cell: CellSnapshot
}

/** Per seminar: cell name → what it was at the moment of deletion. */
const graves = new Map<string, Map<string, Remembered>>()

/**
 * How many deletions a seminar remembers, and for how long.
 *
 * Undo is an immediate gesture: whoever has not remembered within ten minutes
 * will not remember. The ceiling of thirty cells keeps memory bounded in a
 * seminar where people clean up the notebook.
 */
const GRAVE_TTL_MS = 10 * 60 * 1000
const GRAVE_MAX = 30

/** Remember a cell before accepting its deletion. */
export function rememberDeleted(sessionId: string, doc: Y.Doc, cellIds: string[]): void {
  if (cellIds.length === 0) return
  let room = graves.get(sessionId)
  if (!room) graves.set(sessionId, (room = new Map()))
  const now = Date.now()
  for (const id of cellIds) {
    // By name, across all notebooks of the room — the way the gate looks, the
    // very gate that named these ids. While the root `cells` stood here, the
    // server remembered not a single deletion in the second notebook, and
    // Ctrl+Z on a cell that had run hit the refusal "a new cell declares
    // itself as having run".
    const found = findCell(doc, id)
    if (!found) continue
    const snapshot = readCell(found.cell)
    // No point remembering an empty cell — there is nothing to return.
    if (snapshot.outputs.length === 0 && snapshot.execCount === null) continue
    room.set(id, { at: now, cell: snapshot })
  }
  for (const [id, grave] of room) {
    if (now - grave.at > GRAVE_TTL_MS) room.delete(id)
  }
  while (room.size > GRAVE_MAX) room.delete(room.keys().next().value as string)
}

export function forgetSession(sessionId: string): void {
  graves.delete(sessionId)
}

/**
 * Bring freshly created cells in line with what the server knows.
 *
 * Two branches, and both are mandatory. A cell the server remembers as
 * deleted is an undo: it gets its output and state back FROM THE SERVER'S
 * RECORD, not from the frame. Every other new cell is clean: output that the
 * browser attached to it on its own is erased — this is exactly the cell with
 * a ready-made `text/html` that blanks the screen for the whole seminar, and
 * exactly the forged "In [7]", which is less noticeable.
 */
export function settleFresh(sessionId: string, doc: Y.Doc, cellIds: string[]): void {
  if (cellIds.length === 0) return
  const room = graves.get(sessionId)
  const now = Date.now()
  for (const id of cellIds) {
    const found = findCell(doc, id)
    if (!found) continue
    const cell = found.cell
    const grave = room?.get(id)
    const remembered = grave && now - grave.at <= GRAVE_TTL_MS ? grave.cell : null

    const outputs = cell.get('outputs')
    if (outputs instanceof Y.Array) {
      if (outputs.length > 0) outputs.delete(0, outputs.length)
      if (remembered) for (const out of remembered.outputs) outputs.push([writeOutput(out)])
    }
    put(
      cell,
      'state',
      remembered?.state === 'ok' || remembered?.state === 'error' ? remembered.state : 'idle',
    )
    put(cell, 'execCount', remembered?.execCount ?? null)
    put(cell, 'runBy', remembered?.runBy ?? null)
    put(cell, 'runById', remembered?.runById ?? null)
    put(cell, 'ranMs', remembered?.ranMs ?? null)
    /*
     * And the lock comes off. A new cell is always closed — whoever created it
     * and whatever frame brought it: the right to open a cell is granted by the
     * server on a control message (control.ts · cell:open), and it can only
     * come from there. Undoing the deletion of an open cell brings it back
     * closed, and that is more honest than a refusal: the document is intact,
     * and the lock is set with one click.
     */
    if (cell.get('open') != null) cell.set('open', null)
    // And the council handles go with it: a closed cell has none, and a "run
    // for students" that arrived in a frame is the same right as the lock.
    if (cell.get('council') != null) cell.set('council', null)
    // The stopwatch and the input prompt never come back: the kernel is not
    // running this cell and is not asking it anything.
    put(cell, 'startedAt', null)
    if (cell.get('stdin') != null) cell.set('stdin', null)
    if (remembered) room?.delete(id)
  }
}
