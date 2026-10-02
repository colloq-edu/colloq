import { tr } from '@shared/i18n'
/**
 * A class page: what the teacher can put on it, and building it.
 *
 * `publishInfo` answers the «Страница занятия» screen: every notebook of the
 * room (by root, in the room's order) and every file of its folder, each
 * with a default tick and the reason when it is not ticked, plus the checks
 * the page would need confirmed. `buildAndWrite` takes the teacher's pick and
 * makes the page: every picked notebook projected with its outputs, the room
 * address scrubbed, outlines, a downloadable .ipynb with outputs, and the
 * picked files copied byte for byte into the page-file store.
 *
 * Nothing replays history any more. A page is the room as it is when the
 * teacher presses «Опубликовать» (or when the class ends, for a page that
 * refreshes itself), which is what a student wants to read.
 */
import {
  allBooks,
  readCell,
  type CellSnapshot,
} from '@shared/notebook'
import { isClassDay } from '@shared/class-day'
import { normalizePath } from '@shared/paths'
import { findWorkspaceImages } from '@shared/images'
import { SESSION_MISSING } from '@shared/protocol'
import {
  filePick,
  materialKey,
  materialKind,
  materialRank,
  mentioned,
  notebookPick,
  suggestNames,
} from '@shared/materials'
import {
  isRoomAccess,
  MATERIAL_NOT_FOUND,
  MAX_MATERIAL_NAME,
  MAX_MATERIALS,
  MAX_OUTLINE,
  MAX_OUTLINE_TEXT,
  MAX_PAGE_BYTES,
  PUBLICATION_NOT_FOUND,
  publicationAddress,
  slugOk,
  spillEncoding,
  studentTitle,
  suggestSlug,
  type AdminPage,
  type Course,
  type CourseItem,
  type FileChoice,
  type MaterialKind,
  type NotebookChoice,
  type OutlineEntry,
  type PublicCell,
  type PublishCheck,
  type PublishInfo,
  type PublishSelection,
  type RoomAccess,
} from '@shared/publish'
import { finishedAt, getSession, listParticipants, storedRules } from '../db.js'
import { uploadLimitBytes } from '../admin/resource-settings.js'
import { blobBytes, readBlob } from '../blobs.js'
import { visitSessionDoc } from '../routes/doc-visit.js'
import { courseOfPublication, courseOfSeminar, courseRows } from '../routes/course-view.js'
import { instanceToday } from '../time-zone.js'
import { listTree, readBytes, statPath } from '../workspace.js'
import { bookPage, newBlobBag } from './build.js'
import { cellChecks, fileChecks, scrubCells, scrubText, type SpillReader } from './checks.js'
import { notebookWithOutputs, type BlobSource } from './notebook.js'
import { putPageFile } from './page-files.js'
import {
  dropMaterial,
  findPublication,
  formerSlugs,
  getPublication,
  listMaterials,
  publicationOf,
  savePublicationSelection,
  setPublicationSlug,
  writePublication,
  type Publication,
  type StoredMaterial,
} from './store.js'
import { zipTop } from './zip.js'

/* ------------------------------------------------------------- vocabulary */

/**
 * The type a material is served as, from a fixed extension map and never from
 * what was stored: a file's bytes come from a room anyone can write to, and
 * `content-type` decides what a direct link turns into.
 */
export function downloadTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'ipynb':
      return 'application/x-ipynb+json'
    case 'pdf':
      return 'application/pdf'
    case 'csv':
      return 'text/csv'
    case 'tsv':
      return 'text/tab-separated-values'
    case 'json':
    case 'jsonl':
      return 'application/json'
    case 'py':
    case 'md':
    case 'txt':
    case 'r':
    case 'sql':
    case 'sh':
    case 'yaml':
    case 'yml':
      return 'text/plain; charset=utf-8'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

/**
 * The size of the class ZIP, for the page to print before anyone downloads.
 *
 * A store-only archive with one top folder: per entry a local header (30
 * bytes + name), the bytes, a central-directory record (46 + name), and the
 * end record (22). No directory entries, no data descriptors, no extra
 * fields. The README the ZIP route writes on the fly is not counted: it is a
 * kilobyte, and the route computes its exact Content-Length itself.
 */
