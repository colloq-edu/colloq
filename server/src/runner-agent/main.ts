/**
 * The agent of a machine that runs submissions for a home instance
 * («машина для посылок», docs/architecture/remote-runners.md): bundled as
 * dist/runner.js, which the image's entry point starts in `runner` mode
 * (deploy/vast/entrypoint.sh · runner), and whose sha256 next to it
 * (dist/runner.sha256) is the build home compares before it hands the machine
 * new work (the owner's decision 5).
 *
 *   node dist/runner.js                 the agent: joins when it must (COLLOQ_RUNNER_JOIN), then syncs
 *   node dist/runner.js join URL CODE   the same, with the join given as words
 *   node dist/runner.js status          JSON; exit 0 when joined and syncing (the container's health check)
 *   node dist/runner.js drain           the running agent takes nothing new; exit 0 once it holds nothing
 *   node dist/runner.js leave           drained, then revoked by its home, then the agent exits;
 *                                       with no agent running, the machine revokes itself from here
 *   node dist/runner.js version
 *
 * THE ENVIRONMENT IS THE ENTRY POINT'S. COLLOQ_RUNNER_STATE is the tree (by
 * default /var/lib/colloq-runner, the same path inside the agent's container
 * and on the host: a submission's container is started by the host's daemon,
 * which resolves `-v` on the host), and DATA_DIR must be its `data/`, set
 * before this process starts: data-dir.ts reads it once, when the storage
 * layout loads, which is before any line here runs (§13b note 10), so the
 * agent checks it and refuses rather than sets it. COLLOQ_RUNNER_JOIN is
 * `https://<home>#<code>`, the code after the `#` so that it never travels in
 * a request line (the entry point moves `join URL CODE` there too).
 * COLLOQ_RUNNER_CONTAINER and COLLOQ_RUNNER_IMAGE name the agent's own
 * container and image (sync.ts says what for); always set inside a container
 * (colloq-host passes them, the entry point derives them for a plain docker
 * run), and unset under make runner-dev, which means no container of its own:
 * never a guess at one, since a container that happens to be called
 * colloq-runner on a developer's daemon is not this agent's to update or
 * inspect (§13c note 20). HTTPS_PROXY, NO_PROXY and
 * NODE_EXTRA_CA_CERTS are honoured as the server honours them
 * (outbound.ts · installOutboundProxy).
 *
 * WHAT THIS BUNDLE MAY LOAD (tests/runner-import-graph.test.mts keeps it so):
 * the execution core — competitions/docker-runner.ts with the harness and the
 * storage layout, competitions/gpu-math.ts, kernel/card-probe.ts,
 * ops/meminfo.ts — the class cores (kernel/room-spec.ts, perimeter-core.ts,
 * postmortem-core.ts: a class kernel's argv, its perimeter and its reading,
 * kernels.ts) and the contract, but never the database, the room pool,
 * config.ts and its .env, or the release's version (version.ts says why).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { REMOTE_BUILD_DEV, REMOTE_BUILD_FILE, REMOTE_SILENCE_MS, parseRemoteBuildFile, parseRemoteJoinTarget } from '@shared/remote-runner'
import { dataDir } from '../data-dir.js'
import { installOutboundProxy } from '../outbound.js'
import { agentListening, askAgent, serveControl, type ControlMessage } from './control.js'
import { DEFAULT_STATE_ROOT, joined, readIdentity, readStatus, retired, stateLayout, type StateLayout } from './state.js'
import { Agent, STATUS_STALE_MS, type AgentOptions } from './sync.js'
import { runnerVersion } from './version.js'

/** EX_USAGE and EX_CONFIG: a command line, or a container started without what it needs. */
const EX_USAGE = 64
const EX_CONFIG = 78

/** A `leave` with no agent running gives up after this: home unreachable that long is not a leave. */
const ONE_OFF_LEAVE_MS = 10 * 60_000

