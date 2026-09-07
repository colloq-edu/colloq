/**
 * Присутствие ОДНОЙ ячейки — для редактора, который дальше неё не смотрит.
 *
 * `yCollab` получает присутствие целиком, и его плагин чужих кареток устроен
 * так: на ЛЮБОЙ чужой кадр он диспатчит транзакцию в свой редактор, а в
 * `update()` обходит `awareness.getStates()` целиком и для каждого чужого
 * `cursor` резолвит две относительные позиции. В тетради смонтировано десять —
 * двадцать пять редакторов (EAGER плюс запас в 1200 px), и один чужой курсор
 * стоил комнате «редакторы × состояния» резолвов. На пятистах человек это
 * секунды процессора в секунду у каждого — при том что чужая каретка видна
 * ровно в одной ячейке, той, в которой человек стоит.
 *
 * Здесь редактору отдаётся не общее присутствие, а вид на него: локальное
 * состояние (курсор по-прежнему пишется в настоящее присутствие, комната его
 * видит) плюс те, у кого `user.activeCellId` — эта ячейка. Тем же признаком
 * группирует аватары `PeerIndex` в lib/yreactive, и объявляет его тот, кто
 * ячейку ПРАВИТ (lib/presence.ts · cellToAnnounce) — то есть ровно тот, у кого
 * есть каретка.
 *
 * Обход состояний при этом один на комнату, а не один на редактор: группировкой
 * занят общий `Room` на присутствие, и он же коалесцирует кадры по одному на
 * отрисовку. Разбудит он только те ячейки, у которых правда что-то изменилось —
 * курсор, цвет или имя стоящего в ней. Редактору кадр уходит настоящим диффом,
 * с выбывшими в `removed`: иначе снять чужую каретку было бы нечем — см.
 * `announce`.
 */
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

type State = Record<string, unknown>

/** Кадр, каким его ждёт слушатель `change` у настоящего присутствия. */
export interface AwarenessDiff {
  added: number[]
  updated: number[]
  removed: number[]
}

type ChangeHandler = (diff: AwarenessDiff, origin: unknown) => void

/** Один человек, стоящий в ячейке. */
interface Standing {
  clientId: number
  state: State
}

/**
 * Ровно та поверхность присутствия, которой пользуется y-codemirror.next:
 * `doc.clientID`, `on`/`off('change')`, `getLocalState`, `setLocalStateField`,
 * `getStates`. Больше он ничего не спрашивает — проверено по исходнику плагина.
 */
export interface CellAwareness {
  readonly doc: Y.Doc
  readonly clientID: number
  getStates(): Map<number, State>
  getLocalState(): State | null
  setLocalStateField(field: string, value: unknown): void
  on(name: string, handler: ChangeHandler): void
  off(name: string, handler: ChangeHandler): void
  destroy(): void
}

/** Отложить работу до следующей отрисовки; возвращает отмену. */
export type Schedule = (run: () => void) => () => void

const NOBODY: Standing[] = []

function browserSchedule(run: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(run, 0)
    return () => clearTimeout(timer)
  }
  const frame = requestAnimationFrame(run)
  return () => cancelAnimationFrame(frame)
}

/**
 * Подпись стоящего: всё, из чего плагин рисует каретку.
 *
 * Сравнивать состояния по ссылке нельзя — присутствие раскодирует их заново на
 * каждый тик, и объект всегда новый. Поэтому по значению, и только по тем
 * полям, от которых зависит нарисованное: положение, цвет и имя.
 *
 * Разделители — `\u0000`/`\u0001` эскейпами, а не самими байтами: имя человек
 * задаёт сам, и на пробеле «Пётр Ильич» слиплось бы с соседом. Байтом в
 * исходнике их класть нельзя — файл становится для `grep` двоичным и молча
 * перестаёт находиться по имени.
 */
