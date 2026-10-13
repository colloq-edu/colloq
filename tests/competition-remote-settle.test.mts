/**
 * The notebook step of a machine that runs submissions, settled by this
 * server (runner.ts · prepareNotebook, settleNotebook, continueAsMetric), and
 * the guard that lets an outcome be applied twice (storage.ts ·
 * publishAttemptArtifacts, promoteAttempt).
 *
 * Each fails quietly. A preparation that awaits cannot run inside the
 * transaction that leases the row, and a lease without its run row is a run
 * nobody can account for. A result that comes back and goes to the end of the
 * queue punishes the participant for the machine. An outcome applied again
 * after a crash that publishes again finds its notebook already moved and
 * removes the one it had just put in place — and the answer check that
 * follows finds the answer moved too, and calls a good submission one that
 * wrote no file. A machine's run judged against this server's cards waits
 * half a minute on a neighbour that is not its neighbour. And a chmod that
 * sets the mode a file already has moves its ctime, so every hash cached by
 * stat is read again from disk.
 *
 * No machine: its outcome is what the machine would send, handed to the
 * same functions its outcome handler will call.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { db } from '../server/src/db.js'
import { tr } from '../shared/i18n.js'
import type { Competition, Submission } from '../shared/competitions.js'
import { REMOTE_CONTAINER } from '../shared/remote-runner.js'
import {
  BOOT,
  acceptSubmission,
  createCompetition,
  createEntrant,
  enqueue,
  getSubmission,
  leaveQueue,
  listRuns,
  putFile,
  queueRow,
  queueRows,
  setCompetitionState,
  setQueuePaused,
  takeNext,
  updateCompetition,
  updateSubmission,
  type QueueRow,
} from '../server/src/competitions/store.js'
import { bindSubmission, completeBundle, createBundle, putRevision, selectRevision, setPolicy } from '../server/src/dependencies/store.js'
import {
  attemptDir,
  attemptPath,
  competitionsDir,
  competitionsFs,
  EXECUTED_FILE,
  promoteAttempt,
  publishAttemptArtifacts,
  putOpenFile,
  putSealedFile,
  putSecretFile,
  putSubmissionNotebook,
  resultDir,
  SUBMISSION_FILE,
} from '../server/src/competitions/storage.js'
import { SOLUTION_NAME } from '../server/src/competitions/docker-runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner, type RunOutcome } from '../server/src/competitions/runner-port.js'
import {
  continueAsMetric,
  drainCompetitionQueue,
  letContainerRead,
  prepareNotebook,
  setQueueSlots,
  settleNotebook,
  unfitOutcome,
  type PreparedNotebook,
} from '../server/src/competitions/runner.js'

/* ------------------------------------------------------------------ setup */

const runner = new FakeCompetitionRunner()
useCompetitionRunner(runner)

const MACHINE = 'machine-7'

function reset(): void {
  for (const row of queueRows()) leaveQueue(row.submissionId)
  setQueuePaused(false)
  setQueueSlots(1)
}

let seq = 0
const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const ANSWER = 'id,target\n1,0\n2,0\n'

function competition(options: { gpu?: boolean; sealed?: boolean; memoryMb?: number } = {}): Competition {
  seq += 1
  const made = createCompetition({
    slug: `remote${seq}`,
    title: `Remote ${seq}`,
    blurb: '',
    description: '',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 1.0\n' },
    publicPercent: 30,
    limits: { wallSeconds: 600, memoryMb: options.memoryMb ?? 4096, cpus: 2, perDay: 0, ...(options.gpu ? { gpu: true } : {}) },
    environment: options.gpu ? 'base-gpu' : 'base',
  })
  assert.ok(made)
  putOpenFile(made.id, 'sample_submission.csv', enc(ANSWER))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: ANSWER.length, visibility: 'open' })
  putSecretFile(made.id, SOLUTION_NAME, enc('id,target\n1,1\n2,2\n'))
  if (options.sealed) {
    putOpenFile(made.id, 'test.csv', enc('id,feature\n1,0.5\n'))
    putFile({ competitionId: made.id, name: 'test.csv', bytes: 18, visibility: 'open' })
    putSealedFile(made.id, 'test.csv', enc('id,feature\n101,hidden\n'))
    putFile({ competitionId: made.id, name: 'test.csv', bytes: 22, visibility: 'sealed' })
  }
  return made
}

