/**
 * Classes on machines («занятия на машинах») end to end, scenarios B: tunnel
 * faults (docs/architecture/remote-classes.md §17.2 B.4–B.8), on the harness
 * of tests/classes-e2e.test.mts.
 *
 * EVERYTHING IS THE REAL THING BUT THE DAEMON AND THE PYTHON. Home is the app
 * of this process with its tunnel door (tests/_remote-e2e-home.mts); the
 * machine is the real agent as a process of its own
 * (tests/_remote-e2e-agent.mts) on the fake docker
 * (tests/_remote-e2e-docker.mjs), whose class containers are fake Jupyters
 * (tests/_fake-jupyter.mjs); and between them the fault proxy
 * (tests/_tunnel-fault.mts) stands where relay2 does: the machine joins
 * through it, so its syncs and its tunnel cross it, and every fault here is
 * the proxy's. A class is made and joined through the doors its people use —
 * the owner's panel, the room's join, a browser's notebook socket (/collab,
 * Yjs) and control socket (/control) — and what is asserted is what each of
 * them sees there: outputs, notes and the chip in the room's document, the
 * frames of the control socket; besides them what the database holds and the
 * call log of the machine's fake Jupyter. No DELETE may ever reach it: nothing
 * of scenarios B is lost.
 *
 * A CUT IS K0'S: the relay's leg dropping every packet both ways (iptables),
 * which the proxy's black hole is. Under twenty-five seconds it is a stall
 * the tunnel rides out (quiet past TUNNEL_QUIET_MS); past TUNNEL_DEAD_MS home
 * ends the socket, the agent hears that end only once the leg heals, dials
 * again and resumes what both ends kept — or, past TUNNEL_RESUME_MS of home's
 * keeping, finds it reset.
 *
 * TWO CLOCKS. A fault's length is home's clock (HomeClock): home's tunnels,
 * its class placements and the kernel hooks' notes, and the machines'
 * liveness (heard.ts · useRemoteClock) run on it, and a scenario moves it on
 * by hand, a pass of the classes' clock every five seconds of it, as
 * liveness.ts runs them. The agent's clock is the wall, which a fault lasts a
 * moment of: its dead timer is never reached, and its streams are kept across
 * every cut (TUNNEL_RESUME_MS of its wall). The run limit's seconds are the
 * wall's too, scaled down (setCouncilLimitTick).
 *
 * NO PATH EVIDENCE. The file's one machine is the only one home hears, and
 * home's own probe would cross the same dark relay: silence is never proven,
 * so nothing fails over by itself, as when the relay is down for everyone
 * (D15). What a fault does to the class is then the tunnel's and the kernel
 * client's alone.
 *
 * ONE MACHINE SERVES THE FILE. Each scenario makes a class of its own on it.
 */
import './_remote-e2e-home.mts'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import type { Response as ExpressResponse } from 'express'
import { tr } from '../shared/i18n.js'
import { STAFF_COOKIE, type ClassPlacement } from '../shared/admin.js'
import type { ControlClientMessage, ControlServerMessage, JoinResponse } from '../shared/protocol.js'
import { CLASS_PROBE_MS } from '../shared/remote-kernels.js'
import { remoteCredential, type RemoteFacts } from '../shared/remote-runner.js'
import { TUNNEL_DEAD_MS, TUNNEL_PING_MS, TUNNEL_PROBE_MS, TUNNEL_QUIET_MS, TUNNEL_RESUME_MS, TunnelEnd, decodeTunnelFrame, tunnelUrl, type TunnelClock, type TunnelSocket } from '../shared/remote-tunnel.js'
import { CELLS_KEY, bookCells, bookKernel, cellId, createCell, getTerminal, readCell, readTerminalLine, type YCell } from '../shared/notebook.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { getRunner, joinRunner, mintRemoteCode, runnerEventsOf } from '../server/src/competitions/remote/store.js'
import { revokeRunner } from '../server/src/competitions/remote/release.js'
import { useRemoteClock } from '../server/src/competitions/remote/heard.js'
import { jupyterSessionPath } from '../server/src/kernel/jupyter.js'
import { placementOutlook, tunnelWanted } from '../server/src/kernel/remote/placement.js'
import { livePlacement, placementRow } from '../server/src/kernel/remote/placement-store.js'
import { setCouncilLimitTick, shutdownKernels } from '../server/src/kernel/index.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { AgentTunnel } from '../server/src/runner-agent/tunnel.js'
import { Agent, createFleet, killAgents, removeClassContainers, type FakeClassContainer, type FakeJupyterDoor, type Fleet } from './_remote-e2e-agent.mts'
import { Home, kernelRevision, until } from './_remote-e2e-home.mts'
import { TunnelFault } from './_tunnel-fault.mts'

const home = new Home({ liveness: 'manual' })
let fleet: Fleet
/** Where relay2 stands: everything the file's machine says to home crosses it. */
let relay: TunnelFault
/** Every socket a scenario opened: closed at the end of the file, whatever happened. */
const sockets = new Set<WebSocket>()

before(async () => {
  fleet = createFleet()
  await home.start()
  // The machines' liveness on home's clock, as its tunnels and class placements are: a fault's length is that clock's.
  useRemoteClock(home.clock)
  // What computes on this server: a slot no machine takes, or one back from a machine.
  await home.homeJupyter()
  // The class environment's image, in the fleet's registry and noted at home: what a class set to machines runs there.
  kernelRevision(fleet)
  relay = await TunnelFault.start({ target: home.port })
})

after(async () => {
  for (const ws of sockets) ws.terminate()
  // The kernels' clients and the rooms' documents of this process go first: no reconnect knocks on a machine that is gone.
  await shutdownKernels()
  shutdownCollab()
  await relay?.close()
  await killAgents()
  await removeClassContainers()
  await home.close()
  useRemoteClock(null)
})

/* ------------------------------------------------------------------ people */

interface Staff {
  /** The Cookie header a signed-in teacher's browser sends. */
  cookie: string
}

