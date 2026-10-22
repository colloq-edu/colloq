/**
 * Classes on machines end to end, scenarios E: the council on machines
 * (docs/architecture/remote-classes.md §17.2 E.25–E.31, §9), on the harness
 * of tests/classes-e2e.test.mts.
 *
 * THE POOL IS THE REAL ONE, AND SO IS EVERYTHING AROUND IT BUT THE DAEMON AND
 * THE PYTHON. Home is the app of this process (tests/_remote-e2e-home.mts)
 * with its council pool (kernel/council-pool.ts) and its epochs
 * (kernel/remote/epochs.ts); a machine is the real agent as a process of its
 * own (tests/_remote-e2e-agent.mts) on the fake docker, whose class
 * containers are fake Jupyters (tests/_fake-jupyter.mjs). The class's council
 * container is one fake whose sessions are the pool's workers: each loads
 * its epoch from the epochs folder the agent fills (`--epochs-dir`), every
 * file of it checked against its sha256, and runs each attempt in a folder of
 * its own under /colloq/scratch (`--scratch-dir`), the class folder seen
 * read-only. An epoch's export is the fake's: the notebook kernel's bindings,
 * its files written into its container's /tmp/colloq-epoch/<seq> — a room
 * container's on the machine, which the agent copies out with `docker cp`;
 * home's own fake, whose folder the e2e home copies out as `docker cp`
 * would, its files then fetched by the machine from home's store.
 *
 * PEOPLE USE THEIR OWN DOORS. The teacher opens the council, marks, shows and
 * adopts through the control socket (`cell:lock`, `council:mark`,
 * `council:show`, `council:adopt`, `run`); students draft and run theirs
 * (`council:draft`, `council:run`). Asserted is what each hears there — the
 * author's card (`council:mine`), the console's kernel frame with the pool
 * (`council:kernel`), the room's `council:shown` — the room's document, what
 * the database holds (the epochs' registry, the placements), each fake
 * Jupyter's own log of its calls, its holds and its council module (exports,
 * loads, entries, exits), the machine's folders, and that no DELETE reached a
 * container.
 *
 * THE POOL'S CLOCK IS THE TEST'S (council-pool.ts · usePoolClock): it stands
 * still unless a scenario moves it, so the five seconds an attempt waits for
 * a fresher epoch (D8) pass when the scenario says, never because a machine
 * was slow. Everything else is waited for as an event.
 *
 * ONE MACHINE SERVES THE FILE, as in scenarios A: each scenario makes its
 * classes on it and the owner stops their kernels once it is over. E.29
 * takes the machine's classes away («Не принимает занятия»), so it runs last.
 *
 * E.31'S CRASH is the home's (Home.restart: the port closed, every
 * connection cut, a new life on the same database) and what a new process
 * starts without that this one would keep: the rooms' kernels and the pools
 * (abandonKernelsForTest), the council's attempts read from the database
 * anew (resetCouncilCache), and the machines' word on the epochs
 * (resetEpochsForTest).
 */
import './_remote-e2e-home.mts'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import type { Response as ExpressResponse } from 'express'
import { tr } from '../shared/i18n.js'
import { STAFF_COOKIE, type ClassPlacement } from '../shared/admin.js'
import type { ControlClientMessage, ControlServerMessage, CouncilKernel, CouncilMine, CouncilPool, CouncilRun, CouncilSettings, JoinResponse } from '../shared/protocol.js'
import { COUNCIL_EPOCH_WAIT_MS, COUNCIL_WORKER_BASE_MB } from '../shared/remote-kernels.js'
import { REMOTE_API_BASE } from '../shared/remote-runner.js'
import { CELLS_KEY, bookCells, cellId, cellSource, createCell, getTerminal, readCell, readTerminalLine, type YCell } from '../shared/notebook.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { getRunner, mintRemoteCode } from '../server/src/competitions/remote/store.js'
import { resetCouncilCache } from '../server/src/council.js'
import { abandonKernelsForTest, councilWorkerRoot, setCouncilLimitTick, shutdownKernels } from '../server/src/kernel/index.js'
import { poolForTest, usePoolClock, type PoolClock } from '../server/src/kernel/council-pool.js'
import { councilLeftWords } from '../server/src/kernel/council-isolation.js'
import { jupyterSessionPath } from '../server/src/kernel/jupyter.js'
import { placementOutlook } from '../server/src/kernel/remote/placement.js'
import { livePlacement, placementRow } from '../server/src/kernel/remote/placement-store.js'
import { artifactPath, epochFileList, epochsOf, resetEpochsForTest, type Epoch } from '../server/src/kernel/remote/epochs.js'
import { sessionDir, writeText } from '../server/src/workspace.js'
import { instanceTimeZone } from '../server/src/time-zone.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { Agent, createFleet, killAgents, removeClassContainers, type AgentTimings, type FakeClassContainer, type FakeJupyterDoor, type Fleet } from './_remote-e2e-agent.mts'
import { Home, kernelRevision, until } from './_remote-e2e-home.mts'

const home = new Home({ liveness: 'manual' })
let fleet: Fleet
/** Every socket a scenario opened: closed at the end of the file, whatever happened. */
const sockets = new Set<WebSocket>()

/* ------------------------------------------------------------ the pool's clock */

/**
 * A clock that stands still until the test moves it: the pool's timers (the
 * D8 wait, its look every five seconds, a drain's two seconds) fire as
 * `advance` passes them, the earliest first, and not otherwise.
 */
class StillClock implements PoolClock {
  private at = Date.now()
  private seq = 0
  private readonly timers = new Map<number, { at: number; run: () => void }>()

  now(): number {
    return this.at
  }

  setTimeout(run: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { at: this.at + Math.max(0, ms), run })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  advance(ms: number): void {
    const end = this.at + Math.max(0, ms)
    for (;;) {
      let next: [number, { at: number; run: () => void }] | null = null
      for (const entry of this.timers) if (entry[1].at <= end && (next === null || entry[1].at < next[1].at)) next = entry
      if (next === null) break
      this.timers.delete(next[0])
      this.at = Math.max(this.at, next[1].at)
      next[1].run()
    }
    this.at = end
  }
}

const poolClock = new StillClock()

before(async () => {
  fleet = createFleet()
  await home.start()
  // What computes on this server: a class notebook kept here, whose council's pool is on the machine.
  await home.homeJupyter()
  // The class environment's image, in the fleet's registry and noted at home: what a class's slots run on a machine.
  kernelRevision(fleet)
  usePoolClock(poolClock)
})

after(async () => {
  for (const ws of sockets) ws.terminate()
  setCouncilLimitTick(1000)
  // The kernels' clients and the rooms' documents of this process go first: no reconnect knocks on a machine that is gone.
  await shutdownKernels()
  shutdownCollab()
  usePoolClock(null)
  await killAgents()
  await removeClassContainers()
  await home.close()
})

/* ------------------------------------------------------------------ people */

interface Staff {
  /** The Cookie header a signed-in teacher's browser sends. */
  cookie: string
}

