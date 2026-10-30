/**
 * The real judge: one disposable container per submission (docs/architecture/
 * contests.md §2), the sibling of the competitions' docker runner
 * (competitions/docker-runner.ts) and built to its pattern — a pure argv
 * function the tests pin without docker, every `-v` through `hostPathOf`, no
 * `--rm` so the post-mortem can read `OOMKilled`, a removal that retries on the
 * daemon's hiccup, and a sweep that takes only this instance's leftovers.
 *
 * WHAT IS DIFFERENT FROM A SUBMISSION'S NOTEBOOK, and why.
 *
 * 1. `docker run -i`, attached, not `-d`. A contest's harness talks: it reads a
 *    framed job from its stdin (the answers among it, which must never touch a
 *    disk the program can read) and writes its progress and verdicts as JSON
 *    lines on its stdout. One attached process carries both, with no writable
 *    host mount and no `docker exec` to poll — the competitions' two-way needs
 *    neither because its answer is one file collected at the end.
 *
 * 2. Root inside, with three capabilities kept (`SETUID`, `SETGID`, `KILL`).
 *    The harness is PID 1: it drops to `nobody` to compile and to run each
 *    test, and it kills every `nobody` process after a test so a double-forked
 *    helper cannot outlive it. A notebook needs none of this — it is one
 *    uid 1000 process the cgroup and the wall clock bound from outside.
 *
 * 3. Three tmpfs, each with a job: `/work` (the compiled binary and the
 *    program's scratch, `exec`), `/secret` (the answers, the outputs and the
 *    checker, `mode=700` so only root enters), `/tmp` (noexec scratch). Their
 *    sizes are computed below; all three are memory-backed and counted in
 *    `--memory`, so the cgroup ceiling is sized above the program's own limit
 *    (judgeMemoryMb).
 *
 * The queue (contests/pump.ts) hands in everything that depends on the instance
 * — the image, the paths, the limits, the tests with their answers — and reads
 * back a JudgeOutcome (judge/port.ts). This module reaches for nothing: no
 * database, no settings, no .env. It registers itself when it loads and does
 * nothing else, so that it could one day run on a machine of its own, as the
 * competitions' runner already does.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import {
  COMPILE_LOG_BYTES,
  CONTEST_LIMITS,
  LANGUAGE_FILE,
  SNIPPET_BYTES,
  type ContestLanguage,
} from '@shared/contests'
import { dataDir } from '../../data-dir.js'
// The one thing borrowed from the competitions' storage, by the design's
// instruction: translating a path inside DATA_DIR into the one the docker
// daemon sees under `make up`. Importing it is not touching it.
import { hostPathOf } from '../../competitions/storage.js'
import { contestsFs, judgeDir, JUDGE_FILE } from './harness.js'
import {
  registerContestJudge,
  type ContestJudge,
  type JudgeOutcome,
  type JudgeRequest,
  type JudgeTestResult,
  type LanguageProbe,
} from './port.js'
import { tr } from '@shared/i18n'
import type { TestVerdict, Verdict } from '@shared/contests'

/* --------------------------------------------------------------- constants */

/** On every judge container; the sweep finds its own by this and the instance label. */
export const CONTEST_JUDGE_LABEL = 'colloq.kind=contest-judge'

/**
 * This tree's instance label — the very string the competitions' runner and
 * the machine agent put on their containers (docker-runner.ts · INSTANCE_LABEL,
 * runner-agent/images.ts), a hash of the data root as the daemon sees it. It
 * marks the TREE, not the kind, so a contest judge wears it beside its own
 * kind label and the sweep takes only containers with BOTH: two instances on
 * one daemon (a dev server beside a class, two trees on a university host) each
 * sweep their own and never kill the other's running submission.
 */
const INSTANCE_SCOPE = createHash('sha256').update(path.resolve(hostPathOf(dataDir))).digest('hex').slice(0, 16)
const INSTANCE_LABEL = `ru.colloq.competition-instance=${INSTANCE_SCOPE}`

/** The output a program may print on one test before it is OL; also sizes `/secret`. */
const OUTPUT_CAP_BYTES = 64 * 1024 * 1024
const MIB = 1024 * 1024

/** The working tmpfs: a compiled binary and the program's scratch. A fixed room, like a notebook's `/out`. */
const WORK_TMPFS_MB = 256

/** The cushion the cgroup gets above the compiler's room, so a program at its limit is ML, not a container OOM. */
const MEMORY_CUSHION_MB = 256

