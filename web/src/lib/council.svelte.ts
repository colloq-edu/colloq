/**
 * Консилиум на клиенте: своя попытка, стопка преподавателя и счётчики — из
 * сообщений управляющего сокета, по ячейкам.
 *
 * Попытки нарочно не живут в общей тетради (см. shared/protocol.ts · council:*):
 * студент печатает у себя, снимок уезжает на сервер при паузе в наборе, а
 * обратно приходят три разных взгляда — `council:mine` автору, `council:board`
 * преподавателю (целиком — раз, дальше дельтами `council:patch`),
 * `council:count` всей комнате. Здесь они хранятся по ячейке и отдаются
 * CellView как руны; сам сокет живёт в SessionState, и сюда он приходит одной
 * функцией `send`.
 *
 * Карты — `$state.raw` и заменяются целиком, как заметки и чернила в
 * SessionState: снимок стопки на пятьсот попыток оборачивать в глубокий прокси
 * незачем, его читают как целое. Значения при этом сохраняют ссылку: ячейка,
 * чей снимок не менялся, из `$derived` получает тот же объект и не
 * перерисовывается.
 *
 * Чистая часть — `DraftOutbox`, `withOracle`, подписи счётчиков — без рун, и
 * именно она под тестами (tests/council-client.test.mts).
 */
import { untrack } from 'svelte'
import type * as Y from 'yjs'
import {
  cellLock,
  councilSettingsOf,
  type CellLock,
  type CouncilSettings,
  type YCell,
} from '@shared/notebook'
import type {
  ControlClientMessage,
  ControlServerMessage,
  CouncilAttempt,
  CouncilBoard,
  CouncilMine,
  CouncilOracle,
} from '@shared/protocol'
import { plural } from './plural'

/** То из серверных сообщений, что про консилиум, — ровно то, что берёт `receive`. */
export type CouncilMessage = Extract<
  ControlServerMessage,
  { t: 'council:mine' | 'council:board' | 'council:patch' | 'council:oracle' | 'council:count' }
>

export type CouncilPatch = Extract<CouncilMessage, { t: 'council:patch' }>

/** «N сдали из M» — без текстов, для проектора и чипа над ячейкой. */
export interface CouncilCount {
  submitted: number
  total: number
}

/**
 * Пауза в наборе, после которой снимок уезжает на сервер.
 *
 * Меньше секунды из дизайна: человек, дописавший строку и потянувшийся к
 * «Сдать», не должен успевать нажать раньше, чем уедет текст, — иначе сдаётся
 * прошлый снимок. Больше полсекунды: пятьсот человек, шлющих снимок на каждое
 * слово, — это и есть шум, от которого консилиум уводит попытки из CRDT.
 */
export const DRAFT_PAUSE_MS = 800

/**
 * Очередь черновиков: один таймер на ячейку, последний текст побеждает.
 *
 * Отдельным классом без рун и с подставными часами — чтобы проверить ровно то,
 * из-за чего такие очереди врут: два быстрых нажатия дают одну отправку,
 * «Сдать» до истечения паузы уносит свежий текст, а не прошлый, и ячейка,
 * в которой ничего не набирали, при сдаче не шлёт пустой снимок.
 */
export class DraftOutbox {
  readonly #pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()
  readonly #send: (cellId: string, text: string) => void
  readonly #pause: number

  constructor(send: (cellId: string, text: string) => void, pause = DRAFT_PAUSE_MS) {
    this.#send = send
    this.#pause = pause
  }

