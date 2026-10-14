/**
 * A pause holds new work, not work under way (runner.ts ·
 * pauseCompetitionQueue, store.ts · selectNextScore): the metric of a
 * notebook that has already run — a machine's result, or one of ours whose
 * metric was put off — is scored under a pause, as a run here keeps its
 * metric under its own lease whatever the pause.
 *
 * It failed quietly. The machine finished, uploaded and was applied; its row
 * became this server's metric work, and the pause held it: the submission
 * read «оценивается» with no score for the whole pause — a class period —
 * its participant's next upload was refused as in flight, and the private
 * board's release waited on it, while a classmate whose notebook happened to
 * run here was scored and could send again. Which of the two a person was is
 * the scheduler's placement, invisible to them.
 *
 * No Docker: the stand-in runner here, a stand-in machine over HTTP.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { drainCompetitionQueue, pauseCompetitionQueue, pumpOnce, settleCompetitionWork } from '../server/src/competitions/runner.js'
import {
  acceptSubmission,
  continueQueueAsMetric,
  createEntrant,
  enqueue,
  getSubmission,
  holdQueueRow,
  intakePlan,
  leaveQueue,
  pendingResultsCount,
  queueRow,
  setQueuePaused,
  takeNext,
  updateSubmission,
  waitingCount,
  type QueueRow,
} from '../server/src/competitions/store.js'
import { competitionsFs, putSubmissionNotebook, resultDir, SUBMISSION_FILE } from '../server/src/competitions/storage.js'
import { ANSWER, Machine, close, code, competition, enc, finished, reset, send, serve, type TestCompetition } from './_remote.mts'

const runner = new FakeCompetitionRunner()
useCompetitionRunner(runner)
after(() => {
  setQueuePaused(false)
  close()
})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A submission scored once whose answer is stored: what a rescore scores. */
function answered(c: TestCompetition) {
  const entrant = createEntrant(`Пауза ${randomUUID().slice(0, 6)}`).entrant
  const submission = acceptSubmission({ competitionId: c.id, entrantId: entrant.id, fileName: 'solution.ipynb', bytes: 100 })
  putSubmissionNotebook(c.id, submission.id, enc('{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}'))
  leaveQueue(submission.id)
  competitionsFs.writeFileSync(path.join(resultDir(c.id, submission.id), SUBMISSION_FILE), enc(ANSWER), { mode: 0o600 })
  return updateSubmission(submission.id, { state: 'scored', publicScore: 1, privateScore: 1 })!
}

/** A notebook a machine ran, applied: its answer promoted here, its row this server's fresh metric work (continueQueueAsMetric). */
function freshResult(c: TestCompetition): QueueRow {
  const sent = send(c)
  const held = holdQueueRow(sent.id, 'machine-pause')!
  updateSubmission(sent.id, { state: 'running', stage: 'notebook' })
  competitionsFs.writeFileSync(path.join(resultDir(c.id, sent.id), SUBMISSION_FILE), enc(ANSWER), { mode: 0o600 })
  assert.equal(continueQueueAsMetric(held, { durationMs: 4200, cellsDone: 1, cellsTotal: 1 }), 'metric')
  const row = queueRow(sent.id)!
  assert.deepEqual([row.kind, row.state, row.fresh], ['metric', 'waiting', true])
  return row
}

test('under a pause the metric of a notebook that has run is scored; a rescore and a notebook wait for the pause to end', async () => {
  reset({ homeNotebooks: true })
  const c = competition()
  const fresh = freshResult(c)
  const old = answered(c)
  enqueue({ submissionId: old.id, competitionId: c.id, entrantId: old.entrantId, kind: 'metric' })
  const notebook = send(c)
  pauseCompetitionQueue(true, 'teacher')
  try {
    assert.equal(waitingCount(undefined, true), 1, 'only the fresh result is work the pause does not hold')
    assert.equal(takeNext({ slots: 8, lane: 'notebook' }), null, 'no notebook is taken under a pause')
    assert.equal(await pumpOnce(), 1)
    await drainCompetitionQueue()
    await settleCompetitionWork()
    assert.equal(getSubmission(fresh.submissionId)?.state, 'scored')
    assert.equal(queueRow(fresh.submissionId), null)
    assert.notEqual(intakePlan(c.id, fresh.entrantId), 'in_flight', 'its participant may send again')
    assert.deepEqual([queueRow(old.id)?.state, queueRow(old.id)?.kind], ['waiting', 'metric'], 'the rescore is new work')
    assert.equal(queueRow(notebook.id)?.state, 'waiting')
    assert.equal(await pumpOnce(), 0)
  } finally {
    pauseCompetitionQueue(false, 'teacher')
  }
  await drainCompetitionQueue()
  await settleCompetitionWork()
  assert.deepEqual([getSubmission(old.id)?.state, getSubmission(notebook.id)?.state], ['scored', 'scored'])
  reset()
})

test('a run here and a run on a machine, both under way when the queue is paused, both end scored', async () => {
  // Here: the notebook keeps its metric under its own lease.
  reset({ homeNotebooks: true })
  const here = competition()
  const local = send(here, { cells: ['# colloq-test: {"hold": 300}', 'x = 1'] })
  try {
    assert.equal(await pumpOnce(), 1)
    await sleep(50)
    assert.equal(queueRow(local.id)?.state, 'running')
    pauseCompetitionQueue(true, 'teacher')
    await settleCompetitionWork()
    assert.equal(getSubmission(local.id)?.state, 'scored')
  } finally {
    setQueuePaused(false)
    await settleCompetitionWork()
  }
  // On a machine: the outcome is applied under the pause, and its metric runs here at once.
  reset()
  const c = competition()
  const sent = send(c, { cells: ['x = 1'] })
  const m = new Machine(await serve())
  assert.equal((await m.join(code())).status, 200)
  const first = await m.sync()
  const data = first.body.want.data.find((entry) => entry.competitionId === c.id && !entry.sealed)!
  const ready = { revisions: [c.revisionId], data: [data.manifest], sealed: [], bundles: [] }
  const lease = (await m.sync({ ready })).body.leases[0]
  assert.equal(lease.submissionId, sent.id)
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 100 }] })
  try {
    pauseCompetitionQueue(true, 'teacher')
    assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
    const out = await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]))
    assert.equal((out.body as { result: string }).result, 'applied')
    await drainCompetitionQueue()
    await settleCompetitionWork()
    const done = getSubmission(sent.id)!
    assert.equal(done.state, 'scored', `${done.state} at ${done.stage}`)
    assert.equal(queueRow(sent.id), null)
    assert.notEqual(intakePlan(c.id, sent.entrantId), 'in_flight')
    assert.equal(pendingResultsCount(c.id, Number.MAX_SAFE_INTEGER), 0)
  } finally {
    setQueuePaused(false)
    await settleCompetitionWork()
  }
  reset()
})
