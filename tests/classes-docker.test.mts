/**
 * Classes on machines («занятия на машинах») on Linux with real Docker: the
 * parity job (docs/architecture/remote-classes.md §17.3), run by
 * .github/workflows/classes-smoke.yml with COLLOQ_CLASSES_DOCKER_TEST=1 and
 * skipped everywhere else, `npm test` included: nothing here touches a docker
 * daemon unless that variable says so.
 *
 * WHAT IS REAL. Home is the app of this process with its tunnel door
 * (tests/_remote-e2e-home.mts) on KERNEL_BACKEND=test: it starts no room of its
 * own, so its daemon holds no Colloq home (D20) and no chains beside the
 * agent's. The machine is the agent from the checkout
 * (server/src/runner-agent/main.ts, unmodified, its own timings: main.ts's
 * own main(), told only that the host has AGENT_CPUS cores, AGENT_ENTRY) in a
 * container of its own as colloq-host runs one: on the host's network
 * (D19, read from its own HostConfig), as uid 1000 with the docker socket's
 * group (deploy/vast/entrypoint.sh · drop_to_app), its tree at the same path
 * on the host and handed to uid 1000 first (prepare_runner_as_root), the
 * perimeter's helper run from its own image by id. Its docker is the real CLI
 * against the real daemon, and the class runs colloq-kernel:base, the real
 * jupyter_server and ipykernel, from a pinned ref the agent checks by its
 * layers as it checks any (images.ts). Between them the fault proxy
 * (tests/_tunnel-fault.mts) stands where relay2 does. The machines' clock runs
 * as index.ts runs it (runTheClock): a pass every five seconds with the
 * classes' clock in it, and home's probe of its own path through the proxy,
 * so a class fails over by the rules of §11.1 as it would in a classroom.
 * The test's own docker calls go to the daemon the agent mounts, whatever
 * context the CLI would pick (DOCKER_ENV).
 *
 * THE IMAGE'S REF. A machine runs only portable revisions (D22): a ref
 * `repo@sha256:…` and a layer fingerprint. A local build has a digest of its
 * own only in the containerd image store, which lists it as
 * `colloq-kernel@sha256:…` (dependencies/image-identity.ts · registryRefOf,
 * with this repository preferred, as KERNEL_IMAGE_REPO would name it); the
 * workflow keeps the daemon's images there. The revision is noted at home
 * with that ref and those layers, as revisions.ts notes one it captured.
 *
 * WHAT IS PINNED, beside what the scenarios show through their people's doors
 * (the room's document, the control socket, the owner's list):
 *   - jupyter_server's facts the design relies on, each an assertion with a
 *     comment: a kernel process stamps one id on its replies
 *     (`header.session`), whichever socket and session_id ask, and a restart
 *     stamps another (K3c · settleRestart);
 *     a reconnect under the same session_id is answered after the buffer is
 *     replayed (§5.5), on a channel of the test's own and through the product
 *     after a cut; and the kernel WebSocket's ping timeout: a cut longer than
 *     it closes the inner channel, its number and what the resumed stream
 *     brings are recorded (t.diagnostic lines in the job's output, and
 *     facts.txt beside the kept logs).
 *   - the sandbox as the daemon holds it: the room container's user, caps,
 *     limits, network, published port, labels and mount; the agent's bridge;
 *     its chains in the host's iptables; the admission canary's verdict.
 *   - the files both ways on Linux: uid 1000 and the modes 2775/0664 a copy
 *     is made with, the anchored walk through /proc/self/fd (links never
 *     travel), a kernel's 16 TiB of holes kept «на машине» unread (ext4),
 *     and 520 more whose lengths add up past Number.MAX_SAFE_INTEGER, said
 *     clamped (room-files.ts · clampBytes) with no sync refused for them.
 *   - the council on the machine (§9, 0.26): an epoch of real pandas, numpy,
 *     a fitted model and a notebook function exported by the class
 *     notebook's kernel there, copied out by the agent and loaded into four
 *     workers; copy-on-write isolation (each attempt's array and frame in a
 *     mapping of the epoch's files, never a copy of them; a worker's
 *     in-place writes reach neither its neighbours nor its own next attempt
 *     nor the epoch's files, and reading the whole frame writes nothing of a
 *     worker's own); a worker recycled once its attempts left it more than
 *     «Память на попытку» over its seed, as smaps_rollup says it, and not
 *     before; oom_score_adj 1000 in the workers and not in jupyter_server;
 *     each attempt's own RLIMIT_AS; a greedy attempt's MemoryError its
 *     author's alone; the council container held to what §9.5 says; the
 *     artifacts, the read-only class folder and the scratch root as uid
 *     1000's workers find it (1733, unlistable, and not theirs to change);
 *     the drop run on a real kernel. The workers' memory (smaps_rollup),
 *     their limits and the container's cgroup are recorded for §17.5's R2
 *     rows (COUNCIL_WORKER_BASE_MB is an estimate).
 *
 * WAITS ARE FOR EVENTS, each with its bound, and a scenario out of time stops
 * at its next wait (scenario): afterEach lets it stop before it heals the
 * relay or starts an agent, so it never runs on beside the next scenario. The
 * one wall-clock wait aligns the long cut with jupyter_server's ping timer
 * (see the scenario).
 *
 * WHAT IT MADE IT REMOVES, by its own names and labels, and then checks it is
 * gone (Machine · leftovers): the agent's container (colloq.test.run), every
 * container and network of the agent's tree (its INSTANCE_LABEL), its chains
 * (the removal script of its own perimeter), the revision's tag the agent
 * made, and the tree (as root: its files are uid 1000's). With
 * COLLOQ_CLASSES_DOCKER_LOGS set, the logs are kept there for the workflow's
 * artifact as the run goes: home's lines and the facts every LOG_FLUSH_MS and
 * after each scenario, each agent life's log as it ends and after each
 * scenario, each class container's as its class ends, and what a scenario
 * out of time was waiting for (waits.log).
 */
import './_remote-e2e-home.mts'
import { after, afterEach, before, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocket, type RawData } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import type { Response as ExpressResponse } from 'express'
import { tr } from '../shared/i18n.js'
import { STAFF_COOKIE, type ClassPlacement, type RunningClass, type RunningKernels } from '../shared/admin.js'
import type { ControlClientMessage, ControlServerMessage, CouncilMine, CouncilPool, CouncilRun, CouncilSettings, FileEntry, JoinResponse } from '../shared/protocol.js'
import type { RunningClassMachines } from '../shared/remote-admin.js'
import { CLASS_PROBE_MS, COUNCIL_EPOCH_DIR, COUNCIL_EPOCHS_MOUNT, COUNCIL_SCRATCH_MOUNT, COUNCIL_WORKER_BASE_MB, type RemoteFilesLag } from '../shared/remote-kernels.js'
import { REMOTE_API_BASE, REMOTE_BOOT_GRACE_MS } from '../shared/remote-runner.js'
import { TUNNEL_DEAD_MS, TUNNEL_RESUME_MS } from '../shared/remote-tunnel.js'
import { CELLS_KEY, bookCells, bookKernel, cellId, createCell, getTerminal, readCell, readTerminalLine, type YCell } from '../shared/notebook.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { classPathEvidence, heardAt, inBootGrace } from '../server/src/competitions/remote/heard.js'
import { probeTick } from '../server/src/competitions/remote/liveness.js'
import { listRunners, mintRemoteCode, runnerEventsOf } from '../server/src/competitions/remote/store.js'
import { imageIdentity } from '../server/src/dependencies/image-identity.js'
import { noteRevisionImage, putRevision } from '../server/src/dependencies/store.js'
import { jupyterSessionPath } from '../server/src/kernel/jupyter.js'
import { BLOCKED_V4, helperArgs, machinePerimeter, perimeterRemovalScript, type MachinePerimeter } from '../server/src/kernel/perimeter-core.js'
import { CLASS_KERNEL_LABEL, PLACEMENT_LABEL, classHashSeed, machineRoomContainer } from '../server/src/kernel/room-spec.js'
import { exportDropExpression } from '../server/src/kernel/council-isolation.js'
import { artifactPath, epochFileList, epochsOf } from '../server/src/kernel/remote/epochs.js'
import { placementOutlook } from '../server/src/kernel/remote/placement.js'
import { classPlacement, livePlacement, placementRow } from '../server/src/kernel/remote/placement-store.js'
import { ClassFiles, useClassFiles } from '../server/src/kernel/remote/files.js'
import { shutdownKernels } from '../server/src/kernel/index.js'
import { terminalPhase } from '../server/src/kernel/terminal.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { sessionDir, writeText, type FileTree } from '../server/src/workspace.js'
import { CHECK_LABEL, REVISION_TAG } from '../server/src/runner-agent/images.js'
import { parsePort } from '../server/src/runner-agent/kernels.js'
import { KERNEL_UID } from '../server/src/runner-agent/room-files.js'
import { Home, sha256, sleep } from './_remote-e2e-home.mts'
import { TunnelFault } from './_tunnel-fault.mts'

const enabled = process.env.COLLOQ_CLASSES_DOCKER_TEST === '1'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(REPO, 'server/src/runner-agent/main.ts')
/*
 * The cores the agent is told its host has. A hosted runner has four, and a
 * machine keeps one for itself (machine.ts · freeCapacity): a class's room
 * (a core) and its council's pool of four workers (a core each, §9.5) would
 * not fit beside each other, though docker gives each container the quota
 * it asks whatever the agent counts (`--cpus` up to the host's four). Only
 * the agent's arithmetic changes; the sandbox, the limits and the timings are
 * its own.
 */
const AGENT_CPUS = 8
/** The agent's entry: main.ts's own main(), run as `node --import tsx` runs it, with the machine's picture its seam (sync.ts · AgentOptions.machine). */
const AGENT_ENTRY = [
  `const { main } = await import(${JSON.stringify(ENTRY)})`,
  `const { readMachine } = await import(${JSON.stringify(path.join(REPO, 'server/src/runner-agent/machine.ts'))})`,
  `const machine = () => ({ ...readMachine(process.env.COLLOQ_RUNNER_STATE), cpus: ${AGENT_CPUS} })`,
  "process.exit(await main(['run'], process.env, undefined, { machine }))",
].join('\n')
/** The class environment's image, built as runtime-smoke.yml builds it. */
const KERNEL_IMAGE = 'colloq-kernel:base'
/** The repository a local build's digest is listed under (the containerd store): the one this run prefers, as KERNEL_IMAGE_REPO would. */
const KERNEL_REPO = 'colloq-kernel'
/** The agent's own image: the workflow's (Node 22 and the docker CLI). */
const AGENT_IMAGE = 'colloq-runner:classes-smoke'
/** The system daemon's socket, mounted into the agent's container as colloq-host mounts it. */
const SOCKET = '/var/run/docker.sock'
const RUN = randomBytes(4).toString('hex')
/** Every container of this file's own carries both: the agent's, and the throwaway ones it runs to make and remove the tree. */
const TEST_LABEL = 'colloq.test=classes-docker'
const RUN_LABEL = `colloq.test.run=${RUN}`
/** Where the job's logs go (COLLOQ_CLASSES_DOCKER_LOGS); none kept without it. */
const LOGS = process.env.COLLOQ_CLASSES_DOCKER_LOGS?.trim() || null
/** jupyter_server's kernel WebSocket ping, WS_PING_INTERVAL: only to line the long cut up with its timer, never asserted. */
const PING_INTERVAL_GUESS_MS = 30_000
/** The door a machine's every sync comes through (competitions/remote/routes.ts · POST /sync). */
const SYNC_PATH = `${REMOTE_API_BASE}/sync`
/** The machines' clock passes this often in production (liveness.ts · TICK_MS). */
const CLOCK_PASS_MS = 5_000
/** Home's lines and the facts are written whole again this often while the file runs (COLLOQ_CLASSES_DOCKER_LOGS). */
const LOG_FLUSH_MS = 15_000
/** How long a scenario out of time may take to reach its next wait and stop: a docker call's own bound, and a little. */
const BODY_STOP_MS = 150_000

/* ------------------------------------------------------------------ docker */

interface Ran {
  code: number
  stdout: string
  stderr: string
}

/**
 * The environment of the test's own docker CLI: the daemon the agent mounts,
 * whatever context the CLI would pick otherwise (an explicit DOCKER_HOST
 * outranks DOCKER_CONTEXT and `docker context use`), so that what this file
 * inspects and removes is on the daemon the classes run on.
 */
const DOCKER_ENV: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: `unix://${SOCKET}` }
delete DOCKER_ENV.DOCKER_CONTEXT

