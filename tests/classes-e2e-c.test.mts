/**
 * Classes on machines («занятия на машинах») end to end, scenarios C: the
 * class folder both ways (docs/architecture/remote-classes.md §8, §17.2
 * C.9–C.13), on the harness of tests/classes-e2e.test.mts.
 *
 * EVERYTHING IS THE REAL THING BUT THE DAEMON AND THE PYTHON. Home is the app
 * of this process with its tunnel door (tests/_remote-e2e-home.mts); a machine
 * is the real agent as a process of its own (tests/_remote-e2e-agent.mts) on
 * the fake docker (tests/_remote-e2e-docker.mjs), whose class containers are
 * fake Jupyters (tests/_fake-jupyter.mjs) working in the machine's copy of the
 * class folder (<state>/rooms/<id>). What travels between this server's folder
 * and that copy is the product's: home's pushes and the agent's reports on the
 * sync's `kernels` block, the larger files by their own doors (GET blobs, PUT
 * rooms/:id/files). A cell writes, renames and removes there as a kernel does
 * (the fake's WRITE, FILL, TRUNCATE, MOVE, REMOVE); here the editor's and the
 * oracle's writer (workspace.ts · writeText), the room's upload door and the
 * tree's verbs write.
 *
 * WHAT IS ASSERTED is what people see through their own doors — the room's
 * tree (GET /api/sessions/:id/files, a student's), the cells' outputs and the
 * kernel log's notes in the room's document, the control socket's refusals,
 * the owner's «Работают сейчас» — the bytes of both folders and the machine's
 * baseline, the home's requests (a PUT is an upload), the counts of the class
 * folders' module (walks, pushes and refusals), and that no DELETE reached the
 * machine's Jupyter: nothing in scenarios C is lost.
 * Nothing moves a clock: every wait is for an event (a cell at the kernel, a
 * file in a folder, a row in the tree), never a production timeout.
 *
 * ONE MACHINE SERVES THE FILE. Each scenario makes a class of its own on it,
 * and the owner stops its kernels once it is over.
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
import { getLocale, tr } from '../shared/i18n.js'
import { STAFF_COOKIE, type ClassPlacement, type RunningClass, type RunningKernels } from '../shared/admin.js'
import type { ControlClientMessage, ControlServerMessage, FileEntry, JoinResponse } from '../shared/protocol.js'
import type { RunningClassMachines } from '../shared/remote-admin.js'
import { CLASS_INLINE_BYTES, CLASS_INLINE_PUSH_BYTES, type RemoteFilesLag } from '../shared/remote-kernels.js'
import { CELLS_KEY, bookAt, bookCells, bookList, cellId, createCell, getTerminal, readCell, readTerminalLine, type YCell } from '../shared/notebook.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { machineFileLimitBytes } from '../server/src/admin/resource-settings.js'
import { getRunner, mintRemoteCode } from '../server/src/competitions/remote/store.js'
import { placementOutlook } from '../server/src/kernel/remote/placement.js'
import { livePlacement } from '../server/src/kernel/remote/placement-store.js'
import { ClassFiles, sizeWords, useClassFiles } from '../server/src/kernel/remote/files.js'
import { shutdownKernels } from '../server/src/kernel/index.js'
import { peekSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { projectBooks } from '../server/src/collab/books.js'
import { sessionDir, writeText, type FileTree } from '../server/src/workspace.js'
import { instanceTimeZone } from '../server/src/time-zone.js'
import { Agent, createFleet, killAgents, removeClassContainers, type FakeClassContainer, type FakeJupyterDoor, type Fleet } from './_remote-e2e-agent.mts'
import { Home, kernelRevision, until } from './_remote-e2e-home.mts'

const home = new Home({ liveness: 'manual' })
let fleet: Fleet
/** Every socket a scenario opened: closed at the end of the file, whatever happened. */
const sockets = new Set<WebSocket>()
/** What the class folders' module said (ClassFiles' log), oldest first: for a red test's message, never printed. */
const fileLines: string[] = []
/** This file's class folders on machines (kernel/remote/files.ts): the process's, with its log kept here. */
let files: ClassFiles

before(async () => {
  fleet = createFleet()
  await home.start()
  // What computes on this server: none of these classes, but a slot no machine takes would.
  await home.homeJupyter()
  // The class environment's image, in the fleet's registry and noted at home: what a class set to machines runs there.
  kernelRevision(fleet)
  files = new ClassFiles({ log: (line) => fileLines.push(line) })
  useClassFiles(files)
})

after(async () => {
  for (const ws of sockets) ws.terminate()
  // The kernels' clients and the rooms' documents of this process go first: no reconnect knocks on a machine that is gone.
  await shutdownKernels()
  shutdownCollab()
  await killAgents()
  await removeClassContainers()
  useClassFiles(null)
  await home.close()
})

/* ------------------------------------------------------------------ people */

interface Staff {
  /** The Cookie header a signed-in teacher's browser sends. */
  cookie: string
}

