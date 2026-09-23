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
  patches: { path: string; body: any; contentType?: string }[] = []
  sequence = 0
  failure = 0
  delayedDeletion = false
  /**
   * Что kubelet делает с изменением памяти: выставляет (`apply`), откладывает,
   * потому что узлу сейчас нечем (`defer`, k8s 1.33+), или объявляет
   * невыполнимым условием (`infeasible`, так отвечали 1.33–1.34). Отказ самого
   * API (403 с нехваткой allocatable, так отвечает 1.35+) — `patchFailures`.
   */
  kubelet: 'apply' | 'defer' | 'infeasible' = 'apply'
  patchFailures: KubernetesError[] = []
  async request<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T> {
    if (this.failure) throw new KubernetesError(this.failure, 'Forbidden')
    if (method === 'POST') {
      const object = structuredClone(body) as KubeObject
      const key = `${path}/${object.metadata.name}`
      if (this.objects.has(key)) throw new KubernetesError(409, 'AlreadyExists')
      object.metadata.uid = `uid-${++this.sequence}`
      object.metadata.resourceVersion = String(++this.sequence)
      if (object.kind === 'Service' && object.spec.clusterIP === 'None')
        Object.assign(object.spec, {clusterIPs:['None'],ipFamilies:object.spec.ipFamilies??['IPv4','IPv6'],ipFamilyPolicy:object.spec.ipFamilyPolicy??'RequireDualStack'})
      object.status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] }
      if (object.kind === 'Pod')
        object.status.containerStatuses = object.spec.containers.map((c: any) => ({
          name: c.name,
          resources: structuredClone(c.resources),
        }))
      this.objects.set(key, object)
      this.creates.push(object)
      return structuredClone(object) as T
    }
    if (method === 'PATCH') {
      this.patches.push({ path, body: structuredClone(body), contentType })
      const failure = this.patchFailures.shift()
      if (failure) throw failure
      assert.match(path, /\/resize$/, 'only the resize subresource may be patched')
      const object = this.objects.get(path.slice(0, -'/resize'.length))
      if (!object) throw new KubernetesError(404, 'NotFound')
      const patch = body as any
      if (patch.metadata?.resourceVersion !== object.metadata.resourceVersion)
        throw new KubernetesError(409, 'Conflict')
      for (const change of patch.spec.containers) {
        const container = object.spec.containers.find((c: any) => c.name === change.name)
        for (const group of ['requests', 'limits'])
          Object.assign(container.resources[group], change.resources[group])
      }
      object.metadata.resourceVersion = String(++this.sequence)
      const conditions = object.status!.conditions.filter((c: any) => !c.type.startsWith('PodResize'))
      if (this.kubelet === 'apply')
        object.status!.containerStatuses = object.spec.containers.map((c: any) => ({
          name: c.name,
          resources: structuredClone(c.resources),
        }))
      else
        conditions.push({
          type: 'PodResizePending',
          status: 'True',
          reason: this.kubelet === 'defer' ? 'Deferred' : 'Infeasible',
        })
      object.status!.conditions = conditions
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
function setup(probe: () => Promise<boolean> = async () => true, workload: typeof config & { maxMemoryMb?: number } = config) {
  const kube = new FakeKube()
  const runtime = new RuntimeController({
    kube,
    config: workload,
    resizeTimeoutMs: 50,
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

test('room CPU intent sets quota and threads and resets to the runtime default in place', async () => {
  const { kube, runtime } = setup()
  const first = await runtime.ensure('cpuRoom', { environment: 'base', cpus: 6 })
  const kernel = kube.creates.find((o) => o.kind === 'Pod')!.spec.containers[0]
  assert.equal(kernel.resources.requests.cpu, '6')
  assert.equal(kernel.resources.limits.cpu, '6')
  assert.equal((await runtime.list()).find((room) => room.sessionId === 'cpuRoom')?.cpus, 6)
  /*
   * Потоки — по limits.cpu на старте контейнера (Downward API), а не числом
   * брокера: иначе шаблон Pod зависел бы от ядер, и смена ядер на месте
   * делала бы Pod «чужим» для следующего ensure.
   */
  for (const name of ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'])
    assert.deepEqual(kernel.env.find((entry: any) => entry.name === name), {
      name,
      valueFrom: { resourceFieldRef: { containerName: 'kernel', resource: 'limits.cpu', divisor: '1' } },
    })
  assert.deepEqual(kernel.resizePolicy, [
    { resourceName: 'memory', restartPolicy: 'NotRequired' },
    { resourceName: 'cpu', restartPolicy: 'NotRequired' },
  ])
  assert.equal((await runtime.ensure('cpuRoom', { environment: 'base', cpus: 6 })).instanceId, first.instanceId)
  // До 18.09 сброс ядер сносил Pod вместе с переменными семинара.
  const reset = await runtime.ensure('cpuRoom', { environment: 'base' })
  assert.equal(reset.instanceId, first.instanceId, 'a CPU reset must never replace Python')
  assert.equal(kube.deletes.length, 0)
  const pod = kube.objects.get(`/api/v1/namespaces/colloq/pods/${roomName('cpuRoom')}`)!
  assert.equal(pod.spec.containers[0].resources.limits.cpu, '2')
  assert.equal(pod.spec.containers[0].resources.requests.cpu, '2')
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
  assert.deepEqual(await runtime.health(), {
    ok: true,
    reason: null,
    defaultCpus: 2,
    // Умолчание и потолок памяти — чтобы форма занятия подписывала поле
    // числами брокера, а не docker-пути, которых Pod не получает.
    defaultMemoryMb: 2048,
    maxMemoryMb: 262144,
    recovery: { rollbackRetries: 0, rollbackFailures: 0, rollbacksApplied: 0 },
  })
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

/* ------------------------------------------------------------ память комнаты */

const podPath = (id: string) => `/api/v1/namespaces/colloq/pods/${roomName(id)}`
const kernelOf = (pod: KubeObject) => pod.spec.containers.find((c: any) => c.name === 'kernel')

test('room memory intent reaches the Pod as a Guaranteed request/limit and the census reports it', async () => {
  // 18.09: поле памяти в форме на k3s не делало ничего — брокер его не
  // принимал, и Pod любой комнаты получал RUNTIME_KERNEL_MEMORY.
  const { kube, runtime } = setup()
  await runtime.ensure('memRoom', { environment: 'base', memoryMb: 6144 })
  const kernel = kernelOf(kube.creates.find((o) => o.kind === 'Pod')!)
  assert.equal(kernel.resources.requests.memory, '6144Mi')
  assert.equal(kernel.resources.limits.memory, '6144Mi')
  assert.deepEqual(kernel.resizePolicy, [
    { resourceName: 'memory', restartPolicy: 'NotRequired' },
    { resourceName: 'cpu', restartPolicy: 'NotRequired' },
  ])
  assert.equal((await runtime.list()).find((r) => r.sessionId === 'memRoom')?.memoryMb, 6144)
  await runtime.ensure('plainRoom', { environment: 'base' })
  assert.equal(kernelOf(kube.creates.filter((o) => o.kind === 'Pod').at(-1)!).resources.limits.memory, '2Gi')
})

test('raising memory resizes the live Pod in place: same UID, no deletion, only the resize subresource', async () => {
  const { kube, runtime } = setup()
  const before = await runtime.ensure('liveRoom', { environment: 'base', memoryMb: 2048 })
  assert.deepEqual(await runtime.resize('liveRoom', { memoryMb: 8192 }), {
    outcome: 'applied',
    memoryMb: 8192,
  })
  assert.equal(kube.deletes.length, 0, 'a memory change must never replace Python')
  assert.equal(kube.patches.length, 1)
  const [patch] = kube.patches
  assert.equal(patch.path, `${podPath('liveRoom')}/resize`)
  assert.equal(patch.contentType, 'application/strategic-merge-patch+json')
  // Только память контейнера kernel и предусловие версии — ничего исполняемого.
  assert.deepEqual(patch.body.spec, {
    containers: [
      { name: 'kernel', resources: { requests: { memory: '8192Mi' }, limits: { memory: '8192Mi' } } },
    ],
  })
  assert.ok(patch.body.metadata.resourceVersion)
  // Следующий ensure с тем же числом усыновляет тот же Pod: хэш шаблона не
  // зависит от памяти, иначе первый же подъём снёс бы изменённую комнату.
  const after = await runtime.ensure('liveRoom', { environment: 'base', memoryMb: 8192 })
  assert.equal(after.instanceId, before.instanceId)
  assert.equal(kube.creates.filter((o) => o.kind === 'Pod').length, 1)
  assert.equal((await runtime.list())[0].memoryMb, 8192)
})

test('a memory drift found at ensure is resized in place, not replaced', async () => {
  // Изменение не доехало раньше (брокер лежал): следующий Run не должен
  // стоить семинару всех переменных.
  const { kube, runtime } = setup()
  const before = await runtime.ensure('driftRoom', { environment: 'base', memoryMb: 2048 })
  const after = await runtime.ensure('driftRoom', { environment: 'base', memoryMb: 4096 })
  assert.equal(after.instanceId, before.instanceId)
  assert.equal(kube.deletes.length, 0)
  assert.equal(kernelOf(kube.objects.get(podPath('driftRoom'))!).resources.limits.memory, '4096Mi')
})

test('a Run with new memory while the room is still starting queues behind it instead of a 409', async () => {
  // После OOM все жмут Run разом, а преподаватель тем временем поднимает
  // память: второй ensure приходит с другим числом, пока первый ждёт Jupyter.
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const { kube, runtime } = setup(async () => {
    await gate
    return true
  })
  const first = runtime.ensure('startRoom', { environment: 'base', memoryMb: 2048 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = runtime.ensure('startRoom', { environment: 'base', memoryMb: 4096 })
  // Ядра — тоже очередь: с 18.09 их меняют на месте, как память.
  const third = runtime.ensure('startRoom', { environment: 'base', cpus: 4, memoryMb: 4096 })
  // Другое окружение — по-прежнему конфликт: его меняют только заменой Pod.
  await assert.rejects(runtime.ensure('startRoom', { environment: 'gpu' }), (err: any) => err.status === 409)
  open()
  const [a, b, c] = await Promise.all([first, second, third])
  assert.equal(b.instanceId, a.instanceId, 'the second Run lands in the same Pod')
  assert.equal(c.instanceId, a.instanceId, 'a Run with new cores lands in the same Pod')
  assert.equal(kube.deletes.length, 0)
  const kernel = kernelOf(kube.objects.get(podPath('startRoom'))!)
  assert.equal(kernel.resources.limits.memory, '4096Mi')
  assert.equal(kernel.resources.limits.cpu, '4')
})

test('memory and CPU together with any other change, or a tampered Pod, is still a replacement', async () => {
  const { kube, runtime } = setup()
  const first = await runtime.ensure('mixRoom', { environment: 'base', cpus: 2, memoryMb: 2048 })
  const second = await runtime.ensure('mixRoom', { environment: 'gpu', cpus: 4, memoryMb: 4096 })
  assert.notEqual(second.instanceId, first.instanceId)
  assert.equal(kube.patches.length, 0)
  const pod = kube.objects.get(podPath('mixRoom'))!
  kernelOf(pod).command = ['sh', '-c', 'evil']
  const third = await runtime.ensure('mixRoom', { environment: 'gpu', cpus: 4, memoryMb: 8192 })
  assert.notEqual(third.instanceId, second.instanceId, 'a memory diff must not launder an injected command')
  assert.equal(kube.patches.length, 0)
  // Потоки из Downward API — часть сравниваемого spec: подменённый источник
  // (секрет вместо limits.cpu) не отмывается разницей в ядрах.
  const omp = kernelOf(kube.objects.get(podPath('mixRoom'))!).env.find((e: any) => e.name === 'OMP_NUM_THREADS')
  omp.valueFrom = { secretKeyRef: { name: 'colloq-runtime', key: 'token' } }
  const fourth = await runtime.ensure('mixRoom', { environment: 'gpu', cpus: 6, memoryMb: 8192 })
  assert.notEqual(fourth.instanceId, third.instanceId, 'a CPU diff must not launder an injected env source')
  assert.equal(kube.patches.length, 0)
})

test('resizing a room without a Pod neither starts one nor fails', async () => {
  const { kube, runtime } = setup()
  assert.deepEqual(await runtime.resize('coldRoom', { memoryMb: 4096 }), { outcome: 'absent' })
  assert.equal(kube.creates.length, 0)
  assert.equal(kube.patches.length, 0)
})

test('null returns the live Pod to the broker default', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('resetRoom', { environment: 'base', memoryMb: 8192 })
  assert.deepEqual(await runtime.resize('resetRoom', { memoryMb: null }), {
    outcome: 'applied',
    memoryMb: 2048,
  })
  assert.equal(kernelOf(kube.objects.get(podPath('resetRoom'))!).resources.limits.memory, '2048Mi')
})

test('the ceiling refuses a live resize and caps an ensure instead of breaking the room', async () => {
  const { kube, runtime } = setup(undefined, { ...config, maxMemoryMb: 8192 })
  assert.equal((await runtime.health()).maxMemoryMb, 8192)
  await runtime.ensure('capRoom', { environment: 'base', memoryMb: 16384 })
  // Отказ на ensure значил бы комнату без Python до ручной правки строки
  // семинара; потолок честнее, и перепись скажет, что выдано на деле.
  assert.equal(kernelOf(kube.objects.get(podPath('capRoom'))!).resources.limits.memory, '8192Mi')
  await assert.rejects(runtime.resize('capRoom', { memoryMb: 16384 }), (err: any) =>
    err.status === 400 && /ceiling of 8192/.test(err.message),
  )
  assert.equal(kube.patches.length, 0)
})

test('an infeasible resize is reported and never left in the spec for the next Pod', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('bigRoom', { environment: 'base', memoryMb: 2048 })
  // 1.35+: API отвергает сразу, spec не тронут.
  kube.patchFailures.push(new KubernetesError(403, 'Forbidden', 'memory'))
  await assert.rejects(runtime.resize('bigRoom', { memoryMb: 65536 }), (err: any) =>
    err.status === 409 && /infeasible.*memory/i.test(err.message),
  )
  // 1.33–1.34: kubelet ставит Infeasible — брокер возвращает spec к тому, что есть.
  kube.kubelet = 'infeasible'
  await assert.rejects(runtime.resize('bigRoom', { memoryMb: 65536 }), /infeasible/i)
  const pod = kube.objects.get(podPath('bigRoom'))!
  assert.equal(kernelOf(pod).resources.limits.memory, '2048Mi')
  assert.deepEqual(
    kube.patches.at(-1)!.body.spec.containers[0].resources.limits,
    { memory: '2048Mi' },
  )
})

test('a deferred resize is pending, and the census shows what the Pod really has', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('busyNode', { environment: 'base', memoryMb: 2048 })
  kube.kubelet = 'defer'
  assert.deepEqual(await runtime.resize('busyNode', { memoryMb: 4096 }), {
    outcome: 'pending',
    memoryMb: 2048,
  })
  assert.equal((await runtime.list())[0].memoryMb, 2048)
})

test('a status update racing the resize is retried against the fresh resourceVersion', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('raceRoom', { environment: 'base', memoryMb: 2048 })
  kube.patchFailures.push(new KubernetesError(409, 'Conflict'))
  assert.equal((await runtime.resize('raceRoom', { memoryMb: 3072 })).outcome, 'applied')
  assert.equal(kube.patches.length, 2)
})

/* ------------------------------------------------------------- ядра комнаты */

test('the Pod template hash does not depend on CPU, so a CPU change never makes the Pod foreign', async () => {
  // До 18.09 ядра стояли в хэше: смена числа в форме сносила Pod на
  // следующем подъёме (открыли терминал) — со всеми переменными семинара.
  const { kube, runtime } = setup()
  await runtime.ensure('hashRoom', { environment: 'base', cpus: 2 })
  await runtime.remove('hashRoom')
  await runtime.ensure('hashRoom', { environment: 'base', cpus: 6 })
  const [two, six] = kube.creates.filter((o) => o.kind === 'Pod')
  assert.notEqual(kernelOf(two).resources.limits.cpu, kernelOf(six).resources.limits.cpu)
  assert.equal(
    two.metadata.annotations!['colloq.dev/template-hash'],
    six.metadata.annotations!['colloq.dev/template-hash'],
  )
  assert.deepEqual(kernelOf(two).env, kernelOf(six).env, 'thread env must not carry the core count as text')
})

test('raising CPU resizes the live Pod in place: same UID, no deletion, only cpu in the resize patch', async () => {
  const { kube, runtime } = setup()
  const before = await runtime.ensure('cpuLive', { environment: 'base', cpus: 2 })
  assert.deepEqual(await runtime.resize('cpuLive', { cpus: 6 }), { outcome: 'applied', cpus: 6 })
  assert.equal(kube.deletes.length, 0, 'a CPU change must never replace Python')
  assert.equal(kube.patches.length, 1)
  const [patch] = kube.patches
  assert.equal(patch.path, `${podPath('cpuLive')}/resize`)
  assert.equal(patch.contentType, 'application/strategic-merge-patch+json')
  // Только ядра: память, которую не просили, не переписывается прочитанным числом.
  assert.deepEqual(patch.body.spec, {
    containers: [{ name: 'kernel', resources: { requests: { cpu: '6' }, limits: { cpu: '6' } } }],
  })
  assert.ok(patch.body.metadata.resourceVersion)
  // Следующий подъём с тем же числом (открыли терминал) усыновляет тот же Pod.
  const after = await runtime.ensure('cpuLive', { environment: 'base', cpus: 6 })
  assert.equal(after.instanceId, before.instanceId)
  assert.equal(kube.creates.filter((o) => o.kind === 'Pod').length, 1)
  assert.equal(kube.patches.length, 1, 'an already resized Pod needs no second patch')
  assert.equal((await runtime.list())[0].cpus, 6)
})

test('a CPU drift found at ensure is resized in place, not replaced', async () => {
  // Веб записал ядра, а брокер лежал: следующий Run не должен стоить комнате Python.
  const { kube, runtime } = setup()
  const before = await runtime.ensure('cpuDrift', { environment: 'base', cpus: 2, memoryMb: 2048 })
  const after = await runtime.ensure('cpuDrift', { environment: 'base', cpus: 4, memoryMb: 2048 })
  assert.equal(after.instanceId, before.instanceId)
  assert.equal(kube.deletes.length, 0)
  const kernel = kernelOf(kube.objects.get(podPath('cpuDrift'))!)
  assert.equal(kernel.resources.limits.cpu, '4')
  assert.equal(kernel.resources.requests.cpu, '4')
  assert.equal(kernel.resources.limits.memory, '2048Mi')
})

test('memory and CPU change together in one resize, and null returns CPU to the broker default', async () => {
  const { kube, runtime } = setup(undefined, { ...config, cpu: '1500m' })
  await runtime.ensure('bothRoom', { environment: 'base', cpus: 4, memoryMb: 2048 })
  assert.deepEqual(await runtime.resize('bothRoom', { memoryMb: 4096, cpus: 8 }), {
    outcome: 'applied',
    memoryMb: 4096,
    cpus: 8,
  })
  assert.deepEqual(kube.patches.at(-1)!.body.spec.containers[0].resources.limits, {
    memory: '4096Mi',
    cpu: '8',
  })
  // Умолчание брокера — той же строкой, что у нового Pod, хоть бы и дробной.
  assert.deepEqual(await runtime.resize('bothRoom', { cpus: null }), { outcome: 'applied', cpus: 1.5 })
  const kernel = kernelOf(kube.objects.get(podPath('bothRoom'))!)
  assert.equal(kernel.resources.limits.cpu, '1500m')
  assert.equal(kernel.resources.limits.memory, '4096Mi', 'memory was not asked for and stays')
  assert.equal(kube.deletes.length, 0)
})

test('a resize request without any resource or with fractional cores is refused before Kubernetes', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('badRoom', { environment: 'base' })
  for (const intent of [{}, { cpus: 1.5 }, { cpus: 0 }, { cpus: 65 }, { cpus: '4' }])
    await assert.rejects(runtime.resize('badRoom', intent as any), (err: any) => err.status === 400)
  assert.equal(kube.patches.length, 0)
})

test('a deferred CPU resize is pending, and the census shows the cores the Pod really has', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('busyCpu', { environment: 'base', cpus: 2 })
  kube.kubelet = 'defer'
  assert.deepEqual(await runtime.resize('busyCpu', { cpus: 4 }), { outcome: 'pending', cpus: 2 })
  assert.equal((await runtime.list())[0].cpus, 2)
  assert.equal(kube.deletes.length, 0)
})

test('an infeasible CPU resize is reported and the spec returns to the cores the Pod has', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('bigCpu', { environment: 'base', cpus: 2 })
  // 1.35+: «node didn't have enough allocatable resources: cpu» — проверено на k3s 1.36.
  kube.patchFailures.push(new KubernetesError(403, 'Forbidden', 'cpu'))
  await assert.rejects(runtime.resize('bigCpu', { cpus: 64 }), (err: any) =>
    err.status === 409 && /infeasible.*cpu/i.test(err.message),
  )
  kube.kubelet = 'infeasible'
  await assert.rejects(runtime.resize('bigCpu', { cpus: 64 }), /infeasible/i)
  assert.equal(kernelOf(kube.objects.get(podPath('bigCpu'))!).resources.limits.cpu, '2')
  assert.deepEqual(kube.patches.at(-1)!.body.spec.containers[0].resources.limits, { cpu: '2' })
})

/*
 * Pod, которому на узле нет места.
 *
 * Память комнаты зарезервирована целиком (requests = limits), и на занятом узле
 * Pod стоит в Pending с «0/1 nodes are available: 1 Insufficient memory». До
 * 18.09 комната читала про это «Room startup timed out: pending» через две
 * минуты. Подделка ниже — планировщик: Pod создаётся без узла и с условием
 * PodScheduled=False/Unschedulable, а после `schedulesAfter` чтений встаёт.
 */
class CrowdedKube extends FakeKube {
  reads = 0
  constructor(
    public message: string,
    public schedulesAfter = Infinity,
  ) {
    super()
  }
  async request<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T> {
    const stored = this.objects.get(path)
    if (method === 'GET' && stored?.kind === 'Pod' && ++this.reads > this.schedulesAfter) {
      stored.spec.nodeName = 'node-a'
      stored.status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] }
    }
    const result = await super.request<T>(method, path, body, contentType)
    const created = body as KubeObject | undefined
    if (method !== 'POST' || created?.kind !== 'Pod') return result
    const pod = this.objects.get(`${path}/${created.metadata.name}`)!
    pod.status = {
      phase: 'Pending',
      conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: this.message }],
    }
    return structuredClone(pod) as T
  }
}
function crowded(kube: CrowdedKube, timing: { unschedulableGraceMs?: number; startupTimeoutMs?: number } = {}) {
  return new RuntimeController({
    kube,
    config,
    catalog: () => catalog,
    roomSecret: () => 'secret'.repeat(16),
    probe: async () => true,
    pollMs: 1,
    deletionTimeoutMs: 1000,
    startupTimeoutMs: timing.startupTimeoutMs ?? 1000,
    unschedulableGraceMs: timing.unschedulableGraceMs ?? 10,
  })
}
const SCHEDULER = (what: string) =>
  `0/1 nodes are available: ${what}. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.`

