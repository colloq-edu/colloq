/**
 * The decisions of the «Контесты» tab, taken out of the components (Paper
 * «19 · Контесты», A1–A4).
 *
 * No Svelte and no browser, as in `admin/competitions.ts` and for the same
 * reason: these are the words and numbers a teacher acts on in the middle of
 * a class — which contest is live, why a draft will not open, how much room
 * the reference leaves under the time limit, which tests a failed submission
 * never reached — and a mistake in them shows only on a live contest.
 *
 * What is not here: the rules the server must agree with. The phase, the
 * letters, the freeze, the points of a test, the standings themselves live in
 * `shared/contests.ts` and are called from there; a second copy of any of
 * them does not crash, it quietly disagrees with the class's screen.
 */
import { formatDate, formatNumber, getLocale, tr } from '@shared/i18n'
import {
  boardFrozen,
  boardRevealed,
  contestPhase,
  freezeAt,
  judged,
  parseContestSlug,
  RESERVED_CONTEST_SLUGS,
  verdictTone,
  verdictWords,
  type Contest,
  type ContestLanguage,
  type ContestPhase,
  type JudgeState,
  type TestReport,
  type Verdict,
} from '@shared/contests'
import type { LanguageOption } from '@shared/contests-entrant'
import type {
  AdminQuestion,
  ContestListRow,
  ContestSettings,
  JudgeStatus,
  ProblemView,
  ReferenceStatus,
} from '@shared/contests-api'
import { suggestSlug } from '@shared/publish'
import { isTimeZone } from '@shared/time-zone'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/* --------------------------------------------------------------- the list */

/** The list's groups, in the order A1 draws them: what moves now comes first. */
export type ContestGroupKey = 'open' | 'soon' | 'draft' | 'over'

export const CONTEST_GROUPS: readonly ContestGroupKey[] = ['open', 'soon', 'draft', 'over']

/**
 * The rows of the list, grouped by phase and filtered by the search.
 *
 * The phase is worked out here, on the list's own clock, rather than read off
 * `row.phase`: that one is the server's word at the moment of the request, and
 * a list left open over the start of a class kept «СКОРО» on a contest the
 * class was already solving. contestPhase is the shared rule, so the two
 * clocks can disagree by a tick, never by a rule.
 *
 * Inside a group the order is what the teacher looks for: the live ones by
 * the nearest end, the coming ones by the nearest start, drafts by the last
 * edit, the finished ones newest first. Empty groups are not returned.
 */
export function groupContests(
  rows: readonly ContestListRow[],
  now: number,
  query = '',
): { key: ContestGroupKey; rows: ContestListRow[] }[] {
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? rows.filter((row) =>
        [row.contest.title, row.contest.slug, row.contest.blurb, row.course?.name ?? '']
          .some((text) => text.toLowerCase().includes(needle)),
      )
    : [...rows]
  const order: Record<ContestGroupKey, (a: Contest, b: Contest) => number> = {
    open: (a, b) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity),
    soon: (a, b) => (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity),
    draft: (a, b) => b.updatedAt - a.updatedAt,
    over: (a, b) => (b.endsAt ?? b.updatedAt) - (a.endsAt ?? a.updatedAt),
  }
  return CONTEST_GROUPS.map((key) => ({
    key,
    rows: shown
      .filter((row) => contestPhase(row.contest, now) === key)
      .sort((a, b) => order[key](a.contest, b.contest)),
  })).filter((group) => group.rows.length > 0)
}

/** The badge of a phase: the live one filled, the coming one pale, a draft amber, the finished grey (A1). */
export function phaseBadge(phase: ContestPhase): {
  tone: 'accent' | 'warning' | 'neutral'
  form: 'strong' | 'filled'
} {
  if (phase === 'open') return { tone: 'accent', form: 'strong' }
  if (phase === 'soon') return { tone: 'accent', form: 'filled' }
  if (phase === 'draft') return { tone: 'warning', form: 'filled' }
  return { tone: 'neutral', form: 'filled' }
}

/** «Python», «C++», «C» — a language where a column has room for one word. */
export function languageShort(language: ContestLanguage): string {
  if (language === 'python3') return 'Python'
  if (language === 'cpp20') return 'C++'
  return 'C'
}

/**
 * A language with its version, as the image says it («Python 3.11»,
 * «C++20 · g++ 12»); the bare name when the probe has not named it.
 */
