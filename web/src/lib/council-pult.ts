/**
 * Мессенджер пульта консилиума — вся его арифметика, без Svelte и без сокета.
 *
 * Пульт живёт в отдельном окне (components/council/pult) и показывает список
 * людей слева, открытую работу справа. Здесь лежит то, что решает, ЧТО стоит в
 * списке и в каком порядке: сборка строк, фильтры, непрочитанное, придержанные
 * сдачи, ходы курсора и перечень ячеек, между которыми окно переключается.
 *
 * ГРУППИРОВКИ ЗДЕСЬ БОЛЬШЕ НЕТ. Одинаковые ответы сворачивались в одну строку с
 * хвостом «ещё N с тем же ответом», у работы стояло «группа 2 из 6», а письмо
 * уходило «всем N». 20.09 владелец попросил убрать это целиком, и убрано оно
 * целиком: список пульта — лента сдач, и человека в ней ищут по имени, а не по
 * тому, на кого он похож. Какие бывают ответы — вопрос стопки и оракула.
 *
 * Отдельным модулем по тем же доводам, что и council-board.ts: стопку и полосу
 * групп там считает не компонент, и эти правила тоже проверяются без браузера
 * (tests/council-pult.test.mts). Сложенное в разметке складывается по-разному
 * на каждой ветке `{#if}`, а список, в котором курсор ходит не туда, куда
 * смотрят глаза, — это нажатие Enter не на том человеке перед всем залом.
 *
 * ПОРЯДОК ЗДЕСЬ ДРУГОЙ, ЧЕМ В СТОПКЕ. `stackOrder` (council-board.ts) ставит
 * первыми представителей больших групп: карточка листается «по решениям».
 * Мессенджер — это лента сдач, и порядок в нём по времени сдачи, сверху
 * свежие: человек, нажавший «Сдать» минуту назад, обязан быть виден без
 * прокрутки. Два разных порядка — не небрежность: два разных вопроса («какие
 * бывают ответы» против «кто только что сдал»).
 *
 * С 20.09 список — ТРИ ВКЛАДКИ: «Сдали · Пишут · Все» (Paper 05d, артборды 11
 * и 12). У сдавших и пишущих разные вопросы, разные чипы отбора и разный
 * порядок: лента сдач у первых и список тревог у вторых («молчат, упало, просят
 * запуск, остальные» — `byAlarm`). Третий порядок в одном файле выглядит
 * расточительством ровно до той минуты, когда в классе тридцать человек и
 * половина из них ещё пишет: «кто застрял» — это не «кто правил последним».
 */
import { formatNumber, tr } from '@shared/i18n'
import {
  COUNCIL_RERUN_PAUSES,
  COUNCIL_RUN_LIMITS,
  COUNCIL_SILENCE_MS,
  type CellLock,
  type CouncilSettings,
} from '@shared/notebook'
import type {
  CouncilAttempt,
  CouncilBoard,
  CouncilKernel,
  CouncilStatus,
} from '@shared/protocol'

export type PultPresence = 'online' | 'offline' | 'unknown'

/** Saved work is independent of the live room roster. Lost connection makes it unknown. */
export function pultPresence(connected: boolean, people: ReadonlyMap<string, unknown>, id: string): PultPresence {
  if (!connected) return 'unknown'
  return people.has(id) ? 'online' : 'offline'
}

export type PultTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'accent'
export interface PultBadge {
  label: string
  tone: PultTone
  /** Знак перед словом, когда тон о состоянии не договаривает. См. attemptExecution. */
  icon?: string
  /**
   * Форма плашки — второй признак поверх цвета.
   *
   * Заливка означает «от вас ждут действия»: сдано и не оценено. Контур —
   * «состояние, которое само пройдёт»: человек ещё пишет. Тон между ними тоже
   * разный, но одним цветом такие вещи не различают: на проекторе, на чужом
   * мониторе и у того, кто цвета не различает, остаётся форма и слово.
   */
  shape?: 'fill' | 'outline'
}
export type PultView = 'work' | 'queue' | 'oracle'

/**
 * Evaluation and execution are separate facts: running code successfully is not a grade.
 *
 * Сданная и НЕ оценённая — залитая плашка акцентом: 19.09 преподаватель вёл
 * пару и не видел в списке, кого он уже посмотрел, а кого нет («лучше помечать
 * сданные работы в пульте, а то нихуя не видно»). Бледная «Не проверено» в
 * общем сером ряду не отличалась ни от черновика, ни от оценённого.
 */
export function attemptReview(attempt: Pick<CouncilAttempt, 'submittedAt' | 'correct'>): PultBadge {
  if (attempt.submittedAt === null) return { label: tr('room.pult.v2.review.draft'), tone: 'neutral', shape: 'outline' }
  if (attempt.correct === true) return { label: tr('room.pult.v2.review.correct'), tone: 'positive' }
  if (attempt.correct === false) return { label: tr('room.pult.v2.review.wrong'), tone: 'warning' }
  return { label: tr('room.pult.v3.review.waiting'), tone: 'accent', shape: 'fill' }
}

export function attemptExecution(attempt: {
  run: Pick<NonNullable<CouncilAttempt['run']>, 'state' | 'timedOut'> | null
  runRequest?: Pick<NonNullable<CouncilAttempt['runRequest']>, 'status'> | null
}): PultBadge {
  /*
   * Остановленный пределом запуск — не «ошибка запуска».
   *
   * `state` у него тот же `error`, и общим словом он встал бы в один ряд с
   * TypeError, то есть человек шёл бы читать вывод и искать в нём опечатку. А
   * править тут нечего: код, возможно, верный, ему не хватило секунд, и
   * решение принимает преподаватель — поднять предел или прервать соседа.
   * Поэтому у остановленного своё слово и свой знак часов.
   */
  const limit = timedOutLimit(attempt)
  if (limit !== null) {
    return { label: tr('room.pult.v2.execution.timedOut', { duration: pultDuration(limit) }), tone: 'danger', icon: '◷' }
  }
  switch (attempt.run?.state) {
    case 'running': return { label: tr('room.pult.v2.execution.running'), tone: 'accent' }
    case 'queued': return { label: tr('room.pult.v2.execution.queued'), tone: 'accent' }
    case 'error': return { label: tr('room.pult.v2.execution.error'), tone: 'danger' }
  }
  if (attempt.runRequest?.status === 'pending') return { label: tr('room.pult.v2.execution.request'), tone: 'warning' }
  if (attempt.run?.state === 'ok') return { label: tr('room.pult.v2.execution.ok'), tone: 'positive' }
  return { label: tr('room.pult.v2.execution.none'), tone: 'neutral' }
}

/* ------------------------------------------------------- время запуска */

/**
 * Час и минута — и секунды там, где по ним сопоставляют.
 *
 * Своя, а не `clock()` из lib/history: тот модуль ради двух строк тянет за
 * собой `./api` с сетью и токенами, а этот файл читается ещё и из тестов без
 * браузера. Правило форматирования то же самое, до знака.
 *
 * Секунды нужны в открытой работе и в очереди: «запущен в 17:24:05» — это то,
 * чем преподаватель сличает свой запуск с чужим, когда за минуту их три, и
 * «17:24» у всех трёх не отвечает ни на один вопрос.
 */
export function pultClock(at: number, seconds = false): string {
  const date = new Date(at)
  const two = (value: number): string => String(value).padStart(2, '0')
  const hhmm = `${two(date.getHours())}:${two(date.getMinutes())}`
  return seconds ? `${hhmm}:${two(date.getSeconds())}` : hhmm
}

/**
 * Сколько считал законченный запуск.
 *
 * До десяти секунд — с десятой долей: почти все запуски консилиума короткие, и
 * `spell()` округляет их в «0 с» и «1 с», то есть в одно и то же число для
 * всего класса. Дальше десятой доли никто не сравнивает, и там идёт общий
 * `pultDuration` — тот же, каким названы пределы регламента.
 */