function send(c: Competition, cells: string[] = ['x = 1'], at = Date.now()): Submission {
  const entrant = createEntrant(`Машина ${seq}-${randomUUID().slice(0, 6)}`).entrant
  const submission = acceptSubmission({ competitionId: c.id, entrantId: entrant.id, fileName: 'solution.ipynb', bytes: 100, at })
  putSubmissionNotebook(c.id, submission.id, enc(JSON.stringify({
    cells: cells.map((source) => ({ cell_type: 'code', source, metadata: {}, outputs: [] })),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })))
  return submission
}

/** The row as a machine's take leaves it: running under a fresh attempt, this server's boot, the machine as holder. */
function holdOnMachine(submissionId: string): QueueRow {
  db.prepare(`UPDATE competition_queue SET state = 'running', started_at = ?, attempts = attempts + 1, boot = ?, attempt_id = ?, holder = ?
    WHERE submission_id = ?`).run(Date.now(), BOOT, randomUUID().replaceAll('-', ''), MACHINE, submissionId)
  return queueRow(submissionId)!
}

/** Lease a submission to the machine and prepare its step, both in one transaction, as the take for a machine will. */
function leaseAndPrepare(submissionId: string): PreparedNotebook {
  const prepared = db.transaction(() => prepareNotebook(holdOnMachine(submissionId), 'remote'))()
  assert.ok(prepared, 'the submission and its competition are there')
  assert.ok(!(prepared instanceof Promise), 'prepared without waiting on anything')
  return prepared
}

/** What the machine's upload leaves in the attempt's result folder (§3.6): the answer and the executed notebook. */
function machineResults(prepared: PreparedNotebook, executed = '{"cells":[],"note":"executed on the machine"}'): void {
  competitionsFs.writeFileSync(path.join(prepared.result, SUBMISSION_FILE), enc(ANSWER), { mode: 0o600 })
  competitionsFs.writeFileSync(path.join(prepared.result, EXECUTED_FILE), enc(executed), { mode: 0o600 })
}

function finished(prepared: PreparedNotebook, over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    status: 'ok', cell: 0, cells: 1, wall: 4200, submission: path.join(prepared.result, SUBMISSION_FILE), detail: '', log: '',
    diagnostics: { exit: 0, oomKilled: false, backend: 'docker' },
    ...over,
  }
}

const read = (file: string): string | null => {
  try { return (competitionsFs.readFileSync(file) as Buffer).toString('utf8') } catch { return null }
}

/* --------------------------------------------------------------- preparing */

test("a machine's step is prepared in the transaction that leases it, by the code a run here is prepared by", () => {
  reset()
  const c = competition()
  const sent = send(c)
  const prepared = leaseAndPrepare(sent.id)
  assert.equal(prepared.placement, 'remote')
  assert.match(prepared.container, REMOTE_CONTAINER, 'a name the lease can carry')
  const runs = listRuns(sent.id)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].kind, 'notebook')
  assert.equal(runs[0].finishedAt, null)
  assert.equal(runs[0].container, prepared.container)
  assert.equal(runs[0].id, prepared.runId)
  assert.equal(queueRow(sent.id)?.container, prepared.container)
  assert.equal(queueRow(sent.id)?.holder, MACHINE)
  const submission = getSubmission(sent.id)!
  assert.equal(submission.state, 'running')
  assert.equal(submission.stage, 'notebook')
  assert.equal(prepared.sealed, false)
  assert.equal(prepared.codeCells, null)
  assert.ok(fs.existsSync(prepared.result), 'the result folder the upload is moved into')
  reset()
})

test("on the hidden test a machine's step is held to the notebook sent, and nothing is composed here", () => {
  reset()
  const c = competition({ sealed: true })
  const sent = send(c, ['a', 'b', 'c'])
  const prepared = leaseAndPrepare(sent.id)
  assert.equal(prepared.sealed, true)
  assert.deepEqual(prepared.sealedFiles, ['test.csv'])
  assert.equal(prepared.codeCells, 3)
  assert.equal(getSubmission(sent.id)?.sealedInputs, true, 'blind from this run on')
  // The machine composes its own data folder; this server lays out none for it.
  assert.equal(fs.existsSync(attemptPath(c.id, sent.id, prepared.row.attemptId!, 'inputs')), false)
  reset()
})

