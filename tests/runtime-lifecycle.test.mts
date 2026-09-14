import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { RuntimeController, roomName } from '../runtime/src/controller.js'
import {
  KubernetesError,
  type KubernetesClient,
  type KubeObject,
} from '../runtime/src/kubernetes.js'
import { parseRuntimeCatalog } from '../shared/runtime.js'
import { createRuntimeServer } from '../runtime/src/http.js'

const digest = 'a'.repeat(64)
const catalog = parseRuntimeCatalog({
  schemaVersion: 1,
  release: 'v1',
  defaultEnvironment: 'base',
  environments: [
    { name: 'base', image: `registry.example/base@sha256:${digest}`, gpu: false },
    { name: 'gpu', image: `registry.example/gpu@sha256:${digest}`, gpu: true },
  ],
})
class FakeKube implements KubernetesClient {
  objects = new Map<string, KubeObject>()
  creates: KubeObject[] = []
  deletes: { path: string; body: any }[] = []
  sequence = 0
  failure = 0
  delayedDeletion = false
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.failure) throw new KubernetesError(this.failure, 'Forbidden')
    if (method === 'POST') {
      const object = structuredClone(body) as KubeObject
      const key = `${path}/${object.metadata.name}`
      if (this.objects.has(key)) throw new KubernetesError(409, 'AlreadyExists')
      object.metadata.uid = `uid-${++this.sequence}`
      if (object.kind === 'Service' && object.spec.clusterIP === 'None')
        Object.assign(object.spec, {clusterIPs:['None'],ipFamilies:object.spec.ipFamilies??['IPv4','IPv6'],ipFamilyPolicy:object.spec.ipFamilyPolicy??'RequireDualStack'})
      object.status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] }
      this.objects.set(key, object)
      this.creates.push(object)
      return structuredClone(object) as T
    }
    if (method === 'DELETE') {
      const object = this.objects.get(path)
      if (!object) throw new KubernetesError(404, 'NotFound')
      assert.equal((body as any).preconditions.uid, object.metadata.uid)
      this.deletes.push({ path, body })
      if (this.delayedDeletion && path.includes('/pods/'))
        object.metadata.deletionTimestamp = new Date().toISOString()
      else this.objects.delete(path)
      return {} as T
    }
    if (path.includes('?'))
      return {
        items: [...this.objects]
          .filter(([key]) => key.startsWith(path.split('?')[0] + '/'))
          .map(([, obj]) => structuredClone(obj)),
      } as T
    const object = this.objects.get(path)
    if (!object) throw new KubernetesError(404, 'NotFound')
    return structuredClone(object) as T
  }
}
const config = {
  namespace: 'colloq',
  workspaceClaim: 'colloq-workspace',
  memory: '2Gi',
  cpu: '2',
  ephemeral: '2Gi',
}
function setup(probe: () => Promise<boolean> = async () => true) {
  const kube = new FakeKube()
  const runtime = new RuntimeController({
    kube,
    config,
    catalog: () => catalog,
    roomSecret: () => 'secret'.repeat(16),
    probe,
    pollMs: 1,
    startupTimeoutMs: 1000,
    deletionTimeoutMs: 1000,
  })
  return { kube, runtime }
}

test('concurrent room ensure creates one isolated fixed workload and distinct rooms get distinct credentials', async () => {
  const { kube, runtime } = setup()
  const [a, b] = await Promise.all([
    runtime.ensure('roomA', { environment: 'base' }),
    runtime.ensure('roomA', { environment: 'base' }),
  ])
  assert.deepEqual(a, b)
  assert.equal(kube.creates.filter((o) => o.kind === 'Pod').length, 1)
  const pod = kube.creates.find((o) => o.kind === 'Pod')!
  assert.equal(pod.spec.automountServiceAccountToken, false)
  assert.equal(pod.spec.restartPolicy, 'Never')
  assert.equal(pod.spec.securityContext.runAsUser, 1000)
  assert.equal(pod.spec.containers[0].securityContext.allowPrivilegeEscalation, false)
  assert.deepEqual(pod.spec.containers[0].securityContext.capabilities.drop, ['ALL'])
  assert.equal(
    pod.spec.containers[0].volumeMounts.find((m: any) => m.name === 'workspace').subPath,
    'roomA',
  )
  assert.equal(pod.spec.volumes.filter((v: any) => v.persistentVolumeClaim).length, 1)
  assert.equal(
    pod.spec.volumes.some((v: any) => v.hostPath || v.secret || v.projected),
    false,
  )
  const c = await runtime.ensure('roomB', { environment: 'base' })
  assert.notEqual(c.token, a.token)
  assert.notEqual(c.instanceId, a.instanceId)
  assert.equal(a.revision, `sha256:${digest}`)
  assert.equal((await runtime.list()).length, 2)
})

