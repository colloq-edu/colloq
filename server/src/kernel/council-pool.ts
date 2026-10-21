import { tr } from '@shared/i18n'
/**
 * The council's pool of workers, at home (docs/architecture/remote-classes.md
 * §9.5–9.10): a router in front of unchanged pumps.
 *
 * A NOTEBOOK'S ATTEMPTS GO TO A POOL OF ITS OWN when the class's council
 * computes on machines (ClassPlacement.council) and the cell's attempts go to
 * the pool (CouncilSettings.lane): workers, each a hidden runtime of
 * kernel/index.ts with a Python of its own in the class's council container
 * on a machine, loaded once with the notebook's epoch — the snapshot of its
 * kernel (§9.2, kernel/remote/epochs.ts) — computing one attempt at a time
 * through today's runCouncilOne: the barrier, the limit, the entry with its
 * personal copies, the attempt, the exit. Attempts no longer wait for the
 * teacher's cells nor for each other, and the notebook's queue never holds
 * one of them.
 *
 * THE ROUTE IS DECIDED AT THE PRESS (§9.6 «Which queue»): the pool takes an
 * attempt when it has a worker loaded with an epoch it may use, that epoch
 * holds no data on the GPU (D11), and the pool's machine answers. Otherwise
 * — the first seconds after open, no machine, the epoch did not come
 * together or does not fit, the machine away or lost — the attempt runs in
 * the notebook's own kernel, as it always did, and its card says why
 * (§9.9). A class whose council is `shared` meets none of this: its
 * attempts are not even marked.
 *
 * ASSIGNMENT (§9.6). The pool's queue holds the waiting attempts, the
 * teacher's ahead of the authors' (D12), each in the order pressed. Its
 * head goes to an idle worker — one holding the epoch it is given, if any is
 * idle — and that worker's queue holds it alone. Before the head goes, an
 * epoch the teacher has run cells since is refreshed when the head's cell
 * follows the kernel (D8): one refreeze in flight, waited for at most
 * COUNCIL_EPOCH_WAIT_MS, and at most that from the attempt's own press
 * however many refreezes a Run All asks; after that the head runs on the
 * newest epoch its machine holds, and its card says «состояние 14:05 — без
 * ячеек 8–9». What waits when the machine stops answering, or no epoch it
 * may use is left, goes to the notebook's kernel keeping its place.
 *
 * A WORKER IS RECYCLED, NEVER THE NOTEBOOK'S KERNEL (§9.5): restarted with
 * its session kept and loaded again when its entry did not hold, the exit
 * left threads or processes, it was still stuck after the second SIGINT,
 * its private memory passed «Память на попытку», it served
 * COUNCIL_WORKER_REUSE attempts, or the epoch changed (at most
 * RESEED_AT_ONCE at once, idle ones first); loaded again, with nothing to
 * recycle, when its Python restarted by itself or died — an OOM kill of an
 * idle worker included.
 *
 * SIZING (§9.5). `auto` starts min(4, auto) workers as the council opens,
 * beside the export; auto = ceil(online / 3) within 2 and min(16, what the
 * machine fits at what a worker takes); it grows by 2 every 5 s while more
 * attempts wait than workers idle, shrinks by one a minute down to 2 after
 * 3 minutes of an empty queue, and the pool stops COUNCIL_POOL_LINGER_MS
 * after the notebook's last council cell closes. A number by hand is that
 * many workers. The class's one council container follows its pools
 * together, their sizes and their epochs (§9.5: each worker's «Память на
 * попытку», its baseline and the epoch's stream it unpickled, + the epochs'
 * files once + 512 MB, a core each), and goes with its last pool.
 *
 * WHAT IS LOST IS RUN ONCE MORE (§9.10, D15): an attempt cut off by the
 * pool's machine going away runs again in the notebook's kernel, its pause
 * not charged (the lost run never ended as a run); the attempts still
 * waiting go there keeping their place. The notebook's kernel lost or
 * restarted changes nothing here: the pool keeps its epoch, and only the
 * teacher's runs after it make that epoch stale (mainReset). After a
 * restart of this server the pool comes back on its first need, its workers
 * re-attached by their sessions' paths and recycled before they serve
 * (their epoch is unknown to the new life), the epochs read from the
 * registry; none is made up for a notebook whose kernel may run still.
 *
 * Nothing here writes the room's document: the workers are hidden runtimes
 * (kernel/index.ts · `pool`), and the console hears of the pool through
 * `council:kernel` (CouncilKernel.pool, `onPoolChange`).
 */
import { randomUUID } from 'node:crypto'
import {
  COUNCIL_ATTEMPT_MB,
  COUNCIL_EPOCH_DIR,
  COUNCIL_EPOCH_MB,
  COUNCIL_EPOCH_SHIP_MB,
  COUNCIL_EPOCH_WAIT_MS,
  COUNCIL_POOL_LINGER_MS,
  COUNCIL_POOL_READY_MS,
  COUNCIL_WORKERS,
  COUNCIL_WORKER_BASE_MB,
  COUNCIL_WORKER_REUSE,
} from '@shared/remote-kernels'
import type { CouncilPool, CouncilRun } from '@shared/protocol'
import { CLASS_PLACEMENT_DEFAULT, type ClassPlacement } from '@shared/admin'
import { findCell, isCellCouncil } from '@shared/notebook'
import { getSessionDoc, onlineCount, peekSessionDoc } from '../collab/index.js'
import { instanceTimeZone } from '../time-zone.js'
import { remoteBootAt } from '../competitions/remote/heard.js'
import {
  COUNCIL_REPORT_KEY,
  councilEnterSource,
  councilLeftWords,
  epochFiles,
  exportDropExpression,
  exportExpression,
  loadExpression,
  parseCouncilReport,
  parseExitReport,
  parseExportReport,
  parseSeedReport,
} from './council-isolation.js'
import { kernelBackend } from './runtime-client.js'
import { classPlacement, livePlacement } from './remote/placement-store.js'
import {
  artifactsWithinCaps,
  askCollect,
  bytesMissingOn,
  dropCollects,
  dropHomeExport,
  epochFailureOn,
  epochFileList,
  epochFilesWithinContract,
  epochIncarnation,
  epochNamed,
  epochOf,
  epochOnMachine,
  epochsHeardFrom,
  epochsOf,
  forgetClassEpochs,
  ingestHomeExport,
  nextEpochSeq,
  onEpochMachineHeard,
  onEpochNews,
  recordEpoch,
  storeLacks,
  touchEpochStore,
  wantEpoch,
  type Epoch,
  type EpochFiles,
  type EpochSource,
  type EpochTrouble,
} from './remote/epochs.js'
import {
  councilStartWords,
  councilWorker,
  councilWorkerExecute,
  giveCouncilWorker,
  mainKernelOf,
  onKernelMachineChange,
  recycleCouncilWorker,
  releaseCouncilItem,
  requestEpochExport,
  requeueCouncilShared,
  retireCouncilWorker,
  slotViewOf,
  startCouncilWorker,
  stopCouncilSlot,
  tellCouncilItem,
  useCouncilPool,
  workerState,
  type AttemptEnd,
  type CouncilPoolHooks,
  type KernelQueueItem,
  type WorkerHandle,
} from './index.js'

/* ---------------------------------------------------------------- numbers */

const MB = 1024 * 1024
/** How often a live pool looks at itself: growth (§9.5: by 2 every 5 s), the shrink's minute, the console's 60 s, the linger. */
const TICK_MS = 5_000
const GROW_STEP = 2
/** An empty queue this long, and the pool sheds a worker a minute, down to COUNCIL_WORKERS.min. */
const SHRINK_AFTER_MS = 3 * 60_000
const SHRINK_EVERY_MS = 60_000
/** A worker that did not come up, or would not load, is tried again no sooner than this. */
const RETRY_MS = 30_000
/** How long the attempts of a pool whose machine went wait for those that were computing there to come back first. */
const DRAIN_MS = 2_000
/** At most this many workers reload at once when the epoch changes (§9.5 «rolls»). */
const RESEED_AT_ONCE = 2
/** The council container's room beyond its workers and the epoch's buffers (§9.5). */
const POOL_EXTRA_MB = 512
/** The teacher's runs remembered per notebook: what «без ячеек 8–9» names. */
const RUNS_KEPT = 500

/* ------------------------------------------------------- the Python side */

/**
 * What the pool asks of the hidden module's export and load
 * (kernel/council-isolation.ts, §9.3): the silent runs and the reports they
 * answer with. One seam, so that the pool knows the Python by these names
 * alone, and a suite answers it with its fake kernel.
 */
export interface EpochPython {
  /**
   * The export's silent run in the notebook's kernel: into `out`
   * (COUNCIL_EPOCH_DIR/<seq>), within `budgetBytes`; `full` writes every
   * buffer again (the collector lost one the export would reuse), and
   * `workspace` is the class folder inside the kernel's container.
   */
  exportRun(input: { seq: number; out: string; budgetBytes: number; mainRuns: number; full: boolean; workspace: string }): { source: string; expressions: Record<string, string>; key: string }
  /** Its report: null — none, or one that did not hold. */
  exportReport(raw: unknown): ExportReport | null
  /** A silent run in the notebook's kernel that removes its export COUNCIL_EPOCH_DIR/<seq>, which nobody will read (dropMachineExport). */
  dropRun(seq: number): { source: string; expressions: Record<string, string> }
  /** A worker's load of an epoch (`/colloq/epochs/<sha>`), within its ceiling. */
  loadRun(input: { manifest: string; body: string; capMb: number; threads: number; workspace: string }): { source: string; expressions: Record<string, string>; key: string }
  /** Whether the load held. */
  loadReport(raw: unknown): { ok: boolean; error: string | null } | null
  /**
   * A worker's entry for one attempt: today's, with the three inputs only a
   * worker's takes (§9.4, §9.7) — the attempt's text (`_colloq_needs`), its
   * run's id (its folder, /colloq/scratch/<runId>) and its ceiling — and the
   * class folder its folder's skeleton is made from.
   */
  entrySource(input: { budgetBytes: number; memoryGuard: boolean; source: string; runId: string; capMb: number; workspace: string }): string
  /** Of the entry's report: a name the attempt reads that the epoch left behind, and why; null — none. */
  entryNeeds(raw: unknown): { name: string; why: string } | null
  /**
   * Of the exit's report: the regular files new in the attempt's folder (a
   * sha256 for those within COUNCIL_ARTIFACTS, which are the ones to bring
   * home), and how much private memory the attempts left the worker holding
   * beyond its seed, MB (§9.3 detail 4).
   */
  leaveReport(raw: unknown): { files: Array<{ name: string; sha256: string | null; bytes: number }>; dirtyMb: number | null }
}

/** What the export reports (§9.3): its files by sha, what it carried, what it left and why, and whether it held. */
export interface ExportReport {
  ok: boolean
  error: string | null
  files: EpochFiles | null
  carried: string[]
  left: Array<{ name: string; why: string }>
}

