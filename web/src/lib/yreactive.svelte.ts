/**
 * Yjs types, read as Svelte state.
 *
 * Yjs notifies by observer callback and Svelte 5 tracks by signal, so every
 * `watch*` here is the same shape: subscribe on first read, unsubscribe when
 * the last reader goes away, and hand back a `Reactive` whose `.current` can be
 * read inside `$derived` like any other rune.
 *
 * They are deliberately narrow. A seminar notebook is tens of CodeMirror
 * instances, each holding several subscriptions, and a watcher that returned
 * "the whole notebook" would wake every cell on every keystroke anywhere. So
 * each one watches the smallest thing a component actually renders — this
 * cell's text, this cell's outputs, this cell's peers — and the coarse ones
 * (`watchCellIds`, `watchNotebookMeta`) return values cheap enough to compare.
 */

import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import {
  allCellArrays,
  bookKernel,
  bookList,
  CELLS_KEY,
  cellId,
  cellOutputs,
  cellSource,
  cellType,
  getMeta,
  isCellOpen,
  readOutput,
  type CellOutput,
  type CellState,
  type CellType,
  type KernelStatus,
  type YCell,
  type YOutput,
  type Book,
  getChat,
  kernelsMap,
  type YChatEntry,
} from '@shared/notebook'
import type { AwarenessUser } from '@shared/protocol'
import { KERNEL_PROBLEM_KEY, readKernelProblem, type KernelProblem } from '@shared/kernel-problem'
import { PRESENCE_TICK_MS } from './peers'

/**
 * Bridge from Yjs observers to Svelte runes.
 *
 * Yjs types mutate in place, so there is nothing for the reactivity system to
 * diff. Each helper mirrors the part of the document a component cares about
 * into a rune and re-reads it when the narrowest observer that can see that
 * part fires. Three rules keep one delta costing one cell:
 *
 *   1. One observer per document, not one per component. Forty cells used to
 *      mean forty `cells.observe` callbacks each doing a linear scan, so an
 *      insert was quadratic in the length of the notebook.
 *   2. A snapshot is only handed on when it differs from the last one, and
 *      unchanged pieces of it keep their object identity. An event that reports
 *      nothing new must reach nothing.
 *   3. $state.raw, not $state: these mirrors are always replaced wholesale, so
 *      deep-proxying a fresh snapshot on every stream chunk buys nothing and
 *      would defeat rule 2.
 *
 * Every helper that binds to a moving target registers an $effect for its
 * subscription, so it must be called during component initialisation.
 */

export interface Reactive<T> {
  readonly current: T
}

type Unsubscribe = () => void

interface Box<T> {
  value: T
}

