import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { parseRuntimeCatalog } from '../shared/runtime.js'
import { parseCompetitionJobStatus } from '../shared/competition-runtime.js'
import { CompetitionJobs, type CompetitionJobConfig } from '../runtime/src/competition-jobs.js'
import { createRuntimeServer } from '../runtime/src/http.js'
import { KubernetesError, type KubernetesRefusal } from '../runtime/src/kubernetes.js'

const jobId = 'a'.repeat(32), attemptId = 'b'.repeat(32), revision = `sha256:${'c'.repeat(64)}`
const exporterImage = `registry.example/runtime@sha256:${'d'.repeat(64)}`
const catalog = parseRuntimeCatalog({ schemaVersion: 1, release: 'v1', defaultEnvironment: 'kaggle-base', environments: [
  { name: 'kaggle-base', image: `registry.example/kernel@${revision}`, gpu: false },
] })
const limits = { wallSeconds: 120, memoryMb: 1024, cpus: 2, pids: 128, tmpfsMb: 256, targetBytes: 10_000_000 }
const intent = (kind: 'notebook' | 'metric' | 'inventory' | 'resolve' | 'verify') => ({ schemaVersion: 1 as const, jobId, kind, environment: 'kaggle-base', revision, limits,
  ...(kind === 'notebook' || kind === 'metric' ? { competitionId: 'abcd2345', submissionId: 'efgh2345', attemptId } : {}),
  ...(kind === 'resolve' || kind === 'verify' ? { preparationId: attemptId } : {}),
})

function setup(exporter: (url: string, token: string, method: 'GET' | 'POST', payload?: unknown) => Promise<unknown> = async () => ({ files: [], totalBytes: 0 }), now = Date.now()) {
  const calls: { method: string; path: string; body: any }[] = []
  const objects = new Map<string, any>()
  objects.set('/api/v1/namespaces/colloq/persistentvolumeclaims/colloq-data', { metadata: { name: 'colloq-data' } })
  for (const name of ['competition-job-isolation', 'competition-resolver-isolation', 'competition-proxy-isolation'])
    objects.set(`/apis/networking.k8s.io/v1/namespaces/colloq/networkpolicies/${name}`, { metadata: { name } })
  objects.set('/api/v1/namespaces/colloq/services', { items: [] })
  const kube = { async request<T>(method: string, path: string, body?: any): Promise<T> {
    calls.push({ method, path, body })
    const key = path.split('?')[0]
    if (method === 'GET' && key.endsWith('/pods')) return { items: [...objects.values()].filter(x => x.kind === 'Pod'), metadata: {} } as T
    if (method === 'GET' && key.endsWith('/services')) return { items: [...objects.values()].filter(x => x.kind === 'Service'), metadata: {} } as T
    if (method === 'GET') return (objects.get(key) ?? (() => { throw Object.assign(new Error('missing'), { status: 404 }) })()) as T
    if (method === 'POST') {
      const object = { ...body, metadata: { ...body.metadata, uid: `${objects.size + 1}`, creationTimestamp: new Date().toISOString() },
        ...(body.metadata?.labels?.['colloq.dev/role'] === 'competition-proxy' ? { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } } : {}) }
      if (objects.has(`${key}/${object.metadata.name}`)) throw Object.assign(new Error('exists'), { status: 409 })
      objects.set(`${key}/${object.metadata.name}`, object)
      return object as T
    }
    if (method === 'DELETE') { objects.delete(key); return {} as T }
    if (method === 'PATCH') { const object = objects.get(key); Object.assign(object.metadata.annotations, body.metadata.annotations); return object as T }
    throw new Error(`Unexpected ${method} ${path}`)
  } }
  const jobs = new CompetitionJobs({ kube, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage, instanceId: 'instance123' }, catalog: () => catalog, secret: () => 'x'.repeat(64), exporter, now: () => now })
  return { jobs, calls, objects, kube }
}

