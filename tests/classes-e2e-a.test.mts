/**
 * Classes on machines («занятия на машинах») end to end, scenarios A:
 * placement and cells (docs/architecture/remote-classes.md §17.2 A.1–A.3), on
 * the harness of tests/classes-e2e.test.mts.
 *
 * EVERYTHING IS THE REAL THING BUT THE DAEMON AND THE PYTHON. Home is the app
 * of this process with its tunnel door (tests/_remote-e2e-home.mts), its own
 * Jupyter a fake in this process for what computes here; a machine is the
 * real agent as a process of its own (tests/_remote-e2e-agent.mts) on the fake
 * docker (tests/_remote-e2e-docker.mjs), whose class containers are fake
 * Jupyters of their own (tests/_fake-jupyter.mjs). A class is made, set to
 * machines and joined through the doors its people use — the owner's panel,
 * the room's join, a browser's notebook socket (/collab, Yjs) and control
 * socket (/control) — and what is asserted is what each of them sees there:
 * outputs and notes in the room's document, the frames of the control socket,
 * the owner's list of machines; besides them what the database holds and the
 * call log of each fake Jupyter (what reached the machine's, what reached
 * home's). Nothing here moves a clock or waits out a production timeout: every
 * wait is for an event (a sync, a frame, a container), and nothing in
 * scenarios A is lost, so no DELETE may reach a machine's Jupyter while one
 * runs.
 *
 * ONE MACHINE SERVES THE FILE. Each scenario makes classes of its own on it,
 * as one machine takes several classes in a day, and the owner stops their
 * kernels once it is over, which frees the machine's cores for the next; the
 * last (A.3) moves home to another build and back.
 *
 * FILES DO NOT TRAVEL YET (§8, wave 3): where a scenario needs a file in the
 * class folder on both sides (`file:run`), it lays it in both, as the barrier
 * push (§8.2) will.
 */
