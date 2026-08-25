import clsx, { type ClassValue } from 'clsx'

export const cn = (...parts: ClassValue[]) => clsx(parts)

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  const mb = bytes / (1024 * 1024)
  // A decimal is worth a column of its own only while it still says something:
  // past 10 MB the tenth is noise, and dropping it is what keeps the size lane
  // one width down the whole file list.
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function relativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts)
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString()
}

/** Meta on macOS, Ctrl elsewhere — used for shortcut hints in the UI. */
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
export const modKey = isMac ? '⌘' : 'Ctrl'
