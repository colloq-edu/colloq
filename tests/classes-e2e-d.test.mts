/**
 * Classes on machines end to end, group D of docs/architecture/remote-classes.md
 * §17.2: failover and restarts. The home app of this process
 * (tests/_remote-e2e-home.mts) with its tunnel door, machines' agents as
 * processes of their own (tests/_remote-e2e-agent.mts) on the fake docker,
 * whose class containers are fake Jupyters, and a fault proxy before each
 * machine where relay2 stands (tests/_tunnel-fault.mts).
 *
 * THE CLOCKS. The home's liveness runs by hand (`liveness: 'manual'`): every
 * pass of it here is one `pass()`, on the home's clock, which also runs the
 * tunnels, the class placements and the kernel hooks' timers, and on which
 * the machines are heard (heard.ts · useRemoteClock): a minute of a class's
 * silence is a minute of that clock, and a machine that keeps syncing is
 * heard at the time the clock says. The agents keep their own clocks, the
 * wall's, with their sync's hold and backoff shortened (AgentTimings) so
 * that a machine that keeps calling is heard within every pass; what a pass
 * waits for is an event (a sync heard, a probe answered), never a sleep.
 *
 * WHAT IS ASSERTED is what each one sees through their own doors: the room's
 * document (its cells, their outputs, the kernel log's notes, the kernels
 * map's chip), what staff read of a slot (kernelMachineOf, the control
 * socket's `kernel:machine`), the owner's machine page (GET
 * /api/admin/runners/:id) and its log, the database's placement rows, and
 * each class container's Jupyter's own log of every call it took, which
 * outlives the container (keepCalls): no DELETE ever reaches a lost
 * placement. The cells are pressed as the control socket's `run` presses them
 * (kernel/index.ts · requestRun), the class is made and set by the staff's
 * own doors (/api/admin/seminars), the owner's buttons are the owner's doors
 * where the panel has them, and their functions where it does not yet (K9a).
 */
import './_remote-e2e-home.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type * as Y from 'yjs'
import { tr } from '../shared/i18n.js'
import { CLASS_PLACEMENT_DEFAULT, type ClassPlacement } from '../shared/admin.js'
import type { RemoteMachineDetail, RemoteMachinesResponse } from '../shared/remote-admin.js'
import { REMOTE_API_BASE, REMOTE_BOOT_GRACE_MS, REMOTE_BYTES_HEADER, REMOTE_SHA256_HEADER } from '../shared/remote-runner.js'
import { CLASS_EVIDENCE_MS, CLASS_TUNNEL_STUCK_MS, remoteClassPaths } from '../shared/remote-kernels.js'
import { TUNNEL_REPLACEMENTS_ALERT, tunnelUrl } from '../shared/remote-tunnel.js'
import { isTerminal } from '../shared/competitions.js'
import { CELLS_KEY, bookKernel, cellId, createCell, getCells, getTerminal, readOutputs } from '../shared/notebook.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { abandonKernelsForTest, kernelMachineOf, moveKernelNow, onKernelMachineChange, requestCouncilRun, requestRun } from '../server/src/kernel/index.js'
import { runCommand } from '../server/src/kernel/terminal.js'
import { placementOutlook } from '../server/src/kernel/remote/placement.js'
import { livePlacement, placementRow } from '../server/src/kernel/remote/placement-store.js'
import { tunnelReplacementAlert } from '../server/src/kernel/remote/tunnel.js'
import { classPathEvidence, heardAt, lastSync, useRemoteClock } from '../server/src/competitions/remote/heard.js'
import { remoteTick } from '../server/src/competitions/remote/liveness.js'
import { getRunner, remoteEvent, resumeRunnerClasses, runnerEventsOf, setRunnerClasses } from '../server/src/competitions/remote/store.js'
import { wakeRunner } from '../server/src/competitions/remote/wake.js'
import { setCompetitionState } from '../server/src/competitions/store.js'
import { forgetStock } from '../server/src/competitions/remote/want.js'
import { stateLayout } from '../server/src/runner-agent/state.js'
import { AgentTunnel } from '../server/src/runner-agent/tunnel.js'
import { sessionDir, writeText } from '../server/src/workspace.js'
import { instanceTimeZone } from '../server/src/time-zone.js'
import { Agent, createFleet, killAgents, openGate, removeClassContainers, type AgentTimings, type Fleet } from './_remote-e2e-agent.mts'
import { Entrant, Home, competition, kernelRevision, notebook, quietQueue, until, type E2eCompetition } from './_remote-e2e-home.mts'
import { TunnelFault } from './_tunnel-fault.mts'

const home = new Home({ liveness: 'manual' })
let fleet: Fleet

before(async () => {
  fleet = createFleet()
  await home.start()
  // The machines are heard on the home's clock: one that keeps syncing while the clock moves on is not silent.
  useRemoteClock(home.clock)
  // The kernels a class falls back to, here.
  await home.homeJupyter()
  // Out of this life's boot grace before any machine is heard: a failover here is due to its rule alone (D20 starts a new life).
  home.clock.advance(REMOTE_BOOT_GRACE_MS)
  // The classes' image, in the fleet's registry and noted here, as a portable revision of `base` (every class here runs it).
  kernelRevision(fleet)
})

after(async () => {
  await killAgents()
  await removeClassContainers()
  for (const proxy of proxies) await proxy.close()
  await home.close()
  useRemoteClock(null)
})

/* ---------------------------------------------------------------- helpers */

/** An agent's timings for these scenarios: a sync every half second while nothing comes, and quick retries once the path is back. */
const FAST: AgentTimings = { holdMs: { idle: 500, busy: 500 }, backoffMs: { min: 200, max: 2_000 } }

const proxies = new Set<TunnelFault>()

/** Let the event loop turn: what would happen at once, has. */
async function turns(count = 20): Promise<void> {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve))
}

