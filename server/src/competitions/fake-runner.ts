/**
 * Подставной прогонщик: чем жить продукту на машине без docker.
 *
 * Нужен не тестам ради тестов. Стенд (`KERNEL_BACKEND=test`) и вся сюита
 * работают без docker, а соревнование без прогонщика — это страница, на
 * которой нельзя нажать ни одной кнопки: очередь стоит, лидерборд пуст, выбор
 * посылки нечем проверить. Настоящий docker в сюите поднимать нельзя (минуты
 * на случай и контейнеры на машине разработчика), поэтому подставной обязан
 * давать ту же ФОРМУ ответа, включая исходы, которые бывают только у него.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ НИКОГДА: не исполняет ни строки кода из присланной
 * тетради. Директива разбирается как json и только из исходника ячеек. Иначе
 * «прогонщик без изоляции» стал бы дырой ровно там, где её меньше всего ждут,
 * — на машине разработчика и в CI.
 *
 * ДВА СЛОЯ, и это ровно тот приём, которым в этом коде уже подменяют docker
 * (pool.ts · useDockerForLimits).
 *
 * Слой первый — впрыск (`useCompetitionRunner`): тест, которому нужен OOM на
 * третьей ячейке, говорит это прямо и ничего не разбирает.
 *
 * Слой второй — умолчание, работающее само, без единой строчки в тесте.
 * Прогонщик ЧИТАЕТ присланную тетрадь и ищет строку
 *
 *     # colloq-test: {"status": "timeout", "cell": 3}
 *
 * Есть — исполняет её; нет — ведёт себя как добросовестная посылка: отдаёт
 * ответ из сэмпла соревнования и даёт УСТОЙЧИВОЕ число, выведенное из
 * содержимого ответа.
 *
 * Устойчивость числа — не украшение. Лидерборд, «лучшая посылка участника» и
 * итоговый пересчёт после дедлайна — это сравнение чисел; случайные числа
 * превращают такую проверку в монетку.
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

/** `# colloq-test: {...}` — единственное, что подставной прогонщик читает из тетради. */
const DIRECTIVE = /^\s*#\s*colloq-test:\s*(\{.*\})\s*$/m

/** Образец ответа в открытых данных — так его зовут все соревнования этого рода. */
export const SAMPLE_ANSWER_FILE = 'sample_submission.csv'

/**
 * Слова прототипа с подчёркиванием — те же исходы, что `RunVerdict` пишет
 * через дефис. Директиву пишет человек, и заставлять его помнить, где в
 * словаре дефис, а где подчёркивание, — способ получить тест, который молча
 * проверяет не то.
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

/** Что тетрадь просит с собой сделать. Мусор в директиве — не беда: обычный путь. */
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

/** Сколько в тетради ячеек с кодом — то, что участник видит в «ячейка 9 из 14». */
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
 * Число, выведенное из содержимого, — одно и то же при каждом пересчёте.
 *
 * Разные ответы дают разные числа, один и тот же — всегда своё. Без этого
 * «пересчитать всех после правки метрики» проверить нечем: таблица до и после
 * различалась бы всегда, и тест не отличил бы починку от поломки.
 */
export function stableScore(seed: string, low: number, high: number): number {
  const digest = createHash('sha256').update(seed).digest()
  // Пятьдесят три бита — всё, что double держит целым; больше брать нечем.
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
 * Прогонщик стенда и сюиты.
 *
 * Поля, которые тест может подкрутить, — публичные нарочно: проверка «очередь
 * не берёт работу, когда на машине нет памяти» не должна поднимать машину без
 * памяти.
 */
export class FakeCompetitionRunner implements CompetitionRunner {
  readonly backend = 'test' as const

  /** Сколько памяти «есть на машине». `null` — честно не знаем. */
  availableMb: number | null = 65_536

  /** Идущие прогоны: имя контейнера → как его оборвать. */
  private readonly live = new Map<string, () => void>()

  /** Убитые контейнеры — чтобы прогон, который ещё не начался, узнал об этом. */
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
     * Добросовестная посылка отдаёт образец ответа соревнования: другого файла
     * с нужными строками на машине без docker взять неоткуда, а без ответа
     * нечего считать метрике. Нет образца — посылка честно получает «файл не
     * записан», и это ровно тот исход, который увидел бы участник.
     */
    const sample = this.sampleAnswer(request)
    if (!sample) return this.outcome('no-submission', { cell, cells, started })
    competitionsFs.mkdirSync(request.resultDir, { recursive: true })
    const answer = path.join(request.resultDir, SUBMISSION_FILE)
    /*
     * Ответ помечается отпечатком ПРИСЛАННОЙ ТЕТРАДИ, и это не украшение: все
     * посылки копируют один и тот же образец, а число метрика выводит из
     * содержимого ответа. Без отпечатка весь класс получил бы одинаковый
     * результат, и лидерборд, «лучшая посылка» и пересчёт проверялись бы на
     * таблице, где все строки равны.
     */
    const stamp = createHash('sha256').update(notebook ?? Buffer.alloc(0)).digest('hex').slice(0, 16)
    // Директива едет в метрику через сам ответ: второго шага тетрадь не видит.
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
        /* мусор в директиве не роняет очередь стенда */
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
   * Образец ответа — `sample_submission.csv` из открытых данных.
   *
   * Там же, где его ищет участник: соревнование выкладывает образец рядом с
   * `train.csv` и `test.csv`, и это единственный файл с правильным набором
   * строк, до которого дотягивается прогонщик, не заглядывая в ответы.
   * Запасной путь — тот же файл, положенный рядом с сэмпл-тетрадью.
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
   * Постоять под именем контейнера, пока не убьют.
   *
   * Без этого «убить идущий прогон» проверить нечем: подставной прогонщик
   * отвечает за микросекунду, и убивать в нём попросту некого. Директива
   * `{"hold": 5000}` даёт работе время, за которое её успевают снять, а
   * `kill()` обрывает ожидание сразу же, не дожидаясь срока.
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
