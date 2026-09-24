import type { CompetitionCapabilities } from './capabilities.js'
/**
 * What the teacher's panel asks the server about competitions, and what it
 * answers.
 *
 * A file separate from `shared/competitions.ts` on purpose: that one holds the
 * rules by which the server and the browser must give the same answer, this
 * one the shape of the wires. The shape changes with the screen (a column
 * added means a field added), the rules do not change at all, and keeping
 * them in one file would mean revisiting the rules every time a label moved
 * in the mockup.
 *
 * Not a single row from here travels to a participant: these are the answers
 * of the `/api/admin` doors, and they carry the metric code, private numbers
 * and sign-in keys. Participants are answered by their own `/k` doors, with
 * their own types and through `publicCompetition`.
 */
import type {
  Competition,
  CompetitionFile,
  CompetitionLimits,
  Entrant,
  MetricDirection,
  PrivateRelease,
  RankedRow,
  RunKind,
  ScoringRule,
  Submission,
  SubmissionRun,
  SubmissionState,
} from './competitions.js'

/* -------------------------------------------------------------- requests */

/**
 * What the editor form (A2) sends to the server.
 *
 * Everything is optional, and that is not laziness: the panel sends ONLY the
 * fields it showed. The draft editor and the "Settings" tab of a running
 * competition are different pieces of one form, and "save everything" would
 * mean the second one wipes fields it has never seen.
 */
export interface CompetitionInput {
  slug?: string
  title?: string
  blurb?: string
  description?: string
  metric?: { name?: string; direction?: MetricDirection; code?: string }
  publicPercent?: number
  limits?: Partial<CompetitionLimits>
  environment?: string
  startsAt?: number | null
  deadlineAt?: number | null
  privateRelease?: PrivateRelease
  scoring?: ScoringRule
}

/* --------------------------------------------------------- list and queue */

/**
 * Why the competition cannot be opened yet.
 *
 * A reason, not `false`: the "OPEN COMPETITION" button in A2 goes dim
 * silently, and a person who is missing one answers file hunts for the gap by
 * eye across six sections. The server computes it — it is also the one that
 * refuses — so that the screen and the door do not disagree about readiness.
 */
export type OpenRefusal =
  | 'noData'
  | 'noSolution'
  | 'noMetric'
  | 'noBaseline'
  /** The sample notebook is uploaded but has not yet gone the whole way to a number. */
  | 'baselineNotChecked'
  /** The private leaderboard is opened by the deadline, and there is no deadline. */
  | 'noDeadline'

/** A row of the A1 list — a competition plus everything its row draws as numbers. */
export interface CompetitionRow {
  competition: Competition
  /** People who sent at least one submission. The baseline solution is not counted here. */
  entrants: number
  /** Participants' submissions — without the sample notebook's runs. */
  submissions: number
  /** "BEST PUBLIC" — without the baseline solution: that one is shown separately beside it. */
  bestPublic: number | null
  /** "baseline 0.0587" under the best result. */
  baselineScore: number | null
  /** How the sample notebook's last run ended; null — it has not been checked yet. */
  baselineState: SubmissionState | null
  /** `null` — it can be opened. */
  ready: OpenRefusal | null
}

/** A run in progress — the "RUNNING NOW" block (A3) and the runner strip (A1). */
export interface RunningNow {
  submissionId: string
  competitionId: string
  competitionSlug: string
  entrantId: string
  entrantName: string
  /** "#12". */
  number: number
  fileName: string
  kind: RunKind
  cellsDone: number
  cellsTotal: number
  startedAt: number
  /** The right half of "01:12 of 10:00", in milliseconds. */
  limitMs: number
  /** The container's name — the same string as in the caption under the progress bar. */
  container: string | null
  /** A run of the sample notebook, not a participant's submission. */
  baseline: boolean
}

/** A row of the "WAITING · N" list. */
export interface WaitingRow {
  submissionId: string
  competitionId: string
  entrantId: string
  entrantName: string
  number: number
  /** Delayed resource retries have no claimable place yet. */
  place: number | null
  /** "≈ 3 min"; null — nothing to estimate from (nothing has run yet). */
  etaMs: number | null
  resourcePending: boolean
  baseline: boolean
}

/**
 * The instance queue — one for all competitions, because there is one runner.
 *
 * It travels both with the A1 list (the runner strip) and with the live state
 * of A3: it is one and the same machinery, and it must not be shown as two
 * different numbers.
 */
export interface QueueSnapshot {
  paused: boolean
  pausedAt: number | null
  running: RunningNow[]
  waiting: number
  /** How many submissions the runner takes at a time. */
  slots: number
  /** "37 run today" — by the machine's local time zone. */
  doneToday: number
  /** "2 min 40 s on average"; null — nothing has finished today yet. */
  averageMs: number | null
}

