/**
 * What machine is under the instance, and how much of it each room has been
 * given.
 *
 * On 13 Sep 2026 a seminar lost its kernel to memory sixteen times in a row,
 * and the only way to find out was `dmesg`: there was one limit for all rooms,
 * it lived in an environment variable and was shown nowhere in the product.
 * There was no way to raise it for one room, and raising it for everyone meant
 * giving sixteen gigabytes to ten seminars that are fine with two.
 *
 * Hence this module: it answers three questions without which a "how much
 * memory" field is guesswork. How much the machine has at all, how much is
 * free right now, and what has already been handed out to live rooms. Plus
 * the card, because a GPU environment asks for three times the usual memory,
 * and the teacher should see what exactly the seminar is being put on.
 *
 * Nothing here throws. All three sources (/proc, `nvidia-smi`, docker) may be
 * missing on someone else's machine, answer with garbage or hang; then the
 * seminar form simply does not show the hint instead of breaking entirely.
 */
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { db, sessionMemoryMb } from '../db.js'
import { listNames, needsGpu } from '../environments.js'
import { containerLimits, defaultCpus, defaultMemoryMb, dockerRead, roomContainers, memoryLimitMb, ownLimits } from './pool.js'
import { kernelBackend, kernelRuntimeClient } from './runtime-client.js'
import type { GpuCard, InstanceResources, RoomResource } from '@shared/admin'
import type { RuntimeRoom } from '@shared/runtime'
import { observeWorkMemory, workBudgetSnapshot } from '../ops/work-budget.js'

const MB = 1024 * 1024

/*
 * The shape of the answer lives in shared/admin.ts with everything else the
 * panel reads: one documented contract for server and browser, not two
 * similar ones.
 */
export type { GpuCard, InstanceResources, RoomResource } from '@shared/admin'
type Collected = Omit<InstanceResources, 'limits'>

/* --------------------------------------------------------------- memory */

/**
 * How much memory the machine ITSELF has free, in its kernel's opinion, not
 * `freemem`'s.
 *
 * `os.freemem()` is no good on either of the two systems. On Linux it is
 * memory used by NOTHING, page cache included: on a working server it is
 * always close to zero, and a "0.4 GB free" hint out of 72 would honestly
 * scare a teacher on an empty machine. MemAvailable is the kernel's own
 * estimate of "how much can be taken without going to swap", and that is
 * exactly the question the seminar form asks. On macOS `freemem` lies more
 * crudely: the system counts as free only pages used by nothing, and inactive
 * and purgeable pages, the ones it gives up on first demand, are not included.
 * On a Mac with 36 GB, at most half of it in use, the form showed "0.5 GB
 * free" and painted the field with a warning at any limit.
 *
 * So where there is no /proc of our own, the answer is `null`, "don't know":
 * the form then says nothing about free memory. Silence is more honest than a
 * number that scares for nothing.
 */
function hostAvailableMb(): number | null {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8')
    const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo)
    if (match) return Math.floor(Number(match[1]) / 1024)
  } catch {
    /* not Linux, or /proc is not mounted: an honest "don't know" below */
  }
  return null
}

/* ---------------------------------------------------------- docker daemon */

/**
 * The machine the room kernels ACTUALLY live on.
 *
 * On Linux the docker daemon is the same kernel, and its numbers match
 * `os.*`. On a Mac and on Windows a VM stands between them:
 * `colima start --memory 12` is twelve gigabytes for all containers at once,
 * however much the Mac has. The room's ceiling is set by whoever runs it, so
 * that is who has to be asked: a container in such a VM has nowhere to take
 * a sixteenth gigabyte from, while a class form going by the Mac's memory
 * would offer thirty-five and accept them, that is, promise a kernel that
 * gets killed for memory on the first heavy cell.
 */
interface Daemon {
  totalMb: number
  /** The daemon's `NCPU`: for a VM it is its share of the cores, not all of the Mac's. */
  cpus: number
}

/** "12514811904 10": the daemon's memory in bytes and its cores. */
export function parseDaemonInfo(out: string): Daemon | null {
  const [bytes, cores] = out.trim().split(/\s+/)
  const totalMb = Math.floor(Number(bytes) / MB)
  const cpus = Math.floor(Number(cores))
  // Zero and garbage mean "don't know", not "none": "none" would go into the
  // field's bounds and leave nothing to set for a room.
  if (!Number.isFinite(totalMb) || totalMb <= 0) return null
  return { totalMb, cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : 0 }
}