/** A teacher of this instance, signed in: the owner, who also says where classes compute (§6.2, D4). */
function staff(name = 'Преподавательница E'): Staff {
  const made = createTeacher({ name, email: `e.${Date.now()}.${randomBytes(3).toString('hex')}@example.edu`, role: 'owner' })!
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

/** The classes the scenario running now made: the owner stops each one's kernels once it is over (afterEach). */
const classes: Array<{ by: Staff; id: string }> = []

/**
 * A class made in the panel (POST /api/admin/seminars) on the base
 * environment, its placement set in its «Ресурсы» (PATCH, the owner's call):
 * where its notebooks compute, and its council's pool on the machine with
 * its «Попыток одновременно» and «Память на попытку». A core and a gigabyte
 * for the class's own container, as the other scenario files make theirs.
 */
async function makeClass(by: Staff, name: string, placement: Partial<ClassPlacement>): Promise<string> {
  const made = await call<{ id: string }>('POST', '/api/admin/seminars', { name, environment: 'base', rules: {}, cpus: 1, memoryMb: 1024 }, by.cookie)
  assert.equal(made.status, 201, JSON.stringify(made.body))
  classes.push({ by, id: made.body.id })
  const set = await call('PATCH', `/api/admin/seminars/${made.body.id}`, { placement }, by.cookie)
  assert.equal(set.status, 200, JSON.stringify(set.body))
  return made.body.id
}

/**
 * The class is over: the owner stops its kernels («Остановить» in «Работают
 * сейчас»), its slots on the machine stop there — the council's container
 * among them — and the machine's cores are free for the next class.
 */
async function endClass(by: Staff, sessionId: string): Promise<void> {
  const stopped = await call<{ error?: string }>('POST', `/api/admin/resources/running/${sessionId}/stop`, { what: 'class', force: true }, by.cookie)
  assert.ok(stopped.status === 200 || stopped.status === 404, `${stopped.status} ${JSON.stringify(stopped.body)}`)
  await until(`class ${sessionId} off the machine`, () => (['room', 'own', 'council'] as const).every((role) => livePlacement(sessionId, role) === null), 30_000, () => home.classLines.slice(-5).join('\n'))
}

afterEach(async () => {
  for (const { by, id } of classes.splice(0)) await endClass(by, id)
})

/** «Войти» on the room's page (POST /api/sessions/:id/join): the token its sockets open with. */
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
    await until('the notebook to sync', () => bookCells(notebook.doc, CELLS_KEY).length > 0)
    return notebook
  }

  /** A code cell typed at the end of the class notebook: its id. */
  add(source: string): string {
    const cell = createCell('code', source)
    bookCells(this.doc, CELLS_KEY).push([cell])
    return cellId(cell)
  }

  cell(id: string): YCell | null {
    return bookCells(this.doc, CELLS_KEY).toArray().find((cell) => cellId(cell) === id) ?? null
  }

  /** The cell's number in the class notebook, as the room's margin draws it. */
  number(id: string): number {
    return bookCells(this.doc, CELLS_KEY).toArray().findIndex((cell) => cellId(cell) === id) + 1
  }

  state(id: string): string | null {
    const cell = this.cell(id)
    return cell ? readCell(cell).state : null
  }

  source(id: string): string | null {
    const cell = this.cell(id)
    return cell ? cellSource(cell).toString() : null
  }

  /** The cell's state and printed text, once it has settled (ok or error). */
  async settled(id: string, timeoutMs = 20_000): Promise<{ state: string; text: string; errors: string[] }> {
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
    }, timeoutMs, () => JSON.stringify({ cell: this.cell(id) ? readCell(this.cell(id)!) : null, socket: this.ws.readyState }))
  }

  /** The room's notes: the system lines of the shared terminal, where the kernel's news is written. */
  notes(): string[] {
    return getTerminal(this.doc).toArray().map(readTerminalLine).filter((line) => line.kind === 'system').map((line) => line.text)
  }

  close(): void {
    this.ws.terminate()
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

  /** The frames of one kind about one cell, oldest first. */
  frames<K extends ControlServerMessage['t']>(t: K, cell: string): Array<Extract<ControlServerMessage, { t: K }>> {
    return this.heard.filter((frame): frame is Extract<ControlServerMessage, { t: K }> => frame.t === t && (frame as { cellId?: string }).cellId === cell)
  }

  /** The first frame from `from` on that `pick` takes. */
  async frame<T>(what: string, pick: (frame: ControlServerMessage) => T | null | undefined | false, from = 0, timeoutMs = 20_000): Promise<T> {
    return until(what, () => {
      for (const frame of this.heard.slice(from)) {
        const picked = pick(frame)
        if (picked) return picked
      }
      return null
    }, timeoutMs, () => JSON.stringify(this.heard.slice(-6)))
  }

  close(): void {
    this.ws.terminate()
  }
}

/** A browser tab in a room, joined, with both of its sockets: a teacher's, signed in. */
interface Tab {
  joined: JoinResponse
  notebook: Notebook
  control: Control
}

async function tab(sessionId: string, name: string, by: Staff): Promise<Tab> {
  const joined = await join(sessionId, name, by)
  return { joined, notebook: await Notebook.open(sessionId, joined, by), control: await Control.open(sessionId, joined, by) }
}

/** A student in the room: the control socket is all a council needs of them (their sheet is not in the document). */
interface Student {
  name: string
  /** Their participant id: what the teacher marks, shows and adopts them by. */
  id: string
  joined: JoinResponse
  control: Control
}

async function student(sessionId: string, name: string): Promise<Student> {
  const joined = await join(sessionId, name)
  return { name, id: joined.participant.id, joined, control: await Control.open(sessionId, joined) }
}

/** The student writes their attempt on their sheet and presses «Запустить». */
function attempt(who: Student, cell: string, text: string): void {
  who.control.send({ t: 'council:draft', cellId: cell, text })
  who.control.send({ t: 'council:run', cellId: cell })
}

/** Every run their card was told of, in order (`council:mine`), a frame with none dropped. */
function runsOf(who: Student, cell: string): CouncilRun[] {
  return who.control.frames('council:mine', cell).flatMap((frame) => (frame.state.run ? [frame.state.run] : []))
}

/** Their card as it stands. */
function cardOf(who: Student, cell: string): CouncilMine | null {
  return who.control.frames('council:mine', cell).at(-1)?.state ?? null
}

/** Until their card says the run has ended (ok or error): that run. */
async function ended(who: Student, cell: string, timeoutMs = 20_000): Promise<CouncilRun> {
  return until(`${who.name}'s run to end`, () => {
    const run = cardOf(who, cell)?.run
    return run && (run.state === 'ok' || run.state === 'error') ? run : null
  }, timeoutMs, () => JSON.stringify(runsOf(who, cell).map((run) => [run.state, run.placed, run.note, run.epoch])))
}

/** What a run printed, and its errors as `name: words`. */
function printed(run: CouncilRun): { text: string; errors: string[] } {
  return {
    text: run.outputs.map((output) => (output.kind === 'stream' ? output.text : '')).join(''),
    errors: run.outputs.flatMap((output) => (output.kind === 'error' ? [`${output.ename}: ${output.evalue}`] : [])),
  }
}

/* ------------------------------------------------------------- the council */

/** The council cell's rules as these scenarios open it: students run their own attempts, on the pool, the epoch following the kernel. */
const RULES: Partial<CouncilSettings> = { studentRun: true, runLimitSec: null, rerunPauseSec: 0, lane: 'pool', refresh: 'auto' }

/** The teacher opens the council on a cell (the lock's «Консилиум»): the class's pool starts and its epoch is taken (§9.2, §9.5). */
function openCouncil(lead: Tab, cell: string, rules: Partial<CouncilSettings> = {}): void {
  lead.control.send({ t: 'cell:lock', cellId: cell, state: 'council', settings: { ...RULES, ...rules } })
}

/** What the console last heard of the notebook's kernel for this cell (`council:kernel`). */
function kernelOf(lead: Tab, cell: string): CouncilKernel | null {
  return lead.control.frames('council:kernel', cell).at(-1)?.kernel ?? null
}

/** Until the console says the pool is ready with this many workers up and none busy: its view then. */
async function poolReady(lead: Tab, cell: string, workers: number, timeoutMs = 30_000): Promise<CouncilPool> {
  return until(`the pool ready with ${workers} workers`, () => {
    const pool = kernelOf(lead, cell)?.pool
    return pool?.state === 'ready' && pool.workers === workers && pool.busy === 0 && !pool.refreezing ? pool : null
  }, timeoutMs, () => `${JSON.stringify(kernelOf(lead, cell))}\n${home.classLines.slice(-6).join('\n')}`)
}

/* ---------------------------------------------------------------- machines */

/** An agent's timings for these scenarios: a sync every half second while nothing comes, and quick retries. */
const FAST: AgentTimings = { holdMs: { idle: 500, busy: 500 }, backoffMs: { min: 200, max: 2_000 } }

let shared: Agent | null = null

/**
 * The file's class machine: joined with a code minted «Принимает занятия»,
 * its tunnel up at home, each class container's Jupyter writing down every
 * call it takes (keepCalls). It reads its host to have twelve cores, so that
 * a pool of four workers (a core each) and its class beside it fit a CI
 * runner of four.
 */
async function classMachine(): Promise<Agent> {
  if (shared) return shared
  const code = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, classes: true, namePrefix: 'vast', createdBy: 'colloq-host' }).code
  const agent = new Agent(fleet, `e-${randomBytes(2).toString('hex')}`, { join: home.joinTarget(code), classes: true, timings: FAST, keepCalls: true, cpus: 12 })
  agent.start()
  const runnerId = await until('the machine to join', () => agent.identity()?.runnerId, 30_000, () => agent.log())
  await until('its tunnel up at home', () => home.tunnels?.isUp(runnerId), 30_000, () => `${agent.log()}\n${home.tunnelLines.join('\n')}`)
  shared = agent
  return agent
}

