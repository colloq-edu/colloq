import { tr, getLocale } from '@shared/i18n'
/**
 * What the course page says about time: which class is today, which is next,
 * which was the last one, where the «сегодня» line goes, how the list splits
 * into months and how much of it folds away.
 *
 * Pure, and on purpose: `today` comes from the server (PublicCourseView.today,
 * the instance's day), never from the browser's clock or zone. A student in
 * Vladivostok opening a Moscow course at 01:00 on Monday would otherwise see
 * Sunday's class as «вчера» while the teacher is still in the room. Every day
 * here is a 'YYYY-MM-DD' string and all arithmetic is shared/class-day.ts on
 * UTC midnights, so no zone can shift it.
 */
import { addDays, daysBetween, formatDay, weekdayOf } from '@shared/class-day'
import { materialTags, type MaterialTag } from '@shared/materials'
import type { MaterialRef, PublicClass } from '@shared/publish'

/** A class that counts: every row except a pause. */
function counts(row: PublicClass): boolean {
  return row.state !== 'pause' && row.n !== null
}

function dated(rows: readonly PublicClass[]): (PublicClass & { day: string })[] {
  return rows.filter((row): row is PublicClass & { day: string } => counts(row) && row.day !== null)
}

/* ------------------------------------------------------------ now blocks */

export interface Upcoming {
  /** 'today': a class is on the server's today; 'first': nothing came before it. */
  kind: 'today' | 'next' | 'first'
  row: PublicClass & { day: string }
  /** Whole days from today: 0 for today, 1 for tomorrow. */
  inDays: number
}

export interface Past {
  /** 'last' when nothing lies ahead: the course is over. */
  kind: 'past' | 'last'
  row: PublicClass & { day: string }
  /**
   * The most recent earlier class that has a page, offered when this one has
   * none: «Последние материалы — 02 · …». Without it a student who missed the
   * lag between the class and its page sees a dead end.
   */
  latest: PublicClass | null
}

export interface CourseNow {
  upcoming: Upcoming | null
  past: Past | null
  /** Every dated class is behind today: the meta line ends with «курс завершён». */
  over: boolean
}

/**
 * Today's, the next and the previous class, by the server's day.
 *
 * `null` for a course with no dated class at all: it gets no «сейчас»
 * blocks, exactly as before days existed. «Next» and «previous» go by date,
 * not by row order, because a teacher may move a row without retyping it.
 */
export function courseNow(classes: readonly PublicClass[], today: string): CourseNow | null {
  const days = dated(classes)
  if (days.length === 0) return null
  const todays = days.find((row) => row.day === today) ?? null
  let next: (PublicClass & { day: string }) | null = null
  let past: (PublicClass & { day: string }) | null = null
  for (const row of days) {
    if (row.day > today && (!next || row.day < next.day)) next = row
    if (row.day < today && (!past || row.day >= past.day)) past = row
  }

  let upcoming: Upcoming | null = null
  if (todays) upcoming = { kind: 'today', row: todays, inDays: 0 }
  else if (next) {
    upcoming = { kind: past ? 'next' : 'first', row: next, inDays: daysBetween(today, next.day) }
  }

  let before: Past | null = null
  if (past) {
    let latest: PublicClass | null = null
    if (!past.page) {
      for (const row of days) {
        if (row === past || !row.page || row.day >= today) continue
        if (!latest || (latest.day !== null && row.day >= latest.day)) latest = row
      }
    }
    before = { kind: upcoming ? 'past' : 'last', row: past, latest }
  }
  return { upcoming, past: before, over: upcoming === null }
}

/* ---------------------------------------------------------------- the list */

export type ListEntry =
  | { kind: 'month'; key: string; month: number; year: number | null }
  | { kind: 'now'; key: 'now' }
  | {
      kind: 'row'
      key: string
      row: PublicClass
      /** The row of the class on the server's today. */
      today: boolean
      /** The next class (when none is today): its line 2 says so in accent caps. */
      next: boolean
    }

export interface CoursePlan {
  entries: ListEntry[]
  /**
   * What «показать весь план» unfolds: the rows from the first one more than
   * FAR_DAYS past the upcoming class (or today, when it is later), when there
   * are more than FOLD_MIN classes among them. `null` when the whole list is
   * short enough to show.
   */
  folded: { from: number; classes: number; first: string; last: string } | null
}

/** Three months: what a student plans around. Further is the semester plan. */
export const FAR_DAYS = 90
/** Folding fewer rows than this saves less than the button costs. */
export const FOLD_MIN = 8

/**
 * The «ЗАНЯТИЯ» list: rows in teacher order, month labels where the month
 * changes, and the «сегодня» hairline between the past and the future.
 *
 * - A month label goes before a dated class whose month differs from the
 *   previous label's; it names the year only when the year changed, so the
 *   first label of a September course is «сентябрь» and the fifth is
 *   «январь 2027». Undated rows and pauses never start one, so a course with
 *   no days stays the flat list it was.
 * - The hairline goes before the first dated class after today, provided some
 *   class is already behind, and only when no class is today: on the day
 *   itself the row carries the accent instead.
 */