/*
 * Asked once a minute, not on every request.
 *
 * `docker info` is a round trip to the daemon: thirty milliseconds on a
 * healthy machine and forever on a hung one. The answer changes exactly when
 * colima was restarted with different memory; a minute is enough for that to
 * reach the form, and enough to keep several teachers' panels from turning
 * into a stream of docker processes. A failure is remembered just like a
 * success: if the daemon is down, for a minute we answer with the machine's
 * numbers instead of calling it again on every PATCH.
 */
const DAEMON_TTL_MS = 60_000
let seenDaemon: Daemon | null = null
let seenAt = 0
let daemonInflight: Promise<Daemon | null> | null = null

type DockerRead = (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>
let askDocker: DockerRead = dockerRead
let dockerInjected = false

/**
 * Substitute docker, for tests.
 *
 * Exactly like `useDockerForLimits` in pool.ts and for the same reason: there
 * is no real docker in the suite, yet what has to be checked happens only
 * with it.
 */
export function useDockerInfo(fake: DockerRead | null): void {
  askDocker = fake ?? dockerRead
  dockerInjected = fake !== null
}

/** What the daemon says about itself, cached and without a single exception escaping. */
export function readDaemon(): Promise<Daemon | null> {
  // Under the broker we do not manage the containers, and under the test
  // backend there are none at all: nobody to ask, so the numbers stay the
  // machine's.
  if (kernelBackend() !== 'docker' && !dockerInjected) return Promise.resolve(null)
  if (seenAt && Date.now() - seenAt < DAEMON_TTL_MS) return Promise.resolve(seenDaemon)
  daemonInflight ??= askDocker(['info', '--format', '{{.MemTotal}} {{.NCPU}}'], 3_000)
    .then((res) => (res.code === 0 ? parseDaemonInfo(res.out) : null))
    .catch(() => null)
    .then((value) => {
      seenDaemon = value
      seenAt = Date.now()
      return value
    })
    .finally(() => {
      daemonInflight = null
    })
  return daemonInflight
}

/**
 * The last thing the daemon said, for bounds computed synchronously.
 *
 * The `/api/instance/resources` endpoint computes the bounds AFTER
 * collecting, so the number there is always fresh. But a PATCH of a room's
 * limit also arrives at a cold server; there is no point waiting for docker
 * in it: this time the check goes by the machine's numbers, that is, softer
 * than it should, but the request does not stall for seconds because of an
 * unresponsive daemon. It also warms the cache for the next such request.
 */
function lastDaemon(): Daemon | null {
  void readDaemon()
  return seenDaemon
}

/* ---------------------------------------------------------------- broker */

/**
 * A room's memory on k3s is the broker's number, not the web's environment
 * variables.
 *
 * Under the broker it is the broker that assembles the room's Pod, and it has
 * its own default (RUNTIME_KERNEL_MEMORY, 2Gi out of the box), one for all
 * environments. The form, meanwhile, labelled the field with the docker path's
 * defaults, "4 GB, 16 on a GPU", which the Pod never got. And the broker has
 * its own ceiling: the node minus a gigabyte, or the operator's
 * RUNTIME_KERNEL_MEMORY_MAX. It reports both numbers in /v1/health.
 */
interface BrokerMemory {
  defaultMb: number | null
  maxMb: number | null
}
/*
 * If the broker has never answered yet, its factory default. There is no
 * better guess to offer here: an operator who changed RUNTIME_KERNEL_MEMORY
 * sees their number as soon as the broker answers, and until then the form at
 * least does not promise 4 GB where the Pod will get two.
 */
const BROKER_FACTORY_DEFAULT_MB = 2048
const BROKER_TTL_MS = 60_000
let seenBroker: BrokerMemory = { defaultMb: null, maxMb: null }
let brokerAt = 0
let brokerInflight: Promise<void> | null = null

/** Remember what the broker said about memory; silence about a field does not erase the previous value. */
function rememberBroker(health: { defaultMemoryMb?: number; maxMemoryMb?: number }): void {
  seenBroker = {
    defaultMb: health.defaultMemoryMb ?? seenBroker.defaultMb,
    maxMb: health.maxMemoryMb ?? seenBroker.maxMb,
  }
  brokerAt = Date.now()
}

/**
 * The last thing the broker said about memory, for synchronous bounds.
 *
 * Built the same way as `lastDaemon`: a limit PATCH does not wait for the
 * broker but warms the cache for next time. The form asks
 * /api/instance/resources when it opens anyway, so by the time something is
 * typed into the field the number is fresh.
 */
function lastBroker(): BrokerMemory {
  if (kernelBackend() === 'broker' && (!brokerAt || Date.now() - brokerAt >= BROKER_TTL_MS)) {
    brokerInflight ??= (async () => {
      try {
        rememberBroker(await kernelRuntimeClient().health())
      } catch {
        /* the broker is not configured or is down: we stay with the previous value */
      }
    })().finally(() => {
      brokerInflight = null
    })
  }
  return seenBroker
}

/** A room's default under the broker: one for all environments, as the broker itself has it. */
function brokerDefaultMb(): number {
  return lastBroker().defaultMb ?? BROKER_FACTORY_DEFAULT_MB
}

export interface MemoryPicture {
  totalMb: number
  /** How much more can be handed out; `null` means "we honestly don't know". */
  availableMb: number | null
  /** Whose numbers these are: the server machine's or the docker daemon's. */
  source: 'host' | 'docker'
}

/**
 * The form's two numbers, from the source that knows about them.
 *
 * "Is this the same computer" is decided by a number, not by the platform: a
 * native daemon has exactly as much memory as the machine, a colima VM has
 * its own, and DOCKER_HOST may even point at a neighboring server. The
 * one-sixteenth tolerance covers the difference in what each side counts as
 * "all of the memory".
 */
export function memoryPicture(input: {
  daemonTotalMb: number | null
  hostTotalMb: number
  hostAvailableMb: number | null
  takenMb: number
}): MemoryPicture {
  const { daemonTotalMb, hostTotalMb, hostAvailableMb, takenMb } = input
  const sameMachine =
    daemonTotalMb !== null && Math.abs(daemonTotalMb - hostTotalMb) <= hostTotalMb / 16
  if (daemonTotalMb === null || sameMachine) {
    return { totalMb: hostTotalMb, availableMb: hostAvailableMb, source: 'host' }
  }
  /*
   * A VM's free memory cannot be asked for: it has its own /proc, we do not go
   * inside, and the Mac's MemAvailable has nothing to do with its twelve
   * gigabytes. But exactly what the teacher needs is known: how much more can
   * be HANDED OUT, the daemon's ceiling minus a gigabyte for itself (the same
   * one as in the bounds below) minus what is already promised to live rooms.
   */
  return {
    totalMb: daemonTotalMb,
    availableMb: Math.max(0, daemonTotalMb - HOST_RESERVE_MB - takenMb),
    source: 'docker',
  }
}

/* ------------------------------------------------------------------ GPU */

/**
 * The machine's cards, from `nvidia-smi`, if it is there.
 *
 * Neither errors nor a missing binary escape: an empty list means "no cards
 * visible", and the seminar form then says nothing about GPUs. The timeout is
 * short and real (kill, not just reject): `nvidia-smi` on a machine with a
 * hung driver never returns, and this read hangs on the panel's request.
 */
function readGpus(): Promise<GpuCard[]> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('nvidia-smi', [
        '--query-gpu=index,name,memory.total',
        '--format=csv,noheader,nounits',
      ])
    } catch {
      resolve([])
      return
    }
    let out = ''
    let done = false
    const finish = (cards: GpuCard[]): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(cards)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish([])
    }, 3_000)
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('error', () => finish([]))
    child.on('close', (code) => finish(code === 0 ? parseGpus(out) : []))
  })
}