async function runOfflineProbe(sequence: boolean[]): Promise<{ exit: number; attempts: number; elapsed: number }> {
  const { jobs, calls } = setup()
  await jobs.start(jobId, intent('notebook'))
  const pod = calls.find(c => c.method === 'POST' && c.path.endsWith('/pods'))!.body
  const script = pod.spec.initContainers[0].command[3]
  const harness = String.raw`import json,sys,types
values=json.loads(sys.argv[2]); state={'attempts':0,'elapsed':0}
socket=types.ModuleType('socket')
class Connection:
    def close(self): pass
def connect(address,timeout):
    index=state['attempts']; state['attempts']+=1
    if values[min(index,len(values)-1)]: return Connection()
    raise OSError('network policy denied')
socket.create_connection=connect
time=types.ModuleType('time')
time.monotonic=lambda: state['elapsed']
def sleep(seconds): state['elapsed']+=seconds
time.sleep=sleep
sys.modules['socket']=socket;sys.modules['time']=time
exit_code=0
try: exec(sys.argv[1],{'__name__':'__main__'})
except SystemExit as error: exit_code=error.code
print(json.dumps({'exit':exit_code,'attempts':state['attempts'],'elapsed':state['elapsed']}))`
  const result = spawnSync('python3', ['-I', '-c', harness, script, JSON.stringify(sequence)],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('egress init waits through early policy propagation and requires consecutive denials', async () => {
  const late = await runOfflineProbe([true, true, false, false, false])
  assert.deepEqual(late, { exit: 0, attempts: 5, elapsed: 4 })
  const interrupted = await runOfflineProbe([false, false, true, false, false, false])
  assert.equal(interrupted.exit, 0)
  assert.equal(interrupted.attempts, 6)
})

test('egress init fails closed within a bounded wait when outside access persists', async () => {
  const reachable = await runOfflineProbe([true])
  assert.equal(reachable.exit, 41)
  assert.ok(reachable.attempts >= 25 && reachable.attempts <= 32)
  assert.ok(reachable.elapsed <= 30)
  assert.deepEqual(await runOfflineProbe([false]), { exit: 0, attempts: 3, elapsed: 2 })
})

test('notebook Pod isolates public inputs and writable exporter PVC', async () => {
  const { jobs, calls } = setup()
  await jobs.start(jobId, intent('notebook'))
  const pod = calls.find(c => c.method === 'POST' && c.path.endsWith('/pods'))!.body
  assert.equal(pod.spec.automountServiceAccountToken, false)
  assert.equal(pod.spec.containers.length, 2)
  const [main, exporter] = pod.spec.containers
  assert.equal(main.image, `registry.example/kernel@${revision}`)
  assert.equal(exporter.image, exporterImage)
  assert.equal(main.securityContext.readOnlyRootFilesystem, true)
  assert.equal(main.securityContext.runAsUser, 1000)
  assert.deepEqual(main.securityContext.capabilities.drop, ['ALL'])
  // Student code reads the data claim only; the exporter alone writes, into
  // its own subPath.
  assert.ok(main.volumeMounts.filter((m: any) => m.name === 'data').every((m: any) => m.readOnly === true))
  // One volume for the claim, mounted at every path: two volumes naming the
  // same claim hang a 1.31 node in ContainerCreating.
  assert.equal(pod.spec.volumes.filter((v: any) => v.persistentVolumeClaim).length, 1)
  assert.ok(main.volumeMounts.some((m: any) => m.subPath === 'competitions/abcd2345/data'))
  assert.ok(main.volumeMounts.some((m: any) => m.subPath === 'competitions/abcd2345/s/efgh2345/in'))
  assert.ok(!main.volumeMounts.some((m: any) => String(m.subPath).includes('secret')))
  assert.ok(exporter.volumeMounts.some((m: any) => m.mountPath === '/result' && m.subPath === `competitions/abcd2345/s/efgh2345/attempts/${attemptId}/result`))
  assert.ok(exporter.env.some((e: any) => e.name === 'COMP_EXPORT_TOKEN'))
  assert.ok(!main.env.some((e: any) => e.name === 'COMP_EXPORT_TOKEN'))
  assert.ok(pod.spec.volumes.some((v: any) => v.name === 'out' && v.emptyDir.medium === 'Memory'))
})

test('status follows main termination, and collection is authenticated and bounded', async () => {
  const requests: any[] = []
  const { jobs, objects, calls } = setup(async (url, token, method, payload) => {
    requests.push({ url, token, method, payload })
    return method === 'GET' ? { progress: { phase: 'notebook', cell: 2, cells: 3, outputBytes: 42 } }
      : { files: [{ name: 'run.json', bytes: 3, sha256: 'f'.repeat(64) }], totalBytes: 3 }
  })
  await jobs.start(jobId, intent('notebook'))
  const key = `/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`
  const pod = objects.get(key)
  pod.status = { podIP: '10.0.0.8', containerStatuses: [{ name: 'main', state: { running: { startedAt: new Date().toISOString() } } }] }
  assert.equal((await jobs.status(jobId)).progress?.cell, 2)
  await assert.rejects(() => jobs.collect(jobId), /running/i)
  pod.status.containerStatuses[0].state = { terminated: { exitCode: 0, finishedAt: new Date().toISOString() } }
  assert.equal((await jobs.status(jobId)).phase, 'exporting')
  assert.equal((await jobs.collect(jobId)).files[0].name, 'run.json')
  assert.equal((await jobs.status(jobId)).phase, 'complete')
  assert.equal(requests.at(-1).method, 'POST')
  assert.equal(requests.at(-1).payload.kind, 'notebook')
  assert.ok(requests.at(-1).token.length >= 64)
  assert.ok(!calls.some(c => c.method === 'PATCH'))
})

test('broker rejects exporter metadata outside the job artifact allowlist', async () => {
  const { jobs, objects } = setup(async () => ({ files: [{ name: 'score.json', bytes: 1, sha256: 'f'.repeat(64) }], totalBytes: 1 }))
  await jobs.start(jobId, intent('notebook'))
  const pod = objects.get(`/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`)
  pod.status = { podIP: '10.0.0.8', containerStatuses: [{ name: 'main', state: { terminated: { exitCode: 0 } } }] }
  await assert.rejects(() => jobs.collect(jobId), /metadata|artifact|allowlist/i)
})

test('notebook collection allows bounded executed notebook alongside target CSV', async () => {
  const { jobs, objects } = setup(async () => ({ files: [
    { name: 'submission.csv', bytes: 9_000_000, sha256: 'f'.repeat(64) },
    { name: 'executed.ipynb', bytes: 9_000_000, sha256: 'e'.repeat(64) },
  ], totalBytes: 18_000_000 }))
  await jobs.start(jobId, intent('notebook'))
  objects.get(`/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`).status = {
    podIP: '10.0.0.8', containerStatuses: [{ name: 'main', state: { terminated: { exitCode: 0 } } }],
  }
  assert.equal((await jobs.collect(jobId)).totalBytes, 18_000_000)
})

test('failed main asks exporter for incomplete bounded artifacts', async () => {
  let payload: any
  const { jobs, objects } = setup(async (_url, _token, method, body) => {
    if (method === 'POST') payload = body
    return { files: [], totalBytes: 0 }
  })
  await jobs.start(jobId, intent('resolve'))
  objects.get(`/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`).status = {
    podIP: '10.0.0.8', containerStatuses: [{ name: 'main', state: { terminated: { exitCode: 1 } } }],
  }
  assert.equal((await jobs.collect(jobId)).totalBytes, 0)
  assert.deepEqual(payload, { kind: 'resolve', targetBytes: limits.targetBytes, allowIncomplete: true })
})

test('cancel deletes only matching owned Pod and its own proxy resources', async () => {
  const { jobs, objects, calls } = setup()
  await jobs.start(jobId, intent('resolve'))
  assert.equal((await jobs.list()).length, 1)
  await jobs.cancel(jobId)
  assert.equal((await jobs.list()).length, 0)
  assert.ok(![...objects.values()].some(object => object.kind === 'Pod' || object.kind === 'Service'))
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 3)
})

test('restart reconciliation removes only aged orphan proxy resources owned by this instance', async () => {
  const now = Date.now()
  const { jobs, objects, calls, kube } = setup(undefined, now)
  await jobs.start(jobId, intent('resolve'))
  objects.delete(`/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`)
  const other = structuredClone(objects.get(`/api/v1/namespaces/colloq/pods/colloq-proxy-${jobId}`))
  other.metadata.name = `colloq-proxy-${'f'.repeat(32)}`
  other.metadata.labels['colloq.dev/job'] = 'f'.repeat(32)
  other.metadata.labels['colloq.dev/instance'] = 'another-instance'
  objects.set(`/api/v1/namespaces/colloq/pods/${other.metadata.name}`, other)
  const later = new CompetitionJobs({ kube, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage, instanceId: 'instance123' },
    catalog: () => catalog, secret: () => 'x'.repeat(64), now: () => now + 180_000 })
  await later.reconcile()
  assert.ok(!objects.has(`/api/v1/namespaces/colloq/pods/colloq-proxy-${jobId}`))
  assert.ok(objects.has(`/api/v1/namespaces/colloq/pods/${other.metadata.name}`))
  assert.ok(calls.filter(c => c.method === 'DELETE').every(c => !c.path.includes(other.metadata.name)))
})

test('reconciliation preserves a valid four-hour job beyond two hours', async () => {
  const began = Date.now() - 3 * 3600_000
  const { jobs, objects, kube } = setup(undefined, began)
  await jobs.start(jobId, { ...intent('notebook'), limits: { ...limits, wallSeconds: 14400 } })
  const key = `/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`
  const later = new CompetitionJobs({ kube, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage, instanceId: 'instance123' },
    catalog: () => catalog, secret: () => 'x'.repeat(64), now: () => began + 3 * 3600_000 })
  await later.reconcile()
  assert.ok(objects.has(key))
})

test('health separates execution from resolver policy readiness', async () => {
  const { jobs, objects } = setup()
  objects.delete('/api/v1/namespaces/colloq/persistentvolumeclaims/colloq-data')
  objects.delete('/apis/networking.k8s.io/v1/namespaces/colloq/networkpolicies/competition-job-isolation')
  objects.delete('/apis/networking.k8s.io/v1/namespaces/colloq/networkpolicies/competition-resolver-isolation')
  objects.delete('/apis/networking.k8s.io/v1/namespaces/colloq/networkpolicies/competition-proxy-isolation')
  objects.delete('/api/v1/namespaces/colloq/services')
  assert.equal((await jobs.health()).execution.available, false)
  objects.set('/api/v1/namespaces/colloq/persistentvolumeclaims/colloq-data', { metadata: { name: 'colloq-data' } })
  objects.set('/apis/networking.k8s.io/v1/namespaces/colloq/networkpolicies/competition-job-isolation', { metadata: { name: 'competition-job-isolation' } })
  assert.equal((await jobs.health()).execution.available, true)
  assert.equal((await jobs.health()).preparation.available, false)
  for (const name of ['competition-resolver-isolation', 'competition-proxy-isolation'])
    objects.set(`/apis/networking.k8s.io/v1/namespaces/colloq/networkpolicies/${name}`, { metadata: { name } })
  objects.set('/api/v1/namespaces/colloq/services', { items: [] })
  assert.equal((await jobs.health()).preparation.available, true)
})

