/**
 * The sync of a machine that takes classes (docs/architecture/remote-classes.md
 * §15, §6.4, §6.6, §11.1, §11.5, D3, D24; competitions/remote/{routes,
 * liveness,release,fit,want,lease,heard}.ts), against a stand-in for the
 * class placements (kernel/remote/placement.ts) plugged into the port they
 * register with (heard.ts · ClassPort). Every reply is read by the
 * agent's own parser (_remote.mts · Machine.sync).
 *
 * Each rule fails without a word. A block taken from a machine without
 * classes lets a stranger's report in; a wanted set cut short removes a
 * class's kernel, variables and all; an unclass that turns the flag off
 * before the placements move leaves classes on a machine no longer allowed to
 * hold them, and one that says nothing more leaves their containers running;
 * a hidden test leased beside a class is the test on a host whose students'
 * code can read it; a take blind to the reply's intents leases away the
 * memory a class is about to start in; a probe at the leases' pace leaves a
 * class a minute from failover with evidence half a minute old.
 */
import './_env.mts'
import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import {
  REMOTE_API_BASE,
  REMOTE_HOLD_BUSY_MS,
  REMOTE_HOLD_IDLE_MS,
  REMOTE_PROBE_MS,
  type RemoteCard,
  type RemoteSyncReply,
  type RemoteWantRevision,
} from '../shared/remote-runner.js'
import {
  CLASS_BULK_IDLE_MBPS,
  CLASS_BULK_MBPS,
  CLASS_EVIDENCE_MS,
  CLASS_PROBE_MS,
  MACHINE_PACE_MBPS,
  REMOTE_PLACEMENTS_MAX,
  remoteRevisionDigest,
  type PostmortemReading,
  type RemoteKernelRole,
  type RemoteKernelsRequest,
  type RemotePlacementHeld,
  type RemotePlacementIntent,
  type RemotePlacementPhase,
} from '../shared/remote-kernels.js'
import { TUNNEL_CLOSE } from '../shared/remote-tunnel.js'
import type { EnvironmentRevision } from '../shared/dependencies.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { getRevision } from '../server/src/dependencies/store.js'
import { listAdminEvents } from '../server/src/admin/audit-log.js'
import { updateClassMachineSettings } from '../server/src/admin/resource-settings.js'
import { getRunner, mintRemoteCode, runnerEventsOf, setRunnerClasses, updateRunner } from '../server/src/competitions/remote/store.js'
import {
  classPathEvidence,
  classPlacementsLive,
  classPort,
  classPortRegistered,
  forgetHeard,
  heardAt,
  noteCall,
  noteProbe,
  pathEvidence,
  resetHeard,
  useClassPort,
  useRemoteClock,
  type ClassFailoverCause,
  type ClassPort,
  type ClassSlotWhere,
} from '../server/src/competitions/remote/heard.js'
import { revokeRunner, unclassRunner } from '../server/src/competitions/remote/release.js'
import { syncHeldFor, syncHold } from '../server/src/competitions/remote/routes.js'
import { probeTick, resetProbeTick, startRemoteRunners, stopRemoteRunners } from '../server/src/competitions/remote/liveness.js'
import { fitCache, machineFit, rowNeeds } from '../server/src/competitions/remote/fit.js'
import { dataNow } from '../server/src/competitions/remote/want.js'
import { classShare, runnerOffer } from '../server/src/competitions/remote/lease.js'
import { heldSyncs, wakeRunner } from '../server/src/competitions/remote/wake.js'
import { MachineTunnels, useMachineTunnels } from '../server/src/kernel/remote/tunnel.js'
import { Machine, close, code, competition, localRevision, portableRevision, reset, send, serve, syncRequest, type Reply, type TestCompetition } from './_remote.mts'

useCompetitionRunner(new FakeCompetitionRunner())

/* ------------------------------------------------------- the stand-ins */

/** The class placements as the sync calls them, with what each call said kept for the test to read. */
class FakePlacements implements ClassPort {
  readonly intents = new Map<string, RemotePlacementIntent[]>()
  readonly live = new Set<string>()
  readonly where = new Map<string, ClassSlotWhere>()
  readonly postmortem = new Map<string, string[]>()
  readonly reports: Array<{ runnerId: string; kernels: RemoteKernelsRequest; now: number }> = []
  /** Each failover with the machine as it was at that moment: what "first" is read from. */
  readonly failovers: Array<{ runnerId: string; cause: ClassFailoverCause; state: string | null; classes: boolean | null; closed: number }> = []
  revisions: RemoteWantRevision[] = []
  /** How often each question of liveness was asked. */
  readonly asked = { live: 0, anyLive: 0 }

  constructor(private readonly tunnels: RecordingTunnels) {}

  clear(): void {
    this.intents.clear()
    this.live.clear()
    this.where.clear()
    this.postmortem.clear()
    this.reports.length = 0
    this.failovers.length = 0
    this.revisions = []
    this.asked.live = 0
    this.asked.anyLive = 0
  }

  wantedPlacements(runnerId: string): RemotePlacementIntent[] {
    return this.intents.get(runnerId) ?? []
  }

