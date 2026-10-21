/**
 * The class load generator (scripts/class-load.mts, docs/architecture/
 * remote-classes.md §17.5 «Load») against a class on a machine.
 *
 * EVERYTHING IS THE REAL THING BUT THE DAEMON AND THE PYTHON, as in the
 * classes e2e: home is the app of this process with its tunnel door
 * (tests/_remote-e2e-home.mts), the machine the real agent as a process of
 * its own on the fake docker (tests/_remote-e2e-agent.mts), its class
 * containers fake Jupyters (tests/_fake-jupyter.mjs, whose small language the
 * rig speaks with LOAD_CELLS=fake). The rig is a process of its own too, run
 * as an operator runs it, with nothing in its environment but what the
 * operator gives it, and it reaches the home through a fault proxy
 * (tests/_tunnel-fault.mts) where the relay would stand: so the bytes it says
 * it moved can be held against the wire's, and its sockets can be cut. Two
 * tests put an HTTP relay of their own there instead (`Frps`), which answers
 * as frps does for a home it cannot reach: its own 404 page.
 *
 * WHAT IS ASSERTED is what the rig promises: it refuses to start without an
 * explicit address and an owner's credential, a GPU class without a GPU
 * environment, data for an epoch in the fake's cells or more than an epoch
 * may hold or ship, and a baseline of another class, before any room
 * exists, and
 * `make class-load` takes the address from its command line only; it makes
 * its own seminar, holds a class in it on the machine and reports the §17.5
 * quantities (its LOAD_OUT), measuring a click that waits in its kernel's
 * queue in full and timing only completions that came with matches; its
 * council's attempts compute on the class's pool of workers on the machine
 * in two bursts — the first after a cell the teacher ran since the epoch,
 * on the one fresher epoch it waits for (the notebook's kernel asked a
 * question meanwhile, never made to run), any attempt the notebook's kernel
 * took instead counted with the reason its card gave, and a worker's seed
 * timed from it; the second beside the teacher's long cell, which the run
 * limit leaves to run its time, every one on the pool, on the older epoch
 * and saying so, the teacher's run ahead of the class's — with «Обновить
 * состояние» and the pool's start timed, a keystroke between tabs timed
 * during them as well as quietly, and those keystrokes' own writes of the
 * notebook named among the bytes, every one; an R2 row it cannot judge
 * names what it would need; it
 * types in the terminal at the prompt, never behind its own last command;
 * its tabs come back after a relay cut and after the server closes the staff's
 * sockets for an authorization change, as the web app's do; it deletes the
 * seminar at the end and on SIGINT — one Ctrl+C that npx delivers twice
 * included — leaving no class container on the machine; a relay's own 404
 * ends no class and fails no delete; a creation whose answer never came is
 * found by its name and deleted; a class no machine takes ends the run
 * before anyone joins, and a seminar deleted under it in the panel ends it at
 * the next knock; and nothing it prints carries a credential.
 */
import './_remote-e2e-home.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { tr } from '../shared/i18n.js'
import { authorizationChanged, createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie, readSetupToken } from '../server/src/admin/auth.js'
import { getSession } from '../server/src/db.js'
import { getRunner, mintRemoteCode } from '../server/src/competitions/remote/store.js'
import { livePlacement } from '../server/src/kernel/remote/placement-store.js'
import { shutdownKernels } from '../server/src/kernel/index.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { Agent, createFleet, killAgents, removeClassContainers, type Fleet } from './_remote-e2e-agent.mts'
import { Home, kernelRevision, until } from './_remote-e2e-home.mts'
import { TunnelFault } from './_tunnel-fault.mts'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(REPO, 'scripts/class-load.mts')
const NPX = path.join(path.dirname(process.execPath), 'npx')

const home = new Home({ liveness: 'manual' })
let fleet: Fleet
let machine: Agent
/** Where the relay stands: every byte of the rig's crosses it. */
let relay: TunnelFault
/** A relay that answers as frps does when it cannot reach the home. */
let frps: Frps
let ownerToken = ''
/** The instance's first owner, the one the setup token signs in as. */
let ownerId = ''
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-load-'))

/* ------------------------------------------------------------ the frps */

/** frp's own not-found page: what frps answers for a name it cannot hand to a client (relay-setup.sh · custom404Page). */
const FRP_404 = '<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>The page you requested was not found.</h1></body></html>'

/**
 * An HTTP relay in front of the home, standing where frps stands: requests
 * and upgrades passed through; during an `outage` every one answered with
 * frp's 404 page, as for a home restarting behind a live frpc or its leg
 * blocked; the next requests a test names answered with it too (`fail`),
 * or passed on with their answer lost on its way back (`hold`).
 */