/** "0, NVIDIA GeForce RTX 3090, 24576": one line per card. */
export function parseGpus(out: string): GpuCard[] {
  const cards: GpuCard[] = []
  for (const line of out.split('\n')) {
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 3) continue
    const index = Number(parts[0])
    const memoryMb = Number(parts[2].replace(/[^\d]/g, ''))
    if (!Number.isFinite(index) || !parts[1]) continue
    cards.push({ index, name: parts[1], memoryMb: Number.isFinite(memoryMb) ? memoryMb : 0 })
  }
  return cards
}

/* ------------------------------------------------------------------ rooms */

interface RoomRow {
  id: string
  name: string
  environment: string | null
  memory_mb: number | null
  cpus: number | null
}

/**
 * The rooms worth talking about: live ones and those whose memory was set by
 * hand.
 *
 * Not all of them: a semester has sixty, and a "who holds the machine" list
 * of sixty rows, fifty-nine of them asleep, answers the wrong question. The
 * cap is there just in case: the panel draws this list.
 */
const selectRooms = db.prepare(
  'SELECT id, name, environment, memory_mb, cpus FROM sessions ORDER BY created_at DESC LIMIT 200',
)
const selectRoom = db.prepare('SELECT id, name, environment, memory_mb, cpus FROM sessions WHERE id = ?')