/** The compiler's room: a build of a few hundred megabytes must fit under the cgroup even for a 16 MB problem. */
const COMPILER_ROOM_MB = 1024

/** The whole submission's wall ceiling, whatever its tests add up to: a safety net, not the per-test limit. */
const MAX_WALL_SECONDS = 20 * 60

/** Seconds added for compiling, before the tests' own budget. */
const COMPILE_WALL_SECONDS = 60

/**
 * How much of the harness's stdout is read before the run is abandoned.
 *
 * Answers come as base64, a third larger than their bytes, and every answer a
 * problem may hold when uploaded must be one its reference may write: the cap
 * follows the problem's test budget, not a round number below it. Everything
 * else is JSON lines whose size is the tests' snippets — the example's input,
 * output and stderr — so that cap grows with the tests a problem has: a
 * problem of a hundred examples is a normal problem, not a judge failure.
 */
const STDOUT_CAP_ANSWERS = Math.ceil((CONTEST_LIMITS.problemTestBytes * 4) / 3) + 64 * MIB
const STDOUT_BASE_PLAIN = 4 * MIB
/** One test's line at its largest: three snippets, every byte escaped to six in JSON, and its fields. */
const STDOUT_PER_TEST = 3 * SNIPPET_BYTES * 6 + 2048

/** The stdout a run may print before it is abandoned, by its mode and its tests. */
export function stdoutCap(request: Pick<JudgeRequest, 'mode' | 'tests'>): number {
  if (request.mode === 'answers') return STDOUT_CAP_ANSWERS
  return STDOUT_BASE_PLAIN + request.tests.length * STDOUT_PER_TEST
}

/** How much of stderr is kept for the teacher when the judge itself fails. */
const STDERR_TAIL_BYTES = 8 * 1024

/** The daemon's hiccup is retried before a removal is left for later (competitions/docker-runner.ts · RETRY_DELAYS_MS). */
const RETRY_DELAYS_MS = [250, 750, 2000]
const CLEANUP_RETRY_MS = 30_000

/** `colloq-kernel:<environment>` — the launch fails at once on a missing image, never a pull. */
const IMAGE_PREFIX = 'colloq-kernel'

/* --------------------------------------------------------------- docker call */

interface DockerResult {
  code: number
  out: string
}

/** A plain docker call (inspect, rm, kill, ps, the probe run): spawn with an array, no shell. */
type Docker = (args: string[], timeoutMs?: number, maxBytes?: number) => Promise<DockerResult>

const realDocker: Docker = (args, timeoutMs = 60_000, maxBytes = 256 * 1024) =>
  new Promise((resolve) => {
    const child = spawn('docker', args)
    let out = ''
    let bytes = 0
    let overflow = false
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const take = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        overflow = true
        child.kill('SIGKILL')
        return
      }
      out += chunk.toString()
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (error) => {
      clearTimeout(kill)
      resolve({ code: -1, out: String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(kill)
      resolve({ code: overflow ? -1 : code ?? -1, out: overflow ? 'docker output exceeded its limit' : out.trim() })
    })
  })

let docker: Docker = realDocker

/**
 * Swap the plain docker call for the tests of the sweep and the probe parsing.
 *
 * Only the plain call: the attached run of a real submission is proven with
 * real docker (the opt-in integration test), not with a stand-in that would
 * prove only itself.
 */
export function useDockerForContests(fake: Docker | null): void {
  docker = fake ?? realDocker
}

const missing = (out: string): boolean => /No such (?:container|object|image)/i.test(out)

async function retried(call: () => Promise<DockerResult>, settled: (result: DockerResult) => boolean): Promise<DockerResult> {
  let result = await call()
  for (const delay of RETRY_DELAYS_MS) {
    if (settled(result)) break
    await sleep(delay)
    result = await call()
  }
  return result
}

/* ------------------------------------------------------- removal, retried */

const pendingCleanup = new Set<string>()
let cleanupTimer: NodeJS.Timeout | null = null
let cleanupFailures = 0

export function contestJudgeDiagnostics(): { cleanupFailures: number; pendingCleanup: number } {
  return { cleanupFailures, pendingCleanup: pendingCleanup.size }
}

