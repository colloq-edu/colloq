/**
 * The machine as its agent measures it: its facts (what it tells home at
 * join and after each start), its cards (in every sync), and what it can
 * still take (`free`, in every sync and every outcome).
 *
 * WHAT IT CAN STILL TAKE IS home's admission ARITHMETIC ON THIS MACHINE'S
 * NUMBERS (§5.2). Home weighs its own runs with competitions/capacity.ts ·
 * admitJob: the promised memory (the machine less the host's reserve less
 * every reservation) and the measured one (MemAvailable less a floor), each
 * covering the other's blind spot. A machine has no rooms to count, so the
 * promised half is MemTotal less REMOTE_HOST_RESERVE_MB less (memory +
 * REMOTE_CONTAINER_CUSHION_MB) for every attempt it holds, and less what the
 * Docker runner still holds for containers whose removal failed; the measured
 * half is MemAvailable less the same floor admitJob keeps. MemAvailable is
 * taken raw: the containers already running took their memory out of it, and
 * subtracting their reservations again made every run cost the machine twice
 * (capacity.ts says how that was found). CPUs: nproc less one for the agent
 * and the daemon, less each attempt's. Disk: what the tree's filesystem has
 * free, less REMOTE_DISK_RESERVE_MB and REMOTE_ATTEMPT_DISK_MB per attempt
 * (a run is read-only but for its folders in the tree). Places: those, and
 * never more than home's own cap allows (approvedSlots, the owner's «Места»).
 *
 * Docker's own store is another matter: pulls land there, and on a host where
 * it is a partition of its own, a disk the tree's statfs never sees fills
 * (measureDockerDisk, for the pulls' gate and the eviction of revisions).
 *
 * WHAT IS SUBTRACTED IS EVERY ATTEMPT THAT WILL HOLD SOMETHING, accepted ones
 * included. Home recomputes the machine's room as the free it offers plus what
 * its sync lists, less what home has leased to it (§3.4 "Stale capacity"), so
 * an attempt listed but not subtracted here would be counted as room twice.
 * An attempt whose container is gone (exporting, uploading) holds nothing and
 * is not subtracted: listed and leased, it cancels out at home.
 *
 * Nothing here throws, and nothing is made up: a number nobody can read is
 * left out of the bound it would have set (MemAvailable on macOS), the way
 * admitJob never refuses for "don't know".
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  REMOTE_ATTEMPTS_MAX,
  REMOTE_ATTEMPT_DISK_MB,
  REMOTE_CARDS_MAX,
  REMOTE_CARD_MB_MAX,
  REMOTE_CONTAINER_CUSHION_MB,
  REMOTE_CPUS_MAX,
  REMOTE_DISK_MB_MAX,
  REMOTE_DISK_RESERVE_MB,
  REMOTE_HOSTNAME_CHARS,
  REMOTE_HOST_RESERVE_MB,
  REMOTE_LABEL_CHARS,
  REMOTE_MEMORY_MB_MAX,
  REMOTE_PER_DEVICE_MAX,
  remoteCount,
  remoteText,
  type RemoteCard,
  type RemoteFacts,
  type RemoteFree,
} from '@shared/remote-runner'
import { readMeminfo, type Meminfo } from '../ops/meminfo.js'
import { cardsInContainer, type CardRow, type DockerRead } from '../kernel/card-probe.js'
import { cardsInUse, pickRunnerGpu } from '../competitions/gpu-math.js'
import { dockerWords, type Docker, type DockerResult } from './docker.js'

const MB = 1024 * 1024

/**
 * What MemAvailable must still hold after a run: competitions/capacity.ts ·
 * MEMORY_FLOOR_MB, which this bundle may not import (it loads the room census
 * and the database). tests/runner-agent-execute.test.mts holds the two equal.
 */
export const ADMISSION_FLOOR_MB = 512

/** The least a lease can ask for (shared/remote-runner.ts · limitsOf): 128 MB and its cushion, one CPU. */
const SMALLEST_RUN_MB = 128 + REMOTE_CONTAINER_CUSHION_MB

/* ----------------------------------------------------------- the picture */

/** The machine's numbers now; `null` — not readable here. */
export interface MachinePicture {
  memTotalMb: number | null
  memAvailableMb: number | null
  cpus: number
  diskFreeMb: number | null
  diskTotalMb: number | null
}

/**
 * Read off the machine: /proc/meminfo (the host's, from inside the agent's
 * container, unless the host fakes it), the CPUs this process may run on, and
 * the filesystem the tree lives on. Without /proc (macOS, a developer's
 * runner-dev) the total is Node's and MemAvailable unknown.
 */
