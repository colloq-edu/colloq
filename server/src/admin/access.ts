/**
 * Who may see — and therefore run — which course and which room.
 *
 * One rule, in one place, because it is asked from very different doors: the
 * panel's lists and per-id routes, `roleFor` on every request and every socket
 * frame (authorization.ts), the join, the file upload, the ban exemption and
 * the page's door into the room. Asked separately, the answers would drift,
 * and the drift is a hole: a list that hides a room while the room still makes
 * its visitor host is a filter, not access control.
 *
 * The rule:
 *  - an owner sees everything;
 *  - a teacher sees a course they are a member of (course_teachers);
 *  - a teacher sees a room they are a member of (room_teachers), or a room
 *    seated in ANY course they teach — every course, not the newest one,
 *    because authorization needs the union: a room in two courses is run by
 *    the teachers of both.
 *
 * Which course holds which room lives in courses.items JSON, so the reverse
 * index (room → courses) is built here from every course and dropped on every
 * course write (`courseRowsChanged`, called from publish/store.ts). Nothing
 * here waits for a timer to notice a seat or an unseat: a teacher removed from
 * a course plan stops being host on the very next frame. The short lifetime
 * below only bounds writes that bypass the store (a script with sqlite3).
 *
 * The tables are created in admin/store.ts (see the note there); the queries,
 * the one-time migration and the membership writes are here.
 */
import { db } from '../db.js'
import { authorizationChanged, getTeacher } from './store.js'
import { putSettingRow, settingRows } from './settings.js'
import type { MemberTeacher, Teacher, TeacherRef } from '@shared/admin'
import type { StaffGuest } from '@shared/protocol'

/** Anything with an id and a role: a Teacher, or the slice of one a caller holds. */
export type StaffLike = Pick<Teacher, 'id' | 'role'>

export function isOwner(staff: StaffLike | null | undefined): boolean {
  return staff?.role === 'owner'
}

/* ------------------------------------------------------------ course index */

interface CourseIndex {
  at: number
  /** room id → every course whose rows seat it (a 'seminar' row), newest course first. */
  roomCourses: Map<string, string[]>
  /** course id → the rooms its rows seat. */
  courseRooms: Map<string, string[]>
  /** page id → every course a 'gone' row of which still links that page. */
  pageCourses: Map<string, string[]>
  names: Map<string, string>
}

/**
 * The bound on writes made past the store. The store's own writes drop the
 * index at once; this only keeps a hand-edited database from being trusted
 * for longer than half a minute.
 */
const INDEX_TTL_MS = 30_000

let index: CourseIndex | null = null

const selectCourseRows = db.prepare('SELECT id, name, items FROM courses ORDER BY created_at DESC')

/**
 * Drop the reverse index. Called from every write to `courses`
 * (publish/store.ts): create, rename, slug, items, delete.
 */
export function courseRowsChanged(): void {
  index = null
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key)
  if (!list) map.set(key, [value])
  else if (!list.includes(value)) list.push(value)
}

function courseIndex(): CourseIndex {
  const now = Date.now()
  if (index && now - index.at < INDEX_TTL_MS) return index
  const built: CourseIndex = {
    at: now,
    roomCourses: new Map(),
    courseRooms: new Map(),
    pageCourses: new Map(),
    names: new Map(),
  }
  for (const row of selectCourseRows.all() as { id: string; name: string; items: string }[]) {
    built.names.set(row.id, row.name)
    built.courseRooms.set(row.id, [])
    let items: unknown
    try {
      items = JSON.parse(row.items)
    } catch {
      // A corrupted row reads as a course without rooms, the way the store reads it.
      continue
    }
    if (!Array.isArray(items)) continue
    for (const item of items as { kind?: unknown; sessionId?: unknown; publication?: { id?: unknown } | null }[]) {
      if (!item || typeof item !== 'object') continue
      if (item.kind === 'seminar' && typeof item.sessionId === 'string') {
        push(built.roomCourses, item.sessionId, row.id)
        push(built.courseRooms, row.id, item.sessionId)
      }
      if ((item.kind === 'gone' || item.kind === 'seminar') && typeof item.publication?.id === 'string') {
        push(built.pageCourses, item.publication.id, row.id)
      }
    }
  }
  index = built
  return built
}

/** Every course that seats this room, newest first. System paths use it too: it is not scoped. */
export function coursesOfRoom(sessionId: string): string[] {
  return courseIndex().roomCourses.get(sessionId) ?? []
}

