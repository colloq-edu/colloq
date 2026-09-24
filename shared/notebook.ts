import { tr } from './i18n.js'
/**
 * The collaborative notebook document schema.
 *
 * This module is the single contract shared by the browser and the server.
 * Both sides mutate the SAME Y.Doc shape; the server participates as a regular
 * Yjs client, which is how execution outputs reach every participant (including
 * people who join after a cell has already run).
 *
 * Layout of a session Y.Doc:
 *
 *   doc.getArray('cells')  -> Y.Array<Y.Map>   ordered notebook cells
 *   doc.getMap('meta')     -> Y.Map            title, kernel status, run queue
 *
 * A cell Y.Map holds:
 *   id        string                  stable cell identity
 *   type      'code' | 'markdown'
 *   source    Y.Text                  the text everybody types into
 *   outputs   Y.Array<Y.Map>          see OutputCell below
 *   state     CellState               idle | queued | running | ok | error
 *   execCount number | null           In [n]
 *   runBy     string | null           display name of whoever pressed Run
 *   runById   string | null           and their participant id — names are not
 *                                     unique in a seminar, so this is what says
 *                                     whether a run is YOURS
 *   stdin     {prompt,password}|null  set while the cell is stopped in input()
 *   startedAt number | null           server clock at the instant this run
 *                                     began; the cell's live timer counts from
 *                                     it. Written by the kernel, never read
 *                                     unless state is 'running'
 *   ranMs     number | null           how long the last SETTLED run took. Also
 *                                     the kernel's; an interrupted run leaves
 *                                     it null, because it has no finish time
 *   open      true | 'council' | null  the lecture lock, three positions: no
 *                                     field, false or null — closed; true —
 *                                     open to everyone; 'council' — a council:
 *                                     everyone has their own sheet, the shared
 *                                     text is closed as in a closed cell (see
 *                                     cellLock)
 *   council   CouncilSettings | null  the council's knobs: runs for students
 *                                     and names on the projector. Meaningful
 *                                     only when open === 'council'; no field
 *                                     means the defaults (DEFAULT_COUNCIL)
 *
 * `stdin`, `startedAt` and `ranMs` are written only by the server and are
 * display-only: nothing in this product may gate a control on them. The list
 * above was short by one for months — `stdin` was written by the kernel and
 * documented nowhere, which is exactly how it came to be missing from cloneCell
 * and to vanish whenever a neighbouring cell moved.
 *
 * `open` is also written only by the server — on the teacher's control
 * message — but unlike the three above, a right DOES rest on it: in a lecture
 * the room types and runs in exactly the open cells (shared/rules.ts ·
 * mayEditCell). So the gate rejects a frame from a browser that brings this
 * field just as it rejects forged output: a lock you can bring along with you
 * is not a lock.
 *
 * The lock's third position — `'council'` — deliberately lives in THE SAME
 * key rather than next to it: a lock has one position, and two fields would
 * have to agree on which of them wins when both are set. To the gate a
 * council is a closed cell: `isCellOpen` answers strictly `=== true`, so in a
 * council a student does not touch the shared Y.Text and sends their attempt
 * as a snapshot over the control socket (protocol.ts · council:draft).
 * `council` holds the knobs of that same position, and they are server-side
 * for the same reason: "runs for students" is a right, not a readout.
 *
 * An output Y.Map holds:
 *   kind      'stream' | 'data' | 'error'
 *   name      'stdout' | 'stderr'     (stream only)
 *   text      Y.Text                  (stream only) appended to while running
 *   json      string                  (data/error only) JSON payload
 */
import * as Y from 'yjs'

export const CELLS_KEY = 'cells'
export const META_KEY = 'meta'
export const CHAT_KEY = 'chat'
export const TERMINAL_KEY = 'terminal'

/* --------------------------------------------------------------- notebooks */

/**
 * A room has several notebooks, and each is a file.
 *
 * There used to be one, sewn into the document as the `cells` root. That
 * turned out to be not a property of a seminar but a limitation: in class
 * people open last week's notebook next to this one, go over someone else's
 * solution, show a template. A notebook is a file just like .py and .csv, it
 * just opens as cells.
 *
 * Each notebook is its own root in the room's document, not its own document.
 * That is a decision, and here are its price and its gain. The gain: the
 * snapshot in the database, the rules gate and the browser cache work for all
 * notebooks exactly as they did for one — those three machines are untouched.
 * The price: a notebook opened once stays in the room's document for good,
 * even if the file is later removed; the snapshot grows.
 *
 * The fourth machine, version history, is not covered by this price, and the
 * opposite used to be written here. `collab/history` reads, describes and
 * restores exactly the `cells` root — it says there that this is pinned on
 * purpose — so the timeline does not show edits in the other notebooks and
 * "restore version" does not touch them. Hence `removeBook`: it does not
 * undertake to erase cells there is no way to bring back.
 *
 * The first notebook's root is still `cells`, and that is not cosmetic: rooms
 * already running keep their whole version history and the whole browser
 * cache in that root. Renaming the root would silently wipe both.
 */
export const BOOKS_KEY = 'books'
const BOOK_PREFIX = 'nb:'

/** What the room's notebook is called until it is renamed. */
export const DEFAULT_BOOK = 'Тетрадь.ipynb'
/** Only new material receives the current locale's name; stored paths are never renamed. */
export function defaultBookName(): string { return tr('server.defaultNotebook') }

export interface Book {
  /** The file's path in the seminar folder. */
  path: string
  /** The root's name in the document. For the first notebook it is `cells`. */
  root: string
}

/**
 * The root for a new notebook — its own for each, and derived from nothing.
 *
 * It used to be derived from the path (`nb:` + path), and a notebook's path is
 * not a name but an address: it gets freed. Renaming a review notebook to an
 * archive name and putting a new file under the old name is a habit every
 * couple of weeks, and both came out with the same root. Two entries shared
 * one Y.Array: the uploaded file was not read at all, edits went into both
 * tabs, the projection overwrote the very bytes it had just uploaded to disk,
 * and removing the "extra" one meant emptying both — with no way back, since
 * an `nb:` root has no version history.
 *
 * `cells` goes to the first notebook, and only while the room has never
 * created one (the `booksSeeded` flag is set by `ensureInitialNotebook`). A
 * room where a notebook was removed ON PURPOSE must not get a new one on this
 * root: restoring a version writes to `cells`, pinned, and would put the
 * cells of the room's former notebook into someone else's file.
 */
export function rootForNewBook(doc: Y.Doc): string {
  const fresh = bookList(doc).length === 0 && !getMeta(doc).get('booksSeeded')
  return fresh ? CELLS_KEY : BOOK_PREFIX + newId('b')
}

/** Is this root a notebook? The edit parser needs it: see collab/gate.ts. */
export function isBookRoot(root: string): boolean {
  return root === CELLS_KEY || root.startsWith(BOOK_PREFIX)
}

/**
 * The room's notebooks, in order.
 *
 * An empty list for a room that has not created one yet — and for every room
 * created before this list existed. The second case is fixed on the very
 * first open: see `ensureInitialNotebook`.
 */
export function bookList(doc: Y.Doc): Book[] {
  const raw = getMeta(doc).get(BOOKS_KEY)
  if (!(raw instanceof Y.Array)) return []
  const out: Book[] = []
  raw.forEach((item) => {
    if (!(item instanceof Y.Map)) return
    const path = item.get('path')
    const root = item.get('root')
    if (typeof path === 'string' && typeof root === 'string' && path) out.push({ path, root })
  })
  return out
}

function booksArray(doc: Y.Doc): Y.Array<Y.Map<any>> {
  const meta = getMeta(doc)
  const raw = meta.get(BOOKS_KEY)
  if (raw instanceof Y.Array) return raw
  const made = new Y.Array<Y.Map<any>>()
  meta.set(BOOKS_KEY, made)
  return made
}

/** The notebook at a path — or `null` if the room does not consider that file a notebook. */
export function bookAt(doc: Y.Doc, path: string): Book | null {
  return bookList(doc).find((book) => book.path === path) ?? null
}

/** A notebook's cells by its root. */
export function bookCells(doc: Y.Doc, root: string): Y.Array<YCell> {
  return doc.getArray<YCell>(root)
}

/**
 * Which notebook this cell lives in — the name of its root.
 *
 * `null` means the cell is not in the room at all. Needed wherever a cell's
 * sheet has to be found from the cell: adding a neighbor, duplicating,
 * inserting the oracle's answer next to it.
 */
export function rootOfCell(doc: Y.Doc, id: string): string | null {
  const found = findCell(doc, id)
  if (!found) return null
  try {
    return Y.findRootTypeKey(found.cells)
  } catch {
    return null
  }
}

