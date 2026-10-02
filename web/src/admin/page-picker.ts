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
import { formatNumber, tr } from '@shared/i18n'
import {
  PICK_DATA_BYTES,
  PICK_TEXT_BYTES,
  type FileChoice,
  type MaterialKind,
  type NotebookChoice,
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
  const say = (text: string) => ({ text, positive: false })
  switch (file.why) {
    case 'too-large': {
      const over = file.bytes > fileLimit
      const ceiling = over
        ? fileLimit
        : file.kind === 'code' || file.kind === 'text'
          ? PICK_TEXT_BYTES
          : PICK_DATA_BYTES
      return say(tr('admin.page.why.tooLarge', { size: sizeText(ceiling) }))
    }
    case 'private':
      return say(tr('admin.page.why.private'))
    case 'answers':
      return say(tr('admin.page.why.answers'))
    case 'roster':
      return say(tr('admin.page.why.roster'))
    case 'generated':
      return say(tr('admin.page.why.generated'))
    case 'image':
      return say(tr('admin.page.why.image'))
    case 'unused':
      return say(tr('admin.page.why.unused'))
    case 'empty':
      return say(tr('admin.page.why.empty'))
    default:
      return file.usedBy.length > 0
        ? { text: tr('admin.page.usedIn', { paths: file.usedBy.join(', ') }), positive: true }
        : null
  }
}

/** Whether a row can be ticked at all: an empty notebook and a file over the upload limit cannot. */
export function lockedNotebook(book: NotebookChoice): boolean {
  return book.why === 'empty'
}

export function lockedFile(file: FileChoice, fileLimit: number): boolean {
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
 * «Проверил(а)» without reading.
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