export function readMachine(root: string, meminfo: Meminfo | null = readMeminfo()): MachinePicture {
  let diskFreeMb: number | null = null
  let diskTotalMb: number | null = null
  try {
    const stat = fs.statfsSync(root)
    diskFreeMb = Math.floor((Number(stat.bavail) * Number(stat.bsize)) / MB)
    diskTotalMb = Math.floor((Number(stat.blocks) * Number(stat.bsize)) / MB)
  } catch {
    /* not a mounted filesystem we can ask */
  }
  return {
    memTotalMb: meminfo?.totalMb ?? Math.floor(os.totalmem() / MB),
    memAvailableMb: meminfo ? meminfo.availableMb : null,
    cpus: Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length),
    diskFreeMb,
    diskTotalMb,
  }
}

/** What an attempt holds while it holds anything: its lease's memory and CPUs. */
export interface Holding {
  memoryMb: number
  cpus: number
}

/**
 * What the machine can still take (see the header). `heldMb` is what the
 * Docker runner still holds for containers it failed to remove
 * (DockerCompetitionRunner.capacity · heldMb); `attempts` counts every held
 * attempt, each with its share of disk and a place; `gpuShares` comes from
 * cardReport; `approvedSlots` is the places home allows this machine at once
 * (its sync reply's, null — no cap of home's), of which the attempts take
 * theirs. Home applies its cap too (lease.ts · runnerRoom), so this only keeps
 * the machine from offering what it may not have: what home reads, the
 * panel's «места» and the forecast among it, is what the machine will take.
 */
export function freeCapacity(input: {
  picture: MachinePicture
  holding: readonly Holding[]
  heldMb: number
  attempts: number
  gpuShares: number
  approvedSlots?: number | null
}): RemoteFree {
  const { picture } = input
  const reservedMb = input.holding.reduce((sum, hold) => sum + hold.memoryMb + REMOTE_CONTAINER_CUSHION_MB, 0) + Math.max(0, input.heldMb)
  const bounds: number[] = []
  if (picture.memTotalMb !== null) bounds.push(picture.memTotalMb - REMOTE_HOST_RESERVE_MB - reservedMb)
  if (picture.memAvailableMb !== null) bounds.push(picture.memAvailableMb - ADMISSION_FLOOR_MB)
  const memoryMb = remoteCount(bounds.length > 0 ? Math.min(...bounds) : 0, 0, REMOTE_MEMORY_MB_MAX)
  const cpus = remoteCount(picture.cpus - 1 - input.holding.reduce((sum, hold) => sum + hold.cpus, 0), 0, REMOTE_CPUS_MAX)
  const diskMb = remoteCount(picture.diskFreeMb === null ? 0 : picture.diskFreeMb - REMOTE_DISK_RESERVE_MB - REMOTE_ATTEMPT_DISK_MB * input.attempts, 0, REMOTE_DISK_MB_MAX)
  // How many more of the smallest run a lease may be, within home's cap on the places.
  const approved = input.approvedSlots ?? null
  const slots = Math.max(0, Math.min(
    REMOTE_ATTEMPTS_MAX - input.attempts,
    approved === null ? REMOTE_ATTEMPTS_MAX : approved - input.attempts,
    cpus,
    Math.floor(memoryMb / SMALLEST_RUN_MB),
    Math.floor(diskMb / REMOTE_ATTEMPT_DISK_MB),
  ))
  return { slots, memoryMb, cpus, gpuShares: remoteCount(input.gpuShares, 0, REMOTE_CARDS_MAX * REMOTE_PER_DEVICE_MAX), diskMb }
}

/**
 * Whether one more run of this size fits right now, by admitJob's two
 * checks on the machine's own numbers (the header): the lease is already
 * counted among `holding`, so the promised bound must stay at or above zero,
 * and MemAvailable must still hold the run and the floor. Unknown is never a
 * refusal.
 */
export function memoryFits(picture: MachinePicture, holding: readonly Holding[], heldMb: number, run: Holding): boolean {
  const reservedMb = holding.reduce((sum, hold) => sum + hold.memoryMb + REMOTE_CONTAINER_CUSHION_MB, 0) + Math.max(0, heldMb)
  if (picture.memTotalMb !== null && picture.memTotalMb - REMOTE_HOST_RESERVE_MB - reservedMb < 0) return false
  if (picture.memAvailableMb !== null && picture.memAvailableMb < run.memoryMb + REMOTE_CONTAINER_CUSHION_MB + ADMISSION_FLOOR_MB) return false
  return true
}