  noteKernelsReport(runnerId: string, kernels: RemoteKernelsRequest, now: number): void {
    this.reports.push({ runnerId, kernels, now })
  }

  hasLivePlacements(runnerId: string): boolean {
    this.asked.live++
    return this.live.has(runnerId)
  }

  anyLivePlacements(): boolean {
    this.asked.anyLive++
    return this.live.size > 0
  }

  classTick(): void {}

  failoverRunner(runnerId: string, cause: ClassFailoverCause): number {
    const row = getRunner(runnerId)
    this.failovers.push({ runnerId, cause, state: row?.state ?? null, classes: row?.classes ?? null, closed: this.tunnels.closed.length })
    const moved = this.intents.get(runnerId)?.length ?? 0
    this.intents.delete(runnerId)
    this.live.delete(runnerId)
    return moved
  }

  postmortemWanted(runnerId: string): string[] {
    return this.postmortem.get(runnerId) ?? []
  }

  classRevisionsWanted(): RemoteWantRevision[] {
    return this.revisions
  }

  tunnelWanted(runnerId: string): 'open' | 'reconnect' | 'closed' {
    return this.live.has(runnerId) ? 'open' : 'closed'
  }

  placementOf(sessionId: string, role: RemoteKernelRole): ClassSlotWhere {
    return this.where.get(`${sessionId}:${role}`) ?? { where: 'home' }
  }
}

/** The machines' tunnels, with every close the owner's actions asked for written down. */
class RecordingTunnels extends MachineTunnels {
  readonly closed: Array<{ runnerId: string; code: number }> = []

  override close(runnerId: string, code: number, reason: string): void {
    this.closed.push({ runnerId, code })
    super.close(runnerId, code, reason)
  }
}

const tunnels = new RecordingTunnels({ log: () => undefined })
const placements = new FakePlacements(tunnels)
useMachineTunnels(tunnels)
useClassPort(placements)

after(() => {
  useClassPort(null)
  useMachineTunnels(null)
  tunnels.shutdown()
  close()
})

beforeEach(() => {
  reset()
  placements.clear()
  tunnels.closed.length = 0
  resetProbeTick()
})

/* ---------------------------------------------------------------- helpers */

/** A machine joined with a code that takes classes («Принимать занятия»). */
async function classMachine(): Promise<Machine> {
  const m = new Machine(await serve())
  const classes = mintRemoteCode({ machines: 1, hours: 1, trusted: false, classes: true, approvedSlots: null, createdBy: 'tests' }).code
  assert.equal((await m.join(classes)).status, 200)
  return m
}

async function joined(options: { trusted?: boolean } = {}): Promise<Machine> {
  const m = new Machine(await serve())
  assert.equal((await m.join(code({ trusted: options.trusted }))).status, 200)
  return m
}

/** What a machine reports ready for these competitions: their images and their data. */
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

/** A placement home wants, of a portable revision as the intent pins it. */
function intent(sessionId: string, role: RemoteKernelRole, gen: number, revision: EnvironmentRevision, over: Partial<RemotePlacementIntent> = {}): RemotePlacementIntent {
  const pinned = getRevision(revision.id)!
  return {
    key: `${sessionId}:${role}`,
    gen,
    environment: pinned.environmentName,
    revision: { id: pinned.id, ref: pinned.registryRef!, layers: pinned.layers! },
    memoryMb: 2048,
    cpus: 2,
    pids: 512,
    gpu: false,
    network: 'blocked',
    blockedCidrs: [],
    token: 'c'.repeat(40),
    hashSeed: 4242,
    shm: '1g',
    ...(role === 'council' ? { workers: 4 } : {}),
    ...over,
  }
}

/** A placement as the machine's block lists it. */
function held(wanted: RemotePlacementIntent, phase: RemotePlacementPhase = 'ready'): RemotePlacementHeld {
  return {
    key: wanted.key,
    gen: wanted.gen,
    phase,
    ...(phase === 'pulling' ? {} : { container: 'd'.repeat(64) }),
    ...(phase === 'ready' ? { revision: remoteRevisionDigest(wanted.revision.ref) } : {}),
    ...(phase === 'failed' ? { failure: { unschedulable: 'other' as const } } : {}),
  }
}

/** A machine's `kernels` block, as an agent of this release sends it. */
function block(over: Partial<RemoteKernelsRequest> = {}): RemoteKernelsRequest {
  return {
    placements: [],
    reports: [],
    epochs: [],
    readings: [],
    tunnel: 'up',
    classes: { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false },
    ...over,
  }
}

const reading = (): PostmortemReading => ({ limit: 2 ** 31, peak: 2 ** 31, current: 4096, kills: 1, containerOomKilled: true, status: 'exited', exit: 137, tail: ['Killed'] })

/** Wait for something the server does on its own: counted by events, never by the clock. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5))
}

/**
 * A sync whose body comes in two halves, with `between` run once the door has
 * read the machine's row (it notes the call: heard.ts · noteCall, after a
 * forgetHeard) and before the second half is sent. The answer's status.
 */
