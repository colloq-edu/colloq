/**
 * Договор прогонщика — всё, что очередь знает об исполнении посылки.
 *
 * Узко нарочно. Очередь (runner.ts) не должна знать ни одного слова про
 * docker: она решает, чья работа идёт следующей, что записать в строку посылки
 * и когда убить контейнер, — а «как именно исполнить тетрадь» за этой дверью
 * бывает двух видов. Настоящий прогонщик (docker-runner.ts) поднимает два
 * одноразовых контейнера; подставной (fake-runner.ts) не исполняет ни строки
 * чужого кода и нужен не тестам ради тестов: стенд и вся сюита живут без
 * docker, а соревнование без прогонщика — страница, где нельзя нажать ни одной
 * кнопки.
 *
 * ФОРМА ОТВЕТА ОДНА НА ОБА, иначе подмена ничего не доказывает: тест, который
 * зелен на подставном и падает на настоящем, — это не тест, а украшение.
 *
 * И главное, ради чего здесь два отдельных поля вместо одного: `message`
 * участнику и `teacherOnly` преподавателю разведены НА УРОВНЕ ТИПА. Перепутать
 * их нельзя даже тогда, когда очень хочется показать человеку побольше, — а
 * хочется всегда, потому что в трассировке метрики и лежит ответ на его
 * вопрос. Вместе с ответом там лежат строки чужого solution.csv.
 */
import type { Competition, RunVerdict } from '@shared/competitions'

/** Каким путём исполняется посылка. Читается из окружения, как KERNEL_BACKEND. */
export type CompetitionBackend = 'docker' | 'test'

/**
 * Пределы ОДНОГО захода в контейнер — уже в тех числах, которыми говорит docker.
 *
 * Соревнование хранит свои (`CompetitionLimits`), но шага два, и у метрики они
 * другие: ей не нужно четыре гигабайта и десять минут, зато ей нельзя писать
 * ничего, кроме одного json. Поэтому здесь не «лимиты соревнования», а лимиты
 * шага — их считает `limitsFor` ниже, и считает в одном месте.
 */
export interface StepLimits {
  /** Общий срок шага. Вышел — контейнер убит снаружи, без уговоров. */
  wallSeconds: number
  memoryMb: number
  cpus: number
  /** Потолок процессов: посылке 256, метрике 64. */
  pids: number
  /** Потолок ОДНОГО файла, байтами, — жёсткий, ядром (SIGXFSZ). */
  fsizeBytes: number
  /** Сколько памяти отдать /tmp и рабочей папке. Считается в `memoryMb`. */
  tmpfsMb: number
  /** Потолок ответа, который обвязка забирает из контейнера. */
  targetBytes: number
  /** Мягкий потолок печати: выводы за ним считаются, но не копятся. */
  outputBytes: number
  /** Жёсткий потолок печати: за ним контейнер убивают снаружи. */
  outputKillBytes: number
}

/** Докуда дошла идущая тетрадь — то, из чего складывается «ячейка 9 из 14». */
export interface RunProgress {
  phase?: 'dependencies' | 'notebook'
  cell: number
  cells: number
  outputBytes: number
}

/** Заказ на исполнение тетради. Пути — уже разложенные каталоги (storage.ts). */
export interface RunRequest {
  /** Immutable base binding; absent only for legacy callers. */
  imageDigest?: string
  /** Published bundle directory: requirements.lock and wheels/. */
  dependenciesDir?: string
  competition: Competition
  submissionId: string
  /** Имя контейнера; по нему же его убивают. Даётся снаружи, до запуска. */
  container: string
  /** Открытая половина данных. `:ro`, и только она. */
  dataDir: string
  /** Каталог с одной тетрадью. Каталог, а не файл, — см. шапку storage.ts. */
  inputDir: string
  /** Единственное место, куда посылка пишет на диск хоста. */
  resultDir: string
  limits: StepLimits
  /** Зовётся по ходу прогона; очередь кладёт это в строку посылки. */
  onProgress?: (progress: RunProgress) => void
}

/** Что стало с тетрадью. То же самое на обоих прогонщиках. */
export interface RunOutcome {
  /** Слово обвязки, не переведённое и не приукрашенное (`RunVerdict`). */
  status: RunVerdict
  /** На какой ячейке кончилось и сколько их было; `-1` — не начиналась. */
  cell: number
  cells: number
  /** Сколько шёл шаг, миллисекундами. */
  wall: number
  /** Путь к забранному ответу; `null` — посылка его не записала. */
  submission: string | null
  /**
   * Текст, который участник читает дословно.
   *
   * У упавшей ячейки это его собственная трассировка: он её и писал, и прятать
   * её от него значит отвечать «ошибка в тетради» на вопрос «какая».
   */
  detail: string
  /** Код выхода, OOM, хвост журнала контейнера — только преподавателю. */
  log: string
  diagnostics: RunDiagnostics
}

