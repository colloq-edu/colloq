/**
 * The contract of classes on machines («занятия на машинах»,
 * docs/architecture/remote-classes.md §15): the `kernels` block one sync
 * carries each way, a parser for each direction, the doors' paths, and
 * every number both sides must agree on.
 *
 * AN EXTENSION OF shared/remote-runner.ts, NOT A SECOND PROTOCOL. The block
 * rides the 0.23 sync under REMOTE_PROTOCOL 1 and is optional both ways: the
 * agent sends it only after a reply that carried it, so a 0.24 home's strict
 * parser never meets it, and a 0.24 agent drops it from a reply like any key
 * it does not know. Home sends it to every machine with classes, an outdated
 * build included, because live placements must keep reconciling; only new
 * placements need build equality.
 *
 * THE RULES AND THE HELPERS OF THE FILE IT EXTENDS. Home's parser of the
 * agent's block (parseRemoteKernelsRequest) refuses unknown keys, ids, hashes
 * and paths outside their patterns, gens below one, numbers out of range and
 * inline content over its caps. The agent's parser of home's block
 * (parseRemoteKernelsReply) checks every key it knows as strictly, and drops
 * every key it does not at any depth, so what it returns holds the contract's
 * keys and nothing else. Both throw RemoteProtocolError, which the router
 * answers like any other refusal. They normally run inside
 * parseRemoteSyncRequest and parseRemoteSyncReply, which also hold the rules
 * that span both blocks of a sync (the busy hold, the bye, no hidden test
 * beside classes).
 *
 * TWO MODULES THAT IMPORT EACH OTHER. remote-runner.ts parses the block with
 * the parsers here, and these use its helpers and its patterns. Neither reads
 * anything of the other's while it loads, only inside functions, so either
 * may be imported first, under tsx and in the agent's bundle alike
 * (tests/remote-kernels-contract.test.mts loads each first). A top-level line
 * here that reads an import from remote-runner.ts (a constant built from one
 * of its patterns, a set of its words) would break every process that loads
 * remote-runner.ts first, home's router among them: what this file needs of
 * that one at its top level, it writes out itself.
 *
 * A PATH IS shared/paths.ts's. Every path the block carries is canonical by
 * normalizePath (depth, segment and path lengths, no hidden names, no `..`,
 * no empty segments) and names a file a file system could hold: the agent
 * walks the class folder by the same rule (§8.5), and a path outside it is a
 * bug or a forgery, never a file. What is a matter of policy rather than of
 * shape (a notebook file, `__pycache__`, a cap) is home's verdict on that one
 * path (`refused`), never a refused sync: one odd file must not take a
 * machine's every placement down with it.
 *
 * THE SIZES ADD UP, as in the file this extends. The count and byte caps
 * here are chosen so that the largest block a parser accepts, every text and
 * path escaped at its worst, fits the sync's body cap and the agent's reply
 * cap together with the 0.23 fields at their worst
 * (tests/remote-runner-protocol.test.mts builds both).
 */
import {
  REMOTE_BLOB_MBPS,
  REMOTE_CARD_MB_MAX,
  REMOTE_CPUS_MAX,
  REMOTE_DEVICE,
  REMOTE_IMAGE_REF,
  REMOTE_MEMORY_MB_MAX,
  REMOTE_REASON_CHARS,
  REMOTE_REF_CHARS,
  REMOTE_SHA256,
  base64Bytes,
  distinct,
  fields,
  flag,
  imageOf,
  integer,
  items,
  known,
  label,
  matching,
  refuse,
  within,
  word,
} from './remote-runner.js'
import {
  RUNTIME_MEMORY_MAX_MB,
  RUNTIME_MEMORY_MIN_MB,
  RUNTIME_REVISION,
  RUNTIME_SESSION_ID,
  RUNTIME_UNSCHEDULABLE,
  type RuntimeResizeResult,
  type RuntimeStartFailure,
} from './runtime.js'
import { ENVIRONMENT_NAME } from './admin.js'
import { MAX_PATH, isInside, normalizePath } from './paths.js'

/* ---------------------------------------------------------- slots and keys */

/**
 * The containers of one class on a machine (§6.1): `room` holds the class
 * notebooks' kernels and the shared terminal, `own` the personal notebooks',
 * `council` the attempt pool's workers.
 */
export type RemoteKernelRole = 'room' | 'own' | 'council'
export const REMOTE_KERNEL_ROLES: readonly RemoteKernelRole[] = ['room', 'own', 'council']

/** A class: home's sessions.id, as the broker's routes take it. */
export const REMOTE_SESSION_ID = RUNTIME_SESSION_ID

/**
 * A placement's key, `<sessionId>:<role>`: one slot of one class. A class id
 * never holds `:` (REMOTE_SESSION_ID), so a key reads only one way. It names
 * the slot, the gen beside it names the placement.
 */
export const REMOTE_PLACEMENT_KEY = new RegExp(`^(${RUNTIME_SESSION_ID.source.slice(1, -1)}):(room|own|council)$`)

export function remotePlacementKey(sessionId: string, role: RemoteKernelRole): string {
  const key = `${sessionId}:${role}`
  if (!REMOTE_PLACEMENT_KEY.test(key)) refuse('Invalid placement key')
  return key
}

/** The class and the slot a key names; `null` — no key. */
export function parseRemotePlacementKey(key: unknown): { sessionId: string; role: RemoteKernelRole } | null {
  const match = typeof key === 'string' ? REMOTE_PLACEMENT_KEY.exec(key) : null
  return match ? { sessionId: match[1]!, role: match[2] as RemoteKernelRole } : null
}

/**
 * placementToken (§6.9): HMAC-SHA256 of the instance secret over the slot,
 * the machine and the gen, cut to 40 hex digits like pool.ts · roomToken. It
 * is JUPYTER_TOKEN inside the container and the token home's client sends.
 */
export const REMOTE_PLACEMENT_TOKEN = /^[a-f0-9]{40}$/

/** A class container as docker names it to the agent: its full id. The agent reads it from `docker run` and keeps it in its record. */
export const REMOTE_CLASS_CONTAINER = /^[a-f0-9]{64}$/

/**
 * A notebook's root in the room document, as shared/notebook.ts · isBookRoot
 * reads one: `cells`, or `nb:` and the rest. The rest is an id for every
 * notebook made since 2 Sep 2026 (`nb:b_…`, 93122dd), but it was the
 * notebook's path for those made in the four days before (f43e62f:
 * `nb:Тетрадь 2.ipynb`), and no room ever rewrites a root (notebook.ts ·
 * rootForNewBook), nor does a room copied from one: any characters a path
 * took then, up to MAX_PATH of them, by the rules of then.
 * A root this refused would refuse the whole sync of every class on its
 * machine, so it takes them all, and refuses only what no room holds: a
 * control character, half a surrogate pair, a root past that length.
 *
 * So a root is a name to compare, never one to build a file's path or a URL
 * from: what the agent keeps per notebook, it keeps under a hash of the root.
 */
export const REMOTE_ROOT_CHARS = 'nb:'.length + MAX_PATH

export function isRemoteRoot(v: unknown): v is string {
  // `cells` and `nb:` are notebook.ts's CELLS_KEY and BOOK_PREFIX, written out: that module loads Yjs and the i18n catalogues.
  return v === 'cells' || (typeof v === 'string' && v.startsWith('nb:') && v.length > 'nb:'.length && v.length <= REMOTE_ROOT_CHARS && !CONTROL.test(v) && !LONE_SURROGATE.test(v))
}

/** A council run's id, as the scratch folder and the artifacts' path carry it (§9.7). */
export const REMOTE_RUN_ID = /^[A-Za-z0-9_-]{1,64}$/

/** One range a placement must not reach on top of the private ones: an IPv4 CIDR as perimeter.ts · blockedCidrsSetting normalises KERNEL_BLOCKED_CIDRS. */
export const REMOTE_CIDR = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(?:3[0-2]|[12]?\d)$/

