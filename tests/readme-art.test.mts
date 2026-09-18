/**
 * Анимации сцен: то, что нельзя увидеть глазами на одном кадре.
 *
 * Сцены рисует scripts/readme-art.mts, и смотреть их надо в браузере — верстку
 * и петлю проверяет человек. Здесь остаётся то, что глаз пропускает: что файлы
 * на диске совпадают с тем, что печатает генератор (иначе «make readme-art»
 * забыли), что в них нет ничего, чего <img> на GitHub не покажет, и что языки
 * не перемешались — русская сцена с английской подписью выглядит рабочей и
 * молча врёт.
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

/** Все имена, на которые ссылаются README и лендинг. Меняются — ломаются ссылки. */
const expected = SLUGS.flatMap((slug) =>
  LANGS.flatMap((lang) => THEMES.map((theme) => sceneFile(slug, lang, theme))),
)

test('генератор печатает все двадцать файлов под ожидаемыми именами', () => {
  assert.deepEqual([...files.keys()].sort(), [...expected].sort())
})

test('генератор детерминирован: второй прогон байт в байт совпадает с первым', () => {
  const again = renderAll()
  for (const name of expected) assert.equal(again.get(name), files.get(name), name)
})

test('файлы на диске совпадают с тем, что печатает генератор', () => {
  // Каталога два: README читает .github/assets/readme, лендинг раздаётся из
  // site/ и до .github/ не дотягивается. Копии обязаны быть одинаковыми.
  for (const dir of OUT_DIRS) {
    for (const name of expected) {
      const path = join(dir, name)
      let disk: string
      try {
        disk = readFileSync(path, 'utf8')
      } catch {
        assert.fail(`нет файла ${path.slice(ROOT.length + 1)} — прогоните make readme-art`)
      }
      assert.equal(
        disk,
        files.get(name),
        `${path.slice(ROOT.length + 1)} отстал от генератора — прогоните make readme-art`,
      )
    }
  }
})

test('каждая сцена проходит проверки, с которыми её покажет <img> на GitHub', () => {
  for (const [name, svg] of files) assert.deepEqual(complaints(name, svg), [], name)
})

test('у каждой сцены свой язык в корне и подпись на нём же', () => {
  const CYR = /[А-Яа-яЁё]/
  for (const [name, svg] of files) {
    const lang = name.includes('-ru-') ? 'ru' : 'en'
    assert.match(svg, new RegExp(`<svg[^>]*\\slang="${lang}"`), `${name}: нет lang="${lang}"`)
    const title = /<title[^>]*>([^<]*)<\/title>/.exec(svg)?.[1] ?? ''
    const desc = /<desc[^>]*>([^<]*)<\/desc>/.exec(svg)?.[1] ?? ''
    assert.ok(title && desc, `${name}: сцена без <title>/<desc>`)
    for (const [what, text] of [['title', title], ['desc', desc]] as const) {
      assert.equal(CYR.test(text), lang === 'ru', `${name}: ${what} не на языке сцены — ${text}`)
    }
  }
})

/**
 * Латиница, которой в русской сцене место: это не подписи, а код и имена
 * форматов. Питон остаётся Питоном на обоих языках.
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

/** Слова из видимого текста сцены: <style> и сущности не в счёт. */
function visibleWords(svg: string): Set<string> {
  const text = svg
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/&[a-z]+;/g, ' ') // &quot; — это кавычка в коде, а не слово
  const out = new Set<string>()
  for (const chunk of text.matchAll(/>([^<>]+)</g)) {
    for (const word of chunk[1].split(/[^A-Za-z]+/)) {
      if (word.length >= 3) out.add(word.toLowerCase())
    }
  }
  return out
}

test('в русских сценах не осталось английских подписей', () => {
  const english = new Set<string>()
  for (const [name, svg] of files) {
    if (name.includes('-ru-')) continue
    for (const word of visibleWords(svg)) if (!CODE_WORDS.has(word)) english.add(word)
  }
  assert.ok(english.size > 100, 'словарь английских подписей собрался подозрительно маленьким')
  for (const [name, svg] of files) {
    if (!name.includes('-ru-')) continue
    const left = [...visibleWords(svg)].filter((w) => english.has(w))
    assert.deepEqual(left, [], `${name}: английские подписи на месте — ${left.join(', ')}`)
  }
})

test('в английских сценах нет кириллицы', () => {
  for (const [name, svg] of files) {
    if (name.includes('-ru-')) continue
    const found = /[А-Яа-яЁё]+/.exec(svg)
    assert.equal(found, null, `${name}: кириллица в английской сцене — ${found?.[0]}`)
  }
})
