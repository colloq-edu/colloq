/**
 * Соревнования: типы и правила, общие серверу и вебу.
 *
 * Соревнование — это задача с ответами, которых участник не видит. Он
 * присылает ТЕТРАДЬ, сервер исполняет её с нуля в одноразовом контейнере без
 * сети, забирает написанный ею `submission.csv` и вторым, отдельным
 * контейнером считает по нему метрику преподавателя. Метрика зовётся дважды —
 * на публичной части строк и на приватной; публичный лидерборд виден всегда,
 * приватный скрыт до дедлайна, чтобы под него нельзя было подогнаться.
 *
 * ЧТО ЛЕЖИТ ИМЕННО ЗДЕСЬ, а не на сервере. Правила, у которых обе стороны
 * обязаны дать один и тот же ответ: сколько посылок осталось сегодня (участник
 * видит число в зоне загрузки, сервер по нему отказывает), какая посылка идёт
 * в зачёт, как сортируется лидерборд и как строки делятся на публичную и
 * приватную часть. Разъехавшись, эти копии не падают — они тихо врут, и
 * замечает это тот, кто пересчитал место вручную.
 *
 * Чего здесь нет: ни одного обращения к диску, базе и docker. Всё, что ниже, —
 * чистые функции и данные, и тесты на них такие же (tests/competitions-rules).
 */
import { tr } from './i18n.js'
import { slugOk } from './publish.js'

/* --------------------------------------------------------- соревнование */

/**
 * Черновик · идёт · завершено.
 *
 * Три состояния, а не флаг «опубликовано»: черновик не имеет адреса у
 * участника вовсе, у идущего работает приём посылок, а у завершённого
 * лидерборд превращается в итоговый и больше не меняется. Переход
 * `draft → live` закрыт, пока сэмпл-тетрадь не прошла весь путь до числа:
 * соревнование, задача которого не решается даже автором, открывать нечего.
 */
export type CompetitionState = 'draft' | 'live' | 'finished'

/** Куда смотрит метрика: MAPE вниз, ROC AUC вверх. */
export type MetricDirection = 'lower' | 'higher'

/** Когда открывается приватный лидерборд: сам после дедлайна или рукой на разборе. */
export type PrivateRelease = 'auto' | 'manual'

/**
 * Что идёт в зачёт.
 *
 * `chosen` — выбор участника (и молчание считается выбором «лучшая по
 * публичной»), `bestPublic` — лучшая по публичной части, `last` — последняя.
 * Выбор между «верю лидерборду» и «верю своей валидации» — половина урока,
 * поэтому по умолчанию выбирает участник.
 */
export type ScoringRule = 'chosen' | 'bestPublic' | 'last'

/** Метрика преподавателя: имя в шапке колонки, направление и сам код `score`. */
export interface CompetitionMetric {
  /** Короткое имя — подставляется в «ИТОГОВЫЙ {metric}». */
  name: string
  direction: MetricDirection
  /** Python: `def score(solution, submission) -> float`. Участнику не уезжает. */
  code: string
}

/** Пределы одного прогона и дневная норма человека. */
export interface CompetitionLimits {
  /** Общий срок посылки. Вышел — контейнер убит, без уговоров. */
  wallSeconds: number
  memoryMb: number
  cpus: number
  /** Посылок в день на участника; 0 — без предела. */
  perDay: number
}