async function syncInHalves(m: Machine, body: unknown, between: () => void): Promise<number> {
  forgetHeard(m.runnerId)
  const text = JSON.stringify(body)
  return new Promise<number>((resolve, reject) => {
    const req = http.request(new URL(`${m.home}${REMOTE_API_BASE}/sync`), {
      method: 'POST',
      headers: { authorization: `Bearer ${m.credential}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-forwarded-for': m.address },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.write(text.slice(0, 20))
    until(() => heardAt(m.runnerId) !== null).then(() => {
      between()
      req.end(text.slice(20))
    }).catch(reject)
  })
}

const keys = (m: Machine): string[] => m.last!.kernels!.placements.map((one) => `${one.key}@${one.gen}`)
const closedFor = (m: Machine): number[] => tunnels.closed.filter((one) => one.runnerId === m.runnerId).map((one) => one.code)

/* ------------------------------------------------------------------ tests */

test('the kernels block goes to a machine that takes classes and to no other, and only such a machine may send one', async () => {
  const plain = await joined()
  const classes = await classMachine()
  const first = await plain.sync()
  assert.equal(first.status, 200)
  assert.equal(plain.last!.kernels, undefined, 'a machine without classes hears nothing of them')
  // Its first sync, or an agent from before classes: no block of its own, and home's all the same.
  assert.equal((await classes.sync()).status, 200)
  assert.deepEqual(classes.last!.kernels, {
    placements: [], pushes: [], verdicts: [], pulls: [], scan: [], epochs: [], collect: [], postmortem: [],
    rates: { classBulkMBps: CLASS_BULK_IDLE_MBPS, machinePaceMBps: MACHINE_PACE_MBPS }, tunnel: 'closed',
  })
  // Its own block is taken in once, as it arrives.
  assert.equal((await classes.sync({ kernels: block() })).status, 200)
  assert.deepEqual(placements.reports.map((report) => report.runnerId), [classes.runnerId])
  // A machine without classes may send none: refused (its agent drops the block), nothing of it taken in, and without it it syncs on.
  const refused = await plain.sync({ kernels: block() })
  assert.equal(refused.status, 400)
  assert.equal((refused.body as unknown as { error: string }).error, 'invalid')
  assert.equal(placements.reports.length, 1)
  assert.equal((await plain.sync()).status, 200)
})

test('a kernels block that breaks the contract is refused with 400, and nothing of it is taken in', async () => {
  const m = await classMachine()
  const answer = await m.call('POST', 'sync', { body: { ...syncRequest(), kernels: { ...block(), placements: [{ key: 'not a key', gen: 1, phase: 'ready' }] } } })
  assert.equal(answer.status, 400)
  assert.equal(((await answer.json()) as { error: string }).error, 'invalid')
  assert.equal(placements.reports.length, 0)
})

test('a class machine is told its whole wanted set in every reply, in one order, an outdated one too, and never another machine\'s', async () => {
  const a = await classMachine()
  const b = await classMachine()
  const revision = portableRevision()
  const room = intent('class-a', 'room', 3, revision)
  const own = intent('class-a', 'own', 1, revision)
  placements.intents.set(a.runnerId, [room, own])
  placements.intents.set(b.runnerId, [intent('class-b', 'council', 1, revision)])
  await a.sync()
  assert.deepEqual(keys(a), ['class-a:own@1', 'class-a:room@3'])
  assert.deepEqual(a.last!.kernels!.placements[1], room, 'each placement whole, as home wants it')
  // A placement left out is one the machine removes: the next reply leaves it out.
  placements.intents.set(a.runnerId, [room])
  await a.sync()
  assert.deepEqual(keys(a), ['class-a:room@3'])
  // Of another build, the machine takes no new work, and its classes keep reconciling all the same.
  const outdated = await a.sync({ build: 'e'.repeat(64) })
  assert.equal(outdated.body.compatible, false)
  assert.deepEqual(keys(a), ['class-a:room@3'])
  await b.sync()
  assert.deepEqual(keys(b), ['class-b:council@1'])
})

test('what a class machine says of its classes reaches the class placements once, with the readings of the placements it holds at their gen only', async () => {
  const m = await classMachine()
  const room = intent('class-a', 'room', 3, portableRevision())
  placements.intents.set(m.runnerId, [room])
  placements.where.set('class-a:room', { where: 'machine', runnerId: m.runnerId, gen: 3 })
  placements.where.set('class-b:room', { where: 'machine', runnerId: 'zzzzzzzz', gen: 1 })
  const sent = block({
    placements: [held(room), { key: 'class-c:own', gen: 1, phase: 'stopping', container: 'f'.repeat(64) }],
    readings: [
      { key: 'class-a:room', gen: 3, reading: reading() },
      // An older gen of the same slot, a slot on another machine, one back at home: no kernel home has.
      { key: 'class-a:room', gen: 2, reading: reading() },
      { key: 'class-b:room', gen: 1, reading: reading() },
      { key: 'class-c:own', gen: 1, reading: reading() },
    ],
    bye: 'stopping',
  })
  assert.equal((await m.sync({ state: 'draining', kernels: sent })).status, 200)
  assert.equal(placements.reports.length, 1)
  const [report] = placements.reports
  assert.deepEqual(report.kernels.readings.map((entry) => `${entry.key}@${entry.gen}`), ['class-a:room@3'])
  assert.deepEqual(report.kernels.placements, sent.placements, 'the held placements go through whatever their gen')
  assert.deepEqual([report.kernels.bye, report.kernels.tunnel, report.kernels.classes], [sent.bye, sent.tunnel, sent.classes])
})

test('a machine is heard on the machines’ clock, the one the class clock runs on: its call, its sync and its kernels block', async () => {
  const m = await classMachine()
  // An hour ahead of the wall, as an end-to-end home's clock is once moved on: a machine that keeps syncing is not an hour silent.
  const at = Date.now() + 3_600_000
  useRemoteClock({ now: () => at })
  try {
    assert.equal((await m.sync({ kernels: block() })).status, 200)
    assert.equal(heardAt(m.runnerId), at, 'heard when it called, on that clock')
    assert.equal(placements.reports.at(-1)?.now, at, 'and its block taken in on it')
  } finally {
    useRemoteClock(null)
  }
  assert.equal((await m.sync({ kernels: block() })).status, 200)
  assert.ok(Math.abs(placements.reports.at(-1)!.now - Date.now()) < 60_000, 'the wall’s again')
})

test('an agent from before classes on a class machine still syncs: no block of its own, and its leases flow', async () => {
  const c = competition()
  const sent = send(c)
  const m = await classMachine()
  const r = await m.sync({ ready: readyFor(c) })
  assert.equal(r.status, 200)
  assert.equal(r.body.leases[0]?.submissionId, sent.id)
  assert.ok(r.body.kernels, 'the block is there for an agent that reads it, and dropped by one that does not')
  assert.equal(placements.reports.length, 0)
})

test('a machine with a class placement is held at most REMOTE_HOLD_BUSY_MS, listed in its block or not yet', { timeout: 15_000 }, async () => {
  const m = await classMachine()
  const runner = getRunner(m.runnerId)!
  const idle = syncRequest({ holdMs: REMOTE_HOLD_IDLE_MS })
  assert.equal(syncHold(idle, runner), REMOTE_HOLD_IDLE_MS)
  // A placement home holds there that the machine's block does not say yet: its next sync comes within the busy hold.
  placements.live.add(m.runnerId)
  assert.equal(syncHold(idle, runner), REMOTE_HOLD_BUSY_MS)
  assert.equal(syncHold(idle, { ...runner, classes: false }), REMOTE_HOLD_IDLE_MS, 'a machine without classes holds none of them')
  // The hold its sync is given there, woken by news rather than waited out.
  await m.sync()
  const holding = heldSyncs()
  const busy = m.sync({ holdMs: REMOTE_HOLD_IDLE_MS })
  await until(() => heldSyncs() > holding)
  assert.equal(syncHeldFor(m.runnerId), REMOTE_HOLD_BUSY_MS)
  placements.intents.set(m.runnerId, [intent('class-a', 'room', 1, portableRevision())])
  wakeRunner(m.runnerId)
  assert.equal((await busy).status, 200)
  placements.live.clear()
  placements.intents.clear()
  await m.sync()
  const quiet = m.sync({ holdMs: REMOTE_HOLD_IDLE_MS })
  await until(() => heldSyncs() > holding)
  assert.equal(syncHeldFor(m.runnerId), REMOTE_HOLD_IDLE_MS, 'with nothing of its classes live, the idle hold')
  placements.intents.set(m.runnerId, [intent('class-b', 'room', 1, portableRevision())])
  wakeRunner(m.runnerId)
  assert.equal((await quiet).status, 200)
  const listing = { ...syncRequest({ holdMs: REMOTE_HOLD_BUSY_MS }), kernels: block({ placements: [held(intent('class-a', 'own', 1, portableRevision()))] }) }
  assert.equal(syncHold(listing, runner), REMOTE_HOLD_BUSY_MS)
  assert.equal(syncHold(syncRequest({ holdMs: 400 }), runner), 400, 'never longer than the machine allows')
})

test('a change of the wanted set answers a class machine\'s held sync at once', { timeout: 15_000 }, async () => {
  const m = await classMachine()
  await m.sync({ kernels: block() })
  const arrived = placements.reports.length
  const holding = heldSyncs()
  // Nothing held: the idle hold, twenty-five seconds, longer than this test may take.
  const waiting = m.sync({ kernels: block(), holdMs: REMOTE_HOLD_IDLE_MS })
  await until(() => heldSyncs() > holding)
  placements.intents.set(m.runnerId, [intent('class-a', 'room', 1, portableRevision())])
  wakeRunner(m.runnerId)
  assert.equal((await waiting).status, 200)
  assert.deepEqual(keys(m), ['class-a:room@1'])
  assert.equal(placements.reports.length, arrived + 1, 'the block was taken in at its arrival, and not again at the recompute')
})

test('the placements a reply asks for take their share of the machine before any lease (D24)', async () => {
  const c = competition({ memoryMb: 4096 })
  const sent = send(c)
  const m = await classMachine()
  const room = intent('class-a', 'room', 1, portableRevision(), { memoryMb: 6144 })
  placements.intents.set(m.runnerId, [room])
  const free = { slots: 4, memoryMb: 8192, cpus: 16, gpuShares: 0, diskMb: 100_000 }
  // The class has not started there yet: the memory its machine calls free is the class's, and no lease takes it.
  let r = await m.sync({ ready: readyFor(c), free, kernels: block() })
  assert.deepEqual(r.body.leases, [])
  assert.deepEqual(keys(m), ['class-a:room@1'])
  // A placement failed and down is out of the machine's own count again.
  r = await m.sync({ ready: readyFor(c), free, kernels: block({ placements: [held(room, 'failed')] }) })
  assert.deepEqual(r.body.leases, [])
  // Listed at its gen, it is in the machine's count already: the rest is the submissions'.
  r = await m.sync({ ready: readyFor(c), free, kernels: block({ placements: [held(room, 'starting')] }) })
  assert.equal(r.body.leases[0]?.submissionId, sent.id)
  // An outcome's take builds no reply: it leaves room for what the machine was last told to hold.
  const told = { ...syncRequest({ free }), kernels: block() }
  const runner = getRunner(m.runnerId)!
  assert.equal(runnerOffer(runner, free, told, []).room.memoryMb - runnerOffer(runner, free, told).room.memoryMb, 6144 + 256)
  // A new gen is a placement the machine has not counted; a GPU room's card is counted only once its entry at its gen names one.
  const gpu = intent('class-g', 'room', 2, portableRevision('base-gpu'), { gpu: true, memoryMb: 1024, cpus: 1 })
  const carded = { ...held(gpu), card: { device: '0', usedMb: null } }
  assert.deepEqual(classShare([gpu], { kernels: block({ placements: [{ ...carded, gen: 1 }] }) }), { memoryMb: 1024 + 256, cpus: 1, cards: 1 })
  assert.deepEqual(classShare([gpu], { kernels: block({ placements: [held(gpu)] }) }), { memoryMb: 0, cpus: 0, cards: 1 })
  assert.deepEqual(classShare([gpu], { kernels: block({ placements: [carded] }) }), { memoryMb: 0, cpus: 0, cards: 0 })
})

test('a GPU class room keeps a whole card from GPU submissions until its start holds one (D24, §6.5)', async () => {
  const c = competition({ gpu: true, memoryMb: 1024, cpus: 1 })
  send(c)
  send(c)
  const m = await classMachine()
  updateRunner(m.runnerId, { perDevice: 2 })
  const room = intent('class-g', 'room', 1, portableRevision('base-gpu'), { gpu: true, memoryMb: 1024, cpus: 1 })
  placements.intents.set(m.runnerId, [room])
  const card = (device: string, busyShares: number): RemoteCard => ({ device, name: 'RTX 4090', memoryMb: 24_564, perDevice: 2, busyShares })
  const gpuLeases = async (cards: RemoteCard[], listed: RemotePlacementHeld[]): Promise<number> => {
    const free = { slots: 4, memoryMb: 60_000, cpus: 16, gpuShares: cards.reduce((sum, one) => sum + 2 - one.busyShares, 0), diskMb: 100_000 }
    const r: Reply<RemoteSyncReply> = await m.sync({ ready: readyFor(c), free, cards, kernels: block({ placements: listed }) })
    assert.equal(r.status, 200)
    return r.body.leases.filter((lease) => lease.gpu).length
  }
  // Its image still pulling, the room holds no card yet and the machine reports its one card free: the card is the room's all the same.
  assert.equal(await gpuLeases([card('0', 0)], [held(room, 'pulling')]), 0)
  // Asked for in this very reply, with the free shares over two cards: a run would go to the least loaded, the only whole one.
  assert.equal(await gpuLeases([card('0', 1), card('1', 0)], []), 0)
  // Two whole cards: the room's, and one more that takes one run and not the next, which would land on the room's.
  assert.equal(await gpuLeases([card('0', 0), card('1', 0)], [held(room, 'starting')]), 1)
})

test('no hidden test beside classes: machineFit refuses it, the take leases none, the want names none (D3)', async () => {
  const c = competition({ sealed: true })
  const row = send(c)
  const read = rowNeeds({ competitionId: c.id, submissionId: row.id }, fitCache())
  assert.ok(read.ok)
  const sets = dataNow(c.id)
  const everything = {
    ready: { revisions: new Set([c.revisionId]), data: new Set([sets.open!.manifest]), sealed: new Set([sets.sealed!.manifest]) },
    trusted: true,
    cards: false,
    room: { memoryMb: 65_536, cpus: 32, gpuShares: 0, diskMb: 100_000 },
  }
  assert.equal(machineFit(read.needs, everything), null)
  assert.equal(machineFit(read.needs, { ...everything, classes: true }), 'trusted', 'the second lock, whatever the trust')
  // A trusted machine on which a class placement still lives (classes off a moment ago, their containers going).
  const m = await joined({ trusted: true })
  placements.live.add(m.runnerId)
  let r = await m.sync({ ready: readyFor(c) })
  assert.deepEqual(r.body.leases, [])
  assert.equal(r.body.want.data.some((entry) => entry.sealed), false, 'and no hidden data to fetch')
  placements.live.clear()
  r = await m.sync({ ready: readyFor(c) })
  assert.equal(r.body.leases[0]?.submissionId, row.id, 'with the classes gone it takes the hidden test again')
  assert.equal(r.body.want.data.some((entry) => entry.sealed), true)
})

test('a trusted machine whose own sync lists a class container winds it down, and gets no hidden test until it lists none (D3)', async () => {
  const c = competition({ sealed: true })
  const row = send(c)
  // Trusted, never taking classes, no placement of home's on it: only its own block says what it holds (a restart of home between, a hand-edited row).
  const m = await joined({ trusted: true })
  const container = { key: 'class-a:room', gen: 3, phase: 'starting' as const, container: 'd'.repeat(64) }
  let r = await m.sync({ ready: readyFor(c), kernels: block({ placements: [container] }) })
  assert.equal(r.status, 200)
  assert.deepEqual([m.last!.kernels?.placements, m.last!.kernels?.tunnel], [[], 'closed'], 'told to hold none')
  assert.deepEqual(r.body.leases, [])
  assert.equal(m.last!.want.data.some((entry) => entry.sealed), false, 'and no hidden data to fetch beside it')
  assert.equal(getRunner(m.runnerId)!.classesWindingDown, true)
  assert.equal(placements.reports.length, 0, 'none of it reaches the class placements')
  // Its container gone, its block says so: the wind-down is over, and the hidden test is its again.
  r = await m.sync({ ready: readyFor(c), kernels: block() })
  assert.equal(r.status, 200)
  assert.equal(r.body.leases[0]?.submissionId, row.id)
  assert.equal(m.last!.kernels, undefined)
})

test('the revisions of classes set to machines join a class machine\'s want: portable ones only, a GPU kernel only with cards', async () => {
  const cpu = portableRevision('base')
  const gpu = portableRevision('base-gpu')
  const local = localRevision('base')
  const wanted = (revision: EnvironmentRevision, isGpu: boolean): RemoteWantRevision => {
    const pinned = getRevision(revision.id)!
    return { id: pinned.id, ref: pinned.registryRef ?? `colloq-revision:${pinned.id}`, layers: pinned.layers ?? 'none', gpu: isGpu }
  }
  placements.revisions = [wanted(cpu, false), wanted(gpu, true), wanted(local, false)]
  const m = await classMachine()
  const plain = await joined()
  const asked = (machine: Machine) => machine.last!.want.revisions.map((one) => one.id)
  await m.sync()
  assert.ok(asked(m).includes(cpu.id), 'pulled before the bell')
  assert.ok(!asked(m).includes(gpu.id), 'no GPU kernel where there is no card')
  assert.ok(!asked(m).includes(local.id), 'a revision built here runs here only')
  await m.sync({ cards: [{ device: '0', name: 'RTX 4090', memoryMb: 24_564, perDevice: 1, busyShares: 0 }] })
  assert.equal(m.last!.want.revisions.find((one) => one.id === gpu.id)?.gpu, true)
  await plain.sync()
  assert.ok(!asked(plain).includes(cpu.id), 'a machine without classes is asked for no class\'s image')
})

test('turning a machine\'s classes off moves every placement first, then turns the flag off, says so, closes the tunnel, and tells the machine to hold none until it holds none', { timeout: 15_000 }, async () => {
  const m = await classMachine()
  const room = intent('class-a', 'room', 2, portableRevision())
  placements.intents.set(m.runnerId, [room])
  await m.sync({ kernels: block() })
  assert.deepEqual(keys(m), ['class-a:room@2'])
  // Its next sync is held when the owner turns its classes off: answered at once, with nothing to hold.
  const holding = heldSyncs()
  const waiting = m.sync({ kernels: block(), holdMs: REMOTE_HOLD_IDLE_MS })
  await until(() => heldSyncs() > holding)
  const done = unclassRunner(m.runnerId)
  assert.ok(!('refused' in done))
  assert.deepEqual([done.changed, done.moved], [true, 1])
  // The placements first, while the machine still took classes and its tunnel was open.
  assert.deepEqual(placements.failovers.map((one) => [one.cause, one.classes, one.closed]), [['unclassed', true, 0]])
  assert.equal(getRunner(m.runnerId)!.classes, false)
  assert.deepEqual(runnerEventsOf(m.runnerId, ['unclassed'], 0).map((line) => line.detail), ['moved 1'])
  assert.deepEqual(closedFor(m), [TUNNEL_CLOSE.forbidden])
  assert.equal((await waiting).status, 200)
  assert.deepEqual([m.last!.kernels!.placements, m.last!.kernels!.tunnel], [[], 'closed'])
  // Its containers going: each sync that lists one hears the same, and none of it reaches the class placements.
  const reports = placements.reports.length
  await m.sync({ kernels: block({ placements: [held(room, 'stopping')] }) })
  assert.deepEqual(m.last!.kernels!.placements, [])
  // An agent that restarted meanwhile says nothing of its classes in its first sync: it is told all the same.
  await m.sync()
  assert.deepEqual(m.last!.kernels!.placements, [])
  // All gone: the wind-down ends, the machine hears nothing of classes again, and a block from it after that is refused.
  await m.sync({ kernels: block() })
  assert.equal(m.last!.kernels, undefined)
  assert.equal((await m.sync({ kernels: block() })).status, 400)
  assert.equal(placements.reports.length, reports)
  assert.equal(getRunner(m.runnerId)!.state, 'active', 'its submissions go on')
})

test('an owner\'s click while a sync\'s body is on its way counts for that sync, and the wind-down outlives a restart of home and of the agent', { timeout: 15_000 }, async () => {
  const m = await classMachine()
  const room = intent('class-a', 'room', 1, portableRevision())
  placements.intents.set(m.runnerId, [room])
  await m.sync({ kernels: block() })
  const reports = placements.reports.length
  // The door read the row with classes on; the owner turns them off before the rest of the body, which lists the room's container.
  const listing = { ...syncRequest(), kernels: block({ placements: [held(room)] }) }
  const click: { unclassed?: ReturnType<typeof unclassRunner> } = {}
  assert.equal(await syncInHalves(m, listing, () => (click.unclassed = unclassRunner(m.runnerId))), 200)
  assert.ok(click.unclassed && !('refused' in click.unclassed) && click.unclassed.changed)
  assert.equal(placements.reports.length, reports, 'its block reached no class placement: by then the machine took no classes')
  assert.equal(getRunner(m.runnerId)!.classesWindingDown, true)
  // Home restarts, then the agent: its first sync says nothing of the container it adopted, and it is told to hold none.
  resetHeard(Date.now() - 10 * 60_000)
  await m.sync()
  assert.deepEqual([m.last!.kernels?.placements, m.last!.kernels?.tunnel], [[], 'closed'])
  // Its classes back on, then revoked while a body is on its way: refused as its next call would be, and nothing of it taken in.
  assert.ok(!('refused' in setRunnerClasses(m.runnerId, true)))
  assert.equal(await syncInHalves(m, listing, () => revokeRunner(m.runnerId)), 401)
  assert.equal(placements.reports.length, reports)
  assert.equal(heardAt(m.runnerId), null, 'its call heard no more than the revoke forgot it')
})

test('a revoke moves every placement first, then closes the tunnel with 4401, and the machine is refused from then on', async () => {
  const m = await classMachine()
  placements.intents.set(m.runnerId, [intent('class-a', 'own', 1, portableRevision())])
  placements.live.add(m.runnerId)
  assert.equal(revokeRunner(m.runnerId), true)
  assert.deepEqual(placements.failovers.map((one) => [one.cause, one.state, one.closed]), [['revoked', 'active', 0]])
  assert.deepEqual(closedFor(m), [TUNNEL_CLOSE.unauthorized])
  assert.equal((await m.sync()).status, 401)
})

test('a machine that leaves has its classes moved first, and its tunnel closed', async () => {
  const m = await classMachine()
  placements.intents.set(m.runnerId, [intent('class-a', 'room', 1, portableRevision())])
  const r = await m.sync({ state: 'leaving', kernels: block({ bye: 'leaving' }) })
  assert.equal(r.status, 200)
  assert.deepEqual(placements.failovers.map((one) => [one.cause, one.state]), [['leaving', 'active']])
  assert.equal(placements.reports[0]?.kernels.bye, 'leaving', 'its bye heard before it went')
  assert.equal(getRunner(m.runnerId)!.state, 'left')
  assert.deepEqual(closedFor(m), [TUNNEL_CLOSE.unauthorized])
})

test('a reply asks each post-mortem once, paces by the class rates, and a placement that breaks the contract is home\'s 500, never cut out of the set', async () => {
  const m = await classMachine()
  placements.postmortem.set(m.runnerId, ['class-a:room', 'class-a:room', 'not a key'])
  await m.sync()
  assert.deepEqual(m.last!.kernels!.postmortem, ['class-a:room'])
  assert.equal(m.last!.kernels!.rates.classBulkMBps, CLASS_BULK_IDLE_MBPS)
  // Any class live on any machine: every class machine's bulk slows to the classes' rate.
  const other = await classMachine()
  placements.live.add(other.runnerId)
  await m.sync()
  assert.deepEqual(m.last!.kernels!.rates, { classBulkMBps: CLASS_BULK_MBPS, machinePaceMBps: MACHINE_PACE_MBPS })
  updateClassMachineSettings({ classBulkMBps: 3 })
  try {
    await m.sync()
    assert.equal(m.last!.kernels!.rates.classBulkMBps, 3, 'the owner\'s «Файлы занятий»')
  } finally {
    updateClassMachineSettings({ classBulkMBps: null })
  }
  const revision = portableRevision()
  placements.intents.set(m.runnerId, Array.from({ length: REMOTE_PLACEMENTS_MAX + 1 }, (_, i) => intent(`class-${i}`, 'room', 1, revision)))
  const errors = console.error
  console.error = () => undefined
  try {
    const broken = await m.sync()
    assert.equal(broken.status, 500, 'a block the agent would refuse is never sent, and never trimmed into removals')
  } finally {
    console.error = errors
  }
})

test('the owner\'s log says whether an enrolled machine takes classes', async () => {
  const classes = await classMachine()
  const plain = await joined()
  const detailOf = (m: Machine) => listAdminEvents({ limit: 50 }).events.find((event) => event.action === 'runner.enrolled' && event.target?.id === m.runnerId)?.detail
  assert.equal(detailOf(classes)?.classes, true)
  assert.equal(detailOf(plain)?.classes, false)
})

test('home probes its own path every five seconds while a class placement lives, every thirty otherwise, one probe at a time', async () => {
  const m = await classMachine()
  let probes = 0
  let finish: (ok: boolean) => void = () => undefined
  const probe = (): Promise<boolean> => {
    probes++
    return new Promise((resolve) => (finish = resolve))
  }
  const settle = async (): Promise<void> => {
    finish(true)
    await new Promise((resolve) => setImmediate(resolve))
  }
  const t0 = 1_900_000_000_000
  assert.equal(probeTick(t0, probe), true)
  assert.equal(probeTick(t0 + REMOTE_PROBE_MS, probe), false, 'never two at once')
  await settle()
  assert.equal(probeTick(t0 + REMOTE_PROBE_MS - CLASS_PROBE_MS, probe), false, 'no class lives: the leases\' pace')
  // The interval's beats are the event loop's: by Date.now() one comes a millisecond early now and then, and still probes.
  assert.equal(probeTick(t0 + REMOTE_PROBE_MS - 1, probe), true)
  await settle()
  placements.live.add(m.runnerId)
  assert.equal(probeTick(t0 + REMOTE_PROBE_MS - 1 + CLASS_PROBE_MS - 1, probe), true)
  await settle()
  assert.equal(probes, 3)
})

test('the probe\'s clock beats at the classes\' pace from the start: a probe each beat while a class lives, each sixth otherwise', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  const probes: number[] = []
  startRemoteRunners({
    probe: async (now) => {
      probes.push(now)
      return true
    },
  })
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  const beats = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      t.mock.timers.tick(CLASS_PROBE_MS)
      await flush()
    }
  }
  try {
    await flush()
    assert.equal(probes.length, 1, 'one at the start')
    await beats(REMOTE_PROBE_MS / CLASS_PROBE_MS - 1)
    assert.equal(probes.length, 1, 'no class lives: none before the leases\' thirty seconds')
    await beats(1)
    assert.equal(probes.length, 2)
    placements.live.add('a class machine')
    await beats(3)
    assert.equal(probes.length, 5)
  } finally {
    stopRemoteRunners()
  }
})

test('whether a class lives anywhere is one question of the class placements, not one a machine', async () => {
  await classMachine()
  await classMachine()
  placements.live.add('elsewhere')
  placements.asked.live = 0
  placements.asked.anyLive = 0
  assert.equal(classPlacementsLive(), true)
  assert.deepEqual(placements.asked, { live: 0, anyLive: 1 })
})

test('a class counts path evidence for fifteen seconds, where a lease counts it for a minute', () => {
  const t0 = Date.now()
  resetHeard(t0 - 10 * 60_000)
  noteCall('witness1', t0, null)
  assert.equal(classPathEvidence(t0 + CLASS_EVIDENCE_MS), true)
  assert.equal(classPathEvidence(t0 + CLASS_EVIDENCE_MS + 1), false)
  assert.equal(pathEvidence(t0 + CLASS_EVIDENCE_MS + 1), true, 'the same call is a lease\'s evidence for a minute')
  assert.equal(classPathEvidence(t0 + 1000, 'witness1'), false, 'never a machine\'s own word for its own silence')
  noteProbe(true, t0 + 30_000)
  assert.equal(classPathEvidence(t0 + 30_000 + CLASS_EVIDENCE_MS), true, 'the probe as much as a call')
  assert.equal(classPathEvidence(t0 + 30_000 + CLASS_EVIDENCE_MS + 1), false)
})

test('a class machine\'s sync loads kernel/remote/placement.ts as the class port before it answers', async (t) => {
  const module = new URL('../server/src/kernel/remote/placement.ts', import.meta.url)
  if (!fs.existsSync(module)) return t.skip('kernel/remote/placement.ts is not there yet')
  useClassPort(null)
  try {
    const plain = await joined()
    await plain.sync()
    assert.equal(classPortRegistered(), false, 'a machine without classes needs none of it')
    const m = await classMachine()
    assert.equal((await m.sync()).status, 200)
    assert.equal(classPortRegistered(), true, 'loaded before the reply was built: the empty port would have told the machine to remove every class')
    const real = (await import(module.href)) as ClassPort
    assert.equal(classPort().wantedPlacements, real.wantedPlacements, 'the module\'s own functions, by the port\'s names')
    assert.equal(classPort().anyLivePlacements(), false, 'and the question of all machines, of the placements\' table')
  } finally {
    useClassPort(placements)
  }
})
