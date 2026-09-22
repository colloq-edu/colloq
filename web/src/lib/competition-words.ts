/**
 * Всё, что страницы соревнований считают и произносят, — без единого DOM.
 *
 * Здесь то, у чего есть правильный и неправильный ответ: сколько осталось до
 * дедлайна, чем набрано число метрики, какая подпись стоит под именем файла,
 * где посылка стоит на полосе этапов. Всё это на экране выглядит одинаково
 * правдоподобно при любом ответе — «0.046» вместо «0.0455», «1 ч» вместо «1 ч
 * 12 мин», зелёный этап вместо текущего, — и ошибку в нём замечают на паре, а
 * не в браузере.
 *
 * Слова берутся из каталога `competitions` (shared/locales/competitions.ts), и
 * только из него: страницы `/k` не грузят ни комнатный каталог, ни панельный
 * (web/src/lib/messages/competitions-*.ts), так что `spell()` и `elapsed()` из
 * lib/utils.ts, набранные ключами `room.ui.*`, показали бы здесь голый ключ.
 *
 * Плашки, этапы и направление метрики живут не тут, а в `@shared/competitions`:
 * их одинаково произносят сервер и браузер, и вторая копия разошлась бы с
 * первой на первой же правке.
 */
import { formatNumber, getLocale, tr } from '@shared/i18n'
import {
  metricFailedNote,
  stagePosition,
  stageWord,
  SUBMISSION_STAGES,
  DIRECTION_ARROW,
  type EntrantSubmission,
  type MetricDirection,
  type StagePosition,
  type SubmissionStage,
  type SubmissionState,
} from '@shared/competitions'
import type { SubmissionLive } from '@shared/competitions-entrant'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/* ------------------------------------------------------------------ число */

/**
 * Метрика — четырьмя знаками после точки, как во всём макете.
 *
 * Четыре знака выбраны не размером колонки: разница между 0.0455 и 0.0452 —
 * это разница между четвёртым и седьмым местом, и округление до трёх знаков
 * склеивает соседей в лидерборде. Но метрика бывает и не долей: RMSE в рублях
 * приезжает тысячами, а `log loss` на вырожденной задаче — миллионными
 * долями. Поэтому ступеней три, и каждая держит ЗНАЧАЩИЕ цифры, а не число
 * знаков.
 *
 * `NaN` и бесконечность — прочерк: число, которого нет, не должно выглядеть
 * как число. Такое приезжает от метрики, которая поделила на ноль и не упала.
 */
export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const size = Math.abs(value)
  if (size !== 0 && (size >= 1e6 || size < 1e-4)) return value.toExponential(2)
  if (size >= 1000) return value.toFixed(2)
  return value.toFixed(4)
}

/** «0.0412 · 3-й» — число и место одной строкой (колонка «ПУБЛИЧНЫЙ MAPE», P3). */
export function scoreWithPlace(score: number | null, place: number | null): string {
  const number = formatScore(score)
  return place === null ? number : `${number} · ${ordinalPlace(place)}`
}

/**
 * «7-й · 0.0455» — то же самое, но местом вперёд (блок «ВЫ» на P1).
 *
 * Порядок не косметический: в карточке списка человек ищет глазами СЕБЯ, то
 * есть своё место, а в колонке лидерборда — число, по которому эта колонка и
 * названа. Обе формы записаны в макете, и обе здесь.
 */
export function placeWithScore(place: number | null, score: number | null): string {
  if (place === null) return formatScore(score)
  return `${ordinalPlace(place)} · ${formatScore(score)}`
}

/**
 * Место порядковым: «7-й», «7th».
 *
 * Всегда мужского рода, хотя макет пишет «1-я» у Марфы и «3-й» у Даниила:
 * согласовать можно только с полом человека, а пол из имени не выводится ни
 * надёжно, ни вежливо. Одна форма честнее угаданной.
 */
export function ordinalPlace(place: number): string {
  if (getLocale() !== 'en') return `${place}-й`
  const mod100 = place % 100
  if (mod100 >= 11 && mod100 <= 13) return `${place}th`
  const mod10 = place % 10
  return `${place}${mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th'}`
}

