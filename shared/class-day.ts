/**
 * The day of a class: a calendar date, never a moment.
 *
 * A course row says "Sunday, 6 September", and that is a fact about the
 * timetable, not about a clock. Stored as a timestamp it would move with
 * every zone that reads it: midnight in Moscow is still Saturday in a browser
 * set to UTC−5, and the class would show up a day early on half of the
 * phones. So a day travels as 'YYYY-MM-DD' everywhere, the arithmetic here
 * works on UTC dates that no zone can shift, and the only place a zone enters
 * at all is `dayOf`, which asks "what day was it in the instance's zone at
 * that moment".
 *
 * Pure: no clock and no environment. The server decides which zone is the
 * instance's (server/src/time-zone.ts) and which moment is "now".
 */

export const CLASS_DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

const DAY_MS = 86_400_000

/** Midnight UTC of the day, as a number the Date arithmetic below can use. */
function utcOf(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
}

function keyOf(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/**
 * A real calendar date in the stored form.
 *
 * The pattern alone lets 2026-02-30 through, and Date would quietly turn it
 * into 2 March: a teacher who typed the wrong day must hear about it instead
 * of finding the class two days later in the course.
 */
export function isClassDay(value: unknown): value is string {
  return typeof value === 'string' && CLASS_DAY_RE.test(value) && keyOf(utcOf(value)) === value
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>()

/** The day that contains `ms` in the named zone. */
export function dayOf(ms: number, zone: string): string {
  let format = dayFormatters.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    })
    if (dayFormatters.size >= 32) dayFormatters.clear()
    dayFormatters.set(zone, format)
  }
  const parts: Record<string, number> = {}
  for (const part of format.formatToParts(ms)) parts[part.type] = Number(part.value)
  return keyOf(Date.UTC(parts.year, parts.month - 1, parts.day))
}

export function addDays(day: string, days: number): string {
  return keyOf(utcOf(day) + days * DAY_MS)
}

/** Whole days from `from` to `to`: positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / DAY_MS)
}

/** 0 for Sunday … 6 for Saturday, like Date#getDay. */
export function weekdayOf(day: string): number {
  return new Date(utcOf(day)).getUTCDay()
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let found = formatters.get(key)
  if (!found) {
    // Always UTC: the day was built as a UTC midnight, and any other zone
    // would print the day before or after it.
    found = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' })
    if (formatters.size >= 64) formatters.clear()
    formatters.set(key, found)
  }
  return found
}

/**
 * «вс, 4 окт» / "Sun, Oct 4": the short form a course row and a card use.
 *
 * Russian gets its months cut to three letters from the genitive (сен, окт,
 * мая), the way timetables write them; Intl's own short forms («сент.»,
 * «нояб.») read like a form to fill in. `year` adds the year for a day that
 * is not in the current one.
 */
export function formatDay(
  day: string,
  locale: string,
  options: { weekday?: boolean; year?: boolean } = {},
): string {
  const at = utcOf(day)
  const weekday = options.weekday ?? true
  if (locale.startsWith('ru')) {
    const parts = formatter('ru', { day: 'numeric', month: 'long' }).formatToParts(at)
    const date = parts.find((p) => p.type === 'day')?.value ?? ''
    const month = (parts.find((p) => p.type === 'month')?.value ?? '').slice(0, 3)
    const head = weekday ? `${formatter('ru', { weekday: 'short' }).format(at)}, ` : ''
    const tail = options.year ? ` ${new Date(at).getUTCFullYear()}` : ''
    return `${head}${date} ${month}${tail}`
  }
  return formatter(locale, {
    ...(weekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
    ...(options.year ? { year: 'numeric' } : {}),
  }).format(at)
}

/* ------------------------------------------------------------ week texts */

/*
 * Every form a timetable writes a month in, Russian and English, nominative
 * and genitive. A word counts as a month when it is the start of one of these
 * (at least three letters): «сен», «сент.», «сентября» and "Sep" all are,
 * «се» and "Sept-ish" are not.
 */
const MONTHS: readonly string[][] = [
  ['январь', 'января', 'january'],
  ['февраль', 'февраля', 'february'],
  ['март', 'марта', 'march'],
  ['апрель', 'апреля', 'april'],
  ['май', 'мая', 'may'],
  ['июнь', 'июня', 'june'],
  ['июль', 'июля', 'july'],
  ['август', 'августа', 'august'],
  ['сентябрь', 'сентября', 'september'],
  ['октябрь', 'октября', 'october'],
  ['ноябрь', 'ноября', 'november'],
  ['декабрь', 'декабря', 'december'],
]

/** Sunday first, like `weekdayOf`. */
const WEEKDAYS: readonly string[][] = [
  ['вс', 'воскресенье', 'sun', 'sunday'],
  ['пн', 'понедельник', 'mon', 'monday'],
  ['вт', 'вторник', 'tue', 'tues', 'tuesday'],
  ['ср', 'среда', 'wed', 'wednesday'],
  ['чт', 'четверг', 'thu', 'thur', 'thurs', 'thursday'],
  ['пт', 'пятница', 'fri', 'friday'],
  ['сб', 'суббота', 'sat', 'saturday'],
]

function monthOf(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, '')
  if (w.length < 3) return null
  const found = MONTHS.findIndex((forms) => forms.some((form) => form.startsWith(w)))
  return found < 0 ? null : found + 1
}