export interface RunDiagnostics {
  exit: number | null
  oomKilled: boolean
  backend: CompetitionBackend
  /** Кто оборвал контейнер снаружи: срок, печать, запись на диск. */
  killedBy?: 'wall' | 'output' | 'disk'
  /** Пик памяти, снятый обвязкой изнутри, — по нему видно «ровно в лимит». */
  peakBytes?: number | null
}

/** Заказ на подсчёт метрики. Участника в этом контейнере нет. */
export interface ScoreRequest {
  /** The scorer's pinned base, without participant packages. */
  imageDigest?: string
  competition: Competition
  submissionId: string
  container: string
  /** Закрытая половина: solution.csv и код метрики. Только сюда и только `:ro`. */
  secretDir: string
  /** Каталог с одной копией ответа. Ни тетради участника, ни её вывода. */
  submissionDir: string
  /** Куда метрика пишет свой единственный json. */
  outDir: string
  limits: StepLimits
}

/** Что сказала метрика. */
export interface ScoreOutcome {
  status: RunVerdict
  public: number | null
  private: number | null
  /** ParticipantVisibleError — участник читает это дословно. */
  message: string | null
  /** Трассировка и всё прочее — только преподавателю. */
  teacherOnly: string | null
  wall: number
  diagnostics: RunDiagnostics
}

/** Сколько памяти на машине ещё можно раздать; `null` — честно не знаем. */
export interface Capacity {
  availableMb: number | null
}

export interface CompetitionRunner {
  readonly backend: CompetitionBackend
  run(request: RunRequest): Promise<RunOutcome>
  score(request: ScoreRequest): Promise<ScoreOutcome>
  /** Убить идущий контейнер по имени. Молча, если его уже нет. */
  kill(container: string): Promise<void>
  /** Убрать за собой всё, что осталось от прошлой жизни процесса. */
  sweep(): Promise<number>
  capacity(): Promise<Capacity>
}

let injected: CompetitionRunner | null = null
let chosen: CompetitionRunner | null = null

/**
 * Подменить прогонщик — тестам.
 *
 * Тот же приём и по той же причине, что `useDockerForLimits` в pool.ts: тесту,
 * которому нужен OOM на третьей ячейке, надо сказать это прямо, а не
 * подстраивать под него настоящий docker. Впрыск старше умолчания; `null`
 * возвращает как было.
 */
export function useCompetitionRunner(fake: CompetitionRunner | null): void {
  injected = fake
}

/** Забыть выбранный прогонщик — после смены COMPETITION_BACKEND в тесте. */
export function forgetCompetitionRunner(): void {
  chosen = null
}

/**
 * Каким путём идут посылки.
 *
 * Отдельная переменная, а не `KERNEL_BACKEND`: у комнат есть третий путь
 * (брокер), которого у соревнований нет и в ближайшее время не будет, а
 * `KERNEL_BACKEND=broker` на боевой машине не означает, что соревнованиям
 * нельзя поднять docker рядом. Умолчание выводится из того же места, откуда
 * его берут комнаты, чтобы `NODE_ENV=test` не требовал второй строки в .env.
 */
export function competitionBackend(env: NodeJS.ProcessEnv = process.env): CompetitionBackend {
  const asked = (env.COMPETITION_BACKEND ?? '').trim()
  if (asked) {
    if (asked !== 'docker' && asked !== 'test') {
      throw new Error(`Unknown competition backend: ${asked}`)
    }
    if (asked === 'test' && env.NODE_ENV !== 'test') {
      throw new Error('The test competition backend requires NODE_ENV=test')
    }
    return asked
  }
  return env.NODE_ENV === 'test' ? 'test' : 'docker'
}

/**
 * Прогонщик этого процесса.
 *
 * Импорты ленивые: подставному незачем тянуть за собой сборку аргументов
 * docker, а настоящему — разбор директив из тетради. Но главное, зачем они
 * ленивые, — порядок загрузки модулей: `runner.ts` грузится с сервером, а
 * выбор пути зависит от окружения, которое тест правит перед вызовом.
 */
export function competitionRunner(): CompetitionRunner {
  if (injected) return injected
  if (chosen) return chosen
  chosen = competitionBackend() === 'docker' ? dockerRunner() : fakeRunner()
  return chosen
}

