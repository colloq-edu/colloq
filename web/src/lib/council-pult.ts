/**
 * Мессенджер пульта консилиума — вся его арифметика, без Svelte и без сокета.
 *
 * Пульт живёт в отдельном окне (components/council/pult) и показывает список
 * людей слева, открытую работу справа. Здесь лежит то, что решает, ЧТО стоит в
 * списке и в каком порядке: сборка строк, фильтры, непрочитанное, придержанные
 * сдачи, ходы курсора и перечень ячеек, между которыми окно переключается.
 *
 * ГРУППИРОВКИ ЗДЕСЬ БОЛЬШЕ НЕТ. Одинаковые ответы сворачивались в одну строку с
 * хвостом «ещё N с тем же ответом», у работы стояло «группа 2 из 6», а письмо
 * уходило «всем N». 20.09 владелец попросил убрать это целиком, и убрано оно
 * целиком: список пульта — лента сдач, и человека в ней ищут по имени, а не по
 * тому, на кого он похож. Какие бывают ответы — вопрос стопки и оракула.
 *
 * Отдельным модулем по тем же доводам, что и council-board.ts: стопку и полосу
 * групп там считает не компонент, и эти правила тоже проверяются без браузера
 * (tests/council-pult.test.mts). Сложенное в разметке складывается по-разному
 * на каждой ветке `{#if}`, а список, в котором курсор ходит не туда, куда
 * смотрят глаза, — это нажатие Enter не на том человеке перед всем залом.
 *
 * ПОРЯДОК ЗДЕСЬ ДРУГОЙ, ЧЕМ В СТОПКЕ. `stackOrder` (council-board.ts) ставит
 * первыми представителей больших групп: карточка листается «по решениям».
 * Мессенджер — это лента сдач, и порядок в нём один — по времени сдачи, сверху
 * свежие: человек, нажавший «Сдать» минуту назад, обязан быть виден без
 * прокрутки. Два разных порядка — не небрежность: два разных вопроса («какие
 * бывают ответы» против «кто только что сдал»).
 */
import { formatNumber, tr } from '@shared/i18n'
import {
  COUNCIL_RERUN_PAUSES,
  COUNCIL_RUN_LIMITS,
  type CellLock,
  type CouncilSettings,
} from '@shared/notebook'
import type {
  CouncilAttempt,
  CouncilBoard,
  CouncilKernel,
  CouncilStatus,
} from '@shared/protocol'

export type PultPresence = 'online' | 'offline' | 'unknown'

/** Saved work is independent of the live room roster. Lost connection makes it unknown. */
export function pultPresence(connected: boolean, people: ReadonlyMap<string, unknown>, id: string): PultPresence {
  if (!connected) return 'unknown'
  return people.has(id) ? 'online' : 'offline'
}

export type PultTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'accent'
export interface PultBadge {
  label: string
  tone: PultTone
  /** Знак перед словом, когда тон о состоянии не договаривает. См. attemptExecution. */
  icon?: string
  /**
   * Форма плашки — второй признак поверх цвета.
   *
   * Заливка означает «от вас ждут действия»: сдано и не оценено. Контур —
   * «состояние, которое само пройдёт»: человек ещё пишет. Тон между ними тоже
   * разный, но одним цветом такие вещи не различают: на проекторе, на чужом
   * мониторе и у того, кто цвета не различает, остаётся форма и слово.
   */
  shape?: 'fill' | 'outline'
}
export type PultView = 'work' | 'queue' | 'oracle'

/**
 * Evaluation and execution are separate facts: running code successfully is not a grade.
 *
 * Сданная и НЕ оценённая — залитая плашка акцентом: 19.09 преподаватель вёл
 * пару и не видел в списке, кого он уже посмотрел, а кого нет («лучше помечать
 * сданные работы в пульте, а то нихуя не видно»). Бледная «Не проверено» в
 * общем сером ряду не отличалась ни от черновика, ни от оценённого.
 */
export function attemptReview(attempt: Pick<CouncilAttempt, 'submittedAt' | 'correct'>): PultBadge {
  if (attempt.submittedAt === null) return { label: tr('room.pult.v2.review.draft'), tone: 'neutral', shape: 'outline' }
  if (attempt.correct === true) return { label: tr('room.pult.v2.review.correct'), tone: 'positive' }
  if (attempt.correct === false) return { label: tr('room.pult.v2.review.wrong'), tone: 'warning' }
  return { label: tr('room.pult.v3.review.waiting'), tone: 'accent', shape: 'fill' }
}