/** A notebook's cells by path. An empty array if there is no such notebook. */
export function cellsAt(doc: Y.Doc, path: string): Y.Array<YCell> | null {
  const book = bookAt(doc, path)
  return book ? bookCells(doc, book.root) : null
}

/** The root of the room's notebook — the first in the list. */
export function mainRoot(doc: Y.Doc): string {
  return bookList(doc)[0]?.root ?? CELLS_KEY
}

/** All the room's notebooks with their cells — for passes that concern all of them. */
export function allBooks(doc: Y.Doc): { book: Book; cells: Y.Array<YCell> }[] {
  return bookList(doc).map((book) => ({ book, cells: bookCells(doc, book.root) }))
}

/**
 * All the cell arrays in the document — including the case when there is no
 * notebook list yet.
 *
 * Exactly two documents have no list: a room opened for the first time after
 * multiple notebooks appeared (the list gets added a moment later), and a
 * test document built by hand from a single root. Both must behave like a
 * room with one notebook, otherwise the checks that go over all notebooks
 * silently stop checking anything.
 */
export function allCellArrays(doc: Y.Doc): Y.Array<YCell>[] {
  const books = allBooks(doc)
  if (books.length > 0) return books.map(({ cells }) => cells)
  return [legacyCells(doc)]
}

/**
 * Record a notebook in the list.
 *
 * Idempotent: a path already there is returned as is. Otherwise two tabs that
 * opened one file at the same moment would create two notebooks for one
 * path, and half the room would be typing into the second.
 */
export function addBook(doc: Y.Doc, path: string, root?: string): Book {
  const existing = bookAt(doc, path)
  if (existing) return existing
  const made: Book = { path, root: root ?? rootForNewBook(doc) }
  const row = new Y.Map<any>()
  row.set('path', made.path)
  row.set('root', made.root)
  booksArray(doc).push([row])
  return made
}

/** The notebook moved along with its file: the root stays the same, the path changes. */
export function renameBook(doc: Y.Doc, from: string, to: string): void {
  const list = booksArray(doc)
  for (let i = 0; i < list.length; i++) {
    const row = list.get(i)
    if (row instanceof Y.Map && row.get('path') === from) row.set('path', to)
  }
}

/**
 * Remove a notebook from the room.
 *
 * From the list — always, and that is enough for it to be gone: `allBooks`,
 * `findCell` and the gate all go by the list, so nobody sees an abandoned
 * `nb:` root.
 *
 * Cells are erased only for the ROOM's notebook (the `cells` root). It is the
 * one read "from old memory" — version history looks straight into this root
 * — and it is also the only one a version restore can bring back whole, so
 * erasing here is reversible.
 *
 * The other notebooks keep their cells. Their roots have no version history,
 * and erasing them would mean losing an hour of a class's work irreversibly —
 * from a single click on a file in the tree, including an unintended one: the
 * file was removed behind the panel's back, the folder with the notebook was
 * renamed. The price is a snapshot that does not shrink; it is named in the
 * header of this section and is already paid anyway, since a root cannot be
 * thrown out of Yjs.
 */
export function removeBook(doc: Y.Doc, path: string): void {
  const list = booksArray(doc)
  for (let i = list.length - 1; i >= 0; i--) {
    const row = list.get(i)
    if (!(row instanceof Y.Map) || row.get('path') !== path) continue
    const root = row.get('root')
    list.delete(i, 1)
    if (root !== CELLS_KEY) continue
    const cells = bookCells(doc, CELLS_KEY)
    if (cells.length > 0) cells.delete(0, cells.length)
  }
}

export type CellType = 'code' | 'markdown'
export type CellState = 'idle' | 'queued' | 'running' | 'ok' | 'error'
/**
 * What is going on with a notebook's kernel — as the room sees it.
 *
 * `off` — there is NO kernel and nobody is bringing it up: the room was just
 * opened, the server was restarted, the kernel was removed for idleness, the
 * class ended. Introduced on 20 Sep 2026, because before that this state was
 * shown as `starting`: a fresh room said "STARTING python3" and hung like
 * that for hours, starting nothing. The kernel comes up lazily — on the first
 * Run (and, since 19 Sep 2026, on the first hover for help) — and an honest
 * word about that costs exactly as much as a wrong one.
 *
 * `starting` stayed what it should be: coming up IS happening right now.
 * `dead` is a real death (OOM, crash, failed to come up); it has its own red
 * badge and button; a routine doze-off for idleness must not be a red alarm.
 */
export type KernelStatus = 'off' | 'starting' | 'idle' | 'busy' | 'restarting' | 'dead'

/**
 * What to show an old tab instead of the new word.
 *
 * A tab opened before 20 Sep 2026 reads only the old `meta.kernelStatus` key
 * and draws the state from a table that has no `off`: an unfamiliar value
 * would give it `undefined` and an empty badge (and in the header, an error
 * on `kernel.label`). So the OLD key gets `idle` instead of `off`: the old
 * tab shows "IDLE", and that is not a lie in its vocabulary — Run in such a
 * room works and brings the kernel up by itself. The whole truth lies in the
 * new key (`meta.kernels[root].status`), which the old tab does not read.
 */
export function legacyKernelStatus(status: KernelStatus): Exclude<KernelStatus, 'off'> {
  return status === 'off' ? 'idle' : status
}
export type StreamName = 'stdout' | 'stderr'

/* --------------------------------------------------------- notebook kernels */

/**
 * Kernel state per notebook: root → what is happening with it.
 *
 * Every notebook has its own kernel and its own queue
 * (server/src/kernel/index.ts), and the room must see it per notebook: the
 * lecture is computing, the seminar is ready, and one badge for both would
 * lie to both. The map lives in `meta`, like everything else the server
 * writes — so it arrives by the same sync and gets into the snapshot.
 *
 * The old keys `kernelStatus`, `runningCell`, `queue` and `kernelProblem` next
 * to it are NOT removed and keep mirroring the kernel of the `cells` notebook.
 * There are three reasons, and all three are real: a tab opened before the
 * rollout reads only them; version history keeps snapshots that have only
 * them; and resetting a stuck state (`clearStaleWork`) repairs both records
 * at once. One place writes the mirror —
 * `setStatus`/`syncQueue`/`setKernelProblem` in kernel/index.ts.
 */
export const KERNELS_KEY = 'kernels'

/** The fields of one map entry — the same words as the old keys. */
export const KERNEL_STATUS_FIELD = 'status'
export const KERNEL_RUNNING_FIELD = 'runningCell'
export const KERNEL_QUEUE_FIELD = 'queue'

/** The kernel map, if the document has one. For readers — without creating it. */
export function kernelsMap(doc: Y.Doc): Y.Map<any> | null {
  const raw = getMeta(doc).get(KERNELS_KEY)
  return raw instanceof Y.Map ? (raw as Y.Map<any>) : null
}

/**
 * One notebook's entry in the map — creating it if needed.
 *
 * For the server only, and only inside a transaction: `meta` is closed to
 * clients by the gate (collab/gate.ts), and the kernel map is closed by the
 * same rule as `kernelStatus`.
 */
export function kernelEntry(doc: Y.Doc, root: string): Y.Map<any> {
  const meta = getMeta(doc)
  let map = meta.get(KERNELS_KEY)
  if (!(map instanceof Y.Map)) {
    map = new Y.Map<any>()
    meta.set(KERNELS_KEY, map)
  }
  let entry = (map as Y.Map<any>).get(root)
  if (!(entry instanceof Y.Map)) {
    entry = new Y.Map<any>()
    ;(map as Y.Map<any>).set(root, entry)
  }
  return entry as Y.Map<any>
}

/** What the room knows about one notebook's kernel. Empty — it has not been brought up yet. */
export interface BookKernel {
  status: KernelStatus
  runningCell: string | null
  queue: string[]
}

/**
 * The state of one notebook's kernel — as one question, with a fallback
 * answer.
 *
 * No map at all (a room with an old snapshot, a document from a test) — we
 * answer from the old keys, but ONLY for the `cells` notebook: the others
 * have nothing in the old record, and attributing someone else's state to
 * them would show "running" for a notebook in which nobody ran anything.
 */
