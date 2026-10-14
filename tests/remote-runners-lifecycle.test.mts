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
  // The lease went with them, in the same transaction: nothing of their run waits for the week's prune.
  assert.equal(getLease(lease.attemptId), null)
  const told = await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 50 }] })
  assert.deepEqual(told.body.revoke, [{ id: lease.attemptId, reason: 'unknown' }], 'home knows no such lease: the agent drops it')
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 404)
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
  assert.equal(getLease(lease.attemptId), null, 'its runs\' leases went with it')
  // The picture of what machines hold is at most two seconds old (want.ts · homeStock): past that, the deletion is in it.
  forgetStock()
  const told = await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 50 }] })
  assert.deepEqual(told.body.revoke, [{ id: lease.attemptId, reason: 'unknown' }])
  assert.ok(told.body.forget.includes(c.id), 'and its data is to be forgotten')
})

test('erasing a participant, and deleting a competition, take their runs on machines along: the outputs a lease kept and its log lines', async () => {
  reset()
  const leaseRows = (column: 'submission_id' | 'competition_id', id: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM remote_leases WHERE ${column} = ?`).get(id) as { n: number }).n
  const eventRows = (attemptId: string) => (db.prepare('SELECT COUNT(*) AS n FROM remote_events WHERE attempt_id = ?').get(attemptId) as { n: number }).n
  const outputs = () => (db.prepare("SELECT COUNT(*) AS n FROM remote_leases WHERE outcome LIKE '%TRACEBACK-OF-A-PERSON%'").get() as { n: number }).n
  /** A run of `sent` that failed on the machine and was settled: its lease keeps the traceback and the log. */
  async function failedOnMachine(c: TestCompetition, sent: { id: string }) {
    const { m, lease, ready } = await leased(c)
    assert.equal(lease.submissionId, sent.id)
    await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 100 }] })
    assert.equal((await m.put(lease.attemptId, 'executed.ipynb', '{"cells":[]}')).status, 200)
    const request = finished(lease.attemptId, [{ name: 'executed.ipynb', body: '{"cells":[]}' }], {
      status: 'cell_error', cell: 0, cells: 1, produced: false, detail: 'TRACEBACK-OF-A-PERSON: their own words', log: 'TRACEBACK-OF-A-PERSON printed',
      diagnostics: { exit: 1, oomKilled: false, backend: 'docker' },
    })
    assert.equal(((await m.outcome(lease.attemptId, request)).body as { result: string }).result, 'applied')
    return lease
  }
  // A participant with a run settled on a machine: erased.
  const c = competition()
  const person = send(c)
  const ran = await failedOnMachine(c, person)
  assert.equal(outputs(), 1, 'the lease kept the traceback')
  assert.ok(eventRows(ran.attemptId) > 0)
  const home = await serve()
  const erased = await fetch(`${home}/api/admin/competitions/${c.id}/entrants/${person.entrantId}`, { method: 'DELETE', headers: { cookie: ownerCookie() } })
  assert.equal(erased.status, 200, await erased.clone().text())
  assert.equal(leaseRows('submission_id', person.id), 0)
  assert.equal(eventRows(ran.attemptId), 0, 'and the machine\'s lines about it')
  assert.equal(outputs(), 0)
  // A competition with a run settled on a machine: deleted.
  const other = competition()
  const someone = send(other)
  const there = await failedOnMachine(other, someone)
  assert.equal(outputs(), 1)
  const deleted = await fetch(`${home}/api/admin/competitions/${other.id}`, { method: 'DELETE', headers: { cookie: ownerCookie(), origin: home } })
  assert.equal(deleted.status, 204, await deleted.clone().text())
  assert.equal(leaseRows('competition_id', other.id), 0)
  assert.equal(eventRows(there.attemptId), 0)
  assert.equal(outputs(), 0)
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

/* ------------------------------------------------ a cancel while applying */

import { cancelRemote } from '../server/src/competitions/remote/release.js'
import { remoteTick } from '../server/src/competitions/remote/liveness.js'
import { getRunner, driveInFlight } from '../server/src/competitions/remote/store.js'

/** A run on a machine with its answer uploaded, and the outcome that reports it. */
async function uploaded(c: TestCompetition) {
  const { m, lease, ready } = await leased(c)
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 100 }] })
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  return { m, lease, ready, request: finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]) }
}

/** The first move into the result folder fails (a folder where the answer goes): the drive throws and leaves the lease `applying`. */
function blockAnswer(c: TestCompetition, submissionId: string, attemptId: string): () => void {
  const blocker = path.join(attemptPath(c.id, submissionId, attemptId, 'result'), SUBMISSION_FILE, 'in-the-way')
  competitionsFs.mkdirSync(blocker, { recursive: true })
  return () => competitionsFs.rmSync(path.join(attemptPath(c.id, submissionId, attemptId, 'result'), SUBMISSION_FILE), { recursive: true, force: true })
}

test('a cancel that comes while the result is being applied is too late: the drive settles it, once, and the machine is told the truth', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const { m, lease, request } = await uploaded(c)
  // The cancel lands in the middle of the drive: while its staged answer is being moved into place.
  const rename = competitionsFs.renameSync
  let cancelled: boolean | null = null
  competitionsFs.renameSync = ((from: string, to: string) => {
    if (cancelled === null) {
      assert.equal(driveInFlight(lease.attemptId), true)
      cancelled = cancelRemote(queueRow(sent.id)!, 'teacher')
    }
    return rename.call(competitionsFs, from, to)
  }) as typeof competitionsFs.renameSync
  let result: string
  try {
    result = ((await m.outcome(lease.attemptId, request)).body as { result: string }).result
  } finally {
    competitionsFs.renameSync = rename
  }
  assert.equal(cancelled, false, 'its result had come: the cancel is too late, as for a run that has just ended here')
  assert.equal(result, 'applied')
  assert.equal(getLease(lease.attemptId)?.state, 'applied')
  assert.notEqual(getSubmission(sent.id)?.state, 'cancelled')
  assert.equal(queueRow(sent.id)?.kind, 'metric', 'its metric is this server\'s next')
  assert.deepEqual(listRuns(sent.id).map((run) => [run.kind, run.verdict]), [['notebook', 'ok']], 'one verdict, the run\'s own')
})

test('a cancel of a result left applying by a failed drive cancels it for good: nothing settles it afterwards', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const { m, lease, request } = await uploaded(c)
  const unblock = blockAnswer(c, sent.id, lease.attemptId)
  await assert.rejects(applyOutcome(m.runnerId, lease.attemptId, request))
  assert.equal(getLease(lease.attemptId)?.state, 'applying')
  assert.equal(driveInFlight(lease.attemptId), false)
  unblock()
  assert.equal(cancelRemote(queueRow(sent.id)!, 'teacher'), true, 'no drive is under way: the cancel takes it')
  assert.equal(getLease(lease.attemptId)?.state, 'revoked')
  assert.equal(getSubmission(sent.id)?.state, 'cancelled')
  // The machine posts its result again: refused as revoked, and the cancel's words stay the run's.
  assert.equal(((await m.outcome(lease.attemptId, request)).body as { result: string }).result, 'revoked')
  const run = listRuns(sent.id).find((one) => one.id === getLease(lease.attemptId)!.runId)!
  assert.equal(run.verdict, 'exit')
  assert.equal(run.teacherError, tr('competitions.answer.killedByTeacher'))
  assert.equal(getSubmission(sent.id)?.state, 'cancelled')
  assert.equal(queueRow(sent.id), null)
})

test('a result this server cannot apply by its lease\'s ceiling goes back to the queue, and is no loss of the machine\'s', async () => {
  reset()
  const c = competition({ wallSeconds: 60 })
  const sent = send(c)
  const m = new Machine(await serve())
  assert.equal((await m.join(code())).status, 200)
  const want = (await m.sync()).body.want
  const ready = { revisions: [c.revisionId], data: [want.data.find((entry) => entry.competitionId === c.id)!.manifest], sealed: [], bundles: [] }
  const one = { slots: 1, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 }
  // Three times over, on one machine: leased, run, uploaded, and the result cannot be applied here (the drive throws every time).
  for (let round = 0; round < 3; round++) {
    const lease = (await m.sync({ ready, free: one })).body.leases[0]
    assert.equal(lease?.submissionId, sent.id, `round ${round}: leased`)
    await m.sync({ seq: lease.seq, ready, free: { ...one, slots: 0 }, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 100 }] })
    assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
    const unblock = blockAnswer(c, sent.id, lease.attemptId)
    await assert.rejects(applyOutcome(m.runnerId, lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }])))
    unblock()
    assert.equal(getLease(lease.attemptId)?.state, 'applying')
    // Before its ceiling it waits for the machine's next post; past it, nothing holds the row any more.
    const deadline = getLease(lease.attemptId)!.deadlineAt
    assert.equal(remoteTick(deadline - 1000).lost, 0)
    assert.equal(remoteTick(deadline + 1000).lost, 1)
    const ended = getLease(lease.attemptId)!
    assert.equal(ended.state, 'lost')
    assert.equal(ended.cause, 'unapplied')
    const row = queueRow(sent.id)!
    assert.equal(row.state, 'waiting', 'back in the queue, in its place')
    assert.equal(row.lost, round + 1, 'a loss counted on the row: its limits bound how often a result nobody can apply runs again')
    assert.equal(getSubmission(sent.id)?.participantError, tr('server.runners.returned'))
    assert.equal(getRunner(m.runnerId)?.state, 'active', 'the machine delivered its result: no quarantine for this server\'s failure')
    // The machine's repeated post of the old result is over for good.
    assert.equal(((await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]))).body as { result: string }).result, 'revoked')
  }
})

/* ------------------------------------------ what the outcome is settled against */

import { notebookNote } from '../server/src/competitions/runner.js'
import { updateCompetition } from '../server/src/competitions/store.js'

test('a machine\'s outcome is worded by the competition its take read, as a run here is by its job\'s: a teacher\'s edit mid-run changes no numbers in it', async () => {
  reset()
  const c = competition({ wallSeconds: 600 })
  const sent = send(c)
  const { m, lease, ready } = await leased(c)
  const atTake = getCompetition(c.id)!
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 100 }] })
  // During the run the teacher gives the competition half an hour instead of ten minutes.
  updateCompetition(c.id, { limits: { ...atTake.limits, wallSeconds: 1800 } })
  const edited = getCompetition(c.id)!
  assert.equal(edited.limits.wallSeconds, 1800)
  const timedOut = { status: 'timeout' as const, cell: 0, cells: 1, wall: 600_000, produced: false, detail: '', log: '', diagnostics: { exit: 137, oomKilled: false, backend: 'docker' as const, killedBy: 'wall' as const } }
  assert.equal(((await m.outcome(lease.attemptId, finished(lease.attemptId, [], timedOut))).body as { result: string }).result, 'applied')
  const settled = getSubmission(sent.id)!
  const said = (competitionRead: typeof atTake) => notebookNote({ ...timedOut, submission: null }, competitionRead)
  assert.notEqual(said(atTake), said(edited), 'the two readings differ in their numbers')
  assert.equal(settled.participantError, said(atTake), 'the take\'s ten minutes, which the run was held to')
})

/* ----------------------------------------- the cases of §10.1 a machine adds */

import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { packagesRoomMb } from '../shared/dependencies.js'
import { bindSubmission, completeBundle, createBundle, setPolicy } from '../server/src/dependencies/store.js'
import { dependencyRoot } from '../server/src/dependencies/files.js'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'

test('a lease with a package set names it, the set is described with its wheels, and a wheel is fetchable by hash only by a machine that holds the set', async () => {
  reset()
  const MiB = 1024 * 1024
  const c = competition({ memoryMb: 4096 })
  setPolicy(c.id, { enabled: true })
  const sent = send(c, { revisionId: null })
  const wheel = Buffer.from(`a wheel as pip downloaded it, for ${c.id}`)
  const sha = createHash('sha256').update(wheel).digest('hex')
  const fileName = 'catboost-1.2.10-py3-none-any.whl'
  const set = createBundle(c.id, sent.entrantId, c.revisionId, 'catboost')
  assert.equal(completeBundle(set.id, {
    normalizedRequirements: ['catboost'], downloadBytes: wheel.length, installedBytes: 100 * MiB, contentHash: '3'.repeat(64),
    packages: [{ name: 'catboost', version: '1.2.10', fileName, sha256: sha, bytes: wheel.length, url: `https://files.pythonhosted.org/packages/ab/cd/${fileName}` }],
    lock: `catboost==1.2.10 --hash=sha256:${sha}\n`,
  }), true)
  fs.mkdirSync(path.join(dependencyRoot, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(dependencyRoot, 'artifacts', sha), wheel)
  bindSubmission(sent.id, c.revisionId, set.id)
  forgetStock()
  const home = await serve()
  const m = new Machine(home)
  assert.equal((await m.join(code())).status, 200)
  // Asked to hold the set, described in full: its lock and its wheel, by hash.
  const first = await m.sync()
  const wanted = first.body.want.bundles.find((one) => one.id === set.id)
  assert.ok(wanted, 'the set is wanted')
  assert.equal(wanted.packagesMb, packagesRoomMb(100 * MiB))
  assert.match(wanted.lock ?? '', /catboost==1\.2\.10/)
  assert.deepEqual(wanted.wheels?.map((one) => [one.fileName, one.sha256, one.bytes]), [[fileName, sha, wheel.length]])
  // Ready (a set gates no lease): the lease names the set and its room.
  const data = first.body.want.data.find((entry) => entry.competitionId === c.id)!
  const leased = await m.sync({ ready: { revisions: [c.revisionId], data: [data.manifest], sealed: [], bundles: [] } })
  const lease = leased.body.leases.find((one) => one.submissionId === sent.id)
  assert.ok(lease, 'leased')
  assert.deepEqual(lease.bundle, { id: set.id, packagesMb: packagesRoomMb(100 * MiB) })
  // The wheel by its hash, to the machine that holds the set — and to no machine that does not.
  const fetched = await m.call('GET', `blobs/${sha}`)
  assert.equal(fetched.status, 200)
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), wheel)
  const stranger = new Machine(home)
  assert.equal((await stranger.join(code())).status, 200)
  assert.equal((await stranger.call('GET', `blobs/${sha}`)).status, 404, 'a machine never told of the set')
})