/** The real docker CLI, as the test's own hand: the exit code (-1 for a timeout or no CLI) and what it printed. */
function docker(args: readonly string[], timeoutMs = 120_000): Promise<Ran> {
  return new Promise((resolve) => {
    execFile('docker', [...args], { env: DOCKER_ENV, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function dockerOk(args: readonly string[], timeoutMs?: number): Promise<Ran> {
  const ran = await docker(args, timeoutMs)
  if (ran.code !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')}: exit ${ran.code}: ${(ran.stderr || ran.stdout).trim().slice(-2000)}`)
  return ran
}

/** `docker inspect` of one object, parsed; null — docker knows no such one. */
async function inspectOf<T = Record<string, unknown>>(name: string, type: 'container' | 'network' | 'image' = 'container'): Promise<T | null> {
  const asked = await docker(type === 'network' ? ['network', 'inspect', name] : ['inspect', '--type', type, name])
  if (asked.code !== 0) return null
  const parsed = JSON.parse(asked.stdout) as T[]
  return parsed[0] ?? null
}

/**
 * A container's log, both of its streams in the order they were written
 * (`--timestamps`, RFC 3339 in UTC, which sorts as text): each line with
 * when docker took it. None for a container docker no longer knows.
 */
async function logsOf(container: string): Promise<Array<{ at: number; text: string }>> {
  const asked = await docker(['logs', '--timestamps', container])
  if (asked.code !== 0) return []
  return `${asked.stdout}\n${asked.stderr}`.split('\n').filter((line) => line.trim()).sort().map((line) => {
    const space = line.indexOf(' ')
    // Nanoseconds as docker writes them; Date reads milliseconds.
    const at = Date.parse(line.slice(0, space).replace(/(\.\d{3})\d*/, '$1'))
    return { at: Number.isFinite(at) ? at : 0, text: line.slice(space + 1) }
  })
}

const textOf = (lines: ReadonlyArray<{ text: string }>): string => lines.map((line) => line.text).join('\n')

/** A file of the job's logs, appended to (COLLOQ_CLASSES_DOCKER_LOGS); nothing without the variable. */
function keepLog(name: string, text: string): void {
  if (!LOGS || !text) return
  fs.mkdirSync(LOGS, { recursive: true })
  fs.appendFileSync(path.join(LOGS, name), text.endsWith('\n') ? text : `${text}\n`)
}

/** A file of the job's logs written whole, as far as it has come (an agent life's, home's lines); nothing without the variable or the text. */
function saveLog(name: string, text: string): void {
  if (!LOGS || !text) return
  fs.mkdirSync(LOGS, { recursive: true })
  fs.writeFileSync(path.join(LOGS, name), text.endsWith('\n') ? text : `${text}\n`)
}

/** The facts this run measured, in the test's output and in facts.txt. */
const facts: string[] = []

function record(t: TestContext, line: string): void {
  t.diagnostic(line)
  facts.push(line)
}

/* ---------------------------------------------------------------- waiting */

/**
 * The scenario running now, by its async context: its signal, which node:test
 * aborts at the scenario's timeout and which every wait of the scenario's
 * gives up on. Nothing outside a scenario (the hooks) has one.
 */
const scenarioSignal = new AsyncLocalStorage<AbortSignal>()
/** The body of the scenario that ran last, settled or not: afterEach lets it stop before it touches the machine. */
let lastBody: Promise<unknown> = Promise.resolve()

/**
 * A scenario of the file, skipped without COLLOQ_CLASSES_DOCKER_TEST. At its
 * timeout node:test fails it and goes on, while its body runs on: past its
 * next wait it would heal the relay, start an agent or place a class beside
 * the next scenario's. So its waits give up then, and afterEach waits for it.
 */
function scenario(name: string, timeout: number, body: (t: TestContext) => Promise<void>): void {
  test(name, { skip: !enabled, timeout }, (t) => {
    const ran = scenarioSignal.run(t.signal, () => body(t))
    lastBody = ran.catch(() => undefined)
    return ran
  })
}

/**
 * Poll until `check` gives a value, asked at most every `everyMs`, or fail
 * with `what` and what `detail` finds then (a container's log is a docker
 * call away, so it may be a promise). In a scenario out of time it stops at
 * once, and what it waited for goes to waits.log and the job's output: the
 * scenario's failure itself says only that it timed out.
 */
async function waitFor<T>(
  what: string,
  check: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs: number,
  detail: () => string | Promise<string> = () => '',
  everyMs = 100,
): Promise<T> {
  const signal = scenarioSignal.getStore()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) {
      const said = await Promise.resolve(detail()).catch((error: unknown) => `(the detail failed: ${String(error)})`)
      const line = `the scenario ran out of time waiting for ${what}${said ? `\n${said}` : ''}`
      keepLog('waits.log', line)
      console.error(`[classes-docker] ${line}`)
      throw new Error(line)
    }
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) {
      const said = await Promise.resolve(detail()).catch((error: unknown) => `(the detail failed: ${String(error)})`)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${said ? `\n${said}` : ''}`)
    }
    await sleep(everyMs)
  }
}

/** Seconds, to a tenth, for the facts. */
const seconds = (ms: number): string => (ms / 1000).toFixed(1)

/* --------------------------------------------------------------- the machine */

/**
 * The class machine: its tree on the host, and its agent's container. A new
 * container on the same tree, under the same name, is the same machine's
 * next agent life (the identity is in the tree), as `colloq-host runner up`
 * makes it after the old one was killed.
 */
class Machine {
  /** As colloq-host names its own `colloq-runner`, this run's. */
  readonly name = `colloq-runner-parity-${RUN}`
  readonly root: string
  readonly tree: string
  /** The agent's INSTANCE_LABEL (runner-agent/images.ts: a hash of its DATA_DIR as the daemon sees it): what its containers carry. */
  readonly instanceLabel: string
  /** Its bridge, chains and tag (perimeter-core.ts · machinePerimeter). */
  readonly scope: MachinePerimeter
  join = ''
  /** How many times its agent was started. */
  lives = 0
  /** The container of this life (docker's id): its log is read by it, never by the name the next life takes over. */
  id = ''

  constructor(base: string) {
    this.root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'colloq-cd-')))
    this.tree = path.join(this.root, 'm')
    this.instanceLabel = `ru.colloq.competition-instance=${createHash('sha256').update(path.resolve(path.join(this.tree, 'data'))).digest('hex').slice(0, 16)}`
    this.scope = machinePerimeter(this.instanceLabel)
  }

  /** The tree made and handed to uid 1000, as the image's entry point does before it drops to that uid (prepare_runner_as_root). */
  async prepare(): Promise<void> {
    await dockerOk(['run', '--rm', '--network', 'none', '--user', '0:0', '--label', TEST_LABEL, '--label', RUN_LABEL, '-v', `${this.root}:${this.root}`,
      '--entrypoint', 'sh', AGENT_IMAGE, '-c', `mkdir -p "$1" && chown ${KERNEL_UID}:${KERNEL_UID} "$1" && chmod 0700 "$1"`, 'sh', this.tree])
  }

  /** The agent started, in its container on the host's network: colloq-host's `docker run` of it, with the entry point's environment (entrypoint.sh · runner). */
  async start(): Promise<void> {
    this.lives++
    this.id = ''
    const group = fs.statSync(SOCKET).gid
    const ran = await dockerOk([
      'run', '-d', '--name', this.name, '--network', 'host', '--stop-timeout', '90',
      '--user', `${KERNEL_UID}:${KERNEL_UID}`, '--group-add', String(group),
      '--label', TEST_LABEL, '--label', RUN_LABEL,
      '-v', `${SOCKET}:${SOCKET}`, '-v', `${this.tree}:${this.tree}`, '-v', `${REPO}:${REPO}:ro`, '-w', REPO,
      '-e', `COLLOQ_RUNNER_JOIN=${this.join}`, '-e', `COLLOQ_RUNNER_STATE=${this.tree}`, '-e', `DATA_DIR=${path.join(this.tree, 'data')}`,
      '-e', `COLLOQ_RUNNER_CONTAINER=${this.name}`, '-e', `COLLOQ_CONTAINER=${this.name}`, '-e', `COLLOQ_RUNNER_IMAGE=${AGENT_IMAGE}`,
      '-e', 'NODE_ENV=development', '-e', 'KERNEL_BACKEND=docker', '-e', 'COMPETITION_BACKEND=docker',
      '--entrypoint', 'node', AGENT_IMAGE, '--import', 'tsx', '--input-type=module', '-e', AGENT_ENTRY,
    ])
    // What `run -d` prints last is the container's id.
    this.id = ran.stdout.trim().split('\n').at(-1)?.trim() ?? ''
  }

  async running(): Promise<boolean> {
    const asked = await docker(['inspect', '--type', 'container', '--format', '{{.State.Running}}', this.name])
    return asked.code === 0 && asked.stdout.trim() === 'true'
  }

  /** SIGKILL, as a crash or `docker kill colloq-runner` ends an agent: nothing handed back, the class containers left running. Its container goes then. */
  async kill(): Promise<void> {
    await docker(['kill', '--signal', 'KILL', this.name])
    await waitFor('the agent\'s container to stop', async () => !(await this.running()), 60_000)
    await this.remove()
  }

  /** Its container removed, what this life printed kept for the job's logs: a life that ended by itself (a crash, an exit) too. */
  async remove(): Promise<void> {
    await this.keepLife()
    await docker(['rm', '-f', this.name])
  }

  /** What this life printed so far, written whole for the job's logs (agent-<life>.log); nothing once its container is gone. */
  async keepLife(): Promise<void> {
    const { lives, id } = this
    if (id) saveLog(`agent-${lives}.log`, textOf(await logsOf(id)))
  }

  /** What this life printed so far. */
  async log(): Promise<string> {
    return textOf(await logsOf(this.name))
  }

  async tail(lines = 60): Promise<string> {
    return (await this.log()).split('\n').slice(-lines).join('\n')
  }

  /** A command in the agent's container, as the agent's uid. */
  exec(argv: readonly string[]): Promise<Ran> {
    return docker(['exec', this.name, ...argv])
  }

  /** A class's room container on this machine (room-spec.ts · machineRoomContainer). */
  room(sessionId: string): string {
    return machineRoomContainer(this.instanceLabel, sessionId, 'room')
  }

  /** A class's council container on this machine: its pool's workers. */
  council(sessionId: string): string {
    return machineRoomContainer(this.instanceLabel, sessionId, 'council')
  }

  /**
   * Everything the machine made, gone: its container, every container and
   * network of its tree by its INSTANCE_LABEL (the class kernels, the canary
   * and the checks), its chains by its perimeter's own removal script, and
   * the tree, as root, since its files are uid 1000's.
   */
  async dismantle(): Promise<void> {
    if ((await docker(['inspect', '--type', 'container', this.name])).code === 0) await this.remove()
    const ids = async (args: string[]): Promise<string[]> => (await docker(args)).stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    const containers = [...new Set([...await ids(['ps', '-aq', '--filter', `label=${this.instanceLabel}`]), ...await ids(['ps', '-aq', '--filter', `label=${RUN_LABEL}`])])]
    if (containers.length > 0) await docker(['rm', '-f', ...containers])
    const networks = await ids(['network', 'ls', '-q', '--filter', `label=${this.instanceLabel}`])
    if (networks.length > 0) await docker(['network', 'rm', ...networks])
    const removed = await docker(helperArgs(AGENT_IMAGE, perimeterRemovalScript(this.scope)))
    if (!/colloq-perimeter: removed/.test(removed.stdout)) keepLog('teardown.log', `the chains of ${this.scope.chains} were not removed: ${removed.stdout}${removed.stderr}`)
    await docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--label', TEST_LABEL, '--label', RUN_LABEL, '-v', `${this.root}:${this.root}`,
      '--entrypoint', 'rm', AGENT_IMAGE, '-rf', '--', this.tree])
    fs.rmSync(this.root, { recursive: true, force: true })
  }

  /**
   * What the machine made that is still there, one line each: containers and
   * networks by its labels, lines of its chains in the host's filter table,
   * its tree. Every removal of dismantle goes through `docker()`, which never
   * throws, so a teardown that removed nothing would leave a green job and,
   * on a machine of one's own, privileged chains in its host's iptables.
   * Asked through `dockerOk`: a daemon that does not answer fails the check
   * instead of finding nothing left.
   */
  async leftovers(): Promise<string[]> {
    const lines = async (args: string[]): Promise<string[]> => (await dockerOk(args)).stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    const containers = new Set([
      ...await lines(['ps', '-a', '--filter', `label=${this.instanceLabel}`, '--format', '{{.Names}}']),
      ...await lines(['ps', '-a', '--filter', `label=${RUN_LABEL}`, '--format', '{{.Names}}']),
    ])
    const networks = await lines(['network', 'ls', '--filter', `label=${this.instanceLabel}`, '--format', '{{.Name}}'])
    const rules = (await hostRules()).filter((rule) => rule.includes(this.scope.chains))
    return [
      ...[...containers].map((name) => `container ${name}`),
      ...networks.map((name) => `network ${name}`),
      ...rules.map((rule) => `iptables ${rule}`),
      ...(fs.existsSync(this.root) ? [`folder ${this.root}`] : []),
    ]
  }
}

/* ------------------------------------------------------------------ the file */

// The machines' clock is the file's own (runTheClock): on home's clock, as the scenario files run theirs, but at the server's cadence.
const home = new Home({ liveness: 'manual' })
let relay: TunnelFault | null = null
let machine: Machine | null = null
let runnerId = ''
/** The revision the class environment runs on machines, and the tag the agent makes for it. */
let revisionId = ''
/** What the class folders' module said (ClassFiles' log), oldest first. */
const fileLines: string[] = []
/** Every socket a scenario opened: closed at the end of the file, whatever happened. */
const sockets = new Set<WebSocket>()
let dismantled = false
/** Stops the machines' clock (runTheClock); null — not running. */
let stopClock: (() => void) | null = null
let logTimer: NodeJS.Timeout | null = null

const theMachine = (): Machine => {
  if (!machine) throw new Error('the machine was never made')
  return machine
}

/** Home's lines and the facts so far, written whole for the job's logs: every LOG_FLUSH_MS, after each scenario and at the end. */
function keepHomeLogs(): void {
  saveLog('home-tunnels.log', home.tunnelLines.join('\n'))
  saveLog('home-classes.log', home.classLines.join('\n'))
  saveLog('home-files.log', fileLines.join('\n'))
  saveLog('facts.txt', facts.join('\n'))
}

/**
 * THE MACHINES' CLOCK, AS index.ts RUNS IT (liveness.ts · startRemoteRunners,
 * which `liveness: 'manual'` leaves to the test): a pass every CLOCK_PASS_MS
 * with the classes' clock in it — reachability, the failover rules, the
 * prefetch — and a beat of the probe every CLASS_PROBE_MS (liveness.ts ·
 * probeTick: never two at once, every CLASS_PROBE_MS while a class placement
 * lives). The probe of home's own path goes through the relay, as
 * production's goes through relay2 (Home · probe), so path evidence is what
 * the relay says: proven while it carries calls, none while it is dark. A
 * machine silent past its class's failover minute with the relay lit fails
 * the class over here as it would in a classroom, and a scenario's «nothing
 * failed over» is the rules' verdict, not a clock that never ran. On home's
 * clock, which nothing here moves: the wall's.
 */
function runTheClock(through: TunnelFault): () => void {
  const beat = (): void => {
    probeTick(home.clock.now(), () => home.probe(through))
  }
  const passes = setInterval(() => {
    try {
      home.tick()
    } catch (error) {
      console.error('[classes-docker] the machines\' clock pass failed', error)
    }
  }, CLOCK_PASS_MS)
  const beats = setInterval(beat, CLASS_PROBE_MS)
  passes.unref()
  beats.unref()
  beat()
  return () => {
    clearInterval(passes)
    clearInterval(beats)
  }
}

/** Until home's boot grace is over (heard.ts · inBootGrace) nothing fails over: a scenario's «nothing failed over» proves something only after it. */
async function failoverInForce(): Promise<void> {
  await waitFor('home\'s boot grace to be over', () => !inBootGrace(home.clock.now()), REMOTE_BOOT_GRACE_MS + 10_000, () => '', 1_000)
}

before(async () => {
  if (!enabled) return
  if (process.platform !== 'linux') throw new Error('the parity job runs on Linux: home and the agent share the host\'s network, and its daemon\'s iptables')
  // Home starts no room of its own on this daemon (D20 would keep the machine from classes) and installs no chains of its own.
  assert.equal(process.env.KERNEL_BACKEND, 'test', 'home runs on KERNEL_BACKEND=test (tests/_env.mts)')
  // The file's docker goes to the system daemon whatever is set (DOCKER_ENV); a DOCKER_HOST naming another one is a mistake to say.
  const host = (process.env.DOCKER_HOST ?? '').trim()
  if (host !== '' && host !== `unix://${SOCKET}`) throw new Error(`DOCKER_HOST is ${host}: the agent mounts the system daemon's ${SOCKET}, as colloq-host does`)
  for (const image of [KERNEL_IMAGE, AGENT_IMAGE]) {
    if ((await docker(['image', 'inspect', '--format', '{{.Id}}', image])).code !== 0) {
      throw new Error(`${image} is not on this daemon: build it as .github/workflows/classes-smoke.yml does`)
    }
  }
  // The class environment's revision as home notes one it captured: the ref a machine pulls, and the layers it checks.
  const kernel = (await inspectOf<{ Id: string; Os: string; Architecture: string; RepoDigests?: string[]; Config?: { Env?: string[] } }>(KERNEL_IMAGE, 'image'))!
  const identity = imageIdentity(kernel, KERNEL_REPO)
  if (!identity.registryRef || !identity.layers) {
    throw new Error(`${KERNEL_IMAGE} has no digest of its own (RepoDigests ${JSON.stringify(kernel.RepoDigests ?? [])}): keep the daemon's images in the containerd store, as the workflow does`)
  }
  const resolved = await docker(['image', 'inspect', '--format', '{{.Id}}', identity.registryRef])
  assert.equal(resolved.stdout.trim(), kernel.Id, `${identity.registryRef} is not ${KERNEL_IMAGE} on this daemon`)
  const python = (kernel.Config?.Env ?? []).find((entry) => entry.startsWith('PYTHON_VERSION='))?.slice('PYTHON_VERSION='.length) ?? '3.11'
  const revision = putRevision({
    environmentName: 'base', imageDigest: kernel.Id, pythonVersion: python, pythonAbi: `cp${python.split('.').slice(0, 2).join('')}`,
    platform: `${kernel.Os}/${kernel.Architecture}`, packages: [], baseConstraintsHash: 'classes-docker',
  })
  assert.ok(noteRevisionImage(revision.id, identity) || revision.registryRef === identity.registryRef)
  revisionId = revision.id

  await home.start()
  useClassFiles(new ClassFiles({ log: (line) => fileLines.push(line) }))
  relay = await TunnelFault.start({ target: home.port })
  // From the start, as index.ts starts it once the server listens.
  stopClock = runTheClock(relay)
  if (LOGS) {
    logTimer = setInterval(keepHomeLogs, LOG_FLUSH_MS)
    logTimer.unref()
  }
  machine = new Machine(os.tmpdir())
  await machine.prepare()
  machine.join = relay.joinTarget(mintRemoteCode({ machines: 1, hours: 1, trusted: false, approvedSlots: null, classes: true, namePrefix: 'parity', createdBy: 'colloq-host' }).code)
  await machine.start()
  const one = theMachine()
  runnerId = await waitFor('the machine to join', () => listRunners().find((runner) => runner.state === 'active')?.id, 180_000, () => one.tail())
  await waitFor('its tunnel up at home', () => home.tunnels?.isUp(runnerId), 120_000, async () => `${await one.tail()}\n${home.tunnelLines.join('\n')}`)
  // One daemon: the one this file inspects and removes from is the one the agent runs its classes on (its mounted socket).
  const ours = (await dockerOk(['info', '--format', '{{.ID}}'])).stdout.trim()
  const its = await one.exec(['docker', 'info', '--format', '{{.ID}}'])
  assert.equal(its.stdout.trim(), ours, `the agent's daemon is not the file's: ${its.stderr.trim()}`)
}, { timeout: 420_000 })

after(async () => {
  if (!enabled) return
  stopClock?.()
  stopClock = null
  if (logTimer) clearInterval(logTimer)
  for (const ws of sockets) ws.terminate()
  // The kernels' clients and the rooms' documents of this process go first: no reconnect knocks on a machine that is gone.
  await shutdownKernels()
  shutdownCollab()
  relay?.heal()
  try {
    if (machine) await machine.dismantle()
    // The tag the agent gave the revision (images.ts · revisionImage): the kernel's own name keeps the image.
    const tag = `${REVISION_TAG}:${revisionId}`
    if (revisionId) await docker(['image', 'rm', tag])
    // And then nothing of it is left, or the run fails saying what is.
    const left = machine ? await machine.leftovers() : []
    if (revisionId && (await docker(['image', 'inspect', '--format', '{{.Id}}', tag])).code === 0) left.push(`image ${tag}`)
    assert.deepEqual(left, [], `the run left behind:\n${left.join('\n')}`)
  } finally {
    dismantled = true
    keepHomeLogs()
    useClassFiles(null)
    await relay?.close()
    await home.close()
  }
}, { timeout: 300_000 })

/*
 * A run cut short before `after` (a killed process, a hook that threw) still
 * leaves no agent and no class container running on the daemon: the same
 * removals, synchronously, as far as they go.
 */
process.on('exit', () => {
  if (!enabled || !machine || dismantled) return
  const quietly = (args: string[]): string => {
    try {
      return execFileSync('docker', args, { env: DOCKER_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 })
    } catch {
      return ''
    }
  }
  quietly(['rm', '-f', machine.name])
  const left = quietly(['ps', '-aq', '--filter', `label=${machine.instanceLabel}`]).split('\n').map((line) => line.trim()).filter(Boolean)
  if (left.length > 0) quietly(['rm', '-f', ...left])
  const networks = quietly(['network', 'ls', '-q', '--filter', `label=${machine.instanceLabel}`]).split('\n').map((line) => line.trim()).filter(Boolean)
  if (networks.length > 0) quietly(['network', 'rm', ...networks])
  quietly(helperArgs(AGENT_IMAGE, perimeterRemovalScript(machine.scope)))
  quietly(['run', '--rm', '--network', 'none', '--user', '0:0', '--label', TEST_LABEL, '-v', `${machine.root}:${machine.root}`, '--entrypoint', 'rm', AGENT_IMAGE, '-rf', '--', machine.tree])
  try {
    fs.rmSync(machine.root, { recursive: true, force: true })
  } catch { /* a folder left in the temp directory is no failure of the run */ }
})

/* ------------------------------------------------------------------ people */

interface Staff {
  /** The Cookie header a signed-in teacher's browser sends. */
  cookie: string
}

/** A teacher of this instance, signed in: the owner, who also says where classes compute (§6.2, D4). */
function staff(name = 'Преподавательница'): Staff {
  const made = createTeacher({ name, email: `parity.${Date.now()}.${randomBytes(3).toString('hex')}@example.edu`, role: 'owner' })!
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

/** The classes the scenario running now made: each one's kernels are stopped once it is over (afterEach). */
const classes: Array<{ by: Staff; id: string }> = []

/**
 * A class made in the panel on the base environment, a core and a gigabyte
 * (a hosted runner's four cores hold it beside the agent), and its room set
 * to machines in its «Ресурсы» (§6.2).
 */
async function makeClass(by: Staff, name: string, placement: Partial<ClassPlacement> = { room: 'machines' }): Promise<string> {
  const made = await call<{ id: string }>('POST', '/api/admin/seminars', { name, environment: 'base', rules: {}, cpus: 1, memoryMb: 1024 }, by.cookie)
  assert.equal(made.status, 201, JSON.stringify(made.body))
  classes.push({ by, id: made.body.id })
  const set = await call('PATCH', `/api/admin/seminars/${made.body.id}`, { placement }, by.cookie)
  assert.equal(set.status, 200, JSON.stringify(set.body))
  return made.body.id
}

/**
 * The class is over: its room container's log kept for the job, then the
 * owner stops its kernels («Остановить» in «Работают сейчас»), and the
 * machine removes the container and says so (§6.10).
 */
async function endClass(by: Staff, sessionId: string): Promise<void> {
  keepLog(`room-${sessionId}.log`, textOf(await logsOf(theMachine().room(sessionId))))
  keepLog(`council-${sessionId}.log`, textOf(await logsOf(theMachine().council(sessionId))))
  const stopped = await call<{ error?: string }>('POST', `/api/admin/resources/running/${sessionId}/stop`, { what: 'class', force: true }, by.cookie)
  assert.ok(stopped.status === 200 || stopped.status === 404, `${stopped.status} ${JSON.stringify(stopped.body)}`)
  await waitFor(`class ${sessionId} off the machine`, () => (['room', 'own', 'council'] as const).every((role) => livePlacement(sessionId, role) === null), 90_000, () => home.classLines.slice(-5).join('\n'))
}

afterEach(async () => {
  if (!enabled) return
  // A scenario out of time runs on to its next wait (scenario): it stops before anything here heals or starts what it uses.
  let bound: NodeJS.Timeout | undefined
  await Promise.race([lastBody, new Promise((resolve) => (bound = setTimeout(resolve, BODY_STOP_MS)))])
  clearTimeout(bound)
  // Whatever a scenario that failed left: the relay lit, the agent running, so that its classes can be stopped there.
  relay?.heal()
  if (machine && !(await machine.running())) {
    // A life that ended by itself (a crash, an exit during a cut): its log is kept before its container goes.
    await machine.remove()
    await machine.start()
    await waitFor('the tunnel up again', () => home.tunnels?.isUp(runnerId), 120_000)
  }
  for (const { by, id } of classes.splice(0)) await endClass(by, id)
  keepHomeLogs()
  await machine?.keepLife()
}, { timeout: 420_000 })

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
    await waitFor('the notebook to sync', () => notebook.doc.getArray(CELLS_KEY).length > 0, 30_000)
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

  /** What a cell printed so far. */
  printed(id: string): string {
    const cell = this.cell(id)
    return cell ? readCell(cell).outputs.map((output) => (output.kind === 'stream' ? output.text : '')).join('') : ''
  }

  /** The cell's state, printed text and errors, once it has settled (ok or error). */
  async settled(id: string, timeoutMs = 60_000): Promise<{ state: string; text: string; errors: string[] }> {
    return waitFor(`cell ${id} to settle`, () => {
      const cell = this.cell(id)
      if (!cell) return null
      const read = readCell(cell)
      if (read.state !== 'ok' && read.state !== 'error') return null
      return {
        state: read.state,
        text: read.outputs.map((output) => (output.kind === 'stream' ? output.text : '')).join(''),
        errors: read.outputs.flatMap((output) => (output.kind === 'error' ? [output.ename ? `${output.ename}: ${output.evalue}` : output.evalue] : [])),
      }
    }, timeoutMs, async () => `${JSON.stringify({ cell: this.cell(id) ? readCell(this.cell(id)!) : null, notes: this.notes().slice(-4) })}\n${await theMachine().tail(20)}`)
  }

  /** The cell ran to its end with no error: what it printed. */
  async ok(id: string, timeoutMs?: number): Promise<string> {
    const done = await this.settled(id, timeoutMs)
    assert.deepEqual([done.state, done.errors], ['ok', []], `the cell: ${JSON.stringify(done)}\nnotes: ${this.notes().join('\n')}`)
    return done.text
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
    await waitFor('the control socket\'s welcome', () => control.heard.some((frame) => frame.t === 'role'), 30_000)
    return control
  }

  send(message: ControlClientMessage): void {
    this.ws.send(JSON.stringify(message))
  }

  /** The first frame from `from` on that `pick` takes. */
  async frame<T>(what: string, pick: (frame: ControlServerMessage) => T | null | undefined | false, from = 0, timeoutMs = 30_000): Promise<T> {
    return waitFor(what, () => {
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

/** Until the form's live line says the machine takes the class (placement.ts · outlook): its facts heard, the class's image ready there. */
async function takes(sessionId: string): Promise<void> {
  let last: unknown = null
  await waitFor(`the machine to take class ${sessionId}`, async () => {
    const outlook = await placementOutlook(sessionId)
    last = outlook
    return outlook.refusal === null && outlook.machines.find((one) => one.runnerId === runnerId)?.refusal === null
  }, 240_000, async () => `${JSON.stringify(last)}\n${await theMachine().tail()}\n${home.classLines.slice(-10).join('\n')}`, 250)
}

/**
 * A class of its own with its room on the machine (and the rest of its
 * «Где считается» as `placement` says), its notebook's kernel brought up
 * there by the teacher's join (the warm start, §6.8), and a student in it:
 * what every scenario but the first starts from.
 */
async function classOn(name: string, placement?: Partial<ClassPlacement>): Promise<{ id: string; by: Staff; lead: Tab; student: Tab; container: string }> {
  const by = staff()
  const id = await makeClass(by, name, placement)
  await takes(id)
  const lead = await tab(id, 'Преподавательница', by)
  await waitFor(`class ${id}'s room on the machine, its kernel up`, () => {
    const row = placementRow(id, 'room')
    return row?.state === 'ready' && row.runnerId === runnerId && bookKernel(lead.notebook.doc, CELLS_KEY).where === 'machine'
  }, 240_000, async () => `${JSON.stringify(placementRow(id, 'room'))}\n${home.classLines.slice(-10).join('\n')}\n${await theMachine().tail()}`, 250)
  const student = await tab(id, 'Студент')
  return { id, by, lead, student, container: theMachine().room(id) }
}

function closeTabs(...tabs: Tab[]): void {
  for (const one of tabs) {
    one.notebook.close()
    one.control.close()
  }
}

/** A server word with its placeholders as patterns: what the room reads, whatever the machine said in them. */
function words(key: string, names: readonly string[] = [], fixed: Record<string, string | number> = {}): RegExp {
  const marks = Object.fromEntries(names.map((name, i) => [name, `\u0000${i}\u0000`]))
  const escaped = tr(key, { ...fixed, ...marks }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\u0000\d+\u0000/g, '[\\s\\S]*?')}$`)
}

const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''

/** Until class `sessionId`'s terminal ran `command` to its end, among the lines from `from`: the output lines it printed. */
async function ranInTerminal(sessionId: string, notebook: Notebook, command: string, from: number, timeoutMs = 60_000): Promise<string[]> {
  return waitFor(`the terminal to run «${command}»`, () => {
    const lines = notebook.terminal().slice(from)
    const at = lines.findIndex((line) => line.kind === 'command' && line.text === command)
    if (at < 0 || lines[at]!.running) return null
    return lines.slice(at + 1).filter((line) => line.kind === 'output').map((line) => line.text)
  }, timeoutMs, () => `${JSON.stringify(notebook.terminal().slice(-8))}\nhome's shell: ${terminalPhase(sessionId)}`)
}

/* ------------------------------------------------------- a container's Jupyter */

/** A class container's own Jupyter, as the agent reaches it: the loopback port docker published for it, and the token it was started with. */
interface Door {
  url: string
  token: string
}

async function doorOf(container: string): Promise<Door> {
  const port = parsePort((await dockerOk(['port', container, '8888/tcp'])).stdout)
  assert.ok(port, `${container} publishes no Jupyter port on 127.0.0.1`)
  const env = JSON.parse((await dockerOk(['inspect', '--type', 'container', '--format', '{{json .Config.Env}}', container])).stdout) as string[]
  const token = env.find((entry) => entry.startsWith('JUPYTER_TOKEN='))?.slice('JUPYTER_TOKEN='.length)
  assert.ok(token, `${container} was started without a token`)
  return { url: `http://127.0.0.1:${port}`, token }
}

async function rest<T>(door: Door, method: string, at: string, body?: unknown): Promise<{ status: number; body: T }> {
  const answer = await fetch(`${door.url}${at}`, {
    method,
    headers: { authorization: `token ${door.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await answer.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch { /* an error page: the status says it */ }
  return { status: answer.status, body: parsed as T }
}

/** A kernel as jupyter_server's REST lists it: `connections` is the WebSockets open to it now. */
interface KernelModel {
  id: string
  execution_state: string
  connections: number
}

/** The kernel's model now; null — no answer (a poll asks again). */
async function kernelModel(door: Door, kernelId: string): Promise<KernelModel | null> {
  try {
    const asked = await rest<KernelModel>(door, 'GET', `/api/kernels/${kernelId}`)
    return asked.status === 200 ? asked.body : null
  } catch {
    return null
  }
}

/** The kernel jupyter_server keeps for a notebook of home's, by the session path home opens it at (jupyter.ts · jupyterSessionPath). */
async function sessionKernel(door: Door, sessionId: string): Promise<string> {
  return waitFor(`the class notebook's session in ${door.url}`, async () => {
    const listed = await rest<Array<{ path: string; kernel: { id: string } }> | null>(door, 'GET', '/api/sessions')
    return Array.isArray(listed.body) ? listed.body.find((one) => one.path === jupyterSessionPath(sessionId, CELLS_KEY))?.kernel.id : null
  }, 60_000, () => '', 250)
}

/** One message of the kernel protocol as jupyter_server sends it over a channels WebSocket asked for no subprotocol: JSON text. */
interface Message {
  channel: string
  header: { msg_id: string; msg_type: string; session: string }
  parent_header: { msg_id?: string; session?: string }
  content: Record<string, unknown>
}

/** A kernel's channels WebSocket of the test's own, straight to the container's Jupyter: what home's kernel client is, without it. */
class Channel {
  readonly heard: Message[] = []

  private constructor(private readonly ws: WebSocket, readonly session: string) {}

  static async open(door: Door, kernelId: string, session: string): Promise<Channel> {
    const ws = new WebSocket(`${door.url.replace('http:', 'ws:')}/api/kernels/${kernelId}/channels?session_id=${encodeURIComponent(session)}`, { headers: { authorization: `token ${door.token}` } })
    sockets.add(ws)
    const channel = new Channel(ws, session)
    ws.on('message', (data: RawData, binary: boolean) => {
      // Text frames are JSON; a binary one carries buffers (display data), which nothing here asks for.
      if (binary) return
      try {
        channel.heard.push(JSON.parse(String(data)) as Message)
      } catch { /* not a message of the protocol */ }
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    // Once open, a socket's end is the test's to look at (connections, the replay), never an exception of the process.
    ws.on('error', () => undefined)
    return channel
  }

  /** A request on a channel of the kernel: its msg_id. */
  send(channel: 'shell' | 'control', type: string, content: Record<string, unknown>): string {
    const id = randomUUID()
    this.ws.send(JSON.stringify({
      header: { msg_id: id, msg_type: type, username: 'parity', session: this.session, date: new Date().toISOString(), version: '5.3' },
      parent_header: {}, metadata: {}, content, buffers: [], channel,
    }))
    return id
  }

  /** The first message of `type` answering `parent`, and where it came among what this socket heard. */
  async answer(parent: string, type: string, timeoutMs = 60_000): Promise<{ message: Message; index: number }> {
    return waitFor(`the ${type} to ${parent}`, () => {
      const index = this.heard.findIndex((message) => message.parent_header.msg_id === parent && message.header.msg_type === type)
      return index < 0 ? null : { message: this.heard[index]!, index }
    }, timeoutMs, () => JSON.stringify(this.heard.slice(-6).map((message) => message.header.msg_type)))
  }

  /** A socket that goes as a dead process's does: no close frame. */
  terminate(): void {
    this.ws.terminate()
  }
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

/** The room's tree as a participant reads it (GET /api/sessions/:id/files): its rows by path. */
async function tree(sessionId: string, token: string): Promise<Map<string, FileEntry>> {
  const answer = await fetch(`${home.url}/api/sessions/${sessionId}/files`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(answer.status, 200)
  const listed = (await answer.json()) as FileTree
  return new Map(listed.files.map((entry) => [entry.path, entry]))
}

/** A file put in through the room's upload door (POST /api/sessions/:id/files), as the files panel sends it: multipart, field `file`. */
async function upload(sessionId: string, by: Staff, name: string, content: string): Promise<number> {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'text/csv' }), name)
  const answer = await fetch(`${home.url}/api/sessions/${sessionId}/files`, { method: 'POST', headers: { cookie: by.cookie }, body: form })
  await answer.arrayBuffer()
  return answer.status
}

/** What the owner reads of the class's files on its machine in «Работают сейчас»: the room slot's lag, as the machine said it. */
async function lagSeen(by: Staff, sessionId: string): Promise<RemoteFilesLag | null | undefined> {
  const running = await call<RunningKernels>('GET', '/api/admin/resources/running', undefined, by.cookie)
  assert.equal(running.status, 200)
  const row = running.body.classes.find((one) => one.id === sessionId) as (RunningClass & RunningClassMachines) | undefined
  return row?.machines?.find((slot) => slot.role === 'room')?.files
}

/** The class's files the machine uploaded here: its PUTs of rooms/:id/files, each one a pull home asked for. */
const uploadsOf = (sessionId: string): number =>
  home.requests.filter((one) => one.method === 'PUT' && one.runnerId === runnerId && one.path === `/api/runners/v1/rooms/${sessionId}/files`).length

/** CSV text of `bytes` bytes (an ASCII `tag`): a header, then rows of it. */
function csv(bytes: number, tag: string): string {
  const head = 'id,value\n'
  const row = `${tag},0.5\n`
  const body = head + row.repeat(Math.ceil((bytes - head.length) / row.length))
  return body.slice(0, bytes - 1) + '\n'
}

/* ----------------------------------------------------------- the host's rules */

/**
 * The host's filter table (`iptables -S`), read the way the perimeter's own
 * helper reaches it (perimeter-core.ts · helperArgs, FIND_DOCKERD): from the
 * agent's image, privileged, on the host's network and pids, in the mount
 * namespace of the dockerd whose network is the host's.
 */
async function hostRules(): Promise<string[]> {
  const script = [
    'set -u',
    'me=$(readlink /proc/self/ns/net)',
    'pid=',
    'for p in /proc/[0-9]*; do',
    '  [ "$(cat "$p/comm" 2>/dev/null)" = dockerd ] || continue',
    '  [ "$(readlink "$p/ns/net" 2>/dev/null)" = "$me" ] || continue',
    '  pid=${p#/proc/}',
    '  break',
    'done',
    '[ -n "$pid" ] || { echo "no dockerd in the host namespaces"; exit 20; }',
    'exec nsenter -t "$pid" -m -- iptables -w -S',
  ].join('\n')
  return (await dockerOk(helperArgs(AGENT_IMAGE, script))).stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/* --------------------------------------------------------------- scenarios */

scenario('the machine joins with classes from a container on the host network, as uid 1000; its own bridge and chains are on the host, and its admission canary passes on the real daemon', 300_000, async (t) => {
  const one = theMachine()
  const by = staff()
  const id = await makeClass(by, 'Паритет · периметр')
  // Eligible (placement.ts · machineRefusal): the host's network read off its own container, no home on this daemon, the
  // perimeter in place, the canary passed, the class's image ready there: every fact home asks of a class machine.
  await takes(id)
  const said = await one.log()
  assert.match(said, /class perimeter: ok/)
  assert.match(said, /class admission canary: ok/, 'the canary saw the sandbox hold from the inside: no root, no capability, no socket, no agent file, nothing of the host, the LAN, metadata or IPv6 reachable, the folder both ways')
  assert.doesNotMatch(said, /not on the host's network/)

  // The agent as colloq-host runs it: uid 1000, with the docker socket's group as its only way to the daemon.
  const who = (await one.exec(['id'])).stdout.trim()
  assert.match(who, new RegExp(`^uid=${KERNEL_UID}\\b.*\\bgroups=.*\\b${fs.statSync(SOCKET).gid}\\b`), who)
  const own = await inspectOf<{ HostConfig: { NetworkMode: string } }>(one.name)
  assert.equal(own?.HostConfig.NetworkMode, 'host')

  // Its bridge, made by it under its own name and labels: no traffic between containers, no IPv6.
  const network = await inspectOf<{ Labels: Record<string, string>; EnableIPv6: boolean; Options: Record<string, string>; IPAM: { Config: Array<{ Subnet: string }> } }>(one.scope.network, 'network')
  assert.ok(network, `no network ${one.scope.network}`)
  const [instanceKey, instanceValue] = one.instanceLabel.split('=') as [string, string]
  assert.equal(network.Labels['colloq.kind'], 'class-network')
  assert.equal(network.Labels[instanceKey], instanceValue)
  assert.equal(network.EnableIPv6, false)
  assert.equal(network.Options['com.docker.network.bridge.enable_icc'], 'false')
  const subnet = network.IPAM.Config[0]?.Subnet
  assert.ok(subnet, JSON.stringify(network.IPAM))

  // Its chains in the host's filter table, by the agent-scoped names (perimeter-core.ts · machinePerimeter, wave 0's spelling),
  // and the jumps to them by its tag: the rooms' subnet refused to the host, and every private and special range beyond it.
  const rules = await hostRules()
  const { chains, tag } = one.scope
  const jump = (from: string, to: string): boolean => rules.some((rule) => rule.startsWith(`-A ${from} `) && new RegExp(`--comment "?${tag}"? `).test(rule) && rule.endsWith(`-j ${to}`))
  assert.ok(jump('DOCKER-USER', `${chains}-FWD`), `no jump from DOCKER-USER to ${chains}-FWD:\n${rules.join('\n')}`)
  assert.ok(jump('INPUT', `${chains}-IN`), `no jump from INPUT to ${chains}-IN:\n${rules.join('\n')}`)
  assert.ok(rules.includes(`-A ${chains}-IN -s ${subnet} -j ${chains}-DENY`), `the host is not refused to ${subnet}:\n${rules.join('\n')}`)
  for (const range of BLOCKED_V4) assert.ok(rules.includes(`-A ${chains}-FWD -s ${subnet} -d ${range} -j ${chains}-DENY`), `${range} is not refused to ${subnet}`)
  const deny = rules.filter((rule) => rule.startsWith(`-A ${chains}-DENY `))
  record(t, `perimeter: bridge ${one.scope.network} ${subnet}, chains ${chains}-*, deny ${deny.map((rule) => rule.slice(`-A ${chains}-DENY `.length)).join(' / ')}`)
  // The canary ran under the agent's check label, by its own name, and removed itself (--rm).
  assert.equal((await docker(['ps', '-aq', '--filter', `label=${CHECK_LABEL}`, '--filter', `name=colloq-runner-canary-${one.scope.i6}`])).stdout.trim(), '')
})

scenario('placement, cells, help, input(), interrupt, restart and the terminal against the real jupyter_server, in a container the daemon holds to home\'s argv', 420_000, async () => {
  const { id, lead, student, container } = await classOn('Паритет · ячейки')
  const placed = placementRow(id, 'room')!

  // The container as the daemon holds it: home's sandbox by construction (room-spec.ts · machineRoomRunArgs).
  const held = await inspectOf<{
    Id: string
    Config: { User: string; Env: string[]; Labels: Record<string, string> }
    HostConfig: {
      CapDrop: string[] | null; SecurityOpt: string[] | null; PidsLimit: number | null; Memory: number; MemorySwap: number; NanoCpus: number
      NetworkMode: string; PortBindings: Record<string, Array<{ HostIp: string }>>; RestartPolicy: { Name: string }; LogConfig: { Type: string; Config: Record<string, string> }
      Sysctls: Record<string, string> | null
    }
    Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>
  }>(container)
  assert.ok(held, `no container ${container}`)
  const [instanceKey, instanceValue] = theMachine().instanceLabel.split('=') as [string, string]
  assert.equal(held.Config.User, `${KERNEL_UID}:${KERNEL_UID}`)
  assert.deepEqual(held.HostConfig.CapDrop, ['ALL'])
  assert.ok((held.HostConfig.SecurityOpt ?? []).some((option) => option.startsWith('no-new-privileges')), JSON.stringify(held.HostConfig.SecurityOpt))
  assert.ok((held.HostConfig.PidsLimit ?? 0) > 0)
  // What home asked of the slot, held by the daemon; the ready echo is this container, its image the pinned ref.
  const mib = placed.memoryMb * 1024 * 1024
  assert.deepEqual([held.HostConfig.Memory, held.HostConfig.MemorySwap, held.HostConfig.NanoCpus], [mib, mib, placed.cpus * 1e9])
  assert.equal(placed.container, held.Id)
  assert.equal(placed.revision.id, revisionId)
  assert.equal(held.HostConfig.NetworkMode, theMachine().scope.network)
  assert.deepEqual(held.HostConfig.PortBindings['8888/tcp']?.map((binding) => binding.HostIp), ['127.0.0.1'], 'Jupyter on the host\'s loopback only')
  assert.equal(held.HostConfig.RestartPolicy.Name, 'no')
  assert.deepEqual([held.HostConfig.LogConfig.Type, held.HostConfig.LogConfig.Config['max-size'], held.HostConfig.LogConfig.Config['max-file']], ['local', '8m', '2'])
  assert.equal(held.HostConfig.Sysctls?.['net.ipv6.conf.all.disable_ipv6'], '1')
  assert.equal(`colloq.kind=${held.Config.Labels['colloq.kind']}`, CLASS_KERNEL_LABEL)
  assert.equal(held.Config.Labels[PLACEMENT_LABEL], `${id}:room:${placed.gen}`)
  assert.deepEqual([held.Config.Labels['colloq.role'], held.Config.Labels['colloq.session'], held.Config.Labels[instanceKey]], ['room', id, instanceValue])
  assert.ok(held.Config.Labels['colloq.profile'])
  assert.deepEqual(held.Mounts.map((mount) => [mount.Type, mount.Source, mount.Destination, mount.RW]), [['bind', path.join(theMachine().tree, 'rooms', id), `/workspace/${id}`, true]])
  assert.ok(held.Config.Env.includes(`PYTHONHASHSEED=${classHashSeed(id)}`), 'the class\'s one hash seed (D28)')

  // A cell, computed on the machine: in the class folder there, as the kernels' uid, with the class's hash seed.
  const first = lead.notebook.add('import os\nx = 41\nprint("на машине", x, os.getuid(), os.getcwd(), os.environ["PYTHONHASHSEED"])')
  lead.control.send({ t: 'run', cellId: first })
  assert.deepEqual(await student.notebook.settled(first), { state: 'ok', text: `на машине 41 ${KERNEL_UID} /workspace/${id} ${classHashSeed(id)}\n`, errors: [] })
  const entry = bookKernel(student.notebook.doc, CELLS_KEY)
  assert.deepEqual([entry.where, entry.link], ['machine', 'ok'])

  // Completion through the tunnel: IPython's own answer (jedi's first one may take its time warming up, so it is asked again).
  const code = 'import os\nos.pa'
  let matches: string[] = []
  for (let ask = 1; ask <= 6 && !matches.some((text) => /path$/.test(text)); ask++) {
    const from = lead.control.heard.length
    lead.control.send({ t: 'complete', id: ask, code, cursor: code.length, cellId: first })
    matches = (await lead.control.frame('the completion', (frame) => (frame.t === 'complete:reply' && frame.id === ask ? frame : null), from)).matches.map((match) => match.text)
  }
  assert.ok(matches.some((text) => /path$/.test(text)), JSON.stringify(matches))
  const asked = lead.control.heard.length
  lead.control.send({ t: 'inspect', id: 100, code: 'len', cursor: 3, cellId: first })
  const help = await lead.control.frame('the help', (frame) => (frame.t === 'inspect:reply' && frame.id === 100 ? frame : null), asked)
  assert.equal(help.found, true)
  assert.match(help.text ?? '', /number of items/)

  // input(): the prompt in the room, the student's answer back to the cell on the machine.
  const asking = student.notebook.add('name = input("Как вас зовут? ")\nprint("Привет,", name)')
  student.control.send({ t: 'run', cellId: asking })
  const prompt = await waitFor('the prompt in the teacher\'s document', () => {
    const cell = lead.notebook.cell(asking)
    return cell ? readCell(cell).stdin : null
  }, 60_000)
  assert.deepEqual(prompt, { prompt: 'Как вас зовут? ', password: false })
  student.control.send({ t: 'input', value: 'Ада', cellId: asking })
  assert.deepEqual(await lead.notebook.settled(asking), { state: 'ok', text: 'Привет, Ада\n', errors: [] })

  // Interrupt: a cell sleeping on the machine, stopped from the room.
  const sleeping = lead.notebook.add('import time\ntime.sleep(600)')
  lead.control.send({ t: 'run', cellId: sleeping })
  await waitFor('the sleeping cell to run on the machine', () => {
    const kernel = bookKernel(lead.notebook.doc, CELLS_KEY)
    return kernel.status === 'busy' && kernel.runningCell === sleeping
  }, 60_000)
  lead.control.send({ t: 'interrupt', cellId: sleeping })
  const stopped = await student.notebook.settled(sleeping)
  assert.deepEqual([stopped.state, stopped.errors.map((error) => error.split(':')[0])], ['error', ['KeyboardInterrupt']])

  // Restart: a new process over there, every variable gone (K3c's verdict came from the replies' process id, pinned below).
  const notesBefore = student.notebook.notes().length
  lead.control.send({ t: 'restart' })
  const restarted = tr('server.kernelRestartedByEveryVariableIsGone.3322fd', { p0: 'Преподавательница' })
  await waitFor('the restart\'s note', () => student.notebook.notes().slice(notesBefore).includes(restarted), 90_000, () => student.notebook.notes().join('\n'))
  const after = lead.notebook.add('print(x)')
  lead.control.send({ t: 'run', cellId: after })
  assert.deepEqual((await student.notebook.settled(after)).errors, ['NameError: name \'x\' is not defined'], 'a fresh Python')

  // The terminal: the class container's shell, typed into the moment it opens (F3: a socket's first frames end no prime
  // before its greeting, so the command waits for the greeting and its output is its own), then again, then on a new socket.
  lead.control.send({ t: 'term:open' })
  let from = lead.notebook.terminal().length
  const probe = 'echo parity-$((6*7)) $(id -u) $(pwd)'
  lead.control.send({ t: 'term:run', command: probe })
  const printed = await ranInTerminal(id, lead.notebook, probe, from)
  assert.ok(printed.some((line) => line.includes(`parity-42 ${KERNEL_UID} /workspace/${id}`)), JSON.stringify(printed))
  from = lead.notebook.terminal().length
  lead.control.send({ t: 'term:run', command: 'echo second' })
  assert.ok((await ranInTerminal(id, lead.notebook, 'echo second', from)).some((line) => line.includes('second')))
  lead.control.send({ t: 'term:close' })
  await waitFor('the shell closed', () => terminalPhase(id) === 'closed', 30_000)
  from = lead.notebook.terminal().length
  lead.control.send({ t: 'term:open' })
  lead.control.send({ t: 'term:run', command: 'echo again-$((2+3))' })
  assert.ok((await ranInTerminal(id, lead.notebook, 'echo again-$((2+3))', from)).some((line) => line.includes('again-5')))

  assert.deepEqual([placementRow(id, 'room')?.state, placementRow(id, 'room')?.gen], ['ready', placed.gen])
  closeTabs(lead, student)
})

scenario('jupyter_server facts the design relies on, pinned on the real server: one process id on every reply of a kernel process and another after a restart; a reconnect with the same session_id is answered only after its buffer is replayed', 300_000, async (t) => {
  const { lead, student, container } = await classOn('Паритет · факты Jupyter')
  const door = await doorOf(container)
  // A kernel of the test's own beside the class's, in the same jupyter_server: nothing it says reaches home's kernel client.
  const made = await rest<{ id: string }>(door, 'POST', '/api/kernels', { name: 'python3' })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const kernel = made.body.id
  try {
    /*
     * FACT 1 (K3c · settleRestart, reconcileAfterReset): ipykernel draws its
     * Session id once per process and stamps it on every reply as
     * `header.session`, so home tells a process by it: the same on every
     * reply of one process, whichever socket and session_id asked, never the
     * client's own session_id, and another once the kernel is restarted, also
     * to a client back under the same session_id, as home's kernel client
     * comes back after every reconnect. A restart's verdict and the
     * replaced-process check rest on exactly this: were the id the socket's,
     * every reconnect would look like a replaced process; were it the
     * client's session_id, every restart would be «missed».
     */
    const a = await Channel.open(door, kernel, `parity-a-${RUN}`)
    const b = await Channel.open(door, kernel, `parity-b-${RUN}`)
    const one = (await a.answer(a.send('shell', 'kernel_info_request', {}), 'kernel_info_reply')).message
    const two = (await a.answer(a.send('shell', 'kernel_info_request', {}), 'kernel_info_reply')).message
    const beside = (await b.answer(b.send('shell', 'kernel_info_request', {}), 'kernel_info_reply')).message
    assert.ok(one.header.session, 'a reply carries the process\'s id')
    assert.equal(two.header.session, one.header.session, 'one process, one id on every reply')
    assert.equal(beside.header.session, one.header.session, 'the process\'s id, not the socket\'s: the same to another socket under another session_id')
    assert.ok(![a.session, b.session].includes(one.header.session), `the process's own id, never the asking client's session_id: ${one.header.session}`)
    assert.equal(one.parent_header.session, a.session, 'the request\'s own session comes back in the parent, not as the reply\'s id')
    a.terminate()
    b.terminate()
    const restarted = await rest(door, 'POST', `/api/kernels/${kernel}/restart`)
    assert.equal(restarted.status, 200)
    const back = await Channel.open(door, kernel, a.session)
    const three = (await back.answer(back.send('shell', 'kernel_info_request', {}), 'kernel_info_reply')).message
    const four = (await back.answer(back.send('shell', 'kernel_info_request', {}), 'kernel_info_reply')).message
    assert.notEqual(three.header.session, one.header.session, 'a restarted kernel is another process, with another id, to the very session_id that heard the old one')
    assert.equal(four.header.session, three.header.session)
    assert.notEqual(three.header.session, back.session)
    back.terminate()
    record(t, `jupyter_server: replies' header.session ${one.header.session.slice(0, 8)}… to two sockets before the restart, ${three.header.session.slice(0, 8)}… after it to the first one's session_id`)

    /*
     * FACT 2 (§5.5): while no WebSocket of a session is open, jupyter_server
     * keeps what the kernel says to it (start_buffering), and a WebSocket that
     * comes back under the same session_id gets it replayed before anything
     * it asks is answered: the kernel_info_request home sends first after
     * every reconnect is answered after the replay. reconcileAfterReset
     * settles as lost only what is still pending once that answer is in.
     */
    const session = `parity-replay-${RUN}`
    const flag = `/tmp/parity-replay-${RUN}`
    const c = await Channel.open(door, kernel, session)
    const run = c.send('shell', 'execute_request', {
      code: `import os, time\nprint('a', flush=True)\nwhile not os.path.exists(${JSON.stringify(flag)}):\n    time.sleep(0.05)\nprint('c', flush=True)`,
      silent: false, store_history: false, user_expressions: {}, allow_stdin: false, stop_on_error: true,
    })
    await waitFor('the cell\'s first line', () => c.heard.some((message) => message.parent_header.msg_id === run && message.header.msg_type === 'stream' && String(message.content.text).includes('a')), 60_000)
    c.terminate()
    await waitFor('jupyter_server to let the session\'s socket go', async () => (await kernelModel(door, kernel))?.connections === 0, 60_000, () => '', 250)
    await dockerOk(['exec', container, 'touch', flag])
    await waitFor('the cell to end with nobody connected', async () => (await kernelModel(door, kernel))?.execution_state === 'idle', 60_000, () => '', 250)
    const d = await Channel.open(door, kernel, session)
    const info = d.send('shell', 'kernel_info_request', {})
    const answered = await d.answer(info, 'kernel_info_reply')
    const order = d.heard.slice(0, answered.index + 1)
    const printedC = order.findIndex((message) => message.parent_header.msg_id === run && message.header.msg_type === 'stream' && String(message.content.text).includes('c'))
    const replied = order.findIndex((message) => message.parent_header.msg_id === run && message.header.msg_type === 'execute_reply')
    const sequence = order.map((message) => `${message.channel}:${message.header.msg_type}${message.parent_header.msg_id === run ? '(cell)' : message.parent_header.msg_id === info ? '(info)' : ''}`)
    assert.ok(printedC >= 0 && replied >= 0, `the buffered output and reply come before the kernel_info reply: ${sequence.join(' ')}`)
    record(t, `jupyter_server: a reconnect under the same session_id heard ${sequence.join(' ')}`)
    d.terminate()
  } finally {
    await rest(door, 'DELETE', `/api/kernels/${kernel}`)
  }
  closeTabs(lead, student)
})

scenario('files both ways on Linux: an upload here read there, the copy made as uid 1000 with 2775 and 0664, the kernel\'s files listed here through the anchored walk, links never travel, 16 TiB of holes stay on the machine unread, and 520 more, past what a report may carry together, are said clamped', 420_000, async (t) => {
  const { id, by, lead, student } = await classOn('Паритет · файлы')
  // Put in here: an upload through the room's door, and a note the editor saved in a folder of its own.
  const data = csv(10 * 1024, 'uploaded')
  assert.equal(await upload(id, by, 'data.csv', data), 200)
  assert.ok(writeText(id, 'notes/readme.txt', 'прочитай меня\n'))
  // The next cell on the machine reads them (the barrier, §8.2), and says how the copy holds them.
  const look = lead.notebook.add([
    'import hashlib, json, os, stat',
    'def info(p):',
    '    s = os.lstat(p)',
    '    return [oct(stat.S_IMODE(s.st_mode)), s.st_uid, s.st_gid]',
    "print(json.dumps({'uid': os.getuid(), 'folder': info('.'), 'data': info('data.csv'), 'notes': info('notes'), 'readme': info('notes/readme.txt'), 'sha': hashlib.sha256(open('data.csv', 'rb').read()).hexdigest()}))",
  ].join('\n'))
  lead.control.send({ t: 'run', cellId: look })
  const copy = JSON.parse(lastLine(await lead.notebook.ok(look))) as Record<string, unknown>
  // The copy as home's sessionDir makes a room's folder: folders 2775 (setgid) and files 0664, the kernels' uid and group
  // (the agent runs as that uid, as in production); what the kernel reads is the upload, byte for byte.
  const own = [KERNEL_UID, KERNEL_UID]
  assert.deepEqual(copy, { uid: KERNEL_UID, folder: ['0o2775', ...own], data: ['0o664', ...own], notes: ['0o2775', ...own], readme: ['0o664', ...own], sha: sha256(data) })

  // The kernel writes: a small file (inline in its report), a large one (a pull), a nested one, two links, a file of holes past
  // «Файл с машины — до», and a line onto the upload (its base the agreed version: it applies here).
  const write = lead.notebook.add([
    'import os',
    "with open('out.csv', 'w') as f:",
    "    f.write('id,v\\n1,2\\n')",
    "with open('big.csv', 'w') as f:",
    "    f.write('id,v\\n' + '1,2\\n' * 40000)",
    "os.makedirs('sub/deep', exist_ok=True)",
    "with open('sub/deep/x.csv', 'w') as f:",
    "    f.write('x\\n')",
    "os.symlink('/etc/passwd', 'link.csv')",
    "os.symlink('/', 'rootlink')",
    "with open('hole.bin', 'wb') as f:",
    '    f.truncate(2 ** 44 - 4096)',
    "with open('data.csv', 'a') as f:",
    "    f.write('appended,1\\n')",
    "s = os.stat('out.csv')",
    "print(s.st_uid, s.st_gid, oct(s.st_mode & 0o7777))",
  ].join('\n'))
  lead.control.send({ t: 'run', cellId: write })
  const [uid, gid, mode] = lastLine(await lead.notebook.ok(write)).split(' ')
  assert.deepEqual([Number(uid), Number(gid)], own, 'the kernel\'s files are the kernels\' uid\'s, in the folder\'s group')
  record(t, `files: the kernel writes ${mode} (its umask); the agent makes 0664 and 2775`)

  // Listed here once the machine's report was applied: the kernel's files with their bytes, the hole as a row «на машине»
  // with its length and nothing of it read, neither link at all (the walk opens every segment with O_NOFOLLOW).
  const holes = 2 ** 44 - 4096
  const rows = await waitFor('the kernel\'s files at home', async () => {
    const listed = await tree(id, lead.token)
    const landed = ['out.csv', 'big.csv', 'sub/deep/x.csv'].every((at) => listed.get(at) && !listed.get(at)!.pending && !listed.get(at)!.onMachine)
    return landed && listed.get('hole.bin')?.onMachine && homeFile(id, 'data.csv') === `${data}appended,1\n` ? listed : null
  }, 120_000, async () => `${fileLines.slice(-12).join('\n')}\n${await theMachine().tail(20)}`, 250)
  assert.deepEqual(rows.get('hole.bin')!.onMachine, { bytes: holes, why: 'size' })
  assert.deepEqual([rows.has('link.csv'), rows.has('rootlink')], [false, false], 'a link never travels')
  assert.deepEqual([homeFile(id, 'out.csv'), homeFile(id, 'big.csv'), homeFile(id, 'sub/deep/x.csv')], ['id,v\n1,2\n', `id,v\n${'1,2\n'.repeat(40000)}`, 'x\n'])
  assert.equal(fs.existsSync(path.join(sessionDir(id), 'link.csv')), false)
  assert.equal(homeFile(id, 'hole.bin'), null, 'nothing of the holes here')
  assert.ok(uploadsOf(id) >= 1, 'the large file came up by a pull')

  // The owner's «Работают сейчас»: nothing on its way, the one file that stays on the machine, by its length (verdicts all
  // taken in: replySeq and heard, F3).
  const lag = await waitFor('the class\'s files in step', async () => {
    const seen = await lagSeen(by, id)
    return seen && seen.pending === 0 ? seen : null
  }, 60_000, () => fileLines.slice(-8).join('\n'), 500)
  assert.deepEqual([lag.pending, lag.heldOnly, lag.heldOnlyBytes], [0, 1, holes])
  record(t, `files: verdicts said again (home's "never took in" lines): ${fileLines.filter((line) => /never took in/.test(line)).length}`)

  /*
   * The clamp (room-files.ts · clampBytes): 520 more files of holes, each
   * ext4's largest (an inode, no block), whose lengths add up past
   * Number.MAX_SAFE_INTEGER. Unclamped, home's strict parser refused the
   * machine's whole kernels block (Invalid files lag), and the agent dropped
   * it and closed its tunnel at every sync: one cell broke every class on
   * the machine (K6b's review). Clamped, the owner reads the sum as the most
   * a report may carry, no sync is refused, the tunnel stays up, and the
   * class goes on.
   */
  const madeAt = Date.now()
  const syncsFrom = home.requests.length
  const tunnelsFrom = home.tunnelLines.length
  const many = lead.notebook.add([
    'import os',
    "os.makedirs('holes', exist_ok=True)",
    'for i in range(520):',
    "    with open(f'holes/{i:03}.bin', 'wb') as f:",
    '        f.truncate(2 ** 44 - 4096)',
    "print(len(os.listdir('holes')), sum(os.stat(f'holes/{i:03}.bin').st_blocks for i in range(520)))",
  ].join('\n'))
  lead.control.send({ t: 'run', cellId: many })
  const [count, blocks] = lastLine(await lead.notebook.ok(many)).split(' ')
  assert.equal(count, '520')
  assert.ok(521 * holes > Number.MAX_SAFE_INTEGER, 'the 521 lengths add up past what a report may carry')
  const clamped = await waitFor('the 521 files of holes in the owner\'s lag', async () => {
    const seen = await lagSeen(by, id)
    return seen && seen.heldOnly >= 521 && seen.pending === 0 ? seen : null
  }, 120_000, async () => `${JSON.stringify(await lagSeen(by, id))}\n${fileLines.slice(-8).join('\n')}\n${await theMachine().tail(20)}`, 500)
  assert.deepEqual([clamped.heldOnly, clamped.heldOnlyBytes], [521, Number.MAX_SAFE_INTEGER], 'every file of holes held, their sum clamped')
  const next = lead.notebook.add('print("дальше", 2 + 2)')
  lead.control.send({ t: 'run', cellId: next })
  assert.equal(await lead.notebook.ok(next), 'дальше 4\n', 'the class goes on')
  const refused = home.requests.slice(syncsFrom).filter((request) => request.runnerId === runnerId && request.path === SYNC_PATH && (request.status ?? 0) >= 400)
  assert.deepEqual(refused, [], 'no sync of the machine refused')
  const since = textOf((await logsOf(theMachine().id)).filter((line) => line.at >= madeAt - 1_000))
  assert.doesNotMatch(since, /refused the sync's kernels block/)
  assert.deepEqual(home.tunnelLines.slice(tunnelsFrom).filter((line) => line.includes(`machine ${runnerId} up from`)), [], 'the tunnel never went down for them')
  record(t, `files: 521 files of holes held on the machine (the 520 new ones on ${blocks} blocks of the disk), said as ${clamped.heldOnly} files and ${clamped.heldOnlyBytes} bytes (clamped)`)
  closeTabs(lead, student)
})

scenario('an agent killed and started again is back within its class\'s failover minute and adopts the class container: x survives, in the same process, and the shell keeps its pty', 420_000, async (t) => {
  const one = theMachine()
  const { id, lead, student, container } = await classOn('Паритет · перезапуск агента')
  const placed = placementRow(id, 'room')!
  const before = (await inspectOf<{ Id: string }>(container))!.Id
  const set = lead.notebook.add('import os\nx = 5\nprint(os.getpid())')
  lead.control.send({ t: 'run', cellId: set })
  const pid = lastLine(await lead.notebook.ok(set))
  lead.control.send({ t: 'term:open' })
  let from = lead.notebook.terminal().length
  lead.control.send({ t: 'term:run', command: 'export PARITY_PTY=kept' })
  await ranInTerminal(id, lead.notebook, 'export PARITY_PTY=kept', from)

  /*
   * The agent dies with nothing handed back (no bye: a crash, not an update),
   * and its next life on the same tree finds the container by its label and
   * record. Meanwhile the relay is lit and the probe passes, so the machine's
   * silence is proven, and the class fails over once it has lasted the
   * class's failoverSec (§11.1): the new life — tsx from the sources, the
   * sweep, the census and adoption, then its first sync — has that long.
   */
  await failoverInForce()
  const failoverSec = classPlacement(id).failoverSec
  const tunnelsFrom = home.tunnelLines.length
  const killedAt = Date.now()
  await one.kill()
  // The old life is gone by now: what home heard of it last is where its silence began.
  const lastHeard = heardAt(runnerId) ?? killedAt
  assert.equal((await inspectOf<{ State: { Running: boolean } }>(container))?.State.Running, true, 'the class container outlives its agent')
  const startedAt = Date.now()
  await one.start()
  await waitFor('the new life to adopt the class container', async () => /after a restart: 1 class container\(s\) adopted, 0 of no placement removed/.test(await one.log()), 180_000, () => one.tail())
  const synced = await waitFor('the new life\'s first sync', () => home.requests.find((request) => request.runnerId === runnerId && request.path === SYNC_PATH && request.at > startedAt), 120_000, () => one.tail())
  await waitFor('the tunnel up from the new life', () => home.tunnels?.isUp(runnerId) && home.tunnelLines.slice(tunnelsFrom).some((line) => line.includes(`machine ${runnerId} up from`)), 120_000, async () => `${home.tunnelLines.slice(tunnelsFrom).join('\n')}\n${await one.tail()}`)
  const upAt = Date.now()
  const silent = synced.at - lastHeard
  record(t, `agent restart: heard again ${seconds(silent)} s after it was last heard (the class fails over at ${failoverSec} s of proven silence), its tunnel up ${seconds(upAt - killedAt)} s after the kill`)
  assert.deepEqual(runnerEventsOf(runnerId, ['class_failover'], killedAt), [], `nothing failed over: the new life was heard ${seconds(silent)} s after the old one, the class's failover is ${failoverSec} s`)

  const read = lead.notebook.add('print(x, os.getpid())')
  lead.control.send({ t: 'run', cellId: read })
  assert.deepEqual(await student.notebook.settled(read, 120_000), { state: 'ok', text: `5 ${pid}\n`, errors: [] }, 'the variables, in the very process')
  from = lead.notebook.terminal().length
  lead.control.send({ t: 'term:run', command: 'echo $PARITY_PTY' })
  assert.ok((await ranInTerminal(id, lead.notebook, 'echo $PARITY_PTY', from, 120_000)).some((line) => line.includes('kept')), 'the same shell')
  assert.equal((await inspectOf<{ Id: string }>(container))!.Id, before, 'the very container')
  assert.deepEqual([placementRow(id, 'room')?.state, placementRow(id, 'room')?.gen], ['ready', placed.gen])
  assert.deepEqual(runnerEventsOf(runnerId, ['class_failover'], killedAt), [], 'nothing failed over since')
  closeTabs(lead, student)
})

scenario('docker kill of the room: the machine\'s post-mortem reading reaches the room in this server\'s words, and the class computes again in the same container', 420_000, async (t) => {
  const { id, lead, student, container } = await classOn('Паритет · контейнер убит')
  const placed = placementRow(id, 'room')!
  const before = (await inspectOf<{ Id: string; State: { StartedAt: string } }>(container))!
  const warm = lead.notebook.add('x = 1\nprint("до")')
  lead.control.send({ t: 'run', cellId: warm })
  assert.equal(await lead.notebook.ok(warm), 'до\n')

  // SIGKILL to the whole container, as the host's OOM killer or a crash leaves one: the agent reads it for home's question
  // (inspect, cgroup, log; postmortem-core.ts), home says why in its own words, and the machine starts it again.
  const notesFrom = student.notebook.notes().length
  await dockerOk(['kill', container])
  const stoppedWith = words('server.theRoomContainerStoppedWithCode.b72e19', ['p1'], { p0: '137' })
  const why = await waitFor('the post-mortem in the room', () => student.notebook.notes().slice(notesFrom).find((note) => stoppedWith.test(note)), 180_000, async () => `${student.notebook.notes().slice(notesFrom).join('\n')}\n${await theMachine().tail(20)}`)
  record(t, `post-mortem of a killed room: ${why}`)

  // The machine starts the very container again (docker start: a fresh Python, the packages installed in it kept), and the
  // next Run computes there.
  const after = await waitFor('the room container started again', async () => {
    const now = await inspectOf<{ Id: string; State: { Running: boolean; StartedAt: string } }>(container)
    return now?.State.Running && now.State.StartedAt !== before.State.StartedAt && placementRow(id, 'room')?.state === 'ready' ? now : null
  }, 180_000, () => theMachine().tail(20), 500)
  assert.equal(after.Id, before.Id, 'started again, not made anew')
  const again = lead.notebook.add('print("снова", 1 + 1)')
  lead.control.send({ t: 'run', cellId: again })
  assert.equal(await lead.notebook.ok(again, 180_000), 'снова 2\n', 'a fresh kernel on the machine')
  assert.deepEqual([placementRow(id, 'room')?.state, placementRow(id, 'room')?.gen], ['ready', placed.gen], 'no failover for a death on the machine')
  closeTabs(lead, student)
})

scenario('a cut longer than jupyter_server\'s kernel WebSocket ping timeout: the server closes the inner channel, the resumed stream brings its close, and the kernel client\'s reconnect gets the replay before kernel_info (§5.5)', 600_000, async (t) => {
  const one = theMachine()
  const { id, lead, student, container } = await classOn('Паритет · долгий обрыв')
  const placed = placementRow(id, 'room')!
  const door = await doorOf(container)
  const kernel = await sessionKernel(door, id)
  const warm = lead.notebook.add('x = 7\nprint("до обрыва")')
  lead.control.send({ t: 'run', cellId: warm })
  await lead.notebook.ok(warm)
  await waitFor('home\'s kernel client on its channel', async () => ((await kernelModel(door, kernel))?.connections ?? 0) >= 1, 60_000, () => '', 250)

  // A cell that prints, then waits on the machine for a flag only the test lays, then prints again.
  const flag = `/tmp/parity-cut-${RUN}`
  const cell = lead.notebook.add(`import os, time\nprint('a', flush=True)\nwhile not os.path.exists(${JSON.stringify(flag)}):\n    time.sleep(0.1)\nprint('c', flush=True)`)
  lead.control.send({ t: 'run', cellId: cell })
  await waitFor('the first line in the room', () => student.notebook.printed(cell) === 'a\n', 60_000)

  /*
   * Lined up with jupyter_server's ping timer, the one wall-clock wait of the
   * file. The server pings each kernel WebSocket every WS_PING_INTERVAL from
   * its open and closes it at the first ping that finds no pong for the
   * timeout (3 × the interval): up to an interval later than the timeout
   * after the cut. Both ends of the tunnel keep the streams TUNNEL_RESUME_MS
   * from their own dead timer (TUNNEL_DEAD_MS), so the cut must end between
   * the two. Begun just before a ping, it ends as soon as it can; nothing is
   * asserted on the timer, which is only guessed here (PING_INTERVAL_GUESS_MS),
   * and a guess that is wrong costs only margin.
   */
  // The failover rules in force through the cut: what keeps the class on its machine is the rule of a dark relay, below.
  await failoverInForce()
  const opened = (await logsOf(container)).filter((line) => line.text.includes(`Connecting to kernel ${kernel}`)).at(-1)?.at
  if (opened) await sleep((PING_INTERVAL_GUESS_MS - 2_000 - ((Date.now() - opened) % PING_INTERVAL_GUESS_MS) + PING_INTERVAL_GUESS_MS) % PING_INTERVAL_GUESS_MS)
  const tunnelsFrom = home.tunnelLines.length
  relay!.blackhole()
  const cutAt = Date.now()

  /*
   * FACT 3: jupyter_server pings its kernel WebSockets and closes one that
   * stops answering, even while its client is only out of reach: home's
   * channel, held open by the agent across the cut, is closed by the server
   * once the timeout passes. Resume keeps the bytes; it cannot keep a socket
   * the server itself ends. What the server said of it, and when, is recorded.
   */
  const closedAt = await waitFor('jupyter_server to close the channel it could not ping', async () => ((await kernelModel(door, kernel))?.connections === 0 ? Date.now() : null), TUNNEL_DEAD_MS + TUNNEL_RESUME_MS + 10_000, async () => textOf((await logsOf(container)).slice(-20)), 500)
  // Its own words for it where this jupyter_server has them (base/websocket.py · send_ping); and the agent's end lets a stream
  // go only TUNNEL_RESUME_MS after its dead timer, so a close before TUNNEL_RESUME_MS into the cut is the server's either way.
  const timeoutSaid = /WebSocket ping timeout after (\d+) ms/.exec(textOf(await logsOf(container)))
  assert.ok(timeoutSaid || closedAt - cutAt < TUNNEL_RESUME_MS, `the channel went ${Math.round((closedAt - cutAt) / 1000)} s into the cut, and jupyter_server said no ping timeout: the agent's end let it go, so the server's own timeout outlasts a resumable cut`)
  // The rest of the cell, with nobody connected: jupyter_server keeps it for the session (FACT 2).
  await dockerOk(['exec', container, 'touch', flag])
  await waitFor('the cell to end on the machine', async () => (await kernelModel(door, kernel))?.execution_state === 'idle', 60_000, () => '', 250)
  /*
   * The whole relay dark, home's probe of its own path through it too: no
   * evidence of the path (heard.ts · classPathEvidence), so the machine's
   * silence proves nothing and the class waits for it however long the cut
   * (§11.1), as in an outage of relay2. A cut of the machine's leg alone
   * leaves the probe passing: that class fails over after its failoverSec,
   * long before jupyter_server's ping timeout would close its channel.
   */
  assert.equal(classPathEvidence(home.clock.now()), false, 'a dark relay proves no path')
  const logFrom = (await logsOf(container)).length
  relay!.heal()
  const healedAt = Date.now()

  // Healed within what both ends keep: the streams resume, and with them comes the close the server sent into the dark.
  const back = await waitFor('the tunnel back', () => home.tunnelLines.slice(tunnelsFrom).map((line) => new RegExp(`machine ${runnerId} up from [^,]*(?:, (\\d+) streams resumed)?(?:, (\\d+) reset)?`).exec(line)).find(Boolean), 120_000, async () => `${home.tunnelLines.slice(tunnelsFrom).join('\n')}\n${await one.tail()}`)
  const resumed = Number(back[1] ?? 0)
  const reset = Number(back[2] ?? 0)
  assert.ok(resumed > 0, `the streams were not resumed (${reset} reset), ${Math.round((healedAt - cutAt) / 1000)} s after the cut:\n${home.tunnelLines.slice(tunnelsFrom).join('\n')}`)

  // The kernel client opens its channel again, the buffer is replayed, and only then is its kernel_info answered: the cell's
  // reply is in by then, so nothing is settled as lost, and the cell ends with every line it printed.
  // «c» was printed after the server let the channel go, so it reached the room by the replay alone.
  assert.deepEqual(await student.notebook.settled(cell, 120_000), { state: 'ok', text: 'a\nc\n', errors: [] }, 'the replay came before kernel_info')
  const since = textOf((await logsOf(container)).slice(logFrom))
  const replay = /Replaying (\d+) buffered messages/.exec(since)
  record(t, `kernel WebSocket: ${timeoutSaid ? `jupyter_server said "${timeoutSaid[0]}"` : 'jupyter_server logged no ping timeout'}; the channel closed ${Math.round((closedAt - cutAt) / 1000)} s into a cut healed at ${Math.round((healedAt - cutAt) / 1000)} s; ${resumed} streams resumed, ${reset} reset; ${replay ? `the client's reconnect was replayed ${replay[1]} messages before its kernel_info` : 'no "Replaying" line in jupyter_server\'s log'}`)

  const next = lead.notebook.add('print(x)')
  lead.control.send({ t: 'run', cellId: next })
  assert.equal(await lead.notebook.ok(next, 120_000), '7\n', 'the same kernel, its variables kept')
  await waitFor('the slot ready again', () => placementRow(id, 'room')?.state === 'ready', 60_000)
  assert.equal(placementRow(id, 'room')?.gen, placed.gen, 'no failover: without evidence of the path a silence proves nothing')
  assert.deepEqual(runnerEventsOf(runnerId, ['class_failover'], cutAt), [])
  closeTabs(lead, student)
})

/* ------------------------------------------------------------------ the council */

/** A student in the room: the control socket is all a council needs of them (their sheet is not in the document). */
interface Pupil {
  name: string
  control: Control
}

async function pupil(sessionId: string, name: string): Promise<Pupil> {
  return { name, control: await Control.open(sessionId, await join(sessionId, name)) }
}

/** The council as these attempts need it (§9.6): students run their own, on the pool, the epoch kept until asked for, no limit. */
const COUNCIL_RULES: Partial<CouncilSettings> = { studentRun: true, runLimitSec: null, rerunPauseSec: 0, lane: 'pool', refresh: 'manual' }

/** The pupil writes an attempt on their sheet and presses «Запустить»: how many frames their socket had heard, for `runFrom`. */
function attempt(who: Pupil, cell: string, text: string): number {
  const from = who.control.heard.length
  who.control.send({ t: 'council:draft', cellId: cell, text })
  who.control.send({ t: 'council:run', cellId: cell })
  return from
}

/** The run their sheet tells of since `from` (`council:mine`), as it stands: from its first frame said queued or running on. */
function runFrom(who: Pupil, cell: string, from: number): CouncilRun | null {
  const runs = who.control.heard.slice(from).flatMap((frame) => (frame.t === 'council:mine' && frame.cellId === cell && frame.state.run ? [frame.state.run] : []))
  return runs.some((run) => run.state === 'queued' || run.state === 'running') ? runs.at(-1)! : null
}

/** Until that run has ended (ok or error): it. */
async function ended(who: Pupil, cell: string, from: number, timeoutMs = 180_000): Promise<CouncilRun> {
  return waitFor(`${who.name}'s attempt to end`, () => {
    const run = runFrom(who, cell, from)
    return run && (run.state === 'ok' || run.state === 'error') ? run : null
  }, timeoutMs, () => JSON.stringify(runFrom(who, cell, from)), 100)
}

/** What a run printed: the last line it printed as JSON (every attempt here ends by saying what it found), and its errors as `name: words`. */
function said(run: CouncilRun): { json: Record<string, any> | null; errors: string[] } {
  const text = run.outputs.map((output) => (output.kind === 'stream' ? output.text : '')).join('')
  let json: Record<string, any> | null = null
  try {
    json = JSON.parse(lastLine(text)) as Record<string, any>
  } catch { /* it printed no JSON last */ }
  return { json, errors: run.outputs.flatMap((output) => (output.kind === 'error' ? [`${output.ename}: ${output.evalue}`] : [])) }
}

/** What the teacher's console last heard of the notebook's pool (`council:kernel`). */
function poolOf(lead: Tab, cell: string): CouncilPool | null {
  for (let i = lead.control.heard.length - 1; i >= 0; i--) {
    const frame = lead.control.heard[i]!
    if (frame.t === 'council:kernel' && frame.cellId === cell) return frame.kernel.pool ?? null
  }
  return null
}

/** Whether the console ever saw the notebook's own kernel compute an attempt of this cell. */
const mainComputedAnAttempt = (lead: Tab, cell: string): boolean =>
  lead.control.heard.some((frame) => frame.t === 'council:kernel' && frame.cellId === cell && frame.kernel.busy?.kind === 'attempt')

/**
 * Every attempt's first lines here, Python in a worker: its process's memory
 * as Linux says it (smaps_rollup, MB), a wait for a flag the test lays in the
 * council container's /tmp, what its process is — its id, its
 * oom_score_adj, its address-space ceiling — and what jupyter_server's is,
 * and whether an array's memory lies in a mapping of one of the epoch's
 * files (/proc/self/maps names the file a mapping holds): the attempt's
 * `base` and its frame's block (`_maps`, before anything writes them).
 */
const COUNCIL_PROLOGUE = [
  'import json, os, resource, time',
  'def _mem():',
  '    out = {}',
  "    with open('/proc/self/smaps_rollup') as handle:",
  '        for line in handle:',
  "            key, _, rest = line.partition(':')",
  "            if rest.strip().endswith('kB'):",
  '                out[key.strip()] = int(rest.split()[0]) // 1024',
  '    return out',
  'def _wait(name):',
  "    while not os.path.exists('/tmp/' + name):",
  '        time.sleep(0.05)',
  'def _server():',
  "    for pid in os.listdir('/proc'):",
  '        try:',
  "            cmd = open(f'/proc/{pid}/cmdline').read().replace('\\0', ' ')",
  "            if pid.isdigit() and 'jupyter' in cmd and 'ipykernel' not in cmd:",
  "                return {'cmd': cmd[:120], 'oom': int(open(f'/proc/{pid}/oom_score_adj').read())}",
  '        except OSError:',
  '            pass',
  '    return None',
  'def _self():',
  "    return {'pid': os.getpid(), 'oom': int(open('/proc/self/oom_score_adj').read()), 'as': resource.getrlimit(resource.RLIMIT_AS)[0], 'server': _server()}",
  'def _mapped(arr):',
  "    at = arr.__array_interface__['data'][0]",
  "    with open('/proc/self/maps') as handle:",
  '        for line in handle:',
  '            fields = line.split(None, 5)',
  "            low, high = (int(edge, 16) for edge in fields[0].split('-'))",
  '            if low <= at < high:',
  `                return len(fields) == 6 and fields[5].strip().startswith('${COUNCIL_EPOCHS_MOUNT}/')`,
  '    return False',
  'def _maps():',
  "    return {'base': _mapped(base), 'frame': _mapped(df._mgr.blocks[0].values)}",
].join('\n')

const megabytesOf = (bytes: number): number => Math.round(bytes / (1024 * 1024))
const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN

scenario('the council on the machine: real pandas exported by the class notebook\'s kernel there and loaded into four workers; each attempt on the epoch\'s mapped pages, its writes its own, the epoch\'s files untouched; a worker recycled past its memory per attempt by smaps_rollup; oom_score_adj 1000 and a ceiling of each attempt\'s own; a greedy attempt\'s MemoryError its author\'s alone; artifacts, the read-only class folder and the scratch root; the drop run on a real kernel', 600_000, async (t) => {
  const one = theMachine()
  // «Всё на машине», the council's pool there: four workers of 512 MB, a core each (AGENT_CPUS).
  const { id, by, lead, student, container } = await classOn('Паритет · консилиум', { room: 'machines', council: 'machines', workers: 4, attemptMb: 512 })
  const box = one.council(id)
  const flag = `parity-council-${RUN}`
  // A class file the attempts read where they work (§9.7): uploaded here, on the machine by the barrier.
  const data = csv(4 * 1024, 'class')
  assert.equal(await upload(id, by, 'data.csv', data), 200)

  // The teacher's state: a frame of 128 MB in one numeric block, an array of 32 MB, a fitted model and a function of the notebook's.
  const setup = lead.notebook.add([
    'import json',
    'import numpy as np, pandas as pd',
    'from sklearn.linear_model import LogisticRegression',
    'rng = np.random.default_rng(7)',
    'df = pd.DataFrame(rng.standard_normal((1_000_000, 16)), columns=[f"f{i}" for i in range(16)])',
    'base = np.arange(4_000_000, dtype=np.float64)',
    'model = LogisticRegression(max_iter=200).fit(df.iloc[:5000].to_numpy(), (df["f0"].iloc[:5000] > 0).to_numpy())',
    'def score(frame):',
    '    return round(float(frame["f1"].mean()), 9)',
    'first = float(df.iloc[0, 0])',
    "print(json.dumps({'first': first, 'score': score(df), 'model': int(model.predict(df.iloc[:1].to_numpy())[0])}))",
  ].join('\n'))
  lead.control.send({ t: 'run', cellId: setup })
  const teacher = JSON.parse(lastLine(await lead.notebook.ok(setup, 180_000))) as { first: number; score: number; model: number }

  /*
   * The council opens (§9.2, §9.5): its pool starts four workers in the
   * class's council container on the machine, and the class notebook's
   * kernel there exports its state into its own container's
   * /tmp/colloq-epoch, which the agent copies out (docker cp), takes into its
   * store by content and links into the epochs folder the workers map.
   */
  const council = lead.notebook.add('# решение')
  const openedAt = Date.now()
  lead.control.send({ t: 'cell:lock', cellId: council, state: 'council', settings: COUNCIL_RULES })
  const ready = await waitFor('the pool ready with four workers', () => {
    const pool = poolOf(lead, council)
    return pool?.state === 'ready' && pool.workers === 4 && pool.busy === 0 && !pool.refreezing && pool.epoch !== null ? pool : null
  }, 300_000, async () => `${JSON.stringify(poolOf(lead, council))}\n${home.classLines.slice(-10).join('\n')}\n${await one.tail(30)}`, 250)
  const readyIn = Date.now() - openedAt
  const epoch = epochsOf(id, CELLS_KEY)[0]!
  assert.deepEqual([epoch.seq, epoch.trouble, ready.epoch!.left], [ready.epoch!.seq, null, []], 'nothing left behind: pandas, numpy, the model and the function all travel')
  for (const name of ['df', 'base', 'model', 'score', 'first']) assert.ok(epoch.carried.includes(name), `${name} carried: ${JSON.stringify(epoch.carried)}`)
  assert.ok(epoch.source !== 'home' && epoch.source.runnerId === runnerId && epoch.source.role === 'room', `exported on the machine: ${JSON.stringify(epoch.source)}`)
  const files = epochFileList(epoch.files)
  record(t, `council: epoch ${epoch.seq}, ${megabytesOf(epoch.bytes)} MB in ${files.length} files (${files.map((file) => megabytesOf(file.bytes)).join(', ')} MB), exported by the class notebook's kernel on the machine; the pool ready with 4 workers ${seconds(readyIn)} s after the open`)
  // The frame's block and the array out of band, each a file of its own named by its content (§9.3).
  assert.ok(epoch.bytes >= 160_000_000 && files.some((file) => file.bytes >= 32_000_000), `the numeric data out of band: ${JSON.stringify(files)}`)
  // Taken out of the class notebook's container by the agent, and its folder there removed.
  await waitFor('the export\'s folder gone from the room container', async () => (await docker(['exec', container, 'test', '-e', `${COUNCIL_EPOCH_DIR}/${epoch.seq}`])).code === 1, 60_000)
  // The council container held to what its pool holds (§9.5): a worker's 512 MB, its baseline and the epoch's stream it
  // unpickles, four times, the epoch's files once and 512 MB; a core a worker. Grown live, by docker update, once the epoch came.
  const streamMb = Math.ceil((files.find((file) => file.sha256 === epoch.files!.body)?.bytes ?? 0) / (1024 * 1024))
  const sized = 4 * (512 + COUNCIL_WORKER_BASE_MB + streamMb) + Math.ceil(epoch.bytes / (1024 * 1024)) + 512
  await waitFor('the council container held to its epoch', async () => {
    const held = await inspectOf<{ HostConfig: { Memory: number; NanoCpus: number } }>(box)
    return livePlacement(id, 'council')?.memoryMb === sized && held?.HostConfig.Memory === sized * 1024 * 1024 && held.HostConfig.NanoCpus === 4e9
  }, 120_000, async () => `${sized} MB asked: ${JSON.stringify(livePlacement(id, 'council'))} ${JSON.stringify((await inspectOf<{ HostConfig: unknown }>(box))?.HostConfig)}`, 1_000)

  /*
   * COPY-ON-WRITE (§9.3 detail 3): four attempts at once, one a worker. The
   * writer writes in place into the array and the frame and keeps computing;
   * the three beside it read both whole meanwhile and see the teacher's
   * state, none of the writes, and reading writes nothing of a worker's own:
   * the pages are the epoch's file's, mapped copy-on-write. Each attempt
   * says, at its first line, that its array and its frame's block lie in a
   * mapping of an epoch file — the array in a fresh mapping of its own
   * (`_remap`), the block in its worker's — where an entry that copied them
   * instead would have spent the epoch's size on every attempt before its
   * first line, which nothing else here would see.
   */
  const pupils = await Promise.all(['Студентка 1', 'Студент 2', 'Студентка 3', 'Студент 4'].map((name) => pupil(id, name)))
  const reader = (go: string, afterWriter: boolean): string => [
    COUNCIL_PROLOGUE,
    'mapped = _maps()',
    ...(afterWriter ? [`_wait('${flag}-written')`] : []),
    'before = _mem()',
    'total = float(df.to_numpy().sum())',
    'read = _mem()',
    `_wait('${flag}-${go}')`,
    "print(json.dumps({'role': 'reader', **_self(), 'mapped': mapped, 'before': before, 'read': read, 'after': _mem(), 'base': base[:3].tolist(), 'first': float(df.iloc[0, 0]), 'score': score(df), 'model': int(model.predict(df.iloc[:1].to_numpy())[0]), 'total': total}))",
  ].join('\n')
  // Its write into the array measured alone: 32 MB into a clean mapping dirties as much, where a copy made at the entry was dirty already.
  const writer = [
    COUNCIL_PROLOGUE,
    'mapped = _maps()',
    'before = _mem()',
    'total = float(df.to_numpy().sum())',
    'read = _mem()',
    'base[:] = -1.0',
    'dirtied = _mem()',
    'df.iloc[0, 0] = -1.0',
    `open('/tmp/${flag}-written', 'w').close()`,
    `_wait('${flag}-go1')`,
    "print(json.dumps({'role': 'writer', **_self(), 'mapped': mapped, 'before': before, 'read': read, 'dirtied': dirtied, 'after': _mem(), 'base': base[:3].tolist(), 'first': float(df.iloc[0, 0]), 'total': total}))",
  ].join('\n')
  const atOnce = async (texts: readonly string[], go: string): Promise<Array<Record<string, any>>> => {
    const marks = pupils.map((who, i) => attempt(who, council, texts[i]!))
    await waitFor(`four attempts computing at once before ${go}`, () => pupils.every((who, i) => runFrom(who, council, marks[i]!)?.state === 'running') && poolOf(lead, council)?.busy === 4, 120_000,
      () => JSON.stringify({ pool: poolOf(lead, council), runs: pupils.map((who, i) => runFrom(who, council, marks[i]!)) }), 250)
    await dockerOk(['exec', box, 'touch', `/tmp/${flag}-${go}`])
    const runs = await Promise.all(pupils.map((who, i) => ended(who, council, marks[i]!)))
    return runs.map((run, i) => {
      const { json, errors } = said(run)
      assert.deepEqual([run.state, run.placed, errors], ['ok', 'pool', []], `${pupils[i]!.name}'s attempt: ${JSON.stringify(run)}`)
      assert.ok(json, `${pupils[i]!.name}'s attempt said nothing it found: ${JSON.stringify(run.outputs)}`)
      return json
    })
  }
  const round1 = await atOnce([writer, reader('go1', true), reader('go1', true), reader('go1', true)], 'go1')
  const [wrote, ...beside] = round1
  const megabytesFact = (values: number[]): string => `${median(values)} MB (${Math.min(...values)}–${Math.max(...values)})`
  record(t, `council: a worker before its attempt read anything: Private_Dirty ${megabytesFact(round1.map((seen) => seen.before.Private_Dirty))}, Rss ${megabytesFact(round1.map((seen) => seen.before.Rss))}, Pss ${megabytesFact(round1.map((seen) => seen.before.Pss))} (COUNCIL_WORKER_BASE_MB ${COUNCIL_WORKER_BASE_MB})`)
  record(t, `council: reading the whole frame and array: Private_Dirty +${megabytesFact(round1.map((seen) => seen.read.Private_Dirty - seen.before.Private_Dirty))}; the writer's 32 MB into its array +${wrote!.dirtied.Private_Dirty - wrote!.read.Private_Dirty} MB, then one value of its frame +${wrote!.after.Private_Dirty - wrote!.dirtied.Private_Dirty} MB (pandas copies the block it writes)`)
  record(t, `council: an attempt's RLIMIT_AS ${megabytesOf(median(round1.map((seen) => seen.as)))} MB; oom_score_adj ${round1.map((seen) => seen.oom).join(', ')} in the workers, ${JSON.stringify(round1[0]!.server)} for jupyter_server`)
  assert.equal(new Set(round1.map((seen) => seen.pid)).size, 4, 'four workers, each its own Python')
  for (const seen of round1) assert.deepEqual(seen.mapped, { base: true, frame: true }, `${seen.role}: its array and its frame's block in a mapping of an epoch file, never a copy made at its entry`)
  for (const seen of beside) {
    assert.deepEqual([seen.base, seen.first, seen.score, seen.model], [[0, 1, 2], teacher.first, teacher.score, teacher.model], 'the teacher\'s state, none of the writer\'s writes beside it')
    assert.equal(seen.total, wrote!.total, 'the same frame, read whole')
  }
  assert.deepEqual([wrote!.base, wrote!.first], [[-1, -1, -1], -1], 'the writer sees its own writes')
  assert.ok(wrote!.dirtied.Private_Dirty - wrote!.read.Private_Dirty >= 24, `the writer's 32 MB into its array dirtied ${wrote!.dirtied.Private_Dirty - wrote!.read.Private_Dirty} MB of its own: its pages were not a clean mapping`)
  for (const seen of round1) assert.ok(seen.read.Private_Dirty - seen.before.Private_Dirty < 32, `reading 160 MB of the epoch wrote ${seen.read.Private_Dirty - seen.before.Private_Dirty} MB of the worker's own`)

  // The next attempt of each worker, the writer's included, at once again: the same four Pythons, none recycled, and the
  // writer's pages went with its attempt (a fresh mapping each, dropped at leave).
  const round2 = await atOnce(pupils.map(() => reader('go2', false)), 'go2')
  record(t, `council: four readers at once: Shared_Clean ${megabytesFact(round2.map((seen) => seen.after.Shared_Clean ?? 0))}, Pss ${megabytesFact(round2.map((seen) => seen.after.Pss))}, Rss ${megabytesFact(round2.map((seen) => seen.after.Rss))}`)
  assert.deepEqual(round2.map((seen) => seen.pid).sort(), round1.map((seen) => seen.pid).sort(), 'the same four workers')
  for (const seen of round2) assert.deepEqual([seen.base, seen.first, seen.score, seen.mapped], [[0, 1, 2], teacher.first, teacher.score, { base: true, frame: true }], 'the epoch as the teacher left it, in every worker, mapped')
  // Nor did the writes reach the epoch's files: each still hashes to its name (MAP_PRIVATE never writes back).
  for (const file of files) {
    const hashed = await one.exec(['sha256sum', path.join(one.tree, 'council', id, 'epochs', file.sha256)])
    assert.equal(hashed.stdout.split(' ')[0], file.sha256, `${file.sha256.slice(0, 12)} as it was: ${hashed.stderr}`)
  }

  // oom_score_adj (§9.3 detail 5): every worker 1000, jupyter_server not, so the cgroup's OOM killer takes an attempt, never the
  // server and every session with it; and each attempt computes under an address-space ceiling of its own (the mandatory cap).
  for (const seen of [...round1, ...round2]) {
    assert.equal(seen.oom, 1000, `a worker's oom_score_adj: ${seen.oom}`)
    assert.ok(seen.server && seen.server.oom < 1000, `jupyter_server's oom_score_adj: ${JSON.stringify(seen.server)}`)
    assert.ok(seen.as > 0, `an attempt's RLIMIT_AS: ${seen.as}`)
  }

  /*
   * RECYCLED ON ITS MEMORY (§9.3 detail 4, §9.5): a worker whose attempts
   * left it holding more than «Память на попытку» since its seed restarts
   * and loads again before it serves on. The exit reads its Private_Dirty
   * from smaps_rollup (council-isolation.ts · _dirty) against the seed's own
   * reading, a path only Linux has. Two rounds of four at once, each attempt
   * keeping 280 MB past its exit where the exit restores nothing (a module's
   * dict), leave each worker 280 MB over its seed, under the 512 MB of
   * «Память на попытку», and then 560, over it: the same four Pythons serve
   * the second round, and four new ones, loaded with the same epoch, the
   * third.
   */
  const keeper = (go: string): string => [
    COUNCIL_PROLOGUE,
    "kept = json.__dict__.setdefault('_parity_kept', [])",
    'kept.append(bytearray(280 << 20))',
    `_wait('${flag}-${go}')`,
    "print(json.dumps({'role': 'keeper', **_self(), 'kept': 280 * len(kept), 'after': _mem()}))",
  ].join('\n')
  const workersOf = (seen: Array<Record<string, any>>): number[] => seen.map((one) => one.pid as number).sort((a, b) => a - b)
  const kept1 = await atOnce(pupils.map(() => keeper('keep1')), 'keep1')
  assert.deepEqual([workersOf(kept1), kept1.map((seen) => seen.kept)], [workersOf(round1), [280, 280, 280, 280]], 'the same four workers, each keeping one block')
  const kept2 = await atOnce(pupils.map(() => keeper('keep2')), 'keep2')
  assert.deepEqual([workersOf(kept2), kept2.map((seen) => seen.kept)], [workersOf(round1), [560, 560, 560, 560]], 'the same four again, under «Память на попытку» since their seed after one block each')
  const fresh = await atOnce(pupils.map(() => reader('reseeded', false)), 'reseeded')
  const keepers = new Set(workersOf(kept2))
  assert.ok(fresh.every((seen) => !keepers.has(seen.pid)), `four new Pythons once each held 560 MB: ${JSON.stringify(workersOf(fresh))} after ${JSON.stringify(workersOf(kept2))}`)
  for (const seen of fresh) assert.deepEqual([seen.base, seen.first, seen.score, seen.mapped, seen.oom], [[0, 1, 2], teacher.first, teacher.score, { base: true, frame: true }, 1000], 'loaded again with the epoch')
  record(t, `council: keeping 280 MB past each attempt: Private_Dirty ${megabytesFact(kept1.map((seen) => seen.after.Private_Dirty))} with one block, the same four workers; ${megabytesFact(kept2.map((seen) => seen.after.Private_Dirty))} with two, then recycled (over «Память на попытку», 512 MB since the seed): four new Pythons at ${megabytesFact(fresh.map((seen) => seen.before.Private_Dirty))}`)

  /*
   * A GREEDY ATTEMPT (§9.7): one asks for 2 GB, four times its ceiling, while
   * another computes on the worker beside it. The MemoryError is its
   * author's; the neighbour ends as it would have, and the notebook's own
   * kernel computes the teacher's next cell at once, on its own state.
   */
  const [greedy, neighbour] = pupils as [Pupil, Pupil, Pupil, Pupil]
  const n3 = attempt(neighbour, council, [COUNCIL_PROLOGUE, `_wait('${flag}-go3')`, "print(json.dumps({'role': 'neighbour', **_self(), 'score': score(df)}))"].join('\n'))
  await waitFor('the neighbour computing', () => runFrom(neighbour, council, n3)?.state === 'running', 60_000, () => JSON.stringify(runFrom(neighbour, council, n3)))
  const g3 = attempt(greedy, council, [COUNCIL_PROLOGUE, "print(json.dumps({'role': 'greedy', **_self()}), flush=True)", 'big = bytearray(2 * 1024 ** 3)', 'print(len(big))'].join('\n'))
  const failed = await ended(greedy, council, g3)
  assert.deepEqual([failed.state, failed.placed], ['error', 'pool'], JSON.stringify(failed))
  assert.ok(said(failed).errors.some((error) => error.startsWith('MemoryError')), `the greedy attempt's own error: ${JSON.stringify(said(failed).errors)}`)
  await dockerOk(['exec', box, 'touch', `/tmp/${flag}-go3`])
  const fine = await ended(neighbour, council, n3)
  assert.deepEqual([fine.state, said(fine).json?.score], ['ok', teacher.score], JSON.stringify(fine))
  const meanwhile = lead.notebook.add("print(json.dumps({'first': first}))")
  lead.control.send({ t: 'run', cellId: meanwhile })
  assert.equal(JSON.parse(lastLine(await lead.notebook.ok(meanwhile, 60_000))).first, teacher.first, 'the notebook\'s kernel computes on, its state its own')
  assert.ok(!mainComputedAnAttempt(lead, council), 'the console never saw the notebook\'s kernel compute an attempt')

  // The class container's cgroup as the kernel holds it: what the pool's processes take together, against its ceiling.
  const cgroup = (await docker(['exec', box, 'sh', '-c', 'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max 2>/dev/null'])).stdout.trim().split('\n')
  record(t, `council: the container's cgroup memory.current ${cgroup[0] ? megabytesOf(Number(cgroup[0])) : '?'} MB of memory.max ${cgroup[1] ? (cgroup[1] === 'max' ? 'max' : megabytesOf(Number(cgroup[1]))) : '?'} MB, its placement ${sized} MB; the greedy attempt: ${said(failed).errors.join(' | ')}`)

  /*
   * WHAT AN ATTEMPT SEES AND WRITES (§9.7, D10): it works in a folder of its
   * own under the scratch root, reads the class's file through it, cannot
   * write the class folder, and the file it writes comes home on its card.
   */
  const scribe = pupils[2]!
  const s4 = attempt(scribe, council, [
    'import json, os, stat',
    "with open('out.csv', 'w') as handle:",
    "    handle.write('id,v\\n1,2\\n')",
    `root = os.stat('${COUNCIL_SCRATCH_MOUNT}')`,
    'try:',
    `    os.listdir('${COUNCIL_SCRATCH_MOUNT}')`,
    "    listing = 'listed'",
    'except PermissionError:',
    "    listing = 'refused'",
    // A mode holds against the folder's owner only as long as the owner will not change it: chmod asks ownership, no permission bit.
    'try:',
    `    os.chmod('${COUNCIL_SCRATCH_MOUNT}', 0o1777)`,
    "    chmod = 'changed'",
    `    os.chmod('${COUNCIL_SCRATCH_MOUNT}', stat.S_IMODE(root.st_mode))`,
    'except PermissionError:',
    "    chmod = 'refused'",
    'try:',
    `    open('/workspace/${id}/spoiled.txt', 'w').close()`,
    '    spoiled = 0',
    'except OSError as error:',
    '    spoiled = error.errno',
    "print(json.dumps({'cwd': os.getcwd(), 'listing': listing, 'chmod': chmod, 'spoiled': spoiled, 'mode': oct(stat.S_IMODE(root.st_mode)), 'owner': root.st_uid, 'uid': os.getuid(), 'data': open('data.csv').read()}))",
  ].join('\n'))
  const wrote4 = await ended(scribe, council, s4)
  assert.deepEqual([wrote4.state, wrote4.placed], ['ok', 'pool'], JSON.stringify(wrote4))
  const found = said(wrote4).json
  assert.ok(found, `the scribe's attempt said nothing it found: ${JSON.stringify(wrote4.outputs)}`)
  record(t, `council: the scratch root ${found.mode}, owned by uid ${found.owner}; a worker (uid ${found.uid}) listing it: ${found.listing}, changing its mode: ${found.chmod}`)
  assert.match(found.cwd, /^\/colloq\/scratch\/[0-9a-f]{32}$/, 'its own folder, named by its run')
  assert.deepEqual([found.data, found.spoiled, found.uid], [data, 30, KERNEL_UID], 'the class file read through its folder; the class folder read-only (EROFS); the kernels\' uid')
  const body = 'id,v\n1,2\n'
  const kept = await waitFor('out.csv kept on the card', () => {
    const run = runFrom(scribe, council, s4)
    return run?.files?.some((file) => file.name === 'out.csv' && file.kept) ? run : null
  }, 120_000, () => JSON.stringify(runFrom(scribe, council, s4)?.files ?? null))
  assert.equal(fs.readFileSync(artifactPath(id, kept.runId!, sha256(body)), 'utf8'), body, 'here, by its content')
  assert.equal(homeFile(id, 'spoiled.txt'), null)

  /*
   * THE DROP RUN on a real kernel (council-pool.ts · dropMachineExport): the
   * silent execute that has a notebook's own kernel remove an export of its
   * container nobody will collect, sent as the pool sends it, to a kernel of
   * the class's image beside the class's; and nothing of the class's own
   * export is left in that container.
   */
  const roomDoor = await doorOf(container)
  const made = await rest<{ id: string }>(roomDoor, 'POST', '/api/kernels', { name: 'python3' })
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const dropSeq = 999_999
  const dropped = `${COUNCIL_EPOCH_DIR}/${dropSeq}`
  try {
    await dockerOk(['exec', container, 'sh', '-c', `mkdir -p ${dropped} && echo x > ${dropped}/left.bin`])
    const channel = await Channel.open(roomDoor, made.body.id, `parity-drop-${RUN}`)
    const drop = exportDropExpression(dropSeq)
    const asked = channel.send('shell', 'execute_request', { code: drop.code, silent: true, store_history: false, user_expressions: drop.userExpressions, allow_stdin: false, stop_on_error: true })
    assert.equal((await channel.answer(asked, 'execute_reply')).message.content.status, 'ok')
    channel.terminate()
    assert.equal((await docker(['exec', container, 'test', '-e', dropped])).code, 1, `${dropped} is still in the room container`)
  } finally {
    await rest(roomDoor, 'DELETE', `/api/kernels/${made.body.id}`)
  }
  assert.equal((await docker(['exec', container, 'sh', '-c', `ls -A ${COUNCIL_EPOCH_DIR} 2>/dev/null || true`])).stdout.trim(), '', 'no export left in the class notebook\'s container')
  for (const who of pupils) who.control.close()
  closeTabs(lead, student)

  /*
   * THE SCRATCH ROOT (runner-agent/council.ts · SCRATCH_MODE, K7a #17): a
   * folder of 1733 that a worker may enter and make its run's folder in but
   * never list, so that no attempt finds another's — and not the workers'
   * own: its owner may give it any mode (chmod asks ownership, no bit),
   * list it then, and take any run's folder out of it whatever the sticky
   * bit says. So the cause is pinned with the symptom: another owner than
   * the workers' uid, a mode they cannot change, a listing they cannot make.
   * Last: the agent and the kernels are both uid 1000 on a machine, and the
   * agent owns the folder.
   */
  assert.equal(found.mode, '0o1733')
  assert.notEqual(found.owner, found.uid, `the scratch root is owned by uid ${found.owner}, the workers' own: any attempt may change its mode, list it and take another's folder out of it`)
  assert.equal(found.chmod, 'refused', `a worker of uid ${found.uid} changed the scratch root's mode (${found.mode}, owned by uid ${found.owner})`)
  assert.equal(found.listing, 'refused', `a worker of uid ${found.uid} lists the scratch root (${found.mode}, owned by uid ${found.owner}): every attempt's folder can be found from another`)
})
