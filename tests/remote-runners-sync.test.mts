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
import { getLease, liveLeases } from '../server/src/competitions/remote/store.js'
import type { RemoteOutcomeReply } from '../shared/remote-runner.js'
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
  // The competition closes: the machine, which holds its data, is told to forget it.
  const held = carded.want.data.filter((entry) => entry.competitionId === sealed.id)
  const holding = { revisions: [], data: held.filter((entry) => !entry.sealed).map((entry) => entry.manifest), sealed: held.filter((entry) => entry.sealed).map((entry) => entry.manifest), bundles: [] }
  setCompetitionState(sealed.id, 'finished')
  const { forgetStock } = await import('../server/src/competitions/remote/want.js')
  forgetStock()
  const after = (await trusted.sync({ ready: holding, cards: [{ device: '0', name: 'RTX 4090', memoryMb: 24_564, perDevice: 1, busyShares: 0 }] })).body
  assert.ok(after.forget.includes(sealed.id))
  assert.equal(after.want.data.some((entry) => entry.competitionId === sealed.id), false)
})

test('two competitions with the very same files, and a hidden-test copy, each get their own entry in what a machine holds', async () => {
  reset()
  // Every competition of these tests has the same open files (tests/_remote.mts · competition): one manifest for all of them.
  const first = competition()
  const second = competition()
  const copy = competition({ sealed: true })
  for (const c of [first, second, copy]) send(c)
  const trusted = await joined({ trusted: true })
  // Parsed by the contract's own parser (Machine.sync): a reply it refused would fail here, not on a rented VM.
  const r = await trusted.sync()
  assert.equal(r.status, 200)
  const entries = r.body.want.data
  const open = (c: TestCompetition) => entries.find((entry) => entry.competitionId === c.id && !entry.sealed)
  for (const c of [first, second, copy]) assert.ok(open(c), `${c.slug} has its own entry`)
  assert.equal(open(first)!.manifest, open(second)!.manifest, 'under one shared manifest')
  assert.equal(open(first)!.manifest, open(copy)!.manifest)
  assert.ok(entries.some((entry) => entry.competitionId === copy.id && entry.sealed), 'and the copy\'s hidden test beside its open data')
  // What is ready is per manifest: one report of it makes the machine ready for all three.
  const ready = { revisions: [first.revisionId, second.revisionId, copy.revisionId], data: [open(first)!.manifest], sealed: entries.filter((entry) => entry.sealed).map((entry) => entry.manifest), bundles: [] }
  const leased = await trusted.sync({ ready, free: { slots: 8, memoryMb: 65_000, cpus: 32, gpuShares: 0, diskMb: 100_000 } })
  assert.deepEqual(new Set(leased.body.leases.map((lease) => lease.competitionId)), new Set([first.id, second.id, copy.id]))
})

test('a repeated outcome gets its first result, with the trust and the leases as they are now: never the first reply\'s hidden-test offer', async () => {
  reset()
  const c = competition({ sealed: true })
  send(c, { at: 1 })
  const next = send(c, { at: 2 })
  const m = await joined({ trusted: true })
  const ready = await readyFor(m, [c])
  const lease = (await m.sync({ ready, free: { slots: 1, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 } })).body.leases[0]
  assert.equal(lease.sealed, true)
  await m.sync({ seq: lease.seq, ready, free: { slots: 0, memoryMb: 28_000, cpus: 14, gpuShares: 0, diskMb: 99_000 }, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  const request = finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }])
  const first = (await m.outcome(lease.attemptId, request)).body as RemoteOutcomeReply
  assert.equal(first.trusted, true)
  const offered = first.leases.find((one) => one.submissionId === next.id)
  assert.ok(offered?.sealed, 'the next hidden-test lease, at once')
  // That reply is lost on the way; meanwhile the owner stops trusting the machine, which takes the offer back.
  const { untrustRunner } = await import('../server/src/competitions/remote/release.js')
  untrustRunner(m.runnerId)
  assert.equal(getLease(offered.attemptId)?.state, 'revoked')
  // The machine posts the same outcome again: the result it had, the trust as it is now, and no hidden test (the contract's parser would refuse one).
  const again = await m.outcome(lease.attemptId, request)
  assert.equal(again.status, 200)
  const repeated = again.body as RemoteOutcomeReply
  assert.equal(repeated.result, 'applied')
  assert.equal(repeated.trusted, false)
  assert.deepEqual(repeated.leases, [])
})

