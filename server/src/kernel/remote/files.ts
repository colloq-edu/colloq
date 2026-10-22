/**
 * A class folder on a machine, at home («занятия на машинах»,
 * docs/architecture/remote-classes.md §8): what this server pushes to the
 * machine's copy, what it takes back from it, and what the room's panel shows
 * of a file that lives there.
 *
 * HOME IS THE TRUTH. This server's folder (workspace.ts) is the class's; a
 * machine holds a copy at <state>/rooms/<id> for the class's containers there,
 * and everything about the copy comes and goes on the 0.23 sync's `kernels`
 * block (shared/remote-kernels.ts): pushes and verdicts and pulls in replies,
 * reports and acks in syncs, and the bytes of larger files by their own doors
 * (GET blobs/<sha256> with the `room` source, PUT rooms/:id/files). Nothing
 * of it is a remote call: a lost reply is a delay, as with leases.
 *
 * HOME → MACHINE: THE BARRIER (§8.2). Every writer of this server forgets the
 * tree when it writes (workspace.ts · treeEpochOf), so a Run with nothing
 * written since the copy's last push was acked, and a walk at most
 * FRESH_WALK_MS old, passes on a compare of two numbers: no walk, no round
 * trip. Otherwise a stat walk of the folder (hashes kept by stat) is diffed
 * against what the copy acked: removes, moves (a removed and an added path
 * with one sha), puts inline up to CLASS_INLINE_BYTES or as blobs, folders —
 * and the run waits for the ack while bytes keep moving, at most
 * CLASS_BARRIER_MS and never CLASS_BARRIER_STALL_MS without progress. A push
 * also goes by itself shortly after any write here (EAGER_PUSH_MS), so that a
 * Run usually finds it acked; the room's own notebook files, which every
 * run's outputs rewrite, go only that way, never on a run's path. A council
 * pool's attempt, which computes on its epoch, goes at once whenever they
 * are all the machine lacks (notebooksAlone, 0.26.1).
 *
 * HOME ← MACHINE: THE PULL BARRIER (§8.7). filesSettled asks every machine of
 * the class that still calls for a scan, and waits until it had its time to
 * answer, the machine says nothing of the class is pending there, and every
 * file the answer pulled has landed: before the class-end page, a page
 * build, the oracle's report of a script, a download or a move of a file on
 * its way.
 *
 * ONE PUSH IN FLIGHT IS SENT AT A TIME, AND A NEWER ONE SUPERSEDES IT. Every
 * reply carries a copy's newest unacked push until a sync says the copy
 * applied it (`files.pushSeq` of the class's held placements). A push made
 * while another is unacked is planned against everything the copy may hold
 * by now — what it acked, and what any unacked push put there — so its puts
 * and removes are whole and repeatable on top of a half-applied one, and it
 * carries no move (a move is not repeatable): moves go only in a push planned
 * on a copy with nothing unacked.
 *
 * MACHINE → HOME: COMPARE-AND-SWAP ON THE BASE (§8.4). A reported change
 * applies only while this server's file is still what both sides last agreed
 * (the change's `base`; absent counts as null). Otherwise this server's
 * version stays: the machine's is kept as a conflict copy «name (с машины
 * 14-32).ext» within the caps, a delete made here holds, and the copy is
 * counted as holding what the machine has, so the next push puts this
 * server's version back. A notebook file of the room is refused and
 * projected again; a rename is a movePath with no upload; a file over
 * «Файл с машины — до» or the room's limit stays «на машине». Every write
 * lands through the anchored file system as a temporary name and a rename
 * (secure-files.ts), and the unchanged workspace hooks follow, debounced per
 * class. A machine's report is participant data: every path and type is
 * checked again here, and only the classes placed on that machine, at their
 * current gen, are reached by it (a report of an older gen is late: its
 * changes are refused, and named in the room when the class lost that gen
 * there, §8.8).
 *
 * WHAT HOME KNOWS OF A COPY LIVES IN MEMORY, as heard.ts keeps a machine's
 * sync: a new life of this server (heard.ts · remoteBootAt) starts over, and
 * rebuilds what each copy acked from the machine's paged full report, so
 * writes made while home was down are pulled (§8.4, §11.4). A copy whose
 * placements were all written in this life starts with a full push instead.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { formatNumber, getLocale, tr } from '@shared/i18n'
import { MAX_DEPTH, MAX_SEGMENT, MAX_SEGMENT_BYTES, baseOf, isInside, normalizePath, parentOf, segmentBytes } from '@shared/paths'
import type { FileEntry } from '@shared/protocol'
import {
  CLASS_BARRIER_MS,
  CLASS_BARRIER_STALL_MS,
  CLASS_EVIDENCE_MS,
  CLASS_INLINE_BYTES,
  CLASS_INLINE_PUSH_BYTES,
  CLASS_LATE_MAX,
  CLASS_SYNC_FILES_MAX,
  REMOTE_DIR_BASE,
  REMOTE_PLACEMENTS_MAX,
  REMOTE_PUSH_PATHS_MAX,
  REMOTE_REPORT_PATHS_MAX,
  parseRemotePlacementKey,
  type RemoteFilesLag,
  type RemoteFilesPush,
  type RemoteFilesPut,
  type RemoteFilesReport,
  type RemoteKernelsReply,
  type RemoteKernelsRequest,
  type RemoteSkipReason,
  type RemoteVerdictReason,
} from '@shared/remote-kernels'
import { processClock, type TunnelClock } from '@shared/remote-tunnel'
import { machineFileLimitBytes, sessionLimitBytes } from '../../admin/resource-settings.js'
import { cachedSha256 } from '../../dependencies/files.js'
import { instanceTimeZone } from '../../time-zone.js'
import { heardAt, remoteBootAt, remoteNow } from '../../competitions/remote/heard.js'
import { wakeRunner } from '../../competitions/remote/wake.js'
import {
  forgetTree,
  freeName,
  movePath,
  onTreeForgotten,
  resolveInSession,
  sessionBytes,
  sessionDir,
  tempNameIn,
  treeEpochOf,
  useTreeOverlay,
  workspaceFs,
  type FileTree,
} from '../../workspace.js'
import type { RoomRole } from '../room-spec.js'
import { LIVE_PLACEMENT_STATES, classPlacementRows, hasLivePlacement, livePlacement, runnerPlacementRows, type PlacementRow } from './placement-store.js'

/* ---------------------------------------------------------------- numbers */

/** A walk this young, with nothing written here since, is the folder as it is: the barrier's fast path (§8.2). */
export const FRESH_WALK_MS = 10_000
/** A write here is pushed to the class's machines this long after the last of a burst: the editor saves every few seconds. */
const EAGER_PUSH_MS = 1_000
/** The workspace hooks after files from a machine landed, debounced per class (§8.3). */
const HOOKS_MS = 400
/** A settle finished this recently answers the next one at once: a page build right after the class end's own. */
const SETTLED_FRESH_MS = 2_000
/**
 * A scan home asked for is taken as answered this long after it went, with
 * a sync since and nothing pending there: the agent scans in its own time
 * (skipping the quiet rule, §8.3) and its report follows at once, but says
 * nothing when nothing changed.
 */
const SETTLE_QUIET_MS = 3_000
/** Files that stay on a machine shown in the room's tree, at most: past it the tree says it is incomplete. */
const OVERLAY_ROWS_MAX = 200
/** The name of a package tree's one row (FileEntry.kind 'packages'): hidden, so no file of the room can have it. */
export const PACKAGES_ROW = '.packages'
/** Notes of one kind said at most this often for one path in one class (the kernel log is the whole room's). */
const NOTE_AGAIN_MS = 10 * 60_000
/** A waiting run's «Файлы едут на машину…» changes at most this often: each change is a write to the shared document. */
const PROGRESS_EVERY_MS = 1_000
/** Notes of the class files in one room's kernel log, at most, within the window: what a machine reports never floods it. */
const NOTES_PER_CLASS = 30
const NOTES_WINDOW_MS = 10 * 60_000
/** Files a copy keeps as «на машине» at most: a walk's worth (what a machine says is held to what a machine can have). */
const ON_MACHINE_MAX = CLASS_SYNC_FILES_MAX
/** Conflict copies a copy remembers, by the original's path: a report said again is answered with the copy kept, never a second one. */
const KEPT_MAX = CLASS_SYNC_FILES_MAX
/** A barrier's push number while its files go with the push planned next: a rebuild's, the rest of a chain's, a copy begun again's. */
const NEXT_PUSH = Number.MAX_SAFE_INTEGER
/** Replies whose verdicts a machine has not said it took in, kept at most (heardReply): an agent that never says is one that says once. */
const UNHEARD_MAX = 8
/**
 * A pull of what a kernel wrote is let go when it was asked this long ago and
 * the machine says nothing of the class is pending there (dropStalePulls):
 * the agent says a change it has no verdict for again after a minute (its
 * verdict wait), so by then one it still means to send is still pending.
 */
const PULL_STALE_MS = 60_000

/* ------------------------------------------------------------------ types */

/** What a walk saw at a path: a folder, or a file with its content's sha256 and its size. */
interface Seen {
  sha: string
  bytes: number
}

/** One walk of this server's class folder (§8.2). */
interface Walk {
  /** On the files' clock. */
  at: number
  /** The tree's change counter read before the walk began. */
  epoch: number
  /** path → what is there: REMOTE_DIR_BASE for a folder, else the file's sha256. */
  entries: Map<string, Seen>
  /** Folders read whole: a path missing under one of them is gone; under any other, perhaps only past the ceiling. */
  listed: Set<string>
  truncated: boolean
  /** A digest of the entries: a push planned from an equal walk is the one a barrier waits for. */
  digest: string
}

/** One step of what a push does to the copy, in order: what the copy holds once it is applied. */
type Effect = { kind: 'remove'; path: string } | { kind: 'put'; path: string; sha: string }

interface Push {
  seq: number
  full: boolean
  promoted: boolean
  put: RemoteFilesPut[]
  remove: string[]
  move: { from: string; to: string }[]
  /** What the copy holds after it, step by step (a full push: exactly `target`). */
  effects: Effect[]
  /** The walk it was planned from. */
  digest: string
  /** Files it names by hash, as the blob door may serve them: sha256 → this server's path and size (a move's files too). */
  blobs: Map<string, { path: string; bytes: number }>
  /** Bytes of its files, inline and blob: the barrier's «из 150 МБ». */
  bytes: number
  /**
   * What the walk had that this push leaves to the next one: small files past
   * one reply's inline budget (CLASS_INLINE_PUSH_BYTES), which wait for the
   * next push rather than go as a GET each, and whatever is past
   * REMOTE_PUSH_PATHS_MAX. Null — the push makes the copy the walk. A run at
   * the barrier waits for the last push of such a chain.
   */
  rest: { files: number; bytes: number } | null
  /** When it was planned: a reply carries the pushes of its classes a promoted one first, then the oldest. */
  plannedAt: number
  /** Whether a reply carried it yet. */
  sent: boolean
}

/** A file this server asked the machine to send (RemoteKernelsReply.pulls). */
interface Pull {
  path: string
  /** The version asked for; null for «Привезти» of a file the machine left unhashed (over a cap): the file as it is, its PUT saying which. */
  sha256: string | null
  bytes: number
  /** The base the change was reported against (§8.4): checked again when the bytes land. */
  base: string | null
  /** The report it came in, whose verdict says what became of it. */
  seq: number
  /** Where the bytes go: the path itself, or the conflict copy this server keeps of the machine's version. */
  target: string
  /** «Привезти»: allowed over «Файл с машины — до», within the room's limit. */
  fetch: boolean
  /** When it was asked: the room's «на машине» row says it is on its way. */
  at: number
}

/**
 * A verdict of one report, waiting for the next reply. Said once, and again
 * only when the machine says it never took in the reply that carried it
 * (heardReply); an agent that says nothing of it heals a lost one by
 * reporting the path again, a minute on.
 */
interface Verdict {
  sessionId: string
  seq: number
  accepted: string[]
  refused: { path: string; why: RemoteVerdictReason; copy?: string }[]
}

/** A file the machine holds and this server does not, or holds a newer version of than this server's. */
interface OnMachine {
  bytes: number
  why: RemoteSkipReason
  /** Known for a file this server refused for a cap: what «Привезти» asks the machine for. */
  sha256: string | null
  /** The base that refused change was reported against: what «Привезти» lands on, replacing this server's file while it is still that. */
  base: string | null
  /** The report that named it. */
  seq: number
  at: number
}

/** A conflict copy kept of the machine's version of a path (§8.4): what a report of the same change said again is answered with. */
interface Kept {
  sha: string
  base: string | null
  /** The copy's name; null — it fitted no cap, and none was kept. */
  name: string | null
  /** Reports of it whose verdict waits for the copy's bytes (a pull): the machine keeps its version until they landed. */
  seqs: number[]
}

/** What a run tells the barrier (ClassFiles#filesBarrier). */
export interface BarrierOptions {
  /** Hears what is on its way to the machine (movingWords) while the run waits. */
  onProgress?: (words: string) => void
  /** The run was stopped (kernel/index.ts · interruptScope): its wait ends at once. */
  signal?: AbortSignal
  /** A council pool's attempt (§9.6, 0.26.1): no change of the room's live notebooks holds it (notebooksAlone). */
  notebooksAside?: boolean
}

/** A run waiting at the barrier (§8.2). */
interface BarrierWaiter {
  /** The push whose ack, or any later one's, lets it go; NEXT_PUSH — the one planned next. */
  seq: number
  startedAt: number
  progressAt: number
  stall: unknown
  total: unknown
  /** Bytes of the pushes it waited for that the machine applied, and what it waits for in all as far as known: the words over a chain. */
  doneBytes: number
  chainBytes: number
  onProgress?: (words: string) => void
  /** What it was last told, and when: the words go again only when they change, and not more often than PROGRESS_EVERY_MS. */
  told: string | null
  toldAt: number | null
  /** Stop listening to the run's stop (filesBarrier's `signal`). */
  unlisten: (() => void) | null
  resolve(): void
  reject(error: Error): void
}

/** A settle waiting for the machine's scan (§8.7). */
interface SettleWaiter {
  /** When it was asked: only a scan that went out after this answers it. */
  askedAt: number
  /** When the first such scan went out in a reply; null — not yet. */
  scanAt: number | null
  /** The newest push the machine had when that scan went out (the agent applies pushes before it scans), and when it was acked. */
  behind: number | null
  appliedAt: number | null
  resolve(settled: boolean): void
}

/** One class's folder copy on one machine, as this server knows it. */
interface Copy {
  sessionId: string
  runnerId: string
  /** What both sides agreed the copy holds: path → sha256 or REMOTE_DIR_BASE. Null until the machine's full report rebuilds it. */
  acked: Map<string, string> | null
  /** No push has been acked since the copy began: every push is full until one is. */
  fresh: boolean
  /** Unacked pushes, oldest first; a reply carries the newest. */
  pushes: Push[]
  /** The newest push number home used for the copy. */
  seq: number
  /** The pushSeq the machine last said it applied. */
  machineSeq: number
  /** The machine's own lag, as its held placements last said it (null: nothing pending there). */
  lag: RemoteFilesLag | null
  /** When the machine's last sync came, on the files' clock. */
  syncAt: number | null
  /** The newest gen a report of the copy came under: the gen a pull is asked with. */
  gen: number
  /**
   * The gens of the class's slots the copy serves, as replies name them (a
   * slot being stopped is named by none). Home naming the class there at none
   * of them is another life of the class to the agent, which keeps its files
   * but says no push applied until one of home's lands (runner-agent/
   * room-files.ts · reconcile): so is it here (restart).
   */
  gens: Partial<Record<RoomRole, number>>
  walk: Walk | null
  /**
   * A full report wanted (`scan.full` in replies until its page 0 comes), the
   * pages collected so far, and the last page of the walk last rebuilt from
   * (`done`): that page said again is no gap.
   */
  full: { wanted: boolean; pages: RemoteFilesReport[] | null; done: number | null }
  onMachine: Map<string, OnMachine>
  pulls: Map<string, Pull>
  /** Conflict copies kept of the machine's versions: copy's path → the original's path and when. */
  conflicts: Map<string, { of: string; at: number }>
  /** The same, by the original's path: the version each keeps, so that a change reported again is not kept twice. */
  kept: Map<string, Kept>
  /**
   * Versions brought with «Привезти», by path. The machine's own record of
   * what both sides agreed may lack such a file (it was one it left
   * unhashed), so its next change of it is reported with no base: a change
   * of the version brought, until a push of the path is acked.
   */
  fetched: Map<string, string>
  /** A plain scan asked of the machine; `sentAt` once a reply carried it. */
  scan: { wanted: boolean; sentAt: number | null }
  waiters: Set<BarrierWaiter>
  settles: Set<SettleWaiter>
  /** Reports and pulls are applied one at a time, in the order they came. */
  work: Promise<void>
  /** Blob bytes served for its pushes, and when they last moved. */
  served: number
  /** When the copy was last in step with this server: its newest push acked. */
  syncedAt: number | null
  /** An eager push is due (EAGER_PUSH_MS after a write). */
  eager: unknown
  /** What the copy holds differs from this server's in a way no write here will tell (a refusal, an eager push skipped): push once the one in flight is acked. */
  dirty: boolean
  /**
   * Rows only the machine has that staff deleted («на машине», Z6), by path:
   * a remove of each rides every push until one carrying it is acked, and
   * the row goes then — the machine has removed it — or when the machine
   * reports it gone first (`released`).
   */
  drops: Set<string>
}

