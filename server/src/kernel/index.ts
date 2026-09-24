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
  rootOfCell,
  CELLS_KEY,
  KERNELS_KEY,
  KERNEL_QUEUE_FIELD,
  KERNEL_RUNNING_FIELD,
  legacyKernelStatus,
  KERNEL_STATUS_FIELD,
  type CellState,
  type KernelStatus,
  type YCell,
} from '@shared/notebook'
import { config } from '../config.js'
import { appendActivity } from '../activity.js'
import type { ActivityDetails, ActivityKind, ActivityOutcome } from '@shared/activity'
import { getParticipant, sessionEnvironment, storedRules } from '../db.js'
import { bookHasOwnKernel } from '@shared/rules'
import { activeName } from '../environments.js'
import { formatNotebook, type FormatOutcome } from './format.js'
import {
  dropOwnKernel,
  dropRoomKernel,
  endpointForSession,
  forgetSessionKernel,
  listRoomKernels,
  onRoomKernelRecreated,
  ownIdleMinutes,
  ownKernelMax,
  runningRoomKernels,
  OwnKernelUnavailable,
  type KernelRole,
} from './pool.js'
import { kernelBackend, RuntimeRequestError } from './runtime-client.js'
import { KERNEL_PROBLEM_KEY, type KernelProblem } from '@shared/kernel-problem'
import { explain as explainDeath, forgetKills, sampleKills } from './postmortem.js'
import { getSessionDoc, holdRoom, onlineCount, peekSessionDoc } from '../collab/index.js'
import { seldom } from '../log.js'
import { projectBooks } from '../collab/books.js'
import { flushSessionFiles } from '../collab/files.js'
import {
  JupyterKernel,
  type CompleteResult,
  type ExecuteStatus,
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
import type { BriefValue, CouncilRun, InspectMiss } from '@shared/protocol'
import { closeTerminal, terminalPhase } from './terminal.js'

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
}

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
}

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
  if (runtime.retired) return
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
  if (runtime.retired) return
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
  const { doc } = getSessionDoc(runtime.sessionId)
  const meta = getMeta(doc)
  const mirrored = runtime.root === CELLS_KEY
  // Council attempts do not go into the mirror: they have no cell the room
  // could highlight, and the "2 queued" chip is honest anyway: it is about the
  // sheet.
  const ids = runtime.queue.filter((item) => !item.council).map((item) => item.cellId)
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

/** What was computing at death: a phrase for the room, a cell for the post-mortem. */
interface DeathScene {
  /** "Kirill's attempt on cell 21" / "cell 21, run by Timur"; `null`: the kernel was idle. */
  what: string | null
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
  if (!cellId) return { what: null, cellId: null }
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
    return {
      cellId,
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
  if (runtime.retired) return
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
        `${scene.what ? ` · ${scene.what}` : ''}${again > 1 ? ` · ${again} in 10 min` : ''}`,
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
        `${scene.what ? ` · ${scene.what}` : ''}${again > 1 ? ` · ${again} in 10 min` : ''}`,
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
   */
  if (runtime.role === 'own') {
    const limit = ownKernelMax()
    const live = scopesOf(sessionId).filter(
      (scope) =>
        scope !== runtime && scope.role === 'own' && scope.kernel && scope.kernel.phase !== 'dead',
    ).length
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
    kernelNote(
      sessionId,
      envName
        ? tr("server.startingTheEnvironmentWaitingForTheKernel.df8f76", { p0: envName })
        : tr("server.waitingForTheKernelAtCellsCannot.8019bf", { p0: config.jupyter.url }),
    )
  }, SLOW_START_NOTICE_MS)

