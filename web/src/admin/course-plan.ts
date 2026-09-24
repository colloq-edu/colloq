/**
 * "Planned" rows in a course — what the panel does with them.
 *
 * A plan could only be set up with a script from the spreadsheet
 * (scripts/course-from-sheet.mts) or with an API request: the course screen
 * showed the plan rows and could remove and reorder them, but could neither
 * add a new one, nor fix a typo in a topic, nor put a class that has taken
 * place in its spot. That last one is the whole life of such a row ("a plan
 * row is replaced by a seminar"), and without it the class landed at the end
 * of the course and was dragged with the arrows across the whole semester.
 *
 * Kept apart from the screen, like panel.ts, and for the same reason: these
 * are decisions about which row ends up at which position, and a mistake in
 * them only shows on the course page that the whole cohort has already
 * opened.
 */
import {
  MAX_COURSE_NAME,
  MAX_PLANNED_WHEN,
  type CourseItem,
  type CourseItemPlanned,
} from '@shared/publish'

/**
 * A plan row from what was typed — or nothing if there is no topic.
 *
 * The trimming is the same as the server's (routes/courses.ts · str):
 * trimming our own way would mean showing something other than what was
 * typed after saving.
 */
export function plannedRow(name: string, when: string): CourseItemPlanned | null {
  const topic = name.trim().slice(0, MAX_COURSE_NAME)
  if (!topic) return null
  return { kind: 'planned', name: topic, when: when.trim().slice(0, MAX_PLANNED_WHEN) }
}

/** The row being edited: it looked like this and stood right here. */
export interface PlannedTarget {
  at: number
  was: CourseItemPlanned
}

/**
 * Whether this is still the same row.
 *
 * The edit holds the row's index, and an index is not a name: while the field
 * is open the course may have been reordered (the arrows, a 409 carrying
 * someone else's reordering), and the same spot now holds a different week.
 * Writing the edit by index would rename SOMEONE ELSE'S topic — silently, and
 * on a page the whole cohort reads.
 */
function stillThere(items: CourseItem[], target: PlannedTarget): boolean {
  const now = items[target.at]
  return now?.kind === 'planned' && now.name === target.was.name && now.when === target.was.when
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
  target: PlannedTarget | null,
): CourseItem[] | null {
  if (!target) return [...items, row]
  if (!stillThere(items, target)) return null
  return items.map((item, i) => (i === target.at ? row : item))
}

/**
 * A class in place of a plan row — the position in the schedule stays.
 *
 * The row's topic goes with it: the class has its own name, and the course
 * page shows that. A class that is already in the course is not placed a
 * second time — two rows for the same room on the course page read as two
 * different weeks.
 */
export function seatSeminar(
  items: CourseItem[],
  target: PlannedTarget,
  seminar: { id: string; name: string },
): CourseItem[] | null {
  if (!stillThere(items, target)) return null
  if (items.some((item) => item.kind === 'seminar' && item.sessionId === seminar.id)) return null
  return items.map(
    (item, i): CourseItem =>
      i === target.at
        ? { kind: 'seminar', sessionId: seminar.id, name: seminar.name, publication: null }
        : item,
  )
}

/**
 * How many rows are in which state.
 *
 * The course list counted only classes — "2 published · 1 not yet" — and a
 * course with a plan for the whole semester looked there like a course of
 * three rows.
 */
export function courseTally(items: CourseItem[]): {
  published: number
  waiting: number
  planned: number
} {
  let published = 0
  let waiting = 0
  let planned = 0
  for (const item of items) {
    if (item.kind === 'planned') planned += 1
    else if (item.kind === 'seminar') {
      if (item.publication) published += 1
      else waiting += 1
    }
  }
  return { published, waiting, planned }
}
