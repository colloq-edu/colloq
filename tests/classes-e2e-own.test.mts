/**
 * Classes on machines end to end: personal notebooks on machines
 * (docs/architecture/remote-classes.md §10, §17.2 A.2), on the harness of
 * tests/classes-e2e.test.mts.
 *
 * EVERYTHING IS THE REAL THING BUT THE DAEMON AND THE PYTHON. Home is the app
 * of this process with its tunnel door (tests/_remote-e2e-home.mts), its own
 * Jupyter a fake in this process for what computes here; a machine is the
 * real agent as a process of its own (tests/_remote-e2e-agent.mts) on the fake
 * docker (tests/_remote-e2e-docker.mjs), whose class containers are fake
 * Jupyters working in the machine's copy of the class folder; a fault proxy
 * stands where relay2 does before the machines a scenario cuts off
 * (tests/_tunnel-fault.mts). A class is made, placed and joined through the
 * doors its people use — the owner's panel, the room's join, a browser's
 * notebook socket (/collab, Yjs) and control socket (/control) — and what is
 * asserted is what they see there: outputs and notes in the room's document,
 * the frames of the control socket; besides them the database's placement
 * rows, both folders of the class (here and each machine's copy) and the call
 * log of every fake Jupyter: no DELETE ever reaches a placement that was lost.
 *
 * THE CLOCKS. The machines' liveness runs by hand (`liveness: 'manual'`), on
 * the home's clock, as in tests/classes-e2e-d.test.mts: a machine's silence
 * is so many passes of that clock with another machine heard as the path's
 * evidence. Everything else waits for an event.
 */
import './_remote-e2e-home.mts'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import type { Response as ExpressResponse } from 'express'
import { tr } from '../shared/i18n.js'
import { CLASS_PLACEMENT_DEFAULT, STAFF_COOKIE, type ClassPlacement } from '../shared/admin.js'
import type { ControlClientMessage, ControlServerMessage, JoinResponse } from '../shared/protocol.js'
import { REMOTE_BOOT_GRACE_MS } from '../shared/remote-runner.js'
import {
  CELLS_KEY,
  addBook,
  bookAt,
  bookCells,
  bookKernel,
  bookList,
  cellId,
  cellSource,
  createCell,
  getTerminal,
  readCell,
  readTerminalLine,
  type YCell,
} from '../shared/notebook.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { storedRules } from '../server/src/db.js'
import { heardAt, lastSync, useRemoteClock } from '../server/src/competitions/remote/heard.js'
import { remoteTick } from '../server/src/competitions/remote/liveness.js'
import { getRunner, mintRemoteCode, setRunnerClasses } from '../server/src/competitions/remote/store.js'
import { wakeRunner } from '../server/src/competitions/remote/wake.js'
import { jupyterSessionPath } from '../server/src/kernel/jupyter.js'
import { requestRun, shutdownKernels, sweepIdleKernels } from '../server/src/kernel/index.js'
import { ownPidsLimit } from '../server/src/kernel/perimeter.js'
import { kernelLimits, ownKernelMax } from '../server/src/kernel/pool.js'
import { placementOutlook } from '../server/src/kernel/remote/placement.js'
import { livePlacement, placementRow } from '../server/src/kernel/remote/placement-store.js'
import { sessionDir } from '../server/src/workspace.js'
import { Agent, createFleet, killAgents, removeClassContainers, type AgentTimings, type FakeClassContainer, type FakeJupyterDoor, type Fleet } from './_remote-e2e-agent.mts'
import { Home, kernelRevision, until } from './_remote-e2e-home.mts'
import { TunnelFault } from './_tunnel-fault.mts'

const home = new Home({ liveness: 'manual' })
let fleet: Fleet
/** Every socket a scenario opened: closed at the end of the file, whatever happened. */
const sockets = new Set<WebSocket>()
const proxies = new Set<TunnelFault>()