test('on the hidden test a machine\'s run is clamped and worded for a blind participant exactly as a run here is', async () => {
  // The same forged report from both: a cell far past the notebook's, and a traceback the hidden rows were in memory for.
  const detail = 'Traceback (most recent call last):\n  Cell In[2], line 1\nValueError: the secret row is 42'
  const cells = [`# colloq-test: ${JSON.stringify({ status: 'cell_error', cell: 48_213, detail })}\nx = 1`, 'y = 2', 'z = 3']
  // Here: this server's notebooks on, and its stand-in runner reports it.
  reset({ homeNotebooks: true })
  const c = competition({ sealed: true })
  const here = send(c, { cells })
  await drainCompetitionQueue()
  const local = getSubmission(here.id)!
  assert.equal(local.state, 'notebookFailed')
  const localRun = listRuns(here.id).find((run) => run.kind === 'notebook')!
  // On a trusted machine, with the very same report.
  reset()
  const remote = send(c, { cells })
  const m = new Machine(await serve())
  assert.equal((await m.join(code({ trusted: true }))).status, 200)
  const first = await m.sync()
  const ready = {
    revisions: [c.revisionId],
    data: [...new Set(first.body.want.data.filter((entry) => entry.competitionId === c.id && !entry.sealed).map((entry) => entry.manifest))],
    sealed: [...new Set(first.body.want.data.filter((entry) => entry.competitionId === c.id && entry.sealed).map((entry) => entry.manifest))],
    bundles: [],
  }
  const lease = (await m.sync({ ready })).body.leases.find((one) => one.submissionId === remote.id)!
  assert.ok(lease?.sealed, 'a hidden-test lease, on a trusted machine')
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 10 }] })
  assert.equal((await m.put(lease.attemptId, 'executed.ipynb', '{"cells":[]}')).status, 200)
  const reported = finished(lease.attemptId, [{ name: 'executed.ipynb', body: '{"cells":[]}' }], {
    status: 'cell_error', cell: 48_213, cells: 3, produced: false, detail, diagnostics: { exit: 1, oomKilled: false, backend: 'docker' },
  })
  assert.equal(((await m.outcome(lease.attemptId, reported)).body as { result: string }).result, 'applied')
  const machine = getSubmission(remote.id)!
  const machineRun = listRuns(remote.id).find((run) => run.kind === 'notebook')!
  for (const key of ['state', 'stage', 'cellsDone', 'cellsTotal', 'participantError', 'briefError', 'errorType'] as const) {
    assert.deepEqual(machine[key], local[key], `${key}: the same as a run here`)
  }
  assert.ok(machine.cellsDone <= 3, 'clamped to the notebook that was sent')
  assert.ok(!(machine.briefError ?? '').includes('42'), 'the blind participant reads none of the traceback')
  assert.deepEqual([machineRun.verdict, machineRun.cellsDone, machineRun.cellsTotal], [localRun.verdict, localRun.cellsDone, localRun.cellsTotal])
})