/** Remove a container; a failure is retried later, never thrown — the verdict already stands. */
async function removeContainer(container: string, patient = true): Promise<boolean> {
  const removal = (): Promise<DockerResult> => docker(['rm', '-f', container], 60_000)
  const gone = (result: DockerResult): boolean => result.code === 0 || missing(result.out)
  const result = patient ? await retried(removal, gone) : await removal()
  if (gone(result)) {
    pendingCleanup.delete(container)
    return true
  }
  if (!pendingCleanup.has(container)) {
    cleanupFailures = Math.min(Number.MAX_SAFE_INTEGER, cleanupFailures + 1)
    console.warn('[contests] container removal failed; retrying later', container)
    pendingCleanup.add(container)
  }
  scheduleCleanup()
  return false
}

let retrying: Promise<void> | null = null
function retryPendingCleanup(): Promise<void> {
  retrying ??= (async () => {
    for (const container of [...pendingCleanup]) await removeContainer(container, false)
  })().finally(() => {
    retrying = null
  })
  return retrying
}

function scheduleCleanup(): void {
  if (cleanupTimer || pendingCleanup.size === 0) return
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null
    void retryPendingCleanup().finally(scheduleCleanup)
  }, CLEANUP_RETRY_MS)
  cleanupTimer.unref?.()
}

/* ------------------------------------------------------------ sizing (pure) */

/** The bytes of every answer the job carries (0 in mode `answers`, where the run writes them). */
export function totalAnswerBytes(request: Pick<JudgeRequest, 'tests' | 'mode'>): number {
  if (request.mode === 'answers') return 0
  return request.tests.reduce((sum, test) => sum + (test.answer?.length ?? 0), 0)
}

/**
 * The cgroup's memory ceiling, MB: the compiler's room (or the program's
 * limit, whichever is larger) plus a cushion plus the answers that sit in the
 * `/secret` tmpfs. Above the program's own limit on purpose, so that a program
 * a little over it reports ML by its measured peak rather than being killed by
 * the cgroup — though either way the verdict is ML (docs §2).
 */
export function judgeMemoryMb(request: Pick<JudgeRequest, 'memoryMb' | 'tests' | 'mode'>): number {
  return Math.max(request.memoryMb, COMPILER_ROOM_MB) + MEMORY_CUSHION_MB + Math.ceil(totalAnswerBytes(request) / MIB)
}

/** The working tmpfs size, MB. */
export function workTmpfsMb(): number {
  return WORK_TMPFS_MB
}

/**
 * The `/secret` tmpfs size, MB: the answers, two output caps (one test's stdout
 * and stderr at once) and the checker's code, never smaller than 1 MB.
 */
export function secretTmpfsMb(request: Pick<JudgeRequest, 'tests' | 'mode' | 'checker'>): number {
  const bytes = totalAnswerBytes(request) + 2 * OUTPUT_CAP_BYTES + Buffer.byteLength(request.checker.code, 'utf8')
  return Math.max(1, Math.ceil(bytes / MIB))
}

/**
 * The whole run's wall budget, seconds: a minute to compile plus `2 × TL + 1 s`
 * for every test, capped at twenty minutes. The per-test wall is the harness's
 * own; this is the host's net for a harness that wedged (docs §2).
 */
export function wallBudgetSeconds(request: Pick<JudgeRequest, 'tests' | 'timeLimitMs'>): number {
  const perTest = (2 * request.timeLimitMs) / 1000 + 1
  return Math.min(MAX_WALL_SECONDS, Math.ceil(COMPILE_WALL_SECONDS + request.tests.length * perTest))
}

/* ----------------------------------------------------------- argv (pure) */

export interface ContestJudgeArgs {
  container: string
  image: string
  judgeDir: string
  jobDir: string
  testsDir: string
  memoryMb: number
  workMb: number
  secretMb: number
}

/**
 * The `docker run` arguments for a judge container, as a pure function so the
 * suite can pin them exactly (judge/docker-judge-argv is checked): a lost
 * `--network none` is a submission with internet, a lost `--read-only` a
 * writable root, and neither shows until someone uses it.
 *
 * Every `-v` host path goes through `hostPathOf`, without exception: under
 * `make up` the server is itself in a container, and a path the daemon does
 * not recognise is silently mounted as an empty directory (storage.ts header).
 */
