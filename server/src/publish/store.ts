/**
 * Courses and publications: the queries against them.
 *
 * The SCHEMA of these tables (`courses`, `publications`, `publication_steps`,
 * `publication_blobs`) is not here but in `db.ts`, together with the
 * migrations, and it has one owner: `sessions` is already edited by two files
 * (`db.ts` adds the environment and rules columns, `admin-instance.ts` the
 * author and archiving), and a third owner is exactly how a schema sprawls.
 * The matching note is there too, next to `CREATE TABLE`.
 *
 * Here are the queries against those tables and one table of our own,
 * `publish_addresses`: former names in addresses that nobody else knows
 * about. The header used to promise "our own tables here, and nobody else
 * writes to them" about tables this module does not create; reading it that
 * way meant believing a column could be added from here.
 */
import { randomBytes } from 'node:crypto'
import { db } from '../db.js'
import {
  MAX_COURSE_BLURB,
  MAX_COURSE_NAME,
  MAX_STEP_LABEL,
  type AddressHolder,
  type AddressKind,
  type Course,
  type CourseItem,
  type PublicCell,
  type PublicationState,
  type StepHeading,
} from '@shared/publish'

/* ------------------------------------------------------------------- names */

/**
 * Eight characters from an alphabet that is read aloud.
 *
 * The same technique as for a seminar, and deliberately a DIFFERENT id:
 * knowing a room's eight characters is the whole right to write in it, so the
 * public address has to be its own. Otherwise a link given to the class "for
 * reading" would open the live room for them with the right to type.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function newId(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

/* -------------------------------------------------------------- addresses */

/**
 * Addresses the page has already been given to someone under.
 *
 * The name in an address can be changed, but a link handed out cannot: it is
 * written in the group chat, in someone's bookmarks and on the board. The
 * address by id survives the arrival of a name by itself
 * (`WHERE id = ? OR slug = ?`), but a former name had nowhere to be
 * remembered: after a rename it turned into a 404 both on the site and on the
 * live server.
 *
 * Withdrawing a page does not cancel its address: the link must say "it was
 * withdrawn", not "there is no such page here". Addresses are forgotten
 * together with the row, in `deleteCourse` and `deletePublication`, when there
 * is nothing left to point to.
 *
 * The only publication table created here rather than in `db.ts`: no other
 * module knows about it (no column exposed, no query from outside), and
 * keeping its schema apart from the only queries against it would cost more
 * in distance from the code than it would gain in order. Everything else is
 * in `db.ts`; see the file header.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS publish_addresses (
    kind  TEXT NOT NULL,
    slug  TEXT NOT NULL,
    owner TEXT NOT NULL,
    at    INTEGER NOT NULL,
    PRIMARY KEY (kind, slug)
  )
`)

const rememberAddress = db.prepare(
  'INSERT OR REPLACE INTO publish_addresses (kind, slug, owner, at) VALUES (?, ?, ?, ?)',
)
const forgetAddress = db.prepare('DELETE FROM publish_addresses WHERE kind = ? AND slug = ?')
const forgetAddressesOf = db.prepare('DELETE FROM publish_addresses WHERE kind = ? AND owner = ?')
const selectAddressOwner = db.prepare(
  'SELECT owner FROM publish_addresses WHERE kind = ? AND slug = ?',
)
const selectAddresses = db.prepare(
  'SELECT slug FROM publish_addresses WHERE kind = ? AND owner = ? ORDER BY at',
)

/**
 * The name changed: the old one stays an address, and the new one stops being
 * anyone's old one.
 *
 * A live name always outranks a former one, otherwise one address would hold
 * both a page and a pointer to someone else's.
 */
function moveAddress(kind: AddressKind, id: string, was: string | null, now: string | null): void {
  if (was === now) return
  if (was) rememberAddress.run(kind, was, id, Date.now())
  if (now) forgetAddress.run(kind, now)
}

/** Who this address used to belong to. */
function addressOwner(kind: AddressKind, slug: string): string | null {
  const row = selectAddressOwner.get(kind, slug) as { owner: string } | undefined
  return row ? row.owner : null
}

