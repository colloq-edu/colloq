/**
 * Which competitions a staff member runs — the competitions' half of the
 * panel's scope rule (admin/access.ts holds the rooms' and courses').
 *
 * The rule, in one place for every door that asks it (the panel's list and
 * per-id routes, the dependency-policy routes, the queue, the entrant
 * registry, the /k board's staff exemptions):
 *  - an owner runs every competition;
 *  - a teacher runs a competition they created (`created_by` is a staff id,
 *    not a display name, so a rename does not lose it);
 *  - a teacher runs a competition of a course they teach.
 *
 * And one grant kept from before 0.19, when every teacher ran every
 * competition: a competition that existed at the update and has not been
 * given a course since is run by everyone who was on the staff list then
 * (store.ts · staff_shared_at). Without it the update silently took running
 * competitions away from the teachers co-running them.
 *
 * Nothing else grants it. A competition made since with no creator and no
 * course (rows made by scripts, or copied from another instance whose staff
 * ids mean nothing here) is the owners' until one of them puts it in a course.
 */
import { canSeeCourse, isOwner, type StaffLike } from '../admin/access.js'
import { getTeacher } from '../admin/store.js'
import { getCourse } from '../publish/store.js'
import { entrantCompetitionIds, getCompetition, staffSharedAt } from './store.js'
import type { Competition } from '@shared/competitions'

/**
 * What the rule reads. `id` is optional for the "would this move hide it"
 * question, asked of a competition as it would be after the move — and a
 * move into or out of a course ends the pre-0.19 sharing anyway.
 */
type Scoped = Pick<Competition, 'createdBy'> & { id?: string; courseId?: string | null }

export function canSeeCompetition(staff: StaffLike | null | undefined, competition: Scoped | null | undefined): boolean {
  if (!staff || !competition) return false
  if (isOwner(staff)) return true
  if (competition.createdBy !== null && competition.createdBy === staff.id) return true
  if (competition.courseId) return canSeeCourse(staff, competition.courseId)
  return competition.id !== undefined && sharedWithEarlierStaff(staff, competition.id)
}

/** Whether this person was on the staff list when the competition was shared with all of it. */
function sharedWithEarlierStaff(staff: StaffLike, competitionId: string): boolean {
  const at = staffSharedAt(competitionId)
  if (at === null) return false
  const joined = getTeacher(staff.id)?.createdAt
  return joined !== undefined && joined <= at
}

/** By id, for rows that carry only the id (queue rows, an entrant's competitions). */
export function canSeeCompetitionId(staff: StaffLike | null | undefined, competitionId: string): boolean {
  if (isOwner(staff)) return true
  return canSeeCompetition(staff, getCompetition(competitionId))
}

/**
 * How much of a person this teacher may act on as a whole.
 *
 * `none` — not one of the person's competitions is theirs: the person does not
 * exist for them. `some` — the person is in one of theirs and also elsewhere:
 * they see the row, but a rename, switching off or the key reach competitions
 * they do not run. `all` — every competition of the person is theirs (or the
 * caller is an owner). A person in no competition at all is the owner's: a
 * panel-made identity always joins the competition it was made from.
 */
export function entrantReach(staff: StaffLike | null | undefined, entrantId: string): 'none' | 'some' | 'all' {
  if (!staff) return 'none'
  if (isOwner(staff)) return 'all'
  const ids = entrantCompetitionIds(entrantId)
  const mine = ids.filter((id) => canSeeCompetitionId(staff, id)).length
  if (mine === 0) return 'none'
  return mine === ids.length ? 'all' : 'some'
}

/**
 * The course's name for a list row; null for none, for a course since
 * deleted, or for a course the viewer does not teach — the room list trims
 * its courses the same way, and a creator whose competition an owner moved
 * into another course must not read that course's name off the row.
 */
export function courseRefOf(
  courseId: string | null | undefined,
  viewer: StaffLike | null | undefined,
): { id: string; name: string } | null {
  if (!courseId || !canSeeCourse(viewer, courseId)) return null
  const course = getCourse(courseId)
  return course ? { id: course.id, name: course.name } : null
}
