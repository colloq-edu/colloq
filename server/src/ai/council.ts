import { tr } from '@shared/i18n'
/**
 * Оракул о решениях: один взгляд сверху на пятьсот попыток.
 *
 * Преподаватель на консилиуме не читает пятьсот листов — он читает шесть
 * групп одинаковых решений, и просит модель сказать про них три вещи: что в
 * них верно, где типичная ошибка и что показать классу. Тем же ответом модель
 * даёт группам имена одной строкой и черновики ответов группам с ошибкой.
 *
 * Три вещи, которые здесь держатся нарочно.
 *
 * Модель не видит имён. Ей едут тексты по группам с числами, задание и эталон,
 * если он есть; группы названы G1…GN, и к людям их привязывает пульт — по ключу
 * группы. Иначе «примечательное решение Пети» лежало бы в промпте чужого
 * провайдера.
 *
 * Группы считает сервер, не модель: `normalizeAttempt` — та же функция, по
 * которой пульт рисует стопку и полосу, и два разных «одинаково» дали бы
 * сводку, в которой «так же ещё 311» не сходится с шириной сегмента.
 *
 * Обновляется только рукой. Сводка стоит вопроса из лимита комнаты, а класс
 * сдаёт по одному в секунду: авто-обновление тратило бы ключ на каждую сдачу
 * и переписывало абзацы под глазами у того, кто их читает. Что сдали ещё N с
 * тех пор — считает клиент по `basedOn`.
 *
 * Разбор ответа устойчив к модели, которая не умеет в строгий JSON: тогда
 * остаётся сводка из текста, а имена и черновики — пустые. Плохая сводка лучше
 * красной ошибки посреди пары.
 */
import type {
  CouncilGroup,
  CouncilOracle,
  CouncilOracleAnswer,
  CouncilRun,
  CouncilRunRequest,
  CouncilStatus,
} from '@shared/protocol'
import { attemptStatus, groupAttempts } from '@shared/protocol'
import { normalizeAttempt } from '@shared/notebook'
import { randomUUID } from 'node:crypto'
import { getOracleSettings } from '../admin/settings.js'
import { noteTokens } from '../admin/usage.js'
import { streamChat, type ChatTurn } from './provider.js'
import { clip as clipTo, clipLine as cutLine, flatten, groupsWord, people, seconds } from './text.js'

/** То, что оракулу нужно от попытки: без имени, цвета и аватара — их он не видит. */
export interface OracleAttempt {
  participantId: string
  text: string
  submittedAt: number | null
  run: CouncilRun | null
  correct: boolean | null
  /**
   * Просьба о запуске, если запуск идёт «по просьбе»: `pending` — человек ждёт,
   * пока его пустят к ядру.
   *
   * Оракулу о классе это нужно ровно как одна цифра в сводке («ждут разрешения:
   * 3») и одна пометка в строке человека: ждущий запуска не застрял и не упал,
   * он упёрся в очередь, и говорить о нём «не запускал» было бы неправдой.
   * Необязательное: кадру сводки по решениям оно ни к чему, и попытка без него
   * считается никого не ждущей.
   */
  runRequest?: CouncilRunRequest | null
  /**
   * Когда попытку правили в последний раз — разрыв при равном времени сдачи.
   *
   * Не украшение: по этому разрыву выбирается представитель группы, и без него
   * оракул мог назвать представителем не того, кого назвал пульт, — то есть
   * положить черновик ответа на чужую карточку. Необязательное, потому что
   * оракулу оно нужно ровно для сортировки: у попытки, пришедшей без него,
   * ничью решает id.
   */
  updatedAt?: number
}

/** Задание, как его видит модель: текст общей ячейки и то, что вокруг. */
export interface OracleTask {
  /** Текст общей ячейки — то, что студенты решали. */
  source: string
  /** Предыдущая ячейка: условие часто лежит в markdown над кодом. */
  before: string | null
  /** Эталонное решение, если преподаватель его дал. Пока его негде взять — `null`. */
  reference: string | null
}

/** Где оракул хранит состояние — council.ts; в тестах подменяется. */
export interface OracleStore {
  oracleOf(sessionId: string, cellId: string): CouncilOracle | null
  setOracle(sessionId: string, cellId: string, oracle: CouncilOracle): void
}

/*
 * Сколько кода одной группы едет модели.
 *
 * Полторы тысячи знаков — сорок строк, целая попытка почти всегда. Длиннее
 * бывает вставленный файл, и его хвост стоит места, которое лучше отдать ещё
 * одной группе.
 */
const MAX_GROUP_SOURCE = 1_500
const MAX_TASK_SOURCE = 4_000
/** Имя группы — одна строка чипа; длиннее не поместится и не прочитается. */
const MAX_LABEL = 60

/* ----------------------------------------------------------------- группы */

/**
 * Состояние попытки одним словом — как в `CouncilStatus`: отметка
 * преподавателя сильнее запуска, потому что решение о верности — его.
 *
 * Тонкая обёртка над общей `attemptStatus` (protocol.ts): здесь лежала своя
 * копия того же правила, третья по счёту.
 */