/** A server word with its placeholders as patterns (`fixed` ones as given): what a room reads, whatever the clock said in it. */
function words(key: string, names: readonly string[] = [], fixed: Record<string, string> = {}): RegExp {
  const marks = Object.fromEntries(names.map((name, i) => [name, `\u0000${i}\u0000`]))
  const escaped = tr(key, { ...marks, ...fixed }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\u0000\d+\u0000/g, '.+?')}$`)
}

/** One machine of a scenario: its agent (a process of its own), the fault proxy before it, its id at home. */
interface Machine {
  label: string
  agent: Agent
  proxy: TunnelFault
  runnerId: string
}

/** The room as its people see it: its cells, pressed as the control socket presses them, their outputs, the kernel log. */
interface Room {
  id: string
  doc: Y.Doc
  /** A new code cell at the end of the class notebook: its id. */
  cell(source: string): string
  run(...cells: string[]): void
  state(cell: string): unknown
  said(cell: string): string
  errors(cell: string): Array<{ ename: string; evalue: string }>
  /** The kernel log's system lines, oldest first. */
  notes(): string[]
  /** The class notebook's entry in the kernels map: the chip (where, link). */
  chip(): ReturnType<typeof bookKernel>
  /** Until the cell is done (ok or error), its state. */
  done(cell: string, timeoutMs?: number): Promise<unknown>
  /** The cell done, and ok: what it said otherwise, and the kernel log, in the failure. */
  ok(cell: string): Promise<void>
}

function roomOf(id: string): Room {
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  const find = (wanted: string) => {
    for (const cell of cells) if (cellId(cell) === wanted) return cell
    throw new Error(`no cell ${wanted} in ${id}`)
  }
  return {
    id,
    doc,
    cell(source) {
      const made = createCell('code', source)
      cells.push([made])
      return cellId(made)
    },
    run: (...wanted) => void requestRun(id, wanted, 'Учитель', 'p_teacher', undefined, CELLS_KEY),
    state: (wanted) => find(wanted).get('state'),
    said: (wanted) => readOutputs(find(wanted)).map((output) => (output.kind === 'stream' ? output.text : '')).join(''),
    errors: (wanted) => readOutputs(find(wanted)).flatMap((output) => (output.kind === 'error' ? [{ ename: output.ename, evalue: output.evalue }] : [])),
    notes: () => getTerminal(doc).toArray().filter((line) => line.get('kind') === 'system').map((line) => String(line.get('text'))),
    chip: () => bookKernel(doc, CELLS_KEY),
    done: (wanted, timeoutMs = 30_000) => until(`cell ${wanted} of ${id} to be done`, () => {
      const state = find(wanted).get('state')
      return state === 'ok' || state === 'error' ? state : null
    }, timeoutMs, () => `state ${String(find(wanted).get('state'))}; notes:\n${getTerminal(doc).toArray().map((line) => String(line.get('text'))).join('\n')}`),
    async ok(wanted) {
      const state = await this.done(wanted)
      assert.equal(state, 'ok', `cell ${wanted}: ${JSON.stringify(this.errors(wanted))}\nnotes:\n${this.notes().join('\n')}`)
    },
  }
}

/** What one scenario made, ended with it whatever happens to it: the owner disconnects its machines (each hears 401 and exits). */
class Scene {
  readonly machines: Machine[] = []
  private rooms = 0
  private readonly extras: TunnelFault[] = []
  private readonly competitions: E2eCompetition[] = []

  /** A fault proxy before home of the scenario's own (the relay's leg the home's probe takes, a thief's). */
  async proxy(options: { forwardedFor?: string } = {}): Promise<TunnelFault> {
    const proxy = await TunnelFault.start({ target: home.port, forwardedFor: options.forwardedFor ?? null })
    proxies.add(proxy)
    this.extras.push(proxy)
    return proxy
  }

  /** A live competition of the scenario's own, ended with it (no later scenario's machine prepares it). */
  competition(): E2eCompetition {
    const made = competition(fleet, { perDay: 0 })
    this.competitions.push(made)
    return made
  }

  /** A machine joined through a proxy of its own with a code the owner minted (`classes`: «Принимать занятия»). */
  async machine(label: string, options: { classes?: boolean; address?: string; timings?: AgentTimings } = {}): Promise<Machine> {
    const proxy = await TunnelFault.start({ target: home.port, forwardedFor: options.address ?? null })
    proxies.add(proxy)
    const code = await home.mintCode({ classes: options.classes ?? true })
    // Every machine carries the agent's own image (the perimeter's helper), as a class machine's daemon does: the owner may turn its classes on.
    const agent = new Agent(fleet, `${label}-${randomBytes(2).toString('hex')}`, { join: proxy.joinTarget(code), classes: true, timings: options.timings ?? FAST, keepCalls: true })
    agent.start()
    const runnerId = await until(`${label} to join`, () => agent.identity()?.runnerId, 30_000, () => agent.log())
    const made = { label, agent, proxy, runnerId }
    this.machines.push(made)
    return made
  }

  /** A class made by the staff's own door, its placement set by the same (the class's «Где считается», §6.2). */
  async room(placement: Partial<ClassPlacement>): Promise<Room> {
    this.rooms += 1
    // One core and a gigabyte, as the other scenario files make theirs: the machine offers the host's cores less one, and
    // a scenario of two classes on one machine must fit a 4-core CI runner, or the second quietly computes here.
    const made = await home.admin<{ id: string }>('POST', '/api/admin/seminars', { name: `Занятие D ${this.rooms} ${randomBytes(2).toString('hex')}`, cpus: 1, memoryMb: 1024 })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    const set = await home.admin('PATCH', `/api/admin/seminars/${made.body.id}`, { placement: { ...CLASS_PLACEMENT_DEFAULT, ...placement } })
    assert.equal(set.status, 200, JSON.stringify(set.body))
    return roomOf(made.body.id)
  }

  async end(): Promise<void> {
    // A scenario that crashed the home and failed before its new life leaves it down: the owner's doors need it.
    if (!home.up) await home.restart()
    for (const m of this.machines) {
      m.proxy.heal()
      await home.admin('POST', `/api/admin/runners/${m.runnerId}/revoke`).catch(() => undefined)
    }
    for (const m of this.machines) if (m.agent.running) await m.agent.exit(15_000)
    for (const proxy of [...this.machines.map((m) => m.proxy), ...this.extras]) {
      proxies.delete(proxy)
      await proxy.close()
    }
    for (const c of this.competitions) setCompetitionState(c.id, 'finished')
    if (this.competitions.length > 0) {
      forgetStock()
      quietQueue()
    }
  }
}

/** One scenario: its own machines and classes, ended whatever happens. */
function scenario(name: string, timeoutMs: number, body: (scene: Scene) => Promise<void>): void {
  test(name, { timeout: timeoutMs }, async () => {
    const scene = new Scene()
    try {
      await body(scene)
    } finally {
      await scene.end()
    }
  })
}

/** Until the class's form says the machine takes its slot now (placement.ts · placementOutlook): live, its tunnel up, its facts and image in place. */
async function takes(room: Room, m: Machine): Promise<void> {
  let last = ''
  await until(`${m.label} to take ${room.id}`, async () => {
    const outlook = await placementOutlook(room.id)
    last = JSON.stringify(outlook)
    return outlook.machines.find((one) => one.runnerId === m.runnerId)?.refusal === null
  }, 30_000, () => `${last}\n${m.agent.log()}`)
}

/**
 * One pass of the machines' liveness clock (liveness.ts · remoteTick, every
 * five seconds in production), on the home's clock: `ms` on, the machines
 * named heard since (a sync of theirs at the moved time), the home's own
 * path probed when asked, then the pass. When it ran, on that clock.
 */
async function pass(ms: number, options: { heard?: Machine[]; probe?: 'home' | TunnelFault } = {}): Promise<number> {
  const before = new Map((options.heard ?? []).map((m) => [m, lastSync(m.runnerId)]))
  home.clock.advance(ms)
  const moved = home.clock.now()
  for (const m of options.heard ?? []) {
    /*
     * A sync of its taken in since the clock moved (heard.ts · noteSync), not
     * any call: a frame of a tunnel cut on its way is heard at the moved time
     * as well, and with no sync between two moves of the clock the machine's
     * reports would be twice a move apart, so that the run of them a stuck
     * tunnel is counted from would begin again (placement.ts · streakAt).
     */
    await until(`${m.label} to sync at the moved time`, () => lastSync(m.runnerId) !== before.get(m) && (heardAt(m.runnerId) ?? Number.NEGATIVE_INFINITY) >= moved, 20_000, () => m.agent.log())
  }
  if (options.probe) await home.probe(options.probe === 'home' ? undefined : options.probe)
  const now = home.clock.now()
  remoteTick(now)
  await turns()
  return now
}

/** No DELETE ever reached a placement's container, in any life of its Jupyter (§5.2): the kernel client let go of it, never ended it. */
function noDelete(m: Machine, containerId: string): void {
  const calls = m.agent.jupyterCalls(containerId)
  assert.ok(calls.length > 0, `the container ${containerId.slice(0, 12)} of ${m.label} wrote its calls down`)
  assert.deepEqual(calls.filter((call) => call.kind === 'http' && call.method === 'DELETE'), [], `no DELETE reached ${m.label}'s lost placement`)
}

const QUEUE_DROPPED = 'server.theQueueWasClearedItsCellsCounted.c77303'
const LOST_MID_RUN = 'server.thisCellWasRunningOnTheMachine.8d1959'
const ANOTHER_MACHINE = 'server.theKernelWasStartedOnAnotherMachine.28c860'

/** Staff's sentences with a time (§13.2 «Waiting (staff)»), as the machine's watchers heard them for one class. */
function promisesTo(room: Room, m: Machine): () => string[] {
  const staff: string[] = []
  onKernelMachineChange((sessionId, _role, note) => {
    if (sessionId === room.id && note) staff.push(note)
  })
  const waiting = words('server.machineHasNotAnsweredSinceWaitingUntil.1d012e', ['since', 'until'], { machine: getRunner(m.runnerId)!.name })
  return () => staff.filter((note) => waiting.test(note))
}

/** How many seconds a staff sentence's two clocks («не отвечает с 14:32:05. Ждём до 14:33:05») are apart. */
function promisedSeconds(said: string): number {
  const [quietAt, movesAt] = [...said.matchAll(/(\d\d):(\d\d):(\d\d)/g)].map((clock) => Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]))
  return (movesAt! - quietAt! + 86_400) % 86_400
}

/** What a server word's placeholders say in a note of it: the note read back by its words; null — not a note of them. */
function slotsOf(key: string, names: readonly string[], note: string): Record<string, string> | null {
  const marks = Object.fromEntries(names.map((name, i) => [name, `\u0000${i}\u0000`]))
  const escaped = tr(key, marks).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new RegExp(`^${escaped.replace(/\u0000(\d+)\u0000/g, (_all, i: string) => `(?<${names[Number(i)]}>.+?)`)}$`).exec(note)
  return found?.groups ? { ...found.groups } : null
}

/** A moment of the home's clock as the room's words write one («14:31:58» in the instance's zone): its seconds of the day. */
function secondsOf(at: number): number {
  const [h, m, s] = new Intl.DateTimeFormat('en-GB', { timeZone: instanceTimeZone(), hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(at).split(':').map(Number)
  return h! * 3600 + m! * 60 + s!
}

/** «14:31:58»'s seconds of the day. */
function clockSeconds(text: string): number {
  const [h, m, s] = text.split(':').map(Number)
  return h! * 3600 + m! * 60 + s!
}

/** A file of the class folder here, as text; null — none. */
function fileHere(sessionId: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(sessionDir(sessionId), rel), 'utf8')
  } catch {
    return null
  }
}

/* --------------------------------------------------------------- scenarios */

