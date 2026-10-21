/**
 * The class kernels a machine runs for its home («занятия на машинах»,
 * docs/architecture/remote-classes.md §7): one container per slot of a
 * class, started with home's own argv behind home's own perimeter, kept
 * across the agent's own restarts, measured, and said in every sync.
 *
 * LEVEL-TRIGGERED, AS THE LEASES ARE. Every reply that carries the `kernels`
 * block names the whole set of placements home wants here, each a slot at a
 * generation (RemotePlacementIntent): a key the machine does not hold is
 * started, one it holds at another gen is replaced, one no longer named is
 * removed, and a live one whose memory or CPUs changed is resized (`docker
 * update`). Every sync after such a reply says where each placement is
 * (pulling, starting, ready, failed, stopping), with the echoes home checks
 * before it opens a listener for one: the container's id and the digest of
 * the revision it was started from (shared/remote-kernels.ts ·
 * remoteRevisionDigest, never docker's image id). A reply lost on the way is
 * a delay and nothing else.
 *
 * WHAT IT HOLDS IS WRITTEN DOWN BEFORE IT RUNS. A placement's record
 * (state.ts · writePlacement) is on the disk before `docker run`, and again
 * with the container's id once docker said it. A machine that reboots, or an
 * agent that is updated or killed, comes back to its class kernels running
 * and adopts them (§7.3, `adopt`): the class keeps its variables. A class
 * container no record names, or one of another gen, is removed; a record
 * whose container is gone is dropped, and home's next intent starts it anew;
 * a record this build cannot read (an older or newer shape) keeps its
 * container, not ready, until home names its slot again. An exited container
 * of the very same placement, spec and hardening is started again (`docker
 * start`), as home starts its stopped rooms (pool.ts): a fresh Python, and
 * the packages a student installed into the container kept.
 *
 * THE SANDBOX IS HOME'S, BY CONSTRUCTION. The argv is room-spec.ts ·
 * machineRoomRunArgs, the rules perimeter-core.ts's, home's network mode the
 * floor (D21), the bridge, chains and names this agent's own
 * (machinePerimeter). The perimeter fails closed: nothing starts without it,
 * it is installed again every minute while class containers live, and three
 * failures in a row stop every one of them (§7.6). An admission canary — a
 * throwaway container with the class's hardening behind the same rules —
 * checks the sandbox from the inside before anything starts, and its word is
 * what home reads to make the machine eligible.
 *
 * NEVER A SUBMISSION'S, AND ONE LEDGER WITH THEM. Class containers carry a
 * kind of their own (`colloq.kind=class-kernel`), so neither the Docker
 * runner's sweep nor the agent's (sync.ts · sweep) ever touches them; their
 * memory and CPUs join what the machine holds (`holding`), and a GPU room's
 * whole card is held as a run at one per card (`cardRuns`, `wholeCards`), so
 * that `free` stays one truth for submissions and classes (§6.4, §6.5).
 *
 * WHEN HOME FALLS SILENT. A class container whose home has said nothing of
 * its classes (no reply with the block, no tunnel) for a class's idle time,
 * and whose kernels are idle in the census, is stopped by the agent itself
 * (the orphan rule): a home rolled back to a release without classes would
 * otherwise leave it running for ever.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import {
  PERIMETER_FAILURES_MAX,
  PERIMETER_RECHECK_MS,
  REMOTE_PLACEMENTS_MAX,
  REMOTE_READINGS_MAX,
  REMOTE_READING_LINES_MAX,
  REMOTE_READING_LINE_CHARS,
  REMOTE_SESSION_ID,
  parseRemotePlacementKey,
  remotePlacementKey,
  remoteRevisionDigest,
  type PostmortemReading,
  type RemoteClassFacts,
  type RemoteKernelRole,
  type RemoteKernelsReply,
  type RemotePerimeterState,
  type RemotePlacementHeld,
  type RemotePlacementIntent,
  type RemotePlacementPhase,
  type RemotePlacementUsage,
} from '@shared/remote-kernels'
import { REMOTE_CARD_MB_MAX, REMOTE_CPUS_MAX, REMOTE_MEMORY_MB_MAX, REMOTE_REASON_CHARS, remoteCount, remoteText } from '@shared/remote-runner'
import type { RuntimeResizeResult, RuntimeStartFailure, RuntimeUnschedulable } from '@shared/runtime'
import { CLASS_KERNEL_LABEL, MACHINE_ROOM_FLAGS, machineRoomContainer, machineRoomRunArgs, memSpec, slotOfPlacementLabel } from '../kernel/room-spec.js'
import {
  blockedCidrsSetting,
  helperArgs,
  ipv4Subnets,
  machinePerimeter,
  machinePerimeterPlan,
  networkCreateArgs,
  parseCidr,
  perimeterScript,
  profileFor,
  roomHardeningArgs,
  roomNetworkMode,
  type MachinePerimeter,
  type PerimeterPolicy,
} from '../kernel/perimeter-core.js'
import { parseCgroup, parseReading, readingArgs } from '../kernel/postmortem-core.js'
import { dockerMissing, dockerWords, type Docker, type DockerResult } from './docker.js'
import { CHECK_LABELS, INSTANCE_LABEL, revisionImage } from './images.js'
import { pickWholeCard, type CardRun, type ProbedCard } from './machine.js'
import { ensureRoomFolder } from './room-files.js'
import { dropPlacement, readPlacements, unreadPlacements, writePlacement, type StateLayout, type StoredPlacement } from './state.js'

/* ----------------------------------------------------------------- numbers */

/** How the host keeps time: the defaults, which tests shorten or drive by hand. */
export interface KernelTimings {
  /** A started container's Jupyter must answer an authenticated /api/status within this (§7.2). */
  readyMs: number
  readyPollMs: number
  /** The census (§7.4): one batched stats and one inspect, this often, while class containers live. */
  censusMs: number
  /** Each container's cgroup counters and a GPU room's card memory: an exec, at most this often. */
  countersMs: number
  /** The perimeter installed again while class containers live (§7.6), and tried again this often while it is not in place. */
  recheckMs: number
  /** The orphan rule: home silent this long (D25, roomIdleMin's default), and the container idle this long in the census. */
  orphanMs: number
  orphanQuietMs: number
  /** A start that failed is tried again after this while home still wants it, doubling up to `last`. */
  retryMs: { first: number; last: number }
  /** A canary that failed is run again after this (its word goes to home meanwhile). */
  canaryRetryMs: number
}

export const KERNEL_TIMINGS: Readonly<KernelTimings> = Object.freeze({
  readyMs: 90_000,
  readyPollMs: 500,
  censusMs: 10_000,
  countersMs: 60_000,
  recheckMs: PERIMETER_RECHECK_MS,
  orphanMs: 120 * 60_000,
  orphanQuietMs: 5 * 60_000,
  retryMs: Object.freeze({ first: 10_000, last: 5 * 60_000 }),
  canaryRetryMs: 10 * 60_000,
})

/** Below this CPU share a container's kernels count as idle in the census (the orphan rule): a cell computing never is. */
const IDLE_CPU_PERCENT = 5

/**
 * The machine's class bridge's subnet when KERNEL_ROOM_SUBNET does not say:
 * next to home's (perimeter-core.ts · DEFAULT_ROOM_SUBNET, 10.213.0.0/22),
 * outside docker's pools, so a home on the same daemon (refused, D20) and
 * the machine's classes never share a range. Taken by someone's LAN or VPN,
 * docker picks one from its pool, as home's does.
 */
export const MACHINE_ROOM_SUBNET = '10.214.0.0/22'

/**
 * What a class folder's copy may grow to before the class's limit stops it
 * (sessionLimitBytes, 1024 MB by default): the room a start keeps above the
 * disk's floor for it, less what a warm copy already holds there (§7.2: the
 * floor with the room folder's size included).
 */
const ROOM_FOLDER_MB = 1024

/** How often one key is read for home's post-mortem at most: home asks in every reply until a reading comes. */
const READING_EVERY_MS = 5_000

/**
 * How long a reading taken at a death the census found answers home's
 * question about it: home asks within seconds of a death it saw. A later
 * question is about something else, and reads the container as it is.
 */
const READING_KEEP_MS = 2 * 60_000

/** How many times a removal of every class container asks docker to remove them, and lists them again to see (clearClasses). */
const CLEAR_ROUNDS = 3

/**
 * How long a life that adopted class containers waits for its facts before
 * its first sync (adopt): a few docker calls, the helper and the canary,
 * seconds on a daemon that answers. A slower one lets the sync go first: a
 * silence home could take for a dead machine costs a class more than facts
 * said late.
 */
const FACTS_AT_ADOPTION_MS = 5_000

/** The kernel image's own address, a sign of a perimeter image id from docker. */
const IMAGE_ID = /^(?:sha256:)?[a-f0-9]{64}$/

/** What the canary prints, in one line, before the JSON of its checks. */
const CANARY_PREFIX = 'colloq-canary: '

/** The checks the canary reports (§7.6), each true when the sandbox held. */
export const CANARY_CHECKS = [
  'uid', 'capEff', 'noNewPrivs', 'noDockerSocket', 'noAgentFiles',
  'metadataRefused', 'hostRefused', 'lanRefused', 'ipv6Refused', 'loopbackRefused',
  'folderRead', 'folderWritten',
] as const

/* ------------------------------------------------------------------ shapes */

/** What the host asks of the agent's images (images.ts · Images). */
export interface KernelImages {
  /** The revision's tag once its layers were checked once more; null — not ready here. */
  verify(revision: { id: string; layers: string }, signal?: AbortSignal): Promise<string | null>
  isReady(id: string): boolean
  problemWith(id: string): string | null
  readyIds(): string[]
}

export interface KernelHostOptions {
  layout: StateLayout
  docker: Docker
  images: KernelImages
  /** COLLOQ_RUNNER_CONTAINER: the agent's own container (its network mode, and its image for the perimeter's helper); null — none (make runner-dev). */
  container: string | null
  /** COLLOQ_RUNNER_IMAGE: the helper's image when the agent has no container of its own. */
  image: string | null
  /** The machine's own COLLOQ_ROOM_NETWORK, KERNEL_BLOCKED_CIDRS and KERNEL_ROOM_SUBNET: stricter than home's floor or more, never less. */
  env?: NodeJS.ProcessEnv
  /** The agent's INSTANCE_LABEL (images.ts); a test may name its own. */
  instanceLabel?: string
  /** The cards as the probe found them. */
  cards: () => readonly ProbedCard[]
  /** Every share in use on them: the runs', the smoke tests', and the whole cards of the class rooms (this host's `cardRuns` among them). */
  cardRuns: () => readonly CardRun[]
  /** Containers the Docker runner still waits to remove, by card. */
  heldGpus: () => Readonly<Record<string, number>>
  /** The free disk of the tree's filesystem, where the class folders are; null — unknown. */
  diskFreeMb: () => number | null
  diskFloorMb: number
  /** Below the floor: the agent's eviction is asked for (sync.ts · keepDiskFloor). */
  onDiskLow?: () => void
  /** The hidden test is here (a trusted machine, or a run of it held): no class container starts beside it (D3). */
  sealed?: () => boolean
  /** When home last said anything about its classes: a reply that carried the block, or the tunnel up (the orphan rule). */
  heardAt: () => number
  /** Something a sync reports changed; `urgent` — a phase or a fact: the held sync is cut short for it. */
  onChange: (urgent: boolean) => void
  log: (line: string) => void
  now?: () => number
  /** A wait that `signal` cuts short: the ready probe's polls. Tests advance a clock of their own instead. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Jupyter's answer to an authenticated `GET /api/status` on the host's loopback: true for a 200. Tests may hand their own. */
  probe?: (port: number, token: string, signal: AbortSignal) => Promise<boolean>
  fetch?: typeof fetch
  timings?: Partial<KernelTimings>
}

/** The class containers held, by slot, for the status. */
export interface ClassCounts {
  room: number
  own: number
  council: number
}