export function statusOf(attempt: Pick<OracleAttempt, 'run' | 'correct'>): CouncilStatus {
  return attemptStatus({ run: attempt.run ?? null, correct: attempt.correct ?? null })
}

/**
 * Группы одинаковых решений среди СДАННЫХ — от большой к малой.
 *
 * Только сданные: то, что человек ещё печатает, — не решение, а полуслово, и
 * группа «x=» из сорока недописанных попыток ничего не сказала бы ни модели,
 * ни преподавателю.
 *
 * Складывает их общая `groupAttempts` (protocol.ts) — та же, что собирает
 * стопку на сервере и полосу на пульте. Своя копия жила здесь и отличалась
 * ничьей: `updatedAt` оракулу не возили вовсе, и в одну миллисекунду
 * представитель группы у оракула мог оказаться не тем, что на карточке, — то
 * есть черновик ответа лёг бы не на ту группу. Теперь `updatedAt` едет, и
 * разрыв один на всех.
 */
export function groupsOf(attempts: readonly OracleAttempt[]): CouncilGroup[] {
  return groupAttempts(
    attempts.map((attempt) => ({
      participantId: attempt.participantId,
      text: attempt.text,
      submittedAt: attempt.submittedAt,
      updatedAt: attempt.updatedAt ?? 0,
      status: statusOf(attempt),
      // Оракулу «на экране» не нужно, но форма группы одна на всех.
      shown: false,
      groupKey: normalizeAttempt(attempt.text),
    })),
  )
}

/* ----------------------------------------------------------------- промпт */

const STATUS_WORDS: Record<CouncilStatus, string> = {
  unrun: 'не запускали',
  ran: 'запуск прошёл без исключения',
  failed: 'запуск упал',
  correct: 'преподаватель отметил «верно»',
  wrong: 'преподаватель отметил «неверно»',
}

/**
 * «запуск упал: TypeError» — имя исключения из вывода, если оно есть. Упасть
 * мог не представитель, а любой член группы — берётся первый упавший.
 */
function statusLine(group: CouncilGroup, byId: Map<string, OracleAttempt>): string {
  const word = STATUS_WORDS[group.status]
  if (group.status !== 'failed') return word
  const failed = group.members
    .map((id) => byId.get(id))
    .find((attempt) => attempt?.run?.state === 'error')
  const error = failed?.run?.outputs.find((o) => o.kind === 'error')
  return error
    ? `${word}: ${error.ename}${error.evalue ? ` — ${clipLine(error.evalue, 120)}` : ''}`
    : word
}

const SYSTEM = [
  'Ты помогаешь преподавателю разобрать решения студентов прямо на занятии.',
  'Тебе дано задание (текст ячейки тетради), контекст вокруг него и группы',
  'одинаковых решений: у каждой — номер G1…GN, число людей, состояние запуска',
  'и код одного представителя. Имён нет и не нужно — не выдумывай их.',
  '',
  'Ответь СТРОГО одним JSON-объектом без слов до и после него и без пояснений:',
  '{',
  '  "summary": [три абзаца строками: 1) что в решениях верно; 2) типичная ошибка',
  '              и в каких группах она; 3) что показать классу и почему],',
  '  "groupLabels": {"G1": "имя группы одной короткой строкой, до 40 знаков", …} — для КАЖДОЙ группы,',
  '  "drafts": {"G2": "черновик ответа группе с ошибкой: 2–4 предложения, на «вы»,',
  '             без имён, указать на ошибку, не решать за них"} — ТОЛЬКО для групп с ошибкой',
  '}',
  'Keep summary paragraphs short: the teacher reads them during class.',
].join('\n')

/**
 * Кадр для модели: задание, контекст, группы. Возвращает и `keys` — какой ключ
 * группы стоит за каждым G-номером: по ним разбор ответа вернёт имена и
 * черновики к настоящим группам.
 *
 * Бюджет — `contextChars` инстанса, как у обычного вопроса: преподаватель,
 * опустивший его под маленькую модель, ждёт, что и сводка в него уложится.
 * Большие группы едут первыми целиком; маленькие, которым не хватило места,
 * складываются в одну строку счётом — модель должна знать, что они есть.
 */