export function bookKernel(doc: Y.Doc, root: string): BookKernel {
  const entry = kernelsMap(doc)?.get(root)
  if (entry instanceof Y.Map) {
    const queue = entry.get(KERNEL_QUEUE_FIELD)
    return {
      status: (entry.get(KERNEL_STATUS_FIELD) as KernelStatus) ?? 'off',
      runningCell: (entry.get(KERNEL_RUNNING_FIELD) as string | null) ?? null,
      queue: queue instanceof Y.Array ? (queue.toArray() as string[]) : [],
    }
  }
  // No entry at all — this notebook's kernel was never brought up: `off`, not "starting".
  if (root !== CELLS_KEY) return { status: 'off', runningCell: null, queue: [] }
  const meta = getMeta(doc)
  const queue = meta.get('queue')
  return {
    status: (meta.get('kernelStatus') as KernelStatus) ?? 'off',
    runningCell: (meta.get('runningCell') as string | null) ?? null,
    queue: queue instanceof Y.Array ? (queue.toArray() as string[]) : [],
  }
}

export interface StreamOutput {
  kind: 'stream'
  name: StreamName
  text: string
}

/**
 * A large piece of output, moved out of the document.
 *
 * A two-hundred-kilobyte picture is 270 KB of base64 in a document that
 * travels whole to everyone who comes in and is rewritten whole into every
 * snapshot and history keyframe. Here a link of about a hundred and fifty
 * bytes stands in its place, and the bytes lie by hash next to the room
 * (server/src/blobs.ts) and are served with an eternal cache
 * (`/api/sessions/:id/blobs/:sha`).
 *
 * `mime` is the one the kernel sent: whoever will show these bytes or embed
 * them back (publishing, export) needs it. The response's Content-Type is NOT
 * taken from it — the server determines that from the bytes themselves.
 */
export interface OutputBlob {
  sha: string
  mime: string
  bytes: number
}

/** execute_result / display_data: a mimebundle of `mime -> string`. */
export interface DataOutput {
  kind: 'data'
  data: Record<string, string>
  /**
   * Parts of the bundle that are not in `data`: they were moved out by link.
   *
   * A list, not a field: the bundle from one `display_data` carries png, svg
   * and text/plain at once, and more than one of them may end up moved out.
   * Old documents do not have the field at all — everything lies in `data`
   * there, and is read that way.
   */
  blobs?: OutputBlob[]
  execCount: number | null
}

export interface ErrorOutput {
  kind: 'error'
  ename: string
  evalue: string
  traceback: string[]
}

export type CellOutput = StreamOutput | DataOutput | ErrorOutput

/** Plain-JS snapshot of a cell, for AI context and serialization. */
export interface CellSnapshot {
  id: string
  type: CellType
  source: string
  outputs: CellOutput[]
  state: CellState
  execCount: number | null
  runBy: string | null
  runById: string | null
  /** Server clock when this run began. Meaningful only while state is 'running'. */
  startedAt: number | null
  /** How long the last settled run took. Null after an interrupt: it never finished. */
  ranMs: number | null
  /**
   * Set while the cell is stopped inside input(). The kernel is blocked until
   * somebody answers, and in a shared room that somebody is not necessarily
   * whoever pressed Run — so the ask lives in the document, where everybody
   * can see it.
   */
  stdin: { prompt: string; password: boolean } | null
  /**
   * The teacher opened the cell: in a closed lecture notebook it alone
   * accepts typing and runs.
   *
   * An optional field, because the key in the document is optional too: a
   * cell the lock never touched has no such key at all, and a nine-week-old
   * snapshot reads without it. `readCell` puts a boolean here anyway — it must
   * not be read via `!== false`, it has to be read via truth.
   */
  open?: boolean
  /**
   * The lock's position in full — what the mode strip and the cell chip draw.
   *
   * `open` above stays boolean for the sake of everyone who reads a snapshot
   * as "may one type here": for them a council is a closed cell, and that is
   * true. Here, though, all three positions are distinguished. Optional by the
   * same argument as `open`: old snapshots do not know it.
   */
  lock?: CellLock
  /** The council's knobs — with defaults filled in; `null` outside a council. */
  council?: CouncilSettings | null
}

/**
 * The three positions of a cell's lock.
 *
 *   closed  — an ordinary lecture cell: the teacher types and runs
 *   open    — open to everyone: the room types into the shared text
 *   council — a council: everyone has their own sheet, the shared text is
 *             closed, and the attempts live on the server, visible to the
 *             teacher (protocol.ts · council:*)
 *
 * The document stores not this name but the `open` key
 * (true | 'council' | null); the name is for the wires and the interface,
 * where "false" explains nothing.
 */
export type CellLock = 'closed' | 'open' | 'council'

/**
 * The council's knobs on one cell.
 *
 *   studentRun       — false: the teacher runs; true: the student runs by
 *                      themselves; request: the student asks for approval of
 *                      a specific version of the code. Default false. All
 *                      runs go into the kernel of THE notebook the council
 *                      cell is in.
 *   namesOnProjector — the author's name on a shown attempt: ON by default.
 *                      Turned off, it labels the shown solution with a
 *                      variant number ("Answer 12") — the same everywhere: in
 *                      everyone's notebook, in the projector strip and in the
 *                      teacher's badge. The server reads it when it assembles
 *                      `CouncilShown` (server/src/council.ts · shownFor): a
 *                      name that reached someone else's browser counts as
 *                      shown, so with the knob off it is not in the frame at
 *                      all. The author still sees "your answer is on the
 *                      screen" on their side — they know about themselves
 *                      anyway.
 *   runLimitSec      — the limit of ONE run of an attempt, in seconds; `null`
 *                      means no limit. A notebook has one kernel, and the
 *                      queue for the whole cohort stands behind whatever is
 *                      computing: one person's `while True` is "In queue: 37"
 *                      for everyone else until the end of class, until the
 *                      teacher notices and presses "Interrupt". The limit
 *                      presses it by itself: the server interrupts the run,
 *                      the attempt gets the `CouncilRun.timedOut` mark, the
 *                      queue moves on. It applies to all attempt runs —
 *                      including those the teacher started: heavy code does
 *                      not get lighter depending on who pressed. Default
 *                      30 s: a council attempt is a few lines, an ordinary
 *                      run takes a fraction of a second.
 *   rerunPauseSec    — how many seconds a student waits after the end of
 *                      THEIR OWN run before queuing again (both a self-run
 *                      and a request); 0 — right away. With a cohort of five
 *                      hundred, a queue of people pressing "Run" after every
 *                      edit never ends. The pause does not apply to the
 *                      teacher.
 */
export interface CouncilSettings {
  /** false: teacher only; true: direct student runs; request: teacher approval. */
  studentRun: boolean | 'request'
  /** The shown attempt's author's name or "Answer N" — see the note above. */
  namesOnProjector: boolean
  /** The limit of one run, s; `null` — no limit. See the note above. */
  runLimitSec: number | null
  /** The pause between one student's runs, s; 0 — none. See the note above. */
  rerunPauseSec: number
}

export const DEFAULT_COUNCIL: CouncilSettings = {
  studentRun: false,
  namesOnProjector: true,
  runLimitSec: 30,
  rerunPauseSec: 0,
}

/**
 * What the "Rules" sheet in the console offers. The server accepts any integer
 * within the bounds below, not only these numbers: the list is about the
 * interface, not about the right.
 */
export const COUNCIL_RUN_LIMITS: readonly (number | null)[] = [5, 15, 30, 60, 300, null]
export const COUNCIL_RERUN_PAUSES: readonly number[] = [0, 15, 30, 60, 120]
/** The bounds within which the server accepts the run limit and the pause. */
export const COUNCIL_RUN_LIMIT_MAX = 3600
export const COUNCIL_RERUN_PAUSE_MAX = 3600

/**
 * How long a draft sits without a single edit before it counts as "stuck".
 *
 * Five minutes: the sheet is open, nothing is happening in it. The number
 * lives HERE, not with each of its users: by it the oracle names the stuck
 * ones in the summary for the teacher (server/src/ai/council.ts · silent), and
 * the console colors the "silent for 7 min" row and counts the "Silent N" chip
 * in the "Writing" tab. Once apart, two copies would give a person who is
 * stuck in the summary and writing in the list — and the argument would be
 * about which of the two numbers is real.
 */
export const COUNCIL_SILENCE_MS = 5 * 60_000

/**
 * What the council promises about isolating attempts — and what it does not.
 *
 * A notebook has one kernel, and the attempts share it: an attempt sees `df`,
 * `np` and everything the teacher prepared in a shared cell of THIS sheet —
 * otherwise the council would be useless. The class's other notebooks are
 * not affected at all: they have their own kernels and their own variables.
 * But each attempt gets data OF ITS OWN: the server swaps the bindings for
 * personal copies before the attempt and restores the namespace after it
 * (server/src/kernel/council-isolation.ts), so neither `secret = 42`, nor
 * `data = data.dropna()`, nor `df.drop(..., inplace=True)` from one person
 * reaches the next.
 *
 * The same entry point closes two ways to end the class for everyone at
 * once: `exit()` in a Jupyter kernel ends the process (everyone working in
 * this notebook loses their variables), and a greedy attempt called the
 * OOM-killer on its kernel. The first is answered with a refusal, the second
 * gets a memory ceiling.
 *
 * What stays shared is the files on disk, the modules the attempt imported,
 * and whatever could not be copied — too big or of the wrong type; the
 * attempt reads about that as a line in its own output. One string for every
 * place where this is said: the hint of the studentRun knob, the council
 * strip, the README.
 */
