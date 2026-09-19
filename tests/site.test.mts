/**
 * Static landing checks: stylesheet cache version and the entry demo counter.
 * Layout, keyboard access and demo interactions are checked in a browser.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OG_HEIGHT, OG_IMAGES, OG_WIDTH, writeOgImages } from '../scripts/site-og.mts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(resolve(ROOT, 'site/index.html'), 'utf8')
const en = readFileSync(resolve(ROOT, 'site/en/index.html'), 'utf8')
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

/*
 * -------------------------------------------------------- превью ссылки
 *
 * Три картинки 1200×630 рисует scripts/site-og.mts: русская для colloq.ru,
 * английская для /en/ и та же английская с подписью colloq.cc — её подставляет
 * зеркало. Ошибиться тут можно молча и дорого: разворачиватель ссылок кэширует
 * карточку на дни, и страница, показавшая чужой язык или битую картинку,
 * останется такой в чужих чатах надолго.
 */
test('каждая страница зовёт свою картинку превью', () => {
  assert.match(
    html,
    /property="og:image" content="https:\/\/colloq\.ru\/img\/og\.png\?v=[0-9a-f]+"/,
    'русская страница показывает не русскую картинку',
  )
  assert.match(
    en,
    /property="og:image" content="https:\/\/colloq\.ru\/img\/og-en\.png\?v=[0-9a-f]+"/,
    'английская страница показывает русскую картинку: бот не исполняет JS, ' +
      'и автовыбор языка до него не доезжает вовсе',
  )
  for (const [name, page] of [['ru', html], ['en', en]] as const) {
    assert.match(page, /property="og:image:width" content="1200"/, `${name}: нет ширины картинки`)
    assert.match(page, /property="og:image:height" content="630"/, `${name}: нет высоты картинки`)
  }
})

test('метки кэша у картинок превью — хеши самих картинок', () => {
  const cases: Array<[string, string, string]> = [
    ['site/index.html', html, 'og.png'],
    ['site/en/index.html', en, 'og-en.png'],
  ]
  for (const [where, page, file] of cases) {
    const marker = new RegExp(`/img/${file.replace('.', '\\.')}\\?v=([0-9a-f]+)"`).exec(page)?.[1]
    assert.ok(marker, `${where}: у ${file} нет метки версии`)
    const want = blobHash(`site/img/${file}`).slice(0, marker.length)
    assert.equal(
      marker,
      want,
      `${where}: картинку перерисовали, а метку — нет. Мессенджер держит превью в ` +
        `своём кэше днями и покажет старую. Новое значение: ${want}`,
    )
  }
})

test('картинки превью на месте, размером 1200×630 и не тяжелее 150 КБ', () => {
  for (const { file } of OG_IMAGES) {
    const png = readFileSync(resolve(ROOT, 'site/img', file))
    assert.equal(png.readUInt32BE(16), OG_WIDTH, `${file}: ширина`)
    assert.equal(png.readUInt32BE(20), OG_HEIGHT, `${file}: высота`)
    // Telegram и WhatsApp качают картинку до показа превью, и тяжёлая просто
    // не успевает приехать.
    const kb = Math.round(png.length / 1024)
    assert.ok(png.length < 150 * 1024, `${file}: ${kb} КБ — слишком тяжело`)
  }
})

test('перерисованные картинки превью совпадают с выложенными побайтно', async () => {
  /*
   * Файл в site/img — единственное, что видит мессенджер, а рисует его скрипт.
   * Разойдясь однажды (правка текста без перерисовки или наоборот), они будут
   * расходиться и дальше: сверить их глазами нельзя, а метка ?v= считается по
   * файлу и о правке скрипта ничего не знает.
   */
  const dir = mkdtempSync(join(tmpdir(), 'colloq-og-'))
  try {
    await writeOgImages(dir)
    for (const { file } of OG_IMAGES) {
      assert.deepEqual(
        readFileSync(join(dir, file)),
        readFileSync(resolve(ROOT, 'site/img', file)),
        `${file} разошёлся со scripts/site-og.mts — перерисуйте: make site-og`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
