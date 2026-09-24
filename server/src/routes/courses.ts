import { tr } from '@shared/i18n'
/**
 * Courses and publications: both what the teacher does and what the student
 * reads.
 *
 * The public half asks for nothing, neither a name nor a login, and so serves
 * only what is already assembled in `publication_steps`. No unfolding of a
 * Yjs document on a public request: that is multi-megabyte work in the same
 * process that is running a class at that minute, with no rate limit at all.
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import { ownerOnly, requireStaff, currentStaff } from '../admin/auth.js'
import { getSession, renameSession } from '../db.js'
import { visitSessionDoc } from './doc-visit.js'
import {
  spillContentType,
  MAX_COURSE_BLURB,
  MAX_COURSE_NAME,
  MAX_PLANNED_WHEN,
  MAX_STEPS,
  MAX_STEP_LABEL,
  PUBLICATION_NOT_FOUND,
  STEP_NOT_FOUND,
  slugOk,
  type CourseItem,
  type PublicCell,
  type PublicSeminar,
  type SkippedStep,
} from '@shared/publish'
import { courseOfPublication, freshCourseItems, publicCourseView } from './course-view.js'
import { SESSION_MISSING } from '@shared/protocol'
import { candidatesForAsync } from '../publish/candidates.js'
import { newBlobBag, pageOfDoc, pagesAtAsync } from '../publish/build.js'
import { notebookOfStep } from '../publish/notebook.js'
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
  listCourses,
  listPublications,
  publicationOf,
  readBlob,
  readStep,
  releaseFormerSlug,
  renameCourse,
  setCourseItems,
  setCourseSlug,
  setPublicationSlug,
  setPublicationState,
  stepCount,
  stepHeadings,
  writePublication,
  type BuiltStep,
} from '../publish/store.js'

const str = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

function bad(res: Response, message: string): void {
  res.status(400).json({ error: message })
}

/**
 * A public response that has not changed: a 304 and not a single database
 * read.
 *
 * We set the version tag ourselves rather than leaving it to Express's ETag:
 * that one hashes the ASSEMBLED body, that is, after the page has already
 * been read and parsed, which saves traffic but not work. Here it is the
 * other way round: the publication's `revision` is known from one indexed
 * row, and everything heavy comes after this check.
 *
 * `max-age` is small and without `immutable`: the page's address is
 * permanent, but the content is republished, and an eternal cache would mean
 * a week-old review for whoever opened the link before the republication.
 */
const PUBLIC_MAX_AGE_S = 300

function fresh(req: Request, res: Response, tag: string): boolean {
  const etag = `W/"${tag}"`
  res.setHeader('etag', etag)
  res.setHeader('cache-control', `public, max-age=${PUBLIC_MAX_AGE_S}`)
  // The header may carry a list of tags with `W/` before each: we compare word
  // by word, not the whole string.
  const asked = req.headers['if-none-match']
  if (typeof asked !== 'string') return false
  const matched = asked
    .split(',')
    .some((one) => one.trim() === '*' || one.trim() === etag || one.trim() === `"${tag}"`)
  if (!matched) return false
  res.status(304).end()
  return true
}

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
 * The course with live seminar names, the same one that goes into the site
 * export. One function for both places: routes/course-view.ts.
 */
