/**
 * Who teaches a course: the decisions behind the «Ведут» strip and the
 * course list's «Мои / Все» switch.
 *
 * Until 0.19 every teacher saw every course, and a course had no people of
 * its own. Now a course and its rooms are visible to its teachers and to the
 * owners only (server/src/admin/access.ts), so the course screen has to say
 * who those people are and let any of them bring a colleague in. The screen
 * itself is Courses.svelte; what is decided here — whom the search offers,
 * whose × is drawn, which rooms the pickers may offer — is kept apart, like
 * course-plan.ts, so it can be tested without a browser.
 */
import type { AdminSeminar, ListScope, TeacherRef, TeacherWithCourses } from '@shared/admin'
import { seminarLink } from '@/lib/seminar-link'

/* ------------------------------------------------------------ the search */

/**
 * Lower case, «ё» read as «е», runs of spaces folded: «Семён» is found by
 * «семен», and nobody types the second space a colleague's name was saved
 * with.
 */
export function foldForSearch(text: string): string {
  return text.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

/**
 * Whether a staff member matches what was typed: every word of the query
 * must start a word of the name, or sit anywhere in the address. «мар смир»
 * finds Марина Смирнова; «smirnova@» finds her by mail; «ина» does not drag
 * in every Марина, Ирина and Нина on a faculty's staff list.
 */
export function staffMatches(person: Pick<TeacherRef, 'name'> & { email: string }, query: string): boolean {
  const words = foldForSearch(query).split(' ').filter(Boolean)
  if (words.length === 0) return true
  const email = foldForSearch(person.email)
  const nameWords = foldForSearch(person.name).split(' ')
  return words.every((word) => email.includes(word) || nameWords.some((part) => part.startsWith(word)))
}

/** How many people the popover lists at once: more is a scroll inside a scroll. */
export const STAFF_SHOWN = 6

/**
 * Whom «+ Добавить преподавателя» offers.
 *
 * The staff list minus the course's own teachers (adding someone twice is a
 * no-op the server would answer silently, and a row that does nothing is a
 * lie). An empty query lists people too, so a department of five finds a
 * colleague without typing; the order is by name, the way a staff list is
 * read, and the cut is STAFF_SHOWN — the search narrows the rest.
 */
export function addableStaff(
  staff: readonly TeacherWithCourses[],
  members: readonly Pick<TeacherRef, 'id'>[],
  query: string,
  limit = STAFF_SHOWN,
): { shown: TeacherWithCourses[]; more: number } {
  const taken = new Set(members.map((member) => member.id))
  const matching = staff
    .filter((person) => !taken.has(person.id) && staffMatches(person, query))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.email.localeCompare(b.email))
  return { shown: matching.slice(0, limit), more: Math.max(0, matching.length - limit) }
}

/**
 * The invite form, prefilled from the search that came up empty: what was
 * typed is the person's address when it looks like one, otherwise their
 * name. Retyping «m.smirnova@university.ru» one field lower is the kind of
 * friction that makes people share their own link instead.
 */
export function invitePrefill(query: string): { email: string; name: string } {
  const typed = query.trim()
  return typed.includes('@') ? { email: typed, name: '' } : { email: '', name: typed }
}

/** Good enough to send: the server checks again (courses.ts · invite). */
export function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())
}

/* ------------------------------------------------------------- the chips */

/**
 * The strip's order: yourself first, then the others as the server keeps
 * them (by when they were added). Finding «вы» in a row of eight names is
 * the first thing a teacher does on this screen.
 */
export function orderMembers<T extends Pick<TeacherRef, 'id'>>(members: readonly T[], me: string | null): T[] {
  const own = members.filter((member) => member.id === me)
  return [...own, ...members.filter((member) => member.id !== me)]
}

/**
 * Whether a chip gets its ×.
 *
 * The server refuses a teacher who would remove a course's last teacher
 * (409, server.access.courseKeepsATeacher): a course nobody teaches is seen
 * by owners alone, and the teacher who did it would lose it on the spot. A
 * button that is always refused is not drawn. An owner may leave a course
 * empty — they still see it, and can bring someone in again.
 */
