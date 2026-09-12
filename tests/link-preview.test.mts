/**
 * Карточка ссылки на комнату.
 *
 * Мессенджер читает `<head>` первого ответа: там должны быть имя занятия,
 * абсолютный адрес картинки и сама страница — та же, что у всех остальных.
 * Имя комнаты — чужой текст, и в теги оно уходит экранированным.
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

// Публичный адрес читается из .env рядом, а не из окружения (config.ts:
// файл главнее) — значит, и ожидать надо тот, что видит сервер.
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

test('ссылка на комнату несёт имя занятия, картинку и свой адрес', async () => {
  const { createSession } = await import('../server/src/db.js')
  createSession('previewroom', 'MMDA | week01', null)
  const { html } = await page('/s/previewroom')
  assert.equal(meta(html, 'og:title'), 'MMDA | week01 · Colloq')
  assert.match(html, /<title>MMDA \| week01 · Colloq<\/title>/)
  assert.equal(meta(html, 'og:url'), `${origin}/s/previewroom`)
  // Картинка комнаты — своя, с версией от имени и даты (og-card.ts).
  assert.match(meta(html, 'og:image') ?? '', /\/og\/rooms\/previewroom\.png\?v=[A-Za-z0-9_-]{10}$/)
  assert.ok((meta(html, 'og:image') ?? '').startsWith(`${origin}/og/rooms/`))
  assert.equal(meta(html, 'og:image:width'), '1200')
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/)
  assert.match(meta(html, 'og:description') ?? '', /Вы входите на занятие/)
  // Страница осталась той же: язык, корень приложения.
  assert.match(html, /<meta name="colloq-language" content="ru">/)
  assert.match(html, /<div id="app">/)
})

test('имя комнаты уходит в теги экранированным', async () => {
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

test('корень и неизвестная комната получают общую карточку, а не пустоту', async () => {
  const root = await page('/')
  assert.equal(meta(root.html, 'og:title'), 'Colloq — одна ссылка на всё занятие')
  // Без своего адреса: карточка общая, и страница у всех таких путей одна.
  assert.equal(meta(root.html, 'og:url'), null)
  assert.match(meta(root.html, 'og:image') ?? '', /\/og\/colloq\.png\?v=[0-9a-z]+$/)
  const missing = await page('/s/nosuchroom')
  assert.equal(meta(missing.html, 'og:title'), meta(root.html, 'og:title'))
  assert.equal(meta(missing.html, 'og:description'), meta(root.html, 'og:description'))
  assert.equal(missing.etag, root.etag)
})

test('у страниц разных комнат разные ETag, у одной комнаты — один', async () => {
  const one = await page('/s/previewroom')
  const again = await page('/s/previewroom')
  const other = await page('/s/previewevil')
  assert.equal(one.etag, again.etag)
  assert.notEqual(one.etag, other.etag)
  const cached = await fetch(`${base}/s/previewroom`, { headers: { 'if-none-match': one.etag } })
  assert.equal(cached.status, 304)
})
