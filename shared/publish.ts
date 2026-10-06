import { tr } from './i18n.js'
/**
 * A course, its classes and the page each class leaves behind.
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

export { CLASS_DAY_RE } from './class-day.js'

/** The «о чём» line of a class: one or two sentences, not a syllabus. */
export const MAX_CLASS_ABOUT = 280

/**
 * What every course row may carry besides its kind, all optional.
 *
 * Optional on purpose: rows written by 0.12 have none of these, and an older
 * panel that saves the course drops them (the release notes say so). The
 * server keeps a stored field when an incoming row does not mention it
 * (routes/courses.ts), so an old tab cannot wipe class days.
 */
export interface CourseRowFields {
  /** 'r' + 7 characters, assigned by the server and never reused within a course. */
  id?: string
  /** The student-facing title; wins over the live room name. */
  title?: string | null
  /** 'YYYY-MM-DD', a calendar day in the instance zone; never a timestamp. */
  day?: string | null
  /** At most MAX_CLASS_ABOUT characters. */
  about?: string | null
  /**
   * The legacy week text, carried from the plan row when a room is seated
   * into it. Shown only while `day` is null.
   */
  when?: string
}

/**
 * Whether a published page hangs off a course row, and what is on it.
 *
 * Computed live by course-view.ts · freshCourseItems; the stored row keeps
 * `null` here.
 */
export interface CoursePageRef {
  id: PublicationId
  slug: string | null
  publishedAt: number
  /** How many materials the page has. */
  materials: number
}

export interface CourseItemSeminar extends CourseRowFields {
  kind: 'seminar'
  sessionId: string
  name: string
  /** Whether it has a public page, and what is on it. */
  publication: CoursePageRef | null
}

/**
 * A seminar that no longer exists.
 *
 * The row stays, and this is not pedantry: a course from which the fourth
 * week silently vanished is broken for whoever sat in it, and the numbering
 * of the other weeks shifts by one and stops matching the timetable.
 */