export function zipBytesFor(
  top: string,
  entries: readonly { path: string; bytes: number }[],
): number {
  let total = 22
  for (const entry of entries) {
    const name = Buffer.byteLength(`${top}/${entry.path}`)
    total += 30 + name + entry.bytes + 46 + name
  }
  return total
}

/** Markdown inline syntax off a heading: the outline prints plain words. */
function plainHeading(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The table of contents of a notebook: its h1–h3 headings, at most
 * MAX_OUTLINE, each pointing at its cell. Headings inside fenced code are
 * code, not headings.
 */
export function outlineOf(cells: readonly PublicCell[]): OutlineEntry[] {
  const out: OutlineEntry[] = []
  for (const cell of cells) {
    if (cell.type !== 'markdown') continue
    let fence: string | null = null
    for (const line of cell.source.split('\n')) {
      const fenced = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      if (fenced) {
        if (fence === null) fence = fenced[1][0]
        else if (fenced[1][0] === fence) fence = null
        continue
      }
      if (fence !== null) continue
      const heading = /^\s{0,3}(#{1,3})\s+(.*?)\s*#*\s*$/.exec(line)
      if (!heading) continue
      const text = plainHeading(heading[2]).slice(0, MAX_OUTLINE_TEXT)
      if (!text) continue
      out.push({ id: cell.id, level: heading[1].length as 1 | 2 | 3, text })
      if (out.length >= MAX_OUTLINE) return out
    }
  }
  return out
}

/** Cells with at least one output. */
export function outputCount(cells: readonly { outputs: readonly unknown[] }[]): number {
  return cells.filter((cell) => cell.outputs.length > 0).length
}

/**
 * One notebook material, stored: the .ipynb with outputs goes into the
 * page-file store, and the row keeps the cells, the outline and the counts.
 * Shared by the build and by the boot migration of 0.12 pages.
 */
export function notebookMaterial(input: {
  key: string
  name: string
  path: string
  cells: PublicCell[]
  blob: BlobSource
  /** The .ipynb bytes, when the caller has already made them. */
  body?: Buffer
}): StoredMaterial {
  const body = input.body ?? Buffer.from(notebookWithOutputs(input.cells, input.blob), 'utf8')
  const file = putPageFile(body, downloadTypeOf(input.path))
  return {
    key: input.key,
    kind: 'notebook',
    name: input.name,
    path: input.path,
    hash: file.hash,
    bytes: file.bytes,
    cells: input.cells,
    outline: outlineOf(input.cells),
    cellCount: input.cells.length,
    outputCount: outputCount(input.cells),
  }
}

/* ------------------------------------------------------------ room facts */

interface BookScan {
  root: string
  path: string
  cells: CellSnapshot[]
}

function scanBooks(sessionId: string): BookScan[] {
  return visitSessionDoc(sessionId, (doc) =>
    allBooks(doc).map(({ book, cells }) => ({
      root: book.root,
      path: book.path,
      cells: cells.toArray().map(readCell),
    })),
  )
}

/** The room's participants, minus its hosts: the names a page should not carry by accident. */
function rosterOf(sessionId: string): string[] {
  return listParticipants(sessionId)
    .filter((p) => p.role !== 'host')
    .map((p) => p.name)
    .filter((name) => name.trim().length > 0)
}

const isEmptyBook = (cells: readonly CellSnapshot[]): boolean =>
  cells.every((cell) => cell.source.trim() === '' && cell.outputs.length === 0)

/** The cells as the checks see them: the same text a build would publish. */
function lightCells(cells: readonly CellSnapshot[]): PublicCell[] {
  return cells.map((cell) => ({
    id: cell.id,
    type: cell.type,
    source: cell.source,
    outputs: cell.outputs,
    execCount: cell.execCount,
    ranMs: cell.ranMs,
  }))
}

/** The course row this room is seated in, with its ordinal among non-pause rows. */
function courseRowOf(
  sessionId: string,
  roomName: string,
): { course: Course; row: CourseItem; n: number | null; title: string } | null {
  const course = courseOfSeminar(sessionId)
  if (!course) return null
  let n = 0
  for (const item of course.items) {
    const pause = item.kind === 'planned' && item.pause === true
    if (!pause) n++
    if (item.kind === 'seminar' && item.sessionId === sessionId) {
      return { course, row: item, n, title: studentTitle({ title: item.title, name: roomName }) }
    }
  }
  return null
}

export function adminPageOf(pub: Publication): AdminPage {
  return {
    id: pub.id,
    slug: pub.slug,
    address: publicationAddress(pub),
    state: pub.state,
    firstAt: pub.firstAt,
    publishedAt: pub.publishedAt,
    revision: pub.revision,
    materials: listMaterials(pub.id).map((m) => ({
      key: m.key,
      kind: m.kind,
      name: m.name,
      bytes: m.bytes,
      path: m.path,
    })),
    zipBytes: pub.zipBytes,
    former: formerSlugs('publication', pub.id),
  }
}

/* ------------------------------------------------------------ the picker */

const TEXT_SCAN_BYTES = 2 * 1024 * 1024
const TEXT_SCAN_BUDGET = 32 * 1024 * 1024
const TEXT_KINDS: ReadonlySet<MaterialKind> = new Set(['code', 'text', 'data'])
const TEXT_DATA_EXT = /\.(csv|tsv|json|jsonl|ndjson|geojson|txt)$/i

/** Whether a file is text a room id, a key or a name could be in, and small enough to read. */
function scannable(path: string, bytes: number): boolean {
  const kind = materialKind(path)
  if (!TEXT_KINDS.has(kind) || bytes > TEXT_SCAN_BYTES) return false
  return kind !== 'data' || TEXT_DATA_EXT.test(path)
}

/**
 * The picker's view of a plotly figure on the room's shelf: the build reads
 * the same figure out of its blob bag, and the two must find the same names.
 */
function shelfReader(sessionId: string): SpillReader {
  return {
    shelf: (sha) => {
      const bytes = blobBytes(sessionId, sha)
      if (bytes === null || bytes > TEXT_SCAN_BYTES) return null
      return readBlob(sessionId, sha)?.toString('utf8') ?? null
    },
  }
}

/**
 * Everything the «Страница занятия» screen shows for a room, or `null` when
 * there is no such room.
 *
 * With a saved selection, the ticks are that selection (a refresh publishes
 * exactly it); without one, they are the defaults from shared/materials.ts.
 * Unticked rows carry their default reason either way.
 */
export function publishInfo(sessionId: string): PublishInfo | null {
  const session = getSession(sessionId)
  if (!session) return null
  const pub = publicationOf(sessionId)
  const selection = pub?.selection ?? null
  const seen = selection?.seen ? new Set(selection.seen) : null
  const roster = rosterOf(sessionId)
  const shelf = shelfReader(sessionId)
  const rules = storedRules(sessionId).books ?? {}
  const fileLimit = uploadLimitBytes()
  const books = scanBooks(sessionId)
  const names = suggestNames(books.map((b) => b.path))

  const notebooks: NotebookChoice[] = []
  const checks: PublishCheck[] = []
  let scrubbed = 0
  const sources = new Map<string, string>()
  const inNotes = new Set<string>()
  books.forEach((book, i) => {
    const picked = selection?.notebooks.find((n) => n.root === book.root) ?? null
    const name = picked?.name ?? names[i]
    const rule = rules[book.root]
    const owner = rule?.owner ? (rule.ownerName ?? rule.owner) : null
    const empty = isEmptyBook(book.cells)
    const fallback = notebookPick({ path: book.path, empty, owner, roster })
    notebooks.push({
      root: book.root,
      path: book.path,
      cells: book.cells.length,
      outputs: outputCount(book.cells),
      name,
      picked: selection ? picked !== null && !empty : fallback.picked,
      why: selection ? (picked !== null && !empty ? null : fallback.why) : fallback.why,
      owner,
      isNew: seen !== null && !seen.has(book.root),
    })
    const clean = scrubCells(lightCells(book.cells), sessionId)
    scrubbed += clean.scrubbed
    checks.push(...cellChecks({ root: book.root, name, cells: clean.cells }, roster, shelf))
    sources.set(book.path, book.cells.map((c) => c.source).join('\n'))
    for (const cell of book.cells) {
      if (cell.type !== 'markdown') continue
      for (const ref of findWorkspaceImages(cell.source)) inNotes.add(ref.path)
    }
  })

  // The order the page will have: the teacher's saved order when there is one,
  // otherwise lecture, seminar, other notebooks, homework — the room's own
  // order is just the order the files happened to be opened in.
  const placeOf = (n: NotebookChoice): number => {
    if (selection) {
      const at = selection.notebooks.findIndex((s) => s.root === n.root)
      return at >= 0 ? at : selection.notebooks.length
    }
    return materialRank({ kind: 'notebook', name: n.name, path: n.path })
  }
  notebooks.sort((a, b) => placeOf(a) - placeOf(b))

  const files: FileChoice[] = []
  let budget = TEXT_SCAN_BUDGET
  for (const entry of listTree(sessionId).files) {
    if (entry.dir) continue
    const kind = materialKind(entry.path)
    if (kind === 'notebook') continue
    const usedBy = [...sources].filter(([, text]) => mentioned(entry.path, text)).map(([p]) => p)
    const fallback = filePick({
      path: entry.path,
      kind,
      bytes: entry.size,
      usedBy,
      inNotes: inNotes.has(entry.path),
      roster,
      fileLimit,
    })
    const picked = selection?.files.find((f) => f.path === entry.path) ?? null
    const allowed = entry.size <= fileLimit
    files.push({
      path: entry.path,
      kind,
      bytes: entry.size,
      name: picked?.name ?? suggestNames([entry.path])[0],
      picked: selection ? picked !== null && allowed : fallback.picked,
      why: selection ? (picked !== null && allowed ? null : fallback.why) : fallback.why,
      usedBy,
      isNew: seen !== null && !seen.has(entry.path),
    })
    if (budget > 0 && scannable(entry.path, entry.size)) {
      const body = readBytes(sessionId, entry.path, TEXT_SCAN_BYTES)
      if (body) {
        budget -= body.length
        checks.push(...fileChecks(entry.path, body.toString('utf8'), sessionId, roster))
      }
    }
  }

  const seat = courseRowOf(sessionId, session.name)
  return {
    room: {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      finishedAt: finishedAt(sessionId),
      exists: true,
    },
    course: seat
      ? {
          id: seat.course.id,
          name: seat.course.name,
          slug: seat.course.slug,
          row: { id: seat.row.id ?? '', n: seat.n, title: seat.title, day: seat.row.day ?? null },
        }
      : null,
    heldOn: pub?.heldOn ?? null,
    notebooks,
    files,
    checks,
    scrubbed,
    selection,
    roomAccess: selection?.roomAccess ?? 'members',
    page: pub ? adminPageOf(pub) : null,
    limits: { materials: MAX_MATERIALS, pageBytes: MAX_PAGE_BYTES, fileBytes: fileLimit },
  }
}

/**
 * The screen for a page whose room was deleted: nothing left to pick from,
 * only the page's current materials, each of which can still be taken off
 * («Убрать со страницы»). Found by the page's id, since the room's is gone.
 */
export function orphanPublishInfo(pubId: string): PublishInfo | null {
  const pub = getPublication(pubId)
  if (!pub || (pub.sessionId !== null && getSession(pub.sessionId))) return null
  const course = courseOfPublication(pub)
  const row = course ? courseRows(course).find((r) => r.pub?.id === pub.id) ?? null : null
  return {
    room: { id: '', name: pub.title, createdAt: pub.firstAt, finishedAt: null, exists: false },
    course:
      course && row
        ? {
            id: course.id,
            name: course.name,
            slug: course.slug,
            row: { id: row.item.id ?? '', n: row.n, title: row.title, day: row.day },
          }
        : null,
    heldOn: pub.heldOn,
    notebooks: [],
    files: [],
    checks: [],
    scrubbed: 0,
    selection: pub.selection,
    roomAccess: pub.selection?.roomAccess ?? 'members',
    page: adminPageOf(pub),
    limits: { materials: MAX_MATERIALS, pageBytes: MAX_PAGE_BYTES, fileBytes: uploadLimitBytes() },
  }
}

export type RemoveResult =
  | { ok: true; publication: Publication; page: AdminPage; removed: { key: string; name: string } }
  | { ok: false; status: 404 | 409; error: string }

/**
 * Take one material off a page, and out of its saved pick, so the next
 * refresh does not bring it back. The last one stays: a page with nothing on
 * it is a withdrawal, and that has its own button.
 *
 * In the build queue: a build yields between files and then writes the whole
 * list and pick it computed at its start, so a removal committed in between
 * would be undone by it, and every later refresh would keep the notebook.
 */
export function removeMaterial(pubId: string, key: string): Promise<RemoveResult> {
  return serialized(async () => dropOne(pubId, key))
}

function dropOne(pubId: string, key: string): RemoveResult {
  const pub = getPublication(pubId) ?? findPublication(pubId)
  if (!pub) return { ok: false, status: 404, error: PUBLICATION_NOT_FOUND }
  const materials = listMaterials(pub.id)
  const target = materials.find((m) => m.key === key)
  if (!target) return { ok: false, status: 404, error: MATERIAL_NOT_FOUND }
  if (materials.length <= 1) return { ok: false, status: 409, error: tr('server.publish.lastMaterial') }
  const rest = materials.filter((m) => m.key !== key)
  let selection = pub.selection
  if (selection && target.kind === 'notebook') {
    /*
     * Notebook materials are written in the order of the pick's notebooks, so
     * the position names the root; the name confirms it, and is the fallback
     * if a hand-edited pick ever disagrees.
     */
    const at = materials.filter((m) => m.kind === 'notebook').indexOf(target)
    const byPlace = selection.notebooks[at]?.name === target.name ? at : -1
    const drop = byPlace >= 0 ? byPlace : selection.notebooks.findIndex((n) => n.name === target.name)
    if (drop >= 0) {
      selection = { ...selection, notebooks: selection.notebooks.filter((_, i) => i !== drop) }
    }
  } else if (selection) {
    selection = { ...selection, files: selection.files.filter((f) => f.path !== target.path) }
  }
  if (!dropMaterial(pub.id, key, { selection, zipBytes: zipBytesFor(zipTop(pub), rest) })) {
    return { ok: false, status: 404, error: MATERIAL_NOT_FOUND }
  }
  const fresh = getPublication(pub.id)!
  return { ok: true, publication: fresh, page: adminPageOf(fresh), removed: { key, name: target.name } }
}

/* ------------------------------------------------------------- the build */

export interface PublishRequest {
  notebooks: { root: string; name: string }[]
  files: { path: string; name: string }[]
  autoRefresh: boolean
  ack: string[]
  /** Pages outside a course only; ignored for a seated room. */
  heldOn?: string | null
  /** Absent keeps the saved setting (or the default 'members' on a first publish). */
  roomAccess?: RoomAccess
}

export type RefusedReason = 'missing' | 'too-large' | 'budget'

export type BuildResult =
  | {
      ok: true
      publication: Publication
      page: AdminPage
      refused: { path: string; reason: RefusedReason }[]
    }
  | {
      ok: false
      status: 400 | 404 | 409
      error: string
      checks?: PublishCheck[]
      /** A refresh that had nothing to do: the page is withdrawn, or no longer refreshes itself. */
      skipped?: true
    }

const bad = (error: string): BuildResult => ({ ok: false, status: 400, error })

/** Shapes a request body into a PublishRequest, or names what is wrong with it. */
export function readPublishRequest(body: unknown): PublishRequest | string {
  const raw = (body ?? {}) as Record<string, unknown>
  const list = (value: unknown) =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : []
  const name = (value: unknown) =>
    typeof value === 'string' ? value.trim().slice(0, MAX_MATERIAL_NAME) : ''
  const notebooks = list(raw.notebooks)
    .filter((n) => typeof n?.root === 'string')
    .map((n) => ({ root: n.root as string, name: name(n.name) }))
  const files = list(raw.files)
    .filter((f) => typeof f?.path === 'string')
    .map((f) => ({ path: f.path as string, name: name(f.name) }))
  const ack = Array.isArray(raw.ack)
    ? raw.ack.filter((a): a is string => typeof a === 'string')
    : []
  let heldOn: string | null | undefined
  if (raw.heldOn === null) heldOn = null
  else if (raw.heldOn !== undefined) {
    if (!isClassDay(raw.heldOn)) return tr('server.course.badDay')
    heldOn = raw.heldOn
  }
  if (raw.roomAccess !== undefined && !isRoomAccess(raw.roomAccess)) {
    return tr('server.roomDoor.badAccess')
  }
  return {
    notebooks,
    files,
    autoRefresh: raw.autoRefresh !== false,
    ack,
    heldOn,
    ...(raw.roomAccess !== undefined ? { roomAccess: raw.roomAccess as RoomAccess } : {}),
  }
}

/*
 * One build at a time per process. A build reads up to 200 MB of room files
 * and hashes them; two at once would only double the time each of them holds
 * the class's process, and the page-file GC relies on a build putting its
 * files and committing its page in one synchronous stretch.
 *
 * Every other write of a page's materials or pick goes through the same
 * queue (a removal, the room-door setting): a build yields between files and
 * then commits what it computed at its start, which would silently undo
 * anything committed in between.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

const pause = () => new Promise<void>((resume) => setImmediate(resume))

/**
 * Build the page from a pick and write it.
 *
 * `lenient` is the refresh: a notebook removed from the room since the pick
 * is reported as refused instead of failing the whole rebuild.
 */
export function buildAndWrite(
  sessionId: string,
  request: PublishRequest,
  options: { by: string | null; lenient?: boolean },
): Promise<BuildResult> {
  return serialized(() => build(sessionId, request, options))
}

/**
 * Rebuild from the saved selection: «Обновить страницу» and the end of class.
 *
 * The page and its pick are read INSIDE the queue: a refresh queued behind a
 * teacher's «Опубликовать» rebuilds from the pick that publish saved, not
 * from the one it replaced. A withdrawn page is left alone: a refresh is not
 * a restore, and the teacher may have withdrawn it for the very key or name
 * the rebuild would put back. `auto` is the end of class, which also needs
 * the pick to still say «Обновлять страницу».
 */
export function refreshPage(
  sessionId: string,
  options: { by: string | null; auto?: boolean },
): Promise<BuildResult> {
  return serialized(async (): Promise<BuildResult> => {
    const pub = publicationOf(sessionId)
    const selection = pub?.selection
    if (!pub || !selection) return { ok: false, status: 409, error: 'no selection' }
    if (pub.state !== 'published') {
      return { ok: false, status: 409, error: tr('server.publish.withdrawnRefresh'), skipped: true }
    }
    if (options.auto && !selection.autoRefresh) {
      return { ok: false, status: 409, error: 'no auto-refresh', skipped: true }
    }
    // No roomAccess: a refresh keeps whatever the page has at commit time.
    const request = {
      notebooks: selection.notebooks,
      files: selection.files,
      autoRefresh: selection.autoRefresh,
      ack: selection.ack,
    }
    return build(sessionId, request, { by: options.by, lenient: true })
  })
}

export type RoomAccessResult =
  | { ok: true; access: RoomAccess; was: RoomAccess; publication: Publication }
  | { ok: false; status: 404 | 409; error: string }

/**
 * Save who the page leads into the room, and nothing else. In the build
 * queue, for the same reason as a removal: a build in flight would write its
 * own copy of the pick over it.
 */
export function setRoomAccess(pubId: string, access: RoomAccess): Promise<RoomAccessResult> {
  return serialized(async (): Promise<RoomAccessResult> => {
    const pub = getPublication(pubId)
    if (!pub) return { ok: false, status: 404, error: PUBLICATION_NOT_FOUND }
    if (!pub.selection) return { ok: false, status: 409, error: tr('server.roomDoor.publishFirst') }
    const was = pub.selection.roomAccess ?? 'members'
    if (was !== access) savePublicationSelection(pub.id, { ...pub.selection, roomAccess: access })
    return { ok: true, access, was, publication: pub }
  })
}

async function build(
  sessionId: string,
  request: PublishRequest,
  options: { by: string | null; lenient?: boolean },
): Promise<BuildResult> {
  const session = getSession(sessionId)
  if (!session) return { ok: false, status: 404, error: SESSION_MISSING }
  // What the page was when this build started; see the check before the commit.
  const startedAt = publicationOf(sessionId)?.revision ?? null
  const total = request.notebooks.length + request.files.length
  if (total === 0) return bad(tr('server.publish.nothing'))
  if (total > MAX_MATERIALS) return bad(tr('server.publish.tooMany', { n: MAX_MATERIALS }))
  const files: { path: string; name: string }[] = []
  for (const file of request.files) {
    const path = normalizePath(file.path)
    if (!path) return bad(tr('server.publish.badPath', { path: file.path }))
    // A notebook goes out as a notebook, by its root: as a "file" it would be
    // a tab with no cells, sharing a path with the real one.
    if (materialKind(path) === 'notebook') continue
    if (!files.some((f) => f.path === path)) files.push({ path, name: file.name })
  }

  const refused: { path: string; reason: RefusedReason }[] = []
  const roster = rosterOf(sessionId)
  const fileLimit = uploadLimitBytes()
  const bag = newBlobBag()

  // The notebooks, projected from the live document in one visit.
  type Built = { root: string; path: string; name: string; cells: PublicCell[] }
  let roots: string[] = []
  const built = visitSessionDoc(sessionId, (doc): Built[] | string => {
    const books = allBooks(doc)
    roots = books.map((b) => b.book.root)
    const out: Built[] = []
    for (const asked of request.notebooks) {
      if (out.some((b) => b.root === asked.root)) continue
      const book = books.find((b) => b.book.root === asked.root)
      if (!book) {
        if (options.lenient) {
          refused.push({ path: asked.name || asked.root, reason: 'missing' })
          continue
        }
        return tr('server.publish.unknownNotebook', { root: asked.root })
      }
      const cells = bookPage(doc, book.book.root, bag, sessionId)
      out.push({ root: book.book.root, path: book.book.path, name: asked.name, cells })
    }
    return out
  })
  if (typeof built === 'string') return bad(built)
  const names = suggestNames(built.map((b) => b.path))

  // A plotly figure is behind a blob ref by now; the checks read it back from the bag.
  const blobs = new Map(bag.all().map((b) => [b.hash, { mime: b.mime, body: b.body }]))
  const blob: BlobSource = (hash) => blobs.get(hash) ?? null
  const spilled: SpillReader = {
    ref: (hash) => {
      const piece = blobs.get(hash)
      return piece && spillEncoding(piece.mime) === 'utf8' ? piece.body.toString('utf8') : null
    },
  }
  const checks: PublishCheck[] = []
  const notebooks = built.map((book, i) => {
    const name = book.name || names[i]
    const clean = scrubCells(book.cells, sessionId)
    checks.push(...cellChecks({ root: book.root, name, cells: clean.cells }, roster, spilled))
    return { ...book, name, cells: clean.cells }
  })

  // The files, read whole (each at most the upload limit), yielding between them.
  const ipynbs = notebooks.map((book) => Buffer.from(notebookWithOutputs(book.cells, blob), 'utf8'))
  let pageBytes = ipynbs.reduce((sum, body) => sum + body.length, 0)
  const read: { path: string; name: string; body: Buffer }[] = []
  for (const file of files) {
    await pause()
    const stat = statPath(sessionId, file.path)
    if (!stat || stat.dir) {
      refused.push({ path: file.path, reason: 'missing' })
      continue
    }
    if (stat.size > fileLimit) {
      refused.push({ path: file.path, reason: 'too-large' })
      continue
    }
    if (pageBytes + stat.size > MAX_PAGE_BYTES) {
      refused.push({ path: file.path, reason: 'budget' })
      continue
    }
    const body = readBytes(sessionId, file.path, fileLimit)
    if (!body) {
      refused.push({ path: file.path, reason: 'missing' })
      continue
    }
    pageBytes += body.length
    read.push({ path: file.path, name: file.name || suggestNames([file.path])[0], body })
    if (scannable(file.path, body.length)) {
      checks.push(...fileChecks(file.path, body.toString('utf8'), sessionId, roster))
    }
  }
  if (notebooks.length + read.length === 0) return bad(tr('server.publish.nothing'))

  const acked = new Set(request.ack)
  const open = checks.filter((check) => !acked.has(check.id))
  if (open.length > 0) return { ok: false, status: 409, error: 'unconfirmed', checks: open }

  // Page order: notebooks as picked, then files by kind (PDFs, data, code, the rest).
  read.sort(
    (a, b) =>
      materialRank({ kind: materialKind(a.path), name: a.name, path: a.path }) -
      materialRank({ kind: materialKind(b.path), name: b.name, path: b.path }),
  )

  const existing = publicationOf(sessionId)
  /*
   * A backstop: every write of a page goes through the build queue, so the
   * page cannot have moved since this build started. If something ever
   * writes around the queue, its change is reported rather than overwritten
   * with a list and a pick computed before it.
   */
  if ((existing?.revision ?? null) !== startedAt) {
    return { ok: false, status: 409, error: tr('server.publish.changedMeanwhile') }
  }
  const seat = courseRowOf(sessionId, session.name)
  // The stored title goes out on the page and its link card; the room's id must not ride along.
  const title = scrubText(seat ? seat.title : session.name, sessionId)
  const defaultSlug =
    !existing && seat?.course.slug && seat.n !== null
      ? `${seat.course.slug}-${String(seat.n).padStart(2, '0')}`
      : null
  // The ZIP's top folder (zip.ts · zipTop); only an estimate is stored, the route counts exactly.
  const top = existing ? zipTop(existing) : (defaultSlug ?? (suggestSlug(title) || 'xxxxxxxx'))
  let heldOn: string | null | undefined
  if (!seat) {
    if (request.heldOn !== undefined) heldOn = request.heldOn
    else if (!existing) {
      const finished = finishedAt(sessionId)
      heldOn = finished !== null ? instanceToday(finished) : instanceToday()
    }
  }
  const selection: PublishSelection = {
    v: 1,
    notebooks: notebooks.map((b) => ({ root: b.root, name: b.name })),
    files: files.map((f) => ({
      path: f.path,
      name: read.find((r) => r.path === f.path)?.name ?? f.name,
    })),
    autoRefresh: request.autoRefresh,
    ack: [...acked].filter((id) => checks.some((c) => c.id === id)),
    // A refresh is not the teacher looking at the picker: what was new stays new.
    seen: (options.lenient ? existing?.selection?.seen : undefined) ?? [
      ...roots,
      ...listTree(sessionId).files.filter((e) => !e.dir).map((e) => e.path),
    ],
    // Who the page leads into the room survives every rebuild until the teacher changes it.
    roomAccess: request.roomAccess ?? existing?.selection?.roomAccess ?? 'members',
  }

  /*
   * From here to the commit nothing yields: the page-file rows are inserted
   * and referenced in one stretch, so the GC (page-files.ts) can never see
   * them unreferenced in between.
   */
  const taken = new Set<string>()
  const materials: StoredMaterial[] = []
  notebooks.forEach((book, i) => {
    const key = materialKey(book.path, 'notebook', taken)
    taken.add(key)
    const { name, path, cells } = book
    materials.push(notebookMaterial({ key, name, path, cells, blob, body: ipynbs[i] }))
  })
  for (const file of read) {
    const kind = materialKind(file.path)
    const key = materialKey(file.path, kind, taken)
    taken.add(key)
    const stored = putPageFile(file.body, downloadTypeOf(file.path))
    materials.push({
      key,
      kind,
      name: file.name,
      path: file.path,
      hash: stored.hash,
      bytes: stored.bytes,
    })
  }
  const publication = writePublication({
    sessionId,
    title,
    by: options.by,
    materials,
    blobs: bag.all(),
    selection,
    zipBytes: zipBytesFor(top, materials),
    heldOn,
    // Only «Опубликовать» (or «Вернуть») makes a page public; a refresh keeps its state.
    keepState: options.lenient === true,
  })
  // The first publish from a course with an address gets '<course>-<nn>', if free.
  if (defaultSlug && slugOk(defaultSlug)) setPublicationSlug(publication.id, defaultSlug)
  const fresh = publicationOf(sessionId) ?? publication
  return { ok: true, publication: fresh, page: adminPageOf(fresh), refused }
}