export function canRemoveMember(memberCount: number, isOwner: boolean): boolean {
  return isOwner || memberCount > 1
}

/**
 * What removing yourself costs, which decides the question asked before it:
 * a teacher loses the course and its rooms; an owner only stops being one of
 * its teachers, and keeps seeing everything.
 */
export function selfRemoval(isOwner: boolean): 'loses' | 'keeps' {
  return isOwner ? 'keeps' : 'loses'
}

/* ------------------------------------------------------- lists and rooms */

/** The browser key for the owner's «Мои / Все» on the course list. */
export const COURSE_SCOPE_KEY = 'colloq.admin.courses.scope'

/**
 * The owner's last choice of «Мои / Все», or 'mine'.
 *
 * Read through a getter, not straight from `localStorage`: in a private
 * window or with site data blocked the accessor itself throws, and the
 * course list must open all the same. A teacher never gets 'all' back from
 * here — the server would answer 403 to it.
 */
export function readCourseScope(isOwner: boolean, storage: () => Pick<Storage, 'getItem'> | null): ListScope {
  if (!isOwner) return 'mine'
  try {
    return storage()?.getItem(COURSE_SCOPE_KEY) === 'all' ? 'all' : 'mine'
  } catch {
    return 'mine'
  }
}

export function saveCourseScope(scope: ListScope, storage: () => Pick<Storage, 'setItem'> | null): void {
  try {
    storage()?.setItem(COURSE_SCOPE_KEY, scope)
  } catch {
    // A convenience, not state: the switch still works for this visit.
  }
}

/**
 * Which room list the course screen asks for.
 *
 * A teacher's own list ('mine') already holds every room of a course they
 * teach: a course's rooms are its teachers' rooms (access.ts · canSeeRoom).
 * An owner looking at a course they do not teach would find none of its
 * rooms in their own list — the table would lose room names, «завершено»
 * and «снята» — so the owner asks for everything then, and also when they
 * switched the list to «Все».
 */
export function seminarScopeFor(isOwner: boolean, listScope: ListScope, teachesCourse: boolean): ListScope {
  return isOwner && (listScope === 'all' || !teachesCourse) ? 'all' : 'mine'
}

/**
 * The rooms the «Добавить занятие» and «Поставить занятие» pickers may
 * offer.
 *
 * Only what the server listed for this viewer, and of that, the rooms the
 * viewer teaches (`mine`). For a teacher the two are the same list; for an
 * owner who fetched every room to draw someone else's course, offering every
 * room on a university's instance would bury the one they meant — unless
 * they asked for «Все» themselves, which is exactly that request.
 */
export function pickerRooms(
  seminars: readonly AdminSeminar[],
  everyRoom: boolean,
): AdminSeminar[] {
  return everyRoom ? [...seminars] : seminars.filter((seminar) => seminar.mine !== false)
}

/**
 * The «ведут: …» line of a course row, names only. A course with nobody
 * left is said so by the caller: only owners can see it at all.
 */
export function teacherLine(teachers: readonly Pick<TeacherRef, 'name'>[] | undefined, limit = 3): { names: string; more: number } {
  const all = teachers ?? []
  return { names: all.slice(0, limit).map((t) => t.name).join(', '), more: Math.max(0, all.length - limit) }
}

/* --------------------------------------------------------- the invitation */

/**
 * The personal sign-in link of a new colleague, on an address they can open.
 *
 * The server builds it from PUBLIC_URL, and a PUBLIC_URL left on localhost
 * hands the chat a link that opens on one machine only. The Teachers screen
 * applies the same rule (Teachers.svelte · reachable) through the seminar
 * link's (lib/seminar-link.ts): the origin is chosen there, the path — which
 * carries the key — stays the server's.
 */
export function reachableSignIn(signInUrl: string, pageOrigin: string): string {
  try {
    const chosen = new URL(seminarLink(signInUrl, pageOrigin, 'x'))
    const link = new URL(signInUrl)
    return `${chosen.origin}${link.pathname}${link.search}`
  } catch {
    return signInUrl
  }
}
