/**
 * Решения вкладки «Соревнования», вынесенные из компонентов.
 *
 * Ни Svelte, ни браузера — как в `admin/panel.ts` и по той же причине: это
 * числа и слова, по которым преподаватель принимает решения посреди пары
 * («успею ли починить метрику до дедлайна», «почему не открывается»,
 * «на какой ячейке падают все»), и ошибку в них видно только на живом
 * соревновании, когда исправлять поздно.
 *
 * Чего здесь нет: правил, которые обязаны совпасть с сервером. Порядок
 * лидерборда, зачётная посылка, деление строк — всё это лежит в
 * `shared/competitions.ts` и зовётся оттуда. Вторая копия такого правила не
 * падает, а тихо показывает классу другое место.
 */
import { tr, formatDate, formatNumber } from '@shared/i18n'
import {
  boardOf,
  competitionWord,
  directionWord,
  privateBoardOpen,
  type BoardEntry,
  type Competition,
  type CompetitionState,
  type MetricDirection,
  type RankedRow,
  type Submission,
  type SubmissionState,
} from '@shared/competitions'
import type {
  CompetitionRow,
  OpenRefusal,
  QueueSnapshot,
  SubmissionRow,
} from '@shared/competitions-api'

/* --------------------------------------------------------------- числа */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Число метрики так, как его читают в колонке.
 *
 * Макет знает ровно один масштаб — `0.0412`, четыре знака, — и про остальные
 * молчит. Молчать здесь нельзя: метрику пишет преподаватель, и RMSE в рублях
 * выдаёт `1234.5678`, а log-loss на хорошей модели — `0.00003`. Первое рвёт
 * колонку в 96 пикселей, второе печатается как `0.0000` у всех подряд — то
 * есть лидерборд, в котором первые десять мест выглядят одинаково.
 *
 * Отсюда три правила. Знаков после запятой тем меньше, чем крупнее число
 * (колонка — двенадцать знаков моноширинного тринадцатого кегля, и это
 * измерено, а не угадано). Очень крупное и очень мелкое уходит в
 * экспоненту — она узкая и честная. `NaN`, `inf` и отсутствие числа — прочерк:
 * выдумывать ноль там, где считать не вышло, нельзя.
 */
export function metricNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const size = Math.abs(value)
  if (size !== 0 && (size >= 1e6 || size < 1e-4)) return value.toExponential(2)
  const digits = size >= 1000 ? 1 : size >= 100 ? 2 : size >= 10 ? 3 : 4
  return value.toFixed(digits)
}

/** Целое с разделителем разрядов: `7 340`. */
export function count(value: number): string {
  return formatNumber(value)
}

/**
 * Длительность словами: «2 мин 40 с», «1 мин 48 с», «41 с».
 *
 * Секунды не отбрасываются у коротких прогонов и отбрасываются у длинных:
 * «4 ч 12 мин 09 с» — это не факт, а шум, а вот разница между «41 с» и
 * «1 мин 20 с» на посылке решает, ждать ли её на экране.
 */
export function spanWords(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const whole = Math.round(ms / 1000)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  if (hours > 0) return tr('admin.competitions.spanHm', { h: hours, m: minutes })
  if (minutes > 0) return tr('admin.competitions.spanMs', { m: minutes, s: seconds })
  return tr('admin.competitions.spanS', { s: seconds })
}

/**
 * Таймер прогона: `01:12`, `10:00`, `1:02:30`.
 *
 * Моноширинный счётчик, а не слова: он стоит рядом с пределом («01:12 из
 * 10:00») и обязан сравниваться взглядом, не чтением. Минуты дополняются
 * нулём только когда есть с чем равняться — в колонке «ШЛА» макет пишет
 * `3:05`, без ведущего нуля.
 */