test('aged unschedulable Pod fails promptly without exposing scheduler message', async () => {
  const { jobs, objects } = setup()
  await jobs.start(jobId, intent('notebook'))
  const key = `/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`
  const pod = objects.get(key)
  pod.metadata.annotations['colloq.dev/started-at'] = String(Date.now() - 31_000)
  pod.status = { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable',
    message: 'Insufficient memory; secret node details and exact host capacity' }] }
  const status = await jobs.status(jobId)
  assert.equal(status.phase, 'failed')
  assert.match(status.error ?? '', /resource|schedul/i)
  assert.ok(!status.error?.includes('secret node details'))
  assert.deepEqual(status.failure, { code: 'unschedulable', resource: 'memory' })
  assert.ok(!objects.has(key))
})

test('image pull failure is infrastructure status, not a participant error', async () => {
  const { jobs, objects } = setup()
  await jobs.start(jobId, intent('notebook'))
  const key = `/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`
  objects.get(key).status = { phase: 'Pending', containerStatuses: [{ name: 'main', state: { waiting: { reason: 'ImagePullBackOff', message: 'private registry details' } } }] }
  const status = await jobs.status(jobId)
  assert.equal(status.phase, 'failed')
  assert.deepEqual(status.failure, { code: 'image_unavailable' })
  assert.ok(!status.error?.includes('private registry details'))
  assert.ok(!objects.has(key))
})

test('exporter image pull failure after main exits is reported and cleaned up', async () => {
  const { jobs, objects } = setup()
  await jobs.start(jobId, intent('notebook'))
  const key = `/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`
  objects.get(key).status = { phase: 'Pending', containerStatuses: [
    { name: 'main', state: { terminated: { exitCode: 0, finishedAt: new Date().toISOString() } } },
    { name: 'exporter', state: { waiting: { reason: 'ImagePullBackOff' } } },
  ] }
  const status = await jobs.status(jobId)
  assert.equal(status.phase, 'failed')
  assert.deepEqual(status.failure, { code: 'image_unavailable' })
  assert.ok(!objects.has(key))
})

test('Pod deadline after main termination reports timeout without contacting dead exporter', async () => {
  const exporterCalls: string[] = []
  const { jobs, objects } = setup(async (_url, _token, method) => { exporterCalls.push(method); return { files: [], totalBytes: 0 } })
  await jobs.start(jobId, intent('notebook'))
  const key = `/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`
  objects.get(key).status = { phase: 'Failed', reason: 'DeadlineExceeded', podIP: '10.0.0.8', containerStatuses: [
    { name: 'main', state: { terminated: { exitCode: 137, reason: 'Error', finishedAt: new Date().toISOString() } } },
    { name: 'exporter', state: { terminated: { exitCode: 137, reason: 'Error' } } },
  ] }
  const status = await jobs.status(jobId)
  assert.equal(status.phase, 'failed')
  assert.equal(status.error, 'Wall time limit exceeded')
  assert.equal(status.failure, undefined)
  assert.deepEqual(exporterCalls, [])
  assert.ok(!objects.has(key))
})

test('direct collect after Pod deadline never contacts the exporter', async () => {
  let exporterCalls = 0
  const { jobs, objects } = setup(async () => { exporterCalls++; return { files: [], totalBytes: 0 } })
  await jobs.start(jobId, intent('notebook'))
  const pod = objects.get(`/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`)
  pod.status = { phase: 'Failed', reason: 'DeadlineExceeded', podIP: '10.0.0.8', containerStatuses: [
    { name: 'main', state: { terminated: { exitCode: 137 } } },
    { name: 'exporter', state: { terminated: { exitCode: 137 } } },
  ] }
  await assert.rejects(() => jobs.collect(jobId), /Wall time limit exceeded/)
  assert.equal(exporterCalls, 0)
})

test('main finishing after wall limit fails even while exporter is still alive', async () => {
  const { jobs, objects } = setup()
  await jobs.start(jobId, intent('notebook'))
  const key = `/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`
  objects.get(key).metadata.annotations['colloq.dev/started-at'] = String(Date.now() - 121_000)
  objects.get(key).status = { phase: 'Running', podIP: '10.0.0.8', containerStatuses: [
    { name: 'main', state: { terminated: { exitCode: 137, reason: 'Error', finishedAt: new Date().toISOString() } } },
    { name: 'exporter', state: { running: { startedAt: new Date().toISOString() } } },
  ] }
  const status = await jobs.status(jobId)
  assert.equal(status.phase, 'failed')
  assert.equal(status.error, 'Wall time limit exceeded')
  assert.ok(!objects.has(key))
})

test('policy warmup does not consume a short main wall limit', async () => {
  const { jobs, objects } = setup()
  await jobs.start(jobId, { ...intent('notebook'), limits: { ...limits, wallSeconds: 10 } })
  const pod = objects.get(`/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`)
  pod.metadata.annotations['colloq.dev/started-at'] = String(Date.now() - 25_000)
  pod.status = { phase: 'Pending', initContainerStatuses: [{ name: 'egress-probe', state: { running: {} } }] }
  assert.equal((await jobs.status(jobId)).phase, 'queued')
  pod.status = { phase: 'Running', containerStatuses: [{ name: 'main', state: { running: { startedAt: new Date(Date.now() - 5_000).toISOString() } } }] }
  assert.equal((await jobs.status(jobId)).phase, 'running')
})

test('egress preflight refusal fails before the main container starts', async () => {
  const { jobs, objects } = setup()
  await jobs.start(jobId, intent('metric'))
  const key = `/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`
  objects.get(key).status = { phase: 'Failed', initContainerStatuses: [
    { name: 'egress-probe', state: { terminated: { exitCode: 41 } } },
  ] }
  const status = await jobs.status(jobId)
  assert.equal(status.phase, 'failed')
  assert.equal(status.error, 'Network isolation preflight failed')
  assert.deepEqual(status.failure, { code: 'runtime_unavailable' })
  assert.ok(!objects.has(key))
})

test('start refuses missing job isolation before creating a Pod', async () => {
  const { jobs, objects, calls } = setup()
  objects.delete('/apis/networking.k8s.io/v1/namespaces/colloq/networkpolicies/competition-job-isolation')
  await assert.rejects(() => jobs.start(jobId, intent('notebook')), /isolation|unavailable/i)
  assert.ok(!calls.some(c => c.method === 'POST'))
})

test('metric Pod sees only secret snapshot and answer snapshot', async () => {
  const { jobs, calls } = setup()
  await jobs.start(jobId, intent('metric'))
  const pod = calls.find(c => c.method === 'POST' && c.path.endsWith('/pods'))!.body
  const paths = pod.spec.containers[0].volumeMounts.map((m: any) => m.subPath).filter(Boolean)
  assert.ok(paths.includes(`competitions/abcd2345/s/efgh2345/attempts/${attemptId}/secret`))
  assert.ok(paths.includes(`competitions/abcd2345/s/efgh2345/attempts/${attemptId}/score`))
  assert.ok(!paths.some((p: string) => p.endsWith('/data') || p.endsWith('/in') || p.includes('dependencies/bundles')))
})

