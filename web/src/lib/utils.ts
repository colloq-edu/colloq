import { tr, getLocale, formatNumber } from '@shared/i18n'
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
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return tr('room.bytes', { count: formatNumber(bytes) })
  if (bytes < 1024 * 1024) return tr('room.ui.1184', { p0: formatNumber(bytes / 1024, { minimumFractionDigits: bytes < 10240 ? 1 : 0, maximumFractionDigits: bytes < 10240 ? 1 : 0 }) })
  const mb = bytes / (1024 * 1024)
  // A decimal is worth a column of its own only while it still says something:
  // past 10 MB the tenth is noise, and dropping it is what keeps the size lane
  // one width down the whole file list.
  return tr('room.ui.1185', { p0: formatNumber(mb, { minimumFractionDigits: mb < 10 ? 1 : 0, maximumFractionDigits: mb < 10 ? 1 : 0 }) })
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
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
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
  if (delta < 60_000) return tr('room.ui.1186')
  if (delta < 3_600_000) return tr('room.ui.1187', { p0: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return tr('room.ui.1188', { p0: Math.floor(delta / 3_600_000) })
  return new Date(ts).toLocaleDateString(getLocale())
}

/** Meta on macOS, Ctrl elsewhere — used for shortcut hints in the UI. */
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
export const modKey = isMac ? '⌘' : 'Ctrl'

/**
 * Whether this is the modifier used in code to go to a definition.
 *
 * ⌘ on a Mac, Ctrl everywhere else — as in any IDE and in the browser itself,
 * where the same pair opens a link in a new tab. Splitting by platform here is
 * not pedantry but a trade-off: the OTHER modifier stays with picking cells
 * one by one (Notebook.svelte · pick), so on a Mac Ctrl+click on code still
 * collects cells instead of jumping. It also sidesteps the Mac's second
 * trouble: Ctrl+click there also opens the context menu.
 */
export function isJumpClick(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

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
 * Two durations, two formats — and that is a rule, not an oversight.
 *
 * The live figure holds a column and updates five times a second: it has
 * tenths of a second (they are what shows whether a cell is working or
 * hanging) and a leading zero in the seconds, otherwise the row jitters at
 * every step past a multiple of ten. The finished one is read once, inside a
 * sentence: no tenths, no leading zeros — "1m 20s", not "1m 20.0s".
 *
 * Both used to live in their own components — `elapsed` in the terminal,
 * `spell` in the Oracle thread — and a third would have appeared by copying
 * in the very week a cell needed a stopwatch. Here there are two, and there
 * will be no others.
 */

/** Live duration: "0.0s", "12.3s", "1m 04s", "2h 23m". */
export function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, now - since) / 1000
  if (seconds < 60) return tr('room.ui.1190', { p0: formatNumber(seconds, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
  if (seconds < 3600) {
    return tr('room.ui.1191', { p0: Math.floor(seconds / 60), p1: String(Math.floor(seconds % 60)).padStart(2, '0') })
  }
  /*
   * The hours place is new.
   *
   * The format was written for terminal lines, which finish. A cell that
   * trains a model does not finish: without this place it printed "143m 07s",
   * and nobody reads that number as two hours twenty-three minutes.
   */
  return tr('room.ui.1192', { p0: Math.floor(seconds / 3600), p1: String(Math.floor((seconds % 3600) / 60)).padStart(2, '0') })
}

/** Finished duration: "4s", "1m 20s", "2h 23m". Empty if there is none. */
export function spell(ms: number | null): string {
  if (ms === null) return ''
  const total = Math.round(ms / 1000)
  if (total < 60) return tr('room.duration.seconds', { count: total })
  if (total < 3600) return tr('room.ui.1193', { p0: Math.floor(total / 60), p1: total % 60 })
  return tr('room.ui.1194', { p0: Math.floor(total / 3600), p1: Math.floor((total % 3600) / 60) })
}

/**
 * Below this a finished duration is not shown.
 *
 * Under two seconds, "thought for 1s" is a line of furniture announcing that
 * the computer coped quickly, and by the end of a class there are forty such
 * lines. The live figure is not affected: it lives exactly as long as the run
 * lasts, and then disappears.
 */
export const NOTICED_MS = 2_000

/* -------------------------------------------------------- cell output */

/**
 * A carriage return collapses the line instead of piling it up.
 *
 * tqdm and pip redraw one line with `\r`. Without collapsing, a cell shows two
 * hundred copies of the progress bar, the output climbs over the threshold
 * and hides under "Show more" — whereas in Jupyter the same cell shows one
 * line. What remains is the last frame of each line: the same thing the `\r`
 * handling in kernel/terminal.ts and `collapseCarriage` in the terminal panel
 * do.
 *
 * Collapsing here is about display. The frames still travel over the network
 * and still use up the cell's output cap; only the server can remove them at
 * the source.
 */
export function collapseCarriage(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      let last = ''
      for (const frame of line.split('\r')) if (frame !== '') last = frame
      return last
    })
    .join('\n')
}

/* ----------------------------------------------- environment images */

/**
 * Image size and when it was built — in the same words in the panel and in
 * the form.
 *
 * Both lived in Environments.svelte, and then the seminar creation form began
 * showing the same thing. A third copy would have appeared in the same week —
 * that already happened with the durations above.
 */
export function imageSize(bytes: number | null): string {
  if (bytes === null) return '—'
  const gb = bytes / 1e9
  return gb >= 1 ? tr('room.ui.1195', { p0: formatNumber(gb, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : tr('room.ui.1196', { p0: Math.round(bytes / 1e6) })
}

/** "built 3 days ago", "built 4h ago", "built just now", "never built". */
export function builtAgo(ts: number | null, now = Date.now()): string {
  if (ts === null) return tr('room.ui.1197')
  const days = Math.floor((now - ts) / 86_400_000)
  if (days > 1) return tr('room.ui.1198', { p0: days })
  const hours = Math.floor((now - ts) / 3_600_000)
  if (hours >= 1) return tr('room.ui.1199', { p0: hours })
  return tr('room.ui.1200')
}
