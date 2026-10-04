/**
 * The hidden test (sealed inputs): the notebook reads it in `data/` during the
 * check, in place of the open example of the same name, and nobody else ever
 * gets its bytes.
 *
 * A canary row sits in the hidden file, and every way it could leave is
 * walked: the competition page, every file door, "my submissions" and its live
 * stream, the leaderboard, the notebook download, the traceback, the metric's
 * message, the server's own log, the class workspace. The same canary is
 * looked for on the teacher's side too, where it must show up: that is what
 * proves the probe actually carried it out of the run.
 */
import './_env.mts'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { ENTRANT_COOKIE, type Competition } from '../shared/competitions.js'
import type { EntrantCompetitionView, EntrantSubmissions, SubmissionAccepted } from '../shared/competitions-entrant.js'
import type { CompetitionView, SubmissionDetail } from '../shared/competitions-api.js'
import { parseCompetitionJobIntent, type CompetitionJobIntent, type CompetitionJobStatus } from '../shared/competition-runtime.js'
import { parseRuntimeCatalog } from '../shared/runtime.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { config } from '../server/src/config.js'
import {
  createCompetition,
  createEntrant,
  getCompetition,
  getSubmission,
  listFiles,
  listRuns,
  putFile,
  dropFile,
  rekeyCompetitionFiles,
  setCompetitionState,
  acceptSubmission,
} from '../server/src/competitions/store.js'
import {
  attemptPath,
  competitionsDir,
  composeRunInputs,
  dropAttempt,
  ensureCompetition,
  inputLinks,
  openDir,
  putOpenFile,
  putSealedFile,
  putSecretFile,
  readResultFile,
  readSealedFile,
  sealedDir,
} from '../server/src/competitions/storage.js'
import { runArgs } from '../server/src/competitions/docker-runner.js'
import { harnessDir } from '../server/src/competitions/harness.js'
import { BrokerCompetitionRunner } from '../server/src/competitions/broker-runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { limitsFor, useCompetitionRunner, type RunOutcome, type RunRequest } from '../server/src/competitions/runner-port.js'
import { drainCompetitionQueue, errorTypeOf } from '../server/src/competitions/runner.js'
import { CompetitionJobs } from '../runtime/src/competition-jobs.js'
import { db } from '../server/src/db.js'
import { app } from '../server/src/app.js'

/** The canary: a row of the hidden test that must never reach a participant. */
const CANARY = 'KANAREIKA-7f3a9c'
const EXAMPLE = 'id,feature\n1,0.5\n2,0.7\n'
const HIDDEN = `id,feature\n101,${CANARY}-a\n102,${CANARY}-b\n103,${CANARY}-c\n`
const enc = (text: string) => new TextEncoder().encode(text)

let base = ''
let server: http.Server
let staffCookie = ''

