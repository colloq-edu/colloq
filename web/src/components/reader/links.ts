import { tr, formatNumber } from '@shared/i18n'
/**
 * Where a material leads, and how the reader words its size and kind.
 *
 * One copy for the course page and the class page: a notebook opens as a tab
 * of its page, a PDF in the browser's own viewer, anything else downloads.
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

/** «CSV», «PY»: the extension of a path or a name, upper case; '' when there is none. */
export function extLabel(pathOrName: string): string {
  return extOf(pathOrName).toUpperCase()
}
