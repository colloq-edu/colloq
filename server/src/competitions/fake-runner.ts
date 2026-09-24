/**
 * A stand-in runner: what the product lives on on a machine without docker.
 *
 * It is not there for the tests' own sake. The test stand
 * (`KERNEL_BACKEND=test`) and the whole suite work without docker, and a
 * competition without a runner is a page on which no button can be pressed:
 * the queue stands still, the leaderboard is empty, the choice of submission
 * cannot be checked with anything. Real docker cannot be started in the suite
 * (minutes per case and containers on the developer's machine), so the
 * stand-in must give the same SHAPE of answer, including the outcomes that
 * only real docker produces.
 *
 * WHAT IT NEVER DOES: it does not execute a single line of code from the
 * submitted notebook. The directive is parsed as JSON, and only from the
 * cells' source. Otherwise "a runner without isolation" would become a hole
 * exactly where it is least expected — on the developer's machine and in CI.
 *
 * TWO LAYERS, and this is exactly the trick this code already uses to swap
 * out docker (pool.ts · useDockerForLimits).
 *
 * Layer one is injection (`useCompetitionRunner`): a test that needs an OOM on
 * the third cell says so directly and parses nothing.
 *
 * Layer two is a default that works by itself, without a single line in the
 * test. The runner READS the submitted notebook and looks for the line
 *
 *     # colloq-test: {"status": "timeout", "cell": 3}
 *
 * If it is there, the runner carries it out; if not, it behaves like a
 * conscientious submission: it hands over the answer from the competition's
 * sample and gives a STABLE number derived from the content of the answer.
 *
 * The stability of the number is not decoration. The leaderboard, "the
 * participant's best submission" and the final rescoring after the deadline
 * are comparisons of numbers; random numbers turn such a check into a coin
 * toss.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { competitionsFs } from './storage.js'
import { baselineDir, NOTEBOOK_FILE, SUBMISSION_FILE } from './storage.js'
import {
  registerCompetitionRunner,
  type Capacity,
  type CompetitionRunner,
  type RunOutcome,
  type RunRequest,
  type ScoreOutcome,
  type ScoreRequest,
} from './runner-port.js'
import type { RunVerdict } from '@shared/competitions'

/** `# colloq-test: {...}` — all the stand-in runner ever reads from a notebook. */
const DIRECTIVE = /^\s*#\s*colloq-test:\s*(\{.*\})\s*$/m

/** The sample answer in the open data — all competitions of this kind call it that. */
export const SAMPLE_ANSWER_FILE = 'sample_submission.csv'

/**
 * The prototype's words with underscores — the same outcomes that `RunVerdict`
 * writes with a hyphen. A person writes the directive, and making them
 * remember where the vocabulary has a hyphen and where an underscore is a way
 * to get a test that silently checks the wrong thing.
 */
const ALIASES: Record<string, RunVerdict> = {
  out_of_memory: 'out-of-memory',
  no_submission: 'no-submission',
  oom: 'out-of-memory',
}

const KNOWN = new Set<string>([
  'ok',
  'cell_error',
  'cell_timeout',
  'kernel_died',
  'exit',
  'target_too_large',
  'target_unreadable',
  'harness_error',
  'no-submission',
  'out-of-memory',
  'timeout',
  'participant_error',
  'metric_error',
])

function asVerdict(raw: unknown, fallback: RunVerdict): RunVerdict {
  const value = typeof raw === 'string' ? (ALIASES[raw] ?? raw) : ''
  return KNOWN.has(value) ? (value as RunVerdict) : fallback
}

/**
 * What the notebook asks to have done to it. Garbage in the directive is no
 * trouble: the ordinary path.
 */
