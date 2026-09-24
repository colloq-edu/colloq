import { tr } from '@shared/i18n'
import { kernelBackend, requireKernelIsolation, kernelRuntimeClient, runtimeEnvironment, imageRevision } from './runtime-client.js'
import { sessionCpus, sessionEnvironment, sessionKernelRevision, pinSessionKernelRevision, sessionMemoryMb, sessionRowExists, storedRules } from '../db.js'
import { blockKernelStarts, kernelRetirementInProgress } from './retirement.js'
import { hasWorkAllocation, observedWorkMemory, releaseWorkAllocation, reserveWork, type WorkLease } from '../ops/work-budget.js'
/** Production starts fixed, isolated Pods through the private runtime broker.
 * The direct Docker adapter is retained only for explicit local development.
 * Neither backend falls back to a shared Jupyter server. */
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { activeName, needsGpu } from '../environments.js'
import { sessionDir } from '../workspace.js'
import { defaultEndpoint, type KernelEndpoint } from './jupyter.js'
import {
  ROOM_NETWORK,
  ROOM_PROFILE,
  ensureRoomPerimeter,
  perimeterStale,
  roomHardeningArgs,
  warmPerimeter,
  type RoomNetworkTarget,
} from './perimeter.js'

const IMAGE_PREFIX = 'colloq-kernel'
const ROOM_PREFIX = 'colloq-room'

interface RunResult {
  code: number
  out: string
}

function run(args: string[], timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args)
    let out = ''
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (err) => {
      clearTimeout(kill)
      resolve({ code: -1, out: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(kill)
      resolve({ code: code ?? -1, out: out.trim() })
    })
  })
}

/**
 * Whose container this is: the class's, or that of its students' personal
 * notebooks.
 *
 * A room has two containers, and the second is created lazily, on the first
 * run in a personal notebook. Why it has to be separate rather than a second
 * process inside the first is explained in shared/rules.ts · bookHasOwnKernel:
 * a GPU is given to a container as a whole, and the OOM killer under a shared
 * limit picks the heaviest process, that is, the lecture's kernel rather than
 * the greedy student.
 *
 * A live container without the `colloq.role` label reads as `room`: that is
 * how ALL containers started before this change look, and they must survive a
 * rollout without being recreated.
 */
export type KernelRole = 'room' | 'own'

/**
 * This instance cannot give a personal notebook a kernel of its own, and that
 * is an honest refusal, not a failure.
 *
 * It happens exactly on the broker (k3s): it creates one Pod per class, and a
 * second one, without the GPU card, means changing its protocol, its
 * controller and its permissions in the cluster. Running a personal notebook
 * in the lecture's kernel instead of refusing is not an option: that is the
 * very trouble the second container exists to avoid, the class's GPU in a
 * student's hands and an OOM killer that picks the teacher's kernel.
 *
 * A class of its own rather than a string: `ensureKernel` catches it apart
 * from network failures; "that did not work, try again" would be untrue here,
 * there is nothing to retry.
 */
export class OwnKernelUnavailable extends Error {
  constructor() {
    super(tr('server.kernel.ownUnavailable'))
    this.name = 'OwnKernelUnavailable'
  }
}

/**
 * The Jupyter token for one container.
 *
 * Derived from the instance secret rather than issued at random: a container
 * outlives a server restart, and a random token would have to be stored
 * somewhere, or lost together with access to a live kernel in the middle of a
 * lesson. It differs between rooms, so a cell that reads its own
 * `JUPYTER_TOKEN` does not open the neighboring ones.
 *
 * And it differs between the two containers of the SAME room: otherwise a line
 * in a student's personal notebook would open the lecture's Jupyter, that is,
 * other people's kernels, other people's variables and someone else's
 * `execute`, with exactly the token that sits in its environment. The old
 * string (`jupyter:<id>`) stays with the room so that live containers answer
 * to their own token after a rollout instead of all being recreated at once.
 */
function roomToken(sessionId: string, role: KernelRole = 'room'): string {
  return createHmac('sha256', config.sessionSecret)
    .update(role === 'own' ? `jupyter:own:${sessionId}` : `jupyter:${sessionId}`)
    .digest('hex')
    .slice(0, 40)
}

const containerFor = (sessionId: string, role: KernelRole = 'room') =>
  role === 'own' ? `${ROOM_PREFIX}-${sessionId}-own` : `${ROOM_PREFIX}-${sessionId}`

/**
 * The key under which the pool remembers one container: its address, a start
 * in progress, whether it was abandoned.
 *
 * For the room container it is the class id itself, letter for letter as
 * before: the `endpoints`/`starting` maps have survived a dozen changes with
 * this key, and changing it would mean rewriting each of them for the sake of
 * one suffix. For the personal-notebook container it is `<id>#own`; a class id
 * never contains `#` (shared/runtime.ts · RUNTIME_SESSION_ID), so the key can
 * be parsed back exactly.
 */
const slotFor = (sessionId: string, role: KernelRole): string =>
  role === 'own' ? `${sessionId}#own` : sessionId

/** The class the slot belongs to. */
const sessionOfSlot = (slot: string): string => {
  const cut = slot.indexOf('#')
  return cut < 0 ? slot : slot.slice(0, cut)
}

/**
 * How much memory and CPU the personal-notebook container gets.
 *
 * The class's own number if the teacher named one (the `ownMemoryMb`/`ownCpus`
 * rule), otherwise exactly as much as the room has. One place for the whole
 * pool: both a container start and a limit change on a live class ask this
 * question, and if they diverged they would produce a container started with
 * one number and updated with another.
 *
 * No class row in the database (a test, a deleted room) means the room's
 * numbers: that is the old behavior and the only answer that is sure not to
 * lie.
 */
export function ownLimits(sessionId: string): { memoryMb: number | null; cpus: number | null } {
  const room = { memoryMb: sessionMemoryMb(sessionId), cpus: sessionCpus(sessionId) }
  try {
    const rules = storedRules(sessionId)
    return {
      memoryMb: rules.ownMemoryMb ?? room.memoryMb,
      cpus: rules.ownCpus ?? room.cpus,
    }
  } catch {
    return room
  }
}

/**
 * The cap on LIVE personal kernels in one class.
 *
 * A personal-notebook container holds dozens of kernels, and each is a Python
 * with ipykernel: some fifteen threads and a hundred megabytes idle. Without a
 * cap a cohort of five hundred, each with three drafts, brings the container
 * down (and everyone's work with it) on `--pids-limit` or the memory limit,
 * silently and in the middle of the lesson. With the cap the extra run gets a
 * sentence, and the class goes on.
 *
 * Forty is "the whole group works on their own at once" with room to spare; a
 * cohort does not open that many personal notebooks at once, and if it does,
 * the teacher learns about it from a refusal, not from a dead container.
 */
export function ownKernelMax(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number((env.KERNEL_OWN_MAX ?? '').trim())
  return Number.isInteger(value) && value >= 1 ? value : 40
}

/**
 * After how many idle minutes a PERSONAL notebook's kernel is shut down; `0`
 * means never.
 *
 * For the class's kernels idleness is counted per room: empty for two hours,
 * and the whole container goes (kernel/index.ts · IDLE_KERNEL_MS). For
 * personal notebooks that is not enough, and they count differently. A class
 * left open all day keeps a kernel for every draft anyone ever ran: forty
 * Pythons at a hundred megabytes each, idle, and none of them needed by anyone,
 * since people work in two or three. The `KERNEL_OWN_MAX` cap does not help
 * with that; it only refuses the FORTY-FIRST.
 *
 * Half an hour means "went on a break and came back", not "closed the draft":
 * in a ninety-minute lesson a kernel that computed nothing for half an hour
 * almost certainly holds no variables anyone needs. The cost of a mistake is
 * small and stated out loud: a note in the notebook and one Run to start the
 * kernel again.
 *
 * `0` is the off switch for anyone whose lessons work differently.
 */
export function ownIdleMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.KERNEL_OWN_IDLE_MIN ?? '').trim()
  if (raw === '0') return 0
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 ? value : 30
}

/**
 * Whom to tell that the room's container had to be recreated.
 *
 * Recreating means a new Python: the seminar's variables, the open terminal
 * and everything the kernel had computed stay in the removed container. That
 * must not happen silently, yet nothing here can call `kernelNote`:
 * kernel/index.ts depends on the pool, not the other way round. So the pool
 * announces, and whoever holds the room's document installs the listener.
 */
type RecreateListener = (sessionId: string, why: string, role: KernelRole) => void
const recreateListeners: RecreateListener[] = []

export function onRoomKernelRecreated(cb: RecreateListener): void {
  recreateListeners.push(cb)
}

function announceRecreate(sessionId: string, why: string, role: KernelRole): void {
  for (const cb of [...recreateListeners]) {
    try {
      cb(sessionId, why, role)
    } catch (err) {
      console.error(`[kernel] recreate listener failed for ${sessionId}:`, err)
    }
  }
}

/** The host port Docker gave a container, read back after it started. */
async function publishedPort(container: string): Promise<number | null> {
  const res = await run(['port', container, '8888/tcp'])
  if (res.code !== 0) return null
  // "0.0.0.0:54321" or "[::]:54321\n0.0.0.0:54321"
  const match = res.out.match(/:(\d+)\s*$/m)
  const port = match ? Number(match[1]) : NaN
  return Number.isFinite(port) ? port : null
}