scenario('D14 · a machine partitioned while another is heard: failover at the class\'s failoverSec on the clock, in words; the queue dropped, the running cell\'s fate unknown; the class back on the other machine; the returning machine removes its container', 90_000, async (scene) => {
  // A takes the class; B, the other machine whose calls prove the path (§11.1), takes classes once the class is on A.
  const [a, b] = await Promise.all([scene.machine('d14a'), scene.machine('d14b', { classes: false })])
  const room = await scene.room({ room: 'machines', failoverSec: 45 })
  await takes(room, a)

  const first = room.cell('x = 5\nprint(x)')
  room.run(first)
  await room.ok(first)
  assert.equal(room.said(first), '5\n')
  const placed = livePlacement(room.id, 'room')!
  assert.equal(placed.runnerId, a.runnerId, 'the class computes on the machine')
  const container = a.agent.classContainer(room.id, 'room')!
  assert.equal(room.chip().where, 'machine')
  // A file the kernel writes before the partition: a sync of the machine's brings it here, and home's verdict goes back (§8.3).
  const writtenFrom = home.clock.now()
  const synced = room.cell('WRITE d14/kept.csv до разрыва')
  room.run(synced)
  await room.ok(synced)
  await until('the kernel\'s file here, agreed in the machine\'s baseline', () => fileHere(room.id, 'd14/kept.csv') === 'до разрыва' && a.agent.roomBaseline(room.id)?.files.has('d14/kept.csv'), 20_000, () => a.agent.log())
  // The owner turns B's classes on: its tunnel comes up, and it could take the class now.
  assert.equal('refused' in setRunnerClasses(b.runnerId, true), false)
  wakeRunner(b.runnerId)
  await takes(room, b)
  const name = getRunner(a.runnerId)!.name
  const staff: string[] = []
  onKernelMachineChange((sessionId, _role, note) => {
    if (sessionId === room.id && note) staff.push(note)
  })

  // A cell running there, and one queued behind it.
  const running = room.cell('HOLD d14')
  const queued = room.cell('print("after")')
  room.run(running, queued)
  const door = a.agent.jupyterOf(container)
  await until('the held cell to run on the machine', async () => (await door.kernels()).some((kernel) => kernel.busy))
  assert.equal(room.state(queued), 'queued')

  // The partition: nothing of A reaches home, nor anything of home A; what was on its way is held, never lost.
  a.proxy.blackhole()
  await turns()
  // What the kernel writes from now on reaches no one: the unsynced tail, lost with the machine (§8.8).
  fs.writeFileSync(path.join(a.agent.roomCopy(room.id), 'd14', 'lost.csv'), 'после разрыва')
  const quietFrom = heardAt(a.runnerId)!
  const failoverMs = 45_000
  let before: number | null = null
  let moved: number | null = null
  let notedAt: number | null = null
  let seen: ReturnType<typeof kernelMachineOf> = null
  for (let i = 0; i < 20 && moved === null; i++) {
    const now = await pass(5_000, { heard: [b] })
    assert.equal(heardAt(a.runnerId), quietFrom, 'nothing of A was heard through the partition')
    if (notedAt === null && room.notes().some((note) => words('server.noConnectionToTheMachineTheKernel.71d94f', ['elapsed']).test(note))) notedAt = now
    if (placementRow(room.id, 'room')?.state === 'lost') moved = now
    else {
      before = now
      seen = kernelMachineOf(room.id, 'room')
      // The chip turns amber as the slot goes unreachable: «ждёт машину» (§13.1 Z5).
      if (seen?.state === 'unreachable') assert.equal(room.chip().link, 'lost')
    }
  }
  assert.ok(moved !== null, 'the class failed over')
  assert.ok(before !== null && before - quietFrom < failoverMs, `no failover before the class's ${failoverMs / 1000} s (the pass before was at ${before! - quietFrom} ms)`)
  assert.ok(moved - quietFrom >= failoverMs, `failed over at ${moved - quietFrom} ms of silence, at the class's ${failoverMs / 1000} s`)
  const row = placementRow(room.id, 'room')!
  assert.deepEqual([row.state, row.reason, row.gen], ['lost', 'silence', placed.gen])
  assert.ok(notedAt !== null && notedAt < moved, 'the room heard that the machine does not answer before it moved')
  // What staff read of the slot (kernelMachineOf, the control socket's `kernel:machine`): out since its last frame, at or before
  // its last call, and moving the class's failoverSec after that call, as it did.
  assert.ok(seen !== null && seen.state === 'unreachable' && seen.since <= quietFrom, JSON.stringify(seen))
  assert.equal(seen.failoverAt, quietFrom + failoverMs, 'staff were shown when it moves')
  // And every sentence with a time they were told while it was quiet, which the next test reads.
  const waiting = words('server.machineHasNotAnsweredSinceWaitingUntil.1d012e', ['since', 'until'], { machine: name })
  d14Told = { said: staff.filter((note) => waiting.test(note)), failoverMs }
  assert.deepEqual(runnerEventsOf(a.runnerId, ['class_failover'], 0).map((line) => line.detail), ['silence'], 'one line in the machine\'s log')
  assert.deepEqual(runnerEventsOf(b.runnerId, ['class_failover'], 0), [], 'the machine that was heard lost nothing')

  // The room's words: the failover, the queue dropped, the running cell's fate unknown; and no machine named.
  await until('the failover in the room', () => room.notes().some((note) => words('server.theMachineHasNotAnsweredSinceThe.aa7fbb', ['since', 'filesAt']).test(note)))
  assert.ok(room.notes().includes(tr(QUEUE_DROPPED)), room.notes().join('\n'))
  assert.equal(await room.done(running), 'error')
  assert.deepEqual(room.errors(running), [{ ename: '', evalue: tr(LOST_MID_RUN) }])
  assert.notEqual(room.state(queued), 'queued', 'the queue was dropped')
  assert.deepEqual(room.said(queued), '', 'and the queued cell never ran')
  assert.ok(!JSON.stringify(room.doc.toJSON()).includes(name), 'the room never names the machine')

  // The next Run brings the class up on the other machine (§11.2 step 4), at the next gen, on a fresh kernel: the variables gone.
  const again = room.cell('print(x)')
  room.run(again)
  assert.equal(await room.done(again), 'error')
  assert.equal(room.errors(again)[0]?.ename, 'NameError')
  const next = livePlacement(room.id, 'room')!
  assert.deepEqual([next.runnerId, next.gen], [b.runnerId, placed.gen + 1], 'placed again, on the machine that answers')
  assert.ok(b.agent.classContainer(room.id, 'room'), 'its container on B')
  assert.equal(room.chip().where, 'machine')
  d14Words = room.notes()

  // The files as the room was told of them: as of the machine's last sync, what it said before is here, the tail is not. And a
  // late upload of the lost gen, the machine's own with its credential, is answered 409 (`revoked`: the agent drops it).
  const failover = room.notes().map((note) => slotsOf('server.theMachineHasNotAnsweredSinceThe.aa7fbb', ['since', 'filesAt'], note)).find(Boolean)!
  const tail = Buffer.from('после разрыва')
  const stale = await fetch(`${home.url}${REMOTE_API_BASE}/${remoteClassPaths.roomFile(room.id, 'd14/lost.csv', placed.gen)}`, {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      authorization: a.agent.authorization(),
      'content-type': 'application/octet-stream',
      'content-encoding': 'gzip',
      [REMOTE_SHA256_HEADER]: createHash('sha256').update(tail).digest('hex'),
      [REMOTE_BYTES_HEADER]: String(tail.length),
    },
    body: gzipSync(tail),
  })
  const files = {
    filesAt: failover.filesAt!,
    window: [secondsOf(writtenFrom), secondsOf(quietFrom)] as const,
    kept: fileHere(room.id, 'd14/kept.csv'),
    lost: fileHere(room.id, 'd14/lost.csv'),
    stale: [stale.status, ((await stale.json()) as { error?: string }).error],
  }

  // The machine comes back: home no longer names its placement, and it removes the container; no DELETE ever reached it.
  a.proxy.heal()
  await until('the returning machine to remove its container', () => a.agent.classContainer(room.id, 'room') === null, 30_000, () => a.agent.log())
  // Then it names what changed in its copy after the move, and the room hears it; none of it is taken. And its copy goes.
  const late = await until('the late changes in the room', () => room.notes().map((note) => slotsOf('server.theMachineCameBackAfterTheMove.f1111a', ['since', 'files'], note)).find(Boolean), 30_000, () => `${room.notes().join('\n')}\n${a.agent.log()}`)
  await until('the returning machine to remove its copy of the class folder', () => !fs.existsSync(a.agent.roomCopy(room.id)) && a.agent.roomBaseline(room.id) === null, 30_000, () => a.agent.log())
  d14Files = { ...files, late: late.files!, lostAfter: fileHere(room.id, 'd14/lost.csv') }
  noDelete(a, container.id)
})

// The sentences with a time D14's staff were told while the machine was quiet (kernel/index.ts · tellOutage, then each new promise).
let d14Told: { said: string[]; failoverMs: number } | null = null

test('D14 · the staff\'s sentence as the machine goes quiet promises the move at the class\'s failoverSec', () => {
  assert.ok(d14Told && d14Told.said.length > 0, 'D14 ran and staff were told when it moves')
  // Every time they were promised, the first one too: no time is promised before what moves the class is known.
  for (const said of d14Told.said) assert.equal(promisedSeconds(said), d14Told.failoverMs / 1000, `staff were told «${said}»`)
})

// What D14's room read once its class came back on the other machine.
let d14Words: string[] | null = null

test('D14 · the room\'s words say where the kernel comes back: never «on this server» for a class back on another machine', () => {
  assert.ok(d14Words, 'D14 ran')
  const here = /на этом сервере|on this server/
  assert.deepEqual(d14Words.filter((note) => here.test(note)), [], 'the room was told its kernel is here while it computes on another machine')
  // Said once the next Run placed it, as the fallback's note says «here» (D16).
  assert.equal(d14Words.filter((note) => note === tr(ANOTHER_MACHINE)).length, 1, d14Words.join('\n'))
})

// What D14's class folder was when the machine was lost and came back (§8.8): the failover's words of it, the files here, the
// lost gen's upload answered, the returning machine's late list as the room heard it.
let d14Files: {
  filesAt: string
  window: readonly [number, number]
  kept: string | null
  lost: string | null
  stale: Array<number | string | undefined>
  late: string
  lostAfter: string | null
} | null = null

test('D14 · files as of the last sync («файлы — по 14:31:58»), the stale gen\'s PUT answered 409, and the returning machine\'s late changes named in the room and refused', () => {
  assert.ok(d14Files, 'D14 ran')
  // «файлы — по …»: the machine's last sync, no earlier than the cell whose file it brought and no later than its last word.
  const [from, to] = d14Files.window
  const at = clockSeconds(d14Files.filesAt)
  assert.ok((at - from + 86_400) % 86_400 <= (to - from + 86_400) % 86_400, `files as of ${d14Files.filesAt}, between the file's sync and the machine's last word`)
  assert.equal(d14Files.kept, 'до разрыва', 'what the machine said before the partition is here')
  assert.equal(d14Files.lost, null, 'the unsynced tail is not')
  assert.deepEqual(d14Files.stale, [409, 'revoked'], 'an upload of the lost gen is refused')
  // The late list names the tail, not what both sides had agreed, and none of it is taken.
  assert.deepEqual(d14Files.late.split(', '), ['d14/lost.csv'])
  assert.equal(d14Files.lostAfter, null, 'refused')
})