async function rooms(instanceCpus: number, runtimeRooms?: RuntimeRoom[]): Promise<{ rows: RoomResource[]; takenMb: number; takenCpus: number; memoryBySlot: Map<string, number>; complete: boolean }> {
  let alive: Set<string>
  let complete = true
  const memoryBySlot = new Map<string, number>()
  /*
   * Which classes have a SECOND container, the one personal notebooks live in.
   *
   * Asked by the same `docker ps` as the list of live ones: otherwise the panel
   * would call `inspect` blindly on every live room, only to learn "no such
   * container" for half of them. Under the broker there is never a second
   * container.
   */
  let withOwn = new Set<string>()
  let runningRoom = new Set<string>()
  let runningOwn = new Set<string>()
  const runtimeById = new Map(runtimeRooms?.map((room) => [room.sessionId, room]))
  try {
    if (runtimeRooms) {
      alive = new Set(runtimeRooms.filter((room) => room.phase === 'ready' || room.phase === 'pending').map((room) => room.sessionId))
    } else {
      const census = kernelBackend() === 'docker' ? await roomContainers({ strict: true }) : []
      alive = new Set(census.filter((r) => r.running).map((r) => r.session))
      withOwn = new Set(census.filter((r) => r.role === 'own').map((r) => r.session))
      runningRoom = new Set(census.filter((r) => r.running && r.role === 'room').map((r) => r.session))
      runningOwn = new Set(census.filter((r) => r.running && r.role === 'own').map((r) => r.session))
      for (const room of census) if (room.stopped) {
        memoryBySlot.set(room.role === 'own' ? `${room.session}#own` : room.session, 0)
      }
    }
  } catch {
    alive = new Set()
    complete = false
  }
  const rows = new Map((selectRooms.all() as RoomRow[]).map((row) => [row.id, row]))
  // Census is authoritative. Neither the DB display window nor an absent DB
  // row can erase resources a running workload still holds.
  for (const id of alive) if (!rows.has(id)) {
    const observed = runtimeById.get(id)
    rows.set(id, selectRoom.get(id) as RoomRow | undefined ?? {
      id, name: id, environment: observed?.environment ?? null, memory_mb: null, cpus: null,
    })
  }
  const interesting = [...rows.values()]
    .filter((row) => alive.has(row.id) || row.memory_mb !== null || row.cpus !== null)
  const allocations = await Promise.all(
    interesting.map(async (row) => {
      const settledMb = row.memory_mb ?? envDefaultMb(row.environment)
      const settledCpus = row.cpus ?? instanceCpus
      /*
       * For a live room docker is asked, not the seminar row: they can diverge
       * exactly when it matters, when the limit was raised between lessons
       * while the container has been running on the old one since morning.
       * What has to be shown is what the room has, not what was recorded for
       * it. Both numbers in one `inspect`: the list calls it for every live
       * room.
       */
      // The same rule under the broker: the room census reports memory from
      // the Pod's status, what kubelet set, not what is written in the spec.
      const census = runtimeById.get(row.id)
      const real = runningRoom.has(row.id) && kernelBackend() === 'docker'
        ? await containerLimits(row.id).catch(() => ({ memoryMb: null, cpus: null }))
        : { memoryMb: census?.memoryMb ?? null, cpus: census?.cpus ?? null }
      /*
       * And the same for the personal-notebook container, but only when it
       * exists.
       *
       * Its numbers are the same as the room's (pool.ts · startContainer), yet
       * docker is asked all the same: they can diverge exactly when it
       * matters, when the limit was raised between lessons while one of the
       * containers has been running on the old one since morning.
       */
      const own = withOwn.has(row.id)
        ? await containerLimits(row.id, 'own').catch(() => ({ memoryMb: null, cpus: null }))
        : null
      if (kernelBackend() === 'docker' && ((runningRoom.has(row.id) && real.memoryMb === null)
        || (runningOwn.has(row.id) && own?.memoryMb == null))) complete = false
      const ownDefaults = own ? ownLimits(row.id) : null
      return {
        id: row.id,
        name: row.name,
        memoryMb: real.memoryMb ?? settledMb,
        cpus: real.cpus ?? settledCpus,
        environment: row.environment,
        alive: alive.has(row.id),
        ...(own ? { own: { memoryMb: own.memoryMb ?? ownDefaults?.memoryMb ?? settledMb, cpus: own.cpus ?? ownDefaults?.cpus ?? settledCpus } } : {}),
      }
    }),
  )
  let takenMb = 0, takenCpus = 0
  for (const room of allocations) {
    if (runtimeRooms ? room.alive : runningRoom.has(room.id)) {
      takenMb += room.memoryMb
      takenCpus += room.cpus
      memoryBySlot.set(room.id, room.memoryMb)
    }
    if (runningOwn.has(room.id) && room.own) {
      takenMb += room.own.memoryMb
      takenCpus += room.own.cpus
      memoryBySlot.set(`${room.id}#own`, room.own.memoryMb)
    }
  }
  return { rows: allocations.slice(0, 50), takenMb, takenCpus, memoryBySlot, complete }
}

