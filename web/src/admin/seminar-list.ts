/**
 * The «Занятия» list: which folder a room sits in, which tab it counts
 * under, and in which group and order it is drawn.
 *
 * One department could live with a single flat list, newest first. A
 * university cannot: a teacher with three courses and a few rooms outside
 * them looked for this Sunday's class among forty rows, and an owner's
 * «Все» is several hundred. So the list is read the way the teacher thinks
 * about it — by course, then by what is happening now — and every number on
 * the screen (the folder rail, the tabs, the nav row) is counted here, from
 * the same rows, so no two of them can disagree.
 *
 * Kept apart from the screen, like course-plan.ts, and for the same reason:
 * these are decisions about which room ends up where, and a mistake in them
 * only shows as a class missing from the list on the morning it is needed.
 * Pure: no clock, no locale, no store.
 */
import { isClassDay } from '@shared/class-day'
import type { AdminSeminar } from '@shared/admin'
import type { Course, CourseItem } from '@shared/publish'
import { localDay, rowNumbers } from '@/admin/course-plan'

/**
 * Where the rail points.
 *
 * 'all' — every active room; 'none' — rooms in no course the viewer can see;
 * 'archive' — archived rooms only (it replaced the old «Архив» checkbox:
 * a folder is a place you go to, a checkbox was a filter people forgot
 * was on); `course:<id>` — one course.
 */
export type Folder = 'all' | 'none' | 'archive' | `course:${string}`

/**
 * The tab a room counts under.
 *
 * Not the server's status verbatim. The server knows four states of a room
 * (draft, live, idle, finished); a teacher asks one question — is it on now,
 * is it ahead, or is it behind me — and the course row's day answers it
 * better than the room's own clock: a room set up a week early is ahead, not
 * a draft from the past.
 */
export type Phase = 'running' | 'upcoming' | 'past'
export type StatusTab = 'all' | Phase

/** A room's place in one course: its number in the plan and its class day. */
export interface Seat {
  n: number | null
  day: string | null
}

/** One drawn row: the room, plus what its course says about it. */
export interface ListRow {
  seminar: AdminSeminar
  /** «05»: its ordinal among the course's numbered rows; null outside a course. */
  n: number | null
  /** The day the row is dated by: the course row's day, else the room's own. */
  day: string
  /** Whether `day` came from the course plan (a timetable fact) or the room. */
  planned: boolean
  phase: Phase
}

export interface ListGroup {
  /** `course:<id>` or 'none'; also the {#each} key. */
  key: string
  course: { id: string; name: string } | null
  rows: ListRow[]
}

/* --------------------------------------------------------------- seats */

/**
 * Every seated room's number and day, per course: course id → session id →
 * seat. Built once per list, not per row: each row would otherwise scan
 * every course's items.
 */
export function seatsOf(courses: readonly Pick<Course, 'id' | 'items'>[]): Map<string, Map<string, Seat>> {
  const out = new Map<string, Map<string, Seat>>()
  for (const course of courses) {
    const numbers = rowNumbers(course.items)
    const seats = new Map<string, Seat>()
    course.items.forEach((item: CourseItem, index) => {
      if (item.kind !== 'seminar' || seats.has(item.sessionId)) return
      seats.set(item.sessionId, { n: numbers[index], day: isClassDay(item.day) ? item.day : null })
    })
    out.set(course.id, seats)
  }
  return out
}

/* --------------------------------------------------------------- phase */

/**
 * Which tab a room counts under, given the day it is dated by.
 *
 * Live is live, and a class the teacher ended is behind, whatever the plan
 * says. Between those two the plan's day decides: today or later is ahead,
 * earlier is behind. Without a planned day a room nobody has opened yet is
 * ahead (it was made for a class to come), and one that people came to and
 * left is behind — the old «пусто», which never meant "ended" but did mean
 * "already happened".
 */
export function phaseOf(
  seminar: Pick<AdminSeminar, 'status'>,
  plannedDay: string | null,
  today: string,
): Phase {
  if (seminar.status === 'live') return 'running'
  if (seminar.status === 'finished') return 'past'
  if (plannedDay) return plannedDay >= today ? 'upcoming' : 'past'
  return seminar.status === 'draft' ? 'upcoming' : 'past'
}