export const COUNCIL_SHARED_KERNEL_NOTE = 'server.councilSharedKernel'

export type YCell = Y.Map<any>
export type YOutput = Y.Map<any>

/* ------------------------------------------------------------------ chat */

/**
 * The oracle thread lives in the document, not in a per-person inbox.
 *
 * A seminar loses something when questions go into a private tab: the answer
 * helps one student instead of the room, and the teacher never learns what was
 * unclear. Putting the thread in the CRDT makes every question attributable and
 * every answer visible, and streaming lands in everyone's panel at once for
 * free — the same mechanism that carries cell outputs.
 *
 * A chat entry Y.Map holds:
 *   id, participantId, name, color   who asked
 *   question   string
 *   action     AiAction | null
 *   cellId     string | null         cell the question was anchored to
 *   createdAt  number
 *   answer     Y.Text                appended to while the model streams
 *   reasoning  Y.Text                the model's own trace, when it sends one
 *   thoughtMs  number | null         how long the trace took
 *   state      'streaming' | 'done' | 'error'
 */
export type ChatState = 'streaming' | 'done' | 'error'

/**
 * What the oracle did by itself, step by step.
 *
 * The step feed lives in the document next to the answer, not in the server
 * logs, and it is the same decision as for the thread itself: the room must
 * see what exactly happened to its files, not read a retelling of it. Undo is
 * also computed from it — it shows what was touched.
 *
 * `read` in the feed is needed no less than edits: "the oracle changed
 * train.py" without "the oracle first read src/model.py" reads as guessing.
 */
export type StepKind = 'read' | 'write' | 'new' | 'run' | 'note'

export interface AgentStep {
  kind: StepKind
  /** The file the step touched. For `run` — what was run. */
  target: string
  /** Lines added and removed; edits only. */
  added: number
  removed: number
  /** The exit code; runs only. `null` — did not wait for it. */
  exit: number | null
  /** A short digest: the tail of the output, the first lines of an edit, the reason for a refusal. */
  note: string
  /**
   * When the step was recorded, by the server's clock.
   *
   * Optional on read, and that is not sloppiness: feeds of turns recorded
   * before the field existed lie in room snapshots and arrive without it. The
   * panel draws the gap between steps only where both neighbors have a time.
   */
  at?: number
}

/** Whether a turn can be undone: an ordinary question has no such thing at all. */
export type UndoState = 'none' | 'available' | 'done'

/**
 * What happened to a proposed edit.
 *
 * `open` is a patch nobody has decided about yet — that is the state the cell
 * draws a diff for. It lives in the document rather than in the asker's browser
 * on purpose: a proposal the room can see is a proposal the room can discuss,
 * and whoever accepts it is doing it in front of everyone rather than quietly.
 */
export type PatchState = 'open' | 'accepted' | 'rejected'

export interface ChatSnapshot {
  id: string
  participantId: string
  name: string
  color: string
  question: string
  action: string | null
  cellId: string | null
  /** The cells asked about. Empty for turns recorded before multi-cell selection existed. */
  cellIds: string[]
  createdAt: number
  answer: string
  state: ChatState
  /** The complete proposed source of `cellId`, or null when the turn proposed none. */
  patch: string | null
  /**
   * What the cell held when the oracle was asked.
   *
   * A proposal is a rewrite of a particular text, and in a room of twenty
   * people that text moves while the model is still writing. Kept so the cell
   * can say "this was written against an older version" instead of silently
   * overwriting somebody's work with an answer to a question about a cell that
   * no longer exists.
   */
  patchBase: string | null
  patchState: PatchState
  /** Who accepted or rejected it, for the line the thread shows afterwards. */
  patchBy: string | null
  /**
   * What the model said to itself before answering, verbatim.
   *
   * Empty for most turns: only some endpoints send a trace at all, and asking
   * for one is limited to the single provider with a documented switch (see
   * ai/provider.ts). Empty is therefore a normal state and not a fault — the
   * interface simply has no strip to draw.
   *
   * Kept apart from `answer` rather than prefixed into it, because the two are
   * read differently. The answer is what the room is told; the trace is how it
   * was arrived at, and a reader who wants it goes looking for it.
   */
  reasoning: string
  /**
   * Milliseconds between the question and the first word of the answer.
   *
   * Measured, not reported: it is the wait a person actually sat through,
   * which is the number the strip claims. Null while the answer has not
   * started, and on every turn recorded before this existed.
   */
  thoughtMs: number | null
  /**
   * Asked a question, or asked for something to be done.
   *
   * Different things, and they look different in the feed: a question has an
   * answer, an assignment also has a list of what happened to the room's
   * files.
   */
  mode: 'ask' | 'agent'
  steps: AgentStep[]
  undo: UndoState
  /** Who undid the turn, for the line the thread shows afterwards. */
  undoBy: string | null
}

export type YChatEntry = Y.Map<any>

export function getChat(doc: Y.Doc): Y.Array<YChatEntry> {
  return doc.getArray<YChatEntry>(CHAT_KEY)
}

export function createChatEntry(input: {
  participantId: string
  name: string
  color: string
  question: string
  action?: string | null
  cellId?: string | null
  cellIds?: string[]
  /** The cell's text at the moment of asking; see ChatSnapshot.patchBase. */
  patchBase?: string | null
  mode?: 'ask' | 'agent'
}): YChatEntry {
  const entry = new Y.Map<any>()
  entry.set('id', newId('q'))
  entry.set('participantId', input.participantId)
  entry.set('name', input.name)
  entry.set('color', input.color)
  entry.set('question', input.question)
  entry.set('action', input.action ?? null)
  entry.set('cellId', input.cellId ?? null)
  /*
   * The cells one asked to focus on — separately from the one the turn is
   * ATTACHED to. The attachment is one: a proposal rewrites one text, it has
   * one base and one decision for everyone. The list is about what was asked
   * about, and the thread names it in words.
   */
  entry.set('cellIds', input.cellIds ?? [])
  entry.set('createdAt', Date.now())
  entry.set('answer', new Y.Text())
  entry.set('reasoning', new Y.Text())
  entry.set('thoughtMs', null)
  entry.set('state', 'streaming' as ChatState)
  entry.set('patch', null)
  entry.set('patchBase', input.patchBase ?? null)
  entry.set('patchState', 'open' as PatchState)
  entry.set('patchBy', null)
  entry.set('mode', input.mode ?? 'ask')
  entry.set('steps', new Y.Array<Y.Map<any>>())
  entry.set('undo', 'none' as UndoState)
  entry.set('undoBy', null)
  return entry
}

/** This turn's step feed. Empty for everything that is not "do". */
export function chatSteps(entry: YChatEntry): Y.Array<Y.Map<any>> {
  const current = entry.get('steps')
  if (current instanceof Y.Array) return current
  const made = new Y.Array<Y.Map<any>>()
  entry.set('steps', made)
  return made
}

/**
 * Append a step.
 *
 * Each step is a separate entry, not a rewrite of the whole feed: the room
 * watches it while the oracle works, and rewriting it whole would jerk the
 * list on every step.
 */
export function addStep(entry: YChatEntry, step: AgentStep): void {
  const row = new Y.Map<any>()
  row.set('kind', step.kind)
  row.set('target', step.target)
  row.set('added', step.added)
  row.set('removed', step.removed)
  row.set('exit', step.exit)
  row.set('note', step.note)
  // The server writes the time, not the caller: a step's clock must be one for
  // the whole feed, otherwise "how long the run took" comes from two sources.
  row.set('at', step.at ?? Date.now())
  chatSteps(entry).push([row])
}

function readStep(row: unknown): AgentStep | null {
  if (!(row instanceof Y.Map)) return null
  const kind = row.get('kind')
  if (typeof kind !== 'string') return null
  return {
    kind: kind as StepKind,
    target: typeof row.get('target') === 'string' ? (row.get('target') as string) : '',
    added: typeof row.get('added') === 'number' ? (row.get('added') as number) : 0,
    removed: typeof row.get('removed') === 'number' ? (row.get('removed') as number) : 0,
    exit: typeof row.get('exit') === 'number' ? (row.get('exit') as number) : null,
    note: typeof row.get('note') === 'string' ? (row.get('note') as string) : '',
    ...(typeof row.get('at') === 'number' ? { at: row.get('at') as number } : {}),
  }
}

