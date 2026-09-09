import { isLocale, normalizeLocale, setLocaleResolver, tr, type Locale } from '@shared/i18n'
const CACHE_KEY = 'colloq:instance-language'
function cachedLanguage(): Locale | null {
  try {
    const value = localStorage.getItem(CACHE_KEY)
    return isLocale(value) ? value : null
  } catch {
    return null
  }
}
const cached = typeof window === 'undefined' ? null : cachedLanguage()
export const language = $state<{ current: Locale }>({ current: cached ?? 'ru' })
if (typeof window !== 'undefined') setLocaleResolver(() => language.current)
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
      const response = await fetch('/api/instance', {
        cache: 'no-store',
        signal: AbortSignal.timeout(1500),
      })
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
export async function initializeLanguage(): Promise<void> {
  if (typeof window === 'undefined') return
  document.documentElement.lang = normalizeLocale(language.current)
  if (!stopSync) {
    const onStorage = (event: StorageEvent) => {
      if (event.key === CACHE_KEY && isLocale(event.newValue)) setLanguage(event.newValue)
    }
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refreshLanguage()
    }
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', onFocus)
    const timer = window.setInterval(() => void refreshLanguage(), 30_000)
    stopSync = () => {
      window.clearInterval(timer)
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onFocus)
      stopSync = null
    }
  }
  const initial = refreshLanguage()
  // Cached/offline rooms can paint immediately. A first visit resolves the server
  // language before components and their default metadata are constructed.
  if (!cached) await initial
}
export function stopLanguageSync(): void {
  stopSync?.()
}
