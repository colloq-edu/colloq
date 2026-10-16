/**
 * The room container's perimeter on this server's docker: the hardened
 * profile's numbers read from the instance, and the ban on local addresses
 * installed, remembered for a minute and refused in the instance's language.
 *
 * What the perimeter is, and why every flag and rule is the way it is, lives
 * with the flags and rules themselves in perimeter-core.ts: they moved there,
 * pure, so that a machine's agent lays out the very same ones for classes on
 * machines (docs/architecture/remote-classes.md §7.1). What stays here is
 * home's: the process ceilings, which are instance settings in the database
 * (admin/resource-settings.ts), and the installation on this server's docker,
 * with the server's own image for the helper and a refusal a teacher reads.
 * Every name that lived here is still exported from here, so nothing that
 * imports this module changes.
 */
import fs from 'node:fs'
import os from 'node:os'
import { tr } from '@shared/i18n'
import { resourceValue } from '../admin/resource-settings.js'
import {
  ROOM_NETWORK,
  blockedCidrsSetting,
  helperArgs,
  ipv4Subnets,
  networkCreateArgs,
  ownAddresses,
  perimeterRemovalScript,
  perimeterScript,
  profileFor,
  roomHardeningArgs as hardeningArgs,
  roomNetworkMode,
  roomSubnetSetting,
  type PerimeterPlan,
  type RoomHardening,
} from './perimeter-core.js'

export {
  BLACKHOLE_DNS,
  BLOCKED_V4,
  DEFAULT_ROOM_SUBNET,
  PERIMETER_KIND,
  PERIMETER_TAG,
  ROOM_NETWORK,
  ROOM_PROFILE,
  blockedCidrsSetting,
  helperArgs,
  ipv4InCidr,
  ipv4Subnets,
  networkCreateArgs,
  ownAddresses,
  parseCidr,
  parseIpv4,
  perimeterRemovalScript,
  perimeterRules,
  perimeterScript,
  roomNetworkMode,
  roomProfile,
  roomSubnetSetting,
  type PerimeterPlan,
  type RoomNetworkMode,
} from './perimeter-core.js'

/* -------------------------------------------------------------- settings */

/**
 * The room's process ceiling, 512 by default: the instance setting `roomPids`
 * (admin/resource-settings.ts), then KERNEL_PIDS. Read at `docker run`, so a
 * change reaches the next container, not a running one.
 *
 * A fork bomb in a cell without a ceiling takes down not the room but the
 * machine, and every neighbouring class with it. 512 is plenty for Jupyter,
 * the kernel, the terminal and `DataLoader(num_workers=8)`; production keeps
 * 256 per Pod (deploy/k3s).
 */
export function pidsLimit(env: NodeJS.ProcessEnv = process.env): number {
  return resourceValue('roomPids', env)
}

/**
 * The process ceiling of the PERSONAL NOTEBOOKS CONTAINER, 2048 by default:
 * the instance setting `ownPids`, then KERNEL_OWN_PIDS.
 *
 * A separate number, because it counts something else. A room container holds
 * one kernel per class notebook plus the terminal; the personal notebooks
 * container holds dozens of kernels at once, one per open draft, and each
 * ipykernel keeps a dozen and a half threads on its own. The room's 512 runs
 * out already at thirty kernels, and that ends not in a refusal but in a
 * `BlockingIOError` in the middle of someone else's run. 2048 is the same 512
 * "per room" multiplied by a ceiling of live kernels (pool.ts ·
 * ownKernelMax): a fork bomb still hits a wall, and that wall is not the
 * neighbour's. The council's container holds dozens of worker kernels too,
 * and takes the same ceiling.
 */
export function ownPidsLimit(env: NodeJS.ProcessEnv = process.env): number {
  return resourceValue('ownPids', env)
}

/* ------------------------------------------------------- docker run flags */

/**
 * What one container's hardened profile is made of on this server: the
 * ceiling of its role, and the mode and profile label of COLLOQ_ROOM_NETWORK.
 * pool.ts · runArgs builds its argv from these very numbers, so its flags are
 * `roomHardeningArgs` of the same role by construction.
 */
export function roomHardening(
  env: NodeJS.ProcessEnv = process.env,
  role: 'room' | 'own' | 'council' = 'room',
): RoomHardening {
  const mode = roomNetworkMode(env)
  return { pids: role === 'room' ? pidsLimit(env) : ownPidsLimit(env), mode, profile: profileFor(mode) }
}

/**
 * Room container hardening for this server (perimeter-core.ts ·
 * roomHardeningArgs, with the numbers `roomHardening` reads): uid 1000, no
 * capabilities, no-new-privileges, a process ceiling, no IPv6, a profile
 * version label.
 */
