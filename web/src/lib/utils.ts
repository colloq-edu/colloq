import clsx, { type ClassValue } from 'clsx'

export const cn = (...parts: ClassValue[]) => clsx(parts)

/**
 * The reader has asked for less movement.
 *
 * index.css can only gate what CSS owns, and the two largest movements in the
 * product are not CSS: Svelte drives `transition:fly` through element.animate()
 * and the run bar's hold fill is a WAAPI call of our own. No media query
 * reaches either, so the preference has to be read here and honoured at the
 * call site — read per animation rather than cached, because a reader may turn
 * it on halfway through a seminar.
 *
 * Reduced is a reduction, not a blackout: callers give up travel and keep the
 * fade, the colour and the clock.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

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

/*
 * Ink for a coloured disc — an avatar, a chip — chosen by measuring rather than
 * assumed to be white.
 *
 * A participant's colour is fixed and theme-independent (it is also their cursor
 * in the editor), so the ink on it has to be theme-independent too. White
 * initials on the lime and amber of the palette measured 2.08:1, which is not
 * readable by anyone; picking whichever of the two inks actually contrasts
 * better puts every colour in the palette over 4.5:1 without touching the
 * colours themselves.
 */
const DISC_DARK = '#0F2246'
const DISC_LIGHT = '#FFFFFF'

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0
  const n = parseInt(m[1], 16)
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  )
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05]
  return x > y ? x / y : y / x
}

/** Whichever ink reads better on this ground. */
export function inkOn(background: string): string {
  return contrastRatio(DISC_DARK, background) >= contrastRatio(DISC_LIGHT, background)
    ? DISC_DARK
    : DISC_LIGHT
}

export function relativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts)
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString()
}

/** Meta on macOS, Ctrl elsewhere — used for shortcut hints in the UI. */
const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
export const modKey = isMac ? '⌘' : 'Ctrl'

/**
 * Split a filename so a narrow lane can drop the middle and keep the end.
 *
 * `text-overflow: ellipsis` always eats the tail, and the tail of a filename is
 * the part that says what it is: a Files panel 280px wide showed
 * `cifar10-validation` and `семинар 7 — заметк`, with no ellipsis and no
 * extension, so two rows that were an .npz and an .md read as the same kind of
 * thing. Rendered as two spans — a shrinking stem and a fixed tail — the
 * browser does the measuring and the extension is always on screen.
 *
 * Only a plausible extension is held back. A name that merely contains a dot
 * ("Prof. Ivanov notes") would otherwise reserve half the lane for a word.
 */
export function splitFileName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  // A leading dot is a dotfile, not an extension, and a trailing one is a typo.
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' }
  const ext = name.slice(dot)
  if (ext.length > 9 || /[\s/\\]/.test(ext)) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext }
}

/* ------------------------------------------------------------- durations */

/**
 * Две длительности, два формата — и это правило, а не недосмотр.
 *
 * Живая цифра держит колонку и обновляется пять раз в секунду: у неё десятая
 * доля секунды (по ней и видно, работает ячейка или висит) и ведущий ноль в
 * секундах, иначе ряд дёргается на каждом переходе через десяток. Законченная
 * читается один раз в предложении: ни десятых, ни ведущих нулей — «1m 20s», а
 * не «1m 20.0s».
 *
 * Обе жили по своим компонентам — `elapsed` в терминале, `spell` в треде
 * оракула, — и третья появилась бы копированием в ту же неделю, когда
 * секундомер понадобился ячейке. Здесь их две, и других не будет.
 */

/** Живая длительность: «0.0s», «12.3s», «1m 04s», «2h 23m». */
export function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, now - since) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
  }
  /*
   * Часовой разряд — новый.
   *
   * Формат писали для строк терминала, которые заканчиваются. Ячейка, которая
   * учит модель, не заканчивается: без этого разряда она печатала «143m 07s»,
   * а это число никто не читает как два часа двадцать три минуты.
   */
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`
}

/** Законченная длительность: «4s», «1m 20s», «2h 23m». Пусто, если её нет. */
export function spell(ms: number | null): string {
  if (ms === null) return ''
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`
}

/**
 * Ниже этого законченную длительность не показывают.
 *
 * Под две секунды «thought for 1s» — это строка мебели, сообщающая, что
 * компьютер справился быстро, и к концу пары таких строк сорок. Живой цифры
 * это не касается: она живёт ровно столько, сколько идёт выполнение, и потом
 * исчезает.
 */
export const NOTICED_MS = 2_000


/* ------------------------------------------------- образы окружений */

/**
 * Размер образа и когда он собран — теми же словами в панели и в форме.
 *
 * Обе жили в Environments.svelte, а форма создания семинара стала показывать
 * то же самое. Третья копия появилась бы в ту же неделю — так уже было с
 * длительностями выше.
 */
export function imageSize(bytes: number | null): string {
  if (bytes === null) return '—'
  const gb = bytes / 1e9
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

/** «built 3 days ago», «built 4h ago», «built just now», «never built». */
export function builtAgo(ts: number | null, now = Date.now()): string {
  if (ts === null) return 'never built'
  const days = Math.floor((now - ts) / 86_400_000)
  if (days > 1) return `built ${days} days ago`
  const hours = Math.floor((now - ts) / 3_600_000)
  if (hours >= 1) return `built ${hours}h ago`
  return 'built just now'
}
