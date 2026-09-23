import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createCompetition, createEntrant, acceptSubmission, queueRows, leaveQueue, queueRow, setQueuePaused, getSubmission, enqueue, updateCompetition } from '../server/src/competitions/store.js'
import { TEST_ROOT } from './_env.mts'
import { putSubmissionNotebook, putOpenFile, putSecretFile, resultDir, inputDir, openDir } from '../server/src/competitions/storage.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, competitionRunner, forgetCompetitionRunner, limitsFor } from '../server/src/competitions/runner-port.js'
import { pumpOnce, setQueueSlots, rescoreCompetition, rerunSubmission, settleCompetitionWork } from '../server/src/competitions/runner.js'
import { runArgs, useDockerForCompetitions } from '../server/src/competitions/docker-runner.js'
import { harnessDir } from '../server/src/competitions/harness.js'

let seq = 0
function setup() {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false); setQueueSlots(1)
  const c = createCompetition({ slug: `attempt${++seq}`, title: 'audit', blurb: '', description: '', metric: { name: 'x', direction: 'lower', code: 'def score(solution, submission):\n return 1.0' }, publicPercent: 30, limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 0 }, environment: 'base' })!
  putOpenFile(c.id, 'sample_submission.csv', Buffer.from('id,target\n1,0\n2,0\n'))
  putSecretFile(c.id, 'solution.csv', Buffer.from('id,target\n1,1\n2,2\n'))
  const send = () => {
    const e = createEntrant('attempt').entrant
    const s = acceptSubmission({ competitionId: c.id, entrantId: e.id, fileName: 'audit.ipynb', bytes: 100 })
    putSubmissionNotebook(c.id, s.id, Buffer.from(JSON.stringify({ cells: [{ cell_type: 'code', source: 'pass', metadata: {}, outputs: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 })))
    return s
  }
  return { c, send }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const score = { status: 'ok' as const, public: 1, private: 2, message: null, teacherOnly: null, wall: 1, diagnostics: { exit: 0, oomKilled: false, backend: 'test' as const } }

test('rescore preserves the running lease and runs once afterwards with an isolated score directory', async () => {
  const { c, send } = setup(), submission = send()
  const runner = new FakeCompetitionRunner(), releases: Array<(value: any) => void> = [], dirs: string[] = []
  runner.score = async (request) => { dirs.push(request.outDir); return new Promise((resolve) => releases.push(resolve)) }
  useCompetitionRunner(runner)
  try {
    assert.equal(await pumpOnce(), 1); await tick()
    const lease = queueRow(submission.id)
    assert.equal(rescoreCompetition(c.id), 1)
    assert.equal(queueRow(submission.id)?.state, 'running')
    assert.equal(queueRow(submission.id)?.container, lease?.container)
    assert.equal(await pumpOnce(), 0)
    releases[0](score); await settleCompetitionWork()
    assert.equal(queueRow(submission.id)?.state, 'waiting')
    assert.equal(await pumpOnce(), 1); await tick()
    assert.equal(releases.length, 2)
    assert.notEqual(dirs[0], dirs[1])
    releases[1](score); await settleCompetitionWork()
    assert.equal(queueRow(submission.id), null)
    assert.equal(getSubmission(submission.id)?.state, 'scored')
  } finally { for (const done of releases) done(score); await settleCompetitionWork(); useCompetitionRunner(null) }
})

test('one capacity sample admits only jobs whose combined reservations fit, including later pumps', async () => {
  const { send } = setup(); send(); send(); send(); setQueueSlots(3)
  const runner = new FakeCompetitionRunner(), releases: Array<(value: any) => void> = []
  runner.availableMb = 4352
  runner.run = async () => new Promise((resolve) => releases.push(resolve))
  useCompetitionRunner(runner)
  try {
    assert.equal(await pumpOnce(), 1)
    assert.equal(await pumpOnce(), 0)
    assert.equal(releases.length, 1)
  } finally {
    for (const done of releases) done({ status: 'timeout', cell: 0, cells: 1, wall: 1, submission: null, detail: '', log: '', diagnostics: { exit: 1, oomKilled: false, backend: 'test' } })
    await settleCompetitionWork(); useCompetitionRunner(null)
  }
})

test('a nonzero new container cannot reuse a previous successful report or CSV', async () => {
  const { c, send } = setup(), submission = send(), out = resultDir(c.id, submission.id)
  fs.writeFileSync(path.join(out, 'submission.csv'), 'id,target\n1,5\n2,6\n')
  fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ status: 'ok', cell: 0, cells: 1, attemptId: 'previous' }))
  process.env.COMPETITION_BACKEND = 'docker'; useCompetitionRunner(null); forgetCompetitionRunner()
  useDockerForCompetitions(async (args) => ({ code: 0, out: args[0] === 'inspect' ? (args.at(-1) === '{{.State.Running}}' ? 'false' : 'exited 1 false') : '' }))
  try {
    const outcome = await competitionRunner().run({ competition: c, submissionId: submission.id, container: 'attempt-fake', dataDir: openDir(c.id), inputDir: inputDir(c.id, submission.id), resultDir: out, limits: limitsFor(c, 'notebook') })
    assert.notEqual(outcome.status, 'ok')
    assert.equal(outcome.submission, null)
  } finally { useDockerForCompetitions(null); delete process.env.COMPETITION_BACKEND; forgetCompetitionRunner() }
})