/** Whether the disk still holds the attempts and the floor (the same arithmetic as `free.diskMb`). */
export function diskFits(picture: MachinePicture, attempts: number): boolean {
  return picture.diskFreeMb === null || picture.diskFreeMb - REMOTE_DISK_RESERVE_MB - REMOTE_ATTEMPT_DISK_MB * attempts >= 0
}

/* ----------------------------------------------------------------- cards */

/** A card as the probe found it: its index (how `--gpus device=` names it), its name and memory. */
export interface ProbedCard {
  device: string
  name: string | null
  memoryMb: number | null
}

/** A run that holds a share of a card, at the runs per card its lease pinned. */
export interface CardRun {
  device: string
  perDevice: number
}

/**
 * The cards as a sync reports them, and the shares still free on them, at
 * `perDevice` runs per card (what home last said). The places taken are
 * competitions/gpu-math.ts · cardsInUse's, which weighs each run by the share
 * its lease pinned and counts a container awaiting removal (`held`) as a run:
 * a run taken at one per card holds the whole card, whatever home says now.
 * `busyShares` is the runs on the card by head, which stays above perDevice
 * for a while after home lowers it, while those runs finish.
 *
 * A card a class's room holds whole (`whole`: remote-classes.md §6.5, among
 * `runs` as a run at one per card) is reported with every share of it busy,
 * whatever runs per card home says: home's take (lease.ts · cardRoom) counts
 * the heads it does not know as shares held, and finds no share there.
 */
export function cardReport(
  cards: readonly ProbedCard[],
  perDevice: number,
  runs: readonly CardRun[],
  held: Readonly<Record<string, number>> = {},
  whole: ReadonlySet<string> = new Set(),
): { cards: RemoteCard[]; freeShares: number } {
  const per = remoteCount(perDevice, 1, REMOTE_PER_DEVICE_MAX)
  const capacity = cards.map((card) => ({ id: card.device, capacity: per }))
  const used = cardsInUse(capacity, runs, held)
  let freeShares = 0
  const reported: RemoteCard[] = cards.slice(0, REMOTE_CARDS_MAX).map((card) => {
    const heads = runs.filter((run) => run.device === card.device).length + Math.max(0, Math.floor(held[card.device] ?? 0))
    if (!whole.has(card.device)) freeShares += Math.max(0, per - (used.get(card.device) ?? 0))
    return {
      device: card.device,
      name: card.name === null ? null : remoteText(card.name, REMOTE_LABEL_CHARS, 'start') || null,
      memoryMb: card.memoryMb === null ? null : remoteCount(card.memoryMb, 1, REMOTE_CARD_MB_MAX),
      perDevice: per,
      busyShares: remoteCount(whole.has(card.device) ? Math.max(heads, per) : heads, 0, REMOTE_PER_DEVICE_MAX),
    }
  })
  return { cards: reported, freeShares }
}

/**
 * The card a GPU class room takes whole (remote-classes.md §6.5): the first
 * card with no share in use at all — no run of a submission, no smoke test,
 * no container awaiting removal, no other class — by pickRunnerGpu, the rule
 * every card here is picked by; `null` — none is free, and the room does not
 * start (`gpu`). The room then holds it as a run at one per card would, so
 * nothing else is placed on it until its container is gone.
 */
export function pickWholeCard(cards: readonly ProbedCard[], runs: readonly CardRun[], held: Readonly<Record<string, number>> = {}): string | null {
  const capacity = cards.map((card) => ({ id: card.device, capacity: 1 }))
  const used = cardsInUse(capacity, runs, held)
  return pickRunnerGpu(capacity.filter((card) => (used.get(card.id) ?? 0) === 0), used)
}

/**
 * The card a new run takes at the runs per card its lease pins: the least
 * loaded one with room (competitions/gpu-math.ts · pickRunnerGpu over
 * cardsInUse, the rule home uses for its own cards); `null` — every card is
 * full, and the lease is declined (`card`).
 */
export function pickCard(cards: readonly ProbedCard[], perDevice: number, runs: readonly CardRun[], held: Readonly<Record<string, number>> = {}): string | null {
  const capacity = cards.map((card) => ({ id: card.device, capacity: remoteCount(perDevice, 1, REMOTE_PER_DEVICE_MAX) }))
  return pickRunnerGpu(capacity, cardsInUse(capacity, runs, held))
}

