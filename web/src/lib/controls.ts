import { tr } from '@shared/i18n'
/**
 * What a control that needs the server may say and do while the server is gone.
 *
 * The header already tells the truth when the socket drops: the kernel pill
 * dims to "Last known" and a RECONNECTING spinner appears beside it. The
 * buttons used to disagree with it — Run, Interrupt, Restart and the terminal
 * stayed fully lit, a press produced no queue position, no spinner, no word at
 * all, and the request sat in a queue until the network came back. A student
 * who cannot tell whether a press landed presses again, so a thirty-second
 * blip in a lecture hall turned into the same cell running five times over,
 * with whatever it writes to disk done five times too.
 *
 * Nothing here is new machinery. Every one of these buttons already carries a
 * `disabled` and a `title` saying who may press it; this adds one more reason
 * and makes it win, because it is the reason nothing at all can happen.
 *
 * The notebook itself stays editable while disconnected — Yjs is local-first
 * and the typing syncs on reconnect. Only what has to travel to the server is
 * held back.
 */

/**
 * Said by every control that needs the server, so the room reads one sentence.
 *
 * По-русски: она приезжает в title «Очистить» в ящике терминала, в полосу
 * запуска и на пульт лекции — всё это поверхности, переведённые целиком, и
 * английская строка в них выглядит сбоем, а не сообщением.
 */
export const OFFLINE_REASON = "Нет связи с сервером. Повторите запуск после подключения"

/**
 * The title a server-backed control should carry.
 *
 * Being offline outranks whatever else would have stopped the press: telling a
 * student "only the host can restart the kernel" while the room is disconnected
 * answers a question nobody asked, and hides the one fact that matters.
 */
export function controlTitle(connected: boolean, reason: string): string {
  return connected ? reason : tr(OFFLINE_REASON)
}

/**
 * Whether a press should be refused, given the control's own rule.
 *
 * `allowed` is what the control already decided — host-only, runner-only, and
 * so on. This only ever takes permission away.
 */
export function controlDisabled(connected: boolean, allowed = true): boolean {
  return !connected || !allowed
}

/**
 * The queue a press lands in when the socket is closing under it.
 *
 * With the controls disabled this window is about one frame wide, but it is
 * real: `connected` turns false when the socket fires `close`, and a click
 * already in flight is dispatched before Svelte repaints. Keeping those is
 * right — they were pressed while the room still looked live.
 *
 * Two rules, both about not multiplying work. An identical message queued twice
 * is queued once: pressing Run on the same cell twice in that window means run
 * it, not run it twice. And the queue is short, because a press that cannot be
 * delivered promptly is stale by the time it could be.
 */
export const MAX_QUEUED_CONTROL = 16

export function enqueueControl<T>(queue: T[], message: T): T[] {
  const encoded = JSON.stringify(message)
  if (queue.some((q) => JSON.stringify(q) === encoded)) return queue
  queue.push(message)
  if (queue.length > MAX_QUEUED_CONTROL) queue.splice(0, queue.length - MAX_QUEUED_CONTROL)
  return queue
}

/* ------------------------------------------------------- возвращение связи */

/** Дольше этого не ждём: полминуты «Reconnecting» — это уже не связь, а стена. */
export const RECONNECT_MAX_MS = 8000

/**
 * Через сколько стучаться снова — с разбросом, и разброс здесь несущий.
 *
 * Связь роняет обычно не одна вкладка, а провод: перезапуск сервера, упавший
 * Wi-Fi в аудитории, ретранслятор. Тогда все пятьсот отсчитывают ОДИН И ТОТ ЖЕ
 * отступ от одного и того же события и возвращаются в одни и те же
 * миллисекунды: сервер поднимается ровно в этот момент, получает пятьсот
 * рукопожатий разом, часть не успевает — эти вкладки отступают снова и снова
 * приходят вместе. Пачка не рассасывается сама, она только уплотняется.
 *
 * Половина отступа случайна, вторая — та же лестница вдвое, что была: 250 мс
 * после первой неудачи, дальше вдвое, потолок прежний. Дольше никого ждать не
 * заставляем — верхняя граница не выросла.
 *
 * `random` — параметром, чтобы правило проверялось без броска монеты: у
 * генератора нет ни одного значения, при котором две вкладки обязаны сойтись.
 */
export function reconnectDelay(retries: number, random = Math.random()): number {
  const step = Math.min(500 * 2 ** Math.min(retries, 5), RECONNECT_MAX_MS)
  return step * (0.5 + random * 0.5)
}

/* ------------------------------------------- отступ общего документа */

/**
 * Потолок отступа у провайдера общего документа — свой у каждой вкладки.
 *
 * Управляющий сокет разброс себе давно взял (`reconnectDelay` выше), а общий
 * документ вёл y-websocket со своей лестницей: `min(2^n · 100 мс,
 * maxBackoffTime)`, и `maxBackoffTime` по умолчанию 2500 мс — ОДИН И ТОТ ЖЕ у
 * всех. То есть после шестой неудачи пятьсот вкладок стучатся ровно каждые две
 * с половиной секунды, все вместе, от одного и того же события: сервер
 * поднимается, получает пятьсот рукопожатий в одну миллисекунду, часть
 * отваливается — и эти приходят вместе снова. Пачка не рассасывается, она
 * уплотняется.
 *
 * Другой ручки у провайдера нет: в самой лестнице разброса не предусмотрено,
 * зато потолок он читает у себя же на каждой попытке. Случайный потолок и
 * растаскивает пачку — на шесть секунд, то есть заметно шире окна, в которое
 * сервер принимает рукопожатие.
 *
 * Нижняя граница НЕ ниже прежних 2500 мс: ждать дольше — цена, и она названа
 * вслух. Возврат всё равно наступает раньше, потому что первые попытки идут по
 * той же лестнице от ста миллисекунд и потолка не достигают.
 *
 * `random` — параметром, чтобы правило проверялось без броска монеты.
 */
export const COLLAB_BACKOFF_MIN_MS = 4000
export const COLLAB_BACKOFF_SPREAD_MS = 6000

export function collabBackoff(random = Math.random()): number {
  return Math.round(COLLAB_BACKOFF_MIN_MS + random * COLLAB_BACKOFF_SPREAD_MS)
}
