import { tr } from '@shared/i18n'
/**
 * A class page: what the teacher can put on it, and building it.
 *
 * `publishInfo` answers the «Страница занятия» screen: every notebook of the
 * room (by root, in the room's order), every file at the root of its folder,
 * and every top-level folder as one choice, each with a default tick and the
 * reason when it is not ticked, plus the checks the page would need
 * confirmed. `buildAndWrite` takes the teacher's pick and makes the page:
 * every picked notebook projected with its outputs, the room address
 * scrubbed, outlines, a downloadable .ipynb with outputs, and the picked
 * files and folders copied byte for byte into the page-file store.
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
import { SESSION_MISSING, type FileEntry } from '@shared/protocol'
import {
  entryGoes,
  filePick,
  folderEntryWhy,
  folderMentioned,
  folderPick,
  forgetImports,
  holdsOf,
  materialKey,
  materialKind,
  materialRank,
  mentioned,
  neededModules,
  notebookPick,
  scannable,
  SCAN_TEXT_BYTES,
  suggestNames,
  type DefaultPick,
  type FolderChoice,
} from '@shared/materials'
import {
  DEFAULT_ROOM_ACCESS,
  isRoomAccess,
  MATERIAL_NOT_FOUND,
  MAX_FOLDER_FILES,
  MAX_MATERIAL_NAME,
  MAX_MATERIALS,
  MAX_OUTLINE,
  MAX_OUTLINE_TEXT,
  MAX_PAGE_BYTES,
  PUBLICATION_NOT_FOUND,
  publicationAddress,
  roomAccessOf,
  slugOk,
  spillEncoding,
  studentTitle,
  suggestSlug,
  type AdminPage,
  type Course,
  type CourseItem,
  type FileChoice,
  type FolderEntry,
  type MaterialKind,
  type NotebookChoice,
  type OutlineEntry,
  type PickedFile,
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
import {
  courseOfPublication,
  courseOfSeminar,
  courseRows,
  materialRef,
} from '../routes/course-view.js'
import { instanceToday } from '../time-zone.js'
import { listFolder, listLevel, listTree, readBytes, statPath } from '../workspace.js'
import { bookPage, newBlobBag } from './build.js'
import { cellChecks, fileChecks, scrubCells, scrubText, type SpillReader } from './checks.js'
import { notebookWithOutputs, type BlobSource } from './notebook.js'
import {
  gcPageFiles,
  holdPageFiles,
  pageFileInfo,
  putPageFile,
  sha256,
  type PageFile,
} from './page-files.js'
import {
  dropMaterial,
  findPublication,
  formerSlugs,
  getPublication,
  listMaterials,
  missingFolderFiles,
  publicationOf,
  savePublicationSelection,
  setPublicationSlug,
  writePublication,
  type FolderFile,
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
  entries: readonly {
    path: string
    bytes: number
    kind?: MaterialKind
    files?: readonly { path: string; bytes: number }[] | null
  }[],
): number {
  let total = 22
  for (const entry of entries) {
    // A folder is its files, each at its room path.
    const parts = entry.kind === 'folder' ? (entry.files ?? []) : [entry]
    for (const part of parts) {
      const name = Buffer.byteLength(`${top}/${part.path}`)
      total += 30 + name + part.bytes + 46 + name
    }
  }
  return total
}

/**
 * The hash a folder row keeps: of its file list, paths and contents, so it
 * changes exactly when what the folder's ZIP would hold changes. page_files
 * never holds it, so a server that does not know folders finds no bytes
 * behind the row instead of the wrong ones.
 */
export function folderHash(files: readonly FolderFile[]): string {
  return sha256(Buffer.from(files.map((f) => `${f.path}\0${f.hash}\n`).join(''), 'utf8'))
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
  /** Those bytes already in the page-file store (a build puts them ahead, yielding). */
  file?: PageFile
}): StoredMaterial {
  const file =
    input.file ??
    putPageFile(
      input.body ?? Buffer.from(notebookWithOutputs(input.cells, input.blob), 'utf8'),
      downloadTypeOf(input.path),
    )
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
    materials: listMaterials(pub.id).map((m) => ({ ...materialRef(m), path: m.path })),
    zipBytes: pub.zipBytes,
    former: formerSlugs('publication', pub.id),
  }
}