/** The machine's name as the owner gave it: what staff read, and what the room's document must never say. */
const nameOf = (agent: Agent): string => getRunner(agent.runnerId)!.name

/** Until the form's live line says this machine takes the class (placement.ts · outlook): its image there, its facts heard, room for the slot. */
async function takes(agent: Agent, sessionId: string): Promise<void> {
  let last: unknown = null
  await until(`${agent.name} to take class ${sessionId}`, async () => {
    const outlook = await placementOutlook(sessionId)
    last = outlook
    return outlook.refusal === null && outlook.machines.find((one) => one.runnerId === agent.runnerId)?.refusal === null
  }, 30_000, () => `${JSON.stringify(last)}\n${agent.log()}\n${home.classLines.slice(-10).join('\n')}`)
}

/** A slot's class container on the machine, once it runs and its Jupyter listens. */
async function containerOf(agent: Agent, sessionId: string, role: 'room' | 'own' | 'council'): Promise<FakeClassContainer> {
  return until(`the ${role} container of ${sessionId} on ${agent.name}`, () => {
    const found = agent.classContainer(sessionId, role)
    return found?.status === 'running' && found.port !== null ? found : null
  }, 30_000, () => agent.log())
}

/** A pool worker's session path in the council container (kernel/index.ts · councilWorkerRoot): what home opens it at. */
const workerPath = (sessionId: string, n: number): string => jupyterSessionPath(sessionId, councilWorkerRoot(CELLS_KEY, n))

/** The workers' kernels in the council container, by their number: up, of this class's notebook. */
async function workersIn(door: FakeJupyterDoor, sessionId: string): Promise<Map<number, { id: string; busy: boolean; guarded: boolean }>> {
  const kernels = await door.kernels()
  const out = new Map<number, { id: string; busy: boolean; guarded: boolean }>()
  for (let n = 1; n <= 32; n++) {
    const found = kernels.find((kernel) => kernel.alive && kernel.path === workerPath(sessionId, n))
    if (found) out.set(n, { id: found.id, busy: found.busy, guarded: found.guarded })
  }
  return out
}

/** Every DELETE a container's Jupyter was ever sent, in every life of it (keepCalls). */
function deletesTo(agent: Agent, container: FakeClassContainer): number {
  return agent.jupyterCalls(container.id).filter((one) => one.kind === 'http' && one.method === 'DELETE').length
}

/** The requests a container's Jupyter took of one kind (HTTP by method and path). */
function httpTo(agent: Agent, container: FakeClassContainer, method: string, pattern: RegExp): number {
  return agent.jupyterCalls(container.id).filter((one) => one.kind === 'http' && one.method === method && pattern.test(String(one.path))).length
}

/** The newest epoch of the class notebook in the registry. */
function newestEpoch(sessionId: string): Epoch {
  const epoch = epochsOf(sessionId, CELLS_KEY)[0]
  assert.ok(epoch, `class ${sessionId} has no epoch`)
  return epoch
}

/** «14:05»: when an epoch was taken, as the room's clock says it (council-pool.ts · clockTime). */
function clockTime(at: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: instanceTimeZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
}

/** Let the event loop turn: what would happen at once, has. */
async function turns(count = 20): Promise<void> {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve))
}

/** What home's own fake Jupyter was asked to run (its `requests`), and the calls it took (its `calls`): the fake is plain JavaScript. */
interface Asked {
  code: string
  store_history?: boolean
  silent?: boolean
  kernel?: string
}
interface Called {
  kind: string
  method?: string
  path?: string
}

/** The class's council folder on the machine (runner-agent/council.ts · councilDir): its epochs and its scratch space. */
const councilFolder = (agent: Agent, sessionId: string): string => path.join(agent.root, 'council', sessionId)

/* --------------------------------------------------------------- scenarios */

