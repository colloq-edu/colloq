import { tr } from './i18n.js'
/**
 * A course, a published seminar and the steps a student follows.
 *
 * Three new nouns, and none of them is a room. A room is the place where a
 * class happens: people enter it by a link, and it holds the shared document,
 * the kernel and the rights. A publication is a second, frozen object DERIVED
 * from what the room recorded: behind it there is no socket, no kernel, no
 * token, and "read-only" here is a property of the design, not a switch the
 * server would have to honour.
 *
 * A course is the only address in Colloq a person would bookmark: it is
 * given to the class in the first week, and nothing else is given after it.
 */
import type { CellOutput, CellType } from './notebook.js'
import { PLOTLY_MIME } from './plotly.js'

/** Eight characters, like a seminar's, but in a namespace of its own. */
export type CourseId = string
export type PublicationId = string

/* ------------------------------------------------------------- course */

export interface CourseItemSeminar {
  kind: 'seminar'
  sessionId: string
  name: string
  /** Whether it has a public page, and what is on it. */
  publication: {
    id: PublicationId
    slug: string | null
    publishedAt: number
    steps: number
  } | null
}

/**
 * A seminar that no longer exists.
 *
 * The row stays, and this is not pedantry: a course from which the fourth
 * week silently vanished is broken for whoever sat in it, and the numbering
 * of the other weeks shifts by one and stops matching the timetable.
 */
export interface CourseItemGone {
  kind: 'gone'
  name: string
  at: number
  /**
   * The reading left over from the room.
   *
   * Deleting a seminar keeps the published page by default: a link cannot be
   * taken back from students. Without this link the course row becomes a dead
   * end: the page is alive and opens at its direct address, but from the
   * course, the only address the class is given at all, it cannot be reached.
   */
  publication?: {
    id: PublicationId
    slug: string | null
  } | null
}

/**
 * A topic that has not been taught yet.
 *
 * A course is set up at the start of the semester, and rooms appear one at a
 * time, once a week. Without this row the course page would be empty in
 * September, or thirty rooms would have to be created in advance, each with
 * its own link leading to an empty notebook three months before the class.
 *
 * `when` is the week in the timetable's words ("31 Aug – 6 Sep"), not a date:
 * that is how timetables are written, and turning it into numbers would mean
 * inventing a day that is not in it.
 */
export interface CourseItemPlanned {
  kind: 'planned'
  name: string
  when: string
}

export type CourseItem = CourseItemSeminar | CourseItemGone | CourseItemPlanned

/**
 * A name chosen by a person, for the address.
 *
 * Only lowercase letters, digits and hyphens: the address is dictated aloud
 * and written on the board, and capitals in it raise the question "upper or
 * lower case?". No dots or slashes on purpose: the path is built by
 * substitution, and there is no way to climb out of it.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/

export function slugOk(value: string): boolean {
  return SLUG_RE.test(value)
}

/**
 * The address of a page or course: the name if there is one, otherwise the id.
 *
 * One line, and it had already been rewritten four times (courses panel,
 * course list, publish screen, reader page), each time the same way, until
 * the same thing was needed on the entry screen. The rule is simple, but it
 * must not have copies: a removed name forgotten in one of them sends the
 * class to `/p/` with an id nobody dictated.
 */
export function publicationAddress(page: { id: string; slug?: string | null }): string {
  return page.slug ?? page.id
}

/** What can carry a name in the address at all: a course `/c/…` or a class page `/p/…`. */
export type AddressKind = 'course' | 'publication'

/**
 * Who holds the requested name, so that the refusal can name the holder.
 *
 * "Address "ml-2025" is already taken" is a dead end: there is no course with
 * that address in the list (it was renamed to "ml-2025-fall"), and the
 * teacher looks for something that cannot be seen. `former` tells apart two
 * quite different reasons for a refusal: the live address of another page
 * can be freed only by that page's owner, whereas the memory of a link
 * already handed out the owner can release on their own, at the cost of the
 * old link becoming a 404.
 *
 * The type is shared by both sides on purpose: the server judges by this
 * record (`server/src/publish/store.ts` · addressHolder, releaseFormerSlug),
 * the panel uses the same record to decide whether to show the "release"
 * button, and there is nowhere for them to diverge.
 */
export interface AddressHolder {
  kind: AddressKind
  id: string
  name: string
  /** A live address, or a former one kept for a link already handed out. */
  former: boolean
}

/**
 * A word from the title is a suggestion, not a verdict: the person erases it
 * and writes their own.
 */
export function suggestSlug(name: string): string {
  const TRANSLIT: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'c',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
  }
  const out = [...name.toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  return out.length >= 3 ? out : ''
}