export interface Competition {
  id: string
  /** Имя в адресе: `/k/<slug>`. */
  slug: string
  title: string
  /** Одна строка — в списке у участника. */
  blurb: string
  /** Markdown: задача, данные, что сдавать. */
  description: string
  state: CompetitionState
  metric: CompetitionMetric
  /** Доля строк, которую считают сразу, в процентах. */
  publicPercent: number
  /**
   * Зерно деления строк.
   *
   * Записано в строке соревнования, а не берётся из времени: деление обязано
   * воспроизводиться через месяц на другой машине — иначе пересчёт после
   * правки метрики поменяет не только числа, но и то, какие строки были
   * публичными, и весь прошлый лидерборд станет несравним с новым.
   */
  splitSeed: string
  limits: CompetitionLimits
  /** Имя образа: то же окружение, что у ядра в занятии. */
  environment: string
  startsAt: number | null
  deadlineAt: number | null
  privateRelease: PrivateRelease
  scoring: ScoringRule
  /** Когда приватный лидерборд открыли (сам или рукой); null — ещё закрыт. */
  privateOpenedAt: number | null
  /** Посылка сэмпл-тетради: она же строка «бейзлайн» в лидерборде. */
  baselineSubmissionId: string | null
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

/**
 * Соревнование глазами участника.
 *
 * Код метрики и зерно деления сюда не попадают, и это не вкусовщина: по зерну
 * и доле восстанавливается, какие именно строки публичные, а зная это, ответ
 * можно подогнать под скрытую часть, не решая задачу.
 */
export type CompetitionPublic = Omit<Competition, 'metric' | 'splitSeed' | 'createdBy'> & {
  metric: Omit<CompetitionMetric, 'code'>
}

export function publicCompetition(c: Competition): CompetitionPublic {
  const { metric, splitSeed: _seed, createdBy: _by, ...rest } = c
  return { ...rest, metric: { name: metric.name, direction: metric.direction } }
}

/* ------------------------------------------------------------------ файлы */

/**
 * Открытые файлы участник скачивает и видит в контейнере как `data/`; скрытые
 * не покидают DATA_DIR соревнования и попадают только в контейнер метрики.
 */
export type FileVisibility = 'open' | 'hidden'

export interface CompetitionFile {
  competitionId: string
  name: string
  bytes: number
  /** Строк в таблице — показывается рядом с именем; null для не-CSV. */
  rows: number | null
  visibility: FileVisibility
  uploadedAt: number
}

/* --------------------------------------------------------------- участник */

/**
 * Участник соревнований — сущность УРОВНЯ ИНСТАНСА, а не комнаты.
 *
 * Личность студента в занятии живёт в localStorage и привязана к session_id:
 * зашёл с телефона — другой человек. Для соревнования это негодно, потому что
 * посылки и место обязаны возвращаться с другого устройства и через неделю.
 * Отсюда «ключ входа» — ровно та же механика, что у личных ссылок
 * преподавателей (`staff.link_key`), и с той же ценой: кто знает ключ, тот и
 * участник. Преподаватель может выдать новый; старый тут же перестаёт
 * действовать.
 */
export interface Entrant {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  /** Ключ отозвали (выдали новый) — строка живёт, посылки остаются. */
  disabled: boolean
}

/**
 * КЛЮЧА ЗДЕСЬ НЕТ, и это не забывчивость.
 *
 * `Entrant` уезжает в браузер — своему хозяину в `/api/k/me`, преподавателю
 * списком участников, всем подряд строкой лидерборда. Пока ключ лежал полем
 * этой записи, один недосмотренный `res.json({ entrants })` раздавал классу
 * входы друг к другу, а заметить это можно было только чтением ответа.
 * Секрет возвращают ровно две двери сервера — выдача и `entrantKeyOf`, — и обе
 * названы так, что их видно (server/src/competitions/key.ts · store.ts).
 */
export interface MintedEntrant {
  entrant: Entrant
  /** `K7Q-M2X-9FD`. Показывается хозяину и больше нигде. */
  key: string
}

/**
 * Печенье участника — своё, отдельно от преподавательского.
 *
 * Разными печеньями, а не одной ролью в одной подписи: преподаватель, вошедший
 * на `/k` посмотреть глазами студента, обязан остаться преподавателем в
 * соседней вкладке с панелью, а участник — не получить ничего от того, что у
 * него в браузере когда-то лежал `colloq_staff`.
 */
export const ENTRANT_COOKIE = 'colloq_k'

/** Куда ведёт «Ссылка для входа»: страница меняет ключ на печенье. */
export const ENTRANT_SIGN_IN_PATH = '/k/t/'

/**
 * Почему дверь `/api/k` отказала — словом, на которое ветвится экран.
 *
 * `error` читает человек, это — читает код: поле ключа после `key_disabled`
 * предлагает спросить новый, после `key_unknown` — проверить буквы; зона
 * загрузки после `quota` гаснет до завтра, а после `in_flight` — до конца
 * идущего прогона. По тексту отказа различить это нельзя, а различать надо.
 */
export type CompetitionRefusal =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  /** Имя занято тёзкой в этом соревновании. */
  | 'name_taken'
  | 'key_unknown'
  | 'key_disabled'
  /** Соревнование ещё черновик или не наступило его начало. */
  | 'not_open'
  /** Дедлайн прошёл или преподаватель завершил досрочно. */
  | 'closed'
  | 'not_joined'
  /** Прошлая посылка ещё в полёте: по одной за раз. */
  | 'in_flight'
  | 'quota'
  | 'too_often'
  | 'too_big'

export interface CompetitionErrorBody {
  error: string
  reason: CompetitionRefusal
}

/**
 * Идёт ли приём посылок прямо сейчас.
 *
 * Три «нет» вместо одного `boolean`: до открытия человеку говорят «ещё не
 * открыто», после дедлайна — «приём закрыт», и это разные экраны. Черновик
 * сюда не доходит вовсе — его на `/k` нет.
 */
export function submissionsOpen(
  c: Pick<Competition, 'state' | 'startsAt' | 'deadlineAt'>,
  now: number,
): 'open' | 'not_open' | 'closed' {
  if (c.state === 'draft') return 'not_open'
  if (c.state === 'finished') return 'closed'
  if (c.startsAt !== null && now < c.startsAt) return 'not_open'
  if (c.deadlineAt !== null && now > c.deadlineAt) return 'closed'
  return 'open'
}

/**
 * Имя, приведённое к виду, в котором сравнивают ТЁЗОК.
 *
 * «Тёзки в лидерборде недопустимы» — правило про глаз, а не про байты: две
 * строки «Анна Ким» и «анна  ким» человек читает как одно имя и спорит о том,
 * чьё место выше. Поэтому регистр и лишние пробелы не считаются, а `ё`
 * складывается с `е`: «Артём» и «Артем» в одной таблице — ровно та путаница,
 * ради которой правило и заведено.
 *
 * Разбор тут же и ограничение длины — нет: уникальность проверяет база по
 * этому ключу, а длину режет `LIMITS.entrantName` на входе.
 */
export function entrantNameKey(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
}

/**
 * Алфавит ключа: без `O`, `0`, `I`, `1` и `L`.
 *
 * Ключ диктуют вслух и переписывают с экрана телефона на ноутбук. Пара
 * «ноль — О» стоит одного обращения к преподавателю за новым ключом, и
 * дешевле её просто не выпускать.
 */
export const ENTRANT_KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const ENTRANT_KEY_GROUPS = 3
export const ENTRANT_KEY_GROUP_SIZE = 3

/**
 * Привести ключ к каноническому виду или отказать.
 *
 * Человек вставляет его с пробелами, в нижнем регистре и без дефисов — всё это
 * тот же ключ. А вот буква не из алфавита — не описка, а другой ключ, и
 * угадывать за человека здесь нельзя.
 */
export function normalizeEntrantKey(raw: string): string | null {
  const flat = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  const size = ENTRANT_KEY_GROUPS * ENTRANT_KEY_GROUP_SIZE
  if (flat.length !== size) return null
  for (const ch of flat) if (!ENTRANT_KEY_ALPHABET.includes(ch)) return null
  const groups: string[] = []
  for (let i = 0; i < size; i += ENTRANT_KEY_GROUP_SIZE) {
    groups.push(flat.slice(i, i + ENTRANT_KEY_GROUP_SIZE))
  }
  return groups.join('-')
}

export function entrantKeyOk(value: string): boolean {
  return normalizeEntrantKey(value) === value
}

/* --------------------------------------------------------------- посылка */

/**
 * Исход посылки — ровно те восемь, что нарисованы в макете, и один девятый.
 *
 * Девятый — `cancelled`: кнопка «Отменить» есть у идущей и у стоящей в
 * очереди посылки, а плашки для снятой в макете нет. Состояние всё равно
 * обязано существовать, иначе снятая посылка вечно висела бы «В ОЧЕРЕДИ».
 *
 * `rejected` («ОТВЕТ НЕ ПРИНЯТ») покрывает не только `ParticipantVisibleError`
 * метрики, но и «тетрадь дошла до конца, а `submission.csv` не написала» и
 * «написала, но его не прочесть». Слово участнику одно и то же, различается
 * причина, и она лежит в `participantError`: дробить плашки по техническому
 * поводу значит отвечать человеку словарём прогонщика.
 */
export type SubmissionState =
  | 'queued'
  | 'running'
  | 'scored'
  | 'notebookFailed'
  | 'rejected'
  | 'timedOut'
  | 'outOfMemory'
  | 'metricFailed'
  | 'cancelled'

export const SUBMISSION_STATES: readonly SubmissionState[] = [
  'queued',
  'running',
  'scored',
  'notebookFailed',
  'rejected',
  'timedOut',
  'outOfMemory',
  'metricFailed',
  'cancelled',
]

/** Этапы прогона, в порядке полосы под идущей посылкой (P2). */
export type SubmissionStage = 'accepted' | 'queue' | 'notebook' | 'check' | 'score'

export const SUBMISSION_STAGES: readonly SubmissionStage[] = [
  'accepted',
  'queue',
  'notebook',
  'check',
  'score',
]

/** Пройден · идёт сейчас · ещё не наступил. */
export type StagePosition = 'done' | 'current' | 'ahead'

export interface Submission {
  id: string
  competitionId: string
  entrantId: string
  /** Номер по порядку В ПРЕДЕЛАХ соревнования: «#12» в списке участника. */
  number: number
  fileName: string
  bytes: number
  acceptedAt: number
  state: SubmissionState
  /** Докуда дошла: этап, на котором посылка стоит или остановилась. */
  stage: SubmissionStage
  publicScore: number | null
  /** Участнику не уезжает до открытия приватного лидерборда. */
  privateScore: number | null
  /** Сколько шла, в миллисекундах; null — ещё идёт или не начиналась. */
  durationMs: number | null
  /** На какой ячейке кончилась и сколько их было. */
  cellsDone: number
  cellsTotal: number
  /** Что показать участнику: текст ParticipantVisibleError или объяснение отказа. */
  participantError: string | null
  /** Трейс и всё остальное — только преподавателю. */
  teacherError: string | null
  /** Выбрана автором в зачёт. */
  chosen: boolean
}

/**
 * Посылка глазами её автора.
 *
 * Два поля не уезжают. `teacherError` — трейс, и он не участнику: «ошибка в
 * вашем коде, не у участника» (A3) читает тот, кто писал метрику. А
 * `privateScore` считается с первой же посылки и лежит в той же строке, что и
 * публичный, — и если отдать его до открытия приватного лидерборда, весь
 * смысл деления теста исчезает: под скрытую часть можно подогнаться, обновляя
 * страницу.
 *
 * Функцией, а не выборкой в SQL: то же правило применяется к посылке, которую
 * вернула отправка, к списку «Мои посылки» и к одной строке после пересчёта —
 * три места, из которых забыть можно любое.
 */
export type EntrantSubmission = Omit<Submission, 'teacherError' | 'privateScore'> & {
  privateScore: number | null
}

export function entrantSubmission(s: Submission, privateOpen: boolean): EntrantSubmission {
  const { teacherError: _trace, ...rest } = s
  return { ...rest, privateScore: privateOpen ? s.privateScore : null }
}

/**
 * Почему присланный файл — не тетрадь.
 *
 * Разбирается ЗДЕСЬ, до очереди, и не ради вкуса: тетрадь читает `nbformat` в
 * одноразовом контейнере, и битый JSON там становится «упала тетрадь» — то
 * есть приговором коду, которого человек не писал, да ещё и потраченной
 * посылкой из пяти дневных. Проверка дешёвая и отвечает словами про файл.
 *
 * Строгости ровно столько, сколько переживёт настоящая тетрадь из чужого
 * Jupyter: объект, массив `cells`, у каждой ячейки свой `cell_type`. Версию
 * `nbformat` не проверяем — её чинит сам `nbformat.read`.
 */
export function whyNotebookRefused(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return tr('competitions.refusal.notJson')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return tr('competitions.refusal.notNotebook')
  }
  const cells = (parsed as { cells?: unknown }).cells
  if (!Array.isArray(cells)) return tr('competitions.refusal.notNotebook')
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object' || typeof (cell as { cell_type?: unknown }).cell_type !== 'string') {
      return tr('competitions.refusal.brokenCell')
    }
  }
  return null
}

