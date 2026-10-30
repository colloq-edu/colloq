/**
 * The judge contract — everything the contest queue knows about judging a
 * submission (docs/architecture/contests.md §2).
 *
 * Narrow on purpose, like the competitions' runner port: the queue
 * (contests/pump.ts) decides whose submission goes next and what to write
 * into its row; HOW a program is compiled, run and checked comes in two kinds
 * behind this door. The real one (docker-judge.ts) starts one disposable
 * container per submission; the stand-in (fake-judge.ts) never runs a line of
 * anyone's code and decides by magic comments in the source, so the test
 * stand and the suite live without docker. THE SHAPE OF THE ANSWER IS ONE
 * FOR BOTH, otherwise the swap proves nothing.
 *
 * Answers travel in the request as bytes, not as paths: the judge hands them
 * to the harness through its stdin, and no answer ever lies on a disk the
 * participant's program can see.
 */
import type { CheckerKind, ContestLanguage, TestVerdict, Verdict } from '@shared/contests'

/** Which path judges submissions here. */
export type JudgeBackend = 'docker' | 'test'

export interface JudgeTest {
  /** 1-based; the order tests run in. */
  ordinal: number
  sample: boolean
  /** IOI: the group the test belongs to; a failure skips the rest of its group. */
  group: number
  /** The expected answer; null only in mode `answers` (the run writes it). */
  answer: Buffer | null
}

/**
 * `icpc` — stop at the first failed test. `ioi` — run every test, but skip
 * the rest of a group once one of its tests failed. `answers` — the teacher's
 * reference writes the answers: every test runs, nothing is checked, and the
 * outputs come back.
 */
export type JudgeMode = 'icpc' | 'ioi' | 'answers'

export interface JudgeProgress {
  phase: 'compile' | 'test'
  /** The test being run now; null while compiling. */
  test: number | null
  /** Tests finished. */
  done: number
  total: number
}

export interface JudgeRequest {
  submissionId: string
  /** The container's name; it is also what it is killed and removed by. */
  container: string
  /** `colloq-kernel:<environment>`. */
  image: string
  language: ContestLanguage
  source: string
  timeLimitMs: number
  memoryMb: number
  /**
   * The directory with the tests' inputs, `<ordinal>.in` (a host path inside
   * DATA_DIR, mounted read-only). A directory that never existed before this
   * revision of the tests (the virtiofs rule).
   */
  testsDir: string
  /**
   * A fresh directory of this attempt, inside DATA_DIR, where the judge may
   * lay out what it mounts as `/job` (the source and the job's JSON). The
   * queue creates its parent and removes it after the run.
   */
  jobDir: string
  tests: JudgeTest[]
  mode: JudgeMode
  checker: { kind: CheckerKind; epsilon: number; code: string }
  signal?: AbortSignal
  onProgress?: (progress: JudgeProgress) => void
}

export interface JudgeTestResult {
  ordinal: number
  verdict: TestVerdict
  timeMs: number | null
  memoryKb: number | null
  /** The checker's note, in the participant's words where it can be. */
  note?: string
  /** The program's output and stderr, cut at SNIPPET_BYTES — staff only, examples also to the author. */
  output?: string
  stderr?: string
  /** «exit 1», «SIGSEGV» — staff only. */
  exit?: string
}

export interface JudgeOutcome {
  /** OK; the first failing test's verdict; CE; SE when the judge itself failed. */
  verdict: Verdict
  /** The compiler's output (CE, and warnings on success), cut at COMPILE_LOG_BYTES. */
  compileLog: string
  tests: JudgeTestResult[]
  failedTest: number | null
  passed: number
  /** Tests in the request. */
  total: number
  /** The largest time and memory over the tests that ran. */
  timeMs: number | null
  memoryKb: number | null
  /** SE: what went wrong, for the teacher. */
  systemDetail: string | null
  /** Mode `answers`: what the program printed for each test. */
  answers: Map<number, Buffer> | null
  wallMs: number
}

/** What an image can run: versions, or null for a missing tool. */
export interface LanguageProbe {
  python: string | null
  gpp: string | null
  gcc: string | null
}

export interface ContestJudge {
  readonly backend: JudgeBackend
  judge(request: JudgeRequest): Promise<JudgeOutcome>
  /** What the image can run; asked once per image and kept by the caller. */
  probe(image: string): Promise<LanguageProbe>
  /** Leftover containers of this instance (a crash mid-run), removed at startup. */
  sweep(): Promise<number>
}

/* ------------------------------------------------------------- registry */

const factories = new Map<JudgeBackend, () => ContestJudge>()
let chosen: ContestJudge | null = null
let standIn: ContestJudge | null = null

/** A backend makes itself known (docker-judge.ts, fake-judge.ts) when its module loads. */
export function registerContestJudge(kind: JudgeBackend, factory: () => ContestJudge): void {
  factories.set(kind, factory)
}

/** Tests put their own judge in place; null puts the real choice back. */
export function useContestJudge(judge: ContestJudge | null): void {
  standIn = judge
}

/**
 * The judge this server uses, or null — this server cannot judge (the k8s
 * broker: v1 judges with docker only). Follows the competitions' choice of
 * backend (competitions/runner-port.ts · competitionBackend), so a stand on
 * `test` never starts a container and production never takes the stand-in.
 */
export function contestJudge(kind: JudgeBackend | 'broker'): ContestJudge | null {
  if (standIn) return standIn
  if (kind === 'broker') return null
  if (chosen && chosen.backend === kind) return chosen
  const factory = factories.get(kind)
  if (!factory) return null
  chosen = factory()
  return chosen
}

/** Forget the chosen judge — for tests that switch backends. */
export function forgetContestJudge(): void {
  chosen = null
}