class Frps {
  port = 0
  /** Requests and upgrades the relay answered with its own 404 page. */
  notFound = 0
  private down = false
  private failing: { match: (req: http.IncomingMessage) => boolean; times: number } | null = null
  private holding: ((req: http.IncomingMessage) => boolean) | null = null
  private readonly held = new Set<http.ServerResponse>()
  private readonly live = new Set<net.Socket>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private server: http.Server | null = null

  constructor(private readonly target: number) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      const failing = this.failing
      if (this.down || (failing && failing.times > 0 && failing.match(req))) {
        if (!this.down && failing) failing.times--
        this.notFound++
        req.resume()
        res.writeHead(404, { 'content-type': 'text/html' }).end(FRP_404)
        return
      }
      const lost = this.holding?.(req) ?? false
      const up = http.request({ host: '127.0.0.1', port: this.target, method: req.method, path: req.url, headers: req.headers }, (answer) => {
        if (lost) {
          // The home answered; the answer never comes back.
          this.held.add(res)
          answer.resume()
          return
        }
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      })
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/html' }).end(FRP_404)
      })
      req.pipe(up)
    })
    server.on('connection', (socket: net.Socket) => {
      this.live.add(socket)
      socket.once('close', () => this.live.delete(socket))
    })
    server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      if (this.down) {
        this.notFound++
        socket.end(`HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(FRP_404)}\r\nConnection: close\r\n\r\n${FRP_404}`)
        return
      }
      const up = net.connect(this.target, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
        up.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length) up.write(head)
        socket.pipe(up)
        up.pipe(socket)
      })
      this.live.add(up)
      up.once('close', () => {
        this.live.delete(up)
        socket.destroy()
      })
      up.on('error', () => socket.destroy())
      socket.on('error', () => up.destroy())
      socket.once('close', () => up.destroy())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    this.port = (server.address() as net.AddressInfo).port
  }

  /** The home away behind it for `ms`: every connection cut, then frp's 404 for every request and upgrade. */
  outage(ms: number): void {
    this.down = true
    for (const socket of [...this.live]) socket.destroy()
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.down = false
    }, ms)
    this.timers.add(timer)
  }

  /** The next `times` requests `match` takes answered with frp's 404, never reaching the home. */
  fail(match: (req: http.IncomingMessage) => boolean, times = 1): void {
    this.failing = { match, times }
  }

  /** Requests `match` takes reach the home, and their answers are lost on the way back. */
  hold(match: (req: http.IncomingMessage) => boolean): void {
    this.holding = match
  }

  /** Every fault lifted: the outage over, nothing failed or held from now on. */
  heal(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.down = false
    this.failing = null
    this.holding = null
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer)
    for (const res of this.held) res.destroy()
    for (const socket of [...this.live]) socket.destroy()
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }
}

/* ---------------------------------------------------------------- the rig */

interface Rig {
  child: ChildProcess
  /** Started in a process group of its own (npx), signalled as a terminal signals one. */
  group: boolean
  /** Everything it printed, both streams, in order. */
  out: string[]
  exited: Promise<number | null>
}

const rigs = new Set<Rig>()

/**
 * The rig as an operator starts it: its environment only what it is given,
 * never this process's (the home's secrets, its DATA_DIR). `npx` starts it
 * as the header's other way does, through npm and tsx, in a process group of
 * its own as a terminal's foreground job is.
 */
function rig(vars: Record<string, string>, how: 'node' | 'npx' = 'node'): Rig {
  const options = {
    cwd: REPO,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir(), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', ...vars },
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    detached: how === 'npx',
  }
  const child = how === 'npx' ? spawn(NPX, ['tsx', SCRIPT], options) : spawn(process.execPath, ['--import', 'tsx', SCRIPT], options)
  const out: string[] = []
  child.stdout!.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')))
  child.stderr!.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')))
  const run: Rig = { child, group: how === 'npx', out, exited: Promise.resolve(null) }
  run.exited = new Promise<number | null>((resolve) => child.once('exit', (code) => {
    rigs.delete(run)
    resolve(code)
  }))
  rigs.add(run)
  return run
}

/** Every process the rig runs as, gone: its group's, for a rig started in one. */
function kill(run: Rig): void {
  try {
    if (run.child.pid) process.kill(run.group ? -run.child.pid : run.child.pid, 'SIGKILL')
  } catch {
    /* gone already */
  }
}

const printed = (run: Rig) => run.out.join('')

