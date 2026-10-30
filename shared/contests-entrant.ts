/**
 * What the contest pages (`/a/<slug>`, and the contests on the `/k` list) ask
 * the server and what it answers — the `/api/k/contests` doors.
 *
 * Kept apart from `shared/contests-api.ts` along the same border as the
 * competitions' two files: there live the `/api/admin/contests` answers —
 * with the tests, the reference solution and every participant's code; here
 * only what may be shown to anyone who has the contest's address, or to the
 * one person whose submission it is. One file for both would mean that a
 * field added to a panel row travels to the class silently.
 */
import type { Entrant } from './competitions.js'
import type {
  CheckerKind,
  ContestAccepting,
  ContestLanguage,
  ContestPublic,
  ContestRules,
  JudgeState,
  StandingProblemTotals,
  StandingRow,
  TestReport,
  TestVerdict,
  Verdict,
} from './contests.js'

/**
 * Why a contest door refused — a word the screen branches on. The shared
 * participant words (`unauthenticated`, `name_taken`…) mean what they mean
 * on competitions; the rest are the contest's own.
 */
export type ContestRefusal =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'name_taken'
  /** The contest has not started yet. */
  | 'not_open'
  /** The contest is over and upsolving is off. */
  | 'closed'
  | 'not_joined'
  /** The language is not one this contest takes, or its compiler is missing in the image. */
  | 'language'
  /** The per-problem limit of attempts is spent. */
  | 'attempts'
  /** Two submissions of this person are still being judged: wait for one. */
  | 'in_flight'
  | 'too_often'
  | 'too_big'
  /** The board is shown to this contest's participants only. */
  | 'board_closed'
  /** The judge cannot run here (no docker, a cluster without contest support). */
  | 'unavailable'

export interface ContestErrorBody {
  error: string
  reason: ContestRefusal
}

/** A language as the editor offers it: id, the label with the version, whether the image can run it. */
export interface LanguageOption {
  id: ContestLanguage
  /** «Python 3.11», «C++20 · g++ 12». */
  label: string
  available: boolean
}

/** An example under the statement: a test marked `sample`, its data whole up to the snippet cap. */
export interface SampleTest {
  ordinal: number
  input: string
  answer: string
  /** Cut at SNIPPET_BYTES: the copy button warns that it copies a part. */
  truncated: boolean
}

/** What this person has done with one problem: the rail's letter colour (K1). */
export interface ProblemMine {
  solved: boolean
  /** Rejected attempts (ICPC: before the accepted one). */
  attempts: number
  /** Being judged right now: the rail shows «тест 7». */
  pending: boolean
  /** The test the pending submission is on, when known. */
  pendingTest: number | null
  /** IOI: the best score so far; null — nothing judged. */
  score: number | null
  /** Submissions left under the per-problem limit; null — no limit. */
  attemptsLeft: number | null
}

/** A problem as a participant reads it. Before the start the list is empty. */
export interface EntrantProblem {
  id: string
  letter: string
  title: string
  statement: string
  timeLimitMs: number
  memoryMb: number
  checker: CheckerKind
  checkerEpsilon: number
  /** IOI: the most points this problem gives. */
  maxScore: number
  samples: SampleTest[]
  tests: number
  mine: ProblemMine | null
}

/** One row of the `/k` list's contests section. */
export interface EntrantContestRow {
  contest: ContestPublic
  problems: number
  entrants: number
  /** null — the person is not signed in or has not joined. */
  mine: {
    joined: boolean
    solved: number
    score: number
    place: number | null
  } | null
}

export interface EntrantContestList {
  entrant: Entrant | null
  contests: EntrantContestRow[]
}

/** The page of one contest (`GET /api/k/contests/:slug`). */
export interface EntrantContestView {
  contest: ContestPublic
  accepting: ContestAccepting
  /** The server's clock, so the countdown does not trust the laptop's. */
  now: number
  frozen: boolean
  freezeAt: number | null
  languages: LanguageOption[]
  problems: EntrantProblem[]
  entrants: number
  /** null — not signed in. */
  mine: {
    joined: boolean
    place: number | null
    solved: number
    score: number
    /** Unread answers to this person's questions and announcements since they last looked. */
    unreadAnswers: number
  } | null
}

/** A submission as its author sees it. */
export interface EntrantContestSubmission {
  id: string
  number: number
  problemId: string
  letter: string
  language: ContestLanguage
  submittedAt: number
  late: boolean
  state: JudgeState
  verdict: Verdict | null
  failedTest: number | null
  passed: number | null
  total: number | null
  score: number | null
  timeMs: number | null
  memoryKb: number | null
  progress: number | null
  /** The strip under the row: every test's verdict, in order (K2). */
  strip: TestVerdict[]
}

export interface EntrantContestSubmissions {
  submissions: EntrantContestSubmission[]
  /** Bumps whenever any of these changes: the stream compares it. */
  version: string
}

/** One submission opened (`GET …/submissions/:id`): the code and what may be said about its tests. */
export interface EntrantSubmissionDetail extends EntrantContestSubmission {
  source: string
  /** The compiler's words, for CE (and warnings on success). */
  compileLog: string
  /** Every test run, with data snippets for examples only. */
  tests: TestReport[]
}

/** `POST …/submissions` body. */
export interface SubmitBody {
  problemId: string
  language: ContestLanguage
  source: string
}

export interface SubmitAccepted {
  submission: EntrantContestSubmission
}

/** The board (`GET …/standings`). */
export interface EntrantStandings {
  rules: ContestRules
  problems: { id: string; letter: string; title: string; maxScore: number }[]
  rows: StandingRow[]
  totals: StandingProblemTotals[]
  frozen: boolean
  freezeAt: number | null
  /** The viewer's own row id, to highlight; null — not in the table. */
  me: string | null
  penaltyMinutes: number
  startsAt: number | null
}

/** A question and its answer, or an announcement (no question, `public`). */
export interface ContestQuestion {
  id: string
  problemId: string | null
  letter: string | null
  /** Empty for an announcement. */
  question: string
  answer: string | null
  /** Seen by everyone: an announcement, or an answer the teacher gave to all. */
  public: boolean
  /** True when it is this person's own question. */
  mine: boolean
  askedAt: number
  answeredAt: number | null
}

export interface EntrantQuestions {
  questions: ContestQuestion[]
}

/** `POST …/questions` body. */
export interface AskBody {
  problemId: string | null
  question: string
}

/** Every stream event: what changed, so the page refetches only that. */
export interface ContestStreamState {
  /** The contest's revision (settings, problems, phase). */
  revision: number
  /** The person's submissions (EntrantContestSubmissions.version). */
  mine: string
  /** The board's version as this person sees it. */
  board: string
  /** Questions and announcements. */
  questions: string
}
