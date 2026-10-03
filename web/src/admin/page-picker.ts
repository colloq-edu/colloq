/**
 * «Страница занятия»: the words and sums the picker shows, apart from the
 * screen.
 *
 * Every unticked row says why it is unticked. The reasons are the server's
 * decisions (shared/materials.ts · notebookPick, filePick), and a row left
 * unticked without one reads as a bug: the teacher ticks the student's
 * notebook back on because nothing said whose it was. Kept here, like
 * panel.ts, so the wording is tested without a DOM.
 */
import { formatNumber, getLocale, tr } from '@shared/i18n'
import { folderLabel } from '@shared/materials'
import {
  MAX_FOLDER_FILES,
  PICK_DATA_BYTES,
  PICK_TEXT_BYTES,
  type FileChoice,
  type FolderEntry,
  type MaterialKind,
  type NotebookChoice,
  type PickedFile,
  type PickReason,
  type PublishCheck,
} from '@shared/publish'

/** «460 КБ», «5,1 МБ», «200 МБ»: one decimal while it still says something. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return tr('admin.page.bytes', { p0: formatNumber(bytes) })
  if (bytes < 1024 * 1024) return tr('admin.page.kb', { p0: formatNumber(Math.round(bytes / 1024)) })
  const mb = bytes / (1024 * 1024)
  const digits = mb < 100 && Math.round(mb * 10) % 10 !== 0 ? 1 : 0
  return tr('admin.page.mb', {
    p0: formatNumber(mb, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
  })
}

/** Why a notebook is not ticked, in the row's own words; `null` for a ticked one. */
export function notebookReason(book: NotebookChoice): string | null {
  if (book.picked || !book.why) return null
  switch (book.why) {
    case 'student':
      return book.owner
        ? tr('admin.page.why.student', { name: book.owner })
        : tr('admin.page.why.studentBare')
    case 'roster':
      return tr('admin.page.why.roster')
    case 'private':
      return tr('admin.page.why.private')
    case 'answers':
      return tr('admin.page.why.answers')
    case 'empty':
      return tr('admin.page.why.empty')
    default:
      return null
  }
}

/**
 * Why a file is or is not ticked.
 *
 * A ticked data file says where it is used: «используется в seminar.ipynb»
 * is the reason it went in by itself, and the teacher checks that line, not
 * the file. 'too-large' has two sizes behind it: above the upload limit the
 * row is locked; between the default threshold and that limit it is only
 * unticked, and the threshold is what the line names.
 */
export function fileReason(
  file: FileChoice,
  fileLimit: number,
): { text: string; positive: boolean } | null {
  if (file.picked) {
    return file.usedBy.length > 0
      ? { text: tr('admin.page.usedIn', { paths: file.usedBy.join(', ') }), positive: true }
      : null
  }
  if (file.why === 'too-large') {
    const over = file.bytes > fileLimit
    const ceiling = over
      ? fileLimit
      : file.kind === 'code' || file.kind === 'text'
        ? PICK_TEXT_BYTES
        : PICK_DATA_BYTES
    return { text: tr('admin.page.why.tooLarge', { size: sizeText(ceiling) }), positive: false }
  }
  const text = whyText(file.why)
  if (text) return { text, positive: false }
  return file.usedBy.length > 0
    ? { text: tr('admin.page.usedIn', { paths: file.usedBy.join(', ') }), positive: true }
    : null
}

/** The words of a reason every row shares, or `null` for one that needs the row's numbers. */
function whyText(why: PickReason | null): string | null {
  switch (why) {
    case 'private':
      return tr('admin.page.why.private')
    case 'answers':
      return tr('admin.page.why.answers')
    case 'roster':
      return tr('admin.page.why.roster')
    case 'generated':
      return tr('admin.page.why.generated')
    case 'image':
      return tr('admin.page.why.image')
    case 'unused':
      return tr('admin.page.why.unused')
    case 'empty':
      return tr('admin.page.why.empty')
    case 'secret':
      return tr('admin.page.why.secret')
    case 'unchecked':
      return tr('admin.page.why.unchecked')
    default:
      return null
  }
}

/* ---------------------------------------------------------------- folders */

/** «lecture.ipynb и scripts/eda_tools.py»: the paths as a sentence lists them. */
function pathList(paths: readonly string[]): string {
  return new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(paths)
}