/**
 * Прогон — ОДИН заход в контейнер, и их у посылки несколько.
 *
 * Строкой на этап, а не на посылку, ради единственной вещи, которую обещает
 * макет: «после правки метрики всё пересчитывается без повторного исполнения
 * тетрадей». Пересчёт заводит новый прогон вида `metric` рядом с прежним
 * `notebook`, и тетрадь второй раз не запускается. Заодно сюда же ложится
 * «исполнить заново» из меню строки.
 */
export type RunKind = 'notebook' | 'metric'

/**
 * Слова прогонщика — ровно те, что пишет обвязка в `run.json` и `score.json`
 * (см. прототип: harness/run_notebook.py, harness/score_metric.py). Здесь они
 * не переводятся и не приукрашиваются: разбирать их в состояние — дело одной
 * функции ниже, а всё остальное смотрит на состояние.
 */
export type RunVerdict =
  | 'ok'
  | 'cell_error'
  | 'cell_timeout'
  | 'kernel_died'
  | 'exit'
  | 'target_too_large'
  | 'target_unreadable'
  | 'harness_error'
  | 'no-submission'
  | 'out-of-memory'
  | 'timeout'
  | 'participant_error'
  | 'metric_error'
  | 'unknown'

export interface SubmissionRun {
  id: string
  submissionId: string
  /** Номер прогона по порядку внутри посылки. */
  seq: number
  kind: RunKind
  startedAt: number
  finishedAt: number | null
  verdict: RunVerdict | null
  /** Имя контейнера — по нему его убивают и по нему же ищут в журнале docker. */
  container: string | null
  exitCode: number | null
  oom: boolean
  cellsDone: number
  cellsTotal: number
  publicScore: number | null
  privateScore: number | null
  participantError: string | null
  teacherError: string | null
}

