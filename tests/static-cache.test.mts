/**
 * Что можно кэшировать на год, а что нельзя.
 *
 * Vite штампует хэш в имя всего, что собирает, и складывает это в `assets/`;
 * всё остальное в dist приезжает из `web/public` как есть, под именем, которое
 * выбрал человек. Рядом с проверкой каталога стоял регэксп «дефис и восемь
 * знаков» — и `hse-sans-400.woff2` попадал под него («-sans-400»), хотя никакого
 * хэша там нет. Шрифт института уходил с `immutable` на год: заменить
 * начертание под тем же именем и дождаться этого у вернувшихся браузеров было
 * нельзя.
 *
 * STATIC_DIR ставится ДО импорта приложения: config читает переменные при
 * загрузке модуля, поэтому приложение здесь подтягивается динамически.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-static-'))
fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true })
fs.mkdirSync(path.join(staticDir, 'fonts'), { recursive: true })
fs.writeFileSync(path.join(staticDir, 'assets', 'index-UnEQhcxl.js'), 'export default 1\n')
// Настоящее имя из web/public: дефис, «sans», дефис, «400» — восемь знаков,
// и ни одного из них не выбирал сборщик.
fs.writeFileSync(path.join(staticDir, 'fonts', 'hse-sans-400.woff2'), 'not really a font')
fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Colloq</title>')
process.env.STATIC_DIR = staticDir

let base = ''
let server: http.Server

before(async () => {
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

const cacheOf = async (p: string): Promise<string> =>
  (await fetch(`${base}${p}`)).headers.get('cache-control') ?? ''

test('собранное с хэшем в имени кэшируется на год', async () => {
  assert.equal(await cacheOf('/assets/index-UnEQhcxl.js'), 'public, max-age=31536000, immutable')
})

test('шрифт из public — не версионный файл, сколько бы дефисов ни было в имени', async () => {
  const said = await cacheOf('/fonts/hse-sans-400.woff2')
  assert.equal(said, 'public, max-age=3600')
  assert.equal(
    /immutable/.test(said),
    false,
    'шрифт под тем же именем не заменить у вернувшихся браузеров целый год',
  )
})

test('страница не кэшируется вовсе: за ней вся навигация', async () => {
  const seen = await fetch(`${base}/s/abc`)
  assert.equal(seen.headers.get('cache-control'), 'no-cache')
})

test('navigation HTML supplies the saved language and revalidates when it changes', async () => {
  const { setInstanceLanguage } = await import('../server/src/admin/settings.js')
  setInstanceLanguage('en')
  const english = await fetch(`${base}/s/abc`)
  assert.match(await english.text(), /name="colloq-language" content="en"/)
  assert.equal(english.headers.get('content-language'), 'en')
  const etag = english.headers.get('etag')!
  setInstanceLanguage('ru')
  const russian = await fetch(`${base}/s/abc`, { headers: { 'if-none-match': etag } })
  assert.equal(russian.status, 200)
  assert.match(await russian.text(), /name="colloq-language" content="ru"/)
  assert.notEqual(russian.headers.get('etag'), etag)
})
