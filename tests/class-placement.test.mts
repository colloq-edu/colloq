/**
 * Where a class's slots run (docs/architecture/remote-classes.md §6, §11):
 * the chooser and its every filter, the ensure over the sync, the state of a
 * placement on the class clock, failover and the quarantine, the setting and
 * who may change it, and the pool's early branches — on a clock and tunnels
 * the test moves by hand.
 *
 * Every rule here fails quietly when it breaks. A machine that is not
 * eligible gets a class and its students wait three minutes for a kernel
 * that never starts; a silence that is home's own road fails a whole fleet
 * over and costs every class its variables; a report of an older gen
 * flips a newer placement's state; a token that does not change with the gen
 * opens the next placement to the machine that held the last one.
 *
 * No Docker, no agent, no tunnel: the agent's half is its reports (the
 * contract's shapes, its intents read back by the agent's own parser), the
 * tunnel's half a fake that says up or down.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { tr } from '../shared/i18n.js'
import {
  CLASS_PLACEMENT_BOUNDS,
  CLASS_PLACEMENT_DEFAULT,
  CLASS_PLACEMENT_PRESETS,
  STAFF_COOKIE,
  classPlacementPreset,
  readClassPlacement,
  type ClassPlacement,
} from '../shared/admin.js'
import {
  CLASS_BYE_GRACE_MS,
  CLASS_FAILOVER_SEC,
  CLASS_START_MS,
  CLASS_TUNNEL_STUCK_MS,
  CLASS_UNREACHABLE_NOTE_MS,
  COUNCIL_WORKERS,
  COUNCIL_WORKER_BASE_MB,
  REMOTE_PLACEMENTS_MAX,
  parseRemoteKernelsReply,
  remoteRevisionDigest,
  type RemoteClassFacts,
  type RemoteKernelsRequest,
  type RemotePlacementHeld,
} from '../shared/remote-kernels.js'
import { REMOTE_BOOT_GRACE_MS, type RemoteCard, type RemoteSyncRequest } from '../shared/remote-runner.js'
import type { TunnelClock } from '../shared/remote-tunnel.js'
import type { KernelLink } from '../server/src/kernel/jupyter.js'
import { db, createSession, sessionPlacement, setSessionPlacement } from '../server/src/db.js'
import { getRevision } from '../server/src/dependencies/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, oldestOwner, rotateLinkKey } from '../server/src/admin/store.js'
import { addRoomTeacher } from '../server/src/admin/access.js'
import { classMachineSettings, parseClassMachinePatch, updateClassMachineSettings } from '../server/src/admin/resource-settings.js'
import {
  getRunner,
  insertLease,
  joinRunner,
  mintRemoteCode,
  resumeRunnerClasses,
  runnerEventsOf,
  updateRunner,
  type LeaseManifest,
  type RunnerRow,
} from '../server/src/competitions/remote/store.js'
import { noteCall, noteProbe, noteSync, resetHeard } from '../server/src/competitions/remote/heard.js'
import {
  ClassPlacements,
  PlacementLost,
  onPlacementChange,
  placementClock,
  placementCurrent,
  placementToken,
  usePlacements,
  type PlacementEvent,
  type PlacementTunnels,
} from '../server/src/kernel/remote/placement.js'
import { classPlacement, livePlacement, machinePlaced, placementRow, writePlacement } from '../server/src/kernel/remote/placement-store.js'
import { applyMemoryLimit, dropRoomKernel, endpointForSession, listRoomKernels, runningKernelLimits } from '../server/src/kernel/pool.js'
import { containerCensus } from '../server/src/kernel/usage.js'
import { FACTS, close, localRevision, portableRevision, serve, syncRequest } from './_remote.mts'

after(() => {
  usePlacements(null)
  close()
})

/* -------------------------------------------------------------- the rig */

/** A clock the test moves: timers run when it passes them, never on their own. */
class FakeClock implements TunnelClock {
  t = Date.now()
  private next = 1
  private readonly timers = new Map<number, { at: number; run: () => void }>()
  now(): number {
    return this.t
  }
  setTimeout(run: () => void, ms: number): unknown {
    const id = this.next++
    this.timers.set(id, { at: this.t + ms, run })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }
  advance(ms: number): void {
    this.t += ms
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.t) continue
      this.timers.delete(id)
      timer.run()
    }
  }
}

/** The tunnels as a placement reads them: up or down by the test's word, listeners that are only numbers. */
class FakeTunnels implements PlacementTunnels {
  readonly state = new Map<string, { up: boolean; since: number }>()
  readonly rtts = new Map<string, number>()
  readonly lostIds: string[] = []
  readonly listening = new Map<string, { port: number; closed: boolean }>()
  private readonly changes = new Set<(runnerId: string, up: boolean) => void>()
  private port = 41000
  constructor(private readonly clock: FakeClock) {}
  set(runnerId: string, up: boolean): void {
    this.state.set(runnerId, { up, since: this.clock.now() })
    for (const listener of [...this.changes]) listener(runnerId, up)
  }
  isUp(runnerId: string): boolean {
    return this.state.get(runnerId)?.up === true
  }
  since(runnerId: string): number {
    return this.state.get(runnerId)?.since ?? 0
  }
  rtt(runnerId: string): { ewmaMs: number | null; p95Ms: number | null } {
    const ms = this.rtts.get(runnerId) ?? null
    return { ewmaMs: ms, p95Ms: ms }
  }
  onChange(listener: (runnerId: string, up: boolean) => void): () => void {
    this.changes.add(listener)
    return () => this.changes.delete(listener)
  }
  async listen(runnerId: string, key: string, gen: number): Promise<{ port: number; close(): void }> {
    const id = `${runnerId}|${key}|${gen}`
    let found = this.listening.get(id)
    if (!found || found.closed) {
      found = { port: this.port++, closed: false }
      this.listening.set(id, found)
    }
    const listener = found
    return { port: listener.port, close: () => (listener.closed = true) }
  }
  link(runnerId: string, key: string, gen: number): KernelLink {
    const tunnels = this
    const id = `${runnerId}|${key}|${gen}`
    return {
      get up() {
        return tunnels.isUp(runnerId) && !tunnels.lostIds.includes(id)
      },
      rttMs: null,
      since: 0,
      next: async () => (tunnels.lostIds.includes(id) ? 'lost' : 'up'),
    }
  }
  lost(runnerId: string, key: string, gen: number): void {
    this.lostIds.push(`${runnerId}|${key}|${gen}`)
  }
}

const GOOD: RemoteClassFacts = { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false }
const C1 = 'a'.repeat(64)
const C2 = 'b'.repeat(64)

/** A macrotask after every microtask: an ensure's awaits have all run by then. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

let seq = 0

class Rig {
  readonly clock = new FakeClock()
  readonly tunnels = new FakeTunnels(this.clock)
  // Read back: the helper hands over the row as it was before its image was noted.
  readonly revision = getRevision(portableRevision('base').id)!
  readonly gpu = getRevision(portableRevision('base-gpu').id)!
  readonly events: PlacementEvent[] = []
  readonly placements: ClassPlacements

  constructor(options: { boot?: number } = {}) {
    db.prepare('DELETE FROM remote_placements').run()
    db.prepare("UPDATE remote_runners SET state = 'revoked' WHERE state IN ('active', 'draining')").run()
    db.prepare("UPDATE remote_leases SET state = 'revoked' WHERE state IN ('offered', 'accepted', 'running', 'applying')").run()
    db.prepare('DELETE FROM remote_events').run()
    // The boot grace is a rule of its own: a test that means a silence starts well past it.
    resetHeard(options.boot ?? this.clock.now() - 10 * 60_000)
    this.placements = new ClassPlacements({
      clock: this.clock,
      tunnels: this.tunnels,
      revisionOf: async (environment) => (environment === 'base-gpu' ? this.gpu : environment === 'base' ? this.revision : null),
      log: () => undefined,
    })
    usePlacements(this.placements)
    this.placements.onPlacementChange((event) => this.events.push(event))
  }

  /** A machine that takes classes, synced, its facts good, its tunnel up and its image ready unless told otherwise. */
  machine(options: { name?: string; free?: Partial<RemoteSyncRequest['free']>; cards?: RemoteCard[]; ready?: string[]; fetching?: RemoteSyncRequest['fetching']; facts?: Partial<RemoteClassFacts>; up?: boolean; rtt?: number } = {}): RunnerRow {
    const code = mintRemoteCode({ machines: 1, hours: 1, trusted: false, classes: true, approvedSlots: null, namePrefix: options.name ?? `m${++seq}`, createdBy: 'tests' }).code
    const joined = joinRunner({ code, joinId: randomUUID().replaceAll('-', ''), build: 'dev', facts: FACTS, address: null }, this.clock.now())
    assert.ok(joined.ok)
    this.sync(joined.runner, {
      free: { slots: 4, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000, ...options.free },
      cards: options.cards ?? [],
      ready: { revisions: options.ready ?? [this.revision.id, this.gpu.id], data: [], sealed: [], bundles: [] },
      fetching: options.fetching ?? [],
    })
    this.report(joined.runner, { classes: { ...GOOD, ...options.facts } })
    if (options.up !== false) this.tunnels.set(joined.runner.id, true)
    if (options.rtt !== undefined) this.tunnels.rtts.set(joined.runner.id, options.rtt)
    return getRunner(joined.runner.id)!
  }

  sync(runner: RunnerRow, over: Partial<RemoteSyncRequest> = {}): void {
    noteSync(runner.id, syncRequest({ free: { slots: 4, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 }, ready: { revisions: [this.revision.id, this.gpu.id], data: [], sealed: [], bundles: [] }, ...over }), this.clock.now(), null)
  }

  report(runner: RunnerRow, over: Partial<RemoteKernelsRequest> = {}): void {
    this.placements.noteKernelsReport(runner.id, { placements: [], reports: [], epochs: [], readings: [], tunnel: 'up', classes: GOOD, ...over }, this.clock.now())
  }

  /** A class set to machines as the test says, on `environment`. */
  room(placement: Partial<ClassPlacement> = {}, environment = 'base'): string {
    const id = `cls${++seq}${randomUUID().slice(0, 6)}`
    createSession(id, `Class ${seq}`, environment)
    setSessionPlacement(id, { ...CLASS_PLACEMENT_DEFAULT, room: 'machines', own: 'machines', ...placement })
    return id
  }

  /** An ensure started and run up to the moment it waits for the machine (wrapped: an awaited promise would be waited for). */
  async place(sessionId: string, role: 'room' | 'own' | 'council' = 'room', numbers: { cpus?: number; memoryMb?: number } = {}) {
    const ensuring = this.placements.ensure(sessionId, sessionId.startsWith('gpu') ? 'base-gpu' : 'base', undefined, numbers.cpus ?? 2, numbers.memoryMb ?? 4096, role)
    ensuring.catch(() => undefined)
    await flush()
    return { ensuring }
  }

  /** What the machine holds of a slot, as its sync says it. */
  held(sessionId: string, role: string, gen: number, phase: RemotePlacementHeld['phase'] = 'ready', container = C1, extra: Partial<RemotePlacementHeld> = {}): RemotePlacementHeld {
    return {
      key: `${sessionId}:${role}`,
      gen,
      phase,
      ...(phase !== 'pulling' ? { container } : {}),
      ...(phase === 'ready' ? { revision: remoteRevisionDigest((sessionId.startsWith('gpu') ? this.gpu : this.revision).registryRef!) } : {}),
      ...(phase === 'failed' ? { failure: { unschedulable: 'memory' as const, memoryMb: 4096, detail: 'docker run: out of memory' } } : {}),
      ...extra,
    }
  }

  /** A slot placed on `runner` and reported ready there. */
  async ready(sessionId: string, runner: RunnerRow, role: 'room' | 'own' | 'council' = 'room') {
    const { ensuring } = await this.place(sessionId, role)
    const row = livePlacement(sessionId, role)
    assert.ok(row, 'placed')
    assert.equal(row.runnerId, runner.id, 'on the machine meant')
    this.report(runner, { placements: [this.held(sessionId, role, row.gen)] })
    const endpoint = await ensuring
    assert.ok(endpoint)
    return { endpoint, row: livePlacement(sessionId, role)! }
  }

  /** The class clock's pass, as liveness.ts calls it. */
  tick(): void {
    this.placements.classTick(this.clock.now())
  }

  kinds(sessionId: string): string[] {
    return this.events.filter((event) => event.sessionId === sessionId).map((event) => event.kind)
  }
}

