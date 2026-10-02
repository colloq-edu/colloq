/**
 * Courses and publications: the queries against them.
 *
 * The SCHEMA of these tables (`courses`, `publications`, `publication_steps`,
 * `publication_blobs`, `publication_materials`, `page_files`) is not here but
 * in `db.ts`, together with the
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
import { tr } from '@shared/i18n'
import { randomBytes } from 'node:crypto'
import { db } from '../db.js'
import {
  isRoomAccess,
  MATERIAL_KINDS,
  MAX_COURSE_BLURB,
  MAX_COURSE_NAME,
  type AddressHolder,
  type AddressKind,
  type Course,
  type CourseItem,
  type CourseItemGone,
  type CourseRowFields,
  type MaterialKind,
  type OutlineEntry,
  type PublicCell,
  type PublicationState,
  type PublishSelection,
  type StepHeading,
} from '@shared/publish'
import { gcPageFiles } from './page-files.js'

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

function newId(length = 8): string {
  const bytes = randomBytes(length)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

/**
 * An id for a course row: 'r' and seven characters, unique within the
 * course. Rows used to be told apart by their position, and a position
 * shifts with every insertion; a class page, a picker and a PUT from an older
 * tab all need to name "this row" across that.
 */
export function newRowId(taken: Iterable<string | undefined>): string {
  const used = new Set(taken)
  for (;;) {
    const id = `r${newId(7)}`
    if (!used.has(id)) return id
  }
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

/** Former names: the routes answer them with the current address. */
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
 * The price is stated out loud: the old link stops leading anywhere and
 * becomes a 404. That is the owner's decision,
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
 * Rewrite matching rows in every course, retrying on a lost compare-and-swap.
 *
 * The tombstone helpers below used to call `setCourseItems` once and ignore
 * its `null`: a teacher saving the same course in that second silently kept
 * a seminar row pointing at a deleted room, or a tombstone promising a page
 * that was gone. A loss now re-reads the course and applies the change
 * again; `change` returns `null` for a row it leaves alone.
 */
export function rewriteCourseRows(change: (item: CourseItem) => CourseItem | null): void {
  for (const listed of listCourses()) {
    let course: Course | null = listed
    for (let attempt = 0; course; attempt++) {
      let touched = false
      const items = course.items.map((item) => {
        const next = change(item)
        if (next === null) return item
        touched = true
        return next
      })
      if (!touched || setCourseItems(course.id, course.rev, items)) break
      if (attempt >= 8) {
        console.error(`[courses] course ${course.id} kept changing; a row update was not saved`)
        break
      }
      course = getCourse(course.id)
    }
  }
}

/** The optional row fields a row carries, copied as they are (and only those it has). */
export function rowFieldsOf(item: CourseRowFields): CourseRowFields {
  const out: CourseRowFields = {}
  if (item.id !== undefined) out.id = item.id
  if (item.title !== undefined) out.title = item.title
  if (item.day !== undefined) out.day = item.day
  if (item.about !== undefined) out.about = item.about
  if (item.when !== undefined) out.when = item.when
  return out
}

/**
 * Remove a seminar from all courses, leaving a tombstone.
 *
 * The row stays with its name, its id, its title, its day and its «о чём»:
 * a course from which the fourth week silently disappeared is broken for
 * whoever attended it, and the numbering of the rest shifts and stops
 * matching the schedule.
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
  const at = Date.now()
  rewriteCourseRows((item) => {
    if (item.kind !== 'seminar' || item.sessionId !== sessionId) return null
    const link = item.publication ?? live
    const gone: CourseItemGone = {
      kind: 'gone',
      ...rowFieldsOf(item),
      name,
      at,
      publication: link ? { id: link.id, slug: link.slug } : null,
    }
    return gone
  })
}

/**
 * Remove from tombstones a link to a page that no longer exists.
 *
 * A publication can be deleted entirely, and then a course row promising "the
 * page remains" promises a 404.
 */
export function forgetPublicationInCourses(pubId: string): void {
  rewriteCourseRows((item) =>
    item.kind === 'gone' && item.publication?.id === pubId
      ? { kind: 'gone', ...rowFieldsOf(item), name: item.name, at: item.at, publication: null }
      : null,
  )
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
  first_at: number | null
  held_on: string | null
  selection: string | null
  materials_rev: number | null
  zip_bytes: number | null
}

export interface Publication {
  id: string
  slug: string | null
  sessionId: string | null
  title: string
  state: PublicationState
  /** The last build. */
  publishedAt: number
  publishedBy: string | null
  revision: number
  orphanedAt: number | null
  /** The first publish; `publishedAt` for a page from before this was kept. */
  firstAt: number
  /** The class day of a page outside a course. */
  heldOn: string | null
  selection: PublishSelection | null
  /** Equals `revision` when the materials are current (see db.ts). */
  materialsRev: number | null
  zipBytes: number
}

/** A stored selection, or `null` for anything that does not look like one. */
export function readSelection(text: string | null): PublishSelection | null {
  if (!text) return null
  try {
    const raw = JSON.parse(text) as Partial<PublishSelection>
    if (raw?.v !== 1 || !Array.isArray(raw.notebooks) || !Array.isArray(raw.files)) return null
    return {
      v: 1,
      notebooks: raw.notebooks.filter(
        (n): n is { root: string; name: string } =>
          typeof n?.root === 'string' && typeof n?.name === 'string',
      ),
      files: raw.files.filter(
        (f): f is { path: string; name: string } =>
          typeof f?.path === 'string' && typeof f?.name === 'string',
      ),
      autoRefresh: raw.autoRefresh !== false,
      ack: Array.isArray(raw.ack) ? raw.ack.filter((a): a is string => typeof a === 'string') : [],
      ...(Array.isArray(raw.seen)
        ? { seen: raw.seen.filter((a): a is string => typeof a === 'string') }
        : {}),
      ...(isRoomAccess(raw.roomAccess) ? { roomAccess: raw.roomAccess } : {}),
    }
  } catch {
    return null
  }
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
    firstAt: row.first_at ?? row.published_at,
    heldOn: row.held_on,
    selection: readSelection(row.selection),
    materialsRev: row.materials_rev,
    zipBytes: row.zip_bytes ?? 0,
  }
}

