/**
 * The `docker run` of a class kernel's container, with every input named:
 * home's pool and a machine's agent lay it out with the same function.
 *
 * MOVED OUT OF kernel/pool.ts, AND KEPT PURE. Classes on machines
 * (docs/architecture/remote-classes.md §7.1, «занятия на машинах») run home's
 * own argv on a machine, so that the sandbox there is the same by
 * construction: the same hardened profile, the same thread variables, the
 * same limits, the same one class folder. The machine's agent
 * (dist/runner.js) must build it without the room pool, the database and the
 * settings pool.ts and perimeter.ts read, so nothing here reads a setting,
 * the environment or the clock: the caller computes every input (home: pool.ts
 * · runArgs from its rows and its instance settings; a machine: from the
 * intent home sent it) and this module only lays them out.
 * tests/room-spec-argv.test.mts holds home's argv and a machine's equal flag
 * for flag, and names each difference; tests/runner-import-graph.test.mts
 * holds this module free of home.
 *
 * There are no quotes on purpose: docker is called with an array, without a
 * shell, at home (pool.ts · run) and on a machine (runner-agent/docker.ts).
 */
import { createHash } from 'node:crypto'
import { machinePerimeter, roomHardeningArgs, type RoomNetworkMode } from './perimeter-core.js'

/**
 * Whose container this is: the class's (`room`: every class notebook's kernel
 * and the shared terminal), its students' personal notebooks' (`own`), or the
 * pool of workers that run council attempts (`council`, on machines only,
 * §6.1). Why the first two are separate containers is pool.ts · KernelRole.
 */
export type RoomRole = 'room' | 'own' | 'council'

const ROLES: readonly RoomRole[] = ['room', 'own', 'council']

/** One more folder in a container: the council's epochs and scratch space. */
export interface RoomMount {
  /** The folder as the docker daemon sees it. */
  source: string
  /** Where it appears inside the container. */
  target: string
  readOnly: boolean
}

/** Every input of one class container's `docker run`. */
export interface RoomSpec {
  /** The container's name: `colloq-room-<id>[-<role>]` at home, `colloq-class-<i6>-<id>-<role>` on a machine. */
  name: string
  /**
   * The class's container, its personal notebooks', or its council's.
   *
   * Only the class's gets a card, its label and `--shm-size`, whatever `gpu`
   * says: the class's card is not given to personal notebooks, and that is
   * not a setting but the design (shared/rules.ts · bookHasOwnKernel); the
   * council's workers use the CPU only (D11). Everything else is the same for
   * all three: the same image, the same network, the same hardened profile,
   * the same class folder, but a cgroup and a token of each one's own. The
   * council sees the class folder read-only (D10).
   */
  role: RoomRole
  /** The class: the folder's place inside, `/workspace/<id>`, and the `colloq.session` label. */
  sessionId: string
  /** The environment's name, for the `colloq.environment` label. */
  environment: string
  /** The image to run: `colloq-kernel:<env>` at home, the pinned revision's tag on a machine. */
  image: string
  /**
   * The class folder as the docker daemon sees it, mounted at
   * `/workspace/<id>`: the kernel's working directory is set by the Jupyter
   * session path `<id>/session.ipynb`, so that folder must exist inside,
   * while the rest of `/workspace` does not get in at all.
   */
  mount: string
  /** Folders besides the class's: none at home, the council's epochs and scratch on a machine. */
  extraMounts: readonly RoomMount[]
  /** The network to put the container in; empty — docker's default. */
  network: string
  /**
   * Whether to publish Jupyter on the host loopback: that is how a server on
   * the host (and every machine's agent) reaches it. A server in a container
   * goes by name in the shared network, and the port is not published at all.
   */
  publish: boolean
  /** The card for a GPU room, named the way docker names it; null — none. */
  gpu: string | null
  /**
   * The memory limit of THIS particular container, MB. It overrides the
   * environment's default rather than adding to it: a vision class and a
   * statistics class live on the same image, and the whole difference between
   * them is how much memory they need.
   */
  memoryMb: number
  /**
   * How many CPUs to give THIS particular container. The number decides not
   * only `--cpus` but also the numeric libraries' threads: `os.cpu_count()`
   * inside a container sees the HOST's cores, and a room with two allotted
   * cores would start thirty threads on them.
   */
  cpus: number
  /** The process ceiling (perimeter-core.ts · RoomHardening). */
  pids: number
  /** COLLOQ_ROOM_NETWORK's mode: `none` also points the container's resolver at an address the rules refuse. */
  mode: RoomNetworkMode
  /** The `colloq.profile` label (perimeter-core.ts · profileFor). */
  profile: string
  /** This container's Jupyter token: its own, never another container's. */
  token: string
  /** The class's PYTHONHASHSEED (`classHashSeed`). */
  hashSeed: number
  /**
   * `--shm-size` of a GPU room: home's KERNEL_SHM, else `ROOM_SHM`
   * (pool.ts · roomShm), and the same value on a machine, from the intent.
   */
  shm: string
  /** Labels beyond the standard ones, `key=value`. */
  labels: readonly string[]
}