/** The agent's own parser over a reply carrying these intents: a reply home builds that a real agent would refuse fails here. */
function agentReads(intents: ReturnType<ClassPlacements['wantedPlacements']>) {
  return parseRemoteKernelsReply({
    placements: intents, pushes: [], verdicts: [], pulls: [], scan: [], epochs: [], collect: [], postmortem: [],
    rates: { classBulkMBps: 4, machinePaceMBps: 6 }, tunnel: 'open',
  }).placements
}

/** A live lease on `runner` that its sync did not list: what the stale-capacity rule must count. */
function unlistedLease(runner: RunnerRow, memoryMb: number, options: { sealed?: boolean; gpu?: boolean } = {}): void {
  const id = randomUUID().replaceAll('-', '')
  insertLease({
    attemptId: id, runnerId: runner.id, competitionId: 'comp', submissionId: id, runId: id, seq: 1, sealed: options.sealed ?? false, codeCells: null,
    provenance: { inputRevision: null, notebookInputRevision: null },
    manifest: { limits: { memoryMb, cpus: 2 }, gpu: options.gpu ?? false } as unknown as LeaseManifest,
    prepared: {} as never, container: `run-${id}`, perDevice: null, offeredAt: Date.now(), deadlineAt: Date.now() + 3_600_000,
  })
}

/* --------------------------------------------------------- the setting */

test('a class setting reads strictly from a body, leniently from its row, and the bounds are the contract’s', () => {
  const base = { ...CLASS_PLACEMENT_DEFAULT }
  assert.deepEqual(readClassPlacement({ own: 'machines', failoverSec: 90 }, base), { ok: true, placement: { ...base, own: 'machines', failoverSec: 90 } })
  assert.deepEqual(readClassPlacement({ owm: 'machines' }, base), { ok: false, field: 'owm' }, 'a typo is refused, not ignored')
  assert.deepEqual(readClassPlacement({ failoverSec: 29 }, base), { ok: false, field: 'failoverSec' })
  assert.deepEqual(readClassPlacement({ council: 'home' }, base), { ok: false, field: 'council' }, 'the council has no home of its own')
  assert.deepEqual(readClassPlacement({ workers: 33 }, base), { ok: false, field: 'workers' })
  assert.equal(readClassPlacement({ workers: 'auto', attemptMb: 2048, failover: 'wait', fallback: false }, base).ok, true)
  // The shared bounds repeat the contract's numbers rather than import them: held equal here.
  assert.deepEqual(CLASS_PLACEMENT_BOUNDS.failoverSec, { min: CLASS_FAILOVER_SEC.min, max: CLASS_FAILOVER_SEC.max })
  assert.equal(CLASS_PLACEMENT_BOUNDS.workers.max, COUNCIL_WORKERS.max)
  assert.equal(CLASS_PLACEMENT_DEFAULT.failoverSec, CLASS_FAILOVER_SEC.default)
  // A tile by its slots; the GPU class's name for the machines' tile.
  assert.equal(classPlacementPreset(CLASS_PLACEMENT_PRESETS.personal, false), 'personal')
  assert.equal(classPlacementPreset(CLASS_PLACEMENT_PRESETS.machines, true), 'gpu')
  assert.equal(classPlacementPreset(CLASS_PLACEMENT_PRESETS.machines, false), 'machines')
  assert.equal(classPlacementPreset({ room: 'machines', own: 'home', council: 'shared' }, false), null)

  new Rig()
  const id = `set${randomUUID().slice(0, 8)}`
  createSession(id, 'Set', 'base')
  assert.equal(sessionPlacement(id), null, 'a class nobody configured has no row: everything here')
  assert.deepEqual(classPlacement(id), { ...CLASS_PLACEMENT_DEFAULT, failoverSec: classMachineSettings().failoverSec })
  assert.equal(machinePlaced(id, 'room'), false)
  db.prepare('UPDATE sessions SET placement = ? WHERE id = ?').run('{"room":"machines","own":"elsewhere"}', id)
  assert.equal(classPlacement(id).room, 'machines', 'a stored field that reads is taken')
  assert.equal(classPlacement(id).own, 'home', 'one that does not keeps the default')
  assert.equal(machinePlaced(id, 'room'), true)
  assert.equal(machinePlaced(id, 'own'), false)
})

test('the owner’s class settings: defaults, a strict patch, clamped numbers, and the tile a new class starts with', () => {
  new Rig()
  updateClassMachineSettings({ teachers: null, newClasses: null, failoverSec: null, machineFileMb: null, classBulkMBps: null, competitionMBps: null })
  assert.deepEqual(classMachineSettings(), { teachers: true, newClasses: 'home', failoverSec: 60, machineFileMb: 200, classBulkMBps: 4, competitionMBps: 2 })
  assert.ok('error' in parseClassMachinePatch({ teacher: false }), 'an unknown field')
  assert.ok('error' in parseClassMachinePatch({ failoverSec: 1.5 }), 'a fraction')
  assert.ok('error' in parseClassMachinePatch({ newClasses: 'everything' }), 'a tile that does not exist')
  const parsed = parseClassMachinePatch({ failoverSec: 5000, newClasses: 'personal', teachers: false })
  assert.ok('patch' in parsed)
  assert.deepEqual(updateClassMachineSettings(parsed.patch).sort(), ['failoverSec', 'newClasses', 'teachers'])
  assert.equal(classMachineSettings().failoverSec, 300, 'clamped into its bounds')

  // A new class takes the owner's tile; a GPU class put on machines takes the card's (D31); everything here stays no row.
  const cpu = `new${randomUUID().slice(0, 8)}`
  createSession(cpu, 'New', 'base')
  assert.deepEqual({ room: classPlacement(cpu).room, own: classPlacement(cpu).own, council: classPlacement(cpu).council }, CLASS_PLACEMENT_PRESETS.personal)
  assert.equal(classPlacement(cpu).failoverSec, 300, 'with the owner’s delay')
  const gpu = `new${randomUUID().slice(0, 8)}`
  createSession(gpu, 'New GPU', 'base-gpu')
  assert.equal(classPlacement(gpu).room, 'machines')
  updateClassMachineSettings({ newClasses: 'home', failoverSec: null, teachers: null })
  const plain = `new${randomUUID().slice(0, 8)}`
  createSession(plain, 'Plain', 'base')
  assert.equal(sessionPlacement(plain), null)
})

/* ------------------------------------------------------------ chooser */

test('a machine is eligible only when every filter holds, and each one alone keeps it away', async () => {
  const rig = new Rig()
  const cases: Array<[string, (m: RunnerRow) => void]> = [
    ['not-live: outdated build', (m) => updateRunner(m.id, { build: 'another-build' })],
    ['not-live: draining', (m) => updateRunner(m.id, { state: 'draining' })],
    ['classes-off', (m) => updateRunner(m.id, { classes: false })],
    ['quarantined', (m) => updateRunner(m.id, { classesQuarantinedAt: rig.clock.now() })],
    ['sealed (D3)', (m) => unlistedLease(m, 512, { sealed: true })],
    ['tunnel down', (m) => rig.tunnels.set(m.id, false)],
    ['host network', (m) => rig.report(m, { classes: { ...GOOD, hostNetwork: false } })],
    ['perimeter not ok', (m) => rig.report(m, { classes: { ...GOOD, perimeter: 'no-iptables' } })],
    ['canary', (m) => rig.report(m, { classes: { ...GOOD, canary: 'failed: metadata reachable' } })],
    ['same daemon (D20)', (m) => rig.report(m, { classes: { ...GOOD, sameDaemon: true } })],
    ['image not there', (m) => rig.sync(m, { ready: { revisions: [], data: [], sealed: [], bundles: [] } })],
    ['image failing', (m) => rig.sync(m, { fetching: [{ revisionId: rig.revision.id, percent: 40 }], ready: { revisions: [], data: [], sealed: [], bundles: [] }, problems: [{ code: 'pull', revisionId: rig.revision.id, detail: 'denied' } as never] })],
    ['memory', (m) => rig.sync(m, { free: { slots: 4, memoryMb: 4096 + 255, cpus: 16, gpuShares: 0, diskMb: 100_000 } })],
    ['cpus', (m) => rig.sync(m, { free: { slots: 4, memoryMb: 32_768, cpus: 1, gpuShares: 0, diskMb: 100_000 } })],
  ]
  for (const [why, spoil] of cases) {
    const m = rig.machine()
    spoil(m)
    const id = rig.room({ fallback: true })
    const { ensuring } = await rig.place(id)
    assert.equal(await ensuring, null, `${why}: the class falls back here`)
    assert.equal(livePlacement(id, 'room'), null, `${why}: nothing placed`)
    updateRunner(m.id, { state: 'revoked' })
  }
  // And with every filter holding, the slot goes there; an image on its way counts as soon.
  const m = rig.machine({ ready: [], fetching: [{ revisionId: rig.revision.id, percent: 10 }] })
  const id = rig.room()
  void rig.place(id)
  await flush()
  assert.equal(livePlacement(id, 'room')?.runnerId, m.id)
  // The machine's own network floor is not home's to compare: the intent carries home's (D21).
  const strict = rig.machine({ facts: { mode: 'none' } })
  const other = rig.room()
  void rig.place(other)
  await flush()
  assert.ok([m.id, strict.id].includes(livePlacement(other, 'room')!.runnerId))
})