/** The rooms a course seats. */
export function roomsOfCourse(courseId: string): string[] {
  return courseIndex().courseRooms.get(courseId) ?? []
}

/** Every course a tombstone of which still links this page. */
export function coursesOfPage(pubId: string): string[] {
  return courseIndex().pageCourses.get(pubId) ?? []
}

function courseName(courseId: string): string | null {
  return courseIndex().names.get(courseId) ?? null
}

/* ---------------------------------------------------------------- queries */

const selectIsCourseTeacher = db.prepare('SELECT 1 FROM course_teachers WHERE course_id = ? AND staff_id = ?')
const selectIsRoomTeacher = db.prepare('SELECT 1 FROM room_teachers WHERE session_id = ? AND staff_id = ?')
const selectCoursesOf = db.prepare('SELECT course_id FROM course_teachers WHERE staff_id = ?')
const selectRoomsOf = db.prepare('SELECT session_id FROM room_teachers WHERE staff_id = ?')
const selectCourseMembers = db.prepare(`
  SELECT s.id, s.name, s.email, s.role, s.last_seen_at, m.added_at
  FROM course_teachers m JOIN staff s ON s.id = m.staff_id
  WHERE m.course_id = ?
  ORDER BY m.added_at ASC, s.name ASC
`)
const selectRoomMembers = db.prepare(`
  SELECT s.id, s.name, s.email, s.role, s.last_seen_at, m.added_at
  FROM room_teachers m JOIN staff s ON s.id = m.staff_id
  WHERE m.session_id = ?
  ORDER BY m.added_at ASC, s.name ASC
`)
const selectAllCourseMembers = db.prepare(`
  SELECT m.course_id, s.id, s.name
  FROM course_teachers m JOIN staff s ON s.id = m.staff_id
  ORDER BY m.added_at ASC, s.name ASC
`)
const selectAllRoomMembers = db.prepare(`
  SELECT m.session_id, s.id, s.name
  FROM room_teachers m JOIN staff s ON s.id = m.staff_id
  ORDER BY m.added_at ASC, s.name ASC
`)
const insertCourseMember = db.prepare(
  'INSERT OR IGNORE INTO course_teachers (course_id, staff_id, added_by, added_at) VALUES (?, ?, ?, ?)',
)
const insertRoomMember = db.prepare(
  'INSERT OR IGNORE INTO room_teachers (session_id, staff_id, added_by, added_at) VALUES (?, ?, ?, ?)',
)
const deleteCourseMember = db.prepare('DELETE FROM course_teachers WHERE course_id = ? AND staff_id = ?')
const deleteRoomMember = db.prepare('DELETE FROM room_teachers WHERE session_id = ? AND staff_id = ?')
const selectCourseMemberIds = db.prepare('SELECT staff_id FROM course_teachers WHERE course_id = ?')
const selectRoomMemberIds = db.prepare('SELECT staff_id FROM room_teachers WHERE session_id = ?')
const deleteCourseMembers = db.prepare('DELETE FROM course_teachers WHERE course_id = ?')
const deleteRoomMembers = db.prepare('DELETE FROM room_teachers WHERE session_id = ?')

export function isCourseTeacher(staffId: string, courseId: string): boolean {
  return selectIsCourseTeacher.get(courseId, staffId) !== undefined
}

export function isRoomTeacher(staffId: string, sessionId: string): boolean {
  return selectIsRoomTeacher.get(sessionId, staffId) !== undefined
}

/* -------------------------------------------------------------- the rule */

export function canSeeCourse(staff: StaffLike | null | undefined, courseId: string): boolean {
  if (!staff) return false
  if (isOwner(staff)) return true
  return isCourseTeacher(staff.id, courseId)
}

/**
 * Whether this staff member teaches this room — the room's own teacher, or a
 * teacher of any course that seats it. Asked per socket frame through
 * `roleFor`, so it is two indexed lookups and a walk over the (usually one)
 * course of the room; the index is in memory.
 */
export function teachesRoom(staffId: string, sessionId: string): boolean {
  if (isRoomTeacher(staffId, sessionId)) return true
  for (const courseId of coursesOfRoom(sessionId)) {
    if (isCourseTeacher(staffId, courseId)) return true
  }
  return false
}

export function canSeeRoom(staff: StaffLike | null | undefined, sessionId: string): boolean {
  if (!staff) return false
  if (isOwner(staff)) return true
  return teachesRoom(staff.id, sessionId)
}

/**
 * A page's access goes through its room while it has one, and through the
 * courses whose tombstones still link it otherwise (an orphaned page, or a
 * page whose row was buried): owners, or teachers of such a course.
 */