test('E25 · open → epoch → 12 attempts on 4 workers at once; ✓/✗; show; adopt-and-run in the main kernel', { timeout: 60_000 }, async () => {
  const machine = await classMachine()
  const teacher = staff()
  // «Всё на машине»: the class notebook's kernel and the council's pool on the one machine, four workers of 512 MB.
  const id = await makeClass(teacher, 'E25 · всё на машине', { room: 'machines', own: 'machines', council: 'machines', workers: 4, attemptMb: 512 })
  await takes(machine, id)
  const lead = await tab(id, 'Преподавательница', teacher)
  const roomBox = await containerOf(machine, id, 'room')
  const roomDoor = machine.jupyterOf(roomBox)
  const setup = lead.notebook.add('x = 41\nprint(x)')
  lead.control.send({ t: 'run', cellId: setup })
  assert.deepEqual(await lead.notebook.settled(setup), { state: 'ok', text: '41\n', errors: [] })

  // Its state holds a numeric block big enough to travel out of band, a file of its own beside the stream (§9.3).
  await roomDoor.knobs({ council: { buffers: [300_000] } })
  // The council opens: the class's council container comes up beside the room's, its four workers start, and the epoch is taken
  // from the class notebook's kernel there — between the teacher's cells, a service run of its own queue.
  const council = lead.notebook.add('# ваше решение')
  openCouncil(lead, council)
  const ready = await poolReady(lead, council, 4)
  assert.equal(ready.machine, nameOf(machine), 'staff read the pool\'s machine by its name')
  assert.ok(ready.epoch !== null && ready.epoch.seq === 1 && ready.epoch.behind === 0 && ready.epoch.carried >= 1, JSON.stringify(ready.epoch))
  assert.deepEqual(ready.epoch.left, [])
  const box = await containerOf(machine, id, 'council')
  const door = machine.jupyterOf(box)
  // Its container: the class folder read-only, the epochs read-only, the attempts' scratch space its own, the workers' gate and
  // the config that loads it read-only (§9.6); a core a worker, and for each its 512 MB, what it holds before an attempt and the
  // epoch's stream it unpickled; the epoch's files once and 512 MB beside them (§9.5); no card.
  const mounts = Object.fromEntries(box.mounts.map((mount) => [mount.target, mount.readOnly]))
  assert.deepEqual(mounts, {
    [`/workspace/${id}`]: true, '/colloq/epochs': true, '/colloq/scratch': false, '/colloq/gate': true, '/etc/ipython/ipython_kernel_config.py': true,
  })
  const epoch = newestEpoch(id)
  const buffersMb = Math.ceil(epoch.bytes / (1024 * 1024))
  const streamMb = Math.ceil((epoch.files!.buffers.find((file) => file.sha256 === epoch.files!.body)?.bytes ?? 0) / (1024 * 1024))
  assert.equal(box.cpus, 4)
  // Placed before the export was, the container is asked for the epoch's part once the epoch is on the machine: by docker update.
  const sized = 4 * (512 + COUNCIL_WORKER_BASE_MB + streamMb) + buffersMb + 512
  await until('the council container sized for its epoch', () => machine.classContainer(id, 'council')?.memoryMb === sized, 20_000, () => `${machine.classContainer(id, 'council')?.memoryMb} MB, not ${sized}`)
  assert.equal(livePlacement(id, 'council')!.memoryMb, sized, 'as its placement says')
  assert.equal(machine.classContainer(id, 'council')!.id, box.id, 'grown live, never made anew')
  assert.equal(livePlacement(id, 'council')!.workers, 4)
  assert.equal((box as FakeClassContainer & { gpus?: string | null }).gpus ?? null, null, 'no card')
  const room = livePlacement(id, 'room')!
  assert.deepEqual([epoch.seq, epoch.trouble, epoch.source], [1, null, { runnerId: machine.runnerId, role: 'room', container: roomBox.id, gen: room.gen }])
  assert.equal((await roomDoor.council()).runs.export, 1, 'one export, in the class notebook\'s kernel on the machine')
  const workers = await workersIn(door, id)
  assert.deepEqual([...workers.keys()], [1, 2, 3, 4], 'four workers, each a session of the council container')
  assert.ok([...workers.values()].every((worker) => worker.guarded), 'each with the guard in')
  assert.equal((await door.council()).runs.load, 4, 'each loaded the epoch once')
  // The epoch never crossed the relay: the agent copied the export out of the room container beside the pool (docker cp), took
  // each file by its content, linked it into the class's epochs folder, and removed the export's folder from the container.
  const files = epochFileList(epoch.files).map((file) => file.sha256)
  assert.equal(files.length, 3, 'its manifest, its stream and the buffer')
  assert.ok(epochFileList(epoch.files).some((file) => file.bytes === 300_000), 'the buffer, out of band')
  const relayed = home.requestsOf(machine.runnerId).filter((one) => files.some((sha) => one.path.includes(sha)))
  assert.deepEqual(relayed, [], 'no file of the epoch went over the relay, either way')
  for (const sha of files) assert.ok(fs.existsSync(path.join(councilFolder(machine, id), 'epochs', sha)), `${sha.slice(0, 12)} in the class's epochs folder`)
  assert.ok(machine.dockerCalls().some((one) => one.args[0] === 'cp' && one.args[1] === `${roomBox.id}:/tmp/colloq-epoch/1`), 'docker cp of the export')
  await until('the export\'s folder gone from the room container', () => !fs.existsSync(path.join(machine.dockerState, 'containers', `${encodeURIComponent(roomBox.name)}.fs`, 'tmp', 'colloq-epoch', '1')), 10_000, () => machine.log())

  // Twelve students press at once: four attempts compute side by side, one on each worker; eight wait in the pool's queue, and
  // the notebook's own queue never holds one.
  const students = await Promise.all(Array.from({ length: 12 }, (_, i) => student(id, `Студент ${i + 1}`)))
  const texts = students.map((_, i) => `HOLD e25\nprint(x + ${i})`)
  students.forEach((one, i) => attempt(one, council, texts[i]!))
  await until('four attempts holding on the workers', async () => (await door.holds()).holding.e25 === 4, 20_000, () => JSON.stringify(kernelOf(lead, council)))
  const waiting = await until('eight attempts waiting in the pool, numbered', () => {
    const queued = students.filter((one) => cardOf(one, council)?.run?.state === 'queued')
    const places = queued.map((one) => one.control.frames('council:queue', council).at(-1)?.at ?? null)
    return queued.length === 8 && places.every((at) => at !== null) ? places : null
  }, 20_000, () => JSON.stringify(students.map((one) => [cardOf(one, council)?.run?.state, one.control.frames('council:queue', council).at(-1)?.at])))
  assert.deepEqual([...waiting].sort((a, b) => a! - b!), [1, 2, 3, 4, 5, 6, 7, 8], 'their places among the pool\'s waiting attempts alone')
  const busy = await until('the console to see the pool busy', () => {
    const kernel = kernelOf(lead, council)
    return kernel?.pool?.busy === 4 && kernel.pool.queued === 8 ? kernel : null
  }, 10_000, () => JSON.stringify(kernelOf(lead, council)))
  assert.deepEqual([busy.busy, busy.queued], [null, 0], 'the notebook\'s kernel is free, its queue empty')
  assert.ok(!(await roomDoor.requests()).some((one) => one.code.includes('HOLD e25')), 'no attempt reached the class notebook\'s kernel')

  // Three rounds of four.
  for (let round = 1; round <= 3; round++) {
    await until(`round ${round}: four holding`, async () => (await door.holds()).holding.e25 === 4, 20_000, () => JSON.stringify(students.map((one) => cardOf(one, council)?.run?.state)))
    assert.equal(await door.release('e25'), 4)
  }
  for (const [i, one] of students.entries()) {
    const run = await ended(one, council)
    assert.deepEqual([run.state, printed(run).text, run.placed, run.epoch?.seq, run.epoch?.behind, run.note, run.files], ['ok', `${41 + i}\n`, 'pool', 1, 0, undefined, undefined], `${one.name}'s card`)
    // Every frame of it said the pool, and none said the shared kernel.
    assert.ok(runsOf(one, council).every((frame) => frame.placed === 'pool'), JSON.stringify(runsOf(one, council).map((frame) => frame.placed)))
  }
  assert.equal((await door.holds()).peak.e25, 4, 'never more than four at once')
  const ran = (await door.requests()).filter((one) => texts.includes(one.code))
  assert.equal(ran.length, 12, 'each attempt computed once, on a worker')
  assert.ok(ran.every((one) => one.store_history === false), 'none into the kernels\' history')
  assert.equal((await door.council()).runs.enter, 12)
  // The road of one trip (§9.6): every worker's seed said it was born gated (the agent mounted the gate), each attempt carried
  // its run id for the gate and stop_on_error off for the exit behind it, and none was refused. That the three went back to
  // back, before any reply, is counted where a worker's entry can be held (council-pool · «one trip»).
  assert.ok(poolForTest(id, CELLS_KEY)!.workers.every((worker) => worker.gated), JSON.stringify(poolForTest(id, CELLS_KEY)))
  const calls = await door.calls()
  const asked = calls.filter((one) => one.kind === 'shell' && one.msgType === 'execute_request' && one.silent === false)
  assert.deepEqual(asked.map((one) => one.run).sort(), students.map((one) => cardOf(one, council)!.run!.runId).sort())
  assert.ok(asked.every((one) => one.stopOnError === false), JSON.stringify(asked))
  assert.equal(calls.filter((one) => one.kind === 'gate').length, 0, 'the gate refused an attempt whose entry held')
  // And each entry went lean (§9.6, 0.26.1): its worker's load had put the guard and the module in its process, so the entry
  // checked them rather than carried them, a kilobyte where it was 112, and none found them missing.
  const entries = (await door.requests()).filter((one) => one.code.includes('.enter(globals()'))
  assert.equal(entries.length, 12)
  assert.ok(entries.every((one) => !one.code.includes('exec(compile(') && Buffer.byteLength(one.code) < 4096), JSON.stringify(entries.map((one) => Buffer.byteLength(one.code))))
  assert.equal(calls.filter((one) => one.kind === 'lean-refused').length, 0)

  // ✓ and ✗ from the console: each author's card says so.
  lead.control.send({ t: 'council:mark', cellId: council, participantId: students[0]!.id, correct: true })
  lead.control.send({ t: 'council:mark', cellId: council, participantId: students[1]!.id, correct: false })
  await until('the marks on the authors\' cards', () => cardOf(students[0]!, council)?.correct === true && cardOf(students[1]!, council)?.correct === false)

  // Show: the room sees the third student's attempt, signed.
  const shownTo = students[5]!
  lead.control.send({ t: 'council:show', cellId: council, participantId: students[2]!.id })
  const shown = await shownTo.control.frame('the room to see the shown attempt', (frame) => frame.t === 'council:shown' && frame.cellId === council && frame.shown ? frame.shown : null)
  assert.deepEqual([shown.participantId, shown.text], [students[2]!.id, texts[2]])

  // Adopt and run: its text becomes the cell's, and the cell runs in the class notebook's kernel on the machine — on its live
  // state, never on a worker.
  const adoptsFrom = lead.control.heard.length
  lead.control.send({ t: 'council:adopt', cellId: council, participantId: students[2]!.id, run: true })
  const adopted = await lead.control.frame('the adoption', (frame) => frame.t === 'council:adopted' && frame.cellId === council ? frame : null, adoptsFrom)
  assert.deepEqual([adopted.participantId, adopted.run, adopted.warning], [students[2]!.id, true, undefined], 'no warning: the epoch was the kernel\'s state')
  assert.equal(lead.notebook.source(council), texts[2])
  await until('the adopted cell holding in the class notebook\'s kernel', async () => (await roomDoor.holds()).holding.e25 === 1)
  assert.equal(await roomDoor.release('e25'), 1)
  assert.deepEqual(await lead.notebook.settled(council), { state: 'ok', text: '43\n', errors: [] })
  const asCell = (await roomDoor.requests()).filter((one) => one.code === texts[2])
  assert.deepEqual(asCell.map((one) => one.store_history), [true], 'run once in the class notebook\'s kernel, as a cell')
  assert.equal((await door.requests()).filter((one) => one.code === texts[2]).length, 1, 'the workers ran it once, as the attempt')

  // Nothing was ended under anyone, and the room's document never names the machine.
  assert.deepEqual([deletesTo(machine, roomBox), deletesTo(machine, box)], [0, 0])
  assert.ok(!JSON.stringify(lead.notebook.doc.toJSON()).includes(nameOf(machine)), 'the room\'s document never names the machine')
  for (const one of students) one.control.close()
  lead.notebook.close()
  lead.control.close()
})