export function pultRanFor(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 10_000) {
    return tr('room.pult.v2.rules.sec', {
      count: formatNumber(safe / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    })
  }
  return pultDuration(safe / 1000)
}

/**
 * Строка запуска целиком: что случилось, сколько считалось и КОГДА.
 *
 * Час запуска — прямая просьба с пары 19.09: «в пульте консилиума показывать
 * время запуска». Без него «Запуск выполнен» не отличает попытку, запущенную
 * пять минут назад, от запущенной только что, а решают по ним разное: первую
 * пора показывать классу, вторая ещё не досчитала соседей.
 *
 * Слово и тон берутся у `attemptExecution` — одно место, где состояние
 * становится словом, — и к ним прибавляются длительность и время. Не
 * запускали вовсе и просит запуск — там времени нет, и строка остаётся
 * прежней: выдуманного часа быть не должно.
 */
export function attemptRunLine(
  attempt: {
    run: Pick<NonNullable<CouncilAttempt['run']>, 'state' | 'timedOut' | 'startedAt' | 'ranMs'> | null
    runRequest?: Pick<NonNullable<CouncilAttempt['runRequest']>, 'status'> | null
  },
  now: number,
): PultBadge {
  const base = attemptExecution(attempt)
  const run = attempt.run
  if (!run) return base
  const time = pultClock(run.startedAt)
  const limit = timedOutLimit(attempt)
  if (limit !== null) {
    return { ...base, label: tr('room.pult.v3.runStopped', { limit: pultDuration(limit), time }) }
  }
  switch (run.state) {
    case 'running':
      // Живой счётчик — целыми секундами: десятая доля у числа, которое
      // меняется каждую секунду, читается как мерцание, а не как измерение.
      return { ...base, label: tr('room.pult.v3.runRunning', { duration: pultDuration(Math.max(now - run.startedAt, 0) / 1000) }) }
    case 'queued':
      return { ...base, label: tr('room.pult.v3.runQueued', { time }) }
    case 'error':
      return {
        ...base,
        label: run.ranMs === null
          ? tr('room.pult.v3.runFailedAt', { time })
          : tr('room.pult.v3.runFailed', { duration: pultRanFor(run.ranMs), time }),
      }
    case 'ok':
      return {
        ...base,
        label: run.ranMs === null
          ? tr('room.pult.v3.runDoneAt', { time })
          : tr('room.pult.v3.runDone', { duration: pultRanFor(run.ranMs), time }),
      }
  }
  return base
}

export function pultShortcutAllowed(action: PultAction, view: PultView, navigation: boolean, overlay = false): boolean {
  if (overlay || action === null) return false
  // Регламент — правило ЯЧЕЙКИ, а не открытой работы: из очереди и от оракула
  // к нему тянутся так же часто, как из списка, и «сначала вернись в работы»
  // было бы ответом ни на что. Соседняя ячейка — тем же доводом: пульт один на
  // комнату, и переключают его в том числе стоя в очереди.
  if (
    action === 'help' ||
    action === 'escape' ||
    action === 'search' ||
    action === 'rules' ||
    action === 'nextCell' ||
    action === 'prevCell'
  ) {
    return true
  }
  return view === 'work' && !navigation
}

/**
 * С какого числа одинаковых ответов счёт группы вообще о чём-то говорит.
 *
 * Список пульта им больше не пользуется: группировку из пульта убрали целиком
 * (20.09). Порог остаётся ОДНИМ местом, где это число названо, — его читает
 * стопка и оракул, которому «двое написали одно и то же» не повод собирать
 * группу. Переписать его в двух местах по-разному дешевле всего именно тогда,
 * когда одно из них выглядит как ничей остаток.
 */
export const GROUP_MIN = 3

/* ------------------------------------------------------ вкладки списка */

/**
 * Две стопки — две вкладки, и третья для тех, кто привык.
 *
 * До 20.09 это был один список с двумя секциями и пятью чипами отбора поверх
 * него. На тридцати студентах «Пишут» уезжала за край, и туда не доходил
 * никто; чипы на ширине колонки переносились на вторую строку, отнимая у
 * списка ещё одну работу. Главное же — у половин РАЗНЫЕ вопросы: у сданных
 * спрашивают «что я ещё не оценил», у пишущих «кто застрял», и одним рядом
 * чипов на два вопроса не ответишь.
 *
 * «Все» осталась третьей и без изменений: это прежний единый список с двумя
 * секциями — для поиска по имени и для тех, кто читает класс целиком.
 */
export type PultTab = 'submitted' | 'writing' | 'all'
export const PULT_TABS: readonly PultTab[] = ['submitted', 'writing', 'all']

/**
 * Чипы отбора. У каждой вкладки свой набор — см. `tabFilters`.
 *
 * `unrun` («не запущены») в наборах больше нет: пятый чип не влезал во вкладку
 * «Сдали» в одну строку на узкой колонке (280 px при ширине окна 860), а
 * переносить ряд на вторую строку — это минус работа в списке. Само значение
 * осталось: по нему отбирают тесты и, если понадобится, шестой чип.
 */
export type PultFilter =
  | 'all'
  | 'new'
  | 'ungraded'
  | 'error'
  | 'unrun'
  | 'silent'
  | 'failed'
  | 'asking'

const TAB_FILTERS: Record<PultTab, readonly PultFilter[]> = {
  submitted: ['all', 'ungraded', 'new', 'error'],
  writing: ['all', 'silent', 'failed', 'asking'],
  all: ['all', 'new'],
}

export function tabFilters(tab: PultTab): readonly PultFilter[] {
  return TAB_FILTERS[tab]
}

/** Отбор, переживший смену вкладки: чужой чип молча становится «Все». */
export function filterInTab(tab: PultTab, filter: PultFilter): PultFilter {
  return TAB_FILTERS[tab].includes(filter) ? filter : 'all'
}

/** Слово в чипе. Одно место, где фильтр становится словом. */
export function filterLabel(filter: PultFilter): string {
  switch (filter) {
    case 'new':
      return tr('room.pult.v3.tabs.new')
    case 'error':
      return tr('room.pult.v3.tabs.error')
    case 'unrun':
      return tr('room.pult.v3.tabs.unrun')
    case 'ungraded':
      return tr('room.pult.v3.tabs.ungraded')
    case 'silent':
      return tr('room.pult.v3.tabs.silent')
    case 'failed':
      return tr('room.pult.v3.tabs.failed')
    case 'asking':
      return tr('room.pult.v3.tabs.asking')
    default:
      return tr('room.pult.v3.tabs.all')
  }
}

/** Слово на вкладке. */
export function tabLabel(tab: PultTab): string {
  switch (tab) {
    case 'submitted':
      return tr('room.pult.v3.tabs.submitted')
    case 'writing':
      return tr('room.pult.v3.tabs.writing')
    default:
      return tr('room.pult.v3.tabs.all')
  }
}

/** Цвет чипа: красить стоит только то, что зовёт. */
export function filterTone(filter: PultFilter): PultTone | null {
  switch (filter) {
    case 'error':
    case 'failed':
      return 'danger'
    case 'silent':
      return 'warning'
    default:
      return null
  }
}

/**
 * Строка списка. Два вида, и только первый выбирается курсором: заголовок
 * секции — это не человек, а место в ленте, и Enter на нём означал бы
 * «показать классу» неизвестно чью работу.
 *
 * Видов было четыре: сюда же входили шапка группы и свёрнутый хвост «ещё N с
 * тем же ответом». Группировки в пульте больше нет — вся она ушла 20.09 по
 * одному слову владельца, и ушла целиком, а не спряталась за настройку: список
 * пульта — ЛЕНТА СДАЧ, и человек, сдавший минуту назад, обязан стоять в ней
 * сам по себе, а не под чужим хвостом.
 */