/** What a card probe found: the cards, the driver, and a problem when it failed for a reason other than "no cards". */
export interface CardProbe {
  cards: ProbedCard[]
  driver: string | null
  problem: string | null
}

/**
 * Docker's word for a machine that has no NVIDIA runtime at all: `--gpus`
 * cannot be served. That is a CPU machine, not a problem to report.
 */
const NO_GPU_RUNTIME = /could not select device driver|unknown or invalid runtime name: nvidia|no known GPU vendor found/i

const DRIVER = /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/

/**
 * The machine's cards, from one throwaway container given every card
 * (kernel/card-probe.ts · cardsInContainer, the probe home uses), started
 * from `image` — the agent's own image (COLLOQ_RUNNER_IMAGE): `--gpus all`
 * puts nvidia-smi into any container, and that image is on the machine for
 * certain, where a CUDA image would be a pull of gigabytes to count the cards.
 * Named by index, the way `--gpus device=` and the runs' `colloq.gpu` label
 * name them. The driver comes from a second question to the same image.
 */
export async function probeCards(docker: Docker, image: string | null): Promise<CardProbe> {
  if (!image) return { cards: [], driver: null, problem: null }
  // What docker said to the probe, kept for the reason when it failed.
  const seen: { last: DockerResult } = { last: { code: -1, out: '' } }
  const read: DockerRead = async (args, timeoutMs) => (seen.last = await docker(args, { timeoutMs }))
  const rows: CardRow[] | null = await cardsInContainer(read, image)
  if (rows === null) {
    return { cards: [], driver: null, problem: NO_GPU_RUNTIME.test(seen.last.out) ? null : `the card probe failed: ${dockerWords(seen.last)}` }
  }
  const cards = rows.map((row) => ({ device: row.index, name: row.name || null, memoryMb: row.memoryMb }))
  if (cards.length === 0) return { cards, driver: null, problem: null }
  const asked = await docker([
    'run', '--rm', '--pull=never', '--network', 'none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--gpus', 'all', '--entrypoint', 'nvidia-smi', image, '--query-gpu=driver_version', '--format=csv,noheader',
  ], { timeoutMs: 30_000 })
  const driver = asked.code === 0 ? asked.out.split('\n').map((line) => line.trim()).find((line) => DRIVER.test(line)) ?? null : null
  return { cards, driver, problem: null }
}

/** The major number of a driver version, `580.65.06` → 580; null — unknown. */
export function driverMajor(driver: string | null): number | null {
  const major = Number(/^(\d+)/.exec(driver ?? '')?.[1])
  return Number.isSafeInteger(major) ? major : null
}

/* ----------------------------------------------------------------- facts */

/** What `docker info` says that the facts need, and where the daemon keeps its images (DockerRootDir, a path on the host). */
interface DockerInfo {
  version: string
  storage: string
  hostname: string
  platform: string
  cpus: number | null
  memoryMb: number | null
  rootDir: string | null
}

/** Docker's architecture as the kernels are published for it (`linux/amd64`): uname's words to Go's. */
const ARCHITECTURES: Readonly<Record<string, string>> = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' }

/**
 * The daemon's own words about the machine: its version, its storage driver
 * (overlay2 for the classic store, overlayfs for containerd's), the HOST's
 * name (inside the agent's container the hostname is the container's id), and
 * the platform. `null` — the daemon did not answer, which is a `docker`
 * problem.
 */
export async function dockerInfo(docker: Docker): Promise<{ info: DockerInfo | null; problem: string | null }> {
  const asked = await docker(['info', '--format', '{{json .}}'], { timeoutMs: 20_000, maxBytes: 4 * MB })
  if (asked.code !== 0) return { info: null, problem: `docker does not answer: ${dockerWords(asked)}` }
  try {
    const value = JSON.parse(asked.out.split('\n').find((line) => line.trim().startsWith('{')) ?? '') as Record<string, unknown>
    const text = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string) : '')
    const architecture = ARCHITECTURES[text('Architecture')] ?? text('Architecture').toLowerCase().replace(/[^a-z0-9_]/g, '')
    return {
      info: {
        version: text('ServerVersion'),
        storage: text('Driver'),
        hostname: text('Name'),
        platform: `${(text('OSType') || 'linux').toLowerCase()}/${architecture || 'amd64'}`,
        cpus: Number.isSafeInteger(value.NCPU) ? (value.NCPU as number) : null,
        memoryMb: Number.isFinite(value.MemTotal) ? Math.floor((value.MemTotal as number) / MB) : null,
        rootDir: path.isAbsolute(text('DockerRootDir')) ? path.normalize(text('DockerRootDir')) : null,
      },
      problem: null,
    }
  } catch {
    return { info: null, problem: 'docker info answered something that is not JSON' }
  }
}