/** Former names: the export puts pointers to the current address under them. */
export function formerSlugs(kind: AddressKind, id: string): string[] {
  return (selectAddresses.all(kind, id) as { slug: string }[]).map((row) => row.slug)
}

/**
 * Who holds this address, so that the refusal names the holder.
 *
 * "The address "ml-2025" is already taken" is a dead end: there is no course
 * with that address in the list (it was renamed to "ml-2025-fall"), and the
 * teacher looks for something that is not visible. Here both who and how are
 * visible: `former` means the name is held not by a live address but by the
 * memory of a link handed out, and the owner can release such a name.
 *
 * The record itself is `AddressHolder` from `@shared/publish`, and there is
 * deliberately no copy of it here: exactly this goes out in the body of the
 * 409 refusal, and the panel decides by it whether to show "Release the
 * former address". A second declaration would drift apart on the very first
 * field change.
 */
export function addressHolder(kind: AddressKind, slug: string): AddressHolder | null {
  const found = kind === 'course' ? findCourse(slug) : findPublication(slug)
  if (!found) return null
  const live = found.slug === slug
  const name = kind === 'course' ? (found as Course).name : (found as Publication).title
  return { kind, id: found.id, name, former: !live }
}

/**
 * Release one's own former name.
 *
 * A former address is held forever, and for good reason: a link with it is
 * written in the group chat. But the course "ml-2025", renamed to
 * "ml-2025-fall", held "ml-2025" against next year's course too, forever, and
 * there was no way to free it except deleting the owning course. Only the
 * owner releases, and only a former name: a live one is dropped by changing
 * the name, someone else's is not touched at all.
 *
 * The price is stated out loud: the pointer at this address disappears from
 * the export, and the old link becomes a 404. That is the owner's decision,
 * not a side effect.
 */
export function releaseFormerSlug(kind: AddressKind, id: string, slug: string): boolean {
  if (addressOwner(kind, slug) !== id) return false
  forgetAddress.run(kind, slug)
  return true
}

/* ---------------------------------------------------------------- courses */

interface CourseRow {
  id: string
  slug: string | null
  name: string
  blurb: string | null
  created_at: number
  created_by: string | null
  items: string
  rev: number
}

function toCourse(row: CourseRow): Course {
  let items: CourseItem[] = []
  try {
    const parsed: unknown = JSON.parse(row.items)
    if (Array.isArray(parsed)) items = parsed as CourseItem[]
  } catch {
    // A corrupted row means a course without seminars, not a course that cannot be read.
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    blurb: row.blurb,
    createdAt: row.created_at,
    createdBy: row.created_by,
    items,
    rev: row.rev,
  }
}

const insertCourse = db.prepare(`
  INSERT INTO courses (id, name, blurb, created_at, created_by, items, rev)
  VALUES (?, ?, ?, ?, ?, '[]', 0)
`)
const selectCourse = db.prepare('SELECT * FROM courses WHERE id = ?')
/*
 * By name OR by id, in one query.
 *
 * The promise of a permanent address: a link handed out with the
 * eight-character id must keep working after the course is given a human
 * name. Breaking it for the sake of a prettier new address is exactly what
 * this section must never do.
 */
const selectCourseByAny = db.prepare('SELECT * FROM courses WHERE id = ? OR slug = ? LIMIT 1')
const updateCourseSlug = db.prepare('UPDATE courses SET slug = ? WHERE id = ?')
const selectCourses = db.prepare('SELECT * FROM courses ORDER BY created_at DESC')
const updateCourseMeta = db.prepare('UPDATE courses SET name = ?, blurb = ? WHERE id = ?')
const updateCourseItems = db.prepare(
  'UPDATE courses SET items = ?, rev = rev + 1 WHERE id = ? AND rev = ?',
)
const deleteCourseRow = db.prepare('DELETE FROM courses WHERE id = ?')

export function createCourse(name: string, blurb: string | null, by: string | null): Course {
  const id = newId()
  insertCourse.run(
    id,
    clip(name, MAX_COURSE_NAME),
    clip(blurb, MAX_COURSE_BLURB) || null,
    Date.now(),
    by,
  )
  return getCourse(id)!
}

