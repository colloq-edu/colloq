/**
 * The judge's queue: which submission is judged next, the judging itself as
 * the queue sees it, and what is written into the row afterwards
 * (docs/architecture/contests.md §2, «The queue»).
 *
 * THE QUEUE IS THE TABLE. contest_submissions holds every waiting row, so a
 * restart loses nothing: a row running under another process life is an
 * orphan, put back at startup (store.ts · requeueOrphans), and after three
 * starts cut short it ends as the judge's own failure. The order is the
 * store's (store.ts · selectNextQueued): the teacher's runs first, then by
 * the moment of sending, and never two judgings of one person at once.
 *
 * THE PUMP fills free slots on a one-second tick and at once on every new
 * submission (wakeContestJudge), as the competitions' pump does
 * (competitions/runner.ts). Each judging reserves its memory through the
 * instance's work budget (ops/work-budget.ts, kind `competition`), so the
 * rooms' admission sees it, and none starts while the machine's free memory
 * is below what it needs and a floor.
 *
 * HOW A SUBMISSION IS JUDGED is the judge's (judge/port.ts): this module
 * builds the request — the tests of the revision the run is pinned to, the
 * answers read from the host's disk as bytes — and turns the outcome into the
 * row: the verdict, IOI points counted here from the per-test verdicts
 * (@shared/contests · pointGroups, pointsFor), the report with every test.
 * A reference check stamps what it was checked against; a run writing the
 * answers turns them into a new tests revision.
 *
 * THE CLOCK lives here too: a contest's phase moves by itself when its start,
 * its end or its freeze passes, and the pages learn of it by its revision.
 * The tick bumps the revision at every such moment (watchPhases).
 */
import './judge/index.js'
import { tr } from '@shared/i18n'
import {
  boardFrozen,
  COMPILE_LOG_BYTES,
  CONTEST_LANGUAGES,
  contestPhase,
  pointGroups,
  pointsFor,
  problemsVisible,
  type Contest,
  type ContestLanguage,
  type TestVerdict,
} from '@shared/contests'
import type { JudgeStatus } from '@shared/contests-api'
import type { LanguageOption } from '@shared/contests-entrant'
import { contestJudge, type ContestJudge, type JudgeMode, type JudgeOutcome, type JudgeRequest, type LanguageProbe } from './judge/port.js'
import { languageAvailable as toolAvailable, languageLabel as toolLabel } from './judge/languages.js'
import { competitionBackend } from '../competitions/runner-port.js'
import { reserveWork, type WorkLease } from '../ops/work-budget.js'
import { hostMemAvailableMb } from '../ops/meminfo.js'
import { instanceDayStart } from '../time-zone.js'
import {
  BOOT,
  enqueueTeacherRun,
  finishJudging,
  getContest,
  getProblem,
  judgedSince,
  listContests,
  listTests,
  nextQueued,
  noteProgress,
  queueCounts,
  recentJudgingDurations,
  referenceStamp,
  requeueOrphans,
  requeueStopped,
  startJudging,
  stillJudging,
  bumpContestRevision,
  type StartedJudging,
  type StoredTestReport,
} from './store.js'
import { inputsDir, jobDir, prepareRunsDir, readTestFileAsync, removeJobDir, revisionExists, testSnippet, TestsRefused } from './storage.js'
import { changeTests, sameFile, tidyRevisions, TestsMoved, type NextTest } from './revisions.js'
import { judgePaused, judgeSlots, setJudgePaused } from './settings.js'
import { noteJudgeChanged } from './events.js'

/* ------------------------------------------------------------------ judge */

/**
 * The judge this server uses, or null — it cannot judge here (the k8s broker
 * has no second pod per submission in v1). Follows the competitions' choice
 * of backend, so a stand on `test` never starts a container.
 */
export function currentJudge(): ContestJudge | null {
  try {
    return contestJudge(competitionBackend())
  } catch {
    // An unknown COMPETITION_BACKEND, or docker under NODE_ENV=production: no judge, said by the strip.
    return null
  }
}

export function judgeBackend(): JudgeStatus['backend'] {
  return currentJudge()?.backend ?? 'none'
}

