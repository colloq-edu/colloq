/**
 * The lectures guide (docs/pages/<lang>/lectures.html) against the console
 * it describes: the names it gives are the names on the screen, and the
 * magnifier is drawn the way the console's input model allows.
 *
 * Two drifts reached the guide with console v4. The English page called a
 * highlighter "light blue" and a paper "Lines", while the chips say
 * "Highlighter, blue" and "Lined": a teacher, or a screen reader, looking
 * for the documented name finds no such control. And both pages told the
 * presenter to draw the magnifier's frame "with the pen or a finger", while
 * on an iPad that has seen the Pencil a finger neither draws nor frames
 * (InkLayer · `mine`): the frame silently did not come, the key stayed
 * armed, and the next pen stroke, meant as writing, zoomed the hall
 * instead. "Only fingers zoom" was the same mistake from the other side: it
 * is true of the pinch alone, while the pen frames and the keys zoom too.
 *
 * Words are checked instead of the deed on purpose, as in
 * docs-readme-drift.test.mts: the deed is in the neighbouring suites
 * (lecture-pult, lecture-console-sheets), and nobody builds or type-checks
 * the guide. The lists are read off what the console really draws, in its
 * order, so a colour or a paper added to the code fails here with exactly
 * the word the guide has to learn.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOCALE, setLocaleResolver, translate } from '../shared/i18n.js'
import { SHEET_PAPERS } from '../shared/lecture.js'
import { INKS, MARKERS } from '../web/src/components/lecture/pult.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const LANGS = ['ru', 'en'] as const
type Lang = (typeof LANGS)[number]

function guide(lang: Lang): string {
  return readFileSync(path.join(root, 'docs', 'pages', lang, 'lectures.html'), 'utf8')
}

/** One section of the guide, from its heading up to the next one. */
function section(lang: Lang, id: string): string {
  const body = guide(lang)
  const at = body.indexOf(`<h2 id="${id}">`)
  assert.notEqual(at, -1, `${lang}/lectures.html has no section #${id}`)
  const end = body.indexOf('<h2 ', at + 1)
  return body.slice(at, end === -1 ? undefined : end)
}

/** The list a guide sentence writes out, as its words: "a, b и c", "a, b and c", "«a», «b» или «c»". */
function items(lang: Lang, id: string, sentence: RegExp, group = 1): string[] {
  const found = section(lang, id).match(sentence)
  assert.ok(found, `${lang}/lectures.html #${id} has no sentence matching ${sentence}`)
  return found[group]
    .split(/,\s*|\s+(?:и|или|and|or)\s+/)
    .map((word) => word.replace(/[«»“”]/g, '').trim())
    .filter(Boolean)
}

/** What the console reads through `tr`, in the given language. */
function inLocale<T>(lang: Lang, read: () => T): T {
  setLocaleResolver(() => lang)
  try {
    return read()
  } finally {
    setLocaleResolver(() => DEFAULT_LOCALE)
  }
}

/** How each language's guide quotes a word from the screen. */
function quoted(lang: Lang, text: string): string {
  return lang === 'ru' ? `«${text}»` : `“${text}”`
}

test('the pen colours in the guide are the palette, in the order of keys 1–8', () => {
  const sentence: Record<Lang, RegExp> = {
    ru: /восемь цветов: ([^—<]+?) — последние два/,
    en: /eight colours: ([^<]+?), the last two/,
  }
  for (const lang of LANGS) {
    const palette = inLocale(lang, () => INKS.map((ink) => ink.short))
    assert.deepEqual(items(lang, 'tablet', sentence[lang]), palette, `${lang}: the pen colours drifted`)
  }
})

test('the highlighter colours in the guide are the names on its chips', () => {
  // "Маркер, голубой" / "Highlighter, blue": the colour is what follows the tool's name.
  const colour = (name: string): string => name.slice(name.indexOf(', ') + 2)
  const sentence: Record<Lang, RegExp> = {
    ru: /пять цветов \(([^)]+)\)/,
    en: /five colours \(([^)]+)\)/,
  }
  for (const lang of LANGS) {
    const palette = inLocale(lang, () => MARKERS.map((marker) => colour(marker.name)))
    assert.deepEqual(items(lang, 'tablet', sentence[lang]), palette, `${lang}: the highlighter colours drifted`)
  }
  // The word that drifted: there is no "light blue" chip to look for.
  assert.doesNotMatch(section('en', 'tablet'), /light blue/)
})

test('the papers in the guide are the ones in the sheet menu, under its heading', () => {
  // The menu names each paper by these keys (SheetMenu.svelte · NAMES), in SHEET_PAPERS order.
  const menu = readFileSync(path.join(root, 'web', 'src', 'components', 'lecture', 'SheetMenu.svelte'), 'utf8')
  const keys = new Map([...menu.matchAll(/^\s*(\w+): '(room\.pult4\.paper\w+)',?\s*$/gm)].map((m) => [m[1], m[2]]))
  assert.deepEqual([...keys.keys()], [...SHEET_PAPERS], 'the sheet menu no longer names every paper')
  const sentence: Record<Lang, RegExp> = {
    ru: /В разделе «([^»]+)» выберите ([^—<]+?) —/,
    en: /Under ([^,<]+), pick ([^<]+?), and the hall/,
  }
  for (const lang of LANGS) {
    const found = section(lang, 'sheets').match(sentence[lang])
    assert.ok(found, `${lang}: the guide no longer says where the paper is chosen`)
    assert.equal(found[1], translate(lang, 'room.pult4.paper'))
    const names = SHEET_PAPERS.map((paper) => translate(lang, keys.get(paper) ?? ''))
    assert.deepEqual(items(lang, 'sheets', sentence[lang], 2), names, `${lang}: the paper names drifted`)
  }
})

test('the magnifier frame is drawn with the pen, and the guide says when a finger can do it', () => {
  for (const lang of LANGS) {
    const zoom = section(lang, 'zoom')
    // A finger frames only until the console has seen the pen (InkLayer · `mine`): never promised outright.
    assert.doesNotMatch(zoom, /пером или пальцем|with the pen or a finger/, `${lang}: a finger frame is promised`)
    // True of the pinch alone: the pen frames, and the keys zoom too.
    assert.doesNotMatch(zoom, /Приближают только пальцы|Only fingers zoom/, `${lang}: "only fingers zoom" is back`)
    // What the presenter sees when the finger stops, and the row that brings it back, word for word.
    const toast = translate(lang, 'room.ui.244').replace(/\.$/, '')
    assert.ok(zoom.includes(quoted(lang, toast)), `${lang}: the guide does not quote ${toast}`)
    const row = translate(lang, 'room.ui.215')
    assert.ok(zoom.includes(quoted(lang, row)), `${lang}: the guide does not name the row ${row}`)
  }
})

test('the guide says what the notes say on a sheet', () => {
  for (const lang of LANGS) {
    const said = translate(lang, 'room.ui.314')
    assert.ok(section(lang, 'sheets').includes(said), `${lang}: the guide does not say ${said}`)
  }
})