export type PultRow =
  | {
      kind: 'attempt'
      /** Ключ для `{#each}` и для курсора — он же participantId. */
      id: string
      attempt: CouncilAttempt
      unread: boolean
      /** Номер варианта при выключенных именах; с единицы. */
      variant: number
    }
  /**
   * Заголовок половины ленты: «Сдали · N» и «Пишут · N».
   *
   * Порядок в ленте и так ставит сданные первыми (bySubmissionDesc), но граница
   * между «уже сдал» и «ещё пишет» ничем не была отмечена, и в окне, где видно
   * две строки с половиной, её не существовало вовсе: список выглядел как один
   * ряд людей без отличий. Курсору строка не даётся.
   */
  | { kind: 'section'; id: string; section: 'submitted' | 'writing'; count: number }

export interface PultListInput {
  attempts: readonly CouncilAttempt[]
  /** Какая из трёх стопок открыта. */
  tab: PultTab
  filter: PultFilter
  /** Поиск по имени; при выключенных именах зовущий передаёт пустую строку. */
  search: string
  /** Кто сдал после того, как в список смотрели в последний раз. */
  unread: ReadonlySet<string>
  /** Придержанные сдачи: они есть в стопке, но в список ещё не впущены. */
  held: ReadonlySet<string>
  /** Часы окна: по ним считается молчание черновика. */
  now: number
}

/** Сдана — значит есть время сдачи; всё остальное — сохранённый черновик, независимо от присутствия. */
const isSubmitted = (attempt: CouncilAttempt): boolean => attempt.submittedAt !== null

/** Кого пускает вкладка. Отбор — вторым ситом, поверх этого. */
export function inTab(attempt: CouncilAttempt, tab: PultTab): boolean {
  if (tab === 'all') return true
  return tab === 'submitted' ? isSubmitted(attempt) : !isSubmitted(attempt)
}

/* ------------------------------------------------------------- тревога */

/**
 * Что происходит с ЧЕРНОВИКОМ — ровно одно слово на человека.
 *
 * Вкладка «Пишут» отвечает на один вопрос: кто застрял. Ответ у неё четырёх
 * видов, и каждая попытка получает ровно один — иначе чипы «Молчат 3 · Упало 2
 * · Просят запуск 2» считали бы одного человека дважды, и сумма не сходилась бы
 * с длиной списка.
 *
 * Порядок РАЗБОРА (здесь) и порядок ТРЕВОГИ (`ALARM_RANK`) — разные вещи, и
 * расходятся они намеренно. Разбирается первой просьба о запуске: человек,
 * нажавший «прошу запустить» минуту назад, не «молчит» — он ждёт нас, и
 * молчание его листа объясняется именно этим. А выше в списке стоит молчание:
 * просьбу видно из очереди и из полосы, а про застрявшего не скажет никто.
 */
export type DraftAlarm = 'silent' | 'failed' | 'asking' | 'writing'

export function draftAlarm(attempt: CouncilAttempt, now: number): DraftAlarm {
  if (attempt.runRequest?.status === 'pending') return 'asking'
  if (attempt.run?.state === 'error' || timedOutLimit(attempt) !== null) return 'failed'
  return now - attempt.updatedAt > COUNCIL_SILENCE_MS ? 'silent' : 'writing'
}

/** Порядок тревог в списке: молчат, упало, просят запуск, остальные. */
const ALARM_RANK: Record<DraftAlarm, number> = { silent: 0, failed: 1, asking: 2, writing: 3 }

/**
 * Строка состояния пишущего: одна, вместо плашки оценки и строки запуска.
 *
 * У черновика оценки нет, и плашка «Черновик» в каждой строке — это десять
 * одинаковых слов подряд. Здесь вместо неё то, что про этого человека правда
 * известно: сколько он молчит, чем кончился его запуск, сколько ждёт решения,
 * — и сколько строк он успел написать, потому что «пишет · 2 строки» и «пишет ·
 * 40 строк» просят разного.
 */
export function draftLine(attempt: CouncilAttempt, now: number): PultBadge {
  const alarm = draftAlarm(attempt, now)
  const lines = attempt.text === '' ? 0 : attempt.text.split('\n').length
  switch (alarm) {
    case 'silent':
      return {
        label: tr('room.pult.v3.draft.silent', {
          duration: pultIdle((now - attempt.updatedAt) / 1000),
          count: lines,
        }),
        tone: 'warning',
      }
    case 'failed': {
      const limit = timedOutLimit(attempt)
      if (limit !== null) {
        return {
          label: tr('room.pult.v2.execution.timedOut', { duration: pultDuration(limit) }),
          tone: 'danger',
        }
      }
      const error = attempt.run?.outputs.find((output) => output.kind === 'error')
      const name = error && error.kind === 'error' ? error.ename : ''
      return {
        label: name
          ? tr('room.pult.v3.draft.failedNamed', { error: name })
          : tr('room.pult.v3.draft.failed'),
        tone: 'danger',
      }
    }
    case 'asking':
      /*
       * Своя строка, а не заголовок карточки очереди («Просит запуск · ждёт
       * 40 с»): в строке списка соседние состояния набраны со строчной («молчит
       * 7 мин», «пишет · 14 строк»), и одна прописная посреди колонки читается
       * как заголовок, которым эта строка не является.
       */
      return {
        label: tr('room.pult.v3.draft.asking', {
          duration: pultDuration(Math.max(now - (attempt.runRequest?.requestedAt ?? now), 0) / 1000),
        }),
        tone: 'neutral',
      }
    default:
      return { label: tr('room.pult.v3.draft.writing', { count: lines }), tone: 'neutral' }
  }
}

/**
 * Порядок во вкладке «Пишут» — ПО ТРЕВОГЕ, а не по времени.
 *
 * Молчат, упало, просят запуск, остальные. Внутри трёх тревожных групп — кто
 * ждёт дольше, тот выше: «молчит 12 мин» важнее, чем «молчит 6 мин», и
 * просьба, поданная минуту назад, важнее поданной только что. Спокойные идут
 * по времени правки, свежие сверху: там вопрос другой — «кто сейчас работает».
 */
export function byAlarm(now: number) {
  const since = (attempt: CouncilAttempt, alarm: DraftAlarm): number => {
    if (alarm === 'asking') return attempt.runRequest?.requestedAt ?? attempt.updatedAt
    if (alarm === 'failed') return attempt.run?.startedAt ?? attempt.updatedAt
    return attempt.updatedAt
  }
  return (a: CouncilAttempt, b: CouncilAttempt): number => {
    const left = draftAlarm(a, now)
    const right = draftAlarm(b, now)
    const rank = ALARM_RANK[left] - ALARM_RANK[right]
    if (rank !== 0) return rank
    // Спокойные — свежими сверху; тревожные — теми, кто ждёт дольше всех.
    const order = left === 'writing' ? since(b, right) - since(a, left) : since(a, left) - since(b, right)
    return order || a.participantId.localeCompare(b.participantId)
  }
}

/**
 * Номера вариантов — по времени сдачи, с единицы, на всю ячейку.
 *
 * Тем же правилом, что у сервера на показе (protocol.ts · CouncilShown.variant):
 * при выключенных именах номер — единственная подпись человека, и в пульте он
 * обязан совпасть с тем, что видит зал. Пишущие получают номера в хвосте, по
 * id: номера у них ещё нет, а дырка в нумерации читалась бы как потерянный
 * человек.
 */
export function variantNumbers(attempts: readonly CouncilAttempt[]): Map<string, number> {
  const order = [...attempts].sort((a, b) => {
    const left = a.submittedAt
    const right = b.submittedAt
    if (left !== null && right !== null) return left - right || a.participantId.localeCompare(b.participantId)
    if (left !== null) return -1
    if (right !== null) return 1
    return a.participantId.localeCompare(b.participantId)
  })
  return new Map(order.map((attempt, index) => [attempt.participantId, index + 1]))
}

