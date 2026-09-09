import type { Locale } from '@shared/i18n-types'
const listeners = new Set<(locale: Locale) => void>()
export function onInstanceLanguage(listener: (locale: Locale) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function announceInstanceLanguage(locale: Locale): void {
  for (const listener of listeners) listener(locale)
}
