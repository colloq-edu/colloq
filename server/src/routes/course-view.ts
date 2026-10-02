/**
 * The course and its class pages as the outside world sees them, in one
 * place.
 *
 * Assembling "the course with live names" was written twice once, here and
 * in the static export, and the two copies showed DIFFERENT courses: one
 * substituted the room's name, the other returned the stored row with a stale
 * read link. Everything a student reads is now built here: the panel's live
 * rows, the course page (`/api/c`), the class page (`/api/p`), the archive's
 * README and the link cards all walk the same `courseRows`.
 *
 * The way up from a page is here too: `courseOfPublication` also existed in
 * two copies.
 */
import { isClassDay } from '@shared/class-day'
import {
  publicationAddress,
  studentTitle,
  type ClassState,
  type Course,
  type CourseItem,
  type PublicClass,
  type PublicCourseView,
  type PublicMaterial,
  type PublicNeighbor,
  type PublicPage,
} from '@shared/publish'
import { getSession } from '../db.js'
import { scrubText } from '../publish/checks.js'
import {
  getPublication,
  listCourses,
  listMaterials,
  materialCount,
  publicationOf,
  type MaterialRow,
  type Publication,
} from '../publish/store.js'
import { zipPlan, type ZipContext } from '../publish/zip.js'
import { instanceToday } from '../time-zone.js'

/**
 * Course rows with live names and live read links, for the panel.
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
        : { ...item, publication: null }
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
      ...item,
      name: session?.name ?? item.name,
      publication:
        pub && pub.state === 'published'
          ? {
              id: pub.id,
              slug: pub.slug,
              publishedAt: pub.publishedAt,
              materials: materialCount(pub.id),
            }
          : null,
    }
  })
}

/* ------------------------------------------------------------ the rows */

/** One course row as students see it: its number, its title, its day and its page. */
export interface CourseRow {
  item: CourseItem
  /** The row id; rows a 0.12 writer left without one get their position. */
  key: string
  /** The ordinal among non-pause rows; `null` for a pause. */
  n: number | null
  /** studentTitle: the row's title, else the live room name. */
  title: string
  day: string | null
  state: ClassState
  /** The page behind the row, published or withdrawn; `null` when there is none. */
  pub: Publication | null
}

/**
 * Every row of a course, in teacher order, with what a student is shown.
 *
 * 'page' is a row with a published page; 'room' a held or upcoming room with
 * none yet; 'closed' a row that will have none: its room was deleted without
 * one, or its page was withdrawn. A withdrawn page is the teacher's decision,
 * and «материалов пока нет» would promise what it took back.
 */
export function courseRows(course: Course): CourseRow[] {
  let n = 0
  return course.items.map((item, index): CourseRow => {
    const pause = item.kind === 'planned' && item.pause === true
    if (!pause) n++
    const base = {
      item,
      key: item.id ?? `row-${index + 1}`,
      n: pause ? null : n,
      day: isClassDay(item.day) ? item.day : null,
    }
    if (item.kind === 'planned') {
      return { ...base, title: studentTitle(item), state: pause ? 'pause' : 'plan', pub: null }
    }
    if (item.kind === 'gone') {
      const pub = item.publication ? getPublication(item.publication.id) : null
      const state = pub?.state === 'published' ? 'page' : 'closed'
      return { ...base, title: studentTitle(item), state, pub }
    }
    const session = getSession(item.sessionId)
    // A seminar row the tombstone never reached keeps its link in the row.
    const pub =
      publicationOf(item.sessionId) ??
      (item.publication ? getPublication(item.publication.id) : null)
    const state: ClassState = pub
      ? pub.state === 'published'
        ? 'page'
        : 'closed'
      : session
        ? 'room'
        : 'closed'
    // A room named after its own id must not hand that id (the right to write in it) to the course.
    const title = scrubText(
      studentTitle({ title: item.title, name: session?.name ?? item.name }),
      item.sessionId,
    )
    return { ...base, title, state, pub }
  })
}

/**
 * The day a page belongs to: its course row's, else the day the teacher gave
 * a page outside a course, else the day it was first published.
 */
export function pageDay(row: Pick<CourseRow, 'day'> | null, pub: Publication): string {
  return row?.day ?? pub.heldOn ?? instanceToday(pub.firstAt)
}

/** What the archive of a page says about itself, from the row it hangs off. */
export function zipContextOf(
  pub: Publication,
  materials: readonly MaterialRow[],
  course: Course | null,
  row: CourseRow | null,
): ZipContext {
  return {
    pub,
    materials,
    title: row?.title ?? pub.title,
    n: row?.n ?? null,
    day: pageDay(row, pub),
    course: course ? { id: course.id, slug: course.slug, name: course.name } : null,
  }
}

/**
 * The course for its public page.
 *
 * The room id does not go out: its eight characters are the whole right to
 * write in the room, and a link given to the class "for reading" must not
 * open the live notebook for them.
 */
export function publicCourseView(course: Course): PublicCourseView {
  const classes = courseRows(course).map((row): PublicClass => {
    const pub = row.state === 'page' ? row.pub : null
    let page: PublicClass['page'] = null
    if (pub) {
      const materials = listMaterials(pub.id)
      page = {
        address: publicationAddress(pub),
        materials: materials.map((m) => ({ key: m.key, kind: m.kind, name: m.name, bytes: m.bytes })),
        zipBytes: zipPlan(zipContextOf(pub, materials, course, row)).bytes,
        updatedAt: pub.publishedAt,
      }
    }
    return {
      key: row.key,
      n: row.n,
      title: row.title,
      about: row.item.about ?? null,
      day: row.day,
      when: row.day ? null : row.item.when?.trim() || null,
      state: row.state,
      page,
    }
  })
  return {
    id: course.id,
    slug: course.slug,
    name: course.name,
    blurb: course.blurb,
    today: instanceToday(),
    classes,
  }
}