/* ------------------------------------------------------------ collection */

/**
 * The machine as the server sees it right now.
 *
 * Under the test backend the numbers are made up, and made up plausibly:
 * exactly the machine Colloq rents, a 3090 with 72 GB of memory. Without this
 * the seminar form could be neither viewed nor tested on a developer's
 * laptop: there is no `nvidia-smi` there, and "Resources" would be drawn only
 * halfway.
 */
async function collect(): Promise<Collected> {
  const censusStartedAt = process.hrtime.bigint()
  const fake = kernelBackend() === 'test'
  let instanceCpus = defaultCpus()
  let runtimeRooms: RuntimeRoom[] | undefined
  if (kernelBackend() === 'broker') {
    try {
      const client = kernelRuntimeClient()
      const [health, census] = await Promise.all([client.health(), client.rooms().catch(() => [])])
      instanceCpus = health.defaultCpus ?? instanceCpus
      if (health.ok) rememberBroker(health)
      runtimeRooms = census
    } catch { /* Broker unavailable: retain the last configured estimates. */ }
  }
  const perEnvironment: Record<string, { memoryMb: number; gpu: boolean }> = {}
  for (const name of safeNames()) {
    perEnvironment[name] = { memoryMb: envDefaultMb(name), gpu: safeGpu(name) }
  }
  const allocation = await rooms(instanceCpus, runtimeRooms)
  // A live room already holds its memory; it cannot be handed out a second time.
  const takenMb = allocation.takenMb
  const daemon = await readDaemon()
  const picture = memoryPicture({
    daemonTotalMb: daemon?.totalMb ?? null,
    hostTotalMb: Math.floor(os.totalmem() / MB),
    hostAvailableMb: hostAvailableMb(),
    takenMb,
  })
  /*
   * Under the broker "free" is not MemAvailable but what is not yet promised.
   *
   * A room Pod's requests equal its limits, and the scheduler counts all the
   * promised memory as taken, however little of it Python touches. A node
   * with three empty 16 GB rooms is "almost free" by MemAvailable, yet a
   * fourth room will not fit, which is exactly what the field has to warn
   * about. The smaller of the two: MemAvailable also notices memory promised
   * around us (the cluster itself, the application).
   */
  if (kernelBackend() !== 'test') {
    const unpromised = Math.max(0, picture.totalMb - HOST_RESERVE_MB - takenMb)
    picture.availableMb = Math.min(picture.availableMb ?? unpromised, unpromised)
  }
  const brokerMb = kernelBackend() === 'broker' ? brokerDefaultMb() : null
  const gpus = fake ? [{ index: 0, name: 'NVIDIA GeForce RTX 3090', memoryMb: 24_576 }] : await readGpus()
  // An outage is not an empty machine. Keep admission closed until every
  // running allocation can be counted; the UI may still show fallback rows.
  if (!allocation.complete && kernelBackend() === 'docker') picture.availableMb = 0
  observeWorkMemory(allocation.complete ? allocation.memoryBySlot : null, censusStartedAt)
  return {
    memory: fake ? { totalMb: 73_728, availableMb: 51_200, source: 'host' as const } : picture,
    cpus: fake ? 16 : machineCpus(),
    gpus,
    kernel: {
      defaultMemoryMb: brokerMb ?? defaultMemoryMb(false),
      // The broker has no separate GPU default: a Pod with a card gets the same.
      gpuDefaultMemoryMb: brokerMb ?? defaultMemoryMb(true),
      // CPUs are one number per instance: the environment does not affect
      // them, unlike memory, where a GPU environment asks for four times more.
      defaultCpus: instanceCpus,
      perEnvironment,
    },
    rooms: allocation.rows,
  }
}