/** The base of a path that was a folder when both sides last agreed (the baseline maps a path to its sha256 or to this, §8.1). */
export const REMOTE_DIR_BASE = 'dir'

/* ------------------------------------------------------- start and files */

/** How long ensure waits for a placement to be ready: images are prefetched, so this is a container's start plus Jupyter's, typically 5–15 s. */
export const CLASS_START_MS = 180_000
/** How long a run waits at the files barrier while bytes keep moving, and how long it waits with none moving before it is refused (§8.2). */
export const CLASS_BARRIER_MS = 120_000
export const CLASS_BARRIER_STALL_MS = 30_000
/** The agent scans a class folder this often while a stream of the class carried bytes in the last minute, and this often otherwise (§8.3). */
export const CLASS_SCAN_BUSY_MS = 5_000
export const CLASS_SCAN_IDLE_MS = 30_000
/** A changed file is hashed only after this long without a change, so a checkpoint is not caught half-written; a scan home asks for after a run skips it. */
export const CLASS_FILE_QUIET_MS = 2_000
/** A file rides inside a push or a report up to this; a bigger one travels by its own request (GET blobs, PUT rooms/…/files). */
export const CLASS_INLINE_BYTES = 64 * 1024
/** All inline files of one sync's reports together (§8.3): past it the rest are pulled. */
export const CLASS_INLINE_REPORT_BYTES = 128 * 1024
/** All inline files of one reply's pushes together (§8.2): past it the rest are blobs. */
export const CLASS_INLINE_PUSH_BYTES = 1024 * 1024
/** Entries of one walk of a class folder, files and folders together (§8.5): past it the rest are `skipped` with `count`. */
export const CLASS_SYNC_FILES_MAX = 5000
/** Upload slots of a machine's class files, its own beside the submissions', so classes never starve them (§8.3). */
export const REMOTE_CLASS_UPLOADS = 2
/** «Файл с машины — до»: the default of the live setting (machineFileMb) over which a kernel's file stays «на машине» (D17). */
export const CLASS_MACHINE_FILE_MB = 200

/* -------------------------------------------------------------- liveness */

/** A placement unreachable this long gets the room's note and the waiting cell's words (§5.3). */
export const CLASS_UNREACHABLE_NOTE_MS = 10_000
/**
 * «Если машина пропала: перенести через …» (D13): the class's own number of
 * seconds of proven silence on both channels before failover, within these
 * bounds, or «ждать машину».
 */
export const CLASS_FAILOVER_SEC = { min: 30, max: 300, default: 60 } as const
export const CLASS_SILENCE_MS = CLASS_FAILOVER_SEC.default * 1000
/** Tunnel down while syncs keep arriving: the class cannot compute, and home fails over after this (§11.1). */
export const CLASS_TUNNEL_STUCK_MS = 120_000
/** While any class placement lives, path evidence counts for this long, and home probes itself this often (against 60 s and 30 s for leases). */
export const CLASS_EVIDENCE_MS = 15_000
export const CLASS_PROBE_MS = 5_000
/** After a `bye: 'restart'` no failover for this long: the update pulls first, drains, then restarts the agent (D23). */
export const CLASS_BYE_GRACE_MS = 120_000
/** «Перенести сейчас» appears after this long without a link (D13). */
export const CLASS_MOVE_NOW_MS = 10_000
/** Class quarantine (D32): this many silence failovers of one machine within the window stop it taking classes until the owner resumes it. */
export const CLASS_QUARANTINE_FAILOVERS = 2
export const CLASS_QUARANTINE_WINDOW_MS = 30 * 60_000
/** While placements live the agent checks its perimeter this often; this many failures in a row stop every class container (§7.6). */
export const PERIMETER_RECHECK_MS = 60_000
export const PERIMETER_FAILURES_MAX = 3
/** Help on a machine placement waits min(this, 2 × the link's RTT p95) on top of its own budget (§5.6). */
export const CLASS_HELP_PAD_MAX_MS = 1_000

/* ------------------------------------------------------------------ rates */

/**
 * What the reply's `rates` say while any class is live on a machine (§4.9,
 * D18), first numbers that K0 may lower: class bulk both ways (pushes,
 * epochs, kernel writes, artifacts), promoted for a push a run waits on, and
 * as it is with no class live; competition blobs during classes; and the
 * pace of a machine's tunnel lanes towards home, with its burst.
 */
export const CLASS_BULK_MBPS = 4
export const CLASS_BULK_PROMOTED_MBPS = 8
export const CLASS_BULK_IDLE_MBPS = 8
export const CLASS_COMPETITION_MBPS = 2
export const MACHINE_PACE_MBPS = 6
export const MACHINE_PACE_BURST_BYTES = 2 * 1024 * 1024

/* ---------------------------------------------------------------- council */

/** «Память на попытку» (D33): each worker's ceiling by default, mandatory for workers. */
export const COUNCIL_ATTEMPT_MB = 1024
/** Workers of one pool: at least `min` once it runs, at most `auto` sized by itself, at most `max` set by hand (§9.5). */
export const COUNCIL_WORKERS = { min: 2, auto: 16, max: 32 } as const
/** A worker restarts and reseeds after serving this many attempts: leaked modules and `pip` drift stay bounded. */
export const COUNCIL_WORKER_REUSE = 20
/** An epoch's files together, and what one refresh may ship across the relay (only the buffers the other side lacks count). */
export const COUNCIL_EPOCH_MB = 2048
export const COUNCIL_EPOCH_SHIP_MB = 256
/** A dispatch waits this long for a refreeze before it runs on the newest ready epoch (D8). */
export const COUNCIL_EPOCH_WAIT_MS = 5_000
/** A pool not ready this long after the first attempt is reported in the console with the machine's words. */
export const COUNCIL_POOL_READY_MS = 60_000
/** A pool stops this long after the notebook's last council closes. */
export const COUNCIL_POOL_LINGER_MS = 15 * 60_000
/** An attempt's files on its card (D10): this many, each and in all at most these bytes. Larger ones are named with their size and stay behind. */
export const COUNCIL_ARTIFACTS = { files: 20, fileBytes: 1024 * 1024, totalBytes: 5 * 1024 * 1024 } as const
/** Home's own store of epochs, least recently used first out. */
export const COUNCIL_EPOCH_STORE_MB = 4096
/** Where a notebook's kernel writes an export inside its own container: `<dir>/<seq>/`, which personal kernels and attempts cannot reach (§9.2). */
export const COUNCIL_EPOCH_DIR = '/tmp/colloq-epoch'
/** Files of one epoch besides its manifest: the stream and the out-of-band buffers. An export with more keeps its smaller buffers in band. */
export const COUNCIL_EPOCH_BUFFERS_MAX = 4096
/** An epoch's manifest: modules, left names, buffer shas in order, process-state keys. */
export const COUNCIL_EPOCH_MANIFEST_BYTES = 4 * 1024 * 1024

/* ----------------------------------------------------------- the counts */

/** Placements one machine holds, and intents in one reply: twenty-odd classes of three slots each, more than one machine serves. */
export const REMOTE_PLACEMENTS_MAX = 64
/**
 * Paths of one sync's file reports together (changed, removed, skipped and
 * late), of one reply's verdicts and of its pulls: per sync, not per report
 * as §8.6 has it, so that one body holds the reports of every class on the
 * machine at their worst. The agent shares it among its classes; past it the
 * rest wait for the next sync, and a full report goes in pages
 * (RemoteFilesReport.page).
 */
