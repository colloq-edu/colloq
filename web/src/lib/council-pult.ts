/**
 * Мессенджер пульта консилиума — вся его арифметика, без Svelte и без сокета.
 *
 * Пульт живёт в отдельном окне (components/council/pult) и показывает список
 * людей слева, открытую работу справа. Здесь лежит то, что решает, ЧТО стоит в
 * списке и в каком порядке: сборка строк, свёртывание одинаковых ответов,
 * фильтры, непрочитанное, придержанные сдачи и ходы курсора.
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
import { COUNCIL_RERUN_PAUSES, COUNCIL_RUN_LIMITS, type CouncilSettings } from '@shared/notebook'
import type { CouncilAttempt, CouncilGroup, CouncilStatus } from '@shared/protocol'
import { groupTitle } from './council-board'

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

/** С какого числа одинаковых ответов группа сворачивается в одну строку. */
export const GROUP_MIN = 3

/** Чипы отбора над списком — ровно шесть, в этом порядке. */
export type PultFilter = 'all' | 'new' | 'error' | 'unrun' | 'groups' | 'writing'

export const FILTERS: readonly PultFilter[] = ['all', 'new', 'error', 'unrun', 'groups', 'writing']

/** Слово в чипе. Одно место, где фильтр становится словом. */
export function filterLabel(filter: PultFilter): string {
  switch (filter) {
    case 'new':
      return tr('room.ui.1305')
    case 'error':
      return tr('room.ui.1306')
    case 'unrun':
      return tr('room.ui.1307')
    case 'groups':
      return tr('room.ui.1308')
    case 'writing':
      return tr('room.ui.1309')
    default:
      return tr('room.ui.1304')
  }
}

/**
 * Строка списка. Четыре вида, и только первый выбирается курсором: шапка
 * группы, свёрнутый хвост и заголовок секции — это не люди, а места в ленте, и
 * Enter на них означал бы «показать классу» неизвестно чью работу.
 */
export type PultRow =
  | {
      kind: 'attempt'
      /** Ключ для `{#each}` и для курсора — он же participantId. */
      id: string
      attempt: CouncilAttempt
      unread: boolean
      /** Строка внутри раскрытой группы: отступ слева и подпись «та же строка». */
      inGroup: boolean
      /** Номер варианта при выключенных именах; с единицы. */
      variant: number
    }
  | { kind: 'collapsed'; id: string; groupKey: string; rest: number; faces: CouncilAttempt[] }
  /**
   * Заголовок половины ленты: «Сдали · N» и «Пишут · N».
   *
   * Порядок в ленте и так ставит сданные первыми (bySubmissionDesc), но граница
   * между «уже сдал» и «ещё пишет» ничем не была отмечена, и в окне, где видно
   * две строки с половиной, её не существовало вовсе: список выглядел как один
   * ряд людей без отличий. Курсору строка не даётся — как шапке группы и хвосту.
   */
  | { kind: 'section'; id: string; section: 'submitted' | 'writing'; count: number }
  | {
      kind: 'header'
      id: string
      groupKey: string
      index: number
      count: number
      /**
       * Как группа называется: имя от оракула, а без него — первая строка кода
       * (council-board.ts · groupTitle). «Группа 2 · 87 одинаковых» не говорит,
       * ЧТО написали эти восемьдесят семь; название говорит.
       */
      label: string
    }

export interface PultListInput {
  attempts: readonly CouncilAttempt[]
  /** Группы — те же, что у стопки (council-board.ts · groupAttempts). */
  groups: readonly CouncilGroup[]
  filter: PultFilter
  /** Поиск по имени; при выключенных именах зовущий передаёт пустую строку. */
  search: string
  /** Кто сдал после того, как в список смотрели в последний раз. */
  unread: ReadonlySet<string>
  /** Раскрытые группы — по ключу группы. */
  expanded: ReadonlySet<string>
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
  grouped: ReadonlySet<string>,
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
    case 'groups':
      return grouped.has(attempt.groupKey)
    case 'writing':
      return !isSubmitted(attempt)
    default:
      return true
  }
}

/**
 * Строки списка — то, что рисует левая колонка.
 *
 * Правило свёртывания: группа от трёх одинаковых показывает ОДНОГО, самого
 * свежего, а под ним стоит строка «ещё N с тем же ответом». Раскрыли — на её
 * месте шапка группы и остальные с отступом. Свёрнутые члены из ленты уходят
 * целиком: иначе триста одинаковых строк — это и есть сегодняшняя жалоба.
 *
 * Фильтр и поиск свёртывание не отменяют, но отменяют его последствия: когда
 * из группы под отбор попал не представитель, а кто-то один, он стоит в ленте
 * сам по себе, без шапки и без хвоста, — иначе «с ошибкой» показывал бы
 * заголовок группы, в которой под отбор не попал никто.
 */