test('E26 · a teacher cell after the epoch: the next attempt waits for the refreeze and runs on the new epoch; with an export slower than 5 s it runs on the old one, «без ячеек N»', { timeout: 60_000 }, async () => {
  const machine = await classMachine()
  const here = await home.homeJupyter()
  const teacher = staff()
  // The lecture here, its council's pool on the machine (vsos's tile, «Консилиум и личные тетради», with the notebooks here).
  const id = await makeClass(teacher, 'E26 · тетрадь здесь', { room: 'home', own: 'home', council: 'machines', workers: 2, attemptMb: 512 })
  await takes(machine, id)
  // A numeric block the teacher's cells never change: the same buffer in every refreeze (§9.3).
  here.council.buffers = [150_000]
  try {
    const lead = await tab(id, 'Преподавательница', teacher)
    const first = lead.notebook.add('x = 1')
    lead.control.send({ t: 'run', cellId: first })
    assert.equal((await lead.notebook.settled(first)).state, 'ok')
    const council = lead.notebook.add('')
    openCouncil(lead, council)
    await poolReady(lead, council, 2)
    // The epoch was taken here: its files came out of the kernel's folder into this server's store, and the machine fetched each
    // from here by its hash, as the reply named them (§9.2 «Main kernel at home»).
    const one = newestEpoch(id)
    assert.deepEqual([one.seq, one.source, one.trouble], [1, 'home', null])
    for (const file of epochFileList(one.files)) {
      assert.ok(home.requestsOf(machine.runnerId).some((call) => call.method === 'GET' && call.path === `${REMOTE_API_BASE}/blobs/${file.sha256}` && call.status === 200), `${file.sha256.slice(0, 12)} fetched from here`)
    }
    const door = machine.jupyterOf(await containerOf(machine, id, 'council'))
    const a = await student(id, 'Студентка A')
    attempt(a, council, 'print(x)')
    const onOne = await ended(a, council)
    assert.deepEqual([onOne.state, printed(onOne).text, onOne.placed, onOne.epoch?.seq, onOne.epoch?.behind, onOne.note], ['ok', '1\n', 'pool', 1, 0, undefined])

    // The teacher runs a cell after the epoch: the next attempt waits for a refreeze, which is held here so that it is seen to wait.
    const second = lead.notebook.add('x = 2')
    lead.control.send({ t: 'run', cellId: second })
    assert.equal((await lead.notebook.settled(second)).state, 'ok')
    here.holdSilent = [{ match: '"/tmp/colloq-epoch/2"', name: 'e26b' }]
    const b = await student(id, 'Студент B')
    attempt(b, council, 'print(x)')
    await until('the refreeze held in the notebook\'s kernel', () => here.holding('e26b') === 1)
    await until('the console to see the refreeze', () => kernelOf(lead, council)?.pool?.refreezing === true)
    assert.deepEqual(runsOf(b, council).map((run) => [run.state, run.placed]), [['queued', 'pool']], 'it waits in the pool, run on nothing yet')
    assert.equal((await door.council()).runs.enter, 1, 'no worker took it meanwhile')
    here.holdSilent = []
    assert.equal(here.release('e26b'), 1)
    const onTwo = await ended(b, council)
    assert.deepEqual([onTwo.state, printed(onTwo).text, onTwo.placed, onTwo.epoch?.seq, onTwo.epoch?.behind, onTwo.note], ['ok', '2\n', 'pool', 2, 0, undefined], 'on the new epoch')
    assert.equal(here.councilRuns.export, 2)

    // Another cell, and this time the export takes longer than the wait: five seconds of the pool's clock, and the attempt runs on
    // the epoch the machine holds, its card saying which cell it lacks.
    const third = lead.notebook.add('x = 3')
    lead.control.send({ t: 'run', cellId: third })
    assert.equal((await lead.notebook.settled(third)).state, 'ok')
    here.holdSilent = [{ match: '"/tmp/colloq-epoch/3"', name: 'e26c' }]
    const c = await student(id, 'Студентка C')
    attempt(c, council, 'print(x)')
    await until('the slow refreeze held in the notebook\'s kernel', () => here.holding('e26c') === 1)
    assert.deepEqual(runsOf(c, council).map((run) => run.state), ['queued'])
    poolClock.advance(COUNCIL_EPOCH_WAIT_MS - 1)
    await turns()
    assert.deepEqual(runsOf(c, council).map((run) => run.state), ['queued'], 'still waiting a moment before the five seconds are up')
    poolClock.advance(1)
    const old = await ended(c, council)
    const two = epochsOf(id, CELLS_KEY).find((epoch) => epoch.seq === 2)!
    const lacks = tr('server.stateAsOfWithoutCell.30d8e4', { time: clockTime(two.at), cells: String(lead.notebook.number(third)) })
    assert.deepEqual([old.state, printed(old).text, old.placed, old.epoch?.seq, old.epoch?.behind, old.note], ['ok', '2\n', 'pool', 2, 1, lacks])
    // The export ends after all: the pool's next attempts run on it.
    here.holdSilent = []
    assert.equal(here.release('e26c'), 1)
    await until('the third epoch on the machine', () => kernelOf(lead, council)?.pool?.epoch?.seq === 3 && kernelOf(lead, council)?.pool?.epoch?.behind === 0, 20_000, () => JSON.stringify(kernelOf(lead, council)))
    attempt(a, council, 'print(x + 10)')
    await until('A\'s second run to end', () => runsOf(a, council).filter((run) => run.state === 'ok').length === 2)
    const onThree = cardOf(a, council)!.run!
    assert.deepEqual([printed(onThree).text, onThree.epoch?.seq, onThree.note], ['13\n', 3, undefined])
    assert.equal(here.councilRuns.export, 3, 'one export a refreeze: none taken twice')
    // The buffer kept its sha in every epoch: home stored it once, and the machine fetched it once — each refreeze shipped only its
    // manifest and stream.
    const buffer = epochFileList(one.files).find((file) => file.bytes === 150_000)!
    assert.ok(buffer, 'the buffer travelled out of band')
    const three = newestEpoch(id)
    assert.equal(three.seq, 3)
    assert.ok(epochFileList(three.files).some((file) => file.sha256 === buffer.sha256), 'the same buffer in the third epoch')
    const fetched = (sha: string): number => home.requestsOf(machine.runnerId).filter((call) => call.method === 'GET' && call.path === `${REMOTE_API_BASE}/blobs/${sha}`).length
    assert.equal(fetched(buffer.sha256), 1, 'the unchanged buffer crossed the relay once')
    for (const file of epochFileList(three.files)) if (file.sha256 !== buffer.sha256) assert.equal(fetched(file.sha256), 1, `${file.sha256.slice(0, 12)} of the third epoch fetched once`)
    assert.equal(deletesTo(machine, machine.classContainer(id, 'council')!), 0)
    for (const one of [a, b, c]) one.control.close()
    lead.notebook.close()
    lead.control.close()
  } finally {
    here.council.buffers = []
    here.holdSilent = []
  }
})