/** The label home's census looks for (pool.ts · roomContainers): its own rooms, and only those. */
export const ROOM_KERNEL_LABEL = 'colloq.kind=room-kernel'

/**
 * The label a machine's class kernels carry instead (§3). Home's census
 * looks only for `room-kernel`, so it can never mistake a machine's container
 * for one of its rooms, not even on one daemon; the agent finds its own by
 * this label and its INSTANCE_LABEL together.
 */
export const CLASS_KERNEL_LABEL = 'colloq.kind=class-kernel'

/**
 * What a GPU room's shared memory is when nothing else is said: docker's own
 * 64 MB breaks `DataLoader(num_workers=4)` with "bus error".
 */
export const ROOM_SHM = '1g'

/**
 * What a machine adds to home's argv (§7.1). `--pull=never`: the revision was
 * pulled and checked before (runner-agent/images.ts), and a start must never
 * reach a registry for a tag someone moved. The log caps are the submission
 * runs' (competitions/docker-runner.ts · hardeningArgs): raw stdout and
 * stderr bypass the notebook's output budget, and a kernel printing in a loop
 * all lesson must not fill a rented disk.
 */
export const MACHINE_ROOM_FLAGS: readonly string[] = Object.freeze([
  '--pull=never',
  '--log-driver=local',
  '--log-opt=max-size=8m',
  '--log-opt=max-file=2',
])

/** PYTHONHASHSEED's largest value; Python refuses to start with a larger one. */
export const HASH_SEED_MAX = 4294967295

/**
 * The class's PYTHONHASHSEED (D28): 1 + (sha256("colloq-hashseed:" + id) mod
 * 4294967295), so a number from 1 to HASH_SEED_MAX and never 0, which would
 * switch the randomisation off rather than seed it.
 *
 * Derived, not stored: a home restart or a failover derives the same number
 * with nothing kept anywhere, and a class's room, personal and council
 * containers, at home or on any machine, get the same one.
 */
export function classHashSeed(sessionId: string): number {
  const digest = BigInt(`0x${createHash('sha256').update(`colloq-hashseed:${sessionId}`).digest('hex')}`)
  return Number(digest % BigInt(HASH_SEED_MAX)) + 1
}

/**
 * Megabytes in the language `--memory` is set in. The way back, a docker
 * string in megabytes, is admin/resource-settings.ts · parseMemMb.
 */