scenario('D15 · home\'s own path black-holed — both machines silent, the probe failing: nothing fails over, however long, and everything resumes', 90_000, async (scene) => {
  const [a, b] = await Promise.all([scene.machine('d15a'), scene.machine('d15b')])
  // The relay's leg to home, the way the home's probe of its own path goes (liveness.ts · probeOwnPath).
  const relay = await scene.proxy()
  const room = await scene.room({ room: 'machines' })
  await Promise.all([takes(room, a), takes(room, b)])
  const first = room.cell('x = 5\nprint(x)')
  room.run(first)
  await room.ok(first)
  const placed = livePlacement(room.id, 'room')!
  const host = [a, b].find((m) => m.runnerId === placed.runnerId)!
  const container = host.agent.classContainer(room.id, 'room')!
  assert.equal(await home.probe(relay), true, 'the probe proves the path while it works')

  // Home's own leg goes: no machine is heard, the probe fails. Past the class's failoverSec, past the stuck tunnel's two minutes.
  a.proxy.blackhole()
  b.proxy.blackhole()
  relay.cut()
  await turns()
  const lastHeard = Math.max(heardAt(a.runnerId)!, heardAt(b.runnerId)!)
  let waiting: string | null = null
  for (let moved = 0; moved < 150_000; moved += 5_000) {
    const now = await pass(5_000, { probe: relay })
    // A call counts as evidence for CLASS_EVIDENCE_MS; past that nothing proves the path.
    if (now - lastHeard > CLASS_EVIDENCE_MS) assert.equal(classPathEvidence(now), false, 'nothing proves the path')
    assert.notEqual(placementRow(room.id, 'room')?.state, 'lost', `nothing moved at ${moved + 5_000} ms`)
    // A Run pressed during the outage waits for the machine at the pump's gate.
    if (waiting === null && livePlacement(room.id, 'room')?.state === 'unreachable') {
      waiting = room.cell('print(x)')
      room.run(waiting)
    }
  }
  assert.ok(waiting !== null, 'the slot went unreachable')
  assert.equal(room.state(waiting), 'queued', 'the cell waits for the machine')
  assert.equal(room.chip().link, 'lost', 'the chip says the machine does not answer')
  assert.ok(room.notes().some((note) => words('server.noConnectionToTheMachineTheKernel.71d94f', ['elapsed']).test(note)), room.notes().join('\n'))
  assert.deepEqual([...runnerEventsOf(a.runnerId, ['class_failover'], 0), ...runnerEventsOf(b.runnerId, ['class_failover'], 0)], [])

  // The path back: both heard, the probe passes, the tunnel comes back, and the cell computes with what the kernel kept.
  relay.heal()
  a.proxy.heal()
  b.proxy.heal()
  await pass(5_000, { heard: [a, b], probe: relay })
  // Heard again a beat before its tunnel is back: not a tunnel stuck while syncs came, which they did not.
  assert.notEqual(placementRow(room.id, 'room')?.state, 'lost', `nothing moved as the path came back (${placementRow(room.id, 'room')?.reason})`)
  await until('the slot back', () => livePlacement(room.id, 'room')?.state === 'ready', 30_000, () => host.agent.log())
  await room.ok(waiting)
  assert.equal(room.said(waiting), '5\n', 'the variables lived through it')
  assert.ok(room.notes().some((note) => words('server.theConnectionToTheMachineCameBack.d517ba', ['seconds']).test(note)), 'the room heard it is back')
  assert.equal(room.chip().link, 'ok')
  // A silence is proven only from the end of the blind stretch: the passes after it move nothing either.
  for (let i = 0; i < 3; i++) await pass(5_000, { heard: [a, b], probe: relay })
  assert.equal(livePlacement(room.id, 'room')?.state, 'ready')
  assert.deepEqual([...runnerEventsOf(a.runnerId, ['class_failover'], 0), ...runnerEventsOf(b.runnerId, ['class_failover'], 0)], [])
  noDelete(host, container.id)
})

scenario('D16 · the tunnel down while the syncs flow: no failover at the class\'s failoverSec, and the tunnel\'s failover at CLASS_TUNNEL_STUCK_MS, in words', 90_000, async (scene) => {
  const a = await scene.machine('d16')
  const room = await scene.room({ room: 'machines' })
  await takes(room, a)
  const first = room.cell('x = 5\nprint(x)')
  room.run(first)
  await room.ok(first)
  const placed = livePlacement(room.id, 'room')!
  const container = a.agent.classContainer(room.id, 'room')!
  const promised = promisesTo(room, a)

  // Only the tunnel black-holed: the machine's syncs keep coming, so it is alive but cannot compute for the class (§11.1).
  a.proxy.blackhole({ only: 'tunnel' })
  let downAt: number | null = null
  let before: number | null = null
  let moved: number | null = null
  // Each pass as the home saw it, for a failure's message.
  const seen: string[] = []
  for (let i = 0; i < 30 && moved === null; i++) {
    const now = await pass(10_000, { heard: [a] })
    if (downAt === null && !home.tunnels!.isUp(a.runnerId)) downAt = home.tunnels!.since(a.runnerId)
    seen.push(`${now - (downAt ?? now)} ms: tunnel ${home.tunnels!.isUp(a.runnerId) ? 'up' : 'down'}, heard ${now - heardAt(a.runnerId)!} ms ago, ${placementRow(room.id, 'room')?.state}`)
    if (placementRow(room.id, 'room')?.state === 'lost') moved = now
    else before = now
  }
  const told = (): string => `\n${seen.join('\n')}\n${home.classLines.slice(-6).join('\n')}\n${home.tunnelLines.slice(-6).join('\n')}`
  assert.ok(downAt !== null && moved !== null && before !== null, `the tunnel went down at home, and the class moved${told()}`)
  assert.ok(before - downAt >= CLASS_PLACEMENT_DEFAULT.failoverSec * 1000, `the class's failoverSec passed with nothing moved (the last pass ${before - downAt} ms after the tunnel went)${told()}`)
  assert.ok(before - downAt < CLASS_TUNNEL_STUCK_MS && moved - downAt >= CLASS_TUNNEL_STUCK_MS, `moved ${moved - downAt} ms after the tunnel went down, at CLASS_TUNNEL_STUCK_MS${told()}`)
  const row = placementRow(room.id, 'room')!
  assert.deepEqual([row.state, row.reason, row.gen], ['lost', 'tunnel', placed.gen])
  assert.deepEqual(runnerEventsOf(a.runnerId, ['class_failover'], 0).map((line) => line.detail), ['tunnel'])
  assert.ok(room.notes().some((note) => words('server.noConnectionToTheMachineTheKernel.71d94f', ['elapsed']).test(note)), 'the room heard there is no connection')
  await until('the failover in the room', () => room.notes().some((note) => words('server.theMachineHasNotAnsweredSinceThe.aa7fbb', ['since', 'filesAt']).test(note)))
  // Staff were promised the stuck tunnel's two minutes from its going down, once its syncs showed it alive: never a silence's time.
  assert.ok(promised().length > 0, 'staff were told when it moves')
  for (const said of promised()) assert.equal(promisedSeconds(said), CLASS_TUNNEL_STUCK_MS / 1000, said)

  const again = room.cell('print(x)')
  room.run(again)
  assert.equal(await room.done(again), 'error')
  assert.equal(room.errors(again)[0]?.ename, 'NameError', 'a fresh kernel, here')
  assert.equal(livePlacement(room.id, 'room'), null, 'nothing of the class on a machine')
  assert.ok(room.notes().includes(tr('server.noMachineCanTakeTheKernelNow.53437e')), 'the room heard where its kernel went')
  assert.ok(!room.notes().includes(tr(ANOTHER_MACHINE)), 'and only that')
  assert.equal(room.chip().where, null)
  a.proxy.heal()
  await until('the machine to remove the lost placement\'s container', () => a.agent.classContainer(room.id, 'room') === null, 30_000, () => a.agent.log())
  noDelete(a, container.id)
})

scenario('D16 · a stuck tunnel whose syncs then stop too: staff are told again, the class\'s failoverSec from its last word, and the silence moves it', 90_000, async (scene) => {
  const a = await scene.machine('d16s')
  const room = await scene.room({ room: 'machines', failoverSec: 30 })
  await takes(room, a)
  const first = room.cell('x = 5\nprint(x)')
  room.run(first)
  await room.ok(first)
  const container = a.agent.classContainer(room.id, 'room')!
  const promised = promisesTo(room, a)

  // The tunnel alone first: its syncs show the machine alive, and staff are promised the stuck tunnel's two minutes.
  a.proxy.blackhole({ only: 'tunnel' })
  for (let i = 0; i < 10 && promised().length === 0; i++) await pass(5_000, { heard: [a] })
  assert.deepEqual(promised().map(promisedSeconds), [CLASS_TUNNEL_STUCK_MS / 1000], 'the stuck tunnel\'s time')

  // Then all of it: once its silence is what moves the class, staff hear that time instead, counted from the machine's last word.
  a.proxy.blackhole()
  let before: number | null = null
  let moved: number | null = null
  for (let i = 0; i < 20 && moved === null; i++) {
    const now = await pass(5_000, { probe: 'home' })
    if (placementRow(room.id, 'room')?.state === 'lost') moved = now
    else before = now
  }
  assert.ok(moved !== null && before !== null, 'the class moved')
  // Nothing of it got through since: its last word is the last it said before the black hole.
  const lastWord = heardAt(a.runnerId)!
  assert.deepEqual(promised().map(promisedSeconds), [CLASS_TUNNEL_STUCK_MS / 1000, 30], 'told again, once, with the silence\'s time')
  assert.ok(before - lastWord < 30_000 && moved - lastWord >= 30_000, `moved ${moved - lastWord} ms after its last word: the class's 30 s`)
  assert.deepEqual([placementRow(room.id, 'room')!.state, placementRow(room.id, 'room')!.reason], ['lost', 'silence'])
  // The room heard of the outage once: what staff are promised is theirs.
  assert.equal(room.notes().filter((note) => words('server.noConnectionToTheMachineTheKernel.71d94f', ['elapsed']).test(note)).length, 1, room.notes().join('\n'))
  a.proxy.heal()
  await until('the machine to remove the lost placement\'s container', () => a.agent.classContainer(room.id, 'room') === null, 30_000, () => a.agent.log())
  noDelete(a, container.id)
})