before(async () => {
  useCompetitionRunner(null)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const teacher = createTeacher({ name: 'Преподаватель', email: 'sealed.teacher@example.edu', role: 'owner' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse, teacher)
  staffCookie = `${STAFF_COOKIE}=${value}`
})
after(() => {
  useCompetitionRunner(null)
  server?.close()
})

function call(route: string, init: RequestInit & { cookie?: string | null } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json')
  return fetch(`${base}${route}`, { ...init, headers, redirect: 'manual' })
}
function cookieOf(res: Response): string | null {
  for (const line of res.headers.getSetCookie?.() ?? []) if (line.startsWith(`${ENTRANT_COOKIE}=`)) return line.split(';')[0]
  return null
}
const notebook = (...sources: string[]) => JSON.stringify({
  nbformat: 4, nbformat_minor: 5, metadata: {},
  cells: sources.map((source) => ({ cell_type: 'code', source, outputs: [], metadata: {}, execution_count: null })),
})

/** A live competition with the open example, the answers and nothing hidden yet. */
function competition(slug: string): Competition {
  const made = createCompetition({
    slug,
    title: slug,
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 0.5\n' },
    limits: { perDay: 50 },
  })
  assert.ok(made)
  setCompetitionState(made.id, 'live')
  ensureCompetition(made.id)
  putOpenFile(made.id, 'test.csv', enc(EXAMPLE))
  putFile({ competitionId: made.id, name: 'test.csv', bytes: EXAMPLE.length, rows: 2, visibility: 'open' })
  putOpenFile(made.id, 'sample_submission.csv', enc('id,target\n1,0\n2,0\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 20, rows: 2, visibility: 'open' })
  putSecretFile(made.id, 'solution.csv', enc('id,target\n101,1\n102,2\n103,3\n'))
  putFile({ competitionId: made.id, name: 'solution.csv', bytes: 30, rows: 3, visibility: 'hidden' })
  return getCompetition(made.id)!
}

/** The hidden test, the way the teacher's door writes it. */
function seal(c: Competition, name = 'test.csv', body = HIDDEN): void {
  putSealedFile(c.id, name, enc(body))
  putFile({ competitionId: c.id, name, bytes: body.length, rows: 3, visibility: 'sealed' })
}

/* ------------------------------------------------------------- the disk */

test('a hidden file lives in sealed/ only, never in data/', () => {
  const c = competition('sealed-disk')
  seal(c)
  assert.equal(readSealedFile(c.id, 'test.csv')!.toString(), HIDDEN)
  assert.equal(fs.readFileSync(path.join(openDir(c.id), 'test.csv'), 'utf8'), EXAMPLE, 'the example is untouched')
  assert.ok(sealedDir(c.id).startsWith(competitionsDir))
  assert.ok(path.relative(config.workspaceDir, sealedDir(c.id)).startsWith('..'), 'the hidden test is outside the class workspace')
})

test("a run's data folder: open files linked, the hidden one swapped in, gone with the attempt", async () => {
  const c = competition('sealed-compose')
  seal(c)
  seal(c, 'extra.csv', `only,${CANARY}\n`)
  const sid = 'sub23456'
  const aid = 'a'.repeat(32)
  const dir = await composeRunInputs(c.id, sid, aid, { open: ['test.csv', 'sample_submission.csv'], sealed: ['test.csv', 'extra.csv'] })
  assert.equal(dir, attemptPath(c.id, sid, aid, 'inputs'))
  assert.equal(fs.readFileSync(path.join(dir, 'test.csv'), 'utf8'), HIDDEN, 'the example is replaced')
  assert.equal(fs.readFileSync(path.join(dir, 'extra.csv'), 'utf8'), `only,${CANARY}\n`, 'a new name is added')
  // A hard link, not a copy: the same inode as the open file.
  assert.equal(fs.statSync(path.join(dir, 'sample_submission.csv')).ino, fs.statSync(path.join(openDir(c.id), 'sample_submission.csv')).ino)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['extra.csv', 'sample_submission.csv', 'test.csv'])
  // The teacher replaces the example mid-run: the run keeps the bytes it started with.
  putOpenFile(c.id, 'sample_submission.csv', enc('id,target\nnew\n'))
  assert.equal(fs.readFileSync(path.join(dir, 'sample_submission.csv'), 'utf8'), 'id,target\n1,0\n2,0\n')
  dropAttempt(c.id, sid, aid)
  assert.ok(!fs.existsSync(dir))
})

test('where the volume refuses hard links, the files are copied; a hidden file missing on disk fails the run', async () => {
  const c = competition('sealed-copy')
  seal(c)
  const link = inputLinks.link
  inputLinks.link = () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }) }
  try {
    const dir = await composeRunInputs(c.id, 'sub34567', 'b'.repeat(32), { open: ['test.csv', 'sample_submission.csv'], sealed: ['test.csv'] })
    assert.equal(fs.readFileSync(path.join(dir, 'test.csv'), 'utf8'), HIDDEN)
    assert.notEqual(fs.statSync(path.join(dir, 'sample_submission.csv')).ino, fs.statSync(path.join(openDir(c.id), 'sample_submission.csv')).ino)
  } finally {
    inputLinks.link = link
  }
  fs.rmSync(path.join(sealedDir(c.id), 'test.csv'))
  await assert.rejects(
    () => composeRunInputs(c.id, 'sub34567', 'c'.repeat(32), { open: ['test.csv'], sealed: ['test.csv'] }),
    /hidden test file test\.csv is missing/,
  )
})

/* ------------------------------------------------------------- the rows */

test('the example and the hidden test share a name and keep both rows; a hidden change makes the baseline stale', () => {
  const c = competition('sealed-rows')
  const revision = getCompetition(c.id)!.notebookInputRevision!
  seal(c)
  assert.ok(getCompetition(c.id)!.notebookInputRevision! > revision, 'the notebook reads the hidden test: its inputs changed')
  assert.deepEqual(listFiles(c.id, 'open').map((file) => file.name), ['sample_submission.csv', 'test.csv'])
  assert.deepEqual(listFiles(c.id, 'sealed').map((file) => file.name), ['test.csv'])
  // An open file named like the answers no longer turns the answers' row open.
  putFile({ competitionId: c.id, name: 'solution.csv', bytes: 1, visibility: 'open' })
  assert.deepEqual(listFiles(c.id, 'hidden').map((file) => file.name), ['solution.csv'])
  assert.equal(dropFile(c.id, 'test.csv', 'open'), true)
  assert.deepEqual(listFiles(c.id, 'sealed').map((file) => file.name), ['test.csv'], 'dropping the example keeps the test')
})