export function contestJudgeArgs(opts: ContestJudgeArgs): string[] {
  const memory = `${opts.memoryMb}m`
  return [
    'run',
    '-i',
    '--pull=never',
    '--name',
    opts.container,
    '--network',
    'none',
    '--read-only',
    '--user',
    '0:0',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'SETUID',
    '--cap-add',
    'SETGID',
    '--cap-add',
    'KILL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--cpus',
    '1',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
    '--tmpfs',
    `/work:rw,nosuid,nodev,exec,size=${opts.workMb}m,mode=1777`,
    '--tmpfs',
    `/secret:rw,nosuid,nodev,noexec,size=${opts.secretMb}m,mode=700`,
    '-v',
    `${hostPathOf(opts.judgeDir)}:/judge:ro`,
    '-v',
    `${hostPathOf(opts.jobDir)}:/job:ro`,
    '-v',
    `${hostPathOf(opts.testsDir)}:/tests:ro`,
    '--label',
    CONTEST_JUDGE_LABEL,
    '--label',
    INSTANCE_LABEL,
    '--log-driver=local',
    '--log-opt',
    'max-size=8m',
    '-w',
    '/work',
    '-e',
    'PYTHONDONTWRITEBYTECODE=1',
    '-e',
    'PYTHONUNBUFFERED=1',
    '--entrypoint',
    'python3',
    opts.image,
    '-I',
    `/judge/${JUDGE_FILE}`,
  ]
}

/* ------------------------------------------------------- stdin framing (pure) */

/** The header the harness reads first (judge.py · check_header): limits, caps, the tests and the checker. */
export interface JobHeader {
  v: 1
  language: ContestLanguage
  timeLimitMs: number
  memoryMb: number
  mode: JudgeRequest['mode']
  outputCap: number
  snippetBytes: number
  compileLogBytes: number
  checker: { kind: JudgeRequest['checker']['kind']; epsilon: number; codeBytes: number }
  tests: { n: number; sample: boolean; group: number; answerBytes: number | null }[]
}

export function buildJobHeader(request: JudgeRequest): JobHeader {
  const answers = request.mode === 'answers'
  return {
    v: 1,
    language: request.language,
    timeLimitMs: request.timeLimitMs,
    memoryMb: request.memoryMb,
    mode: request.mode,
    outputCap: OUTPUT_CAP_BYTES,
    snippetBytes: SNIPPET_BYTES,
    compileLogBytes: COMPILE_LOG_BYTES,
    checker: {
      kind: request.checker.kind,
      epsilon: request.checker.epsilon,
      codeBytes: Buffer.byteLength(request.checker.code, 'utf8'),
    },
    tests: request.tests.map((test) => ({
      n: test.ordinal,
      sample: test.sample,
      group: test.group,
      answerBytes: answers ? null : test.answer?.length ?? 0,
    })),
  }
}

/**
 * The stdin, chunk by chunk: the header line, then every answer's bytes in the
 * header's order, then the checker's code. The harness reads exactly this —
 * the header's `answerBytes` and `codeBytes` tell it how far each stretch runs
 * (judge.py · read_job) — so the order here and the sizes in the header are one
 * contract. A generator so a 512 MB set of answers streams to the pipe under
 * back-pressure instead of becoming one buffer (the queue already holds them).
 */
export function* jobStdinChunks(request: JudgeRequest): Generator<Buffer> {
  yield Buffer.from(JSON.stringify(buildJobHeader(request)) + '\n', 'utf8')
  if (request.mode !== 'answers') {
    for (const test of request.tests) if (test.answer) yield test.answer
  }
  if (request.checker.code) yield Buffer.from(request.checker.code, 'utf8')
}

/* ---------------------------------------------------- stdout → outcome (pure) */

/** One JSON line the harness wrote; `t` says which (judge.py header). */
export interface HarnessLine {
  t: string
  [key: string]: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const TEST_VERDICTS = new Set<TestVerdict>(['OK', 'WA', 'TL', 'ML', 'RE', 'OL', 'SE', 'skipped'])

/**
 * A checker's note as a sentence in the instance's language.
 *
 * The harness cannot speak the instance's language, so a builtin checker sends
 * a code and its values (`{code:"tokens.differ", params:{n,expected,got}}`),
 * and the words are put here, on the server, the way every refusal is: «слово
 * 3: ожидалось «5», получено «4»». The kind in the code says what the number
 * counts — words for `tokens` and `float`, lines for `lines` — and the ending
 * says what went wrong: a different item, an output longer than the answer
 * (`long`), or one that stopped early (`short`). The values are the data's own,
 * already cut to a few characters by the harness. A custom checker's note is
 * the teacher's own sentence and travels through unchanged.
 */
export function noteText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw || undefined
  if (!raw || typeof raw !== 'object') return undefined
  const code = str((raw as HarnessLine).code)
  const params = (raw as { params?: Record<string, unknown> }).params ?? {}
  if (!code) return undefined
  const n = int(params.n)
  const expected = str(params.expected) ?? ''
  const got = str(params.got) ?? ''
  const unit = code.startsWith('lines.') ? 'line' : 'word'
  const at = n === null ? '?' : String(n)
  if (code.endsWith('.long')) return tr(`contests.note.${unit}.long`, { n: at, got })
  if (code.endsWith('.short')) return tr(`contests.note.${unit}.short`, { n: at, expected })
  return tr(`contests.note.${unit}.differ`, { n: at, expected, got })
}

