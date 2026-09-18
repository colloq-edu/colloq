import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer as createTlsServer } from 'node:https'
import { createRuntimeServer } from '../runtime/src/http.js'
import { HttpsKubernetesClient } from '../runtime/src/kubernetes.js'
import { loadRuntimeConfig, readStrongSecret } from '../runtime/src/config.js'
import { parseRuntimeCatalog } from '../shared/runtime.js'

const catalog = parseRuntimeCatalog({
  schemaVersion: 1,
  release: 'v1',
  defaultEnvironment: 'base',
  environments: [
    { name: 'base', image: `registry.example/base@sha256:${'a'.repeat(64)}`, gpu: false },
  ],
})
test('private API authenticates every route and accepts only bounded room intent', async () => {
  const secret = randomBytes(32).toString('hex')
  const calls: string[] = []
  const server = createRuntimeServer({
    token: () => secret,
    catalog: () => catalog,
    controller: {
      health: async () => ({ ok: true, reason: null }),
      list: async () => [],
      ensure: async (id, request) => {
        calls.push(id)
        return {
          url: 'http://room:8888',
          token: 'private',
          instanceId: 'uid',
          environment: request.environment,
          revision: 'sha256:' + 'a'.repeat(64),
        }
      },
      remove: async (id) => {
        calls.push(id)
      },
      resize: async (id, request) => {
        calls.push(`${id}:${request.memoryMb}:${request.cpus}`)
        return {
          outcome: 'applied',
          ...(request.memoryMb !== undefined ? { memoryMb: request.memoryMb ?? 2048 } : {}),
          ...(request.cpus !== undefined ? { cpus: request.cpus ?? 2 } : {}),
        }
      },
    },
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }
  try {
    for (const path of ['/v1/health', '/v1/catalog', '/v1/rooms'])
      assert.equal((await fetch(base + path)).status, 401)
    assert.equal(
      (await fetch(base + '/v1/health', { headers: { Authorization: 'Bearer wrong' } })).status,
      401,
    )
    assert.deepEqual(await (await fetch(base + '/v1/catalog', { headers })).json(), catalog)
    assert.equal(
      (
        await fetch(base + '/v1/rooms/roomA', {
          method: 'POST',
          headers,
          body: JSON.stringify({ environment: 'base', image: 'evil' }),
        })
      ).status,
      400,
    )
    assert.equal(
      (await fetch(base + '/v1/rooms/roomA', { method: 'POST', headers, body: 'x'.repeat(5000) }))
        .status,
      413,
    )
    assert.equal(
      (await fetch(base + '/v1/rooms/a%2fb', { method: 'POST', headers, body: '{}' })).status,
      400,
    )
    assert.equal(calls.length, 0)
    assert.equal(
      (
        await fetch(base + '/v1/rooms/roomA', {
          method: 'POST',
          headers,
          body: JSON.stringify({ environment: 'base' }),
        })
      ).status,
      200,
    )
    assert.deepEqual(
      await (await fetch(base + '/v1/rooms/roomA', { method: 'DELETE', headers })).json(),
      { ok: true },
    )
    // Живой комнате — только память и ядра: ни окружения, ни образа, ни шаблона.
    for (const body of [
      '{}',
      '{"memoryMb":4096,"environment":"base"}',
      '{"cpus":4,"image":"evil"}',
      '{"memoryMb":"4Gi"}',
      '{"memoryMb":4096.5}',
      '{"cpus":1.5}',
      '{"cpus":"4"}',
    ])
      assert.equal(
        (await fetch(base + '/v1/rooms/roomA', { method: 'PATCH', headers, body })).status,
        400,
        body,
      )
    assert.equal(
      (await fetch(base + '/v1/rooms/roomA', { method: 'PATCH', body: '{"memoryMb":4096}' })).status,
      401,
    )
    assert.deepEqual(
      await (
        await fetch(base + '/v1/rooms/roomA', { method: 'PATCH', headers, body: '{"memoryMb":4096}' })
      ).json(),
      { outcome: 'applied', memoryMb: 4096 },
    )
    assert.deepEqual(
      await (
        await fetch(base + '/v1/rooms/roomA', { method: 'PATCH', headers, body: '{"cpus":6}' })
      ).json(),
      { outcome: 'applied', cpus: 6 },
    )
    assert.deepEqual(calls, ['roomA', 'roomA', 'roomA:4096:undefined', 'roomA:undefined:6'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())))
  }
})