export function oraclePrompt(
  task: OracleTask,
  groups: readonly CouncilGroup[],
  attempts: readonly OracleAttempt[],
  budget: number = getOracleSettings().contextChars,
): { turns: ChatTurn[]; keys: string[] } {
  const system = SYSTEM + '\n' + tr('server.ai.answerLanguage')
  const byId = new Map(attempts.map((a) => [a.participantId, a] as const))
  const head: string[] = []
  if (task.before) {
    head.push('КОНТЕКСТ (ячейка над заданием):', clip(task.before, MAX_TASK_SOURCE), '')
  }
  head.push('ЗАДАНИЕ (текст общей ячейки):', '```', clip(task.source, MAX_TASK_SOURCE), '```', '')
  if (task.reference) {
    head.push(
      'ЭТАЛОННОЕ РЕШЕНИЕ преподавателя:',
      '```python',
      clip(task.reference, MAX_TASK_SOURCE),
      '```',
      '',
    )
  }
  const total = groups.reduce((n, g) => n + g.count, 0)
  head.push(
    `РЕШЕНИЯ: ${people(total)} сдали, ${groups.length} ${groupsWord(groups.length)} одинаковых решений.`,
    '',
  )

  const keys: string[] = []
  const blocks: string[] = []
  let used = system.length + head.join('\n').length
  let hidden = 0
  let hiddenPeople = 0
  for (const group of groups) {
    const no = `G${keys.length + 1}`
    const block = [
      `### ${no} — ${people(group.count)}, ${statusLine(group, byId)}`,
      '```python',
      clip(group.sample.trim() || tr("server.empty.9a3a4f"), MAX_GROUP_SOURCE),
      '```',
    ].join('\n')
    // Хотя бы одна группа едет всегда: сводка без единого решения — это не
    // сводка, а бюджет, который меньше одного листа, поставлен по ошибке.
    if (keys.length > 0 && used + block.length > budget) {
      hidden++
      hiddenPeople += group.count
      continue
    }
    keys.push(group.key)
    blocks.push(block)
    used += block.length + 2
  }
  if (hidden > 0) {
    blocks.push(
      `Ещё ${hidden} ${groupsWord(hidden)} (${people(hiddenPeople)}) — маленькие, в кадр не поместились.`,
    )
  }
  const turns: ChatTurn[] = [
    { role: 'system', content: system },
    { role: 'user', content: [...head, ...blocks].join('\n') },
  ]
  return { turns, keys }
}

/**
 * Голова и хвост: в хвосте кода — возврат, в хвосте условия — вопрос.
 *
 * Общей обрезкой (text.ts · clip), только словами по-русски: кадр сводки
 * написан по-русски, и английский маркер посреди него читался бы как чужой.
 * Своя копия здесь резала 70/30 и клала маркер СВЕРХ потолка — то есть отдавала
 * модели больше, чем ей отвели бюджетом.
 */
function clip(text: string, limit: number): string {
  return clipTo(text, limit, (dropped) => `\n… пропущено ${dropped} знаков …\n`)
}

/** Однострочно: трейсбек в чипе группы читается только так. */
function clipLine(text: string, limit: number): string {
  return cutLine(flatten(text), limit)
}

/* ------------------------------------------------------ кадр о классе */

/*
 * Оракул о КЛАССЕ — второй кадр, и он не про код, а про то, как идут дела.
 *
 * Сводка по решениям (`oraclePrompt`) читает только СДАННОЕ: пока никто не
 * сдал, читать ей нечего, и преподаватель на живом семинаре 19.09 упёрся ровно
 * в это — на десятой минуте, когда половина класса ещё пишет, а двое молча
 * застряли, спросить было не у кого. Здесь едет весь класс: черновики, запуски,
 * тишина, — и свободный вопрос преподавателя поверх.
 *
 * Обещание из шапки файла держится и тут, и это единственное, ради чего кадр
 * собирается руками, а не отдаётся модели списком попыток: людей зовут S1…SN,
 * и соответствие «метка → человек» остаётся на сервере (`ClassFrame.people`).
 * Ни имени, ни цвета, ни аватара, ни participantId в промпт не уезжает —
 * это закреплено тестом.
 */

/** Пять минут без единой правки — «застрял»: лист открыт, в нём ничего не происходит. */
const SILENCE_MS = 5 * 60_000

/** Сколько кода одного листа едет в кадре статуса: экран, а не файл. */
const MAX_SHEET_SOURCE = 900

/**
 * Какую долю СВОБОДНОГО места забирают строки по людям.
 *
 * Половина: на классе в пятьсот человек список сам по себе съел бы весь кадр, и
 * модель отвечала бы «кто застрял» по одним цифрам, не видя ни строчки кода.
 * Вторая половина — группам и листам тех, у кого что-то случилось.
 */
const ROSTER_SHARE = 0.5

/** Кадр о классе: что уехало модели и кого она под какой меткой видела. */
export interface ClassFrame {
  turns: ChatTurn[]
  /** Метка → participantId. Ключи — `S1`, `S2`, …; уходит только преподавателю. */
  people: Record<string, string>
  /** На каком классе отвечали — эта пара стоит под ответом в ленте. */
  basedOn: { submitted: number; drafts: number }
}

const STATUS_SYSTEM = [
  'Ты помогаешь преподавателю вести занятие: он спрашивает, как идут дела у класса.',
  'Тебе дана сводка по листам одной задачи: числа, строки по людям и код.',
  'Людей зовут метками S1…SN, группы одинаковых сданных решений — G1…GN.',
  'Имён нет и не нужно — не выдумывай их и не придумывай новых меток.',
  '',
  'Отвечай КОРОТКО и по делу, обычной прозой: преподаватель читает ответ прямо',
  'на паре, стоя у доски. Два-три предложения, если хватает; без JSON, без',
  'заголовков и без длинных списков. На людей ссылайся ТОЛЬКО метками (S7),',
  'на группы — G2. Если в данных ответа на вопрос нет — так и скажи одной',
  'строкой, не догадываясь.',
  '',
  // Диапазон «S6–S10» пульт подменяет двумя именами с тире посередине, и
  // фраза читается как чужая фамилия: «Александр Яковлев–Александр».
  'Метки перечисляй через запятую (S6, S7, S8) и никогда не пиши их',
  'диапазоном вида S6–S10: преподаватель видит на месте метки имя студента.',
].join('\n')