/**
 * Во что превращается слово прогонщика.
 *
 * Порядок разбора — тот же, что у прототипа (`drive.py` · verdict_of), и он
 * же единственная копия правила: убийство по памяти и по сроку старше всего,
 * что успела записать обвязка, а «нет файла» идёт раньше её `status`, иначе
 * посылка с пустыми руками считалась бы удавшейся.
 */
export function stateOfVerdict(kind: RunKind, verdict: RunVerdict): SubmissionState {
  if (verdict === 'out-of-memory') return 'outOfMemory'
  if (verdict === 'timeout' || verdict === 'cell_timeout') return 'timedOut'
  if (kind === 'metric') {
    if (verdict === 'ok') return 'scored'
    // ParticipantVisibleError — единственная ошибка метрики, которую участник
    // читает дословно; любая другая означает, что упал код преподавателя.
    return verdict === 'participant_error' ? 'rejected' : 'metricFailed'
  }
  switch (verdict) {
    case 'ok':
      return 'running'
    case 'no-submission':
    case 'target_too_large':
    case 'target_unreadable':
      // Тетрадь отработала, а ответа нет или он нечитаем — это отказ участнику,
      // а не падение тетради: ячейка с ошибкой тут ни при чём.
      return 'rejected'
    case 'cell_error':
    case 'kernel_died':
    case 'exit':
      return 'notebookFailed'
    default:
      // harness_error и unknown: виновата обвязка, а не участник, и разбирать
      // это преподавателю. Показывать человеку «ошибка в тетради» нельзя.
      return 'metricFailed'
  }
}

/** Дошла ли посылка до конца пути — в любом смысле, включая плохой. */
export function isTerminal(state: SubmissionState): boolean {
  return state !== 'queued' && state !== 'running'
}

/* ------------------------------------------------- слова про состояние */

/** Тон плашки — по таблице макета «Плашки статусов». */
export type BadgeTone = 'accent' | 'positive' | 'danger' | 'warning' | 'neutral'