export function attemptExecution(attempt: {
  run: Pick<NonNullable<CouncilAttempt['run']>, 'state' | 'timedOut'> | null
  runRequest?: Pick<NonNullable<CouncilAttempt['runRequest']>, 'status'> | null
}): PultBadge {
  /*
   * Остановленный пределом запуск — не «ошибка запуска».
   *
   * `state` у него тот же `error`, и общим словом он встал бы в один ряд с
   * TypeError, то есть человек шёл бы читать вывод и искать в нём опечатку. А
   * править тут нечего: код, возможно, верный, ему не хватило секунд, и
   * решение принимает преподаватель — поднять предел или прервать соседа.
   * Поэтому у остановленного своё слово и свой знак часов.
   */
  const limit = timedOutLimit(attempt)
  if (limit !== null) {
    return { label: tr('room.pult.v2.execution.timedOut', { duration: pultDuration(limit) }), tone: 'danger', icon: '◷' }
  }
  switch (attempt.run?.state) {
    case 'running': return { label: tr('room.pult.v2.execution.running'), tone: 'accent' }
    case 'queued': return { label: tr('room.pult.v2.execution.queued'), tone: 'accent' }
    case 'error': return { label: tr('room.pult.v2.execution.error'), tone: 'danger' }
  }
  if (attempt.runRequest?.status === 'pending') return { label: tr('room.pult.v2.execution.request'), tone: 'warning' }
  if (attempt.run?.state === 'ok') return { label: tr('room.pult.v2.execution.ok'), tone: 'positive' }
  return { label: tr('room.pult.v2.execution.none'), tone: 'neutral' }
}

/* ------------------------------------------------------- время запуска */

/**
 * Час и минута — и секунды там, где по ним сопоставляют.
 *
 * Своя, а не `clock()` из lib/history: тот модуль ради двух строк тянет за
 * собой `./api` с сетью и токенами, а этот файл читается ещё и из тестов без
 * браузера. Правило форматирования то же самое, до знака.
 *
 * Секунды нужны в открытой работе и в очереди: «запущен в 17:24:05» — это то,
 * чем преподаватель сличает свой запуск с чужим, когда за минуту их три, и
 * «17:24» у всех трёх не отвечает ни на один вопрос.
 */
export function pultClock(at: number, seconds = false): string {
  const date = new Date(at)
  const two = (value: number): string => String(value).padStart(2, '0')
  const hhmm = `${two(date.getHours())}:${two(date.getMinutes())}`
  return seconds ? `${hhmm}:${two(date.getSeconds())}` : hhmm
}

/**
 * Сколько считал законченный запуск.
 *
 * До десяти секунд — с десятой долей: почти все запуски консилиума короткие, и
 * `spell()` округляет их в «0 с» и «1 с», то есть в одно и то же число для
 * всего класса. Дальше десятой доли никто не сравнивает, и там идёт общий
 * `pultDuration` — тот же, каким названы пределы регламента.
 */
export function pultRanFor(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 10_000) {
    return tr('room.pult.v2.rules.sec', {
      count: formatNumber(safe / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    })
  }
  return pultDuration(safe / 1000)
}

/**
 * Строка запуска целиком: что случилось, сколько считалось и КОГДА.
 *
 * Час запуска — прямая просьба с пары 19.09: «в пульте консилиума показывать
 * время запуска». Без него «Запуск выполнен» не отличает попытку, запущенную
 * пять минут назад, от запущенной только что, а решают по ним разное: первую
 * пора показывать классу, вторая ещё не досчитала соседей.
 *
 * Слово и тон берутся у `attemptExecution` — одно место, где состояние
 * становится словом, — и к ним прибавляются длительность и время. Не
 * запускали вовсе и просит запуск — там времени нет, и строка остаётся
 * прежней: выдуманного часа быть не должно.
 */
export function attemptRunLine(
  attempt: {
    run: Pick<NonNullable<CouncilAttempt['run']>, 'state' | 'timedOut' | 'startedAt' | 'ranMs'> | null
    runRequest?: Pick<NonNullable<CouncilAttempt['runRequest']>, 'status'> | null
  },
  now: number,
): PultBadge {
  const base = attemptExecution(attempt)
  const run = attempt.run
  if (!run) return base
  const time = pultClock(run.startedAt)
  const limit = timedOutLimit(attempt)
  if (limit !== null) {
    return { ...base, label: tr('room.pult.v3.runStopped', { limit: pultDuration(limit), time }) }
  }
  switch (run.state) {
    case 'running':
      // Живой счётчик — целыми секундами: десятая доля у числа, которое
      // меняется каждую секунду, читается как мерцание, а не как измерение.
      return { ...base, label: tr('room.pult.v3.runRunning', { duration: pultDuration(Math.max(now - run.startedAt, 0) / 1000) }) }
    case 'queued':
      return { ...base, label: tr('room.pult.v3.runQueued', { time }) }
    case 'error':
      return {
        ...base,
        label: run.ranMs === null
          ? tr('room.pult.v3.runFailedAt', { time })
          : tr('room.pult.v3.runFailed', { duration: pultRanFor(run.ranMs), time }),
      }
    case 'ok':
      return {
        ...base,
        label: run.ranMs === null
          ? tr('room.pult.v3.runDoneAt', { time })
          : tr('room.pult.v3.runDone', { duration: pultRanFor(run.ranMs), time }),
      }
  }
  return base
}

export function pultShortcutAllowed(action: PultAction, view: PultView, navigation: boolean, overlay = false): boolean {
  if (overlay || action === null) return false
  // Регламент — правило ЯЧЕЙКИ, а не открытой работы: из очереди и от оракула
  // к нему тянутся так же часто, как из списка, и «сначала вернись в работы»
  // было бы ответом ни на что.
  if (action === 'help' || action === 'escape' || action === 'search' || action === 'rules') return true
  return view === 'work' && !navigation
}