function cap(text: string | undefined, bytes: number): string | undefined {
  if (text === undefined) return undefined
  const buffer = Buffer.from(text, 'utf8')
  return buffer.length <= bytes ? text : buffer.subarray(0, bytes).toString('utf8')
}

/**
 * Turns the harness's JSON lines into a JudgeOutcome, line by line, as they
 * arrive — so the host can call `onProgress` live and never hold more than one
 * test's words in memory (answers aside, which it must collect).
 *
 * It knows the request because the harness is terse on purpose: it says nothing
 * of the tests it skipped (ICPC after a failure, an IOI group once failed), so
 * the assembler fills every unseen test as `skipped`, and the overall verdict,
 * the first failing test and the counts are worked out here from the per-test
 * verdicts, never trusted to the container.
 */
export class OutcomeAssembler {
  private readonly total: number
  private readonly mode: JudgeRequest['mode']
  private readonly onProgress?: JudgeRequest['onProgress']
  private compileLog = ''
  private compiled: boolean | null = null
  private ce = false
  private readonly results = new Map<number, JudgeTestResult>()
  private readonly answers = new Map<number, Buffer[]>()
  private readonly ordinals: number[]
  private running: number | null = null
  private se: string | null = null
  private done = false

  constructor(request: Pick<JudgeRequest, 'tests' | 'mode' | 'onProgress'>) {
    this.total = request.tests.length
    this.mode = request.mode
    this.onProgress = request.onProgress
    this.ordinals = request.tests.map((test) => test.ordinal)
  }

  /** Feed one parsed line. Unknown shapes are ignored: the harness and these types change in different files. */
  line(message: HarnessLine): void {
    switch (message.t) {
      case 'compile':
        this.onProgress?.({ phase: 'compile', test: null, done: 0, total: this.total })
        return
      case 'compiled':
        this.compiled = message.ok === true
        this.compileLog = cap(str(message.log), COMPILE_LOG_BYTES) ?? ''
        if (!this.compiled) this.ce = true
        return
      case 'start':
        this.running = int(message.n)
        this.onProgress?.({ phase: 'test', test: this.running, done: this.results.size, total: this.total })
        return
      case 'answer': {
        const n = int(message.n)
        const b64 = str(message.b64)
        if (n === null || b64 === undefined) return
        const list = this.answers.get(n) ?? []
        list.push(Buffer.from(b64, 'base64'))
        this.answers.set(n, list)
        return
      }
      case 'test': {
        const result = this.testResult(message)
        if (result === null) return
        this.results.set(result.ordinal, result)
        if (this.running === result.ordinal) this.running = null
        this.onProgress?.({ phase: 'test', test: null, done: this.results.size, total: this.total })
        return
      }
      case 'done':
        this.done = true
        this.se = str(message.se) ?? null
        return
      default:
        return
    }
  }

  private testResult(message: HarnessLine): JudgeTestResult | null {
    const ordinal = int(message.n)
    const verdict = str(message.v)
    if (ordinal === null || verdict === undefined || !TEST_VERDICTS.has(verdict as TestVerdict)) return null
    return {
      ordinal,
      verdict: verdict as TestVerdict,
      timeMs: int(message.ms),
      memoryKb: int(message.kb),
      note: noteText(message.note),
      output: cap(str(message.out), SNIPPET_BYTES),
      stderr: cap(str(message.err), SNIPPET_BYTES),
      exit: str(message.exit),
    }
  }