/** A teacher of this instance, signed in: the owner, who also says where classes compute (§6.2, D4). */
function staff(name = 'Преподавательница B'): Staff {
  const made = createTeacher({ name, email: `b.${Date.now()}.${randomBytes(3).toString('hex')}@example.edu`, role: 'owner' })!
  rotateLinkKey(made.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, made)
  return { cookie: `${STAFF_COOKIE}=${value}` }
}

/** A call through the home's doors, as a browser makes one: JSON both ways, with the cookie when signed in. */
async function call<T>(method: string, at: string, body?: unknown, cookie?: string): Promise<{ status: number; body: T }> {
  const answer = await fetch(`${home.url}${at}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await answer.text()
  return { status: answer.status, body: (text ? JSON.parse(text) : null) as T }
}

/** A class made in the panel on the base environment, with these rules, and its placement set in its «Ресурсы». */
async function makeClass(by: Staff, name: string, placement: Partial<ClassPlacement>, rules: Record<string, unknown> = {}): Promise<string> {
  // One core and a gigabyte: the machine offers the host's cores less one, and a 4-core CI runner holds one such class at a time.
  const made = await call<{ id: string }>('POST', '/api/admin/seminars', { name, environment: 'base', rules, cpus: 1, memoryMb: 1024 }, by.cookie)
  assert.equal(made.status, 201, JSON.stringify(made.body))
  classes.push({ by, id: made.body.id })
  const set = await call('PATCH', `/api/admin/seminars/${made.body.id}`, { placement }, by.cookie)
  assert.equal(set.status, 200, JSON.stringify(set.body))
  return made.body.id
}

/** Every class a scenario made: ended after it (classes-e2e-a.test.mts · endClass), so its cores are free for the next scenario's. */
const classes: { by: Staff; id: string }[] = []

/** The owner's stop of the whole class («Остановить», POST …/running/:id/stop): its slot on the machine stops there, and the row leaves. */
async function endClass(by: Staff, sessionId: string): Promise<void> {
  const stopped = await call<{ error?: string }>('POST', `/api/admin/resources/running/${sessionId}/stop`, { what: 'class', force: true }, by.cookie)
  // Nothing to stop is an ended class too (a slot that never started, or one already moved here).
  assert.ok(stopped.status === 200 || stopped.status === 404, `${stopped.status} ${JSON.stringify(stopped.body)}`)
  await until(`class ${sessionId} off the machine`, () => livePlacement(sessionId, 'room') === null, 30_000, () => home.classLines.slice(-5).join('\n'))
}

afterEach(async () => {
  for (const { by, id } of classes.splice(0)) await endClass(by, id)
})

/** «Войти» on the room's page: the token its sockets open with. */
async function join(sessionId: string, name: string, by?: Staff): Promise<JoinResponse> {
  const joined = await call<JoinResponse>('POST', `/api/sessions/${sessionId}/join`, { name }, by?.cookie)
  assert.equal(joined.status, 200, JSON.stringify(joined.body))
  return joined.body
}

/** A browser's notebook socket (/collab/<id>): a Y.Doc of its own, synced both ways as the y-websocket provider syncs it. */
class Notebook {
  readonly doc = new Y.Doc()
  private readonly ws: WebSocket

  private constructor(url: string, cookie: string | undefined) {
    this.ws = new WebSocket(url, { headers: cookie ? { cookie } : {} })
    sockets.add(this.ws)
    this.ws.on('open', () => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0)
      syncProtocol.writeSyncStep1(encoder, this.doc)
      this.ws.send(encoding.toUint8Array(encoder))
    })
    this.ws.on('message', (data: RawData) => {
      const decoder = decoding.createDecoder(new Uint8Array(data as Buffer))
      // Awareness and anything else is not this test's business.
      if (decoding.readVarUint(decoder) !== 0) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0)
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this)
      if (encoding.length(encoder) > 1) this.ws.send(encoding.toUint8Array(encoder))
    })
    this.ws.on('error', () => undefined)
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this || this.ws.readyState !== WebSocket.OPEN) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0)
      syncProtocol.writeUpdate(encoder, update)
      this.ws.send(encoding.toUint8Array(encoder))
    })
  }

  static async open(sessionId: string, joined: JoinResponse, by?: Staff): Promise<Notebook> {
    const notebook = new Notebook(`${home.url.replace('http:', 'ws:')}/collab/${sessionId}?token=${encodeURIComponent(joined.token)}`, by?.cookie)
    await until('the notebook to sync', () => notebook.doc.getArray(CELLS_KEY).length > 0)
    return notebook
  }

  /** A code cell typed at the end of the room's notebook: its id. */
  add(source: string): string {
    const cell = createCell('code', source)
    bookCells(this.doc, CELLS_KEY).push([cell])
    return cellId(cell)
  }

  cell(id: string): YCell | null {
    return bookCells(this.doc, CELLS_KEY).toArray().find((cell) => cellId(cell) === id) ?? null
  }

  /** What a cell printed so far. */
  printed(id: string): string {
    const cell = this.cell(id)
    return cell ? readCell(cell).outputs.map((output) => (output.kind === 'stream' ? output.text : '')).join('') : ''
  }

  state(id: string): string | null {
    const cell = this.cell(id)
    return cell ? readCell(cell).state : null
  }

  /** The cell's state, printed text and errors, once it has settled (ok or error). */
  async settled(id: string, timeoutMs = 30_000): Promise<{ state: string; text: string; errors: string[] }> {
    return until(`cell ${id} to settle`, () => {
      const cell = this.cell(id)
      if (!cell) return null
      const read = readCell(cell)
      if (read.state !== 'ok' && read.state !== 'error') return null
      return {
        state: read.state,
        text: read.outputs.map((output) => (output.kind === 'stream' ? output.text : '')).join(''),
        errors: read.outputs.flatMap((output) => (output.kind === 'error' ? [output.ename ? `${output.ename}: ${output.evalue}` : output.evalue] : [])),
      }
    }, timeoutMs, () => JSON.stringify(this.cell(id) ? readCell(this.cell(id)!) : null))
  }

  /** The room's notes: the system lines of the shared terminal, where the kernel's news is written. */
  notes(): string[] {
    return getTerminal(this.doc).toArray().map(readTerminalLine).filter((line) => line.kind === 'system').map((line) => line.text)
  }

  /** The chip of the room's notebook: whether its machine answers (notebook.ts · KERNEL_LINK_FIELD). */
  link(): string | null {
    return bookKernel(this.doc, CELLS_KEY).link
  }
}

/** A browser's control socket (/control/<id>): every frame it heard, and what it sends. */
class Control {
  readonly heard: ControlServerMessage[] = []
  private readonly ws: WebSocket

  private constructor(url: string, cookie: string | undefined) {
    this.ws = new WebSocket(url, { headers: cookie ? { cookie } : {} })
    sockets.add(this.ws)
    this.ws.on('message', (data: RawData) => this.heard.push(JSON.parse(String(data)) as ControlServerMessage))
    this.ws.on('error', () => undefined)
  }

  static async open(sessionId: string, joined: JoinResponse, by?: Staff): Promise<Control> {
    const control = new Control(`${home.url.replace('http:', 'ws:')}/control/${sessionId}?token=${encodeURIComponent(joined.token)}`, by?.cookie)
    await until('the control socket\'s welcome', () => control.heard.some((frame) => frame.t === 'role'))
    return control
  }

  send(message: ControlClientMessage): void {
    this.ws.send(JSON.stringify(message))
  }

  /** The refusals said to this socket since frame `from`: `{t: 'error'}` frames' messages. */
  errors(from = 0): string[] {
    return this.heard.slice(from).flatMap((frame) => (frame.t === 'error' ? [String((frame as { message?: string }).message ?? '')] : []))
  }

  /** The staff frames about the room slot's machine since frame `from` (protocol.ts · `kernel:machine`): their notes. */
  machineNotes(from = 0): string[] {
    return this.heard.slice(from).flatMap((frame) => (frame.t === 'kernel:machine' && frame.role === 'room' && frame.note ? [frame.note] : []))
  }
}

interface Tab {
  notebook: Notebook
  control: Control
}

async function tab(sessionId: string, name: string, by?: Staff): Promise<Tab> {
  const joined = await join(sessionId, name, by)
  return { notebook: await Notebook.open(sessionId, joined, by), control: await Control.open(sessionId, joined, by) }
}

/* ---------------------------------------------------------------- machines */

let shared: Agent | null = null

/**
 * The file's class machine: joined through the relay with a code minted
 * «Принимает занятия», its agent running, its tunnel up at home.
 */
async function classMachine(): Promise<Agent> {
  if (shared) return shared
  const agent = new Agent(fleet, `b-${randomBytes(2).toString('hex')}`, { join: relay.joinTarget(await home.mintCode({ classes: true })), classes: true })
  agent.start()
  const runnerId = await until('the machine to join', () => agent.identity()?.runnerId, 30_000, () => agent.log())
  await until('its tunnel up at home', () => home.tunnels?.isUp(runnerId), 30_000, () => `${agent.log()}\n${home.tunnelLines.join('\n')}`)
  shared = agent
  return agent
}

/** The machine's name as the owner gave it: what staff read, and what the room's document must never say. */
const nameOf = (agent: Agent): string => getRunner(agent.runnerId)!.name

/** Until the form's live line says this machine takes the class (placement.ts · outlook): its image there, its facts heard. */
async function takes(agent: Agent, sessionId: string): Promise<void> {
  let last: unknown = null
  await until(`${agent.name} to take class ${sessionId}`, async () => {
    const outlook = await placementOutlook(sessionId)
    last = outlook
    return outlook.refusal === null && outlook.machines.find((one) => one.runnerId === agent.runnerId)?.refusal === null
  }, 45_000, () => `${JSON.stringify(last)}\n${agent.log()}\n${home.classLines.slice(-10).join('\n')}`)
}

/** A slot's class container on the machine, once it runs and its Jupyter listens. */
async function containerOf(agent: Agent, sessionId: string): Promise<FakeClassContainer> {
  return until(`the room container of ${sessionId} on ${agent.name}`, () => {
    const found = agent.classContainer(sessionId, 'room')
    return found?.status === 'running' && found.port !== null ? found : null
  }, 30_000, () => agent.log())
}

/** The kernel a fake Jupyter keeps for the class notebook, by the session path home opens it at; `online`: its channels open now. */
async function kernelOf(door: FakeJupyterDoor, sessionId: string): Promise<{ id: string; guarded: boolean; busy: boolean; count: number; online: number } | null> {
  return (await door.kernels()).find((one) => one.path === jupyterSessionPath(sessionId, CELLS_KEY) && one.alive) ?? null
}

/** How many times a kernel's channel was opened at the machine's Jupyter: one more is a reconnect of home's kernel client. */
async function channels(door: FakeJupyterDoor, kernelId: string): Promise<number> {
  return (await door.calls()).filter((one) => one.kind === 'channel' && one.kernel === kernelId).length
}

/** The fake's call log of one kind for a kernel, by HTTP path ending: restarts, interrupts. */
async function posts(door: FakeJupyterDoor, kernelId: string, verb: 'restart' | 'interrupt'): Promise<number> {
  return (await door.calls()).filter((one) => one.kind === 'http' && one.method === 'POST' && one.path === `/api/kernels/${kernelId}/${verb}`).length
}

/** Every DELETE the machine's Jupyter was sent. */
async function deletes(door: FakeJupyterDoor): Promise<number> {
  return (await door.calls()).filter((one) => one.kind === 'http' && one.method === 'DELETE').length
}

/** The values COUNT printed in a kernel, in order: one per execution, so a cell run twice shows. */
async function counts(door: FakeJupyterDoor, kernelId: string): Promise<number[]> {
  return (await door.calls()).filter((one) => one.kind === 'count' && one.kernel === kernelId).map((one) => one.value as number)
}

/** A class of its own on the machine, its room notebook's kernel brought up there by the teacher's join (§6.8), guarded. */
async function classOn(agent: Agent, name: string, rules: Record<string, unknown> = {}): Promise<{
  id: string
  teacher: Tab
  student: Tab
  container: FakeClassContainer
  door: FakeJupyterDoor
  kernel: { id: string }
}> {
  const by = staff()
  const id = await makeClass(by, name, { room: 'machines' }, rules)
  await takes(agent, id)
  const teacher = await tab(id, 'Преподавательница', by)
  const container = await containerOf(agent, id)
  const door = agent.jupyterOf(container)
  const kernel = await until('the class notebook\'s kernel on the machine, its guard in', async () => {
    const found = await kernelOf(door, id)
    return found?.guarded ? found : null
  }, 30_000, () => agent.log())
  const student = await tab(id, 'Студент')
  return { id, teacher, student, container, door, kernel }
}

/* ------------------------------------------------------------------ clocks */

/** Let the event loop turn: what would happen at once, has. */
async function turns(count = 20): Promise<void> {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve))
}

/** Home's clock moved on by `ms`, a pass of the classes' clock every CLASS_PROBE_MS of it (liveness.ts · remoteTick), as the server runs them. */
async function pass(ms: number): Promise<void> {
  for (let left = ms; left > 0;) {
    const step = Math.min(CLASS_PROBE_MS, left)
    home.clock.advance(step)
    left -= step
    home.tick()
    await turns()
  }
}

/**
 * The relay dark for `ms` of home's clock, then lit again: a cut of K0's
 * (see the header). Past TUNNEL_DEAD_MS home has ended the tunnel by then,
 * and the agent hears it as the leg heals.
 */
async function cut(ms: number): Promise<void> {
  relay.blackhole()
  await turns()
  await pass(ms)
}

/** A server word with its placeholders as patterns: what the room reads, whatever the clock said in it. */
function words(key: string, names: readonly string[] = [], fixed: Record<string, string | number> = {}): RegExp {
  const marks = Object.fromEntries(names.map((name, i) => [name, `\u0000${i}\u0000`]))
  const escaped = tr(key, { ...fixed, ...marks }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\u0000\d+\u0000/g, '.+?')}$`)
}