/**
 * С какого числа одинаковых ответов счёт группы вообще о чём-то говорит.
 *
 * Список пульта им больше не пользуется: группировку из пульта убрали целиком
 * (20.09). Порог остаётся ОДНИМ местом, где это число названо, — его читает
 * стопка и оракул, которому «двое написали одно и то же» не повод собирать
 * группу. Переписать его в двух местах по-разному дешевле всего именно тогда,
 * когда одно из них выглядит как ничей остаток.
 */
export const GROUP_MIN = 3

/** Чипы отбора над списком — ровно пять, в этом порядке. */
export type PultFilter = 'all' | 'new' | 'error' | 'unrun' | 'writing'

export const FILTERS: readonly PultFilter[] = ['all', 'new', 'error', 'unrun', 'writing']

/** Слово в чипе. Одно место, где фильтр становится словом. */
export function filterLabel(filter: PultFilter): string {
  switch (filter) {
    case 'new':
      return tr('room.ui.1305')
    case 'error':
      return tr('room.ui.1306')
    case 'unrun':
      return tr('room.ui.1307')
    case 'writing':
      return tr('room.ui.1309')
    default:
      return tr('room.ui.1304')
  }
}

/**
 * Строка списка. Два вида, и только первый выбирается курсором: заголовок
 * секции — это не человек, а место в ленте, и Enter на нём означал бы
 * «показать классу» неизвестно чью работу.
 *
 * Видов было четыре: сюда же входили шапка группы и свёрнутый хвост «ещё N с
 * тем же ответом». Группировки в пульте больше нет — вся она ушла 20.09 по
 * одному слову владельца, и ушла целиком, а не спряталась за настройку: список
 * пульта — ЛЕНТА СДАЧ, и человек, сдавший минуту назад, обязан стоять в ней
 * сам по себе, а не под чужим хвостом.
 */
export type PultRow =
  | {
      kind: 'attempt'
      /** Ключ для `{#each}` и для курсора — он же participantId. */
      id: string
      attempt: CouncilAttempt
      unread: boolean
      /** Номер варианта при выключенных именах; с единицы. */
      variant: number
    }
  /**
   * Заголовок половины ленты: «Сдали · N» и «Пишут · N».
   *
   * Порядок в ленте и так ставит сданные первыми (bySubmissionDesc), но граница
   * между «уже сдал» и «ещё пишет» ничем не была отмечена, и в окне, где видно
   * две строки с половиной, её не существовало вовсе: список выглядел как один
   * ряд людей без отличий. Курсору строка не даётся.
   */
  | { kind: 'section'; id: string; section: 'submitted' | 'writing'; count: number }

export interface PultListInput {
  attempts: readonly CouncilAttempt[]
  filter: PultFilter
  /** Поиск по имени; при выключенных именах зовущий передаёт пустую строку. */
  search: string
  /** Кто сдал после того, как в список смотрели в последний раз. */
  unread: ReadonlySet<string>
  /** Придержанные сдачи: они есть в стопке, но в список ещё не впущены. */
  held: ReadonlySet<string>
}

/** Сдана — значит есть время сдачи; всё остальное — сохранённый черновик, независимо от присутствия. */
const isSubmitted = (attempt: CouncilAttempt): boolean => attempt.submittedAt !== null

/**
 * Номера вариантов — по времени сдачи, с единицы, на всю ячейку.
 *
 * Тем же правилом, что у сервера на показе (protocol.ts · CouncilShown.variant):
 * при выключенных именах номер — единственная подпись человека, и в пульте он
 * обязан совпасть с тем, что видит зал. Пишущие получают номера в хвосте, по
 * id: номера у них ещё нет, а дырка в нумерации читалась бы как потерянный
 * человек.
 */
export function variantNumbers(attempts: readonly CouncilAttempt[]): Map<string, number> {
  const order = [...attempts].sort((a, b) => {
    const left = a.submittedAt
    const right = b.submittedAt
    if (left !== null && right !== null) return left - right || a.participantId.localeCompare(b.participantId)
    if (left !== null) return -1
    if (right !== null) return 1
    return a.participantId.localeCompare(b.participantId)
  })
  return new Map(order.map((attempt, index) => [attempt.participantId, index + 1]))
}

/** Сверху свежие: лента сдач, а не стопка решений. Пишущие — в конце, по id. */
export function bySubmissionDesc(a: CouncilAttempt, b: CouncilAttempt): number {
  const left = a.submittedAt
  const right = b.submittedAt
  if (left !== null && right !== null) return right - left || a.participantId.localeCompare(b.participantId)
  if (left !== null) return -1
  if (right !== null) return 1
  return a.participantId.localeCompare(b.participantId)
}

