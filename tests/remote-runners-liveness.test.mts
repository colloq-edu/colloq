/**
 * When a machine's runs count as gone, and what that costs (§3.4,
 * competitions/remote/liveness.ts and release.ts), on a clock the test
 * moves by hand.
 *
 * The rules cut both ways, and both failures are quiet. Expire too early —
 * on a silence that is the tunnel's, in the first minutes after this
 * server's restart — and a fleet's worth of notebooks runs twice. Expire
 * too late, or never — an offer nobody acked, a run past its ceiling, a
 * machine that says it no longer holds the run — and the participant
 * watches a timer that does not move. And whatever this costs must never be
 * the participant's: no quota, no failed attempt, our words for what
 * happened, their place in the queue kept.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tr } from '../shared/i18n.js'
import { countsTowardDailyQuota, countsTowardFailedAttempts } from '../shared/competitions.js'
import { REMOTE_BLIND_MS, REMOTE_BOOT_GRACE_MS, REMOTE_EVIDENCE_MS, REMOTE_OFFER_MS, REMOTE_SILENCE_MS } from '../shared/remote-runner.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { getSubmission, listRuns, queueRow, updateSubmission } from '../server/src/competitions/store.js'
import { getLease, getRunner, joinRunner, updateLease, type RunnerRow } from '../server/src/competitions/remote/store.js'
import { runnerOffer, reconcileSync, takeForRunner, type RunnerOffer } from '../server/src/competitions/remote/lease.js'
import { dataNow } from '../server/src/competitions/remote/want.js'
import { declineLease, loseLease } from '../server/src/competitions/remote/release.js'
import { bootRemoteRunners, probeOwnPath, remoteTick, settleUnfit } from '../server/src/competitions/remote/liveness.js'
import { noteCall, resetHeard } from '../server/src/competitions/remote/heard.js'
import { machineDetail, machinesResponse } from '../server/src/competitions/remote/views.js'
import { holdQueueRow } from '../server/src/competitions/store.js'
import { bindSubmission, completeBundle, createBundle, setPolicy } from '../server/src/dependencies/store.js'
import { updateCompetition } from '../server/src/competitions/store.js'
import { FACTS, code, competition, reset, send, syncRequest, type TestCompetition } from './_remote.mts'

useCompetitionRunner(new FakeCompetitionRunner())

/** The probe's address resolves elsewhere: no DNS asked in a test (liveness.ts · leavesHost has tests of its own). */
const elsewhere = async (): Promise<boolean> => true

function machine(): RunnerRow {
  const joined = joinRunner({ code: code(), joinId: randomUUID().replaceAll('-', ''), build: 'dev', facts: FACTS, address: null }, Date.now())
  assert.ok(joined.ok)
  return joined.runner
}

function offerFor(runner: RunnerRow, c: TestCompetition): RunnerOffer {
  const sets = dataNow(c.id)
  const sync = syncRequest({ ready: { revisions: [c.revisionId], data: sets.open ? [sets.open.manifest] : [], sealed: [], bundles: [] } })
  return runnerOffer(getRunner(runner.id)!, sync.free, sync)
}

/** A lease on `runner` whose container started `ago` ms before `at` (null — not started). */
function running(runner: RunnerRow, c: TestCompetition, at: number, started: number | null = at) {
  const [lease] = takeForRunner(runner, offerFor(runner, c), at)
  assert.ok(lease, 'leased')
  updateLease(lease.attemptId, { state: started === null ? 'accepted' : 'running', acceptedAt: at, ...(started === null ? {} : { startedAt: started, phase: 'running' as const }) })
  noteCall(runner.id, at, null)
  return lease
}

test('an offer nobody acks within a minute is withdrawn, with nothing counted against anyone', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = machine()
  const now = Date.now()
  const [lease] = takeForRunner(m, offerFor(m, c), now)
  assert.equal(remoteTick(now + REMOTE_OFFER_MS - 1000).withdrawn, 0)
  assert.equal(remoteTick(now + REMOTE_OFFER_MS + 1000).withdrawn, 1)
  assert.equal(getLease(lease.attemptId)?.state, 'withdrawn')
  const row = queueRow(sent.id)!
  assert.equal(row.state, 'waiting')
  assert.equal(row.lost, 0)
  assert.equal(row.attempts, 0, 'the attempt is refunded')
  assert.equal(listRuns(sent.id).length, 0, 'the run row the take started went')
  assert.equal(getSubmission(sent.id)?.state, 'queued')
  reset()
})

