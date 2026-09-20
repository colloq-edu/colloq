/**
 * Что страницы `/k` спрашивают у сервера и что он отвечает.
 *
 * Отдельно от `shared/competitions-api.ts` по той же границе, по которой
 * разведены двери: там ответы `/api/admin` — с кодом метрики, приватными
 * числами и ключами входа, здесь ответы `/api/k` — то, что можно показать
 * кому угодно с адресом соревнования. Один файл на оба набора означал бы, что
 * поле, дописанное в строку панели, уезжает участнику молча.
 *
 * Типы общие для сервера и браузера нарочно: экран участника и дверь, которая
 * его кормит, расходятся тихо — ответ становится на поле короче, страница
 * рисует `undefined` там, где было место, и никто ничего не замечает до пары.
 */
import type {
  CompetitionPublic,
  Entrant,
  EntrantSubmission,
  SubmissionStage,
} from './competitions.js'

/** Открыт ли приём — то же слово, что возвращает `submissionsOpen`. */
export type Accepting = 'open' | 'not_open' | 'closed'

/** Кто я и чем возвращаюсь: карточка «ВАШ КЛЮЧ ВХОДА» (P1). */
export interface EntrantMe {
  entrant: Entrant | null
  /** `K7Q-M2X-9FD` — только своему хозяину. */
  key: string | null
  /** Полный адрес ссылки для входа; null, если ключа нет. */
  link: string | null
}

/** Что человек знает о себе в одном соревновании — блок «ВЫ» карточки P1. */
export interface EntrantStanding {
  joined: boolean
  place: number | null
  score: number | null
  submissions: number
  /** Ждут очереди или исполняются прямо сейчас. */
  inFlight: number
  /** Сколько посылок осталось сегодня; null — предела нет. */
  leftToday: number | null
}

/** Открытый файл данных на скачивание. */
export interface EntrantFile {
  name: string
  bytes: number
  /** Строк в таблице; null — файл не CSV или слишком велик, чтобы считать. */
  rows: number | null
}

/** Строка списка соревнований (P1). */
export interface EntrantCompetitionRow {
  competition: CompetitionPublic
  entrants: number
  submissions: number
  bestPublic: number | null
  baselinePublic: number | null
  privateOpen: boolean
  /** null — человек не вошёл: ключа у него ещё нет. */
  mine: EntrantStanding | null
}

export interface EntrantCompetitionList {
  entrant: Entrant | null
  competitions: EntrantCompetitionRow[]
}

/** Страница одного соревнования: задача, файлы, условия проверки. */
export interface EntrantCompetitionView {
  competition: CompetitionPublic
  files: EntrantFile[]
  entrants: number
  submissions: number
  bestPublic: number | null
  baselinePublic: number | null
  privateOpen: boolean
  accepting: Accepting
  mine: EntrantStanding | null
}

/**
 * Строка лидерборда.
 *
 * Имя и место — всем; `you` отмечает свою строку (её подсвечивают целиком), а
 * `number` и то, ЧЕМ посылка попала в зачёт, рисуют колонку «ПОСЫЛКА В ЗАЧЁТ»
 * (P3). Приватного числа до открытия итогов здесь нет вовсе: таблица
 * приходит пустой, а не нулевой.
 */
export interface EntrantBoardLine {
  place: number
  entrantId: string
  name: string
  score: number
  submissionId: string
  /** «#12» в колонке «ПОСЫЛКА В ЗАЧЁТ». */
  number: number
  /** Автор выбрал её сам — иначе это лучшая по публичной части. */
  chosen: boolean
  /** Сколько посылок у человека за всё соревнование. */
  submissions: number
  /** Строка базового решения: в макете она отбита пунктиром внизу таблицы. */
  baseline: boolean
  you: boolean
}

export interface EntrantLeaderboard {
  public: EntrantBoardLine[]
  /** `null` — итоги ещё закрыты. Это не «пусто»: под них нельзя подогнаться. */
  private: EntrantBoardLine[] | null
  privateOpen: boolean
  baselinePublic: number | null
}

/**
 * Живое состояние посылки, которая ещё идёт.
 *
 * Отдельно от самой посылки, а не полями в ней: строка посылки лежит в базе и
 * меняется на переходах, а это — очередь, которая перестраивается от чужих
 * работ. Держать их вместе значило бы переписывать посылку каждый раз, когда
 * кто-то другой прислал свою.
 */
export interface SubmissionLive {
  submissionId: string
  /** Место в очереди ВСЕГО инстанса, с единицы; null — уже исполняется. */
  place: number | null
  /** «≈ 6 мин»; null — мерить не по чему, соревнование ещё ничего не считало. */
  etaMs: number | null
  /** Когда взяли в работу; null — ещё ждёт. */
  startedAt: number | null
  /** Правая половина «01:12 из 10:00». */
  limitMs: number
  /** Номер СВОЕЙ посылки прямо перед этой; null — впереди только чужие. */
  aheadNumber: number | null
  /** Докуда дошла — то же, что в посылке, но обновляется потоком. */
  stage: SubmissionStage
  cellsDone: number
  cellsTotal: number
}

/** «Мои посылки» (P2, P4) — и всё, чем распоряжается зона отправки. */
export interface EntrantSubmissions {
  submissions: EntrantSubmission[]
  leftToday: number | null
  perDay: number
  inFlight: number
  accepting: Accepting
  joined: boolean
  /** Только про те посылки, что ещё идут; у остальных живого нечему быть. */
  live: SubmissionLive[]
  /** Очередь инстанса остановлена преподавателем — ждущие стоят не просто так. */
  paused: boolean
}

/** Ответ на отправку тетради. */
export interface SubmissionAccepted {
  submission: EntrantSubmission
  leftToday: number | null
}
