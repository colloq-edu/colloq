/**
 * Стопка консилиума — чистая арифметика пульта, без Svelte и без сокета.
 *
 * Пульт преподавателя рисует одну карточку из сотен попыток и полосу групп под
 * ней; порядок стопки, сегменты полосы и «так же ещё 311» считаются здесь, из
 * полного `CouncilBoard`, который приезжает по сокету. Вынесено в модуль ради
 * тестов (образец: output-seat.ts) и ради того, чтобы компонент не складывал
 * группы сам: сложенное в двух местах рано или поздно складывается по-разному.
 *
 * Ключ группы попыткам ставит сервер той же `normalizeAttempt`, что
 * реэкспортирована отсюда: пульт по нему только группирует, не пересчитывает.
 */
import type { CouncilAttempt, CouncilGroup, CouncilOracle, CouncilStatus } from '@shared/protocol'
import { bySubmission, groupAttempts } from '@shared/protocol'
export { normalizeAttempt } from '@shared/notebook'

/** Цвет черты под сегментом: верно / ошибка / падает / не смотрели. */
export type StripTone = 'ok' | 'error' | 'fail' | 'none'

export interface StripSegment {
  key: string
  count: number
  tone: StripTone
  /** Группа, представитель которой сейчас на карточке. */
  current: boolean
  /** Пунктирный хвост «ещё пишут» — без ключа группы, потому что группы ещё нет. */
  writing?: boolean
}

/**
 * Ключ хвоста в полосе. С пробелом внутри — и потому не ключ ни одной группы:
 * `normalizeAttempt` пробелы выбрасывает все, а пустую строку даёт запросто —
 * пустой лист и лист из одних комментариев сдают, и это группа «(пусто)» с
 * ключом ''. Хвост с тем же ключом давал бы два одинаковых ключа в keyed
 * `{#each}` полосы: падение в dev, сломанная реконсиляция в prod.
 */
export const WRITING_KEY = 'ещё пишут'

/** Сдана — значит есть время сдачи; всё остальное — «ещё пишет». */
const submitted = (attempt: CouncilAttempt): attempt is CouncilAttempt & { submittedAt: number } =>
  attempt.submittedAt !== null

/*
 * Группировка — общая, из shared/protocol.ts.
 *
 * Здесь лежали свои `bySubmission` и `groupAttempts`, третья копия одного и
 * того же правила: своя была у серверной стопки, своя у оракула, своя у
 * пульта, — и они уже разошлись разрывом при равенстве. Разрыв решает, кто
 * представитель группы, то есть чей код стоит на карточке и на чью карточку
 * ложится черновик ответа; при расхождении «так же ещё 311» и ширина сегмента
 * считались от разных наборов. `CouncilAttempt` подходит под `GroupMember` как
 * есть — `groupKey` ему ставит сервер той же `normalizeAttempt`.
 */
export { groupAttempts }

/**
 * Порядок стопки: представители групп от большой к малой, потом остальные по
 * времени сдачи, пишущие — в конце, по id.
 *
 * Пишущие нарочно НЕ по времени правки: стопка пересобирается на каждый кадр,
 * по три в секунду, пока класс печатает, и порядок «кто печатал последним, тот
 * первый» переставлял бы карточку под глазами — пока никто не сдал, карточка
 * без выбранной позиции показывает первую в стопке, и она меняла бы имя и код
 * на каждую паузу в наборе у кого угодно, а → вела бы в случайное место.
 * Порядок по id ничего не значит, зато не двигается.
 */
export function stackOrder(groups: CouncilGroup[], attempts: CouncilAttempt[]): CouncilAttempt[] {
  const byId = new Map(attempts.map((a) => [a.participantId, a]))
  const heads: CouncilAttempt[] = []
  const taken = new Set<string>()
  for (const group of groups) {
    const head = byId.get(group.representative)
    if (!head) continue
    heads.push(head)
    taken.add(head.participantId)
  }
  const rest = attempts
    .filter((a) => submitted(a) && !taken.has(a.participantId))
    .sort(bySubmission)
  const writing = attempts
    .filter((a) => !submitted(a))
    .sort((a, b) => a.participantId.localeCompare(b.participantId))
  return [...heads, ...rest, ...writing]
}