/** Lines 0 … n-1, as `STREAM n ms` prints them. */
const streamed = (n: number): string => Array.from({ length: n }, (_, k) => `${k}\n`).join('')

/** The lines of the agent's log since `from` that say its tunnel went down or was dialled again. */
const tunnelDrops = (agent: Agent, from: number): string[] => agent.lines.slice(from).filter((line) => /class tunnel: (tunnel-down|tunnel-stale)/.test(line))

/** Home's tunnel lines since `from` that say the machine's tunnel went down. */
const homeDrops = (agent: Agent, from: number): string[] => home.tunnelLines.slice(from).filter((line) => line.includes(`machine ${agent.runnerId} down`))

/* --------------------------------------------------------------- scenarios */

test('B4 · a 20 s black hole mid-STREAM: no failover, no reconnect attempt counted, the chip amber after 10 s, the "back" note, all output delivered', { timeout: 90_000 }, async () => {
  const machine = await classMachine()
  const { id, teacher, student, door, kernel } = await classOn(machine, 'B4 · чёрная дыра')
  const gen = placementRow(id, 'room')!.gen
  const opened = await channels(door, kernel.id)
  const agentFrom = machine.lines.length
  const homeFrom = home.tunnelLines.length

  // A cell streams on the machine, a line every 40 ms.
  const cell = teacher.notebook.add('STREAM 100 40\nCOUNT')
  teacher.control.send({ t: 'run', cellId: cell })
  await until('the first lines in the room', () => student.notebook.printed(cell).split('\n').length > 3)

  // The relay goes dark both ways, for every connection of the machine, mid-stream: nothing it carries is lost, and nothing is said.
  relay.blackhole()
  await turns()
  assert.equal(student.notebook.state(cell), 'running', 'mid-stream')
  assert.ok(student.notebook.printed(cell).split('\n').length < 100)
  const notesFrom = student.notebook.notes().length
  const staffFrom = teacher.control.heard.length

  // Ten seconds of it on home's clock: a blip that says nothing, the chip as it was.
  await pass(10_000)
  assert.equal(student.notebook.link(), 'ok', 'ten seconds of silence say nothing yet')
  assert.deepEqual(student.notebook.notes().slice(notesFrom), [])

  // Past the quiet line (the pings stopped): the chip turns amber, and the room hears it at once, with the stall's length.
  await pass(TUNNEL_QUIET_MS - 10_000)
  await until('the chip amber', () => student.notebook.link() === 'lost', 15_000, () => JSON.stringify(bookKernel(student.notebook.doc, CELLS_KEY)))
  const unreachable = words('server.noConnectionToTheMachineTheKernel.71d94f', ['elapsed'])
  await until('the unreachable note in the room', () => student.notebook.notes().slice(notesFrom).some((note) => unreachable.test(note)), 15_000, () => student.notebook.notes().join('\n'))
  assert.ok(student.notebook.notes().includes(tr('server.noConnectionToTheMachineTheKernel.71d94f', { elapsed: '0:12' })), `counted from the last frame:\n${student.notebook.notes().join('\n')}`)
  // Staff read which machine it is: the named words reach their control socket only.
  await until('the staff\'s words naming the machine', () => teacher.control.machineNotes(staffFrom).some((note) => note.includes(nameOf(machine))), 15_000, () => JSON.stringify(teacher.control.heard.slice(staffFrom)))
  assert.deepEqual(student.control.machineNotes(), [], 'a student hears no machine named')

  // Twenty seconds in all: the class has not moved, and the slot waits for its machine at the same placement.
  await pass(20_000 - TUNNEL_QUIET_MS)
  assert.deepEqual([placementRow(id, 'room')?.state, placementRow(id, 'room')?.gen], ['unreachable', gen], 'no failover')
  assert.equal(runnerEventsOf(machine.runnerId, ['class_failover'], 0).length, 0)

  // Healed: what the relay held goes on, and the room hears the machine is back — it heard it was gone.
  relay.heal()
  const back = words('server.theConnectionToTheMachineCameBack.d517ba', ['seconds'])
  const backNote = await until('the back note in the room', () => student.notebook.notes().slice(notesFrom).find((note) => back.test(note)), 30_000, () => student.notebook.notes().join('\n'))
  // The outage's length on home's clock: its twenty seconds, and the moments the test itself took on the wall.
  const seconds = Number(/(\d+)/.exec(backNote)?.[1])
  assert.ok(seconds >= 20 && seconds <= 25, backNote)
  await until('the chip back', () => student.notebook.link() === 'ok')
  assert.equal(placementRow(id, 'room')?.state, 'ready')

  // Every line the cell printed, once and in order, and the cell done on the same kernel: computed once (COUNT).
  assert.deepEqual(await student.notebook.settled(cell), { state: 'ok', text: `${streamed(100)}1\n`, errors: [] })
  assert.deepEqual(await counts(door, kernel.id), [1])
  // No reconnect: the kernel client's channel is the one it had, and the tunnel was never dropped at either end.
  assert.equal(await channels(door, kernel.id), opened, 'home\'s kernel client never opened its channel again')
  assert.deepEqual(tunnelDrops(machine, agentFrom), [], 'the agent never dropped its tunnel')
  assert.deepEqual(homeDrops(machine, homeFrom), [], 'nor did home')
  assert.equal(await deletes(door), 0, 'no DELETE ever reached the machine')
  assert.ok(!JSON.stringify(student.notebook.doc.toJSON()).includes(nameOf(machine)), 'the room\'s document never names the machine')
})

