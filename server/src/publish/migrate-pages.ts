import { tr } from '@shared/i18n'
/**
 * Bringing courses and pages written by 0.12 up to class pages, at every
 * start.
 *
 * Idempotent, and cheap when there is nothing to do: each step looks for
 * exactly what it fills and leaves everything else alone, so a second run
 * changes nothing, and a 0.12 that a rollback brought back for a week is
 * caught up on the next start.
 *
 * COURSES (one compare-and-swap per course, retried):
 *   (a) every row gets an id;
 *   (b) a plan row whose week text names a single day gets that day
 *       (shared/class-day.ts · parseWhen); week ranges are left as they are;
 *   (c) a seated room that has been held gets its day: the instance-zone
 *       day on which the most distinct students joined it, else the day the
 *       class was finished. Never the day the room was created: rooms are
 *       made hours or days before the class.
 * Only rows whose `day` was never set are touched: a day a teacher cleared
 * is `null` and stays cleared.
 *
 * PAGES (one transaction per page):
 *   (e) a page whose materials are behind its revision (every page published
 *       before this release, and any page a rolled-back 0.12 republished)
 *       becomes one notebook material «Тетрадь» built from its last step,
 *       with its outline, its counts and an .ipynb with outputs, the room id
 *       scrubbed. The steps stay in place for a rollback;
 *   (f) material, blob and step rows of pages a rolled-back 0.12 deleted
 *       are dropped, so the page-file GC can let their files go.
 */
import { db, finishedAt } from '../db.js'
import '../activity.js'
import { dayOf, isClassDay, parseWhen } from '@shared/class-day'
import { suggestSlug, type Course, type CourseItem } from '@shared/publish'
import { instanceTimeZone } from '../time-zone.js'
import { scrubCells, scrubText } from './checks.js'
import { notebookMaterial, zipBytesFor } from './materials.js'
import { gcPageFiles } from './page-files.js'
import {
  adoptMaterials,
  getCourse,
  getPublication,
  legacyPage,
  listCourses,
  newRowId,
  readBlob,
  setCourseItems,
} from './store.js'
import { zipTop } from './zip.js'

const selectJoins = db.prepare(`
  SELECT created_at, actor_id FROM session_activity
  WHERE session_id = ? AND kind = 'presence.joined' AND actor_id IS NOT NULL
    AND (actor_role IS NULL OR actor_role <> 'host')
`)

/**
 * The day a room was held, or `null` when there is no evidence it was.
 *
 * Attendance first: the day most distinct students joined (an earlier day
 * wins a tie). Then the day the class was finished. A room that never ran
 * stays undated, and its own «Завершить занятие» will date it.
 */
export function heldDayOf(sessionId: string, zone = instanceTimeZone()): string | null {
  const byDay = new Map<string, Set<string>>()
  for (const row of selectJoins.all(sessionId) as { created_at: number; actor_id: string }[]) {
    const day = dayOf(row.created_at, zone)
    let people = byDay.get(day)
    if (!people) byDay.set(day, (people = new Set()))
    people.add(row.actor_id)
  }
  let best: string | null = null
  let most = 0
  for (const [day, people] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    if (people.size > most) {
      best = day
      most = people.size
    }
  }
  if (best) return best
  const finished = finishedAt(sessionId)
  return finished !== null ? dayOf(finished, zone) : null
}

/** The course's rows with what (a)–(c) fill in; `null` when nothing changes. */
function migratedRows(course: Course, zone: string): CourseItem[] | null {
  const created = dayOf(course.createdAt, zone)
  const ids: (string | undefined)[] = course.items.map((item) => item.id)
  let touched = false
  let unparsed = 0
  const items = course.items.map((item): CourseItem => {
    let next = item
    if (!next.id) {
      const id = newRowId(ids)
      ids.push(id)
      next = { ...next, id }
      touched = true
    }
    if (next.day === undefined) {
      let day: string | null = null
      if (next.kind === 'planned') {
        day = next.when ? parseWhen(next.when, created) : null
        if (!day && next.when) unparsed++
      } else if (next.kind === 'seminar') {
        day = heldDayOf(next.sessionId, zone)
      }
      if (day && isClassDay(day)) {
        next = { ...next, day }
        touched = true
      }
    }
    return next
  })
  if (unparsed > 0) {
    console.log(`[courses] ${course.id}: ${unparsed} plan row(s) name no single day; week text kept`)
  }
  return touched ? items : null
}

