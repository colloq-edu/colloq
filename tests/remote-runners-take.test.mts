/**
 * Taking work for a machine (competitions/remote/lease.ts · takeForRunner,
 * docs/architecture/remote-runners.md §5.2).
 *
 * Each rule fails quietly: a row leased to a machine that has not pulled its
 * image is a decline and a lost minute; the hidden test leased to an
 * untrusted machine is the hidden test on a stranger's VM; a take that stops
 * on the first row it cannot run leaves the rest of the queue waiting behind
 * one GPU notebook; a held sync's stale numbers lease a machine twice over;
 * a machine's card written into competition_queue.gpu takes a card from a
 * class here. And a row taken twice — by the pump and a machine, or two
 * machines — is a notebook run twice and scored once by chance.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { BOOT, enqueue, getSubmission, listRuns, queueRow, queueRows, setQueuePaused, takeNext } from '../server/src/competitions/store.js'
import { db } from '../server/src/db.js'
import { joinRunner, liveLeases, updateLease, type RunnerRow } from '../server/src/competitions/remote/store.js'
import { runnerOffer, takeForRunner, type RunnerOffer } from '../server/src/competitions/remote/lease.js'
import { dataNow } from '../server/src/competitions/remote/want.js'
import { declineLease } from '../server/src/competitions/remote/release.js'
import { FACTS, code, competition, localRevision, reset, send, syncRequest, type TestCompetition } from './_remote.mts'

useCompetitionRunner(new FakeCompetitionRunner())

function machine(options: { trusted?: boolean; approvedSlots?: number | null } = {}): RunnerRow {
  const joined = joinRunner({ code: code({ trusted: options.trusted, approvedSlots: options.approvedSlots ?? null }), joinId: randomUUID().replaceAll('-', ''), build: 'dev', facts: FACTS, address: null }, Date.now())
  assert.ok(joined.ok)
  return joined.runner
}

/** Everything of these competitions in place on the machine. */
function readyFor(...competitions: TestCompetition[]): { revisions: string[]; data: string[]; sealed: string[]; bundles: string[] } {
  const ready = { revisions: [] as string[], data: [] as string[], sealed: [] as string[], bundles: [] as string[] }
  for (const c of competitions) {
    const sets = dataNow(c.id)
    ready.revisions.push(c.revisionId)
    if (sets.open) ready.data.push(sets.open.manifest)
    if (sets.sealed) ready.sealed.push(sets.sealed.manifest)
  }
  return ready
}

function offer(runner: RunnerRow, over: { free?: Partial<ReturnType<typeof syncRequest>['free']>; ready?: ReturnType<typeof readyFor> } = {}): RunnerOffer {
  const sync = syncRequest({ free: { ...syncRequest().free, ...over.free }, ready: over.ready ?? { revisions: [], data: [], sealed: [], bundles: [] } })
  return runnerOffer(runner, sync.free, sync)
}

const take = (runner: RunnerRow, o: RunnerOffer) => takeForRunner(runner, o, Date.now())

test('a machine is leased only what it has in place: the image, the open data, and the hidden test when trusted', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = machine()
  assert.deepEqual(take(m, offer(m)), [], 'nothing ready, nothing leased')
  assert.deepEqual(take(m, offer(m, { ready: { ...readyFor(c), data: [] } })), [], 'the image alone is not enough')
  assert.deepEqual(take(m, offer(m, { ready: { ...readyFor(c), revisions: [] } })), [], 'nor the data alone')
  const leases = take(m, offer(m, { ready: readyFor(c) }))
  assert.equal(leases.length, 1)
  assert.equal(leases[0].submissionId, sent.id)
  assert.equal(queueRow(sent.id)?.holder, m.id)
  assert.equal(queueRow(sent.id)?.gpu, null)
  assert.equal(leases[0].manifest.sealed, null)
  reset()
})

test('the hidden test goes to trusted machines only, and only once its manifest is in place there', () => {
  reset()
  const c = competition({ sealed: true })
  const sent = send(c)
  const untrusted = machine()
  const trusted = machine({ trusted: true })
  const ready = readyFor(c)
  assert.deepEqual(take(untrusted, offer(untrusted, { ready })), [], 'never to an untrusted machine, whatever it says it holds')
  assert.deepEqual(take(trusted, offer(trusted, { ready: { ...ready, sealed: [] } })), [], 'nor before the hidden test is in place')
  const leases = take(trusted, offer(trusted, { ready }))
  assert.equal(leases.length, 1)
  assert.equal(leases[0].sealed, true)
  assert.ok(leases[0].manifest.sealed?.files.some((file) => file.name === 'test.csv'))
  assert.equal(getSubmission(sent.id)?.sealedInputs, true, 'blind from this run on')
  reset()
})

