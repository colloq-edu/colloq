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
  bookList,
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
  type YChatEntry,
} from '@shared/notebook'
import type { AwarenessUser } from '@shared/protocol'
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
 * Ячейки всех тетрадей комнаты, в одном месте.
 *
 * Реестр один на документ, а не на тетрадь, и это то же решение, что и у
 * `findCell` на сервере: ячейку ищут по имени, не зная, в какой она тетради.
 * Поэтому `get(id)` не спрашивает про тетрадь, а порядок — спрашивает: «выше» и
 * «ниже» имеет смысл только внутри одного листа.
 *
 * Тетради появляются и исчезают на ходу — их список сам лежит в документе, — и
 * подписки пересобираются, когда он меняется.
 */
class CellRegistry {
  readonly #doc: Y.Doc
  readonly #arrays = new Map<string, Y.Array<YCell>>()
  readonly #ids = new Map<string, Box<string[]>>()
  readonly #byId = new Map<string, YCell>()
  readonly #watchers = new Map<string, Set<(cell: YCell | null) => void>>()
  /**
   * Номер ячейки — тот же, что нарисован у неё в поле слева.
   *
   * Счёт идёт внутри своей тетради и начинается заново в каждой: панель людей и
   * лента оракула называют ячейку тем же числом, которое человек видит рядом с
   * ней. Собирается здесь, потому что здесь и так есть все списки.
   */
  readonly numbering = box<Map<string, number>>(new Map())

  /** Корни, на которые реестр подписан сейчас, — по ним и видно, что список сменился. */
  #bound: string[] = []