test('a set that cannot fit is refused before any container, wherever the run was to go', async () => {
  reset()
  const MiB = 1024 * 1024
  const c = competition({ memoryMb: 2048 })
  setCompetitionState(c.id, 'live')
  const revision = putRevision({
    environmentName: 'base', imageDigest: `sha256:${'e'.repeat(64)}`, pythonVersion: '3.11.16', pythonAbi: 'cp311',
    platform: 'linux/arm64', packages: [{ name: 'numpy', version: '2.4.6' }], baseConstraintsHash: 'hash',
  })
  selectRevision(c.id, revision.id)
  setPolicy(c.id, { enabled: true })
  const sent = send(c, ['import catboost'])
  const set = createBundle(c.id, sent.entrantId, revision.id, 'catboost')
  completeBundle(set.id, {
    normalizedRequirements: ['catboost'], downloadBytes: 1, installedBytes: 315 * MiB, contentHash: '3'.repeat(64),
    packages: [{ name: 'catboost', version: '1.2.10', fileName: 'catboost-1.2.10-py3-none-any.whl', sha256: '4'.repeat(64), bytes: 1 }],
    lock: `catboost==1.2.10 --hash=sha256:${'4'.repeat(64)}\n`,
  })
  bindSubmission(sent.id, revision.id, set.id)
  updateCompetition(c.id, { limits: { ...c.limits, memoryMb: 512 } })
  const prepared = leaseAndPrepare(sent.id)
  const refusal = unfitOutcome(prepared)
  assert.equal(refusal?.status, 'dependency_error')
  assert.deepEqual(refusal?.dependencyFailure, { reason: 'memory', bytes: 379 * MiB, limitBytes: 512 * MiB })
  const settled = await settleNotebook(prepared, { outcome: refusal!, endedAt: Date.now(), crowded: false })
  assert.deepEqual(settled, { next: 'none' })
  const done = getSubmission(sent.id)!
  assert.equal(done.state, 'rejected')
  assert.equal(done.stage, 'dependencies')
  assert.match(done.participantError ?? '', /379/)
  reset()
})

/* ---------------------------------------------------------------- settling */

test("a machine's result settles like a run here, then waits in the metric lane in its own place, and scores", async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const before = queueRow(sent.id)!
  const prepared = leaseAndPrepare(sent.id)
  machineResults(prepared)
  const settled = await settleNotebook(prepared, { outcome: finished(prepared), endedAt: Date.now(), crowded: false })
  assert.equal(settled.next, 'score')
  assert.equal(settled.next === 'score' && settled.answer, path.join(resultDir(c.id, sent.id), SUBMISSION_FILE))
  assert.equal(read(path.join(resultDir(c.id, sent.id), SUBMISSION_FILE)), ANSWER, 'the answer is the submission\'s now')
  assert.ok(read(path.join(resultDir(c.id, sent.id), EXECUTED_FILE))?.includes('executed on the machine'))
  assert.equal(continueAsMetric(prepared, settled as Extract<typeof settled, { next: 'score' }>), true)
  const row = queueRow(sent.id)!
  assert.equal(row.kind, 'metric')
  assert.equal(row.state, 'waiting')
  assert.equal(row.holder, null, 'the metric is this server\'s')
  assert.equal(row.attemptId, null)
  assert.equal(row.attempts, 0)
  assert.deepEqual([row.turn, row.enqueuedAt, row.late], [before.turn, before.enqueuedAt, before.late], 'it keeps the place the upload took')
  const waiting = getSubmission(sent.id)!
  assert.equal(waiting.state, 'running', 'a fresh result, ahead of every rescore')
  assert.equal(waiting.stage, 'score')
  assert.equal(waiting.durationMs, 4200)
  assert.deepEqual([waiting.cellsDone, waiting.cellsTotal], [1, 1])
  // The metric lane takes it, and the metric adds its own time to the notebook's.
  await drainCompetitionQueue()
  const done = getSubmission(sent.id)!
  assert.equal(done.state, 'scored')
  assert.ok((done.durationMs ?? 0) >= 4200)
  assert.deepEqual(listRuns(sent.id).map((run) => [run.kind, run.verdict]), [['notebook', 'ok'], ['metric', 'ok']])
  assert.equal(queueRow(sent.id), null)
  reset()
})

test('an outcome applied twice moves nothing twice and judges nothing missing', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const prepared = leaseAndPrepare(sent.id)
  machineResults(prepared)
  const end = { outcome: finished(prepared), endedAt: Date.now(), crowded: false }
  const first = await settleNotebook(prepared, end)
  // The server crashed before the row was flipped: the outcome is applied again, from the start.
  const second = await settleNotebook(prepared, end)
  assert.deepEqual(second, first)
  assert.equal(read(path.join(resultDir(c.id, sent.id), EXECUTED_FILE))?.includes('executed on the machine'), true, 'the published notebook is still there')
  assert.equal(read(path.join(resultDir(c.id, sent.id), SUBMISSION_FILE)), ANSWER)
  assert.equal(getSubmission(sent.id)?.state, 'running', 'not rejected for an answer it had already promoted')
  assert.equal(getSubmission(sent.id)?.participantError, null)
  assert.equal(continueAsMetric(prepared, first as Extract<typeof first, { next: 'score' }>), true)
  // And the flip happens once: the attempt is not the row's any more.
  assert.equal(continueAsMetric(prepared, first as Extract<typeof first, { next: 'score' }>), false)
  assert.equal(queueRow(sent.id)?.kind, 'metric')
  reset()
})