/**
 * Accept a proposal: the cell becomes what the oracle wrote.
 *
 * The write is an ordinary edit, so it merges like any other, everyone watches
 * it land at once, and it becomes a version in the room's history under the
 * name of whoever pressed Accept — not under the oracle's. A person decided;
 * the model only offered.
 *
 * Returns false when there is nothing to apply, which covers the two races that
 * matter: somebody else accepted it a second earlier, and the cell was deleted
 * while the answer was being written.
 */
/**
 * Replace a text without rewriting it whole.
 *
 * `delete(0, length)` followed by `insert(0, next)` means "all the text
 * vanished, a different one appeared". For a CRDT that is exactly so: for
 * everyone who stood in this cell the caret jumps to the beginning, the
 * selection disappears, and a neighbor who was typing at the end of the file
 * finds their line in the middle of someone else's. Meanwhile "accept an
 * edit" and "restore a version" usually change a few lines out of forty.
 *
 * The common head and the common tail are left untouched, the middle is
 * rewritten. This is not a full diff — an insertion at the start of a file
 * that repeats its end will still rewrite a lot of extra — but where text is
 * being edited rather than composed anew, carets stay in place.
 */
export function replaceText(text: Y.Text, next: string): void {
  const before = text.toString()
  if (before === next) return

  let head = 0
  const max = Math.min(before.length, next.length)
  while (head < max && before[head] === next[head]) head++

  let tail = 0
  while (tail < max - head && before[before.length - 1 - tail] === next[next.length - 1 - tail]) {
    tail++
  }

  const removed = before.length - head - tail
  if (removed > 0) text.delete(head, removed)
  const added = next.slice(head, next.length - tail)
  if (added) text.insert(head, added)
}

export function acceptPatch(doc: Y.Doc, entry: YChatEntry, byName: string): boolean {
  const patch = entry.get('patch')
  const cellId = entry.get('cellId')
  if (typeof patch !== 'string' || typeof cellId !== 'string') return false
  if (entry.get('patchState') !== 'open') return false

  /*
   * Across all notebooks, not the first one.
   *
   * A cell is found by name without knowing its notebook — that is how
   * `findCell` works, and so do the kernel and the oracle. The search here
   * used to be its own and covered only the first notebook: a cell in the
   * second open notebook got a legitimate-looking proposal, and "accept"
   * silently returned false — the button pressed and did nothing.
   */
  const target = findCell(doc, cellId)?.cell ?? null
  if (!target) return false

  const source = target.get('source') as Y.Text | undefined
  if (!source) return false

  /*
   * Claim first, write second, both in one transaction.
   *
   * The check above reads a value that may be seconds old: the panel and the
   * cell both show Accept, and a teacher pressing one while a student presses
   * the other produced two writes and a cell holding the patch twice. Yjs will
   * merge both — that is what it is for — so the guard has to be inside the
   * transaction, where re-reading the state is the last thing that happens
   * before the write.
   */
  let applied = false
  doc.transact(() => {
    if (entry.get('patchState') !== 'open') return
    entry.set('patchState', 'accepted' as PatchState)
    entry.set('patchBy', byName)
    replaceText(source, patch)
    applied = true
  })
  return applied
}

/** Turn a proposal down. Nothing is written to the cell; the thread keeps both. */
export function rejectPatch(doc: Y.Doc, entry: YChatEntry, byName: string): void {
  if (entry.get('patchState') !== 'open') return
  doc.transact(() => {
    entry.set('patchState', 'rejected' as PatchState)
    entry.set('patchBy', byName)
  })
}

/**
 * Has the cell moved since this proposal was written?
 *
 * Not a refusal — the room may well want the rewrite anyway — but it has to be
 * said out loud before somebody presses Accept, because what they are accepting
 * is the deletion of whatever arrived in between.
 */
export function patchIsStale(doc: Y.Doc, entry: YChatEntry): boolean {
  const base = entry.get('patchBase')
  const cellId = entry.get('cellId')
  if (typeof base !== 'string' || typeof cellId !== 'string') return false
  // Across all notebooks — for the same reason as in `acceptPatch`: otherwise
  // a proposal for a cell in the second notebook never counted as stale.
  const found = findCell(doc, cellId)
  if (!found) return false
  const source = found.cell.get('source')
  const now = source instanceof Y.Text ? source.toString() : String(source ?? '')
  return now !== base
}

/** The proposal on a chat turn, if it made one and nobody has decided yet. */
export function openPatchFor(doc: Y.Doc, cellId: string): YChatEntry | null {
  const chat = getChat(doc)
  for (let i = chat.length - 1; i >= 0; i--) {
    const entry = chat.get(i)
    if (entry.get('cellId') !== cellId) continue
    if (entry.get('patchState') !== 'open') continue
    const patch = entry.get('patch')
    if (typeof patch !== 'string' || patch.length === 0) continue
    return entry
  }
  return null
}

export function chatAnswer(entry: YChatEntry): Y.Text {
  let text = entry.get('answer') as Y.Text | undefined
  if (!text) {
    text = new Y.Text()
    entry.set('answer', text)
  }
  return text
}

/**
 * The entry's reasoning text, created on first use.
 *
 * Lazy for the same reason chatAnswer is: a turn written by an older build has
 * no such key, and every reader of a nine-week-old thread would otherwise have
 * to guard for it. Creating it on read is safe here because the server is a
 * Yjs client like any other — the empty text merges with itself.
 */
export function chatReasoning(entry: YChatEntry): Y.Text {
  let text = entry.get('reasoning') as Y.Text | undefined
  if (!text) {
    text = new Y.Text()
    entry.set('reasoning', text)
  }
  return text
}

/** A Y.Text as a string, and anything else as nothing. */
function readText(value: unknown): string {
  return value instanceof Y.Text ? value.toString() : ''
}

export function readChatEntry(entry: YChatEntry): ChatSnapshot {
  return {
    id: entry.get('id') as string,
    participantId: (entry.get('participantId') as string) ?? '',
    name: (entry.get('name') as string) ?? 'Someone',
    color: (entry.get('color') as string) ?? '#939598',
    question: (entry.get('question') as string) ?? '',
    action: (entry.get('action') as string | null) ?? null,
    cellId: (entry.get('cellId') as string | null) ?? null,
    cellIds: Array.isArray(entry.get('cellIds')) ? (entry.get('cellIds') as string[]) : [],
    createdAt: (entry.get('createdAt') as number) ?? 0,
    answer: readText(entry.get('answer')),
    state: (entry.get('state') as ChatState) ?? 'done',
    // Absent on every turn written before proposals existed, which is most of
    // them: a thread from last week must still read.
    patch: (entry.get('patch') as string | null) ?? null,
    patchBase: (entry.get('patchBase') as string | null) ?? null,
    patchState: (entry.get('patchState') as PatchState) ?? 'open',
    patchBy: (entry.get('patchBy') as string | null) ?? null,
    /*
     * Read without creating. chatReasoning() makes the text when it is missing,
     * which is right for the server about to write into it and wrong here: this
     * runs in every browser on every observer pass, so a thread of turns from
     * before reasoning existed would have had each of them written to — a read
     * that mutates the document, inside the callback that fires on mutations.
     */
    reasoning: readText(entry.get('reasoning')),
    thoughtMs: (entry.get('thoughtMs') as number | null) ?? null,
    // Everything that turns recorded before "do" mode lacked: a week-old
    // thread must read, not crash on a missing field.
    mode: entry.get('mode') === 'agent' ? 'agent' : 'ask',
    steps: readSteps(entry.get('steps')),
    undo: (entry.get('undo') as UndoState) ?? 'none',
    undoBy: (entry.get('undoBy') as string | null) ?? null,
  }
}

function readSteps(value: unknown): AgentStep[] {
  if (!(value instanceof Y.Array)) return []
  const out: AgentStep[] = []
  value.forEach((row) => {
    const step = readStep(row)
    if (step) out.push(step)
  })
  return out
}

/* ---------------------------------------------------- rereading per frame */

/**
 * Which rows of the array this frame touched — or `null` if the array itself
 * was touched.
 *
 * `observeDeep` delivers events with a path from the observed root: the
 * array's own event has an empty path (a row was inserted or deleted — the
 * order changed and the indexes shifted), a card's event has the path
 * `[index]`, the text inside it `[index, 'answer']`. The first element is
 * enough to name the row.
 */
