/**
 * What the teacher's panel asks about contests and what the server answers —
 * the `/api/admin/contests` doors.
 *
 * Everything here may hold what the class must never see: the tests and their
 * answers, the reference solution, the custom checker, every participant's
 * code and full name. The participant's half is `shared/contests-entrant.ts`,
 * and nothing in this file is imported there.
 */
import type { BoardVisibility } from './competitions.js'
import type {
  CheckerKind,
  Contest,
  ContestGroup,
  ContestLanguage,
  ContestPhase,
  ContestProblem,
  ContestRules,
  ContestSubmission,
  ContestTest,
  PointsMode,
  StandingProblemTotals,
  StandingRow,
  TestReport,
} from './contests.js'
import type { ContestQuestion, LanguageOption } from './contests-entrant.js'

/** The judge, as the list's strip shows it (A1): what runs, what waits, how fast. */
export interface JudgeStatus {
  /** `docker` judges for real; `test` is the stand-in of the test stand; `none` — this server cannot judge. */
  backend: 'docker' | 'test' | 'none'
  running: number
  queued: number
  slots: number
  /** Submissions judged since the start of today (the instance's time zone). */
  judgedToday: number
  /** Median judging time of the recent ones, ms; null — none yet. */
  medianMs: number | null
  paused: boolean
}

/** A row of the contests list (A1). */
export interface ContestListRow {
  contest: Contest
  phase: ContestPhase
  problems: number
  entrants: number
  submissions: number
  /** ICPC: problems solved per entrant, on average; IOI: points per entrant. */
  averageSolved: number | null
  /** The most the average could be: problems (ICPC) or points (IOI). */
  averageOf: number
  /** Problems whose reference does not pass yet — the draft's «эталон не проверен: C, D». */
  notReady: string[]
  course: { id: string; name: string } | null
}

export interface ContestList {
  contests: ContestListRow[]
  judge: JudgeStatus
}

/** How a problem's reference fared, as its editor and the contest's problem table show it. */
export type ReferenceState =
  /** No reference source yet. */
  | 'missing'
  /** Changed (or the tests changed) since the last check: unknown. */
  | 'unchecked'
  | 'queued'
  | 'running'
  /** OK on every test of the current revision. */
  | 'passes'
  /** Failed: the verdict and test say how. */
  | 'fails'

export interface ReferenceStatus {
  state: ReferenceState
  verdict: ContestSubmission['verdict']
  failedTest: number | null
  /** The slowest test's time and the largest memory: the margin the editor shows against the limit. */
  timeMs: number | null
  memoryKb: number | null
  slowestTest: number | null
  checkedAt: number | null
  /** The last reference submission's id: its report opens in the drawer. */
  submissionId: string | null
}

/**
 * A test as the problem editor lists it (A3): the row plus the first bytes of
 * its input and answer — «4 5 ⏎ ##..#» — so the teacher recognises a test
 * without downloading it.
 */
export interface AdminTest extends ContestTest {
  /** The input's first PREVIEW_BYTES, as text. */
  inputPreview: string
  /** The answer's first PREVIEW_BYTES; null — no answer yet. */
  answerPreview: string | null
}

/** How much of a test the editor's preview shows. */
export const PREVIEW_BYTES = 120

/** A problem in the panel: everything of it, plus its tests' list and the reference's state. */
export interface ProblemView extends ContestProblem {
  letter: string
  tests: AdminTest[]
  groups: ContestGroup[]
  /** IOI: the full score, as the groups add up. */
  maxScore: number
  testBytes: number
  reference: ReferenceStatus
  /** Tests still without an answer: «Ответы из эталона» fills them. */
  missingAnswers: number
  /** A run writing answers with the reference is queued or running. */
  answersRunning: boolean
}

/** The whole contest for the editor (A2) and the console (A4). */
export interface ContestView {
  contest: Contest
  phase: ContestPhase
  problems: ProblemView[]
  /** What the environment's image can run, with versions. */
  languages: LanguageOption[]
  course: { id: string; name: string } | null
  /** The instance's time zone (IANA): the editor shows and reads dates in it, as competitions do. */
  timeZone: string
  /** Why «Открыть контест» is refused, in the editor's words; empty — ready. */
  readiness: string[]
  entrants: number
  submissions: number
  judge: JudgeStatus
}