  /** Придержать текст: уедет через паузу, если за это время не позовут снова. */
  hold(cellId: string, text: string): void {
    const previous = this.#pending.get(cellId)
    if (previous) clearTimeout(previous.timer)
    const timer = setTimeout(() => this.flush(cellId), this.#pause)
    this.#pending.set(cellId, { text, timer })
  }

  /** Отправить сейчас то, что придержано для этой ячейки. Ничего — ничего. */
  flush(cellId: string): boolean {
    const pending = this.#pending.get(cellId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.#pending.delete(cellId)
    this.#send(cellId, pending.text)
    return true
  }

  /** Забыть придержанное, не отправляя: консилиум закрыли под рукой. */
  drop(cellId: string): void {
    const pending = this.#pending.get(cellId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(cellId)
  }

  has(cellId: string): boolean {
    return this.#pending.has(cellId)
  }

  /** Снять все таймеры — при уходе из комнаты. Ничего не шлёт: сокета уже нет. */
  clear(): void {
    for (const { timer } of this.#pending.values()) clearTimeout(timer)
    this.#pending.clear()
  }
}

/** Стопка с новым состоянием оракула — прочее нетронуто. */
export function withOracle(board: CouncilBoard, oracle: CouncilOracle): CouncilBoard {
  return { ...board, oracle }
}

/**
 * Стопка после дельты: попытки из кадра заменяют свои по participantId (новые
 * — в конец), `removed` уходят, числа и замок — из кадра. Порядок остальных
 * не меняется: группы и стопку пульт считает сам, и порядок здесь ни на что
 * не влияет, а лишняя пересортировка — лишняя перерисовка.
 */
export function withPatch(board: CouncilBoard, patch: CouncilPatch): CouncilBoard {
  const fresh = new Map(patch.attempts.map((a) => [a.participantId, a] as const))
  const gone = new Set(patch.removed)
  const attempts: CouncilAttempt[] = []
  for (const attempt of board.attempts) {
    if (gone.has(attempt.participantId)) continue
    const next = fresh.get(attempt.participantId)
    if (next) fresh.delete(attempt.participantId)
    attempts.push(next ?? attempt)
  }
  for (const attempt of fresh.values()) if (!gone.has(attempt.participantId)) attempts.push(attempt)
  return {
    ...board,
    attempts,
    counts: patch.counts,
    lock: patch.lock,
    settings: patch.settings,
  }
}

/**
 * С чего заводить свой лист: со своей попытки, если она есть, иначе с общего
 * текста ячейки — задание обычно лежит в нём.
 *
 * Пустая строка от сервера — не попытка, а «попытки ещё нет» (mineFor при
 * открытом консилиуме шлёт `text: ''`), и заводить ею лист нельзя: замок
 * приезжает по CRDT, `council:mine` — по управляющему сокету, и у того, кому
 * первым дошёл `mine`, лист оказывался пустым, а у соседа — с заданием. Один
 * класс, два разных стартовых листа, по жребию двух сокетов.
 */
export function sheetSeed(mineText: string | null | undefined, shared: string): string {
  return mineText || shared
}

/**
 * Полоса режима преподавателя: «487 попыток · 446 сдали · 41 ещё пишут ·
 * 6 разных ответов». Куски без чего сказать — опускаются: «0 ещё пишут» в
 * конце работы — это шум рядом с числом, ради которого смотрят.
 */
export function councilStripText(counts: CouncilBoard['counts']): string {
  const parts: string[] = []
  parts.push(`${counts.attempts} ${plural(counts.attempts, 'попытка', 'попытки', 'попыток')}`)
  parts.push(`${counts.submitted} ${plural(counts.submitted, 'сдал', 'сдали', 'сдали')}`)
  if (counts.writing > 0) {
    parts.push(`${counts.writing} ещё ${plural(counts.writing, 'пишет', 'пишут', 'пишут')}`)
  }
  if (counts.groups > 0) {
    parts.push(
      `${counts.groups} ${plural(counts.groups, 'разный ответ', 'разных ответа', 'разных ответов')}`,
    )
  }
  return parts.join(' · ')
}

/** «446 сдали из 487» — чип у студента и строка проектора. */
export function countLine(count: CouncilCount): string {
  return `${count.submitted} ${plural(count.submitted, 'сдал', 'сдали', 'сдали')} из ${count.total}`
}

/**
 * Кто и как запускал попытку — строка под выводом у автора.
 *
 * «Вы» вместо имени: у автора один собеседник — преподаватель, и второе имя в
 * этой строке было бы его собственным.
 */
export function ranByLine(
  run: NonNullable<CouncilMine['run']>,
  spellMs: (ms: number) => string,
): string {
  if (run.state === 'queued') return 'в очереди на запуск'
  if (run.state === 'running') return 'выполняется'
  const who = run.by === 'host' ? 'запускал преподаватель' : 'запускали вы'
  return run.ranMs === null ? who : `${who} · ${spellMs(run.ranMs)}`
}

/**
 * «вы 37-й в очереди» — место в очереди на запуск, если ручка включена.
 *
 * Мужской род без склонения: порядковое от любого числа в именительном
 * кончается на «-й» (первый, третий, сороковой), так что окончание одно.
 */
export function queueWords(place: number): string {
  return `вы ${place}-й в очереди`
}

/* ------------------------------------------------------------------ руны */

/**
 * Состояние консилиума комнаты. Живёт в SessionState и умирает с ним.
 *
 * Отправка — только через `send` сокета: очередь на закрытом соединении и
 * «нет связи» словами остаются там, где они у всех остальных нажатий.
 */
export class CouncilState {
  /** Своя попытка по ячейкам — приходит только автору. */
  mine = $state.raw<Record<string, CouncilMine>>({})
  /** Стопки по ячейкам — приходят только преподавателю. */
  boards = $state.raw<Record<string, CouncilBoard>>({})
  /** «N сдали из M» по ячейкам — всей комнате. */
  counts = $state.raw<Record<string, CouncilCount>>({})
  /**
   * Стопка или сводка — положение общее на все ячейки, а не своё у каждой:
   * преподаватель, переключившийся на сводку, смотрит сводку и в следующей
   * ячейке тоже — это способ смотреть, а не свойство ячейки.
   */
  view = $state<'stack' | 'summary'>('stack')

  readonly #send: (message: ControlClientMessage) => void
  readonly #outbox: DraftOutbox
  /**
   * Оракул, приехавший раньше своей стопки. Стопка приходит целиком и несёт
   * `oracle` внутри, так что обычно это пусто; но порядок кадров в
   * приветственной пачке никто не обещал, и потерять ответ модели из-за него
   * было бы обидно — он стоил вопроса из лимита комнаты.
   */
  readonly #earlyOracles = new Map<string, CouncilOracle>()

  constructor(send: (message: ControlClientMessage) => void) {
    this.#send = send
    this.#outbox = new DraftOutbox((cellId, text) =>
      this.#send({ t: 'council:draft', cellId, text }),
    )
  }

  receive(message: CouncilMessage): void {
    if (message.t === 'council:mine') {
      this.mine = { ...this.mine, [message.cellId]: message.state }
      // Закрытый консилиум не принимает снимков — придержанный уходит без
      // отправки, текст при этом остаётся в редакторе автора черновиком.
      if (message.state.closed) this.#outbox.drop(message.cellId)
      return
    }
    if (message.t === 'council:board') {
      const early = this.#earlyOracles.get(message.cellId)
      const board =
        early && message.board.oracle === null ? withOracle(message.board, early) : message.board
      this.#earlyOracles.delete(message.cellId)
      this.boards = { ...this.boards, [message.cellId]: board }
      return
    }
    if (message.t === 'council:patch') {
      const board = this.boards[message.cellId]
      // Стопки по этой ячейке ещё нет — дельту некуда класть: полная стопка
      // приезжает пачкой при подключении и на смену замка, дельта без неё
      // выдала бы стопку из одного человека за весь класс.
      if (!board) return
      this.boards = { ...this.boards, [message.cellId]: withPatch(board, message) }
      return
    }
    if (message.t === 'council:oracle') {
      const board = this.boards[message.cellId]
      if (board)
        this.boards = { ...this.boards, [message.cellId]: withOracle(board, message.oracle) }
      else this.#earlyOracles.set(message.cellId, message.oracle)
      return
    }
    this.counts = {
      ...this.counts,
      [message.cellId]: { submitted: message.submitted, total: message.total },
    }
  }

  /* ------------------------------------------------------------ свой лист */

  /** Придержать снимок текста: уедет через паузу в наборе. */
  draft(cellId: string, text: string): void {
    this.#outbox.hold(cellId, text)
  }

  /** Отправить придержанное сейчас — на уходе фокуса и перед «Сдать». */
  flush(cellId: string): void {
    this.#outbox.flush(cellId)
  }

  /**
   * «Сдать». Сначала свежий снимок, потом сдача: иначе сервер сдал бы текст
   * секундной давности, а последняя строка приехала бы уже к сданному.
   */
  submit(cellId: string): void {
    this.#outbox.flush(cellId)
    this.#send({ t: 'council:submit', cellId })
  }

  /** «Изменить»: снять «сдано», текст остаётся. */
  withdraw(cellId: string): void {
    this.#send({ t: 'council:withdraw', cellId })
  }

  /** Запустить: свою попытку (без participantId) или чью-то — преподаватель. */
  run(cellId: string, participantId?: string): void {
    if (participantId === undefined) this.#outbox.flush(cellId)
    this.#send(
      participantId === undefined
        ? { t: 'council:run', cellId }
        : { t: 'council:run', cellId, participantId },
    )
  }

