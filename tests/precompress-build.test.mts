import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { precompress } from '../web/scripts/precompress.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'colloq-precompress-'))
after(() => fs.rm(root, { recursive: true, force: true }))

test('optimized artifacts round-trip, retain originals and exclude already compressed files', async () => {
  await fs.mkdir(path.join(root, 'assets'))
  await fs.mkdir(path.join(root, 'pdf'))
  const original = Buffer.from('export const classroom = "interactive notebook";\n'.repeat(100))
  await fs.writeFile(path.join(root, 'assets/app.js'), original)
  await fs.writeFile(path.join(root, 'pdf/pdf.worker.min.mjs'), original)
  await fs.writeFile(path.join(root, 'assets/tiny.css'), 'body{}')
  await fs.writeFile(path.join(root, 'assets/image.png'), original)
  await fs.writeFile(path.join(root, 'index.html'), original)
  const report = await precompress(root)
  assert.equal(report.files, 2)
  for (const file of ['assets/app.js', 'pdf/pdf.worker.min.mjs']) {
    assert.deepEqual(await fs.readFile(path.join(root, file)), original)
    const br = await fs.readFile(path.join(root, file + '.br'))
    const gzip = await fs.readFile(path.join(root, file + '.gz'))
    assert.deepEqual(zlib.brotliDecompressSync(br), original)
    assert.deepEqual(zlib.gunzipSync(gzip), original)
    assert.ok(br.length < original.length)
  }
  for (const file of ['assets/tiny.css', 'assets/image.png', 'index.html']) {
    await assert.rejects(fs.stat(path.join(root, file + '.br')), { code: 'ENOENT' })
  }
  const again = await precompress(root)
  assert.deepEqual(again, report, 'encoding files must not be recursively compressed')
  await fs.writeFile(path.join(root, 'assets/app.js'), 'small')
  await precompress(root)
  await assert.rejects(fs.stat(path.join(root, 'assets/app.js.br')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(root, 'assets/app.js.gz')), { code: 'ENOENT' })
})