export const REMOTE_REPORT_PATHS_MAX = 1000
/** Paths of one reply's pushes together, a move counting two: the largest class folder in one full push (CLASS_SYNC_FILES_MAX). */
export const REMOTE_PUSH_PATHS_MAX = CLASS_SYNC_FILES_MAX
/** Paths a returning machine names as changed after the fence, in one report (§8.8). */
export const CLASS_LATE_MAX = 50
/**
 * Epochs in one message, each way: every epoch a machine may hold, which is
 * the two newest of each council notebook (the live one and the one being
 * refreshed) for REMOTE_PLACEMENTS_MAX notebooks. A machine with classes of
 * D31 holds only their council and personal slots, so dozens of councils on
 * one machine are what the cap is for.
 */
export const REMOTE_EPOCHS_MAX = 2 * REMOTE_PLACEMENTS_MAX
/** Files one reply's epoch intents name together, their buffers: two epochs at their largest. Past it the rest wait for a later reply. */
export const REMOTE_EPOCH_FILES_MAX = 2 * COUNCIL_EPOCH_BUFFERS_MAX
/** Post-mortem questions in one reply and readings in one sync (§7.4). */
export const REMOTE_READINGS_MAX = 16
/** The log lines of one reading, and each line's length: home's own reading keeps three (postmortem.ts · readTail), and `describe` names the last. */
export const REMOTE_READING_LINES_MAX = 3
export const REMOTE_READING_LINE_CHARS = 500
/** Attempts whose artifacts one reply asks for. */
export const REMOTE_COLLECTS_MAX = 16
/**
 * Ranges of KERNEL_BLOCKED_CIDRS one intent carries. Home caps nothing of the
 * setting (perimeter-core.ts · blockedCidrsSetting) and may not cut the list
 * either, since a machine may add ranges and never drop one (§7.6), so the
 * rule is home's: while the setting holds more ranges than this, home's floor
 * (D21) is one no machine can be told, and no slot is placed on a machine or
 * kept there (K5a's eligibility, with the reason in words). An intent over
 * it would refuse the whole reply on the agent, leases and revokes with it.
 */
export const REMOTE_BLOCKED_CIDRS_MAX = 64
/** A class container's process ceiling: the instance settings' own bounds (admin/resource-settings.ts · roomPids, ownPids). */
export const REMOTE_PIDS = { min: 64, max: 32768 } as const
/** Room cores, as the class form and the broker take them (runtime.ts). */
export const REMOTE_ROOM_CPUS_MAX = 64
/** PYTHONHASHSEED (D28): 1 + sha256 mod 4294967295, so one of 1…4294967295 (room-spec.ts · classHashSeed). */
export const REMOTE_HASH_SEED_MAX = 4_294_967_295
/**
 * A GPU room's `--shm-size` as docker reads a size (go-units · RAMInBytes:
 * a number, a unit, an `i` and a `b` as it likes them, `1g`, `512MiB`,
 * `2gb`), above nothing: docker's 64 MB default is what breaks
 * `DataLoader(num_workers=4)` with "bus error", and `0` is that default. Home
 * sends what its own GPU rooms run with (pool.ts · roomShm: KERNEL_SHM, else
 * room-spec.ts · ROOM_SHM) and checks it by this same pattern first: the
 * agent refuses the whole reply over an intent outside it, leases and
 * revokes with it.
 */
export const REMOTE_SHM = /^(?=[^1-9]*[1-9])\d{1,12}(?:\.\d{1,6})? ?[kKmMgGtTpP]?[iI]?[bB]?$/

/* ---------------------------------------------------------------- the doors */

/**
 * The class doors under REMOTE_API_BASE (§15) beside remotePaths, built only
 * from ids and paths in their patterns: a path ends up in a URL, and a URL is
 * no place for a `../`. The tunnel's own is remote-tunnel.ts's.
 */
export const remoteClassPaths = {
  /** PUT a kernel's file home (gzip, X-Colloq-Sha256, X-Colloq-Bytes), at most machineFileMb, or the room limit for «Привезти». */
  roomFile: (sessionId: string, path: string, gen: number): string =>
    `rooms/${part(sessionId, REMOTE_SESSION_ID)}/files?path=${encodeURIComponent(filePart(path))}&gen=${genPart(gen)}`,
  /** PUT one epoch file home, raw: accepted only for an epoch home asked that placement for. */
  epoch: (sha256: string, sessionId: string, gen: number): string =>
    `epochs/${part(sha256, REMOTE_SHA256)}?session=${part(sessionId, REMOTE_SESSION_ID)}&gen=${genPart(gen)}`,
  /** PUT one artifact of an attempt, at most COUNCIL_ARTIFACTS.fileBytes. */
  artifact: (sessionId: string, runId: string, name: string, gen: number): string =>
    `council/${part(sessionId, REMOTE_SESSION_ID)}/runs/${part(runId, REMOTE_RUN_ID)}/files/${encodeURIComponent(filePart(name))}?gen=${genPart(gen)}`,
} as const

/**
 * The `revision` a ready placement echoes, and the one home asks
 * checkRuntimeEndpoint for: the manifest digest its image is pinned by, the
 * `sha256:…` after the `@` of the revision's `ref`, as home reads an
 * environment's image (runtime.ts · imageRevision). The agent echoes it from
 * the ref of the revision it started the container from (its placement
 * record, §7.2), home asks for its intent's, so a container adopted from
 * before a repin is told apart. Never docker's image id (`inspect -f
 * {{.Image}}`): the classic store gives the config's digest there, containerd
 * the manifest's or the index's (runner-agent/images.ts), and an echo of it
 * would match on some machines and on no others.
 */
export function remoteRevisionDigest(ref: string): string {
  if (typeof ref !== 'string' || ref.length > REMOTE_REF_CHARS || !REMOTE_IMAGE_REF.test(ref)) refuse('Invalid image ref')
  return ref.slice(ref.lastIndexOf('@') + 1)
}

/* ---------------------------------------------------------------- messages */

/**
 * A placement home wants the machine to hold, whole: what `docker run` needs
 * on top of the agent's own argv core (room-spec.ts · roomRunArgs). The
 * reply's list is the whole wanted set: a key left out is a container to
 * remove.
 */
export interface RemotePlacementIntent {
  /** `<sessionId>:<role>` (remotePlacementKey). */
  key: string
  gen: number
  environment: string
  /** The pinned image, as a lease pins it: the container runs `colloq-revision:<id>`, tagged after its layers matched. */
  revision: { id: string; ref: string; layers: string }
  memoryMb: number
  cpus: number
  pids: number
  /** A whole card (§6.5): for a `room` slot only. Personal notebooks never get one (pool.ts), council workers none in v1 (D11). */
  gpu: boolean
  /** Home's network mode, the floor on the machine (D21): `open` never leaves home. */
  network: 'blocked' | 'none'
  /** KERNEL_BLOCKED_CIDRS: the machine may add ranges, never remove them. */
  blockedCidrs: string[]
  /** placementToken: JUPYTER_TOKEN inside the container, 40 hex digits. */
  token: string
  /** The class's PYTHONHASHSEED, the same for its three containers (D28). */
  hashSeed: number
  /**
   * `--shm-size` of a GPU room (REMOTE_SHM): home's own (pool.ts · roomShm),
   * so that the argv on a machine is home's flag for flag
   * (tests/room-spec-argv.test.mts). Every slot carries it; only a room with a
   * card gets the flag (room-spec.ts).
   */
  shm: string
  /** The pool's planned size: `council` only, and always there. */
  workers?: number
}

/** Where a placement is on the machine. `failed` carries why; `ready` carries the echoes home checks (checkRuntimeEndpoint). */
export type RemotePlacementPhase = 'pulling' | 'starting' | 'ready' | 'failed' | 'stopping'

/** The census of one placement's container (§7.4): whole numbers, measured by the agent (remoteCount). */
export interface RemotePlacementUsage {
  usedMb: number | null
  limitMb: number
  cpus: number
  cpuPercent: number | null
  /** When the container started, on the agent's clock (epoch ms). */
  startedAt: number
  oomKills: number
}