export function canSeePublication(
  staff: StaffLike | null | undefined,
  pub: { id: string; sessionId: string | null },
): boolean {
  if (!staff) return false
  if (isOwner(staff)) return true
  if (pub.sessionId !== null && teachesRoom(staff.id, pub.sessionId)) return true
  return coursesOfPage(pub.id).some((courseId) => isCourseTeacher(staff.id, courseId))
}

/** The courses this person is a member of — owners included: this is "mine", not "visible". */
export function memberCourseIds(staffId: string): Set<string> {
  return new Set((selectCoursesOf.all(staffId) as { course_id: string }[]).map((row) => row.course_id))
}

/** The rooms this person teaches: their own rooms and every room of their courses. */
export function memberRoomIds(staffId: string): Set<string> {
  const ids = new Set((selectRoomsOf.all(staffId) as { session_id: string }[]).map((row) => row.session_id))
  for (const courseId of memberCourseIds(staffId)) {
    for (const sessionId of roomsOfCourse(courseId)) ids.add(sessionId)
  }
  return ids
}

/**
 * What a list shows this person. `null` means "everything" — an owner who
 * asked for scope=all. An owner's default ("mine") is what they teach, like
 * anyone's: the «Мои / Все» switch on the screen is exactly this choice.
 */
export function visibleCourseIds(staff: StaffLike, all = false): Set<string> | null {
  if (all && isOwner(staff)) return null
  return memberCourseIds(staff.id)
}

export function visibleRoomIds(staff: StaffLike, all = false): Set<string> | null {
  if (all && isOwner(staff)) return null
  return memberRoomIds(staff.id)
}

/* ----------------------------------------------------------- the members */

interface MemberRow {
  id: string
  name: string
  email: string
  role: string
  last_seen_at: number | null
  added_at: number
}

function toMember(row: MemberRow): MemberTeacher {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role === 'owner' ? 'owner' : 'teacher',
    lastSeenAt: row.last_seen_at,
    addedAt: row.added_at,
  }
}

export function courseTeachers(courseId: string): MemberTeacher[] {
  return (selectCourseMembers.all(courseId) as MemberRow[]).map(toMember)
}

export function roomTeachers(sessionId: string): MemberTeacher[] {
  return (selectRoomMembers.all(sessionId) as MemberRow[]).map(toMember)
}

/**
 * Every course's teachers and every room's own teachers, as names, in two
 * queries: the lists (sixty rooms, twenty courses) would otherwise ask once
 * per row.
 */
export function membershipDirectory(): {
  courses: Map<string, TeacherRef[]>
  rooms: Map<string, TeacherRef[]>
} {
  const courses = new Map<string, TeacherRef[]>()
  const rooms = new Map<string, TeacherRef[]>()
  for (const row of selectAllCourseMembers.all() as { course_id: string; id: string; name: string }[]) {
    const list = courses.get(row.course_id) ?? []
    list.push({ id: row.id, name: row.name })
    courses.set(row.course_id, list)
  }
  for (const row of selectAllRoomMembers.all() as { session_id: string; id: string; name: string }[]) {
    const list = rooms.get(row.session_id) ?? []
    list.push({ id: row.id, name: row.name })
    rooms.set(row.session_id, list)
  }
  return { courses, rooms }
}

const selectStaffCourses = db.prepare(`
  SELECT m.staff_id, c.id, c.name
  FROM course_teachers m JOIN courses c ON c.id = m.course_id
  ORDER BY c.created_at DESC
`)

/**
 * Each staff member's courses, as the viewer may name them: an owner reads
 * every course, a teacher only the courses they teach themselves — the staff
 * picker must not be a way to learn the names of other people's courses.
 */
export function staffCourses(viewer: StaffLike): Map<string, TeacherRef[]> {
  const mine = isOwner(viewer) ? null : memberCourseIds(viewer.id)
  const out = new Map<string, TeacherRef[]>()
  for (const row of selectStaffCourses.all() as { staff_id: string; id: string; name: string }[]) {
    if (mine && !mine.has(row.id)) continue
    const list = out.get(row.staff_id) ?? []
    list.push({ id: row.id, name: row.name })
    out.set(row.staff_id, list)
  }
  return out
}

/**
 * Close this person's sockets in the rooms, among these, they no longer
 * teach — and only there.
 *
 * Not every socket of theirs: a teacher removed from one course may be in the
 * middle of a lecture in another, and an iPad console reconnecting mid-class
 * over a change that took nothing from that room is an interruption for
 * nothing. Nor every room listed: a room they still teach through its own
 * teachers or through another course has nothing to re-check. A deleted
 * person (no row) loses every room listed.
 */