test('B5 · a cut without resume: inner reconnect, replay, and reconcileAfterReset settles the reply the fake dropped on purpose; COUNT unchanged', { timeout: 90_000 }, async () => {
  const machine = await classMachine()
  const { id, teacher, student, door, kernel } = await classOn(machine, 'B5 · обрыв без продолжения')
  const gen = placementRow(id, 'room')!.gen
  const opened = await channels(door, kernel.id)
  const homeFrom = home.tunnelLines.length

  // A cell on the machine counts, prints and waits at its HOLD; once let go it prints again, and its reply is lost (LOSE).
  const cell = teacher.notebook.add('x = 5\nCOUNT\nprint("a")\nHOLD b5\nprint("c")\nLOSE')
  teacher.control.send({ t: 'run', cellId: cell })
  await until('the cell to print up to its hold', () => student.notebook.printed(cell) === '1\na\n', 15_000, () => student.notebook.printed(cell))
  await until('and to hold on the machine', async () => (await kernelOf(door, id))?.busy === true)

  // The relay dark past home's dead timer and past what home keeps for a resume: home's ends of the streams are reset, the
  // kernel client's channel among them, with the cell's reply still out.
  await cut(TUNNEL_DEAD_MS + TUNNEL_RESUME_MS + CLASS_PROBE_MS)
  assert.ok(home.tunnelLines.slice(homeFrom).some((line) => line.includes(`machine ${machine.runnerId} down`)), 'home ended the dead tunnel')
  assert.equal(student.notebook.state(cell), 'running', 'the cell waits for its reply')
  assert.equal(student.notebook.link(), 'lost')
  assert.deepEqual([placementRow(id, 'room')?.state, placementRow(id, 'room')?.gen], ['unreachable', gen], 'no failover: silence was never proven')

  // The machine's Jupyter takes the kernel client's next channel only when told, and keeps what the kernel says meanwhile.
  await door.knobs({ upgradeDelayMs: 600_000 })
  relay.heal()
  await until('the agent to come back as no life home kept, and home\'s kernel client to knock again', async () =>
    (await channels(door, kernel.id)) === opened + 1 && (await kernelOf(door, id))?.online === 0, 30_000, () => `${machine.log()}\n${home.tunnelLines.slice(homeFrom).join('\n')}`)
  assert.ok(home.tunnelLines.slice(homeFrom).some((line) => new RegExp(`machine ${machine.runnerId} up from .*, \\d+ reset`).test(line)), `reset, not resumed:\n${home.tunnelLines.slice(homeFrom).join('\n')}`)
  // Meanwhile the cell goes on into no channel: it prints, and its reply never leaves.
  await door.release('b5')
  await until('the cell to end, its reply lost on the way', async () => (await door.calls()).some((one) => one.kind === 'lost' && one.kernel === kernel.id))
  await door.knobs({ upgradeDelayMs: 0 })

  // The channel back: the replay first («c», said while no channel listened), then the kernel's answer; the reply that never
  // came is settled as lost, the cell an error in the room's words, and nothing ran twice.
  assert.deepEqual(await student.notebook.settled(cell), { state: 'error', text: '1\na\nc\n', errors: [tr('server.theConnectionToTheMachineBrokeThe.5504d1')] })
  assert.equal(await channels(door, kernel.id), opened + 1, 'one reconnect of the kernel client')
  assert.deepEqual(await counts(door, kernel.id), [1], 'COUNT unchanged: nothing ran again')

  // The same kernel with its variables: the next cell computes there, and the count goes on.
  const next = teacher.notebook.add('print(x)\nCOUNT')
  teacher.control.send({ t: 'run', cellId: next })
  assert.deepEqual(await student.notebook.settled(next), { state: 'ok', text: '5\n2\n', errors: [] })
  assert.deepEqual(await counts(door, kernel.id), [1, 2])
  assert.deepEqual([placementRow(id, 'room')?.state, placementRow(id, 'room')?.gen], ['ready', gen])
  assert.equal(student.notebook.link(), 'ok')
  assert.equal(await deletes(door), 0, 'no DELETE ever reached the machine')
})

