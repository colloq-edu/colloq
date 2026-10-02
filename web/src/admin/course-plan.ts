/**
 * Course rows: what the panel does with them.
 *
 * A plan could only be set up with a script from the spreadsheet
 * (scripts/course-from-sheet.mts) or with an API request: the course screen
 * showed the plan rows and could remove and reorder them, but could neither
 * add a new one, nor fix a typo in a topic, nor put a class that has taken
 * place in its spot. That last one is the whole life of such a row ("a plan
 * row is replaced by a seminar"), and without it the class landed at the end
 * of the course and was dragged with the arrows across the whole semester.
 *
 * Now every row also carries its class day, a student title and an «о чём»
 * line, and the row is where the teacher sees whether the class left a page.
 *
 * Kept apart from the screen, like panel.ts, and for the same reason: these
 * are decisions about which row ends up at which position, and a mistake in
 * them only shows on the course page that the whole cohort has already
 * opened.
 */
import { addDays, daysBetween, isClassDay } from '@shared/class-day'
import {
  MAX_CLASS_ABOUT,
  MAX_COURSE_NAME,
  MAX_PLANNED_WHEN,
  studentTitle,
  type Course,
  type CourseItem,
  type CourseItemPlanned,
  type CourseItemSeminar,
} from '@shared/publish'
import { LIMITS, type AdminSeminar } from '@shared/admin'

/** The optional fields of a plan row form. */
export interface PlanFields {
  day?: string
  about?: string
  pause?: boolean
}

/**
 * A plan row from what was typed — or nothing if there is no topic.
 *
 * The trimming is the same as the server's (routes/courses.ts · str):
 * trimming our own way would mean showing something other than what was
 * typed after saving. A day that is not a real calendar date is left out
 * rather than sent: the server would refuse the whole list over it.
 */
export function plannedRow(
  name: string,
  when: string,
  fields: PlanFields = {},
): CourseItemPlanned | null {
  const topic = name.trim().slice(0, MAX_COURSE_NAME)
  if (!topic) return null
  const row: CourseItemPlanned = {
    kind: 'planned',
    name: topic,
    when: when.trim().slice(0, MAX_PLANNED_WHEN),
  }
  const day = fields.day?.trim()
  if (day && isClassDay(day)) row.day = day
  const about = fields.about?.trim().slice(0, MAX_CLASS_ABOUT)
  if (about) row.about = about
  if (fields.pause) row.pause = true
  return row
}

/**
 * The day a new plan row starts with: a week after the last dated row.
 *
 * A course meets on the same weekday, so the next topic is almost always
 * seven days later; typing thirty dates by hand is how a semester ends up
 * with a Saturday in it. Empty when no row has a day yet.
 */
export function nextPlanDay(items: readonly CourseItem[], at = items.length): string {
  for (let i = Math.min(at, items.length) - 1; i >= 0; i--) {
    const day = items[i].day
    if (isClassDay(day)) return addDays(day, 7)
  }
  return ''
}

/** The row being edited: it looked like this and stood right here. */
export interface RowTarget<T extends CourseItem = CourseItem> {
  at: number
  was: T
}

export type PlannedTarget = RowTarget<CourseItemPlanned>

/**
 * Whether this is still the same row.
 *
 * The edit holds the row's index, and an index is not a name: while the field
 * is open the course may have been reordered (the arrows, a 409 carrying
 * someone else's reordering), and the same spot now holds a different week.
 * Writing the edit by index would rename SOMEONE ELSE'S topic — silently, and
 * on a page the whole cohort reads. The id settles it when both sides have
 * one; the row's own key (topic and week, room, tombstone) covers rows an
 * older writer left without one, and a topic someone else renamed meanwhile.
 */
function stillThere(items: readonly CourseItem[], target: RowTarget): boolean {
  const now = items[target.at]
  const was = target.was
  if (!now || now.kind !== was.kind) return false
  if (now.id && was.id && now.id !== was.id) return false
  if (now.kind === 'planned' && was.kind === 'planned') {
    return now.name === was.name && now.when === was.when
  }
  if (now.kind === 'seminar' && was.kind === 'seminar') return now.sessionId === was.sessionId
  if (now.kind === 'gone' && was.kind === 'gone') return now.name === was.name && now.at === was.at
  return false
}