  constructor(doc: Y.Doc) {
    this.#doc = doc
    this.#rebind(false)
    /*
     * Список тетрадей живёт в meta: он меняется, когда в комнате открывают или
     * убирают тетрадь, и подписки должны за ним поспевать.
     *
     * Глубоко, а не мелко. Вторая и следующие тетради дописываются push'ем во
     * вложенный `meta.books`, а мелкий observe на Y.Map вложенного изменения
     * не видит вовсе: вкладка открывалась (её рисует watchBooks, у него
     * observeDeep), а ячеек в ней не было — реестр просыпался только когда
     * кто-нибудь трогал верхнеуровневый ключ, то есть на первом же запуске
     * ячейки. Работы при этом не прибавилось, а убавилось: раньше пересборка
     * шла на любую запись в meta, теперь — только когда список корней правда
     * стал другим.
     */
    getMeta(doc).observeDeep(() => {
      if (sameIds(this.#rootKeys(), this.#bound)) return
      this.#rebind(true)
    })
  }

  #rootKeys(): string[] {
    return allCellArrays(this.#doc).map((cells) => Y.findRootTypeKey(cells))
  }

  /** Подписаться на те массивы, которые сейчас числятся тетрадями. */
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
    // Тетрадь, которую убрали из комнаты: её список опустошается, иначе экран
    // держал бы ячейки, которых в документе больше нет.
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
 * Тетради комнаты по порядку.
 *
 * Список живёт в `meta`, потому что он часть документа: открытая тетрадь — это
 * состояние комнаты, а не вкладки, и опоздавший видит те же тетради, что и все.
 */
export function watchBooks(doc: Y.Doc): Reactive<Book[]> {
  const meta = getMeta(doc)
  // Простой снимок, не руна: сравнивать через `value` значило бы зависеть от
  // того, что этот же наблюдатель и пишет.
  let previous = bookList(doc)
  const value = box<Book[]>(previous)
  const read = () => {
    const next = bookList(doc)
    if (sameBooks(next, previous)) return
    previous = next
    value.value = next
  }

  /*
   * Подписка живёт ровно столько, сколько её читатель.
   *
   * Вкладки ящика терминала (история, файлы, оракул) монтируются и исчезают на
   * каждом переключении, а `observeDeep` без ответной отписки оставлял бы от
   * каждого монтажа вечного наблюдателя на meta — к концу пары их там десятки,
   * и каждый пересобирает список тетрадей на любую запись в документе.
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
 * Номера ячеек: имя → число, которое нарисовано у неё слева.
 *
 * Панелям, которые называют ячейку по номеру, тетрадь знать не нужно и вредно:
 * ячейка могла прийти из любой, а число у неё одно.
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
   * Серверные часы в момент, когда это выполнение началось. Читается только
   * при state === 'running': в любом другом состоянии значение — мусор от
   * прошлого раза, который никто не смотрит.
   */
  startedAt: number | null
  /** Сколько длилось последнее ЗАВЕРШЁННОЕ выполнение. У прерванного — null. */
  ranMs: number | null
  /**
   * Ячейку открыли комнате — в тетради, которая иначе преподавательская.
   *
   * Поле ячейки, а не свойство комнаты: в лекции открытых ячеек бывает
   * сколько угодно, и каждая — своё решение. Пишет его сервер (`cell:open`), а
   * сюда оно приезжает обычным кадром CRDT, как состояние и номер выполнения.
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
 * Ключи, изменение которых будит читателей ячейки.
 *
 * Добавить сюда два новых бесплатно: оба пишутся в той же транзакции, что
 * меняет `state`, а `state` в списке и так. Ни одна ячейка не проснётся сверх
 * того, что просыпалась раньше.
 *
 * И следствие, ради которого это написано: поле, меняющееся по таймеру, сюда
 * добавлять нельзя. Оно будило бы каждый кадр каждого читателя ячейки — а
 * весь этот модуль существует ровно затем, чтобы сорок ячеек не просыпались
 * по восемьдесят раз на один Run All.
 *
 * `open` этой мерке отвечает: его пишет преподаватель нажатием, то есть
 * считаные разы за пару, и будит оно ровно ту ячейку, которую открыли.
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
    // Плоское сравнение: объект приходит из документа заново на каждое
    // изменение, поэтому сравнивать по ссылке бессмысленно.
    a.stdin?.prompt === b.stdin?.prompt &&
    a.stdin?.password === b.stdin?.password &&
    (a.stdin === null) === (b.stdin === null) &&
    // Поле, забытое здесь, означает, что руна отдаст равный объект и часы на
    // ячейке не пойдут вовсе: сравнение поимённое, и молчит оно тихо.
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
 * Разобранный вывод, пока запись не менялась.
 *
 * `readOutput` для data и error разбирает JSON целиком, а читателя будит
 * КАЖДАЯ склейка stdout — до двадцати раз в секунду у стримящей ячейки.
 * Картинка, которая с прошлого раза не двигалась, разбиралась заново вместе с
 * каждым кадром прогресс-бара; потолок ячейки в 400 КБ говорит, сколько это
 * стоило. Ключ — сама запись Y.Map: WeakMap отпускает её вместе с документом,
 * а хранимая строка `json` отвечает на «а не переписали ли её».
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
    // Поток: текст лежит в Y.Text, разбирать нечего.
    const parsed = readOutput(entry)
    if (parsed) out.push(parsed)
  })
  return out
}

function sameOutput(a: CellOutput, b: CellOutput): boolean {
  // Та же запись, не тронутая с прошлого раза, — см. parsedOutputs.
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
      if (event.target === this.#meta) {
        scalars = true
        if ((event as Y.YMapEvent<any>).keysChanged.has('queue')) queue = true
        continue
      }
      /*
       * Вложенных типов под meta ДВА, а не один: очередь запуска и список
       * тетрадей (`meta.books`, куда дописывается каждая открытая). Пока
       * считалось, что вложенная — только очередь, `#readQueue` дёргался на
       * каждое открытие тетради: безвредно, но это ровно та неправда в
       * комментарии, из-за которой следующая правка кладётся мимо.
       */
      if (event.target === this.#meta.get('queue')) queue = true
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

  /** Пересчёт отложен до конца тика присутствия. См. `#onChange`. */
  #timer: number | undefined

  constructor(awareness: Awareness) {
    this.#awareness = awareness
    awareness.on('change', this.#onChange)
  }

  /**
   * Кадр присутствия приехал — пересчитать, но не чаще раза в тик.
   *
   * Группировка обходит ВСЕ состояния, а кадры идут на каждое нажатие каждого
   * из пятисот: без склейки этот обход шёл сотни раз в секунду в каждой вкладке,
   * даже когда ни одна метка «правит здесь» не двигалась. Тик тот же, что у
   * списка людей (lib/peers.ts · PRESENCE_TICK_MS), — чтобы аватары в ячейке и
   * в панели людей обновлялись в один момент, а не по очереди.
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

/* --------------------------------------------- предложения оракула к ячейкам */

/**
 * Поля хода, от которых зависит «есть ли открытое предложение к этой ячейке».
 *
 * Всё остальное в ходе меняется куда чаще и к делу не относится: ответ
 * дописывается кусками двадцать раз в секунду, рассуждение — тоже, шаги агента
 * складываются во вложенный массив. Ни одно из этих событий не может ни
 * завести предложение, ни закрыть его.
 */
/*
 * Ключи хода, ради которых стоит будить ячейки: предложение, его судьба, адрес
 * и СОСТОЯНИЕ. Последний добавился вместе с признаком «оракул занят этой
 * ячейкой»: `state` меняется с `streaming` на `done` один раз за ход, а куски
 * ответа идут по `answer` — то есть отсев по ключам продолжает отбрасывать
 * поток, ради которого он и заведён.
 */
const PATCH_KEYS = ['patch', 'patchState', 'cellId', 'cellIds', 'state'] as const

/**
 * Открытые предложения оракула — по ячейке, одним наблюдателем на документ.
 *
 * Правило 1 из шапки этого файла, которое здесь было нарушено громче всего:
 * каждый CellView заводил свой `chat.observeDeep`, и каждый такой наблюдатель на
 * КАЖДЫЙ кусок стрима шёл по всей ленте с конца, ища запись со своим cellId (а
 * для ячейки без предложения — всю ленту до начала). Сорок смонтированных ячеек
 * на ленте в триста ходов при двадцати кусках в секунду — это сотни тысяч
 * сравнений в секунду на ровном месте, и вся эта работа делалась во время
 * ответа оракула, то есть ровно тогда, когда комната смотрит на экран.
 *
 * Здесь наблюдатель один, кусок стрима отсеивается по ключам (`PATCH_KEYS`), а
 * лента обходится один раз на событие — и будит только те ячейки, у которых
 * предложение правда сменилось.
 */
class PatchRegistry {
  readonly #chat: Y.Array<YChatEntry>
  readonly #watchers = new Map<string, Set<(entry: YChatEntry | null) => void>>()
  readonly #current = new Map<string, YChatEntry | null>()
  /*
   * Второй канал того же реестра: «оракул сейчас работает над этой ячейкой».
   *
   * Отдельным наблюдателем это было бы вторым обходом ленты на каждое событие —
   * ровно та цена, от которой этот класс и заведён. Один проход считает обе
   * карты: предложение и занятость.
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
      // Лента изменилась сама: ход добавили, убрали или ленту очистили.
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
   * Ячейки, над которыми оракул работает прямо сейчас.
   *
   * `cellIds` наравне с `cellId`: агент берёт несколько ячеек одним ходом, и
   * занята каждая из них. Проход по всей ленте, а не с конца до первого
   * попадания: ходов может идти несколько сразу — свой и чужой.
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
   * Один проход по ленте: ячейка → её открытое предложение.
   *
   * С конца, потому что побеждает последнее, — то же правило, что у
   * `openPatchFor`, из которого это и выросло. Проход один на все ячейки, а не
   * по проходу на каждую.
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
 * Занят ли оракул этой ячейкой прямо сейчас.
 *
 * Нужно там, где панель оракула свёрнута: жест сделан кнопкой над ячейкой, а
 * ответ приходит в другое место экрана, и без этого признака непонятно, взял
 * ли он задачу вообще. Заканчивается сменой `state` на `done` или `error` —
 * то есть признак снимается сам, чем бы ход ни кончился.
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
      // Ячейка сменилась под наблюдателем, а эффект ещё не перепривязался:
      // читаем сквозь реестр, иначе кадр показал бы предложение к прошлой.
      if (key !== bound.value) return registry.patch(key)
      return value.value
    },
  }
}
