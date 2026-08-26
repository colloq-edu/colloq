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
  cellId,
  cellOutputs,
  cellSource,
  cellType,
  getCells,
  getMeta,
  readOutput,
  type CellOutput,
  type CellState,
  type CellType,
  type KernelStatus,
  type YCell,
  type YOutput,
} from '@shared/notebook'
import type { AwarenessUser } from '@shared/protocol'

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
class CellRegistry {
  readonly ids = box<string[]>(EMPTY_IDS)

  readonly #cells: Y.Array<YCell>
  readonly #byId = new Map<string, YCell>()
  readonly #watchers = new Map<string, Set<(cell: YCell | null) => void>>()

  constructor(doc: Y.Doc) {
    this.#cells = getCells(doc)
    this.#sync(false)
    this.#cells.observe(this.#onChange)
  }

  #onChange = () => this.#sync(true)

  #sync(notify: boolean): void {
    const cells = this.#cells.toArray()
    const ids: string[] = []
    const seen = new Set<string>()

    for (const cell of cells) {
      const id = cellId(cell)
      ids.push(id)
      seen.add(id)
      if (this.#byId.get(id) === cell) continue
      this.#byId.set(id, cell)
      if (notify) this.#wake(id, cell)
    }
    for (const id of [...this.#byId.keys()]) {
      if (seen.has(id)) continue
      this.#byId.delete(id)
      if (notify) this.#wake(id, null)
    }

    if (!sameIds(ids, this.ids.value)) this.ids.value = ids
  }

  #wake(id: string, cell: YCell | null): void {
    const watchers = this.#watchers.get(id)
    if (!watchers) return
    for (const watcher of watchers) watcher(cell)
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

const cellRegistries = new WeakMap<Y.Doc, CellRegistry>()

function cellRegistry(doc: Y.Doc): CellRegistry {
  let registry = cellRegistries.get(doc)
  if (!registry) {
    registry = new CellRegistry(doc)
    cellRegistries.set(doc, registry)
  }
  return registry
}

/** Ordered cell ids. Fires on insert/delete/move, and only when the sequence
    genuinely differs — not on typing, not on a run. */
export function watchCellIds(doc: Y.Doc): Reactive<string[]> {
  const registry = cellRegistry(doc)
  return {
    get current() {
      return registry.ids.value
    },
  }
}

/** The Y.Map behind one id. Replaced only when that cell is re-parented, which
    a move does (Y.Array has no move, so the cell is cloned) and nothing else. */
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
}

const EMPTY_META: CellMeta = {
  type: 'code',
  state: 'idle',
  execCount: null,
  runBy: null,
  runById: null,
  stdin: null,
}
const META_KEYS = ['type', 'state', 'execCount', 'runBy', 'runById', 'stdin'] as const

function readMeta(cell: YCell): CellMeta {
  return {
    type: cellType(cell),
    state: (cell.get('state') as CellState) ?? 'idle',
    execCount: (cell.get('execCount') as number | null) ?? null,
    runBy: (cell.get('runBy') as string | null) ?? null,
    runById: (cell.get('runById') as string | null) ?? null,
    stdin: (cell.get('stdin') as CellMeta['stdin']) ?? null,
  }
}

function sameMeta(a: CellMeta, b: CellMeta): boolean {
  return (
    a.type === b.type &&
    a.state === b.state &&
    a.execCount === b.execCount &&
    a.runBy === b.runBy &&
    a.runById === b.runById &&
    // Плоское сравнение: объект приходит из документа заново на каждое
    // изменение, поэтому сравнивать по ссылке бессмысленно.
    a.stdin?.prompt === b.stdin?.prompt &&
    a.stdin?.password === b.stdin?.password &&
    (a.stdin === null) === (b.stdin === null)
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

function readOutputSnapshot(cell: YCell): CellOutput[] {
  const out: CellOutput[] = []
  cellOutputs(cell).forEach((entry: YOutput) => {
    const parsed = readOutput(entry)
    if (parsed) out.push(parsed)
  })
  return out
}

function sameOutput(a: CellOutput, b: CellOutput): boolean {
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
  kernelStatus: KernelStatus
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
  readonly kernelStatus = box<KernelStatus>('starting')
  readonly queue = box<string[]>(EMPTY_IDS)
  readonly runningCellId = box<string | null>(null)
  readonly view: NotebookMeta

  readonly #meta: Y.Map<any>

  constructor(doc: Y.Doc) {
    this.#meta = getMeta(doc)

    const fields = this
    this.view = {
      get title() {
        return fields.title.value
      },
      get kernelStatus() {
        return fields.kernelStatus.value
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

  #onEvents = (events: Y.YEvent<any>[]) => {
    let scalars = false
    let queue = false
    for (const event of events) {
      if (event.target !== this.#meta) {
        // The run queue is the only nested type under meta.
        queue = true
        continue
      }
      scalars = true
      if ((event as Y.YMapEvent<any>).keysChanged.has('queue')) queue = true
    }
    if (scalars) this.#readScalars()
    if (queue) this.#readQueue()
  }

  #readScalars(): void {
    const title = (this.#meta.get('title') as string) ?? ''
    if (title !== this.title.value) this.title.value = title

    const status = (this.#meta.get('kernelStatus') as KernelStatus) ?? 'starting'
    if (status !== this.kernelStatus.value) this.kernelStatus.value = status

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

export function watchNotebookMeta(doc: Y.Doc): Reactive<NotebookMeta> {
  let registry = metaRegistries.get(doc)
  if (!registry) {
    registry = new MetaRegistry(doc)
    metaRegistries.set(doc, registry)
  }
  const fields = registry
  return {
    get current() {
      return fields.view
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

  constructor(awareness: Awareness) {
    this.#awareness = awareness
    awareness.on('change', this.#onChange)
  }

  #onChange = () => {
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