export function changedRows(events: readonly Y.YEvent<any>[]): Set<number> | null {
  const rows = new Set<number>()
  for (const event of events) {
    const at = event.path[0]
    if (typeof at !== 'number') return null
    rows.add(at)
  }
  return rows
}

/**
 * Reread only what changed — and keep the previous snapshots of the rest.
 *
 * The oracle feed and the terminal transcript grow by appending to a Y.Text
 * INSIDE a row: every piece of the answer brings a frame, and
 * `array.map(read)` on it reads the whole thread — `toString()` of every
 * answer, every reasoning and every step. That is O(thread length) per token,
 * for everyone who has the panel open, and on a long answer in a
 * hundred-turn thread it is the tab's main work.
 *
 * Here is the same trick as `settle` in yreactive: unchanged snapshots are
 * returned as THE SAME objects, so a row's derived values (diffs, markdown
 * parsing, the author's role) are not recomputed, and `{#each}` does not
 * touch their nodes. When there is nothing to touch, the same array is
 * returned, so that a caller comparing by reference does not write a new
 * value on every frame.
 *
 * `events === null` (the first read) and any doubt mean a full reread: one
 * may err towards extra work, never towards a stale snapshot.
 */
export function rereadRows<Row extends Y.Map<any>, Snapshot>(
  previous: readonly Snapshot[],
  array: Y.Array<Row>,
  read: (row: Row) => Snapshot,
  events: readonly Y.YEvent<any>[] | null,
): Snapshot[] {
  const rows = events === null ? null : changedRows(events)
  if (rows === null || previous.length !== array.length) return array.map(read)
  if (rows.size === 0) return previous as Snapshot[]
  const next = previous.slice()
  for (const at of rows) {
    if (at < 0 || at >= array.length) return array.map(read)
    next[at] = read(array.get(at))
  }
  return next
}

export function findChatEntry(doc: Y.Doc, id: string): YChatEntry | null {
  const chat = getChat(doc)
  for (let i = 0; i < chat.length; i++) {
    const entry = chat.get(i)
    if ((entry.get('id') as string) === id) return entry
  }
  return null
}

/* -------------------------------------------------------------- terminal */

/**
 * The terminal is shared for the same reason the kernel is: an install that
 * only one person can see would be a lie, since it changes the environment for
 * every cell in the room. Commands carry the name of whoever typed them.
 *
 * A terminal line Y.Map holds:
 *   id, kind ('command' | 'output' | 'system')
 *   participantId, name, color   (command only)
 *   text     Y.Text              appended to while output streams
 *   createdAt number
 *   running  boolean             (command only) still producing output
 */
export type TerminalLineKind = 'command' | 'output' | 'system'

export interface TerminalLineSnapshot {
  id: string
  kind: TerminalLineKind
  name: string | null
  color: string | null
  text: string
  createdAt: number
  running: boolean
}

export type YTerminalLine = Y.Map<any>

export function getTerminal(doc: Y.Doc): Y.Array<YTerminalLine> {
  return doc.getArray<YTerminalLine>(TERMINAL_KEY)
}

export function createTerminalLine(input: {
  kind: TerminalLineKind
  text?: string
  name?: string | null
  color?: string | null
  participantId?: string | null
}): YTerminalLine {
  const line = new Y.Map<any>()
  line.set('id', newId('t'))
  line.set('kind', input.kind)
  line.set('participantId', input.participantId ?? null)
  line.set('name', input.name ?? null)
  line.set('color', input.color ?? null)
  const text = new Y.Text()
  if (input.text) text.insert(0, input.text)
  line.set('text', text)
  line.set('createdAt', Date.now())
  line.set('running', input.kind === 'command')
  return line
}

export function terminalText(line: YTerminalLine): Y.Text {
  let text = line.get('text') as Y.Text | undefined
  if (!text) {
    text = new Y.Text()
    line.set('text', text)
  }
  return text
}

export function readTerminalLine(line: YTerminalLine): TerminalLineSnapshot {
  return {
    id: line.get('id') as string,
    kind: (line.get('kind') as TerminalLineKind) ?? 'output',
    name: (line.get('name') as string | null) ?? null,
    color: (line.get('color') as string | null) ?? null,
    text: terminalText(line).toString(),
    createdAt: (line.get('createdAt') as number) ?? 0,
    running: Boolean(line.get('running')),
  }
}

/* ----------------------------------------------------------------- cells */

/**
 * The cells of the ROOM'S NOTEBOOK — the first in the list.
 *
 * What "cells" used to mean, and where that is the intended meaning it
 * stayed: version history, publishing and the oracle's context are about the
 * room, not about any file opened in it. Everything that must work with any
 * notebook calls `bookCells` or `allBooks`.
 */
export function getCells(doc: Y.Doc): Y.Array<YCell> {
  const first = bookList(doc)[0]
  if (first) return doc.getArray<YCell>(first.root)
  return legacyCells(doc)
}

function legacyCells(doc: Y.Doc): Y.Array<YCell> {
  return doc.getArray<YCell>(CELLS_KEY)
}

export function getMeta(doc: Y.Doc): Y.Map<any> {
  return doc.getMap<any>(META_KEY)
}

/** Non-cryptographic id, good enough to distinguish cells. */
export function newId(prefix = 'c'): string {
  return (
    prefix + '_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
  )
}

export function createCell(type: CellType, source = '', id?: string): YCell {
  const cell = new Y.Map<any>()
  // An id may be supplied: restoring a deleted cell has to bring back the one
  // it had, or a second restore cannot tell it is already there and makes
  // another copy.
  cell.set('id', id ?? newId())
  cell.set('type', type)
  const text = new Y.Text()
  if (source) text.insert(0, source)
  cell.set('source', text)
  cell.set('outputs', new Y.Array<YOutput>())
  cell.set('state', 'idle' as CellState)
  cell.set('execCount', null)
  cell.set('runBy', null)
  cell.set('runById', null)
  cell.set('startedAt', null)
  cell.set('ranMs', null)
  return cell
}

export function cellId(cell: YCell): string {
  return cell.get('id') as string
}

export function cellType(cell: YCell): CellType {
  return (cell.get('type') as CellType) ?? 'code'
}

/**
 * Whether the cell is open — that is, the whole room types and runs in it.
 *
 * Strictly by truth: no key, `false`, `null`, the string "no" — all of that is
 * a closed cell. The lock must be off by default, because by default it simply
 * is not in the document: a notebook written before lectures existed and a
 * cell the teacher never touched are one and the same case.
 *
 * The right is derived from this field not by the field itself but by
 * `mayEditCell`/`mayRunCell` (shared/rules.ts): an open cell gives text and
 * runs, and nothing beyond that.
 */
export function isCellOpen(cell: YCell): boolean {
  return cell.get('open') === true
}

/**
 * Whether the cell holds a council — that is, everyone has their own sheet,
 * and the shared text is closed.
 *
 * Separate from `isCellOpen`, and not through it: to the gate and to
 * `mayEditCell` a council is a closed cell, and they must not know about it.
 * Only those who draw the council and those who accept attempts ask this
 * (control.ts · council:draft): an attempt into a cell without a council is
 * refused.
 */
export function isCellCouncil(cell: YCell): boolean {
  return cell.get('open') === 'council'
}

/** The lock's position as one word — for the mode strip, the chip and the wires. */
export function cellLock(cell: YCell): CellLock {
  const raw: unknown = cell.get('open')
  if (raw === true) return 'open'
  if (raw === 'council') return 'council'
  return 'closed'
}

/** The value of the `open` key for a lock position — what the server writes. */
export function openValueFor(lock: CellLock): true | 'council' | null {
  if (lock === 'open') return true
  if (lock === 'council') return 'council'
  return null
}

/**
 * The council's knobs from anything — with a default for each field
 * separately.
 *
 * Like `readRules`: a knob added tomorrow is missing on yesterday's cell, and
 * it must be missing as its default, not break reading of the neighboring
 * one.
 */
export function readCouncilSettings(raw: unknown): CouncilSettings {
  const from = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  /*
   * The limit: `null` means "no limit", and that is the teacher's conscious
   * choice, not a missing field. No field at all (a cell from yesterday's
   * version) means the default: otherwise a server update would silently lift
   * the limit from every open council. Garbage also means the default, not "no
   * limit": there is only one safe side here.
   */
  const limit = from.runLimitSec
  const runLimitSec =
    limit === null
      ? null
      : typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= COUNCIL_RUN_LIMIT_MAX
        ? limit
        : DEFAULT_COUNCIL.runLimitSec
  const pause = from.rerunPauseSec
  const rerunPauseSec =
    typeof pause === 'number' && Number.isInteger(pause) && pause >= 0 && pause <= COUNCIL_RERUN_PAUSE_MAX
      ? pause
      : DEFAULT_COUNCIL.rerunPauseSec
  return {
    studentRun: from.studentRun === 'request' ? 'request' : from.studentRun === true,
    namesOnProjector: from.namesOnProjector !== false,
    runLimitSec,
    rerunPauseSec,
  }
}