function markOf(state: State): string {
  const user = state.user as { color?: unknown; name?: unknown } | undefined
  return `${JSON.stringify(state.cursor ?? null)}\u0000${String(user?.color ?? '')}\u0000${String(
    user?.name ?? '',
  )}`
}

function signatureOf(standing: readonly Standing[]): string {
  let out = ''
  for (const person of standing) out += `${person.clientId}\u0000${markOf(person.state)}\u0001`
  return out
}

/** Тот же снимок, но поимённо: из него считается дифф кадра. */
function marksOf(standing: readonly Standing[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const person of standing) out.set(person.clientId, markOf(person.state))
  return out
}

/**
 * Общая на присутствие бухгалтерия: один обход состояний на кадр, а дальше —
 * только те ячейки, у которых что-то изменилось.
 */
class Room {
  readonly #source: Awareness
  readonly #schedule: Schedule
  /** Ячейка → слушатели её вида. Пустая карта означает «мы отписаны». */
  readonly #watchers = new Map<string, Set<() => void>>()
  readonly #standing = new Map<string, Standing[]>()
  readonly #signature = new Map<string, string>()
  #cancel: (() => void) | null = null

  constructor(source: Awareness, schedule: Schedule) {
    this.#source = source
    this.#schedule = schedule
  }

  get empty(): boolean {
    return this.#watchers.size === 0
  }

  watch(cellId: string, onChange: () => void): () => void {
    let set = this.#watchers.get(cellId)
    if (!set) {
      set = new Set()
      this.#watchers.set(cellId, set)
      if (this.#watchers.size === 1) this.#source.on('change', this.#onChange)
      /*
       * Первый вид считается сразу и молча: редактор строится и спрашивает
       * состояния в том же кадре, а кадр «изменилось» на пустом месте заставил
       * бы плагин диспатчить транзакцию на ровном месте при каждом монтаже.
       */
      const seeded = this.#group().get(cellId) ?? NOBODY
      this.#standing.set(cellId, seeded)
      this.#signature.set(cellId, signatureOf(seeded))
    }
    set.add(onChange)
    return () => {
      const alive = this.#watchers.get(cellId)
      if (!alive) return
      alive.delete(onChange)
      if (alive.size > 0) return
      this.#watchers.delete(cellId)
      this.#standing.delete(cellId)
      this.#signature.delete(cellId)
      if (this.#watchers.size > 0) return
      this.#source.off('change', this.#onChange)
      this.#cancel?.()
      this.#cancel = null
    }
  }

  standing(cellId: string): Standing[] {
    // Пока на ячейку никто не подписан, снимка нет — считаем на месте: за него
    // спросят разве что один раз, при постройке редактора.
    return this.#standing.get(cellId) ?? this.#group().get(cellId) ?? NOBODY
  }

  #onChange = () => {
    if (this.#cancel) return
    this.#cancel = this.#schedule(() => {
      this.#cancel = null
      this.#regroup()
    })
  }

  /** Один обход всех состояний — и рассылка только тем, у кого что-то стало другим. */
  #regroup(): void {
    const byCell = this.#group()
    for (const [cellId, listeners] of this.#watchers) {
      const next = byCell.get(cellId) ?? NOBODY
      const signature = signatureOf(next)
      if (signature === this.#signature.get(cellId)) continue
      this.#signature.set(cellId, signature)
      this.#standing.set(cellId, next)
      for (const listener of listeners) listener()
    }
  }

  #group(): Map<string, Standing[]> {
    const byCell = new Map<string, Standing[]>()
    const self = this.#source.clientID
    this.#source.getStates().forEach((state, clientId) => {
      if (clientId === self) return
      const user = (state as State).user as { activeCellId?: unknown } | undefined
      const at = user?.activeCellId
      if (typeof at !== 'string' || at === '') return
      const list = byCell.get(at)
      if (list) list.push({ clientId, state: state as State })
      else byCell.set(at, [{ clientId, state: state as State }])
    })
    // Порядок прихода кадров не постоянен, а подпись сравнивается строкой:
    // без сортировки переподключившаяся вкладка «меняла» бы каждую ячейку.
    for (const list of byCell.values()) {
      if (list.length > 1) list.sort((a, b) => a.clientId - b.clientId)
    }
    return byCell
  }
}