test('a machine\'s run crowded off its card by a neighbour\'s burst goes back once, with our words, and is judged the second time', async () => {
  reset()
  const c = competition({ gpu: true })
  const sent = send(c)
  const m = new Machine(await serve())
  assert.equal((await m.join(code())).status, 200)
  const card = { device: '0', name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564, perDevice: 2, busyShares: 0 }
  const first = await m.sync({ cards: [card] })
  const ready = { revisions: [c.revisionId], data: [first.body.want.data.find((entry) => entry.competitionId === c.id)!.manifest], sealed: [], bundles: [] }
  const free = { slots: 1, memoryMb: 32_768, cpus: 16, gpuShares: 2, diskMb: 100_000 }
  const oom = 'Traceback (most recent call last):\n  Cell In[3], line 4\ntorch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB'
  const crowdedRun = (attemptId: string) => finished(attemptId, [{ name: 'executed.ipynb', body: '{"cells":[]}' }], {
    status: 'cell_error', cell: 2, cells: 4, produced: false, detail: oom, crowded: true,
    card: { device: '0', perDevice: 2, sliceMb: 12_282 }, diagnostics: { exit: 1, oomKilled: false, backend: 'docker' },
  })
  const run = async () => {
    const lease = (await m.sync({ ready, cards: [card], free })).body.leases.find((one) => one.submissionId === sent.id)!
    assert.ok(lease?.gpu, 'a lease on the card')
    await m.sync({ seq: lease.seq, ready, cards: [card], free: { ...free, slots: 0, gpuShares: 1 }, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 10, card: { device: '0', sliceMb: 12_282 } }] })
    assert.equal((await m.put(lease.attemptId, 'executed.ipynb', '{"cells":[]}')).status, 200)
    assert.equal(((await m.outcome(lease.attemptId, crowdedRun(lease.attemptId))).body as { result: string }).result, 'applied')
  }
  await run()
  const row = queueRow(sent.id)!
  assert.equal(row.state, 'waiting', 'back to the queue, on the machine\'s word that a neighbour crowded it out')
  assert.equal(row.resourceRetries, 1)
  assert.equal(getSubmission(sent.id)?.participantError, tr('competitions.answer.gpuNeighbourRetry'))
  assert.notEqual(getSubmission(sent.id)?.state, 'notebookFailed', 'not the participant\'s failure')
  // The second time it is judged as any run is: once, not for ever.
  db.prepare('UPDATE competition_queue SET not_before = 0 WHERE submission_id = ?').run(sent.id)
  await run()
  assert.equal(getSubmission(sent.id)?.state, 'notebookFailed')
  assert.equal(queueRow(sent.id), null)
})