test('an unschedulable room ends with the lacking resource and the Pod numbers, not a timeout', async () => {
  const kube = new CrowdedKube(SCHEDULER('1 Insufficient memory'))
  const runtime = crowded(kube)
  await assert.rejects(runtime.ensure('fullNode', { environment: 'base', memoryMb: 6144 }), (err: any) => {
    assert.equal(err.status, 503)
    assert.deepEqual(err.failure, { unschedulable: 'memory', memoryMb: 6144, cpus: 2 })
    assert.doesNotMatch(err.message, /timed out|nodes are available|preemption/)
    return true
  })
  // Pod ни разу не стоял на узле: он удалён, и следующий подъём создаст новый
  // с тем, что к тому времени будет в форме, — а не станет менять память Pod-у
  // без узла.
  assert.equal(kube.objects.has(`/api/v1/namespaces/colloq/pods/${roomName('fullNode')}`), false)
  assert.equal(kube.deletes.filter((d) => d.path.includes('/pods/')).length, 1)
})

test('the scheduler message yields only a resource word: GPU first, then memory, then CPU, else other', async () => {
  for (const [message, word] of [
    [SCHEDULER('1 Insufficient memory, 1 Insufficient nvidia.com/gpu'), 'gpu'],
    [SCHEDULER('1 Insufficient cpu, 1 Insufficient memory'), 'memory'],
    [SCHEDULER('1 Insufficient cpu'), 'cpu'],
    [SCHEDULER("1 node(s) had untolerated taint {node.kubernetes.io/disk-pressure: }"), 'other'],
  ] as const) {
    const runtime = crowded(new CrowdedKube(message))
    await assert.rejects(runtime.ensure('mapped', { environment: word === 'gpu' ? 'gpu' : 'base' }), (err: any) => {
      assert.equal(err.failure.unschedulable, word, message)
      return true
    })
  }
})