test('no portable image, a broken blocklist or no machine: the fallback here, a refusal without it, and the council has no home', async () => {
  const rig = new Rig()
  rig.machine()
  const local = getRevision(localRevision('base').id)!
  const placements = new ClassPlacements({ clock: rig.clock, tunnels: rig.tunnels, revisionOf: async () => local, log: () => undefined })
  usePlacements(placements)
  const events: string[] = []
  placements.onPlacementChange((event) => events.push(event.kind))
  const home = rig.room()
  assert.equal(await placements.ensure(home, 'base', undefined, 2, 4096, 'room'), null, 'an environment built here stays here (D22)')
  assert.deepEqual(events, ['fallback'])
  const strict = rig.room({ fallback: false })
  // In words, and without the machines and their refusals, which are for the log: the room reads it as it is.
  await assert.rejects(placements.ensure(strict, 'base', undefined, 2, 4096, 'room'), (error: Error) => error.message === tr('server.noMachineCanTakeThisClassNow.07c43f'))
  const pool = rig.room({ council: 'machines' })
  await assert.rejects(placements.ensure(pool, 'base', undefined, 2, 4096, 'council'), (error: Error) => error.message === tr('server.theCouncilPoolRunsOnlyOnMachines.ef5702'))

  usePlacements(rig.placements)
  process.env.KERNEL_BLOCKED_CIDRS = '10.0.0.0/8, not-a-range'
  try {
    const blocked = rig.room()
    assert.equal(await rig.placements.ensure(blocked, 'base', undefined, 2, 4096, 'room'), null, 'a blocklist home cannot fully tell keeps classes here')
  } finally {
    delete process.env.KERNEL_BLOCKED_CIDRS
  }
})

test('the preferences: another slot of the class, then the image in place, the shorter link, more memory, the name; the last host has no rank', async () => {
  const rig = new Rig()
  const near = rig.machine({ rtt: 20, name: 'near' })
  const far = rig.machine({ rtt: 200, name: 'far' })
  // The shorter link first.
  const a = rig.room()
  const { row: room } = await rig.ready(a, near)
  assert.equal(room.runnerId, near.id)
  // Another slot of the class goes where the class is (D5), even over a shorter link elsewhere.
  rig.tunnels.rtts.set(far.id, 5)
  await rig.place(a, 'own')
  assert.equal(livePlacement(a, 'own')?.runnerId, near.id)
  // The class's host of a few days ago is no reason over the link: no copy of its folder waits there (the agent removed it
  // with its last slot), and the shorter link wins.
  const b = rig.room()
  db.prepare(`INSERT INTO remote_placements (session_id, role, gen, runner_id, state, environment, revision_id, revision_ref, revision_layers, memory_mb, cpus, created_at, ended_at)
    VALUES (?, 'room', 3, ?, 'stopped', 'base', 'r', 'ref', 'l', 512, 1, ?, ?)`).run(b, near.id, rig.clock.now(), rig.clock.now() - 6 * 24 * 3_600_000)
  void rig.place(b)
  await flush()
  assert.equal(livePlacement(b, 'room')?.runnerId, far.id, 'the shorter link, not the last host')
  assert.equal(livePlacement(b, 'room')?.gen, 4, 'the next gen after the history')
  // Ready over fetching, before the link.
  const fetching = rig.machine({ rtt: 1, ready: [], fetching: [{ revisionId: rig.revision.id, percent: 50 }] })
  const c = rig.room()
  void rig.place(c)
  await flush()
  assert.notEqual(livePlacement(c, 'room')?.runnerId, fetching.id)
  // «далеко» over 150 ms in the form's line, with each machine's refusal.
  const outlook = await rig.placements.outlook(rig.room())
  const farLine = outlook.machines.find((machine) => machine.runnerId === far.id)!
  assert.equal(farLine.far, false, 'its p95 is 5 ms now')
  rig.tunnels.rtts.set(far.id, 200)
  assert.equal((await rig.placements.outlook(rig.room())).machines.find((machine) => machine.runnerId === far.id)!.far, true)
})

test('the council’s pool prefers the machine of the notebook’s kernel, and is sized from its setting', async () => {
  const rig = new Rig()
  const quick = rig.machine({ rtt: 5 })
  const main = rig.machine({ rtt: 50 })
  const id = rig.room({ room: 'machines', own: 'home', council: 'machines', workers: 6, attemptMb: 512 })
  // The notebook's kernel on `main` (placed with the link that preferred it then).
  rig.tunnels.rtts.set(quick.id, 500)
  await rig.ready(id, main)
  rig.tunnels.rtts.set(quick.id, 5)
  void rig.place(id, 'council')
  await flush()
  const pool = livePlacement(id, 'council')!
  assert.equal(pool.runnerId, main.id)
  assert.equal(pool.workers, 6)
  assert.equal(pool.memoryMb, 6 * (512 + COUNCIL_WORKER_BASE_MB) + 512, 'its workers’ ceilings, what each holds before an attempt, and a margin (§9.5)')
  assert.equal(pool.cpus, 6)
  const [intent] = agentReads(rig.placements.wantedPlacements(main.id)).filter((one) => one.key.endsWith(':council'))
  assert.equal(intent.workers, 6)
  assert.equal(intent.gpu, false)
  // The pool grown by its pools (kernel/council-pool.ts): the row and the intent say how many workers it holds now, as the
  // panel names them, the numbers with it; a new count alone is written too, docker having nothing to apply of it.
  await rig.placements.resize(id, 'council', { memoryMb: 8 * (512 + COUNCIL_WORKER_BASE_MB) + 512, cpus: 8, workers: 8 })
  assert.deepEqual([livePlacement(id, 'council')!.workers, livePlacement(id, 'council')!.cpus], [8, 8])
  await rig.placements.resize(id, 'council', { memoryMb: 8 * (512 + COUNCIL_WORKER_BASE_MB) + 512, cpus: 8, workers: 7 })
  assert.equal(livePlacement(id, 'council')!.workers, 7)
  const [grown] = agentReads(rig.placements.wantedPlacements(main.id)).filter((one) => one.key.endsWith(':council'))
  assert.equal(grown.workers, 7)
  // The other slots have no workers to say.
  await rig.placements.resize(id, 'room', { cpus: 2, workers: 9 })
  assert.equal(livePlacement(id, 'room')!.workers, null)
})

test('stale capacity: intents the machine has not acknowledged and leases it did not list come off what it says is free', async () => {
  const rig = new Rig()
  const m = rig.machine({ free: { memoryMb: 9000 } })
  const a = rig.room()
  void rig.place(a, 'room', { memoryMb: 4096 })
  await flush()
  assert.equal(livePlacement(a, 'room')?.runnerId, m.id)
  // 9000 − 4096 unacknowledged leaves 4904, enough for 4096 + 256 …
  const b = rig.room()
  void rig.place(b, 'room', { memoryMb: 4096 })
  await flush()
  assert.equal(livePlacement(b, 'room')?.runnerId, m.id)
  // … and with both unacknowledged 808 MB are left: not enough for 1024 + 256.
  const c = rig.room({ fallback: true })
  assert.equal(await (await rig.place(c, 'room', { memoryMb: 1024 })).ensuring, null)
  // Acknowledged (held, not failed), they count in the machine's own free number, and room returns.
  rig.report(m, { placements: [rig.held(a, 'room', 1, 'starting'), rig.held(b, 'room', 1, 'starting', C2)] })
  const d = rig.room()
  void rig.place(d, 'room', { memoryMb: 512 })
  await flush()
  assert.equal(livePlacement(d, 'room')?.runnerId, m.id)
  // A lease its sync did not list takes its claim too (lease.ts · runnerRoom).
  const n = rig.machine({ free: { memoryMb: 5000 } })
  unlistedLease(n, 4096)
  const e = rig.room({ fallback: true })
  void e
  rig.sync(m, { free: { slots: 0, memoryMb: 0, cpus: 0, gpuShares: 0, diskMb: 0 } })
  assert.equal(await (await rig.place(e, 'room', { memoryMb: 1024 })).ensuring, null, 'the lease leaves 5000 − 4096 − 256 short of 1024 + 256')
})

test('a machine takes no more placements than one reply names, and a reply never leaves a running slot out for a starting one', async () => {
  const rig = new Rig()
  const m = rig.machine({ free: { memoryMb: 1_000_000, cpus: 1000 } })
  const write = (sessionId: string, state: 'ready' | 'starting', createdAt: number) => writePlacement({
    sessionId, role: 'room', runnerId: m.id, state, environment: 'base',
    revision: { id: rig.revision.id, ref: rig.revision.registryRef!, layers: rig.revision.layers! },
    memoryMb: 512, cpus: 1, gpu: null, workers: null, container: state === 'ready' ? C1 : null,
    readyAt: state === 'ready' ? createdAt : null, endedAt: null, reason: null, createdAt,
  })
  const running: RemotePlacementHeld[] = []
  for (let i = 0; i < REMOTE_PLACEMENTS_MAX; i++) {
    // Sorting after the class below: a cut by session id would drop one of these first.
    const id = `zz${String(i).padStart(3, '0')}${randomUUID().slice(0, 4)}`
    createSession(id, `Big ${i}`, 'base')
    setSessionPlacement(id, { ...CLASS_PLACEMENT_DEFAULT, room: 'machines' })
    running.push(rig.held(id, 'room', write(id, 'ready', rig.clock.now()).gen))
  }
  rig.report(m, { placements: running })
  // Room and cores to spare, but every place a reply has is taken: the class starts here, and the form says why.
  const more = rig.room({ fallback: true })
  const { ensuring } = await rig.place(more, 'room', { memoryMb: 512, cpus: 1 })
  assert.equal(livePlacement(more, 'room'), null, 'not placed as the 65th there')
  assert.equal(await ensuring, null)
  assert.equal((await rig.placements.outlook(more)).machines.find((line) => line.runnerId === m.id)?.refusal, 'full')
  // One more written by another hand anyway (its id sorting first): the reply keeps every running slot and leaves it out.
  const extra = `aa${randomUUID().slice(0, 6)}`
  createSession(extra, 'Extra', 'base')
  write(extra, 'starting', rig.clock.now() + 1)
  const keys = rig.placements.wantedPlacements(m.id).map((intent) => intent.key)
  assert.equal(keys.length, REMOTE_PLACEMENTS_MAX)
  assert.ok(running.every((entry) => keys.includes(entry.key)), 'no running slot is left out (left out = removed)')
  assert.ok(!keys.includes(`${extra}:room`))
})