/**
 * The state of the room's container, in three answers rather than two.
 *
 * "Not running" is not yet "stopped": `dead` (docker could not finish it off,
 * usually for lack of disk space), `paused` and `restarting` do not come up
 * with `docker start`. Treating them as stopped, the server called `start`,
 * did not look at the result, found no port, and answered "could not read the
 * published port" to every Run until the end of the lesson. Such a container
 * has to be recreated, not woken up.
 */
async function stateOf(container: string): Promise<'running' | 'stopped' | 'broken' | 'missing'> {
  const res = await run(['inspect', container, '--format', '{{.State.Status}}'])
  if (res.code !== 0) return 'missing'
  const status = res.out.trim()
  if (status === 'running') return 'running'
  return status === 'created' || status === 'exited' ? 'stopped' : 'broken'
}

async function imageExists(image: string): Promise<boolean> {
  const res = await run(['image', 'inspect', image, '--format', '{{.Id}}'])
  return res.code === 0
}

/** Whether a container was created from the image this environment now has. */
async function sameImage(container: string, image: string): Promise<boolean> {
  const [running, current] = await Promise.all([
    run(['inspect', container, '--format', '{{.Image}}']),
    run(['image', 'inspect', image, '--format', '{{.Id}}']),
  ])
  if (running.code !== 0 || current.code !== 0) return true
  return running.out.trim() === current.out.trim()
}

/**
 * The names docker uses for "the default network" when no `--network` was given.
 *
 * There is more than one. Docker 20 wrote the word `default` into
 * `HostConfig.NetworkMode`, while Docker 24+ writes the real network name,
 * `bridge`. Comparing against `default` alone NEVER matched on a modern daemon:
 * every first Run after a server restart in host mode declared "the server
 * changed networks", removed the room's container with all its variables and
 * started an empty one, silently, in the middle of the lesson, exactly against
 * what `shutdownKernels` was written for.
 */
const BARE_NETWORKS = new Set(['default', 'bridge'])

/**
 * Whether the network mode string matches the network we now look for the
 * container in.
 *
 * A pure function, because this rule is exactly what has to be proven, and
 * there is no real docker in the tests.
 */
export function networkMatches(mode: string, network: string): boolean {
  const actual = mode.trim()
  if (!network) return BARE_NETWORKS.has(actual)
  return actual === network
}

/**
 * Whether the container is in the network we now look for it in.
 *
 * An instance that moved from `make run` to `make up` (or back) finds by name
 * a container from the previous mode: with a published port and without our
 * network, or the other way round. There is no route to it in the new mode,
 * and the room would wait ninety seconds for an answer on every Run;
 * recreating is cheaper.
 *
 * The mode string is only the first, cheap question. If it does not match, we
 * ask what we actually care about: whether there is a route to the container
 * in OUR mode. In host mode that is a published port, in network mode
 * membership in our network. That way the next name a future docker version
 * invents costs one extra call, not the seminar's lost variables.
 */
async function sameNetwork(container: string, network: string): Promise<boolean> {
  const res = await run(['inspect', container, '--format', '{{.HostConfig.NetworkMode}}'])
  if (res.code !== 0) return true
  if (networkMatches(res.out.trim(), network)) return true
  if (!network) return (await publishedPort(container)) !== null
  const joined = await run([
    'inspect',
    container,
    '--format',
    '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}',
  ])
  if (joined.code !== 0) return false
  return joined.out.trim().split(/\s+/).includes(network)
}

/** The hardened profile version the container was started with; empty means it was started before the profile. */
async function profileOf(container: string): Promise<string> {
  const res = await run(['inspect', container, '--format', '{{index .Config.Labels "colloq.profile"}}'])
  if (res.code !== 0) return ''
  const label = res.out.trim()
  return label === '<no value>' ? '' : label
}

/**
 * Whether there is a route to a live container started before the profile:
 * the one it was reached by back then.
 *
 * On the host it sits in `bridge` with a published port, and that port still
 * works: it does not need the `colloq-rooms` network to last out the lesson.
 * In the container form the network did not change at all, so membership in
 * it is enough.
 */
async function legacyReachable(container: string, network: string): Promise<boolean> {
  if (publishes()) return (await publishedPort(container)) !== null
  return sameNetwork(container, network)
}

/** Said once per room: a live container without the profile is a hole until it stops. */
const legacyWarned = new Set<string>()

function warnLegacy(sessionId: string): void {
  if (legacyWarned.has(sessionId)) return
  legacyWarned.add(sessionId)
  console.warn(
    `[kernel] room ${sessionId} keeps its pre-hardening container (default privileges, open network) until it stops; the next start recreates it hardened`,
  )
}

/** Coalesce probes and retry outages with bounded backoff. Positive results
 * also expire, so daemon/network changes become visible without a restart. */
class AvailabilityProbe {
  private pending: Promise<boolean> | null = null
  private checkedAt = 0
  private retryAt = 0
  private available: boolean | null = null
  private failures = 0
  private probes = 0
  private recoveries = 0
  status() {
    return { available: this.available, retryAt: this.retryAt, failures: this.failures, probes: this.probes, recoveries: this.recoveries }
  }
  check(probe: () => Promise<boolean>): Promise<boolean> {
    if (this.pending) return this.pending
    const now = Date.now()
    if (this.available !== null && now >= this.checkedAt && now < this.retryAt)
      return Promise.resolve(this.available)
    this.probes = Math.min(Number.MAX_SAFE_INTEGER, this.probes + 1)
    this.pending = probe().catch(() => false).then((available) => {
      if (available && this.available === false) this.recoveries = Math.min(Number.MAX_SAFE_INTEGER, this.recoveries + 1)
      this.failures = available ? 0 : Math.min(16, this.failures + 1)
      this.available = available
      this.checkedAt = Date.now()
      this.retryAt = this.checkedAt + (available ? 30000 : Math.min(30000, 1000 * 2 ** (this.failures - 1)))
      return available
    }).finally(() => { this.pending = null })
    return this.pending
  }
}
const dockerReady = new AvailabilityProbe()

function haveDocker(): Promise<boolean> {
  if (kernelBackend() !== 'docker') return Promise.resolve(false)
  return dockerReady.check(async () => {
    const res = await run(['version', '--format', '{{.Server.Version}}'], 5_000)
    const ok = res.code === 0
    if (!ok && dockerReady.status().available !== false) {
      console.warn('[kernel] Docker is unavailable. Isolated room execution is disabled until the development runtime is restored.')
    }
    return ok
  })
}

/** Said once: there is no point repeating it on every Run. */
let networkWarned = false

function warnOnce(text: string): void {
  if (networkWarned) return
  networkWarned = true
  console.warn(text)
}

let networkName = ''
let networkReady = new AvailabilityProbe()

function networkExists(network: string): Promise<boolean> {
  if (network !== networkName) {
    networkName = network
    networkReady = new AvailabilityProbe()
    networkWarned = false
  }
  return networkReady.check(async () => (await run(['network', 'inspect', network, '--format', '{{.Id}}'], 5_000)).code === 0)
}

/** Bounded, credential-free recovery state for operational health. */
export function kernelRecoveryDiagnostics() {
  return { docker: dockerReady.status(), network: networkReady.status() }
}

/** Check the selected runtime; an unavailable backend disables execution. */
async function canIsolate(): Promise<boolean> {
  try { requireKernelIsolation() } catch { return false }
  if (kernelBackend() === 'broker') return (await kernelRuntimeClient().health()).ok
  if (kernelBackend() === 'test') return false
  if (!(await haveDocker())) return false
  if (!inContainer()) return true

  const network = roomNetwork()
  if (!network) {
    warnOnce(
      '[kernel] KERNEL_NETWORK is missing. Isolated room execution is disabled.',
    )
    return false
  }
  if (!(await networkExists(network))) {
    warnOnce(`[kernel] Network ${network} is unavailable. Isolated room execution is disabled.`)
    return false
  }
  return true
}

/** Whether this room really has its own container, for the panel, so it does not promise too much. */
export function isolationAvailable(): Promise<boolean> {
  return canIsolate()
}

/**
 * The room network and the ban on local addresses, set up in advance at
 * server start.
 *
 * iptables rules survive a server restart but not a reboot of the colima or
 * Docker Desktop VM; this way a failure also shows in the log before the
 * lesson rather than on the first Run. An error here does not bring the server
 * down: the rooms will refuse on their own, with their own text.
 */
export async function warmRoomPerimeter(): Promise<void> {
  if (kernelBackend() !== 'docker') return
  if (!(await canIsolate())) return
  await warmPerimeter(run, perimeterTarget(), `${IMAGE_PREFIX}:${activeName()}`)
}

/**
 * The rooms whose containers live on this machine right now, by docker label.
 *
 * Not the same as `runningRoomKernels()`: that map is filled only by starts in
 * THIS process, so after a server restart the containers of yesterday's
 * seminars ceased to exist for the idle sweep and lived until `make down`. The
 * label is set by `docker run` below, and it outlives us.
 */