test('a short refusal while a neighbour is still going away is waited out, not reported', async () => {
  const kube = new CrowdedKube(SCHEDULER('1 Insufficient memory'), 3)
  const runtime = crowded(kube, { unschedulableGraceMs: 10000 })
  const endpoint = await runtime.ensure('patient', { environment: 'base' })
  assert.ok(endpoint.instanceId)
  assert.equal(kube.deletes.length, 0)
})

test('a startup timeout shorter than the grace still names the lacking resource', async () => {
  const runtime = crowded(new CrowdedKube(SCHEDULER('1 Insufficient memory')), {
    unschedulableGraceMs: 60000,
    startupTimeoutMs: 30,
  })
  await assert.rejects(runtime.ensure('short', { environment: 'base' }), (err: any) =>
    err.failure?.unschedulable === 'memory' && !/timed out/.test(err.message),
  )
})

test('the census names an unscheduled Pod and the HTTP error carries the word without scheduler text', async () => {
  const kube = new CrowdedKube(SCHEDULER('1 Insufficient memory'))
  const runtime = crowded(kube, { unschedulableGraceMs: 60000, startupTimeoutMs: 60000 })
  const pending = runtime.ensure('census', { environment: 'base', memoryMb: 4096 }).catch((err) => err)
  while (!kube.objects.has(`/api/v1/namespaces/colloq/pods/${roomName('census')}`))
    await new Promise((r) => setTimeout(r, 1))
  const [room] = await runtime.list()
  assert.equal(room.phase, 'pending')
  assert.equal(room.reason, 'Unschedulable')
  await runtime.remove('census')
  await pending

  const token = 't'.repeat(64)
  const server = createRuntimeServer({ controller: crowded(new CrowdedKube(SCHEDULER('1 Insufficient memory'))), token: () => token, catalog: () => catalog })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/rooms/over`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ environment: 'base', memoryMb: 6144 }),
    })
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.deepEqual(
      { ...body, error: undefined },
      { error: undefined, unschedulable: 'memory', memoryMb: 6144, cpus: 2 },
    )
    assert.doesNotMatch(JSON.stringify(body), /nodes are available|preemption/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