test('a GPU room gets a whole card no share of is in use; personal notebooks never need one', async () => {
  const rig = new Rig()
  const card = (busyShares: number): RemoteCard => ({ device: `GPU-${busyShares}`, name: 'RTX 4090', memoryMb: 24_564, perDevice: 4, busyShares })
  rig.machine({ cards: [card(1)] })
  const busy = `gpu${randomUUID().slice(0, 8)}`
  createSession(busy, 'GPU', 'base-gpu')
  setSessionPlacement(busy, { ...CLASS_PLACEMENT_DEFAULT, room: 'machines', own: 'machines' })
  assert.equal(await (await rig.place(busy)).ensuring, null, 'a card with a share in use is no whole card')
  const free = rig.machine({ cards: [card(0)] })
  void rig.place(busy)
  await flush()
  const row = livePlacement(busy, 'room')!
  assert.equal(row.runnerId, free.id)
  assert.equal(row.gpu, '', 'a whole card asked, not named yet')
  const [intent] = agentReads(rig.placements.wantedPlacements(free.id))
  assert.equal(intent.gpu, true)
  // That unacknowledged card is taken: a second GPU room does not fit there.
  const second = `gpu${randomUUID().slice(0, 8)}`
  createSession(second, 'GPU 2', 'base-gpu')
  setSessionPlacement(second, { ...CLASS_PLACEMENT_DEFAULT, room: 'machines', own: 'machines' })
  assert.equal(await (await rig.place(second)).ensuring, null)
  // Nor once the machine holds the room at its gen while its image comes: it names no card until it picks one, reporting the card
  // free meanwhile, and the card is the room's all the same (the take counts it so too, lease.ts · classShare).
  rig.report(free, { placements: [rig.held(busy, 'room', row.gen, 'pulling')] })
  const third = `gpu${randomUUID().slice(0, 8)}`
  createSession(third, 'GPU 3', 'base-gpu')
  setSessionPlacement(third, { ...CLASS_PLACEMENT_DEFAULT, room: 'machines', own: 'machines' })
  const { ensuring: placingThird } = await rig.place(third)
  assert.equal(livePlacement(third, 'room'), null, 'one whole card, one room')
  assert.equal(await placingThird, null)
  // The personal notebooks of a GPU class take no card.
  void rig.place(second, 'own')
  await flush()
  assert.equal(livePlacement(second, 'own')?.gpu, null)
  // The card the machine names goes into the row.
  rig.report(free, { placements: [rig.held(busy, 'room', row.gen, 'starting', C1, { card: { device: 'GPU-0', usedMb: null } })] })
  assert.equal(livePlacement(busy, 'room')?.gpu, 'GPU-0')
})

/* ------------------------------------------------------- ensure and intents */

test('ensure writes the placement, the machine reports it ready, the echoes pass and the endpoint is the placement’s own', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  const { ensuring } = await rig.place(id, 'room', { cpus: 1.5, memoryMb: 6144 })
  const row = livePlacement(id, 'room')!
  assert.equal(row.state, 'starting')
  assert.equal(row.gen, 1)
  assert.equal(row.cpus, 2, 'whole cores, rounded up')
  // The intent passes the agent's own parser, and carries home's numbers and floor.
  const [intent] = agentReads(rig.placements.wantedPlacements(m.id))
  assert.equal(intent.key, `${id}:room`)
  assert.equal(intent.token, placementToken(id, 'room', m.id, 1))
  assert.equal(intent.network, 'blocked')
  assert.deepEqual(intent.revision, { id: rig.revision.id, ref: rig.revision.registryRef, layers: rig.revision.layers })
  // A failed start from before this ensure is not this ensure's; one after it is.
  rig.report(m, { placements: [rig.held(id, 'room', 1, 'pulling')] })
  assert.match(rig.placements.startingWords(id, 'room')!, /./)
  rig.report(m, { placements: [rig.held(id, 'room', 1, 'ready')] })
  const endpoint = (await ensuring)!
  assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(endpoint.token, placementToken(id, 'room', m.id, 1))
  assert.equal(endpoint.identity, `machine:${m.id}:${C1}:1`)
  assert.equal(endpoint.link?.up, true)
  assert.equal(livePlacement(id, 'room')?.state, 'ready')
  assert.deepEqual(rig.kinds(id), ['starting', 'ready'])
  // Another notebook of the class: the same endpoint, no second placement.
  assert.equal(await rig.placements.ensure(id, 'base', undefined, 2, 4096, 'room'), endpoint)
  // Nothing about the view or the events carries the token.
  assert.ok(!JSON.stringify(rig.placements.placementOf(id, 'room')).includes(endpoint.token))
  assert.ok(!JSON.stringify(rig.events).includes(endpoint.token))
})

test('a start fails in the machine’s words; a ready echo of another image is refused and its container goes', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  const { ensuring: failing } = await rig.place(id)
  rig.report(m, { placements: [rig.held(id, 'room', 1, 'failed')] })
  await assert.rejects(failing, (error: Error & { failure?: { unschedulable: string } }) =>
    error.message === tr('server.theKernelDidNotStartOnMachine.f6b08f', { machine: m.name, detail: 'docker run: out of memory' }) && error.failure?.unschedulable === 'memory')
  assert.equal(livePlacement(id, 'room')?.state, 'starting', 'the machine retries while home keeps the intent')
  // The next Run waits for the retry, not for the old failure.
  const next = rig.placements.ensure(id, 'base', undefined, 2, 4096, 'room')
  await flush()
  rig.report(m, { placements: [rig.held(id, 'room', 1, 'ready', C1, { revision: 'sha256:' + '9'.repeat(64) })] })
  await assert.rejects(next, (error: Error) => error.message === tr('server.kernelRuntimeReturnedADifferentEnvironmentRevision.8f728c'))
  assert.equal(livePlacement(id, 'room')?.state, 'stopping', 'the wrong container goes')
  assert.deepEqual(agentReads(rig.placements.wantedPlacements(m.id)), [], 'the reply omits it')
})

test('the start waits CLASS_START_MS and no longer', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  const { ensuring } = await rig.place(id)
  rig.clock.advance(179_000)
  await flush()
  let settled = false
  ensuring.then(() => (settled = true), () => (settled = true))
  await flush()
  assert.equal(settled, false)
  rig.clock.advance(1_000)
  await assert.rejects(ensuring, (error: Error) => error.message === tr('server.theKernelDidNotStartOnMachine.5db0fa', { machine: m.name, seconds: 180 }))
})

test('a start the machine keeps failing is given up CLASS_START_MS after its first failure: stopped there, and the class goes elsewhere', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room({ fallback: true })
  const failed = (): void => rig.report(m, { placements: [rig.held(id, 'room', 1, 'failed')] })
  const { ensuring } = await rig.place(id)
  failed()
  const words = tr('server.theKernelDidNotStartOnMachine.f6b08f', { machine: m.name, detail: 'docker run: out of memory' })
  await assert.rejects(ensuring, (error: Error) => error.message === words)
  // The machine retries and fails again; the next Run waits for it, but not for ever.
  const waiting = rig.placements.ensure(id, 'base', undefined, 2, 4096, 'room')
  waiting.catch(() => undefined)
  for (let at = 5000; at < CLASS_START_MS; at += 5000) {
    rig.clock.advance(5000)
    failed()
    rig.tick()
  }
  assert.equal(livePlacement(id, 'room')?.state, 'starting', 'still retried')
  rig.clock.advance(5000)
  failed()
  rig.tick()
  assert.equal(livePlacement(id, 'room')?.state, 'stopping', 'given up there: the reply omits it')
  await assert.rejects(waiting, (error: Error & { failure?: { unschedulable: string } }) => error.message === words && error.failure?.unschedulable === 'memory')
  assert.equal(await rig.placements.ensure(id, 'base', undefined, 2, 4096, 'room'), null, 'that machine is avoided: the fallback here')
  assert.equal(runnerEventsOf(m.id, ['class_failover'], 0).length, 0, 'no failover: there were no variables to lose')
})

test('a stop that lands while the port opens closes it, and the start hears the room’s words', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  let open!: () => void
  const opening = new Promise<void>((resolve) => (open = resolve))
  const listen = rig.tunnels.listen.bind(rig.tunnels)
  rig.tunnels.listen = async (...args) => {
    await opening
    return listen(...args)
  }
  const { ensuring } = await rig.place(id)
  rig.report(m, { placements: [rig.held(id, 'room', 1)] })
  await flush()
  await rig.placements.drop(id, ['room'])
  open()
  await assert.rejects(ensuring, (error: Error) => error.message === tr('server.kernel.startsPaused'))
  assert.equal(rig.tunnels.listening.size, 1)
  assert.ok([...rig.tunnels.listening.values()].every((listener) => listener.closed), 'no port left open on 127.0.0.1')
})

test('the placement after a loss runs the image the lost one ran; a slot that came back since takes its class’s', async () => {
  const rig = new Rig()
  const newer = getRevision(portableRevision('base').id)!
  // This server's image of the environment is newer than the one the class started on.
  const placements = new ClassPlacements({ clock: rig.clock, tunnels: rig.tunnels, revisionOf: async () => newer, log: () => undefined })
  usePlacements(placements)
  const report = (runner: RunnerRow, held: RemotePlacementHeld[]): void =>
    placements.noteKernelsReport(runner.id, { placements: held, reports: [], epochs: [], readings: [], tunnel: 'up', classes: GOOD }, rig.clock.now())
  const m = rig.machine()
  report(m, [])
  const id = rig.room()
  const first = placements.ensure(id, 'base', rig.revision.id, 2, 4096, 'room')
  await flush()
  assert.equal(livePlacement(id, 'room')?.runnerId, m.id)
  report(m, [rig.held(id, 'room', 1)])
  await first
  // Another machine, holding both images.
  const n = rig.machine()
  rig.sync(n, { ready: { revisions: [rig.revision.id, newer.id], data: [], sealed: [], bundles: [] } })
  report(n, [])
  assert.deepEqual(await placements.moveNow(id, 'room', 'teacher'), { ok: true })
  const second = placements.ensure(id, 'base', undefined, 2, 4096, 'room')
  await flush()
  const moved = livePlacement(id, 'room')!
  assert.equal(moved.runnerId, n.id)
  assert.equal(moved.revision.id, rig.revision.id, 'the same image: the class goes on (§6.6)')
  report(n, [rig.held(id, 'room', 2)])
  await second
  // Back on a machine, stopped and started again: a new kernel, on the class's image of now.
  await placements.drop(id, ['room'])
  report(n, [])
  void placements.ensure(id, 'base', undefined, 2, 4096, 'room').catch(() => undefined)
  await flush()
  assert.equal(livePlacement(id, 'room')?.revision.id, newer.id)
})