/** «MAPE ↓» — метрика со стрелкой направления (P1, P4). */
export function metricArrow(name: string, direction: MetricDirection): string {
  return `${name} ${DIRECTION_ARROW[direction]}`
}

/* -------------------------------------------------------------- время */

/**
 * Законченная длительность словами: «41 с», «2 мин 51 с», «6 мин», «1 ч 12 мин».
 *
 * Секунды исчезают, как только появляются часы: «1 ч 12 мин 03 с» — это
 * точность, которой никто не пользуется, и три лишних знака в колонке.
 */
export function spellDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.round(ms / SECOND)
  if (total < 60) return tr('competitions.p.durSeconds', { count: total })
  if (total < 3600) {
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return seconds === 0
      ? tr('competitions.p.durMinutes', { count: minutes })
      : tr('competitions.p.durMinutesSeconds', { minutes, seconds })
  }
  return tr('competitions.p.durHoursMinutes', {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
  })
}

/**
 * Сколько осталось, словами: «6 дн 4 ч», «1 ч 12 мин», «12 мин».
 *
 * Два разряда и не больше: человек читает эту строку, чтобы решить «успею
 * сегодня или нет», и третий разряд на это решение не влияет.
 */
export function remainingWords(ms: number): string {
  if (ms <= 0) return tr('competitions.p.closedNow')
  if (ms < MINUTE) return tr('competitions.p.durInstant')
  if (ms < HOUR) return tr('competitions.p.durMinutes', { count: Math.floor(ms / MINUTE) })
  if (ms < DAY) {
    return tr('competitions.p.durHoursMinutes', {
      hours: Math.floor(ms / HOUR),
      minutes: Math.floor((ms % HOUR) / MINUTE),
    })
  }
  return tr('competitions.p.durDaysHours', {
    days: Math.floor(ms / DAY),
    hours: Math.floor((ms % DAY) / HOUR),
  })
}

/**
 * То же время, но часами: «6 дн 04:12», «04:12», «00:07».
 *
 * Крупная цифра в шапке (P2, P4) идёт часами, а не словами, и это не вкус:
 * она обновляется каждую минуту на глазах, и «1 ч 12 мин» → «1 ч 11 мин»
 * меняет ширину строки, а `01:12` → `01:11` не меняет.
 */
export function remainingClock(ms: number): string {
  if (ms <= 0) return '00:00'
  const days = Math.floor(ms / DAY)
  const rest = ms - days * DAY
  const clock = `${pad(Math.floor(rest / HOUR))}:${pad(Math.floor((rest % HOUR) / MINUTE))}`
  return days > 0 ? tr('competitions.p.durClockDays', { days, clock }) : clock
}