/** «17:25» — время сдачи в строке человека; часы сервера, как и везде в кадре. */
function hhmm(at: number): string {
  const when = new Date(at)
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
}

/** «только что», «3 мин назад», «1 ч 05 мин назад» — давность правки листа. */
function ago(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60_000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин назад`
  return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин назад`
}

/**
 * Состояние ОДНОГО листа словами — то же правило, что у группы, плюс две вещи,
 * которых у группы нет: остановка по пределу и ожидание разрешения.
 *
 * Остановку по пределу отдельно от падения, потому что это разные разговоры:
 * упавший ошибся, а остановленный написал бесконечный цикл или ждёт `input()`, и
 * преподаватель подходит к нему по-другому. По `ename` их не различить —
 * сервер прерывает запуск сам (`CouncilRun.timedOut`).
 */
function sheetStatus(attempt: OracleAttempt): string {
  const status = statusOf(attempt)
  if (status !== 'failed') return STATUS_WORDS[status]
  const run = attempt.run
  if (run?.timedOut !== undefined) return `запуск остановлен: дольше ${seconds(run.timedOut)}`
  const error = run?.outputs.find((o) => o.kind === 'error')
  return error
    ? `${STATUS_WORDS.failed}: ${error.ename}${error.evalue ? ` — ${clipLine(error.evalue, 120)}` : ''}`
    : STATUS_WORDS.failed
}

/** Ждёт ли человек, пока его пустят к ядру. */
function waiting(attempt: OracleAttempt): boolean {
  return attempt.runRequest?.status === 'pending'
}

/**
 * Черновик, в который давно не дописали ни знака.
 *
 * Без `updatedAt` — не молчит: время правки необязательное (его не возит кадр
 * сводки), и считать «нет времени» за «давно не трогали» значило бы объявить
 * застрявшим весь класс на первом же кадре без этого поля.
 */
function silent(attempt: OracleAttempt, now: number): boolean {
  if (attempt.submittedAt !== null || attempt.updatedAt === undefined) return false
  return now - attempt.updatedAt > SILENCE_MS
}

/** Строка одного человека и его место в очереди на внимание. */
interface Row {
  label: string
  attempt: OracleAttempt
  /** 0 — похоже, нужна помощь; 1 — молчит; 2 — просто работает. */
  rank: number
  line: string
}

function rowOf(label: string, attempt: OracleAttempt, now: number, group: number | null): Row {
  const status = statusOf(attempt)
  const stuck = status === 'failed'
  const quiet = silent(attempt, now)
  const bits = [
    label,
    attempt.submittedAt === null
      ? 'пишет'
      : `сдал ${hhmm(attempt.submittedAt)}${group === null ? '' : `, G${group}`}`,
    sheetStatus(attempt),
  ]
  if (waiting(attempt)) bits.push('ждёт разрешения на запуск')
  const lines = attempt.text.trim() ? attempt.text.split('\n').length : 0
  bits.push(lines === 0 ? 'лист пуст' : `${lines} ${linesWord(lines)}`)
  if (attempt.updatedAt !== undefined) bits.push(`правка ${ago(now - attempt.updatedAt)}`)
  return { label, attempt, rank: stuck ? 0 : quiet ? 1 : 2, line: bits.join(' · ') }
}

/** «1 строка», «3 строки», «12 строк» — счёт, который не режет глаз в кадре. */
function linesWord(n: number): string {
  return tr('server.ai.linesWord', { count: n })
}

/**
 * Числа по классу — то, с чего модель начинает читать кадр.
 *
 * Отдельной функцией, потому что по ней же собираются `basedOn` ленты и порядок
 * строк: одно место, где решается, кто «упал», кто «молчит» и кто «ждёт».
 */
function tally(attempts: readonly OracleAttempt[], now: number) {
  let submitted = 0
  let ran = 0
  let failed = 0
  let stopped = 0
  let unrun = 0
  let waits = 0
  let right = 0
  let wrong = 0
  let quiet = 0
  const errors = new Map<string, number>()
  for (const attempt of attempts) {
    if (attempt.submittedAt !== null) submitted += 1
    if (waiting(attempt)) waits += 1
    if (silent(attempt, now)) quiet += 1
    if (attempt.correct === true) right += 1
    if (attempt.correct === false) wrong += 1
    const run = attempt.run
    if (!run) {
      unrun += 1
    } else if (run.timedOut !== undefined) {
      stopped += 1
    } else if (run.state === 'error') {
      failed += 1
      const name = run.outputs.find((o) => o.kind === 'error')?.ename?.trim()
      if (name) errors.set(name, (errors.get(name) ?? 0) + 1)
    } else if (run.state === 'ok') {
      ran += 1
    }
  }
  return {
    total: attempts.length,
    submitted,
    drafts: attempts.length - submitted,
    ran,
    failed,
    stopped,
    unrun,
    waits,
    right,
    wrong,
    quiet,
    // Топ имён исключений: три штуки — это уже «типичная ошибка», дальше хвост.
    errors: [...errors.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3),
  }
}

