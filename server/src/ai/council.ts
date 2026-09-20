import { tr } from '@shared/i18n'
/**
 * Оракул о классе: один взгляд сверху на то, как идёт задача.
 *
 * Один кадр, один ответ, одна лента. Раньше их было два: «сводка по решениям»
 * читала только СДАННОЕ и складывала его в шесть групп одинаковых текстов, а
 * «вопрос о классе» видел весь класс и отвечал прозой. Оба вида ушли в один, и
 * это решение владельца, а не упрощение ради упрощения:
 *
 *   — группы преподаватель попросил снести. Шесть безымянных стопок — это не
 *     то, как он думает о классе; он думает «у Ани работает, у Пети падает», а
 *     черновик письма группе в придачу оказывался письмом не тому;
 *   — спрашивать можно ВСЕГДА, в том числе когда не сдал ещё никто: «что это
 *     вообще за задание и как им лучше действовать» — законный вопрос на
 *     десятой минуте, а кадр несёт текст общей ячейки и markdown над ней даже
 *     на пустой ячейке.
 *
 * Модель видит ИМЕНА. Это тоже выбор владельца, и он записан здесь честно,
 * потому что раньше в этой шапке стояло обратное обещание. С метками S1…SN
 * модель отвечала «S7 и S12 застряли», преподаватель читал шифр, а на просьбу
 * «кому подойти» модель имена выдумывала. Теперь в кадре стоят настоящие имена
 * из состава комнаты, и она ссылается на людей так же, как это сделал бы
 * коллега. Выключается это одной настройкой инстанса («Имена учащихся в
 * запросах к модели», OracleSettings.sendNames) — тогда возвращаются метки, и
 * соответствие «метка → человек» остаётся на сервере (`ClassFrame.people`).
 * Решает владелец ключа: это про то, что уходит ЧУЖОМУ провайдеру.
 *
 * Обновляется только рукой. Вопрос стоит строки из лимита комнаты, а класс
 * сдаёт по одному в секунду: авто-обновление тратило бы ключ на каждую сдачу и
 * переписывало абзацы под глазами у того, кто их читает.
 *
 * И у похода к модели есть сторож. Общий, из ai/watch.ts: 20.09 на живом
 * занятии «Обновить сводку» на тридцати работах повисло навсегда — ни ответа,
 * ни ошибки, ни строки в журнале, — а запись в карте `reading` держала ячейку
 * запертой до перезапуска сервера. Теперь у запроса три срока, у карты второй
 * замок, а у приёма и исхода — по строке в журнале.
 */
import type {
  CouncilOracle,
  CouncilOracleAnswer,
  CouncilRun,
  CouncilRunRequest,
  CouncilStatus,
} from '@shared/protocol'
import { attemptStatus } from '@shared/protocol'
import type { ReasoningEffort } from '@shared/admin'
import { randomUUID } from 'node:crypto'
import { getOracleSettings } from '../admin/settings.js'
import { dropQuestion, noteTokens } from '../admin/usage.js'
import { streamChat, type ChatTurn } from './provider.js'
import { COUNCIL_WATCH, watchSilence, type WatchTimes } from './watch.js'
import {
  clip as clipTo,
  clipLine as cutLine,
  effortNote,
  flatten,
  people,
  seconds,
} from './text.js'

/** То, что оракулу нужно от попытки. Имя — если инстанс разрешил его слать. */
export interface OracleAttempt {
  participantId: string
  /**
   * Имя человека, как его видит комната.
   *
   * Необязательное: тесты и старые вызовы приходят без него, и кадр тогда
   * зовёт человека меткой — ровно так же, как при выключенной настройке.
   * Цвета и аватара здесь нет и не будет: модели они ни о чём не говорят, а в
   * промпте чужого провайдера это лишние данные о человеке.
   */
  name?: string | null
  text: string
  submittedAt: number | null
  run: CouncilRun | null
  correct: boolean | null
  /**
   * Просьба о запуске, если запуск идёт «по просьбе»: `pending` — человек ждёт,
   * пока его пустят к ядру.
   *
   * Оракулу это нужно ровно как одна цифра в сводке («ждут разрешения: 3») и
   * одна пометка в строке человека: ждущий запуска не застрял и не упал, он
   * упёрся в очередь, и говорить о нём «не запускал» было бы неправдой.
   */
  runRequest?: CouncilRunRequest | null
  /**
   * Когда попытку правили в последний раз — по нему считается тишина.
   *
   * Необязательное: попытка, пришедшая без него, считается никогда не
   * молчавшей (см. `silent`), потому что «нет времени» и «давно не трогали» —
   * разные вещи, и путать их значит объявить застрявшим весь класс.
   */
  updatedAt?: number
}

