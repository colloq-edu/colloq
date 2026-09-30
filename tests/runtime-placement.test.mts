/**
 * The customer's cluster rules for broker-created Pods (runtime/src/pod-policy.ts).
 *
 * A bank's multi-node Kubernetes is not the single-node k3s the installer
 * builds: ReadWriteOnce volumes attach to one node (colocation with the app),
 * GPU nodes are tainted and labelled, a PriorityClass and policy-engine labels
 * are required, and `pods/resize` may be absent from the Role. Each setting is
 * checked here on the Pod spec the broker sends, and the drift rules on what
 * happens to a LIVE class when a setting changes: it must keep its Python.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeController, roomName } from '../runtime/src/controller.js'
import { CompetitionJobs } from '../runtime/src/competition-jobs.js'
import { loadRuntimeConfig, type WorkloadConfig } from '../runtime/src/config.js'
import { KubernetesError, type KubernetesClient, type KubeObject } from '../runtime/src/kubernetes.js'
import { parseRuntimeCatalog } from '../shared/runtime.js'

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
const base: WorkloadConfig = { namespace: 'colloq', workspaceClaim: 'colloq-workspace', memory: '2Gi', cpu: '2', ephemeral: '2Gi' }
const APP_AFFINITY = {
  podAffinity: {
    requiredDuringSchedulingIgnoredDuringExecution: [
      { labelSelector: { matchLabels: { 'colloq.dev/role': 'app' } }, topologyKey: 'kubernetes.io/hostname' },
    ],
  },
}

/** Kubernetes as far as the broker sees it; `admit` is the cluster's admission, `pending` a Pod not yet started. */
class Cluster implements KubernetesClient {
  objects = new Map<string, KubeObject>()
  creates: KubeObject[] = []
  deletes: string[] = []
  patches: string[] = []
  sequence = 0
  pending = false
  admit: (object: KubeObject) => void = () => {}
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (method === 'POST') {
      const object = structuredClone(body) as KubeObject
      const key = `${path}/${object.metadata.name}`
      if (this.objects.has(key)) throw new KubernetesError(409, 'AlreadyExists')
      object.metadata.uid = `uid-${++this.sequence}`
      object.metadata.resourceVersion = String(this.sequence)
      if (object.kind === 'Pod') {
        this.admit(object)
        object.status = this.pending
          ? { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'SchedulingGated' }] }
          : {
              phase: 'Running',
              conditions: [{ type: 'Ready', status: 'True' }],
              containerStatuses: object.spec.containers.map((c: any) => ({ name: c.name, resources: structuredClone(c.resources) })),
            }
      }
      this.objects.set(key, object)
      this.creates.push(structuredClone(object))
      return structuredClone(object) as T
    }
    if (method === 'PATCH') {
      this.patches.push(path)
      throw new Error('pods/resize must not be called in this test')
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
  pod(id: string, suffix = ''): KubeObject {
    return this.objects.get(`/api/v1/namespaces/colloq/pods/${roomName(id)}${suffix}`)!
  }
}
function broker(config: Partial<WorkloadConfig> = {}, kube = new Cluster()) {
  const runtime = new RuntimeController({
    kube,
    config: { ...base, ...config },
    catalog: () => catalog,
    roomSecret: () => 'secret'.repeat(16),
    probe: async () => true,
    pollMs: 1,
    startupTimeoutMs: 200,
    deletionTimeoutMs: 200,
    resizeTimeoutMs: 20,
  })
  return { kube, runtime }
}

/* ------------------------------------------------------------ defaults */

