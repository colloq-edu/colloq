import { tr, formatNumber, getLocale } from '@shared/i18n'
/**
 * Where a material leads, and how the reader words its size and kind.
 *
 * One copy for the course page and the class page: a notebook opens as a tab
 * of its page, a PDF in the browser's own viewer, anything else downloads (a
 * folder as one ZIP with the folder inside).
 * Two copies of that rule would drift on the first new kind, and a PDF that
 * downloads on one page and opens on the other reads as a bug.
 */
import { extOf } from '@shared/paths'
import type { MaterialKind } from '@shared/publish'

interface Linkable {
  key: string
  kind: MaterialKind
}

/** A plain left click: everything else (a new tab, a copied link) belongs to the browser. */
export function plainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}

export function pageHref(address: string, key?: string | null): string {
  return key ? `/p/${address}/${key}` : `/p/${address}`
}

export function downloadHref(address: string, key: string): string {
  return `/api/p/${address}/m/${key}/download`
}

export function zipHref(address: string): string {
  return `/api/p/${address}/zip`
}

/** The address a material's name leads to. */
export function materialHref(address: string, m: Linkable): string {
  if (m.kind === 'notebook') return pageHref(address, m.key)
  if (m.kind === 'pdf') return `/api/p/${address}/m/${m.key}/open`
  return downloadHref(address, m.key)
}

/**
 * «2,4 МБ»: the room's size words (room.bytes, room.ui.1184/1185), which
 * the reader's dictionary carries. A tenth only below 10, where it still
 * says something.
 */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return tr('room.bytes', { count: formatNumber(bytes) })
  const kb = bytes / 1024
  if (kb < 1024) {
    const digits = kb < 10 ? 1 : 0
    return tr('room.ui.1184', {
      p0: formatNumber(kb, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    })
  }
  const mb = kb / 1024
  const digits = mb < 10 ? 1 : 0
  return tr('room.ui.1185', {
    p0: formatNumber(mb, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
  })
}

/**
 * «15 файлов · 25 МБ»: a folder material counted. The count is left out when
 * the server sent none; the size is every file that went out in it.
 */
export function folderCount(m: { files?: number; bytes: number }): string {
  const files = m.files === undefined ? null : tr('room.page.files', { count: m.files })
  return [files, sizeText(m.bytes)].filter(Boolean).join(' · ')
}

/** «CSV», «PY»: the extension of a path or a name, upper case; '' when there is none. */
export function extLabel(pathOrName: string): string {
  return extOf(pathOrName).toUpperCase()
}

/**
 * The caption under the class ZIP: what the archive holds, in words
 * («Тетради с результатами и слайды»), and the folders by name, in page
 * order, because those are the paths the code opens and the promise is that
 * it finds them after unzipping.
 *
 * The sentence starts with a capital only when it starts with a word: a page
 * of folders alone reads «data/ и scripts/ — по тем же путям…», since
 * «Data/» is a folder no case-sensitive disk has.
 */
export function zipNote(materials: readonly { kind: MaterialKind; name: string }[]): string {
  const kinds = new Set(materials.map((m) => m.kind))
  const words: string[] = []
  if (kinds.has('notebook')) words.push(tr('room.page.zipWhat.notebooks'))
  if (kinds.has('pdf')) words.push(tr('room.page.zipWhat.slides'))
  if (kinds.has('data')) words.push(tr('room.page.zipWhat.data'))
  if (kinds.has('code')) words.push(tr('room.page.zipWhat.code'))
  if (kinds.has('text') || kinds.has('image') || kinds.has('file')) {
    words.push(tr('room.page.zipWhat.files'))
  }
  const startsWithWord = words.length > 0
  const folders = materials.filter((m) => m.kind === 'folder')
  for (const m of folders) words.push(m.name)
  const list = new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(words)
  const what = startsWithWord ? list.charAt(0).toUpperCase() + list.slice(1) : list
  return tr(folders.length > 0 ? 'room.page.zipNoteFolders' : 'room.page.zipNote', { what })
}