test('an older files table is rekeyed in place: the rows survive, the key gains the visibility', () => {
  db.exec(`
    CREATE TABLE competition_files_old (competition_id TEXT NOT NULL, name TEXT NOT NULL, bytes INTEGER NOT NULL,
      row_count INTEGER, visibility TEXT NOT NULL, uploaded_at INTEGER NOT NULL, PRIMARY KEY (competition_id, name));
    INSERT INTO competition_files_old SELECT competition_id, name, bytes, row_count, visibility, uploaded_at
      FROM competition_files WHERE visibility != 'sealed' GROUP BY competition_id, name;
    DROP TABLE competition_files;
    ALTER TABLE competition_files_old RENAME TO competition_files;
  `)
  const before = (db.prepare('SELECT COUNT(*) AS n FROM competition_files').get() as { n: number }).n
  assert.equal(rekeyCompetitionFiles(), true)
  assert.equal(rekeyCompetitionFiles(), false, 'once is enough')
  const after = (db.prepare('SELECT COUNT(*) AS n FROM competition_files').get() as { n: number }).n
  assert.equal(after, before)
  const key = (db.prepare('PRAGMA table_info(competition_files)').all() as { name: string; pk: number }[])
    .filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name)
  assert.deepEqual(key, ['competition_id', 'visibility', 'name'])
  const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'competition_files'").all() as { name: string }[])
    .map((row) => row.name).sort()
  assert.ok(triggers.includes('competition_files_insert_notebook_inputs'))
  assert.ok(triggers.includes('competition_files_insert_revision'))
  assert.ok(!triggers.some((name) => name.endsWith('_notebook_revision')), 'the old open-only triggers are gone')
  const c = competition('sealed-after-rekey')
  seal(c)
  assert.equal(listFiles(c.id, 'sealed').length, 1)
})

/* ------------------------------------------------------------ the runners */

/** The stand-in runner, remembering what each run was handed. */
class Watching extends FakeCompetitionRunner {
  seen: { request: RunRequest; files: Record<string, string> }[] = []
  override async run(request: RunRequest): Promise<RunOutcome> {
    const files: Record<string, string> = {}
    for (const name of fs.readdirSync(request.dataDir)) files[name] = fs.readFileSync(path.join(request.dataDir, name), 'utf8')
    this.seen.push({ request, files })
    return super.run(request)
  }
}

test("with a hidden test the notebook's data/ is the run's own folder; without one, the open data/ as before", async () => {
  const runner = new Watching()
  useCompetitionRunner(runner)
  try {
    const plain = competition('sealed-none')
    const who = createEntrant('@plain_runner').entrant.id
    const before = acceptSubmission({ competitionId: plain.id, entrantId: who, fileName: 'p.ipynb', bytes: 1 })
    fs.mkdirSync(path.join(competitionsDir, plain.id, 's', before.id, 'in'), { recursive: true })
    fs.writeFileSync(path.join(competitionsDir, plain.id, 's', before.id, 'in', 'notebook.ipynb'), notebook('print(1)'))
    await drainCompetitionQueue()
    const unsealed = runner.seen.at(-1)!
    assert.equal(unsealed.request.dataDir, openDir(plain.id))
    assert.ok(!('sealedInputs' in unsealed.request), 'nothing new on the request of an ordinary competition')
    assert.equal(getSubmission(before.id)!.sealedInputs, false)

    const c = competition('sealed-run')
    seal(c)
    const sent = acceptSubmission({ competitionId: c.id, entrantId: who, fileName: 's.ipynb', bytes: 1 })
    fs.mkdirSync(path.join(competitionsDir, c.id, 's', sent.id, 'in'), { recursive: true })
    fs.writeFileSync(path.join(competitionsDir, c.id, 's', sent.id, 'in', 'notebook.ipynb'), notebook('print(1)'))
    await drainCompetitionQueue()
    const sealed = runner.seen.at(-1)!
    assert.equal(sealed.request.sealedInputs, true)
    assert.match(sealed.request.dataDir, /\/attempts\/[a-f0-9]{32}\/inputs$/)
    assert.equal(sealed.files['test.csv'], HIDDEN, 'data/test.csv is the hidden test during the check')
    assert.ok(sealed.files['sample_submission.csv'])
    assert.ok(!fs.existsSync(sealed.request.dataDir), 'the folder went with the attempt')
    assert.equal(fs.readFileSync(path.join(openDir(c.id), 'test.csv'), 'utf8'), EXAMPLE)
    assert.equal(getSubmission(sent.id)!.sealedInputs, true)
    assert.equal(listRuns(sent.id).filter((run) => run.kind === 'notebook').length, 1)
  } finally {
    useCompetitionRunner(null)
  }
})

