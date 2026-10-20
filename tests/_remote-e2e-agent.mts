/**
 * The machines of tests/remote-e2e.test.mts: the REAL agent
 * (server/src/runner-agent/main.ts, under tsx) as a child process of its own,
 * one per machine, each with its own tree and its own fake Docker.
 *
 * A PROCESS OF ITS OWN, NOT AN IMPORT. data-dir.ts reads DATA_DIR once, when
 * the storage layout loads, and the agent refuses to start unless DATA_DIR is
 * its tree's data/ (main.ts · configured); the home in the test's process has
 * a DATA_DIR of its own. So each agent gets its own environment, built from
 * nothing (never the test process's, which holds the home's secrets and its
 * KERNEL_BACKEND=test): COLLOQ_RUNNER_JOIN with the home's loopback address and
 * an owner's code, COLLOQ_RUNNER_STATE and DATA_DIR in its own temporary tree,
 * NODE_ENV=development as the image's entry point sets it, and a PATH that
 * starts with the fake (tests/_remote-e2e-docker.mjs), so it is the `docker`
 * every spawn finds — /usr/bin and /bin after it, never the directories a
 * Docker Desktop or Colima CLI is installed in. Plain http to
 * 127.0.0.1 needs no switch: the contract takes an http origin for a home on
 * the same network or in a test (shared/remote-runner.ts · homeOrigin).
 *
 * ANOTHER BUILD, WITHOUT TOUCHING THE PRODUCT. A machine's build is the
 * sha256 in runner.sha256 beside its entry, and `dev` for the sources
 * (main.ts · runnerBuild, the one the test's home reports too). An agent of
 * another build runs a byte-for-byte copy of main.ts placed in a temporary
 * tree of its own, with a runner.sha256 beside it and every module it imports
 * linked to the real one: the same code, reporting another build.
 *
 * EVERY CHILD DIES WITH THE TEST. Each one started is remembered; killAgents()
 * (the test's `after`) and the process's exit — a failed test, --test-force-exit
 * — SIGKILL whatever is still running. Only these pids are ever signalled.
 *
 * A CLASS MACHINE (remote-classes.md §7, §17.2) is the same agent with what a
 * class kernel host needs of its daemon: an image of its own for the
 * perimeter's helper (COLLOQ_RUNNER_IMAGE, the form `make runner-dev` has, or
 * its own container seeded with a network mode), the machine's own settings in
 * its environment, and the fake docker's class containers — each a fake
 * Jupyter process (tests/_fake-jupyter.mjs) that outlives the agent, as a
 * container does, so that an agent killed and started again adopts it. Those
 * processes are the fake docker's children, not the test's: they end with
 * their container (`docker rm`, `kill`), once the test's process is gone
 * (FAKE_DOCKER_OWNER), and at removeClassContainers() (the test's `after`)
 * and the process's exit, which signal each by the pid its container's state
 * names, after its command line says it is that container's.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { layersFingerprint } from '../server/src/dependencies/image-identity.ts'
import { remoteCredential } from '../shared/remote-runner.ts'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(REPO, 'server/src/runner-agent/main.ts')
const FAKE_DOCKER = path.join(REPO, 'tests/_remote-e2e-docker.mjs')

/* ------------------------------------------------------------ the children */

const live = new Set<ChildProcess>()

function killLive(): void {
  for (const child of live) {
    try {
      if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(child.pid, 'SIGKILL')
    } catch { /* gone already */ }
  }
}

/** Every machine made in this process: whose fake docker's class containers the teardown ends. */
const machines = new Set<Agent>()

/** A process's command line by its pid; null — no such process (or none this process may read). */
function commandLine(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
  } catch { /* no /proc: macOS */ }
  const asked = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return asked.status === 0 ? asked.stdout : null
}

/** The pids of the class containers' processes of every machine, each checked to be its container's (pids come round). */
function classProcesses(): number[] {
  const pids: number[] = []
  for (const machine of machines) {
    for (const c of machine.classContainers()) {
      if (c.pid !== null && (commandLine(c.pid) ?? '').includes(`--container-id ${c.id}`)) pids.push(c.pid)
    }
  }
  return pids
}

function killClassProcesses(): number[] {
  const pids = classProcesses()
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch { /* gone already */ }
  }
  return pids
}