const selectPub = db.prepare('SELECT * FROM publications WHERE id = ?')
const selectPubByAny = db.prepare('SELECT * FROM publications WHERE id = ? OR slug = ? LIMIT 1')
const updatePubSlug = db.prepare('UPDATE publications SET slug = ? WHERE id = ?')
const selectPubForSession = db.prepare('SELECT * FROM publications WHERE session_id = ?')
const selectPubs = db.prepare('SELECT * FROM publications ORDER BY published_at DESC')
const insertPub = db.prepare(`
  INSERT INTO publications
    (id, session_id, title, state, published_at, published_by, revision,
     first_at, held_on, selection, materials_rev, zip_bytes)
  VALUES
    (@id, @session_id, @title, 'published', @now, @by, 1,
     @now, @held_on, @selection, 1, @zip_bytes)
`)
/*
 * On the right-hand side every column still has its OLD value: `revision`
 * and `materials_rev` both become old + 1, and `first_at` falls back to the
 * old `published_at`, the best guess there is for a page from before
 * `first_at` was kept.
 */
const bumpPub = db.prepare(`
  UPDATE publications
  SET title = @title, state = CASE WHEN @keep_state THEN state ELSE 'published' END,
      published_at = @now, published_by = @by,
      revision = revision + 1, materials_rev = revision + 1,
      first_at = COALESCE(first_at, published_at),
      held_on = CASE WHEN @keep_held THEN held_on ELSE @held_on END,
      selection = @selection, zip_bytes = @zip_bytes
  WHERE id = @id
`)
const setPubState = db.prepare('UPDATE publications SET state = ? WHERE id = ?')
const setPubSelection = db.prepare('UPDATE publications SET selection = ? WHERE id = ?')
const orphanPub = db.prepare(
  'UPDATE publications SET session_id = NULL, orphaned_at = ? WHERE session_id = ?',
)
const deletePubRow = db.prepare('DELETE FROM publications WHERE id = ?')

const clearSteps = db.prepare('DELETE FROM publication_steps WHERE pub = ?')
const insertStep = db.prepare(`
  INSERT INTO publication_steps (pub, seq, ord, label, at, page)
  VALUES (@pub, @seq, @ord, @label, @at, @page)
`)
const selectHeadings = db.prepare(`
  SELECT seq, label, at,
         CASE WHEN json_valid(page) THEN json_array_length(page) ELSE 0 END AS cell_count
  FROM publication_steps WHERE pub = ? ORDER BY ord
`)
const selectStep = db.prepare(
  'SELECT seq, label, at, page FROM publication_steps WHERE pub = ? AND seq = ?',
)
const selectFirstStep = db.prepare(
  'SELECT seq, label, at, page FROM publication_steps WHERE pub = ? ORDER BY ord LIMIT 1',
)

const selectLegacyStep = db.prepare(`
  SELECT seq, label, at, page FROM publication_steps WHERE pub = ?
  ORDER BY CASE WHEN seq = 0 THEN 0 ELSE 1 END, ord DESC LIMIT 1
`)

