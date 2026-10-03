import { tr } from '@shared/i18n'
/**
 * Courses and publications: both what the teacher does and what the student
 * reads.
 *
 * The public half asks for nothing, neither a name nor a login, and so serves
 * only what is already assembled in `publication_materials`. No unfolding of a
 * Yjs document on a public request: that is multi-megabyte work in the same
 * process that is running a class at that minute, with no rate limit at all.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { ownerOnly, requireStaff, currentStaff } from '../admin/auth.js'
import { recordAdminEvent } from '../admin/audit-log.js'
import { getSession } from '../db.js'
import { isClassDay } from '@shared/class-day'
import { MATERIAL_KEY_RE } from '@shared/materials'
import {
  isRoomAccess,
  spillContentType,
  MATERIAL_NOT_FOUND,
  MAX_CLASS_ABOUT,
  MAX_COURSE_BLURB,
  MAX_COURSE_NAME,
  MAX_PLANNED_WHEN,
  PUBLICATION_NOT_FOUND,
  ROBOTS_TAG,
  STEPS_GONE,
  publicationAddress,
  slugOk,
  type CourseItem,
  type CourseRowFields,
} from '@shared/publish'
import {
  courseRows,
  forgetCourseIndex,
  freshCourseItems,
  pageContext,
  pageDay,
  publicCourseView,
  publicPageView,
  zipContextOf,
} from './course-view.js'
import { SESSION_MISSING } from '@shared/protocol'
import {
  buildAndWrite,
  downloadTypeOf,
  orphanPublishInfo,
  publishInfo,
  readPublishRequest,
  refreshPage,
  removeMaterial,
  setRoomAccess,
  type BuildResult,
} from '../publish/materials.js'
import { pageFileInfo, pageFilePath } from '../publish/page-files.js'
import { readDoorTokens, roomDoor } from '../publish/room-door.js'
import { addressForLimits } from '../net/inbound.js'
import { tooOften } from '../net/too-often.js'
import {
  folderZipPlan,
  leaveZip,
  waitForZip,
  ZIP_IDLE_MS,
  zipPlan,
  zipStream,
  type ZipPlan,
} from '../publish/zip.js'
import {
  addressHolder,
  createCourse,
  deleteCourse,
  deletePublication,
  getCourse,
  findCourse,
  findPublication,
  formerSlugs,
  getPublication,
  hasNotebook,
  listCourses,
  listMaterials,
  listPublications,
  materialCellsText,
  materialCount,
  newRowId,
  publicationOf,
  readBlob,
  releaseFormerSlug,
  renameCourse,
  setCourseItems,
  setCourseSlug,
  setPublicationSlug,
  setPublicationState,
  type Publication,
} from '../publish/store.js'

const str = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

function bad(res: Response, message: string): void {
  res.status(400).json({ error: message })
}

/**
 * A public page changed state: the audit log records who withdrew, restored or
 * erased it (admin/audit-log.ts). Pages outlive their rooms and can carry a
 * class's work to anyone with the link, so these are the staff decisions the
 * log exists for.
 */
function recordPublication(
  req: Request,
  action: 'publication.withdrawn' | 'publication.restored' | 'publication.deleted',
  pub: { id: string; title: string; sessionId: string | null },
): void {
  recordAdminEvent({
    actor: currentStaff(req),
    action,
    target: { type: 'publication', id: pub.id, label: pub.title },
    ...(pub.sessionId ? { detail: { room: pub.sessionId } } : {}),
    req,
  })
}

/**
 * Whether the request already holds this version: a 304 and no body.
 *
 * The header may carry a list of tags with `W/` before each, so the
 * comparison goes word by word, not on the whole string.
 */
function holds(req: Request, etag: string): boolean {
  const asked = req.headers['if-none-match']
  if (typeof asked !== 'string') return false
  const bare = etag.replace(/^W\//, '')
  return asked.split(',').some((one) => {
    const tag = one.trim()
    return tag === '*' || tag === etag || tag.replace(/^W\//, '') === bare
  })
}

/**
 * A notebook tab that has not changed: a 304 before a single heavy read.
 *
 * The tag is the page's `materials_rev` and the key, known from one indexed
 * row, and the cells (megabytes of outputs) are read only after this check.
 * `max-age` is small and without `immutable`: the address is permanent, but
 * the page is rebuilt after every class, and an eternal cache would mean
 * last week's notebook for whoever opened the tab before the rebuild.
 */
const PUBLIC_MAX_AGE_S = 300

/** A page's image: content-addressed, but a takedown has to reach caches (see the blob route). */
const BLOB_MAX_AGE_S = 3600

function fresh(req: Request, res: Response, tag: string): boolean {
  const etag = `W/"${tag}"`
  res.setHeader('etag', etag)
  res.setHeader('cache-control', `public, max-age=${PUBLIC_MAX_AGE_S}`)
  if (!holds(req, etag)) return false
  res.status(304).end()
  return true
}

/**
 * A course or class page: tagged by its body, and asked again every time.
 *
 * These bodies depend on more than one row (the course's live room names,
 * the neighbours' pages, «сегодня»), so no single revision is their
 * version. The hash of the body is, and `no-cache` makes the browser ask
 * each time: the answer costs the server the same, the phone a 304.
 */
function sendTagged(req: Request, res: Response, body: unknown): void {
  const text = JSON.stringify(body)
  const etag = `W/"${createHash('sha1').update(text).digest('base64url')}"`
  res.setHeader('etag', etag)
  res.setHeader('cache-control', 'no-cache')
  if (holds(req, etag)) {
    res.status(304).end()
    return
  }
  res.type('application/json').send(text)
}

/** A published page by any of its addresses, or `null` for one gone or withdrawn. */
function livePage(handle: string): Publication | null {
  const pub = findPublication(handle)
  return pub && pub.state === 'published' ? pub : null
}

/**
 * `filename*` per RFC 5987, plus a plain `filename` for clients that know
 * only that one: «Слайды лекции.pdf» must not arrive as `download`.
 */
function disposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'download'
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path

/**
 * A rejected promise goes to the error handler, not into the void.
 *
 * Express 4 knows nothing about async: what is thrown after the first `await`
 * never reaches the error middleware, and the request never answers. The same
 * wrapper as in routes/admin-import.ts, for the same reason.
 */
const wrap =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next)
  }