/** The image a contest's judgings run in: the environments' kernel image. */
export function kernelImage(environment: string): string {
  return `colloq-kernel:${environment}`
}

/* ------------------------------------------------------------ languages */

/*
 * What an image can run, asked of the judge once per image and kept: a probe
 * starts a container, and every page of a contest asks. A failed probe (no
 * image yet, docker away) is kept briefly, so a page refreshed in a loop does
 * not start a container a second; a good one for ten minutes, so a rebuilt
 * image with g++ added is seen without a restart. Per judge, so a test that
 * swaps the judge sees its own answers.
 */
const PROBE_TTL_MS = 10 * 60_000
const PROBE_FAILED_TTL_MS = 30_000

interface ProbeEntry {
  at: number
  value: LanguageProbe | null
  pending: Promise<LanguageProbe | null> | null
}

const probes = new WeakMap<ContestJudge, Map<string, ProbeEntry>>()

/** What the environment's image can run; null — no judge here, or the probe failed. */
export async function imageLanguages(environment: string, now = Date.now()): Promise<LanguageProbe | null> {
  const judge = currentJudge()
  if (!judge) return null
  const image = kernelImage(environment)
  let byImage = probes.get(judge)
  if (!byImage) {
    byImage = new Map()
    probes.set(judge, byImage)
  }
  const cached = byImage.get(image)
  if (cached?.pending) return cached.pending
  if (cached && now - cached.at < (cached.value ? PROBE_TTL_MS : PROBE_FAILED_TTL_MS)) return cached.value
  const entry: ProbeEntry = { at: now, value: null, pending: null }
  entry.pending = judge.probe(image).then(
    (value) => value,
    (error: unknown) => {
      console.warn(`[contests] the languages of ${image} could not be probed:`, error instanceof Error ? error.message : error)
      return null
    },
  ).then((value) => {
    entry.value = value
    entry.at = Date.now()
    entry.pending = null
    return value
  })
  byImage.set(image, entry)
  return entry.pending
}

/** Forget what the images were found to run — after an image was rebuilt, and in tests. */
export function forgetLanguageProbes(): void {
  const judge = currentJudge()
  if (judge) probes.delete(judge)
}

/** A probe of nothing: what an image is said to run when it could not be asked. */
const NO_TOOLS: LanguageProbe = { python: null, gpp: null, gcc: null }

/**
 * «Python 3.11», «C++20 · g++ 12.2» — the judge's own words for a language
 * (judge/languages.ts), or the language alone when the image could not be
 * asked or has no such tool.
 */
export function languageLabel(language: ContestLanguage, probe: LanguageProbe | null): string {
  return toolLabel(language, probe ?? NO_TOOLS)
}

/** Whether the image runs the language — never when it could not be asked. */
export function languageAvailable(language: ContestLanguage, probe: LanguageProbe | null): boolean {
  return probe !== null && toolAvailable(language, probe)
}

/** The languages as the editor offers them: `languages` in their order, each with its version and whether it runs here. */
export async function languageOptions(environment: string, languages: readonly ContestLanguage[] = CONTEST_LANGUAGES): Promise<LanguageOption[]> {
  const probe = await imageLanguages(environment)
  return languages.map((id) => ({ id, label: languageLabel(id, probe), available: languageAvailable(id, probe) }))
}

/* -------------------------------------------------------------- the pump */

interface ActiveJudging {
  submissionId: string
  contestId: string
  problemId: string
  entrantId: string | null
  attempt: number
  controller: AbortController
  done: Promise<void>
}

/** Judgings running in THIS process: whom a shutdown requeues, whom a removal waits for. */
const active = new Map<string, ActiveJudging>()

/** A contest, a problem of it, or a person in it: what a removal holds back from the judge. */
interface Scope {
  contestId: string
  problemId?: string
  entrantId?: string
}

function inScope(row: { contestId: string; problemId: string; entrantId: string | null }, scope: Scope): boolean {
  return row.contestId === scope.contestId
    && (scope.problemId === undefined || row.problemId === scope.problemId)
    && (scope.entrantId === undefined || row.entrantId === scope.entrantId)
}