/**
 * Форма: залитая бледным фоном, залитая насыщенным цветом или контурная.
 * «УПАЛА МЕТРИКА» и «ВЫПОЛНЯЕТСЯ» — единственные насыщенные.
 */
export type BadgeForm = 'filled' | 'strong' | 'outline'

export interface SubmissionBadge {
  word: string
  tone: BadgeTone
  form: BadgeForm
}

/**
 * Плашка посылки ГЛАЗАМИ УЧАСТНИКА.
 *
 * `null` — плашки нет вовсе, и это не пропуск: упавший код метрики виноват
 * перед участником, а не наоборот, и на его строке стоит фраза
 * (`METRIC_FAILED_NOTE`), а не ярлык.
 */
export function entrantBadge(state: SubmissionState): SubmissionBadge | null {
  switch (state) {
    case 'running':
      return { word: tr('competitions.entrant.running'), tone: 'accent', form: 'strong' }
    case 'queued':
      return { word: tr('competitions.entrant.queued'), tone: 'accent', form: 'outline' }
    case 'scored':
      return { word: tr('competitions.entrant.scored'), tone: 'positive', form: 'filled' }
    case 'notebookFailed':
      return { word: tr('competitions.entrant.notebookFailed'), tone: 'danger', form: 'filled' }
    case 'rejected':
      return { word: tr('competitions.entrant.rejected'), tone: 'warning', form: 'filled' }
    case 'timedOut':
      return { word: tr('competitions.entrant.timedOut'), tone: 'danger', form: 'filled' }
    case 'outOfMemory':
      // В макете участника этой плашки нет — нарисован только преподавательский
      // случай. Молчать нельзя: посылка, убитая по памяти, обязана назваться,
      // иначе она выглядит пропавшей. Слово взято у преподавателя.
      return { word: tr('competitions.entrant.outOfMemory'), tone: 'danger', form: 'filled' }
    case 'cancelled':
      return { word: tr('competitions.entrant.cancelled'), tone: 'neutral', form: 'filled' }
    case 'metricFailed':
      return null
  }
}

/**
 * Плашка посылки ГЛАЗАМИ ПРЕПОДАВАТЕЛЯ.
 *
 * `null` у идущей и стоящей в очереди: в таблице A3 их нет, они живут в блоке
 * очереди сверху («ИСПОЛНЯЕТСЯ СЕЙЧАС» и «ЖДУТ · N»), и второй раз называть
 * их плашкой значит показать одно и то же дважды разными словами.
 */
export function teacherBadge(state: SubmissionState): SubmissionBadge | null {
  switch (state) {
    case 'scored':
      return { word: tr('competitions.teacher.scored'), tone: 'positive', form: 'filled' }
    case 'notebookFailed':
      return { word: tr('competitions.teacher.notebookFailed'), tone: 'danger', form: 'filled' }
    case 'rejected':
      return { word: tr('competitions.teacher.rejected'), tone: 'warning', form: 'filled' }
    case 'timedOut':
      return { word: tr('competitions.teacher.timedOut'), tone: 'danger', form: 'filled' }
    case 'outOfMemory':
      return { word: tr('competitions.teacher.outOfMemory'), tone: 'danger', form: 'filled' }
    case 'metricFailed':
      // Единственная насыщенно-красная плашка продукта: её видит только тот,
      // кто может это починить.
      return { word: tr('competitions.teacher.metricFailed'), tone: 'danger', form: 'strong' }
    case 'cancelled':
      return { word: tr('competitions.teacher.cancelled'), tone: 'neutral', form: 'filled' }
    case 'queued':
    case 'running':
      return null
  }
}

/** Фраза вместо плашки — то, что читает участник у посылки с упавшей метрикой. */
export function metricFailedNote(): string {
  return tr('competitions.metricFailedNote')
}

/** Состояние соревнования словом: «ЧЕРНОВИК», «ИДЁТ», «ЗАВЕРШЕНО». */
export function competitionWord(state: CompetitionState): string {
  return tr(`competitions.state.${state}`)
}

/** Подпись этапа прогона. */
export function stageWord(stage: SubmissionStage): string {
  return tr(`competitions.stage.${stage}`)
}

/** Направление метрики словами (A1, A2, P2, P3). */
export function directionWord(direction: MetricDirection): string {
  return tr(`competitions.direction.${direction}`)
}

/** Направление метрики знаком: `MAPE ↓`, `ROC AUC ↑` (P1, P4). Не перевод, а стрелка. */
export const DIRECTION_ARROW: Record<MetricDirection, string> = { lower: '↓', higher: '↑' }

/**
 * Где посылка стоит на полосе этапов.
 *
 * Дошедшая до конца — вся зелёная: «ОЦЕНКА» у готовой посылки пройдена, а не
 * идёт. Упавшая красит пройденным всё до этапа, на котором умерла, и сам этот
 * этап оставляет текущим — там и надо искать причину.
 */
export function stagePosition(
  state: SubmissionState,
  at: SubmissionStage,
  stage: SubmissionStage,
): StagePosition {
  const here = SUBMISSION_STAGES.indexOf(at)
  const asked = SUBMISSION_STAGES.indexOf(stage)
  if (asked < here) return 'done'
  if (asked > here) return 'ahead'
  return state === 'scored' ? 'done' : 'current'
}