  /**
   * The finished outcome. `ended` says how the container stopped, for the case
   * the harness never wrote `{"t":"done"}`: an out-of-memory kill makes the
   * in-flight test ML (the cgroup took the whole container, harness and all),
   * anything else is the judge's own failure (SE).
   */
  build(ended: { oomKilled: boolean; killedReason: string | null; wallMs: number; stderrTail: string }): JudgeOutcome {
    if (this.ce) {
      return {
        verdict: 'CE',
        compileLog: this.compileLog,
        tests: [],
        failedTest: null,
        passed: 0,
        total: this.total,
        timeMs: null,
        memoryKb: null,
        systemDetail: null,
        answers: null,
        wallMs: ended.wallMs,
      }
    }
    // The harness crashed, or the host cut it off, without a closing `done`.
    if (!this.done && this.se === null) {
      if (ended.oomKilled && this.running !== null) {
        this.results.set(this.running, { ordinal: this.running, verdict: 'ML', timeMs: null, memoryKb: null })
        this.running = null
      } else {
        this.se = ended.killedReason
          ? `the judge container was stopped: ${ended.killedReason}`
          : 'the judge exited without a result'
      }
    }
    const tests = this.withSkipped()
    const se = this.se
    if (se !== null) {
      return {
        verdict: 'SE',
        compileLog: this.compileLog,
        tests,
        failedTest: null,
        passed: tests.filter((test) => test.verdict === 'OK').length,
        total: this.total,
        timeMs: maxOf(tests, 'timeMs'),
        memoryKb: maxOf(tests, 'memoryKb'),
        systemDetail: joinDetail(se, ended.stderrTail),
        answers: null,
        wallMs: ended.wallMs,
      }
    }
    const firstFail = tests.find((test) => test.verdict !== 'OK' && test.verdict !== 'skipped') ?? null
    const passed = tests.filter((test) => test.verdict === 'OK').length
    return {
      verdict: (firstFail?.verdict as Verdict) ?? 'OK',
      compileLog: this.compileLog,
      tests,
      failedTest: firstFail?.ordinal ?? null,
      passed,
      total: this.total,
      timeMs: maxOf(tests, 'timeMs'),
      memoryKb: maxOf(tests, 'memoryKb'),
      systemDetail: null,
      answers: this.mode === 'answers' ? this.collectedAnswers() : null,
      wallMs: ended.wallMs,
    }
  }

  /**
   * Every test the request named, in its run order: the harness's results
   * where it reported one, `skipped` where it stayed silent (ICPC stopped
   * before it, an IOI group had already failed). The strip is always complete,
   * so a page need not know which tests the harness chose to run.
   */
  private withSkipped(): JudgeTestResult[] {
    return this.ordinals.map(
      (ordinal) => this.results.get(ordinal) ?? { ordinal, verdict: 'skipped' as TestVerdict, timeMs: null, memoryKb: null },
    )
  }

  private collectedAnswers(): Map<number, Buffer> {
    const map = new Map<number, Buffer>()
    for (const [n, chunks] of this.answers) map.set(n, Buffer.concat(chunks))
    // A test that ran in answers mode but printed nothing still has an answer: empty.
    for (const result of this.results.values()) if (!map.has(result.ordinal) && result.verdict === 'OK') map.set(result.ordinal, Buffer.alloc(0))
    return map
  }
}

function maxOf(tests: JudgeTestResult[], key: 'timeMs' | 'memoryKb'): number | null {
  let best: number | null = null
  for (const test of tests) {
    const value = test[key]
    if (value !== null && value !== undefined && (best === null || value > best)) best = value
  }
  return best
}

function joinDetail(detail: string, stderrTail: string): string {
  const tail = stderrTail.trim()
  return tail ? `${detail}\n${tail}` : detail
}

