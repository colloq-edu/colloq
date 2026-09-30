/**
 * Kernels on /metrics, through the real start path.
 *
 * The counters are one line each inside kernel/index.ts · ensureKernel, and
 * a line in the wrong branch counts a failure as a start or not at all. So a
 * room's kernel is started here against a fake broker (the same stand-in as
 * kernel-unschedulable.test.mts) that answers when told to: the census must
 * show the kernel `starting` while the broker thinks, and the failure must
 * land in the failure counter of the class's container, labelled with the
 * backend that failed.
 */
import './_env.mts'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { TEST_ROOT } from './_env.mts'
import { createSession } from '../server/src/db.js'
import { ensureKernel, kernelMetrics } from '../server/src/kernel/index.js'
import { renderMetrics } from '../server/src/ops/metrics.js'
import { counterValues } from '../server/src/ops/counters.js'

const digest = 'b'.repeat(64)
const catalog = {
  schemaVersion: 1,
  release: 'v1',
  defaultEnvironment: 'base',
  environments: [{ name: 'base', image: `registry.example/base@sha256:${digest}`, gpu: false }],
}
let release: (() => void) | null = null
let broker: http.Server
const saved = { ...process.env }

before(async () => {
  broker = http.createServer(async (req, res) => {
    for await (const _ of req) void _
    res.setHeader('content-type', 'application/json')
    if (req.method !== 'POST') return res.end(JSON.stringify({ ok: true }))
    // The start waits until the test lets it answer, then fails.
    await new Promise<void>((resolve) => (release = resolve))
    res.statusCode = 503
    res.end(JSON.stringify({ error: 'Room startup timed out: ErrImagePull' }))
  })
  await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve))
  const token = path.join(TEST_ROOT, 'broker-metrics-token')
  fs.writeFileSync(token, 'm'.repeat(64))
  const catalogFile = path.join(TEST_ROOT, 'broker-metrics-catalog.json')
  fs.writeFileSync(catalogFile, JSON.stringify(catalog))
  Object.assign(process.env, {
    KERNEL_BACKEND: 'broker',
    KERNEL_ISOLATION: 'required',
    KERNEL_RUNTIME_URL: `http://127.0.0.1:${(broker.address() as { port: number }).port}`,
    KERNEL_RUNTIME_TOKEN_FILE: token,
    KERNEL_CATALOG_FILE: catalogFile,
  })
})

after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  broker?.closeAllConnections()
  await new Promise<void>((resolve) => broker.close(() => resolve()))
})

function sample(text: string, line: string): number {
  const found = text.split('\n').find((l) => l.startsWith(`${line} `))
  assert.ok(found, `no ${line} in the exposition`)
  return Number(found.slice(line.length + 1))
}

test('a kernel being brought up is `starting`; a start that fails is counted for its container and backend', async () => {
  const before = counterValues()
  const beforeText = renderMetrics()
  createSession('metrics-kernel-room', 'Метрики ядра', 'base')

  const started = ensureKernel('metrics-kernel-room')
  started.catch(() => {})
  assert.equal(kernelMetrics().kernels.room.starting, 1)
  assert.equal(sample(renderMetrics(), 'colloq_kernels{backend="broker",role="room",state="starting"}'), 1)

  // Let the broker answer, and wait for the refusal to arrive.
  const waitForBroker = async () => {
    for (let i = 0; i < 500 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(release, 'the start never reached the broker')
    release()
  }
  await waitForBroker()
  await assert.rejects(started)

  const census = kernelMetrics()
  assert.equal(census.kernels.room.starting, 0)
  const later = counterValues()
  assert.equal(later.kernelStartFailures.room, before.kernelStartFailures.room + 1)
  assert.equal(later.kernelStarts.room, before.kernelStarts.room, 'a failed start was counted as a start')
  const text = renderMetrics()
  const failures = 'colloq_kernel_start_failures_total{backend="broker",role="room"}'
  assert.equal(sample(text, failures), sample(beforeText, failures) + 1)
  assert.equal(sample(text, 'colloq_kernels{backend="broker",role="room",state="starting"}'), 0)
  // The room is nowhere on the page.
  assert.doesNotMatch(text, /metrics-kernel-room/)
})