test("the real harness: data/test.csv and /data/test.csv both read the hidden test from the run's folder", async (t) => {
  if (spawnSync('python3', ['-c', 'import nbformat'], { encoding: 'utf8' }).status !== 0) return t.skip('no python3 with nbformat')
  const c = competition('sealed-harness')
  seal(c)
  const data = await composeRunInputs(c.id, 'sub45678', 'd'.repeat(32), { open: ['test.csv'], sealed: ['test.csv'] })
  const root = fs.mkdtempSync(path.join(process.env.DATA_DIR as string, 'sealed-play-'))
  const fake = path.join(root, 'fake', 'nbclient')
  fs.mkdirSync(fake, { recursive: true })
  fs.writeFileSync(path.join(fake, 'exceptions.py'), 'class CellExecutionError(Exception): pass\nclass CellTimeoutError(TimeoutError): pass\nclass DeadKernelError(RuntimeError): pass\n')
  // A stand-in nbclient that "reads" a path the way a cell would, from the
  // notebook's working folder: "read data/test.csv" prints the file.
  fs.writeFileSync(path.join(fake, '__init__.py'), `
import os
import nbformat
class NotebookClient:
    def __init__(self, nb, **kwargs):
        self.nb = nb
        self.cwd = kwargs['resources']['metadata']['path']
        self.timeout = kwargs.get('timeout')
        self.timeout_func = None
        self.shutdown_kernel = 'graceful'
    def output(self, outs, msg, display_id, cell_index):
        outs.append(nbformat.v4.new_output('stream', name='stdout', text=msg['content']['text']))
    def execute(self):
        for index, cell in enumerate(self.nb.cells):
            self.on_cell_start(cell=cell, cell_index=index)
            cell.outputs = []
            for line in cell.source.splitlines():
                if line.startswith('read '):
                    with open(os.path.join(self.cwd, line[5:])) as handle:
                        self.output(cell.outputs, {'content': {'text': handle.read()}}, None, index)
            cell.execution_count = index + 1
            self.on_cell_executed(cell=cell, cell_index=index)
`)
  for (const part of ['in', 'out', 'result', 'home']) fs.mkdirSync(path.join(root, part))
  fs.writeFileSync(path.join(root, 'in', 'notebook.ipynb'), notebook('read data/test.csv', `read ${data}/test.csv`))
  const result = spawnSync('python3', [path.join(harnessDir(), 'run_notebook.py')], {
    encoding: 'utf8', timeout: 60_000,
    env: {
      PATH: process.env.PATH, HOME: path.join(root, 'home'), PYTHONPATH: path.join(root, 'fake'),
      COMP_NOTEBOOK: path.join(root, 'in', 'notebook.ipynb'), COMP_OUT: path.join(root, 'out'),
      COMP_RESULT: path.join(root, 'result'), COMP_DATA: data, COMP_ATTEMPT_ID: 'play',
    },
  })
  const executed = JSON.parse(fs.readFileSync(path.join(root, 'result', 'executed.ipynb'), 'utf8')) as { cells: { outputs: { text: string | string[] }[] }[] }
  const text = (i: number) => executed.cells[i].outputs.map((o) => (Array.isArray(o.text) ? o.text.join('') : o.text)).join('')
  assert.equal(text(0), HIDDEN, `data/test.csv (relative, through the harness's link): ${result.stderr}`)
  assert.equal(text(1), HIDDEN, 'the mount point itself, /data/test.csv in the container')
  assert.equal(fs.readlinkSync(path.join(root, 'out', 'data')), data, 'the working folder links data/ to the mount')
})

test("Docker mounts the run's own folder at /data, read-only, and never the sealed folder itself", () => {
  const inputs = attemptPath('abcd2345', 'efgh2345', 'e'.repeat(32), 'inputs')
  const args = runArgs({
    container: 'c', image: 'colloq-kernel:base', dataDir: inputs,
    inputDir: '/x/in', resultDir: '/x/out', target: 'submission.csv',
    limits: limitsFor({ limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 } } as Competition, 'notebook'),
  })
  const mounts = args.filter((_arg, i) => args[i - 1] === '-v')
  assert.ok(mounts.includes(`${inputs}:/data:ro`), mounts.join(' '))
  assert.ok(!mounts.some((mount) => mount.includes('/sealed') || mount.includes('/secret')))
})