/** Сверху свежие: лента сдач, а не стопка решений. Пишущие — в конце, по id. */
export function bySubmissionDesc(a: CouncilAttempt, b: CouncilAttempt): number {
  const left = a.submittedAt
  const right = b.submittedAt
  if (left !== null && right !== null) return right - left || a.participantId.localeCompare(b.participantId)
  if (left !== null) return -1
  if (right !== null) return 1
  return a.participantId.localeCompare(b.participantId)
}

/** Подходит ли попытка под чип отбора. Поиск — отдельно: он по имени. */
export function matchesFilter(
  attempt: CouncilAttempt,
  filter: PultFilter,
  unread: ReadonlySet<string>,
  now: number = Date.now(),
): boolean {
  switch (filter) {
    case 'new':
      return unread.has(attempt.participantId)
    case 'ungraded':
      // «Без оценки» — про руку преподавателя, а не про запуск: сдано, а
      // отметки нет. Черновики сюда не попадают — их и не оценивают.
      return isSubmitted(attempt) && attempt.correct === null
    case 'error':
      // Остановленный пределом считается «с ошибкой» наравне с упавшим: чип
      // отбирает работы, которым запуск не удался, а не имена исключений.
      return attempt.run?.state === 'error' || timedOutLimit(attempt) !== null || attempt.correct === false
    case 'unrun':
      return attempt.run === null
    case 'silent':
      return !isSubmitted(attempt) && draftAlarm(attempt, now) === 'silent'
    case 'failed':
      return !isSubmitted(attempt) && draftAlarm(attempt, now) === 'failed'
    case 'asking':
      return !isSubmitted(attempt) && draftAlarm(attempt, now) === 'asking'
    default:
      return true
  }
}

/** Числа в чипах вкладки — по тому же ситу, каким чип и отбирает. */
export function filterCounts(
  attempts: readonly CouncilAttempt[],
  tab: PultTab,
  unread: ReadonlySet<string>,
  now: number,
): Record<PultFilter, number> {
  const counts = {
    all: 0,
    new: 0,
    ungraded: 0,
    error: 0,
    unrun: 0,
    silent: 0,
    failed: 0,
    asking: 0,
  } as Record<PultFilter, number>
  for (const attempt of attempts) {
    if (!inTab(attempt, tab)) continue
    for (const filter of TAB_FILTERS[tab]) {
      if (matchesFilter(attempt, filter, unread, now)) counts[filter] += 1
    }
  }
  return counts
}

/** Числа на самих вкладках: «Сдали 13 · Пишут 11 · Все 24». */
export function tabCounts(attempts: readonly CouncilAttempt[]): Record<PultTab, number> {
  const submitted = attempts.filter(isSubmitted).length
  return { submitted, writing: attempts.length - submitted, all: attempts.length }
}

/**
 * Строки списка — то, что рисует левая колонка.
 *
 * Одна строка на человека, сверху свежие. Ни свёртывания, ни шапок групп:
 * список пульта — лента сдач, и единственный вопрос, на который она отвечает,
 * — «кто только что сдал». Группировка одинаковых ответов жила здесь до 20.09
 * и убрана по прямой просьбе владельца: она прятала людей под чужим хвостом
 * («ещё N с тем же ответом»), а найти в списке конкретного человека — ровно то,
 * ради чего в него смотрят. Какие бывают ответы — вопрос стопки и оракула, и
 * задают его в другом месте.
 */
export function listRows(input: PultListInput): PultRow[] {
  const { attempts, tab, filter, search, unread, held, now } = input
  const variants = variantNumbers(attempts)
  const needle = search.trim().toLocaleLowerCase()

  const visible = attempts.filter(
    (attempt) =>
      inTab(attempt, tab) &&
      !held.has(attempt.participantId) &&
      matchesFilter(attempt, filter, unread, now) &&
      (needle === '' || attempt.name.toLocaleLowerCase().includes(needle)),
  )
  /*
   * Два порядка на три вкладки, и это не небрежность.
   *
   * «Сдали» и «Все» — лента сдач: свежие сверху, человек, нажавший «Сдать»
   * минуту назад, виден без прокрутки. «Пишут» — не лента, а список тревог:
   * там спрашивают «кто застрял», и время правки отвечает на этот вопрос
   * последним из всего, что о человеке известно.
   */
  const ordered = [...visible].sort(tab === 'writing' ? byAlarm(now) : bySubmissionDesc)

  const rows: PultRow[] = ordered.map((attempt) => ({
    kind: 'attempt',
    id: attempt.participantId,
    attempt,
    unread: unread.has(attempt.participantId),
    variant: variants.get(attempt.participantId) ?? 0,
  }))
  // Секции — только в «Все»: во вкладках половина ленты и так одна, и
  // заголовок «Сдали · 13» над тринадцатью сдавшими был бы подписью к себе.
  return withSections(rows, ordered, tab === 'all' && filter === 'all' && needle === '')
}

/**
 * Две секции — только в полном списке и только без поиска.
 *
 * Под отбором «с ошибкой» заголовок «Сдали · 5» говорил бы о числе, которого в
 * списке нет: отбор уже разрезал ленту по другому признаку, и второй разрез
 * поверх первого читается как ошибка счёта. Поиск — то же самое: в нём стоят
 * найденные, а не «все сдавшие».
 *
 * Счёт — по людям, а не по строкам: разойтись им теперь негде, но считать по
 * `ordered` дешевле и честнее, чем по собранным строкам, среди которых стоят
 * сами заголовки.
 */
function withSections(rows: PultRow[], ordered: readonly CouncilAttempt[], on: boolean): PultRow[] {
  if (!on) return rows
  const submitted = ordered.filter(isSubmitted).length
  const writing = ordered.length - submitted
  const out: PultRow[] = []
  let openedSubmitted = false
  let openedWriting = false
  for (const row of rows) {
    const draft = row.kind === 'attempt' && row.attempt.submittedAt === null
    if (!draft && !openedSubmitted && submitted > 0) {
      out.push({ kind: 'section', id: 'section:submitted', section: 'submitted', count: submitted })
      openedSubmitted = true
    }
    if (draft && !openedWriting && writing > 0) {
      out.push({ kind: 'section', id: 'section:writing', section: 'writing', count: writing })
      openedWriting = true
    }
    out.push(row)
  }
  return out
}

/** Только по людям: заголовок секции курсору не даётся. */
export function selectable(rows: readonly PultRow[]): string[] {
  return rows.filter((row) => row.kind === 'attempt').map((row) => row.id)
}

/* --------------------------------------------------- ячейки консилиума */

/**
 * Ячейка в списке выбора — всё, что о ней говорит строка меню.
 *
 * Пульт — ОДНО окно на комнату, и ячейку в нём выбирают, а не открывают
 * вторым окном: «будет круто иметь один общий пульт, в котором можно
 * перемещаться между ячейками». Номер ячейки в шапке стал дверью в этот
 * список, и список обязан отвечать на единственный вопрос, ради которого его
 * открывают: куда переключиться прямо сейчас.
 */