test('offline jobs probe egress isolation before participant or metric code starts', async () => {
  for (const kind of ['notebook', 'metric', 'inventory', 'verify', 'resolve'] as const) {
    const { jobs, calls } = setup()
    await jobs.start(jobId, intent(kind))
    const pod = calls.find(c => c.method === 'POST' && c.path.endsWith('/pods') && c.body.metadata.name === `colloq-job-${jobId}`)!.body
    if (kind === 'resolve') assert.equal(pod.spec.initContainers?.length ?? 0, 0)
    else {
      assert.equal(pod.spec.initContainers.length, 1)
      assert.equal(pod.spec.initContainers[0].securityContext.readOnlyRootFilesystem, true)
      assert.equal(pod.spec.initContainers[0].volumeMounts?.length ?? 0, 0)
    }
  }
})

test('notebook bundle mount includes verified wheel directory and lock file', async () => {
  const { jobs, calls } = setup()
  await jobs.start(jobId, { ...intent('notebook'), bundleId: 'd'.repeat(32) })
  const pod = calls.find(c => c.method === 'POST' && c.path.endsWith('/pods'))!.body
  const deps = pod.spec.containers[0].volumeMounts.find((m: any) => m.mountPath === '/deps')
  assert.equal(deps.subPath, `dependencies/bundles/${'d'.repeat(32)}`)
  assert.equal(deps.readOnly, true)
  // An app that sized no room: the set shares /work, as before.
  assert.ok(!pod.spec.volumes.some((v: any) => v.name === 'packages'))
  assert.ok(!pod.spec.containers[0].env.some((e: any) => e.name === 'COMP_PACKAGES'))
})

test('a notebook package set gets its own memory-backed room, sized by the app, and only the main container sees it', async () => {
  const { jobs, calls } = setup()
  await jobs.start(jobId, { ...intent('notebook'), bundleId: 'd'.repeat(32), limits: { ...limits, packagesMb: 379 } })
  const pod = calls.find(c => c.method === 'POST' && c.path.endsWith('/pods'))!.body
  const [main, exporter] = pod.spec.containers
  // Memory, not a PVC: the participant writes into it, and nothing of theirs reaches a disk.
  assert.deepEqual(pod.spec.volumes.find((v: any) => v.name === 'packages'), { name: 'packages', emptyDir: { medium: 'Memory', sizeLimit: '379Mi' } })
  assert.ok(main.volumeMounts.some((m: any) => m.name === 'packages' && m.mountPath === '/packages' && !m.readOnly))
  assert.ok(main.env.some((e: any) => e.name === 'COMP_PACKAGES' && e.value === '/packages'))
  assert.ok(!exporter.volumeMounts.some((m: any) => m.name === 'packages'), 'the exporter has no business with the set')
  // /work keeps the participant's own eighth.
  assert.deepEqual(pod.spec.volumes.find((v: any) => v.name === 'work').emptyDir, { medium: 'Memory', sizeLimit: '256Mi' })
})

test('a notebook knows the whole limit, so its harness stops a late notebook before the Pod deadline', async () => {
  const { jobs, calls } = setup()
  await jobs.start(jobId, intent('notebook'))
  const main = calls.find(c => c.method === 'POST' && c.path.endsWith('/pods'))!.body.spec.containers[0]
  assert.ok(main.env.some((e: any) => e.name === 'COMP_WALL_SECONDS' && e.value === String(limits.wallSeconds)))
})

test('rejects a catalog digest mismatch before creating anything', async () => {
  const { jobs, calls } = setup()
  await assert.rejects(() => jobs.start(jobId, { ...intent('notebook'), revision: `sha256:${'e'.repeat(64)}` }), /catalog|revision|unavailable/i)
  assert.equal(calls.length, 0)
})

/*
 * GPU environments. Until GPU jobs the broker refused every job of a GPU
 * catalog image, and the app showed each submission of such a competition, and
 * its baseline check, as a failed metric. Now the image runs every job on the
 * CPU, and a card goes only to a notebook whose intent asks for one, on a
 * broker that names the cluster's GPU resource (RUNTIME_COMPETITION_GPU_*).
 */
const gpuRevision = `sha256:${'e'.repeat(64)}`
const gpuCatalog = parseRuntimeCatalog({ schemaVersion: 1, release: 'v1', defaultEnvironment: 'kaggle-base', environments: [
  { name: 'kaggle-base', image: `registry.example/kernel@${revision}`, gpu: false },
  { name: 'kaggle-gpu', image: `registry.example/kernel-gpu@${gpuRevision}`, gpu: true },
] })
const onGpuImage = (kind: Parameters<typeof intent>[0]) => ({ ...intent(kind), environment: 'kaggle-gpu', revision: gpuRevision })
const MIG = { resource: 'nvidia.com/mig-1g.10gb', count: 2 }
function gpuSetup(config: Partial<CompetitionJobConfig> = {}, list = gpuCatalog) {
  const { kube, calls, objects } = setup()
  const jobs = new CompetitionJobs({ kube, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage, instanceId: 'instance123', ...config },
    catalog: () => list, secret: () => 'x'.repeat(64) })
  return { jobs, calls, objects }
}
const jobPod = (calls: { method: string; path: string; body: any }[]) =>
  calls.find(c => c.method === 'POST' && c.path.endsWith('/pods') && c.body.metadata.name === `colloq-job-${jobId}`)!.body
const NO_GPU = { name: 'NVIDIA_VISIBLE_DEVICES', value: 'void' }

test("a GPU environment's image runs every job on the CPU, and nothing in it can reach a card", async () => {
  for (const config of [{}, { gpu: MIG }]) {
    for (const kind of ['notebook', 'metric', 'inventory', 'resolve', 'verify'] as const) {
      const { jobs, calls } = gpuSetup(config)
      await jobs.start(jobId, onGpuImage(kind))
      const pod = jobPod(calls)
      const where = `${kind}, GPU jobs ${'gpu' in config ? 'on' : 'off'}`
      const containers = [...pod.spec.containers, ...(pod.spec.initContainers ?? [])]
      for (const container of containers)
        assert.ok(!Object.keys({ ...container.resources.requests, ...container.resources.limits }).some((name) => name.includes('/')), `${where}: ${container.name}`)
      assert.equal('runtimeClassName' in pod.spec, false, where)
      assert.ok(!pod.spec.volumes.some((v: any) => v.name === 'shm'), where)
      // An image from nvidia/cuda would otherwise get every card of a node whose default runtime is NVIDIA's.
      const [main, exporter] = pod.spec.containers
      assert.ok(main.env.some((e: any) => e.name === NO_GPU.name && e.value === NO_GPU.value), where)
      if (kind !== 'resolve') assert.deepEqual(pod.spec.initContainers[0].env, [NO_GPU], where)
      assert.ok(!exporter.env.some((e: any) => e.name === NO_GPU.name), 'the exporter runs our own image')
    }
  }
  // A CPU environment's Pod is the Pod it always was: not a word about GPUs.
  const { jobs, calls } = setup()
  await jobs.start(jobId, intent('notebook'))
  const pod = jobPod(calls)
  assert.ok(!JSON.stringify(pod.spec).includes('NVIDIA'))
  assert.equal(pod.spec.initContainers[0].env, undefined)
})