export function roomHardeningArgs(
  env: NodeJS.ProcessEnv = process.env,
  /** The personal notebooks container uses its own ceiling, `ownPidsLimit`, and so does the council's. */
  role: 'room' | 'own' | 'council' = 'room',
): string[] {
  return hardeningArgs(roomHardening(env, role))
}

/* --------------------------------------------------------- installation */

interface RunResult {
  code: number
  out: string
}
export type DockerRun = (args: string[], timeoutMs?: number) => Promise<RunResult>

/**
 * Refusing a room without the ban: the text is translated and says what to do.
 * The key picks the text: the helper failed (the default), the operator's
 * blocklist is broken, there is no image the helper may run from.
 */
export class RoomPerimeterError extends Error {
  constructor(
    readonly reason: string,
    key:
      | 'server.roomPerimeter.refused'
      | 'server.roomPerimeter.badBlockedCidrs'
      | 'server.roomPerimeter.noHelperImage' = 'server.roomPerimeter.refused',
  ) {
    super(tr(key, { p0: reason }))
    this.name = 'RoomPerimeterError'
  }
}

/**
 * Where the rooms are and how to recognise them: the network name, and whether
 * to create it ourselves.
 *
 * On the host (`make dev`, `colloq start`, `make run`) the network is ours,
 * `colloq-rooms`. In a container (`make up`, vast) rooms live on the network
 * the server shares with them (KERNEL_NETWORK); whoever launched us creates
 * it, and we read the subnet from docker.
 */
export interface RoomNetworkTarget {
  network: string
  create: boolean
}

/**
 * Success is remembered for a minute, no longer.
 *
 * A rule can disappear: a reboot of the colima or Docker Desktop VM, an
 * `iptables -F` by hand. Checking on every room start would mean an extra
 * privileged container for each of thirty students in the first minute of
 * class; never checking would mean trusting a rule that is no longer there. A
 * minute is one helper per wave of starts, and a fresh look after any daemon
 * restart (which itself takes longer).
 */
const FRESH_MS = 60_000

let applied: { key: string; at: number } | null = null
let inflight: Promise<void> | null = null
/** The last refusal, so it can be told to those who ask about the state too. */
let lastProblem: string | null = null
let openAnnounced = false
/** Said once per process: a setting that has nothing to act on. */
let ignoredAnnounced = false
/** The server's own image ID, once found: a running container never changes its image. */
let ownImage: string | null = null

export function perimeterProblem(): string | null {
  return lastProblem
}

/** Do not trust the remembered success: the next room start asks docker again. */
export function perimeterStale(): void {
  applied = null
}

/** Forget everything, for tests, so one case does not inherit another's memory. */
export function forgetPerimeter(): void {
  applied = null
  inflight = null
  lastProblem = null
  openAnnounced = false
  ignoredAnnounced = false
  ownImage = null
}