/** How far a class folder copy is behind home and home behind it: «файлы: синхронно», «↑ 3 файла, 12 МБ», «2 файла только на машине» (§8.7). */
export interface RemoteFilesLag {
  /** The last push the copy has applied. */
  pushSeq: number
  pending: number
  pendingBytes: number
  /** Files that stay on the machine: over a cap, or in a package tree. */
  heldOnly: number
  heldOnlyBytes: number
}

/** A placement the machine holds: every one of them in every sync, and one left out is one it no longer has. */
export interface RemotePlacementHeld {
  key: string
  gen: number
  phase: RemotePlacementPhase
  /** The container's id: a `ready` placement's echo, never a `pulling` one's. */
  container?: string
  /** remoteRevisionDigest of the ref the container was started from: a `ready` placement's echo, checked like RuntimeClient.ensure's. */
  revision?: string
  /** Why a `failed` placement did not start, in the broker's words, and with nothing else. */
  failure?: RuntimeStartFailure & { detail?: string }
  usage?: RemotePlacementUsage
  /** The card a GPU room holds whole, and the memory it uses there. */
  card?: { device: string; usedMb: number | null }
  files?: RemoteFilesLag
  /** The last resize's outcome (`docker update`). */
  resized?: RuntimeResizeResult['outcome']
}

/** A file of a push: its content by hash, inline up to CLASS_INLINE_BYTES (base64) or fetched as a blob. */
export interface RemoteFilesPutFile {
  path: string
  sha256: string
  bytes: number
  inline?: string
  dir?: never
}

/** A folder of a push: its path and nothing else. */
export interface RemoteFilesPutDir {
  path: string
  dir: true
  sha256?: never
  bytes?: never
  inline?: never
}

/**
 * One or the other, and the type says so: §15 wrote one shape with `dir?:
 * true` beside a hash and a size, which the agent refuses ('Invalid pushed
 * folder', the whole reply with it), so a folder that carries a file's keys
 * does not compile, rather than stall every class of its machine.
 */
export type RemoteFilesPut = RemoteFilesPutFile | RemoteFilesPutDir

/**
 * What home wrote to a class folder since the machine's copy last agreed
 * (§8.2), applied in order: moves, then removes, then puts. `full` describes
 * the whole folder, as the first push of a placement does.
 */
export interface RemoteFilesPush {
  sessionId: string
  seq: number
  full: boolean
  /** A run waits on it: the agent fetches its blobs at the promoted rate (CLASS_BULK_PROMOTED_MBPS). */
  promoted?: boolean
  put: RemoteFilesPut[]
  remove: string[]
  move: { from: string; to: string }[]
}

/** Why a path is left on the machine: over machineFileMb, over the room limit, past the walk's ceiling, or inside a package tree (§8.5). */
export type RemoteSkipReason = 'size' | 'room' | 'count' | 'package'

/**
 * What a class's kernels wrote, as a scan of the machine's copy found it
 * (§8.3). Each change carries its `base`, the sha256 both sides last agreed
 * on (REMOTE_DIR_BASE for a folder, null for a path that was not there):
 * home applies it only if its own file still is that (§8.4).
 */
export interface RemoteFilesReport {
  sessionId: string
  gen: number
  seq: number
  /**
   * Every file of the copy, from one walk, for home to rebuild what it has
   * acked after a restart (§8.4). A walk holds up to CLASS_SYNC_FILES_MAX
   * entries and one sync REMOTE_REPORT_PATHS_MAX paths, so a full report comes
   * in pages, `page` on every one of them.
   */
  full?: boolean
  /**
   * A full report's place in its walk, there with `full` and never without
   * it. Pages go out in order from 0, one a sync, and the class sends no other
   * report until the last. Home starts over at page 0 and takes the walk for
   * the whole copy only at its last page: a page it did not count from 0 (home
   * restarted in between), or a report without `full` before the last page
   * (the agent restarted), drops what it has, and home asks again
   * (RemoteKernelsReply.scan).
   */
  page?: { index: number; last: boolean }
  changed: { path: string; sha256: string; bytes: number; base: string | null; inline?: string }[]
  removed: { path: string; base: string }[]
  skipped: { path: string; bytes: number; why: RemoteSkipReason }[]
  /** Changed after the fence, at most CLASS_LATE_MAX (§8.8): home names them in the room and refuses them. */
  late?: string[]
}

/**
 * An epoch home wants the machine to hold (§9.2): its manifest and every file
 * it names, by hash, fetched as blobs or copied from the export on this very
 * machine. Home names it in every reply until the machine's sync reports it
 * `ready`, a lost reply being a delay, and then no more: leaving an epoch out
 * of a reply never asks for its removal (RemoteKernelsReply.epochs).
 */
export interface RemoteEpochIntent {
  sessionId: string
  root: string
  seq: number
  manifest: { sha256: string; bytes: number }
  /** The stream and the out-of-band buffers. */
  buffers: { sha256: string; bytes: number }[]
  /** `home`: fetched as blobs. Otherwise the export lies in a class container on this very machine, at `${COUNCIL_EPOCH_DIR}/<seq>`, for `docker cp`. */
  from: 'home' | { container: string; dir: string }
}

/** An epoch as the machine holds it: whole, or the hashes it still lacks (COUNCIL_EPOCH_BUFFERS_MAX of them over one sync at most, so a list may be cut). */
export interface RemoteEpochState {
  sessionId: string
  root: string
  seq: number
  ready: boolean
  missing?: string[]
}

/**
 * What docker and the cgroup said of a placement's container, as home's own
 * post-mortem reads a room (kernel/postmortem.ts · MemoryReading): numbers in
 * bytes, docker's state word, the exit code and the last lines of its log.
 */
export interface PostmortemReading {
  limit: number | null
  peak: number | null
  current: number | null
  kills: number | null
  containerOomKilled: boolean
  status: string
  exit: number | null
  tail: string[]
}

/** The agent's perimeter as it last checked it (§7.6). */
export type RemotePerimeterState = 'ok' | 'no-dockerd' | 'no-iptables' | 'refused' | 'failing'

/** What makes a machine eligible for classes, measured on it (§6.3, §7.5, §7.6). */
export interface RemoteClassFacts {
  /** The agent runs with `--network host` (D19); false while it does not know yet. */
  hostNetwork: boolean
  /** Only `failing` (the perimeter failed closed, §7.6) moves classes away; any other word but `ok` keeps the machine from new ones. */
  perimeter: RemotePerimeterState
  /**
   * The machine's own floor (its COLLOQ_ROOM_NETWORK): every class there runs
   * at least this strict. Home's mode rides each intent and the stricter of
   * the two is what runs, so home never needs this to reach its own floor
   * for a machine to be eligible. `open` is never said (D21).
   */
  mode: 'blocked' | 'none' | 'open'
  /** The admission canary: `ok`, or what failed, in the agent's words. */
  canary: string
  /** A Colloq home's containers are on the same daemon (D20); true while the agent does not know yet. */
  sameDaemon: boolean
}

/** Why the agent's last sync is its last: an update restarts it, a stop stops it, a leave leaves (§7.3). */
export type RemoteBye = 'restart' | 'stopping' | 'leaving'

/** The machine's `kernels` block, in every sync after a reply that carried one. */
export interface RemoteKernelsRequest {
  placements: RemotePlacementHeld[]
  reports: RemoteFilesReport[]
  /** Every epoch the machine holds or is fetching, in every sync: one left out is one it no longer has. */
  epochs: RemoteEpochState[]
  readings: { key: string; gen: number; reading: PostmortemReading }[]
  tunnel: 'up' | 'down'
  bye?: RemoteBye
  classes: RemoteClassFacts
}

/** Why home refused a reported change (§8.4): another base, a notebook file, a cap, or a path it does not take. */
export type RemoteVerdictReason = 'base' | 'book' | 'cap' | 'path'

