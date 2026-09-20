/**
 * Уровень размышлений, запомненный в браузере.
 *
 * Не правило комнаты и не настройка человека на сервере: это то же самое, что
 * «Спросить/Сделать» рядом с полем — выбор, который держится между вопросами и
 * никого, кроме этой вкладки, не касается. Правил у комнаты и так больше, чем
 * помещается на экран, а человек, поставивший «сразу», хочет его на сегодня, а
 * не на весь семинар.
 *
 * `null` — «как на инстансе»: тогда в запрос не уходит ни поля `effort`, ни
 * чего-либо ещё, и чужие инстансы ведут себя ровно как до этой ручки. Оно же
 * и есть умолчание.
 */
import type { ReasoningEffort } from '@shared/admin'
import { isReasoningEffort } from '@shared/admin'

const KEY = 'colloq.oracle.effort'

/**
 * Что выбрано в этом браузере. Любая ошибка чтения — «как на инстансе»:
 * приватное окно, запрещённые данные сайта и чужая строка в ключе не должны
 * мешать спросить.
 */
export function rememberedEffort(): ReasoningEffort | null {
  try {
    const raw = localStorage.getItem(KEY)
    return isReasoningEffort(raw) ? raw : null
  } catch {
    return null
  }
}

/** Запомнить выбор; `null` стирает строку — вернулись к умолчанию инстанса. */
export function rememberEffort(effort: ReasoningEffort | null): void {
  try {
    if (effort === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, effort)
  } catch {
    /* запомнить не вышло — выбор всё равно действует до закрытия вкладки */
  }
}