/** The council's knobs on the cell. Outside a council — `null`: a closed door has no knobs. */
export function councilSettingsOf(cell: YCell): CouncilSettings | null {
  return isCellCouncil(cell) ? readCouncilSettings(cell.get('council')) : null
}

/**
 * How many characters fit into a council attempt.
 *
 * An attempt is a cell, not a file: it never has hundreds of lines. The
 * ceiling is here, not only on the server, by exactly the `allows` argument:
 * the server's refusal and the counter under the sheet must say the same
 * thing. A client that does not know the number sends a snapshot at every
 * pause in typing and gets a refusal for each — a toast every second instead
 * of one line "9,012 of 8,000".
 */
export const MAX_ATTEMPT_CHARS = 8000

/**
 * The key of a group of identical solutions: the attempt's text without
 * spaces, empty lines and comments.
 *
 * Here, not on the server and not in the console: the groups are computed by
 * the server (for the oracle and `CouncilAttempt.groupKey`), and the console
 * draws the stack and the strip from them — and two different notions of
 * "identical" would give a stack in which "311 others answered the same" does
 * not match the width of the segment. Deliberately crude: `#` inside a line
 * counts as the start of a comment only outside quotes, and that is where the
 * precision ends — the goal is not to parse Python but to glue `x=1` together
 * with `x = 1  # answer`.
 */
export function normalizeAttempt(text: string): string {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    let quote: string | null = null
    let kept = ''
    for (const ch of raw) {
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '#') {
        break
      }
      if (ch === ' ' || ch === '\t' || ch === '\r') continue
      kept += ch
    }
    if (kept) lines.push(kept)
  }
  return lines.join('\n')
}

export function cellSource(cell: YCell): Y.Text {
  let text = cell.get('source') as Y.Text | undefined
  if (!text) {
    text = new Y.Text()
    cell.set('source', text)
  }
  return text
}

export function cellOutputs(cell: YCell): Y.Array<YOutput> {
  let outputs = cell.get('outputs') as Y.Array<YOutput> | undefined
  if (!outputs) {
    outputs = new Y.Array<YOutput>()
    cell.set('outputs', outputs)
  }
  return outputs
}

/**
 * A copy of a cell, id and all.
 *
 * Y.Array has no move, so reordering means rebuilding — and a rebuilt sheet
 * has to hold the same cells, not new ones with the same text: every caret,
 * every open proposal and every history row names a cell by its id.
 */
export function cloneCell(cell: YCell): YCell {
  const copy = new Y.Map<any>()
  copy.set('id', cell.get('id'))
  copy.set('type', cell.get('type'))
  const text = new Y.Text()
  const source = cell.get('source')
  const was = source instanceof Y.Text ? source.toString() : String(source ?? '')
  if (was) text.insert(0, was)
  copy.set('source', text)
  const outputs = new Y.Array<YOutput>()
  const had = cell.get('outputs')
  if (had instanceof Y.Array) {
    for (const out of had.toArray()) outputs.push([cloneOutput(out)])
  }
  copy.set('outputs', outputs)
  copy.set('state', cell.get('state') ?? ('idle' as CellState))
  copy.set('execCount', cell.get('execCount') ?? null)
  copy.set('runBy', cell.get('runBy') ?? null)
  copy.set('runById', cell.get('runById') ?? null)
  /*
   * Every key forgotten here vanishes when a neighbor is reordered.
   *
   * `moveCell` recreates as a clone not the cell being moved but the
   * neighboring one — so moving cell 5 while cell 6 is computing means
   * rebuilding the sixth whole. A key not copied over here disappears from it
   * in the middle of a run: with `startedAt` that is a stopped stopwatch on a
   * working cell, and with `stdin` an input form that vanishes for the whole
   * room while the kernel waits for an answer. The second lay here
   * undiscovered precisely because the list of keys in the file header did
   * not name it.
   */
  copy.set('stdin', cell.get('stdin') ?? null)
  copy.set('startedAt', cell.get('startedAt') ?? null)
  copy.set('ranMs', cell.get('ranMs') ?? null)
  /*
   * The lock moves together with the cell — the same argument as in the
   * paragraph above, but at a higher price than the stopwatch: reordering a
   * neighbor would slam shut a cell the room is typing in, mid-typing. The
   * key is written only when it exists: a closed cell does not have it in the
   * document, and there is no reason to create it on every reorder.
   */
  if (cell.get('open') != null) copy.set('open', cell.get('open'))
  // And the council's knobs — by exactly the same argument: a cell that turned
  // on runs for students when a neighbor was reordered is worse than one that
  // slammed shut.
  if (cell.get('council') != null) copy.set('council', cell.get('council'))
  return copy
}

function cloneOutput(output: YOutput): YOutput {
  const copy = new Y.Map<any>()
  for (const [key, value] of output.entries()) {
    if (value instanceof Y.Text) {
      const text = new Y.Text()
      const was = value.toString()
      if (was) text.insert(0, was)
      copy.set(key, text)
    } else {
      copy.set(key, value)
    }
  }
  return copy as YOutput
}

/**
 * A cell by name — whichever of the room's notebooks it is in.
 *
 * This is exactly how all the work with a single cell stays unaware of
 * notebooks: the kernel, the oracle and the control socket need only the
 * name, and none of them has to carry a file path around. A cell's name is
 * unique in the room — that is enforced separately, see the duplicate check
 * in collab/index.ts.
 *
 * A pass over all notebooks costs as much as the pass over one cost while
 * there was one notebook, and grows linearly with the number open.
 */
export function findCell(
  doc: Y.Doc,
  id: string,
): { cell: YCell; index: number; cells: Y.Array<YCell> } | null {
  for (const cells of allCellArrays(doc)) {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells.get(i)
      if (cellId(cell) === id) return { cell, index: i, cells }
    }
  }
  return null
}

/** Convert one output Y.Map into a plain object for rendering. */
export function readOutput(output: YOutput): CellOutput | null {
  const kind = output.get('kind')
  if (kind === 'stream') {
    const text = output.get('text')
    return {
      kind: 'stream',
      name: (output.get('name') as StreamName) ?? 'stdout',
      text: text instanceof Y.Text ? text.toString() : String(text ?? ''),
    }
  }
  if (kind === 'data' || kind === 'error') {
    try {
      const parsed = JSON.parse((output.get('json') as string) ?? '{}')
      return { kind, ...parsed } as CellOutput
    } catch {
      return null
    }
  }
  return null
}

/**
 * The inverse of `readOutput`: an output from a snapshot back into the
 * document.
 *
 * Needed where the server puts output back into the document from its own
 * memory rather than copying what a browser sent: undoing a cell deletion.
 * The shape is the same one the kernel writes (`kernel/outputs.ts`),
 * otherwise the screen would show a different one.
 */
export function writeOutput(output: CellOutput): YOutput {
  const map = new Y.Map<any>()
  map.set('kind', output.kind)
  if (output.kind === 'stream') {
    map.set('name', output.name)
    const text = new Y.Text()
    if (output.text) text.insert(0, output.text)
    map.set('text', text)
    return map as YOutput
  }
  const { kind: _kind, ...rest } = output
  map.set('json', JSON.stringify(rest))
  return map as YOutput
}

export function readOutputs(cell: YCell): CellOutput[] {
  const out: CellOutput[] = []
  cellOutputs(cell).forEach((o: YOutput) => {
    const parsed = readOutput(o)
    if (parsed) out.push(parsed)
  })
  return out
}

export function readCell(cell: YCell): CellSnapshot {
  return {
    id: cellId(cell),
    type: cellType(cell),
    source: cellSource(cell).toString(),
    outputs: readOutputs(cell),
    state: (cell.get('state') as CellState) ?? 'idle',
    execCount: (cell.get('execCount') as number | null) ?? null,
    runBy: (cell.get('runBy') as string | null) ?? null,
    runById: (cell.get('runById') as string | null) ?? null,
    stdin: (cell.get('stdin') as CellSnapshot['stdin']) ?? null,
    // `?? null`, not a cast: a notebook written before these keys existed
    // returns undefined, and the view compares against null.
    startedAt: (cell.get('startedAt') as number | null) ?? null,
    ranMs: (cell.get('ranMs') as number | null) ?? null,
    open: isCellOpen(cell),
    lock: cellLock(cell),
    council: councilSettingsOf(cell),
  }
}

