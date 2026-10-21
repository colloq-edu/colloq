/**
 * Personal notebooks on machines (docs/architecture/remote-classes.md §10):
 * what a class's personal kernels go through in the kernel hooks of
 * kernel/index.ts — the personal kernel ceiling, the idle retirement, the
 * stop of their container, the warm start, failover per slot — what the
 * placement asks of a machine for them (ownLimits, the ledger, no card), and
 * the bounds of a class's memory and cores by where its slots compute.
 *
 * Two rigs, in process. The hooks over a fake placement module and a fake
 * Jupyter behind a road the test opens and closes (tests/_fake-jupyter.mjs ·
 * startFakeLink), as tests/class-kernel-hooks.test.mts has them; and the REAL
 * placement module (kernel/remote/placement.ts) wired into the same hooks as
 * a harness wires it (useClassPlacements with the module), on a clock the
 * test moves, with tunnels whose every placement's port is a real road to
 * the fake Jupyter of its machine. The machines' reports are the contract's
 * shapes sent by hand, as tests/class-placement.test.mts sends them. Waits
 * are polls for an event, never a sleep of the wall clock.
 *
 * And two small ones, for what is held elsewhere: a machine's kernel host
 * (runner-agent/kernels.ts) on a fake docker with a card, as
 * tests/runner-agent-kernels.test.mts stands it up, for the card the
 * personal notebooks' container never gets; and the class form
 * (web/src/admin/ui/Resources.svelte) rendered on the server, as
 * tests/classes-ui-form.test.mts renders it, for the bounds it draws.
 */
import { TEST_ROOT } from './_env.mts'
import { after, afterEach, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Response as ExpressResponse } from 'express'
import type { Component } from 'svelte'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import { WebSocket } from 'ws'
import { guardAnswer } from './_guard.mts'
import { startFakeJupyter, startFakeLink } from './_fake-jupyter.mjs'
import { FACTS, close as closeApp, portableRevision, serve, syncRequest } from './_remote.mts'
import { LAYERS, REVISION, fakeAgentDocker } from './_runner-agent-home.mts'
import { tr } from '../shared/i18n.js'
import { CLASS_PLACEMENT_DEFAULT, STAFF_COOKIE, ownNumberMax, type ClassNumberBounds, type ClassPlacement, type InstanceResources } from '../shared/admin.js'
import {
  parseRemoteKernelsReply,
  remoteRevisionDigest,
  type RemoteClassFacts,
  type RemoteKernelsReply,
  type RemoteKernelsRequest,
  type RemotePlacementHeld,
  type RemotePlacementIntent,
} from '../shared/remote-kernels.js'
import type { RemoteCard, RemoteSyncRequest } from '../shared/remote-runner.js'
import type { TunnelClock } from '../shared/remote-tunnel.js'
import * as notebook from '../shared/notebook.js'
import { signToken, type TokenPayload } from '../server/src/auth.js'
import * as db from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import * as control from '../server/src/control.js'
import * as kernel from '../server/src/kernel/index.js'
import type { ClassClock, ClassPlacements as KernelPlacements, PlacementEvent, PlacementView } from '../server/src/kernel/index.js'
import * as jupyter from '../server/src/kernel/jupyter.js'
import type { KernelLink } from '../server/src/kernel/jupyter.js'
import { applyOwnLimits, endpointForSession, kernelLimits } from '../server/src/kernel/pool.js'
import { cpuBounds, memoryBounds, numberPlaces, placedBounds } from '../server/src/kernel/resources.js'
import { ownPidsLimit } from '../server/src/kernel/perimeter.js'
import { machineRoomContainer } from '../server/src/kernel/room-spec.js'
import { KernelHost } from '../server/src/runner-agent/kernels.js'
import { INSTANCE_LABEL, revisionImage } from '../server/src/runner-agent/images.js'
import type { ProbedCard } from '../server/src/runner-agent/machine.js'
import { stateLayout } from '../server/src/runner-agent/state.js'
import * as placementModule from '../server/src/kernel/remote/placement.js'
import { ClassPlacements, classMachineBounds, usePlacements, type PlacementTunnels } from '../server/src/kernel/remote/placement.js'
import { classPlacement, livePlacement, placementRow } from '../server/src/kernel/remote/placement-store.js'
import { getRevision } from '../server/src/dependencies/store.js'
import { noteSync, resetHeard } from '../server/src/competitions/remote/heard.js'
import { getRunner, joinRunner, mintRemoteCode, setRunnerClasses, updateRunner, type RunnerRow } from '../server/src/competitions/remote/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, oldestOwner, rotateLinkKey } from '../server/src/admin/store.js'
import { setInstanceLanguage } from '../server/src/admin/settings.js'
import { updateClassMachineSettings } from '../server/src/admin/resource-settings.js'

const closing: Array<() => unknown> = []

afterEach(() => {
  kernel.useClassPlacements(null)
  jupyter.useDefaultEndpointForTest(null)
})

after(async () => {
  for (const close of closing.reverse()) {
    try {
      await close()
    } catch {
      // The rest still closes: a socket or a port left open here would outlive the file.
    }
  }
  await kernel.shutdownKernels()
  shutdownCollab()
  usePlacements(null)
  closeApp()
})

setInstanceLanguage('ru')

/* ---------------------------------------------------------------- helpers */

/** Until `what` holds, polled; whether it did. */
async function until(what: () => boolean | Promise<boolean>, polls = 400): Promise<boolean> {
  for (let poll = 0; poll < polls; poll++) {
    if (await what()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return what()
}

/** Let the event loop turn: what was going to happen without a timer has happened by then. */
async function turns(count = 50): Promise<void> {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve))
}

