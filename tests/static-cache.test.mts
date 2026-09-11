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
import zlib from 'node:zlib'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-static-'))
fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true })
fs.mkdirSync(path.join(staticDir, 'fonts'), { recursive: true })
fs.writeFileSync(path.join(staticDir, 'assets', 'index-UnEQhcxl.js'), 'export default 1\n')
// Настоящее имя из web/public: дефис, «sans», дефис, «400» — восемь знаков,
// и ни одного из них не выбирал сборщик.
fs.writeFileSync(path.join(staticDir, 'fonts', 'hse-sans-400.woff2'), 'not really a font')
/*
 * Страница размером с настоящую, а не в две строки: собранный index.html —
 * это 26 КБ (входной модуль Vite внутри), и на двух строках ни gzip, ни brotli
 * не выигрывают у исходника ни байта — проверка «отдаём сжатое» на такой
 * странице проверяла бы только арифметику zlib.
 */
fs.writeFileSync(
  path.join(staticDir, 'index.html'),
  '<!doctype html><html lang="ru"><head><title>Colloq</title>' +
    '<script type="module" src="/assets/index-UnEQhcxl.js"></script>' +
    '<style>body{margin:0}</style></head><body><div id="app"></div>' +
    '<script>window.__colloq_entry__=1;/* '.repeat(20) +
    '*/</script></body></html>',
)
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

/** fetch распаковывает Content-Encoding сам, а здесь важны именно те байты. */
const raw = (p: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = http.request(`${base}${p}`, { headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () =>
        resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })

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

/*
 * Страница собирается один раз на выкладку и язык, а не на каждый вход.
 *
 * Раньше каждая навигация читала index.html, склеивала в него язык и уходила в
 * потоковый brotli: 1.74 мс процессорного времени на запрос там, где в момент
 * звонка приходит вся группа разом. Теперь байты, ETag и обе кодировки лежат
 * готовыми (server/src/frontend-html.ts), и проверяется здесь именно это —
 * счётчик сборок, а не «стало быстрее».
 */
test('одна и та же страница собирается однажды, а не на каждый запрос', async () => {
  const { frontendPageBuilds } = await import('../server/src/frontend-html.js')
  const before = frontendPageBuilds()
  const first = await fetch(`${base}/s/abc`, { headers: { 'accept-encoding': 'br' } })
  const firstBody = Buffer.from(await first.arrayBuffer())
  const second = await fetch(`${base}/s/xyz`, { headers: { 'accept-encoding': 'br' } })
  assert.equal(frontendPageBuilds() - before, 0, 'страницу пересобрали на втором входе')
  assert.equal(first.headers.get('etag'), second.headers.get('etag'))
  assert.deepEqual(firstBody, Buffer.from(await second.arrayBuffer()))
})

test('готовые байты уходят в сокет как есть, а не через сжатие на лету', async () => {
  const plain = await raw('/s/abc', { 'accept-encoding': 'identity' })
  assert.equal(plain.headers['content-encoding'], undefined)
  const html = plain.body.toString('utf8')
  for (const [encoding, decode] of [
    ['br', zlib.brotliDecompressSync],
    ['gzip', zlib.gunzipSync],
  ] as const) {
    const response = await raw('/s/abc', { 'accept-encoding': encoding })
    assert.equal(response.headers['content-encoding'], encoding)
    assert.equal(response.headers.vary, 'Accept-Encoding')
    // Длина объявлена: ответ целиком известен заранее, а не течёт из zlib.
    assert.equal(response.headers['content-length'], String(response.body.length))
    assert.equal(decode(response.body).toString('utf8'), html)
    assert.ok(response.body.length < plain.body.length, `${encoding}: тело не сжато`)
  }
})

test('вернувшемуся студенту отдаётся 304, а не страница заново', async () => {
  const { frontendPageBuilds } = await import('../server/src/frontend-html.js')
  const etag = (await fetch(`${base}/s/abc`)).headers.get('etag')!
  // Сильный тег: слабым его делал express, потому что считал на лету и не знал,
  // что отдаст.
  assert.ok(!etag.startsWith('W/'), `ожидался сильный ETag, а не ${etag}`)
  const before = frontendPageBuilds()
  for (const sent of [etag, `W/${etag}`, `"other-build", ${etag}`, '*']) {
    const again = await raw('/s/abc', { 'if-none-match': sent })
    assert.equal(again.status, 304, `If-None-Match: ${sent}`)
    assert.equal(again.body.length, 0)
    assert.equal(again.headers['cache-control'], 'no-cache')
    assert.equal(again.headers.etag, etag)
  }
  assert.equal(frontendPageBuilds() - before, 0)
  const other = await raw('/s/abc', { 'if-none-match': '"other-build"' })
  assert.equal(other.status, 200)
})

test('выкладка отменяет готовые байты: файл изменился — страница собирается заново', async () => {
  const { frontendPageBuilds } = await import('../server/src/frontend-html.js')
  const was = (await fetch(`${base}/s/abc`)).headers.get('etag')
  const before = frontendPageBuilds()
  // Ровно то, что делает выкладка: новый index.html на том же месте. Ключ —
  // mtime и размер, поэтому меняется и содержимое, и длина.
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Colloq снова</title>')
  const now = await fetch(`${base}/s/abc`)
  assert.equal(frontendPageBuilds() - before, 1)
  assert.notEqual(now.headers.get('etag'), was)
  assert.match(await now.text(), /Colloq снова/)
})