function box<T>(initial: T): Box<T> {
  let value = $state.raw(initial)
  return {
    get value() {
      return value
    },
    set value(next: T) {
      value = next
    },
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Mirror one subtree of the document into a rune.
 *
 * `subscribe` attaches the narrowest observer that can see a change; `settle`
 * gets the chance to hand back the previous snapshot when the new one says the
 * same thing, which is what stops an unrelated event from invalidating anything
 * downstream. The getter reads through to the document while the effect has not
 * yet bound to the target `select` is naming, so a cell that was just
 * re-parented never paints a frame of the previous target's content.
 */
function mirror<S extends object, T>(
  select: () => S | null,
  empty: T,
  read: (source: S) => T,
  subscribe: (source: S, changed: () => void) => Unsubscribe,
  settle: (next: T, previous: T) => T = (next) => next,
): Reactive<T> {
  const value = box(empty)
  const bound = box<S | null>(null)

  $effect(() => {
    const target = select()
    if (!target) {
      value.value = empty
      bound.value = null
      return
    }
    // Plain, not a rune: reading the previous snapshot through `value` would
    // make this effect depend on what it writes, and it would never settle.
    let previous = empty
    const changed = () => {
      previous = settle(read(target), previous)
      value.value = previous
    }
    changed()
    bound.value = target
    return subscribe(target, changed)
  })

  return {
    get current() {
      const target = select()
      if (target !== bound.value) return target ? read(target) : empty
      return value.value
    },
  }
}

/* ------------------------------------------------- per-document registries */

/*
 * The registries below live exactly as long as their document. `doc.destroy()`
 * drops the shared types, and the WeakMap entry goes with them, so there is
 * nothing to refcount and no teardown ordering to get wrong.
 */

const EMPTY_IDS: string[] = []

/**
 * The cell array, read once per structural event.
 *
 * Survives: typing (a Y.Text edit never reaches a Y.Array observer), cell state
 * writes, output writes. Wakes for: insert, delete, move — and then only the
 * ids whose Y.Map instance actually moved, because notebook-ops clones a cell
 * to move it and leaves every other cell's map alone.
 */
/**
 * The cells of all the room's notebooks, in one place.
 *
 * There is one registry per document, not per notebook, and it is the same
 * decision as `findCell` on the server: a cell is looked up by name without
 * knowing which notebook it is in. So `get(id)` does not ask about the
 * notebook, but the order does: "above" and "below" only make sense within
 * one sheet.
 *
 * Notebooks appear and disappear on the fly — their list itself lives in the
 * document — and the subscriptions are rebuilt when it changes.
 */
class CellRegistry {
  readonly #doc: Y.Doc
  readonly #arrays = new Map<string, Y.Array<YCell>>()
  readonly #ids = new Map<string, Box<string[]>>()
  readonly #byId = new Map<string, YCell>()
  readonly #watchers = new Map<string, Set<(cell: YCell | null) => void>>()
  /**
   * A cell's number — the same one drawn in its left margin.
   *
   * The count runs within its own notebook and starts over in each: the people
   * panel and the Oracle feed call a cell by the same number the person sees
   * next to it. It is built here because all the lists are here anyway.
   */
  readonly numbering = box<Map<string, number>>(new Map())

  /** The roots the registry is subscribed to now — they are how a changed list is noticed. */
  #bound: string[] = []

  constructor(doc: Y.Doc) {
    this.#doc = doc
    this.#rebind(false)
    /*
     * The notebook list lives in meta: it changes when a notebook is opened or
     * removed in the room, and the subscriptions have to keep up with it.
     *
     * Deep, not shallow. The second and later notebooks are appended with a
     * push into the nested `meta.books`, and a shallow observe on a Y.Map does
     * not see a nested change at all: the tab opened (watchBooks draws it, and
     * it has observeDeep), but there were no cells in it — the registry woke
     * up only when someone touched a top-level key, that is, on the first cell
     * run. The work did not grow but shrank: before, the rebuild ran on any
     * write to meta, now only when the list of roots has really changed.
     */
    getMeta(doc).observeDeep(() => {
      if (sameIds(this.#rootKeys(), this.#bound)) return
      this.#rebind(true)
    })
  }

  #rootKeys(): string[] {
    return allCellArrays(this.#doc).map((cells) => Y.findRootTypeKey(cells))
  }

  /** Subscribe to the arrays currently listed as notebooks. */
  #rebind(notify: boolean): void {
    const wanted = new Map<string, Y.Array<YCell>>()
    for (const cells of allCellArrays(this.#doc)) {
      const root = Y.findRootTypeKey(cells)
      wanted.set(root, cells)
    }
    this.#bound = [...wanted.keys()]
    for (const [root, array] of this.#arrays) {
      if (wanted.get(root) === array) continue
      array.unobserve(this.#onChange)
      this.#arrays.delete(root)
    }
    for (const [root, array] of wanted) {
      if (this.#arrays.has(root)) continue
      this.#arrays.set(root, array)
      array.observe(this.#onChange)
    }
    this.#sync(notify)
  }

  #onChange = () => this.#sync(true)

  #box(root: string): Box<string[]> {
    let found = this.#ids.get(root)
    if (!found) {
      found = box<string[]>(EMPTY_IDS)
      this.#ids.set(root, found)
    }
    return found
  }

  #sync(notify: boolean): void {
    const seen = new Set<string>()

    for (const [root, array] of this.#arrays) {
      const ids: string[] = []
      for (const cell of array.toArray()) {
        const id = cellId(cell)
        ids.push(id)
        seen.add(id)
        if (this.#byId.get(id) === cell) continue
        this.#byId.set(id, cell)
        if (notify) this.#wake(id, cell)
      }
      const target = this.#box(root)
      if (!sameIds(ids, target.value)) target.value = ids
    }

    for (const id of [...this.#byId.keys()]) {
      if (seen.has(id)) continue
      this.#byId.delete(id)
      if (notify) this.#wake(id, null)
    }

    const numbers = new Map<string, number>()
    for (const target of this.#ids.values()) {
      target.value.forEach((id, at) => numbers.set(id, at + 1))
    }
    if (!sameNumbers(numbers, this.numbering.value)) this.numbering.value = numbers
    // A notebook removed from the room: its list is emptied, otherwise the
    // screen would keep cells that are no longer in the document.
    for (const [root, target] of this.#ids) {
      if (this.#arrays.has(root) || target.value.length === 0) continue
      target.value = EMPTY_IDS
    }
  }

  #wake(id: string, cell: YCell | null): void {
    const watchers = this.#watchers.get(id)
    if (!watchers) return
    for (const watcher of watchers) watcher(cell)
  }

  ids(root: string): Box<string[]> {
    return this.#box(root)
  }

  get(id: string): YCell | null {
    return this.#byId.get(id) ?? null
  }

  watch(id: string, onChange: (cell: YCell | null) => void): Unsubscribe {
    let watchers = this.#watchers.get(id)
    if (!watchers) {
      watchers = new Set()
      this.#watchers.set(id, watchers)
    }
    watchers.add(onChange)
    return () => {
      watchers.delete(onChange)
      if (watchers.size === 0) this.#watchers.delete(id)
    }
  }
}

function sameNumbers(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false
  for (const [id, n] of a) if (b.get(id) !== n) return false
  return true
}

const cellRegistries = new WeakMap<Y.Doc, CellRegistry>()

function cellRegistry(doc: Y.Doc): CellRegistry {
  let registry = cellRegistries.get(doc)
  if (!registry) {
    registry = new CellRegistry(doc)
    cellRegistries.set(doc, registry)
  }
  return registry
}

/** Ordered cell ids of ONE notebook. Fires on insert/delete/move, and only when
    the sequence genuinely differs — not on typing, not on a run. */
export function watchCellIds(doc: Y.Doc, root: () => string): Reactive<string[]> {
  const registry = cellRegistry(doc)
  return {
    get current() {
      return registry.ids(root()).value
    },
  }
}

/**
 * The room's notebooks in order.
 *
 * The list lives in `meta` because it is part of the document: an open
 * notebook is the room's state, not a tab's, and a latecomer sees the same
 * notebooks as everyone else.
 */
export function watchBooks(doc: Y.Doc): Reactive<Book[]> {
  const meta = getMeta(doc)
  // A plain snapshot, not a rune: comparing through `value` would mean
  // depending on what this very observer writes.
  let previous = bookList(doc)
  const value = box<Book[]>(previous)
  const read = () => {
    const next = bookList(doc)
    if (sameBooks(next, previous)) return
    previous = next
    value.value = next
  }

  /*
   * The subscription lives exactly as long as its reader.
   *
   * The terminal drawer's tabs (history, files, Oracle) mount and vanish on
   * every switch, and an `observeDeep` without a matching unsubscribe would
   * leave an eternal observer on meta from every mount — by the end of a
   * class there are dozens of them, and each rebuilds the notebook list on
   * any write to the document.
   */
  $effect(() => {
    read()
    meta.observeDeep(read)
    return () => meta.unobserveDeep(read)
  })

  return {
    get current() {
      return value.value
    },
  }
}

function sameBooks(a: Book[], b: Book[]): boolean {
  return a.length === b.length && a.every((x, i) => x.path === b[i].path && x.root === b[i].root)
}

/**
 * Cell numbers: name → the number drawn on its left.
 *
 * Panels that call a cell by number do not need to know the notebook, and it
 * would hurt: the cell could come from any of them, and it has one number.
 */
export function watchCellNumbers(doc: Y.Doc): Reactive<Map<string, number>> {
  const registry = cellRegistry(doc)
  return {
    get current() {
      return registry.numbering.value
    },
  }
}

/** The Y.Map behind one id, in whichever notebook it lives. Replaced only when
    that cell is re-parented, which a move does (Y.Array has no move, so the
    cell is cloned) and nothing else. */
export function watchCell(doc: Y.Doc, id: () => string): Reactive<YCell | null> {
  const registry = cellRegistry(doc)
  const value = box<YCell | null>(null)
  const bound = box<string | null>(null)

  $effect(() => {
    const key = id()
    value.value = registry.get(key)
    bound.value = key
    return registry.watch(key, (cell) => (value.value = cell))
  })

  return {
    get current() {
      const key = id()
      if (key !== bound.value) return registry.get(key)
      return value.value
    },
  }
}

/* ------------------------------------------------------------- cell meta */

export interface CellMeta {
  type: CellType
  state: CellState
  execCount: number | null
  runBy: string | null
  /** Participant id, so "is this run mine?" is not decided by a display name. */
  runById: string | null
  /**
   * Set while the cell is stopped inside input(). The kernel is blocked until
   * somebody in the room answers, so this is a state of the seminar, not of
   * whoever pressed Run.
   */
  stdin: { prompt: string; password: boolean } | null
  /**
   * The server clock at the moment this run started. Read only while
   * state === 'running': in any other state the value is garbage from last
   * time that nobody looks at.
   */
  startedAt: number | null
  /** How long the last COMPLETED run took. null for an interrupted one. */
  ranMs: number | null
  /**
   * The cell was opened to the room — in a notebook that is otherwise the
   * teacher's.
   *
   * A field of the cell, not a property of the room: a lecture can have any
   * number of open cells, and each is its own decision. The server writes it
   * (`cell:open`), and it arrives here as an ordinary CRDT frame, like the
   * state and the execution count.
   */
  open: boolean
}

const EMPTY_META: CellMeta = {
  type: 'code',
  state: 'idle',
  execCount: null,
  runBy: null,
  runById: null,
  stdin: null,
  startedAt: null,
  ranMs: null,
  open: false,
}
/*
 * The keys whose change wakes a cell's readers.
 *
 * Adding the two new ones here costs nothing: both are written in the same
 * transaction that changes `state`, and `state` is in the list anyway. Not a
 * single cell wakes up more than it did before.
 *
 * And the consequence this is written for: a field that changes on a timer
 * must not be added here. It would wake every reader of the cell every frame
 * — and this whole module exists precisely so that forty cells do not wake
 * up eighty times over for one Run All.
 *
 * `open` meets this measure: the teacher writes it with a click, that is, a
 * handful of times per class, and it wakes exactly the cell that was opened.
 */
const META_KEYS = [
  'type',
  'state',
  'execCount',
  'runBy',
  'runById',
  'stdin',
  'startedAt',
  'ranMs',
  'open',
] as const

function readMeta(cell: YCell): CellMeta {
  return {
    type: cellType(cell),
    state: (cell.get('state') as CellState) ?? 'idle',
    execCount: (cell.get('execCount') as number | null) ?? null,
    runBy: (cell.get('runBy') as string | null) ?? null,
    runById: (cell.get('runById') as string | null) ?? null,
    stdin: (cell.get('stdin') as CellMeta['stdin']) ?? null,
    startedAt: (cell.get('startedAt') as number | null) ?? null,
    ranMs: (cell.get('ranMs') as number | null) ?? null,
    open: isCellOpen(cell),
  }
}

function sameMeta(a: CellMeta, b: CellMeta): boolean {
  return (
    a.type === b.type &&
    a.state === b.state &&
    a.execCount === b.execCount &&
    a.runBy === b.runBy &&
    a.runById === b.runById &&
    // A flat comparison: the object comes from the document anew on every
    // change, so comparing by reference is pointless.
    a.stdin?.prompt === b.stdin?.prompt &&
    a.stdin?.password === b.stdin?.password &&
    (a.stdin === null) === (b.stdin === null) &&
    // A field forgotten here means the rune hands back an equal object and
    // the clock on the cell never starts: the comparison is field by field,
    // and it fails quietly.
    a.startedAt === b.startedAt &&
    a.ranMs === b.ranMs &&
    a.open === b.open
  )
}

/**
 * A cell's attributes. Its text belongs to CodeMirror and its outputs to
 * watchOutputs.
 *
 * Survives: every keystroke (a Y.Text edit does not fire its parent map), and
 * re-seating 'source' or 'outputs', which is filtered out by key. Wakes for: a
 * type change and the four writes a run makes — and only when the values move.
 */
export function watchCellMeta(cell: () => YCell | null): Reactive<CellMeta> {
  return mirror(
    cell,
    EMPTY_META,
    readMeta,
    (target, changed) => {
      const observer = (event: Y.YMapEvent<any>) => {
        for (const key of META_KEYS) {
          if (event.keysChanged.has(key)) {
            changed()
            return
          }
        }
      }
      target.observe(observer)
      return () => target.unobserve(observer)
    },
    (next, previous) => (sameMeta(next, previous) ? previous : next),
  )
}

/* ---------------------------------------------------------------- outputs */

const EMPTY_OUTPUTS: CellOutput[] = []

/**
 * A parsed output, as long as the entry has not changed.
 *
 * `readOutput` parses the whole JSON for data and error, and the reader is
 * woken by EVERY stdout append — up to twenty times a second for a streaming
 * cell. An image that had not moved since last time was parsed again with
 * every frame of a progress bar; the cell's 400 KB cap tells how much that
 * cost. The key is the Y.Map entry itself: the WeakMap lets go of it together
 * with the document, and the stored `json` string answers "was it rewritten?".
 */
const parsedOutputs = new WeakMap<YOutput, { json: string; value: CellOutput }>()

function readOutputSnapshot(cell: YCell): CellOutput[] {
  const out: CellOutput[] = []
  cellOutputs(cell).forEach((entry: YOutput) => {
    const json = entry.get('json')
    if (typeof json === 'string') {
      const cached = parsedOutputs.get(entry)
      if (cached && cached.json === json) {
        out.push(cached.value)
        return
      }
      const parsed = readOutput(entry)
      if (!parsed) return
      parsedOutputs.set(entry, { json, value: parsed })
      out.push(parsed)
      return
    }
    // A stream: the text lives in a Y.Text, there is nothing to parse.
    const parsed = readOutput(entry)
    if (parsed) out.push(parsed)
  })
  return out
}

function sameOutput(a: CellOutput, b: CellOutput): boolean {
  // The same entry, untouched since last time — see parsedOutputs.
  if (a === b) return true
  if (a.kind !== b.kind) return false
  if (a.kind === 'stream' && b.kind === 'stream') {
    // Length first: a stream that just grew differs in O(1), which is the case
    // this runs in thirty times a second.
    return a.name === b.name && a.text.length === b.text.length && a.text === b.text
  }
  if (a.kind === 'error' && b.kind === 'error') {
    return a.ename === b.ename && a.evalue === b.evalue && sameIds(a.traceback, b.traceback)
  }
  if (a.kind === 'data' && b.kind === 'data') {
    if (a.execCount !== b.execCount) return false
    const mimes = Object.keys(a.data)
    if (mimes.length !== Object.keys(b.data).length) return false
    return mimes.every((mime) => a.data[mime] === b.data[mime])
  }
  return false
}

/**
 * One cell's outputs. observeDeep because a streaming stdout grows a Y.Text
 * *inside* an entry rather than touching the array; it is scoped to this cell's
 * own outputs, so another cell's run is invisible here.
 *
 * Entries that did not change keep their object identity, which is what stops a
 * single stdout chunk from re-running the ansi parser and DOMPurify over every
 * other output the cell already had.
 */
export function watchOutputs(cell: () => YCell | null): Reactive<CellOutput[]> {
  return mirror(
    cell,
    EMPTY_OUTPUTS,
    readOutputSnapshot,
    (target, changed) => {
      const list = cellOutputs(target)
      list.observeDeep(changed)
      return () => list.unobserveDeep(changed)
    },
    (next, previous) => {
      let identical = next.length === previous.length
      for (let i = 0; i < next.length; i++) {
        const before = previous[i]
        if (before !== undefined && sameOutput(next[i], before)) next[i] = before
        else identical = false
      }
      return identical ? previous : next
    },
  )
}

/**
 * Live source text, for the rendered form of a note.
 *
 * This is the one helper that does wake on every keystroke, and rebuilding the
 * string is O(cell). Ask for it only where something will actually render it —
 * a code cell's text is CodeMirror's business and never needs a copy here.
 */
export function watchText(cell: () => YCell | null): Reactive<string> {
  return mirror(
    cell,
    '',
    (target) => cellSource(target).toString(),
    (target, changed) => {
      const source = cellSource(target)
      source.observe(changed)
      return () => source.unobserve(changed)
    },
  )
}

/* ----------------------------------------------------------- notebook meta */

export interface NotebookMeta {
  title: string
  /**
   * The kernel state of the ROOM's notebook — the old field with the old
   * meaning.
   *
   * Every notebook now has its own kernel (`watchBookKernel` below), and
   * everything that draws one open notebook asks that notebook. What stays
   * here is the room's — for the places that have no notebook at all: the
   * kernel log in the drawer and the people list.
   */
  kernelStatus: KernelStatus
  /** Why the last kernel start failed, if it can be explained (shared/kernel-problem.ts). */
  kernelProblem: KernelProblem | null
  queue: string[]
  runningCellId: string | null
}

/**
 * The kernel state of ONE notebook — what its bar draws.
 *
 * The same four fields as the room's, and that is no coincidence: before
 * there were several kernels, they were the room's. Now "IDLE", the queue
 * counter, "Interrupt" and "Restart" belong to the notebook the person has
 * open — a lecture may be computing while the seminar is free, and one chip
 * for both would lie to both.
 */
export interface BookKernelView {
  kernelStatus: KernelStatus
  kernelProblem: KernelProblem | null
  queue: string[]
  runningCellId: string | null
}

/**
 * Document-level state, split one field per source.
 *
 * `meta` is observed deeply because the run queue is a nested Y.Array, and Run
 * All rewrites that queue once per cell. Handing out a rebuilt object each time
 * meant a forty-cell run woke every reader of every field — the header's kernel
 * chip, the terminal, and all forty gutters — eighty times over. `view` is a
 * fixed object of getters instead, so reading `.kernelStatus` subscribes to the
 * kernel status and nothing else.
 */
class MetaRegistry {
  readonly title = box('')
  readonly kernelStatus = box<KernelStatus>('off')
  readonly kernelProblem = box<KernelProblem | null>(null)
  readonly queue = box<string[]>(EMPTY_IDS)
  readonly runningCellId = box<string | null>(null)
  /*
   * Kernel state per notebook — four "root → value" maps, and all four boxes
   * are created HERE, in the constructor. Why not one box per notebook — the
   * full argument is at `bookView`.
   */
  readonly bookStatus = box<Record<string, KernelStatus>>({})
  readonly bookProblem = box<Record<string, KernelProblem | null>>({})
  readonly bookQueue = box<Record<string, string[]>>({})
  readonly bookRunning = box<Record<string, string | null>>({})
  readonly view: NotebookMeta

  readonly #meta: Y.Map<any>
  readonly #doc: Y.Doc
  /** Ready-made getter sets per root — with no state of their own. */
  readonly #views = new Map<string, BookKernelView>()

  constructor(doc: Y.Doc) {
    this.#doc = doc
    this.#meta = getMeta(doc)

    const fields = this
    this.view = {
      get title() {
        return fields.title.value
      },
      get kernelStatus() {
        return fields.kernelStatus.value
      },
      get kernelProblem() {
        return fields.kernelProblem.value
      },
      get queue() {
        return fields.queue.value
      },
      get runningCellId() {
        return fields.runningCellId.value
      },
    }

    this.#readScalars()
    this.#readQueue()
    this.#meta.observeDeep(this.#onEvents)
  }

  /**
   * The kernel state of one notebook — as a ready-made set of getters.
   *
   * The VALUES themselves do not live here but in the registry's four boxes
   * (one box per field, holding a "root → value" map). Only the object with
   * getters is created here, and it holds no rune state at all — that is the
   * fix of 20 Sep 2026.
   *
   * Why this way rather than a box per notebook. The boxes used to be created
   * ON FIRST REQUEST, and the first request comes from a `$derived` in the
   * room header. State created inside a reaction is owned by that reaction:
   * later writes to it from outside do NOT wake the reaction. So the kernel
   * chip showed the first value it read forever — "STARTING" for a kernel that
   * was up — although the box dutifully received the truth (measured on the
   * test bench on 20 Sep 2026: `box= idle`, "STARTING" on screen). `untrack`
   * around the creation does not help: ownership is not assigned by active
   * dependency. The same trap lay under the queue, "Interrupt" and the advice
   * about a kernel that failed to start — they are the same boxes.
   *
   * The cost: a change to the queue of ONE notebook wakes the queue readers of
   * all open ones. There are only a few of them (1–3 open notebooks), the
   * value does not change, and `sameIds` keeps the array's identity — so the
   * derived values go no further. The fields are separate boxes: the queue
   * count does not wake the state chip.
   */
  bookView(root: string): BookKernelView {
    let view = this.#views.get(root)
    if (view) return view
    const fields = this
    view = {
      get kernelStatus() {
        return fields.bookStatus.value[root] ?? 'off'
      },
      get kernelProblem() {
        return fields.bookProblem.value[root] ?? null
      },
      get queue() {
        return fields.bookQueue.value[root] ?? EMPTY_IDS
      },
      get runningCellId() {
        return fields.bookRunning.value[root] ?? null
      },
    }
    this.#views.set(root, view)
    /*
     * The notebook has to be read, but not FROM HERE.
     *
     * The first request comes from a `$derived` in the header, and Svelte
     * forbids writing to state while a derived value is being computed
     * (`state_unsafe_mutation`) — rightly so. A microtask makes it before the
     * paint: the value arrives in the same frame, just on the scheduler's next
     * pass. Whoever can read in advance is asked to do so in advance — see
     * `prime` below.
     */
    if (!(root in this.bookStatus.value)) queueMicrotask(() => this.#readBooks(root))
    return view
  }

  /**
   * Reserve the notebook's place in the maps IN ADVANCE — from component
   * initialisation.
   *
   * Called from `watchBookKernel`, that is, from the component body, where
   * there is no reaction and writing to state is allowed. Thanks to this the
   * open notebook's chip is right from the very first frame, and the
   * microtask above stays as a safety net for notebooks asked about later
   * (switching tabs).
   */
  prime(root: string): void {
    this.bookView(root)
    if (!(root in this.bookStatus.value)) this.#readBooks(root)
  }

  /**
   * Re-read the notebooks' state into the four maps — and replace only what
   * changed.
   *
   * All roots anyone has asked about are read, plus the named one. Fewer is
   * not an option: the kernel map appears in the document later than the tab,
   * and a notebook whose entry was missing at the first read would otherwise
   * keep the default forever.
   */
  #readBooks(extra?: string): void {
    const roots = new Set(this.#views.keys())
    if (extra) roots.add(extra)
    if (roots.size === 0) return
    const status: Record<string, KernelStatus> = {}
    const problem: Record<string, KernelProblem | null> = {}
    const queue: Record<string, string[]> = {}
    const running: Record<string, string | null> = {}
    let sameStatus = true
    let sameProblem = true
    let sameQueue = true
    let sameRunning = true
    const wasStatus = this.bookStatus.value
    const wasProblem = this.bookProblem.value
    const wasQueue = this.bookQueue.value
    const wasRunning = this.bookRunning.value
    for (const root of roots) {
      const state = bookKernel(this.#doc, root)
      status[root] = state.status
      if (wasStatus[root] !== state.status) sameStatus = false
      running[root] = state.runningCell
      if (wasRunning[root] !== state.runningCell) sameRunning = false
      /*
       * The array's identity is kept while the list is the same: the derived
       * values downstream compare by reference, and a new array with the same
       * contents would redraw the queue counter on every cell.
       */
      const before = wasQueue[root]
      if (before && sameIds(before, state.queue)) queue[root] = before
      else {
        queue[root] = state.queue
        sameQueue = false
      }
      const raw = this.#problemOf(root)
      const kept = wasProblem[root] ?? null
      if (JSON.stringify(kept) === JSON.stringify(raw)) problem[root] = kept
      else {
        problem[root] = raw
        sameProblem = false
      }
    }
    // A vanished root is a change too: the notebook was closed, its entry went away.
    if (Object.keys(wasStatus).length !== roots.size) sameStatus = false
    if (Object.keys(wasQueue).length !== roots.size) sameQueue = false
    if (Object.keys(wasRunning).length !== roots.size) sameRunning = false
    if (Object.keys(wasProblem).length !== roots.size) sameProblem = false
    if (!sameStatus) this.bookStatus.value = status
    if (!sameProblem) this.bookProblem.value = problem
    if (!sameQueue) this.bookQueue.value = queue
    if (!sameRunning) this.bookRunning.value = running
  }

  /** The advice about a kernel that failed to start lives next to the state. */
  #problemOf(root: string): KernelProblem | null {
    const entry = kernelsMap(this.#doc)?.get(root)
    const raw =
      entry instanceof Y.Map
        ? entry.get(KERNEL_PROBLEM_KEY)
        : root === CELLS_KEY
          ? this.#meta.get(KERNEL_PROBLEM_KEY)
          : null
    return readKernelProblem(raw)
  }

  #onEvents = (events: Y.YEvent<any>[]) => {
    let scalars = false
    let queue = false
    for (const event of events) {
      if (event.target === this.#meta) {
        scalars = true
        if ((event as Y.YMapEvent<any>).keysChanged.has('queue')) queue = true
        continue
      }
      /*
       * There are TWO nested types under meta, not one: the run queue and the
       * notebook list (`meta.books`, to which every opened notebook is
       * appended). While the assumption was that only the queue is nested,
       * `#readQueue` fired on every notebook opening: harmless, but it is
       * exactly the kind of untruth in a comment that makes the next change
       * land in the wrong place.
       */
      if (event.target === this.#meta.get('queue')) queue = true
    }
    if (scalars) this.#readScalars()
    if (queue) this.#readQueue()
    /*
     * The kernel map is re-read on ANY event under `meta`, and that is cheaper
     * than it looks: there are as many boxes as open notebooks, and each of
     * them is one read of an entry and of one short list. Working out which
     * entry exactly changed would mean going through three different event
     * targets (the map itself, the notebook's entry, its Y.Array), and the
     * first forgotten target would mean a chip that silently stops updating.
     * Readers wake only on a real change of value — the boxes take care of
     * that.
     */
    if (this.#views.size > 0) this.#readBooks()
  }

  #readScalars(): void {
    const title = (this.#meta.get('title') as string) ?? ''
    if (title !== this.title.value) this.title.value = title

    /*
     * The room's old field is read from the MAP entry of the `cells` notebook,
     * not from the old key: since 20 Sep 2026 the key holds a word for old
     * tabs, with `off` replaced by `idle` (shared/notebook.ts ·
     * legacyKernelStatus). A reader in this tab needs the truth — "the kernel
     * is not running", not "free".
     */
    const status = bookKernel(this.#doc, CELLS_KEY).status
    if (status !== this.kernelStatus.value) this.kernelStatus.value = status

    // The value is a plain object, and every read gives a new one: compare by
    // content, otherwise any edit to meta would wake everyone watching the
    // advice.
    const problem = readKernelProblem(this.#meta.get(KERNEL_PROBLEM_KEY))
    if (JSON.stringify(problem) !== JSON.stringify(this.kernelProblem.value))
      this.kernelProblem.value = problem

    const running = (this.#meta.get('runningCell') as string | null) ?? null
    if (running !== this.runningCellId.value) this.runningCellId.value = running
  }

  #readQueue(): void {
    const list = this.#meta.get('queue')
    const next = list instanceof Y.Array ? (list.toArray() as string[]) : EMPTY_IDS
    if (!sameIds(next, this.queue.value)) this.queue.value = next
  }
}

const metaRegistries = new WeakMap<Y.Doc, MetaRegistry>()

function registryFor(doc: Y.Doc): MetaRegistry {
  let registry = metaRegistries.get(doc)
  if (!registry) {
    registry = new MetaRegistry(doc)
    metaRegistries.set(doc, registry)
  }
  return registry
}

export function watchNotebookMeta(doc: Y.Doc): Reactive<NotebookMeta> {
  const fields = registryFor(doc)
  return {
    get current() {
      return fields.view
    },
  }
}

/**
 * Whether a notebook's kernel is busy — one question for all tabs at once.
 *
 * Separate from `watchBookKernel`, because here the question is about ANOTHER
 * tab: the tab row draws a dot on every notebook, not only on the open one.
 * It is read lazily, inside the `$derived` that builds the row — so the
 * subscription lands exactly on the notebooks currently on screen.
 */
export function watchBookBusy(doc: Y.Doc): { busy: (root: string) => boolean } {
  const fields = registryFor(doc)
  return {
    busy(root: string): boolean {
      const state = fields.bookView(root)
      return (
        state.kernelStatus === 'busy' || state.runningCellId !== null || state.queue.length > 0
      )
    },
  }
}

/**
 * The kernel state of the OPEN notebook.
 *
 * `root` is a function, not a value: a tab does not know its root right away
 * (the notebook list arrives with the document), and passing it once would
 * mean remembering an empty string forever. An empty root answers the same
 * as an empty notebook — "the kernel has not been started yet".
 */
export function watchBookKernel(doc: Y.Doc, root: () => string): Reactive<BookKernelView> {
  const fields = registryFor(doc)
  // From the component body, before any derived value: see `MetaRegistry.prime`.
  fields.prime(root())
  return {
    get current() {
      return fields.bookView(root())
    },
  }
}

/* ----------------------------------------------------------------- peers */

export interface CellPeer {
  clientId: number
  user: AwarenessUser
}

const EMPTY_PEERS: CellPeer[] = []

function samePeers(a: CellPeer[], b: CellPeer[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].clientId !== b[i].clientId) return false
    // Awareness payloads are decoded fresh on every tick, so object identity
    // says nothing. Only what the avatar actually draws counts as a change.
    const before = a[i].user
    const after = b[i].user
    if (before.name !== after.name) return false
    if (before.color !== after.color) return false
    if (before.avatar !== after.avatar) return false
  }
  return true
}

/**
 * Awareness, grouped by the cell each person is standing in.
 *
 * y-codemirror republishes the local cursor on every keystroke, so 'change'
 * fires for every character every participant types. Filtering a whole peer
 * list per cell meant one student typing invalidated the avatar row of every
 * cell in the notebook. This groups once and wakes only the cells whose
 * occupants moved; a cursor travelling inside a cell it was already in changes
 * nothing and therefore reaches nothing.
 */
class PeerIndex {
  readonly #awareness: Awareness
  readonly #watchers = new Map<string, Set<(peers: CellPeer[]) => void>>()
  readonly #current = new Map<string, CellPeer[]>()

  /** The recount is deferred until the end of the presence tick. See `#onChange`. */
  #timer: number | undefined

  constructor(awareness: Awareness) {
    this.#awareness = awareness
    awareness.on('change', this.#onChange)
  }

  /**
   * A presence frame arrived — recount, but no more than once per tick.
   *
   * Grouping walks ALL states, and frames come on every keystroke of each of
   * five hundred people: without batching, this walk ran hundreds of times a
   * second in every tab, even when not a single "editing here" marker moved.
   * The tick is the same as the people list's (lib/peers.ts ·
   * PRESENCE_TICK_MS) — so that avatars in a cell and in the people panel
   * update at the same moment, not one after another.
   */
  #onChange = () => {
    if (this.#watchers.size === 0 || this.#timer !== undefined) return
    this.#timer = window.setTimeout(() => {
      this.#timer = undefined
      this.#regroup()
    }, PRESENCE_TICK_MS)
  }

  #regroup = () => {
    if (this.#watchers.size === 0) return
    const byCell = this.#group()
    for (const [id, watchers] of this.#watchers) {
      const next = byCell.get(id) ?? EMPTY_PEERS
      const previous = this.#current.get(id) ?? EMPTY_PEERS
      if (samePeers(next, previous)) continue
      this.#current.set(id, next)
      for (const watcher of watchers) watcher(next)
    }
  }

  #group(): Map<string, CellPeer[]> {
    const byCell = new Map<string, CellPeer[]>()
    const self = this.#awareness.clientID
    this.#awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return
      const user = state?.user as AwarenessUser | undefined
      const at = user?.activeCellId
      if (!user?.id || !at) return
      const list = byCell.get(at)
      if (list) list.push({ clientId, user })
      else byCell.set(at, [{ clientId, user }])
    })
    // Map iteration order is stable but arrival order is not; sorting keeps a
    // reconnecting tab from reshuffling everyone's avatars.
    for (const list of byCell.values()) {
      if (list.length > 1) list.sort((a, b) => a.clientId - b.clientId)
    }
    return byCell
  }

  peers(id: string): CellPeer[] {
    return this.#current.get(id) ?? this.#group().get(id) ?? EMPTY_PEERS
  }

  watch(id: string, onChange: (peers: CellPeer[]) => void): Unsubscribe {
    let watchers = this.#watchers.get(id)
    if (!watchers) {
      watchers = new Set()
      this.#watchers.set(id, watchers)
      this.#current.set(id, this.#group().get(id) ?? EMPTY_PEERS)
    }
    watchers.add(onChange)
    return () => {
      watchers.delete(onChange)
      if (watchers.size > 0) return
      this.#watchers.delete(id)
      this.#current.delete(id)
    }
  }
}

const peerIndexes = new WeakMap<Awareness, PeerIndex>()

function peerIndex(awareness: Awareness): PeerIndex {
  let index = peerIndexes.get(awareness)
  if (!index) {
    index = new PeerIndex(awareness)
    peerIndexes.set(awareness, index)
  }
  return index
}

/** The people standing in one cell, and nobody else's cursor. */
export function watchCellPeers(awareness: Awareness, id: () => string): Reactive<CellPeer[]> {
  const index = peerIndex(awareness)
  const value = box<CellPeer[]>(EMPTY_PEERS)
  const bound = box<string | null>(null)

  $effect(() => {
    const key = id()
    const unwatch = index.watch(key, (peers) => (value.value = peers))
    value.value = index.peers(key)
    bound.value = key
    return unwatch
  })

  return {
    get current() {
      const key = id()
      if (key !== bound.value) return index.peers(key)
      return value.value
    },
  }
}

/* ------------------------------------------------ Oracle proposals for cells */

/**
 * The turn fields that decide "is there an open proposal for this cell".
 *
 * Everything else in a turn changes far more often and is beside the point:
 * the answer is appended in chunks twenty times a second, so is the
 * reasoning, and the agent's steps pile up in a nested array. None of these
 * events can either create a proposal or close it.
 */
/*
 * The turn keys worth waking cells for: the proposal, its fate, the address
 * and the STATE. The last one came with the "the Oracle is busy with this
 * cell" flag: `state` changes from `streaming` to `done` once per turn, while
 * the answer chunks go through `answer` — so filtering by keys still drops
 * the stream it was introduced for.
 */
const PATCH_KEYS = ['patch', 'patchState', 'cellId', 'cellIds', 'state'] as const

/**
 * The Oracle's open proposals — per cell, with one observer per document.
 *
 * Rule 1 from this file's header, which was broken here the loudest: every
 * CellView set up its own `chat.observeDeep`, and every such observer walked
 * the whole feed from the end on EVERY stream chunk, looking for the entry
 * with its cellId (and for a cell without a proposal — the whole feed back to
 * the start). Forty mounted cells over a feed of three hundred turns at
 * twenty chunks a second make hundreds of thousands of comparisons a second
 * out of nothing, and all this work happened while the Oracle was answering,
 * that is, exactly when the room is looking at the screen.
 *
 * Here there is one observer, a stream chunk is filtered out by keys
 * (`PATCH_KEYS`), and the feed is walked once per event — waking only the
 * cells whose proposal really changed.
 */
class PatchRegistry {
  readonly #chat: Y.Array<YChatEntry>
  readonly #watchers = new Map<string, Set<(entry: YChatEntry | null) => void>>()
  readonly #current = new Map<string, YChatEntry | null>()
  /*
   * A second channel of the same registry: "the Oracle is working on this
   * cell right now".
   *
   * As a separate observer this would be a second walk over the feed on every
   * event — exactly the cost this class was introduced to avoid. One pass
   * computes both maps: proposal and busyness.
   */
  readonly #busyWatchers = new Map<string, Set<(busy: boolean) => void>>()
  readonly #busy = new Map<string, boolean>()

  constructor(doc: Y.Doc) {
    this.#chat = getChat(doc)
    this.#chat.observeDeep(this.#onEvents)
  }

  #onEvents = (events: Y.YEvent<any>[]) => {
    if (this.#watchers.size === 0) return
    let matters = false
    for (const event of events) {
      // The feed itself changed: a turn was added or removed, or the feed was cleared.
      if (event.target === this.#chat) {
        matters = true
        break
      }
      const keys = (event as Y.YMapEvent<any>).keysChanged
      if (keys && PATCH_KEYS.some((key) => keys.has(key))) {
        matters = true
        break
      }
    }
    if (!matters) return

    const open = this.#open()
    for (const [id, watchers] of this.#watchers) {
      const next = open.get(id) ?? null
      if (this.#current.get(id) === next) continue
      this.#current.set(id, next)
      for (const watcher of watchers) watcher(next)
    }

    if (this.#busyWatchers.size === 0) return
    const busy = this.#working()
    for (const [id, watchers] of this.#busyWatchers) {
      const next = busy.has(id)
      if (this.#busy.get(id) === next) continue
      this.#busy.set(id, next)
      for (const watcher of watchers) watcher(next)
    }
  }

  /**
   * The cells the Oracle is working on right now.
   *
   * `cellIds` on a par with `cellId`: the agent takes several cells in one
   * turn, and each of them is busy. A pass over the whole feed, not from the
   * end to the first hit: several turns can run at once — one's own and
   * someone else's.
   */
  #working(): Set<string> {
    const busy = new Set<string>()
    for (let i = 0; i < this.#chat.length; i++) {
      const entry = this.#chat.get(i)
      if (entry.get('state') !== 'streaming') continue
      const one = entry.get('cellId')
      if (typeof one === 'string' && one) busy.add(one)
      const many = entry.get('cellIds')
      if (Array.isArray(many)) for (const id of many) if (typeof id === 'string' && id) busy.add(id)
    }
    return busy
  }

  busy(id: string): boolean {
    const known = this.#busy.get(id)
    return known !== undefined ? known : this.#working().has(id)
  }

  watchBusy(id: string, onChange: (busy: boolean) => void): Unsubscribe {
    let watchers = this.#busyWatchers.get(id)
    if (!watchers) {
      watchers = new Set()
      this.#busyWatchers.set(id, watchers)
      this.#busy.set(id, this.#working().has(id))
    }
    watchers.add(onChange)
    return () => {
      watchers.delete(onChange)
      if (watchers.size > 0) return
      this.#busyWatchers.delete(id)
      this.#busy.delete(id)
    }
  }

  /**
   * One pass over the feed: cell → its open proposal.
   *
   * From the end, because the last one wins — the same rule as in
   * `openPatchFor`, which this grew out of. One pass for all cells, not a pass
   * per cell.
   */
  #open(): Map<string, YChatEntry> {
    const byCell = new Map<string, YChatEntry>()
    for (let i = this.#chat.length - 1; i >= 0; i--) {
      const entry = this.#chat.get(i)
      const cell = entry.get('cellId')
      if (typeof cell !== 'string' || !cell || byCell.has(cell)) continue
      if (entry.get('patchState') !== 'open') continue
      const patch = entry.get('patch')
      if (typeof patch !== 'string' || patch.length === 0) continue
      byCell.set(cell, entry)
    }
    return byCell
  }

  patch(id: string): YChatEntry | null {
    const known = this.#current.get(id)
    return known !== undefined ? known : (this.#open().get(id) ?? null)
  }

  watch(id: string, onChange: (entry: YChatEntry | null) => void): Unsubscribe {
    let watchers = this.#watchers.get(id)
    if (!watchers) {
      watchers = new Set()
      this.#watchers.set(id, watchers)
      this.#current.set(id, this.#open().get(id) ?? null)
    }
    watchers.add(onChange)
    return () => {
      watchers.delete(onChange)
      if (watchers.size > 0) return
      this.#watchers.delete(id)
      this.#current.delete(id)
    }
  }
}

const patchRegistries = new WeakMap<Y.Doc, PatchRegistry>()

function patchRegistry(doc: Y.Doc): PatchRegistry {
  let registry = patchRegistries.get(doc)
  if (!registry) {
    registry = new PatchRegistry(doc)
    patchRegistries.set(doc, registry)
  }
  return registry
}

/**
 * The proposal standing against one cell, if any.
 *
 * Deep, not shallow: a turn's `patch` and `patchState` are set on the entry
 * long after the entry itself joined the array — the patch is lifted out when
 * the answer finishes, and the state changes when somebody decides. An
 * observer on the array alone would show the offer appear and never see it
 * resolve, so the cell would keep offering a patch that had already been
 * applied.
 */
/**
 * Whether the Oracle is busy with this cell right now.
 *
 * Needed where the Oracle panel is collapsed: the gesture is made with a
 * button above the cell, while the answer arrives in another part of the
 * screen, and without this flag it is unclear whether it took the task at
 * all. It ends when `state` changes to `done` or `error` — so the flag clears
 * itself however the turn ended.
 */
export function watchOracleBusy(doc: Y.Doc, id: () => string): Reactive<boolean> {
  const registry = patchRegistry(doc)
  const value = box(false)
  const bound = box<string | null>(null)

  $effect(() => {
    const key = id()
    const unwatch = registry.watchBusy(key, (busy) => (value.value = busy))
    value.value = registry.busy(key)
    bound.value = key
    return unwatch
  })

  return {
    get current() {
      const key = id()
      if (key !== bound.value) return registry.busy(key)
      return value.value
    },
  }
}

export function watchPatchFor(doc: Y.Doc, id: () => string): Reactive<YChatEntry | null> {
  const registry = patchRegistry(doc)
  const value = box<YChatEntry | null>(null)
  const bound = box<string | null>(null)

  $effect(() => {
    const key = id()
    const unwatch = registry.watch(key, (entry) => (value.value = entry))
    value.value = registry.patch(key)
    bound.value = key
    return unwatch
  })

  return {
    get current() {
      const key = id()
      // The cell changed under the watcher and the effect has not rebound yet:
      // read through the registry, otherwise a frame would show the previous
      // cell's proposal.
      if (key !== bound.value) return registry.patch(key)
      return value.value
    },
  }
}