/** «01:12» — секундомер идущего прогона; часы появляются, только если нужны. */
export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${pad(minutes)}:${pad(seconds)}`
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds)}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Дедлайн горит, когда он ближе шести часов.
 *
 * Шесть, а не сутки: «осталось 20 ч» — это ещё целый вечер, и красить его
 * тревожным значит приучить не замечать цвет. Шесть часов — это последний
 * заход, в который человек успевает обучить модель и отправить тетрадь.
 */
export const URGENT_MS = 6 * HOUR

export function deadlineUrgent(deadlineAt: number | null, now: number): boolean {
  if (deadlineAt === null) return false
  const left = deadlineAt - now
  return left > 0 && left <= URGENT_MS
}

/** Подпись под таймером: «до 27.09, 23:59» или «сегодня до 21:00». */
export function deadlineNote(deadlineAt: number | null, now: number): string {
  if (deadlineAt === null) return tr('competitions.p.noDeadline')
  if (deadlineAt <= now) return tr('competitions.p.closedNow')
  if (sameDay(deadlineAt, now)) return tr('competitions.p.untilToday', { time: clockOf(deadlineAt) })
  return tr('competitions.p.untilDate', { date: `${dateOf(deadlineAt)}, ${clockOf(deadlineAt)}` })
}

/** «Сегодня в 18:40», «Вчера в 22:14», «13.09 в 20:05». */
export function whenWords(at: number, now: number): string {
  if (sameDay(at, now)) return tr('competitions.p.todayAt', { time: clockOf(at) })
  if (sameDay(at, now - DAY)) return tr('competitions.p.yesterdayAt', { time: clockOf(at) })
  return tr('competitions.p.dateAt', { date: dateOf(at), time: clockOf(at) })
}

export function sameDay(a: number, b: number): boolean {
  const left = new Date(a)
  const right = new Date(b)
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

/** «23:59» часовым поясом читателя: сервер шлёт момент, а не строку. */
export function clockOf(at: number): string {
  return new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(at))
}

/** «27.09» — день и месяц, без года: соревнование живёт недели, а не годы. */
export function dateOf(at: number): string {
  return new Intl.DateTimeFormat(getLocale(), { day: '2-digit', month: '2-digit' })
    .format(new Date(at))
}

/* --------------------------------------------------------- полоса этапов */

export interface StageCell {
  stage: SubmissionStage
  position: StagePosition
  word: string
}

/** Пять подписей полосы под идущей посылкой (P2) — с их цветом-состоянием. */
export function stageStrip(state: SubmissionState, at: SubmissionStage): StageCell[] {
  return SUBMISSION_STAGES.map((stage) => ({
    stage,
    position: stagePosition(state, at, stage),
    word: stageWord(stage),
  }))
}

/**
 * Насколько полоса заполнена, 0–100.
 *
 * Ячейки — единственное, что двигается по-настоящему, поэтому они и считают:
 * пока их число неизвестно (тетрадь ещё не открывали), полоса показывает
 * этап, а не ноль. Ноль под словом «ВЫПОЛНЯЕТСЯ» читается как «висит».
 */
export function runProgress(live: Pick<SubmissionLive, 'stage' | 'cellsDone' | 'cellsTotal'>): number {
  if (live.cellsTotal > 0) {
    const share = live.cellsDone / live.cellsTotal
    return clampPercent(5 + share * 90)
  }
  const at = SUBMISSION_STAGES.indexOf(live.stage)
  return clampPercent(((at + 1) / SUBMISSION_STAGES.length) * 100)
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/* --------------------------------------------------------------- очередь */

/** «Третья», «11-я» — место в очереди словом, как его произносят вслух. */
export function queueOrdinal(place: number): string {
  if (place >= 1 && place <= 10) return tr(`competitions.p.ordinal.${place}`)
  return tr('competitions.p.ordinalN', { count: place })
}

export interface QueueNote {
  place: number | null
  aheadNumber: number | null
  paused: boolean
  /** Телефон говорит короче: «запуск после посылки #12», без «завершения». */
  short?: boolean
}

/**
 * Подпись ждущей посылки: «Третья в очереди · запуск после завершения посылки #12».
 *
 * Хвост про чужой номер не пишется никогда (сервер его и не присылает): «после
 * посылки #7» про чужую посылку — это номер из чужого списка, который человеку
 * нечем сопоставить со своим.
 */
export function queueNote(note: QueueNote): string {
  const parts: string[] = []
  if (note.place !== null) parts.push(tr('competitions.p.queueAt', { place: queueOrdinal(note.place) }))
  if (note.aheadNumber !== null) {
    parts.push(
      tr(note.short ? 'competitions.p.afterMineShort' : 'competitions.p.afterMine', {
        number: note.aheadNumber,
      }),
    )
  }
  if (note.paused) parts.push(tr('competitions.p.queuePaused'))
  return parts.join(' · ')
}

/* ------------------------------------------------- подписи строк посылок */

/**
 * Первая фраза отказа — в заголовок, остальное — в подпись.
 *
 * У «ОТВЕТ НЕ ПРИНЯТ» в заголовке строки стоит не имя файла, а причина: «Не
 * для всех строк test.csv есть прогноз», и это не прихоть макета — участнику
 * важнее причина, чем то, как он назвал файл. Причина приезжает одной строкой
 * от метрики, и режется она по первой точке: так написаны все сообщения
 * каталога («… есть прогноз. В submission.csv 391 строка вместо 397…»).
 */
export function splitError(text: string | null): { head: string; rest: string } {
  const value = (text ?? '').trim()
  if (!value) return { head: '', rest: '' }
  const at = value.search(/[.!?:](\s|$)/)
  if (at < 0 || at >= value.length - 1) return { head: value, rest: '' }
  return { head: value.slice(0, at + 1).trim(), rest: value.slice(at + 1).trim() }
}

export interface RowWords {
  /** Что стоит в заголовке строки: имя файла или причина отказа. */
  title: string
  /** Строки подписи под ним, сверху вниз. */
  lines: string[]
}

export interface RowInput {
  submission: EntrantSubmission
  live: SubmissionLive | null
  /** Лучший публичный результат среди своих посылок. */
  best: boolean
  paused: boolean
  now: number
  /** Телефонная раскладка (P4): подписи короче, длительности нет. */
  phone?: boolean
}

/**
 * Что написано в строке посылки — заголовком и подписью.
 *
 * Одна функция на все восемь исходов нарочно: подпись отличается от исхода к
 * исходу не оформлением, а СОСТАВОМ («ошибка в ячейке 7 из 14 через 41 с»
 * против «остановка на ячейке 11 из 16»), и собранная по месту она разъедется
 * между десктопом и телефоном в первую же правку.
 */
export function rowWords(input: RowInput): RowWords {
  const { submission, live, now } = input
  const file = submission.fileName
  switch (submission.state) {
    case 'running': {
      const lines: string[] = []
      if ((live?.stage ?? submission.stage) === 'dependencies') {
        return { title: file, lines: [tr('dependencies.installing')] }
      }
      if (input.phone) {
        lines.push(
          submission.cellsTotal > 0
            ? tr('competitions.p.cellRunning', {
                cell: Math.max(1, submission.cellsDone),
                cells: submission.cellsTotal,
              })
            : tr('competitions.entrant.running'),
        )
        return { title: file, lines }
      }
      if (submission.cellsTotal > 0) {
        lines.push(
          tr('competitions.p.cellOf', {
            cell: Math.max(1, submission.cellsDone),
            cells: submission.cellsTotal,
          }),
        )
      }
      lines.push(tr('competitions.p.sentAt', { time: clockOf(submission.acceptedAt) }))
      if (live?.startedAt) {
        lines.push(
          tr('competitions.p.waited', {
            duration: spellDuration(live.startedAt - submission.acceptedAt),
          }),
        )
      }
      return { title: file, lines: [lines.join(' · ')] }
    }
    case 'queued':
      return {
        title: file,
        lines: [
          queueNote({
            place: live?.place ?? null,
            aheadNumber: live?.aheadNumber ?? null,
            paused: input.paused,
            short: input.phone,
          }),
        ].filter(Boolean),
      }
    case 'scored': {
      const parts = [whenWords(submission.acceptedAt, now)]
      if (!input.phone) {
        parts.push(
          input.best
            ? spellDuration(submission.durationMs)
            : tr('competitions.p.doneIn', { duration: spellDuration(submission.durationMs) }),
        )
      }
      if (input.best) parts.push(tr('competitions.p.best'))
      return { title: file, lines: [parts.join(' · ')] }
    }
    case 'notebookFailed': {
      const head = [whenWords(submission.acceptedAt, now)]
      if (submission.cellsTotal > 0) {
        head.push(
          tr('competitions.p.failedAtCell', {
            cell: Math.max(1, submission.cellsDone),
            cells: submission.cellsTotal,
            duration: spellDuration(submission.durationMs),
          }),
        )
      }
      return { title: file, lines: [head.join(' · ')] }
    }
    case 'timedOut': {
      const head = [whenWords(submission.acceptedAt, now)]
      if (submission.cellsTotal > 0) {
        head.push(
          tr('competitions.p.stoppedAtCell', {
            cell: Math.max(1, submission.cellsDone),
            cells: submission.cellsTotal,
          }),
        )
      }
      const lines = [head.join(' · ')]
      if (submission.participantError && !input.phone) lines.push(submission.participantError)
      return { title: file, lines }
    }
    case 'rejected': {
      /*
       * Причина — в заголовок, имя файла — в подпись: так в макете, и это тот
       * единственный исход, где человек смотрит не на «какую тетрадь я слал»,
       * а на «чем именно ответ не подошёл».
       */
      const { head, rest } = splitError(submission.participantError)
      const first = [whenWords(submission.acceptedAt, now), file]
      if (!input.phone) first.push(spellDuration(submission.durationMs))
      const lines = [first.join(' · ')]
      if (rest && !input.phone) lines.push(rest)
      return { title: head || file, lines: input.phone && head ? [] : lines }
    }
    case 'outOfMemory': {
      const lines = [whenWords(submission.acceptedAt, now)]
      if (submission.participantError && !input.phone) lines.push(submission.participantError)
      return { title: file, lines }
    }
    case 'metricFailed':
      return {
        title: file,
        lines: [whenWords(submission.acceptedAt, now), metricFailedNote()],
      }
    case 'cancelled':
      return {
        title: file,
        lines: [`${whenWords(submission.acceptedAt, now)} · ${tr('competitions.p.cancelledNote')}`],
      }
  }
}

/* ------------------------------------------------------------- лидерборд */

/**
 * Места в таблице — по ЛЮДЯМ, с базовым решением там, куда оно попало.
 *
 * Сервер ранжирует всех подряд, и базовое решение получает от него обычное
 * место. Пока оно двадцатое из двадцати восьми (как в макете), разницы нет;
 * но на соревновании, где никто ещё не обогнал бейзлайн, он становится первым,
 * и человек читает «ВАШЕ МЕСТО 2 из 3» в шапке рядом со строкой «3» в
 * таблице. Здесь бейзлайн перестаёт занимать место людей и встаёт ровно туда,
 * где стоял бы, будь он участником: после всех, кто его обошёл.
 *
 * Порядок строк не меняется — он уже посчитан сервером по правилу метрики.
 */
export function boardPlaces<T extends { baseline: boolean }>(
  lines: readonly T[],
): (T & { place: number | null })[] {
  let people = 0
  return lines.map((line) => {
    if (!line.baseline) {
      people += 1
      return { ...line, place: people }
    }
    /*
     * Базовое решение, которого ещё никто не обошёл, места не занимает вовсе:
     * «1» в его строке рядом с «1» у первого человека читается как ничья,
     * которой нет. Прочерк на этом месте — это и есть новость: пока ни одна
     * посылка не лучше бейзлайна.
     */
    return { ...line, place: people === 0 ? null : people + 1 }
  })
}

/* ----------------------------------------------------------------- файлы */

/**
 * Размер файла данных: «6 КБ», «212 КБ», «4,1 МБ».
 *
 * Свой, а не `formatBytes` из lib/utils.ts: тот набран ключами `room.*`, а
 * каталог комнаты на эти страницы не приезжает — на экране оказалась бы
 * строка `room.ui.1185`. Десятая доля живёт только до десяти мегабайт: дальше
 * она ничего не говорит и ломает колонку по ширине.
 */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return tr('competitions.p.sizeBytes', { count: bytes })
  if (bytes < 1024 * 1024) {
    return tr('competitions.p.sizeKb', { size: formatNumber(Math.round(bytes / 1024)) })
  }
  const mb = bytes / (1024 * 1024)
  const digits = mb < 10 ? 1 : 0
  return tr('competitions.p.sizeMb', {
    size: formatNumber(mb, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
  })
}

/* --------------------------------------------------------------- аватар */

/**
 * Кружок с буквой: шесть пастельных подложек макета, выбор — по имени.
 *
 * По имени, а не по идентификатору: человек узнаёт себя в таблице по цвету, и
 * этот цвет обязан быть тем же на телефоне, где идентификатор другой… и тем
 * же после того, как преподаватель выдаст новый ключ.
 */
export const AVATAR_TINTS: readonly string[] = [
  '#CFE3F7',
  '#F7D9E3',
  '#D8F0E4',
  '#F2D9B8',
  '#E3DDF7',
  '#F7E9C4',
]

export function avatarTint(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 100_000
  return AVATAR_TINTS[hash % AVATAR_TINTS.length]
}

/** Одна буква на кружке — первая буква имени, как в макете («Т»). */
export function avatarLetter(name: string): string {
  const trimmed = name.trim()
  return trimmed ? [...trimmed][0].toUpperCase() : '?'
}

/** «Тимур А.» — как подписан человек в шапке телефона. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return name.trim()
  return `${parts[0]} ${[...parts[1]][0].toUpperCase()}.`
}