function revokeLost(staffIds: readonly string[], sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return
  for (const staffId of staffIds) {
    const staff = staffById(staffId)
    const lost = staff ? sessionIds.filter((id) => !canSeeRoom(staff, id)) : [...sessionIds]
    if (lost.length > 0) authorizationChanged(staffId, lost)
  }
}

/**
 * Add a teacher to a course. False when they already were one.
 *
 * A grant closes no socket. Nothing was taken away, and the rooms that would
 * be "upgraded" are better left alone: a brand-new room has no sockets yet,
 * and a participant socket that should now be host is turned away on its
 * next frame anyway (socket-authorization.ts compares `roleFor` with the role
 * it came with) and reconnects as host. Closing every socket of the person
 * instead — which is what a bare authorizationChanged does — dropped the
 * creator's live lecture, iPad console included, each time they made a room
 * or a course for next week.
 */
export function addCourseTeacher(courseId: string, staffId: string, by: string | null): boolean {
  return insertCourseMember.run(courseId, staffId, by, Date.now()).changes > 0
}

export function removeCourseTeacher(courseId: string, staffId: string): boolean {
  const removed = deleteCourseMember.run(courseId, staffId).changes > 0
  if (removed) revokeLost([staffId], roomsOfCourse(courseId))
  return removed
}

/** Add a room's own teacher. False when they already were one. A grant closes no socket (see above). */
export function addRoomTeacher(sessionId: string, staffId: string, by: string | null): boolean {
  return insertRoomMember.run(sessionId, staffId, by, Date.now()).changes > 0
}

export function removeRoomTeacher(sessionId: string, staffId: string): boolean {
  const removed = deleteRoomMember.run(sessionId, staffId).changes > 0
  if (removed) revokeLost([staffId], [sessionId])
  return removed
}

export function courseTeacherIds(courseId: string): string[] {
  return (selectCourseMemberIds.all(courseId) as { staff_id: string }[]).map((row) => row.staff_id)
}

export function roomTeacherIds(sessionId: string): string[] {
  return (selectRoomMemberIds.all(sessionId) as { staff_id: string }[]).map((row) => row.staff_id)
}

/**
 * Rooms that have just left a course and now sit in no course at all, with
 * no teachers of their own, are adopted by that course's teachers.
 *
 * Without this such a room becomes owner-only the moment its row is removed
 * from the plan, or its course is deleted — invisible even to the teacher who
 * removed the row, who then cannot seat it in their other course either
 * (seating a room you cannot see is refused). The rooms this happens to are
 * the ones the one-time migration reached only through their course (it
 * never copies a seated room into room_teachers), and a room whose author
 * removed themselves while it was seated. A room that has its own teachers
 * keeps exactly them: taking it out of the course hands it back to them.
 *
 * Call it after the course write (so `coursesOfRoom` already reads the new
 * rows) and before the course's memberships are forgotten.
 */
export function adoptOrphanedRooms(courseId: string, sessionIds: readonly string[], by: string | null): string[] {
  const orphans = sessionIds.filter((id) => coursesOfRoom(id).length === 0 && roomTeacherIds(id).length === 0)
  if (orphans.length === 0) return []
  const teachers = courseTeacherIds(courseId)
  const now = Date.now()
  db.transaction(() => {
    for (const sessionId of orphans) {
      for (const staffId of teachers) insertRoomMember.run(sessionId, staffId, by, now)
    }
  })()
  return orphans
}

/**
 * A deleted course takes its teachers with it; they lose its former rooms
 * (`sessionIds`, read before the delete) now, not on reconnect — unless they
 * still teach a room another way.
 */
export function forgetCourseTeachers(courseId: string, sessionIds: readonly string[]): void {
  const ids = courseTeacherIds(courseId)
  deleteCourseMembers.run(courseId)
  revokeLost(ids, sessionIds)
}

/**
 * A deleted room takes its own teachers with it. No socket is told: the
 * room's own sockets are closed by its deletion (closeControlRoom,
 * dropSessionDoc), and the teachers' sockets in other rooms lost nothing.
 * Meant to run inside the deletion's transaction.
 */
export function forgetRoomTeachers(sessionId: string): void {
  deleteRoomMembers.run(sessionId)
}