/** The room's own day: when it was finished, else when it was made. */
const ownDay = (seminar: Pick<AdminSeminar, 'createdAt' | 'finishedAt'>): string =>
  localDay(seminar.finishedAt ?? seminar.createdAt)

/** A drawn row for a room seen through one course (or none). */
export function rowOf(seminar: AdminSeminar, seat: Seat | null, today: string): ListRow {
  const planned = seat?.day ?? null
  return {
    seminar,
    n: seat?.n ?? null,
    day: planned ?? ownDay(seminar),
    planned: planned !== null,
    phase: phaseOf(seminar, planned, today),
  }
}

/**
 * The phase a room counts under for the tabs: through its first course
 * with a planned day, so a room in two courses is one room in one tab.
 */
export function phaseForTabs(
  seminar: AdminSeminar,
  seats: Map<string, Map<string, Seat>>,
  today: string,
): Phase {
  for (const course of seminar.courses) {
    const seat = seats.get(course.id)?.get(seminar.id)
    if (seat?.day) return phaseOf(seminar, seat.day, today)
  }
  return phaseOf(seminar, null, today)
}

/* ------------------------------------------------------------- folders */

/** Whether a room belongs in a folder. Archived rooms live only in 'archive'. */
export function inFolder(seminar: Pick<AdminSeminar, 'archivedAt' | 'courses'>, folder: Folder): boolean {
  if (folder === 'archive') return seminar.archivedAt !== null
  if (seminar.archivedAt !== null) return false
  if (folder === 'all') return true
  if (folder === 'none') return seminar.courses.length === 0
  const id = folder.slice('course:'.length)
  return seminar.courses.some((course) => course.id === id)
}

export interface FolderCounts {
  all: number
  none: number
  archive: number
  /** Active rooms per course id; a room in two courses counts in both. */
  courses: Map<string, number>
}

/** The rail's numbers: over the whole scoped list, before search and tabs. */
export function folderCounts(seminars: readonly AdminSeminar[]): FolderCounts {
  const counts: FolderCounts = { all: 0, none: 0, archive: 0, courses: new Map() }
  for (const seminar of seminars) {
    if (seminar.archivedAt !== null) {
      counts.archive += 1
      continue
    }
    counts.all += 1
    if (seminar.courses.length === 0) counts.none += 1
    for (const course of seminar.courses) counts.courses.set(course.id, (counts.courses.get(course.id) ?? 0) + 1)
  }
  return counts
}

/**
 * The courses the rail lists, in the order the server gave them, plus any
 * course a room names that the course list did not bring.
 *
 * That happens on an owner's «Мои»: a room the owner teaches through
 * room_teachers can sit in a course the owner does not teach. Leaving it out
 * of the rail would draw a group the rail cannot select.
 */
export function railCourses(
  courses: readonly Pick<Course, 'id' | 'name'>[],
  seminars: readonly Pick<AdminSeminar, 'courses' | 'archivedAt'>[],
): { id: string; name: string }[] {
  const out = courses.map((course) => ({ id: course.id, name: course.name }))
  const known = new Set(out.map((course) => course.id))
  for (const seminar of seminars) {
    if (seminar.archivedAt !== null) continue
    for (const course of seminar.courses) {
      if (known.has(course.id)) continue
      known.add(course.id)
      out.push({ id: course.id, name: course.name })
    }
  }
  return out
}

/* -------------------------------------------------------------- search */

/** Name or address: a teacher reads out «/s/k2mx…» as often as the title. */
export function matches(seminar: Pick<AdminSeminar, 'id' | 'name'>, needle: string): boolean {
  if (!needle) return true
  return seminar.name.toLowerCase().includes(needle) || seminar.id.toLowerCase().includes(needle)
}

/* ---------------------------------------------------------------- tabs */

export type TabCounts = Record<StatusTab, number>