/** Подходит ли попытка под чип отбора. Поиск — отдельно: он по имени. */
export function matchesFilter(
  attempt: CouncilAttempt,
  filter: PultFilter,
  unread: ReadonlySet<string>,
): boolean {
  switch (filter) {
    case 'new':
      return unread.has(attempt.participantId)
    case 'error':
      // Остановленный пределом считается «с ошибкой» наравне с упавшим: чип
      // отбирает работы, которым запуск не удался, а не имена исключений.
      return attempt.run?.state === 'error' || timedOutLimit(attempt) !== null || attempt.correct === false
    case 'unrun':
      return attempt.run === null
    case 'writing':
      return !isSubmitted(attempt)
    default:
      return true
  }
}

/**
 * Строки списка — то, что рисует левая колонка.
 *
 * Одна строка на человека, сверху свежие. Ни свёртывания, ни шапок групп:
 * список пульта — лента сдач, и единственный вопрос, на который она отвечает,
 * — «кто только что сдал». Группировка одинаковых ответов жила здесь до 20.09
 * и убрана по прямой просьбе владельца: она прятала людей под чужим хвостом
 * («ещё N с тем же ответом»), а найти в списке конкретного человека — ровно то,
 * ради чего в него смотрят. Какие бывают ответы — вопрос стопки и оракула, и
 * задают его в другом месте.
 */
export function listRows(input: PultListInput): PultRow[] {
  const { attempts, filter, search, unread, held } = input
  const variants = variantNumbers(attempts)
  const needle = search.trim().toLocaleLowerCase()

  const visible = attempts.filter(
    (attempt) =>
      !held.has(attempt.participantId) &&
      matchesFilter(attempt, filter, unread) &&
      (needle === '' || attempt.name.toLocaleLowerCase().includes(needle)),
  )
  const ordered = [...visible].sort(bySubmissionDesc)

  const rows: PultRow[] = ordered.map((attempt) => ({
    kind: 'attempt',
    id: attempt.participantId,
    attempt,
    unread: unread.has(attempt.participantId),
    variant: variants.get(attempt.participantId) ?? 0,
  }))
  return withSections(rows, ordered, filter === 'all' && needle === '')
}

/**
 * Две секции — только в полном списке и только без поиска.
 *
 * Под отбором «с ошибкой» заголовок «Сдали · 5» говорил бы о числе, которого в
 * списке нет: отбор уже разрезал ленту по другому признаку, и второй разрез
 * поверх первого читается как ошибка счёта. Поиск — то же самое: в нём стоят
 * найденные, а не «все сдавшие».
 *
 * Счёт — по людям, а не по строкам: разойтись им теперь негде, но считать по
 * `ordered` дешевле и честнее, чем по собранным строкам, среди которых стоят
 * сами заголовки.
 */
function withSections(rows: PultRow[], ordered: readonly CouncilAttempt[], on: boolean): PultRow[] {
  if (!on) return rows
  const submitted = ordered.filter(isSubmitted).length
  const writing = ordered.length - submitted
  const out: PultRow[] = []
  let openedSubmitted = false
  let openedWriting = false
  for (const row of rows) {
    const draft = row.kind === 'attempt' && row.attempt.submittedAt === null
    if (!draft && !openedSubmitted && submitted > 0) {
      out.push({ kind: 'section', id: 'section:submitted', section: 'submitted', count: submitted })
      openedSubmitted = true
    }
    if (draft && !openedWriting && writing > 0) {
      out.push({ kind: 'section', id: 'section:writing', section: 'writing', count: writing })
      openedWriting = true
    }
    out.push(row)
  }
  return out
}

/** Только по людям: заголовок секции курсору не даётся. */
export function selectable(rows: readonly PultRow[]): string[] {
  return rows.filter((row) => row.kind === 'attempt').map((row) => row.id)
}

/* --------------------------------------------------- ячейки консилиума */

/**
 * Ячейка в списке выбора — всё, что о ней говорит строка меню.
 *
 * Пульт — ОДНО окно на комнату, и ячейку в нём выбирают, а не открывают
 * вторым окном: «будет круто иметь один общий пульт, в котором можно
 * перемещаться между ячейками». Номер ячейки в шапке стал дверью в этот
 * список, и список обязан отвечать на единственный вопрос, ради которого его
 * открывают: куда переключиться прямо сейчас.
 */
export interface PultCellRow {
  cellId: string
  /** Номер ячейки в своей тетради, с единицы; `null` — ячейки в документе нет. */
  index: number | null
  /** Имя тетради. Пустое, пока все ячейки из одной: подпись там ничего не решает. */
  book: string
  submitted: number
  total: number
  /** В ядре прямо сейчас считается чья-то попытка этой ячейки. */
  running: boolean
  /** Чья-то работа по этой ячейке стоит на проекторе. */
  onScreen: boolean
  /**
   * Консилиум закрыт, а попытки остались.
   *
   * Такие ячейки из списка НЕ УХОДЯТ: сданное смотрят до конца занятия, и
   * ячейка, снятая с консилиума под открытым на ней пультом, обязана остаться
   * на месте — выкинуть человека из того, на что он смотрит, хуже, чем
   * признаться словом, что менять здесь больше нечего.
   */
  review: boolean
}