export function coursePlan(classes: readonly PublicClass[], today: string): CoursePlan {
  const entries: ListEntry[] = []
  const now = courseNow(classes, today)
  const todayKey = now?.upcoming?.kind === 'today' ? now.upcoming.row.key : null
  const nextKey = now?.upcoming && now.upcoming.kind !== 'today' ? now.upcoming.row.key : null
  let label: { month: number; year: number } | null = null
  let behind = false
  let lined = todayKey !== null
  for (const row of classes) {
    if (counts(row) && row.day !== null) {
      if (!lined && behind && row.day > today) {
        entries.push({ kind: 'now', key: 'now' })
        lined = true
      }
      if (row.day < today) behind = true
      const month = Number(row.day.slice(5, 7))
      const year = Number(row.day.slice(0, 4))
      if (!label || label.month !== month || label.year !== year) {
        entries.push({
          kind: 'month',
          key: `m-${year}-${month}-${entries.length}`,
          month,
          year: label && label.year !== year ? year : null,
        })
        label = { month, year }
      }
    }
    entries.push({
      kind: 'row',
      key: row.key,
      row,
      today: row.key === todayKey,
      next: row.key === nextKey,
    })
  }

  /*
   * Three months from the next class, not from today: a course link shared in
   * June for a September start had every row past a horizon counted from
   * today, the fold began at row 01, and «ЗАНЯТИЯ» showed not a single class.
   * Counted from the upcoming class, that class is never folded away.
   */
  let folded: CoursePlan['folded'] = null
  const ahead = now?.upcoming?.row.day
  const horizon = addDays(ahead !== undefined && ahead > today ? ahead : today, FAR_DAYS)
  const at = entries.findIndex(
    (entry) => entry.kind === 'row' && counts(entry.row) && entry.row.day !== null && entry.row.day > horizon,
  )
  if (at >= 0) {
    // The label that opens the first far month folds with it.
    const from = at > 0 && entries[at - 1].kind === 'month' ? at - 1 : at
    const rest = entries.slice(from).filter((entry) => entry.kind === 'row' && counts(entry.row))
    const days = rest.flatMap((entry) => (entry.kind === 'row' && entry.row.day ? [entry.row.day] : []))
    if (rest.length > FOLD_MIN && days.length > 0) {
      folded = { from, classes: rest.length, first: days[0], last: days.reduce((a, b) => (b > a ? b : a)) }
    }
  }
  return { entries, folded }
}

/* ---------------------------------------------------------------- the header */

/**
 * The weekday a course runs on, 0 for Sunday: when at least three classes
 * have a day and at least 80% of them share one. A course that moved twice
 * still runs «по воскресеньям»; one split between two days does not.
 */
export function courseWeekday(classes: readonly PublicClass[]): number | null {
  const days = dated(classes)
  if (days.length < 3) return null
  const tally = new Array<number>(7).fill(0)
  for (const row of days) tally[weekdayOf(row.day)]++
  const best = tally.indexOf(Math.max(...tally))
  return tally[best] / days.length >= 0.8 ? best : null
}

/** «2026/27» for a course across New Year, «2026» within one year; `null` without days. */
export function courseYears(classes: readonly PublicClass[]): string | null {
  const days = dated(classes).map((row) => row.day)
  if (days.length === 0) return null
  const first = Number(days.reduce((a, b) => (b < a ? b : a)).slice(0, 4))
  const last = Number(days.reduce((a, b) => (b > a ? b : a)).slice(0, 4))
  if (first === last) return String(first)
  if (last === first + 1) return `${first}/${String(last).slice(-2)}`
  return `${first}–${last}`
}

/** The first and the last class day, for «сентябрь — май»; `null` when they share a month. */
export function courseMonths(classes: readonly PublicClass[]): { first: string; last: string } | null {
  const days = dated(classes).map((row) => row.day)
  if (days.length === 0) return null
  const first = days.reduce((a, b) => (b < a ? b : a))
  const last = days.reduce((a, b) => (b > a ? b : a))
  return first.slice(0, 7) === last.slice(0, 7) ? null : { first, last }
}

/** Classes on the page, with a page, and still ahead: «3 с материалами · 30 впереди». */
export function courseTally(classes: readonly PublicClass[], today: string): {
  classes: number
  pages: number
  ahead: number
} {
  let total = 0
  let pages = 0
  let ahead = 0
  for (const row of classes) {
    if (!counts(row)) continue
    total++
    if (row.page) pages++
    else if (row.day !== null ? row.day >= today : row.state === 'plan' || row.state === 'room') ahead++
  }
  return { classes: total, pages, ahead }
}

/* --------------------------------------------------------------- formatting */

const monthFormats = new Map<string, Intl.DateTimeFormat>()

/**
 * «сентябрь», «январь 2027»: the nominative a timetable heads a month with.
 * Intl gives the standalone form when the month is asked alone, which in
 * Russian is exactly the nominative; the zone is UTC because the date is.
 */
export function monthName(month: number, year: number | null, locale = getLocale()): string {
  let format = monthFormats.get(locale)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' })
    monthFormats.set(locale, format)
  }
  const name = format.format(Date.UTC(2000, month - 1, 15))
  return year === null ? name : `${name} ${year}`
}