test('an environment only this server has, or a submission with no pin, is never leased', () => {
  reset()
  const c = competition()
  const local = localRevision('base')
  const pinnedHere = send(c, { revisionId: local.id })
  const unpinned = send(c, { revisionId: null })
  const m = machine()
  const ready = { ...readyFor(c), revisions: [c.revisionId, local.id] }
  assert.deepEqual(take(m, offer(m, { ready })), [])
  assert.equal(queueRow(pinnedHere.id)?.state, 'waiting')
  assert.equal(queueRow(unpinned.id)?.state, 'waiting')
  reset()
})

test('the take skips what it cannot run and never stops on it: the next row in the fair order is taken', () => {
  reset()
  const big = competition({ memoryMb: 16_384 })
  const small = competition()
  const first = send(big, { at: 1 })
  const second = send(small, { at: 2 })
  const m = machine()
  const leases = take(m, offer(m, { free: { memoryMb: 8192 }, ready: readyFor(big, small) }))
  assert.deepEqual(leases.map((lease) => lease.submissionId), [second.id], 'the big one does not fit; the small one behind it goes')
  assert.equal(queueRow(first.id)?.state, 'waiting')
  reset()
})

test('memory, CPUs and places are spent as rows are taken; the owner\'s cap holds', () => {
  reset()
  const c = competition({ memoryMb: 4096, cpus: 2 })
  for (let i = 0; i < 6; i++) send(c, { at: i })
  const m = machine()
  // Room for two by memory (2 × (4096 + 256) ≤ 9000 < 3 × 4352).
  assert.equal(take(m, offer(m, { free: { memoryMb: 9000, slots: 8 }, ready: readyFor(c) })).length, 2)
  const capped = machine({ approvedSlots: 1 })
  assert.equal(take(capped, offer(capped, { free: { slots: 8 }, ready: readyFor(c) })).length, 1, 'the owner\'s cap over what it offers')
  const cpus = machine()
  assert.equal(take(cpus, offer(cpus, { free: { cpus: 3, slots: 8 }, ready: readyFor(c) })).length, 1, 'two CPUs each out of three')
  reset()
})

test('a held sync\'s stale numbers cannot lease a machine twice over', () => {
  reset()
  const c = competition()
  for (let i = 0; i < 4; i++) send(c, { at: i })
  const m = machine()
  const stale = offer(m, { free: { slots: 2 }, ready: readyFor(c) })
  assert.equal(take(m, stale).length, 2)
  // The same sync, recomputed after a wake: what home leased since is not in its list, so it is not free.
  assert.equal(take(m, offer(m, { free: { slots: 2 }, ready: readyFor(c) })).length, 0)
  assert.equal(liveLeases(m.id).length, 2)
  reset()
})

test('a free card share takes the first GPU notebook before any CPU one; without shares GPU work is passed over', () => {
  reset()
  const cpu = competition()
  const gpu = competition({ gpu: true })
  const early = send(cpu, { at: 1 })
  send(gpu, { at: 2 })
  const m = machine()
  const none = take(m, offer(m, { free: { slots: 1, gpuShares: 0 }, ready: readyFor(cpu, gpu) }))
  assert.deepEqual(none.map((lease) => lease.submissionId), [early.id], 'no share: the GPU notebook is passed over')
  reset()
  const early2 = send(cpu, { at: 1 })
  const card2 = send(gpu, { at: 2 })
  const g = machine()
  const leases = take(g, offer(g, { free: { slots: 1, gpuShares: 1 }, ready: readyFor(cpu, gpu) }))
  assert.deepEqual(leases.map((lease) => lease.submissionId), [card2.id], 'a share takes the GPU notebook first')
  assert.equal(leases[0].manifest.gpu, true)
  assert.ok((leases[0].manifest.perDevice ?? 0) >= 1, 'runs per card pinned with the lease')
  assert.equal(queueRow(card2.id)?.gpu, null, 'the machine\'s card is never this server\'s')
  assert.equal(queueRow(early2.id)?.state, 'waiting')
  reset()
})

test('a metric row is never leased: the answers stay here', () => {
  reset()
  const c = competition()
  const sent = send(c)
  enqueue({ submissionId: sent.id, competitionId: c.id, entrantId: sent.entrantId, kind: 'metric' })
  const m = machine()
  assert.deepEqual(take(m, offer(m, { ready: readyFor(c) })), [])
  assert.equal(queueRow(sent.id)?.kind, 'metric')
  reset()
})