export interface PultCellRow {
  cellId: string
  /** Номер ячейки в своей тетради, с единицы; `null` — ячейки в документе нет. */
  index: number | null
  /**
   * Название задания — первая строка ячейки или заголовок над ней.
   *
   * Пустое — названия нет, и строка обходится номером. Правило целиком лежит в
   * `cellHeadline` / `markdownHeadline`: «ячейка 60» и «ячейка 65» в меню
   * неразличимы, а выбирают между ними по заданию, а не по числу.
   */
  title: string
  /** Имя тетради. Пустое, пока все ячейки из одной: подпись там ничего не решает. */
  book: string
  submitted: number
  total: number
  /** Сдано и не оценено — единственное, что просит руки преподавателя. */
  waiting: number
  /** Сколько человек просят разрешить запуск. */
  asking: number
  /** Сколько попыток этой ячейки стоит в очереди ядра. */
  queued: number
  /** В ядре прямо сейчас считается чья-то попытка этой ячейки. */
  running: boolean
  /** Чья-то работа по этой ячейке стоит на проекторе. */
  onScreen: boolean
  /**
   * Консилиум закрыт, а попытки остались.
   *
   * Такие ячейки из списка НЕ УХОДЯТ: сданное смотрят до конца занятия, и
   * ячейка, снятая с консилиума под открытым на ней пультом, обязана остаться
   * на месте — выкинуть человека из того, на что он смотрит, хуже, чем
   * признаться словом, что менять здесь больше нечего.
   */
  review: boolean
}

export interface PultCellFacts {
  cellId: string
  index: number | null
  /** Название задания — см. `cellHeadline`; пустое, если его не из чего вывести. */
  title?: string
  book: string
  lock: CellLock
  /** Числа стопки — запасной счёт, когда комнатный ещё не приехал. */
  counts: CouncilBoard['counts']
  /** «Сдали N из M» по всей комнате — те же числа, что под ячейкой в тетради. */
  room: { submitted: number; total: number } | null
  attempts: readonly CouncilAttempt[]
  onScreen: boolean
}

/**
 * Список ячеек для меню: порядок, числа и пометки.
 *
 * Порядок — по тетради и номеру, а не по приходу кадров: меню открывают,
 * чтобы найти известную ячейку, и «та, чья стопка приехала первой» — не тот
 * порядок, в котором её ищут.
 *
 * Имя тетради приезжает ВСЕГДА, а прячет его уже меню: номер уникален только
 * внутри тетради, и «ячейка 09» в семинаре и в лекции — две разные ячейки с
 * одной подписью (просьба с пары 20.09.2026). Когда тетрадь одна, меню
 * называет её один раз в шапке; когда их несколько — в каждой строке, потому
 * что иначе шапка обещала бы за весь список имя первой попавшейся.
 */
export function pultCells(facts: readonly PultCellFacts[]): PultCellRow[] {
  return [...facts]
    .sort(
      (a, b) =>
        a.book.localeCompare(b.book) ||
        // Ячейка, которой в документе нет, уходит в хвост: у неё нет места в
        // тетради, и вставлять её по нулю значило бы ставить первой.
        (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) ||
        a.cellId.localeCompare(b.cellId),
    )
    .map((fact) => ({
      cellId: fact.cellId,
      index: fact.index,
      title: fact.title ?? '',
      book: fact.book,
      submitted: fact.room?.submitted ?? fact.counts.submitted,
      total: fact.room?.total ?? fact.counts.attempts,
      /*
       * Счёт — по стопке, которая у преподавателя и так есть по КАЖДОЙ ячейке
       * (control.ts · councilWelcome). Сервер ради этих чисел не трогаем: он
       * везёт «сдали N из M» всей комнате, а «ждут оценки» и «просят запуск» —
       * это приватное знание пульта, и считать его приватно правильнее, чем
       * заводить ради него кадр.
       */
      waiting: fact.attempts.filter((one) => one.submittedAt !== null && one.correct === null).length,
      asking: fact.attempts.filter((one) => one.runRequest?.status === 'pending').length,
      queued: fact.attempts.filter((one) => one.run?.state === 'queued').length,
      running: fact.attempts.some((attempt) => attempt.run?.state === 'running'),
      onScreen: fact.onScreen,
      review: fact.lock !== 'council',
    }))
}

/**
 * Соседняя ячейка в том же порядке, в каком они стоят в меню.
 *
 * Клавиши `[` и `]` обязаны ходить ровно по нему: список открывают, чтобы
 * найти известную ячейку, и «следующая» — это следующая строка меню, а не
 * следующий пришедший кадр. На краях — `null`: заворачивать по кругу значит
 * увести пульт с первой ячейки на последнюю одним нажатием, не показав, что
 * произошло.
 */
export function neighbourCell(
  cells: readonly PultCellRow[],
  current: string,
  delta: 1 | -1,
): string | null {
  const at = cells.findIndex((cell) => cell.cellId === current)
  if (at < 0) return null
  const next = at + delta
  return next >= 0 && next < cells.length ? cells[next].cellId : null
}

/**
 * Сколько ДРУГИХ ячеек ждут оценки — подпись рядом с кнопкой выбора.
 *
 * Закрытые не считаются, и это не упрощение: строка такой ячейки в меню
 * говорит «консилиум закрыт · только просмотр» и чисел не показывает вовсе.
 * Позвать в неё подписью, которой в самом меню не соответствует ни одна
 * строка, значит отправить человека искать то, чего он там не увидит.
 */
export function othersWaiting(cells: readonly PultCellRow[], current: string): number {
  return cells.filter((cell) => cell.cellId !== current && !cell.review && cell.waiting > 0).length
}

/**
 * Строка внимания под названием ячейки: что в ней требует руки прямо сейчас.
 *
 * Не «сколько там всего», а «за чем туда идти». Закрытый консилиум говорит об
 * этом одним куском и вместо всего остального: там менять нечего, и «9 ждут
 * оценки» в закрытой ячейке звало бы туда, где ничего не изменить. Ячейка, в
 * которой всё разобрано, получает свою строку — пустое место читалось бы как
 * «строка не догрузилась».
 */
export interface CellNote {
  text: string
  tone: PultTone | 'faint'
  /** Плашка, а не слово: «на экране» — состояние зала, а не счёт. */
  chip?: boolean
}

export function cellNotes(cell: PultCellRow): CellNote[] {
  if (cell.review) return [{ text: tr('room.pult.v3.cells.closed'), tone: 'faint' }]
  const notes: CellNote[] = []
  if (cell.waiting > 0) {
    notes.push({ text: tr('room.pult.v3.cells.waiting', { count: cell.waiting }), tone: 'accent' })
  }
  if (cell.asking > 0) {
    notes.push({ text: tr('room.pult.v3.cells.asking', { count: cell.asking }), tone: 'warning' })
  }
  if (cell.running) {
    notes.push({
      text: cell.queued > 0
        ? `${tr('room.pult.v3.cells.running')} · ${tr('room.pult.v3.cells.queued', { count: cell.queued })}`
        : tr('room.pult.v3.cells.running'),
      tone: 'neutral',
    })
  } else if (cell.queued > 0) {
    notes.push({ text: tr('room.pult.v3.cells.queued', { count: cell.queued }), tone: 'neutral' })
  }
  if (cell.onScreen) notes.push({ text: tr('room.pult.v3.cells.onScreen'), tone: 'positive', chip: true })
  if (notes.length === 0) notes.push({ text: tr('room.pult.v3.cells.clear'), tone: 'neutral' })
  return notes
}

/* ------------------------------------------------- название задания */

/**
 * Декор, который в заголовке ничего не значит: рамки, подчёркивания, решётки.
 *
 * Снимается с ОБОИХ концов и только целыми сериями: «# ══ Важность ══» — это
 * «Важность», а «x ** 2» и «a - b» остаются собой, потому что внутри строки
 * ничего не трогается.
 */