/**
 * Кадр о классе для свободного вопроса преподавателя.
 *
 * `now` — параметром, а не `Date.now()` внутри: «тишина» и «правка 3 мин назад»
 * считаются от него, и тест, у которого время подставное, проверяет настоящие
 * числа, а не то, что успело пройти между двумя строками.
 *
 * Бюджет — `contextChars` инстанса, как у сводки. Тратится по порядку: сначала
 * задание и числа (они едут всегда — кадр без них не кадр), потом строки по
 * людям (не больше половины оставшегося), потом код: группы сданных, потом
 * листы тех, у кого что-то случилось. Хвост списка людей сворачивается в счёт:
 * модель должна знать, что за кадром есть ещё класс, иначе «у всех остальных
 * всё хорошо» она скажет, не имея на это права.
 */
export function statusPrompt(
  task: OracleTask,
  attempts: readonly OracleAttempt[],
  question: string,
  now: number = Date.now(),
  budget: number = getOracleSettings().contextChars,
): ClassFrame {
  const system = STATUS_SYSTEM + '\n' + tr('server.ai.answerLanguage')

  /*
   * Метки раздаются по participantId, а не по времени сдачи или правки.
   *
   * И то и другое живое: сосед сдал, передумал, дописал запятую — и S7 в
   * следующем вопросе оказался бы другим человеком. Нумерация по id не плывёт,
   * пока класс работает, а к людям её всё равно привязывает не модель, а
   * словарь `people`, который едет рядом с ответом.
   */
  const ordered = [...attempts].sort((a, b) => a.participantId.localeCompare(b.participantId))
  const labels = new Map(ordered.map((attempt, at) => [attempt.participantId, `S${at + 1}`]))
  const who: Record<string, string> = {}
  for (const [id, label] of labels) who[label] = id

  const sum = tally(attempts, now)
  const head: string[] = []
  if (task.before) {
    head.push('КОНТЕКСТ (ячейка над заданием):', clip(task.before, MAX_TASK_SOURCE), '')
  }
  head.push('ЗАДАНИЕ (текст общей ячейки):', '```', clip(task.source, MAX_TASK_SOURCE), '```', '')
  head.push(
    `СЕЙЧАС: ${hhmm(now)}.`,
    `КЛАСС: ${people(sum.total)} с листом — сдали ${sum.submitted}, ещё пишут ${sum.drafts}.`,
    `ЗАПУСКИ: без ошибки ${sum.ran}, с ошибкой ${sum.failed}` +
      (sum.errors.length > 0
        ? ` (${sum.errors.map(([name, n]) => `${name} — ${n}`).join(', ')})`
        : '') +
      `, остановлено пределом ${sum.stopped}, не запускали ${sum.unrun}, ждут разрешения ${sum.waits}.`,
    `ОТМЕТКИ преподавателя: верно ${sum.right}, неверно ${sum.wrong}, без отметки ${sum.total - sum.right - sum.wrong}.`,
    `ТИШИНА: черновиков без правки дольше 5 минут — ${sum.quiet}.`,
    '',
  )

  /*
   * Группы считаются до списка людей, потому что номер группы стоит В СТРОКЕ
   * человека: «S7 · сдал 17:25, G2 · …». Без этой связки модель, которую
   * спросили «в каких группах типичная ошибка и кому о ней сказать», знает про
   * G2 всё, кроме того, кто в ней сидит.
   */
  const groups = groupsOf(attempts)
  const groupNo = new Map<string, number>()
  for (const [at, group] of groups.entries()) for (const id of group.members) groupNo.set(id, at + 1)

  const rows = [...labels]
    .map(([id, label]) => {
      const attempt = attempts.find((one) => one.participantId === id)
      return attempt ? rowOf(label, attempt, now, groupNo.get(id) ?? null) : null
    })
    .filter((row): row is Row => row !== null)
    // Сначала те, кому вероятнее нужна помощь: упал, молчит, всё остальное.
    // Внутри разряда — по номеру метки, чтобы два одинаковых кадра совпали.
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, 'en', { numeric: true }))

  let used = system.length + head.join('\n').length + question.length
  const roster: string[] = ['ПО ЛЮДЯМ (метки S — других имён у этих людей нет):']
  const rosterCap = used + Math.max(0, budget - used) * ROSTER_SHARE
  let folded = 0
  let foldedQuiet = 0
  for (const row of rows) {
    if (used + row.line.length > rosterCap) {
      folded += 1
      if (row.rank === 2) foldedQuiet += 1
      continue
    }
    roster.push(row.line)
    used += row.line.length + 1
  }
  if (folded > 0) {
    const tail =
      folded === foldedQuiet
        ? `Ещё ${folded} без происшествий.`
        : `Ещё ${folded} в кадр не поместились (из них ${folded - foldedQuiet} с происшествиями).`
    roster.push(tail)
    used += tail.length + 1
  }
  roster.push('')

  /*
   * Код — вторым заходом: сначала группы сданных (они же G-номера ответа),
   * потом листы тех, у кого что-то случилось. Порядок именно такой, потому что
   * вопрос «типичные ошибки» отвечается по группам, а «кто застрял» — по
   * первым строкам списка, которые в кадре уже есть.
   */
  const code: string[] = []
  /** Чей код в кадре уже есть группой — второй раз его везти незачем. */
  const shown = new Set<string>()
  if (groups.length > 0) {
    code.push('СДАННЫЕ РЕШЕНИЯ ГРУППАМИ:')
    used += code[0].length + 1
    const byId = new Map(attempts.map((a) => [a.participantId, a] as const))
    let hidden = 0
    for (const [at, group] of groups.entries()) {
      const block = [
        `### G${at + 1} — ${people(group.count)}, ${statusLine(group, byId)}`,
        '```python',
        clip(group.sample.trim() || tr('server.empty.9a3a4f'), MAX_GROUP_SOURCE),
        '```',
      ].join('\n')
      if (used + block.length > budget) {
        hidden += 1
        continue
      }
      code.push(block)
      for (const id of group.members) shown.add(id)
      used += block.length + 2
    }
    if (hidden > 0) code.push(`Ещё ${hidden} ${groupsWord(hidden)} в кадр не поместились.`)
    code.push('')
  }

  /*
   * Листы поимённо — только те, которых в кадре ещё нет.
   *
   * Сданная упавшая попытка уже уехала своим группам блоком, и второй раз тот
   * же код стоил бы полутора тысяч знаков бюджета — то есть места ещё для двух
   * черновиков, которых модель иначе не увидит вовсе. Кто в какой группе,
   * сказано строкой человека («S7 · сдал 17:25, G2 · …»).
   */
  const trouble = rows.filter(
    (row) =>
      row.rank < 2 && row.attempt.text.trim().length > 0 && !shown.has(row.attempt.participantId),
  )
  if (trouble.length > 0) {
    const title = 'ЛИСТЫ ТЕХ, У КОГО ЧТО-ТО СЛУЧИЛОСЬ:'
    const blocks: string[] = []
    used += title.length + 1
    for (const row of trouble) {
      const block = [
        `### ${row.label} — ${row.line.slice(row.label.length + 3)}`,
        '```python',
        clip(row.attempt.text.trim(), MAX_SHEET_SOURCE),
        '```',
      ].join('\n')
      if (used + block.length > budget) break
      blocks.push(block)
      used += block.length + 2
    }
    if (blocks.length > 0) code.push(title, ...blocks, '')
  }

  const turns: ChatTurn[] = [
    { role: 'system', content: system },
    { role: 'user', content: [...head, ...roster, ...code, 'ВОПРОС ПРЕПОДАВАТЕЛЯ:', question].join('\n') },
  ]
  return { turns, people: who, basedOn: { submitted: sum.submitted, drafts: sum.drafts } }
}