test('a paused queue leases nothing, to machines as to this server', () => {
  reset()
  const c = competition()
  send(c)
  const m = machine()
  setQueuePaused(true)
  try {
    assert.deepEqual(take(m, offer(m, { ready: readyFor(c) })), [])
  } finally {
    setQueuePaused(false)
  }
  reset()
})

test('a machine that declined a submission is not offered it again for ten minutes; another machine is', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const a = machine()
  const b = machine()
  const [lease] = take(a, offer(a, { ready: readyFor(c) }))
  assert.equal(declineLease(lease.attemptId, Date.now(), 'image', 'pull failed'), 'declined')
  assert.equal(queueRow(sent.id)?.state, 'waiting')
  assert.equal(listRuns(sent.id).length, 0, 'the unstarted run row went')
  assert.deepEqual(take(a, offer(a, { ready: readyFor(c) })), [], 'skipped by the machine that refused it')
  assert.equal(take(b, offer(b, { ready: readyFor(c) }))[0]?.submissionId, sent.id, 'taken by another')
  reset()
})

test('the fair order counts a person\'s runs wherever they run: a machine\'s run lets the others go first here', () => {
  reset({ homeNotebooks: true })
  const c = competition()
  const busy = send(c, { at: 1 })
  // The same person's second submission, sent first of the waiting ones.
  const again = send(c, { at: 2 })
  db.prepare('UPDATE submissions SET entrant_id = ? WHERE id = ?').run(busy.entrantId, again.id)
  db.prepare('UPDATE competition_queue SET entrant_id = ?, turn = 0 WHERE submission_id = ?').run(busy.entrantId, again.id)
  const other = send(c, { at: 3 })
  const m = machine()
  assert.equal(take(m, offer(m, { free: { slots: 1 }, ready: readyFor(c) }))[0]?.submissionId, busy.id)
  // Home's pump takes next: the person with a run on the machine lets the other go ahead.
  assert.equal(takeNext({ boot: BOOT, slots: 4, lane: 'notebook' })?.submissionId, other.id)
  reset()
})

test('the pump and two machines interleaved at random never take a row twice', () => {
  for (let round = 0; round < 5; round++) {
    reset({ homeNotebooks: true })
    const c = competition()
    const sent = Array.from({ length: 12 }, (_, i) => send(c, { at: i }))
    const a = machine()
    const b = machine()
    const takers: Array<() => number> = [
      () => (takeNext({ boot: BOOT, slots: 64, lane: 'notebook' }) ? 1 : 0),
      () => take(a, offer(a, { free: { slots: 1 }, ready: readyFor(c) })).length,
      () => take(b, offer(b, { free: { slots: 1 }, ready: readyFor(c) })).length,
    ]
    let taken = 0
    for (let step = 0; step < 60 && taken < sent.length; step++) taken += takers[Math.floor(Math.random() * takers.length)]()
    const rows = queueRows().filter((row) => row.competitionId === c.id)
    const attempts = rows.filter((row) => row.state === 'running').map((row) => row.attemptId)
    assert.equal(new Set(attempts).size, attempts.length, 'one attempt per row')
    for (const row of rows.filter((one) => one.state === 'running')) {
      const runs = listRuns(row.submissionId).filter((run) => run.kind === 'notebook')
      if (row.holder) assert.equal(runs.length, 1, 'a machine\'s take starts exactly one run row')
      const leases = [...liveLeases(a.id), ...liveLeases(b.id)].filter((lease) => lease.submissionId === row.submissionId)
      assert.equal(leases.length, row.holder ? 1 : 0, 'a lease exactly for the rows machines hold')
    }
    assert.equal(rows.filter((row) => row.state === 'running').length, taken)
  }
  reset()
})

test('an offer for a revoked machine\'s submission is withdrawn with the machine, and the row is free for others', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const a = machine()
  const [lease] = take(a, offer(a, { ready: readyFor(c) }))
  updateLease(lease.attemptId, { state: 'accepted', acceptedAt: Date.now() })
  const { revokeRunner } = await import('../server/src/competitions/remote/release.js')
  assert.equal(revokeRunner(a.id), true)
  assert.equal(queueRow(sent.id)?.state, 'waiting')
  assert.equal(queueRow(sent.id)?.lost, 0, 'no penalty')
  const b = machine()
  assert.equal(take(b, offer(b, { ready: readyFor(c) }))[0]?.submissionId, sent.id)
  reset()
})
