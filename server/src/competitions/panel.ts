/**
 * Решения, которые панель соревнований принимает по числам, а не по запросу.
 *
 * Чистые функции: ни базы, ни диска, ни express. Сюда вынесено всё, у чего
 * есть правильный и неправильный ответ, — готовность к открытию, оценка
 * ожидания в очереди, сводка без базового решения, — потому что проверять их
 * через HTTP значит проверять заодно печенье, маршрутизацию и JSON, а падать
 * они будут молча и по одному числу.
 *
 * Слов здесь нет: отказ называется причиной (`OpenRefusal`), а фразу к ней
 * подбирает тот, кто отвечает, — по-русски или по-английски, смотря чей
 * инстанс.
 */
import { ENVIRONMENT_NAME } from '@shared/admin'
import {
  isTerminal,
  LIMITS,
  parseSlug,
  slugRefusal,
  type CompetitionLimits,
  type MetricDirection,
  type PrivateRelease,
  type ScoringRule,
  type SlugRefusal,
  type SubmissionState,
} from '@shared/competitions'
import type { CompetitionCounts, CompetitionInput, OpenRefusal } from '@shared/competitions-api'

/** Всё, чем решается «можно ли открывать». */
export interface Readiness {
  openFiles: number
  hiddenFiles: number
  metricCode: string
  /** Есть ли на диске сэмпл-тетрадь. */
  baseline: boolean
  /** Чем кончился её последний заход; null — не проверялась. */
  baselineState: SubmissionState | null
  privateRelease: 'auto' | 'manual'
  deadlineAt: number | null
}

/**
 * Почему соревнование ещё нельзя открыть; `null` — можно.
 *
 * Порядок проверок — порядок секций в редакторе (данные, ответы, метрика,
 * сэмпл-тетрадь, сроки): человек чинит то, что названо первым, и должен идти
 * по форме сверху вниз, а не прыгать по ней за каждым следующим отказом.
 *
 * Главное здесь — предпоследняя строка. «Сэмпл-тетрадь загружена» и
 * «сэмпл-тетрадь прошла весь путь до числа» — разные вещи, и открывать
 * соревнование можно только по второй: задача, которая не решается даже
 * автором, — это сто человек, безуспешно ищущих ошибку у себя.
 */
export function openRefusal(r: Readiness): OpenRefusal | null {
  if (r.openFiles === 0) return 'noData'
  if (r.hiddenFiles === 0) return 'noSolution'
  if (r.metricCode.trim().length === 0) return 'noMetric'
  if (!r.baseline) return 'noBaseline'
  if (r.baselineState !== 'scored') return 'baselineNotChecked'
  // Приватный лидерборд открывает дедлайн — без даты открывать его нечему, и
  // итога у соревнования не будет вовсе.
  if (r.privateRelease === 'auto' && r.deadlineAt === null) return 'noDeadline'
  return null
}

/**
 * Можно ли пересчитать метрику этой посылки, не запуская тетрадь заново.
 *
 * Пересчёт читает `submission.csv`, снятый прошлым прогоном, — значит годится
 * всё, что до него дошло: и удачная посылка, и отвергнутая метрикой (после
 * правки кода тот же ответ может оказаться принятым), и упавшая на самой
 * метрике. Упавшая тетрадь, убитая по времени или по памяти ответа не
 * оставила, и «пересчитать» для неё означало бы исполнить заново — другое
 * действие с другой ценой.
 */
export function rescorable(state: SubmissionState): boolean {
  return state === 'scored' || state === 'rejected' || state === 'metricFailed'
}

/* ----------------------------------------------------------- оценка ждущих */

export interface QueueTiming {
  /** Сколько осталось каждому идущему прогону, мс. */
  runningLeftMs: readonly number[]
  /** Сколько в среднем идёт посылка; null — мерить не по чему. */
  averageMs: number | null
  slots: number
}

/**
 * «≈ 3 мин» для каждой ждущей посылки, по порядку очереди.
 *
 * Считается расстановкой по свободным местам, а не умножением номера на
 * среднее: при двух исполнителях пятый в очереди ждёт вдвое меньше, и число,
 * посчитанное без этого, врёт ровно вдвое — причём в большую сторону, то есть
 * человек уходит с экрана, решив, что успеет сходить за кофе.
 *
 * `null` — когда среднего ещё нет: первая посылка соревнования ждёт неизвестно
 * сколько, и «≈ 0 мин» было бы обещанием, а не оценкой.
 */
export function waitEtas(count: number, timing: QueueTiming): (number | null)[] {
  if (count <= 0) return []
  if (timing.averageMs === null) return Array.from({ length: count }, () => null)
  const slots = Math.max(1, timing.slots)
  const free: number[] = []
  for (let i = 0; i < slots; i++) free.push(Math.max(0, timing.runningLeftMs[i] ?? 0))
  const out: (number | null)[] = []
  for (let i = 0; i < count; i++) {
    free.sort((a, b) => a - b)
    const at = free[0]
    out.push(at)
    free[0] = at + timing.averageMs
  }
  return out
}