export function getCourse(id: string): Course | null {
  const row = selectCourse.get(id) as CourseRow | undefined
  return row ? toCourse(row) : null
}

/** A course by address, name or id. Both lead to the same place. */
export function findCourse(handle: string): Course | null {
  const row = selectCourseByAny.get(handle, handle) as CourseRow | undefined
  if (row) return toCourse(row)
  // And by a former name: a rename does not cancel a link handed out under it.
  const was = addressOwner('course', handle)
  return was ? getCourse(was) : null
}

/**
 * Give a course a name in its address.
 *
 * `null` removes the name; one taken by someone else is a refusal, not a
 * silent overwrite: two courses at one address mean that one of them has
 * vanished for those it was already given to.
 */
export function setCourseSlug(id: string, slug: string | null): 'ok' | 'taken' {
  const current = getCourse(id)
  if (slug !== null) {
    const owner = findCourse(slug)
    if (owner && owner.id !== id) return 'taken'
  }
  updateCourseSlug.run(slug, id)
  moveAddress('course', id, current?.slug ?? null, slug)
  return 'ok'
}

export function listCourses(): Course[] {
  return (selectCourses.all() as CourseRow[]).map(toCourse)
}

export function renameCourse(id: string, name: string, blurb: string | null): Course | null {
  const current = getCourse(id)
  if (!current) return null
  updateCourseMeta.run(
    clip(name, MAX_COURSE_NAME) || current.name,
    blurb === null ? null : clip(blurb, MAX_COURSE_BLURB) || null,
    id,
  )
  return getCourse(id)
}

/**
 * Rewrite a course's contents and order, if nobody changed it under us.
 *
 * Compare-and-swap, not last-write-wins: teacher rights on an instance are
 * shared, the seminars screen re-reads itself, and two people rearranging one
 * course in the same minute would otherwise silently lose each other's order.
 * A mismatch returns `null`, and the screen shows the list as it is now.
 */
export function setCourseItems(id: string, rev: number, items: CourseItem[]): Course | null {
  const res = updateCourseItems.run(JSON.stringify(items), id, rev)
  return res.changes === 1 ? getCourse(id) : null
}

export function deleteCourse(id: string): void {
  deleteCourseRow.run(id)
  // A deleted course's addresses are freed: they have nothing left to point to.
  forgetAddressesOf.run('course', id)
}

/**
 * Remove a seminar from all courses, leaving a tombstone.
 *
 * The row stays with its name and date: a course from which the fourth week
 * silently disappeared is broken for whoever attended it, and the numbering
 * of the rest shifts and stops matching the schedule.
 *
 * And with the read link, if the reading was kept. Deleting a room keeps the
 * page by default (a link cannot be recalled from students), but its
 * `session_id` is cleared, and a tombstone without that link became a dead
 * end: the page opens at its direct address, but it cannot be reached from
 * the course. `orphanPublication` puts the link into the row while the
 * connection still exists; if it is not there, we look it up ourselves, since
 * a seminar may be buried while its page is alive.
 */
export function entombSeminar(sessionId: string, name: string): void {
  const live = publicationOf(sessionId)
  for (const course of listCourses()) {
    let touched = false
    const items = course.items.map((item) => {
      if (item.kind !== 'seminar' || item.sessionId !== sessionId) return item
      touched = true
      const link = item.publication ?? live
      return {
        kind: 'gone' as const,
        name,
        at: Date.now(),
        publication: link ? { id: link.id, slug: link.slug } : null,
      }
    })
    if (touched) setCourseItems(course.id, course.rev, items)
  }
}

/**
 * Remove from tombstones a link to a page that no longer exists.
 *
 * A publication can be deleted entirely, and then a course row promising "the
 * page remains" promises a 404.
 */
export function forgetPublicationInCourses(pubId: string): void {
  for (const course of listCourses()) {
    let touched = false
    const items = course.items.map((item) => {
      if (item.kind !== 'gone' || item.publication?.id !== pubId) return item
      touched = true
      return { kind: 'gone' as const, name: item.name, at: item.at, publication: null }
    })
    if (touched) setCourseItems(course.id, course.rev, items)
  }
}