test('B6 · (K3b) a 60 s cut with resume: zero output lost, no inner reconnect', { timeout: 90_000 }, async () => {
  const machine = await classMachine()
  const { id, teacher, student, door, kernel } = await classOn(machine, 'B6 · обрыв на минуту')
  const gen = placementRow(id, 'room')!.gen
  const opened = await channels(door, kernel.id)
  const agentFrom = machine.lines.length
  const homeFrom = home.tunnelLines.length

  // A cell streams on the machine, a line every 40 ms, on through the cut.
  const cell = teacher.notebook.add('STREAM 100 40\nCOUNT')
  teacher.control.send({ t: 'run', cellId: cell })
  await until('the first lines in the room', () => student.notebook.printed(cell).split('\n').length > 3)

  // A minute dark: home ends the dead tunnel at its twenty-five seconds and keeps its streams; the kernel client keeps its
  // channel; what the cell prints meanwhile waits on the machine, unacknowledged.
  await cut(60_000)
  assert.equal(student.notebook.state(cell), 'running', 'the cell streams on through the cut')
  assert.ok(home.tunnelLines.slice(homeFrom).some((line) => line.includes(`machine ${machine.runnerId} down`)), 'home ended the dead tunnel')
  assert.deepEqual([placementRow(id, 'room')?.state, placementRow(id, 'room')?.gen], ['unreachable', gen], 'no failover')
  relay.heal()

  // The agent hears the end as the leg heals, dials again, and both ends take the streams up where they were.
  await until('the tunnel back, its streams resumed', () => home.tunnelLines.slice(homeFrom).some((line) => new RegExp(`machine ${machine.runnerId} up from .*, \\d+ streams resumed`).test(line)), 30_000, () => `${machine.log()}\n${home.tunnelLines.slice(homeFrom).join('\n')}`)
  // The agent says so in its own log, which reaches this process on its own pipe, a moment after or before home's line.
  await until('the agent\'s word of the resume', () => machine.lines.slice(agentFrom).some((line) => /class tunnel: tunnel-up .*"resumed":\d+/.test(line)), 15_000, () => machine.lines.slice(agentFrom).join('\n'))
  assert.deepEqual(await student.notebook.settled(cell), { state: 'ok', text: `${streamed(100)}1\n`, errors: [] }, 'zero output lost')
  assert.equal(await channels(door, kernel.id), opened, 'no inner reconnect')
  assert.deepEqual(await counts(door, kernel.id), [1])
  await until('the chip back', () => student.notebook.link() === 'ok')
  assert.deepEqual([placementRow(id, 'room')?.state, placementRow(id, 'room')?.gen], ['ready', gen])
  assert.equal(await deletes(door), 0, 'no DELETE ever reached the machine')
})