/**
 * The course rows with live seminar names and page links, for the panel; the
 * public course page is built from the same rows (routes/course-view.ts).
 */
const freshItems = freshCourseItems

/*
 * The room door is asked once per page view, so a lecture hall behind one
 * NAT opening the course at the bell is a hundred knocks in a minute; a loop
 * spends the ceiling within seconds. Each knock verifies up to fifty HMACs,
 * which is cheap, but a public door has no reason to do it without end.
 */
const doorKnocks = new Map<string, number[]>()
const DOOR_WINDOW_MS = 60_000
const MAX_DOOR_KNOCKS = 120

/**
 * The common half of both door routes: the per-address ceiling, then the
 * tokens. `null` means the refusal was already sent. The answer depends on
 * the caller's cookie and tokens, so nothing on the way may keep it.
 */
function doorTokens(req: Request, res: Response): string[] | null {
  res.setHeader('cache-control', 'no-store')
  if (tooOften(doorKnocks, addressForLimits(req), DOOR_WINDOW_MS, MAX_DOOR_KNOCKS)) {
    res.setHeader('retry-after', String(DOOR_WINDOW_MS / 1000))
    res.status(429).json({ error: tr('server.roomDoor.tooOften') })
    return null
  }
  const tokens = readDoorTokens(req.body)
  if (!tokens) {
    res.status(400).json({ error: tr('server.roomDoor.badTokens') })
    return null
  }
  return tokens
}

/**
 * An archive, through the line (publish/zip.ts · waitForZip): three at a
 * time per page and six per instance, the rest wait for a slot, and only one
 * that waited too long hears «через минуту». A stream that stops moving is
 * dropped, so a paused download cannot keep a slot from the class.
 *
 * `plan` is asked after the wait, against the page as it is then: it may
 * have been rebuilt or withdrawn while the download waited. An `error` from
 * it is a 404 in those words.
 */
function sendArchive(
  res: Response,
  next: NextFunction,
  pubId: string,
  plan: () => { plan: ZipPlan } | { error: string },
): void {
  const gone = new AbortController()
  let entered = false
  let left = false
  const leave = () => {
    if (!entered || left) return
    left = true
    leaveZip(pubId)
  }
  // Before the answer this means the client left the line; after it, the download ended.
  res.on('close', () => {
    gone.abort()
    leave()
  })
  waitForZip(pubId, { signal: gone.signal })
    .then((admitted) => {
      if (!admitted) {
        if (gone.signal.aborted) return
        res.setHeader('retry-after', '60')
        res.status(429).json({ error: tr('server.zip.busy') })
        return
      }
      entered = true
      if (gone.signal.aborted) return leave()
      const made = plan()
      if ('error' in made) {
        leave()
        res.status(404).json({ error: made.error })
        return
      }
      const archive = made.plan
      res.setHeader('content-type', 'application/zip')
      res.setHeader('content-length', String(archive.bytes))
      res.setHeader('content-disposition', disposition('attachment', `${archive.top}.zip`))
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('x-robots-tag', ROBOTS_TAG)
      res.setHeader('cache-control', 'no-cache')
      /*
       * The socket's idle timer: it fires when no bytes have moved for the
       * whole span, which is exactly a reader that stopped reading
       * (backpressure leaves the writes pending). Destroying the response
       * fires 'close' above, which frees the slot.
       */
      res.setTimeout(ZIP_IDLE_MS, () => res.destroy())
      pipeline(zipStream(archive), res).catch((err: unknown) => {
        if (!res.writableEnded) {
          const why = err instanceof Error ? err.message : err
          console.error(`[pages] archive ${archive.top}.zip of ${pubId} broke off:`, why)
        }
        res.destroy()
      })
    })
    .catch((err: unknown) => {
      leave()
      next(err)
    })
}

/**
 * A folder material as its own ZIP (`data.zip` with `data/` inside), through
 * the same line as the class archive: it reads the same disk. The folder is
 * looked up again after the wait, by its key, on the page as it is then.
 */