test('a gen is never used twice: a slot placed again a month after its last stop goes on from that gen', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  const { endpoint, row } = await rig.ready(id, m)
  await rig.placements.drop(id, ['room'])
  rig.report(m, { placements: [] })
  assert.equal(placementRow(id, 'room')?.state, 'stopped')
  assert.ok(rig.tunnels.lostIds.includes(`${m.id}|${id}:room|${row.gen}`), 'the stop fenced its gen in the tunnel')
  // A month on, the same home: the class's history is still what the next gen counts from.
  rig.clock.advance(31 * 24 * 3_600_000)
  rig.sync(m)
  rig.tick()
  const again = await rig.ready(id, m)
  assert.equal(again.row.gen, row.gen + 1)
  assert.notEqual(again.endpoint.token, endpoint.token)
  assert.equal(again.endpoint.link?.up, true, 'not born lost')
})

test('a placement being stopped is still current for its late writes; another gen, another machine and a stopped one are not', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  await rig.ready(id, m)
  await rig.placements.drop(id, ['room'])
  assert.equal(livePlacement(id, 'room')?.state, 'stopping')
  assert.equal(placementCurrent(m.id, id, 'room', 1), true, 'the kernel’s last writes still come home')
  assert.equal(placementCurrent(m.id, id, 'room', 2), false)
  assert.equal(placementCurrent('another', id, 'room', 1), false)
  rig.report(m, { placements: [] })
  assert.equal(placementCurrent(m.id, id, 'room', 1), false)
})

test('a reply built before the class clock’s pass never names part of home’s blocklist: the slots move first', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  void rig.place(id)
  await flush()
  const saved = process.env.KERNEL_BLOCKED_CIDRS
  try {
    process.env.KERNEL_BLOCKED_CIDRS = Array.from({ length: 65 }, (_, i) => `198.${i}.0.0/16`).join(',')
    assert.deepEqual(rig.placements.wantedPlacements(m.id), [], 'no intent with 64 of 65 ranges')
    assert.equal(placementRow(id, 'room')?.reason, 'blocked')
  } finally {
    if (saved === undefined) delete process.env.KERNEL_BLOCKED_CIDRS
    else process.env.KERNEL_BLOCKED_CIDRS = saved
  }
})

test('a token per gen and per machine; every input of an older gen is ignored', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  const { row } = await rig.ready(id, m)
  assert.notEqual(placementToken(id, 'room', m.id, 1), placementToken(id, 'room', m.id, 2))
  assert.notEqual(placementToken(id, 'room', m.id, 1), placementToken(id, 'room', 'otherone', 1))
  assert.match(placementToken(id, 'room', m.id, 1), /^[a-f0-9]{40}$/)
  // Moved: gen 2 elsewhere.
  const n = rig.machine()
  rig.tunnels.set(m.id, false)
  await rig.placements.moveNow(id, 'room', 'teacher')
  const { ensuring: placing } = await rig.place(id)
  const next = livePlacement(id, 'room')!
  assert.equal(next.gen, row.gen + 1)
  assert.equal(next.runnerId, n.id)
  // The returning machine still says gen 1 ready: it moves nothing, and its reply omits it.
  rig.tunnels.set(m.id, true)
  rig.report(m, { placements: [rig.held(id, 'room', 1, 'ready')] })
  assert.equal(livePlacement(id, 'room')?.state, 'starting')
  assert.deepEqual(rig.placements.wantedPlacements(m.id), [])
  // On one machine too: a slot stopped there and placed there again hears nothing of its old gen.
  rig.tunnels.set(m.id, false)
  const again = rig.room()
  await rig.ready(again, n)
  await rig.placements.drop(again, ['room'])
  rig.report(n, { placements: [rig.held(id, 'room', next.gen, 'starting', C2)] })
  assert.equal(placementRow(again, 'room')?.state, 'stopped')
  const { ensuring: replacing } = await rig.place(again)
  assert.equal(livePlacement(again, 'room')?.gen, 2)
  assert.equal(livePlacement(again, 'room')?.runnerId, n.id, 'the one machine that answers, where it was')
  rig.report(n, { placements: [rig.held(id, 'room', next.gen, 'starting', C2), rig.held(again, 'room', 1, 'ready', C1)] })
  assert.equal(livePlacement(again, 'room')?.state, 'starting', 'gen 1 ready says nothing of gen 2')
  rig.report(n, { placements: [rig.held(id, 'room', next.gen, 'starting', C2), rig.held(again, 'room', 2, 'ready', C1)] })
  assert.equal((await replacing)?.identity, `machine:${n.id}:${C1}:2`)
  // A reading of the old gen answers no question of the new.
  const asked = rig.placements.reading(id, 'room')
  rig.report(n, { placements: [rig.held(id, 'room', next.gen, 'ready', C2)], readings: [{ key: `${id}:room`, gen: 1, reading: { limit: 1, peak: 1, current: 1, kills: 1, containerOomKilled: false, status: 'running', exit: null, tail: [] } }] })
  rig.clock.advance(10_000)
  assert.equal(await asked, null)
  await placing
})

test('home’s floor and numbers go out as the contract has them: an open home sends blocked, none sends no ranges', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  void rig.place(id)
  await flush()
  const saved = { network: process.env.COLLOQ_ROOM_NETWORK, cidrs: process.env.KERNEL_BLOCKED_CIDRS }
  try {
    process.env.KERNEL_BLOCKED_CIDRS = '203.0.113.0/24'
    process.env.COLLOQ_ROOM_NETWORK = 'open'
    let [intent] = agentReads(rig.placements.wantedPlacements(m.id))
    assert.equal(intent.network, 'blocked')
    assert.deepEqual(intent.blockedCidrs, ['203.0.113.0/24'])
    process.env.COLLOQ_ROOM_NETWORK = 'none'
    ;[intent] = agentReads(rig.placements.wantedPlacements(m.id))
    assert.equal(intent.network, 'none')
    assert.deepEqual(intent.blockedCidrs, [])
    assert.ok(intent.hashSeed >= 1)
    // More ranges than an intent may carry: no slot is kept on a machine.
    process.env.COLLOQ_ROOM_NETWORK = 'blocked'
    process.env.KERNEL_BLOCKED_CIDRS = Array.from({ length: 65 }, (_, i) => `198.${i}.0.0/16`).join(',')
    rig.tick()
    assert.equal(placementRow(id, 'room')?.state, 'lost')
    assert.equal(placementRow(id, 'room')?.reason, 'blocked')
  } finally {
    if (saved.network === undefined) delete process.env.COLLOQ_ROOM_NETWORK
    else process.env.COLLOQ_ROOM_NETWORK = saved.network
    if (saved.cidrs === undefined) delete process.env.KERNEL_BLOCKED_CIDRS
    else process.env.KERNEL_BLOCKED_CIDRS = saved.cidrs
  }
})

/* --------------------------------------------------- the class clock */

test('the tunnel down: amber at once, the note after ten seconds, back with its words; a gate waits for it', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  await rig.ready(id, m)
  rig.tunnels.set(m.id, false)
  assert.equal(rig.placements.placementOf(id, 'room').where, 'machine')
  assert.equal((rig.placements.placementOf(id, 'room') as { state: string }).state, 'unreachable')
  const first = rig.events.at(-1)!
  assert.equal(first.kind, 'unreachable')
  assert.equal(first.words, undefined, 'the chip first, no note')
  let opened = false
  const gate = rig.placements.placementGate(id, 'room').then(() => (opened = true))
  rig.clock.advance(CLASS_UNREACHABLE_NOTE_MS - 1000)
  noteCall(m.id, rig.clock.now(), null)
  rig.tick()
  assert.equal(rig.events.filter((event) => event.kind === 'unreachable' && event.words).length, 0)
  rig.clock.advance(1000)
  rig.tick()
  const note = rig.events.filter((event) => event.kind === 'unreachable' && event.words)
  assert.equal(note.length, 1)
  assert.match(note[0].staffWords ?? '', /./, 'staff read until when home waits')
  await flush()
  assert.equal(opened, false, 'the gate waits while the machine is unreachable')
  rig.tunnels.set(m.id, true)
  await gate
  const back = rig.events.at(-1)!
  assert.equal(back.kind, 'back')
  assert.match(back.words ?? '', /10/)
  assert.equal(livePlacement(id, 'room')?.state, 'ready')
})

test('a gate on a row a previous life left unreachable opens with the tunnel, before any pass of the class clock', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  await rig.ready(id, m)
  const life = (): ClassPlacements => {
    const next = new ClassPlacements({ clock: rig.clock, tunnels: rig.tunnels, revisionOf: async () => rig.revision, log: () => undefined })
    usePlacements(next)
    return next
  }
  // A home stopping: its tunnels close under its placements, which write the row unreachable.
  rig.tunnels.set(m.id, false)
  assert.equal(livePlacement(id, 'room')?.state, 'unreachable')
  const fresh = life()
  let opened = false
  void fresh.placementGate(id, 'room').then(() => (opened = true))
  await flush()
  assert.equal(opened, false, 'the machine is away')
  rig.tunnels.set(m.id, true)
  await flush()
  assert.equal(opened, true, 'its tunnel back opens the gate')
  assert.equal(livePlacement(id, 'room')?.state, 'ready')
  // The tunnel back before the next life heard of anything: the gate opens at once.
  rig.tunnels.set(m.id, false)
  const later = life()
  rig.tunnels.set(m.id, true)
  assert.equal(livePlacement(id, 'room')?.state, 'unreachable', 'nobody listened')
  let passed = false
  void later.placementGate(id, 'room').then(() => (passed = true))
  await flush()
  assert.equal(passed, true)
  assert.equal(livePlacement(id, 'room')?.state, 'ready')
})

test('tunnel down with syncs still coming: no failover until CLASS_TUNNEL_STUCK_MS, then the tunnel’s failover', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  await rig.ready(id, m)
  rig.tunnels.set(m.id, false)
  for (let at = 0; at < CLASS_TUNNEL_STUCK_MS - 5000; at += 5000) {
    rig.clock.advance(5000)
    noteCall(m.id, rig.clock.now(), null)
    rig.tick()
  }
  assert.equal(livePlacement(id, 'room')?.state, 'unreachable')
  rig.clock.advance(5000)
  noteCall(m.id, rig.clock.now(), null)
  rig.tick()
  assert.equal(placementRow(id, 'room')?.state, 'lost')
  assert.equal(placementRow(id, 'room')?.reason, 'tunnel')
})

