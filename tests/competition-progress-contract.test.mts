/**
 * A Kubernetes submission's progress, carried the whole way the app reads it:
 * run_notebook.py writes progress.json, the Pod's export sidecar serves it,
 * the broker's status puts it into the job's status, its HTTP route sends that
 * to the app, and the RuntimeClient the competition queue polls with parses it
 * (audit F03).
 *
 * No line here is typed by hand. The real harness runs under python3 with
 * nbclient replaced by a driver that calls its hooks the way nbclient does, and
 * every line it writes to progress.json is taken as it lay on disk. A sample
 * written from memory is how the broker came to allow a phase the harness never
 * writes ('notebook') and to forward a key it always does ('attemptId'): the
 * install's line then failed the app's poll, the app cancelled the submission
 * it was polling, and every cell's line was dropped as an unknown phase.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { TEST_ROOT } from './_env.mts'
import { parseRuntimeCatalog } from '../shared/runtime.js'
import { parseCompetitionJobStatus, type CompetitionJobIntent, type CompetitionJobStatus } from '../shared/competition-runtime.js'
import { CompetitionJobs } from '../runtime/src/competition-jobs.js'
import { createExportServer } from '../runtime/src/export-sidecar.js'
import { createRuntimeServer } from '../runtime/src/http.js'
import { RuntimeClient } from '../server/src/kernel/runtime-client.js'
import { BrokerCompetitionRunner } from '../server/src/competitions/broker-runner.js'
import { harnessDir } from '../server/src/competitions/harness.js'

const jobId = 'a'.repeat(32), attemptId = 'b'.repeat(32), revision = `sha256:${'c'.repeat(64)}`
const image = `registry.example/kernel@${revision}`
const catalog = parseRuntimeCatalog({ schemaVersion: 1, release: 'v1', defaultEnvironment: 'kaggle-base', environments: [
  { name: 'kaggle-base', image, gpu: false },
] })
const limits = { wallSeconds: 120, memoryMb: 1024, cpus: 2, pids: 128, tmpfsMb: 256, targetBytes: 10_000_000 }
const intent = (kind: 'notebook' | 'resolve', attempt = attemptId): CompetitionJobIntent => ({ schemaVersion: 1, jobId, kind, environment: 'kaggle-base', revision, limits,
  ...(kind === 'notebook' ? { competitionId: 'abcd2345', submissionId: 'efgh2345', attemptId: attempt } : { preparationId: attempt }) })

/**
 * nbclient's part, played by a driver: one notebook of a markdown cell and two
 * code cells, each code cell printing past a tiny output cap, under a package
 * set — so the run passes through every line the harness can write. The
 * install itself is pip's business and is skipped; its line is written before
 * it starts. Every write of progress.json is read back the moment it lands.
 */