test('configuration fails closed on absent or weak secrets and invalid resource limits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-config-'))
  try {
    const token = join(dir, 'token')
    writeFileSync(token, 'dev-token')
    assert.throws(() => readStrongSecret(token), /32|strong|secret/i)
    assert.throws(() => loadRuntimeConfig({}), /RUNTIME_TOKEN_FILE/)
    writeFileSync(token, randomBytes(32).toString('hex'))
    const env = {
      RUNTIME_TOKEN_FILE: token,
      RUNTIME_ROOM_SECRET_FILE: token,
      RUNTIME_CATALOG_FILE: join(dir, 'catalog'),
    }
    writeFileSync(env.RUNTIME_CATALOG_FILE, JSON.stringify(catalog))
    assert.equal(loadRuntimeConfig(env).port, 8787)
    assert.throws(() => loadRuntimeConfig({ ...env, RUNTIME_KERNEL_CPU: 'Infinity' }))
    assert.throws(() => loadRuntimeConfig({ ...env, RUNTIME_KERNEL_MEMORY: '0Gi' }))
    assert.throws(() => loadRuntimeConfig({ ...env, RUNTIME_KUBE_URL: 'http://localhost' }))
    // Потолок памяти комнаты: явный у оператора, иначе узел минус гигабайт.
    assert.equal(loadRuntimeConfig(env, 73728).maxMemoryMb, 72704)
    assert.equal(loadRuntimeConfig({ ...env, RUNTIME_KERNEL_MEMORY_MAX: '16Gi' }, 73728).maxMemoryMb, 16384)
    // Умолчание обязано влезать под потолок: иначе каждая комната без своего
    // числа нарушала бы политику брокера.
    assert.throws(
      () => loadRuntimeConfig({ ...env, RUNTIME_KERNEL_MEMORY: '8Gi', RUNTIME_KERNEL_MEMORY_MAX: '4Gi' }),
      /exceeds/,
    )
    assert.throws(() => loadRuntimeConfig({ ...env, RUNTIME_KERNEL_MEMORY_MAX: '16G' }), /MAX/)
    // Узел меньше умолчания — потолок не ниже умолчания, а не отказ стартовать.
    assert.equal(loadRuntimeConfig(env, 1024).maxMemoryMb, 2048)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Kubernetes HTTPS client verifies CA, rereads rotating token, and bounds response errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-tls-'))
  const key = join(dir, 'key.pem'),
    cert = join(dir, 'cert.pem'),
    token = join(dir, 'token')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    { stdio: 'ignore' },
  )
  const auth: string[] = []
  const server = createTlsServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (req, res) => {
      auth.push(req.headers.authorization ?? '')
      if (req.url === '/denied') {
        res.writeHead(403)
        res.end(JSON.stringify({ reason: 'Forbidden', message: 'secret-value'.repeat(1000) }))
        return
      }
      if (req.url === '/resize') {
        res.writeHead(403)
        res.end(JSON.stringify({ reason: 'Forbidden', message:
          `pods "x" is forbidden: node didn't have enough allocatable resources: memory, requested: 1, allocatable: 0 ${'secret-value'.repeat(10)}` }))
        return
      }
      if (req.url === '/huge') {
        res.end('x'.repeat(3000))
        return
      }
      res.end(JSON.stringify({ ok: true }))
    },
  )
  await new Promise<void>((r) => server.listen(0, 'localhost', r))
  try {
    const url = `https://localhost:${(server.address() as any).port}`
    writeFileSync(token, 'first-projected-token')
    const client = new HttpsKubernetesClient({
      url,
      tokenFile: token,
      caFile: cert,
      maxResponseBytes: 2048,
    })
    assert.deepEqual(await client.request('GET', '/ready'), { ok: true })
    writeFileSync(token, 'rotated-projected-token')
    await client.request('GET', '/ready')
    assert.deepEqual(auth, ['Bearer first-projected-token', 'Bearer rotated-projected-token'])
    await assert.rejects(
      client.request('GET', '/denied'),
      (err) =>
        err instanceof Error && err.message.length < 250 && !err.message.includes('secret-value'),
    )
    // Из тела отказа наружу выходит только имя ресурса, которого не хватило.
    await assert.rejects(
      client.request('PATCH', '/resize', {}, 'application/strategic-merge-patch+json'),
      (err: any) => err.insufficient === 'memory' && !err.message.includes('secret-value'),
    )
    await assert.rejects(client.request('PATCH', '/resize', {}, 'text/x-evil'), /content type/)
    await assert.rejects(client.request('GET', '/huge'), /large|limit/i)
    writeFileSync(cert, '')
    await assert.rejects(client.request('GET', '/ready'), /self.signed|certificate|issuer/i)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())))
    rmSync(dir, { recursive: true, force: true })
  }
})
