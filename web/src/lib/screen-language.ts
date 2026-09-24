import type { Locale } from '@shared/i18n-types'

/**
 * Which part of the product is speaking — and so which dictionary it needs.
 *
 * The dictionary used to be one for everyone and carried both languages at
 * once: 351 KB of source (74 KB over the wire) before ANY screen, of which a
 * quarter belongs to the room. Now the area and the language are chosen here,
 * and each area's contents are listed as imports in
 * lib/messages/<area>-<language>.ts — the build plugin, which cuts the catalogs
 * down to one language, reads them from there too.
 */
/**
 * `competitions` is the fourth area, and it was set up because the three
 * earlier ones do not fit it: `/k/**` is neither the room, nor the teacher
 * panel, nor the reader. All it shares with them is `common` and the trimmed
 * server catalog.
 */
export type MessageArea = 'room' | 'admin' | 'reader' | 'competitions'

/*
 * Listed by hand and in full, because the bundler cannot parse
 * `import('./messages/' + name)`: it either drags the whole directory into the
 * build or finds nothing. Eight lines are the price of Rollup seeing exactly
 * eight chunks and naming them predictably (firstPaint looks at these names).
 */
const MODULES: Record<string, () => Promise<unknown>> = {
  'room-ru': () => import('./messages/room-ru'),
  'room-en': () => import('./messages/room-en'),
  'admin-ru': () => import('./messages/admin-ru'),
  'admin-en': () => import('./messages/admin-en'),
  'reader-ru': () => import('./messages/reader-ru'),
  'reader-en': () => import('./messages/reader-en'),
  'competitions-ru': () => import('./messages/competitions-ru'),
  'competitions-en': () => import('./messages/competitions-en'),
}

const loading = new Map<string, Promise<unknown>>()
const shown = new Set<MessageArea>()

/** One area's dictionary in one language — once per tab. */
export function loadAreaMessages(area: MessageArea, locale: Locale): Promise<unknown> {
  shown.add(area)
  const name = `${area}-${locale}`
  const known = loading.get(name)
  if (known) return known
  const started = MODULES[name]().catch((cause: unknown) => {
    // A failure is not cached: "Reload the page" at the bottom of the screen
    // must work.
    if (loading.get(name) === started) loading.delete(name)
    throw cause
  })
  loading.set(name, started)
  return started
}

/** Catalog registration precedes module evaluation, including top-level tr(). */
export async function loadLocalizedScreen<T>(
  screen: () => Promise<T>,
  area: MessageArea,
  locale: Locale,
  messages: (area: MessageArea, locale: Locale) => Promise<unknown> = loadAreaMessages,
): Promise<T> {
  await messages(area, locale)
  return screen()
}

/**
 * The language was switched — deliver its dictionary to the screens already
 * open.
 *
 * Until then `translate` returns the previous language, not a bare key: seeing
 * the old caption for half a second is better than `room.ui.862` in the middle
 * of a form.
 */
export async function reloadAreaMessages(locale: Locale): Promise<void> {
  await Promise.all([...shown].map((area) => loadAreaMessages(area, locale)))
}