/* ----------------------------------------------------------- publications */

interface PublicationRow {
  id: string
  slug: string | null
  session_id: string | null
  title: string
  state: string
  published_at: number
  published_by: string | null
  revision: number
  orphaned_at: number | null
}

export interface Publication {
  id: string
  slug: string | null
  sessionId: string | null
  title: string
  state: PublicationState
  publishedAt: number
  publishedBy: string | null
  revision: number
  orphanedAt: number | null
}

function toPublication(row: PublicationRow): Publication {
  return {
    id: row.id,
    slug: row.slug,
    sessionId: row.session_id,
    title: row.title,
    state: row.state === 'withdrawn' ? 'withdrawn' : 'published',
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    revision: row.revision,
    orphanedAt: row.orphaned_at,
  }
}

const selectPub = db.prepare('SELECT * FROM publications WHERE id = ?')
const selectPubByAny = db.prepare('SELECT * FROM publications WHERE id = ? OR slug = ? LIMIT 1')
const updatePubSlug = db.prepare('UPDATE publications SET slug = ? WHERE id = ?')
const selectPubForSession = db.prepare('SELECT * FROM publications WHERE session_id = ?')
const selectPubs = db.prepare('SELECT * FROM publications ORDER BY published_at DESC')
const insertPub = db.prepare(`
  INSERT INTO publications (id, session_id, title, state, published_at, published_by, revision)
  VALUES (@id, @session_id, @title, 'published', @published_at, @published_by, 1)
`)
const bumpPub = db.prepare(`
  UPDATE publications
  SET title = ?, state = 'published', published_at = ?, published_by = ?, revision = revision + 1
  WHERE id = ?
`)
const setPubState = db.prepare('UPDATE publications SET state = ? WHERE id = ?')
const orphanPub = db.prepare(
  'UPDATE publications SET session_id = NULL, orphaned_at = ? WHERE session_id = ?',
)
const deletePubRow = db.prepare('DELETE FROM publications WHERE id = ?')

const clearSteps = db.prepare('DELETE FROM publication_steps WHERE pub = ?')
const insertStep = db.prepare(`
  INSERT INTO publication_steps (pub, seq, ord, label, at, page)
  VALUES (@pub, @seq, @ord, @label, @at, @page)
`)
/*
 * Headings without the page itself.
 *
 * `page` is all of a step's text outputs in full: the training log,
 * tracebacks, tables in text/html. Reading and parsing them for the sake of
 * one number used to happen on every public course request, in the very
 * process that is running a class at that minute. SQLite counts the array
 * length; `json_valid` is for a row not written by us: a corrupted page must
 * give zero, not a query error.
 */
const selectHeadings = db.prepare(`
  SELECT seq, label, at,
         CASE WHEN json_valid(page) THEN json_array_length(page) ELSE 0 END AS cell_count
  FROM publication_steps WHERE pub = ? ORDER BY ord
`)
const countSteps = db.prepare('SELECT COUNT(*) AS n FROM publication_steps WHERE pub = ?')
const selectStep = db.prepare(
  'SELECT seq, label, at, page FROM publication_steps WHERE pub = ? AND seq = ?',
)
const selectFirstStep = db.prepare(
  'SELECT seq, label, at, page FROM publication_steps WHERE pub = ? ORDER BY ord LIMIT 1',
)

const clearBlobs = db.prepare('DELETE FROM publication_blobs WHERE pub = ?')
const insertBlob = db.prepare(
  'INSERT OR IGNORE INTO publication_blobs (pub, hash, mime, body) VALUES (?, ?, ?, ?)',
)
const selectBlob = db.prepare('SELECT mime, body FROM publication_blobs WHERE pub = ? AND hash = ?')

export function getPublication(id: string): Publication | null {
  const row = selectPub.get(id) as PublicationRow | undefined
  return row ? toPublication(row) : null
}