/** A placement as the host holds it: the record's facts, and what only this life knows. */
interface Placement {
  readonly key: string
  readonly sessionId: string
  readonly role: RemoteKernelRole
  readonly gen: number
  /** What home wants of it: the latest intent at its gen (an adopted one's from its record until home says). */
  intent: RemotePlacementIntent
  /**
   * The intent its container was made from, as its record keeps it: the
   * revision the ready echo names (remoteRevisionDigest of its ref), whatever
   * a later intent of the gen says; null — no container made yet.
   */
  made: RemotePlacementIntent | null
  phase: RemotePlacementPhase
  /** The container's full id, once docker said it. */
  container: string | null
  /**
   * Whether its container runs, as far as the host knows: an adopted one that
   * exited, or one the census found dead, is started again. A failed start
   * leaves it as docker last said: a container taken as it ran still runs,
   * and holds what it holds (`holding`).
   */
  running: boolean
  /** Held from its record, before docker's list said what runs of it (adopt, relist). */
  unmatched: boolean
  /** Its Jupyter on the host's loopback (`docker port`), while ready. */
  port: number | null
  /** The whole card a GPU room holds, from the start that picked it until its record goes. */
  card: string | null
  /** What docker holds the container to. */
  limits: { memoryMb: number; cpus: number }
  /** The spec its container was made with (specDigest); null — none made yet. */
  spec: string | null
  failure: (RuntimeStartFailure & { detail?: string }) | null
  resized: RuntimeResizeResult['outcome'] | null
  /** The limits (`memoryMb:cpus`) the outcome in `resized` is for: said only while home asks for those. */
  resizedFor: string | null
  /** Limits docker refused (`pending`): not asked again until they change, or until the container is started again. */
  refusedResize: string | null
  usage: RemotePlacementUsage | null
  cardUsedMb: number | null
  /** The last census that saw it busy, or could not tell: the orphan rule stops only what has been idle since. */
  busyAt: number
  /** When an exec last read its cgroup counters (the census): at most every `countersMs`. */
  countersAt: number
  /** What its container said when the census last found it dead, and when: home's question about that death, asked soon after. */
  lastReading: { reading: PostmortemReading; at: number } | null
  /** A failed start is tried again from then, while home still asks for it. */
  retryAt: number
  retryMs: number
  /** A removal docker refused is tried again from then: a start's backoff never holds one up. */
  removeAt: number
  /** The start, removal or resize under way; a start's own abort, which a removal arriving meanwhile pulls. */
  task: Promise<void> | null
  abort: AbortController | null
}

type Fence = { ok: true } | { ok: false; detail: string }

/* ------------------------------------------------------------- pure parts */

/** The network mode a placement's container runs in: home's floor, or the machine's own when it is stricter (D21). */
export function strictestMode(home: 'blocked' | 'none', machine: 'blocked' | 'none'): 'blocked' | 'none' {
  return home === 'none' || machine === 'none' ? 'none' : 'blocked'
}

/**
 * What only a new container changes, as one digest: the image, the process
 * ceiling, the card, the network mode (`--dns`) and the hardening profile it
 * names (`colloq.profile`), the flags the machine adds to home's argv, the
 * token, the hash seed, the shared memory, the pool's size. Memory and CPUs
 * are not in it (`docker update` changes them live), nor the blocked ranges
 * (the rules follow the bridge, not the container). An exited container is
 * started again only for the same digest — one made by a build with other
 * hardening is made anew, as home recreates a stopped room of another
 * profile (pool.ts) — and a live one runs on with whatever it was made with,
 * as home's rooms do (no live container is recreated from under a class).
 */
export function specDigest(intent: RemotePlacementIntent, mode: 'blocked' | 'none'): string {
  const { environment, revision, pids, gpu, token, hashSeed, shm } = intent
  return createHash('sha256').update(JSON.stringify([
    environment, revision.id, revision.ref, revision.layers, pids, gpu, mode, profileFor(mode), MACHINE_ROOM_FLAGS, token, hashSeed, shm, intent.workers ?? null,
  ])).digest('hex')
}

/** The port `docker port <c> 8888/tcp` publishes Jupyter on, on the host's loopback and nowhere else; null — none. */
export function parsePort(out: string): number | null {
  for (const line of out.split('\n')) {
    const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(line.trim())
    const port = match ? Number(match[1]) : NaN
    if (port > 0 && port < 65536) return port
  }
  return null
}

/** Whether `docker inspect … {{.HostConfig.NetworkMode}}` of the agent's own container says the host's network (D19). */
export function hostNetworkOf(out: string): boolean {
  return out.trim().split('\n')[0]?.trim() === 'host'
}

/**
 * Why a `docker run` of a class container failed, in the broker's words
 * (RuntimeStartFailure): a card docker could not give, CPUs past what the
 * machine has, memory, or anything else, with docker's own line as the detail.
 */
export function startFailureOf(result: DockerResult, intent: Pick<RemotePlacementIntent, 'memoryMb' | 'cpus'>): RuntimeStartFailure & { detail: string } {
  const text = result.out
  const unschedulable: RuntimeUnschedulable = /could not select device driver|nvidia|\[\[gpu\]\]|--gpus/i.test(text)
    ? 'gpu'
    : /range of cpus|nanocpus|cpus? available|cpu quota|cpuset/i.test(text)
      ? 'cpu'
      : /memory|cannot allocate|\boom\b/i.test(text)
        ? 'memory'
        : 'other'
  return {
    unschedulable,
    ...(unschedulable === 'memory' ? { memoryMb: intent.memoryMb } : {}),
    ...(unschedulable === 'cpu' ? { cpus: intent.cpus } : {}),
    detail: remoteText(`docker run: ${dockerWords(result)}`, REMOTE_REASON_CHARS, 'start'),
  }
}

/**
 * The canary's verdict from what its container printed: `ok` when every
 * check of CANARY_CHECKS held, otherwise `failed:` and the checks that did
 * not (or what went wrong instead), at most a reason's length.
 */
export function parseCanary(out: string): string {
  const line = out.split('\n').map((entry) => entry.trim()).find((entry) => entry.startsWith(CANARY_PREFIX))
  let report: Record<string, unknown> | null = null
  try {
    const value: unknown = line ? JSON.parse(line.slice(CANARY_PREFIX.length)) : null
    if (value && typeof value === 'object' && !Array.isArray(value)) report = value as Record<string, unknown>
  } catch { /* said nothing readable */ }
  if (report === null) return remoteText(`failed: the canary said nothing readable (${out.split('\n').filter((entry) => entry.trim()).slice(-1)[0]?.trim() || 'no output'})`, REMOTE_REASON_CHARS, 'start')
  const failed = CANARY_CHECKS.filter((check) => report![check] !== true)
  return failed.length === 0 ? 'ok' : remoteText(`failed: ${failed.join(', ')}`, REMOTE_REASON_CHARS, 'start')
}

/**
 * The canary itself (§7.6, adapted from ops/runtime-smoke.ts): run as the
 * class kernels are, behind the same rules, it says from the inside that it
 * is no root and holds no capability, sees no docker socket and no file of
 * the agent's, reaches neither the cloud's metadata, nor the host (the agent
 * listens on every address of it for the length of the check), nor another
 * class's loopback port, nor any IPv6 address, and that its folder takes a
 * file both ways.
 */
export function canaryScript(input: { seed: string; ports: readonly [number, number]; lan: readonly string[]; state: string }): string {
  return [
    'import json, os, socket',
    `seed = ${JSON.stringify(input.seed)}`,
    `wide, narrow = ${JSON.stringify(input.ports[0])}, ${JSON.stringify(input.ports[1])}`,
    `lan = ${JSON.stringify(input.lan)}`,
    'status = {}',
    'try:',
    '    with open("/proc/self/status") as f:',
    '        for line in f:',
    '            key, _, value = line.partition(":")',
    '            status[key] = value.strip()',
    'except OSError:',
    '    pass',
    'def refused(host, port, family=socket.AF_INET):',
    '    try:',
    '        with socket.socket(family, socket.SOCK_STREAM) as c:',
    '            c.settimeout(1.0)',
    '            c.connect((host, port))',
    '        return False',
    '    except OSError:',
    '        return True',
    'def gateway():',
    '    try:',
    '        with open("/proc/net/route") as f:',
    '            for line in f.readlines()[1:]:',
    '                parts = line.split()',
    '                if len(parts) > 2 and parts[1] == "00000000":',
    '                    return socket.inet_ntoa(int(parts[2], 16).to_bytes(4, "little"))',
    '    except (OSError, ValueError):',
    '        pass',
    '    return None',
    'def v6_off():',
    '    try:',
    '        with open("/proc/sys/net/ipv6/conf/all/disable_ipv6") as f:',
    '            off = f.read().strip() == "1"',
    '    except OSError:',
    '        off = True',
    '    return off and refused("2001:4860:4860::8888", 53, socket.AF_INET6)',
    'gw = gateway()',
    'r = {}',
    'r["uid"] = os.getuid() != 0 and os.geteuid() != 0',
    'r["capEff"] = int(status.get("CapEff") or "f", 16) == 0',
    'r["noNewPrivs"] = status.get("NoNewPrivs") == "1"',
    'r["noDockerSocket"] = not any(os.path.lexists(p) for p in ["/var/run/docker.sock", "/run/docker.sock", "/run/containerd/containerd.sock", "/var/run/containerd/containerd.sock"])',
    `r["noAgentFiles"] = not any(os.path.lexists(p) for p in [${JSON.stringify(input.state)}, "/var/lib/colloq-runner"])`,
    'r["metadataRefused"] = refused("169.254.169.254", 80)',
    'r["hostRefused"] = gw is not None and refused(gw, wide)',
    'r["lanRefused"] = all(refused(a, wide) for a in lan)',
    'r["loopbackRefused"] = refused("127.0.0.1", narrow) and (gw is None or refused(gw, narrow))',
    'r["ipv6Refused"] = v6_off()',
    'try:',
    '    with open("/workspace/canary/seed") as f:',
    '        r["folderRead"] = f.read() == seed',
    'except OSError:',
    '    r["folderRead"] = False',
    'try:',
    '    with open("/workspace/canary/canary", "w") as f:',
    '        f.write(seed)',
    '    r["folderWritten"] = True',
    'except OSError:',
    '    r["folderWritten"] = False',
    `print(${JSON.stringify(CANARY_PREFIX)} + json.dumps(r), flush=True)`,
  ].join('\n')
}

/** "101.2MiB" or "1.5GB" in megabytes, as `docker stats` prints them (kernel/usage.ts · parseDockerSize, which this bundle may not load). */
function dockerSizeMb(text: string): number | null {
  const match = /^\s*([\d.]+)\s*([kKmMgGtT]?)(i?)B\s*$/.exec(text)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const unit = match[2]!.toLowerCase()
  const base = match[3] === 'i' ? 1024 : 1000
  const power = unit === 'k' ? 1 : unit === 'm' ? 2 : unit === 'g' ? 3 : unit === 't' ? 4 : 0
  return (value * base ** power) / 1024 ** 2
}

/** One container of the census, as one batched inspect said it. */
interface CensusState {
  status: string
  startedAt: number | null
  memoryMb: number | null
  cpus: number | null
}

const CENSUS_INSPECT = '{{.Name}}\t{{.State.Status}}\t{{.State.StartedAt}}\t{{.HostConfig.Memory}}\t{{.HostConfig.NanoCpus}}'
const CENSUS_STATS = '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'