/** A teacher of this instance, signed in: the owner, who also says where classes compute (§6.2, D4). */
function staff(name = 'Преподавательница C'): Staff {
  const made = createTeacher({ name, email: `c.${Date.now()}.${randomBytes(3).toString('hex')}@example.edu`, role: 'owner' })!
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

/** A class made in the panel on the base environment, its room set to machines in its «Ресурсы» (§6.2). */
async function makeClass(by: Staff, name: string, placement: Partial<ClassPlacement>): Promise<string> {
  const made = await call<{ id: string }>('POST', '/api/admin/seminars', { name, environment: 'base', rules: {}, cpus: 1, memoryMb: 1024 }, by.cookie)
  assert.equal(made.status, 201, JSON.stringify(made.body))
  classes.push({ by, id: made.body.id })
  const set = await call('PATCH', `/api/admin/seminars/${made.body.id}`, { placement }, by.cookie)
  assert.equal(set.status, 200, JSON.stringify(set.body))
  return made.body.id
}

/** The class is over: the owner stops its kernels («Остановить» in «Работают сейчас»), and its slot leaves the machine. */
async function endClass(by: Staff, sessionId: string): Promise<void> {
  const stopped = await call<{ error?: string }>('POST', `/api/admin/resources/running/${sessionId}/stop`, { what: 'class', force: true }, by.cookie)
  assert.ok(stopped.status === 200 || stopped.status === 404, `${stopped.status} ${JSON.stringify(stopped.body)}`)
  await until(`class ${sessionId} off the machine`, () => livePlacement(sessionId, 'room') === null, 30_000, () => home.classLines.slice(-5).join('\n'))
}

afterEach(async () => {
  for (const { by, id } of classes.splice(0)) await endClass(by, id)
})

/** «Войти» on the room's page (POST /api/sessions/:id/join): the token its sockets and its doors open with. */
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

  static async open(sessionId: string, joined: JoinResponse, by?: Staff): Promise<Notebook> {
    const notebook = new Notebook(`${home.url.replace('http:', 'ws:')}/collab/${sessionId}?token=${encodeURIComponent(joined.token)}`, by?.cookie)
    await until('the notebook to sync', () => notebook.doc.getArray(CELLS_KEY).length > 0)
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
    }, timeoutMs, () => JSON.stringify({ cell: this.cell(id) ? readCell(this.cell(id)!) : null, notes: this.notes(), files: fileLines.slice(-6) }))
  }

  /** The cell ran to its end with no error: what it printed. */
  async ok(id: string): Promise<string> {
    const done = await this.settled(id)
    assert.deepEqual([done.state, done.errors], ['ok', []], `the cell: ${JSON.stringify(done)}\nnotes: ${this.notes().join('\n')}`)
    return done.text
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

  /** The refusals said to this socket since `from`. */
  errors(from = 0): string[] {
    return this.heard.slice(from).flatMap((frame) => (frame.t === 'error' ? [frame.message] : []))
  }

  close(): void {
    this.ws.terminate()
  }
}

/** A browser tab in a room, joined, with both of its sockets; `token` is what its doors are called with. */
interface Tab {
  notebook: Notebook
  control: Control
  token: string
}

async function tab(sessionId: string, name: string, by?: Staff): Promise<Tab> {
  const joined = await join(sessionId, name, by)
  return { notebook: await Notebook.open(sessionId, joined, by), control: await Control.open(sessionId, joined, by), token: joined.token }
}

function closeTabs(...tabs: Tab[]): void {
  for (const one of tabs) {
    one.notebook.close()
    one.control.close()
  }
}

/* ---------------------------------------------------------------- machines */

let shared: Agent | null = null

/**
 * The file's class machine: joined with a code minted «Принимает занятия», as
 * the instance's console mints one, its agent running and its tunnel up.
 * Named by the code's prefix («vast-1»), never by its tree.
 */
async function classMachine(): Promise<Agent> {
  if (shared) return shared
  const code = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, classes: true, namePrefix: 'vast', createdBy: 'colloq-host' }).code
  const agent = new Agent(fleet, `c-${randomBytes(2).toString('hex')}`, { join: home.joinTarget(code), classes: true })
  agent.start()
  const runnerId = await until('the machine to join', () => agent.identity()?.runnerId, 30_000, () => agent.log())
  await until('its tunnel up at home', () => home.tunnels?.isUp(runnerId), 30_000, () => `${agent.log()}\n${home.tunnelLines.join('\n')}`)
  shared = agent
  return agent
}

/** The machine's name as the owner gave it: what the room's document must never say. */
const nameOf = (agent: Agent): string => getRunner(agent.runnerId)!.name

/** Until the form's live line says this machine takes the class: its image there, its facts heard. */
async function takes(agent: Agent, sessionId: string): Promise<void> {
  let last: unknown = null
  await until(`${agent.name} to take class ${sessionId}`, async () => {
    const outlook = await placementOutlook(sessionId)
    last = outlook
    return outlook.refusal === null && outlook.machines.find((one) => one.runnerId === agent.runnerId)?.refusal === null
  }, 30_000, () => `${JSON.stringify(last)}\n${agent.log()}\n${home.classLines.slice(-10).join('\n')}`)
}

/** The room's container on the machine, once it runs and its Jupyter listens. */
async function containerOf(agent: Agent, sessionId: string): Promise<FakeClassContainer> {
  return until(`the room container of ${sessionId} on ${agent.name}`, () => {
    const found = agent.classContainer(sessionId, 'room')
    return found?.status === 'running' && found.port !== null ? found : null
  }, 30_000, () => agent.log())
}