const rooms = new WeakMap<Awareness, Room>()

function roomFor(source: Awareness, schedule: Schedule): Room {
  let room = rooms.get(source)
  if (!room) {
    room = new Room(source, schedule)
    rooms.set(source, room)
  }
  return room
}

/**
 * Вид на присутствие глазами одной ячейки.
 *
 * @param schedule — чем откладывать склейку кадров; по умолчанию отрисовка.
 * Параметром, а не константой, ради тестов: рамка кадра в node не наступает.
 */
export function cellAwareness(
  source: Awareness,
  cellId: string,
  schedule: Schedule = browserSchedule,
): CellAwareness {
  const room = roomFor(source, schedule)
  const handlers = new Set<ChangeHandler>()
  let unwatch: (() => void) | null = null
  /**
   * Кто был нарисован в этой ячейке на прошлом кадре — и чем.
   *
   * Кадр обязан быть ДИФФОМ, а не списком стоящих сейчас. Плагин чужих кареток
   * диспатчит транзакцию, только если в `added ∪ updated ∪ removed` есть хоть
   * один чужой клиент (y-codemirror.next · y-remote-selections), а ушедшего в
   * списке стоящих уже нет: кадр «кто здесь» на его уход приходил ПУСТЫМ,
   * транзакции не было, `update()` не пересчитывал украшения — и каретка с
   * чужим именем оставалась висеть в покинутой ячейке до любой посторонней
   * правки в этом редакторе. Своего набора там обычно и не случается: в том и
   * смысл десяти — двадцати пяти смонтированных редакторов.
   */
  let seen = new Map<number, string>()

  const announce = () => {
    if (handlers.size === 0) return
    const next = marksOf(room.standing(cellId))
    const added: number[] = []
    const updated: number[] = []
    const removed: number[] = []
    for (const [clientId, mark] of next) {
      const before = seen.get(clientId)
      if (before === undefined) added.push(clientId)
      else if (before !== mark) updated.push(clientId)
    }
    for (const clientId of seen.keys()) if (!next.has(clientId)) removed.push(clientId)
    seen = next
    // Ничего не изменилось — нечего и будить: `Room` до сюда с таким кадром
    // и не доходит, но пустой кадр всё равно не должен выйти наружу.
    if (added.length === 0 && updated.length === 0 && removed.length === 0) return
    const diff: AwarenessDiff = { added, updated, removed }
    for (const handler of [...handlers]) handler(diff, 'cell-awareness')
  }

  return {
    get doc() {
      return source.doc
    },
    get clientID() {
      return source.clientID
    },
    getStates() {
      const out = new Map<number, State>()
      const local = source.getLocalState()
      if (local) out.set(source.clientID, local as State)
      for (const person of room.standing(cellId)) out.set(person.clientId, person.state)
      return out
    },
    getLocalState: () => source.getLocalState() as State | null,
    setLocalStateField: (field, value) => source.setLocalStateField(field, value),
    on(name, handler) {
      if (name !== 'change') return
      handlers.add(handler)
      if (unwatch) return
      unwatch = room.watch(cellId, announce)
      // Плагин строит украшения из `getStates()` сразу после подписки, значит
      // стоящие сейчас уже нарисованы: дифф считается от них, а не от пустоты.
      seen = marksOf(room.standing(cellId))
    },
    off(name, handler) {
      if (name !== 'change') return
      handlers.delete(handler)
      if (handlers.size > 0) return
      unwatch?.()
      unwatch = null
      seen = new Map()
    },
    destroy() {
      handlers.clear()
      unwatch?.()
      unwatch = null
      seen = new Map()
    },
  }
}
