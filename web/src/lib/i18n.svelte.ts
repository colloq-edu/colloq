import { isLocale, normalizeLocale, setLocaleResolver, tr, type Locale } from '@shared/i18n'
import { readRoomRoute } from './routes'
const CACHE_KEY = 'colloq:instance-language'
/** How often to ask the server for the language where nobody would report a change. */
const REFRESH_EVERY = 5 * 60_000
function cachedLanguage(): Locale | null {
  try {
    const value = localStorage.getItem(CACHE_KEY)
    return isLocale(value) ? value : null
  } catch {
    return null
  }
}
const cached = typeof window === 'undefined' ? null : cachedLanguage()
const suppliedValue = typeof document === 'undefined'
  ? null : document.querySelector?.('meta[name="colloq-language"]')?.getAttribute('content')
const supplied = isLocale(suppliedValue) ? suppliedValue : null
export const language = $state<{ current: Locale }>({ current: supplied ?? cached ?? 'ru' })
/*
 * A counter of arrived dictionaries, and it is reactive too.
 *
 * A screen dictionary carries ONE language (lib/screen-language.ts), so the
 * text on screen changes not only when the language is switched but also when
 * the new language's dictionary arrives. The resolver reads the counter along
 * with the language — so every `tr()` in the markup depends on it too, and
 * `messagesChanged()` redraws exactly what is said in words, without touching
 * a single piece of room state.
 */
const revision = $state<{ n: number }>({ n: 0 })
if (typeof window !== 'undefined') setLocaleResolver(() => {
  revision.n
  return language.current
})
/** The dictionary has grown — redraw everything that is translated. */
export function messagesChanged(): void {
  revision.n++
}
let generation = 0
const listeners = new Set<() => void>()
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function setLanguage(value: Locale): void {
  if (!isLocale(value)) return
  generation++
  const changed = language.current !== value
  language.current = value
  if (typeof document !== 'undefined') document.documentElement.lang = value
  try {
    localStorage.setItem(CACHE_KEY, value)
  } catch {
    /* storage is optional */
  }
  if (changed) for (const listener of listeners) listener()
}
let reading: Promise<void> | null = null
async function refreshLanguage(strict = false): Promise<void> {
  if (reading) return strict ? reading : reading.catch(() => undefined)
  const started = generation
  const attempt = (async () => {
    try {
      // No `no-store`: the response is small and has an ETag, so let the server's
      // headers decide its fate, not a tab that asks once every five minutes.
      const response = await fetch('/api/instance', { signal: AbortSignal.timeout(1500) })
      if (!response.ok) throw new Error(tr('common.languageReadFailed'))
      const state: unknown = await response.json()
      // A newer socket/storage update wins over this response, even when the
      // request was the confirmation for an owner write.
      if (started !== generation) return
      if (
        !state ||
        typeof state !== 'object' ||
        !('language' in state) ||
        !isLocale(state.language)
      ) throw new Error(tr('common.languageReadFailed'))
      setLanguage(state.language)
    } catch (cause) {
      // Background synchronization remains usable offline. Owner writes need
      // visible confirmation unless a newer authoritative update already won.
      if (strict && started === generation) throw cause
    }
  })().finally(() => {
    if (reading === attempt) reading = null
  })
  reading = attempt
  return attempt
}
/** Confirm an owner write with a read started after any older read settles. */
export async function revalidateLanguage(): Promise<void> {
  while (reading) {
    try { await reading } catch { /* this call makes its own fresh request */ }
  }
  await refreshLanguage(true)
}
let stopSync: (() => void) | null = null
let refreshedAt = 0
export async function initializeLanguage(): Promise<void> {
  if (typeof window === 'undefined') return
  document.documentElement.lang = normalizeLocale(language.current)
  /*
   * In a room the control socket brings the language (`instance:language`, see
   * lib/session.svelte.ts), and it needs no polling at all. It never did:
   * thirty students each kept up a request every thirty seconds for the whole
   * class — thousands of requests per class for a setting that changes once a
   * year.
   *
   * The other screens — the panel, the reader — hold no socket; they keep the
   * same polling, but once every five minutes, plus a return to the tab with
   * the same threshold.
   */
  const inRoom = typeof location !== 'undefined' && readRoomRoute(location.pathname) !== null
  if (!stopSync) {
    const onStorage = (event: StorageEvent) => {
      if (event.key === CACHE_KEY && isLocale(event.newValue)) setLanguage(event.newValue)
    }
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - refreshedAt < REFRESH_EVERY) return
      refreshedAt = Date.now()
      void refreshLanguage()
    }
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', onFocus)
    const timer = inRoom ? 0 : window.setInterval(() => {
      refreshedAt = Date.now()
      void refreshLanguage()
    }, REFRESH_EVERY)
    stopSync = () => {
      if (timer) window.clearInterval(timer)
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onFocus)
      stopSync = null
    }
  }
  // Navigation HTML already carries the authoritative language on a cold visit,
  // so the boot request is the fallback for older/static servers, not the rule.
  if (supplied) return
  refreshedAt = Date.now()
  const initial = refreshLanguage()
  if (!cached) await initial
}
export function stopLanguageSync(): void {
  stopSync?.()
}