/**
 * «15 файлов · 25 МБ»: what goes out in a folder.
 *
 * Counted from its files as they are ticked on screen («состав папки»), so
 * unticking a file changes the line; without them, as the server counted.
 * A folder nothing in it would go out of (`_drafts/`, `outputs/`, one whose
 * files all stay in the room) counts what is inside instead: «0 файлов ·
 * 0 Б» beside a folder with a file in it reads as a bug, and the reason
 * under the line already says that none of it goes.
 */
export function folderMeta(
  folder: Pick<FileChoice, 'files' | 'bytes'>,
  entries: readonly Pick<FolderEntry, 'bytes' | 'picked'>[] = [],
): string {
  const going = entries.filter((entry) => entry.picked)
  const sum = (list: readonly Pick<FolderEntry, 'bytes'>[]) =>
    list.reduce((total, entry) => total + entry.bytes, 0)
  let count = folder.files ?? 0
  let bytes = folder.bytes
  if (going.length > 0) {
    count = going.length
    bytes = sum(going)
  } else if (entries.length > 0) {
    count = entries.length
    bytes = sum(entries)
  }
  return `${tr('admin.count.file', { count })} · ${sizeText(bytes)}`
}

/** What a ticked file or folder adds to the page: a folder, the files in it ticked on screen. */
export function pickedBytes(file: Pick<FileChoice, 'kind' | 'bytes' | 'entries'>): number {
  if (file.kind !== 'folder' || !file.entries?.length) return file.bytes
  return file.entries.reduce((sum, entry) => sum + (entry.picked ? entry.bytes : 0), 0)
}

/**
 * Every path that goes out with the pick on screen: the ticked root files,
 * and inside each ticked folder the files ticked in «состав папки». The
 * checks are asked about these and nothing else (relevantChecks).
 */
export function goingPaths(files: readonly FileChoice[]): Set<string> {
  const out = new Set<string>()
  for (const file of files) {
    if (!file.picked) continue
    if (file.kind !== 'folder') out.add(file.path)
    else for (const entry of file.entries ?? []) if (entry.picked) out.add(entry.path)
  }
  return out
}

/**
 * A ticked folder as «Опубликовать» sends it: 'data/', with the files the
 * teacher ticked against the rules (`include`) and unticked against them
 * (`exclude`). Files nobody touched follow the rules at every refresh, so a
 * dataset dropped into data/ during the class still goes out.
 */
export function folderRequest(folder: FileChoice, name: string): PickedFile {
  const entries = folder.entries ?? []
  const include = entries.filter((e) => e.picked && e.why !== null).map((e) => e.path)
  const exclude = entries.filter((e) => !e.picked && e.why === null).map((e) => e.path)
  return {
    path: folder.path,
    name,
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  }
}

/**
 * Why a folder is or is not ticked.
 *
 * The positive line names how the folder is used, because that is what the
 * teacher checks before a dataset folder goes public: pictures the notes
 * draw (the archive is opened offline, so they have to travel with it), a
 * package the code imports, data the code reads. Who uses it comes from the
 * server (FileChoice · usedBy, inNotes), notebooks and code going out alike:
 * `data/` is «читается в scripts/eda_tools.py» even when the notebook only
 * imports `scripts`. 'too-large' for a folder is the page budget, not the
 * per-file limit: a folder is many files, and each one inside is held to
 * that limit on its own (entryReason).
 */
export function folderReason(
  folder: FileChoice,
  pageLimit: number,
): { text: string; positive: boolean } | null {
  if (folder.picked || folder.why === null) {
    const notes = folder.inNotes ?? []
    if (notes.length > 0) return { text: tr('admin.page.folder.pictures'), positive: true }
    if (folder.usedBy.length === 0) return null
    const paths = pathList(folder.usedBy)
    const label = folderLabel(folder.holds ?? [])
    const key =
      label === 'code'
        ? 'admin.page.folder.importedIn'
        : label === 'data'
          ? 'admin.page.folder.readIn'
          : 'admin.page.usedIn'
    return { text: tr(key, { paths }), positive: true }
  }
  const say = (text: string) => ({ text, positive: false })
  if (folder.why === 'too-many') {
    return say(tr('admin.page.why.tooMany', { count: MAX_FOLDER_FILES }))
  }
  if (folder.why === 'too-large') {
    return say(tr('admin.page.why.tooLarge', { size: sizeText(pageLimit) }))
  }
  // Files inside, all of them staying in the room: «пустая» would contradict the list under it.
  if (folder.why === 'empty' && (folder.entries?.length ?? 0) > 0) {
    return say(tr('admin.page.why.folderNothing'))
  }
  const text = whyText(folder.why)
  return text ? say(text) : null
}