/** Задание, как его видит модель: текст общей ячейки и то, что вокруг. */
export interface OracleTask {
  /** Текст общей ячейки — то, что студенты решают. */
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

const MAX_TASK_SOURCE = 4_000

/** Сколько кода одного листа едет в кадре: экран, а не файл. */
const MAX_SHEET_SOURCE = 900

/** Пять минут без единой правки — «застрял»: лист открыт, в нём ничего не происходит. */
const SILENCE_MS = 5 * 60_000

/**
 * Какую долю СВОБОДНОГО места забирают строки по людям.
 *
 * Половина: на классе в пятьсот человек список сам по себе съел бы весь кадр, и
 * модель отвечала бы «кто застрял» по одним цифрам, не видя ни строчки кода.
 * Вторая половина — листам: сначала тем, у кого что-то случилось, потом
 * остальным сданным.
 */
const ROSTER_SHARE = 0.5

/* ----------------------------------------------------------------- слова */

const STATUS_WORDS: Record<CouncilStatus, string> = {
  unrun: 'не запускали',
  ran: 'запуск прошёл без исключения',
  failed: 'запуск упал',
  correct: 'преподаватель отметил «верно»',
  wrong: 'преподаватель отметил «неверно»',
}

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
 * Состояние ОДНОГО листа словами — то же правило, что у `statusOf`, плюс две
 * вещи, которых в нём нет: остановка по пределу и ожидание разрешения.
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

/**
 * Голова и хвост: в хвосте кода — возврат, в хвосте условия — вопрос.
 *
 * Общей обрезкой (text.ts · clip), только словами по-русски: кадр написан
 * по-русски, и английский маркер посреди него читался бы как чужой.
 */
function clip(text: string, limit: number): string {
  return clipTo(text, limit, (dropped) => `\n… пропущено ${dropped} знаков …\n`)
}

/** Однострочно: трейсбек в строке человека читается только так. */
function clipLine(text: string, limit: number): string {
  return cutLine(flatten(text), limit)
}

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

/** «1 строка», «3 строки», «12 строк» — счёт, который не режет глаз в кадре. */
function linesWord(n: number): string {
  return tr('server.ai.linesWord', { count: n })
}

/** Ждёт ли человек, пока его пустят к ядру. */
function waiting(attempt: OracleAttempt): boolean {
  return attempt.runRequest?.status === 'pending'
}

/**
 * Черновик, в который давно не дописали ни знака.
 *
 * Без `updatedAt` — не молчит: время правки необязательное, и считать «нет
 * времени» за «давно не трогали» значило бы объявить застрявшим весь класс на
 * первом же кадре без этого поля.
 */
function silent(attempt: OracleAttempt, now: number): boolean {
  if (attempt.submittedAt !== null || attempt.updatedAt === undefined) return false
  return now - attempt.updatedAt > SILENCE_MS
}

/* ----------------------------------------------------------------- кадр */

/** Кадр для модели: что уехало и кого она под каким именем (или меткой) видела. */
export interface ClassFrame {
  turns: ChatTurn[]
  /**
   * ПОДПИСЬ В КАДРЕ → participantId. Ключ — либо метка `S7`, либо имя ровно
   * так, как оно уехало модели («Анна Иванова», «Анна Иванова (2)»).
   *
   * Одно поле на оба случая, и это не мелочь: пульт подсвечивает в ответе
   * ключи этого словаря и больше ничего, так что ему не нужно ни знать, какой
   * сейчас режим, ни второй раз выводить те же подписи по составу комнаты —
   * а два вывода одного правила однажды разошлись бы на тёзках.
   */
  people: Record<string, string>
  /** На каком классе отвечали — эта пара стоит под ответом в ленте. */
  basedOn: { submitted: number; drafts: number }
  /** Сколько знаков уехало модели — одно число в журнале приёма. */
  chars: number
}

/** Как в кадре зовут людей: настоящими именами или метками S1…SN. */
export interface FrameNaming {
  /** `true` — имена; `false` — метки. Умолчание берётся из настроек инстанса. */
  names: boolean
}

function systemFrame(names: boolean, effort: ReasoningEffort | undefined): string {
  const lines = [
    'Ты помогаешь преподавателю вести занятие: он спрашивает, как идут дела у класса',
    'и что делать с решениями.',
    'Тебе дано задание, числа по классу, строки по людям и их код.',
    '',
  ]
  if (names) {
    lines.push(
      'Людей зовут ИМЕНАМИ — ровно теми, что стоят в кадре. Ссылайся на них по имени',
      'и пиши имя ТОЧНО так, как оно написано здесь, без склонений в самой ссылке',
      '(«у Анны Белой падает запуск», а не «у Белой А.»): по этим именам преподаватель',
      'открывает работу нажатием. Людей, которых в кадре нет, не выдумывай.',
    )
  } else {
    lines.push(
      'Людей зовут метками S1…SN, и других имён у них нет — не выдумывай их и не',
      'придумывай новых меток. Метки перечисляй через запятую (S6, S7, S8) и никогда',
      // Диапазон «S6–S10» пульт подменяет двумя именами с тире посередине, и
      // фраза читается как чужая фамилия: «Александр Яковлев–Александр».
      'не пиши их диапазоном вида S6–S10: преподаватель видит на месте метки имя.',
    )
  }
  lines.push(
    '',
    'Отвечай КОРОТКО и по делу, обычной прозой: преподаватель читает ответ прямо',
    'на паре, стоя у доски. Два-три предложения, если хватает; без JSON, без',
    'заголовков и без длинных списков. Если в данных ответа на вопрос нет — так и',
    'скажи одной строкой, не догадываясь.',
  )
  const note = effortNote(effort)
  if (note) lines.push('', note)
  return lines.join('\n') + '\n' + tr('server.ai.answerLanguage')
}

/** Строка одного человека и его место в очереди на внимание. */
interface Row {
  label: string
  attempt: OracleAttempt
  /** 0 — похоже, нужна помощь; 1 — молчит; 2 — просто работает. */
  rank: number
  line: string
}

function rowOf(label: string, attempt: OracleAttempt, now: number): Row {
  const status = statusOf(attempt)
  const stuck = status === 'failed'
  const quiet = silent(attempt, now)
  const bits = [
    label,
    attempt.submittedAt === null ? 'пишет' : `сдал ${hhmm(attempt.submittedAt)}`,
    sheetStatus(attempt),
  ]
  if (waiting(attempt)) bits.push('ждёт разрешения на запуск')
  const lines = attempt.text.trim() ? attempt.text.split('\n').length : 0
  bits.push(lines === 0 ? 'лист пуст' : `${lines} ${linesWord(lines)}`)
  if (attempt.updatedAt !== undefined) bits.push(`правка ${ago(now - attempt.updatedAt)}`)
  return { label, attempt, rank: stuck ? 0 : quiet ? 1 : 2, line: bits.join(' · ') }
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
 * Имена, которыми в кадре зовут людей.
 *
 * С включённой настройкой — настоящее имя; человек без имени (участника уже
 * нет в базе, строка битая) всё равно получает метку, иначе строка кадра
 * начиналась бы с пустоты. С выключенной — только метки.
 *
 * Метки раздаются по participantId, а не по времени сдачи или правки. И то и
 * другое живое: сосед сдал, передумал, дописал запятую — и S7 в следующем
 * вопросе оказался бы другим человеком.
 *
 * Одинаковые имена — обычное дело в классе на сто человек, и две «Анны
 * Ивановы» в кадре сделали бы ответ неразрешимым: обеим дописывается номер
 * («Анна Иванова (2)»), и по нему же пульт находит нужную работу.
 */
function namesFor(
  attempts: readonly OracleAttempt[],
  names: boolean,
): { label: Map<string, string>; people: Record<string, string> } {
  const ordered = [...attempts].sort((a, b) => a.participantId.localeCompare(b.participantId))
  const label = new Map<string, string>()
  const people: Record<string, string> = {}
  const seen = new Map<string, number>()
  for (const [at, attempt] of ordered.entries()) {
    const own = names ? (attempt.name ?? '').trim() : ''
    let mark = `S${at + 1}`
    if (own) {
      const times = (seen.get(own) ?? 0) + 1
      seen.set(own, times)
      mark = times === 1 ? own : `${own} (${times})`
    }
    label.set(attempt.participantId, mark)
    people[mark] = attempt.participantId
  }
  return { label, people }
}

/**
 * Кадр для модели — один на все вопросы.
 *
 * `now` — параметром, а не `Date.now()` внутри: «тишина» и «правка 3 мин назад»
 * считаются от него, и тест, у которого время подставное, проверяет настоящие
 * числа, а не то, что успело пройти между двумя строками.
 *
 * Бюджет — `contextChars` инстанса. Тратится по порядку: сначала системный
 * кадр, задание и числа (они едут всегда — кадр без них не кадр), потом строки
 * по людям (не больше половины оставшегося), потом код листов: сперва у кого
 * что-то случилось, потом остальные сданные. Хвост и там, и там сворачивается
 * в счёт: модель должна знать, что за кадром есть ещё класс, иначе «у всех
 * остальных всё хорошо» она скажет, не имея на это права.
 *
 * ГОЛОВА КАДРА СЧИТАЕТСЯ В БЮДЖЕТ. Раньше не считалась вовсе: задание на
 * четыре тысячи знаков уезжало сверх потолка, и преподаватель, опустивший
 * contextChars под маленькую модель, получал запрос вдвое больше названного.
 */
export function oraclePrompt(
  task: OracleTask,
  attempts: readonly OracleAttempt[],
  question: string,
  options: {
    now?: number
    budget?: number
    names?: boolean
    effort?: ReasoningEffort
  } = {},
): ClassFrame {
  const settings = getOracleSettings()
  const now = options.now ?? Date.now()
  const budget = options.budget ?? settings.contextChars
  const names = options.names ?? settings.sendNames
  const system = systemFrame(names, options.effort)

  const { label, people: who } = namesFor(attempts, names)
  const sum = tally(attempts, now)

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

  const rows = attempts
    .map((attempt) => rowOf(label.get(attempt.participantId) ?? attempt.participantId, attempt, now))
    // Сначала те, кому вероятнее нужна помощь: упал, молчит, всё остальное.
    // Внутри разряда — по подписи, чтобы два одинаковых кадра совпали.
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, 'ru', { numeric: true }))