function censusStates(out: string): Map<string, CensusState> {
  const found = new Map<string, CensusState>()
  for (const line of out.split('\n')) {
    const [rawName, status, started, bytes, nano] = line.split('\t')
    const name = (rawName ?? '').trim().replace(/^\//, '')
    if (!name || status === undefined) continue
    const at = Date.parse((started ?? '').trim())
    const memory = Number(bytes)
    const cores = Number(nano)
    found.set(name, {
      status: status.trim(),
      // Docker writes the zero time for a container that never started.
      startedAt: Number.isFinite(at) && at > 0 ? at : null,
      memoryMb: Number.isFinite(memory) && memory > 0 ? Math.floor(memory / 1024 ** 2) : null,
      cpus: Number.isFinite(cores) && cores > 0 ? cores / 1e9 : null,
    })
  }
  return found
}

function censusUsage(out: string): Map<string, { usedMb: number | null; cpuPercent: number | null }> {
  const found = new Map<string, { usedMb: number | null; cpuPercent: number | null }>()
  for (const line of out.split('\n')) {
    const [rawName, usage, cpu] = line.split('\t')
    const name = (rawName ?? '').trim()
    if (!name) continue
    const used = dockerSizeMb((usage ?? '').split('/')[0] ?? '')
    const percent = Number((cpu ?? '').trim().replace(/%$/, ''))
    found.set(name, { usedMb: used === null ? null : Math.round(used), cpuPercent: Number.isFinite(percent) ? percent : null })
  }
  return found
}

/** The names docker said it does not know, in an answer about several. */
function namesMissing(out: string): Set<string> {
  const missing = new Set<string>()
  for (const match of out.matchAll(/No such (?:object|container): (\S+)/g)) missing.add(match[1]!.replace(/^\//, ''))
  return missing
}

/** A reading as the contract carries it (shared/remote-kernels.ts · readingsOf): whole numbers, a status word, three cut lines. */
function wireReading(reading: PostmortemReading): PostmortemReading {
  const measured = (n: number | null): number | null => (n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null)
  const status = reading.status.toLowerCase()
  return {
    limit: measured(reading.limit),
    peak: measured(reading.peak),
    current: measured(reading.current),
    kills: measured(reading.kills),
    containerOomKilled: reading.containerOomKilled === true,
    status: /^[a-z]{0,16}$/.test(status) ? status : '',
    exit: reading.exit !== null && Number.isSafeInteger(reading.exit) && reading.exit >= 0 && reading.exit <= 255 ? reading.exit : null,
    tail: reading.tail.slice(-REMOTE_READING_LINES_MAX).map((line) => remoteText(line, REMOTE_READING_LINE_CHARS, 'end')),
  }
}

/** The bytes of a folder's files, walking at most `max` entries, never following a link. */
function folderBytes(dir: string, max = 5000): number {
  let bytes = 0
  let seen = 0
  const stack = [dir]
  while (stack.length > 0 && seen < max) {
    const at = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(at, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++seen > max) break
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try {
          bytes += fs.lstatSync(full).size
        } catch { /* gone meanwhile */ }
      }
    }
  }
  return bytes
}

/**
 * A tree of the agent's own removed as far as it will go, and the entries
 * that stayed, counted. Every folder in it is given back to its owner first:
 * a class kernel runs as the agent's own uid (1000) and may take a folder's
 * bits away (`chmod 000`), which stops a plain recursive removal at that
 * folder. A link is removed, never followed; one entry that will not go is
 * no stop for the rest.
 */
function removeTree(root: string): number {
  let stayed = 0
  const stack: Array<{ at: string; open: boolean }> = [{ at: root, open: false }]
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    if (top.open) {
      // Its entries are done: the folder itself.
      stack.pop()
      try {
        fs.rmdirSync(top.at)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stayed++
      }
      continue
    }
    top.open = true
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(top.at)
    } catch {
      stack.pop()
      continue
    }
    if (!stat.isDirectory()) {
      stack.pop()
      try {
        fs.unlinkSync(top.at)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stayed++
      }
      continue
    }
    try {
      fs.chmodSync(top.at, 0o700)
    } catch { /* the walk says what it could not read */ }
    let names: string[]
    try {
      names = fs.readdirSync(top.at)
    } catch {
      stack.pop()
      stayed++
      continue
    }
    for (const name of names) stack.push({ at: path.join(top.at, name), open: false })
  }
  return stayed
}

/** A wait that ends early when the signal aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    signal?.addEventListener('abort', done, { once: true })
  })
}

/* ------------------------------------------------------------------- host */

export class KernelHost {
  private readonly options: KernelHostOptions
  private readonly docker: Docker
  private readonly layout: StateLayout
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly timings: KernelTimings
  private readonly instanceLabel: string
  private readonly scope: MachinePerimeter
  private readonly placements = new Map<string, Placement>()
  /** The last reply's wanted set; empty until one says, and after the perimeter failed closed or a removal of everything. */
  private wanted = new Map<string, RemotePlacementIntent>()
  /** Post-mortem readings to say, by key, until a sync that carried them is answered. */
  private readonly readings = new Map<string, { key: string; gen: number; reading: PostmortemReading }>()
  private readonly readingAsked = new Map<string, number>()
  /** Home has spoken of classes in this life: a placement it does not name is removed. */
  private activated = false
  /** The facts are found out and the canary run: home has spoken of classes, or this life adopted class containers. */
  private factsOn = false
  /**
   * Every class container is being removed (removeAll), until a reply under
   * a new identity speaks of classes: nothing starts meanwhile, and no beat
   * runs, so that nothing is made after docker's list the removal goes by.
   */
  private removing = false
  /** Docker did not list the class containers at the start: a beat asks again (relist). */
  private unlisted = false
  /**
   * Containers whose record this build cannot read (state.ts ·
   * unreadPlacements), by key: kept as they run, not ready, until home names
   * their slot at their gen again (a start then takes them up as they run)
   * or does not (they go), or the orphan rule.
   */
  private readonly unread = new Map<string, { id: string; gen: number; limits: { memoryMb: number; cpus: number } | null }>()
  private closed = false
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private factsBusy = false
  /** What runs beside the slots' own tasks (the facts, the readings), for `idle`. */
  private readonly pending = new Set<Promise<unknown>>()
  /* The facts (RemoteClassFacts), as last found. */
  private hostNetwork: boolean | null = null
  private sameDaemon: boolean | null = null
  private sameDaemonAt = 0
  private perimeter: RemotePerimeterState = 'refused'
  private perimeterDetail = 'not installed yet'
  private mode: 'blocked' | 'none'
  private canary = 'pending'
  private canaryAt = 0
  private canaryRun: Promise<string> | null = null
  /** The perimeter as last installed: its plan's key and when, for the minute's memory a burst of starts shares. */
  private fence: { key: string; at: number } | null = null
  private installing: { key: string; done: Promise<Fence> } | null = null
  /** When the perimeter was last tried, and how many tries in a row failed while class containers lived. */
  private checkedAt = 0
  private failures = 0
  private helper: string | null = null

  constructor(options: KernelHostOptions) {
    this.options = options
    this.docker = options.docker
    this.layout = options.layout
    this.now = options.now ?? Date.now
    this.log = options.log
    this.timings = { ...KERNEL_TIMINGS, ...options.timings }
    this.instanceLabel = options.instanceLabel ?? INSTANCE_LABEL
    this.scope = machinePerimeter(this.instanceLabel)
    const own = this.machinePolicy()
    this.mode = typeof own !== 'string' && own.mode === 'none' ? 'none' : 'blocked'
  }

  /* ----------------------------------------------------------- the agent's */

  /**
   * At the agent's start, before its first sync (§7.3): the records an
   * earlier life wrote, held as written down, then matched to the class
   * containers of this tree that docker lists (relist). A docker that does
   * not answer keeps every record as a placement not seen running, and the
   * next beat asks it again; meanwhile a start (`start`) finds a container
   * still running by its name and label, and takes it as it is. A life that
   * adopts class containers is a class machine's: its facts are found out
   * now, not once home has spoken (an update under a live class must not say
   * the machine off the host's network with its perimeter refused).
   */
  async adopt(): Promise<void> {
    const records = readPlacements(this.layout)
    for (const record of records) this.placements.set(record.intent.key, this.fromRecord(record))
    this.unlisted = true
    await this.relist()
    if (this.unlisted && records.length > 0) this.log(`[runner] docker did not list the class containers; ${records.length} placement(s) are held as written down until it does`)
    if (this.placements.size + this.unread.size > 0 || records.length > 0) {
      this.factsOn = true
      this.ensureTicking()
      // Before the first sync, so that its block says them: a daemon slower than this lets the sync go first, never holds it.
      const found = new AbortController()
      await Promise.race([this.aside(this.refreshFacts()), pause(FACTS_AT_ADOPTION_MS, found.signal)])
      found.abort()
    }
  }

  /**
   * Docker's list of this tree's class containers, matched to what was
   * written down (adopt; a beat while docker did not list). A record's
   * container is held again as it is, running or not (a running one with the
   * port it has now); a record whose container is gone is dropped (home's next
   * intent starts the slot anew); a record this build cannot read keeps its
   * container, not ready, until home says (`unread`); a class container no
   * record names, or one of another gen, goes. A placement of this life (made
   * or taken up since) is its own operations' to decide, never this list's.
   */
  private async relist(): Promise<void> {
    const listed = await this.listed()
    if (listed === null || this.closed || this.removing) return
    this.unlisted = false
    const unreadable = new Map(unreadPlacements(this.layout).map((entry) => [entry.key, entry]))
    const matched = new Set<string>()
    const strays: string[] = []
    for (const found of listed) {
      const slot = slotOfPlacementLabel(found.placement)
      const key = slot ? remotePlacementKey(slot.sessionId, slot.role) : null
      const placement = key ? this.placements.get(key) : undefined
      if (placement && (!placement.unmatched || placement.task)) continue
      if (slot && key && placement && placement.gen === slot.gen && (placement.container === null || placement.container === found.id) && !matched.has(key)) {
        matched.add(key)
        const written = placement.container
        placement.container = found.id
        if (found.state === 'running') {
          const port = await this.portOf(found.id)
          if (port !== null && !placement.task) {
            placement.running = true
            placement.port = port
            placement.phase = 'ready'
          }
        }
        if (written === null) this.record(placement)
        continue
      }
      const unread = key ? unreadable.get(key) : undefined
      if (slot && key && !placement && unread && (unread.gen === null || unread.gen === slot.gen) && !this.unread.has(key)) {
        this.unread.set(key, { id: found.id, gen: slot.gen, limits: unread.limits })
        this.log(`[runner] the record of class ${key} gen ${slot.gen} is not one this build reads: its container is kept, not ready, until home names it again`)
        continue
      }
      strays.push(found.id)
    }
    let adopted = 0
    for (const placement of [...this.placements.values()]) {
      if (!placement.unmatched || placement.task) continue
      placement.unmatched = false
      if (matched.has(placement.key)) adopted++
      else this.forget(placement)
    }
    for (const key of unreadable.keys()) if (!this.unread.has(key)) dropPlacement(this.layout, key)
    if (strays.length > 0) await this.docker(['rm', '-f', ...strays], { timeoutMs: 60_000 })
    if (adopted + this.unread.size + strays.length > 0) this.log(`[runner] after a restart: ${adopted + this.unread.size} class container(s) adopted, ${strays.length} of no placement removed`)
    if (adopted + this.unread.size + strays.length > 0) this.options.onChange(true)
  }

  /**
   * A reply's block: the whole wanted set, reconciled key by key (see the
   * header), and the post-mortem questions it asks. The first in a life finds
   * the machine's facts out and runs the canary.
   */
  reconcile(kernels: RemoteKernelsReply): void {
    if (this.closed) return
    // A reply that speaks of classes after a removal of everything is a new identity's: the host works again.
    this.removing = false
    if (!this.activated) {
      this.activated = true
      this.factsOn = true
      this.ensureTicking()
      this.aside(this.refreshFacts())
    }
    this.wanted = new Map(kernels.placements.map((intent) => [intent.key, intent]))
    for (const [key, kept] of [...this.unread]) {
      // Named at its gen, a start takes its container up as it runs (`start`); otherwise it goes.
      this.unread.delete(key)
      if (this.wanted.get(key)?.gen === kept.gen && this.perimeter !== 'failing') continue
      this.aside(this.dropUnread(key, kept, 'home no longer names it'))
    }
    for (const key of new Set([...this.placements.keys(), ...this.wanted.keys()])) this.drive(key)
    for (const key of kernels.postmortem) this.askReading(key)
  }

  /** The images changed (a revision ready, a pull failed): the placements waiting on one look again. */
  imagesChanged(): void {
    for (const placement of this.placements.values()) if (!placement.task && placement.phase !== 'ready') this.drive(placement.key)
  }

  /** Every placement held, as a sync carries it (RemotePlacementHeld); a container of a record this build cannot read, as starting. */
  held(): RemotePlacementHeld[] {
    const held = [...this.placements.values()].map((placement) => {
      const entry: RemotePlacementHeld = { key: placement.key, gen: placement.gen, phase: placement.phase }
      if (placement.container && placement.phase !== 'pulling') entry.container = placement.container
      if (placement.phase === 'ready') entry.revision = remoteRevisionDigest((placement.made ?? placement.intent).revision.ref)
      if (placement.phase === 'failed') entry.failure = placement.failure ?? { unschedulable: 'other' }
      if (placement.usage && placement.phase !== 'pulling') entry.usage = placement.usage
      if (placement.card !== null && placement.role === 'room') entry.card = { device: placement.card, usedMb: placement.cardUsedMb }
      // An outcome is said only for the limits home asks for now: one for the last numbers is no word on new ones.
      if (placement.resized && placement.resizedFor === `${placement.intent.memoryMb}:${placement.intent.cpus}`) entry.resized = placement.resized
      return entry
    })
    const kept = [...this.unread].map(([key, entry]): RemotePlacementHeld => ({ key, gen: entry.gen, phase: 'starting', container: entry.id }))
    return [...held, ...kept].slice(0, REMOTE_PLACEMENTS_MAX)
  }