test('participant has no writable host mount and all writable export storage has a hard tmpfs bound', () => {
  const { c } = setup()
  const args = runArgs({ container: 'attempt-fake', image: 'base', dataDir: '/data/open', inputDir: '/data/in', resultDir: '/data/result', limits: limitsFor(c, 'notebook'), target: 'submission.csv' })
  const mounts = args.filter((_, i) => args[i - 1] === '-v')
  assert.ok(mounts.every((mount) => mount.endsWith(':ro')), 'no participant-writable host subtree')
  assert.ok(args.some((arg) => /^--tmpfs=\/result:.*size=\d+m/.test(arg)))
})

test('dropped continuous output keeps bounded progress updates and publishes hard-limit crossing immediately', () => {
  const script = `
import ast
from pathlib import Path
from types import SimpleNamespace
tree=ast.parse(Path(${JSON.stringify(path.join(harnessDir(), 'run_notebook.py'))}).read_text())
class Client:
    def __init__(self,*args,**kwargs): pass
    def output(self,*args): pass
clock=SimpleNamespace(now=0.0)
clock.monotonic=lambda: clock.now
scope=dict(NotebookClient=Client,time=clock,MAX_OUTPUT=2000000,MAX_OUTPUT_KILL=67108864)
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Runner'],type_ignores=[]),'<test>','exec'),scope)
runner=scope['Runner'](SimpleNamespace(cells=[])); beats=[]
runner.beat=lambda phase: beats.append(runner.output_bytes)
for i in range(70):
    clock.now+=0.01
    runner.output([],{'content':{'text':'x'*1000000}},None,0)
assert beats[-1]>=67108864,beats
assert len(beats)<10,beats
errors=scope['Runner'](SimpleNamespace(cells=[]))
errors.beat=lambda phase: None
errors.output([],{'content':{'ename':'Error','evalue':'short','traceback':['x'*3000000]}},None,0)
assert errors.output_bytes>=3000000,errors.output_bytes
`
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('a replaced lease ignores old progress and completion and persists the scoring revision captured at start', async () => {
  const { c, send } = setup(), submission = send(), runner = new FakeCompetitionRunner()
  const scores: Array<{ request: any; resolve: (value: any) => void }> = []
  runner.score = (request) => new Promise((resolve) => scores.push({ request, resolve }))
  useCompetitionRunner(runner); setQueueSlots(2)
  try {
    await pumpOnce(); await tick()
    const old = queueRow(submission.id)!
    leaveQueue(submission.id)
    enqueue({ submissionId: submission.id, competitionId: c.id, entrantId: submission.entrantId, kind: 'metric' })
    await pumpOnce(); await tick()
    const current = queueRow(submission.id)!
    assert.notEqual(old.attemptId, current.attemptId)
    scores[0].resolve({ ...score, public: 100 })
    await tick()
    assert.equal(queueRow(submission.id)?.attemptId, current.attemptId)
    assert.notEqual(getSubmission(submission.id)?.publicScore, 100)
    updateCompetition(c.id, { metric: { ...c.metric, code: 'def score(solution, submission):\n return 3.0' } })
    scores[1].resolve(score); await settleCompetitionWork()
    assert.equal(getSubmission(submission.id)?.inputRevision, c.inputRevision)
  } finally { for (const held of scores) held.resolve(score); await settleCompetitionWork(); useCompetitionRunner(null) }
})

test('the export reader rejects symlinks, special files and oversized nested content without copying trees', () => {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, 'exports-'))
  const exported = path.join(root, 'submission.csv')
  const run = () => spawnSync('python3', [path.join(harnessDir(), 'export_files.py'), 'file', root, 'submission.csv'], { encoding: 'utf8', env: { ...process.env, COMP_MAX_TARGET_BYTES: '4' } })
  fs.writeFileSync(exported, '1234')
  assert.equal(run().stdout, 'MTIzNA==')
  fs.writeFileSync(exported, '12345')
  assert.notEqual(run().status, 0)
  fs.unlinkSync(exported)
  fs.symlinkSync(path.join(root, 'other'), exported)
  fs.writeFileSync(path.join(root, 'other'), '1234')
  assert.notEqual(run().status, 0)
  fs.unlinkSync(exported)
  fs.mkdirSync(exported); fs.writeFileSync(path.join(exported, 'nested'), '1234')
  assert.notEqual(run().status, 0)
})

