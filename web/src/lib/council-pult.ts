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
import { tr } from '@shared/i18n'
import type { CouncilAttempt, CouncilGroup, CouncilStatus } from '@shared/protocol'
import { groupTitle } from './council-board'

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
 * Строка списка. Три вида, и только первый выбирается курсором: шапка группы и
 * свёрнутый хвост — это не люди, а места в ленте, и Enter на них означал бы
 * «показать классу» неизвестно чью работу.
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

/** Сдана — значит есть время сдачи; всё остальное — черновик, «ещё пишет». */
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
      return attempt.status === 'failed' || attempt.status === 'wrong'
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
  return rows
}

/** Только по людям: шапка группы и свёрнутый хвост курсору не даются. */
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