/** The hidden module's own export, load, entry and exit (kernel/council-isolation.ts, §9.3–9.7): the pool's, unless a suite brings its own. */
export const KERNEL_PYTHON: EpochPython = {
  exportRun: ({ seq, out, budgetBytes, mainRuns, full, workspace }) => {
    const run = exportExpression({ seq, mainRuns, budgetBytes, dir: out, full, workspace })
    return { source: run.code, expressions: run.userExpressions, key: COUNCIL_REPORT_KEY }
  },
  exportReport: (raw) => {
    const report = parseExportReport(raw)
    if (!report) return null
    // The stream is a file among the buffers, as the contract carries it (RemoteEpochIntent.buffers).
    const files = report.manifest !== null && report.body !== null
      ? { manifest: { sha256: report.manifest, bytes: report.manifestBytes }, body: report.body, buffers: epochFiles(report) }
      : null
    return { ok: report.ok, error: report.error, files, carried: report.carried, left: report.left }
  },
  dropRun: (seq) => {
    const run = exportDropExpression(seq)
    return { source: run.code, expressions: run.userExpressions }
  },
  loadRun: ({ manifest, body, threads, workspace }) => {
    const run = loadExpression({ manifest, body, threads, workspace })
    return { source: run.code, expressions: run.userExpressions, key: COUNCIL_REPORT_KEY }
  },
  loadReport: (raw) => {
    const report = parseSeedReport(raw)
    return report ? { ok: report.ok, error: report.error } : null
  },
  entrySource: ({ budgetBytes, memoryGuard, source, runId, capMb, workspace }) =>
    councilEnterSource(budgetBytes, { memoryGuard, source, runId, capMb, workspace }),
  entryNeeds: (raw) => parseCouncilReport(raw)?.needs[0] ?? null,
  leaveReport: (raw) => {
    const report = parseExitReport(raw)
    if (!report) return { files: [], dirtyMb: null }
    return {
      files: report.files.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes })),
      // Measured against the seed: the epoch's own objects are the worker's baseline, not its dirt.
      dirtyMb: report.grown === null ? null : report.grown / MB,
    }
  },
}

let python: EpochPython = KERNEL_PYTHON

/** For tests: what the pool asks of the Python side (null — the hidden module's own). */
export function useEpochPython(next: EpochPython | null): void {
  python = next ?? KERNEL_PYTHON
}

/** The class folder inside each of its containers (kernel/room-spec.ts mounts it there for every role). */
function workspaceOf(sessionId: string): string {
  return `/workspace/${sessionId}`
}

/* --------------------------------------------------------------- seams */