/* ---------------------------------------------------------------- the judge */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class DockerContestJudge implements ContestJudge {
  readonly backend = 'docker' as const

  async judge(request: JudgeRequest): Promise<JudgeOutcome> {
    const started = Date.now()
    layOutJob(request)
    const image = request.image || `${IMAGE_PREFIX}:base`
    const args = contestJudgeArgs({
      container: request.container,
      image,
      judgeDir: judgeDir(),
      jobDir: request.jobDir,
      testsDir: request.testsDir,
      memoryMb: judgeMemoryMb(request),
      workMb: workTmpfsMb(),
      secretMb: secretTmpfsMb(request),
    })
    const assembler = new OutcomeAssembler(request)
    try {
      const ended = await this.runAttached(request, args, assembler)
      return assembler.build({ ...ended, wallMs: Date.now() - started })
    } finally {
      await removeContainer(request.container)
    }
  }

  /**
   * Run the container attached: write the framed job to its stdin, read its
   * JSON lines off stdout into the assembler, keep a tail of stderr, and bound
   * the whole thing by the wall budget, the stdout cap and the abort signal —
   * each of which, when it fires, kills the container from the host (a
   * `docker kill`, the only thing a program in a C loop cannot ignore). The
   * post-mortem (`docker inspect`) reads `OOMKilled` while the container is
   * still there, before the removal in `judge`'s `finally`.
   */
  private async runAttached(
    request: JudgeRequest,
    args: string[],
    assembler: OutcomeAssembler,
  ): Promise<{ oomKilled: boolean; killedReason: string | null; stderrTail: string }> {
    const outputCap = stdoutCap(request)
    let killedReason: string | null = null

    await new Promise<void>((resolve) => {
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
      let settled = false
      let giveUp: NodeJS.Timeout | null = null
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(wall)
        if (giveUp) clearTimeout(giveUp)
        request.signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const killContainer = (reason: string): void => {
        if (killedReason === null) killedReason = reason
        void docker(['kill', request.container], 30_000)
        // If `docker kill` itself wedges (a daemon in trouble), do not hang on
        // the attached client forever: give it a grace window, then SIGKILL the
        // local `docker run` process. The container is still removed in the
        // `finally` of judge(), with its own retries.
        if (!giveUp) {
          giveUp = setTimeout(() => child.kill('SIGKILL'), 30_000)
          giveUp.unref?.()
        }
      }
      const wall = setTimeout(() => killContainer('wall budget exceeded'), wallBudgetSeconds(request) * 1000)
      wall.unref?.()
      const onAbort = (): void => {
        killContainer('aborted')
        child.stdin.destroy()
      }
      if (request.signal) {
        if (request.signal.aborted) onAbort()
        else request.signal.addEventListener('abort', onAbort, { once: true })
      }

      // stdin: the framed job, with back-pressure so a half-gigabyte of answers
      // does not sit in memory twice. A broken pipe (the harness died early) is
      // not our error to throw — the missing `done` is the whole story.
      void writeChunks(child.stdin, jobStdinChunks(request)).catch(() => undefined)

      // A StringDecoder, not chunk.toString(): the harness writes JSON with
      // ensure_ascii off, so a note's `≠` or a Cyrillic checker message is
      // multi-byte, and a chunk boundary must not split one into `�`.
      const decoder = new StringDecoder('utf8')
      let stdoutBytes = 0
      let pending = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > outputCap) {
          killContainer('the judge printed more than its output limit')
          child.stdout.destroy()
          return
        }
        pending += decoder.write(chunk)
        let newline = pending.indexOf('\n')
        while (newline >= 0) {
          const raw = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          feedLine(assembler, raw)
          newline = pending.indexOf('\n')
        }
      })

      let stderrTail = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
      })

      child.on('error', (error) => {
        if (killedReason === null) killedReason = `docker could not run: ${error}`
        done()
      })
      child.on('close', () => {
        pending += decoder.end()
        if (pending.trim()) feedLine(assembler, pending)
        this.lastStderrTail = stderrTail
        done()
      })
    })

    const dead = await this.postmortem(request.container)
    return { oomKilled: dead.oomKilled, killedReason, stderrTail: this.lastStderrTail }
  }

  private lastStderrTail = ''

  private async postmortem(container: string): Promise<{ oomKilled: boolean; exitCode: number | null }> {
    const result = await retried(
      () => docker(['inspect', container, '--format', '{{.State.OOMKilled}} {{.State.ExitCode}}'], 20_000),
      (answer) => answer.code === 0 || missing(answer.out),
    )
    if (result.code !== 0) return { oomKilled: false, exitCode: null }
    const [oom, code] = result.out.trim().split(/\s+/)
    const exit = Number(code)
    return { oomKilled: oom === 'true', exitCode: Number.isFinite(exit) ? exit : null }
  }

  /**
   * What an image can run, probed once per image and kept by the caller.
   *
   * A throwaway container that prints the versions it has and nothing it does
   * not. `g++ -dumpfullversion -dumpversion` is gcc's own trick for "the full
   * version if there is one, else the short": a single line either way. A
   * missing tool prints nothing for its line, and that line becomes `null`.
   */
  async probe(image: string): Promise<LanguageProbe> {
    const script =
      'python3 -c "import platform;print(\'python\', platform.python_version())" 2>/dev/null;' +
      'v=$(g++ -dumpfullversion -dumpversion 2>/dev/null) && printf "gpp %s\\n" "$v";' +
      'v=$(gcc -dumpfullversion -dumpversion 2>/dev/null) && printf "gcc %s\\n" "$v";' +
      ':'
    const result = await docker(
      ['run', '--rm', '--network', 'none', '--pull=never', '--entrypoint', 'sh', image, '-c', script],
      60_000,
    )
    return parseProbe(result.code === 0 ? result.out : '')
  }

  /**
   * Remove the judge containers of THIS instance left by a previous life — a
   * crash mid-run. Only our own kind and our own instance label: a class's
   * rooms and a competition's runs stand on the same daemon, and a sweep by
   * kind alone would reach another tree's submission mid-judge.
   */
  async sweep(): Promise<number> {
    const found = await docker(
      ['ps', '-aq', '--filter', `label=${CONTEST_JUDGE_LABEL}`, '--filter', `label=${INSTANCE_LABEL}`],
      20_000,
    )
    if (found.code !== 0) return 0
    let dropped = 0
    for (const id of found.out.split('\n').map((line) => line.trim()).filter(Boolean)) {
      if (await removeContainer(id)) dropped++
    }
    return dropped
  }
}

