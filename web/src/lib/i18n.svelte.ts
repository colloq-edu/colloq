import { isLocale, normalizeLocale, setLocaleResolver, tr, type Locale } from '@shared/i18n'
import { readRoomRoute } from './routes'
const CACHE_KEY = 'colloq:instance-language'
/** Как часто спрашивать язык у сервера там, где о смене некому рассказать. */
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
 * Счётчик приехавших словарей, и он тоже реактивный.
 *
 * Экранный словарь везёт ОДИН язык (lib/screen-language.ts), поэтому текст на
 * экране меняется не только когда сменили язык, но и когда доехал словарь
 * нового языка. Разрешитель читает счётчик вместе с языком — значит, любое
 * `tr()` в разметке зависит и от него, и `messagesChanged()` перерисовывает
 * ровно то, что сказано словами, не трогая ни одного состояния комнаты.
 */
const revision = $state<{ n: number }>({ n: 0 })
if (typeof window !== 'undefined') setLocaleResolver(() => {
  revision.n
  return language.current
})
/** Словарь пополнился — перерисовать всё, что переведено. */
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
      // Без `no-store`: ответ маленький и с ETag, и пусть его судьбу решают
      // заголовки сервера, а не вкладка, которая спрашивает раз в пять минут.
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
   * В комнате язык приносит управляющий сокет (`instance:language`, см.
   * lib/session.svelte.ts), и опрос ей не нужен вовсе. Он и был не нужен:
   * тридцать студентов держали по запросу каждые тридцать секунд всё занятие
   * — тысячи запросов за пару ради настройки, которую меняют раз в год.
   *
   * Остальные экраны — панель, читалка — сокета не держат; им остаётся тот же
   * опрос, но раз в пять минут, и возврат во вкладку с тем же порогом.
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