export interface Course {
  id: CourseId
  /** The name in the address. `null`: the address stays the id. */
  slug: string | null
  name: string
  blurb: string | null
  createdAt: number
  createdBy: string | null
  items: CourseItem[]
  /**
   * Version of the list, for compare-and-swap.
   *
   * Teacher rights on an instance are shared, and a course's seminar list is
   * written whole as one value: without this, two people rearranging the
   * same course in the same minute silently lose each other's order.
   */
  rev: number
  /**
   * Former names in the address that still lead to this course.
   *
   * A rename does not cancel a link already handed out: the old name stays an
   * address forever, and holds it for everyone else too. Next year's course
   * that needed this name got "Address "ml-2025" is already taken" about a
   * row not visible in the list at all. The owner releases them, one at a
   * time (`DELETE /api/admin/slug/course/:id/former/:slug`), and this has its
   * own price: a released address stops leading anywhere.
   *
   * Optional and only in the panel: the public view of a course has no need
   * to know about former names.
   */
  former?: string[]
}

/**
 * A course as a student sees it.
 *
 * A separate type rather than the whole `Course`, and the difference is
 * exactly what it lacks: `sessionId` does not go out. The eight characters of
 * a room are the whole right to write into it, so a link given to the class
 * "for reading" must not open the live notebook for them. `rev`, the author
 * and the creation date mean nothing to a student either.
 */
export interface PublicCourseView {
  id: CourseId
  slug: string | null
  name: string
  blurb: string | null
  items: CourseItem[]
}

/* ------------------------------------------------------- published seminar */

/**
 * A cell on the public page.
 *
 * `runBy`, `runById`, `stdin` and `state` do not get here, and this is an
 * allowlist enumeration, not a subtraction: a field added to the notebook
 * tomorrow must not end up on the public page by itself.
 */
export interface PublicCell {
  id: string
  type: CellType
  source: string
  outputs: CellOutput[]
  /** Execution count. `null`: there is output, but no execution behind it any more. */
  execCount: number | null
  /** How long the last finished run took. */
  ranMs: number | null
}

/** One step: a moment the teacher named, and the notebook at that moment. */
export interface PublicStep {
  /** The history row the step is built from. It is also its permanent address. */
  seq: number
  label: string
  at: number
  cells: PublicCell[]
}

/** A step without content, for the rail and for the list. */
export interface StepHeading {
  seq: number
  label: string
  at: number
  cellCount: number
}

export type PublicationState = 'published' | 'withdrawn'

export interface PublicSeminar {
  id: PublicationId
  slug: string | null
  title: string
  state: PublicationState
  publishedAt: number
  /** The course, if the seminar belongs to one, so the page has a way up. */
  course: { id: CourseId; name: string } | null
  steps: StepHeading[]
  /** Whether the seminar this was made from is gone. It does not stop reading. */
  orphaned: boolean
}

/**
 * A moment that can become a step.
 *
 * `label` is empty when nobody named the moment: it is a service snapshot,
 * and "Snapshot #14" in a student's rail is not a title but an admission that
 * someone forgot to name it. Such a moment cannot be marked until words are
 * written in the field.
 */
export interface PublishCandidate {
  seq: number
  label: string
  at: number
  cellCount: number
  kind: string
}

/* ------------------------------------------------ two "no"s for one code */

/**
 * No step, or no page: both have code 404, and only the body tells them apart.
 *
 * `/api/p/:id/step/:seq` refuses for two different reasons, and for the
 * reader these are two different worlds. `step not found`: the publication
 * is alive and open, but it has no such step: the link is out of date (the
 * seminar is republished at the same address; `writePublication` keeps the
 * id and changes the marks) or the number is wrong. `publication not found`:
 * the page is gone altogether: withdrawn or deleted.
 *
 * The words live here, not in the route and not in the screen: these cases
 * can be told apart ONLY by the body, and should one of the two copies drift,
 * the reader will again start burying a live publication, and there will be
 * nothing left to fix it with.
 */
export const STEP_NOT_FOUND = 'step not found'
export const PUBLICATION_NOT_FOUND = 'publication not found'

/**
 * What exactly was not found, by the refusal's code and body.
 *
 * `null` means "I don't know", not "no": a 404 without familiar words (a
 * proxy's stub page, someone else's response) proves neither, and it must
 * not be acted on as a verdict.
 */
export function refusedStep(status: number, message: string): 'step' | 'publication' | null {
  if (status !== 404) return null
  if (message === STEP_NOT_FOUND) return 'step'
  if (message === PUBLICATION_NOT_FOUND) return 'publication'
  return null
}

/* ------------------------------------------------------------------- limits */

export const MAX_COURSE_NAME = 120
export const MAX_COURSE_BLURB = 140
/**
 * The week of a plan row: "31 Aug – 6 Sep", not a paragraph.
 *
 * Forty used to be a number inside the route, and the panel field did not
 * know about it: anything typed longer was silently truncated by the server,
 * and the saved row differed from what the person saw in the field. One
 * constant for both sides.
 */
export const MAX_PLANNED_WHEN = 40
export const MAX_STEP_LABEL = 80
/** How many steps can be published at once. Forty is already a semester. */
export const MAX_STEPS = 40