const USAGE = `colloq-runner: a machine that runs another Colloq instance's submissions

  node dist/runner.js                 run (COLLOQ_RUNNER_JOIN='https://<home>#<code>' on the first start)
  node dist/runner.js join URL CODE   run, joining with the words given
  node dist/runner.js status          joined and syncing? (JSON; exit 0 when so)
  node dist/runner.js drain           take nothing new; return once nothing is held
  node dist/runner.js leave           finish what is held, revoke this machine on its home, stop
  node dist/runner.js version

The tree: COLLOQ_RUNNER_STATE (default ${DEFAULT_STATE_ROOT}), with DATA_DIR=<tree>/data.
`

/** What the process writes; tests hand their own. */
export interface Io {
  out: (text: string) => void
  err: (text: string) => void
}

/** What an agent started from here talks to: the machine's docker and runner, and fetch. Tests hand stand-ins; nothing else does. */
export type Seams = Pick<AgentOptions, 'docker' | 'runner' | 'fetch'>

const processIo: Io = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) }

/** The command line, run: the exit code. Exported for tests; the bundle runs it when it is the entry. */
export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, io: Io = processIo, seams: Seams = {}): Promise<number> {
  const [command = 'run', ...rest] = argv
  const layout = stateLayout(env.COLLOQ_RUNNER_STATE?.trim() || DEFAULT_STATE_ROOT)
  switch (command) {
    case 'run':
      if (rest.length > 0) return usage(io)
      return runAgent(layout, env.COLLOQ_RUNNER_JOIN, env, io, seams)
    case 'join': {
      if (rest.length !== 2) return usage(io)
      return runAgent(layout, `${rest[0]!.replace(/\/+$/, '')}#${rest[1]}`, env, io, seams)
    }
    case 'status':
      return status(layout, io)
    case 'drain':
      return drain(layout, io)
    case 'leave':
      return leave(layout, env, io, seams)
    case 'version':
      io.out(`${runnerVersion()}\n`)
      return 0
    case 'help':
    case '-h':
    case '--help':
      io.out(USAGE)
      return 0
    default:
      return usage(io)
  }
}

function usage(io: Io): number {
  io.err(USAGE)
  return EX_USAGE
}

/* ----------------------------------------------------------------- run */

/**
 * What a machine needs before its agent starts, said and refused rather than
 * found out later: DATA_DIR inside its tree, no DATA_HOST_DIR (the paths are
 * the host's own), a join or an identity, and no other agent on the tree.
 */
async function configured(layout: StateLayout, env: NodeJS.ProcessEnv, io: Io): Promise<boolean> {
  if (path.resolve(dataDir) !== layout.dataDir) {
    io.err(`colloq-runner: DATA_DIR is ${dataDir}, and this machine's tree is ${layout.root}: start the agent with DATA_DIR=${layout.dataDir} (the image's entry point does).\n`)
    return false
  }
  if ((env.DATA_HOST_DIR ?? '').trim()) {
    io.err('colloq-runner: DATA_HOST_DIR is set; a machine hands the daemon its own paths, and its tree is mounted at the same path on the host. Unset it.\n')
    return false
  }
  if (await agentListening(layout.socket)) {
    io.err(`colloq-runner: another agent already runs on ${layout.root}.\n`)
    return false
  }
  return true
}