export async function listRoomKernels(): Promise<Array<{ session: string; running: boolean; own: boolean }>> {
  if (kernelBackend() === 'broker') return (await kernelRuntimeClient().rooms()).map(room => ({session:room.sessionId,running:room.phase === 'ready' || room.phase === 'pending',own:false}))
  if (kernelBackend() === 'test') return []
  /*
   * By CLASSES, not by containers: a room has two of them.
   *
   * A row per container would mean the idle sweep handles the same room twice,
   * and the panel counts it as live twice. It is live if at least one of the
   * two is: the personal-notebook container is stopped while the lecture is
   * computing, that is a working class, and it is too early for its two-hour
   * countdown.
   */
  const rooms = new Map<string, { running: boolean; own: boolean }>()
  for (const room of await roomContainers()) {
    if (room.session.length === 0) continue
    const seen = rooms.get(room.session) ?? { running: false, own: false }
    seen.running ||= room.running
    // Whether the class has a second container is asked HERE, by the same
    // `docker ps`. Otherwise the resources panel would call `inspect` blindly
    // on every live room, only to learn "no such container" half the time.
    seen.own ||= room.role === 'own'
    rooms.set(room.session, seen)
  }
  return [...rooms].map(([session, seen]) => ({ session, ...seen }))
}

/** A room and the slice its container holds; an empty slice means a room without a GPU. */
interface RoomContainer {
  session: string
  gpu: string
  /** The class's container or its personal notebooks'; no label means the class's. */
  role: KernelRole
  /**
   * Whether the container is alive right now.
   *
   * The idle sweep needs to know this, not just "does it exist": a stopped
   * container (`--restart=no` plus a machine reboot, and they all are) does not
   * exist at all for `docker ps` without `-a`, so until now it never got swept
   * and held its GPU slice until `make down`.
   */
  running: boolean
  /** A known exited/created container, distinct from a missing census row. */
  stopped: boolean
}

/**
 * Room containers together with their labels, both live and stopped.
 *
 * `docker ps -a`, always. For handing out slices this is the only correct
 * way: a stopped container holds its slice, and `docker start` will bring it
 * back with the same variables and the same device. The idle sweep used to
 * ask without `-a` and for exactly that reason saw no stopped container at
 * all: after a machine reboot (`--restart=no`) ALL of them become stopped, the
 * GPU slices stayed with rooms nobody would open again, and a new seminar
 * heard "no free slices". Which are live and which are not is told by the
 * `running` field.
 */
export async function roomContainers(options: { strict?: boolean } = {}): Promise<RoomContainer[]> {
  if (!(await canIsolate())) {
    if (options.strict) throw new Error('Room allocation census is unavailable')
    return []
  }
  const res = await run([
    'ps',
    '-a',
    '--filter',
    'label=colloq.kind=room-kernel',
    '--format',
    '{{.Label "colloq.session"}}\t{{.Label "colloq.gpu"}}\t{{.State}}\t{{.Label "colloq.role"}}',
  ])
  if (res.code !== 0) {
    if (options.strict) throw new Error('Room allocation census is unavailable')
    return []
  }
  return res.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [session, gpu, state, role] = line.split('\t')
      return {
        session: (session ?? '').trim(),
        gpu: (gpu ?? '').trim(),
        running: (state ?? '').trim() === 'running',
        stopped: ['created', 'exited', 'dead'].includes((state ?? '').trim()),
        // Empty or `<no value>` is a container started before the label
        // existed, that is, a room one. Silence here is the backward
        // compatibility.
        role: (role ?? '').trim() === 'own' ? 'own' : 'room',
      }
    })
}

/**
 * The path to the room's folder AS THE docker daemon SEES IT.
 *
 * `-v` is parsed by the daemon on the host, not by us, and it reads the path
 * its own way. Under `make run` (server on the host) it is the same path, and
 * no variable is needed. Under `make up` the server lives in a container where
 * the room's folder is at `/app/workspace/<id>`; the daemon would create an
 * empty folder with that name on the host and mount it: the kernel sees
 * nothing, while the room's files stay where the server writes them and the
 * panel shows them. `WORKSPACE_HOST_DIR` names the same folder the way the
 * host sees it, and only that makes isolation under `make up` possible.
 */
function hostMount(sessionId: string): string {
  const inside = sessionDir(sessionId)
  const root = hostRoot()
  if (!root) return inside
  return path.join(root, path.relative(config.workspaceDir, inside))
}

/** The workspace root as the host sees it; empty means the server is on the host and the paths match. */
function hostRoot(): string {
  return (process.env.WORKSPACE_HOST_DIR ?? '').trim()
}

/**
 * Whether the server itself runs in a container: the question both the mount
 * path and the kernel's address depend on.
 *
 * It is asked of the system rather than inferred from a non-empty
 * WORKSPACE_HOST_DIR, as it used to be: a variable forgotten in .env from a
 * previous way of running silently moved the kernel into the compose network,
 * and on a machine where the server runs under systemd EVERY cell run broke.
 * The docker marker is the `/.dockerenv` file; it exists in every container
 * and does not depend on what someone put in the environment.
 */
function inContainer(): boolean {
  return fs.existsSync('/.dockerenv')
}

/**
 * The network to put the room's container in.
 *
 * Under `make run` the server is on the host, the port is published on the
 * host loopback, and `127.0.0.1:<port>` is the right address. Under `make up`
 * the server is itself in a container, and the same string points at itself:
 * it cannot reach the host loopback, and host-gateway does not help, since the
 * port is bound to 127.0.0.1, not to the bridge. There is only one way there:
 * the shared compose network and addressing by container name. Then the port
 * is not published at all, and nobody on the host can see the room's Jupyter,
 * which is strictly better than before. Only whoever launched us knows the
 * network name: `KERNEL_NETWORK`.
 *
 * On the host, rooms no longer sit in the default `bridge` but live in their
 * own `colloq-rooms` network (18 Sep 2026): it has a known subnet, and the ban
 * on local addresses is written exactly for it, without touching the
 * machine's other containers (perimeter.ts). In the container form the network
 * stays shared with the server, otherwise the kernel cannot be reached by
 * name; perimeter.ts reads its subnet from docker.
 *
 * The "server in a container" marker is the same one the mount path uses.
 */
function roomNetwork(): string {
  return inContainer() ? (process.env.KERNEL_NETWORK ?? '').trim() : ROOM_NETWORK
}

/** How the server reaches the room's Jupyter: by a port on its own loopback (true) or by name in the shared network. */
function publishes(): boolean {
  return !inContainer()
}

/** The room network for perimeter.ts: our own we create ourselves, a shared one is created by whoever launched us. */
function perimeterTarget(): RoomNetworkTarget {
  return { network: roomNetwork(), create: publishes() }
}

/* -------------------------------------------------------------- GPU slices */

/**
 * The devices given to Colloq: `KERNEL_GPUS`, comma-separated, in the form
 * docker understands them (`MIG-GPU-…`, `0`, `1`).
 *
 * Empty or unset means nobody asks for a GPU, and everything works exactly as
 * before: on a machine without a card no room should trip over a slice.
 */
export function gpuDevices(): string[] {
  return (process.env.KERNEL_GPUS ?? '')
    .split(',')
    .map((device) => device.trim())
    .filter((device) => device.length > 0)
}

/**
 * Slices handed out in this process that have not yet become a label on a
 * container.
 *
 * A second passes between "read the taken ones" and "docker run set the
 * label", and two rooms opened at once managed to pick the same slice: docker
 * does not complain, the MIG slice's memory is split in half, and the very
 * first training run fails for lack of video memory in both. The source of
 * truth is still the label; this only covers the window in between.
 */
const reserved = new Map<string, string>()

/**
 * Which slice to give a room: the same one if it already has one, otherwise
 * the first free one, otherwise none.
 *
 * "The same one" is not politeness: a slice is bound to its container, and a
 * different slice means recreating the container, that is, losing all the
 * seminar's variables for nothing. A slice that is no longer in `KERNEL_GPUS`
 * (the operator rewrote the list), however, does not count as the room's own:
 * the device may no longer be on the machine.
 *
 * A pure function, because this rule is exactly what has to be proven, and
 * there is no real docker in the tests.
 */
export function pickGpu(
  devices: string[],
  taken: Array<Pick<RoomContainer, 'session' | 'gpu'>>,
  sessionId: string,
): string | null {
  const mine = taken.find((held) => held.session === sessionId && devices.includes(held.gpu))
  if (mine) return mine.gpu
  const busy = new Set(taken.map((held) => held.gpu).filter((gpu) => gpu.length > 0))
  return devices.find((device) => !busy.has(device)) ?? null
}

/**
 * Not enough slices, said in the same words as the "the environment was never
 * built" refusal: what happened and what the person in the room should do
 * next.
 *
 * A refusal, not a silent run on the CPU: the torch wheels in such an
 * environment are built for CUDA, `import torch` goes through, and the first
 * `.cuda()` in the middle of the lesson says something about the driver, and
 * nobody connects that with the slice being taken.
 */
export function gpuRefusal(env: string, devices: string[]): string {
  if (devices.length === 0) {
    return tr("server.environmentRequiresAGpuButNoneIs.53af19", { p0: env })
  }
  return tr("server.environmentRequiresAGpuButAllAvailable.f3d4d9", { p0: env, p1: devices.length })
}

/**
 * Who holds which slice right now, by the labels of live AND stopped
 * containers, plus this process's reservations. Needed by the panel and by
 * the allocation.
 */