const digest = `sha256:${'a'.repeat(64)}`
const image = `registry.example/colloq/kaggle-base@${digest}`
function brokerClient(seen: CompetitionJobIntent[]) {
  let current: CompetitionJobIntent
  const status = (intent: CompetitionJobIntent): CompetitionJobStatus => ({ jobId: intent.jobId, kind: intent.kind, phase: 'complete', startedAt: 1, finishedAt: 2, exitCode: 0, oomKilled: false, progress: null, error: null })
  return {
    async startCompetitionJob(intent: CompetitionJobIntent) { current = intent; seen.push(parseCompetitionJobIntent(intent)); return status(intent) },
    async competitionJob() { return status(current) },
    async collectCompetitionJob() { return { files: [], totalBytes: 0 } },
    async cancelCompetitionJob() {},
    async competitionJobs() { return [] },
  }
}

test('the broker gets a typed flag for the hidden test, and refuses any other data folder with it', async () => {
  const seen: CompetitionJobIntent[] = []
  const runner = new BrokerCompetitionRunner(brokerClient(seen) as any, { catalog: () => ({ schemaVersion: 1, release: 'r', defaultEnvironment: 'kaggle-base', environments: [{ name: 'kaggle-base', image, gpu: false, current: true }] }), pollMs: 1 })
  const competitionRow = { id: 'abcdefgh', environment: 'kaggle-base', publicPercent: 30, splitSeed: 's' } as Competition
  const limits = limitsFor({ limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 } } as Competition, 'notebook')
  const attemptId = 'f'.repeat(32)
  const resultDir = attemptPath('abcdefgh', 'bcdefghi', attemptId, 'result')
  const ask = (extra: Partial<RunRequest>) => runner.run({ competition: competitionRow, submissionId: 'bcdefghi', attemptId, container: 'c', imageDigest: image, dataDir: openDir('abcdefgh'), inputDir: 'x', resultDir, limits, ...extra })
  await ask({})
  assert.equal(seen.at(-1)!.sealedInputs, undefined, 'no flag, no new key: an older broker reads it as before')
  await ask({ sealedInputs: true, dataDir: attemptPath('abcdefgh', 'bcdefghi', attemptId, 'inputs') })
  assert.equal(seen.at(-1)!.sealedInputs, true)
  const count = seen.length
  await assert.rejects(() => ask({ sealedInputs: true }), /attempt inputs folder/)
  assert.equal(seen.length, count, 'refused before any job started')
})

test('the broker Pod mounts the attempt inputs at /data with the flag; the metric never takes it', async () => {
  const jobId = 'a'.repeat(32), attemptId = 'b'.repeat(32), revision = `sha256:${'c'.repeat(64)}`
  const catalog = parseRuntimeCatalog({ schemaVersion: 1, release: 'v1', defaultEnvironment: 'kaggle-base', environments: [{ name: 'kaggle-base', image: `registry.example/kernel@${revision}`, gpu: false }] })
  const limits = { wallSeconds: 120, memoryMb: 1024, cpus: 2, pids: 128, tmpfsMb: 256, targetBytes: 10_000_000 }
  const intent = (extra: object = {}) => ({ schemaVersion: 1 as const, jobId, kind: 'notebook' as const, environment: 'kaggle-base', revision, limits, competitionId: 'abcd2345', submissionId: 'efgh2345', attemptId, ...extra })
  const pods: any[] = []
  const objects = new Map<string, any>()
  objects.set('/api/v1/namespaces/colloq/persistentvolumeclaims/colloq-data', { metadata: { name: 'colloq-data' } })
  for (const name of ['competition-job-isolation', 'competition-resolver-isolation', 'competition-proxy-isolation'])
    objects.set(`/apis/networking.k8s.io/v1/namespaces/colloq/networkpolicies/${name}`, { metadata: { name } })
  const kube = { async request<T>(method: string, route: string, body?: any): Promise<T> {
    const key = route.split('?')[0]
    if (method === 'GET' && (key.endsWith('/pods') || key.endsWith('/services'))) return { items: [], metadata: {} } as T
    if (method === 'GET') return (objects.get(key) ?? (() => { throw Object.assign(new Error('missing'), { status: 404 }) })()) as T
    if (method === 'POST') { if (key.endsWith('/pods')) pods.push(body); return { ...body, metadata: { ...body.metadata, uid: '1' } } as T }
    return {} as T
  } }
  const jobs = new CompetitionJobs({ kube, config: { namespace: 'colloq', dataClaim: 'colloq-data', exporterImage: `registry.example/runtime@sha256:${'d'.repeat(64)}`, instanceId: 'instance123' }, catalog: () => catalog, secret: () => 'x'.repeat(64), exporter: async () => ({ files: [], totalBytes: 0 }), now: () => Date.now() })
  await jobs.start(jobId, intent({ sealedInputs: true }))
  const data = pods[0].spec.containers[0].volumeMounts.find((m: any) => m.mountPath === '/data')
  assert.equal(data.subPath, `competitions/abcd2345/s/efgh2345/attempts/${attemptId}/inputs`)
  assert.equal(data.readOnly, true)
  assert.ok(!pods[0].spec.containers.some((c: any) => c.volumeMounts.some((m: any) => String(m.subPath).includes('/sealed'))))
  // The contract: notebook jobs only, and only `true`.
  assert.throws(() => parseCompetitionJobIntent({ ...intent({ sealedInputs: true }), kind: 'metric' }), /Unexpected sealed inputs/)
  assert.throws(() => parseCompetitionJobIntent(intent({ sealedInputs: false })), /Unexpected sealed inputs/)
  assert.equal(parseCompetitionJobIntent(intent()).sealedInputs, undefined)
})

