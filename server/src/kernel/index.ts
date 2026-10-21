import { tr } from '@shared/i18n'
/**
 * One Python kernel per NOTEBOOK, and the queue in front of each.
 *
 * A notebook here is a Jupyter notebook, and notebooks do not share variables.
 * A lecture and a seminar run in one room and one class, but a `df` loaded in
 * the lecture must not show up in the seminar: these are different files and
 * different work. So the execution scope here is the pair (class, notebook
 * root), not the class: each has its own Python process, its own queue and its
 * own execution counter. They compute IN PARALLEL (two kernels, two pumps),
 * and it shows: while the lecture is thinking over training, the seminar
 * answers.
 *
 * Where a kernel lives is a second question, and it has a different answer.
 * The class's notebooks compute in the room container; students' personal
 * notebooks in a separate container without a GPU (`bookHasOwnKernel`,
 * pool.ts · KernelRole), because a GPU is handed to a container whole, and the
 * OOM killer under a shared limit picks the heaviest process, i.e. the
 * teacher's kernel with the dataset.
 *
 * The room shares a kernel per notebook, so the interesting part of this file
 * is not talking to Jupyter — jupyter.ts does that — but deciding whose turn it
 * is and making that decision visible. A `Runtime` per scope holds the kernel,
 * the queue and, importantly, its *own* record of what is running and who
 * started it: the document is shared and a student with a console could write
 * any `runById` into any cell, so anything that grants a right (interrupting,
 * cancelling) is answered from here rather than from the CRDT.
 *
 * Everything the room sees is written into the session document, not sent to
 * the browser that pressed the button: cell state, execution counts, output,
 * the queue, the kernel status and the notes in the terminal's kernel log. That
 * is why a student who joins twenty minutes late sees the whole history, and
 * why two people watching the same run see byte-identical output. The kernel
 * state lives there per notebook (`meta.kernels`), and for the room's notebook
 * it is also mirrored into the old keys; see `setStatus`.
 *
 * A press of Run is a *batch* — one cell for Run, thirty for Run All. A failure
 * stops the rest of its own batch and nothing else, so somebody else's queued
 * cell is not collateral damage.
 */

import * as Y from 'yjs'
import {
  cellId as idOf,
  cellOutputs,
  cellSource,
  allBooks,
  allCellArrays,
  bookCells,
  bookList,
  cellsAt,
  cellType,
  createTerminalLine,
  findCell,
  getMeta,
  getTerminal,
  kernelEntry,
  kernelsMap,
  readOutput,
  rootOfCell,
  CELLS_KEY,
  KERNELS_KEY,
  KERNEL_LINK_FIELD,
  KERNEL_LINK_SINCE_FIELD,
  KERNEL_QUEUE_FIELD,
  KERNEL_RUNNING_FIELD,
  KERNEL_WHERE_FIELD,
  legacyKernelStatus,
  KERNEL_STATUS_FIELD,
  type CellState,
  type CouncilSettings,
  type KernelLinkState,
  type KernelStatus,
  type KernelWhere,
  type TerminalLineCode,
  type YCell,
  type YOutput,
} from '@shared/notebook'
import { CLASS_HELP_PAD_MAX_MS, CLASS_UNREACHABLE_NOTE_MS } from '@shared/remote-kernels'
import { config } from '../config.js'
import { appendActivity } from '../activity.js'
import type { ActivityDetails, ActivityKind, ActivityOutcome } from '@shared/activity'
import { getParticipant, isFinished, sessionEnvironment, sessionRowExists, storedRules } from '../db.js'
import { instanceTimeZone } from '../time-zone.js'
import { bookHasOwnKernel } from '@shared/rules'
import { activeName } from '../environments.js'
import { formatNotebook, type FormatOutcome } from './format.js'
import {
  dropOwnKernel,
  dropRoomKernel,
  endpointForSession,
  forgetSessionKernel,
  listRoomKernels,
  machineMemoryFull,
  onRoomKernelRecreated,
  ownIdleMinutes,
  ownKernelMax,
  roomIdleMinutes,
  runningRoomKernels,
  OwnKernelUnavailable,
  type KernelRole,
} from './pool.js'
import { kernelBackend, RuntimeRequestError } from './runtime-client.js'
import { isKernelMemoryOutput, KERNEL_MEMORY_ENAME, KERNEL_PROBLEM_KEY, type KernelProblem } from '@shared/kernel-problem'
import { explain as explainDeath, forgetKills, sampleKills } from './postmortem.js'
import { getSessionDoc, holdRoom, onlineCount, peekSessionDoc } from '../collab/index.js'
import { kernelRetirementInProgress, pauseKernelStarts } from './retirement.js'
import { takePlacementHooks } from './remote/placement-store.js'
import { attemptCardFiles } from './remote/epochs.js'
import { FilesStalled, askSlotScan, filesPlacementChanged, slotFilesBarrier, slotOnMachine } from './remote/files.js'
import { seldom } from '../log.js'
import { countKernelStart } from '../ops/counters.js'
import { projectBooks } from '../collab/books.js'
import { flushSessionFiles } from '../collab/files.js'
import {
  JupyterKernel,
  RestartUnknown,
  type CompleteResult,
  type ExecuteStatus,
  type KernelEndpoint,
  type KernelLink,
  type KernelPhase,
} from './jupyter.js'
import {
  inspectBriefSource,
  inspectFactsSource,
  inspectStaticSource,
  looksLikeModule,
  nameChainAt,
  parseBrief,
  parseStaticInspect,
  withModuleFacts,
  INSPECT_BUDGET_SEC,
  INSPECT_REPORT_EXPR,
  INSPECT_REPORT_KEY,
} from './inspect-static.js'
import { dataBudgetFor, OutputWriter } from './outputs.js'
import { CouncilOutputBuffer, type CouncilJob } from './council.js'
import {
  councilEnterSource,
  councilEnterRefusal,
  councilLeftoverNotes,
  councilMemoryNote,
  councilSkipNotes,
  parseCouncilLeftovers,
  parseCouncilReport,
  COUNCIL_EXIT_SOURCE,
  COUNCIL_LEFTOVERS_EXPR,
  COUNCIL_REFUSED,
  COUNCIL_REPORT_EXPR,
  COUNCIL_REPORT_KEY,
  type CouncilIsolationReport,
  type CouncilLeftovers,
} from './council-isolation.js'
import {
  guardPolicySource,
  parseGuardReport,
  COLLOQ_REFUSED,
  GUARD_REPORT_EXPR,
  GUARD_REPORT_KEY,
} from './danger.js'
import { durationWords } from '@shared/text'
import type { BriefValue, CouncilPool, CouncilRun, CouncilRunEpoch, InspectMiss, KernelMachine } from '@shared/protocol'
import { closeTerminal, codedLineStands, terminalPhase, useLinkJitter } from './terminal.js'

/**
 * The per-session Python runtime.
 *
 * One seminar means one kernel and one queue: everybody shares the same
 * variables, and cells run strictly one at a time so `df` means the same thing
 * to the room as it does to the person who pressed Run. Runtime state is
 * mirrored into the document's `meta` map rather than pushed over a side
 * channel, so a browser that just finished syncing already knows what is
 * queued, what is running, and who asked for it.
 */

/** Marks every write this module makes to a session document. */
const ORIGIN = 'kernel'
/** Long enough that a healthy cold start never trips it, short enough to matter. */
const SLOW_START_NOTICE_MS = 8_000

interface QueueItem {
  cellId: string
  runBy: string
  runById: string
  activitySeq?: number | null
  activityFinished?: boolean
  activityCancelled?: boolean
  /**
   * Which press of Run this cell came from.
   *
   * Run All is one press and thirty cells; a single Run is one press and one.
   * When a cell fails, the rest of *its own* batch stops — the way Run All has
   * always worked in the tool this room already knows, and the way the execute
   * request this server sends (`stop_on_error: true`) already asks the kernel
   * to behave. Cells somebody else queued in the meantime are untouched: their
   * work has nothing to do with this failure.
   */
  batch: number
  /**
   * A council attempt, not a cell.
   *
   * The same pump and the same queue: a notebook has one kernel, and "run the
   * attempt" stands in its queue next to cells, in the order of presses. But
   * the `cellId` of such an entry is synthetic (`councilQueueId`): there is no
   * such cell in the document, and everything that writes to the document by
   * cell name (state, output, the queue mirror) finds nothing and stays silent.
   * The output goes into a buffer (kernel/council.ts), not into a shared cell:
   * whether to show it to the audience is the teacher's decision, not the
   * kernel's.
   */
  council?: CouncilJob
  /**
   * The council cell's knobs at the press that matter to the pool
   * (remote-classes.md §6.2): whether its attempts go to the class's pool of
   * workers, and whether their epoch follows the kernel. Absent for a cell.
   */
  councilCell?: Pick<CouncilSettings, 'lane' | 'refresh'>
  /**
   * Where an attempt runs and on what (§9.8), for its card: the pool (with
   * the epoch it was given and its run's own name) or the shared kernel
   * (with why). Absent for an attempt of a class whose council is not on
   * machines: nothing is said of it then.
   */
  placed?: AttemptPlacement
  /** A pool attempt already run once and lost with its machine (§9.10, D15): it is not run again a second time. */
  rerun?: boolean
  /**
   * A service run in the notebook's kernel, not a cell: the export of its
   * epoch for the council's pool (§9.2). It stands in the queue, at its
   * head, so that it runs between the teacher's cells and never under one;
   * its `cellId` (`epoch:<seq>`) is no cell's, and nothing of it goes into
   * the document. It never starts a kernel: with none live it is answered
   * at once (`no-kernel`).
   */
  service?: ServiceJob
}

/** Where a council attempt runs (QueueItem.placed): what its run frames carry for the card (CouncilRun.placed, note, epoch, runId). */
export interface AttemptPlacement {
  placed: 'pool' | 'shared'
  note?: string
  epoch?: CouncilRunEpoch
  runId?: string
}

/** The export of a notebook's epoch as its kernel's queue runs it (QueueItem.service): one silent execute, answered once. */
export interface ServiceJob {
  kind: 'epoch'
  source: string
  expressions: Record<string, string>
  /** The kernel's `user_expressions`; or why there were none: no live kernel, dropped from the queue, or a failed run. */
  done(answer: { values: Record<string, unknown> } | { refused: 'no-kernel' | 'dropped' | 'failed'; detail?: string }): void
}

/** The queue entry of a cell, an attempt or a service run, for kernel/council-pool.ts, which holds attempts of its own. */
export type KernelQueueItem = QueueItem

function executionActivity(runtime: Runtime, item: QueueItem, kind: ActivityKind, details: ActivityDetails = {}): number | null {
  return appendActivity(runtime.sessionId, item.runById, kind, {
    cellId: item.council?.cellId ?? item.cellId,
    subjectId: item.council?.participantId,
    requestSeq: item.activitySeq ?? undefined,
    source: 'participant',
    ...details,
  })
}

function finishExecution(runtime: Runtime, item: QueueItem, outcome: ActivityOutcome, durationMs = 0): void {
  if (item.activityFinished) return
  item.activityFinished = true
  executionActivity(runtime, item, 'execution.finished', {
    outcome: item.activityCancelled && outcome !== 'completed' ? 'cancelled' : outcome,
    durationMs,
  })
  if (runtime.activityItem === item) runtime.activityItem = null
}

/** The council attempt the kernel is computing right now. */
interface ActiveJob {
  item: QueueItem
  job: CouncilJob
  buffer: CouncilOutputBuffer
  run: CouncilRun
  /** A deferred output frame; see `touchJob`. */
  timer: NodeJS.Timeout | null
}

/**
 * The limit alarm for what the kernel is computing NOW, one for a cell and for
 * an attempt alike.
 *
 * It lives on the runtime, not on the attempt, and that is the main decision
 * here. The limit used to be a property of the council cell and guarded only
 * attempts, but a notebook's queue is one and shared (`Runtime.queue`): one
 * endless run of an ORDINARY cell held the whole council until the end of
 * class, and a teacher who had set "everyone in turn" and a 30 s limit
 * honestly read it as "the limit does not work". A second copy of the alarm
 * for cells would drift from the first at the very first turn (on recounting
 * from the start of the run, on `restamp`, on "no more than two signals"), so
 * there is one record and one set of functions here.
 *
 * At any moment exactly one job is computing (the pump is strictly
 * sequential), so there is one record, and it names its own target.
 */
interface RunLimit {
  /** The queue entry being guarded: a cell or an attempt. */
  item: QueueItem
  /** Where to count from if the runtime lacks the start (see `startOfLimit`). */
  startedAt: number
  /**
   * The limit in seconds; `null` means no limit, and the alarm is not set.
   *
   * Separate from `CouncilJob.limitSec`, because the rules can be changed in the
   * middle of a run, and "rules apply at once" means the new limit is counted
   * from the start of the work already running (`retimeCouncilRun`).
   */
  sec: number | null
  timer: NodeJS.Timeout | null
  /** The limit that FIRED: it goes to `CouncilRun.timedOut` and the cell's output. */
  firedSec: number | null
  /** How many times we have already asked the kernel to stop over this limit. */
  interrupts: number
  /**
   * Two signals went out, and the work is still computing.
   *
   * Python that has gone into C does not see SIGINT until it returns to the
   * interpreter, and signalling further is pointless (see `fireLimit`). This
   * used to be followed by silence: the attempt "computing" forever, the pump
   * standing, the queue frozen, and nobody saying a word about it. The console
   * reads this flag and offers the only thing that helps: restarting the
   * notebook's kernel.
   */
  stuck: boolean
  /**
   * The last signal could not reach the kernel: it computes on a machine
   * whose link is down (remote-classes.md §5.8). The signal goes again by
   * itself once the link is back and this same work still computes
   * (`signalItem`); until then the limit's next step waits in `resume`, so it
   * counts from when the signal landed rather than from when it was lost.
   */
  pending: boolean
  resume: (() => void) | null
}

/**
 * How many milliseconds a second of the limit costs, and a seam for the test.
 *
 * The rules sanitizer accepts only whole seconds from one up
 * (shared/notebook.ts · readCouncilSettings), and that is right for a knob, but
 * it would mean a suite that honestly waits five seconds for every case. The
 * scale is changed only by a test; in production it is always a thousand.
 */
let limitTickMs = 1000
export function setCouncilLimitTick(ms: number): void {
  limitTickMs = ms
}

/**
 * How long until SIGINT is repeated if the attempt did not notice it.
 *
 * Counted in the same limit "seconds", so that a test that sped up the scale
 * also speeds up the repeat.
 */
const LIMIT_RETRY_TICKS = 5

/** The synthetic name of a queue entry for an attempt: never equal to a cell's. */
function councilQueueId(cellId: string, participantId: string): string {
  return `council:${cellId}:${participantId}`
}

interface Runtime {
  sessionId: string
  /**
   * The notebook this kernel belongs to: its root in the room document.
   *
   * The pair (class, root) is the execution scope: each has its own Python, its
   * own queue and its own execution counter. `cells` is the room's notebook,
   * historically the first; its scope carries the old Jupyter session name and
   * is mirrored into the old document keys, so that a deploy does not cost live
   * rooms their variables.
   */
  root: string
  /**
   * Which container this kernel is up in: the class's or the personal
   * notebooks'.
   *
   * Decided ONCE, at start-up, by the stored rules, and remembered, because a
   * kernel has to be shut down where it lives. A teacher who changes a
   * notebook's access in the middle of class changes the answer of
   * `bookHasOwnKernel`; the scope is then shut down entirely
   * (`relocateBookKernel`) rather than silently moving.
   */
  role: KernelRole
  activityItem?: QueueItem | null
  kernel: JupyterKernel | null
  /** In-flight connect, shared by concurrent ensureKernel callers. */
  starting: Promise<void> | null
  /**
   * In-flight restart, if one is running.
   *
   * The race between Run and Restart. A restart reset the queue, announced
   * 'restarting' and went off to wait for the kernel; a Run in that same second
   * put a cell into the queue and woke the pump, which saw a (still) live
   * kernel and sent execute to something already restarting. Such an execute
   * never gets an answer: the queue stands, the room sees "idle", and
   * `currentCell` stays taken until the next Restart.
   *
   * A promise, not a flag: both a second press of Restart and the pump wait for
   * the same thing, that very restart, not one of their own.
   */
  restarting: Promise<void> | null
  queue: QueueItem[]
  /** A targeted interrupt that must settle before the queue may start another job. */
  beforeNext: Promise<void> | null
  pumping: boolean
  currentCell: string | null
  /** Which press of Run the running cell came from; see stopBatchOf. */
  currentBatch: number | null
  /**
   * What was started and when, by the server's clock.
   *
   * A duplicate of the `startedAt` field in the document, and a deliberate one:
   * the whole room writes the document, while this number is what the duration
   * later shown as a fact is computed from. The live stopwatch grows from the
   * document; the duration comes from here.
   *
   * A pair, not a single number: `currentCell` is cleared in `runOne`'s
   * `finally` ONE LINE BEFORE `setCellState` is called, so the mark cannot be
   * tied to the cell through it: the duration would simply stop being
   * recorded, and only a test would notice.
   */
  started: { cellId: string; at: number } | null
  /** Who asked for the running cell — the server's own record, not the document's. */
  currentRunById: string | null
  /**
   * The cell that has just finished, and its batch.
   *
   * Needed for exactly one thing: a "stop" pressed on a cell at the moment it
   * managed to finish while the kernel had already taken the next one. Without
   * this record nothing is left of the press's target, and the batch of what
   * was running at that moment got cancelled, i.e. someone else's.
   */
  lastFinished: { cellId: string; batch: number } | null
  /**
   * When this scope last did anything, by the server's clock.
   *
   * Only for the idle cleanup of PERSONAL notebooks: they have their own count
   * (see `sweepIdleOwnScopes`). Set when the kernel comes up and at every end
   * of work (cells and council attempts), i.e. at the same places where the
   * scope stops being busy. `null` before the first start: there is nothing to
   * shut down yet.
   */
  lastWorkAt: number | null
  writer: OutputWriter | null
  /**
   * "Do not evict the room": the writer holds the `Y.Doc` longer than one call.
   *
   * An empty room is evicted from memory after ten minutes (collab ·
   * sweepIdleRooms), and eviction destroys the document. The writer, though,
   * took it in its constructor (outputs.ts · OutputWriter) and writes into THIS
   * object until the end of the execution: writes into a destroyed one are seen
   * by nobody, silently. The computing window itself is covered from the collab
   * side (`atWork` does not let a room be evicted while the document has a
   * running cell, a queue or a busy kernel); this is insurance for the gap
   * between the end of a run and `writer` being cleared. `dropWriter` owns it
   * and is also what releases it.
   */
  writerHold: (() => void) | null
  /** An attempt, not a cell, is computing; `currentCell` is then its synthetic name. */
  job: ActiveJob | null
  /** The limit alarm on the current work, shared by cells and attempts. See `RunLimit`. */
  limit: RunLimit | null
  /**
   * Which environment this room's kernel actually came up on.
   *
   * Not the same as "the environment configured right now": switching rebuilds
   * and restarts the container, but a room that was already running keeps the
   * Python it started with until its own kernel is replaced. The panel says so
   * in the footnote; this is what makes the column able to say it too.
   */
  environment: string | null
  /**
   * The seminar is closed (deleted or removed for idleness): this runtime is no
   * longer its.
   *
   * `shutdownSession` takes the runtime off the map, but a kernel start begun
   * before that lives out its minute on the captured object, and everything it
   * writes goes through `getSessionDoc`, which creates the document anew. The
   * deleted room came back into memory, and with it a folder with a new
   * session.ipynb and a line in the history. The rule is the same as in collab:
   * only what a person does has the right to create a document.
   */
  retired: boolean
  /**
   * What this kernel has ALREADY been told about dangerous commands, in that
   * very line.
   *
   * The source itself serves as the fingerprint (danger.ts ·
   * guardPolicySource): it holds both the room rule and the refusal language,
   * so comparing with what was said before catches both a rule switch in the
   * middle of class and a change of the instance language, and costs not a
   * single extra trip to the kernel per cell.
   *
   * `null`: the kernel has not been told anything yet, or what was said no
   * longer holds: a fresh process, a restart, Jupyter's own restart after an
   * OOM. While this is `null`, the queue is not let through (`ensureGuard`).
   */
  guard: string | null
  /**
   * The lost machine placement this scope was ended for (`loseSlot`), as
   * `runner:gen`: a failover is told to the room once, whichever of its
   * signals (the placement's event, the pump's gate, a start's rejection)
   * comes first. Cleared when a kernel comes up again.
   */
  lostKey: string | null
  /** Set while the pump waits at its slot's placement gate (§5.3); retiring the scope ends the wait. */
  gateWait: { controller: AbortController; view: MachineView } | null
  /**
   * The slot's machine was lost while this scope's kernel was still coming
   * up there (`loseSlot`): the room's sentence about it, said once already.
   * The start then fails as that loss (`StartLost`), not as a kernel that did
   * not come up. Cleared when the next start begins.
   */
  startLost: string | null
  /**
   * A worker of the council's pool (remote-classes.md §9.5), not a
   * notebook's scope: its kernel is a session of the class's council
   * container, its queue holds one attempt at most, given to it by
   * kernel/council-pool.ts, and its root (`<root>~w<n>`) is no notebook's.
   * A HIDDEN RUNTIME WRITES NOTHING TO THE ROOM'S DOCUMENT: no status, no
   * queue mirror, no notes, no placement, no cell states (`hidden`).
   */
  pool?: WorkerTie
}

/** What a worker's runtime knows of its pool: the council notebook whose epoch it loads, and its number there. */
export interface WorkerTie {
  readonly root: string
  readonly n: number
}

/** A worker of the council's pool: nothing of it reaches the room's document. */
const hidden = (runtime: Runtime): boolean => runtime.pool !== undefined

/** Workers whose Python restarted by itself and has not answered since: their pool loads them once it does (`onPhase`). */
const comingBack = new WeakSet<Runtime>()

/**
 * Execution scopes: class → notebook root → its kernel with a queue.
 *
 * A nested map, not a flat one with a compound key, and this matters: half the
 * work here is "everything belonging to this class" (shut down, count, clean up
 * for idleness), and a glued key would turn each such question into parsing a
 * string. An inner map left empty is removed at once: a class without scopes
 * must not take up memory until a restart.
 */
const runtimes = new Map<string, Map<string, Runtime>>()
const workspaceListeners: Array<(sessionId: string) => void> = []

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Which container to compute this notebook in.
 *
 * By the STORED rules, not the effective ones, and that is no trifle:
 * `rulesAfterClass` does not carry the `books` map over at all, so after the
 * bell the effective rules answer "room" for every notebook, and the very first
 * run after the end of class would move a personal notebook's kernel into the
 * lecture container, to its GPU and its memory limit. The end of class is about
 * rights, not placement.
 */
function roleOfBook(sessionId: string, root: string): KernelRole {
  try {
    return bookHasOwnKernel(storedRules(sessionId), root) ? 'own' : 'room'
  } catch {
    // There is no class row in the database (a test, a deleted room): count it
    // as a room notebook; that is the old behaviour and the only container that
    // surely exists.
    return 'room'
  }
}

/**
 * After how many seconds a cell in this room stops by itself; `null` means
 * never.
 *
 * By the STORED rules, and by construction there is no difference from the
 * effective ones here: `rulesAfterClass` carries this number over as is (the
 * end of class is about rights, not about how long the kernel may compute).
 * Asked of the ROOM's rules, not the notebook's: `rulesForBook` does not touch
 * the limit, and a student's personal notebook lives under the same ceiling:
 * its kernel is its own, but the CPU is shared across the machine.
 *
 * No class row in the database (a test, a deleted room) means no limit: that
 * is the old behaviour, and erring here is only allowed in that direction.
 */
function cellLimitOf(sessionId: string): number | null {
  try {
    return storedRules(sessionId).cellLimitSec
  } catch {
    return null
  }
}

/**
 * Whether not to execute dangerous commands in this room (rules.ts · `danger`).
 *
 * By the STORED rules, and by construction there is no difference from the
 * effective ones here: `rulesAfterClass` carries this field over as is; the end
 * of class is about rights, and the guard stays as it was. Asked of the ROOM's
 * rules, not the notebook's: `rulesForBook` does not touch it, and a student's
 * personal notebook lives under the same guard: its process is its own, but
 * the trouble is the same.
 *
 * No class row in the database (a test, a deleted room) means we guard: the
 * default here is strict, and erring is only allowed in that direction.
 */
function dangerBlocked(sessionId: string): boolean {
  try {
    return storedRules(sessionId).danger !== 'allow'
  } catch {
    return true
  }
}

function getRuntime(sessionId: string, root: string): Runtime {
  let scopes = runtimes.get(sessionId)
  if (!scopes) {
    scopes = new Map<string, Runtime>()
    runtimes.set(sessionId, scopes)
  }
  let runtime = scopes.get(root)
  if (!runtime) {
    runtime = {
      sessionId,
      root,
      role: roleOfBook(sessionId, root),
      kernel: null,
      starting: null,
      restarting: null,
      queue: [],
      beforeNext: null,
      pumping: false,
      currentCell: null,
      currentBatch: null,
      started: null,
      currentRunById: null,
      lastFinished: null,
      lastWorkAt: null,
      writer: null,
      writerHold: null,
      job: null,
      limit: null,
      environment: null,
      retired: false,
      guard: null,
      lostKey: null,
      gateWait: null,
      startLost: null,
    }
    scopes.set(root, runtime)
  }
  return runtime
}

/** The scope, if it already exists. A question must not start a Python for the room. */
function peekRuntime(sessionId: string, root: string): Runtime | undefined {
  return runtimes.get(sessionId)?.get(root)
}

/** All scopes of ONE class, across all its notebooks. */
function scopesOf(sessionId: string): Runtime[] {
  const scopes = runtimes.get(sessionId)
  return scopes ? [...scopes.values()] : []
}

/** All scopes of all classes in this process. */
function allScopes(): Runtime[] {
  const out: Runtime[] = []
  for (const scopes of runtimes.values()) out.push(...scopes.values())
  return out
}

/** Remove the scope from the map, and the class itself if it has no scopes left. */
function forgetScope(runtime: Runtime): void {
  const scopes = runtimes.get(runtime.sessionId)
  if (!scopes) return
  if (scopes.get(runtime.root) === runtime) scopes.delete(runtime.root)
  if (scopes.size === 0) runtimes.delete(runtime.sessionId)
}

/**
 * Which notebook a cell lives in, and `cells` if it is no longer in the room.
 *
 * The fallback answer is needed for cells deleted while they were waiting in
 * the queue: there is nowhere left in the document to look up their scope, and
 * saying "nowhere" would leave the queue entry there forever. The real callers
 * for whom the scope matters ask `rootOfCell` themselves and can handle `null`.
 */
function rootOf(sessionId: string, cellId: string): string {
  try {
    return rootOfCell(getSessionDoc(sessionId).doc, cellId) ?? CELLS_KEY
  } catch {
    return CELLS_KEY
  }
}

/** The root name from the cell array itself: `findCell` returns it with the cell. */
function rootOfArray(cells: Y.Array<YCell>): string | null {
  try {
    return Y.findRootTypeKey(cells)
  } catch {
    return null
  }
}

/**
 * Whose work this is, by the queue entry's name and not only by the document.
 *
 * The live scopes are asked first, and that is not an optimisation. Not only
 * cells stand in the queue: a council attempt has a synthetic name
 * (`councilQueueId`), and there is no cell with such a name in the document at
 * all; its scope can only be found where it lives. A cell that was deleted
 * while it waited is found the same way.
 *
 * The document is the second question and the ordinary case: the cell exists,
 * but no scope has been created for it yet. `fallback` is the caller's last
 * word: the notebook the press came from.
 */
function scopeOfCell(sessionId: string, cellId: string, fallback: string): string {
  for (const scope of scopesOf(sessionId)) {
    if (scope.currentCell === cellId || scope.queue.some((item) => item.cellId === cellId)) {
      return scope.root
    }
  }
  try {
    return rootOfCell(getSessionDoc(sessionId).doc, cellId) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Finish with the output writer: flush what has accumulated and release the
 * room.
 *
 * One place for every end of an execution (an empty cell, `runOne`'s `finally`,
 * a dead kernel, the end of a seminar, a server stop), because exactly one
 * thing can be forgotten here, and silently: `holdRoom` is not released, and a
 * room nobody will come back to stays in memory forever. A repeated call is
 * safe: both `dispose` and "release" are idempotent.
 */
function dropWriter(runtime: Runtime): void {
  runtime.writer?.dispose()
  runtime.writer = null
  runtime.writerHold?.()
  runtime.writerHold = null
}

/* --------------------------------------------------------- document mirror */

/**
 * The kernel state of ONE notebook goes into the `meta.kernels` map, and for
 * the room's notebook also into the old key.
 *
 * The mirror is not a transitional crutch but three live readers. A tab opened
 * before the deploy knows only `kernelStatus` and will know only that until the
 * page is reloaded. Snapshots in the version history keep the old shape, and
 * the timeline has to open. And the reset of stuck state (shared/notebook.ts ·
 * clearStaleWork) repairs both records at once, because a dead process can
 * leave both behind.
 *
 * Exactly `cells`, the room's notebook, is mirrored. Putting the state of
 * "some" notebook there would mean an old tab shows the lecture one moment and
 * the seminar the next, depending on who pressed last.
 */
function setStatus(runtime: Runtime, status: KernelStatus): void {
  // A pool's worker has no notebook entry: its state is the console's (CouncilKernel.pool), never the room's.
  if (runtime.retired || hidden(runtime)) return
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  const mirrored = runtime.root === CELLS_KEY
  const entry = kernelsMap(doc)?.get(runtime.root)
  const known = entry instanceof Y.Map ? entry.get(KERNEL_STATUS_FIELD) : undefined
  /*
   * Into the old key goes a compatible word: a tab opened before 20 Sep 2026
   * does not know `off` at all, and its badge would stay empty
   * (shared/notebook.ts · `legacyKernelStatus`). The whole truth lies in the
   * map the new ones read.
   */
  const legacy = legacyKernelStatus(status)
  if (known === status && (!mirrored || meta.get('kernelStatus') === legacy)) return
  doc.transact(() => {
    kernelEntry(doc, runtime.root).set(KERNEL_STATUS_FIELD, status)
    if (mirrored) meta.set('kernelStatus', legacy)
  }, ORIGIN)
}

/**
 * Why the last start-up did not work, as a word for advice to the teacher, or
 * nothing (see shared/kernel-problem.ts). If the kernel came up or failed for
 * another reason, the previous word is removed: the advice "reduce memory" for
 * a room that Jupyter does not answer would be untrue.
 */
function setKernelProblem(runtime: Runtime, problem: KernelProblem | null): void {
  if (runtime.retired || hidden(runtime)) return
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  const mirrored = runtime.root === CELLS_KEY
  const entry = kernelsMap(doc)?.get(runtime.root)
  const had = entry instanceof Y.Map && entry.get(KERNEL_PROBLEM_KEY) != null
  if (problem === null && !had && !(mirrored && meta.has(KERNEL_PROBLEM_KEY))) return
  doc.transact(() => {
    const slot = kernelEntry(doc, runtime.root)
    if (problem === null) slot.delete(KERNEL_PROBLEM_KEY)
    else slot.set(KERNEL_PROBLEM_KEY, { ...problem })
    if (!mirrored) return
    if (problem === null) meta.delete(KERNEL_PROBLEM_KEY)
    else meta.set(KERNEL_PROBLEM_KEY, { ...problem })
  }, ORIGIN)
}

/**
 * The narrowest edit of a list: what to remove and what to insert so that
 * `current` becomes `next`.
 *
 * The queue changes in two ways, both at the edges: a cell went to work (the
 * first element disappeared) or joined the tail (a last one appeared). A full
 * rewrite turned each of them into "delete everything and put everything":
 * with five hundred participants and the "one at a time" rule that is hundreds
 * of identifiers in a Yjs update, on EVERY start and EVERY end of a cell, to
 * the whole room, plus as many tombstones in the document and an extra
 * `record()` pass in the history.
 *
 * Computed by a common head and a common tail, not by a "smart" diff: the
 * queue is a list without repeats, and that is enough for the two ordinary
 * cases to cost one operation. A pure function, and that is what has to be
 * proved.
 */
export function queueDelta(
  current: string[],
  next: string[],
): { at: number; remove: number; insert: string[] } {
  let head = 0
  while (head < current.length && head < next.length && current[head] === next[head]) head++
  let tail = 0
  while (
    tail < current.length - head &&
    tail < next.length - head &&
    current[current.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++
  }
  return {
    at: head,
    remove: current.length - head - tail,
    insert: next.slice(head, next.length - tail),
  }
}

/**
 * Who wants to know that a notebook's queue has moved, even when it moved for
 * nothing.
 *
 * The queue mirror in the document (below) covers only CELLS: council attempts
 * deliberately do not go into it, they have no cell the room could highlight.
 * So the teacher's console, looking at the notebook's queue, saw neither
 * someone else's cell occupying the kernel nor the length of the real queue,
 * and wrote "nothing is running in this cell" next to "queued: 12". The
 * subscription is the only point from which all of it is visible.
 *
 * Called FROM `syncQueue`, i.e. on every queue shift and every change of work,
 * before all of its "did the mirror change" checks: the mirror may not have
 * changed (attempts do not go into it) while the queue did. Thinning out the
 * frames is the subscriber's business.
 */
const queueWatchers: Array<(sessionId: string, root: string) => void> = []

export function onKernelQueueChanged(cb: (sessionId: string, root: string) => void): void {
  queueWatchers.push(cb)
}

function tellQueueWatchers(runtime: Runtime): void {
  for (const cb of queueWatchers) {
    try {
      cb(runtime.sessionId, runtime.root)
    } catch (err) {
      // Someone else's handler must not be able to bring the pump down: the
      // same argument as for `tellJob`.
      console.error(`[kernel] queue watcher failed for ${runtime.sessionId}:`, errText(err))
    }
  }
}

function syncQueue(runtime: Runtime): void {
  if (runtime.retired) return
  tellQueueWatchers(runtime)
  // A pool's worker computes attempts only, and has no mirror: the console hears of it through the watchers above.
  if (hidden(runtime)) return
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  const mirrored = runtime.root === CELLS_KEY
  // Council attempts do not go into the mirror: they have no cell the room
  // could highlight, and the "2 queued" chip is honest anyway: it is about the
  // sheet. Nor does the export of the council's epoch (§9.2): no cell runs.
  const ids = runtime.queue.filter((item) => !item.council && !item.service).map((item) => item.cellId)
  const running = runtime.job ? null : (runtime.currentCell ?? null)

  const entry = kernelsMap(doc)?.get(runtime.root)
  const existing = entry instanceof Y.Map ? entry.get(KERNEL_QUEUE_FIELD) : undefined
  const current = existing instanceof Y.Array ? (existing.toArray() as string[]) : null
  const queueUnchanged =
    current !== null && current.length === ids.length && current.every((id, i) => id === ids[i])
  const runningUnchanged =
    entry instanceof Y.Map && (entry.get(KERNEL_RUNNING_FIELD) ?? null) === running
  if (queueUnchanged && runningUnchanged) {
    // The mirror could fall behind by itself only in a room with an old
    // snapshot; the check is cheaper than a transaction and prevents a silent
    // divergence.
    if (!mirrored) return
    const legacy = meta.get('queue')
    const sameLegacy =
      legacy instanceof Y.Array &&
      legacy.length === ids.length &&
      (legacy.toArray() as string[]).every((id, i) => id === ids[i])
    if (sameLegacy && (meta.get('runningCell') ?? null) === running) return
  }

  doc.transact(() => {
    const slot = kernelEntry(doc, runtime.root)
    writeQueue(slot, KERNEL_QUEUE_FIELD, ids, queueUnchanged)
    slot.set(KERNEL_RUNNING_FIELD, running)
    if (!mirrored) return
    writeQueue(meta, 'queue', ids, false)
    meta.set('runningCell', running)
  }, ORIGIN)
}

/**
 * Write the list of waiting cells with a narrow edit, the same as before.
 *
 * A full rewrite turned every start and every end of a cell into "delete
 * everything and put everything": hundreds of identifiers in a Yjs update on
 * EVERY step of the queue, to the whole room. See `queueDelta`.
 */
function writeQueue(
  holder: Y.Map<any>,
  key: string,
  ids: string[],
  unchanged: boolean,
): void {
  let list = holder.get(key) as Y.Array<string> | undefined
  if (!(list instanceof Y.Array)) {
    list = new Y.Array<string>()
    holder.set(key, list)
  } else if (unchanged) return
  const delta = queueDelta((list.toArray() as string[]) ?? [], ids)
  if (delta.remove > 0) list.delete(delta.at, delta.remove)
  if (delta.insert.length > 0) list.insert(delta.at, delta.insert)
}

/**
 * Send one cell to the kernel, bringing a new one up if the old one turns out
 * to have died while nobody was looking. Retries once and only for that: a
 * kernel that dies *during* the run is a real failure the room needs to see.
 */
async function runOnKernel(
  runtime: Runtime,
  source: string,
  handlers: Parameters<JupyterKernel['execute']>[1],
  opts?: Parameters<JupyterKernel['execute']>[2],
): Promise<ExecuteStatus> {
  try {
    return await runtime.kernel!.execute(source, handlers, opts)
  } catch (err) {
    if (runtime.kernel && runtime.kernel.phase !== 'dead') throw err
    /*
     * The scope is closed: a kernel must NOT be brought up for it again.
     *
     * Both an ordinary kernel death during a break comes here (then a fresh
     * kernel is exactly what is needed) and the end of a scope: the seminar was
     * deleted, the notebook removed, its access changed. In the second case a
     * start-up would create a new container and a new Python for a notebook
     * that no longer exists, and would write into a document that is being
     * evicted at that moment.
     */
    if (runtime.retired) throw err
    /*
     * Nor for a kernel ended from outside: its machine was lost, and the cell
     * that was on its way there is the room's to run again (the failover's
     * words say so), not this function's to run quietly somewhere else on a
     * kernel without the variables it was written against.
     */
    if (runtime.kernel?.endedBy) throw err
    /*
     * Nor for a worker of the council's pool: a fresh kernel there holds no
     * epoch, and an attempt run quietly on it would compute on nothing. Its
     * death is the attempt's, and the pool recycles the worker (§9.5).
     */
    if (hidden(runtime)) throw err
    kernelNote(
      runtime.sessionId,
      tr("server.theKernelHadStoppedStartingAFresh.65e2e2"),
    )
    await ensureKernel(runtime.sessionId, runtime.root)
    /*
     * The stopwatch is restarted once there finally is a kernel.
     *
     * Bringing up a cold container takes up to a minute and a half, and it
     * counted against the cell: a one-liner reported a minute and a half of
     * work, although it computed for milliseconds. And it was not the one being
     * waited for.
     */
    restamp(runtime)
    return await runtime.kernel!.execute(source, handlers, opts)
  }
}

/** Mark the start of the execution anew, in the runtime and in the document. */
function restamp(runtime: Runtime): void {
  const cellId = runtime.currentCell
  if (!cellId) return
  const at = Date.now()
  runtime.started = { cellId, at }
  // The limit is restarted too, by the same argument as the stopwatch: a minute
  // and a half of bringing up a cold kernel is not run time, and it is unfair
  // for a thirty-second limit to burn out in it. This applies to both a cell
  // and an attempt: there is one limit record for both (`RunLimit`), and
  // `startOfLimit` reads the same mark the line above has just moved.
  if (runtime.limit?.item.cellId === cellId) armLimit(runtime)
  const { doc } = getSessionDoc(runtime.sessionId)
  const found = findCell(doc, cellId)
  if (found) doc.transact(() => found.cell.set('startedAt', at), ORIGIN)
}

/**
 * The only door out of 'running', and so the only place where the stopwatch is
 * stopped.
 *
 * All three ends of an execution come here: an empty cell, an ordinary finish
 * and `reportDeadKernel`. A throw from `execute` too: `runOne` catches it
 * itself and reaches this same line. So the three keys, `state`, `startedAt`
 * and `ranMs`, are kept consistent here rather than in three places apart.
 *
 * `ranMs` is written only for outcomes that really ended in something: an
 * interrupted execution has no finish time, and printing one next to `Out [n]`
 * would announce a result that did not happen. The `was === 'running'` check
 * is there for `reportDeadKernel`: it comes here also for cells that stood in
 * the queue and never started.
 */
function setCellState(sessionId: string, cellId: string, state: CellState): void {
  const { doc } = getSessionDoc(sessionId)
  const found = findCell(doc, cellId)
  if (!found) return
  /*
   * The duration is counted from the server's record, not from the document
   * field.
   *
   * `startedAt` lies in the shared document, and anyone in the room writes it:
   * that is the product's design, not a hole. Counting the duration from it
   * would let any student write "ran for three hours" for the teacher to see.
   * The field in the document stays what it was: the number the stopwatch in
   * the browser grows from. The real start time is kept by the server.
   */
  // By scopes: a cell belongs to one notebook, but the start mark is held by
  // the scope that ran it, and only that scope knows which one it is.
  const runtime = scopesOf(sessionId).find((scope) => scope.started?.cellId === cellId)
  const startedAt = runtime?.started?.at ?? null
  doc.transact(() => {
    const was = found.cell.get('state') as CellState | undefined
    found.cell.set('state', state)
    if (found.cell.get('startedAt') != null) found.cell.set('startedAt', null)
    if (was === 'running' && (state === 'ok' || state === 'error') && startedAt !== null) {
      found.cell.set('ranMs', Math.max(0, Date.now() - startedAt))
    }
  }, ORIGIN)
  if (runtime) runtime.started = null
}

/**
 * How often it makes sense for one room to sweep for ghosts.
 *
 * There are three triggers (the heartbeat, a press, a control socket
 * connecting), and all three come in bursts: after a server restart five
 * hundred tabs come back within two seconds, and that is five hundred
 * transactions over every cell of every notebook of ONE room in exactly the
 * second when the whole audience is waiting for sync. What this pass repairs is
 * what a dead process left behind: it is already in the document and will be
 * found by the very first call, not the five-hundredth.
 */
const ORPHAN_SWEEP_EVERY_MS = 2000

/** When this room was last swept, by the server's clock. */
const orphanSweeps = new Map<string, number>()

/**
 * Cells the document considers running while the server knows nothing of them.
 *
 * `clearStaleExecution` runs once, when the room comes up, and that is not
 * enough. A tab open at the moment the server crashed keeps its updates and on
 * reconnecting merges them back as they are. Yjs decides per key and by the
 * last write, so a 'running' from a dead process can survive the reset, and
 * before this fix such a cell simply sat there quietly. Now it breathes and
 * counts seconds until the end of class: the animation made an old quiet
 * trouble loud, and it has to be fixed here.
 *
 * `scopesOf`, not `getRuntime`: a room where nobody ran anything must not
 * acquire a runtime from one check. The pass goes over ALL scopes of the class:
 * it has as many kernels as notebooks, and a stuck cell can be in any of them.
 *
 * The rejected option was hanging a deferred pass on `doc.on('update')` in
 * collab. That is the precise moment, and also a cycle: the kernel takes
 * `getSessionDoc` from collab, so a reverse import would tie the modules to
 * each other. Three cheap triggers are better than one beautiful cycle.
 *
 * `now` is the caller's clock: the window between passes
 * (ORPHAN_SWEEP_EVERY_MS) can be checked from a test without waiting for it
 * live, the same trick as collab · sweepIdleRooms.
 */
export function sweepOrphanRuns(sessionId: string, now: number = Date.now()): number {
  // This room was swept just now; there is no need for a second time. The
  // check comes before `getSessionDoc`: walking the document is exactly the
  // cost the window exists for.
  const last = orphanSweeps.get(sessionId)
  if (last !== undefined && now - last < ORPHAN_SWEEP_EVERY_MS) return 0
  orphanSweeps.set(sessionId, now)
  const scopes = scopesOf(sessionId)
  const { doc } = getSessionDoc(sessionId)
  // Across all of the room's notebooks: each has its own kernel and its own
  // queue, and a stuck cell can be in any open one.
  const cells = allCellArrays(doc).flatMap((array: Y.Array<YCell>) => array.toArray())
  let repaired = 0

  doc.transact(() => {
    for (const cell of cells) {
      const state = cell.get('state')
      if (state !== 'running' && state !== 'queued') continue
      const id = idOf(cell)
      const ours = scopes.some(
        (scope) => scope.currentCell === id || scope.queue.some((q) => q.cellId === id),
      )
      if (ours) continue
      cell.set('state', 'idle' as CellState)
      cell.set('startedAt', null)
      // The kernel's question goes out along with the state.
      //
      // A cell stopped in input() carries `stdin`, from which the answer form
      // is drawn. Clearing the state and leaving the form would show the room an
      // input field with nobody behind it any more: there is no one to answer,
      // "Send" goes into the void, and there is no way to take it off the
      // screen.
      if (cell.get('stdin') != null) cell.set('stdin', null)
      repaired++
    }
  }, ORIGIN)

  /*
   * Half a ghost is a ghost too.
   *
   * Besides the cells' state, the same dead process leaves its mirror in meta
   * behind: `runningCell`, `queue` and `kernelStatus`. Only the server writes
   * them and the client reads them, and it reads from them the "2 queued" chip
   * in the panel, the "Maria — running cell 05" line in the people list, and
   * whether to draw the room's Interrupt enabled. Cleaning the cells and
   * leaving the mirror would mean fixing what is visible and leaving what the
   * counting is based on.
   *
   * `syncQueue` can do exactly that and writes nothing itself when the mirror
   * is already right. When there is no runtime at all (and that is the case
   * after a restart), we clean directly, as clearStaleExecution does.
   */
  if (repaired > 0) {
    const live = new Set(scopes.map((scope) => scope.root))
    for (const scope of scopes) syncQueue(scope)
    /*
     * And for the notebooks that have NO scope in this process.
     *
     * That is exactly the case after a server restart: the record in the
     * document is left over from a dead process, and creating a scope for it
     * would mean bringing up a Python for the room from one check. We clean
     * directly, the same as clearStaleExecution does, only now across the map.
     */
    const meta = getMeta(doc)
    const roots = new Set<string>([CELLS_KEY, ...bookList(doc).map((book) => book.root)])
    const known = kernelsMap(doc)
    if (known) for (const root of known.keys()) roots.add(root)
    doc.transact(() => {
      for (const root of roots) {
        if (live.has(root)) continue
        const entry = known?.get(root)
        if (entry instanceof Y.Map) {
          const queue = entry.get(KERNEL_QUEUE_FIELD)
          if (queue instanceof Y.Array && queue.length > 0) queue.delete(0, queue.length)
          if (entry.get(KERNEL_RUNNING_FIELD) != null) entry.set(KERNEL_RUNNING_FIELD, null)
          const state = entry.get(KERNEL_STATUS_FIELD)
          if (state === 'busy' || state === 'restarting') {
            entry.set(KERNEL_STATUS_FIELD, 'idle' as KernelStatus)
          }
        }
        if (root !== CELLS_KEY) continue
        const queue = meta.get('queue')
        if (queue instanceof Y.Array && queue.length > 0) queue.delete(0, queue.length)
        if (meta.get('runningCell') != null) meta.set('runningCell', null)
        const status = meta.get('kernelStatus')
        if (status === 'busy' || status === 'restarting') {
          meta.set('kernelStatus', 'idle' as KernelStatus)
        }
      }
    }, ORIGIN)
  }

  // runBy, runById, execCount, ranMs and the output stay: the same position as
  // clearStaleExecution's: we stop what is happening and do not touch what has
  // happened.
  return repaired
}

/** Queued work the kernel will never get to; put those cells back to rest. */
function dropQueue(runtime: Runtime): void {
  if (runtime.queue.length === 0) {
    syncQueue(runtime)
    return
  }
  const dropped = runtime.queue.splice(0, runtime.queue.length)
  const { doc } = getSessionDoc(runtime.sessionId)
  doc.transact(() => {
    for (const item of dropped) {
      const found = findCell(doc, item.cellId)
      if (found && found.cell.get('state') === 'queued')
        found.cell.set('state', 'idle' as CellState)
    }
  }, ORIGIN)
  releaseCouncil(runtime, dropped)
  syncQueue(runtime)
}

/**
 * Attempts taken off the queue without running: their authors have to be told.
 *
 * For a cell the same news goes into the document (`state: 'idle'`), and the
 * room sees it by itself. An attempt has no document: not calling would leave
 * "queued" on the card until the end of class. `null` means "there was no
 * run"; see CouncilJob.
 */
function releaseCouncil(runtime: Runtime, dropped: QueueItem[]): void {
  for (const item of dropped) {
    finishExecution(runtime, item, 'cancelled')
    if (item.council) tellJob(item.council, null)
    // An epoch's export dropped with the queue (a restart, a death, a stop): the pool hears there was none.
    if (item.service) answerService(item.service, { refused: 'dropped' })
  }
}

/** Service runs already answered: each is answered once, whichever end reaches it first. */
const answered = new WeakSet<ServiceJob>()

/** A service run is answered once, and its listener never brings the pump down. */
function answerService(job: ServiceJob, answer: Parameters<ServiceJob['done']>[0]): void {
  if (answered.has(job)) return
  answered.add(job)
  try {
    job.done(answer)
  } catch (err) {
    console.error(`[kernel] a service listener failed (${job.kind}):`, errText(err))
  }
}

/** Another module's callback must not be able to bring the pump down. */
function tellJob(job: CouncilJob, run: CouncilRun | null): void {
  try {
    job.onChange(run)
  } catch (err) {
    console.error(`[kernel] council listener failed for ${job.cellId}:`, errText(err))
  }
}

/**
 * The window in which kernels do not die on their own.
 *
 * Switching the environment recreates the container, and every room that was
 * computing something at that moment loses its kernel at once. Each heard "The
 * kernel ran out of memory", a phrase right for ninety-nine crashes out of a
 * hundred and utterly false here. The teacher went looking for whose cell had
 * eaten the memory, but nobody had: an administrator had pressed "use this
 * environment".
 *
 * A window, not a per-room flag: the recreation goes across all containers at
 * once and stretches over seconds, while the only thing that knows about it is
 * one HTTP request that has already answered by then.
 */
let churn: { reason: string; until: number } | null = null

export function expectKernelChurn(reason: string, ms = 120_000): void {
  churn = { reason, until: Date.now() + ms }
}

function churnReason(): string | null {
  if (!churn) return null
  if (Date.now() > churn.until) {
    churn = null
    return null
  }
  return churn.reason
}

/** What was computing at death: a phrase for the room, a line for the journal, a cell for the post-mortem. */
interface DeathScene {
  /** "Kirill's attempt on cell 21" / "cell 21, run by Timur"; `null`: the kernel was idle. */
  what: string | null
  /**
   * The same for the machine's journal, with participant ids where the room
   * reads names: "attempt of p_x on cell 21" / "cell 21, run by p_y".
   *
   * Two phrases, not one, because the audiences differ. The room knows its
   * people, and the note is written for them; the journal is read by whoever
   * runs the machine, shipped to wherever the university keeps its logs, and
   * kept long after the class — log.ts promises that no participant's name
   * gets there. The id is enough to find the person in the room's own list.
   */
  logged: string | null
  /** The cell this relates to, for `explainDeath`; for an attempt, the council cell. */
  cellId: string | null
}

/**
 * Name what was running when the kernel went away.
 *
 * On 20 Sep 2026 a room lost its kernel nine times in eleven minutes, and each
 * time the note said exactly one thing: "variables were reset". It lacked the
 * only thing that settled the matter: WHAT was running. The killer was the same
 * two-line council attempt (`import os` / `os._exit(0)`), and the only way to
 * learn that was a database query the next day. The server has this knowledge
 * in that very second: `runtime.job` says whose attempt and on which cell,
 * `currentCell` and `currentRunById` say which cell and who pressed.
 *
 * The cell number is its position in its notebook, counting markdown: the same
 * one drawn in the room to its left. Otherwise the teacher goes looking for
 * "cell 11" where the screen says 21.
 *
 * The name may be missing (the participant left, the run was not from a
 * person); then the phrase is shorter by the name rather than filled in with an
 * invention.
 */
function whatWasRunning(runtime: Runtime): DeathScene {
  const job = runtime.job
  const cellId = job ? job.job.cellId : runtime.currentCell
  if (!cellId) return { what: null, logged: null, cellId: null }
  const doc = (() => {
    try {
      return peekSessionDoc(runtime.sessionId)?.doc ?? null
    } catch {
      return null
    }
  })()
  const found = doc ? findCell(doc, cellId) : null
  const cell = found ? found.index + 1 : null
  const nameOf = (id: string | null | undefined): string | null => {
    if (!id) return null
    try {
      return getParticipant(runtime.sessionId, id)?.name || null
    } catch {
      return null
    }
  }
  if (job) {
    const author = nameOf(job.job.participantId)
    const ran = nameOf(job.item.runById)
    const pressedBy = job.item.runById && job.item.runById !== job.job.participantId ? `, run by ${job.item.runById}` : ''
    return {
      cellId,
      logged: `attempt of ${job.job.participantId || '—'}${pressedBy} on cell ${cell ?? '?'}`,
      what:
        cell === null
          ? tr('server.kernel.diedOnAttemptNoCell', { author: author ?? '—' })
          : author === null
            ? tr('server.kernel.diedOnAttemptNoAuthor', { cell })
            : ran !== null && ran !== author
              ? tr('server.kernel.diedOnAttemptRunBy', { author, cell, ran })
              : tr('server.kernel.diedOnAttempt', { author, cell }),
    }
  }
  const ran = nameOf(runtime.currentRunById)
  return {
    cellId,
    logged: cell === null ? null : `cell ${cell}${runtime.currentRunById ? `, run by ${runtime.currentRunById}` : ''}`,
    what:
      cell === null
        ? null
        : ran === null
          ? tr('server.kernel.diedOnCell', { cell })
          : tr('server.kernel.diedOnCellRunBy', { cell, ran }),
  }
}

/**
 * How many times in a row this scope has lost its kernel, so as not to repeat
 * the same thing.
 *
 * Nine identical notes in eleven minutes told the teacher nothing beyond the
 * first, and drowned the one line about the cell that was all that was needed.
 * From the second time on, the note gives the count ("the third time in ten
 * minutes") and suggests an action (stop the queue), because with deaths in a
 * row it is not chance that is to blame but what the room runs again and
 * again.
 *
 * The window slides: half an hour of quiet and the count starts over, because
 * "the third time" about crashes spread over a whole class is not about one
 * trouble.
 */
const DEATH_WINDOW_MS = 10 * 60_000
const deaths = new Map<string, { count: number; at: number }>()

function countDeath(runtime: Runtime): number {
  const key = `${runtime.sessionId}/${runtime.root}`
  const now = Date.now()
  const seen = deaths.get(key)
  const count = seen && now - seen.at <= DEATH_WINDOW_MS ? seen.count + 1 : 1
  deaths.set(key, { count, at: now })
  return count
}

/** Room closed or kernel replaced: the crash count has no bearing on the new one. */
export function forgetDeaths(sessionId: string): void {
  for (const key of [...deaths.keys()]) {
    if (key === sessionId || key.startsWith(`${sessionId}/`)) deaths.delete(key)
  }
}

/**
 * Tell the room WHY the kernel went away.
 *
 * The first note goes out at once and tells the truth about the consequences:
 * the variables are gone, the queue is empty. The cause follows half a second
 * later, because it has to be fetched from docker, and waiting for it while
 * keeping the room in the dark would be worse than adding a second line. In
 * the kernel log these are two lines in a row, and they read as one thought:
 * what happened and why.
 *
 * The cell number is the one drawn in the room to its left: its position in
 * its notebook, counting markdown. Otherwise the teacher goes looking for
 * "cell 11" where the screen says 21.
 *
 * Promises nothing: `explain` returns `null` when there is nothing to say, and
 * silence here is a deliberate answer, not a lost error.
 */
function tellWhyItDied(runtime: Runtime, cellId: string | null): void {
  // A closed room gets silence: both the note and the cell lookup itself would
  // create its document anew, and there is nobody left to tell the cause to.
  // So does a pool's worker: its death costs one attempt, never the room's log (§9.7).
  if (runtime.retired || hidden(runtime)) return
  const doc = (() => {
    try {
      return getSessionDoc(runtime.sessionId).doc
    } catch {
      return null
    }
  })()
  const found = cellId && doc ? findCell(doc, cellId) : null
  const cell = found ? found.index + 1 : null
  // The post-mortem looks at THE container where the dead kernel lived:
  // personal notebooks have their own cgroup, memory limit and kill counter.
  void explainDeath(runtime.sessionId, cell, runtime.role)
    .then((why) => {
      if (!why) return
      // Into the machine's journal, with the same word `oom` this trouble is
      // already searched for with one grep, and with numbers that were never
      // there before.
      console.warn(`[kernel ${runtime.sessionId}] ${why.oom ? 'oom' : 'died'}: ${why.text}`)
      if (!runtime.retired) kernelNote(runtime.sessionId, why.text)
    })
    .catch(() => {
      /* A post-mortem that breaks the room's work is worse than no post-mortem. */
    })
}

function onPhase(runtime: Runtime, phase: KernelPhase, expected = false): void {
  /*
   * The process is changing: everything we told it no longer holds.
   *
   * A restart (by the button or on its own, after an OOM or after `os._exit`
   * on that one night when the guard was not installed yet) starts a NEW Python
   * that has neither our module nor the patches. If we forgot to clear the
   * fingerprint, we would consider the guard in place on a kernel without it,
   * and the next thirty cells would go into it as they are.
   */
  if (phase === 'restarting' || phase === 'dead') runtime.guard = null
  /*
   * A worker of the council's pool (remote-classes.md §9.5, §9.7): its
   * Python restarting by itself or dying costs the attempt it ran (which
   * reads so from its aborted execute) and never the room anything — no
   * status, no note, no post-mortem in the room's log. An attempt given to
   * it that had not started goes back to the notebook's queue, and the pool
   * recycles the worker.
   */
  if (hidden(runtime)) {
    const handle = handleOf(runtime)!
    if ((phase === 'restarting' && !expected) || phase === 'dead') {
      // Ended from outside, it went with its machine (or its placement): no fault of the worker's.
      giveBackQueue(runtime, phase === 'dead' ? 'its kernel died' : 'its kernel restarted by itself', runtime.kernel?.endedBy != null)
      console.warn(`[kernel ${runtime.sessionId}/${runtime.root}] council worker ${phase === 'dead' ? 'died' : 'restarted itself'}${runtime.job ? ' mid-attempt' : ''}`)
      // Its epoch went with its Python — an OOM kill of an idle worker included: loaded again before it serves (§9.5).
      poolSays('restarted', undefined, () => councilPool.restarted(handle, runtime.kernel?.endedBy != null))
      if (phase === 'restarting') comingBack.add(runtime)
    } else if (phase !== 'restarting' && comingBack.delete(runtime)) {
      // Its new process answers: the pool loads it now, not at the next attempt.
      poolSays('idle', undefined, () => councilPool.idle(handle))
    }
    return
  }
  /*
   * The notebook's kernel lost its Python: its council pool's epoch is behind
   * none of the teacher's runs before this moment (remote-classes.md §9.2: a
   * restart alone does not mark the epoch stale, the first history run after
   * it does). A cell found dead before it was sent runs on the fresh kernel
   * now, and keeps its run.
   */
  if (phase === 'restarting' || phase === 'dead') {
    const keep = phase === 'dead' && expected ? runtime.currentCell : null
    poolSays('mainReset', undefined, () => councilPool.mainReset(runtime.sessionId, runtime.root, keep))
  }
  /*
   * Jupyter restarting the kernel by itself — the container's OOM killer,
   * almost always. The process is gone and coming back under the same id, so
   * this is neither `dead` (nothing to start) nor an ordinary phase (there is
   * something to say). The cell that was running gets its KernelDied from the
   * aborted execute; what is said here is for the rest of the room, and the
   * queue is dropped because everything in it assumed variables that no longer
   * exist.
   */
  if (phase === 'restarting' && !expected) {
    const hadWork = runtime.currentCell !== null || runtime.queue.length > 0
    // What was running is taken BEFORE `dropQueue`: it carries the attempt away
    // with it, and without the attempt nothing is left of the most important
    // question ("whose cell?").
    const scene = whatWasRunning(runtime)
    dropQueue(runtime)
    setStatus(runtime, 'restarting')
    /*
     * And the execution numbers too, across the whole notebook, as a manual
     * Restart does.
     *
     * The process is new, there are no variables, yet `Out [12]` stays above
     * every past output and claims the opposite; the client also uses it to
     * decide whether to show "From an earlier run — the kernel restarted".
     * Without this line it was not just the one killed cell that lied, but the
     * whole notebook.
     */
    resetAllCells(runtime, runtime.currentCell)
    const known = churnReason()
    /*
     * Into the journal as a separate line, and WITHOUT a guessed cause.
     *
     * Until 20 Sep 2026 the word "oom" stood here when the cause was unknown: a
     * handy grep and, as it turned out, untrue. That day the room lost its
     * kernel nine times in a row, the journal said "oom" nine times, and the
     * post-mortem right there, a line below, objected: "did not end because of
     * memory, 5.2 GB of 16 in use". The killer was `os._exit(0)` in a council
     * attempt: the cgroup untouched, dmesg clean. One false line cost half a day
     * of hunting for a greedy cell that did not exist.
     *
     * Now the line says exactly what is known NOW: the kernel restarted itself,
     * the cause is still being found out. The real cause is printed by the
     * post-mortem (`tellWhyItDied`), with the word `oom` only where the cgroup
     * confirmed it, and the word `died` in all other cases. The greps for
     * `[kernel` and `oom:` still work, and the lying has stopped.
     */
    const again = known ? 0 : countDeath(runtime)
    console.warn(
      `[kernel ${runtime.sessionId}] restarted itself — ${known ? `churn: ${known}` : 'cause unknown'}` +
        `${scene.logged ? ` · ${scene.logged}` : ''}${again > 1 ? ` · ${again} in 10 min` : ''}`,
    )
    kernelNote(
      runtime.sessionId,
      known
        ? tr("server.everyVariableIsGone.eff831", { p0: known, p1: hadWork ? '; whatever was queued was dropped' : '' })
        : [
            hadWork
              ? tr("server.theKernelRestartedUnexpectedlyVariablesWereReset.f87dd9")
              : tr("server.theKernelRestartedUnexpectedlyVariablesWereReset.a76c88"),
            scene.what,
            again > 1 ? tr('server.kernel.diedAgain', { count: again }) : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' '),
    )
    // An environment rebuild is explained without docker; docker explains the rest.
    if (!known) tellWhyItDied(runtime, scene.cellId)
    return
  }
  if (phase === 'dead') {
    /*
     * Found by asking, before the cell was sent: the run is about to be retried
     * on a fresh kernel and will say so itself. Two notices, one of them about a
     * cell that then runs perfectly well, is worse than one.
     *
     * And the queue is left alone: it stood BEHIND this cell and will go on the
     * same fresh kernel. `dropQueue` used to stand above this check, and Run All
     * on a kernel that died during a break ran exactly one cell: the rest
     * silently went back to rest (there is no note about them, since the
     * `return` comes earlier), together with other people's batches, contrary to
     * the promise that "a failure stops only its own". There is no failure here
     * anyway: the kernel is replaced before sending.
     */
    if (expected) {
      setStatus(runtime, 'dead')
      return
    }
    /*
     * Ended from outside: its machine was lost, or this server took the
     * placement back (remote-classes.md §5.2). Nothing in the room crashed, so
     * there is neither a death to count nor a post-mortem to ask docker for:
     * the room reads the kernel's own words (`endedBy.words`), and the queue
     * goes, because every cell in it counted on variables that are gone. The
     * chip says «не запущено»: the next Run brings a kernel up wherever the
     * class computes now. When `loseSlot` ended it, both lines were said
     * already, once for the whole slot; any other end is said here.
     */
    const ended = runtime.kernel?.endedBy ?? null
    if (ended) {
      const hadWork = runtime.currentCell !== null || runtime.queue.length > 0
      dropQueue(runtime)
      setStatus(runtime, 'off')
      console.warn(`[kernel ${runtime.sessionId}/${runtime.root}] ended from outside (${ended.cause})${hadWork ? ' mid-run' : ''}`)
      if (runtime.lostKey === null) {
        kernelNote(runtime.sessionId, ended.words)
        if (hadWork) kernelNote(runtime.sessionId, tr(QUEUE_DROPPED))
      }
      return
    }
    const hadWork = runtime.currentCell !== null || runtime.queue.length > 0
    // As with a restart: who computed what is taken only before `dropQueue`.
    const scene = whatWasRunning(runtime)
    dropQueue(runtime)
    setStatus(runtime, 'dead')
    // The post-mortem below honestly says why the kernel went; here, what happened.
    const known = churnReason()
    const again = known ? 0 : countDeath(runtime)
    // A kernel's death is what stops a class; in the journal it must be a line,
    // not only a note in the notebook that goes away together with it.
    console.warn(
      `[kernel ${runtime.sessionId}] died${hadWork ? ' mid-run' : ''}${known ? ` — churn: ${known}` : ''}` +
        `${scene.logged ? ` · ${scene.logged}` : ''}${again > 1 ? ` · ${again} in 10 min` : ''}`,
    )
    kernelNote(
      runtime.sessionId,
      known
        ? tr("server.runACellToStartAFresh.ffee95", { p0: known, p1: hadWork ? tr("server.whateverWasQueuedWasDropped.752abc") : '' })
        : [
            hadWork
              ? tr("server.theKernelStoppedDuringExecutionQueuedCells.74ec64")
              : tr("server.theKernelStoppedRestartItToRun.911803"),
            scene.what,
            again > 1 ? tr('server.kernel.diedAgain', { count: again }) : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' '),
    )
    if (!known) tellWhyItDied(runtime, scene.cellId)
    return
  }
  // A cell mid-run keeps the room's status honest even between kernel messages.
  setStatus(runtime, runtime.currentCell ? 'busy' : phase)
}

/* ------------------------------------------------------ classes on machines */

/*
 * A class's kernel slots (its notebooks' container, its personal notebooks')
 * may compute on a machine instead of this server
 * (docs/architecture/remote-classes.md). Where a slot runs is the question of
 * kernel/remote/placement.ts, and pool.ts goes there for the endpoint. This
 * file only reads the answer, in a handful of places: the pump's gate, a
 * restart or an interrupt refused while the machine does not answer, a help
 * question's wait, the room's notes about the link, and the end of a kernel
 * whose machine was lost. Everything else (the queue, the guard, outputs, the
 * council) runs as it does at home, against an endpoint that happens to lead
 * to a machine.
 */

/** One slot's placement, as kernel/remote/placement.ts · PlacementView has it. */
export type PlacementView =
  | { where: 'home' }
  | {
      where: 'machine'
      runnerId: string
      /** The machine's name, as the owner gave it: for staff, never for the room's document. */
      name: string
      gen: number
      state: 'starting' | 'ready' | 'unreachable' | 'stopping'
      link: KernelLink | null
      /** Since when the slot is in `state`. */
      since: number
      failover: 'auto' | 'wait'
      /** When it moves by itself if nothing changes; null — it will not, or no time can be promised yet. */
      failoverAt: number | null
      /** Since when the machine has not answered, as the rule behind `failoverAt` counts (staff's «не отвечает с»); `since` without one. */
      quietSince?: number | null
    }

type MachineView = Extract<PlacementView, { where: 'machine' }>

/** News about one slot (placement.ts · PlacementEvent). */
export interface PlacementEvent {
  sessionId: string
  role: KernelRole
  kind: 'unreachable' | 'back' | 'lost' | 'ready' | 'moving' | 'moved' | (string & {})
  view: PlacementView
  words?: string
  at: number
  /**
   * Why. For 'lost', a failover cause: 'revoked', 'unclassed', 'leaving' and
   * 'perimeter' have words of their own (`lossWords`), anything else reads as
   * a machine that went silent. For 'unreachable', 'updating' while the
   * machine's agent restarts for an update (`bye: 'restart'`).
   */
  cause?: string
  /** For 'lost': when the class folder was last in sync with this server (§8.8), once files travel. */
  filesAt?: number
}

/**
 * What this file asks of kernel/remote/placement.ts: the names that module
 * exports (the shared interface of wave 2), plus `machinePlaced` from pool.ts's
 * early branches and `warmSlot`, which only the warm start needs. Handed in
 * rather than imported: the module reaches the machines' router and the
 * competitions' queue, which a process of the kernel alone never loads, and
 * a suite stands a fake module in. The module hands itself over as it loads
 * (placement-store.ts · takePlacementHooks, below); a class with nothing on a
 * machine runs exactly the old code either way.
 */
export interface ClassPlacements {
  placementOf(sessionId: string, role: KernelRole): PlacementView
  placementGate(sessionId: string, role: KernelRole, signal?: AbortSignal): Promise<void>
  onPlacementChange(listener: (event: PlacementEvent) => void): () => void
  moveNow(sessionId: string, role: KernelRole | null, by: string): Promise<{ ok: true } | { refused: string }>
  helpPadMs(sessionId: string, role: KernelRole): number
  /** What a gate or a start rejects with at failover: `words` are staff's (they name the machine), `cause` reads as PlacementEvent's. */
  PlacementLost: abstract new (...args: never[]) => Error & { words: string }
  /** Whether this slot goes to machines, placed yet or not. */
  machinePlaced?(sessionId: string, role: KernelRole): boolean
  /** Staff's words for a slot still starting on its machine, with the image's progress (they name the machine). */
  startingWords?(sessionId: string, role: KernelRole): string | null
  /**
   * Start the slot's container on a machine ahead of its first Run, in the
   * background (§6.8): only when a machine takes it now, never on this
   * server, and nothing for a slot that is placed or runs here already.
   * Without it the warm start warms nothing (`warmClassKernels`).
   */
  warmSlot?(sessionId: string, role: KernelRole): void
  /**
   * The durable stop of the slot's placement at this gen (§6.10, §10): the
   * personal notebooks' container once its last kernel retired
   * (`dropOwnIfEmpty`). Nothing for another gen, or a placement no longer
   * live; synchronous. Without it the pool's own stop goes (pool.ts ·
   * dropOwnKernel).
   */
  stopSlot?(sessionId: string, role: KernelRole, gen: number): boolean
}

/** The clock of these hooks' own timers: the process's, unless a suite brings one it moves by hand. */
export interface ClassClock {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const PROCESS_CLOCK: ClassClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

const HOME_VIEW: PlacementView = { where: 'home' }

/** Nothing is ever lost at home: a gate there never rejects. */
class NeverLost extends Error {
  readonly words = ''
}

/** Every slot on this server: what runs until the placement module is given, and in every suite that brings none. */
const HOME_PLACEMENTS: ClassPlacements = {
  placementOf: () => HOME_VIEW,
  placementGate: () => Promise.resolve(),
  onPlacementChange: () => () => {},
  moveNow: async () => ({ refused: tr('server.thisClassSKernelsRunOnThis.d5eaa3') }),
  helpPadMs: () => 0,
  PlacementLost: NeverLost,
}

let placements: ClassPlacements = HOME_PLACEMENTS
let classClock: ClassClock = PROCESS_CLOCK
let unlisten: () => void = () => {}
/** A suite or a harness handed these hooks their placements (useClassPlacements): the process's own, loaded after, replace nothing. */
let chosen = false

/** The last machine view of each slot: a 'lost' event may carry the view after the loss, which names no machine. */
const lastMachine = new Map<string, MachineView>()

/**
 * Slots whose room was told their machine was lost, by the machine they
 * left, until their next start says where the kernel went: here the
 * fallback's note, on another machine `sayWhereItCameBack`.
 */
const movedOff = new Map<string, string | null>()

const slotKey = (sessionId: string, role: KernelRole): string => `${sessionId}\0${role}`

/**
 * Hand these hooks a placement module, and optionally a clock for their
 * timers; null puts every slot back on this server and the process's clock
 * back. A second call replaces the first: its events stop reaching here, and
 * what was known of its outages is forgotten.
 *
 * THE SERVER CALLS NOTHING: the hooks take the process's own module, on the
 * clock of the process's placements, the moment that module is loaded (at
 * boot, by the app's routes; `takePlacementHooks` below). This is for a suite
 * that stands a fake in, or a harness on a clock of its own, and once called
 * the process's module replaces nothing. The module's news is subscribed to
 * once, here, and keeps arriving whatever instance it puts behind its
 * functions (placement.ts · usePlacements, onPlacementChange). The clock must
 * be the module's own: its views' `since` are read against this clock's `now`
 * (the ten seconds of an outage's note).
 */
export function useClassPlacements(next: ClassPlacements | null, clock: ClassClock | null = null): void {
  chosen = true
  installPlacements(next ?? HOME_PLACEMENTS, clock ?? PROCESS_CLOCK)
}

function installPlacements(next: ClassPlacements, clock: ClassClock): void {
  unlisten()
  for (const outage of outages.values()) if (outage.timer !== null) classClock.clearTimeout(outage.timer)
  outages.clear()
  lastMachine.clear()
  movedOff.clear()
  terminalSlots.clear()
  ownPlacementsUsed.clear()
  placements = next
  classClock = clock
  unlisten = placements.onPlacementChange(onPlacementEvent)
}

/** A slot's placement, remembered when it is a machine. */
function viewOf(sessionId: string, role: KernelRole): PlacementView {
  let view: PlacementView
  try {
    view = placements.placementOf(sessionId, role)
  } catch (err) {
    // A placement that cannot be read must not take the pump down: the slot reads as this server's.
    if (seldom(`placement-of:${sessionId}`)) console.warn(`[kernel ${sessionId}] the placement of ${role} could not be read:`, errText(err))
    return HOME_VIEW
  }
  if (view.where === 'machine') lastMachine.set(slotKey(sessionId, role), view)
  return view
}

/** A machine that does not answer, as much as a refusal needs of it: its name for staff, when it is known. */
interface Away {
  name: string | null
}

/**
 * Whether this scope computes on a machine that cannot be reached right now:
 * the placement says so, or the live kernel's own link is down (the link
 * knows a moment before the placement does). Null at home.
 */
function machineAway(runtime: Runtime): Away | null {
  const kernel = runtime.kernel && !runtime.kernel.endedBy ? runtime.kernel : null
  const link = kernel?.endpoint.link
  const down = link !== undefined && !link.up
  const view = viewOf(runtime.sessionId, runtime.role)
  if (view.where === 'machine') return view.state === 'unreachable' || down ? { name: view.name } : null
  if (!down) return null
  return { name: lastMachine.get(slotKey(runtime.sessionId, runtime.role))?.name ?? null }
}

/**
 * A press refused because the kernel's machine does not answer right now
 * (remote-classes.md §5.4), before anything was touched. `message` never
 * names the machine; `named` does, for staff (control.ts picks by role).
 */
export class MachineUnreachable extends Error {
  constructor(
    message: string,
    readonly named: string,
  ) {
    super(message)
    this.name = 'MachineUnreachable'
  }
}

/**
 * A kernel start that its slot's failover ended while the kernel was still
 * coming up on the machine (`loseSlot`). Not a start that failed: the room
 * heard of the loss once, and the queue went with it, so nothing more is
 * said. The message is the room's sentence, which never names the machine,
 * for whoever reads it as an answer (Format).
 */
class StartLost extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StartLost'
  }
}

/** Rejects once the signal aborts: what a gate that ignores its signal is raced against. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('the wait was given up')), { once: true })
  })
}

/** The failover cause a PlacementLost carries, if it says one. */
function causeOf(err: unknown): string | null {
  const cause = (err as { cause?: unknown }).cause
  return typeof cause === 'string' ? cause : null
}

/**
 * Wait at the slot's placement gate (remote-classes.md §5.3); whether the
 * pump may go on.
 *
 * The gate answers at once for a machine that answers. While it does not, the
 * cells stay queued, their notebook's entry says so (`link: 'lost'`, which
 * the room draws as «ждёт машину»), and the room is told after
 * CLASS_UNREACHABLE_NOTE_MS (`beginOutage`); under «ждать машину» the wait
 * lasts until the machine is back or staff move the kernel. A failover ends
 * it with PlacementLost: the scope is ended with every other of its slot
 * (`loseSlot`), and the pump stops. Retiring the scope ends the wait too.
 */
async function passGate(runtime: Runtime, view: MachineView): Promise<boolean> {
  const { sessionId, role } = runtime
  const waiting = view.state === 'unreachable'
  const controller = new AbortController()
  runtime.gateWait = { controller, view }
  if (waiting) {
    beginOutage(sessionId, role, view)
    writePlacement(runtime, 'machine', 'lost', view.since)
  }
  try {
    await Promise.race([placements.placementGate(sessionId, role, controller.signal), untilAborted(controller.signal)])
  } catch (err) {
    if (controller.signal.aborted || runtime.retired) return false
    if (err instanceof placements.PlacementLost) {
      loseSlot(sessionId, role, { view, cause: causeOf(err), at: classClock.now(), filesAt: null, staffWords: err.words || null })
      return false
    }
    throw err
  } finally {
    if (runtime.gateWait?.controller === controller) runtime.gateWait = null
  }
  if (runtime.retired) return false
  if (waiting) {
    /*
     * Open again. Only the same placement answering is a return (the
     * placement's own news may have said so already: this is the same news
     * once). A gate also opens when the slot goes on without its machine: a
     * stop, or another placement by now. Nothing came back then, and nothing
     * is waited for any more. The same placement starting its container anew
     * is still away, until its machine reports it ready ('ready').
     */
    const now = viewOf(sessionId, role)
    const same = now.where === 'machine' && now.runnerId === view.runnerId && now.gen === view.gen
    if (same && now.state === 'ready') {
      endOutage(sessionId, role, now, 'back', classClock.now())
      writePlacement(runtime, 'machine', 'ok', classClock.now())
    } else if (!same || now.state === 'stopping') {
      leaveOutage(sessionId, role, view.runnerId)
      writePlacement(runtime, now.where === 'machine' ? 'machine' : null, null, classClock.now())
    }
  }
  return true
}

/**
 * One machine of a class that stopped answering: per class and machine,
 * whichever of the class's slots are on it. The room hears about it once,
 * after CLASS_UNREACHABLE_NOTE_MS (a blip shorter than that says nothing),
 * and hears that it is back only when it heard that it was gone.
 *
 * A record lasts as long as a slot in it waits for that machine: each slot
 * leaves it when its machine answers again, when it is lost, and when it
 * goes on without the machine (a stop, another placement), so that one slot
 * gone quiet never holds the record, nor silences the machine's next outage.
 */
interface Outage {
  sessionId: string
  /** The machine as last seen: its name and its failover plan are staff's words. */
  view: MachineView
  since: number
  /** The class's slots waiting for it, each with the gen of its placement there. */
  roles: Map<KernelRole, number>
  timer: unknown
  /** Staff were told, and so hear its end. */
  told: boolean
  /** What staff's sentence promised of the move (`promiseOf`): a different promise is told again. */
  promised: string | null
  /** The room's kernel log was told too (not for the council's pool alone), and so hears the return. */
  toldRoom: boolean
  /** Its agent restarts for an update (`bye: 'restart'`): a different sentence, the same wait. */
  updating: boolean
}

const outages = new Map<string, Outage>()

const outageKey = (sessionId: string, runnerId: string): string => `${sessionId}\0${runnerId}`

function beginOutage(sessionId: string, role: KernelRole, view: MachineView, updating = false): void {
  const key = outageKey(sessionId, view.runnerId)
  let outage = outages.get(key)
  // The slot is counted at another gen: that placement ended unheard, and its part of the record with it.
  const gen = outage?.roles.get(role)
  if (outage && gen !== undefined && gen !== view.gen) {
    outage.roles.delete(role)
    if (outage.roles.size === 0) {
      dropOutage(key, outage)
      outage = undefined
    }
  }
  if (outage) {
    outage.roles.set(role, view.gen)
    outage.view = view
    outage.updating ||= updating
    // Its moment passed with nobody here to tell (`tellOutage`): told now that there is.
    if (!outage.told && outage.timer === null) armOutage(key, outage)
    // Told, and the move is known by now or changed (a young outage promises no time, a stuck tunnel's syncs may stop): staff
    // hear when it moves now. The room's note said nothing of when, and is not said again.
    else if (outage.told && promiseOf(view, outage.updating) !== outage.promised) tellStaff(outage)
    return
  }
  outage = { sessionId, view, since: view.since, roles: new Map([[role, view.gen]]), timer: null, told: false, promised: null, toldRoom: false, updating }
  outages.set(key, outage)
  armOutage(key, outage)
}

/** The note CLASS_UNREACHABLE_NOTE_MS after the machine went quiet: at once when that moment is past. */
function armOutage(key: string, outage: Outage): void {
  const due = outage.since + CLASS_UNREACHABLE_NOTE_MS - classClock.now()
  if (due <= 0) {
    tellOutage(key, outage)
    return
  }
  outage.timer = classClock.setTimeout(() => tellOutage(key, outage), due)
}

function tellOutage(key: string, outage: Outage): void {
  outage.timer = null
  if (outages.get(key) !== outage || outage.told) return
  // A class this process holds nothing of has nobody to tell, and a note would bring its document back.
  // The record stays untold: the first notebook of the class to wait for the machine tells it (`beginOutage`).
  if (scopesOf(outage.sessionId).length === 0) return
  outage.told = true
  const words = outageWords(outage, clockOf(classClock.now() - outage.since))
  if (words !== null) {
    outage.toldRoom = true
    kernelNote(outage.sessionId, words)
  }
  tellStaff(outage)
}

/** Staff's sentence about the outage (`waitingWords`), to the watchers of each of its slots: what it promises is remembered. */
function tellStaff(outage: Outage): void {
  outage.promised = promiseOf(outage.view, outage.updating)
  const named = waitingWords(outage.view, outage.updating, clockOf(classClock.now() - outage.since))
  for (const role of outage.roles.keys()) tellMachineWatchers(outage.sessionId, role, named)
}

/**
 * The class's placement setting changed (routes/admin-instance.ts · the
 * seminar PATCH, §6.2): staff read every slot of it on a machine again, the
 * class's «Если машина пропала» riding the frame, and — while that machine
 * does not answer — the waiting sentence as the class has it now. «Ждать
 * машину» pressed in one tab reaches every other staff tab, and a time the
 * class no longer keeps to is promised no more.
 */
export function kernelMachinesChanged(sessionId: string): void {
  for (const outage of [...outages.values()]) {
    if (outage.sessionId !== sessionId) continue
    // The record's view as the placement has it now: its failover is the setting's.
    for (const role of outage.roles.keys()) {
      const view = viewOf(sessionId, role)
      if (view.where === 'machine' && view.runnerId === outage.view.runnerId) outage.view = view
    }
    if (outage.told && promiseOf(outage.view, outage.updating) !== outage.promised) tellStaff(outage)
  }
  for (const role of ['room', 'own', 'council'] as const) if (kernelMachineOf(sessionId, role) !== null) tellMachineWatchers(sessionId, role, null)
}

/**
 * What staff's sentence promises of the move, as a key: another promise is
 * told again, the clock moving on is not. A time is promised only once the
 * placement knows what moves the slot (placement.ts · outageRule): from
 * when, then, says which rule it is.
 */
function promiseOf(view: MachineView, updating: boolean): string {
  if (updating) return 'updating'
  if (view.failover === 'wait') return 'wait'
  return view.failoverAt === null ? 'none' : `from ${view.quietSince ?? view.since}`
}

/**
 * The room's note about a machine that does not answer, by what of the class
 * waits for it. The class notebooks' kernel: everything waits, the plain
 * sentence. The personal notebooks' alone (§10, D31): only their runs wait,
 * and the room is told so rather than that every new run will. The council's
 * pool alone: its attempts wait, which staff's console says; nothing in the
 * room's log.
 */
function outageWords(outage: Outage, elapsed: string): string | null {
  if (outage.roles.has('room')) {
    return outage.updating
      ? tr('server.theAgentOnTheMachineIsUpdating.d5b483')
      : tr('server.noConnectionToTheMachineTheKernel.71d94f', { elapsed })
  }
  if (outage.roles.has('own')) {
    return outage.updating
      ? tr('server.theAgentOnThePersonalNotebooksMachine.5176d2')
      : tr('server.noConnectionToThePersonalNotebooksMachine.d2ae75', { elapsed })
  }
  return null
}

function dropOutage(key: string, outage: Outage): void {
  if (outages.get(key) === outage) outages.delete(key)
  if (outage.timer !== null) classClock.clearTimeout(outage.timer)
  outage.timer = null
}

/** A slot no longer waits for that machine (or, with no machine named, for any of the class's): it leaves without a word. */
function leaveOutage(sessionId: string, role: KernelRole, runnerId: string | null): void {
  for (const [key, outage] of [...outages]) {
    if (outage.sessionId !== sessionId || (runnerId !== null && outage.view.runnerId !== runnerId)) continue
    if (!outage.roles.delete(role)) continue
    if (outage.roles.size === 0) dropOutage(key, outage)
  }
}

/**
 * Staff's sentence about a machine that does not answer (§13.2 «Waiting
 * (staff)»): what happens next, and when. Quiet since when the rule that
 * moves it counts (`quietSince`: a silence from the machine's last word), so
 * that «с 14:32:05 … до 14:33:05» is the class's own failoverSec; with no
 * time to promise yet, how long it has been out.
 */
function waitingWords(view: MachineView, updating: boolean, elapsed: string): string {
  if (updating) return tr('server.theAgentOnMachineIsUpdatingThe.88b188', { machine: view.name })
  const since = clockTime(view.quietSince ?? view.since)
  if (view.failover === 'wait') return tr('server.machineHasNotAnsweredSinceWaitingFor.5afc55', { machine: view.name, since })
  if (view.failoverAt !== null) {
    return tr('server.machineHasNotAnsweredSinceWaitingUntil.1d012e', { machine: view.name, since, until: clockTime(view.failoverAt) })
  }
  return tr('server.noConnectionToMachineTheKernelAnd.df78c8', { machine: view.name, elapsed })
}

/**
 * A slot's machine answers again ('back'), or the slot was lost with it
 * ('lost'): it leaves the record, and the last one out says the return, to
 * whoever heard of the outage. A slot recorded at another gen was another
 * placement's, and leaves without a word.
 */
function endOutage(sessionId: string, role: KernelRole, view: MachineView, how: 'back' | 'lost', at: number): void {
  const key = outageKey(sessionId, view.runnerId)
  const outage = outages.get(key)
  const gen = outage?.roles.get(role)
  if (!outage || gen === undefined) return
  outage.roles.delete(role)
  if (outage.roles.size > 0) return
  dropOutage(key, outage)
  if (how !== 'back' || gen !== view.gen || !outage.told) return
  const seconds = Math.max(1, Math.round((at - outage.since) / 1000))
  if (outage.toldRoom && scopesOf(sessionId).length > 0) kernelNote(sessionId, tr('server.theConnectionToTheMachineCameBack.d517ba', { seconds }))
  tellMachineWatchers(sessionId, role, tr('server.theConnectionToMachineCameBackAfter.28f7cf', { machine: outage.view.name, seconds }))
}

/** One slot's news, from the placement module: never allowed to throw back into it. */
function onPlacementEvent(event: PlacementEvent): void {
  try {
    placementNews(event)
  } catch (err) {
    console.error(`[kernel] placement news (${event.kind}) failed for ${event.sessionId}:`, errText(err))
  }
  /*
   * And the class folder's copies (kernel/remote/files.ts): one whose slots
   * left its machine goes now, and a run at its barrier with it — after the
   * news above, so that run meets the failover's words, not the files'
   * refusal half a minute later; one placed there anew begins anew.
   */
  try {
    filesPlacementChanged(event.sessionId)
  } catch (err) {
    console.error(`[kernel] the files of ${event.sessionId} did not follow its placement (${event.kind}):`, errText(err))
  }
}

function placementNews(event: PlacementEvent): void {
  const { sessionId, role, view, at } = event
  if (view.where === 'machine') lastMachine.set(slotKey(sessionId, role), view)
  const machine = view.where === 'machine' ? view : (lastMachine.get(slotKey(sessionId, role)) ?? null)
  switch (event.kind) {
    case 'unreachable':
      if (view.where !== 'machine') break
      beginOutage(sessionId, role, view, event.cause === 'updating')
      markSlot(sessionId, role, 'lost', view.since)
      break
    case 'back':
    case 'ready':
      // Ready in a container its machine made anew while the road is still down: as far away as before.
      if (view.where === 'machine' && view.state === 'unreachable') {
        beginOutage(sessionId, role, view)
        markSlot(sessionId, role, 'lost', view.since)
        break
      }
      if (machine) endOutage(sessionId, role, machine, 'back', at)
      markSlot(sessionId, role, 'ok', at)
      break
    case 'moving':
      markSlot(sessionId, role, 'moving', at)
      break
    case 'stopping':
    case 'stopped':
      // The slot went on without its machine answering: it waits for nothing now.
      leaveOutage(sessionId, role, null)
      // And kernels computing on that very placement went with its container: a stop nobody here asked for (endUnderStop).
      if (view.where === 'machine') endUnderStop(sessionId, role, view)
      break
    case 'moved':
      // Running again after a loss: it waits for nothing now, and the room hears where it came back.
      leaveOutage(sessionId, role, null)
      sayWhereItCameBack(sessionId, role, view)
      break
    case 'lost':
      // Staff hear it from there: the module's own words when it has them (they name the machine).
      loseSlot(sessionId, role, {
        view: machine,
        cause: event.cause ?? null,
        at,
        filesAt: event.filesAt ?? null,
        staffWords: event.words ?? null,
      })
      return
    case 'fallback':
      /*
       * No machine could take the slot, and it starts on this server through
       * the usual admission (§6.2 «если машин нет — здесь»). The room hears
       * where its kernel went, once per start; a class this process holds
       * nothing of hears nothing, as its document must not come back for it.
       */
      if (scopesOf(sessionId).some((scope) => scope.role === role && !scope.retired)) {
        kernelNote(sessionId, tr('server.noMachineCanTakeTheKernelNow.53437e'))
      }
      // After a loss, too: this is where it went.
      movedOff.delete(slotKey(sessionId, role))
      break
    default:
      break
  }
  tellMachineWatchers(sessionId, role, null)
}

/**
 * A slot whose loss the room was told of runs again (§11.2 step 4): on
 * another machine, the room hears so, as it hears the fallback's «здесь»
 * when the slot comes back on this server. The failover's own note could
 * not say where: nothing ran anywhere then. Back on the machine it left
 * (once that is allowed again), nothing more is said. The council's pool is
 * the console's news, not the room's.
 */
function sayWhereItCameBack(sessionId: string, role: KernelRole, view: PlacementView): void {
  const key = slotKey(sessionId, role)
  if (!movedOff.has(key)) return
  const left = movedOff.get(key)
  movedOff.delete(key)
  if (view.where !== 'machine' || view.runnerId === left || role === 'council') return
  if (!scopesOf(sessionId).some((scope) => scope.role === role && !scope.retired)) return
  kernelNote(sessionId, tr(role === 'own' ? 'server.thePersonalNotebooksKernelsWereStartedOn.3d0553' : 'server.theKernelWasStartedOnAnotherMachine.28c860'))
}

/** Say a slot's link in the entry of every notebook computing in it, or waiting for it at the gate. */
function markSlot(sessionId: string, role: KernelRole, link: KernelLinkState, since: number): void {
  for (const scope of scopesOf(sessionId)) {
    if (scope.role !== role || scope.retired) continue
    const onMachine = scope.kernel?.endpoint.link !== undefined && !scope.kernel.endedBy
    if (onMachine || scope.gateWait !== null) writePlacement(scope, 'machine', link, since)
  }
}

/** How a slot's machine was lost, as either of its two signals (the event, the gate) has it. */
interface Loss {
  /** The machine as last seen; null when this process never saw it. */
  view: MachineView | null
  cause: string | null
  at: number
  filesAt: number | null
  /** The placement module's own sentence for staff, when it gave one. */
  staffWords: string | null
}

/**
 * The room's side of a failover (remote-classes.md §11.2): every notebook of
 * the slot that computed on the lost machine, was coming up on it, or waited
 * for it at the gate, is ended, once, whichever way the news arrived.
 *
 * A kernel is ended from outside (`endFromOutside`): its pending work is
 * aborted with no DELETE ever sent, the cell that was running reads that its
 * fate is unknown (`lostMidRun`), and the death branch of `onPhase` drops the
 * queue. A kernel still coming up fails its start as this loss (`StartLost`).
 * The room gets one note for the whole slot, and the queue-dropped line when
 * anything was waiting; staff read the same naming the machine. The next Run
 * brings a kernel up wherever the slot goes now (§11.2 step 4).
 */
function loseSlot(sessionId: string, role: KernelRole, loss: Loss): void {
  if (loss.view) endOutage(sessionId, role, loss.view, 'lost', loss.at)
  else leaveOutage(sessionId, role, null)
  const key = loss.view ? `${loss.view.runnerId}:${loss.view.gen}` : `?:${loss.at}`
  const scopes = scopesOf(sessionId).filter(
    (scope) => scope.role === role && !scope.retired && scope.lostKey !== key && onLostMachine(scope, loss.view),
  )
  if (scopes.length === 0) {
    tellMachineWatchers(sessionId, role, null)
    return
  }
  const words = lossWords(loss, role)
  const hadWork = scopes.some((scope) => scope.currentCell !== null || scope.queue.length > 0)
  for (const scope of scopes) scope.lostKey = key
  console.warn(
    `[kernel ${sessionId}] the ${role} slot was lost with its machine` +
      `${loss.view ? ` ${loss.view.runnerId} (gen ${loss.view.gen})` : ''}${loss.cause ? `: ${loss.cause}` : ''}`,
  )
  // The council's pool is the console's news (§9.10): its attempts run again in the notebook's kernel, and the room's log hears nothing.
  if (role !== 'council') {
    kernelNote(sessionId, words.room)
    if (hadWork) kernelNote(sessionId, tr(QUEUE_DROPPED))
  }
  // Told that the kernel goes: its next start tells where (`sayWhereItCameBack`, the fallback's note).
  movedOff.set(slotKey(sessionId, role), loss.view?.runnerId ?? null)
  for (const scope of scopes) endOnLostMachine(scope, words.room, loss.at)
  tellMachineWatchers(sessionId, role, loss.staffWords ?? words.staff)
}

/**
 * A SLOT'S PLACEMENT STOPPED UNDER KERNELS THAT COMPUTE ON IT
 * (remote-classes.md §6.10, §10): a stop nobody here asked for — a container
 * whose ready echo this server refused, a start its machine kept failing
 * after the container died — takes their Python with the container, and
 * nothing else would tell them: their runs failed on a road to nowhere until
 * the idle sweep retired them, a personal one holding its place under the
 * ceiling meanwhile. Each is ended from outside now, as a loss ends one, with
 * no DELETE (jupyter.ts · endFromOutside): the room hears it once for the
 * slot, and its next Run starts a kernel wherever the slot is then, the chip
 * saying nothing of a move that never was. A stop this server asked for (the
 * owner's, the class end, the idle sweeps, dropOwnIfEmpty) finds no such
 * kernel: its scopes were retired first, or held none there.
 */
function endUnderStop(sessionId: string, role: KernelRole, view: MachineView): void {
  const key = `${view.runnerId}:${view.gen}`
  const scopes = scopesOf(sessionId).filter((scope) => {
    const kernel = scope.kernel
    return scope.role === role && !scope.retired && scope.lostKey !== key && kernel?.endpoint.link !== undefined && !kernel.endedBy && samePlacement(kernel.endpoint, view)
  })
  if (scopes.length === 0) return
  const words = tr(role === 'own' ? 'server.thePersonalNotebooksKernelsOnTheMachine.160525' : 'server.theKernelOnTheMachineWasStopped.7de430')
  const hadWork = scopes.some((scope) => scope.currentCell !== null || scope.queue.length > 0)
  // Said here once for the slot; the kernels' own `dead` says nothing more (onPhase reads lostKey).
  for (const scope of scopes) scope.lostKey = key
  console.warn(`[kernel ${sessionId}] the ${role} slot's placement on ${view.runnerId} (gen ${view.gen}) stopped under ${scopes.length} kernel(s): ended`)
  if (role !== 'council') {
    kernelNote(sessionId, words)
    if (hadWork) kernelNote(sessionId, tr(QUEUE_DROPPED))
  }
  for (const scope of scopes) {
    const kernel = scope.kernel!
    const alive = kernel.phase !== 'dead'
    kernel.endFromOutside('fenced', words)
    // A kernel dead already hears no `dead` again: what it left queued goes from here.
    if (!alive) {
      dropOrGiveBack(scope, 'its placement was stopped')
      setStatus(scope, 'off')
    }
    writePlacement(scope, null, null, null)
  }
}

function endOnLostMachine(scope: Runtime, words: string, at: number): void {
  const kernel = scope.kernel
  if (kernel && kernel.endpoint.link && !kernel.endedBy) {
    const alive = kernel.phase !== 'dead'
    // Its `dead` reaches onPhase, which drops the queue.
    kernel.endFromOutside('lost', words)
    // A kernel dead already hears no `dead` again: what it left queued goes from here.
    if (!alive) {
      dropOrGiveBack(scope, 'its machine was lost')
      setStatus(scope, 'off')
    }
  } else if (comingUp(scope)) {
    // Its start fails by itself a moment later, and reads as this loss (`StartLost`) rather than as its own error.
    scope.startLost = words
    dropOrGiveBack(scope, 'its machine was lost')
  } else {
    // Waiting at the gate, with no kernel there yet: only the queue to drop.
    dropOrGiveBack(scope, 'its machine was lost')
    if (!kernel || kernel.phase === 'dead') setStatus(scope, 'off')
  }
  writePlacement(scope, null, null, at)
}

/**
 * A notebook's queue goes with its kernel; a pool's worker gives back the
 * attempt it was given and had not started (§9.10): it runs in the
 * notebook's kernel, keeping its place.
 */
function dropOrGiveBack(scope: Runtime, why: string, lost = true): void {
  if (hidden(scope)) giveBackQueue(scope, why, lost)
  else dropQueue(scope)
}

/** Whether this scope computed on that placement, was coming up on it, or waited for it at the gate. */
function onLostMachine(scope: Runtime, view: MachineView | null): boolean {
  const kernel = scope.kernel
  if (kernel?.endpoint.link && !kernel.endedBy) return view === null || samePlacement(kernel.endpoint, view)
  /*
   * Still coming up: its start waits on the slot's placement (the machine's
   * ready report, or the road to its container), and a slot has one
   * placement at a time, the one lost.
   */
  if (comingUp(scope)) return true
  const waiting = scope.gateWait
  if (!waiting) return false
  return view === null || (waiting.view.runnerId === view.runnerId && waiting.view.gen === view.gen)
}

/** A start of this scope in flight, before its kernel is there (`ensureKernel`). */
function comingUp(scope: Runtime): boolean {
  return scope.starting !== null && scope.kernel === null
}

/**
 * Whether an endpoint leads to this placement, by the identity it carries,
 * `machine:<runner>:<container>:<gen>` (§4.5). An endpoint that says nothing
 * readable is taken to: the end of a kernel is the safe side to err on.
 */
function samePlacement(endpoint: KernelEndpoint, view: MachineView): boolean {
  const parts = endpoint.identity?.split(':')
  if (!parts || parts.length < 4 || parts[0] !== 'machine') return true
  return parts[1] === view.runnerId && parts[parts.length - 1] === String(view.gen)
}

const QUEUE_DROPPED = 'server.theQueueWasClearedItsCellsCounted.c77303'

/**
 * What the room and staff read about a lost machine (remote-classes.md
 * §13.2), by its cause. The room's sentence never names the machine, and it
 * says whose variables are gone: the personal notebooks' slot alone (§10,
 * D31) costs the class notebook nothing. Nor does any of them say where the
 * kernel comes back — a revoke's and a move's no more than a silence's:
 * nothing runs anywhere yet, and the next start may place it on another
 * machine as much as here (the move only keeps it off the machine it left
 * for a while, placement.ts · AVOID_MS) — it says which as it does
 * (`placementNews` · 'fallback', 'moved').
 */
function lossWords(loss: Loss, role: KernelRole): { room: string; staff: string } {
  const name = loss.view?.name ?? null
  const named = (key: string, unnamed: string): string => (name === null ? tr(unnamed) : tr(key, { machine: name }))
  const own = role === 'own'
  const moved = tr('server.theKernelWillStartAgainTheVariables.a76610')
  const roomMoved = own ? tr('server.thePersonalNotebooksKernelsWillStartAgain.7cdaa6') : moved
  switch (loss.cause) {
    case 'revoked':
      return {
        room: `${tr('server.theOwnerDisconnectedTheMachine.0660fa')} ${roomMoved}`,
        staff: `${named('server.theOwnerDisconnectedMachine.1a3061', 'server.theOwnerDisconnectedTheMachine.0660fa')} ${moved}`,
      }
    case 'unclassed':
      return {
        room: `${tr('server.theMachineIsNoLongerTrustedTo.7919d7')} ${roomMoved}`,
        staff: `${named('server.machineIsNoLongerTrustedToRun.8962f2', 'server.theMachineIsNoLongerTrustedTo.7919d7')} ${moved}`,
      }
    case 'leaving':
      return {
        room: `${tr('server.theMachineIsBeingDisconnected.126fbe')} ${roomMoved}`,
        staff: `${named('server.machineIsBeingDisconnected.6aa752', 'server.theMachineIsBeingDisconnected.126fbe')} ${moved}`,
      }
    case 'perimeter':
      return {
        room: tr(own ? 'server.theNetworkOnThePersonalNotebooksMachine.b18ca6' : 'server.theNetworkOnTheMachineGotOut.10829b'),
        staff: named('server.theNetworkOnMachineGotOutOf.c73666', 'server.theNetworkOnTheMachineGotOut.10829b'),
      }
    default:
      break
  }
  // Moved off a machine that answered («Перенести на сервер»): nothing to say about silence.
  const view = loss.view
  if (!view || view.state !== 'unreachable') return { room: roomMoved, staff: moved }
  // Quiet since when the rule that moved it counted, as staff were told while it waited (`waitingWords`).
  const since = clockTime(view.quietSince ?? view.since)
  if (loss.filesAt !== null) {
    const filesAt = clockTime(loss.filesAt)
    return {
      room: own
        ? tr('server.thePersonalNotebooksMachineHasNotAnswered.ae4676', { since, filesAt })
        : tr('server.theMachineHasNotAnsweredSinceThe.aa7fbb', { since, filesAt }),
      staff: tr('server.machineHasNotAnsweredSinceTheKernel.6c488a', { machine: view.name, since, filesAt }),
    }
  }
  return {
    room: own
      ? tr('server.thePersonalNotebooksMachineHasNotAnswered.69b338', { since })
      : tr('server.theMachineHasNotAnsweredSinceThe.ee52e1', { since }),
    staff: tr('server.machineHasNotAnsweredSinceTheKernel.ceaa1d', { machine: view.name, since }),
  }
}

/** The words of a cell or an attempt cut off by a failover (§13.2): what became of it on the machine is unknown. */
function lostMidRun(): string {
  return tr('server.thisCellWasRunningOnTheMachine.8d1959')
}

/**
 * The loss a start failed by, if it did (`ensureKernel`): heard as the
 * placement's news already (`loseSlot` marked the scope), or only now, as
 * the start's own rejection. A PlacementLost that reaches the start first is
 * told from here, once; the news after it finds the scope ended.
 */
function startLostBy(runtime: Runtime, err: unknown): StartLost | null {
  if (err instanceof StartLost) return err
  if (err instanceof placements.PlacementLost && runtime.startLost === null && !runtime.retired) {
    const { sessionId, role } = runtime
    loseSlot(sessionId, role, {
      view: lastMachine.get(slotKey(sessionId, role)) ?? null,
      cause: causeOf(err),
      at: classClock.now(),
      filesAt: null,
      staffWords: err.words || null,
    })
  }
  if (runtime.startLost !== null) return new StartLost(runtime.startLost)
  // A loss that found nothing to end (the scope closed meanwhile): its own words name the machine, and stay out.
  if (err instanceof placements.PlacementLost) return new StartLost(tr('server.theKernelWillStartAgainTheVariables.a76610'))
  return null
}

/**
 * A start's failure as the room reads it (§13.1 «Data path»): words that
 * name the slot's machine never go into the room's document. They read as
 * the plain «Ядро не запустилось на машине», and staff hear them whole.
 */
function startWords(sessionId: string, role: KernelRole, text: string): string {
  const name = lastMachine.get(slotKey(sessionId, role))?.name
  return name && text.includes(name) ? tr('server.theKernelDidNotStartOnThe.8ad0fb') : text
}

/**
 * Why a council worker's kernel did not start, as the console and the cards
 * read it (kernel/council-pool.ts · poolWhy, §9.9 «with the machine's
 * words»): the placement's own sentence — one that names the machine is
 * staff's, and the room reads the plain one, as for any start
 * (startWords) — or null for an error of this server's, whose detail is for
 * its log alone.
 */
export function councilStartWords(sessionId: string, err: unknown): string | null {
  if (err instanceof MachineUnreachable || err instanceof StartLost) return err.message
  if (err instanceof RuntimeRequestError) return startWords(sessionId, 'council', err.message)
  return null
}

/**
 * The class's council container still starting on its machine, in staff's
 * words («Запускаем ядро на машине «vast-3»… образ ↓ 45 %»): what «Пул не
 * поднялся: …» says after a minute of it (council-pool.ts · view, the
 * console's alone); null — it is not starting.
 */
export function councilStartingWords(sessionId: string): string | null {
  const view = viewOf(sessionId, 'council')
  return view.where === 'machine' && view.state === 'starting' ? startingWordsOf(sessionId, 'council', view) : null
}

/** Staff's slow-start sentence: the placement module's, with the image's progress, or the plain one. */
function startingWordsOf(sessionId: string, role: KernelRole, view: MachineView): string {
  let words: string | null = null
  try {
    words = placements.startingWords?.(sessionId, role) ?? null
  } catch {
    words = null
  }
  return words ?? tr('server.startingTheKernelOnMachine.c2d7a3', { machine: view.name })
}

/** The road closed before a restart left: the kernel was not asked at all (jupyter.ts · restart). */
function restartNotSent(kernel: JupyterKernel): boolean {
  const link = kernel.endpoint.link
  return link !== undefined && !link.up && !kernel.endedBy && kernel.phase !== 'restarting' && kernel.phase !== 'dead'
}

/**
 * A restart sent to a machine whose answer never came back (remote-classes.md
 * §5.4): look at the kernel once the link is back, and say which way it went.
 *
 * The restart stays in flight meanwhile (`runtime.restarting`), and so the
 * pump sends no cell: a cell computing in a fresh process would look like the
 * old process still at work. The kernel's own process id settles it
 * (jupyter.ts · settleRestart): another process means it happened, the cells
 * lose their numbers and the guard goes into the new process; the same one
 * means it did not, and the variables are still there. A failover settles it
 * otherwise: the kernel is ended, and the failover's words are the room's.
 */
async function settleUnknownRestart(runtime: Runtime, kernel: JupyterKernel): Promise<void> {
  const { sessionId } = runtime
  console.warn(`[kernel ${sessionId}/${runtime.root}] restart sent, its answer lost: settled once the machine answers`)
  kernelNote(sessionId, tr('server.theRestartWasSentButNoAnswer.17cbbc'))
  let verdict: 'happened' | 'missed'
  try {
    verdict = await kernel.settleRestart()
  } catch (err) {
    if (kernel.endedBy || runtime.kernel !== kernel || runtime.retired) return
    /*
     * It never answered at all. The kernel is let go of, without a DELETE:
     * the next Run attaches again by the session's path, to whichever
     * process is there, and the room is told the restart did not come back.
     */
    console.error(`[kernel] the restart of ${sessionId}/${runtime.root} could not be settled:`, errText(err))
    kernel.detach()
    runtime.kernel = null
    setStatus(runtime, 'dead')
    kernelNote(sessionId, tr('server.theKernelDidNotComeBackAfter.cadaf5'))
    return
  }
  if (runtime.kernel !== kernel || runtime.retired) return
  if (verdict === 'happened') {
    runtime.guard = null
    await ensureGuard(runtime).catch(() => false)
    resetAllCells(runtime, runtime.currentCell)
    setStatus(runtime, 'idle')
    kernelNote(sessionId, tr('server.theRestartWentThroughTheVariablesWere.96b635'))
    return
  }
  // The old process lives on, idle or still computing what it was: the status follows it.
  setStatus(runtime, kernel.phase === 'busy' ? 'busy' : 'idle')
  kernelNote(sessionId, tr('server.theRestartDidNotGetThroughThe.92177b'))
}

/** The kernel's placement in its notebook's entry (notebook.ts · KERNEL_WHERE_FIELD), written only when it changes. */
function writePlacement(runtime: Runtime, where: KernelWhere, link: KernelLinkState | null, since: number | null): void {
  if (runtime.retired || hidden(runtime)) return
  const { doc } = getSessionDoc(runtime.sessionId)
  const entry = kernelsMap(doc)?.get(runtime.root)
  if (
    entry instanceof Y.Map &&
    entry.has(KERNEL_WHERE_FIELD) &&
    (entry.get(KERNEL_WHERE_FIELD) ?? null) === where &&
    (entry.get(KERNEL_LINK_FIELD) ?? null) === link &&
    (entry.get(KERNEL_LINK_SINCE_FIELD) ?? null) === since
  ) {
    return
  }
  doc.transact(() => {
    const slot = kernelEntry(doc, runtime.root)
    slot.set(KERNEL_WHERE_FIELD, where)
    if (link === null) slot.delete(KERNEL_LINK_FIELD)
    else slot.set(KERNEL_LINK_FIELD, link)
    if (since === null) slot.delete(KERNEL_LINK_SINCE_FIELD)
    else slot.set(KERNEL_LINK_SINCE_FIELD, since)
  }, ORIGIN)
}

/**
 * A kernel came up: say where it computes. A kernel on a machine says its link;
 * one back on this server after a machine says it left (`where` null); one
 * that never left writes nothing at all.
 */
function markWhere(runtime: Runtime, kernel: JupyterKernel): void {
  // A pool's worker is no notebook: the room is told nothing of where it computes.
  if (hidden(runtime)) return
  const link = kernel.endpoint.link
  if (link) {
    writePlacement(runtime, 'machine', link.up ? 'ok' : 'lost', link.since)
    if (runtime.role === 'room' && kernel.endpoint.identity) terminalSlots.set(kernel.endpoint.identity, runtime.sessionId)
    wireTerminalJitter()
    return
  }
  const entry = kernelsMap(getSessionDoc(runtime.sessionId).doc)?.get(runtime.root)
  if (entry instanceof Y.Map && entry.get(KERNEL_WHERE_FIELD) === 'machine') writePlacement(runtime, null, null, classClock.now())
}

/**
 * Where one slot of a class computes, for staff (protocol.ts ·
 * `kernel:machine`): null on this server. Read-only: it starts nothing.
 */
export function kernelMachineOf(sessionId: string, role: KernelRole): KernelMachine | null {
  const view = viewOf(sessionId, role)
  if (view.where !== 'machine') return null
  return {
    name: view.name,
    state: view.state,
    since: view.since,
    rttMs: view.link?.rttMs ?? null,
    failover: view.failover,
    failoverAt: view.failoverAt,
  }
}

/**
 * Who wants to know that a slot's placement changed, and what staff should
 * read about it: control.ts sends staff the `kernel:machine` frame. `note`
 * names the machine, and so never goes into the room's document.
 */
const machineWatchers: Array<(sessionId: string, role: KernelRole, note: string | null) => void> = []

export function onKernelMachineChange(cb: (sessionId: string, role: KernelRole, note: string | null) => void): void {
  machineWatchers.push(cb)
}

function tellMachineWatchers(sessionId: string, role: KernelRole, note: string | null): void {
  for (const cb of machineWatchers) {
    try {
      cb(sessionId, role, note)
    } catch (err) {
      console.error(`[kernel] machine watcher failed for ${sessionId}:`, errText(err))
    }
  }
}

/**
 * Warm the personal notebooks' slot of a class up on its machine, in the
 * background (remote-classes.md §6.8), when the first participant opens the
 * room: a container start over there is typically 5–15 s, and started now,
 * the first personal Run costs a round trip rather than that. The idle sweep
 * stops it after the room setting, like any class's kernels.
 *
 * The placement module does the warming (`warmSlot`), because only it can
 * promise what a warm start must: a machine or nothing. Opening a room never
 * starts a slot on this server, where a class with no machine for it falls
 * back (§6.2): a personal notebooks' container here starts at their first
 * Run, as it always has. The class notebooks' kernel needs nothing from here:
 * the join's own warm-up brings it up, the cells session with its guard,
 * wherever the class computes (routes/sessions.ts · warmsKernel).
 *
 * Nothing for a class nobody will compute in now (finished, archived, being
 * stopped: the join's rule for its warm-up), nothing for a class whose rules
 * give no notebook a personal kernel (`mayHaveOwnKernel`: a lecture pays for
 * no container it cannot use, §10), and nothing under the broker, whose
 * classes never go to machines (D26).
 */
export async function warmClassKernels(sessionId: string): Promise<void> {
  if (!placements.warmSlot || kernelBackend() === 'broker') return
  try {
    if (!machineSlot(sessionId, 'own') || isFinished(sessionId) || kernelStopInProgress(sessionId)) return
    if (!mayHaveOwnKernel(sessionId)) return
    // Read where it is kept, lazily: that module reaches this one while it loads.
    const { isArchived } = await import('../routes/admin-instance.js')
    if (isArchived(sessionId)) return
    placements.warmSlot?.(sessionId, 'own')
  } catch (err) {
    // No class row (a test, a room being deleted), or a placement that cannot be read: nothing is warmed.
    if (seldom(`warm:${sessionId}`)) console.warn(`[kernel ${sessionId}] the warm start was skipped:`, errText(err))
  }
}

/**
 * Whether a notebook of the class can have a personal kernel by its rules as
 * they stand: students may make their own (`ownBooks`), or a notebook is
 * given to its owner (shared/rules.ts · bookHasOwnKernel). Rules changed
 * later bring the container up at the first personal Run, cold.
 */
function mayHaveOwnKernel(sessionId: string): boolean {
  const rules = storedRules(sessionId)
  return rules.ownBooks === 'on' || Object.keys(rules.books ?? {}).some((root) => bookHasOwnKernel(rules, root))
}

/** Whether a slot of this class goes to machines (pool.ts · machinePlaced), or is on one already. */
function machineSlot(sessionId: string, role: KernelRole): boolean {
  try {
    if (placements.machinePlaced) return placements.machinePlaced(sessionId, role)
  } catch {
    return false
  }
  return viewOf(sessionId, role).where === 'machine'
}

/**
 * «Перенести сейчас» (remote-classes.md §11.1): staff move one notebook's slot
 * off its machine now, or with no root every slot of the class that is on
 * one. The placement module fails it over; its 'lost' news ends the kernels
 * here (`loseSlot`), and the next Run brings them up where the class goes.
 */
export async function moveKernelNow(
  sessionId: string,
  root: string | null,
  by: string,
): Promise<{ ok: true } | { refused: string }> {
  return placements.moveNow(sessionId, root === null ? null : roleOfBook(sessionId, root), by)
}

/** The room is over: forget its machines' outages, views and kernels. */
function forgetClassMachines(sessionId: string): void {
  for (const [key, outage] of outages) {
    if (outage.sessionId !== sessionId) continue
    if (outage.timer !== null) classClock.clearTimeout(outage.timer)
    outages.delete(key)
  }
  for (const key of [...lastMachine.keys()]) if (key.startsWith(`${sessionId}\0`)) lastMachine.delete(key)
  for (const key of [...movedOff.keys()]) if (key.startsWith(`${sessionId}\0`)) movedOff.delete(key)
  for (const [identity, owner] of terminalSlots) if (owner === sessionId) terminalSlots.delete(identity)
  ownPlacementsUsed.delete(sessionId)
}

/** "14:32:05": a moment as the room's clock on the wall says it, in the instance's time zone. */
const clockFormats = new Map<string, Intl.DateTimeFormat>()

function clockTime(at: number): string {
  const zone = instanceTimeZone()
  let format = clockFormats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    clockFormats.set(zone, format)
  }
  return format.format(at)
}

/** "0:12": how long, in minutes and seconds. */
function clockOf(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * The class notebooks' kernels on machines, by the identity their endpoint
 * carries. The shared terminal knows only its endpoint, the room slot's, with
 * the same identity, and this is how it finds its class (§5.7).
 */
const terminalSlots = new Map<string, string>()

/**
 * The machine placements of each class's personal notebooks slot that a
 * personal kernel came up on in this process, as `runner:gen` (`placedOn`):
 * the only ones `dropOwnIfEmpty` stops. Gens only grow; a stop forgets its
 * own, and the class's end or another placement module forgets the rest.
 */
const ownPlacementsUsed = new Map<string, Set<string>>()

/*
 * The process's placements, from the moment their module is loaded (at boot,
 * by the app's routes): the pump's gate, the notes and the refusals hear them
 * from then on, unless a suite or a harness handed the hooks others
 * (useClassPlacements). Here, below every record installing clears.
 */
takePlacementHooks(({ placements: loaded, clock }) => {
  if (!chosen) installPlacements(loaded, clock)
})

let jitterWired = false

/**
 * The shell on a machine waits out the road's jitter before it calls a
 * command finished (terminal.ts · quietPadMs: twice the jitter, at most
 * 600 ms). The help pad is min(1000, 2 × the RTT p95), so half of it is the
 * p95 the terminal doubles. Until a pad is known, the link's own average, as
 * the terminal reads it by itself; nothing at all without a link.
 *
 * Handed to the terminal when the first kernel on a machine comes up, never
 * while this module loads: terminal.ts reaches this one through collab, and
 * mid-cycle its own state does not exist yet.
 */
function wireTerminalJitter(): void {
  if (jitterWired) return
  jitterWired = true
  useLinkJitter((endpoint) => {
    const link = endpoint.link
    if (!link) return null
    const sessionId = endpoint.identity ? terminalSlots.get(endpoint.identity) : undefined
    const pad = sessionId === undefined ? 0 : helpPad(sessionId, 'room')
    return pad > 0 ? pad / 2 : link.rttMs
  })
}

/* ---------------------------------------------------------------- lifecycle */

/**
 * Idempotent and concurrency-safe: five students hitting Run at once share one
 * connect. A kernel that has died counts as absent, so the next Run quietly
 * brings a fresh one up instead of demanding a manual restart.
 *
 * `root` is the notebook whose kernel we bring up; without it, the room's
 * notebook, i.e. the old behaviour for everything that does not know about
 * multiple kernels yet.
 */
export function ensureKernel(sessionId: string, root: string = CELLS_KEY): Promise<void> {
  const runtime = getRuntime(sessionId, root)
  if (runtime.kernel && runtime.kernel.phase !== 'dead') return Promise.resolve()
  if (runtime.starting) return runtime.starting

  /*
   * No start for a slot whose machine does not answer (remote-classes.md
   * §5.3), and nothing touched. The start would wait at the closed road for
   * the whole outage, the chip saying «запускается» about a kernel that may
   * well be over there with all its variables. The pump waits at its gate
   * instead; whoever else asks (the join's warm-up, a hover's wake, Format)
   * hears why and asks again later.
   */
  const placed = viewOf(sessionId, runtime.role)
  if (placed.where === 'machine' && placed.state === 'unreachable') {
    const words = tr('server.noConnectionToTheMachineTheKernel.67a40e')
    return Promise.reject(new MachineUnreachable(words, words))
  }

  /*
   * The personal kernel ceiling is checked BEFORE start-up and before any work.
   *
   * There is one personal notebooks container per class, and it holds dozens of
   * kernels: without a ceiling, a cohort in which everyone has a draft brings
   * it down at the process or memory limit, i.e. drops everyone's work at once
   * and silently. Live kernels are counted, not created scopes: a notebook
   * whose kernel went out for idleness takes up no place.
   *
   * Our own scope does not count: its kernel either already exists (and we did
   * not get here) or died and is being brought up again; refusing it would lock
   * the notebook for good after the very first OOM.
   *
   * Wherever the class's personal notebooks compute (§10), here or on their
   * machine, and the kernels coming up count as much as the ones up
   * (`holdsOwnPlace`): forty students pressing Run at once all start before
   * any of them is up, and counting the live ones alone let every one of them
   * through. The look and the mark of this start (`runtime.starting`, below)
   * are one synchronous stretch, so the sixty-first is refused whatever
   * order they come in.
   */
  if (runtime.role === 'own') {
    const limit = ownKernelMax()
    const live = scopesOf(sessionId).filter((scope) => scope !== runtime && holdsOwnPlace(scope)).length
    if (live >= limit) {
      const refusal = new Error(tr('server.kernel.ownFull', { p0: limit }))
      setStatus(runtime, 'dead')
      return Promise.reject(refusal)
    }
  }

  const dead = runtime.kernel
  runtime.kernel = null

  /*
   * A kernel that cannot be reached takes the full startup timeout to say so,
   * and a minute of "starting…" with nothing else is indistinguishable from a
   * room that is simply broken. Say something while it is still trying: the
   * seminar is usually in the middle of something and can decide whether to
   * wait or go on without Python.
   */
  const envName = sessionEnvironment(sessionId) ?? activeName()
  const slow = setTimeout(() => {
    /*
     * About the environment that is being brought up, not the global address.
     *
     * `config.jupyter.url` used to stand here: "kernel:8888", the shared
     * setting. But that is usually not what is being waited for: a room on its
     * own environment brings up its own container, and that is the minute and a
     * half. Naming the wrong address turns an explanation into a riddle: go fix
     * kernel:8888, which at that moment is alive and has nothing to do with it.
     */
    if (runtime.retired) return
    /*
     * A slot placed on a machine is waited for over there: its container is
     * what starts (remote-classes.md §6.8). The room is told so without the
     * machine's name, which it does not need; staff hear it named.
     */
    const view = viewOf(sessionId, runtime.role)
    if (view.where === 'machine') {
      // Not while it does not answer: the start waits for the road, and the outage has its own note.
      if (view.state === 'unreachable') return
      // A pool's worker starting is staff's news alone: the room's log says nothing of the council's pool.
      if (!hidden(runtime)) kernelNote(sessionId, tr('server.startingTheKernelOnAMachine.eca55f'))
      tellMachineWatchers(sessionId, runtime.role, startingWordsOf(sessionId, runtime.role, view))
      return
    }
    if (hidden(runtime)) return
    kernelNote(
      sessionId,
      envName
        ? tr("server.startingTheEnvironmentWaitingForTheKernel.df8f76", { p0: envName })
        : tr("server.waitingForTheKernelAtCellsCannot.8019bf", { p0: config.jupyter.url }),
    )
  }, SLOW_START_NOTICE_MS)

  runtime.starting = (async () => {
    setStatus(runtime, 'starting')
    runtime.startLost = null
    // Read at the moment the kernel is built, not at the moment it is asked
    // for: that is the value the container will actually have.
    runtime.environment = envName
    if (dead) {
      /*
       * A kernel ended from outside, by a failover, is only let go of here:
       * its dispose sends no DELETE (jupyter.ts · endFromOutside), which
       * would go to a loopback port of this server that may lead to another
       * placement by now (remote-classes.md §5.2).
       */
      try {
        await dead.dispose()
      } catch {
        /* it was already gone */
      }
    }
    // Which environment we are asking for now: needed if it does not answer.
    const wanted = sessionEnvironment(sessionId)
    try {
      /*
       * Where to go for Python is decided by the room and the notebook.
       *
       * The room picks the container: the class has its own, its personal
       * notebooks a second one, without a GPU (pool.ts · KernelRole). The
       * environment picks only the image the container is brought up from.
       * And the notebook picks the SESSION inside it: different paths,
       * different kernels and different variables.
       */
      const endpoint = await endpointForSession(sessionId, wanted, runtime.role)
      const kernel = await JupyterKernel.connect(sessionId, endpoint, runtime.root)
      if (runtime.retired) {
        // The seminar was closed while the kernel was coming up. There is
        // nothing to connect to now: without this branch the socket and the
        // live-kernel watchdog would hang on a runtime that is no longer in
        // the map until the server restarts. A dead process's scope sends
        // nothing at all: its kernel is the next life's (abandonKernelsForTest).
        if (abandoned.has(runtime)) kernel.detach()
        else await kernel.dispose().catch(() => {})
        return
      }
      // Its machine was lost in the last moments of the start: what came up leads to a placement that is gone.
      if (runtime.startLost !== null) {
        kernel.endFromOutside('lost', runtime.startLost)
        kernel.detach()
        throw new StartLost(runtime.startLost)
      }
      runtime.kernel = kernel
      runtime.lostKey = null
      // A placement a personal kernel came up on: its container may be stopped once the last of them goes (`dropOwnIfEmpty`).
      if (runtime.role === 'own') noteOwnPlacement(sessionId, kernel)
      setKernelProblem(runtime, null)
      clearMemoryNotices(runtime)
      markWhere(runtime, kernel)
      kernel.onPhaseChange((phase, expected) => onPhase(runtime, phase, expected))
      // Before anything of ours is sent: a kernel that is already busy is
      // finishing a cell for a server that no longer exists, and it would make
      // every Run in this room wait behind output nobody will ever see.
      // (A pool's worker re-attached mid-attempt after a restart of this server is recycled by its pool, §9.10: no note.)
      if ((await kernel.releaseOrphanedWork()) && !runtime.retired && !hidden(runtime)) {
        kernelNote(
          sessionId,
          tr("server.reconnectedToTheExistingKernelTheRunning.a20941"),
        )
      }
      /*
       * The guard against dangerous commands comes BEFORE the kernel is
       * declared ready.
       *
       * The process is new, and `os._exit` in it is still the real one: between
       * "the socket came up" and this line not a single user cell may get into
       * the kernel. A failure here does not bury the kernel; it is simply not
       * let out to work: `ensureGuard` will be asked again before every cell
       * (`pump`), and the one that did not get it will say so in words instead
       * of silently computing on an unguarded kernel.
       */
      runtime.guard = null
      await ensureGuard(runtime).catch(() => false)
      // Lost with its machine meanwhile (`loseSlot`): ended from outside, said so, and «не запущено» already.
      if (kernel.endedBy) throw new StartLost(kernel.endedBy.words)
      setStatus(runtime, runtime.currentCell ? 'busy' : (kernel.phase as KernelStatus))
      // A kernel coming up is a real event: up to a minute and a half of cold
      // start, and it is exactly between this line and the next that the room
      // stares into emptiness.
      console.log(`[kernel ${sessionId}/${runtime.root}] up (${envName ?? 'shared'}, ${runtime.role})`)
      countKernelStart(runtime.role, true)
      // The idle count starts at start-up: a kernel brought up and untouched
      // for half an hour is exactly the draft that was opened and forgotten.
      runtime.lastWorkAt = Date.now()
      /*
       * The reference point for a future post-mortem.
       *
       * A container's OOM kill counter is cumulative: it counts from the
       * container's birth, and the container survives both a kernel change and
       * a server restart. If we do not remember it now, at the very first death
       * we cannot tell "killed by this cell" from "killed this morning in the
       * previous class". We do not wait: a room's start must not stand still
       * for diagnostics needed an hour later. (A pool's worker has no
       * post-mortem: its death costs one attempt, §9.7.)
       */
      if (!hidden(runtime)) void sampleKills(sessionId, runtime.role)
    } catch (err) {
      /*
       * Ended by its slot's failover while it came up (`loseSlot`): not a
       * start that failed. The room heard of the loss once, without the
       * machine's name, and the queue went with it; nothing of the start's
       * own error goes into the room (a PlacementLost's words name the
       * machine: they are staff's). The chip says «не запущено»: the next Run
       * brings a kernel up wherever the class computes now.
       */
      const lost = startLostBy(runtime, err)
      if (lost) {
        if (!runtime.retired) setStatus(runtime, 'off')
        throw lost
      }
      /*
       * A full machine is not a death: nothing started, and the next Run
       * tries again. The chip says «НЕ ЗАПУЩЕНО», as for a notebook nobody
       * ran yet, not «ЯДРО ОСТАНОВЛЕНО», which reads as "your code broke it"
       * (K5, 9 Oct 2026).
       */
      const full = machineMemoryFull(err)
      setStatus(runtime, full ? 'off' : 'dead')
      countKernelStart(runtime.role, false)
      // A scheduler refusal is a word for advice to the teacher; anything else removes it.
      const problem = err instanceof RuntimeRequestError ? err.failure ?? null : null
      setKernelProblem(runtime, problem)
      // No more than once a minute per room: `ensureKernel` is called by every
      // student's entry and every Run, and they all share one promise: we have
      // already seen thirty identical lines in the same millisecond.
      if (seldom(`kernel-down:${sessionId}/${runtime.root}`)) {
        // The error text here is for students, so the journal also gets a
        // word: the operator searches the cluster events by it.
        const lacking = problem ? ` [unschedulable: ${problem.unschedulable}]` : ''
        console.warn(`[kernel ${sessionId}/${runtime.root}] did not start: ${errText(err)}${lacking}`)
      }
      /*
       * Forget the remembered container address.
       *
       * The room container's port is random, and the pool caches it. After
       * `docker restart colloq-room-<id>` the port is different, but the room
       * goes to the old one, and will keep going until the whole server is
       * restarted: "No Python kernel after 60s" on every Run, with a live and
       * healthy container right next to it.
       */
      forgetSessionKernel(sessionId, runtime.role)
      // Into the shared record too: the person who presses Run sees the message
      // on their cell, and everyone else sees a notebook that stopped.
      // A closed room gets silence: a note would create its document anew.
      // A pool's worker that did not come up is the console's (CouncilKernel.pool), never the room's log.
      if (!runtime.retired && !hidden(runtime)) {
        const said = startWords(sessionId, runtime.role, errText(err))
        kernelNote(sessionId, said, full ? 'kernel_memory' : undefined)
        // Words that name the machine are staff's (§13.1): they hear them as they were.
        if (said !== errText(err)) tellMachineWatchers(sessionId, runtime.role, errText(err))
      }
      throw err
    } finally {
      clearTimeout(slow)
      runtime.starting = null
    }
  })()

  return runtime.starting
}

/*
 * A recreated container is news for the room, not for the server journal.
 *
 * The pool removes a container when it was built from an old image, sits on
 * the wrong network, holds someone else's GPU slice or does not accept our
 * token. Each such case costs the seminar all its variables at once, and until
 * now it went by silently: `x` existed and suddenly NameError, with not a line
 * on screen. Now there is a line, and it says why.
 */
onRoomKernelRecreated((sessionId, why, role) => {
  // The container is new, and so its kill counter starts from zero as well. It
  // is counted per room container (postmortem.ts), so recreating the second
  // container does not affect it.
  if (role !== 'own') forgetKills(sessionId)
  // A closed room gets silence: a note would create its document anew.
  const scopes = scopesOf(sessionId)
  if (scopes.length > 0 && scopes.every((scope) => scope.retired)) return
  kernelNote(
    sessionId,
    role === 'own'
      ? tr('server.kernel.ownRecreated', { p0: why })
      : tr("server.theRoomSPythonContainerHadTo.253b0b", { p0: why }) +
          'The files in the Files panel are untouched; run your cells again.',
  )
})

/**
 * A line in the room's shared transcript, under the terminal's "Kernel log" tab.
 *
 * That tab was drawn for exactly this and had nothing in it: a kernel that
 * restarted or died was invisible to everybody except whoever pressed the
 * button. A student who ran three cells and looked away came back to an unrun
 * notebook with no explanation anywhere.
 *
 * Written straight into the document rather than through the live terminal,
 * because the news matters whether or not anyone has the drawer open; the
 * terminal rebuilds its own bookkeeping from these lines when it next opens.
 */
export function kernelNote(sessionId: string, text: string, code?: TerminalLineCode): void {
  try {
    const { doc } = getSessionDoc(sessionId)
    const terminal = getTerminal(doc)
    // A coded note is said once while it stands and is fresh (terminal.ts · codedLineStands).
    if (code && codedLineStands(terminal, code, text)) return
    doc.transact(() => {
      terminal.push([createTerminalLine({ kind: 'system', text, code })])
    }, ORIGIN)
  } catch {
    // Never let a log line be the reason a restart fails.
  }
}

/**
 * Restart the kernel of ONE notebook.
 *
 * `root` says whose; without it, the room's notebook, so that a tab opened
 * before the deploy does exactly what it did before. The class's neighbouring
 * notebooks are not touched at all: they have their own processes, and
 * "restart the lecture" must not mean "reset the seminar".
 */
export async function restartSession(
  sessionId: string,
  restartedBy?: string,
  root: string = CELLS_KEY,
): Promise<void> {
  const runtime = getRuntime(sessionId, root)
  // Two presses mean one restart. The second joins the first rather than
  // starting another one on top of it.
  if (runtime.restarting) return runtime.restarting
  /*
   * A kernel on a machine that cannot be reached is not restarted, and
   * nothing else is touched either (remote-classes.md §5.4): not the queue,
   * not the status. The kernel itself would refuse the request at the closed
   * door (jupyter.ts · restart), but only after the press had dropped the
   * room's queue for nothing. The person who pressed is told why; the cells
   * wait for the machine as they did.
   */
  const away = machineAway(runtime)
  if (away) {
    throw new MachineUnreachable(
      tr('server.noConnectionToTheMachineARestart.f05d30'),
      away.name === null
        ? tr('server.noConnectionToTheMachineARestart.f05d30')
        : tr('server.noConnectionToMachineARestartWould.406486', { machine: away.name }),
    )
  }
  if (runtime.activityItem) runtime.activityItem.activityCancelled = true
  dropQueue(runtime)
  setStatus(runtime, 'restarting')

  runtime.restarting = (async () => {
    const kernel = runtime.kernel && runtime.kernel.phase !== 'dead' ? runtime.kernel : null
    try {
      if (kernel) await kernel.restart()
      else await ensureKernel(sessionId, root)
      /*
       * A restart is a new process, i.e. a kernel without the guard. We install
       * it right here, without waiting for the first cell: between "the kernel
       * is back" and the first Run the room usually has people in it, and they
       * have the terminal and the Oracle.
       * A failure does not fail the restart: the question is asked again before
       * a cell.
       */
      runtime.guard = null
      await ensureGuard(runtime).catch(() => false)
      // Lost with its machine meanwhile: the failover's words are the room's, not a restart's.
      if (runtime.kernel?.endedBy) return
      resetAllCells(runtime, runtime.currentCell)
      setStatus(runtime, 'idle')
      kernelNote(
        sessionId,
        restartedBy
          ? tr("server.kernelRestartedByEveryVariableIsGone.3322fd", { p0: restartedBy })
          : tr("server.kernelRestartedEveryVariableIsGoneAnd.38530e"),
      )
    } catch (err) {
      /*
       * Its machine was lost while the restart was on its way (a failover,
       * «Перенести сейчас»): the kernel is ended, and the failover said so in
       * the room's words and left the chip «не запущено» (`loseSlot`). There is
       * no restart to report on, failed or not; the next Run brings a kernel up.
       */
      if (kernel?.endedBy || err instanceof StartLost) return
      /*
       * Sent to a machine, and its answer was lost on the way: whether the
       * kernel restarted is not known, and it is settled by looking at it
       * once the link is back (`settleUnknownRestart`). Until then the
       * restart stays in flight, and so does every cell behind it.
       */
      if (kernel && err instanceof RestartUnknown && runtime.kernel === kernel) {
        await settleUnknownRestart(runtime, kernel)
        return
      }
      /*
       * The road closed between the check above and the request: the kernel
       * was not even asked (jupyter.ts · restart), so it is what it was, with
       * its variables. Only the queue was dropped, by the press itself.
       */
      if (kernel && restartNotSent(kernel)) {
        setStatus(runtime, kernel.phase as KernelStatus)
        kernelNote(sessionId, tr('server.noConnectionToTheMachineARestart.f05d30'))
        return
      }
      // Never a rejection: the person clicked a button, the document carries the news.
      console.error(`[kernel] restart failed for ${sessionId}:`, errText(err))
      setStatus(runtime, machineMemoryFull(err) ? 'off' : 'dead')
      kernelNote(
        sessionId,
        tr("server.theKernelDidNotComeBackAfter.cadaf5"),
      )
    }
  })()

  try {
    await runtime.restarting
  } finally {
    runtime.restarting = null
    // Whatever was queued while the kernel was coming back can go now.
    void pump(runtime)
  }
}

/**
 * @param cellId The cell the press was for. The room-wide button does not name
 * one.
 *
 * A press on the cell itself names its target, and that is a fix, not a
 * convenience. The button is drawn from the document's state, and the document
 * lags the server by a round trip: pressing "stop" in the gap between two cells
 * of Run All meant landing in the `else` branch below and throwing out the
 * whole room's queue, including the batches of people who had pressed nothing.
 * While "stop" lived only at the bottom of the cell, hitting that gap was hard;
 * a button under the cursor makes it easy.
 *
 * Without `cellId` the behaviour is as before, and this branch is needed:
 * Interrupt in the notebook's bar is the only way to clear an accumulated queue
 * with one press when nothing is running.
 *
 * @param root The notebook whose kernel is stopped. A named cell is stronger:
 * its scope is the one where the work is going on, while `root`, on a miss by
 * name, would be taken from whichever tab is open at that moment.
 */
export async function interruptSession(
  sessionId: string,
  cellId?: string,
  root: string = CELLS_KEY,
  /**
   * The author of an attempt of the council cell `cellId` in the class's pool
   * (remote-classes.md §9.6): computing on a worker, that worker alone is
   * stopped — each attempt there has a kernel of its own; given to one and
   * not begun, or waiting in the pool's queue, it goes with no run, as a
   * cancel takes it. Never the notebook's kernel for one of the pool's. One
   * in the notebook's kernel, or none, is stopped as before.
   */
  participantId?: string,
): Promise<void> {
  if (cellId !== undefined && participantId !== undefined && stopInPool(sessionId, cellId, participantId)) return
  const runtime = getRuntime(
    sessionId,
    cellId === undefined ? root : scopeOfCell(sessionId, cellId, root),
  )
  /*
   * A cell computing on a machine that cannot be reached cannot be stopped
   * now, and the press is refused before anything is touched
   * (remote-classes.md §5.4): its batch stays queued behind it, as it would
   * after a stop that never landed. A time limit still fires: its signal goes
   * again once the link is back (§5.8, `signalItem`). With nothing running
   * there is nothing to send, and a press that clears the queue still does.
   */
  // (A cell still waiting at the files barrier has reached no machine yet: it stops here, whatever the road, §8.2.)
  if (runtime.currentCell !== null && !barrierWaits.has(runtime) && machineAway(runtime)) {
    const words = tr('server.noConnectionToTheMachineTheCell.b76132')
    throw new MachineUnreachable(words, words)
  }
  await interruptScope(runtime, cellId)
}

/** The worker of the class's pool computing this author's attempt of this council cell, if one does (§9.6). */
function workerComputing(sessionId: string, cellId: string, participantId: string): Runtime | undefined {
  return scopesOf(sessionId).find((scope) => hidden(scope) && !scope.retired && scope.job?.job.cellId === cellId && scope.job.job.participantId === participantId)
}

/** Whether a worker of the class's pool computes this author's attempt of this cell now: an interrupt naming it reaches that worker (control.ts). */
export function attemptOnWorker(sessionId: string, cellId: string, participantId: string): boolean {
  return workerComputing(sessionId, cellId, participantId) !== undefined
}

/**
 * Whether this author's attempt of this cell is the class's pool's: computing
 * on a worker, given to one and not begun, or waiting in the pool's queue.
 * An interrupt naming it goes there and nowhere else (control.ts).
 */
export function attemptInPool(sessionId: string, cellId: string, participantId: string): boolean {
  const id = councilQueueId(cellId, participantId)
  if (scopesOf(sessionId).some((scope) => hidden(scope) && !scope.retired && (scope.job?.item.cellId === id || scope.queue.some((item) => item.cellId === id)))) return true
  return poolSays('position', null, () => councilPool.position(sessionId, cellId, participantId)) !== null
}

/** A stop of one attempt of the class's pool (interruptSession): whether it was the pool's. */
function stopInPool(sessionId: string, cellId: string, participantId: string): boolean {
  const worker = workerComputing(sessionId, cellId, participantId)
  if (worker?.job) {
    if (machineAway(worker)) {
      const words = tr('server.noConnectionToTheMachineTheCell.b76132')
      throw new MachineUnreachable(words, words)
    }
    stopRunningItem(worker, worker.job.item)
    return true
  }
  // Given to a worker that has not begun it (its gate, its load): it goes with no run, and the worker's pump finds nothing.
  if (takeOffWorker(sessionId, councilQueueId(cellId, participantId))) return true
  const dropped = poolSays('cancel', null, () => councilPool.cancel(sessionId, cellId, participantId))
  if (!dropped) return false
  releaseCouncilItem(sessionId, dropped)
  return true
}

/** An attempt given to a worker of the class's pool and not begun, taken back with no run; whether one was. */
function takeOffWorker(sessionId: string, id: string): boolean {
  for (const scope of scopesOf(sessionId)) {
    if (!hidden(scope) || scope.retired) continue
    const index = scope.queue.findIndex((item) => item.cellId === id)
    if (index < 0) continue
    const [dropped] = scope.queue.splice(index, 1)
    releaseCouncil(scope, [dropped!])
    syncQueue(scope)
    return true
  }
  return false
}

/**
 * What became of one interrupt: 'sent' reached the kernel, 'unreachable' could
 * not (its machine's link is down; try again once it is back), 'none' found
 * nothing to send or failed otherwise, which was always only logged.
 */
type Interrupted = 'sent' | 'unreachable' | 'none'

async function interruptScope(runtime: Runtime, cellId?: string): Promise<Interrupted> {
  const sessionId = runtime.sessionId
  /*
   * Drop the tail first: interrupting cell 3 of 10 must not start cell 4.
   *
   * The tail is this press of Run, not the whole room's. Dropping everything
   * meant a student stopping their own loop silently cancelled thirty cells
   * the teacher had queued with Run All — who then saw a notebook that had
   * simply stopped, decided Run All had not worked, and pressed it again. It
   * also walked straight past the ownership check above, which exists exactly
   * so one person cannot cancel another's work.
   */
  const running = runtime.currentCell
  /*
   * The target check stands only on the second branch, and this matters.
   *
   * At first it stood over the whole function, and the result was strictly
   * worse than intended: a press that missed its cell did nothing at all, while
   * the kernel at that moment was computing the next cell of the same Run All,
   * and the person who pressed "stop" was left with a running notebook and a
   * silent button.
   *
   * Only the lower branch was dangerous: `dropQueue` throws out the whole
   * notebook's queue, other people's batches included. `stopBatchOf` cannot do
   * that (it is limited to the batch of the cell running now), so the current
   * work may be stopped even by a missed press, but the queue must not be
   * cleared on a miss.
   */
  if (running) {
    /*
     * SIGINT still goes to whatever is computing in THIS notebook: a scope has
     * one kernel, and there is nothing for it to choose from. But on a miss we
     * clear only our own queue.
     *
     * A miss between two cells can also cross owners: the teacher presses
     * "stop" on their cell exactly as it finishes, while the kernel has already
     * taken the first cell of a student's Run All. Cancelling that batch would
     * put out twelve of someone else's cells without explanation, and that is
     * exactly what used to happen, because `stopBatchOf` on the current cell
     * fell back to `currentBatch`. A target we know nothing about at all (the
     * cell has been deleted) counts as our own, as before.
     */
    const batch = cellId === undefined ? runtime.currentBatch : batchOf(runtime, cellId)
    if (batch === null || batch === runtime.currentBatch) stopBatchOf(runtime, running)
  } else if (cellId === undefined) dropQueue(runtime)
  /*
   * A cell waiting at the files barrier (§8.2) has not reached the kernel:
   * SIGINT would find it idle, and the cell would run once its files were
   * there. Its wait ends instead, and it ends without running (runOne).
   */
  const barrier = running ? barrierWaits.get(runtime) : undefined
  if (barrier) {
    if (runtime.activityItem) runtime.activityItem.activityCancelled = true
    barrier.abort()
    return 'sent'
  }
  const kernel = runtime.kernel
  if (!kernel || kernel.phase === 'dead') return 'none'
  /*
   * The export of the council's epoch computing now (remote-classes.md §9.2)
   * is this server's own, and over in a moment: a stop of the room's cells
   * never reaches it — SIGINT would end the snapshot, not a cell, and the
   * pool would go to the shared kernel for an export that did not come
   * together. What the press dropped of the queue above stays dropped.
   */
  if (servicing.has(runtime)) return 'none'
  if (runtime.activityItem) runtime.activityItem.activityCancelled = true
  // A machine whose road is down is not even asked: the request would only
  // fail at the closed door (§5.8). Home's kernels have no road.
  const link = kernel.endpoint.link
  if (link && !link.up) return 'unreachable'
  try {
    await kernel.interrupt()
    return 'sent'
  } catch (err) {
    // The road closed under the request: the signal is still owed.
    if (link && !link.up && !kernel.endedBy) return 'unreachable'
    console.error(`[kernel] interrupt failed for ${sessionId}/${runtime.root}:`, errText(err))
    return 'none'
  }
}

/**
 * Stop one session's kernel and its shell, and forget both. A deleted seminar
 * must not leave a process running in the container writing output into a
 * document that is on its way out — and because every writer here reaches for
 * the document through getSessionDoc(), which creates one on demand, this has
 * to finish before the document is evicted or it simply builds another.
 * Every other caller wants restartSession, which keeps the room.
 */
export async function shutdownSession(sessionId: string, permanent = false): Promise<void> {
  // ALL of the class's scopes: it has as many kernels as notebooks, and leaving
  // even one would leave a process writing into the document of a room that no
  // longer exists. Its council pool's workers among them; the pool itself goes first, its waiting attempts with no run.
  poolSays('closed', undefined, () => councilPool.closed(sessionId))
  const scopes = scopesOf(sessionId)
  runtimes.delete(sessionId)
  for (const runtime of scopes) {
    // First of all, before any await: a kernel start going on right now will
    // see this flag and will neither write into the document nor leave a
    // connected kernel behind.
    runtime.retired = true
    // And a pump waiting for its machine stops waiting for it.
    runtime.gateWait?.controller.abort()
    for (const item of runtime.queue) finishExecution(runtime, item, 'cancelled')
    runtime.queue.length = 0
    dropWriter(runtime)
    try {
      await runtime.kernel?.dispose()
    } catch (err) {
      console.error(`[kernel] could not stop ${sessionId}/${runtime.root}:`, errText(err))
    }
  }
  try {
    await closeTerminal(sessionId)
  } catch (err) {
    console.error(`[kernel] could not stop the terminal for ${sessionId}:`, errText(err))
  }
  // The room is over: if it is opened again, the shared kernel has to be told
  // anew, since that is a different class by then.
  // And the ghost sweep mark too: the room is over, there is nothing to
  // remember about it.
  orphanSweeps.delete(sessionId)
  /*
   * And the room's containers themselves, both of them.
   *
   * Containers are now a pair per seminar, not one per environment: not
   * removing them would mean leaving two containers for every class ever held
   * on this machine. The room's files live on the host and survive this; only
   * the Python with all its variables goes, which is exactly what "the seminar
   * is over" means.
   */
  // Deleting documents or files is safe only after the runtime confirms that
  // every room writer stopped. The caller must retain the room on failure.
  await dropRoomKernel(sessionId, permanent)
  // The OOM kill counter counts from the birth of the CONTAINER. The container
  // is gone, and a remembered number would outlive it and declare the very
  // first death in a new container "not from memory".
  forgetKills(sessionId)
  // The count of deaths in a row is about THAT kernel; "the third time in ten
  // minutes" does not belong to the new one, and carrying it over would scare
  // the room with someone else's trouble.
  forgetDeaths(sessionId)
  // And what was known of its machines: their outages and their names.
  forgetClassMachines(sessionId)
}

/* ---------------------------------------------- moving and removing scopes */

/**
 * Shut down the kernel of ONE notebook, with everything it held.
 *
 * Not a restart: the scope is removed from the map entirely, and the next run
 * in this notebook creates it anew, already where it is now supposed to live.
 * That is what "moving" is: a live process cannot be moved from one container
 * to another, and pretending the variables survived is worse than saying they
 * are gone.
 *
 * The order here matters, and it is all about the race with the pump. First
 * the scope is removed from the map, so that a parallel Run creates a FRESH one
 * instead of writing into the dying one. Then the queue is cleared: cells go
 * back to rest, council attempts learn there was no run. And only then is the
 * kernel shut down: its `dispose` cuts off what was computing, and the pump
 * will add its own ending to the cell, so the notebook's cell states are
 * levelled AFTER it, as the last word.
 */
async function retireScope(
  runtime: Runtime,
  note: string | null,
  /**
   * Leave the personal-notebook container to the caller. The owner's stop
   * retires every scope at once and removes the container itself, once:
   * otherwise each personal scope would race to `docker rm` the same
   * container as it finished.
   */
  options: { keepContainer?: boolean } = {},
): Promise<void> {
  const { sessionId, root } = runtime
  forgetScope(runtime)
  if (runtime.activityItem) runtime.activityItem.activityCancelled = true
  /*
   * What this scope held, before we take it apart.
   *
   * The cell that was computing will end by itself: `dispose` cuts it off, and
   * the pump writes "kernel stopped" into it. For an ordinary kernel death those
   * are the right words, but not here: the kernel is gone not because something
   * broke but because the notebook moved, and that is said in a separate line.
   * The names are remembered now, because a line later the queue will be empty.
   */
  const touched = new Set<string>(runtime.queue.map((item) => item.cellId))
  if (runtime.currentCell) touched.add(runtime.currentCell)
  dropQueue(runtime)
  dropWriter(runtime)
  // The flag is set BEFORE `dispose`: otherwise the pump, seeing a dead kernel,
  // would bring up a new one for this notebook (see `runOnKernel`), a notebook
  // that no longer exists.
  runtime.retired = true
  runtime.gateWait?.controller.abort()
  try {
    const kernel = runtime.kernel
    /*
     * A personal kernel whose placement was taken back under it (a stop it
     * did not ask for: a container whose echo home refused, a start given
     * up) is let go of, as an ended one is (remote-classes.md §5.2): its
     * machine removes the container with it, and a DELETE would go to a road
     * that leads nowhere, or to another placement by now.
     */
    if (kernel && runtime.role === 'own' && fencedUnder(runtime, kernel)) kernel.detach()
    else await kernel?.dispose()
  } catch (err) {
    console.error(`[kernel] could not stop ${sessionId}/${root}:`, errText(err))
  }
  runtime.kernel = null
  /*
   * Wait for the pump before levelling the cells.
   *
   * `dispose` cuts off what was computing, but `runOne` learns of it at its
   * `await` and writes its own ending into the cell ("kernel stopped") after we
   * have returned from here. Levelling the states before it would leave "error"
   * in the notebook where the kernel simply went away: the last word must be
   * ours, not the race's.
   */
  await settled(runtime)
  runtime.currentCell = null
  // A pool's worker has no cells and no entry: `bookCells` of its root would make an array of that name in the document.
  if (!hidden(runtime)) {
    restCells(sessionId, root, touched)
    clearScopeMirror(sessionId, root)
  }
  if (note) kernelNote(sessionId, note)
  // The personal notebooks container is kept while it has at least one kernel.
  if (runtime.role === 'own' && !options.keepContainer) await dropOwnIfEmpty(sessionId)
}

/**
 * Wait until this scope's pump stops, but no longer than a second.
 *
 * A second, not "as long as it takes": seminar deletion and access changes come
 * here, and they must not hang because of a kernel that does not answer. If it
 * does not make it, we level the states as they are: an extra "kernel stopped"
 * line in the notebook is more honest than a request that never came back.
 */
async function settled(runtime: Runtime): Promise<void> {
  const deadline = Date.now() + 1000
  while (runtime.pumping && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Everything this notebook was computing goes back to rest. The output stays:
 * it happened.
 *
 * `touched` are the names the scope held at the moment of removal. They are put
 * out in any state, not only from "running": the pump managed to write its
 * ending into its cell ("kernel stopped"), and leaving it red would declare a
 * breakage what was a move.
 */
function restCells(sessionId: string, root: string, touched: ReadonlySet<string>): void {
  let doc: Y.Doc
  try {
    doc = getSessionDoc(sessionId).doc
  } catch {
    return
  }
  const cells = bookCells(doc, root).toArray()
  doc.transact(() => {
    for (const cell of cells) {
      const state = cell.get('state')
      const ours = touched.has(idOf(cell))
      if (!ours && state !== 'running' && state !== 'queued') continue
      if (state === 'idle') continue
      cell.set('state', 'idle' as CellState)
      cell.set('startedAt', null)
      if (cell.get('stdin') != null) cell.set('stdin', null)
    }
  }, ORIGIN)
}

/** Clear the notebook's kernels-map entry, and its mirror for the room's notebook. */
function clearScopeMirror(sessionId: string, root: string): void {
  let doc: Y.Doc
  try {
    doc = getSessionDoc(sessionId).doc
  } catch {
    return
  }
  const map = kernelsMap(doc)
  const meta = getMeta(doc)
  doc.transact(() => {
    /*
     * The entry is not deleted but switched to `off`, and that is the fix of
     * 20 Sep 2026.
     *
     * A deleted entry meant "nothing is known about this notebook's kernel",
     * and the room read that in different ways: the room's notebook slid back to
     * the old key (which said "IDLE", a promise of a live Python that does not
     * exist), and the others got the default "STARTING". Neither describes what
     * happened: the kernel was removed, normally, for idleness or at the end of
     * class, and it will come up at the next run.
     */
    if (map?.has(root)) kernelEntry(doc, root).set(KERNEL_STATUS_FIELD, 'off' as KernelStatus)
    const slot = map?.get(root)
    if (slot instanceof Y.Map) {
      const waiting = slot.get(KERNEL_QUEUE_FIELD)
      if (waiting instanceof Y.Array && waiting.length > 0) waiting.delete(0, waiting.length)
      if (slot.get(KERNEL_RUNNING_FIELD) != null) slot.set(KERNEL_RUNNING_FIELD, null)
      if (slot.has(KERNEL_PROBLEM_KEY)) slot.delete(KERNEL_PROBLEM_KEY)
    }
    if (root !== CELLS_KEY) return
    const queue = meta.get('queue')
    if (queue instanceof Y.Array && queue.length > 0) queue.delete(0, queue.length)
    if (meta.get('runningCell') != null) meta.set('runningCell', null)
    meta.set('kernelStatus', legacyKernelStatus('off'))
    if (meta.has(KERNEL_PROBLEM_KEY)) meta.delete(KERNEL_PROBLEM_KEY)
  }, ORIGIN)
}

/**
 * Whether this scope takes one of its class's places under the personal
 * kernel ceiling (`ownKernelMax`): its kernel is up, wherever it computes —
 * on a machine that does not answer right now too, since its Python is there
 * all the same and comes back with the road (§10) — or it is coming up. A
 * kernel ended from outside takes none: its placement was lost or taken
 * back, and whatever the student runs next starts a kernel of its own,
 * counted then, once (§11.2 step 4).
 */
function holdsOwnPlace(scope: Runtime): boolean {
  if (scope.role !== 'own' || scope.retired) return false
  if (scope.starting !== null) return true
  const kernel = scope.kernel
  return kernel !== null && kernel.phase !== 'dead' && !kernel.endedBy
}

/** The machine placement a kernel computes on, by its endpoint's identity (`machine:<runner>:<container>:<gen>`); null — here, or unreadable. */
function placedOn(kernel: JupyterKernel | null): { runnerId: string; gen: number } | null {
  const parts = kernel?.endpoint.link ? kernel.endpoint.identity?.split(':') : undefined
  if (!parts || parts.length < 4 || parts[0] !== 'machine') return null
  const gen = Number(parts[parts.length - 1])
  return Number.isSafeInteger(gen) ? { runnerId: parts[1]!, gen } : null
}

/** Whether the slot's view is still the placement a kernel computes on (`placedOn`): that machine, that gen, and not being stopped. */
function stillPlacedOn(view: PlacementView, on: { runnerId: string; gen: number }): boolean {
  return view.where === 'machine' && view.runnerId === on.runnerId && view.gen === on.gen && view.state !== 'stopping'
}

/**
 * A personal kernel on a machine placement that is no longer its slot's
 * live one, and that nothing ended: the placement was stopped under it
 * (placement.ts · stopRow, which tells the kernel nothing), and its Python
 * goes with that container. A kernel ended from outside is let go of anyway.
 */
function fencedUnder(runtime: Runtime, kernel: JupyterKernel): boolean {
  const on = placedOn(kernel)
  return on !== null && !kernel.endedBy && !stillPlacedOn(viewOf(runtime.sessionId, runtime.role), on)
}

/**
 * A personal kernel on a machine that does not answer right now, on the
 * placement it computes on: still the slot's live one (`stillPlacedOn`), its
 * road down. Not one ended from outside, nor one whose placement is gone: that
 * one waits for nothing (`fencedUnder`).
 */
function awayOnItsPlacement(runtime: Runtime, kernel: JupyterKernel): boolean {
  const link = kernel.endpoint.link
  if (!link || link.up || kernel.endedBy) return false
  const on = placedOn(kernel)
  // An identity this server cannot read: its road alone says, as before machines had gens.
  return on === null || stillPlacedOn(viewOf(runtime.sessionId, runtime.role), on)
}

/** A personal kernel came up on a machine placement: one `dropOwnIfEmpty` may stop (`ownPlacementsUsed`). */
function noteOwnPlacement(sessionId: string, kernel: JupyterKernel): void {
  const on = placedOn(kernel)
  if (on === null) return
  let used = ownPlacementsUsed.get(sessionId)
  if (!used) ownPlacementsUsed.set(sessionId, (used = new Set()))
  used.add(`${on.runnerId}:${on.gen}`)
}

/**
 * Whether this scope keeps its class's personal notebooks' container on its
 * machine (`dropOwnIfEmpty`): its kernel is coming up, or attached and not
 * ended — up, away with its machine, or dead in the container (its own idle
 * pass retires it) — or work waits for a kernel there (a queue, the gate, a
 * cell, a council job). A notebook whose start was refused, or whose kernel
 * ended with its machine, keeps nothing: its next Run starts a kernel
 * wherever the slot is then.
 */
function keepsOwnContainer(scope: Runtime): boolean {
  if (scope.role !== 'own' || scope.retired) return false
  if (scope.starting !== null || (scope.kernel !== null && !scope.kernel.endedBy)) return true
  return scope.queue.length > 0 || scope.gateWait !== null || scope.currentCell !== null || scope.job !== null
}

/**
 * No personal kernels left: the personal notebooks container has no reason to stay.
 *
 * On a machine (remote-classes.md §10) it goes as a durable stop of the
 * slot's placement at its gen: the row says stopping, the next reply leaves
 * the slot out and the machine removes the container, whether or not it
 * answers at this moment. Only a scope with a Python there, coming, or work
 * waiting for one keeps it (`keepsOwnContainer`): a notebook whose start was
 * refused, or whose kernel ended with a lost machine, holds nothing in it.
 * And only a placement some personal kernel of the class came up on is
 * stopped (`ownPlacementsUsed`), whichever scope happens to retire last: a
 * warm start nobody used yet stays for the Run it was made for, and the
 * room's own sweep takes it with the room. Nothing goes to a placement that
 * was lost: it is no longer the slot's, its machine removes what it holds
 * once it hears the fence (§11.3), and nothing here sends it anything, a
 * DELETE least of all. The look at the scopes and the stop are one turn, so
 * no personal kernel starts in between.
 *
 * Here, as always: any personal notebook scope keeps the container.
 */
async function dropOwnIfEmpty(sessionId: string): Promise<void> {
  const view = viewOf(sessionId, 'own')
  if (view.where === 'machine' && placements.stopSlot) {
    if (scopesOf(sessionId).some(keepsOwnContainer)) return
    const used = ownPlacementsUsed.get(sessionId)
    const key = `${view.runnerId}:${view.gen}`
    if (!used?.has(key)) return
    try {
      if (placements.stopSlot(sessionId, 'own', view.gen)) used.delete(key)
    } catch (err) {
      console.error(`[kernel] could not stop the personal-notebook container of ${sessionId} on its machine:`, errText(err))
    }
    return
  }
  if (scopesOf(sessionId).some((scope) => scope.role === 'own')) return
  try {
    await dropOwnKernel(sessionId)
  } catch (err) {
    console.error(`[kernel] could not drop the personal-notebook container of ${sessionId}:`, errText(err))
  }
}

/**
 * Check against the rules and the document: where this class's kernels belong
 * now.
 *
 * Called where the answer changes: the teacher changed a notebook's access
 * (routes/sessions.ts, routes/admin-instance.ts), and a notebook was removed
 * from the room (control.ts · onBooksWritten). Cheap: a pass over the class's
 * live scopes, and there are as many as notebooks were opened in it, a handful.
 *
 * Why we shut down rather than move. A kernel is a process in a specific
 * container with a specific memory limit and specific access to the GPU. It
 * cannot be "moved": one can only start a new one and lose the variables.
 * Leaving it as is would mean leaving a student's personal notebook computing
 * in the lecture container, with its GPU and its OOM killer, i.e. exactly what
 * this whole fork exists to prevent.
 */
export function syncBookKernels(sessionId: string): void {
  const scopes = scopesOf(sessionId)
  if (scopes.length === 0) return
  const doc = peekSessionDoc(sessionId)?.doc ?? null
  const books = doc ? bookList(doc) : []
  // An empty list belongs to a room not yet opened in this process, and to a
  // test document. Taking it as "there are no notebooks" would shut down
  // everything.
  const roots = books.length > 0 ? new Set(books.map((book) => book.root)) : null
  const named = (root: string): string =>
    books.find((book) => book.root === root)?.path ?? root
  for (const scope of scopes) {
    // A pool's worker belongs to no notebook by its root: its pool decides when it goes.
    if (scope.retired || hidden(scope)) continue
    const gone = roots !== null && !roots.has(scope.root)
    if (!gone && roleOfBook(sessionId, scope.root) === scope.role) continue
    void retireScope(
      scope,
      gone ? null : `${named(scope.root)}: ${tr('server.kernel.bookAccessChanged')}`,
    )
  }
}

/* ----------------------------------------------------------- idle cleanup */

/**
 * How long a room's container lives after everyone has left, when nothing
 * else is said.
 *
 * A class lasts an hour and a half; two hours of an empty room mean "the class
 * is over", not "the teacher went out for coffee". Previously no cleanup was
 * needed at all: there was one container per environment serving everyone. Now
 * there are TWO per seminar (its own and the one where students' personal
 * notebooks compute), and without cleanup the machine piles up a pair for every
 * class ever held. They go together: the class ended as a whole, not by half.
 *
 * Since 0.20 this is only the default of the owner's setting `roomIdleMin`
 * (pool.ts · roomIdleMinutes), read at every pass: on a small machine two
 * hours of three idle rooms' reservations refused every new kernel for the
 * evening. `idleVerdict` keeps it as the default of its own, so a caller that
 * says nothing about the limit gets the old rule.
 */
const IDLE_KERNEL_MS = 2 * 60 * 60 * 1000
/**
 * A stopped container has no reason to wait that long.
 *
 * Two hours mean "the teacher went out for coffee, let the seminar's variables
 * wait". A stopped container has no variables at all: its Python was killed
 * with it, and all it holds is a layer on disk and, more expensively, its GPU
 * slice, because of which the next seminar hears "no free slices". After a
 * machine reboot (`--restart=no`) ALL of yesterday's containers become like
 * that at once, so the price of waiting is a whole morning without a GPU.
 */
const IDLE_STOPPED_KERNEL_MS = 30 * 60 * 1000
/** The sweep's pace, and its slowest: a shorter room setting brings it closer (see `sweepEveryMs`). */
const SWEEP_EVERY_MS = 10 * 60 * 1000
/** Its fastest: a pass asks docker for every container, and once a minute is plenty. */
const SWEEP_FLOOR_MS = 60 * 1000

/**
 * Since when the sweep has seen a room empty: set by the first pass that
 * finds it so, dropped by any pass that finds it occupied.
 *
 * Not "when someone was last seen", which it was until 0.20: a busy pass
 * marked the room with its own time and the first empty pass kept that mark,
 * so the countdown began at the last busy look rather than when the room
 * emptied. Against two hours and a ten-minute pace that was a rounding error;
 * with the owner's five minutes and a pass every two and a half, a class was
 * dropped after half the wait it was promised. Now the wait is at least the
 * setting, and at most one pass more.
 */
const emptySince = new Map<string, number>()

/**
 * The owner's stops in flight, per class (`stopKernelsByOwner`). A second
 * stop of the same class is refused rather than joined: the second press
 * came from a list that did not yet show the first.
 */
const ownerStops = new Map<string, Promise<void>>()

/**
 * What to do with a room's container right now, by one rule and without docker.
 *
 * `busy`: occupied: someone is in the room, a cell is computing, a queue stands
 * or a command is running in the shell. `watch`: empty, the countdown is on.
 * `drop`: empty long enough, the container is removed.
 *
 * A separate function, because the bug was in the rule itself, not in docker:
 * stopped containers never got into the cleanup at all, and on a GPU machine
 * after a nightly reboot every slice stayed with rooms nobody would ever open
 * again.
 */
export function idleVerdict(opts: {
  running: boolean
  busy: boolean
  since: number | undefined
  now: number
  /**
   * How long a live container may stay empty, in milliseconds: the owner's
   * `roomIdleMin`. `null` means never; left out, the old two hours.
   *
   * A stopped container keeps its own half hour (it holds no variables, only
   * a GPU slice and a layer on disk), and goes sooner only when the room
   * setting is shorter still: a stopped container never outlives a live one.
   * "Never" is about live kernels, whose variables someone may come back to.
   */
  limitMs?: number | null
}): 'busy' | 'watch' | 'drop' {
  if (opts.busy) return 'busy'
  if (opts.since === undefined) return 'watch'
  const room = opts.limitMs === undefined ? IDLE_KERNEL_MS : opts.limitMs
  const limit = opts.running
    ? room
    : room === null ? IDLE_STOPPED_KERNEL_MS : Math.min(room, IDLE_STOPPED_KERNEL_MS)
  if (limit === null) return 'watch'
  return opts.now - opts.since < limit ? 'watch' : 'drop'
}

/** The room setting as the sweep counts it: milliseconds, or `null` for never. */
function roomIdleLimitMs(): number | null {
  let minutes = IDLE_KERNEL_MS / 60_000
  try {
    minutes = roomIdleMinutes()
  } catch {
    // An unreadable settings table keeps the old rule rather than stopping the sweep.
  }
  return minutes > 0 ? minutes * 60_000 : null
}

let idleSweep: Promise<void> | null = null

/**
 * A broker outage postpones maintenance; it must not reject the interval's
 * detached promise or strand the single-flight slot for all later sweeps.
 *
 * `now` is the caller's clock, the same trick as `sweepOrphanRuns`: half an
 * hour of a personal kernel's idleness is checked in a millisecond rather than
 * by waiting half an hour. In production it is always set by a call without
 * arguments.
 */
export function sweepIdleKernels(now: number = Date.now()): Promise<void> {
  if (idleSweep) return idleSweep
  const attempt = sweepIdleKernelsOnce(now)
    .catch(() => {
      if (seldom('kernel-idle-sweep-census', 60_000)) {
        console.warn('[kernel] idle sweep postponed: runtime room census failed; will retry at the next sweep')
      }
    })
    .finally(() => {
      if (idleSweep === attempt) idleSweep = null
    })
  idleSweep = attempt
  return attempt
}

/**
 * Personal kernels that have done nothing for longer than allowed, one at a
 * time.
 *
 * A separate pass inside the shared cleanup, not a second timer: the reason is
 * one and the same ("nobody uses this any more"), and two schedules for one
 * reason would drift apart with the very first change.
 *
 * Counted PER SCOPE, not per room, and that is the whole difference from the
 * cleanup of class kernels. A room can be full of people and work (the lecture
 * computing, the seminar open) while forty drafts opened in the morning have
 * been holding forty Pythons in one container all this time. The room being
 * busy says nothing about them.
 *
 * Only what is really idle is put out: nothing is running, the queue is empty,
 * no council attempts are going. The notebook learns about it from a line in
 * the kernel log, and the next Run brings the kernel up the usual way, in
 * seconds, because the container is already there. And when not a single
 * kernel is left in it, the container goes too (`retireScope` →
 * `dropOwnIfEmpty`).
 */
async function sweepIdleOwnScopes(now: number): Promise<void> {
  const minutes = ownIdleMinutes()
  if (minutes <= 0) return
  const limit = minutes * 60_000
  for (const runtime of allScopes()) {
    if (runtime.role !== 'own' || runtime.retired) continue
    // No kernel yet, so nothing to put out; a scope without a kernel takes no room.
    if (!runtime.kernel) continue
    /*
     * On a machine that does not answer now (§10: as here, but only as here):
     * the kernel is over there, on the slot's live placement, and cannot be
     * told to stop, and retiring its scope would leave it running with its
     * variables under a note that says it stopped — the next Run of the
     * notebook attaching to it again by its path. It waits for the road, and
     * a later pass retires it; a failover ends it from outside meanwhile, and
     * then it goes with no word to the machine (`dispose` of an ended kernel
     * only lets go of it). A kernel whose placement was stopped under it
     * waits for nothing: its container goes with that placement, and it is
     * retired as idle here, let go of without a DELETE (`retireScope`).
     */
    if (awayOnItsPlacement(runtime, runtime.kernel)) continue
    if (runtime.currentCell !== null || runtime.queue.length > 0 || runtime.job) continue
    const since = runtime.lastWorkAt
    if (since === null || now - since < limit) continue
    const doc = peekSessionDoc(runtime.sessionId)?.doc ?? null
    const named = doc ? (bookList(doc).find((book) => book.root === runtime.root)?.path ?? null) : null
    const note = tr('server.kernel.ownIdle', { p0: minutes })
    console.log(`[kernel ${runtime.sessionId}/${runtime.root}] own kernel idle for ${minutes}m — stopped`)
    try {
      await retireScope(runtime, named ? `${named}: ${note}` : note)
    } catch (err) {
      console.error(`[kernel] idle sweep failed for ${runtime.sessionId}/${runtime.root}:`, errText(err))
    }
  }
}

/** Since when a class's personal-notebook Pod has had no kernel of this process in it. */
const ownPodUntracked = new Map<string, number>()

/**
 * A personal-notebook Pod that no scope of this process lives in, after the
 * personal kernels' idle time, goes the way `dropOwnIfEmpty` sends it.
 *
 * The case is an app restart: the scopes are gone with the process, the
 * kernels in the Pod are ones nobody re-attached to, and `dropOwnIfEmpty`
 * runs only when a scope retires, so with no scope it never runs. A student
 * who comes back within the idle time re-attaches and the Pod stays; the rest
 * waited as long as the per-kernel sweep would have given them.
 *
 * The broker only. There the Pod's memory is reserved on the node in full
 * (requests = limits) and blocks other classes' Pods from being scheduled;
 * the docker path keeps its behaviour, the container going with its room.
 */
async function sweepUntrackedOwnPods(now: number, census: Array<{ session: string; own: boolean }>): Promise<void> {
  const minutes = ownIdleMinutes()
  if (kernelBackend() !== 'broker' || minutes <= 0) {
    ownPodUntracked.clear()
    return
  }
  const present = new Set<string>()
  for (const room of census) {
    if (!room.own) continue
    present.add(room.session)
    if (scopesOf(room.session).some((scope) => scope.role === 'own')) {
      ownPodUntracked.delete(room.session)
      continue
    }
    const since = ownPodUntracked.get(room.session)
    if (since === undefined) {
      ownPodUntracked.set(room.session, now)
      continue
    }
    if (now - since < minutes * 60_000) continue
    ownPodUntracked.delete(room.session)
    console.log(`[kernel ${room.session}] personal-notebook Pod without a tracked kernel for ${minutes}m — stopped`)
    await dropOwnIfEmpty(room.session)
  }
  for (const session of [...ownPodUntracked.keys()]) if (!present.has(session)) ownPodUntracked.delete(session)
}

async function sweepIdleKernelsOnce(now: number): Promise<void> {
  // Personal kernels first, one by one: the class goes on meanwhile, and the
  // room below may turn out to be busy; that does not affect the decision on it.
  await sweepIdleOwnScopes(now)
  /*
   * Not only the ones this process brought up, and not only the live ones.
   *
   * `runningRoomKernels()` is a map in memory, and after a server restart it is
   * empty while yesterday's containers keep running: the cleanup did not know
   * about them until someone opened the room, and they lived until `make down`.
   * The docker label outlives us, so we ask it too, together with the stopped
   * ones (`docker ps -a`), which until now NEVER got into the cleanup.
   */
  const rooms = new Map<string, boolean>()
  for (const sessionId of runningRoomKernels()) rooms.set(sessionId, true)
  const census = await listRoomKernels()
  for (const room of census) rooms.set(room.session, room.running)
  /*
   * And the classes computing on machines, by this process's own kernels:
   * their containers are not on this server's docker, so its census may not
   * list them, and a class warmed up by its first participant and left empty
   * must still go after the room setting (remote-classes.md §6.8, D25). Home's
   * kernels have no link, and this adds nothing for them.
   */
  for (const scope of allScopes()) {
    if (scope.kernel?.endpoint.link && !scope.retired && !rooms.has(scope.sessionId)) rooms.set(scope.sessionId, true)
  }
  await sweepUntrackedOwnPods(now, census)
  // Once per pass: the owner may change it between two passes, not within one.
  const limitMs = roomIdleLimitMs()
  for (const [sessionId, running] of rooms) {
    // The owner is stopping it by hand right now: that stop does what this
    // would, and two at once only race each other to `docker rm`.
    if (ownerStops.has(sessionId)) continue
    const scopes = scopesOf(sessionId)
    // A computing room is busy even if everyone closed their tabs: the cell has
    // an owner who will come back for the result. The same goes for a command
    // in the shell: a three-hour training run started in the terminal is work
    // with an owner, and removing the container under it means killing it with
    // a "terminal closed" line.
    //
    // Across ALL of the class's scopes: a computing lecture holds the room just
    // as the single old pump would have held it, and the cleanup removes the
    // class's containers as a whole, both at once.
    // (The class's pool's workers are among its scopes, and an attempt waiting in the pool is the class's work too, §9.6.)
    const busy =
      onlineCount(sessionId) > 0 ||
      scopes.some((scope) => scope.currentCell !== null || scope.queue.length > 0) ||
      poolSays('waiting', [] as QueueItem[], () => councilPool.waiting(sessionId)).length > 0 ||
      terminalPhase(sessionId) === 'busy'
    const verdict = idleVerdict({ running, busy, since: emptySince.get(sessionId), now, limitMs })
    if (verdict === 'busy') {
      // Occupied: no clock. The next pass that finds it empty starts one.
      emptySince.delete(sessionId)
      continue
    }
    if (verdict === 'watch') {
      // The first look at it empty starts the countdown, from this pass, not
      // from the last one that saw it busy.
      if (!emptySince.has(sessionId)) emptySince.set(sessionId, now)
      continue
    }
    try {
      await shutdownSession(sessionId)
      emptySince.delete(sessionId)
    } catch (err) {
      console.error(`[kernel] idle sweep failed for ${sessionId}:`, errText(err))
    }
  }
  // A room without a container has no clock: if one comes back, its wait starts anew.
  for (const sessionId of [...emptySince.keys()]) if (!rooms.has(sessionId)) emptySince.delete(sessionId)
}

/**
 * How often the sweep looks: every ten minutes, or at half the room setting
 * when that is shorter (but not more than once a minute).
 *
 * Ten minutes against a two-hour wait is a rounding error; against a
 * ten-minute one it is double the wait the owner asked for. Half the setting
 * keeps the overshoot within half of it.
 */
function sweepEveryMs(): number {
  const limit = roomIdleLimitMs()
  if (limit === null) return SWEEP_EVERY_MS
  return Math.min(SWEEP_EVERY_MS, Math.max(SWEEP_FLOOR_MS, limit / 2))
}

/** When the next pass is due, for the panel's countdown (`classActivity`). */
let nextSweepAt: number | null = null
let sweepTimer: NodeJS.Timeout | null = null

/*
 * A chain of timeouts rather than an interval: the pace is read again after
 * every pass, so a change of the setting needs no restart. A pass never
 * overlaps the next one, since the next is scheduled when this one settles;
 * `sweepIdleKernels` stays single-flight for the callers outside the chain.
 *
 * `unref`: the timer must not keep the process alive: tests and one-off
 * scripts import this module and must be able to exit.
 */
function scheduleIdleSweep(): void {
  if (sweepTimer) clearTimeout(sweepTimer)
  const delay = sweepEveryMs()
  nextSweepAt = Date.now() + delay
  sweepTimer = setTimeout(() => {
    sweepTimer = null
    nextSweepAt = null
    void sweepIdleKernels().finally(scheduleIdleSweep)
  }, delay)
  sweepTimer.unref()
}

/**
 * The owner changed the room idle setting: the next pass comes at the new
 * pace instead of after the old one. A pass running right now schedules the
 * next one itself when it ends.
 */
export function idleSweepSettingsChanged(): void {
  if (sweepTimer) scheduleIdleSweep()
}

scheduleIdleSweep()

/* ------------------------------------------------ what runs, for the panel */

/**
 * What a class is busy with, by this process's own records (the queue, the
 * running cell, the restart promise), never by the document a student could
 * write. `participantId` is the server's record of who pressed; the panel
 * turns it into a name, and only for a room the viewer may read.
 */
export interface ClassBusy {
  kind: 'cell' | 'queue' | 'attempt' | 'terminal' | 'starting' | 'restarting'
  participantId: string | null
  root: string | null
  since: number | null
}

/** One notebook's kernel, as the panel lists it. */
export interface ScopeActivity {
  root: string
  role: KernelRole
  phase: 'starting' | 'idle' | 'busy' | 'restarting' | 'dead' | 'off'
  lastWorkAt: number | null
}

/** A class's kernels and the idle sweep's view of it, read-only. */
export interface ClassActivity {
  scopes: ScopeActivity[]
  /** The first reason the class is not idle, or `null`. */
  busy: ClassBusy | null
  /** The latest end of work across its notebooks. */
  lastWorkAt: number | null
  /** Since when the sweep counts the room as empty; `null` while occupied or before its first look. */
  idleSince: number | null
  /** When the sweep will remove the containers; `null` while occupied, or never by the setting. */
  stopsAt: number | null
  /** An owner's stop or the room's deletion is in flight. */
  stopping: boolean
}

/**
 * The first thing these scopes are busy with, in the order it matters to
 * someone about to stop them: a restart, an attempt, a cell, a queue, then
 * (when asked) the shell and a kernel still starting.
 *
 * The first five are what refuses an owner's stop. A start is not: it sees
 * the stop and lets go of its kernel itself (`ensureKernel` checks
 * `retired`), so it only keeps a class off the idle list.
 */
/** The notebook a scope computes for: its own root, or a pool's worker's notebook (§9.5), never the worker's hidden root. */
function notebookRootOf(scope: Runtime): string {
  return scope.pool?.root ?? scope.root
}

function busyOf(
  sessionId: string,
  scopes: Runtime[],
  options: { terminal: boolean; starts: boolean },
): ClassBusy | null {
  for (const scope of scopes) {
    if (scope.restarting) return { kind: 'restarting', participantId: null, root: notebookRootOf(scope), since: null }
  }
  for (const scope of scopes) {
    const active = scope.job
    if (active) {
      return { kind: 'attempt', participantId: active.job.participantId, root: notebookRootOf(scope), since: active.run.startedAt }
    }
  }
  for (const scope of scopes) {
    if (scope.currentCell !== null) {
      return {
        kind: 'cell',
        participantId: scope.currentRunById,
        root: notebookRootOf(scope),
        since: scope.started?.cellId === scope.currentCell ? scope.started.at : null,
      }
    }
  }
  for (const scope of scopes) {
    if (scope.queue.length > 0) {
      const people = new Set(scope.queue.map((item) => item.council?.participantId ?? item.runById))
      return { kind: 'queue', participantId: people.size === 1 ? [...people][0]! : null, root: notebookRootOf(scope), since: null }
    }
  }
  /*
   * The attempts waiting in the class's pool (§9.6): a class's work as much as
   * a notebook's queue, whenever its scopes are asked about (the workers
   * computing are scopes, above).
   */
  if (scopes.some((scope) => hidden(scope)) || options.terminal) {
    const waiting = poolSays('waiting', [] as QueueItem[], () => councilPool.waiting(sessionId))
    if (waiting.length > 0) {
      const people = new Set(waiting.map((item) => item.council?.participantId ?? item.runById))
      return { kind: 'queue', participantId: people.size === 1 ? [...people][0]! : null, root: waiting[0]!.council ? rootOf(sessionId, waiting[0]!.council.cellId) : null, since: null }
    }
  }
  if (options.terminal && terminalPhase(sessionId) === 'busy') {
    return { kind: 'terminal', participantId: null, root: null, since: null }
  }
  if (options.starts) {
    for (const scope of scopes) {
      if (scope.starting && !scope.kernel) return { kind: 'starting', participantId: null, root: notebookRootOf(scope), since: null }
    }
  }
  return null
}

function phaseOf(scope: Runtime): ScopeActivity['phase'] {
  if (scope.restarting) return 'restarting'
  if (scope.kernel) return scope.currentCell !== null ? 'busy' : scope.kernel.phase
  return scope.starting ? 'starting' : 'off'
}

/**
 * The classes this process holds kernel scopes for, live or coming up.
 *
 * The panel lists classes by their containers; this is the second source,
 * for the test backend (no containers at all) and for a docker census that
 * did not answer. A scope whose kernel died or never came up holds nothing
 * and is left out.
 */
export function kernelClasses(): string[] {
  const out: string[] = []
  for (const [sessionId, scopes] of runtimes) {
    for (const scope of scopes.values()) {
      if (scope.restarting || scope.starting || (scope.kernel && scope.kernel.phase !== 'dead')) {
        out.push(sessionId)
        break
      }
    }
  }
  return out
}

/**
 * One class's kernels and its place in the idle sweep, for the owner's
 * «Работают сейчас». Read-only: it never creates a scope, starts a kernel,
 * loads a document or moves the sweep's clock.
 *
 * `idleSince` is the sweep's own mark (`emptySince`), because that is what
 * the sweep will act on; the countdown is that mark plus the room setting,
 * and no earlier than the next pass, which is when the sweep can act. A room
 * the sweep has not seen empty yet gets its clock from the next pass, exactly
 * as the sweep will start it.
 */
export function classActivity(sessionId: string, now: number = Date.now()): ClassActivity {
  const scopes = scopesOf(sessionId)
  const busy = busyOf(sessionId, scopes, { terminal: true, starts: true })
  const occupied = busy !== null || onlineCount(sessionId) > 0
  const limit = roomIdleLimitMs()
  const since = occupied ? null : (emptySince.get(sessionId) ?? null)
  let stopsAt: number | null = null
  if (!occupied && limit !== null) {
    const pass = nextSweepAt ?? now
    stopsAt = Math.max((since ?? pass) + limit, pass)
  }
  let lastWorkAt: number | null = null
  for (const scope of scopes) {
    if (scope.lastWorkAt !== null && (lastWorkAt === null || scope.lastWorkAt > lastWorkAt)) lastWorkAt = scope.lastWorkAt
  }
  return {
    // Notebooks' kernels: a pool's workers are none of them (their work counts in `busy`).
    scopes: scopes.filter((scope) => !hidden(scope)).map((scope) => ({ root: scope.root, role: scope.role, phase: phaseOf(scope), lastWorkAt: scope.lastWorkAt })),
    busy,
    lastWorkAt,
    idleSince: since,
    stopsAt,
    stopping: kernelStopInProgress(sessionId),
  }
}

/* ------------------------------------------------------ the owner's stop */

/** A deletion or another owner stop of this class is under way. */
export function kernelStopInProgress(sessionId: string): boolean {
  return ownerStops.has(sessionId) || kernelRetirementInProgress(sessionId)
}

/**
 * What would refuse an owner's stop right now: work in the kernels being
 * stopped (a cell, an attempt, a queue, a restart), and for the whole class
 * the shared shell running a command too. People in the room are not a
 * refusal; the panel warns about them in its confirmation.
 */
export function stopBlocker(sessionId: string, what: 'class' | 'own'): ClassBusy | null {
  const scopes = scopesOf(sessionId).filter((scope) => what === 'class' || scope.role === 'own')
  return busyOf(sessionId, scopes, { terminal: what === 'class', starts: false })
}

/**
 * Why the owner's stop did not start; nothing was touched.
 *
 * `online`: only for a stop asked for an idle class (`idleOnly`), when
 * somebody is in the room after all; a single stop warns about people and
 * goes on.
 */
export class KernelStopRefusal extends Error {
  constructor(
    readonly reason: 'stopping' | 'busy' | 'online',
    readonly busy: ClassBusy | null = null,
  ) {
    super(tr(reason === 'stopping' ? 'server.running.stopping' : 'server.running.busy'))
    this.name = 'KernelStopRefusal'
  }
}

/** How long a forced stop waits for a restart in flight before it goes on regardless. */
const RESTART_WAIT_MS = 15_000

/**
 * The owner frees a class's memory from the panel: `class` takes both
 * containers, every notebook's kernel and the shared shell; `own` only the
 * personal-notebook container and the kernels in it.
 *
 * Not `shutdownSession`, which is made for a room that is over: it leaves the
 * badge on its last word, queued cells «в очереди» and council attempts
 * waiting for an answer that never comes, and it writes no line. This class
 * goes on, often with people in it, so every scope is retired the way a
 * notebook whose access changed is (`retireScope`): queues dropped and their
 * authors told, cells put to rest, the badge «не запущено», then ONE line in
 * the kernel log saying who stopped it, why, and how to bring it back.
 *
 * Starts of the containers being stopped are paused for the whole stop
 * (retirement.ts · pauseKernelStarts): a Run in the gap before `docker rm`
 * would start a container the stop then removes under it. Joins are not,
 * unlike a deletion: nobody is thrown out, on the broker either (pool.ts ·
 * OwnerStop). Stopping only the personal notebooks pauses only their
 * container: the lecture and the shell start as usual meanwhile.
 *
 * `idleOnly`: the batch «Остановить простаивающие» promises to take only
 * empty, quiet classes, and the panel's list it was pressed on is seconds
 * old. Nobody online and nothing computing, starting or running in the shell
 * is checked here, in the same synchronous stretch as the gate going up, so
 * a person who walks in a moment before is never left without a kernel.
 *
 * Never `permanent`: on the broker that retires the room for good, and this
 * room is expected back at its next Run.
 *
 * Throws KernelStopRefusal before touching anything (another stop or a
 * deletion in flight; work running, unless `force`; for `idleOnly`, anyone
 * in the room or any work at all), and the runtime's error when it did not
 * confirm the removal: the variables are gone by then, and the caller must
 * say the container may still hold memory.
 */
export async function stopKernelsByOwner(
  sessionId: string,
  what: 'class' | 'own',
  options: { force?: boolean; idleOnly?: boolean } = {},
): Promise<void> {
  if (kernelStopInProgress(sessionId)) throw new KernelStopRefusal('stopping')
  if (options.idleOnly) {
    if (onlineCount(sessionId) > 0) throw new KernelStopRefusal('online')
    // The panel's own word for idle (classActivity): a warm-up start counts too.
    const busy = busyOf(sessionId, scopesOf(sessionId), { terminal: true, starts: true })
    if (busy) throw new KernelStopRefusal('busy', busy)
  }
  const blocker = stopBlocker(sessionId, what)
  if (blocker && !options.force) throw new KernelStopRefusal('busy', blocker)
  // From here to the gate below, nothing awaits: the checks above hold when it goes up.
  // The whole class's stop removes its council pool too (pool.ts · dropRoomKernel): its starts wait with the rest.
  const release = pauseKernelStarts(sessionId, what === 'class' ? ['room', 'own', 'council'] : ['own'])
  const ours = (scope: Runtime): boolean => what === 'class' || scope.role === 'own'
  // The class's council pool goes with the class's kernels: its waiting attempts with no run, and no worker started again behind the stop.
  if (what === 'class') poolSays('closed', undefined, () => councilPool.closed(sessionId))
  const stop = (async () => {
    /*
     * A restart in flight is let finish first, for a bounded while: retiring
     * a scope under it makes the restart report "the kernel did not come
     * back", and a dead kernel's restart goes through `ensureKernel`, which
     * would make a fresh scope behind our back.
     */
    const restarts = scopesOf(sessionId).filter(ours).flatMap((scope) => (scope.restarting ? [scope.restarting] : []))
    if (restarts.length > 0) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled(restarts),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RESTART_WAIT_MS)
        }),
      ])
      clearTimeout(timer)
    }
    const victims = scopesOf(sessionId).filter(ours)
    await Promise.all(victims.map((scope) => retireScope(scope, null, { keepContainer: true })))
    let removed = false
    try {
      if (what === 'class') {
        try {
          await closeTerminal(sessionId)
        } catch (err) {
          console.error(`[kernel] could not stop the terminal for ${sessionId}:`, errText(err))
        }
        await dropRoomKernel(sessionId, false, { owner: true })
        // A new container counts its kills and the room its deaths from zero,
        // as after `shutdownSession`; and the idle clock starts over.
        forgetKills(sessionId)
        forgetDeaths(sessionId)
        emptySince.delete(sessionId)
      } else {
        await dropOwnKernel(sessionId, { owner: true })
      }
      removed = true
    } finally {
      /*
       * One line, written when it is true: the variables went with the
       * scopes even if the runtime then failed to confirm the removal. A
       * room whose row is gone (an orphan container) gets none: a note would
       * create its document anew.
       */
      if ((removed || victims.length > 0) && sessionRowExists(sessionId)) {
        kernelNote(sessionId, tr(what === 'class' ? 'server.kernel.stoppedByOwner' : 'server.kernel.ownStoppedByOwner'))
      }
    }
    console.log(`[kernel ${sessionId}] ${what === 'class' ? 'class' : 'personal-notebook'} kernels stopped by the owner`)
  })()
  ownerStops.set(sessionId, stop)
  try {
    await stop
  } finally {
    ownerStops.delete(sessionId)
    release()
  }
}

/**
 * Stopping the server, not the seminars.
 *
 * This used to DELETE every Jupyter session, which killed every kernel in
 * every room. `make run` is what the Makefile tells a teacher to do after any
 * edit, so a one-line change wiped the variables of every class in progress —
 * and the re-attach path, built precisely so a restart is invisible, only ever
 * ran after a crash. Now the sockets are dropped and the processes are left
 * running; a room's kernel is ended when the room is (shutdownSession).
 */
export async function shutdownKernels(): Promise<void> {
  poolSays('shutdown', undefined, () => councilPool.shutdown())
  const all = allScopes()
  runtimes.clear()
  // The sweep marks go along with the runtimes: the next process starts from a
  // clean slate, and its very first trigger must sweep for ghosts.
  orphanSweeps.clear()
  for (const runtime of all) {
    for (const item of runtime.queue) finishExecution(runtime, item, 'cancelled')
    runtime.queue.length = 0
    runtime.gateWait?.controller.abort()
    dropWriter(runtime)
    runtime.kernel?.detach()
  }
}

/** Scopes forgotten as a dead process forgets them (abandonKernelsForTest): what they still had under way sends and writes nothing. */
const abandoned = new WeakSet<Runtime>()

/**
 * For an end-to-end home that crashes (tests/_remote-e2e-home.mts · crash,
 * remote-classes.md §17.2 D20): forget every scope as a process that died
 * would, and nothing more. No kernel is asked anything and no DELETE leaves:
 * each kernel client is let go of (`detach`), a wait at a placement gate is
 * given up, queues, limits and writers are dropped where they stand (their
 * rooms' holds with them), and the class machines' records with their
 * timers. A cell that was computing stays as the document has it, as a crash
 * leaves it, for the next life to find (releaseOrphanedWork, ghost runs);
 * so does a council attempt (council.ts · settleGhostRun): nothing more of
 * it is reported, nor is its isolation left in the kernel. A start under way
 * lets its kernel go unasked. Not a writer's flush already timed (outputs.ts
 * cannot drop one unwritten): output printed in the crash's last
 * `config.outputFlushMs` may still be written.
 */
export function abandonKernelsForTest(): void {
  // The council pools die with the process too: nothing of theirs is said, nor any attempt released.
  poolSays('abandon', undefined, () => councilPool.abandon())
  const all = allScopes()
  runtimes.clear()
  orphanSweeps.clear()
  for (const runtime of all) {
    abandoned.add(runtime)
    runtime.retired = true
    runtime.queue.length = 0
    runtime.gateWait?.controller.abort()
    if (runtime.limit?.timer) clearTimeout(runtime.limit.timer)
    // An attempt's next output frame (touchJob) is never sent.
    if (runtime.job?.timer) clearTimeout(runtime.job.timer)
    runtime.writer = null
    runtime.writerHold?.()
    runtime.writerHold = null
    runtime.kernel?.detach()
  }
  for (const outage of outages.values()) if (outage.timer !== null) classClock.clearTimeout(outage.timer)
  outages.clear()
  lastMachine.clear()
  movedOff.clear()
  terminalSlots.clear()
}

/**
 * Kernel state for the minute summary: live, of those busy, and dead.
 *
 * KERNELS are counted, not rooms: a class has as many as notebooks were opened
 * in it, plus its students' personal notebooks. The summary is about the
 * machine's load, and the load comes from every process, not from a room.
 *
 * Notebooks whose kernel has never been brought up are not counted at all:
 * they have no kernel rather than a dead one, and recording an empty notebook
 * as a loss would scare whoever reads the journal every minute.
 */
export function kernelCensus(): { live: number; busy: number; dead: number } {
  let live = 0
  let busy = 0
  let dead = 0
  for (const runtime of allScopes()) {
    const phase = runtime.kernel?.phase
    if (!phase) continue
    if (phase === 'dead') {
      dead += 1
      continue
    }
    live += 1
    // Busy means a cell is really running in the notebook: the 'busy' phase
    // comes from Jupyter with a delay, while `currentCell` knows it from the
    // very execute.
    if (phase === 'busy' || runtime.currentCell !== null) busy += 1
  }
  return { live, busy, dead }
}

/**
 * The same census for /metrics: split by container (the class's or the
 * personal notebooks'), in states that do not overlap, with the run queue
 * beside it. `starting` is a kernel being brought up, the up-to-a-minute-
 * and-a-half of a cold start that the room spends staring at nothing.
 *
 * Counts only. Nothing here names a room, so a scrape grows no series per
 * class; which room is struggling is what the log is for.
 */
export function kernelMetrics(): {
  kernels: Record<KernelRole, Record<'idle' | 'busy' | 'starting' | 'dead', number>>
  runs: { queued: number; running: number }
} {
  const kernels: Record<KernelRole, Record<'idle' | 'busy' | 'starting' | 'dead', number>> = {
    room: { idle: 0, busy: 0, starting: 0, dead: 0 },
    own: { idle: 0, busy: 0, starting: 0, dead: 0 },
    council: { idle: 0, busy: 0, starting: 0, dead: 0 },
  }
  let queued = 0
  let running = 0
  for (const runtime of allScopes()) {
    // The running cell has left the queue (pump · shift): the two never count one run twice.
    queued += runtime.queue.length
    if (runtime.currentCell !== null) running += 1
    const counts = kernels[runtime.role]
    if (!counts) continue
    const phase = runtime.kernel?.phase
    if (!phase) {
      if (runtime.starting) counts.starting += 1
      continue
    }
    if (phase === 'dead') counts.dead += 1
    else if (phase === 'busy' || runtime.currentCell !== null) counts.busy += 1
    else counts.idle += 1
  }
  return { kernels, runs: { queued, running } }
}

/**
 * Whether this participant is the one whose cell is running right now.
 *
 * Read from the runtime rather than the document: the document is shared and a
 * client could write `runById` into a cell itself. The queue is the server's
 * own record of who asked for what.
 *
 * `root` is the notebook being asked about; without it, ANY notebook of the
 * class. That is not a loosening but the old meaning of the question: it is
 * asked by "stop" and by answering `input()`, and a person whose cell is
 * computing in the seminar stays its owner whichever tab they keep open.
 */
export function startedTheRunningCell(
  sessionId: string,
  participantId: string,
  root?: string,
): boolean {
  const scopes = root === undefined ? scopesOf(sessionId) : [peekRuntime(sessionId, root)]
  return scopes.some((scope) => scope !== undefined && startedIn(scope, participantId))
}

function startedIn(runtime: Runtime, participantId: string): boolean {
  /*
   * A pool's worker grants nothing here: "stop" stops a NOTEBOOK's kernel,
   * and an attempt of one's own on a worker is stopped by naming it
   * (interruptSession · participantId), never by holding the right to
   * interrupt whatever the notebook's kernel computes.
   */
  if (hidden(runtime)) return false
  if (runtime.currentCell) return runtime.currentRunById === participantId
  /*
   * Between two cells the owner of the work is the one whose cell stands first.
   *
   * `currentRunById` now goes out together with `currentCell` (otherwise the
   * "one at a time" ceiling refused the previous author while the pump was
   * bringing up a dead kernel, and that takes up to a minute and a half).
   * Reading it in that window would be untrue; but answering "no" is not
   * allowed either: in exactly this gap a person running Run All presses
   * "stop", and a refusal would leave them with a running notebook and a silent
   * button. We ask the queue: it is about the same work and is ours too.
   */
  return runtime.queue[0]?.runById === participantId
}

/**
 * Whether the queue holds only what this person queued.
 *
 * A nameless "stop" throws out the notebook's whole queue, and a notebook's
 * queue is shared: one press would remove other people's batches under the
 * same right with which a person stops their own cell. An empty queue counts
 * as one's own: there is nothing to stop.
 *
 * `root` is the notebook whose queue is about to be cleared; without it, all
 * of the class's queues, as it was when there was one queue.
 */
export function queueIsOnly(sessionId: string, participantId: string, root?: string): boolean {
  // The notebooks' queues: a pool's worker's one attempt is no queue a nameless stop clears.
  const scopes = root === undefined ? scopesOf(sessionId).filter((scope) => !hidden(scope)) : [peekRuntime(sessionId, root)]
  return scopes.every(
    (scope) => scope === undefined || scope.queue.every((item) => item.runById === participantId || item.service !== undefined),
  )
}

/* -------------------------------------------------------------- run queue */

let batchCounter = 0

/**
 * Put cells into the queue.
 *
 * `cap` is how many of their own cells this person may hold in the queue at
 * once; under the "one at a time" rule that is one. A ceiling, not a right: it
 * is what makes "one at a time" a boundary rather than a press counter; a
 * scripted loop of `{t:'run'}` frames queues one cell and gets a sentence for
 * the rest. Returns how many cells did not fit, so the caller says so once,
 * not twenty times.
 */
export function requestRun(
  sessionId: string,
  cellIds: string[],
  runBy: string,
  runById: string,
  cap = Number.POSITIVE_INFINITY,
  /**
   * The notebook whose queue this is. Without it, the room's notebook, i.e. the
   * old behaviour of a frame without a sheet name.
   *
   * The `cap` ceiling is counted PER THIS queue, and that follows from there now
   * being several kernels: "one at a time" means "one at a time per notebook",
   * otherwise the rule would lock a student whose cell is computing in the
   * lecture out of their own draft.
   */
  root: string = CELLS_KEY,
): number {
  const runtime = getRuntime(sessionId, root)
  // A press repairs the room it was made in: if a cell is left there that the
  // document considers running while the server knows nothing of it, now is the
  // time to notice. See sweepOrphanRuns.
  sweepOrphanRuns(sessionId)
  const { doc } = getSessionDoc(sessionId)
  const batch = ++batchCounter

  // Counted from the runtime, not from the document: everyone writes the document.
  let mine =
    runtime.queue.filter((item) => item.runById === runById).length +
    (runtime.currentRunById === runById ? 1 : 0)
  let refused = 0

  doc.transact(() => {
    for (const cellId of cellIds) {
      const found = findCell(doc, cellId)
      // Markdown cells arrive in every runAll list; skipping them is not an error.
      if (!found || cellType(found.cell) !== 'code') continue
      /*
       * A cell from another notebook does not join this queue.
       *
       * The lists arrive here assembled per sheet, so in practice this is
       * silent. But a frame arrives over the wire, and a cell named from someone
       * else's notebook would compute in this one's kernel, i.e. would see its
       * variables. Exactly the boundary there are several kernels for.
       */
      if (rootOfArray(found.cells) !== runtime.root) continue
      if (runtime.currentCell === cellId) continue
      if (runtime.queue.some((item) => item.cellId === cellId)) continue
      if (mine >= cap) {
        refused += 1
        continue
      }
      mine += 1
      const item: QueueItem = { cellId, runBy, runById, batch }
      item.activitySeq = executionActivity(runtime, item, 'execution.queued', { count: 1 })
      runtime.queue.push(item)
      found.cell.set('state', 'queued' as CellState)
      found.cell.set('runBy', runBy)
      found.cell.set('runById', runById)
    }
  }, ORIGIN)

  syncQueue(runtime)
  void pump(runtime)
  return refused
}

/**
 * Take cells back out of the queue.
 *
 * Only ones that are still waiting: the cell holding the kernel is Interrupt's
 * business, and this must never be a second, quieter way to stop somebody
 * else's run. Whoever queued a cell may cancel it, and so may the host.
 *
 * Ownership is decided from the server's own queue record rather than from the
 * cell's `runById`, which is a field in a document anyone in the room can write.
 *
 * Returns how many were actually removed, so the caller can tell the difference
 * between "cancelled" and "there was nothing of yours to cancel".
 */
export function cancelRun(
  sessionId: string,
  cellIds: string[],
  participantId: string,
  isHost: boolean,
): number {
  /*
   * Across ALL of the class's queues, not one.
   *
   * The cell's name itself names its notebook, and the caller has no way to
   * name it separately: `onCellsRemoved` comes here too, when the cell is no
   * longer in the document and there is nobody to ask about it. The queue is
   * our record; the cell lies in it where it was put, and this is the only way
   * to find it.
   */
  let removedTotal = 0
  for (const runtime of scopesOf(sessionId)) {
    removedTotal += cancelIn(runtime, cellIds, participantId, isHost)
  }
  return removedTotal
}

function cancelIn(
  runtime: Runtime,
  cellIds: string[],
  participantId: string,
  isHost: boolean,
): number {
  const sessionId = runtime.sessionId
  const wanted = new Set(cellIds)
  const removed: string[] = []

  runtime.queue = runtime.queue.filter((item) => {
    if (!wanted.has(item.cellId)) return true
    if (!isHost && item.runById !== participantId) return true
    removed.push(item.cellId)
    finishExecution(runtime, item, 'cancelled')
    return false
  })
  if (removed.length === 0) return 0

  const { doc } = getSessionDoc(sessionId)
  doc.transact(() => {
    for (const cellId of removed) {
      const found = findCell(doc, cellId)
      if (!found) continue
      found.cell.set('state', 'idle' as CellState)
      found.cell.set('runBy', null)
      found.cell.set('runById', null)
    }
  }, ORIGIN)
  syncQueue(runtime)
  return removed.length
}

/** Did the cell that just ran end in a traceback? */
function failed(runtime: Runtime, cellId: string): boolean {
  const { doc } = getSessionDoc(runtime.sessionId)
  return findCell(doc, cellId)?.cell.get('state') === 'error'
}

/**
 * Which batch the cell named by a press came from, as far as the server still
 * remembers.
 *
 * `null` means "we do not know": the cell is not in the queue, is not running
 * and was not the last to finish. Then there is nothing to judge the batch by,
 * and the caller decides.
 */
function batchOf(runtime: Runtime, cellId: string): number | null {
  const queued = runtime.queue.find((item) => item.cellId === cellId)
  if (queued) return queued.batch
  if (runtime.currentCell === cellId) return runtime.currentBatch
  if (runtime.lastFinished?.cellId === cellId) return runtime.lastFinished.batch
  return null
}

/**
 * A cell failed, so the rest of the same Run All is not worth running.
 *
 * Thirty cells that each need the one before produce thirty tracebacks, and the
 * only one worth reading is the first. Cells queued by anybody else stay: their
 * work is not what just broke.
 */
/**
 * Drop what was queued by the same press of Run as the cell now running.
 *
 * Everything else in the queue belongs to somebody else's press and is none of
 * this interrupt's business.
 */
function stopBatchOf(runtime: Runtime, cellId: string): void {
  const mine = runtime.queue.find((item) => item.cellId === cellId)
  const batch = mine?.batch ?? runtime.currentBatch
  if (batch === null || batch === undefined) return
  const dropped = runtime.queue.filter((item) => item.batch === batch)
  if (dropped.length === 0) return
  runtime.queue = runtime.queue.filter((item) => item.batch !== batch)

  const { doc } = getSessionDoc(runtime.sessionId)
  doc.transact(() => {
    for (const item of dropped) {
      const found = findCell(doc, item.cellId)
      if (!found) continue
      found.cell.set('state', 'idle' as CellState)
      found.cell.set('runBy', null)
      found.cell.set('runById', null)
    }
  }, ORIGIN)
  releaseCouncil(runtime, dropped)
  syncQueue(runtime)
  // Said out loud, because a queue that empties without a word reads as a
  // product that ignored the button.
  kernelNote(
    runtime.sessionId,
    dropped.length === 1
      ? tr("server.theInterruptAlsoDroppedTheOneCell.612a37")
      : tr("server.theInterruptAlsoDroppedTheCellsQueued.cfbaff", { p0: dropped.length }),
  )
}

function stopBatch(runtime: Runtime, failedItem: QueueItem): void {
  const dropped = runtime.queue.filter((item) => item.batch === failedItem.batch)
  if (dropped.length === 0) return
  runtime.queue = runtime.queue.filter((item) => item.batch !== failedItem.batch)

  const { doc } = getSessionDoc(runtime.sessionId)
  doc.transact(() => {
    for (const item of dropped) {
      const found = findCell(doc, item.cellId)
      if (!found) continue
      found.cell.set('state', 'idle' as CellState)
      found.cell.set('runBy', null)
      found.cell.set('runById', null)
    }
  }, ORIGIN)
  releaseCouncil(runtime, dropped)
  syncQueue(runtime)
  kernelNote(
    runtime.sessionId,
    dropped.length === 1
      ? tr("server.aCellFailedSoTheOneQueued.6d932d")
      : tr("server.aCellFailedSoTheCellsQueued.bbcda8", { p0: dropped.length }),
  )
}

async function pump(runtime: Runtime): Promise<void> {
  if (runtime.pumping) return
  /*
   * The pump does not process an empty queue at all, and that is not about
   * saving work.
   *
   * The `finally` below announces the kernel phase to the room, and a scope
   * whose kernel was never brought up has no phase, which reads as `dead`.
   * While there was one queue per room, nothing came here with an empty one;
   * now things do: a Run whose cells were all filtered out (markdown, the "one
   * at a time" ceiling, a cell from another notebook) creates a scope and wakes
   * the pump. Without this line a notebook where nobody ran anything would get
   * a "kernel stopped" badge.
   */
  if (runtime.queue.length === 0) return
  runtime.pumping = true
  // What the chip says when the loop ends without a kernel: see reportDeadKernel.
  let down: KernelStatus = 'dead'
  try {
    while (runtime.queue.length > 0) {
      // A ban may interrupt one Council author while another waits behind
      // them. The HTTP interrupt can arrive after the first run ends; starting
      // the next job before it settles would deliver that SIGINT to the wrong
      // author. Keep the queue intact and wait only at this boundary.
      if (runtime.beforeNext) await runtime.beforeNext
      // A restart is under way: wait for it rather than send execute to a
      // kernel that will be gone in a moment. Such an execute never gets an
      // answer.
      if (runtime.restarting) {
        await runtime.restarting.catch(() => {})
        // A restart clears the queue; whatever is left arrived after it.
        if (runtime.queue.length === 0) break
      }
      /*
       * The slot's placement gate (remote-classes.md §5.3). At home, and on a
       * machine that answers, there is nothing to wait for: the pump goes on
       * in this same turn, without an await. While the machine cannot be
       * reached the queue stands here, its cells still `queued`; without the
       * gate a Run in an outage would fail `POST /api/sessions` a minute
       * later. A failover ends the wait with the queue dropped (`passGate`).
       */
      const view = viewOf(runtime.sessionId, runtime.role)
      if (view.where === 'machine') {
        const go = await passGate(runtime, view)
        // Lost, retired, or every waiting cell cancelled while it waited.
        if (!go || runtime.retired || runtime.queue.length === 0) {
          // Nothing ran: a scope with no kernel has nothing to call dead.
          down = 'off'
          if (!go) return
          break
        }
      }
      /*
       * The export of the council's epoch never starts a kernel (§9.2): with
       * none live by its turn, the epoch is empty by construction, and it is
       * answered so at once.
       */
      const head = runtime.queue[0]
      if (head?.service && (!runtime.kernel || runtime.kernel.phase === 'dead' || runtime.kernel.endedBy)) {
        runtime.queue.shift()
        answerService(head.service, { refused: 'no-kernel' })
        continue
      }
      try {
        await ensureKernel(runtime.sessionId, runtime.root)
      } catch (err) {
        // The machine went quiet between the gate and the start: back to the gate, to wait there.
        if (err instanceof MachineUnreachable) continue
        /*
         * Lost with its machine while the kernel came up: the failover said
         * it and dropped the queue (`loseSlot`). Whatever was queued after it
         * goes where the class computes now, through the gate again.
         */
        if (err instanceof StartLost) {
          down = 'off'
          continue
        }
        // A pool's worker that did not come up gives its attempt back: it runs in the notebook's kernel (§9.9).
        if (hidden(runtime)) {
          giveBackQueue(runtime, errText(err), false)
          return
        }
        const full = machineMemoryFull(err)
        down = full ? 'off' : 'dead'
        reportDeadKernel(runtime, startWords(runtime.sessionId, runtime.role, errText(err)), full)
        return
      }
      /*
       * A pool's worker loads its notebook's epoch before the attempt, beside
       * the guard ensureKernel installed (§9.5 «Seeding»): the epoch its
       * attempt was given, once. One that will not load gives the attempt
       * back, to the notebook's kernel.
       */
      const handle = handleOf(runtime)
      const next = runtime.queue[0]
      if (handle && next?.council) {
        const seeded = await councilPool.seed(handle, next).catch((err: unknown) => {
          console.warn(`[kernel ${runtime.sessionId}/${runtime.root}] the council worker could not load its epoch:`, errText(err))
          return false
        })
        if (!seeded) {
          giveBackQueue(runtime, 'its epoch did not load', false)
          continue
        }
      }
      const item = runtime.queue.shift()
      if (!item) break
      if (item.service) {
        await runService(runtime, item, item.service)
        continue
      }
      if (item.council) await runCouncilOne(runtime, item, item.council)
      else await runOne(runtime, item)
      if (runtime.kernel && runtime.kernel.phase === 'dead') {
        dropOrGiveBack(runtime, 'its kernel died', runtime.kernel.endedBy != null)
        return
      }
      if (failed(runtime, item.cellId)) stopBatch(runtime, item)
    }
  } catch (err) {
    // The queue must not die silently with cells stuck on "running".
    console.error(`[kernel] run queue failed for ${runtime.sessionId}/${runtime.root}:`, errText(err))
    reportDeadKernel(runtime, errText(err))
  } finally {
    runtime.pumping = false
    runtime.currentCell = null
    runtime.currentBatch = null
    runtime.currentRunById = null
    syncQueue(runtime)
    const phase = runtime.kernel?.phase ?? down
    // A kernel ended from outside is not a death: see `onPhase`.
    setStatus(runtime, runtime.kernel?.endedBy ? 'off' : phase === 'busy' ? 'idle' : (phase as KernelStatus))
    // A pool's worker is free again: its pool recycles it if it must, and gives it the next attempt (§9.5, §9.6).
    const handle = handleOf(runtime)
    if (handle) poolSays('idle', undefined, () => councilPool.idle(handle))
  }
}

async function runOne(runtime: Runtime, item: QueueItem): Promise<void> {
  const { doc } = getSessionDoc(runtime.sessionId)
  const found = findCell(doc, item.cellId)
  // Someone deleted the cell while it sat in the queue.
  if (!found || cellType(found.cell) !== 'code') {
    finishExecution(runtime, item, 'cancelled')
    return
  }

  const cell = found.cell
  runtime.activityItem = item
  const source = cellSource(cell).toString()
  /*
   * The image ceiling depends on the number of people the images will travel
   * to.
   *
   * A cell's output goes into the shared document, i.e. to EVERY open socket of
   * the room, each in its own copy and with its own deflate. Six megabytes of
   * `imshow` in a seminar of thirty is a hundred and eighty megabytes and
   * bothers nobody; the same six on a cohort of five hundred is a gigabyte of
   * egress, behind which everyone's own typing queues up. See dataBudgetFor.
   */
  const writer = new OutputWriter(
    doc,
    item.cellId,
    dataBudgetFor(onlineCount(runtime.sessionId)),
    // The room, so that large images are stored next to it, not in the document.
    runtime.sessionId,
  )
  runtime.currentCell = item.cellId
  runtime.currentBatch = item.batch
  runtime.currentRunById = item.runById
  // The writer will outlive this call, and so will the document it took: while
  // it writes, the room is not evicted from memory. `dropWriter` releases it.
  dropWriter(runtime)
  runtime.writer = writer
  runtime.writerHold = holdRoom(runtime.sessionId)
  // The same number in two places: into the document, so everyone's clocks
  // grow; into the runtime, so the duration is counted from our record.
  const startedAt = Date.now()
  runtime.started = { cellId: item.cellId, at: startedAt }
  executionActivity(runtime, item, 'execution.started')
  syncQueue(runtime)
  setStatus(runtime, 'busy')

  doc.transact(() => {
    cell.set('state', 'running' as CellState)
    cell.set('runBy', item.runBy)
    cell.set('runById', item.runById)
    cell.set('execCount', null)
    /*
     * One number in a transaction that is happening anyway.
     *
     * A cell's live stopwatch is exactly this mark plus counting in the
     * browser. Writing here every second would look simpler and be ruinous in
     * practice: a field changing more often than once every twelve seconds
     * keeps a history burst open forever (and attributes to the room everything
     * people typed in that time), and makes the disk write encode a snapshot
     * every few seconds in an empty room. Here it is zero extra Yjs updates,
     * zero extra broadcasts and zero extra bursts.
     *
     * `ranMs` is cleared together with `execCount` and for the same reason: the
     * time of the previous execution stops being true the moment this one
     * starts.
     */
    cell.set('startedAt', startedAt)
    cell.set('ranMs', null)
    /*
     * The previous output is erased right here, in this very transaction.
     *
     * It is still erased at the start, not in the queue: until the cell goes,
     * the previous result is still the truth on the screen. One thing changed:
     * it used to be a separate transaction a line below, and the client got two
     * events. On the first one the field observer woke up: `execCount` went to
     * null and the `Out [n]` line disappeared, twenty-four pixels. On the second
     * the output observer woke up, and the body disappeared. Between those two
     * frames the area managed to be measured twenty-four pixels shorter, i.e.
     * the space for the new output was reserved wrong, and the room saw an
     * extra jump.
     *
     * One transaction is one update on the wire, one record() call and one
     * shapeOf pass per run. For a Run All of forty cells in a room of twenty,
     * that is forty updates and eight hundred frames that no longer exist.
     */
    writer.clear()
  }, ORIGIN)

  if (source.trim().length === 0) {
    runtime.currentCell = null
    runtime.currentBatch = null
    runtime.currentRunById = null
    runtime.lastFinished = { cellId: item.cellId, batch: item.batch }
    runtime.lastWorkAt = Date.now()
    dropWriter(runtime)
    setCellState(runtime.sessionId, item.cellId, 'ok')
    finishExecution(runtime, item, 'completed', Math.max(0, Date.now() - startedAt))
    return
  }

  /*
   * A history run of the notebook (remote-classes.md §9.2): an execute that
   * stores history, whoever pressed (the teacher, an open cell, an adopted
   * attempt, the oracle's run_cell). The council's pool counts them against
   * its epoch; attempts and service runs never come here. Counted as the
   * pump takes the cell, before anything is awaited: an export asked from
   * here on waits behind it in the queue and holds it, and its epoch must
   * count it too (a run the guard or the barrier then refuses costs one
   * needless refreeze, never a stale epoch taken for a current one).
   */
  poolSays('historyRun', undefined, () => councilPool.historyRun(runtime.sessionId, runtime.root, item.cellId))

  /*
   * The guard against dangerous commands, before the first line goes to the
   * kernel.
   *
   * Usually this is zero work: the fingerprint matches what the kernel has
   * already been told, and the function returns without leaving the process. A
   * trip to the kernel happens exactly twice: on the first cell after start-up
   * and on a rule change in the middle of class.
   *
   * If it is not confirmed, the cell is NOT executed, and we say why. Letting it
   * through would mean returning to exactly where it all started: `os._exit(0)`
   * in someone's cell and thirty people without variables, without a line in
   * the journal and without a cause.
   */
  if (!(await ensureGuard(runtime))) {
    /*
     * A kernel that died in the gap between `ensureKernel` and this line is
     * explained in its own words: "the guard was not confirmed" would send the
     * teacher looking for a breakage in a rule they did not touch. The
     * exception name in the second case is empty by the same argument as for a
     * stop by the limit: the cell draws "name: text", and an English word in
     * front of a Russian phrase adds nothing.
     */
    if (runtime.kernel?.phase === 'dead') writer.error('KernelDied', deadMessage(), [])
    else writer.error('', tr('server.guard.notConfirmed'), [])
    runtime.currentCell = null
    runtime.currentBatch = null
    runtime.currentRunById = null
    runtime.lastFinished = { cellId: item.cellId, batch: item.batch }
    runtime.lastWorkAt = Date.now()
    dropWriter(runtime)
    setCellState(runtime.sessionId, item.cellId, 'error')
    finishExecution(runtime, item, 'error', Math.max(0, Date.now() - startedAt))
    return
  }

  /*
   * Everything typed goes to disk before the cell goes to read it.
   *
   * `%run solve.py`, `open('data.csv')`, `import helpers` read a file, not the
   * document, and the document reaches the disk with a delay: the editor 700 ms
   * after the last keystroke, notebooks after a second and a half. A cell run
   * right after an edit read the previous version of the file and failed on the
   * line that had just been fixed in front of everyone, and there was nothing
   * to explain it with.
   */
  flushToDisk(runtime.sessionId)
  /*
   * And to the machine, when this kernel computes on one (remote-classes.md
   * §8.2): the class folder there is a copy, and what was saved here a
   * second ago is a push away. With nothing written since the last push the
   * barrier is a compare of two numbers; otherwise the cell says what is on
   * its way («Файлы едут на машину: 12 из 150 МБ…»), and a push that stops
   * moving refuses the cell in words before the limit's clock starts.
   */
  let moving = false
  const barred = await passFilesBarrier(runtime, (words) => {
    moving = true
    writer.supersede()
    writer.stream('stdout', words)
  })
  if (moving) writer.clear()
  if (barred !== null) {
    runtime.currentCell = null
    runtime.currentBatch = null
    runtime.currentRunById = null
    runtime.lastFinished = { cellId: item.cellId, batch: item.batch }
    runtime.lastWorkAt = Date.now()
    if (barred === STOPPED) {
      // Stopped before it reached the kernel: back at rest, as a queued cell dropped by the same press is (stopBatchOf).
      dropWriter(runtime)
      doc.transact(() => {
        cell.set('state', 'idle' as CellState)
        cell.set('runBy', null)
        cell.set('runById', null)
        cell.set('startedAt', null)
      }, ORIGIN)
      finishExecution(runtime, item, 'cancelled', Math.max(0, Date.now() - startedAt))
      return
    }
    writer.error('', barred, [])
    dropWriter(runtime)
    setCellState(runtime.sessionId, item.cellId, 'error')
    finishExecution(runtime, item, 'error', Math.max(0, Date.now() - startedAt))
    return
  }

  const unwatch = stopIfDeleted(runtime, doc, item.cellId)
  /*
   * The room's alarm on an ordinary cell, by the same mechanism as an
   * attempt's.
   *
   * Set BEFORE the first line goes to the kernel and after the empty-cell check:
   * an empty cell has nothing to compute, while everything else is already time
   * the queue stands still. The number is read HERE, not at queueing time, and
   * that is no accident: "rules apply at once" is a promise to the whole room,
   * and between pressing Run All and the fortieth cell half a class goes by.
   */
  beginLimit(runtime, item, cellLimitOf(runtime.sessionId), startedAt)
  /** Whether we have already said the limit stopped it: that line is needed once. */
  let saidStopped = false
  /** The number of the limit that fired, asked of the record while it is alive. */
  const firedNow = (): number | null =>
    runtime.limit?.item === item ? runtime.limit.firedSec : null
  let state: CellState = 'idle'
  try {
    /*
     * A kernel can die between two cells without anything saying so — Jupyter
     * leaves the socket open when it goes, so the first this server hears of it
     * is the check inside execute(). One retry turns that into a fresh kernel
     * and a cell that runs, rather than an error nobody can act on and a Run
     * that works the second time for no visible reason. The room is told what
     * happened by the phase change either way, so nothing is being hidden.
     */
    const status = await runOnKernel(runtime, source, {
      onExecuteInput: (execCount) => {
        const target = findCell(doc, item.cellId)
        if (target) doc.transact(() => target.cell.set('execCount', execCount), ORIGIN)
      },
      onStream: (name, text) => writer.stream(name, text),
      onData: (mimebundle, execCount) => writer.data(mimebundle, execCount),
      /*
       * A stop by the limit is explained by one line, not a traceback.
       *
       * SIGINT arrives in Python as `KeyboardInterrupt`, and by default the cell
       * would keep its traceback: a dozen frames of someone else's library and a
       * line about a keyboard nobody pressed. The room reads that as "someone
       * pressed stop". The substitution is made HERE, on the way in, not by
       * editing what has already been written: a cell's output lives in the
       * shared document, and striking things out of it after the fact means
       * extra tombstones for everyone and an extra history pass. For an attempt
       * the same line comes about differently, through a buffer in memory
       * (kernel/council.ts · stopped): there an after-the-fact edit costs
       * nothing.
       */
      onError: (ename, evalue, traceback) => {
        /*
         * Our own refusal is one line without a traceback, just like a stop by
         * the limit. The `<colloq-guard>` frames in it are not student code:
         * that is our module explaining why `os._exit()` in a shared notebook
         * takes the kernel down for the whole class, and all of that is already
         * said in human words in the refusal text itself. The code BEFORE the
         * dangerous line ran as usual: a refusal is an exception, not a
         * cancellation of the cell.
         */
        if (ename === COLLOQ_REFUSED) {
          writer.error('', evalue, [])
          return
        }
        const fired = firedNow()
        if (fired !== null && (ename === 'KeyboardInterrupt' || ename === 'Interrupted')) {
          // The exception name is empty on purpose: the cell draws "name: text",
          // and an English word in front of a Russian phrase adds nothing.
          writer.error('', tr('server.cell.stoppedByLimit', { p0: durationWords(fired) }), [])
          saidStopped = true
          return
        }
        writer.error(ename, evalue, traceback)
      },
      // wait=True promises a replacement, wait=False erases now. See OutputWriter.
      onClear: (wait) => (wait ? writer.supersede() : writer.clear()),
      /*
       * input() blocks the kernel until a person types something, so the ask
       * goes into the shared document rather than to whoever pressed Run: in a
       * seminar the person who can answer is often not the person who started
       * the cell, and a room staring at a cell that never finishes has no way
       * to find out why.
       */
      onInputRequest: (prompt, password) => {
        const target = findCell(doc, item.cellId)
        if (target) {
          doc.transact(() => target.cell.set('stdin', { prompt, password }), ORIGIN)
        }
      },
    })
    // Its process is gone, as far as this scope knows (abandonKernelsForTest): the document keeps the cell as the crash left it.
    if (abandoned.has(runtime)) return
    state = status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'idle'
    if (status === 'abort') {
      const phase = runtime.kernel?.phase
      if (runtime.kernel?.endedBy) {
        // Cut off by a failover: what became of it on the machine is unknown (§11.2).
        writer.error('', lostMidRun(), [])
        state = 'error'
      } else if (phase === 'dead') {
        writer.error('KernelDied', deadMessage(), [])
        state = 'error'
      } else if (phase === 'restarting' && runtime.kernel?.phaseExpected === false) {
        /*
         * The kernel was restarted not by a person but by Jupyter itself: the
         * process was killed (almost always for memory), and this cell killed
         * it. The phase at this moment is `restarting`, not `dead`, so this
         * branch was never reached before: the cell sat down in `idle` with
         * "Out [7]", indistinguishable on screen from a successful one, and
         * nobody saw the link to the NameError in the next one any more.
         */
        writer.error('KernelDied', killedMessage(), [])
        state = 'error'
      }
    }
  } catch (err) {
    if (abandoned.has(runtime)) return
    // A run cut off by a failover on its way to the machine (or to its fresh kernel there) reads as one cut off there.
    if (runtime.kernel?.endedBy || err instanceof StartLost) writer.error('', lostMidRun(), [])
    else writer.error('KernelError', startWords(runtime.sessionId, runtime.role, errText(err)), [])
    state = 'error'
  } finally {
    unwatch()
    /*
     * The alarm is cleared HERE, at the cell's only exit, and so it is cleared
     * on every outcome: a normal end, a failure, an interrupt, a kernel death,
     * the cell's removal. Were it to outlive its cell even for a moment, the
     * signal would go to the next queue entry, i.e. someone else's cell or
     * someone's attempt.
     */
    const fired = clearLimit(runtime, item)
    /*
     * And the word about the stop, if it has not been said yet.
     *
     * The ordinary case is caught by `onError` above: the kernel answers
     * `KeyboardInterrupt`, and a line takes the traceback's place. Those without
     * one get here: the cell caught the interrupt with its own `except` and
     * failed with something else, or `execute` did not answer with an error at
     * all. Keeping quiet about the stop in these cases would leave the teacher
     * with a cell that broke off for no reason.
     */
    if (fired !== null && state === 'error' && !saidStopped) {
      writer.error('', tr('server.cell.stoppedByLimit', { p0: durationWords(fired) }), [])
    }
    dropWriter(runtime)
    runtime.currentCell = null
    runtime.currentBatch = null
    /*
     * And the run's owner is cleared right here too, together with the cell.
     *
     * `currentRunById` used to be kept until the queue emptied (the pump's
     * `finally`), and between two cells the pump manages to go into
     * `ensureKernel`: a dead kernel takes up to a minute and a half. All that
     * time `requestRun` counted an extra "running" cell for the previous author
     * and, under the "one at a time" rule, refused them a new Run, although
     * nothing of theirs was running.
     */
    runtime.currentRunById = null
    // Whose batch this was is remembered for one more round: a "stop" on this
    // cell may arrive after the kernel has already taken the next one.
    runtime.lastFinished = { cellId: item.cellId, batch: item.batch }
    runtime.lastWorkAt = Date.now()
    // The prompt belongs to a running cell. Whatever ended the run — an answer,
    // an interrupt, a dead kernel — it must not be left on screen asking.
    const target = findCell(doc, item.cellId)
    if (target?.cell.get('stdin')) {
      doc.transact(() => target.cell.set('stdin', null), ORIGIN)
    }
  }

  setCellState(runtime.sessionId, item.cellId, state)
  finishExecution(runtime, item, state === 'ok' ? 'completed' : state === 'error' ? 'error' : 'cancelled',
    Math.max(0, Date.now() - startedAt))
  syncQueue(runtime)
  // The cell may have written a CSV; the Files panel should not need a refresh.
  notifyWorkspaceChanged(runtime.sessionId)
  // On a machine, the CSV is there: its scan reports it now, not at its next round (§8.3).
  askSlotScan(runtime.sessionId, runtime.role)
}

/**
 * A service run of a notebook's kernel (QueueItem.service): the export of the
 * council's epoch (remote-classes.md §9.2), one silent execute between the
 * teacher's cells, reported through `user_expressions`. Nothing of it reaches
 * the document — no cell runs, no state changes, no history is stored — and
 * the room's kernel indicator does not blink at it (`quiet`).
 */
async function runService(runtime: Runtime, _item: QueueItem, job: ServiceJob): Promise<void> {
  const kernel = runtime.kernel
  if (!kernel || kernel.phase === 'dead' || kernel.endedBy) {
    answerService(job, { refused: 'no-kernel' })
    return
  }
  let values: Record<string, unknown> = {}
  servicing.add(runtime)
  try {
    const status = await kernel.execute(
      job.source,
      { ...SILENT_HANDLERS, onUserExpressions: (answered) => (values = answered) },
      { silent: true, storeHistory: false, quiet: true, userExpressions: job.expressions },
    )
    answerService(job, status === 'ok' ? { values } : { refused: 'failed', detail: status })
  } catch (err) {
    answerService(job, { refused: 'failed', detail: errText(err) })
  } finally {
    servicing.delete(runtime)
  }
}

/** Notebooks' kernels computing a service run now (runService): a room's stop does not reach it (interruptScope). */
const servicing = new WeakSet<Runtime>()

/** The runs of each scope waiting at the files barrier now: a stop pressed meanwhile ends the wait (interruptScope). */
const barrierWaits = new WeakMap<Runtime, AbortController>()

/** What passFilesBarrier says of a run stopped while it waited. */
const STOPPED = Symbol('stopped at the barrier')

/**
 * THE FILES BARRIER of a scope on a machine (remote-classes.md §8.2): null
 * once this server's files are on the machine (at once for a scope computing
 * here), STOPPED for a run stopped while it waited, otherwise the words the
 * run is refused with. `show` hears what is on its way while it waits.
 */
async function passFilesBarrier(runtime: Runtime, show: (words: string) => void): Promise<string | typeof STOPPED | null> {
  if (!slotOnMachine(runtime.sessionId, runtime.role)) return null
  const stop = new AbortController()
  barrierWaits.set(runtime, stop)
  try {
    await slotFilesBarrier(runtime.sessionId, runtime.role, { onProgress: show, signal: stop.signal })
    return stop.signal.aborted ? STOPPED : null
  } catch (err) {
    if (stop.signal.aborted) return STOPPED
    return err instanceof FilesStalled ? err.words : errText(err)
  } finally {
    if (barrierWaits.get(runtime) === stop) barrierWaits.delete(runtime)
  }
}

/* ----------------------------------------------------------- council */

/** How often at most a computing attempt's output frame goes to host and author. */
const COUNCIL_REPORT_MS = 400

/**
 * A council attempt works with personal copies of the data, and after it the
 * kernel returns to exactly what it was.
 *
 * A notebook has one kernel, and that is by product design, not an oversight:
 * an attempt has to see `df`, `np` and everything the teacher prepared in a
 * shared cell. In the other direction, though, this was a hole, and a silent
 * one. First by names: `secret = 42` in one student's attempt answered
 * `print(secret)` in the next one's. Then, at the live seminar of 19 Sep 2026,
 * by data: the task had the line `# data = data.dropna()`, one person
 * uncommented it, and `data` changed for EVERYONE, including those who had
 * already submitted.
 *
 * The previous cleanup (a snapshot of the names before, removing the new ones
 * after) closed only the first half and by design could not close the second:
 * rebinding changes a name that EXISTED, and in-place mutation does not change
 * names at all.
 *
 * So there are now two other silent requests around an attempt
 * (council-isolation.ts): the entry replaces the bindings with personal copies
 * and reports through `user_expressions`; the exit returns every binding,
 * removes new names, and rolls back cwd and rcParams. Personal copies are made
 * of pandas frames and series, numpy arrays, built-in containers and tuples,
 * torch tensors and models together with their optimizers (a shared memo, so
 * that the optimizer points to the parameters of ITS OWN copy of the model),
 * scipy sparse matrices, sklearn estimators, random number generators and
 * objects of classes declared in the notebook itself. There is still no
 * namespace isolation (`exec` in a fresh dict): it breaks the echo of the last
 * expression, magics and the line numbers in tracebacks, i.e. everything that
 * makes an attempt like a cell.
 *
 * Copies cover the data; the same entry also closes what let one attempt take
 * down the whole class (council-isolation.ts):
 *   · `exit()` and `quit()`: in ipykernel that is `shell.ask_exit()`, i.e. the
 *     end of the process and the loss of EVERYONE's variables; checked on a
 *     live kernel. For the duration of an attempt they answer with a one-line
 *     refusal. The kernel survives `sys.exit()` without our help, so that one
 *     is left alone;
 *   · `os._exit()` and `os.abort()`: the end of the process without a single
 *     word: no traceback, no signal in dmesg, no counter in the cgroup. On
 *     20 Sep 2026 a room of thirty lost its kernel nine times in eleven minutes
 *     on a two-line attempt. For the duration of an attempt they answer with a
 *     refusal; a child after `fork()` keeps the real `_exit`, otherwise
 *     multiprocessing breaks;
 *   · greed: the attempt gets an address-space ceiling derived from the
 *     container limit (`COUNCIL_MEMORY_GUARD`), and `np.ones((40000, 40000))`
 *     now ends in a `MemoryError` for the author, not with the OOM killer for
 *     the whole room;
 *   · process state that shifts the results of whoever comes next: the random
 *     number stream (`random`, `numpy`, `torch`), `sys.stdout`/`stderr`,
 *     `sys.path`, `os.environ`, `builtins`, warning filters, the recursion
 *     limit, the tracer, the SIGINT handler, numpy and pandas print options,
 *     `sklearn.set_config`, the `decimal` context, `%pdb`, IPython hooks,
 *     matplotlib figures, child processes.
 *
 * What stays shared, and is said out loud (COUNCIL_SHARED_KERNEL_NOTE, README,
 * docs/pages · council.html):
 *   · files on disk: `df.to_csv('out.csv')` writes into the room's shared
 *     directory. This was deliberately not fixed: chmod for the duration of an
 *     attempt breaks both the file editor and the terminal, and intercepting
 *     `open` breaks the ordinary "everyone writes out.csv";
 *   · objects outside the list of copied types: an open file, a generator, a
 *     socket, a database connection, polars, PIL (council-isolation.ts ·
 *     _plan);
 *   · objects beyond the `COUNCIL_COPY_MB` budget and those whose copy failed;
 *     these are named one by one in the attempt's own output;
 *   · modules the attempt imported: they stay in the kernel's memory;
 *   · threads the attempt left running: Python has no way to stop them, so the
 *     exit counts them and mentions them in the output;
 *   · the GPU: the card's memory and its contexts are one for the room;
 *   · intent that goes around the refusals: `ctypes`, `signal.raise_signal`,
 *     `os.kill`, deleting the service module from `sys.modules`. The council is
 *     a teaching technique, not an exam sandbox: what is closed is the way a
 *     class really gets taken down, not every conceivable one.
 */
function councilEnterSourceNow(): string {
  /*
   * Built for EVERY attempt, and that is not wasteful: the refusal text in the
   * room's language goes inside, and the language gets changed in the panel in
   * the middle of class. The expensive part, escaping the source, is computed
   * once and kept in the module's memory; what is left here is joining two
   * strings.
   */
  return councilEnterSource(config.councilCopyBytes, {
    memoryGuard: config.councilMemoryGuard,
  })
}

/**
 * The entry of one attempt in its scope: a notebook's own, as above; a pool's
 * worker's from its pool (§9.4, §9.7), with the three inputs only a worker's
 * entry takes — the attempt's text (for the check of the names it reads),
 * its run's scratch folder and its ceiling («Память на попытку»).
 */
function entrySourceFor(runtime: Runtime, item: QueueItem): string {
  const handle = handleOf(runtime)
  if (!handle) return councilEnterSourceNow()
  return poolSays('entry', councilEnterSourceNow(), () => councilPool.entry(handle, item, { budgetBytes: config.councilCopyBytes, memoryGuard: config.councilMemoryGuard }))
}

/** Handlers for a service request that has neither output nor audience. */
const SILENT_HANDLERS: Parameters<JupyterKernel['execute']>[1] = {
  onExecuteInput: () => {},
  onStream: () => {},
  onData: () => {},
  onError: () => {},
  onClear: () => {},
}

/**
 * Install the guard against dangerous commands in the kernel, and WAIT for
 * confirmation.
 *
 * The confirmation is mandatory, and that is the main property: `false` from
 * here means "unknown whether `os._exit` and the rest are patched", and on such
 * a kernel a cell does not run. On 20 Sep 2026 the price of a silent "it
 * probably went in" was already measured: nine lost kernels in eleven minutes
 * in a class of thirty.
 *
 * The report travels in `user_expressions`: with `silent: true` the kernel
 * sends nothing over IOPUB, and there would be no other way to hear the
 * install; the council isolation's entry is heard the same way.
 *
 * It costs one trip to the kernel on the FIRST cell after start-up and one more
 * on every rule or language change: after that the fingerprint matches, and
 * the function returns without leaving the process.
 */
async function ensureGuard(runtime: Runtime): Promise<boolean> {
  const wanted = guardPolicySource(dangerBlocked(runtime.sessionId))
  if (runtime.guard === wanted) return true
  const kernel = runtime.kernel
  if (!kernel || kernel.phase === 'dead') return false
  runtime.guard = null
  let raw: unknown = null
  try {
    await kernel.execute(
      wanted,
      {
        ...SILENT_HANDLERS,
        onUserExpressions: (values) => {
          raw = values[GUARD_REPORT_KEY]
        },
      },
      {
        silent: true,
        storeHistory: false,
        userExpressions: { [GUARD_REPORT_KEY]: GUARD_REPORT_EXPR },
      },
    )
  } catch {
    return false
  }
  const report = parseGuardReport(raw)
  // `policy` is checked, not `on`: a council attempt may be holding the guard
  // above the rule right now, and `on: true` with the rule off is normal, while
  // a diverged `policy` would mean the kernel did not understand us.
  if (!report?.ok || report.policy !== dangerBlocked(runtime.sessionId)) return false
  runtime.guard = wanted
  return true
}

/**
 * The rule was changed in the middle of class: carry it to all of the class's
 * live kernels.
 *
 * "Rules apply at once" is a promise to the whole room (shared/rules.ts), and
 * the guard cannot be an exception to it: a Python course teacher switched the
 * line for a demonstration and expects the very next cell to show `os._exit`,
 * not a refusal. Quietly and without a queue: a cell has nothing to wait for
 * here, and one that did not make it will ask by itself through `ensureGuard`.
 */
export function syncDangerGuard(sessionId: string): void {
  for (const runtime of scopesOf(sessionId)) {
    if (!runtime.kernel || runtime.kernel.phase === 'dead' || runtime.retired) continue
    void ensureGuard(runtime).catch(() => {})
  }
}

/** Quietly run a service line in the notebook's kernel; a failure is no trouble. */
async function quietly(runtime: Runtime, source: string): Promise<void> {
  try {
    await runtime.kernel?.execute(source, SILENT_HANDLERS, { silent: true, storeHistory: false })
  } catch {
    /* the kernel no longer answers: the attempt's own run will say so */
  }
}

/**
 * Prepare personal copies of the data for an attempt, and wait for
 * confirmation.
 *
 * The confirmation is mandatory, and that is the main property: `null` from
 * here means "unknown whether the bindings were replaced", and an attempt never
 * runs on shared objects. The report travels in `user_expressions`: with
 * `silent: true` nothing arrives over IOPUB, and there would be no other way to
 * hear the entry.
 *
 * `runOnKernel`, not `quietly`: a kernel that died between two attempts is
 * brought up again here, and the attempt computes in a fresh, empty kernel, as
 * it would have before, rather than being refused because there turned out to
 * be nothing to copy.
 */
async function enterCouncilIsolation(
  runtime: Runtime,
  item: QueueItem,
): Promise<{ report: CouncilIsolationReport | null; reason: string | null; raw: unknown }> {
  let raw: unknown = null
  let reason: string | null = null
  try {
    const status = await runOnKernel(
      runtime,
      entrySourceFor(runtime, item),
      {
        ...SILENT_HANDLERS,
        onError: (ename, evalue) => {
          // The entry catches its own errors and reports them; only what
          // outlived it gets here: an interrupt by the limit, a kernel death.
          // KeyboardInterrupt has no text at all, and the colon after the name
          // would hang in the refusal line on nothing.
          reason = evalue.trim().length > 0 ? `${ename}: ${evalue.trim()}` : ename
        },
        onUserExpressions: (values) => {
          raw = values[COUNCIL_REPORT_KEY]
        },
      },
      {
        silent: true,
        storeHistory: false,
        userExpressions: { [COUNCIL_REPORT_KEY]: COUNCIL_REPORT_EXPR },
      },
    )
    if (status !== 'ok' && reason === null) reason = tr("server.theAttemptWasInterrupted.4f4edf")
  } catch (err) {
    reason = errText(err)
  }
  const report = parseCouncilReport(raw)
  return { report, reason: report?.error ?? reason, raw }
}

/**
 * Return the kernel to what it was, and learn what could not be returned.
 *
 * Unlike the entry, silence here decides nothing: the exit works by itself, and
 * the report is needed for one note in the attempt's output. Hence the
 * `quietly` logic: the kernel did not answer, and so be it.
 */
async function leaveCouncilIsolation(runtime: Runtime): Promise<{ leftovers: CouncilLeftovers | null; raw: unknown }> {
  let raw: unknown = null
  try {
    await runtime.kernel?.execute(
      COUNCIL_EXIT_SOURCE,
      {
        ...SILENT_HANDLERS,
        onUserExpressions: (values) => {
          raw = values[COUNCIL_REPORT_KEY]
        },
      },
      {
        silent: true,
        storeHistory: false,
        userExpressions: { [COUNCIL_REPORT_KEY]: COUNCIL_LEFTOVERS_EXPR },
      },
    )
  } catch {
    /* the kernel no longer answers: nothing to return, and nobody to return it to */
  }
  return { leftovers: parseCouncilLeftovers(raw), raw }
}

/** What an attempt's frames say of where it ran (CouncilRun.placed, note, epoch, runId): nothing for a class whose council is not on machines. */
function placedOf(item: QueueItem | null): Partial<CouncilRun> {
  const placed = item?.placed
  if (!placed) return {}
  return {
    placed: placed.placed,
    ...(placed.note ? { note: placed.note } : {}),
    ...(placed.epoch ? { epoch: { ...placed.epoch } } : {}),
    ...(placed.runId ? { runId: placed.runId } : {}),
  }
}

/** A run's first frame: it is also the request, and its text is the job's. */
const queuedRun = (job: CouncilJob, item: QueueItem | null = null): CouncilRun => ({
  state: 'queued',
  outputs: [],
  execCount: null,
  ranMs: null,
  startedAt: Date.now(),
  by: job.by,
  ...placedOf(item),
})

/* ------------------------------------------------- the council's pool */

/*
 * THE COUNCIL'S POOL OF WORKERS (docs/architecture/remote-classes.md §9.5,
 * §9.6) is kernel/council-pool.ts's: a router in front of unchanged pumps. It
 * hands its functions in here as it loads (`useCouncilPool`), as the
 * placement module does, and this file asks it at the few places an attempt
 * may go elsewhere than the notebook's queue: its route at the press, its
 * place in the queue, a cancel, a ban, a retime, the console's view, the
 * idle sweep and an owner's stop. Its workers are hidden runtimes of this
 * file (`Runtime.pool`), pumped by the same pump and computing through the
 * same runCouncilOne; the pool drives them by the functions below. A
 * process without it, and a class whose council is not on machines, run
 * exactly the old code.
 */

/** A worker of a council pool as kernel/council-pool.ts holds it: its class, its council notebook and its number. */
export interface WorkerHandle {
  readonly sessionId: string
  /** The council notebook whose epoch it loads. */
  readonly root: string
  readonly n: number
}

/** How a worker stands, by this file's own record. */
export interface WorkerState {
  /** Its kernel is up (not dead, not ended from outside). */
  up: boolean
  /** Coming up. */
  starting: boolean
  /** An attempt is given to it or computing on it. */
  computing: boolean
  restarting: boolean
}

/** How a worker's attempt ended, for its pool's recycling (§9.5) and the attempt's files (§9.7). */
export interface AttemptEnd {
  /**
   * `ran`: through the exit; `stopped`: stopped at the files barrier, no run;
   * `rerouted`: handed to the notebook's kernel before it ran (a name it reads
   * stayed out of the epoch, §9.4); `lost`: its machine went with it, and it
   * runs again there once (§9.10).
   */
  kind: 'ran' | 'stopped' | 'rerouted' | 'lost'
  /** The entry held (its personal copies were made); false is a worker recycled. */
  entered: boolean
  /**
   * Its entry was sent, which makes the run's scratch folder on the machine
   * (§9.7) — before a ceiling it could not set, say, as much as on the way
   * to an attempt that ran: the folder is to be collected and removed, an
   * empty one, or one never made, included.
   */
  scratch: boolean
  /** What the exit left behind (council-isolation.ts · CouncilLeftovers). */
  threads: number
  processes: number
  /** It was still computing after the second SIGINT. */
  stuck: boolean
  /** Its kernel after: up, restarted by itself, or dead. */
  kernel: 'up' | 'restarted' | 'dead'
  /** Its private dirty memory after the attempt, MB, when the exit could tell (§9.3 detail 4). */
  dirtyMb: number | null
  /** The files the attempt wrote into its own folder (§9.7), as its exit listed them: a sha256 for those to bring home. */
  files: Array<{ name: string; sha256: string | null; bytes: number }>
  /** The finished run, as its card has it. */
  run: CouncilRun | null
}

/** What this file asks of kernel/council-pool.ts (§9.6): each answers as if there were no pool until it is given. */
export interface CouncilPoolHooks {
  /** The route at the press (§9.6 «Which queue»): the pool took it; the notebook's queue keeps it with this footnote; null — nothing to say. */
  take(sessionId: string, root: string, item: QueueItem): 'pool' | { shared: string } | null
  /** This person's attempt for this cell waiting in a pool: its place among the pool's waiting attempts, from 1. */
  position(sessionId: string, cellId: string, participantId: string): number | null
  /** Any attempt of this person waiting in the notebook's pool: its place. */
  personAt(sessionId: string, root: string, participantId: string): number | null
  /** Replace this attempt waiting in a pool by `next(old)` in its place (the author edited the text); whether it was there. */
  replace(sessionId: string, cellId: string, participantId: string, next: (old: QueueItem) => QueueItem | null): boolean
  /** Take this attempt off a pool's queue; the entry taken, released here. */
  cancel(sessionId: string, cellId: string, participantId: string): QueueItem | null
  /** Take every attempt of this person off the class's pools' queues; the entries taken, released here. */
  purge(sessionId: string, participantId: string): QueueItem[]
  retime(sessionId: string, cellId: string, limitSec: number | null): void
  positions(sessionId: string): Array<{ cellId: string; participantId: string; position: number }>
  /** Attempts waiting in the class's pools now. */
  waiting(sessionId: string): QueueItem[]
  view(sessionId: string, root: string): CouncilPool | null
  /** Before a worker's attempt: the epoch it was given loaded (the pump, beside the guard). */
  seed(worker: WorkerHandle, item: QueueItem): Promise<boolean>
  /** A worker's entry for this attempt, with its three inputs (§9.4, §9.7): the attempt's text, its run's folder, its ceiling. */
  entry(worker: WorkerHandle, item: QueueItem, base: { budgetBytes: number; memoryGuard: boolean }): string
  /** Of a worker's entry report: a name the attempt reads that its epoch left behind, and why; null — none. */
  needs(raw: unknown): { name: string; why: string } | null
  /** Of a worker's exit report: the files of its folder (§9.7) and its private memory after (§9.3). */
  left(raw: unknown): { files: AttemptEnd['files']; dirtyMb: number | null }
  /**
   * A worker gives back an attempt it never ran: it runs in the notebook's
   * kernel. `lost` — its machine went (or its placement was stopped), not the
   * worker: the card says so, and the worker is not held against.
   */
  givenBack(worker: WorkerHandle, item: QueueItem, why: string, lost: boolean): void
  ended(worker: WorkerHandle, item: QueueItem, end: AttemptEnd): void
  /** A worker's attempt does not take its interrupts (the second SIGINT went for nothing). */
  stuck(worker: WorkerHandle): void
  /** A worker's pump went idle, or its kernel answers again after a restart of its own: nothing of its queue computes or waits. */
  idle(worker: WorkerHandle): void
  /**
   * A worker's Python restarted by itself or died: what it had loaded is gone
   * with it (§9.5). `outside` — it was ended from outside, with its machine or
   * its placement: no fault of an attempt's.
   */
  restarted(worker: WorkerHandle, outside: boolean): void
  /** A history run of a notebook (§9.2): a cell's execute that stores history. */
  historyRun(sessionId: string, root: string, cellId: string): void
  /**
   * A notebook's kernel lost its Python — a restart, by the button or by
   * itself, a death, its machine's loss: the teacher's runs before it no
   * longer make an epoch stale (§9.2). `keep` — a cell about to run on the
   * fresh kernel (a death found by asking before it was sent) keeps its run.
   */
  mainReset(sessionId: string, root: string, keep: string | null): void
  /** The class's kernels are gone (its end, an owner's stop): its pools go. */
  closed(sessionId: string): void
  /** This server stops. */
  shutdown(): void
  /** A test's crash: everything forgotten, nothing said. */
  abandon(): void
}

/** No pool: every attempt is the notebook's, as before 0.26. */
const NO_POOL: CouncilPoolHooks = {
  take: () => null,
  position: () => null,
  personAt: () => null,
  replace: () => false,
  cancel: () => null,
  purge: () => [],
  retime: () => {},
  positions: () => [],
  waiting: () => [],
  view: () => null,
  seed: async () => false,
  entry: () => councilEnterSourceNow(),
  needs: () => null,
  left: () => ({ files: [], dirtyMb: null }),
  givenBack: () => {},
  ended: () => {},
  stuck: () => {},
  idle: () => {},
  restarted: () => {},
  historyRun: () => {},
  mainReset: () => {},
  closed: () => {},
  shutdown: () => {},
  abandon: () => {},
}

let councilPool: CouncilPoolHooks = NO_POOL

/** kernel/council-pool.ts, as it loads (null puts every attempt back in the notebooks' queues). */
export function useCouncilPool(hooks: CouncilPoolHooks | null): void {
  councilPool = hooks ?? NO_POOL
}

/** A pool's call that throws must not bring an attempt, a pump or a press down. */
function poolSays<T>(what: string, fallback: T, ask: () => T): T {
  try {
    return ask()
  } catch (err) {
    console.error(`[kernel] the council pool failed (${what}):`, errText(err))
    return fallback
  }
}

/** A worker's root: no notebook's (a root is `cells` or `nb:…`), and its Jupyter session's path says which worker it is. */
export function councilWorkerRoot(root: string, n: number): string {
  return `${root}~w${n}`
}

const handleOf = (runtime: Runtime): WorkerHandle | null =>
  runtime.pool ? { sessionId: runtime.sessionId, root: runtime.pool.root, n: runtime.pool.n } : null

/** A worker's runtime, made now if it has none: role `council`, a kernel of its own in the class's council container. */
export function councilWorker(sessionId: string, root: string, n: number): WorkerHandle {
  const scope = councilWorkerRoot(root, n)
  if (!peekRuntime(sessionId, scope)?.pool) {
    const runtime = getRuntime(sessionId, scope)
    runtime.role = 'council'
    runtime.pool = { root, n }
  }
  return { sessionId, root, n }
}

function workerRuntime(handle: WorkerHandle): Runtime | undefined {
  const runtime = peekRuntime(handle.sessionId, councilWorkerRoot(handle.root, handle.n))
  return runtime && runtime.pool && !runtime.retired ? runtime : undefined
}

export function workerState(handle: WorkerHandle): WorkerState {
  const runtime = workerRuntime(handle)
  const kernel = runtime?.kernel ?? null
  return {
    up: kernel !== null && kernel.phase !== 'dead' && !kernel.endedBy,
    starting: runtime?.starting != null,
    computing: runtime !== undefined && (runtime.queue.length > 0 || runtime.job !== null || runtime.pumping),
    // Its recycle, or its Python coming back by itself: given nothing until it answers.
    restarting: runtime?.restarting != null || kernel?.phase === 'restarting',
  }
}

/**
 * Bring a worker's kernel up (its first start places the class's council
 * slot, pool.ts · endpointForSession), the guard in it. A worker whose
 * runtime went behind its pool's back (an owner's stop retires every scope
 * of the class, the pool's workers among them) gets one anew: its pool still
 * wants it.
 */
export async function startCouncilWorker(handle: WorkerHandle): Promise<void> {
  if (!workerRuntime(handle)) councilWorker(handle.sessionId, handle.root, handle.n)
  const runtime = workerRuntime(handle)
  if (!runtime) throw new Error('the worker is gone')
  await ensureKernel(handle.sessionId, councilWorkerRoot(handle.root, handle.n))
  if (!(await ensureGuard(runtime))) throw new Error('the guard was not confirmed')
}

/** One attempt into a worker's own queue, and its pump; false when it cannot take one now (busy, gone). */
export function giveCouncilWorker(handle: WorkerHandle, item: QueueItem): boolean {
  const runtime = workerRuntime(handle)
  if (!runtime || runtime.queue.length > 0 || runtime.job !== null || runtime.pumping || runtime.restarting || runtime.kernel?.phase === 'restarting') return false
  runtime.queue.push(item)
  void pump(runtime)
  return true
}

/**
 * Recycle a worker (§9.5): its kernel restarted with its session kept, the
 * guard into the new process. Whether it came back. The pump waits for it
 * as for any restart (`runtime.restarting`).
 */
export async function recycleCouncilWorker(handle: WorkerHandle): Promise<boolean> {
  const runtime = workerRuntime(handle)
  const kernel = runtime?.kernel ?? null
  if (!runtime || !kernel || kernel.phase === 'dead' || kernel.endedBy) return false
  if (runtime.restarting) {
    await runtime.restarting.catch(() => {})
    return runtime.kernel !== null && runtime.kernel.phase !== 'dead'
  }
  let back = false
  runtime.restarting = (async () => {
    await kernel.restart()
    runtime.guard = null
    back = await ensureGuard(runtime).catch(() => false)
  })()
  try {
    await runtime.restarting
  } catch (err) {
    console.warn(`[kernel ${handle.sessionId}] council worker ${handle.n} did not come back from its recycle:`, errText(err))
    back = false
  } finally {
    runtime.restarting = null
    void pump(runtime)
  }
  return back
}

/** A worker goes: its kernel's session is deleted in the council container (a shrink, the pool's end). */
export async function retireCouncilWorker(handle: WorkerHandle): Promise<void> {
  const runtime = workerRuntime(handle)
  if (runtime) await retireScope(runtime, null)
}

/**
 * A silent service run on a worker (its epoch's load, §9.3): the answers of
 * its `user_expressions`. Outside the pump: the pool calls it only on a
 * worker it gives nothing meanwhile.
 */
export async function councilWorkerExecute(handle: WorkerHandle, source: string, expressions: Record<string, string>): Promise<{ status: ExecuteStatus | 'gone'; values: Record<string, unknown> }> {
  const kernel = workerRuntime(handle)?.kernel
  if (!kernel || kernel.phase === 'dead' || kernel.endedBy) return { status: 'gone', values: {} }
  let values: Record<string, unknown> = {}
  const status = await kernel.execute(
    source,
    { ...SILENT_HANDLERS, onUserExpressions: (answered) => (values = answered) },
    { silent: true, storeHistory: false, userExpressions: expressions },
  )
  return { status, values }
}

/** A frame of an attempt to its card, from the pool (its files landing, §9.7). */
export function tellCouncilItem(item: QueueItem, run: CouncilRun): void {
  if (item.council) tellJob(item.council, run)
}

/** An attempt the pool takes off its queue: there was no run, and its author's card says so (null frame). */
export function releaseCouncilItem(sessionId: string, item: QueueItem): void {
  const runtime = peekRuntime(sessionId, rootOf(sessionId, item.council?.cellId ?? item.cellId))
  if (runtime) releaseCouncil(runtime, [item])
  else {
    item.activityFinished = true
    if (item.council) tellJob(item.council, null)
  }
}

/**
 * An attempt of the pool goes to the notebook's own queue (§9.9): never run
 * yet (the pool could not take it after all, a worker gave it back, its
 * machine was lost), or run once and lost with its machine (D15). It keeps
 * its place: before the first entry pressed after it (its batch is its
 * press), so the cells and attempts pressed later still wait behind it. Its
 * card hears it is queued again, with why.
 */
export function requeueCouncilShared(sessionId: string, root: string, item: QueueItem, note: string | null): void {
  const runtime = getRuntime(sessionId, root)
  if (runtime.retired || !item.council) {
    releaseCouncilItem(sessionId, item)
    return
  }
  item.placed = { placed: 'shared', ...(note ? { note } : {}) }
  const at = runtime.queue.findIndex((one) => one.batch > item.batch && !one.service)
  if (at < 0) runtime.queue.push(item)
  else runtime.queue.splice(at, 0, item)
  tellJob(item.council, queuedRun(item.council, item))
  syncQueue(runtime)
  void pump(runtime)
}

/**
 * What a worker gives back when it cannot run what it was given: its pool
 * sends it to the notebook's kernel. `lost` — the machine (or the placement)
 * went, not the worker.
 */
function giveBackQueue(runtime: Runtime, why: string, lost: boolean): void {
  const handle = handleOf(runtime)
  if (!handle) return
  for (const item of runtime.queue.splice(0, runtime.queue.length)) {
    poolSays('given back', undefined, () => councilPool.givenBack(handle, item, why, lost))
  }
  syncQueue(runtime)
}

/**
 * The export of a notebook's epoch (§9.2), as a service item at the head of
 * its kernel's queue: it runs between the teacher's cells and never under
 * one. False — the notebook has no live kernel (none is started for it):
 * the epoch is empty by construction.
 */
export function requestEpochExport(sessionId: string, root: string, job: ServiceJob): boolean {
  const runtime = peekRuntime(sessionId, root)
  const kernel = runtime?.kernel ?? null
  if (!runtime || runtime.retired || hidden(runtime) || !kernel || kernel.phase === 'dead' || kernel.endedBy) return false
  const item: QueueItem = { cellId: `epoch:${runtime.sessionId}`, runBy: '', runById: '', batch: ++batchCounter, service: job, activityFinished: true }
  // At the head, behind only what computes now: the attempts that wait for it wait for the running cell alone.
  runtime.queue.unshift(item)
  void pump(runtime)
  return true
}

/**
 * The notebook's kernel, as an epoch's export needs it: whether it is live,
 * and where it computes — this server, or a placement on a machine (its
 * container there, for the agent's `docker cp`). `gone`: this life of the
 * server saw that kernel end (dead, or ended from outside), so a kernel
 * started now would hold nothing; a kernel not live and not gone may run
 * still, unknown to this life (a restart of this server re-attaches it on
 * its first need).
 */
export function mainKernelOf(sessionId: string, root: string): { live: boolean; gone: boolean; where: 'home' | { runnerId: string; role: KernelRole; container: string; gen: number } | null; role: KernelRole | null } {
  const runtime = peekRuntime(sessionId, root)
  const kernel = runtime?.kernel ?? null
  if (!runtime || hidden(runtime) || !kernel || kernel.phase === 'dead' || kernel.endedBy) {
    const gone = runtime !== undefined && !hidden(runtime) && kernel !== null
    return { live: false, gone, where: null, role: runtime?.role ?? null }
  }
  if (!kernel.endpoint.link) return { live: true, gone: false, where: 'home', role: runtime.role }
  const parts = kernel.endpoint.identity?.split(':')
  const gen = Number(parts?.[parts.length - 1])
  if (!parts || parts.length < 4 || parts[0] !== 'machine' || !Number.isSafeInteger(gen)) return { live: true, gone: false, where: null, role: runtime.role }
  return { live: true, gone: false, where: { runnerId: parts[1]!, role: runtime.role, container: parts.slice(2, -1).join(':'), gen }, role: runtime.role }
}

/** A slot's placement as these hooks read it (viewOf): the pool's machine and its road. */
export function slotViewOf(sessionId: string, role: KernelRole): PlacementView {
  return viewOf(sessionId, role)
}

/**
 * The class's council container on its machine stopped, its pools gone (§9.5:
 * the pool stops COUNCIL_POOL_LINGER_MS after the last council closes, and
 * the machine's ledger holds nothing for it after): at the gen it is placed
 * at, and only while no worker of the class has a kernel there. Whether it
 * stopped; the next pool places it again.
 */
export function stopCouncilSlot(sessionId: string): boolean {
  const view = viewOf(sessionId, 'council')
  if (view.where !== 'machine' || !placements.stopSlot) return false
  if (scopesOf(sessionId).some((scope) => hidden(scope) && !scope.retired && (scope.starting !== null || (scope.kernel !== null && scope.kernel.phase !== 'dead' && !scope.kernel.endedBy)))) return false
  try {
    return placements.stopSlot(sessionId, 'council', view.gen)
  } catch (err) {
    console.error(`[kernel] could not stop the council container of ${sessionId} on its machine:`, errText(err))
    return false
  }
}

/**
 * Put a council attempt into the kernel's queue.
 *
 * The same attempt means one entry: a second press on THE SAME text while the
 * first is waiting or computing queues nothing and returns its place, so a
 * refusal can say "you are 37th". `position` is the place in the queue,
 * counting the one being executed; `0` means executing now. `runById` is who
 * pressed: a teacher running someone else's attempt stays the owner of the run
 * (interrupting, answering input), as with a cell.
 *
 * A different text is not a second press but a different run.
 *
 * There is one queue for the whole cohort, waiting a minute is ordinary, and an
 * edit in that time is ordinary too. Previously a waiting entry was
 * untouchable: a student who fixed their sheet got "this attempt is already
 * queued, 37th" and could not rerun the NEW version until the kernel finished
 * the old one, whose output by then was thrown away anyway as late (council.ts
 * · recordRun). So the entry is replaced in place: the place in the queue stays
 * the same (nobody is punished for a typo), and what gets computed is what the
 * person sees on screen.
 *
 * One already computing cannot be replaced: the line has gone to the kernel.
 * It is still answered "already computing", and that is honest: it can be
 * interrupted with the button, and its output would not fit the new text
 * anyway.
 */
export function requestCouncilRun(
  sessionId: string,
  job: CouncilJob,
  runBy: string,
  runById: string,
  /**
   * The council cell's knobs at the press that the pool reads (§6.2): its
   * lane and its refresh. Without them, the defaults (the pool's lane, the
   * refresh following the kernel): what a class whose council is not on
   * machines never meets.
   */
  cell?: Pick<CouncilSettings, 'lane' | 'refresh'>,
): { queued: boolean; position: number } {
  /*
   * An attempt computes in the kernel of THE notebook where its cell is.
   *
   * A council is a cell on a sheet, and it has one sheet. Computing attempts in
   * the room's kernel while the cell itself lies in the seminar would give them
   * someone else's variables and occupy someone else's queue. Isolating
   * attempts from each other (council-isolation.ts) does not change because of
   * this: it is about the namespace inside one kernel, and that kernel is now
   * the kernel of its own notebook.
   */
  const runtime = getRuntime(sessionId, rootOf(sessionId, job.cellId))
  sweepOrphanRuns(sessionId)
  const knobs = cell ? { councilCell: { lane: cell.lane, refresh: cell.refresh } } : {}
  const already = councilQueuePosition(sessionId, job.cellId, job.participantId)
  if (already !== null) {
    const id = councilQueueId(job.cellId, job.participantId)
    const index = runtime.queue.findIndex((item) => item.cellId === id)
    const waiting = index < 0 ? null : runtime.queue[index]
    if (!waiting) {
      /*
       * Not in the notebook's queue: computing now (on a worker of the
       * class's pool, or in the kernel), or waiting in the pool's queue,
       * where an edited text replaces the old one in place just the same.
       */
      if (already === 0) return { queued: false, position: already }
      const swapped: { item: QueueItem | null } = { item: null }
      const replaced = poolSays('replace', false, () =>
        councilPool.replace(sessionId, job.cellId, job.participantId, (old) => {
          if (old.council?.source === job.source) return null
          finishExecution(runtime, old, 'cancelled')
          const next: QueueItem = { ...old, runBy, runById, council: job, ...knobs, activityFinished: false, activityCancelled: false, activitySeq: null }
          next.activitySeq = executionActivity(runtime, next, 'execution.queued', { count: 1 })
          swapped.item = next
          return next
        }),
      )
      if (!replaced || swapped.item === null) return { queued: false, position: already }
      tellJob(job, queuedRun(job, swapped.item))
      return { queued: true, position: already }
    }
    if (waiting.council?.source === job.source) {
      return { queued: false, position: already }
    }
    // The "queued" frame goes out for the NEW job: it also moves the text
    // fingerprint by which recordRun decides whose output counts as its own.
    finishExecution(runtime, waiting, 'cancelled')
    const replacement: QueueItem = { ...waiting, runBy, runById, council: job, ...knobs, activityFinished: false, activityCancelled: false, activitySeq: null }
    replacement.activitySeq = executionActivity(runtime, replacement, 'execution.queued', { count: 1 })
    runtime.queue[index] = replacement
    tellJob(job, queuedRun(job, replacement))
    return { queued: true, position: already }
  }
  /*
   * One run in flight per person, across the whole notebook, not per cell.
   *
   * A ceiling, not a right (the same kind of boundary as `runQueueCap` for
   * cells): it forbids no press and divides nobody into roles. Without it the
   * waiting is not limited by anything: a sheet has several council cells, and
   * one person occupied the shared kernel's queue with three of their attempts
   * at once while the class stood behind them. Replacing the text in an entry
   * already waiting (the branch above) still stays: nobody is punished for a
   * typo, and the place in the queue is kept.
   *
   * The teacher falls under the ceiling too, and on purpose: they run SOMEONE
   * ELSE'S attempt, and it stands in the queue in the author's name; otherwise
   * a review at the board would give a student a second job on top of the one
   * they are already waiting for.
   */
  const elsewhere = councilQueuePositionsOf(runtime, job.participantId)
  if (elsewhere !== null) return { queued: false, position: elsewhere }
  const item: QueueItem = {
    cellId: councilQueueId(job.cellId, job.participantId),
    runBy,
    runById,
    batch: ++batchCounter,
    council: job,
    ...knobs,
  }
  item.activitySeq = executionActivity(runtime, item, 'execution.queued', { count: 1 })
  /*
   * THE ROUTE (remote-classes.md §9.6 «Which queue»): the class's pool of
   * workers takes the attempt when it can, and gives it to a worker in a
   * turn of its own, after this frame; otherwise the notebook's queue, as
   * always, and the card says why it is not the pool's (§9.9). A class whose
   * council is not on machines hears nothing of either.
   */
  const route = poolSays('take', null, () => councilPool.take(sessionId, runtime.root, item))
  if (route === 'pool') {
    item.placed = { placed: 'pool' }
    tellJob(job, queuedRun(job, item))
    return { queued: true, position: councilQueuePosition(sessionId, job.cellId, job.participantId) ?? 1 }
  }
  if (route !== null) item.placed = { placed: 'shared', ...(route.shared ? { note: route.shared } : {}) }
  runtime.queue.push(item)
  const position = councilQueuePosition(sessionId, job.cellId, job.participantId) ?? 1
  tellJob(job, queuedRun(job, item))
  syncQueue(runtime)
  void pump(runtime)
  return { queued: true, position }
}

/**
 * Where in THIS notebook's queue this person's attempt stands, any attempt,
 * from any cell. `0` means computing now, `null` means they are not queued.
 *
 * Separate from `councilQueuePosition`, because the question is different: that
 * one answers "where is my attempt for THIS cell" (the card asks it), and this
 * one "is their place in the queue already taken" (the ceiling asks it). The
 * number is computed by the same formula, together with the cells ahead: the
 * person will have to wait for all of them.
 */
function councilQueuePositionsOf(runtime: Runtime, participantId: string): number | null {
  const running = runtime.job
  if (running?.job.participantId === participantId) return 0
  const index = runtime.queue.findIndex((item) => item.council?.participantId === participantId)
  if (index >= 0) return index + 1 + (runtime.currentCell ? 1 : 0)
  // And the notebook's pool (§9.6): given to a worker or computing on one, or waiting for one.
  if (workersOf(runtime.sessionId, runtime.root).some((worker) => holdsAttemptOf(worker, (job) => job.participantId === participantId))) return 0
  return poolSays('personAt', null, () => councilPool.personAt(runtime.sessionId, runtime.root, participantId))
}

/** The workers of a notebook's pool in this process: hidden runtimes of its class whose pool is that notebook's. */
function workersOf(sessionId: string, root: string): Runtime[] {
  return scopesOf(sessionId).filter((scope) => scope.pool?.root === root && !scope.retired)
}

/** Whether a worker computes, or was given, an attempt this test picks. */
function holdsAttemptOf(worker: Runtime, picks: (job: CouncilJob) => boolean): boolean {
  if (worker.job && picks(worker.job.job)) return true
  return worker.queue.some((item) => item.council !== undefined && picks(item.council))
}

/**
 * Take a waiting attempt off the queue: there is nobody left to compute it for.
 *
 * Two reasons, and both are about the work becoming pointless before it even
 * started: the author changed the text (control.ts · council:draft), and the
 * person was banned (control.ts · purgeCouncilOf). There is one kernel for the
 * cohort, the queue to it is shared, and a minute spent on code that no longer
 * exists is a minute the rest of the class waits.
 *
 * `null` in `tellJob` is understood as "there was no run": council.ts erases
 * both the run from the card and the text fingerprint. Returns whether it was
 * removed: `false` means either the attempt is already computing (the line has
 * gone to the kernel and cannot be reached from here) or it was never queued.
 */
export function cancelCouncilRun(
  sessionId: string,
  cellId: string,
  participantId: string,
): boolean {
  const runtime = councilScope(sessionId, cellId)
  const id = councilQueueId(cellId, participantId)
  if (runtime) {
    if (runtime.currentCell === id) return false
    const index = runtime.queue.findIndex((item) => item.cellId === id)
    if (index >= 0) {
      const [dropped] = runtime.queue.splice(index, 1)
      releaseCouncil(runtime, [dropped])
      syncQueue(runtime)
      return true
    }
  }
  // Given to a worker of the class's pool and not begun, or waiting in the pool (§9.6): taken off the same way; one computing on a worker is not.
  if (takeOffWorker(sessionId, id)) return true
  const dropped = poolSays('cancel', null, () => councilPool.cancel(sessionId, cellId, participantId))
  if (!dropped) return false
  releaseCouncilItem(sessionId, dropped)
  return true
}

/**
 * Remove from the kernel all attempts of a person being removed from the class.
 *
 * An ordinary cancel deliberately does not touch a running attempt. For a ban
 * this left an endless loop occupying the shared kernel after the author and
 * their work had been removed from the room. Here the current work is checked
 * against the server's record of the job. The queue does not start someone
 * else's next attempt until the interrupt is answered: otherwise a late SIGINT
 * could land in that one.
 */
export function purgeCouncilRunsOf(
  sessionId: string,
  participantId: string,
): { running: boolean; queued: number } {
  // Across all of the class's notebooks: the banned person could be queued in
  // each one where a council is running, and leaving even one means leaving
  // their endless loop occupying the kernel after they themselves were removed
  // from the room.
  let running = false
  let queued = 0
  // (The class's pool's workers are among the scopes: a worker computing the banned person's attempt is interrupted, §9.6.)
  for (const runtime of scopesOf(sessionId)) {
    const dropped = runtime.queue.filter((item) => item.council?.participantId === participantId)
    if (dropped.length > 0) {
      const gone = new Set(dropped)
      runtime.queue = runtime.queue.filter((item) => !gone.has(item))
      releaseCouncil(runtime, dropped)
      syncQueue(runtime)
      queued += dropped.length
    }
    const active = runtime.job
    if (active?.job.participantId === participantId) {
      running = true
      stopRunningItem(runtime, active.item)
    }
  }
  // And what waits in the pool's queue.
  for (const item of poolSays('purge', [] as QueueItem[], () => councilPool.purge(sessionId, participantId))) {
    releaseCouncilItem(sessionId, item)
    queued += 1
  }
  return { running, queued }
}

/**
 * The scope this cell's council lives in, and `undefined` if it has not been
 * created yet.
 *
 * `peekRuntime`, not `getRuntime`: every card asks "where is my attempt in the
 * queue" when the console opens, and that must not start a Python for the
 * room.
 */
function councilScope(sessionId: string, cellId: string): Runtime | undefined {
  return peekRuntime(sessionId, rootOf(sessionId, cellId))
}

/**
 * Interrupt EXACTLY this work, and do not let the SIGINT catch up with the next
 * one.
 *
 * Three reasons to stop something nobody asked to stop: the attempt's author
 * was banned, the attempt exceeded the rules' limit, the cell exceeded the
 * room's limit. They share one boundary because the danger is one: `interrupt`
 * goes to Jupyter over HTTP and does not answer instantly, and in that time the
 * queue manages to take the next job, so a signal sent to Petya stopped Masha.
 * So the promise goes into `beforeNext`: the pump waits on it exactly at the
 * boundary between jobs, throwing nothing out of the queue. The previous
 * barrier is not lost: two bans in a row give two signals, and both have to be
 * waited for.
 *
 * `interruptSession` with the queue entry's name, not without it: without a
 * name it clears the queue of the WHOLE room (that is the room Interrupt
 * button's branch). An attempt has its own single batch, a cell its own Run,
 * and `stopBatchOf` on it will find nothing of anyone else's.
 */
function stopRunningItem(runtime: Runtime, item: QueueItem): void {
  const interrupt = signalItem(runtime, item)
  const prior = runtime.beforeNext
  const barrier = prior ? Promise.all([prior, interrupt]).then(() => {}) : interrupt
  runtime.beforeNext = barrier
  void barrier.then(() => {
    if (runtime.beforeNext === barrier) runtime.beforeNext = null
  })
}

/** One look of `signalItem` at a link that has not come back: it then checks whether the work still computes. */
const SIGNAL_WAIT_MS = 5000

/**
 * SIGINT for exactly this work, sent again once its machine is back if it
 * could not get there (remote-classes.md §5.8).
 *
 * At home, and on a machine that answers, this is the one interrupt it always
 * was. A signal that cannot reach the kernel (the machine's link is down)
 * leaves the limit `pending` and waits for the link; when the link comes back
 * and THIS item still computes, the signal goes again, never to whatever runs
 * next. It resolves once a signal landed, once there is nothing to signal,
 * or once the item no longer computes (its machine lost, the room closed):
 * the pump's barrier waits on it, so the next item does not start while a
 * signal for this one may still go out.
 */
async function signalItem(runtime: Runtime, item: QueueItem): Promise<void> {
  let outcome = await interruptScope(runtime, item.cellId)
  while (outcome === 'unreachable') {
    const waiting = runtime.limit?.item === item ? runtime.limit : null
    if (waiting) waiting.pending = true
    const link = runtime.kernel?.endpoint.link
    const word = link ? await link.next(SIGNAL_WAIT_MS) : 'lost'
    if (word === 'lost' || !stillComputing(runtime, item)) break
    if (word !== 'up') continue
    outcome = await interruptScope(runtime, item.cellId)
  }
  // Landed, or moot: the limit's next step counts from here.
  const limit = runtime.limit?.item === item ? runtime.limit : null
  if (limit?.pending) {
    limit.pending = false
    const resume = limit.resume
    limit.resume = null
    resume?.()
  }
}

/** Whether this queue entry is still the work computing in its scope. */
function stillComputing(runtime: Runtime, item: QueueItem): boolean {
  if (runtime.retired || peekRuntime(runtime.sessionId, runtime.root) !== runtime) return false
  if (item.council) return runtime.job?.item === item
  return runtime.currentCell === item.cellId && runtime.activityItem === item
}

/**
 * Where the attempt is in the queue: `0` means computing now, `null` means it
 * is not there. Also counts the cells ahead of it: a notebook has one queue,
 * and the student will have to wait for all of them.
 */
export function councilQueuePosition(
  sessionId: string,
  cellId: string,
  participantId: string,
): number | null {
  const runtime = councilScope(sessionId, cellId)
  const id = councilQueueId(cellId, participantId)
  if (runtime) {
    if (runtime.currentCell === id) return 0
    const index = runtime.queue.findIndex((item) => item.cellId === id)
    if (index >= 0) return index + 1 + (runtime.currentCell ? 1 : 0)
  }
  /*
   * The class's pool (§9.6): on a worker, computing now; waiting for one,
   * its place among the pool's waiting attempts alone — no teacher's cell
   * stands in that queue, and the workers compute side by side.
   */
  for (const scope of scopesOf(sessionId)) {
    if (hidden(scope) && holdsAttemptOf(scope, (job) => job.cellId === cellId && job.participantId === participantId)) return 0
  }
  return poolSays('position', null, () => councilPool.position(sessionId, cellId, participantId))
}

/**
 * All waiting attempts with their numbers, in one pass over the queue.
 *
 * The same as `councilQueuePosition` for each waiting one, only without a
 * search through the queue for each: with five hundred attempts a queue shift
 * cost a quarter of a million comparisons for nothing. The number is computed
 * the same way, together with the one computing now. There is no zero here: a
 * computing attempt is no longer waiting.
 */
export function councilQueuePositions(
  sessionId: string,
): { cellId: string; participantId: string; position: number }[] {
  // The number is counted IN ITS OWN queue: there are several notebooks and as
  // many queues, and "third" in the seminar says nothing about the lecture.
  const out: { cellId: string; participantId: string; position: number }[] = []
  for (const runtime of scopesOf(sessionId)) {
    // A worker's queue holds the one attempt it was given: computing, not waiting.
    if (hidden(runtime)) continue
    const ahead = runtime.currentCell ? 1 : 0
    runtime.queue.forEach((item, index) => {
      if (!item.council) return
      out.push({
        cellId: item.council.cellId,
        participantId: item.council.participantId,
        position: index + 1 + ahead,
      })
    })
  }
  // And the class's pools' waiting attempts, each numbered in its own pool's queue.
  out.push(...poolSays('positions', [] as ReturnType<CouncilPoolHooks['positions']>, () => councilPool.positions(sessionId)))
  return out
}

/** What the notebook's kernel is computing right now, for the teacher's console. */
export interface KernelBusy {
  /** An ordinary notebook cell or a council attempt. */
  kind: 'cell' | 'attempt'
  /** The DOCUMENT's cell: an ordinary run's own, or an attempt's council cell. */
  cellId: string
  /** Who pressed, by the server's queue record, not the document field. */
  runById: string
  /** Whose attempt; `null` for an ordinary cell. */
  participantId: string | null
  startedAt: number
  /** The limit it runs under, in seconds; `null` means no limit. */
  limitSec: number | null
  /** Two stop signals went out and it still computes: the notebook's queue stands. */
  stuck: boolean
}

/**
 * The kernel of THE notebook where this cell lives: what it is busy with and
 * how much is waiting.
 *
 * Created for the council console, and for one of its troubles. The console
 * built "running/queued" from the attempts of ITS OWN cell, the only thing that
 * reached it, and when the kernel was held by an ordinary cell or by an attempt
 * of a neighbouring cell, it honestly wrote "nothing is running in this cell
 * right now" next to "queued: 12". There was no "Interrupt" button at that
 * moment at all: it was drawn inside the "a run is going" branch. So exactly
 * in the minute when the teacher needed to act, the console showed there was
 * nothing to act on.
 *
 * `peekRuntime`, not `getRuntime`: every console frame asks this, and it must
 * not start a Python for the room. `null` means there was no scope yet, i.e.
 * nothing has been run in this notebook.
 */
export function kernelWorkOf(
  sessionId: string,
  cellId: string,
): { busy: KernelBusy | null; queued: number; pool?: CouncilPool } | null {
  const root = rootOf(sessionId, cellId)
  // The class's pool of workers for this notebook's attempts (§9.8): what the console reads beside the kernel.
  const view = poolSays('view', null, () => councilPool.view(sessionId, root))
  const pool = view ? { pool: view } : {}
  const runtime = councilScope(sessionId, cellId)
  if (!runtime) return view ? { busy: null, queued: 0, ...pool } : null
  // The queue length is ALL of it: both cells and attempts of any cells of this
  // notebook. There is one queue, and the student will have to wait for
  // everyone in it.
  const queued = runtime.queue.length
  const active = runtime.job
  const limit = runtime.limit
  if (active) {
    return {
      queued,
      ...pool,
      busy: {
        kind: 'attempt',
        cellId: active.job.cellId,
        runById: active.item.runById,
        participantId: active.job.participantId,
        startedAt: active.run.startedAt,
        limitSec: limit?.item === active.item ? limit.sec : null,
        stuck: limit?.item === active.item ? limit.stuck : false,
      },
    }
  }
  const current = runtime.currentCell
  if (!current) return { busy: null, queued, ...pool }
  return {
    queued,
    ...pool,
    busy: {
      kind: 'cell',
      cellId: current,
      runById: runtime.currentRunById ?? '',
      participantId: null,
      startedAt: runtime.started?.at ?? Date.now(),
      limitSec: limit?.item.cellId === current ? limit.sec : null,
      stuck: limit?.item.cellId === current ? limit.stuck : false,
    },
  }
}

/** Whose attempts wait in the queue, to tell them their new number after each shift. */
export function councilQueued(sessionId: string): { cellId: string; participantId: string }[] {
  const out: { cellId: string; participantId: string }[] = []
  for (const runtime of scopesOf(sessionId)) {
    // A worker's one attempt computes: it waits for nothing.
    if (hidden(runtime)) continue
    for (const item of runtime.queue) {
      if (item.council)
        out.push({ cellId: item.council.cellId, participantId: item.council.participantId })
    }
  }
  for (const item of poolSays('waiting', [] as QueueItem[], () => councilPool.waiting(sessionId))) {
    if (item.council) out.push({ cellId: item.council.cellId, participantId: item.council.participantId })
  }
  return out
}

/**
 * Whether any notebook of the room is still computing: a cell or an attempt
 * running, or anything waiting in a queue. The class page that refreshes
 * itself at the bell waits for this to go quiet (publish/class-end.ts), since
 * cells queued before the bell keep running after it.
 */
export function sessionComputing(sessionId: string): boolean {
  // The class's pool's workers are scopes too, and what waits for them is the pool's queue.
  return scopesOf(sessionId).some(
    (runtime) => runtime.queue.length > 0 || runtime.currentCell !== null || runtime.job !== null,
  ) || poolSays('waiting', [] as QueueItem[], () => councilPool.waiting(sessionId)).length > 0
}

/** One output frame per window, not per print: the stack travels to the host whole. */
function touchJob(runtime: Runtime, active: ActiveJob): void {
  if (active.timer) return
  active.timer = setTimeout(() => {
    active.timer = null
    if (runtime.job !== active) return
    tellJob(active.job, { ...active.run, outputs: active.buffer.snapshot() })
  }, COUNCIL_REPORT_MS)
  active.timer.unref?.()
}

/** When the guarded work started by the server's clock, corrected for `restamp`. */
function startOfLimit(runtime: Runtime, limit: RunLimit): number {
  // By the runtime's record, not its own: `restamp` moves the start when the
  // kernel had to be brought up again, and the minute and a half of that is not
  // work time.
  return runtime.started?.cellId === limit.item.cellId ? runtime.started.at : limit.startedAt
}

/**
 * Set the alarm on work that has just gone to the kernel.
 *
 * One door for both paths: `runOne` brings the room's limit
 * (rules.ts · RoomRules.cellLimitSec), `runCouncilOne` the cell rules' limit
 * (notebook.ts · CouncilSettings.runLimitSec). Everything after that (the
 * countdown, the repeated signal, the "not taking" flag) is shared, and there
 * is nowhere for them to diverge.
 */
function beginLimit(runtime: Runtime, item: QueueItem, sec: number | null, startedAt: number): void {
  runtime.limit = { item, startedAt, sec, timer: null, firedSec: null, interrupts: 0, stuck: false, pending: false, resume: null }
  armLimit(runtime)
}

/**
 * Clear the alarm and say whether it fired.
 *
 * Called at the ONLY exit of each of the two paths (`finishCouncil` for an
 * attempt and `finally` for a cell), and so cleared on every outcome at once:
 * a normal end, a failure, an interrupt, a kernel death, the cell's removal.
 * Were the alarm to outlive its work even for a moment, the signal would go to
 * the next queue entry, i.e. someone else's attempt or the teacher's cell.
 */
function clearLimit(runtime: Runtime, item: QueueItem): number | null {
  const limit = runtime.limit
  if (!limit || limit.item !== item) return null
  if (limit.timer) {
    clearTimeout(limit.timer)
    limit.timer = null
  }
  runtime.limit = null
  return limit.firedSec
}

/**
 * Reset the alarm on the current work, or clear it.
 *
 * Counted from the START of the run, not from "now": otherwise a teacher who
 * touched the rules twice in a minute would extend a hung loop's life with
 * every press. Hence also "the limit was lowered below the time already
 * passed": the remainder is negative, zero goes into `setTimeout`, the signal
 * comes on the next tick.
 */
function armLimit(runtime: Runtime): void {
  const limit = runtime.limit
  if (!limit) return
  if (limit.timer) {
    clearTimeout(limit.timer)
    limit.timer = null
  }
  if (limit.sec === null) return
  const left = startOfLimit(runtime, limit) + limit.sec * limitTickMs - Date.now()
  limit.timer = setTimeout(() => {
    limit.timer = null
    fireLimit(runtime, limit)
  }, Math.max(0, left))
  limit.timer.unref?.()
}

/**
 * The limit fired: stop the work and remember which limit it was.
 *
 * The kernel is NOT restarted, even if SIGINT did not help. Python that has
 * gone into C (`np.linalg.inv` on a matrix of the wrong size) will not see the
 * signal until it returns to the interpreter, but the notebook has one kernel,
 * and it holds the teacher's whole analysis: `df`, the model, half an hour of
 * preparation. Wiping that out for them, by a timer and silently, costs more
 * than the trouble. They decide: they have "Interrupt" and "Restart", and from
 * now on also a word about what happened.
 *
 * And for the same reason there are no more than two signals: one at once and
 * one five limit "seconds" later, for the case when the first landed right in
 * someone else's `except KeyboardInterrupt`. Signalling silently beyond that is
 * not allowed: SIGINT in a tight loop once a second is a storm of HTTP requests
 * to Jupyter until the end of class, and it cannot help. But KEEPING QUIET is
 * not allowed either: from this second the notebook's queue stands dead still,
 * and until now nobody learned about it: neither the author, whose attempt
 * "computes" forever, nor the twelve people standing behind it. So the `stuck`
 * flag is set here, the console draws a kernel restart with an honest price
 * from it, and a line goes into the kernel log.
 */
function fireLimit(runtime: Runtime, limit: RunLimit): void {
  // The work finished by itself at exactly this moment: there is nothing to
  // touch, since the queue may have taken the next job already, and the signal
  // would land in it.
  if (runtime.limit !== limit) return
  // And a seminar closed in these milliseconds must not wake `getRuntime` inside
  // `interruptSession`: that one creates the runtime anew, and with it the
  // document of a room that no longer exists (the same caution as with
  // `retired` in `shutdownSession`).
  if (runtime.retired || peekRuntime(runtime.sessionId, runtime.root) !== runtime) return
  /*
   * The signal before this one has not reached the kernel yet: its machine
   * cannot be reached, and that signal goes again by itself the moment the
   * link is back (§5.8, `signalItem`). A second one now would only stand
   * behind it, so the count goes on from when the first one lands.
   */
  if (limit.pending) {
    limit.resume = () => fireAgainLater(runtime, limit)
    return
  }
  if (limit.sec !== null) limit.firedSec = limit.sec
  limit.interrupts += 1
  stopRunningItem(runtime, limit.item)
  if (limit.interrupts < 2) {
    fireAgainLater(runtime, limit)
    return
  }
  checkDeafLater(runtime, limit)
}

/** The second signal, LIMIT_RETRY_TICKS after the first. */
function fireAgainLater(runtime: Runtime, limit: RunLimit): void {
  limit.timer = setTimeout(() => {
    limit.timer = null
    fireLimit(runtime, limit)
  }, LIMIT_RETRY_TICKS * limitTickMs)
  limit.timer.unref?.()
}

/**
 * The second signal went out. After the same five "seconds" we check whether
 * it took: work that is still computing by then will never stop, and the
 * notebook's queue will not move behind it. The check is deferred rather than
 * right after, because `interrupt` goes over HTTP and does not answer
 * instantly: declaring the kernel deaf in the same millisecond would slander
 * half of the normal stops.
 */
function checkDeafLater(runtime: Runtime, limit: RunLimit): void {
  const check = setTimeout(() => {
    if (runtime.limit !== limit || limit.stuck) return
    // Not deaf but out of reach: the signal is still on its way, and the check waits for it to land.
    if (limit.pending) {
      limit.resume = () => checkDeafLater(runtime, limit)
      return
    }
    limit.stuck = true
    tellQueueWatchers(runtime)
    // A pool's worker is recycled, never the notebook's kernel (§9.6): the room's log hears nothing of it.
    const handle = handleOf(runtime)
    if (handle) poolSays('stuck', undefined, () => councilPool.stuck(handle))
    else kernelNote(runtime.sessionId, tr('server.kernel.deafToInterrupt'))
  }, LIMIT_RETRY_TICKS * limitTickMs)
  check.unref?.()
}

/**
 * The rules were changed while this cell's attempt is computing: the limit
 * applies at once, counted from its start.
 *
 * Called from control.ts on `cell:lock`: "rules apply at once" is a promise to
 * the whole room (shared/rules.ts), and the run limit cannot be an exception to
 * it, otherwise a hung loop lives until the end of class under new rules that
 * forbid exactly that.
 */
export function retimeCouncilRun(sessionId: string, cellId: string, limitSec: number | null): void {
  const runtime = councilScope(sessionId, cellId)
  if (runtime) retimeIn(runtime, cellId, limitSec)
  /*
   * And the class's pool (§9.6): every worker computing an attempt of this
   * cell re-arms its own alarm, counted from that attempt's start, and the
   * attempts waiting in the pool's queue take the new number with them.
   */
  for (const worker of workersOf(sessionId, rootOf(sessionId, cellId))) retimeIn(worker, cellId, limitSec)
  poolSays('retime', undefined, () => councilPool.retime(sessionId, cellId, limitSec))
}

/** The new limit for one scope's attempts of this cell: the waiting ones and the one computing (retimeCouncilRun). */
function retimeIn(runtime: Runtime, cellId: string, limitSec: number | null): void {
  /*
   * The waiting ones first: the limit is written into the job itself at
   * queueing time (the kernel does not read the document), and without this
   * "applies at once" would be true for exactly one attempt. On a cohort the
   * queue is dozens of jobs: the teacher replaces "no limit" with a limit, and
   * forty runs already waiting would still go without one, one by one, until
   * the end of class. The queue entry is replaced whole rather than edited in
   * place: its `job` is the same object the listener in control.ts holds, and
   * there is no reason to change someone else's field under it.
   */
  for (const item of runtime.queue) {
    if (item.council?.cellId === cellId && item.council.limitSec !== limitSec) {
      item.council = { ...item.council, limitSec }
    }
  }
  const active = runtime.job
  if (!active || active.job.cellId !== cellId) return
  const limit = runtime.limit
  // The alarm guards EXACTLY this attempt, not "something in this notebook":
  // between the end of an attempt and the next job the queue manages to step.
  if (!limit || limit.item !== active.item || limit.sec === limitSec) return
  limit.sec = limitSec
  // A signal was already sent: no second one by the new limit; there is one
  // stop, and its number (`firedSec`) is already named.
  if (limit.firedSec !== null) return
  armLimit(runtime)
}

/**
 * The only door out of "computing" for an attempt, like `setCellState` for a
 * cell. The ordinary end, a throw from execute and `reportDeadKernel` come
 * here.
 */
function finishCouncil(runtime: Runtime, active: ActiveJob, state: 'ok' | 'error'): void {
  if (active.timer) {
    clearTimeout(active.timer)
    active.timer = null
  }
  /*
   * The limit alarm is cleared HERE, at the attempt's only exit, and so it is
   * cleared on every outcome: a normal end, a failure, an interrupt, a kernel
   * death, the cell's removal. Were it to outlive the attempt even for a
   * moment, the signal would go to the next job in the queue, i.e. someone
   * else's attempt or the teacher's cell. `clearLimit` also answers whether it
   * fired.
   */
  // By the runtime's record, not its own: `restamp` moves the start when the
  // kernel had to be brought up again, and the minute and a half of that is not
  // attempt time.
  const startedAt =
    runtime.started?.cellId === active.item.cellId ? runtime.started.at : active.run.startedAt
  const fired = clearLimit(runtime, active.item)
  /*
   * The "stopped by the limit" mark is put only on a failed run.
   *
   * The signal and the last line of code can coincide within one millisecond:
   * the kernel managed to answer `ok`, so the attempt finished computing by
   * itself and nothing was taken from it. Calling such a run stopped would be a
   * lie on the card and in the list of works, and that costs more than a missed
   * second of the limit.
   */
  const limitFired = state === 'error' ? fired : null
  if (limitFired !== null) {
    active.buffer.stopped(
      tr("server.stoppedTheRunTookLongerThanThe.87bfc0", { p0: durationWords(limitFired) }),
    )
  }
  active.run = {
    ...active.run,
    state,
    outputs: active.buffer.snapshot(),
    ranMs: Math.max(0, Date.now() - startedAt),
    ...(limitFired !== null ? { timedOut: limitFired } : {}),
  }
  finishExecution(runtime, active.item, state === 'ok' ? 'completed' : 'error', active.run.ranMs ?? 0)
  if (runtime.started?.cellId === active.item.cellId) runtime.started = null
  runtime.job = null
  runtime.currentCell = null
  runtime.currentBatch = null
  runtime.currentRunById = null
  runtime.lastFinished = { cellId: active.item.cellId, batch: active.item.batch }
  runtime.lastWorkAt = Date.now()
  tellJob(active.job, active.run)
  syncQueue(runtime)
}

/**
 * Compute an attempt with the same kernel and the same handlers as a cell, but
 * with output into a buffer. The differences from `runOne` are named where they
 * occur; everything else is deliberately the same, so that an attempt behaves
 * like a cell that was run.
 */
async function runCouncilOne(runtime: Runtime, item: QueueItem, job: CouncilJob): Promise<void> {
  const { doc } = getSessionDoc(runtime.sessionId)
  const startedAt = Date.now()
  const active: ActiveJob = {
    item,
    job,
    buffer: new CouncilOutputBuffer(),
    run: { state: 'running', outputs: [], execCount: null, ranMs: null, startedAt, by: job.by, ...placedOf(item) },
    timer: null,
  }
  runtime.currentCell = item.cellId
  runtime.currentBatch = item.batch
  runtime.currentRunById = item.runById
  runtime.started = { cellId: item.cellId, at: startedAt }
  runtime.job = active
  runtime.activityItem = item
  executionActivity(runtime, item, 'execution.started')
  syncQueue(runtime)
  setStatus(runtime, 'busy')
  tellJob(job, { ...active.run })
  // A pool's worker (§9.5): its pool hears how each attempt ended, for its recycling and the attempt's files.
  const handle = handleOf(runtime)

  if (job.source.trim().length === 0) {
    finishCouncil(runtime, active, 'ok')
    if (handle) attemptEnded(handle, item, { ...QUIET_END, run: active.run })
    return
  }

  flushToDisk(runtime.sessionId)
  // The barrier, as before a cell (runOne, §8.2): the attempt reads the class folder of the machine it computes on.
  let moving = false
  const barred = await passFilesBarrier(runtime, (words) => {
    moving = true
    active.buffer.supersede()
    active.buffer.stream('stdout', words)
    touchJob(runtime, active)
  })
  if (moving) active.buffer.clear()
  if (barred === STOPPED) {
    // Stopped before it reached the kernel: no run at all, as an attempt the same press dropped from the queue (releaseCouncil).
    letGoOfAttempt(runtime, active)
    releaseCouncil(runtime, [item])
    syncQueue(runtime)
    if (handle) attemptEnded(handle, item, { ...QUIET_END, kind: 'stopped' })
    return
  }
  if (barred !== null) {
    active.buffer.error('', barred, [])
    finishCouncil(runtime, active, 'error')
    if (handle) attemptEnded(handle, item, { ...QUIET_END, run: active.run })
    return
  }
  const unwatch = stopIfDeleted(runtime, doc, item.cellId, job.cellId)
  /*
   * The alarm is set BEFORE the first line goes to the kernel and after the
   * empty-attempt check: an empty one has nothing to compute, while everything
   * else is already time the queue stands still. Personal data copies (the
   * entry below) count against the limit on purpose: they occupy the shared
   * kernel too.
   *
   * The number was taken from the cell at the second of the press and came with
   * the job (kernel/council.ts · CouncilJob.limitSec); rules changed in the
   * middle of a run arrive separately, through `retimeCouncilRun`.
   */
  beginLimit(runtime, item, job.limitSec, startedAt)
  const { buffer } = active
  let state: 'ok' | 'error' = 'ok'
  /*
   * A pool's attempt that goes to the notebook's kernel after all (§9.4,
   * §9.10): it reads a name its epoch left behind (the worker's entry says
   * so), or its machine went with it, once (D15). It is not an attempt that
   * failed: no frame of an end goes out, and it runs again there, keeping
   * its place, its card saying why.
   */
  let handback: { kind: 'rerouted' | 'lost'; note: string } | null = null
  const lostOnce = (): boolean => handle !== null && !item.rerun && runtime.kernel?.endedBy?.cause === 'lost'
  let entered = false
  let restartedItself = false
  // The attempt's personal data copies. See councilEnterSourceNow (and entrySourceFor for a pool's worker).
  const { report, reason, raw } = await enterCouncilIsolation(runtime, item)
  let starved = false
  try {
    const needs = handle ? poolSays('needs', null, () => councilPool.needs(raw)) : null
    if (needs) {
      handback = { kind: 'rerouted', note: tr('server.runInTheSharedKernelItUses.eaf141', { name: needs.name }) }
      entered = true
      return
    }
    if (!report?.ok) {
      if (lostOnce()) {
        handback = { kind: 'lost', note: tr('server.theMachineWasLostInTheMiddle.b5f5c5') }
        return
      }
      /*
       * The entry was not confirmed: the attempt does NOT run.
       *
       * The entry's silence means "unknown whose data is in the kernel right
       * now", and running on shared objects is exactly what would cost a class
       * here: the student would get a right-looking answer while spoiling the
       * data for the whole group. One line without a traceback: the
       * `<colloq-council>` frames are not their code and will tell them
       * nothing.
       */
      // The exception name is empty for the same reason as with a stop by the
      // limit (council.ts · stopped): the card draws "name: text", and an
      // English word in front of a Russian phrase adds nothing.
      buffer.error('', runtime.kernel?.endedBy ? lostMidRun() : councilEnterRefusal(reason), [])
      state = 'error'
      return
    }
    entered = true
    // What stayed shared goes first in the output, before the attempt's first line.
    for (const note of councilSkipNotes(report)) buffer.stream('stderr', note)
    /*
     * No kernel history: the only difference from a cell in the request itself.
     *
     * A notebook has one kernel, and IPython puts the source of every executed
     * cell into `In`/`_ih`: the attempts the teacher ran could be read by anyone
     * a cell is later opened to "everyone" for (`print(In[-5:])`, `%history`).
     * An attempt's output honestly travels to two people, while its text would
     * lie in the kernel's memory for everyone, contrary to the rule "a student
     * never sees other people's attempts".
     */
    const status = await runOnKernel(
      runtime,
      job.source,
      {
        onExecuteInput: (execCount) => {
          active.run.execCount = execCount
          touchJob(runtime, active)
        },
        onStream: (name, text) => {
          buffer.stream(name, text)
          touchJob(runtime, active)
        },
        onData: (mimebundle, execCount) => {
          buffer.data(mimebundle, execCount)
          touchJob(runtime, active)
        },
        onError: (ename, evalue, traceback) => {
          /*
           * Our own refusal is one line without a traceback, like a stop by the
           * limit. The `<colloq-council>` frames in it are not student code,
           * and there is nothing there for them to read: that is our module
           * explaining why `exit()` in an attempt would take the kernel down
           * for the whole room.
           */
          if (ename === COUNCIL_REFUSED) buffer.error('', evalue, [])
          else buffer.error(ename, evalue, traceback)
          // A MemoryError under our ceiling is a class saved, and that has to
          // be said after the traceback, in words and with a number.
          if (/MemoryError/.test(ename)) starved = true
          touchJob(runtime, active)
        },
        onClear: (wait) => {
          if (wait) buffer.supersede()
          else buffer.clear()
          touchJob(runtime, active)
        },
        /*
         * `input()` in an attempt has nobody to show it to: a cell's prompt
         * lives in the shared document, but an attempt has no document, and the
         * audience does not see it. Meanwhile the kernel stands until someone
         * answers, and would stand until the end of class. We answer with an
         * empty string ourselves and say so in the output: `int('')` fails
         * honestly and explainably, and the queue moves on.
         */
        onInputRequest: () => {
          buffer.stream(
            'stderr',
            tr("server.colloqInputIsNotSupportedInCouncil.fd07fb"),
          )
          touchJob(runtime, active)
          void runtime.kernel?.answerInput('').catch(() => {})
        },
      },
      { storeHistory: false },
    )
    state = status === 'ok' ? 'ok' : 'error'
    if (status === 'abort' && lostOnce()) {
      handback = { kind: 'lost', note: tr('server.theMachineWasLostInTheMiddle.b5f5c5') }
      return
    }
    if (status === 'abort' && !buffer.hasError) {
      const phase = runtime.kernel?.phase
      if (runtime.kernel?.endedBy) buffer.error('', lostMidRun(), [])
      else if (phase === 'dead') buffer.error('KernelDied', deadMessage(), [])
      else if (phase === 'restarting' && runtime.kernel?.phaseExpected === false) {
        restartedItself = true
        buffer.error('KernelDied', killedMessage(), [])
      } else buffer.error('Interrupted', tr("server.theAttemptWasInterrupted.4f4edf"), [])
    }
  } catch (err) {
    if (lostOnce() || (handle !== null && !item.rerun && err instanceof StartLost)) {
      handback = { kind: 'lost', note: tr('server.theMachineWasLostInTheMiddle.b5f5c5') }
    } else {
      if (runtime.kernel?.endedBy || err instanceof StartLost) buffer.error('', lostMidRun(), [])
      else buffer.error('KernelError', startWords(runtime.sessionId, runtime.role, errText(err)), [])
      state = 'error'
    }
  } finally {
    unwatch()
    /*
     * The exit ALWAYS happens, including the branch where the attempt was not
     * run: the entry may have managed to replace the bindings and fail after,
     * and then the only thing that returns the room its data is this line.
     *
     * The end of the attempt is assembled right here, after the exit, not after
     * the `try`: the "entry not confirmed" branch leaves the block early, and
     * otherwise the card would stay "computing" forever.
     *
     * Except for a process that is gone, as far as this scope knows
     * (abandonKernelsForTest): it sends the kernel nothing and reports
     * nothing, and the next life finds the attempt as a crash leaves it.
     */
    if (!abandoned.has(runtime)) {
      const stuck = runtime.limit?.item === item && runtime.limit.stuck
      /*
       * A worker being recycled under its attempt (it was stuck, §9.5) has no
       * namespace left to give back: the process goes, and an exit sent to it
       * now would be lost with it, the attempt never ending.
       */
      const recycling = handle !== null && (runtime.restarting !== null || runtime.kernel?.phase === 'restarting')
      const { leftovers, raw: leftRaw } = recycling ? { leftovers: null, raw: null } : await leaveCouncilIsolation(runtime)
      if (handback !== null && handle !== null) {
        // To the notebook's kernel, keeping its place: a loss is run there once (D15), and its pause is not charged (it never ended as a run).
        letGoOfAttempt(runtime, active)
        if (handback.kind === 'lost') item.rerun = true
        requeueCouncilShared(runtime.sessionId, handle.root, item, handback.note)
        syncQueue(runtime)
        attemptEnded(handle, item, { ...QUIET_END, kind: handback.kind, entered, scratch: true, threads: leftovers?.threads ?? 0, processes: leftovers?.processes ?? 0, stuck })
        return
      }
      // Notes at the tail of the output: why memory ran short and what was left
      // running. Both come after the attempt's code, because both are about its
      // consequences.
      if (starved) buffer.stream('stderr', councilMemoryNote(report?.memory ?? null))
      for (const note of councilLeftoverNotes(leftovers)) buffer.stream('stderr', note)
      const left = handle ? poolSays('left', { files: [], dirtyMb: null }, () => councilPool.left(leftRaw)) : null
      // The pool's attempt's own files (§9.7): named on its card as its worker listed them, those it brings on their way; each brought as it lands.
      if (left && left.files.length > 0) active.run = { ...active.run, files: attemptCardFiles(left.files) }
      finishCouncil(runtime, active, state)
      if (handle && left) {
        const kernel = runtime.kernel
        attemptEnded(handle, item, {
          kind: 'ran',
          entered,
          scratch: true,
          threads: leftovers?.threads ?? 0,
          processes: leftovers?.processes ?? 0,
          stuck,
          kernel: !kernel || kernel.phase === 'dead' || kernel.endedBy ? 'dead' : restartedItself ? 'restarted' : 'up',
          dirtyMb: left.dirtyMb,
          files: left.files,
          run: active.run,
        })
      }
      // The attempt may have written a file: the files panel cares about that too.
      notifyWorkspaceChanged(runtime.sessionId)
      // And a machine's scan reports it now (§8.3).
      askSlotScan(runtime.sessionId, runtime.role)
    }
  }
}

/** An attempt that ended with nothing for its worker's pool to mend. */
const QUIET_END: AttemptEnd = { kind: 'ran', entered: true, scratch: false, threads: 0, processes: 0, stuck: false, kernel: 'up', dirtyMb: null, files: [], run: null }

/** A worker's attempt ended: its pool hears it, and its throw never brings the pump down. */
function attemptEnded(handle: WorkerHandle, item: QueueItem, end: AttemptEnd): void {
  poolSays('ended', undefined, () => councilPool.ended(handle, item, end))
}

/**
 * An attempt leaves its scope without an end of its own (stopped at the
 * barrier, or handed to the notebook's kernel): its frame timer, its alarm
 * and the scope's record of it go, and nothing is told its card here.
 */
function letGoOfAttempt(runtime: Runtime, active: ActiveJob): void {
  const { item } = active
  if (active.timer) {
    clearTimeout(active.timer)
    active.timer = null
  }
  clearLimit(runtime, item)
  if (runtime.started?.cellId === item.cellId) runtime.started = null
  runtime.job = null
  runtime.currentCell = null
  runtime.currentBatch = null
  runtime.currentRunById = null
  runtime.lastFinished = { cellId: item.cellId, batch: item.batch }
  runtime.lastWorkAt = Date.now()
}

/**
 * A kernel that will not come up is an output on the cell, never a crash.
 *
 * `full`: it did not come up because the machine's memory is promised to
 * other classes (pool.ts · machineMemoryFull). The cell that was waiting gets
 * the error under KERNEL_MEMORY_ENAME, which the room draws as a notice
 * rather than as a failure (K5), and stays `idle`: its code never ran, the
 * oracle must not read it as a broken cell, and the chip says «НЕ ЗАПУЩЕНО».
 */
function reportDeadKernel(runtime: Runtime, message: string, full = false): void {
  const down: KernelStatus = full ? 'off' : 'dead'
  // An epoch's export at the head has no cell to say it on: it is answered as failed, and goes.
  while (runtime.queue[0]?.service) answerService(runtime.queue.shift()!.service!, { refused: 'failed', detail: message })
  if (runtime.activityItem && !runtime.job) {
    finishExecution(runtime, runtime.activityItem, 'error',
      Math.max(0, Date.now() - (runtime.started?.at ?? Date.now())))
  }
  /*
   * A council attempt gets the same word, but on the attempt, not into a cell:
   * it has no cell, and the OutputWriter below would write into the void,
   * leaving the card "computing" forever.
   */
  if (runtime.job) {
    runtime.job.buffer.error('KernelError', message, [])
    finishCouncil(runtime, runtime.job, 'error')
    dropQueue(runtime)
    setStatus(runtime, down)
    return
  }
  const head = runtime.queue[0]
  if (!runtime.currentCell && head?.council) {
    finishExecution(runtime, head, 'error')
    runtime.queue.shift()
    tellJob(head.council, {
      state: 'error',
      outputs: [{ kind: 'error', ename: 'KernelError', evalue: message, traceback: [] }],
      execCount: null,
      ranMs: null,
      startedAt: Date.now(),
      by: head.council.by,
    })
    dropQueue(runtime)
    setStatus(runtime, down)
    return
  }
  const { doc } = getSessionDoc(runtime.sessionId)
  const stuck = runtime.currentCell ?? runtime.queue[0]?.cellId ?? null
  if (stuck) {
    // One notice per cell: a second press on a full machine replaces the
    // first refusal instead of stacking another box under it.
    if (full) dropMemoryRefusals(doc, stuck)
    const writer = runtime.writer ?? new OutputWriter(doc, stuck)
    writer.error(full ? KERNEL_MEMORY_ENAME : 'KernelError', message, [])
    // Our own one, created a line above, does not hold the room, so there is
    // nothing to release; the one that sat in the runtime is released here.
    writer.dispose()
    dropWriter(runtime)
    runtime.currentCell = null
    runtime.currentBatch = null
    runtime.currentRunById = null
    const waiting = runtime.queue[0]?.cellId === stuck
    if (waiting) finishExecution(runtime, runtime.queue[0], 'error')
    if (waiting) runtime.queue.shift()
    /*
     * A cell that was only waiting in the queue loses its number along with the
     * kernel.
     *
     * Its previous result stays: it is the only evidence of what it once showed,
     * and there is no reason to erase it. But the number above it now lies:
     * under one `Out [12] · 3.4 s` there end up the contents of two different
     * executions, `hasError` paints the whole cell as failed, and
     * `newestErrorIndex` in the Oracle's context hands the model the table of
     * the twelfth execution as the circumstances of a failure that belongs to
     * none.
     */
    if (waiting) {
      const found = findCell(doc, stuck)
      if (found) {
        doc.transact(() => {
          found.cell.set('execCount', null)
          found.cell.set('ranMs', null)
        }, ORIGIN)
      }
    }
    setCellState(runtime.sessionId, stuck, full ? 'idle' : 'error')
  }
  dropQueue(runtime)
  setStatus(runtime, down)
}

/** Remove a cell's earlier memory refusals (see reportDeadKernel); its real output stays. */
function dropMemoryRefusals(doc: Y.Doc, cellId: string): void {
  const found = findCell(doc, cellId)
  if (!found) return
  const outputs = cellOutputs(found.cell)
  const stale: number[] = []
  outputs.forEach((output, index) => {
    const parsed = readOutput(output)
    if (parsed && isKernelMemoryOutput(parsed)) stale.push(index)
  })
  if (stale.length === 0) return
  doc.transact(() => {
    for (const index of stale.reverse()) outputs.delete(index, 1)
  }, ORIGIN)
}

/**
 * The kernel came up: every memory notice in its notebook is out of date.
 *
 * A refusal lands on whichever cell was waiting (reportDeadKernel), and only
 * a second refusal or a re-run of that same cell took it off. Student A's
 * cell 3 and student B's cell 7 kept «Не хватает памяти на сервере… попросите
 * владельца» while the teacher's cell 1 had long brought the kernel up and it
 * was computing; and since outputs are saved with the notebook, the next class
 * opened the room to the same notices. The notice is about the machine, not
 * about the cell's code, so it goes when the machine has let a kernel in.
 *
 * Read without creating anything: a cell without outputs stays without the key.
 */
function clearMemoryNotices(runtime: Runtime): void {
  if (hidden(runtime)) return
  const doc = peekSessionDoc(runtime.sessionId)?.doc
  if (!doc) return
  const stale: Array<{ outputs: Y.Array<YOutput>; index: number }> = []
  bookCells(doc, runtime.root).forEach((cell) => {
    const outputs = cell.get('outputs') as Y.Array<YOutput> | undefined
    if (!(outputs instanceof Y.Array)) return
    outputs.forEach((output, index) => {
      if (output.get('kind') !== 'error') return
      const parsed = readOutput(output)
      if (parsed && isKernelMemoryOutput(parsed)) stale.push({ outputs, index })
    })
  })
  if (stale.length === 0) return
  doc.transact(() => {
    // From the end, so each index still points at what it was read as.
    for (const { outputs, index } of stale.reverse()) outputs.delete(index, 1)
  }, ORIGIN)
}

function deadMessage(): string {
  return tr("server.thePythonKernelStoppedRespondingRestartIt.09f400")
}

/**
 * The cell that is computing right now was deleted: stop the kernel.
 *
 * Deletion has no link to execution: the cell disappears from the document
 * while the loop in the kernel keeps spinning, `meta.runningCell` names an id
 * that no longer exists, and there is nothing to stop it with: the button is
 * drawn on the cell, and the cell is gone. An interrupt here is exactly what a
 * person would press if the button had something to attach to.
 *
 * The observer lives only while the cell computes and does not see our own
 * writes: output and states go under `ORIGIN`.
 */
function stopIfDeleted(
  runtime: Runtime,
  doc: Y.Doc,
  cellId: string,
  /*
   * What to watch. For a cell, the cell itself; for a council attempt the queue
   * entry is synthetic, and what can disappear from the document is the council
   * cell, and with it the point of computing anyone's attempt for it.
   */
  watched = cellId,
): () => void {
  let fired = false
  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (fired || origin === ORIGIN) return
    if (runtime.currentCell !== cellId || findCell(doc, watched)) return
    fired = true
    if (runtime.activityItem) runtime.activityItem.activityCancelled = true
    // (A pool's worker stops its attempt as quietly: the council cell's removal is the room's own news.)
    if (!hidden(runtime)) {
      kernelNote(
        runtime.sessionId,
        tr("server.theCellThatWasRunningWasDeleted.ec6ea8"),
      )
    }
    void runtime.kernel?.interrupt().catch(() => {})
  }
  doc.on('update', onUpdate)
  return () => doc.off('update', onUpdate)
}

/**
 * Write to disk what the room has typed but not saved yet.
 *
 * Only for our own room: the cell reads the disk here, while other rooms'
 * unsaved files will get there by themselves the same seven hundred
 * milliseconds later.
 */
function flushToDisk(sessionId: string): void {
  try {
    projectBooks(sessionId)
    flushSessionFiles(sessionId)
  } catch (err) {
    console.error(`[kernel] could not flush files for ${sessionId}:`, errText(err))
  }
}

/** The kernel came back on its own, the cell did not: its process was killed. */
function killedMessage(): string {
  const known = churnReason()
  return known
    ? tr("server.theCellRunningAtTheTimeWas.11ac96", { p0: known })
    : tr("server.theKernelRestartedDuringExecutionThisCell.e72a65")
}

/* ------------------------------------------------------------------ outputs */

/**
 * Put the room's code in one shape.
 *
 * Waits for a kernel first: black runs in the seminar's own Python, so that the
 * formatting matches the version the room is actually using. Anything the
 * formatter refuses is left alone — see kernel/format.ts for why that is the
 * whole design rather than a fallback.
 */
export async function formatSession(
  sessionId: string,
  book?: string,
  /** The notebook whose kernel runs black; without it, the room's notebook. */
  root: string = CELLS_KEY,
): Promise<FormatOutcome> {
  const runtime = getRuntime(sessionId, root)
  /*
   * Bypassing the queue, but not into a busy kernel.
   *
   * The formatting request goes straight to the kernel, bypassing our queue,
   * and Jupyter executes strictly in order: while a cell is computing, black's
   * `execute` simply waits behind it. Usually that is seconds and concerns
   * nobody. But a cell stopped in `input()` will not end until somebody
   * answers, and the Format button hangs without a word until the end of class,
   * while a neighbouring cell's `stop_on_error` can even cut the request off
   * with "The kernel could not run the formatter", which explains nothing.
   *
   * So the refusal comes in words and at once. There is nothing to wait in line
   * for here: the notebook cannot be rewritten under a cell that is executing
   * it at that moment anyway.
   */
  const busyWith = formatBlocker(runtime)
  if (busyWith) return formatRefused(sessionId, busyWith)
  try {
    await ensureKernel(sessionId, root)
  } catch (err) {
    // The only refusal without its own kernel log line: `ensureKernel` has
    // already put `errText(err)` there in the same words, and there is no need
    // to repeat them to the whole room a second time. The person who pressed
    // gets them as the answer anyway.
    return { changed: 0, skipped: 0, edited: 0, unchanged: 0, error: errText(err) }
  }
  const kernel = runtime.kernel
  if (!kernel) return formatRefused(sessionId, tr("server.theKernelIsNotRunning.2a9152"))
  // The kernel may have gone to work while it was coming up: we ask again, now
  // knowing about `input()` too.
  const nowBusy = formatBlocker(runtime)
  if (nowBusy) return formatRefused(sessionId, nowBusy)
  const outcome = await formatNotebook(sessionId, kernel, book)
  if (outcome.error) return formatRefused(sessionId, outcome.error)
  return outcome
}

/**
 * A formatting refusal, one road for every reason.
 *
 * The "Formatting failed: …" line went into the kernel log only from
 * `formatNotebook`, while the early refusals (waiting for `input()`, the kernel
 * is busy, the queue) returned before it, i.e. a room whose Format did nothing
 * saw the reason nowhere, while the comments nearby promised the opposite. Now
 * one place writes the reason: the person who pressed gets it as the answer
 * (control.ts · `t:'error'`), the room gets this same line in the log. There is
 * nothing to count here: on an error `formatNotebook` also returns all zeros.
 */
function formatRefused(sessionId: string, error: string): FormatOutcome {
  kernelNote(sessionId, tr("server.formattingFailed.e1afc5", { p0: error }))
  return { changed: 0, skipped: 0, edited: 0, unchanged: 0, error }
}

/** Why now is not the time to format, in the words that will go to the kernel log. */
function formatBlocker(runtime: Runtime): string | null {
  if (runtime.kernel?.waitingForInput) {
    return tr("server.aCellIsWaitingForInputAnswer.370e11")
  }
  if (runtime.currentCell) {
    return tr("server.theKernelIsBusyRunningACell.9452d9")
  }
  if (runtime.queue.length > 0) {
    return tr("server.cellsAreQueuedToRunPressFormat.204e75")
  }
  return null
}

/**
 * Answer a cell that is blocked inside input().
 *
 * Anyone in the room may answer, and the first answer wins — that is not a
 * race to guard against but how a seminar works: the person at the keyboard is
 * not always the person who knows the number.
 */
/**
 * Answer a cell stopped inside `input()`.
 *
 * `cellId` is not decoration: without it the answer went to whatever the
 * kernel happened to be blocked on at that moment, from anyone and from any
 * screen. The cell changed between drawing the form and pressing Enter, and a
 * password typed for one's own cell goes to someone else's.
 */
export async function answerInput(
  sessionId: string,
  value: string,
  cellId?: string,
): Promise<boolean> {
  const scopes = scopesOf(sessionId)
  /*
   * The scope is found by the cell, and without one by what is ASKING.
   *
   * There are several kernels now, and any of them may stand in `input()`;
   * "what the kernel is blocked on" is no longer one place. With a cell name
   * the answer goes exactly where the question came from. Without a name (a tab
   * opened before the deploy) we take the scope that really waits for an
   * answer: if only one waits, there is nobody to miss into, and if several,
   * the order is the same one in which the notebooks were created.
   */
  const runtime = cellId
    ? scopes.find((scope) => scope.currentCell === cellId)
    : scopes.find((scope) => scope.kernel?.waitingForInput)
  const kernel = runtime?.kernel
  if (!runtime || !kernel || !kernel.waitingForInput) {
    /*
     * The kernel is not waiting for input, so the form on the cell must not ask
     * either.
     *
     * The prompt lives in the shared document, and it hung for the WHOLE room:
     * every next "Send" quietly got `false`, and the only way out was "stop".
     * We clear it here, not only on a successful answer.
     */
    const stale = cellId ?? scopes.find((scope) => scope.currentCell)?.currentCell ?? null
    if (stale && scopes.some((scope) => !scope.retired)) clearStdinOn(sessionId, stale)
    return false
  }
  const answered = await kernel.answerInput(value)
  if (answered) clearStdinOn(sessionId, runtime.currentCell)
  return answered
}

/**
 * The NOTEBOOK's kernel, but only one that is ALREADY alive.
 *
 * No kernel, a dead one or one restarting gives `null` here, and there is
 * nothing to ask. It cannot be BROUGHT UP from here: `ensureKernel` means up to
 * a minute and a half of waiting, and a question asked by a hovering mouse
 * cannot wait that long. Who brings it up and by what right is said at
 * `mayWake` below; the kernel arrives here already alive or not at all.
 */
function liveKernel(sessionId: string, root: string): JupyterKernel | null {
  const runtime = peekRuntime(sessionId, root)
  const kernel = runtime?.kernel ?? null
  if (!runtime || !kernel) return null
  if (kernel.phase === 'dead' || kernel.phase === 'restarting' || kernel.phase === 'starting') return null
  /*
   * A kernel on a machine that does not answer right now is not there to ask
   * either (remote-classes.md §5.6): the question would wait out its whole
   * budget at a closed door, on every hover. Home's kernels have no link, and
   * nothing more is asked about them.
   */
  if (kernel.endpoint.link && machineAway(runtime)) return null
  return kernel
}

/**
 * How much longer a help question waits for a kernel on a machine: the road's
 * pad, min(1000 ms, 2 × the link's RTT p95), so that jedi does not time out on
 * distance alone (§5.6). Zero at home, where the placement module is not even
 * asked.
 */
function helpPadOf(runtime: Runtime | null, kernel: JupyterKernel): number {
  if (!runtime || !kernel.endpoint.link) return 0
  return helpPad(runtime.sessionId, runtime.role)
}

function helpPad(sessionId: string, role: KernelRole): number {
  let pad = 0
  try {
    pad = placements.helpPadMs(sessionId, role)
  } catch {
    return 0
  }
  return Number.isFinite(pad) && pad > 0 ? Math.min(pad, CLASS_HELP_PAD_MAX_MS) : 0
}

/**
 * A help question raced against its wait. The timer is the class clock's
 * (`useClassPlacements`), which is the process's own unless a suite moves it.
 */
function withinWait<T>(question: Promise<T>, ms: number): Promise<T | 'abort'> {
  let handle: unknown = null
  const wait = new Promise<'abort'>((resolve) => {
    handle = classClock.setTimeout(() => resolve('abort'), ms)
  })
  return Promise.race([question, wait]).finally(() => classClock.clearTimeout(handle))
}

/**
 * Wake the kernel with this question, and do not wait for it.
 *
 * Until 19 Sep 2026 a hint never brought a kernel up, and the argument was:
 * `ensureKernel` takes up to a minute and a half, and a dot typed after `df` is
 * no reason to warm up the machine. The argument stayed half right. The
 * question still cannot wait and does not: the promise resolves right away with
 * the answer "starting". But the asker's RIGHT to start is exactly the same as
 * the "Run" button's: control.ts decides it (`mayWake`), and whoever can press
 * Run can also hover the mouse. Refusing them help because they have not run
 * anything yet would mean refusing exactly at the start of class, when the
 * notebook has just been opened and help is needed most.
 */
function wakeKernel(sessionId: string, root: string): void {
  /*
   * The kernel of THE notebook being typed in. A personal notebook has its
   * own, in its own container, and bringing up the room's kernel instead would
   * show help about someone else's variables.
   *
   * A refusal does not go outside: personal kernels have a ceiling per class
   * (`OwnKernelUnavailable`), and the broker has its own reasons not to give a
   * Pod. For help this is simply "no kernel", and the next question will say so
   * in words; throwing an exception from here would bring down the answer to a
   * mouse hover.
   */
  void ensureKernel(sessionId, root).catch(() => {
    /* did not come up: the next question says so itself; nobody to complain to */
  })
}

/**
 * What the kernel would complete at this point in the code.
 *
 * `null` means "there was nobody to ask, or the kernel did not answer": there
 * is deliberately no separate word for a refusal, because there is nowhere to
 * show it. A suggestion either exists or it does not; a toast saying jedi is
 * thinking is noise in the middle of typing.
 */
export async function completeIn(
  sessionId: string,
  code: string,
  cursor: number,
  /** The notebook whose kernel is asked; without it, the room's notebook. */
  root: string = CELLS_KEY,
  opts: { mayWake?: boolean } = {},
): Promise<CompleteResult | null> {
  const kernel = liveKernel(sessionId, root)
  /*
   * The test backend has no kernel at all (KERNEL_BACKEND=test, JUPYTER_URL
   * points at a dead port), yet the whole path has to be checked, from the
   * console frame to the frame back. The prepared answer is this backend's
   * "kernel": the same set pandas gives on `df.`, so that the test speaks about
   * the real case rather than an empty list.
   *
   * And only in place of the kernel it lacks, as for help (`inspectIn`): a
   * live kernel of this backend (the fake Jupyter a suite stands in, a
   * class's kernel on a machine) answers itself, by the real road and with
   * that road's pad (remote-classes.md §5.6). Otherwise no test of the
   * console's `complete` frame could see it reach a kernel, here or on a
   * machine.
   */
  if (kernelBackend() === 'test' && !kernel) return cannedComplete(code, cursor)
  if (!kernel) {
    // The very first dot typed brings up a Python for this notebook; see
    // `wakeKernel`. This question has nothing to answer with, but the next one
    // will.
    if (opts.mayWake === true) wakeKernel(sessionId, root)
    return null
  }
  try {
    return await kernel.complete(code, cursor, helpPadOf(peekRuntime(sessionId, root) ?? null, kernel))
  } catch {
    // A busy kernel does not answer shell at all; see SHELL_REQUEST_MS. That is
    // an ordinary outcome in the middle of a run, with nowhere to complain.
    return null
  }
}

/** Help for what is under the caret, and the reason if there is none. */
export interface InspectAnswer {
  found: boolean
  text: string | null
  /** Why nothing was found; `null` means found. See protocol.ts · `InspectMiss`. */
  reason: InspectMiss | null
  /** The kernel's machine does not answer right now (`reason` is then 'busy'); see protocol.ts · `inspect:reply`. */
  unreachable?: true
}

export interface InspectHelpOptions {
  /**
   * The notebook's import header, for the static analysis.
   *
   * It is assembled by whoever has the document (control.ts), not by this
   * function: the kernel layer has no notebooks at all, and reaching into the
   * CRDT for them from here would mean creating a second road to the document
   * for the sake of one line.
   */
  header?: string
  /** Whether this question may bring the kernel up: control.ts decides the right. */
  mayWake?: boolean
}

const miss = (reason: InspectMiss): InspectAnswer => ({ found: false, text: null, reason })

/**
 * Help for what is under the caret, by two roads and with the reason for a
 * refusal.
 *
 * The kernel of THE notebook being typed in is asked: there are now as many
 * kernels as notebooks, and the seminar's `df` is not the `df` the teacher
 * loaded in the lecture.
 *
 * The LIVE kernel is asked first (`inspect_request`): it looks at the real
 * object and knows everything about it, including what the person computed in
 * this notebook a minute ago. If the kernel answers "not found" (and it does
 * every time the cell with the import has not been run yet), jedi is asked
 * from the SOURCES (inspect-static.ts). The order is exactly this and cannot be
 * reversed: the static analysis knows the library but not the room.
 *
 * There is no more silence in any branch. Previously `null` came back here for
 * every trouble, and a person could not tell "the name is not in the kernel"
 * from "the kernel is still coming up": in class this read as "help works every
 * other time".
 */
export async function inspectIn(
  sessionId: string,
  code: string,
  cursor: number,
  /** The notebook whose kernel is asked; without it, the room's notebook. */
  root: string = CELLS_KEY,
  help: InspectHelpOptions = {},
): Promise<InspectAnswer> {
  const runtime = peekRuntime(sessionId, root) ?? null
  const kernel = liveKernel(sessionId, root)
  /*
   * The test backend's prepared answer, in place of the kernel it lacks.
   *
   * And only in place of it. If there is a live kernel (the Jupyter fake in
   * tests/kernel.test.mts), the real road works, with refusal reasons and the
   * static analysis. If there is no kernel but the asker MAY bring it up, it is
   * the real road too: they get "starting", the kernel comes up, and the next
   * question answers honestly. The prepared answer stays what it was: an answer
   * where a kernel has nowhere to come from: someone else's council sheet, a
   * reader, a class that has ended.
   */
  if (kernelBackend() === 'test' && !kernel && help.mayWake !== true) {
    return cannedInspect(code, cursor)
  }
  if (!kernel) {
    /*
     * On a machine that does not answer: "the machine does not answer", and
     * not a word about starting (which would wake nothing) or about no
     * kernel (it is there, with its variables). As 'busy' for a tab that does
     * not know the flag: it asks again, and the help comes with the link.
     */
    if (runtime && machineAway(runtime)) return { ...miss('busy'), unreachable: true }
    const phase = runtime?.kernel?.phase ?? null
    // Already coming up, by its own question or by someone else's Run: there
    // will be an answer, but not this one. We say "in a few seconds", not "no
    // kernel".
    if (runtime?.starting || phase === 'starting' || phase === 'restarting') return miss('starting')
    if (help.mayWake === true) {
      wakeKernel(sessionId, root)
      return miss('starting')
    }
    return miss('no-kernel')
  }
  /*
   * Busy: we say so at once, without waiting out our two and a half seconds.
   *
   * The server knows about being busy even without the kernel: this notebook's
   * scope has its own queue and its own running cell. There is nothing to wait
   * for in this case (ipykernel's shell is single and sequential), and two and a
   * half seconds of silence on a mouse hover read as "the hint is broken".
   *
   * A NEIGHBOURING notebook being busy does not get in the way of help, and that
   * follows from there now being as many kernels as notebooks: the queue and
   * the cell are asked of the scope (`peekRuntime(sessionId, root)`), not of the
   * class. While the lecture computes, help in a student's personal notebook
   * answers as if nothing were happening.
   */
  if (kernel.phase === 'busy' || runtime?.currentCell || (runtime?.queue.length ?? 0) > 0) {
    return miss('busy')
  }
  try {
    const live = await kernel.inspect(code, cursor, 0, helpPadOf(runtime, kernel))
    if (live.found && live.text !== null && live.text !== '') {
      /*
       * About a module the live kernel says nothing.
       *
       * `Type: module`, the object's address in memory and `<no docstring>`:
       * exactly what the teacher saw on 21 Sep 2026 for pandas and seaborn (the
       * first assembles its docstring at runtime, the second has none at all).
       * Everything substantial about the package lies next to it on disk, and
       * it is fetched by a second short question to the same helper. If that
       * fails, we return it as is: the addition is optional, and the answer
       * without it is worse but not broken.
       */
      if (looksLikeModule(live.text) && runtime) {
        const extra = await moduleFacts(runtime, nameChainAt(code, cursor))
        return { found: true, text: withModuleFacts(live.text, extra), reason: null }
      }
      return { found: true, text: live.text, reason: null }
    }
  } catch {
    // The kernel got busy between the check and the question: a usual seminar race.
    return miss('busy')
  }
  return runtime ? await inspectStatically(runtime, code, cursor, help.header ?? '') : miss('unknown')
}

/**
 * How long we wait for the line about a value: four hundred milliseconds.
 *
 * This is the cheapest question of all: the object is already in the kernel's
 * memory, it is asked for its type and size (measured on a live kernel:
 * 0.01–0.05 ms per answer). Anything that does not fit in this time means a
 * busy kernel, not a long answer, and then there simply will be no line: about
 * a variable there is either an instant answer or silence.
 */
const BRIEF_WAIT_MS = 400

/**
 * What this value is, in one line, without help and without bringing the
 * kernel up.
 *
 * "Small pop-up hints would be interesting to see: at least the data type of a
 * variable, a quick type and the dimensions" was the owner's request of
 * 21 Sep 2026, and its second half matters no less than the first: "it also
 * added a whole wagon of more detailed text there, that is not much fun". So
 * there is no `inspect_request` here, no jedi and no second path: `null`, and
 * the client stays silent.
 *
 * The kernel is NEVER brought up: until it exists there is nothing to say about
 * a variable; it appears only after a cell is run.
 */
export async function briefIn(
  sessionId: string,
  expr: string,
  root: string = CELLS_KEY,
): Promise<BriefValue | null> {
  if (expr === '') return null
  const runtime = peekRuntime(sessionId, root) ?? null
  const kernel = liveKernel(sessionId, root)
  if (!runtime || !kernel || kernel.phase !== 'idle') return null
  // A busy kernel will not answer, and a line is not worth waiting for it.
  if (runtime.currentCell || runtime.queue.length > 0) return null
  let raw: unknown = null
  try {
    const status = await withinWait(
      kernel.execute(
        inspectBriefSource(expr),
        {
          ...SILENT_HANDLERS,
          onUserExpressions: (values) => {
            raw = values[INSPECT_REPORT_KEY]
          },
        },
        {
          silent: true,
          storeHistory: false,
          // A mouse hover is not a room event: the kernel indicator does not blink.
          quiet: true,
          userExpressions: { [INSPECT_REPORT_KEY]: INSPECT_REPORT_EXPR },
        },
      ),
      BRIEF_WAIT_MS + helpPadOf(runtime, kernel),
    )
    if (status !== 'ok') return null
  } catch {
    return null
  }
  return parseBrief(raw)
}

/**
 * How long we wait for the package addition: half a second and not a moment
 * more.
 *
 * This is reading files next to the package (dist-info), not parsing sources:
 * the "module → distribution" map is built once per kernel (84 ms on the
 * colloq-kernel:base image), and after that a question costs a few
 * milliseconds. The addition is optional, and the kernel's shell is shared:
 * waiting longer for it would delay someone else's Run for the sake of a
 * "Docs: …" line.
 */
const MODULE_FACTS_WAIT_MS = 500

/**
 * The package name, its version and documentation link, for a LIVE module.
 *
 * An empty string is no trouble: the kernel's answer goes as is. By the same
 * quiet run as the static analysis (`quiet: true`), i.e. the room's kernel
 * indicator does not blink.
 */
async function moduleFacts(runtime: Runtime, expr: string): Promise<string> {
  const kernel = runtime.kernel
  if (!kernel || expr === '' || kernel.phase !== 'idle') return ''
  if (runtime.currentCell || runtime.queue.length > 0) return ''
  let raw: unknown = null
  try {
    const status = await withinWait(
      kernel.execute(
        inspectFactsSource(expr),
        {
          ...SILENT_HANDLERS,
          onUserExpressions: (values) => {
            raw = values[INSPECT_REPORT_KEY]
          },
        },
        {
          silent: true,
          storeHistory: false,
          quiet: true,
          userExpressions: { [INSPECT_REPORT_KEY]: INSPECT_REPORT_EXPR },
        },
      ),
      MODULE_FACTS_WAIT_MS + helpPadOf(runtime, kernel),
    )
    if (status !== 'ok') return ''
  } catch {
    return ''
  }
  const answer = parseStaticInspect(raw)
  return answer?.found && answer.text !== null ? answer.text : ''
}

/**
 * How long we wait for a SERVICE run's answer before deciding there will be
 * none.
 *
 * The jedi budget plus a second for the road. The alarm sits inside Python
 * (inspect-static.ts · `_arm`), and in ordinary life it fires first; this
 * ceiling is for the case when the signal did not arrive at all (the kernel
 * computes in another thread, the kernel is not ipykernel). The promise has to
 * resolve in any of them.
 */
const STATIC_INSPECT_WAIT_MS = Math.round(INSPECT_BUDGET_SEC * 1000) + 1000

/**
 * The second path: the same name, read by jedi from the sources, without a
 * single run.
 *
 * Only on this notebook's FREE kernel. This is a real `execute_request`, and
 * were it to queue behind someone else's cell, the suggestion would arrive a
 * minute later, and in that time the kernel would belong to a hovering mouse,
 * not to the class. The scope arrives here whole, so its own queue is what is
 * asked.
 */
async function inspectStatically(
  runtime: Runtime,
  code: string,
  cursor: number,
  header: string,
): Promise<InspectAnswer> {
  const kernel = runtime.kernel
  if (!kernel || kernel.phase !== 'idle') return miss('busy')
  if (runtime.currentCell || runtime.queue.length > 0) return miss('busy')
  let raw: unknown = null
  try {
    const status = await withinWait(
      kernel.execute(
        inspectStaticSource({ code, cursor, header }),
        {
          ...SILENT_HANDLERS,
          onUserExpressions: (values) => {
            raw = values[INSPECT_REPORT_KEY]
          },
        },
        {
          silent: true,
          storeHistory: false,
          // The room has no need to know about this: the kernel indicator does
          // not blink; see jupyter.ts · `Pending.quiet`.
          quiet: true,
          userExpressions: { [INSPECT_REPORT_KEY]: INSPECT_REPORT_EXPR },
        },
      ),
      STATIC_INSPECT_WAIT_MS + helpPadOf(runtime, kernel),
    )
    // No answer in the allotted time: further waiting is the client's job, not ours.
    if (status !== 'ok') return miss('thinking')
  } catch {
    return miss('unknown')
  }
  const answer = parseStaticInspect(raw)
  if (answer?.found && answer.text !== null) return { found: true, text: answer.text, reason: null }
  /*
   * Not making it is not "I do not know".
   *
   * The first analysis of a heavy library on a cold container costs seconds
   * (pandas ~1.5 s), and the second milliseconds: jedi puts the analysis into
   * its cache. Answering "nothing to say" to that would mean lying exactly where
   * the answer was half a step away, which is what people came with on
   * 20 Sep 2026. We say "still thinking", and the client asks again by itself
   * (protocol.ts · InspectMiss.thinking).
   */
  return miss(answer?.why === 'timeout' ? 'thinking' : 'unknown')
}

/** The test backend's completion: a few pandas names and nothing more. */
function cannedComplete(code: string, cursor: number): CompleteResult {
  const before = code.slice(0, cursor)
  // The word the person has already started, and the dot before it: exactly
  // what the real kernel answer uses to decide where the replaced piece starts.
  const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before)?.[0] ?? ''
  const start = cursor - word.length
  const attribute = before[start - 1] === '.'
  const names = attribute
    ? ['head', 'tail', 'describe', 'shape', 'columns']
    : ['print', 'pandas', 'property']
  return {
    matches: names
      .filter((name) => name.startsWith(word))
      .map((name) => ({
        text: name,
        type: name === 'shape' || name === 'columns' ? 'instance' : 'function',
      })),
    cursorStart: start,
    cursorEnd: cursor,
  }
}

/**
 * The test backend's long help: a real seaborn answer, as is.
 *
 * It is here for two things that are not checked by a short answer at all:
 * scrolling inside the window, and a long signature not hiding the
 * documentation. `sns.lmplot` has forty-odd parameters, i.e. a signature
 * longer than the whole window, and that is exactly where the hint broke in the
 * class of 19 Sep 2026, when it showed the first six lines.
 *
 * The text was taken from a live kernel (`colloq-kernel:base`, seaborn 0.13.2)
 * and cut at a section boundary; `File:` and `Type:` were added so that the
 * parser sees them too.
 */
const CANNED_LONG = `Signature:
sns.lmplot(
    data,
    *,
    x=None,
    y=None,
    hue=None,
    col=None,
    row=None,
    palette=None,
    col_wrap=None,
    height=5,
    aspect=1,
    markers='o',
    sharex=None,
    sharey=None,
    hue_order=None,
    col_order=None,
    row_order=None,
    legend=True,
    legend_out=None,
    x_estimator=None,
    x_bins=None,
    x_ci='ci',
    scatter=True,
    fit_reg=True,
    ci=95,
    n_boot=1000,
    units=None,
    seed=None,
    order=1,
    logistic=False,
    lowess=False,
    robust=False,
    logx=False,
    x_partial=None,
    y_partial=None,
    truncate=True,
    x_jitter=None,
    y_jitter=None,
    scatter_kws=None,
    line_kws=None,
    facet_kws=None,
)
Docstring:
Plot data and regression model fits across a FacetGrid.

This function combines :func:\`regplot\` and :class:\`FacetGrid\`. It is
intended as a convenient interface to fit regression models across
conditional subsets of a dataset.

When thinking about how to assign variables to different facets, a general
rule is that it makes sense to use \`\`hue\`\` for the most important
comparison, followed by \`\`col\`\` and \`\`row\`\`. However, always think about
your particular dataset and the goals of the visualization you are
creating.

There are a number of mutually exclusive options for estimating the
regression model. See the :ref:\`tutorial <regression_tutorial>\` for more
information.

The parameters to this function span most of the options in
:class:\`FacetGrid\`, although there may be occasional cases where you will
want to use that class and :func:\`regplot\` directly.

Parameters
----------
data : DataFrame
    Tidy ("long-form") dataframe where each column is a variable and each
    row is an observation.
x, y : strings, optional
    Input variables; these should be column names in \`\`data\`\`.
hue, col, row : strings
    Variables that define subsets of the data, which will be drawn on
    separate facets in the grid. See the \`\`*_order\`\` parameters to control
    the order of levels of this variable.
palette : palette name, list, or dict
    Colors to use for the different levels of the \`\`hue\`\` variable. Should
    be something that can be interpreted by :func:\`color_palette\`, or a
    dictionary mapping hue levels to matplotlib colors.
col_wrap : int
    "Wrap" the column variable at this width, so that the column facets
    span multiple rows. Incompatible with a \`\`row\`\` facet.
height : scalar
    Height (in inches) of each facet. See also: \`\`aspect\`\`.
aspect : scalar
    Aspect ratio of each facet, so that \`\`aspect * height\`\` gives the width
    of each facet in inches.
markers : matplotlib marker code or list of marker codes, optional
    Markers for the scatterplot. If a list, each marker in the list will be
    used for each level of the \`\`hue\`\` variable.
share{x,y} : bool, 'col', or 'row' optional
    If true, the facets will share y axes across columns and/or x axes
    across rows.

    .. deprecated:: 0.12.0
        Pass using the \`facet_kws\` dictionary.

{hue,col,row}_order : lists, optional
    Order for the levels of the faceting variables. By default, this will
    be the order that the levels appear in \`\`data\`\` or, if the variables
    are pandas categoricals, the category order.
legend : bool, optional
    If \`\`True\`\` and there is a \`\`hue\`\` variable, add a legend.
legend_out : bool
    If \`\`True\`\`, the figure size will be extended, and the legend will be
    drawn outside the plot on the center right.

    .. deprecated:: 0.12.0
        Pass using the \`facet_kws\` dictionary.

x_estimator : callable that maps vector -> scalar, optional
    Apply this function to each unique value of \`\`x\`\` and plot the
    resulting estimate. This is useful when \`\`x\`\` is a discrete variable.
    If \`\`x_ci\`\` is given, this estimate will be bootstrapped and a
    confidence interval will be drawn.
x_bins : int or vector, optional
    Bin the \`\`x\`\` variable into discrete bins and then estimate the central
    tendency and a confidence interval. This binning only influences how
    the scatterplot is drawn; the regression is still fit to the original
    data.  This parameter is interpreted either as the number of
    evenly-sized (not necessary spaced) bins or the positions of the bin
    centers. When this parameter is used, it implies that the default of
    \`\`x_estimator\`\` is \`\`numpy.mean\`\`.
x_ci : "ci", "sd", int in [0, 100] or None, optional
    Size of the confidence interval used when plotting a central tendency
File:      /usr/local/lib/python3.11/site-packages/seaborn/regression.py
Type:      function`

/**
 * The test backend's help: a signature recognisable by eye and in an
 * assertion.
 *
 * The name decides which answer comes, and that is not a whim: the test backend
 * has no kernel at all, yet both cases have to be checked: a short answer that
 * fits into the window whole, and a long one, which is what the window scrolls
 * for at all. Everything ending in `lmplot` answers with the long one.
 *
 * An empty name gives `unknown`, not silence: under the pointer there is a
 * space or a bracket, and that has to be said with the same word a live kernel
 * would use.
 */
function cannedInspect(code: string, cursor: number): InspectAnswer {
  const name = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(code.slice(0, cursor))?.[0] ?? ''
  if (!name) return miss('unknown')
  /*
   * Key names for refusal reasons. The test backend has no real reasons at all
   * (it has no kernel), yet FOUR lines have to be checked that a person sees
   * instead of help: "the kernel is starting", "the kernel is busy" and the
   * rest. Without this branch there would be no way to see them on a test
   * stand, and they would be checked only by reading the locales.
   */
  const staged = /(?:^|\.)zz_(starting|busy|nokernel|unknown)$/.exec(name)?.[1]
  if (staged) return miss(staged === 'nokernel' ? 'no-kernel' : (staged as InspectMiss))
  if (/(^|\.)lmplot$/.test(name)) return { found: true, text: CANNED_LONG, reason: null }
  return {
    found: true,
    text: `Signature: ${name}(n: int = 5)\nDocstring:\nReturn the first n rows.`,
    reason: null,
  }
}

/** Clear the input prompt on a cell, where there is nothing left to ask. */
function clearStdinOn(sessionId: string, cellId: string | null): void {
  if (!cellId) return
  const { doc } = getSessionDoc(sessionId)
  const target = findCell(doc, cellId)
  if (target?.cell.get('stdin')) doc.transact(() => target.cell.set('stdin', null), ORIGIN)
}

/**
 * Erase outputs.
 *
 * With a cell name, one cell's, whichever notebook it lies in. Without a name,
 * the WHOLE room's, not one notebook's: that is what the button is called, and
 * erasing half would be a promise it never made.
 */
export function clearOutputs(sessionId: string, cellId?: string, book?: string): void {
  const { doc } = getSessionDoc(sessionId)
  /*
   * A notebook is named: erase in it; not named: in the whole room.
   *
   * The "Clear" button stands in ONE notebook's toolbar and names it; a kernel
   * restart names nobody, because it takes away the variables of the whole room
   * at once.
   */
  const named = book ? cellsAt(doc, book) : null
  /*
   * A notebook named but not found is not "no notebook named".
   *
   * `null` here read as "in the whole room", and a miss by name (a frame from a
   * tab whose notebook had just been closed or renamed) erased the outputs of
   * ALL notebooks at once. control.ts now rejects frames with an unknown name
   * earlier; this is the second line of defence.
   */
  if (book && !named) return
  const cells = named
    ? named.toArray()
    : allCellArrays(doc).flatMap((array: Y.Array<YCell>) => array.toArray())
  doc.transact(() => {
    cells.forEach((cell: YCell) => {
      if (cellId && idOf(cell) !== cellId) return
      const outputs = cellOutputs(cell)
      if (outputs.length > 0) outputs.delete(0, outputs.length)
      const state = cell.get('state') as CellState | undefined
      // Leave queued and running cells alone; their state belongs to the queue.
      if (state === 'ok' || state === 'error') cell.set('state', 'idle' as CellState)
    })
  }, ORIGIN)
}

/**
 * Everything back to rest, except the cell the pump is handling at the moment.
 *
 * A restart cuts off execution, but the pump learns about it at its await and
 * finishes the cell itself: it writes KernelDied into it and sets the state. If
 * we went over it here, the state would land earlier, and the pump would write
 * its own on top, leaving the cell "running" in a room where nothing is
 * running.
 */
function resetAllCells(runtime: Runtime, except: string | null = null): void {
  // A pool's worker has no cells (and `bookCells` of its root would make an array of that name in the document).
  if (hidden(runtime)) return
  const { doc } = getSessionDoc(runtime.sessionId)
  /*
   * The cells of ONE notebook, the one whose kernel was restarted.
   *
   * This used to walk all of the room's notebooks, and that was true: there was
   * one kernel, and its restart took everyone's variables at once. Now each
   * notebook has its own process, and erasing execution numbers in a
   * neighbouring one would declare its results invalid exactly when they are
   * perfectly valid, because nobody touched its kernel.
   */
  const cells = bookCells(doc, runtime.root).toArray()
  doc.transact(() => {
    cells.forEach((cell: YCell) => {
      /*
       * The number is removed from all, the state not from all.
       *
       * The exception exists for the race: the cell the pump is handling now,
       * it will finish by itself, and touching its state from here means
       * getting "running" in a room where nothing is running. That does not
       * apply to the number: nobody will write it for this execution any more
       * (execute_input has already happened, and setCellState does not touch
       * the number), and the counter that issued it belongs to a kernel that no
       * longer exists.
       *
       * The exception used to cover the number too, and it came out worst of
       * all: after a restart forty results stayed on screen, while the only
       * verifiable fact about them, the execution number, disappeared silently.
       * Now nobody has a number, and the client says so in words.
       */
      cell.set('execCount', null)
      if (except && idOf(cell) === except) return
      cell.set('state', 'idle' as CellState)
      // And the stopwatch with it: the kernel that computed was restarted, and
      // the time of the previous execution belonged to it.
      cell.set('startedAt', null)
      cell.set('ranMs', null)
    })
  }, ORIGIN)
}

/* -------------------------------------------------------------- workspace */

export function onWorkspaceChanged(cb: (sessionId: string) => void): void {
  workspaceListeners.push(cb)
}

function notifyWorkspaceChanged(sessionId: string): void {
  for (const cb of [...workspaceListeners]) {
    try {
      cb(sessionId)
    } catch (err) {
      console.error(`[kernel] workspace listener failed for ${sessionId}:`, errText(err))
    }
  }
}

/**
 * The environment a room's kernel is actually running, or null when it has not
 * started one. Read by the panel: a seminar that was live through a switch is
 * still on the old image, and a column that showed the configured value would
 * be quietly wrong about exactly the case worth knowing.
 *
 * A class has one environment for all its notebooks: the image is chosen for a
 * container, not for a kernel. The room's notebook is asked first: it comes up
 * first and lives the longest, and the panel speaks about the class.
 */
export function environmentOf(sessionId: string): string | null {
  const scopes = scopesOf(sessionId)
  const main = scopes.find((scope) => scope.root === CELLS_KEY && scope.environment)
  return (main ?? scopes.find((scope) => scope.environment))?.environment ?? null
}