test('with every setting absent a room Pod is the Pod of 0.9 plus a liveness probe, and nothing else', async () => {
  const { kube, runtime } = broker()
  await runtime.ensure('roomA', { environment: 'base' })
  await runtime.ensure('roomB', { environment: 'gpu' })
  const [plain, gpu] = kube.creates.filter((o) => o.kind === 'Pod')
  for (const field of ['affinity', 'nodeSelector', 'tolerations', 'priorityClassName', 'runtimeClassName'])
    assert.equal(field in plain.spec, false, field)
  // A GPU room still gets the installer's RuntimeClass, and no other placement.
  assert.equal(gpu.spec.runtimeClassName, 'nvidia')
  for (const field of ['affinity', 'nodeSelector', 'tolerations', 'priorityClassName'])
    assert.equal(field in gpu.spec, false, field)
  /*
   * A liveness probe for policy engines that require one: TCP, never HTTP into
   * Jupyter, and five minutes of refused connections before it acts, because
   * with restartPolicy Never it ends the Pod. A long cell never fails it: the
   * kernel is another process and the node completes the handshake.
   */
  for (const pod of [plain, gpu])
    assert.deepEqual(pod.spec.containers[0].livenessProbe, {
      tcpSocket: { port: 8888 }, initialDelaySeconds: 30, periodSeconds: 30, timeoutSeconds: 5, failureThreshold: 10,
    })
  assert.deepEqual(Object.keys(plain.metadata.labels!).sort(), [
    'app.kubernetes.io/managed-by', 'colloq.dev/environment', 'colloq.dev/role', 'colloq.dev/session', 'colloq.kind',
  ])
})

test('room Pods created by 0.9, a plain and a GPU one, are adopted with their Python after the upgrade', async () => {
  /*
   * The template hashes 0.9 wrote for exactly these rooms (release 0.9.0, the
   * same catalog, secret and config). Adoption by them proves that this
   * version's template, without the liveness probe and with a GPU room's
   * RuntimeClass where 0.9 hashed it, is byte for byte the template of 0.9.
   */
  for (const [id, environment, golden] of [
    ['roomA', 'base', '959d915bec6f9927757be7ae39357eebd35db1bb27729c47887cc01b2722da1f'],
    ['roomB', 'gpu', 'd0bea037be7c2eb5d567f39fcf976d4891e63c5bde7a0b31c34b2de7a2c072a7'],
  ] as const) {
    const { kube, runtime } = broker()
    const first = await runtime.ensure(id, { environment })
    const pod = kube.pod(id)
    delete pod.spec.containers[0].livenessProbe
    pod.metadata.annotations!['colloq.dev/template-hash'] = golden
    const again = await runtime.ensure(id, { environment })
    assert.equal(again.instanceId, first.instanceId, environment)
    assert.deepEqual(kube.deletes, [], environment)
    // Held to that template exactly: anything else injected is still a replacement.
    pod.spec.containers[0].livenessProbe = { exec: { command: ['evil'] } }
    assert.notEqual((await runtime.ensure(id, { environment })).instanceId, first.instanceId, environment)
  }
  // Another hash is another template.
  const { kube, runtime } = broker()
  const first = await runtime.ensure('roomC', { environment: 'base' })
  kube.pod('roomC').metadata.annotations!['colloq.dev/template-hash'] = 'f'.repeat(64)
  assert.notEqual((await runtime.ensure('roomC', { environment: 'base' })).instanceId, first.instanceId)
})

/* ------------------------------------------------------------ colocation */

test('colocation puts a required podAffinity to the app on every Pod that mounts a claim, and only when enabled', async () => {
  const { kube, runtime } = broker({ colocateWithApp: true })
  await runtime.ensure('roomA', { environment: 'base' })
  await runtime.ensure('roomA', { environment: 'base' }, 'own')
  for (const pod of kube.creates.filter((o) => o.kind === 'Pod')) assert.deepEqual(pod.spec.affinity, APP_AFFINITY, pod.metadata.name)
  const off = broker()
  await off.runtime.ensure('roomA', { environment: 'base' })
  await off.runtime.ensure('roomA', { environment: 'base' }, 'own')
  for (const pod of off.kube.creates.filter((o) => o.kind === 'Pod')) assert.equal(pod.spec.affinity, undefined)
})

/* ------------------------------------------------------------ competition Pods */