test('the exception class a participant may be told comes from a short list', () => {
  assert.equal(errorTypeOf('Traceback (most recent call last):\n  ...\nValueError: could not convert'), 'ValueError')
  assert.equal(errorTypeOf('...\npandas.errors.ParserError: Error tokenizing data'), 'ParserError')
  // A message with line breaks pushes the class up; the nearest such line is taken.
  assert.equal(errorTypeOf('...\nKeyError: first\nsecond line'), 'KeyError')
  // A class the notebook made up and named after what it read never passes.
  assert.equal(errorTypeOf(`...\n${CANARY.replaceAll('-', '_')}Error: boom`), null)
  assert.equal(errorTypeOf(''), null)
})

/* ------------------------------------------------------- through the doors */

const SLUG = 'sealed-doors'
let doors: Competition
let cookie = ''
const sent: Record<string, { id: string; body: string }> = {}

/** Everything the server printed while the runs went, to look for the canary in. */
const printed: string[] = []

async function upload(name: string, body: string) {
  const form = new FormData()
  form.append('file', new Blob([body]), `${name}.ipynb`)
  const res = await call(`/api/k/competitions/${SLUG}/submissions`, { method: 'POST', body: form, cookie })
  assert.equal(res.status, 200, name)
  sent[name] = { id: ((await res.json()) as SubmissionAccepted).submission.id, body }
  // Run it before the next upload, which would otherwise take its place in the queue.
  await drainCompetitionQueue()
}

test('the teacher uploads the hidden test through its own door, under a target name, and gets no download', async () => {
  doors = competition(SLUG)
  const form = new FormData()
  form.append('name', 'test.csv')
  form.append('file', new Blob([HIDDEN]), 'test_full.csv')
  const res = await call(`/api/admin/competitions/${doors.id}/sealed`, { method: 'POST', body: form, cookie: staffCookie })
  assert.equal(res.status, 200)
  const view = (await res.json()) as CompetitionView
  assert.deepEqual(view.sealedFiles?.map((file) => ({ name: file.name, replaces: file.replaces, rows: file.rows, columns: file.columns })),
    [{ name: 'test.csv', replaces: 'test.csv', rows: 3, columns: ['id', 'feature'] }])
  const extra = new FormData()
  extra.append('file', new Blob([`id,value\n1,${CANARY}\n`]), 'extra.csv')
  assert.equal((await call(`/api/admin/competitions/${doors.id}/sealed`, { method: 'POST', body: extra, cookie: staffCookie })).status, 200)
  // A name is for one file only.
  const two = new FormData()
  two.append('name', 'x.csv')
  two.append('file', new Blob(['a']), 'a.csv')
  two.append('file', new Blob(['b']), 'b.csv')
  assert.equal((await call(`/api/admin/competitions/${doors.id}/sealed`, { method: 'POST', body: two, cookie: staffCookie })).status, 400)
  // Not for participants, not for anyone without the panel.
  assert.equal((await call(`/api/admin/competitions/${doors.id}/sealed`, { method: 'POST', body: extra })).status, 401)
  const listed = await call(`/api/admin/competitions/${doors.id}/sealed`, { cookie: staffCookie })
  const listedText = await listed.text()
  assert.match(listedText, /extra\.csv/)
  assert.doesNotMatch(listedText, new RegExp(CANARY))
  // Neither the open-file door nor any made-up one hands out the hidden bytes.
  for (const route of [`/api/admin/competitions/${doors.id}/files/test.csv`, `/api/admin/competitions/${doors.id}/files/extra.csv`, `/api/admin/competitions/${doors.id}/sealed/test.csv`]) {
    const body = await (await call(route, { cookie: staffCookie })).text()
    assert.doesNotMatch(body, new RegExp(CANARY), route)
  }
  assert.doesNotMatch(JSON.stringify(view), new RegExp(CANARY))
})