  let used = system.length + head.join('\n').length + question.length

  const roster: string[] = []
  if (rows.length > 0) {
    const title = names
      ? 'ПО ЛЮДЯМ:'
      : 'ПО ЛЮДЯМ (метки S — других имён у этих людей нет):'
    roster.push(title)
    used += title.length + 1
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
  }

  /*
   * Код — вторым заходом, и поимённо. Групп больше нет: одинаковые решения
   * едут как есть, каждое со своим именем, потому что преподаватель спрашивает
   * не «что в группе G2», а «что у Пети».
   *
   * Порядок — тот же, что у строк: сперва упавшие и молчащие (о них и
   * спрашивают), потом остальные сданные. Черновики без происшествий кодом не
   * едут вовсе: полторы строки начатого листа стоят места, на котором иначе
   * поместится чья-то настоящая ошибка, а сам факт «пишет, 3 строки» уже стоит
   * в строке человека.
   */
  const code: string[] = []
  const worth = rows.filter(
    (row) => row.attempt.text.trim().length > 0 && (row.rank < 2 || row.attempt.submittedAt !== null),
  )
  if (worth.length > 0) {
    const title = 'РЕШЕНИЯ ПОИМЁННО:'
    code.push(title)
    used += title.length + 1
    let hidden = 0
    for (const row of worth) {
      const block = [
        `### ${row.label} — ${row.line.slice(row.label.length + 3)}`,
        '```python',
        clip(row.attempt.text.trim(), MAX_SHEET_SOURCE),
        '```',
      ].join('\n')
      if (used + block.length > budget) {
        hidden += 1
        continue
      }
      code.push(block)
      used += block.length + 2
    }
    if (hidden > 0) code.push(`Ещё ${hidden} ${listsWord(hidden)} в кадр не поместились.`)
    code.push('')
  }