const freshItems = freshCourseItems

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
    res.json({
      course: createCourse(
        name,
        str(req.body?.blurb, MAX_COURSE_BLURB) || null,
        teacher?.name ?? null,
      ),
    })
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
   */
  router.put('/api/admin/courses/:id/items', requireStaff, (req, res) => {
    const course = getCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    const incoming: unknown = req.body?.items
    if (!Array.isArray(incoming)) return bad(res, tr("server.itemsMustBeAnArray.399a2e"))

    const items: CourseItem[] = []
    for (const raw of incoming as Record<string, unknown>[]) {
      if (raw?.kind === 'planned') {
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
        items.push({ kind: 'planned', name, when: str(raw.when, MAX_PLANNED_WHEN) })
        continue
      }
      if (raw?.kind === 'gone') {
        /*
         * The link to the remaining reading survives rearranging the rows.
         *
         * If it was not sent, we take it from what is already recorded: a
         * screen that knows nothing about this link would otherwise erase it
         * on the very first save of the course, and the tombstone would become
         * a dead end again.
         */
        const name = str(raw.name, MAX_COURSE_NAME)
        const at = Number(raw.at) || Date.now()
        const sent = raw.publication as { id?: unknown } | null | undefined
        const known = course.items.find((i) => i.kind === 'gone' && i.name === name && i.at === at)
        const id =
          typeof sent?.id === 'string'
            ? sent.id
            : (known?.kind === 'gone' && known.publication?.id) || null
        const pub = id ? getPublication(id) : null
        items.push({
          kind: 'gone',
          name,
          at,
          publication: pub ? { id: pub.id, slug: pub.slug } : null,
        })
        continue
      }
      const sessionId = str(raw?.sessionId, 64)
      const session = sessionId ? getSession(sessionId) : null
      if (!session) continue
      items.push({
        kind: 'seminar',
        sessionId,
        name: session.name,
        publication: null,
      })
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
    if (!getCourse(req.params.id)) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    deleteCourse(req.params.id)
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
   * What steps can be assembled from, and what is already published.
   *
   * Candidates are computed yielding the event loop (`candidatesForAsync`)
   * rather than in one synchronous pass: on a room with a semester of history
   * that is seconds in the very process that holds the class's sockets at
   * that minute. The result is the same (yielding changes no field), and the
   * lesson next door goes on.
   */
  router.get(
    '/api/admin/seminars/:id/publish',
    requireStaff,
    wrap(async (req: Request, res: Response) => {
      const session = getSession(req.params.id)
      if (!session) {
        res.status(404).json({ error: SESSION_MISSING })
        return
      }
      const pub = publicationOf(session.id)
      res.json({
        title: session.name,
        candidates: await candidatesForAsync(session.id),
        publication: pub
          ? { ...pub, steps: stepHeadings(pub.id), former: formerSlugs('publication', pub.id) }
          : null,
      })
    }),
  )

  router.post(
    '/api/admin/seminars/:id/publish',
    requireStaff,
    wrap(async (req: Request, res: Response) => {
      const session = getSession(req.params.id)
      if (!session) {
        res.status(404).json({ error: SESSION_MISSING })
        return
      }

      const asked: unknown = req.body?.steps
      if (!Array.isArray(asked)) return bad(res, tr("server.stepsMustBeAnArray.62b083"))
      if (asked.length > MAX_STEPS) return bad(res, tr("server.noMoreThanSteps.63addd", { p0: MAX_STEPS }))

      /*
       * What was asked for, and what of it will not become a step.
       *
       * A moment that dropped out used to vanish silently: the teacher marked
       * seven, and the page had six. The reasons differ in nature: about the
       * request ("no name", "already in the list") and about the class ("the
       * notebook is empty", "the record cannot be read"), and all of them go
       * into the response (shared/publish.ts · SkippedStep), so that the panel
       * can name the missing moment.
       */
      const wanted: { seq: number; label: string; at: number }[] = []
      const skipped: SkippedStep[] = []
      const seen = new Set<number>()
      for (const raw of asked as Record<string, unknown>[]) {
        const label = str(raw?.label, MAX_STEP_LABEL)
        const seq = Number(raw?.seq)
        /*
         * A step's address is a version number from the feed: an integer
         * greater than zero. Zero is taken by the last page (below); fractions
         * and negatives address nothing. That is not "a moment that dropped
         * out" but a wrong request, and it has to be answered in words, not
         * with silence and not with a 500 from the transaction.
         */
        if (!Number.isInteger(seq) || seq <= 0) {
          return bad(res, tr("server.chooseAVersionForTheStepA.ec311c"))
        }
        // An unnamed step is not published: a rail of "Snapshot #14" entries
        // is not named moments but an admission that somebody forgot to name
        // them.
        if (!label) {
          skipped.push({ seq, label: '', reason: 'unnamed' })
          continue
        }
        if (seen.has(seq)) {
          skipped.push({ seq, label, reason: 'duplicate' })
          continue
        }
        seen.add(seq)
        wanted.push({ seq, label, at: Number(raw?.at) || Date.now() })
      }

      /*
       * All steps in one pass over the history, not a pass per step.
       *
       * Each step used to unfold in its own Y.Doc from the nearest keyframe
       * (`buildPageAt`): a notebook with images is megabytes per step, and
       * there are up to forty steps, that is, up to forty full replays of the
       * history in a row. Now the history is replayed ONCE for the whole
       * publication, and only the rows between the previous step and the next
       * are applied on top of the previous step's state (publish/replay.ts,
       * `pagesAtAsync`).
       *
       * Yielding the event loop has not gone anywhere: it is inside the pass,
       * between steps: page projection (a hash of every image, base64 to
       * bytes) is still done per step, and a colleague is teaching a lesson in
       * the same process. The pass itself goes in ascending `seq` and drops
       * duplicates by itself; in the response the steps are laid out in the
       * order they were named, because the rail's order is chosen by the
       * teacher, not by arithmetic.
       */
      const blobs = newBlobBag()
      const built = new Map<number, PublicCell[]>()
      for (const [seq, page] of await pagesAtAsync(session.id, [...seen], blobs)) {
        if (page.ok) built.set(seq, page.cells)
        else {
          const named = wanted.find((step) => step.seq === seq)
          skipped.push({ seq, label: named?.label ?? '', reason: page.reason })
        }
      }

      const steps: BuiltStep[] = []
      for (const step of wanted) {
        const cells = built.get(step.seq)
        if (cells) steps.push({ ...step, cells })
      }

      /*
       * The last page is the notebook as it is now, and it is always there. A
       * publication without it would be a story of the class that breaks off
       * in the middle; `seq: 0` is its permanent address, free by
       * construction (AUTOINCREMENT starts at one).
       *
       * And the archived room's document does not stay in memory after this:
       * people publish in the evening, when nobody has opened the room
       * (routes/doc-visit.ts).
       */
      steps.push({
        seq: 0,
        label: str(req.body?.finalLabel, MAX_STEP_LABEL) || tr("server.notebookAtPublication.33f04f"),
        at: Date.now(),
        cells: visitSessionDoc(session.id, (doc) => pageOfDoc(doc, blobs)),
      })

      const teacher = currentStaff(req)
      const publication = writePublication({
        sessionId: session.id,
        title: session.name,
        by: teacher?.name ?? null,
        steps,
        blobs: blobs.all(),
      })
      res.json({
        publication: { ...publication, steps: stepHeadings(publication.id) },
        skipped,
      })
    }),
  )

  /** Withdraw the page. The link stays and says that the page was withdrawn. */
  router.delete('/api/admin/seminars/:id/publish', requireStaff, (req, res) => {
    const pub = publicationOf(req.params.id)
    if (!pub) return res.status(404).json({ error: tr("server.notPublished.61a0a5") })
    setPublicationState(pub.id, 'withdrawn')
    res.json({ ok: true })
  })

  router.post('/api/admin/seminars/:id/publish/restore', requireStaff, (req, res) => {
    const pub = publicationOf(req.params.id)
    if (!pub) return res.status(404).json({ error: tr("server.notPublished.61a0a5") })
    setPublicationState(pub.id, 'published')
    res.json({ ok: true })
  })

  /**
   * Pages keyed by their own address.
   *
   * Deleting a seminar by default keeps the reading and clears `session_id`,
   * and all the routes above, keyed by the room id, start answering 404. The
   * page itself is alive: served by the server and deployed to the site by
   * every `make site`. There was no way to withdraw it, and someone's
   * personal output might have remained on it.
   */
  router.get('/api/admin/publications', requireStaff, (_req, res) => {
    res.json({
      publications: listPublications().map((pub) => ({
        ...pub,
        steps: stepCount(pub.id),
        orphaned: pub.sessionId === null,
      })),
    })
  })

  router.delete('/api/admin/publications/:id', requireStaff, (req, res) => {
    const pub = getPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    setPublicationState(pub.id, 'withdrawn')
    res.json({ ok: true })
  })

  router.post('/api/admin/publications/:id/restore', requireStaff, (req, res) => {
    const pub = getPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    setPublicationState(pub.id, 'published')
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
    res.json({ ok: true })
  })

  /* ------------------------------------------------------------ public */

  router.get('/api/c/:id', (req, res) => {
    // By name or by id: a link handed out before the course was given a name
    // must keep working afterwards.
    const course = findCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    res.json({ course: publicCourseView(course) })
  })

  /**
   * The seminar page, with a version tag, because a whole cohort opens it.
   *
   * A publication is immutable between republications: `revision` grows with
   * every write, and the state (withdrawn/live) changes by a separate click;
   * together they are the version of the response. Five hundred people
   * opening the link at a review in the same minute get a 304 on a matching
   * tag and cost not a single database row; the five minutes of `max-age` are
   * about these pages being read in a row, paging through the steps, while
   * they change once a week.
   *
   * The header is set BEFORE the steps are read, and that is the whole
   * point: `stepHeadings` reads the steps table, and answering 304 after it
   * would save nothing.
   */
  router.get('/api/p/:id', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    if (fresh(req, res, `${pub.id}.${pub.revision}.${pub.state}`)) return
    // An orphaned page has no room, and the course will not be found by
    // `sessionId`: the tombstone holds it back. It must keep a way up too.
    const course = courseOfPublication(pub)
    const seminar: PublicSeminar = {
      id: pub.id,
      slug: pub.slug,
      title: pub.title,
      state: pub.state,
      publishedAt: pub.publishedAt,
      course: course ? { id: course.id, name: course.name } : null,
      steps: pub.state === 'published' ? stepHeadings(pub.id) : [],
      orphaned: pub.sessionId === null,
    }
    res.json({ seminar })
  })

  router.get('/api/p/:id/step/:seq', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub || pub.state !== 'published') {
      return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    }
    const asked = req.params.seq === 'first' ? null : Number(req.params.seq)
    if (asked !== null && !Number.isFinite(asked)) return bad(res, tr("server.badStep.8811c6"))
    /*
     * A step is the heaviest thing the public half serves: the whole page,
     * with all its text outputs. And the most unchanging: while `revision` is
     * the same, it is byte for byte the same step.
     */
    if (fresh(req, res, `${pub.id}.${pub.revision}.${req.params.seq}`)) return
    const step = readStep(pub.id, asked)
    if (!step) return res.status(404).json({ error: STEP_NOT_FOUND })
    res.json({ step })
  })

  /**
   * The notebook as an .ipynb file.
   *
   * The only way to take the code away whole: the room itself has no export
   * at all, and selecting across several cells with the mouse is impossible,
   * since each is a separate editor. The step named in `?step=` is served;
   * without a number, the last one, that is, the notebook as of publication.
   *
   * Outputs are not put into the file. A notebook without them opens
   * anywhere and weighs kilobytes; with them it is megabytes of base64 in a
   * file the student takes home to run again, and the first thing they do is
   * press "Run" anyway.
   */
  router.get('/api/p/:id/notebook.ipynb', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub || pub.state !== 'published') return res.status(404).end()
    /*
     * The step the reader is on, if they said which.
     *
     * Without `?step=` the last one is served, that is, the notebook as of
     * publication: that is how this link always worked, and how the page
     * labels it. An unknown number also gets the last step, not a 404: a
     * download is not the place to explain addresses to a person, and a file
     * in hand beats an empty refusal.
     */
    const wanted = Number(req.query.step)
    const body = notebookOfStep(pub.id, Number.isInteger(wanted) ? wanted : null)
    if (body.length === 0) return res.status(404).end()
    const name = pub.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'notebook'
    res.setHeader('content-type', 'application/x-ipynb+json; charset=utf-8')
    res.setHeader(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}.ipynb`,
    )
    res.send(body)
  })

  /**
   * Large pieces of output, by content hash.
   *
   * The hash is the version, so the cache is eternal: the page is opened from
   * a phone, and a half-megabyte chart must not arrive twice.
   *
   * The type is taken not from the record but from a whitelist: an output's
   * mime comes from the room's document, that is, from anyone, and
   * `content-type` decides what the response becomes when a direct link is
   * followed. `image/svg+xml` is a document, and a script inside it would run
   * on the instance's origin, with the cookie of whoever opened the link.
   * That and everything unknown goes out as an attachment, which the browser
   * does not display; `sandbox` is there in case it gets opened anyway.
   */
  router.get('/api/p/:id/blob/:hash', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub || pub.state !== 'published') return res.status(404).end()
    const blob = readBlob(pub.id, req.params.hash)
    if (!blob) return res.status(404).end()
    /*
     * The type comes from the whitelist, and is not necessarily the one
     * written in the row: a plotly figure is served as `application/json`.
     * Neither becomes a document, and `application/vnd.plotly.v1+json` in the
     * header adds nothing and reads worse in other hands.
     */
    const type = spillContentType(blob.mime)
    res.setHeader('content-type', type ?? 'application/octet-stream')
    res.setHeader('content-disposition', type ? 'inline' : 'attachment; filename="output.bin"')
    res.setHeader('content-security-policy', "sandbox; default-src 'none'")
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.send(blob.body)
  })

  return router
}