test('an offer a sync leaves out after seeing its number is withdrawn at once; one it may not have seen yet is not', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = machine()
  const now = Date.now()
  const [lease] = takeForRunner(m, offerFor(m, c), now)
  // A sync sent before the offer was made (lower seq): the offer stays, to be repeated.
  reconcileSync(getRunner(m.id)!, syncRequest({ seq: lease.seq - 1 }), now)
  assert.equal(getLease(lease.attemptId)?.state, 'offered')
  // A sync that has seen it and does not list it: it never arrived.
  reconcileSync(getRunner(m.id)!, syncRequest({ seq: lease.seq }), now)
  assert.equal(getLease(lease.attemptId)?.state, 'withdrawn')
  assert.equal(queueRow(sent.id)?.state, 'waiting')
  reset()
})

test('a delivered run the machine stops listing is lost at once — refunded before its container started', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = machine()
  const now = Date.now()
  const lease = running(m, c, now, null)
  reconcileSync(getRunner(m.id)!, syncRequest({ seq: lease.seq }), now)
  assert.equal(getLease(lease.attemptId)?.state, 'lost')
  const row = queueRow(sent.id)!
  assert.equal(row.state, 'waiting')
  assert.equal(row.lost, 0, 'no container had started: nothing counted')
  assert.equal(listRuns(sent.id).length, 0)
  reset()
})

test('a silent machine loses its runs only with path evidence, never in the boot grace, and at last after a blind quarter of an hour', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = machine()
  const witness = machine()
  const now = Date.now()
  const lease = running(m, c, now)
  const later = now + REMOTE_SILENCE_MS + 5000
  // Silent past the limit, but nothing else heard and no probe: it may be the tunnel's silence.
  assert.equal(remoteTick(later).lost, 0)
  assert.equal(getLease(lease.attemptId)?.state, 'running')
  // Within this life's boot grace nothing expires, path evidence or not.
  resetHeard(later - REMOTE_BOOT_GRACE_MS + 10_000)
  noteCall(m.id, now, null)
  noteCall(witness.id, later, null)
  assert.equal(remoteTick(later).lost, 0)
  // Past the grace, with another machine heard within a minute: the silence is the machine's.
  resetHeard(now - 10 * 60_000)
  noteCall(m.id, now, null)
  noteCall(witness.id, later - REMOTE_EVIDENCE_MS + 1000, null)
  assert.equal(remoteTick(later).lost, 1)
  const lost = getLease(lease.attemptId)!
  assert.equal(lost.state, 'lost')
  assert.equal(lost.cause, 'silent')
  const row = queueRow(sent.id)!
  assert.equal(row.state, 'waiting')
  assert.equal(row.lost, 1, 'its container had started: the loss counts toward the three')
  const run = listRuns(sent.id).find((one) => one.id === lease.runId)!
  assert.equal(run.verdict, 'unknown')
  assert.match(run.teacherError ?? '', new RegExp(m.name))
  const back = getSubmission(sent.id)!
  assert.equal(back.state, 'queued')
  assert.equal(back.participantError, tr('server.runners.returned'))
  assert.equal(back.briefError, back.participantError, 'our words, safe to show blind')
  reset()

  // Without any evidence the silence expires all the same after REMOTE_BLIND_MS.
  const c2 = competition()
  send(c2)
  const alone = machine()
  const t0 = Date.now()
  const blind = running(alone, c2, t0)
  assert.equal(remoteTick(t0 + REMOTE_BLIND_MS - 1000).lost, 0)
  assert.equal(remoteTick(t0 + REMOTE_BLIND_MS + 1000).lost, 1)
  assert.equal(getLease(blind.attemptId)?.state, 'lost')
  reset()
})

test('this server\'s probe of its own address through the relay is path evidence', async () => {
  reset()
  const c = competition()
  send(c)
  const m = machine()
  const now = Date.now()
  const lease = running(m, c, now)
  const passing = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
  const later = now + REMOTE_SILENCE_MS + 5000
  assert.equal(await probeOwnPath(later - 1000, passing, 'https://vsos.colloq.ru', elsewhere), true)
  assert.equal(remoteTick(later).lost, 1)
  assert.equal(getLease(lease.attemptId)?.state, 'lost')
  reset()
})

