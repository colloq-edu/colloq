import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import { config } from '../server/src/config.js'
import { app } from '../server/src/app.js'
import { workspaceFs } from '../server/src/workspace.js'

test('readiness requires working workspace access even when the database and kernel are healthy', async (t) => {
  const jupyter = http.createServer((_req, res) => { res.end('{}') })
  const server = http.createServer(app)
  await new Promise<void>(resolve => jupyter.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const oldUrl = config.jupyter.url
  config.jupyter.url = `http://127.0.0.1:${(jupyter.address() as { port: number }).port}`
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    // A fresh workspace must be usable without a room having created it first.
    const healthy = await fetch(`${base}/api/health`)
    assert.equal(healthy.status, 200)
    assert.equal((await healthy.json()).workspace, true)

    // Reproduce the native platform refusal at the filesystem boundary.
    const refusal = t.mock.method(workspaceFs, 'mkdirSync', () => {
      throw new Error('Linux descriptor traversal is required; unsafe development fallback must be explicitly enabled')
    })
    const broken = await fetch(`${base}/api/health`)
    assert.equal(broken.status, 503)
    const state = await broken.json()
    assert.equal(state.database, true)
    assert.equal(state.kernel, true)
    assert.equal(state.workspace, false)
    assert.match(state.reason, /Linux descriptor traversal/)
    assert.equal((await fetch(`${base}/api/livez`)).status, 200)
    refusal.mock.restore()

    // Real filesystem failure must also fail readiness, without cached success.
    workspaceFs.close()
    fs.rmdirSync(config.workspaceDir)
    fs.writeFileSync(config.workspaceDir, 'not a directory')
    assert.equal((await fetch(`${base}/api/health`)).status, 503)
    fs.unlinkSync(config.workspaceDir)
    assert.equal((await fetch(`${base}/api/health`)).status, 200)
  } finally {
    config.jupyter.url = oldUrl
    server.closeAllConnections(); jupyter.closeAllConnections()
    await Promise.all([server, jupyter].map(s => new Promise<void>(resolve => s.close(() => resolve()))))
  }
})