export interface PultCellFacts {
  cellId: string
  index: number | null
  book: string
  lock: CellLock
  /** Числа стопки — запасной счёт, когда комнатный ещё не приехал. */
  counts: CouncilBoard['counts']
  /** «Сдали N из M» по всей комнате — те же числа, что под ячейкой в тетради. */
  room: { submitted: number; total: number } | null
  attempts: readonly CouncilAttempt[]
  onScreen: boolean
}

/**
 * Список ячеек для меню: порядок, числа и пометки.
 *
 * Порядок — по тетради и номеру, а не по приходу кадров: меню открывают,
 * чтобы найти известную ячейку, и «та, чья стопка приехала первой» — не тот
 * порядок, в котором её ищут. Номера уникальны ВНУТРИ тетради, поэтому имя
 * тетради появляется ровно тогда, когда ячейки из разных: иначе «ячейка 03»
 * стояла бы в списке дважды и ничем не различалась.
 */
export function pultCells(facts: readonly PultCellFacts[]): PultCellRow[] {
  const books = new Set(facts.map((fact) => fact.book))
  const many = books.size > 1
  return [...facts]
    .sort(
      (a, b) =>
        a.book.localeCompare(b.book) ||
        // Ячейка, которой в документе нет, уходит в хвост: у неё нет места в
        // тетради, и вставлять её по нулю значило бы ставить первой.
        (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) ||
        a.cellId.localeCompare(b.cellId),
    )
    .map((fact) => ({
      cellId: fact.cellId,
      index: fact.index,
      book: many ? fact.book : '',
      submitted: fact.room?.submitted ?? fact.counts.submitted,
      total: fact.room?.total ?? fact.counts.attempts,
      running: fact.attempts.some((attempt) => attempt.run?.state === 'running'),
      onScreen: fact.onScreen,
      review: fact.lock !== 'council',
    }))
}

/**
 * Куда уходит курсор с клавиши j / k.
 *
 * Курсора нет — вниз ведёт к первой строке, вверх к последней: первое нажатие
 * обязано что-то выбрать, иначе клавиша читается как сломанная. Курсор на
 * строке, которой в отборе больше нет (сменили фильтр), — тоже к первой.
 */
export function moveCursor(rows: readonly PultRow[], cursor: string | null, delta: 1 | -1): string | null {
  const ids = selectable(rows)
  if (ids.length === 0) return null
  const at = cursor === null ? -1 : ids.indexOf(cursor)
  if (at < 0) return delta === 1 ? ids[0] : ids[ids.length - 1]
  const next = at + delta
  if (next < 0 || next >= ids.length) return ids[at]
  return ids[next]
}

/* ------------------------------------------------------- непрочитанное */

/**
 * Кто сдал после того, как в список смотрели, — голубая точка слева.
 *
 * `seen` — те, чью строку уже открывали: точка гаснет на открытии и не
 * возвращается. `since` — момент, когда пульт открыли: всё, что сдано раньше,
 * непрочитанным не считается, иначе первое открытие красило бы точками весь
 * класс.
 */
export function unreadIds(
  attempts: readonly CouncilAttempt[],
  since: number,
  seen: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>()
  for (const attempt of attempts) {
    if (attempt.submittedAt === null) continue
    if (attempt.submittedAt <= since) continue
    if (seen.has(attempt.participantId)) continue
    out.add(attempt.participantId)
  }
  return out
}

/* ------------------------------------------------- придержанные сдачи */

/**
 * Держать ли новые сдачи за полосой «↑ ещё N сдали — показать».
 *
 * Список прокручен или курсор не на первой строке — значит человек читает
 * что-то конкретное, и строка, вставшая сверху, увела бы под курсором всё
 * вниз. Стоим на первой строке у самого верха — впускаем сразу: там новая
 * сдача и есть то, ради чего смотрят.
 */
export function holdsArrivals(scrolled: boolean, cursorAtTop: boolean): boolean {
  return scrolled || !cursorAtTop
}

/**
 * Что придержать: сданное после `frozenAt`, кроме того, что уже стоит в списке
 * и кроме строки под курсором. Курсор не двигается никогда — даже если человек
 * под ним сдал заново.
 */
export function heldArrivals(
  attempts: readonly CouncilAttempt[],
  frozenAt: number,
  standing: ReadonlySet<string>,
  cursor: string | null,
): Set<string> {
  const out = new Set<string>()
  for (const attempt of attempts) {
    if (attempt.submittedAt === null || attempt.submittedAt <= frozenAt) continue
    if (standing.has(attempt.participantId)) continue
    if (attempt.participantId === cursor) continue
    out.add(attempt.participantId)
  }
  return out
}

/* ------------------------------------------------------------ клавиши */

/** Где стоит фокус — от этого зависит, чья клавиша. */
export type PultFocus = 'list' | 'search' | 'reply' | 'actions'

export type PultAction =
  | 'next'
  | 'prev'
  | 'search'
  | 'show'
  | 'run'
  | 'correct'
  | 'wrong'
  | 'clearShown'
  | 'send'
  | 'escape'
  | 'help'
  | 'rules'
  | null

export interface PultKey {
  key: string
  shift?: boolean
  meta?: boolean
  ctrl?: boolean
  alt?: boolean
  composing?: boolean
}

