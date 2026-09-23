import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { parseRuntimeCatalog } from '../shared/runtime.js'
import { CompetitionJobs } from '../runtime/src/competition-jobs.js'
import { createRuntimeServer } from '../runtime/src/http.js'

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
  assert.ok(main.volumeMounts.every((m: any) => m.readOnly !== false && m.name !== 'destination'))
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
})

test('rejects a catalog digest mismatch before creating anything', async () => {
  const { jobs, calls } = setup()
  await assert.rejects(() => jobs.start(jobId, { ...intent('notebook'), revision: `sha256:${'e'.repeat(64)}` }), /catalog|revision|unavailable/i)
  assert.equal(calls.length, 0)
})

test('rejects GPU catalog images until competition Pod GPU isolation exists', async () => {
  const { kube, calls } = setup()
  const gpuCatalog = parseRuntimeCatalog({ schemaVersion: 1, release: 'v1', defaultEnvironment: 'kaggle-base', environments: [
    { name: 'kaggle-base', image: `registry.example/kernel@${revision}`, gpu: true },
  ] })
  const jobs = new CompetitionJobs({ kube, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage, instanceId: 'instance123' },
    catalog: () => gpuCatalog, secret: () => 'x'.repeat(64) })
  await assert.rejects(() => jobs.start(jobId, intent('notebook')), /GPU|unsupported/i)
  assert.ok(!calls.some(c => c.method === 'POST'))
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
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }
})
