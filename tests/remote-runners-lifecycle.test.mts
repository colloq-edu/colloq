/**
 * A submission's life on a machine, end to end through the real app
 * (docs/architecture/remote-runners.md §2, §3.4–§3.6): join, the sync that
 * leases it, the ack, the uploads, the outcome, the flip to this server's
 * metric lane and the score — with the stand-in agent of tests/_remote.mts
 * and the stand-in runner for the metric.
 *
 * What is checked is what fails quietly in a class: a result applied twice,
 * a second run row for one run, a row that goes to the end of the queue
 * after its machine ran it, an outcome repeated after a lost reply refused,
 * a different one accepted, a crash between the moves and the commit that
 * leaves a submission stuck, a run.json of another attempt taken as this
 * one's, a machine's text kept as a raw marker.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { REMOTE_TEXT_OPEN, remoteTextMarker, type RemoteLease } from '../shared/remote-runner.js'
import { tr } from '../shared/i18n.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { drainCompetitionQueue } from '../server/src/competitions/runner.js'
import { getSubmission, listRuns, queueRow } from '../server/src/competitions/store.js'
import { attemptPath, competitionsFs, resultDir, EXECUTED_FILE, SUBMISSION_FILE } from '../server/src/competitions/storage.js'
import { getLease, updateLease } from '../server/src/competitions/remote/store.js'
import { db } from '../server/src/db.js'
import { applyOutcome, redriveApplying } from '../server/src/competitions/remote/apply.js'
import { stagedPath } from '../server/src/competitions/remote/upload.js'
import { ANSWER, Machine, close, code, competition, finished, reset, send, serve, type TestCompetition } from './_remote.mts'

const runner = new FakeCompetitionRunner()
useCompetitionRunner(runner)

after(() => close())

const read = (file: string): string | null => {
  try { return (competitionsFs.readFileSync(file) as Buffer).toString('utf8') } catch { return null }
}

/** A machine joined, with the competition's image and data reported ready; the lease it is given. */
async function leased(c: TestCompetition, machine?: Machine): Promise<{ m: Machine; lease: RemoteLease; ready: { revisions: string[]; data: string[]; sealed: string[]; bundles: string[] } }> {
  const home = await serve()
  const m = machine ?? new Machine(home)
  if (!m.runnerId) assert.equal((await m.join(code())).status, 200)
  const first = await m.sync()
  assert.equal(first.status, 200)
  const data = first.body.want.data.find((entry) => entry.competitionId === c.id && !entry.sealed)
  assert.ok(data, 'the competition\'s open data is wanted')
  assert.ok(first.body.want.revisions.some((revision) => revision.id === c.revisionId), 'and its image')
  const ready = { revisions: [c.revisionId], data: [data.manifest], sealed: [], bundles: [] }
  const r = await m.sync({ ready })
  assert.equal(r.status, 200)
  assert.equal(r.body.leases.length >= 1, true, 'ready, it is given work')
  return { m, lease: r.body.leases[0], ready }
}

