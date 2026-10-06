import { tr } from '@shared/i18n'
/**
 * Putting a just-created room into its course row, on the server.
 *
 * The creation form used to do it from the browser: create the room, then
 * write the whole course list back with the room in the chosen row (a second
 * request, retried once on a race). Two requests meant a room could be created
 * and the seating could still fail, and since 0.19 it would fail for a reason
 * of its own: a teacher may create rooms in a course they teach, but the whole
 * list is written under the course's rules. One request now does both, and the
 * course is checked before anything is created.
 *
 * Shared by all three panel doors (POST /api/admin/seminars, /import,
 * /import/notebook), so the rule is written once.
 */
import { isClassDay } from '@shared/class-day'
import { studentTitle, type CourseItem, type CourseItemSeminar } from '@shared/publish'
import type { SeatRequest, SeatResult } from '@shared/admin'
import { canSeeCourse, type StaffLike } from './access.js'
import { getCourse, newRowId, setCourseItems } from '../publish/store.js'
import { forgetCourseIndex } from '../routes/course-view.js'

export type SeatCheck =
  | { ok: true; seat: SeatRequest | null }
  | { ok: false; status: 400 | 404 | 409; error: string }

/** A plan row a room may take the place of: planned, and not a break. */
function openRow(item: CourseItem | undefined): item is Extract<CourseItem, { kind: 'planned' }> {
  return item?.kind === 'planned' && item.pause !== true
}

/**
 * The `seat` of a creation request, checked before the room exists.
 *
 * A course the caller cannot see is a 404 in the same words as a course that
 * does not exist: an id must not tell a teacher that someone else's course is
 * there. A row that is no longer an open plan row (seated by someone else in
 * the meantime, made a break, removed) is a 409 — nothing has been created
 * yet, and the form can offer the fresh list.
 */
export function readSeat(raw: unknown, staff: StaffLike | null): SeatCheck {
  if (raw === undefined || raw === null) return { ok: true, seat: null }
  const body = raw as { courseId?: unknown; rowId?: unknown }
  if (typeof raw !== 'object' || typeof body.courseId !== 'string' || !body.courseId) {
    return { ok: false, status: 400, error: tr('server.seat.bad') }
  }
  if (body.rowId !== undefined && body.rowId !== null && typeof body.rowId !== 'string') {
    return { ok: false, status: 400, error: tr('server.seat.bad') }
  }
  const course = getCourse(body.courseId)
  if (!course || !canSeeCourse(staff, course.id)) {
    return { ok: false, status: 404, error: tr('server.courseNotFound.0429ec') }
  }
  const rowId = typeof body.rowId === 'string' && body.rowId ? body.rowId : undefined
  if (rowId !== undefined && !openRow(course.items.find((item) => item.id === rowId))) {
    return { ok: false, status: 409, error: tr('server.seat.rowTaken') }
  }
  return { ok: true, seat: rowId ? { courseId: course.id, rowId } : { courseId: course.id } }
}

/**
 * The room as a course row in place of the plan row: the row's id, topic, day,
 * «о чём» and week go with it — the topic becomes the class's title for
 * students, as on the client before (web/src/admin/course-plan.ts ·
 * seatSeminar).
 */
function seatedRow(was: Extract<CourseItem, { kind: 'planned' }>, room: { id: string; name: string }): CourseItemSeminar {
  return {
    kind: 'seminar',
    ...(was.id ? { id: was.id } : {}),
    sessionId: room.id,
    name: room.name,
    publication: null,
    title: studentTitle(was),
    ...(isClassDay(was.day) ? { day: was.day } : {}),
    ...(was.about ? { about: was.about } : {}),
    ...(was.when ? { when: was.when } : {}),
  }
}

/**
 * Write the room into the course, retrying a lost compare-and-swap against
 * the fresh list. The row checked by `readSeat` may have been taken in the
 * second since: then the room is appended rather than left outside the course
 * — it was asked to be in this course, and the teacher can move it.
 *
 * Null when the course itself disappeared in that second (an owner deleted
 * it), or when the caller no longer teaches it: `readSeat` asked before the
 * room was made, and the GitHub import walks the network for seconds in
 * between — a teacher removed from the course meanwhile must not still write
 * into its plan and make its teachers hosts of their room. The room stays
 * outside courses either way, and its author still runs it.
 */
export function seatRoom(
  seat: SeatRequest,
  room: { id: string; name: string },
  staff: StaffLike | null,
): SeatResult | null {
  for (let attempt = 0; attempt < 8; attempt++) {
    const course = getCourse(seat.courseId)
    if (!course || !canSeeCourse(staff, course.id)) return null
    const at = seat.rowId ? course.items.findIndex((item) => item.id === seat.rowId) : -1
    const row = at >= 0 ? course.items[at] : undefined
    let items: CourseItem[]
    let rowId: string
    let replaced: boolean
    if (openRow(row)) {
      const next = seatedRow(row, room)
      items = course.items.map((item, i) => (i === at ? next : item))
      rowId = next.id ?? newRowId(course.items.map((item) => item.id))
      if (!next.id) next.id = rowId
      replaced = true
    } else {
      rowId = newRowId(course.items.map((item) => item.id))
      items = [...course.items, { kind: 'seminar', id: rowId, sessionId: room.id, name: room.name, publication: null }]
      replaced = false
    }
    if (setCourseItems(course.id, course.rev, items)) {
      // The room's course hint and the class pages see it on the next request.
      forgetCourseIndex()
      return { courseId: course.id, rowId, replaced }
    }
  }
  console.error(`[courses] course ${seat.courseId} kept changing; room ${room.id} was not seated`)
  return null
}