  runtime.starting = (async () => {
    setStatus(runtime, 'starting')
    // Read at the moment the kernel is built, not at the moment it is asked
    // for: that is the value the container will actually have.
    runtime.environment = envName
    if (dead) {
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
        // the map until the server restarts.
        await kernel.dispose().catch(() => {})
        return
      }
      runtime.kernel = kernel
      setKernelProblem(runtime, null)
      kernel.onPhaseChange((phase, expected) => onPhase(runtime, phase, expected))
      // Before anything of ours is sent: a kernel that is already busy is
      // finishing a cell for a server that no longer exists, and it would make
      // every Run in this room wait behind output nobody will ever see.
      if ((await kernel.releaseOrphanedWork()) && !runtime.retired) {
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
      setStatus(runtime, runtime.currentCell ? 'busy' : (kernel.phase as KernelStatus))
      // A kernel coming up is a real event: up to a minute and a half of cold
      // start, and it is exactly between this line and the next that the room
      // stares into emptiness.
      console.log(`[kernel ${sessionId}/${runtime.root}] up (${envName ?? 'shared'}, ${runtime.role})`)
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
       * for diagnostics needed an hour later.
       */
      void sampleKills(sessionId, runtime.role)
    } catch (err) {
      setStatus(runtime, 'dead')
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
      if (!runtime.retired) kernelNote(sessionId, errText(err))
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
export function kernelNote(sessionId: string, text: string): void {
  try {
    const { doc } = getSessionDoc(sessionId)
    doc.transact(() => {
      getTerminal(doc).push([createTerminalLine({ kind: 'system', text })])
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
  if (runtime.activityItem) runtime.activityItem.activityCancelled = true
  dropQueue(runtime)
  setStatus(runtime, 'restarting')

  runtime.restarting = (async () => {
    try {
      if (runtime.kernel && runtime.kernel.phase !== 'dead') await runtime.kernel.restart()
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
      resetAllCells(runtime, runtime.currentCell)
      setStatus(runtime, 'idle')
      kernelNote(
        sessionId,
        restartedBy
          ? tr("server.kernelRestartedByEveryVariableIsGone.3322fd", { p0: restartedBy })
          : tr("server.kernelRestartedEveryVariableIsGoneAnd.38530e"),
      )
    } catch (err) {
      // Never a rejection: the person clicked a button, the document carries the news.
      console.error(`[kernel] restart failed for ${sessionId}:`, errText(err))
      setStatus(runtime, 'dead')
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
): Promise<void> {
  const runtime = getRuntime(
    sessionId,
    cellId === undefined ? root : scopeOfCell(sessionId, cellId, root),
  )
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
  if (!runtime.kernel || runtime.kernel.phase === 'dead') return
  if (runtime.activityItem) runtime.activityItem.activityCancelled = true
  try {
    await runtime.kernel.interrupt()
  } catch (err) {
    console.error(`[kernel] interrupt failed for ${sessionId}/${runtime.root}:`, errText(err))
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
  // longer exists.
  const scopes = scopesOf(sessionId)
  runtimes.delete(sessionId)
  for (const runtime of scopes) {
    // First of all, before any await: a kernel start going on right now will
    // see this flag and will neither write into the document nor leave a
    // connected kernel behind.
    runtime.retired = true
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
async function retireScope(runtime: Runtime, note: string | null): Promise<void> {
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
  try {
    await runtime.kernel?.dispose()
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
  restCells(sessionId, root, touched)
  clearScopeMirror(sessionId, root)
  if (note) kernelNote(sessionId, note)
  // The personal notebooks container is kept while it has at least one kernel.
  if (runtime.role === 'own') await dropOwnIfEmpty(sessionId)
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

/** No personal kernels left: the personal notebooks container has no reason to stay. */
async function dropOwnIfEmpty(sessionId: string): Promise<void> {
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
    if (scope.retired) continue
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
 * How long a room's container lives after everyone has left.
 *
 * A class lasts an hour and a half; two hours of an empty room mean "the class
 * is over", not "the teacher went out for coffee". Previously no cleanup was
 * needed at all: there was one container per environment serving everyone. Now
 * there are TWO per seminar (its own and the one where students' personal
 * notebooks compute), and without cleanup the machine piles up a pair for every
 * class ever held. They go together: the class ended as a whole, not by half.
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
const SWEEP_EVERY_MS = 10 * 60 * 1000

/** When someone was last in the room. */
const lastOccupied = new Map<string, number>()

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
}): 'busy' | 'watch' | 'drop' {
  if (opts.busy) return 'busy'
  if (opts.since === undefined) return 'watch'
  const limit = opts.running ? IDLE_KERNEL_MS : IDLE_STOPPED_KERNEL_MS
  return opts.now - opts.since < limit ? 'watch' : 'drop'
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
  for (const room of await listRoomKernels()) rooms.set(room.session, room.running)
  for (const [sessionId, running] of rooms) {
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
    const busy =
      onlineCount(sessionId) > 0 ||
      scopes.some((scope) => scope.currentCell !== null || scope.queue.length > 0) ||
      terminalPhase(sessionId) === 'busy'
    const verdict = idleVerdict({ running, busy, since: lastOccupied.get(sessionId), now })
    if (verdict !== 'drop') {
      // A busy room is marked now; an empty one seen for the first time is also
      // marked now: the countdown starts from the first look, not from zero.
      if (verdict === 'busy' || !lastOccupied.has(sessionId)) lastOccupied.set(sessionId, now)
      continue
    }
    try {
      await shutdownSession(sessionId)
      lastOccupied.delete(sessionId)
    } catch (err) {
      console.error(`[kernel] idle sweep failed for ${sessionId}:`, errText(err))
    }
  }
}

/*
 * `unref`: the timer must not keep the process alive: tests and one-off
 * scripts import this module and must be able to exit.
 */
setInterval(() => void sweepIdleKernels(), SWEEP_EVERY_MS).unref()

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
  const all = allScopes()
  runtimes.clear()
  // The sweep marks go along with the runtimes: the next process starts from a
  // clean slate, and its very first trigger must sweep for ghosts.
  orphanSweeps.clear()
  for (const runtime of all) {
    for (const item of runtime.queue) finishExecution(runtime, item, 'cancelled')
    runtime.queue.length = 0
    dropWriter(runtime)
    runtime.kernel?.detach()
  }
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
  const scopes = root === undefined ? scopesOf(sessionId) : [peekRuntime(sessionId, root)]
  return scopes.every(
    (scope) => scope === undefined || scope.queue.every((item) => item.runById === participantId),
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
      try {
        await ensureKernel(runtime.sessionId, runtime.root)
      } catch (err) {
        reportDeadKernel(runtime, errText(err))
        return
      }
      const item = runtime.queue.shift()
      if (!item) break
      if (item.council) await runCouncilOne(runtime, item, item.council)
      else await runOne(runtime, item)
      if (runtime.kernel && runtime.kernel.phase === 'dead') {
        dropQueue(runtime)
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
    const phase = runtime.kernel?.phase ?? 'dead'
    setStatus(runtime, phase === 'busy' ? 'idle' : (phase as KernelStatus))
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
    state = status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'idle'
    if (status === 'abort') {
      const phase = runtime.kernel?.phase
      if (phase === 'dead') {
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
    writer.error('KernelError', errText(err), [])
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
): Promise<{ report: CouncilIsolationReport | null; reason: string | null }> {
  let raw: unknown = null
  let reason: string | null = null
  try {
    const status = await runOnKernel(
      runtime,
      councilEnterSourceNow(),
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
  return { report, reason: report?.error ?? reason }
}

/**
 * Return the kernel to what it was, and learn what could not be returned.
 *
 * Unlike the entry, silence here decides nothing: the exit works by itself, and
 * the report is needed for one note in the attempt's output. Hence the
 * `quietly` logic: the kernel did not answer, and so be it.
 */
async function leaveCouncilIsolation(runtime: Runtime): Promise<CouncilLeftovers | null> {
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
  return parseCouncilLeftovers(raw)
}

/** A run's first frame: it is also the request, and its text is the job's. */
const queuedRun = (job: CouncilJob): CouncilRun => ({
  state: 'queued',
  outputs: [],
  execCount: null,
  ranMs: null,
  startedAt: Date.now(),
  by: job.by,
})

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
  const already = councilQueuePosition(sessionId, job.cellId, job.participantId)
  if (already !== null) {
    const id = councilQueueId(job.cellId, job.participantId)
    const index = runtime.queue.findIndex((item) => item.cellId === id)
    const waiting = index < 0 ? null : runtime.queue[index]
    if (!waiting || waiting.council?.source === job.source) {
      return { queued: false, position: already }
    }
    // The "queued" frame goes out for the NEW job: it also moves the text
    // fingerprint by which recordRun decides whose output counts as its own.
    finishExecution(runtime, waiting, 'cancelled')
    const replacement: QueueItem = { ...waiting, runBy, runById, council: job, activityFinished: false, activityCancelled: false, activitySeq: null }
    replacement.activitySeq = executionActivity(runtime, replacement, 'execution.queued', { count: 1 })
    runtime.queue[index] = replacement
    tellJob(job, queuedRun(job))
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
  }
  item.activitySeq = executionActivity(runtime, item, 'execution.queued', { count: 1 })
  runtime.queue.push(item)
  const position = councilQueuePosition(sessionId, job.cellId, job.participantId) ?? 1
  tellJob(job, queuedRun(job))
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
  if (index < 0) return null
  return index + 1 + (runtime.currentCell ? 1 : 0)
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
  if (!runtime) return false
  const id = councilQueueId(cellId, participantId)
  if (runtime.currentCell === id) return false
  const index = runtime.queue.findIndex((item) => item.cellId === id)
  if (index < 0) return false
  const [dropped] = runtime.queue.splice(index, 1)
  releaseCouncil(runtime, [dropped])
  syncQueue(runtime)
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
  const interrupt = interruptSession(runtime.sessionId, item.cellId, runtime.root)
  const prior = runtime.beforeNext
  const barrier = prior ? Promise.all([prior, interrupt]).then(() => {}) : interrupt
  runtime.beforeNext = barrier
  void barrier.then(() => {
    if (runtime.beforeNext === barrier) runtime.beforeNext = null
  })
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
  if (!runtime) return null
  const id = councilQueueId(cellId, participantId)
  if (runtime.currentCell === id) return 0
  const index = runtime.queue.findIndex((item) => item.cellId === id)
  if (index < 0) return null
  return index + 1 + (runtime.currentCell ? 1 : 0)
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
): { busy: KernelBusy | null; queued: number } | null {
  const runtime = councilScope(sessionId, cellId)
  if (!runtime) return null
  // The queue length is ALL of it: both cells and attempts of any cells of this
  // notebook. There is one queue, and the student will have to wait for
  // everyone in it.
  const queued = runtime.queue.length
  const active = runtime.job
  const limit = runtime.limit
  if (active) {
    return {
      queued,
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
  if (!current) return { busy: null, queued }
  return {
    queued,
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
    for (const item of runtime.queue) {
      if (item.council)
        out.push({ cellId: item.council.cellId, participantId: item.council.participantId })
    }
  }
  return out
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
  runtime.limit = { item, startedAt, sec, timer: null, firedSec: null, interrupts: 0, stuck: false }
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
  if (limit.sec !== null) limit.firedSec = limit.sec
  limit.interrupts += 1
  stopRunningItem(runtime, limit.item)
  if (limit.interrupts < 2) {
    limit.timer = setTimeout(() => {
      limit.timer = null
      fireLimit(runtime, limit)
    }, LIMIT_RETRY_TICKS * limitTickMs)
    limit.timer.unref?.()
    return
  }
  /*
   * The second signal went out. After the same five "seconds" we check whether
   * it took: work that is still computing by then will never stop, and the
   * notebook's queue will not move behind it. The check is deferred rather than
   * right after, because `interrupt` goes over HTTP and does not answer
   * instantly: declaring the kernel deaf in the same millisecond would slander
   * half of the normal stops.
   */
  const check = setTimeout(() => {
    if (runtime.limit !== limit || limit.stuck) return
    limit.stuck = true
    tellQueueWatchers(runtime)
    kernelNote(runtime.sessionId, tr('server.kernel.deafToInterrupt'))
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
  if (!runtime) return
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
    run: { state: 'running', outputs: [], execCount: null, ranMs: null, startedAt, by: job.by },
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

  if (job.source.trim().length === 0) {
    finishCouncil(runtime, active, 'ok')
    return
  }

  flushToDisk(runtime.sessionId)
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
  // The attempt's personal data copies. See councilEnterSourceNow.
  const { report, reason } = await enterCouncilIsolation(runtime)
  let starved = false
  try {
    if (!report?.ok) {
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
      buffer.error('', councilEnterRefusal(reason), [])
      state = 'error'
      return
    }
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
    if (status === 'abort' && !buffer.hasError) {
      const phase = runtime.kernel?.phase
      if (phase === 'dead') buffer.error('KernelDied', deadMessage(), [])
      else if (phase === 'restarting' && runtime.kernel?.phaseExpected === false) {
        buffer.error('KernelDied', killedMessage(), [])
      } else buffer.error('Interrupted', tr("server.theAttemptWasInterrupted.4f4edf"), [])
    }
  } catch (err) {
    buffer.error('KernelError', errText(err), [])
    state = 'error'
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
     */
    const leftovers = await leaveCouncilIsolation(runtime)
    // Notes at the tail of the output: why memory ran short and what was left
    // running. Both come after the attempt's code, because both are about its
    // consequences.
    if (starved) buffer.stream('stderr', councilMemoryNote(report?.memory ?? null))
    for (const note of councilLeftoverNotes(leftovers)) buffer.stream('stderr', note)
    finishCouncil(runtime, active, state)
    // The attempt may have written a file: the files panel cares about that too.
    notifyWorkspaceChanged(runtime.sessionId)
  }
}

/** A kernel that will not come up is an output on the cell, never a crash. */
function reportDeadKernel(runtime: Runtime, message: string): void {
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
    setStatus(runtime, 'dead')
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
    setStatus(runtime, 'dead')
    return
  }
  const { doc } = getSessionDoc(runtime.sessionId)
  const stuck = runtime.currentCell ?? runtime.queue[0]?.cellId ?? null
  if (stuck) {
    const writer = runtime.writer ?? new OutputWriter(doc, stuck)
    writer.error('KernelError', message, [])
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
    setCellState(runtime.sessionId, stuck, 'error')
  }
  dropQueue(runtime)
  setStatus(runtime, 'dead')
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
    kernelNote(
      runtime.sessionId,
      tr("server.theCellThatWasRunningWasDeleted.ec6ea8"),
    )
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
  const kernel = peekRuntime(sessionId, root)?.kernel ?? null
  if (!kernel) return null
  return kernel.phase === 'dead' || kernel.phase === 'restarting' || kernel.phase === 'starting'
    ? null
    : kernel
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
  /*
   * The test backend has no kernel at all (KERNEL_BACKEND=test, JUPYTER_URL
   * points at a dead port), yet the whole path has to be checked, from the
   * console frame to the frame back. The prepared answer is this backend's
   * "kernel": the same set pandas gives on `df.`, so that the test speaks about
   * the real case rather than an empty list.
   */
  if (kernelBackend() === 'test') return cannedComplete(code, cursor)
  const kernel = liveKernel(sessionId, root)
  if (!kernel) {
    // The very first dot typed brings up a Python for this notebook; see
    // `wakeKernel`. This question has nothing to answer with, but the next one
    // will.
    if (opts.mayWake === true) wakeKernel(sessionId, root)
    return null
  }
  try {
    return await kernel.complete(code, cursor)
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
    const live = await kernel.inspect(code, cursor)
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
    const status = await Promise.race([
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
      new Promise<'abort'>((resolve) => {
        const timer = setTimeout(() => resolve('abort'), BRIEF_WAIT_MS)
        timer.unref?.()
      }),
    ])
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
    const status = await Promise.race([
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
      new Promise<'abort'>((resolve) => {
        const timer = setTimeout(() => resolve('abort'), MODULE_FACTS_WAIT_MS)
        timer.unref?.()
      }),
    ])
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
    const status = await Promise.race([
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
      new Promise<'abort'>((resolve) => {
        const timer = setTimeout(() => resolve('abort'), STATIC_INSPECT_WAIT_MS)
        timer.unref?.()
      }),
    ])
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