const DRIVER = String.raw`import json, os, sys, types
from pathlib import Path

harness, root, attempt = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
for name in ("out", "result", "data", "submission", "deps"):
    (root / name).mkdir(parents=True, exist_ok=True)
notebook = root / "submission" / "notebook.ipynb"
code = lambda source: {"cell_type": "code", "source": source, "metadata": {}, "outputs": [], "execution_count": None}
notebook.write_text(json.dumps({"cells": [{"cell_type": "markdown", "source": "# x", "metadata": {}}, code("print(1)"), code("print(2)")],
                                "metadata": {}, "nbformat": 4, "nbformat_minor": 5}))
os.environ.update({"COMP_NOTEBOOK": str(notebook), "COMP_OUT": str(root / "out"), "COMP_DATA": str(root / "data"),
                   "COMP_RESULT": str(root / "result"), "COMP_ATTEMPT_ID": attempt, "COMP_DEPENDENCIES": str(root / "deps"),
                   "COMP_MAX_OUTPUT_BYTES": "8"})

class Node(dict):
    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

def node(value):
    if isinstance(value, dict):
        return Node({key: node(item) for key, item in value.items()})
    if isinstance(value, list):
        return [node(item) for item in value]
    return value

nbformat = types.ModuleType("nbformat")
nbformat.read = lambda path, as_version: node(json.loads(Path(path).read_text()))
nbformat.from_dict = node
nbformat.write = lambda nb, fh: json.dump(nb, fh)

class NotebookClient:
    def __init__(self, nb, **kwargs):
        self.nb = nb
        self.timeout = kwargs.get("timeout")
    def output(self, outs, msg, display_id, cell_index):
        return None
    def execute(self):
        for index, cell in enumerate(self.nb.cells):
            if cell.cell_type != "code":
                continue
            self.on_cell_start(cell=cell, cell_index=index)
            self.output([], {"content": {"text": "x" * 64}}, None, index)
            self.on_cell_executed(cell=cell, cell_index=index)

nbclient = types.ModuleType("nbclient")
nbclient.NotebookClient = NotebookClient
exceptions = types.ModuleType("nbclient.exceptions")
for name in ("CellExecutionError", "CellTimeoutError", "DeadKernelError"):
    setattr(exceptions, name, type(name, (Exception,), {}))
sys.modules.update({"nbformat": nbformat, "nbclient": nbclient, "nbclient.exceptions": exceptions})

samples = []
replace = os.replace
def record(source, target):
    replace(source, target)
    if Path(target).name == "progress.json":
        samples.append(Path(target).read_text(encoding="utf-8"))
os.replace = record

scope = {"__name__": "run_notebook", "__file__": harness}
exec(compile(Path(harness).read_text(encoding="utf-8"), harness, "exec"), scope)
scope["prepare_dependencies"] = lambda: "python3"
print(json.dumps({"exit": scope["main"](), "samples": samples}))
`

/** Every line the real harness writes to progress.json in one run, as it lay on disk. */
function harnessLines(attempt: string): string[] {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, 'harness-run-'))
  const run = spawnSync('python3', ['-I', '-c', DRIVER, path.join(harnessDir(), 'run_notebook.py'), root, attempt],
    { encoding: 'utf8', timeout: 30_000 })
  assert.equal(run.status, 0, run.stderr)
  const { exit, samples } = JSON.parse(run.stdout) as { exit: number; samples: string[] }
  assert.equal(exit, 0)
  return samples
}

/** The phases the harness source can write at all: what a run here must pass through. */
function harnessPhases(): Set<string> {
  const source = fs.readFileSync(path.join(harnessDir(), 'run_notebook.py'), 'utf8')
  return new Set([...source.matchAll(/beat\("([a-z]+)"\)|"phase": "([a-z]+)"/g)].map(match => match[1] ?? match[2]))
}

const closing = (server: http.Server) => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) }

/**
 * The broker for one job, its Pod running, with the Kubernetes API stubbed as
 * the broker's own suite does it, and the Pod's real export sidecar serving
 * `out` with the token the broker gave the Pod. `show` puts a line where the
 * harness puts it and returns what the broker sends and what the app reads.
 */
