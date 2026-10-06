/**
 * The «Курсы» column of «Преподаватели»: which courses each person teaches,
 * and the owner's way of changing that without opening thirty courses.
 *
 * Since 0.19 a teacher sees only the courses they teach (server/src/admin/
 * access.ts), so «who teaches what» became the question an owner asks this
 * screen first — and «ещё ни в одном курсе» the row to act on: a teacher in
 * no course sees an empty panel. The decisions are kept apart from the screen
 * (Teachers.svelte), like course-plan.ts, so they are testable without a
 * browser.
 */
import type { AdminRole, TeacherRef } from '@shared/admin'
import type { Course } from '@shared/publish'

/**
 * What the cell says about one person.
 *
 * - 'owner': an owner sees every course whatever they teach («видит все
 *   курсы»); how many they teach is said only to another owner, because a
 *   teacher's view of the list is trimmed (below) and its count would lie.
 * - 'chips': the courses, as many as the viewer may know of.
 * - 'none': in no course at all — said only to an owner, who has the whole
 *   list. A warning, because such a teacher sees nothing but their own rooms.
 * - 'unshared': a teacher looking at a colleague with no course in common.
 *   The server trims the list to the viewer's own courses (GET /teachers), so
 *   an empty list here is not «in no course», and saying so would be false.
 */
export type CoursesCell =
  | { kind: 'owner'; teaches: number | null }
  | { kind: 'chips'; courses: TeacherRef[] }
  | { kind: 'none' }
  | { kind: 'unshared' }

export function coursesCell(
  person: { role: AdminRole; courses?: readonly TeacherRef[] },
  viewerIsOwner: boolean,
): CoursesCell {
  const courses = [...(person.courses ?? [])]
  if (person.role === 'owner') return { kind: 'owner', teaches: viewerIsOwner ? courses.length : null }
  if (courses.length > 0) return { kind: 'chips', courses }
  return viewerIsOwner ? { kind: 'none' } : { kind: 'unshared' }
}

/**
 * The courses «+ курс» offers a person: every course they do not teach yet,
 * by name, narrowed by what was typed (any word of the name may start with
 * any typed word; «ё» is «е»). A course already on the row is not offered —
 * adding it again is a no-op that would look like an answer.
 */
export function addableCourses(
  all: readonly Pick<Course, 'id' | 'name'>[],
  have: readonly Pick<TeacherRef, 'id'>[],
  query = '',
): TeacherRef[] {
  const taken = new Set(have.map((course) => course.id))
  const fold = (text: string) => text.toLocaleLowerCase('ru').replace(/ё/g, 'е')
  const words = fold(query).split(/\s+/).filter(Boolean)
  return all
    .filter((course) => !taken.has(course.id))
    .filter((course) => {
      if (words.length === 0) return true
      const parts = fold(course.name).split(/[\s|/·,.()-]+/).filter(Boolean)
      return words.every((word) => parts.some((part) => part.startsWith(word)))
    })
    .map((course) => ({ id: course.id, name: course.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}

/** The row after a course was added: at the end, once. */
export function withCourse<T extends { courses?: readonly TeacherRef[] }>(person: T, course: TeacherRef): T & { courses: TeacherRef[] } {
  const courses = person.courses ?? []
  if (courses.some((c) => c.id === course.id)) return { ...person, courses: [...courses] }
  return { ...person, courses: [...courses, { id: course.id, name: course.name }] }
}

/** The row after a course was removed. */
export function withoutCourse<T extends { courses?: readonly TeacherRef[] }>(person: T, courseId: string): T & { courses: TeacherRef[] } {
  return { ...person, courses: (person.courses ?? []).filter((c) => c.id !== courseId) }
}

/**
 * A new teacher into the courses ticked on the add form, one by one.
 *
 * The person already exists by now — the staff row and the link are the
 * part that matters, and a course refused (deleted a minute ago, say) must
 * not undo them. So every course is tried, and the caller hears which ones
 * took and which did not, to say so beside the link. The call is passed in
 * so the decision is testable without a server.
 */
export async function joinCourses(
  courses: readonly TeacherRef[],
  add: (courseId: string) => Promise<unknown>,
): Promise<{ joined: TeacherRef[]; failed: TeacherRef[] }> {
  const joined: TeacherRef[] = []
  const failed: TeacherRef[] = []
  for (const course of courses) {
    try {
      await add(course.id)
      joined.push(course)
    } catch {
      failed.push(course)
    }
  }
  return { joined, failed }
}