test('the participant sees the hidden test as names and rows, and downloads only the example', async () => {
  const joined = await call(`/api/k/competitions/${SLUG}/join`, { method: 'POST', body: JSON.stringify({ name: '@leaky_student' }) })
  assert.equal(joined.status, 200)
  cookie = cookieOf(joined)!
  const res = await call(`/api/k/competitions/${SLUG}`, { cookie })
  const text = await res.text()
  assert.doesNotMatch(text, new RegExp(CANARY))
  const view = JSON.parse(text) as EntrantCompetitionView
  assert.deepEqual(view.files.map((file) => [file.name, file.sealed ?? false]), [['sample_submission.csv', false], ['test.csv', true]])
  assert.deepEqual(view.sealedFiles, [
    { name: 'extra.csv', rows: 1, replaces: null, columns: null },
    { name: 'test.csv', rows: 3, replaces: 'test.csv', columns: ['id', 'feature'] },
  ])
  assert.equal(await (await call(`/api/k/competitions/${SLUG}/files/test.csv`, { cookie })).text(), EXAMPLE)
  assert.equal((await call(`/api/k/competitions/${SLUG}/files/extra.csv`, { cookie })).status, 404)
})

test('notebooks that try to carry the hidden test out: it reaches the teacher, never the participant', async () => {
  const write = (stream: 'log' | 'warn' | 'error') => {
    const original = console[stream]
    console[stream] = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); original(...args) }
    return () => { console[stream] = original }
  }
  const restore = [write('log'), write('warn'), write('error')]
  try {
    // Reads data/test.csv into its answer: the check ran on the hidden rows.
    await upload('reads', notebook('# colloq-test: {"read": "test.csv"}', 'x = 1'))
    await upload('reads-extra', notebook('# colloq-test: {"read": "extra.csv"}'))
    // Raises with the hidden rows in its message, prints them, and lies about its cell.
    await upload('raises', notebook('# colloq-test: {"status": "cell_error", "detailFrom": "test.csv", "executed": true, "cell": 99999}', 'y = 2'))
    // Writes the rows into its answer, and the metric quotes the answer back.
    await upload('echoes', notebook('# colloq-test: {"read": "test.csv", "metric": "participant_error", "echo": true}'))
    // Our own alignment check, which would quote an id of the hidden test.
    await upload('misaligned', notebook('# colloq-test: {"metric": "participant_error"}'))
    // A made-up exception class named after what it read.
    await upload('named', notebook('# colloq-test: {"status": "cell_error", "detail": "Traceback\\nLEAKYNAMEError: boom"}'))
    await drainCompetitionQueue()
  } finally {
    for (const undo of restore) undo()
  }
  // The probe works: the answers and the teacher's view carry the canary.
  assert.match(readResultFile(doors.id, sent.reads.id, 'submission.csv')!.toString(), new RegExp(`${CANARY}-a`), 'data/test.csv was the hidden test')
  assert.match(readResultFile(doors.id, sent['reads-extra'].id, 'submission.csv')!.toString(), new RegExp(CANARY), 'a hidden name of its own is readable too')
  const detail = (await (await call(`/api/admin/competitions/${doors.id}/submissions/${sent.raises.id}`, { cookie: staffCookie })).json()) as SubmissionDetail
  assert.match(detail.submission.participantError ?? '', new RegExp(CANARY))
  assert.match(readResultFile(doors.id, sent.raises.id, 'executed.ipynb')!.toString(), new RegExp(CANARY))
  assert.match(getSubmission(sent.echoes.id)!.participantError ?? '', new RegExp(CANARY))

  assert.ok(!printed.some((line) => line.includes(CANARY)), 'the server log never prints the hidden rows')
})