test('a notebook that asks for a card is refused before any Pod: by a broker without the GPU resource, on a CPU environment, and for any other job', async () => {
  const off = gpuSetup()
  await assert.rejects(() => off.jobs.start(jobId, { ...onGpuImage('notebook'), gpu: true }),
    (err: any) => err.status === 409 && /RUNTIME_COMPETITION_GPU_RESOURCE is not set/.test(err.message))
  assert.ok(!off.calls.some(c => c.method === 'POST'))
  // A CPU environment's image has nothing to use a card with.
  const on = gpuSetup({ gpu: MIG })
  await assert.rejects(() => on.jobs.start(jobId, { ...intent('notebook'), gpu: true }),
    (err: any) => err.status === 409 && /GPU environment/.test(err.message))
  // The metric holds the hidden answers: no card, whatever asks.
  for (const kind of ['metric', 'inventory', 'resolve', 'verify'] as const)
    await assert.rejects(() => on.jobs.start(jobId, { ...onGpuImage(kind), gpu: true }), /Unexpected GPU request/, kind)
  assert.ok(!on.calls.some(c => c.method === 'POST'))
})

test("a notebook given a card: the units in its main container alone, the GPU rooms' placement over the students', and /dev/shm within its memory", async () => {
  const studentToleration = { key: 'colloq/students', operator: 'Exists', effect: 'NoSchedule' } as const
  const gpuToleration = { key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' } as const
  const { jobs, calls } = gpuSetup({
    gpu: MIG, gpuRuntimeClass: 'nvidia-cdi',
    studentNodeSelector: { pool: 'students', zone: 'a' }, studentTolerations: [studentToleration],
    gpuNodeSelector: { pool: 'gpu', 'nvidia.com/gpu.present': 'true' }, gpuTolerations: [gpuToleration],
  })
  await jobs.start(jobId, { ...onGpuImage('notebook'), gpu: true })
  const pod = jobPod(calls)
  const [main, exporter] = pod.spec.containers
  const probe = pod.spec.initContainers[0]
  // Requests equal limits: Kubernetes never overcommits an extended resource.
  assert.equal(main.resources.requests['nvidia.com/mig-1g.10gb'], 2)
  assert.equal(main.resources.limits['nvidia.com/mig-1g.10gb'], 2)
  assert.equal(main.resources.limits.memory, '1024Mi', 'the rest of its limits are what they were')
  for (const container of [exporter, probe])
    assert.ok(!Object.keys({ ...container.resources.requests, ...container.resources.limits }).some((name) => name.includes('/')), container.name)
  assert.equal(pod.spec.runtimeClassName, 'nvidia-cdi')
  // The GPU nodes' selector wins over the students' where both name a key.
  assert.deepEqual(pod.spec.nodeSelector, { pool: 'gpu', zone: 'a', 'nvidia.com/gpu.present': 'true' })
  assert.deepEqual(pod.spec.tolerations, [studentToleration, gpuToleration])
  // Half the job's 1024 MiB, memory-backed, for main alone: DataLoader workers hand batches over through it.
  assert.deepEqual(pod.spec.volumes.find((v: any) => v.name === 'shm'), { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } })
  assert.ok(main.volumeMounts.some((m: any) => m.name === 'shm' && m.mountPath === '/dev/shm' && !m.readOnly))
  assert.ok(!exporter.volumeMounts.some((m: any) => m.name === 'shm'))
  // The device plugin names the allocated units to main; the preflight gets none.
  assert.ok(!main.env.some((e: any) => e.name === NO_GPU.name))
  assert.deepEqual(probe.env, [NO_GPU])
  assert.equal(JSON.parse(pod.metadata.annotations['colloq.dev/intent']).gpu, true)
})

test("a card's /dev/shm stops at the GPU room's 1 GiB, and the GPU RuntimeClass is the rooms' setting: nvidia when absent, none when empty", async () => {
  const big = gpuSetup({ gpu: { resource: 'nvidia.com/gpu', count: 1 } })
  await big.jobs.start(jobId, { ...onGpuImage('notebook'), gpu: true, limits: { ...limits, memoryMb: 16384 } })
  const pod = jobPod(big.calls)
  assert.equal(pod.spec.volumes.find((v: any) => v.name === 'shm').emptyDir.sizeLimit, '1024Mi')
  assert.equal(pod.spec.containers[0].resources.limits['nvidia.com/gpu'], 1)
  assert.equal(pod.spec.runtimeClassName, 'nvidia')
  const none = gpuSetup({ gpu: { resource: 'nvidia.com/gpu', count: 1 }, gpuRuntimeClass: '' })
  await none.jobs.start(jobId, { ...onGpuImage('notebook'), gpu: true })
  const plain = jobPod(none.calls)
  assert.equal('runtimeClassName' in plain.spec, false)
  assert.equal(plain.spec.containers[0].resources.limits['nvidia.com/gpu'], 1, 'the card is still requested')
})

test('health: a catalog of GPU images alone works, and the GPU capability exists only where the resource is named, then exactly as execution', async () => {
  const gpuOnly = parseRuntimeCatalog({ schemaVersion: 1, release: 'v1', defaultEnvironment: 'kaggle-gpu', environments: [
    { name: 'kaggle-gpu', image: `registry.example/kernel-gpu@${gpuRevision}`, gpu: true },
  ] })
  const off = await gpuSetup({}, gpuOnly).jobs.health()
  assert.deepEqual(off.execution, { available: true, code: 'ready', reason: null })
  assert.equal(off.gpu?.available, false)
  assert.equal(off.gpu?.code, 'gpu_unavailable')
  assert.match(off.gpu?.reason ?? '', /RUNTIME_COMPETITION_GPU_RESOURCE/)
  const on = gpuSetup({ gpu: MIG }, gpuOnly)
  assert.deepEqual((await on.jobs.health()).gpu, { available: true, code: 'ready', reason: null })
  // A GPU job is a job first: without the data claim it cannot run either.
  on.objects.delete('/api/v1/namespaces/colloq/persistentvolumeclaims/colloq-data')
  const broken = await on.jobs.health()
  assert.equal(broken.execution.code, 'storage_unavailable')
  assert.deepEqual(broken.gpu, broken.execution)
  // Nor while the broker is half-configured; and off stays off, whatever else is wrong.
  const unconfigured = gpuSetup({ gpu: MIG, instanceId: '' }, gpuOnly)
  assert.equal((await unconfigured.jobs.health()).gpu?.code, 'broker_unavailable')
  assert.equal((await gpuSetup({ instanceId: '' }, gpuOnly).jobs.health()).gpu?.code, 'gpu_unavailable')
})