/** Every DELETE a fake Jupyter was sent. */
async function deletes(door: FakeJupyterDoor): Promise<number> {
  return (await door.calls()).filter((one) => one.kind === 'http' && one.method === 'DELETE').length
}

/** A class on the file's machine, its room's kernel there, with a teacher's tab in it: what every scenario starts from. */
async function classOn(name: string): Promise<{ machine: Agent; teacher: Staff; id: string; lead: Tab; container: FakeClassContainer; door: FakeJupyterDoor }> {
  const machine = await classMachine()
  const teacher = staff()
  const id = await makeClass(teacher, name, { room: 'machines' })
  await takes(machine, id)
  const lead = await tab(id, 'Преподавательница', teacher)
  const container = await containerOf(machine, id)
  assert.equal(container.folder, machine.roomCopy(id), 'the room\'s container works in the machine\'s copy of the class folder')
  return { machine, teacher, id, lead, container, door: machine.jupyterOf(container) }
}

/* -------------------------------------------------------------- the folders */

/** A file of the class folder here, as text; null — none. */
function homeFile(sessionId: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(sessionDir(sessionId), rel), 'utf8')
  } catch {
    return null
  }
}

/** A file of the machine's copy of the class folder, as text; null — none. */
function machineFile(machine: Agent, sessionId: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(machine.roomCopy(sessionId), rel), 'utf8')
  } catch {
    return null
  }
}

/** Every regular file under a folder that travels (no hidden name, no Python cache, as a walk takes them): path → its length. */
function filesUnder(root: string, rel = ''): Map<string, number> {
  const out = new Map<string, number>()
  let names: string[] = []
  try {
    names = fs.readdirSync(rel ? path.join(root, rel) : root)
  } catch {
    return out
  }
  for (const name of names) {
    if (name.startsWith('.') || name === '__pycache__') continue
    const at = rel ? `${rel}/${name}` : name
    const stat = fs.lstatSync(path.join(root, at))
    if (stat.isDirectory()) for (const [inner, bytes] of filesUnder(root, at)) out.set(inner, bytes)
    else if (stat.isFile()) out.set(at, stat.size)
  }
  return out
}

/** A file's sha256, read as a stream (a checkpoint of hundreds of megabytes is never held whole). */
async function shaOf(full: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(full)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Until the machine's copy holds this server's class folder as it is — every
 * file of it there, byte for byte — with no push of it unacked: the two sides
 * in step. The machine may hold more (what stays on it).
 */
async function inStep(machine: Agent, sessionId: string, what = 'the machine\'s copy in step with this server\'s folder'): Promise<void> {
  const same = (): boolean => {
    if (files.unackedPushes() > 0) return false
    const there = filesUnder(machine.roomCopy(sessionId))
    for (const [at, bytes] of filesUnder(sessionDir(sessionId))) {
      if (there.get(at) !== bytes) return false
      if (!fs.readFileSync(path.join(sessionDir(sessionId), at)).equals(fs.readFileSync(path.join(machine.roomCopy(sessionId), at)))) return false
    }
    return true
  }
  await until(what, same, 20_000, () => `${fileLines.slice(-8).join('\n')}\n${machine.log()}`)
}

/**
 * Nothing on its way either way: what the tab typed in this server's
 * document of the room, the room's notebooks projected to their files now
 * (collab/books.ts · projectBooks, the projection's own timer otherwise a
 * second and a half away), and the machine's copy in step. As a teacher's
 * Run finds it seconds after the cell was typed.
 */
async function quiet(machine: Agent, sessionId: string, notebook?: Notebook): Promise<void> {
  if (notebook) {
    const typed = bookCells(notebook.doc, CELLS_KEY).toArray().map(cellId)
    await until('the room\'s document here to hold every cell typed', () => {
      const doc = peekSessionDoc(sessionId)?.doc
      const here = new Set(doc ? bookCells(doc, CELLS_KEY).toArray().map(cellId) : [])
      return typed.every((one) => here.has(one))
    })
  }
  projectBooks(sessionId)
  await inStep(machine, sessionId)
}

/** The room's tree as a participant reads it (GET /api/sessions/:id/files): its rows by path. */
async function tree(sessionId: string, token: string): Promise<{ rows: Map<string, FileEntry>; files: FileEntry[] }> {
  const answer = await fetch(`${home.url}/api/sessions/${sessionId}/files`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(answer.status, 200)
  const listed = (await answer.json()) as FileTree
  return { rows: new Map(listed.files.map((entry) => [entry.path, entry])), files: listed.files }
}

/** A file put in through the room's upload door (POST /api/sessions/:id/files), as the files panel sends it: multipart, field `file`. */
async function upload(sessionId: string, by: Staff, name: string, content: string): Promise<number> {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'text/csv' }), name)
  const answer = await fetch(`${home.url}/api/sessions/${sessionId}/files`, { method: 'POST', headers: { cookie: by.cookie }, body: form })
  await answer.arrayBuffer()
  return answer.status
}

/**
 * What the owner reads of the class's files on its machine in «Работают
 * сейчас» (GET /api/admin/resources/running, Paper 18 · Z7): the room
 * slot's lag, as the machine said it. Undefined — no such row (yet).
 */
