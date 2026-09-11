import './_env.mts'
import { TEST_ROOT } from './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import zlib from 'node:zlib'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'

const root = path.join(TEST_ROOT, 'static')
fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
fs.mkdirSync(path.join(root, 'pdf'), { recursive: true })
const source = Buffer.from('export const answer = "classroom";\n'.repeat(100))
const br = zlib.brotliCompressSync(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
const gz = zlib.gzipSync(source, { level: 9 })
fs.writeFileSync(path.join(root, 'assets/app-hash.js'), source)
fs.writeFileSync(path.join(root, 'assets/app-hash.js.br'), br)
fs.writeFileSync(path.join(root, 'assets/app-hash.js.gz'), gz)
fs.writeFileSync(path.join(root, 'assets/plain.js'), source)
fs.writeFileSync(path.join(root, 'pdf/pdf.worker.min.mjs'), source)
fs.writeFileSync(path.join(root, 'pdf/pdf.worker.min.mjs.br'), br)
fs.writeFileSync(path.join(root, 'index.html'), '<title>Colloq</title>')
process.env.STATIC_DIR = root
let server: http.Server
let base = ''
before(async () => {
  const { app } = await import('../server/src/app.js')
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(() => server.close())

function get(url = '/assets/app-hash.js', headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = http.request(base + url, { headers, method }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

test('Brotli artifact is served as JavaScript without recompression', async () => {
  const response = await get(undefined, { 'accept-encoding': 'gzip, br' })
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-encoding'], 'br')
  assert.equal(response.headers['content-length'], String(br.length))
  assert.match(response.headers['content-type'] ?? '', /javascript/)
  assert.match(response.headers.vary ?? '', /Accept-Encoding/i)
  assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.deepEqual(response.body, br)
  assert.deepEqual(zlib.brotliDecompressSync(response.body), source)
})

test('encoding preferences and explicit refusals are respected', async () => {
  for (const offered of ['gzip', 'br;q=0, gzip', 'gzip;q=1, br;q=0.5']) {
    const response = await get(undefined, { 'accept-encoding': offered })
    assert.equal(response.headers['content-encoding'], 'gzip')
    assert.deepEqual(response.body, gz)
  }
  const plain = await get(undefined, { 'accept-encoding': 'identity' })
  assert.equal(plain.headers['content-encoding'], undefined)
  assert.deepEqual(plain.body, source)
})

test('HEAD and validators describe the selected encoded representation', async () => {
  const first = await get(undefined, { 'accept-encoding': 'br' })
  const head = await get(undefined, { 'accept-encoding': 'br' }, 'HEAD')
  assert.equal(head.headers['content-encoding'], 'br')
  assert.equal(head.headers['content-length'], String(br.length))
  assert.equal(head.body.length, 0)
  const cached = await get(undefined, { 'accept-encoding': 'br', 'if-none-match': first.headers.etag! })
  assert.equal(cached.status, 304)
  assert.equal(cached.body.length, 0)
})

test('ranges and ordinary builds retain the existing delivery path', async () => {
  const ranged = await get(undefined, { 'accept-encoding': 'br', range: 'bytes=0-9' })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers['content-encoding'], undefined)
  assert.deepEqual(ranged.body, source.subarray(0, 10))
  const ordinary = await get('/assets/plain.js', { 'accept-encoding': 'br' })
  assert.deepEqual(zlib.brotliDecompressSync(ordinary.body), source)
})

test('unversioned PDF worker keeps short caching and HTML keeps revalidation', async () => {
  const worker = await get('/pdf/pdf.worker.min.mjs', { 'accept-encoding': 'br' })
  assert.deepEqual(worker.body, br)
  assert.equal(worker.headers['cache-control'], 'public, max-age=3600')
  const html = await get('/s/room', { 'accept-encoding': 'br' })
  assert.equal(html.headers['cache-control'], 'no-cache')
})

test('missing or stale sidecars fall back without serving an outdated build', async () => {
  const file = path.join(root, 'assets/stale.js')
  fs.writeFileSync(file, source)
  fs.writeFileSync(file + '.br', br)
  fs.utimesSync(file + '.br', new Date(0), new Date(0))
  const response = await get('/assets/stale.js', { 'accept-encoding': 'br' })
  assert.deepEqual(zlib.brotliDecompressSync(response.body), source)
  assert.equal(response.headers['content-length'], undefined, 'stale artifact was served')
  fs.writeFileSync(path.join(root, 'assets/gzip-only.js'), source)
  fs.writeFileSync(path.join(root, 'assets/gzip-only.js.gz'), gz)
  const fallback = await get('/assets/gzip-only.js', { 'accept-encoding': 'br, gzip' })
  assert.equal(fallback.headers['content-encoding'], 'gzip')
  assert.deepEqual(fallback.body, gz)
})
