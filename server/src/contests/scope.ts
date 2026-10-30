/**
 * Which contests a staff member runs — the contests' half of the panel's
 * scope rule, word for word the competitions' (competitions/scope.ts):
 *  - an owner runs every contest;
 *  - a teacher runs a contest they created (`created_by` is a staff id, so a
 *    rename does not lose it);
 *  - a teacher runs a contest of a course they teach (admin/access.ts ·
 *    canSeeCourse).
 *
 * Nothing else grants it, and there is no pre-0.19 sharing to keep: contests
 * were born after courses had teachers. A contest with no creator and no
 * course (a script's row) is the owners' until one of them puts it in a
 * course.
 *
 * Asked by every per-id door of the panel (routes/admin-contests.ts ·
 * contestOf), by the participant's doors where staff read what the class
 * cannot (a draft's preview, the board's full names), and by the projector.
 */
import { canSeeCourse, isOwner, type StaffLike } from '../admin/access.js'
import type { Contest } from '@shared/contests'

type Scoped = Pick<Contest, 'createdBy' | 'courseId'>

export function canSeeContest(staff: StaffLike | null | undefined, contest: Scoped | null | undefined): boolean {
  if (!staff || !contest) return false
  if (isOwner(staff)) return true
  if (contest.createdBy !== null && contest.createdBy === staff.id) return true
  if (contest.courseId) return canSeeCourse(staff, contest.courseId)
  return false
}

/**
 * Who may delete a contest: an owner, or the teacher who created it.
 *
 * The competitions keep their delete to owners (the submissions and places of
 * a hundred people go for good); a contest is more often a teacher's own
 * class test, made and thrown away the same week, so its author may take it
 * down too. A course's other teachers may run it, not delete it.
 */
export function canDeleteContest(staff: StaffLike | null | undefined, contest: Scoped | null | undefined): boolean {
  if (!staff || !contest) return false
  return isOwner(staff) || (contest.createdBy !== null && contest.createdBy === staff.id)
}