async function broker(job: CompetitionJobIntent, sidecarKind: 'notebook' | 'resolve' = 'notebook') {
  const objects = new Map<string, any>()
  objects.set('/api/v1/namespaces/colloq/persistentvolumeclaims/colloq-data', { metadata: { name: 'colloq-data' } })
  for (const name of ['competition-job-isolation', 'competition-resolver-isolation', 'competition-proxy-isolation'])
    objects.set(`/apis/networking.k8s.io/v1/namespaces/colloq/networkpolicies/${name}`, { metadata: { name } })
  objects.set('/api/v1/namespaces/colloq/services', { items: [] })
  const kube = { async request<T>(method: string, route: string, body?: any): Promise<T> {
    const key = route.split('?')[0]
    if (method === 'GET' && key.endsWith('/pods')) return { items: [...objects.values()].filter(x => x.kind === 'Pod'), metadata: {} } as T
    if (method === 'GET' && key.endsWith('/services')) return { items: [...objects.values()].filter(x => x.kind === 'Service'), metadata: {} } as T
    if (method === 'GET') return (objects.get(key) ?? (() => { throw Object.assign(new Error('missing'), { status: 404 }) })()) as T
    if (method === 'POST') {
      const object = { ...body, metadata: { ...body.metadata, uid: `${objects.size + 1}`, creationTimestamp: new Date().toISOString() },
        ...(body.metadata?.labels?.['colloq.dev/role'] === 'competition-proxy' ? { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } } : {}) }
      objects.set(`${key}/${object.metadata.name}`, object)
      return object as T
    }
    if (method === 'DELETE') { objects.delete(key); return {} as T }
    throw new Error(`Unexpected ${method} ${route}`)
  } }
  let sidecarPort = 0
  const jobs = new CompetitionJobs({ kube, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage: `registry.example/runtime@sha256:${'d'.repeat(64)}`, instanceId: 'instance123' },
    catalog: () => catalog, secret: () => 'x'.repeat(64),
    // The Pod's address, swapped for the sidecar's own; the path, the token and the method are the broker's.
    exporter: async (url, token, method) => {
      const response = await fetch(`http://127.0.0.1:${sidecarPort}${new URL(url).pathname}`, { method, headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) throw new Error(`exporter ${response.status}`)
      return response.json()
    } })
  await jobs.start(job.jobId, job)
  const pod = objects.get(`/api/v1/namespaces/colloq/pods/colloq-job-${job.jobId}`)
  pod.status = { podIP: '10.0.0.8', containerStatuses: [{ name: 'main', state: { running: { startedAt: new Date().toISOString() } } }] }
  const exportToken = pod.spec.containers.find((c: any) => c.name === 'exporter').env.find((e: any) => e.name === 'COMP_EXPORT_TOKEN').value
  const root = fs.mkdtempSync(path.join(TEST_ROOT, 'pod-'))
  const out = path.join(root, 'out'), result = path.join(root, 'result')
  fs.mkdirSync(out); fs.mkdirSync(result)
  const sidecar = createExportServer({ source: out, destination: result, token: exportToken, kind: sidecarKind })
  sidecar.listen(0, '127.0.0.1'); await once(sidecar, 'listening')
  sidecarPort = (sidecar.address() as { port: number }).port
  const token = 't'.repeat(64)
  const server = createRuntimeServer({ token: () => token, catalog: () => catalog, controller: {
    health: async () => ({ ok: true, reason: null }), list: async () => [], ensure: async () => { throw new Error('unused') },
    remove: async () => {}, resize: async () => ({ outcome: 'applied' as const }),
  }, jobs })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const client = new RuntimeClient({ url: base, token })
  return {
    async show(file: string, line: string): Promise<{ wire: unknown; read: CompetitionJobStatus }> {
      fs.writeFileSync(path.join(out, file), line)
      const response = await fetch(`${base}/v1/competition-jobs/${job.jobId}`, { headers: { Authorization: `Bearer ${token}` } })
      assert.equal(response.status, 200)
      return { wire: await response.json(), read: await client.competitionJob(job.jobId) }
    },
    async close() { await closing(server); await closing(sidecar) },
  }
}

test('every line the notebook harness writes reaches the app as the four public fields', async () => {
  const lines = harnessLines(attemptId)
  const seen = new Set(lines.map(line => JSON.parse(line).phase))
  // The run went through every phase the harness has: a new one is covered here, or this fails.
  assert.deepEqual([...seen].sort(), [...harnessPhases()].sort())
  const job = await broker(intent('notebook'))
  try {
    for (const line of lines) {
      const written = JSON.parse(line)
      // What the harness wrote is richer than the contract, and must stay its own business.
      assert.equal(written.attemptId, attemptId)
      const { wire, read } = await job.show('progress.json', line)
      const expected = { phase: written.phase === 'dependencies' ? 'dependencies' : 'notebook',
        cell: written.cell, cells: written.cells, outputBytes: written.outputBytes }
      // The broker's word passes the app's strict parser as it stands — not only the client's leniency.
      assert.deepEqual(parseCompetitionJobStatus(wire).progress, expected, written.phase)
      assert.deepEqual(read.progress, expected, written.phase)
      assert.equal(read.phase, 'running')
    }
  } finally { await job.close() }
})