/** «вс, 4 окт»: the short day every row and block uses. */
export function shortDay(day: string, locale = getLocale()): string {
  return formatDay(day, locale)
}

const longFormats = new Map<string, Intl.DateTimeFormat>()

function longFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let found = longFormats.get(key)
  if (!found) {
    found = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' })
    longFormats.set(key, found)
  }
  return found
}

/**
 * «воскресенье, 13 сентября 2026» for a class page header; «вс, 13 сентября
 * 2026» with `weekday: 'short'`, «13 сентября 2026» with none.
 *
 * Built from parts in Russian: Intl's full form ends in « г.», which reads
 * like a form to fill in, not like a timetable.
 */
export function longDay(
  day: string,
  weekday: 'long' | 'short' | null = 'long',
  locale = getLocale(),
): string {
  const at = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
  if (locale.startsWith('ru')) {
    const parts = longFormat('ru', { day: 'numeric', month: 'long' }).formatToParts(at)
    const date = parts.find((p) => p.type === 'day')?.value ?? ''
    const month = parts.find((p) => p.type === 'month')?.value ?? ''
    const head = weekday ? `${longFormat('ru', { weekday }).format(at)}, ` : ''
    return `${head}${date} ${month} ${day.slice(0, 4)}`
  }
  return longFormat(locale, {
    ...(weekday ? { weekday } : {}),
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(at)
}

/** The 2-digit ordinal a timetable numbers classes with: 04. */
export function ordinal(n: number): string {
  return String(n).padStart(2, '0')
}

/** «через 2 дня» / «завтра». */
export function inDaysText(days: number): string {
  return days === 1 ? tr('room.course.tomorrow') : tr('room.course.inDays', { count: days })
}

/** «СЕГОДНЯ · ВС, 4 ОКТ», «СЛЕДУЮЩЕЕ · ВС, 4 ОКТ · ЧЕРЕЗ 2 ДНЯ», «ПЕРВОЕ ЗАНЯТИЕ · …». */
export function upcomingLabel(upcoming: Upcoming): string {
  const day = shortDay(upcoming.row.day)
  if (upcoming.kind === 'today') return tr('room.course.todayAt', { day })
  const when = inDaysText(upcoming.inDays)
  return tr(upcoming.kind === 'first' ? 'room.course.first' : 'room.course.next', { day, when })
}

/** «ПРОШЛОЕ ЗАНЯТИЕ · ВС, 20 СЕН» / «ПОСЛЕДНЕЕ ЗАНЯТИЕ · …». */
export function pastLabel(past: Past): string {
  return tr(past.kind === 'last' ? 'room.course.last' : 'room.course.past', {
    day: shortDay(past.row.day),
  })
}

/** «по воскресеньям». */
export function weekdayPhrase(weekday: number): string {
  return tr(`room.course.weekly.${weekday}`)
}

/** The words for a page's materials, deduped and in the shared order. */
export function tagWords(materials: readonly MaterialRef[]): string[] {
  return materialTags(materials).map((tag: MaterialTag) => tr(`room.course.tag.${tag}`))
}

/**
 * The second line of a course row: what a student needs to know about the
 * class without opening it. `chip` is the accent «СЕГОДНЯ» that replaces the
 * date on today's row; `date` is left out when the wide layout prints the day
 * in a column of its own.
 */
export interface RowNote {
  chip: boolean
  date: string | null
  /** Accent caps for the next class: «следующее · через 2 дня». */
  next: string | null
  text: string | null
}

export function rowNote(
  row: PublicClass,
  today: string,
  options: { next: boolean; withDate: boolean },
): RowNote {
  const tags = row.page ? tagWords(row.page.materials).join(' · ') : ''
  if (row.day === null) {
    /*
     * An undated row's week text («14–20 сен») stands where its date would:
     * the wide layout already prints it in the day column (CoursePage ·
     * dayText), so here it goes only with `withDate`. Line 2 keeps what a
     * page holds, as on a dated row, instead of the week a second time.
     */
    return { chip: false, date: options.withDate ? row.when : null, next: null, text: tags || null }
  }
  const isToday = row.day === today
  const date = isToday || !options.withDate ? null : shortDay(row.day)
  const next = options.next ? tr('room.course.nextRow', { when: inDaysText(daysBetween(today, row.day)) }) : null
  let text: string | null = null
  if (row.page) {
    text = row.day > today ? tr('room.course.beforeRow', { tags }) : tags || null
  } else if (isToday) {
    text = tr('room.course.afterRow')
  } else if (row.day < today) {
    text = row.state === 'closed' ? tr('room.course.noneRow') : tr('room.course.noneYetRow')
  }
  return { chip: isToday, date, next, text }
}

/** The text after the date on a row, joined the way it is printed: «вс, 6 сен · лекция · семинар». */
export function rowLine(note: RowNote): string {
  return [note.chip ? tr('room.course.today') : null, note.date, note.next, note.text]
    .filter((part): part is string => !!part)
    .join(' · ')
}