/** A publication by address: name, id or former name. */
export function findPublication(handle: string): Publication | null {
  const row = selectPubByAny.get(handle, handle) as PublicationRow | undefined
  if (row) return toPublication(row)
  const was = addressOwner('publication', handle)
  return was ? getPublication(was) : null
}

export function setPublicationSlug(id: string, slug: string | null): 'ok' | 'taken' {
  const current = getPublication(id)
  if (slug !== null) {
    const owner = findPublication(slug)
    if (owner && owner.id !== id) return 'taken'
  }
  updatePubSlug.run(slug, id)
  moveAddress('publication', id, current?.slug ?? null, slug)
  return 'ok'
}

export function publicationOf(sessionId: string): Publication | null {
  const row = selectPubForSession.get(sessionId) as PublicationRow | undefined
  return row ? toPublication(row) : null
}

/**
 * All pages, including those with no room behind them any more.
 *
 * An orphaned publication can no longer be found at any panel address: the
 * seminar is gone, and the withdrawal routes are keyed by its id. Without
 * this list such a page could only be withdrawn by editing the database by
 * hand.
 */
export function listPublications(): Publication[] {
  return (selectPubs.all() as PublicationRow[]).map(toPublication)
}

export interface BuiltStep {
  seq: number
  label: string
  at: number
  cells: PublicCell[]
}

/**
 * Write the whole publication: the steps and the large pieces of output.
 *
 * In one transaction, and the old steps are erased: a publication is a
 * snapshot, not an accumulation. The address is kept: a student with last
 * week's link lands in the same place.
 */
export function writePublication(input: {
  sessionId: string
  title: string
  by: string | null
  steps: BuiltStep[]
  blobs: { hash: string; mime: string; body: Buffer }[]
}): Publication {
  const existing = publicationOf(input.sessionId)
  const id = existing?.id ?? newId()
  const now = Date.now()
  /*
   * One moment, one row: `publication_steps` is keyed by the pair (pub, seq),
   * and two steps with the same `seq` brought down the whole transaction with
   * SQLITE_CONSTRAINT, that is, a 500 without a single word about the cause.
   * The last one wins: `seq: 0` is the permanent address of the last page,
   * and its route appends it at the end, over anything that might have come
   * in under the same number from outside.
   */
  const lastAt = new Map(input.steps.map((step, index) => [step.seq, index]))
  const steps = input.steps.filter((step, index) => lastAt.get(step.seq) === index)

  db.transaction(() => {
    if (existing) bumpPub.run(input.title, now, input.by, id)
    else
      insertPub.run({
        id,
        session_id: input.sessionId,
        title: input.title,
        published_at: now,
        published_by: input.by,
      })
    clearSteps.run(id)
    clearBlobs.run(id)
    steps.forEach((step, index) => {
      insertStep.run({
        pub: id,
        seq: step.seq,
        ord: index,
        label: clip(step.label, MAX_STEP_LABEL),
        at: step.at,
        page: JSON.stringify(step.cells),
      })
    })
    for (const blob of input.blobs) insertBlob.run(id, blob.hash, blob.mime, blob.body)
  })()
  // This page's rail is known right here: the steps were just assembled and
  // their cells counted. The order is the same as `ORDER BY ord`, the write
  // order.
  keepRail(
    id,
    steps.map((step) => ({
      seq: step.seq,
      label: clip(step.label, MAX_STEP_LABEL),
      at: step.at,
      cellCount: step.cells.length,
    })),
  )

  return getPublication(id)!
}

export function setPublicationState(id: string, state: PublicationState): void {
  setPubState.run(state, id)
}

/**
 * The seminar was deleted, but the reading was kept.
 *
 * The link to the page is moved into the course rows BEFORE the connection
 * to the room disappears: `session_id` is about to be cleared, and there will
 * be nothing to find the page by. Then a tombstone replaces the row, and the
 * link stays in it; otherwise the course, the only address the class is
 * given, leads to a dead end.
 */