test('a machine runs the notebook, this server scores it, in its own place and with one run row per step', async () => {
  reset()
  const c = competition()
  const sent = send(c, { cells: ['x = 1', 'y = 2'] })
  const before = queueRow(sent.id)!
  const { m, lease, ready } = await leased(c)
  assert.equal(lease.submissionId, sent.id)
  assert.equal(lease.competitionId, c.id)
  assert.equal(lease.gpu, false)
  assert.equal(lease.sealed, false)
  assert.ok(lease.notebook.inline, 'a small notebook rides inside its lease')
  assert.ok(Buffer.from(lease.notebook.inline!, 'base64').toString('utf8').includes('y = 2'))
  const held = queueRow(sent.id)!
  assert.equal(held.state, 'running')
  assert.equal(held.holder, m.runnerId)
  assert.equal(held.gpu, null, 'a machine\'s cards never enter competition_queue.gpu')
  assert.equal(listRuns(sent.id).length, 1, 'the take started the run row')
  assert.equal(getLease(lease.attemptId)?.state, 'offered')

  // The ack, and the container's start on this server's clock (the lease a minute old: a machine never ran longer than it held one).
  db.prepare('UPDATE remote_leases SET offered_at = offered_at - 60000 WHERE attempt_id = ?').run(lease.attemptId)
  const t0 = Date.now()
  let r = await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 3000, progress: { phase: 'notebook', cell: 0, cells: 2 } }] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.leases, [], 'an acked offer is not repeated')
  assert.equal(getLease(lease.attemptId)?.state, 'running')
  const started = queueRow(sent.id)!.startedAt!
  assert.ok(started <= t0 - 2500 && started >= t0 - 4000, 'started_at is now less what the machine has run')
  assert.equal(getSubmission(sent.id)?.cellsDone, 1, 'progress reaches the participant')

  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  assert.equal((await m.put(lease.attemptId, 'executed.ipynb', '{"cells":[],"note":"executed on the machine"}')).status, 200)
  const request = finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }, { name: 'executed.ipynb', body: '{"cells":[],"note":"executed on the machine"}' }], { cell: 1, cells: 2 })
  const out = await m.outcome(lease.attemptId, request)
  assert.equal(out.status, 200)
  assert.equal((out.body as { result: string }).result, 'applied')

  const row = queueRow(sent.id)!
  assert.equal(row.kind, 'metric', 'its metric is this server\'s now')
  assert.equal(row.holder, null)
  assert.equal(row.state, 'waiting')
  assert.deepEqual([row.turn, row.enqueuedAt, row.late], [before.turn, before.enqueuedAt, before.late], 'it keeps the place its upload took')
  assert.equal(read(path.join(resultDir(c.id, sent.id), SUBMISSION_FILE)), ANSWER)
  assert.ok(read(path.join(resultDir(c.id, sent.id), EXECUTED_FILE))?.includes('executed on the machine'))
  assert.ok(read(path.join(resultDir(c.id, sent.id), 'run.json'))?.includes(lease.attemptId), 'its own run.json is kept')
  assert.equal(getLease(lease.attemptId)?.state, 'applied')
  assert.equal(competitionsFs.existsSync(stagedPath(lease.attemptId, 'submission.csv', request.files[0].sha256)), false, 'staging is gone')

  // The same outcome again (its reply was lost): the same answer, nothing applied twice.
  const again = await m.outcome(lease.attemptId, request)
  assert.equal((again.body as { result: string }).result, 'applied')
  // A different one for the same attempt: refused.
  const other = await m.outcome(lease.attemptId, { ...request, outcome: { ...request.outcome, wall: 9999 } })
  assert.equal(other.status, 409)
  assert.equal((other.body as { error: string }).error, 'conflict')

  // The machine's next sync is told to delete the attempt's tree.
  r = await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'uploading', runningMs: 4200 }] })
  assert.deepEqual(r.body.applied, [lease.attemptId])

  await drainCompetitionQueue()
  const done = getSubmission(sent.id)!
  assert.equal(done.state, 'scored')
  assert.ok((done.durationMs ?? 0) >= 4200, 'notebook and metric time together')
  assert.deepEqual(listRuns(sent.id).map((run) => [run.kind, run.verdict]), [['notebook', 'ok'], ['metric', 'ok']])
  assert.equal(queueRow(sent.id), null)
})

test('a repeat of an outcome whose apply is in flight gets that apply\'s answer: never «applied» for one that failed', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const { m, lease, ready } = await leased(c)
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 1000 }] })
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  const request = finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }])
  // The move into the result folder fails (a folder where the answer goes): the apply in flight throws.
  const blocker = path.join(attemptPath(c.id, sent.id, lease.attemptId, 'result'), SUBMISSION_FILE, 'in-the-way')
  competitionsFs.mkdirSync(blocker, { recursive: true })
  // The machine's retry after its first post timed out: both in flight at once, and neither may say «applied».
  const answers = await Promise.allSettled([
    applyOutcome(m.runnerId, lease.attemptId, request),
    applyOutcome(m.runnerId, lease.attemptId, request),
  ])
  assert.deepEqual(answers.map((answer) => answer.status), ['rejected', 'rejected'], 'the repeat shares the failed apply\'s answer')
  assert.equal(getLease(lease.attemptId)?.state, 'applying', 'kept for the next post (or the boot) to drive again')
  // The machine kept its result and posts again: applied, once.
  competitionsFs.rmSync(path.join(attemptPath(c.id, sent.id, lease.attemptId, 'result'), SUBMISSION_FILE), { recursive: true, force: true })
  const again = await m.outcome(lease.attemptId, request)
  assert.equal((again.body as { result: string }).result, 'applied')
  assert.deepEqual(listRuns(sent.id).map((run) => [run.kind, run.verdict]), [['notebook', 'ok']], 'one run row, settled once')
  assert.equal(queueRow(sent.id)?.kind, 'metric')
})