/* ------------------------------------------------------------ the page */

/** Where a page sits in its course, if it sits in one. */
export interface PageContext {
  course: Course | null
  rows: CourseRow[]
  row: CourseRow | null
  at: number
}

export function pageContext(pub: Publication): PageContext {
  const course = courseOfPublication(pub)
  const rows = course ? courseRows(course) : []
  const at = rows.findIndex((row) => row.pub?.id === pub.id)
  return { course, rows, row: at >= 0 ? rows[at] : null, at }
}

/** The nearest non-pause row in a direction, as the page's prev or next link. */
function neighborOf(context: PageContext, step: 1 | -1): PublicNeighbor | null {
  if (!context.row) return null
  for (let i = context.at + step; i >= 0 && i < context.rows.length; i += step) {
    const row = context.rows[i]
    if (row.n === null) continue
    return {
      n: row.n,
      title: row.title,
      day: row.day,
      address: row.state === 'page' && row.pub ? publicationAddress(row.pub) : null,
    }
  }
  return null
}

function publicMaterial(m: MaterialRow): PublicMaterial {
  const out: PublicMaterial = { key: m.key, kind: m.kind, name: m.name, bytes: m.bytes, path: m.path }
  if (m.kind === 'notebook') {
    out.cells = m.cellCount ?? 0
    out.outputs = m.outputCount ?? 0
    out.outline = m.outline
  }
  return out
}

/**
 * A class page as a student reads it: the course row's title, number, day
 * and «о чём», its neighbours, and its materials (none when withdrawn).
 */
export function publicPageView(pub: Publication): PublicPage {
  const context = pageContext(pub)
  const { course, row } = context
  const live = pub.state === 'published'
  const materials = live ? listMaterials(pub.id) : []
  const zip =
    materials.length > 0 ? zipPlan(zipContextOf(pub, materials, course, row)) : null
  return {
    id: pub.id,
    slug: pub.slug,
    address: publicationAddress(pub),
    state: pub.state,
    title: row?.title ?? pub.title,
    about: row?.item.about ?? null,
    day: pageDay(row, pub),
    n: row?.n ?? null,
    today: instanceToday(),
    firstAt: pub.firstAt,
    updatedAt: pub.publishedAt,
    updatedOn: instanceToday(pub.publishedAt),
    course: course ? { id: course.id, slug: course.slug, name: course.name } : null,
    prev: neighborOf(context, -1),
    next: neighborOf(context, 1),
    materials: materials.map(publicMaterial),
    zip: zip ? { name: `${zip.top}.zip`, bytes: zip.bytes } : null,
  }
}

/* ------------------------------------------------------------- lookups */

/**
 * "Which course is this seminar in", by index rather than by scanning all
 * courses.
 *
 * It is asked on entering a room (`GET /api/sessions/:id`) and on a class
 * page, that is, up to five hundred times in the first minute of a lesson
 * and on every tab refresh. The answer used to be assembled by a scan:
 * `listCourses()` reads all of the semester's courses, parses the contents
 * JSON of each and searches for the row linearly.
 *
 * The index lives five seconds. The writes this server makes itself (the
 * panel's PUT items, the day a finished class is stamped with) drop it at
 * once with `forgetCourseIndex`, so the teacher's next click already sees
 * them; the five seconds only bound how long a write from elsewhere (a
 * script, another process) takes to show.
 *
 * Keys have a prefix: `s:` for a room, `p:` for a page from a tombstone. Both
 * have eight characters from the same alphabet, and a shared key would one
 * day show a seminar someone else's course.
 */
const INDEX_TTL_MS = 5_000

let index: { at: number; byHandle: Map<string, Course> } | null = null

export function forgetCourseIndex(): void {
  index = null
}

function courseIndex(): Map<string, Course> {
  const now = Date.now()
  if (index && now - index.at < INDEX_TTL_MS) return index.byHandle
  const byHandle = new Map<string, Course>()
  // The order is the same as the scan's (`listCourses` puts the newest on
  // top), and so is the first winner: a seminar that ended up in two courses
  // shows the same one of them as before.
  for (const course of listCourses()) {
    for (const item of course.items) {
      const keys: string[] = []
      if (item.kind === 'seminar') {
        keys.push(`s:${item.sessionId}`)
        if (item.publication) keys.push(`p:${item.publication.id}`)
      } else if (item.kind === 'gone' && item.publication) {
        keys.push(`p:${item.publication.id}`)
      }
      for (const key of keys) if (!byHandle.has(key)) byHandle.set(key, course)
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
 * The course the publication belongs to: the way up from a class page.
 *
 * An orphaned page has no room, and the course will not be found by
 * `sessionId`: only the tombstone holds it back, and only the tombstone ties
 * it to the course.
 */
export function courseOfPublication(pub: Pick<Publication, 'id' | 'sessionId'>): Course | null {
  const where = courseIndex()
  const byRoom = pub.sessionId !== null ? where.get(`s:${pub.sessionId}`) : undefined
  return byRoom ?? where.get(`p:${pub.id}`) ?? null
}
