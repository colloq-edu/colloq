/**
 * Shared scaffolding for the contest-judge tests (contests-judge-*.test.mts).
 *
 * Two things the three test files all need and must not each reinvent:
 *   • `buildRequest` — a JudgeRequest with sane defaults, so a case names only
 *     what it is about (the mode, the checker, the tests);
 *   • `runHarnessNoSandbox` — the real Python harness run by the system
 *     `python3` with no container around it, through the judge's OWN stdin
 *     framing and OWN stdout assembler (docker-judge.ts). That is the point of
 *     the no-sandbox path: it proves the harness's logic (the checkers, the
 *     limits, the modes) with the same framing and parsing the docker judge
 *     uses, so a bug in either is caught without minutes of docker per case.
 *
 * It is a helper, not a test (the leading underscore keeps it out of the
 * `*.test.mts` glob), like tests/_fake-docker.mts and tests/_env.mts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { LANGUAGE_FILE, type CheckerKind, type ContestLanguage } from '../shared/contests.ts'
import { judgeDir, JUDGE_FILE } from '../server/src/contests/judge/harness.ts'
import {
  buildJobHeader,
  jobStdinChunks,
  OutcomeAssembler,
  type HarnessLine,
} from '../server/src/contests/judge/docker-judge.ts'
import type { JudgeMode, JudgeOutcome, JudgeProgress, JudgeRequest, JudgeTest } from '../server/src/contests/judge/port.ts'

/** One test as a case writes it: the input, and the answer unless the mode writes it. */
export interface TestSpec {
  ordinal: number
  input: string
  answer?: string
  sample?: boolean
  group?: number
}

export interface BuildOptions {
  language?: ContestLanguage
  source: string
  mode?: JudgeMode
  checker?: CheckerKind
  epsilon?: number
  checkerCode?: string
  timeLimitMs?: number
  memoryMb?: number
  tests: TestSpec[]
  onProgress?: (progress: JudgeProgress) => void
  /**
   * Where to lay the tests and the job out; a temp dir under the OS tmp by
   * default. The real docker test overrides it with a dir under DATA_DIR so the
   * mounts land where the daemon's VM can see them (Colima shares only $HOME,
   * and the anchored filesystem only accepts a job dir inside DATA_DIR).
   */
  root?: string
}

export interface Built {
  request: JudgeRequest
  /** The directory with `<ordinal>.in`, as the container would mount it at /tests. */
  testsDir: string
  /** Remove everything this built on disk. */
  cleanup(): void
}

/**
 * A JudgeRequest and the tests' input files on disk. The inputs live in a temp
 * `testsDir` (the queue's job in production); the answers travel in the request
 * as bytes, as the contract says (port.ts).
 */
export function buildRequest(options: BuildOptions): Built {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-judge-'))
  fs.mkdirSync(root, { recursive: true })
  const testsDir = path.join(root, 'tests')
  fs.mkdirSync(testsDir, { recursive: true })
  const mode: JudgeMode = options.mode ?? 'icpc'
  const tests: JudgeTest[] = options.tests.map((spec) => {
    fs.writeFileSync(path.join(testsDir, `${spec.ordinal}.in`), spec.input)
    return {
      ordinal: spec.ordinal,
      sample: spec.sample ?? false,
      group: spec.group ?? 0,
      answer: mode === 'answers' ? null : Buffer.from(spec.answer ?? ''),
    }
  })
  const request: JudgeRequest = {
    submissionId: 's-' + path.basename(root),
    container: 'colloq-contest-test-' + path.basename(root),
    image: 'colloq-kernel:base',
    language: options.language ?? 'python3',
    source: options.source,
    timeLimitMs: options.timeLimitMs ?? 1000,
    memoryMb: options.memoryMb ?? 256,
    testsDir,
    jobDir: path.join(root, 'job'),
    tests,
    mode,
    checker: { kind: options.checker ?? 'tokens', epsilon: options.epsilon ?? 1e-6, code: options.checkerCode ?? '' },
    onProgress: options.onProgress,
  }
  return { request, testsDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

export interface HarnessRun {
  outcome: JudgeOutcome
  /** Every JSON line the harness wrote, parsed — for asserting the protocol directly. */
  lines: HarnessLine[]
  progress: JudgeProgress[]
  stderr: string
  exitCode: number | null
}

/** Whether these tests can run the real harness here: a `python3` on PATH, and not as root. */
export function harnessRunnable(): { ok: boolean; reason: string } {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return { ok: false, reason: 'the no-sandbox harness refuses to run as root (it would run the program as root)' }
  }
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) return { ok: false, reason: 'python3 is not on PATH' }
  return { ok: true, reason: '' }
}

/**
 * Run the real harness with the system `python3`, no container, through the
 * judge's own framing and assembler. The harness reads the source from the job
 * directory and everything else (the header, the answers, the checker) from the
 * stdin the docker judge builds; its JSON lines go back through the docker
 * judge's OutcomeAssembler. Deterministic and self-contained (temp dirs only).
 */
export function runHarnessNoSandbox(built: Built): HarnessRun {
  const { request } = built
  const dir = judgeDir()
  const root = path.dirname(built.testsDir)
  const dirs = {
    job: request.jobDir,
    tests: built.testsDir,
    secret: path.join(root, 'secret'),
    work: path.join(root, 'work'),
    tmp: path.join(root, 'tmp'),
  }
  fs.mkdirSync(dirs.job, { recursive: true })
  fs.writeFileSync(path.join(dirs.job, LANGUAGE_FILE[request.language]), request.source)
  for (const place of [dirs.secret, dirs.work, dirs.tmp]) fs.mkdirSync(place, { recursive: true })

  const stdin = Buffer.concat([...jobStdinChunks(request)])
  const result = spawnSync('python3', ['-I', path.join(dir, JUDGE_FILE)], {
    input: stdin,
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      COLLOQ_JUDGE_NO_SANDBOX: '1',
      COLLOQ_JUDGE_JOB: dirs.job,
      COLLOQ_JUDGE_TESTS: dirs.tests,
      COLLOQ_JUDGE_SECRET: dirs.secret,
      COLLOQ_JUDGE_WORK: dirs.work,
      COLLOQ_JUDGE_TMP: dirs.tmp,
    },
  })

  const progress: JudgeProgress[] = []
  const assembler = new OutcomeAssembler({ tests: request.tests, mode: request.mode, onProgress: (p) => progress.push(p) })
  const lines: HarnessLine[] = []
  for (const raw of String(result.stdout ?? '').split('\n')) {
    const text = raw.trim()
    if (!text) continue
    let message: HarnessLine
    try {
      message = JSON.parse(text) as HarnessLine
    } catch {
      continue
    }
    lines.push(message)
    assembler.line(message)
  }
  const outcome = assembler.build({ oomKilled: false, killedReason: null, wallMs: 0, stderrTail: String(result.stderr ?? '') })
  return { outcome, lines, progress, stderr: String(result.stderr ?? ''), exitCode: result.status }
}