/* Разорвать круг импорта: оба прогонщика импортируют типы отсюда. */
let dockerFactory: (() => CompetitionRunner) | null = null
let fakeFactory: (() => CompetitionRunner) | null = null

/** Зарегистрировать себя — зовётся из самих прогонщиков при загрузке модуля. */
export function registerCompetitionRunner(
  kind: CompetitionBackend,
  factory: () => CompetitionRunner,
): void {
  if (kind === 'docker') dockerFactory = factory
  else fakeFactory = factory
}

function dockerRunner(): CompetitionRunner {
  if (!dockerFactory) throw new Error('The Docker competition runner is not registered')
  return dockerFactory()
}

function fakeRunner(): CompetitionRunner {
  if (!fakeFactory) throw new Error('The test competition runner is not registered')
  return fakeFactory()
}

/* ------------------------------------------------------------------ числа */

/**
 * Сколько секунд терпеть метрику.
 *
 * Метрика на двадцати тысячах строк считается за долю секунды; сто двадцать
 * секунд — это не запас на большие данные, а срок, за которым висящий код
 * преподавателя перестаёт занимать исполнителя всего инстанса. Своё число, а
 * не срок соревнования: десять минут на тетрадь участника разумны, десять
 * минут на `score()` не бывают.
 */
export const METRIC_WALL_SECONDS = 120

/** Памяти метрике — не больше двух гигабайт: в ней один pandas и два вызова. */
export const METRIC_MEMORY_MB = 2048

/** Метрика пишет один json; большего ей не нужно. */
export const METRIC_FSIZE_BYTES = 1024 * 1024

/**
 * Пределы шага — из пределов соревнования.
 *
 * Одним местом на оба прогонщика и на оба шага. Числа не круглые, а выведенные
 * из памяти шага: `/out` и `/tmp` считаются в `--memory`, и отдать им половину
 * значит отнять её у обучения. Восьмая доля — то, на чём стоял прототип
 * (512 МБ при четырёх гигабайтах), с полом в 128 МБ, ниже которого не
 * поместится ни один разумный ответ.
 */
export function limitsFor(competition: Competition, step: 'notebook' | 'metric'): StepLimits {
  const { limits } = competition
  if (step === 'metric') {
    return {
      wallSeconds: METRIC_WALL_SECONDS,
      memoryMb: Math.min(METRIC_MEMORY_MB, Math.max(512, limits.memoryMb)),
      cpus: limits.cpus,
      pids: 64,
      fsizeBytes: METRIC_FSIZE_BYTES,
      tmpfsMb: 128,
      targetBytes: METRIC_FSIZE_BYTES,
      outputBytes: 0,
      outputKillBytes: 0,
    }
  }
  const tmpfsMb = Math.max(128, Math.min(2048, Math.floor(limits.memoryMb / 8)))
  return {
    wallSeconds: limits.wallSeconds,
    memoryMb: limits.memoryMb,
    cpus: limits.cpus,
    pids: 256,
    /*
     * Вчетверо от потолка ответа: `--ulimit fsize` сторожит не ответ (его
     * сторожит обвязка), а того, кто пишет прямо в смонтированный каталог
     * хоста. Впритык поставить нельзя — у участника бывают законные временные
     * файлы крупнее ответа.
     */
    fsizeBytes: TARGET_BYTES * 4,
    tmpfsMb,
    targetBytes: TARGET_BYTES,
    outputBytes: SOFT_OUTPUT_BYTES,
    outputKillBytes: HARD_OUTPUT_BYTES,
  }
}

/**
 * Потолок ответа — тот же, что объявлен продуктом (`LIMITS.submissionBytes`).
 *
 * Не импортируется отсюда константой окружения нарочно: число обязано быть
 * одним и тем же в трёх местах — в проверке обвязки внутри контейнера, в
 * `--ulimit` снаружи и в подписи на странице соревнования.
 */
const TARGET_BYTES = 64 * 1024 * 1024

/**
 * Два потолка печати, и оба нужны.
 *
 * Мягкий (в обвязке) не даёт выводам копиться в памяти: без него тетрадь,
 * печатающая гигабайты, умирает по OOM, и в журнале это выглядит как нехватка
 * памяти на обучении. Но печать и после него жжёт процессор — прототип
 * намерил тридцать три секунды на восьми гигабайтах. Жёсткий (снаружи, по
 * маячку) обрывает такое за две.
 */
const SOFT_OUTPUT_BYTES = 2_000_000
const HARD_OUTPUT_BYTES = 64 * 1024 * 1024
