/** Explicit UI translations. User content and protocol values never pass through this layer. */
import type { Locale, MessageCatalog, MessageText, TranslationParams } from './i18n-types.js'
import { commonMessages } from './locales/common.js'
import { adminMessages } from './locales/admin.js'
import { roomMessages } from './locales/room.js'
import { serverMessages } from './locales/server.js'
export type { Locale, MessageCatalog, MessageText, TranslationParams } from './i18n-types.js'
export const DEFAULT_LOCALE: Locale = 'ru'
export function isLocale(value: unknown): value is Locale {
  return value === 'ru' || value === 'en'
}
export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE
}
export const messages: MessageCatalog = {}
for (const catalog of [commonMessages, adminMessages, roomMessages, serverMessages]) {
  for (const [key, value] of Object.entries(catalog)) {
    if (Object.hasOwn(messages, key)) {
      if (JSON.stringify(messages[key]) !== JSON.stringify(value))
        throw new Error(`Conflicting translation key: ${key}`)
      continue
    }
    Object.defineProperty(messages, key, { value, enumerable: true, configurable: false })
  }
}
let localeResolver: () => unknown = () => DEFAULT_LOCALE
/** The browser supplies a reactive getter; the server supplies its persisted instance setting. */
export function setLocaleResolver(resolver: () => unknown): void {
  localeResolver = resolver
}
export function getLocale(): Locale {
  return normalizeLocale(localeResolver())
}
const rules = { ru: new Intl.PluralRules('ru'), en: new Intl.PluralRules('en') }
export function hasTranslation(key: string): boolean {
  return Object.hasOwn(messages, key)
}
export function translate(locale: Locale, key: string, params: TranslationParams = {}): string {
  const pair = Object.hasOwn(messages, key) ? messages[key] : undefined
  if (!pair) return key
  const value = pair[locale]
  const text =
    typeof value === 'string'
      ? value
      : (value[rules[locale].select(Number(params.count ?? 0))] ?? value.other)
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  )
}
export function tr(key: string, params?: TranslationParams): string {
  return translate(getLocale(), key, params)
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(), options).format(value)
}
export function formatDate(
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(getLocale(), options).format(date)
    : '—'
}
export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options: Intl.RelativeTimeFormatOptions = { numeric: 'auto' },
): string {
  return new Intl.RelativeTimeFormat(getLocale(), options).format(value, unit)
}