test('publish and promote are once per attempt, however many times and wherever they are cut short', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const out = resultDir(c.id, sent.id)
  const attempt = (files: Record<string, string>): string => {
    const id = randomUUID().replaceAll('-', '')
    const dir = attemptDir(c.id, sent.id, id)
    for (const [name, body] of Object.entries(files)) competitionsFs.writeFileSync(path.join(dir, name), enc(body), { mode: 0o600 })
    return id
  }
  const first = attempt({ [EXECUTED_FILE]: 'A', 'run.json': '{"run":"A"}', [SUBMISSION_FILE]: 'answer A' })
  assert.deepEqual(publishAttemptArtifacts(c.id, sent.id, first), { executed: true, runJson: true })
  assert.deepEqual(publishAttemptArtifacts(c.id, sent.id, first), { executed: true, runJson: true }, 'the first answer, again')
  assert.equal(read(path.join(out, EXECUTED_FILE)), 'A', 'a second publish never removes what the first published')
  assert.equal(read(path.join(out, 'run.json')), '{"run":"A"}')
  assert.equal(promoteAttempt(c.id, sent.id, first), path.join(out, SUBMISSION_FILE))
  assert.equal(promoteAttempt(c.id, sent.id, first), path.join(out, SUBMISSION_FILE), 'a second promote does not throw')
  assert.equal(read(path.join(out, SUBMISSION_FILE)), 'answer A')

  // A crash between the decision and the move: the next call makes the move, and clears what the first had decided to.
  const second = attempt({ [EXECUTED_FILE]: 'B' })
  const rename = competitionsFs.renameSync
  let crash = true
  competitionsFs.renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    if (crash) { crash = false; throw new Error('the process died here') }
    return rename(from, to)
  }
  try {
    assert.throws(() => publishAttemptArtifacts(c.id, sent.id, second), /died here/)
    assert.equal(read(path.join(out, EXECUTED_FILE)), 'A', 'nothing moved yet')
    assert.deepEqual(publishAttemptArtifacts(c.id, sent.id, second), { executed: true, runJson: false })
  } finally {
    competitionsFs.renameSync = rename
  }
  assert.equal(read(path.join(out, EXECUTED_FILE)), 'B')
  assert.equal(read(path.join(out, 'run.json')), null, 'the run.json of the attempt before is not this one\'s')

  // An attempt with nothing to publish still clears the old notebook, once; with nothing to promote, promote refuses.
  const third = attempt({})
  assert.deepEqual(publishAttemptArtifacts(c.id, sent.id, third), { executed: false, runJson: false })
  assert.equal(read(path.join(out, EXECUTED_FILE)), null)
  assert.deepEqual(publishAttemptArtifacts(c.id, sent.id, third), { executed: false, runJson: false })
  assert.throws(() => promoteAttempt(c.id, sent.id, third))
  assert.equal(read(path.join(out, SUBMISSION_FILE)), 'answer A', 'the last good answer stays')
  reset()
})

test("work asked for during a machine's run replaces its metric, as it replaces the rest of a run here", async () => {
  reset()
  const c = competition()
  for (const pending of ['metric', 'notebook'] as const) {
    const sent = send(c)
    const prepared = leaseAndPrepare(sent.id)
    machineResults(prepared)
    // A rescore or a rerun asked while the machine runs it (store.ts · enqueue on a running row).
    enqueue({ submissionId: sent.id, competitionId: c.id, entrantId: sent.entrantId, kind: pending })
    assert.equal(queueRow(sent.id)?.pendingKind, pending)
    const settled = await settleNotebook(prepared, { outcome: finished(prepared), endedAt: Date.now(), crowded: false })
    assert.equal(continueAsMetric(prepared, settled as Extract<typeof settled, { next: 'score' }>), true)
    const row = queueRow(sent.id)!
    assert.equal(row.kind, pending)
    assert.equal(row.pendingKind, null)
    assert.equal(row.holder, null)
    const waiting = getSubmission(sent.id)!
    assert.equal(waiting.state, 'queued')
    assert.equal(waiting.stage, 'queue')
    assert.equal(waiting.durationMs, 4200, 'the notebook did run')
    leaveQueue(sent.id)
  }
  reset()
})