test('GPU is one explicit device and runtime class, never a host mount', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('gpuRoom', { environment: 'gpu' })
  const pod = kube.creates.find((o) => o.kind === 'Pod')!
  assert.equal(pod.spec.runtimeClassName, 'nvidia')
  assert.equal(pod.spec.containers[0].resources.limits['nvidia.com/gpu'], 1)
})

test('room CPU intent sets quota and threads and resets to the runtime default', async () => {
  const { kube, runtime } = setup()
  const first = await runtime.ensure('cpuRoom', { environment: 'base', cpus: 6 })
  const kernel = kube.creates.find((o) => o.kind === 'Pod')!.spec.containers[0]
  assert.equal(kernel.resources.requests.cpu, '6')
  assert.equal(kernel.resources.limits.cpu, '6')
  assert.equal((await runtime.list()).find((room) => room.sessionId === 'cpuRoom')?.cpus, 6)
  for (const name of ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS'])
    assert.equal(kernel.env.find((entry: any) => entry.name === name).value, '6')
  assert.equal((await runtime.ensure('cpuRoom', { environment: 'base', cpus: 6 })).instanceId, first.instanceId)
  const reset = await runtime.ensure('cpuRoom', { environment: 'base' })
  assert.notEqual(reset.instanceId, first.instanceId)
  const replacement = kube.creates.filter((o) => o.kind === 'Pod').at(-1)!
  assert.equal(replacement.spec.containers[0].resources.limits.cpu, '2')
})

test('delete invalidates an in-flight ensure, removes its resources, and later ensure gets a new incarnation', async () => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((r) => (enter = r)),
    released = new Promise<void>((r) => (release = r))
  let first = true
  const { kube, runtime } = setup(async () => {
    if (first) {
      first = false
      enter()
      await released
    }
    return true
  })
  const ensuring = runtime.ensure('roomA', { environment: 'base' })
  const rejected = assert.rejects(ensuring, /cancel|supersed/i)
  await entered
  const stopping = runtime.remove('roomA')
  release()
  await rejected
  await stopping
  assert.equal(kube.objects.size, 0)
  const endpoint = await runtime.ensure('roomA', { environment: 'base' })
  assert.notEqual(endpoint.instanceId, 'uid-2')
})

test('Kubernetes authorization failure never becomes absence and mismatched objects are never deleted', async () => {
  const { kube, runtime } = setup()
  kube.failure = 403
  await assert.rejects(runtime.ensure('roomA', { environment: 'base' }), /Forbidden/)
  assert.equal(kube.creates.length, 0)
  kube.failure = 0
  kube.objects.set(`/api/v1/namespaces/colloq/pods/${roomName('roomA')}`, {
    kind: 'Pod',
    metadata: { name: roomName('roomA'), uid: 'foreign', labels: {} },
    spec: {},
  })
  await assert.rejects(runtime.remove('roomA'), /managed|ownership/i)
  assert.equal(kube.deletes.length, 0)
})

test('deletion waits for Pod disappearance before a later ensure can replace it', async () => {
  const { kube, runtime } = setup()
  const first = await runtime.ensure('roomA', { environment: 'base' })
  kube.delayedDeletion = true
  const deleting = runtime.remove('roomA')
  let finished = false
  const reopening = runtime.ensure('roomA', { environment: 'base' }).then((value) => {
    finished = true
    return value
  })
  for (let i = 0; i < 100 && !kube.deletes.some((d) => d.path.includes('/pods/')); i++)
    await new Promise((r) => setTimeout(r, 1))
  assert.equal(
    kube.deletes.some((d) => d.path.includes('/pods/')),
    true,
  )
  assert.equal(finished, false)
  assert.equal(kube.creates.filter((o) => o.kind === 'Pod').length, 1)
  kube.objects.delete(`/api/v1/namespaces/colloq/pods/${roomName('roomA')}`)
  await deleting
  const second = await reopening
  assert.notEqual(second.instanceId, first.instanceId)
})

test('runtime process replacement adopts the same Pod UID without restarting Python', async () => {
  const { kube, runtime } = setup()
  const first = await runtime.ensure('roomA', { environment: 'base' })
  const restarted = new RuntimeController({
    kube,
    config,
    catalog: () => catalog,
    roomSecret: () => 'secret'.repeat(16),
    probe: async () => true,
  })
  assert.deepEqual(await restarted.ensure('roomA', { environment: 'base' }), first)
  assert.equal(kube.creates.filter((o) => o.kind === 'Pod').length, 1)
})