  const body = [...head, ...roster, ...code, 'ВОПРОС ПРЕПОДАВАТЕЛЯ:', question].join('\n')
  const turns: ChatTurn[] = [
    { role: 'system', content: system },
    { role: 'user', content: body },
  ]
  return {
    turns,
    people: who,
    basedOn: { submitted: sum.submitted, drafts: sum.drafts },
    chars: system.length + body.length,
  }
}

/** «1 лист», «3 листа», «5 листов» — счёт свёрнутого хвоста. */
function listsWord(n: number): string {
  return tr('server.council.sheetsWord', { count: n })
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
    error: null,
    answers: [],
    pending: null,
  }
}

/**
 * Прочитанный из базы оракул, приведённый к сегодняшнему кадру.
 *
 * Строки `council_oracle` пишутся JSON-ом и переживают обновление сервера:
 * записанные прошлой версией несут поля, которых больше нет (`summary`,
 * `groupLabels`, `drafts`), и не несут тех, что появились. Здесь строка
 * приводится к нынешней форме — иначе читатель, положившийся на наличие поля,
 * уронил бы пульт на первом же занятии, начатом вчера. Здесь же держится и
 * потолок ленты.
 */
export function normalizeOracle(oracle: CouncilOracle): CouncilOracle {
  const answers = Array.isArray(oracle.answers) ? oracle.answers.slice(-MAX_ORACLE_ANSWERS) : []
  return {
    state: oracle.state ?? 'idle',
    askedAt: oracle.askedAt ?? null,
    basedOn: oracle.basedOn ?? 0,
    error: oracle.error ?? null,
    answers,
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

/**
 * Ключ — `${sessionId}:${cellId}`; запись есть только пока модель читает.
 *
 * У записи ДВА замка. Первый — `.finally()` того же обещания, который снимает
 * её, чем бы чтение ни кончилось. Второй — срок: если обещание не разрешилось
 * вовсе (а именно это и случилось 20.09), запись снимается по таймеру, и
 * ячейка не остаётся запертой на 409 до перезапуска сервера. Один замок здесь
 * уже был, и его не хватило.
 */
interface Reading {
  controller: AbortController
  /** Второй замок: снимает запись, даже если обещание не разрешилось. */
  latch: NodeJS.Timeout
}

const reading = new Map<string, Reading>()

/**
 * Запас поверх потолка запроса: сторож обрывает на 180 с, разрешение обещания
 * и запись состояния стоят ещё доли секунды. Полминуты — с избытком, и это
 * аварийный путь, а не рабочий.
 */
const LATCH_GRACE_MS = 30_000

function forget(key: string, entry: Reading): void {
  if (reading.get(key) !== entry) return
  clearTimeout(entry.latch)
  reading.delete(key)
}

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
  /** Вопрос преподавателя. Пусто — маршрут подставляет свою заготовку. */
  question: string
  /** Уровень размышлений на этот запрос; пусто — умолчание инстанса. */
  effort?: ReasoningEffort
  /**
   * Сроки сторожа. Маршрут их не передаёт — у него `COUNCIL_WATCH`; подставляет
   * их тест, и другого способа нет: проверка «замолчавший провайдер кончается
   * понятной ошибкой» по настоящим срокам стоила бы трёх минут ожидания на
   * каждый прогон, то есть её бы не было вовсе.
   */
  times?: WatchTimes
}

/**
 * Спросить. Возвращает состояние «читает» сразу — 202 отдаётся им; ответ
 * приезжает потом через `onCouncilOracle`.
 */
export function askCouncilOracle(input: AskCouncilOracle): CouncilOracle {
  const { sessionId, cellId, store } = input
  const key = `${sessionId}:${cellId}`
  const previous = normalizeOracle(store.oracleOf(sessionId, cellId) ?? idleOracle())
  const question = input.question.trim()
  const now = Date.now()
  const submitted = input.attempts.filter((one) => one.submittedAt !== null).length
  const started: CouncilOracle = {
    ...previous,
    state: 'reading',
    askedAt: now,
    basedOn: submitted,
    error: null,
    pending: { question, askedAt: now },
  }
  store.setOracle(sessionId, cellId, started)
  announce(sessionId, cellId, started)

  const controller = new AbortController()
  const entry: Reading = {
    controller,
    latch: setTimeout(() => {
      // Сюда попадают только застрявшие: обычное чтение снимает запись раньше.
      if (reading.get(key) !== entry) return
      reading.delete(key)
      console.warn(`[session ${sessionId}] council oracle: stuck reading on ${cellId}, freed by latch`)
      controller.abort()
      settleStuck(input, previous)
    }, ((input.times ?? COUNCIL_WATCH).capMs ?? 180_000) + LATCH_GRACE_MS),
  }
  entry.latch.unref?.()
  reading.set(key, entry)
  void read(input, previous, question, controller).finally(() => forget(key, entry))
  return started
}

/** Ячейка, застрявшая в «читает», — привести в порядок и сказать об этом пульту. */
function settleStuck(input: AskCouncilOracle, previous: CouncilOracle): void {
  const current = input.store.oracleOf(input.sessionId, input.cellId)
  if (!current || current.state !== 'reading') return
  const settled = failedOracle(
    normalizeOracle(current),
    previous,
    tr('server.theOracleDidNotRespondCheckThe.e430c5'),
  )
  input.store.setOracle(input.sessionId, input.cellId, settled)
  announce(input.sessionId, input.cellId, settled)
}

/**
 * Отказ — в ЛЕНТУ, а не только красной плашкой.
 *
 * Вопрос преподавателя при отказе не исчезает: ход остаётся на месте с
 * причиной вместо ответа. Пока его не было, «Обновить сводку», кончившееся
 * ничем, стирало и сам вопрос — повторить было нечего, а понять, на что не
 * ответили, невозможно.
 */
function failedOracle(current: CouncilOracle, previous: CouncilOracle, reason: string): CouncilOracle {
  const asked = current.pending ?? previous.pending
  const answers = asked
    ? [
        ...current.answers,
        {
          id: randomUUID(),
          question: asked.question,
          text: '',
          failed: reason,
          askedAt: asked.askedAt,
          basedOn: { submitted: current.basedOn, drafts: 0 },
          people: {},
        } satisfies CouncilOracleAnswer,
      ].slice(-MAX_ORACLE_ANSWERS)
    : current.answers
  return {
    ...current,
    state: answers.length > 0 ? 'ready' : 'idle',
    error: reason,
    pending: null,
    answers,
  }
}

async function read(
  input: AskCouncilOracle,
  previous: CouncilOracle,
  question: string,
  controller: AbortController,
): Promise<void> {
  const { sessionId, cellId, store } = input
  const began = Date.now()
  const settle = (oracle: CouncilOracle) => {
    store.setOracle(sessionId, cellId, oracle)
    announce(sessionId, cellId, oracle)
  }
  /** Текущее состояние, а не то, что было на входе: ленту мог дополнить сосед. */
  const nowState = () => normalizeOracle(store.oracleOf(sessionId, cellId) ?? previous)

  /*
   * Потраченный впустую вопрос не должен съедать часовой лимит комнаты.
   *
   * Строка расхода заводится при ПРИЁМЕ (маршрут), потому что запрос к
   * провайдеру уйдёт, чем бы он ни кончился. Но «Обновить», повисшее на три
   * минуты и кончившееся отказом, — это не вопрос, а потерянное время, и
   * платить за него местом в часовом потолке несправедливо вдвойне: именно
   * тогда преподаватель и жмёт кнопку ещё раз. Снимается строка, только если
   * провайдер ни одного токена не назвал; назвал — значит деньги ушли, и
   * счёт остаётся (admin/usage.ts · dropQuestion).
   */
  const wasted = () => {
    if (input.usageId !== undefined) dropQuestion(input.usageId)
  }

  const spend = (tokens: number) => {
    if (input.usageId !== undefined) noteTokens(input.usageId, tokens)
  }

  const guard = watchSilence(controller, input.times ?? COUNCIL_WATCH)
  try {
    const settings = getOracleSettings()
    const frame = oraclePrompt(input.task, input.attempts, question, { effort: input.effort })
    console.log(
      `[session ${sessionId}] council oracle: cell ${cellId}, ` +
        `${input.attempts.length} sheets, ${frame.chars} chars, ` +
        `effort ${input.effort ?? settings.reasoningEffort}, ` +
        `names ${settings.sendNames ? 'on' : 'off'}`,
    )
    const text = await streamChat(
      frame.turns,
      () => guard.heard(),
      controller.signal,
      spend,
      input.effort,
    )
    if (controller.signal.aborted) {
      /*
       * Три исхода одной отмены, и разводятся они словами.
       *
       * «Не открыл поток» — правда только до первого кадра: лечится это
       * меньшим contextChars, и говорит об этом фраза про отведённое время.
       * «Замолчал на середине» — уже разговор с эндпоинтом, и там совет
       * «повторите» уместен. «Нажали Стоп» — вообще не отказ.
       */
      const why =
        guard.why === null
          ? null
          : guard.spoke
            ? tr('server.theModelStoppedSendingItsResponseTry.3aa75a')
            : tr('server.theModelDidNotRespondWithinThe.be1746')
      console.warn(
        `[session ${sessionId}] council oracle: ${guard.why ?? 'stopped by teacher'} ` +
          `after ${Date.now() - began} ms`,
      )
      wasted()
      settle(why === null ? stoppedOracle(nowState()) : failedOracle(nowState(), previous, why))
      return
    }
    if (!text.trim()) {
      wasted()
      settle(
        failedOracle(nowState(), previous, tr('server.theModelReturnedAnEmptyResponseTry.c365b1')),
      )
      return
    }
    const answer: CouncilOracleAnswer = {
      id: randomUUID(),
      question,
      text: text.trim(),
      failed: null,
      askedAt: Date.now(),
      basedOn: frame.basedOn,
      people: frame.people,
    }
    const current = nowState()
    settle({
      ...current,
      state: 'ready',
      error: null,
      pending: null,
      answers: [...current.answers, answer].slice(-MAX_ORACLE_ANSWERS),
    })
    console.log(
      `[session ${sessionId}] council oracle: ready in ${Date.now() - began} ms, ` +
        `${answer.text.length} chars`,
    )
  } catch (err) {
    if (controller.signal.aborted && guard.why === null) {
      settle(stoppedOracle(nowState()))
      wasted()
      return
    }
    const reason = err instanceof Error ? err.message.trim() : String(err)
    console.error(
      `[session ${sessionId}] council oracle: failed after ${Date.now() - began} ms — ${reason}`,
    )
    wasted()
    settle(
      failedOracle(
        nowState(),
        previous,
        reason || tr('server.theOracleDidNotRespondCheckThe.e430c5'),
      ),
    )
  } finally {
    guard.stop()
  }
}

/**
 * «Стоп» — не отказ: ход просто уходит из ленты вместе с ожиданием.
 *
 * Ошибку не ставим и прежнюю снимаем: красная плашка после собственного
 * нажатия читается как поломка.
 */
function stoppedOracle(current: CouncilOracle): CouncilOracle {
  return {
    ...current,
    state: current.answers.length > 0 ? 'ready' : 'idle',
    error: null,
    pending: null,
  }
}

/**
 * «Стоп»: оборвать чтение. Возвращает `true`, если было что обрывать.
 *
 * И приводит состояние в порядок, даже когда обрывать нечего. Это второй замок
 * на ту же дверь, что и срок у записи: ячейка, застрявшая в `reading` без
 * живого чтения, отвечала 409 на каждый следующий вопрос — то есть «Стоп»
 * переставал работать ровно тогда, когда он и нужен.
 */
export function stopCouncilOracle(sessionId: string, cellId: string, store?: OracleStore): boolean {
  const key = `${sessionId}:${cellId}`
  const entry = reading.get(key)
  if (entry) {
    entry.controller.abort()
    // Запись снимет `.finally()` чтения; латч — на случай, если не снимет.
  }
  if (store) {
    const current = store.oracleOf(sessionId, cellId)
    if (current && current.state === 'reading' && !entry) {
      const settled = stoppedOracle(normalizeOracle(current))
      store.setOracle(sessionId, cellId, settled)
      announce(sessionId, cellId, settled)
    }
  }
  return entry !== undefined
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
  for (const [key, entry] of reading) {
    if (!key.startsWith(prefix)) continue
    entry.controller.abort()
    clearTimeout(entry.latch)
    reading.delete(key)
    stopped += 1
  }
  return stopped
}