import './_remote-e2e-home.mts'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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
import type { RemoteMachinesResponse } from '../shared/remote-admin.js'
import {
  CELLS_KEY,
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
import { getRunner, mintRemoteCode, useHomeRunnerBuild } from '../server/src/competitions/remote/store.js'
import { jupyterSessionPath } from '../server/src/kernel/jupyter.js'
import { placementOutlook } from '../server/src/kernel/remote/placement.js'
import { livePlacement, placementRow } from '../server/src/kernel/remote/placement-store.js'
import { writeText } from '../server/src/workspace.js'
import { kernelLimits } from '../server/src/kernel/pool.js'
import { classHashSeed } from '../server/src/kernel/room-spec.js'
import { shutdownKernels } from '../server/src/kernel/index.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { Agent, createFleet, killAgents, removeClassContainers, type FakeClassContainer, type FakeJupyterDoor, type Fleet } from './_remote-e2e-agent.mts'
import { Home, kernelRevision, until } from './_remote-e2e-home.mts'

const home = new Home({ liveness: 'manual' })
let fleet: Fleet
/** Every socket a scenario opened: closed at the end of the file, whatever happened. */
const sockets = new Set<WebSocket>()

before(async () => {
  fleet = createFleet()
  await home.start()
  // What computes on this server: a class's room kept here, a slot no machine takes.
  await home.homeJupyter()
  // The class environment's image, in the fleet's registry and noted at home: what a class set to machines runs there.
  kernelRevision(fleet)
})

after(async () => {
  for (const ws of sockets) ws.terminate()
  // The kernels' clients and the rooms' documents of this process go first: no reconnect knocks on a machine that is gone.
  await shutdownKernels()
  shutdownCollab()
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
function staff(name = 'Преподавательница A'): Staff {
  const made = createTeacher({ name, email: `a.${Date.now()}.${randomBytes(3).toString('hex')}@example.edu`, role: 'owner' })!
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
 * environment, and its placement set in its «Ресурсы» (PATCH, the owner's
 * call): what a teacher does the evening before. A core and a gigabyte, so
 * that a CI runner's few cores hold a scenario's classes (machine.ts ·
 * freeCapacity offers the host's cores less one).
 */
async function makeClass(by: Staff, name: string, placement: Partial<ClassPlacement>, rules: Record<string, unknown> = {}): Promise<string> {
  const made = await call<{ id: string }>('POST', '/api/admin/seminars', { name, environment: 'base', rules, cpus: 1, memoryMb: 1024 }, by.cookie)
  assert.equal(made.status, 201, JSON.stringify(made.body))
  classes.push({ by, id: made.body.id })
  const set = await call('PATCH', `/api/admin/seminars/${made.body.id}`, { placement }, by.cookie)
  assert.equal(set.status, 200, JSON.stringify(set.body))
  return made.body.id
}

/**
 * The class is over: the owner stops its kernels («Остановить» in «Работают
 * сейчас», POST …/running/:id/stop), its slots on a machine stop there
 * (§6.10: the row `stopping` until the machine says the container is gone),
 * and the machine's cores are free for the next class.
 */
async function endClass(by: Staff, sessionId: string): Promise<void> {
  const stopped = await call<{ error?: string }>('POST', `/api/admin/resources/running/${sessionId}/stop`, { what: 'class', force: true }, by.cookie)
  // Nothing to stop is an ended class too (a slot that never started).
  assert.ok(stopped.status === 200 || stopped.status === 404, `${stopped.status} ${JSON.stringify(stopped.body)}`)
  await until(`class ${sessionId} off the machine`, () => livePlacement(sessionId, 'room') === null && livePlacement(sessionId, 'own') === null, 30_000, () => home.classLines.slice(-5).join('\n'))
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
      // Awareness (1) and anything else is not this test's business.
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

  /** Opened with the join's token (and a teacher's cookie), and synced: the room's notebook is in the document. */
  static async open(sessionId: string, joined: JoinResponse, by?: Staff): Promise<Notebook> {
    const notebook = new Notebook(`${home.url.replace('http:', 'ws:')}/collab/${sessionId}?token=${encodeURIComponent(joined.token)}`, by?.cookie)
    await until('the notebook to sync', () => notebook.doc.getArray(CELLS_KEY).length > 0)
    return notebook
  }

  /** A code cell typed at the end of a notebook (the room's by default): its id. */
  add(source: string, root = CELLS_KEY): string {
    const cell = createCell('code', source)
    bookCells(this.doc, root).push([cell])
    return cellId(cell)
  }

  /** A cell of this document by its id, in any notebook. */
  cell(id: string): YCell | null {
    for (const root of [CELLS_KEY, ...bookRoots(this.doc)]) {
      const found = bookCells(this.doc, root).toArray().find((cell) => cellId(cell) === id)
      if (found) return found
    }
    return null
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
    }, timeoutMs, () => JSON.stringify({ cell: this.cell(id) ? readCell(this.cell(id)!) : null, socket: this.ws.readyState, roots: [CELLS_KEY, ...bookRoots(this.doc)].map((root) => [root, bookCells(this.doc, root).toArray().map(cellId)]) }))
  }

  /** The room's notes: the system lines of the shared terminal, where the kernel's news is written. */
  notes(): string[] {
    return getTerminal(this.doc).toArray().map(readTerminalLine).filter((line) => line.kind === 'system').map((line) => line.text)
  }

  /** The shared terminal's lines, every kind; a command's while it runs. */
  terminal(): Array<{ kind: string; text: string; running: boolean }> {
    return getTerminal(this.doc).toArray().map(readTerminalLine).map((line) => ({ kind: line.kind, text: line.text, running: line.running }))
  }

  close(): void {
    this.ws.terminate()
  }
}

function bookRoots(doc: Y.Doc): string[] {
  return bookList(doc).map((book) => book.root).filter((root) => root !== CELLS_KEY)
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

  /** The first frame from `from` on that `pick` takes. */
  async frame<T>(what: string, pick: (frame: ControlServerMessage) => T | null | undefined | false, from = 0, timeoutMs = 20_000): Promise<T> {
    return until(what, () => {
      for (const frame of this.heard.slice(from)) {
        const picked = pick(frame)
        if (picked) return picked
      }
      return null
    }, timeoutMs, () => JSON.stringify(this.heard.slice(-8)))
  }

  close(): void {
    this.ws.terminate()
  }
}

/** A browser tab in a room, joined, with both of its sockets: a teacher's when `by` signs it in, a student's otherwise. */
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
 * The file's class machine: joined with a code minted «Принимает занятия»,
 * as the instance's console mints one (`colloq-host runner-code --classes
 * --prefix vast`), its agent running and its tunnel up at home: one a class
 * set to machines may be placed on once its facts and the class's image are
 * there (`takes`). Named by the code's prefix («vast-1»), never by its tree,
 * whose folders the fake's shell prints.
 */
async function classMachine(): Promise<Agent> {
  if (shared) return shared
  const code = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, classes: true, namePrefix: 'vast', createdBy: 'colloq-host' }).code
  const agent = new Agent(fleet, `a-${randomBytes(2).toString('hex')}`, { join: home.joinTarget(code), classes: true })
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
  }, 30_000, () => `${JSON.stringify(last)}\n${agent.log()}\n${home.classLines.slice(-10).join('\n')}`)
}

/** A slot's class container on the machine, once it runs and its Jupyter listens. */
async function containerOf(agent: Agent, sessionId: string, role: 'room' | 'own'): Promise<FakeClassContainer> {
  return until(`the ${role} container of ${sessionId} on ${agent.name}`, () => {
    const found = agent.classContainer(sessionId, role)
    return found?.status === 'running' && found.port !== null ? found : null
  }, 30_000, () => agent.log())
}

/** The kernel a fake Jupyter keeps for a notebook, by the session path home opens it at. */
async function kernelAt(door: FakeJupyterDoor, sessionId: string, root: string): Promise<{ id: string; guarded: boolean; busy: boolean; count: number } | null> {
  return (await door.kernels()).find((one) => one.path === jupyterSessionPath(sessionId, root) && one.alive) ?? null
}

/** Every DELETE a fake Jupyter was sent. */
async function deletes(door: FakeJupyterDoor): Promise<number> {
  return (await door.calls()).filter((call) => call.kind === 'http' && call.method === 'DELETE').length
}

/* --------------------------------------------------------------- scenarios */

test('A1 · warm start on join; Run → output in Yjs; completion, inspect and brief through the tunnel; interrupt, restart, input(), file:run, the terminal', { timeout: 90_000 }, async () => {
  const machine = await classMachine()
  const teacher = staff()
  const id = await makeClass(teacher, 'A1 · на машине', { room: 'machines' })
  await takes(machine, id)
  assert.equal(livePlacement(id, 'room'), null, 'nothing is placed before anyone comes')
  assert.equal(machine.classContainer(id, 'room'), null)

  // The teacher comes in: the join's warm-up brings the class notebook's kernel up on the machine, guarded, before any Run (§6.8).
  const teacherTab = await tab(id, 'Преподавательница', teacher)
  const container = await containerOf(machine, id, 'room')
  const door = machine.jupyterOf(container)
  const warm = await until('the class notebook\'s kernel on the machine, its guard in', async () => {
    const kernel = await kernelAt(door, id, CELLS_KEY)
    return kernel?.guarded ? kernel : null
  })
  assert.ok((await door.requests()).every((one) => one.silent === true), 'only the guard\'s service runs: no cell yet')
  const placed = placementRow(id, 'room')!
  assert.deepEqual([placed.state, placed.runnerId, placed.gen], ['ready', machine.runnerId, 1], 'the database holds the slot ready on the machine')
  const here = await home.homeJupyter()
  assert.equal(here.kernelAt(jupyterSessionPath(id, CELLS_KEY)) ?? null, null, 'nothing of the class computes on this server')

  // Staff are told where it computes, by the machine's name; a student is not.
  const machineName = nameOf(machine)
  const where = await teacherTab.control.frame('the staff frame naming the machine', (frame) => frame.t === 'kernel:machine' && frame.role === 'room' && frame.machine?.state === 'ready' ? frame : null)
  assert.equal(where.machine?.name, machineName)
  const student = await tab(id, 'Студент')

  // Run: computed on the machine, the output in the student's document, once (COUNT), and in the warm kernel: no session
  // opened for it, no channel dialled, just the cell's round trip.
  const opened = async (): Promise<number> => (await door.calls()).filter((one) => (one.kind === 'http' && one.method === 'POST' && one.path === '/api/sessions') || one.kind === 'channel').length
  const openedWarm = await opened()
  const first = teacherTab.notebook.add('x = 41\nprint("на машине", x)\nCOUNT')
  teacherTab.control.send({ t: 'run', cellId: first })
  const ran = await student.notebook.settled(first)
  assert.deepEqual(ran, { state: 'ok', text: 'на машине 41\n1\n', errors: [] })
  assert.equal(await opened(), openedWarm, 'the first Run found its kernel warm')
  assert.deepEqual((await door.calls()).filter((one) => one.kind === 'count').map((one) => [one.kernel, one.value]), [[warm.id, 1]], 'one execution, on the machine')
  assert.ok(!here.requests.some((one: { code: string }) => one.code.includes('на машине')), 'never here')
  const entry = bookKernel(student.notebook.doc, CELLS_KEY)
  assert.deepEqual([entry.where, entry.link, entry.status], ['machine', 'ok', 'idle'], 'the room reads «на машине», the link fine')

  // Completion, help and the brief of a value: answered by the machine's kernel, through the tunnel.
  const shellOf = async (type: string): Promise<number> => (await door.calls()).filter((one) => one.kind === 'shell' && one.msgType === type).length
  const completesBefore = await shellOf('complete_request')
  teacherTab.control.send({ t: 'complete', id: 1, code: 'df.', cursor: 3, cellId: first })
  const completed = await teacherTab.control.frame('the completion', (frame) => frame.t === 'complete:reply' && frame.id === 1 ? frame : null)
  assert.deepEqual(completed.matches.map((match) => match.text), ['df.head', 'df.describe'])
  assert.equal(await shellOf('complete_request'), completesBefore + 1, 'the machine\'s kernel was asked')
  teacherTab.control.send({ t: 'inspect', id: 2, code: 'df.head', cursor: 7, cellId: first })
  const helped = await teacherTab.control.frame('the help', (frame) => frame.t === 'inspect:reply' && frame.id === 2 ? frame : null)
  assert.equal(helped.found, true)
  assert.match(helped.text ?? '', /df\.head\(n=5\)/)
  assert.equal(await shellOf('inspect_request'), 1, 'the machine\'s kernel was asked')
  teacherTab.control.send({ t: 'inspect', id: 3, code: 'df', cursor: 2, cellId: first, brief: true })
  const brief = await teacherTab.control.frame('the brief', (frame) => frame.t === 'inspect:reply' && frame.id === 3 ? frame : null)
  assert.deepEqual([brief.found, brief.brief], [true, { type: 'DataFrame', dims: '1460 × 81' }])
  assert.ok((await door.requests()).some((one) => one.silent === true && one.code.includes('.brief(globals()')), 'the brief was read off the machine\'s kernel')
  // Help on a module: the kernel's answer, and the package's facts read off the same kernel by a second question (§5.6).
  teacherTab.control.send({ t: 'inspect', id: 4, code: 'MODULE', cursor: 6, cellId: first })
  const module = await teacherTab.control.frame('the help on a module', (frame) => frame.t === 'inspect:reply' && frame.id === 4 ? frame : null)
  assert.match(module.text ?? '', /Statistical data visualization/)
  assert.ok((await door.requests()).some((one) => one.silent === true && one.code.includes('.facts(globals()')), 'the facts were read off the machine\'s kernel')

  // input(): the prompt in the document for the room to see, the student's answer back to the cell on the machine.
  const asking = student.notebook.add('name = input("Как вас зовут? ")\nprint("Привет,", name)')
  student.control.send({ t: 'run', cellId: asking })
  const prompt = await until('the prompt in the teacher\'s document', () => {
    const cell = teacherTab.notebook.cell(asking)
    return cell ? readCell(cell).stdin : null
  })
  assert.deepEqual(prompt, { prompt: 'Как вас зовут? ', password: false })
  student.control.send({ t: 'input', value: 'Ада', cellId: asking })
  assert.deepEqual(await teacherTab.notebook.settled(asking), { state: 'ok', text: 'Привет, Ада\n', errors: [] })

  // Interrupt: a cell held on the machine, stopped from the room.
  const held = teacherTab.notebook.add('HOLD a1\nprint("никогда")')
  teacherTab.control.send({ t: 'run', cellId: held })
  await until('the held cell to compute on the machine', async () => (await kernelAt(door, id, CELLS_KEY))?.busy === true)
  teacherTab.control.send({ t: 'interrupt', cellId: held })
  const stopped = await student.notebook.settled(held)
  assert.deepEqual([stopped.state, stopped.text, stopped.errors.map((error) => error.split(':')[0])], ['error', '', ['KeyboardInterrupt']])
  assert.ok((await door.calls()).some((one) => one.kind === 'http' && one.method === 'POST' && one.path === `/api/kernels/${warm.id}/interrupt`), 'the interrupt reached the machine\'s kernel')

  // Restart: a new process over there, every variable gone, the guard in again.
  const notesBefore = student.notebook.notes().length
  teacherTab.control.send({ t: 'restart' })
  const restarted = tr('server.kernelRestartedByEveryVariableIsGone.3322fd', { p0: 'Преподавательница' })
  await until('the restart\'s note', () => student.notebook.notes().slice(notesBefore).includes(restarted), 20_000, () => student.notebook.notes().join('\n'))
  assert.ok((await door.calls()).some((one) => one.kind === 'http' && one.method === 'POST' && one.path === `/api/kernels/${warm.id}/restart`), 'the restart reached the machine\'s kernel')
  const after = teacherTab.notebook.add('print(x)')
  teacherTab.control.send({ t: 'run', cellId: after })
  assert.deepEqual((await student.notebook.settled(after)).errors, ['NameError: name \'x\' is not defined'], 'a fresh Python')
  await until('the guard in the new process', async () => (await kernelAt(door, id, CELLS_KEY))?.guarded === true)

  // The terminal: the room's shell is the class container's, in the class folder over there.
  teacherTab.control.send({ t: 'term:open' })
  teacherTab.control.send({ t: 'term:run', command: 'pwd' })
  await until('the machine\'s folder in the terminal', () => student.notebook.terminal().some((line) => line.kind === 'output' && line.text.includes(container.folder)), 20_000, () => JSON.stringify(student.notebook.terminal().slice(-6)))
  assert.ok((await door.calls()).some((one) => one.kind === 'stdin' && String(one.data).includes('pwd')), 'typed into the machine\'s pty')
  await until('the command to end', () => student.notebook.terminal().some((line) => line.kind === 'command' && line.text === 'pwd' && !line.running), 20_000, () => JSON.stringify(student.notebook.terminal().slice(-6)))

  // file:run: the file run by the machine's shell, from the class folder there.
  const script = 'print("файл", "на машине")\n'
  assert.ok(writeText(id, 'hello.py', script))
  fs.writeFileSync(path.join(container.folder, 'hello.py'), script)
  teacherTab.control.send({ t: 'file:run', path: 'hello.py' })
  await until('the file\'s output in the terminal', () => student.notebook.terminal().some((line) => line.kind === 'output' && line.text.includes('файл на машине')), 20_000, () => JSON.stringify(student.notebook.terminal().slice(-6)))
  assert.ok((await door.calls()).some((one) => one.kind === 'stdin' && String(one.data).includes('python -u \'hello.py\'')), 'run by the machine\'s shell')

  // Nothing of it reached this server's Jupyter, no DELETE reached the machine's, the room heard of nothing but the restart,
  // and its document never names the machine.
  assert.equal(here.kernelAt(jupyterSessionPath(id, CELLS_KEY)) ?? null, null)
  assert.deepEqual(student.notebook.notes(), [restarted], 'no word of a link, a start or a move')
  assert.equal(await deletes(door), 0)
  assert.ok(!JSON.stringify(student.notebook.doc.toJSON()).includes(machineName), 'the room\'s document never names the machine')
  assert.ok(!student.control.heard.some((frame) => frame.t === 'kernel:machine'), 'nor does a student\'s control socket')
  for (const one of [teacherTab, student]) {
    one.notebook.close()
    one.control.close()
  }
})

// Not yet: the class folder travels to machines in wave 3 (K6a, §8.2), and `file:run` passes the barrier before its shell runs
// the file. Until then the machine's shell finds no file saved only here; the scenario runs and is reported, never failed.
test('A1 · file:run of a file saved only here: the barrier brings it to the machine before its shell runs it (§8.2)', { timeout: 60_000, todo: 'K6a (wave 3): the class folder does not travel to machines yet' }, async () => {
  const machine = await classMachine()
  const teacher = staff()
  const id = await makeClass(teacher, 'A1 · файл отсюда', { room: 'machines' })
  await takes(machine, id)
  const lead = await tab(id, 'Преподавательница', teacher)
  await containerOf(machine, id, 'room')
  assert.ok(writeText(id, 'solo.py', 'print("файл с сервера")\n'))
  lead.control.send({ t: 'term:open' })
  lead.control.send({ t: 'file:run', path: 'solo.py' })
  try {
    await until('the command to end', () => lead.notebook.terminal().some((line) => line.kind === 'command' && line.text === 'python -u \'solo.py\'' && !line.running), 20_000, () => JSON.stringify(lead.notebook.terminal().slice(-4)))
    assert.ok(lead.notebook.terminal().some((line) => line.kind === 'output' && line.text.includes('файл с сервера')), JSON.stringify(lead.notebook.terminal().slice(-4)))
  } finally {
    lead.notebook.close()
    lead.control.close()
  }
})

test('A2 · two class notebooks in one room container; ten personal kernels on a machine with the room at home', { timeout: 90_000 }, async () => {
  const machine = await classMachine()
  const teacher = staff()
  const here = await home.homeJupyter()

  // Two class notebooks in one room container: a kernel of its own each, side by side in it, their variables their own.
  const two = await makeClass(teacher, 'A2 · две тетради', { room: 'machines' })
  await takes(machine, two)
  const lead = await tab(two, 'Преподавательница', teacher)
  const room = await containerOf(machine, two, 'room')
  const door = machine.jupyterOf(room)
  lead.control.send({ t: 'tree:new', path: 'вторая.ipynb' })
  const second = await until('the second class notebook in the room', () => bookAt(lead.notebook.doc, 'вторая.ipynb'))
  const inFirst = lead.notebook.add('x = "первая"\nprint(x)\nCOUNT')
  const inSecond = lead.notebook.add('print(x)', second.root)
  lead.control.send({ t: 'run', cellId: inFirst })
  lead.control.send({ t: 'run', cellId: inSecond })
  assert.deepEqual(await lead.notebook.settled(inFirst), { state: 'ok', text: 'первая\n1\n', errors: [] })
  assert.deepEqual((await lead.notebook.settled(inSecond)).errors, ['NameError: name \'x\' is not defined'], 'the second notebook\'s kernel is not the first\'s')
  const kernels = await until('both kernels guarded', async () => {
    const both = [await kernelAt(door, two, CELLS_KEY), await kernelAt(door, two, second.root)]
    return both.every((kernel) => kernel?.guarded) ? both : null
  })
  assert.notEqual(kernels[0]!.id, kernels[1]!.id)
  assert.deepEqual(machine.classContainers().filter((c) => c.labels.includes(`colloq.session=${two}`)).map((c) => c.id), [room.id], 'one container for the class, the room\'s')
  assert.deepEqual([livePlacement(two, 'room')?.state, livePlacement(two, 'own')], ['ready', null])
  assert.deepEqual([bookKernel(lead.notebook.doc, CELLS_KEY).where, bookKernel(lead.notebook.doc, second.root).where], ['machine', 'machine'])
  assert.equal(here.kernelAt(jupyterSessionPath(two, second.root)) ?? null, null)
  assert.deepEqual([await deletes(door), lead.notebook.notes()], [0, []])
  lead.notebook.close()
  lead.control.close()
  await endClass(teacher, two)

  // Personal notebooks on the machine and the class notebook here (D31): the teacher's coming in warms both up, each where it computes.
  const mixed = await makeClass(teacher, 'A2 · личные тетради', { own: 'machines' }, { ownBooks: 'on' })
  await takes(machine, mixed)
  const teacherTab = await tab(mixed, 'Преподавательница', teacher)
  await until('the class notebook\'s kernel here', () => here.kernelAt(jupyterSessionPath(mixed, CELLS_KEY)))
  const own = await containerOf(machine, mixed, 'own')
  await until('the personal notebooks\' slot ready on the machine', () => livePlacement(mixed, 'own')?.state === 'ready')
  const ownDoor = machine.jupyterOf(own)
  assert.deepEqual(await ownDoor.kernels(), [], 'warm: the container, and no kernel in it before a personal notebook runs')
  assert.equal(livePlacement(mixed, 'room'), null, 'the class notebook stays here')
  assert.equal(machine.classContainer(mixed, 'room'), null)
  // One limit for all of them, as here (D6), and the class's one hash seed (D28).
  const ownRow = livePlacement(mixed, 'own')!
  assert.deepEqual([own.memoryMb, own.cpus], [ownRow.memoryMb, ownRow.cpus])
  assert.deepEqual([ownRow.memoryMb, ownRow.cpus], Object.values(kernelLimits(mixed, 'base', 'own')))
  assert.equal(own.env.PYTHONHASHSEED, String(classHashSeed(mixed)))
  const ownFrame = await teacherTab.control.frame('the staff frame of the personal notebooks\' machine', (frame) => frame.t === 'kernel:machine' && frame.role === 'own' && frame.machine?.state === 'ready' ? frame : null)
  assert.equal(ownFrame.machine?.name, nameOf(machine))

  // Ten students, each in a personal notebook of their own, each running a cell at once.
  const students = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    const student = await tab(mixed, `Студент ${i + 1}`)
    const name = `моя-${i + 1}.ipynb`
    student.control.send({ t: 'tree:new', path: name })
    const book = await until(`${name} in the room`, () => bookAt(student.notebook.doc, name))
    const cell = await until(`${name}'s first cell`, () => bookCells(student.notebook.doc, book.root).get(0))
    cellSource(cell).insert(0, `who = "студент ${i + 1}"\nprint(who)\nCOUNT`)
    student.control.send({ t: 'run', cellId: cellId(cell) })
    return { student, root: book.root, cell: cellId(cell), i }
  }))
  for (const { student, cell, i } of students) {
    assert.deepEqual(await student.notebook.settled(cell), { state: 'ok', text: `студент ${i + 1}\n1\n`, errors: [] })
  }
  const personal = await ownDoor.kernels()
  assert.deepEqual(personal.map((kernel) => kernel.path).sort(), students.map(({ root }) => jupyterSessionPath(mixed, root)).sort(), 'ten personal kernels, in the one container')
  assert.ok(personal.every((kernel) => kernel.alive && kernel.guarded && kernel.count === 1), JSON.stringify(personal))
  assert.deepEqual(machine.classContainers().filter((c) => c.labels.includes(`colloq.session=${mixed}`)).map((c) => c.id), [own.id], 'one personal notebooks\' container for the class (D6), and no room container')
  for (const { root } of students) assert.equal(here.kernelAt(jupyterSessionPath(mixed, root)) ?? null, null)
  const view = students[0]!.student.notebook.doc
  assert.deepEqual([bookKernel(view, students[0]!.root).where, bookKernel(view, CELLS_KEY).where], ['machine', null])
  // A personal notebook's completion is asked of its kernel on the machine.
  const asked = (await ownDoor.calls()).filter((one) => one.kind === 'shell' && one.msgType === 'complete_request').length
  students[0]!.student.control.send({ t: 'complete', id: 7, code: 'df.', cursor: 3, cellId: students[0]!.cell })
  const completed = await students[0]!.student.control.frame('the completion', (frame) => frame.t === 'complete:reply' && frame.id === 7 ? frame : null)
  assert.deepEqual(completed.matches.map((match) => match.text), ['df.head', 'df.describe'])
  assert.equal((await ownDoor.calls()).filter((one) => one.kind === 'shell' && one.msgType === 'complete_request').length, asked + 1)

  // The class notebook computes here meanwhile.
  const lecture = teacherTab.notebook.add('print("тетрадь класса")')
  teacherTab.control.send({ t: 'run', cellId: lecture })
  assert.deepEqual(await students[3]!.student.notebook.settled(lecture), { state: 'ok', text: 'тетрадь класса\n', errors: [] })
  assert.ok(here.requests.some((one: { code: string }) => one.code === 'print("тетрадь класса")'), 'computed here')
  assert.ok(!(await ownDoor.requests()).some((one) => one.code.includes('тетрадь класса')))

  assert.equal(await deletes(ownDoor), 0)
  assert.deepEqual(teacherTab.notebook.notes(), [], 'nothing to tell the room')
  assert.ok(!students.some(({ student }) => student.control.heard.some((frame) => frame.t === 'kernel:machine')), 'students are never told the machine')
  for (const one of [teacherTab, ...students.map(({ student }) => student)]) {
    one.notebook.close()
    one.control.close()
  }
})