test('a machine silent on both channels is a silence whatever the class waits: no move without evidence, and with it at the class’s own delay', async () => {
  for (const kind of ['no evidence', 'witness', 'syncs stop'] as const) {
    const rig = new Rig()
    const m = rig.machine()
    const witness = rig.machine()
    const id = rig.room(kind === 'syncs stop' ? {} : { failoverSec: 300 })
    await rig.ready(id, m)
    const downAt = rig.clock.now()
    rig.tunnels.set(m.id, false)
    let movedAt: number | null = null
    for (let i = 1; i <= 70 && movedAt === null; i++) {
      rig.clock.advance(5000)
      // «syncs stop»: the machine syncs on for 70 s with its tunnel down, then home's own road goes (nothing heard, no probe).
      if (kind === 'witness') rig.sync(witness)
      if (kind === 'syncs stop' && i <= 14) rig.sync(m)
      rig.tick()
      if (kind === 'witness' && i === 4) {
        // Staff read until when home waits: the class's 300 s from the last call, not the stuck tunnel's 120 s.
        assert.equal((rig.placements.placementOf(id, 'room') as { failoverAt: number | null }).failoverAt, downAt + 300_000)
      }
      if (placementRow(id, 'room')?.state === 'lost') movedAt = rig.clock.now() - downAt
    }
    if (kind === 'witness') {
      assert.equal(movedAt, 300_000, 'witness: the class said 300 s')
      assert.equal(placementRow(id, 'room')?.reason, 'silence')
    } else {
      assert.equal(movedAt, null, `${kind}: home's own road may be down`)
      assert.equal(runnerEventsOf(m.id, ['class_failover'], 0).length, 0)
    }
  }
})

test('silence on both channels fails over at the class’s failoverSec — only with path evidence, and counted from its return', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const witness = rig.machine()
  const id = rig.room({ failoverSec: 30 })
  await rig.ready(id, m)
  let lost: unknown = null
  rig.tunnels.set(m.id, false)
  rig.placements.placementGate(id, 'room').catch((error) => (lost = error))
  // No evidence at all for a long while: nothing moves (home's own road may be down).
  for (let i = 0; i < 24; i++) {
    rig.clock.advance(5000)
    rig.tick()
  }
  assert.equal(livePlacement(id, 'room')?.state, 'unreachable', 'two minutes of silence without evidence')
  // The witness comes back: the silence counts from here, a whole failoverSec.
  for (let i = 0; i < 5; i++) {
    noteCall(witness.id, rig.clock.now(), null)
    rig.clock.advance(5000)
    rig.tick()
  }
  assert.equal(livePlacement(id, 'room')?.state, 'unreachable', 'evidence back for 25 s of the 30')
  noteCall(witness.id, rig.clock.now(), null)
  rig.clock.advance(5000)
  rig.tick()
  assert.equal(placementRow(id, 'room')?.state, 'lost')
  assert.equal(placementRow(id, 'room')?.reason, 'silence')
  await flush()
  assert.ok(lost instanceof PlacementLost, 'the gate is rejected')
  assert.equal((lost as PlacementLost).cause, 'silence')
  assert.match((lost as PlacementLost).words, new RegExp(getRunner(m.id)!.name))
  assert.ok(rig.tunnels.lostIds.includes(`${m.id}|${id}:room|1`), 'the link answers lost')
  assert.equal([...rig.tunnels.listening.values()].every((listener) => listener.closed), true, 'the listener closed')
  assert.equal(rig.events.at(-1)?.kind, 'lost')
  assert.equal(runnerEventsOf(m.id, ['class_failover'], 0).length, 1)
})

test('evidence counts fifteen seconds; the probe passing is evidence', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room({ failoverSec: 30 })
  await rig.ready(id, m)
  rig.tunnels.set(m.id, false)
  // The probe every five seconds keeps the evidence fresh: the silence is proven, and the class moves at 30 s.
  for (let i = 0; i < 7; i++) {
    noteProbe(true, rig.clock.now())
    rig.clock.advance(5000)
    rig.tick()
  }
  assert.equal(placementRow(id, 'room')?.state, 'lost')
  // A probe sixteen seconds old proves nothing.
  const rig2 = new Rig()
  const m2 = rig2.machine()
  const other = rig2.room({ failoverSec: 30 })
  await rig2.ready(other, m2)
  rig2.tunnels.set(m2.id, false)
  noteProbe(true, rig2.clock.now())
  rig2.clock.advance(16_000)
  rig2.tick()
  rig2.clock.advance(60_000)
  rig2.tick()
  assert.equal(livePlacement(other, 'room')?.state, 'unreachable')
})

test('nothing moves in the boot grace, nor within a bye{restart}’s 120 s, nor for a class that waits for its machine', async () => {
  for (const kind of ['boot', 'bye', 'wait'] as const) {
    const rig = kind === 'boot' ? new Rig({ boot: Date.now() }) : new Rig()
    const m = rig.machine()
    const witness = rig.machine()
    const id = rig.room(kind === 'wait' ? { failover: 'wait' } : {})
    await rig.ready(id, m)
    if (kind === 'bye') rig.report(m, { placements: [rig.held(id, 'room', 1)], bye: 'restart', tunnel: 'down' })
    rig.tunnels.set(m.id, false)
    const graceMs = kind === 'boot' ? REMOTE_BOOT_GRACE_MS : kind === 'bye' ? CLASS_BYE_GRACE_MS : 30 * 60_000
    for (let at = 0; at < graceMs - 5000; at += 5000) {
      rig.clock.advance(5000)
      noteCall(witness.id, rig.clock.now(), null)
      rig.tick()
    }
    assert.equal(livePlacement(id, 'room')?.state, 'unreachable', `${kind}: still waiting`)
    if (kind === 'bye') assert.ok(rig.events.some((event) => event.kind === 'unreachable' && /обновляется|updating/i.test(event.words ?? '')))
    if (kind === 'wait') {
      // «Перенести сейчас» is what moves it.
      assert.deepEqual(await rig.placements.moveNow(id, null, 'teacher'), { ok: true })
      assert.equal(placementRow(id, 'room')?.reason, 'moved')
      assert.deepEqual(await rig.placements.moveNow(id, null, 'teacher'), { refused: tr('server.thisClassSKernelsRunOnThis.d5eaa3') })
      continue
    }
    for (let i = 0; i < 3; i++) {
      rig.clock.advance(5000)
      noteCall(witness.id, rig.clock.now(), null)
      rig.tick()
    }
    assert.equal(placementRow(id, 'room')?.state, 'lost', `${kind}: moves once the grace is over`)
  }
})

test('«Перенести на сервер» on a reachable machine moves now, and the slot does not go back to that machine', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room({ fallback: true })
  await rig.ready(id, m)
  assert.deepEqual(await rig.placements.moveNow(id, 'room', 'teacher'), { ok: true })
  assert.deepEqual(rig.kinds(id).slice(-2), ['moving', 'lost'])
  assert.equal(placementRow(id, 'room')?.reason, 'moved')
  assert.match(rig.events.at(-1)?.words ?? '', /./)
  assert.equal(await rig.placements.ensure(id, 'base', undefined, 2, 4096, 'room'), null, 'the same machine is avoided: here instead')
  rig.placements.settledHome(id, 'room')
  assert.equal(rig.kinds(id).at(-1), 'moved')
  // A move by hand is no silence: it counts for no quarantine.
  assert.equal(runnerEventsOf(m.id, ['class_failover'], 0)[0]?.detail, 'moved: teacher')
})

test('two silence failovers within half an hour quarantine the machine for classes; a resume starts the count over', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const silence = async (): Promise<void> => {
    const id = rig.room({ failoverSec: 30 })
    rig.tunnels.set(m.id, true)
    await rig.ready(id, m)
    rig.tunnels.set(m.id, false)
    // The evidence is home's own probe: no second machine that could take the class instead.
    for (let i = 0; i < 8; i++) {
      noteProbe(true, rig.clock.now())
      rig.clock.advance(5000)
      rig.tick()
    }
    assert.equal(placementRow(id, 'room')?.state, 'lost')
  }
  await silence()
  assert.equal(getRunner(m.id)?.classesQuarantinedAt, null, 'one is no pattern')
  rig.sync(m)
  await silence()
  assert.ok(getRunner(m.id)?.classesQuarantinedAt, 'two within the window')
  assert.equal(runnerEventsOf(m.id, ['classes_quarantined'], 0).length, 1)
  // A quarantine keeps new placements away and closes nothing.
  const id = rig.room({ fallback: true })
  rig.tunnels.set(m.id, true)
  rig.sync(m)
  assert.equal(await (await rig.place(id)).ensuring, null)
  assert.equal(rig.placements.tunnelWanted(m.id), 'open', 'a quarantine never closes the tunnel')
  assert.ok(resumeRunnerClasses(m.id, rig.clock.now()))
  rig.sync(m)
  void rig.place(id)
  await flush()
  assert.equal(livePlacement(id, 'room')?.runnerId, m.id, 'resumed, it takes classes again')
  // One more silence after the resume is the first of a new window.
  await silence()
  assert.equal(getRunner(m.id)?.classesQuarantinedAt, null)
})

test('one disappearance is one: two classes moving at their own failoverSec, in passes apart, quarantine nothing; a second disappearance does', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const witness = rig.machine()
  const fast = rig.room({ failoverSec: 30 })
  const slow = rig.room({ failoverSec: 60 })
  await rig.ready(fast, m)
  const { ensuring } = await rig.place(slow)
  rig.report(m, { placements: [rig.held(fast, 'room', 1), rig.held(slow, 'room', 1, 'ready', C2)] })
  await ensuring
  const outage = (seconds: number): void => {
    rig.tunnels.set(m.id, false)
    for (let at = 0; at < seconds; at += 5000) {
      rig.clock.advance(5000)
      rig.sync(witness)
      rig.tick()
    }
  }
  outage(70_000)
  assert.equal(placementRow(fast, 'room')?.reason, 'silence')
  assert.equal(placementRow(slow, 'room')?.reason, 'silence')
  assert.deepEqual(runnerEventsOf(m.id, ['class_failover'], 0).map((line) => line.detail), ['silence'], 'one line for the one outage')
  assert.equal(getRunner(m.id)?.classesQuarantinedAt, null)
  // Back, and gone again with a class on it: twice within the half hour.
  rig.tunnels.set(m.id, true)
  rig.sync(m)
  const third = rig.room({ failoverSec: 30 })
  await rig.ready(third, m)
  outage(40_000)
  assert.equal(placementRow(third, 'room')?.reason, 'silence')
  assert.ok(getRunner(m.id)?.classesQuarantinedAt, 'two disappearances')
})