process.on('exit', () => {
  killLive()
  killClassProcesses()
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    killLive()
    killClassProcesses()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

/** SIGKILL every agent still running and wait for each to be gone. */
export async function killAgents(): Promise<void> {
  const waits = [...live].map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
  }))
  killLive()
  await Promise.all(waits)
}

/**
 * Every class container's process of every machine ended, and waited for:
 * the teardown of a suite whose machines ran classes (the containers outlive
 * the agents, as on a real machine). A process is not this test's child, so
 * its end is seen by asking for it until it is gone.
 */
export async function removeClassContainers(): Promise<void> {
  const pids = killClassProcesses()
  for (const pid of pids) {
    for (let i = 0; i < 250; i++) {
      try {
        process.kill(pid, 0)
      } catch {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

/* --------------------------------------------------------------- the fleet */

/** What every machine of a run shares: the registry the kernels are pulled from, the gates notebooks wait on, the fake `docker` itself. */
export interface Fleet {
  root: string
  bin: string
  registry: string
  gates: string
}

export function createFleet(): Fleet {
  // os.tmpdir(), not a deeper folder: each agent listens on a Unix socket in its tree, and macOS caps such a path at 104 bytes.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-e2e-'))
  const bin = path.join(root, 'bin')
  const gates = path.join(root, 'gates')
  fs.mkdirSync(bin)
  fs.mkdirSync(gates)
  for (const part of [process.execPath, FAKE_DOCKER]) if (part.includes("'")) throw new Error(`a path the wrapper cannot quote: ${part}`)
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_DOCKER}' "$@"\n`, { mode: 0o755 })
  const registry = path.join(root, 'registry.json')
  fs.writeFileSync(registry, '{}')
  process.on('exit', () => {
    // COLLOQ_E2E_KEEP=1 keeps the machines' trees, logs and docker calls for a look after a red run.
    if (process.env.COLLOQ_E2E_KEEP) {
      process.stderr.write(`# remote-e2e: the machines' trees are kept in ${root}\n`)
      return
    }
    // After killLive (registered first): a child SIGKILLed a moment ago may still be closing a file in here.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch { /* a temporary folder left behind is no failure of the test */ }
  })
  return { root, bin, registry, gates }
}

/** A kernel in the fleet's registry: what its pull brings, and the pin home records for it. */
export function publishKernel(fleet: Fleet, ref: string, diffIds: string[]): { ref: string; layers: string } {
  const registry = JSON.parse(fs.readFileSync(fleet.registry, 'utf8')) as Record<string, { diffIds: string[] }>
  registry[ref] = { diffIds }
  fs.writeFileSync(`${fleet.registry}.tmp`, JSON.stringify(registry))
  fs.renameSync(`${fleet.registry}.tmp`, fleet.registry)
  return { ref, layers: layersFingerprint('linux', 'amd64', diffIds) }
}

/** Let the notebooks waiting on `name` finish (their next status look sees it). */
export function openGate(fleet: Fleet, name: string): void {
  fs.writeFileSync(path.join(fleet.gates, name), '')
}

/* ----------------------------------------------------------- another build */

/**
 * A copy of main.ts that reports `build` (see the header): byte for byte the
 * entry, in a tree whose every relative import is a link to the real module.
 */
function entryWithBuild(fleet: Fleet, build: string): string {
  const source = fs.readFileSync(ENTRY, 'utf8')
  const dir = path.join(fleet.root, `build-${build.slice(0, 8)}`, 'server', 'src', 'runner-agent')
  fs.mkdirSync(dir, { recursive: true })
  const copy = path.join(dir, 'main.ts')
  fs.writeFileSync(copy, source)
  fs.writeFileSync(path.join(dir, 'runner.sha256'), `${build}  runner.js\n`)
  const imports = [...source.matchAll(/from '(\.\.?\/[^']+)\.js'/g)].map((match) => match[1]!)
  if (imports.length === 0) throw new Error('main.ts imports no module of its own: the copy cannot be what it was')
  for (const relative of imports) {
    const target = path.resolve(path.dirname(ENTRY), `${relative}.ts`)
    const link = path.resolve(dir, `${relative}.ts`)
    if (!fs.existsSync(target)) throw new Error(`main.ts imports ${relative}, which is not ${target}`)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    if (!fs.existsSync(link)) fs.symlinkSync(target, link)
  }
  return copy
}

/* -------------------------------------------------------------- one machine */

export interface DockerCall {
  at: number
  args: string[]
}

export interface FakeContainer {
  id: string
  name: string
  image: string
  labels: string[]
  attemptId: string
  directive: Record<string, unknown>
  startedAt: number
  killed: boolean
  killedAt: number | null
}

/** A class container as the fake docker keeps it (tests/_remote-e2e-docker.mjs · classRun). */
export interface FakeClassContainer {
  kind: 'class'
  id: string
  name: string
  image: string
  labels: string[]
  env: Record<string, string>
  mounts: Array<{ source: string; target: string; readOnly: boolean }>
  network: string
  memoryMb: number
  cpus: number
  token: string
  /** The class folder on the machine: the fake Jupyter's folder. */
  folder: string
  status: 'created' | 'running' | 'exited'
  /** Its Jupyter's process while it runs. */
  pid: number | null
  /** Its Jupyter's port on 127.0.0.1: `docker port … 8888/tcp`. */
  port: number | null
  startedAt: number | null
  exitCode: number
  oomKilled: boolean
  /** How many times `docker start` gave it a fresh process. */
  restarts: number
  /** What the census reads of it (`stats`, the cgroup's counters); an idle kernel's when unset. */
  stats?: { usedMb?: number; cpuPercent?: number; peakMb?: number; cardMb?: number }
}

/** How the fake daemon misbehaves (tests/_remote-e2e-docker.mjs, KNOBS). */
export interface DockerKnobs {
  perimeter: 'ok' | 'fail' | 'no-iptables' | 'no-dockerd'
  canary: 'ok' | 'fail'
  classRun: { failure: 'memory' | 'cpu' | 'gpu' | 'other'; times: number } | null
  update: 'ok' | 'refuse'
  networkOverlap: boolean
}

/** A class container's fake Jupyter, through its own doors (tests/_fake-jupyter.mjs · the header). */
export interface FakeJupyterDoor {
  url: string
  token: string
  calls(): Promise<Array<{ kind: string; [field: string]: unknown }>>
  kernels(): Promise<Array<{ id: string; path: string; alive: boolean; busy: boolean; count: number; guarded: boolean; online: number }>>
  requests(): Promise<Array<{ code: string; store_history?: boolean; silent?: boolean }>>
  /** Let cells waiting at `HOLD name` go on: how many did. */
  release(name?: string): Promise<number>
  knobs(asked: { holdKernelInfo?: boolean; slowRevival?: boolean; upgradeDelayMs?: number; refuseUpgrades?: number; holdInterrupts?: boolean; restarts?: 'normal' | 'unanswered' | 'ignored' | 'held' }): Promise<Record<string, unknown>>
}

export interface AgentOptions {
  /** COLLOQ_RUNNER_JOIN: `http://127.0.0.1:<port>#<code>`. */
  join: string
  /** Another build than the sources' `dev` (a 64-hex digest). */
  build?: string
  /**
   * A class machine's agent: an image of its own in its fake docker,
   * RUNNER_IMAGE, named by COLLOQ_RUNNER_IMAGE — what the perimeter's helper
   * runs from (kernels.ts · helperImage) when the agent has no container of
   * its own. The 0.23 scenarios start agents without it, as before.
   */
  classes?: boolean
  /** The agent's own container (COLLOQ_RUNNER_CONTAINER), seeded running in its fake docker with this network mode (`host`, as colloq-host starts it). */
  container?: { network: string }
  /** The machine's own settings (COLLOQ_ROOM_NETWORK, KERNEL_BLOCKED_CIDRS, KERNEL_ROOM_SUBNET, …), added to the agent's environment. */
  env?: Record<string, string>
}

/** The image a class machine's agent runs as, in its fake docker: the perimeter's helper runs from it. */
export const RUNNER_IMAGE = 'colloq-runner:e2e'

/** One machine: its tree, its fake Docker, and the agent process when it runs. */
export class Agent {
  readonly dir: string
  readonly root: string
  readonly dockerState: string
  readonly logFile: string
  readonly lines: string[] = []
  child: ChildProcess | null = null
  private readonly entry: string
  private exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null

  constructor(readonly fleet: Fleet, readonly name: string, readonly options: AgentOptions) {
    this.dir = path.join(fleet.root, name)
    this.root = path.join(this.dir, 'state')
    this.dockerState = path.join(this.dir, 'docker')
    this.logFile = path.join(this.dir, 'agent.log')
    // A machine is its tree: a second one on the same tree would be the first one again, with its identity.
    if (fs.existsSync(this.dir)) throw new Error(`a machine called ${name} exists already in ${fleet.root}`)
    // The image's entry point makes the tree before the agent starts (deploy/vast/entrypoint.sh · prepare_as_root): the agent's socket goes in it.
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.dockerState, { recursive: true })
    fs.mkdirSync(path.join(this.dir, 'home'), { recursive: true })
    this.entry = options.build ? entryWithBuild(fleet, options.build) : ENTRY
    if (options.classes || options.container) this.seedRunner()
    machines.add(this)
  }

  /**
   * The agent's own image (RUNNER_IMAGE) in the fake docker, and its own
   * container when it has one: what a machine's daemon holds before its agent
   * starts, as colloq-host leaves it.
   */
  private seedRunner(): void {
    const images = path.join(this.dockerState, 'images')
    const containers = path.join(this.dockerState, 'containers')
    fs.mkdirSync(images, { recursive: true })
    fs.mkdirSync(containers, { recursive: true })
    const id = `sha256:${createHash('sha256').update(`${RUNNER_IMAGE} of ${this.name}`).digest('hex')}`
    fs.writeFileSync(path.join(images, `${encodeURIComponent(RUNNER_IMAGE)}.json`), JSON.stringify({ id, diffIds: [], repoDigests: [], tags: [RUNNER_IMAGE] }))
    if (!this.options.container) return
    fs.writeFileSync(path.join(containers, `${encodeURIComponent(this.ownContainer)}.json`), JSON.stringify({
      kind: 'seed', id: randomBytes(32).toString('hex'), name: this.ownContainer, image: RUNNER_IMAGE, imageId: id, labels: [],
      network: this.options.container.network, status: 'running', startedAt: Date.now(), memoryMb: 0, cpus: 0,
    }))
  }

  /** The agent's own container's name, when it has one (COLLOQ_RUNNER_CONTAINER). */
  get ownContainer(): string {
    return `colloq-runner-${this.name}`
  }

  /** The environment of the agent and of its fake docker: built from nothing (see the header). */
  private environment(): NodeJS.ProcessEnv {
    return {
      ...this.options.env,
      PATH: `${this.fleet.bin}:/usr/bin:/bin`,
      HOME: path.join(this.dir, 'home'),
      TMPDIR: os.tmpdir(),
      LANG: 'en_US.UTF-8',
      NODE_ENV: 'development',
      COLLOQ_RUNNER_JOIN: this.options.join,
      COLLOQ_RUNNER_STATE: this.root,
      DATA_DIR: path.join(this.root, 'data'),
      ...(this.options.container ? { COLLOQ_RUNNER_CONTAINER: this.ownContainer } : this.options.classes ? { COLLOQ_RUNNER_IMAGE: RUNNER_IMAGE } : {}),
      FAKE_DOCKER_STATE: this.dockerState,
      FAKE_DOCKER_REGISTRY: this.fleet.registry,
      FAKE_DOCKER_GATES: this.fleet.gates,
      FAKE_DOCKER_HOST: this.name,
      // The class containers' processes end once the test's is gone, however it went.
      FAKE_DOCKER_OWNER: String(process.pid),
    }
  }

  /** Start the agent (again, after a kill: the same tree, the same identity). */
  start(): void {
    if (this.running) throw new Error(`${this.name} is running already`)
    const env = this.environment()
    const child = spawn(process.execPath, ['--import', 'tsx', this.entry], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    live.add(child)
    const keep = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      fs.appendFileSync(this.logFile, text)
      for (const line of text.split('\n')) if (line.trim()) this.lines.push(line)
    }
    child.stdout!.on('data', keep)
    child.stderr!.on('data', keep)
    this.exited = new Promise((resolve) => child.once('exit', (code, signal) => {
      live.delete(child)
      fs.appendFileSync(this.logFile, `--- exited: code ${code} signal ${signal}\n`)
      resolve({ code, signal })
    }))
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  /** SIGKILL, as a machine dies: nothing handed back, the containers left running. */
  async kill(): Promise<void> {
    if (!this.running) return
    process.kill(this.child!.pid!, 'SIGKILL')
    await this.exited
  }

  /** The exit of a process that ends by itself (a revoked machine): its code, or a kill after `timeoutMs`. */
  async exit(timeoutMs = 15_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!this.exited) throw new Error(`${this.name} never started`)
    const timer = setTimeout(() => void this.kill(), timeoutMs)
    try {
      return await this.exited
    } finally {
      clearTimeout(timer)
    }
  }

  /** The agent's log so far, for a failure's message. */
  log(): string {
    return this.lines.slice(-60).join('\n')
  }

  /** runner.json: who this machine is to its home. */
  identity(): { runnerId?: string; home?: string; trusted?: boolean } | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, 'runner.json'), 'utf8'))
    } catch {
      return null
    }
  }

  get runnerId(): string {
    const id = this.identity()?.runnerId
    if (!id) throw new Error(`${this.name} has not joined:\n${this.log()}`)
    return id
  }

  /** The machine's credential as its tunnel sends it, `Bearer cr1.<id>.<secret>` (sync.ts · tunnelWant), from runner.json. */
  authorization(): string {
    const identity = this.identity() as { runnerId?: string; secret?: string } | null
    if (!identity?.runnerId || !identity.secret) throw new Error(`${this.name} has not joined:\n${this.log()}`)
    return `Bearer ${remoteCredential(identity.runnerId, identity.secret)}`
  }

  /** The agent's INSTANCE_LABEL, as images.ts derives it from its DATA_DIR: the label its class containers carry. */
  get instanceLabel(): string {
    return `ru.colloq.competition-instance=${createHash('sha256').update(path.resolve(path.join(this.root, 'data'))).digest('hex').slice(0, 16)}`
  }

  /** status.json, as `runner status` reads it. */
  status(): Record<string, unknown> | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, 'status.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /** The leases written down in its tree (leases/<attempt>.json, without the outcomes). */
  leaseFiles(): string[] {
    try {
      return fs.readdirSync(path.join(this.root, 'leases')).filter((name) => /^[a-f0-9]{32}\.json$/.test(name)).map((name) => name.slice(0, 32))
    } catch {
      return []
    }
  }

  /** Whether the run's outcome is written down (leases/<attempt>.outcome.json): what a restart uploads again. */
  hasOutcome(attemptId: string): boolean {
    return fs.existsSync(path.join(this.root, 'leases', `${attemptId}.outcome.json`))
  }

  /** Whether the attempt's tree is still on the machine. */
  holdsAttemptTree(competitionId: string, submissionId: string, attemptId: string): boolean {
    return fs.existsSync(path.join(this.root, 'data', 'competitions', competitionId, 's', submissionId, 'attempts', attemptId))
  }

  /** The hidden test's blobs in its cache (cache.ts · .sealed/). */
  sealedBlobs(): string[] {
    try {
      return fs.readdirSync(path.join(this.root, 'data', 'competitions', '.sealed')).filter((name) => /^[a-f0-9]{64}$/.test(name))
    } catch {
      return []
    }
  }

  /** Every docker call this machine made, oldest first. */
  dockerCalls(): DockerCall[] {
    try {
      return fs.readFileSync(path.join(this.dockerState, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as DockerCall)
    } catch {
      return []
    }
  }

  /** Every container its fake Docker holds now: submissions', class ones, the agent's own. */
  private allContainers(): Array<{ kind?: string }> {
    const dir = path.join(this.dockerState, 'containers')
    try {
      return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { kind?: string }]
        } catch {
          return []
        }
      })
    } catch {
      return []
    }
  }

  /** The submission containers its fake Docker holds now. */
  containers(): FakeContainer[] {
    return this.allContainers().filter((c) => c.kind === undefined) as unknown as FakeContainer[]
  }

  /** The class containers its fake Docker holds now, whatever their state. */
  classContainers(): FakeClassContainer[] {
    return this.allContainers().filter((c) => c.kind === 'class') as FakeClassContainer[]
  }

  /** The class container of one slot, by its labels (colloq.session, colloq.role); null — none. */
  classContainer(sessionId: string, role: 'room' | 'own' | 'council'): FakeClassContainer | null {
    return this.classContainers().find((c) => c.labels.includes(`colloq.session=${sessionId}`) && c.labels.includes(`colloq.role=${role}`)) ?? null
  }

  /** A docker call on this machine's daemon, as its agent makes one (runner-agent/docker.ts · realDocker): the exit code and all it printed. */
  docker(argv: string[]): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(path.join(this.fleet.bin, 'docker'), argv, { env: this.environment(), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
      child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
      child.once('error', (error) => resolve({ code: -1, out: String(error) }))
      child.once('close', (code) => resolve({ code: code ?? -1, out: out.trim() }))
    })
  }

  /** How this machine's daemon misbehaves from now on (the fake docker's KNOBS): the fields given, the others as they were. */
  dockerKnobs(asked: Partial<DockerKnobs>): void {
    const file = path.join(this.dockerState, 'knobs.json')
    let knobs: Partial<DockerKnobs> = {}
    try {
      knobs = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DockerKnobs>
    } catch { /* none yet */ }
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...knobs, ...asked }))
    fs.renameSync(`${file}.tmp`, file)
  }

  /** What the census reads of a class container from now on (`docker stats`, the cgroup's counters). */
  classStats(name: string, stats: NonNullable<FakeClassContainer['stats']>): void {
    const file = path.join(this.dockerState, 'containers', `${encodeURIComponent(name)}.json`)
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as FakeClassContainer
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...c, stats: { ...c.stats, ...stats } }))
    fs.renameSync(`${file}.tmp`, file)
  }

  /**
   * A class container dies under its kernels (`docker kill`, as a crash or
   * the host's OOM killer leaves it), docker's OOMKilled set when `oom`: what
   * the census then finds, reads for home's post-mortem and starts again.
   */
  async killClassContainer(name: string, options: { oom?: boolean } = {}): Promise<void> {
    const killed = await this.docker(['kill', name])
    if (killed.code !== 0) throw new Error(`${this.name}: docker kill ${name}: ${killed.out}`)
    if (!options.oom) return
    const file = path.join(this.dockerState, 'containers', `${encodeURIComponent(name)}.json`)
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as FakeClassContainer
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...c, oomKilled: true }))
    fs.renameSync(`${file}.tmp`, file)
  }

  /** A class container's fake Jupyter, through its own doors, where docker publishes it. */
  jupyterOf(c: FakeClassContainer): FakeJupyterDoor {
    if (c.port === null) throw new Error(`${c.name} publishes no port: it does not run`)
    const url = `http://127.0.0.1:${c.port}`
    const json = async <T,>(method: string, at: string, body?: unknown): Promise<T> => {
      const answer = await fetch(`${url}/_fake/${at}`, { method, body: body === undefined ? undefined : JSON.stringify(body) })
      if (!answer.ok) throw new Error(`${c.name}: ${method} /_fake/${at}: ${answer.status}`)
      return (await answer.json()) as T
    }
    return {
      url,
      token: c.token,
      calls: () => json('GET', 'calls'),
      kernels: () => json('GET', 'kernels'),
      requests: () => json('GET', 'requests'),
      release: async (name = '') => (await json<{ released: number }>('POST', `release/${encodeURIComponent(name)}`)).released,
      knobs: (asked) => json('POST', 'knobs', asked),
    }
  }

  /** The submission containers ever started here (`docker run` of a notebook). */
  sandboxRuns(): DockerCall[] {
    return this.dockerCalls().filter((call) => call.args[0] === 'run' && call.args.includes('/harness/run_notebook.py'))
  }

  /** An image gone from this machine's store (an operator's `docker image prune`), as the agent will find it. */
  dropImage(name: string): void {
    fs.rmSync(path.join(this.dockerState, 'images', `${encodeURIComponent(name)}.json`), { force: true })
  }

  hasImage(name: string): boolean {
    return fs.existsSync(path.join(this.dockerState, 'images', `${encodeURIComponent(name)}.json`))
  }
}
