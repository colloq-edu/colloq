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
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { layersFingerprint } from '../server/src/dependencies/image-identity.ts'

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

process.on('exit', killLive)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    killLive()
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

export interface AgentOptions {
  /** COLLOQ_RUNNER_JOIN: `http://127.0.0.1:<port>#<code>`. */
  join: string
  /** Another build than the sources' `dev` (a 64-hex digest). */
  build?: string
}

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
  }

  /** Start the agent (again, after a kill: the same tree, the same identity). */
  start(): void {
    if (this.running) throw new Error(`${this.name} is running already`)
    const env: NodeJS.ProcessEnv = {
      PATH: `${this.fleet.bin}:/usr/bin:/bin`,
      HOME: path.join(this.dir, 'home'),
      TMPDIR: os.tmpdir(),
      LANG: 'en_US.UTF-8',
      NODE_ENV: 'development',
      COLLOQ_RUNNER_JOIN: this.options.join,
      COLLOQ_RUNNER_STATE: this.root,
      DATA_DIR: path.join(this.root, 'data'),
      FAKE_DOCKER_STATE: this.dockerState,
      FAKE_DOCKER_REGISTRY: this.fleet.registry,
      FAKE_DOCKER_GATES: this.fleet.gates,
      FAKE_DOCKER_HOST: this.name,
    }
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

  /** The submission containers its fake Docker holds now. */
  containers(): FakeContainer[] {
    const dir = path.join(this.dockerState, 'containers')
    try {
      return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as FakeContainer]
        } catch {
          return []
        }
      })
    } catch {
      return []
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
