import type { CompetitionCapabilities } from './capabilities.js'
/**
 * Что панель преподавателя спрашивает у сервера про соревнования, и что он
 * отвечает.
 *
 * Отдельным файлом от `shared/competitions.ts` намеренно: там — правила, по
 * которым сервер и браузер обязаны дать один ответ, а здесь — форма проводов.
 * Форма меняется от экрана (добавили колонку — добавили поле), правила не
 * меняются вовсе, и держать их в одном файле значит пересматривать правила
 * каждый раз, когда в макете переехала подпись.
 *
 * Ни одна строка отсюда не уезжает участнику: это ответы дверей `/api/admin`,
 * и в них есть и код метрики, и приватные числа, и ключи входа. Участнику
 * отвечают свои двери `/k`, своими типами и через `publicCompetition`.
 */
import type {
  Competition,
  CompetitionFile,
  CompetitionLimits,
  Entrant,
  MetricDirection,
  PrivateRelease,
  RankedRow,
  RunKind,
  ScoringRule,
  Submission,
  SubmissionRun,
  SubmissionState,
} from './competitions.js'

/* --------------------------------------------------------------- запросы */

/**
 * Что форма редактора (A2) посылает серверу.
 *
 * Всё необязательно, и это не лень: панель шлёт ТОЛЬКО те поля, которые
 * показывала. Редактор черновика и вкладка «Настройки» идущего соревнования —
 * разные куски одной формы, и «сохранить всё» означало бы, что вторая затирает
 * поля, которых никогда не видела.
 */
export interface CompetitionInput {
  slug?: string
  title?: string
  blurb?: string
  description?: string
  metric?: { name?: string; direction?: MetricDirection; code?: string }
  publicPercent?: number
  limits?: Partial<CompetitionLimits>
  environment?: string
  startsAt?: number | null
  deadlineAt?: number | null
  privateRelease?: PrivateRelease
  scoring?: ScoringRule
}

/* ------------------------------------------------------- список и очередь */

/**
 * Почему соревнование ещё нельзя открыть.
 *
 * Причина, а не `false`: кнопка «ОТКРЫТЬ СОРЕВНОВАНИЕ» гаснет в A2 молча, и
 * человек, у которого не хватает одного файла ответов, ищет пропажу глазами по
 * шести секциям. Считает её сервер — он же и отказывает, — чтобы экран и дверь
 * не разошлись во мнении о готовности.
 */
export type OpenRefusal =
  | 'noData'
  | 'noSolution'
  | 'noMetric'
  | 'noBaseline'
  /** Сэмпл-тетрадь загружена, но весь путь до числа ещё не прошла. */
  | 'baselineNotChecked'
  /** Приватный лидерборд открывается дедлайном, а дедлайна нет. */
  | 'noDeadline'

/** Строка списка A1 — соревнование плюс всё, что в его строке нарисовано числами. */
export interface CompetitionRow {
  competition: Competition
  /** Людей, приславших хотя бы одну посылку. Базовое решение сюда не входит. */
  entrants: number
  /** Посылок участников — без заходов сэмпл-тетради. */
  submissions: number
  /** «ЛУЧШИЙ ПУБЛИЧНЫЙ» — без базового решения: оно показано рядом отдельно. */
  bestPublic: number | null
  /** «бейзлайн 0.0587» под лучшим результатом. */
  baselineScore: number | null
  /** Чем кончился последний заход сэмпл-тетради; null — её ещё не проверяли. */
  baselineState: SubmissionState | null
  /** `null` — открывать можно. */
  ready: OpenRefusal | null
}

/** Идущий прогон — блок «ИСПОЛНЯЕТСЯ СЕЙЧАС» (A3) и полоса исполнителя (A1). */
export interface RunningNow {
  submissionId: string
  competitionId: string
  competitionSlug: string
  entrantId: string
  entrantName: string
  /** «#12». */
  number: number
  fileName: string
  kind: RunKind
  cellsDone: number
  cellsTotal: number
  startedAt: number
  /** Правая половина «01:12 из 10:00», в миллисекундах. */
  limitMs: number
  /** Имя контейнера — та же строка, что в подписи под полосой прогресса. */
  container: string | null
  /** Заход сэмпл-тетради, а не посылка участника. */
  baseline: boolean
}

/** Строка списка «ЖДУТ · N». */
export interface WaitingRow {
  submissionId: string
  competitionId: string
  entrantId: string
  entrantName: string
  number: number
  /** Место в очереди, начиная с 1 — то, что нарисовано в колонке 16 px. */
  place: number
  /** «≈ 3 мин»; null — оценить не из чего (ещё ничего не исполнялось). */
  etaMs: number | null
  baseline: boolean
}

/**
 * Очередь инстанса — одна на все соревнования, потому что исполнитель один.
 *
 * Едет и со списком A1 (полоса исполнителя), и с живым состоянием A3: это одно
 * и то же хозяйство, и показывать его двумя разными числами нельзя.
 */