before(async () => {
  fleet = createFleet()
  await home.start()
  // The machines are heard on the home's clock: one that keeps syncing while the clock moves on is not silent.
  useRemoteClock(home.clock)
  // What computes on this server: the class notebooks of these classes, and a personal notebook back here after a loss.
  await home.homeJupyter()
  // Out of this life's boot grace before any machine is heard: a failover here is due to its rule alone.
  home.clock.advance(REMOTE_BOOT_GRACE_MS)
  // The classes' image, in the fleet's registry and noted here, as a portable revision of `base`.
  kernelRevision(fleet)
})

after(async () => {
  for (const ws of sockets) ws.terminate()
  // The kernels' clients and the rooms' documents of this process go first: no reconnect knocks on a machine that is gone.
  await shutdownKernels()
  shutdownCollab()
  await killAgents()
  await removeClassContainers()
  for (const proxy of proxies) await proxy.close()
  await home.close()
  useRemoteClock(null)
})

/* ------------------------------------------------------------------ people */

interface Staff {
  cookie: string
}

/** The owner, signed in: who says where classes compute (§6.2, D4). */
function staff(name = 'Преподавательница личных тетрадей'): Staff {
  const made = createTeacher({ name, email: `own.${Date.now()}.${randomBytes(3).toString('hex')}@example.edu`, role: 'owner' })!
  rotateLinkKey(made.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, made)
  return { cookie: `${STAFF_COOKIE}=${value}` }
}