test('successful Docker export requires the current nonce and uses only bounded known artifact reads', async () => {
  const { c, send } = setup(), submission = send(), out = resultDir(c.id, submission.id)
  const nonce = 'current-attempt', reads: string[] = []
  process.env.COMPETITION_BACKEND = 'docker'; useCompetitionRunner(null); forgetCompetitionRunner()
  useDockerForCompetitions(async (args) => {
    if (args[0] === 'inspect') return { code: 0, out: args.at(-1) === '{{.State.Running}}' ? 'true' : 'running 0 false' }
    if (args[0] === 'exec') {
      if (args[5] === 'status') return { code: 0, out: JSON.stringify({ complete: { attemptId: nonce, exit: 0 } }) }
      const name = args.at(-1)!; reads.push(name)
      const value = name === 'run.json' ? JSON.stringify({ status: 'ok', attemptId: nonce, cell: 0, cells: 1 }) : name === 'submission.csv' ? 'id,target\n1,2\n' : '{}'
      return { code: 0, out: Buffer.from(value).toString('base64') }
    }
    return { code: 0, out: '' }
  })
  try {
    const outcome = await competitionRunner().run({ competition: c, submissionId: submission.id, attemptId: nonce, container: 'attempt-fake', dataDir: openDir(c.id), inputDir: inputDir(c.id, submission.id), resultDir: out, limits: limitsFor(c, 'notebook') })
    assert.equal(outcome.status, 'ok')
    assert.equal(fs.readFileSync(outcome.submission!, 'utf8'), 'id,target\n1,2\n')
    assert.deepEqual(reads, ['run.json', 'submission.csv', 'executed.ipynb'])
  } finally { useDockerForCompetitions(null); delete process.env.COMPETITION_BACKEND; forgetCompetitionRunner() }
})