test('a perimeter that failed closed moves every class of the machine at once, and the owner hears of it once', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const a = rig.room()
  const b = rig.room()
  await rig.ready(a, m)
  await rig.ready(b, m)
  rig.report(m, { classes: { ...GOOD, perimeter: 'failing' } })
  assert.equal(placementRow(a, 'room')?.reason, 'perimeter')
  assert.equal(placementRow(b, 'room')?.reason, 'perimeter')
  rig.report(m, { classes: { ...GOOD, perimeter: 'failing' } })
  assert.equal(runnerEventsOf(m.id, ['perimeter_failing'], 0).length, 1)
  assert.equal(runnerEventsOf(m.id, ['class_failover'], 0).length, 1, 'one line for the machine')
  // Other bad facts only keep new placements away: nothing live moves for them.
  const c = rig.room()
  rig.report(m, { classes: GOOD })
  await rig.ready(c, m)
  rig.report(m, { placements: [rig.held(c, 'room', 1)], classes: { ...GOOD, canary: 'failed: x', hostNetwork: false } })
  assert.equal(livePlacement(c, 'room')?.state, 'ready')
})

test('revoke, unclass and leave move every placement of the machine first; a stop in flight is done', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  await rig.ready(id, m)
  void rig.place(id, 'own')
  await flush()
  assert.equal(rig.placements.failoverRunner(m.id, 'unclassed', rig.clock.now()), 2)
  assert.equal(placementRow(id, 'room')?.reason, 'unclassed')
  assert.match(rig.events.filter((event) => event.kind === 'lost')[0]?.words ?? '', /./)
  // Then the flag goes, as unclassRunner does it.
  updateRunner(m.id, { classes: false })
  // The class clock's backstop: a machine revoked by some other door, and one that left.
  const n = rig.machine()
  const other = rig.room()
  await rig.ready(other, n)
  updateRunner(n.id, { state: 'revoked' })
  rig.tick()
  assert.equal(placementRow(other, 'room')?.reason, 'revoked')
  const gone = rig.machine()
  const leaving = rig.room()
  await rig.ready(leaving, gone)
  updateRunner(gone.id, { state: 'left' })
  rig.tick()
  assert.equal(placementRow(leaving, 'room')?.reason, 'leaving')
  const words = rig.events.filter((event) => event.kind === 'lost' && event.sessionId === leaving)[0]?.words ?? ''
  assert.ok(words.startsWith(tr('server.machineIsBeingDisconnected.6aa752', { machine: gone.name })), words)
})

test('the machine says the container is gone or broken: recreated on the same machine at the same gen, not a failover', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  const { endpoint } = await rig.ready(id, m)
  rig.report(m, { placements: [rig.held(id, 'room', 1, 'starting', C1)] })
  assert.equal(livePlacement(id, 'room')?.state, 'starting', 'the same container taken up again')
  assert.ok(!rig.kinds(id).includes('restarting'), 'no death announced for it')
  rig.report(m, { placements: [rig.held(id, 'room', 1, 'ready', C1)] })
  // Gone: the machine starts it anew, in another container.
  rig.report(m, { placements: [] })
  assert.equal(livePlacement(id, 'room')?.state, 'starting')
  assert.equal(livePlacement(id, 'room')?.gen, 1)
  assert.equal(rig.kinds(id).at(-1), 'restarting')
  const again = rig.placements.ensure(id, 'base', undefined, 2, 4096, 'room')
  await flush()
  rig.report(m, { placements: [rig.held(id, 'room', 1, 'ready', C2)] })
  const fresh = (await again)!
  assert.equal(fresh.identity, `machine:${m.id}:${C2}:1`)
  assert.notEqual(fresh.identity, endpoint.identity)
  assert.equal(runnerEventsOf(m.id, ['class_failover'], 0).length, 0)
})

/* -------------------------------------------- stops, resizes, readings */

test('a stop is durable: stopping, omitted from the reply, stopped once the machine no longer lists it; an owner waits for it', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  await rig.ready(id, m)
  let done = false
  noteCall(m.id, rig.clock.now(), null)
  const stopping = rig.placements.drop(id, ['room', 'own', 'council'], { owner: true }).then(() => (done = true))
  assert.equal(livePlacement(id, 'room')?.state, 'stopping')
  assert.deepEqual(rig.placements.wantedPlacements(m.id), [])
  assert.equal(rig.placements.hasLivePlacements(m.id), true, 'a stop in flight still holds the machine’s syncs short')
  rig.report(m, { placements: [rig.held(id, 'room', 1)] })
  await flush()
  assert.equal(done, false)
  rig.report(m, { placements: [] })
  await stopping
  assert.equal(placementRow(id, 'room')?.state, 'stopped')
  assert.equal(rig.placements.hasLivePlacements(m.id), false)
  assert.ok(rig.tunnels.lostIds.includes(`${m.id}|${id}:room|1`), 'its link is fenced')
  // A stop on a machine that went silent for good is done after five minutes; the machine removes the container if it returns.
  const other = rig.room()
  await rig.ready(other, m)
  void rig.placements.drop(other, ['room'])
  rig.clock.advance(4 * 60_000)
  rig.tick()
  assert.equal(placementRow(other, 'room')?.state, 'stopping')
  rig.clock.advance(60_000)
  rig.tick()
  assert.equal(placementRow(other, 'room')?.state, 'stopped')
})

test('a resize is an intent: applied once the machine answers for those numbers, pending otherwise', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  await rig.ready(id, m)
  const resizing = rig.placements.resize(id, 'room', { memoryMb: 8192 })
  assert.equal(livePlacement(id, 'room')?.memoryMb, 8192)
  // An answer from before the reply that carried the new numbers is about the old ones.
  rig.report(m, { placements: [rig.held(id, 'room', 1, 'ready', C1, { resized: 'applied' })] })
  let outcome: string | null = null
  void resizing.then((value) => (outcome = value))
  await flush()
  assert.equal(outcome, null)
  agentReads(rig.placements.wantedPlacements(m.id))
  rig.report(m, { placements: [rig.held(id, 'room', 1, 'ready', C1, { resized: 'applied' })] })
  assert.equal(await resizing, 'applied')
  // Unreachable: the number waits in the row.
  rig.tunnels.set(m.id, false)
  assert.equal(await rig.placements.resize(id, 'room', { cpus: 4 }), 'pending')
  assert.equal(livePlacement(id, 'room')?.cpus, 4)
})

test('a raise the machine has no room for is refused as here, and a raise it has not applied yet counts for the next', async () => {
  const rig = new Rig()
  // 9000 MB free beside two running 4096 MB slots.
  const m = rig.machine({ free: { memoryMb: 9000 } })
  const a = rig.room()
  const b = rig.room()
  await rig.ready(a, m)
  const { ensuring } = await rig.place(b)
  const running = (limitMb: number) => ({ usedMb: 100, limitMb, cpus: 2, cpuPercent: 1, startedAt: 1, oomKills: 0 })
  rig.report(m, { placements: [rig.held(a, 'room', 1, 'ready', C1, { usage: running(4096) }), rig.held(b, 'room', 1, 'ready', C2, { usage: running(4096) })] })
  await ensuring
  // An answer at once, or the machine's to wait for (a resize sent waits for its `docker update`).
  const outcome = (resizing: Promise<string>): Promise<string> => Promise.race([resizing, flush().then(() => 'sent to the machine')])
  assert.equal(await outcome(rig.placements.resize(a, 'room', { memoryMb: 65_536 })), 'failed')
  assert.equal(livePlacement(a, 'room')?.memoryMb, 4096, 'the row keeps its numbers')
  assert.deepEqual(agentReads(rig.placements.wantedPlacements(m.id)).map((intent) => intent.memoryMb), [4096, 4096])
  // 4096 more fits; until docker gives it (the machine still says 4096), it is not free for another slot.
  assert.equal(await outcome(rig.placements.resize(a, 'room', { memoryMb: 8192 })), 'sent to the machine')
  assert.equal(livePlacement(a, 'room')?.memoryMb, 8192)
  assert.equal(await outcome(rig.placements.resize(b, 'room', { memoryMb: 4096 + 5000 })), 'failed', '9000 − 4096 on its way leaves 4904')
})

test('post-mortem questions go out by key and are answered by the machine’s reading', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room()
  await rig.ready(id, m)
  const asked = rig.placements.reading(id, 'room')
  assert.deepEqual(rig.placements.postmortemWanted(m.id), [`${id}:room`])
  const reading = { limit: 4 * 1024 ** 3, peak: 4 * 1024 ** 3, current: 1024, kills: 3, containerOomKilled: false, status: 'running', exit: null, tail: ['Killed'] }
  rig.report(m, { placements: [rig.held(id, 'room', 1, 'ready', C1, { usage: { usedMb: 100, limitMb: 4096, cpus: 2, cpuPercent: 5, startedAt: 1, oomKills: 3 } })], readings: [{ key: `${id}:room`, gen: 1, reading }] })
  assert.deepEqual(await asked, reading)
  assert.deepEqual(rig.placements.postmortemWanted(m.id), [])
  assert.equal(rig.placements.kills(id, 'room'), 3, 'the census’s counter is the baseline')
})

test('what the machine is asked to hold: the tunnel’s word, its class revisions, a GPU kernel only where there are cards', async () => {
  const rig = new Rig()
  const plain = rig.machine({ up: false })
  assert.equal(rig.placements.tunnelWanted(plain.id), 'reconnect', 'a machine that may take classes keeps its tunnel, so the chooser sees it')
  rig.tunnels.set(plain.id, true)
  assert.equal(rig.placements.tunnelWanted(plain.id), 'open')
  updateRunner(plain.id, { classes: false })
  assert.equal(rig.placements.tunnelWanted(plain.id), 'closed')
  updateRunner(plain.id, { classes: true })
  // Classes set to machines: their images are prefetched, the GPU one only to a machine with cards.
  const gpuClass = `gpu${randomUUID().slice(0, 8)}`
  createSession(gpuClass, 'GPU', 'base-gpu')
  setSessionPlacement(gpuClass, { ...CLASS_PLACEMENT_DEFAULT, room: 'machines' })
  rig.room()
  rig.tick()
  await flush()
  const ids = rig.placements.classRevisionsWanted(plain.id).map((revision) => revision.id)
  assert.ok(ids.includes(rig.revision.id))
  assert.ok(!ids.includes(rig.gpu.id))
  const cards = rig.machine({ cards: [{ device: 'GPU-0', name: null, memoryMb: 24_000, perDevice: 4, busyShares: 0 }] })
  assert.ok(rig.placements.classRevisionsWanted(cards.id).some((revision) => revision.id === rig.gpu.id && revision.gpu))
})