test('B7 · restart pressed while unreachable is refused; a restart whose answer is cut reads «ответа нет», then is settled one way, and in a second run the other', { timeout: 90_000 }, async () => {
  const machine = await classMachine()
  const { id, teacher, student, door, kernel } = await classOn(machine, 'B7 · перезапуск через обрыв')
  const gen = placementRow(id, 'room')!.gen
  const run = async (source: string): Promise<{ state: string; text: string; errors: string[] }> => {
    const cell = teacher.notebook.add(source)
    teacher.control.send({ t: 'run', cellId: cell })
    return student.notebook.settled(cell)
  }
  assert.deepEqual(await run('x = 7\nprint(x)'), { state: 'ok', text: '7\n', errors: [] })

  // Unreachable (the relay stalled past the quiet line): Restart is refused to the person who pressed, in words naming the
  // machine for staff, and nothing reaches the kernel.
  relay.blackhole()
  await turns()
  await pass(TUNNEL_QUIET_MS)
  await until('the slot unreachable', () => placementRow(id, 'room')?.state === 'unreachable' && student.notebook.link() === 'lost')
  const from = teacher.control.heard.length
  teacher.control.send({ t: 'restart' })
  const refused = await until('the refusal', () => teacher.control.errors(from)[0], 15_000, () => JSON.stringify(teacher.control.heard.slice(from)))
  assert.equal(refused, tr('server.noConnectionToMachineARestartWould.406486', { machine: nameOf(machine) }))
  relay.heal()
  await until('the link back', () => student.notebook.link() === 'ok' && placementRow(id, 'room')?.state === 'ready')
  assert.equal(await posts(door, kernel.id, 'restart'), 0, 'the refused restart never left home')
  assert.deepEqual(await run('print(x)'), { state: 'ok', text: '7\n', errors: [] }, 'the variables untouched')

  /** A restart whose answer the relay's cut takes: «ответа нет» while it lasts, and what the kernel says once it is over. */
  const restartThroughCut = async (mode: 'unanswered' | 'ignored', sent: number): Promise<string[]> => {
    await door.knobs({ restarts: mode })
    const notesFrom = student.notebook.notes().length
    teacher.control.send({ t: 'restart' })
    await until('the restart to reach the machine', async () => (await posts(door, kernel.id, 'restart')) === sent)
    await cut(TUNNEL_DEAD_MS + TUNNEL_RESUME_MS + CLASS_PROBE_MS)
    await until('«ответа нет»', () => student.notebook.notes().slice(notesFrom).includes(tr('server.theRestartWasSentButNoAnswer.17cbbc')), 15_000, () => student.notebook.notes().slice(notesFrom).join('\n'))
    relay.heal()
    const settled = [tr('server.theRestartWentThroughTheVariablesWere.96b635'), tr('server.theRestartDidNotGetThroughThe.92177b')]
    await until('the restart settled', () => student.notebook.notes().slice(notesFrom).some((note) => settled.includes(note)), 30_000, () => `${student.notebook.notes().slice(notesFrom).join('\n')}\n${machine.log()}`)
    await door.knobs({ restarts: 'normal' })
    return student.notebook.notes().slice(notesFrom)
  }

  // Taken, and its answer lost (a fresh process over there): settled as done, the variables gone.
  const happened = await restartThroughCut('unanswered', 1)
  assert.ok(happened.includes(tr('server.theRestartWentThroughTheVariablesWere.96b635')), happened.join('\n'))
  assert.ok(!happened.includes(tr('server.theRestartDidNotGetThroughThe.92177b')))
  assert.deepEqual((await run('print(x)')).errors, ['NameError: name \'x\' is not defined'], 'a fresh Python')
  await until('the guard in the new process', async () => (await kernelOf(door, id))?.guarded === true)

  // The second run: lost on its way there (the process is the one it was), settled as not done, the variables in place.
  assert.deepEqual(await run('x = 8'), { state: 'ok', text: '', errors: [] })
  const missed = await restartThroughCut('ignored', 2)
  assert.ok(missed.includes(tr('server.theRestartDidNotGetThroughThe.92177b')), missed.join('\n'))
  assert.ok(!missed.includes(tr('server.theRestartWentThroughTheVariablesWere.96b635')))
  assert.deepEqual(await run('print(x)'), { state: 'ok', text: '8\n', errors: [] })

  assert.deepEqual([placementRow(id, 'room')?.state, placementRow(id, 'room')?.gen], ['ready', gen], 'the class never moved')
  assert.equal(await deletes(door), 0, 'no DELETE ever reached the machine')
})