test('a GPU notebook that finds no free card goes back to the queue as gpu: the scheduler said so, or the kubelet could not hand the card over', async () => {
  const key = `/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`
  const unschedulable = (message: string) => ({ phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message }] })
  for (const [gpu, podStatus, resource] of [
    [true, unschedulable('0/3 nodes are available: 1 Insufficient nvidia.com/mig-1g.10gb, 2 Insufficient memory. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.'), 'gpu'],
    // Short of memory alone, a GPU notebook says memory: the card is not what is missing.
    [true, unschedulable('0/1 nodes are available: 1 Insufficient memory.'), 'memory'],
    // The same name a notebook without a card never requested is not its problem.
    [false, unschedulable('0/1 nodes are available: 1 Insufficient nvidia.com/mig-1g.10gb.'), 'other'],
    // The kubelet refused a placed Pod: the device plugin could not allocate, or the node had none left.
    [true, { phase: 'Failed', reason: 'UnexpectedAdmissionError', message: 'Allocate failed due to requested number of devices unavailable' }, 'gpu'],
    [true, { phase: 'Failed', reason: 'OutOfnvidia.com/mig-1g.10gb', message: 'Node didn\'t have enough resource' }, 'gpu'],
  ] as const) {
    const { jobs, objects } = gpuSetup({ gpu: MIG })
    await jobs.start(jobId, { ...onGpuImage('notebook'), ...(gpu ? { gpu: true } : {}) })
    const pod = objects.get(key)
    pod.metadata.annotations['colloq.dev/started-at'] = String(Date.now() - 31_000)
    pod.status = structuredClone(podStatus)
    const status = await jobs.status(jobId)
    assert.equal(status.phase, 'failed', JSON.stringify(podStatus))
    assert.deepEqual(status.failure, { code: 'unschedulable', resource }, JSON.stringify(podStatus))
    assert.equal(status.error, 'Competition resources are unavailable')
    assert.ok(!objects.has(key), 'the Pod is gone, so the retry can create it anew')
  }
  // A kubelet refusal of a Pod without a card stays what it was: the runtime failed.
  const { jobs, objects } = gpuSetup({ gpu: MIG })
  await jobs.start(jobId, onGpuImage('notebook'))
  objects.get(key).status = { phase: 'Failed', reason: 'UnexpectedAdmissionError' }
  assert.deepEqual((await jobs.status(jobId)).failure, { code: 'runtime_unavailable' })
})

/*
 * How many GPU notebooks the cluster runs at once is the operator's to say
 * (RUNTIME_COMPETITION_GPU_SLOTS). The app's queue keeps that many at the
 * broker, one when it is not said, and lets CPU work go past the rest: a GPU
 * notebook Kubernetes cannot place holds a general slot for 30 seconds, and a
 * queue that sent every waiting one kept every slot busy with them.
 */
test('health reports the GPU notebooks the cluster runs at once: the operator\'s number, null when unsaid or off', async () => {
  assert.equal((await gpuSetup({ gpu: { ...MIG, slots: 3 } }).jobs.health()).gpuSlots, 3)
  assert.equal((await gpuSetup({ gpu: MIG }).jobs.health()).gpuSlots, null)
  assert.equal((await gpuSetup({ gpu: { ...MIG, slots: null } }).jobs.health()).gpuSlots, null)
  // Without the resource there are no GPU jobs, whatever number is left over.
  assert.equal((await gpuSetup().jobs.health()).gpuSlots, null)
  // The number is the operator's, beside the verdicts, which stay what they are.
  const down = gpuSetup({ gpu: { ...MIG, slots: 2 } })
  down.objects.delete('/api/v1/namespaces/colloq/persistentvolumeclaims/colloq-data')
  const health = await down.jobs.health()
  assert.equal(health.gpuSlots, 2)
  assert.equal(health.gpu?.code, 'storage_unavailable')
})

/*
 * Under MPS sharing the device plugin mounts its daemon's shared memory at
 * /dev/shm, and the kubelet mounts the Pod's own volumes after the plugin's:
 * a /dev/shm of ours hid it, and CUDA could not reach the MPS server.
 */
test('a /dev/shm ceiling of 0 gives a GPU notebook none of ours, for MPS; another ceiling caps it under half the memory', async () => {
  const mps = gpuSetup({ gpu: { ...MIG, shmMb: 0 } })
  await mps.jobs.start(jobId, { ...onGpuImage('notebook'), gpu: true })
  const pod = jobPod(mps.calls)
  assert.ok(!pod.spec.volumes.some((v: any) => v.name === 'shm'))
  assert.ok(!pod.spec.containers.some((c: any) => c.volumeMounts.some((m: any) => m.mountPath === '/dev/shm')))
  assert.equal(pod.spec.containers[0].resources.limits['nvidia.com/mig-1g.10gb'], 2, 'the card is still requested')
  // A ceiling below half the job's memory is the size; half the memory stays the most.
  const small = gpuSetup({ gpu: { ...MIG, shmMb: 256 } })
  await small.jobs.start(jobId, { ...onGpuImage('notebook'), gpu: true })
  assert.equal(jobPod(small.calls).spec.volumes.find((v: any) => v.name === 'shm').emptyDir.sizeLimit, '256Mi')
  const big = gpuSetup({ gpu: { ...MIG, shmMb: 4096 } })
  await big.jobs.start(jobId, { ...onGpuImage('notebook'), gpu: true })
  assert.equal(jobPod(big.calls).spec.volumes.find((v: any) => v.name === 'shm').emptyDir.sizeLimit, '512Mi')
})

/*
 * A GPU environment's image is 10 to 13 GB, and every job of a GPU
 * competition runs it, on nodes that may never have pulled it. The pull came
 * out of the job's own time: a metric (two minutes) on a cold CPU node failed
 * as "Wall time limit exceeded" while its image was still arriving.
 */
test("a GPU image's Pod has its pull allowance before its own time starts, and a started job still gets exactly its limit", async () => {
  const key = `/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`
  const pulling = { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'True' }],
    initContainerStatuses: [{ name: 'egress-probe', state: { waiting: { reason: 'PodInitializing' } } }],
    containerStatuses: [{ name: 'main', state: { waiting: { reason: 'PodInitializing' } } }, { name: 'exporter', state: { waiting: { reason: 'PodInitializing' } } }] }
  const clocked = (config: Partial<CompetitionJobConfig> = {}) => {
    const { kube, calls, objects } = setup()
    const clock = { now: 1_000_000_000_000 }
    const jobs = new CompetitionJobs({ kube, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage, instanceId: 'instance123', ...config },
      catalog: () => gpuCatalog, secret: () => 'x'.repeat(64), now: () => clock.now })
    return { jobs, calls, objects, clock }
  }
  const metric = { ...onGpuImage('metric'), limits: { ...limits, wallSeconds: 120 } }
  // The Pod: its deadline grows by the allowance, and it keeps its own number.
  const gpu = clocked()
  await gpu.jobs.start(jobId, metric)
  const pod = jobPod(gpu.calls)
  assert.equal(pod.spec.activeDeadlineSeconds, 120 + 90 + 900)
  assert.equal(pod.metadata.annotations['colloq.dev/pull-seconds'], '900')
  // Still pulling at 151 seconds: queued, not a wall-time failure.
  gpu.objects.get(key).status = structuredClone(pulling)
  gpu.clock.now += 151_000
  assert.equal((await gpu.jobs.status(jobId)).phase, 'queued')
  // Past the allowance, the startup and the limit: the wall time, as before.
  gpu.clock.now += (30 + 900 + 120) * 1000 - 151_000 + 1000
  const late = await gpu.jobs.status(jobId)
  assert.equal(late.phase, 'failed')
  assert.equal(late.error, 'Wall time limit exceeded')
  // Started late, a job still has exactly its limit, counted from its own start.
  const started = clocked()
  await started.jobs.start(jobId, metric)
  started.clock.now += 600_000
  started.objects.get(key).status = { phase: 'Running', containerStatuses: [{ name: 'main', state: { running: { startedAt: new Date(started.clock.now).toISOString() } } }] }
  started.clock.now += 119_000
  assert.equal((await started.jobs.status(jobId)).phase, 'running')
  started.clock.now += 2000
  assert.equal((await started.jobs.status(jobId)).error, 'Wall time limit exceeded')
  // A CPU image keeps the clock it always had: the same 151 seconds are its end.
  const cpu = clocked()
  await cpu.jobs.start(jobId, { ...intent('metric'), limits: { ...limits, wallSeconds: 120 } })
  assert.equal(jobPod(cpu.calls).spec.activeDeadlineSeconds, 210)
  assert.equal(jobPod(cpu.calls).metadata.annotations['colloq.dev/pull-seconds'], undefined)
  cpu.objects.get(key).status = structuredClone(pulling)
  cpu.clock.now += 151_000
  assert.equal((await cpu.jobs.status(jobId)).error, 'Wall time limit exceeded')
  // The operator's allowance, 0 included (images pulled beforehand).
  const none = clocked({ gpuPullSeconds: 0 })
  await none.jobs.start(jobId, metric)
  assert.equal(jobPod(none.calls).spec.activeDeadlineSeconds, 210)
  const short = clocked({ gpuPullSeconds: 60 })
  await short.jobs.start(jobId, onGpuImage('notebook'))
  assert.equal(jobPod(short.calls).spec.activeDeadlineSeconds, limits.wallSeconds + 90 + 60)
  // The notebook's harness still stops it at its own limit, counted from its own
  // start (run_notebook.py · stop_at, with no supervisor's mark under the broker).
  const main = jobPod(short.calls).spec.containers[0]
  assert.ok(main.env.some((e: any) => e.name === 'COMP_WALL_SECONDS' && e.value === String(limits.wallSeconds)))
  assert.ok(!main.env.some((e: any) => e.name === 'COMP_STARTED_MONOTONIC'))
  assert.match(main.command.join(' '), /exec python -I -u \/harness\/run_notebook\.py/)
  // A package preparation's proxy lives through the resolver's pull as well.
  const resolve = clocked({ gpuPullSeconds: 300 })
  await resolve.jobs.start(jobId, onGpuImage('resolve'))
  const proxy = resolve.calls.find(c => c.method === 'POST' && c.path.endsWith('/pods') && c.body.metadata.name === `colloq-proxy-${jobId}`)!.body
  assert.equal(proxy.spec.activeDeadlineSeconds, limits.wallSeconds + 90 + 300)
  assert.ok(proxy.spec.containers[0].env.some((e: any) => e.name === 'COMP_PROXY_WALL_SECONDS' && e.value === String(limits.wallSeconds + 300)))
  assert.equal(jobPod(resolve.calls).spec.activeDeadlineSeconds, limits.wallSeconds + 90 + 300)
})