test('adoption rejects injected pod execution, credentials, mounts and scheduling despite unchanged template hash', async () => {
  const attacks: Array<(pod: KubeObject) => void> = [
    (pod) => {
      pod.spec.initContainers = [{ name: 'injected', image: 'evil' }]
    },
    (pod) => {
      pod.spec.ephemeralContainers = [{ name: 'injected', image: 'evil' }]
    },
    (pod) => {
      pod.spec.containers[0].command = ['sh', '-c', 'evil']
    },
    (pod) => {
      pod.spec.containers[0].args = ['evil']
    },
    (pod) => {
      pod.spec.containers[0].envFrom = [{ secretRef: { name: 'colloq-room-secret' } }]
    },
    (pod) => {
      pod.spec.containers[0].lifecycle = { postStart: { exec: { command: ['evil'] } } }
    },
    (pod) => {
      pod.spec.containers[0].livenessProbe = { exec: { command: ['evil'] } }
    },
    (pod) => {
      pod.spec.containers[0].readinessProbe.exec = { command: ['evil'] }
    },
    (pod) => {
      pod.spec.containers[0].volumeMounts[0].subPathExpr = 'other-room'
    },
    (pod) => {
      pod.spec.containers[0].securityContext.privileged = true
    },
    (pod) => {
      pod.spec.securityContext.fsGroup = 0
    },
    (pod) => {
      pod.spec.hostNetwork = true
    },
    (pod) => {
      pod.spec.nodeSelector = { untrusted: 'node' }
    },
    (pod) => {
      pod.spec.priorityClassName = 'system-node-critical'
    },
    (pod) => {
      pod.spec.tolerations = [{ operator: 'Exists' }]
    },
  ]
  for (const attack of attacks) {
    const { kube, runtime } = setup()
    const before = await runtime.ensure('roomA', { environment: 'base' })
    const pod = kube.objects.get(`/api/v1/namespaces/colloq/pods/${roomName('roomA')}`)!
    attack(pod)
    const after = await runtime.ensure('roomA', { environment: 'base' })
    assert.notEqual(
      after.instanceId,
      before.instanceId,
      'unsafe existing Pod must never be adopted',
    )
  }
})

test('server-populated Kubernetes defaults and equivalent resource quantities preserve a healthy Pod incarnation', async () => {
  const { kube, runtime } = setup()
  const before = await runtime.ensure('roomA', { environment: 'gpu' })
  const pod = kube.objects.get(`/api/v1/namespaces/colloq/pods/${roomName('roomA')}`)!
  Object.assign(pod.spec, {
    dnsPolicy: 'ClusterFirst',
    schedulerName: 'default-scheduler',
    nodeName: 'colloq-node',
    serviceAccount: 'colloq-kernel',
    priority: 0,
    preemptionPolicy: 'PreemptLowerPriority',
    tolerations: [
      {
        key: 'node.kubernetes.io/not-ready',
        operator: 'Exists',
        effect: 'NoExecute',
        tolerationSeconds: 300,
      },
      {
        key: 'node.kubernetes.io/unreachable',
        operator: 'Exists',
        effect: 'NoExecute',
        tolerationSeconds: 300,
      },
    ],
  })
  Object.assign(pod.spec.containers[0], {
    terminationMessagePath: '/dev/termination-log',
    terminationMessagePolicy: 'File',
  })
  pod.spec.containers[0].readinessProbe.successThreshold = 1
  pod.spec.volumes[1].emptyDir.sizeLimit = '2048Mi'
  for (const resources of [
    pod.spec.containers[0].resources.limits,
    pod.spec.containers[0].resources.requests,
  ]) {
    resources.cpu = '2000m'
    resources.memory = '2048Mi'
    resources['nvidia.com/gpu'] = '1'
  }
  const after = await runtime.ensure('roomA', { environment: 'gpu' })
  assert.equal(after.instanceId, before.instanceId)
})

test('Service adoption permits only allocation defaults and refuses extra policy fields', async () => {
  const { kube, runtime } = setup()
  const before = await runtime.ensure('roomA', { environment: 'base' })
  const service = kube.objects.get(`/api/v1/namespaces/colloq/services/${roomName('roomA')}`)!
  Object.assign(service.spec, {
    clusterIP: '10.43.0.10',
    clusterIPs: ['10.43.0.10'],
    ipFamilies: ['IPv4'],
    ipFamilyPolicy: 'SingleStack',
    sessionAffinity: 'None',
    internalTrafficPolicy: 'Cluster',
  })
  assert.equal(
    (await runtime.ensure('roomA', { environment: 'base' })).instanceId,
    before.instanceId,
  )
  service.spec.ports[0].nodePort = 30099
  await assert.rejects(runtime.ensure('roomA', { environment: 'base' }), /private service policy/)
  assert.equal(kube.deletes.length, 0)
})