  /* --------------------------------------------------------------- ведущий */

  /** Замок в положение — и ручки консилиума тем же сообщением. */
  lock(cellId: string, state: CellLock, settings?: Partial<CouncilSettings>): void {
    this.#send(
      settings ? { t: 'cell:lock', cellId, state, settings } : { t: 'cell:lock', cellId, state },
    )
  }

  show(cellId: string, participantId: string): void {
    this.#send({ t: 'council:show', cellId, participantId })
  }

  reply(cellId: string, to: { participantId: string } | { groupKey: string }, text: string): void {
    this.#send({ t: 'council:reply', cellId, to, text })
  }

  mark(cellId: string, participantId: string, correct: boolean | null): void {
    this.#send({ t: 'council:mark', cellId, participantId, correct })
  }

  destroy(): void {
    this.#outbox.clear()
  }
}

/* ------------------------------------------------------------ замок ячейки */

/** Положение замка и ручки консилиума — то, чего `watchCellMeta` не различает. */
export interface CellLockView {
  lock: CellLock
  /** `null` вне консилиума — ручек у закрытой двери нет. */
  settings: CouncilSettings | null
}

const CLOSED_LOCK: CellLockView = { lock: 'closed', settings: null }

function readLock(cell: YCell): CellLockView {
  return { lock: cellLock(cell), settings: councilSettingsOf(cell) }
}