export function listRows(input: PultListInput): PultRow[] {
  const { attempts, groups, filter, search, unread, expanded, held } = input
  const variants = variantNumbers(attempts)
  const big = new Map(groups.filter((group) => group.count >= GROUP_MIN).map((group) => [group.key, group]))
  const grouped = new Set(big.keys())
  const index = new Map(groups.map((group, at) => [group.key, at + 1]))
  const needle = search.trim().toLocaleLowerCase()

  const visible = attempts.filter(
    (attempt) =>
      !held.has(attempt.participantId) &&
      matchesFilter(attempt, filter, unread, grouped) &&
      (needle === '' || attempt.name.toLocaleLowerCase().includes(needle)),
  )
  const ordered = [...visible].sort(bySubmissionDesc)

  // Кто стоит за группу: первый её член в ленте, то есть самый свежий из
  // доехавших до отбора. Считается по УЖЕ отобранным — представитель, не
  // прошедший фильтр, группу собой не заслоняет.
  const head = new Map<string, string>()
  for (const attempt of ordered) {
    if (!isSubmitted(attempt) || !big.has(attempt.groupKey)) continue
    if (!head.has(attempt.groupKey)) head.set(attempt.groupKey, attempt.participantId)
  }

  const rows: PultRow[] = []
  const row = (attempt: CouncilAttempt, inGroup: boolean): PultRow => ({
    kind: 'attempt',
    id: attempt.participantId,
    attempt,
    unread: unread.has(attempt.participantId),
    inGroup,
    variant: variants.get(attempt.participantId) ?? 0,
  })

  for (const attempt of ordered) {
    const key = attempt.groupKey
    const group = isSubmitted(attempt) ? big.get(key) : undefined
    if (!group || head.get(key) !== attempt.participantId) {
      // Член свёрнутой группы — он уже под её хвостом; раскрытую собирает шапка.
      if (group) continue
      rows.push(row(attempt, false))
      continue
    }
    rows.push(row(attempt, false))
    const rest = ordered.filter(
      (other) => other.groupKey === key && isSubmitted(other) && other.participantId !== attempt.participantId,
    )
    if (rest.length === 0) continue
    if (!expanded.has(key)) {
      rows.push({ kind: 'collapsed', id: `group:${key}`, groupKey: key, rest: rest.length, faces: rest.slice(0, 3) })
      continue
    }
    rows.push({
      kind: 'header',
      id: `head:${key}`,
      groupKey: key,
      index: index.get(key) ?? 0,
      count: group.count,
      label: groupTitle(group),
    })
    for (const member of rest) rows.push(row(member, true))
  }
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
 * Счёт — по людям, а не по строкам: свёрнутая группа прячет своих под хвостом,
 * и «Сдали · 3» при восьми сдавших было бы враньём ровно там, где на число
 * смотрят, чтобы понять, ждать ли ещё кого-то.
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

/** Только по людям: шапка группы, свёрнутый хвост и заголовок секции курсору не даются. */
export function selectable(rows: readonly PultRow[]): string[] {
  return rows.filter((row) => row.kind === 'attempt').map((row) => row.id)
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

/**
 * Сосед ВНУТРИ одной группы — стрелки ← →.
 *
 * Из группы они не выводят: у них одна работа — «покажите другой вариант того
 * же ответа», и выход в соседнюю группу означал бы, что стрелка иногда меняет
 * тему разговора, а иногда нет. Вне группы соседа нет вовсе.
 */
export function neighbourInGroup(
  attempts: readonly CouncilAttempt[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (current === null) return null
  const at = attempts.find((attempt) => attempt.participantId === current)
  if (!at || !isSubmitted(at)) return null
  const mates = attempts
    .filter((attempt) => attempt.groupKey === at.groupKey && isSubmitted(attempt))
    .sort(bySubmissionDesc)
  if (mates.length < 2) return null
  const index = mates.findIndex((attempt) => attempt.participantId === current)
  const next = (index + delta + mates.length) % mates.length
  return mates[next].participantId
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
  | 'toggleGroup'
  | 'search'
  | 'show'
  | 'run'
  | 'correct'
  | 'wrong'
  | 'clearShown'
  | 'neighbourNext'
  | 'neighbourPrev'
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
    case ' ':
      return 'toggleGroup'
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
    case 'ArrowRight':
      return 'neighbourNext'
    case 'ArrowLeft':
      return 'neighbourPrev'
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
  running: CouncilAttempt | null
  queued: CouncilAttempt[]
  pending: CouncilAttempt[]
}

export function kernelView(attempts: readonly CouncilAttempt[]): KernelView {
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
  return { running, queued, pending }
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