/* ----------------------------------------------------------------- разбор */

/**
 * Что удалось вычитать из ответа модели — уже по настоящим ключам групп.
 *
 * `notable` («до трёх примечательных решений») отсюда убран, и это не потеря.
 * Модель тратила на него токены в самом дорогом запросе комнаты, сервер
 * разбирал его и подставлял представителя группы — а нарисовать его было
 * негде: ни стопка, ни сводка, ни карточка его не читали, и `CouncilOracle`
 * возил его пустым грузом в каждом кадре. Обещание из шапки этого файла —
 * «к людям их привязывает пульт» — пульт не выполнял. Поля нет и в протоколе:
 * пустой груз в кадре — то же самое обещание, только молчаливое.
 */
export interface ParsedOracle {
  summary: string[]
  groupLabels: Record<string, string>
  drafts: Record<string, string>
}

/**
 * Разобрать ответ, чем бы он ни оказался.
 *
 * Хорошая модель отдаёт JSON; средняя — JSON в ```json-ограде с абзацем
 * «вот ваш ответ» перед ним; плохая — три абзаца прозы. Все три случая дают
 * сводку: из прозы — абзацами, до трёх. Имена и черновики — только из JSON:
 * угадывать их из текста значило бы приписать группе чужую строку.
 *
 * Ключи модели — G-номера, `keys[i]` говорит, чей это ключ. Номер, которого
 * в кадре не было, отбрасывается: модель их иногда досочиняет.
 */
export function parseOracleAnswer(text: string, keys: readonly string[]): ParsedOracle {
  const empty: ParsedOracle = { summary: [], groupLabels: {}, drafts: {} }
  const raw = extractJson(text)
  if (!raw || typeof raw !== 'object') {
    return { ...empty, summary: paragraphsOf(text) }
  }
  const obj = raw as Record<string, unknown>
  const summary = stringsOf(obj.summary)
  const groupLabels: Record<string, string> = {}
  for (const [no, label] of entriesOf(obj.groupLabels)) {
    const key = keyFor(no, keys)
    if (key !== null && label) groupLabels[key] = clipLine(label, MAX_LABEL)
  }
  const drafts: Record<string, string> = {}
  for (const [no, draft] of entriesOf(obj.drafts)) {
    const key = keyFor(no, keys)
    if (key !== null && draft) drafts[key] = draft.trim()
  }
  return {
    // JSON без сводки — редкость, но лучше проза целиком, чем пустые абзацы.
    summary: summary.length > 0 ? summary : paragraphsOf(text),
    groupLabels,
    drafts,
  }
}