scenario('D17 · «ждать машину»: no failover however long the machine is silent, until «Перенести сейчас», which moves at once', 90_000, async (scene) => {
  const a = await scene.machine('d17')
  const room = await scene.room({ room: 'machines', failover: 'wait' })
  await takes(room, a)
  const first = room.cell('x = 5\nprint(x)')
  room.run(first)
  await room.ok(first)
  const container = a.agent.classContainer(room.id, 'room')!
  const name = getRunner(a.runnerId)!.name
  const staff: string[] = []
  onKernelMachineChange((sessionId, _role, note) => {
    if (sessionId === room.id && note) staff.push(note)
  })

  a.proxy.blackhole()
  let waiting: string | null = null
  for (let moved = 0; moved < 180_000; moved += 5_000) {
    await pass(5_000, { probe: 'home' })
    assert.notEqual(placementRow(room.id, 'room')?.state, 'lost', `nothing moved at ${moved + 5_000} ms of silence, the path proven`)
    if (waiting === null && livePlacement(room.id, 'room')?.state === 'unreachable') {
      waiting = room.cell('print(x)')
      room.run(waiting)
    }
  }
  assert.ok(waiting !== null)
  assert.equal(room.state(waiting), 'queued')
  // Staff read that the class waits for its machine, with no time it moves by itself; the room that the machine does not answer.
  const seen = kernelMachineOf(room.id, 'room')!
  assert.deepEqual([seen.state, seen.failover, seen.failoverAt], ['unreachable', 'wait', null])
  assert.ok(staff.some((note) => words('server.machineHasNotAnsweredSinceWaitingFor.5afc55', ['since'], { machine: name }).test(note)), staff.join('\n'))
  assert.ok(room.notes().some((note) => words('server.noConnectionToTheMachineTheKernel.71d94f', ['elapsed']).test(note)))

  // «Перенести сейчас»: the slot moves this moment.
  assert.deepEqual(await moveKernelNow(room.id, null, 'Учитель'), { ok: true })
  const row = placementRow(room.id, 'room')!
  assert.deepEqual([row.state, row.reason], ['lost', 'moved'], 'moved at once')
  assert.deepEqual(runnerEventsOf(a.runnerId, ['class_failover'], 0).map((line) => line.detail), ['moved: Учитель'])
  await until('the move in the room', () => room.notes().some((note) => words('server.theMachineHasNotAnsweredSinceThe.aa7fbb', ['since', 'filesAt']).test(note)))
  assert.ok(room.notes().includes(tr(QUEUE_DROPPED)), 'the waiting cell went with the queue')
  await until('the waiting cell let go of', () => room.state(waiting!) !== 'queued')
  assert.equal(room.said(waiting), '')
  const again = room.cell('print(x)')
  room.run(again)
  assert.equal(await room.done(again), 'error')
  assert.equal(room.errors(again)[0]?.ename, 'NameError')
  assert.equal(getRunner(a.runnerId)!.classesQuarantinedAt, null, 'a move by hand counts for no quarantine')
  a.proxy.heal()
  await until('the machine to remove the moved placement\'s container', () => a.agent.classContainer(room.id, 'room') === null, 30_000, () => a.agent.log())
  noDelete(a, container.id)

  // «Перенести на сервер» on a machine that answers (§11.1): the same move at once, said without a silence, and the machine
  // lets its container go at its next sync.
  const other = await scene.room({ room: 'machines' })
  await takes(other, a)
  const set = other.cell('x = 7\nprint(x)')
  other.run(set)
  await other.ok(set)
  const answering = a.agent.classContainer(other.id, 'room')!
  // A cell still running there has just written a file no scan has brought yet: the move brings it first (§8.7), the files as
  // of the move, not of the last scan.
  const writing = other.cell('WRITE moved/last.csv перед переездом\nHOLD d17move')
  other.run(writing)
  const door = a.agent.jupyterOf(answering)
  await until('the cell holding on the machine, its file written', async () => (await door.kernels()).some((kernel) => kernel.busy) && fs.existsSync(path.join(a.agent.roomCopy(other.id), 'moved', 'last.csv')))
  assert.equal(fileHere(other.id, 'moved/last.csv'), null, 'not here before the move')
  assert.equal(livePlacement(other.id, 'room')?.state, 'ready')
  assert.deepEqual(await moveKernelNow(other.id, null, 'Учитель'), { ok: true })
  assert.equal(fileHere(other.id, 'moved/last.csv'), 'перед переездом', 'the machine\'s last file came before the slot left it')
  assert.deepEqual([placementRow(other.id, 'room')!.state, placementRow(other.id, 'room')!.reason], ['lost', 'moved'])
  await until('the move in the room', () => other.notes().includes(tr('server.theKernelWillStartAgainTheVariables.a76610')), 10_000, () => other.notes().join('\n'))
  await until('the machine that answers to remove the container', () => a.agent.classContainer(other.id, 'room') === null, 30_000, () => a.agent.log())
  const here = other.cell('print(x)')
  other.run(here)
  assert.equal(await other.done(here), 'error')
  assert.equal(other.errors(here)[0]?.ename, 'NameError', 'here, on a fresh kernel')
  noDelete(a, answering.id)
})

scenario('D18 · the agent SIGKILLed and started again: its class container adopted, x = 5 survives print(x), and the shell\'s pty is kept', 90_000, async (scene) => {
  const a = await scene.machine('d18')
  const room = await scene.room({ room: 'machines' })
  await takes(room, a)
  const first = room.cell('x = 5\nprint(x)')
  room.run(first)
  await room.ok(first)
  const container = a.agent.classContainer(room.id, 'room')!
  const door = a.agent.jupyterOf(container)
  const kernels = (await door.kernels()).map((kernel) => kernel.id)
  // The shared terminal in the class container, its shell one folder up: a fresh pty would be back in the class folder.
  const shell = (command: string): Promise<string> =>
    new Promise((resolve) => runCommand(room.id, command, { name: 'Учитель', color: '#336699', participantId: 'p_teacher' }, (result) => resolve(result.output)))
  const up = await shell('cd .. && pwd')
  assert.match(up, /rooms/, up)

  // SIGKILL: nothing handed back, nothing said; the container runs on.
  await a.agent.kill()
  await until('home to see the machine\'s tunnel go', () => !home.tunnels!.isUp(a.runnerId))
  await until('the slot unreachable', () => livePlacement(room.id, 'room')?.state === 'unreachable')
  assert.equal(a.agent.classContainer(room.id, 'room')?.pid, container.pid, 'the container outlives its agent')

  // Started again: it adopts the container, home hears it hold the same one, and the tunnel comes back.
  a.agent.start()
  await until('the adopted slot to be ready again', () => livePlacement(room.id, 'room')?.state === 'ready' && home.tunnels!.isUp(a.runnerId), 30_000, () => a.agent.log())
  assert.ok(a.agent.lines.some((line) => /class container\(s\) adopted/.test(line)), a.agent.log())
  assert.equal(livePlacement(room.id, 'room')!.container, container.id, 'the same container, the same gen')
  assert.equal(a.agent.classContainer(room.id, 'room')!.pid, container.pid, `adopted as it ran, never started again:\n${a.agent.log()}`)
  const after = room.cell('print(x)')
  room.run(after)
  await room.ok(after)
  assert.equal(room.said(after), '5\n', 'the variables lived through the agent\'s death')
  assert.deepEqual((await door.kernels()).map((kernel) => kernel.id), kernels, 'the same kernel, found again by its session path')
  const pwd = await shell('pwd')
  assert.equal(pwd.trim().split('\n').at(-1), up.trim().split('\n').at(-1), 'the same shell: still one folder up')
  const calls = a.agent.jupyterCalls(container.id)
  assert.equal(calls.filter((call) => call.kind === 'http' && call.method === 'POST' && call.path === '/api/terminals').length, 1, 'one pty, made once')
  assert.equal(placementRow(room.id, 'room')!.gen, livePlacement(room.id, 'room')!.gen)
  assert.deepEqual(runnerEventsOf(a.runnerId, ['class_failover'], 0), [])
  noDelete(a, container.id)
})