/**
 * What the pump must not start now: the scopes being removed (holdAndStop),
 * each with how many removals hold it. Their waiting rows are passed over, so
 * a judging stopped for a removal is not taken again in the second before its
 * rows go — and if the removal is refused, they are judged after all.
 */
const held = new Map<string, { scope: Scope; holders: number }>()

function isHeldBack(row: { contestId: string; problemId: string; entrantId: string | null }): boolean {
  for (const { scope } of held.values()) if (inScope(row, scope)) return true
  return false
}

const TICK_MS = 1_000
/** The free memory a judging leaves to the machine on top of what it takes. */
const MEMORY_FLOOR_MB = 256
/** What a compiler (g++ at -O2) and the harness take beside the program. */
const COMPILER_MB = 512

let timer: NodeJS.Timeout | null = null
let starting: Promise<void> | null = null
let stopped = true
let warned = ''

function warnOnce(text: string): void {
  if (warned === text) return
  warned = text
  console.warn(text)
}

/**
 * What one judging reserves: the program's memory or the compiler's (at
 * least a gigabyte), half a gigabyte for the harness, and the answers twice —
 * once in this server's memory while they are handed over, once in the
 * container's tmpfs. Small answers cost nothing worth the name; a problem
 * with hundreds of megabytes of answers judges fewer submissions at once
 * instead of taking the server's memory from under it.
 */
export function judgingReserveMb(memoryMb: number, answersMb = 0): number {
  return Math.max(memoryMb, 1024) + 512 + 2 * answersMb
}

/** The answers a judging of this problem carries, MB — what the tests table says they weigh. */
function answersMbOf(problemId: string | undefined): number {
  if (!problemId) return 0
  const bytes = listTests(problemId).reduce((sum, test) => sum + (test.answerBytes ?? 0), 0)
  return Math.ceil(bytes / (1024 * 1024))
}

/**
 * Fill the free slots, now: the number of judgings started. Synchronous —
 * from the look at the queue to the row marked running nothing else runs, so
 * two passes can never take one row. A paused judge, or none, takes nothing;
 * the clock ticks either way.
 */
export function pumpContestJudge(): number {
  watchPhases()
  const judge = currentJudge()
  if (!judge || judgePaused()) return 0
  const slots = judgeSlots()
  // The stand-in starts no container and takes no memory: the gate is the real judge's.
  const memory = judge.backend === 'test' ? null : hostMemAvailableMb()
  let admittedMb = 0
  let started = 0
  const skip: string[] = []
  while (active.size < slots) {
    const next = nextQueued(skip)
    if (!next) break
    if (isHeldBack(next)) {
      skip.push(next.id)
      continue
    }
    const problem = getProblem(next.problemId)
    // A run that writes the answers carries none; every other one carries them all.
    const answersMb = next.kind === 'answers' ? 0 : answersMbOf(problem?.id)
    const needMb = judgingReserveMb(problem?.memoryMb ?? 256, answersMb)
    /*
     * The reservation is a promise to the rooms' admission (the cgroup's
     * ceiling); what a judging really takes is its program's limit and the
     * compiler's working set. MemAvailable already holds what the running
     * judgings took, and what this pass admitted has not taken it yet.
     */
    const wantMb = (problem?.memoryMb ?? 256) + COMPILER_MB + 2 * answersMb
    if (memory !== null && memory - admittedMb < wantMb + MEMORY_FLOOR_MB) {
      warnOnce(`[contests] waiting for memory: a judging needs ${wantMb} MB and ${Math.max(0, memory - admittedMb)} MB is free`)
      break
    }
    const release = reserveWork({ id: `contest:${next.id}`, kind: 'competition', memoryMb: needMb, diskBytes: 0 }, {})
    if (!release) break
    const taken = startJudging(next.id, BOOT)
    if (!taken) {
      release()
      break
    }
    warned = ''
    admittedMb += wantMb
    started++
    launch(judge, taken, release)
  }
  return started
}