/** A call through the home's doors, as a browser makes one. */
async function call<T>(method: string, at: string, body?: unknown, cookie?: string): Promise<{ status: number; body: T }> {
  const answer = await fetch(`${home.url}${at}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await answer.text()
  return { status: answer.status, body: (text ? JSON.parse(text) : null) as T }
}

const classes: Array<{ by: Staff; id: string }> = []

/**
 * A class made in the panel, its students' own notebooks allowed, and its
 * placement set in its «Ресурсы»: a core and a gigabyte, so that a CI
 * runner's few cores hold a scenario's classes.
 */
async function makeClass(by: Staff, name: string, placement: Partial<ClassPlacement>, rules: Record<string, unknown> = {}): Promise<string> {
  const made = await call<{ id: string }>('POST', '/api/admin/seminars', { name, environment: 'base', rules: { ownBooks: 'on', ...rules }, cpus: 1, memoryMb: 1024 }, by.cookie)
  assert.equal(made.status, 201, JSON.stringify(made.body))
  classes.push({ by, id: made.body.id })
  const set = await call('PATCH', `/api/admin/seminars/${made.body.id}`, { placement: { ...CLASS_PLACEMENT_DEFAULT, ...placement } }, by.cookie)
  assert.equal(set.status, 200, JSON.stringify(set.body))
  return made.body.id
}

/** The class is over: the owner stops its kernels, and its slots on machines stop there. */
async function endClass(by: Staff, sessionId: string): Promise<void> {
  const stopped = await call('POST', `/api/admin/resources/running/${sessionId}/stop`, { what: 'class', force: true }, by.cookie)
  assert.ok(stopped.status === 200 || stopped.status === 404, `${stopped.status} ${JSON.stringify(stopped.body)}`)
  await until(`class ${sessionId} off the machines`, () => livePlacement(sessionId, 'room') === null && livePlacement(sessionId, 'own') === null, 30_000, () => home.classLines.slice(-5).join('\n'))
}

afterEach(async () => {
  for (const { by, id } of classes.splice(0)) await endClass(by, id)
})

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

  add(source: string, root = CELLS_KEY): string {
    const cell = createCell('code', source)
    bookCells(this.doc, root).push([cell])
    return cellId(cell)
  }

  cell(id: string): YCell | null {
    for (const root of [CELLS_KEY, ...bookList(this.doc).map((book) => book.root)]) {
      const found = bookCells(this.doc, root).toArray().find((cell) => cellId(cell) === id)
      if (found) return found
    }
    return null
  }

  async settled(id: string, timeoutMs = 30_000): Promise<{ state: string; text: string; errors: string[] }> {
    return until(`cell ${id} to settle`, () => {
      const cell = this.cell(id)
      if (!cell) return null
      const read = readCell(cell)
      if (read.state !== 'ok' && read.state !== 'error') return null
      return {
        state: read.state,
        text: read.outputs.map((output) => (output.kind === 'stream' ? output.text : '')).join(''),
        errors: read.outputs.flatMap((output) => (output.kind === 'error' ? [`${output.ename}: ${output.evalue}`] : [])),
      }
    }, timeoutMs, () => JSON.stringify({ cell: this.cell(id) ? readCell(this.cell(id)!) : null, notes: this.notes() }))
  }

  notes(): string[] {
    return getTerminal(this.doc).toArray().map(readTerminalLine).filter((line) => line.kind === 'system').map((line) => line.text)
  }

  close(): void {
    this.ws.terminate()
  }
}

/** A browser's control socket (/control/<id>). */
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

  close(): void {
    this.ws.terminate()
  }
}

interface Tab {
  notebook: Notebook
  control: Control
}

async function tab(sessionId: string, name: string, by?: Staff, joined?: JoinResponse): Promise<Tab> {
  const token = joined ?? (await join(sessionId, name, by))
  return { notebook: await Notebook.open(sessionId, token, by), control: await Control.open(sessionId, token, by) }
}

function closeTabs(...tabs: Tab[]): void {
  for (const one of tabs) {
    one.notebook.close()
    one.control.close()
  }
}

/** A student's own notebook, made as the room's «Новая тетрадь» makes one (ownBooks: on), and its first cell typed in: the cell's id. */
async function ownNotebook(student: Tab, name: string, source: string): Promise<{ root: string; cell: string }> {
  student.control.send({ t: 'tree:new', path: name })
  const book = await until(`${name} in the room`, () => bookAt(student.notebook.doc, name))
  const cell = await until(`${name}'s first cell`, () => bookCells(student.notebook.doc, book.root).get(0))
  cellSource(cell).insert(0, source)
  return { root: book.root, cell: cellId(cell) }
}

/* ---------------------------------------------------------------- machines */

/** An agent's timings for these scenarios: a sync every half second, quick retries once the path is back. */
const FAST: AgentTimings = { holdMs: { idle: 500, busy: 500 }, backoffMs: { min: 200, max: 2_000 } }

interface Machine {
  label: string
  agent: Agent
  proxy: TunnelFault
  runnerId: string
}

const machines: Machine[] = []

/**
 * A machine joined through a fault proxy of its own, with a code minted
 * «Принимает занятия» (its tunnel up at home), or one the owner turns that on
 * for later (`classes: false`); its agent carries its own image either way,
 * as a class machine's daemon does.
 */
async function machine(label: string, options: { classes?: boolean } = {}): Promise<Machine> {
  const proxy = await TunnelFault.start({ target: home.port })
  proxies.add(proxy)
  const classes = options.classes ?? true
  const code = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, classes, namePrefix: label, createdBy: 'colloq-host' }).code
  const agent = new Agent(fleet, `${label}-${randomBytes(2).toString('hex')}`, { join: proxy.joinTarget(code), classes: true, timings: FAST, keepCalls: true })
  agent.start()
  const runnerId = await until(`${label} to join`, () => agent.identity()?.runnerId, 30_000, () => agent.log())
  if (classes) await until(`${label}'s tunnel up at home`, () => home.tunnels?.isUp(runnerId), 30_000, () => `${agent.log()}\n${home.tunnelLines.join('\n')}`)
  const made = { label, agent, proxy, runnerId }
  machines.push(made)
  return made
}

/** The owner disconnects a scenario's own machine (each hears 401 and exits): no later scenario's slot goes to it. */
async function revoke(m: Machine): Promise<void> {
  m.proxy.heal()
  await call('POST', `/api/admin/runners/${m.runnerId}/revoke`, undefined, staff().cookie).catch(() => undefined)
  if (m.agent.running) await m.agent.exit(15_000)
}

let shared: Machine | null = null

/** The machine the scenarios that need one share, as one machine takes several classes in a day. */
async function sharedMachine(): Promise<Machine> {
  shared ??= await machine('own')
  return shared
}

const nameOf = (m: Machine): string => getRunner(m.runnerId)!.name

