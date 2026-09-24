import type { CompetitionCapabilities } from './capabilities.js'
/**
 * What the `/k` pages ask the server and what it answers.
 *
 * Kept apart from `shared/competitions-api.ts` along the same border that
 * separates the doors: there live the `/api/admin` answers — with the metric
 * code, private numbers and sign-in keys; here the `/api/k` answers — what may
 * be shown to anyone who has the competition's address. One file for both
 * sets would mean that a field added to a panel row travels to the
 * participant silently.
 *
 * The types are shared by the server and the browser on purpose: a
 * participant's screen and the door that feeds it drift apart quietly — the
 * answer becomes one field shorter, the page draws `undefined` in the spot
 * where a value was, and nobody notices anything until the class.
 */
import type {
  CompetitionPublic,
  Entrant,
  EntrantSubmission,
  SubmissionStage,
} from './competitions.js'

/** Whether submissions are accepted — the same word `submissionsOpen` returns. */
export type Accepting = 'open' | 'not_open' | 'closed'

/** Who I am and how I get back in: the "YOUR SIGN-IN KEY" card (P1). */
export interface EntrantMe {
  entrant: Entrant | null
  /** `K7Q-M2X-9FD` — only to its owner. */
  key: string | null
  /** The full address of the sign-in link; null when there is no key. */
  link: string | null
}

/** What a person knows about themselves in one competition — the "YOU" block of the P1 card. */
export interface EntrantStanding {
  joined: boolean
  place: number | null
  score: number | null
  submissions: number
  /** Waiting in the queue or running right now. */
  inFlight: number
  /** How many submissions are left today; null — there is no limit. */
  leftToday: number | null
}

/** An open data file for download. */
export interface EntrantFile {
  name: string
  bytes: number
  /** Rows in the table; null — the file is not CSV or is too big to count. */
  rows: number | null
}

/** A row of the list of competitions (P1). */
export interface EntrantCompetitionRow {
  competition: CompetitionPublic
  entrants: number
  submissions: number
  bestPublic: number | null
  baselinePublic: number | null
  privateOpen: boolean
  /** null — the person has not joined: they have no key yet. */
  mine: EntrantStanding | null
}

export interface EntrantCompetitionList {
  entrant: Entrant | null
  competitions: EntrantCompetitionRow[]
}

/** The page of one competition: the task, the files, the checking conditions. */
export interface EntrantCompetitionView {
  capabilities?: CompetitionCapabilities
  competition: CompetitionPublic
  files: EntrantFile[]
  entrants: number
  submissions: number
  bestPublic: number | null
  baselinePublic: number | null
  privateOpen: boolean
  accepting: Accepting
  mine: EntrantStanding | null
}

/**
 * A leaderboard row.
 *
 * Name and place go to everyone; `you` marks one's own row (it is highlighted
 * whole), and `number` together with HOW the submission came to count draw
 * the "SUBMISSION THAT COUNTS" column (P3). Before the final results are
 * opened there is no private number here at all: that table arrives empty,
 * not zeroed.
 */
export interface EntrantBoardLine {
  place: number
  entrantId: string
  name: string
  score: number
  submissionId: string
  /** "#12" in the "SUBMISSION THAT COUNTS" column. */
  number: number
  /** The author picked it themselves — otherwise it is the best on the public part. */
  chosen: boolean
  /** How many submissions the person has over the whole competition. */
  submissions: number
  /** The baseline's row: the mockup sets it off with a dashed line at the bottom. */
  baseline: boolean
  you: boolean
}

export interface EntrantLeaderboard {
  public: EntrantBoardLine[]
  /** `null` — the final results are still closed. Not "empty": nobody can fit to them. */
  private: EntrantBoardLine[] | null
  privateOpen: boolean
  baselinePublic: number | null
}

/**
 * The live state of a submission that is still in progress.
 *
 * Separate from the submission itself rather than fields in it: a submission
 * row lives in the database and changes on transitions, while this is a queue
 * that rearranges itself because of other people's jobs. Keeping them
 * together would mean rewriting the submission every time somebody else sent
 * theirs.
 */
export interface SubmissionLive {
  submissionId: string
  /** Place in the queue of the WHOLE instance, counting from one; null — already running. */
  place: number | null
  /** "≈ 6 min"; null — nothing to measure by, the competition has not scored anything yet. */
  etaMs: number | null
  /** The scheduler has not found resources to start the Pod yet; it will retry automatically. */
  resourcePending?: boolean
  /** When it was taken up; null — still waiting. */
  startedAt: number | null
  /** The right half of "01:12 of 10:00". */
  limitMs: number
  /** Number of one's OWN submission right before this one; null — only other people's are ahead. */
  aheadNumber: number | null
  /** How far it got — the same as in the submission, but updated by the stream. */
  stage: SubmissionStage
  cellsDone: number
  cellsTotal: number
}

/** "My submissions" (P2, P4) — and everything the submit area controls. */
export interface EntrantSubmissions {
  submissions: EntrantSubmission[]
  leftToday: number | null
  perDay: number
  inFlight: number
  accepting: Accepting
  joined: boolean
  /** Only for submissions still in progress; the rest have nothing live about them. */
  live: SubmissionLive[]
  /** The teacher has paused the instance queue — the waiting ones are held for a reason. */
  paused: boolean
}

/** The answer to sending a notebook. */
export interface SubmissionAccepted {
  submission: EntrantSubmission
  leftToday: number | null
}