/** The environment list is read from disk; an empty directory is no reason to refuse an answer. */
function safeNames(): string[] {
  try {
    return listNames()
  } catch {
    return []
  }
}

/**
 * The environment's default, and "don't know" instead of an exception.
 *
 * The environment name comes from the seminar row, and the environment may
 * have been deleted or renamed since. Resolving its chain throws, and the
 * whole answer would fail on it, for the sake of one line in the room list.
 */
function envDefaultMb(name: string | null): number {
  // KERNEL_MEM_<ENVIRONMENT> and 4g/16g belong to `docker run`; the broker's Pod does not see them.
  if (kernelBackend() === 'broker') return brokerDefaultMb()
  try {
    return memoryLimitMb(name ?? '')
  } catch {
    return defaultMemoryMb(false)
  }
}

function safeGpu(name: string): boolean {
  try {
    return needsGpu(name)
  } catch {
    return false
  }
}

/*
 * Ten seconds, and why they are needed at all.
 *
 * The answer costs a read of /proc, a run of `nvidia-smi` and a
 * `docker inspect` for every live room. The seminar form asks for it on open
 * and on every environment change, and the panel is open for several
 * teachers at once; without memory that is dozens of processes a second on a
 * machine that is busy training someone's neural network at the time. Nobody
 * needs anything fresher than ten seconds here: neither the machine's size
 * nor the list of cards changes that fast.
 */
const TTL_MS = 10_000
let cached: { at: number; value: Collected } | null = null
let inflight: Promise<Collected> | null = null

export async function machineResources(options: { fresh?: boolean; beforeReservations?: boolean } = {}): Promise<Collected> {
  if (options.fresh) cached = null
  const display = (value: Collected): Collected => options.beforeReservations ? value : {
    ...value,
    memory: { ...value.memory, availableMb: value.memory.availableMb === null ? null : Math.max(0, value.memory.availableMb - workBudgetSnapshot().memoryMb) },
  }
  // Reservation changes must be visible immediately even while census is cached.
  if (cached && Date.now() - cached.at < TTL_MS) return display(cached.value)
  // One collection for everyone who asked while it runs: otherwise ten panel
  // tabs start ten `nvidia-smi` in one second, exactly what the cache is for.
  inflight ??= collect()
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = null
    })
  return display(await inflight)
}

/** Forget what was collected, after a room's limit changed. The daemon too: it
 *  is reconfigured less often, but there is no point remembering it longer
 *  than the rooms. */
export function forgetResources(): void {
  cached = null
  seenDaemon = null
  seenAt = 0
  // The broker's numbers are not erased, only marked stale: without them the
  // PATCH bounds would fall back to the node's memory until the next answer.
  brokerAt = 0
}

/* ----------------------------------------------------------- validation */