/** The pool's clock: its timers, the five seconds of D8, the minutes of the shrink. The process's, unless a suite moves one by hand. */
export interface PoolClock {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const PROCESS_CLOCK: PoolClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

let clock: PoolClock = PROCESS_CLOCK

/** For tests: the pool's clock (null — the process's). */
export function usePoolClock(next: PoolClock | null): void {
  clock = next ?? PROCESS_CLOCK
}

/** Where the class's council computes and how big its pool may be: the class's setting, or a suite's word. */
let settingOf: (sessionId: string) => Pick<ClassPlacement, 'council' | 'workers' | 'attemptMb'> = (sessionId) => {
  try {
    return classPlacement(sessionId)
  } catch {
    // No class row (a test, a room being deleted): the council computes where it always did.
    return CLASS_PLACEMENT_DEFAULT
  }
}

/** How many are in the class's room now: what `auto` sizes the pool by (§9.5). */
let onlineOf: (sessionId: string) => number = onlineCount

/** For tests: the room's head count as the pool reads it (null — the room's sockets). */
export function usePoolOnline(next: ((sessionId: string) => number) | null): void {
  onlineOf = next ?? onlineCount
}

/** For tests: the class's council setting as the pool reads it (null — the stored one). */
export function usePoolSetting(next: ((sessionId: string) => Pick<ClassPlacement, 'council' | 'workers' | 'attemptMb'>) | null): void {
  settingOf = next ?? ((sessionId) => {
    try {
      return classPlacement(sessionId)
    } catch {
      return CLASS_PLACEMENT_DEFAULT
    }
  })
}

/**
 * The council container's room on its machine, for sizing (§9.5): what it
 * has, and what the machine has free beside it. Read from the placement
 * module, loaded lazily (it reaches the machines' router); a suite stands
 * its own in.
 */
export interface PoolRoom {
  room(sessionId: string): Promise<{ memoryMb: number; freeMb: number } | null>
  /** The container's numbers, and its pools' workers together (the placement's `workers`, which the panel names). */
  resize(sessionId: string, memoryMb: number, cpus: number, workers: number): Promise<'applied' | 'pending' | 'failed'>
  /**
   * The council container was ready before this life of the server: a
   * worker's kernel started in it now may be a previous life's, re-attached
   * by its session's path, holding an epoch this life knows nothing of
   * (§9.10).
   */
  readyBefore(sessionId: string): boolean
}

const PLACEMENT_ROOM: PoolRoom = {
  room: async (sessionId) => (await import('./remote/placement.js')).poolRoom(sessionId),
  resize: async (sessionId, memoryMb, cpus, workers) => (await import('./remote/placement.js')).machineKernels.resize(sessionId, 'council', { memoryMb, cpus, workers }),
  readyBefore: (sessionId) => {
    const row = livePlacement(sessionId, 'council')
    return row !== null && row.readyAt !== null && row.readyAt < remoteBootAt()
  },
}

let roomOf: PoolRoom = PLACEMENT_ROOM

/** For tests: the council container's room and resize (null — the placement module's). */
export function usePoolRoom(next: PoolRoom | null): void {
  roomOf = next ?? PLACEMENT_ROOM
}

/* ---------------------------------------------------------------- state */

interface Worker {
  n: number
  handle: WorkerHandle
  /** The epoch it holds, by seq; null — none yet, or not known (a fresh start, a recycle). */
  seeded: number | null
  /** Attempts it served since it was loaded. */
  served: number
  /** Starting, loading or being recycled: given nothing meanwhile. */
  preparing: Promise<void> | null
  /** It would not come up or load: why, and when it is tried again. */
  broken: { why: string; until: number } | null
  /** Recycle before it serves again. */
  recycle: boolean
  /** Its kernel may be a previous life's of this server, re-attached by its path: recycled before it serves (§9.10). */
  inherited: boolean
  /** It was started in this life already: a later start is a new kernel (its machine went, it died), never a previous life's. */
  startedOnce: boolean
}

interface Pool {
  sessionId: string
  root: string
  /** Council cells of the notebook open now: the pool lingers COUNCIL_POOL_LINGER_MS after the last closes. */
  open: Set<string>
  /** Attempts waiting for a worker: the teacher's first (D12), each in the order pressed. */
  queue: KernelQueueItem[]
  workers: Map<number, Worker>
  /** How many workers it is to have now. */
  size: number
  /** The size a growth is asking its container for, until the machine answers: another pool of the class sizing meanwhile counts it. */
  sizing: number | null
  /** A refreeze in flight (one at a time, D8), the epoch number it will be, and when it was asked. */
  refreezing: { seq: number; since: number; done: Promise<void> } | null
  /**
   * «Обновить состояние» (or an opening) pressed while a refreeze was in
   * flight: once it is done, another is taken if the teacher ran cells after
   * it was asked (a home export's copy-out may take its while, and cells run
   * meanwhile).
   */
  again: boolean
  /** A dispatch that waited for an epoch, by its seq, and until when: never waited twice for one. */
  wait: { seq: number; until: number } | null
  /**
   * Epochs judged too big to ship to the pool's machine (COUNCIL_EPOCH_SHIP_MB,
   * §9.2), by seq, with the machine they were judged against: a verdict of
   * that machine's alone, kept in memory (another machine, or this one
   * holding more by then, judges anew).
   */
  tooBig: Map<number, string>
  /**
   * The newest epoch was given up on the pool's machine (its files did not
   * check out there, or its export was not where it was said to be): the
   * next look takes one fresh export, every buffer written again, whatever
   * the count of the teacher's runs — once per that count and machine
   * (`fullRetryKey`), so a machine that keeps failing is not fed exports.
   */
  retryFull: boolean
  fullRetryKey: string | null
  /** The count of the teacher's runs the last refreeze was asked at: the automatic one asks once per count (D8). */
  askedRuns: number | null
  /** The teacher's runs and the pool's machine at the last refreeze: one with no epoch to run asks once per change of either (maybeRefreeze). */
  autoKey: string | null
  /** The machine of the class's council placement, as last seen. */
  machine: { runnerId: string; name: string; gen: number } | null
  /** Its machine went: the waiting attempts go to the notebook's kernel once the workers' attempts have come back (or after DRAIN_MS). */
  draining: { words: string; timer: unknown } | null
  /** Why the pool cannot take attempts now, in the room's words: null — nothing to say. */
  trouble: string | null
  /** When an attempt first found the pool not ready: past COUNCIL_POOL_READY_MS the console says «пул не поднялся». */
  waitingSince: number | null
  /** Since when its queue has been empty, and when it last shed a worker. */
  emptySince: number | null
  shedAt: number
  /** When its last open council closed: it stops COUNCIL_POOL_LINGER_MS after. */
  closedAt: number | null
  /** When the next start of a worker may be tried after a failure. */
  retryAt: number
  /**
   * The next export writes every buffer again: an epoch did not come
   * together where it was collected, and an export reuses the buffers whose
   * place, size and checksum match its previous one (§9.3), which that
   * collector may be the one that lost.
   */
  full: boolean
  timer: unknown
  dispatchQueued: boolean
  waitTimer: unknown
  stopped: boolean
}

const pools = new Map<string, Pool>()
const poolKey = (sessionId: string, root: string): string => `${sessionId}\0${root}`

/** Exports on machines whose removal was asked of their kernels (dropMachineExport), by class, notebook and number: asked once. */
const exportsDropped = new Set<string>()

/** The teacher's runs of each notebook in this life, numbered: an epoch says how many it had, its cards which it lacks. */
const runs = new Map<string, { count: number; log: Array<{ n: number; cellId: string }> }>()

const listeners = new Set<(sessionId: string) => void>()

/** The console's frame about a notebook's pool is due (control.ts · nudgeKernel): something of it changed. */
export function onPoolChange(listener: (sessionId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function changed(pool: Pool): void {
  for (const listener of [...listeners]) {
    try {
      listener(pool.sessionId)
    } catch (error) {
      console.error(`[council ${pool.sessionId}] a pool listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/* --------------------------------------------------------------- words */

/** «14:05»: when an epoch was taken, as the room's clock says it. */
function clockTime(at: number): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: instanceTimeZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
  } catch {
    return new Date(at).toISOString().slice(11, 16)
  }
}

/** «8–9», «3, 5–7»: cell numbers as the room's margin draws them, runs of them joined. */
export function cellRanges(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]))
    i = j
  }
  return parts.join(', ')
}

/** Why the pool cannot take attempts, in the words a card's footnote and the console read. */
function troubleWords(trouble: EpochTrouble | 'machine' | 'lost' | 'worker', detail?: string): string {
  switch (trouble) {
    case 'cuda':
      return tr('server.theNotebookSStateHoldsDataOn.2ac2bc')
    case 'over':
      return tr('server.theNotebookSStateDoesNotFit.c67b68')
    case 'failed':
      return tr('server.theNotebookSStateCouldNotBe.9e7101')
    case 'machine':
      return detail ? tr('server.thePoolDidNotStart.80644c', { why: detail }) : tr('server.theCouncilPoolRunsOnlyOnMachines.ef5702')
    case 'lost':
      return tr('server.thePoolSMachineWasLostThe.8aff4c')
    case 'worker':
      return tr('server.aPoolWorkerDidNotStartThe.4ecf00')
  }
}

/**
 * A worker that would not come up or load, said in the room's words (rule:
 * user-facing words go through the locales): the English detail is the
 * log's, the card and the console read `words`.
 */
class WorkerTrouble extends Error {
  constructor(
    message: string,
    readonly words: string,
  ) {
    super(message)
    this.name = 'WorkerTrouble'
  }
}

/**
 * What «Пул не поднялся: …» says of a worker's failure (§9.9): the
 * placement's own words for its council slot — «Пул консилиума бывает
 * только на машинах.» when no machine takes it, a machine that does not
 * answer — with a machine's name left to staff (kernel/index.ts ·
 * councilStartWords); the pool's own when it is this server's error.
 */
function poolWhy(sessionId: string, error: unknown): string {
  if (error instanceof WorkerTrouble) return error.words
  return councilStartWords(sessionId, error) ?? tr('server.itsWorkersDidNotStart.f8a286')
}

/* ------------------------------------------------------------- the pools */

/**
 * Whether the class's council computes on machines: everything here is for
 * such a class alone. Never under the runtime broker, whose classes keep
 * their Pods and never go to machines (D26), whatever a class's stored
 * setting says.
 */
function poolClass(sessionId: string): boolean {
  if (kernelBackend() === 'broker') return false
  return settingOf(sessionId).council === 'machines'
}

function poolOf(sessionId: string, root: string): Pool | undefined {
  return pools.get(poolKey(sessionId, root))
}

/** A notebook's pool, made on its first need: its workers start (§9.5), and an epoch is taken when it has none it may use. */
function ensurePool(sessionId: string, root: string): Pool {
  const key = poolKey(sessionId, root)
  let pool = pools.get(key)
  if (pool && !pool.stopped) return pool
  pool = {
    sessionId,
    root,
    open: new Set(),
    queue: [],
    workers: new Map(),
    size: 0,
    sizing: null,
    refreezing: null,
    again: false,
    wait: null,
    tooBig: new Map(),
    retryFull: false,
    fullRetryKey: null,
    askedRuns: null,
    autoKey: null,
    machine: null,
    draining: null,
    trouble: null,
    waitingSince: null,
    emptySince: clock.now(),
    shedAt: clock.now(),
    closedAt: null,
    retryAt: 0,
    full: false,
    timer: null,
    dispatchQueued: false,
    waitTimer: null,
    stopped: false,
  }
  pools.set(key, pool)
  const setting = settingOf(sessionId)
  pool.size = setting.workers === 'auto' ? Math.min(4, autoCap(pool, null)) : clampWorkers(setting.workers)
  noteMachine(pool)
  startWorkers(pool)
  if (!standingEpoch(pool)) refreeze(pool)
  else want(pool)
  arm(pool)
  return pool
}

function clampWorkers(count: number): number {
  return Math.min(COUNCIL_WORKERS.max, Math.max(1, Math.floor(count)))
}

/** auto = ceil(online / 3) within COUNCIL_WORKERS.min and min(COUNCIL_WORKERS.auto, what fits): `fit` null when the machine's room is not known. */
function autoCap(pool: Pool, fit: number | null): number {
  const online = (() => {
    try {
      return onlineOf(pool.sessionId)
    } catch {
      return 0
    }
  })()
  const top = Math.min(COUNCIL_WORKERS.auto, fit ?? COUNCIL_WORKERS.auto)
  return Math.max(COUNCIL_WORKERS.min, Math.min(top, Math.ceil(online / 3)))
}

/** «Память на попытку», MB: each worker's ceiling (D33), mandatory for them. */
function attemptMbOf(pool: Pool): number {
  const mb = settingOf(pool.sessionId).attemptMb
  return Number.isInteger(mb) && mb > 0 ? mb : COUNCIL_ATTEMPT_MB
}

function arm(pool: Pool): void {
  if (pool.timer !== null || pool.stopped) return
  pool.timer = clock.setTimeout(() => {
    pool.timer = null
    void tick(pool).finally(() => arm(pool))
  }, TICK_MS)
}

/** The pool goes: its workers' kernels with it, and the attempts still waiting go to the notebook's kernel. */
async function stopPool(pool: Pool, why: 'linger' | 'closed'): Promise<void> {
  if (pool.stopped) return
  pool.stopped = true
  if (pool.timer !== null) clock.clearTimeout(pool.timer)
  if (pool.waitTimer !== null) clock.clearTimeout(pool.waitTimer)
  if (pool.draining) clock.clearTimeout(pool.draining.timer)
  pool.draining = null
  pool.timer = null
  pools.delete(poolKey(pool.sessionId, pool.root))
  wantEpoch(pool.sessionId, pool.root, null)
  if (why === 'linger') for (const item of pool.queue.splice(0)) requeueCouncilShared(pool.sessionId, pool.root, item, null)
  else for (const item of pool.queue.splice(0)) releaseCouncilItem(pool.sessionId, item)
  console.log(`[council ${pool.sessionId}/${pool.root}] the pool stops (${why})`)
  if (why === 'linger') {
    await Promise.allSettled([...pool.workers.values()].map((worker) => retireCouncilWorker(worker.handle)))
    /*
     * The council container goes with the class's last pool (§9.5), and the
     * machine's ledger holds nothing for it after; a pool of another notebook
     * of the class keeps it, at that pool's size (the next pool places it
     * again). The class's own stop removes it with the rest of its kernels.
     */
    if (poolsOf(pool.sessionId).length === 0) {
      if (stopCouncilSlot(pool.sessionId)) containerAsked.delete(pool.sessionId)
    } else void fitContainer(pool.sessionId)
  }
  pool.workers.clear()
  changed(pool)
}

/* -------------------------------------------------------- the machine */

/** The machine of the class's council placement, as the placement says it now; whether it changed. */
function noteMachine(pool: Pool): boolean {
  const view = slotViewOf(pool.sessionId, 'council')
  const machine = view.where === 'machine' ? { runnerId: view.runnerId, name: view.name, gen: view.gen } : null
  const before = pool.machine
  pool.machine = machine
  return before?.runnerId !== machine?.runnerId || before?.gen !== machine?.gen
}

/** The council placement answers: ready on its machine, its road up. */
function machineReady(pool: Pool): boolean {
  const view = slotViewOf(pool.sessionId, 'council')
  return view.where === 'machine' && view.state === 'ready' && (view.link === null || view.link.up)
}

/**
 * The council placement's machine does not answer (or its placement is being
 * stopped): not a road's blink, but what the placement calls a machine away
 * (§9.9 «the pool's machine is unreachable»). Lost is another matter
 * (machineNews · drain).
 */
function machineAway(pool: Pool): boolean {
  const view = slotViewOf(pool.sessionId, 'council')
  return view.where === 'machine' && (view.state === 'unreachable' || view.state === 'stopping')
}

/**
 * The attempts waiting in the pool go to the notebook's kernel, keeping their
 * place (requeueCouncilShared), their cards saying why: nothing will take
 * them here — the machine does not answer, no epoch it may use is left — and
 * the presses after them already go there (§9.9).
 */
function strand(pool: Pool, words: string): void {
  if (pool.queue.length === 0) return
  console.warn(`[council ${pool.sessionId}/${pool.root}] ${pool.queue.length} waiting attempt(s) go to the notebook's kernel: ${words}`)
  for (const item of pool.queue.splice(0)) requeueCouncilShared(pool.sessionId, pool.root, item, words)
  pool.emptySince ??= clock.now()
  changed(pool)
}

/**
 * News of the class's council placement (kernel/index.ts · onKernelMachineChange):
 * away, its waiting attempts go to the notebook's kernel keeping their place,
 * as later presses do (those computing there wait for it); lost or gone, the
 * same once the workers' attempts are back, and its workers start again
 * wherever the slot is placed next; back or ready, the queue moves on.
 */
function machineNews(sessionId: string): void {
  for (const pool of [...pools.values()]) {
    if (pool.sessionId !== sessionId || pool.stopped) continue
    const before = pool.machine
    if (!noteMachine(pool)) {
      if (machineAway(pool)) strand(pool, tr('server.thePoolSMachineDoesNotAnswer.16922d'))
      schedule(pool)
      changed(pool)
      continue
    }
    // Another machine, or the same placed anew: a worker that failed there, or the pool as a whole, is tried at once here.
    for (const worker of pool.workers.values()) worker.broken = null
    pool.trouble = null
    pool.retryAt = 0
    if (before !== null) {
      // The placement left that machine: what it held there is gone with it (its kernels were ended from outside).
      console.warn(`[council ${pool.sessionId}/${pool.root}] the pool's machine ${before.runnerId} (gen ${before.gen}) is gone`)
      dropCollects(pool.sessionId, before.runnerId)
      for (const worker of pool.workers.values()) {
        worker.seeded = null
        worker.inherited = false
        worker.recycle = false
      }
      pool.waitingSince = null
      /*
       * What waits goes to the notebook's kernel keeping its place, behind
       * what was computing on the workers: those come back from their
       * kernels' end to run there once more (D15), and were pressed first.
       * So the queue goes once no worker computes any more.
       */
      if (pool.draining === null) {
        const timer = clock.setTimeout(() => drain(pool), DRAIN_MS)
        pool.draining = { words: troubleWords('lost'), timer }
      }
      if (![...pool.workers.values()].some((worker) => workerState(worker.handle).computing)) drain(pool)
    }
    if (pool.machine !== null) {
      // Placed (again): the epoch that can reach that machine, or a fresh one when none can.
      if (!standingEpoch(pool)) refreeze(pool)
      else want(pool)
    }
    startWorkers(pool)
    schedule(pool)
    changed(pool)
  }
}

/** The waiting attempts of a pool whose machine went, to the notebook's kernel (machineNews). */
function drain(pool: Pool): void {
  const draining = pool.draining
  if (!draining) return
  pool.draining = null
  clock.clearTimeout(draining.timer)
  for (const item of pool.queue.splice(0)) requeueCouncilShared(pool.sessionId, pool.root, item, draining.words)
  if (pool.queue.length === 0) pool.emptySince ??= clock.now()
  schedule(pool)
  changed(pool)
}

/* ------------------------------------------------------------- the epoch */

function runsOf(sessionId: string, root: string): { count: number; log: Array<{ n: number; cellId: string }> } {
  const key = poolKey(sessionId, root)
  let entry = runs.get(key)
  if (!entry) runs.set(key, (entry = { count: 0, log: [] }))
  return entry
}

/** A history run of the notebook (§9.2 «Automatically»): a cell's execute that stores history, whoever pressed. */
function historyRun(sessionId: string, root: string, cellId: string): void {
  const entry = runsOf(sessionId, root)
  entry.count += 1
  entry.log.push({ n: entry.count, cellId })
  if (entry.log.length > RUNS_KEPT) entry.log.splice(0, entry.log.length - RUNS_KEPT)
  const pool = poolOf(sessionId, root)
  if (pool) changed(pool)
}

/**
 * The notebook's kernel lost its Python (kernel/index.ts · onPhase), or the
 * class's kernels were stopped (closed): the runs before no longer make an
 * epoch stale — none of their state is in any kernel now, while the epoch
 * still holds what it took (§9.0: «Перезапуск ядра тетради снимок не
 * стирает: попытки считаются на прежнем, пока преподаватель снова не
 * выполнит ячейки»). The count goes on, so that every epoch's count stays
 * comparable within this life; `keep`, a cell about to run on the fresh
 * kernel, keeps its run.
 */
function mainReset(sessionId: string, root: string, keep: string | null): void {
  const entry = runs.get(poolKey(sessionId, root))
  if (!entry || entry.log.length === 0) return
  const last = entry.log.at(-1)!
  entry.log = keep !== null && last.cellId === keep ? [last] : []
  const pool = poolOf(sessionId, root)
  if (pool) changed(pool)
}

/** The teacher's runs since an epoch: those of this life after its count; all of this life for one taken in another (§9.2). */
function sinceEpoch(epoch: Epoch): Array<{ n: number; cellId: string }> {
  const entry = runsOf(epoch.sessionId, epoch.root)
  if (epoch.incarnation !== epochIncarnation()) return entry.log
  return entry.log.filter((run) => run.n > epoch.mainRuns)
}

function behindOf(epoch: Epoch): number {
  return sinceEpoch(epoch).length
}

/** «Состояние 14:05 — без ячеек 8–9.»: the cells the teacher ran since the epoch, by their numbers in the notebook. */
function olderWords(epoch: Epoch): string | undefined {
  const since = sinceEpoch(epoch)
  if (since.length === 0) return undefined
  let numbers: number[] = []
  try {
    const { doc } = getSessionDoc(epoch.sessionId)
    numbers = since.flatMap((run) => {
      const found = findCell(doc, run.cellId)
      return found ? [found.index + 1] : []
    })
  } catch {
    numbers = []
  }
  const cells = cellRanges(numbers)
  const time = clockTime(epoch.at)
  if (cells === '') return tr('server.stateAsOfWithoutCells.44aa0a', { time, cells: '?' })
  return tr(new Set(numbers).size === 1 ? 'server.stateAsOfWithoutCell.30d8e4' : 'server.stateAsOfWithoutCells.44aa0a', { time, cells })
}

/**
 * The epoch the pool's workers run: the newest of the notebook with no
 * trouble that its machine holds whole (an empty one needs nothing).
 */
function usableEpoch(pool: Pool): Epoch | null {
  if (!pool.machine) return null
  for (const epoch of epochsOf(pool.sessionId, pool.root)) {
    if (epoch.trouble !== null) continue
    if (epochOnMachine(pool.machine.runnerId, epoch) === 'ready') return epoch
  }
  return null
}

/**
 * The newest epoch of the notebook that may reach the pool's machine: the
 * machine is told to hold it (epochs.ts · wantEpoch). One that would ship
 * past COUNCIL_EPOCH_SHIP_MB there is judged too big for that machine, and
 * the one before it stays (§9.2 «A refresh over them keeps the previous
 * epoch»); before the machine's first sync of this life nothing is judged —
 * what it holds is unknown until then (a restart of this server forgets it)
 * — and nothing that could pass the cap is asked of it.
 */
function want(pool: Pool): void {
  if (!pool.machine || pool.stopped || pools.get(poolKey(pool.sessionId, pool.root)) !== pool) return
  const runner = pool.machine.runnerId
  const newest = epochsOf(pool.sessionId, pool.root)[0]
  for (const epoch of epochsOf(pool.sessionId, pool.root)) {
    if (epoch.trouble !== null) continue
    const state = epochOnMachine(runner, epoch)
    const away = lostAtSource(pool, epoch)
    if (state === 'failed' || away) {
      if (epoch.seq === newest?.seq) {
        // Given up there, or where its export lay: the next export writes every buffer again, whatever it could reuse.
        pool.full = true
        // Taken anew once (maybeRefreeze), unless the machine's disk is what failed: it tries again by itself.
        if ((away || epochFailureOn(runner, epoch) !== 'disk') && pool.fullRetryKey !== autoKeyOf(pool)) pool.retryFull = true
      }
      continue
    }
    if (!mayReach(pool, epoch)) continue
    if (state !== 'ready' && epoch.files && !sameMachine(epoch.source, runner)) {
      const heard = epochsHeardFrom(runner)
      const ship = heard ? bytesMissingOn(runner, epoch.files) : epochBytes(epoch.files)
      if (ship > COUNCIL_EPOCH_SHIP_MB * MB) {
        if (!heard) {
          wantEpoch(pool.sessionId, pool.root, null)
          return
        }
        if (pool.tooBig.get(epoch.seq) !== runner) {
          console.warn(`[council ${pool.sessionId}/${pool.root}] epoch ${epoch.seq} would ship ${Math.round(ship / MB)} MB to its machine: the previous one stays`)
          if (epoch.source !== 'home') {
            /*
             * Its export lies in a container on another machine, which no
             * reply will now ask to read it: its folder goes, and the next
             * export writes every buffer again — the kernel's own table of
             * them is this export's, whose files reach nobody.
             */
            pool.full = true
            dropMachineExport(pool, epoch)
          }
        }
        pool.tooBig.set(epoch.seq, runner)
        continue
      }
    }
    pool.tooBig.delete(epoch.seq)
    wantEpoch(pool.sessionId, pool.root, { runnerId: runner, seq: epoch.seq })
    dropSuperseded(pool, epoch.seq)
    return
  }
  wantEpoch(pool.sessionId, pool.root, null)
}

function epochBytes(files: EpochFiles): number {
  return epochFileList(files).reduce((sum, file) => sum + file.bytes, 0)
}

/** Judged too big to ship to the pool's machine as it stands now (want). */
function tooBig(pool: Pool, epoch: Epoch): boolean {
  return pool.machine !== null && pool.tooBig.get(epoch.seq) === pool.machine.runnerId
}

function sameMachine(source: EpochSource, runnerId: string): boolean {
  return source !== 'home' && source.runnerId === runnerId
}

/**
 * Whether the machine whose container held an epoch's export gave it up
 * (epochs.ts · epochFailureOn: the folder was not there, docker would not
 * copy it, its files were not what the report said) before this server had
 * every file of it: a pool on another machine can get it from nowhere now.
 * A full disk there is no verdict: that machine tries again by itself.
 */
function lostAtSource(pool: Pool, epoch: Epoch): boolean {
  if (epoch.source === 'home' || !epoch.files || (pool.machine !== null && epoch.source.runnerId === pool.machine.runnerId)) return false
  const failure = epochFailureOn(epoch.source.runnerId, epoch)
  return (failure === 'source' || failure === 'files') && storeLacks(pool.sessionId, epoch.files).length > 0
}

/**
 * An export lying in a container on a machine that no reply will ask to
 * read (§9.2): one that cannot be the pool's, one too big to ship, one a
 * refreeze superseded before any reply named it. Its own kernel removes the
 * folder, by a silent service run between the teacher's cells — the agent
 * reads and removes only what home names, and this server reaches no
 * container on a machine. Only while the notebook's kernel still lives in
 * that very container, at that gen: a container gone took the folder with
 * it. One that ended after its pool stopped stays: the next pool may still
 * have it read.
 */
function dropMachineExport(pool: Pick<Pool, 'sessionId' | 'root'>, epoch: Pick<Epoch, 'seq' | 'source'>): void {
  const source = epoch.source
  if (source === 'home') return
  const key = `${pool.sessionId}\0${pool.root}\0${epoch.seq}`
  if (exportsDropped.has(key)) return
  const main = mainKernelOf(pool.sessionId, pool.root)
  if (main.where === null || main.where === 'home' || main.where.container !== source.container || main.where.gen !== source.gen) return
  exportsDropped.add(key)
  const run = python.dropRun(epoch.seq)
  const queued = requestEpochExport(pool.sessionId, pool.root, {
    kind: 'epoch',
    source: run.source,
    expressions: run.expressions,
    done: (answer) => {
      if ('refused' in answer) console.warn(`[council ${pool.sessionId}/${pool.root}] the export of epoch ${epoch.seq} stays in its container on machine ${source.runnerId} (${answer.refused})`)
    },
  })
  if (queued) console.log(`[council ${pool.sessionId}/${pool.root}] the export of epoch ${epoch.seq} is removed from its container on machine ${source.runnerId}: nothing will read it`)
}

/**
 * A refreeze (§9.2): a silent export of the notebook's kernel, as a service
 * item at the head of its own queue, so that it runs between the teacher's
 * cells and never under one; at most one in flight, and a press meanwhile
 * (`pressed`) is not lost (Pool.again). With no kernel the epoch is empty by
 * construction, and no kernel is started for it.
 */
function refreeze(pool: Pool, pressed = false): void {
  if (pool.stopped) return
  if (pool.refreezing) {
    if (pressed) pool.again = true
    return
  }
  const { sessionId, root } = pool
  const main = mainKernelOf(sessionId, root)
  if (!main.live && mayRunUnseen(pool, main)) {
    /*
     * The notebook's kernel may well be running, unknown to this life: a
     * restart of this server re-attaches it on its first need (§9.10). No
     * epoch is made up for it — an empty one would have the workers compute
     * on nothing while the kernel holds the teacher's state. Its first sign
     * of life takes one (maybeRefreeze), and attempts compute in it
     * meanwhile, the card saying the pool is still starting.
     */
    pool.autoKey = null
    changed(pool)
    return
  }
  const seq = nextEpochSeq(sessionId)
  const mainRuns = runsOf(sessionId, root).count
  pool.askedRuns = mainRuns
  pool.autoKey = autoKeyOf(pool)
  const since = clock.now()
  let settle: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  pool.refreezing = { seq, since, done }
  const finish = (): void => {
    if (pool.refreezing?.seq === seq) pool.refreezing = null
    settle()
    if (pool.stopped) return
    // A press while it was in flight, and the teacher's cells ran since it was asked: once more, for them.
    if (pool.again) {
      pool.again = false
      if (runsOf(sessionId, root).count !== mainRuns) refreeze(pool)
    }
    want(pool)
    schedule(pool)
    prepareIdle(pool)
    changed(pool)
  }
  if (!main.live) {
    /*
     * No live kernel to snapshot, and none to come: this life saw it end, or
     * never had one. The pool keeps the epoch it has (§9.10: the notebook's
     * kernel lost or restarted changes nothing here), or the one the registry
     * has that its machine may hold or fetch; one with none at all gets an
     * empty epoch, which is what a notebook with no kernel holds.
     */
    if (!standingEpoch(pool)) keepEmpty(pool, seq, mainRuns)
    finish()
    return
  }
  const run = python.exportRun({
    seq,
    out: `${COUNCIL_EPOCH_DIR}/${seq}`,
    budgetBytes: COUNCIL_EPOCH_MB * MB,
    mainRuns,
    full: pool.full || lostAtHome(pool, main.where),
    workspace: workspaceOf(sessionId),
  })
  pool.full = false
  const queued = requestEpochExport(sessionId, root, {
    kind: 'epoch',
    source: run.source,
    expressions: run.expressions,
    done: (answer) => {
      void accept(pool, seq, mainRuns, answer, run.key).catch((error: unknown) => {
        console.error(`[council ${sessionId}/${root}] epoch ${seq} could not be kept: ${errText(error)}`)
      }).finally(finish)
    },
  })
  if (!queued) {
    if (!standingEpoch(pool)) keepEmpty(pool, seq, mainRuns)
    finish()
  }
  changed(pool)
}

/**
 * Whether the notebook's kernel, not live in this life, may run all the same
 * (refreeze): not seen to end here, and either its slot placed on a machine
 * now or an epoch of a previous life of this server in the registry — its
 * kernel was up then, and a restart of this server leaves kernels running.
 */
function mayRunUnseen(pool: Pool, main: ReturnType<typeof mainKernelOf>): boolean {
  if (main.gone) return false
  if (livePlacement(pool.sessionId, main.role ?? 'room') !== null) return true
  return epochsOf(pool.sessionId, pool.root).some((epoch) => epoch.incarnation !== epochIncarnation())
}

/**
 * A kernel here whose last export's files this server's store no longer holds
 * whole (its LRU let them go): its next export writes every buffer again —
 * the kernel reuses the buffers of its previous export (§9.3), which the
 * store would then lack.
 */
function lostAtHome(pool: Pool, where: ReturnType<typeof mainKernelOf>['where']): boolean {
  if (where !== 'home') return false
  const last = epochsOf(pool.sessionId, pool.root).find((epoch) => epoch.files !== null && epoch.source === 'home')
  return last !== undefined && storeLacks(pool.sessionId, last.files).length > 0
}

/**
 * The newest epoch of the notebook the pool may still run: no trouble, not
 * too big to ship to its machine, and not given up there (it may be there,
 * or on its way).
 */
function standingEpoch(pool: Pool): Epoch | null {
  for (const epoch of epochsOf(pool.sessionId, pool.root)) {
    if (epoch.trouble !== null || tooBig(pool, epoch) || !mayReach(pool, epoch)) continue
    return epoch
  }
  return null
}

/**
 * Whether an epoch is, or can still get, on the pool's machine: there or on
 * its way; or its files here, whole (the store's LRU may have let them go);
 * or its export in a container on that machine; or in one of a live
 * placement of the class elsewhere, which ships it home (§9.2). An export
 * that lay on a machine since gone, or that its machine gave up
 * (lostAtSource), can come nowhere. Before the pool has a machine, any may.
 */
function mayReach(pool: Pool, epoch: Epoch): boolean {
  if (!pool.machine) return true
  const state = epochOnMachine(pool.machine.runnerId, epoch)
  if (state === 'ready' || state === 'fetching') return true
  if (state === 'failed') return false
  if (!epoch.files || (epoch.source !== 'home' && epoch.source.runnerId === pool.machine.runnerId)) return true
  if (storeLacks(pool.sessionId, epoch.files).length === 0) return true
  if (epoch.source === 'home' || lostAtSource(pool, epoch)) return false
  const row = livePlacement(pool.sessionId, epoch.source.role)
  return row !== null && row.runnerId === epoch.source.runnerId && row.gen === epoch.source.gen
}

/**
 * A refreeze nobody asked for, when the pool has no epoch it may run and
 * the notebook's kernel is live (§9.9 → §9.2): once per count of the
 * teacher's runs and machine of the pool, so that a state that cannot be the
 * pool's (data on the GPU, an export that fails) is not exported over and
 * over until something changes — a cell the teacher runs, a new machine,
 * «Обновить состояние» — and once more when its machine gave the newest up
 * (Pool.retryFull).
 */
function maybeRefreeze(pool: Pool): void {
  if (pool.stopped || pool.refreezing || standingEpoch(pool)) return
  if (!mainKernelOf(pool.sessionId, pool.root).live) return
  if (pool.retryFull) {
    pool.retryFull = false
    pool.fullRetryKey = autoKeyOf(pool)
    refreeze(pool)
    return
  }
  if (pool.autoKey === autoKeyOf(pool)) return
  refreeze(pool)
}

function autoKeyOf(pool: Pool): string {
  return `${runsOf(pool.sessionId, pool.root).count}|${pool.machine ? `${pool.machine.runnerId}:${pool.machine.gen}` : ''}`
}

/** An empty epoch: the notebook's kernel was not running, and the workers start from nothing, as a fresh kernel would. */
function keepEmpty(pool: Pool, seq: number, mainRuns: number): void {
  recordEpoch({
    sessionId: pool.sessionId, root: pool.root, seq, at: clock.now(), mainRuns, incarnation: epochIncarnation(),
    bytes: 0, shipBytes: 0, carried: [], left: [], files: null, source: 'home', trouble: null,
  })
}

/**
 * The export's answer: kept with its files where they are, and with its
 * trouble when it has one — data on the GPU (D11), past COUNCIL_EPOCH_MB,
 * not come together. Its files: here, copied out of the kernel's container
 * and checked; on a machine, left where they are for the agents. The folder
 * of one here that is not kept is removed all the same (§9.2).
 */
async function accept(
  pool: Pool,
  seq: number,
  mainRuns: number,
  answer: Parameters<Parameters<typeof requestEpochExport>[2]['done']>[0],
  key: string,
): Promise<void> {
  const { sessionId, root } = pool
  const at = clock.now()
  const base = { sessionId, root, seq, at, mainRuns, incarnation: epochIncarnation(), shipBytes: 0 }
  const main = mainKernelOf(sessionId, root)
  const here = main.where === 'home'
  const source: EpochSource = main.where !== null && main.where !== 'home' ? main.where : 'home'
  if ('refused' in answer) {
    /*
     * The kernel was gone by the time the export's turn came (`no-kernel`), or
     * the export went with the queue (a restart, a stop: `dropped`): the pool
     * keeps the epoch it has, and one with none gets an empty one. A run that
     * failed (interrupted, its answer lost on the road) did not come together,
     * and what it wrote goes — and may have been written whole, the kernel's
     * table of its buffers with it: the next export writes every one again.
     */
    if (answer.refused === 'failed') {
      recordEpoch({ ...base, bytes: 0, carried: [], left: [], files: null, source: 'home', trouble: 'failed' })
      pool.full = true
      if (here) await dropHomeExport(sessionId, main.role ?? 'room', seq)
      else dropMachineExport(pool, { seq, source })
    } else if (!standingEpoch(pool)) keepEmpty(pool, seq, mainRuns)
    return
  }
  const report = python.exportReport(answer.values[key])
  if (!report || !report.ok || (report.files !== null && !epochFilesWithinContract(report.files))) {
    console.warn(`[council ${sessionId}/${root}] epoch ${seq} did not come together${report?.error ? `: ${report.error}` : ''}`)
    recordEpoch({ ...base, bytes: 0, carried: report?.carried ?? [], left: report?.left ?? [], files: null, source, trouble: 'failed' })
    // A report that held, with files past the contract: written, and the kernel's table is theirs (a failed export removed its own).
    if (report?.ok) pool.full = true
    if (here) await dropHomeExport(sessionId, main.role ?? 'room', seq)
    else if (report?.ok) dropMachineExport(pool, { seq, source })
    return
  }
  const files = report.files
  const bytes = files ? [files.manifest, ...files.buffers].reduce((sum, file) => sum + file.bytes, 0) : 0
  let trouble: EpochTrouble | null = report.left.some((one) => one.why === 'cuda') ? 'cuda' : bytes > COUNCIL_EPOCH_MB * MB ? 'over' : null
  if (trouble === null && files !== null && source === 'home') {
    // Its kernel is here: the export comes out of its container into the store, every file checked against its sha.
    const role = main.role ?? 'room'
    if (!(await ingestHomeExport(sessionId, role, seq, files))) {
      trouble = 'failed'
      pool.full = true
    }
  } else if (trouble !== null && files !== null) {
    // Written, and never to be read (data on the GPU writes nothing): its folder goes, and the kernel's table of buffers with it.
    pool.full = true
    if (here) await dropHomeExport(sessionId, main.role ?? 'room', seq)
    else dropMachineExport(pool, { seq, source })
  }
  const runner = pool.machine?.runnerId ?? null
  const shipBytes = files && runner && !sameMachine(source, runner) ? bytesMissingOn(runner, files) : 0
  recordEpoch({ ...base, bytes, shipBytes, carried: report.carried, left: report.left, files, source, trouble })
  if (trouble !== null) console.warn(`[council ${sessionId}/${root}] epoch ${seq} cannot be the pool's: ${trouble}`)
}

/**
 * The exports on machines of epochs older than the one the pool's machine is
 * now to hold (want), that no reply ever named to a machine (epochs.ts ·
 * epochNamed): refreezes that followed each other faster than the machine
 * was told of them. Replies name the newer one from now on, so none of them
 * will be read, and their folders go. Of this life alone: what an earlier
 * one named is not known.
 */
function dropSuperseded(pool: Pool, seq: number): void {
  for (const older of epochsOf(pool.sessionId, pool.root)) {
    if (older.seq >= seq || !older.files || older.source === 'home' || older.incarnation !== epochIncarnation() || epochNamed(older)) continue
    dropMachineExport(pool, older)
  }
}

/* ------------------------------------------------------------- workers */

/** Start the workers the pool is to have, beside what it has: each its own kernel in the council container (§9.5). */
function startWorkers(pool: Pool): void {
  if (pool.stopped || clock.now() < pool.retryAt) return
  for (let n = 1; n <= pool.size; n++) {
    const known = pool.workers.get(n)
    if (known) {
      // Up, on its way, or tried too lately: left alone. One whose kernel went (its machine with it, a death) starts again.
      if (known.preparing || (known.broken && clock.now() < known.broken.until)) continue
      const state = workerState(known.handle)
      if (state.starting || state.computing) continue
      if (state.up) {
        // Up, its while over: what would not load may load now — a failure is tried again, never a verdict for good.
        if (known.broken) {
          known.broken = null
          prepare(pool, known)
        }
        continue
      }
    }
    const worker: Worker = known ?? { n, handle: councilWorker(pool.sessionId, pool.root, n), seeded: null, served: 0, preparing: null, broken: null, recycle: false, inherited: false, startedOnce: false }
    worker.broken = null
    pool.workers.set(n, worker)
    prepare(pool, worker)
  }
}

/**
 * Bring one worker up and load it with the pool's epoch, in the background.
 * Its kernel is one session of the council container; started there the
 * first time, the slot itself is placed on a machine (pool.ts · endpointForSession).
 */
function prepare(pool: Pool, worker: Worker): void {
  if (worker.preparing || pool.stopped) return
  worker.preparing = (async () => {
    try {
      const state = workerState(worker.handle)
      if (!state.up) {
        // The first start of this worker in this life, in a container that was ready before it: its Python may hold anything from before (§9.10).
        const first = !worker.startedOnce
        worker.startedOnce = true
        await startCouncilWorker(worker.handle)
        noteMachine(pool)
        worker.inherited = first && roomOf.readyBefore(pool.sessionId)
        worker.seeded = null
      }
      const epoch = usableEpoch(pool)
      if (epoch && (worker.seeded !== epoch.seq || worker.recycle || worker.inherited)) await seed(pool, worker, epoch)
      // Nothing to load yet: a worker due its recycle is cleaned all the same, and loads when an epoch comes.
      else if (!epoch && (worker.recycle || worker.inherited)) await recycleNow(worker)
    } catch (error) {
      // The room's words on the card and the console; the detail in the log.
      const why = poolWhy(pool.sessionId, error)
      worker.broken = { why, until: clock.now() + RETRY_MS }
      console.warn(`[council ${pool.sessionId}/${pool.root}] worker ${worker.n} did not come up: ${errText(error)}`)
      if ([...pool.workers.values()].every((one) => one.broken !== null)) {
        pool.trouble = troubleWords('machine', why)
        pool.retryAt = clock.now() + RETRY_MS
        // Nothing will take them: they go to the notebook's kernel, as they would have without the pool.
        for (const item of pool.queue.splice(0)) requeueCouncilShared(pool.sessionId, pool.root, item, pool.trouble)
      }
    } finally {
      worker.preparing = null
      if (worker.broken === null && pool.trouble !== null && pool.machine !== null) pool.trouble = null
      // The roll goes on: the next idle worker holding another epoch reloads.
      prepareIdle(pool)
      schedule(pool)
      changed(pool)
    }
  })()
}

/**
 * Load an epoch into a worker (§9.3 `load`): recycled first when it holds
 * another or may hold a previous life's, then the silent load, its report
 * checked. An empty epoch needs a fresh kernel and nothing else.
 */
async function seed(pool: Pool, worker: Worker, epoch: Epoch): Promise<boolean> {
  if (worker.seeded === epoch.seq && !worker.recycle && !worker.inherited) return true
  if (worker.seeded !== null || worker.recycle || worker.inherited) await recycleNow(worker)
  if (!epoch.files) {
    worker.seeded = epoch.seq
    return true
  }
  const run = python.loadRun({
    manifest: epoch.files.manifest.sha256,
    body: epoch.files.body,
    capMb: attemptMbOf(pool),
    threads: 1,
    workspace: workspaceOf(pool.sessionId),
  })
  const answer = await councilWorkerExecute(worker.handle, run.source, run.expressions)
  const report = python.loadReport(answer.values[run.key])
  if (!report?.ok) {
    throw new WorkerTrouble(
      `the epoch did not load${report?.error ? `: ${report.error}` : answer.status !== 'ok' ? ` (${answer.status})` : ''}`,
      tr('server.theWorkersCouldNotLoadThe.69de42'),
    )
  }
  worker.seeded = epoch.seq
  worker.served = 0
  return true
}

/** A worker's kernel restarted with its session kept (kernel/index.ts · recycleCouncilWorker): it holds nothing after. */
async function recycleNow(worker: Worker): Promise<void> {
  const back = await recycleCouncilWorker(worker.handle)
  worker.seeded = null
  worker.served = 0
  worker.recycle = false
  worker.inherited = false
  if (!back) throw new WorkerTrouble('the worker did not come back from its restart', tr('server.itsWorkersDidNotStart.f8a286'))
}

/**
 * Idle workers holding another epoch than the pool's reload: those holding
 * an older one at most RESEED_AT_ONCE at a time, so that the rest serve on
 * meanwhile (§9.5 «rolls»); those holding none, or due a recycle, all at
 * once — they serve nothing as they are.
 */
function prepareIdle(pool: Pool): void {
  if (pool.stopped) return
  const epoch = usableEpoch(pool)
  if (!epoch) return
  let rolling = [...pool.workers.values()].filter((worker) => worker.preparing !== null && worker.seeded !== null).length
  for (const worker of pool.workers.values()) {
    if (worker.preparing || worker.broken || (worker.seeded === epoch.seq && !worker.recycle && !worker.inherited)) continue
    const state = workerState(worker.handle)
    // (One whose Python is coming back by itself loads once it answers: kernel/index.ts tells its pool.)
    if (!state.up || state.computing || state.restarting) continue
    const rolls = worker.seeded !== null && !worker.recycle && !worker.inherited
    if (rolls && rolling >= RESEED_AT_ONCE) continue
    if (rolls) rolling++
    prepare(pool, worker)
  }
}

function idleWorkers(pool: Pool): Worker[] {
  return [...pool.workers.values()].filter((worker) => {
    if (worker.preparing || worker.broken) return false
    const state = workerState(worker.handle)
    return state.up && !state.computing && !state.restarting
  })
}

/* ------------------------------------------------------------ routing */

/** Whether the pool may take an attempt now (§9.6), or why not, in the card's words. */
function ready(pool: Pool): { ok: true; epoch: Epoch } | { ok: false; note: string } {
  if (pool.trouble) return { ok: false, note: pool.trouble }
  if (pool.machine === null && slotViewOf(pool.sessionId, 'council').where !== 'machine') return { ok: false, note: tr('server.thePoolIsStillStartingThisAttempt.bf84be') }
  const newest = epochsOf(pool.sessionId, pool.root)[0] ?? null
  const epoch = usableEpoch(pool)
  // The notebook's state cannot be the pool's: data on the GPU (D11), or no epoch at all that may reach the machine.
  if (newest?.trouble === 'cuda') return { ok: false, note: troubleWords('cuda') }
  if (!epoch) {
    const blocked = blockedBy(pool, newest)
    if (blocked && !pool.refreezing) return { ok: false, note: troubleWords(blocked) }
    return { ok: false, note: tr('server.thePoolIsStillStartingThisAttempt.bf84be') }
  }
  if (!machineReady(pool)) return { ok: false, note: tr('server.thePoolSMachineDoesNotAnswer.16922d') }
  const seeded = [...pool.workers.values()].some((worker) => worker.seeded !== null && worker.broken === null && workerState(worker.handle).up)
  if (!seeded) return { ok: false, note: tr('server.thePoolIsStillStartingThisAttempt.bf84be') }
  return { ok: true, epoch }
}

/** What keeps the newest epoch from the pool's machine, when something does: its trouble, or its size there (want). */
function blockedBy(pool: Pool, newest: Epoch | null): EpochTrouble | null {
  if (!newest) return null
  return newest.trouble ?? (tooBig(pool, newest) ? 'over' : null)
}

/**
 * The route of one attempt (§9.6 «Which queue»): into the pool, which then
 * gives it to a worker; or the notebook's FIFO, with the card's footnote.
 * Null: the class's council is not on machines, or the cell's attempts go
 * to the shared kernel by the teacher's choice — nothing is marked.
 */
function take(sessionId: string, root: string, item: KernelQueueItem): 'pool' | { shared: string } | null {
  if (!poolClass(sessionId)) return null
  if (item.councilCell?.lane === 'shared') return null
  const pool = ensurePool(sessionId, root)
  const now = ready(pool)
  if (!now.ok) {
    pool.waitingSince ??= clock.now()
    changed(pool)
    return { shared: now.note }
  }
  pool.waitingSince = null
  enqueue(pool, item)
  return 'pool'
}

/**
 * When each waiting attempt came into the pool's queue: it waits for a
 * fresher epoch at most COUNCIL_EPOCH_WAIT_MS from then (D8), however many
 * refreezes the teacher's cells ask meanwhile.
 */
const enteredAt = new WeakMap<KernelQueueItem, number>()

/** Into the pool's queue: the teacher's ahead of the authors' (D12), each in the order pressed. */
function enqueue(pool: Pool, item: KernelQueueItem): void {
  const host = item.council?.by === 'host'
  const at = host ? pool.queue.findIndex((one) => one.council?.by !== 'host') : -1
  if (at < 0) pool.queue.push(item)
  else pool.queue.splice(at, 0, item)
  enteredAt.set(item, clock.now())
  pool.emptySince = null
  schedule(pool)
  changed(pool)
}

function schedule(pool: Pool): void {
  if (pool.dispatchQueued || pool.stopped) return
  pool.dispatchQueued = true
  // Never in the caller's own turn: the attempt's «queued» frame goes before its «running» one (kernel/index.ts · requestCouncilRun).
  queueMicrotask(() => {
    pool.dispatchQueued = false
    dispatch(pool)
  })
}

/**
 * ASSIGN (§9.6): the head of the pool's queue to an idle worker, as many as
 * there are, each on the newest epoch its machine holds — after waiting for
 * a refreeze when the head's cell follows the kernel and the teacher has run
 * cells since (D8): at most COUNCIL_EPOCH_WAIT_MS for one epoch, and at most
 * that from the head's own press, whatever comes after. A machine away, or
 * no epoch left it may use: what waits goes to the notebook's kernel.
 */
function dispatch(pool: Pool): void {
  if (pool.stopped || pool.draining) return
  while (pool.queue.length > 0) {
    if (!machineReady(pool)) {
      if (machineAway(pool)) strand(pool, tr('server.thePoolSMachineDoesNotAnswer.16922d'))
      return
    }
    const epoch = usableEpoch(pool)
    if (!epoch) {
      const blocked = blockedBy(pool, epochsOf(pool.sessionId, pool.root)[0] ?? null)
      strand(pool, blocked ? troubleWords(blocked) : tr('server.thePoolIsStillStartingThisAttempt.bf84be'))
      return
    }
    const head = pool.queue[0]!
    if (head.councilCell?.refresh !== 'manual' && behindOf(epoch) > 0) {
      const awaited = awaitedEpoch(pool, epoch)
      if (awaited !== null) {
        // One window per epoch awaited: its export and its way to the machine together, never waited for twice.
        if (pool.wait?.seq !== awaited) pool.wait = { seq: awaited, until: clock.now() + COUNCIL_EPOCH_WAIT_MS }
        const until = Math.min(pool.wait.until, (enteredAt.get(head) ?? clock.now()) + COUNCIL_EPOCH_WAIT_MS)
        if (clock.now() < until) {
          if (pool.waitTimer !== null) clock.clearTimeout(pool.waitTimer)
          pool.waitTimer = clock.setTimeout(() => {
            pool.waitTimer = null
            schedule(pool)
          }, until - clock.now())
          return
        }
      }
    }
    const workers = idleWorkers(pool)
    const worker = workers.find((one) => one.seeded === epoch.seq && !one.recycle && !one.inherited) ?? workers[0]
    if (!worker) return
    pool.queue.shift()
    const behind = behindOf(epoch)
    const note = olderWords(epoch)
    head.placed = {
      placed: 'pool',
      runId: randomUUID().replace(/-/g, ''),
      epoch: { seq: epoch.seq, at: epoch.at, behind },
      ...(note ? { note } : {}),
    }
    if (!giveCouncilWorker(worker.handle, head)) {
      pool.queue.unshift(head)
      worker.broken = { why: tr('server.itsWorkersDidNotStart.f8a286'), until: clock.now() + RETRY_MS }
      continue
    }
  }
  if (pool.queue.length === 0) pool.emptySince ??= clock.now()
  changed(pool)
}

/**
 * The epoch the queue's head waits for (D8) while the one the pool runs is
 * behind the teacher's runs: a refreeze in flight, or the newest epoch still
 * on its way to the machine that holds every run. None coming, one is asked
 * for now — once per count of the teacher's runs, so an export that cannot
 * be had is not asked again and again until the teacher runs another cell —
 * and never with no live kernel, where there is nothing to snapshot: the
 * pool runs on what it has (§9.10). Null — nothing is coming.
 */
function awaitedEpoch(pool: Pool, usable: Epoch): number | null {
  const coming = comingEpoch(pool, usable)
  const count = runsOf(pool.sessionId, pool.root).count
  if (coming === null && !pool.refreezing && pool.askedRuns !== count && mainKernelOf(pool.sessionId, pool.root).live) refreeze(pool)
  return pool.refreezing?.seq ?? coming?.seq ?? null
}

/** An epoch newer than the usable one that may still reach the machine and is behind none of the teacher's runs. */
function comingEpoch(pool: Pool, usable: Epoch): Epoch | null {
  if (!pool.machine) return null
  for (const epoch of epochsOf(pool.sessionId, pool.root)) {
    if (epoch.seq <= usable.seq) return null
    if (epoch.trouble !== null || tooBig(pool, epoch) || epochOnMachine(pool.machine.runnerId, epoch) === 'failed') continue
    return behindOf(epoch) === 0 ? epoch : null
  }
  return null
}

/* ------------------------------------------------- what the pumps tell */

/** Before a worker's attempt (its pump, next to the guard): the epoch the attempt was given, loaded. */
async function seedFor(handle: WorkerHandle, item: KernelQueueItem): Promise<boolean> {
  const pool = poolOf(handle.sessionId, handle.root)
  const worker = pool?.workers.get(handle.n)
  if (!pool || !worker) return false
  if (worker.preparing) await worker.preparing
  const seq = item.placed?.epoch?.seq
  const epoch = seq === undefined ? usableEpoch(pool) : epochOf(pool.sessionId, pool.root, seq)
  if (!epoch) return false
  try {
    return await seed(pool, worker, epoch)
  } catch (error) {
    worker.broken = { why: poolWhy(pool.sessionId, error), until: clock.now() + RETRY_MS }
    console.warn(`[council ${pool.sessionId}/${pool.root}] worker ${worker.n} could not load epoch ${epoch.seq}: ${errText(error)}`)
    return false
  }
}

/**
 * A worker gives its attempt back before it ran: it did not come up, or would
 * not load — the attempt runs in the notebook's kernel, keeping its place,
 * and the worker is tried again later; or its machine went (`lost`) — the
 * card says so, and the worker starts again wherever the slot goes, held
 * against nothing.
 */
function givenBack(handle: WorkerHandle, item: KernelQueueItem, why: string, lost: boolean): void {
  const pool = poolOf(handle.sessionId, handle.root)
  const worker = pool?.workers.get(handle.n)
  console.warn(`[council ${handle.sessionId}/${handle.root}] worker ${handle.n} gives an attempt back: ${why}`)
  if (worker && !worker.broken && !lost) worker.broken = { why: tr('server.itsWorkersDidNotStart.f8a286'), until: clock.now() + RETRY_MS }
  requeueCouncilShared(handle.sessionId, handle.root, item, troubleWords(lost ? 'lost' : 'worker'))
  if (pool) {
    schedule(pool)
    changed(pool)
  }
}

/**
 * A worker's attempt ended (kernel/index.ts · runCouncilOne): the recycling
 * rules (§9.5), its files on their way to the card (§9.7), and the queue's
 * next head.
 */
function ended(handle: WorkerHandle, item: KernelQueueItem, end: AttemptEnd): void {
  const pool = poolOf(handle.sessionId, handle.root)
  const worker = pool?.workers.get(handle.n)
  if (!pool || !worker) return
  if (end.kind === 'ran') worker.served += 1
  if (end.kind === 'lost' || end.kernel === 'dead' || end.kernel === 'restarted') {
    /*
     * Its kernel went (with its machine, or by itself), or its Python is a new
     * one (an OOM kill): nothing to recycle — it starts again wherever the
     * slot is, or loads once it answers (restarted).
     */
    worker.seeded = null
  } else if (
    // (One stuck after its second SIGINT was recycled under it already: `stuck`.)
    !end.entered || end.threads > 0 || end.processes > 0 || end.kernel !== 'up'
    || (end.dirtyMb !== null && end.dirtyMb > attemptMbOf(pool)) || worker.served >= COUNCIL_WORKER_REUSE
  ) {
    worker.recycle = true
  }
  // Its folder on the machine: the files on their way to the card, and then the folder goes (an empty listing included).
  if (end.scratch && end.kind !== 'lost') collectFiles(pool, item, end.run, end.files)
  schedule(pool)
  prepareIdle(pool)
  const state = workerState(worker.handle)
  if (worker.recycle && !worker.preparing && state.up && !state.computing) prepare(pool, worker)
  changed(pool)
}

/**
 * The files an attempt wrote into its folder (§9.7): those within
 * COUNCIL_ARTIFACTS are asked of its machine, and the card names each as it
 * lands; the rest are named with their size. The folder goes once the
 * machine says the collection is over (an empty one included).
 */
function collectFiles(pool: Pool, item: KernelQueueItem, run: CouncilRun | null, listed: AttemptEnd['files']): void {
  const machine = pool.machine
  const runId = item.placed?.runId
  if (!machine || !runId) return
  // The exit hashed those within COUNCIL_ARTIFACTS, and those alone are brought: the caps once more, should a report claim more.
  const { taken } = artifactsWithinCaps(listed.flatMap((file) => (file.sha256 !== null ? [{ ...file, sha256: file.sha256 }] : [])))
  let card: CouncilRun | null = run ? { ...run, runId, files: listed.map((file) => ({ name: file.name, bytes: file.bytes, kept: false })) } : null
  askCollect({
    sessionId: pool.sessionId,
    runId,
    runnerId: machine.runnerId,
    gen: machine.gen,
    files: taken.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes })),
    landed: (name) => {
      if (!card) return
      card = { ...card, files: (card.files ?? []).map((file) => (file.name === name ? { ...file, kept: true } : file)) }
      tellCouncilItem(item, card)
    },
    over: () => {},
  })
}

/** A worker's attempt is still computing after the second SIGINT (§9.5): the worker is recycled, never the notebook's kernel. */
function stuck(handle: WorkerHandle): void {
  const pool = poolOf(handle.sessionId, handle.root)
  const worker = pool?.workers.get(handle.n)
  if (!pool || !worker) return
  console.warn(`[council ${pool.sessionId}/${pool.root}] worker ${worker.n} does not take its interrupts: recycled`)
  worker.recycle = true
  worker.seeded = null
  void recycleCouncilWorker(worker.handle).finally(() => {
    worker.recycle = false
    schedule(pool)
    prepareIdle(pool)
    changed(pool)
  })
}

/** A worker's pump went idle, or its Python answers again after restarting by itself (kernel/index.ts): recycled or loaded now if it must be, and the queue's head is due. */
function idle(handle: WorkerHandle): void {
  const pool = poolOf(handle.sessionId, handle.root)
  const worker = pool?.workers.get(handle.n)
  if (!pool || !worker) return
  if (pool.draining && ![...pool.workers.values()].some((one) => workerState(one.handle).computing)) drain(pool)
  const state = workerState(worker.handle)
  if (worker.recycle && !worker.preparing && state.up && !state.restarting) prepare(pool, worker)
  /*
   * Its kernel went with its machine while it computed (machineNews passed it
   * by): it starts again now, wherever the council's slot is placed next, or
   * the pool says why it did not start — not at the pool's next look, until
   * which every attempt pressed would read that the pool is still starting.
   */
  if (!state.up && !state.starting) startWorkers(pool)
  prepareIdle(pool)
  schedule(pool)
  changed(pool)
}

/**
 * A worker's Python restarted by itself or died (kernel/index.ts · onPhase):
 * an OOM kill in the class's one cgroup takes an idle worker as readily as a
 * busy one. What it had loaded is gone with the process (§9.5 «the kernel
 * restarted or died»): it is loaded again before it serves, once its new
 * Python answers, or started again when none comes.
 */
function restarted(handle: WorkerHandle): void {
  const pool = poolOf(handle.sessionId, handle.root)
  const worker = pool?.workers.get(handle.n)
  if (!pool || !worker) return
  worker.seeded = null
  worker.served = 0
  worker.recycle = false
  worker.inherited = false
  changed(pool)
}

/* ------------------------------------------------- the queue's helpers */

/** Every live pool of a class. */
function poolsOf(sessionId: string): Pool[] {
  return [...pools.values()].filter((pool) => pool.sessionId === sessionId && !pool.stopped)
}

const isAttempt = (item: KernelQueueItem, cellId: string, participantId: string): boolean =>
  item.council?.cellId === cellId && item.council.participantId === participantId

function position(sessionId: string, cellId: string, participantId: string): number | null {
  for (const pool of poolsOf(sessionId)) {
    const index = pool.queue.findIndex((item) => isAttempt(item, cellId, participantId))
    if (index >= 0) return index + 1
  }
  return null
}

function personAt(sessionId: string, root: string, participantId: string): number | null {
  const pool = poolOf(sessionId, root)
  if (!pool) return null
  const index = pool.queue.findIndex((item) => item.council?.participantId === participantId)
  return index < 0 ? null : index + 1
}

function replace(sessionId: string, cellId: string, participantId: string, next: (old: KernelQueueItem) => KernelQueueItem | null): boolean {
  for (const pool of poolsOf(sessionId)) {
    const index = pool.queue.findIndex((item) => isAttempt(item, cellId, participantId))
    if (index < 0) continue
    const swapped = next(pool.queue[index]!)
    if (!swapped) return false
    pool.queue[index] = swapped
    return true
  }
  return false
}

function cancel(sessionId: string, cellId: string, participantId: string): KernelQueueItem | null {
  for (const pool of poolsOf(sessionId)) {
    const index = pool.queue.findIndex((item) => isAttempt(item, cellId, participantId))
    if (index < 0) continue
    const [dropped] = pool.queue.splice(index, 1)
    if (pool.queue.length === 0) pool.emptySince ??= clock.now()
    changed(pool)
    return dropped ?? null
  }
  return null
}

function purge(sessionId: string, participantId: string): KernelQueueItem[] {
  const out: KernelQueueItem[] = []
  for (const pool of poolsOf(sessionId)) {
    const gone = pool.queue.filter((item) => item.council?.participantId === participantId)
    if (gone.length === 0) continue
    pool.queue = pool.queue.filter((item) => !gone.includes(item))
    out.push(...gone)
    changed(pool)
  }
  return out
}

function retime(sessionId: string, cellId: string, limitSec: number | null): void {
  for (const pool of poolsOf(sessionId)) {
    for (const item of pool.queue) {
      if (item.council?.cellId === cellId && item.council.limitSec !== limitSec) item.council = { ...item.council, limitSec }
    }
  }
}

function positions(sessionId: string): Array<{ cellId: string; participantId: string; position: number }> {
  const out: Array<{ cellId: string; participantId: string; position: number }> = []
  for (const pool of poolsOf(sessionId)) {
    pool.queue.forEach((item, index) => {
      if (item.council) out.push({ cellId: item.council.cellId, participantId: item.council.participantId, position: index + 1 })
    })
  }
  return out
}

function waiting(sessionId: string): KernelQueueItem[] {
  return poolsOf(sessionId).flatMap((pool) => pool.queue)
}

/* --------------------------------------------------------------- the view */

/** The pool of a notebook as the console reads it (CouncilKernel.pool); null — the class's council is not on machines. */
function view(sessionId: string, root: string): CouncilPool | null {
  if (!poolClass(sessionId)) return null
  const pool = poolOf(sessionId, root)
  const epoch = pool ? usableEpoch(pool) : null
  const newest = epochsOf(sessionId, root)[0] ?? null
  const shown = epoch ?? (newest && newest.trouble !== 'failed' ? newest : null)
  const workers = pool ? [...pool.workers.values()].filter((worker) => workerState(worker.handle).up) : []
  const busy = workers.filter((worker) => workerState(worker.handle).computing).length
  const now = pool ? ready(pool) : { ok: false as const, note: tr('server.thePoolIsStillStartingThisAttempt.bf84be') }
  const stalled = pool?.waitingSince != null && clock.now() - pool.waitingSince >= COUNCIL_POOL_READY_MS
  // The newest cannot be the pool's — its trouble, or its size on the pool's machine — and nothing older stands in: the attempts are the shared kernel's.
  const blocked = pool ? blockedBy(pool, newest) : (newest?.trouble ?? null)
  const trouble = pool?.trouble ?? (blocked && !epoch && !pool?.refreezing ? troubleWords(blocked) : null)
  const state: CouncilPool['state'] = now.ok ? 'ready' : trouble ? 'shared' : 'starting'
  const note = now.ok
    ? (epoch && newest && newest.seq !== epoch.seq && pool && tooBig(pool, newest)
        ? tr('server.theNewStateDoesNotFit.1c7533', { time: clockTime(epoch.at) })
        : undefined)
    : trouble ?? (stalled ? tr('server.thePoolDidNotStart.80644c', { why: pool && [...pool.workers.values()].find((one) => one.broken)?.broken?.why || now.note }) : undefined)
  return {
    state,
    machine: pool?.machine?.name ?? null,
    workers: workers.length,
    busy,
    queued: pool?.queue.length ?? 0,
    refreezing: pool?.refreezing != null,
    epoch: shown
      ? {
          seq: shown.seq,
          at: shown.at,
          carried: shown.carried.length,
          left: shown.left.map((one) => ({ name: one.name, why: councilLeftWords(one.why) })),
          behind: behindOf(shown),
        }
      : null,
    ...(note ? { note } : {}),
  }
}

/* ----------------------------------------------------------------- tick */

/** A pool's look at itself every TICK_MS: grow, shrink, the console's minute, the linger, a retry. */
async function tick(pool: Pool): Promise<void> {
  if (pool.stopped) return
  const now = clock.now()
  stillOpen(pool, now)
  if (pool.open.size === 0 && pool.closedAt !== null && now - pool.closedAt >= COUNCIL_POOL_LINGER_MS && pool.queue.length === 0) {
    await stopPool(pool, 'linger')
    return
  }
  if (!poolClass(pool.sessionId)) {
    // The class's council came here meanwhile: what waits goes to the notebook's kernel, and the pool ends.
    await stopPool(pool, 'linger')
    return
  }
  // The class computes on its epochs: the store keeps their files ahead of the classes nobody uses (epochs.ts · pruneStore).
  touchEpochStore(pool.sessionId)
  const setting = settingOf(pool.sessionId)
  if (setting.workers !== 'auto') {
    const wanted = clampWorkers(setting.workers)
    if (wanted !== pool.size) await resize(pool, wanted)
  } else {
    const idle = idleWorkers(pool).length
    const room = await roomOf.room(pool.sessionId).catch(() => null)
    // What the container holds beside this pool's workers: the class's other pools, every epoch's buffers, the margin.
    const beside = containerNeed(pool.sessionId, { pool, size: 0 }).memoryMb
    const fit = room ? Math.floor((room.memoryMb + room.freeMb - beside) / workerMb(pool, usableEpoch(pool))) : null
    const cap = autoCap(pool, fit)
    if (pool.queue.length > idle && pool.size < cap) await resize(pool, Math.min(cap, pool.size + GROW_STEP))
    else if (pool.queue.length === 0 && pool.emptySince !== null && now - pool.emptySince >= SHRINK_AFTER_MS && now - pool.shedAt >= SHRINK_EVERY_MS && pool.size > COUNCIL_WORKERS.min) {
      pool.shedAt = now
      await resize(pool, pool.size - 1)
    }
  }
  if (pool.trouble !== null && now >= pool.retryAt) pool.trouble = null
  // The container at what the class's pools hold now: the start's guess, an epoch's buffers come in.
  if (pool.machine !== null) await fitContainer(pool.sessionId)
  maybeRefreeze(pool)
  startWorkers(pool)
  prepareIdle(pool)
  schedule(pool)
  changed(pool)
}

/**
 * The council cells of the notebook still open, by the document: one deleted,
 * or no longer a council's, closes as the lock's own message would close it
 * (control.ts · councilClosed), and the linger counts from now. A room whose
 * document is not in memory is left as it is.
 */
function stillOpen(pool: Pool, now: number): void {
  if (pool.open.size === 0) return
  const doc = peekSessionDoc(pool.sessionId)?.doc
  if (!doc) return
  for (const cellId of [...pool.open]) {
    const found = findCell(doc, cellId)
    if (!found || !isCellCouncil(found.cell)) pool.open.delete(cellId)
  }
  if (pool.open.size === 0) pool.closedAt ??= now
}

/**
 * What one worker takes in the class's council container beside the
 * epoch's files (§9.5): its ceiling («Память на попытку»), what it holds
 * before an attempt (COUNCIL_WORKER_BASE_MB: the interpreter, the imports),
 * and the epoch's stream it unpickled into memory of its own — the buffers
 * are mapped, the same pages for every worker. An attempt's ceiling counts
 * from where its worker stands (§9.3 detail 4), so all three are its.
 */
function workerMb(pool: Pool, epoch: Epoch | null): number {
  const files = epoch?.files
  const stream = files ? (files.buffers.find((file) => file.sha256 === files.body)?.bytes ?? 0) : 0
  return attemptMbOf(pool) + COUNCIL_WORKER_BASE_MB + Math.ceil(stream / MB)
}

/**
 * What the class's one council container is to hold (§9.5), across the pools
 * of all its notebooks: each pool's workers, at what each takes (workerMb),
 * and the files of the epoch it runs, the margin once, a core a worker.
 * `change` — one pool at another size than it has (the one being resized,
 * or left out at 0).
 */
function containerNeed(sessionId: string, change: { pool: Pool; size: number } | null = null): { memoryMb: number; cpus: number; workers: number } {
  let memoryMb = POOL_EXTRA_MB
  let workers = 0
  const all = poolsOf(sessionId)
  if (change && !all.includes(change.pool)) all.push(change.pool)
  for (const one of all) {
    const size = change && one === change.pool ? change.size : (one.sizing ?? one.size)
    const epoch = usableEpoch(one)
    memoryMb += size * workerMb(one, epoch) + (epoch ? Math.ceil(epoch.bytes / MB) : 0)
    workers += size
  }
  return { memoryMb, cpus: Math.max(1, workers), workers: Math.max(1, workers) }
}

/** The numbers last asked of each class's council container, with the gen of the placement they were asked of. */
const containerAsked = new Map<string, { gen: number | null; memoryMb: number; cpus: number; workers: number }>()

/**
 * The class's council container at what its pools hold (§9.5), asked of its
 * placement whenever that changes: a pool grown or shrunk, a pool of another
 * notebook come or gone, an epoch whose buffers come in — and the start's
 * numbers, which the placement guessed before any pool had a size or an
 * epoch. The same numbers are not asked twice of one placement. `change` — a
 * growth being asked (resize). A machine with no room for more keeps what
 * the container has: said once in the log, asked again when the numbers
 * change.
 */
async function fitContainer(sessionId: string, change: { pool: Pool; size: number } | null = null): Promise<'applied' | 'pending' | 'failed'> {
  const need = containerNeed(sessionId, change)
  const view = slotViewOf(sessionId, 'council')
  const gen = view.where === 'machine' ? view.gen : null
  const last = containerAsked.get(sessionId)
  if (last && last.gen === gen && last.memoryMb === need.memoryMb && last.cpus === need.cpus && last.workers === need.workers) return 'applied'
  containerAsked.set(sessionId, { gen, ...need })
  const outcome = await roomOf.resize(sessionId, need.memoryMb, need.cpus, need.workers).catch(() => 'failed' as const)
  if (outcome === 'failed' && !change) console.warn(`[council ${sessionId}] its machine has no room for a council container of ${need.memoryMb} MB: it stays as it is`)
  return outcome
}

/** The pool's size, and the class's container with it (§9.5, fitContainer). */
async function resize(pool: Pool, size: number): Promise<void> {
  const before = pool.size
  if (size === before || pool.stopped) return
  if (size > before) {
    pool.sizing = size
    const outcome = await fitContainer(pool.sessionId, { pool, size })
    pool.sizing = null
    if (outcome === 'failed') {
      console.warn(`[council ${pool.sessionId}/${pool.root}] its machine has no room for ${size} workers: it stays at ${before}`)
      return
    }
    pool.size = size
    console.log(`[council ${pool.sessionId}/${pool.root}] the pool grows to ${size} workers`)
    startWorkers(pool)
    return
  }
  // Shrinking: the highest idle workers go, then the container gives the memory back.
  pool.size = size
  for (const worker of [...pool.workers.values()].sort((a, b) => b.n - a.n)) {
    if (worker.n <= size) break
    const state = workerState(worker.handle)
    if (state.computing || worker.preparing) {
      // Busy: it goes at its next look, once idle.
      pool.size = Math.max(pool.size, worker.n)
      continue
    }
    pool.workers.delete(worker.n)
    await retireCouncilWorker(worker.handle)
  }
  void fitContainer(pool.sessionId)
  console.log(`[council ${pool.sessionId}/${pool.root}] the pool shrinks to ${pool.size} workers`)
}

/* --------------------------------------------------------- the console */

/**
 * A council cell opened (control.ts · cell:lock → council): the notebook's
 * pool starts its workers, and an epoch is taken, beside each other (§9.5).
 */
export function councilOpened(sessionId: string, root: string, cellId: string): void {
  if (!poolClass(sessionId)) return
  const pool = ensurePool(sessionId, root)
  pool.open.add(cellId)
  pool.closedAt = null
  // The teacher opened it on this state: a fresh epoch, whatever the pool held (one already on its way is that one, or one more after it).
  refreeze(pool, true)
  changed(pool)
}

/** A council cell closed: the pool lingers COUNCIL_POOL_LINGER_MS after the last of the notebook's closes (§9.5). */
export function councilClosed(sessionId: string, root: string, cellId: string): void {
  const pool = poolOf(sessionId, root)
  if (!pool) return
  pool.open.delete(cellId)
  if (pool.open.size === 0) pool.closedAt = clock.now()
  changed(pool)
}

/**
 * The teacher's «Обновить состояние» (`council:epoch`): a refreeze now,
 * whatever the cell's `refresh`. False — the cell's attempts do not go to a
 * pool (the class's council is not on machines).
 */
export function councilRefresh(sessionId: string, root: string): boolean {
  if (!poolClass(sessionId)) return false
  const pool = ensurePool(sessionId, root)
  refreeze(pool, true)
  return true
}

/** A console came (control.ts · councilWelcome): the pool of an open council comes back after a restart of this server (§9.10). */
export function councilWarm(sessionId: string, root: string, cellId: string): void {
  if (!poolClass(sessionId)) return
  const pool = ensurePool(sessionId, root)
  pool.open.add(cellId)
  pool.closedAt = null
}

/**
 * «В ячейку и запустить» of an attempt that ran on an epoch the notebook's
 * kernel has moved on from since (§9.8): the console's warning, or null.
 */
export function adoptWarning(sessionId: string, run: CouncilRun | null): string | null {
  const seq = run?.placed === 'pool' ? run.epoch?.seq : undefined
  if (seq === undefined || !run) return null
  const root = poolRootOf(sessionId, seq)
  const epoch = root === null ? null : epochOf(sessionId, root, seq)
  const behind = epoch ? behindOf(epoch) : (run.epoch?.behind ?? 0)
  return behind > 0 ? tr('server.theKernelHasRunCellsSinceThe.e29733', { count: behind }) : null
}

/** The notebook an epoch number of a class belongs to: the class counts its epochs across its notebooks (epochs.ts · nextEpochSeq). */
function poolRootOf(sessionId: string, seq: number): string | null {
  for (const pool of poolsOf(sessionId)) if (epochOf(sessionId, pool.root, seq)) return pool.root
  return null
}

/**
 * The class is gone or its kernels were stopped (kernel/index.ts ·
 * shutdownSession, stopKernelsByOwner): its pools go, waiting attempts with
 * no run. Its notebooks' kernels went too, and their runs before no longer
 * make the class's kept epochs stale — the counts go on (mainReset): an
 * epoch counted in this life is compared with the runs after it, never with
 * a count begun anew.
 */
function closed(sessionId: string): void {
  for (const pool of poolsOf(sessionId)) void stopPool(pool, 'closed')
  containerAsked.delete(sessionId)
  for (const key of [...runs.keys()]) if (key.startsWith(`${sessionId}\0`)) mainReset(sessionId, key.slice(sessionId.length + 1), null)
}

/** The class was deleted (control.ts · closeControlRoom): its epochs and their files too, and the counts they were compared with. */
export function councilDiscarded(sessionId: string): void {
  closed(sessionId)
  for (const key of [...runs.keys()]) if (key.startsWith(`${sessionId}\0`)) runs.delete(key)
  for (const key of [...exportsDropped]) if (key.startsWith(`${sessionId}\0`)) exportsDropped.delete(key)
  forgetClassEpochs(sessionId)
}

/** This server stops: every timer goes (the workers' kernels are let go of by kernel/index.ts). */
function shutdown(): void {
  for (const pool of [...pools.values()]) {
    pool.stopped = true
    if (pool.timer !== null) clock.clearTimeout(pool.timer)
    if (pool.waitTimer !== null) clock.clearTimeout(pool.waitTimer)
    if (pool.draining) clock.clearTimeout(pool.draining.timer)
  }
  pools.clear()
}

/** For tests and the end-to-end harness: forget every pool as a dead process would, saying nothing to anyone. */
export function resetPoolsForTest(): void {
  shutdown()
  runs.clear()
  containerAsked.clear()
  exportsDropped.clear()
}

/** For tests: how a notebook's pool stands, by its own record. */
export function poolForTest(sessionId: string, root: string): { size: number; queue: number; workers: Array<{ n: number; seeded: number | null; served: number; broken: string | null }>; refreezing: boolean } | null {
  const pool = poolOf(sessionId, root)
  if (!pool) return null
  return {
    size: pool.size,
    queue: pool.queue.length,
    workers: [...pool.workers.values()].map((worker) => ({ n: worker.n, seeded: worker.seeded, served: worker.served, broken: worker.broken?.why ?? null })),
    refreezing: pool.refreezing !== null,
  }
}

/** For tests: one pass of a pool's tick now. */
export async function tickPoolForTest(sessionId: string, root: string): Promise<void> {
  const pool = poolOf(sessionId, root)
  if (pool) await tick(pool)
}

/* -------------------------------------------------------------- wiring */

const HOOKS: CouncilPoolHooks = {
  take,
  position,
  personAt,
  replace,
  cancel,
  purge,
  retime,
  positions,
  waiting,
  view,
  seed: seedFor,
  entry: (handle, item, base) => {
    const pool = poolOf(handle.sessionId, handle.root)
    return python.entrySource({
      ...base,
      source: item.council?.source ?? '',
      runId: item.placed?.runId ?? randomUUID().replace(/-/g, ''),
      capMb: pool ? attemptMbOf(pool) : COUNCIL_ATTEMPT_MB,
      workspace: workspaceOf(handle.sessionId),
    })
  },
  needs: (raw) => python.entryNeeds(raw),
  left: (raw) => python.leaveReport(raw),
  givenBack,
  ended,
  stuck,
  idle,
  restarted,
  historyRun,
  mainReset,
  closed,
  shutdown,
  abandon: resetPoolsForTest,
}

useCouncilPool(HOOKS)
onKernelMachineChange((sessionId, role) => {
  if (role === 'council') machineNews(sessionId)
})
onEpochNews((sessionId, root) => {
  const pool = poolOf(sessionId, root)
  if (!pool) return
  want(pool)
  maybeRefreeze(pool)
  // An epoch on the machine now: the container is asked to hold its buffers as the workers load it.
  if (pool.machine !== null) void fitContainer(sessionId)
  prepareIdle(pool)
  schedule(pool)
  changed(pool)
})
// A machine's first sync of this life: what it holds is known now, and what an epoch would ship there with it (want).
onEpochMachineHeard((runnerId) => {
  for (const pool of [...pools.values()]) {
    if (pool.stopped || pool.machine?.runnerId !== runnerId) continue
    want(pool)
    maybeRefreeze(pool)
    prepareIdle(pool)
    schedule(pool)
    changed(pool)
  }
})