function sameLock(a: CellLockView, b: CellLockView): boolean {
  return (
    a.lock === b.lock &&
    a.settings?.studentRun === b.settings?.studentRun &&
    a.settings?.namesOnProjector === b.settings?.namesOnProjector &&
    (a.settings === null) === (b.settings === null)
  )
}

/**
 * Замок ячейки в три положения — как руна.
 *
 * `watchCellMeta` отдаёт `open: boolean` (= isCellOpen) и просыпается на ключ
 * `open`, но консилиум для него — закрытая ячейка, и переход closed → council
 * он молча съедает как «то же самое». Здесь свой узкий наблюдатель на той же
 * Y.Map: два ключа, `open` и `council`, пишет их только сервер, и меняются они
 * считаные разы за пару. Звать при инициализации компонента — внутри `$effect`.
 */
export function watchCellLock(cell: () => YCell | null): { readonly current: CellLockView } {
  let current = $state.raw<CellLockView>(CLOSED_LOCK)

  $effect(() => {
    const target = cell()
    // Присваивание без чтения: эффект зависит от ячейки, а не от того, что сам пишет.
    current = target ? readLock(target) : CLOSED_LOCK
    if (!target) return
    const observer = (event: Y.YMapEvent<unknown>) => {
      if (!event.keysChanged.has('open') && !event.keysChanged.has('council')) return
      const next = readLock(target)
      if (
        !sameLock(
          next,
          untrack(() => current),
        )
      )
        current = next
    }
    target.observe(observer)
    return () => target.unobserve(observer)
  })

  return {
    get current() {
      return current
    },
  }
}