scenario('D19 · bye{restart}: no failover within its 120 s grace however silent the machine; past it the silence counts; the agent back adopts what was kept', 90_000, async (scene) => {
  const a = await scene.machine('d19')
  // Two classes on the one machine: one that moves once its time is up, one that waits for the machine.
  const moving = await scene.room({ room: 'machines' })
  const kept = await scene.room({ room: 'machines', failover: 'wait' })
  await takes(moving, a)
  await takes(kept, a)
  for (const room of [moving, kept]) {
    const first = room.cell('x = 5\nprint(x)')
    room.run(first)
    await room.ok(first)
  }
  const containers = { moving: a.agent.classContainer(moving.id, 'room')!, kept: a.agent.classContainer(kept.id, 'room')! }

  // colloq-host runner update: the marker, then docker stop. The agent's last sync says why it is the last.
  fs.writeFileSync(stateLayout(a.agent.root).restartMarker, '')
  assert.equal((await a.agent.terminate()).code, 0, a.agent.log())
  assert.ok(home.classLines.some((line) => line.includes(`machine ${a.runnerId} is restarting its agent`)), home.classLines.join('\n'))
  assert.ok(
    a.agent.classContainer(moving.id, 'room')?.status === 'running' && a.agent.classContainer(kept.id, 'room')?.status === 'running',
    `the containers run on: ${JSON.stringify([a.agent.classContainer(moving.id, 'room'), a.agent.classContainer(kept.id, 'room')])}\n${a.agent.log()}`,
  )
  const byeAt = heardAt(a.runnerId)!
  await until('the slots unreachable', () => livePlacement(moving.id, 'room')?.state === 'unreachable')
  const due = kernelMachineOf(moving.id, 'room')!.failoverAt!
  // The grace counts from the sync that said the bye; the machine's last word may be its tunnel's last frame, a moment later:
  // to the second staff read, the end of the grace.
  assert.ok(due - byeAt > 119_000 && due - byeAt < 121_000, `staff are told it moves at the end of the grace (${due - byeAt} ms after the bye)`)

  // Silent, the path proven: past the class's failoverSec, nothing moves until the grace is over.
  let moved: number | null = null
  let before: number | null = null
  for (let i = 0; i < 40 && moved === null; i++) {
    const now = await pass(5_000, { probe: 'home' })
    assert.notEqual(placementRow(kept.id, 'room')?.state, 'lost')
    if (placementRow(moving.id, 'room')?.state === 'lost') moved = now
    else before = now
  }
  assert.ok(moved !== null && before !== null)
  assert.ok(before < due && before - byeAt > CLASS_PLACEMENT_DEFAULT.failoverSec * 1000, `nothing moved in the grace, well past the class's failoverSec (${before - byeAt} ms)`)
  assert.ok(moved >= due, 'the class moved once the grace was over')
  assert.equal(placementRow(moving.id, 'room')!.reason, 'silence')
  assert.ok(moving.notes().some((note) => note === tr('server.theAgentOnTheMachineIsUpdating.d5b483')), `the room heard the agent updates:\n${moving.notes().join('\n')}`)

  // The update done: the agent back adopts the class that waited; the moved one's container goes.
  a.agent.start()
  await until('the class that waited to be back', () => livePlacement(kept.id, 'room')?.state === 'ready' && home.tunnels!.isUp(a.runnerId), 30_000, () => a.agent.log())
  const after = kept.cell('print(x)')
  kept.run(after)
  await kept.ok(after)
  assert.equal(kept.said(after), '5\n', 'adopted with its variables')
  assert.equal(a.agent.classContainer(kept.id, 'room')!.pid, containers.kept.pid)
  await until('the moved class\'s container to go', () => a.agent.classContainer(moving.id, 'room') === null, 30_000, () => a.agent.log())
  noDelete(a, containers.moving.id)
  noDelete(a, containers.kept.id)

  // A stop that is no update (`docker stop`, no marker): its last sync says `stopping`, and the silence counts from there.
  const plain = await scene.room({ room: 'machines' })
  await takes(plain, a)
  const set = plain.cell('x = 5\nprint(x)')
  plain.run(set)
  await plain.ok(set)
  const plainContainer = a.agent.classContainer(plain.id, 'room')!
  assert.equal((await a.agent.terminate()).code, 0, a.agent.log())
  const stopAt = heardAt(a.runnerId)!
  let plainMoved: number | null = null
  let plainBefore: number | null = null
  for (let i = 0; i < 20 && plainMoved === null; i++) {
    const now = await pass(5_000, { probe: 'home' })
    if (placementRow(plain.id, 'room')?.state === 'lost') plainMoved = now
    else plainBefore = now
  }
  assert.ok(plainMoved !== null && plainBefore !== null)
  const failoverMs = CLASS_PLACEMENT_DEFAULT.failoverSec * 1000
  assert.ok(plainBefore - stopAt < failoverMs && plainMoved - stopAt >= failoverMs, `moved ${plainMoved - stopAt} ms after a plain stop: at the class's failoverSec, no grace`)
  assert.equal(placementRow(plain.id, 'room')!.reason, 'silence')
  assert.notEqual(placementRow(kept.id, 'room')?.state, 'lost', 'the class that waits for its machine still does')
  noDelete(a, plainContainer.id)
})

scenario('D20 · home crashes mid-cell and starts again: nothing fails over in its boot grace, however silent the machine; the kernel re-attached by its session path, its orphaned cell let go', 90_000, async (scene) => {
  const a = await scene.machine('d20')
  // Two classes on the machine: one that waits for it (the one mid-cell), one that moves once a rule lets it.
  const room = await scene.room({ room: 'machines', failover: 'wait' })
  const moving = await scene.room({ room: 'machines' })
  await takes(room, a)
  await takes(moving, a)
  // A file both sides agree on before the crash: saved here, on the machine before the first Run there (the barrier).
  assert.ok(writeText(room.id, 'd20/agreed.csv', 'было до падения'))
  for (const each of [room, moving]) {
    const first = each.cell('x = 5\nprint(x)')
    each.run(first)
    await each.ok(first)
  }
  const container = a.agent.classContainer(room.id, 'room')!
  const movingContainer = a.agent.classContainer(moving.id, 'room')!
  const door = a.agent.jupyterOf(container)
  const kernels = (await door.kernels()).map((kernel) => kernel.id)
  await until('the file agreed in the machine\'s baseline', () => a.agent.roomBaseline(room.id)?.files.has('d20/agreed.csv'), 20_000, () => a.agent.log())
  // The pushes of the whole folder the machine applied, as its log says them.
  const whole = (): number => a.agent.lines.filter((line) => line.includes(`class ${room.id}: push `) && line.includes('the whole folder')).length
  const wholeBefore = whole()
  const held = room.cell('HOLD d20')
  room.run(held)
  await until('the held cell to run on the machine', async () => (await door.kernels()).some((kernel) => kernel.busy))
  const gen = livePlacement(room.id, 'room')!.gen
  // And a council attempt computing in the other class's kernel there, as the console's card hears it.
  const attempt: Array<string | null> = []
  const council = moving.cell('answer = None')
  requestCouncilRun(moving.id, { cellId: council, participantId: 'p_pupil', source: 'HOLD d20c', by: 'author', limitSec: null, onChange: (run) => attempt.push(run?.state ?? null) }, 'Ученик', 'p_pupil')
  const movingDoor = a.agent.jupyterOf(movingContainer)
  await until('the attempt to run on the machine', async () => attempt.at(-1) === 'running' && (await movingDoor.kernels()).some((kernel) => kernel.busy))

  // The home dies mid-cell, its rooms' kernels forgotten as a dead process forgets them, and its new life comes up while the
  // machine cannot reach it.
  a.proxy.blackhole()
  abandonKernelsForTest()
  // While home is down the kernel there writes one file and removes another: what only the machine's full report tells the next life.
  fs.writeFileSync(path.join(a.agent.roomCopy(room.id), 'd20', 'while-down.csv'), 'пока сервер лежал')
  fs.rmSync(path.join(a.agent.roomCopy(room.id), 'd20', 'agreed.csv'))
  const heardOfAttempt = attempt.length
  await home.restart()
  const bootAt = home.clock.now()
  let movedAt: number | null = null
  let before: number | null = null
  for (let i = 0; i < 45 && movedAt === null; i++) {
    const now = await pass(5_000, { probe: 'home' })
    if (placementRow(moving.id, 'room')?.state === 'lost') movedAt = now
    else before = now
  }
  // The path proven all along and the machine silent since this life began: past the class's failoverSec, nothing moved until
  // the boot grace was over, and the class that waits for its machine did not move at all.
  assert.ok(movedAt !== null && before !== null, 'the class moved once the grace was over')
  assert.ok(before - bootAt < REMOTE_BOOT_GRACE_MS && before - bootAt > CLASS_PLACEMENT_DEFAULT.failoverSec * 1000, `nothing moved in the boot grace (the last pass ${before - bootAt} ms into it)`)
  assert.ok(movedAt - bootAt >= REMOTE_BOOT_GRACE_MS)
  assert.equal(placementRow(moving.id, 'room')!.reason, 'silence')
  assert.notEqual(placementRow(room.id, 'room')?.state, 'lost')
  assert.deepEqual(runnerEventsOf(a.runnerId, ['class_failover'], 0).map((line) => line.detail), ['silence'])

  // The machine reaches the new life: the same placement, reachable again.
  a.proxy.heal()
  await until('the placement back', () => livePlacement(room.id, 'room')?.state === 'ready' && home.tunnels!.isUp(a.runnerId), 30_000, () => a.agent.log())
  assert.equal(livePlacement(room.id, 'room')!.gen, gen)
  // A file saved here now: the next Run there waits for this life's copy, rebuilt from the machine's full report, and its push.
  assert.ok(writeText(room.id, 'd20/after.csv', 'после перезапуска'))
  const after = room.cell('print(x)')
  room.run(after)
  await room.ok(after)
  assert.equal(room.said(after), '5\n', 'the variables lived through the home\'s crash')
  assert.deepEqual((await door.kernels()).map((kernel) => kernel.id), kernels, 're-attached by its session path: the same kernel')
  // releaseOrphanedWork: the cell the dead life left computing is interrupted before anything of the new life's is sent.
  const calls = a.agent.jupyterCalls(container.id)
  assert.ok(calls.some((call) => call.kind === 'http' && call.method === 'POST' && call.path === `/api/kernels/${kernels[0]}/interrupt`), 'the orphaned cell was interrupted')
  assert.ok(room.notes().includes(tr('server.reconnectedToTheExistingKernelTheRunning.a20941')), room.notes().join('\n'))
  assert.equal(room.state(held), 'idle', 'the cell the dead life left running reads so no more')
  // The dead life said nothing more of its attempt: no end, no interruption (the next life reads it as a crash leaves it).
  assert.deepEqual(attempt.slice(heardOfAttempt), [], `the attempt after the crash: ${JSON.stringify(attempt)}`)
  // The class folder's state, rebuilt from the machine's full report (§8.4): the write made while home was down came here, the
  // removal went, and the file saved here since was on the machine before the Run: a push of the copy rebuilt, never the whole
  // folder again.
  const there = (rel: string): string | null => {
    try {
      return fs.readFileSync(path.join(a.agent.roomCopy(room.id), rel), 'utf8')
    } catch {
      return null
    }
  }
  d20Files = { wrote: fileHere(room.id, 'd20/while-down.csv'), removed: fileHere(room.id, 'd20/agreed.csv') === null, wholeBefore, whole: whole() - wholeBefore, after: there('d20/after.csv') }
  await until('the moved class\'s container to go', () => a.agent.classContainer(moving.id, 'room') === null, 30_000, () => a.agent.log())
  noDelete(a, container.id)
  noDelete(a, movingContainer.id)
})

