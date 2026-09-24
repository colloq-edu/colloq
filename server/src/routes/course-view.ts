/**
 * The course as the outside world sees it, in one place.
 *
 * Assembling "the course with live names" was written twice: here (for the
 * panel and `/api/c/:id`) and in publish/export.ts (for exporting to the
 * site). They did the same thing differently: the export substituted
 * `session?.name ?? item.name` and re-read the publication, while the route,
 * when the room was gone, returned the row as is, together with a stale read
 * link. That is, the server and the site showed DIFFERENT courses, and the
 * next change to the tombstone rules would have landed in one copy of the
 * two.
 *
 * The way up from a publication page is here too: `courseOfPublication` also
 * existed in two copies.
 */
import type { Course, CourseItem, PublicCourseView } from '@shared/publish'
import { getSession } from '../db.js'
import { getPublication, listCourses, publicationOf, stepCount } from '../publish/store.js'
import type { Publication } from '../publish/store.js'

/**
 * Course rows with live names and live read links.
 *
 * The seminar's name may have changed after it was added, the page may have
 * been withdrawn or restored, and the room deleted. What is recorded in the
 * course stays the address; everything else is asked for afresh.
 */
export function freshCourseItems(items: CourseItem[]): CourseItem[] {
  return items.map((item): CourseItem => {
    /*
     * A tombstone has a link to the remaining reading, but the page may have
     * been withdrawn after the room was deleted, and then there is nowhere to
     * lead.
     */
    if (item.kind === 'gone') {
      if (!item.publication) return item
      const pub = getPublication(item.publication.id)
      return pub && pub.state === 'published'
        ? { ...item, publication: { id: pub.id, slug: pub.slug } }
        : { kind: 'gone', name: item.name, at: item.at, publication: null }
    }
    if (item.kind !== 'seminar') return item
    /*
     * The room may not exist at all: deletion puts up a tombstone, but if the
     * write of the contents failed at that moment (a race in entombSeminar),
     * the seminar row stays an orphan. The name is then the one it was
     * recorded under in the course, and the reading is asked for anyway: it
     * lives in its own rows and does not need the room.
     */
    const session = getSession(item.sessionId)
    const pub = publicationOf(item.sessionId)
    return {
      kind: 'seminar',
      sessionId: item.sessionId,
      name: session?.name ?? item.name,
      publication:
        pub && pub.state === 'published'
          ? {
              id: pub.id,
              slug: pub.slug,
              publishedAt: pub.publishedAt,
              steps: stepCount(pub.id),
            }
          : null,
    }
  })
}

/**
 * The course for the public page, and for the export: it is the same page.
 *
 * The room id does not go out: its eight characters are the whole right to
 * write in it.
 */
export function publicCourseView(course: Course): PublicCourseView {
  return {
    id: course.id,
    slug: course.slug,
    name: course.name,
    blurb: course.blurb,
    items: freshCourseItems(course.items).map((item) =>
      item.kind === 'seminar' ? { ...item, sessionId: '' } : item,
    ),
  }
}

/**
 * "Which course is this seminar in", by index rather than by scanning all
 * courses.
 *
 * It is asked on entering a room (`GET /api/sessions/:id`) and on a step's
 * public page, that is, up to five hundred times in the first minute of a
 * lesson and on every tab refresh. The answer used to be assembled by a scan:
 * `listCourses()` reads all of the semester's courses, parses the contents
 * JSON of each and searches for the row linearly.
 *
 * The index lives five seconds, and that is exactly what it is worth: course
 * contents are edited from the panel once a week, and seeing an edit after
 * five seconds is not the same as seeing it after five minutes. There is
 * deliberately no invalidation on write: publish/store.ts edits the courses,
 * and asking it to call us back would mean a second link between the modules
 * for the sake of a delay nobody will notice.
 *
 * Keys have a prefix: `s:` for a room, `p:` for a page from a tombstone. Both
 * have eight characters from the same alphabet, and a shared key would one
 * day show a seminar someone else's course.
 */
const INDEX_TTL_MS = 5_000

let index: { at: number; byHandle: Map<string, Course> } | null = null

function courseIndex(): Map<string, Course> {
  const now = Date.now()
  if (index && now - index.at < INDEX_TTL_MS) return index.byHandle
  const byHandle = new Map<string, Course>()
  // The order is the same as the scan's (`listCourses` puts the newest on
  // top), and so is the first winner: a seminar that ended up in two courses
  // shows the same one of them as before.
  for (const course of listCourses()) {
    for (const item of course.items) {
      const key =
        item.kind === 'seminar'
          ? `s:${item.sessionId}`
          : item.kind === 'gone' && item.publication
            ? `p:${item.publication.id}`
            : null
      if (key && !byHandle.has(key)) byHandle.set(key, course)
    }
  }
  index = { at: now, byHandle }
  return byHandle
}

/** The course the room belongs to: a hint on the entry screen. */
export function courseOfSeminar(sessionId: string): Course | null {
  return courseIndex().get(`s:${sessionId}`) ?? null
}

/**
 * The course the publication belongs to: the way up from a step page.
 *
 * An orphaned page has no room, and the course will not be found by
 * `sessionId`: only the tombstone holds it back, and only the tombstone ties
 * it to the course.
 *
 * With the course list at hand (the site export builds it once for all
 * pages), it is searched in that list; without it, by the index above.
 */
export function courseOfPublication(
  pub: Pick<Publication, 'id' | 'sessionId'>,
  courses?: Course[],
): Course | null {
  if (!courses) {
    const where = courseIndex()
    const byRoom = pub.sessionId !== null ? where.get(`s:${pub.sessionId}`) : undefined
    return byRoom ?? where.get(`p:${pub.id}`) ?? null
  }
  return (
    courses.find((course) =>
      course.items.some((item) =>
        item.kind === 'seminar'
          ? pub.sessionId !== null && item.sessionId === pub.sessionId
          : item.kind === 'gone' && item.publication?.id === pub.id,
      ),
    ) ?? null
  )
}
