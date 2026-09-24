/**
 * Scene animations: what the eye cannot see in a single frame.
 *
 * The scenes are drawn by scripts/readme-art.mts, and they have to be viewed in
 * a browser — a person checks the layout and the loop. What stays here is what
 * the eye misses: that the files on disk match what the generator prints
 * (otherwise somebody forgot "make readme-art"), that they hold nothing an
 * <img> on GitHub will not show, and that the languages did not get mixed up —
 * a Russian scene with an English caption looks like it works and silently lies.
 */
import './_env.mts'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { complaints, OUT_DIRS, renderAll, sceneFile } from '../scripts/readme-art.mts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SLUGS = ['room', 'run', 'council', 'lecture', 'oracle'] as const
const LANGS = ['en', 'ru'] as const
const THEMES = ['light', 'dark'] as const

const files = renderAll()

/** Every name the README and the landing page link to. Change them and the links break. */
const expected = SLUGS.flatMap((slug) =>
  LANGS.flatMap((lang) => THEMES.map((theme) => sceneFile(slug, lang, theme))),
)

test('the generator prints all twenty files under the expected names', () => {
  assert.deepEqual([...files.keys()].sort(), [...expected].sort())
})

test('the generator is deterministic: a second run matches the first byte for byte', () => {
  const again = renderAll()
  for (const name of expected) assert.equal(again.get(name), files.get(name), name)
})

test('the files on disk match what the generator prints', () => {
  // There are two directories: the README reads .github/assets/readme, the landing
  // page is served from site/ and cannot reach .github/. The copies have to be identical.
  for (const dir of OUT_DIRS) {
    for (const name of expected) {
      const path = join(dir, name)
      let disk: string
      try {
        disk = readFileSync(path, 'utf8')
      } catch {
        assert.fail(`missing file ${path.slice(ROOT.length + 1)}: run make readme-art`)
      }
      assert.equal(
        disk,
        files.get(name),
        `${path.slice(ROOT.length + 1)} is behind the generator: run make readme-art`,
      )
    }
  }
})

test('every scene passes the checks it needs for an <img> on GitHub to show it', () => {
  for (const [name, svg] of files) assert.deepEqual(complaints(name, svg), [], name)
})

test('every scene has its language at the root and a caption in that language', () => {
  const CYR = /[А-Яа-яЁё]/
  for (const [name, svg] of files) {
    const lang = name.includes('-ru-') ? 'ru' : 'en'
    assert.match(svg, new RegExp(`<svg[^>]*\\slang="${lang}"`), `${name}: no lang="${lang}"`)
    const title = /<title[^>]*>([^<]*)<\/title>/.exec(svg)?.[1] ?? ''
    const desc = /<desc[^>]*>([^<]*)<\/desc>/.exec(svg)?.[1] ?? ''
    assert.ok(title && desc, `${name}: a scene without <title>/<desc>`)
    for (const [what, text] of [['title', title], ['desc', desc]] as const) {
      assert.equal(CYR.test(text), lang === 'ru', `${name}: ${what} is not in the scene's language — ${text}`)
    }
  }
})

/**
 * Latin words that belong in a Russian scene: they are not captions but code
 * and format names. Python stays Python in both languages.
 */
const CODE_WORDS = new Set([
  'csv', // "scores.csv"
  'dtype', // Name: score, dtype: float64
  'float', // ...float64
  'for', // for n in range(10**9)
  'group', // df.groupby("group")
  'groupby',
  'ipad', // ПУЛЬТ ЛЕКЦИИ · IPAD
  'keyerror', // KeyError: 'scores'
  'mean', // .mean()
  'name', // Name: score
  'pdf', // PDF, ваше перо, все экраны
  'range',
  'read', // pd.read_csv
  'round', // .round(2)
  'score',
  'scores',
  'shape', // df.shape
])

/** Words from the visible text of a scene: <style> and entities do not count. */
function visibleWords(svg: string): Set<string> {
  const text = svg
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/&[a-z]+;/g, ' ') // &quot; is a quote in code, not a word
  const out = new Set<string>()
  for (const chunk of text.matchAll(/>([^<>]+)</g)) {
    for (const word of chunk[1].split(/[^A-Za-z]+/)) {
      if (word.length >= 3) out.add(word.toLowerCase())
    }
  }
  return out
}

test('no English captions are left in the Russian scenes', () => {
  const english = new Set<string>()
  for (const [name, svg] of files) {
    if (name.includes('-ru-')) continue
    for (const word of visibleWords(svg)) if (!CODE_WORDS.has(word)) english.add(word)
  }
  assert.ok(english.size > 100, 'the dictionary of English captions came out suspiciously small')
  for (const [name, svg] of files) {
    if (!name.includes('-ru-')) continue
    const left = [...visibleWords(svg)].filter((w) => english.has(w))
    assert.deepEqual(left, [], `${name}: English captions still in place — ${left.join(', ')}`)
  }
})

test('there is no Cyrillic in the English scenes', () => {
  for (const [name, svg] of files) {
    if (name.includes('-ru-')) continue
    const found = /[А-Яа-яЁё]+/.exec(svg)
    assert.equal(found, null, `${name}: Cyrillic in an English scene — ${found?.[0]}`)
  }
})