/**
 * Сегменты полосы групп: ширина по числу людей (min-width рисует CSS), тон по
 * статусу группы, `current` — группа попытки на карточке, последним — хвост
 * «ещё пишут» на `writing` человек, если их больше нуля.
 */
export function stripSegments(
  groups: CouncilGroup[],
  writing: number,
  currentKey: string | null,
): StripSegment[] {
  const segments: StripSegment[] = groups.map((group) => ({
    key: group.key,
    count: group.count,
    tone: toneOf(group.status),
    current: currentKey !== null && group.key === currentKey,
  }))
  if (writing > 0) {
    segments.push({ key: WRITING_KEY, count: writing, tone: 'none', current: false, writing: true })
  }
  return segments
}

/** Тон черты для статуса — одно место, где статус становится цветом. */
export function toneOf(status: CouncilStatus): StripTone {
  switch (status) {
    case 'correct':
      return 'ok'
    case 'wrong':
      return 'error'
    case 'failed':
      return 'fail'
    default:
      return 'none'
  }
}

/**
 * Слово в чипе состояния. Для упавшей — имя исключения, потому что «ошибка»
 * ничего не говорит, а `TypeError` в чипе сразу отвечает, что показать классу.
 */
export function statusLabel(attempt: Pick<CouncilAttempt, 'status' | 'run'>): string {
  switch (attempt.status) {
    case 'correct':
      return 'верно'
    case 'wrong':
      return 'неверно'
    case 'failed': {
      const error = attempt.run?.outputs.find((o) => o.kind === 'error')
      return error && error.kind === 'error' && error.ename ? error.ename : 'упала'
    }
    case 'ran':
      return 'выполнена'
    default:
      return 'не запускали'
  }
}

/** Имя группы: от оракула, а пока его нет — первая непустая строка кода. */
export function groupTitle(group: Pick<CouncilGroup, 'label' | 'sample'>): string {
  if (group.label) return group.label
  const line = group.sample.split('\n').find((l) => l.trim())
  return line?.trim() ?? '(пусто)'
}

export interface Neighbours {
  prev: string | null
  next: string | null
  /** Представитель предыдущей / следующей группы; у пишущего следующей группы нет. */
  prevGroup: string | null
  nextGroup: string | null
}

/**
 * Куда ведут стрелки с текущей попытки. Позиция `null` (карточку ещё не
 * выбирали) — «следующая» есть первая в стопке, «предыдущей» нет.
 *
 * Shift+стрелка ходит по представителям: с любой попытки внутри группы —
 * к соседней группе, не к своему же представителю; иначе первое нажатие
 * никуда не вело бы.
 */
export function neighbours(
  order: CouncilAttempt[],
  groups: CouncilGroup[],
  position: string | null,
): Neighbours {
  const at = position === null ? -1 : order.findIndex((a) => a.participantId === position)
  const prev = at > 0 ? order[at - 1].participantId : null
  const next = at + 1 < order.length ? order[at + 1].participantId : null

  const current = at >= 0 ? order[at] : null
  const groupAt =
    current && current.submittedAt !== null
      ? groups.findIndex((g) => g.key === current.groupKey)
      : -1
  let prevGroup: string | null = null
  let nextGroup: string | null = null
  if (current === null) {
    nextGroup = groups[0]?.representative ?? null
  } else if (groupAt >= 0) {
    prevGroup = groupAt > 0 ? groups[groupAt - 1].representative : null
    nextGroup = groupAt + 1 < groups.length ? groups[groupAt + 1].representative : null
  } else {
    // Пишущий стоит за всеми группами: назад — к последней, вперёд некуда.
    prevGroup = groups[groups.length - 1]?.representative ?? null
  }
  return { prev, next, prevGroup, nextGroup }
}