/* ------------------------------------------------------------ the picker */

/** How much text the picker reads in all, for the checks and for who uses what. */
const TEXT_SCAN_BUDGET = 32 * 1024 * 1024
/**
 * Root files the picker offers. The room's tree had the same ceiling
 * (workspace.ts · listTree); past it a root is a dump, not a class.
 */
const MAX_ROOT_FILES = 2000

/**
 * The picker's view of a plotly figure on the room's shelf: the build reads
 * the same figure out of its blob bag, and the two must find the same names.
 */
function shelfReader(sessionId: string): SpillReader {
  return {
    shelf: (sha) => {
      const bytes = blobBytes(sessionId, sha)
      if (bytes === null || bytes > SCAN_TEXT_BYTES) return null
      return readBlob(sessionId, sha)?.toString('utf8') ?? null
    },
  }
}

/** A top-level folder of the room as the picker and the build see it. */
interface FolderShape {
  /** 'data', without the slash. */
  name: string
  /**
   * Every file inside except notebooks, in tree order, each with why the
   * rules keep it in the room (`null`: they send it) and `picked` as the
   * rules alone have it.
   */
  entries: FolderEntry[]
  /**
   * More files inside than a folder material holds: the listing stopped at
   * MAX_FOLDER_FILES + 1, so what is in it is not known, and it does not go
   * out at all.
   */
  truncated: boolean
}

/**
 * The room's files the way a page offers them: the ones at the root one by
 * one, and everything under a top-level folder as that folder. Notebooks are
 * in neither: they are offered by root, wherever they lie.
 *
 * Each folder is walked on its own (workspace.ts · listFolder), not taken
 * from the room's tree: the tree stops at two thousand rows for the whole
 * room, read breadth-first, and a `lib/` beside `data/` used them up before
 * `data/raw/` was read, so `data/` went out without it under a caption that
 * promises the code runs. Hidden files and `__pycache__` never appear, and a
 * symlink is never followed.
 *
 * `readers` are the texts of the notebooks going out and `textOf` reads a
 * room file: a `_` module that the package going out imports is sent with
 * it (shared/materials.ts · neededModules).
 */
function roomShape(
  sessionId: string,
  input: {
    roster: readonly string[]
    fileLimit: number
    readers: readonly string[]
    textOf: (path: string, bytes: number) => string | null
  },
): { root: FileEntry[]; folders: FolderShape[] } {
  const root: FileEntry[] = []
  const folders: FolderShape[] = []
  const notNotebook = (entry: FileEntry) => materialKind(entry.path) !== 'notebook'
  for (const top of listLevel(sessionId)) {
    if (!top.dir) {
      if (notNotebook(top) && root.length < MAX_ROOT_FILES) root.push(top)
      continue
    }
    const listed = listFolder(sessionId, top.path, MAX_FOLDER_FILES + 1, notNotebook)
    // Only notebooks in it (homework/hw.ipynb), or nothing: the notebooks are offered by root.
    if (listed.files.length === 0) continue
    const entries: FolderEntry[] = listed.files.map((file) => {
      const why = folderEntryWhy({
        path: file.path,
        bytes: file.size,
        roster: input.roster,
        fileLimit: input.fileLimit,
      })
      const kind = materialKind(file.path)
      return { path: file.path, kind, bytes: file.size, why, picked: why === null }
    })
    const sizes = new Map(entries.map((entry) => [entry.path, entry.bytes]))
    const textOf = (path: string) => input.textOf(path, sizes.get(path) ?? 0)
    for (const path of neededModules(entries, textOf, input.readers)) {
      const entry = entries.find((e) => e.path === path)!
      entry.why = null
      entry.picked = true
    }
    folders.push({ name: top.path, entries, truncated: listed.truncated })
  }
  return { root, folders }
}

/** The teacher's word on a picked folder's files (PickedFile), as sets. */
function choiceOf(file: Pick<PickedFile, 'include' | 'exclude'>): FolderChoice {
  return { include: new Set(file.include ?? []), exclude: new Set(file.exclude ?? []) }
}

