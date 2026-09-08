import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { TEST_ROOT } from './_env.mts'
import { sweepIdleKernels, shutdownSession } from '../server/src/kernel/index.js'

test('failed broker census is contained, concurrent sweeps coalesce, and the next sweep retries', async () => {
  const old = { ...process.env },
    warnings: string[] = []
  const warn = console.warn
  let fail = true,
    requests = 0
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/rooms')
    requests++
    res.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(fail ? { error: 'private-marker-do-not-log' } : { rooms: [] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const token = path.join(TEST_ROOT, 'census-token')
  fs.writeFileSync(token, 't'.repeat(64))
  Object.assign(process.env, {
    KERNEL_BACKEND: 'broker',
    KERNEL_ISOLATION: 'required',
    KERNEL_RUNTIME_URL: `http://127.0.0.1:${(server.address() as any).port}`,
    KERNEL_RUNTIME_TOKEN_FILE: token,
  })
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(' '))
  }
  try {
    await assert.doesNotReject(Promise.all([sweepIdleKernels(), sweepIdleKernels()]))
    assert.equal(requests, 1)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /idle sweep|census/i)
    assert.equal(warnings[0].includes('private-marker-do-not-log'), false)
    fail = false
    await sweepIdleKernels()
    assert.equal(requests, 2, 'a failed sweep must release the in-flight slot')
  } finally {
    console.warn = warn
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]
    Object.assign(process.env, old)
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('shutdown propagates failed broker termination so callers cannot delete a still-writing room', async () => {
  const old = { ...process.env }
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'DELETE')
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'termination pending' }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const token = path.join(TEST_ROOT, 'shutdown-token')
  fs.writeFileSync(token, 't'.repeat(64))
  Object.assign(process.env, {
    KERNEL_BACKEND: 'broker',
    KERNEL_ISOLATION: 'required',
    KERNEL_RUNTIME_URL: `http://127.0.0.1:${(server.address() as any).port}`,
    KERNEL_RUNTIME_TOKEN_FILE: token,
  })
  try {
    await assert.rejects(shutdownSession('failed-termination'), /termination pending/)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]
    Object.assign(process.env, old)
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