const DECOR = /^[\s#=\-—–*_~·•≡═─━☰]+|[\s#=\-—–*_~·•≡═─━☰]+$/g

/**
 * Служебный префикс вида «ЯЧЕЙКА СТУДЕНТА ·».
 *
 * Только ПРОПИСНЫМИ и только из двух слов и больше: «S5E12 · минимум» —
 * название, а не префикс, и одно слово капсом перед точкой снимать нельзя.
 * Остаток обязан быть непустым: «КОНТРОЛЬНАЯ РАБОТА ·» без продолжения — это
 * и есть название.
 */
const PREFIX = /^[\p{Lu}\p{Nd}\s]*\p{Lu}[\p{Lu}\p{Nd}]*\s+[\p{Lu}\p{Nd}][\p{Lu}\p{Nd}\s]*[·:—-]\s+(?=\S)/u

/**
 * Название задания из текста ячейки — первая строка, если она комментарий.
 *
 * Комментарий над кодом — то, как задание подписывают в тетради, и он же
 * единственное, что о ячейке известно самому пульту. Строка чистится: решётки,
 * рамка из `═` и служебный префикс снимаются, а декоративная строка целиком
 * («# ═════») пропускается — за ней обычно и стоит название.
 *
 * Первая непустая строка КОДОМ означает, что названия в ячейке нет: подписью
 * тогда служит markdown-ячейка над ней, и её ищет зовущий (`markdownHeadline`).
 * Выдумывать заголовок из кода нельзя: «imp = clf.feature_importances_» в меню
 * хуже честной «ячейки 03».
 */
export function cellHeadline(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    // Дошли до кода — заголовка в ячейке нет.
    if (!line.startsWith('#')) return ''
    const clean = line.replace(DECOR, '').replace(PREFIX, '').trim()
    if (clean !== '') return clean
  }
  return ''
}

/**
 * ЗАГОЛОВОК markdown-ячейки — и только он, а не первая её строка.
 *
 * Разница тут не академическая. Настоящая ячейка семинара выглядит так:
 * абзац на три строки про пропуски в признаках, а под ним «### Задача 1» — и
 * задание называется именно вторым. Взяв первую непустую строку, меню получало
 * в кнопку «Остались пропуски только в числовых признаках (`GarageYrBlt`,
 * `MasVnrArea`). Их можно заполнить, проведя анализ…» — абзац вместо названия.
 *
 * Берётся ПОСЛЕДНИЙ заголовок ячейки: он ближе всего к коду, который под ней, и
 * именно он вводит задание. Заголовка нет вовсе — названия нет: абзац в роли
 * названия хуже честной «ячейки 60».
 *
 * Число решёток не значит ничего: «## Важность» и «# Важность» — одно название,
 * а уровень — про оглавление документа, а не про текст.
 */
export function markdownHeadline(text: string): string {
  let found = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('#')) continue
    const clean = line.replace(DECOR, '').replace(PREFIX, '').trim()
    if (clean !== '') found = clean
  }
  return found
}

/**
 * Что написано в строке меню и на кнопке в шапке.
 *
 * Название, если оно есть; иначе прежняя «ячейка NN»; а если ячейки в
 * документе уже нет — общее слово. Обрезается название не здесь: резать по
 * числу символов значит резать по-разному в «Важность признаков» и в
 * «ЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖ», а меряет ширину браузер (`text-overflow: ellipsis`).
 */
export function cellTaskTitle(input: { title: string; index: number | null }): string {
  const title = input.title.trim()
  if (title !== '') return title
  return input.index != null
    ? tr('room.ui.1272', { p0: String(input.index).padStart(2, '0') })
    : tr('room.ui.34')
}

/**
 * Куда уходит курсор с клавиши j / k.
 *
 * Курсора нет — вниз ведёт к первой строке, вверх к последней: первое нажатие
 * обязано что-то выбрать, иначе клавиша читается как сломанная. Курсор на
 * строке, которой в отборе больше нет (сменили фильтр), — тоже к первой.
 */
export function moveCursor(rows: readonly PultRow[], cursor: string | null, delta: 1 | -1): string | null {
  const ids = selectable(rows)
  if (ids.length === 0) return null
  const at = cursor === null ? -1 : ids.indexOf(cursor)
  if (at < 0) return delta === 1 ? ids[0] : ids[ids.length - 1]
  const next = at + delta
  if (next < 0 || next >= ids.length) return ids[at]
  return ids[next]
}

/* ------------------------------------------------------- непрочитанное */

/**
 * Кто сдал после того, как в список смотрели, — голубая точка слева.
 *
 * `seen` — те, чью строку уже открывали: точка гаснет на открытии и не
 * возвращается. `since` — момент, когда пульт открыли: всё, что сдано раньше,
 * непрочитанным не считается, иначе первое открытие красило бы точками весь
 * класс.
 */
export function unreadIds(
  attempts: readonly CouncilAttempt[],
  since: number,
  seen: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>()
  for (const attempt of attempts) {
    if (attempt.submittedAt === null) continue
    if (attempt.submittedAt <= since) continue
    if (seen.has(attempt.participantId)) continue
    out.add(attempt.participantId)
  }
  return out
}

/* ------------------------------------------------- придержанные сдачи */

/**
 * Держать ли новые сдачи за полосой «↑ ещё N сдали — показать».
 *
 * Список прокручен или курсор не на первой строке — значит человек читает
 * что-то конкретное, и строка, вставшая сверху, увела бы под курсором всё
 * вниз. Стоим на первой строке у самого верха — впускаем сразу: там новая
 * сдача и есть то, ради чего смотрят.
 */
export function holdsArrivals(scrolled: boolean, cursorAtTop: boolean): boolean {
  return scrolled || !cursorAtTop
}

/**
 * Что придержать: сданное после `frozenAt`, кроме того, что уже стоит в списке
 * и кроме строки под курсором. Курсор не двигается никогда — даже если человек
 * под ним сдал заново.
 */
export function heldArrivals(
  attempts: readonly CouncilAttempt[],
  frozenAt: number,
  standing: ReadonlySet<string>,
  cursor: string | null,
): Set<string> {
  const out = new Set<string>()
  for (const attempt of attempts) {
    if (attempt.submittedAt === null || attempt.submittedAt <= frozenAt) continue
    if (standing.has(attempt.participantId)) continue
    if (attempt.participantId === cursor) continue
    out.add(attempt.participantId)
  }
  return out
}

/* ------------------------------------------------------------ клавиши */

/** Где стоит фокус — от этого зависит, чья клавиша. */
export type PultFocus = 'list' | 'search' | 'reply' | 'actions'

export type PultAction =
  | 'next'
  | 'prev'
  | 'nextCell'
  | 'prevCell'
  | 'search'
  | 'show'
  | 'run'
  | 'correct'
  | 'wrong'
  | 'clearShown'
  | 'send'
  | 'escape'
  | 'help'
  | 'rules'
  | null

export interface PultKey {
  key: string
  shift?: boolean
  meta?: boolean
  ctrl?: boolean
  alt?: boolean
  composing?: boolean
}

/**
 * Что делает клавиша в пульте.
 *
 * Три правила, и все три про поля ввода. В поле ответа клавиши его: ⌘↵
 * отправляет, Esc закрывает, всё остальное — набор. В поиске стрелки ПРОДОЛЖАЮТ
 * ходить по отфильтрованному списку (иначе после ⌘F руки обязаны вернуться к
 * мыши), а буквы — набор. Везде остальное — буквы пульта.
 *
 * Enter показывает классу и только оттуда, где видно, кого показывают; на
 * кнопке (`actions`) он нажимает кнопку, а не делает второе дело первым.
 */
