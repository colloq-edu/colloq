/**
 * Русская страница и английская — близнецы: одна разметка, два языка.
 *
 * Проверяется то, что ломается молча: разъехавшиеся секции, ссылка в
 * никуда, забытая сцена, русская фраза, уехавшая на английскую страницу,
 * и слова о закрытом доступе, оставшиеся от времён до выпуска.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = resolve(ROOT, 'site')

const ru = readFileSync(resolve(SITE, 'index.html'), 'utf8')
const en = readFileSync(resolve(SITE, 'en/index.html'), 'utf8')

/** Страница и папка, относительно которой считаются её относительные ссылки. */
const PAGES: Array<[string, string, string]> = [
  ['ru', ru, SITE],
  ['en', en, resolve(SITE, 'en')],
]

/**
 * Комментарии — служебный слой: они на русском в обоих файлах, потому что
 * на русском весь остальной код проекта. Читателю страницы они не видны,
 * поэтому из проверки на кириллицу выпадают и HTML-, и JS-комментарии.
 */
function withoutComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function ids(html: string): string[] {
  return [...html.matchAll(/<section[^>]*\bid="([a-z0-9-]+)"/g)].map((m) => m[1]).sort()
}

test('обе страницы существуют и объявляют свой язык', () => {
  assert.match(ru, /<html lang="ru">/)
  assert.match(en, /<html lang="en">/)
})

test('секции у русской и английской страницы одни и те же', () => {
  assert.deepEqual(
    ids(en),
    ids(ru),
    'разъехались разделы: ссылка вида /#konsilium с одной страницы перестаёт ' +
      'работать на другой, а переключатель языка увозит читателя в пустоту',
  )
})