async function lagSeen(by: Staff, sessionId: string): Promise<RemoteFilesLag | null | undefined> {
  const running = await call<RunningKernels>('GET', '/api/admin/resources/running', undefined, by.cookie)
  assert.equal(running.status, 200)
  const row = running.body.classes.find((one) => one.id === sessionId) as (RunningClass & RunningClassMachines) | undefined
  return row?.machines?.find((slot) => slot.role === 'room')?.files
}

/** The class's files the machine uploaded here: its PUTs of rooms/:id/files, each one a pull home asked for. */
const uploadsOf = (machine: Agent, sessionId: string): number =>
  home.requests.filter((one) => one.method === 'PUT' && one.runnerId === machine.runnerId && one.path === `/api/runners/v1/rooms/${sessionId}/files`).length

/** Until the machine's kernel has the cell: its code asked to run there (the files barrier passed). */
async function atKernel(door: FakeJupyterDoor, marker: string): Promise<void> {
  await until(`the cell with ${marker} at the machine's kernel`, async () => (await door.requests()).some((one) => one.silent !== true && one.code.includes(marker)), 20_000, () => fileLines.slice(-6).join('\n'))
}

/** CSV text of `bytes` bytes (an ASCII `tag`): a header, then rows of it. */
function csv(bytes: number, tag: string): string {
  const head = 'id,value\n'
  const row = `${tag},0.5\n`
  const body = head + row.repeat(Math.ceil((bytes - head.length) / row.length))
  return body.slice(0, bytes - 1) + '\n'
}

/** A server word with its placeholders as patterns: a note of it, whatever it says in them. */
function wordsOf(key: string, names: readonly string[]): RegExp {
  const marks = Object.fromEntries(names.map((name, i) => [name, `\u0000${i}\u0000`]))
  const escaped = tr(key, marks).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\u0000\d+\u0000/g, '.+?')}$`)
}

/** The kernel log's notes as the room's document holds them here: what every tab of it reads. */
function roomNotes(sessionId: string): string[] {
  const doc = peekSessionDoc(sessionId)?.doc
  return doc ? getTerminal(doc).toArray().map(readTerminalLine).filter((line) => line.kind === 'system').map((line) => line.text) : []
}

/** The conflict copies of `stem` here: files whose name is the copy's shape for it, whatever the time or the number after it. */
function copiesOf(sessionId: string, stem: string): string[] {
  const prefix = tr('server.fromTheMachine.3b540b', { name: stem, time: '\u0000' }).split('\u0000')[0]!
  return [...filesUnder(sessionDir(sessionId)).keys()].filter((at) => at.startsWith(prefix))
}

/**
 * The names a conflict copy of `stem` + `ext` may have now (§8.4): «utils (с
 * машины 14-32).py», the time of this minute or the last one in the
 * instance's zone, a hyphen for the colon.
 */
function copyNames(stem: string, ext: string): string[] {
  const clock = new Intl.DateTimeFormat(getLocale(), { timeZone: instanceTimeZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return [Date.now(), Date.now() - 60_000].map((at) => `${tr('server.fromTheMachine.3b540b', { name: stem, time: clock.format(at).replace(':', '-') })}${ext}`)
}

/* --------------------------------------------------------------- scenarios */

test('C9 · an upload here is read by the next cell there; with nothing changed a Run walks and pushes nothing, a 10 KB edit is one push, and a folder past one reply\'s inline budget a chain the Run waits out', { timeout: 90_000 }, async () => {
  const { machine, id, lead, door, teacher } = await classOn('C9 · загрузка')
  // The copy made when the class was placed, pushed whole: the room's notebook there as here.
  await quiet(machine, id, lead.notebook)

  // An upload through the room's door, and at once a cell that reads it on the machine: the Run waits for the push (§8.2).
  const data = csv(10 * 1024, 'uploaded')
  assert.equal(await upload(id, teacher, 'data.csv', data), 200)
  const read = lead.notebook.add('READ data.csv')
  lead.control.send({ t: 'run', cellId: read })
  assert.equal(await lead.notebook.ok(read), data, 'the machine\'s kernel read the file uploaded here')
  assert.equal(machineFile(machine, id, 'data.csv'), data)

  // Nothing changed: a cell typed, projected into the notebook's file and that pushed (in the background, acked), then run.
  // The barrier passes on a compare of two numbers: no walk, no push, and the kernel has the cell at once.
  const still = lead.notebook.add('HOLD c9\nprint("ничего не менялось")')
  await quiet(machine, id, lead.notebook)
  const idle = { ...files.counts }
  lead.control.send({ t: 'run', cellId: still })
  await atKernel(door, 'HOLD c9')
  assert.deepEqual({ walks: files.counts.walks - idle.walks, pushes: files.counts.pushes - idle.pushes }, { walks: 0, pushes: 0 }, 'a Run with nothing changed walks and pushes nothing')
  assert.equal(await door.release('c9'), 1)
  assert.equal(await lead.notebook.ok(still), 'ничего не менялось\n')

  // A 10 KB edit, saved by the editor (its writer, workspace.ts · writeText): one push, which the Run waits for.
  const reread = lead.notebook.add('HOLD c9e\nREAD data.csv')
  await quiet(machine, id, lead.notebook)
  const edited = csv(10 * 1024, 'edited')
  const before = files.counts.pushes
  assert.ok(writeText(id, 'data.csv', edited))
  lead.control.send({ t: 'run', cellId: reread })
  await atKernel(door, 'HOLD c9e')
  assert.equal(files.counts.pushes - before, 1, 'a 10 KB edit is one push')
  assert.equal(machineFile(machine, id, 'data.csv'), edited, 'on the machine before the cell runs')
  assert.equal(await door.release('c9e'), 1)
  assert.equal(await lead.notebook.ok(reread), edited)

  // Twenty small files written here at once, more than one reply carries inline: a chain of pushes, small files inline
  // all of them (never a GET each), and the Run waits for its last.
  const each = 60_000
  const count = 20
  assert.ok(each <= CLASS_INLINE_BYTES && each * count > CLASS_INLINE_PUSH_BYTES)
  const pictures = lead.notebook.add(`HOLD c9p\nREAD photos/${count - 1}.txt`)
  await quiet(machine, id, lead.notebook)
  const chainFrom = files.counts.pushes
  const blobsFrom = home.requests.filter((one) => one.runnerId === machine.runnerId && one.path.startsWith('/api/runners/v1/blobs/')).length
  const contents = Array.from({ length: count }, (_, i) => `${i}`.padEnd(each - 1, '.') + '\n')
  for (let i = 0; i < count; i++) assert.ok(writeText(id, `photos/${i}.txt`, contents[i]!))
  lead.control.send({ t: 'run', cellId: pictures })
  await atKernel(door, 'HOLD c9p')
  const perPush = Math.floor(CLASS_INLINE_PUSH_BYTES / each)
  assert.equal(files.counts.pushes - chainFrom, Math.ceil(count / perPush), `a chain of pushes, one reply's inline budget each:\n${fileLines.slice(-6).join('\n')}`)
  for (let i = 0; i < count; i++) assert.equal(machineFile(machine, id, `photos/${i}.txt`), contents[i], `photos/${i}.txt there before the cell`)
  assert.equal(home.requests.filter((one) => one.runnerId === machine.runnerId && one.path.startsWith('/api/runners/v1/blobs/')).length, blobsFrom, 'no blob fetched for a small file')
  assert.equal(await door.release('c9p'), 1)
  assert.equal(await lead.notebook.ok(pictures), contents[count - 1])

  assert.equal(await deletes(door), 0)
  assert.ok(!JSON.stringify(lead.notebook.doc.toJSON()).includes(nameOf(machine)), 'the room\'s document never names the machine')
  closeTabs(lead)
})