test('a GPU class’s image is wanted as the GPU kernel it is, for a personal slot that holds no card too', async () => {
  const rig = new Rig()
  const m = rig.machine({ cards: [{ device: 'GPU-0', name: 'RTX 4090', memoryMb: 24_564, perDevice: 4, busyShares: 0 }] })
  const id = `gpu${randomUUID().slice(0, 8)}`
  createSession(id, 'GPU', 'base-gpu')
  setSessionPlacement(id, { ...CLASS_PLACEMENT_DEFAULT, room: 'home', own: 'machines' })
  await rig.ready(id, m, 'own')
  assert.equal(livePlacement(id, 'own')?.gpu, null, 'personal notebooks take no card')
  // The bit the leases and the stock give the same id: the machine books an image anew whenever it changes.
  assert.equal(rig.placements.classRevisionsWanted(m.id).find((revision) => revision.id === rig.gpu.id)?.gpu, true)
})

test('help waits min(1000, 2 × RTT p95) on a machine and nothing here', async () => {
  const rig = new Rig()
  const m = rig.machine({ rtt: 120 })
  const id = rig.room()
  await rig.ready(id, m)
  assert.equal(rig.placements.helpPadMs(id, 'room'), 240)
  rig.tunnels.rtts.set(m.id, 900)
  assert.equal(rig.placements.helpPadMs(id, 'room'), 1000)
  assert.equal(rig.placements.helpPadMs(rig.room(), 'room'), 0)
})

/* --------------------------------------------------------- the pool */

test('the pool’s branches: a class on machines gets its endpoint there, is swept, holds 0 MB here, resizes and stops there', async () => {
  const rig = new Rig()
  const m = rig.machine()
  const id = rig.room({ own: 'home' })
  const ensuring = endpointForSession(id, 'base', 'room')
  await flush()
  await flush()
  const row = livePlacement(id, 'room')
  assert.ok(row, 'endpointForSession placed it')
  rig.report(m, { placements: [rig.held(id, 'room', row.gen)] })
  const endpoint = await ensuring
  assert.equal(endpoint.identity, `machine:${m.id}:${C1}:${row.gen}`)
  // 0 MB here, and the idle sweep sees the class.
  const census = await runningKernelLimits()
  assert.deepEqual(census.filter((kernel) => kernel.session === id), [{ session: id, role: 'room', memoryMb: 0, cpus: 0, where: 'machine' }])
  assert.deepEqual((await listRoomKernels()).filter((room) => room.session === id), [{ session: id, running: true, own: false }])
  const readings = (await containerCensus()).containers.filter((container) => container.session === id)
  assert.equal(readings.length, 1)
  assert.equal(readings[0].memoryMb, 0)
  assert.equal(readings[0].machine?.name, getRunner(m.id)!.name)
  // A memory change reaches the machine as an intent.
  const applying = applyMemoryLimit(id, 6144)
  await flush()
  agentReads(rig.placements.wantedPlacements(m.id))
  rig.report(m, { placements: [rig.held(id, 'room', row.gen, 'ready', C1, { resized: 'applied' })] })
  assert.equal(await applying, 'applied')
  // The class ends: its slot stops on the machine.
  await dropRoomKernel(id)
  assert.equal(livePlacement(id, 'room')?.state, 'stopping')
})

test('the fallback here: no machine fits, the slot starts on this server and stays here for the class’s next notebook', async () => {
  const rig = new Rig()
  const id = rig.room()
  const here = await endpointForSession(id, 'base', 'room')
  assert.equal(rig.events.at(-1)?.kind, 'fallback')
  // A machine appears: the slot that runs here keeps running here, never in two places.
  rig.machine()
  const again = await endpointForSession(id, 'base', 'room')
  assert.equal(again.url, here.url)
  assert.equal(livePlacement(id, 'room'), null)
  // Once it stopped, the next start goes to the machine.
  await dropRoomKernel(id)
  void endpointForSession(id, 'base', 'room').catch(() => undefined)
  await flush()
  await flush()
  assert.ok(livePlacement(id, 'room'))
})

test('a warm start puts the slot on a machine, never here: one gen however many ask, and nothing for a slot placed, kept here or computing here', async () => {
  const rig = new Rig()
  const m = rig.machine()
  // Personal notebooks on machines, the class notebook here, and no fallback: a warm start must not need one.
  const id = rig.room({ room: 'home', own: 'machines', fallback: false })
  rig.placements.warmSlot(id, 'own')
  rig.placements.warmSlot(id, 'own')
  // A Run arriving meanwhile waits for the warm start's placement rather than writing a second gen.
  const { ensuring } = await rig.place(id, 'own')
  await flush()
  assert.equal(livePlacement(id, 'own')?.runnerId, m.id, 'warmed on the machine')
  assert.equal(livePlacement(id, 'own')?.gen, 1)
  assert.deepEqual(rig.kinds(id), ['starting'], 'one placement')
  rig.report(m, { placements: [rig.held(id, 'own', 1)] })
  assert.ok(await ensuring, 'the Run gets the warmed kernel')
  rig.placements.warmSlot(id, 'own')
  rig.placements.warmSlot(id, 'room')
  await flush()
  assert.equal(livePlacement(id, 'own')?.gen, 1, 'placed already: nothing')
  assert.equal(livePlacement(id, 'room'), null, 'its class keeps it here: nothing')

  // A Run that comes once the warm start is already placing (looking its image up) waits for that placement: one gen still.
  let looked!: () => void
  const lookup = new Promise<void>((resolve) => (looked = resolve))
  const slow = new ClassPlacements({ clock: rig.clock, tunnels: rig.tunnels, revisionOf: async () => (await lookup, rig.revision), log: () => undefined })
  usePlacements(slow)
  slow.noteKernelsReport(m.id, { placements: [], reports: [], epochs: [], readings: [], tunnel: 'up', classes: GOOD }, rig.clock.now())
  const late = rig.room({ own: 'machines', fallback: false })
  slow.warmSlot(late, 'own')
  await flush()
  const running = slow.ensure(late, 'base', undefined, 2, 4096, 'own')
  running.catch(() => undefined)
  looked()
  await flush()
  await flush()
  assert.equal(livePlacement(late, 'own')?.gen, 1, 'the Run took the warm start’s placement')
  usePlacements(rig.placements)

  // No machine can take it now: nothing here, no fallback said, no refusal, with the fallback on.
  rig.tunnels.set(m.id, false)
  const lone = rig.room({ own: 'machines', fallback: true })
  rig.placements.warmSlot(lone, 'own')
  await flush()
  await flush()
  assert.equal(livePlacement(lone, 'own'), null)
  assert.deepEqual(rig.kinds(lone), [], 'a warm start starts nothing here and says nothing')
  // A slot that computes here already (its fallback) is never started on a machine as well.
  await endpointForSession(lone, 'base', 'own')
  assert.deepEqual(rig.kinds(lone), ['fallback'])
  rig.tunnels.set(m.id, true)
  rig.placements.warmSlot(lone, 'own')
  await flush()
  await flush()
  assert.equal(livePlacement(lone, 'own'), null, 'one slot never computes in two places')
})

test('the process’s listeners and clock follow its placements across a swap: the kernel hooks subscribe once', async () => {
  const heard: string[] = []
  const stop = onPlacementChange((event) => heard.push(event.kind))
  try {
    const first = new Rig()
    assert.equal(placementClock.now(), first.clock.now(), 'the clock of the placements of the moment')
    let fired = 0
    const timer = placementClock.setTimeout(() => fired++, 1_000)
    first.machine()
    await first.place(first.room())
    assert.deepEqual(heard, ['starting'])
    // A harness's next life: other placements, on another clock.
    const second = new Rig()
    second.clock.t = first.clock.t + 3_600_000
    assert.equal(placementClock.now(), second.clock.now())
    // A timer stays with the clock it was set on.
    placementClock.clearTimeout(timer)
    first.clock.advance(5_000)
    assert.equal(fired, 0)
    second.machine()
    await second.place(second.room())
    assert.deepEqual(heard, ['starting', 'starting'], 'the news of the placements swapped in reaches the listener subscribed before')
  } finally {
    stop()
  }
})

test('a class with nothing on machines takes none of the machine branches', async () => {
  new Rig()
  const id = `plain${randomUUID().slice(0, 8)}`
  createSession(id, 'Plain', 'base')
  assert.equal(machinePlaced(id, 'room'), false)
  const endpoint = await endpointForSession(id, 'base', 'room')
  assert.equal(endpoint.link, undefined)
  assert.equal(livePlacement(id, 'room'), null)
})

/* -------------------------------------------------- the seminar door */

function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_name: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

test('the seminar view says where the class computes; its PATCH is the class staff’s, refused to teachers while the owner’s switch is off', async () => {
  new Rig()
  const base = await serve()
  const owner = oldestOwner() ?? createTeacher({ name: 'Владелец', email: 'placement.owner@example.edu', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  const teacher = createTeacher({ name: 'Учитель', email: `placement.${randomUUID().slice(0, 6)}@example.edu`, role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  const id = `sem${randomUUID().slice(0, 8)}`
  createSession(id, 'Seminar', 'base')
  addRoomTeacher(id, teacher.id, owner.id)
  const patch = (cookie: string, body: unknown) =>
    fetch(`${base}/api/admin/seminars/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
  const asTeacher = mintCookie(teacher)
  const asOwner = mintCookie(owner)

  updateClassMachineSettings({ teachers: true })
  let answer = await patch(asTeacher, { placement: { own: 'machines', council: 'machines' } })
  assert.equal(answer.status, 200)
  let body = (await answer.json()) as { placement: ClassPlacement; placementEditable: boolean }
  assert.equal(body.placement.own, 'machines')
  assert.equal(body.placementEditable, true)
  assert.equal(classPlacement(id).council, 'machines')

  updateClassMachineSettings({ teachers: false })
  answer = await patch(asTeacher, { placement: { room: 'machines' } })
  assert.equal(answer.status, 403)
  assert.equal(((await answer.json()) as { error: string }).error, tr('server.onlyTheOwnerDecidesWhereClassesCompute.5ef976'), 'in the teacher’s words')
  assert.equal(classPlacement(id).room, 'home', 'nothing applied')
  // The whole form sent back unchanged is no change to refuse, and the rest of it applies.
  answer = await patch(asTeacher, { name: 'Renamed', placement: classPlacement(id) })
  assert.equal(answer.status, 200)
  body = (await answer.json()) as { placement: ClassPlacement; placementEditable: boolean }
  assert.equal(body.placementEditable, false)
  // The owner always may; a value the setting cannot hold is refused.
  assert.equal((await patch(asOwner, { placement: { room: 'machines' } })).status, 200)
  assert.equal(classPlacement(id).room, 'machines')
  assert.equal((await patch(asOwner, { placement: { failoverSec: 5 } })).status, 400)
  updateClassMachineSettings({ teachers: null })
})
