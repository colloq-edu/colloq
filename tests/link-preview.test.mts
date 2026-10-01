/**
 * The link card for a room.
 *
 * A messenger reads the `<head>` of the first response: it must carry the
 * class name, the absolute image address and the page itself — the same one
 * everyone else gets. The room name is someone else's text, and it goes into
 * the tags escaped.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-preview-'))
fs.mkdirSync(path.join(staticDir, 'og'), { recursive: true })
fs.writeFileSync(path.join(staticDir, 'og', 'colloq.png'), 'not really a png')
fs.writeFileSync(
  path.join(staticDir, 'index.html'),
  '<!doctype html><html lang="ru"><head><title>Colloq</title></head><body><div id="app"></div></body></html>',
)
process.env.STATIC_DIR = staticDir

// The public address is read from the .env next to it, not from the
// environment (config.ts: the file wins) — so the one to expect is the one the
// server sees.
let origin = ''
let base = ''
let server: http.Server

before(async () => {
  const { config } = await import('../server/src/config.js')
  origin = config.publicUrl.replace(/\/+$/, '')
  const { app } = await import('../server/src/app.js')
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  fs.rmSync(staticDir, { recursive: true, force: true })
})

const page = async (p: string): Promise<{ html: string; etag: string }> => {
  const response = await fetch(`${base}${p}`)
  assert.equal(response.status, 200, p)
  return { html: await response.text(), etag: response.headers.get('etag') ?? '' }
}

const meta = (html: string, property: string): string | null => {
  const match = new RegExp(`<meta property="${property}" content="([^"]*)">`).exec(html)
  return match ? match[1] : null
}

test('a room link carries the class name, the image and its own address', async () => {
  const { createSession } = await import('../server/src/db.js')
  createSession('previewroom', 'MMDA | week01', null)
  const { html } = await page('/s/previewroom')
  assert.equal(meta(html, 'og:title'), 'MMDA | week01 · Colloq')
  assert.match(html, /<title>MMDA \| week01 · Colloq<\/title>/)
  assert.equal(meta(html, 'og:url'), `${origin}/s/previewroom`)
  // The room image is its own, versioned by name and date (og-card.ts).
  assert.match(meta(html, 'og:image') ?? '', /\/og\/rooms\/previewroom\.png\?v=[A-Za-z0-9_-]{10}$/)
  assert.ok((meta(html, 'og:image') ?? '').startsWith(`${origin}/og/rooms/`))
  assert.equal(meta(html, 'og:image:width'), '1200')
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/)
  assert.match(meta(html, 'og:description') ?? '', /Занятие в Colloq/)
  // The page stayed the same: the language, the app root.
  assert.match(html, /<meta name="colloq-language" content="ru">/)
  assert.match(html, /<div id="app">/)
})

test('the room name goes into the tags escaped', async () => {
  const { createSession } = await import('../server/src/db.js')
  createSession('previewevil', '<script>alert("x")</script> & co', null)
  const { html } = await page('/s/previewevil')
  assert.doesNotMatch(html, /<script>alert/)
  assert.equal(
    meta(html, 'og:title'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co · Colloq',
  )
  assert.match(html, /<title>&lt;script&gt;alert\("x"\)&lt;\/script&gt; &amp; co · Colloq<\/title>/)
})

test('the root and an unknown room get the general card, not nothing', async () => {
  const root = await page('/')
  assert.equal(meta(root.html, 'og:title'), 'Colloq — одна ссылка на всё занятие')
  // No address of its own: the card is general, and all such paths share one
  // page.
  assert.equal(meta(root.html, 'og:url'), null)
  assert.match(meta(root.html, 'og:image') ?? '', /\/og\/colloq\.png\?v=[0-9a-z]+$/)
  const missing = await page('/s/nosuchroom')
  assert.equal(meta(missing.html, 'og:title'), meta(root.html, 'og:title'))
  assert.equal(meta(missing.html, 'og:description'), meta(root.html, 'og:description'))
  assert.equal(missing.etag, root.etag)
})

test('pages of different rooms have different ETags, one room has one', async () => {
  const one = await page('/s/previewroom')
  const again = await page('/s/previewroom')
  const other = await page('/s/previewevil')
  assert.equal(one.etag, again.etag)
  assert.notEqual(one.etag, other.etag)
  const cached = await fetch(`${base}/s/previewroom`, { headers: { 'if-none-match': one.etag } })
  assert.equal(cached.status, 304)
})

/* ------------------------------------------- competitions and courses */

test('a competition link carries its title, blurb, own image and address; a draft looks like any page', async () => {
  const { createCompetition, setCompetitionState } = await import('../server/src/competitions/store.js')
  const live = createCompetition({ slug: 'pvz-preview', title: 'Спрос нового ПВЗ', blurb: 'Предскажите спрос.', metric: { name: 'MAPE', direction: 'lower' }, deadlineAt: Date.now() + 86_400_000 })
  assert.ok(live)
  setCompetitionState(live.id, 'live')
  const { html } = await page('/k/pvz-preview')
  assert.equal(meta(html, 'og:title'), 'Спрос нового ПВЗ · Colloq')
  assert.equal(meta(html, 'og:description'), 'Предскажите спрос.')
  assert.match(meta(html, 'og:image') ?? '', new RegExp(`^${origin}/og/competitions/pvz-preview\\.png\\?v=[A-Za-z0-9_-]{10}$`))
  assert.equal(meta(html, 'og:url'), `${origin}/k/pvz-preview`)
  // Its tabs share the card.
  assert.equal(meta((await page('/k/pvz-preview/leaderboard')).html, 'og:image'), meta(html, 'og:image'))

  const draft = createCompetition({ slug: 'secret-draft', title: 'Секретный черновик' })
  assert.ok(draft)
  const hidden = (await page('/k/secret-draft')).html
  assert.equal(hidden.includes('Секретный черновик'), false, 'a draft must not show through the card')
  assert.equal(meta(hidden, 'og:url'), null)
  // The key link is a credential: it never gets a card of its own.
  assert.equal(meta((await page('/k/t/abcdefghij')).html, 'og:url'), null)
})

test('the competitions list and a course have cards of their own', async () => {
  const list = (await page('/k')).html
  assert.match(meta(list, 'og:image') ?? '', new RegExp(`^${origin}/og/competitions\\.png\\?v=`))
  assert.equal(meta(list, 'og:url'), `${origin}/k`)

  const { createCourse, setCourseSlug } = await import('../server/src/publish/store.js')
  const course = createCourse('Машинное обучение', 'Восемь недель.', null)
  assert.equal(setCourseSlug(course.id, 'ml-preview'), 'ok')
  const { html } = await page('/c/ml-preview')
  assert.equal(meta(html, 'og:title'), 'Машинное обучение · Colloq')
  assert.equal(meta(html, 'og:description'), 'Восемь недель.')
  assert.match(meta(html, 'og:image') ?? '', new RegExp(`^${origin}/og/courses/ml-preview\\.png\\?v=`))
  // An unknown course is any page.
  assert.equal(meta((await page('/c/no-such-course')).html, 'og:url'), null)
})