export function languageLabel(language: ContestLanguage, options: readonly LanguageOption[]): string {
  return options.find((one) => one.id === language)?.label || languageShort(language)
}

/**
 * The title's second line in the list: «ICPC · Python, C++ · курс
 * «Алгоритмы, весна»». The third piece is the course when there is one; a
 * coming contest without one says instead that every reference passes —
 * the one thing a teacher checks before the class arrives.
 */
export function contestMeta(row: ContestListRow, now: number): string {
  const c = row.contest
  const parts = [c.rules.toUpperCase(), c.languages.map(languageShort).join(', ')].filter(Boolean)
  if (row.course) parts.push(tr('admin.contests.courseMeta', { name: row.course.name }))
  else if (contestPhase(c, now) === 'soon' && row.notReady.length === 0) parts.push(tr('admin.contests.allReferencesPass'))
  return parts.join(' · ')
}

/** What the state column says under the badge, and in which voice. */
export interface StateNote {
  text: string
  tone: 'brand' | 'warning' | 'accent' | 'muted'
  /** Drawn with the live dot of «дорешивание открыто». */
  dot: boolean
}

/**
 * The line under the phase badge (A1): the freeze of a live contest, what
 * stops a draft from opening, upsolving after the end. One line, and the
 * most pressing one wins.
 */
export function stateNote(row: ContestListRow, now: number, zone: string | null = null): StateNote | null {
  const c = row.contest
  const phase = contestPhase(c, now)
  if (phase === 'draft' || (phase === 'soon' && row.notReady.length > 0)) {
    return row.notReady.length > 0
      ? { text: tr('admin.contests.notReady', { letters: row.notReady.join(', ') }), tone: 'warning', dot: false }
      : null
  }
  if (boardFrozen(c, now)) {
    const at = freezeAt(c)!
    return { text: tr('admin.contests.frozenSince', { time: clockOf(at, zone) }), tone: 'brand', dot: false }
  }
  if (phase === 'over' && c.upsolving) return { text: tr('admin.contests.upsolvingOpen'), tone: 'accent', dot: true }
  return null
}

/** The «ОКНО» column: when, and what that means now. */
export interface WindowLine {
  when: string
  note: string | null
  /** The contest has no dates at all: the line is said muted. */
  empty: boolean
}

/**
 * «сегодня, 12:30–15:30» / «осталось 52 мин»; «6.11, 12:30–15:30» / «через 6
 * дней»; «22.10 – 29.10, 23:59» / «вчера». The day is dropped for today, the
 * second date for a contest that ends on the day it starts.
 */
export function windowLine(c: Pick<Contest, 'state' | 'startsAt' | 'endsAt'>, now: number, zone: string | null = null): WindowLine {
  if (c.startsAt === null && c.endsAt === null) return { when: tr('admin.contests.window.none'), note: null, empty: true }
  const day = (at: number) => (sameDay(at, now, zone) ? tr('admin.contests.window.today') : dateOf(at, zone))
  let when: string
  if (c.startsAt !== null && c.endsAt !== null) {
    when = sameDay(c.startsAt, c.endsAt, zone)
      ? `${day(c.startsAt)}, ${clockOf(c.startsAt, zone)}–${clockOf(c.endsAt, zone)}`
      : `${day(c.startsAt)} – ${day(c.endsAt)}, ${clockOf(c.endsAt, zone)}`
  } else if (c.startsAt !== null) {
    when = tr('admin.contests.window.from', { when: `${day(c.startsAt)}, ${clockOf(c.startsAt, zone)}` })
  } else {
    when = tr('admin.contests.window.until', { when: `${day(c.endsAt!)}, ${clockOf(c.endsAt!, zone)}` })
  }
  const phase = contestPhase(c, now)
  let note: string | null = null
  if (phase === 'soon' && c.startsAt !== null) note = untilWords(c.startsAt, now, zone)
  else if (phase === 'open') note = c.endsAt === null ? tr('admin.contests.window.noEnd') : tr('admin.contests.window.left', { time: leftWords(c.endsAt - now) })
  else if (phase === 'over' && c.endsAt !== null) note = sinceWords(c.endsAt, now, zone)
  return { when, note, empty: false }
}

/**
 * «3,1 из 6» under ICPC (problems solved on average, a tenth), «212 из 400»
 * under IOI (points, whole). `null` — nothing to average yet.
 */