/* ------------------------------------------------------- Docker's disk */

/** A filesystem's room, in MB. */
export interface DiskSpace {
  freeMb: number
  totalMb: number
}

/**
 * The room on Docker's own store (DockerRootDir), where pulls land and what
 * evicting a revision frees, when it is a filesystem other than the tree's:
 * `same` — it is the tree's (whose statfs, readMachine, says it all); `null` —
 * it could not be measured (a daemon in a VM of its own, as on a Mac; no
 * image to measure with), which no pull is refused for.
 *
 * Inside the agent's container the store is not mounted, and its path is the
 * host's: a throwaway container of the agent's own image (`image`, on the
 * machine for certain) is given the store and the tree, read-only, and stat
 * says which filesystem each is on and how much of the store's is free —
 * two filesystems with one id are one. Outside a container (make runner-dev,
 * no container of its own) both are this process's to ask, by their device.
 */
export async function measureDockerDisk(input: {
  docker: Docker
  rootDir: string | null
  tree: string
  image: string | null
  /** Whether the agent runs in a container of its own (COLLOQ_RUNNER_CONTAINER). */
  contained: boolean
  /** The check container's labels (images.ts · CHECK_LABELS): swept like the smoke test should a life end mid-measure. */
  labels: readonly string[]
}): Promise<DiskSpace | 'same' | null> {
  const { rootDir, tree } = input
  if (!rootDir) return null
  if (!input.contained) {
    try {
      if (fs.statSync(rootDir).dev === fs.statSync(tree).dev) return 'same'
      const stat = fs.statfsSync(rootDir)
      return { freeMb: Math.floor((Number(stat.bavail) * Number(stat.bsize)) / MB), totalMb: Math.floor((Number(stat.blocks) * Number(stat.bsize)) / MB) }
    } catch {
      return null
    }
  }
  if (!input.image) return null
  const asked = await input.docker([
    'run', '--rm', '--pull=never', '--network', 'none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--user=1000:1000',
    ...input.labels, '-v', `${rootDir}:/docker-root:ro`, '-v', `${tree}:/tree:ro`,
    '--entrypoint', 'stat', input.image, '-f', '-c', '%i %S %a %b', '/docker-root', '/tree',
  ], { timeoutMs: 30_000 })
  if (asked.code !== 0) return null
  const rows = asked.out.split('\n').map((line) => /^([0-9a-f]+) (\d+) (\d+) (\d+)$/.exec(line.trim())).filter((row): row is RegExpExecArray => row !== null)
  if (rows.length !== 2) return null
  const [store, own] = rows as [RegExpExecArray, RegExpExecArray]
  if (store[1] === own[1]) return 'same'
  const block = Number(store[2])
  return { freeMb: Math.floor((Number(store[3]) * block) / MB), totalMb: Math.floor((Number(store[4]) * block) / MB) }
}

/**
 * The facts a sync carries, cut to what the contract takes (remoteText for
 * the shown texts, the version, platform and driver in their patterns, or the
 * fact is left as unknown as the contract allows).
 */
export function machineFacts(input: { version: string; info: DockerInfo | null; picture: MachinePicture; driver: string | null }): RemoteFacts {
  const { info, picture } = input
  const label = (text: string | undefined, max: number, fallback: string): string => remoteText((text ?? '').trim(), max, 'start') || fallback
  const platform = info && /^linux\/[a-z0-9_]{1,16}$/.test(info.platform) ? info.platform : `linux/${ARCHITECTURES[os.arch()] ?? 'amd64'}`
  return {
    version: input.version,
    hostname: label(info?.hostname || os.hostname(), REMOTE_HOSTNAME_CHARS, 'unknown'),
    platform,
    cpus: remoteCount(info?.cpus ?? picture.cpus, 1, REMOTE_CPUS_MAX),
    memoryMb: remoteCount(picture.memTotalMb ?? info?.memoryMb ?? 1, 1, REMOTE_MEMORY_MB_MAX),
    diskMb: remoteCount(picture.diskTotalMb ?? 0, 0, REMOTE_DISK_MB_MAX),
    docker: label(info?.version, REMOTE_LABEL_CHARS, 'unknown'),
    storage: label(info?.storage, REMOTE_LABEL_CHARS, 'unknown'),
    driver: input.driver !== null && DRIVER.test(input.driver) ? input.driver : null,
  }
}