function launch(judge: ContestJudge, taken: StartedJudging, release: WorkLease): void {
  const controller = new AbortController()
  const { submission } = taken
  const job: ActiveJudging = {
    submissionId: submission.id,
    contestId: submission.contestId,
    problemId: submission.problemId,
    entrantId: submission.entrantId,
    attempt: submission.attempt,
    controller,
    done: Promise.resolve(),
  }
  job.done = judgeOne(judge, taken, controller.signal)
    .catch((error: unknown) => console.error('[contests] a judging failed to record', submission.id, error))
    .finally(() => {
      release()
      // Only its own entry: a run of the same submission started after it must stay tracked.
      if (active.get(submission.id) === job) active.delete(submission.id)
      // A freed slot is filled at once, not at the next tick.
      wakeContestJudge()
    })
  active.set(submission.id, job)
}

/** The judge failed, in the teacher's words (SE): what the row says when nothing ran. */
function systemOutcome(detail: string, total: number): JudgeOutcome {
  return {
    verdict: 'SE',
    compileLog: '',
    tests: [],
    failedTest: null,
    passed: 0,
    total,
    timeMs: null,
    memoryKb: null,
    systemDetail: detail,
    answers: null,
    wallMs: 0,
  }
}

/** Something the queue itself cannot start a judging without (an answer missing, the tests gone). */
class NotJudgeable extends Error {}

async function judgeOne(judge: ContestJudge, taken: StartedJudging, signal: AbortSignal): Promise<void> {
  const { submission, problem, tests } = taken
  const contest = getContest(submission.contestId)
  const revision = submission.testsRevision ?? problem.testsRevision
  const mode: JudgeMode = submission.kind === 'answers' ? 'answers' : contest?.rules === 'ioi' ? 'ioi' : 'icpc'
  let outcome: JudgeOutcome
  try {
    if (!contest) throw new NotJudgeable(tr('contests.judge.contestGone'))
    if (tests.length === 0 || !revisionExists(problem.contestId, problem.id, revision)) {
      throw new NotJudgeable(tr('contests.judge.noTests'))
    }
    const answers = await Promise.all(
      tests.map(async (test) => {
        if (mode === 'answers') return null
        if (test.answerBytes === null) throw new NotJudgeable(tr('contests.judge.noAnswer', { test: test.ordinal }))
        return readTestFileAsync(problem.contestId, problem.id, revision, test.ordinal, 'ans')
      }),
    )
    // Stopped while the answers were read (a shutdown, a removal): the judge is not asked at all.
    if (signal.aborted) throw new NotJudgeable(tr('contests.judge.stopped'))
    prepareRunsDir(problem.contestId)
    let lastProgress = 0
    const request: JudgeRequest = {
      submissionId: submission.id,
      container: `colloq-contest-${submission.id}-${submission.attempt}`,
      image: kernelImage(contest.environment),
      language: submission.language,
      source: submission.source,
      timeLimitMs: problem.timeLimitMs,
      memoryMb: problem.memoryMb,
      /*
       * Both in this server's own view of DATA_DIR: the judge turns every
       * path it mounts into the daemon's (hostPathOf, docker-judge.ts) —
       * mapped here as well, it would be mapped twice under `make up`. The
       * run's directory is the judge's to make, fresh, under runs/.
       */
      testsDir: inputsDir(problem.contestId, problem.id, revision),
      jobDir: jobDir(problem.contestId, submission.id, submission.attempt),
      tests: tests.map((test, index) => ({ ordinal: test.ordinal, sample: test.sample, group: test.group, answer: answers[index] })),
      mode,
      checker: {
        kind: problem.checker,
        epsilon: problem.checkerEpsilon,
        code: problem.checker === 'custom' ? problem.checkerCode : '',
      },
      signal,
      onProgress: (progress) => {
        if (progress.phase !== 'test') return
        // At most once a second per run, and always the last: the row is
        // written, and thirty phones re-read their submissions on each write.
        const now = Date.now()
        if (now - lastProgress < 1000 && progress.done < progress.total) return
        lastProgress = now
        noteProgress(submission.id, submission.attempt, progress.done)
      },
    }
    outcome = await judge.judge(request)
  } catch (error) {
    const detail = error instanceof NotJudgeable ? error.message : tr('contests.judge.failed', { detail: error instanceof Error ? error.message : String(error) })
    outcome = systemOutcome(detail, tests.length)
  } finally {
    removeJobDir(problem.contestId, submission.id, submission.attempt)
  }
  record(taken, contest, revision, mode, outcome)
}