/**
 * Что делает клавиша в пульте.
 *
 * Три правила, и все три про поля ввода. В поле ответа клавиши его: ⌘↵
 * отправляет, Esc закрывает, всё остальное — набор. В поиске стрелки ПРОДОЛЖАЮТ
 * ходить по отфильтрованному списку (иначе после ⌘F руки обязаны вернуться к
 * мыши), а буквы — набор. Везде остальное — буквы пульта.
 *
 * Enter показывает классу и только оттуда, где видно, кого показывают; на
 * кнопке (`actions`) он нажимает кнопку, а не делает второе дело первым.
 */
export function pultKeyAction(event: PultKey, focus: PultFocus): PultAction {
  if (event.alt || event.composing) return null
  const mod = Boolean(event.meta || event.ctrl)
  if (mod && (event.key === 'f' || event.key === 'F' || event.key === 'а' || event.key === 'А')) return 'search'
  if (focus === 'reply') {
    if (mod && event.key === 'Enter') return 'send'
    if (event.key === 'Escape') return 'escape'
    return null
  }
  if (mod) return null
  if (focus === 'actions' && (event.key === ' ' || event.key === 'Enter')) return null
  if (event.key === 'ArrowDown') return 'next'
  if (event.key === 'ArrowUp') return 'prev'
  if (event.key === 'Escape') return 'escape'
  if (focus === 'search') return event.key === 'Enter' ? 'show' : null
  if (mod) return null
  switch (event.key) {
    case 'j':
    case 'о':
      return 'next'
    case 'k':
    case 'л':
      return 'prev'
    case 'Enter':
      return focus === 'actions' ? null : 'show'
    case 'r':
    case 'R':
    case 'к':
    case 'К':
      return 'run'
    case '1':
      return 'correct'
    case '2':
      return 'wrong'
    case '3':
      return 'clearShown'
    // «п» — правила; латинская g стоит на той же клавише, как о и j у курсора.
    case 'g':
    case 'G':
    case 'п':
    case 'П':
      return 'rules'
    case '?':
      return 'help'
    default:
      return null
  }
}

/* --------------------------------------------------------------- слова */

/** Цвет левой полосы строки: что от вас требуется, а не что случилось. */
export type RowMeaning = 'none' | 'cursor' | 'screen' | 'asking'

export function rowMeaning(
  attempt: CouncilAttempt,
  cursor: string | null,
  shown: string | null,
): RowMeaning {
  if (attempt.runRequest?.status === 'pending') return 'asking'
  if (shown === attempt.participantId) return 'screen'
  if (cursor === attempt.participantId) return 'cursor'
  return 'none'
}

/**
 * Повод рядом с просьбой о запуске — два слова, из-за которых разрешают.
 *
 * Выводится ТОЛЬКО из того, что правда известно: прошлый запуск этой же
 * попытки упал — значит «TypeError в прошлый раз». Истории просьб сервер не
 * везёт (`CouncilRunRequest` — одна текущая), поэтому «третья попытка за
 * минуту» здесь не сочиняется: выдуманный повод хуже пустого места, потому что
 * по нему принимают решение.
 */
export function requestReason(attempt: CouncilAttempt): string | null {
  const run = attempt.run
  if (!run || run.state !== 'error') return null
  const error = run.outputs.find((output) => output.kind === 'error')
  const name = error && error.kind === 'error' ? error.ename : ''
  return name ? tr('room.ui.1302', { p0: name }) : null
}

/** Кто сейчас в ядре по этой ячейке и кто ждёт — из той же стопки. */
export interface KernelView {
  /** Попытка ЭТОЙ ячейки, которую ядро считает сейчас. */
  running: CouncilAttempt | null
  queued: CouncilAttempt[]
  pending: CouncilAttempt[]
  /**
   * Ядро ТЕТРАДИ: чем занято и сколько всего ждёт.
   *
   * Из отдельного кадра (`council:kernel`), а не из стопки, и это не удвоение
   * `running`. Очередь у тетради одна, и держать её может обычная ячейка или
   * попытка СОСЕДНЕЙ ячейки консилиума — ни того ни другого в стопке этой
   * ячейки нет. Пока этого поля не было, пульт писал «в этой ячейке сейчас
   * ничего не выполняется» и «в очереди: 12» одновременно, а кнопку «Прервать»
   * прятал: она жила внутри ветки `running`.
   *
   * `null` — кадра ещё не приходило (старый сервер, пульт только открылся).
   * Тогда всё читается как раньше, по одной стопке.
   */
  book: CouncilKernel | null
}

export function kernelView(
  attempts: readonly CouncilAttempt[],
  book: CouncilKernel | null = null,
): KernelView {
  const running = attempts.find((attempt) => attempt.run?.state === 'running') ?? null
  const queued = attempts
    .filter((attempt) => attempt.run?.state === 'queued')
    .sort((a, b) => (a.run?.startedAt ?? 0) - (b.run?.startedAt ?? 0))
  const pending = attempts
    .filter((attempt) => attempt.runRequest?.status === 'pending')
    .sort(
      (a, b) =>
        (a.runRequest?.requestedAt ?? 0) - (b.runRequest?.requestedAt ?? 0) ||
        a.participantId.localeCompare(b.participantId),
    )
  return { running, queued, pending, book }
}