export function clock(ms: number | null | undefined, pad = false): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const whole = Math.floor(ms / 1000)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  const ss = String(seconds).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`
  return `${pad ? String(minutes).padStart(2, '0') : String(minutes)}:${ss}`
}

/**
 * Сколько осталось: «6 дн 4 ч», «1 ч 12 мин», «40 с».
 *
 * Две единицы, никогда три: «6 дн 4 ч 17 мин» читается дольше, чем стоит, а
 * решение по этой строке принимают одно — успею или не успею.
 */
export function leftWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return tr('admin.competitions.leftNone')
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY)
    const hours = Math.floor((ms % DAY) / HOUR)
    return hours > 0
      ? tr('admin.competitions.leftDh', { d: days, h: hours })
      : tr('admin.competitions.leftD', { d: days })
  }
  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes > 0
      ? tr('admin.competitions.leftHm', { h: hours, m: minutes })
      : tr('admin.competitions.leftH', { h: hours })
  }
  if (ms >= MINUTE) return tr('admin.competitions.leftM', { m: Math.floor(ms / MINUTE) })
  return tr('admin.competitions.leftS', { s: Math.max(1, Math.round(ms / 1000)) })
}

/**
 * Сколько прошло: «вчера», «3 дн назад», «неделю назад».
 *
 * Своё, а не `panel.ts · ago`: там шкала кончается днями, и завершённое
 * месяц назад соревнование подписывалось «45 дн назад» — число, которое никто
 * не переводит в недели в уме. Здесь шкала доведена до месяцев, потому что
 * список соревнований живёт семестр, а не пару.
 */
export function sinceWords(from: number, now: number): string {
  const ms = Math.max(0, now - from)
  if (ms < MINUTE) return tr('admin.competitions.sinceNow')
  if (ms < HOUR) return tr('admin.competitions.sinceM', { count: Math.floor(ms / MINUTE) })
  if (ms < DAY) return tr('admin.competitions.sinceH', { count: Math.floor(ms / HOUR) })
  const days = Math.floor(ms / DAY)
  if (days === 1) return tr('admin.competitions.sinceYesterday')
  if (days < 7) return tr('admin.competitions.sinceD', { count: days })
  if (days < 31) return tr('admin.competitions.sinceW', { count: Math.floor(days / 7) })
  return tr('admin.competitions.sinceMonth', { count: Math.max(1, Math.floor(days / 30)) })
}

/* ------------------------------------------------------------- дедлайн */

/** Дата дедлайна и подпись под ней — две строки колонки «ДЕДЛАЙН». */
export interface DeadlineLine {
  /** `27.09, 23:59`, `сегодня, 21:00` или «не назначен». */
  when: string
  /** «осталось 6 дн 4 ч», «неделю назад», «откроется после проверки». */
  note: string
  /** Подпись горит: до дедлайна меньше половины суток. */
  hot: boolean
}

/**
 * Момент в колонке «КОГДА»: `18:58` сегодня, `13.09` раньше.
 *
 * Колонка в 74 пикселя, и в неё не влезает ни то ни другое сразу. Выбор
 * сделан за человека, и он же — единственный осмысленный: лента идущего
 * соревнования почти вся сегодняшняя, а вчерашнюю строку от сегодняшней
 * отличает не минута, а день.
 */
export function feedWhen(at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  return sameDay
    ? formatDate(at, { hour: '2-digit', minute: '2-digit' })
    : formatDate(at, { day: '2-digit', month: '2-digit' })
}

/** Момент — датой и временем; «сегодня» вместо даты, пока это сегодня. */
export function moment(at: number, now: number): string {
  const time = formatDate(at, { hour: '2-digit', minute: '2-digit' })
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  if (sameDay) return tr('admin.competitions.todayAt', { time })
  return `${formatDate(at, { day: '2-digit', month: '2-digit' })}, ${time}`
}

/**
 * Порог, за которым подпись дедлайна становится жёлтой.
 *
 * Полсуток, а не «сегодня»: дедлайн в 23:59 наступает для того, кто сел за
 * задачу в девять вечера, так же внезапно, как и для того, кто открыл экран в
 * полночь, — а календарные сутки различают их только по формальности. И не
 * час: за час преподаватель уже ничего не успеет сделать со своей стороны, а
 * строка списка нужна ему как раз затем, чтобы успеть.
 */
const HOT_MS = 12 * HOUR

export function deadlineLine(
  c: Pick<Competition, 'state' | 'deadlineAt'>,
  now: number,
  ready: OpenRefusal | null = null,
): DeadlineLine {
  if (c.deadlineAt === null) {
    return {
      when: tr('admin.competitions.deadlineNone'),
      // Черновику без даты говорят не «нет даты» (это и так видно слева), а
      // что с ним будет дальше: он ждёт проверки, а не назначения.
      note: c.state === 'draft' ? openNote(ready) : tr('admin.competitions.deadlineOpenEnded'),
      hot: false,
    }
  }
  const when = moment(c.deadlineAt, now)
  if (c.state === 'draft') return { when, note: openNote(ready), hot: false }
  const left = c.deadlineAt - now
  if (c.state === 'finished' || left <= 0) {
    return { when, note: sinceWords(c.deadlineAt, now), hot: false }
  }
  return {
    when,
    note: tr('admin.competitions.left', { time: leftWords(left) }),
    hot: left < HOT_MS,
  }
}

/** Подпись черновика: он откроется, когда пройдёт проверку. */
function openNote(ready: OpenRefusal | null): string {
  return ready === null
    ? tr('admin.competitions.readyToOpen')
    : tr('admin.competitions.opensAfterCheck')
}

/* -------------------------------------------------------- строки списка */

/**
 * Вторая строка названия: «MAPE · меньше — лучше · публичная часть 30 %».
 *
 * Третий кусок меняется со состоянием, и это не украшение: у черновика на его
 * месте стоит единственное, что мешает открыться, у завершённого — открыт ли
 * итог. Одна строка отвечает на вопрос «что с ним сейчас не так», ради
 * которого в список и заходят.
 */
export function metricLine(row: CompetitionRow, now: number): string {
  const c = row.competition
  const head = `${c.metric.name || tr('admin.competitions.metricUnnamed')} · ${directionWord(c.metric.direction)}`
  if (c.state === 'draft') {
    return `${head} · ${row.ready === null ? tr('admin.competitions.readyToOpen') : tr('admin.competitions.baselineNotPassed')}`
  }
  if (c.state === 'finished') {
    return `${head} · ${
      privateBoardOpen(c, now)
        ? tr('admin.competitions.privateBoardOpen')
        : tr('admin.competitions.privateBoardClosed')
    }`
  }
  return `${head} · ${tr('admin.competitions.publicPart', { percent: c.publicPercent })}`
}

/**
 * Подпись под лучшим публичным: «бейзлайн 0.0587» или его беда.
 *
 * Именно бейзлайн, а не приватный результат, даже у завершённого: приватного
 * числа в строке списка нет и быть не может — это одна строка на соревнование,
 * а итог считается по одной посылке КАЖДОГО участника. Бейзлайн же и есть то,
 * с чем сравнивают лучший результат класса: «0.0412 против 0.0587» — это
 * единственное, что строка списка вообще может сказать о качестве решений.
 */
export function baselineNote(row: CompetitionRow): { text: string; bad: boolean } {
  if (row.baselineState === null) return { text: tr('admin.competitions.baselineNotRun'), bad: false }
  if (row.baselineState === 'metricFailed') {
    return { text: tr('admin.competitions.baselineMetricFailed'), bad: true }
  }
  if (row.baselineState !== 'scored') {
    return { text: tr('admin.competitions.baselineFailed'), bad: true }
  }
  return { text: tr('admin.competitions.baselineScore', { score: metricNumber(row.baselineScore) }), bad: false }
}

/* ------------------------------------------------------ полоса очереди */

/** Две фразы полосы исполнителя: что идёт и на каких условиях. */
export interface RunnerLine {
  head: string
  tail: string
}

/**
 * «исполняет 1 посылку · 2 ждут» и «по одной за раз · без сети · сегодня
 * исполнено 37, в среднем 2 мин 40 с».
 *
 * Пауза сказана первой и словом: приостановленная очередь выглядит точно так
 * же, как пустая, — ничего не исполняется, — и различает их только эта
 * строка. Соревнование, в котором посылки молча не считаются вторые сутки,
 * начинается ровно здесь.
 */
export function runnerLine(queue: QueueSnapshot): RunnerLine {
  const parts: string[] = []
  if (queue.paused) parts.push(tr('admin.competitions.queuePaused'))
  parts.push(
    queue.running.length > 0
      ? tr('admin.competitions.runningN', { count: queue.running.length })
      : tr('admin.competitions.runningNone'),
  )
  if (queue.waiting > 0) parts.push(tr('admin.competitions.waitingN', { count: queue.waiting }))
  const tail = [
    tr('admin.competitions.slots', { count: queue.slots }),
    tr('admin.competitions.noNetwork'),
    queue.averageMs === null
      ? tr('admin.competitions.doneToday', { count: queue.doneToday })
      : tr('admin.competitions.doneTodayAvg', {
          count: queue.doneToday,
          avg: spanWords(queue.averageMs),
        }),
  ]
  return { head: parts.join(' · '), tail: tail.join(' · ') }
}

/** «≈ 3 мин»; оценки нет — так и сказано, а не «≈ 0 мин». */
export function etaWords(ms: number | null): string {
  if (ms === null) return tr('admin.competitions.etaUnknown')
  if (ms < MINUTE) return tr('admin.competitions.etaSoon')
  return tr('admin.competitions.eta', { time: leftWords(ms) })
}

/* ------------------------------------------------- почему не открывается */

/** Секция редактора, в которой лежит причина отказа. */
export type EditorSection = 'basics' | 'data' | 'baseline' | 'metric' | 'terms'

/**
 * Куда вести человека по отказу.
 *
 * Отказ называет причину, а не место, и «Нет файла ответов» на экране в шесть
 * секций — это шесть мест, в которых его можно искать. Порядок проверок на
 * сервере (`competitions/panel.ts` · openRefusal) — это порядок секций сверху
 * вниз, так что соответствие однозначное.
 */
export function refusalSection(refusal: OpenRefusal): EditorSection {
  switch (refusal) {
    case 'noData':
    case 'noSolution':
      return 'data'
    case 'noMetric':
      return 'metric'
    case 'noBaseline':
    case 'baselineNotChecked':
      return 'baseline'
    case 'noDeadline':
      return 'terms'
  }
}

/** Фраза отказа — та же, которой отказывает дверь `/open`. */
export function refusalText(refusal: OpenRefusal): string {
  return tr(`competitions.refusal.open.${refusal}`)
}

/* ------------------------------------------------------ заготовки метрики */

/** Заготовка: имя в чипе, куда смотрит метрика и какой у неё код. */
export interface MetricPreset {
  name: string
  direction: MetricDirection
}

/**
 * Семь чипов «ЗАГОТОВКИ» — ровно те, что нарисованы, и в том же порядке.
 *
 * Направление едет вместе с именем: MAPE, у которой «больше — лучше», — это
 * лидерборд задом наперёд, и заметит это тот, кто окажется последним.
 */
export const METRIC_PRESETS: readonly MetricPreset[] = [
  { name: 'MAPE', direction: 'lower' },
  { name: 'RMSE', direction: 'lower' },
  { name: 'MAE', direction: 'lower' },
  { name: 'ROC AUC', direction: 'higher' },
  { name: 'F1', direction: 'higher' },
  { name: 'accuracy', direction: 'higher' },
  { name: 'QWK', direction: 'higher' },
]

/** Колонки файла ответов: по ним заготовка знает, что с чем сливать. */
export interface AnswerColumns {
  /** Ключ строки — первая колонка `solution.csv`. */
  id: string
  /** Что предсказывают — вторая. */
  target: string
}

/**
 * Колонки из шапки файла ответов; нет файла — общие имена.
 *
 * Заготовка, подставляющая `target` туда, где в ответах написано `orders`,
 * падает на первой же проверке — с трейсом, который преподаватель будет
 * читать как ошибку продукта. Шапку ответов сервер уже прислал (`FileView ·
 * columns`), и единственное, чего ей не хватало, — чтобы кто-то её прочёл.
 */
export function answerColumns(columns: readonly string[] | null | undefined): AnswerColumns {
  const named = (columns ?? []).filter((name) => typeof name === 'string' && name.trim() !== '')
  // Колонка `Usage` — разметка деления строк, а не предсказание: она лежит в
  // файле ответов рядом с целевой и в метрику не идёт (shared · splitByUsage).
  const useful = named.filter((name) => name.toLowerCase() !== 'usage')
  return { id: useful[0] ?? 'id', target: useful[1] ?? 'target' }
}

/** Тело `score` для заготовки — с настоящими именами колонок этого соревнования. */
export function presetCode(name: string, columns: AnswerColumns): string {
  const { id, target } = columns
  const guard = [
    `    if list(submission.columns) != [${quote(id)}, ${quote(target)}]:`,
    `        raise ParticipantVisibleError(${quote(tr('admin.competitions.preset.columns', { cols: `${id}, ${target}` }))})`,
    `    merged = solution.merge(submission, on=${quote(id)}, how="left", suffixes=("", "_pred"))`,
    `    if merged[${quote(`${target}_pred`)}].isna().any():`,
    `        raise ParticipantVisibleError(${quote(tr('admin.competitions.preset.missing'))})`,
  ].join('\n')
  const head = (imports: string): string =>
    `${imports}\n\ndef score(solution: pd.DataFrame, submission: pd.DataFrame) -> float:\n${guard}\n`
  const truth = `merged[${quote(target)}]`
  const guess = `merged[${quote(`${target}_pred`)}]`
  switch (name) {
    case 'MAPE':
      return `${head('import numpy as np, pandas as pd')}    err = (${truth} - ${guess}).abs() / ${truth}\n    return float(err.mean())\n`
    case 'RMSE':
      return `${head('import numpy as np, pandas as pd')}    err = (${truth} - ${guess}) ** 2\n    return float(np.sqrt(err.mean()))\n`
    case 'MAE':
      return `${head('import numpy as np, pandas as pd')}    return float((${truth} - ${guess}).abs().mean())\n`
    case 'ROC AUC':
      return `${head('import pandas as pd\nfrom sklearn.metrics import roc_auc_score')}    return float(roc_auc_score(${truth}, ${guess}))\n`
    case 'F1':
      return `${head('import pandas as pd\nfrom sklearn.metrics import f1_score')}    return float(f1_score(${truth}, ${guess}, average="macro"))\n`
    case 'accuracy':
      return `${head('import pandas as pd\nfrom sklearn.metrics import accuracy_score')}    return float(accuracy_score(${truth}, ${guess}))\n`
    case 'QWK':
      return `${head('import pandas as pd\nfrom sklearn.metrics import cohen_kappa_score')}    return float(cohen_kappa_score(${truth}, ${guess}, weights="quadratic"))\n`
    default:
      return `${head('import pandas as pd')}    return float((${truth} - ${guess}).abs().mean())\n`
  }
}

/** Строка Python: кавычки те же, что у остального кода заготовок. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Метрика после нажатия на чип заготовки. */
export interface MetricDraft {
  name: string
  direction: MetricDirection
  code: string
}

/**
 * Что делает чип заготовки с тем, что уже набрано.
 *
 * Имя и направление он меняет всегда — за этим его и нажимают. А код
 * подставляет ТОЛЬКО поверх пустого места или поверх другой, нетронутой
 * заготовки: полчаса работы над своей метрикой, стёртые случайным попаданием в
 * чип, назад не вернёшь, а Ctrl+Z в поле кода отменяет ввод, а не чужую
 * подстановку.
 */
export function applyPreset(current: MetricDraft, name: string, columns: AnswerColumns): MetricDraft {
  const preset = METRIC_PRESETS.find((one) => one.name === name)
  if (!preset) return current
  const next: MetricDraft = { name: preset.name, direction: preset.direction, code: current.code }
  if (current.code.trim() === '' || isUntouchedPreset(current.code, columns)) {
    next.code = presetCode(preset.name, columns)
  }
  return next
}

/** Код, который целиком совпадает с какой-нибудь заготовкой, — значит, ничей. */
export function isUntouchedPreset(code: string, columns: AnswerColumns): boolean {
  return METRIC_PRESETS.some((preset) => presetCode(preset.name, columns).trim() === code.trim())
}

/* ------------------------------------------------------------- сводка A3 */

/** «Чаще всего тетради падают на ячейке 7 — 11 посылок из 27». */
export interface WorstCell {
  cell: number
  hits: number
  total: number
}

/**
 * Ячейка, на которой падает больше всего тетрадей.
 *
 * Единственное число этого экрана, которое говорит про ЗАДАЧУ, а не про
 * машину: если двадцать семь человек из ста спотыкаются на седьмой ячейке,
 * значит, дело не в них, а в данных или в формулировке, — и увидеть это
 * можно только сложив чужие неудачи в одну кучу.
 *
 * `null` там, где куча ещё не куча: одно-два падения — это просто чей-то
 * `KeyError`, и объявлять его закономерностью значит отправить
 * преподавателя чинить свою задачу из-за одного человека.
 */
export function worstCell(rows: readonly SubmissionRow[], least = 3): WorstCell | null {
  const failed = rows.filter(
    (row) => !row.baseline && row.submission.state === 'notebookFailed' && row.submission.cellsDone > 0,
  )
  if (failed.length === 0) return null
  const tally = new Map<number, number>()
  for (const row of failed) {
    const cell = row.submission.cellsDone
    tally.set(cell, (tally.get(cell) ?? 0) + 1)
  }
  let best: WorstCell | null = null
  for (const [cell, hits] of tally) {
    if (best === null || hits > best.hits || (hits === best.hits && cell < best.cell)) {
      best = { cell, hits, total: failed.length }
    }
  }
  return best !== null && best.hits >= least ? best : null
}

/**
 * Лидерборд из ленты посылок, обе части сразу.
 *
 * Считается здесь, а не отдельной дверью, и это выбор, а не экономия: правило
 * зачёта одно (`shared/competitions.ts` · boardOf), и экран, который зовёт его
 * сам, не может разойтись с сервером в том, чья посылка пошла в счёт. Цена —
 * лента должна приехать целиком; за этим следит тот, кто её грузит.
 *
 * Базовое решение из таблицы вынуто: оно не участник, и место ему не
 * полагается. Строкой «бейзлайн» его рисует экран — отдельно и без номера.
 */
export function boardFromFeed(
  rows: readonly SubmissionRow[],
  c: Pick<Competition, 'scoring' | 'metric'>,
  part: 'public' | 'private',
): RankedRow[] {
  const people = new Map<string, BoardEntry[]>()
  for (const row of rows) {
    if (row.baseline) continue
    const entries = people.get(row.submission.entrantId) ?? []
    entries.push(entryOf(row.submission))
    people.set(row.submission.entrantId, entries)
  }
  return boardOf(
    [...people].map(([entrantId, entries]) => ({ entrantId, entries })),
    c.scoring,
    c.metric.direction,
    part,
  )
}

function entryOf(submission: Submission): BoardEntry {
  return {
    id: submission.id,
    number: submission.number,
    acceptedAt: submission.acceptedAt,
    state: submission.state,
    publicScore: submission.publicScore,
    privateScore: submission.privateScore,
    chosen: submission.chosen,
  }
}

/* --------------------------------------------------------------- слова */

/** Что случилось с посылкой — колонка «ЧТО СЛУЧИЛОСЬ». */
export function outcomeLine(row: SubmissionRow, best: boolean): string {
  const s = row.submission
  if (s.state === 'metricFailed') return tr('admin.competitions.outcome.metricFailed')
  if (s.state === 'scored') {
    if (best) return tr('admin.competitions.outcome.newBest')
    if (s.chosen) return tr('admin.competitions.outcome.chosen')
    return ''
  }
  if (s.participantError) return s.participantError
  if (s.state === 'notebookFailed' && s.cellsDone > 0) {
    return tr('admin.competitions.outcome.cellFailed', { cell: s.cellsDone })
  }
  return ''
}

/** Состояние соревнования словом — одна копия на список и на шапку. */
export function stateWord(state: CompetitionState): string {
  return competitionWord(state)
}

/**
 * Тон плашки соревнования — по таблице макета: идёт — accent, черновик —
 * предупреждение, завершено — нейтральная.
 */
export function stateTone(state: CompetitionState): 'accent' | 'warning' | 'neutral' {
  return state === 'live' ? 'accent' : state === 'draft' ? 'warning' : 'neutral'
}

/** Идёт ли посылка прямо сейчас — строки очереди рисуются не в ленте. */
export function inFlight(state: SubmissionState): boolean {
  return state === 'queued' || state === 'running'
}