/** The tab numbers: distinct rooms, so a room in two courses is counted once. */
export function tabCounts(
  seminars: readonly AdminSeminar[],
  seats: Map<string, Map<string, Seat>>,
  today: string,
): TabCounts {
  const counts: TabCounts = { all: 0, running: 0, upcoming: 0, past: 0 }
  for (const seminar of seminars) {
    counts.all += 1
    counts[phaseForTabs(seminar, seats, today)] += 1
  }
  return counts
}

/* ------------------------------------------------------------- groups */

const PHASE_ORDER: Record<Phase, number> = { running: 0, upcoming: 1, past: 2 }

/**
 * Inside a group: what is on now, then what is next (nearest first), then
 * what is behind (latest first). Newest-created-first used to be the only
 * order, and in week twelve this Sunday's class sat between two rooms made
 * for a retake in May.
 *
 * Among the rooms ahead, the ones the plan dates come first, by that date;
 * a room with no planned day has only the day it was made, which says
 * nothing about when its class is, so those follow, newest first.
 */
export function compareRows(a: ListRow, b: ListRow): number {
  const phase = PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]
  if (phase !== 0) return phase
  if (a.phase === 'upcoming' && a.planned !== b.planned) return a.planned ? -1 : 1
  if (a.phase === 'upcoming' && !a.planned) return b.seminar.createdAt - a.seminar.createdAt
  if (a.day !== b.day) return a.phase === 'upcoming' ? (a.day < b.day ? -1 : 1) : a.day < b.day ? 1 : -1
  return b.seminar.createdAt - a.seminar.createdAt
}

/**
 * The drawn list: one group per course (in rail order), then «Без курса».
 *
 * A room in two courses is drawn in both groups — it is in both, and its
 * number and day differ between them. `seminars` arrives already filtered
 * by folder, search and tab. A course folder keeps its group even when
 * empty, so «+ Занятие в курс» stays where the teacher is looking; the
 * other folders draw only groups that have rows.
 */
export function groupRows(
  seminars: readonly AdminSeminar[],
  rail: readonly { id: string; name: string }[],
  seats: Map<string, Map<string, Seat>>,
  folder: Folder,
  today: string,
): ListGroup[] {
  const only = folder.startsWith('course:') ? folder.slice('course:'.length) : null
  const groups = new Map<string, ListGroup>()
  for (const course of rail) {
    if (only !== null && course.id !== only) continue
    groups.set(course.id, { key: `course:${course.id}`, course, rows: [] })
  }
  const loose: ListGroup = { key: 'none', course: null, rows: [] }

  for (const seminar of seminars) {
    if (seminar.courses.length === 0) {
      loose.rows.push(rowOf(seminar, null, today))
      continue
    }
    for (const ref of seminar.courses) {
      if (only !== null && ref.id !== only) continue
      let group = groups.get(ref.id)
      if (!group) {
        group = { key: `course:${ref.id}`, course: { id: ref.id, name: ref.name }, rows: [] }
        groups.set(ref.id, group)
      }
      group.rows.push(rowOf(seminar, seats.get(ref.id)?.get(seminar.id) ?? null, today))
    }
  }

  const out: ListGroup[] = []
  for (const group of groups.values()) {
    if (group.rows.length === 0 && only === null) continue
    group.rows.sort(compareRows)
    out.push(group)
  }
  if (loose.rows.length > 0 && only === null) {
    loose.rows.sort(compareRows)
    out.push(loose)
  }
  return out
}

/* --------------------------------------------------------------- scope */

/** The localStorage key for an owner's Мои/Все choice. */
export const SCOPE_KEY = 'colloq.admin.seminars.scope'

/**
 * The remembered scope, defensively: storage can throw (a private window,
 * blocked site data) or hold anything at all, and only an owner may ask for
 * 'all' — a teacher who was once an owner on this browser must not get a 403
 * for a choice they no longer have.
 */
export function readScope(read: () => string | null, owner: boolean): 'mine' | 'all' {
  if (!owner) return 'mine'
  try {
    return read() === 'all' ? 'all' : 'mine'
  } catch {
    return 'mine'
  }
}