test('a machine that hands a run back because it stops is given no work in that reply', async () => {
  reset()
  const c = competition()
  send(c, { at: 1 })
  send(c, { at: 2 })
  send(c, { at: 3 })
  const m = await joined()
  const ready = await readyFor(m, [c])
  const lease = (await m.sync({ ready, free: { slots: 1, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 } })).body.leases[0]
  await m.sync({ seq: lease.seq, ready, free: { slots: 0, memoryMb: 28_000, cpus: 14, gpuShares: 0, diskMb: 99_000 }, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  // docker stop: the run goes back as a drain, with room on the machine and work waiting.
  const stopping = { protocol: 1, build: 'dev', free: { slots: 4, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 }, kind: 'declined', reason: 'draining', detail: 'SIGTERM' }
  const out = await m.outcome(lease.attemptId, stopping)
  assert.equal(out.status, 200)
  assert.equal((out.body as RemoteOutcomeReply).result, 'applied')
  assert.deepEqual((out.body as RemoteOutcomeReply).leases, [], 'a machine that stops passes whatever a reply hands it')
  assert.deepEqual(liveLeases(m.runnerId), [], 'and nothing is held for it')
})

test('a run one machine gives back is offered to another machine\'s held sync at once, not at the end of its hold', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const a = await joined()
  const b = await joined()
  const readyA = await readyFor(a, [c])
  const readyB = await readyFor(b, [c])
  const one = { slots: 1, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 }
  const lease = (await a.sync({ ready: readyA, free: one })).body.leases[0]
  assert.equal(lease?.submissionId, sent.id)
  await a.sync({ seq: lease.seq, ready: readyA, free: { ...one, slots: 0 }, attempts: [{ id: lease.attemptId, phase: 'accepted' }] })
  for (const [why, giveBack] of [
    // The agent restarted: its sync no longer lists the run.
    ['missing', () => a.sync({ seq: lease.seq, ready: readyA, free: { ...one, slots: 0 } })],
  ] as const) {
    // B idles in a long hold, with room for one.
    const started = Date.now()
    const held = b.sync({ ready: readyB, free: one, holdMs: 20_000 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    await giveBack()
    const r = await held
    assert.ok(Date.now() - started < 5_000, `${why}: answered at once (${Date.now() - started} ms)`)
    assert.equal(r.body.leases[0]?.submissionId, sent.id, `${why}: and the row is B's`)
  }
  // And a decline in an outcome: B gives it back, A, idle in a hold, takes it at once.
  const back = b.last!.leases[0]
  await b.sync({ seq: back.seq, ready: readyB, free: { ...one, slots: 0 }, attempts: [{ id: back.attemptId, phase: 'accepted' }] })
  const started = Date.now()
  const held = a.sync({ ready: readyA, free: one, holdMs: 20_000 })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const declined = await b.outcome(back.attemptId, { protocol: 1, build: 'dev', free: { ...one, slots: 0 }, kind: 'declined', reason: 'image', detail: 'pull failed' })
  assert.equal((declined.body as RemoteOutcomeReply).result, 'applied')
  const r = await held
  assert.ok(Date.now() - started < 5_000, `a decline: answered at once (${Date.now() - started} ms)`)
  assert.equal(r.body.leases[0]?.submissionId, sent.id)
})

test('what a machine was asked to hold outlives a restart of this server: a competition closed after one is still forgotten', async () => {
  reset()
  const { resetHeard } = await import('../server/src/competitions/remote/heard.js')
  const { forgetStock } = await import('../server/src/competitions/remote/want.js')
  const { db } = await import('../server/src/db.js')
  const sealed = competition({ sealed: true })
  const leased = competition()
  const waiting = send(sealed)
  send(leased)
  const m = await joined({ trusted: true })
  const ready = await readyFor(m, [leased])
  assert.ok((await m.sync()).body.want.data.some((entry) => entry.competitionId === sealed.id && entry.sealed), 'asked for its hidden test')
  // A run of the other one, settled.
  const lease = (await m.sync({ ready })).body.leases.find((one) => one.competitionId === leased.id)!
  assert.ok(lease)
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 10 }] })
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  assert.equal(((await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]))).body as RemoteOutcomeReply).result, 'applied')
  // This server restarts (nothing in memory any more), and a database from before the list was kept knows only the lease.
  resetHeard(Date.now() - 10 * 60_000)
  db.prepare('UPDATE remote_runners SET wanted = NULL WHERE id = ?').run(m.runnerId)
  const back = await m.sync()
  // This server restarts once more, and both competitions close (nothing of them waits) while the machine still holds their data.
  resetHeard(Date.now() - 10 * 60_000)
  const { leaveQueue } = await import('../server/src/competitions/store.js')
  leaveQueue(waiting.id)
  setCompetitionState(sealed.id, 'finished')
  setCompetitionState(leased.id, 'finished')
  forgetStock()
  const of = (id: string) => back.body.want.data.filter((entry) => entry.competitionId === id)
  const holding = {
    revisions: [],
    data: [...new Set([...of(sealed.id), ...of(leased.id)].filter((entry) => !entry.sealed).map((entry) => entry.manifest).concat(ready.data))],
    sealed: of(sealed.id).filter((entry) => entry.sealed).map((entry) => entry.manifest),
    bundles: [],
  }
  const told = (await m.sync({ ready: holding })).body
  assert.ok(back.body.want.data.some((entry) => entry.competitionId === sealed.id), 'still wanted before they closed')
  assert.ok(told.forget.includes(sealed.id), 'the hidden test of a competition closed after a restart is purged')
  assert.ok(told.forget.includes(leased.id), 'and the data of one it only ran a lease of')
  // Level-triggered: named again while the machine still says it holds their data (the reply may have been lost) ...
  assert.ok((await m.sync({ ready: holding })).body.forget.includes(sealed.id), 'a lost reply is only a delay')
  // ... and not once it holds none of it.
  assert.deepEqual((await m.sync()).body.forget.filter((id) => id === sealed.id || id === leased.id), [])
  assert.deepEqual((await m.sync({ ready: holding })).body.forget.filter((id) => id === sealed.id || id === leased.id), [], 'and forgotten for good once dropped')
})