export function memSpec(mb: number): string {
  return `${Math.floor(mb)}m`
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
function threadLimit(cpus: number): string {
  if (!Number.isFinite(cpus) || cpus <= 0) return '2'
  return String(Math.max(1, Math.floor(cpus)))
}

/**
 * The numbers that, wrong, would leave a container without a limit: docker
 * reads `--memory=0m`, `--cpus=0` and `--pids-limit=0` as "none", and Python
 * does not start with a hash seed out of its range. Home never builds such a
 * spec; a machine's intent comes over the wire, and a container without a
 * ceiling must not be what a broken one gives. A plain error: a caller's
 * mistake, not something to say to a room.
 */
function checkNumbers(spec: RoomSpec): void {
  const bad: string[] = []
  if (!Number.isFinite(spec.memoryMb) || Math.floor(spec.memoryMb) < 1) bad.push(`memoryMb ${spec.memoryMb}`)
  if (!Number.isFinite(spec.cpus) || spec.cpus <= 0) bad.push(`cpus ${spec.cpus}`)
  if (!Number.isSafeInteger(spec.pids) || spec.pids < 1) bad.push(`pids ${spec.pids}`)
  if (!Number.isSafeInteger(spec.hashSeed) || spec.hashSeed < 0 || spec.hashSeed > HASH_SEED_MAX) bad.push(`hashSeed ${spec.hashSeed}`)
  if (bad.length) throw new Error(`room container ${spec.name}: out of range: ${bad.join(', ')}`)
}

/**
 * The `docker run` arguments for a class container at home: pool.ts · runArgs
 * computes the spec, this lays it out.
 *
 * A function of its own, because there is no real docker in the tests, and
 * building this line correctly matters more than calling it: an extra space
 * or a lost flag here means a seminar without a GPU or without isolation, and
 * that can only be noticed during the lesson.
 */
export function roomRunArgs(spec: RoomSpec): string[] {
  return argv(spec, ROOM_KERNEL_LABEL, [])
}

/** The argv itself: home's, and a machine's with its kind label and its flags before the image. */
function argv(spec: RoomSpec, kind: string, beforeImage: readonly string[]): string[] {
  checkNumbers(spec)
  // Only the class's container gets a card. Not "if one was passed" but "if
  // allowed": a caller's mistake must not be able to give the card to personal
  // notebooks or to the council's workers.
  const gpu = spec.role === 'room' ? spec.gpu : null
  const memory = memSpec(spec.memoryMb)
  const threads = threadLimit(spec.cpus)
  return [
    'run',
    '-d',
    '--name',
    spec.name,
    /*
     * Our own room network (on the host, and on a machine) or the shared
     * compose network (the server itself in a container), and in either of
     * them the ban on local addresses applies (perimeter-core.ts).
     */
    ...(spec.network ? ['--network', spec.network] : []),
    /*
     * A port on the host loopback, only when the server is on the host (and
     * always on a machine, whose agent runs on the host's network). The
     * loopback is not decoration here: without it the room's Jupyter is open
     * on every interface, and the lecture hall's Wi-Fi is one of them, or a
     * rented VM's public address. In the container form the port is not
     * published at all.
     */
    ...(spec.publish ? ['-p', '127.0.0.1:0:8888'] : []),
    /*
     * The hardened profile, always, not only when the class is open to the
     * outside: uid 1000, no capabilities, no-new-privileges, a process cap, no
     * IPv6, a profile version label (perimeter-core.ts · roomHardeningArgs).
     */
    ...roomHardeningArgs({ pids: spec.pids, mode: spec.mode, profile: spec.profile }),
    // One slice, named the way docker calls it. A room on an ordinary
    // environment does not get here and takes no device.
    ...(gpu ? ['--gpus', `device=${gpu}`] : []),
    '-e',
    `JUPYTER_TOKEN=${spec.token}`,
    // The room has as many CPUs as it was given, and as many threads. But only
    // as of `docker run`: `docker update --cpus` changes a live container's
    // quota, not its environment variables (see pool.ts · applyCpuLimit).
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
    /*
     * One hash seed for the whole class (D28), the seventh and last variable:
     * a set of strings iterates in the same order, and `hash('…')` gives the
     * same number, in the class's kernel, in its personal notebooks and in
     * the council's workers, which run attempts on a frozen copy of the
     * class kernel's state (§9.3). Python draws a new seed per process
     * otherwise. It is not part of any recreate check: a container created
     * before it runs on without it until it is created again.
     */
    '-e',
    `PYTHONHASHSEED=${spec.hashSeed}`,
    '-v',
    `${spec.mount}:/workspace/${spec.sessionId}${spec.role === 'council' ? ':ro' : ''}`,
    ...spec.extraMounts.flatMap((mount) => ['-v', `${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`]),
    // Student code is arbitrary, exactly as in compose. A runaway cell in
    // one room must not be able to take the host down either.
    `--memory=${memory}`,
    /*
     * Swap exactly equal to memory, for the same reason it is set in
     * `docker update` (pool.ts · applyMemoryLimit): without this flag docker
     * gives the container as much swap again on top, and a kernel that hits
     * the limit does not die but goes to disk; the room stalls for minutes
     * where it would be more honest to say "out of memory" right away.
     */
    `--memory-swap=${memory}`,
    `--cpus=${spec.cpus}`,
    /*
     * Shared memory is needed only where there is a GPU: docker's default is
     * 64 MB, and `DataLoader(num_workers=4)` fails on it with "bus error"
     * without naming the cause. Ordinary rooms do not need it, and extra
     * memory given to everyone is memory taken from neighboring seminars.
     */
    ...(gpu ? [`--shm-size=${spec.shm}`] : []),
    /*
     * `no`, not `unless-stopped`: there is one container per seminar, and a
     * machine reboot would bring up the whole past semester at once. While
     * the server is alive, it restarts a fallen container itself the next time
     * the room is opened.
     */
    '--restart=no',
    '--label',
    kind,
    '--label',
    `colloq.session=${spec.sessionId}`,
    '--label',
    `colloq.environment=${spec.environment}`,
    /*
     * Whose container this is: the class's, its personal notebooks' or its
     * council's.
     *
     * Set on all, including the room one, where the value would be implied
     * anyway: the label is needed by the sweep, the slice allocation and
     * `colloq status`, and they read `docker ps`, that is, also yesterday's
     * containers started by a process that no longer exists. A missing label
     * reads as `room` (see pool.ts · KernelRole), so live containers survive a
     * rollout without being recreated.
     */
    '--label',
    `colloq.role=${spec.role}`,
    // The label is the source of truth about who holds a slice: it survives
    // a server restart, and the in-memory map does not.
    ...(gpu ? ['--label', `colloq.gpu=${gpu}`] : []),
    ...spec.labels.flatMap((label) => ['--label', label]),
    ...beforeImage,
    spec.image,
  ]
}

/* --------------------------------------------------------------- machines */

/** The class id's alphabet: shared/runtime.ts · RUNTIME_SESSION_ID, which a container name and a label can carry as is. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/

/** What a machine knows of a placement beyond the spec: whose agent it is and which generation. */
export interface MachinePlacement {
  /** The agent's INSTANCE_LABEL (runner-agent/images.ts), `ru.colloq.competition-instance=<hex>`. */
  instanceLabel: string
  /** The placement's generation: every write about it carries it (§6.9). */
  gen: number
}

/**
 * A machine's spec: the name, the network, the publishing and the labels are
 * the machine's by rule (`machineRoomRunArgs`), so the agent cannot get one of
 * them wrong. And it never runs `open`: home's mode is the floor there, and
 * `open` is no mode for somebody else's LAN (perimeter-core.ts ·
 * machinePerimeterPlan).
 */
export type MachineRoomSpec = Omit<RoomSpec, 'name' | 'network' | 'publish' | 'labels' | 'mode'> & {
  mode: 'blocked' | 'none'
}

/** The key of the placement label: `colloq.placement=<id>:<role>:<gen>`. */
export const PLACEMENT_LABEL = 'colloq.placement'

/** One slot of a class at one generation, as its container's label names it. */
export interface PlacedSlot {
  sessionId: string
  role: RoomRole
  gen: number
}

function checkSlot(slot: PlacedSlot): void {
  if (!SESSION_ID.test(slot.sessionId)) throw new Error(`not a class id: ${JSON.stringify(slot.sessionId)}`)
  if (!ROLES.includes(slot.role)) throw new Error(`not a class container role: ${JSON.stringify(slot.role)}`)
  if (!Number.isSafeInteger(slot.gen) || slot.gen < 1) throw new Error(`not a placement generation: ${slot.gen}`)
}

/** The placement label of a slot, `colloq.placement=<id>:<role>:<gen>`, as `--label` takes it. */
export function placementLabel(slot: PlacedSlot): string {
  checkSlot(slot)
  return `${PLACEMENT_LABEL}=${slot.sessionId}:${slot.role}:${slot.gen}`
}

/**
 * The slot a container's placement label names, read back (the agent's
 * adoption after its restart, §7.3); null for a value that is not one, which
 * the agent treats as a container of no placement it knows.
 */
export function slotOfPlacementLabel(value: string): PlacedSlot | null {
  const match = /^([A-Za-z0-9_-]{1,64}):(room|own|council):([1-9]\d{0,15})$/.exec(value.trim())
  if (!match) return null
  const gen = Number(match[3])
  return Number.isSafeInteger(gen) ? { sessionId: match[1]!, role: match[2] as RoomRole, gen } : null
}

/**
 * A class container's name on a machine: `colloq-class-<i6>-<id>-<role>`,
 * `<i6>` being the agent's six hex characters (perimeter-core.ts ·
 * machinePerimeter). The role is always spelled out, unlike home's
 * `colloq-room-<id>`: a machine holds nothing from before the role existed.
 */
export function machineRoomContainer(instanceLabel: string, sessionId: string, role: RoomRole): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`not a class id: ${JSON.stringify(sessionId)}`)
  if (!ROLES.includes(role)) throw new Error(`not a class container role: ${JSON.stringify(role)}`)
  return `colloq-class-${machinePerimeter(instanceLabel).i6}-${sessionId}-${role}`
}