export function pultKeyAction(event: PultKey, focus: PultFocus): PultAction {
  if (event.alt || event.composing) return null
  const mod = Boolean(event.meta || event.ctrl)
  if (mod && (event.key === 'f' || event.key === 'F' || event.key === 'а' || event.key === 'А')) return 'search'
  if (focus === 'reply') {
    if (mod && event.key === 'Enter') return 'send'
    if (event.key === 'Escape') return 'escape'
    return null
  }
  if (mod) return null
  if (focus === 'actions' && (event.key === ' ' || event.key === 'Enter')) return null
  if (event.key === 'ArrowDown') return 'next'
  if (event.key === 'ArrowUp') return 'prev'
  if (event.key === 'Escape') return 'escape'
  /*
   * Скобки — соседняя ячейка, и работают они даже из поиска.
   *
   * В поле поиска набирают имя человека, а не квадратные скобки; зато уйти из
   * него в соседнюю ячейку, не снимая фокуса, — обычное дело. Раскладка тут
   * общая: на русской те же клавиши дают «х» и «ъ».
   */
  if (event.key === '[' || event.key === 'х' || event.key === 'Х') return 'prevCell'
  if (event.key === ']' || event.key === 'ъ' || event.key === 'Ъ') return 'nextCell'
  if (focus === 'search') return event.key === 'Enter' ? 'show' : null
  if (mod) return null
  switch (event.key) {
    case 'j':
    case 'о':
      return 'next'
    case 'k':
    case 'л':
      return 'prev'
    case 'Enter':
      return focus === 'actions' ? null : 'show'
    case 'r':
    case 'R':
    case 'к':
    case 'К':
      return 'run'
    case '1':
      return 'correct'
    case '2':
      return 'wrong'
    case '3':
      return 'clearShown'
    // «п» — правила; латинская g стоит на той же клавише, как о и j у курсора.
    case 'g':
    case 'G':
    case 'п':
    case 'П':
      return 'rules'
    // Косая — поиск, как в любом списке с лупой. ⌘F остаётся: он привычнее
    // тем, кто пришёл из браузера, а «/» — тем, кто из почты и мессенджеров.
    case '/':
      return 'search'
    case '?':
      return 'help'
    default:
      return null
  }
}

/* --------------------------------------------------------------- слова */

/** Цвет левой полосы строки: что от вас требуется, а не что случилось. */
export type RowMeaning = 'none' | 'cursor' | 'screen' | 'asking'

export function rowMeaning(
  attempt: CouncilAttempt,
  cursor: string | null,
  shown: string | null,
): RowMeaning {
  if (attempt.runRequest?.status === 'pending') return 'asking'
  if (shown === attempt.participantId) return 'screen'
  if (cursor === attempt.participantId) return 'cursor'
  return 'none'
}

/**
 * Повод рядом с просьбой о запуске — два слова, из-за которых разрешают.
 *
 * Выводится ТОЛЬКО из того, что правда известно: прошлый запуск этой же
 * попытки упал — значит «TypeError в прошлый раз». Истории просьб сервер не
 * везёт (`CouncilRunRequest` — одна текущая), поэтому «третья попытка за
 * минуту» здесь не сочиняется: выдуманный повод хуже пустого места, потому что
 * по нему принимают решение.
 */
export function requestReason(attempt: CouncilAttempt): string | null {
  const run = attempt.run
  if (!run || run.state !== 'error') return null
  const error = run.outputs.find((output) => output.kind === 'error')
  const name = error && error.kind === 'error' ? error.ename : ''
  return name ? tr('room.ui.1302', { p0: name }) : null
}

/** Кто сейчас в ядре по этой ячейке и кто ждёт — из той же стопки. */
export interface KernelView {
  /** Попытка ЭТОЙ ячейки, которую ядро считает сейчас. */
  running: CouncilAttempt | null
  queued: CouncilAttempt[]
  pending: CouncilAttempt[]
  /**
   * Ядро ТЕТРАДИ: чем занято и сколько всего ждёт.
   *
   * Из отдельного кадра (`council:kernel`), а не из стопки, и это не удвоение
   * `running`. Очередь у тетради одна, и держать её может обычная ячейка или
   * попытка СОСЕДНЕЙ ячейки консилиума — ни того ни другого в стопке этой
   * ячейки нет. Пока этого поля не было, пульт писал «в этой ячейке сейчас
   * ничего не выполняется» и «в очереди: 12» одновременно, а кнопку «Прервать»
   * прятал: она жила внутри ветки `running`.
   *
   * `null` — кадра ещё не приходило (старый сервер, пульт только открылся).
   * Тогда всё читается как раньше, по одной стопке.
   */
  book: CouncilKernel | null
}

export function kernelView(
  attempts: readonly CouncilAttempt[],
  book: CouncilKernel | null = null,
): KernelView {
  const running = attempts.find((attempt) => attempt.run?.state === 'running') ?? null
  const queued = attempts
    .filter((attempt) => attempt.run?.state === 'queued')
    .sort((a, b) => (a.run?.startedAt ?? 0) - (b.run?.startedAt ?? 0))
  const pending = attempts
    .filter((attempt) => attempt.runRequest?.status === 'pending')
    .sort(
      (a, b) =>
        (a.runRequest?.requestedAt ?? 0) - (b.runRequest?.requestedAt ?? 0) ||
        a.participantId.localeCompare(b.participantId),
    )
  return { running, queued, pending, book }
}

/**
 * Сколько работ ждёт своей очереди — по всей тетради, а не по этой ячейке.
 *
 * Число из кадра ядра считает всё: обычные ячейки, попытки этой ячейки и
 * попытки соседних. Пока его не было, пульт называл «в очереди» длину своего
 * списка — и преподаватель, читавший там «3», ждал минуту вместо десяти.
 * Кадра ещё нет (старый сервер) — остаётся прежнее число: врать про тетрадь
 * хуже, чем честно сказать про ячейку.
 */
export function queuedInBook(kernel: KernelView): number {
  return kernel.book?.queued ?? kernel.queued.length
}

/**
 * Есть ли что прерывать: ядро тетради занято — своей попыткой или чужой работой.
 *
 * Кнопка «Прервать» рисуется по этому ответу, а не по `running`. Раньше она
 * жила внутри карточки своей попытки, то есть исчезала ровно тогда, когда
 * очередь держала чужая работа, — в единственную минуту, когда она и нужна.
 */
export function kernelIsBusy(kernel: KernelView): boolean {
  return kernel.running !== null || kernel.book?.busy != null
}

/* ---------------------------------------------------------- регламент */

/**
 * Четыре правила ячейки — и один порядок на все места, где о них говорят.
 *
 * Порядок не по важности и не по алфавиту, а по ходу занятия: сперва кто
 * вообще запускает, потом сколько длится один запуск, потом когда разрешён
 * повтор, и в конце — что из этого увидит зал. Предложение в шапке, строки
 * листа и подсветка «того правила, ради которого лист открыли» читают его
 * отсюда: разойдясь, они начали бы показывать разное на одно нажатие.
 */
export type PultRule = 'studentRun' | 'runLimit' | 'rerunPause' | 'names'
export const PULT_RULES: readonly PultRule[] = ['studentRun', 'runLimit', 'rerunPause', 'names']

/**
 * Длительность регламента словами: «30 с», «1 мин», «1 мин 30 с».
 *
 * Не `spell()` из utils: та говорит о СЛУЧИВШЕМСЯ («считался 4 с») и округляет
 * до секунды, а здесь число — выбранная настройка, и 90 выбирали как «1 мин
 * 30 с», а не как «2 мин». Одна функция на предложение, лист, полосу запуска и
 * строку «Остановлен: дольше 30 с» — иначе предел в одном месте читался бы
 * иначе, чем в другом, и спор был бы о том, какое из двух чисел настоящее.
 *
 * Множественного числа в ключах нет намеренно: сокращения «с» и «мин» (s/min)
 * не склоняются ни в одном из двух языков.
 */
export function pultDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 60) return tr('room.pult.v2.rules.sec', { count: whole })
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return rest === 0
    ? tr('room.pult.v2.rules.min', { count: minutes })
    : tr('room.pult.v2.rules.minSec', { count: minutes, sec: rest })
}