/** The rig's exit, or a failure that shows what it printed. */
async function exitOf(run: Rig, timeoutMs: number): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), timeoutMs)))
  const code = await Promise.race([run.exited, late])
  clearTimeout(timer)
  if (code === 'late') {
    kill(run)
    assert.fail(`the rig did not end within ${timeoutMs} ms:\n${printed(run).slice(-4000)}`)
  }
  return code
}

/** A short class, as the test's machine and CI's few cores hold it: the fake's cells, one core and a gigabyte, no CSVs. */
function classVars(extra: Record<string, string>): Record<string, string> {
  return {
    LOAD_BASE_URL: relay.url,
    LOAD_SETUP_TOKEN: ownerToken,
    LOAD_CELLS: 'fake',
    LOAD_ENVIRONMENT: 'base',
    LOAD_CPUS: '1',
    LOAD_MEMORY_MB: '1024',
    LOAD_RAMP_SEC: '0',
    LOAD_UPLOAD_KB: '16',
    LOAD_CSV_MB: '0',
    ...extra,
  }
}

/** A staff member's cookie, as the panel's sign-in sets it. */
function cookieOf(role: 'owner' | 'teacher'): string {
  const made = createTeacher({ name: `Load ${role}`, email: `load.${role}.${Date.now()}.${randomBytes(3).toString('hex')}@example.edu`, role })!
  rotateLinkKey(made.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, made)
  return `${STAFF_COOKIE}=${value}`
}

/** No credential in what the rig printed: the owner's token, a cookie, a token in an address. */
function printsNoSecret(text: string, cookie?: string): void {
  assert.ok(!text.includes(ownerToken), 'the setup token was printed')
  if (cookie) assert.ok(!text.includes(cookie.slice(`${STAFF_COOKIE}=`.length)), 'the staff cookie was printed')
  assert.doesNotMatch(text, /token=(?!…)[A-Za-z0-9._-]{8,}/, 'a token in an address was printed')
}

/** The seminar's id as the rig's header names it. */
const seminarIn = (text: string): string | null => /\bseminar\s+([A-Za-z0-9_-]{4,})\s/.exec(text)?.[1] ?? null

/** Until the class is gone from the machine: no live placement row, no class container of it in its docker. */
async function goneFromMachine(sessionId: string): Promise<void> {
  await until(`class ${sessionId} off the machine`, () => livePlacement(sessionId, 'room') === null && livePlacement(sessionId, 'own') === null && livePlacement(sessionId, 'council') === null &&
    !machine.classContainers().some((c) => c.labels.includes(`colloq.session=${sessionId}`) && c.status !== 'exited'), 30_000, () => home.classLines.slice(-6).join('\n'))
}

const seminarPosts = () => home.requests.filter((one) => one.method === 'POST' && one.path === '/api/admin/seminars').length

/* ------------------------------------------------------------------ setup */

before(async () => {
  fleet = createFleet()
  await home.start()
  // What computes here: the class notebook of a class that keeps it on this server (CLASS=personal).
  await home.homeJupyter()
  // The class environment's image, in the fleet's registry and noted at home.
  kernelRevision(fleet)
  // The instance's owner, so that its setup token signs in as one (routes/admin-auth.ts · signin/token).
  const owner = createTeacher({ name: 'Load owner', email: `load.owner.${Date.now()}.${randomBytes(3).toString('hex')}@example.edu`, role: 'owner' })!
  rotateLinkKey(owner.id)
  ownerId = owner.id
  ownerToken = readSetupToken()
  const code = mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, classes: true, namePrefix: 'vast', createdBy: 'colloq-host' }).code
  // It reads its host to have twelve cores (AgentOptions.cpus), so that the class's room and personal containers and its council's
  // pool, a core a worker, fit beside each other on a CI runner of four.
  machine = new Agent(fleet, `load-${randomBytes(2).toString('hex')}`, { join: home.joinTarget(code), classes: true, cpus: 12 })
  machine.start()
  const runnerId = await until('the machine to join', () => machine.identity()?.runnerId, 30_000, () => machine.log())
  await until('its tunnel up at home', () => home.tunnels?.isUp(runnerId), 30_000, () => `${machine.log()}\n${home.tunnelLines.join('\n')}`)
  relay = await TunnelFault.start({ target: home.port })
  frps = new Frps(home.port)
  await frps.start()
})