const clearBlobs = db.prepare('DELETE FROM publication_blobs WHERE pub = ?')
const insertBlob = db.prepare(
  'INSERT OR IGNORE INTO publication_blobs (pub, hash, mime, body) VALUES (?, ?, ?, ?)',
)
const selectBlob = db.prepare('SELECT mime, body FROM publication_blobs WHERE pub = ? AND hash = ?')

const clearMaterials = db.prepare('DELETE FROM publication_materials WHERE pub = ?')
const insertMaterial = db.prepare(`
  INSERT INTO publication_materials
    (pub, key, ord, kind, name, path, hash, bytes, cells, outline, cell_count, output_count)
  VALUES
    (@pub, @key, @ord, @kind, @name, @path, @hash, @bytes,
     @cells, @outline, @cell_count, @output_count)
`)
const selectMaterials = db.prepare(`
  SELECT key, ord, kind, name, path, hash, bytes, outline, cell_count, output_count
  FROM publication_materials WHERE pub = ? ORDER BY ord
`)
const selectMaterialCells = db.prepare(
  "SELECT cells FROM publication_materials WHERE pub = ? AND key = ? AND kind = 'notebook'",
)
const countMaterials = db.prepare('SELECT COUNT(*) AS n FROM publication_materials WHERE pub = ?')
const selectHasNotebook = db.prepare(
  "SELECT 1 AS one FROM publication_materials WHERE pub = ? AND key = ? AND kind = 'notebook'",
)
const deleteMaterialRow = db.prepare('DELETE FROM publication_materials WHERE pub = ? AND key = ?')
const selectNotebookCells = db.prepare(`
  SELECT cells FROM publication_materials
  WHERE pub = ? AND kind = 'notebook' AND cells IS NOT NULL
`)
const selectBlobHashes = db.prepare('SELECT hash FROM publication_blobs WHERE pub = ?')
const deleteBlobRow = db.prepare('DELETE FROM publication_blobs WHERE pub = ? AND hash = ?')
const bumpForRemoval = db.prepare(`
  UPDATE publications
  SET revision = revision + 1, materials_rev = revision + 1,
      selection = @selection, zip_bytes = @zip_bytes
  WHERE id = @id
`)
/*
 * The rollback step follows the page's first notebook: a 0.12 brought back
 * after a removal must not show the notebook the teacher just took down.
 */
const refreshLegacyStep = db.prepare(`
  UPDATE publication_steps
  SET page = COALESCE(
    (SELECT cells FROM publication_materials
     WHERE pub = @pub AND kind = 'notebook' AND cells IS NOT NULL ORDER BY ord LIMIT 1),
    '[]')
  WHERE pub = @pub AND seq = 0
`)

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

/* --------------------------------------------------------------- materials */

/** One material of a page, as the build hands it over and the store keeps it. */
export interface StoredMaterial {
  key: string
  kind: MaterialKind
  name: string
  /** Room-relative path; the ZIP and the download name come from it. */
  path: string
  /** page_files.hash of the downloadable bytes, put there BEFORE the write. */
  hash: string
  bytes: number
  /** Notebooks only: the projected cells, the outline and the counts. */
  cells?: PublicCell[] | null
  outline?: OutlineEntry[] | null
  cellCount?: number | null
  outputCount?: number | null
}

/** A material as read back, without its cells. */
export interface MaterialRow {
  key: string
  ord: number
  kind: MaterialKind
  name: string
  path: string
  hash: string
  bytes: number
  outline: OutlineEntry[]
  cellCount: number | null
  outputCount: number | null
}

interface MaterialDbRow {
  key: string
  ord: number
  kind: string
  name: string
  path: string
  hash: string
  bytes: number
  outline: string | null
  cell_count: number | null
  output_count: number | null
}

function parseOutline(text: string | null): OutlineEntry[] {
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as OutlineEntry[]) : []
  } catch {
    return []
  }
}

export function listMaterials(pub: string): MaterialRow[] {
  return (selectMaterials.all(pub) as MaterialDbRow[]).map((row) => ({
    key: row.key,
    ord: row.ord,
    kind: (MATERIAL_KINDS as readonly string[]).includes(row.kind)
      ? (row.kind as MaterialKind)
      : 'file',
    name: row.name,
    path: row.path,
    hash: row.hash,
    bytes: row.bytes,
    outline: parseOutline(row.outline),
    cellCount: row.cell_count,
    outputCount: row.output_count,
  }))
}

export function materialCount(pub: string): number {
  return Number((countMaterials.get(pub) as { n: number }).n)
}