/** Parse the probe container's lines into a LanguageProbe; a tool with no line is null. */
export function parseProbe(out: string): LanguageProbe {
  const probe: LanguageProbe = { python: null, gpp: null, gcc: null }
  for (const line of out.split('\n')) {
    const match = /^(python|gpp|gcc)\s+(\S.*)$/.exec(line.trim())
    if (!match) continue
    const value = match[2].trim()
    if (value) probe[match[1] as keyof LanguageProbe] = value
  }
  return probe
}

/* --------------------------------------------------------------- job layout */

/**
 * Lay out `/job`: a fresh directory of this attempt (it must not exist — the
 * virtiofs rule), 0755, holding `job.json` and the source under the language's
 * file name, both 0644 so the `nobody` the compiler runs as can read them. The
 * source is what the harness actually compiles; `job.json` is for a person
 * reading a crashed container's mount afterwards, never by the harness (which
 * takes everything from its stdin).
 */
export function layOutJob(request: JudgeRequest): void {
  // mkdir without recursive: the parent (the attempt's folder) is the queue's,
  // and a leaf that already exists is a reused name the virtiofs rule forbids.
  contestsFs.mkdirSync(request.jobDir)
  contestsFs.chmodSync(request.jobDir, 0o755)
  const sourceName = LANGUAGE_FILE[request.language]
  writeJobFile(request.jobDir, sourceName, Buffer.from(request.source, 'utf8'))
  writeJobFile(
    request.jobDir,
    'job.json',
    Buffer.from(
      JSON.stringify(
        {
          submissionId: request.submissionId,
          language: request.language,
          mode: request.mode,
          timeLimitMs: request.timeLimitMs,
          memoryMb: request.memoryMb,
          checker: request.checker.kind,
          tests: request.tests.length,
        },
        null,
        2,
      ),
      'utf8',
    ),
  )
}

function writeJobFile(dir: string, name: string, body: Buffer): void {
  const file = path.join(dir, name)
  contestsFs.writeFileSync(file, body, { mode: 0o644 })
  contestsFs.chmodSync(file, 0o644)
}

/* -------------------------------------------------------------- small helpers */

function feedLine(assembler: OutcomeAssembler, raw: string): void {
  const text = raw.trim()
  if (!text) return
  let message: HarnessLine
  try {
    message = JSON.parse(text) as HarnessLine
  } catch {
    return
  }
  if (message && typeof message === 'object' && typeof message.t === 'string') assembler.line(message)
}

/** Write a stream of buffers to a pipe, honouring back-pressure, then end it. */
function writeChunks(stream: NodeJS.WritableStream, chunks: Iterable<Buffer>): Promise<void> {
  return new Promise((resolve, reject) => {
    const iterator = chunks[Symbol.iterator]()
    stream.on('error', reject)
    const pump = (): void => {
      let next = iterator.next()
      while (!next.done) {
        const ok = stream.write(next.value)
        if (!ok) {
          stream.once('drain', pump)
          return
        }
        next = iterator.next()
      }
      stream.end(resolve)
    }
    pump()
  })
}

/* ------------------------------------------------- register when this loads */

registerContestJudge('docker', () => new DockerContestJudge())