/** Home's `kernels` block, to every machine with classes. */
export interface RemoteKernelsReply {
  /** The whole wanted set: a placement left out is one to remove. */
  placements: RemotePlacementIntent[]
  pushes: RemoteFilesPush[]
  /** Per report: the paths that moved into the baseline, and those home's next push overwrites. `copy` is the conflict copy home kept. */
  verdicts: { sessionId: string; seq: number; accepted: string[]; refused: { path: string; why: RemoteVerdictReason; copy?: string }[] }[]
  /** Files home wants sent (PUT rooms/…/files), by the hash the report named. */
  pulls: { sessionId: string; gen: number; paths: { path: string; sha256: string }[] }[]
  /**
   * Scan these class folders now. `full` asks for a full report: a fresh
   * walk, its page 0 in the very next sync, which drops a walk still being
   * paged. So home asks for one until a page 0 comes and not after: asked in
   * every reply, a walk would never reach its last page.
   */
  scan: { sessionId: string; full?: boolean }[]
  /**
   * The epochs the machine is to hold and has not reported ready, at most
   * REMOTE_EPOCHS_MAX of them naming REMOTE_EPOCH_FILES_MAX files together:
   * the rest wait for a later reply. Not the whole held set, as `placements`
   * is: a whole set would carry every buffer's hash in every reply. The
   * machine drops an epoch by the rule home's store keeps (§9.2): it holds the
   * two newest of each notebook by seq (the live one and the one being
   * refreshed) while a placement of its class lives there, REMOTE_EPOCHS_MAX
   * in all, the oldest going first.
   */
  epochs: RemoteEpochIntent[]
  /** Artifacts of finished attempts to upload (PUT council/…/files). */
  collect: { sessionId: string; runId: string; files: { name: string; sha256: string; bytes: number }[] }[]
  /** Placements whose container home wants read (§7.4), by key. */
  postmortem: string[]
  rates: { classBulkMBps: number; machinePaceMBps: number }
  /** `open`: dial the tunnel. `reconnect`: it is down on home's side, dial again. `closed`: hold none. */
  tunnel: 'open' | 'reconnect' | 'closed'
}

/* -------------------------------------------- the machine's block, at home */

const PHASES: ReadonlySet<string> = new Set<RemotePlacementPhase>(['pulling', 'starting', 'ready', 'failed', 'stopping'])
const RESIZED: ReadonlySet<string> = new Set<RuntimeResizeResult['outcome']>(['applied', 'pending', 'absent'])
const TUNNEL_SIDES: ReadonlySet<string> = new Set<RemoteKernelsRequest['tunnel']>(['up', 'down'])
const BYES: ReadonlySet<string> = new Set<RemoteBye>(['restart', 'stopping', 'leaving'])
const PERIMETERS: ReadonlySet<string> = new Set<RemotePerimeterState>(['ok', 'no-dockerd', 'no-iptables', 'refused', 'failing'])
const MODES: ReadonlySet<string> = new Set<RemoteClassFacts['mode']>(['blocked', 'none', 'open'])
const SKIPS: ReadonlySet<string> = new Set<RemoteSkipReason>(['size', 'room', 'count', 'package'])

/**
 * Home's parser of the machine's block: strict, like every parser of a
 * machine's request. It returns the block itself, checked.
 */
export function parseRemoteKernelsRequest(value: unknown): RemoteKernelsRequest {
  const v = fields(value, 'kernels block', ['placements', 'reports', 'epochs', 'readings', 'tunnel', 'bye', 'classes'])
  if (!word(v.tunnel, TUNNEL_SIDES) || (v.bye !== undefined && !word(v.bye, BYES))) refuse('Invalid kernels block')
  heldOf(v.placements)
  reportsOf(v.reports)
  epochStatesOf(v.epochs)
  readingsOf(v.readings)
  classFactsOf(v.classes)
  return v as unknown as RemoteKernelsRequest
}

function heldOf(value: unknown): void {
  const keys = new Set<string>()
  for (const item of items(value, 'held placements', REMOTE_PLACEMENTS_MAX)) {
    const v = fields(item, 'held placement', ['key', 'gen', 'phase', 'container', 'revision', 'failure', 'usage', 'card', 'files', 'resized'])
    const slot = parseRemotePlacementKey(v.key)
    if (slot === null || keys.has(v.key as string) || !gen(v.gen) || !word(v.phase, PHASES)) refuse('Invalid held placement')
    keys.add(v.key as string)
    if ((v.container !== undefined && !matching(v.container, REMOTE_CLASS_CONTAINER)) || (v.revision !== undefined && !matching(v.revision, RUNTIME_REVISION))
      || (v.resized !== undefined && !word(v.resized, RESIZED))) refuse('Invalid held placement')
    // What a ready placement echoes, as the broker's answer to ensure does: home checks both before it opens a listener.
    if (v.phase === 'ready' && (v.container === undefined || v.revision === undefined)) refuse('A ready placement without its echoes')
    // An image still being pulled has no container to name yet.
    if (v.phase === 'pulling' && v.container !== undefined) refuse('Unexpected container of a pulling placement')
    if ((v.phase === 'failed') !== (v.failure !== undefined)) refuse('A failure belongs to a failed placement')
    if (v.failure !== undefined) failureOf(v.failure)
    if (v.usage !== undefined) usageOf(v.usage)
    if (v.card !== undefined) {
      // A whole card is a GPU room's (§6.5): personal notebooks and workers never hold one.
      if (slot.role !== 'room') refuse('Unexpected card of a placement')
      const c = fields(v.card, 'placement card', ['device', 'usedMb'])
      if (!matching(c.device, REMOTE_DEVICE) || !(c.usedMb === null || integer(c.usedMb, 0, REMOTE_CARD_MB_MAX))) refuse('Invalid placement card')
    }
    if (v.files !== undefined) {
      const f = fields(v.files, 'files lag', ['pushSeq', 'pending', 'pendingBytes', 'heldOnly', 'heldOnlyBytes'])
      if (![f.pushSeq, f.pending, f.pendingBytes, f.heldOnly, f.heldOnlyBytes].every((n) => integer(n, 0, Number.MAX_SAFE_INTEGER))) refuse('Invalid files lag')
    }
  }
}

/** RuntimeStartFailure as parseRuntimeStartFailure reads the broker's, strictly, and the agent's detail beside it. */
function failureOf(value: unknown): void {
  const v = fields(value, 'start failure', ['unschedulable', 'memoryMb', 'cpus', 'detail'])
  const cpus = v.cpus
  if (typeof v.unschedulable !== 'string' || !(RUNTIME_UNSCHEDULABLE as readonly string[]).includes(v.unschedulable)
    || (v.memoryMb !== undefined && !integer(v.memoryMb, RUNTIME_MEMORY_MIN_MB, RUNTIME_MEMORY_MAX_MB))
    || (cpus !== undefined && !(typeof cpus === 'number' && Number.isFinite(cpus) && cpus > 0 && cpus <= REMOTE_ROOM_CPUS_MAX))
    || (v.detail !== undefined && !within(v.detail, REMOTE_REASON_CHARS))) refuse('Invalid start failure')
}

function usageOf(value: unknown): void {
  const v = fields(value, 'placement usage', ['usedMb', 'limitMb', 'cpus', 'cpuPercent', 'startedAt', 'oomKills'])
  if (!(v.usedMb === null || integer(v.usedMb, 0, REMOTE_MEMORY_MB_MAX)) || !integer(v.limitMb, 0, REMOTE_MEMORY_MB_MAX) || !integer(v.cpus, 0, REMOTE_CPUS_MAX)
    || !(v.cpuPercent === null || integer(v.cpuPercent, 0, 100 * REMOTE_CPUS_MAX)) || !integer(v.startedAt, 0, Number.MAX_SAFE_INTEGER)
    || !integer(v.oomKills, 0, Number.MAX_SAFE_INTEGER)) refuse('Invalid placement usage')
}