export function orphanPublication(sessionId: string): void {
  const pub = publicationOf(sessionId)
  if (pub) {
    for (const course of listCourses()) {
      let touched = false
      const items = course.items.map((item) => {
        if (item.kind !== 'seminar' || item.sessionId !== sessionId) return item
        touched = true
        return {
          ...item,
          publication: {
            id: pub.id,
            slug: pub.slug,
            publishedAt: pub.publishedAt,
            steps: stepCount(pub.id),
          },
        }
      })
      if (touched) setCourseItems(course.id, course.rev, items)
    }
  }
  orphanPub.run(Date.now(), sessionId)
}

/** The seminar was deleted together with the reading. */
export function deletePublication(id: string): void {
  db.transaction(() => {
    clearSteps.run(id)
    clearBlobs.run(id)
    deletePubRow.run(id)
    forgetAddressesOf.run('publication', id)
  })()
  forgetRail(id)
  // The tombstone in the course promised "the page remains"; now it does not.
  forgetPublicationInCourses(id)
}

interface StepRow {
  seq: number
  label: string
  at: number
  page: string
}

interface HeadingRow {
  seq: number
  label: string
  at: number
  cell_count: number
}

function parsePage(row: StepRow): PublicCell[] {
  try {
    const parsed: unknown = JSON.parse(row.page)
    return Array.isArray(parsed) ? (parsed as PublicCell[]) : []
  } catch {
    return []
  }
}

/**
 * The step rail comes from memory, not from parsing pages on every public
 * request.
 *
 * SQLite counts the cells (`json_array_length` in `selectHeadings`), and that
 * costs a parse of the FULL text of every page: a page is all of a step's
 * text outputs, a training log of megabytes. The rail is asked for on every
 * open of the public page, that is, up to five hundred times in the first
 * minute of a review, and each time afresh, for the sake of forty small
 * numbers.
 *
 * A cache here is more reliable than any time to live: a publication's steps
 * change in exactly two ways, and both are in this file: republishing
 * (`writePublication`) and erasing (`deletePublication`). Withdrawing a page
 * does not touch the steps.
 *
 * Republishing does not reset the rail but PUTS it: the steps are assembled
 * and in memory at that moment, and there is no reason to count their cells
 * a second time, by parsing text at that. So exactly one parse remains: the
 * first read of a page published before the process started.
 *
 * A `cell_count` column would not cost even that and would survive a
 * restart, but the publication schema is held by db.ts ("one owner of the
 * schema"), and bringing in a second owner for one number is exactly the
 * price described there.
 */
const RAILS_KEPT = 200
const rails = new Map<string, StepHeading[]>()

function forgetRail(pub: string): void {
  rails.delete(pub)
}

function keepRail(pub: string, rail: StepHeading[]): void {
  // A semester has dozens of pages; the cap is here for an instance living
  // for years, and it evicts the oldest entry, not the whole memory at once.
  if (!rails.has(pub) && rails.size >= RAILS_KEPT) {
    const oldest = rails.keys().next()
    if (!oldest.done) rails.delete(oldest.value)
  }
  rails.set(pub, rail)
}

export function stepHeadings(pub: string): StepHeading[] {
  const known = rails.get(pub)
  // As a copy: the array is shared, and it goes out into response bodies,
  // where nobody is obliged to treat it as someone else's.
  if (known) return [...known]
  const built = (selectHeadings.all(pub) as HeadingRow[]).map((row) => ({
    seq: row.seq,
    label: row.label,
    at: row.at,
    cellCount: row.cell_count,
  }))
  keepRail(pub, built)
  return [...built]
}

/** How many steps, where only the number is needed. */
export function stepCount(pub: string): number {
  return Number((countSteps.get(pub) as { n: number }).n)
}

export function readStep(pub: string, seq: number | null): BuiltStep | null {
  const row = (seq === null ? selectFirstStep.get(pub) : selectStep.get(pub, seq)) as
    | StepRow
    | undefined
  if (!row) return null
  return { seq: row.seq, label: row.label, at: row.at, cells: parsePage(row) }
}

export function readBlob(pub: string, hash: string): { mime: string; body: Buffer } | null {
  const row = selectBlob.get(pub, hash) as { mime: string; body: Buffer } | undefined
  return row ? { mime: row.mime, body: row.body } : null
}