function weekdayNamed(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, '')
  const found = WEEKDAYS.findIndex((forms) =>
    forms.some((form, i) => form === w || (i > 0 && w.length >= 3 && form.startsWith(w))),
  )
  return found < 0 ? null : found
}

const WORD = '[A-Za-zА-Яа-яЁё]+\\.?'
const WEEKDAY_HEAD = new RegExp(`^(${WORD})[,\\s]+`)
const DAY_MONTH = new RegExp(`^(\\d{1,2})\\s+(${WORD})$`)
const MONTH_DAY = new RegExp(`^(${WORD})\\s+(\\d{1,2})$`)
const NUMERIC = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?$/
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

function make(year: number, month: number, date: number): string | null {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  const day = `${pad(year, 4)}-${pad(month)}-${pad(date)}`
  return isClassDay(day) ? day : null
}

/**
 * The single day a legacy week text names, or `null`.
 *
 * Accepted: «вс, 6 сен», «6 сен», «06.09», «06.09.2026», «Sun, Sep 6»,
 * «6 сентября», «2026-09-06». Everything else, a week range above all
 * («31 авг — 6 сен», «1–28 фев»), is left alone: picking one day out of a
 * range would be inventing what the timetable does not say.
 *
 * A text without a year gets the one that puts the day within
 * [created − 180 days, created + 366 days], nearest to `created`, the day the
 * course was made: a course created on 1 September 2026 that says «10 янв»
 * means January 2027. A weekday written in the text must agree with the day
 * it names, and it settles the year when the window holds two: «вс, 7 мар»
 * on that course is 7 March 2027, a Sunday, not 7 March 2026, a Saturday a
 * little nearer. With no candidate agreeing the row is better left undated
 * than dated wrongly.
 */
export function parseWhen(text: string, created: string): string | null {
  let rest = text.trim().replace(/\s+/g, ' ').replace(/[.,;]+$/, '')
  if (!rest) return null
  let weekday: number | null = null
  const head = WEEKDAY_HEAD.exec(rest)
  if (head) {
    const named = weekdayNamed(head[1])
    if (named !== null) {
      weekday = named
      rest = rest.slice(head[0].length).trim()
    }
  }

  let month: number | null = null
  let date = 0
  let year: number | null = null
  let match: RegExpExecArray | null
  if ((match = ISO.exec(rest))) {
    year = Number(match[1])
    month = Number(match[2])
    date = Number(match[3])
  } else if ((match = NUMERIC.exec(rest))) {
    date = Number(match[1])
    month = Number(match[2])
    if (match[3]) year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])
  } else if ((match = DAY_MONTH.exec(rest))) {
    date = Number(match[1])
    month = monthOf(match[2])
  } else if ((match = MONTH_DAY.exec(rest))) {
    month = monthOf(match[1])
    date = Number(match[2])
  }
  if (!month || month > 12 || date < 1) return null

  const agrees = (day: string) => weekday === null || weekdayOf(day) === weekday
  if (year !== null) {
    const day = make(year, month, date)
    return day && agrees(day) ? day : null
  }
  const base = Number(created.slice(0, 4))
  let day: string | null = null
  let best = Infinity
  for (const candidate of [base - 1, base, base + 1]) {
    const made = make(candidate, month, date)
    if (!made || !agrees(made)) continue
    const offset = daysBetween(created, made)
    if (offset < -180 || offset > 366) continue
    if (Math.abs(offset) < best) {
      best = Math.abs(offset)
      day = made
    }
  }
  return day
}
