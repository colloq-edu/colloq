/**
 * The council page quotes the product (docs/pages/{ru,en}/council.html ·
 * «Регламент» and «Консилиум на машинах»): the console's words — its rules,
 * its pool strip, its cards — and the server's sentences. A word renamed in
 * shared/locales and left on the page reads, a class later, as a button that
 * is not there, so every quote is held to the catalog here: each «…» (ru) or
 * “…” (en) is a value of it, its placeholders any text, or one of the few
 * lines the console composes of such values, built below from them.
 *
 * Words, not deeds: what the console draws is pinned by
 * tests/classes-ui-council.test.mts and the council suites; nobody builds or
 * type-checks the pages.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { messages, translate, type Locale } from '../shared/i18n.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const page = (locale: Locale): string => fs.readFileSync(path.join(root, 'docs/pages', locale, 'council.html'), 'utf8')

/** The sections whose quotes are the product's. */
const SECTIONS = ['rules', 'machines']
const MARKS: Record<Locale, [string, string]> = { ru: ['«', '»'], en: ['“', '”'] }

/** A section's text: from its heading to the next, markup out. */
function sectionText(html: string, id: string): string {
  const at = html.indexOf(`<h2 id="${id}"`)
  assert.notEqual(at, -1, `the council page has no #${id}`)
  const end = html.indexOf('<h2', at + 1)
  return html.slice(at, end < 0 ? undefined : end)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** The outermost quotes of a text: «Пул не поднялся: «…»» is one quote, its inner one part of it. */
function quotesOf(text: string, [open, close]: [string, string]): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === open) {
      if (depth === 0) start = i + 1
      depth++
    } else if (text[i] === close && depth > 0) {
      depth--
      if (depth === 0) out.push(text.slice(start, i))
    }
  }
  return out
}

/** The same apostrophe and spaces whichever a writer typed. */
const plain = (text: string): string => text.replace(/[’']/g, "'").replace(/\s+/g, ' ').trim()

/** Every value of the catalog in one language, plural forms each. */
function values(locale: Locale): string[] {
  const out: string[] = []
  for (const pair of Object.values(messages)) {
    const value = (pair as Record<string, unknown>)[locale]
    if (typeof value === 'string') out.push(plain(value))
    else if (value && typeof value === 'object') for (const form of Object.values(value as Record<string, string>)) out.push(plain(form))
  }
  return out
}

/** A value as a pattern of the whole quote: its placeholders any text. Mostly placeholders, it would match anything: none. */
function pattern(value: string): RegExp | null {
  const parts = value.split(/\{[^}]+\}/g)
  if (parts.length === 1 || parts.join('').trim().length < 6) return null
  return new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`)
}

/** Lines the console composes of several values: built from the catalog, never typed. */
function composed(locale: Locale): string[] {
  const t = (key: string, params?: Record<string, string | number>) => plain(translate(locale, key, params))
  const sec30 = t('room.pult.v2.rules.sec', { count: 30 })
  return [
    // The rules sentence of a cell (PultHeader): «Запускаю только я · каждый запуск до 30 с · на экране с именами».
    [
      `${t('room.pult.v2.rules.runLeadTeacher')} ${t('room.pult.v2.rules.runTeacher')}`,
      `${t('room.pult.v2.rules.limitLead')} ${t('room.pult.v2.rules.limitValue', { duration: sec30 })}`,
      `${t('room.pult.v2.rules.screenLead')} ${t('room.pult.v2.rules.screenNames')}`,
    ].join(' · '),
    // A left name with its reason, as the «Не переносится» line says one (council-pult.ts · poolLeftLine).
    `model (${t('server.itsModuleIsOnlyInTheNotebook.49d81a')})`,
    // A card's files with one chip (council-footnote.ts · attemptFiles): the label, a name and its size.
    `${t('room.council.pool.files')} out.csv ${t('room.ui.1184', { p0: '12' })}`,
  ]
}

function matches(quote: string, catalog: string[], patterns: RegExp[], made: string[]): boolean {
  const q = plain(quote)
  if (made.includes(q)) return true
  // «Запуск через …», «Остановлено: запуск шёл дольше …»: the start of a value, the rest of it left out.
  if (q.endsWith('…') && q.length >= 7) return catalog.some((value) => value.startsWith(q.slice(0, -1).trimEnd()))
  return catalog.some((value) => value === q || value.replace(/[.…]$/, '') === q || (q.length >= 12 && value.includes(q)))
    || patterns.some((one) => one.test(q))
}

for (const locale of ['ru', 'en'] as const) {
  test(`every quote of the council page's rules and machines sections is the product's own words (${locale})`, () => {
    const html = page(locale)
    const catalog = values(locale)
    const patterns = catalog.map(pattern).filter((one): one is RegExp => one !== null)
    const made = composed(locale)
    const quotes = SECTIONS.flatMap((id) => quotesOf(sectionText(html, id), MARKS[locale]))
    assert.ok(quotes.length >= 30, `only ${quotes.length} quotes found: the sections moved?`)
    const strangers = quotes.filter((quote) => quote.trim().length >= 3 && !matches(quote, catalog, patterns, made))
    assert.deepEqual(strangers, [], `quotes that are no word of shared/locales (${locale})`)
  })
}

test('the quotes of the pool\'s words F6 added are on the page in both languages', () => {
  // The console's newer words, quoted where the page describes them: renamed in the catalog, they fail above; dropped from the page, here.
  for (const [locale, keys] of [
    ['ru', ['room.pult.pool.recycled', 'room.council.pool.coming', 'server.theNewStateCouldNotBeTaken.01b6b1', 'server.theOrderOfSetsInAttemptsMay.b87dc7']],
    ['en', ['room.pult.pool.recycled', 'room.council.pool.coming', 'server.theNewStateCouldNotBeTaken.01b6b1', 'server.theOrderOfSetsInAttemptsMay.b87dc7']],
  ] as const) {
    const text = plain(sectionText(page(locale), 'machines'))
    for (const key of keys) {
      const value = plain(translate(locale, key, { time: '14:05' }))
      assert.ok(text.includes(value), `${locale}: «${value}» (${key}) is not on the page`)
    }
  }
})