/* ------------------------------------------------------------------ адрес */

/**
 * Почему это имя не годится в адрес — словом, а не «false».
 *
 * Отказ «адрес не подходит» отправляет преподавателя перебирать буквы; отказ
 * `reserved` он читает один раз и больше сюда не приходит.
 */
export type SlugRefusal = 'empty' | 'chars' | 'reserved'

/**
 * Имена, занятые не соревнованиями.
 *
 * `t` — вход по ключу (`/k/t/<key>`), и соревнование с таким адресом отняло бы
 * у всех участников способ вернуться. Проверка здесь, а не в маршрутизаторе:
 * к моменту, когда до маршрута дойдёт дело, адрес уже роздан классу.
 */
export const RESERVED_SLUGS: readonly string[] = ['t', 'new']

/**
 * Привести имя к адресу или отказать.
 *
 * Правило букв — одно на весь продукт (`shared/publish.ts` · slugOk): только
 * строчные, цифры и дефис, потому что адрес диктуют вслух и пишут на доске.
 * Своей копии регулярки здесь нет намеренно — разойдясь, они дали бы курс и
 * соревнование с разными представлениями о том, что такое адрес.
 */
export function parseSlug(raw: string): string | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!slugOk(value) || RESERVED_SLUGS.includes(value)) return null
  return value
}

export function slugRefusal(raw: string): SlugRefusal | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return 'empty'
  if (RESERVED_SLUGS.includes(value)) return 'reserved'
  return slugOk(value) ? null : 'chars'
}

/** Адрес страницы соревнования у участника. */
export function competitionPath(slug: string): string {
  return `/k/${slug}`
}

/* --------------------------------------------------- дневная норма посылок */

/** Всё, что нужно, чтобы решить, идёт ли посылка в счёт дня. */
export interface QuotaEntry {
  acceptedAt: number
  state: SubmissionState
  cellsDone: number
}

/**
 * Идёт ли посылка в дневную норму.
 *
 * Два исключения, и оба названы макетом. Снятая участником не идёт: он её
 * отменил, а не потратил. И «посылки с ошибкой в счёт дня не идут, если упали
 * до первой ячейки» — то есть тетрадь, которая не запустилась вовсе (битый
 * JSON, мёртвое ядро на старте), норму не тратит: человек не получил ни одной
 * попытки решить задачу.
 *
 * Стоящая в очереди и идущая — идут. Иначе один человек поставил бы в очередь
 * сто тетрадей, и норма дня начала бы действовать задним числом.
 */
export function countsTowardDailyQuota(entry: QuotaEntry): boolean {
  if (entry.state === 'cancelled') return false
  if (!isTerminal(entry.state) || entry.state === 'scored') return true
  return entry.cellsDone > 0
}

/**
 * Начало суток для момента `at` в поясе, сдвинутом на `offsetMinutes` от UTC.
 *
 * Пояс приходит числом, а не именем зоны: сутки соревнования — это сутки той
 * аудитории, где его ведут (макет пишет «23:59 МСК»), и одно число здесь честнее
 * доверия к часам браузера, которые у половины класса стоят как попало.
 */
export function dayStart(at: number, offsetMinutes: number): number {
  const DAY = 24 * 60 * 60 * 1000
  const shift = offsetMinutes * 60 * 1000
  return Math.floor((at + shift) / DAY) * DAY - shift
}

/**
 * Сколько посылок человеку осталось сегодня; `null` — предела нет.
 *
 * Отрицательным не бывает: преподаватель может опустить норму в середине дня,
 * и «осталось −2» на экране участника — не число, а обвинение.
 */
export function submissionsLeftToday(
  perDay: number,
  entries: readonly QuotaEntry[],
  now: number,
  offsetMinutes: number,
): number | null {
  if (!Number.isFinite(perDay) || perDay <= 0) return null
  const since = dayStart(now, offsetMinutes)
  let used = 0
  for (const entry of entries) {
    if (entry.acceptedAt < since || entry.acceptedAt > now) continue
    if (countsTowardDailyQuota(entry)) used += 1
  }
  return Math.max(0, Math.floor(perDay) - used)
}

/* --------------------------------------------------------- зачёт и места */

/** Посылка глазами правил зачёта и лидерборда. */
export interface BoardEntry {
  id: string
  number: number
  acceptedAt: number
  state: SubmissionState
  publicScore: number | null
  privateScore: number | null
  chosen: boolean
}