test("a broker restart keeps a pulling GPU image's Pod for its allowance on top of its limit", async () => {
  const began = Date.now() - 2.5 * 3600_000
  const { kube, objects } = setup(undefined, began)
  const first = new CompetitionJobs({ kube, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage, instanceId: 'instance123', gpuPullSeconds: 3600 },
    catalog: () => gpuCatalog, secret: () => 'x'.repeat(64), now: () => began })
  await first.start(jobId, { ...onGpuImage('notebook'), limits: { ...limits, wallSeconds: 6000 } })
  const key = `/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`
  // 2.5 hours on: past its limit plus ten minutes, within its allowance on top.
  const later = new CompetitionJobs({ kube, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage, instanceId: 'instance123' },
    catalog: () => gpuCatalog, secret: () => 'x'.repeat(64), now: () => began + 2.5 * 3600_000 })
  await later.reconcile()
  assert.ok(objects.has(key))
})

/*
 * The API server can refuse a GPU notebook's Pod before it exists: the
 * namespace's quota of the GPU resource used up, the GPU RuntimeClass missing
 * on the cluster, an admission policy against the GPU parts. That error used
 * to fail every GPU submission of the class "in the metric" within seconds,
 * with nothing to retry them and "Forbidden" for the teacher.
 */
test("the API server's no to a GPU notebook's Pod sends it back to the queue with the cause; a CPU job and the broker's own permission stay errors", async () => {
  const refusing = (refusal: KubernetesRefusal, config: Partial<CompetitionJobConfig> = {}) => {
    const { kube, calls } = setup()
    const posted: string[] = []
    const client = { request: async <T>(method: string, path: string, body?: any): Promise<T> => {
      if (method === 'POST' && path.endsWith('/pods') && body?.metadata?.name === `colloq-job-${jobId}`) {
        posted.push(body.metadata.name)
        throw new KubernetesError(403, 'Forbidden', undefined, refusal)
      }
      return kube.request<T>(method, path, body)
    } }
    const jobs = new CompetitionJobs({ kube: client, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage, instanceId: 'instance123', gpu: MIG, ...config },
      catalog: () => gpuCatalog, secret: () => 'x'.repeat(64) })
    return { jobs, calls, posted }
  }
  const cases: Array<[KubernetesRefusal, Partial<CompetitionJobConfig>, RegExp]> = [
    [{ kind: 'quota', resources: ['requests.nvidia.com/mig-1g.10gb'] }, {}, /resource quota is used up \(requests\.nvidia\.com\/mig-1g\.10gb\)/],
    [{ kind: 'runtime-class' }, { gpuRuntimeClass: 'nvidia-cdi' }, /no RuntimeClass "nvidia-cdi" \(RUNTIME_GPU_RUNTIME_CLASS, Helm: gpu\.runtimeClassName\)/],
    [{ kind: 'runtime-class' }, {}, /no RuntimeClass "nvidia"/],
    [{ kind: 'admission' }, {}, /at admission: a policy of the cluster denied it/],
  ]
  for (const [refusal, config, words] of cases) {
    const { jobs, posted } = refusing(refusal, config)
    const status = await jobs.start(jobId, { ...onGpuImage('notebook'), gpu: true })
    assert.equal(posted.length, 1)
    assert.equal(status.phase, 'failed', refusal.kind)
    assert.deepEqual(status.failure, { code: 'unschedulable', resource: 'gpu' }, refusal.kind)
    assert.match(status.error ?? '', words)
    // What the app reads: a status, not an error (shared/competition-runtime.ts).
    assert.deepEqual(parseCompetitionJobStatus(JSON.parse(JSON.stringify(status))), status)
  }
  // A notebook without a card was never waiting for one: the refusal stays an error, as before.
  const cpu = refusing({ kind: 'quota', resources: ['requests.memory'] })
  await assert.rejects(() => cpu.jobs.start(jobId, onGpuImage('notebook')), (err: any) => err instanceof KubernetesError && err.status === 403)
  // Nor is the broker's own missing permission a card to wait for.
  const rbac = refusing({ kind: 'permission' })
  await assert.rejects(() => rbac.jobs.start(jobId, { ...onGpuImage('notebook'), gpu: true }), (err: any) => err instanceof KubernetesError)
  // Over HTTP the app gets the status with its failure word, which it defers.
  const { jobs } = refusing({ kind: 'quota', resources: ['requests.nvidia.com/mig-1g.10gb'] })
  const token = 't'.repeat(64)
  const server = createRuntimeServer({ token: () => token, catalog: () => gpuCatalog, controller: {
    health: async () => ({ ok: true, reason: null }), list: async () => [], ensure: async () => { throw new Error('unused') },
    remove: async () => {}, resize: async () => ({ outcome: 'applied' as const }),
  }, jobs })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/competition-jobs/${jobId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...onGpuImage('notebook'), gpu: true }) })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.phase, 'failed')
    assert.deepEqual(body.failure, { code: 'unschedulable', resource: 'gpu' })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }
})

test('concurrent starts of one job create one Pod', async () => {
  const { jobs, calls } = setup()
  const [first, second] = await Promise.all([jobs.start(jobId, intent('notebook')), jobs.start(jobId, intent('notebook'))])
  assert.equal(first.jobId, second.jobId)
  assert.equal(calls.filter(c => c.method === 'POST' && c.path.endsWith('/pods')).length, 1)
})