/** «G3», «g3», « G3 », «3» и сам ключ группы — всё это третья группа. */
function keyFor(no: string, keys: readonly string[]): string | null {
  const flat = no.trim()
  if (keys.includes(flat)) return flat
  const m = /^g?\s*(\d+)$/i.exec(flat)
  if (!m) return null
  const index = Number(m[1]) - 1
  return index >= 0 && index < keys.length ? keys[index] : null
}

function entriesOf(value: unknown): [string, string][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const out: [string, string][] = []
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out.push([k, v])
  }
  return out
}

/** Массив строк — до трёх; одна строка — тоже сводка; что угодно ещё — ничего. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return paragraphsOf(value)
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 3)
}

/** Абзацы прозы — до трёх; без пустых строк делится по строкам. */
function paragraphsOf(text: string): string[] {
  const cleaned = text.replace(/```[a-z]*\n?|```/gi, '').trim()
  if (!cleaned) return []
  const byBlank = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const parts =
    byBlank.length > 1
      ? byBlank
      : cleaned
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean)
  return parts.slice(0, 3)
}

/**
 * Найти JSON в ответе: сначала внутри ```-ограды, потом от первой `{` до
 * последней `}`. Оба разбора могут не сойтись — тогда `null`, и сводка идёт
 * из текста.
 */
function extractJson(text: string): unknown {
  const candidates: string[] = []
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced) candidates.push(fenced[1])
  const from = text.indexOf('{')
  const to = text.lastIndexOf('}')
  if (from >= 0 && to > from) candidates.push(text.slice(from, to + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* следующий кандидат */
    }
  }
  return null
}

/* -------------------------------------------------------------- состояние */

/**
 * Сколько ходов ленты держит сервер.
 *
 * Шесть — это разговор на паре: что спрашивали полчаса назад, на доске уже
 * неважно. И это потолок кадра: каждый ответ везёт свой словарь меток, и лента
 * без предела росла бы в КАЖДОМ `council:oracle` до конца занятия.
 */
export const MAX_ORACLE_ANSWERS = 6

export function idleOracle(): CouncilOracle {
  return {
    state: 'idle',
    askedAt: null,
    basedOn: 0,
    summary: [],
    groupLabels: {},
    drafts: {},
    error: null,
    answers: [],
    pending: null,
  }
}

/**
 * Прочитанный из базы оракул, приведённый к сегодняшнему кадру.
 *
 * Строки `council_oracle` пишутся JSON-ом и переживают обновление сервера:
 * записанные до ленты вопросов не знают ни `answers`, ни `pending`, и читатель,
 * который положится на их наличие, уронит пульт на первом же занятии, начатом
 * вчера. Здесь же держится и потолок ленты — на случай, если строку записала
 * версия, считавшая иначе.
 */
export function normalizeOracle(oracle: CouncilOracle): CouncilOracle {
  return {
    ...idleOracle(),
    ...oracle,
    answers: Array.isArray(oracle.answers) ? oracle.answers.slice(-MAX_ORACLE_ANSWERS) : [],
    pending: oracle.pending ?? null,
  }
}

type OracleListener = (sessionId: string, cellId: string, oracle: CouncilOracle) => void

let listener: OracleListener | null = null

/**
 * Кому сказать, что оракул сменил состояние. Регистрирует control.ts — у него
 * сокеты преподавателей; импорт control.ts отсюда замкнул бы модули друг на
 * друга, ровно как onRefusal в collab/index.ts.
 */
export function onCouncilOracle(next: OracleListener): void {
  listener = next
}

function announce(sessionId: string, cellId: string, oracle: CouncilOracle): void {
  listener?.(sessionId, cellId, oracle)
}

/** Ключ — `${sessionId}:${cellId}`; запись есть только пока модель читает. */
const reading = new Map<string, AbortController>()

export function isOracleReading(sessionId: string, cellId: string): boolean {
  return reading.has(`${sessionId}:${cellId}`)
}

export interface AskCouncilOracle {
  sessionId: string
  cellId: string
  task: OracleTask
  attempts: readonly OracleAttempt[]
  store: OracleStore
  /** Строка расхода, заведённая маршрутом при приёме: токены лягут на неё. */
  usageId?: number
  /**
   * Вопрос преподавателя о классе; `null` или пусто — прежняя сводка по
   * решениям.
   *
   * Два вида запроса и одно чтение на оба: ключ, лимит, «Стоп» и 409 у них
   * общие — к модели за обоими идёт один и тот же поход, и разводить их на два
   * состояния значило бы разрешить два одновременных.
   */
  question?: string | null
}

/**
 * Спросить. Возвращает состояние «читает» сразу — 202 отдаётся им; ответ
 * приезжает потом через `onCouncilOracle`. Пока читает, прежние имена и
 * черновики остаются: чипы на пульте не должны моргать на время вопроса.
 *
 * Вопрос о классе НЕ трогает `basedOn` и `askedAt` — они про сводку по
 * решениям. Иначе «Кто застрял?» на пятой сдаче сбрасывал бы счёт «сводка
 * отстала на N», который считается разницей с `basedOn` (protocol.ts ·
 * CouncilOracle), и сводка молча выглядела бы свежей.
 */