/**
 * A pick saved before folders, which named the files inside one by one
 * ('data/train.csv'), read as the folder holding exactly those files: what
 * the teacher ticked goes (against the rules too, as they ticked it then),
 * and whatever they could have ticked and did not stays in the room. Read as
 * the whole folder, the next «Опубликовать» would send the holdout labels
 * they had kept back on purpose.
 */
function legacyChoice(entries: readonly FolderEntry[], old: ReadonlySet<string>): FolderChoice {
  return {
    include: new Set(entries.filter((e) => e.why !== null && old.has(e.path)).map((e) => e.path)),
    exclude: new Set(entries.filter((e) => e.why === null && !old.has(e.path)).map((e) => e.path)),
  }
}

/** A folder with its files ticked as the saved pick (or the rules) has them. */
interface FolderPick {
  shape: FolderShape
  /** 'data/'. */
  path: string
  /** The saved pick names the folder ('data/'), or files in it from before folders. */
  kept: boolean
  name: string | null
  /** The shape's entries, `picked` by the pick. */
  entries: FolderEntry[]
  /** The entries that go out, and their bytes. */
  out: FolderEntry[]
  bytes: number
  /** Whether it can go out as picked: listed whole, something in it, within the limits. */
  allowed: boolean
}

function folderPickOf(shape: FolderShape, selection: PublishSelection | null): FolderPick {
  const path = `${shape.name}/`
  const saved = selection?.files.find((f) => f.path === path) ?? null
  const old = saved
    ? null
    : new Set((selection?.files ?? []).map((f) => f.path).filter((p) => p.startsWith(path)))
  const choice = saved
    ? choiceOf(saved)
    : old && old.size > 0
      ? legacyChoice(shape.entries, old)
      : null
  const entries = shape.entries.map((entry) => ({ ...entry, picked: entryGoes(entry, choice) }))
  const out = entries.filter((entry) => entry.picked)
  const bytes = out.reduce((sum, entry) => sum + entry.bytes, 0)
  return {
    shape,
    path,
    kept: choice !== null,
    name: saved?.name || null,
    entries,
    out,
    bytes,
    allowed:
      !shape.truncated &&
      out.length > 0 &&
      out.length <= MAX_FOLDER_FILES &&
      bytes <= MAX_PAGE_BYTES,
  }
}

interface FolderFacts {
  usedBy: string[]
  inNotes: string[]
  files: number
  bytes: number
  holds: MaterialKind[]
  pick: DefaultPick
}

/**
 * Who uses a folder and whether it goes out by default (shared/materials.ts
 * · folderPick). A reader inside the folder does not count for it, unless it
 * is a notebook: `scripts/eda_tools.py` importing `scripts.case_cian` says
 * nothing about whether the page needs `scripts/`, while a notebook in
 * `lectures/` that reads `lectures/img/` does.
 */