test('a probe of the loopback is no evidence of the relay: a silent machine keeps its runs while nothing else proves the path', async () => {
  reset()
  const c = competition()
  send(c)
  const m = machine()
  const now = Date.now()
  const lease = running(m, c, now)
  const asked: string[] = []
  const passing = (async (url: URL) => {
    asked.push(String(url))
    return new Response('{"ok":true}', { status: 200 })
  }) as unknown as typeof fetch
  const later = now + REMOTE_SILENCE_MS + 5000
  // The default PUBLIC_URL of an instance with no address: it answers from this very process, through no relay at all.
  for (const home of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(await probeOwnPath(later - 1000, passing, home), false, home)
  }
  assert.deepEqual(asked, [], 'not even asked')
  assert.equal(remoteTick(later).lost, 0, 'no evidence: the silence may be the tunnel\'s')
  assert.equal(getLease(lease.attemptId)?.state, 'running')
  reset()
})

test('the probe follows one redirect from http to https on its own host, and no other', async () => {
  reset()
  machine()
  const redirecting = (to: string) => (async (url: URL) => String(url).startsWith('http://')
    ? new Response(null, { status: 308, headers: { location: to } })
    : new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
  assert.equal(await probeOwnPath(Date.now(), redirecting('https://vsos.colloq.ru/api/readyz'), 'http://vsos.colloq.ru', elsewhere), true, 'Caddy\'s http to https')
  assert.equal(await probeOwnPath(Date.now(), redirecting('https://elsewhere.example/api/readyz'), 'http://vsos.colloq.ru', elsewhere), false, 'another host is not this server')
  assert.equal(await probeOwnPath(Date.now(), redirecting('http://vsos.colloq.ru/login'), 'http://vsos.colloq.ru', elsewhere), false)
  reset()
})

test('a run past its ceiling is lost even while its machine keeps syncing', () => {
  reset()
  const c = competition({ wallSeconds: 60 })
  send(c)
  const m = machine()
  const now = Date.now()
  const lease = running(m, c, now)
  const past = getLease(lease.attemptId)!.deadlineAt + 1000
  noteCall(m.id, past, null)
  assert.equal(remoteTick(past).lost, 1)
  assert.equal(getLease(lease.attemptId)?.cause, 'ceiling')
  reset()
})

test('lost by three different machines, a submission ends as our failure and spends no quota', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const machines = [machine(), machine(), machine()]
  const now = Date.now()
  for (const [i, m] of machines.entries()) {
    const lease = running(m, c, now + i)
    assert.equal(loseLease(lease.attemptId, now + i + 1, 'silent'), true)
  }
  const done = getSubmission(sent.id)!
  assert.equal(done.state, 'metricFailed')
  assert.equal(done.participantError, tr('server.runners.lostFailed'))
  for (const m of machines) assert.match(done.teacherError ?? '', new RegExp(m.name))
  assert.equal(countsTowardDailyQuota(done), false, 'no quota spent')
  assert.equal(countsTowardFailedAttempts(done), false, 'and no failed attempt')
  assert.equal(queueRow(sent.id), null)
  reset()
})

test('declined by three different machines, a submission ends as our failure, with their reasons', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const now = Date.now()
  for (const [i, why] of ['pull failed', 'no space', 'driver 535'].entries()) {
    const m = machine()
    const [lease] = takeForRunner(m, offerFor(m, c), now + i)
    assert.equal(declineLease(lease.attemptId, now + i, i === 1 ? 'disk' : 'image', why), 'declined')
  }
  const done = getSubmission(sent.id)!
  assert.equal(done.state, 'metricFailed')
  assert.equal(done.participantError, tr('server.runners.declinedFailed'))
  assert.match(done.teacherError ?? '', /no space/)
  assert.match(done.teacherError ?? '', /driver 535/)
  reset()
})