export async function gpuAssignments(): Promise<Array<Pick<RoomContainer, 'session' | 'gpu'>>> {
  const held: Array<Pick<RoomContainer, 'session' | 'gpu'>> = (await roomContainers())
    /*
     * The personal-notebook container takes no part in slice allocation AT
     * ALL.
     *
     * It has no slice label and cannot have one (`runArgs` strikes it out), so
     * the `gpu` filter would drop it anyway. The role check sits next to it
     * because what matters is not "today it has no label" but "it is not
     * entitled to the card": `pickGpu` treats ANY slice of its room as its own,
     * and a label that got here by mistake would give the class's card to its
     * drafts.
     */
    .filter((room) => room.role !== 'own' && room.gpu.length > 0)
    .map((room) => ({ session: room.session, gpu: room.gpu }))
  const known = new Set(held.map((room) => room.session))
  for (const [session, gpu] of reserved) if (!known.has(session)) held.push({ session, gpu })
  return held
}

/** Taken slices, for the panel, so it does not promise free ones. */
export async function gpuBusy(): Promise<string[]> {
  return [...new Set((await gpuAssignments()).map((room) => room.gpu))]
}

/** A slice for the room, or a refusal. The reservation is set at once; see `reserved`. */
async function takeGpu(sessionId: string, env: string): Promise<string> {
  const devices = gpuDevices()
  const gpu = pickGpu(devices, await gpuAssignments(), sessionId)
  if (!gpu) throw new Error(gpuRefusal(env, devices))
  reserved.set(sessionId, gpu)
  return gpu
}

/**
 * Whether an existing container has the right slice: the third check next to
 * `sameImage` and `sameNetwork`.
 *
 * A container started before the environment needed a GPU carries no label at
 * all and has no device inside: reusing it means giving the room a kernel
 * that learns about its trouble only on the first `.cuda()`.
 */
async function sameGpu(container: string, gpu: string | null): Promise<boolean> {
  const res = await run(['inspect', container, '--format', '{{index .Config.Labels "colloq.gpu"}}'])
  if (res.code !== 0) return true
  // No label: docker prints an empty string, and older versions print `<no value>`.
  const label = res.out.trim() === '<no value>' ? '' : res.out.trim()
  return label === (gpu ?? '')
}

/**
 * How many threads to allow numeric libraries.
 *
 * `os.cpu_count()` inside a container shows the HOST's cores, not the ones
 * given by `--cpus`: numpy and torch start thirty threads each on two allotted
 * cores and fight over them, computing slower than with one. Docker
 * understands fractional `--cpus`, but a thread count is an integer, rounded
 * down, not up: asking for more threads than there are cores is exactly the
 * trouble this is set to prevent.
 */
function threadLimit(own?: number | null): string {
  const cpus = own ?? Number(process.env.KERNEL_CPUS ?? '2')
  if (!Number.isFinite(cpus) || cpus <= 0) return '2'
  return String(Math.max(1, Math.floor(cpus)))
}

/**
 * How many CPUs a room gets when nothing was set for it, as a number.
 *
 * `KERNEL_CPUS` is a string from the environment, and it can be fractional
 * ("1.5"): docker can do that. The same number goes out, because the class
 * form labels the "CPU" field with it, and it must label it with what the
 * room will actually get.
 */
export function defaultCpus(): number {
  const cpus = Number(process.env.KERNEL_CPUS ?? '2')
  return Number.isFinite(cpus) && cpus > 0 ? cpus : 2
}

/**
 * How much memory to give the room's container, and why it is not one number
 * for the whole machine.
 *
 * Two gigabytes per room is an honest default for a laptop where someone
 * starts Colloq to have a look, and a death sentence for a computer vision
 * seminar: `resnet18` on a batch of 250 images at 224×224 takes nearly two
 * gigabytes in activations alone, and that is ON TOP of torch, the CUDA
 * context and an already loaded language model. Then the cgroup kills python,
 * Jupyter silently starts a new one, and the teacher sees "kernel restarted"
 * on the same cell fifteen times in a row.
 *
 * So the limit is asked of the environment rather than hard-coded:
 * `KERNEL_MEM` is the general one, and `KERNEL_MEM_<ENVIRONMENT>` overrides it
 * for one environment. The environment name is turned into the shape of an
 * environment variable: `base-gpu` → `KERNEL_MEM_BASE_GPU`. That way a heavy
 * environment gets its own, and light rooms next to it do not eat up the
 * machine for nothing.
 */
export function memoryLimit(env: string): string {
  const named = process.env[`KERNEL_MEM_${env.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`]
  return named || process.env.KERNEL_MEM || (needsGpu(env) ? DEFAULT_MEM_GPU : DEFAULT_MEM)
}

/*
 * The defaults were raised on 13 Sep 2026 after a day when 2g killed the
 * kernel on every run of a single cell. Four gigabytes is still tolerable for
 * an ordinary notebook with pandas and pictures on a laptop; a GPU environment
 * makes no sense without sixteen: the rented machine is a 3090 with 24 GB of
 * video memory and 72 GB of RAM, and torch with a CUDA context and a model
 * puts no less into RAM than into video memory. This is about RAM: the cgroup
 * does not limit video memory, and rooms get the card whole.
 */
const DEFAULT_MEM = '4g'
const DEFAULT_MEM_GPU = '16g'

/**
 * A docker string ("4g", "512m", "2048") in megabytes, and back.
 *
 * Needed precisely because the limit is no longer a matter of `.env` alone:
 * it is now visible in the panel and can be set for a room as a number. The
 * panel speaks gigabytes, the seminar row stores megabytes, docker
 * understands suffixes, and without one common measure in the middle these
 * three silently drift apart, and the price is paid by a kernel that got half
 * of what the screen shows.
 *
 * Rounding down is deliberate: docker will not give out a fractional
 * megabyte, and an extra one added while reading would come back into
 * `--memory` as a number larger than what the environment variable said.
 */
export function parseMemMb(spec: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([bkmg])?b?\s*$/i.exec(spec)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = (match[2] ?? 'b').toLowerCase()
  const bytes = value * (unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1)
  const mb = Math.floor(bytes / 1024 ** 2)
  return mb > 0 ? mb : null
}

/** And back, in the same language `--memory` is set in. */
export function memSpec(mb: number): string {
  return `${Math.floor(mb)}m`
}

/**
 * What environments fall back to: the general default and the default for a
 * GPU environment.
 *
 * Separate from `memoryLimitMb(env)` because the seminar form shows both
 * BEFORE an environment is chosen: "4 GB by default, 16 on a GPU".
 */
export function defaultMemoryMb(gpu = false): number {
  const fallback = gpu ? DEFAULT_MEM_GPU : DEFAULT_MEM
  return parseMemMb(process.env.KERNEL_MEM || fallback) ?? (parseMemMb(fallback) as number)
}

/** The environment's default as a number; the seminar form shows it. */
export function memoryLimitMb(env: string): number {
  const named = parseMemMb(memoryLimit(env))
  if (named !== null) return named
  // The environment variable was written any old way ("4 gigs"): our own
  // default is sure to parse, and the room starts instead of failing on NaN.
  return parseMemMb(needsGpu(env) ? DEFAULT_MEM_GPU : DEFAULT_MEM) as number
}

/**
 * Call docker on someone else's behalf: for postmortem.ts, which finds out why
 * a kernel died.
 *
 * A separate export rather than "expose `run`": only reading goes out, with a
 * short timeout, and the dependency goes one way; the pool knows nothing
 * about who reads its containers' state and why.
 */
export function dockerRead(args: string[], timeoutMs = 10_000): Promise<{ code: number; out: string }> {
  return run(args, timeoutMs)
}

/** The container name, for those who ask docker about it directly. */
export function roomContainer(sessionId: string, role: KernelRole = 'room'): string {
  return containerFor(sessionId, role)
}

/**
 * The `docker run` arguments for the room's container.
 *
 * A separate function, because there is no real docker in the tests, and
 * building this line correctly matters more than calling it: an extra space
 * or a lost flag here means a seminar without a GPU or without isolation, and
 * that can only be noticed during the lesson. There are no quotes on purpose:
 * `run()` calls spawn with an array, without a shell.
 */