test('C10 · a cell writes out.csv there and /files lists it once the cell ends; the kernel\'s rename is a movePath here with no upload; its delete removes it here', { timeout: 90_000 }, async () => {
  const { machine, id, lead, door } = await classOn('C10 · запись на машине')
  const student = await tab(id, 'Студент')
  await quiet(machine, id, lead.notebook)

  // 100 KB of CSV written by the kernel: over the inline cap, so its bytes come home by a pull (PUT rooms/:id/files).
  const write = lead.notebook.add('FILL out.csv 102400 7,0.5\\n')
  lead.control.send({ t: 'run', cellId: write })
  await lead.notebook.ok(write)
  const written = machineFile(machine, id, 'out.csv')!
  assert.ok(written.length === 102400 && written.length > CLASS_INLINE_BYTES)
  // The cell's end asks the machine for a scan (§8.3): the file is reported, pulled, and listed here — whole, not «на машине».
  const listed = await until('out.csv in the room\'s tree', async () => {
    const row = (await tree(id, student.token)).rows.get('out.csv')
    return row && !row.onMachine && !row.pending ? row : null
  }, 20_000, () => fileLines.slice(-8).join('\n'))
  assert.equal(listed.size, written.length)
  assert.equal(homeFile(id, 'out.csv'), written)
  assert.equal(uploadsOf(machine, id), 1, 'its bytes came by one upload')
  const inode = fs.statSync(path.join(sessionDir(id), 'out.csv')).ino

  // The kernel renames it: a removal and an addition of one content in one report, a movePath here — the same file, no upload.
  // Once the machine has home's word that both sides hold it (the verdict, in its baseline), as a kernel's rename comes later.
  await until('out.csv agreed in the machine\'s baseline', () => machine.roomBaseline(id)?.files.has('out.csv'), 20_000, () => machine.log())
  await inStep(machine, id)
  const rename = lead.notebook.add('MOVE out.csv final.csv')
  lead.control.send({ t: 'run', cellId: rename })
  await lead.notebook.ok(rename)
  const moved = await until('final.csv in the tree, out.csv gone', async () => {
    const { rows } = await tree(id, student.token)
    return rows.has('final.csv') && !rows.has('out.csv') && !rows.get('final.csv')!.pending ? rows.get('final.csv')! : null
  }, 20_000, () => fileLines.slice(-8).join('\n'))
  assert.equal(moved.size, written.length)
  assert.equal(homeFile(id, 'final.csv'), written)
  assert.equal(homeFile(id, 'out.csv'), null)
  assert.equal(fs.statSync(path.join(sessionDir(id), 'final.csv')).ino, inode, 'a movePath: the file here renamed, not written anew')
  assert.equal(uploadsOf(machine, id), 1, 'no upload for a rename')

  // The kernel removes it: removed here too, and nothing brings it back on either side.
  const remove = lead.notebook.add('REMOVE final.csv')
  lead.control.send({ t: 'run', cellId: remove })
  await lead.notebook.ok(remove)
  await until('final.csv gone from the tree', async () => !(await tree(id, student.token)).rows.has('final.csv'), 20_000, () => fileLines.slice(-8).join('\n'))
  assert.equal(homeFile(id, 'final.csv'), null)
  assert.ok(await files.filesSettled(id, 15_000), 'the machine has nothing more to say of the class')
  await quiet(machine, id, lead.notebook)
  assert.equal(machineFile(machine, id, 'final.csv'), null, 'nor is it back there')
  assert.equal(homeFile(id, 'final.csv'), null)
  assert.equal(uploadsOf(machine, id), 1)

  assert.deepEqual(lead.notebook.notes(), [], 'nothing to tell the room')
  assert.equal(await deletes(door), 0)
  closeTabs(lead, student)
})