/**
 * The contents after a plan row is added or edited.
 *
 * A new one goes to the end: a plan is entered in week order, and the end of
 * the list is the next week. `null` — the edited row is no longer in that
 * spot.
 */
export function putPlanned(
  items: CourseItem[],
  row: CourseItemPlanned,
  target: RowTarget | null,
): CourseItem[] | null {
  if (!target) return [...items, row]
  return putRow(items, target, row)
}

/**
 * Any row replaced in its own place, keeping the id it was stored under.
 *
 * The id is what the server matches the row by (routes/courses.ts · PUT
 * items): a row sent without it would look new and lose the fields this
 * form does not show.
 */
export function putRow(
  items: CourseItem[],
  target: RowTarget,
  row: CourseItem,
): CourseItem[] | null {
  if (!stillThere(items, target)) return null
  const id = target.was.id
  return items.map((item, i) => (i === target.at ? (id ? { ...row, id } : row) : item))
}

/** What the row form holds, as typed. */
export interface RowDraft {
  /** The topic of a plan row; the student title of any other. */
  title: string
  /** 'YYYY-MM-DD', or '' for none. */
  day: string
  about: string
  pause: boolean
}

export function draftOf(item: CourseItem): RowDraft {
  return {
    title: studentTitle(item),
    day: isClassDay(item.day) ? item.day : '',
    about: item.about ?? '',
    pause: item.kind === 'planned' && item.pause === true,
  }
}

/**
 * A row with the form's fields written in, or `null` for a plan row left
 * without a topic.
 *
 * A plan row's title IS its topic: the form edits the name and drops a
 * separate title, so the two can never disagree. On a room's row a title the
 * same as the room's name is not stored: «titles are never frozen», and a
 * room renamed later must keep showing under its new name. Empty fields go
 * out as `null`, which the server reads as "clear it" — leaving them out
 * would keep the old value. The same goes for «Перерыв»: an unticked box is
 * an explicit `pause: false`, or the row would stay a break.
 */
export function applyDraft(item: CourseItem, draft: RowDraft): CourseItem | null {
  const title = draft.title.trim().slice(0, MAX_COURSE_NAME)
  const day = isClassDay(draft.day) ? draft.day : null
  const about = draft.about.trim().slice(0, MAX_CLASS_ABOUT) || null
  if (item.kind === 'planned') {
    if (!title) return null
    const { pause: _pause, title: _title, ...rest } = item
    return {
      ...rest,
      name: title,
      ...(item.title != null ? { title: null } : {}),
      day,
      about,
      // Always sent, false included: a row without the key keeps its stored pause on the server.
      pause: draft.pause,
    }
  }
  return { ...item, title: title && title !== item.name ? title : null, day, about }
}

/**
 * A class in place of a plan row — the position in the schedule stays.
 *
 * The row's id, topic, day, «о чём» and week go with it: the topic becomes
 * the class's student title, so the course page keeps the name it promised
 * in September while the room is called «04 · Лики и хаки данных». A class
 * that is already in the course is not placed a second time — two rows for
 * the same room on the course page read as two different weeks.
 */
export function seatSeminar(
  items: CourseItem[],
  target: RowTarget,
  seminar: { id: string; name: string },
): CourseItem[] | null {
  if (!stillThere(items, target)) return null
  const was = target.was
  if (was.kind !== 'planned') return null
  if (items.some((item) => item.kind === 'seminar' && item.sessionId === seminar.id)) return null
  const row: CourseItemSeminar = {
    kind: 'seminar',
    ...(was.id ? { id: was.id } : {}),
    sessionId: seminar.id,
    name: seminar.name,
    publication: null,
    title: studentTitle(was),
    ...(isClassDay(was.day) ? { day: was.day } : {}),
    ...(was.about ? { about: was.about } : {}),
    ...(was.when ? { when: was.when } : {}),
  }
  return items.map((item, i): CourseItem => (i === target.at ? row : item))
}