function reportsOf(value: unknown): void {
  const sessions = new Set<string>()
  let paths = 0
  let inline = 0
  for (const item of items(value, 'files reports', REMOTE_PLACEMENTS_MAX)) {
    const v = fields(item, 'files report', ['sessionId', 'gen', 'seq', 'full', 'page', 'changed', 'removed', 'skipped', 'late'])
    if (!matching(v.sessionId, REMOTE_SESSION_ID) || sessions.has(v.sessionId) || !gen(v.gen) || !integer(v.seq, 1, Number.MAX_SAFE_INTEGER)
      || (v.full !== undefined && !flag(v.full))) refuse('Invalid files report')
    sessions.add(v.sessionId)
    // A full report is paged, every page of it: without its place in the walk, home could not tell its first page from its whole.
    if ((v.full === true) !== (v.page !== undefined)) refuse('A page belongs to a full report')
    if (v.page !== undefined) {
      const p = fields(v.page, 'report page', ['index', 'last'])
      if (!integer(p.index, 0, Number.MAX_SAFE_INTEGER) || !flag(p.last)) refuse('Invalid report page')
    }
    // One path, one fate in a report: changed, removed or left on the machine.
    const seen = new Set<string>()
    const once = (path: unknown, what: string): void => {
      if (!filePath(path) || seen.has(path)) refuse(`Invalid ${what}`)
      seen.add(path)
    }
    const changed = items(v.changed, 'changed files', REMOTE_REPORT_PATHS_MAX)
    for (const entry of changed) {
      const c = fields(entry, 'changed file', ['path', 'sha256', 'bytes', 'base', 'inline'])
      once(c.path, 'changed file')
      if (!matching(c.sha256, REMOTE_SHA256) || !integer(c.bytes, 0, Number.MAX_SAFE_INTEGER) || !(c.base === null || base(c.base))) refuse('Invalid changed file')
      if (c.inline !== undefined) {
        if (c.bytes > CLASS_INLINE_BYTES || base64Bytes(c.inline) !== c.bytes) refuse('Invalid inline file')
        inline += c.bytes
      }
    }
    const removed = items(v.removed, 'removed files', REMOTE_REPORT_PATHS_MAX)
    for (const entry of removed) {
      const r = fields(entry, 'removed file', ['path', 'base'])
      once(r.path, 'removed file')
      // A removal is of something both sides had: a file or a folder, never nothing.
      if (!base(r.base)) refuse('Invalid removed file')
    }
    const skipped = items(v.skipped, 'skipped files', REMOTE_REPORT_PATHS_MAX)
    for (const entry of skipped) {
      const s = fields(entry, 'skipped file', ['path', 'bytes', 'why'])
      once(s.path, 'skipped file')
      if (!integer(s.bytes, 0, Number.MAX_SAFE_INTEGER) || !word(s.why, SKIPS)) refuse('Invalid skipped file')
    }
    let late = 0
    if (v.late !== undefined) {
      const named = new Set<string>()
      for (const path of items(v.late, 'late changes', CLASS_LATE_MAX)) {
        if (!filePath(path) || named.has(path)) refuse('Invalid late change')
        named.add(path)
      }
      late = named.size
    }
    paths += changed.length + removed.length + skipped.length + late
  }
  if (paths > REMOTE_REPORT_PATHS_MAX) refuse('Files reports over their budget')
  if (inline > CLASS_INLINE_REPORT_BYTES) refuse('Inline files over their budget')
}

function epochStatesOf(value: unknown): void {
  const seen = new Set<string>()
  let missing = 0
  for (const item of items(value, 'epochs', REMOTE_EPOCHS_MAX)) {
    const v = fields(item, 'epoch', ['sessionId', 'root', 'seq', 'ready', 'missing'])
    const id = `${String(v.sessionId)} ${String(v.root)} ${String(v.seq)}`
    if (!matching(v.sessionId, REMOTE_SESSION_ID) || !isRemoteRoot(v.root) || !integer(v.seq, 1, Number.MAX_SAFE_INTEGER) || !flag(v.ready) || seen.has(id)) refuse('Invalid epoch')
    seen.add(id)
    if (v.missing === undefined) continue
    const shas = distinct(v.missing, 'missing epoch files', REMOTE_SHA256, COUNCIL_EPOCH_BUFFERS_MAX)
    if (v.ready && shas.length > 0) refuse('A ready epoch with missing files')
    missing += shas.length
  }
  if (missing > COUNCIL_EPOCH_BUFFERS_MAX) refuse('Missing epoch files over their budget')
}

const STATUS = /^[a-z]{0,16}$/

function readingsOf(value: unknown): void {
  const seen = new Set<string>()
  for (const item of items(value, 'readings', REMOTE_READINGS_MAX)) {
    const v = fields(item, 'reading', ['key', 'gen', 'reading'])
    const id = `${String(v.key)} ${String(v.gen)}`
    if (parseRemotePlacementKey(v.key) === null || !gen(v.gen) || seen.has(id)) refuse('Invalid reading')
    seen.add(id)
    const r = fields(v.reading, 'post-mortem reading', ['limit', 'peak', 'current', 'kills', 'containerOomKilled', 'status', 'exit', 'tail'])
    if (!measured(r.limit) || !measured(r.peak) || !measured(r.current) || !measured(r.kills) || !flag(r.containerOomKilled) || !matching(r.status, STATUS)
      || !(r.exit === null || integer(r.exit, 0, 255))) refuse('Invalid post-mortem reading')
    for (const line of items(r.tail, 'log tail', REMOTE_READING_LINES_MAX)) if (!within(line, REMOTE_READING_LINE_CHARS)) refuse('Invalid log tail')
  }
}

function classFactsOf(value: unknown): void {
  const v = fields(value, 'class facts', ['hostNetwork', 'perimeter', 'mode', 'canary', 'sameDaemon'])
  if (!flag(v.hostNetwork) || !word(v.perimeter, PERIMETERS) || !word(v.mode, MODES) || !label(v.canary, REMOTE_REASON_CHARS) || !flag(v.sameDaemon)) refuse('Invalid class facts')
}

/* ------------------------------------------------ home's block, on the agent */

const NETWORKS: ReadonlySet<string> = new Set<RemotePlacementIntent['network']>(['blocked', 'none'])
const TUNNEL_ORDERS: ReadonlySet<string> = new Set<RemoteKernelsReply['tunnel']>(['open', 'reconnect', 'closed'])
const VERDICTS: ReadonlySet<string> = new Set<RemoteVerdictReason>(['base', 'book', 'cap', 'path'])

/**
 * The agent's parser of home's block: every key it knows checked, every other
 * dropped, at any depth (remote-runner.ts · known). What it returns is a copy
 * holding the contract's keys and nothing else.
 */
export function parseRemoteKernelsReply(value: unknown): RemoteKernelsReply {
  const v = known(value, 'kernels block', ['placements', 'pushes', 'verdicts', 'pulls', 'scan', 'epochs', 'collect', 'postmortem', 'rates', 'tunnel'])
  if (!word(v.tunnel, TUNNEL_ORDERS)) refuse('Invalid kernels block')
  const rates = known(v.rates, 'rates', ['classBulkMBps', 'machinePaceMBps'])
  if (!integer(rates.classBulkMBps, REMOTE_BLOB_MBPS.min, REMOTE_BLOB_MBPS.max) || !integer(rates.machinePaceMBps, REMOTE_BLOB_MBPS.min, REMOTE_BLOB_MBPS.max)) refuse('Invalid rates')
  return {
    placements: intentsOf(v.placements),
    pushes: pushesOf(v.pushes),
    verdicts: verdictsOf(v.verdicts),
    pulls: pullsOf(v.pulls),
    scan: scanOf(v.scan),
    epochs: epochIntentsOf(v.epochs),
    collect: collectOf(v.collect),
    postmortem: [...distinct(v.postmortem, 'post-mortem questions', REMOTE_PLACEMENT_KEY, REMOTE_READINGS_MAX)],
    rates: { classBulkMBps: rates.classBulkMBps as number, machinePaceMBps: rates.machinePaceMBps as number },
    tunnel: v.tunnel as RemoteKernelsReply['tunnel'],
  }
}