test('cancel during Pod creation cannot leave a running job behind', async () => {
  const { kube, objects } = setup()
  let entered!: () => void, release!: () => void
  const posting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const delayed = { request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (method === 'POST' && path.endsWith('/pods') && (body as any).metadata.name === `colloq-job-${jobId}`) {
      entered()
      await gate
    }
    return kube.request<T>(method, path, body)
  } }
  const jobs = new CompetitionJobs({ kube: delayed, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage, instanceId: 'instance123' },
    catalog: () => catalog, secret: () => 'x'.repeat(64) })
  const start = jobs.start(jobId, intent('notebook'))
  await posting
  const cancel = jobs.cancel(jobId)
  release()
  await assert.rejects(start, /cancelled/i)
  await cancel
  assert.ok(!objects.has(`/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`))
})

test('restart waits for a stale owned proxy deletion before reusing its name', async () => {
  const { jobs: first, kube, objects } = setup()
  await first.start(jobId, intent('resolve'))
  objects.delete(`/api/v1/namespaces/colloq/pods/colloq-job-${jobId}`)
  let pending = 0
  const delayed = { request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const key = `/api/v1/namespaces/colloq/pods/colloq-proxy-${jobId}`
    if (method === 'DELETE' && path === key) { pending = 2; return {} as T }
    if (method === 'GET' && path === key && pending > 0) {
      pending--
      if (pending === 0) objects.delete(key)
    }
    return kube.request<T>(method, path, body)
  } }
  const second = new CompetitionJobs({ kube: delayed, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage, instanceId: 'instance123' },
    catalog: () => catalog, secret: () => 'x'.repeat(64), pollMs: 1 })
  assert.equal((await second.start(jobId, intent('resolve'))).jobId, jobId)
})

test('resolve creates a mountless proxy and a resolver restricted to that service', async () => {
  const { jobs, calls } = setup()
  await jobs.start(jobId, intent('resolve'))
  const pods = calls.filter(c => c.method === 'POST' && c.path.endsWith('/pods')).map(c => c.body)
  const proxy = pods.find(p => p.metadata.labels['colloq.dev/role'] === 'competition-proxy')
  const resolver = pods.find(p => p.metadata.labels['colloq.dev/role'] === 'competition-resolver')
  assert.ok(proxy)
  assert.ok(resolver)
  assert.equal(proxy.spec.volumes?.filter((v: any) => v.persistentVolumeClaim).length ?? 0, 0)
  assert.ok(resolver.spec.containers[0].env.some((e: any) => e.name === 'HTTPS_PROXY' && e.value.includes(':3128')))
  assert.ok(!resolver.spec.containers[0].volumeMounts.some((m: any) => String(m.subPath).startsWith('competitions/')))
})

test('a package preparation works in /work, sized by the app for its phase, while /tmp stays small', async () => {
  for (const kind of ['resolve', 'verify'] as const) {
    const { jobs, calls } = setup()
    // 608 MiB: the installed limit of 512 MiB and its headroom (preparation-contract.ts · preparationRoomBytes).
    await jobs.start(jobId, { ...intent(kind), limits: { ...limits, tmpfsMb: 608 } })
    const pod = calls.find(c => c.method === 'POST' && c.path.endsWith('/pods') && c.body.metadata.name === `colloq-job-${jobId}`)!.body
    const main = pod.spec.containers[0]
    const room = (name: string) => pod.spec.volumes.find((v: any) => v.name === name).emptyDir
    // The program installs into COMP_OUT (preparation-python.ts · ROOM)...
    assert.ok(main.env.some((e: any) => e.name === 'COMP_OUT' && e.value === '/work'), kind)
    assert.ok(main.volumeMounts.some((m: any) => m.name === 'work' && m.mountPath === '/work' && !m.readOnly), kind)
    assert.deepEqual(room('work'), { medium: 'Memory', sizeLimit: '608Mi' }, kind)
    // ...not into /tmp, which a 300 MB set outgrows.
    assert.deepEqual(room('tmp'), { medium: 'Memory', sizeLimit: '256Mi' }, kind)
  }
})

test('verify reads staged wheels offline; inventory mounts no competition inputs', async () => {
  for (const kind of ['verify', 'inventory'] as const) {
    const { jobs, calls } = setup()
    await jobs.start(jobId, intent(kind))
    const pod = calls.find(c => c.method === 'POST' && c.path.endsWith('/pods'))!.body
    const main = pod.spec.containers[0]
    assert.equal(pod.metadata.labels['colloq.dev/role'], 'competition-job')
    assert.ok(!main.env.some((e: any) => /PROXY/i.test(e.name)))
    assert.ok(!main.volumeMounts.some((m: any) => String(m.subPath).startsWith('competitions/')))
    if (kind === 'verify') assert.ok(main.volumeMounts.some((m: any) => m.mountPath === '/wheels' && m.readOnly === true &&
      m.subPath === `dependencies/staging/${attemptId}/wheels`))
    else assert.ok(!main.volumeMounts.some((m: any) => m.mountPath === '/wheels'))
  }
})

test('authenticated HTTP job routes bind URL ID and reject arbitrary templates', async () => {
  const { jobs } = setup()
  const token = 't'.repeat(64)
  const server = createRuntimeServer({ token: () => token, catalog: () => catalog, controller: {
    health: async () => ({ ok: true, reason: null }), list: async () => [], ensure: async () => { throw new Error('unused') },
    remove: async () => {}, resize: async () => ({ outcome: 'applied' as const }),
  }, jobs })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1/competition-jobs`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  try {
    assert.equal((await fetch(base, { method: 'GET' })).status, 401)
    assert.equal((await fetch(`${base}/${jobId}`, { method: 'POST', headers, body: JSON.stringify({ ...intent('notebook'), spec: { hostNetwork: true } }) })).status, 400)
    assert.equal((await fetch(`${base}/${'f'.repeat(32)}`, { method: 'POST', headers, body: JSON.stringify(intent('notebook')) })).status, 400)
    assert.equal((await fetch(`${base}/${jobId}`, { method: 'POST', headers, body: JSON.stringify(intent('notebook')) })).status, 200)
    assert.equal((await fetch(`${base}/${jobId}/collect`, { method: 'POST' })).status, 401)
    assert.equal((await fetch(`${base}/${jobId}`, { method: 'DELETE' })).status, 401)
    assert.equal((await fetch(`${base}/${jobId}/collect`, { method: 'POST', headers, body: '{}' })).status, 400)
    assert.equal((await fetch(`${base}/${jobId}/collect`, { method: 'POST', headers })).status, 409)
    assert.equal((await fetch(base, { method: 'GET', headers })).status, 200)
    assert.equal((await fetch(`${base}/${jobId}`, { method: 'GET', headers })).status, 200)
    assert.equal((await fetch(`${base}/${jobId}`, { method: 'DELETE', headers })).status, 200)
    // The app reads whether a GPU notebook can run from here (runtime-client.ts · health).
    const health = await (await fetch(base.replace('/competition-jobs', '/health'), { headers })).json()
    assert.deepEqual(Object.keys(health.competition), ['execution', 'preparation', 'gpu', 'gpuSlots'])
    assert.equal(health.competition.gpu.code, 'gpu_unavailable')
    assert.equal(health.competition.gpuSlots, null)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }
})