export function averageWords(row: Pick<ContestListRow, 'averageSolved' | 'averageOf' | 'contest'>): string | null {
  if (row.averageSolved === null) return null
  const ioi = row.contest.rules === 'ioi'
  const value = formatNumber(row.averageSolved, ioi ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return tr('admin.contests.averageOf', { value, of: formatNumber(row.averageOf) })
}

/* ------------------------------------------------------------ the judge */

/** The judge strip's phrases (A1): what it does now, how many at once, and on what terms. */
export interface JudgeLine {
  head: string
  /** «до 4 одновременно» — apart, since the owner changes it from there; null — nothing to judge with. */
  slots: string | null
  tail: string
  /** The square before the word: lit while it runs, grey when paused or unable. */
  lit: boolean
}

/**
 * «проверяет 2 посылки · 0 ждут», «до 4 одновременно», «без сети · сегодня
 * проверено 312, в среднем 1,4 с». A server that cannot judge says so
 * instead of counting a queue nothing will empty.
 */
export function judgeLine(judge: JudgeStatus): JudgeLine {
  if (judge.backend === 'none') {
    return { head: tr('admin.contests.judge.none'), slots: null, tail: tr('admin.contests.judge.noneHint'), lit: false }
  }
  const head = [
    judge.paused
      ? tr('admin.contests.judge.paused')
      : judge.running > 0
        ? tr('admin.contests.judge.running', { count: judge.running })
        : tr('admin.contests.judge.idle'),
    tr('admin.contests.judge.waiting', { count: judge.queued }),
  ].join(' · ')
  const today =
    judge.medianMs === null
      ? tr('admin.contests.judge.today', { count: formatNumber(judge.judgedToday) })
      : `${tr('admin.contests.judge.today', { count: formatNumber(judge.judgedToday) })}, ${tr('admin.contests.judge.median', { time: secondsWords(judge.medianMs) })}`
  const tail = [tr('admin.contests.judge.noNetwork'), today, judge.backend === 'test' ? tr('admin.contests.judge.test') : null]
    .filter(Boolean)
    .join(' · ')
  return { head, slots: tr('admin.contests.judge.slots', { count: judge.slots }), tail, lit: !judge.paused }
}

/** The slots field's reading of the saved setting: a number, or «авто (4)». */
export function slotsWords(settings: ContestSettings): string {
  return settings.judgeSlots === null
    ? tr('admin.contests.judge.autoNow', { count: settings.autoSlots })
    : String(settings.judgeSlots)
}

/* ------------------------------------------------------------- numbers */

/** «0,31» — seconds to a hundredth, in the instance's decimal mark. */
export function seconds(ms: number): string {
  return formatNumber(ms / 1000, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** «0,31 с», «1,4 с», «12 с»: a duration a person reads, not a column. */
export function secondsWords(ms: number): string {
  const value = ms / 1000
  const digits = value >= 10 ? 0 : value >= 1 ? 1 : 2
  return tr('admin.contests.secondsUnit', { value: formatNumber(value, { maximumFractionDigits: digits }) })
}

/** A time limit as the teacher typed it: «1», «1,5», «0,25» (seconds, no padding). */
export function limitSeconds(ms: number): string {
  return formatNumber(ms / 1000, { maximumFractionDigits: 2 })
}

/** «38 МБ», «9 МБ», «512 КБ»: a program's peak memory. */
export function memoryWords(kb: number | null): string {
  if (kb === null || !Number.isFinite(kb)) return '—'
  if (kb < 1024) return tr('admin.contests.kb', { value: formatNumber(Math.max(0, Math.round(kb))) })
  const mb = kb / 1024
  return tr('admin.contests.mb', { value: formatNumber(mb, { maximumFractionDigits: mb < 10 ? 1 : 0 }) })
}

/** «1 с · 256 МБ» — the problem table's limits. */
export function limitsLine(problem: Pick<ProblemView, 'timeLimitMs' | 'memoryMb'>): string {
  return tr('admin.contests.limitsLine', { time: limitSeconds(problem.timeLimitMs), memory: formatNumber(problem.memoryMb) })
}

/** «14 · 2 прим.» — tests and how many of them are examples. */
export function testsLine(problem: Pick<ProblemView, 'tests'>): string {
  const samples = problem.tests.filter((test) => test.sample).length
  return samples > 0
    ? tr('admin.contests.testsLine', { count: problem.tests.length, samples })
    : String(problem.tests.length)
}

/**
 * How long a contest lasts: «3 ч», «1 ч 30 мин», «2 дн 3 ч». `null` — one of
 * the ends is missing or they are the wrong way round (the form says so).
 */
export function durationWords(startsAt: number | null, endsAt: number | null): string | null {
  if (startsAt === null || endsAt === null || endsAt <= startsAt) return null
  const minutes = Math.round((endsAt - startsAt) / MINUTE)
  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor((minutes % (24 * 60)) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? tr('admin.contests.span.dh', { d: days, h: hours }) : tr('admin.contests.span.d', { d: days })
  if (hours > 0) return rest > 0 ? tr('admin.contests.span.hm', { h: hours, m: rest }) : tr('admin.contests.span.h', { h: hours })
  return tr('admin.contests.span.m', { m: rest })
}

/** «00:52:40» — the console's countdown; hours grow past two digits rather than wrap. */
export function countdown(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}`
}

/** «52 мин», «6 дн 4 ч», «40 с» — two units, never three. */
export function leftWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return tr('admin.contests.span.m', { m: 0 })
  if (ms >= DAY) {
    const d = Math.floor(ms / DAY)
    const h = Math.floor((ms % DAY) / HOUR)
    return h > 0 ? tr('admin.contests.span.dh', { d, h }) : tr('admin.contests.span.d', { d })
  }
  if (ms >= HOUR) {
    const h = Math.floor(ms / HOUR)
    const m = Math.floor((ms % HOUR) / MINUTE)
    return m > 0 ? tr('admin.contests.span.hm', { h, m }) : tr('admin.contests.span.h', { h })
  }
  if (ms >= MINUTE) return tr('admin.contests.span.m', { m: Math.floor(ms / MINUTE) })
  return tr('admin.contests.span.s', { s: Math.max(1, Math.round(ms / 1000)) })
}

/**
 * Calendar days from the day of `from` to the day of `to`, on the zone's
 * clock: a class at 9:00 tomorrow is «завтра» at 23:00 tonight, though only
 * ten hours away, and a contest that ended at 23:59 is «вчера» at noon.
 */
function calendarDays(from: number, to: number, zone: string | null): number {
  const a = wallOf(from, zone)
  const b = wallOf(to, zone)
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY)
}

/** «через 12 мин», «завтра», «через 6 дней» — until a contest starts. */
export function untilWords(at: number, now: number, zone: string | null = null): string {
  const days = calendarDays(now, at, zone)
  if (days <= 0) return tr('admin.contests.window.in', { time: leftWords(at - now) })
  if (days === 1) return tr('admin.contests.window.tomorrow')
  return tr('admin.contests.window.inDays', { count: days })
}

/** «только что», «40 мин назад», «вчера», «3 дня назад» — since a contest ended. */
export function sinceWords(at: number, now: number, zone: string | null = null): string {
  const ms = Math.max(0, now - at)
  if (ms < MINUTE) return tr('admin.contests.since.now')
  if (ms < HOUR) return tr('admin.contests.since.m', { count: Math.floor(ms / MINUTE) })
  const days = calendarDays(at, now, zone)
  if (days <= 0) return tr('admin.contests.since.h', { count: Math.floor(ms / HOUR) })
  if (days === 1) return tr('admin.contests.since.yesterday')
  return tr('admin.contests.since.d', { count: days })
}

/* ------------------------------------------------------------ the clock */

/**
 * The instance's time zone, when the server names one.
 *
 * The contract has no field for it yet (reported to the server's side): until
 * then the answer is null and every date here is in the reader's own zone, as
 * the competitions' editor has always worked. A name the runtime does not
 * know is not trusted either — a date shifted by a zone nobody can resolve is
 * worse than the reader's own.
 */
export function instanceZone(view: unknown): string | null {
  const zone = (view as { timeZone?: unknown } | null)?.timeZone
  return typeof zone === 'string' && isTimeZone(zone) ? zone : null
}

interface Wall {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const wallFormats = new Map<string, Intl.DateTimeFormat>()

/** What a clock in `zone` (the reader's when null) shows at the moment `at`. */
function wallOf(at: number, zone: string | null): Wall {
  if (zone === null) {
    const date = new Date(at)
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() }
  }
  let format = wallFormats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
    wallFormats.set(zone, format)
  }
  const wall: Wall = { year: 0, month: 0, day: 0, hour: 0, minute: 0 }
  for (const part of format.formatToParts(at)) {
    if (part.type in wall) wall[part.type as keyof Wall] = Number(part.value)
  }
  wall.hour %= 24
  return wall
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** «14:36» in the zone the contest is held in. */
export function clockOf(at: number, zone: string | null = null): string {
  const wall = wallOf(at, zone)
  return `${pad2(wall.hour)}:${pad2(wall.minute)}`
}

/**
 * «6.11» — a day without the year, as A1 writes it. Not Intl's numeric form,
 * which pads the Russian day to «06.11»; English reads «Nov 6».
 */
export function dateOf(at: number, zone: string | null = null): string {
  const wall = wallOf(at, zone)
  if (getLocale() === 'ru') return `${wall.day}.${pad2(wall.month)}`
  return formatDate(Date.UTC(wall.year, wall.month - 1, wall.day, 12), { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function sameDay(a: number, b: number, zone: string | null): boolean {
  const one = wallOf(a, zone)
  const two = wallOf(b, zone)
  return one.year === two.year && one.month === two.month && one.day === two.day
}

/** «14:36» today, «29.10, 14:36» on another day: a moment in a feed or a note. */
export function momentOf(at: number, now: number, zone: string | null = null): string {
  return sameDay(at, now, zone) ? clockOf(at, zone) : `${dateOf(at, zone)}, ${clockOf(at, zone)}`
}

/**
 * A moment as `datetime-local` understands it, on the clock of `zone`.
 *
 * Not through ISO: «30.10 12:30» is typed while looking at the class
 * timetable, and the field must show what the timetable says, not UTC.
 */
export function zonedInput(at: number | null, zone: string | null = null): string {
  if (at === null || !Number.isFinite(at)) return ''
  const wall = wallOf(at, zone)
  return `${String(wall.year).padStart(4, '0')}-${pad2(wall.month)}-${pad2(wall.day)}T${pad2(wall.hour)}:${pad2(wall.minute)}`
}

/**
 * The moment a `datetime-local` value names on the clock of `zone`; null for
 * an empty or broken value.
 *
 * The zone's offset at that moment is not known until the moment is: the
 * offset of the wall time read as UTC is tried first, and the offset at that
 * guess second — they differ only when the clocks moved in between (a summer
 * time change), and the second answer is the one on the far side of it.
 */
export function fromZonedInput(value: string, zone: string | null = null): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const [year, month, day, hour, minute] = match.slice(1).map(Number)
  if (zone === null) {
    const at = new Date(year, month - 1, day, hour, minute).getTime()
    return Number.isFinite(at) ? at : null
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, minute)
  if (!Number.isFinite(asUtc)) return null
  const offset = (at: number) => {
    const wall = wallOf(at, zone)
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - Math.floor(at / MINUTE) * MINUTE
  }
  const first = asUtc - offset(asUtc)
  return asUtc - offset(first)
}

/** «MSK», «GMT+3» — the zone's short name beside the date fields; null when the runtime cannot say. */
export function zoneName(at: number, zone: string | null, locale: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone: zone ?? undefined, timeZoneName: 'short' }).formatToParts(at)
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? null
  } catch {
    return null
  }
}

/**
 * The new end after «Продлить»: from the current end, or from now when the
 * end has already passed — fifteen minutes added to a deadline an hour ago
 * would extend nothing.
 */
export function extendedEnd(endsAt: number | null, now: number, minutes: number): number {
  const base = endsAt === null || endsAt < now ? now : endsAt
  return base + minutes * MINUTE
}

/** The freeze as the console's header says it; null — no freeze to speak of. */
export function freezeNote(
  c: Pick<Contest, 'freezeMinutes' | 'endsAt' | 'unfrozenAt'>,
  phase: ContestPhase,
  now: number,
  zone: string | null = null,
): { text: string; frozen: boolean } | null {
  const at = freezeAt(c)
  if (at === null) return null
  if (boardRevealed(c)) return { text: tr('admin.contests.freeze.revealed'), frozen: false }
  if (boardFrozen(c, now)) {
    return {
      text: tr(phase === 'over' ? 'admin.contests.freeze.over' : 'admin.contests.freeze.now', { time: clockOf(at, zone) }),
      frozen: true,
    }
  }
  return phase === 'open' || phase === 'soon' ? { text: tr('admin.contests.freeze.at', { time: clockOf(at, zone) }), frozen: false } : null
}

/* ------------------------------------------------------------ addresses */

/** Why a typed address will not do, in the panel's words; null — it will. */
export function contestSlugRefusal(raw: string): string | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return tr('admin.contests.slug.empty')
  if (RESERVED_CONTEST_SLUGS.includes(value)) return tr('admin.contests.slug.reserved')
  return parseContestSlug(value) === null ? tr('admin.contests.slug.chars') : null
}

/** The address a title suggests: the product's one transliteration (shared/publish.ts · suggestSlug). */
export function contestSlugFor(title: string): string {
  return suggestSlug(title)
}

/* ------------------------------------------------------------ problems */

/** The reference's state as a problem row says it (A2): a dot, a word, a detail. */
export interface ReferenceLook {
  tone: 'positive' | 'danger' | 'warning' | 'accent'
  word: string
  detail: string
}

export function referenceLook(problem: Pick<ProblemView, 'reference' | 'referenceLanguage'>): ReferenceLook {
  const ref = problem.reference
  const language = languageShort(problem.referenceLanguage)
  switch (ref.state) {
    case 'missing':
      return { tone: 'warning', word: tr('admin.contests.ref.missing'), detail: '' }
    case 'unchecked':
      return { tone: 'warning', word: tr('admin.contests.ref.unchecked'), detail: language }
    case 'queued':
      return { tone: 'accent', word: tr('admin.contests.ref.queued'), detail: language }
    case 'running':
      return { tone: 'accent', word: tr('admin.contests.ref.running'), detail: language }
    case 'passes':
      return {
        tone: 'positive',
        word: tr('admin.contests.ref.passes'),
        detail: ref.timeMs === null ? language : `${secondsWords(ref.timeMs)} · ${language}`,
      }
    default:
      return { tone: 'danger', word: referenceFailure(ref), detail: language }
  }
}

/** «TL на тесте 27», «ошибка компиляции» — how a reference failed. */
export function referenceFailure(ref: Pick<ReferenceStatus, 'verdict' | 'failedTest'>): string {
  if (ref.verdict === null) return tr('admin.contests.ref.fails')
  if (ref.failedTest !== null) return tr('admin.contests.ref.failsOn', { verdict: ref.verdict, test: ref.failedTest })
  return verdictWords(ref.verdict).toLowerCase()
}

/** The header badge of the problem editor (A3): «ЭТАЛОН ПРОХОДИТ» and its kin. */
export function referenceBadge(ref: Pick<ReferenceStatus, 'state'>): { word: string; tone: 'positive' | 'danger' | 'warning' | 'accent' } {
  switch (ref.state) {
    case 'passes':
      return { word: tr('admin.contests.refBadge.passes'), tone: 'positive' }
    case 'fails':
      return { word: tr('admin.contests.refBadge.fails'), tone: 'danger' }
    case 'queued':
    case 'running':
      return { word: tr('admin.contests.refBadge.running'), tone: 'accent' }
    case 'missing':
      return { word: tr('admin.contests.refBadge.missing'), tone: 'warning' }
    default:
      return { word: tr('admin.contests.refBadge.unchecked'), tone: 'warning' }
  }
}

/**
 * «самый долгий тест эталона — 0,31 с, втрое меньше предела» (A3): how much
 * room the reference leaves under the time limit. A Python solution of the
 * right complexity runs several times slower than C++, so a reference in C++
 * at half the limit is a problem only C++ can pass — said in amber.
 */
export function marginWords(
  ref: Pick<ReferenceStatus, 'state' | 'timeMs'>,
  timeLimitMs: number,
): { text: string; tone: 'ink' | 'warning' | 'danger' | 'muted' } {
  if (ref.timeMs === null || (ref.state !== 'passes' && ref.state !== 'fails')) {
    return { text: tr('admin.contests.margin.none'), tone: 'muted' }
  }
  const time = secondsWords(ref.timeMs)
  if (ref.timeMs > timeLimitMs) return { text: tr('admin.contests.margin.text', { time, ratio: tr('admin.contests.margin.over') }), tone: 'danger' }
  const times = ref.timeMs > 0 ? Math.floor(timeLimitMs / ref.timeMs) : Infinity
  if (times < 2) return { text: tr('admin.contests.margin.text', { time, ratio: tr('admin.contests.margin.tight') }), tone: 'warning' }
  const ratio =
    times === 2
      ? tr('admin.contests.margin.half')
      : times === 3
        ? tr('admin.contests.margin.third')
        : tr('admin.contests.margin.times', { count: Number.isFinite(times) ? times : 100 })
  return { text: tr('admin.contests.margin.text', { time, ratio }), tone: times < 3 ? 'warning' : 'ink' }
}

/** `1e-6`, `0.001` — an epsilon as a person writes it: a power of ten past three zeros as one. */
export function epsilonWords(epsilon: number): string {
  if (!Number.isFinite(epsilon) || epsilon <= 0) return '0'
  const exponent = Math.log10(epsilon)
  if (Number.isInteger(exponent) && exponent <= -4) return `1e${exponent}`
  return String(Number(epsilon.toPrecision(3)))
}

/** A test's data in one line of a table: newlines as ⏎, cut at `limit` characters. */
export function dataPreview(text: string | undefined | null, limit = 36): string | null {
  if (text === undefined || text === null) return null
  const flat = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/\n/g, ' ⏎ ').replace(/[ \t]+/g, ' ')
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat
}

/**
 * The first tests of a problem, the way the reference saw them: by ordinal,
 * what the reference's report says of each (verdict, time, the input and
 * answer snippets staff are sent). The report of the last reference run is
 * the panel's only source of the data's first bytes (reported: the tests
 * list itself carries sizes only).
 */
export function reportByTest(tests: readonly TestReport[] | null | undefined): Map<number, TestReport> {
  return new Map((tests ?? []).map((test) => [test.ordinal, test]))
}

/** «OK · 0,02» — a test's line in the reference column. */
export function testResultWords(report: Pick<TestReport, 'verdict' | 'timeMs'> | undefined): string | null {
  if (!report) return null
  if (report.verdict === 'skipped') return tr('admin.contests.test.skipped')
  return report.timeMs === null ? report.verdict : `${report.verdict} · ${seconds(report.timeMs)}`
}

/**
 * The tests a submission never reached: «Тесты 5–31 не запускались». ICPC
 * stops at the first failure, and an IOI group stops at its own; the report
 * names them `skipped`, or simply ends before `total`.
 */
export function notRunRange(tests: readonly Pick<TestReport, 'ordinal' | 'verdict'>[], total: number | null): string | null {
  const ran = new Set(tests.filter((test) => test.verdict !== 'skipped').map((test) => test.ordinal))
  const last = Math.max(total ?? 0, ...tests.map((test) => test.ordinal), 0)
  const missing: number[] = []
  for (let n = 1; n <= last; n++) if (!ran.has(n)) missing.push(n)
  if (missing.length === 0) return null
  // One range when they are consecutive (the usual ICPC tail); a list otherwise.
  const consecutive = missing.every((n, i) => i === 0 || n === missing[i - 1] + 1)
  if (missing.length === 1) return tr('admin.contests.drawer.notRunOne', { test: missing[0] })
  if (consecutive) return tr('admin.contests.drawer.notRun', { from: missing[0], to: missing[missing.length - 1] })
  return tr('admin.contests.drawer.notRunList', { tests: missing.length > 8 ? `${missing.slice(0, 8).join(', ')}…` : missing.join(', ') })
}

/** The test a failure is explained by: the first one run that is not OK. */
export function failedReport<T extends Pick<TestReport, 'ordinal' | 'verdict'>>(tests: readonly T[]): T | null {
  return [...tests].sort((a, b) => a.ordinal - b.ordinal).find((test) => test.verdict !== 'OK' && test.verdict !== 'skipped') ?? null
}

/* ----------------------------------------------------------- verdicts */

/** How a verdict badge is drawn (A4): the accepted one filled, the others pale, the pending one framed. */
export function verdictBadge(verdict: Verdict | null, state: JudgeState): {
  word: string
  tone: 'positive' | 'danger' | 'warning' | 'neutral' | 'accent'
  form: 'strong' | 'filled' | 'outline'
} {
  const tone = verdictTone(verdict, state)
  if (!judged(state) || verdict === null) return { word: '…', tone: 'accent', form: 'outline' }
  return { word: verdict, tone, form: tone === 'positive' ? 'strong' : 'filled' }
}

/**
 * The drawer's verdict line: «Неправильный ответ на тесте 4 из 31»,
 * «Принято · 31 тест», «Проверяется · тест 7 из 31».
 */
export function verdictLine(s: {
  state: JudgeState
  verdict: Verdict | null
  failedTest: number | null
  total: number | null
  progress: number | null
  score: number | null
}, maxScore: number | null = null): string {
  if (s.state === 'queued') return tr('admin.contests.drawer.queued')
  if (s.state === 'running') {
    return s.total !== null && s.progress !== null
      ? tr('admin.contests.drawer.running', { test: Math.min(s.total, s.progress + 1), total: s.total })
      : tr('admin.contests.drawer.runningPlain')
  }
  if (s.verdict === null) return tr('admin.contests.drawer.queued')
  const words = verdictWords(s.verdict)
  const score = s.score !== null && maxScore !== null ? ` · ${tr('admin.contests.drawer.score', { score: formatNumber(s.score), max: formatNumber(maxScore) })}` : ''
  if (s.verdict === 'OK') {
    return s.total !== null ? `${words} · ${tr('admin.contests.drawer.testsCount', { count: s.total })}${score}` : `${words}${score}`
  }
  if (s.failedTest !== null) {
    return s.total !== null
      ? `${tr('admin.contests.drawer.failedOf', { words, test: s.failedTest, total: s.total })}${score}`
      : `${tr('admin.contests.drawer.failedOn', { words, test: s.failedTest })}${score}`
  }
  return `${words}${score}`
}

/* ----------------------------------------------------------- questions */

/**
 * The questions as the console lists them: the unanswered first, oldest
 * first (whoever asked first has waited longest), then everything answered
 * and every announcement, newest first.
 */
export function sortQuestions<T extends Pick<AdminQuestion, 'answer' | 'askedAt' | 'answeredAt' | 'question'>>(questions: readonly T[]): T[] {
  const waiting = questions.filter((one) => waitsForAnswer(one)).sort((a, b) => a.askedAt - b.askedAt)
  const done = questions
    .filter((one) => !waitsForAnswer(one))
    .sort((a, b) => (b.answeredAt ?? b.askedAt) - (a.answeredAt ?? a.askedAt))
  return [...waiting, ...done]
}

/** A question nobody has answered yet; an announcement is never one. */
export function waitsForAnswer(one: Pick<AdminQuestion, 'answer' | 'question'>): boolean {
  return one.question.trim() !== '' && (one.answer === null || one.answer.trim() === '')
}

/* ----------------------------------------------------------- the console */

/** The console's tabs, in the order A4 draws them; each is an address. */
export type ContestTab = 'submissions' | 'board' | 'questions' | 'problems' | 'entrants' | 'settings'

export const CONTEST_TABS: readonly ContestTab[] = ['submissions', 'board', 'questions', 'problems', 'entrants', 'settings']

/** `/admin/contests/<id>[/tab]` — the submissions tab is the bare address. */
export function contestTabPath(id: string, tab: ContestTab): string {
  return `/admin/contests/${encodeURIComponent(id)}${tab === 'submissions' ? '' : `/${tab}`}`
}

/** `/admin/contests/<id>/problems/<pid>` — the problem editor (A3). */
export function problemPath(id: string, problemId: string): string {
  return `/admin/contests/${encodeURIComponent(id)}/problems/${encodeURIComponent(problemId)}`
}

/**
 * Where «← к контесту» leads from a problem: a draft's editor, or a live
 * contest's «Задачи» tab — the list the teacher came from.
 */
export function backFromProblem(c: Pick<Contest, 'id' | 'state'>): string {
  return c.state === 'draft' ? contestTabPath(c.id, 'submissions') : contestTabPath(c.id, 'problems')
}

/**
 * The address's tail, read back: the console tab, and the problem it names.
 * Anything else — a typo, a tab of another screen — is the submissions tab.
 */
export function readContestRoute(path: string): { id: string; tab: ContestTab; problem: string | null } | null {
  const match = /^\/admin\/contests\/([A-Za-z0-9_-]{1,64})(?:\/([a-z]+)(?:\/([A-Za-z0-9_-]{1,64}))?)?\/?$/.exec(path)
  if (!match || match[1] === 'settings' || match[1] === 'judge') return null
  const tab = (CONTEST_TABS as readonly string[]).includes(match[2] ?? '') ? (match[2] as ContestTab) : 'submissions'
  return { id: match[1], tab, problem: tab === 'problems' ? (match[3] ?? null) : null }
}
