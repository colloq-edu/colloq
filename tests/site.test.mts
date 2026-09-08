/**
 * Static landing checks: stylesheet cache version and the entry demo counter.
 * Layout, keyboard access and demo interactions are checked in a browser.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(resolve(ROOT, 'site/index.html'), 'utf8')

/** Тот же хеш, что печатает `git hash-object`: sha1 от «blob <длина>\0» и содержимого. */
function blobHash(rel: string): string {
  const buf = readFileSync(resolve(ROOT, rel))
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

test('метка кэша у styles.css — хеш самого styles.css', () => {
  const marker = /href="styles\.css\?v=([0-9a-f]+)"/.exec(html)?.[1]
  assert.ok(marker, 'в index.html нет ссылки на styles.css с меткой версии')
  const want = blobHash('site/styles.css').slice(0, marker.length)
  assert.equal(
    marker,
    want,
    'styles.css поправили, а метку — нет. Так она и простояла пять правок подряд: ' +
      'читатель получал новый HTML и старые стили по тому же адресу. ' +
      `Новое значение: ${want}`,
  )
})

test('счёт на афише двери берётся из data-n, а не из русской строки', () => {
  const tag = /<span id="door-count"([^>]*)>([^<]*)<\/span>/.exec(html)
  assert.ok(tag, 'строки #door-count в разметке нет')
  const attr = /\bdata-n="(\d+)"/.exec(tag[1])?.[1]
  assert.ok(
    attr,
    '#door-count без data-n: parseInt по «внутри уже 7 человек» даёт NaN, ' +
      'и вошедший читатель видит «внутри уже 1 человек» при пяти кругах',
  )
  assert.equal(attr, /(\d+)/.exec(tag[2])?.[1], 'число в data-n и число в строке разъехались')
  assert.doesNotMatch(
    html,
    /parseInt\(\s*count\.textContent/,
    'счёт снова читается из строки, которая начинается со слова: это NaN, то есть ноль мест',
  )
})