/** Until the class's form says the machine takes its slot now (placement.ts · outlook). */
async function takes(m: Machine, sessionId: string): Promise<void> {
  let last: unknown = null
  await until(`${m.label} to take class ${sessionId}`, async () => {
    const outlook = await placementOutlook(sessionId)
    last = outlook
    return outlook.refusal === null && outlook.machines.find((one) => one.runnerId === m.runnerId)?.refusal === null
  }, 30_000, () => `${JSON.stringify(last)}\n${m.agent.log()}`)
}

/** A slot's class container on the machine, once it runs and its Jupyter listens. */
async function containerOf(m: Machine, sessionId: string, role: 'room' | 'own'): Promise<FakeClassContainer> {
  return until(`the ${role} container of ${sessionId} on ${m.label}`, () => {
    const found = m.agent.classContainer(sessionId, role)
    return found?.status === 'running' && found.port !== null ? found : null
  }, 30_000, () => m.agent.log())
}

/** Every DELETE a container's Jupyter was sent, in any life of it (keepCalls). */
function deletesTo(m: Machine, containerId: string): number {
  return m.agent.jupyterCalls(containerId).filter((one) => one.kind === 'http' && one.method === 'DELETE').length
}

/** The kernels a fake Jupyter keeps for a class's notebooks, alive. */
async function kernelsOf(door: FakeJupyterDoor, sessionId: string): Promise<string[]> {
  return (await door.kernels()).filter((one) => one.alive && one.path.startsWith(`${sessionId}/`)).map((one) => one.path)
}

/** A file of the class folder here, as text; null — none. */
function fileHere(sessionId: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(sessionDir(sessionId), rel), 'utf8')
  } catch {
    return null
  }
}

/** A file of a machine's copy of the class folder, as text; null — none. */
function fileThere(m: Machine, sessionId: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(m.agent.roomCopy(sessionId), rel), 'utf8')
  } catch {
    return null
  }
}

/** Let the event loop turn: what would happen at once, has. */
async function turns(count = 20): Promise<void> {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * One pass of the machines' liveness clock (liveness.ts · remoteTick, every
 * five seconds in production), on the home's clock: `ms` on, the machines
 * named heard since (a sync of theirs at the moved time), then the pass.
 */
async function pass(ms: number, heard: Machine[]): Promise<number> {
  const before = new Map(heard.map((m) => [m, lastSync(m.runnerId)]))
  home.clock.advance(ms)
  const moved = home.clock.now()
  for (const m of heard) {
    await until(`${m.label} to sync at the moved time`, () => lastSync(m.runnerId) !== before.get(m) && (heardAt(m.runnerId) ?? Number.NEGATIVE_INFINITY) >= moved, 20_000, () => m.agent.log())
  }
  const now = home.clock.now()
  remoteTick(now)
  await turns()
  return now
}