/** What this module asks of the rest of the server: given as it loads (control.ts), a test's own otherwise. */
export interface FilesHooks {
  /** A line of the room's kernel log, which every participant reads: no machine's name in it. */
  note(sessionId: string, text: string): void
  /** The unchanged workspace hooks (kernel/index.ts · onWorkspaceChanged): the notebooks, the board, the files frame. */
  changed(sessionId: string): void
  /** Whether a path is one of the room's notebook files (collab/books.ts · isBookFile). */
  isBook(sessionId: string, path: string): boolean
  /** The room's notebooks to their files again (collab/books.ts · projectBooks). */
  reproject(sessionId: string): void
}

const QUIET_HOOKS: FilesHooks = {
  note: () => undefined,
  changed: (sessionId) => forgetTree(sessionId),
  isBook: () => false,
  reproject: () => undefined,
}

export interface ClassFilesOptions {
  /** The files' clock: the barrier's and the settle's timers, the walks' age. The process's by default. */
  clock?: TunnelClock
  log?: (line: string) => void
  /** Answer the machine's held sync early (wake.ts · wakeRunner by default). */
  wake?: (runnerId: string) => void
  hooks?: Partial<FilesHooks>
  /** The first push number of this life: above any a machine may have applied from an earlier one. The wall's milliseconds by default. */
  seqBase?: number
}

/**
 * A run refused at the barrier (§8.2): the files it needs did not reach the
 * machine. `words` are the room's (the cell's error), naming no machine.
 */
export class FilesStalled extends Error {
  constructor(readonly words: string) {
    super(words)
    this.name = 'FilesStalled'
  }
}

/**
 * Why the PUT door of a pulled file refuses it (upload.ts · receiveRoomFile
 * answers in the contract's codes): `stale` — the class's placement at that
 * gen is fenced (409, the agent drops it, §8.8); `unknown` — this server did
 * not ask for that version of that path (404); `over` — past its cap (413).
 */
export class PullRefused extends Error {
  constructor(
    readonly why: 'stale' | 'unknown' | 'over',
    message: string,
  ) {
    super(message)
    this.name = 'PullRefused'
  }
}

/** What a PUT of a pulled file is answered: the file as it landed, and what became of it. */
export interface RoomFileStored {
  path: string
  sha256: string
  bytes: number
  verdict: { accepted: true } | { accepted: false; why: RemoteVerdictReason; copy?: string }
}

const copyKey = (sessionId: string, runnerId: string): string => `${sessionId}\0${runnerId}`
const LIVE: ReadonlySet<string> = new Set(LIVE_PLACEMENT_STATES)

/* -------------------------------------------------------------- the words */

/** «14:32» or «14:32:05» in the instance's zone. */
function clockOf(at: number, seconds = false): string {
  try {
    return new Intl.DateTimeFormat(getLocale(), {
      timeZone: instanceTimeZone(),
      hour: '2-digit',
      minute: '2-digit',
      ...(seconds ? { second: '2-digit' as const } : {}),
      hourCycle: 'h23',
    }).format(at)
  } catch {
    return new Date(at).toISOString().slice(11, seconds ? 19 : 16)
  }
}

/** Bytes in the words the council already uses: «2,1 ГБ», «150 МБ», «12 КБ». */
export function sizeWords(bytes: number): string {
  const round = (value: number) => formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })
  if (bytes >= 1024 ** 3) return tr('server.council.sizeGb', { p0: round(bytes / 1024 ** 3) })
  if (bytes >= 1024 ** 2) return tr('server.council.sizeMb', { p0: round(bytes / 1024 ** 2) })
  return tr('server.council.sizeKb', { p0: round(Math.max(1, bytes) / 1024) })
}

/** «Файлы едут на машину: 12 из 150 МБ…»: the done part in the total's unit. */
export function movingWords(done: number, total: number): string {
  const unit = total >= 1024 ** 3 ? 1024 ** 3 : total >= 1024 ** 2 ? 1024 ** 2 : 1024
  const part = Math.min(done, total) / unit
  return tr('server.filesAreOnTheirWayToThe.1bb29d', { done: formatNumber(part, { maximumFractionDigits: part < 10 ? 1 : 0 }), total: sizeWords(total) })
}

/**
 * The conflict copy's name (§8.4): «out (с машины 14-32).csv» beside the
 * original, the time in the instance's zone with a hyphen (a colon is no
 * name for a file), a number after it when that one is taken, and the stem
 * cut short rather than the name refused for its length.
 */
export function conflictCopyName(sessionId: string, rel: string, at: number): string {
  const dir = parentOf(rel)
  const base = baseOf(rel)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  const time = clockOf(at).replace(':', '-')
  const room = MAX_SEGMENT - ext.length - tr('server.fromTheMachine.3b540b', { name: '', time }).length - 4
  let head = stem.slice(0, Math.max(1, room)).trimEnd()
  while (head.length > 1 && segmentBytes(`${tr('server.fromTheMachine.3b540b', { name: head, time })} 99${ext}`) > MAX_SEGMENT_BYTES) {
    head = Array.from(head).slice(0, -1).join('').trimEnd()
  }
  const name = `${tr('server.fromTheMachine.3b540b', { name: head, time })}${ext}`
  return freeName(sessionId, dir ? `${dir}/${name}` : name)
}

/* ------------------------------------------------------------- the class */

/**
 * The class folders on machines of this home. One per process (classFiles);
 * tests make their own, on their own clock, and install it with
 * useClassFiles.
 */
export class ClassFiles {
  readonly clock: TunnelClock
  private readonly log: (line: string) => void
  private readonly wake: (runnerId: string) => void
  private hooks: FilesHooks
  private readonly seqBase: number
  /** The number of the last reply sent to any machine (replySent): this life's first is above an earlier life's, as push numbers are. */
  private lastReply: number
  private readonly copies = new Map<string, Copy>()
  /** The server's life the copies belong to (heard.ts · remoteBootAt): another, and what was known of them is gone. */
  private life = remoteBootAt()
  /** Hashes of this server's files by stat, per class: a walk hashes only what changed. */
  private readonly digests = new Map<string, Map<string, { key: string; sha: string }>>()
  /** One walk of a class at a time, with the tree's counter as it began. */
  private readonly walking = new Map<string, { epoch: number; walk: Promise<Walk> }>()
  /** Late changes named in the room, once per machine, class and gen (§8.8). */
  private readonly told = new Set<string>()
  /**
   * The classes each machine held a copy of in this life: the only rooms a
   * returning machine's late list is named in. A late list is the machine's
   * word, and a machine's word reaches only the rooms it served (§8.6).
   */
  private readonly served = new Map<string, Set<string>>()
  /** Notes said per class lately (NOTES_PER_CLASS in NOTES_WINDOW_MS): a machine's reports never flood a room's kernel log. */
  private readonly noted = new Map<string, number[]>()
  /** Notes said, by class, kind and path: once while they stand. */
  private readonly notes = new Map<string, number>()
  /** The workspace hooks due per class (HOOKS_MS). */
  private readonly hooksDue = new Map<string, unknown>()
  /** When a settle of the class last settled (not one that gave up). */
  private readonly settledAt = new Map<string, number>()
  /** Work started in the background (an eager push, a rebuild's push): what whenIdle waits for. */
  private readonly background = new Set<Promise<unknown>>()
  private closed = false
  /** What it did, for the metrics and the tests: walks of a class folder, pushes planned, files pulled, changes applied, refused. */
  readonly counts = { walks: 0, pushes: 0, pulls: 0, applied: 0, refused: 0 }

  constructor(options: ClassFilesOptions = {}) {
    this.clock = options.clock ?? processClock
    this.log = options.log ?? ((line) => console.log(line))
    this.wake = options.wake ?? wakeRunner
    this.ownHooks = options.hooks ?? {}
    this.hooks = { ...QUIET_HOOKS, ...this.ownHooks }
    this.seqBase = options.seqBase ?? Date.now()
    this.lastReply = this.seqBase
  }

  /** The hooks this instance was made with: they outrank the server's (a test's own). */
  private readonly ownHooks: Partial<FilesHooks>

  /** The rest of the server, as control.ts hands it over (useFilesHooks): under the instance's own. */
  useHooks(hooks: Partial<FilesHooks>): void {
    this.hooks = { ...QUIET_HOOKS, ...hooks, ...this.ownHooks }
  }

  /** Pushes planned and not yet acked, every copy's together: what this server holds for machines that have not applied them. */
  unackedPushes(): number {
    let held = 0
    for (const copy of this.copies.values()) held += copy.pushes.length
    return held
  }

  /** For tests: once every report, pull and push started so far is done (they chain one another, so until none is left). */
  async whenIdle(): Promise<void> {
    for (let round = 0; round < 100; round++) {
      const work = [...[...this.copies.values()].map((copy) => copy.work), ...this.background]
      await Promise.all(work.map((one) => one.catch(() => undefined)))
      const after = [...[...this.copies.values()].map((copy) => copy.work), ...this.background]
      if (after.length === work.length && after.every((one, at) => one === work[at])) return
    }
  }

  /** Background work, kept for whenIdle until it ends. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.background.add(work)
    void work.catch(() => undefined).finally(() => this.background.delete(work))
    return work
  }

  /** Stop: every waiter goes (a barrier passes, a settle says no), every timer is cleared. */
  close(): void {
    this.closed = true
    for (const copy of [...this.copies.values()]) this.dropCopy(copy)
    for (const timer of this.hooksDue.values()) this.clock.clearTimeout(timer)
    this.hooksDue.clear()
  }

  /* ---------------------------------------------------------------- copies */

  /** A new life of the server: what was known of every copy belongs to the old one. */
  private live(): void {
    const life = remoteBootAt()
    if (life === this.life) return
    this.life = life
    for (const copy of [...this.copies.values()]) this.dropCopy(copy)
    this.told.clear()
    this.served.clear()
    this.unheard.clear()
  }

  /** The live placements of a class, by machine. */
  private hosts(sessionId: string): Map<string, PlacementRow[]> {
    const out = new Map<string, PlacementRow[]>()
    for (const row of classPlacementRows(sessionId)) {
      if (!LIVE.has(row.state)) continue
      out.set(row.runnerId, [...(out.get(row.runnerId) ?? []), row])
    }
    return out
  }

  /**
   * The class's copy on the machine, made when a live placement of the class
   * is there and none was known: fresh when every such placement was written
   * in this life (a full push makes the copy), otherwise to be rebuilt from
   * the machine's full report. Null — nothing of the class lives there (and a
   * copy known before goes).
   */
  private copyOf(sessionId: string, runnerId: string, rows = this.hosts(sessionId).get(runnerId) ?? []): Copy | null {
    this.live()
    const key = copyKey(sessionId, runnerId)
    const known = this.copies.get(key)
    if (rows.length === 0) {
      if (known) this.dropCopy(known)
      return null
    }
    const named = namedGens(rows)
    if (known) {
      if (anotherLife(known.gens, named)) this.restart(known, named, 'the class is placed there again at new gens, and the machine begins its copy anew')
      else if (Object.keys(named).length > 0) known.gens = named
      return known
    }
    if (this.closed) return null
    const fresh = rows.every((row) => row.createdAt >= this.life)
    const copy: Copy = {
      sessionId,
      runnerId,
      acked: fresh ? new Map() : null,
      fresh,
      pushes: [],
      seq: this.seqBase,
      machineSeq: 0,
      lag: null,
      syncAt: null,
      gen: Math.max(...rows.map((row) => row.gen)),
      gens: named,
      walk: null,
      full: { wanted: !fresh, pages: null, done: null },
      onMachine: new Map(),
      pulls: new Map(),
      conflicts: new Map(),
      kept: new Map(),
      fetched: new Map(),
      scan: { wanted: false, sentAt: null },
      waiters: new Set(),
      settles: new Set(),
      work: Promise.resolve(),
      served: 0,
      syncedAt: null,
      eager: null,
      dirty: false,
      drops: new Set(),
    }
    this.copies.set(key, copy)
    const served = this.served.get(runnerId) ?? new Set<string>()
    served.add(sessionId)
    this.served.set(runnerId, served)
    this.log(`[files] ${sessionId} on machine ${runnerId}: ${fresh ? 'a fresh copy, pushed whole' : 'a copy from before this life, rebuilt from its full report'}`)
    // A fresh copy is pushed now, unless all it serves is a stop (its last writes still come home); a rebuilt one once its
    // full report came (rebuild).
    if (fresh && rows.some((row) => row.state !== 'stopping')) this.scheduleEager(copy, 0)
    return copy
  }

  /** The gen a pull of the copy is asked with: the newest of the class's placements on the machine now (§6.9). */
  private genOf(copy: Copy): number {
    let gen = 0
    for (const row of classPlacementRows(copy.sessionId)) if (LIVE.has(row.state) && row.runnerId === copy.runnerId) gen = Math.max(gen, row.gen)
    return gen || copy.gen
  }

  /** The copy's placements are gone (lost, stopped, moved): whatever waited on it goes on, and nothing more is asked of it. */
  private dropCopy(copy: Copy): void {
    this.copies.delete(copyKey(copy.sessionId, copy.runnerId))
    if (copy.eager !== null) this.clock.clearTimeout(copy.eager)
    copy.eager = null
    this.dropVerdicts(copy)
    // The class's hashes are kept while a copy of it is anywhere: a class back here alone needs none of them.
    if (![...this.copies.values()].some((other) => other.sessionId === copy.sessionId)) this.digests.delete(copy.sessionId)
    // A barrier passes: its run meets the kernel's own news (the placement moved), never the files' refusal.
    for (const waiter of [...copy.waiters]) this.release(copy, waiter)
    for (const settle of [...copy.settles]) {
      copy.settles.delete(settle)
      settle.resolve(false)
    }
  }

  /** Its verdicts are for reports of a copy the machine no longer serves: nothing more is said of them, nor said again. */
  private dropVerdicts(copy: Copy): void {
    const queued = this.outbox.get(copy.runnerId)?.filter((verdict) => verdict.sessionId !== copy.sessionId) ?? []
    if (queued.length > 0) this.outbox.set(copy.runnerId, queued)
    else this.outbox.delete(copy.runnerId)
    const unheard = (this.unheard.get(copy.runnerId) ?? [])
      .map((reply) => ({ seq: reply.seq, verdicts: reply.verdicts.filter((verdict) => verdict.sessionId !== copy.sessionId) }))
      .filter((reply) => reply.verdicts.length > 0)
    if (unheard.length > 0) this.unheard.set(copy.runnerId, unheard)
    else this.unheard.delete(copy.runnerId)
  }

  /**
   * THE MACHINE BEGINS THE CLASS'S COPY ANEW (§8.8): home names the class
   * there at gens the copy never served — a slot stopped and placed again on
   * the same machine, the chooser's favourite — so the agent takes none of
   * its old record as home's word (its ack says 0 until a push lands); or the
   * machine says it holds less of the copy than it applied. What this server
   * knew of the old copy goes, and the new one is pushed whole, over the
   * files the machine kept there: what both sides agreed and the push leaves
   * out goes, and what only the machine has — the old placement's last
   * writes — comes back as its changes, taken by the rule of §8.4 like any
   * (a stop moved the class nowhere). A run at the barrier stays, and waits
   * for that push: it reads the files there, not the old copy's word.
   */
  private restart(copy: Copy, gens: Partial<Record<RoomRole, number>>, why: string): void {
    this.log(`[files] ${copy.sessionId} on machine ${copy.runnerId}: ${why}; pushed whole`)
    copy.gens = gens
    copy.acked = new Map()
    copy.fresh = true
    copy.pushes = []
    copy.machineSeq = 0
    copy.lag = null
    copy.walk = null
    copy.full = { wanted: false, pages: null, done: null }
    copy.onMachine.clear()
    copy.pulls.clear()
    copy.kept.clear()
    copy.fetched.clear()
    copy.served = 0
    copy.syncedAt = null
    copy.dirty = false
    this.dropVerdicts(copy)
    for (const waiter of copy.waiters) waiter.seq = NEXT_PUSH
    if (copy.waiters.size > 0) void this.track(this.refresh(copy, true)).catch((error: unknown) => this.log(`[files] ${copy.sessionId}: ${errorText(error)}`))
    else this.scheduleEager(copy, 0)
  }

  /**
   * News of the class's placements (kernel/index.ts · onPlacementEvent): a
   * copy whose slots left its machine goes at once — a run at its barrier
   * meets the failover's words, not the files' refusal half a minute later —
   * and one placed there again at new gens begins anew.
   */
  placementChanged(sessionId: string): void {
    if (this.closed) return
    this.liveCopies(sessionId)
  }

  /** The class's copies whose machine holds a live slot of it now; the others go (a failover, a stop, a revoke). */
  private liveCopies(sessionId: string): Copy[] {
    const mine = [...this.copies.values()].filter((copy) => copy.sessionId === sessionId)
    if (mine.length === 0) return mine
    const hosts = this.hosts(sessionId)
    return mine.map((copy) => this.copyOf(sessionId, copy.runnerId, hosts.get(copy.runnerId) ?? [])).filter((copy): copy is Copy => copy !== null)
  }

  /** Every copy of the machine that has a live placement there now (made when missing). */
  private copiesOn(runnerId: string): Copy[] {
    this.live()
    const bySession = new Map<string, PlacementRow[]>()
    for (const row of runnerPlacementRows(runnerId)) bySession.set(row.sessionId, [...(bySession.get(row.sessionId) ?? []), row])
    const out: Copy[] = []
    for (const [sessionId, rows] of bySession) {
      const copy = this.copyOf(sessionId, runnerId, rows)
      if (copy) out.push(copy)
    }
    // A copy whose placements all went since: nothing more of it.
    for (const copy of [...this.copies.values()]) if (copy.runnerId === runnerId && !bySession.has(copy.sessionId)) this.dropCopy(copy)
    return out
  }