test('a run given back on a drain, even after its container started, waits again with nothing counted', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = machine()
  const now = Date.now()
  const lease = running(m, c, now)
  assert.equal(declineLease(lease.attemptId, now + 10, 'draining', 'colloq-host runner update --now'), 'declined')
  const row = queueRow(sent.id)!
  assert.equal(row.state, 'waiting')
  assert.equal(row.lost, 0)
  assert.equal(getLease(lease.attemptId)?.cause, 'draining')
  assert.equal(getRunner(m.id)!.state, 'active', 'and no quarantine')
  reset()
})

test('a drain after the container started is skipped by that machine for the decline\'s window, one before it is not: a giveback cannot hold a submission for ever', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = machine()
  const now = Date.now()
  // Before its container started: as if never taken, and the same machine may take it again at once (an updated agent).
  const early = running(m, c, now, null)
  assert.equal(declineLease(early.attemptId, now + 10, 'draining', 'docker stop'), 'declined')
  const again = takeForRunner(getRunner(m.id)!, offerFor(m, c), now + 20)
  assert.equal(again[0]?.submissionId, sent.id, 'a drain before any container is no refusal')
  // After its container started: no loss, no quota — and not this machine again until the window ends.
  updateLease(again[0].attemptId, { state: 'running', acceptedAt: now + 20, startedAt: now + 25, phase: 'running' })
  assert.equal(declineLease(again[0].attemptId, now + 30, 'draining', 'colloq-host runner update --now'), 'declined')
  const row = queueRow(sent.id)!
  assert.deepEqual([row.state, row.lost], ['waiting', 0])
  assert.deepEqual(takeForRunner(getRunner(m.id)!, offerFor(m, c), now + 40), [], 'the same machine does not take it straight back')
  const other = machine()
  assert.equal(takeForRunner(other, offerFor(other, c), now + 50)[0]?.submissionId, sent.id, 'another machine does')
  assert.equal(getRunner(m.id)!.state, 'active', 'and the drains drained nothing')
  reset()
})

test('three losses within half an hour drain the machine, and the panel raises a banner until the owner looks', async () => {
  reset()
  const c = competition()
  const m = machine()
  const now = Date.now()
  for (let i = 0; i < 3; i++) {
    send(c, { at: now + i })
    const lease = running(m, c, now + i)
    loseLease(lease.attemptId, now + i + 1, 'missing')
  }
  const quarantined = getRunner(m.id)!
  assert.equal(quarantined.state, 'draining')
  assert.ok(quarantined.quarantinedAt !== null)
  assert.equal((await machinesResponse()).banner?.machineId, m.id)
  assert.equal((await machineDetail(m.id))?.state, 'quarantined')
  assert.equal((await machinesResponse()).banner, null, 'looked at: no banner')
  reset()
})

test('at boot, offers of the previous life are withdrawn, and a machine\'s row without a live lease waits again', async () => {
  reset()
  const c = competition()
  const offered = send(c, { at: 1 })
  const orphan = send(c, { at: 2 })
  const m = machine()
  const now = Date.now()
  const [lease] = takeForRunner(m, { ...offerFor(m, c), room: { ...offerFor(m, c).room, slots: 1 } }, now)
  assert.equal(lease.submissionId, offered.id)
  // A row held for a machine with no lease behind it (a hand in the database).
  assert.ok(holdQueueRow(orphan.id, m.id, now))
  const fixed = await bootRemoteRunners(now)
  assert.equal(fixed.withdrawn, 1)
  assert.equal(fixed.orphans, 1)
  assert.equal(queueRow(offered.id)?.state, 'waiting')
  assert.equal(queueRow(orphan.id)?.state, 'waiting')
  reset()
})