test('C11 · the editor saves utils.py while the kernel writes it: this server\'s version stays, the machine\'s is «utils (с машины HH-MM).py»; deleted here while the kernel rewrites it: nothing comes back', { timeout: 90_000 }, async () => {
  const { machine, id, lead, door } = await classOn('C11 · одновременно')
  const student = await tab(id, 'Студент')

  // Both sides change utils.py from one version: the kernel there, then the editor here, before either hears of the other.
  assert.ok(writeText(id, 'utils.py', 'VERSION = "общая"\n'))
  await quiet(machine, id, lead.notebook)
  const both = lead.notebook.add('WRITE utils.py VERSION = "машина"\\n\nHOLD c11')
  lead.control.send({ t: 'run', cellId: both })
  await atKernel(door, 'HOLD c11')
  await until('the kernel\'s version there', () => machineFile(machine, id, 'utils.py') === 'VERSION = "машина"\n')
  assert.ok(writeText(id, 'utils.py', 'VERSION = "сервер"\n'))
  assert.equal(await door.release('c11'), 1)
  await lead.notebook.ok(both)

  // This server's version stays; the machine's is kept beside it under the conflict copy's name; the room is told; and the
  // machine gets this server's version back, with the copy.
  const names = copyNames('utils', '.py')
  const kept = await until('the conflict copy here', () => names.find((name) => homeFile(id, name) !== null), 20_000, () => `${[...filesUnder(sessionDir(id)).keys()].join(', ')}\n${fileLines.slice(-8).join('\n')}`)
  assert.equal(homeFile(id, 'utils.py'), 'VERSION = "сервер"\n', 'this server\'s version won')
  assert.equal(homeFile(id, kept), 'VERSION = "машина"\n', 'the machine\'s version, kept as the conflict copy')
  await until('the room told', () => lead.notebook.notes().includes(tr('server.wasChangedHereAndOnTheMachine.107a60', { file: 'utils.py', copy: kept })), 10_000, () => lead.notebook.notes().join('\n'))
  const row = (await tree(id, student.token)).rows.get(kept)
  assert.equal(row?.conflict?.of, 'utils.py', 'the copy\'s row says whose it is')
  await quiet(machine, id, lead.notebook)
  assert.equal(machineFile(machine, id, 'utils.py'), 'VERSION = "сервер"\n', 'this server\'s version pushed back')
  assert.equal(machineFile(machine, id, kept), 'VERSION = "машина"\n')
  assert.deepEqual(copiesOf(id, 'utils'), [kept], 'one copy, not two')

  // Deleted here while the kernel rewrites it: the delete holds, the kernel's change is dropped with a note, nothing comes back.
  assert.ok(writeText(id, 'log.txt', 'строка 0\n'))
  await quiet(machine, id, lead.notebook)
  const loop = lead.notebook.add('WRITE log.txt строка 1\\n\nHOLD c11b')
  lead.control.send({ t: 'run', cellId: loop })
  await atKernel(door, 'HOLD c11b')
  await until('the kernel\'s rewrite there', () => machineFile(machine, id, 'log.txt') === 'строка 1\n')
  lead.control.send({ t: 'tree:remove', path: 'log.txt' })
  await until('removed here', () => homeFile(id, 'log.txt') === null)
  assert.equal(await door.release('c11b'), 1)
  await lead.notebook.ok(loop)
  const dropped = tr('server.wasDeletedOnTheServerTheChanges.6230f9', { file: 'log.txt' })
  await until('the note', () => lead.notebook.notes().includes(dropped), 20_000, () => `${lead.notebook.notes().join('\n')}\n${fileLines.slice(-8).join('\n')}`)
  assert.ok(await files.filesSettled(id, 15_000))
  await quiet(machine, id, lead.notebook)
  assert.equal(homeFile(id, 'log.txt'), null, 'not back here')
  assert.equal(machineFile(machine, id, 'log.txt'), null, 'the delete holds there too')
  assert.equal((await tree(id, student.token)).rows.has('log.txt'), false)
  // And a scan after the next cell still finds nothing to bring back.
  const next = lead.notebook.add('print("дальше")')
  lead.control.send({ t: 'run', cellId: next })
  await lead.notebook.ok(next)
  assert.ok(await files.filesSettled(id, 15_000))
  assert.equal(homeFile(id, 'log.txt'), null)
  assert.equal(lead.notebook.notes().filter((note) => note === dropped).length, 1, 'said once')

  assert.equal(await deletes(door), 0)
  assert.ok(!JSON.stringify(lead.notebook.doc.toJSON()).includes(nameOf(machine)), 'the notes never name the machine')
  closeTabs(lead, student)
})