export type StackKeyAction = 'prev' | 'next' | 'prevGroup' | 'nextGroup' | 'show' | null

/**
 * Что делает клавиша в стопке — по тому, где стоит фокус.
 *
 *   field   — textarea, input, contenteditable: клавиши его, все
 *   control — кнопка или ссылка: стрелки листают (кнопке они не нужны, а после
 *             щелчка по сегменту полосы или по «Запустить» фокус остаётся на
 *             ней — и стрелки, которые обещает подсказка, иначе молчали бы),
 *             Enter — кнопки, не «показать классу», иначе одно нажатие делало
 *             бы два дела
 *   stack   — сам контейнер: и стрелки, и Enter
 */
export function stackKeyAction(
  key: string,
  shift: boolean,
  focus: 'field' | 'control' | 'stack',
): StackKeyAction {
  if (focus === 'field') return null
  if (key === 'ArrowLeft') return shift ? 'prevGroup' : 'prev'
  if (key === 'ArrowRight') return shift ? 'nextGroup' : 'next'
  if (key === 'Enter' && focus === 'stack') return 'show'
  return null
}

export interface StackPlace {
  /** Номер попытки в стопке, с единицы; 0 — позиции нет. */
  index: number
  total: number
  /** Номер группы, с единицы; 0 — попытка вне групп (пишет). */
  group: number
  groups: number
  /** «Так же ещё N» — остальные в группе. */
  same: number
}

/** Числа для плашки «группа 1 из 6 · 12 / 487». */
export function placeOf(
  order: CouncilAttempt[],
  groups: CouncilGroup[],
  position: string | null,
): StackPlace {
  const at = position === null ? -1 : order.findIndex((a) => a.participantId === position)
  const current = at >= 0 ? order[at] : null
  const groupAt =
    current && current.submittedAt !== null
      ? groups.findIndex((g) => g.key === current.groupKey)
      : -1
  return {
    index: at + 1,
    total: order.length,
    group: groupAt + 1,
    groups: groups.length,
    same: groupAt >= 0 ? groups[groupAt].count - 1 : 0,
  }
}

/**
 * Редкие — группы меньше одной двадцатой сдавших. В сводке они складываются в
 * одну строку «Редкие · 9 · 5 · 3»: двадцать одиночных ответов на пятьсот
 * человек — не шесть разных решений, а шум, и разворачивать его — по щелчку.
 * Пока сдавших мало, редких нет вовсе: на десять человек каждый ответ — решение.
 */
export const RARE_SHARE = 20

export function splitRare(
  groups: CouncilGroup[],
  submitted: number,
): { main: CouncilGroup[]; rare: CouncilGroup[] } {
  const main: CouncilGroup[] = []
  const rare: CouncilGroup[] = []
  for (const group of groups) (group.count * RARE_SHARE < submitted ? rare : main).push(group)
  return { main, rare }
}

export type OracleView = 'idle' | 'reading' | 'ready' | 'stale'

/**
 * В каком состоянии рисовать блок оракула. «Отстала» — счёт на месте, по числу
 * сдавших против `basedOn`: сводка обновляется только рукой, и о чужой сдаче
 * сервер ей ничего не говорит — `council:oracle` на «Сдать» не ходит намеренно.
 * Своего `stale` у сервера нет и не было: в кадре приезжают только три
 * остальных состояния.
 */
export function oracleState(oracle: CouncilOracle | null, submitted: number): OracleView {
  if (!oracle) return 'idle'
  if (oracle.state === 'idle' || oracle.state === 'reading') return oracle.state
  return submitted > oracle.basedOn ? 'stale' : 'ready'
}

/** «С тех пор сдали ещё N» — разница с тем, сколько попыток модель читала. */
export function staleBy(oracle: CouncilOracle, submitted: number): number {
  return Math.max(submitted - oracle.basedOn, 0)
}