/** The rooms network's subnets; creates it if it is our network and missing. */
async function roomSubnets(docker: DockerRun, target: RoomNetworkTarget): Promise<string[]> {
  const inspect = () =>
    docker(['network', 'inspect', target.network, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'], 10_000)
  let found = await inspect()
  if (found.code !== 0 && target.create) {
    const { subnet, explicit } = roomSubnetSetting()
    let made = await docker(networkCreateArgs(subnet), 30_000)
    /*
     * The subnet already belongs to someone (another docker network on this
     * machine), and it was not named explicitly: let docker choose. The rules
     * are written for the subnet the network actually got anyway, not for the
     * default.
     */
    if (made.code !== 0 && !explicit && /overlap/i.test(made.out)) {
      console.warn(`[kernel] ${subnet} is taken on this Docker; ${ROOM_NETWORK} gets a subnet from Docker's pool`)
      made = await docker(networkCreateArgs(null), 30_000)
    }
    // Two processes created the network at once: for the second it is enough
    // that the network exists.
    if (made.code !== 0 && !/already exists/i.test(made.out)) {
      throw new RoomPerimeterError(`docker network create ${ROOM_NETWORK}: ${made.out.slice(-200)}`)
    }
    if (made.code === 0) console.log(`[kernel] created docker network ${ROOM_NETWORK} for room kernels`)
    found = await inspect()
  }
  if (found.code !== 0) throw new RoomPerimeterError(`docker network inspect ${target.network}: ${found.out.slice(-200)}`)
  const subnets = ipv4Subnets(found.out)
  if (subnets.length === 0) throw new RoomPerimeterError(`network ${target.network} has no IPv4 subnet`)
  return subnets
}

export interface HelperImageOptions {
  env?: NodeJS.ProcessEnv
  /** Whether the server itself runs in a container: `/.dockerenv`, the marker pool.ts uses too. */
  inContainer?: () => boolean
  /** This container's name as docker knows it, when COLLOQ_CONTAINER does not say. */
  hostname?: () => string
}

const IMAGE_ID = /^(?:sha256:)?[a-f0-9]{64}$/

/**
 * The image the privileged helper runs from.
 *
 * It used to be the room's kernel image, and that made it the weakest link on
 * the machine: the helper runs as root with the host's pid and network
 * namespaces, while the kernel image is built from package lists any teacher
 * edits in the panel, pip options included. One poisoned package in a list
 * would run as root on the host at the next room start. So, in order:
 *
 *   1. COLLOQ_HELPER_IMAGE, when the operator names one (a digest-pinned
 *      minimal image with sh and nsenter). It must already be on the machine:
 *      the helper never pulls.
 *   2. The server's own image, when the server runs in a container (the Vast
 *      image, `make up`): built by CI, not editable from the panel, certainly
 *      present, and it has nsenter. Found the way the image's entry point
 *      finds itself (deploy/vast/entrypoint.sh · locate_self): COLLOQ_CONTAINER,
 *      else the hostname, which docker sets to the container ID.
 *   3. Today's choice on a teacher's own machine, where the server runs on
 *      the host and has no image: the room's kernel image, else any
 *      colloq-kernel. The teacher who edits the lists is the machine's owner
 *      there.
 *
 * Images from the first two come back as their ID, exactly the bytes that
 * were inspected: a tag moved between the inspect and the run cannot swap
 * them. Null only in the third case with no kernel image at all: there is
 * nothing to bring a room up from either, and that refusal says "environment
 * not built" before this one does. When the first two cannot be satisfied,
 * this refuses rather than falling back to the kernel image, which would
 * reopen exactly the hole this closes.
 */
export async function helperImage(
  docker: DockerRun,
  preferred: string | null,
  options: HelperImageOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env
  const override = (env.COLLOQ_HELPER_IMAGE ?? '').trim()
  if (override) {
    const found = await docker(['image', 'inspect', '--format', '{{.Id}}', override], 10_000)
    const id = found.out.trim()
    if (found.code !== 0 || !IMAGE_ID.test(id)) {
      throw new RoomPerimeterError(`COLLOQ_HELPER_IMAGE=${override} is not on this Docker; docker pull it first`, 'server.roomPerimeter.noHelperImage')
    }
    return id
  }
  if ((options.inContainer ?? (() => fs.existsSync('/.dockerenv')))()) {
    if (ownImage) return ownImage
    const self = (env.COLLOQ_CONTAINER ?? '').trim() || (options.hostname ?? os.hostname)()
    const found = await docker(['inspect', '--type', 'container', '--format', '{{.Image}}', self], 10_000)
    const id = found.out.trim()
    if (found.code !== 0 || !IMAGE_ID.test(id)) {
      throw new RoomPerimeterError(
        `this server's container "${self}" is not visible to Docker; set COLLOQ_CONTAINER to its name, or COLLOQ_HELPER_IMAGE`,
        'server.roomPerimeter.noHelperImage',
      )
    }
    ownImage = id
    return id
  }
  if (preferred) {
    const own = await docker(['image', 'inspect', preferred, '--format', '{{.Id}}'], 10_000)
    if (own.code === 0) return preferred
  }
  const any = await docker(['images', 'colloq-kernel', '--format', '{{.Repository}}:{{.Tag}}'], 10_000)
  if (any.code !== 0) return null
  return any.out.split('\n').map((line) => line.trim()).find((line) => line && !line.endsWith(':<none>')) ?? null
}

/**
 * The rooms network exists and the ban on local addresses is in place, or a
 * refusal.
 *
 * Called before every `docker run` and `docker start` of a room (success is
 * remembered for a minute, simultaneous calls share one helper) and once at
 * server start. Throws RoomPerimeterError, and then the room does not come up.
 */
export async function ensureRoomPerimeter(
  docker: DockerRun,
  target: RoomNetworkTarget,
  image: string | null,
  options: HelperImageOptions = {},
): Promise<void> {
  const subnets = await roomSubnets(docker, target)
  return applyPerimeter(docker, target, subnets, image, options)
}

/**
 * The same at server start, in advance, so that the first room does not wait
 * for the helper and the operator sees a refusal in the journal before class,
 * not at the first Run.
 *
 * No kernel image yet (vast builds it in the background after start) is not a
 * refusal on a machine where the helper would run from it: there is nothing
 * to bring a room up from anyway, and the room's first start will install the
 * ban. Where the helper runs from the server's own image, the ban goes up now.
 */
export async function warmPerimeter(
  docker: DockerRun,
  target: RoomNetworkTarget,
  image: string,
  options: HelperImageOptions = {},
): Promise<void> {
  try {
    if (roomNetworkMode() !== 'open' && (await helperImage(docker, image, options)) === null) {
      console.log('[kernel] no kernel image yet; the room network block is installed with the first room')
      return
    }
    await ensureRoomPerimeter(docker, target, image, options)
  } catch (err) {
    console.error(`[kernel] ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * What the rules are made of in the current mode, or the refusal of a broken
 * blocklist. A setting that has nothing to act on (v6 ranges; any list in the
 * `none` mode, which refuses everything anyway) is said once, not refused.
 */
function perimeterPlan(mode: 'blocked' | 'none', subnets: string[], exempt: string[]): PerimeterPlan {
  const { cidrs, ignored, invalid } = blockedCidrsSetting()
  if (mode === 'none') {
    if ((cidrs.length || ignored.length || invalid.length) && !ignoredAnnounced) {
      ignoredAnnounced = true
      console.warn('[kernel] COLLOQ_ROOM_NETWORK=none refuses everything a room starts; KERNEL_BLOCKED_CIDRS has nothing to add')
    }
    return { subnets, exempt, mode }
  }
  if (invalid.length) throw new RoomPerimeterError(invalid.join(', ').slice(0, 300), 'server.roomPerimeter.badBlockedCidrs')
  if (ignored.length && !ignoredAnnounced) {
    ignoredAnnounced = true
    console.warn(`[kernel] KERNEL_BLOCKED_CIDRS: rooms have no IPv6, so ${ignored.join(', ')} has nothing to block`)
  }
  return cidrs.length ? { subnets, exempt, mode, extra: cidrs } : { subnets, exempt, mode }
}

async function applyPerimeter(
  docker: DockerRun,
  target: RoomNetworkTarget,
  subnets: string[],
  image: string | null,
  options: HelperImageOptions,
): Promise<void> {
  const mode = roomNetworkMode()
  if (mode === 'open') {
    lastProblem = null
    if (!openAnnounced) {
      openAnnounced = true
      console.warn(
        '[kernel] COLLOQ_ROOM_NETWORK=open: room kernels can reach this machine, its LAN and cloud metadata. Remove the line to block local addresses.',
      )
      if ((process.env.KERNEL_BLOCKED_CIDRS ?? '').trim()) {
        console.warn('[kernel] COLLOQ_ROOM_NETWORK=open lifts every block, KERNEL_BLOCKED_CIDRS included')
      }
      // Open means open: a ban installed by a previous run is removed. If that
      // fails (the helper is not allowed here anyway, or has no image to run
      // from), there is nothing to remove.
      const img = await helperImage(docker, image, options).catch(() => null)
      if (img) {
        const res = await docker(helperArgs(img, perimeterRemovalScript()), 30_000)
        if (res.code === 0 && /removed/.test(res.out)) applied = null
      }
    }
    return
  }
  let plan: PerimeterPlan
  try {
    plan = perimeterPlan(mode, subnets, target.create ? [] : ownAddresses(subnets))
  } catch (err) {
    applied = null
    lastProblem = err instanceof Error ? err.message : String(err)
    throw err
  }
  const key = JSON.stringify(plan)
  if (applied && applied.key === key && Date.now() - applied.at < FRESH_MS) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const img = await helperImage(docker, image, options)
      if (!img) throw new RoomPerimeterError('no colloq-kernel image to run the firewall helper from')
      const res = await docker(helperArgs(img, perimeterScript(plan)), 60_000)
      if (res.code !== 0 || !/colloq-perimeter: ok/.test(res.out)) {
        const said = res.out.split('\n').filter((line) => line.trim()).slice(-2).join(' · ')
        throw new RoomPerimeterError((said || `exit ${res.code}`).slice(0, 300))
      }
      if (!applied || applied.key !== key) {
        const what =
          plan.mode === 'none'
            ? 'no outbound traffic (COLLOQ_ROOM_NETWORK=none)'
            : plan.extra?.length
              ? `local addresses and ${plan.extra.length} extra range(s) blocked (KERNEL_BLOCKED_CIDRS)`
              : 'local addresses blocked'
        console.log(`[kernel] room network ${target.network}: ${what} for ${subnets.join(', ')}`)
      }
      applied = { key, at: Date.now() }
      lastProblem = null
    } catch (err) {
      applied = null
      lastProblem = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      inflight = null
    }
  })()
  return inflight
}
