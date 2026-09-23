import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createExportServer } from '../runtime/src/export-sidecar.ts'

async function fixture(run: (url: string, out: string, result: string) => Promise<void>, kind?: 'resolve' | 'verify' | 'notebook', maxBytes?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-export-'))
  const out = path.join(root, 'out'); const result = path.join(root, 'result')
  fs.mkdirSync(out); fs.mkdirSync(result)
  const server = createExportServer({ source: out, destination: result, token: 'secret-token', kind, maxBytes })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try { await run(`http://127.0.0.1:${address.port}`, out, result) }
  finally { server.close(); await once(server, 'close'); fs.rmSync(root, { recursive: true, force: true }) }
}
const post = (url: string, body: unknown, token = 'secret-token') => fetch(url + '/collect', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('exporter authenticates progress reads and bounds malformed progress', async () => fixture(async (url, out) => {
  fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify({ state: 'running', percent: 37 }))
  assert.equal((await fetch(url + '/status')).status, 401)
  const response = await fetch(url + '/status', { headers: { authorization: 'Bearer secret-token' } })
  assert.deepEqual(await response.json(), { progress: { state: 'running', percent: 37 } })
  fs.writeFileSync(path.join(out, 'progress.json'), 'x'.repeat(65537))
  assert.equal((await fetch(url + '/status', { headers: { authorization: 'Bearer secret-token' } })).status, 413)
}))