test('C12 · a 300 MB write stays «на машине» with a line in the kernel log, and «Привезти» brings it; pip install -t . is one package row and no upload', { timeout: 90_000 }, async () => {
  const { machine, id, lead, door, teacher } = await classOn('C12 · большие файлы')
  const student = await tab(id, 'Студент')
  await quiet(machine, id, lead.notebook)

  // A checkpoint past «Файл с машины — до» (200 MB): it stays on the machine, its row says so, the kernel log says it once.
  const big = 300 * 1024 * 1024
  assert.ok(big > machineFileLimitBytes())
  const save = lead.notebook.add(`TRUNCATE model.pt ${big}`)
  lead.control.send({ t: 'run', cellId: save })
  await lead.notebook.ok(save)
  const row = await until('the row of the file on the machine', async () => (await tree(id, student.token)).rows.get('model.pt')?.onMachine, 20_000, () => fileLines.slice(-8).join('\n'))
  assert.deepEqual(row, { bytes: big, why: 'size' })
  const overCap = tr('server.isOverTheLimitAndStaysOn.bf3362', { file: 'model.pt', size: sizeWords(big), limit: sizeWords(machineFileLimitBytes()) })
  await until('the kernel log\'s line', () => lead.notebook.notes().includes(overCap), 10_000, () => lead.notebook.notes().join('\n'))
  assert.equal(homeFile(id, 'model.pt'), null, 'nothing of it here')
  assert.equal(uploadsOf(machine, id), 0, 'nothing uploaded')
  const after = lead.notebook.add('print("дальше")')
  lead.control.send({ t: 'run', cellId: after })
  await lead.notebook.ok(after)
  assert.ok(await files.filesSettled(id, 15_000))
  assert.equal(lead.notebook.notes().filter((note) => note === overCap).length, 1, 'said once')
  // The owner reads it in «Работают сейчас»: one file, of its size, only on the machine (§8.7).
  const stays = await until('the owner\'s row to count it only on the machine', async () => {
    const lag = await lagSeen(teacher, id)
    return lag && lag.heldOnly === 1 ? lag : null
  }, 20_000, () => machine.log())
  assert.equal(stays.heldOnlyBytes, big)

  // «Привезти»: staff bring it, over the per-file cap, within the room's limit; one upload, and the row is the file here.
  const fromLead = lead.control.heard.length
  lead.control.send({ t: 'files:fetch', path: 'model.pt' })
  const landed = await until('the file brought here', async () => {
    const one = (await tree(id, student.token)).rows.get('model.pt')
    return one && !one.onMachine && !one.pending ? one : null
  }, 60_000, () => fileLines.slice(-8).join('\n'))
  assert.equal(landed.size, big)
  assert.deepEqual(lead.control.errors(fromLead), [])
  assert.equal(uploadsOf(machine, id), 1, 'one upload: the file brought')
  assert.equal(await shaOf(path.join(sessionDir(id), 'model.pt')), await shaOf(path.join(machine.roomCopy(id), 'model.pt')), 'the machine\'s bytes, here')

  // pip install -t .: a package tree as pip leaves it, its RECORD last. It stays on the machine as one row, never uploaded.
  const record = (rel: string, body: string): string => `${rel},sha256=${createHash('sha256').update(body).digest('base64url')},${Buffer.byteLength(body)}`
  const parts = { init: 'from .core import answer', core: 'answer = 42', meta: 'Name: colloqpkg\nVersion: 1.0' }
  const lines = [
    record('colloqpkg/__init__.py', parts.init),
    record('colloqpkg/core.py', parts.core),
    record('colloqpkg-1.0.dist-info/METADATA', parts.meta),
    'colloqpkg-1.0.dist-info/RECORD,,',
  ]
  const pip = lead.notebook.add([
    `WRITE colloqpkg/__init__.py ${parts.init}`,
    `WRITE colloqpkg/core.py ${parts.core}`,
    `WRITE colloqpkg-1.0.dist-info/METADATA ${parts.meta.replace('\n', '\\n')}`,
    `WRITE colloqpkg-1.0.dist-info/RECORD ${lines.join('\\n')}\\n`,
  ].join('\n'))
  lead.control.send({ t: 'run', cellId: pip })
  await lead.notebook.ok(pip)
  const packages = await until('the package row', async () => {
    const listed = await tree(id, student.token)
    return listed.files.some((entry) => entry.kind === 'packages') ? listed : null
  }, 20_000, () => fileLines.slice(-8).join('\n'))
  const rows = packages.files.filter((entry) => entry.kind === 'packages')
  const bytes = Buffer.byteLength(parts.init) + Buffer.byteLength(parts.core) + Buffer.byteLength(parts.meta)
  assert.deepEqual(rows.map((entry) => [entry.path, entry.bytes, entry.count, entry.onMachine]), [['.packages', bytes, 2, { bytes, why: 'package' }]], 'one row for the tree pip made')
  assert.deepEqual(packages.files.filter((entry) => entry.path.startsWith('colloqpkg')).map((entry) => entry.path), [], 'none of its files in the tree')
  assert.ok(await files.filesSettled(id, 15_000))
  assert.equal(fs.existsSync(path.join(sessionDir(id), 'colloqpkg')), false, 'nothing of it here')
  assert.equal(uploadsOf(machine, id), 1, 'no upload for it')
  // And the owner reads only the package tree as left on the machine: the checkpoint brought here is counted there no more.
  let lastLag: unknown = null
  await until('the owner\'s row to count only the packages on the machine', async () => {
    const lag = await lagSeen(teacher, id)
    lastLag = lag
    return lag?.heldOnlyBytes === bytes
  }, 20_000, () => `${JSON.stringify(lastLag)}\n${machine.log()}`)

  // The class ends with another checkpoint left only on the machine: it goes with the copy there. The machine moved nowhere,
  // so the room is never told it came back after a move (§8.8 is a failover's).
  const second = lead.notebook.add(`TRUNCATE second.pt ${big}`)
  lead.control.send({ t: 'run', cellId: second })
  await lead.notebook.ok(second)
  await until('the second checkpoint\'s row', async () => (await tree(id, student.token)).rows.get('second.pt')?.onMachine, 20_000, () => fileLines.slice(-8).join('\n'))
  assert.equal(await deletes(door), 0)
  await endClass(teacher, id)
  const lateTaken = (line: string): boolean => line.startsWith(`[files] ${id}: machine ${machine.runnerId} `) && /lets go of|came back with/.test(line)
  await until('the machine\'s late list of its copy taken in here', () => fileLines.some(lateTaken), 30_000, () => `${fileLines.slice(-8).join('\n')}\n${machine.log()}`)
  const moved = wordsOf('server.theMachineCameBackAfterTheMove.f1111a', ['since', 'files'])
  assert.deepEqual(roomNotes(id).filter((note) => moved.test(note)), [], 'no word of a move that never was')
  // What went with the copy is said in the stop's words, once: the second checkpoint, which never came here.
  const dropped = wordsOf('server.theKernelsOnTheMachineWereStopped.d5fceb', ['files'])
  const said = roomNotes(id).filter((note) => dropped.test(note))
  assert.equal(said.length, 1, roomNotes(id).join('\n'))
  assert.ok(said[0]!.includes('second.pt'), said[0])

  assert.ok(!JSON.stringify(lead.notebook.doc.toJSON()).includes(nameOf(machine)), 'the notes never name the machine')
  closeTabs(lead, student)
})