test('permanent retirement persists before Pod deletion and survives ordinary stop and broker restart', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('retired-room', { environment: 'base' })
  let sawMarker = false
  const request = kube.request.bind(kube)
  kube.request = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    if (method === 'DELETE' && path.includes('/pods/')) {
      const marker = kube.objects.get(
        `/api/v1/namespaces/colloq/services/${roomName('retired-room')}`,
      )!
      assert.equal(marker.metadata.annotations?.['colloq.dev/retired'], 'true')
      assert.equal(marker.metadata.labels?.['colloq.dev/retired'], 'true')
      assert.equal(marker.spec.clusterIP, 'None')
      assert.equal(marker.spec.selector, undefined)
      sawMarker = true
    }
    return request<T>(method, path, body)
  }
  await runtime.remove('retired-room', true)
  assert.equal(sawMarker, true)
  assert.deepEqual(await runtime.list(), [])
  await assert.rejects(runtime.ensure('retired-room', { environment: 'base' }), /retired/)
  await runtime.remove('retired-room')
  assert.equal(kube.objects.size, 1, 'ordinary stop must preserve the retirement tombstone')
  const restarted = new RuntimeController({
    kube,
    config,
    catalog: () => catalog,
    roomSecret: () => 'secret'.repeat(16),
    probe: async () => true,
  })
  await assert.rejects(restarted.ensure('retired-room', { environment: 'base' }), /retired/)
  await restarted.remove('retired-room', true)
  assert.equal(kube.objects.size, 1)
})

test('an old POST body completed after permanent DELETE cannot resurrect its room', async () => {
  const { runtime } = setup(),
    token = 'test-token'.repeat(8)
  const server = createRuntimeServer({
    controller: runtime,
    token: () => token,
    catalog: () => catalog,
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const input = JSON.stringify({ environment: 'base' })
  let admitted!: () => void
  const accepted = new Promise<void>((r) => (admitted = r))
  server.on('request', (req) => {
    if (req.method === 'POST') admitted()
  })
  let request!: http.ClientRequest
  const response = new Promise<number>((resolve, reject) => {
    request = http.request(
      base + '/v1/rooms/late-room',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(input),
        },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode!))
      },
    )
    request.on('error', reject)
    request.write(input.slice(0, 2))
  })
  try {
    await accepted
    const retired = await fetch(base + '/v1/rooms/late-room?retire=true', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(retired.status, 200)
    request.end(input.slice(2))
    assert.equal(await response, 410)
  } finally {
    request.destroy()
    await response.catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('readiness checks API permissions and catalog without claiming that a room was scheduled', async () => {
  const { kube, runtime } = setup()
  assert.deepEqual(await runtime.health(), { ok: true, reason: null, defaultCpus: 2 })
  assert.equal(kube.creates.length, 0)
  kube.failure = 403
  assert.equal((await runtime.health()).ok, false)
})

test('a persisted tombstone survives failed retirement verification and subsequent ordinary deletion', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('failed-retirement', { environment: 'base' })
  const original = kube.request.bind(kube)
  kube.request = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const result = await original<T>(method, path, body)
    if (
      method === 'POST' &&
      (body as KubeObject)?.metadata?.labels?.['colloq.dev/retired'] === 'true'
    ) {
      ;(result as KubeObject).spec.publishNotReadyAddresses = true
      kube.objects.get(`${path}/${roomName('failed-retirement')}`)!.spec.publishNotReadyAddresses =
        true
    }
    return result
  }
  await assert.rejects(
    runtime.remove('failed-retirement', true),
    /retirement could not be persisted/,
  )
  assert.equal(
    kube.deletes.some((entry) => entry.path.includes('/pods/')),
    false,
  )
  await runtime.remove('failed-retirement')
  assert.equal(kube.objects.size, 1)
  await assert.rejects(runtime.ensure('failed-retirement', { environment: 'base' }), /retired/)
})

test('room census follows Kubernetes continuation pages so cleanup does not omit older rooms', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('roomA', { environment: 'base' })
  await runtime.ensure('roomB', { environment: 'base' })
  const original = kube.request.bind(kube)
  kube.request = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const result = await original<any>(method, path, body)
    if (method === 'GET' && path.includes('/pods?labelSelector=')) {
      return (
        path.includes('continue=next')
          ? { items: result.items.slice(1), metadata: {} }
          : { items: result.items.slice(0, 1), metadata: { continue: 'next' } }
      ) as T
    }
    return result
  }
  assert.equal((await runtime.list()).length, 2)
})