const jobId = 'a'.repeat(32), attemptId = 'b'.repeat(32), revision = `sha256:${'c'.repeat(64)}`
const kaggle = parseRuntimeCatalog({ schemaVersion: 1, release: 'v1', defaultEnvironment: 'kaggle-base', environments: [
  { name: 'kaggle-base', image: `registry.example/kernel@${revision}`, gpu: false },
] })
const limits = { wallSeconds: 120, memoryMb: 1024, cpus: 2, pids: 128, tmpfsMb: 256, targetBytes: 10_000_000 }
function competition(policy: Record<string, unknown>) {
  const created: KubeObject[] = []
  const objects = new Map<string, any>()
  objects.set('/api/v1/namespaces/colloq/persistentvolumeclaims/colloq-data', { metadata: { name: 'colloq-data' } })
  for (const name of ['competition-job-isolation', 'competition-resolver-isolation', 'competition-proxy-isolation'])
    objects.set(`/apis/networking.k8s.io/v1/namespaces/colloq/networkpolicies/${name}`, { metadata: { name } })
  const kube = { async request<T>(method: string, path: string, body?: any): Promise<T> {
    const key = path.split('?')[0]
    if (method === 'GET' && (key.endsWith('/pods') || key.endsWith('/services'))) return { items: [], metadata: {} } as T
    if (method === 'GET') return (objects.get(key) ?? (() => { throw Object.assign(new Error('missing'), { status: 404 }) })()) as T
    if (method === 'POST') {
      const object = { ...body, metadata: { ...body.metadata, uid: `${objects.size + 1}` },
        ...(body.metadata?.labels?.['colloq.dev/role'] === 'competition-proxy' ? { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } } : {}) }
      objects.set(`${key}/${object.metadata.name}`, object)
      if (object.kind === 'Pod') created.push(object)
      return object as T
    }
    return {} as T
  } }
  const jobs = new CompetitionJobs({ kube, catalog: () => kaggle, secret: () => 'x'.repeat(64),
    config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage: `registry.example/runtime@sha256:${'d'.repeat(64)}`, instanceId: 'instance123', ...policy } })
  return { jobs, created }
}

test('competition job and resolver Pods mount the data claim and are co-located; the package proxy is not', async () => {
  const { jobs, created } = competition({ colocateWithApp: true, priorityClass: 'colloq-batch' })
  await jobs.start(jobId, { schemaVersion: 1, jobId, kind: 'notebook', environment: 'kaggle-base', revision, limits, competitionId: 'abcd2345', submissionId: 'efgh2345', attemptId })
  const resolverJob = 'e'.repeat(32)
  await jobs.start(resolverJob, { schemaVersion: 1, jobId: resolverJob, kind: 'resolve', environment: 'kaggle-base', revision, limits, preparationId: attemptId })
  const byRole = (role: string) => created.filter((pod) => pod.metadata.labels?.['colloq.dev/role'] === role)
  const [job] = byRole('competition-job'), [resolver] = byRole('competition-resolver'), [proxy] = byRole('competition-proxy')
  for (const pod of [job, resolver]) {
    assert.ok(pod.spec.volumes.some((v: any) => v.persistentVolumeClaim?.claimName === 'colloq-data'), 'mounts the data claim')
    assert.deepEqual(pod.spec.affinity, APP_AFFINITY)
  }
  assert.equal(proxy.spec.volumes.some((v: any) => v.persistentVolumeClaim), false)
  assert.equal(proxy.spec.affinity, undefined, 'a Pod without a claim is free to run anywhere')
  for (const pod of [job, resolver, proxy]) assert.equal(pod.spec.priorityClassName, 'colloq-batch')
  // Without the rooms' placement set, nobody gets a node selector.
  for (const pod of [job, resolver, proxy]) assert.equal(pod.spec.nodeSelector, undefined)
  /*
   * Probes where they are cheap and safe: TCP liveness on the two servers (the
   * exporter, the package proxy). The batch `main` gets none: it has no
   * endpoint, and a probe could only end a legitimate long run.
   */
  const container = (pod: KubeObject, name: string) => pod.spec.containers.find((c: any) => c.name === name)
  for (const pod of [job, resolver]) {
    assert.deepEqual(container(pod, 'exporter').livenessProbe.tcpSocket, { port: 8765 })
    assert.ok(container(pod, 'exporter').readinessProbe)
    assert.equal(container(pod, 'main').livenessProbe, undefined)
  }
  assert.deepEqual(container(proxy, 'proxy').livenessProbe, { tcpSocket: { port: 3128 }, initialDelaySeconds: 10, periodSeconds: 20, timeoutSeconds: 5, failureThreshold: 6 })
})