test('exporter copies only bounded regular notebook outputs once with hashes', async () => fixture(async (url, out, result) => {
  fs.writeFileSync(path.join(out, 'run.json'), '{}')
  fs.writeFileSync(path.join(out, 'submission.csv'), 'id,y\n1,2\n')
  const response = await post(url, { kind: 'notebook', targetBytes: 1024 })
  assert.equal(response.status, 200, await response.clone().text())
  const report = await response.json() as any
  assert.deepEqual(report.files.map((file: any) => file.name), ['run.json', 'submission.csv'])
  assert.equal(report.totalBytes, 11)
  assert.equal(report.files[0].sha256, '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
  assert.equal(fs.readFileSync(path.join(result, 'submission.csv'), 'utf8'), 'id,y\n1,2\n')
  const retried = await post(url, { kind: 'notebook', targetBytes: 1024 })
  assert.equal(retried.status, 200)
  assert.deepEqual(await retried.json(), report)
  assert.equal((await post(url, { kind: 'metric', targetBytes: 1024 })).status, 409)
}))

test('exporter rejects unexpected files, symlinks, and totals over the requested cap', async () => {
  await fixture(async (url, out, result) => {
    fs.writeFileSync(path.join(out, 'score.json'), '{}')
    fs.writeFileSync(path.join(out, 'secret.txt'), 'no')
    assert.equal((await post(url, { kind: 'metric', targetBytes: 1024 })).status, 400)
    assert.deepEqual(fs.readdirSync(result), [])
  })
  await fixture(async (url, out, result) => {
    fs.symlinkSync('/etc/passwd', path.join(out, 'score.json'))
    assert.equal((await post(url, { kind: 'metric', targetBytes: 1024 })).status, 400)
    assert.deepEqual(fs.readdirSync(result), [])
  })
  await fixture(async (url, out, result) => {
    fs.writeFileSync(path.join(out, 'score.json'), '{}')
    assert.equal((await post(url, { kind: 'metric', targetBytes: 1 })).status, 413)
    assert.deepEqual(fs.readdirSync(result), [])
  })
})

test('resolver wheel export preserves only safe wheel names below aggregate cap', async () => fixture(async (url, out, result) => {
  fs.mkdirSync(path.join(out, 'wheels'))
  fs.writeFileSync(path.join(out, 'resolved.json'), '{}')
  fs.writeFileSync(path.join(out, 'wheels', 'demo-1.0-py3-none-any.whl'), 'wheel')
  const response = await post(url, { kind: 'resolve', targetBytes: 100 })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(fs.readFileSync(path.join(result, 'wheels', 'demo-1.0-py3-none-any.whl'), 'utf8'), 'wheel')
}, 'resolve'))

test('resolver status exposes only the latest bounded progress event', async () => fixture(async (url, out) => {
  fs.writeFileSync(path.join(out, 'progress.ndjson'), `${'x'.repeat(70_000)}\n{"state":"downloading","downloadBytes":27}\n`)
  const response = await fetch(url + '/status', { headers: { authorization: 'Bearer secret-token' } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { progress: { phase: 'resolve', cell: 0, cells: 0, outputBytes: 27 } })
}, 'resolve'))

test('notebook submission keeps its own byte cap while aggregate export includes reports', async () => fixture(async (url, out, result) => {
  fs.writeFileSync(path.join(out, 'run.json'), '{}')
  fs.writeFileSync(path.join(out, 'submission.csv'), '1234')
  assert.equal((await post(url, { kind: 'notebook', targetBytes: 4 })).status, 200)
  assert.equal(fs.readFileSync(path.join(result, 'submission.csv'), 'utf8'), '1234')
}, 'notebook', 4))

test('notebook refuses a submission larger than its own cap', async () => fixture(async (url, out, result) => {
  fs.writeFileSync(path.join(out, 'run.json'), '{}')
  fs.writeFileSync(path.join(out, 'submission.csv'), '12345')
  assert.equal((await post(url, { kind: 'notebook', targetBytes: 4 })).status, 413)
  assert.deepEqual(fs.readdirSync(result), [])
}, 'notebook', 4))

test('resolver accepts 256 bounded wheel files and refuses a 257th', async () => {
  await fixture(async (url, out) => {
    const wheels = path.join(out, 'wheels'); fs.mkdirSync(wheels)
    fs.writeFileSync(path.join(out, 'resolved.json'), '{}')
    for (let index = 0; index < 256; index++) fs.writeFileSync(path.join(wheels, `pkg${index}-1-py3-none-any.whl`), 'x')
    const response = await post(url, { kind: 'resolve', targetBytes: 256 })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(((await response.json()) as any).files.length, 257)
  }, 'resolve', 256)
  await fixture(async (url, out, result) => {
    const wheels = path.join(out, 'wheels'); fs.mkdirSync(wheels)
    fs.writeFileSync(path.join(out, 'resolved.json'), '{}')
    for (let index = 0; index < 257; index++) fs.writeFileSync(path.join(wheels, `pkg${index}-1-py3-none-any.whl`), 'x')
    assert.equal((await post(url, { kind: 'resolve', targetBytes: 257 })).status, 413)
    assert.deepEqual(fs.readdirSync(result), [])
  }, 'resolve', 257)
})

test('resolver rejects wheels over the primary download cap despite manifest headroom', async () => fixture(async (url, out, result) => {
  const wheels = path.join(out, 'wheels'); fs.mkdirSync(wheels)
  fs.writeFileSync(path.join(out, 'resolved.json'), '{}')
  fs.writeFileSync(path.join(wheels, 'pkg-1-py3-none-any.whl'), '12345')
  assert.equal((await post(url, { kind: 'resolve', targetBytes: 4 })).status, 413)
  assert.deepEqual(fs.readdirSync(result), [])
}, 'resolve', 4))

test('failed resolver can export bounded progress without a resolved manifest', async () => fixture(async (url, out, result) => {
  fs.writeFileSync(path.join(out, 'progress.ndjson'), '{"error":"download failed"}\n')
  assert.equal((await post(url, { kind: 'resolve', targetBytes: 1024 })).status, 400)
  assert.equal((await post(url, { kind: 'resolve', targetBytes: 1024, allowIncomplete: true })).status, 200)
  assert.equal(fs.existsSync(path.join(result, 'progress.ndjson')), true)
}, 'resolve'))

test('failed main can collect an empty allowlisted result idempotently', async () => fixture(async (url, _out, result) => {
  const request = { kind: 'metric', targetBytes: 1024, allowIncomplete: true }
  const first = await post(url, request)
  assert.equal(first.status, 200, await first.clone().text())
  assert.deepEqual(await first.json(), { files: [], totalBytes: 0 })
  const second = await post(url, request)
  assert.equal(second.status, 200)
  assert.deepEqual(await second.json(), { files: [], totalBytes: 0 })
  assert.equal((await post(url, { kind: 'metric', targetBytes: 1024 })).status, 409)
  assert.deepEqual(fs.readdirSync(result), [])
}))

test('resolver rejects wheel names outside the shared artifact grammar', async () => fixture(async (url, out, result) => {
  const wheels = path.join(out, 'wheels'); fs.mkdirSync(wheels)
  fs.writeFileSync(path.join(out, 'resolved.json'), '{}')
  fs.writeFileSync(path.join(wheels, '!bad-1-py3-none-any.whl'), 'x')
  assert.equal((await post(url, { kind: 'resolve', targetBytes: 1024 })).status, 400)
  assert.deepEqual(fs.readdirSync(result), [])
}, 'resolve'))