/**
 * Seat a room that was just created into its course row, once more on a race.
 *
 * The row was chosen on the creation form a minute ago; by now someone may
 * have reordered the course (a 409, retried once against the fresh list) or
 * put another room into that very row ('taken': the room stays, outside the
 * course). The calls are passed in so the decision is testable without a
 * server.
 */
export async function seatCreated(
  rowId: string,
  seminar: { id: string; name: string },
  io: {
    load: () => Promise<Course>
    save: (rev: number, items: CourseItem[]) => Promise<unknown>
    isConflict: (cause: unknown) => boolean
  },
): Promise<'seated' | 'taken'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const course = await io.load()
    const at = course.items.findIndex((item) => item.id === rowId)
    const row = course.items[at]
    if (!row || row.kind !== 'planned' || row.pause) return 'taken'
    const next = seatSeminar(course.items, { at, was: row }, seminar)
    if (!next) return 'taken'
    try {
      await io.save(course.rev, next)
      return 'seated'
    } catch (cause) {
      if (!io.isConflict(cause) || attempt > 0) throw cause
    }
  }
  return 'taken'
}

/**
 * How many rows are in which state: «3 со страницей · 30 по плану».
 *
 * The course list counted only classes — "2 published · 1 not yet" — and a
 * course with a plan for the whole semester looked there like a course of
 * three rows. Breaks are not classes and are not counted at all.
 */
export function courseTally(items: readonly CourseItem[]): {
  pages: number
  rooms: number
  planned: number
} {
  let pages = 0
  let rooms = 0
  let planned = 0
  for (const item of items) {
    if (item.kind === 'planned') {
      if (!item.pause) planned += 1
    } else if (item.publication) pages += 1
    else if (item.kind === 'seminar') rooms += 1
  }
  return { pages, rooms, planned }
}

/**
 * What the «Страница» column says about a row.
 *
 * 'early': a page published before its class day («до занятия»). 'missing':
 * the class is over (its day has passed, or the room was finished) and
 * there is still no page — the one state that asks the teacher to act.
 * 'room': a room before or on its day, nothing published yet.
 */
export type PageState =
  | 'pause'
  | 'plan'
  | 'page'
  | 'early'
  | 'withdrawn'
  | 'missing'
  | 'room'
  | 'gone'

export function pageState(
  item: CourseItem,
  context: { today: string | null; finished?: boolean; withdrawn?: boolean },
): PageState {
  if (item.kind === 'planned') return item.pause ? 'pause' : 'plan'
  const day = isClassDay(item.day) ? item.day : null
  const ahead = day !== null && context.today !== null && day > context.today
  if (item.publication) return ahead ? 'early' : 'page'
  if (item.kind === 'gone') return 'gone'
  if (context.withdrawn) return 'withdrawn'
  const past = day !== null && context.today !== null && day < context.today
  return past || context.finished ? 'missing' : 'room'
}

/** Ordinals among non-pause rows, by index: the «№» column. `null` for a break. */
export function rowNumbers(items: readonly CourseItem[]): (number | null)[] {
  let n = 0
  return items.map((item) => (item.kind === 'planned' && item.pause ? null : ++n))
}

/** «04»: the ordinal as the course page prints it. */
export const twoDigits = (n: number): string => String(n).padStart(2, '0')

/**
 * The browser's calendar day for a moment.
 *
 * Only for what the panel has no instance day for: when a room was held
 * (AdminSeminar carries moments, not days). The class days themselves come
 * from the server and are never recomputed here.
 */