test('E27 · an attempt reading a left name is refused by the worker\'s entry and runs in the shared kernel, keeping its place', { timeout: 60_000 }, async () => {
  const machine = await classMachine()
  const here = await home.homeJupyter()
  const teacher = staff()
  const id = await makeClass(teacher, 'E27 · соединение с базой', { room: 'home', own: 'home', council: 'machines', workers: 2, attemptMb: 512 })
  await takes(machine, id)
  const lead = await tab(id, 'Преподавательница', teacher)
  const setup = lead.notebook.add('conn = "база"\nx = 5')
  lead.control.send({ t: 'run', cellId: setup })
  assert.equal((await lead.notebook.settled(setup)).state, 'ok')
  // The notebook's state holds a database connection, which no export can carry (§9.4): the hidden module leaves it behind.
  here.council.left = [{ name: 'conn', why: 'connection' }]
  try {
    // «По кнопке»: the epoch stays while the teacher computes (§9.2), so no attempt here waits for a refreeze behind the long cell.
    const council = lead.notebook.add('')
    openCouncil(lead, council, { refresh: 'manual' })
    const ready = await poolReady(lead, council, 2)
    // The console names what did not travel, once for the epoch: «Не переносится: conn (соединение с базой)».
    assert.deepEqual(ready.epoch?.left, [{ name: 'conn', why: councilLeftWords('connection') }])
    const box = await containerOf(machine, id, 'council')
    const door = machine.jupyterOf(box)
    const main = here.kernelAt(jupyterSessionPath(id, CELLS_KEY))!
    // The teacher's long cell holds the notebook's kernel.
    const long = lead.notebook.add('HOLD e27')
    lead.control.send({ t: 'run', cellId: long })
    await until('the teacher\'s cell holding', () => here.holding('e27') === 1)
    // An attempt that reads the connection: the pool takes it, and its worker's entry is held so that the teacher presses a cell
    // after it, which waits behind the long one.
    await door.knobs({ holdSilent: [{ match: '\'runId\': "', name: 'e27in' }] })
    const reader = await student(id, 'Студентка с базой')
    attempt(reader, council, 'print(conn)')
    await until('its entry held on a worker', async () => (await door.holds()).holding.e27in === 1)
    const later = lead.notebook.add('print("после")')
    lead.control.send({ t: 'run', cellId: later })
    await until('the later cell queued', () => lead.notebook.state(later) === 'queued')
    await door.knobs({ holdSilent: [] })
    assert.equal(await door.release('e27in'), 1)
    // The entry refused it (`_colloq_needs`): it goes to the notebook's kernel, its card saying why, never having ended.
    const words = tr('server.runInTheSharedKernelItUses.eaf141', { name: 'conn' })
    const handed = await until('it handed to the notebook\'s kernel', () => runsOf(reader, council).find((run) => run.placed === 'shared'))
    assert.deepEqual([handed.state, handed.note], ['queued', words])
    assert.ok(runsOf(reader, council).every((run) => run.state === 'queued' || run.state === 'running'), 'no end before it ran there')
    assert.equal(here.release('e27'), 1)
    const run = await ended(reader, council)
    assert.deepEqual([run.state, printed(run).text, run.placed, run.note], ['ok', 'база\n', 'shared', words])
    assert.deepEqual(await lead.notebook.settled(later), { state: 'ok', text: 'после\n', errors: [] })
    // Keeping its place: it was pressed before the later cell and handed on after it was queued, and it ran first.
    const order = here.requests.filter((one: Asked) => one.kernel === main && (one.code === 'print(conn)' || one.code === 'print("после")')).map((one: Asked) => one.code)
    assert.deepEqual(order, ['print(conn)', 'print("после")'])
    // The worker never computed its text: its entry refused it, and the worker's gate held back the attempt sent right behind
    // that entry (§9.6), unrun.
    assert.deepEqual((await door.calls()).filter((one) => one.kind === 'gate').length, 1, 'the worker computed it')
    // An attempt that reads only what travelled runs on a worker, on the epoch as it was, its card naming the two cells it lacks.
    const other = await student(id, 'Студент без базы')
    attempt(other, council, 'print(x)')
    const fine = await ended(other, council)
    const lacks = tr('server.stateAsOfWithoutCells.44aa0a', { time: clockTime(newestEpoch(id).at), cells: `${lead.notebook.number(long)}–${lead.notebook.number(later)}` })
    assert.deepEqual([fine.state, printed(fine).text, fine.placed, fine.epoch?.seq, fine.epoch?.behind, fine.note], ['ok', '5\n', 'pool', 1, 2, lacks])
    // Put in the cell, it says what the notebook's kernel did since that epoch: its result there may differ (§9.8).
    lead.control.send({ t: 'council:show', cellId: council, participantId: other.id })
    await other.control.frame('the room to see it shown', (frame) => frame.t === 'council:shown' && frame.cellId === council && frame.shown?.participantId === other.id)
    const adoptsFrom = lead.control.heard.length
    lead.control.send({ t: 'council:adopt', cellId: council, participantId: other.id, run: false })
    const adopted = await lead.control.frame('the adoption', (frame) => frame.t === 'council:adopted' && frame.cellId === council ? frame : null, adoptsFrom)
    assert.equal(adopted.warning, tr('server.theKernelHasRunCellsSinceThe.e29733', { count: 2 }))
    assert.equal(lead.notebook.source(council), 'print(x)')
    assert.equal(deletesTo(machine, box), 0)
    for (const one of [reader, other]) one.control.close()
    lead.notebook.close()
    lead.control.close()
  } finally {
    here.council.left = []
  }
})

test('E28 · a stuck attempt: the second SIGINT, the worker recycles, and the main kernel\'s queue never moves', { timeout: 60_000 }, async () => {
  const machine = await classMachine()
  const here = await home.homeJupyter()
  const teacher = staff()
  const id = await makeClass(teacher, 'E28 · попытка застряла', { room: 'home', own: 'home', council: 'machines', workers: 2, attemptMb: 512 })
  await takes(machine, id)
  const lead = await tab(id, 'Преподавательница', teacher)
  const setup = lead.notebook.add('x = 5')
  lead.control.send({ t: 'run', cellId: setup })
  assert.equal((await lead.notebook.settled(setup)).state, 'ok')
  const main = here.kernelAt(jupyterSessionPath(id, CELLS_KEY))!
  // The run limit's «seconds» are 20 ms each here: the second SIGINT five of them after the first, the deafness found five after.
  setCouncilLimitTick(20)
  try {
    const council = lead.notebook.add('')
    openCouncil(lead, council)
    await poolReady(lead, council, 2)
    const box = await containerOf(machine, id, 'council')
    const door = machine.jupyterOf(box)
    const loads = (await door.council()).runs.load
    // Python deep in C: deaf to every SIGINT. No limit yet: it computes on its worker, and on.
    const looping = await student(id, 'Студент в цикле')
    attempt(looping, council, 'DEAF e28')
    const worker = await until('the attempt deaf on a worker', async () => [...(await workersIn(door, id)).values()].find((one) => one.busy) ?? null)
    // The notebook's kernel is free meanwhile: the teacher's cell runs at once.
    const meanwhile = lead.notebook.add('print(x)')
    lead.control.send({ t: 'run', cellId: meanwhile })
    assert.deepEqual(await lead.notebook.settled(meanwhile), { state: 'ok', text: '5\n', errors: [] })
    assert.equal(cardOf(looping, council)?.run?.state, 'running', 'the attempt still computes on its worker')
    // The teacher sets a limit of five: it applies to the attempt computing now, counted from its start (retimeCouncilRun), on its
    // worker — which takes the second SIGINT and no third, and is recycled: restarted with its session kept, and loaded again.
    lead.control.send({ t: 'cell:lock', cellId: council, state: 'council', settings: { ...RULES, runLimitSec: 5 } })
    const run = await ended(looping, council)
    assert.deepEqual([run.state, run.timedOut, run.placed], ['error', 5, 'pool'], 'stopped by the limit, on its worker')
    await until('the worker recycled and loaded again', async () => httpTo(machine, box, 'POST', new RegExp(`^/api/kernels/${worker.id}/restart$`)) === 1 && (await door.council()).runs.load === loads + 1, 20_000, () => JSON.stringify(machine.jupyterCalls(box.id).filter((one) => one.kind === 'http').slice(-8)))
    assert.equal(httpTo(machine, box, 'POST', new RegExp(`^/api/kernels/${worker.id}/interrupt$`)), 2, 'the second SIGINT, and no third')
    assert.equal(httpTo(machine, box, 'POST', /\/restart$/), 1, 'that worker alone')
    assert.equal((await door.holds()).holding.e28 ?? 0, 0, 'its Python went with the recycle')
    // The notebook's kernel was never signalled nor restarted, never computed the attempt, and its queue never held it.
    assert.deepEqual(here.calls.filter((one: Called) => one.kind === 'http' && one.method === 'POST' && (one.path === `/api/kernels/${main}/interrupt` || one.path === `/api/kernels/${main}/restart`)), [])
    assert.ok(!here.requests.some((one: Asked) => one.kernel === main && one.code === 'DEAF e28'))
    assert.ok(lead.control.frames('council:kernel', council).every((frame) => frame.kernel.busy?.kind !== 'attempt'), 'the console never saw the attempt in the notebook\'s kernel')
    assert.ok(runsOf(looping, council).every((one) => one.placed === 'pool'), 'never handed to the shared kernel')
    assert.ok(!lead.notebook.notes().includes(tr('server.kernel.deafToInterrupt')), 'the room hears nothing of a worker\'s deafness')
    // The recycled pool serves on, under the new limit.
    const next = await student(id, 'Студентка после')
    attempt(next, council, 'print(x)')
    const fine = await ended(next, council)
    assert.deepEqual([fine.state, printed(fine).text, fine.placed, fine.timedOut], ['ok', '5\n', 'pool', undefined])
    assert.equal(deletesTo(machine, box), 0)
    for (const one of [looping, next]) one.control.close()
    lead.notebook.close()
    lead.control.close()
  } finally {
    setCouncilLimitTick(1000)
  }
})