export function askCouncilOracle(input: AskCouncilOracle): CouncilOracle {
  const { sessionId, cellId, store } = input
  const key = `${sessionId}:${cellId}`
  const previous = normalizeOracle(store.oracleOf(sessionId, cellId) ?? idleOracle())
  const question = input.question?.trim() ? input.question.trim() : null
  const groups = groupsOf(input.attempts)
  const now = Date.now()
  const started: CouncilOracle = question
    ? { ...previous, state: 'reading', error: null, pending: { question, askedAt: now } }
    : {
        ...previous,
        state: 'reading',
        askedAt: now,
        basedOn: groups.reduce((n, g) => n + g.count, 0),
        error: null,
        pending: null,
      }
  store.setOracle(sessionId, cellId, started)
  announce(sessionId, cellId, started)

  const controller = new AbortController()
  reading.set(key, controller)
  void read(input, groups, previous, question, controller).finally(() => {
    if (reading.get(key) === controller) reading.delete(key)
  })
  return started
}

async function read(
  input: AskCouncilOracle,
  groups: CouncilGroup[],
  previous: CouncilOracle,
  question: string | null,
  controller: AbortController,
): Promise<void> {
  const { sessionId, cellId, store } = input
  const settle = (oracle: CouncilOracle) => {
    store.setOracle(sessionId, cellId, oracle)
    announce(sessionId, cellId, oracle)
  }
  /*
   * Не вышло — вернуть то, что было: прежняя сводка (если была) с причиной
   * рядом, а не пустота. Преподаватель, нажавший «Обновить» и получивший
   * ошибку сети, не должен потерять три абзаца, которые читал минуту назад.
   *
   * Лента вопросов переживает отказ в обоих случаях: она — разговор, а не
   * состояние запроса, и терять её из-за оборванного соединения незачем.
   */
  const giveBack = (error: string | null) =>
    settle(
      previous.state === 'ready'
        ? { ...previous, state: 'ready', pending: null, error }
        : { ...idleOracle(), answers: previous.answers, error },
    )

  const spend = (tokens: number) => {
    if (input.usageId !== undefined) noteTokens(input.usageId, tokens)
  }

  try {
    const frame = question
      ? statusPrompt(input.task, input.attempts, question)
      : oraclePrompt(input.task, groups, input.attempts)
    const text = await streamChat(frame.turns, () => {}, controller.signal, spend)
    if (controller.signal.aborted) {
      giveBack(null)
      return
    }
    if (!text.trim()) {
      giveBack(tr("server.theModelReturnedAnEmptyResponseTry.c365b1"))
      return
    }
    if (question && 'people' in frame) {
      const answer: CouncilOracleAnswer = {
        id: randomUUID(),
        question,
        text: text.trim(),
        askedAt: Date.now(),
        basedOn: frame.basedOn,
        people: frame.people,
      }
      settle({
        // Всё, что было, остаётся: вопрос о классе ничего не пересчитывает —
        // он дописывает строку в ленту.
        ...previous,
        state: 'ready',
        error: null,
        pending: null,
        answers: [...previous.answers, answer].slice(-MAX_ORACLE_ANSWERS),
      })
      return
    }
    const parsed = parseOracleAnswer(text, 'keys' in frame ? frame.keys : [])
    settle({
      ...previous,
      state: 'ready',
      askedAt: Date.now(),
      basedOn: groups.reduce((n, g) => n + g.count, 0),
      summary: parsed.summary,
      groupLabels: parsed.groupLabels,
      // Черновик группе, которую преподаватель уже отметил верной, — лишний.
      drafts: Object.fromEntries(
        Object.entries(parsed.drafts).filter(
          ([key]) => groups.find((g) => g.key === key)?.status !== 'correct',
        ),
      ),
      error: null,
      pending: null,
    })
  } catch (err) {
    if (controller.signal.aborted) {
      giveBack(null)
      return
    }
    const reason = err instanceof Error ? err.message.trim() : String(err)
    console.error(`[session ${sessionId}] council oracle failed:`, reason)
    giveBack(reason || tr("server.theOracleDidNotRespondCheckThe.e430c5"))
  }
}

/** «Стоп»: оборвать чтение. `false` — читать было нечего. */
export function stopCouncilOracle(sessionId: string, cellId: string): boolean {
  const controller = reading.get(`${sessionId}:${cellId}`)
  if (!controller) return false
  controller.abort()
  return true
}

/**
 * Оборвать все чтения комнаты — семинар сносят.
 *
 * Зовёт `discardCouncil` (server/src/council.ts). Без этого ответ, пришедший
 * через минуту после удаления, шёл в `setOracle`, а тот заводил кэш комнаты
 * заново и писал строку `council_oracle` для сессии, которой в списке уже нет.
 * Возвращает, сколько чтений оборвали, — ради журнала и теста.
 */
export function stopRoomOracles(sessionId: string): number {
  const prefix = `${sessionId}:`
  let stopped = 0
  for (const [key, controller] of reading) {
    if (!key.startsWith(prefix)) continue
    controller.abort()
    stopped += 1
  }
  return stopped
}