function sendFolder(
  res: Response,
  next: NextFunction,
  pub: Publication,
  handle: string,
  key: string,
): void {
  sendArchive(res, next, pub.id, () => {
    const now = livePage(handle)
    if (!now) return { error: PUBLICATION_NOT_FOUND }
    const folder = listMaterials(now.id).find((m) => m.key === key && m.kind === 'folder')
    if (!folder || (folder.files ?? []).length === 0) return { error: MATERIAL_NOT_FOUND }
    const day = pageDay(pageContext(now).row, now)
    const plan = folderZipPlan(folder, day, { verify: true })
    return plan.entries.length > 0 ? { plan } : { error: MATERIAL_NOT_FOUND }
  })
}

/** A material's bytes from the page-file store: a download, or a PDF opened in place. */
function sendMaterial(
  req: Request,
  res: Response,
  next: NextFunction,
  how: 'attachment' | 'inline',
): void {
  const pub = livePage(req.params.id)
  if (!pub) {
    res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    return
  }
  const material = listMaterials(pub.id).find((m) => m.key === req.params.key)
  if (material?.kind === 'folder' && how === 'attachment') {
    sendFolder(res, next, pub, req.params.id, material.key)
    return
  }
  const info = material && material.kind !== 'folder' ? pageFileInfo(material.hash) : null
  if (!material || !info || (how === 'inline' && material.kind !== 'pdf')) {
    res.status(404).json({ error: MATERIAL_NOT_FOUND })
    return
  }
  const file = pageFilePath(material.hash)
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    console.error(`[pages] ${material.hash} is missing from data/page-files`)
    res.status(404).json({ error: MATERIAL_NOT_FOUND })
    return
  }
  const etag = `"${material.hash}"`
  res.setHeader('etag', etag)
  res.setHeader('cache-control', `public, max-age=${PUBLIC_MAX_AGE_S}`)
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-robots-tag', ROBOTS_TAG)
  if (how === 'inline') {
    res.setHeader('content-type', 'application/pdf')
  } else {
    res.setHeader('content-type', downloadTypeOf(material.path))
    res.setHeader('content-security-policy', "sandbox; default-src 'none'")
  }
  res.setHeader('content-disposition', disposition(how, baseName(material.path)))
  if (holds(req, etag)) {
    res.status(304).end()
    return
  }
  res.setHeader('content-length', String(size))
  pipeline(fs.createReadStream(file), res).catch(() => res.destroy())
}

/** Whether a stored row is the one an id-less request row means: by its own key. */
function sameRow(item: CourseItem, raw: Record<string, unknown>): boolean {
  if (item.kind !== raw.kind) return false
  if (item.kind === 'seminar') return item.sessionId === raw.sessionId
  if (item.kind === 'gone') return item.name === raw.name && item.at === Number(raw.at)
  return item.name === str(raw.name, MAX_COURSE_NAME) && item.when === str(raw.when, MAX_PLANNED_WHEN)
}

/**
 * A text field of a row: absent keeps the stored value, `null` (or an empty
 * string) clears it, anything else is clipped.
 */
function textField(
  value: unknown,
  stored: string | null | undefined,
  max: number,
): string | null | undefined {
  if (value === undefined) return stored
  if (value === null) return null
  if (typeof value !== 'string') return stored
  return value.trim().slice(0, max) || null
}

/**
 * The optional fields of one incoming row, merged with the stored row it
 * matches; a refusal in words for a day that is not a calendar date.
 *
 * Seating a room into a plan row keeps that row's topic as the title
 * students see: the room may be called «Неделя 4 (повтор)», the class is
 * still «Лики и хаки данных».
 */
function rowFields(raw: Record<string, unknown>, known: CourseItem | undefined): CourseRowFields | string {
  const seated = known?.kind === 'planned' && raw.kind !== 'planned'
  const storedTitle = seated ? (known.title ?? known.name) : known?.title
  let day: string | null | undefined
  if (raw.day === undefined) day = known?.day
  else if (raw.day === null || raw.day === '') day = null
  else if (isClassDay(raw.day)) day = raw.day
  else return tr('server.course.badDay')
  const when =
    raw.when === undefined
      ? known?.when
      : typeof raw.when === 'string'
        ? raw.when.trim().slice(0, MAX_PLANNED_WHEN)
        : ''
  const fields: CourseRowFields = {}
  const title = textField(raw.title, storedTitle, MAX_COURSE_NAME)
  const about = textField(raw.about, known?.about, MAX_CLASS_ABOUT)
  if (title !== undefined) fields.title = title
  if (day !== undefined) fields.day = day
  if (about !== undefined) fields.about = about
  if (when) fields.when = when
  return fields
}