/** Кусок предложения регламента: связка, значение-кнопка и то же значение в узком окне. */
export interface RulePart {
  rule: PultRule
  /** Связка перед значением; в узком окне прячется. */
  lead: string
  /** Значение — по нему и нажимают: оно открывает лист на своём правиле. */
  value: string
  /**
   * Чем значение становится, когда связки спрятаны.
   *
   * Совпадает со `value` везде, кроме паузы: «через 30 с» без связки читается
   * как второй предел запуска, поэтому в узком окне «повтор» переезжает ВНУТРЬ
   * значения — «повтор через 30 с».
   */
  short: string
  /** Единственное жёлтое значение в предложении — запуск без предела. */
  warn: boolean
}

/**
 * Регламент одной строкой — предложением, а не списком ручек.
 *
 * Запускать студенты не могут вовсе — кусок про повтор ИСЧЕЗАЕТ, а не гаснет:
 * пауза между запусками у того, кто не запускает, не означает ничего, и серая
 * «повтор сразу» в предложении — это лишнее слово, которое читают каждый раз.
 * Без предела — единственное жёлтое: очередь на нём встаёт насмерть, и знать
 * об этом надо не открывая лист.
 */
export function rulesSentence(settings: CouncilSettings): RulePart[] {
  const parts: RulePart[] = []
  const run = settings.studentRun
  const runValue = tr(
    run === false
      ? 'room.pult.v2.rules.runTeacher'
      : run === true
        ? 'room.pult.v2.rules.runEveryone'
        : 'room.pult.v2.rules.runRequest',
  )
  parts.push({
    rule: 'studentRun',
    lead: tr(run === false ? 'room.pult.v2.rules.runLeadTeacher' : 'room.pult.v2.rules.runLead'),
    value: runValue,
    short: runValue,
    warn: false,
  })

  const limit = settings.runLimitSec
  const limitValue =
    limit === null
      ? tr('room.pult.v2.rules.limitNone')
      : tr('room.pult.v2.rules.limitValue', { duration: pultDuration(limit) })
  parts.push({
    rule: 'runLimit',
    lead: tr('room.pult.v2.rules.limitLead'),
    value: limitValue,
    short: limitValue,
    warn: limit === null,
  })

  if (run !== false) {
    const pause = settings.rerunPauseSec
    const duration = pultDuration(pause)
    parts.push({
      rule: 'rerunPause',
      lead: tr('room.pult.v2.rules.pauseLead'),
      value: pause > 0 ? tr('room.pult.v2.rules.pauseValue', { duration }) : tr('room.pult.v2.rules.pauseNow'),
      short: pause > 0 ? tr('room.pult.v2.rules.pauseShort', { duration }) : tr('room.pult.v2.rules.pauseShortNow'),
      warn: false,
    })
  }

  const names = tr(
    settings.namesOnProjector ? 'room.pult.v2.rules.screenNames' : 'room.pult.v2.rules.screenAnon',
  )
  parts.push({ rule: 'names', lead: tr('room.pult.v2.rules.screenLead'), value: names, short: names, warn: false })
  return parts
}

/**
 * Что показать в ряду кнопок: заготовки, а при чужом значении — и его.
 *
 * Сервер принимает любое целое в границах (notebook.ts · COUNCIL_RUN_LIMIT_MAX),
 * и значение могло приехать из другой сборки, из истории или из будущего
 * списка заготовок. Ряд, в котором не нажата ни одна кнопка, читается как
 * «настройка сломана»; поэтому чужое число встаёт своей кнопкой — на своё
 * место по величине, а «без предела» остаётся последним.
 */
export function limitOptions(current: number | null): (number | null)[] {
  if (COUNCIL_RUN_LIMITS.includes(current)) return [...COUNCIL_RUN_LIMITS]
  const numbers = COUNCIL_RUN_LIMITS.filter((one): one is number => one !== null)
  // «Без предела» остаётся последним: это не самое большое число, а его отсутствие.
  return [...[...numbers, current as number].sort((a, b) => a - b), null]
}

export function pauseOptions(current: number): number[] {
  if (COUNCIL_RERUN_PAUSES.includes(current)) return [...COUNCIL_RERUN_PAUSES]
  return [...COUNCIL_RERUN_PAUSES, current].sort((a, b) => a - b)
}

/** Сколько на самом деле считают запуски этой ячейки: медиана, самый долгий и по скольким. */
export interface RunStats { median: number; max: number; count: number }

/**
 * Числа под выбором предела — чтобы его ставили по классу, а не по страху.
 *
 * Считается по ЗАКОНЧЕННЫМ запускам: у идущего длительности ещё нет, а у
 * остановленного пределом она не настоящая — там измерен сам предел, и медиана
 * поехала бы вверх ровно от того правила, которое по ней и выбирают (поставили
 * 5 с — «обычно 5 с» — поставили 15 с). Прерванные руки дают `ranMs: null` и
 * сюда тоже не попадают.
 */
export function runStats(attempts: readonly CouncilAttempt[]): RunStats | null {
  const spans = attempts
    .map((attempt) => attempt.run)
    .filter((run): run is NonNullable<CouncilAttempt['run']> =>
      run !== null && run !== undefined && run.ranMs !== null && timedOutLimit({ run }) === null)
    .map((run) => run.ranMs as number)
    .sort((a, b) => a - b)
  if (spans.length === 0) return null
  const middle = Math.floor(spans.length / 2)
  return {
    median: spans.length % 2 === 1 ? spans[middle] : Math.round((spans[middle - 1] + spans[middle]) / 2),
    max: spans[spans.length - 1],
    count: spans.length,
  }
}

/**
 * «Давно ли» — и без «1646 мин 28 с».
 *
 * `pultDuration` меряет НАСТРОЙКУ: пределы регламента живут в пределах часа, и
 * «1 мин 30 с» там — ровно то, что выбирали. Здесь мерят возраст: черновик,
 * оставленный вчера, честно старше суток, и минуты в нём не значат ничего.
 * Поэтому разряд один и всегда самый крупный: «7 мин», «3 ч», «2 дн».
 *
 * Меньше минуты не бывает: всё, что этой функцией измеряют, уже перешло свой
 * порог (пять минут молчания, минута с последней правки), и «0 мин» было бы
 * числом, которого не существует.
 */
export function pultIdle(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 3600) return tr('room.pult.v2.rules.min', { count: Math.max(1, Math.floor(whole / 60)) })
  if (whole < 86_400) return tr('room.pult.v3.idle.hours', { count: Math.floor(whole / 3600) })
  return tr('room.pult.v3.idle.days', { count: Math.floor(whole / 86_400) })
}

/** Предел, который остановил этот запуск, — или `null`, если его никто не останавливал. */
export function timedOutLimit(attempt: {
  run: Pick<NonNullable<CouncilAttempt['run']>, 'timedOut'> | null
}): number | null {
  const limit = attempt.run?.timedOut
  return typeof limit === 'number' ? limit : null
}

/**
 * «Остановлены сами» — свежие сверху, по началу запуска.
 *
 * По началу, а не по сдаче: секция про то, что случилось с ОЧЕРЕДЬЮ минуту
 * назад, и работа, сданная утром и запущенная сейчас, стоит первой.
 */
export function timedOutAttempts(attempts: readonly CouncilAttempt[]): CouncilAttempt[] {
  return attempts
    .filter((attempt) => timedOutLimit(attempt) !== null)
    .sort(
      (a, b) =>
        (b.run?.startedAt ?? 0) - (a.run?.startedAt ?? 0) || a.participantId.localeCompare(b.participantId),
    )
}

/** Доли полосы «весь класс одной строкой» — по статусам, без округлений. */
export function classBar(
  attempts: readonly CouncilAttempt[],
): Record<CouncilStatus | 'writing', number> {
  const bar: Record<CouncilStatus | 'writing', number> = {
    correct: 0,
    wrong: 0,
    failed: 0,
    ran: 0,
    unrun: 0,
    writing: 0,
  }
  for (const attempt of attempts) {
    if (attempt.submittedAt === null) bar.writing += 1
    else bar[attempt.status] += 1
  }
  return bar
}