/**
 * The `docker run` of a class container on a machine: home's argv for the
 * same spec, with what is the machine's by rule (§7.1).
 *
 *   - its name, `machineRoomContainer`, and its network, the machine's own
 *     bridge `colloq-mrooms-<i6>` behind the machine's chains;
 *   - Jupyter published on 127.0.0.1 only, the form a home on the host uses:
 *     the agent reaches it from the host's network, and a rented VM's public
 *     address never sees port 8888;
 *   - `colloq.kind=class-kernel` in place of `room-kernel`, the placement
 *     label with its generation, and the agent's INSTANCE_LABEL, by which it
 *     adopts its containers after a restart and which no other agent's sweep
 *     touches;
 *   - `MACHINE_ROOM_FLAGS`: never a pull, and the submission runs' log caps.
 */
export function machineRoomRunArgs(spec: MachineRoomSpec, placement: MachinePlacement): string[] {
  const slot = { sessionId: spec.sessionId, role: spec.role, gen: placement.gen }
  return argv(
    {
      ...spec,
      name: machineRoomContainer(placement.instanceLabel, spec.sessionId, spec.role),
      network: machinePerimeter(placement.instanceLabel).network,
      publish: true,
      labels: [placementLabel(slot), placement.instanceLabel],
    },
    CLASS_KERNEL_LABEL,
    MACHINE_ROOM_FLAGS,
  )
}