export function runArgs(opts: {
  sessionId: string
  env: string
  mount: string
  /**
   * The class's container or the container of its personal notebooks.
   *
   * The second has no `--gpus`, no slice label and no `--shm-size`, and
   * cannot have them: the class's card is not given to personal notebooks,
   * and that is not a setting but the design; see shared/rules.ts ·
   * bookHasOwnKernel. Everything else is the same: the same image, the same
   * network, the same hardened profile, the same class folder and the same
   * memory and CPU numbers, but its own cgroup and its own token.
   */
  role?: KernelRole
  /** The room's network: `colloq-rooms` on the host, KERNEL_NETWORK in the container form. */
  network: string
  /**
   * Whether to publish Jupyter on the host loopback: that is how a server
   * living on the host reaches it. In the container form the server goes by
   * name in the shared network, and the port is not published at all.
   */
  publish: boolean
  gpu: string | null
  /**
   * The memory limit of THIS particular room, if the teacher set one.
   *
   * It overrides the environment's default rather than adding to it: a vision
   * seminar and a statistics seminar live on the same image, and the whole
   * difference between them is how much memory they need. `null` (and a
   * missing field) means the old behavior, that is, `KERNEL_MEM` and the
   * environment's default.
   */
  memoryMb?: number | null
  /**
   * How many CPUs to give THIS particular room.
   *
   * By the same rule as memory: `null` means the old behavior, that is,
   * `KERNEL_CPUS` for the whole instance. The number here decides not only
   * `--cpus` but also the numeric libraries' threads below: `os.cpu_count()`
   * inside a container sees the HOST's cores, and a room with two allotted
   * cores would start thirty threads on them, exactly what these variables
   * are there to prevent.
   */
  cpus?: number | null
}): string[] {
  const { sessionId, env, mount, network, publish } = opts
  const role = opts.role ?? 'room'
  // Only the class's container gets a slice. Not "if one was passed" but "if
  // allowed": a caller's mistake must not be able to give the card to personal
  // notebooks.
  const gpu = role === 'own' ? null : opts.gpu
  const memory = opts.memoryMb ? memSpec(opts.memoryMb) : memoryLimit(env)
  const cpus = opts.cpus && opts.cpus > 0 ? opts.cpus : defaultCpus()
  const threads = threadLimit(cpus)
  return [
    'run',
    '-d',
    '--name',
    containerFor(sessionId, role),
    /*
     * Our own room network (on the host) or the shared compose network (the
     * server itself in a container), and in either of them the ban on local
     * addresses applies (perimeter.ts).
     */
    ...(network ? ['--network', network] : []),
    /*
     * A port on the host loopback, only when the server is on the host. The
     * loopback is not decoration here: without it the room's Jupyter is open
     * on every interface, and the lecture hall's Wi-Fi is one of them. In the
     * container form the port is not published at all.
     */
    ...(publish ? ['-p', '127.0.0.1:0:8888'] : []),
    /*
     * The hardened profile, always, not only when the class is open to the
     * outside: uid 1000, no capabilities, no-new-privileges, a process cap, no
     * IPv6, a profile version label (perimeter.ts · roomHardeningArgs).
     */
    ...roomHardeningArgs(process.env, role),
    // One slice, named the way docker calls it. A room on an ordinary
    // environment does not get here and takes no device.
    ...(gpu ? ['--gpus', `device=${gpu}`] : []),
    '-e',
    `JUPYTER_TOKEN=${roomToken(sessionId, role)}`,
    // The room has as many CPUs as it was given, and as many threads. But only
    // as of `docker run`: `docker update --cpus` changes a live container's
    // quota, not its environment variables (see applyCpuLimit).
    '-e',
    `OMP_NUM_THREADS=${threads}`,
    '-e',
    `MKL_NUM_THREADS=${threads}`,
    '-e',
    `OPENBLAS_NUM_THREADS=${threads}`,
    // numexpr counts its number from the HOST's cores just like the other
    // three, and grumbles quietly into the kernel log when its variable is
    // missing.
    '-e',
    `NUMEXPR_NUM_THREADS=${threads}`,
    /*
     * Which representation plotly emits a figure in, and why that is decided
     * here rather than in the image.
     *
     * Without the variable plotly picks the renderer itself, from the
     * environment, and picks differently in different versions: 7.x under
     * ipykernel emits a single `application/vnd.plotly.v1+json` (which is what
     * we need), while 5.x also emits `text/html`, and in its first frame sends
     * the WHOLE plotly.js bundle, five megabytes of script we do not execute
     * anyway. The difference is not ours and changes from image to image.
     *
     * A variable of the kernel process is the least intrusive way to bring
     * order here: it acts on SOMEONE ELSE'S environment, built by anyone at any
     * time, without requiring an image rebuild, a plotly import or a single
     * line executed in the kernel before the student's code. And the student
     * can override it with one line (`pio.renderers.default = …`), so it is a
     * default, not a prohibition.
     *
     * It is set in the image (kernel/Dockerfile) too: this code is not the
     * only thing that starts the container; there are also compose and rented
     * machines.
     */
    '-e',
    'PLOTLY_RENDERER=plotly_mimetype',
    '-v',
    `${mount}:/workspace/${sessionId}`,
    // Student code is arbitrary, exactly as in compose. A runaway cell in
    // one room must not be able to take the host down either.
    `--memory=${memory}`,
    /*
     * Swap exactly equal to memory, for the same reason it is set in
     * `docker update` below: without this flag docker gives the container as
     * much swap again on top, and a kernel that hits the limit does not die
     * but goes to disk; the room stalls for minutes where it would be more
     * honest to say "out of memory" right away.
     */
    `--memory-swap=${memory}`,
    `--cpus=${cpus}`,
    /*
     * Shared memory is needed only where there is a GPU: docker's default is
     * 64 MB, and `DataLoader(num_workers=4)` fails on it with "bus error"
     * without naming the cause. Ordinary rooms do not need it, and extra
     * memory given to everyone is memory taken from neighboring seminars.
     */
    ...(gpu ? [`--shm-size=${process.env.KERNEL_SHM ?? '1g'}`] : []),
    /*
     * `no`, not `unless-stopped`: there is now one container per seminar, and
     * a machine reboot would bring up the whole past semester at once. While
     * the server is alive, it restarts a fallen container itself the next time
     * the room is opened.
     */
    '--restart=no',
    '--label',
    'colloq.kind=room-kernel',
    '--label',
    `colloq.session=${sessionId}`,
    '--label',
    `colloq.environment=${env}`,
    /*
     * Whose container this is: the class's or its personal notebooks'.
     *
     * Set on BOTH, including the room one, where the value would be implied
     * anyway: the label is needed by the sweep, the slice allocation and
     * `colloq status`, and they read `docker ps`, that is, also yesterday's
     * containers started by a process that no longer exists. A missing label
     * reads as `room` (see `KernelRole`), so live containers survive a
     * rollout without being recreated.
     */
    '--label',
    `colloq.role=${role}`,
    // The label is the source of truth about who holds a slice: it survives
    // a server restart, and the in-memory map does not.
    ...(gpu ? ['--label', `colloq.gpu=${gpu}`] : []),
    `${IMAGE_PREFIX}:${env}`,
  ]
}

/* -------------------------------------------------- memory limit on a live room */

type DockerRun = (args: string[], timeoutMs?: number) => Promise<RunResult>
let limitsDocker: DockerRun = run

/**
 * Substitute docker, for tests.
 *
 * Exactly as in postmortem.ts and for exactly the same reason: there is no
 * real docker in the suite, yet what has to be checked happens only with it.
 * The substitute affects ONLY limit changes: it does not touch the container
 * life cycle, and a test that forgets to remove it cannot start a single
 * container on the machine.
 */
export function useDockerForLimits(fake: DockerRun | null): void {
  limitsDocker = fake ?? run
  limitsInjected = fake !== null
}
let limitsInjected = false

/** What happened to the limit: applied on a live container, waiting for the next start, or failed. */
export type LimitOutcome = 'applied' | 'pending' | 'failed'

/** Docker has no scheduler: reserve before issuing run/start/update. The
 * complete census credits existing allocations, leaving only positive growth.
 * Broker admission remains Kubernetes' responsibility. */
async function reserveKernelMemory(
  sessionId: string, targets: Array<{ role: KernelRole; memoryMb: number }>, runningOnly = false,
): Promise<Map<KernelRole, WorkLease>> {
  const leases = new Map<KernelRole, WorkLease>()
  if (kernelBackend() !== 'docker') return leases
  const { machineResources } = await import('./resources.js')
  const machine = await machineResources({ fresh: true, beforeReservations: true })
  try {
    for (const target of targets) {
      const allocationKey = slotFor(sessionId, target.role)
      const observed = observedWorkMemory(allocationKey)
      if (observed === null) throw new Error('Available kernel memory cannot be verified while the allocation census is unavailable')
      // Updating a stopped container consumes nothing; an in-flight start must
      // finish first so the update cannot outrun its admitted memory limit.
      if (runningOnly && !observed && !hasWorkAllocation(allocationKey)) continue
      if (target.memoryMb <= observed && !hasWorkAllocation(allocationKey)) continue
      const lease = reserveWork({ id: `kernel:${allocationKey}`, kind: 'kernel', allocationKey,
        memoryMb: target.memoryMb, diskBytes: 0 }, { availableMemoryMb: machine.memory.availableMb })
      if (!lease) throw new Error('Not enough available memory for this kernel allocation')
      leases.set(target.role, lease)
    }
    return leases
  } catch (error) { for (const lease of leases.values()) lease(); throw error }
}

async function refreshKernelAllocations(): Promise<void> {
  const { machineResources, forgetResources } = await import('./resources.js')
  forgetResources()
  await machineResources({ fresh: true, beforeReservations: true })
}

async function startWithMemory(sessionId: string, role: KernelRole, memoryMb: number, start: () => Promise<RunResult>): Promise<RunResult> {
  const leases = await reserveKernelMemory(sessionId, [{ role, memoryMb }])
  const lease = leases.get(role)
  let created = false
  try {
    assertLocalRoomRunning(sessionId)
    const result = await start()
    if (result.code === 0) { created = true; lease?.settle() }
    else lease?.()
    await refreshKernelAllocations()
    return result
  } catch (error) { if (!created) lease?.(); throw error }
}

async function updateWithMemory(
  sessionId: string, shown: string, targets: Array<{ role: KernelRole; memoryMb: number }>,
  update: (container: string, role: KernelRole) => Promise<RunResult>,
): Promise<LimitOutcome> {
  let leases: Map<KernelRole, WorkLease>
  try { leases = await reserveKernelMemory(sessionId, targets, true) }
  catch (error) { console.warn(`[kernel] ${sessionId}: ${error instanceof Error ? error.message : error}`); return 'failed' }
  try {
    return await bothContainers(sessionId, shown, async (container, role) => {
      const result = await update(container, role)
      const lease = leases.get(role)
      if (result.code === 0) lease?.settle()
      else lease?.()
      leases.delete(role)
      return result
    }, targets.map(target => target.role))
  } finally {
    for (const lease of leases.values()) lease()
    if (kernelBackend() === 'docker') await refreshKernelAllocations()
  }
}