/**
 * Сколько работ ждёт своей очереди — по всей тетради, а не по этой ячейке.
 *
 * Число из кадра ядра считает всё: обычные ячейки, попытки этой ячейки и
 * попытки соседних. Пока его не было, пульт называл «в очереди» длину своего
 * списка — и преподаватель, читавший там «3», ждал минуту вместо десяти.
 * Кадра ещё нет (старый сервер) — остаётся прежнее число: врать про тетрадь
 * хуже, чем честно сказать про ячейку.
 */
export function queuedInBook(kernel: KernelView): number {
  return kernel.book?.queued ?? kernel.queued.length
}

/**
 * Есть ли что прерывать: ядро тетради занято — своей попыткой или чужой работой.
 *
 * Кнопка «Прервать» рисуется по этому ответу, а не по `running`. Раньше она
 * жила внутри карточки своей попытки, то есть исчезала ровно тогда, когда
 * очередь держала чужая работа, — в единственную минуту, когда она и нужна.
 */
export function kernelIsBusy(kernel: KernelView): boolean {
  return kernel.running !== null || kernel.book?.busy != null
}

/* ---------------------------------------------------------- регламент */

/**
 * Четыре правила ячейки — и один порядок на все места, где о них говорят.
 *
 * Порядок не по важности и не по алфавиту, а по ходу занятия: сперва кто
 * вообще запускает, потом сколько длится один запуск, потом когда разрешён
 * повтор, и в конце — что из этого увидит зал. Предложение в шапке, строки
 * листа и подсветка «того правила, ради которого лист открыли» читают его
 * отсюда: разойдясь, они начали бы показывать разное на одно нажатие.
 */
export type PultRule = 'studentRun' | 'runLimit' | 'rerunPause' | 'names'
export const PULT_RULES: readonly PultRule[] = ['studentRun', 'runLimit', 'rerunPause', 'names']

/**
 * Длительность регламента словами: «30 с», «1 мин», «1 мин 30 с».
 *
 * Не `spell()` из utils: та говорит о СЛУЧИВШЕМСЯ («считался 4 с») и округляет
 * до секунды, а здесь число — выбранная настройка, и 90 выбирали как «1 мин
 * 30 с», а не как «2 мин». Одна функция на предложение, лист, полосу запуска и
 * строку «Остановлен: дольше 30 с» — иначе предел в одном месте читался бы
 * иначе, чем в другом, и спор был бы о том, какое из двух чисел настоящее.
 *
 * Множественного числа в ключах нет намеренно: сокращения «с» и «мин» (s/min)
 * не склоняются ни в одном из двух языков.
 */
export function pultDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 60) return tr('room.pult.v2.rules.sec', { count: whole })
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return rest === 0
    ? tr('room.pult.v2.rules.min', { count: minutes })
    : tr('room.pult.v2.rules.minSec', { count: minutes, sec: rest })
}

/** Кусок предложения регламента: связка, значение-кнопка и то же значение в узком окне. */
export interface RulePart {
  rule: PultRule
  /** Связка перед значением; в узком окне прячется. */
  lead: string
  /** Значение — по нему и нажимают: оно открывает лист на своём правиле. */
  value: string
  /**
   * Чем значение становится, когда связки спрятаны.
   *
   * Совпадает со `value` везде, кроме паузы: «через 30 с» без связки читается
   * как второй предел запуска, поэтому в узком окне «повтор» переезжает ВНУТРЬ
   * значения — «повтор через 30 с».
   */
  short: string
  /** Единственное жёлтое значение в предложении — запуск без предела. */
  warn: boolean
}

/**
 * Регламент одной строкой — предложением, а не списком ручек.
 *
 * Запускать студенты не могут вовсе — кусок про повтор ИСЧЕЗАЕТ, а не гаснет:
 * пауза между запусками у того, кто не запускает, не означает ничего, и серая
 * «повтор сразу» в предложении — это лишнее слово, которое читают каждый раз.
 * Без предела — единственное жёлтое: очередь на нём встаёт насмерть, и знать
 * об этом надо не открывая лист.
 */
