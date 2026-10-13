import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer as createTlsServer } from 'node:https'
import { createRuntimeServer } from '../runtime/src/http.js'
import { HttpsKubernetesClient, KubernetesError, refusalOf } from '../runtime/src/kubernetes.js'
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
    // A live room gets only memory and cores: no environment, no image, no template.
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
    // Room memory ceiling: explicit from the operator, otherwise the node minus a gigabyte.
    assert.equal(loadRuntimeConfig(env, 73728).maxMemoryMb, 72704)
    assert.equal(loadRuntimeConfig({ ...env, RUNTIME_KERNEL_MEMORY_MAX: '16Gi' }, 73728).maxMemoryMb, 16384)
    // The default has to fit under the ceiling: otherwise every room without its
    // own number would violate the broker's policy.
    assert.throws(
      () => loadRuntimeConfig({ ...env, RUNTIME_KERNEL_MEMORY: '8Gi', RUNTIME_KERNEL_MEMORY_MAX: '4Gi' }),
      /exceeds/,
    )
    assert.throws(() => loadRuntimeConfig({ ...env, RUNTIME_KERNEL_MEMORY_MAX: '16G' }), /MAX/)
    // Node smaller than the default: the ceiling is not below the default, rather
    // than a refusal to start.
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
      // The API server's refusals of a Pod: a quota, a RuntimeClass, RBAC, a webhook, and a plain bad request.
      const refusals: Record<string, [number, string, string]> = {
        '/quota': [403, 'Forbidden', `pods "colloq-job-a" is forbidden: exceeded quota: gpu-${'secret-value'}, requested: requests.nvidia.com/gpu=1, used: requests.nvidia.com/gpu=2, limited: requests.nvidia.com/gpu=2`],
        '/runtimeclass': [403, 'Forbidden', 'pods "colloq-job-a" is forbidden: pod rejected: RuntimeClass "nvidia" not found'],
        '/rbac': [403, 'Forbidden', 'pods is forbidden: User "system:serviceaccount:colloq:colloq-runtime" cannot create resource "pods" in API group "" in the namespace "colloq"'],
        '/webhook': [400, 'BadRequest', 'admission webhook "validate.kyverno.svc-fail" denied the request: secret-value policy'],
        '/invalid': [422, 'Invalid', 'Pod "colloq-job-a" is invalid: spec.containers[0].image: Required value'],
      }
      if (refusals[req.url ?? '']) {
        const [code, reason, message] = refusals[req.url!]
        res.writeHead(code)
        res.end(JSON.stringify({ reason, message }))
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
    // Only the name of the resource that ran short gets out of the refusal body.
    await assert.rejects(
      client.request('PATCH', '/resize', {}, 'application/strategic-merge-patch+json'),
      (err: any) => err.insufficient === 'memory' && !err.message.includes('secret-value'),
    )
    // A node short of memory is that, not an admission policy.
    await assert.rejects(client.request('PATCH', '/resize', {}, 'application/strategic-merge-patch+json'), (err: any) => err.refusal === undefined)
    // Of a refusal only its kind leaves the body, and of a quota its resource names.
    for (const [path, refusal] of [
      ['/quota', { kind: 'quota', resources: ['requests.nvidia.com/gpu'] }],
      ['/runtimeclass', { kind: 'runtime-class' }],
      ['/rbac', { kind: 'permission' }],
      ['/webhook', { kind: 'admission' }],
      ['/invalid', undefined],
    ] as const)
      await assert.rejects(client.request('POST', path, {}), (err: any) =>
        err instanceof KubernetesError && JSON.stringify(err.refusal) === JSON.stringify(refusal) &&
          !err.message.includes('secret-value') && !err.message.includes('quota') && err.message.length < 250)
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

/*
 * The API server's "no" to a Pod, as the broker tells its kinds apart: a GPU
 * notebook refused for a quota, a RuntimeClass or a policy goes back to the
 * app's queue instead of failing as a metric (competition-jobs.ts ·
 * refusedAtAdmission), while the broker's own missing permission does not.
 */
test('refusals: a quota with its resource names, a missing RuntimeClass, RBAC, and admission of any other kind', () => {
  const quota = 'pods "colloq-job-a" is forbidden: exceeded quota: compute, requested: limits.memory=2Gi,requests.memory=2Gi,requests.nvidia.com/mig-1g.10gb=1, used: limits.memory=30Gi, limited: limits.memory=31Gi'
  assert.deepEqual(refusalOf(403, quota), { kind: 'quota', resources: ['limits.memory', 'requests.memory', 'requests.nvidia.com/mig-1g.10gb'] })
  // At most three names, whatever the quota lists.
  assert.equal(refusalOf(403, 'exceeded quota: q, requested: a/b=1,c/d=1,e/f=1,g/h=1, used: a/b=1')?.kind, 'quota')
  assert.deepEqual((refusalOf(403, 'exceeded quota: q, requested: a/b=1,c/d=1,e/f=1,g/h=1, used: a/b=1') as any).resources, ['a/b', 'c/d', 'e/f'])
  assert.deepEqual(refusalOf(403, 'pods "x" is forbidden: pod rejected: RuntimeClass "nvidia-cdi" not found'), { kind: 'runtime-class' })
  assert.deepEqual(refusalOf(403, 'pods is forbidden: User "system:serviceaccount:colloq:colloq-runtime" cannot create resource "pods" in API group ""'), { kind: 'permission' })
  // Pod Security, a LimitRange, a ValidatingAdmissionPolicy, a webhook with its own code, an empty body: admission.
  for (const message of ['pods "x" is forbidden: violates PodSecurity "restricted:latest": runAsNonRoot != true',
    'pods "x" is forbidden: maximum memory usage per Container is 4Gi, but limit is 8Gi', '', 'admission webhook "gatekeeper" denied the request: no GPUs here'])
    assert.deepEqual(refusalOf(403, message), { kind: 'admission' }, message)
  assert.deepEqual(refusalOf(422, 'pods "x" is forbidden: ValidatingAdmissionPolicy \'gpu\' with binding \'gpu\' denied request: no'), { kind: 'admission' })
  assert.deepEqual(refusalOf(400, 'admission webhook "validate.kyverno.svc-fail" denied the request: x'), { kind: 'admission' })
  // A request we built wrong, a conflict, a missing object: no refusal of that kind at all.
  assert.equal(refusalOf(422, 'Pod "x" is invalid: spec.containers[0].image: Required value'), undefined)
  assert.equal(refusalOf(400, 'the body of the request was in an unknown format'), undefined)
  assert.equal(refusalOf(409, 'pods "x" already exists'), undefined)
  assert.equal(refusalOf(404, 'namespaces "colloq" not found'), undefined)
})