/** A file's path inside its folder: «raw/train.csv» under «data/». */
export function entryPath(
  folder: Pick<FileChoice, 'path'>,
  entry: Pick<FolderEntry, 'path'>,
): string {
  return entry.path.startsWith(folder.path) ? entry.path.slice(folder.path.length) : entry.path
}

/**
 * Why the rules keep a file inside a folder in the room, or `null` when they
 * send it. Said whether or not the teacher ticked it anyway: a ticked
 * `_utils.py` still reads «имя начинается с «_»», which is what they
 * decided against.
 */
export function entryReason(entry: FolderEntry, fileLimit: number): string | null {
  if (entry.why === null) return null
  if (entry.why === 'too-large') return tr('admin.page.why.tooLarge', { size: sizeText(fileLimit) })
  return whyText(entry.why)
}

/** A file in a folder over the upload limit cannot be ticked: the build does not read past it. */
export function lockedEntry(entry: Pick<FolderEntry, 'why'>): boolean {
  return entry.why === 'too-large'
}

/** Whether a row can be ticked at all: an empty notebook and a file over the upload limit cannot. */
export function lockedNotebook(book: NotebookChoice): boolean {
  return book.why === 'empty'
}

export function lockedFile(file: FileChoice, fileLimit: number): boolean {
  /*
   * A folder's bytes are many files together: only the per-file limit
   * applies inside it. It can be ticked while a file in it is: one whose
   * files all stay in the room by the rules opens with nothing ticked, and
   * ticking a file in «состав папки» ticks the folder.
   */
  if (file.kind === 'folder') {
    if (file.why === 'too-many') return true
    const entries = file.entries ?? []
    return entries.length > 0 ? !entries.some((entry) => entry.picked) : file.why === 'empty'
  }
  return file.bytes > fileLimit
}

/** «PDF», «Данные», «HTML»: what a file is, by the kind the server gave it. */
export function kindText(kind: MaterialKind, path: string): string {
  if (kind === 'file') {
    const ext = /\.([A-Za-z0-9]{1,8})$/.exec(path)?.[1]
    return ext ? ext.toUpperCase() : tr('admin.page.kind.file')
  }
  return tr(`admin.page.kind.${kind}`)
}

/** «54 ячейки · 40 с результатами». */
export function notebookMeta(book: Pick<NotebookChoice, 'cells' | 'outputs'>): string {
  const cells = tr('admin.count.cell', { count: book.cells })
  return book.outputs > 0
    ? `${cells} · ${tr('admin.page.withOutputs', { count: book.outputs })}`
    : cells
}

/**
 * The checks that matter for this pick: only findings in what is ticked.
 *
 * A key in a notebook the teacher left out is not going anywhere, and a
 * warning about it next to the button would teach people to tick
 * «Проверил(а)» without reading. `paths` are the files going out
 * (goingPaths): root files, and the files ticked inside ticked folders, so
 * a key in `data/_raw.csv` is asked about only once the teacher ticks it.
 */
export function relevantChecks(
  checks: readonly PublishCheck[],
  roots: ReadonlySet<string>,
  paths: ReadonlySet<string>,
): PublishCheck[] {
  return checks.filter(
    (check) =>
      (check.root !== null && roots.has(check.root)) ||
      (check.root === null && check.path !== null && paths.has(check.path)),
  )
}

/**
 * Whether the button may build the page: something is ticked, the page
 * holds that many materials, and every finding in the pick is confirmed.
 */
export function publishBlocked(input: {
  picked: number
  limit: number
  unconfirmed: number
}): 'nothing' | 'too-many' | 'unconfirmed' | null {
  if (input.picked === 0) return 'nothing'
  if (input.picked > input.limit) return 'too-many'
  if (input.unconfirmed > 0) return 'unconfirmed'
  return null
}

/** One warning line of «ПРОВЕРКА», without its sample (drawn apart, in mono). */
export function checkText(check: PublishCheck): string {
  if (check.kind === 'secret') return tr('admin.page.check.secret', { where: check.where })
  if (check.kind === 'name') return tr('admin.page.check.name', { where: check.where })
  return tr('admin.page.check.roomId', { path: check.path ?? check.where })
}