  /** The post-mortem readings to say: each until a sync that carried it is answered (`readingsSaid`). */
  readingsNow(): Array<{ key: string; gen: number; reading: PostmortemReading }> {
    return [...this.readings.values()].slice(0, REMOTE_READINGS_MAX)
  }

  readingsSaid(said: ReadonlyArray<{ key: string; gen: number; reading: PostmortemReading }>): void {
    for (const entry of said) if (this.readings.get(entry.key) === entry) this.readings.delete(entry.key)
  }

  /**
   * What makes the machine eligible for classes (§6.3), as last found. What
   * is not known yet is said the way that keeps classes off: no host network,
   * and a home on this docker (start refuses on the same rule). `mode` is the
   * machine's own floor (its COLLOQ_ROOM_NETWORK), not the last plan's: every
   * intent carries home's mode, and the stricter of the two is what runs.
   */
  facts(): RemoteClassFacts {
    const own = this.machinePolicy()
    return {
      hostNetwork: this.hostNetwork === true,
      perimeter: this.perimeter,
      mode: typeof own !== 'string' && own.mode === 'none' ? 'none' : 'blocked',
      canary: remoteText(this.canary, REMOTE_REASON_CHARS, 'start') || 'pending',
      sameDaemon: this.sameDaemon !== false,
    }
  }

  /**
   * What the class containers hold of the machine (§6.4): from their
   * acceptance until their container is gone. A failed one holds nothing,
   * unless its container still runs (taken as it ran by a start that then
   * failed): what runs holds its memory, whatever its start said.
   */
  holding(): Array<{ memoryMb: number; cpus: number }> {
    const placements = [...this.placements.values()].filter((placement) => placement.phase !== 'failed' || placement.running).map((placement) => ({ ...placement.limits }))
    return [...placements, ...[...this.unread.values()].flatMap((kept) => (kept.limits ? [{ ...kept.limits }] : []))]
  }

  /** The whole cards of the GPU rooms, as runs at one per card: nothing else fits beside one (machine.ts · cardsInUse). */
  cardRuns(): CardRun[] {
    return [...this.placements.values()].filter((placement) => placement.card !== null).map((placement) => ({ device: placement.card!, perDevice: 1 }))
  }

  wholeCards(): Set<string> {
    return new Set(this.cardRuns().map((run) => run.device))
  }

  /** The revisions the class containers run or are to run: never evicted from under them, and pulled whatever `want` says. */
  revisions(): Array<{ id: string; ref: string; layers: string; gpu: boolean }> {
    const found = new Map<string, { id: string; ref: string; layers: string; gpu: boolean }>()
    const held = [...this.placements.values()].flatMap((placement) => (placement.made ? [placement.made, placement.intent] : [placement.intent]))
    for (const intent of [...held, ...this.wanted.values()]) {
      const known = found.get(intent.revision.id)
      found.set(intent.revision.id, { ...intent.revision, gpu: (known?.gpu ?? false) || intent.gpu })
    }
    return [...found.values()]
  }

  /** Whether any class container is held: the hidden test never lies beside one (D3). */
  holdsAny(): boolean {
    return this.placements.size + this.unread.size > 0
  }

  /**
   * When a kernel of the class was last busy, as the census saw its CPU (or
   * could not tell), or became ready: the class folder's own scans run at the
   * busy pace for a minute after (room-files.ts, §8.3). 0 — none runs here.
   */
  busyAt(sessionId: string): number {
    let at = 0
    for (const placement of this.placements.values()) if (placement.sessionId === sessionId && placement.running) at = Math.max(at, placement.busyAt)
    return at
  }

  /** The gens of the class whose containers are held (a record this build cannot read included): a fenced copy waits for them to go. */
  heldGens(sessionId: string): Array<{ role: RemoteKernelRole; gen: number }> {
    const held = [...this.placements.values()].filter((placement) => placement.sessionId === sessionId).map((placement) => ({ role: placement.role, gen: placement.gen }))
    for (const [key, kept] of this.unread) {
      const slot = parseRemotePlacementKey(key)
      if (slot?.sessionId === sessionId) held.push({ role: slot.role, gen: kept.gen })
    }
    return held
  }

  counts(): ClassCounts {
    const counts: ClassCounts = { room: 0, own: 0, council: 0 }
    for (const placement of this.placements.values()) if (placement.phase !== 'failed' || placement.running) counts[placement.role]++
    for (const key of this.unread.keys()) {
      const role = key.slice(key.lastIndexOf(':') + 1) as RemoteKernelRole
      if (role in counts) counts[role]++
    }
    return counts
  }

  /**
   * The tunnel's question for a stream home opens (§4.6): the port of this
   * very placement's Jupyter on the host's loopback, from the agent's own
   * records, and nothing else. A gen below the one held is `stale`; one above
   * it, or one still on its way up, `starting`; anything else is `gone`.
   */
  resolve(key: string, gen: number): { port: number } | { refused: 'gone' | 'stale' | 'starting' } {
    const placement = this.placements.get(key)
    const kept = this.unread.get(key)
    if (!placement && kept) return { refused: gen < kept.gen ? 'stale' : 'starting' }
    if (!placement) return { refused: this.wanted.get(key)?.gen === gen ? 'starting' : 'gone' }
    if (gen < placement.gen) return { refused: 'stale' }
    if (gen > placement.gen) return { refused: 'starting' }
    if (placement.phase === 'ready' && placement.running && placement.port !== null) return { port: placement.port }
    return { refused: placement.phase === 'pulling' || placement.phase === 'starting' ? 'starting' : 'gone' }
  }

  /**
   * Every class container of this tree and every class folder, gone: the
   * owner revoked the machine, it left, or it now belongs to another home
   * (§7.3, §11.5). By docker's list as well as the records, so that nothing
   * an earlier life left behind stays, and checked by docker's list again:
   * the answer is how many class containers docker still lists (null — it
   * could not say), which the agent asks again until it is none (sync.ts ·
   * removeClasses). From its first line until a reply of a new identity
   * speaks of classes nothing starts and no beat runs, and every start under
   * way ends first, removing what it made (`abandon`): one still inside
   * `docker run` would otherwise make its container after the list was taken.
   */
  async removeAll(why: string): Promise<number | null> {
    this.removing = true
    this.wanted = new Map()
    for (const placement of this.placements.values()) placement.abort?.abort()
    await Promise.allSettled([...this.placements.values()].map((placement) => placement.task))
    const cleared = await this.clearClasses([...this.placements.values()].map((placement) => this.nameOf(placement)))
    this.placements.clear()
    this.unread.clear()
    this.readings.clear()
    let folders = 0
    let stayed = 0
    let names: string[] = []
    try {
      names = fs.readdirSync(this.layout.roomsDir)
    } catch { /* none */ }
    for (const name of names) {
      // One class folder at a time (its baseline and staging beside it): one that will not go is no reason to keep the others.
      const left = removeTree(path.join(this.layout.roomsDir, name))
      if (left === 0 && REMOTE_SESSION_ID.test(name)) folders++
      stayed += left
    }
    if (stayed === 0) stayed += removeTree(this.layout.roomsDir)
    stayed += removeTree(this.layout.placementsDir)
    const left = cleared.left === null ? null : cleared.left.length
    if (cleared.found + folders > 0 || left !== 0 || stayed > 0) {
      const containers = left === null ? `${cleared.found} class container(s) found, and docker does not say whether they are gone` : `${cleared.found - left} class container(s) removed${left > 0 ? `, ${left} still there` : ''}`
      this.log(`[runner] ${why}: ${containers}; ${folders} class folder(s) removed${stayed > 0 ? `, ${stayed} entr(ies) of them would not go` : ''}`)
    }
    this.options.onChange(true)
    return left
  }

  /**
   * Every class container of this tree removed, by docker's own list (by
   * `names` when it cannot list), then listed again, up to CLEAR_ROUNDS
   * times: how many the first list held, and the slot of each container
   * docker still lists (null — it could not say). What is gone is what docker
   * no longer lists, never what `rm -f` answered: a name already gone fails
   * it, and of several it refused it says which only in words.
   */
  private async clearClasses(names: string[]): Promise<{ found: number; left: string[] | null }> {
    let found = -1
    for (let round = 0; ; round++) {
      const listed = await this.listed()
      if (found < 0) found = listed?.length ?? names.length
      const keys = listed === null ? null : listed.map((entry) => {
        const slot = slotOfPlacementLabel(entry.placement)
        return slot ? remotePlacementKey(slot.sessionId, slot.role) : `?${entry.id}`
      })
      if ((keys !== null && keys.length === 0) || round >= CLEAR_ROUNDS) return { found, left: keys }
      const targets = listed === null ? names : listed.map((entry) => entry.id)
      if (targets.length > 0) await this.docker(['rm', '-f', ...targets], { timeoutMs: 120_000 })
    }
  }

  /**
   * Settled once nothing is under way: no start, removal or resize (one may
   * follow another: a removal, then the next gen's start), no finding out of
   * the facts, no reading for home.
   */
  async idle(): Promise<void> {
    for (;;) {
      const tasks = [...this.placements.values()].map((placement) => placement.task).filter((task): task is Promise<void> => task !== null)
      const busy = [...tasks, ...this.pending]
      if (busy.length === 0) return
      await Promise.allSettled(busy)
    }
  }