test("student code goes where rooms go: job and resolver Pods take the rooms' node selector and tolerations, the proxy does not", async () => {
  const toleration = { key: 'colloq/students', operator: 'Exists', effect: 'NoSchedule' }
  const { jobs, created } = competition({ studentNodeSelector: { pool: 'students' }, studentTolerations: [toleration] })
  await jobs.start(jobId, { schemaVersion: 1, jobId, kind: 'notebook', environment: 'kaggle-base', revision, limits, competitionId: 'abcd2345', submissionId: 'efgh2345', attemptId })
  const resolverJob = 'f'.repeat(32)
  await jobs.start(resolverJob, { schemaVersion: 1, jobId: resolverJob, kind: 'resolve', environment: 'kaggle-base', revision, limits, preparationId: attemptId })
  const byRole = (role: string) => created.filter((pod) => pod.metadata.labels?.['colloq.dev/role'] === role)
  const [job] = byRole('competition-job'), [resolver] = byRole('competition-resolver'), [proxy] = byRole('competition-proxy')
  for (const pod of [job, resolver]) {
    assert.deepEqual(pod.spec.nodeSelector, { pool: 'students' })
    assert.deepEqual(pod.spec.tolerations, [toleration])
  }
  assert.equal(proxy.spec.nodeSelector, undefined, 'the package proxy runs no student code')
  assert.equal(proxy.spec.tolerations, undefined)
})

/* ------------------------------------------------------------ GPU and room placement */

test('the GPU RuntimeClass is a setting: a name, or none at all when empty', async () => {
  const named = broker({ gpuRuntimeClass: 'nvidia-cdi' })
  await named.runtime.ensure('gpuRoom', { environment: 'gpu' })
  await named.runtime.ensure('cpuRoom', { environment: 'base' })
  const [gpu, cpu] = named.kube.creates.filter((o) => o.kind === 'Pod')
  assert.equal(gpu.spec.runtimeClassName, 'nvidia-cdi')
  assert.equal(cpu.spec.runtimeClassName, undefined)
  const none = broker({ gpuRuntimeClass: '' })
  await none.runtime.ensure('gpuRoom', { environment: 'gpu' })
  const [plain] = none.kube.creates.filter((o) => o.kind === 'Pod')
  assert.equal('runtimeClassName' in plain.spec, false)
  assert.equal(plain.spec.containers[0].resources.limits['nvidia.com/gpu'], 1, 'the card is still requested')
})