/* --------------------------------------------------------------- сводки */

/** Что известно про посылку счёту дня и средней длительности. */
export interface DoneEntry {
  acceptedAt: number
  state: SubmissionState
  durationMs: number | null
}

/**
 * «сегодня исполнено 37, в среднем 2 мин 40 с».
 *
 * Днём считается день ПРИНЯТИЯ посылки, а не окончания прогона: времени
 * окончания у посылки нет, есть длительность, и восстанавливать по ней момент
 * значило бы прибавлять к принятию ещё и неизвестное ожидание в очереди.
 * Расходятся эти два дня только у посылки, принятой до полуночи и досчитанной
 * после, — одна строка в сутки, и она не стоит выдуманного времени.
 */
export function executedToday(
  entries: readonly DoneEntry[],
  since: number,
  now: number,
): { done: number; averageMs: number | null } {
  const today = entries.filter(
    (entry) => entry.acceptedAt >= since && entry.acceptedAt <= now && isTerminal(entry.state),
  )
  const spans = today
    .map((entry) => entry.durationMs)
    .filter((ms): ms is number => typeof ms === 'number' && ms > 0)
  return {
    done: today.length,
    averageMs: spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null,
  }
}

/** Медиана — «Медиана исполнения 2 мин 40 с» в сводке A3. */
export function medianOf(values: readonly number[]): number | null {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/**
 * Сводка без базового решения.
 *
 * Сэмпл-тетрадь записана обычной посылкой обычного (служебного) участника —
 * иначе её незачем было бы исполнять тем же путём, которым исполняются
 * посылки, и «проверено» ничего бы не доказывало. Но в строке «УЧАСТНИКИ 28» и
 * в сводке «ПОСЫЛОК 143» её быть не должно: это числа про класс, и лишняя
 * единица в них — та самая мелочь, по которой перестают верить всему экрану.
 */
export function withoutBaseline(
  counts: CompetitionCounts,
  baselineRows: readonly { state: SubmissionState }[],
  bestPublic: number | null,
): CompetitionCounts {
  const of = (state: SubmissionState) => baselineRows.filter((row) => row.state === state).length
  return {
    submissions: Math.max(0, counts.submissions - baselineRows.length),
    scored: Math.max(0, counts.scored - of('scored')),
    notebookFailed: Math.max(0, counts.notebookFailed - of('notebookFailed')),
    rejected: Math.max(0, counts.rejected - of('rejected')),
    timedOut: Math.max(0, counts.timedOut - of('timedOut')),
    outOfMemory: Math.max(0, counts.outOfMemory - of('outOfMemory')),
    metricFailed: Math.max(0, counts.metricFailed - of('metricFailed')),
    cancelled: Math.max(0, counts.cancelled - of('cancelled')),
    entrants: Math.max(0, counts.entrants - (baselineRows.length > 0 ? 1 : 0)),
    bestPublic,
  }
}

/* ------------------------------------------------------- разбор формы A2 */

/*
 * Что прислала форма редактора, лежит в `@shared/competitions-api`: это форма
 * проводов, и вторая её копия здесь разошлась бы с клиентом на первом же новом
 * поле.
 */
export type { CompetitionInput }

/** Отказ формы называет ПОЛЕ: человек должен знать, что подсветить. */
export type InputRefusal =
  | { field: 'slug'; why: SlugRefusal }
  | { field: 'title'; why: 'empty' }
  | { field: 'environment'; why: 'chars' }
  | { field: string; why: 'range'; min: number; max: number }
  | { field: string; why: 'value' }

const CHOICES = {
  direction: ['lower', 'higher'],
  privateRelease: ['auto', 'manual'],
  scoring: ['chosen', 'bestPublic', 'last'],
} as const

/**
 * Прочитать тело запроса как правку соревнования.
 *
 * Чистая, и это не из любви к чистоте: границы полей — единственное, что стоит
 * между формой и базой. Поле, проверенное только на экране, — это поле без
 * ограничения, а «публичная часть 0 %» или «памяти 64 МБ» ломаются не при
 * сохранении, а через неделю, на чужой посылке, и выглядят как ошибка
 * участника.
 *
 * Пришедшие поля — только те, что назвала форма: редактор A2 и вкладка
 * «Настройки» в A3 показывают РАЗНЫЕ куски соревнования, и «сохранить всё»
 * означало бы, что вкладка затирает поля, которых никогда не показывала.
 */
export function parseCompetitionInput(
  body: unknown,
  opts: { creating: boolean } = { creating: false },
): { input: CompetitionInput } | { refusal: InputRefusal } {
  const raw = (body ?? {}) as Record<string, unknown>
  const input: CompetitionInput = {}
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key)

  if (has('slug') || opts.creating) {
    const slug = parseSlug(String(raw.slug ?? ''))
    if (!slug) return { refusal: { field: 'slug', why: slugRefusal(String(raw.slug ?? '')) ?? 'chars' } }
    input.slug = slug
  }
  if (has('title') || opts.creating) {
    const title = String(raw.title ?? '').trim()
    if (!title) return { refusal: { field: 'title', why: 'empty' } }
    input.title = title
  }
  if (has('blurb')) input.blurb = String(raw.blurb ?? '').trim()
  // Описание не подрезается по краям: пробел в конце строки Markdown — это
  // перенос, а не мусор.
  if (has('description')) input.description = String(raw.description ?? '')

  if (has('metric')) {
    const metric = (raw.metric ?? {}) as Record<string, unknown>
    const out: { name?: string; direction?: MetricDirection; code?: string } = {}
    if (Object.prototype.hasOwnProperty.call(metric, 'name')) out.name = String(metric.name ?? '').trim()
    if (Object.prototype.hasOwnProperty.call(metric, 'code')) out.code = String(metric.code ?? '')
    if (Object.prototype.hasOwnProperty.call(metric, 'direction')) {
      const direction = String(metric.direction ?? '')
      if (!CHOICES.direction.includes(direction as MetricDirection)) {
        return { refusal: { field: 'metric.direction', why: 'value' } }
      }
      out.direction = direction as MetricDirection
    }
    input.metric = out
  }

  if (has('publicPercent')) {
    const range = LIMITS.publicPercent
    const value = number(raw.publicPercent)
    if (value === null || value < range.min || value > range.max) {
      return { refusal: { field: 'publicPercent', why: 'range', min: range.min, max: range.max } }
    }
    input.publicPercent = value
  }

  if (has('limits')) {
    const limits = (raw.limits ?? {}) as Record<string, unknown>
    const out: Partial<CompetitionLimits> = {}
    for (const name of ['wallSeconds', 'memoryMb', 'cpus', 'perDay'] as const) {
      if (!Object.prototype.hasOwnProperty.call(limits, name)) continue
      const range = LIMITS[name]
      const value = number(limits[name])
      if (value === null || value < range.min || value > range.max) {
        return { refusal: { field: `limits.${name}`, why: 'range', min: range.min, max: range.max } }
      }
      out[name] = value
    }
    input.limits = out
  }

  if (has('environment')) {
    const environment = String(raw.environment ?? '').trim()
    if (!ENVIRONMENT_NAME.test(environment)) {
      return { refusal: { field: 'environment', why: 'chars' } }
    }
    input.environment = environment
  }

  for (const name of ['startsAt', 'deadlineAt'] as const) {
    if (!has(name)) continue
    if (raw[name] === null) {
      input[name] = null
      continue
    }
    const at = number(raw[name])
    if (at === null) return { refusal: { field: name, why: 'value' } }
    input[name] = at
  }

  for (const name of ['privateRelease', 'scoring'] as const) {
    if (!has(name)) continue
    const value = String(raw[name] ?? '')
    if (!(CHOICES[name] as readonly string[]).includes(value)) {
      return { refusal: { field: name, why: 'value' } }
    }
    input[name] = value as PrivateRelease & ScoringRule
  }

  return { input }
}