export function courseRoutes(): Router {
  const router = Router()

  /* ------------------------------------------------------------- panel */

  router.get('/api/admin/courses', requireStaff, (_req, res) => {
    res.json({
      courses: listCourses().map((course) => ({
        ...course,
        items: freshItems(course.items),
        // Former names travel with the course: the refusal "this address is
        // the former name of such-and-such course" sends you to its settings,
        // and there has to be something to show and release there.
        former: formerSlugs('course', course.id),
      })),
    })
  })

  router.post('/api/admin/courses', requireStaff, (req, res) => {
    const name = str(req.body?.name, MAX_COURSE_NAME)
    if (!name) return bad(res, tr("server.aCourseNeedsAName.42dad0"))
    const teacher = currentStaff(req)
    const course = createCourse(name, str(req.body?.blurb, MAX_COURSE_BLURB) || null, teacher?.name ?? null)
    recordAdminEvent({ actor: teacher, action: 'course.created', target: { type: 'course', id: course.id, label: course.name }, req })
    res.json({ course })
  })

  router.get('/api/admin/courses/:id', requireStaff, (req, res) => {
    const course = getCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    res.json({
      course: {
        ...course,
        items: freshItems(course.items),
        former: formerSlugs('course', course.id),
      },
    })
  })

  router.patch('/api/admin/courses/:id', requireStaff, (req, res) => {
    const course = getCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    const blurb =
      req.body?.blurb === undefined ? course.blurb : str(req.body.blurb, MAX_COURSE_BLURB) || null
    res.json({
      course: renameCourse(course.id, str(req.body?.name, MAX_COURSE_NAME) || course.name, blurb),
    })
  })

  /**
   * The contents and order, whole, with a version comparison.
   *
   * A mismatch is not an error but a race: someone rearranged the course
   * while this screen held the old one. The 409 answer carries the list as it
   * is now, so the screen shows the truth instead of arguing with it.
   *
   * Rows are matched to what is stored by id (an older tab that sends none,
   * by the row's own key: its room, its tombstone, its topic and week), and a
   * field the request does not mention keeps its stored value, while `null`
   * clears it. An admin tab opened before class days existed cannot wipe
   * them by saving the order. Ids are the server's: a row without a known one
   * gets a new one.
   */
  router.put('/api/admin/courses/:id/items', requireStaff, (req, res) => {
    const course = getCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    const incoming: unknown = req.body?.items
    if (!Array.isArray(incoming)) return bad(res, tr("server.itemsMustBeAnArray.399a2e"))

    const byId = new Map<string, CourseItem>()
    for (const item of course.items) if (item.id) byId.set(item.id, item)
    const claimed = new Set<CourseItem>()
    const ids = new Set<string | undefined>(course.items.map((item) => item.id))
    const knownFor = (raw: Record<string, unknown>): CourseItem | undefined => {
      const asked = typeof raw.id === 'string' ? byId.get(raw.id) : undefined
      const found =
        asked ??
        course.items.find(
          (item) =>
            !claimed.has(item) && (raw.id === undefined || !item.id) && sameRow(item, raw),
        )
      if (!found || claimed.has(found)) return undefined
      claimed.add(found)
      return found
    }

    const items: CourseItem[] = []
    for (const raw of incoming as Record<string, unknown>[]) {
      if (!raw || typeof raw !== 'object') continue
      const known = knownFor(raw)
      const fields = rowFields(raw, known)
      if (typeof fields === 'string') return bad(res, fields)
      const id = known?.id ?? newRowId(ids)
      ids.add(id)
      if (raw.kind === 'planned') {
        /*
         * A plan row without a topic is a refusal in words, not a
         * disappearance.
         *
         * Such a row used to be dropped silently with a 200: while plan rows
         * were created only by the script from the spreadsheet, it never sent
         * empty topics. Now they are typed by hand in the panel, and "Add"
         * with an empty topic would answer with a success after which the row
         * is gone, and the numbering of the other weeks no longer matches the
         * schedule.
         */
        const name = str(raw.name, MAX_COURSE_NAME)
        if (!name) return bad(res, tr('server.course.plannedNeedsTopic'))
        const when =
          raw.when === undefined && known?.kind === 'planned'
            ? known.when
            : str(raw.when, MAX_PLANNED_WHEN)
        const pause =
          raw.pause === undefined ? known?.kind === 'planned' && known.pause === true : raw.pause === true
        const { when: _carried, ...rest } = fields
        items.push({ kind: 'planned', id, ...rest, name, when, ...(pause ? { pause: true } : {}) })
        continue
      }
      if (raw.kind === 'gone') {
        /*
         * The link to the remaining reading survives rearranging the rows.
         *
         * If it was not sent, we take it from what is already recorded: a
         * screen that knows nothing about this link would otherwise erase it
         * on the very first save of the course, and the tombstone would become
         * a dead end again.
         */
        const name = str(raw.name, MAX_COURSE_NAME)
        const at = Number(raw.at) || (known?.kind === 'gone' ? known.at : Date.now())
        const sent = raw.publication as { id?: unknown } | null | undefined
        const pubId =
          typeof sent?.id === 'string'
            ? sent.id
            : (known?.kind === 'gone' && known.publication?.id) || null
        const pub = pubId ? getPublication(pubId) : null
        items.push({
          kind: 'gone',
          id,
          ...fields,
          name: name || (known?.kind === 'gone' ? known.name : ''),
          at,
          publication: pub ? { id: pub.id, slug: pub.slug } : null,
        })
        continue
      }
      const sessionId = str(raw?.sessionId, 64)
      const session = sessionId ? getSession(sessionId) : null
      if (!session) continue
      items.push({ kind: 'seminar', id, ...fields, sessionId, name: session.name, publication: null })
    }

    const rev = Number(req.body?.rev)
    const updated = Number.isFinite(rev) ? setCourseItems(course.id, rev, items) : null
    if (!updated) {
      const now = getCourse(course.id)!
      return res.status(409).json({
        error: tr("server.thisCourseHasAlreadyBeenChanged.70c236"),
        course: { ...now, items: freshItems(now.items) },
      })
    }
    // The room's course hint and the class pages see the new rows on the next request.
    forgetCourseIndex()
    res.json({ course: { ...updated, items: freshItems(updated.items) } })
  })

  /**
   * Erase a course: by an owner, and only by an owner.
   *
   * A course is the only address handed to a whole cohort (`/c/slug`), and
   * after deletion it answers 404 to everyone it was given to: both those in
   * the request and those not in it. That is exactly the line by which
   * deleting a seminar and "erase the page" are already owner-only ("takes
   * work away from people who are not in the request"), while the course
   * lived without it: any teacher, with one request, without confirmation and
   * with no way back.
   *
   * And a missing course is a 404, not a cheerful `{ok:true}`: "deleted"
   * about something that did not exist is a lie in the response.
   */
  router.delete('/api/admin/courses/:id', ownerOnly('delete a course'), (req, res) => {
    const course = getCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    deleteCourse(course.id)
    recordAdminEvent({ actor: currentStaff(req), action: 'course.deleted', target: { type: 'course', id: course.id, label: course.name }, req })
    res.json({ ok: true })
  })

  /**
   * A name in the address, for a course or a publication.
   *
   * A separate route rather than a field in PATCH: a taken name is a refusal
   * that has to be said in words, not a loss among three other fields that
   * were saved successfully.
   */
  router.put('/api/admin/slug/:kind/:id', requireStaff, (req, res) => {
    const raw = req.body?.slug
    const slug = typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null
    if (slug !== null && !slugOk(slug)) {
      return bad(res, tr("server.useLowercaseLatinLettersDigitsAndHyphens.f004a4"))
    }
    const course = req.params.kind === 'course'
    const target = course ? getCourse(req.params.id) : getPublication(req.params.id)
    if (!target) return res.status(404).json({ error: tr("server.notFound.094b76") })

    const outcome = course ? setCourseSlug(target.id, slug) : setPublicationSlug(target.id, slug)
    if (outcome === 'taken') {
      /*
       * The refusal names the holder, and that is not politeness.
       *
       * "The address "ml-2025" is already taken" is a dead end: most often it
       * is held by the FORMER name of another course (that one was renamed,
       * and the old name stayed an address for the sake of a link handed
       * out), and there is no such row in the course list at all. The teacher
       * looks for something that is not there and ends up with an address
       * with a digit at the end.
       *
       * The holder travels as a separate field, not only inside the
       * sentence: the panel decides by it whether to show "Release the former
       * address" next to the same field (web/src/lib/adminApi.ts ·
       * addressHolderOf), and it has no way to parse Russian text. `null`
       * means "taken, but I cannot say by whom": the screen then repeats the
       * sentence and offers nothing.
       *
       * For the same reason the sentence no longer advises going to another
       * course's settings: the release happens right here, two centimeters
       * away from it.
       */
      const holder = addressHolder(course ? 'course' : 'publication', slug!)
      const what = course ? tr("server.course.7c69f0") : tr("server.page.356bb7")
      const whose = course ? tr("server.course.91f120") : tr("server.page.3360a3")
      return res.status(409).json({
        error: !holder
          ? tr("server.theAddressIsAlreadyInUse.795904", { p0: String(slug) })
          : holder.former
            ? tr("server.theAddressIsAFormerNameOf.a5a2ca", { p0: String(slug), p1: whose, p2: holder.name })
            : tr("server.theAddressIsUsedByThe.3ffa25", { p0: String(slug), p1: what, p2: holder.name }),
        holder,
      })
    }
    res.json({ slug })
  })

  /**
   * Release one's own former name.
   *
   * A former address is held forever, and for good reason: a link with it is
   * written in the group chat. But the course "ml-2025", renamed to
   * "ml-2025-fall", held "ml-2025" against next year's course too, forever,
   * and there was no way to free it except deleting the owning course.
   *
   * Only the owner releases, and only a former name: a live name is dropped
   * by changing the name, someone else's is not touched at all
   * (publish/store.ts · releaseFormerSlug), and a 404 here means exactly
   * that: you have no such former name.
   */
  router.delete('/api/admin/slug/:kind/:id/former/:slug', requireStaff, (req, res) => {
    const kind = req.params.kind === 'course' ? 'course' : 'publication'
    if (!releaseFormerSlug(kind, req.params.id, req.params.slug.toLowerCase())) {
      return res.status(404).json({ error: tr("server.notFound.094b76") })
    }
    res.json({ ok: true })
  })

  /* ------------------------------------------------------- publication */

  /**
   * What the «Страница занятия» screen shows: every notebook and file of the
   * room with its default tick and reason, the checks, and the page if there
   * is one (publish/materials.ts · publishInfo).
   */
  router.get('/api/admin/seminars/:id/publish', requireStaff, (req, res) => {
    // A page whose room was deleted is asked for by its own id: it has no room any more.
    const info = publishInfo(req.params.id) ?? orphanPublishInfo(req.params.id)
    if (!info) return res.status(404).json({ error: SESSION_MISSING })
    res.json(info)
  })

  /** A build's answer, and the audit line for a page that went out. */
  const answer = (req: Request, res: Response, result: BuildResult, trigger: string): void => {
    if (!result.ok) {
      res.status(result.status).json({
        error: result.error,
        ...(result.checks ? { checks: result.checks } : {}),
      })
      return
    }
    const { publication, page, refused } = result
    // A class's notebooks became a public page: whose decision, which room.
    recordAdminEvent({
      actor: currentStaff(req),
      action: 'publication.published',
      target: { type: 'publication', id: publication.id, label: publication.title },
      detail: {
        room: req.params.id,
        materials: page.materials.length,
        revision: publication.revision,
        trigger,
      },
      req,
    })
    res.json({ page, refused })
  }

  router.post(
    '/api/admin/seminars/:id/publish',
    requireStaff,
    wrap(async (req: Request, res: Response) => {
      const request = readPublishRequest(req.body)
      if (typeof request === 'string') return bad(res, request)
      const teacher = currentStaff(req)
      const withdrawn = publicationOf(req.params.id)?.state === 'withdrawn'
      const result = await buildAndWrite(req.params.id, request, { by: teacher?.name ?? null })
      answer(req, res, result, 'teacher')
      // «Опубликовать снова» on a withdrawn page puts it back: logged as «Вернуть» would be.
      if (result.ok && withdrawn) recordPublication(req, 'publication.restored', result.publication)
    }),
  )

  /** Rebuild from the saved pick, with no questions: «Обновить страницу». */
  router.post(
    '/api/admin/seminars/:id/publish/refresh',
    requireStaff,
    wrap(async (req: Request, res: Response) => {
      if (!getSession(req.params.id)) {
        res.status(404).json({ error: SESSION_MISSING })
        return
      }
      const teacher = currentStaff(req)
      answer(req, res, await refreshPage(req.params.id, { by: teacher?.name ?? null }), 'refresh')
    }),
  )

  /** Withdraw the page. The link stays and says that the page was withdrawn. */
  router.delete('/api/admin/seminars/:id/publish', requireStaff, (req, res) => {
    const pub = publicationOf(req.params.id)
    if (!pub) return res.status(404).json({ error: tr("server.notPublished.61a0a5") })
    setPublicationState(pub.id, 'withdrawn')
    recordPublication(req, 'publication.withdrawn', pub)
    res.json({ ok: true })
  })

  router.post('/api/admin/seminars/:id/publish/restore', requireStaff, (req, res) => {
    const pub = publicationOf(req.params.id)
    if (!pub) return res.status(404).json({ error: tr("server.notPublished.61a0a5") })
    setPublicationState(pub.id, 'published')
    recordPublication(req, 'publication.restored', pub)
    res.json({ ok: true })
  })

  /**
   * Pages keyed by their own address.
   *
   * Deleting a seminar by default keeps the reading and clears `session_id`,
   * and all the routes above, keyed by the room id, start answering 404. The
   * page itself is alive and served by the server. There was no way to
   * withdraw it, and someone's personal output might have remained on it.
   */
  router.get('/api/admin/publications', requireStaff, (_req, res) => {
    res.json({
      publications: listPublications().map((pub) => ({
        ...pub,
        materials: materialCount(pub.id),
        orphaned: pub.sessionId === null,
      })),
    })
  })

  router.delete('/api/admin/publications/:id', requireStaff, (req, res) => {
    const pub = getPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    setPublicationState(pub.id, 'withdrawn')
    recordPublication(req, 'publication.withdrawn', pub)
    res.json({ ok: true })
  })

  router.post('/api/admin/publications/:id/restore', requireStaff, (req, res) => {
    const pub = getPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    setPublicationState(pub.id, 'published')
    recordPublication(req, 'publication.restored', pub)
    res.json({ ok: true })
  })

  /**
   * For good: the page's rows are erased, and the tombstone in the course
   * loses its link.
   *
   * By an owner, like deleting a seminar: withdrawing a page is one click and
   * reversible, while erasing it cannot be undone.
   */
  router.delete('/api/admin/publications/:id/forever', ownerOnly('delete a page'), (req, res) => {
    const pub = getPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    deletePublication(pub.id)
    recordPublication(req, 'publication.deleted', pub)
    res.json({ ok: true })
  })

  /**
   * Take one material off a page, keeping the rest as they are. The pick
   * forgets it too, so the next «Обновить страницу» does not bring it back.
   */
  router.delete(
    '/api/admin/publications/:id/materials/:key',
    requireStaff,
    wrap(async (req: Request, res: Response) => {
      // Queued behind any build in flight, which would otherwise write the material back.
      const result = await removeMaterial(req.params.id, req.params.key)
      if (!result.ok) {
        res.status(result.status).json({ error: result.error })
        return
      }
      const { publication, page, removed } = result
      recordAdminEvent({
        actor: currentStaff(req),
        action: 'publication.material_removed',
        target: { type: 'publication', id: publication.id, label: publication.title },
        detail: {
          material: removed.name,
          key: removed.key,
          revision: publication.revision,
          ...(publication.sessionId ? { room: publication.sessionId } : {}),
        },
        req,
      })
      res.json({ page })
    }),
  )

  /**
   * Who the page leads into the room («Вход в комнату со страницы»), saved on
   * its own. It lives in the saved pick so a rebuild keeps it, but changing
   * it is not a rebuild: the materials, the revision and every cached tab stay
   * as they are (store.ts · savePublicationSelection).
   *
   * A page with no saved pick (one carried over from 0.12) has nothing to
   * keep it in yet: the setting goes out with its next publish from the
   * screen, which writes a pick, and until then it reads as the default,
   * 'anyone' (shared/publish.ts · DEFAULT_ROOM_ACCESS).
   */
  router.patch(
    '/api/admin/publications/:id',
    requireStaff,
    wrap(async (req: Request, res: Response) => {
      const access = req.body?.roomAccess
      if (!isRoomAccess(access)) return bad(res, tr('server.roomDoor.badAccess'))
      // Queued behind any build in flight, which would otherwise save its own copy of the pick.
      const result = await setRoomAccess(req.params.id, access)
      if (!result.ok) {
        res.status(result.status).json({ error: result.error })
        return
      }
      const { was, publication: pub } = result
      if (was !== access) {
        // Who reaches a room with names and oracle questions from a public link is staff's call.
        recordAdminEvent({
          actor: currentStaff(req),
          action: 'publication.room_access',
          target: { type: 'publication', id: pub.id, label: pub.title },
          detail: { access, was, ...(pub.sessionId ? { room: pub.sessionId } : {}) },
          req,
        })
      }
      res.json({ roomAccess: access })
    }),
  )

  /* ------------------------------------------------------------ public */

  /**
   * The course page: every row with its number, title, day and page, and the
   * instance's «сегодня». By name, by id or by a former name: a link handed
   * out before the course was given a name keeps working afterwards.
   */
  router.get('/api/c/:id', (req, res) => {
    const course = findCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    sendTagged(req, res, { course: publicCourseView(course) })
  })

  /**
   * The class page: its header, its neighbours and its materials, without
   * the notebooks' cells, which come per tab (below). A withdrawn page still
   * answers, with no materials: the link must say it was withdrawn, not that
   * it never existed.
   */
  router.get('/api/p/:id', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    sendTagged(req, res, { page: publicPageView(pub) })
  })

  /**
   * The way into the class's room, for whoever may take it
   * (publish/room-door.ts). The page above never names its room; this is
   * the one answer that can, and only to staff, to everyone under 'anyone' (the default),
   * or to a browser whose token proves it was in that room under 'members'.
   * A withdrawn page leads nowhere.
   */
  router.post('/api/p/:id/room', (req, res) => {
    const tokens = doorTokens(req, res)
    if (!tokens) return
    const pub = findPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    const sessionId = pub.state === 'published' ? pub.sessionId : null
    res.json(roomDoor(req, sessionId, pub.selection?.roomAccess, tokens))
  })

  /**
   * The same door for a course row, by its key: the «Сегодня» block offers
   * the room while the class is on, before any page exists. The row's page,
   * when there is one, sets the access; a row without a page has the
   * default, 'anyone' (publish/room-door.ts · roomDoor).
   * A withdrawn page closes the row's door too: the teacher took the class
   * back, and the course must not reopen it.
   */
  router.post('/api/c/:id/room', (req, res) => {
    const tokens = doorTokens(req, res)
    if (!tokens) return
    const course = findCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    const key = typeof req.body?.key === 'string' ? req.body.key : ''
    const row = key ? courseRows(course).find((r) => r.key === key) : undefined
    if (!row) return res.status(404).json({ error: tr("server.notFound.094b76") })
    const withdrawn = row.pub !== null && row.pub.state !== 'published'
    const sessionId = row.item.kind === 'seminar' && !withdrawn ? row.item.sessionId : null
    res.json(roomDoor(req, sessionId, row.pub?.selection?.roomAccess, tokens))
  })

  /**
   * One notebook's cells, as stored: the heaviest thing the public half
   * serves (every output of a lesson), and the most unchanging, since while
   * `materials_rev` is the same, it is byte for byte the same text.
   */
  router.get('/api/p/:id/m/:key', (req, res) => {
    const pub = livePage(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    const key = req.params.key
    if (!MATERIAL_KEY_RE.test(key) || !hasNotebook(pub.id, key)) {
      return res.status(404).json({ error: MATERIAL_NOT_FOUND })
    }
    if (fresh(req, res, `${pub.id}.${pub.materialsRev ?? pub.revision}.${key}`)) return
    const cells = materialCellsText(pub.id, key) ?? '[]'
    // Put together as text: parsing megabytes of outputs only to print them again buys nothing.
    res.type('application/json').send(`{"notebook":{"key":${JSON.stringify(key)},"cells":${cells}}}`)
  })

  /**
   * A material's bytes, as a download; a folder's, as its ZIP (sendFolder).
   *
   * The type comes from a fixed map of extensions (materials.ts ·
   * downloadTypeOf), never from the row: the bytes come from a room anyone in
   * it could write to, and `content-type` decides what a followed link turns
   * into. `sandbox` and `nosniff` are there in case it gets opened anyway.
   */
  router.get('/api/p/:id/m/:key/download', (req, res, next) => {
    sendMaterial(req, res, next, 'attachment')
  })

  /**
   * A PDF in the browser's own viewer: «Слайды лекции» opens, it does not
   * download. Without the CSP sandbox the download has: a sandboxed document
   * is exactly what Chrome's PDF viewer refuses to draw. A PDF is all this
   * route serves, under its own fixed type.
   */
  router.get('/api/p/:id/m/:key/open', (req, res, next) => {
    sendMaterial(req, res, next, 'inline')
  })

  /**
   * Everything on the page in one archive, laid out like the room
   * (publish/zip.ts). Three at a time per page and six per instance; the
   * rest wait in line for a slot, and only one that waited too long hears
   * «через минуту». A stream that stops moving is dropped, so a paused
   * download cannot keep a slot from the class.
   */
  router.get('/api/p/:id/zip', (req, res, next) => {
    const pub = livePage(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    if (listMaterials(pub.id).length === 0) {
      return res.status(404).json({ error: MATERIAL_NOT_FOUND })
    }
    sendArchive(res, next, pub.id, () => {
      const now = livePage(req.params.id)
      const materials = now ? listMaterials(now.id) : []
      if (!now || materials.length === 0) {
        return { error: now ? MATERIAL_NOT_FOUND : PUBLICATION_NOT_FOUND }
      }
      const context = pageContext(now)
      const plan = zipPlan(zipContextOf(now, materials, context.course, context.row), {
        verify: true,
      })
      return { plan }
    })
  })

  /*
   * The 0.12 addresses. `notebook.ipynb` was printed on every page and
   * pasted into chats, so it still leads to the page's first notebook, now
   * with outputs. A step address has nothing to lead to: the 410 names the
   * page, and the reader goes there.
   */
  router.get('/api/p/:id/notebook.ipynb', (req, res) => {
    const pub = livePage(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    const first = listMaterials(pub.id).find((m) => m.kind === 'notebook')
    if (!first) return res.status(404).json({ error: MATERIAL_NOT_FOUND })
    const address = encodeURIComponent(publicationAddress(pub))
    res.redirect(302, `/api/p/${address}/m/${first.key}/download`)
  })

  router.get('/api/p/:id/step/:seq', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    res.status(410).json({ error: STEPS_GONE, address: publicationAddress(pub) })
  })

  /**
   * Large pieces of output, by content hash.
   *
   * The hash is the version, so the bytes never change, but they can be
   * taken down: «Убрать со страницы» and «Снять страницу» exist for the
   * student's notebook or the screenshot with someone's data that went out by
   * mistake. A year of `immutable` would keep such an image in every shared
   * cache long after the takedown. So an hour, and then a revalidation by
   * the hash that costs a phone a 304 while the image is still on the page
   * and a 404 once it is not.
   *
   * The type is taken not from the record but from a whitelist: an output's
   * mime comes from the room's document, that is, from anyone, and
   * `content-type` decides what the response becomes when a direct link is
   * followed. Everything unknown goes out as an attachment, which the
   * browser does not display; `sandbox` is there in case it gets opened
   * anyway.
   */
  router.get('/api/p/:id/blob/:hash', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub || pub.state !== 'published') return res.status(404).end()
    const blob = readBlob(pub.id, req.params.hash)
    if (!blob) return res.status(404).end()
    res.setHeader('content-security-policy', "sandbox; default-src 'none'")
    res.setHeader('x-content-type-options', 'nosniff')
    const etag = `"${req.params.hash}"`
    res.setHeader('etag', etag)
    res.setHeader('cache-control', `public, max-age=${BLOB_MAX_AGE_S}`)
    if (holds(req, etag)) return res.status(304).end()
    /*
     * A note's SVG keeps its type, so an `<img>` on the page draws it, and is
     * an attachment, so following the link downloads it instead of opening a
     * document (with whatever script it carries) on the instance's origin.
     * It used to go out as an octet-stream, and the note showed a broken
     * image.
     */
    if (blob.mime === 'image/svg+xml') {
      res.setHeader('content-type', 'image/svg+xml')
      res.setHeader('content-disposition', 'attachment; filename="image.svg"')
      return res.send(blob.body)
    }
    /*
     * The type comes from the whitelist, and is not necessarily the one
     * written in the row: a plotly figure is served as `application/json`.
     * Neither becomes a document, and `application/vnd.plotly.v1+json` in the
     * header adds nothing and reads worse in other hands.
     */
    const type = spillContentType(blob.mime)
    res.setHeader('content-type', type ?? 'application/octet-stream')
    res.setHeader('content-disposition', type ? 'inline' : 'attachment; filename="output.bin"')
    res.send(blob.body)
  })

  return router
}