/** Годится ли посылка в лидерборд: дошла до числа, и число это настоящее. */
export function hasScore(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Что лучше: `-1`, если `a` выше `b`.
 *
 * Ничья решается временем — «при одинаковом результате выше посылка,
 * отправленная раньше» (сноска P3). Правило не косметическое: без него порядок
 * зависел бы от того, в каком виде база вернула строки, и место участника
 * менялось бы между двумя обновлениями страницы.
 */
export function compareScores(
  a: { score: number; at: number },
  b: { score: number; at: number },
  direction: MetricDirection,
): number {
  if (a.score !== b.score) {
    return direction === 'lower' ? a.score - b.score : b.score - a.score
  }
  return a.at - b.at
}

/**
 * Какая посылка участника идёт в зачёт.
 *
 * `chosen` с оговоркой из макета: «Не выбрал — берётся лучшая по публичной
 * части». Оговорка лежит здесь, а не в вёрстке, потому что по этой же функции
 * сервер собирает итоговый лидерборд.
 *
 * `last` — последняя ДОШЕДШАЯ ДО ЧИСЛА, а не последняя присланная: упавшую
 * тетрадь в лидерборд поставить нечем, и «последняя» в этом случае означала бы
 * вылет участника из таблицы за одну неудачную посылку перед сном.
 */
export function countedSubmission(
  rule: ScoringRule,
  entries: readonly BoardEntry[],
  direction: MetricDirection,
): BoardEntry | null {
  const scored = entries.filter((e) => e.state === 'scored' && hasScore(e.publicScore))
  if (scored.length === 0) return null
  if (rule === 'chosen') {
    const picked = scored.find((e) => e.chosen)
    if (picked) return picked
  }
  if (rule === 'last') {
    return scored.reduce((best, e) =>
      e.acceptedAt > best.acceptedAt || (e.acceptedAt === best.acceptedAt && e.number > best.number)
        ? e
        : best,
    )
  }
  return scored.reduce((best, e) =>
    compareScores(
      { score: e.publicScore as number, at: e.acceptedAt },
      { score: best.publicScore as number, at: best.acceptedAt },
      direction,
    ) < 0
      ? e
      : best,
  )
}

/** Строка лидерборда до расстановки мест. */
export interface BoardRow {
  entrantId: string
  submissionId: string
  score: number
  at: number
}

export type RankedRow = BoardRow & { place: number }

/**
 * Расставить места.
 *
 * Мест, разделённых на двоих, здесь нет: ничья уже решена временем, поэтому
 * место — просто порядковый номер. Иначе «ВАШЕ МЕСТО 7 из 28» перестало бы
 * сходиться с длиной таблицы.
 */
export function rankBoard(rows: readonly BoardRow[], direction: MetricDirection): RankedRow[] {
  return [...rows]
    .sort((a, b) => compareScores(a, b, direction))
    .map((row, index) => ({ ...row, place: index + 1 }))
}

/**
 * Лидерборд одной части теста: по одной, зачётной, посылке на человека.
 *
 * Считается из ПУБЛИЧНЫХ чисел даже для итоговой таблицы, и это не описка:
 * правило зачёта выбирает посылку по тому, что участник видел, а приватное
 * число лишь подставляется в выбранную. Иначе итог считался бы по посылке,
 * которую человек не выбирал и увидеть не мог.
 */
export function boardOf(
  people: readonly { entrantId: string; entries: readonly BoardEntry[] }[],
  rule: ScoringRule,
  direction: MetricDirection,
  part: 'public' | 'private',
): RankedRow[] {
  const rows: BoardRow[] = []
  for (const person of people) {
    const counted = countedSubmission(rule, person.entries, direction)
    if (!counted) continue
    const score = part === 'public' ? counted.publicScore : counted.privateScore
    if (!hasScore(score)) continue
    rows.push({
      entrantId: person.entrantId,
      submissionId: counted.id,
      score,
      at: counted.acceptedAt,
    })
  }
  return rankBoard(rows, direction)
}

/** Место человека в готовой таблице, или null — его там нет. */
export function placeOf(rows: readonly RankedRow[], entrantId: string): number | null {
  return rows.find((row) => row.entrantId === entrantId)?.place ?? null
}

/**
 * Насколько человек переехал между публичным и итоговым лидербордом.
 *
 * Положительное — поднялся (`▲`), отрицательное — опустился (`▼`), ноль —
 * остался (`—`). `null`, если в одной из таблиц его нет: «поднялся на 7 мест»
 * из ниоткуда — не факт, а выдумка.
 */
export function placeShift(publicPlace: number | null, privatePlace: number | null): number | null {
  if (publicPlace === null || privatePlace === null) return null
  return publicPlace - privatePlace
}

/**
 * Открыт ли приватный лидерборд.
 *
 * `auto` открывает его дедлайн, `manual` — только рука преподавателя, и никакой
 * срок за него этого не сделает: вся ценность разбора в том, что места
 * называет он сам.
 */
export function privateBoardOpen(
  c: Pick<Competition, 'privateRelease' | 'deadlineAt' | 'privateOpenedAt'>,
  now: number,
): boolean {
  if (c.privateOpenedAt !== null) return true
  if (c.privateRelease !== 'auto') return false
  return c.deadlineAt !== null && now >= c.deadlineAt
}

/* ------------------------------------------------- деление строк ответов */

export type RowPart = 'public' | 'private'

/**
 * Сколько строк считать сразу.
 *
 * Обе части обязаны быть непусты: метрика на нуле строк либо падает, либо
 * возвращает NaN, и соревнование с пустой приватной частью — это соревнование
 * без итога. Отсюда зажим, а не голое округление.
 */
export function publicRowCount(total: number, publicPercent: number): number {
  if (total <= 0) return 0
  if (total === 1) return 1
  const wanted = Math.round((total * publicPercent) / 100)
  return Math.min(total - 1, Math.max(1, wanted))
}

/**
 * FNV-1a, 32 бита.
 *
 * Хэш здесь не про стойкость, а про повторяемость: одно и то же зерно и один и
 * тот же ключ строки обязаны дать одно и то же число сегодня, через месяц и на
 * другой машине. `Math.random` и порядок строк в файле для этого негодны — при
 * пересчёте после правки метрики публичной стала бы другая половина теста.
 */
function hash32(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Разделить строки ответов на публичную и приватную часть.
 *
 * Не «каждая строка с вероятностью p», а РАНГ по хэшу: доля должна давать ровно
 * то число строк, которое написано в макете («119 строк считаются сразу, 278 —
 * после дедлайна»), а жребий по каждой строке отдельно даёт 119 ± десяток и
 * разное число при каждом новом наборе.
 *
 * Ответ выровнен по входу: `parts[i]` — про `ids[i]`. Перестановка строк в
 * файле ответов ничего не меняет — строка помнит свою часть по ключу, а не по
 * месту.
 */
export function splitRows(
  ids: readonly string[],
  publicPercent: number,
  seed: string,
): RowPart[] {
  const take = publicRowCount(ids.length, publicPercent)
  const order = ids.map((id, index) => ({ index, id, hash: hash32(`${seed}\u0000${id}`) }))
  // Второй ключ — сам идентификатор: одинаковые хэши у разных строк случаются,
  // и без него порядок зависел бы от того, как Array.sort повёл себя с ничьёй.
  order.sort((a, b) => (a.hash !== b.hash ? a.hash - b.hash : a.id < b.id ? -1 : 1))
  const parts: RowPart[] = new Array(ids.length).fill('private')
  for (let i = 0; i < take; i++) parts[order[i].index] = 'public'
  return parts
}

/**
 * Деление, записанное преподавателем в колонке `Usage` файла ответов.
 *
 * Оно старше зерна: разметив строки руками, преподаватель обычно делит их не
 * случайно, а по смыслу — по времени, по складу, по пациенту, — и подменять
 * такое деление жребием значит испортить задачу. `null` — колонка не годится
 * (чужие слова или одна часть пуста), и тогда делит зерно.
 */
export function splitByUsage(usage: readonly string[]): RowPart[] | null {
  const parts: RowPart[] = []
  let publicRows = 0
  for (const raw of usage) {
    const value = String(raw ?? '').trim().toLowerCase()
    if (value === 'public') {
      parts.push('public')
      publicRows += 1
      continue
    }
    if (value === 'private') {
      parts.push('private')
      continue
    }
    return null
  }
  if (publicRows === 0 || publicRows === parts.length) return null
  return parts
}

/**
 * Как разделить строки на самом деле: колонкой, если она есть и годна, иначе
 * зерном. Одна дверь на оба пути — чтобы «а откуда у этого соревнования такое
 * деление» имело один ответ.
 */
export function planSplit(
  rows: { ids: readonly string[]; usage?: readonly string[] | null },
  publicPercent: number,
  seed: string,
): { parts: RowPart[]; by: 'usage' | 'seed' } {
  if (rows.usage && rows.usage.length === rows.ids.length) {
    const byUsage = splitByUsage(rows.usage)
    if (byUsage) return { parts: byUsage, by: 'usage' }
  }
  return { parts: splitRows(rows.ids, publicPercent, seed), by: 'seed' }
}

/* ----------------------------------------------------------------- пределы */

/**
 * Длины и границы — одним местом, как в `shared/admin.ts`.
 *
 * Числа сторожат и форму в панели, и сервер: поле, отказавшее только на
 * клиенте, — это поле без ограничения.
 */
export const LIMITS = {
  title: 120,
  slug: 64,
  blurb: 240,
  /** Markdown задачи. Двадцать килобайт — это десяток экранов текста. */
  description: 20_000,
  metricName: 24,
  metricCode: 40_000,
  entrantName: 60,
  fileName: 120,
  /** Текст, который читает участник. Длиннее — это уже трейс, а он не ему. */
  participantError: 2_000,
  teacherError: 20_000,
  publicPercent: { min: 1, max: 99, default: 30 },
  wallSeconds: { min: 30, max: 4 * 60 * 60, default: 600 },
  memoryMb: { min: 512, max: 64 * 1024, default: 4096 },
  cpus: { min: 1, max: 32, default: 2 },
  /** Посылок в день на участника; 0 — без предела. */
  perDay: { min: 0, max: 100, default: 5 },
  /** «до 200 МБ на соревнование» — подпись под списком открытых файлов (A2). */
  dataBytes: 200 * 1024 * 1024,
  files: 40,
  /**
   * Потолок ПРИСЛАННОЙ тетради.
   *
   * Свой, а не `config.maxUploadBytes`: `nbformat.read` разбирает файл в памяти
   * контейнера целиком, и тетрадь на полсотни мегабайт base64-картинок убивает
   * посылку по памяти ещё до первой ячейки — с причиной «не хватило памяти»,
   * которую участник прочтёт как приговор своему коду.
   */
  notebookBytes: 20 * 1024 * 1024,
  /** Потолок ответа, который обвязка забирает из контейнера (прототип: max_target). */
  submissionBytes: 64 * 1024 * 1024,
} as const