function folderFacts(
  folder: FolderPick,
  readers: ReadonlyMap<string, string>,
  drawn: ReadonlyMap<string, ReadonlySet<string>>,
  roster: readonly string[],
): FolderFacts {
  const prefix = folder.path
  const paths = folder.entries.map((entry) => entry.path)
  const usedBy: string[] = []
  for (const [path, text] of readers) {
    if (path.startsWith(prefix) && materialKind(path) !== 'notebook') continue
    if (folderMentioned(folder.shape.name, paths, text)) usedBy.push(path)
  }
  const inNotes = new Set<string>()
  for (const path of paths) for (const book of drawn.get(path) ?? []) inNotes.add(book)
  const pick = folderPick({
    path: folder.shape.name,
    files: folder.shape.truncated ? MAX_FOLDER_FILES + 1 : folder.out.length,
    bytes: folder.bytes,
    usedBy,
    inNotes: [...inNotes],
    roster,
    pageLimit: MAX_PAGE_BYTES,
  })
  return {
    usedBy,
    inNotes: [...inNotes],
    files: folder.out.length,
    bytes: folder.bytes,
    holds: holdsOf(folder.out.map((entry) => entry.path)),
    pick,
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
  /*
   * The notebooks going out (ticked by the saved pick, or by default): only
   * they make a folder needed. solutions.ipynb reading grading/labels.csv,
   * or a student's notebook reading uploads/, must not tick a whole folder.
   */
  const outSources = new Map<string, string>()
  // Picture path → the notebooks whose notes draw it; `drawnOut` counts those going out.
  const drawn = new Map<string, Set<string>>()
  const drawnOut = new Map<string, Set<string>>()
  const addDrawn = (into: Map<string, Set<string>>, path: string, book: string) => {
    const by = into.get(path)
    if (by) by.add(book)
    else into.set(path, new Set([book]))
  }
  books.forEach((book, i) => {
    const picked = selection?.notebooks.find((n) => n.root === book.root) ?? null
    const name = picked?.name ?? names[i]
    const rule = rules[book.root]
    const owner = rule?.owner ? (rule.ownerName ?? rule.owner) : null
    const empty = isEmptyBook(book.cells)
    const fallback = notebookPick({ path: book.path, empty, owner, roster })
    const goes = selection ? picked !== null && !empty : fallback.picked
    notebooks.push({
      root: book.root,
      path: book.path,
      cells: book.cells.length,
      outputs: outputCount(book.cells),
      name,
      picked: goes,
      why: selection ? (picked !== null && !empty ? null : fallback.why) : fallback.why,
      owner,
      isNew: seen !== null && !seen.has(book.root),
    })
    const clean = scrubCells(lightCells(book.cells), sessionId)
    scrubbed += clean.scrubbed
    checks.push(...cellChecks({ root: book.root, name, cells: clean.cells }, roster, shelf))
    const text = book.cells.map((c) => c.source).join('\n')
    sources.set(book.path, text)
    if (goes) outSources.set(book.path, text)
    for (const cell of book.cells) {
      if (cell.type !== 'markdown') continue
      for (const ref of findWorkspaceImages(cell.source)) {
        addDrawn(drawn, ref.path, book.path)
        if (goes) addDrawn(drawnOut, ref.path, book.path)
      }
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

  // Texts read once: the checks and the question of who reads a folder share them.
  let budget = TEXT_SCAN_BUDGET
  const texts = new Map<string, string | null>()
  const textOf = (path: string, bytes: number): string | null => {
    const known = texts.get(path)
    if (known !== undefined) return known
    let text: string | null = null
    if (budget > 0 && scannable(path, bytes)) {
      const body = readBytes(sessionId, path, SCAN_TEXT_BYTES)
      if (body) {
        budget -= body.length
        text = body.toString('utf8')
      }
    }
    texts.set(path, text)
    return text
  }

  const files: FileChoice[] = []
  const shape = roomShape(sessionId, {
    roster,
    fileLimit,
    readers: [...outSources.values()],
    textOf,
  })
  // Who may make a folder needed: the notebooks going out, and the code going out with them.
  const readers = new Map(outSources)
  for (const entry of shape.root) {
    const kind = materialKind(entry.path)
    const usedBy = [...sources].filter(([, text]) => mentioned(entry.path, text)).map(([p]) => p)
    const fallback = filePick({
      path: entry.path,
      kind,
      bytes: entry.size,
      usedBy,
      inNotes: drawn.has(entry.path),
      roster,
      fileLimit,
    })
    const picked = selection?.files.find((f) => f.path === entry.path) ?? null
    const allowed = entry.size <= fileLimit
    const goes = selection ? picked !== null && allowed : fallback.picked
    files.push({
      path: entry.path,
      kind,
      bytes: entry.size,
      name: picked?.name ?? suggestNames([entry.path])[0],
      picked: goes,
      why: selection ? (picked !== null && allowed ? null : fallback.why) : fallback.why,
      usedBy,
      isNew: seen !== null && !seen.has(entry.path),
    })
    const text = textOf(entry.path, entry.size)
    if (text !== null) checks.push(...fileChecks(entry.path, text, sessionId, roster))
    if (kind === 'code' && goes && text !== null) readers.set(entry.path, text)
  }

  /*
   * A folder can be needed by code rather than by a notebook: scripts/
   * eda_tools.py reads data/, and the notebook only imports scripts. A folder
   * going out brings its code into the readers, so this repeats until
   * nothing more goes; each round adds at least one folder or ends. With a
   * saved pick, what goes is the pick, and the rounds only find who reads.
   */
  const folders = shape.folders.map((folder) => folderPickOf(folder, selection))
  const goesOut = (folder: FolderPick): boolean =>
    selection
      ? folder.kept && folder.allowed
      : folderFacts(folder, readers, drawnOut, roster).pick.picked
  const going = new Set<string>()
  for (let grew = true; grew; ) {
    grew = false
    for (const folder of folders) {
      if (going.has(folder.path) || !goesOut(folder)) continue
      going.add(folder.path)
      grew = true
      for (const entry of folder.out) {
        if (entry.kind !== 'code') continue
        const text = textOf(entry.path, entry.bytes)
        if (text !== null) readers.set(entry.path, text)
      }
    }
  }
  for (const folder of folders) {
    const facts = folderFacts(folder, readers, drawnOut, roster)
    const { path } = folder
    const picked = going.has(path)
    files.push({
      path,
      kind: 'folder',
      bytes: facts.bytes,
      name: folder.name ?? path,
      picked,
      why: picked ? null : facts.pick.why,
      usedBy: facts.usedBy,
      isNew:
        seen !== null && !seen.has(path) && !folder.entries.some((entry) => seen.has(entry.path)),
      files: facts.files,
      holds: facts.holds,
      entries: folder.entries,
      inNotes: facts.inNotes,
    })
    /*
     * Every file that could go out is checked, those the pick sends first
     * (the reading budget is shared): the teacher may tick a file the rules
     * keep in the room, and its finding has to be on screen before the
     * button, not after it. The panel asks only about what is ticked
     * (page-picker.ts · relevantChecks).
     */
    if (folder.shape.truncated) continue
    const order = [...folder.out, ...folder.entries.filter((entry) => !entry.picked)]
    for (const entry of order) {
      if (entry.why === 'too-large') continue
      const text = textOf(entry.path, entry.bytes)
      if (text === null) continue
      for (const check of fileChecks(entry.path, text, sessionId, roster)) {
        checks.push({ ...check, folder: path })
      }
    }
  }
  forgetImports()

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
    roomAccess: roomAccessOf(selection),
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
    roomAccess: roomAccessOf(pub.selection),
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
  } else if (selection && target.kind === 'folder') {
    // The folder ('data/'), and any file inside it a pick from before folders named on its own.
    const inside = (path: string) => {
      const clean = normalizePath(path) ?? path
      return clean === target.path || clean.startsWith(`${target.path}/`)
    }
    selection = { ...selection, files: selection.files.filter((f) => !inside(f.path)) }
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
  /** Root files, and folders ('data/') with the teacher's word on single files inside. */
  files: PickedFile[]
  autoRefresh: boolean
  ack: string[]
  /** Pages outside a course only; ignored for a seated room. */
  heldOn?: string | null
  /** Absent keeps the saved setting (or DEFAULT_ROOM_ACCESS on a first publish). */
  roomAccess?: RoomAccess
}

/**
 * Why a picked file or folder did not go out. A folder is refused whole:
 * 'missing' when it is gone or nothing in it may go out, 'budget' when it
 * would not fit on the page, 'too-many' over MAX_FOLDER_FILES (or more files
 * inside than can be listed). Half a dataset folder is worse than none: the
 * notebook fails on the missing half.
 */
export type RefusedReason = 'missing' | 'too-large' | 'budget' | 'too-many'

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
  // A folder lists at most MAX_FOLDER_FILES + 1 files, so neither list can be longer.
  const paths = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((p): p is string => typeof p === 'string').slice(0, MAX_FOLDER_FILES + 1)
      : []
  const files = list(raw.files)
    .filter((f) => typeof f?.path === 'string')
    .map((f): PickedFile => {
      const include = paths(f.include)
      const exclude = paths(f.exclude)
      return {
        path: f.path as string,
        name: name(f.name),
        ...(include.length > 0 ? { include } : {}),
        ...(exclude.length > 0 ? { exclude } : {}),
      }
    })
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
  // No default filled in here: absent must stay absent, or a publish that does not mention the
  // door would reset a page saved with 'members' or 'none'. build() fills DEFAULT_ROOM_ACCESS.
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
 * the class's process. (The page-file GC does not rely on the queue: a build
 * holds the files it has put until its commit, page-files.ts ·
 * holdPageFiles.)
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
    const was = roomAccessOf(pub.selection)
    // A pick from before the door holds no choice: write the teacher's down even when it equals
    // the default, so it stays theirs if the default ever moves.
    if (was !== access || pub.selection.roomAccess === undefined) {
      savePublicationSelection(pub.id, { ...pub.selection, roomAccess: access })
    }
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
  if (request.notebooks.length + request.files.length === 0) {
    return bad(tr('server.publish.nothing'))
  }
  const named: { path: string; name: string }[] = []
  const folders: { path: string; name: string; include: Set<string>; exclude: Set<string> }[] = []
  for (const file of request.files) {
    const path = normalizePath(file.path)
    if (!path) return bad(tr('server.publish.badPath', { path: file.path }))
    if (file.path.endsWith('/')) {
      // A material is a top-level folder; anything deeper goes out inside one.
      if (path.includes('/')) return bad(tr('server.publish.badPath', { path: file.path }))
      if (folders.some((f) => f.path === path)) continue
      const inside = (list: readonly string[] | undefined) =>
        new Set(
          (list ?? [])
            .map((p) => normalizePath(p))
            .filter((p): p is string => p !== null && p.startsWith(`${path}/`)),
        )
      folders.push({
        path,
        name: file.name,
        include: inside(file.include),
        exclude: inside(file.exclude),
      })
      continue
    }
    // A notebook goes out as a notebook, by its root: as a "file" it would be
    // a tab with no cells, sharing a path with the real one.
    if (materialKind(path) === 'notebook') continue
    if (!named.some((f) => f.path === path)) named.push({ path, name: file.name })
  }
  /*
   * A file inside a picked folder goes out with the folder, once (a pick
   * saved before folders named such files one by one), and goes even where
   * the rules would keep it: it was named.
   */
  const files = named.filter((f) => {
    const folder = folders.find((d) => f.path.startsWith(`${d.path}/`))
    if (!folder) return true
    folder.include.add(f.path)
    folder.exclude.delete(f.path)
    return false
  })
  const total = request.notebooks.length + files.length + folders.length
  if (total > MAX_MATERIALS) return bad(tr('server.publish.tooMany', { n: MAX_MATERIALS }))

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

  /*
   * The folders, re-read from the room on every build. A picked folder is a
   * folder, not the list of files it had when it was ticked: a refresh (the
   * end of class, «Обновить страницу») takes what is in it now, so the
   * dataset the teacher dropped into data/ during the class goes out. But a
   * file that arrived that way passes everything a file passes: the rules
   * that leave a file inside in the room (folderEntryWhy: «_», answers, a
   * student's name, run output, a key's name, what the checks cannot read,
   * the upload limit), and the checks for keys, names and the room address;
   * a finding in it nobody confirmed holds the refresh exactly like a new
   * one in a cell. Files the teacher decided about keep the decision
   * (PickedFile · include, exclude).
   */
  const readText = (path: string, bytes: number): string | null =>
    scannable(path, bytes)
      ? (readBytes(sessionId, path, SCAN_TEXT_BYTES)?.toString('utf8') ?? null)
      : null
  const shape =
    folders.length > 0
      ? roomShape(sessionId, {
          roster,
          fileLimit,
          readers: notebooks.map((book) => book.cells.map((cell) => cell.source).join('\n')),
          textOf: readText,
        })
      : null
  const readFolders: { path: string; name: string; files: { path: string; body: Buffer }[] }[] = []
  for (const folder of folders) {
    await pause()
    const label = `${folder.path}/`
    const found = shape?.folders.find((f) => f.name === folder.path)
    if (!found) {
      refused.push({ path: label, reason: 'missing' })
      continue
    }
    // Listed only up to the ceiling: what else is in it is not known, so none of it goes.
    if (found.truncated) {
      refused.push({ path: label, reason: 'too-many' })
      continue
    }
    const out = found.entries.filter((entry) => entryGoes(entry, folder))
    if (out.length === 0) {
      refused.push({ path: label, reason: 'missing' })
      continue
    }
    if (out.length > MAX_FOLDER_FILES) {
      refused.push({ path: label, reason: 'too-many' })
      continue
    }
    const planned = out.reduce((sum, entry) => sum + entry.bytes, 0)
    if (pageBytes + planned > MAX_PAGE_BYTES) {
      refused.push({ path: label, reason: 'budget' })
      continue
    }
    const bodies: { path: string; body: Buffer }[] = []
    let bytes = 0
    for (const entry of out) {
      await pause()
      // Gone since the folder was read, or grown past the upload limit: not in the folder any more.
      const body = readBytes(sessionId, entry.path, fileLimit)
      if (!body) continue
      bytes += body.length
      bodies.push({ path: entry.path, body })
    }
    if (bodies.length === 0) {
      refused.push({ path: label, reason: 'missing' })
      continue
    }
    if (pageBytes + bytes > MAX_PAGE_BYTES) {
      refused.push({ path: label, reason: 'budget' })
      continue
    }
    pageBytes += bytes
    readFolders.push({ path: folder.path, name: folder.name || label, files: bodies })
    for (const { path, body } of bodies) {
      if (!scannable(path, body.length)) continue
      for (const check of fileChecks(path, body.toString('utf8'), sessionId, roster)) {
        checks.push({ ...check, folder: label })
      }
    }
  }
  if (notebooks.length + read.length + readFolders.length === 0) {
    return bad(tr('server.publish.nothing'))
  }

  const acked = new Set(request.ack)
  const open = checks.filter((check) => !acked.has(check.id))
  if (open.length > 0) return { ok: false, status: 409, error: 'unconfirmed', checks: open }

  // Page order: notebooks as picked, then files by kind (PDFs, data, code, the rest), then folders.
  read.sort(
    (a, b) =>
      materialRank({ kind: materialKind(a.path), name: a.name, path: a.path }) -
      materialRank({ kind: materialKind(b.path), name: b.name, path: b.path }),
  )

  /*
   * The bytes go into the page-file store first, yielding between files: a
   * folder is up to a thousand files, each written with an fsync, and on a
   * cloud disk that is seconds the class's process would otherwise spend
   * deaf to every room (y-websocket drops a socket silent for 30 s). The
   * hold keeps the GC off them until the commit references them.
   */
  const hold = holdPageFiles()
  let committed = false
  try {
    const notebookFiles: PageFile[] = []
    for (const [i, body] of ipynbs.entries()) {
      await pause()
      notebookFiles.push(hold.put(body, downloadTypeOf(notebooks[i].path)))
    }
    const readFiles: PageFile[] = []
    for (const file of read) {
      await pause()
      readFiles.push(hold.put(file.body, downloadTypeOf(file.path)))
    }
    const folderFiles: FolderFile[][] = []
    for (const folder of readFolders) {
      const list: FolderFile[] = []
      for (const { path, body } of folder.files) {
        await pause()
        const stored = hold.put(body, downloadTypeOf(path))
        list.push({ path, hash: stored.hash, bytes: stored.bytes })
      }
      folderFiles.push(list)
    }

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
      files: [
        ...files.map((f) => ({
          path: f.path,
          name: read.find((r) => r.path === f.path)?.name ?? f.name,
        })),
        ...folders.map((f) => pickedFolder(f, shape, readFolders)),
      ],
      autoRefresh: request.autoRefresh,
      ack: [...acked].filter((id) => checks.some((c) => c.id === id)),
      // A refresh is not the teacher looking at the picker: what was new stays new.
      seen: (options.lenient ? existing?.selection?.seen : undefined) ?? [
        ...roots,
        ...listTree(sessionId).files.map((e) =>
          e.dir ? (e.path.includes('/') ? null : `${e.path}/`) : e.path,
        ).filter((path): path is string => path !== null),
      ],
      // Who the page leads into the room survives every rebuild until the teacher changes it.
      roomAccess: request.roomAccess ?? existing?.selection?.roomAccess ?? DEFAULT_ROOM_ACCESS,
    }

    /*
     * From here to the commit nothing yields: the materials are assembled
     * from the files already put and written in one transaction.
     */
    const taken = new Set<string>()
    const materials: StoredMaterial[] = []
    notebooks.forEach((book, i) => {
      const key = materialKey(book.path, 'notebook', taken)
      taken.add(key)
      const { name, path, cells } = book
      materials.push(notebookMaterial({ key, name, path, cells, blob, file: notebookFiles[i] }))
    })
    read.forEach((file, i) => {
      const kind = materialKind(file.path)
      const key = materialKey(file.path, kind, taken)
      taken.add(key)
      const stored = readFiles[i]
      materials.push({
        key,
        kind,
        name: file.name,
        path: file.path,
        hash: stored.hash,
        bytes: stored.bytes,
      })
    })
    readFolders.forEach((folder, i) => {
      const key = materialKey(`${folder.path}/`, 'folder', taken)
      taken.add(key)
      const files = folderFiles[i]
      materials.push({
        key,
        kind: 'folder',
        name: folder.name,
        path: folder.path,
        hash: folderHash(files),
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        files,
      })
    })
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
    committed = true
    // The first publish from a course with an address gets '<course>-<nn>', if free.
    if (defaultSlug && slugOk(defaultSlug)) setPublicationSlug(publication.id, defaultSlug)
    const fresh = publicationOf(sessionId) ?? publication
    return { ok: true, publication: fresh, page: adminPageOf(fresh), refused }
  } finally {
    hold.release()
    // A build that gave up after putting its files leaves them to nobody: the GC takes them now.
    if (!committed) gcPageFiles()
  }
}

/**
 * A picked folder as the saved pick keeps it: its path with a slash, its
 * name, and the teacher's word on single files, minus files that are no
 * longer in it (a folder refused as gone keeps the lists as they came).
 */
function pickedFolder(
  folder: { path: string; name: string; include: Set<string>; exclude: Set<string> },
  shape: { folders: FolderShape[] } | null,
  read: readonly { path: string; name: string }[],
): PickedFile {
  const found = shape?.folders.find((f) => f.name === folder.path)
  const known = found ? new Set(found.entries.map((entry) => entry.path)) : null
  const keep = (set: ReadonlySet<string>) =>
    [...set].filter((path) => known === null || known.has(path)).sort()
  const include = keep(folder.include)
  const exclude = keep(folder.exclude)
  return {
    path: `${folder.path}/`,
    name: read.find((r) => r.path === folder.path)?.name ?? folder.name,
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  }
}

/* ---------------------------------------------------------------- repair */

/**
 * At startup: folder files whose bytes are gone from the page-file store.
 *
 * A release before folders sweeps page files at startup by
 * publication_materials alone, so a server rolled back to it deletes every
 * file only a folder referenced, and brought forward again its pages list
 * «data/ · 15 файлов» behind a 404 and a class ZIP short of them without a
 * word. A file the room still has with the same bytes is put back. A folder
 * missing anything else is taken off its page; the saved pick still names
 * it, so the next refresh or «Опубликовать» brings it back from the room.
 */
export function repairFolderFiles(): {
  restored: number
  dropped: { pub: string; key: string }[]
} {
  let restored = 0
  const broken = new Map<string, Set<string>>()
  for (const row of missingFolderFiles()) {
    // Put back a moment ago for another page or folder that holds the same bytes.
    if (pageFileInfo(row.hash)) continue
    const pub = getPublication(row.pub)
    if (!pub) continue
    const room = pub.sessionId !== null && getSession(pub.sessionId) ? pub.sessionId : null
    const body = room ? readBytes(room, row.path, MAX_PAGE_BYTES) : null
    if (body && sha256(body) === row.hash) {
      putPageFile(body, downloadTypeOf(row.path))
      restored++
      continue
    }
    const keys = broken.get(row.pub)
    if (keys) keys.add(row.key)
    else broken.set(row.pub, new Set([row.key]))
  }
  const dropped: { pub: string; key: string }[] = []
  for (const [id, keys] of broken) {
    const pub = getPublication(id)
    if (!pub) continue
    let rest = listMaterials(id)
    for (const key of keys) {
      rest = rest.filter((m) => m.key !== key)
      const change = { selection: pub.selection, zipBytes: zipBytesFor(zipTop(pub), rest) }
      if (dropMaterial(id, key, change)) dropped.push({ pub: id, key })
    }
  }
  return { restored, dropped }
}