test('room placement reaches room and personal Pods; GPU placement only GPU rooms; the operator priority class all', async () => {
  const toleration = { key: 'dedicated', operator: 'Equal', value: 'edu', effect: 'NoSchedule' } as const
  const gpuToleration = { key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' } as const
  const { kube, runtime } = broker({
    roomNodeSelector: { 'node-role.example/edu': 'true' },
    roomTolerations: [toleration],
    gpuNodeSelector: { 'nvidia.com/gpu.present': 'true' },
    gpuTolerations: [gpuToleration],
    priorityClass: 'colloq-rooms',
  })
  await runtime.ensure('cpuRoom', { environment: 'base' })
  await runtime.ensure('gpuRoom', { environment: 'gpu' })
  await runtime.ensure('gpuRoom', { environment: 'gpu' }, 'own')
  const [cpu, gpu, own] = kube.creates.filter((o) => o.kind === 'Pod')
  assert.deepEqual(cpu.spec.nodeSelector, { 'node-role.example/edu': 'true' })
  assert.deepEqual(cpu.spec.tolerations, [toleration])
  assert.deepEqual(gpu.spec.nodeSelector, { 'node-role.example/edu': 'true', 'nvidia.com/gpu.present': 'true' })
  assert.deepEqual(gpu.spec.tolerations, [toleration, gpuToleration])
  // A personal notebook never has the class's card, so none of the GPU placement either.
  assert.deepEqual(own.spec.nodeSelector, { 'node-role.example/edu': 'true' })
  assert.deepEqual(own.spec.tolerations, [toleration])
  assert.equal(own.spec.runtimeClassName, undefined)
  for (const pod of [cpu, gpu, own]) assert.equal(pod.spec.priorityClassName, 'colloq-rooms')
})

/* ------------------------------------------------------------ labels and annotations */

test("the operator's labels and annotations reach every broker Pod under the broker's own, and never the selectors", async () => {
  const policy = {
    podLabels: { 'app.kubernetes.io/part-of': 'colloq', 'cost-center': 'edu-42' },
    podAnnotations: { 'policy.example/owner': 'edu-platform' },
  }
  const { kube, runtime } = broker(policy)
  await runtime.ensure('roomA', { environment: 'base' })
  await runtime.ensure('roomA', { environment: 'base' }, 'own')
  for (const pod of kube.creates.filter((o) => o.kind === 'Pod')) {
    assert.equal(pod.metadata.labels!['cost-center'], 'edu-42')
    assert.equal(pod.metadata.labels!['app.kubernetes.io/part-of'], 'colloq')
    assert.equal(pod.metadata.labels!['colloq.dev/role'], 'kernel')
    assert.equal(pod.metadata.annotations!['policy.example/owner'], 'edu-platform')
    assert.equal(pod.metadata.annotations!['colloq.dev/session-id'], 'roomA')
  }
  // Services are selectors: the operator's labels stay out of them.
  for (const service of kube.creates.filter((o) => o.kind === 'Service')) {
    assert.equal(service.spec.selector['cost-center'], undefined)
    assert.equal(service.metadata.labels!['cost-center'], undefined)
  }
  const jobs = competition(policy)
  await jobs.jobs.start(jobId, { schemaVersion: 1, jobId, kind: 'notebook', environment: 'kaggle-base', revision, limits, competitionId: 'abcd2345', submissionId: 'efgh2345', attemptId })
  const [job] = jobs.created
  assert.equal(job.metadata.labels!['cost-center'], 'edu-42')
  assert.equal(job.metadata.labels!['colloq.dev/job'], jobId)
  assert.equal(job.metadata.annotations!['policy.example/owner'], 'edu-platform')
  assert.ok(job.metadata.annotations!['colloq.dev/intent'])
})

/* ------------------------------------------------------------ configuration */

function env(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-policy-'))
  const secret = join(dir, 'secret'), catalogFile = join(dir, 'catalog')
  writeFileSync(secret, randomBytes(32).toString('hex'))
  writeFileSync(catalogFile, JSON.stringify(catalog))
  return {
    dir,
    values: { RUNTIME_TOKEN_FILE: secret, RUNTIME_ROOM_SECRET_FILE: secret, RUNTIME_CATALOG_FILE: catalogFile, ...extra },
  }
}

test('settings are read at start: defaults are the single-node k3s, and each value is parsed into the Pod policy', () => {
  const { dir, values } = env()
  try {
    const defaults = loadRuntimeConfig(values, 16384)
    assert.equal(defaults.colocateWithApp, false)
    assert.equal(defaults.inPlaceResize, true)
    assert.equal(defaults.gpuRuntimeClass, 'nvidia')
    assert.equal(defaults.priorityClass, '')
    assert.deepEqual([defaults.podLabels, defaults.podAnnotations, defaults.roomNodeSelector, defaults.gpuNodeSelector], [{}, {}, {}, {}])
    assert.deepEqual([defaults.roomTolerations, defaults.gpuTolerations], [[], []])
    const set = loadRuntimeConfig({
      ...values,
      RUNTIME_COLOCATE_WITH_APP: '1',
      RUNTIME_IN_PLACE_RESIZE: '0',
      RUNTIME_GPU_RUNTIME_CLASS: '',
      RUNTIME_PRIORITY_CLASS: 'colloq-rooms',
      RUNTIME_POD_LABELS: '{"cost-center":"edu-42"}',
      RUNTIME_POD_ANNOTATIONS: '{"policy.example/owner":"edu platform, room 5"}',
      RUNTIME_ROOM_NODE_SELECTOR: '{"node-role.example/edu":"true"}',
      RUNTIME_ROOM_TOLERATIONS: '[{"key":"dedicated","operator":"Equal","value":"edu","effect":"NoSchedule"}]',
      RUNTIME_GPU_NODE_SELECTOR: '{"nvidia.com/gpu.present":"true"}',
      RUNTIME_GPU_TOLERATIONS: '[{"key":"nvidia.com/gpu","operator":"Exists","effect":"NoExecute","tolerationSeconds":60}]',
    }, 16384)
    assert.equal(set.colocateWithApp, true)
    assert.equal(set.inPlaceResize, false)
    assert.equal(set.gpuRuntimeClass, '', 'empty means no RuntimeClass, not the default')
    assert.equal(set.priorityClass, 'colloq-rooms')
    assert.deepEqual(set.podLabels, { 'cost-center': 'edu-42' })
    assert.deepEqual(set.gpuTolerations, [{ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 60 }])
    assert.equal(loadRuntimeConfig({ ...values, RUNTIME_COLOCATE_WITH_APP: 'true' }, 16384).colocateWithApp, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a wrong setting stops the broker at start with the variable named, and reserved keys cannot be overridden', () => {
  const { dir, values } = env()
  try {
    const refused: Array<[Record<string, string>, RegExp]> = [
      [{ RUNTIME_COLOCATE_WITH_APP: 'yes' }, /RUNTIME_COLOCATE_WITH_APP must be 0 or 1/],
      [{ RUNTIME_IN_PLACE_RESIZE: '2' }, /RUNTIME_IN_PLACE_RESIZE must be 0 or 1/],
      [{ RUNTIME_POD_LABELS: '{"colloq.dev/role":"app"}' }, /RUNTIME_POD_LABELS: "colloq.dev\/role" is reserved/],
      [{ RUNTIME_POD_LABELS: '{"colloq.kind":"room-kernel"}' }, /reserved/],
      [{ RUNTIME_POD_LABELS: '{"app.kubernetes.io/managed-by":"Helm"}' }, /reserved/],
      [{ RUNTIME_POD_ANNOTATIONS: '{"colloq.dev/template-hash":"x"}' }, /RUNTIME_POD_ANNOTATIONS: .* is reserved/],
      [{ RUNTIME_POD_ANNOTATIONS: '{"container.apparmor.security.beta.kubernetes.io/kernel":"unconfined"}' }, /security profile/],
      [{ RUNTIME_POD_LABELS: '{"team":7}' }, /value of "team" must be a string/],
      [{ RUNTIME_POD_LABELS: '{"team":"has spaces"}' }, /not a valid Kubernetes label value/],
      [{ RUNTIME_POD_LABELS: '{"bad key":"x"}' }, /not a valid Kubernetes label key/],
      [{ RUNTIME_POD_LABELS: '["team"]' }, /must be a JSON object/],
      [{ RUNTIME_ROOM_NODE_SELECTOR: '{nope' }, /RUNTIME_ROOM_NODE_SELECTOR is not valid JSON/],
      [{ RUNTIME_ROOM_TOLERATIONS: '{"key":"x"}' }, /must be a JSON array/],
      [{ RUNTIME_ROOM_TOLERATIONS: '[{"key":"x","operator":"Exists","value":"y"}]' }, /Exists takes no value/],
      [{ RUNTIME_ROOM_TOLERATIONS: '[{"operator":"Equal","value":"y"}]' }, /without a key must use operator Exists/],
      [{ RUNTIME_ROOM_TOLERATIONS: '[{"key":"x","effect":"NoSchedule","tolerationSeconds":5}]' }, /needs effect NoExecute/],
      [{ RUNTIME_GPU_TOLERATIONS: '[{"key":"x","operator":"Exists","effect":"Evict"}]' }, /RUNTIME_GPU_TOLERATIONS\[0\]: effect/],
      [{ RUNTIME_GPU_TOLERATIONS: '[{"key":"x","operator":"Exists","nodeName":"n"}]' }, /unknown field "nodeName"/],
      [{ RUNTIME_PRIORITY_CLASS: 'system-node-critical' }, /reserved for cluster components/],
      [{ RUNTIME_PRIORITY_CLASS: 'Not A Name' }, /RUNTIME_PRIORITY_CLASS must be a PriorityClass name/],
      [{ RUNTIME_GPU_RUNTIME_CLASS: 'NVIDIA!' }, /RUNTIME_GPU_RUNTIME_CLASS must be a RuntimeClass name/],
      [{ RUNTIME_POD_LABELS: JSON.stringify({ x: 'y'.repeat(20000) }) }, /exceeds 16384 bytes/],
    ]
    for (const [extra, message] of refused)
      assert.throws(() => loadRuntimeConfig({ ...values, ...extra }, 16384), message, JSON.stringify(extra))
    // Node selector keys are node labels: a colloq.* node label is someone's choice, not a broker selector.
    assert.deepEqual(loadRuntimeConfig({ ...values, RUNTIME_ROOM_NODE_SELECTOR: '{"colloq.dev/pool":"rooms"}' }, 16384).roomNodeSelector, { 'colloq.dev/pool': 'rooms' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------ drift */

test('a changed placement setting never takes a running class its Python; its next Pod follows the setting', async () => {
  const kube = new Cluster()
  const before = await broker({}, kube).runtime.ensure('liveRoom', { environment: 'gpu' })
  // The operator turns colocation on, pins rooms to a pool, adds a priority,
  // renames the GPU RuntimeClass, and the broker restarts with it.
  const changed = broker({
    colocateWithApp: true,
    roomNodeSelector: { pool: 'edu' },
    roomTolerations: [{ key: 'dedicated', operator: 'Exists' }],
    priorityClass: 'colloq-rooms',
    gpuRuntimeClass: 'nvidia-cdi',
  }, kube).runtime
  const warn = console.warn, warned: string[] = []
  console.warn = (...args: unknown[]) => void warned.push(args.join(' '))
  try {
    const after = await changed.ensure('liveRoom', { environment: 'gpu' })
    await changed.ensure('liveRoom', { environment: 'gpu' })
    assert.equal(after.instanceId, before.instanceId, 'the class keeps its Pod and its variables')
    assert.deepEqual(kube.deletes, [])
    assert.equal(warned.filter((line) => /earlier configuration/.test(line)).length, 1, 'said once per Pod, not per run')
  } finally {
    console.warn = warn
  }
  // Once the room stops, its next Pod is placed by the current setting.
  await changed.remove('liveRoom')
  await changed.ensure('liveRoom', { environment: 'gpu' })
  const next = kube.pod('liveRoom')
  assert.deepEqual(next.spec.affinity, APP_AFFINITY)
  assert.deepEqual(next.spec.nodeSelector, { pool: 'edu' })
  assert.equal(next.spec.priorityClassName, 'colloq-rooms')
  assert.equal(next.spec.runtimeClassName, 'nvidia-cdi')
})

test('a Pod that has not started under the old placement is replaced: no Python to lose, and the new placement may be what lets it start', async () => {
  const kube = new Cluster()
  kube.pending = true
  // An ensure of the old broker left a Pod that never started (a ReadWriteOnce
  // volume attached on another node: Multi-Attach, ContainerCreating).
  await assert.rejects(broker({}, kube).runtime.ensure('stuck', { environment: 'base' }), /timed out/)
  const stuck = kube.pod('stuck').metadata.uid
  kube.pending = false
  const endpoint = await broker({ colocateWithApp: true }, kube).runtime.ensure('stuck', { environment: 'base' })
  assert.notEqual(endpoint.instanceId, stuck)
  assert.deepEqual(kube.pod('stuck').spec.affinity, APP_AFFINITY)
})

test('placement the cluster fills in at admission is not "a different workload": no 409 right after the broker created the Pod', async () => {
  const { kube, runtime } = broker({ priorityClass: 'colloq-rooms', gpuRuntimeClass: 'nvidia' })
  kube.admit = (pod) => {
    Object.assign(pod.spec, {
      priority: 100000,
      preemptionPolicy: 'Never',
      schedulerName: 'volcano',
      overhead: { cpu: '250m', memory: '120Mi' },
      schedulingGates: [{ name: 'kueue.x-k8s.io/admission' }],
      topologySpreadConstraints: [{ maxSkew: 1, topologyKey: 'zone', whenUnsatisfiable: 'ScheduleAnyway' }],
      nodeSelector: { ...pod.spec.nodeSelector, 'namespace-default/pool': 'edu' },
      tolerations: [...(pod.spec.tolerations ?? []), { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 }],
    })
  }
  const first = await runtime.ensure('admitted', { environment: 'gpu' })
  assert.equal((await runtime.ensure('admitted', { environment: 'gpu' })).instanceId, first.instanceId)
  // A cluster whose global default PriorityClass the Priority plugin writes into a Pod that named none.
  const plain = broker()
  plain.kube.admit = (pod) => Object.assign(pod.spec, { priorityClassName: 'cluster-default', priority: 1000 })
  const created = await plain.runtime.ensure('defaulted', { environment: 'base' })
  assert.equal((await plain.runtime.ensure('defaulted', { environment: 'base' })).instanceId, created.instanceId)
})

test('a workload the cluster rewrote at admission is still refused, and the log names the fields, never the token', async () => {
  for (const [rewrite, field] of [
    [(pod: KubeObject) => { pod.spec.containers[0].imagePullPolicy = 'Always' }, 'spec.containers[0].imagePullPolicy'],
    [(pod: KubeObject) => { pod.spec.containers.push({ name: 'istio-proxy', image: 'proxy' }) }, 'spec.containers[1]'],
  ] as const) {
    const { kube, runtime } = broker()
    kube.admit = rewrite
    const warn = console.warn, warned: string[] = []
    console.warn = (...args: unknown[]) => void warned.push(args.join(' '))
    try {
      await assert.rejects(runtime.ensure('mutated', { environment: 'base' }), /does not match the requested workload policy/)
    } finally {
      console.warn = warn
    }
    const line = warned.find((entry) => /changed at admission/.test(entry)) ?? ''
    assert.ok(line.includes(field), line)
    const token = kube.pod('mutated').spec.containers[0].env.find((e: any) => e.name === 'JUPYTER_TOKEN').value
    assert.equal(line.includes(token), false)
  }
})

/* ------------------------------------------------------------ in-place resize off */

test('with in-place resize off the broker never calls pods/resize: a live room keeps its Python and a resize is 501', async () => {
  const { kube, runtime } = broker({ inPlaceResize: false })
  assert.deepEqual(await runtime.resize('cold', { memoryMb: 4096 }), { outcome: 'absent' }, 'no Pod: the next start takes it')
  const first = await runtime.ensure('live', { environment: 'base', memoryMb: 2048 })
  await assert.rejects(runtime.resize('live', { memoryMb: 4096 }), (err: any) => err.status === 501 && /RUNTIME_IN_PLACE_RESIZE=0/.test(err.message))
  await assert.rejects(runtime.resize('live', { cpus: 4 }), (err: any) => err.status === 501)
  // Nothing to change is not a change: the numbers it already has.
  assert.deepEqual(await runtime.resize('live', { memoryMb: 2048 }), { outcome: 'applied', memoryMb: 2048 })
  // An ensure with new numbers adopts the Pod as it is: no resize, no replacement.
  const again = await runtime.ensure('live', { environment: 'base', memoryMb: 4096, cpus: 4 })
  assert.equal(again.instanceId, first.instanceId)
  assert.deepEqual(kube.patches, [])
  assert.deepEqual(kube.deletes, [])
  assert.equal((await runtime.health()).inPlaceResize, false)
  // The Pod's next incarnation takes the new numbers.
  await runtime.remove('live')
  await runtime.ensure('live', { environment: 'base', memoryMb: 4096, cpus: 4 })
  assert.equal(kube.pod('live').spec.containers[0].resources.limits.memory, '4096Mi')
})
