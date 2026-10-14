/**
 * The translations of a machine's agent: none. What dist/runner.js loads
 * wherever the code it bundles imports shared/i18n.ts
 * (docs/architecture/remote-runners.md §13, note 9).
 *
 * WHY. shared/i18n.ts registers every catalogue of the UI when it loads, some
 * 1.6 MB of strings, and the execution core the agent runs reaches it through
 * `tr` (competitions/docker-runner.ts, secure-files.ts, and
 * shared/competitions.ts, dependencies.ts and publish.ts under them). In the
 * bundle those strings would be part of the machine's build, the sha256 of
 * dist/runner.js that home compares with its own before it hands out work
 * (shared/remote-runner.ts · remoteCompatible, the owner's decision 5): an
 * edit of any button's label would make every machine «устарела» after a
 * release that changed nothing a run depends on (§8.4). And the texts a
 * machine made would be in its own language, Russian by default, whatever
 * home's is.
 *
 * SO A TEXT LEAVES A MACHINE AS A KEY. `tr(key, params)` here is
 * remoteTextMarker(key, params): the key and its params between two invisible
 * characters, inside whatever text the core builds around them. Home renders
 * each marker in its own language with remoteRenderTexts when it takes in
 * what the machine sent, so the participant reads the same sentence a run at
 * home would have given them, and the teacher the same log line. What a
 * machine shows on its own (its stderr) keeps the markers: the key reads well
 * enough there, and the operator's words are home's panel.
 *
 * HOW IT GETS HERE. Nothing imports this module by name. The runner's build
 * (server/scripts/build-runner.mjs · withoutTranslations) resolves every
 * import of shared/i18n.ts to it, `@shared/i18n` from server/src and
 * './i18n.js' from shared/ alike, and fails the build if anything still
 * reaches shared/i18n.ts or a file under shared/locales/
 * (tests/runner-import-graph.test.mts holds the bundle to it, and its sha256
 * to one UI edit). Everything else, home included, keeps the real
 * dictionaries; so does an agent started from the sources (make runner-dev
 * without DIST=1), whose texts arrive as words and pass home's renderer as
 * they are.
 *
 * THE SAME EXPORTS AS shared/i18n-runtime.ts, which shared/i18n.ts re-exports,
 * with the same signatures: a module of the core that imports a name the
 * runtime has and this one lacks would stop the runner's build, and one whose
 * signature differed would type-check against the runtime and misbehave only
 * on a machine. tsc compares the two (the type below), the import-graph test
 * compares their names. Each does what a machine with no dictionary can:
 * - tr and translate give the marker, whatever the locale;
 * - hasTranslation knows no key, and registerMessages and setLocaleResolver
 *   keep nothing: no catalogue or language has a place here;
 * - isLocale, normalizeLocale and DEFAULT_LOCALE are the runtime's, getLocale
 *   answers what the runtime answers with no resolver set, and `messages`
 *   stays empty;
 * - the formatters work without catalogues (below).
 */
import { remoteTextMarker } from '@shared/remote-runner'
import type { Locale, MessageCatalog, TranslationParams } from '@shared/i18n-types'
import type * as runtime from '@shared/i18n-runtime'
import type { PartialCatalog } from '@shared/i18n-runtime'
import type * as shim from './i18n-shim.js'

export type { Locale, MessageCatalog, MessageText, TranslationParams } from '@shared/i18n-types'
export type { PartialCatalog } from '@shared/i18n-runtime'

/**
 * Every value this module exports against the runtime's, signature for
 * signature, in both directions: tsc (npm run typecheck) fails here when the
 * runtime gains, loses or changes an export and this module does not follow.
 * A type only, so nothing of it reaches the bundle.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Holds<T extends true> = T
export type ShimMatchesRuntime = Holds<Same<typeof shim, typeof runtime>>

export const DEFAULT_LOCALE: Locale = 'ru'

export function isLocale(value: unknown): value is Locale {
  return value === 'ru' || value === 'en'
}

export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE
}

/** Empty, and never filled: registerMessages keeps nothing. */
export const messages: MessageCatalog = {}

/** Kept by nothing: a catalogue in the bundle is what this module is for keeping out. */
export function registerMessages(..._catalogs: PartialCatalog[]): void {}

/** Kept by nothing: the language a text is read in is home's, chosen when home renders it. */
export function setLocaleResolver(_resolver: () => unknown): void {}

/**
 * The runtime's answer with no resolver set. Nothing on a machine should draw
 * a text by language: a text goes through `tr`, and home picks the language.
 */
export function getLocale(): Locale {
  return DEFAULT_LOCALE
}

/** No key is known here: every one is home's to render. */
export function hasTranslation(_key: string): boolean {
  return false
}

/** The marker home renders in its own language; the locale asked for is not the machine's to choose. */
export function translate(_locale: Locale, key: string, params: TranslationParams = {}): string {
  return remoteTextMarker(key, params)
}

/** The marker home renders in its own language (shared/remote-runner.ts · remoteTextMarker). */
export function tr(key: string, params?: TranslationParams): string {
  return remoteTextMarker(key, params)
}

/*
 * THE FORMATTERS carry no translations, only Intl, in one locale whatever
 * home's: what they make reaches home already formatted, inside a param,
 * where home's own translate puts it as it is. English, with no grouping
 * unless asked for: a grouping comma is a decimal comma to a Russian reader
 * ("1,234 МБ" reads as a little over one), while a point and plain digits read
 * one way in both languages. In the core only formatNumber is reached at all
 * (shared/dependencies.ts, the sizes of a package set, which only home's
 * preparation words), and a machine that needs a date or a duration in a text
 * should pass the number as a param rather than a phrase. Cached as the
 * runtime caches them: the first Intl in a process wakes ICU.
 */
const MACHINE_LOCALE = 'en'
const formatters = new Map<string, unknown>()

function cachedFormat<T>(kind: string, options: unknown, make: () => T): T {
  const key = `${kind} ${JSON.stringify(options ?? null)}`
  const known = formatters.get(key)
  if (known !== undefined) return known as T
  const made = make()
  formatters.set(key, made)
  return made
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return cachedFormat('number', options, () => new Intl.NumberFormat(MACHINE_LOCALE, { useGrouping: false, ...options })).format(value)
}

export function formatDate(
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return cachedFormat('date', options, () => new Intl.DateTimeFormat(MACHINE_LOCALE, options)).format(date)
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options: Intl.RelativeTimeFormatOptions = { numeric: 'auto' },
): string {
  return cachedFormat('relative', options, () => new Intl.RelativeTimeFormat(MACHINE_LOCALE, options)).format(value, unit)
}