/**
 * Raise (or lower) a live room's memory without killing its Python.
 *
 * `docker update` can change the cgroup of a running container, which means
 * a teacher whose kernel was just killed for memory adds gigabytes and runs
 * the same cell again without losing the seminar's variables or the open
 * terminal. Recreating the container here would be exactly what people
 * suffered from: a clean Python in the middle of the lesson.
 *
 * Both flags together, and that is not overcaution: docker rejects `--memory`
 * without `--memory-swap` whenever the new memory is larger than the OLD swap
 * ("Memory limit should be smaller than already set memoryswap limit"), that
 * is, in exactly the case we came here for. Swap equals memory, the same
 * arrangement as with `docker run` above.
 *
 * No container is neither a problem nor an error: the number is already in
 * the seminar's row, and the next start takes it from there.
 *
 * Under the broker (k3s) it is the same, done by Kubernetes: the broker
 * changes a live Pod's memory through the `pods/resize` subresource, and the
 * Pod and its Python stay. Before 18 Sep 2026 there was an early `pending`
 * here, and the memory field did nothing at all on k3s: neither for the live
 * room nor for the next Pod, since the broker did not accept the number.
 *
 * `null` means "as the environment has it". Docker leaves it alone here (the
 * old behavior: the next `docker run` picks up the default), while the broker
 * returns the Pod to its default at once, just like a CPU reset.
 */
export async function applyMemoryLimit(sessionId: string, mb: number | null): Promise<LimitOutcome> {
  if (!limitsInjected && kernelBackend() === 'broker') return resizeRoomPod(sessionId, { memoryMb: mb })
  // A docker reset waits for the next `docker run`, without a trip to the
  // daemon: before the broker change, the route never called here with `null`.
  if (mb === null) return 'pending'
  if (!limitsInjected) {
    // Under the test backend there are no containers at all; the number waits for the next start.
    if (kernelBackend() !== 'docker') return 'pending'
    if (!(await canIsolate())) return 'pending'
  }
  const spec = memSpec(mb)
  /*
   * The room gets its number, personal notebooks get theirs (`ownLimits`).
   *
   * While personal notebooks have no number of their own, they get the same
   * one; as soon as the teacher names one, the class's "Memory" field does not
   * concern them at all, otherwise one click in the class settings would
   * silently undo what the teacher chose for them separately.
   */
  const own = ownLimits(sessionId).memoryMb
  const ownSpec = own === null ? spec : memSpec(own)
  return updateWithMemory(sessionId, `${spec} of memory`, [{ role: 'room', memoryMb: mb }, { role: 'own', memoryMb: own ?? mb }], (container, role) => {
    const use = role === 'own' ? ownSpec : spec
    return limitsDocker(['update', `--memory=${use}`, `--memory-swap=${use}`, container], 30_000)
  })
}

/**
 * The personal notebooks' numbers go to their container, and only to it.
 *
 * Called where the rule changes (routes/sessions.ts,
 * routes/admin-instance.ts): the teacher chose how much to hand the students
 * and expects it to take effect now, not after the class is closed some day.
 * This path NEVER touches the room's container: its number is the class's
 * "Memory" field, and changing it from here would give the students the
 * teacher's memory with the very click the teacher used to limit them.
 *
 * `null` in the rule means "as for the class", and then the container gets
 * the room's number; that way it returns to the common limit without a second
 * on/off field.
 */
export async function applyOwnLimits(sessionId: string): Promise<LimitOutcome> {
  if (!limitsInjected && kernelBackend() !== 'docker') return 'pending'
  if (!limitsInjected && !(await canIsolate())) return 'pending'
  const { memoryMb, cpus } = ownLimits(sessionId)
  const spec = memSpec(memoryMb ?? defaultMemoryMb(false))
  const cores = cpus ?? defaultCpus()
  return updateWithMemory(
    sessionId,
    `${spec} of memory and ${cores} CPUs for personal notebooks`,
    [{ role: 'own', memoryMb: memoryMb ?? defaultMemoryMb(false) }],
    (container) =>
      limitsDocker(
        ['update', `--memory=${spec}`, `--memory-swap=${spec}`, `--cpus=${cores}`, container],
        30_000,
      ),
  )
}

/**
 * The given number goes to BOTH of the room's containers, each its own, with
 * one outcome.
 *
 * The field in the class form is called "Memory" and is about the room. Until
 * personal notebooks are assigned a number of their own, they get the same
 * one: a teacher who raised the seminar to eight gigabytes has every right to
 * expect that the students' drafts will not keep dying at four. Once one is
 * assigned, the second container lives by its own number and does not react
 * to changes of the room's (`ownLimits`). Their cgroups are separate in any
 * case: that is the whole point of the second container.
 *
 * "No container" is an ordinary thing, not a refusal: a class may have no
 * personal notebooks at all, and the room may not have been opened today yet.
 * The outcome is counted by what worked: if at least one live container
 * accepted, `applied`; if none was found, `pending`, that is, "taken at the
 * next start"; if one answered with an error, `failed`, and the error goes to
 * the log.
 */
async function bothContainers(
  sessionId: string,
  shown: string,
  update: (container: string, role: KernelRole) => Promise<RunResult>,
  roles: readonly KernelRole[] = ['room', 'own'],
): Promise<LimitOutcome> {
  let applied = false
  let failed = false
  for (const role of roles) {
    const container = containerFor(sessionId, role)
    const res = await update(container, role)
    if (res.code === 0) {
      applied = true
      continue
    }
    if (/no such container/i.test(res.out)) continue
    failed = true
    console.error(`[kernel] docker update for ${container} failed: ${res.out.slice(-200)}`)
  }
  if (applied) {
    console.log(`[kernel] room ${sessionId} was given ${shown} on live containers`)
    return 'applied'
  }
  if (failed) return 'failed'
  console.log(`[kernel] room ${sessionId} has ${shown} recorded; no container, it applies at the next start`)
  return 'pending'
}

/** Memory or CPUs of the room's live Pod through the broker; the broker's answer in the pool's terms. */
async function resizeRoomPod(
  sessionId: string,
  change: { memoryMb: number | null } | { cpus: number | null },
): Promise<LimitOutcome> {
  const [value] = Object.values(change)
  const shown =
    'memoryMb' in change
      ? value === null ? 'the broker default memory' : `${value} MB of memory`
      : value === null ? 'the broker default CPUs' : `${value} CPUs`
  try {
    const result = await kernelRuntimeClient().resize(sessionId, change)
    if (result.outcome === 'applied') {
      console.log(`[kernel] room ${sessionId} was given ${shown} on the live Pod`)
      return 'applied'
    }
    // absent: no Pod, the next start takes it; pending: the node has nothing
    // to spare right now (Deferred), and kubelet applies it itself when a
    // neighboring room frees its share.
    console.log(`[kernel] room ${sessionId} has ${shown} recorded; Pod: ${result.outcome}`)
    return 'pending'
  } catch (err) {
    console.error(`[kernel] the broker did not give room ${sessionId} ${shown}: ${err instanceof Error ? err.message.slice(0, 300) : err}`)
    return 'failed'
  }
}

/**
 * Raise (or lower) a live room's CPU count, on both backends at once.
 *
 * `docker update --cpus` changes the cgroup of a running container, and the
 * kernel gets more room that very second. Under the broker (k3s) the
 * `pods/resize` subresource does the same: the Pod, its UID and Python stay.
 * Before 18 Sep 2026 there was an early `pending` here under the broker, the
 * hint promised "after a kernel restart", and in fact the CPUs arrived only
 * when the next start tore down the whole Pod, together with all the
 * seminar's variables.
 *
 * There is one caveat, and it is an honest one: the numpy and torch threads
 * (OMP_NUM_THREADS and its neighbors) are set when the container is CREATED,
 * by `docker run` or a new Pod, and cannot be changed in a live container.
 * Restarting the Jupyter kernel does not help here: the new Python inherits
 * the server's environment in the same container. The room's next container
 * gets the new thread count. The hint under the field says so, not only this
 * comment.
 *
 * `null` means "as for the instance": docker takes KERNEL_CPUS, the broker
 * its own default. There is no swap-like pair of flags here: `--cpus` is
 * self-sufficient.
 */
export async function applyCpuLimit(sessionId: string, own: number | null): Promise<LimitOutcome> {
  if (!limitsInjected && kernelBackend() === 'broker') return resizeRoomPod(sessionId, { cpus: own })
  const cpus = own ?? defaultCpus()
  if (!limitsInjected) {
    if (kernelBackend() !== 'docker') return 'pending'
    if (!(await canIsolate())) return 'pending'
  }
  // The room gets its number, personal notebooks theirs; the reasoning is at memory above.
  const ownCores = ownLimits(sessionId).cpus ?? cpus
  return bothContainers(sessionId, `${cpus} CPUs`, (container, role) =>
    limitsDocker(['update', `--cpus=${role === 'own' ? ownCores : cpus}`, container], 30_000),
  )
}

/**
 * What docker actually gave the room's container: memory and CPUs in one
 * question.
 *
 * Asked of docker rather than taken from the seminar row: they can diverge
 * exactly when it matters, when the limit was raised but the room has been
 * running on the old one since morning. Zero in docker's answer means "no
 * limit", and that is `null`, not 0. One `inspect` for both numbers, because
 * the room list calls it for every live room.
 */