/** `POST /api/admin/contests`. */
export interface NewContestBody {
  title: string
  slug: string
  rules?: ContestRules
  courseId?: string | null
}

/** `PATCH /api/admin/contests/:id` — every field optional. */
export interface ContestPatch {
  title?: string
  slug?: string
  blurb?: string
  description?: string
  rules?: ContestRules
  penaltyMinutes?: number
  freezeMinutes?: number
  attemptsPerProblem?: number
  languages?: ContestLanguage[]
  environment?: string
  startsAt?: number | null
  endsAt?: number | null
  upsolving?: boolean
  boardVisibility?: BoardVisibility
  courseId?: string | null
}

/** `POST /api/admin/contests/:id/problems` and `PATCH …/problems/:pid`. */
export interface ProblemPatch {
  title?: string
  statement?: string
  timeLimitMs?: number
  memoryMb?: number
  checker?: CheckerKind
  checkerEpsilon?: number
  checkerCode?: string
  points?: PointsMode
  referenceLanguage?: ContestLanguage
  referenceSource?: string
}

/** `POST …/problems/:pid/tests` — one test typed in by hand. */
export interface NewTestBody {
  input: string
  /** Omitted or null — to be written by the reference. */
  answer?: string | null
  sample?: boolean
  group?: number
}

/** `PATCH …/problems/:pid/tests/:ordinal`. */
export interface TestPatch {
  sample?: boolean
  group?: number
  /** Move the test to this ordinal (1-based); the others shift. */
  ordinal?: number
}

/** What an uploaded archive of tests turned into. */
export interface ArchiveImport {
  problem: ProblemView
  /** Tests read from the archive. */
  added: number
  /** Inputs without an answer: the reference will write them. */
  withoutAnswers: number
  /** Files the archive held that are not tests (a statement, a checker…): named, not taken. */
  skipped: string[]
}

/** A submission in the console's feed (A4). */
export interface AdminSubmissionRow extends ContestSubmission {
  letter: string
  /** The entrant's full name — staff see full names. */
  entrant: { id: string; name: string } | null
}

export interface AdminSubmissions {
  submissions: AdminSubmissionRow[]
  total: number
}

/** One submission opened in the drawer: the code, the compiler's log, every test with data. */
export interface AdminSubmissionDetail extends AdminSubmissionRow {
  source: string
  compileLog: string
  tests: TestReport[]
  /** Why the judge failed (SE), in the judge's words. */
  systemDetail: string | null
}

/** The board as staff see it: unfrozen, full names. `?audience=class` gives the participants' view. */
export interface AdminStandings {
  rules: ContestRules
  problems: { id: string; letter: string; title: string; maxScore: number }[]
  rows: StandingRow[]
  totals: StandingProblemTotals[]
  frozen: boolean
  freezeAt: number | null
  penaltyMinutes: number
  startsAt: number | null
}

/** A participant in the console's «Участники» tab. */
export interface ContestEntrantRow {
  id: string
  name: string
  joinedAt: number
  submissions: number
  solved: number
  lastSubmissionAt: number | null
}

/** A question as the teacher sees it: with the asker's name. */
export interface AdminQuestion extends ContestQuestion {
  entrant: { id: string; name: string } | null
}

export interface AdminQuestions {
  questions: AdminQuestion[]
  /** Questions with no answer yet: the red count on the tab. */
  unanswered: number
}

/** `POST …/questions/:qid/answer`. */
export interface AnswerBody {
  answer: string
  /** Answer to everyone: the question and the answer become an announcement. */
  public: boolean
}

/** `POST …/announcements`. */
export interface AnnouncementBody {
  text: string
  problemId?: string | null
}

/** What the console's stream says: revisions to compare, nothing heavy. */
export interface ContestLiveState {
  revision: number
  /** This contest's submissions waiting and being judged now (the header's «В ОЧЕРЕДИ»). */
  queued: number
  running: number
  /** Bumps with every submission's change. */
  submissions: string
  questions: string
  judge: JudgeStatus
  now: number
}

/** `GET/PUT /api/admin/contests/settings`. */
export interface ContestSettings {
  /** null — automatic (by the machine's CPUs). */
  judgeSlots: number | null
  /** What `null` resolves to on this machine now. */
  autoSlots: number
}
