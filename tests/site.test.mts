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
/** Живые куски лендинга переехали в общий файл: обе страницы читают его. */
const demos = readFileSync(resolve(ROOT, 'site/demos.js'), 'utf8')

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

test('метка кэша у demos.js — хеш самого demos.js', () => {
  const marker = /src="\/?demos\.js\?v=([0-9a-f]+)"/.exec(html)?.[1]
  assert.ok(marker, 'в index.html нет ссылки на demos.js с меткой версии')
  const want = blobHash('site/demos.js').slice(0, marker.length)
  assert.equal(
    marker,
    want,
    'demos.js поправили, а метку — нет: страница приедет новой, а демо на ней ' +
      `останутся старыми. Новое значение: ${want}`,
  )
})

test('слой декоративных кареток закрыт от диктора', () => {
  const at = demos.indexOf("layer.className = 'cursors'")
  assert.ok(at > 0, 'слоя .cursors в скрипте героя нет')
  assert.match(
    demos.slice(at, at + 800),
    /layer\.setAttribute\('aria-hidden', 'true'\)/,
    'слой лежит внутри h1, и без aria-hidden подписи кареток въезжают в его ' +
      'доступное имя: «Занятия, где делают, а не смотрят НИКИТА ТИМУР»',
  )
})