test('B8 · a run limit firing during a cut lands when the link returns, on the same cell, never the next', { timeout: 90_000 }, async () => {
  const machine = await classMachine()
  // The room's limit of three seconds, each half a second of the wall here.
  setCouncilLimitTick(500)
  try {
    const { id, teacher, student, door, kernel } = await classOn(machine, 'B8 · предел во время обрыва', { cellLimitSec: 3 })
    const gen = placementRow(id, 'room')!.gen

    // One press runs two cells: the first holds on the machine past the limit, the second waits behind it.
    const held = teacher.notebook.add('print("held")\nHOLD b8\nprint("never")')
    const tail = teacher.notebook.add('print("tail")')
    teacher.control.send({ t: 'runAll' })
    await until('the held cell computing on the machine', async () => student.notebook.printed(held) === 'held\n' && (await kernelOf(door, id))?.busy === true)

    // The relay dark past home's dead timer, before the limit's time: the tunnel is cut at home.
    const notesFrom = student.notebook.notes().length
    await cut(TUNNEL_DEAD_MS)
    assert.ok(!home.tunnels!.isUp(machine.runnerId))
    assert.equal(student.notebook.state(tail), 'queued', 'the limit\'s time is still to come')
    // The limit fires in the cut: it drops the rest of its press, as any stop does, and its signal waits for the link.
    await until('the limit to fire', () => student.notebook.state(tail) === 'idle', 15_000, () => JSON.stringify(readCell(student.notebook.cell(tail)!)))
    await until('the room told of the dropped cell', () => student.notebook.notes().slice(notesFrom).includes(tr('server.theInterruptAlsoDroppedTheOneCell.612a37')), 15_000, () => student.notebook.notes().slice(notesFrom).join('\n'))
    assert.equal(await posts(door, kernel.id, 'interrupt'), 0, 'no signal reached the machine in the cut')
    // A later press, of its own: it waits behind the held cell.
    const next = teacher.notebook.add('print("next")\nCOUNT')
    teacher.control.send({ t: 'run', cellId: next })
    await until('the next cell queued', () => student.notebook.state(next) === 'queued')
    assert.equal(student.notebook.state(held), 'running')

    // The link back: the signal lands on the same cell, which stops as the limit says.
    relay.heal()
    const stopped = await student.notebook.settled(held)
    assert.deepEqual([stopped.state, stopped.text], ['error', 'held\n'])
    // The kernel's KeyboardInterrupt, read as the limit's stop.
    assert.equal(stopped.errors.length, 1, stopped.errors.join('\n'))
    assert.match(stopped.errors[0]!, words('server.cell.stoppedByLimit', ['p0']))
    // Never the next: it computes whole on the same kernel, and no second signal reaches the machine.
    assert.deepEqual(await student.notebook.settled(next), { state: 'ok', text: 'next\n1\n', errors: [] })
    assert.equal(await posts(door, kernel.id, 'interrupt'), 1, 'one signal, once the link was back')
    assert.equal(student.notebook.printed(tail), '')
    assert.ok(!(await door.requests()).some((one) => one.code.includes('print("tail")')), 'the dropped cell never reached the machine')
    assert.deepEqual([placementRow(id, 'room')?.state, placementRow(id, 'room')?.gen], ['ready', gen])
    assert.equal(await deletes(door), 0, 'no DELETE ever reached the machine')
  } finally {
    setCouncilLimitTick(1000)
  }
})

/* --------------------------------------------- what B.4's stall rests on */

/** A clock of the test's own: its timers run when it is moved, the earliest first, and never by themselves. */
class ManualClock implements TunnelClock {
  t = 1_000_000
  private seq = 0
  private readonly timers = new Map<number, { at: number; run: () => void }>()

  now = (): number => this.t
  setTimeout = (run: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timers.set(id, { at: this.t + Math.max(0, ms), run })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let next: [number, { at: number; run: () => void }] | null = null
      for (const entry of this.timers) if (entry[1].at <= end && (next === null || entry[1].at < next[1].at)) next = entry
      if (next === null) break
      this.timers.delete(next[0])
      this.t = Math.max(this.t, next[1].at)
      next[1].run()
    }
    this.t = end
  }
}