export function readNotebook(doc: Y.Doc): CellSnapshot[] {
  return getCells(doc).map(readCell)
}

/** What had to be put back to rest — by kind of work, not as one number. */
export interface StaleWork {
  /** Cells taken off "running" and "queued". */
  cells: number
  /** Oracle turns cut off mid-answer. */
  turns: number
}

/**
 * Execution belonging to a process that is gone.
 *
 * `kernelStatus`, `runningCell`, the queue and every cell's `state` live in the
 * document, which means they are in the snapshot too. A server that dies with a
 * cell running comes back, loads all of that, and hands the room a notebook
 * where one cell spins forever and a queue waits on a run that no longer
 * exists — against a runtime that has never heard of any of it.
 *
 * The truth at hydration is simple: nothing is running, because nothing has
 * been started yet. Outputs are left exactly as they are — a cell that printed
 * three lines before the crash really did print them, and deleting them would
 * hide the only evidence of how far it got.
 *
 * It counts TWO numbers, not one, and that is not pedantry. The caller writes
 * a kernel log line about CELLS from it ("were put back to rest"), and under
 * a single counter an interrupted oracle turn got in there too: a restart in
 * the middle of an answer, not a single computing cell — and the room reads
 * that its work was cancelled. The same kind of lie this file separately
 * guards `startedAt` against below.
 */
export function clearStaleWork(doc: Y.Doc): StaleWork {
  const meta = getMeta(doc)
  // Across all notebooks, not one: the room's queue is shared, and a cell stuck
  // in "running" can be in any of the open ones.
  const cells = allCellArrays(doc).flatMap((array) => array.toArray())
  let cleared = 0
  let turns = 0

  doc.transact(() => {
    // The queue is emptied but not counted: every id in it belongs to a cell
    // that is counted below, and counting both reports each one twice.
    const queue = meta.get('queue')
    if (queue instanceof Y.Array && queue.length > 0) queue.delete(0, queue.length)
    if (meta.get('runningCell') != null) meta.set('runningCell', null)

    /*
     * No process means `off`, not `idle` and not "starting".
     *
     * This function runs when a room is brought into memory, that is, after a
     * server restart: the document holds what was written BEFORE it, and the
     * new process has no kernels at all. `idle` ("IDLE") and `starting`
     * ("STARTING") are equally untrue here — the first promises a live
     * Python, the second promises that it is about to be. The old key gets
     * the compatible word (see `legacyKernelStatus`).
     */
    const status = meta.get('kernelStatus')
    if (status !== undefined && status !== 'dead')
      meta.set('kernelStatus', legacyKernelStatus('off'))

    /*
     * And the same per notebook.
     *
     * A room has as many kernels as notebooks (server/src/kernel/index.ts),
     * and each leaves its own entry behind. Repairing the old keys without
     * touching the map would mean curing what the old tab sees and leaving
     * "running" forever in all the others — exactly the quiet trouble this
     * function exists to prevent.
     */
    const kernels = meta.get(KERNELS_KEY)
    if (kernels instanceof Y.Map) {
      for (const entry of kernels.values()) {
        if (!(entry instanceof Y.Map)) continue
        const waiting = entry.get(KERNEL_QUEUE_FIELD)
        if (waiting instanceof Y.Array && waiting.length > 0) waiting.delete(0, waiting.length)
        if (entry.get(KERNEL_RUNNING_FIELD) != null) entry.set(KERNEL_RUNNING_FIELD, null)
        const state = entry.get(KERNEL_STATUS_FIELD)
        if (state !== undefined && state !== 'dead')
          entry.set(KERNEL_STATUS_FIELD, 'off' as KernelStatus)
      }
    }

    for (const cell of cells) {
      const state = cell.get('state')
      if (state === 'running' || state === 'queued') {
        cell.set('state', 'idle' as CellState)
        cleared++
      }
      /*
       * The stopwatch is turned off on every cell, and that does not count as
       * a reset.
       *
       * `cleared` goes into the line the room reads in the kernel log —
       * "Cells that were running or queued were put back to rest". Adding to
       * it a cell that only has a stale timestamp means telling the class
       * their work was cancelled when nothing was cancelled.
       *
       * Loose `!= null`: in a notebook written before this key existed it is
       * `undefined`, and a strict check would rewrite every cell on every
       * room open — that is, it would open a history burst and wake up a disk
       * write out of nothing.
       */
      if (cell.get('startedAt') != null) cell.set('startedAt', null)
      // And the kernel's question: an answer form with nobody behind it any
      // more is an input field whose "Send" goes into the void, and there is
      // no way to remove it from the screen.
      if (cell.get('stdin') != null) cell.set('stdin', null)
      // `ranMs` is left alone: it is a measured fact from a single server
      // clock, and a restart does not make it untrue. Erasing it would remove
      // "· 4s" from the whole notebook on every server update.
    }

    /*
     * A turn left mid-answer is in the same position as a cell left mid-run:
     * the process that was writing it is gone, and nothing will ever finish
     * it. Without this the thread kept a "thinking" spinner turning for the
     * rest of the seminar — and, because the newest turn is the one the panel
     * follows, it turned at the bottom of everybody's screen.
     *
     * Counted separately from cells: an oracle turn has already spoken for
     * itself — right in the thread, in words — and there is no reason to add
     * it to the line about cells.
     */
    for (const entry of getChat(doc)) {
      if (entry.get('state') !== 'streaming') continue
      const answer = entry.get('answer')
      const said = answer instanceof Y.Text ? answer.toString() : ''
      if (!said.trim()) {
        const text = answer instanceof Y.Text ? answer : null
        text?.insert(text.length, tr("server.theAnswerStoppedWhenTheServerRestarted.a8fefc"))
      }
      entry.set('state', 'error' as ChatState)
      turns++
    }
  }, 'init')

  return { cells: cleared, turns }
}

/**
 * The same thing, as one number — how many CELLS were put back to rest.
 *
 * The name this has always gone by, and it is right to keep calling it where
 * the question is whether to explain things to the room with a line about
 * cells. Interrupted oracle turns are deliberately not included: for the
 * details, see `clearStaleWork`.
 */
export function clearStaleExecution(doc: Y.Doc): number {
  return clearStaleWork(doc).cells
}

/**
 * Give a fresh document something to look at. Safe to call on every load: it
 * only writes when the document is genuinely empty, and says whether it did.
 */
export function ensureInitialNotebook(doc: Y.Doc, title?: string): boolean {
  const meta = getMeta(doc)
  let seeded = false
  doc.transact(() => {
    /*
     * `has`, not the value: an empty title is not "there is no document".
     *
     * A host who erased the name in the header leaves '' in the document. By
     * value the condition is true again, and this very function is called by
     * EVERY browser on every sync — so a student would write the title, and
     * the gate refuses the title to a non-host: 4403, cache cleared, reload,
     * sync again, write again. A loop the tab gets out of only when the host
     * finishes typing the name.
     */
    if (title && !meta.has('title')) meta.set('title', title)
    /*
     * The kernel state is NOT seeded here at all, and that is the fix of
     * 20 Sep 2026.
     *
     * It used to be `starting`, and that was "STARTING python3" in the header
     * of a fresh room — forever, until the first Run: the kernel comes up
     * lazily, that is, a room that was just opened has none and nobody is
     * bringing one up. Exactly the complaint people came with. An empty key
     * reads as `off` ("not running") — and that is true; the server's very
     * first word will overwrite it.
     */
    /*
     * The notebook list comes first, and it is also the migration.
     *
     * A room that ran before multiple notebooks existed keeps its cells in the
     * `cells` root and has no list at all. Here it gets exactly one entry,
     * pointing at that very root: no cell moves, the browser cache and version
     * history stay the same. The file on disk appears next — the projection
     * writes it, see collab/books.ts.
     */
    /*
     * A flag, not an empty list: a room where a notebook was removed ON
     * PURPOSE got it back with all its cells on the next open — the deletion
     * undid itself as soon as the server restarted.
     */
    if (!meta.get('booksSeeded')) {
      meta.set('booksSeeded', true)
      if (bookList(doc).length === 0) addBook(doc, getCells(doc).length > 0 ? DEFAULT_BOOK : defaultBookName(), CELLS_KEY)
    }
    const first = bookList(doc)[0]
    if (!first) return
    const cells = getCells(doc)
    if (cells.length === 0) {
      cells.push([
        createCell(
          'markdown',
          tr('server.welcomeNotebook'),
        ),
        createCell('code', 'print("hello, seminar")'),
      ])
      seeded = true
    }
  }, 'init')
  // The caller needs to know, because a seed that never reaches disk is a seed
  // that happens twice — see getSessionDoc().
  return seeded
}