/**
 * A course's rows changed and some rooms left it: whoever was host in them
 * only through this course re-checks now, in those rooms. Without this an
 * idle socket would keep receiving the host-only frames (speaker notes,
 * council sheets) of a room its owner no longer teaches until it next sent
 * something.
 */
export function courseRoomsLeft(courseId: string, sessionIds: readonly string[]): void {
  revokeLost(courseTeacherIds(courseId), sessionIds)
}

/* ------------------------------------------------------------ the guest */

/**
 * Why a staff member is an ordinary participant in this room: whose course it
 * is and who may lead it. The room shows it as one line (U5a): «Это комната
 * курса «…». Вы здесь как участник. Вести её могут: …».
 *
 * Names only — never addresses: the person reading this is, by definition,
 * someone who does not teach here. Owners are not listed: the line ends with
 * «— или владельца» on its own.
 */
export function staffGuestOf(sessionId: string): StaffGuest {
  const courses = coursesOfRoom(sessionId)
  const first = courses[0] ?? null
  const names: string[] = []
  const seen = new Set<string>()
  const add = (member: MemberTeacher): void => {
    if (seen.has(member.id) || member.role === 'owner') return
    seen.add(member.id)
    names.push(member.name)
  }
  for (const member of roomTeachers(sessionId)) add(member)
  for (const courseId of courses) for (const member of courseTeachers(courseId)) add(member)
  return {
    course: first ? { id: first, name: courseName(first) ?? '' } : null,
    teachers: names,
  }
}

/**
 * The guest note for a request, or null when there is nothing to explain:
 * nobody signed in, or the person does run this room.
 */
export function staffGuestFor(staff: StaffLike | null | undefined, sessionId: string): StaffGuest | null {
  if (!staff || canSeeRoom(staff, sessionId)) return null
  return staffGuestOf(sessionId)
}

/** A teacher by id for the tablet branch of `roleFor`: the token names them, the row decides. */
export function staffById(id: string): StaffLike | null {
  return getTeacher(id)
}

/* --------------------------------------------------------- the migration */

const MIGRATED_KEY = 'access.membershipsSeeded'

/**
 * The first boot with these tables keeps today's visibility exactly.
 *
 * Before them every staff member saw and ran every course and every room.
 * Taking that away silently on an update would hide a teacher's own semester
 * from them in the middle of it, so every existing staff member becomes a
 * teacher of every existing course, and of every existing room that sits in
 * no course (a seated room is reached through its course). Open-instance rooms
 * with nobody's name on them are included: they were visible to everyone too.
 *
 * Once, by a marker in instance_settings, not by "the tables are empty": an
 * instance where an owner later removed everyone from a course must not get
 * them all back on the next restart. A fresh install has nothing to copy and
 * only writes the marker.
 */
function seedMemberships(): void {
  if (settingRows('access.').has(MIGRATED_KEY)) return
  const staff = (db.prepare('SELECT id FROM staff').all() as { id: string }[]).map((row) => row.id)
  const courses = db.prepare('SELECT id, items FROM courses').all() as { id: string; items: string }[]
  const seated = new Set<string>()
  for (const course of courses) {
    try {
      const items: unknown = JSON.parse(course.items)
      if (!Array.isArray(items)) continue
      for (const item of items as { kind?: unknown; sessionId?: unknown }[]) {
        if (item?.kind === 'seminar' && typeof item.sessionId === 'string') seated.add(item.sessionId)
      }
    } catch {
      /* a corrupted row seats nothing */
    }
  }
  const rooms = (db.prepare('SELECT id FROM sessions').all() as { id: string }[])
    .map((row) => row.id)
    .filter((id) => !seated.has(id))
  const now = Date.now()
  db.transaction(() => {
    for (const staffId of staff) {
      for (const course of courses) insertCourseMember.run(course.id, staffId, null, now)
      for (const room of rooms) insertRoomMember.run(room, staffId, null, now)
    }
    putSettingRow(MIGRATED_KEY, String(now))
  })()
  if (staff.length > 0 && (courses.length > 0 || rooms.length > 0)) {
    console.log(
      `[access] kept today's visibility: ${staff.length} staff × ${courses.length} courses and ${rooms.length} rooms outside courses`,
    )
  }
}

seedMemberships()

/**
 * For the migration test: run the seeding again — as if on a first boot
 * (`firstBoot`, the marker dropped), or as on any later boot (the marker kept,
 * so nothing must happen).
 */
export function reseedMembershipsForTest(firstBoot = true): void {
  if (firstBoot) putSettingRow(MIGRATED_KEY, null)
  seedMemberships()
}
