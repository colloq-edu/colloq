import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { devFrontendReady } from '../cli/src/launch-readiness.js'

test('an HTML response cannot mark development ready when the real stylesheet fails', async () => {
  let cssStatus = 500
  const requested: string[] = []
  const server = http.createServer((req, res) => {
    requested.push(req.url ?? '')
    res.statusCode = req.url === '/src/index.css' ? cssStatus : 200
    res.end(req.url === '/src/index.css' ? 'stylesheet result' : '<html></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    await assert.rejects(devFrontendReady(url), /index.css/)
    cssStatus = 200
    assert.equal(await devFrontendReady(url), true)
    assert.deepEqual(requested, ['/', '/src/index.css', '/', '/src/index.css'])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