export function rulesSentence(settings: CouncilSettings): RulePart[] {
  const parts: RulePart[] = []
  const run = settings.studentRun
  const runValue = tr(
    run === false
      ? 'room.pult.v2.rules.runTeacher'
      : run === true
        ? 'room.pult.v2.rules.runEveryone'
        : 'room.pult.v2.rules.runRequest',
  )
  parts.push({
    rule: 'studentRun',
    lead: tr(run === false ? 'room.pult.v2.rules.runLeadTeacher' : 'room.pult.v2.rules.runLead'),
    value: runValue,
    short: runValue,
    warn: false,
  })

  const limit = settings.runLimitSec
  const limitValue =
    limit === null
      ? tr('room.pult.v2.rules.limitNone')
      : tr('room.pult.v2.rules.limitValue', { duration: pultDuration(limit) })
  parts.push({
    rule: 'runLimit',
    lead: tr('room.pult.v2.rules.limitLead'),
    value: limitValue,
    short: limitValue,
    warn: limit === null,
  })

  if (run !== false) {
    const pause = settings.rerunPauseSec
    const duration = pultDuration(pause)
    parts.push({
      rule: 'rerunPause',
      lead: tr('room.pult.v2.rules.pauseLead'),
      value: pause > 0 ? tr('room.pult.v2.rules.pauseValue', { duration }) : tr('room.pult.v2.rules.pauseNow'),
      short: pause > 0 ? tr('room.pult.v2.rules.pauseShort', { duration }) : tr('room.pult.v2.rules.pauseShortNow'),
      warn: false,
    })
  }

  const names = tr(
    settings.namesOnProjector ? 'room.pult.v2.rules.screenNames' : 'room.pult.v2.rules.screenAnon',
  )
  parts.push({ rule: 'names', lead: tr('room.pult.v2.rules.screenLead'), value: names, short: names, warn: false })
  return parts
}

/**
 * Что показать в ряду кнопок: заготовки, а при чужом значении — и его.
 *
 * Сервер принимает любое целое в границах (notebook.ts · COUNCIL_RUN_LIMIT_MAX),
 * и значение могло приехать из другой сборки, из истории или из будущего
 * списка заготовок. Ряд, в котором не нажата ни одна кнопка, читается как
 * «настройка сломана»; поэтому чужое число встаёт своей кнопкой — на своё
 * место по величине, а «без предела» остаётся последним.
 */
export function limitOptions(current: number | null): (number | null)[] {
  if (COUNCIL_RUN_LIMITS.includes(current)) return [...COUNCIL_RUN_LIMITS]
  const numbers = COUNCIL_RUN_LIMITS.filter((one): one is number => one !== null)
  // «Без предела» остаётся последним: это не самое большое число, а его отсутствие.
  return [...[...numbers, current as number].sort((a, b) => a - b), null]
}

export function pauseOptions(current: number): number[] {
  if (COUNCIL_RERUN_PAUSES.includes(current)) return [...COUNCIL_RERUN_PAUSES]
  return [...COUNCIL_RERUN_PAUSES, current].sort((a, b) => a - b)
}

/** Сколько на самом деле считают запуски этой ячейки: медиана, самый долгий и по скольким. */
export interface RunStats { median: number; max: number; count: number }

/**
 * Числа под выбором предела — чтобы его ставили по классу, а не по страху.
 *
 * Считается по ЗАКОНЧЕННЫМ запускам: у идущего длительности ещё нет, а у
 * остановленного пределом она не настоящая — там измерен сам предел, и медиана
 * поехала бы вверх ровно от того правила, которое по ней и выбирают (поставили
 * 5 с — «обычно 5 с» — поставили 15 с). Прерванные руки дают `ranMs: null` и
 * сюда тоже не попадают.
 */
export function runStats(attempts: readonly CouncilAttempt[]): RunStats | null {
  const spans = attempts
    .map((attempt) => attempt.run)
    .filter((run): run is NonNullable<CouncilAttempt['run']> =>
      run !== null && run !== undefined && run.ranMs !== null && timedOutLimit({ run }) === null)
    .map((run) => run.ranMs as number)
    .sort((a, b) => a - b)
  if (spans.length === 0) return null
  const middle = Math.floor(spans.length / 2)
  return {
    median: spans.length % 2 === 1 ? spans[middle] : Math.round((spans[middle - 1] + spans[middle]) / 2),
    max: spans[spans.length - 1],
    count: spans.length,
  }
}

/** Предел, который остановил этот запуск, — или `null`, если его никто не останавливал. */
export function timedOutLimit(attempt: {
  run: Pick<NonNullable<CouncilAttempt['run']>, 'timedOut'> | null
}): number | null {
  const limit = attempt.run?.timedOut
  return typeof limit === 'number' ? limit : null
}

/**
 * «Остановлены сами» — свежие сверху, по началу запуска.
 *
 * По началу, а не по сдаче: секция про то, что случилось с ОЧЕРЕДЬЮ минуту
 * назад, и работа, сданная утром и запущенная сейчас, стоит первой.
 */
export function timedOutAttempts(attempts: readonly CouncilAttempt[]): CouncilAttempt[] {
  return attempts
    .filter((attempt) => timedOutLimit(attempt) !== null)
    .sort(
      (a, b) =>
        (b.run?.startedAt ?? 0) - (a.run?.startedAt ?? 0) || a.participantId.localeCompare(b.participantId),
    )
}

/** Доли полосы «весь класс одной строкой» — по статусам, без округлений. */
export function classBar(
  attempts: readonly CouncilAttempt[],
): Record<CouncilStatus | 'writing', number> {
  const bar: Record<CouncilStatus | 'writing', number> = {
    correct: 0,
    wrong: 0,
    failed: 0,
    ran: 0,
    unrun: 0,
    writing: 0,
  }
  for (const attempt of attempts) {
    if (attempt.submittedAt === null) bar.writing += 1
    else bar[attempt.status] += 1
  }
  return bar
}