test("a machine's run crowded off its card goes back once on the machine's word, never waiting on this server's cards", async () => {
  reset()
  process.env.KERNEL_GPUS = '0'
  process.env.COMPETITION_GPUS = '0'
  try {
    const g = competition({ gpu: true })
    // A run of THIS server on its card 0 — the card a machine also calls 0.
    const local = send(g, ['x'], 1)
    assert.equal(takeNext({ at: 10, boot: BOOT, slots: 8, gpu: { cards: [{ id: '0', capacity: 2 }] }, lane: 'notebook' })?.gpu, '0')
    const oom = {
      status: 'cell_error' as const, cell: 0,
      detail: 'Traceback (most recent call last):\n  Cell In[1], line 1\nOutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB.',
      diagnostics: { exit: 1, oomKilled: false, backend: 'docker' as const },
    }
    const card = { device: '0', sliceMb: 12_282, perDevice: 2 }
    for (const crowded of [true, false]) {
      const sent = send(g, ['model.fit()'], 2)
      const prepared = leaseAndPrepare(sent.id)
      const started = performance.now()
      const settled = await settleNotebook(prepared, { outcome: finished(prepared, oom), endedAt: Date.now(), gpu: card, crowded })
      assert.ok(performance.now() - started < 5_000, 'settled without waiting on the neighbours of this server\'s card 0')
      assert.deepEqual(settled, { next: 'none' })
      const after = getSubmission(sent.id)!
      if (crowded) {
        const row = queueRow(sent.id)!
        assert.equal(row.state, 'waiting')
        assert.equal(row.holder, null)
        assert.equal(row.resourceRetries, 1, 'once, counting toward nothing')
        assert.equal(after.state, 'queued')
        assert.equal(after.participantError, tr('competitions.answer.gpuNeighbourRetry'))
      } else {
        assert.equal(after.state, 'notebookFailed', 'not crowded: judged like any out-of-memory of its own')
        assert.match(after.participantError ?? '', /OutOfMemoryError/)
      }
      leaveQueue(sent.id)
    }
    leaveQueue(local.id)
  } finally {
    delete process.env.KERNEL_GPUS
    delete process.env.COMPETITION_GPUS
    reset()
  }
})

/* ------------------------------------------------- letting the container read */

test('letting the container read sets a mode only where it differs, so no ctime moves on what it could read already', async () => {
  const root = path.join(competitionsDir, `chmod-${randomUUID().slice(0, 8)}`)
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  fs.mkdirSync(path.join(root, 'ready'), { recursive: true })
  const write = (rel: string, mode: number) => {
    fs.writeFileSync(path.join(root, rel), 'data')
    fs.chmodSync(path.join(root, rel), mode)
  }
  write('closed.csv', 0o600)
  write('open.csv', 0o644)
  write('sub/deep.csv', 0o644)
  write('ready/file.csv', 0o644)
  fs.chmodSync(path.join(root, 'sub'), 0o700)
  fs.chmodSync(path.join(root, 'ready'), 0o755)
  fs.chmodSync(root, 0o700)
  const ctime = (rel: string) => fs.statSync(path.join(root, rel), { bigint: true }).ctimeNs
  const mode = (rel: string) => fs.statSync(path.join(root, rel)).mode & 0o7777
  const before = { open: ctime('open.csv'), deep: ctime('sub/deep.csv'), ready: ctime('ready'), file: ctime('ready/file.csv'), closed: ctime('closed.csv') }
  // Long enough for a chmod to show in any file system's ctime.
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  letContainerRead(root)
  assert.deepEqual([mode('.'), mode('closed.csv'), mode('open.csv'), mode('sub'), mode('sub/deep.csv'), mode('ready'), mode('ready/file.csv')],
    [0o755, 0o644, 0o644, 0o755, 0o644, 0o755, 0o644])
  assert.equal(ctime('open.csv'), before.open, 'a file the container could read already is not touched')
  assert.equal(ctime('sub/deep.csv'), before.deep)
  assert.equal(ctime('ready'), before.ready)
  assert.equal(ctime('ready/file.csv'), before.file)
  assert.notEqual(ctime('closed.csv'), before.closed, 'the one it could not read is opened')
  fs.rmSync(root, { recursive: true, force: true })
})