test("another attempt's lines are no progress of this job, and break nothing", async () => {
  const lines = harnessLines('e'.repeat(32))
  const job = await broker(intent('notebook'))
  try {
    for (const line of lines) {
      const { wire, read } = await job.show('progress.json', line)
      assert.equal(parseCompetitionJobStatus(wire).progress, null, JSON.parse(line).phase)
      assert.equal(read.progress, null)
      assert.equal(read.phase, 'running')
    }
  } finally { await job.close() }
})

test('a line the participant forges in place of the beacon never reaches the app as anything but the four fields', async () => {
  // The notebook's kernel runs as the harness's user and can write /out: the beacon is input, not trusted output.
  const job = await broker(intent('notebook'))
  try {
    const forged = [
      { phase: 'cell', cell: 1, cells: 2, outputBytes: 0, attemptId, note: 'x'.repeat(100) },
      { phase: 'cell', cell: 1e9, cells: 2, outputBytes: 0, attemptId },
      { phase: 'cell', cell: '1', cells: 2, outputBytes: 0, attemptId },
      { phase: 'score', cell: 1, cells: 2, outputBytes: 0, attemptId },
      { phase: 'resolve', cell: 0, cells: 0, outputBytes: 0, attemptId },
      { phase: 'cell', cell: 1, cells: 2, outputBytes: 0 },
      [1, 2, 3],
    ]
    const { read } = await job.show('progress.json', JSON.stringify(forged[0]))
    assert.deepEqual(read.progress, { phase: 'notebook', cell: 1, cells: 2, outputBytes: 0 })
    for (const line of forged.slice(1)) {
      const { wire, read: after } = await job.show('progress.json', JSON.stringify(line))
      assert.equal(parseCompetitionJobStatus(wire).progress, null, JSON.stringify(line))
      assert.equal(after.phase, 'running')
    }
  } finally { await job.close() }
})

test("a package preparation's progress still says how much it downloaded", async () => {
  const job = await broker(intent('resolve'), 'resolve')
  try {
    // The line the preparation program writes (preparation-python.ts · emit), read by the sidecar into the public shape.
    const { wire, read } = await job.show('progress.ndjson', `${JSON.stringify({ state: 'downloading', downloadBytes: 27 })}\n`)
    assert.deepEqual(parseCompetitionJobStatus(wire).progress, { phase: 'resolve', cell: 0, cells: 0, outputBytes: 27 })
    assert.deepEqual(read.progress, { phase: 'resolve', cell: 0, cells: 0, outputBytes: 27 })
  } finally { await job.close() }
})

/**
 * A broker of an earlier release forwards the harness's line whole, keys and
 * all: the app's client reads such a status without its progress rather than
 * refusing it, so a run on an app upgraded before its broker is not cancelled
 * for a line meant only for a progress bar. The rest of the status stays
 * strict: an identity the app did not ask for still fails the poll.
 */
