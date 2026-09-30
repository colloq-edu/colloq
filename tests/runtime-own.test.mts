/**
 * Personal notebooks on the broker: a second Pod per class (role `own`).
 *
 * Until 0.10 the broker had one Pod per class, and a run in a personal
 * notebook (`access: owner`) was refused on Kubernetes. The Docker backend
 * gives those notebooks a second container: no GPU, the same room folder, its
 * own cgroup and its own Jupyter token. These tests hold the broker's second
 * Pod to the same terms, against a fake Kubernetes API.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeController, ownName, roomName } from '../runtime/src/controller.js'
import { createRuntimeServer } from '../runtime/src/http.js'
import { KubernetesError, type KubernetesClient, type KubeObject } from '../runtime/src/kubernetes.js'
import { parseRuntimeCatalog, type RuntimeEndpoint } from '../shared/runtime.js'

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
const ns = '/api/v1/namespaces/colloq'

class Cluster implements KubernetesClient {
  objects = new Map<string, KubeObject>()
  creates: KubeObject[] = []
  deletes: string[] = []
  patches: Array<{ path: string; body: any }> = []
  sequence = 0
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (method === 'POST') {
      const object = structuredClone(body) as KubeObject
      const key = `${path}/${object.metadata.name}`
      if (this.objects.has(key)) throw new KubernetesError(409, 'AlreadyExists')
      object.metadata.uid = `uid-${++this.sequence}`
      object.metadata.resourceVersion = String(++this.sequence)
      if (object.kind === 'Service' && object.spec.clusterIP === 'None')
        Object.assign(object.spec, { clusterIPs: ['None'] })
      if (object.kind === 'Pod')
        object.status = {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: object.spec.containers.map((c: any) => ({ name: c.name, resources: structuredClone(c.resources) })),
        }
      this.objects.set(key, object)
      this.creates.push(structuredClone(object))
      return structuredClone(object) as T
    }
    if (method === 'PATCH') {
      this.patches.push({ path, body: structuredClone(body) })
      const object = this.objects.get(path.slice(0, -'/resize'.length))
      if (!object) throw new KubernetesError(404, 'NotFound')
      for (const change of (body as any).spec.containers) {
        const container = object.spec.containers.find((c: any) => c.name === change.name)
        for (const group of ['requests', 'limits']) Object.assign(container.resources[group], change.resources[group])
      }
      object.metadata.resourceVersion = String(++this.sequence)
      object.status!.containerStatuses = object.spec.containers.map((c: any) => ({ name: c.name, resources: structuredClone(c.resources) }))
      return structuredClone(object) as T
    }
    if (method === 'DELETE') {
      const object = this.objects.get(path)
      if (!object) throw new KubernetesError(404, 'NotFound')
      assert.equal((body as any).preconditions.uid, object.metadata.uid)
      this.deletes.push(path)
      this.objects.delete(path)
      return {} as T
    }
    if (path.includes('?'))
      return { items: [...this.objects].filter(([key]) => key.startsWith(path.split('?')[0] + '/')).map(([, o]) => structuredClone(o)) } as T
    const object = this.objects.get(path)
    if (!object) throw new KubernetesError(404, 'NotFound')
    return structuredClone(object) as T
  }
}
function setup(probe: (endpoint: RuntimeEndpoint) => Promise<boolean> = async () => true, maxMemoryMb?: number) {
  const kube = new Cluster()
  const runtime = new RuntimeController({
    kube,
    config: { namespace: 'colloq', workspaceClaim: 'colloq-workspace', memory: '2Gi', cpu: '2', ephemeral: '2Gi', ...(maxMemoryMb ? { maxMemoryMb } : {}) },
    catalog: () => catalog,
    roomSecret: () => 'secret'.repeat(16),
    probe,
    pollMs: 1,
    startupTimeoutMs: 2000,
    deletionTimeoutMs: 500,
    resizeTimeoutMs: 20,
  })
  return { kube, runtime }
}
const selects = (selector: Record<string, string>, labels: Record<string, string> = {}) =>
  Object.entries(selector).every(([key, value]) => labels[key] === value)

test('the personal notebooks get a second Pod: no GPU ever, the room folder, their own numbers, Service and token', async () => {
  const { kube, runtime } = setup(undefined, 8192)
  const room = await runtime.ensure('seminar', { environment: 'gpu' })
  const own = await runtime.ensure('seminar', { environment: 'gpu', memoryMb: 16384, cpus: 1 }, 'own')
  const pod = kube.objects.get(`${ns}/pods/${ownName('seminar')}`)!
  const roomPod = kube.objects.get(`${ns}/pods/${roomName('seminar')}`)!
  assert.equal(ownName('seminar'), `${roomName('seminar')}-own`)
  assert.ok(ownName('seminar').length <= 63, 'a Service name is a DNS label')
  const kernel = pod.spec.containers[0]
  // A GPU environment's image, on the CPU: the class's card is the class's.
  assert.equal(kernel.image, roomPod.spec.containers[0].image)
  assert.equal(kernel.resources.limits['nvidia.com/gpu'], undefined)
  assert.equal(pod.spec.runtimeClassName, undefined)
  assert.equal(pod.spec.volumes.find((v: any) => v.name === 'shm').emptyDir.sizeLimit, '64Mi')
  assert.equal(roomPod.spec.containers[0].resources.limits['nvidia.com/gpu'], 1)
  // The room folder, and only it, at the same path as in the room's Pod (as on docker).
  assert.deepEqual(kernel.volumeMounts, roomPod.spec.containers[0].volumeMounts)
  assert.deepEqual(kernel.volumeMounts.find((m: any) => m.name === 'workspace'), { name: 'workspace', mountPath: '/workspace/seminar', subPath: 'seminar' })
  assert.deepEqual(pod.spec.volumes.filter((v: any) => v.persistentVolumeClaim), [{ name: 'workspace', persistentVolumeClaim: { claimName: 'colloq-workspace' } }])
  // The personal notebooks' numbers, capped at the broker's ceiling like a room's.
  assert.equal(kernel.resources.limits.memory, '8192Mi')
  assert.equal(kernel.resources.requests.memory, '8192Mi')
  assert.equal(kernel.resources.limits.cpu, '1')
  // The same hardening as the room's Pod.
  assert.deepEqual(pod.spec.securityContext, roomPod.spec.securityContext)
  assert.deepEqual(kernel.securityContext, roomPod.spec.containers[0].securityContext)
  assert.equal(pod.spec.automountServiceAccountToken, false)
  // NetworkPolicy role kept: room-isolation covers it. The kind tells the two apart.
  assert.deepEqual(pod.metadata.labels, {
    'colloq.dev/role': 'kernel',
    'app.kubernetes.io/managed-by': 'colloq-runtime',
    'colloq.kind': 'own-kernel',
    'colloq.dev/session': roomPod.metadata.labels!['colloq.dev/session'],
    'colloq.dev/kernel': 'own',
    'colloq.dev/environment': 'gpu',
  })
  // Its own token and address: a line in a personal notebook cannot open the lecture's Jupyter.
  assert.notEqual(own.token, room.token)
  assert.notEqual(own.instanceId, room.instanceId)
  assert.equal(own.url, `http://${ownName('seminar')}.colloq.svc:8888`)
  assert.equal(kernel.env.find((e: any) => e.name === 'JUPYTER_TOKEN').value, own.token)
})

test("neither Service selects the other role's Pod", async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('seminar', { environment: 'base' })
  await runtime.ensure('seminar', { environment: 'base' }, 'own')
  const roomService = kube.objects.get(`${ns}/services/${roomName('seminar')}`)!
  const ownService = kube.objects.get(`${ns}/services/${ownName('seminar')}`)!
  const roomPod = kube.objects.get(`${ns}/pods/${roomName('seminar')}`)!
  const ownPod = kube.objects.get(`${ns}/pods/${ownName('seminar')}`)!
  assert.ok(selects(roomService.spec.selector, roomPod.metadata.labels))
  assert.equal(selects(roomService.spec.selector, ownPod.metadata.labels), false, 'the lecture Service must not route to a personal Pod')
  assert.ok(selects(ownService.spec.selector, ownPod.metadata.labels))
  assert.equal(selects(ownService.spec.selector, roomPod.metadata.labels), false)
  assert.deepEqual(ownService.spec.ports, roomService.spec.ports)
  assert.equal(ownService.spec.type, 'ClusterIP')
  // Both are what room-isolation selects.
  for (const pod of [roomPod, ownPod]) assert.equal(pod.metadata.labels!['colloq.dev/role'], 'kernel')
})

test('the census lists both Pods of a class, the personal one marked own, the room row exactly as before', async () => {
  const { runtime } = setup()
  await runtime.ensure('seminar', { environment: 'base', memoryMb: 3072 })
  await runtime.ensure('seminar', { environment: 'base', memoryMb: 1024, cpus: 1 }, 'own')
  const rows = await runtime.list()
  const room = rows.find((row) => row.role === undefined)!
  const own = rows.find((row) => row.role === 'own')!
  assert.equal(rows.length, 2)
  assert.equal(room.sessionId, 'seminar')
  assert.equal('role' in room, false)
  assert.equal(room.memoryMb, 3072)
  assert.deepEqual([own.sessionId, own.memoryMb, own.cpus, own.phase], ['seminar', 1024, 1, 'ready'])
})

test("the room's DELETE takes both Pods; the personal one alone goes without touching the class", async () => {
  const { kube, runtime } = setup()
  const room = await runtime.ensure('seminar', { environment: 'base' })
  await runtime.ensure('seminar', { environment: 'base' }, 'own')
  await runtime.remove('seminar', false, 'own')
  assert.deepEqual(kube.deletes.sort(), [`${ns}/pods/${ownName('seminar')}`, `${ns}/services/${ownName('seminar')}`])
  assert.equal((await runtime.ensure('seminar', { environment: 'base' })).instanceId, room.instanceId, 'the class kept its Python')
  await runtime.ensure('seminar', { environment: 'base' }, 'own')
  kube.deletes.length = 0
  await runtime.remove('seminar')
  assert.equal(kube.objects.size, 0)
  assert.equal(kube.deletes.length, 4)
})

test('a permanent retirement closes the personal notebooks too, and cannot be asked of them alone', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('gone', { environment: 'base' })
  await runtime.ensure('gone', { environment: 'base' }, 'own')
  await runtime.remove('gone', true)
  assert.deepEqual([...kube.objects.keys()], [`${ns}/services/${roomName('gone')}`], 'only the reservation stays')
  await assert.rejects(runtime.ensure('gone', { environment: 'base' }, 'own'), (err: any) => err.status === 410)
  await assert.rejects(runtime.ensure('gone', { environment: 'base' }), (err: any) => err.status === 410)
  await assert.rejects(runtime.remove('gone', true, 'own'), (err: any) => err.status === 400)
})

test("a personal Pod's slow start does not hold up the class's own start", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { runtime } = setup(async (endpoint) => {
    if (endpoint.url.includes('-own.')) await gate
    return true
  })
  const personal = runtime.ensure('busy', { environment: 'base' }, 'own')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const room = await Promise.race([
    runtime.ensure('busy', { environment: 'base' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('the room waited behind the personal Pod')), 1000)),
  ])
  assert.ok((room as RuntimeEndpoint).instanceId)
  release()
  await personal
})

test("the room's DELETE cancels a personal start in flight and leaves nothing behind", async () => {
  let entered!: () => void, release!: () => void
  const inside = new Promise<void>((resolve) => (entered = resolve))
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { kube, runtime } = setup(async (endpoint) => {
    if (endpoint.url.includes('-own.')) {
      entered()
      await gate
    }
    return true
  })
  const personal = runtime.ensure('closing', { environment: 'base' }, 'own')
  const refused = assert.rejects(personal, /cancel/i)
  await inside
  const removing = runtime.remove('closing')
  release()
  await refused
  await removing
  assert.equal(kube.objects.size, 0)
})

test('a live personal Pod is resized through its own subresource, never the room\'s', async () => {
  const { kube, runtime } = setup()
  await runtime.ensure('seminar', { environment: 'base' })
  await runtime.ensure('seminar', { environment: 'base', memoryMb: 1024 }, 'own')
  assert.deepEqual(await runtime.resize('seminar', { memoryMb: 3072, cpus: 3 }, 'own'), { outcome: 'applied', memoryMb: 3072, cpus: 3 })
  assert.deepEqual(kube.patches.map((p) => p.path), [`${ns}/pods/${ownName('seminar')}/resize`])
  assert.equal(kube.objects.get(`${ns}/pods/${roomName('seminar')}`)!.spec.containers[0].resources.limits.memory, '2Gi')
  assert.deepEqual(await runtime.resize('nobody', { memoryMb: 3072 }, 'own'), { outcome: 'absent' })
})

test('the HTTP API carries the role in the path and nothing else about it', async () => {
  const calls: string[] = []
  const endpoint = { url: 'http://x:8888', token: 't'.repeat(64), instanceId: 'uid', environment: 'base', revision: `sha256:${digest}` }
  const token = 'k'.repeat(64)
  const server = createRuntimeServer({
    token: () => token,
    catalog: () => catalog,
    controller: {
      health: async () => ({ ok: true, reason: null }),
      list: async () => [{ sessionId: 'room1', instanceId: 'u', phase: 'ready', environment: 'base', revision: `sha256:${digest}`, role: 'own' }],
      ensure: async (id, _intent, role) => (calls.push(`ensure ${id} ${role}`), endpoint),
      resize: async (id, _intent, role) => (calls.push(`resize ${id} ${role}`), { outcome: 'absent' }),
      remove: async (id, permanent, role) => void calls.push(`remove ${id} ${permanent} ${role}`),
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  try {
    assert.equal((await fetch(`${base}/v1/rooms/room1/own`, { method: 'POST', headers, body: '{"environment":"base"}' })).status, 200)
    assert.equal((await fetch(`${base}/v1/rooms/room1/own`, { method: 'PATCH', headers, body: '{"memoryMb":1024}' })).status, 200)
    assert.equal((await fetch(`${base}/v1/rooms/room1/own`, { method: 'DELETE', headers })).status, 200)
    assert.equal((await fetch(`${base}/v1/rooms/room1`, { method: 'DELETE', headers })).status, 200)
    // The role is the path: a body field for it is an unknown field.
    assert.equal((await fetch(`${base}/v1/rooms/room1`, { method: 'POST', headers, body: '{"environment":"base","role":"own"}' })).status, 400)
    // No other sub-route exists.
    assert.equal((await fetch(`${base}/v1/rooms/room1/other`, { method: 'POST', headers, body: '{"environment":"base"}' })).status, 400)
    assert.deepEqual(await (await fetch(`${base}/v1/rooms`, { headers })).json(), {
      rooms: [{ sessionId: 'room1', instanceId: 'u', phase: 'ready', environment: 'base', revision: `sha256:${digest}`, role: 'own' }],
    })
    assert.deepEqual(calls, ['ensure room1 own', 'resize room1 own', 'remove room1 false own', 'remove room1 false room'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  // A permanent retirement of the personal Pod alone is refused by the controller.
  const { runtime } = setup()
  const retire = createRuntimeServer({ token: () => token, catalog: () => catalog, controller: runtime })
  await new Promise<void>((resolve) => retire.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${(retire.address() as { port: number }).port}/v1/rooms/room1/own?retire=true`, { method: 'DELETE', headers })
    assert.equal(response.status, 400)
  } finally {
    retire.closeAllConnections()
    await new Promise<void>((resolve) => retire.close(() => resolve()))
  }
})