/** Whether the page has a notebook under this key: a cheap check before the heavy read. */
export function hasNotebook(pub: string, key: string): boolean {
  return selectHasNotebook.get(pub, key) !== undefined
}

/**
 * Take one material off a page: «Убрать со страницы».
 *
 * A change of the page like a build (revision and materials_rev grow, so
 * every cached notebook tab is asked again), but not a rebuild: the other
 * materials keep their bytes and `published_at` keeps meaning the last
 * build. `false` when there was no such material.
 */
export function dropMaterial(
  pub: string,
  key: string,
  change: { selection: PublishSelection | null; zipBytes: number },
): boolean {
  const dropped = db.transaction(() => {
    if (deleteMaterialRow.run(pub, key).changes === 0) return false
    bumpForRemoval.run({
      id: pub,
      selection: change.selection ? JSON.stringify(change.selection) : null,
      zip_bytes: Math.max(0, Math.round(change.zipBytes)),
    })
    refreshLegacyStep.run({ pub })
    pruneBlobs(pub)
    return true
  })()
  if (dropped) gcPageFiles()
  return dropped
}

/**
 * Drop the page's images and figures no remaining notebook refers to.
 *
 * The blobs are shared by all of a page's notebooks, so they cannot go with
 * the material row; but «Убрать со страницы» is exactly how a teacher takes
 * down a student's notebook or a screenshot with someone's data on it, and
 * an image left in publication_blobs stays served at /blob/<hash> to anyone
 * who loaded the page before. A reference is `blob:<hash>` in an output's
 * bundle or in a note's markdown (`blob:<hash>.png`), and the cells are the
 * text that holds them; the rollback step mirrors the first notebook.
 */
function pruneBlobs(pub: string): void {
  const kept = new Set<string>()
  for (const row of selectNotebookCells.all(pub) as { cells: string }[]) {
    for (const m of row.cells.matchAll(/blob:([0-9a-f]{32})/g)) kept.add(m[1])
  }
  for (const { hash } of selectBlobHashes.all(pub) as { hash: string }[]) {
    if (!kept.has(hash)) deleteBlobRow.run(pub, hash)
  }
}

/**
 * A notebook's cells as the stored JSON text, unparsed: the public route
 * puts it into the response body as it is, and parsing megabytes of outputs
 * only to print them again would cost the class's process for nothing.
 */
export function materialCellsText(pub: string, key: string): string | null {
  const row = selectMaterialCells.get(pub, key) as { cells: string | null } | undefined
  return row?.cells ?? null
}

/**
 * The label of the single step the store still writes, for 0.12.
 *
 * A rollback to 0.12 renders every page from `publication_steps`, so each
 * write keeps one row there: seq 0, the first notebook. Clipped like 0.12's
 * labels were (80 characters).
 */
const LEGACY_STEP_LABEL = 80

/**
 * Write the whole page: its materials, its images and the rollback step.
 *
 * One transaction, and everything of the previous build is replaced: a page
 * is a snapshot, not an accumulation. The address is kept: a student with
 * last week's link lands in the same place. `first_at` is kept too, while
 * `published_at` becomes now and `revision` grows by one.
 *
 * The files behind `materials[].hash` must already be in page_files
 * (page-files.ts · putPageFile); the GC after the commit removes whatever
 * the previous build referenced and this one does not.
 */
export function writePublication(input: {
  sessionId: string
  title: string
  by: string | null
  materials: StoredMaterial[]
  blobs: { hash: string; mime: string; body: Buffer }[]
  selection?: PublishSelection | null
  zipBytes?: number
  /** `undefined` keeps the stored day; `null` clears it. */
  heldOn?: string | null
  /**
   * Keep a withdrawn page withdrawn: a refresh rebuilds what is on the page,
   * it does not decide whether the page is public.
   */
  keepState?: boolean
}): Publication {
  const existing = publicationOf(input.sessionId)
  const id = existing?.id ?? newId()
  const now = Date.now()
  const selection = input.selection ? JSON.stringify(input.selection) : null
  const zipBytes = Math.max(0, Math.round(input.zipBytes ?? 0))
  const firstNotebook = input.materials.find((m) => m.kind === 'notebook' && m.cells)

  db.transaction(() => {
    if (existing) {
      bumpPub.run({
        id,
        title: input.title,
        now,
        by: input.by,
        keep_held: input.heldOn === undefined ? 1 : 0,
        keep_state: input.keepState ? 1 : 0,
        held_on: input.heldOn ?? null,
        selection,
        zip_bytes: zipBytes,
      })
    } else {
      insertPub.run({
        id,
        session_id: input.sessionId,
        title: input.title,
        now,
        by: input.by,
        held_on: input.heldOn ?? null,
        selection,
        zip_bytes: zipBytes,
      })
    }
    clearMaterials.run(id)
    input.materials.forEach((m, ord) => {
      insertMaterial.run({
        pub: id,
        key: m.key,
        ord,
        kind: m.kind,
        name: m.name,
        path: m.path,
        hash: m.hash,
        bytes: m.bytes,
        cells: m.cells ? JSON.stringify(m.cells) : null,
        outline: m.outline ? JSON.stringify(m.outline) : null,
        cell_count: m.cellCount ?? null,
        output_count: m.outputCount ?? null,
      })
    })
    clearBlobs.run(id)
    for (const blob of input.blobs) insertBlob.run(id, blob.hash, blob.mime, blob.body)
    clearSteps.run(id)
    insertStep.run({
      pub: id,
      seq: 0,
      ord: 0,
      label: tr('server.notebookAtPublication.33f04f').slice(0, LEGACY_STEP_LABEL),
      at: now,
      page: JSON.stringify(firstNotebook?.cells ?? []),
    })
  })()
  gcPageFiles()
  return getPublication(id)!
}