function intentsOf(value: unknown): RemotePlacementIntent[] {
  const keys = new Set<string>()
  const intents: RemotePlacementIntent[] = []
  for (const item of items(value, 'placement intents', REMOTE_PLACEMENTS_MAX)) {
    const v = known(item, 'placement intent', ['key', 'gen', 'environment', 'revision', 'memoryMb', 'cpus', 'pids', 'gpu', 'network', 'blockedCidrs', 'token', 'hashSeed', 'shm', 'workers'])
    const slot = parseRemotePlacementKey(v.key)
    if (slot === null || keys.has(v.key as string) || !gen(v.gen) || !matching(v.environment, ENVIRONMENT_NAME)
      || !integer(v.memoryMb, RUNTIME_MEMORY_MIN_MB, RUNTIME_MEMORY_MAX_MB) || !integer(v.cpus, 1, REMOTE_ROOM_CPUS_MAX) || !integer(v.pids, REMOTE_PIDS.min, REMOTE_PIDS.max)
      || !flag(v.gpu) || !word(v.network, NETWORKS) || !matching(v.token, REMOTE_PLACEMENT_TOKEN) || !integer(v.hashSeed, 1, REMOTE_HASH_SEED_MAX)
      || !matching(v.shm, REMOTE_SHM)) refuse('Invalid placement intent')
    keys.add(v.key as string)
    const revision = imageOf(v.revision, 'placement revision', ['id', 'ref', 'layers'])
    const blockedCidrs = [...distinct(v.blockedCidrs, 'blocked ranges', REMOTE_CIDR, REMOTE_BLOCKED_CIDRS_MAX)]
    // A whole card goes to a class's own container alone (§6.5).
    if (v.gpu && slot.role !== 'room') refuse('Unexpected card for a placement')
    // A pool has a size, and nothing else has one.
    if (slot.role === 'council' ? !integer(v.workers, 1, COUNCIL_WORKERS.max) : v.workers !== undefined) refuse('Unexpected pool size')
    intents.push({ ...v, revision, blockedCidrs } as unknown as RemotePlacementIntent)
  }
  return intents
}

function pushesOf(value: unknown): RemoteFilesPush[] {
  const sessions = new Set<string>()
  const pushes: RemoteFilesPush[] = []
  let paths = 0
  let inline = 0
  for (const item of items(value, 'files pushes', REMOTE_PLACEMENTS_MAX)) {
    const v = known(item, 'files push', ['sessionId', 'seq', 'full', 'promoted', 'put', 'remove', 'move'])
    if (!matching(v.sessionId, REMOTE_SESSION_ID) || sessions.has(v.sessionId) || !integer(v.seq, 1, Number.MAX_SAFE_INTEGER) || !flag(v.full)
      || (v.promoted !== undefined && !flag(v.promoted))) refuse('Invalid files push')
    sessions.add(v.sessionId)
    const put: RemoteFilesPut[] = []
    const putPaths = new Set<string>()
    for (const entry of items(v.put, 'pushed files', REMOTE_PUSH_PATHS_MAX)) {
      const e = known(entry, 'pushed file', ['path', 'sha256', 'bytes', 'dir', 'inline'])
      if (!filePath(e.path) || putPaths.has(e.path)) refuse('Invalid pushed file')
      putPaths.add(e.path)
      if (e.dir !== undefined) {
        // A folder is its path and nothing else: a hash or a size beside it is a file's, and the two cannot both be meant.
        if (e.dir !== true || e.sha256 !== undefined || e.bytes !== undefined || e.inline !== undefined) refuse('Invalid pushed folder')
        put.push({ path: e.path, dir: true })
        continue
      }
      if (!matching(e.sha256, REMOTE_SHA256) || !integer(e.bytes, 0, Number.MAX_SAFE_INTEGER)) refuse('Invalid pushed file')
      if (e.inline === undefined) {
        put.push({ path: e.path, sha256: e.sha256, bytes: e.bytes })
        continue
      }
      if (e.bytes > CLASS_INLINE_BYTES || base64Bytes(e.inline) !== e.bytes) refuse('Invalid inline file')
      inline += e.bytes
      put.push({ path: e.path, sha256: e.sha256, bytes: e.bytes, inline: e.inline as string })
    }
    const remove = [...distinctPaths(v.remove, 'removed paths', REMOTE_PUSH_PATHS_MAX)]
    const move: RemoteFilesPush['move'] = []
    const sources = new Set<string>()
    const targets = new Set<string>()
    for (const entry of items(v.move, 'moves', REMOTE_PUSH_PATHS_MAX)) {
      const m = known(entry, 'move', ['from', 'to'])
      // A path moves once, to one place, and never into itself: `a` to `a/b` has nowhere to land.
      if (!filePath(m.from) || !filePath(m.to) || sources.has(m.from) || targets.has(m.to) || isInside(m.to, m.from) || isInside(m.from, m.to)) refuse('Invalid move')
      sources.add(m.from)
      targets.add(m.to)
      move.push({ from: m.from, to: m.to })
    }
    paths += put.length + remove.length + 2 * move.length
    pushes.push({ sessionId: v.sessionId, seq: v.seq as number, full: v.full as boolean, ...(v.promoted !== undefined ? { promoted: v.promoted } : {}), put, remove, move })
  }
  if (paths > REMOTE_PUSH_PATHS_MAX) refuse('Files pushes over their budget')
  if (inline > CLASS_INLINE_PUSH_BYTES) refuse('Inline files over their budget')
  return pushes
}

function verdictsOf(value: unknown): RemoteKernelsReply['verdicts'] {
  const seen = new Set<string>()
  const verdicts: RemoteKernelsReply['verdicts'] = []
  let paths = 0
  for (const item of items(value, 'verdicts', REMOTE_PLACEMENTS_MAX)) {
    const v = known(item, 'verdict', ['sessionId', 'seq', 'accepted', 'refused'])
    const id = `${String(v.sessionId)} ${String(v.seq)}`
    if (!matching(v.sessionId, REMOTE_SESSION_ID) || !integer(v.seq, 1, Number.MAX_SAFE_INTEGER) || seen.has(id)) refuse('Invalid verdict')
    seen.add(id)
    const accepted = distinctPaths(v.accepted, 'accepted paths', REMOTE_REPORT_PATHS_MAX)
    const refused: RemoteKernelsReply['verdicts'][number]['refused'] = []
    const named = new Set<string>(accepted)
    for (const entry of items(v.refused, 'refused paths', REMOTE_REPORT_PATHS_MAX)) {
      const r = known(entry, 'refused path', ['path', 'why', 'copy'])
      // A path is accepted or refused, never both; a copy is kept only where home's version won over the machine's.
      if (!filePath(r.path) || named.has(r.path) || !word(r.why, VERDICTS) || (r.copy !== undefined && (r.why !== 'base' || !filePath(r.copy)))) refuse('Invalid refused path')
      named.add(r.path)
      refused.push({ path: r.path, why: r.why as RemoteVerdictReason, ...(r.copy !== undefined ? { copy: r.copy as string } : {}) })
    }
    paths += named.size
    verdicts.push({ sessionId: v.sessionId, seq: v.seq as number, accepted: [...accepted], refused })
  }
  if (paths > REMOTE_REPORT_PATHS_MAX) refuse('Verdicts over their budget')
  return verdicts
}