/** A kernel cannot start with less than this: Jupyter itself with its imports takes hundreds of megabytes. */
export const MIN_ROOM_MB = 512
/** The machine needs something to live on after the room takes its share. */
export const HOST_RESERVE_MB = 1024

export interface MemoryBounds {
  min: number
  max: number
}

/**
 * The bounds within which a limit makes sense at all.
 *
 * The upper one is the machine's memory minus a gigabyte for the machine
 * itself: a room given everything kills not itself but the server beneath it.
 * It has to be checked on the server, not in the form: the panel knows the
 * numbers, but the browser is not the place that decides how much can be
 * taken from the machine.
 *
 * The machine here is the one that runs the containers. Under colima that is
 * its VM, and a bound based on the Mac's memory would let "sixteen gigabytes"
 * through into docker's twelve: `docker run` would answer that with a refusal
 * in the middle of the lesson.
 */
export function memoryBounds(): MemoryBounds {
  const totalMb =
    kernelBackend() === 'test' ? 73_728 : (lastDaemon()?.totalMb ?? Math.floor(os.totalmem() / MB))
  let max = Math.max(MIN_ROOM_MB, totalMb - HOST_RESERVE_MB)
  /*
   * Under the broker it has the last word: its ceiling is stricter if the
   * operator set RUNTIME_KERNEL_MEMORY_MAX. Accepting more here would mean
   * recording for the room a number the broker will not set on a live room
   * and will cut down to the ceiling for a new Pod.
   */
  const brokerMax = kernelBackend() === 'broker' ? lastBroker().maxMb : null
  if (brokerMax !== null) max = Math.max(MIN_ROOM_MB, Math.min(max, brokerMax))
  return { min: MIN_ROOM_MB, max }
}

/**
 * How many CPUs the machine has, by the same rule as memory.
 *
 * Under the test backend the number is made up and the same as in the
 * endpoint's answer: a bound that does not match the label under the field is
 * a refusal nobody can explain to a person.
 */
export function machineCpus(): number {
  if (kernelBackend() === 'test') return 16
  // And for the same reason as memory: a docker that colima gave ten CPUs
  // rejects `--cpus 12` outright, and the room simply does not start.
  return Math.max(1, lastDaemon()?.cpus || os.cpus().length)
}

/**
 * The bounds for CPUs: from one to all the machine has.
 *
 * There is deliberately no "leave the machine a core" reserve like there is
 * for memory: `--cpus` is a share of time, not hardware taken away. A room
 * with eight CPUs out of eight does not leave the server without a processor,
 * it just competes with it for the processor; a room with the machine's
 * memory minus nothing leaves it with no memory at all.
 */
export function cpuBounds(): MemoryBounds {
  return { min: 1, max: Math.min(machineCpus(), kernelBackend() === 'broker' ? 64 : Infinity) }
}

export type CpuInput = { ok: true; cpus: number | null } | { ok: false; error: 'type' | 'range' }

/** The same measure as for memory: an integer, within bounds, and null means "as for the instance". */
export function readCpuInput(value: unknown): CpuInput {
  if (value === null || value === undefined) return { ok: true, cpus: null }
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: 'type' }
  const { min, max } = cpuBounds()
  if (value < min || value > max) return { ok: false, error: 'range' }
  return { ok: true, cpus: value }
}

export type MemoryInput = { ok: true; mb: number | null } | { ok: false; error: 'type' | 'range' }

/**
 * Parse a submitted "how much memory", with one measure for every endpoint.
 *
 * `null` is a legitimate answer and means "as for the environment": that is
 * how a room is returned to the default without inventing a second field for
 * it. A fraction is rejected, not rounded: the form sends whole megabytes,
 * and a fraction here is a sign that it was not the form that sent it.
 */
export function readMemoryInput(value: unknown): MemoryInput {
  if (value === null || value === undefined) return { ok: true, mb: null }
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: 'type' }
  const { min, max } = memoryBounds()
  if (value < min || value > max) return { ok: false, error: 'range' }
  return { ok: true, mb: value }
}

/** A room's effective limit: its own number or its environment's default. */
export function roomMemoryMb(sessionId: string, environment: string | null): number {
  return sessionMemoryMb(sessionId) ?? envDefaultMb(environment)
}