test('сцен поровну, и каждая лежит на диске', () => {
  const scenes = (html: string) => [...html.matchAll(/src="(\/img\/scenes\/[^"]+)"/g)].map((m) => m[1])
  const a = scenes(ru)
  const b = scenes(en)
  assert.ok(a.length >= 5, `на русской странице ${a.length} сцен, ожидалось не меньше пяти`)
  assert.equal(b.length, a.length, 'на одной из страниц сцену забыли')

  /* Русские файлы получают суффикс -ru-; английские идут без него. */
  for (const src of a) assert.match(src, /-ru-light\.svg$/, `русская сцена без -ru-: ${src}`)
  for (const src of b) assert.doesNotMatch(src, /-ru-/, `английская сцена с русским файлом: ${src}`)
  assert.deepEqual(
    b.map((src) => src.replace(/-light\.svg$/, '')),
    a.map((src) => src.replace(/-ru-light\.svg$/, '')),
    'страницы показывают разные сцены или в разном порядке',
  )

  for (const src of [...a, ...b]) {
    assert.ok(existsSync(resolve(SITE, src.replace(/^\//, ''))), `нет файла сцены ${src}`)
  }
})

test('у каждой сцены проставлены размеры и подпись', () => {
  for (const [name, html] of PAGES) {
    const tags = [...html.matchAll(/<img[^>]*\/img\/scenes\/[^>]*>/g)].map((m) => m[0])
    for (const tag of tags) {
      assert.match(tag, /\bwidth="\d+"/, `${name}: сцена без width — страница прыгнет при загрузке`)
      assert.match(tag, /\bheight="\d+"/, `${name}: сцена без height`)
      assert.match(tag, /\bloading="lazy"/, `${name}: сцена грузится сразу, а лежит ниже экрана`)
      assert.match(tag, /\balt="[^"]{20,}"/, `${name}: сцене нужен осмысленный alt`)

      /*
       * Размеры в разметке — не украшение, а место, которое браузер держит
       * до загрузки картинки. Сцены рисует соседний скрипт, и высота у них
       * меняется вместе с содержимым: разъехавшись с разметкой, она вернёт
       * прыжок вёрстки ровно там, где его заделывали.
       */
      const src = /src="([^"]+)"/.exec(tag)![1]
      const svg = readFileSync(resolve(SITE, src.replace(/^\//, '')), 'utf8').slice(0, 400)
      const real = /width="(\d+)"\s+height="(\d+)"/.exec(svg)
      assert.ok(real, `${name}: у ${src} не читаются собственные размеры`)
      assert.equal(/\bwidth="(\d+)"/.exec(tag)![1], real[1], `${name}: ширина ${src} разъехалась`)
      assert.equal(/\bheight="(\d+)"/.exec(tag)![1], real[2], `${name}: высота ${src} разъехалась`)
    }
  }
})

test('канон, hreflang и og согласованы', () => {
  assert.match(ru, /<link rel="canonical" href="https:\/\/colloq\.ru\/" \/>/)
  assert.match(en, /<link rel="canonical" href="https:\/\/colloq\.ru\/en\/" \/>/)
  for (const [name, html] of PAGES) {
    assert.match(html, /hreflang="ru" href="https:\/\/colloq\.ru\/"/, `${name}: нет hreflang ru`)
    assert.match(html, /hreflang="en" href="https:\/\/colloq\.ru\/en\/"/, `${name}: нет hreflang en`)
    assert.match(
      html,
      /hreflang="x-default" href="https:\/\/colloq\.ru\/en\/"/,
      `${name}: x-default должен вести на английскую — она для тех, чей язык не совпал`,
    )
  }
  assert.match(ru, /property="og:locale" content="ru_RU"/)
  assert.match(ru, /property="og:locale:alternate" content="en_US"/)
  assert.match(en, /property="og:locale" content="en_US"/)
  assert.match(en, /property="og:locale:alternate" content="ru_RU"/)
  assert.match(en, /property="og:url" content="https:\/\/colloq\.ru\/en\/"/)
})

test('автовыбор языка смотрит с правильной стороны и не зацикливается', () => {
  assert.match(ru, /var here = 'ru'\n\s*var there = '\/en\/'/, 'русская страница увозит не туда')
  assert.match(en, /var here = 'en'\n\s*var there = '\/'/, 'английская страница увозит не туда')
  for (const [name, html] of PAGES) {
    assert.match(
      html,
      /location\.replace\(there \+ location\.hash\)/,
      `${name}: якорь теряется при смене языка`,
    )
    assert.match(
      html,
      /localStorage\.getItem\('colloq-site-lang'\)/,
      `${name}: явный выбор языка не читается, и переключатель работает один раз`,
    )
  }
})

test('в шапке есть переключатель, и текущий язык в нём — не ссылка', () => {
  assert.match(ru, /<span class="lang-option" aria-current="page">RU<\/span>/)
  assert.match(ru, /<a class="lang-option" href="\/en\/" data-lang="en"/)
  assert.match(en, /<span class="lang-option" aria-current="page">EN<\/span>/)
  assert.match(en, /<a class="lang-option" href="\/" data-lang="ru"/)
})

test('на английской странице нет русского текста, кроме названия языка', () => {
  const clean = withoutComments(en).replace(/Русский/g, '')
  const hit = /[А-Яа-яЁё][А-Яа-яЁё\s.,«»—-]*/.exec(clean)
  assert.equal(
    hit,
    null,
    `русская фраза уехала на английскую страницу: ${JSON.stringify(hit?.[0]?.slice(0, 80))}`,
  )
})

test('страницы не обещают закрытый доступ', () => {
  const closed = [
    /готовится к открытию/i,
    /по запросу/i,
    /закрыт(ый|ом|ая)? (исходный )?код/i,
    /public release is being prepared/i,
    /by request/i,
    /not (yet )?(on PyPI|public)/i,
    /coming soon/i,
  ]
  for (const [name, html] of PAGES) {
    for (const re of closed) {
      assert.doesNotMatch(
        html,
        re,
        `${name}: страница всё ещё говорит о закрытом проекте (${re}), а он выпущен`,
      )
    }
  }
})

test('блок установки на месте и обещает ровно то, что делает пакет', () => {
  for (const [name, html] of PAGES) {
    assert.match(html, /id="start"/, `${name}: нет блока установки`)
    assert.match(html, /<code>pip install colloq<\/code>/, `${name}: нет команды установки`)
    assert.match(html, /<code>colloq start<\/code>/, `${name}: нет команды запуска`)
    assert.match(html, /<code>colloq start --share<\/code>/, `${name}: нет команды со ссылкой`)
    assert.match(html, /https:\/\/github\.com\/sleep3r\/colloq/, `${name}: нет ссылки на GitHub`)
    assert.match(html, /https:\/\/pypi\.org\/project\/colloq\//, `${name}: нет ссылки на PyPI`)
    assert.match(html, /Node\.js 22\+/, `${name}: требования не названы`)
  }
  assert.match(ru, /href="\/docs\/"/, 'русская страница ведёт не в русскую документацию')
  assert.match(en, /href="\/docs\/en\/"/, 'английская страница ведёт не в английскую документацию')
  assert.doesNotMatch(en, /href="\/docs\/"/, 'английская страница уводит в русскую документацию')
})

test('домен виден только как простой текст в элементе .host', () => {
  /* Зеркало colloq.cc подменяет эту подпись на лету: если разбить её на
     дочерние узлы или собрать скриптом, на зеркале останется colloq.ru. */
  for (const [name, html] of PAGES) {
    assert.match(html, /<span class="host">colloq\.ru<\/span>/, `${name}: подпись домена не простой текст`)
    const visible = withoutComments(html)
      .replace(/<[^>]*>/g, ' ')
      .replace(/ colloq\.ru /g, '')
    assert.ok(!visible.includes('colloq.ru'), `${name}: домен напечатан ещё где-то в тексте`)
  }
})

test('каждая местная ссылка и картинка ведёт в существующий файл', () => {
  for (const [name, html, base] of PAGES) {
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
    for (const ref of refs) {
      if (/^(https?:|mailto:|data:|#|\/\/)/.test(ref)) continue
      const bare = ref.split(/[?#]/)[0]
      if (!bare) continue
      /* Корневые ссылки считаются от site/, относительные — от папки страницы. */
      const where = bare.startsWith('/') ? resolve(SITE, bare.slice(1)) : resolve(base, bare)
      const target = bare.endsWith('/') ? resolve(where, 'index.html') : where
      assert.ok(existsSync(target), `${name}: ссылка ${ref} никуда не ведёт (${target})`)
    }
  }
})