export function localDay(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The day a room was held: when it was finished, else when it was made. */
export function roomDay(seminar: Pick<AdminSeminar, 'createdAt' | 'finishedAt'>): string {
  return localDay(seminar.finishedAt ?? seminar.createdAt)
}

/**
 * Rooms to put into a row, nearest to the row's day first.
 *
 * The pickers listed every room by name, archived ones included, and in
 * week twelve the right one was somewhere in a row of thirty buttons named
 * «Семинар». Sorted by the distance between the room's day and the row's,
 * the class held that Sunday comes first and is marked «подходит по дате»
 * (only when it is within a week of the row: the nearest of rooms a month
 * off is not a match). A row without a day keeps the newest rooms first.
 */
export function roomChoices(
  seminars: readonly AdminSeminar[],
  rowDay: string | null,
  taken: ReadonlySet<string>,
): { seminar: AdminSeminar; day: string; fits: boolean }[] {
  const open = seminars
    .filter((s) => !s.archivedAt && !taken.has(s.id))
    .map((seminar) => ({ seminar, day: roomDay(seminar) }))
  const distance = (day: string) => (rowDay ? Math.abs(daysBetween(day, rowDay)) : 0)
  open.sort((a, b) =>
    rowDay
      ? distance(a.day) - distance(b.day) || b.seminar.createdAt - a.seminar.createdAt
      : b.seminar.createdAt - a.seminar.createdAt,
  )
  return open.map((choice, i) => ({
    ...choice,
    fits: rowDay !== null && i === 0 && distance(choice.day) <= 6,
  }))
}

/** One unseated plan row, as the «Занятие курса» select offers it. */
export interface ClassOption {
  courseId: string
  courseName: string
  rowId: string
  n: number
  title: string
  day: string | null
}

/**
 * Every plan row a new room could take, nearest first: today and the days
 * ahead in order, then the days already gone (most recent first: a class
 * held without a room yet is created afterwards), then rows with no day, in
 * course order. Breaks are not classes and are not offered.
 */
export function classOptions(courses: readonly Course[], today: string): ClassOption[] {
  const options: (ClassOption & { order: number })[] = []
  let order = 0
  for (const course of courses) {
    const numbers = rowNumbers(course.items)
    course.items.forEach((item, i) => {
      const n = numbers[i]
      if (item.kind !== 'planned' || n === null || !item.id) return
      options.push({
        courseId: course.id,
        courseName: course.name,
        rowId: item.id,
        n,
        title: studentTitle(item),
        day: isClassDay(item.day) ? item.day : null,
        order: order++,
      })
    })
  }
  const rank = (o: ClassOption & { order: number }): [number, number] => {
    if (o.day === null) return [2, o.order]
    const gap = daysBetween(today, o.day)
    return gap >= 0 ? [0, gap] : [1, -gap]
  }
  return options
    .sort((a, b) => {
      const [ga, va] = rank(a)
      const [gb, vb] = rank(b)
      return ga - gb || va - vb || a.order - b.order
    })
    .map(({ order: _order, ...option }) => option)
}

/**
 * Which row a new room most likely belongs to.
 *
 * The course of the teacher's own most recently created room that sits in a
 * course (anyone's, when they have none), and in it the first unseated row
 * dated today or later; a course whose rows have no days at all offers its
 * first unseated row. `null` — nothing to suggest: «Без курса».
 */
export function defaultClass(
  options: readonly ClassOption[],
  seminars: readonly Pick<AdminSeminar, 'createdAt' | 'createdBy' | 'courses'>[],
  me: string | null,
  today: string,
): ClassOption | null {
  const seated = seminars
    .filter((s) => s.courses.length > 0)
    .sort((a, b) => b.createdAt - a.createdAt)
  const mine = seated.find((s) => me !== null && s.createdBy === me) ?? seated[0]
  const courseId = mine?.courses[0]?.id
  if (!courseId) return null
  const inCourse = options.filter((o) => o.courseId === courseId)
  const ahead = inCourse
    .filter((o) => o.day !== null && o.day >= today)
    .sort((a, b) => (a.day! < b.day! ? -1 : a.day! > b.day! ? 1 : 0))
  if (ahead.length > 0) return ahead[0]
  if (inCourse.every((o) => o.day === null)) return inCourse[0] ?? null
  return null
}

/** «04 · Лики и хаки данных»: the room name a course row suggests, cut to what a room name holds. */
export function roomNameFor(option: Pick<ClassOption, 'n' | 'title'>): string {
  return `${twoDigits(option.n)} · ${option.title}`.slice(0, LIMITS.seminarName)
}
