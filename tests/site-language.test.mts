/**
 * The Russian page and the English one are twins: one markup, two languages.
 *
 * What is checked is what breaks silently: sections drifting apart, a link to
 * nowhere, a forgotten scene, a Russian phrase that slipped onto the English
 * page, and words about closed access left over from before the release.
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

/** A page and the folder its relative links are resolved against. */
const PAGES: Array<[string, string, string]> = [
  ['ru', ru, SITE],
  ['en', en, resolve(SITE, 'en')],
]

/**
 * Comments are a service layer: in both files they may be in Russian, as the
 * rest of the project's code was. Readers of the page do not see them, so both
 * HTML and JS comments drop out of the Cyrillic check.
 */
function withoutComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function ids(html: string): string[] {
  return [...html.matchAll(/<section[^>]*\bid="([a-z0-9-]+)"/g)].map((m) => m[1]).sort()
}

test('both pages exist and declare their language', () => {
  assert.match(ru, /<html lang="ru">/)
  assert.match(en, /<html lang="en">/)
})

test('the Russian and English pages have the same sections', () => {
  assert.deepEqual(
    ids(en),
    ids(ru),
    'the sections drifted apart: a link like /#konsilium from one page stops ' +
      'working on the other, and the language switcher takes the reader into the void',
  )
})