/** A compiler's log cut where the shared cap says, on a character boundary. */
function cutLog(log: string): string {
  const bytes = Buffer.from(String(log ?? ''), 'utf8')
  if (bytes.length <= COMPILE_LOG_BYTES) return String(log ?? '')
  let end = COMPILE_LOG_BYTES
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * The outcome into the row. The report keeps everything the judge said of
 * every test, and for the examples and the first failed test the input and
 * the answer too (what anyone opens a report for); the doors decide who
 * reads what of it (routes/contests.ts gives a participant the examples only).
 */
function record(taken: StartedJudging, contest: Contest | null, revision: number, mode: JudgeMode, judged: JudgeOutcome): void {
  const { submission, problem, tests, groups } = taken
  let outcome = judged
  // Only the run that still owns its row writes answers: one requeued by a shutdown is judged again.
  if (submission.kind === 'answers' && outcome.verdict === 'OK' && stillJudging(submission.id, submission.attempt, BOOT)) {
    const refusal = applyAnswers(taken, revision, outcome)
    if (refusal) outcome = { ...outcome, verdict: 'SE', systemDetail: refusal }
  }
  const byOrdinal = new Map(tests.map((test) => [test.ordinal, test]))
  const report: StoredTestReport[] = outcome.tests.map((result) => {
    const test = byOrdinal.get(result.ordinal)
    const sample = test?.sample ?? false
    const keepData = sample || result.ordinal === outcome.failedTest
    const input = keepData ? testSnippet(problem.contestId, problem.id, revision, result.ordinal, 'in') : null
    const answer = keepData && mode !== 'answers' ? testSnippet(problem.contestId, problem.id, revision, result.ordinal, 'ans') : null
    return {
      ordinal: result.ordinal,
      verdict: result.verdict,
      timeMs: result.timeMs,
      memoryKb: result.memoryKb,
      sample,
      group: test?.group ?? 0,
      ...(result.note ? { note: result.note } : {}),
      ...(input ? { input: input.text } : {}),
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(answer ? { answer: answer.text } : {}),
      ...(result.exit !== undefined ? { exit: result.exit } : {}),
      ...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
    }
  })
  const verdicts = new Map<number, TestVerdict>(outcome.tests.map((result) => [result.ordinal, result.verdict]))
  const score = contest?.rules === 'ioi' && outcome.verdict !== 'SE' && mode !== 'answers'
    ? outcome.verdict === 'CE' ? 0 : pointsFor(pointGroups(tests, problem.points, groups), verdicts)
    : null
  const stamp = submission.kind === 'reference'
    ? referenceStamp({ ...problem, referenceLanguage: submission.language, referenceSource: submission.source })
    : undefined
  finishJudging(submission.id, submission.attempt, {
    state: outcome.verdict === 'SE' ? 'failed' : 'done',
    verdict: outcome.verdict,
    failedTest: outcome.failedTest,
    passed: outcome.passed,
    total: outcome.total,
    score,
    timeMs: outcome.timeMs,
    memoryKb: outcome.memoryKb,
    compileLog: cutLog(outcome.compileLog),
    report: { tests: report, ...(stamp ? { stamp } : {}) },
    systemDetail: outcome.verdict === 'SE' ? outcome.systemDetail ?? tr('contests.judge.unknown') : null,
    judgedAt: Date.now(),
  })
  // The revision the run read may be an old one now: nothing pins it any more.
  tidyRevisions(problem.contestId, problem.id)
}

/**
 * The reference's outputs become the answers of a new tests revision: every
 * test with no answer, or with one the reference wrote before; an uploaded
 * answer is the teacher's and stays. Only onto the revision the run read —
 * tests changed meanwhile mean inputs these outputs are not for. A check of
 * the reference is queued right after: the revision moved, so the old check
 * no longer counts, and opening the contest needs one. Returns why it could
 * not be done, in the teacher's words, or null.
 */
function applyAnswers(taken: StartedJudging, revision: number, outcome: JudgeOutcome): string | null {
  const answers = outcome.answers
  if (!answers) return tr('contests.judge.answersMissing')
  const problem = getProblem(taken.problem.id)
  if (!problem) return tr('contests.judge.contestGone')
  if (problem.testsRevision !== revision) return tr('contests.judge.answersStale')
  const next: NextTest[] = listTests(problem.id).map((test) => {
    const written = test.answerBytes === null || test.answerFrom === 'reference'
    const fresh = written ? answers.get(test.ordinal) : undefined
    return {
      sample: test.sample,
      group: test.group,
      input: sameFile(problem, test.ordinal),
      answer: fresh !== undefined ? { bytes: fresh } : test.answerBytes === null ? null : sameFile(problem, test.ordinal),
      answerFrom: fresh !== undefined ? 'reference' : test.answerFrom,
    }
  })
  try {
    changeTests(problem, next)
  } catch (error) {
    if (error instanceof TestsRefused) return tr(`contests.judge.answersRefused.${error.why}`)
    if (error instanceof TestsMoved) return tr('contests.judge.answersStale')
    return tr('contests.judge.failed', { detail: error instanceof Error ? error.message : String(error) })
  }
  const fresh = getProblem(problem.id)
  if (fresh && fresh.referenceSource.trim()) enqueueTeacherRun(fresh, 'reference')
  return null
}

/* -------------------------------------------------------------- the clock */

/*
 * The last phase each live contest was seen in: its phase, whether its board
 * is frozen, whether its problems can be read. A change bumps the revision,
 * so every page reloads at the start (the problems appear), at the end and
 * when the freeze begins — none of which any write would otherwise announce.
 */
const phases = new Map<string, string>()

function phaseKey(contest: Contest, now: number): string {
  return `${contestPhase(contest, now)}|${boardFrozen(contest, now)}|${problemsVisible(contest, now)}`
}

export function watchPhases(now = Date.now()): void {
  const seen = new Set<string>()
  for (const contest of listContests()) {
    if (contest.state !== 'live') continue
    seen.add(contest.id)
    const key = phaseKey(contest, now)
    const before = phases.get(contest.id)
    phases.set(contest.id, key)
    if (before !== undefined && before !== key) bumpContestRevision(contest.id)
  }
  for (const id of phases.keys()) if (!seen.has(id)) phases.delete(id)
}

/* ---------------------------------------------------------- lifecycle */

/** Start a pass now instead of at the next tick: a new submission, a freed slot, a lifted pause. */
export function wakeContestJudge(): void {
  if (stopped || timer === null) return
  pumpContestJudge()
}

/**
 * Start the judge, once, with the server: the previous life's judgings back
 * to the queue (their run directories cleared), the judge's leftover
 * containers swept, then the tick. Without a judge here the clock ticks
 * anyway — the phases move by it.
 */
export function startContestJudge(): Promise<void> {
  if (timer) return Promise.resolve()
  if (starting) return starting
  stopped = false
  starting = (async () => {
    const { requeued, failed } = requeueOrphans(BOOT)
    for (const row of [...requeued, ...failed]) removeJobDir(row.contestId, row.id, row.attempt)
    const judge = currentJudge()
    let swept = 0
    if (judge) {
      try {
        swept = await judge.sweep()
      } catch (error) {
        console.warn('[contests] leftover judge containers were not swept:', error instanceof Error ? error.message : error)
      }
    }
    if (requeued.length || failed.length || swept) {
      console.log(`[contests] after restart: requeued ${requeued.length}, failed ${failed.length}, containers removed ${swept}`)
    }
    if (stopped) return
    timer = setInterval(() => {
      try {
        pumpContestJudge()
      } catch (error) {
        console.error('[contests] the judge pump failed', error)
      }
    }, TICK_MS)
    // The tick must not keep the process alive: it goes away with it.
    timer.unref?.()
    pumpContestJudge()
  })().finally(() => {
    starting = null
  })
  return starting
}

/**
 * Stop the judge with the server: no new judging starts, and every running
 * one goes back to the queue, its start not counted, before its container is
 * stopped — so the outcome a killed run reports is never written, and the
 * next life judges it from the start. Waits a few seconds for the judges to
 * let go of their containers.
 */
export async function stopContestJudge(waitMs = 5_000): Promise<void> {
  stopped = true
  if (timer) clearInterval(timer)
  timer = null
  if (starting) await starting.catch(() => undefined)
  const jobs = [...active.values()]
  for (const job of jobs) {
    requeueStopped(job.submissionId, job.attempt, BOOT)
    job.controller.abort()
  }
  await settle(jobs, waitMs)
}

async function settle(jobs: readonly ActiveJudging[], waitMs: number): Promise<boolean> {
  if (jobs.length === 0) return true
  let timeout: NodeJS.Timeout | undefined
  const late = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), waitMs)
  })
  try {
    return await Promise.race([Promise.allSettled(jobs.map((job) => job.done)).then(() => true), late])
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Hold a contest, a problem or a person back from the judge and stop what of
 * it runs — before it is removed (a contest deleted, a problem deleted, a
 * person removed). Nothing of the scope starts while it is held; each running
 * judging goes back to the queue BEFORE its container is killed, so the SE a
 * killed run reports («stopped: aborted») is never written as anybody's
 * verdict, and a removal that is then refused leaves the rows waiting to be
 * judged as if nothing happened. `ended` — none of the scope runs here any
 * more (`false` after `waitMs`: the caller refuses). `release` lets the scope
 * go again; the caller calls it whatever it did.
 */
export async function holdAndStop(scope: Scope, waitMs = 30_000): Promise<{ ended: boolean; release: () => void }> {
  const key = `${scope.contestId}\u0000${scope.problemId ?? ''}\u0000${scope.entrantId ?? ''}`
  const entry = held.get(key) ?? { scope, holders: 0 }
  entry.holders++
  held.set(key, entry)
  const jobs = [...active.values()].filter((job) => inScope(job, scope))
  for (const job of jobs) {
    requeueStopped(job.submissionId, job.attempt, BOOT)
    job.controller.abort()
  }
  await settle(jobs, waitMs)
  let released = false
  return {
    ended: jobs.every((job) => active.get(job.submissionId) !== job),
    release: () => {
      if (released) return
      released = true
      const drop = (): void => {
        if (--entry.holders <= 0) held.delete(key)
        wakeContestJudge()
      }
      /*
       * A kill the daemon has not finished yet (the caller refused after
       * `waitMs`) keeps the scope held until that run is really over: its row
       * is already back in the queue, and letting it go now would start a
       * second container on the same submission beside the first.
       */
      const lingering = jobs.filter((job) => active.get(job.submissionId) === job)
      if (lingering.length === 0) drop()
      else void Promise.allSettled(lingering.map((job) => job.done)).then(drop)
    },
  }
}

/**
 * Judge everything waiting to the end, and wait for it — for the tests and
 * the test stand, where there is no second to wait for the tick. Stops when a
 * pass starts nothing and nothing runs.
 */
export async function drainContestJudge(rounds = 200): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    pumpContestJudge()
    const jobs = [...active.values()]
    // Nothing running after a pass means nothing more can start: the rest waits for a slot, a pause, memory.
    if (jobs.length === 0) return
    await Promise.allSettled(jobs.map((job) => job.done))
  }
}

/** Pause the judge or let it go; the console's strip hears of it. */
export function pauseContestJudge(paused: boolean): void {
  setJudgePaused(paused)
  noteJudgeChanged()
  if (!paused) wakeContestJudge()
}

/* --------------------------------------------------------------- status */

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** The judge as the list's strip shows it (A1). */
export function judgeStatus(now = Date.now()): JudgeStatus {
  const counts = queueCounts()
  return {
    backend: judgeBackend(),
    running: counts.running,
    queued: counts.queued,
    slots: judgeSlots(),
    judgedToday: judgedSince(instanceDayStart(now)),
    medianMs: median(recentJudgingDurations(50)),
    paused: judgePaused(),
  }
}
