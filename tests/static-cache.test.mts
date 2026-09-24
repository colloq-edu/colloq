/**
 * What may be cached for a year and what may not.
 *
 * Vite stamps a hash into the name of everything it builds and puts it in
 * `assets/`; everything else in dist comes from `web/public` as is, under the
 * name a person chose. Next to the directory check stood the regex "a hyphen
 * and eight characters" — and `hse-sans-400.woff2` fell under it
 * ("-sans-400"), although there is no hash there at all. The institute's font
 * went out with `immutable` for a year: replacing a face under the same name
 * and having returning browsers pick it up was impossible.
 *
 * STATIC_DIR is set BEFORE the app is imported: config reads the variables
 * when the module loads, which is why the app is pulled in dynamically here.
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
// A real name from web/public: a hyphen, "sans", a hyphen, "400" — eight
// characters, and the bundler chose none of them.
fs.writeFileSync(path.join(staticDir, 'fonts', 'hse-sans-400.woff2'), 'not really a font')
/*
 * A page the size of a real one, not two lines: the built index.html is 26 KB
 * (the Vite entry module inside), and on two lines neither gzip nor brotli
 * beats the source by a single byte — a "we serve it compressed" check on such
 * a page would check only zlib's arithmetic.
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

/** fetch unpacks Content-Encoding by itself, and here exactly those bytes matter. */
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

test('built files with a hash in the name are cached for a year', async () => {
  assert.equal(await cacheOf('/assets/index-UnEQhcxl.js'), 'public, max-age=31536000, immutable')
})

test('a font from public is not a versioned file, however many hyphens its name has', async () => {
  const said = await cacheOf('/fonts/hse-sans-400.woff2')
  assert.equal(said, 'public, max-age=3600')
  assert.equal(
    /immutable/.test(said),
    false,
    'a font under the same name could not be replaced in returning browsers for a whole year',
  )
})

test('the page is not cached at all: all navigation stands behind it', async () => {
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
 * The page is built once per deploy and language, not on every visit.
 *
 * Previously every navigation read index.html, spliced the language into it
 * and went into streaming brotli: 1.74 ms of CPU time per request at the
 * moment of the bell, when the whole group arrives at once. Now the bytes, the
 * ETag and both encodings lie ready (server/src/frontend-html.ts), and exactly
 * that is checked here — the build counter, not "it got faster".
 */
test('the same page is built once, not on every request', async () => {
  const { frontendPageBuilds } = await import('../server/src/frontend-html.js')
  const before = frontendPageBuilds()
  const first = await fetch(`${base}/s/abc`, { headers: { 'accept-encoding': 'br' } })
  const firstBody = Buffer.from(await first.arrayBuffer())
  const second = await fetch(`${base}/s/xyz`, { headers: { 'accept-encoding': 'br' } })
  assert.equal(frontendPageBuilds() - before, 0, 'the page was rebuilt on the second visit')
  assert.equal(first.headers.get('etag'), second.headers.get('etag'))
  assert.deepEqual(firstBody, Buffer.from(await second.arrayBuffer()))
})

test('ready bytes go to the socket as is, not through on-the-fly compression', async () => {
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
    // The length is declared: the whole response is known in advance, not
    // streamed out of zlib.
    assert.equal(response.headers['content-length'], String(response.body.length))
    assert.equal(decode(response.body).toString('utf8'), html)
    assert.ok(response.body.length < plain.body.length, `${encoding}: the body is not compressed`)
  }
})

test('a returning student gets a 304, not the page again', async () => {
  const { frontendPageBuilds } = await import('../server/src/frontend-html.js')
  const etag = (await fetch(`${base}/s/abc`)).headers.get('etag')!
  // A strong tag: express made it weak because it computed it on the fly and
  // did not know what it would send.
  assert.ok(!etag.startsWith('W/'), `expected a strong ETag, not ${etag}`)
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

test('a deploy invalidates the ready bytes: the file changed — the page is built again', async () => {
  const { frontendPageBuilds } = await import('../server/src/frontend-html.js')
  const was = (await fetch(`${base}/s/abc`)).headers.get('etag')
  const before = frontendPageBuilds()
  // Exactly what a deploy does: a new index.html in the same place. The key is
  // mtime and size, so both the contents and the length change.
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Colloq снова</title>')
  const now = await fetch(`${base}/s/abc`)
  assert.equal(frontendPageBuilds() - before, 1)
  assert.notEqual(now.headers.get('etag'), was)
  assert.match(await now.text(), /Colloq снова/)
})