test('with this server\'s notebooks off, a package set that cannot fit is refused here, never leased and never stuck', () => {
  reset()
  const MiB = 1024 * 1024
  const c = competition({ memoryMb: 2048 })
  setPolicy(c.id, { enabled: true })
  const sent = send(c, { revisionId: null })
  const set = createBundle(c.id, sent.entrantId, c.revisionId, 'catboost')
  completeBundle(set.id, {
    normalizedRequirements: ['catboost'], downloadBytes: 1, installedBytes: 315 * MiB, contentHash: '3'.repeat(64),
    packages: [{ name: 'catboost', version: '1.2.10', fileName: 'catboost-1.2.10-py3-none-any.whl', sha256: '4'.repeat(64), bytes: 1 }],
    lock: `catboost==1.2.10 --hash=sha256:${'4'.repeat(64)}\n`,
  })
  bindSubmission(sent.id, c.revisionId, set.id)
  updateCompetition(c.id, { limits: { ...c.limits, memoryMb: 512 } })
  const m = machine()
  assert.deepEqual(takeForRunner(m, offerFor(m, c), Date.now()), [], 'never leased with a set that cannot fit')
  assert.equal(settleUnfit(), 1)
  return new Promise<void>((resolve) => setImmediate(() => {
    const done = getSubmission(sent.id)!
    assert.equal(done.state, 'rejected')
    assert.equal(done.stage, 'dependencies')
    assert.match(done.participantError ?? '', /379/)
    assert.equal(queueRow(sent.id), null)
    reset()
    resolve()
  }))
})

test('five declines within half an hour quarantine a machine too; its drains are no refusals', async () => {
  reset()
  const c = competition()
  const m = machine()
  const now = Date.now()
  for (let i = 0; i < 4; i++) {
    send(c, { at: now + i })
    const [lease] = takeForRunner(getRunner(m.id)!, offerFor(m, c), now + i)
    declineLease(lease.attemptId, now + i, 'draining', '')
  }
  assert.equal(getRunner(m.id)?.state, 'active', 'drains are the machine stopping, not refusing')
  for (let i = 0; i < 5; i++) {
    send(c, { at: now + 10 + i })
    const [lease] = takeForRunner(getRunner(m.id)!, offerFor(m, c), now + 10 + i)
    assert.ok(lease, `lease ${i}`)
    declineLease(lease.attemptId, now + 10 + i, 'disk', 'full')
  }
  const quarantined = getRunner(m.id)!
  assert.equal(quarantined.state, 'draining')
  assert.ok(quarantined.quarantinedAt !== null)
  reset()
})

test('an agent restart that loses every run at once is one loss, and losses before a container started are none: the machine keeps serving', () => {
  reset()
  const c = competition()
  const m = machine()
  const now = Date.now()
  // Four runs going, then the agent restarts: its first sync lists none of them.
  const held = Array.from({ length: 4 }, (_, i) => {
    send(c, { at: now + i })
    return running(m, c, now + i)
  })
  reconcileSync(getRunner(m.id)!, syncRequest({ seq: Math.max(...held.map((lease) => lease.seq)) }), now + 100)
  for (const lease of held) assert.equal(getLease(lease.attemptId)?.state, 'lost')
  assert.equal(getRunner(m.id)?.state, 'active', 'one restart is one loss, not four')
  // Three more, each lost before its container started (an image that would not pull): refunded, and no loss at all.
  for (let i = 0; i < 3; i++) {
    send(c, { at: now + 10 + i })
    const lease = running(m, c, now + 10 + i, null)
    assert.equal(loseLease(lease.attemptId, now + 200 + i, 'missing'), true)
  }
  assert.equal(getRunner(m.id)?.state, 'active', 'losses that cost no run count for nothing')
  // Two more restarts of the agent with runs going: three losses in all, and now the machine is drained.
  for (let i = 0; i < 2; i++) {
    send(c, { at: now + 20 + i })
    const lease = running(m, c, now + 20 + i)
    assert.equal(loseLease(lease.attemptId, now + 300 + i, 'missing'), true)
    assert.equal(getRunner(m.id)?.state, i === 0 ? 'active' : 'draining')
  }
  assert.ok(getRunner(m.id)?.quarantinedAt !== null)
  reset()
})

test('a submission given up on as our failure keeps no progress of the run that was lost', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const machines = [machine(), machine(), machine()]
  const now = Date.now()
  for (const [i, m] of machines.entries()) {
    const lease = running(m, c, now + i)
    // The run reported its third cell of five before its machine went.
    updateSubmission(sent.id, { stage: 'notebook', cellsDone: 3, cellsTotal: 5 })
    assert.equal(loseLease(lease.attemptId, now + i + 1, 'silent'), true)
  }
  const done = getSubmission(sent.id)!
  assert.equal(done.state, 'metricFailed')
  assert.equal(done.stage, 'queue', 'no stage of a run that was lost')
  assert.deepEqual([done.cellsDone, done.cellsTotal], [0, 0], 'and none of its cells')
  reset()
})