test('a failed notebook settles here with the machine\'s words in this server\'s language, and gets no metric row', async () => {
  reset()
  const c = competition()
  const sent = send(c, { cells: ['a', 'b', 'c'] })
  const { m, lease, ready } = await leased(c)
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 100 }] })
  // The machine's core wrote one of our sentences as a marker: home renders it in its own words.
  const marker = remoteTextMarker('competitions.answer.restartAbandoned', { attempts: 2 })
  const request = finished(lease.attemptId, [{ name: 'executed.ipynb', body: '{"cells":[]}' }], {
    status: 'cell_error', cell: 1, cells: 3, produced: false,
    detail: 'Traceback (most recent call last):\nValueError: bad value',
    log: `container log\n${marker}`,
    diagnostics: { exit: 1, oomKilled: false, backend: 'docker' },
  })
  assert.equal((await m.put(lease.attemptId, 'executed.ipynb', '{"cells":[]}')).status, 200)
  const out = await m.outcome(lease.attemptId, request)
  assert.equal((out.body as { result: string }).result, 'applied')
  const failed = getSubmission(sent.id)!
  assert.equal(failed.state, 'notebookFailed')
  assert.match(failed.participantError ?? '', /ValueError: bad value/)
  assert.ok(!(failed.teacherError ?? '').includes(REMOTE_TEXT_OPEN), 'no raw marker reaches a reader')
  assert.ok((failed.teacherError ?? '').includes(tr('competitions.answer.restartAbandoned', { attempts: 2 })))
  assert.equal(queueRow(sent.id), null, 'nothing waits for a metric')
  assert.deepEqual(listRuns(sent.id).map((run) => run.kind), ['notebook'])
})

test('a run.json that names another attempt is not kept', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const { m, lease } = await leased(c)
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  const request = finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }])
  request.runJson = Buffer.from(JSON.stringify({ attemptId: 'f'.repeat(32), status: 'ok' })).toString('base64')
  assert.equal(((await m.outcome(lease.attemptId, request)).body as { result: string }).result, 'applied')
  assert.equal(read(path.join(resultDir(c.id, sent.id), 'run.json')), null)
})

test('an outcome whose files were never uploaded is refused, and the run counts as lost, not as the participant\'s failure', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const { m, lease, ready } = await leased(c)
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 100 }] })
  const out = await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]))
  assert.equal((out.body as { result: string }).result, 'refused')
  assert.deepEqual((out.body as { leases: unknown[] }).leases, [], 'not offered straight back to the machine that could not deliver it')
  assert.equal(getLease(lease.attemptId)?.state, 'lost')
  const row = queueRow(sent.id)!
  assert.equal(row.state, 'waiting')
  assert.equal(row.lost, 1)
  assert.equal(getSubmission(sent.id)?.state, 'queued')
  assert.equal(getSubmission(sent.id)?.participantError, tr('server.runners.returned'))
})

test('an outcome left applying by a crash is driven again at boot, once, and the second pass settles nothing twice', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const { m, lease, ready } = await leased(c)
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 100 }] })
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  const request = finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }])
  // The post that crashed between writing `applying` and the moves: written by hand, as the process left it.
  const { remoteOutcomeDigest } = await import('../shared/remote-runner.js')
  const { sha256 } = await import('../server/src/competitions/remote/store.js')
  updateLease(lease.attemptId, {
    state: 'applying', endedAt: Date.now(), outcomeSha256: remoteOutcomeDigest(request, sha256),
    outcome: { kind: 'finished', outcome: request.outcome, runJson: request.runJson, files: request.files },
  })
  assert.equal(await redriveApplying(), 1)
  assert.equal(getLease(lease.attemptId)?.state, 'applied')
  assert.equal(queueRow(sent.id)?.kind, 'metric')
  assert.equal(listRuns(sent.id).filter((run) => run.kind === 'notebook').length, 1)
  // Again: nothing left to drive.
  assert.equal(await redriveApplying(), 0)
  // And the machine's repeated post gets the reply of the first.
  assert.equal(((await m.outcome(lease.attemptId, request)).body as { result: string }).result, 'applied')
  await drainCompetitionQueue()
  assert.equal(getSubmission(sent.id)?.state, 'scored')
})