/** A clock the test moves: timers run when it passes them, in order, never on their own. */
class FakeClock implements TunnelClock, ClassClock {
  t = Date.now()
  private next = 1
  private readonly timers = new Map<number, { at: number; run: () => void }>()
  now = (): number => this.t
  setTimeout = (run: () => void, ms: number): unknown => {
    const id = this.next++
    this.timers.set(id, { at: this.t + Math.max(0, ms), run })
    return id
  }
  clearTimeout = (handle: unknown): void => {
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

/** A fake Jupyter of a machine's container (or of this server): interpreted cells, the guard answered, DELETE honoured. */
async function jupyterFake() {
  const fake = await startFakeJupyter({ guardAnswer, interpreter: true, buffer: true, keepAlive: false, deletes: true })
  closing.push(() => fake.close())
  return fake
}
type Fake = Awaited<ReturnType<typeof jupyterFake>>

/** How many DELETEs of a session reached a fake. */
const deletes = (fake: Fake): number =>
  fake.calls.filter((call: { kind: string; method?: string; path?: unknown }) => call.kind === 'http' && call.method === 'DELETE' && /^\/api\/sessions\//.test(String(call.path))).length

/** A class, its people's personal notebooks made in its document and given to them by its rules (§10). */
function personalClass(names: string[], options: { environment?: string; rules?: Record<string, unknown> } = {}) {
  const id = `own${randomUUID().slice(0, 8)}`
  db.createSession(id, `Own ${id}`, options.environment ?? 'base')
  const { doc } = getSessionDoc(id)
  const books = names.map((name, i) => ({ ...notebook.addBook(doc, `${name}.ipynb`), owner: `p_${i}`, name }))
  db.setRules(id, {
    ...db.storedRules(id),
    ownBooks: 'on',
    books: Object.fromEntries(books.map((book) => [book.root, { access: 'owner' as const, owner: book.owner, ownerName: book.name }])),
    ...options.rules,
  })
  const roots = books.map((book) => book.root)
  return {
    id,
    doc,
    roots,
    /** A code cell typed into a notebook (the class notebook by default): its id. */
    cell(source: string, root: string = notebook.CELLS_KEY): string {
      const made = notebook.createCell('code', source)
      notebook.bookCells(doc, root).push([made])
      return notebook.cellId(made)
    },
    run(cell: string, root: string = notebook.CELLS_KEY): void {
      kernel.requestRun(id, [cell], 'Студент', 'p_0', undefined, root)
    },
    said(cell: string): string {
      for (const root of [notebook.CELLS_KEY, ...roots]) {
        const found = notebook.bookCells(doc, root).toArray().find((one) => notebook.cellId(one) === cell)
        if (found) return notebook.readOutputs(found).map((output) => (output.kind === 'stream' ? output.text : output.kind === 'error' ? output.evalue : '')).join('')
      }
      return ''
    },
    state(cell: string): unknown {
      for (const root of [notebook.CELLS_KEY, ...roots]) {
        const found = notebook.bookCells(doc, root).toArray().find((one) => notebook.cellId(one) === cell)
        if (found) return found.get('state')
      }
      return null
    },
    notes: () => notebook.getTerminal(doc).toArray().filter((line) => line.get('kind') === 'system').map((line) => String(line.get('text'))),
    status: (root: string) => notebook.bookKernel(doc, root).status,
  }
}
type Room = ReturnType<typeof personalClass>

/** The instance's personal kernel ceiling for one test (KERNEL_OWN_MAX, read at every start). */
function ownMax(t: TestContext, value: number): void {
  const previous = process.env.KERNEL_OWN_MAX
  process.env.KERNEL_OWN_MAX = String(value)
  t.after(() => {
    if (previous === undefined) delete process.env.KERNEL_OWN_MAX
    else process.env.KERNEL_OWN_MAX = previous
  })
}

/* ---------------------------------------------- rig one: a fake placement module */

const NAME = 'vast-own'

/** A placement module whose slots the test sets, and whose news the test sends. */
function fakePlacements() {
  const views = new Map<string, PlacementView>()
  const listeners = new Set<(event: PlacementEvent) => void>()
  const stops: Array<{ sessionId: string; role: string; gen: number }> = []
  class Lost extends Error {
    constructor(readonly words: string, readonly cause: string) {
      super(words)
    }
  }
  const impl: KernelPlacements = {
    placementOf: (sessionId, role) => views.get(`${sessionId}:${role}`) ?? { where: 'home' },
    placementGate: () => Promise.resolve(),
    onPlacementChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    moveNow: async () => ({ ok: true }),
    helpPadMs: () => 0,
    PlacementLost: Lost,
    stopSlot: (sessionId, role, gen) => {
      stops.push({ sessionId, role, gen })
      return true
    },
  }
  return {
    impl,
    stops,
    set: (sessionId: string, role: string, view: PlacementView) => views.set(`${sessionId}:${role}`, view),
    emit: (event: PlacementEvent) => {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

/**
 * A class whose personal notebooks compute on a pretend machine: its `own`
 * slot is placed there and ready, and every kernel it starts is the machine's
 * fake behind a road of its own, with that placement's identity.
 */
async function machineOwn(t: TestContext, names: string[], gen = 1) {
  const clock = new FakeClock()
  const places = fakePlacements()
  kernel.useClassPlacements(places.impl, clock)
  const machine = await jupyterFake()
  const road = await startFakeLink({ target: machine.port })
  closing.push(() => road.close())
  jupyter.useDefaultEndpointForTest({ url: road.url, token: 'fake', link: road.link, identity: `machine:r1:c1:${gen}` })
  const room = personalClass(names)
  const view = (over: Partial<Extract<PlacementView, { where: 'machine' }>> = {}): PlacementView => ({
    where: 'machine', runnerId: 'r1', name: NAME, gen, state: 'ready', link: road.link, since: clock.now(), failover: 'auto', failoverAt: null, ...over,
  })
  places.set(room.id, 'own', view())
  t.after(async () => {
    await kernel.shutdownSession(room.id).catch(() => {})
  })
  return { clock, places, machine, road, room, view }
}

/* ---------------------------------------------------------------- the ceiling */

test('the personal kernel ceiling counts the kernels coming up as well as the ones up, on the machine: four pressed at once against three, the fourth refused in words', async (t) => {
  const { machine, room } = await machineOwn(t, ['Аня', 'Боря', 'Вера', 'Гоша'])
  ownMax(t, 3)
  // Pressed in one turn, as a class presses Run: none of them is up when the next one asks.
  const starts = room.roots.map((root) => kernel.ensureKernel(room.id, root))
  const settled = await Promise.allSettled(starts)
  assert.deepEqual(settled.map((one) => one.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected'])
  assert.equal((settled[3] as PromiseRejectedResult).reason.message, tr('server.kernel.ownFull', { p0: 3 }), 'the existing words')
  const up = room.roots.filter((root) => machine.kernelAt(jupyter.jupyterSessionPath(room.id, root)) !== null)
  assert.deepEqual(up, room.roots.slice(0, 3), 'three kernels in the machine’s container, the fourth never asked for')
  // Up now, they still count: a fourth start is refused as the fourth press was.
  await assert.rejects(kernel.ensureKernel(room.id, room.roots[3]!), { message: tr('server.kernel.ownFull', { p0: 3 }) })
})

test('kernels on a machine whose road is down still count, and kernels ended by a failover count no more: their notebooks start again', async (t) => {
  const { places, road, room } = await machineOwn(t, ['Аня', 'Боря', 'Вера'])
  ownMax(t, 2)
  await kernel.ensureKernel(room.id, room.roots[0]!)
  await kernel.ensureKernel(room.id, room.roots[1]!)
  // The road goes; the placement has not said so yet (the link knows a moment before). The two Pythons are over there all the same.
  road.down()
  await assert.rejects(kernel.ensureKernel(room.id, room.roots[2]!), { message: tr('server.kernel.ownFull', { p0: 2 }) }, 'no undercount while the machine is away')
  road.up()
  // The slot fails over: both kernels end from outside, and the next start of every notebook is a kernel of its own, counted once.
  const here = await jupyterFake()
  places.set(room.id, 'own', { where: 'home' })
  places.emit({ sessionId: room.id, role: 'own', kind: 'lost', view: { where: 'home' }, cause: 'silence', at: Date.now() })
  assert.ok(await until(() => room.status(room.roots[0]!) === 'off' && room.status(room.roots[1]!) === 'off'))
  jupyter.useDefaultEndpointForTest({ url: here.url, token: 'fake' })
  const again = await Promise.allSettled([kernel.ensureKernel(room.id, room.roots[1]!), kernel.ensureKernel(room.id, room.roots[2]!)])
  assert.deepEqual(again.map((one) => one.status), ['fulfilled', 'fulfilled'], 'the ended kernels hold no place')
  assert.ok(here.kernelAt(jupyter.jupyterSessionPath(room.id, room.roots[2]!)), 'computing here now')
  await assert.rejects(kernel.ensureKernel(room.id, room.roots[0]!), { message: tr('server.kernel.ownFull', { p0: 2 }) }, 'and the ceiling holds there as well')
})

/* ----------------------------------------------------------- idle retirement */

test('a personal kernel idle on a machine that does not answer waits for the road; once it is back it is retired as here, its DELETE reaching the machine', async (t) => {
  const { machine, road, room } = await machineOwn(t, ['Аня'])
  const root = room.roots[0]!
  await kernel.ensureKernel(room.id, root)
  const path = jupyter.jupyterSessionPath(room.id, root)
  assert.ok(machine.kernelAt(path))
  const idle = tr('server.kernel.ownIdle', { p0: 30 })
  road.down()
  await kernel.sweepIdleKernels(Date.now() + 31 * 60_000)
  assert.equal(deletes(machine), 0, 'nothing sent into a road that is down')
  assert.ok(machine.kernelAt(path), 'its Python still there')
  assert.ok(!room.notes().some((note) => note.includes(idle)), 'no note saying it stopped')
  assert.notEqual(room.status(root), 'off')
  road.up()
  await kernel.sweepIdleKernels(Date.now() + 31 * 60_000)
  assert.equal(deletes(machine), 1, 'retired as here: its session deleted on the machine')
  assert.equal(machine.kernelAt(path), null)
  assert.ok(room.notes().some((note) => note.includes(idle)))
  assert.equal(room.status(root), 'off')
})

/* ----------------------------------------- the stop of the container (§10) */

test('a notebook whose personal kernel was refused keeps nothing on the machine: the last kernel retired stops the container, once, at its gen', async (t) => {
  const { places, room } = await machineOwn(t, ['Аня', 'Боря'])
  ownMax(t, 1)
  const [a, b] = room.roots as [string, string]
  await kernel.ensureKernel(room.id, a)
  await assert.rejects(kernel.ensureKernel(room.id, b), { message: tr('server.kernel.ownFull', { p0: 1 }) })
  // Half an hour on, A's kernel retires: B's notebook has no Python anywhere, and the container goes with A's.
  await kernel.sweepIdleKernels(Date.now() + 31 * 60_000)
  assert.deepEqual(places.stops, [{ sessionId: room.id, role: 'own', gen: 1 }])
  // And nothing more, hours on.
  await kernel.sweepIdleKernels(Date.now() + 5 * 60 * 60_000)
  assert.equal(places.stops.length, 1)
})

test('a personal kernel whose placement was stopped under it is ended there and then, with no DELETE; the placement its classmate came up on stops when that one retires', async (t) => {
  const { machine, places, road, room, view } = await machineOwn(t, ['Аня', 'Боря'])
  const [y, x] = room.roots as [string, string]
  await kernel.ensureKernel(room.id, y)
  // Gen 1 is stopped under Y's kernel by nobody here (placement.ts · stopRow: a refused echo, a start given up): its Python goes
  // with that container, and Y's kernel ends now, the room told once for the slot.
  const stopping = view({ state: 'stopping', link: null })
  places.set(room.id, 'own', stopping)
  places.emit({ sessionId: room.id, role: 'own', kind: 'stopping', view: stopping, at: Date.now() })
  const stopped = tr('server.thePersonalNotebooksKernelsOnTheMachine.160525')
  assert.ok(await until(() => room.status(y) === 'off'))
  assert.deepEqual(room.notes().filter((note) => note === stopped), [stopped])
  // X's start places the slot again.
  places.set(room.id, 'own', view({ gen: 2 }))
  jupyter.useDefaultEndpointForTest({ url: road.url, token: 'fake', link: road.link, identity: 'machine:r1:c2:2' })
  await kernel.ensureKernel(room.id, x)
  const moved = tr('server.kernel.bookAccessChanged')
  // X's notebook is a class notebook now: its kernel goes, deleted as here, and Y's holds nothing there, so the container X
  // computed on stops at its gen.
  db.setRules(room.id, { ...db.storedRules(room.id), books: { [y]: db.storedRules(room.id).books![y]! } })
  kernel.syncBookKernels(room.id)
  assert.ok(await until(() => room.notes().filter((note) => note.includes(moved)).length === 1))
  assert.ok(await until(() => places.stops.length === 1))
  assert.deepEqual(places.stops, [{ sessionId: room.id, role: 'own', gen: 2 }])
  assert.equal(deletes(machine), 1, 'X’s kernel deleted as here')
  // Y's goes too, later: nothing more to stop, and no word to the placement taken back.
  db.setRules(room.id, { ...db.storedRules(room.id), books: {} })
  kernel.syncBookKernels(room.id)
  await turns()
  assert.equal(places.stops.length, 1)
  assert.equal(deletes(machine), 1, 'no DELETE for the kernel whose placement was stopped, though its road still answers')
  assert.ok(machine.kernelAt(jupyter.jupyterSessionPath(room.id, y)), 'its Python goes with that placement’s container, not by a word from here')
  assert.deepEqual(room.notes().filter((note) => note === stopped), [stopped], 'said once')
})

/* ----------------------------------------- rig two: the real placement module */

const GOOD: RemoteClassFacts = { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false }
const CONTAINER = (n: number) => String(n).repeat(64).slice(0, 64)

/**
 * The tunnels as a placement reads them: a machine's tunnel up or down by the
 * test's word, and every placement's listener a real road (startFakeLink) to
 * its machine's fake Jupyter, so that the kernel client reaches it as it
 * reaches a placement through home's tunnel.
 */
class RoadTunnels implements PlacementTunnels {
  private readonly state = new Map<string, { up: boolean; since: number }>()
  private readonly targets = new Map<string, number>()
  private readonly roads = new Map<string, Awaited<ReturnType<typeof startFakeLink>>>()
  private readonly lostIds = new Set<string>()
  private readonly changes = new Set<(runnerId: string, up: boolean) => void>()
  constructor(private readonly clock: FakeClock) {}
  machine(runnerId: string, port: number): void {
    this.targets.set(runnerId, port)
    this.set(runnerId, true)
  }
  set(runnerId: string, up: boolean): void {
    this.state.set(runnerId, { up, since: this.clock.now() })
    for (const [id, road] of this.roads) if (id.startsWith(`${runnerId}|`) && !this.lostIds.has(id)) (up ? road.up() : road.down())
    for (const listener of [...this.changes]) listener(runnerId, up)
  }
  isUp(runnerId: string): boolean {
    return this.state.get(runnerId)?.up === true
  }
  since(runnerId: string): number {
    return this.state.get(runnerId)?.since ?? 0
  }
  rtt(): { ewmaMs: number | null; p95Ms: number | null } {
    return { ewmaMs: 5, p95Ms: 5 }
  }
  onChange(listener: (runnerId: string, up: boolean) => void): () => void {
    this.changes.add(listener)
    return () => this.changes.delete(listener)
  }
  async listen(runnerId: string, key: string, gen: number): Promise<{ port: number; close(): void }> {
    const id = `${runnerId}|${key}|${gen}`
    let road = this.roads.get(id)
    if (!road) {
      road = await startFakeLink({ target: this.targets.get(runnerId)!, rttMs: 5 })
      closing.push(() => road!.close())
      this.roads.set(id, road)
      if (!this.isUp(runnerId)) road.down()
    }
    return { port: road.port, close: () => undefined }
  }
  link(runnerId: string, key: string, gen: number): KernelLink {
    const id = `${runnerId}|${key}|${gen}`
    const road = this.roads.get(id)
    if (road) return road.link
    const tunnels = this
    return { get up() { return tunnels.isUp(runnerId) && !tunnels.lostIds.has(id) }, rttMs: null, since: 0, next: async () => (tunnels.lostIds.has(id) ? 'lost' : 'up') }
  }
  lost(runnerId: string, key: string, gen: number): void {
    const id = `${runnerId}|${key}|${gen}`
    this.lostIds.add(id)
    this.roads.get(id)?.lose()
  }
}

let seq = 0

class Rig {
  readonly clock = new FakeClock()
  readonly tunnels = new RoadTunnels(this.clock)
  readonly revision = getRevision(portableRevision('base').id)!
  readonly gpu = getRevision(portableRevision('base-gpu').id)!
  readonly events: PlacementEvent[] = []
  readonly placements: ClassPlacements

  constructor() {
    db.db.prepare('DELETE FROM remote_placements').run()
    db.db.prepare("UPDATE remote_runners SET state = 'revoked' WHERE state IN ('active', 'draining')").run()
    db.db.prepare('DELETE FROM remote_events').run()
    // Well past the boot grace: a silence here is the rule's alone.
    resetHeard(this.clock.now() - 10 * 60_000)
    this.placements = new ClassPlacements({
      clock: this.clock,
      tunnels: this.tunnels,
      revisionOf: async (environment) => (environment === 'base-gpu' ? this.gpu : environment === 'base' ? this.revision : null),
      log: () => undefined,
    })
    usePlacements(this.placements)
    this.placements.onPlacementChange((event) => this.events.push(event))
    // The hooks run on the module, on this clock, as a harness hands it to them (tests/_remote-e2e-home.mts).
    kernel.useClassPlacements(placementModule, this.clock)
  }

  /** A machine that takes classes, synced, its facts good, its tunnel up, its own fake Jupyter behind every placement's road. */
  async machine(options: { name?: string; free?: Partial<RemoteSyncRequest['free']>; cards?: RemoteCard[]; facts?: Partial<typeof FACTS>; trusted?: boolean } = {}) {
    const code = mintRemoteCode({ machines: 1, hours: 1, trusted: options.trusted ?? false, classes: !options.trusted, approvedSlots: null, namePrefix: options.name ?? `own${++seq}`, createdBy: 'tests' }).code
    const joined = joinRunner({ code, joinId: randomUUID().replaceAll('-', ''), build: 'dev', facts: { ...FACTS, ...options.facts }, address: null }, this.clock.now())
    assert.ok(joined.ok)
    const runner = joined.runner
    this.sync(runner, { free: { slots: 4, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000, ...options.free }, cards: options.cards ?? [] })
    this.report(runner)
    const jupyter = await jupyterFake()
    this.tunnels.machine(runner.id, jupyter.port)
    return { runner: getRunner(runner.id)!, jupyter }
  }

  sync(runner: RunnerRow, over: Partial<RemoteSyncRequest> = {}): void {
    noteSync(runner.id, syncRequest({
      free: { slots: 4, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 },
      ready: { revisions: [this.revision.id, this.gpu.id], data: [], sealed: [], bundles: [] },
      ...over,
    }), this.clock.now(), null)
  }

  report(runner: RunnerRow, over: Partial<RemoteKernelsRequest> = {}): void {
    this.placements.noteKernelsReport(runner.id, { placements: [], reports: [], epochs: [], readings: [], tunnel: 'up', classes: GOOD, ...over }, this.clock.now())
  }

  /** What the machine holds of a slot, ready at a gen. */
  held(sessionId: string, role: string, gen: number, container = CONTAINER(gen)): RemotePlacementHeld {
    const revision = livePlacement(sessionId, role as 'room')?.environment === 'base-gpu' ? this.gpu : this.revision
    return { key: `${sessionId}:${role}`, gen, phase: 'ready', container, revision: remoteRevisionDigest(revision.registryRef!) }
  }

  /** A class set to machines as the test says. */
  room(placement: Partial<ClassPlacement>, names: string[] = [], options: { environment?: string; rules?: Record<string, unknown> } = {}): Room {
    const room = personalClass(names, options)
    db.setSessionPlacement(room.id, { ...CLASS_PLACEMENT_DEFAULT, ...placement })
    return room
  }

  /**
   * A kernel of the class brought up as a Run brings it (ensureKernel), its
   * slot placed on a machine on the way and reported ready there by `on`
   * once it is: the machine's every held slot is said again, as its sync
   * says the whole set.
   */
  async up(room: Room, root: string, role: 'room' | 'own', on: { runner: RunnerRow }, holds: RemotePlacementHeld[] = []): Promise<RemotePlacementHeld[]> {
    const started = kernel.ensureKernel(room.id, root)
    started.catch(() => undefined)
    assert.ok(await until(() => livePlacement(room.id, role) !== null), `the ${role} slot placed`)
    const row = livePlacement(room.id, role)!
    assert.equal(row.runnerId, on.runner.id, `the ${role} slot on the machine meant`)
    const all = row.state === 'starting' ? [...holds.filter((one) => one.key !== `${room.id}:${role}`), this.held(room.id, role, row.gen)] : holds
    this.report(on.runner, { placements: all })
    await started
    return all
  }
}

/* -------------------------------------------- the stop of the container (§10) */

test('the last personal kernel retired stops its container on the machine, durably and at its gen: the row stops, the reply leaves it out, the machine’s report ends it', async (t) => {
  const rig = new Rig()
  const m = await rig.machine()
  const room = rig.room({ room: 'home', own: 'machines' }, ['Аня', 'Боря'])
  t.after(() => kernel.shutdownSession(room.id).catch(() => {}))
  const here = await jupyterFake()
  jupyter.useDefaultEndpointForTest({ url: here.url, token: 'fake' })
  const holds = await rig.up(room, room.roots[0]!, 'own', m)
  await kernel.ensureKernel(room.id, room.roots[1]!)
  const placed = livePlacement(room.id, 'own')!
  assert.equal(placed.state, 'ready')
  assert.equal(m.jupyter.byPath.size, 2, 'two personal kernels in the one container')
  assert.equal(here.byPath.size, 0, 'none here')

  // One retires: its kernel goes on the machine, the container stays for the other.
  db.setRules(room.id, { ...db.storedRules(room.id), books: { [room.roots[1]!]: db.storedRules(room.id).books![room.roots[1]!]! } })
  kernel.syncBookKernels(room.id)
  assert.ok(await until(() => m.jupyter.kernelAt(jupyter.jupyterSessionPath(room.id, room.roots[0]!)) === null))
  assert.equal(livePlacement(room.id, 'own')?.state, 'ready', 'one kernel left: the container stays')

  // The last one retires for idleness: its container stops there at its gen, whatever the machine says next.
  await kernel.sweepIdleKernels(Date.now() + 31 * 60_000)
  assert.equal(deletes(m.jupyter), 2, 'each kernel’s DELETE reached the machine, as here')
  const stopping = placementRow(room.id, 'own')!
  assert.deepEqual([stopping.state, stopping.gen], ['stopping', placed.gen], 'a durable stop of that placement')
  assert.deepEqual(rig.placements.wantedPlacements(m.runner.id).map((intent) => intent.key), [], 'the reply leaves it out: the machine removes it')
  rig.report(m.runner, { placements: holds })
  assert.equal(placementRow(room.id, 'own')?.state, 'stopping', 'still listed: still stopping')
  rig.report(m.runner, { placements: [] })
  assert.deepEqual([placementRow(room.id, 'own')?.state, placementRow(room.id, 'own')?.gen], ['stopped', placed.gen])
})

test('a personal kernel ended by its machine’s loss is let go of with no word to it, and its retirement stops no placement the slot got since', async (t) => {
  const rig = new Rig()
  const first = await rig.machine({ name: 'own-a' })
  const second = await rig.machine({ name: 'own-b' })
  const room = rig.room({ room: 'home', own: 'machines' }, ['Аня'])
  t.after(() => kernel.shutdownSession(room.id).catch(() => {}))
  const root = room.roots[0]!
  // Whichever machine the chooser takes first: the other is where the slot goes next.
  const started = kernel.ensureKernel(room.id, root)
  assert.ok(await until(() => livePlacement(room.id, 'own') !== null))
  const [on, other] = livePlacement(room.id, 'own')!.runnerId === first.runner.id ? [first, second] : [second, first]
  rig.report(on.runner, { placements: [rig.held(room.id, 'own', 1)] })
  await started
  assert.ok(on.jupyter.kernelAt(jupyter.jupyterSessionPath(room.id, root)))

  // Lost: the kernel ends from outside, the room told once in its own words, nothing sent to the machine.
  rig.placements.failoverRunner(on.runner.id, 'leaving', rig.clock.now())
  assert.ok(await until(() => room.status(root) === 'off'))
  assert.ok(room.notes().includes(`${tr('server.theMachineIsBeingDisconnected.126fbe')} ${tr('server.thePersonalNotebooksKernelsWillStartAgain.7cdaa6')}`), room.notes().join('\n'))
  // Someone comes in: the slot is warmed up again on the other machine, at the next gen. No kernel starts for anyone.
  rig.placements.warmSlot(room.id, 'own')
  assert.ok(await until(() => livePlacement(room.id, 'own')?.gen === 2))
  assert.equal(livePlacement(room.id, 'own')!.runnerId, other.runner.id)
  // The ended kernel's notebook sits idle and retires: no DELETE to the lost placement, and the warm container stays.
  await kernel.sweepIdleKernels(Date.now() + 31 * 60_000)
  assert.equal(deletes(on.jupyter), 0, 'no DELETE ever reached the lost placement')
  assert.equal(livePlacement(room.id, 'own')?.state, 'starting', 'gen 2 is not the retired kernel’s to stop')
  assert.equal(other.jupyter.byPath.size, 0, 'and nobody’s kernel was started behind their back')
})

test('a personal kernel whose placement was stopped under it (a refused echo) ends at the stop: its place under the ceiling comes back at once', async (t) => {
  const rig = new Rig()
  const m = await rig.machine({ name: 'own-fenced' })
  const room = rig.room({ room: 'home', own: 'machines' }, ['Аня', 'Боря'])
  t.after(() => kernel.shutdownSession(room.id).catch(() => {}))
  const [a, b] = room.roots as [string, string]
  await rig.up(room, a, 'own', m)
  const row = livePlacement(room.id, 'own')!
  // The machine says the slot runs in a container of its own making whose image is not the one pinned: home stops it there,
  // under the kernel, and its road with it.
  rig.report(m.runner, { placements: [{ key: `${room.id}:own`, gen: row.gen, phase: 'ready', container: CONTAINER(7), revision: `sha256:${'0'.repeat(64)}` }] })
  assert.equal(placementRow(room.id, 'own')?.state, 'stopping')
  // Ended now, not at the idle sweep half an hour on: the room told once, no word to the machine.
  assert.ok(await until(() => room.status(a) === 'off'))
  assert.ok(room.notes().includes(tr('server.thePersonalNotebooksKernelsOnTheMachine.160525')), room.notes().join('\n'))
  assert.equal(deletes(m.jupyter), 0)
  // The machine has removed the container; with one personal kernel allowed, a classmate's comes up at once.
  rig.report(m.runner, { placements: [] })
  ownMax(t, 1)
  await rig.up(room, b, 'own', m)
  assert.ok(m.jupyter.kernelAt(jupyter.jupyterSessionPath(room.id, b)))
  // And A's next Run starts a kernel of its own, refused by the ceiling as any other would be: nothing of the old one counts.
  await assert.rejects(kernel.ensureKernel(room.id, a), (error: Error) => error.message === tr('server.kernel.ownFull', { p0: 1 }))
})

test('a slot set to machines with more than this server can give does not fall back here when no machine takes it: the room reads why, and within the bound it falls back as before', async (t) => {
  const rig = new Rig()
  // Everything on machines, falling back here (the default), and no machine at all.
  const room = rig.room({ room: 'machines', own: 'machines' })
  t.after(() => kernel.shutdownSession(room.id).catch(() => {}))
  const here = await jupyterFake()
  jupyter.useDefaultEndpointForTest({ url: here.url, token: 'fake' })
  // A number a big machine allowed once (kernel/resources.ts · placedBounds), past this server's.
  const memory = memoryBounds()
  db.setSessionMemoryMb(room.id, memory.max + 8_192)
  const words = tr('server.noMachineCanTakeTheKernelNow.f1fc7d', { max: memory.max, mb: memory.max + 8_192 })
  await assert.rejects(kernel.ensureKernel(room.id), { message: words })
  assert.ok(room.notes().includes(words), room.notes().join('\n'))
  assert.equal(here.byPath.size, 0, 'nothing started here')
  db.setSessionMemoryMb(room.id, null)
  db.setSessionCpus(room.id, cpuBounds().max + 1)
  await assert.rejects(kernel.ensureKernel(room.id), { message: tr('server.noMachineCanTakeTheKernelNow.81688a', { max: cpuBounds().max, cpus: cpuBounds().max + 1 }) })
  // Within this server's bounds it starts here, with the fallback's note.
  db.setSessionCpus(room.id, null)
  await kernel.ensureKernel(room.id)
  assert.ok(here.kernelAt(jupyter.jupyterSessionPath(room.id, notebook.CELLS_KEY)))
  assert.ok(room.notes().includes(tr('server.noMachineCanTakeTheKernelNow.53437e')))
})

/* ---------------------------------------------------------- failover per slot */

test('failover is per slot: the personal notebooks’ machine lost moves no class notebook kernel; personal kernels come back at their next Run, here, never before', async (t) => {
  const rig = new Rig()
  const b = await rig.machine({ name: 'own-own' })
  // vsos's default (D31): the class notebook here, the personal notebooks on the machine.
  const room = rig.room({ room: 'home', own: 'machines' }, ['Аня', 'Боря'])
  t.after(() => kernel.shutdownSession(room.id).catch(() => {}))
  const here = await jupyterFake()
  jupyter.useDefaultEndpointForTest({ url: here.url, token: 'fake' })

  const x = room.cell('x = 41\nprint(x)')
  room.run(x)
  assert.ok(await until(() => room.state(x) === 'ok'), String(room.said(x)))
  const roomKernel = here.kernelAt(jupyter.jupyterSessionPath(room.id, notebook.CELLS_KEY))
  assert.ok(roomKernel, 'the class notebook computes here')
  const [first, second] = room.roots as [string, string]
  await rig.up(room, first, 'own', b)
  await kernel.ensureKernel(room.id, second)
  assert.ok(b.jupyter.kernelAt(jupyter.jupyterSessionPath(room.id, first)) && b.jupyter.kernelAt(jupyter.jupyterSessionPath(room.id, second)))

  // The personal notebooks' machine goes: each of their kernels is ended, the room told once in their words.
  rig.placements.failoverRunner(b.runner.id, 'leaving', rig.clock.now())
  assert.ok(await until(() => room.status(first) === 'off' && room.status(second) === 'off'))
  assert.equal(placementRow(room.id, 'own')?.state, 'lost')
  const lost = `${tr('server.theMachineIsBeingDisconnected.126fbe')} ${tr('server.thePersonalNotebooksKernelsWillStartAgain.7cdaa6')}`
  assert.deepEqual(room.notes().filter((note) => note === lost), [lost], 'one note for the slot')
  // The class notebook: neither waited nor lost anything.
  assert.equal(room.status(notebook.CELLS_KEY), 'idle')
  const y = room.cell('print(x + 1)')
  room.run(y)
  assert.ok(await until(() => room.state(y) === 'ok'))
  assert.equal(room.said(y), '42\n', 'same kernel, variables and all')
  assert.equal(here.kernelAt(jupyter.jupyterSessionPath(room.id, notebook.CELLS_KEY)), roomKernel)
  rig.placements.classTick(rig.clock.now())
  await turns()
  // Nothing brings a personal kernel back by itself.
  assert.equal(placementRow(room.id, 'own')?.state, 'lost', 'no placement behind the students’ backs')
  assert.equal(here.kernelAt(jupyter.jupyterSessionPath(room.id, first)), null)
  assert.equal(here.kernelAt(jupyter.jupyterSessionPath(room.id, second)), null)

  // A student's next Run brings that one kernel up: the machine it left is avoided, so here (its fallback), in the existing words.
  const z = room.cell('print("снова")', first)
  room.run(z, first)
  assert.ok(await until(() => room.state(z) === 'ok'), room.notes().join('\n'))
  assert.equal(room.said(z), 'снова\n')
  assert.ok(here.kernelAt(jupyter.jupyterSessionPath(room.id, first)), 'computing here')
  assert.equal(here.kernelAt(jupyter.jupyterSessionPath(room.id, second)), null, 'the other one waits for its own Run')
  assert.ok(room.notes().includes(tr('server.noMachineCanTakeTheKernelNow.53437e')), room.notes().join('\n'))
  assert.equal(livePlacement(room.id, 'own'), null)
  assert.equal(deletes(b.jupyter), 0, 'no DELETE to the lost placement')
})

/* ----------------------------------------------- what a machine is asked for */

test('the personal notebooks’ container asks a machine for ownLimits — memory, cores, the personal process ceiling — and never a card, even in a GPU class; the ledger chooses by them', async (t) => {
  const rig = new Rig()
  const pids = process.env.KERNEL_OWN_PIDS
  process.env.KERNEL_OWN_PIDS = '1500'
  t.after(() => {
    if (pids === undefined) delete process.env.KERNEL_OWN_PIDS
    else process.env.KERNEL_OWN_PIDS = pids
  })
  const card: RemoteCard = { device: '0', name: 'RTX 4090', memoryMb: 24_564, perDevice: 1, busyShares: 0 }
  const small = await rig.machine({ name: 'own-small', free: { memoryMb: 6_000, cpus: 16 }, cards: [card] })
  const big = await rig.machine({ name: 'own-big', free: { memoryMb: 32_768, cpus: 16 }, cards: [card] })
  // A GPU class (D31's «Всё на машине с картой» puts its personal notebooks on machines too), the class notebook here.
  const room = rig.room({ room: 'home', own: 'machines' }, ['Аня'], { environment: 'base-gpu', rules: { ownMemoryMb: 6_144, ownCpus: 3 } })
  t.after(() => kernel.shutdownSession(room.id).catch(() => {}))
  assert.deepEqual(kernelLimits(room.id, 'base-gpu', 'own'), { memoryMb: 6_144, cpus: 3 })

  // The ledger is asked for ownLimits: the machine without them free beside the cushion cannot take the slot, the other can.
  const outlook = await rig.placements.outlook(room.id)
  assert.deepEqual(outlook.machines.map((one) => [one.name, one.refusal]).sort(), [[big.runner.name, null], [small.runner.name, 'memory']].sort())
  const placing = endpointForSession(room.id, 'base-gpu', 'own')
  placing.catch(() => undefined)
  assert.ok(await until(() => livePlacement(room.id, 'own') !== null))
  const row = livePlacement(room.id, 'own')!
  assert.equal(row.runnerId, big.runner.id)
  assert.deepEqual([row.memoryMb, row.cpus, row.gpu], [6_144, 3, null], 'no card asked: there is none to name')
  // The intent as the machine's agent reads it: ownLimits, the personal process ceiling, and no card, although both machines have one free.
  const intents = parseRemoteKernelsReply({
    placements: rig.placements.wantedPlacements(big.runner.id), pushes: [], verdicts: [], pulls: [], scan: [], epochs: [], collect: [], postmortem: [],
    rates: { classBulkMBps: 4, machinePaceMBps: 6 }, tunnel: 'open',
  }).placements
  const own = intents.find((intent) => intent.key === `${room.id}:own`)!
  assert.deepEqual([own.memoryMb, own.cpus, own.pids, own.gpu], [6_144, 3, 1_500, false])
  assert.equal(own.pids, ownPidsLimit())
  rig.report(big.runner, { placements: [rig.held(room.id, 'own', row.gen)] })
  await placing

  // The rules change the personal notebooks' numbers: their container there follows, as one here does (applyOwnLimits).
  db.setRules(room.id, { ...db.storedRules(room.id), ownMemoryMb: 8_192, ownCpus: 4 })
  const resized = applyOwnLimits(room.id)
  assert.ok(await until(() => livePlacement(room.id, 'own')?.memoryMb === 8_192))
  assert.equal(livePlacement(room.id, 'own')?.cpus, 4)
  rig.report(big.runner, { placements: [{ ...rig.held(room.id, 'own', row.gen), resized: 'applied' }] })
  rig.clock.advance(60_000)
  await resized
})

/** A placement intent as home sends it: the class notebooks' slot or the personal notebooks', of class `s1`. */
function intentFor(role: 'room' | 'own', gpu: boolean): RemotePlacementIntent {
  return {
    key: `s1:${role}`, gen: 1, environment: 'base', revision: { id: REVISION.id, ref: REVISION.ref, layers: LAYERS },
    memoryMb: 4_096, cpus: 2, pids: role === 'own' ? 2_048 : 512, gpu, network: 'blocked', blockedCidrs: [], token: 'e'.repeat(40), hashSeed: 7, shm: '1g',
  }
}

/** A reply's kernels block, as the agent's sync reads it (parsed: what home may send). */
function kernelsBlock(placements: RemotePlacementIntent[]): RemoteKernelsReply {
  return parseRemoteKernelsReply({
    placements, pushes: [], verdicts: [], pulls: [], scan: [], epochs: [], collect: [], postmortem: [],
    rates: { classBulkMBps: 4, machinePaceMBps: 6 }, tunnel: 'open',
  })
}

/**
 * A machine's kernel host on a fake docker with one card free of everything,
 * its perimeter in place and its canary passed: the agent as
 * tests/runner-agent-kernels.test.mts stands it up, on a clock of its own.
 */
async function cardHost() {
  const layout = stateLayout(fs.mkdtempSync(path.join(TEST_ROOT, 'own-host-')))
  const docker = fakeAgentDocker()
  let now = 1_800_000_000_000
  const cards: ProbedCard[] = [{ device: '0', name: 'RTX 4090', memoryMb: 24_564 }]
  const images = {
    verify: async (revision: { id: string }) => revisionImage(revision.id),
    isReady: (id: string) => id === REVISION.id,
    problemWith: () => null,
    readyIds: () => [REVISION.id],
  }
  const host: KernelHost = new KernelHost({
    layout, docker, images, container: 'colloq-runner', image: null, env: {},
    cards: () => cards,
    cardRuns: () => host.cardRuns(),
    heldGpus: () => ({}),
    diskFreeMb: () => 500_000,
    diskFloorMb: 8_192,
    heardAt: () => now,
    onChange: () => undefined,
    log: () => undefined,
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
    probe: async () => true,
    // The host's own beat never fires by the wall clock here.
    timings: { censusMs: 3_600_000 },
  })
  host.reconcile(kernelsBlock([]))
  await host.idle()
  assert.deepEqual(host.facts(), { hostNetwork: true, perimeter: 'ok', mode: 'blocked', canary: 'ok', sameDaemon: false })
  return { host, docker }
}

test('the personal notebooks’ container never gets a card on its machine: the contract refuses one for it, and an agent handed one anyway runs no --gpus and takes none', async () => {
  // Home asks none (needOf: a card is the class notebooks' slot's alone), and the agent's parser refuses a reply that does.
  assert.throws(() => kernelsBlock([intentFor('own', true)]), /Unexpected card/)
  // Handed one past the parser, the agent still runs the personal notebooks' container without it.
  const { host, docker } = await cardHost()
  host.reconcile({ ...kernelsBlock([]), placements: [intentFor('own', true)] })
  await host.idle()
  assert.equal(host.held().find((one) => one.key === 's1:own')?.phase, 'ready')
  const own = docker.classes.get(machineRoomContainer(INSTANCE_LABEL, 's1', 'own'))!
  assert.ok(!own.args.some((arg) => arg.startsWith('--gpus')), own.args.join(' '))
  assert.deepEqual(host.cardRuns(), [], 'no share of the card held')
  // The card was there to take: the class notebooks' slot of a GPU class takes it whole, on the same machine.
  host.reconcile({ ...kernelsBlock([]), placements: [intentFor('own', true), intentFor('room', true)] })
  await host.idle()
  const room = docker.classes.get(machineRoomContainer(INSTANCE_LABEL, 's1', 'room'))!
  assert.ok(room.args.includes('device=0'), room.args.join(' '))
  assert.deepEqual(host.cardRuns(), [{ device: '0', perDevice: 1 }])
  await host.stop()
})

/* --------------------------------------------------------------- warm start */

/** A control socket that keeps what it is sent (control-welcome.test.mts). */
function socket() {
  const fakeSocket = {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send() {},
    on() {
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fakeSocket.readyState = WebSocket.CLOSED
    },
  }
  return fakeSocket as unknown as WebSocket
}

const studentOf = (sessionId: string): TokenPayload => ({ sessionId, participantId: 'p_student', role: 'participant' })

test('the first participant warms the personal notebooks’ container on a machine, only when the class puts them there and its rules allow one, and no kernel starts for anyone', async (t) => {
  const rig = new Rig()
  const m = await rig.machine()
  const machines = rig.room({ room: 'home', own: 'machines' }, ['Аня'])
  const home = rig.room({ room: 'home', own: 'home' }, ['Боря'])
  // A lecture as vsos's preset makes one (D31): its rules give nobody a personal notebook — ownBooks off, no notebook
  // given to an owner — so a container there could hold nothing, and would hold its memory in the machine's ledger.
  const lecture = `own${randomUUID().slice(0, 8)}`
  db.createSession(lecture, 'Лекция', 'base')
  getSessionDoc(lecture)
  db.setSessionPlacement(lecture, { ...CLASS_PLACEMENT_DEFAULT, room: 'home', own: 'machines' })
  assert.equal(db.storedRules(lecture).ownBooks, 'off')
  t.after(() => {
    for (const one of [machines.id, home.id, lecture]) control.closeControlRoom(one)
  })
  control.handleControlSocket(socket(), lecture, studentOf(lecture))
  control.handleControlSocket(socket(), machines.id, studentOf(machines.id))
  control.handleControlSocket(socket(), home.id, studentOf(home.id))
  assert.ok(await until(() => livePlacement(machines.id, 'own') !== null))
  await turns()
  const warmed = livePlacement(machines.id, 'own')!
  assert.deepEqual([warmed.state, warmed.runnerId, warmed.gen], ['starting', m.runner.id, 1])
  assert.equal(livePlacement(home.id, 'own'), null, 'a class that keeps them here warms nothing')
  assert.equal(livePlacement(lecture, 'own'), null, 'a class whose rules allow no personal notebook warms nothing')
  assert.equal(livePlacement(machines.id, 'room'), null, 'the class notebook stays where its class says')
  rig.report(m.runner, { placements: [rig.held(machines.id, 'own', 1)] })
  assert.equal(livePlacement(machines.id, 'own')?.state, 'ready')
  await turns()
  assert.equal(m.jupyter.byPath.size, 0, 'a container, and no personal kernel in it until someone runs one')
})

/* ------------------------------------------------------------------ bounds */

test('a class number’s bound is the place of every slot it reaches: this server’s, the biggest machine’s, the tighter of the two, named', () => {
  const here = { min: 512, max: 15_360 }
  const machine = { max: 30_000, machine: 'vast-3' }
  assert.deepEqual(placedBounds(here, machine, numberPlaces({ room: 'home', own: 'home' }, true)), { min: 512, max: 15_360, machine: null, here: true, machines: false })
  assert.deepEqual(placedBounds(here, machine, numberPlaces({ room: 'machines', own: 'machines' }, true)), { min: 512, max: 30_000, machine: 'vast-3', here: false, machines: true })
  // The class notebook here and its personal notebooks on machines with the same number (D31): the tighter, here's.
  assert.deepEqual(placedBounds(here, machine, numberPlaces({ room: 'home', own: 'machines' }, true)), { min: 512, max: 15_360, machine: null, here: true, machines: true })
  assert.deepEqual(placedBounds({ min: 512, max: 60_000 }, machine, numberPlaces({ room: 'home', own: 'machines' }, true)), { min: 512, max: 30_000, machine: 'vast-3', here: true, machines: true })
  // Personal notebooks with a number of their own are not this number's: the class notebook's place alone.
  assert.deepEqual(placedBounds({ min: 512, max: 60_000 }, machine, numberPlaces({ room: 'home', own: 'machines' }, false)), { min: 512, max: 60_000, machine: null, here: true, machines: false })
  // No machine can take them: slots set to machines start here (their fallback) or nowhere, and here's bound is the one there is.
  assert.deepEqual(placedBounds(here, null, numberPlaces({ room: 'machines', own: 'machines' }, true)), { min: 512, max: 15_360, machine: null, here: true, machines: true })
  // A tie is this server's, which needs no name.
  assert.equal(placedBounds(here, { max: 15_360, machine: 'vast-3' }, { here: true, machines: true }).machine, null)
})

test('the machines’ bound is the biggest machine that takes classes, by its ledger with nothing held: memory less the host’s reserve and the cushion, cores less one', async () => {
  const rig = new Rig()
  assert.equal(classMachineBounds(), null, 'no machine takes classes')
  const wide = await rig.machine({ name: 'own-wide', facts: { memoryMb: 131_072, cpus: 8 } })
  const fast = await rig.machine({ name: 'own-fast', facts: { memoryMb: 65_536, cpus: 32 } })
  await rig.machine({ name: 'own-trusted', facts: { memoryMb: 262_144, cpus: 64 }, trusted: true })
  const off = await rig.machine({ name: 'own-off', facts: { memoryMb: 200_000, cpus: 48 } })
  setRunnerClasses(off.runner.id, false)
  assert.deepEqual(classMachineBounds(), {
    memoryMb: { max: 131_072 - 2_048 - 256, machine: wide.runner.name },
    cpus: { max: 31, machine: fast.runner.name },
  }, 'each number by its biggest machine; the trusted one and the one that stopped taking classes count for none')
  // Offline or quarantined, a machine that takes classes still counts: the bound does not flap with a missed sync.
  updateRunner(wide.runner.id, { classesQuarantinedAt: rig.clock.now() })
  assert.equal(classMachineBounds()?.memoryMb.machine, wide.runner.name)
  // A slot that needs a whole card — a GPU class's class notebooks (placement.ts · needOf) — has the machines with cards alone.
  const card: RemoteCard = { device: '0', name: 'RTX 4090', memoryMb: 24_564, perDevice: 1, busyShares: 0 }
  const carded = await rig.machine({ name: 'own-card', facts: { memoryMb: 49_152, cpus: 12 }, cards: [card] })
  assert.deepEqual(classMachineBounds({ card: true }), { memoryMb: { max: 49_152 - 2_048 - 256, machine: carded.runner.name }, cpus: { max: 11, machine: carded.runner.name } })
  assert.equal(classMachineBounds()?.memoryMb.machine, wide.runner.name, 'a slot that needs none keeps them all')
  // A machine whose class facts keep it from every placement gives a class nothing: off the host's network, it counts for none.
  rig.report(wide.runner, { classes: { ...GOOD, hostNetwork: false } })
  assert.deepEqual(classMachineBounds(), { memoryMb: { max: 65_536 - 2_048 - 256, machine: fast.runner.name }, cpus: { max: 31, machine: fast.runner.name } })
})

test('a move of where a class computes is refused while the class holds a number the new place cannot give, before anything is written, in words naming both; the seminar says the bounds it is held to', async () => {
  const rig = new Rig()
  const big = await rig.machine({ name: 'own-move', facts: { memoryMb: 262_144, cpus: 64 } })
  const card: RemoteCard = { device: '0', name: 'RTX 4090', memoryMb: 24_564, perDevice: 1, busyShares: 0 }
  const carded = await rig.machine({ name: 'own-move-card', facts: { memoryMb: 32_768, cpus: 8 }, cards: [card] })
  const base = await serve()
  const cookie = staffCookie()
  const call = async (method: string, at: string, body?: unknown) => {
    const answer = await fetch(`${base}${at}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: answer.status, body: (await answer.json()) as { error?: string; bounds?: ClassNumberBounds } }
  }
  const here = memoryBounds()
  const room = rig.room({ room: 'machines', own: 'machines' })
  const plenty = here.max + 8_192
  let answer = await call('PATCH', `/api/admin/seminars/${room.id}`, { memoryMb: plenty })
  assert.equal(answer.status, 200, answer.body.error)
  // What the PATCH held it to, as the class form draws it: the biggest machine's, named.
  assert.deepEqual(answer.body.bounds, {
    memory: { min: here.min, max: 262_144 - 2_048 - 256, machine: big.runner.name, here: false, machines: true },
    cpus: { min: 1, max: 63, machine: big.runner.name, here: false, machines: true },
  })
  // Moved here, it would hold a number this server cannot give: refused, and the setting stays.
  answer = await call('PATCH', `/api/admin/seminars/${room.id}`, { placement: { room: 'home', own: 'home' } })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error, `${tr('server.theClassHasMbOfMemoryLower.e34f97', { mb: plenty })} ${tr('server.memoryOutOfRange', { p0: here.min, p1: here.max })}`)
  assert.deepEqual([classPlacement(room.id).room, classPlacement(room.id).own], ['machines', 'machines'])
  // Lowered first, it moves.
  assert.equal((await call('PATCH', `/api/admin/seminars/${room.id}`, { memoryMb: here.max })).status, 200)
  assert.equal((await call('PATCH', `/api/admin/seminars/${room.id}`, { placement: { room: 'home', own: 'home' } })).status, 200)
  // A GPU class's class notebooks go to a machine with a card alone: moved there, its cores are held to that machine's.
  const gpu = rig.room({}, [], { environment: 'base-gpu' })
  db.setSessionCpus(gpu.id, 8)
  answer = await call('PATCH', `/api/admin/seminars/${gpu.id}`, { placement: { room: 'machines', own: 'machines' } })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error, `${tr('server.theClassHasCoresLowerThemBefore.1f3d8b', { cpus: 8 })} ${tr('server.onTheMachinesThisClassComputesOn.dc2f4b', { min: 1, max: 7, machine: carded.runner.name })}`)
  assert.equal(classPlacement(gpu.id).room, 'home')
})

test('a class’s personal-notebook numbers are held to where their slot computes: the biggest machine’s while it is on machines, this server’s otherwise; the forms draw the same', async () => {
  const rig = new Rig()
  await rig.machine({ name: 'own-rules', facts: { memoryMb: 262_144, cpus: 64 } })
  const base = await serve()
  const here = memoryBounds()
  const room = rig.room({ room: 'home', own: 'machines' }, ['Аня'])
  const participantId = `p_${room.id}_host`
  db.upsertParticipant({ id: participantId, sessionId: room.id, name: 'Ада', avatar: null, role: 'host', tokenHost: true })
  const token = signToken({ sessionId: room.id, participantId, role: 'host', iat: Date.now() })
  const rules = async (patch: Record<string, unknown>) => {
    const answer = await fetch(`${base}/api/sessions/${room.id}/rules`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ rules: patch }) })
    return { status: answer.status, body: (await answer.json()) as { error?: string } }
  }
  // On a machine: more than this server could give, as much as the machine can.
  const plenty = here.max + 8_192
  let answer = await rules({ ownMemoryMb: plenty, ownCpus: cpuBounds().max + 4 })
  assert.equal(answer.status, 200, answer.body.error)
  assert.equal(db.storedRules(room.id).ownMemoryMb, plenty)
  answer = await rules({ ownMemoryMb: 262_144 })
  assert.equal(answer.status, 400, 'never past the biggest machine')
  assert.equal(answer.body.error, tr('server.rules.ownMemoryRefused'))
  // Back here: this server's bound, as always.
  db.setSessionPlacement(room.id, { ...CLASS_PLACEMENT_DEFAULT, own: 'home' })
  answer = await rules({ ownMemoryMb: plenty })
  assert.equal(answer.status, 400)
  // The forms' rows are bounded the same way (shared/admin.ts · ownNumberMax).
  const limits = { min: here.min, max: here.max, cpus: cpuBounds(), machines: classMachineBounds() }
  assert.deepEqual(ownNumberMax(limits, 'machines'), { memoryMb: 262_144 - 2_048 - 256, cpus: 63 })
  assert.deepEqual(ownNumberMax(limits, 'home'), { memoryMb: here.max, cpus: cpuBounds().max })
  assert.deepEqual(ownNumberMax({ ...limits, machines: null }, 'machines'), { memoryMb: here.max, cpus: cpuBounds().max }, 'no machine: they start here')
  for (const form of ['web/src/admin/screens/Seminars.svelte', 'web/src/admin/screens/NewSeminar.svelte']) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', form), 'utf8')
    assert.match(source, /ownNumberMax\(resources\.limits, (ruling\.placement\?|placementShown\?)\.own\)/, form)
    assert.doesNotMatch(source, /maxMemoryMb[=:] ?\{?resources\?\.limits\.max/, `${form} bounds no personal row by this server alone`)
  }
})

function staffCookie(): string {
  const owner = oldestOwner() ?? createTeacher({ name: 'Владелец', email: 'own.owner@example.edu', role: 'owner' })
  assert.ok(owner)
  rotateLinkKey(owner.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, v: string) => (value = v) } as unknown as ExpressResponse, owner)
  return `${STAFF_COOKIE}=${value}`
}

test('the class’s PATCH and its creation refuse a memory or cores past the bound of where its slots compute, in words naming the place; a class here hears what it always heard', async () => {
  const rig = new Rig()
  const m = await rig.machine({ name: 'own-bound', facts: { memoryMb: 32_768, cpus: 8 } })
  const name = m.runner.name
  const base = await serve()
  const cookie = staffCookie()
  const call = async (method: string, at: string, body?: unknown) => {
    const answer = await fetch(`${base}${at}`, { method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: answer.status, body: (await answer.json()) as { error?: string } & Record<string, unknown> }
  }
  const here = memoryBounds()
  const machineMb = 32_768 - 2_048 - 256
  assert.ok(machineMb < here.max, 'the machine is the smaller here')

  // The form's numbers carry the machines' bound beside this server's.
  const resources = await call('GET', '/api/instance/resources')
  assert.deepEqual((resources.body as unknown as InstanceResources).limits.machines, { memoryMb: { max: machineMb, machine: name }, cpus: { max: 7, machine: name } })

  // Everything on machines: the machine's bound, named.
  const all = rig.room({ room: 'machines', own: 'machines' })
  let answer = await call('PATCH', `/api/admin/seminars/${all.id}`, { memoryMb: machineMb + 1 })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error, tr('server.onTheMachinesThisClassComputesOn.8a0084', { min: here.min, max: machineMb, machine: name }))
  assert.equal(db.sessionMemoryMb(all.id), null, 'nothing written')
  assert.equal((await call('PATCH', `/api/admin/seminars/${all.id}`, { memoryMb: machineMb })).status, 200)
  answer = await call('PATCH', `/api/admin/seminars/${all.id}`, { cpus: 8 })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error, tr('server.onTheMachinesThisClassComputesOn.dc2f4b', { min: 1, max: 7, machine: name }))
  assert.equal((await call('PATCH', `/api/admin/seminars/${all.id}`, { cpus: 7 })).status, 200)

  // The class notebook here, personal notebooks on machines with its number: the tighter, the machine's.
  const mixed = rig.room({ room: 'home', own: 'machines' })
  answer = await call('PATCH', `/api/admin/seminars/${mixed.id}`, { memoryMb: machineMb + 512 })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error, tr('server.onTheMachinesThisClassComputesOn.8a0084', { min: here.min, max: machineMb, machine: name }))
  answer = await call('PATCH', `/api/admin/seminars/${mixed.id}`, { cpus: cpuBounds().max })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error, tr('server.onTheMachinesThisClassComputesOn.dc2f4b', { min: 1, max: 7, machine: name }), 'their cores follow the class’s too')
  // Given a number of their own, the personal notebooks are not this number's: the class notebook's place alone, as before machines.
  db.setRules(mixed.id, { ...db.storedRules(mixed.id), ownMemoryMb: 4_096 })
  assert.equal((await call('PATCH', `/api/admin/seminars/${mixed.id}`, { memoryMb: machineMb + 512 })).status, 200)
  answer = await call('PATCH', `/api/admin/seminars/${mixed.id}`, { memoryMb: here.max + 1 })
  assert.equal(answer.body.error, tr('server.memoryOutOfRange', { p0: here.min, p1: here.max }))

  // A class all here: this server's bounds in the words it always had.
  const plain = rig.room({})
  answer = await call('PATCH', `/api/admin/seminars/${plain.id}`, { memoryMb: here.max + 1 })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error, tr('server.memoryOutOfRange', { p0: here.min, p1: here.max }))
  assert.equal((await call('PATCH', `/api/admin/seminars/${plain.id}`, { memoryMb: machineMb + 512 })).status, 200)
  answer = await call('PATCH', `/api/admin/seminars/${plain.id}`, { cpus: cpuBounds().max + 1 })
  assert.equal(answer.body.error, tr('server.cpusOutOfRange', { p0: 1, p1: cpuBounds().max }))

  // A new class under the owner's D31 default puts its personal notebooks on machines: created within their bound only.
  updateClassMachineSettings({ newClasses: 'personal' })
  try {
    answer = await call('POST', '/api/admin/seminars', { name: 'Новое занятие', environment: 'base', memoryMb: machineMb + 512 })
    assert.equal(answer.status, 400)
    assert.equal(answer.body.error, tr('server.onTheMachinesThisClassComputesOn.8a0084', { min: here.min, max: machineMb, machine: name }))
    answer = await call('POST', '/api/admin/seminars', { name: 'Новое занятие', environment: 'base', memoryMb: machineMb + 512, rules: { ownMemoryMb: 4_096 } })
    assert.equal(answer.status, 201, JSON.stringify(answer.body))
  } finally {
    updateClassMachineSettings({ newClasses: null })
  }

  // A machine bigger than this server joins: a number that reaches both is held to this server's, said as this server's.
  await rig.machine({ name: 'own-huge', facts: { memoryMb: 262_144, cpus: 64 } })
  const both = rig.room({ room: 'home', own: 'machines' })
  answer = await call('PATCH', `/api/admin/seminars/${both.id}`, { memoryMb: here.max + 1 })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error, tr('server.onThisServerTheClassMayBe.93fb13', { min: here.min, max: here.max }))
  answer = await call('PATCH', `/api/admin/seminars/${both.id}`, { cpus: cpuBounds().max + 1 })
  assert.equal(answer.body.error, tr('server.onThisServerTheClassMayBe.e52ca3', { min: 1, max: cpuBounds().max }))
})

/* ---------------------------------------------------- the class form's numbers */

let resourcesForm: Component<any> | null = null

/**
 * Resources.svelte rendered on the server, its parts standing in, as
 * tests/classes-ui-form.test.mts renders it: what the class form draws for
 * the numbers it is given.
 */
async function form(): Promise<Component<any>> {
  if (resourcesForm) return resourcesForm
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'own-form-'))
  const stub = path.join(dir, 'component.mjs')
  fs.writeFileSync(stub, 'export default function Stub() {}\n')
  const web = (rel: string) => new URL(`../web/src/${rel}`, import.meta.url).href
  const shared = (rel: string) => new URL(`../shared/${rel}`, import.meta.url).href
  const source = fs.readFileSync(new URL('../web/src/admin/ui/Resources.svelte', import.meta.url), 'utf8')
  let js = compile(source, { filename: 'Resources.svelte', generate: 'server' }).js.code
  for (const [from, to] of [
    ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
    ['svelte', import.meta.resolve('svelte')],
    ['@shared/i18n', shared('i18n.ts')],
    ['@shared/admin', shared('admin.ts')],
    ['@/admin/ui/Check.svelte', pathToFileURL(stub).href],
    ['@/components/ui/Icon.svelte', pathToFileURL(stub).href],
    ['@/components/ui/Skeleton.svelte', pathToFileURL(stub).href],
    ['@/lib/utils', web('lib/utils.ts')],
    ['@/admin/runners', web('admin/runners.ts')],
  ]) js = js.replaceAll(`'${from}'`, JSON.stringify(to))
  const file = path.join(dir, 'Resources.mjs')
  fs.writeFileSync(file, js)
  resourcesForm = (await import(pathToFileURL(file).href)).default as Component<any>
  return resourcesForm
}

test('the class form says the machines’ bound, and this server’s free memory, as the server holds the class’s numbers, never by a rule of its own', async () => {
  const Resources = await form()
  // This server: 15 GB to give, 2 GB free now; the machines (instance-wide): one far bigger, as vsos's are.
  const resources: InstanceResources = {
    memory: { totalMb: 16_384, availableMb: 2_048, source: 'host' },
    cpus: 8,
    gpus: [],
    kernel: { defaultMemoryMb: 4_096, gpuDefaultMemoryMb: 8_192, defaultCpus: 2, perEnvironment: { base: { memoryMb: 4_096, gpu: false } } },
    rooms: [],
    limits: { min: 512, max: 15_360, cpus: { min: 1, max: 8 }, machines: { memoryMb: { max: 62_976, machine: 'vast-big' }, cpus: { max: 31, machine: 'vast-big' } } },
  }
  const draw = (placement: Partial<ClassPlacement>, bounds: ClassNumberBounds | null): string =>
    render(Resources, {
      props: {
        part: 'numbers', resources, loading: false, environment: 'base', memoryMb: 8_192, cpus: null, onmemory() {}, oncpus() {},
        roomId: 'own-form', placement: { ...CLASS_PLACEMENT_DEFAULT, ...placement }, bounds,
      },
    }).body.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
  const overFree = tr('admin.resources.overFree')
  const memory = { min: 512, max: 15_360, machine: null, here: true, machines: true }
  const cores = { min: 1, max: 8, machine: null, here: true, machines: true }
  // vsos's D31: the class notebook here holds the number to this server's, the tighter; no machines' line, and this
  // server's free memory is the class's concern.
  let text = draw({ room: 'home', own: 'machines' }, { memory, cpus: cores })
  assert.ok(!text.includes('На машинах'), text)
  assert.ok(text.includes(overFree), text)
  // Everything on machines: the machines' line, named, and nothing of this server's free memory.
  text = draw({ room: 'machines', own: 'machines' }, { memory: { ...memory, max: 62_976, machine: 'vast-big', here: false }, cpus: { ...cores, max: 31, machine: 'vast-big', here: false } })
  assert.ok(text.includes(tr('admin.resources.machinesBound', { p0: '61.5', p1: '31', p2: 'vast-big' })), text)
  assert.ok(!text.includes(overFree), text)
  // One number held by a machine, the other by this server: that number's line alone.
  text = draw({ room: 'home', own: 'machines' }, { memory: { ...memory, max: 6_144, machine: 'vast-small' }, cpus: cores })
  assert.ok(text.includes(tr('admin.resources.machinesBoundMemory', { p0: '6', p1: 'vast-small' })), text)
  // A form the server said nothing to (a new class): no line, and the warning as before machines.
  text = draw({ room: 'machines', own: 'machines' }, null)
  assert.ok(!text.includes('На машинах'), text)
  assert.ok(text.includes(overFree), text)
})