test('cancellation arriving during Docker launch kills the eventual container before export', async () => {
  const { c, send } = setup(), submission = send(), signal = new AbortController(), commands: string[][] = []
  process.env.COMPETITION_BACKEND = 'docker'; useCompetitionRunner(null); forgetCompetitionRunner()
  useDockerForCompetitions(async (args) => {
    commands.push(args)
    if (args[0] === 'run') signal.abort()
    return { code: 0, out: args[0] === 'inspect' ? 'exited 137 false' : '' }
  })
  try {
    const outcome = await competitionRunner().run({ competition: c, submissionId: submission.id, signal: signal.signal, container: 'cancel-during-launch', dataDir: openDir(c.id), inputDir: inputDir(c.id, submission.id), resultDir: resultDir(c.id, submission.id), limits: limitsFor(c, 'notebook') })
    assert.notEqual(outcome.status, 'ok')
    assert.ok(commands.some((args) => args[0] === 'kill'))
    assert.ok(commands.some((args) => args[0] === 'rm'))
    assert.equal(commands.some((args) => args[0] === 'exec'), false)
  } finally { useDockerForCompetitions(null); delete process.env.COMPETITION_BACKEND; forgetCompetitionRunner() }
})

test('a failed rerun preserves the promoted CSV for rescore but publishes the current failure notebook', async () => {
  const { c, send } = setup(), submission = send(), runner = new FakeCompetitionRunner()
  useCompetitionRunner(runner)
  try {
    await pumpOnce(); await settleCompetitionWork()
    const answer = fs.readFileSync(path.join(resultDir(c.id, submission.id), 'submission.csv'), 'utf8')
    runner.run = async (request) => {
      fs.writeFileSync(path.join(request.resultDir, 'executed.ipynb'), '{"current":"failure"}')
      return { status: 'cell_error', cell: 0, cells: 1, wall: 1, submission: null, detail: 'current failure', log: '', diagnostics: { exit: 1, oomKilled: false, backend: 'test' } }
    }
    assert.equal(rerunSubmission(submission.id), true)
    await pumpOnce(); await settleCompetitionWork()
    assert.equal(fs.readFileSync(path.join(resultDir(c.id, submission.id), 'submission.csv'), 'utf8'), answer)
    assert.equal(fs.readFileSync(path.join(resultDir(c.id, submission.id), 'executed.ipynb'), 'utf8'), '{"current":"failure"}')
  } finally { await settleCompetitionWork(); useCompetitionRunner(null) }
})

test('failed container removal blocks admission until the orphan cleanup succeeds', async () => {
  const { c, send } = setup(), submission = send()
  process.env.COMPETITION_BACKEND = 'docker'; useCompetitionRunner(null); forgetCompetitionRunner()
  let removable = false
  useDockerForCompetitions(async (args) => ({ code: args[0] === 'rm' ? (removable ? 0 : 1) : 1, out: 'unavailable' }))
  try {
    const runner = competitionRunner()
    await assert.rejects(runner.run({ competition: c, submissionId: submission.id, container: 'cleanup-recovery', dataDir: openDir(c.id), inputDir: inputDir(c.id, submission.id), resultDir: resultDir(c.id, submission.id), limits: limitsFor(c, 'notebook') }), /cleanup/i)
    assert.equal((await runner.capacity()).availableMb, 0)
    removable = true
    assert.ok((await runner.capacity()).availableMb! > 0)
  } finally { removable = true; await competitionRunner().capacity(); useDockerForCompetitions(null); delete process.env.COMPETITION_BACKEND; forgetCompetitionRunner() }
})

test('unsupported broker competition runtime leaves queued jobs unclaimed', async () => {
  const { send } = setup(), submission = send(), before = { ...process.env }
  process.env.KERNEL_BACKEND = 'broker'; process.env.COMPETITION_BACKEND = 'docker'
  useCompetitionRunner(new FakeCompetitionRunner())
  try {
    assert.equal(await pumpOnce(), 0)
    assert.equal(queueRow(submission.id)?.state, 'waiting')
    assert.equal(getSubmission(submission.id)?.state, 'queued')
  } finally {
    await settleCompetitionWork(); useCompetitionRunner(null)
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]
    Object.assign(process.env, before)
  }
})