function migrateCourses(zone: string): number {
  let changed = 0
  for (const listed of listCourses()) {
    let course: Course | null = listed
    for (let attempt = 0; course && attempt < 8; attempt++) {
      const items = migratedRows(course, zone)
      if (!items) break
      if (setCourseItems(course.id, course.rev, items)) {
        changed++
        break
      }
      course = getCourse(course.id)
    }
  }
  return changed
}

const selectBehind = db.prepare(
  'SELECT id FROM publications WHERE materials_rev IS NULL OR materials_rev <> revision',
)

/**
 * (e): one 0.12 page into one notebook material.
 *
 * 0.12 never scrubbed the room id, and its step holds every
 * `/workspace/<id>/…` of every traceback. The material is what the new
 * routes serve (the tab, the .ipynb with outputs, the ZIP), so it is built
 * from scrubbed cells, and the stored title loses the id too: it goes into
 * the link card and the archive's name. A page whose room is gone keeps its
 * text; a dead id opens nothing.
 */
export function migratePage(pubId: string): void {
  const pub = getPublication(pubId)
  if (!pub) return
  const room = pub.sessionId
  const title = room ? scrubText(pub.title, room) : pub.title
  const legacy = legacyPage(pub.id)
  if (!legacy) {
    adoptMaterials(pub.id, [], 0, title)
    return
  }
  const cells = room ? scrubCells(legacy, room).cells : legacy
  const material = notebookMaterial({
    key: 'notebook',
    name: tr('server.page.notebook'),
    path: `${suggestSlug(title) || 'notebook'}.ipynb`,
    cells,
    blob: (hash) => readBlob(pub.id, hash),
  })
  adoptMaterials(pub.id, [material], zipBytesFor(zipTop({ ...pub, title }), [material]), title)
}

/*
 * Rows of pages that no longer exist. 0.12 deletes a page (forever, or with
 * its room) without knowing publication_materials, so after a rollback and a
 * roll forward those rows are left behind, and since the page-file GC keeps
 * every hash a material row names, the page's PDFs and datasets would stay
 * on disk and in every backup for good.
 */
const dropOrphanRows = [
  db.prepare('DELETE FROM publication_materials WHERE pub NOT IN (SELECT id FROM publications)'),
  db.prepare('DELETE FROM publication_blobs WHERE pub NOT IN (SELECT id FROM publications)'),
  db.prepare('DELETE FROM publication_steps WHERE pub NOT IN (SELECT id FROM publications)'),
]

/** (f): the rows a rolled-back 0.12 orphaned; how many went. */
export function dropOrphanPageRows(): number {
  return db.transaction(() => dropOrphanRows.reduce((n, stmt) => n + stmt.run().changes, 0))()
}

function migrateLegacyPages(): number {
  const behind = (selectBehind.all() as { id: string }[]).map((row) => row.id)
  for (const id of behind) {
    try {
      migratePage(id)
    } catch (err) {
      // One broken page must not keep the others, or the server, from starting.
      console.error(`[pages] page ${id} was not converted:`, err)
    }
  }
  return behind.length
}

/** Run every step. Called at startup after the schema is in place (index.ts). */
export function migratePages(zone = instanceTimeZone()): { courses: number; pages: number } {
  const courses = migrateCourses(zone)
  const orphans = dropOrphanPageRows()
  if (orphans > 0) console.log(`[pages] dropped ${orphans} row(s) of pages that no longer exist`)
  const pages = migrateLegacyPages()
  if (pages > 0 || orphans > 0) gcPageFiles()
  if (courses > 0 || pages > 0) {
    console.log(`[pages] brought up to class pages: ${courses} course(s), ${pages} page(s)`)
  }
  return { courses, pages }
}
