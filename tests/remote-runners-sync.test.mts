/**
 * The sync (§3.3, §3.4): a long-poll held while there is nothing to say and
 * answered the moment there is, level-triggered, with offers repeated until
 * acked, and with what each machine may hold worked out for it.
 *
 * What fails quietly here is time and trust: a held sync that is not woken
 * by a new upload makes an idle machine wait twenty-five seconds for work it
 * could start now; one not woken by a cancel lets a cancelled run go on; an
 * offer not repeated is a lost reply that becomes a lost run; a machine of
 * another build given new work runs a sandbox nobody compared with this
 * server's; a GPU image sent to a machine without cards is gigabytes for
 * nothing, and the hidden test sent to an untrusted one is the hidden test
 * on a stranger's disk.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { cancelSubmission, wakeCompetitionPump } from '../server/src/competitions/runner.js'
import { getSubmission, queueRow, setCompetitionState } from '../server/src/competitions/store.js'
import { getLease } from '../server/src/competitions/remote/store.js'
import { ANSWER, Machine, close, code, competition, finished, reset, send, serve, type TestCompetition } from './_remote.mts'

useCompetitionRunner(new FakeCompetitionRunner())

after(() => close())

async function joined(options: { trusted?: boolean } = {}): Promise<Machine> {
  const m = new Machine(await serve())
  assert.equal((await m.join(code({ trusted: options.trusted }))).status, 200)
  return m
}

async function readyFor(m: Machine, competitions: TestCompetition[]) {
  const first = await m.sync()
  const ids = new Set(competitions.map((c) => c.id))
  return {
    revisions: competitions.map((c) => c.revisionId),
    data: first.body.want.data.filter((entry) => ids.has(entry.competitionId) && !entry.sealed).map((entry) => entry.manifest),
    sealed: first.body.want.data.filter((entry) => ids.has(entry.competitionId) && entry.sealed).map((entry) => entry.manifest),
    bundles: [],
  }
}

test('a sync with nothing to say is held for what the machine allows, and answered at once when work arrives', async () => {
  reset()
  const c = competition()
  const m = await joined()
  const ready = await readyFor(m, [c])
  await m.sync({ ready })
  // Nothing new: held for its whole hold.
  let started = Date.now()
  let r = await m.sync({ ready, holdMs: 400 })
  assert.equal(r.status, 200)
  assert.ok(Date.now() - started >= 350, 'held while nothing changed')
  assert.deepEqual(r.body.leases, [])
  // Work arrives while it is held: answered at once, with the lease.
  started = Date.now()
  const held = m.sync({ ready, holdMs: 20_000 })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const sent = send(c)
  wakeCompetitionPump()
  r = await held
  assert.ok(Date.now() - started < 5000, 'not held to the end once there was news')
  assert.equal(r.body.leases[0]?.submissionId, sent.id)
})

test('a cancel wakes the machine\'s held sync, and its reply carries the revoke', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = await joined()
  const ready = await readyFor(m, [c])
  const lease = (await m.sync({ ready })).body.leases[0]
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  const started = Date.now()
  const held = m.sync({ seq: lease.seq, ready, holdMs: 10_000, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 100 }] })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(await cancelSubmission(sent.id, 'entrant'), true, 'a durable cancel, whatever this server\'s own runtime')
  const r = await held
  assert.ok(Date.now() - started < 5000)
  assert.deepEqual(r.body.revoke, [{ id: lease.attemptId, reason: 'cancelled' }])
  assert.equal(getSubmission(sent.id)?.state, 'cancelled')
  assert.equal(queueRow(sent.id), null)
  assert.equal(getLease(lease.attemptId)?.state, 'revoked')
})

test('an offer is repeated in every reply until a sync acks it', async () => {
  reset()
  const c = competition()
  send(c)
  const m = await joined()
  const ready = await readyFor(m, [c])
  const first = (await m.sync({ ready })).body.leases[0]
  assert.ok(first)
  // The reply was lost: the machine syncs again with the seq it had.
  const again = (await m.sync({ ready, seq: first.seq - 1 })).body.leases
  assert.deepEqual(again.map((lease) => lease.attemptId), [first.attemptId])
  const acked = (await m.sync({ ready, seq: first.seq, attempts: [{ id: first.attemptId, phase: 'accepted' }] })).body.leases
  assert.deepEqual(acked, [])
  assert.equal(getLease(first.attemptId)?.state, 'accepted')
})

test('a machine of another build is told so and given nothing new, while its run in flight still finishes', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = await joined()
  const ready = await readyFor(m, [c])
  const lease = (await m.sync({ ready })).body.leases[0]
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  send(c)
  const other = 'f'.repeat(64)
  const r = await m.sync({ build: other, seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 10 }] })
  assert.equal(r.body.compatible, false)
  assert.deepEqual(r.body.leases, [], 'no new lease for another build')
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  const out = await m.outcome(lease.attemptId, { ...finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]), build: other })
  assert.equal((out.body as { result: string; leases: unknown[] }).result, 'applied', 'the lease out finishes')
  assert.deepEqual((out.body as { leases: unknown[] }).leases, [], 'and nothing new comes with its reply')
  assert.equal(queueRow(sent.id)?.kind, 'metric')
})

test('a machine draining on its own takes nothing new; the owner\'s drain says so in every reply', async () => {
  reset()
  const c = competition()
  send(c)
  const m = await joined()
  const ready = await readyFor(m, [c])
  const r = await m.sync({ ready, state: 'draining' })
  assert.deepEqual(r.body.leases, [])
  assert.equal(r.body.drain, false, 'its own drain is not the owner\'s')
})

test('an outcome\'s reply carries the machine\'s next work at once', async () => {
  reset()
  const c = competition()
  send(c, { at: 1 })
  const next = send(c, { at: 2 })
  const m = await joined()
  const ready = await readyFor(m, [c])
  const lease = (await m.sync({ ready, free: { slots: 1, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 } })).body.leases[0]
  await m.sync({ seq: lease.seq, ready, free: { slots: 0, memoryMb: 28_000, cpus: 14, gpuShares: 0, diskMb: 99_000 }, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  const out = await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]))
  const leases = (out.body as { leases: { submissionId: string }[] }).leases
  assert.deepEqual(leases.map((one) => one.submissionId), [next.id])
})

test('what a machine is asked to hold: GPU kernels only with cards, the hidden test only when trusted, and what to forget', async () => {
  reset()
  const gpu = competition({ gpu: true })
  const sealed = competition({ sealed: true })
  send(gpu)
  const plain = await joined()
  const trusted = await joined({ trusted: true })
  const without = (await plain.sync()).body.want
  assert.equal(without.revisions.some((revision) => revision.id === gpu.revisionId), false, 'no GPU kernel to a machine without cards')
  assert.equal(without.data.some((entry) => entry.sealed), false, 'no hidden test to an untrusted machine')
  const carded = (await trusted.sync({ cards: [{ device: '0', name: 'RTX 4090', memoryMb: 24_564, perDevice: 1, busyShares: 0 }] })).body
  const revision = carded.want.revisions.find((one) => one.id === gpu.revisionId)
  assert.ok(revision, 'a machine with cards is asked for the GPU kernel')
  assert.equal(revision.gpu, true)
  assert.ok(carded.want.data.some((entry) => entry.competitionId === sealed.id && entry.sealed), 'a trusted machine is asked for the hidden test')
  assert.equal(carded.trusted, true)
  // The competition closes: the machine is told to forget it.
  setCompetitionState(sealed.id, 'finished')
  const { forgetStock } = await import('../server/src/competitions/remote/want.js')
  forgetStock()
  const after = (await trusted.sync({ cards: [{ device: '0', name: 'RTX 4090', memoryMb: 24_564, perDevice: 1, busyShares: 0 }] })).body
  assert.ok(after.forget.includes(sealed.id))
  assert.equal(after.want.data.some((entry) => entry.competitionId === sealed.id), false)
})