/** Целое из тела запроса; `null` — это не число (в том числе `"5"` с мусором). */
function number(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

/* ------------------------------------------------------- порядок очереди */

/** Строка очереди в том виде, в каком её сортируют. */
export interface QueueOrderRow {
  submissionId: string
  entrantId: string
  turn: number
  enqueuedAt: number
}

/**
 * Ждущие — в том порядке, в котором их возьмут.
 *
 * ЭТО КОПИЯ ПОРЯДКА ИЗ `store.ts` · `selectNext`, и другой она быть не может:
 * берёт работу SQL (два процесса должны видеть один ответ), а нумерует строки
 * экран. Разойдясь, они не падают — экран просто врёт: человек читает «вы
 * вторая», а исполнитель берёт третью, и объяснить это нельзя ничем. Правило
 * одно: у кого уже что-то исполняется, тот пропускает остальных вперёд; своя
 * k-я посылка встаёт позади всех чужих (k−1)-х; при равенстве — кто раньше
 * прислал.
 */
export function fairOrder<T extends QueueOrderRow>(
  waiting: readonly T[],
  busyEntrants: ReadonlySet<string>,
): T[] {
  return [...waiting].sort((a, b) => {
    const busy = Number(busyEntrants.has(a.entrantId)) - Number(busyEntrants.has(b.entrantId))
    if (busy !== 0) return busy
    if (a.turn !== b.turn) return a.turn - b.turn
    if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt
    return a.submissionId < b.submissionId ? -1 : a.submissionId > b.submissionId ? 1 : 0
  })
}

/** Delayed resource retries remain visible, but cannot claim a queue slot yet. */
export function waitingEligibilityOrder<T extends QueueOrderRow & {notBefore:number}>(
  waiting:readonly T[],busyEntrants:ReadonlySet<string>,now=Date.now(),
):{eligible:T[];deferred:T[]} {
  return {
    eligible:fairOrder(waiting.filter(row=>row.notBefore<=now),busyEntrants),
    deferred:fairOrder(waiting.filter(row=>row.notBefore>now),busyEntrants),
  }
}