test('every participant door answers without the canary: the run is blind', async () => {
  const mineText = await (await call(`/api/k/competitions/${SLUG}/submissions`, { cookie })).text()
  assert.doesNotMatch(mineText, new RegExp(CANARY))
  assert.doesNotMatch(mineText, /LEAKYNAME|398692/)
  const mine = JSON.parse(mineText) as EntrantSubmissions
  const row = (name: string) => mine.submissions.find((s) => s.id === sent[name].id)!

  const raises = row('raises')
  assert.equal(raises.state, 'notebookFailed')
  assert.equal(raises.blind, true)
  assert.equal(raises.errorType, 'ValueError')
  assert.equal(raises.cellsTotal, 2, 'the cells of the notebook that was sent')
  assert.ok(raises.cellsDone <= raises.cellsTotal, `cell ${raises.cellsDone} of ${raises.cellsTotal}`)
  assert.match(raises.participantError ?? '', /ячейке 2 из 2: ValueError\. Текст ошибки и вывод скрыты/)
  assert.equal(raises.notebook, 'sent')
  assert.ok(!('briefError' in raises) && !('teacherError' in raises))

  assert.equal(row('echoes').state, 'rejected')
  assert.match(row('echoes').participantError ?? '', /Метрика не приняла ответ\. Подробности скрыты/)
  assert.equal(row('misaligned').participantError, 'В ответе есть не все строки теста. Стройте ответ по строкам data/, а не по номерам из примера.')
  assert.equal(row('named').errorType, null)
  assert.match(row('named').participantError ?? '', /^Тетрадь упала на ячейке \d+ из \d+\. Текст ошибки/)
  assert.equal(row('reads').state, 'scored')
  assert.equal(row('reads').blind, true)

  // The download is the notebook as sent, byte for byte.
  const download = await call(`/api/k/competitions/${SLUG}/submissions/${sent.raises.id}/notebook`, { cookie })
  assert.equal(download.status, 200)
  assert.equal(await download.text(), sent.raises.body)

  // The live stream's first frame, the board, the list, the page.
  const abort = new AbortController()
  const stream = await fetch(`${base}/api/k/competitions/${SLUG}/stream`, { headers: { cookie }, signal: abort.signal })
  const reader = stream.body!.getReader()
  let frame = ''
  while (!frame.includes('\n\n')) frame += new TextDecoder().decode((await reader.read()).value)
  abort.abort()
  assert.match(frame, /^event: state/)
  assert.doesNotMatch(frame, new RegExp(CANARY))
  for (const route of [`/api/k/competitions/${SLUG}/leaderboard`, '/api/k/competitions', `/api/k/competitions/${SLUG}`]) {
    assert.doesNotMatch(await (await call(route, { cookie })).text(), new RegExp(CANARY), route)
  }
})

test("nothing of the hidden test lands in the class workspace", () => {
  const walk = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
  }
  for (const file of walk(config.workspaceDir)) {
    assert.doesNotMatch(fs.readFileSync(file).toString('latin1'), new RegExp(CANARY), file)
  }
})

test('"full output" hands the participant everything again, and back to brief hides it, with no rerun', async () => {
  const patch = (outputPolicy: string) => call(`/api/admin/competitions/${doors.id}`, { method: 'PATCH', body: JSON.stringify({ outputPolicy }), cookie: staffCookie })
  assert.equal((await patch('full')).status, 200)
  const full = (await (await call(`/api/k/competitions/${SLUG}/submissions`, { cookie })).json()) as EntrantSubmissions
  const raises = full.submissions.find((s) => s.id === sent.raises.id)!
  assert.equal(raises.blind, undefined)
  assert.match(raises.participantError ?? '', new RegExp(CANARY))
  assert.equal(raises.notebook, 'executed')
  assert.match(await (await call(`/api/k/competitions/${SLUG}/submissions/${sent.raises.id}/notebook`, { cookie })).text(), new RegExp(CANARY))
  assert.equal((await patch('brief')).status, 200)
  assert.doesNotMatch(await (await call(`/api/k/competitions/${SLUG}/submissions`, { cookie })).text(), new RegExp(CANARY))
  assert.equal(await (await call(`/api/k/competitions/${SLUG}/submissions/${sent.raises.id}/notebook`, { cookie })).text(), sent.raises.body)
})

test('a competition without a hidden test shows a failed run in full, exactly as before', async () => {
  competition('sealed-plain-doors')
  const joined = await call('/api/k/competitions/sealed-plain-doors/join', { method: 'POST', body: JSON.stringify({ name: '@open_student' }) })
  const own = cookieOf(joined)!
  const form = new FormData()
  const body = notebook('# colloq-test: {"status": "cell_error", "detail": "Traceback\\nValueError: visible to its author", "executed": true}')
  form.append('file', new Blob([body]), 'a.ipynb')
  const res = await call('/api/k/competitions/sealed-plain-doors/submissions', { method: 'POST', body: form, cookie: own })
  const id = ((await res.json()) as SubmissionAccepted).submission.id
  await drainCompetitionQueue()
  const mine = (await (await call('/api/k/competitions/sealed-plain-doors/submissions', { cookie: own })).json()) as EntrantSubmissions
  const row = mine.submissions.find((s) => s.id === id)!
  assert.equal(row.blind, undefined)
  assert.equal(row.sealedInputs, false)
  assert.match(row.participantError ?? '', /ValueError: visible to its author/)
  assert.equal(row.notebook, 'executed')
})

test('a blind run reports its time in whole seconds', async () => {
  const { entrantSubmission } = await import('../shared/competitions.ts')
  const base = { durationMs: 12_345, teacherError: 'x', briefError: 'brief', privateScore: 0.9 } as never
  const out = entrantSubmission(base, false, true) as { durationMs: number | null; participantError: string | null }
  assert.equal(out.durationMs, 12_000)
  assert.equal(out.participantError, 'brief')
  const open = entrantSubmission(base, false, false) as { durationMs: number | null }
  assert.equal(open.durationMs, 12_345)
})