test('B4 (the tunnel) · a tunnel whose peer answers is never quiet: an end that heard nothing for half the quiet line PINGs at once, so a late PONG is no stall; a dead one is quiet from its last frame', () => {
  const clock = new ManualClock()
  // The agent's own clock stands still: it PINGs nothing of its own, and only answers home's.
  const still = new ManualClock()
  const toAgent: Uint8Array[] = []
  const toHome: Uint8Array[] = []
  const wire = (out: Uint8Array[]): TunnelSocket => ({ bufferedAmount: 0, send: (frame, done) => { out.push(frame.slice()); done() } })
  const said: Array<[boolean, number]> = []
  const home = new TunnelEnd({ side: 'home', socket: wire(toAgent), clock, build: 'dev', session: 'a'.repeat(32), hooks: { end: () => undefined, quiet: (quiet, since) => said.push([quiet, since]) } })
  const agent = new TunnelEnd({ side: 'agent', socket: wire(toHome), clock: still, build: 'dev', session: 'b'.repeat(32), hooks: { end: () => undefined } })
  const kinds = (frames: Uint8Array[]): string[] => frames.map((frame) => decodeTunnelFrame(frame, 'home').kind)
  /** Home's frames to the agent, and the agent's answers back: one round trip, `rttMs` on home's clock. */
  const roundTrip = (rttMs: number): string[] => {
    const sent = toAgent.splice(0)
    for (const frame of sent) agent.receive(frame, true)
    clock.advance(rttMs)
    for (const frame of toHome.splice(0)) home.receive(frame, true)
    return kinds(sent)
  }
  home.start()
  agent.start()
  for (const frame of toHome.splice(0)) home.receive(frame, true)
  roundTrip(0)
  assert.ok(home.up && agent.up, 'greeted both ways')

  // Its first PING as it opens, answered 100 ms later.
  clock.advance(0)
  assert.deepEqual(roundTrip(100), ['PING'])
  const startedAt = clock.now()
  // Nothing heard for half the quiet line: a PING at once, ahead of the ten seconds', answered.
  clock.advance(TUNNEL_PROBE_MS - 1)
  assert.deepEqual(kinds(toAgent), [], 'not before its moment')
  clock.advance(1)
  assert.deepEqual(roundTrip(100), ['PING'])
  // The ten seconds' PING, its PONG three seconds late: past the quiet line from the PONG before the probe's, not from this one.
  clock.advance(startedAt + TUNNEL_PING_MS - 100 - clock.now())
  const late = toAgent.splice(0)
  assert.deepEqual(kinds(late), ['PING'])
  for (const frame of late) agent.receive(frame, true)
  clock.advance(3_000)
  for (const frame of toHome.splice(0)) home.receive(frame, true)
  assert.ok(clock.now() - startedAt >= TUNNEL_QUIET_MS, 'the line a tunnel without the probe would have crossed')
  assert.deepEqual(said, [], 'an answering tunnel was never quiet')
  assert.equal(home.quiet, false)

  // The path dies: nothing more comes. Quiet once, from the last frame; still open, the dead timer not yet run out.
  const last = clock.now()
  toAgent.splice(0)
  clock.advance(TUNNEL_QUIET_MS - 1)
  assert.deepEqual(said, [])
  clock.advance(1)
  assert.deepEqual(said, [[true, last]])
  assert.ok(home.quiet && home.up, 'quiet, and its socket kept')
  // The next frame ends it.
  for (const frame of toAgent.splice(0)) agent.receive(frame, true)
  for (const frame of toHome.splice(0)) home.receive(frame, true)
  assert.deepEqual(said, [[true, last], [false, clock.now()]])
  assert.equal(home.quiet, false)
  home.close()
  agent.close()
})

/** What a machine says of itself when it joins (shared/remote-runner.ts · RemoteFacts). */
const FACTS: RemoteFacts = { version: '0.25.0', hostname: 'classes-e2e-b', platform: 'linux/amd64', cpus: 16, memoryMb: 65_536, diskMb: 200_000, docker: '28.3.1', storage: 'overlay2', driver: null }

test('B4 (the agent\'s end) · home\'s «reconnect», said while a stall kept the tunnel quiet and heard once it is over, leaves the tunnel that hears home; one that hears nothing is dialled again', { timeout: 60_000 }, async () => {
  // A class machine of its own, its end of the tunnel in this process on a clock of the test's: the rule is the agent's clock's.
  const minted = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, classes: true, createdBy: 'classes-e2e-b' })
  const joined = joinRunner({ code: minted.code, joinId: randomBytes(16).toString('hex'), build: 'dev', facts: FACTS, address: null }, Date.now())
  assert.ok(joined.ok)
  const runnerId = joined.runner.id
  const stall = await TunnelFault.start({ target: home.port })
  const clock = new ManualClock()
  const events: string[] = []
  const end = new AgentTunnel({
    url: tunnelUrl(stall.url),
    authorization: `Bearer ${remoteCredential(runnerId, joined.secret)}`,
    build: 'dev',
    resolve: () => ({ refused: 'gone' }),
    paceMBps: () => 1000,
    log: (event) => events.push(event),
    clock,
    relayState: async () => 'unknown',
  })
  try {
    end.want('open')
    await until('the tunnel up at home', () => home.tunnels!.isUp(runnerId), 30_000, () => home.tunnelLines.join('\n'))
    // Up a ping period on the agent's clock: old enough for home's word to be about this very tunnel.
    clock.t += TUNNEL_PING_MS

    // The relay stalls: home's end goes quiet, and its answer to the machine's syncs meanwhile is «reconnect».
    stall.blackhole()
    await turns()
    home.clock.advance(TUNNEL_QUIET_MS)
    await until('home\'s tunnel quiet', () => !home.tunnels!.isUp(runnerId))
    assert.equal(tunnelWanted(runnerId), 'reconnect')
    // The stall over: home's held frames reach the agent, and its answers home.
    stall.heal()
    await until('home hearing the machine again', () => home.tunnels!.isUp(runnerId))
    assert.equal(tunnelWanted(runnerId), 'open')

    // The stall's reply comes last: the tunnel hears home, and stays.
    end.want('reconnect')
    await turns()
    assert.ok(!events.includes('tunnel-stale'), events.join(', '))
    assert.equal(end.state().up, true)
    assert.ok(home.tunnels!.isUp(runnerId))

    // A tunnel that has heard nothing of home's for a ping period is the dropped one home means: ended, and dialled again.
    clock.t += TUNNEL_PING_MS
    end.want('reconnect')
    await until('the stale tunnel ended', () => events.includes('tunnel-stale') && !end.state().up)
  } finally {
    await end.close()
    await stall.close()
    revokeRunner(runnerId)
  }
})