test('work asked for during the machine\'s run replaces its metric: a rerun waits as a notebook', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const { m, lease } = await leased(c)
  const { enqueue } = await import('../server/src/competitions/store.js')
  enqueue({ submissionId: sent.id, competitionId: c.id, entrantId: sent.entrantId, kind: 'notebook' })
  assert.equal(queueRow(sent.id)?.pendingKind, 'notebook')
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  // A machine with no room left: the reply takes nothing, so the row is seen as the outcome left it.
  const full = { ...finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]), free: { slots: 0, memoryMb: 0, cpus: 0, gpuShares: 0, diskMb: 0 } }
  assert.equal(((await m.outcome(lease.attemptId, full)).body as { result: string }).result, 'applied')
  const row = queueRow(sent.id)!
  assert.equal(row.kind, 'notebook')
  assert.equal(row.state, 'waiting')
  assert.equal(row.pendingKind, null)
  assert.equal(getSubmission(sent.id)?.state, 'queued')
})

/* --------------------------------------------- erase, delete, the participant */

import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { ENTRANT_COOKIE } from '../shared/competitions.js'
import type { EntrantSubmissions } from '../shared/competitions-entrant.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { entrantKeyOf, getCompetition } from '../server/src/competitions/store.js'
import { submissionDir } from '../server/src/competitions/storage.js'
import { forgetStock } from '../server/src/competitions/remote/want.js'

function ownerCookie(): string {
  const made = createTeacher({ name: 'Владелица', email: `owner.lifecycle.${Date.now()}.${Math.random()}@example.edu`, role: 'owner' })!
  rotateLinkKey(made.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, made)
  return `${STAFF_COOKIE}=${value}`
}

test('a participant erased while a machine runs their notebook is erased at once, and the machine\'s late upload recreates nothing', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const { m, lease, ready } = await leased(c)
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  const home = await serve()
  const erased = await fetch(`${home}/api/admin/competitions/${c.id}/entrants/${sent.entrantId}`, { method: 'DELETE', headers: { cookie: ownerCookie() } })
  assert.equal(erased.status, 200, await erased.clone().text())
  assert.equal(getSubmission(sent.id), null)
  assert.equal(getLease(lease.attemptId)?.state, 'revoked')
  const told = await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 50 }] })
  assert.deepEqual(told.body.revoke, [{ id: lease.attemptId, reason: 'cancelled' }])
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 409)
  assert.equal(competitionsFs.existsSync(submissionDir(c.id, sent.id)), false)
})

test('a competition deleted while a machine runs one of its notebooks is deleted at once, with nothing left running', async () => {
  reset()
  const c = competition()
  send(c)
  const { m, lease, ready } = await leased(c)
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  const home = await serve()
  const deleted = await fetch(`${home}/api/admin/competitions/${c.id}`, { method: 'DELETE', headers: { cookie: ownerCookie(), origin: home } })
  assert.equal(deleted.status, 204, await deleted.clone().text())
  assert.equal(getCompetition(c.id), null)
  assert.equal(getLease(lease.attemptId)?.state, 'revoked')
  // The picture of what machines hold is at most two seconds old (want.ts · homeStock): past that, the deletion is in it.
  forgetStock()
  const told = await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 50 }] })
  assert.deepEqual(told.body.revoke, [{ id: lease.attemptId, reason: 'cancelled' }])
  assert.ok(told.body.forget.includes(c.id), 'and its data is to be forgotten')
})

test('the participant reads «готовится» for a notebook no executor can take yet, and nothing about which machine', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const home = await serve()
  const signIn = await fetch(`${home}/api/k/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: entrantKeyOf(sent.entrantId) }) })
  const cookie = signIn.headers.getSetCookie().find((line) => line.startsWith(`${ENTRANT_COOKIE}=`))!.split(';')[0]
  const mine = async () => (await (await fetch(`${home}/api/k/competitions/${c.slug}/submissions`, { headers: { cookie } })).json()) as EntrantSubmissions
  let live = (await mine()).live.find((one) => one.submissionId === sent.id)!
  assert.equal(live.preparing, true, 'no machine and this server\'s notebooks off')
  assert.equal(live.place, null)
  // A machine with everything in place: a place, and no «готовится».
  const m = new Machine(home)
  assert.equal((await m.join(code())).status, 200)
  const first = await m.sync({ free: { slots: 0, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 } })
  const data = first.body.want.data.find((entry) => entry.competitionId === c.id)!
  await m.sync({ ready: { revisions: [c.revisionId], data: [data.manifest], sealed: [], bundles: [] }, free: { slots: 0, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 } })
  live = (await mine()).live.find((one) => one.submissionId === sent.id)!
  assert.equal(live.preparing, undefined)
})