export interface CompetitionsList {
  competitions: CompetitionRow[]
  queue: QueueSnapshot
}

/* ------------------------------------------------------------ editor (A2) */

/** An open data file or an answers file, as A2 sees it. */
export interface FileView extends CompetitionFile {
  /** CSV columns — "397 rows · id, orders". null: not CSV, or the file is too big. */
  columns: string[] | null
}

/** The card of the sample notebook and of its check. */
export interface BaselineView {
  inputsCurrent?: boolean
  inputRevision?: number | null
  notebookInputRevision?: number | null
  fileName: string
  bytes: number
  /** "14 cells"; null — the file did not parse as a notebook. */
  cells: number | null
  uploadedAt: number
  /** The submission of the last run; null — the notebook is uploaded but was not checked. */
  submissionId: string | null
  state: SubmissionState | null
  publicScore: number | null
  privateScore: number | null
  durationMs: number | null
  /** The text a participant would read: the metric's ParticipantVisibleError. */
  participantError: string | null
  /** The traceback — for the teacher only, and only here. */
  teacherError: string | null
}

/** How the answer rows will be split: "119 rows count right away, 278 after the deadline". */
export interface SplitView {
  total: number
  publicRows: number
  privateRows: number
  /** The split is set by the Usage column in the answers file, not by the seed. */
  byUsage: boolean
}

export interface CompetitionView {
  capabilities?: CompetitionCapabilities
  competition: Competition
  openFiles: FileView[]
  /** Hidden answers: names, rows and columns — the contents are never handed out. */
  hiddenFiles: FileView[]
  baseline: BaselineView | null
  split: SplitView | null
  counts: CompetitionCounts
  ready: OpenRefusal | null
  /** How much the open files weigh against the `LIMITS.dataBytes` ceiling. */
  dataBytes: number
}

/* --------------------------------------------------------- live competition */

/** The five numbers of the A3 summary plus what the A1 row needs. */
export interface CompetitionCounts {
  submissions: number
  /** "REACHED A SCORE". */
  scored: number
  notebookFailed: number
  rejected: number
  timedOut: number
  outOfMemory: number
  metricFailed: number
  cancelled: number
  entrants: number
  bestPublic: number | null
}

/** A row of the submission feed (A3). */
export interface SubmissionRow {
  submission: Submission
  entrantName: string
  /** A run of the sample notebook: it is in the feed, but it does not count as a participant's. */
  baseline: boolean
  /** The competition's best public result — "a new best result". */
  best: boolean
}

export interface SubmissionFeed {
  rows: SubmissionRow[]
  /** How many rows match the filter in total — for "and N more". */
  total: number
}

/** The live state of the A3 screen: what changes by itself while someone watches it. */
export interface CompetitionLive {
  revision?: number
  counts: CompetitionCounts
  queue: QueueSnapshot
  /** Those waiting in THIS competition; the queue is shared, but the screen is about one. */
  waiting: WaitingRow[]
  /** Median run time of this competition's submissions, ms. */
  medianMs: number | null
}

/** All the output of one submission — the row menu, the "All output" item. */
export interface SubmissionDetail {
  submission: Submission
  entrant: Pick<Entrant, 'id' | 'name'>
  runs: SubmissionRun[]
  /** Files left over from the run: `run.json`, `submission.csv`, the notebook with output. */
  artifacts: { name: string; bytes: number }[]
}

/* ---------------------------------------------------------- participants */

/**
 * A participant in the teacher's list — together with the sign-in key.
 *
 * The key is here on purpose: it is dictated aloud and pasted into the course
 * chat, and it is the only way to bring a person back from another device.
 * The door that hands it out is a panel door (`requireStaff`), and there is
 * no other place in the product where the key is visible.
 */
export interface EntrantRow extends Entrant {
  /**
   * `K7Q-M2X-9FD` — the decrypted sign-in key; null if the instance secret was
   * changed and the old key no longer works for anyone.
   */
  key: string | null
  /** Submissions in this competition; in the instance-wide list — 0. */
  submissions: number
  /** Place on this competition's public leaderboard; null — they are not on it. */
  place: number | null
  /** The sample notebook is recorded under a service participant — never shown to people. */
  baseline: boolean
}

export interface EntrantsList {
  entrants: EntrantRow[]
}

/** Full authoritative standings, independent of submission feed pagination. */
export interface CompetitionLeaderboard {
  baseline?: BaselineView | null
  revision: number
  public: (RankedRow & { entrantName: string })[]
  private: (RankedRow & { entrantName: string })[]
}