// What D20's class folder came to in the new life of the home (§8.4, §11.4).
let d20Files: { wrote: string | null; removed: boolean; wholeBefore: number; whole: number; after: string | null } | null = null

test('D20 · the files\' state rebuilt from the machine\'s full reports after a home restart: what the kernel wrote and removed while home was down comes here, and the copy is never pushed whole again', () => {
  assert.ok(d20Files, 'D20 ran')
  assert.equal(d20Files.wrote, 'пока сервер лежал', 'written while home was down: here by the first Run of the new life')
  assert.equal(d20Files.removed, true, 'removed while home was down: gone here')
  assert.ok(d20Files.wholeBefore >= 1, 'the first life pushed the copy whole once, as the machine\'s log says')
  assert.equal(d20Files.whole, 0, 'the next life rebuilt what both sides agreed, and pushed nothing whole')
  assert.equal(d20Files.after, 'после перезапуска', 'a file saved here reached the machine before the Run, a push of the rebuilt copy')
})

/**
 * The kinds of the lines on the owner's machine page (GET /api/admin/runners/:id), newest first. The class kinds
 * (store.ts · REMOTE_CLASS_EVENT_KINDS) come through as the log has them; the panel's type names them with their words in K9a.
 */
async function pageKinds(m: Machine): Promise<string[]> {
  const page = await home.admin<RemoteMachineDetail>('GET', `/api/admin/runners/${m.runnerId}`)
  assert.equal(page.status, 200)
  return page.body.events.map((event) => event.kind as string)
}

/** Until the owner's list says the machine takes the competition (its image and data in place there). */
async function readyFor(m: Machine, c: E2eCompetition): Promise<void> {
  await until(`${m.label} to take ${c.slug}`, async () => {
    const list = await home.admin<RemoteMachinesResponse>('GET', '/api/admin/runners')
    return list.body.machines.find((one) => one.id === m.runnerId)?.readiness.find((entry) => entry.competitionId === c.id)?.verdict === 'taking'
  }, 30_000, () => m.agent.log())
}

/** A participant's submission, settled: its state as they see it. */
async function settled(entrant: Entrant, id: string): Promise<string> {
  return until(`submission ${id} to end`, async () => {
    const seen = await entrant.submission(id)
    return isTerminal(seen.state) ? seen.state : null
  }, 30_000)
}

scenario('D21 · revoke, «Не принимает занятия» and leave: each fails its machine\'s class over at once, in the owner\'s words; submissions keep flowing after the unclass', 120_000, async (scene) => {
  quietQueue()
  const c = scene.competition()
  const started = tr('server.theKernelWillStartAgainTheVariables.a76610')
  // A machine to revoke and one to unclass, the second taking no classes until the owner turns them on, so that each class has
  // its own; the one that leaves joins later, when the other two are done with classes.
  const [revoked, unclassed] = await Promise.all([scene.machine('d21r'), scene.machine('d21u', { classes: false })])
  const classOn = async (m: Machine, room: Room): Promise<void> => {
    if (!getRunner(m.runnerId)!.classes) assert.equal('refused' in setRunnerClasses(m.runnerId, true), false)
    wakeRunner(m.runnerId)
    await takes(room, m)
    const first = room.cell('x = 5\nprint(x)')
    room.run(first)
    await room.ok(first)
    assert.equal(livePlacement(room.id, 'room')!.runnerId, m.runnerId)
  }
  const movedHere = async (room: Room, said: string): Promise<void> => {
    await until(`the owner's words in ${room.id}`, () => room.notes().includes(said), 10_000, () => room.notes().join('\n'))
    const again = room.cell('print(x)')
    room.run(again)
    assert.equal(await room.done(again), 'error')
    assert.equal(room.errors(again)[0]?.ename, 'NameError', 'the next Run computes here, on a fresh kernel')
  }

  // Revoke («Отключить»), by the owner's door: the class moves first, then the machine hears 401, removes its class containers and goes.
  const r = await scene.room({ room: 'machines' })
  await classOn(revoked, r)
  const rContainer = revoked.agent.classContainer(r.id, 'room')!
  assert.ok(fs.existsSync(path.join(stateLayout(revoked.agent.root).roomsDir, r.id)), 'the class folder\'s copy on the machine')
  assert.equal((await home.admin('POST', `/api/admin/runners/${revoked.runnerId}/revoke`)).status, 200)
  assert.deepEqual([placementRow(r.id, 'room')!.state, placementRow(r.id, 'room')!.reason], ['lost', 'revoked'], 'moved at once')
  await movedHere(r, `${tr('server.theOwnerDisconnectedTheMachine.0660fa')} ${started}`)
  assert.equal((await revoked.agent.exit(20_000)).code, 0, revoked.agent.log())
  assert.equal(revoked.agent.classContainers().length, 0, 'the revoked machine removed its class containers')
  assert.equal(fs.existsSync(path.join(stateLayout(revoked.agent.root).roomsDir, r.id)), false, 'and the class folder\'s copy')
  noDelete(revoked, rContainer.id)

  // «Не принимает занятия», while the machine runs a submission: the class moves, the container goes, the submissions go on.
  const u = await scene.room({ room: 'machines' })
  await classOn(unclassed, u)
  const uContainer = unclassed.agent.classContainer(u.id, 'room')!
  await readyFor(unclassed, c)
  const entrant = await new Entrant(home, c).join()
  const during = await entrant.submit(notebook({ gate: `d21-${u.id}` }, 2))
  await until('the submission to run on the machine', async () => (await entrant.submission(during.id)).state === 'running', 30_000, () => unclassed.agent.log())
  // A cell still running there has just written a file no scan has brought yet: the owner's unclass brings it first (§11.5),
  // as «Перенести сейчас» does, the files as of the unclass and not of the last scan.
  const uWriting = u.cell('WRITE out/u.csv перед отключением\nHOLD d21u')
  u.run(uWriting)
  const uDoor = unclassed.agent.jupyterOf(uContainer)
  await until('the cell holding on the machine, its file written', async () => (await uDoor.kernels()).some((kernel) => kernel.busy) && fs.existsSync(path.join(unclassed.agent.roomCopy(u.id), 'out', 'u.csv')))
  assert.equal(fileHere(u.id, 'out/u.csv'), null, 'not here before the unclass')
  // By the owner's door («Не принимает занятия»): the files first, then the class moves.
  assert.equal((await home.admin('PATCH', `/api/admin/runners/${unclassed.runnerId}`, { classes: false })).status, 200)
  assert.equal(fileHere(u.id, 'out/u.csv'), 'перед отключением', 'the machine\'s last file came before the class left it')
  assert.deepEqual(runnerEventsOf(unclassed.runnerId, ['unclassed'], 0).map((line) => line.detail), ['moved 1'])
  assert.deepEqual([placementRow(u.id, 'room')!.state, placementRow(u.id, 'room')!.reason], ['lost', 'unclassed'])
  await movedHere(u, `${tr('server.theMachineIsNoLongerTrustedTo.7919d7')} ${started}`)
  await until('the unclassed machine to remove its class container', () => unclassed.agent.classContainer(u.id, 'room') === null, 30_000, () => unclassed.agent.log())
  // Its wind-down ends with the first sync that lists no class container (routes.ts · windDownBlock).
  await until('the wind-down to end', () => getRunner(unclassed.runnerId)?.classesWindingDown === false, 30_000, () => unclassed.agent.log())
  openGate(fleet, `d21-${u.id}`)
  assert.equal(await settled(entrant, during.id), 'scored', 'the run under way when the classes went off ended as it would have')
  const next = await new Entrant(home, c).join()
  const afterwards = await next.submit(notebook(null, 2))
  assert.equal(await settled(next, afterwards.id), 'scored', 'and the next submission ran there too')
  assert.equal(unclassed.agent.sandboxRuns().length, 2, 'both ran on the unclassed machine, the only one there is')
  noDelete(unclassed, uContainer.id)

  // `colloq-host runner leave`: the agent drains, its leaving sync moves the class, it removes its class containers and goes.
  const leaving = await scene.machine('d21l')
  const l = await scene.room({ room: 'machines' })
  await classOn(leaving, l)
  const lContainer = leaving.agent.classContainer(l.id, 'room')!
  assert.ok(fs.existsSync(path.join(stateLayout(leaving.agent.root).roomsDir, l.id)))
  // The same for a leave: a file a running cell wrote a moment before goes home before the leaving sync moves the class.
  const lWriting = l.cell('WRITE out/l.csv перед уходом\nHOLD d21l')
  l.run(lWriting)
  const lDoor = leaving.agent.jupyterOf(lContainer)
  await until('the cell holding on the leaving machine, its file written', async () => (await lDoor.kernels()).some((kernel) => kernel.busy) && fs.existsSync(path.join(leaving.agent.roomCopy(l.id), 'out', 'l.csv')))
  assert.equal(fileHere(l.id, 'out/l.csv'), null, 'not here before the leave')
  const left = await leaving.agent.command(['leave'])
  assert.equal(left.code, 0, left.out)
  assert.equal(fileHere(l.id, 'out/l.csv'), 'перед уходом', 'the leaving machine\'s last file came before its leaving sync')
  assert.deepEqual([placementRow(l.id, 'room')!.state, placementRow(l.id, 'room')!.reason], ['lost', 'leaving'])
  await movedHere(l, `${tr('server.theMachineIsBeingDisconnected.126fbe')} ${started}`)
  assert.equal((await leaving.agent.exit(20_000)).code, 0, leaving.agent.log())
  assert.equal(leaving.agent.classContainers().length, 0, 'the machine that left removed its class containers')
  assert.equal(fs.existsSync(path.join(stateLayout(leaving.agent.root).roomsDir, l.id)), false, 'and the class folder\'s copy')
  assert.equal(getRunner(leaving.runnerId)?.state, 'left')
  noDelete(leaving, lContainer.id)

  // The owner's log of each: the class moved, with why.
  for (const [m, why] of [[revoked, 'revoked'], [unclassed, 'unclassed'], [leaving, 'leaving']] as const) {
    assert.deepEqual(runnerEventsOf(m.runnerId, ['class_failover'], 0).map((line) => line.detail), [why])
    assert.ok((await pageKinds(m)).includes('class_failover'), `the owner reads ${m.label}'s failover`)
  }
})