function pullsOf(value: unknown): RemoteKernelsReply['pulls'] {
  const sessions = new Set<string>()
  const pulls: RemoteKernelsReply['pulls'] = []
  let paths = 0
  for (const item of items(value, 'pulls', REMOTE_PLACEMENTS_MAX)) {
    const v = known(item, 'pull', ['sessionId', 'gen', 'paths'])
    if (!matching(v.sessionId, REMOTE_SESSION_ID) || sessions.has(v.sessionId) || !gen(v.gen)) refuse('Invalid pull')
    sessions.add(v.sessionId)
    const named = new Set<string>()
    const wanted: RemoteKernelsReply['pulls'][number]['paths'] = []
    for (const entry of items(v.paths, 'pulled paths', REMOTE_REPORT_PATHS_MAX)) {
      const p = known(entry, 'pulled path', ['path', 'sha256'])
      if (!filePath(p.path) || named.has(p.path) || !matching(p.sha256, REMOTE_SHA256)) refuse('Invalid pulled path')
      named.add(p.path)
      wanted.push({ path: p.path, sha256: p.sha256 })
    }
    paths += wanted.length
    pulls.push({ sessionId: v.sessionId, gen: v.gen as number, paths: wanted })
  }
  if (paths > REMOTE_REPORT_PATHS_MAX) refuse('Pulls over their budget')
  return pulls
}

function scanOf(value: unknown): RemoteKernelsReply['scan'] {
  const sessions = new Set<string>()
  const scan: RemoteKernelsReply['scan'] = []
  for (const item of items(value, 'scans', REMOTE_PLACEMENTS_MAX)) {
    const v = known(item, 'scan', ['sessionId', 'full'])
    if (!matching(v.sessionId, REMOTE_SESSION_ID) || sessions.has(v.sessionId) || (v.full !== undefined && !flag(v.full))) refuse('Invalid scan')
    sessions.add(v.sessionId)
    scan.push({ sessionId: v.sessionId, ...(v.full !== undefined ? { full: v.full } : {}) })
  }
  return scan
}

function epochIntentsOf(value: unknown): RemoteEpochIntent[] {
  const seen = new Set<string>()
  const epochs: RemoteEpochIntent[] = []
  let files = 0
  for (const item of items(value, 'epoch intents', REMOTE_EPOCHS_MAX)) {
    const v = known(item, 'epoch intent', ['sessionId', 'root', 'seq', 'manifest', 'buffers', 'from'])
    const id = `${String(v.sessionId)} ${String(v.root)} ${String(v.seq)}`
    if (!matching(v.sessionId, REMOTE_SESSION_ID) || !isRemoteRoot(v.root) || !integer(v.seq, 1, Number.MAX_SAFE_INTEGER) || seen.has(id)) refuse('Invalid epoch intent')
    seen.add(id)
    const m = known(v.manifest, 'epoch manifest', ['sha256', 'bytes'])
    if (!matching(m.sha256, REMOTE_SHA256) || !integer(m.bytes, 1, COUNCIL_EPOCH_MANIFEST_BYTES)) refuse('Invalid epoch manifest')
    const shas = new Set<string>([m.sha256])
    const buffers: RemoteEpochIntent['buffers'] = []
    let bytes = 0
    for (const entry of items(v.buffers, 'epoch files', COUNCIL_EPOCH_BUFFERS_MAX)) {
      const b = known(entry, 'epoch file', ['sha256', 'bytes'])
      // Content-addressed: a file named twice, or by the manifest's own hash, is one file the epoch does not have twice.
      if (!matching(b.sha256, REMOTE_SHA256) || shas.has(b.sha256) || !integer(b.bytes, 0, COUNCIL_EPOCH_MB * 1024 * 1024)) refuse('Invalid epoch file')
      shas.add(b.sha256)
      bytes += b.bytes
      buffers.push({ sha256: b.sha256, bytes: b.bytes })
    }
    if (bytes > COUNCIL_EPOCH_MB * 1024 * 1024) refuse('Epoch over its cap')
    files += buffers.length
    let from: RemoteEpochIntent['from'] = 'home'
    if (v.from !== 'home') {
      // The export's own folder in its own container, and no other: home never names a path for docker cp to read.
      const f = known(v.from, 'epoch source', ['container', 'dir'])
      if (!matching(f.container, REMOTE_CLASS_CONTAINER) || f.dir !== `${COUNCIL_EPOCH_DIR}/${v.seq as number}`) refuse('Invalid epoch source')
      from = { container: f.container, dir: f.dir }
    }
    epochs.push({ sessionId: v.sessionId, root: v.root, seq: v.seq as number, manifest: { sha256: m.sha256, bytes: m.bytes as number }, buffers, from })
  }
  if (files > REMOTE_EPOCH_FILES_MAX) refuse('Epoch files over their budget')
  return epochs
}

function collectOf(value: unknown): RemoteKernelsReply['collect'] {
  const seen = new Set<string>()
  const collect: RemoteKernelsReply['collect'] = []
  for (const item of items(value, 'collections', REMOTE_COLLECTS_MAX)) {
    const v = known(item, 'collection', ['sessionId', 'runId', 'files'])
    const id = `${String(v.sessionId)} ${String(v.runId)}`
    if (!matching(v.sessionId, REMOTE_SESSION_ID) || !matching(v.runId, REMOTE_RUN_ID) || seen.has(id)) refuse('Invalid collection')
    seen.add(id)
    const names = new Set<string>()
    const files: RemoteKernelsReply['collect'][number]['files'] = []
    let bytes = 0
    for (const entry of items(v.files, 'artifacts', COUNCIL_ARTIFACTS.files)) {
      const f = known(entry, 'artifact', ['name', 'sha256', 'bytes'])
      if (!filePath(f.name) || names.has(f.name) || !matching(f.sha256, REMOTE_SHA256) || !integer(f.bytes, 0, COUNCIL_ARTIFACTS.fileBytes)) refuse('Invalid artifact')
      names.add(f.name)
      bytes += f.bytes
      files.push({ name: f.name, sha256: f.sha256, bytes: f.bytes })
    }
    if (bytes > COUNCIL_ARTIFACTS.totalBytes) refuse('Artifacts over their cap')
    collect.push({ sessionId: v.sessionId, runId: v.runId, files })
  }
  return collect
}

/* ---------------------------------------------------------------- helpers */

const gen = (v: unknown): v is number => integer(v, 1, Number.MAX_SAFE_INTEGER)
/** A base both sides agreed on: a file's sha256, or a folder. */
const base = (v: unknown): v is string => v === REMOTE_DIR_BASE || matching(v, REMOTE_SHA256)
/** A number docker or the cgroup may not have given: bytes or a count, or null. */
const measured = (v: unknown): boolean => v === null || integer(v, 0, Number.MAX_SAFE_INTEGER)

/** Half of a surrogate pair on its own: no name a file system gives back has one (Node decodes a bad one to U+FFFD). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
/** What paths.ts · safeSegment never let into a name, a path's in a root among them. */
// eslint-disable-next-line no-control-regex -- control characters are the very subject here
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * A path inside a class folder as both sides keep it: canonical
 * (normalizePath gives it back unchanged), not the folder itself, and well
 * formed. A file's path and a folder's alike.
 */
function filePath(v: unknown): v is string {
  return typeof v === 'string' && v !== '' && normalizePath(v) === v && !LONE_SURROGATE.test(v)
}

/** Distinct paths, each a filePath, at most `max`. */
function distinctPaths(value: unknown, what: string, max: number): Set<string> {
  const seen = new Set<string>()
  for (const item of items(value, what, max)) {
    if (!filePath(item) || seen.has(item)) refuse(`Invalid ${what}`)
    seen.add(item)
  }
  return seen
}

function part(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) refuse('Invalid path part')
  return value
}

function filePart(value: string): string {
  if (!filePath(value)) refuse('Invalid path part')
  return value
}

function genPart(value: number): number {
  if (!gen(value)) refuse('Invalid path part')
  return value
}