  /**
   * The agent stops: the timers go and the waits end, and nothing else. Class
   * containers run on through the agent's restart (§7.3): what is under way
   * is written down, and the next life adopts it.
   */
  stop(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /* ------------------------------------------------------- the periodic part */

  /**
   * One beat of the host's clock (every `censusMs`): the facts still unknown,
   * the census, the perimeter's minute, the orphan rule, and the placements
   * whose retry is due.
   */
  async tick(): Promise<void> {
    if (this.ticking || this.closed || this.removing) return
    this.ticking = true
    try {
      if (this.unlisted) await this.relist()
      if (this.factsOn) await this.refreshFacts()
      await this.census()
      if (this.live().length > 0 && this.now() - this.checkedAt >= this.timings.recheckMs) await this.recheckPerimeter()
      await this.orphans()
      for (const key of new Set([...this.placements.keys(), ...this.wanted.keys()])) this.drive(key)
    } catch (error) {
      this.log(`[runner] the class kernels' beat failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    } finally {
      this.ticking = false
    }
  }

  /**
   * The census (§7.4): one batched `docker inspect` and one `docker stats
   * --no-stream` for every live class container, the pair home's census uses
   * (kernel/usage.ts), and for each container an exec of the cgroup's counters
   * (and a GPU room's card) at most every `countersMs`. A container docker
   * says is not running, or does not know, is dead: read for home's
   * post-mortem, and started again while home wants it.
   */
  async census(): Promise<void> {
    const live = this.live()
    if (live.length === 0) return
    const names = live.map((placement) => this.nameOf(placement))
    const [inspected, stats] = await Promise.all([
      this.docker(['inspect', '--format', CENSUS_INSPECT, ...names], { timeoutMs: 15_000 }),
      this.docker(['stats', '--no-stream', '--format', CENSUS_STATS, ...names], { timeoutMs: 20_000 }),
    ])
    const states = censusStates(inspected.out)
    const missing = namesMissing(inspected.out)
    const usages = censusUsage(stats.out)
    const now = this.now()
    for (const placement of live) {
      if (placement.task) continue
      const name = this.nameOf(placement)
      const state = states.get(name)
      if (missing.has(name) || (state && state.status !== 'running')) {
        await this.died(placement, state?.status ?? 'gone')
        continue
      }
      if (!state) continue
      const used = usages.get(name)
      placement.usage = {
        usedMb: used?.usedMb === null || used?.usedMb === undefined ? null : remoteCount(used.usedMb, 0, REMOTE_MEMORY_MB_MAX),
        limitMb: remoteCount(state.memoryMb ?? placement.limits.memoryMb, 0, REMOTE_MEMORY_MB_MAX),
        cpus: remoteCount(Math.round(state.cpus ?? placement.limits.cpus), 0, REMOTE_CPUS_MAX),
        cpuPercent: used?.cpuPercent === null || used?.cpuPercent === undefined ? null : remoteCount(Math.round(used.cpuPercent), 0, 100 * REMOTE_CPUS_MAX),
        startedAt: remoteCount(state.startedAt ?? 0, 0, Number.MAX_SAFE_INTEGER),
        oomKills: placement.usage?.oomKills ?? 0,
      }
      if (used?.cpuPercent === null || used?.cpuPercent === undefined || used.cpuPercent > IDLE_CPU_PERCENT) placement.busyAt = now
    }
    for (const placement of live) {
      if (!placement.running || placement.task || now - placement.countersAt < this.timings.countersMs) continue
      placement.countersAt = now
      await this.readCounters(placement)
    }
  }

  /**
   * The perimeter's minute (§7.6): installed again while class containers
   * live, a missing rule put back by the same script. Three failures in a row
   * stop every class container, and the facts say `failing`: home moves the
   * classes and tells the owner.
   */
  async recheckPerimeter(): Promise<void> {
    const answer = await this.ensurePerimeter(true)
    if (answer.ok) {
      this.failures = 0
      return
    }
    this.failures++
    this.log(`[runner] the class perimeter did not hold (${this.failures} of ${PERIMETER_FAILURES_MAX}): ${answer.detail}`)
    if (this.failures >= PERIMETER_FAILURES_MAX) await this.failClosed(answer.detail)
  }

  /**
   * The orphan rule (§7.6): home silent about its classes for `orphanMs`
   * (no reply with the block, no tunnel), and a container whose kernels have
   * been idle in the census for `orphanQuietMs`, is stopped. A cell still
   * computing is let be; the next quiet census stops it. A placement whose
   * container does not run (exited, never started, a start that failed)
   * holds no variable, and goes as soon as home has been silent that long,
   * unless docker has not yet said whether it runs (unmatched); so does a
   * container of a record this build cannot read. Otherwise a home rolled
   * back to a release without classes would leave them holding the
   * machine's memory, and turning the hidden test away (D3), for ever.
   */
  async orphans(): Promise<void> {
    const silent = this.now() - this.options.heardAt()
    if (this.timings.orphanMs <= 0 || silent < this.timings.orphanMs) return
    const minutes = Math.round(silent / 60_000)
    for (const placement of [...this.placements.values()]) {
      if (placement.task) continue
      if (placement.running ? this.now() - placement.busyAt < this.timings.orphanQuietMs : placement.unmatched) continue
      this.wanted.delete(placement.key)
      this.log(`[runner] home has said nothing of its classes for ${minutes} min and ${placement.key}'s ${placement.running ? 'kernels are idle' : 'container does not run'}: it is removed`)
      this.run(placement, () => this.remove(placement))
    }
    for (const [key, kept] of [...this.unread]) {
      this.unread.delete(key)
      this.aside(this.dropUnread(key, kept, `home has said nothing of its classes for ${minutes} min`))
    }
  }

  /** A container of a record this build cannot read, removed with that record; one docker would not remove is kept for the next try. */
  private async dropUnread(key: string, kept: { id: string; gen: number; limits: { memoryMb: number; cpus: number } | null }, why: string): Promise<void> {
    const gone = await this.docker(['rm', '-f', kept.id], { timeoutMs: 60_000 })
    if (gone.code !== 0 && !dockerMissing(gone)) {
      if (!this.unread.has(key) && !this.placements.has(key)) this.unread.set(key, kept)
      this.log(`[runner] class ${key} gen ${kept.gen}: its container could not be removed (${dockerWords(gone)}); tried again`)
      return
    }
    dropPlacement(this.layout, key, kept.gen)
    this.log(`[runner] class ${key} gen ${kept.gen} removed: ${why}`)
    this.options.onChange(true)
  }

  /* ------------------------------------------------------------ the slots */

  /**
   * The next step for one key, from what is held and what home wants: one
   * operation at a time per key, the next decided when it ends. A removal
   * arriving during a start pulls the start's abort, and the start removes
   * what it made (pool.ts · abandoned does it so at home).
   */
  private drive(key: string): void {
    if (this.closed || this.removing) return
    const placement = this.placements.get(key)
    const want = this.wanted.get(key)
    if (placement?.task) {
      if (placement.abort && (!want || want.gen !== placement.gen)) placement.abort.abort()
      return
    }
    if (this.perimeter === 'failing') {
      // Failed closed (§7.6): nothing starts until the rules hold again, and what docker would not remove is removed again at every beat.
      if (placement && this.now() >= placement.removeAt) this.run(placement, () => this.remove(placement))
      return
    }
    if (!want) {
      // Nothing home said yet in this life is no "none": an adopted kernel waits for the first reply's block (or the orphan rule).
      if (placement && this.activated && this.now() >= placement.removeAt) this.run(placement, () => this.remove(placement))
      return
    }
    if (!placement) {
      const fresh = this.fresh(want)
      this.placements.set(key, fresh)
      this.ensureTicking()
      if (this.waiting(fresh)) return
      this.run(fresh, () => this.start(fresh))
      return
    }
    if (want.gen !== placement.gen) {
      if (this.now() >= placement.removeAt) this.run(placement, () => this.remove(placement))
      return
    }
    placement.intent = want
    // Not ready — not running, a start that failed (its container perhaps still running, taken as it ran), or a removal that failed
    // while home has since asked for it again: a start takes up what docker still runs of it.
    if (!placement.running || placement.phase !== 'ready') {
      if (this.now() < placement.retryAt || this.waiting(placement)) return
      this.run(placement, () => this.start(placement))
      return
    }
    const asked = `${want.memoryMb}:${want.cpus}`
    if (placement.phase === 'ready' && asked !== `${placement.limits.memoryMb}:${placement.limits.cpus}` && asked !== placement.refusedResize) {
      this.run(placement, () => this.resize(placement))
    }
  }

  private run(placement: Placement, work: () => Promise<void>): void {
    placement.task = work()
      .catch((error: unknown) => this.log(`[runner] class ${placement.key} gen ${placement.gen}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))
      .finally(() => {
        placement.task = null
        placement.abort = null
        this.drive(placement.key)
      })
  }

  /**
   * Whether a placement still waits for its revision (images.ts pulls and
   * checks it, never this): `pulling` meanwhile, or `failed` with the image's
   * own problem while the pull is retried. Nothing is started for it until
   * the revision is ready (`imagesChanged` looks again).
   */
  private waiting(placement: Placement): boolean {
    const { id } = placement.intent.revision
    if (this.options.images.isReady(id)) return false
    const problem = this.options.images.problemWith(id)
    const phase: RemotePlacementPhase = problem ? 'failed' : 'pulling'
    const failure = problem ? { unschedulable: 'other' as const, detail: remoteText(`the revision is not ready here: ${problem}`, REMOTE_REASON_CHARS, 'start') } : null
    if (placement.phase !== phase || placement.failure?.detail !== failure?.detail) {
      placement.phase = phase
      placement.failure = failure
      this.options.onChange(true)
    }
    return true
  }

  /**
   * A start, in the order of §7.2: the revision ready through the agent's
   * images; the disk's floor with room for the class folder; a GPU room's
   * whole card; the perimeter (the bridge first, then its rules) and the
   * canary behind it; the record; `docker run` (or `docker start` of the very
   * placement's exited container); its port; and Jupyter's answer, within
   * `readyMs`. A failure is said in the broker's words and tried again later.
   */
  private async start(placement: Placement): Promise<void> {
    const abort = new AbortController()
    placement.abort = abort
    const { signal } = abort
    const intent = placement.intent
    const name = this.nameOf(placement)
    let made = false
    const ended = (): boolean => this.closed || signal.aborted
    // Defence in depth for D3: home never places a class on a machine trusted with the hidden test, and this machine never starts one there.
    if (this.options.sealed?.()) return this.fail(placement, made, { unschedulable: 'other', detail: 'this machine holds the hidden test: no class kernel starts beside it (D3)' })
    const image = await this.options.images.verify(intent.revision, signal)
    if (ended()) return this.abandon(placement, made)
    if (image === null) {
      // The book said ready and the inspect did not: back to waiting, as the images were told (images.ts · verify);
      // a book that stays ready is another pin than the intent's, which no wait mends.
      if (this.waiting(placement)) return
      return this.fail(placement, made, { unschedulable: 'other', detail: `the revision ${intent.revision.id.slice(0, 12)} here is not the image home pinned` })
    }
    this.phase(placement, 'starting')

    const free = this.options.diskFreeMb()
    const folder = path.join(this.layout.roomsDir, placement.sessionId)
    const reserveMb = Math.max(0, ROOM_FOLDER_MB - Math.floor(folderBytes(folder) / (1024 * 1024)))
    if (free !== null && free - reserveMb < this.options.diskFloorMb) {
      this.options.onDiskLow?.()
      return this.fail(placement, made, { unschedulable: 'other', detail: `free disk ${free} MB leaves less than the ${this.options.diskFloorMb} MB floor beside the class folder's ${ROOM_FOLDER_MB} MB` })
    }
    if (intent.gpu && placement.role === 'room' && placement.card === null) {
      const card = pickWholeCard(this.options.cards(), this.options.cardRuns(), this.options.heldGpus())
      if (card === null) {
        return this.fail(placement, made, { unschedulable: 'gpu', detail: this.options.cards().length === 0 ? 'this machine has no card' : 'no card here is free of submissions and of other classes' })
      }
      placement.card = card
      this.options.onChange(true)
    }
    // What the facts say, asked now if no beat has yet: a home on this docker keeps its classes (D20), and an agent off the host's network reaches no kernel.
    if (this.hostNetwork === null) await this.detectHostNetwork()
    if (this.sameDaemon === null) await this.detectSameDaemon()
    if (ended()) return this.abandon(placement, made)
    if (this.sameDaemon !== false) {
      return this.fail(placement, made, { unschedulable: 'other', detail: this.sameDaemon ? 'a Colloq home runs on this Docker: its classes stay with it (D20)' : 'docker did not say whether a Colloq home runs on it' })
    }
    const fence = await this.ensurePerimeter()
    if (ended()) return this.abandon(placement, made)
    if (!fence.ok) return this.fail(placement, made, { unschedulable: 'other', detail: `the class perimeter is not in place: ${fence.detail}` })
    const canary = await this.ensureCanary(image)
    if (ended()) return this.abandon(placement, made)
    if (canary !== 'ok') return this.fail(placement, made, { unschedulable: 'other', detail: `the admission canary: ${canary}` })

    try {
      this.folder(placement.sessionId)
    } catch (error) {
      return this.fail(placement, made, { unschedulable: 'other', detail: `the class folder could not be made: ${error instanceof Error ? error.message : String(error)}` })
    }
    const mode = strictestMode(intent.network, this.mode)
    const spec = specDigest(intent, mode)

    // What has the placement's name now. A docker that cannot say is no answer: nothing is removed on a guess (a live kernel would be).
    const found = await this.byName(name)
    if (ended()) return this.abandon(placement, made)
    if (found === 'unknown') return this.fail(placement, made, { unschedulable: 'other', detail: `docker did not answer about ${name}` })
    // Docker has said what runs under its name: what this start does with it is no later list's to undo (relist).
    placement.unmatched = false
    const ours = found !== null && found.placement === `${placement.sessionId}:${placement.role}:${placement.gen}`
    let container: string | null = null
    if (ours && found.status === 'running') {
      // Running all along (a census that misread it, an adoption docker did not answer, a record this build could not read): taken
      // as it is, its Python with it, and never removed by this start, whatever it meets. It holds what it holds from here on, and
      // what docker says of it next is the census's to judge.
      container = found.id
      placement.running = true
    } else if (ours && placement.spec === spec && found.profile === profileFor(mode)) {
      // This very placement's container, exited, made with this hardening: started again as home starts a stopped room, the
      // packages installed in it kept. One of another profile is made anew, as home's pool does: a `docker start` would bring a
      // kernel back with the rights of a build since mended.
      const started = await this.docker(['start', found.id], { timeoutMs: 120_000 })
      if (started.code === 0) {
        container = found.id
        made = true
        // Limits docker refused were refused for what the old Python used: the fresh one is asked again once it is ready (drive).
        placement.refusedResize = null
      }
    }
    if (container !== null) {
      placement.container = container
      placement.made ??= intent
      if (!this.record(placement, image)) return this.fail(placement, made, { unschedulable: 'other', detail: 'the placement could not be written down: the disk refused it' })
    } else {
      if (found !== null) {
        const gone = await this.docker(['rm', '-f', name], { timeoutMs: 60_000 })
        if (gone.code !== 0 && !dockerMissing(gone)) return this.fail(placement, made, { unschedulable: 'other', detail: `the old container ${name} could not be removed: ${dockerWords(gone)}` })
      }
      placement.container = null
      placement.made = intent
      placement.spec = spec
      placement.limits = { memoryMb: intent.memoryMb, cpus: intent.cpus }
      placement.refusedResize = null
      placement.resized = null
      placement.resizedFor = null
      // Written down before docker runs anything: a life that ends between the two finds the container by its label.
      if (!this.record(placement, image)) return this.fail(placement, made, { unschedulable: 'other', detail: 'the placement could not be written down: the disk refused it' })
      let argv: string[]
      try {
        argv = machineRoomRunArgs({
          role: placement.role,
          sessionId: placement.sessionId,
          environment: intent.environment,
          image,
          mount: path.join(this.layout.roomsDir, placement.sessionId),
          extraMounts: [],
          gpu: placement.role === 'room' ? placement.card : null,
          memoryMb: intent.memoryMb,
          cpus: intent.cpus,
          pids: intent.pids,
          mode,
          profile: profileFor(mode),
          token: intent.token,
          hashSeed: intent.hashSeed,
          shm: intent.shm,
        }, { instanceLabel: this.instanceLabel, gen: placement.gen })
      } catch (error) {
        return this.fail(placement, true, { unschedulable: 'other', detail: `the container's argv: ${error instanceof Error ? error.message : String(error)}` })
      }
      const ran = await this.docker(argv, { timeoutMs: 120_000 })
      made = true
      const id = ran.out.split('\n').map((line) => line.trim()).reverse().find((line) => /^[a-f0-9]{64}$/.test(line)) ?? null
      if (ran.code !== 0 || id === null) return this.fail(placement, made, ran.code === 0 ? { unschedulable: 'other', detail: 'docker run named no container' } : startFailureOf(ran, intent))
      container = id
      placement.container = id
      this.record(placement, image)
    }
    if (ended()) return this.abandon(placement, made)

    const port = await this.portOf(container)
    if (port === null) return this.fail(placement, made, { unschedulable: 'other', detail: 'docker publishes no port of its Jupyter on 127.0.0.1' })
    const answer = await this.awaitReady(placement, port, signal)
    if (ended()) return this.abandon(placement, made)
    if (answer !== 'ready') {
      // Ended while starting, it runs no more; one that only did not answer in time still runs, and holds what it holds.
      if (answer === 'exited') placement.running = false
      const reading = await this.readingOf(name)
      const said = reading.tail[reading.tail.length - 1] ?? ''
      const detail = answer === 'exited'
        ? `the container ended while starting (${reading.status || 'gone'}${reading.exit !== null ? ` ${reading.exit}` : ''}${reading.containerOomKilled ? ', out of memory' : ''})${said ? `: ${said}` : ''}`
        : `Jupyter did not answer within ${Math.round(this.timings.readyMs / 1000)} s${said ? `: ${said}` : ''}`
      return this.fail(placement, made, { unschedulable: reading.containerOomKilled ? 'memory' : 'other', ...(reading.containerOomKilled ? { memoryMb: intent.memoryMb } : {}), detail })
    }
    placement.port = port
    placement.running = true
    placement.failure = null
    placement.retryMs = 0
    placement.retryAt = 0
    placement.busyAt = this.now()
    placement.countersAt = 0
    this.phase(placement, 'ready')
    this.log(`[runner] class ${placement.key} gen ${placement.gen} is ready (${image}${placement.card !== null ? `, card ${placement.card}` : ''})`)
  }

  /** A start home no longer wants (a removal, another gen) ends here: what it made goes, its record and its card with it. */
  private async abandon(placement: Placement, made: boolean): Promise<void> {
    // The agent stopping is no removal: what is under way stays written down, and the next life adopts or removes it. Unless
    // everything is being removed (a revocation, a leave, a perimeter that failed closed): then what it made goes, stop or not.
    if (this.closed && !this.removing && this.perimeter !== 'failing') return
    placement.phase = 'stopping'
    this.options.onChange(true)
    if (made || placement.container) {
      const gone = await this.docker(['rm', '-f', this.nameOf(placement)], { timeoutMs: 60_000 })
      if (gone.code !== 0 && !dockerMissing(gone)) {
        // Held, stopping, and removed again by the next beat (or found by the removal of everything, which lists by label).
        placement.removeAt = this.now() + this.timings.retryMs.first
        this.log(`[runner] class ${placement.key} gen ${placement.gen}: its start was given up, and its container could not be removed (${dockerWords(gone)}); tried again`)
        return
      }
    }
    this.forget(placement)
    this.log(`[runner] class ${placement.key} gen ${placement.gen}: its start was given up, home no longer asks for it`)
  }

  /**
   * A start that failed: said in the broker's words (`failed`), what it
   * made removed, and tried again after a wait that doubles, while home
   * still asks for it. A failure before any container leaves an exited one of
   * an earlier life as it is, for a later `docker start`.
   */
  private async fail(placement: Placement, made: boolean, failure: RuntimeStartFailure & { detail?: string }): Promise<void> {
    if (this.closed && !this.removing && this.perimeter !== 'failing') return
    if (made) {
      await this.docker(['rm', '-f', this.nameOf(placement)], { timeoutMs: 60_000 })
      dropPlacement(this.layout, placement.key, placement.gen)
      placement.container = null
      placement.made = null
      placement.spec = null
      placement.running = false
    }
    if (placement.container === null) placement.card = null
    // `running` stays as docker last said it: a container this start took as it ran, and did not make, still runs (holding).
    placement.port = null
    placement.failure = { ...failure, ...(failure.detail !== undefined ? { detail: remoteText(failure.detail, REMOTE_REASON_CHARS, 'start') } : {}) }
    placement.retryMs = placement.retryMs > 0 ? Math.min(this.timings.retryMs.last, placement.retryMs * 2) : this.timings.retryMs.first
    placement.retryAt = this.now() + placement.retryMs
    this.phase(placement, 'failed')
    this.log(`[runner] class ${placement.key} gen ${placement.gen} did not start (${failure.unschedulable}): ${failure.detail ?? ''}; tried again in ${Math.round(placement.retryMs / 1000)} s while home asks`)
  }

  /** A placement home no longer wants (or wants at another gen): its container goes, then its record, then the placement. */
  private async remove(placement: Placement): Promise<void> {
    this.phase(placement, 'stopping')
    const gone = await this.docker(['rm', '-f', this.nameOf(placement)], { timeoutMs: 60_000 })
    if (gone.code !== 0 && !dockerMissing(gone)) {
      placement.removeAt = this.now() + this.timings.retryMs.first
      this.log(`[runner] class ${placement.key} gen ${placement.gen}: its container could not be removed (${dockerWords(gone)}); tried again`)
      return
    }
    this.forget(placement)
    this.log(`[runner] class ${placement.key} gen ${placement.gen} removed`)
  }

  /** Its record (its own gen's, never a newer one's), its card and its readings go, and it is no longer held. */
  private forget(placement: Placement): void {
    dropPlacement(this.layout, placement.key, placement.gen)
    if (this.placements.get(placement.key) === placement) {
      this.placements.delete(placement.key)
      this.readings.delete(placement.key)
    }
    this.options.onChange(true)
  }

  /**
   * A live container's limits changed (§6.10): `docker update`, memory and
   * swap together as home's resize has them (pool.ts · applyMemoryLimit),
   * and the CPUs. `applied`; `absent` when the container is gone (started
   * again with the new numbers); `pending` when docker refused them (lower
   * than in use, say): not asked again until they change, or until the
   * container is started again (`start`), when they are asked of the fresh
   * Python. Each outcome is said for the numbers it answers (`resizedFor`).
   */
  private async resize(placement: Placement): Promise<void> {
    const { memoryMb, cpus } = placement.intent
    const memory = memSpec(memoryMb)
    const updated = await this.docker(['update', `--memory=${memory}`, `--memory-swap=${memory}`, `--cpus=${cpus}`, placement.container ?? this.nameOf(placement)], { timeoutMs: 30_000 })
    placement.resizedFor = `${memoryMb}:${cpus}`
    if (updated.code === 0) {
      placement.limits = { memoryMb, cpus }
      placement.resized = 'applied'
      this.record(placement)
    } else if (dockerMissing(updated)) {
      placement.resized = 'absent'
      placement.running = false
      placement.port = null
      this.phase(placement, 'starting')
    } else {
      placement.resized = 'pending'
      placement.refusedResize = `${memoryMb}:${cpus}`
      this.log(`[runner] class ${placement.key} gen ${placement.gen}: docker kept its limits (${dockerWords(updated)}); ${memoryMb} MB and ${cpus} CPU(s) apply at its next start`)
    }
    this.options.onChange(true)
  }

  /**
   * A live container found dead (by the census, or by home's question that
   * came first, `said`): read for home's post-mortem while it is still there,
   * then started again. The reading is kept for home's question about this
   * death, unless that question has had it already.
   */
  private async died(placement: Placement, status: string, said?: PostmortemReading): Promise<void> {
    if (!placement.running) return
    placement.running = false
    placement.port = null
    const reading = said ?? wireReading(await this.readingOf(this.nameOf(placement)))
    placement.lastReading = said ? null : { reading, at: this.now() }
    this.phase(placement, 'starting')
    this.log(`[runner] class ${placement.key} gen ${placement.gen}: its container is ${status}${reading.containerOomKilled ? ' (out of memory)' : ''}; it is started again while home asks for it`)
    this.drive(placement.key)
  }

  /**
   * A post-mortem question of home's for one key (§7.4), answered by a
   * reading in a sync soon. A question soon after the census found the
   * container dead gets what it said then: started again since, its cgroup
   * is a new one, and its kill counter and docker's OOM flag no longer
   * remember the death. Any other question reads the container as it is —
   * and a container that reads dead before the census saw it is that death,
   * said now and started again now, so that no reading of it is left over to
   * answer a later question about something else.
   */
  private askReading(key: string): void {
    const placement = this.placements.get(key)
    if (!placement || this.now() - (this.readingAsked.get(key) ?? 0) < READING_EVERY_MS) return
    this.readingAsked.set(key, this.now())
    this.aside((async () => {
      const kept = placement.lastReading
      placement.lastReading = null
      let reading = kept && this.now() - kept.at <= READING_KEEP_MS ? kept.reading : null
      if (reading === null && placement.container !== null) {
        reading = wireReading(await this.readingOf(this.nameOf(placement)))
        const current = this.placements.get(key) === placement && !placement.task
        if ((reading.status === 'exited' || reading.status === 'dead') && current) await this.died(placement, reading.status, reading)
      }
      // A container docker no longer knows says nothing worth saying.
      if (reading === null || (reading.status === '' && reading.tail.length === 0)) return
      this.readings.set(key, { key, gen: placement.gen, reading })
      this.options.onChange(true)
    })())
  }

  /** Home's own three questions of a dead kernel's container (postmortem-core.ts · readingArgs), through this machine's docker. */
  private async readingOf(container: string): Promise<PostmortemReading> {
    const ask = readingArgs(container)
    const [inspect, cgroup, logs] = await Promise.all([
      this.docker(ask.inspect, { timeoutMs: 10_000 }),
      this.docker(ask.cgroup, { timeoutMs: 10_000 }),
      this.docker(ask.logs, { timeoutMs: 10_000 }),
    ])
    return parseReading({ inspect, cgroup, logs })
  }

  /** A live container's cgroup kill counter and, for a GPU room, its card's memory in use: one exec (the census, `countersMs`). */
  private async readCounters(placement: Placement): Promise<void> {
    const ask = readingArgs(this.nameOf(placement)).cgroup
    const card = placement.card !== null ? '; printf "card %s\\n" "$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -n 1)"' : ''
    const answer = await this.docker([...ask.slice(0, -1), `${ask[ask.length - 1]}${card}`], { timeoutMs: 15_000 })
    const kills = parseCgroup(answer).kills
    if (placement.usage && kills !== null) placement.usage = { ...placement.usage, oomKills: remoteCount(kills, 0, Number.MAX_SAFE_INTEGER) }
    if (placement.card !== null) {
      const used = Number(/^card (\d+)\s*$/m.exec(answer.code === 0 ? answer.out : '')?.[1])
      placement.cardUsedMb = Number.isSafeInteger(used) ? remoteCount(used, 0, REMOTE_CARD_MB_MAX) : null
    }
  }

  /**
   * The container's Jupyter, asked until it answers an authenticated `GET
   * /api/status` or `readyMs` is up, and docker asked every few tries whether
   * the container still runs: one that ended while starting is said at once,
   * not after a minute and a half.
   */
  private async awaitReady(placement: Placement, port: number, signal: AbortSignal): Promise<'ready' | 'timeout' | 'exited' | 'aborted'> {
    const until = this.now() + this.timings.readyMs
    const probe = this.options.probe ?? ((at: number, token: string, cut: AbortSignal) => this.statusOk(at, token, cut))
    const sleep = this.options.sleep ?? pause
    for (let tries = 1; ; tries++) {
      if (signal.aborted || this.closed) return 'aborted'
      // The container's own token: the one it was made with (the same for its gen and machine, §6.9).
      if (await probe(port, (placement.made ?? placement.intent).token, signal).catch(() => false)) return 'ready'
      if (this.now() >= until) return 'timeout'
      if (tries % 4 === 0) {
        const found = await this.byName(this.nameOf(placement))
        if (found === null || (found !== 'unknown' && found.status !== 'running')) return 'exited'
      }
      await sleep(this.timings.readyPollMs, signal)
    }
  }

  private async statusOk(port: number, token: string, signal: AbortSignal): Promise<boolean> {
    const fetcher = this.options.fetch ?? globalThis.fetch.bind(globalThis)
    const response = await fetcher(`http://127.0.0.1:${port}/api/status`, {
      headers: { Authorization: `token ${token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
      redirect: 'manual',
    })
    await response.body?.cancel().catch(() => undefined)
    return response.status === 200
  }

  /* ------------------------------------------------------------ perimeter */

  /**
   * The perimeter in place for every class container here, or why not, by
   * home's own rule (perimeter.ts · ensureRoomPerimeter): the agent's bridge
   * (made when missing, its subnets read back from docker), the plan with
   * home's floor and the machine's own on top, and the helper run from the
   * agent's own image by its id. A success is remembered for a minute for the
   * same plan, so that a burst of starts runs one helper; `force` asks again.
   *
   * ONE HELPER AT A TIME. The rules in force are those of the install that
   * ended last: two plans installed side by side would leave the older one
   * in force when it ends second, and a class started on the newer one's
   * word (a range home blocks, `none`) behind rules that no longer hold it.
   * So a plan waits for the install under way, shares it when it is the
   * same plan, and is installed after it otherwise.
   */
  private async ensurePerimeter(force = false): Promise<Fence> {
    for (;;) {
      const policy = this.policies()
      const key = JSON.stringify(policy)
      if (!force && this.fence && this.fence.key === key && this.perimeter === 'ok' && this.now() - this.fence.at < this.timings.recheckMs) return { ok: true }
      const running = this.installing
      if (running) {
        const answer = await running.done
        if (running.key === key) return answer
        continue
      }
      const done = this.install(key, policy).finally(() => {
        if (this.installing?.done === done) this.installing = null
      })
      this.installing = { key, done }
      return done
    }
  }

  private async install(key: string, policy: { home: PerimeterPolicy; machine: PerimeterPolicy | string }): Promise<Fence> {
    this.checkedAt = this.now()
    const failed = (state: RemotePerimeterState, detail: string): Fence => {
      this.fence = null
      this.setPerimeter(state, detail)
      return { ok: false, detail }
    }
    if (typeof policy.machine === 'string') return failed('refused', policy.machine)
    const helper = await this.helperImage()
    if (helper === null) return failed('refused', 'no image of the agent\'s own to run the perimeter helper from (COLLOQ_RUNNER_CONTAINER or COLLOQ_RUNNER_IMAGE)')
    const bridge = await this.bridge()
    if ('error' in bridge) return failed('refused', bridge.error)
    let plan: ReturnType<typeof machinePerimeterPlan>
    try {
      plan = machinePerimeterPlan(bridge.subnets, policy.home, policy.machine)
    } catch (error) {
      return failed('refused', error instanceof Error ? error.message : String(error))
    }
    const ran = await this.docker(helperArgs(helper, perimeterScript(plan, this.scope)), { timeoutMs: 60_000 })
    if (ran.code === 0 && /colloq-perimeter: ok/.test(ran.out)) {
      this.fence = { key, at: this.now() }
      this.mode = plan.mode ?? 'blocked'
      // Whoever installed them (a start, the canary, the re-check), the rules hold: the failures in a row are none (§7.6).
      this.failures = 0
      this.setPerimeter('ok', '')
      return { ok: true }
    }
    const said = ran.out.split('\n').filter((line) => line.trim()).slice(-2).join(' · ') || `exit ${ran.code}`
    return failed(ran.code === 20 ? 'no-dockerd' : ran.code === 21 ? 'no-iptables' : 'refused', remoteText(said, REMOTE_REASON_CHARS, 'start'))
  }

  /**
   * Every class container stopped: the perimeter failed three times in a row
   * (§7.6). `failing` is said first, and from then on nothing starts (drive)
   * until the rules hold again. A container is gone when docker no longer
   * lists it: one docker would not remove (a wedged daemon, which may be why
   * the helper failed) stays held, stopping, said to home as such, and is
   * removed again at every beat — never forgotten while it runs behind rules
   * that do not hold.
   */
  private async failClosed(detail: string): Promise<void> {
    this.log(`[runner] the class perimeter failed ${this.failures} times in a row: every class container is stopped (${detail})`)
    this.setPerimeter('failing', detail)
    this.failures = 0
    this.wanted = new Map()
    for (const placement of this.placements.values()) placement.abort?.abort()
    await Promise.race([Promise.allSettled([...this.placements.values()].map((placement) => placement.task)), pause(30_000)])
    const cleared = await this.clearClasses([...this.placements.values()].map((placement) => this.nameOf(placement)))
    const left = cleared.left === null ? null : new Set(cleared.left)
    for (const placement of [...this.placements.values()]) {
      // A start still under way ends on its abort, and removes what it made itself (abandon).
      if (placement.task) continue
      if (left !== null && !left.has(placement.key)) {
        this.forget(placement)
        continue
      }
      placement.removeAt = 0
      this.phase(placement, 'stopping')
    }
    for (const [key, kept] of [...this.unread]) {
      if (left !== null && left.has(key)) continue
      this.unread.delete(key)
      dropPlacement(this.layout, key, kept.gen)
    }
    if (left === null || left.size > 0) this.log(`[runner] ${left === null ? 'docker does not say whether the class containers are gone' : `${left.size} class container(s) are still there`}: removed again at every beat`)
  }

  private setPerimeter(state: RemotePerimeterState, detail: string): void {
    // A perimeter that failed closed stays said so until it holds again: home moves the classes on that word.
    const next = this.perimeter === 'failing' && state !== 'ok' ? 'failing' : state
    if (next !== this.perimeter || detail !== this.perimeterDetail) {
      if (next !== this.perimeter) this.log(`[runner] class perimeter: ${next}${detail ? ` (${detail})` : ''}`)
      this.perimeter = next
      this.perimeterDetail = detail
      this.options.onChange(true)
    }
  }

  /** Home's floor, from every intent held or wanted (D21), and the machine's own policy — or why the machine's own cannot be read. */
  private policies(): { home: PerimeterPolicy; machine: PerimeterPolicy | string } {
    const intents = [...[...this.placements.values()].map((placement) => placement.intent), ...this.wanted.values()]
    const blocked = new Set<string>()
    for (const intent of intents) for (const range of intent.blockedCidrs) blocked.add(range)
    return {
      home: { mode: intents.some((intent) => intent.network === 'none') ? 'none' : 'blocked', blockedCidrs: [...blocked].sort() },
      machine: this.machinePolicy(),
    }
  }

  /** The machine's own COLLOQ_ROOM_NETWORK and KERNEL_BLOCKED_CIDRS: `open` is no mode for a class here (machinePerimeterPlan), a broken list a refusal. */
  private machinePolicy(): PerimeterPolicy | string {
    const env = this.options.env ?? process.env
    const { cidrs, invalid } = blockedCidrsSetting(env)
    if (invalid.length > 0) return `KERNEL_BLOCKED_CIDRS on this machine: not an IPv4 address or range: ${invalid.join(', ').slice(0, 200)}`
    return { mode: roomNetworkMode(env) === 'none' ? 'none' : 'blocked', blockedCidrs: cidrs }
  }

  /**
   * The image the privileged helper runs from: the agent's own, by its id
   * (§7.6) — built by CI, never editable from a panel, certainly here, and
   * with nsenter in it — read from its container, or from COLLOQ_RUNNER_IMAGE
   * without one. Never a kernel image: a teacher's package list must not run
   * as root on the host (perimeter.ts · helperImage says why).
   */
  private async helperImage(): Promise<string | null> {
    if (this.helper) return this.helper
    const asked = this.options.container !== null
      ? await this.docker(['inspect', '--type', 'container', '--format', '{{.Image}}', this.options.container], { timeoutMs: 15_000 })
      : this.options.image
        ? await this.docker(['image', 'inspect', '--format', '{{.Id}}', this.options.image], { timeoutMs: 15_000 })
        : null
    const id = asked && asked.code === 0 ? asked.out.trim().split('\n')[0]?.trim() ?? '' : ''
    this.helper = IMAGE_ID.test(id) ? id : null
    return this.helper
  }

  /** The agent's class bridge (`colloq-mrooms-<i6>`): made when missing, and its subnets as docker has them, never as asked. */
  private async bridge(): Promise<{ subnets: string[] } | { error: string }> {
    const network = this.scope.network
    const inspect = (): Promise<DockerResult> => this.docker(['network', 'inspect', network, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'], { timeoutMs: 15_000 })
    let found = await inspect()
    if (found.code !== 0) {
      if (!/no such network|not found/i.test(found.out)) return { error: `docker network inspect ${network}: ${dockerWords(found)}` }
      const { subnet, explicit } = this.subnetSetting()
      let made = await this.docker(networkCreateArgs(subnet, this.scope), { timeoutMs: 30_000 })
      // Taken by another network here and not named on purpose: docker picks one, and the rules follow the one it got.
      if (made.code !== 0 && !explicit && /overlap/i.test(made.out)) made = await this.docker(networkCreateArgs(null, this.scope), { timeoutMs: 30_000 })
      if (made.code !== 0 && !/already exists/i.test(made.out)) return { error: `docker network create ${network}: ${dockerWords(made)}` }
      if (made.code === 0) this.log(`[runner] created docker network ${network} for class kernels`)
      found = await inspect()
      if (found.code !== 0) return { error: `docker network inspect ${network}: ${dockerWords(found)}` }
    }
    const subnets = ipv4Subnets(found.out)
    return subnets.length > 0 ? { subnets } : { error: `network ${network} has no IPv4 subnet` }
  }

  /** KERNEL_ROOM_SUBNET as home reads it for its own rooms (perimeter-core.ts · roomSubnetSetting), with the machine's default. */
  private subnetSetting(): { subnet: string; explicit: boolean } {
    const raw = ((this.options.env ?? process.env).KERNEL_ROOM_SUBNET ?? '').trim()
    if (raw !== '' && parseCidr(raw) !== null) return { subnet: raw, explicit: true }
    return { subnet: MACHINE_ROOM_SUBNET, explicit: false }
  }

  /* --------------------------------------------------------------- facts */

  /** The facts still unknown, the perimeter not in place, and the canary not yet passed: each found out again while home asks for classes. */
  private async refreshFacts(): Promise<void> {
    if (this.factsBusy || this.closed) return
    this.factsBusy = true
    try {
      if (this.hostNetwork === null) await this.detectHostNetwork()
      if (this.sameDaemon === null || this.now() - this.sameDaemonAt >= 30 * 60_000) await this.detectSameDaemon()
      if (this.sameDaemon === true) {
        this.setCanary('not run: a Colloq home runs on this Docker (D20)')
        return
      }
      // While class containers live the re-check owns the perimeter, and counts its failures (recheckPerimeter): at once when this
      // life has not checked it yet (an agent restarted under a class finds its rules again before home reads them refused).
      if (this.live().length > 0) {
        if (this.checkedAt === 0) await this.recheckPerimeter()
      } else if (this.perimeter !== 'ok' && this.now() - this.checkedAt >= this.timings.recheckMs) await this.ensurePerimeter()
      const due = this.canaryAt === 0 || this.canary.startsWith('pending') || this.now() - this.canaryAt >= this.timings.canaryRetryMs
      if (this.canary !== 'ok' && due) await this.ensureCanary()
    } finally {
      this.factsBusy = false
    }
  }

  /**
   * The agent's own network (D19, §7.5): `--network host`, the only way it
   * reaches class kernels on the host's 127.0.0.1. With no container of its
   * own (make runner-dev) it is a process on the host, which is that network.
   */
  private async detectHostNetwork(): Promise<void> {
    if (this.options.container === null) {
      this.setHostNetwork(true)
      return
    }
    const asked = await this.docker(['inspect', '--type', 'container', '--format', '{{.HostConfig.NetworkMode}}', this.options.container], { timeoutMs: 15_000 })
    if (asked.code === 0) this.setHostNetwork(hostNetworkOf(asked.out))
  }

  private setHostNetwork(value: boolean): void {
    if (value === this.hostNetwork) return
    this.hostNetwork = value
    if (!value) this.log('[runner] this agent is not on the host\'s network: it takes no classes until it is restarted with --network host (the command from the panel)')
    this.options.onChange(true)
  }

  /**
   * Whether a Colloq home lives on this docker (D20): its server's container
   * (colloq-host labels it `colloq.kind=app`), its rooms, or its rooms'
   * network. A daemon that did not answer says nothing either way.
   */
  private async detectSameDaemon(): Promise<void> {
    const questions = [
      ['ps', '-aq', '--filter', 'label=colloq.kind=app'],
      ['ps', '-aq', '--filter', 'label=colloq.kind=room-kernel'],
      ['network', 'ls', '-q', '--filter', 'label=colloq.kind=room-network'],
    ]
    let found = false
    for (const question of questions) {
      const asked = await this.docker(question, { timeoutMs: 15_000 })
      if (asked.code !== 0) return
      found ||= asked.out.trim() !== ''
    }
    this.sameDaemonAt = this.now()
    if (found !== this.sameDaemon) {
      this.sameDaemon = found
      if (found) this.log('[runner] a Colloq home runs on this Docker: this machine takes no classes (D20)')
      this.options.onChange(true)
    }
  }

  private setCanary(verdict: string): void {
    if (verdict === this.canary) return
    this.canary = verdict
    this.log(`[runner] class admission canary: ${verdict}`)
    this.options.onChange(true)
  }

  /**
   * The admission canary's word (§7.6): `ok` for the rest of this life once it
   * passed; run now when it has not run, or its last failure is old enough;
   * the last word otherwise. `image` — a class image to run it from (a start's
   * own); else any revision ready here.
   */
  private async ensureCanary(image?: string): Promise<string> {
    if (this.canary === 'ok') return 'ok'
    if (this.canaryRun) return this.canaryRun
    const due = this.canaryAt === 0 || this.canary.startsWith('pending') || this.now() - this.canaryAt >= this.timings.canaryRetryMs
    if (!due) return this.canary
    const run = this.runCanary(image)
      .catch((error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`)
      .then((verdict) => {
        if (!verdict.startsWith('pending')) this.canaryAt = this.now()
        this.setCanary(remoteText(verdict, REMOTE_REASON_CHARS, 'start'))
        return this.canary
      })
      .finally(() => {
        this.canaryRun = null
      })
    this.canaryRun = run
    return run
  }

  private async runCanary(image?: string): Promise<string> {
    if (this.hostNetwork !== true) return this.hostNetwork === false ? 'not run: the agent is not on the host\'s network (--network host)' : 'pending: the agent\'s network is not known yet'
    const fence = await this.ensurePerimeter()
    if (!fence.ok) return `not run: the class perimeter is not in place (${fence.detail})`
    const ready = this.options.images.readyIds()[0]
    const use = image ?? (ready ? revisionImage(ready) : null)
    if (!use) return 'pending: no class image is ready here yet'
    const seed = randomBytes(16).toString('hex')
    const dir = path.join(this.layout.roomsDir, `.canary-${randomBytes(4).toString('hex')}`)
    let hits = 0
    const listen = (host: string): Promise<net.Server> => new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        hits++
        socket.destroy()
      })
      server.once('error', reject)
      server.listen(0, host, () => resolve(server))
    })
    const servers: net.Server[] = []
    try {
      // Each kept for the `finally` as soon as it listens: a second that fails must not leave the first open on the host's network.
      servers.push(await listen('0.0.0.0'))
      servers.push(await listen('127.0.0.1'))
      const ports = servers.map((server) => (server.address() as net.AddressInfo).port) as [number, number]
      // Made as a class folder is (`folder`): what the canary's uid 1000 reads and writes is what a kernel's would.
      fs.mkdirSync(this.layout.roomsDir, { recursive: true, mode: 0o700 })
      fs.mkdirSync(dir, { mode: 0o2775 })
      fs.chmodSync(dir, 0o2775)
      fs.writeFileSync(path.join(dir, 'seed'), seed)
      fs.chmodSync(path.join(dir, 'seed'), 0o664)
      if (process.getuid?.() === 0) for (const made of [dir, path.join(dir, 'seed')]) fs.chownSync(made, 1000, 1000)
      const lan = Object.values(os.networkInterfaces()).flatMap((list) => list ?? []).filter((info) => info.family === 'IPv4' && !info.internal).map((info) => info.address).slice(0, 16)
      const name = `colloq-runner-canary-${this.scope.i6}`
      await this.docker(['rm', '-f', name], { timeoutMs: 30_000 })
      const ran = await this.docker([
        'run', '--rm', '--name', name, ...CHECK_LABELS, '--network', this.scope.network,
        ...roomHardeningArgs({ pids: 64, mode: this.mode, profile: profileFor(this.mode) }),
        '-v', `${dir}:/workspace/canary`, '--memory=256m', '--memory-swap=256m', '--cpus=1', '--pull=never',
        '--entrypoint', 'python', use, '-I', '-c', canaryScript({ seed, ports, lan, state: this.layout.root }),
      ], { timeoutMs: 120_000 })
      let verdict = parseCanary(ran.out)
      const back = (() => {
        try {
          return fs.readFileSync(path.join(dir, 'canary'), 'utf8') === seed
        } catch {
          return false
        }
      })()
      const also = [...(back ? [] : ['folderRoundTrip']), ...(hits > 0 ? ['hostReached'] : [])]
      if (also.length > 0) verdict = verdict === 'ok' ? `failed: ${also.join(', ')}` : `${verdict}, ${also.join(', ')}`
      return verdict
    } finally {
      for (const server of servers) server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  /* ---------------------------------------------------------------- helpers */

  /** Work beside the slots' tasks, kept for `idle` until it ends; the promise of its end, which never rejects. */
  private aside(work: Promise<unknown>): Promise<unknown> {
    const kept = work.catch((error: unknown) => this.log(`[runner] the class kernels: ${error instanceof Error ? error.message : String(error)}`)).finally(() => this.pending.delete(kept))
    this.pending.add(kept)
    return kept
  }

  /** The live class containers: those the census asks about. */
  private live(): Placement[] {
    return [...this.placements.values()].filter((placement) => placement.running && placement.container !== null)
  }

  private ensureTicking(): void {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => void this.tick(), this.timings.censusMs)
    this.timer.unref?.()
  }

  private nameOf(placement: Placement): string {
    return machineRoomContainer(this.instanceLabel, placement.sessionId, placement.role)
  }

  private phase(placement: Placement, phase: RemotePlacementPhase): void {
    if (placement.phase === phase) return
    placement.phase = phase
    this.options.onChange(true)
  }

  private fresh(intent: RemotePlacementIntent): Placement {
    const [sessionId, role] = intent.key.split(':') as [string, RemoteKernelRole]
    return {
      key: intent.key,
      sessionId,
      role,
      gen: intent.gen,
      intent,
      made: null,
      phase: 'pulling',
      container: null,
      running: false,
      unmatched: false,
      port: null,
      card: null,
      limits: { memoryMb: intent.memoryMb, cpus: intent.cpus },
      spec: null,
      failure: null,
      resized: null,
      resizedFor: null,
      refusedResize: null,
      usage: null,
      cardUsedMb: null,
      busyAt: this.now(),
      countersAt: 0,
      lastReading: null,
      retryAt: 0,
      retryMs: 0,
      removeAt: 0,
      task: null,
      abort: null,
    }
  }

  private fromRecord(record: StoredPlacement): Placement {
    const placement = this.fresh(record.intent)
    placement.made = record.intent
    placement.unmatched = true
    placement.phase = 'starting'
    placement.container = record.container
    placement.card = record.card
    placement.limits = { ...record.limits }
    placement.spec = record.spec
    return placement
  }

  /** The record, as the placement is now; false — the disk would not take it (said in the log). */
  private record(placement: Placement, image = revisionImage((placement.made ?? placement.intent).revision.id)): boolean {
    try {
      writePlacement(this.layout, {
        intent: placement.made ?? placement.intent,
        container: placement.container,
        image,
        spec: placement.spec ?? specDigest(placement.made ?? placement.intent, strictestMode((placement.made ?? placement.intent).network, this.mode)),
        limits: { ...placement.limits },
        card: placement.card,
      })
      return true
    } catch (error) {
      this.log(`[runner] the record of class ${placement.key} could not be written down: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** The class folder's copy (§8.1), by the one rule its files are written by (room-files.ts): made empty when missing, its files come with their pushes. */
  private folder(sessionId: string): string {
    return ensureRoomFolder(this.layout, sessionId)
  }

  /** The class containers of this tree, as docker lists them; null — it did not answer. */
  private async listed(): Promise<Array<{ id: string; state: string; placement: string }> | null> {
    const found = await this.docker(['ps', '-a', '--no-trunc', '--filter', `label=${CLASS_KERNEL_LABEL}`, '--filter', `label=${this.instanceLabel}`, '--format', '{{.ID}}\t{{.State}}\t{{.Label "colloq.placement"}}'], { timeoutMs: 20_000 })
    if (found.code !== 0) return null
    return found.out.split('\n').map((line) => line.trim().split('\t')).filter(([id]) => id !== undefined && /^[a-f0-9]{64}$/.test(id)).map(([id, state = '', placement = '']) => ({ id: id!, state: state.trim(), placement: placement.trim() }))
  }

  /**
   * The container that has the placement's name now: its id, its state, its
   * placement label and its hardening profile (`colloq.profile`); null —
   * none; `unknown` — docker did not say, which is never taken for "none" (a
   * live kernel would be removed on it).
   */
  private async byName(name: string): Promise<{ id: string; status: string; placement: string; profile: string } | null | 'unknown'> {
    const asked = await this.docker(['inspect', '--type', 'container', '--format', '{{.Id}}\t{{.State.Status}}\t{{index .Config.Labels "colloq.placement"}}\t{{index .Config.Labels "colloq.profile"}}', name], { timeoutMs: 15_000 })
    if (asked.code !== 0) return dockerMissing(asked) ? null : 'unknown'
    const [id = '', status = '', placement = '', profile = ''] = asked.out.trim().split('\n')[0]?.split('\t') ?? []
    return /^[a-f0-9]{64}$/.test(id.trim()) ? { id: id.trim(), status: status.trim(), placement: placement.trim(), profile: profile.trim() } : 'unknown'
  }

  private async portOf(container: string): Promise<number | null> {
    const asked = await this.docker(['port', container, '8888/tcp'], { timeoutMs: 15_000 })
    return asked.code === 0 ? parsePort(asked.out) : null
  }
}