export interface CourseItemGone extends CourseRowFields {
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
 * `when` is the week in the timetable's words ("31 Aug – 6 Sep"); `day` is
 * the calendar day once someone knows it. `pause` marks a break (holidays):
 * it has no number, and 0.12 shows it as an ordinary plan row.
 */
export interface CourseItemPlanned extends CourseRowFields {
  kind: 'planned'
  name: string
  when: string
  pause?: boolean
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

/**
 * Russian letters as Latin ones, lowercased; everything else as it was.
 *
 * Shared by address suggestions and by the publish checks that compare a
 * file name like `ZuevAkim_02.ipynb` with a participant called «Зуев Аким»
 * (shared/materials.ts · rosterMatch).
 */
export function transliterate(text: string): string {
  return [...text.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('')
}

/**
 * A word from the title is a suggestion, not a verdict: the person erases it
 * and writes their own.
 */
export function suggestSlug(name: string): string {
  const out = transliterate(name)
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
  /**
   * The course's teachers («Ведут»), names and ids. Panel only, like
   * `former`: the public course page does not name its staff.
   */
  teachers?: { id: string; name: string }[]
  /**
   * Whether the viewer teaches this course. Panel only; false on an owner's
   * «Все» list for the courses the owner sees by role alone.
   */
  mine?: boolean
}

/** What the course page needs to say about one row. */
export type ClassState = 'plan' | 'room' | 'closed' | 'page' | 'pause'

/** A material as a course row lists it: enough for a tag and a link. */
export interface MaterialRef {
  key: string
  kind: MaterialKind
  name: string
  /** For a folder: every file that went out in it, together. */
  bytes: number
  /** Folders only: how many files went out in it. */
  files?: number
  /**
   * Folders only: what those files are, once each, in MATERIAL_KINDS order.
   * The course row's tags and the page's «Данные · 15 файлов» are read from it
   * (shared/materials.ts · folderLabel, tagsOf).
   */
  holds?: MaterialKind[]
  /**
   * Markdown text, read on the class page as a tab of its own, like a
   * notebook (shared/materials.ts · readsOnPage). Absent for everything else.
   */
  reads?: true
}

export interface PublicClass {
  /** The row id. */
  key: string
  /** The ordinal among non-pause rows; `null` for a pause. */
  n: number | null
  /** studentTitle: the row's title, else the live room name. */
  title: string
  about: string | null
  day: string | null
  /** The legacy week text, only while `day` is null. */
  when: string | null
  state: ClassState
  page: { address: string; materials: MaterialRef[]; zipBytes: number; updatedAt: number } | null
}

/**
 * A course as a student sees it.
 *
 * A separate type rather than the whole `Course`, and the difference is
 * exactly what it lacks: `sessionId` does not go out. The eight characters of
 * a room are the whole right to write into it, so a link given to the class
 * "for reading" must not open the live notebook for them. `today` is the
 * instance's day: the browser's zone never decides what «сегодня» is.
 */
export interface PublicCourseView {
  id: CourseId
  slug: string | null
  name: string
  blurb: string | null
  today: string
  classes: PublicClass[]
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

/*
 * PublicStep, StepHeading, PublicSeminar and PublishCandidate are the 0.12
 * page model. The store still dual-writes one step (seq 0) for rollback, and
 * the old routes and screens read these until they move to PublicPage.
 */

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

/* --------------------------------------------------------- class pages */

/**
 * What a material is, by its file name (shared/materials.ts · materialKind).
 *
 * The stored kind decides how the class page offers it: a notebook opens as
 * a tab, a PDF in the browser's viewer, everything else downloads.
 *
 * 'folder' is a top-level folder of the room published whole, as one row: a
 * class whose notebooks do `from scripts import case_cian` and read
 * `data/*.csv` needs `scripts/` and `data/` next to them, with the paths
 * intact, and fifteen datasets as fifteen rows would not fit on the page or
 * in anyone's head. Its download is a ZIP of the folder.
 */
export type MaterialKind =
  | 'notebook'
  | 'pdf'
  | 'data'
  | 'code'
  | 'text'
  | 'image'
  | 'file'
  | 'folder'

export const MATERIAL_KINDS: readonly MaterialKind[] = [
  'notebook',
  'pdf',
  'data',
  'code',
  'text',
  'image',
  'file',
  'folder',
]

/** A heading of a notebook, for its table of contents. */
export interface OutlineEntry {
  /** The cell it is in: the reader scrolls to `#<cellId>`. */
  id: string
  level: 1 | 2 | 3
  /** At most MAX_OUTLINE_TEXT characters. */
  text: string
}

export interface PublicMaterial extends MaterialRef {
  /**
   * Room-relative: 'seminar.ipynb', 'lecture.pdf', and 'data' for the folder
   * `data/`. The ZIP keeps the same paths.
   */
  path: string
  cells?: number
  /** Cells with at least one output. */
  outputs?: number
  outline?: OutlineEntry[]
}

/** The class before or after this one in the course. */
export interface PublicNeighbor {
  n: number
  title: string
  day: string | null
  /** `null`: that class has no page yet. */
  address: string | null
}

export interface PublicPage {
  id: PublicationId
  slug: string | null
  address: string
  state: PublicationState
  title: string
  about: string | null
  day: string | null
  n: number | null
  today: string
  firstAt: number
  updatedAt: number
  /**
   * The instance-zone day of `updatedAt` ('YYYY-MM-DD'), for «обновлено 14 сен».
   * The server decides it, like `today`: the browser's zone never decides a day.
   */
  updatedOn: string
  course: { id: CourseId; slug: string | null; name: string } | null
  prev: PublicNeighbor | null
  next: PublicNeighbor | null
  /** Empty when withdrawn. */
  materials: PublicMaterial[]
  zip: { name: string; bytes: number } | null
}

/** A notebook tab: the PublicCell whitelist below, unchanged. */
export interface PublicNotebook {
  key: string
  cells: PublicCell[]
}

/**
 * One picked root file, or one picked folder ('data/').
 *
 * A folder goes out by the rules for what is inside it (shared/materials.ts
 * · folderEntryWhy), and those rules are suggestions like every default
 * tick: the teacher may keep a file the rules let through in the room
 * (`exclude`), or send one they hold back (`include`: a `_utils.py` the
 * package imports, a sample `submission.csv` the notebook reads). Both are
 * room paths inside the folder, and both outlive a refresh: a file that
 * arrives in the folder later follows the rules, a file decided about keeps
 * the decision.
 */
export interface PickedFile {
  path: string
  name: string
  /** Folders only: files inside that go out although the rules keep them in the room. */
  include?: string[]
  /** Folders only: files inside that stay in the room although the rules would send them. */
  exclude?: string[]
}

/**
 * What the teacher picked, kept with the page so that «Обновить страницу»
 * and the end of class rebuild it without asking again.
 *
 * Notebooks are named by ROOT, not by path: a root is issued once and lives
 * with the notebook (shared/notebook.ts · rootForNewBook), while a path gets
 * renamed. Files are named by path, since they have nothing else.
 */
export interface PublishSelection {
  v: 1
  notebooks: { root: string; name: string }[]
  /**
   * Root files by path, and folders by their path with a slash: 'data/'. A
   * folder is picked as a folder: a refresh re-reads it and takes what is in
   * it now (publish/materials.ts · build), each file by the default rules
   * unless the teacher decided otherwise for it (PickedFile · include,
   * exclude).
   */
  files: PickedFile[]
  autoRefresh: boolean
  /** Check ids the teacher confirmed («Проверил(а) — публиковать как есть»). */
  ack: string[]
  /**
   * Every notebook root, file path and top-level folder ('data/') the room
   * had when this was saved. The picker marks anything not in it «новая»:
   * added since, so neither ticked nor knowingly left out. A folder counts as
   * seen when any file in it was (picks saved before folders list only files).
   */
  seen?: string[]
  /**
   * Who the page leads into the room (RoomAccess). Absent on picks saved
   * before the door existed, which read as DEFAULT_ROOM_ACCESS (roomAccessOf).
   */
  roomAccess?: RoomAccess
}

/* ------------------------------------------------------- the room door */

/**
 * Who a class page (or its course row) offers a way into the room.
 *
 * Two objects since pages exist: the publication, frozen and forwardable, and
 * the room, where the class worked and where its marks and its oracle thread
 * stay. The room shows the participants' names and their questions, and its
 * eight characters are the right to write in it, so the page never carries
 * them: the way in is asked for separately (POST /api/p/:id/room), by a
 * browser that proves it was there.
 *
 * - 'anyone': everyone who can open the page. The default (DEFAULT_ROOM_ACCESS).
 * - 'members': whoever presents a token of this room (they joined from this
 *   browser) and is not banned.
 * - 'none': nobody but staff.
 *
 * Widest first, the order the panel draws them in.
 */
export type RoomAccess = 'members' | 'anyone' | 'none'

export const ROOM_ACCESS: readonly RoomAccess[] = ['anyone', 'members', 'none']

/**
 * What a page with no saved choice leads to, and what a first publish saves.
 *
 * 'anyone', because 'members' promises more than it can keep: there are no
 * student accounts, only the token a browser got when it joined. The same
 * student on a phone, in another browser or after clearing site data is a
 * stranger to it, while the class's own students are who the page is for.
 * The cost (names and oracle questions on view) is said under the control,
 * and the teacher narrows it per page. A page saved with 'members' (a first
 * publish used to save it) keeps it: the default only fills an absent
 * choice, and those pages are switched by hand.
 */
export const DEFAULT_ROOM_ACCESS: RoomAccess = 'anyone'

export function isRoomAccess(value: unknown): value is RoomAccess {
  return typeof value === 'string' && (ROOM_ACCESS as readonly string[]).includes(value)
}

/** The access a saved pick sets: its own, else DEFAULT_ROOM_ACCESS (also with no pick at all). */
export function roomAccessOf(
  selection: { roomAccess?: RoomAccess } | null | undefined,
): RoomAccess {
  return selection?.roomAccess ?? DEFAULT_ROOM_ACCESS
}

/**
 * How many tokens one door request may carry, and how long each may be.
 *
 * A browser holds one token per room it ever joined, newest first
 * (web/src/lib/identity.ts · storedTokens): fifty is more than a year of
 * weekly classes. A real token is a few hundred bytes; two kilobytes is room
 * to spare, and anything longer is not one.
 */
export const MAX_DOOR_TOKENS = 50
export const MAX_DOOR_TOKEN_BYTES = 2048

/**
 * The answer about the way into a class's room.
 *
 * `access` is what holds right now: 'none' as well when there is no room to
 * lead to (deleted, or the page withdrawn), so the reader draws nothing.
 * `room` is non-null only for someone allowed in, and it is the only place a
 * room address ever reaches a public reader.
 */
export interface RoomDoor {
  access: RoomAccess
  /** A token of this room, of a participant who is not banned, came with the request. */
  member: boolean
  /** The caller is staff: they always see the way in, whatever the setting. */
  staff: boolean
  /** `/s/<id>`, and whether the class is still on (not finished, not archived). */
  room: { path: string; live: boolean } | null
}

/**
 * Why a notebook or file is not ticked by default (shared/materials.ts).
 *
 * 'too-large' covers two cases told apart by size: above the instance upload
 * limit the row cannot be ticked at all; between the default-pick threshold
 * and that limit it is only unticked.
 */
export type PickReason =
  | 'student'
  | 'roster'
  | 'private'
  | 'answers'
  | 'generated'
  | 'unused'
  | 'image'
  | 'too-large'
  | 'empty'
  /** A folder with more than MAX_FOLDER_FILES files in it. */
  | 'too-many'
  /**
   * A file inside a folder named like a key or a password: `id_rsa`,
   * `server.pem`, `credentials.json`, `token.txt`.
   */
  | 'secret'
  /**
   * A file inside a folder the checks cannot read: a binary of no known data
   * or picture kind (an exported .html, a .key, a file with no extension), or
   * code and text over the size the checks read. Whatever is in it would go
   * out unseen.
   */
  | 'unchecked'

export interface NotebookChoice {
  root: string
  path: string
  cells: number
  /** Cells with at least one output. */
  outputs: number
  name: string
  picked: boolean
  why: PickReason | null
  /** The student's name for a student's own notebook. */
  owner: string | null
  /** Added since the last publish: it starts unticked. */
  isNew: boolean
}

/** One file inside a folder choice, and whether it goes out with the folder. */
export interface FolderEntry {
  /** Room path: 'data/train.csv'. */
  path: string
  kind: MaterialKind
  bytes: number
  /** `null`: the rules send it with the folder; otherwise why they keep it in the room. */
  why: PickReason | null
  /**
   * Whether it goes out with the folder under the pick on screen: the rules
   * (`why`), or the teacher's word against them (PickedFile · include,
   * exclude). A file over the upload limit never does.
   */
  picked: boolean
}

/**
 * A root file of the room, or one of its top-level folders.
 *
 * A folder comes as one choice with `kind: 'folder'` and a path with a slash
 * ('data/'); `bytes` and `files` count only what would go out under the
 * saved pick (or the rules, before the first publish), and `entries` lists
 * everything inside, each ticked or not, with the rules' reason for those
 * they keep in the room («состав папки»). Notebooks are never inside: they
 * are notebook choices of their own.
 */
export interface FileChoice {
  path: string
  kind: MaterialKind
  bytes: number
  name: string
  picked: boolean
  why: PickReason | null
  /**
   * Paths of the notebooks that mention this file. For a folder: of the
   * notebooks, and of the code going out on the page, that mention a file in
   * it, read the folder or import it as a package.
   */
  usedBy: string[]
  isNew: boolean
  /** Folders only: how many files would go out in it. */
  files?: number
  /** Folders only: what those files are (MaterialRef · holds). */
  holds?: MaterialKind[]
  /** Folders only: every file inside, in tree order (up to MAX_FOLDER_FILES + 1). */
  entries?: FolderEntry[]
  /**
   * Folders only: the notebooks whose notes draw a picture from it. Such a
   * folder is ticked by default: the archive needs the pictures to show them.
   */
  inNotes?: string[]
}

/**
 * Something on the page the teacher should look at before it goes public.
 *
 * `id` is stable across rebuilds (a hash of what and where), so a
 * confirmation survives «Обновить страницу» as long as the finding is the
 * same one; a new key in a cell is a new id and stops the refresh.
 */
export interface PublishCheck {
  id: string
  kind: 'secret' | 'name' | 'roomId'
  /** «Семинар», ячейка 14 | data/notes.txt */
  where: string
  root: string | null
  cellId: string | null
  path: string | null
  /** Masked for secrets («sk-p…3f»), as found for names. */
  sample: string
  /**
   * The folder choice a file finding belongs to ('data/'), when the file is
   * inside one: the picker ticks the folder, not the file.
   */
  folder?: string
}

export interface AdminPage {
  id: PublicationId
  slug: string | null
  address: string
  state: PublicationState
  firstAt: number
  publishedAt: number
  revision: number
  materials: (MaterialRef & { path: string })[]
  zipBytes: number
  former: string[]
}

export interface PublishInfo {
  room: { id: string; name: string; createdAt: number; finishedAt: number | null; exists: boolean }
  course: {
    id: CourseId
    name: string
    slug: string | null
    row: { id: string; n: number | null; title: string; day: string | null }
  } | null
  heldOn: string | null
  notebooks: NotebookChoice[]
  files: FileChoice[]
  checks: PublishCheck[]
  /** Cells the room address was removed from. */
  scrubbed: number
  selection: PublishSelection | null
  /** The saved RoomAccess, else DEFAULT_ROOM_ACCESS (roomAccessOf). */
  roomAccess: RoomAccess
  page: AdminPage | null
  limits: { materials: number; pageBytes: number; fileBytes: number }
}

/** studentTitle: what students see as the class's name. */
export function studentTitle(row: { title?: string | null; name: string }): string {
  return row.title?.trim() || row.name
}

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
 * The page is there, the material is not: a tab or download link from before
 * a rebuild that renamed or dropped it. The class page offers the first
 * material instead of saying the page is gone.
 */
export const MATERIAL_NOT_FOUND = 'material not found'
/** What the 0.12 step addresses answer now (410), with the page's address to go to. */
export const STEPS_GONE = 'steps are gone'

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

/** The same verdict for a notebook tab (`/api/p/:id/m/:key`): no such material, or no page. */
export function refusedMaterial(status: number, message: string): 'material' | 'publication' | null {
  if (status !== 404) return null
  if (message === MATERIAL_NOT_FOUND) return 'material'
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
/**
 * The label of the dual-written seq 0 step (publish/store.ts). Still read by
 * the old publish screen; goes with it.
 */
export const MAX_STEP_LABEL = 80
/** How many steps can be published at once. Forty is already a semester. */
export const MAX_STEPS = 40

/**
 * Materials on one page: two notebooks, slides and a few data files fit with
 * room to spare. A folder is one material, however many files it holds.
 */
export const MAX_MATERIALS = 24
/**
 * Files in one folder material. A dataset folder is tens of files; a thousand
 * is a `pip install --target` or a dump of images, and every one of them is a
 * row, a hash and a ZIP entry.
 */
export const MAX_FOLDER_FILES = 1000
/** One page, all materials together: far under the 4 GB a plain (non-ZIP64) archive holds. */
export const MAX_PAGE_BYTES = 200 * 1024 * 1024
/** A tab name or a file label. */
export const MAX_MATERIAL_NAME = 60
/** Headings in one notebook's table of contents, and characters in one heading. */
export const MAX_OUTLINE = 60
export const MAX_OUTLINE_TEXT = 120
/**
 * Default-pick thresholds: data is ticked up to 20 MB, code and text up to
 * 200 KB. Above them a file is still allowed (up to the upload limit), only
 * not ticked by itself.
 */
export const PICK_DATA_BYTES = 20 * 1024 * 1024
export const PICK_TEXT_BYTES = 200 * 1024

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
 * Whether to let search engines onto published pages.
 *
 * There used to be two carriers: a static Pages export (retired) and the live
 * instance (`/p/`, `/c/` in `server/src/index.ts`). While the rule lived in
 * comments on both sides, the comments managed to diverge: the static
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