const adoptRow = db.prepare(`
  UPDATE publications
  SET materials_rev = revision, first_at = COALESCE(first_at, published_at), zip_bytes = ?,
      title = COALESCE(?, title)
  WHERE id = ?
`)

/**
 * Replace a page's materials WITHOUT counting it as a new build: the boot
 * migration of 0.12 pages (migrate-pages.ts). `revision`, `published_at` and
 * the steps stay as they were; `materials_rev` catches up with `revision`.
 * `title`, when given, replaces the stored one (the migration scrubs it).
 */
export function adoptMaterials(
  pub: string,
  materials: StoredMaterial[],
  zipBytes: number,
  title?: string,
): void {
  db.transaction(() => {
    clearMaterials.run(pub)
    materials.forEach((m, ord) => {
      insertMaterial.run({
        pub,
        key: m.key,
        ord,
        kind: m.kind,
        name: m.name,
        path: m.path,
        hash: m.hash,
        bytes: m.bytes,
        cells: m.cells ? JSON.stringify(m.cells) : null,
        outline: m.outline ? JSON.stringify(m.outline) : null,
        cell_count: m.cellCount ?? null,
        output_count: m.outputCount ?? null,
      })
    })
    adoptRow.run(Math.max(0, Math.round(zipBytes)), title ?? null, pub)
  })()
}

/**
 * The page a 0.12 build left: its last step (seq 0, else the one rail-last),
 * or `null` when it has none.
 */
export function legacyPage(pub: string): PublicCell[] | null {
  const row = selectLegacyStep.get(pub) as StepRow | undefined
  return row ? parsePage(row) : null
}

export function setPublicationState(id: string, state: PublicationState): void {
  setPubState.run(state, id)
}

/**
 * Rewrite a page's saved pick and nothing else: no revision, no
 * `published_at`, no materials. A setting that lives in the pick (the room
 * door) changes how the page behaves, not what is on it, so saving it must
 * not cost a build or invalidate every cached notebook tab.
 */
export function savePublicationSelection(id: string, selection: PublishSelection): void {
  setPubSelection.run(JSON.stringify(selection), id)
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
    const link = {
      id: pub.id,
      slug: pub.slug,
      publishedAt: pub.publishedAt,
      materials: materialCount(pub.id),
    }
    rewriteCourseRows((item) =>
      item.kind === 'seminar' && item.sessionId === sessionId
        ? { ...item, publication: link }
        : null,
    )
  }
  orphanPub.run(Date.now(), sessionId)
}

/** The seminar was deleted together with the reading. */
export function deletePublication(id: string): void {
  db.transaction(() => {
    clearSteps.run(id)
    clearBlobs.run(id)
    clearMaterials.run(id)
    deletePubRow.run(id)
    forgetAddressesOf.run('publication', id)
  })()
  gcPageFiles()
  // The tombstone in the course promised "the page remains"; now it does not.
  forgetPublicationInCourses(id)
}

/* ------------------------------------------------- the 0.12 step, read back */

/*
 * One step per page now: seq 0, dual-written for a rollback to 0.12. Only the
 * tests of that dual-write read it back; these go with publication_steps.
 */

export interface BuiltStep {
  seq: number
  label: string
  at: number
  cells: PublicCell[]
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

export function stepHeadings(pub: string): StepHeading[] {
  return (selectHeadings.all(pub) as HeadingRow[]).map((row) => ({
    seq: row.seq,
    label: row.label,
    at: row.at,
    cellCount: row.cell_count,
  }))
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