export interface QueueSnapshot {
  paused: boolean
  pausedAt: number | null
  running: RunningNow[]
  waiting: number
  /** Сколько посылок за раз берёт исполнитель. */
  slots: number
  /** «сегодня исполнено 37» — по местному поясу машины. */
  doneToday: number
  /** «в среднем 2 мин 40 с»; null — сегодня ещё ничего не досчиталось. */
  averageMs: number | null
}

export interface CompetitionsList {
  competitions: CompetitionRow[]
  queue: QueueSnapshot
}

/* ---------------------------------------------------------- редактор (A2) */

/** Открытый файл данных или файл ответов глазами A2. */
export interface FileView extends CompetitionFile {
  /** Колонки CSV — «397 строк · id, orders». null: не CSV или файл слишком велик. */
  columns: string[] | null
}

/** Карточка сэмпл-тетради и её проверки. */
export interface BaselineView {
  inputsCurrent?: boolean
  inputRevision?: number | null
  notebookInputRevision?: number | null
  fileName: string
  bytes: number
  /** «14 ячеек»; null — файл не разобрался как тетрадь. */
  cells: number | null
  uploadedAt: number
  /** Посылка последнего захода; null — тетрадь загружена, но не проверялась. */
  submissionId: string | null
  state: SubmissionState | null
  publicScore: number | null
  privateScore: number | null
  durationMs: number | null
  /** Текст, который прочёл бы участник: ParticipantVisibleError метрики. */
  participantError: string | null
  /** Трейс — только преподавателю, и только здесь. */
  teacherError: string | null
}

/** Как поделятся строки ответов: «119 строк считаются сразу, 278 — после дедлайна». */
export interface SplitView {
  total: number
  publicRows: number
  privateRows: number
  /** Деление задано колонкой Usage в файле ответов, а не зерном. */
  byUsage: boolean
}

export interface CompetitionView {
  capabilities?: CompetitionCapabilities
  competition: Competition
  openFiles: FileView[]
  /** Скрытые ответы: имена, строки и колонки — содержимое не отдаётся никогда. */
  hiddenFiles: FileView[]
  baseline: BaselineView | null
  split: SplitView | null
  counts: CompetitionCounts
  ready: OpenRefusal | null
  /** Сколько весят открытые файлы против потолка `LIMITS.dataBytes`. */
  dataBytes: number
}

/* -------------------------------------------------------- соревнование идёт */

/** Пять чисел сводки A3 плюс то, что нужно строке A1. */
export interface CompetitionCounts {
  submissions: number
  /** «ДОШЛИ ДО ЧИСЛА». */
  scored: number
  notebookFailed: number
  rejected: number
  timedOut: number
  outOfMemory: number
  metricFailed: number
  cancelled: number
  entrants: number
  bestPublic: number | null
}

/** Строка ленты посылок (A3). */
export interface SubmissionRow {
  submission: Submission
  entrantName: string
  /** Заход сэмпл-тетради: в ленте он есть, но в счёт участников не идёт. */
  baseline: boolean
  /** Лучший публичный результат соревнования — «новый лучший результат». */
  best: boolean
}

export interface SubmissionFeed {
  rows: SubmissionRow[]
  /** Сколько строк отвечает фильтру целиком — для «и ещё N». */
  total: number
}

/** Живое состояние экрана A3: то, что меняется само, пока на него смотрят. */
export interface CompetitionLive {
  revision?: number
  counts: CompetitionCounts
  queue: QueueSnapshot
  /** Ждущие ЭТОГО соревнования; очередь общая, а экран один. */
  waiting: WaitingRow[]
  /** Медиана исполнения посылок этого соревнования, мс. */
  medianMs: number | null
}

/** Весь вывод одной посылки — меню строки, пункт «весь вывод». */
export interface SubmissionDetail {
  submission: Submission
  entrant: Pick<Entrant, 'id' | 'name'>
  runs: SubmissionRun[]
  /** Файлы, оставшиеся от прогона: `run.json`, `submission.csv`, тетрадь с выводом. */
  artifacts: { name: string; bytes: number }[]
}

/* ------------------------------------------------------------- участники */

/**
 * Участник в списке преподавателя — вместе с ключом входа.
 *
 * Ключ здесь есть намеренно: его диктуют вслух и вставляют в чат курса, это
 * единственный способ вернуть человека с другого устройства. Дверь, которая
 * это отдаёт, — панельная (`requireStaff`), и другого места, где ключ виден,
 * в продукте нет.
 */
export interface EntrantRow extends Entrant {
  /**
   * `K7Q-M2X-9FD` — расшифрованный ключ входа; null, если секрет инстанса
   * сменили и старый ключ больше не работает ни у кого.
   */
  key: string | null
  /** Посылок в этом соревновании; в общем списке инстанса — 0. */
  submissions: number
  /** Место в публичном лидерборде этого соревнования; null — его там нет. */
  place: number | null
  /** Сэмпл-тетрадь записана на служебного участника — его не показывают людям. */
  baseline: boolean
}

export interface EntrantsList {
  entrants: EntrantRow[]
}

/** Full authoritative standings, independent of submission feed pagination. */
export interface CompetitionLeaderboard {
  baseline?: BaselineView | null
  revision: number
  public: (RankedRow & { entrantName: string })[]
  private: (RankedRow & { entrantName: string })[]
}