export function directiveOf(notebook: Buffer | string): Record<string, unknown> {
  let book: unknown
  try {
    book = JSON.parse(typeof notebook === 'string' ? notebook : notebook.toString('utf8'))
  } catch {
    return {}
  }
  const cells = (book as { cells?: unknown })?.cells
  if (!Array.isArray(cells)) return {}
  for (const cell of cells) {
    const source = (cell as { source?: unknown })?.source
    const text = Array.isArray(source) ? source.join('') : typeof source === 'string' ? source : ''
    const found = DIRECTIVE.exec(text)
    if (!found) continue
    try {
      const asked: unknown = JSON.parse(found[1])
      return asked && typeof asked === 'object' && !Array.isArray(asked)
        ? (asked as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** The notebook's code cell count — what the participant sees in "cell 9 of 14". */
export function cellsOf(notebook: Buffer | string): number {
  try {
    const book: unknown = JSON.parse(
      typeof notebook === 'string' ? notebook : notebook.toString('utf8'),
    )
    const cells = (book as { cells?: unknown })?.cells
    if (!Array.isArray(cells)) return 0
    return cells.filter((cell) => (cell as { cell_type?: unknown })?.cell_type === 'code').length
  } catch {
    return 0
  }
}

/**
 * A number derived from the content — the same on every rescoring.
 *
 * Different answers give different numbers, the same answer always its own.
 * Without this, "rescore everyone after fixing the metric" cannot be checked:
 * the table before and after would always differ, and a test could not tell a
 * fix from a breakage.
 */
export function stableScore(seed: string, low: number, high: number): number {
  const digest = createHash('sha256').update(seed).digest()
  // Fifty-three bits: all that a double holds as an integer; it cannot hold more.
  const fraction = Number(digest.readBigUInt64BE(0) >> 11n) / 2 ** 53
  return Math.round((low + fraction * (high - low)) * 1e6) / 1e6
}

function readFile(file: string): Buffer | null {
  try {
    return competitionsFs.readFileSync(file) as Buffer
  } catch {
    return null
  }
}

/**
 * The runner of the test stand and the suite.
 *
 * The fields a test may tweak are public on purpose: the check "the queue does
 * not take work when the machine has no memory" should not have to bring up a
 * machine without memory.
 */
export class FakeCompetitionRunner implements CompetitionRunner {
  readonly backend = 'test' as const

  /** How much memory "the machine has". `null` means we honestly do not know. */
  availableMb: number | null = 65_536

  /** Runs in progress: container name → how to cut it short. */
  private readonly live = new Map<string, () => void>()

  /** Killed containers — so that a run that has not started yet learns about it. */
  private readonly killed = new Set<string>()

  async run(request: RunRequest): Promise<RunOutcome> {
    const started = Date.now()
    const notebook = readFile(path.join(request.inputDir, NOTEBOOK_FILE))
    const asked = notebook ? directiveOf(notebook) : {}
    const cells = notebook ? cellsOf(notebook) : 0
    const cell = typeof asked.cell === 'number' ? asked.cell : Math.max(0, cells - 1)

    request.onProgress?.({ cell: 0, cells, outputBytes: 0 })
    const held = await this.hold(request.container, asked)
    if (held === 'killed') {
      return this.outcome('timeout', { cell, cells, started, killedBy: 'wall' })
    }
    request.onProgress?.({ cell, cells, outputBytes: 0 })

    const status = asVerdict(asked.status, 'ok')
    if (status !== 'ok') {
      return this.outcome(status, {
        cell,
        cells,
        started,
        detail: typeof asked.detail === 'string' ? asked.detail : '',
        log: typeof asked.log === 'string' ? asked.log : '',
        oom: status === 'out-of-memory',
        exit: status === 'timeout' ? 137 : 1,
      })
    }

    /*
     * A conscientious submission hands over the competition's sample answer:
     * on a machine without docker there is nowhere else to get a file with the
     * right rows, and without an answer the metric has nothing to score. No
     * sample — the submission honestly gets "file not written", and that is
     * exactly the outcome the participant would have seen.
     */
    const sample = this.sampleAnswer(request)
    if (!sample) return this.outcome('no-submission', { cell, cells, started })
    competitionsFs.mkdirSync(request.resultDir, { recursive: true })
    const answer = path.join(request.resultDir, SUBMISSION_FILE)
    /*
     * The answer is stamped with the fingerprint of the SUBMITTED NOTEBOOK, and
     * that is not decoration: all submissions copy the same sample, and the
     * metric derives its number from the content of the answer. Without the
     * stamp the whole class would get the same result, and the leaderboard,
     * "the best submission" and rescoring would be checked on a table where
     * all rows are equal.
     */
    const stamp = createHash('sha256').update(notebook ?? Buffer.alloc(0)).digest('hex').slice(0, 16)
    // The directive travels to the metric through the answer itself: the
    // second step does not see the notebook.
    const head = Object.keys(asked).length ? `# colloq-test: ${JSON.stringify(asked)}\n` : ''
    const body = Buffer.concat([
      Buffer.from(head, 'utf8'),
      sample,
      Buffer.from(`\n# colloq-run: ${stamp}\n`, 'utf8'),
    ])
    competitionsFs.writeFileSync(answer, body, { mode: 0o600 })
    return this.outcome('ok', { cell: cells - 1, cells, started, submission: answer })
  }

  async score(request: ScoreRequest): Promise<ScoreOutcome> {
    const started = Date.now()
    const answer = readFile(path.join(request.submissionDir, SUBMISSION_FILE))
    if (!answer) {
      return {
        status: 'metric_error',
        public: null,
        private: null,
        message: null,
        teacherOnly: 'fake runner: no submission.csv to score',
        wall: Date.now() - started,
        diagnostics: { exit: 1, oomKilled: false, backend: this.backend },
      }
    }
    const head = answer.subarray(0, 4096).toString('utf8')
    const found = DIRECTIVE.exec(head)
    let asked: Record<string, unknown> = {}
    if (found) {
      try {
        const parsed: unknown = JSON.parse(found[1])
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          asked = parsed as Record<string, unknown>
        }
      } catch {
        /* garbage in the directive does not bring down the stand's queue */
      }
    }
    const held = await this.hold(request.container, asked)
    const wall = Date.now() - started
    const diagnostics = { exit: 0, oomKilled: false, backend: this.backend }
    if (held === 'killed') {
      return {
        status: 'metric_error',
        public: null,
        private: null,
        message: null,
        teacherOnly: 'fake runner: metric container killed',
        wall,
        diagnostics: { ...diagnostics, exit: 137 },
      }
    }
    const status = asVerdict(asked.metric, 'ok')
    if (status === 'participant_error') {
      return {
        status,
        public: null,
        private: null,
        message:
          typeof asked.message === 'string'
            ? asked.message
            : JSON.stringify({ code: 'missingRows', params: { count: 100, column: 'id', example: '398692' } }),
        teacherOnly: null,
        wall,
        diagnostics: { ...diagnostics, exit: 1 },
      }
    }
    if (status === 'metric_error') {
      return {
        status,
        public: null,
        private: null,
        message: null,
        teacherOnly:
          typeof asked.teacherOnly === 'string'
            ? asked.teacherOnly
            : 'ZeroDivisionError: division by zero\n  File "metric.py", line 7, in score',
        wall,
        diagnostics: { ...diagnostics, exit: 1 },
      }
    }
    const seed = createHash('sha256').update(answer).digest('hex')
    return {
      status: 'ok',
      public: typeof asked.public === 'number' ? asked.public : stableScore(`${seed}:public`, 0.5, 1),
      private: typeof asked.private === 'number' ? asked.private : stableScore(`${seed}:private`, 0.5, 1),
      message: null,
      teacherOnly: null,
      wall,
      diagnostics,
    }
  }

  /**
   * The sample answer — `sample_submission.csv` from the open data.
   *
   * In the same place where the participant looks for it: a competition puts
   * the sample next to `train.csv` and `test.csv`, and it is the only file with
   * the right set of rows that the runner can reach without looking into the
   * answers. The fallback is the same file placed next to the sample notebook.
   */
  private sampleAnswer(request: RunRequest): Buffer | null {
    return (
      readFile(path.join(request.dataDir, SAMPLE_ANSWER_FILE)) ??
      readFile(path.join(baselineDir(request.competition.id), SUBMISSION_FILE))
    )
  }

  async kill(container: string): Promise<void> {
    this.killed.add(container)
    this.live.get(container)?.()
  }

  async sweep(): Promise<number> {
    const held = this.live.size
    for (const stop of this.live.values()) stop()
    this.live.clear()
    this.killed.clear()
    return held
  }

  async capacity(): Promise<Capacity> {
    return { availableMb: this.availableMb }
  }

  /**
   * Stay under the container's name until killed.
   *
   * Without this, "kill a running run" cannot be checked: the stand-in runner
   * answers within a microsecond, and there is simply nobody in it to kill.
   * The directive `{"hold": 5000}` gives the work enough time to be taken
   * down, and `kill()` cuts the wait short at once, without waiting for the
   * deadline.
   */
  private hold(container: string, asked: Record<string, unknown>): Promise<'done' | 'killed'> {
    if (this.killed.has(container)) return Promise.resolve('killed')
    const ms = typeof asked.hold === 'number' && asked.hold > 0 ? Math.min(asked.hold, 60_000) : 0
    if (ms === 0) return Promise.resolve('done')
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.live.delete(container)
        resolve('done')
      }, ms)
      this.live.set(container, () => {
        clearTimeout(timer)
        this.live.delete(container)
        resolve('killed')
      })
    })
  }

  private outcome(
    status: RunVerdict,
    parts: {
      cell: number
      cells: number
      started: number
      submission?: string
      detail?: string
      log?: string
      oom?: boolean
      exit?: number
      killedBy?: 'wall' | 'output' | 'disk'
    },
  ): RunOutcome {
    return {
      status,
      cell: parts.cell,
      cells: parts.cells,
      wall: Date.now() - parts.started,
      submission: parts.submission ?? null,
      detail: parts.detail ?? '',
      log: parts.log ?? '',
      diagnostics: {
        exit: parts.exit ?? (status === 'ok' ? 0 : 1),
        oomKilled: parts.oom ?? false,
        backend: this.backend,
        killedBy: parts.killedBy,
      },
    }
  }
}

registerCompetitionRunner('test', () => new FakeCompetitionRunner())