scenario('D22 · the perimeter helper fails three times in a row: the class containers stopped, the class moves, and the owner\'s banner has its line', 90_000, async (scene) => {
  // A machine whose kernel host re-checks its perimeter every second rather than every minute.
  const a = await scene.machine('d22', { timings: { ...FAST, classes: { censusMs: 500, recheckMs: 1_000 } } })
  const room = await scene.room({ room: 'machines' })
  await takes(room, a)
  const first = room.cell('x = 5\nprint(x)')
  room.run(first)
  await room.ok(first)
  const container = a.agent.classContainer(room.id, 'room')!

  a.agent.dockerKnobs({ perimeter: 'fail' })
  await until('the class to move off the machine', () => placementRow(room.id, 'room')?.state === 'lost', 30_000, () => a.agent.log())
  assert.equal(placementRow(room.id, 'room')!.reason, 'perimeter')
  assert.equal(a.agent.lines.filter((line) => /the class perimeter did not hold \(\d of 3\)/.test(line)).length >= 3, true, a.agent.log())
  await until('every class container stopped', () => a.agent.classContainers().length === 0, 30_000, () => a.agent.log())
  await until('the failover in the room', () => room.notes().includes(tr('server.theNetworkOnTheMachineGotOut.10829b')), 10_000, () => room.notes().join('\n'))
  // What the owner's banner reads (K9a draws it): the machine's log says its perimeter failed closed, and the form why it takes no class.
  assert.deepEqual(runnerEventsOf(a.runnerId, ['perimeter_failing'], 0).length, 1)
  assert.ok((await pageKinds(a)).includes('perimeter_failing'))
  // The class it left keeps away from it for a while («Перенести на сервер» means away); another class's form reads why it takes none.
  assert.equal((await placementOutlook(room.id)).machines.find((one) => one.runnerId === a.runnerId)?.refusal, 'avoided')
  const other = await scene.room({ room: 'machines' })
  assert.equal((await placementOutlook(other.id)).machines.find((one) => one.runnerId === a.runnerId)?.refusal, 'perimeter')
  const again = room.cell('print(x)')
  room.run(again)
  assert.equal(await room.done(again), 'error')
  assert.equal(room.errors(again)[0]?.ename, 'NameError', 'the class computes here now')
  assert.equal(livePlacement(room.id, 'room'), null)
  // The rules hold again: nothing started while they did not, and now a class goes there again.
  a.agent.dockerKnobs({ perimeter: 'ok' })
  await takes(other, a)
  const there = other.cell('y = 1\nprint(y)')
  other.run(there)
  await other.ok(there)
  assert.equal(livePlacement(other.id, 'room')?.runnerId, a.runnerId)
  noDelete(a, container.id)
})

scenario('D23 · two silence failovers of one machine within the window: its class quarantine, no new placement there until the owner resumes it', 90_000, async (scene) => {
  const a = await scene.machine('d23')
  const lost: string[] = []
  const outage = async (label: string): Promise<Room> => {
    const room = await scene.room({ room: 'machines', failoverSec: 30 })
    await takes(room, a)
    const first = room.cell('x = 5\nprint(x)')
    room.run(first)
    await room.ok(first)
    assert.equal(livePlacement(room.id, 'room')!.runnerId, a.runnerId, `${label}: on the machine`)
    lost.push(a.agent.classContainer(room.id, 'room')!.id)
    a.proxy.blackhole()
    for (let i = 0; i < 20 && placementRow(room.id, 'room')?.state !== 'lost'; i++) await pass(5_000, { probe: 'home' })
    assert.deepEqual([placementRow(room.id, 'room')!.state, placementRow(room.id, 'room')!.reason], ['lost', 'silence'], label)
    a.proxy.heal()
    await until(`${label}: the machine back`, () => home.tunnels!.isUp(a.runnerId) && a.agent.classContainer(room.id, 'room') === null, 30_000, () => a.agent.log())
    return room
  }
  await outage('the first outage')
  assert.equal(getRunner(a.runnerId)!.classesQuarantinedAt, null, 'one disappearance quarantines nothing')
  await outage('the second outage')
  const quarantined = getRunner(a.runnerId)!.classesQuarantinedAt
  assert.notEqual(quarantined, null, 'twice within the window: quarantined')
  assert.equal(runnerEventsOf(a.runnerId, ['classes_quarantined'], 0).length, 1)
  assert.deepEqual(runnerEventsOf(a.runnerId, ['class_failover'], 0).map((line) => line.detail), ['silence', 'silence'])
  assert.ok((await pageKinds(a)).includes('classes_quarantined'), 'the owner\'s banner has its line')

  // No new placement there: a new class's form says why, and its Run computes here.
  const third = await scene.room({ room: 'machines' })
  await until('the machine heard again', () => home.tunnels!.isUp(a.runnerId))
  assert.equal((await placementOutlook(third.id)).machines.find((one) => one.runnerId === a.runnerId)?.refusal, 'quarantined')
  const here = third.cell('x = 7\nprint(x)')
  third.run(here)
  await third.ok(here)
  assert.equal(livePlacement(third.id, 'room'), null, 'it computes on this server')
  assert.equal(a.agent.classContainer(third.id, 'room'), null)

  // The owner's «Вернуть» (K9a's door: the row, the line in the log, the wake): new classes go there again.
  const resumed = resumeRunnerClasses(a.runnerId, home.clock.now())
  assert.ok(!('refused' in resumed) && resumed.changed)
  remoteEvent(a.runnerId, 'classes_resumed', {}, home.clock.now())
  wakeRunner(a.runnerId)
  const fourth = await scene.room({ room: 'machines' })
  await takes(fourth, a)
  const there = fourth.cell('x = 9\nprint(x)')
  fourth.run(there)
  await fourth.ok(there)
  assert.equal(livePlacement(fourth.id, 'room')?.runnerId, a.runnerId, 'resumed: placed on the machine again')
  for (const container of lost) noDelete(a, container)
})

scenario('D24 · four tunnel replacements from two addresses: each one in the machine\'s log with both, and the owner\'s alert past the third', 90_000, async (scene) => {
  const a = await scene.machine('d24', { address: '198.51.100.7' })
  await until('the machine\'s tunnel up', () => home.tunnels!.isUp(a.runnerId), 30_000, () => a.agent.log())
  // A thief with the machine's secret, dialling from an address of its own; the machine's agent dials back as home replaces it.
  const away = await scene.proxy({ forwardedFor: '203.0.113.9' })
  const thief = new AgentTunnel({
    url: tunnelUrl(away.url),
    authorization: a.agent.authorization(),
    build: 'dev',
    resolve: () => ({ refused: 'gone' }),
    paceMBps: () => 1000,
    log: () => {},
    relayState: async () => 'unknown',
  })
  const replaced = () => runnerEventsOf(a.runnerId, ['tunnel_replaced'], 0)
  let atThree: boolean | null = null
  try {
    thief.want('open')
    await until('four replacements', () => {
      if (replaced().length === 3 && atThree === null) atThree = tunnelReplacementAlert(a.runnerId)
      return replaced().length >= 4
    }, 60_000, () => `${replaced().length} replacements\n${home.tunnelLines.join('\n')}`)
  } finally {
    await thief.close()
  }
  const lines = replaced().slice(0, 4)
  // Each takeover names the newer tunnel's address and the one it replaced: the two addresses by turns.
  assert.deepEqual(lines.map((line) => [line.address, line.detail]), [
    ['203.0.113.9', '198.51.100.7'],
    ['198.51.100.7', '203.0.113.9'],
    ['203.0.113.9', '198.51.100.7'],
    ['198.51.100.7', '203.0.113.9'],
  ])
  assert.equal(atThree, false, 'three replacements raise no alert')
  assert.equal(tunnelReplacementAlert(a.runnerId), true, 'the fourth does: the banner (K9a draws it) reads this')
  assert.ok((await pageKinds(a)).filter((kind) => kind === 'tunnel_replaced').length >= 4, 'the owner reads each replacement')
  await until('the machine\'s own tunnel up again', () => home.tunnels!.isUp(a.runnerId), 30_000, () => a.agent.log())
  // The alert is for its window: ten minutes on, it is over.
  home.clock.advance(TUNNEL_REPLACEMENTS_ALERT.windowMs)
  assert.equal(tunnelReplacementAlert(a.runnerId), false)
})