  /** Whether `gen` is a placement of the class on the machine now (placement.ts · placementCurrent, for any of the class's slots). */
  private current(runnerId: string, sessionId: string, gen: number): boolean {
    return classPlacementRows(sessionId).some((row) => LIVE.has(row.state) && row.runnerId === runnerId && row.gen === gen)
  }

  /* ------------------------------------------------------------------ walk */

  /**
   * This server's class folder, walked once at a time per class (§8.2): a
   * walk under way is shared while nothing was written since it began; one
   * that began before a write (a barrier's flushToDisk a moment ago) is
   * waited out, and the folder walked again after it.
   */
  private walk(sessionId: string): Promise<Walk> {
    const running = this.walking.get(sessionId)
    if (running && running.epoch === treeEpochOf(sessionId)) return running.walk
    const after = running ? running.walk.catch(() => undefined) : Promise.resolve()
    const entry = { epoch: treeEpochOf(sessionId), walk: after.then(() => this.walkOnce(sessionId)) }
    entry.walk = entry.walk.finally(() => {
      if (this.walking.get(sessionId) === entry) this.walking.delete(sessionId)
    })
    this.walking.set(sessionId, entry)
    return entry.walk
  }

  /**
   * A stat walk level by level, as the room's tree reads it (workspace.ts ·
   * walkTree): never a hidden name (the temporary ones among them),
   * `__pycache__`, a link or a special file; depth MAX_DEPTH; at most
   * CLASS_SYNC_FILES_MAX entries. A file's hash is kept by its stat, so only
   * what changed is read.
   */
  private async walkOnce(sessionId: string): Promise<Walk> {
    this.counts.walks++
    const epoch = treeEpochOf(sessionId)
    const root = sessionDir(sessionId)
    const entries = new Map<string, Seen>()
    const listed = new Set<string>()
    const files: Array<{ path: string; full: string; stat: fs.Stats }> = []
    let truncated = false
    let level = ['']
    for (let depth = 0; depth < MAX_DEPTH && level.length > 0 && !truncated; depth++) {
      const next: string[] = []
      for (const dir of level) {
        if (entries.size >= CLASS_SYNC_FILES_MAX) {
          truncated = true
          break
        }
        let names: string[]
        try {
          names = (workspaceFs.readdirSync(dir ? path.join(root, dir) : root) as string[]).sort()
        } catch {
          continue
        }
        let whole = true
        for (const name of names) {
          if (name.startsWith('.') || name === '__pycache__') continue
          const here = dir ? `${dir}/${name}` : name
          if (normalizePath(here) !== here) continue
          let stat: fs.Stats
          try {
            stat = workspaceFs.lstatSync(path.join(root, here))
          } catch {
            continue
          }
          if (!stat.isDirectory() && !stat.isFile()) continue
          if (entries.size >= CLASS_SYNC_FILES_MAX) {
            truncated = true
            whole = false
            break
          }
          if (stat.isDirectory()) {
            entries.set(here, { sha: REMOTE_DIR_BASE, bytes: 0 })
            next.push(here)
          } else {
            entries.set(here, { sha: '', bytes: stat.size })
            files.push({ path: here, full: path.join(root, here), stat })
          }
        }
        if (whole) listed.add(dir)
      }
      level = next
    }
    const known = this.digests.get(sessionId) ?? new Map<string, { key: string; sha: string }>()
    const kept = new Map<string, { key: string; sha: string }>()
    for (const file of files) {
      const key = `${file.stat.size}:${file.stat.mtimeMs}:${file.stat.ctimeMs}:${file.stat.ino}`
      let sha = known.get(file.path)?.key === key ? known.get(file.path)!.sha : null
      if (sha === null) {
        try {
          sha = await cachedSha256(file.full, file.stat, () => workspaceFs.createReadStream(file.full))
        } catch {
          // Gone or swapped since the look: no entry, so the copy keeps what it has of it until the next walk.
          entries.delete(file.path)
          continue
        }
      }
      kept.set(file.path, { key, sha })
      entries.get(file.path)!.sha = sha
    }
    this.digests.set(sessionId, kept)
    const digest = createHash('sha256')
    for (const [where, seen] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) digest.update(`${where}\0${seen.sha}\0`)
    return { at: this.clock.now(), epoch, entries, listed, truncated, digest: digest.digest('hex') }
  }

  /* ------------------------------------------------------------------ push */

  /** Push what changed here soon, without a run waiting on it (EAGER_PUSH_MS after the last write of a burst). */
  private scheduleEager(copy: Copy, ms = EAGER_PUSH_MS): void {
    if (this.closed) return
    if (copy.eager !== null) this.clock.clearTimeout(copy.eager)
    copy.eager = this.clock.setTimeout(() => {
      copy.eager = null
      // Nothing for a copy whose slots left the machine meanwhile (a failover the machine never heard of): it goes now.
      if (this.copyOf(copy.sessionId, copy.runnerId) !== copy) return
      void this.track(this.refresh(copy, false)).catch((error: unknown) => this.log(`[files] ${copy.sessionId}: an eager push failed: ${errorText(error)}`))
    }, ms)
  }

  /** A write here: every copy of the class pushes it soon. */
  treeChanged(sessionId: string | undefined): void {
    if (this.closed) return
    for (const copy of this.copies.values()) if (sessionId === undefined || copy.sessionId === sessionId) this.scheduleEager(copy)
  }

  /**
   * Walk the folder and push what the copy lacks. An eager push never
   * supersedes one in flight (the barrier does, once per run): a folder
   * written to every second would otherwise keep the machine starting over.
   */
  private async refresh(copy: Copy, promoted: boolean, supersede = promoted): Promise<Push | null> {
    if (copy.acked === null) return null
    if (!supersede && copy.pushes.length > 0) {
      copy.dirty = true
      return null
    }
    /*
     * What the copy holds differs from this server's in a way no write here
     * tells (a refusal put the machine's version in its record): planned
     * again, even from a walk equal to the one in flight — that push was
     * planned before the refusal, and may not put this server's file back.
     */
    const dirty = copy.dirty
    copy.dirty = false
    const walk = this.freshWalk(copy) ?? (await this.walk(copy.sessionId))
    if (this.copies.get(copyKey(copy.sessionId, copy.runnerId)) !== copy || copy.acked === null) return null
    copy.walk = walk
    const newest = copy.pushes.at(-1)
    if (newest && newest.digest === walk.digest && !dirty) {
      /*
       * A run waits for no push that carries only the room's notebook files
       * (§8.2: they are off the run path), which a class whose students type
       * plans every few seconds: it goes now, the push on in the background.
       */
      if (promoted && copy.pushes.every((one) => this.booksOnly(copy, one))) {
        this.releaseNext(copy)
        return null
      }
      if (promoted && !newest.promoted) {
        newest.promoted = true
        this.wake(copy.runnerId)
      }
      this.waitersOn(copy)
      return newest
    }
    const push = this.plan(copy, walk, promoted)
    if (!push) {
      // A run's barrier left a notebook's projection behind: it follows in the background.
      if (copy.dirty) this.scheduleEager(copy)
      /*
       * Nothing a run reads is missing there, whatever the pushes in flight
       * do: a run's plan puts again every path they touch but the notebooks
       * (plan), so one with nothing to push means they carry notebooks
       * alone. The run goes now rather than wait for their ack.
       */
      if (promoted) this.releaseNext(copy)
      else this.waitersOn(copy)
      return null
    }
    this.counts.pushes++
    copy.pushes.push(push)
    this.trim(copy)
    this.log(`[files] ${copy.sessionId} → machine ${copy.runnerId}: push ${push.seq}${push.full ? ' (full)' : ''}, ${push.put.length} put, ${push.remove.length} removed, ${push.move.length} moved, ${push.bytes} bytes${push.rest ? `, ${push.rest.files} left for the next` : ''}`)
    this.waitersOn(copy)
    this.wake(copy.runnerId)
    return push
  }

  /** The copy's last walk, when nothing was written here since and it is at most FRESH_WALK_MS old: the folder as it is. */
  private freshWalk(copy: Copy): Walk | null {
    const walk = copy.walk
    return walk && walk.epoch === treeEpochOf(copy.sessionId) && this.clock.now() - walk.at <= FRESH_WALK_MS ? walk : null
  }

  /**
   * A NEWER PUSH MAKES THE OLDER UNACKED ONES MOOT: it is whole on top of any
   * of them (plan). Kept beside it is only the one the machine may be applying
   * — the oldest a reply carried — for its ack and the blobs it fetches; the
   * rest go, inline bytes and all. A machine that stops acking (a full disk, a
   * stuck agent, a stolen secret) holds two pushes here, however many runs
   * find a change and push again.
   */
  private trim(copy: Copy): void {
    if (copy.pushes.length <= 1) return
    const newest = copy.pushes.at(-1)!
    const flying = copy.pushes.find((one) => one !== newest && one.sent)
    copy.pushes = flying ? [flying, newest] : [newest]
  }

  /** Whether a push carries only the room's notebook files, which no run waits for (§8.2): no folder, no move, nothing left for a next one. */
  private booksOnly(copy: Copy, push: Push): boolean {
    if (push.full || push.rest !== null || push.move.length > 0) return false
    return push.put.every((entry) => !('dir' in entry && entry.dir) && this.hooks.isBook(copy.sessionId, entry.path)) && push.remove.every((where) => this.hooks.isBook(copy.sessionId, where))
  }

  /** The runs waiting for the push planned next go now: nothing they read is missing on the machine. */
  private releaseNext(copy: Copy): void {
    for (const waiter of [...copy.waiters]) if (waiter.seq === NEXT_PUSH) this.release(copy, waiter)
  }

  /** Runs waiting for the push planned next: now it is the newest, or there is none to wait for (the copy is in step). */
  private waitersOn(copy: Copy): void {
    const newest = copy.pushes.at(-1)
    for (const waiter of [...copy.waiters]) {
      if (waiter.seq !== NEXT_PUSH) continue
      if (newest) {
        waiter.seq = newest.seq
        waiter.chainBytes = Math.max(waiter.chainBytes, waiter.doneBytes + newest.bytes + (newest.rest?.bytes ?? 0))
        this.tellProgress(copy, waiter)
      } else if (copy.acked !== null) this.release(copy, waiter)
    }
  }

