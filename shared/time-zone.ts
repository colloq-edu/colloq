/**
 * Days and clocks in a NAMED time zone, from the zone database the runtime
 * carries (Intl). Pure: no clock, no environment — the server decides which
 * zone is the instance's (server/src/time-zone.ts), the browser gets the name
 * from the server.
 *
 * WHY A NAME AND NOT AN OFFSET. "The day" of a daily limit is the classroom's
 * day, and a fixed offset is right only where the clocks never move: Moscow
 * has kept +3 since 2014, but an instance in Berlin or in Almaty would count
 * its days an hour off for half of every year. With a zone name, midnight is
 * wherever the local clock says 00:00, summer time included.
 *
 * WHY NOT `new Date().getHours()`. That is the zone of the process, and a
 * container or a VPS without TZ runs in UTC: the day would start at three in
 * the morning Moscow time, in the middle of night work, while the page says
 * "today".
 */

/** The zone an instance counts its days in when `TZ` names none. */
export const DEFAULT_TIME_ZONE = 'Europe/Moscow'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Formatters are costly to build and cheap to reuse: one per zone. */
const partFormatters = new Map<string, Intl.DateTimeFormat>()

function partsOf(zone: string): Intl.DateTimeFormat {
  let found = partFormatters.get(zone)
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    if (partFormatters.size >= 32) partFormatters.clear()
    partFormatters.set(zone, found)
  }
  return found
}

const known = new Map<string, boolean>()

/** Whether the runtime's zone database knows this name (`Europe/Moscow` yes, `MSK` no). */
export function isTimeZone(zone: string): boolean {
  if (typeof zone !== 'string' || !zone) return false
  let answer = known.get(zone)
  if (answer === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone })
      answer = true
    } catch {
      answer = false
    }
    if (known.size >= 64) known.clear()
    known.set(zone, answer)
  }
  return answer
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** What a clock on the wall in `zone` shows at the moment `at`. */
function wallClock(at: number, zone: string): WallClock {
  const wall: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
  for (const part of partsOf(zone).formatToParts(at)) {
    if (part.type in wall) wall[part.type as keyof WallClock] = Number(part.value)
  }
  // An engine that still prints midnight as "24" under h23 means the start of the day.
  wall.hour %= 24
  return wall
}

/** `2026-09-30`: comparable as a string, which the search below relies on. */
function dayKey(wall: WallClock): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`
}

/** How many minutes `zone` is ahead of UTC at the moment `at`. */
function offsetAt(at: number, zone: string): number {
  const wall = wallClock(at, zone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / MINUTE)
}

/** The day starts found so far, by zone and date: the stream asks for today's once a second. */
const starts = new Map<string, number>()

/**
 * The first moment of the day that contains `at`, in `zone`.
 *
 * Usually local midnight: the date's midnight minus the zone's offset at that
 * midnight. The offset at midnight is not known until the moment is, so the
 * offset of `at` is tried first and the offset at that guess second; the two
 * differ only when the clocks moved between midnight and `at`. A zone that
 * moves its clocks AT midnight (Havana, Beirut, São Paulo until 2019) has no
 * 00:00 on that day, and its day starts at 01:00 — whichever candidate is the
 * first moment of the date wins, and a search settles anything stranger.
 */
export function dayStartIn(at: number, zone: string): number {
  const wall = wallClock(at, zone)
  const key = dayKey(wall)
  const cached = starts.get(`${zone}|${key}`)
  if (cached !== undefined) return cached
  const midnight = Date.UTC(wall.year, wall.month - 1, wall.day)
  const keyAt = (moment: number) => dayKey(wallClock(moment, zone))
  const first = midnight - offsetAt(at, zone) * MINUTE
  const second = midnight - offsetAt(first, zone) * MINUTE
  let start: number | null = null
  for (const candidate of [first, second].sort((a, b) => a - b)) {
    if (keyAt(candidate) === key && keyAt(candidate - 1) < key) {
      start = candidate
      break
    }
  }
  if (start === null) {
    // No offset in the world is more than fourteen hours; a day of summer
    // time adds one. The date's first moment lies between these two.
    let low = midnight - 27 * HOUR
    let high = at
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2)
      if (keyAt(middle) < key) low = middle
      else high = middle
    }
    start = high
  }
  if (starts.size >= 256) starts.clear()
  starts.set(`${zone}|${key}`, start)
  return start
}

/**
 * The first moment of the NEXT day, in `zone`: when a daily limit starts
 * over. A day lasts 23 to 25 hours, so a moment 26 hours after this day's
 * start always lies in the next one (a day a zone skipped outright, as Samoa
 * did in 2011, simply is not "the next one").
 */
export function nextDayStartIn(at: number, zone: string): number {
  return dayStartIn(dayStartIn(at, zone) + 26 * HOUR, zone)
}

/**
 * "00:00 GMT+3": a moment as a 24-hour clock with the zone named, in the
 * reader's language. The zone's short name comes from the same database;
 * `null` when the runtime does not know the zone (an old browser), so the
 * caller can say it without one.
 */
export function zonedClock(at: number, zone: string, locale: string): string | null {
  if (!isTimeZone(zone)) return null
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(at)
  } catch {
    return null
  }
}