after(async () => {
  for (const run of rigs) kill(run)
  await relay?.close()
  await frps?.close()
  // The kernels' clients and the rooms' documents of this process go first: no reconnect knocks on a machine that is gone.
  await shutdownKernels()
  shutdownCollab()
  await killAgents()
  await removeClassContainers()
  await home.close()
  fs.rmSync(outDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ tests */

test('it refuses to start without an explicit home and an owner\'s credential, a GPU class without a GPU environment, data for an epoch in the fake\'s cells or past what an epoch may hold, a baseline of another class, before any room exists', { timeout: 60_000 }, async () => {
  const seminarsBefore = seminarPosts()

  const nowhere = rig({ LOAD_SETUP_TOKEN: ownerToken })
  assert.equal(await exitOf(nowhere, 20_000), 2)
  assert.match(printed(nowhere), /LOAD_BASE_URL is not set/)

  const anonymous = rig({ LOAD_BASE_URL: relay.url })
  assert.equal(await exitOf(anonymous, 20_000), 2)
  assert.match(printed(anonymous), /neither LOAD_SETUP_TOKEN nor LOAD_STAFF_COOKIE/)

  // A teacher's cookie signs in, and is refused: only an owner deletes a seminar, and the rig deletes its own.
  const teacherCookie = cookieOf('teacher')
  const teacher = rig({ LOAD_BASE_URL: relay.url, LOAD_STAFF_COOKIE: teacherCookie })
  assert.equal(await exitOf(teacher, 20_000), 2)
  assert.match(printed(teacher), /not an owner's/)
  printsNoSecret(printed(teacher), teacherCookie)

  // CLASS=gpu is a class on a GPU environment: a CPU one would measure a CPU class under the GPU's name.
  const gpu = rig({ LOAD_BASE_URL: relay.url, LOAD_SETUP_TOKEN: ownerToken, LOAD_CLASS: 'gpu', LOAD_ENVIRONMENT: 'base' })
  assert.equal(await exitOf(gpu, 20_000), 2)
  assert.match(printed(gpu), /CLASS=gpu needs a GPU environment/)

  // The epoch's data is a Python cell's: the fake's small language makes no frame, and a run that asked for one would measure none.
  const data = rig({ LOAD_BASE_URL: relay.url, LOAD_SETUP_TOKEN: ownerToken, LOAD_CELLS: 'fake', LOAD_EPOCH_MB: '50' })
  assert.equal(await exitOf(data, 20_000), 2)
  assert.match(printed(data), /LOAD_EPOCH_MB: the data is a Python cell/)
  // Data that cannot be the pool's epoch: past the export's budget the frame stays behind, and a class notebook computing here
  // sends its first epoch whole, which past the ship cap keeps the council shared — either would measure the shared kernel.
  const budget = rig({ LOAD_BASE_URL: relay.url, LOAD_SETUP_TOKEN: ownerToken, LOAD_EPOCH_MB: '2048' })
  assert.equal(await exitOf(budget, 20_000), 2)
  assert.match(printed(budget), /LOAD_EPOCH_MB: at most 2032, not 2048/)
  const ships = rig({ LOAD_BASE_URL: relay.url, LOAD_SETUP_TOKEN: ownerToken, LOAD_CLASS: 'personal', LOAD_EPOCH_MB: '250' })
  assert.equal(await exitOf(ships, 20_000), 2)
  assert.match(printed(ships), /LOAD_EPOCH_MB: at most 240 with CLASS=personal, not 250/)

  // A baseline is a CLASS=home run of the same class: a machines run's numbers make a delta of nothing.
  const wrong = path.join(outDir, 'machines-baseline.json')
  fs.writeFileSync(wrong, JSON.stringify({ classLoad: 1, class: 'machines', cells: 'fake', students: 3, own: 0.5 }))
  const baseline = rig({ LOAD_BASE_URL: relay.url, LOAD_SETUP_TOKEN: ownerToken, LOAD_CELLS: 'fake', LOAD_STUDENTS: '3', LOAD_BASELINE: wrong })
  assert.equal(await exitOf(baseline, 20_000), 2)
  assert.match(printed(baseline), /LOAD_BASELINE is a CLASS=machines run/)

  // make class-load takes the home from its command line only: a URL the shell exports is nobody's choice. (No credential
  // goes with it, so a target that took it would start a rig that refuses on its own, never a class.)
  const made = spawnSync('make', ['--no-print-directory', 'class-load'], { cwd: REPO, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir(), URL: relay.url }, encoding: 'utf8' })
  assert.notEqual(made.status, 0)
  assert.match(made.stdout + made.stderr, /Specify the home/)
  assert.doesNotMatch(made.stdout + made.stderr, /class-load:/, 'the rig itself never started')

  assert.equal(seminarPosts(), seminarsBefore, 'no seminar was asked for')
})

test('a short class on the machine: its own seminar made, the class held and the numbers reported, its council on the class\'s pool, its tabs back after a cut and an authorization change, the seminar deleted', { timeout: 180_000 }, async () => {
  const out = path.join(outDir, 'machines.json')
  const name = getRunner(machine.runnerId)!.name
  const wireBefore = relay.stats().bytes
  // Its council on a pool of two workers of 512 MB: four students' bursts queue for them, and the teacher's run goes ahead.
  const run = rig(classVars({ LOAD_CLASS: 'machines', LOAD_STUDENTS: '4', LOAD_OWN: '0.25', LOAD_MINUTES: '0.25', LOAD_CSV_MB: '0.1', LOAD_BIG_MB: '1', LOAD_WORKERS: '2', LOAD_ATTEMPT_MB: '512', LOAD_OUT: out }))

  // The class has begun: the server closes the staff's sockets for a change of their rights (socket-authorization.ts,
  // 4401 «reconnect»), then the relay restarts under it, and every tab's sockets are reset at once.
  await until('the class to begin', () => printed(run).includes('3. CLASS'), 90_000, () => printed(run).slice(-3000))
  authorizationChanged(ownerId, [seminarIn(printed(run))!])
  await new Promise((resolve) => setTimeout(resolve, 1500))
  relay.cut()
  await new Promise((resolve) => setTimeout(resolve, 300))
  relay.heal()

  assert.equal(await exitOf(run, 160_000), 0, printed(run).slice(-4000))
  const text = printed(run)
  printsNoSecret(text)
  const sum = JSON.parse(fs.readFileSync(out, 'utf8'))
  const id = sum.seminar as string
  assert.equal(seminarIn(text), id, 'the header names the rig\'s own seminar')

  // Its own seminar, gone with everything it held: the row, the class's slots and containers on the machine.
  assert.equal(sum.deleted, true)
  assert.equal(getSession(id), null)
  const deletes = home.requests.filter((one) => one.method === 'DELETE' && one.path.startsWith('/api/admin/seminars/'))
  assert.deepEqual(deletes.map((one) => [one.path, one.status]), [[`/api/admin/seminars/${id}`, 204]], 'it deleted its own seminar, and nothing else')
  await goneFromMachine(id)

  // The class computed on the machine, and staff were told so.
  assert.deepEqual([sum.machine.where.room, sum.machine.where.own], [name, name], JSON.stringify(sum.machine))
  assert.ok(sum.machine.frames > 0)
  assert.deepEqual([sum.machine.failovers, sum.machine.unreachable.n], [0, 0], 'nothing failed over: the cut was the students\' path, not the machine\'s')
  assert.deepEqual([sum.joined, sum.synced, sum.personal], [4, 4, 1])
  // «Работают сейчас» named its three slots there, the council's with its two workers.
  assert.deepEqual(sum.machine.containers.map((slot: { role: string; where: string }) => `${slot.role}@${slot.where}`).sort(), [`council@${name}`, `own@${name}`, `room@${name}`], JSON.stringify(sum.machine.containers))
  assert.equal(sum.machine.containers.find((slot: { role: string }) => slot.role === 'council').workers, 2)

  // The numbers of §17.5, each with its p50 and p95.
  const n = sum.numbers
  const present = (what: string, spread: { n: number; p50: number | null; p95: number | null }, least = 1) => {
    assert.ok(spread.n >= least, `${what}: ${spread.n} samples`)
    assert.ok(Number.isFinite(spread.p50) && Number.isFinite(spread.p95), `${what}: ${JSON.stringify(spread)}`)
  }
  present('print(1) in the class notebook', n.print.room)
  present('print(1) in the personal notebook', n.print.own.n > 0 ? n.print.own : n.print.ownQueued)
  // The teacher's Shift+Enter behind the long cell waits longer than a click may go untaken (a tenth of the round): measured in full, never lost.
  present('print(1) behind its queue', n.print.roomQueued)
  assert.equal(n.print.unanswered, 0)
  present('the first runs', n.print.firstRoom, 3)
  present('the personal notebook\'s first run', n.print.firstOwn)
  // Completion: answers with matches to a free kernel are the row; every ask is in exactly one place.
  present('completion', n.completion.free)
  const c = n.completion
  assert.equal(c.asked, c.free.n + c.busy.n + c.away.n + c.empty + c.unanswered, JSON.stringify(c))
  present('the value line', n.value)
  present('interrupt', n.interrupt, 2)
  present('terminal echo', n.echo, 2)
  present('the figure', n.figure.shown)
  present('tqdm\'s longest gap', n.tqdm.longest)
  assert.ok(n.tqdm.updates > 0)
  present('the long cell', n.long.overhead)
  present('the run limit\'s stop', n.limit.past)
  present('upload', n.upload.http, 3)
  present('upload → readable', n.upload.readable)
  present('a 10 KB edit → readable', n.edit.readable)
  present('the big upload → readable', n.big.readable)
  assert.deepEqual(n.csv.map((csv: { mb: number; toPanel: { n: number } }) => [csv.mb, csv.toPanel.n]), [[0.1, 1]], JSON.stringify(n.csv))
  // The council (§17.5's R2 rows): two bursts of four on the machine's pool.
  const k = n.council
  assert.deepEqual([k.lane, k.workers, k.attemptMb, k.pool.workers, k.presses, k.beside.presses], ['pool', 2, 512, 2, 4, 4], JSON.stringify(k))
  /*
   * The first burst computed on one epoch, the refreeze of the teacher's cell
   * since the open that it waited for: the teacher's editor asked the
   * notebook's kernel a question meanwhile, never a run, which would have
   * made that epoch stale under the burst and its workers reload again.
   */
  assert.equal(k.burstEpochs, 1, JSON.stringify(k))
  present('a completion asked of the notebook\'s kernel during the burst', k.main.completionDuringBurst)
  // And from the console naming that epoch to its first attempt computing: a worker's seed.
  present('a worker\'s seed', k.pool.seed)
  // The long cell the second burst ran beside ran its own time: the room's run limit is past it.
  assert.equal(k.beside.stopped, 0, JSON.stringify(k.beside))
  // Two workers, four at once: the R2 burst row is not judged, and says what it would need.
  assert.match(text, /\(R2\) 30 attempts of 2 s on 8 workers ≤ 20 s not judged: «Попыток одновременно» was 2, not 8 \(LOAD_WORKERS=8\)/)
  present('council attempts', k, 8)
  assert.deepEqual([k.unanswered, k.errors, k.placed.pool + k.placed.shared], [0, 0, k.n], JSON.stringify(k))
  // Beside the teacher's long cell every attempt computed on the pool, the notebook's kernel never one of them, whose own cell held it.
  assert.deepEqual([k.beside.placed.pool, k.beside.placed.shared, k.beside.busyWithAttempt], [4, 0, 0], JSON.stringify(k.beside))
  /*
   * Every attempt of both bursts computed on the pool: a press that lands
   * while both workers load the epoch the teacher's cell made them take
   * waits in the pool's queue for the reload (council-pool.ts · ready,
   * Worker.reloading) — it went to the shared kernel before, reading «Пул ещё
   * поднимается» of a pool that was up.
   */
  assert.deepEqual([k.placed.pool, k.placed.shared], [k.n, 0], JSON.stringify(k.placed))
  assert.deepEqual(k.placed.why, {}, JSON.stringify(k.placed.why))
  present('an attempt\'s wait to compute', k.wait)
  present('an attempt\'s overhead past its two seconds', k.overhead)
  present('the burst', k.burst)
  present('the first burst\'s first start', k.firstStart)
  present('the burst beside the teacher\'s long cell', k.beside.burst)
  present('the teacher\'s run of a student\'s attempt', k.host)
  // Pressed once the class had, beside the long cell, it left the pool's queue ahead of the attempts waiting there for a fresher epoch (D12).
  assert.deepEqual([k.host.judged, k.host.overtaken], [1, 0], JSON.stringify(k.host))
  present('the pool\'s epoch, cold', k.pool.epochFirst)
  present('the pool\'s first start', k.pool.readyFirst)
  present('«Обновить состояние» with nothing run since', k.pool.refresh)
  // The teacher's cell after the epoch: the first burst waited for a fresher one; beside the long cell, the second ran on the
  // older one, each card saying which cells it lacks.
  assert.ok(k.epochs.fresh >= 1 && k.epochs.noted >= 4 && k.epochs.silent === 0, JSON.stringify(k.epochs))
  present('a keystroke between tabs', n.collab.quiet)
  present('a keystroke between tabs during a burst', n.collab.burst)
  // Each keystroke is an edit of the class notebook, written to its file and pushed to the machine: section 6 names them, every one.
  const probe = sum.bytes.probe
  assert.equal(probe.edits, n.collab.quiet.n + n.collab.burst.n + n.collab.big.n + n.collab.unanswered, JSON.stringify({ probe, collab: n.collab }))
  assert.ok(probe.notebookBytes > 0, JSON.stringify(probe))
  assert.match(text, new RegExp(`less the rig's own keystrokes between tabs \\(collaboration RTT\\): ${probe.edits} edits of the class notebook`))
  present('the control ping', n.controlRtt)
  present('the rig\'s own loop', sum.rig.loopLag)
  assert.deepEqual([n.interrupt.lost, n.echo.shellBusy], [0, 0])
  assert.ok(n.value.answered > 0 && n.value.answered <= n.value.asked)

  // Each echo was typed at the prompt: the shell never had to hold one behind the last («команда ждёт свободной оболочки»).
  const waiting = tr('server.colloqTheCommandIsWaitingForThe.0e6b42', { p0: 'Teacher (class-load)' })
  assert.ok(!JSON.stringify(sum.machine.roomNotes).includes(waiting), JSON.stringify(sum.machine.roomNotes))

  // The authorization change closed the staff's sockets, and they came back as the web app's do: the chip was watched to the end.
  assert.ok((sum.sockets.closes['4401'] ?? 0) >= 2, JSON.stringify(sum.sockets))
  assert.deepEqual(sum.tabsUp, { staff: 2, students: 4 }, JSON.stringify(sum.sockets))
  // The cut reset every socket of the six tabs, and each came back by itself.
  assert.ok(sum.sockets.reconnects.collab >= 6 && sum.sockets.reconnects.control >= 6, JSON.stringify(sum.sockets))

  // Its bytes are the wire's: what the relay carried for it, less the request headers it cannot see.
  const wire = relay.stats().bytes
  const up = wire.up - wireBefore.up
  const down = wire.down - wireBefore.down
  assert.ok(sum.bytes.received > 0.8 * down && sum.bytes.received <= down * 1.01, `received ${sum.bytes.received} of the wire's ${down}`)
  assert.ok(sum.bytes.sent > 0.5 * up && sum.bytes.sent <= up * 1.01, `sent ${sum.bytes.sent} of the wire's ${up}`)
})

test('a class set to machines that none takes ends the run before anyone joins, and its seminar goes', { timeout: 60_000 }, async () => {
  // An environment with no portable image here: the class's own refusal, which no wait mends (placement.ts · outlook).
  const out = path.join(outDir, 'refused.json')
  const run = rig(classVars({ LOAD_CLASS: 'machines', LOAD_STUDENTS: '2', LOAD_MINUTES: '0.25', LOAD_ENVIRONMENT: 'kaggle-base', LOAD_OUT: out }))
  assert.equal(await exitOf(run, 45_000), 1, printed(run).slice(-3000))
  assert.match(printed(run), /no machine takes this class: not-portable/)
  const sum = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.deepEqual([sum.deleted, sum.joined], [true, 0], 'nobody came into a class that would have computed here')
  assert.equal(getSession(sum.seminar), null)
  printsNoSecret(printed(run))
})

test('its seminar deleted under it in the panel: the rig notices at its next knock, says so and ends', { timeout: 90_000 }, async () => {
  const out = path.join(outDir, 'deleted.json')
  const run = rig(classVars({ LOAD_CLASS: 'personal', LOAD_STUDENTS: '2', LOAD_OWN: '0.5', LOAD_MINUTES: '5', LOAD_OUT: out }))
  await until('the class to begin', () => printed(run).includes('3. CLASS'), 90_000, () => printed(run).slice(-3000))
  const id = seminarIn(printed(run))!
  // The owner deletes it in the panel: its sockets close, and the door refuses them back (upgrade.ts · reject).
  const gone = await home.admin('DELETE', `/api/admin/seminars/${id}`)
  assert.equal(gone.status, 204)
  assert.equal(await exitOf(run, 40_000), 1, printed(run).slice(-3000))
  assert.match(printed(run), /was deleted under the rig/)
  const sum = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(sum.deleted, true, 'nothing of it is left: it was gone already')
  assert.match(sum.endedBy, /deleted under the rig/)
  await goneFromMachine(id)
  printsNoSecret(printed(run))
})

test('one Ctrl+C under npx tsx reaches the rig twice: it is one press, and the seminar goes with nothing left on the machine', { timeout: 90_000 }, async () => {
  const out = path.join(outDir, 'interrupted.json')
  const run = rig(classVars({ LOAD_CLASS: 'personal', LOAD_STUDENTS: '2', LOAD_OWN: '0.5', LOAD_MINUTES: '5', LOAD_OUT: out }), 'npx')
  await until('the class to begin', () => printed(run).includes('3. CLASS'), 90_000, () => printed(run).slice(-3000))
  const id = seminarIn(printed(run))
  assert.ok(id, printed(run))
  // Its personal notebooks compute on the machine meanwhile, the class notebook here.
  assert.ok(machine.classContainers().some((c) => c.labels.includes(`colloq.session=${id}`) && c.labels.includes('colloq.role=own') && c.status === 'running'))

  // The relay holds every byte 60 ms each way: the delete's answer comes later than npm's copy of the press.
  relay.delay(60)
  try {
    // As a terminal sends Ctrl+C: to the whole process group — npm, tsx and the rig.
    process.kill(-run.child.pid!, 'SIGINT')
    assert.notEqual(await exitOf(run, 60_000), 0, printed(run).slice(-4000))
  } finally {
    relay.heal()
  }
  const sum = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.deepEqual([sum.seminar, sum.interrupted, sum.deleted], [id, true, true], printed(run).slice(-3000))
  assert.doesNotMatch(printed(run), /left at once/)
  assert.equal(getSession(id!), null)
  assert.ok(home.requests.some((one) => one.method === 'DELETE' && one.path === `/api/admin/seminars/${id}` && one.status === 204))
  await goneFromMachine(id!)
  printsNoSecret(printed(run))
})

test('the relay\'s own 404 for a home it cannot reach ends no class, and the delete it answers is tried again', { timeout: 90_000 }, async () => {
  const out = path.join(outDir, 'relay-404.json')
  const run = rig({ LOAD_BASE_URL: frps.url, LOAD_SETUP_TOKEN: ownerToken, LOAD_CELLS: 'fake', LOAD_CLASS: 'home', LOAD_STUDENTS: '2', LOAD_OWN: '0', LOAD_MINUTES: '0.25', LOAD_RAMP_SEC: '0', LOAD_UPLOAD_KB: '16', LOAD_CSV_MB: '0', LOAD_OUT: out })
  await until('the class to begin', () => printed(run).includes('3. CLASS'), 60_000, () => printed(run).slice(-3000))
  const id = seminarIn(printed(run))!
  const seen = frps.notFound
  try {
    // The home restarts behind the relay: frp's page for every request and upgrade, three seconds long (§17.5 «Restart H mid-class»).
    frps.outage(3_000)
    // And the rig's delete at the end meets it once more.
    frps.fail((req) => req.method === 'DELETE' && (req.url ?? '').startsWith(`/api/admin/seminars/${id}`))
    assert.equal(await exitOf(run, 80_000), 0, printed(run).slice(-4000))
  } finally {
    frps.heal()
  }
  const sum = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(sum.endedBy, null, printed(run).slice(-3000))
  assert.ok(frps.notFound > seen + 1, 'the relay answered its own page meanwhile')
  assert.ok(sum.sockets.reconnects.control >= 3, JSON.stringify(sum.sockets))
  assert.equal(sum.deleted, true)
  assert.equal(getSession(id), null)
  assert.ok(home.requests.some((one) => one.method === 'DELETE' && one.path === `/api/admin/seminars/${id}` && one.status === 204))
  printsNoSecret(printed(run))
})

test('a seminar whose creation was never answered is found by its name on Ctrl+C, and deleted', { timeout: 60_000 }, async () => {
  const since = Date.now()
  // The home makes the room; its answer is lost on the way back.
  frps.hold((req) => req.method === 'POST' && req.url === '/api/admin/seminars')
  const out = path.join(outDir, 'unanswered.json')
  try {
    const run = rig({ LOAD_BASE_URL: frps.url, LOAD_SETUP_TOKEN: ownerToken, LOAD_CELLS: 'fake', LOAD_CLASS: 'home', LOAD_STUDENTS: '2', LOAD_MINUTES: '0.25', LOAD_CSV_MB: '0', LOAD_OUT: out })
    await until('the seminar made at home', () => home.requests.some((one) => one.method === 'POST' && one.path === '/api/admin/seminars' && one.status === 201 && one.at >= since), 30_000, () => printed(run))
    run.child.kill('SIGINT')
    assert.equal(await exitOf(run, 40_000), 130, printed(run))
    const name = /looking for «([^»]+)»/.exec(printed(run))?.[1]
    assert.ok(name, printed(run))
    assert.match(printed(run), /cleaned up: seminar \S+ deleted/)
    const listed = await home.admin<Array<{ name: string }>>('GET', '/api/admin/seminars?scope=all')
    assert.ok(!listed.body.some((one) => one.name === name), `«${name}» is still at the home`)
    const sum = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.deepEqual([sum.interrupted, sum.deleted], [true, true])
    printsNoSecret(printed(run))
  } finally {
    frps.heal()
  }
})