  /**
   * The push that makes the copy this walk (§8.2), or null: nothing to do.
   * Against what the copy acked, and — while a push is unacked — against
   * whatever such a push may already have put there, so the new one is whole
   * on top of a half-applied one.
   *
   * SMALL FILES RIDE INLINE, ONE REPLY'S WORTH AT A TIME. A file up to
   * CLASS_INLINE_BYTES goes in the push itself while the push's inline bytes
   * stay within CLASS_INLINE_PUSH_BYTES; past that it waits for the next push
   * of the chain (`rest`), planned the moment this one is acked. Only a file
   * larger than CLASS_INLINE_BYTES is a blob: a folder of three thousand
   * small images is six pushes, not three thousand GETs on the agent's one
   * blob stream, which no barrier would outwait.
   */
  private plan(copy: Copy, walk: Walk, promoted: boolean): Push | null {
    const acked = copy.acked!
    const effects: Effect[] = []
    const put: RemoteFilesPut[] = []
    const remove: string[] = []
    const move: { from: string; to: string }[] = []
    const blobs = new Map<string, { path: string; bytes: number }>()
    let bytes = 0
    let inline = 0
    let paths = 0
    const rest = { files: 0, bytes: 0 }
    const later = (size: number): void => {
      rest.files++
      rest.bytes += size
    }
    const putFile = (where: string, seen: Seen): void => {
      if (paths + 1 > REMOTE_PUSH_PATHS_MAX) return later(seen.bytes)
      if (seen.bytes <= CLASS_INLINE_BYTES) {
        if (inline + seen.bytes > CLASS_INLINE_PUSH_BYTES) return later(seen.bytes)
        const content = readWhole(copy.sessionId, where, CLASS_INLINE_BYTES)
        // Read as it is now: the push names what it carries, whatever the walk saw a moment before.
        if (content !== null) {
          if (inline + content.length > CLASS_INLINE_PUSH_BYTES) return later(content.length)
          const sha = createHash('sha256').update(content).digest('hex')
          paths++
          bytes += content.length
          inline += content.length
          blobs.set(sha, { path: where, bytes: content.length })
          effects.push({ kind: 'put', path: where, sha })
          put.push({ path: where, sha256: sha, bytes: content.length, inline: content.toString('base64') })
          return
        }
        // Gone, swapped for a link or grown since the walk: named by its hash, which the blob door checks (410: planned again).
      }
      paths++
      bytes += seen.bytes
      blobs.set(seen.sha, { path: where, bytes: seen.bytes })
      effects.push({ kind: 'put', path: where, sha: seen.sha })
      put.push({ path: where, sha256: seen.sha, bytes: seen.bytes })
    }
    const putDir = (where: string): void => {
      if (paths + 1 > REMOTE_PUSH_PATHS_MAX) return later(0)
      paths++
      effects.push({ kind: 'put', path: where, sha: REMOTE_DIR_BASE })
      put.push({ path: where, dir: true })
    }
    /*
     * Rows only the machine has that staff deleted (removeOnMachine): removed
     * there by every push until one carrying them is acked — a full one too,
     * which by itself takes away only what both sides agreed. One this server
     * has something at again is this server's to put, and needs no remove.
     */
    const dropRemoves = (): void => {
      for (const where of [...copy.drops]) {
        if (walk.entries.has(where)) {
          copy.drops.delete(where)
          continue
        }
        if (remove.some((one) => isInside(where, one))) continue
        if (paths + 1 > REMOTE_PUSH_PATHS_MAX) {
          later(0)
          continue
        }
        paths++
        remove.push(where)
        effects.push({ kind: 'remove', path: where })
      }
    }
    const ordered = [...walk.entries].sort((a, b) => depthOf(a[0]) - depthOf(b[0]) || (a[0] < b[0] ? -1 : 1))
    const full = copy.fresh
    if (full) {
      // The whole folder: the copy becomes exactly this (the agent removes what it does not name), what waits for the next
      // push of the chain put by that one.
      dropRemoves()
      for (const [where, seen] of ordered) {
        if (seen.sha === REMOTE_DIR_BASE) putDir(where)
        else putFile(where, seen)
      }
    } else {
      // What the copy may hold: what it acked, and whatever an unacked push put or removed since.
      const touched = new Set<string>()
      for (const push of copy.pushes) for (const effect of push.effects) touched.add(effect.path)
      const maybe = new Set<string>([...acked.keys(), ...touched])
      const superseding = copy.pushes.length > 0
      /*
       * Removed here: what the copy may hold and the walk did not see, decided
       * by the nearest folder above it that is still here, as the agent decides
       * it (runner-agent/room-files.ts · gone) — gone only under a folder the
       * walk read whole (a path past the walk's ceiling is not), and what goes
       * is the topmost path missing below that folder, its whole subtree with
       * it: a folder the copy's record never named (one a kernel made, a
       * rebuilt copy's) goes with the files under it. Never a file that only
       * the machine has. A file here where the copy has a folder goes too,
       * and is put again.
       */
      const gone: string[] = []
      const again = new Set<string>()
      const folderHere = (dir: string): boolean => dir === '' || walk.entries.get(dir)?.sha === REMOTE_DIR_BASE
      for (const where of [...maybe].sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : 1))) {
        if (walk.entries.has(where) || copy.onMachine.has(where)) continue
        let top = where
        let dir = parentOf(where)
        while (!folderHere(dir)) {
          top = dir
          dir = parentOf(dir)
        }
        if (!walk.listed.has(dir) || gone.some((one) => isInside(top, one))) continue
        gone.push(top)
        if (walk.entries.has(top)) again.add(top)
      }
      const added: Array<[string, Seen]> = ordered.filter(([where, seen]) => acked.get(where) !== seen.sha || touched.has(where) || again.has(where))
      // A rename here is a rename there (§8.2, movePath): a removed path and an added one of the same content — a file, or a
      // folder whose whole subtree came along unchanged — when nothing is unacked. Nothing is uploaded for it.
      const moved = new Set<string>()
      if (!superseding) {
        const subtree = (of: (where: string) => string | undefined, keys: Iterable<string>, top: string): string => {
          const inside: string[] = []
          for (const where of keys) if (where !== top && isInside(where, top)) inside.push(`${where.slice(top.length)}\0${of(where)}`)
          return inside.sort().join('\n')
        }
        const goneDirs = gone.filter((where) => acked.get(where) === REMOTE_DIR_BASE && !again.has(where))
        // The topmost of each folder new here: one inside another new one moves with it.
        const isNewDir = (where: string): boolean => walk.entries.get(where)?.sha === REMOTE_DIR_BASE && !acked.has(where)
        const newDirs = added.filter(([where]) => isNewDir(where) && !(parentOf(where) !== '' && isNewDir(parentOf(where))))
        for (const from of goneDirs) {
          const shape = subtree((where) => acked.get(where), acked.keys(), from)
          const match = newDirs.find(([to]) => !moved.has(to) && subtree((where) => walk.entries.get(where)?.sha, walk.entries.keys(), to) === shape)
          if (!match || paths + 2 > REMOTE_PUSH_PATHS_MAX) continue
          const to = match[0]
          paths += 2
          move.push({ from, to })
          effects.push({ kind: 'remove', path: from }, { kind: 'put', path: to, sha: REMOTE_DIR_BASE })
          for (const [where, seen] of walk.entries) {
            if (!isInside(where, to)) continue
            moved.add(where)
            if (where === to) continue
            effects.push({ kind: 'put', path: where, sha: seen.sha })
            // A move whose source is gone there the agent makes good by hash (runner-agent/room-files.ts): within the blob door's scope.
            if (seen.sha !== REMOTE_DIR_BASE) blobs.set(seen.sha, { path: where, bytes: seen.bytes })
          }
          moved.add(from)
        }
        const byContent = new Map<string, string[]>()
        for (const where of gone) {
          const sha = acked.get(where)
          if (sha && sha !== REMOTE_DIR_BASE && !moved.has(where) && !again.has(where)) byContent.set(sha, [...(byContent.get(sha) ?? []), where])
        }
        for (const [where, seen] of added) {
          if (seen.sha === REMOTE_DIR_BASE || acked.has(where) || moved.has(where)) continue
          const from = byContent.get(seen.sha)?.shift()
          if (!from || paths + 2 > REMOTE_PUSH_PATHS_MAX) continue
          paths += 2
          move.push({ from, to: where })
          effects.push({ kind: 'remove', path: from }, { kind: 'put', path: where, sha: seen.sha })
          blobs.set(seen.sha, { path: where, bytes: seen.bytes })
          moved.add(from).add(where)
        }
      }
      for (const where of gone) {
        if (moved.has(where)) continue
        if (paths + 1 > REMOTE_PUSH_PATHS_MAX) {
          later(0)
          continue
        }
        paths++
        remove.push(where)
        effects.push({ kind: 'remove', path: where })
      }
      dropRemoves()
      for (const [where, seen] of added) {
        if (moved.has(where)) continue
        /*
         * The room's notebook files are this server's projections of the
         * document (§8.4), rewritten after every run's outputs: a run never
         * waits for one. The push that follows its ack carries them (dirty).
         */
        if (promoted && seen.sha !== REMOTE_DIR_BASE && this.hooks.isBook(copy.sessionId, where)) {
          copy.dirty = true
          continue
        }
        if (seen.sha === REMOTE_DIR_BASE) putDir(where)
        else putFile(where, seen)
      }
      // Moves first, then removes, then puts: the order the agent applies them in, and the order the effects say it.
      effects.sort((a, b) => effectRank(a, move) - effectRank(b, move))
    }
    if (!full && put.length === 0 && remove.length === 0 && move.length === 0) return null
    // A path home is putting is home's from now on: a «на машине» file of that name is overwritten there.
    for (const entry of put) copy.onMachine.delete(entry.path)
    copy.seq = Math.max(copy.seq, copy.machineSeq) + 1
    return {
      seq: copy.seq,
      full,
      promoted,
      put,
      remove,
      move,
      effects,
      digest: walk.digest,
      blobs,
      bytes,
      rest: rest.files > 0 ? rest : null,
      plannedAt: this.clock.now(),
      sent: false,
    }
  }

  /**
   * The machine applied pushes up to `seq` (its held placements'
   * files.pushSeq): what the copy holds moves on. A run whose push was the
   * whole of its walk goes on; one whose push left the rest of a chain waits
   * for the push that carries it, planned now.
   */
  private noteAck(copy: Copy, seq: number): void {
    copy.machineSeq = seq
    copy.seq = Math.max(copy.seq, seq)
    let last: Push | null = null
    let rowsGone = false
    while (copy.pushes.length > 0 && copy.pushes[0]!.seq <= seq) {
      const push = copy.pushes.shift()!
      last = push
      if (push.full) {
        copy.acked = new Map()
        copy.fresh = false
      }
      if (copy.acked) for (const effect of push.effects) applyEffect(copy.acked, effect)
      // A path this server pushed is one the machine's record has from now on: a version brought with «Привезти» is no longer a guess.
      for (const effect of push.effects) for (const where of [...copy.fetched.keys()]) if (isInside(where, effect.path)) copy.fetched.delete(where)
      /*
       * The machine removed these, and whatever was under them: a row staff
       * deleted there is done, and what stayed only there under a removed
       * folder is gone with it. The room's tree says so now.
       */
      for (const effect of push.effects) {
        if (effect.kind !== 'remove') continue
        copy.drops.delete(effect.path)
        for (const where of [...copy.onMachine.keys()]) {
          if (!isInside(where, effect.path)) continue
          copy.onMachine.delete(where)
          rowsGone = true
        }
      }
    }
    if (rowsGone) this.landed(copy.sessionId)
    if (!last) return
    const now = this.clock.now()
    for (const settle of copy.settles) if (settle.behind !== null && settle.appliedAt === null && seq >= settle.behind) settle.appliedAt = now
    const more = last.rest !== null
    if (copy.pushes.length === 0 && !more) copy.syncedAt = now
    for (const waiter of [...copy.waiters]) {
      if (waiter.seq > seq) continue
      if (!more) {
        this.release(copy, waiter)
        continue
      }
      waiter.doneBytes += last.bytes
      waiter.seq = copy.pushes.at(-1)?.seq ?? NEXT_PUSH
      this.tellProgress(copy, waiter)
    }
    // The rest of a chain, a write here while that push was in flight, or a refusal from the machine meanwhile: the next one
    // goes now, promoted when a run waits for it.
    if (copy.pushes.length > 0 || !(more || copy.dirty || (copy.walk && copy.walk.epoch !== treeEpochOf(copy.sessionId)))) return
    if (copy.waiters.size > 0) void this.track(this.refresh(copy, true)).catch((error: unknown) => this.log(`[files] ${copy.sessionId}: ${errorText(error)}`))
    else this.scheduleEager(copy, 0)
  }

  /* --------------------------------------------------------------- barrier */

  /**
   * THE BARRIER (§8.2): this server's files on the machine before a run
   * there reads them. Passes at once with nothing written since the copy's
   * last acked push, nothing refused since that a write here would not tell,
   * and a walk at most FRESH_WALK_MS old; otherwise walks, pushes (promoted: a
   * run waits on it) and waits for the ack while bytes move — for the last
   * push of a chain, when small files past one reply's inline budget follow.
   * Throws FilesStalled with the room's words after CLASS_BARRIER_STALL_MS
   * without progress, or CLASS_BARRIER_MS in all. `onProgress` hears
   * «Файлы едут на машину: 12 из 150 МБ…». `signal`: the run was stopped
   * while it waited (kernel/index.ts · interruptScope): the wait ends at once,
   * and the caller reads the signal. `notebooksAside`: a council pool's
   * attempt (§9.6, 0.26.1), which goes at once when all the machine lacks is
   * the room's notebooks (notebooksAlone); otherwise it waits as any run.
   */
  async filesBarrier(sessionId: string, runnerId: string, options: BarrierOptions = {}): Promise<void> {
    const copy = this.copyOf(sessionId, runnerId)
    if (!copy || options.signal?.aborted) return
    const now = this.clock.now()
    const epoch = treeEpochOf(sessionId)
    if (copy.acked && copy.pushes.length === 0 && !copy.dirty && copy.walk && copy.walk.epoch === epoch && now - copy.walk.at <= FRESH_WALK_MS) return
    if (options.notebooksAside) {
      const alone = await this.track(this.notebooksAlone(copy))
      // Or its copy went meanwhile (the run meets the kernel's news, as dropCopy lets a waiting one go), or it was stopped.
      if (alone || this.copies.get(copyKey(sessionId, runnerId)) !== copy || options.signal?.aborted) return
    }
    // The run waits for the push planned next (now, or once a rebuild is done), or for the one in flight when it is this walk's.
    const { waiter, done } = this.waitForAck(copy, options)
    if (copy.acked) {
      try {
        await this.track(this.refresh(copy, true))
      } catch (error) {
        // The folder could not be walked: this run hears why, and waits for nothing.
        this.release(copy, waiter)
        throw error
      }
    } else {
      copy.full.wanted ||= copy.full.pages === null
      this.wake(runnerId)
    }
    await done
  }

  /**
   * WHETHER ALL THE MACHINE LACKS IS THE ROOM'S NOTEBOOKS (§9.6, 0.26.1),
   * asked by a council pool's attempt before it waits at all. The attempt
   * computes on its epoch, never on a notebook's file; the class folder is
   * its data. So it goes when every change of this server's the machine has
   * not acked is a live notebook's file put anew (`isBook`: the files
   * projectBooks writes) — in the folder against what the copy acked, and in
   * every push not yet acked, which the machine may hold half applied.
   * Anything else is waited for as any run waits for it: another file, a
   * folder, a removal or a move, a copy being rebuilt from the machine's
   * report or not yet acked whole (its full push on the way), a walk past
   * its ceiling, a row staff deleted there.
   *
   * Asked of the walk, not of the push a waiter was given: the eager push of
   * a notebook's write, planned on the very walk a run's refresh waited for,
   * takes that run as its own (waitersOn) before the refresh can let it go
   * (releaseNext lets go only those given none), and the run then waits for
   * that push's ack — every attempt pressed in that moment. The notebooks go
   * on in the background: by the push their write armed, or, newer than the
   * one in flight, by the next (dirty, noteAck).
   */
  private async notebooksAlone(copy: Copy): Promise<boolean> {
    if (copy.acked === null || copy.fresh) return false
    const walk = this.freshWalk(copy) ?? (await this.walk(copy.sessionId))
    const acked = copy.acked
    if (this.copies.get(copyKey(copy.sessionId, copy.runnerId)) !== copy || acked === null || copy.fresh) return false
    if (walk.truncated || copy.drops.size > 0) return false
    const book = (where: string): boolean => this.hooks.isBook(copy.sessionId, where)
    for (const push of copy.pushes) {
      if (push.full || push.move.length > 0) return false
      if (!push.effects.every((effect) => effect.kind === 'put' && effect.sha !== REMOTE_DIR_BASE && book(effect.path))) return false
    }
    let changed = false
    for (const [where, seen] of walk.entries) {
      if (acked.get(where) === seen.sha) continue
      if (seen.sha === REMOTE_DIR_BASE || !book(where)) return false
      changed = true
    }
    // Removed here, and not one of the machine's own files: a removal is waited for.
    for (const where of acked.keys()) if (!walk.entries.has(where) && !copy.onMachine.has(where)) return false
    const newest = copy.pushes.at(-1)
    if (newest && newest.digest !== walk.digest) copy.dirty = true
    else if (!newest && changed && copy.eager === null) this.scheduleEager(copy)
    /*
     * The copy's walk only on a yes, when all it lacks is what no run waits
     * for. The barrier's fast path trusts a stored walk to have been planned
     * on (refresh stores and plans in one step), and a «no» is planned on
     * only by the refresh after it: an attempt stopped while it walked has
     * none, and a cell would then pass on a file the machine lacks. That
     * refresh walks again, by stat.
     */
    copy.walk = walk
    return true
  }

  private waitForAck(copy: Copy, options: { onProgress?: (words: string) => void; signal?: AbortSignal }): { waiter: BarrierWaiter; done: Promise<void> } {
    const now = this.clock.now()
    let waiter!: BarrierWaiter
    const done = new Promise<void>((resolve, reject) => {
      waiter = {
        seq: NEXT_PUSH,
        startedAt: now,
        progressAt: now,
        stall: null,
        total: null,
        doneBytes: 0,
        chainBytes: 0,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        told: null,
        toldAt: null,
        unlisten: null,
        resolve,
        reject,
      }
      waiter.stall = this.clock.setTimeout(() => this.stalled(copy, waiter, 'stall'), CLASS_BARRIER_STALL_MS)
      waiter.total = this.clock.setTimeout(() => this.stalled(copy, waiter, 'total'), CLASS_BARRIER_MS)
      const signal = options.signal
      if (signal) {
        const stopped = (): void => this.release(copy, waiter)
        signal.addEventListener('abort', stopped, { once: true })
        waiter.unlisten = () => signal.removeEventListener('abort', stopped)
      }
      copy.waiters.add(waiter)
    })
    return { waiter, done }
  }

  private release(copy: Copy, waiter: BarrierWaiter): void {
    if (!copy.waiters.delete(waiter)) return
    this.clock.clearTimeout(waiter.stall)
    this.clock.clearTimeout(waiter.total)
    waiter.unlisten?.()
    waiter.resolve()
  }

  private stalled(copy: Copy, waiter: BarrierWaiter, why: 'stall' | 'total'): void {
    if (!copy.waiters.delete(waiter)) return
    this.clock.clearTimeout(waiter.stall)
    this.clock.clearTimeout(waiter.total)
    waiter.unlisten?.()
    const words = why === 'stall'
      ? tr('server.theFilesDidNotReachTheMachine.20cf87', { seconds: Math.round(CLASS_BARRIER_STALL_MS / 1000) })
      : tr('server.theFilesDidNotReachTheMachineIn.793493', { seconds: Math.round(CLASS_BARRIER_MS / 1000) })
    this.log(`[files] ${copy.sessionId} on machine ${copy.runnerId}: a run gave up at the barrier (${why})`)
    waiter.reject(new FilesStalled(words))
  }

  /** Bytes moved for the copy (a blob served, a reply carrying a push, a page of a full report): every barrier's stall clock starts over. */
  private progress(copy: Copy): void {
    const now = this.clock.now()
    for (const waiter of copy.waiters) {
      waiter.progressAt = now
      this.clock.clearTimeout(waiter.stall)
      waiter.stall = this.clock.setTimeout(() => this.stalled(copy, waiter, 'stall'), CLASS_BARRIER_STALL_MS)
      this.tellProgress(copy, waiter)
    }
  }

  /**
   * «Файлы едут на машину: 12 из 150 МБ…» to a waiting run: only for what
   * does not land in a reply's time — a push that fetches blobs, or a chain
   * of pushes — when the words change, at most every PROGRESS_EVERY_MS.
   */
  private tellProgress(copy: Copy, waiter: BarrierWaiter): void {
    if (!waiter.onProgress || waiter.seq === NEXT_PUSH) return
    const push = copy.pushes.at(-1)
    if (!push) return
    const inline = inlineBytes(push)
    const blob = push.bytes - inline
    if (blob <= 0 && push.rest === null && waiter.doneBytes === 0) return
    const now = this.clock.now()
    const done = waiter.doneBytes + (push.sent ? inline : 0) + Math.min(copy.served, blob)
    const words = movingWords(done, Math.max(waiter.chainBytes, done))
    if (words === waiter.told || (waiter.toldAt !== null && now - waiter.toldAt < PROGRESS_EVERY_MS)) return
    waiter.told = words
    waiter.toldAt = now
    try {
      waiter.onProgress(words)
    } catch {
      /* the cell's words are the caller's */
    }
  }

  /* ------------------------------------------------------- the machine's sync */

  /**
   * A class machine's `kernels` block, once, as its sync arrives (routes.ts ·
   * sync): the acks and lags of its held placements, then its reports. Only
   * placements and reports of a class placed on the machine at their current
   * gen count; a report of an older gen is late (§8.8). Whether the sync is
   * to be answered at once rather than held: a page of a full report came and
   * the next is wanted, which the agent sends only in its next sync.
   */
  noteKernelsBlock(runnerId: string, kernels: RemoteKernelsRequest, now = this.clock.now()): boolean {
    this.live()
    this.heardReply(runnerId, kernels.heard)
    const lags = new Map<string, RemoteFilesLag>()
    const holding = new Set<string>()
    for (const held of kernels.placements) {
      const slot = parseRemotePlacementKey(held.key)
      if (!slot || !this.current(runnerId, slot.sessionId, held.gen)) continue
      holding.add(slot.sessionId)
      if (!held.files) continue
      const known = lags.get(slot.sessionId)
      // The class's slots share one copy: the furthest any of them says it got.
      lags.set(slot.sessionId, known && known.pushSeq >= held.files.pushSeq ? known : held.files)
    }
    for (const copy of this.copiesOn(runnerId)) {
      // No lag said: nothing of the copy is pending there (the agent says one once it has anything to say).
      const lag = lags.get(copy.sessionId) ?? null
      /*
       * The machine applied pushes of this copy, and now holds a slot of the
       * class at a current gen saying it applied fewer, or nothing at all: its
       * copy began anew under this one (fenced and emptied, or its record
       * lost), whatever this server made of the gens. Pushed whole again.
       */
      if (copy.machineSeq > 0 && holding.has(copy.sessionId) && (lag === null || lag.pushSeq < copy.machineSeq)) {
        this.restart(copy, copy.gens, `the machine says it applied push ${lag?.pushSeq ?? 0} of the copy, after ${copy.machineSeq}: its copy began anew`)
      }
      copy.lag = lag
      copy.syncAt = now
      if (lag) this.noteAck(copy, lag.pushSeq)
      if (holding.has(copy.sessionId)) this.dropStalePulls(copy, lag, now)
    }
    let urgent = false
    for (const report of kernels.reports) urgent = this.noteReport(runnerId, report, now) || urgent
    // Settles, once this sync's reports are applied: a scan answered is the machine with nothing more pending.
    for (const copy of this.copies.values()) if (copy.runnerId === runnerId && copy.settles.size > 0) this.enqueue(copy, async () => this.settleCheck(copy, this.clock.now()))
    return urgent
  }

  /**
   * Pulls of what a kernel wrote that the machine no longer has to send: it
   * holds the class and says nothing of it is pending there, and the pull
   * was asked PULL_STALE_MS ago at least — its agent restarted and lost the
   * version it kept for it (a conflict's, which a push since overwrote), or
   * the version went unseen. They are let go, so that no settle waits on
   * them for good; a conflict that waited on such a pull is answered as kept
   * nowhere. «Привезти» is staff's, and waits on (released lets it go).
   */
  private dropStalePulls(copy: Copy, lag: RemoteFilesLag | null, now: number): void {
    if ((lag?.pending ?? 0) > 0) return
    for (const pull of [...copy.pulls.values()]) {
      if (pull.fetch || now - pull.at < PULL_STALE_MS) continue
      copy.pulls.delete(pull.path)
      this.log(`[files] ${copy.sessionId} on machine ${copy.runnerId}: ${pull.path} was asked for ${Math.round((now - pull.at) / 1000)} s ago, and nothing of the class is pending there; let go`)
      if (pull.target === pull.path) continue
      const kept = copy.kept.get(pull.path)
      const seqs = kept && kept.name === pull.target ? kept.seqs : [pull.seq]
      if (kept && kept.name === pull.target) {
        kept.name = null
        kept.seqs = []
      }
      for (const seq of seqs) this.queueVerdict(copy, { sessionId: copy.sessionId, seq, accepted: [], refused: [{ path: pull.path, why: 'base' }] })
    }
  }

  private noteReport(runnerId: string, report: RemoteFilesReport, now: number): boolean {
    if (!this.current(runnerId, report.sessionId, report.gen)) {
      if (report.late && report.late.length > 0) this.lateChanges(runnerId, report, now)
      return false
    }
    const copy = this.copyOf(report.sessionId, runnerId)
    if (!copy) return false
    copy.gen = Math.max(copy.gen, report.gen)
    if (report.full) return this.collectPage(copy, report)
    if (copy.full.pages !== null) {
      // The agent started over in the middle of a paged walk: what was collected is no walk; ask again.
      this.log(`[files] ${copy.sessionId} on machine ${runnerId}: a report came in the middle of its full report; asking again`)
      copy.full = { wanted: true, pages: null, done: null }
    }
    this.enqueue(copy, () => this.apply(copy, report.seq, report, now))
    return false
  }

  /**
   * A page of a full report (RemoteFilesReport.page): kept from page 0 to the
   * last, in order. The page just kept said again is the same page (the agent
   * moves on only once its sync is answered, and a lost answer or its own
   * poke makes it say it again): it replaces the one kept. So is the walk's
   * last page said again after its rebuild. Any other gap drops what was kept,
   * and the walk is asked again. Whether the next page is wanted now.
   */
  private collectPage(copy: Copy, page: RemoteFilesReport): boolean {
    const index = page.page?.index ?? 0
    const pages = copy.full.pages
    if (index === 0) copy.full = { wanted: false, pages: [page], done: null }
    else if (pages !== null && index === pages.length) pages.push(page)
    else if (pages !== null && index === pages.length - 1) pages[index] = page
    else if (pages === null && index === copy.full.done) return false
    else {
      this.log(`[files] ${copy.sessionId} on machine ${copy.runnerId}: page ${index} of a full report came out of order; asking again`)
      copy.full = { wanted: true, pages: null, done: null }
      return false
    }
    this.progress(copy)
    if (!page.page?.last) return true
    const all = copy.full.pages!
    copy.full = { wanted: false, pages: null, done: index }
    this.enqueue(copy, () => this.rebuild(copy, all, this.clock.now()))
    return false
  }

  /**
   * A whole full report (§8.4, §11.4): what the copy acked is what the
   * machine's baseline says both sides last agreed, every file it lists as
   * changed since is applied as any report's would be, and what stays on the
   * machine is what it lists as such, all of it.
   */
  private async rebuild(copy: Copy, pages: RemoteFilesReport[], now: number): Promise<void> {
    const acked = new Map<string, string>()
    copy.onMachine.clear()
    for (const page of pages) {
      for (const entry of page.changed) if (entry.base !== null) acked.set(entry.path, entry.base)
      for (const entry of page.removed) acked.set(entry.path, entry.base)
    }
    copy.acked = acked
    copy.fresh = false
    this.log(`[files] ${copy.sessionId} on machine ${copy.runnerId}: rebuilt from a full report of ${pages.length} page(s), ${acked.size} agreed paths`)
    for (const page of pages) {
      // Unchanged files are only what was agreed: the rest is applied as a report.
      const changes: RemoteFilesReport = { ...page, full: false, changed: page.changed.filter((entry) => entry.sha256 !== entry.base) }
      delete changes.page
      await this.apply(copy, page.seq, changes, now)
    }
    // Whatever waited for the rebuild pushes now; a run at the barrier waits for that push (refresh · waitersOn).
    await this.refresh(copy, copy.waiters.size > 0)
  }

  private enqueue(copy: Copy, work: () => Promise<void>): void {
    copy.work = copy.work.then(work).catch((error: unknown) => this.log(`[files] ${copy.sessionId} on machine ${copy.runnerId}: ${errorText(error)}`))
  }

  /** A machine's report of an older gen, naming what it changed after the fence (§8.8): told in the room once, and refused. */
  private lateChanges(runnerId: string, report: RemoteFilesReport, now: number): void {
    const key = `${runnerId}\0${report.sessionId}\0${report.gen}`
    // Only a class this machine held here in this life, and only of a gen it could have held: never another room's log.
    const placed = classPlacementRows(report.sessionId)
    if (!this.served.get(runnerId)?.has(report.sessionId) || !placed.some((row) => row.gen >= report.gen)) return
    if (this.told.has(key)) return
    this.told.add(key)
    const late = (report.late ?? []).slice(0, CLASS_LATE_MAX)
    /*
     * A machine come back after a move is one whose gen the class lost there
     * (§8.8: a failover, «Перенести сейчас», a revoke). One whose slots were
     * stopped there — the class's end, the owner's stop, the idle sweep —
     * moved nowhere, and came back from nowhere: what was left only in its
     * copy (a file over a cap, the last writes no scan had brought) goes with
     * the copy, refused all the same, and the room reads that in the stop's
     * words, never of a move.
     */
    const row = placed.find((one) => one.runnerId === runnerId && one.gen === report.gen)
    if (row && row.state !== 'lost') {
      this.log(`[files] ${report.sessionId}: machine ${runnerId} lets go of ${late.length} change(s) of gen ${report.gen}, stopped there; refused`)
      this.say(report.sessionId, 'late', `${runnerId}:${report.gen}`, tr('server.theKernelsOnTheMachineWereStopped.d5fceb', { files: late.join(', ') }))
      return
    }
    // When the slot left the machine: the placement after it began then.
    const fenced = row?.endedAt
      ?? placed.filter((one) => one.gen > report.gen).map((one) => one.createdAt).sort((a, b) => a - b)[0]
      ?? now
    this.log(`[files] ${report.sessionId}: machine ${runnerId} came back with ${late.length} change(s) after gen ${report.gen} was fenced; refused`)
    this.say(report.sessionId, 'late', `${runnerId}:${report.gen}`, tr('server.theMachineCameBackAfterTheMove.f1111a', { since: clockOf(fenced, true), files: late.join(', ') }))
  }

  /* ----------------------------------------------------------------- apply */

  /**
   * One report's changes (§8.4), in order: what stays on the machine, the
   * renames, the removals deepest first, the changes. Each by the one rule:
   * it applies only while this server's file is still its base.
   */
  private async apply(copy: Copy, seq: number, report: Pick<RemoteFilesReport, 'changed' | 'removed' | 'skipped' | 'released'>, now: number): Promise<void> {
    const verdict: Verdict = { sessionId: copy.sessionId, seq, accepted: [], refused: [] }
    const room = { bytes: null as number | null }
    let landed = false
    // The rows the room's tree has of the machine changed (one more left there, one gone from it): the room hears it now.
    let rows = false
    // No longer left on the machine: gone from it, or on their way here now (then in `changed` too).
    const changing = new Set(report.changed.map((entry) => entry.path))
    for (const where of report.released ?? []) {
      if (copy.onMachine.delete(where)) rows = true
      // Gone, not on its way: a «Привезти» of it waits for no bytes that come (its row, and the lag's «↑ 1 файл», with it).
      if (!changing.has(where) && copy.pulls.get(where)?.fetch) this.dropPull(copy, where)
    }
    for (const entry of report.skipped) {
      if (copy.onMachine.size >= ON_MACHINE_MAX && !copy.onMachine.has(entry.path)) break
      const known = copy.onMachine.get(entry.path)
      if (!known || known.bytes !== entry.bytes || known.why !== entry.why) rows = true
      copy.onMachine.set(entry.path, { bytes: entry.bytes, why: entry.why, sha256: null, base: null, seq, at: now })
      // Left there, it is not on its way: a pull of what a kernel wrote there waits for no bytes («Привезти» does: staff asked).
      const pull = copy.pulls.get(entry.path)
      if (pull && !pull.fetch && pull.target === pull.path) this.dropPull(copy, entry.path)
      if (entry.why === 'size' || entry.why === 'room') this.sayOverCap(copy, entry.path, entry.bytes, entry.why)
      // The proxy in front of this server refused its upload (the agent heard its 413): no cap of ours, and none to name.
      else if (entry.why === 'proxy') this.say(copy.sessionId, `proxy:${entry.bytes}`, entry.path, tr('server.staysOnTheMachineTheProxyIn.8cfa12', { file: entry.path, size: sizeWords(entry.bytes) }))
    }
    // Renames: a removed file and an added one of the same content, in one report.
    const adds = new Map<string, string[]>()
    for (const change of report.changed) if (change.base === null) adds.set(change.sha256, [...(adds.get(change.sha256) ?? []), change.path])
    const paired = new Map<string, string>()
    for (const removal of report.removed) {
      if (removal.base === REMOTE_DIR_BASE) continue
      const to = adds.get(removal.base)?.shift()
      if (to) paired.set(removal.path, to)
    }
    const pairedTo = new Set(paired.values())
    for (const [from, to] of paired) {
      const sha = report.removed.find((entry) => entry.path === from)!.base
      if (await this.rename(copy, from, to, sha)) {
        verdict.accepted.push(from, to)
        landed = true
      } else {
        paired.delete(from)
        pairedTo.delete(to)
      }
    }
    const removals = report.removed.filter((entry) => !paired.has(entry.path)).sort((a, b) => depthOf(b.path) - depthOf(a.path))
    for (const removal of removals) {
      const outcome = await this.removal(copy, removal.path, removal.base)
      if (outcome === 'accepted') verdict.accepted.push(removal.path)
      else verdict.refused.push({ path: removal.path, why: outcome })
      if (outcome === 'accepted') landed = true
    }
    for (const change of report.changed) {
      if (pairedTo.has(change.path)) continue
      const outcome = await this.change(copy, seq, change, room, now)
      if (outcome === 'pulled') continue
      if (outcome === 'accepted') {
        verdict.accepted.push(change.path)
        landed = true
      } else verdict.refused.push(outcome)
    }
    this.queueVerdict(copy, verdict)
    if (landed || rows) this.landed(copy.sessionId)
    // A refused path is this server's version again on the machine: the next push puts it back (now, or once the one in
    // flight is acked).
    if (verdict.refused.some((entry) => entry.why !== 'cap')) {
      copy.dirty = true
      this.scheduleEager(copy, 0)
    }
  }

  private queueVerdict(copy: Copy, verdict: Verdict): void {
    if (verdict.accepted.length === 0 && verdict.refused.length === 0) return
    this.counts.applied += verdict.accepted.length
    this.counts.refused += verdict.refused.length
    const queued = this.outbox.get(copy.runnerId) ?? []
    const same = queued.find((one) => one.sessionId === verdict.sessionId && one.seq === verdict.seq)
    if (same) {
      // One fate per path in a verdict (the agent's parser refuses a reply naming one twice): the newest decision stands.
      const decided = new Set([...verdict.accepted, ...verdict.refused.map((entry) => entry.path)])
      same.accepted = [...same.accepted.filter((where) => !decided.has(where)), ...verdict.accepted]
      same.refused = [...same.refused.filter((entry) => !decided.has(entry.path)), ...verdict.refused]
    } else queued.push(verdict)
    this.outbox.set(copy.runnerId, queued)
    this.wake(copy.runnerId)
  }

  /** Verdicts decided and not yet sent, by machine, oldest first. */
  private readonly outbox = new Map<string, Verdict[]>()
  /** Verdicts sent, by machine, in the replies (by their replySeq, oldest first) the machine has not said it took in yet. */
  private readonly unheard = new Map<string, Array<{ seq: number; verdicts: Verdict[] }>>()

  /** What the copy holds at a path is now `sha` (or nothing): when the copy is known at all. A file where a folder was takes what was under it. */
  private agreed(copy: Copy, where: string, sha: string | null): void {
    if (!copy.acked) return
    applyEffect(copy.acked, sha === null ? { kind: 'remove', path: where } : { kind: 'put', path: where, sha })
  }

  /** This server's file at a path: its sha256, REMOTE_DIR_BASE for a folder, null for nothing; and the stat it was read at. */
  private async homeState(sessionId: string, where: string): Promise<{ sha: string | null; key: string | null }> {
    const full = resolveInSession(sessionId, where)
    if (!full) return { sha: null, key: null }
    let stat: fs.Stats
    try {
      stat = workspaceFs.lstatSync(full)
    } catch {
      return { sha: null, key: null }
    }
    if (stat.isDirectory()) return { sha: REMOTE_DIR_BASE, key: 'dir' }
    if (!stat.isFile()) return { sha: 'special', key: 'special' }
    const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
    const memo = this.digests.get(sessionId)?.get(where)
    if (memo?.key === key) return { sha: memo.sha, key }
    const sha = await cachedSha256(full, stat, () => workspaceFs.createReadStream(full))
    return { sha, key }
  }

  /** Whether this server's file at a path is still as it was read (the moment between the hash and the rename). */
  private unchanged(sessionId: string, where: string, key: string | null): boolean {
    const full = resolveInSession(sessionId, where)
    if (!full) return false
    let stat: fs.Stats
    try {
      stat = workspaceFs.lstatSync(full)
    } catch {
      return key === null
    }
    if (stat.isDirectory()) return key === 'dir'
    return key === `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
  }

  /** Whether a reported path is one this server takes at all (§8.5, §8.6): the folder's own, and no cache of Python's. */
  private takes(sessionId: string, where: string): boolean {
    return normalizePath(where) === where && where !== '' && !where.split('/').includes('__pycache__') && resolveInSession(sessionId, where) !== null
  }

  /** The machine renamed `from` to `to` (§8.4): a movePath here when this server's files are still the base, with no upload. */
  private async rename(copy: Copy, from: string, to: string, sha: string): Promise<boolean> {
    if (!this.takes(copy.sessionId, from) || !this.takes(copy.sessionId, to)) return false
    if (this.hooks.isBook(copy.sessionId, from) || this.hooks.isBook(copy.sessionId, to)) return false
    const source = await this.homeState(copy.sessionId, from)
    const target = await this.homeState(copy.sessionId, to)
    if (source.sha !== sha || target.sha !== null) return false
    if (!this.unchanged(copy.sessionId, from, source.key) || movePath(copy.sessionId, from, to) !== 'ok') return false
    this.agreed(copy, from, null)
    this.agreed(copy, to, sha)
    this.dropPull(copy, from)
    this.dropPull(copy, to)
    for (const where of [from, to]) {
      copy.kept.delete(where)
      copy.fetched.delete(where)
    }
    return true
  }

  /** A removal on the machine (§8.4): done here while this server's is still the base; refused otherwise, and put back. */
  private async removal(copy: Copy, where: string, base: string): Promise<'accepted' | RemoteVerdictReason> {
    if (!this.takes(copy.sessionId, where)) return 'path'
    this.dropPull(copy, where)
    copy.onMachine.delete(where)
    if (this.hooks.isBook(copy.sessionId, where)) {
      // The notebook stays; the machine gets it back.
      this.agreed(copy, where, null)
      this.hooks.reproject(copy.sessionId)
      return 'book'
    }
    copy.kept.delete(where)
    const home = await this.homeState(copy.sessionId, where)
    if (home.sha === null) {
      this.agreed(copy, where, null)
      return 'accepted'
    }
    if (home.sha !== base) {
      // Replaced here since (or a file where a folder was): this server's goes back.
      this.agreed(copy, where, null)
      return 'base'
    }
    const full = resolveInSession(copy.sessionId, where)
    try {
      if (!full || !this.unchanged(copy.sessionId, where, home.key)) throw new Error('changed under the removal')
      // A folder only empty: what this server put in it since is this server's, and stays.
      if (home.sha === REMOTE_DIR_BASE) workspaceFs.rmSync(full, { recursive: false })
      else workspaceFs.unlinkSync(full)
    } catch {
      this.agreed(copy, where, null)
      return 'base'
    }
    this.agreed(copy, where, null)
    copy.fetched.delete(where)
    return 'accepted'
  }

  /**
   * A change on the machine (§8.4, §8.5): this server's file is still its
   * base → applied (inline now, or pulled), within the caps; the same
   * content here already → accepted; otherwise this server's version wins,
   * the machine's is kept as a conflict copy within the caps, and the copy
   * counts as holding the machine's version, so the next push puts this
   * server's back.
   */
  private async change(
    copy: Copy,
    seq: number,
    change: RemoteFilesReport['changed'][number],
    room: { bytes: number | null },
    now: number,
  ): Promise<'accepted' | 'pulled' | { path: string; why: RemoteVerdictReason; copy?: string }> {
    const where = change.path
    if (!this.takes(copy.sessionId, where)) return { path: where, why: 'path' }
    if (change.inline !== undefined) {
      const content = Buffer.from(change.inline, 'base64')
      if (content.length !== change.bytes || createHash('sha256').update(content).digest('hex') !== change.sha256) {
        this.log(`[files] ${copy.sessionId} on machine ${copy.runnerId}: ${where} came inline with bytes other than its report says; refused`)
        return { path: where, why: 'path' }
      }
    }
    if (this.hooks.isBook(copy.sessionId, where)) {
      this.dropPull(copy, where)
      this.agreed(copy, where, change.sha256)
      this.hooks.reproject(copy.sessionId)
      return { path: where, why: 'book' }
    }
    /*
     * A version brought with «Привезти» may be missing from the machine's own
     * record of what both sides agreed (it was a file the machine left
     * unhashed there), so a change of it comes with no base: it is a change
     * of the version brought, as long as no push of the path was acked since.
     */
    let base = change.base
    if (base !== null) copy.fetched.delete(where)
    else base = copy.fetched.get(where) ?? null
    const home = await this.homeState(copy.sessionId, where)
    if (home.sha === change.sha256) {
      // Both sides have it: nothing to move.
      this.dropPull(copy, where)
      copy.onMachine.delete(where)
      copy.kept.delete(where)
      copy.fetched.delete(where)
      this.agreed(copy, where, change.sha256)
      return 'accepted'
    }
    if (home.sha === REMOTE_DIR_BASE || home.sha === 'special' || base === REMOTE_DIR_BASE) {
      // A file where this server has a folder, or the other way round: the shape here wins, and goes back.
      this.dropPull(copy, where)
      this.agreed(copy, where, change.sha256)
      return { path: where, why: 'base' }
    }
    if (home.sha !== base) {
      copy.onMachine.delete(where)
      this.agreed(copy, where, change.sha256)
      if (home.sha === null) {
        // Deleted here: the delete holds (§8.4), and nothing comes back.
        this.dropPull(copy, where)
        this.say(copy.sessionId, 'deleted', where, tr('server.wasDeletedOnTheServerTheChanges.6230f9', { file: where }))
        return { path: where, why: 'base' }
      }
      return this.conflict(copy, seq, change, room, now)
    }
    // The base holds: the caps, then the bytes.
    copy.kept.delete(where)
    const limit = machineFileLimitBytes()
    if (change.bytes > limit) {
      this.overCap(copy, where, change, base, seq, 'size', now)
      return { path: where, why: 'cap' }
    }
    if (!this.fits(copy.sessionId, where, change.bytes, room, false)) {
      this.overCap(copy, where, change, base, seq, 'room', now)
      return { path: where, why: 'cap' }
    }
    copy.onMachine.delete(where)
    if (change.inline !== undefined) {
      if (!this.write(copy.sessionId, where, Buffer.from(change.inline, 'base64'), home.key)) {
        // Written here in the moment between: this server's stays, and goes back.
        this.agreed(copy, where, change.sha256)
        return { path: where, why: 'base' }
      }
      this.agreed(copy, where, change.sha256)
      copy.fetched.delete(where)
      return 'accepted'
    }
    copy.pulls.set(where, { path: where, sha256: change.sha256, bytes: change.bytes, base, seq, target: where, fetch: false, at: now })
    this.counts.pulls++
    this.wake(copy.runnerId)
    return 'pulled'
  }

  /**
   * Both sides changed it (§8.4): this server's version stays, and the
   * machine's is kept beside it as a conflict copy if it fits the caps — once.
   * The same change said again (its verdict lost, or the machine keeping its
   * version aside when this server's push came over it, which it says as a
   * change of the same base) is answered with the copy already kept, and no
   * second one. A copy whose bytes come by a pull is answered once they
   * landed: until then the machine keeps its version for the pull to send.
   */
  private async conflict(
    copy: Copy,
    seq: number,
    change: RemoteFilesReport['changed'][number],
    room: { bytes: number | null },
    now: number,
  ): Promise<'pulled' | { path: string; why: RemoteVerdictReason; copy?: string }> {
    const where = change.path
    const known = copy.kept.get(where)
    if (known && known.sha === change.sha256 && known.base === change.base) {
      const pull = copy.pulls.get(where)
      if (pull && pull.target !== where && pull.target === known.name) {
        if (!known.seqs.includes(seq)) known.seqs.push(seq)
        return 'pulled'
      }
      return known.name ? { path: where, why: 'base', copy: known.name } : { path: where, why: 'base' }
    }
    this.dropPull(copy, where)
    const name = conflictCopyName(copy.sessionId, where, now)
    if (!this.fits(copy.sessionId, name, change.bytes, room, false)) {
      this.keep(copy, where, { sha: change.sha256, base: change.base, name: null, seqs: [] })
      this.say(copy.sessionId, 'conflict', where, tr('server.wasChangedHereAndOnTheMachineNoCopy.c0eae4', { file: where }))
      return { path: where, why: 'base' }
    }
    if (change.inline !== undefined) {
      if (!this.write(copy.sessionId, name, Buffer.from(change.inline, 'base64'), null)) return { path: where, why: 'base' }
      this.keep(copy, where, { sha: change.sha256, base: change.base, name, seqs: [] })
      this.keptCopy(copy, where, name, now)
      return { path: where, why: 'base', copy: name }
    }
    copy.pulls.set(where, { path: where, sha256: change.sha256, bytes: change.bytes, base: change.base, seq, target: name, fetch: false, at: now })
    this.keep(copy, where, { sha: change.sha256, base: change.base, name, seqs: [seq] })
    this.counts.pulls++
    this.wake(copy.runnerId)
    // No refusal is said yet, but this server's version goes back all the same (apply puts back what it refuses).
    copy.dirty = true
    this.scheduleEager(copy, 0)
    return 'pulled'
  }

  /** A conflict copy remembered for its original (KEPT_MAX at most, the oldest let go). */
  private keep(copy: Copy, where: string, kept: Kept): void {
    copy.kept.delete(where)
    copy.kept.set(where, kept)
    if (copy.kept.size > KEPT_MAX) copy.kept.delete(copy.kept.keys().next().value!)
  }

  /**
   * A file over a cap stays on the machine (§8.5): its row says so, and the
   * kernel log says it once. `base`: what the change was made on, which
   * «Привезти» lands it against.
   */
  private overCap(copy: Copy, where: string, change: { sha256: string; bytes: number }, base: string | null, seq: number, why: 'size' | 'room', now: number): void {
    this.dropPull(copy, where)
    if (copy.onMachine.size < ON_MACHINE_MAX || copy.onMachine.has(where)) copy.onMachine.set(where, { bytes: change.bytes, why, sha256: change.sha256, base, seq, at: now })
    this.sayOverCap(copy, where, change.bytes, why)
  }

  private sayOverCap(copy: Copy, where: string, bytes: number, why: 'size' | 'room'): void {
    const limit = why === 'size' ? machineFileLimitBytes() : sessionLimitBytes()
    this.say(copy.sessionId, `cap:${bytes}`, where, tr('server.isOverTheLimitAndStaysOn.bf3362', { file: where, size: sizeWords(bytes), limit: sizeWords(limit) }))
  }

  /** A note of the kernel log, once per class, kind and path while it stands (NOTE_AGAIN_MS). */
  private say(sessionId: string, kind: string, where: string, text: string): void {
    const key = `${sessionId}\0${kind}\0${where}`
    const now = this.clock.now()
    const last = this.notes.get(key)
    if (last !== undefined && now - last < NOTE_AGAIN_MS) return
    const recent = (this.noted.get(sessionId) ?? []).filter((at) => now - at < NOTES_WINDOW_MS)
    if (recent.length >= NOTES_PER_CLASS) return
    this.noted.set(sessionId, [...recent, now])
    this.notes.set(key, now)
    if (this.notes.size > 10_000) this.notes.delete(this.notes.keys().next().value!)
    try {
      this.hooks.note(sessionId, text)
    } catch (error) {
      this.log(`[files] ${sessionId}: a note was not written: ${errorText(error)}`)
    }
  }

  /**
   * Whether `bytes` more at `where` fit the caps (§8.5): «Файл с машины —
   * до» (not for «Привезти»), and the room's limit — what the folder holds,
   * less what it held at that path, with what this report already let in.
   * A file that fits is counted in `room` from here. `staged`: the file's
   * own bytes, lying in the folder already under a temporary name (a pull
   * landing, upload.ts · receiveRoomFile), which are not counted twice.
   */
  private fits(sessionId: string, where: string, bytes: number, room: { bytes: number | null }, fetch: boolean, staged: string | null = null): boolean {
    if (!fetch && bytes > machineFileLimitBytes()) return false
    room.bytes ??= sessionBytes(sessionId) - (staged ? sizeOf(staged) : 0)
    const full = resolveInSession(sessionId, where)
    const there = full ? sizeOf(full) : 0
    if (room.bytes - there + bytes > sessionLimitBytes()) return false
    room.bytes += bytes - there
    return true
  }

  /** The machine's version kept beside this server's (§8.4): the row says whose it is, and the kernel log names it. */
  private keptCopy(copy: Copy, of: string, name: string, at: number): void {
    copy.conflicts.set(name, { of, at })
    this.say(copy.sessionId, 'conflict', of, tr('server.wasChangedHereAndOnTheMachine.107a60', { file: of, copy: baseOf(name) }))
    this.landed(copy.sessionId)
  }

  /**
   * Bytes to a path of the class folder (§8.6): through the anchored file
   * system, under a temporary name in the target's own folder, then a rename
   * — never through a link, never outside the folder. `key`: what this
   * server's file must still be at the moment of the rename (its stat), or
   * null for nothing there. Whether it landed.
   */
  private write(sessionId: string, where: string, content: Buffer, key: string | null): boolean {
    const full = resolveInSession(sessionId, where)
    if (!full) return false
    const dir = path.dirname(full)
    let tmp: string | null = null
    try {
      workspaceFs.mkdirSync(dir, { recursive: true })
      tmp = tempNameIn(dir)
      workspaceFs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o664 })
      if (!this.unchanged(sessionId, where, key)) throw new Error('changed under the write')
      workspaceFs.renameSync(tmp, full)
      tmp = null
      return true
    } catch (error) {
      this.log(`[files] ${sessionId}: ${where} did not land: ${errorText(error)}`)
      return false
    } finally {
      if (tmp !== null) {
        try {
          workspaceFs.rmSync(tmp, { force: true })
        } catch {
          /* a parent swapped under it: the sweep takes the temporary name */
        }
      }
    }
  }

  private dropPull(copy: Copy, where: string): void {
    copy.pulls.delete(where)
  }

  /** Files from a machine landed here: the tree is fresh at once, and the workspace hooks follow once the burst is over. */
  private landed(sessionId: string): void {
    forgetTree(sessionId)
    const due = this.hooksDue.get(sessionId)
    if (due !== undefined) this.clock.clearTimeout(due)
    this.hooksDue.set(sessionId, this.clock.setTimeout(() => {
      this.hooksDue.delete(sessionId)
      try {
        this.hooks.changed(sessionId)
      } catch (error) {
        this.log(`[files] ${sessionId}: the workspace hooks failed: ${errorText(error)}`)
      }
    }, HOOKS_MS))
  }

  /* ------------------------------------------------------------ the reply */

  /**
   * The files part of a class machine's reply (routes.ts · classesBlock):
   * each copy's newest unacked push, the verdicts not yet sent, the pulls
   * still wanted, the scans asked — within the contract's budgets for one
   * reply, the oldest first; what does not fit waits for the next reply. Pure
   * but for the copies it finds missing or placed anew (made or begun again
   * here, their push planned in the background): a held sync's reply is built
   * again and again.
   */
  replyBlock(runnerId: string): Pick<RemoteKernelsReply, 'pushes' | 'verdicts' | 'pulls' | 'scan' | 'replySeq'> {
    const copies = this.copiesOn(runnerId).filter((copy) => this.copies.get(copyKey(copy.sessionId, copy.runnerId)) === copy)
    const pushes: RemoteFilesPush[] = []
    let pushPaths = 0
    let inline = 0
    /*
     * A run's push first, then the oldest planned: each push within the
     * reply's budgets as it is — a push past them waits for the next reply,
     * which the agent's ack of this one brings at once, rather than lose its
     * inline files to a GET each.
     */
    const newest = copies.flatMap((copy) => {
      const push = copy.pushes.at(-1)
      return push ? [{ copy, push }] : []
    })
    newest.sort((a, b) => Number(b.push.promoted) - Number(a.push.promoted) || a.push.plannedAt - b.push.plannedAt)
    for (const { copy, push } of newest) {
      if (pushes.length >= REMOTE_PLACEMENTS_MAX) break
      const paths = push.put.length + push.remove.length + 2 * push.move.length
      const pushInline = inlineBytes(push)
      if (pushPaths + paths > REMOTE_PUSH_PATHS_MAX || inline + pushInline > CLASS_INLINE_PUSH_BYTES) continue
      pushPaths += paths
      inline += pushInline
      pushes.push({ sessionId: copy.sessionId, seq: push.seq, full: push.full, ...(push.promoted ? { promoted: true } : {}), put: push.put, remove: push.remove, move: push.move })
    }
    const verdicts: RemoteKernelsReply['verdicts'] = []
    let verdictPaths = 0
    for (const verdict of this.outbox.get(runnerId) ?? []) {
      const paths = verdict.accepted.length + verdict.refused.length
      if (verdicts.length >= REMOTE_PLACEMENTS_MAX || verdictPaths + paths > REMOTE_REPORT_PATHS_MAX) break
      verdictPaths += paths
      verdicts.push({ sessionId: verdict.sessionId, seq: verdict.seq, accepted: [...verdict.accepted], refused: verdict.refused.map((one) => ({ ...one })) })
    }
    const pulls: RemoteKernelsReply['pulls'] = []
    let pullPaths = 0
    for (const copy of copies) {
      if (copy.pulls.size === 0 || pulls.length >= REMOTE_PLACEMENTS_MAX) continue
      const paths: Array<{ path: string; sha256?: string }> = []
      for (const pull of copy.pulls.values()) {
        if (pullPaths >= REMOTE_REPORT_PATHS_MAX) break
        paths.push(pull.sha256 === null ? { path: pull.path } : { path: pull.path, sha256: pull.sha256 })
        pullPaths++
      }
      if (paths.length > 0) pulls.push({ sessionId: copy.sessionId, gen: this.genOf(copy), paths })
    }
    const scan: RemoteKernelsReply['scan'] = []
    for (const copy of copies) {
      if (scan.length >= REMOTE_PLACEMENTS_MAX) break
      if (copy.full.wanted) scan.push({ sessionId: copy.sessionId, full: true })
      else if (copy.scan.wanted) scan.push({ sessionId: copy.sessionId })
    }
    return { pushes, verdicts, pulls, scan }
  }

  /**
   * The reply went out (routes.ts · noteSent), numbered (`replySeq`): its
   * verdicts are said — and said again should the machine's next block say
   * it never took this reply in (heardReply) — its scans asked, its pushes
   * on their way: progress for a run at the barrier.
   */
  replySent(runnerId: string, block: Pick<RemoteKernelsReply, 'pushes' | 'verdicts' | 'scan' | 'replySeq'> | undefined, now = this.clock.now()): void {
    if (!block) return
    // Its number, which the machine's next block says back once it took this reply in (heardReply).
    block.replySeq = ++this.lastReply
    if (block.verdicts.length > 0) {
      const unheard = this.unheard.get(runnerId) ?? []
      unheard.push({ seq: block.replySeq, verdicts: block.verdicts.map((one) => ({ ...one, accepted: [...one.accepted], refused: one.refused.map((entry) => ({ ...entry })) })) })
      this.unheard.set(runnerId, unheard.slice(-UNHEARD_MAX))
    }
    const queued = this.outbox.get(runnerId) ?? []
    for (const sent of block.verdicts) {
      const at = queued.findIndex((one) => one.sessionId === sent.sessionId && one.seq === sent.seq)
      if (at < 0) continue
      // Only what went: a path decided for the same report after the reply was built waits for the next one.
      const one = queued[at]!
      const accepted = new Set(sent.accepted)
      const refused = new Set(sent.refused.map((entry) => entry.path))
      one.accepted = one.accepted.filter((where) => !accepted.has(where))
      one.refused = one.refused.filter((entry) => !refused.has(entry.path))
      if (one.accepted.length === 0 && one.refused.length === 0) queued.splice(at, 1)
    }
    if (queued.length === 0) this.outbox.delete(runnerId)
    for (const asked of block.scan) {
      const copy = this.copies.get(copyKey(asked.sessionId, runnerId))
      if (!copy || asked.full) continue
      copy.scan = { wanted: false, sentAt: now }
      // The pushes the machine has by now, this reply's among them, are applied before the scan runs.
      const carried = block.pushes.find((one) => one.sessionId === copy.sessionId)?.seq ?? null
      const flying = copy.pushes.filter((one) => one.sent).at(-1)?.seq ?? null
      const behind = carried === null && flying === null ? null : Math.max(carried ?? 0, flying ?? 0)
      for (const settle of copy.settles) {
        if (settle.scanAt !== null || settle.askedAt > now) continue
        settle.scanAt = now
        settle.behind = behind !== null && behind > copy.machineSeq ? behind : null
      }
      // The machine scans and reports in its own time: a settle waiting on it looks again once its answer could have come.
      if (copy.settles.size > 0) this.clock.setTimeout(() => this.settleLater(copy), SETTLE_QUIET_MS)
    }
    for (const sent of block.pushes) {
      const copy = this.copies.get(copyKey(sent.sessionId, runnerId))
      const push = copy?.pushes.find((one) => one.seq === sent.seq)
      if (!copy || !push || push.sent) continue
      push.sent = true
      copy.served = 0
      this.progress(copy)
    }
  }

  /**
   * What the machine's block says it took in (RemoteKernelsRequest.heard),
   * as it arrives: the verdicts of that reply were heard; those of every
   * other reply sent before this sync came were not — the agent cut the sync
   * short for news while its answer was on the way, or the answer was lost —
   * and go again in this sync's answer, once: a sync is sent only once the
   * one before it is done with, so a reply not heard by now never will be. A
   * block that says nothing (an agent before the field, or one yet to take
   * in a numbered reply) leaves them said once, as they were.
   */
  private heardReply(runnerId: string, heard: number | undefined): void {
    const unheard = this.unheard.get(runnerId)
    if (!unheard) return
    this.unheard.delete(runnerId)
    if (heard === undefined) return
    const lost = unheard.filter((reply) => reply.seq !== heard)
    if (lost.length === 0) return
    this.log(`[files] machine ${runnerId} never took in ${lost.length} repl${lost.length === 1 ? 'y' : 'ies'} with verdicts; they go again`)
    this.requeue(runnerId, lost.flatMap((reply) => reply.verdicts))
  }

  /**
   * Verdicts the machine never heard, back at the head of its queue. What was
   * decided since for a path of the same report stands, the newest over the
   * older: they are merged newest first, the queue's own first of all.
   */
  private requeue(runnerId: string, verdicts: Verdict[]): void {
    const queued = this.outbox.get(runnerId) ?? []
    const back: Verdict[] = []
    for (const lost of [...verdicts].reverse()) {
      // A copy begun again or gone says nothing more of its old reports (dropVerdicts).
      if (!this.copies.has(copyKey(lost.sessionId, runnerId))) continue
      const same = queued.find((one) => one.sessionId === lost.sessionId && one.seq === lost.seq) ?? back.find((one) => one.sessionId === lost.sessionId && one.seq === lost.seq)
      if (!same) {
        back.unshift({ sessionId: lost.sessionId, seq: lost.seq, accepted: [...lost.accepted], refused: lost.refused.map((entry) => ({ ...entry })) })
        continue
      }
      const decided = new Set([...same.accepted, ...same.refused.map((entry) => entry.path)])
      same.accepted = [...same.accepted, ...lost.accepted.filter((where) => !decided.has(where))]
      same.refused = [...same.refused, ...lost.refused.filter((entry) => !decided.has(entry.path))]
    }
    if (back.length > 0) this.outbox.set(runnerId, [...back, ...queued])
  }

  /* ------------------------------------------------------------- the blobs */

  /**
   * The `room` source of GET blobs/<sha256> (§15, blobs.ts): a file of a
   * class placed on the machine that an unacked push of its copy names by
   * that hash. Null — out of the machine's scope.
   */
  blobFor(runnerId: string, sha256: string): { sessionId: string; path: string; bytes: number; promoted: boolean } | null {
    this.live()
    const mine = [...this.copies.values()].filter((copy) => copy.runnerId === runnerId)
    if (mine.length === 0) return null
    // Only classes placed on the machine now: a machine failed over (lost, revoked) reaches none of its old classes' files.
    const placed = new Set(runnerPlacementRows(runnerId).map((row) => row.sessionId))
    for (const copy of mine) {
      if (!placed.has(copy.sessionId)) {
        this.dropCopy(copy)
        continue
      }
      for (const push of [...copy.pushes].reverse()) {
        const file = push.blobs.get(sha256)
        if (file) return { sessionId: copy.sessionId, path: file.path, bytes: file.bytes, promoted: push.promoted }
      }
    }
    return null
  }

  /** Bytes of a room blob went out to the machine: progress for its copy's barrier. */
  noteServed(runnerId: string, sha256: string, bytes: number): void {
    for (const copy of this.copies.values()) {
      if (copy.runnerId !== runnerId || !copy.pushes.some((push) => push.blobs.has(sha256))) continue
      copy.served += bytes
      this.progress(copy)
    }
  }

  /** The file a push names changed here before the machine fetched it (410): the push is planned again from a new walk. */
  blobGone(runnerId: string, sha256: string): void {
    for (const copy of [...this.copies.values()]) {
      if (copy.runnerId !== runnerId || !copy.pushes.some((push) => push.blobs.has(sha256))) continue
      // Changed under a walk that is still young, by a writer that forgot no tree: that walk is not the folder any more.
      copy.walk = null
      // A push the machine cannot complete is replaced, whatever waits on it: the agent drops one it cannot apply.
      void this.track(this.refresh(copy, copy.waiters.size > 0, true)).catch((error: unknown) => this.log(`[files] ${copy.sessionId}: ${errorText(error)}`))
    }
  }

  /* -------------------------------------------------------------- the PUT */

  /**
   * What the PUT door of a pulled file (upload.ts · receiveRoomFile, §8.3,
   * §15) is to take, asked before it reads a byte: the class must be placed
   * on the machine at that gen (else `stale`: a fenced gen, 409, or
   * `unknown`), and this server must wait for that very version of that
   * path. Where its bytes are staged and how large they may be come with it:
   * at most «Файл с машины — до», or the room's limit for «Привезти».
   */
  pullFor(runnerId: string, sessionId: string, where: string, gen: number, sha256: string, bytes: number): { target: string; cap: number } {
    this.live()
    if (!this.current(runnerId, sessionId, gen)) {
      // A gen of the class that is no longer this machine's (lost, or replaced by a newer one): the fence (§8.8). A gen the
      // class never had: nothing to send.
      const fenced = classPlacementRows(sessionId).some((row) => row.gen >= gen)
      throw new PullRefused(fenced ? 'stale' : 'unknown', fenced ? "This placement is no longer the class's current one" : 'No such class on this machine')
    }
    const pull = this.copies.get(copyKey(sessionId, runnerId))?.pulls.get(where)
    if (!pull) throw new PullRefused('unknown', 'This server did not ask for this file')
    // A version named: that one or none. None named («Привезти» of a file the machine never hashed): the file as it is.
    if (pull.sha256 !== null && (pull.sha256 !== sha256 || pull.bytes !== bytes)) throw new PullRefused('unknown', 'This server asked for another version of this file')
    const cap = pull.fetch ? sessionLimitBytes() : machineFileLimitBytes()
    if (bytes > cap) throw new PullRefused('over', 'The file is over its cap')
    return { target: pull.target, cap }
  }

  /**
   * A pulled file whose bytes were checked (sha256 and length after
   * decompression) and staged at `tmp` beside its target, into its place by
   * the rule of §8.4 — the fence and the pull asked again first: a loss while
   * the bytes came refuses them (`stale`). Its verdict goes out with the next
   * reply as well. The caller removes `tmp` whatever became of it.
   */
  landPulled(runnerId: string, sessionId: string, gen: number, where: string, sha256: string, tmp: string): Promise<RoomFileStored['verdict']> {
    return new Promise((resolve, reject) => {
      const copy = this.copies.get(copyKey(sessionId, runnerId))
      if (!copy) return reject(new PullRefused('stale', 'The class left this machine while its file came'))
      this.enqueue(copy, async () => {
        try {
          if (!this.current(runnerId, sessionId, gen) || this.copies.get(copyKey(sessionId, runnerId)) !== copy) {
            throw new PullRefused('stale', 'The class left this machine while its file came')
          }
          const asked = copy.pulls.get(where)
          if (!asked || (asked.sha256 !== null && asked.sha256 !== sha256)) throw new PullRefused('unknown', 'This server no longer waits for this version of the file')
          copy.pulls.delete(asked.path)
          const pull: Pull & { sha256: string } = { ...asked, sha256 }
          const verdict = await this.placePulled(copy, pull, tmp)
          if (pull.target === pull.path) {
            this.queueVerdict(copy, {
              sessionId,
              seq: pull.seq,
              accepted: verdict.accepted ? [pull.path] : [],
              refused: verdict.accepted ? [] : [{ path: pull.path, why: verdict.why, ...(verdict.copy ? { copy: verdict.copy } : {}) }],
            })
          } else {
            // A conflict copy's bytes landed, or did not fit after all: every report of that change hears it now, and the
            // machine lets its version go (it kept it for this pull).
            const kept = copy.kept.get(pull.path)
            const name = !verdict.accepted && verdict.copy ? verdict.copy : null
            const refused = { path: pull.path, why: 'base' as const, ...(name ? { copy: name } : {}) }
            const seqs = kept && kept.name === pull.target ? kept.seqs : [pull.seq]
            if (kept && kept.name === pull.target) {
              if (!name) kept.name = null
              kept.seqs = []
            }
            for (const seq of seqs) this.queueVerdict(copy, { sessionId, seq, accepted: [], refused: [refused] })
          }
          this.settleCheck(copy, this.clock.now())
          resolve(verdict)
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  private async placePulled(copy: Copy, pull: Pull & { sha256: string }, tmp: string): Promise<RoomFileStored['verdict']> {
    const now = this.clock.now()
    if (pull.target !== pull.path) {
      // The machine's version of a file both sides changed: kept as the copy this server named, if it still fits.
      const full = resolveInSession(copy.sessionId, pull.target)
      if (!full || !this.fits(copy.sessionId, pull.target, pull.bytes, { bytes: null }, false, tmp) || (await this.homeState(copy.sessionId, pull.target)).sha !== null) {
        return { accepted: false, why: 'base' }
      }
      if (!this.place(copy.sessionId, tmp, full)) return { accepted: false, why: 'base' }
      this.keptCopy(copy, pull.path, pull.target, now)
      return { accepted: false, why: 'base', copy: pull.target }
    }
    const home = await this.homeState(copy.sessionId, pull.path)
    if (home.sha === pull.sha256) {
      this.agreed(copy, pull.path, pull.sha256)
      copy.onMachine.delete(pull.path)
      if (pull.fetch) copy.fetched.set(pull.path, pull.sha256)
      return { accepted: true }
    }
    if (home.sha !== pull.base) {
      // Changed or deleted here while the bytes came: this server's wins, as with a report (§8.4).
      this.agreed(copy, pull.path, pull.sha256)
      copy.dirty = true
      this.scheduleEager(copy, 0)
      if (home.sha === null) {
        this.say(copy.sessionId, 'deleted', pull.path, tr('server.wasDeletedOnTheServerTheChanges.6230f9', { file: pull.path }))
        return { accepted: false, why: 'base' }
      }
      const name = conflictCopyName(copy.sessionId, pull.path, now)
      const full = resolveInSession(copy.sessionId, name)
      if (!full || !this.fits(copy.sessionId, name, pull.bytes, { bytes: null }, false, tmp) || !this.place(copy.sessionId, tmp, full)) {
        this.keep(copy, pull.path, { sha: pull.sha256, base: pull.base, name: null, seqs: [] })
        this.say(copy.sessionId, 'conflict', pull.path, tr('server.wasChangedHereAndOnTheMachineNoCopy.c0eae4', { file: pull.path }))
        return { accepted: false, why: 'base' }
      }
      this.keep(copy, pull.path, { sha: pull.sha256, base: pull.base, name, seqs: [] })
      this.keptCopy(copy, pull.path, name, now)
      return { accepted: false, why: 'base', copy: name }
    }
    if (!this.fits(copy.sessionId, pull.path, pull.bytes, { bytes: null }, pull.fetch, tmp)) {
      this.overCap(copy, pull.path, pull, pull.base, pull.seq, 'room', now)
      return { accepted: false, why: 'cap' }
    }
    const full = resolveInSession(copy.sessionId, pull.path)
    if (!full || !this.unchanged(copy.sessionId, pull.path, home.key) || !this.place(copy.sessionId, tmp, full)) {
      this.agreed(copy, pull.path, pull.sha256)
      copy.dirty = true
      this.scheduleEager(copy, 0)
      return { accepted: false, why: 'base' }
    }
    copy.onMachine.delete(pull.path)
    this.agreed(copy, pull.path, pull.sha256)
    if (pull.fetch) copy.fetched.set(pull.path, pull.sha256)
    else copy.fetched.delete(pull.path)
    this.landed(copy.sessionId)
    return { accepted: true }
  }

  /**
   * Staged bytes into their place (§8.6): the target's folders made only now,
   * once the bytes were checked, as this server's own writers make them —
   * a refused PUT leaves no empty folder in the room — then the rename, both
   * through the anchored file system. Whether it landed.
   */
  private place(sessionId: string, tmp: string, full: string): boolean {
    try {
      workspaceFs.mkdirSync(path.dirname(full), { recursive: true })
      workspaceFs.renameSync(tmp, full)
      return true
    } catch (error) {
      this.log(`[files] ${sessionId}: a file from a machine did not land: ${errorText(error)}`)
      return false
    }
  }

  /* --------------------------------------------------------------- settle */

  /**
   * THE PULL BARRIER (§8.7): ask every machine of the class for a scan and
   * wait until each answered it and every file that answer pulled has
   * landed (or been refused) — at most `timeoutMs`, each caller its own: a
   * download's ten seconds and the class end's two minutes share the scan,
   * never each other's deadline. Whether everything settled; a class with
   * nothing on machines is settled at once, and so is one whose last settle
   * settled a moment ago (a page build right after the class end's).
   */
  filesSettled(sessionId: string, timeoutMs: number): Promise<boolean> {
    this.live()
    const last = this.settledAt.get(sessionId)
    if (last !== undefined && this.clock.now() - last < SETTLED_FRESH_MS) return Promise.resolve(true)
    // Only machines that still call: one silent this long answers no scan, and its class's page or end does not wait for it.
    const calling = (runnerId: string): boolean => remoteNow() - (heardAt(runnerId) ?? Number.NEGATIVE_INFINITY) <= CLASS_EVIDENCE_MS
    const copies = [...this.hosts(sessionId).keys()]
      .filter(calling)
      .map((runnerId) => this.copyOf(sessionId, runnerId))
      .filter((copy): copy is Copy => copy !== null)
    if (copies.length === 0) return Promise.resolve(true)
    const askedAt = this.clock.now()
    const mine: Array<{ copy: Copy; waiter: SettleWaiter }> = []
    const settles = copies.map((copy) => new Promise<boolean>((resolve) => {
      const waiter: SettleWaiter = { askedAt, scanAt: null, behind: null, appliedAt: null, resolve }
      mine.push({ copy, waiter })
      copy.settles.add(waiter)
      copy.scan.wanted = true
      this.wake(copy.runnerId)
    }))
    return new Promise<boolean>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        for (const { copy, waiter } of mine) {
          if (!copy.settles.delete(waiter)) continue
          waiter.resolve(false)
        }
      }, timeoutMs)
      void Promise.all(settles).then((each) => {
        this.clock.clearTimeout(timer)
        const settled = each.every(Boolean)
        if (settled) this.settledAt.set(sessionId, this.clock.now())
        resolve(settled)
      })
    })
  }

  /**
   * A settle's scan had its time (SETTLE_QUIET_MS since it went out) and is
   * still not answered by a sync: the next reply asks again, which answers
   * the machine's held sync at once, so its next one — sent after the scan
   * had that time — comes now, not when the hold ends.
   */
  private settleLater(copy: Copy): void {
    if (this.copies.get(copyKey(copy.sessionId, copy.runnerId)) !== copy) return
    this.enqueue(copy, async () => {
      this.settleCheck(copy, this.clock.now())
      if (copy.settles.size === 0 || copy.scan.wanted) return
      copy.scan.wanted = true
      this.wake(copy.runnerId)
    })
  }

  /**
   * A settle of the copy is done (§8.7) once its scan was answered: a sync
   * arrived at least SETTLE_QUIET_MS after the scan went out and after the
   * machine applied the pushes it had by then (the agent applies pushes
   * before it scans), the machine says nothing of the class is pending there
   * (its lag), and nothing a kernel wrote is still on its way here. The agent
   * scans in its own time and says nothing when nothing changed, so it is the
   * time a sync was sent at that says the scan had its time — a sync crossing
   * the scan says nothing of it.
   */
  private settleCheck(copy: Copy, now: number): void {
    // What a kernel wrote, not what staff asked to bring (a «Привезти» of gigabytes comes in its own time).
    const pulling = [...copy.pulls.values()].some((pull) => !pull.fetch)
    if (pulling || copy.syncAt === null || (copy.lag?.pending ?? 0) > 0) return
    for (const waiter of [...copy.settles]) {
      // Its scan has not gone out yet (a reply carries it next).
      if (waiter.scanAt === null || now < waiter.scanAt) continue
      if (waiter.behind !== null && copy.machineSeq < waiter.behind) continue
      const ranFrom = Math.max(waiter.scanAt, waiter.appliedAt ?? 0)
      if (copy.syncAt < ranFrom + SETTLE_QUIET_MS) continue
      copy.settles.delete(waiter)
      waiter.resolve(true)
    }
  }

  /** Whether a newer version of the path, or of anything under it, is on its way from a machine: a download or a move waits for it. */
  pendingUnder(sessionId: string, where: string): boolean {
    for (const copy of this.liveCopies(sessionId)) for (const pull of copy.pulls.values()) if (isInside(pull.path, where)) return true
    return false
  }

  /** Ask the machine of a slot for a scan now: after every cell or attempt there (§8.3). */
  askScan(sessionId: string, runnerId: string): void {
    const copy = this.copyOf(sessionId, runnerId)
    if (!copy || copy.scan.wanted) return
    copy.scan.wanted = true
    this.wake(runnerId)
  }

  /* ---------------------------------------------------------- «Привезти» */

  /**
   * «Привезти» (§8.5): pull one file that stays on a machine of the class,
   * over «Файл с машины — до» if it must, within the room's limit. The room
   * hears of it from the tree once it lands. `brought` — no machine keeps it
   * aside any more and the file is here (it landed before the press was
   * read). Words when it cannot be.
   */
  fetch(sessionId: string, where: string): { ok: true } | { brought: true } | { refused: string } {
    this.live()
    const normal = normalizePath(where)
    if (!normal) return { refused: tr('server.thisFileIsNotOnTheClassMachines.0fd59f') }
    for (const runnerId of this.hosts(sessionId).keys()) {
      const copy = this.copyOf(sessionId, runnerId)
      const held = copy?.onMachine.get(normal)
      if (!copy || !held) continue
      // A package tree's file comes with its tree or not at all; any other is brought as it is (by its hash, when it was told one).
      if (held.why === 'package') return { refused: tr('server.thisFileCannotBeBroughtFromThe.148a43') }
      // One the proxy in front of this server refused would meet the same refusal: its administrator raises the limit first.
      if (held.why === 'proxy') return { refused: tr('server.cannotBeBroughtHereTheProxyIn.fc1eca', { file: normal }) }
      if (copy.pulls.has(normal)) return { ok: true }
      let fits = true
      try {
        fits = this.fits(sessionId, normal, held.bytes, { bytes: null }, true)
      } catch {
        fits = true
      }
      if (!fits) {
        return { refused: tr('server.doesNotFitTheClassLimit.39ab91', { file: normal, size: sizeWords(held.bytes), limit: sizeWords(sessionLimitBytes()) }) }
      }
      /*
       * It lands on what it was made from: the base of the change refused for
       * a cap, or what both sides last agreed of the path — so a newer version
       * of a file this server has replaces it while this server's is still
       * that, and is kept beside it as a conflict copy otherwise.
       */
      const base = held.base ?? copy.acked?.get(normal) ?? null
      copy.pulls.set(normal, { path: normal, sha256: held.sha256, bytes: held.bytes, base, seq: held.seq, target: normal, fetch: true, at: this.clock.now() })
      this.counts.pulls++
      this.log(`[files] ${sessionId}: ${normal} (${held.bytes} bytes) brought from machine ${runnerId} by staff`)
      this.wake(runnerId)
      return { ok: true }
    }
    if (isFileHere(sessionId, normal)) return { brought: true }
    return { refused: tr('server.thisFileIsNotOnTheClassMachines.0fd59f') }
  }

  /**
   * Delete of a row only a machine of the class has («на машине», Z6): the
   * file, or a folder made up of such rows, goes on that machine. A remove of
   * the path rides the copy's next push, planned now, and the row goes once
   * that push is acked or the machine reports the path gone first (noteAck,
   * `released`). Whether any copy keeps something at or under the path:
   * false — no such row here, and the caller's own refusal stands. Rights are
   * the caller's: this server's delete doors (control.ts · tree:remove,
   * routes/files.ts) refuse students here as they do for any file.
   */
  removeOnMachine(sessionId: string, where: string): boolean {
    this.live()
    const normal = normalizePath(where)
    if (!normal) return false
    let any = false
    for (const copy of this.liveCopies(sessionId)) {
      if (![...copy.onMachine.keys()].some((held) => isInside(held, normal))) continue
      any = true
      copy.drops.add(normal)
      // What was on its way from under it is not wanted any more: the delete holds (§8.4).
      for (const pull of [...copy.pulls.values()]) if (isInside(pull.path, normal)) this.dropPull(copy, pull.path)
      copy.dirty = true
      this.log(`[files] ${sessionId}: ${normal} deleted by staff on machine ${copy.runnerId}, where alone it was`)
      this.scheduleEager(copy, 0)
    }
    return any
  }

  /* ---------------------------------------------------------------- views */

  /**
   * The room's tree with the rows of its class folders on machines
   * (shared/protocol.ts · FileEntry): a file on its way is `pending`, a
   * conflict copy says whose it is, a file that stays on a machine has a row
   * of its own (`onMachine`, its folders made up when this server has none),
   * and every package tree is one row. In the tree's own order. The tree as
   * it is, the same object, for a class with none of these.
   */
  treeOverlay(sessionId: string, tree: FileTree): FileTree {
    const copies = this.liveCopies(sessionId)
    if (copies.every((copy) => copy.pulls.size === 0 && copy.conflicts.size === 0 && copy.onMachine.size === 0)) return tree
    const byPath = new Map<string, FileEntry>()
    for (const entry of tree.files) byPath.set(entry.path, entry)
    const marked = new Map<string, FileEntry>()
    const mark = (where: string, patch: Partial<FileEntry>): void => {
      const entry = marked.get(where) ?? byPath.get(where)
      if (entry) marked.set(where, { ...entry, ...patch })
    }
    for (const copy of copies) {
      for (const pull of copy.pulls.values()) if (pull.target === pull.path) mark(pull.path, { pending: true })
      for (const [name, conflict] of copy.conflicts) mark(name, { conflict: { ...conflict } })
    }
    const added = new Map<string, FileEntry>()
    let truncated = tree.truncated
    const packages = new Map<string, number>()
    /** Its folders, where this server has none of them: rows of the machine's too. */
    const folders = (where: string, at: number, why: RemoteSkipReason): void => {
      for (let dir = parentOf(where); dir !== '' && !byPath.has(dir) && !added.has(dir); dir = parentOf(dir)) {
        added.set(dir, { name: baseOf(dir), path: dir, dir: true, size: 0, modifiedAt: at, onMachine: { bytes: 0, why } })
      }
    }
    for (const copy of copies) {
      for (const [where, held] of copy.onMachine) {
        if (held.why === 'package') {
          packages.set(where, held.bytes)
          continue
        }
        const here = byPath.get(where)
        if (here) {
          /*
           * Another version of a file this server has stays on the machine,
           * over a cap: the row says so, and «Привезти» brings it. Known for a
           * change this server refused (its hash), guessed by the size for one
           * the machine left unhashed (it skips a large file whatever it is).
           */
          const other = held.sha256 !== null || held.bytes !== here.size
          if (!here.dir && held.why !== 'count' && other) mark(where, { newer: { bytes: held.bytes, why: held.why }, ...(copies.some((one) => one.pulls.has(where)) ? { pending: true as const } : {}) })
          continue
        }
        if (added.has(where)) continue
        if (added.size >= OVERLAY_ROWS_MAX) {
          truncated = true
          continue
        }
        // «Привезти» pressed: on its way here.
        const coming = copies.some((one) => one.pulls.has(where))
        added.set(where, { name: baseOf(where), path: where, dir: false, size: held.bytes, modifiedAt: held.at, onMachine: { bytes: held.bytes, why: held.why }, ...(coming ? { pending: true as const } : {}) })
        folders(where, held.at, held.why)
      }
    }
    // One row per folder the packages went to, under every folder of it this server lacks.
    for (const [folder, pack] of packageRows(packages)) {
      const where = folder ? `${folder}/${PACKAGES_ROW}` : PACKAGES_ROW
      folders(where, 0, 'package')
      added.set(where, { name: PACKAGES_ROW, path: where, dir: false, size: pack.bytes, modifiedAt: 0, kind: 'packages', bytes: pack.bytes, count: pack.count, onMachine: { bytes: pack.bytes, why: 'package' } })
    }
    if (marked.size === 0 && added.size === 0) return tree
    const files = tree.files.map((entry) => marked.get(entry.path) ?? entry)
    return { files: added.size === 0 ? files : treeOrder([...files, ...added.values()]), truncated }
  }

  /**
   * How far the class's copy on the machine is from this server, as this
   * server sees it (§8.7, «Работают сейчас»): the push the copy applied,
   * the files on their way here, the files that stay there. Null — no copy.
   */
  filesLag(sessionId: string, runnerId: string): RemoteFilesLag | null {
    const copy = this.copies.get(copyKey(sessionId, runnerId))
    if (!copy) return null
    let pendingBytes = 0
    for (const pull of copy.pulls.values()) pendingBytes += pull.bytes
    let heldOnlyBytes = 0
    for (const held of copy.onMachine.values()) heldOnlyBytes += held.bytes
    return {
      pushSeq: copy.machineSeq,
      pending: Math.max(copy.pulls.size, copy.lag?.pending ?? 0),
      pendingBytes: Math.max(pendingBytes, copy.lag?.pendingBytes ?? 0),
      heldOnly: copy.onMachine.size,
      heldOnlyBytes,
    }
  }

  /** When the class's copy on the machine was last in step with this server (its newest push acked): failover's «файлы — по 14:31:58». */
  filesSyncedAt(sessionId: string, runnerId: string): number | null {
    return this.copies.get(copyKey(sessionId, runnerId))?.syncedAt ?? null
  }

  /** Whether the class's copy on the machine was heard from in this life: a sync of the machine's came since it was known here. */
  heardFrom(sessionId: string, runnerId: string): boolean {
    return (this.copies.get(copyKey(sessionId, runnerId))?.syncAt ?? null) !== null
  }
}

/* ---------------------------------------------------------------- helpers */

const depthOf = (where: string): number => (where === '' ? 0 : where.split('/').length)

/** Moves, then removes, then puts (the agent's order, §8.2). */
function effectRank(effect: Effect, moves: readonly { from: string; to: string }[]): number {
  if (moves.some((one) => one.from === effect.path || one.to === effect.path)) return 0
  return effect.kind === 'remove' ? 1 : 2
}

/** What the copy holds after one step: a removal takes everything under the path with it, and so does a file put where a folder was. */
function applyEffect(acked: Map<string, string>, effect: Effect): void {
  if (effect.kind === 'put') {
    if (effect.sha !== REMOTE_DIR_BASE && acked.get(effect.path) === REMOTE_DIR_BASE) {
      for (const where of [...acked.keys()]) if (where !== effect.path && isInside(where, effect.path)) acked.delete(where)
    }
    acked.set(effect.path, effect.sha)
    return
  }
  for (const where of [...acked.keys()]) if (isInside(where, effect.path)) acked.delete(where)
}

/** The bytes a push carries inline. */
function inlineBytes(push: Pick<Push, 'put'>): number {
  return push.put.reduce((sum, entry) => sum + (entry.inline !== undefined ? (entry.bytes ?? 0) : 0), 0)
}

/** Whether a path of the class folder is a file here, through the anchored file system (a link is none). */
function isFileHere(sessionId: string, where: string): boolean {
  const full = resolveInSession(sessionId, where)
  if (!full) return false
  try {
    return workspaceFs.lstatSync(full).isFile()
  } catch {
    return false
  }
}

/** A file's length through the anchored file system (a link's own), 0 for nothing there. */
function sizeOf(full: string): number {
  try {
    return workspaceFs.lstatSync(full).size
  } catch {
    return 0
  }
}

/** The gens a reply names the class's slots on a machine at: every live row but a stopping one (placement.ts · wantedPlacements). */
function namedGens(rows: readonly PlacementRow[]): Partial<Record<RoomRole, number>> {
  const out: Partial<Record<RoomRole, number>> = {}
  for (const row of rows) if (row.state !== 'stopping') out[row.role] = row.gen
  return out
}

/**
 * Whether home names the class on a machine at gens its copy there never
 * served, the agent's rule for another life of the class
 * (runner-agent/room-files.ts · reconcile, where the copy is kept and no push
 * is said applied until home's next one lands): some gens recorded, some
 * named, and no slot named at the gen recorded for it. A gen of a slot only
 * ever grows, and a stopped one is never named again, so none comes back.
 */
function anotherLife(recorded: Partial<Record<RoomRole, number>>, named: Partial<Record<RoomRole, number>>): boolean {
  const roles = Object.keys(named) as RoomRole[]
  if (roles.length === 0 || Object.keys(recorded).length === 0) return false
  return !roles.some((role) => recorded[role] === named[role])
}

/** A small file of the class folder, whole, through the anchored file system; null — gone, a link, or over `max`. */
function readWhole(sessionId: string, where: string, max: number): Buffer | null {
  const full = resolveInSession(sessionId, where)
  if (!full) return null
  let held: ReturnType<typeof workspaceFs.openRead>
  try {
    held = workspaceFs.openRead(full)
  } catch {
    return null
  }
  try {
    const stat = fs.fstatSync(held.fd)
    if (stat.size > max) return null
    const buf = Buffer.alloc(stat.size)
    const read = fs.readSync(held.fd, buf, 0, buf.length, 0)
    return buf.subarray(0, read)
  } catch {
    return null
  } finally {
    held.close()
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A package's own record folder (§8.5): `*.dist-info` or `*.egg-info`, whose parent is where `pip install -t` put it. */
const RECORD_FOLDER = /\.(?:dist|egg)-info$/

/**
 * The paths of package trees on a machine, as rows: one per folder the
 * packages went to (`pip install -t .` → the class's top, `-t lib` → `lib`),
 * which is the parent of a package's record folder. Paths of no install the
 * record folders name go to the folder all of them share.
 */
function packageRows(paths: Map<string, number>): Map<string, { bytes: number; count: number }> {
  const targets = new Set<string>()
  for (const where of paths.keys()) {
    const parts = where.split('/')
    const at = parts.findIndex((part) => RECORD_FOLDER.test(part))
    if (at >= 0) targets.add(parts.slice(0, at).join('/'))
  }
  const ordered = [...targets].sort((a, b) => depthOf(b) - depthOf(a))
  const rest: string[] = []
  const out = new Map<string, { bytes: number; count: number }>()
  const add = (folder: string, bytes: number): void => {
    const known = out.get(folder) ?? { bytes: 0, count: 0 }
    out.set(folder, { bytes: known.bytes + bytes, count: known.count + 1 })
  }
  for (const [where, bytes] of paths) {
    const target = ordered.find((folder) => folder === '' || isInside(where, folder))
    if (target !== undefined) add(target, bytes)
    else rest.push(where)
  }
  if (rest.length > 0) {
    let shared = parentOf(rest[0]!)
    for (const where of rest) while (shared !== '' && !isInside(where, shared)) shared = parentOf(shared)
    for (const where of rest) add(shared, paths.get(where)!)
  }
  return out
}

/** The tree's own order (workspace.ts · walkTree): depth first, folders before files at every level, each by name. */
function treeOrder(entries: FileEntry[]): FileEntry[] {
  const children = new Map<string, FileEntry[]>()
  for (const entry of entries) {
    const parent = parentOf(entry.path)
    children.set(parent, [...(children.get(parent) ?? []), entry])
  }
  const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name)
  const out: FileEntry[] = []
  const emit = (dir: string): void => {
    const here = children.get(dir) ?? []
    for (const entry of [...here.filter((one) => one.dir).sort(byName), ...here.filter((one) => !one.dir).sort(byName)]) {
      out.push(entry)
      if (entry.dir) emit(entry.path)
    }
  }
  emit('')
  return out
}

/* ------------------------------------------------------------ the process */

let current: ClassFiles | null = null
let hooksGiven: Partial<FilesHooks> = {}

/** This process's class folders on machines. */
export function classFiles(): ClassFiles {
  if (!current) {
    current = new ClassFiles()
    current.useHooks(hooksGiven)
  }
  return current
}

/** For tests and harnesses: the process's class folders become these (null — a fresh default at the next use). */
export function useClassFiles(next: ClassFiles | null): void {
  if (current && current !== next) current.close()
  current = next
  current?.useHooks(hooksGiven)
}

/** The rest of the server, as control.ts hands it over at load: kept for whichever instance stands here later. */
export function useFilesHooks(hooks: Partial<FilesHooks>): void {
  hooksGiven = { ...hooksGiven, ...hooks }
  current?.useHooks(hooksGiven)
}

/* The shared names of this wave, as functions of the process's class folders. */

export const filesBarrier = (sessionId: string, runnerId: string, options?: BarrierOptions): Promise<void> =>
  classFiles().filesBarrier(sessionId, runnerId, options)

/** The machine a slot of the class computes on now, or null: here, or only being stopped there. One indexed read. */
export function slotMachine(sessionId: string, role: RoomRole): string | null {
  if (!hasLivePlacement(sessionId, role)) return null
  const row = livePlacement(sessionId, role)
  return row && row.state !== 'stopping' ? row.runnerId : null
}

export const slotOnMachine = (sessionId: string, role: RoomRole): boolean => slotMachine(sessionId, role) !== null

/** The barrier for a slot of the class (§8.2): on its machine when it has one, nothing at all here. */
export function slotFilesBarrier(sessionId: string, role: RoomRole, options?: BarrierOptions): Promise<void> {
  const runnerId = slotMachine(sessionId, role)
  return runnerId ? classFiles().filesBarrier(sessionId, runnerId, options) : Promise.resolve()
}

/** After a cell, an attempt or a script on a machine: its writes are reported now, not at the agent's next scan (§8.3). */
export function askSlotScan(sessionId: string, role: RoomRole): void {
  const runnerId = slotMachine(sessionId, role)
  if (runnerId) classFiles().askScan(sessionId, runnerId)
}
export const filesSettled = (sessionId: string, timeoutMs: number): Promise<boolean> => classFiles().filesSettled(sessionId, timeoutMs)
export const askFilesScan = (sessionId: string, runnerId: string): void => classFiles().askScan(sessionId, runnerId)
export const filesPendingUnder = (sessionId: string, where: string): boolean => classFiles().pendingUnder(sessionId, where)
export const fetchFromMachine = (sessionId: string, where: string): { ok: true } | { brought: true } | { refused: string } => classFiles().fetch(sessionId, where)
/** Delete of a row only a machine has: removed there (ClassFiles#removeOnMachine); false — no such row. */
export const removeOnMachine = (sessionId: string, where: string): boolean => current?.removeOnMachine(sessionId, where) ?? false
export const filesLag = (sessionId: string, runnerId: string): RemoteFilesLag | null => classFiles().filesLag(sessionId, runnerId)
export const filesSyncedAt = (sessionId: string, runnerId: string): number | null => classFiles().filesSyncedAt(sessionId, runnerId)
/** Whether a move off the machine has anything to wait for from it (placement.ts · moveNow): its copy of the class was heard from. */
export const filesHeardFrom = (sessionId: string, runnerId: string): boolean => current?.heardFrom(sessionId, runnerId) ?? false
/** News of the class's placements, as kernel/index.ts hears it: copies whose slots left their machine go, with their runs at the barrier. */
export const filesPlacementChanged = (sessionId: string): void => current?.placementChanged(sessionId)

/*
 * Wired to the rest of this server as this module loads: a write here pushes
 * to the class's machines (workspace.ts · onTreeForgotten), and the room's
 * tree shows the machines' rows (workspace.ts · roomTree), whichever
 * instance stands behind classFiles() then.
 */
onTreeForgotten((sessionId) => current?.treeChanged(sessionId))
useTreeOverlay((sessionId, tree) => (current ? current.treeOverlay(sessionId, tree) : tree))
