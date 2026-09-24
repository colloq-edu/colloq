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
/** The live parts of the landing page moved into a shared file: both pages read it. */
const demos = readFileSync(resolve(ROOT, 'site/demos.js'), 'utf8')

/** The same hash `git hash-object` prints: sha1 of "blob <length>\0" and the contents. */
function blobHash(rel: string): string {
  const buf = readFileSync(resolve(ROOT, rel))
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

test('the cache marker on styles.css is the hash of styles.css itself', () => {
  const marker = /href="styles\.css\?v=([0-9a-f]+)"/.exec(html)?.[1]
  assert.ok(marker, 'index.html has no link to styles.css with a version marker')
  const want = blobHash('site/styles.css').slice(0, marker.length)
  assert.equal(
    marker,
    want,
    'styles.css was edited, but the marker was not. That is how it stood through five edits in a row: ' +
      'the reader got new HTML and old styles at the same address. ' +
      `New value: ${want}`,
  )
})

test('the cache marker on demos.js is the hash of demos.js itself', () => {
  const marker = /src="\/?demos\.js\?v=([0-9a-f]+)"/.exec(html)?.[1]
  assert.ok(marker, 'index.html has no link to demos.js with a version marker')
  const want = blobHash('site/demos.js').slice(0, marker.length)
  assert.equal(
    marker,
    want,
    'demos.js was edited, but the marker was not: the page will arrive new, but the demos on it ' +
      `will stay old. New value: ${want}`,
  )
})

/*
 * --------------------------------------------------------- link preview
 *
 * Three 1200×630 images are drawn by scripts/site-og.mts: a Russian one for
 * colloq.ru, an English one for /en/, and the same English one captioned
 * colloq.cc — the mirror substitutes it. Mistakes here are silent and
 * expensive: link unfurlers cache the card for days, and a page that showed
 * the wrong language or a broken image stays that way in other people's chats
 * for a long time.
 */
test('each page calls for its own preview image', () => {
  assert.match(
    html,
    /property="og:image" content="https:\/\/colloq\.ru\/img\/og\.png\?v=[0-9a-f]+"/,
    'the Russian page shows a non-Russian image',
  )
  assert.match(
    en,
    /property="og:image" content="https:\/\/colloq\.ru\/img\/og-en\.png\?v=[0-9a-f]+"/,
    'the English page shows the Russian image: the bot does not run JS, ' +
      'and the automatic language choice never reaches it',
  )
  for (const [name, page] of [['ru', html], ['en', en]] as const) {
    assert.match(page, /property="og:image:width" content="1200"/, `${name}: no image width`)
    assert.match(page, /property="og:image:height" content="630"/, `${name}: no image height`)
  }
})

test('the cache markers on preview images are the hashes of the images themselves', () => {
  const cases: Array<[string, string, string]> = [
    ['site/index.html', html, 'og.png'],
    ['site/en/index.html', en, 'og-en.png'],
  ]
  for (const [where, page, file] of cases) {
    const marker = new RegExp(`/img/${file.replace('.', '\\.')}\\?v=([0-9a-f]+)"`).exec(page)?.[1]
    assert.ok(marker, `${where}: ${file} has no version marker`)
    const want = blobHash(`site/img/${file}`).slice(0, marker.length)
    assert.equal(
      marker,
      want,
      `${where}: the image was redrawn, but the marker was not. A messenger keeps the preview in ` +
        `its cache for days and will show the old one. New value: ${want}`,
    )
  }
})

test('the preview images are in place, 1200×630 in size and no heavier than 150 KB', () => {
  for (const { file } of OG_IMAGES) {
    const png = readFileSync(resolve(ROOT, 'site/img', file))
    assert.equal(png.readUInt32BE(16), OG_WIDTH, `${file}: width`)
    assert.equal(png.readUInt32BE(20), OG_HEIGHT, `${file}: height`)
    // Telegram and WhatsApp download the image before showing the preview,
    // and a heavy one simply does not arrive in time.
    const kb = Math.round(png.length / 1024)
    assert.ok(png.length < 150 * 1024, `${file}: ${kb} KB — too heavy`)
  }
})

test('redrawn preview images match the published ones byte for byte', async () => {
  /*
   * The file in site/img is the only thing the messenger sees, and a script
   * draws it. Once they diverge (a text edit without a redraw or the other way
   * round), they will keep diverging: they cannot be compared by eye, and the
   * ?v= marker is computed from the file and knows nothing about script edits.
   */
  const dir = mkdtempSync(join(tmpdir(), 'colloq-og-'))
  try {
    await writeOgImages(dir)
    for (const { file } of OG_IMAGES) {
      assert.deepEqual(
        readFileSync(join(dir, file)),
        readFileSync(resolve(ROOT, 'site/img', file)),
        `${file} diverged from scripts/site-og.mts — redraw it: make site-og`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the layer of decorative carets is hidden from the screen reader', () => {
  const at = demos.indexOf("layer.className = 'cursors'")
  assert.ok(at > 0, 'the hero script has no .cursors layer')
  assert.match(
    demos.slice(at, at + 800),
    /layer\.setAttribute\('aria-hidden', 'true'\)/,
    'the layer sits inside h1, and without aria-hidden the caret labels slip into its ' +
      'accessible name: "Занятия, где делают, а не смотрят НИКИТА ТИМУР"',
  )
})