test('a progress sample the app cannot read costs the sample, not the submission', async () => {
  const competitionId = 'abcdefgh', submissionId = 'bcdefghi'
  const resultDir = path.join(TEST_ROOT, 'data', 'competitions', competitionId, 's', submissionId, 'attempts', attemptId, 'result')
  fs.mkdirSync(resultDir, { recursive: true })
  const [install, cell] = harnessLines(attemptId).map(line => JSON.parse(line))
  const deleted: string[] = []
  let polls = 0, collected = false, id = ''
  const status = (phase: CompetitionJobStatus['phase'], progress: unknown) => ({ jobId: id, kind: 'notebook', phase, startedAt: 1,
    finishedAt: phase === 'complete' ? 2 : null, exitCode: phase === 'complete' || phase === 'exporting' ? 0 : null, oomKilled: false, progress, error: null })
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part
    res.setHeader('content-type', 'application/json')
    const route = req.url ?? ''
    if (req.method === 'POST' && !route.endsWith('/collect')) { id = JSON.parse(body).jobId; return res.end(JSON.stringify(status('queued', null))) }
    if (req.method === 'DELETE') { deleted.push(route); return res.end(JSON.stringify({ ok: true })) }
    if (req.method === 'POST') {
      collected = true
      fs.writeFileSync(path.join(resultDir, 'run.json'), JSON.stringify({ attemptId, status: 'ok', cell: 1, cells: 2, detail: '' }))
      fs.writeFileSync(path.join(resultDir, 'submission.csv'), 'id,target\n1,2\n')
      return res.end(JSON.stringify({ files: [], totalBytes: 0 }))
    }
    polls++
    // The install's line as an earlier broker forwarded it, then a cell's in the public shape, then the end.
    res.end(JSON.stringify(polls === 1 ? status('running', install) : polls === 2 ? status('running', { phase: 'notebook', cell: cell.cell, cells: cell.cells, outputBytes: cell.outputBytes })
      : collected ? status('complete', null) : status('exporting', null)))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const client = new RuntimeClient({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: 'a'.repeat(64) })
  try {
    const seen: unknown[] = []
    const runner = new BrokerCompetitionRunner(client, { pollMs: 1,
      catalog: () => ({ schemaVersion: 1, release: 'r', defaultEnvironment: 'kaggle-base', environments: [{ name: 'kaggle-base', image, gpu: false, current: true }] }) })
    const outcome = await runner.run({ competition: { id: competitionId, environment: 'kaggle-base', publicPercent: 30, splitSeed: 'seed' } as any,
      submissionId, attemptId, container: 'colloq-comp-progress', imageDigest: image, dataDir: 'ignored', inputDir: 'ignored', resultDir,
      limits: { ...limits, fsizeBytes: 1024, outputBytes: 100, outputKillBytes: 1000 }, onProgress: progress => seen.push(progress) })
    assert.equal(outcome.status, 'ok')
    assert.deepEqual(seen, [{ phase: 'notebook', cell: cell.cell, cells: cell.cells, outputBytes: cell.outputBytes }])
    // Cancelled once, by the cleanup after the end, not in the middle of the run.
    assert.equal(deleted.length, 1)
    assert.ok(polls >= 3)
  } finally { await closing(server) }
  // ...while a status of another job, or one whose own fields are broken, is still refused.
  let reply: unknown = { jobId: 'f'.repeat(32), kind: 'notebook', phase: 'running', startedAt: 1, finishedAt: null, exitCode: null, oomKilled: false, progress: install, error: null }
  const strict = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply)) })
  strict.listen(0, '127.0.0.1'); await once(strict, 'listening')
  const strictClient = new RuntimeClient({ url: `http://127.0.0.1:${(strict.address() as { port: number }).port}`, token: 'a'.repeat(64) })
  try {
    await assert.rejects(() => strictClient.competitionJob(jobId), /identity/i)
    reply = { jobId, kind: 'notebook', phase: 'running', startedAt: 1, finishedAt: null, exitCode: 'x', oomKilled: false, progress: install, error: null }
    await assert.rejects(() => strictClient.competitionJob(jobId), /identity|status/i)
    reply = { jobId, kind: 'notebook', phase: 'running', startedAt: 1, finishedAt: null, exitCode: null, oomKilled: false, error: null }
    await assert.rejects(() => strictClient.competitionJob(jobId), /identity|status/i)
  } finally { await closing(strict) }
})
