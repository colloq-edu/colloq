/**
 * Слова и обрезка — общие для всего, что оракул пишет и читает.
 *
 * Здесь ничего не решается: это четыре мелочи, которые лежали по два-три раза в
 * `index.ts`, `agent.ts`, `council.ts`, `context.ts` и `routes/ai.ts` и уже
 * разошлись деталями. Русский плюрал был написан четырьмя разными способами
 * (в одном из них 11–14 разбирались отдельно), `clip` в одном месте считал
 * маркер в бюджет, а в другом — сверх него, и обрезанный кусок выходил длиннее
 * заявленного потолка. Правило одно, значит и копия должна быть одна: следующая
 * правка попадёт во все места разом, а не в одно из трёх.
 *
 * Живёт в server/src/ai/, а не в shared: обрезка промпта нужна ровно здесь, и
 * тащить её в браузер было бы хуже, чем оставить рядом с тем, что её зовёт.
 * Само правило склонения — из shared: его читают и вкладка, и статические
 * страницы, и второй копии у него быть не должно.
 */
import { plural } from '@shared/plural'

/**
 * «одну секунду, две секунды, пять секунд» — одно правило на все счётные слова.
 *
 * Реэкспортом, чтобы счётные слова оракула стояли рядом с остальными его
 * словами и звались из одного места.
 */
export { plural }

/** «22 секунды» — число и слово к нему. */
export function seconds(n: number): string {
  return `${n} ${plural(n, 'секунду', 'секунды', 'секунд')}`
}

/** «3 человека»: у «человек» родительный совпадает с именительным, и это не опечатка. */
export function people(n: number): string {
  return `${n} ${plural(n, 'человек', 'человека', 'человек')}`
}

/** «1 группа», «3 группы», «5 групп» — без числа: его ставят рядом. */
export function groupsWord(n: number): string {
  return plural(n, 'группа', 'группы', 'групп')
}

/** «1 ячейка», «3 ячейки», «5 ячеек»: счёт, который не режет глаз. */
export function cellsWord(n: number): string {
  return plural(n, 'ячейка', 'ячейки', 'ячеек')
}

/** 01, 02, 03 — тот же номер, который нарисован у ячейки в поле слева. */
export function pad(no: number): string {
  return String(no).padStart(2, '0')
}

/** Маркер по умолчанию — по-английски: его же называет заголовок кадра для модели. */
const TRUNCATED = (dropped: number) => `\n… truncated ${dropped} chars …\n`

/**
 * Keep the opening and the ending, say what went missing in between.
 *
 * The marker counts against the limit rather than being added on top of it: a
 * budget that the sentence explaining the budget pushes you over is not a
 * budget, and a teacher who sets contextChars to fit a small model's window
 * means the number they typed. Two passes because the marker's own length
 * depends on the figure it carries.
 *
 * The figure stays what was actually dropped: it is derived from the lengths
 * actually kept rather than from the limit.
 *
 * `mark` — потому что кадр вопроса написан по-английски, а кадр сводки
 * консилиума по-русски, и модель читает то, что вокруг. Правило обрезки при
 * этом одно: раньше сводка резала 70/30 и клала маркер СВЕРХ бюджета, то есть
 * отдавала больше, чем ей отвели.
 */
export function clip(
  text: string,
  limit: number,
  mark: (dropped: number) => string = TRUNCATED,
): string {
  if (text.length <= limit) return text

  let room = Math.max(0, limit - mark(text.length).length)
  let head = Math.ceil(room * 0.65)
  let dropped = text.length - room
  room = Math.max(0, limit - mark(dropped).length)
  head = Math.ceil(room * 0.65)
  const tail = room - head
  dropped = text.length - head - tail

  const out = `${text.slice(0, head).trimEnd()}${mark(dropped)}${text.slice(text.length - tail).trimStart()}`
  // trimEnd/trimStart only ever shorten it; the guard is for a limit so small
  // that the marker alone does not fit.
  return out.length <= limit ? out : out.slice(0, limit)
}

/** Одна строка целиком или её начало с многоточием. Переносов не трогает. */
export function clipLine(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…'
}

/** Многострочное — в одну строку: трейсбек в чипе группы читается только так. */
export function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Ошибка словами. `fallback` — для того, что не Error вовсе: в ленте оракула
 * такое показывается как есть, а в ходе агента вместо него стоит русская фраза,
 * потому что читает её комната.
 */
export function describe(err: unknown, fallback?: string): string {
  if (err instanceof Error) return err.message.trim()
  return fallback ?? String(err)
}