test('E30 · an attempt writes out.csv into its scratch folder: listed on the card; the class folder untouched', { timeout: 60_000 }, async () => {
  const machine = await classMachine()
  const teacher = staff()
  const id = await makeClass(teacher, 'E30 · файлы попытки', { room: 'home', own: 'home', council: 'machines', workers: 1, attemptMb: 512 })
  await takes(machine, id)
  // A class file saved here: the barrier brings it to the machine's copy before an attempt reads it (§8.2).
  const data = 'id,score\n1,0.5\n'
  assert.ok(writeText(id, 'data.csv', data))
  const lead = await tab(id, 'Преподавательница', teacher)
  const setup = lead.notebook.add('x = 5')
  lead.control.send({ t: 'run', cellId: setup })
  assert.equal((await lead.notebook.settled(setup)).state, 'ok')
  const council = lead.notebook.add('')
  openCouncil(lead, council)
  await poolReady(lead, council, 1)

  // The attempt reads the class's file where it works and writes its own beside it: into its own folder, /colloq/scratch/<run>.
  const writer = await student(id, 'Студентка с файлом')
  attempt(writer, council, 'READ data.csv\nWRITE out.csv id,pred\\n1,0.7\\n\nFILL big.bin 1100000\nprint("записано")')
  const run = await ended(writer, council)
  assert.deepEqual([run.state, printed(run).text, run.placed], ['ok', `${data}записано\n`, 'pool'])
  // Listed on the card as its worker's exit named them, then out.csv kept once the machine brought it here (§9.7), for the author
  // and on the teacher's pile; the one past a file's megabyte named with its size and left behind.
  const body = 'id,pred\n1,0.7\n'
  const kept = await until('the file kept on the author\'s card', () => {
    const files = cardOf(writer, council)?.run?.files
    return files?.length === 2 && files.find((file) => file.name === 'out.csv')?.kept ? files : null
  }, 20_000, () => `${JSON.stringify(runsOf(writer, council).map((one) => one.files))}\n${machine.log()}`)
  const sha = createHash('sha256').update(body).digest('hex')
  assert.deepEqual(kept, [{ name: 'big.bin', bytes: 1_100_000, kept: false }, { name: 'out.csv', bytes: Buffer.byteLength(body), kept: true, sha256: sha }])
  // Before it landed the card said it was on its way (null), never that it was not kept; the big one left behind from the end on.
  const first = runsOf(writer, council).find((one) => (one.files?.length ?? 0) > 0)
  assert.deepEqual(first?.files, [{ name: 'big.bin', bytes: 1_100_000, kept: false }, { name: 'out.csv', bytes: Buffer.byteLength(body), kept: null, sha256: sha }])
  const runId = cardOf(writer, council)!.run!.runId!
  assert.match(runId, /^[0-9a-f]{32}$/)
  assert.equal(fs.readFileSync(artifactPath(id, runId, sha), 'utf8'), body, 'here, by its content')
  await until('the file on the teacher\'s pile', () => lead.control.frames('council:patch', council).some((frame) => frame.attempts.some((one) => one.participantId === writer.id && one.run?.files?.some((file) => file.name === 'out.csv' && file.kept) === true)))
  // The class folder untouched, here and in the machine's copy; and the attempt's folder on the machine gone once its file came.
  assert.equal(fs.existsSync(path.join(sessionDir(id), 'out.csv')), false, 'no out.csv in the class folder here')
  assert.equal(fs.existsSync(path.join(machine.roomCopy(id), 'out.csv')), false, 'nor in the machine\'s copy of it')
  await until('the attempt\'s scratch folder gone', () => !fs.existsSync(path.join(councilFolder(machine, id), 'scratch', runId)), 20_000, () => machine.log())
  const collected = home.requestsOf(machine.runnerId).filter((one) => one.method === 'PUT' && one.path.startsWith(`${REMOTE_API_BASE}/council/${id}/runs/${runId}/files/`))
  assert.deepEqual(collected.map((one) => [one.path.split('/').pop(), one.status]), [['out.csv', 200]], 'one PUT of it, taken, and none of the big one')

  // An attempt that writes over a class file fails as a read-only file system does, and the file stays as it was everywhere.
  const spoiler = await student(id, 'Студент-вредитель')
  attempt(spoiler, council, 'WRITE data.csv испорчено')
  const refused = await ended(spoiler, council)
  assert.deepEqual([refused.state, printed(refused).errors, refused.placed, refused.files], ['error', ['OSError: [Errno 30] Read-only file system: \'data.csv\''], 'pool', undefined])
  assert.equal(fs.readFileSync(path.join(sessionDir(id), 'data.csv'), 'utf8'), data)
  assert.equal(fs.readFileSync(path.join(machine.roomCopy(id), 'data.csv'), 'utf8'), data)
  assert.equal(deletesTo(machine, machine.classContainer(id, 'council')!), 0)
  for (const one of [writer, spoiler]) one.control.close()
  lead.notebook.close()
  lead.control.close()
})

test('E31 · a home restart with attempts mid-run: ServerRestarted once; workers re-attached and recycled', { timeout: 90_000 }, async () => {
  const machine = await classMachine()
  const here = await home.homeJupyter()
  const teacher = staff()
  const id = await makeClass(teacher, 'E31 · сервер перезапустился', { room: 'home', own: 'home', council: 'machines', workers: 2, attemptMb: 512 })
  await takes(machine, id)
  const lead = await tab(id, 'Преподавательница', teacher)
  const setup = lead.notebook.add('x = 5')
  lead.control.send({ t: 'run', cellId: setup })
  assert.equal((await lead.notebook.settled(setup)).state, 'ok')
  const council = lead.notebook.add('')
  openCouncil(lead, council)
  await poolReady(lead, council, 2)
  const box = await containerOf(machine, id, 'council')
  const door = machine.jupyterOf(box)
  const workers = await workersIn(door, id)
  assert.equal(workers.size, 2)
  const gen = livePlacement(id, 'council')!.gen
  // Two attempts mid-run on the workers.
  const pupils = await Promise.all(['Студентка 1', 'Студент 2'].map((name) => student(id, name)))
  for (const one of pupils) attempt(one, council, 'HOLD e31\nprint(x)')
  await until('both attempts mid-run on the workers', async () => (await door.holds()).holding.e31 === 2)
  for (const one of pupils) assert.deepEqual([cardOf(one, council)?.run?.state, cardOf(one, council)?.run?.placed], ['running', 'pool'])
  const loads = (await door.council()).runs.load
  const restartsBefore = httpTo(machine, box, 'POST', /\/restart$/)

  // The home dies mid-attempt and starts again: its rooms' kernels and pools forgotten as a dead process forgets them (no word to
  // anyone, no DELETE), the council's attempts and the machines' word on the epochs with them; the database and the machine stay.
  abandonKernelsForTest()
  resetCouncilCache()
  resetEpochsForTest()
  await home.restart()
  await until('the machine back in the new life', () => home.tunnels?.isUp(machine.runnerId), 30_000, () => machine.log())

  // The students come back with their tabs: each card says the server restarted while the attempt ran, once.
  const back = await Promise.all(pupils.map(async (one) => ({ ...one, control: await Control.open(id, one.joined) })))
  for (const one of back) {
    const run = await ended(one, council)
    assert.equal(run.state, 'error')
    assert.deepEqual(printed(run).errors, [`ServerRestarted: ${tr('server.theServerRestartedWhileTheAttemptWas.0dc824')}`], `${one.name}'s card`)
  }
  // The teacher comes back: the console brings the open council's pool back (§9.10). Its workers are re-attached by their
  // sessions' paths — the same kernels — and recycled before they serve (their Python may hold anything of the dead life),
  // each restarted once and loaded again; the dead life's attempts went with their processes.
  const exports = here.councilRuns.export
  const again = await tab(id, 'Преподавательница', teacher)
  const revived = await poolReady(again, council, 2)
  assert.equal(livePlacement(id, 'council')!.gen, gen, 'the same council placement')
  // The epoch's row survived (§9.10): the new life's pool runs on it, as its machine still holds it, and nothing is exported anew.
  assert.equal(revived.epoch?.seq, 1)
  assert.equal(here.councilRuns.export, exports, 'no export in the new life')
  const after = await workersIn(door, id)
  assert.deepEqual([...after].map(([n, worker]) => [n, worker.id]), [...workers].map(([n, worker]) => [n, worker.id]), 're-attached: the same kernels')
  for (const [n, worker] of after) {
    assert.equal(httpTo(machine, box, 'POST', new RegExp(`^/api/kernels/${worker.id}/restart$`)), 1, `worker ${n} recycled once`)
  }
  assert.equal(httpTo(machine, box, 'POST', /\/restart$/) - restartsBefore, 2)
  await until('each loaded again', async () => (await door.council()).runs.load === loads + 2, 20_000, () => JSON.stringify(kernelOf(again, council)))
  assert.equal((await door.holds()).holding.e31 ?? 0, 0, 'the dead life\'s attempts went with their processes')
  // Nothing of them ran again, and nothing more was said of them: once.
  assert.equal((await door.requests()).filter((one) => one.code === 'HOLD e31\nprint(x)').length, 2)
  // A new attempt runs on a recycled worker.
  const fresh = await student(id, 'Студентка после')
  attempt(fresh, council, 'print(x)')
  const run = await ended(fresh, council)
  assert.deepEqual([run.state, printed(run).text, run.placed], ['ok', '5\n', 'pool'])
  for (const one of back) {
    const restarted = runsOf(one, council).filter((frame) => frame.outputs.some((output) => output.kind === 'error' && output.ename === 'ServerRestarted'))
    assert.ok(restarted.length >= 1 && restarted.every((frame) => frame.outputs.filter((output) => output.kind === 'error').length === 1), JSON.stringify(runsOf(one, council)))
    assert.equal(cardOf(one, council)?.run?.state, 'error', 'no later frame of the dead life\'s attempt')
  }
  assert.equal(deletesTo(machine, box), 0)
  for (const one of [...back, fresh]) one.control.close()
  for (const one of [lead, again]) {
    one.notebook.close()
    one.control.close()
  }
})