test('C13 · a kernel writes a notebook\'s file: refused, the notebook stays the room\'s, and its projection goes back to the machine; os.remove of it is refused too', { timeout: 90_000 }, async () => {
  const { machine, id, lead, door } = await classOn('C13 · тетрадь')
  const book = bookList(lead.notebook.doc)[0]!.path
  const first = lead.notebook.add('print("тетрадь класса")')
  lead.control.send({ t: 'run', cellId: first })
  await lead.notebook.ok(first)
  await quiet(machine, id, lead.notebook)
  const cells = bookCells(lead.notebook.doc, CELLS_KEY).length

  // The kernel overwrites the notebook's file there, as `open('Тетрадь.ipynb', 'w')` would.
  const forged = '{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}'
  const refusedBefore = files.counts.refused
  const write = lead.notebook.add(`WRITE ${book} ${forged}`)
  lead.control.send({ t: 'run', cellId: write })
  await lead.notebook.ok(write)
  // Refused: this server's file stays the document's projection, and that goes back to the machine (§8.4).
  await until('the kernel\'s write refused here', () => files.counts.refused > refusedBefore, 20_000, () => fileLines.slice(-8).join('\n'))
  assert.ok(await files.filesSettled(id, 15_000))
  await quiet(machine, id, lead.notebook)
  assert.notEqual(machineFile(machine, id, book), forged, 'the machine has the projection back')
  assert.ok(homeFile(id, book)!.includes('тетрадь класса'), 'this server\'s file is the room\'s notebook')
  assert.ok(!homeFile(id, book)!.includes('"cells": []'), 'never the kernel\'s bytes')
  assert.equal(bookCells(lead.notebook.doc, CELLS_KEY).length, cells + 1, 'the notebook keeps its cells')
  assert.deepEqual(copiesOf(id, book.replace(/\.ipynb$/, '')), [], 'no conflict copy of a notebook')

  // os.remove of it there: refused too, the tab stays, and the file goes back to the machine.
  const remove = lead.notebook.add(`REMOVE ${book}`)
  lead.control.send({ t: 'run', cellId: remove })
  await lead.notebook.ok(remove)
  assert.ok(await files.filesSettled(id, 15_000))
  await quiet(machine, id, lead.notebook)
  assert.ok(machineFile(machine, id, book)?.includes('тетрадь класса'), 'back on the machine')
  assert.ok(homeFile(id, book)!.includes('тетрадь класса'))
  assert.ok(bookAt(lead.notebook.doc, book), 'the notebook\'s tab stays')

  assert.deepEqual(lead.notebook.notes(), [], 'nothing to tell the room')
  assert.equal(await deletes(door), 0)
  closeTabs(lead)
})