test('both pages have the same number of scenes, and each one is on disk', () => {
  const scenes = (html: string) => [...html.matchAll(/src="(\/img\/scenes\/[^"]+)"/g)].map((m) => m[1])
  const a = scenes(ru)
  const b = scenes(en)
  assert.ok(a.length >= 5, `the Russian page has ${a.length} scenes, at least five were expected`)
  assert.equal(b.length, a.length, 'a scene was forgotten on one of the pages')

  /* Russian files get the -ru- suffix; English ones go without it. */
  for (const src of a) assert.match(src, /-ru-light\.svg$/, `a Russian scene without -ru-: ${src}`)
  for (const src of b) assert.doesNotMatch(src, /-ru-/, `an English scene with a Russian file: ${src}`)
  assert.deepEqual(
    b.map((src) => src.replace(/-light\.svg$/, '')),
    a.map((src) => src.replace(/-ru-light\.svg$/, '')),
    'the pages show different scenes or show them in a different order',
  )

  for (const src of [...a, ...b]) {
    assert.ok(existsSync(resolve(SITE, src.replace(/^\//, ''))), `no scene file ${src}`)
  }
})

test('every scene has its dimensions and a caption set', () => {
  for (const [name, html] of PAGES) {
    const tags = [...html.matchAll(/<img[^>]*\/img\/scenes\/[^>]*>/g)].map((m) => m[0])
    for (const tag of tags) {
      assert.match(tag, /\bwidth="\d+"/, `${name}: a scene without width — the page will jump on load`)
      assert.match(tag, /\bheight="\d+"/, `${name}: a scene without height`)
      assert.match(tag, /\bloading="lazy"/, `${name}: a scene loads right away, though it sits below the fold`)
      assert.match(tag, /\balt="[^"]{20,}"/, `${name}: a scene needs a meaningful alt`)

      /*
       * The dimensions in the markup are not decoration but the space the
       * browser holds until the image loads. The scenes are drawn by a
       * neighbouring script, and their height changes with the content: once
       * it drifts from the markup, it brings the layout jump back exactly
       * where it was patched.
       */
      const src = /src="([^"]+)"/.exec(tag)![1]
      const svg = readFileSync(resolve(SITE, src.replace(/^\//, '')), 'utf8').slice(0, 400)
      const real = /width="(\d+)"\s+height="(\d+)"/.exec(svg)
      assert.ok(real, `${name}: the intrinsic dimensions of ${src} cannot be read`)
      assert.equal(/\bwidth="(\d+)"/.exec(tag)![1], real[1], `${name}: the width of ${src} drifted`)
      assert.equal(/\bheight="(\d+)"/.exec(tag)![1], real[2], `${name}: the height of ${src} drifted`)
    }
  }
})

test('canonical, hreflang and og agree', () => {
  assert.match(ru, /<link rel="canonical" href="https:\/\/colloq\.ru\/" \/>/)
  assert.match(en, /<link rel="canonical" href="https:\/\/colloq\.ru\/en\/" \/>/)
  for (const [name, html] of PAGES) {
    assert.match(html, /hreflang="ru" href="https:\/\/colloq\.ru\/"/, `${name}: no hreflang ru`)
    assert.match(html, /hreflang="en" href="https:\/\/colloq\.ru\/en\/"/, `${name}: no hreflang en`)
    assert.match(
      html,
      /hreflang="x-default" href="https:\/\/colloq\.ru\/en\/"/,
      `${name}: x-default must lead to the English page — it is for those whose language did not match`,
    )
  }
  assert.match(ru, /property="og:locale" content="ru_RU"/)
  assert.match(ru, /property="og:locale:alternate" content="en_US"/)
  assert.match(en, /property="og:locale" content="en_US"/)
  assert.match(en, /property="og:locale:alternate" content="ru_RU"/)
  assert.match(en, /property="og:url" content="https:\/\/colloq\.ru\/en\/"/)
})

test('the automatic language choice looks from the right side and does not loop', () => {
  assert.match(ru, /var here = 'ru'\n\s*var there = '\/en\/'/, 'the Russian page redirects to the wrong place')
  assert.match(en, /var here = 'en'\n\s*var there = '\/'/, 'the English page redirects to the wrong place')
  for (const [name, html] of PAGES) {
    assert.match(
      html,
      /location\.replace\(there \+ location\.hash\)/,
      `${name}: the anchor is lost when switching language`,
    )
    assert.match(
      html,
      /localStorage\.getItem\('colloq-site-lang'\)/,
      `${name}: an explicit language choice is not read, and the switcher works only once`,
    )
  }
})

test('the header has a switcher, and the current language in it is not a link', () => {
  assert.match(ru, /<span class="lang-option" aria-current="page">RU<\/span>/)
  assert.match(ru, /<a class="lang-option" href="\/en\/" data-lang="en"/)
  assert.match(en, /<span class="lang-option" aria-current="page">EN<\/span>/)
  assert.match(en, /<a class="lang-option" href="\/" data-lang="ru"/)
})

test('the English page has no Russian text except the language name', () => {
  const clean = withoutComments(en).replace(/Русский/g, '')
  const hit = /[А-Яа-яЁё][А-Яа-яЁё\s.,«»—-]*/.exec(clean)
  assert.equal(
    hit,
    null,
    `a Russian phrase slipped onto the English page: ${JSON.stringify(hit?.[0]?.slice(0, 80))}`,
  )
})

test('the pages do not promise closed access', () => {
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
        `${name}: the page still talks about a closed project (${re}), but it has been released`,
      )
    }
  }
})

test('the install block is in place and promises exactly what the package does', () => {
  for (const [name, html] of PAGES) {
    assert.match(html, /id="start"/, `${name}: no install block`)
    assert.match(html, /<code>pip install colloq<\/code>/, `${name}: no install command`)
    assert.match(html, /<code>colloq start<\/code>/, `${name}: no start command`)
    assert.match(html, /<code>colloq start --share<\/code>/, `${name}: no command with a share link`)
    assert.match(html, /https:\/\/github\.com\/colloq-edu\/colloq/, `${name}: no link to GitHub`)
    assert.match(html, /https:\/\/pypi\.org\/project\/colloq\//, `${name}: no link to PyPI`)
    // Platform wheels bring Node.js: on the pages the requirements are Python and Docker.
    assert.match(html, /<p class="install-req">Python · Docker<\/p>/, `${name}: the requirements are not named`)
    assert.doesNotMatch(html, /Node\.js 22\+/, `${name}: still asks for Node.js`)
  }
  assert.match(ru, /href="\/docs\/"/, 'the Russian page does not lead to the Russian documentation')
  assert.match(en, /href="\/docs\/en\/"/, 'the English page does not lead to the English documentation')
  assert.doesNotMatch(en, /href="\/docs\/"/, 'the English page leads to the Russian documentation')
})

test('the domain is visible only as plain text in the .host element', () => {
  /* The colloq.cc mirror swaps this caption on the fly: if it is split into
     child nodes or assembled by a script, colloq.ru will remain on the mirror. */
  for (const [name, html] of PAGES) {
    assert.match(html, /<span class="host">colloq\.ru<\/span>/, `${name}: the domain caption is not plain text`)
    // The contents of <script> and <style> are not page text: in the
    // schema.org markup the site addresses are there for a reason, and the
    // mirror rewrites only `body .host`.
    // The separator is written as \u0000, not as the byte itself: with a
    // literal NUL the file became binary for grep and for the diff on GitHub.
    const visible = withoutComments(html)
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '\u0000')
      .replace(/<[^>]*>/g, '\u0000')
      .replace(/\u0000colloq\.ru\u0000/g, '')
    assert.ok(!visible.includes('colloq.ru'), `${name}: the domain is printed somewhere else in the text`)
  }
})

test('every local link and image leads to an existing file', () => {
  for (const [name, html, base] of PAGES) {
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
    for (const ref of refs) {
      if (/^(https?:|mailto:|data:|#|\/\/)/.test(ref)) continue
      const bare = ref.split(/[?#]/)[0]
      if (!bare) continue
      /* Root links are resolved from site/, relative ones from the page's folder. */
      const where = bare.startsWith('/') ? resolve(SITE, bare.slice(1)) : resolve(base, bare)
      const target = bare.endsWith('/') ? resolve(where, 'index.html') : where
      assert.ok(existsSync(target), `${name}: link ${ref} leads nowhere (${target})`)
    }
  }
})

/*
 * The favicon and the sitemap are for the search engine, not for the browser.
 *
 * The landing page icon was a data: link, /favicon.ico answered 404, and in
 * Google results colloq.ru had a grey globe: the crawler takes an icon only
 * from a real address and only a square one whose side is a multiple of 48 px
 * (or SVG).
 */
test('the site icon is real files the crawler can download', () => {
  for (const file of ['index.html', 'en/index.html']) {
    const head = readFileSync(resolve(SITE, file), 'utf8').split('</head>')[0]!
    assert.doesNotMatch(head, /rel="icon"[^>]*href="data:/, `${file}: the icon is embedded as a data: link again`)
    for (const href of ['/favicon.ico', '/favicon.svg', '/favicon-96.png', '/apple-touch-icon.png']) {
      assert.ok(head.includes(`href="${href}"`), `${file}: no link to ${href}`)
    }
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(head)?.[1]
    assert.ok(ld, `${file}: no schema.org markup`)
    const graph = (JSON.parse(ld) as { '@graph': { '@type': string; name?: string; logo?: { url: string } }[] })['@graph']
    assert.equal(graph.find((node) => node['@type'] === 'WebSite')?.name, 'Colloq')
    assert.equal(graph.find((node) => node['@type'] === 'Organization')?.logo?.url, 'https://colloq.ru/icon-512.png')
  }
  // PNG: the side from the IHDR header; Google asks for a multiple of 48.
  for (const [name, side] of [['favicon-48.png', 48], ['favicon-96.png', 96], ['favicon-192.png', 192], ['icon-512.png', 512]] as const) {
    const png = readFileSync(resolve(SITE, name))
    assert.equal(png.readUInt32BE(16), side, `${name}: width`)
    assert.equal(png.readUInt32BE(20), side, `${name}: height`)
  }
  for (const side of [48, 96, 192]) assert.equal(side % 48, 0)
  const ico = readFileSync(resolve(SITE, 'favicon.ico'))
  assert.equal(ico.readUInt16LE(2), 1, 'favicon.ico: not an icon')
  assert.ok(ico.readUInt16LE(4) >= 1)
})

test('robots.txt lets everyone in and names the sitemap, and the sitemap knows both versions of the landing page', () => {
  const robots = readFileSync(resolve(SITE, 'robots.txt'), 'utf8')
  assert.match(robots, /^User-agent: \*$/m)
  assert.doesNotMatch(robots, /^Disallow: \/\s*$/m)
  assert.match(robots, /^Sitemap: https:\/\/colloq\.ru\/sitemap\.xml$/m)
  const map = readFileSync(resolve(SITE, 'sitemap.xml'), 'utf8')
  for (const loc of ['https://colloq.ru/', 'https://colloq.ru/en/', 'https://colloq.ru/docs/', 'https://colloq.ru/docs/en/']) {
    assert.ok(map.includes(`<loc>${loc}</loc>`), `the sitemap has no ${loc}`)
  }
})