async function runAgent(layout: StateLayout, joinText: string | undefined, env: NodeJS.ProcessEnv, io: Io, seams: Seams): Promise<number> {
  const given = (joinText ?? '').trim()
  const target = given ? parseRemoteJoinTarget(given) : null
  if (given && !target) {
    io.err('colloq-runner: COLLOQ_RUNNER_JOIN is not https://<home>#<code> (the home\'s origin, then its owner\'s 32-digit code after #).\n')
    return EX_CONFIG
  }
  const identity = readIdentity(layout)
  if (!target && !joined(identity)) {
    io.err(`colloq-runner: this machine has not joined a home, and COLLOQ_RUNNER_JOIN is not set: -e COLLOQ_RUNNER_JOIN='https://<home>#<code>'.\n`)
    return EX_CONFIG
  }
  if (!(await configured(layout, env, io))) return EX_CONFIG
  await installOutboundProxy(env)
  const build = runnerBuild()
  const version = runnerVersion({ env })
  io.err(`colloq-runner ${version} (build ${build === REMOTE_BUILD_DEV ? REMOTE_BUILD_DEV : build.slice(0, 12)}), tree ${layout.root}\n`)
  const agent = new Agent({
    ...seams,
    layout,
    join: target,
    build,
    version,
    container: env.COLLOQ_RUNNER_CONTAINER?.trim() || null,
    image: env.COLLOQ_RUNNER_IMAGE?.trim() || null,
    env,
  })
  let server: Awaited<ReturnType<typeof serveControl>>
  try {
    server = await serveControl(agent, layout.socket)
  } catch (error) {
    io.err(`colloq-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    return EX_CONFIG
  }
  const signals = (): void => {
    void agent.stop()
  }
  process.on('SIGTERM', signals)
  process.on('SIGINT', signals)
  try {
    const exit = await agent.run()
    if (exit.detail && exit.code !== 0) io.err(`colloq-runner: ${exit.detail}\n`)
    return exit.code
  } finally {
    process.off('SIGTERM', signals)
    process.off('SIGINT', signals)
    server.close()
    fs.rmSync(layout.socket, { force: true })
  }
}

/**
 * The build home compares (decision 5): the sha256 of dist/runner.js, which
 * the build writes beside it (REMOTE_BUILD_FILE). A bundle without that file
 * is its own bytes' hash; the sources (make runner-dev) are `dev`, which only
 * a home of make dev matches.
 */
export function runnerBuild(dir = path.dirname(fileURLToPath(import.meta.url))): string {
  try {
    const said = parseRemoteBuildFile(fs.readFileSync(path.join(dir, REMOTE_BUILD_FILE), 'utf8'))
    if (said) return said
  } catch { /* no build file here */ }
  const self = path.join(dir, path.basename(fileURLToPath(import.meta.url)))
  if (path.basename(self) === 'runner.js') {
    try {
      return createHash('sha256').update(fs.readFileSync(self)).digest('hex')
    } catch { /* not readable */ }
  }
  return REMOTE_BUILD_DEV
}

/* --------------------------------------------------------------- status */

const WORKING = new Set(['active', 'draining', 'leaving'])

/**
 * The status the running agent keeps (status.json), never home's: the health
 * check runs it every half minute, so it reads two files of the tree and asks
 * nobody (no call to home, no docker, no socket). Healthy is joined, working,
 * written by a live agent lately, and heard by home within REMOTE_SILENCE_MS —
 * the silence after which home starts to count the machine's leases lost.
 */
export function status(layout: StateLayout, io: Io, now = Date.now()): number {
  const kept = readStatus(layout)
  const identity = readIdentity(layout)
  const live = kept !== null && now - kept.updatedAt <= STATUS_STALE_MS && alive(kept.pid)
  const state = kept && live ? kept.state : identity && retired(identity) ? (identity.leftAt !== undefined ? 'left' : 'revoked') : 'stopped'
  const report = {
    joined: (kept?.joined ?? false) || (joined(identity) && !retired(identity)),
    home: kept?.home ?? identity?.home ?? null,
    runnerId: kept?.runnerId ?? identity?.runnerId ?? null,
    state,
    held: live ? kept!.held : 0,
    version: kept?.version ?? runnerVersion(),
    ...(kept?.homeVersion ? { homeVersion: kept.homeVersion } : {}),
    compatible: kept?.compatible ?? null,
    trusted: kept?.trusted ?? null,
    // The owner's «Места» as home last said it: the running agent's word, or else the one written down with the identity.
    approvedSlots: kept && 'approvedSlots' in kept ? kept.approvedSlots : identity?.approvedSlots ?? null,
    path: live ? kept!.path : null,
    problem: kept?.problem ?? null,
    syncedAt: kept?.syncedAt ?? null,
    updatedAt: kept?.updatedAt ?? null,
    // The class tunnel and the class containers (remote-classes.md §14), a live agent's word: none without one.
    tunnel: live ? kept!.tunnel ?? null : null,
    classes: live ? kept!.classes ?? { room: 0, own: 0, council: 0 } : { room: 0, own: 0, council: 0 },
  }
  io.out(`${JSON.stringify(report)}\n`)
  const healthy = live && report.joined && WORKING.has(state) && kept!.syncedAt !== null && now - kept!.syncedAt <= REMOTE_SILENCE_MS
  return healthy ? 0 : 1
}

/** Whether a process with this pid runs, as far as this one can tell (EPERM: it does, as someone else). */
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/* --------------------------------------------------------- drain, leave */

function progress(io: Io): (message: ControlMessage) => void {
  return (message) => {
    if ('held' in message) io.err(`colloq-runner: ${message.held} run(s) held, finishing (${message.state})\n`)
    else if ('error' in message) io.err(`colloq-runner: ${message.error}\n`)
  }
}

async function drain(layout: StateLayout, io: Io): Promise<number> {
  let drained = false
  const said = progress(io)
  const how = await askAgent(layout.socket, 'drain', (message) => {
    if ('drained' in message) drained = true
    said(message)
  })
  if (how === 'no-agent') {
    io.err('colloq-runner: no agent runs on this tree, so nothing is held.\n')
    return 1
  }
  if (!drained) {
    io.err('colloq-runner: the agent did not finish draining (it restarted or stopped); its runs go back to the home\'s queue when it stops.\n')
    return 1
  }
  io.err('colloq-runner: drained: nothing is held.\n')
  return 0
}

async function leave(layout: StateLayout, env: NodeJS.ProcessEnv, io: Io, seams: Seams): Promise<number> {
  let left = false
  let revoked = false
  const said = progress(io)
  const how = await askAgent(layout.socket, 'leave', (message) => {
    if ('left' in message) {
      left = true
      revoked = message.revoked === true
    }
    said(message)
  })
  if (how !== 'no-agent') {
    // Revoked by its owner while it drained: gone from its home all the same, which is what a leave is for.
    if (left) io.err(`colloq-runner: left: the home no longer counts on this machine${revoked ? ' (its owner revoked it while it finished its runs)' : ''}.\n`)
    return left ? 0 : 1
  }
  // No agent runs here (the machine's container is stopped): this process revokes the machine itself.
  const identity = readIdentity(layout)
  if (!joined(identity)) {
    io.err('colloq-runner: this machine has not joined a home: there is nothing to leave.\n')
    return 0
  }
  if (retired(identity)) {
    io.err(`colloq-runner: this machine has already ${identity.leftAt !== undefined ? 'left its home' : 'been revoked by its home'}.\n`)
    return 0
  }
  if (!(await configured(layout, env, io))) return EX_CONFIG
  await installOutboundProxy(env)
  const agent = new Agent({
    ...seams,
    layout,
    // Never a new join on the way out: the identity on the disk is the one that leaves.
    join: null,
    build: runnerBuild(),
    version: runnerVersion({ env }),
    container: env.COLLOQ_RUNNER_CONTAINER?.trim() || null,
    image: env.COLLOQ_RUNNER_IMAGE?.trim() || null,
  })
  void agent.requestLeave()
  agent.leaveAcknowledged()
  const timer = setTimeout(() => void agent.stop(), ONE_OFF_LEAVE_MS)
  timer.unref?.()
  try {
    const exit = await agent.run()
    if (exit.reason === 'left' || exit.reason === 'revoked') {
      io.err('colloq-runner: left: the home no longer counts on this machine.\n')
      return 0
    }
    io.err(`colloq-runner: the machine did not leave: ${exit.detail ?? exit.reason}.\n`)
    return 1
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------ the entry */

/**
 * Run only as the program (dist/runner.js, or the sources under make
 * runner-dev), never when a test imports it. Compared by real path: node
 * names the main module by it (a checkout under a symlink, macOS's /var), and
 * the command line keeps whatever was typed.
 */
function realPath(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`colloq-runner: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