test('A3 · a home build differing from the agent\'s: classes keep running, a new placement goes home with the words, «устарел»', { timeout: 90_000 }, async () => {
  const machine = await classMachine()
  const teacher = staff()
  const here = await home.homeJupyter()
  const running = await makeClass(teacher, 'A3 · идёт', { room: 'machines' })
  await takes(machine, running)
  const lead = await tab(running, 'Преподавательница', teacher)
  const door = machine.jupyterOf(await containerOf(machine, running, 'room'))
  const before = lead.notebook.add('x = 7\nCOUNT')
  lead.control.send({ t: 'run', cellId: before })
  assert.deepEqual(await lead.notebook.settled(before), { state: 'ok', text: '1\n', errors: [] })
  const kernel = (await kernelAt(door, running, CELLS_KEY))!

  // This server is now of a release whose runner differs (0.23 decision 5).
  useHomeRunnerBuild('f'.repeat(64))
  try {
    // The owner's list says «устарела»; the machine hears it at its next sync.
    const row = await until('the owner\'s list to say the machine is outdated', async () => {
      const list = await call<RemoteMachinesResponse>('GET', '/api/admin/runners', undefined, teacher.cookie)
      return list.body.machines.find((one) => one.id === machine.runnerId && one.state === 'outdated')
    })
    assert.equal(tr(`admin.runners.state.${row.state}`), 'устарела')
    assert.equal(row.compatible, false)
    await until('the machine to hear it is outdated', () => machine.status()?.compatible === false, 20_000, () => machine.log())
    // The clock's passes see it so: nothing moves.
    home.tick()

    // The class on it keeps computing there, in the same kernel, with its variables.
    const again = lead.notebook.add('print(x)\nCOUNT')
    lead.control.send({ t: 'run', cellId: again })
    assert.deepEqual(await lead.notebook.settled(again), { state: 'ok', text: '7\n2\n', errors: [] })
    assert.deepEqual((await door.calls()).filter((one) => one.kind === 'count' && one.kernel === kernel.id).map((one) => one.value), [1, 2])
    const placed = placementRow(running, 'room')!
    assert.deepEqual([placed.state, placed.gen, placed.runnerId], ['ready', 1, machine.runnerId])
    assert.equal(home.tunnels!.isUp(machine.runnerId), true, 'its tunnel stays up for the class it holds')
    // A notebook of it opened now comes up in its container there too: the placement is the class's, and it holds.
    lead.control.send({ t: 'tree:new', path: 'ещё.ipynb' })
    const more = await until('the notebook in the room', () => bookAt(lead.notebook.doc, 'ещё.ipynb'))
    const third = lead.notebook.add('print("и эта")', more.root)
    lead.control.send({ t: 'run', cellId: third })
    assert.deepEqual(await lead.notebook.settled(third), { state: 'ok', text: 'и эта\n', errors: [] })
    assert.ok(await kernelAt(door, running, more.root), 'its kernel in the class\'s container on the machine')
    assert.deepEqual(lead.notebook.notes(), [], 'and its room hears nothing of it')

    // A new placement goes home: a class set to machines that starts now finds none to take it, starts here, and its room is told.
    const fresh = await makeClass(teacher, 'A3 · новое', { room: 'machines' })
    const outlook = await placementOutlook(fresh)
    assert.equal(outlook.machines.find((one) => one.runnerId === machine.runnerId)?.refusal, 'not-live', 'the form\'s live line: the machine takes nothing new')
    const freshTab = await tab(fresh, 'Преподавательница', teacher)
    const words = tr('server.noMachineCanTakeTheKernelNow.53437e')
    await until('the room told where its kernel went', () => freshTab.notebook.notes().includes(words), 20_000, () => freshTab.notebook.notes().join('\n'))
    assert.deepEqual(freshTab.notebook.notes(), [words], 'once')
    await until('its kernel here', () => here.kernelAt(jupyterSessionPath(fresh, CELLS_KEY)))
    const cell = freshTab.notebook.add('print("здесь")')
    freshTab.control.send({ t: 'run', cellId: cell })
    assert.deepEqual(await freshTab.notebook.settled(cell), { state: 'ok', text: 'здесь\n', errors: [] })
    assert.ok(here.requests.some((one: { code: string }) => one.code === 'print("здесь")'), 'computed here')
    assert.deepEqual([livePlacement(fresh, 'room'), machine.classContainer(fresh, 'room'), bookKernel(freshTab.notebook.doc, CELLS_KEY).where], [null, null, null])
    assert.ok(home.classLines.some((line) => line.includes(`${fresh}/room: no machine can take it (${nameOf(machine)}: not-live)`)), home.classLines.slice(-5).join('\n'))
    freshTab.notebook.close()
    freshTab.control.close()
  } finally {
    useHomeRunnerBuild(null)
  }
  // The builds match again (the machine updated, or home rolled back): the machine takes new classes again.
  const later = await makeClass(teacher, 'A3 · снова', { room: 'machines' })
  await takes(machine, later)
  assert.equal(await deletes(door), 0)
  lead.notebook.close()
  lead.control.close()
})