export async function containerLimits(
  sessionId: string,
  /** Defaults to the class's container: the panel shows the room, not the drafts. */
  role: KernelRole = 'room',
): Promise<{ memoryMb: number | null; cpus: number | null }> {
  const res = await limitsDocker(
    ['inspect', containerFor(sessionId, role), '--format', '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}'],
    10_000,
  )
  if (res.code !== 0) return { memoryMb: null, cpus: null }
  const [rawBytes, rawNano] = res.out.trim().split(/\s+/)
  const bytes = Number(rawBytes)
  const nano = Number(rawNano)
  return {
    memoryMb: Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes / 1024 ** 2) : null,
    // NanoCpus are billionths of a CPU: 2.5 CPUs arrive as 2500000000.
    cpus: Number.isFinite(nano) && nano > 0 ? Math.round(nano / 1e8) / 10 : null,
  }
}

const locallyStoppedRooms = new Set<string>()
function assertLocalRoomRunning(sessionId: string): void {
  if (locallyStoppedRooms.has(sessionId)) throw new Error('Local session is stopping')
}

async function startContainer(
  sessionId: string,
  env: string,
  role: KernelRole = 'room',
  retried = false,
): Promise<KernelEndpoint> {
  assertLocalRoomRunning(sessionId)
  const container = containerFor(sessionId, role)
  const image = `${IMAGE_PREFIX}:${env}`
  const network = roomNetwork()
  /*
   * The slice is asked for before we decide to reuse the container: for a
   * room with its own container it is the same slice as before, and for a new
   * one it is either a free one or a refusal, and the refusal has to come
   * before `docker start` brings up a kernel without the device.
   *
   * The personal-notebook container neither asks for nor takes slices: the
   * class's card is not given to its students (shared/rules.ts ·
   * bookHasOwnKernel), and it starts a GPU environment just like an ordinary
   * one, on the CPU.
   */
  const gpu = role !== 'own' && needsGpu(env) ? await takeGpu(sessionId, env) : null
  const state = await stateOf(container)
  assertLocalRoomRunning(sessionId)

  /*
   * Recreate the container and try again, exactly once.
   *
   * There is deliberately no second attempt: if a freshly created container
   * does not answer either, the problem is not the container, and an endless
   * loop of `rm` + `run` in the middle of the lesson is worse than an honest
   * error on the cell.
   */
  const recreate = async (why: string): Promise<KernelEndpoint> => {
    assertLocalRoomRunning(sessionId)
    if (retried) throw new Error(tr("server.couldNotStartTheRoomContainer.cf7398", { p0: why }))
    /*
     * Say it out loud when a live (or frozen) container is removed.
     *
     * Recreating means a clean Python: all the seminar's variables, everything
     * computed and the terminal's pty go with it. A silent loss in the middle
     * of the lesson looks like "the kernel went mad": `x` was there and
     * suddenly NameError, with not a single line about it anywhere. `missing`
     * does not count: there is nothing to lose, there was no container.
     */
    if (state === 'running' || state === 'broken') announceRecreate(sessionId, why, role)
    await run(['rm', '-f', container], 60_000)
    endpoints.delete(slotFor(sessionId, role))
    return startContainer(sessionId, env, role, true)
  }

  if (state === 'broken') {
    // `dead`, `paused`, `restarting`: `docker start` will not help these.
    return recreate(tr("server.theContainerIsInAStateThat.d95d79"))
  }
  if (state === 'stopped' || state === 'running') {
    /*
     * A container built from an old image is no longer this environment. It
     * used to be reused by name alone, so rebuilding the package list left the
     * room on the previous image while the panel showed the new one: the
     * student's `import transformers` failed, and nothing on the screen
     * contradicted it.
     */
    if (!(await sameImage(container, image))) return recreate(tr("server.theEnvironmentImageWasRebuilt.229a9d"))
    /*
     * A container started before the hardened profile (no colloq.profile
     * label): with docker's default privileges and in a network without the
     * ban.
     *
     * A stopped one is recreated: there is nothing to lose in it except
     * packages installed into its layer (just as with an image rebuild), and
     * bringing it up with `docker start` would release a kernel with the old
     * rights again. A live one lasts until it stops: removing it would take
     * all the variables away from the lesson in the middle of the class; the
     * owner's decision is "until the restart".
     */
    const legacy = (await profileOf(container)) !== ROOM_PROFILE
    if (legacy && state === 'stopped') return recreate(tr('server.roomPerimeter.migrated'))
    if (legacy) {
      // The route to it is the old one: a published port on the host or a
      // name in the shared network. If even that is gone, it is no longer the
      // profile but a changed server mode.
      if (!(await legacyReachable(container, network))) return recreate(tr("server.theServerChangedNetworks.08933e"))
      warnLegacy(sessionId)
    } else if (!(await sameNetwork(container, network))) {
      // A container from the previous mode: it lacks the address we now call
      // it by, neither a name in our network nor a published port.
      return recreate(tr("server.theServerChangedNetworks.08933e"))
    }
    // A container without a slice (or with someone else's) is no good for a
    // GPU environment: devices cannot be passed into it except by starting over.
    if (!(await sameGpu(container, gpu))) return recreate(tr("server.theContainerWasStartedWithADifferent.bc4d7d"))
    if (state === 'stopped') {
      // The ban on local addresses goes up before the kernel wakes, not after:
      // if it fails, the room does not start (perimeter.ts · RoomPerimeterError).
      await ensureRoomPerimeter(run, perimeterTarget(), image)
      assertLocalRoomRunning(sessionId)
      const stoppedLimits = await containerLimits(sessionId, role)
      const started = await startWithMemory(sessionId, role, stoppedLimits.memoryMb ?? memoryLimitMb(env), () => run(['start', container], 60_000))
      // The result is read: a container that did not come up would go on
      // answering "could not read the published port" to every Run, until a
      // manual docker rm.
      if (started.code !== 0) return recreate(tr("server.dockerStart.e0ac13", { p0: started.out.slice(-200) }))
    }
  } else if (state === 'missing') {
    if (!(await imageExists(image))) {
      throw new Error(
        tr("server.environmentHasNotBeenBuiltBuildIt.cf54f5", { p0: env, p1: env }),
      )
    }
    /*
     * ONLY this room's folder is mounted, at the same path as before: the
     * kernel's working directory is set by the Jupyter session path
     * `<id>/session.ipynb`, so `/workspace/<id>` must exist inside, while the
     * rest of `/workspace` no longer gets in at all.
     */
    const mount = hostMount(sessionId)
    // The room network is created right here if it is missing, and the ban
    // goes up before the kernel's first packet; if it fails, that is a refusal,
    // not an open network.
    await ensureRoomPerimeter(run, perimeterTarget(), image)
    assertLocalRoomRunning(sessionId)
    const limits = role === 'own' ? ownLimits(sessionId) : { memoryMb: sessionMemoryMb(sessionId), cpus: sessionCpus(sessionId) }
    const args = runArgs({
        sessionId,
        env,
        role,
        mount,
        network,
        publish: publishes(),
        gpu,
        // The same numbers as the room's, but a cgroup of its own: "Memory" in
        // the class form promises that much to each of its Pythons, not that
        // much for the two together. The personal-notebook container gets its
        // own numbers: a class may hand the students a different amount than
        // it took for itself.
        ...limits,
      })
    const created = await startWithMemory(sessionId, role, limits.memoryMb ?? memoryLimitMb(env), () => run(args, 120_000))
    if (created.code !== 0) {
      // The network may have been removed between the check and the start:
      // the next attempt asks again instead of trusting what it remembered a
      // minute ago.
      if (/network .* not found/i.test(created.out)) perimeterStale()
      /*
       * The most common trouble of a GPU room is not ours: the host lacks
       * nvidia-container-toolkit, and docker answers "could not select device
       * driver", which tells the person in the room nothing. The hint is added
       * only if docker said exactly that.
       */
      const noDriver = gpu !== null && /device driver|nvidia/i.test(created.out)
      const hint = noDriver
        ? tr("server.theHostMayBeMissingNvidiaContainer.f5c0df")
        : ''
      throw new Error(tr("server.dockerRunFailed.0f4300", { p0: created.out.slice(-300), p1: hint }))
    }
  }

  assertLocalRoomRunning(sessionId)
  let url: string
  if (!publishes()) {
    // Inside the network they listen on the same 8888; there is nothing to publish.
    url = `http://${container}:8888`
  } else {
    const port = await publishedPort(container)
    if (port === null) throw new Error(tr("server.couldNotReadThePublishedPortOf.07ca0a", { p0: container }))
    url = `http://127.0.0.1:${port}`
  }

  const endpoint: KernelEndpoint = { url, token: roomToken(sessionId, role) }

  // Wait for Jupyter inside it to answer. `docker run` returns as soon as the
  // process is spawned, and connecting a second later fails with a bare
  // "fetch failed" that says nothing about why.
  const deadline = Date.now() + 90_000
  let lastError = tr("server.noResponse.187241")
  while (Date.now() < deadline) {
    assertLocalRoomRunning(sessionId)
    try {
      const res = await fetch(`${endpoint.url}/api/status?token=${endpoint.token}`, {
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) return endpoint
      /*
       * 401/403 does not mean "not up yet" but "a different token".
       *
       * The container's token is fixed at `docker run` and derived from the
       * instance secret: after a SESSION_SECRET rotation (the README
       * recommends it outright) all old containers answer 403, and the room
       * waited ninety seconds on every Run, reading about a timeout. The token
       * is deterministic, so a recreated container gets the right one.
       */
      if (res.status === 401 || res.status === 403) {
        return recreate(tr("server.theRoomKernelRejectedItsTokenHttp.c7ea0c", { p0: res.status }))
      }
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(tr("server.theRoomKernelDidNotRespondWithin.1324d5", { p0: lastError }))
}

/**
 * Addresses already resolved, so a busy room does not call docker per cell.
 *
 * The key is the slot (`slotFor`), not the class: a room has two containers,
 * and each has its own address, with a different port and a different token.
 */
const endpoints = new Map<string, KernelEndpoint>()
/** One start at a time per SLOT, shared by concurrent calls. */
const starting = new Map<string, Promise<KernelEndpoint>>()
/**
 * Rooms closed while their container was still starting.
 *
 * `docker rm -f` in the middle of `docker run` does not catch up: the start
 * finishes and leaves the deleted seminar's container alive with its memory
 * limit; the idle sweep will not find it (the room is no longer in the maps),
 * and it lives until `make down`. `dropRoomKernel` cannot wait for the start,
 * that is up to a minute and a half on a delete request, so we mark it, and
 * the start cleans up after itself.
 */
const abandoned = new Set<string>()
const brokerStarts = new Map<string, Set<Promise<KernelEndpoint>>>()

/**
 * The address of the Python this room should talk to.
 *
 * Production image selection comes from the persisted room pin and release catalog.
 */
export async function endpointForSession(
  sessionId: string,
  env: string | null,
  /**
   * The class's container or the container of its personal notebooks.
   *
   * Under the broker there is no second one: it creates one Pod per class,
   * and creating a second next to it means changing its protocol, its
   * controller and its permissions in the cluster. A refusal is more honest
   * than a substitute: a personal notebook quietly run in the lecture's kernel
   * would mean exactly what the second container exists to prevent, someone
   * else's card and someone else's OOM. The refusal is read in
   * kernel/index.ts.
   */
  role: KernelRole = 'room',
): Promise<KernelEndpoint> {
  requireKernelIsolation()
  assertLocalRoomRunning(sessionId)
  if (kernelRetirementInProgress(sessionId)) throw new Error(tr("server.cannotStartKernelSeminarIsStopping.9820e1"))
  const backend = kernelBackend()
  if (backend === 'test') return defaultEndpoint()
  if (role === 'own' && backend !== 'docker') throw new OwnKernelUnavailable()
  if (backend === 'broker') {
    if (!sessionRowExists(sessionId)) throw new Error(tr("server.cannotStartKernelSeminarDoesNotExist.4f72c5"))
    sessionDir(sessionId)
    const previous = sessionKernelRevision(sessionId)
    const selected = runtimeEnvironment(sessionEnvironment(sessionId), previous)
    const revision = pinSessionKernelRevision(sessionId, selected.name, imageRevision(selected.image))
    const pinned = runtimeEnvironment(sessionEnvironment(sessionId), revision)
    const starts = brokerStarts.get(sessionId) ?? new Set<Promise<KernelEndpoint>>()
    brokerStarts.set(sessionId, starts)
    const attempt = kernelRuntimeClient().ensure(
      sessionId, pinned.name, revision, sessionCpus(sessionId), sessionMemoryMb(sessionId),
    )
    starts.add(attempt)
    try {
      const endpoint = await attempt
      if (kernelRetirementInProgress(sessionId) || !sessionRowExists(sessionId)) {
        throw new Error(tr("server.cannotStartKernelSeminarIsStopping.9820e1"))
      }
      return endpoint
    } finally {
      starts.delete(attempt)
      if (starts.size === 0) brokerStarts.delete(sessionId)
    }
  }
  if (!(await canIsolate())) throw new Error('Room isolation is unavailable. Execution is disabled; shared Jupyter fallback is not permitted')

  assertLocalRoomRunning(sessionId)
  const slot = slotFor(sessionId, role)
  const cached = endpoints.get(slot)
  if (cached) return cached

  const inFlight = starting.get(slot)
  if (inFlight) return inFlight

  const name = (env ?? '').trim() || activeName()
  const attempt = startContainer(sessionId, name, role)
    .then((endpoint) => {
      endpoints.set(slot, endpoint)
      return endpoint
    })
    .finally(() => {
      starting.delete(slot)
      // The reservation has done its job: either the container already
      // carries the slice label, or there is no container and the slice is
      // free. It must not outlive the start, otherwise a failed environment
      // build takes the slice from the next seminar for good.
      reserved.delete(sessionId)
      // The room was closed while this was starting: we remove the container
      // (finished or half-made) ourselves, since nobody else will.
      if (abandoned.delete(slot)) void discardSlot(slot)
    })
  starting.set(slot, attempt)
  return attempt
}

async function discardSlot(slot: string): Promise<void> {
  endpoints.delete(slot)
  const container = containerOfSlot(slot)
  try {
    const result = await run(['rm', '-f', container], 60_000)
    if (result.code === 0 || /no such container/i.test(result.out)) {
      releaseWorkAllocation(slot)
      await refreshKernelAllocations()
    }
  } catch (err) {
    console.error(`[kernel] could not remove container ${container}:`, err)
  }
}

/** The container name for a slot, in one line, so the key parsing lives in one place. */
const containerOfSlot = (slot: string): string =>
  containerFor(sessionOfSlot(slot), slot.endsWith('#own') ? 'own' : 'room')

/** Both slots of a room, in "class first" order: the order shows in the log. */
const slotsOf = (sessionId: string): string[] => [
  slotFor(sessionId, 'room'),
  slotFor(sessionId, 'own'),
]

/**
 * Remove the room's containers for good, BOTH of them.
 *
 * Called when a seminar is deleted and by the idle sweep. The files live on
 * the host, in the room's folder, and survive this; only the Python with all
 * its variables goes.
 *
 * The personal-notebook container goes together with the room one, for the
 * same reason: the class is over. `dropOwnKernel` removes it separately, when
 * no live kernel is left in it while the class itself goes on.
 */
export async function dropRoomKernel(sessionId: string, permanent = false): Promise<void> {
  if (kernelBackend() === 'broker') {
    const release = blockKernelStarts(sessionId)
    try {
      // An already-issued ensure must settle before DELETE; otherwise its late
      // request can recreate the Pod after a successful stop response.
      await Promise.allSettled([...(brokerStarts.get(sessionId) ?? [])])
      await kernelRuntimeClient().stop(sessionId, permanent)
    } finally { release() }
    return
  }
  if (kernelBackend() === 'test') return
  for (const slot of slotsOf(sessionId)) endpoints.delete(slot)
  if (!(await canIsolate())) return
  for (const slot of slotsOf(sessionId)) {
    // A start in progress right now would put the container back a second
    // later: we mark the slot, and the start removes it itself when it ends.
    if (starting.has(slot)) abandoned.add(slot)
    const result = await run(['rm', '-f', containerOfSlot(slot)], 60_000)
    if (!starting.has(slot) && (result.code === 0 || /no such container/i.test(result.out))) releaseWorkAllocation(slot)
  }
  await refreshKernelAllocations()
}

/**
 * Remove ONLY the personal-notebook container; the class goes on.
 *
 * Called when its last kernel has shut down: keeping an empty container for
 * every class where someone once opened a draft means piling them up exactly
 * the way room containers piled up before the idle sweep existed. This path
 * NEVER touches the room container, neither its Python nor its terminal.
 */
export async function dropOwnKernel(sessionId: string): Promise<void> {
  if (kernelBackend() !== 'docker') return
  const slot = slotFor(sessionId, 'own')
  endpoints.delete(slot)
  if (!(await canIsolate())) return
  if (starting.has(slot)) abandoned.add(slot)
  const result = await run(['rm', '-f', containerFor(sessionId, 'own')], 60_000)
  if (!starting.has(slot) && (result.code === 0 || /no such container/i.test(result.out))) releaseWorkAllocation(slot)
  await refreshKernelAllocations()
}

/** Forget the resolved address so the next open re-checks the container. */
export function forgetSessionKernel(sessionId: string, role: KernelRole = 'room'): void {
  endpoints.delete(slotFor(sessionId, role))
}

/**
 * Rooms for which this process started at least one container. Needed by the
 * panel and the sweep, and both count CLASSES, not containers.
 */
export function runningRoomKernels(): string[] {
  return [...new Set([...endpoints.keys()].map(sessionOfSlot))]
}

/** Local supervisor shutdown; independent of network readiness and never deletes files. */
export async function dropLocalRoomKernel(sessionId: string): Promise<void> {
  if (kernelBackend() === 'test') return
  if (kernelBackend() !== 'docker') throw new Error('Local cleanup requires KERNEL_BACKEND=docker')
  locallyStoppedRooms.add(sessionId)
  const release = blockKernelStarts(sessionId)
  try {
    // A Docker create already sent to the daemon must settle before rm; checks
    // throughout startup prevent any later create or readiness retry.
    await Promise.allSettled(slotsOf(sessionId).map((slot) => starting.get(slot)))
    for (const slot of slotsOf(sessionId)) {
      endpoints.delete(slot)
      const result = await run(['rm', '-f', containerOfSlot(slot)], 60_000)
      if (result.code !== 0 && !/No such container/i.test(result.out)) throw new Error(result.out)
      releaseWorkAllocation(slot)
    }
  } finally { release() }
}