// Last: it takes the file's machine off classes.
test('E29 · the pool\'s machine lost mid-attempt: re-run once in the shared kernel, the pause not charged', { timeout: 60_000 }, async () => {
  const machine = await classMachine()
  const here = await home.homeJupyter()
  const teacher = staff()
  const id = await makeClass(teacher, 'E29 · машина пропала', { room: 'home', own: 'home', council: 'machines', workers: 1, attemptMb: 512 })
  await takes(machine, id)
  const lead = await tab(id, 'Преподавательница', teacher)
  const setup = lead.notebook.add('x = 5')
  lead.control.send({ t: 'run', cellId: setup })
  assert.equal((await lead.notebook.settled(setup)).state, 'ok')
  const main = here.kernelAt(jupyterSessionPath(id, CELLS_KEY))!
  const council = lead.notebook.add('')
  // A pause of thirty seconds between one's own runs.
  openCouncil(lead, council, { rerunPauseSec: 30 })
  await poolReady(lead, council, 1)
  const box = await containerOf(machine, id, 'council')
  const door = machine.jupyterOf(box)
  // One attempt mid-run on the one worker, another waiting for it in the pool.
  const lost = await student(id, 'Студентка на машине')
  attempt(lost, council, 'HOLD e29\nprint("ещё раз")')
  await until('the attempt mid-run on the worker', async () => (await door.holds()).holding.e29 === 1)
  const waiting = await student(id, 'Студент в очереди')
  attempt(waiting, council, 'print(x)')
  await until('the second waiting in the pool', () => cardOf(waiting, council)?.run?.state === 'queued' && waiting.control.frames('council:queue', council).at(-1)?.at === 1)

  // The owner takes classes off the machine («Не принимает занятия»): the council's placement there is lost at once, mid-attempt.
  assert.equal((await home.admin('PATCH', `/api/admin/runners/${machine.runnerId}`, { classes: false })).status, 200)
  assert.deepEqual([placementRow(id, 'council')!.state, placementRow(id, 'council')!.reason], ['lost', 'unclassed'])
  // The attempt runs once more in the notebook's kernel here, its card saying why; the lost run never ended, so no pause was
  // charged for it (§9.10, D15).
  const words = tr('server.theMachineWasLostInTheMiddle.b5f5c5')
  const handed = await until('the lost attempt handed to the notebook\'s kernel', () => runsOf(lost, council).find((run) => run.placed === 'shared'), 20_000, () => JSON.stringify(runsOf(lost, council).map((run) => [run.state, run.placed])))
  assert.deepEqual([handed.state, handed.note], ['queued', words])
  const before = runsOf(lost, council).slice(0, runsOf(lost, council).indexOf(handed))
  assert.ok(
    before.some((run) => run.state === 'running') && before.every((run) => run.placed === 'pool' && (run.state === 'queued' || run.state === 'running')),
    `it ran on the worker, and never ended there: ${JSON.stringify(before.map((run) => [run.state, run.placed]))}`,
  )
  await until('it computing in the notebook\'s kernel', () => here.holding('e29') === 1)
  // The one waiting goes there behind it, its card saying the pool's machine was lost.
  const behind = await until('the waiting one handed on', () => runsOf(waiting, council).find((run) => run.placed === 'shared'))
  assert.deepEqual([behind.state, behind.note], ['queued', tr('server.thePoolSMachineWasLostThe.8aff4c')])
  assert.equal(here.release('e29'), 1)
  const rerun = await ended(lost, council)
  assert.deepEqual([rerun.state, printed(rerun).text, rerun.placed, rerun.note], ['ok', 'ещё раз\n', 'shared', words])
  const next = await ended(waiting, council)
  assert.deepEqual([next.state, printed(next).text, next.placed], ['ok', '5\n', 'shared'])
  const order = here.requests.filter((one: Asked) => one.kernel === main && (one.code === 'HOLD e29\nprint("ещё раз")' || one.code === 'print(x)')).map((one: Asked) => one.code)
  assert.deepEqual(order, ['HOLD e29\nprint("ещё раз")', 'print(x)'], 'in the order pressed')
  // Run once more, not twice: one hand-over, one end.
  assert.equal(runsOf(lost, council).filter((run) => run.placed === 'shared' && run.state === 'queued').length, 1)
  assert.equal(runsOf(lost, council).filter((run) => run.state === 'ok' || run.state === 'error').length, 1)
  // The pause counts from the run that ended, the one here.
  const nextRunAt = cardOf(lost, council)?.nextRunAt ?? null
  assert.ok(nextRunAt !== null && nextRunAt >= rerun.startedAt + 30_000, `the next run at ${nextRunAt}, the rerun started at ${rerun.startedAt}`)
  // The machine lets the lost placement go: its council container removed, no DELETE ever sent to it.
  await until('the council container gone from the machine', () => machine.classContainer(id, 'council') === null, 30_000, () => machine.log())
  assert.equal(deletesTo(machine, box), 0)
  // Its worker started again as soon as its attempt was handed on, wherever the council is placed now: nowhere, no machine takes
  // classes. The next attempt runs in the notebook's kernel, its card saying the pool did not start (§9.9), never that it is
  // still starting — at once, not at the pool's next look (its clock stands still here).
  // In the placement's own words (§9.9): no machine takes the class's council now.
  const didNotStart = tr('server.thePoolDidNotStart.80644c', { why: tr('server.theCouncilPoolRunsOnlyOnMachines.ef5702') })
  await until('the console to say the pool did not start', () => kernelOf(lead, council)?.pool?.state === 'shared' && kernelOf(lead, council)?.pool?.note === didNotStart, 20_000, () => JSON.stringify(kernelOf(lead, council)))
  const later = await student(id, 'Студентка после')
  attempt(later, council, 'print(x + 1)')
  const shared = await ended(later, council)
  assert.deepEqual([shared.state, printed(shared).text, shared.placed], ['ok', '6\n', 'shared'])
  assert.equal(shared.note, didNotStart, 'its card says why')
  for (const one of [lost, waiting, later]) one.control.close()
  lead.notebook.close()
  lead.control.close()
})