/**
 * The threshold beyond which output content moves to a separate record.
 *
 * A matplotlib plot is hundreds of kilobytes of base64, and it is the same in
 * every step where this cell did not change. Storing it in each means six
 * copies of one picture per seminar; storing it by hash means one.
 */
export const BLOB_MIN_BYTES = 2048

/**
 * What moves to a separate record at all: only raster images.
 *
 * The list is spelled out because moving out assumes base64: the record
 * stores DECODED bytes. `image/svg+xml` comes from the kernel as XML text,
 * and `Buffer.from(xml, 'base64')` turned it into garbage: the page was left
 * with an empty frame, and the original in the publication could no longer be
 * recovered. SVG stays in the page as is: it also weighs less than the
 * picture all this was set up for.
 *
 * The second thing this list guards: the type goes from here into the
 * response's `content-type` (`/api/p/:id/blob/:hash`). An SVG in a blob is a
 * document on the instance's origin, and so is the script inside it.
 */
export const BLOB_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/**
 * What can move out of the document into a separate record at all.
 *
 * Wider than `BLOB_MIMES` by exactly one entry, the plotly figure, and a
 * separate set rather than an entry in that list, for two reasons at once.
 * First: `BLOB_MIMES` is also the list of what is drawn by an `<img>` element
 * (web/src/components/notebook/output-mimes.ts · IMG_MIMES), and a chart that
 * got there would arrive as a broken image. Second: the records store DECODED
 * bytes, and their encodings differ: an image comes as base64, a figure comes
 * as JSON text (see `spillEncoding`).
 *
 * A figure is moved out for the same reason as a matplotlib plot: a
 * `px.scatter` of tens of thousands of points is megabytes, and in the room
 * document they would cost as much to every viewer, every snapshot and every
 * history frame.
 */
export const SPILL_MIMES: ReadonlySet<string> = new Set([...BLOB_MIMES, PLOTLY_MIME])

/** How such a piece sits in the kernel's bundle: base64 or plain text. */
export function spillEncoding(mime: string): 'base64' | 'utf8' {
  return BLOB_MIMES.has(mime) ? 'base64' : 'utf8'
}

/**
 * What to serve a moved-out piece to the browser as, and it is NOT what the
 * kernel said.
 *
 * `content-type` decides what the response becomes when a direct link is
 * followed, and the `display_data` bundle is formed by a library in the
 * student's code. An image gets its own type back, a figure gets
 * `application/json`: it is exact and does not become a document. `null`:
 * unknown; such content goes out as an attachment.
 */
export function spillContentType(mime: string): string | null {
  if (BLOB_MIMES.has(mime)) return mime
  if (mime === PLOTLY_MIME) return 'application/json'
  return null
}

/** A reference to such content inside an output's mime bundle. */
export const BLOB_PREFIX = 'blob:'

/* ---------------------------------------------------- a step that fell out */

/**
 * Why a moment the teacher marked did not become a step.
 *
 * Silence here costs more than it seems: the teacher marked seven moments,
 * pressed "Publish" and got a page with six, and nobody said which one was
 * lost and why. The reasons differ in nature and must not be confused:
 * "empty" is a fact about the class, "unreadable" is a server breakage, and
 * the other two are about the request itself.
 */
export type SkipReason = 'empty' | 'broken' | 'unnamed' | 'duplicate'

/** A named moment that did not make it into the publication, and why. */
export interface SkippedStep {
  seq: number
  label: string
  reason: SkipReason
}

/**
 * How to say this to a person: one copy for the server and the panel.
 *
 * The text lives here, not in the route and not in the component: two copies
 * of one phrase drift apart at the very first edit, and then the server log
 * and the teacher's screen call the same refusal by different names.
 */
export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  get empty() { return tr('server.skip_reason_text.empty') },
  get broken() { return tr('server.skip_reason_text.broken') },
  get unnamed() { return tr('server.skip_reason_text.unnamed') },
  get duplicate() { return tr('server.skip_reason_text.duplicate') },
}

/* ----------------------------------------------------------------- indexing */

/**
 * Whether to let search engines onto published pages: one decision for both
 * carriers.
 *
 * There are two: the Pages export (`server/src/publish/render.ts`) and the
 * live instance (`/p/`, `/c/` in `server/src/index.ts`). While the rule lived
 * in comments on both sides, the comments managed to diverge: the static
 * export set `noindex` ("the page is given to the class, not to a search
 * engine"), while the instance's `robots.txt` closed only the rooms and the
 * panel, explaining that publications "are indexed: that is what they are
 * published for". The same page behaved differently depending on which
 * address it was opened at.
 *
 * The decision is "not indexed", and it is about what this page is: a record
 * of a class given to its own class by link, not a publication for readers
 * at large. It should be found by whoever was given the address; the
 * colloq.ru landing is open to search engines and stays open.
 */
export const PUBLIC_PAGES_INDEXED = false

/** `<meta name="robots">` and the `X-Robots-Tag` header, from one decision. */
export const ROBOTS_TAG = PUBLIC_PAGES_INDEXED ? 'all' : 'noindex'