/** A server word with its placeholders as patterns: what a room reads, whatever the clock said in it. */
function words(key: string, names: readonly string[]): RegExp {
  const marks = Object.fromEntries(names.map((name, i) => [name, `\u0000${i}\u0000`]))
  const escaped = tr(key, marks).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\u0000\d+\u0000/g, '.+?')}$`)
}

/* --------------------------------------------------------------- scenarios */

test('ten personal kernels on a machine, the class notebook here: one container with ownLimits, their files home, the class notebook reading them; idle, they retire and leave no container', { timeout: 120_000 }, async () => {
  const m = await sharedMachine()
  const teacher = staff()
  const here = await home.homeJupyter()
  const id = await makeClass(teacher, 'Личные тетради на машине', { own: 'machines' })
  await takes(m, id)
  const lead = await tab(id, 'Преподавательница', teacher)
  await until('the class notebook\'s kernel here', () => here.kernelAt(jupyterSessionPath(id, CELLS_KEY)))
  // The first participant warmed the personal notebooks' container: there before anyone runs one, no kernel in it.
  const own = await containerOf(m, id, 'own')
  const door = m.agent.jupyterOf(own)
  assert.deepEqual(await kernelsOf(door, id), [])
  const row = livePlacement(id, 'own')!
  assert.equal(row.runnerId, m.runnerId)
  assert.deepEqual([own.memoryMb, own.cpus], Object.values(kernelLimits(id, 'base', 'own')), 'ownLimits, as here')
  assert.equal(own.pids, ownPidsLimit(), 'the personal notebooks\' process ceiling')
  // No card, by construction, is held where a card could be had: tests/class-own.test.mts (the contract and the agent).
  assert.equal(livePlacement(id, 'room'), null, 'the class notebook stays here')

  // Ten students, each in a personal notebook of their own, each writing a file of the class folder there.
  const students = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    const student = await tab(id, `Студент ${i + 1}`)
    const { root, cell } = await ownNotebook(student, `моя-${i + 1}.ipynb`, `who = "студент ${i + 1}"\nWRITE out/s${i + 1}.txt from ${i + 1}\nprint(who)`)
    student.control.send({ t: 'run', cellId: cell })
    return { student, root, cell, i }
  }))
  for (const { student, cell, i } of students) assert.deepEqual(await student.notebook.settled(cell), { state: 'ok', text: `студент ${i + 1}\n`, errors: [] })
  const personal = await kernelsOf(door, id)
  assert.deepEqual(personal.sort(), students.map(({ root }) => jupyterSessionPath(id, root)).sort(), 'ten personal kernels in the one container')
  assert.deepEqual(m.agent.classContainers().filter((c) => c.labels.includes(`colloq.session=${id}`)).map((c) => c.id), [own.id], 'one personal notebooks\' container for the class (D6)')
  for (const { root } of students) assert.equal(here.kernelAt(jupyterSessionPath(id, root)) ?? null, null)

  // Their files come home by the machine's scans, and the class notebook here reads one of them.
  for (const { i } of students) await until(`out/s${i + 1}.txt here`, () => fileHere(id, `out/s${i + 1}.txt`) === `from ${i + 1}`, 20_000, () => m.agent.log())
  const read = lead.notebook.add('READ out/s7.txt')
  lead.control.send({ t: 'run', cellId: read })
  assert.deepEqual(await lead.notebook.settled(read), { state: 'ok', text: 'from 7', errors: [] })
  assert.ok(here.requests.some((one: { code: string }) => one.code === 'READ out/s7.txt'), 'read here, from this server\'s folder')

  // Half an hour of nothing: every personal kernel retires as one here does, its session deleted over there, and with the last
  // one the container goes, a durable stop at its gen that the machine carries out.
  const deletesBefore = deletesTo(m, own.id)
  await sweepIdleKernels(Date.now() + 31 * 60_000)
  assert.equal(deletesTo(m, own.id) - deletesBefore, 10, 'ten DELETEs, through the tunnel to a placement that answers')
  const stopped = placementRow(id, 'own')!
  assert.equal(stopped.gen, row.gen)
  assert.ok(stopped.state === 'stopping' || stopped.state === 'stopped', stopped.state)
  await until('the personal notebooks\' container gone from the machine', () => m.agent.classContainer(id, 'own') === null, 30_000, () => m.agent.log())
  await until('its placement stopped', () => placementRow(id, 'own')?.state === 'stopped', 30_000, () => home.classLines.slice(-5).join('\n'))
  for (const { student, root } of students) await until(`${root} «не запущено»`, () => bookKernel(student.notebook.doc, root).status === 'off')
  assert.ok(lead.notebook.notes().some((note) => note.includes(tr('server.kernel.ownIdle', { p0: 30 }))))
  // The class notebook here keeps its kernel.
  assert.ok(here.kernelAt(jupyterSessionPath(id, CELLS_KEY)), 'the class notebook\'s kernel here is untouched')
  closeTabs(lead, ...students.map(({ student }) => student))
})

test('the class notebook on one machine and the personal notebooks on another, each copy synced with this server only; the personal notebooks\' machine lost: the class notebook computes on, the personal kernels come back at their next Run', { timeout: 150_000 }, async () => {
  // The class notebook's machine is the file's own; the other takes classes once the class notebook is placed (as D14's does).
  const roomOn = await sharedMachine()
  const ownOn = await machine('own-b', { classes: false })
  try {
    await twoMachines(roomOn, ownOn)
  } finally {
    await revoke(ownOn)
  }
})

async function twoMachines(roomOn: Machine, ownOn: Machine): Promise<void> {
  const teacher = staff()
  const here = await home.homeJupyter()
  // The personal notebooks take every core a machine offers but its own: once one holds the class notebook it is full for them (D5),
  // and they spill to the other.
  const cores = os.availableParallelism() - 1
  const id = await makeClass(teacher, 'Две машины', { room: 'machines', own: 'machines', failoverSec: 45 }, { ownCpus: cores })
  await takes(roomOn, id)

  // The teacher joins: the class notebook's kernel comes up on its machine.
  const joined = await join(id, 'Преподавательница', teacher)
  const roomRow = await until('the class notebook\'s slot placed', () => livePlacement(id, 'room'))
  assert.equal(roomRow.runnerId, roomOn.runnerId)
  const lead = await tab(id, 'Преподавательница', teacher, joined)
  const roomBox = await containerOf(roomOn, id, 'room')
  const roomDoor = roomOn.agent.jupyterOf(roomBox)
  const x = lead.notebook.add('x = 5\nprint(x)\nCOUNT')
  lead.control.send({ t: 'run', cellId: x })
  assert.deepEqual(await lead.notebook.settled(x), { state: 'ok', text: '5\n1\n', errors: [] })
  const roomKernel = (await roomDoor.kernels()).find((one) => one.path === jupyterSessionPath(id, CELLS_KEY))!
  // No machine had cores for the personal notebooks beside the class notebook: their warm start warmed nothing, here neither.
  assert.equal(livePlacement(id, 'own'), null)

  // The owner turns the other machine's classes on: its tunnel comes up, and it could take the personal notebooks now.
  assert.equal('refused' in setRunnerClasses(ownOn.runnerId, true), false)
  wakeRunner(ownOn.runnerId)
  await takes(ownOn, id)

  // A student's personal notebook computes on it — a second machine for the slot that does not fit on the first — and writes a file there.
  const student = await tab(id, 'Студентка')
  const own = await ownNotebook(student, 'моя.ipynb', 'WRITE shared/from-own.txt from the personal notebook\nprint("own")')
  student.control.send({ t: 'run', cellId: own.cell })
  assert.deepEqual(await student.notebook.settled(own.cell), { state: 'ok', text: 'own\n', errors: [] })
  assert.equal(livePlacement(id, 'own')?.runnerId, ownOn.runnerId)
  const ownBox = await containerOf(ownOn, id, 'own')
  assert.equal(ownBox.cpus, cores)
  assert.ok((await kernelsOf(ownOn.agent.jupyterOf(ownBox), id)).includes(jupyterSessionPath(id, own.root)))

  // Each copy talks to this server only: the personal notebook's file comes home, then goes to the class notebook's machine with
  // its next Run; the class notebook's goes the other way.
  await until('the personal notebook\'s file here', () => fileHere(id, 'shared/from-own.txt') === 'from the personal notebook', 20_000, () => ownOn.agent.log())
  const readOwn = lead.notebook.add('READ shared/from-own.txt\nWRITE shared/from-room.txt from the class notebook')
  lead.control.send({ t: 'run', cellId: readOwn })
  assert.deepEqual(await lead.notebook.settled(readOwn), { state: 'ok', text: 'from the personal notebook', errors: [] })
  assert.equal(fileThere(roomOn, id, 'shared/from-own.txt'), 'from the personal notebook')
  await until('the class notebook\'s file here', () => fileHere(id, 'shared/from-room.txt') === 'from the class notebook', 20_000, () => roomOn.agent.log())
  const readRoom = student.notebook.add('READ shared/from-room.txt', own.root)
  student.control.send({ t: 'run', cellId: readRoom })
  assert.deepEqual(await student.notebook.settled(readRoom), { state: 'ok', text: 'from the class notebook', errors: [] })
  assert.equal(fileThere(ownOn, id, 'shared/from-room.txt'), 'from the class notebook')

  // The personal notebooks' machine is cut off; the other is heard all along. Past the class's 45 s of proven silence it fails over.
  ownOn.proxy.blackhole()
  await turns()
  let moved = false
  for (let i = 0; i < 20 && !moved; i++) {
    await pass(5_000, [roomOn])
    moved = placementRow(id, 'own')?.state === 'lost'
  }
  assert.ok(moved, 'the personal notebooks\' slot failed over')
  assert.equal(placementRow(id, 'own')?.reason, 'silence')
  // Only that slot: the class notebook's never moved, and computes on in the same kernel, its variables with it.
  const still = livePlacement(id, 'room')!
  assert.deepEqual([still.state, still.runnerId, still.gen], ['ready', roomOn.runnerId, roomRow.gen])
  const y = lead.notebook.add('print(x)\nCOUNT')
  lead.control.send({ t: 'run', cellId: y })
  assert.deepEqual(await lead.notebook.settled(y), { state: 'ok', text: '5\n2\n', errors: [] })
  assert.equal((await roomDoor.kernels()).find((one) => one.path === jupyterSessionPath(id, CELLS_KEY))?.id, roomKernel.id)
  // The room heard the personal notebooks' words, once, without the machine's name.
  const ownLost = [words('server.thePersonalNotebooksMachineHasNotAnswered.ae4676', ['since', 'filesAt']), words('server.thePersonalNotebooksMachineHasNotAnswered.69b338', ['since'])]
  await until('the room told the personal notebooks\' kernels are gone', () => lead.notebook.notes().some((note) => ownLost.some((pattern) => pattern.test(note))), 20_000, () => lead.notebook.notes().join('\n'))
  assert.equal(lead.notebook.notes().filter((note) => ownLost.some((pattern) => pattern.test(note))).length, 1)
  assert.ok(!JSON.stringify(lead.notebook.doc.toJSON()).includes(nameOf(ownOn)), 'the room\'s document never names the machine')
  await until('the personal notebook «не запущено»', () => bookKernel(student.notebook.doc, own.root).status === 'off')
  // And nothing brings a personal kernel back behind the student's back.
  await pass(5_000, [roomOn])
  assert.equal(placementRow(id, 'own')?.state, 'lost')
  assert.equal(here.kernelAt(jupyterSessionPath(id, own.root)) ?? null, null)
  assert.deepEqual(await kernelsOf(roomDoor, id), [jupyterSessionPath(id, CELLS_KEY)])

  // The teacher gives the personal notebooks the class's own cores again; the student's next Run brings their kernel up on the
  // class notebook's machine, which has room for it now, or here when it has not (a runner of two cores).
  const fits = os.availableParallelism() - 2 >= 1
  assert.equal((await call('PATCH', `/api/admin/seminars/${id}`, { rules: { ownCpus: null } }, teacher.cookie)).status, 200)
  const again = student.notebook.add('print("again")', own.root)
  student.control.send({ t: 'run', cellId: again })
  assert.deepEqual(await student.notebook.settled(again), { state: 'ok', text: 'again\n', errors: [] })
  if (fits) {
    assert.equal(livePlacement(id, 'own')?.runnerId, roomOn.runnerId, 'back on the other machine')
    await until('the room told where they came back', () => lead.notebook.notes().includes(tr('server.thePersonalNotebooksKernelsWereStartedOn.3d0553')), 20_000, () => lead.notebook.notes().join('\n'))
  } else {
    assert.equal(livePlacement(id, 'own'), null)
    assert.ok(here.kernelAt(jupyterSessionPath(id, own.root)), 'back here')
    assert.ok(lead.notebook.notes().includes(tr('server.noMachineCanTakeTheKernelNow.53437e')))
  }

  // The lost machine comes back: it hears the fence and removes the container it held, and no DELETE ever reached it.
  ownOn.proxy.heal()
  await until('the lost machine\'s personal notebooks\' container removed', () => ownOn.agent.classContainer(id, 'own') === null, 30_000, () => ownOn.agent.log())
  assert.equal(deletesTo(ownOn, ownBox.id), 0, 'no DELETE ever reached the lost placement')
  assert.equal(deletesTo(roomOn, roomBox.id), 0)
  closeTabs(lead, student)
}

test('sixty-one personal kernels pressed at once: the sixty-first is refused with words, on the machine as here; once one of the sixty goes, its Run computes', { timeout: 150_000 }, async () => {
  const m = await sharedMachine()
  const teacher = staff()
  const limit = ownKernelMax()
  assert.equal(limit, 60, 'the default ceiling (§10)')
  const id = await makeClass(teacher, 'Шестьдесят личных тетрадей', { own: 'machines' })
  await takes(m, id)
  // Sixty personal notebooks, each of its own student (their rules say so: shared/rules.ts · bookHasOwnKernel), a cell in each.
  const { doc } = getSessionDoc(id)
  const books = Array.from({ length: limit }, (_, i) => addBook(doc, `личная-${i + 1}.ipynb`))
  const owners = Object.fromEntries(books.map((book, i) => [book.root, { access: 'owner', owner: `p_s${i + 1}`, ownerName: `Студент ${i + 1}` }]))
  assert.equal((await call('PATCH', `/api/admin/seminars/${id}`, { rules: { books: owners } }, teacher.cookie)).status, 200)
  const cells = books.map((book, i) => {
    const cell = createCell('code', `print(${i + 1})`)
    bookCells(doc, book.root).push([cell])
    return cellId(cell)
  })
  // And a sixty-first: a latecomer's own notebook, made through the room's doors (their coming in warms the container up).
  const late = await tab(id, 'Опоздавший')
  const mine = await ownNotebook(late, 'моя.ipynb', 'print("61")')
  const own = await containerOf(m, id, 'own')
  const door = m.agent.jupyterOf(own)
  assert.deepEqual(await kernelsOf(door, id), [])

  // Everyone presses Run at once: the sixty as their control sockets press it, the latecomer while those are still coming up.
  books.forEach((book, i) => requestRun(id, [cells[i]!], `Студент ${i + 1}`, `p_s${i + 1}`, undefined, book.root))
  late.control.send({ t: 'run', cellId: mine.cell })
  const refused = await late.notebook.settled(mine.cell)
  assert.equal(refused.state, 'error')
  assert.ok(refused.errors.some((error) => error.includes(tr('server.kernel.ownFull', { p0: limit }))), JSON.stringify(refused))
  await until('sixty personal kernels done', () => cells.every((cell, i) => readCell(bookCells(doc, books[i]!.root).toArray().find((one) => cellId(one) === cell)!).state === 'ok'), 90_000)
  assert.equal((await kernelsOf(door, id)).length, limit, 'sixty kernels in the container, the sixty-first never asked for')
  assert.ok(!(await kernelsOf(door, id)).includes(jupyterSessionPath(id, mine.root)))

  // One of the sixty is a class notebook again (its access changed): its kernel goes, and the latecomer's Run computes.
  const kept = Object.fromEntries(Object.entries(storedRules(id).books ?? {}).filter(([root]) => root !== books[0]!.root))
  assert.ok(kept[mine.root], 'the latecomer\'s own notebook is theirs by the rules the room wrote')
  assert.equal((await call('PATCH', `/api/admin/seminars/${id}`, { rules: { books: kept } }, teacher.cookie)).status, 200)
  await until('the first one\'s personal kernel gone', async () => !(await kernelsOf(door, id)).includes(jupyterSessionPath(id, books[0]!.root)), 20_000)
  late.control.send({ t: 'run', cellId: mine.cell })
  await until('the latecomer\'s cell computed', () => readCell(late.notebook.cell(mine.cell)!).outputs.some((output) => output.kind === 'stream' && output.text === '61\n'), 30_000, () => JSON.stringify(readCell(late.notebook.cell(mine.cell)!)))
  assert.equal((await kernelsOf(door, id)).length, limit, 'sixty again, never sixty-one')
  closeTabs(late)
})
