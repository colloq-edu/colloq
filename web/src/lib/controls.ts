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
 * In Russian: it lands in the title of "Clear" in the terminal drawer, in the
 * run bar and on the lecture console — all of them surfaces translated in
 * full, where an English line looks like a glitch rather than a message.
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
  const key = snapshotKey(message)
  const encoded = JSON.stringify(message)
  // A command consumes the preceding state. Never coalesce snapshots across it
  // or deduplicate a later command across intervening state changes.
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const previousKey = snapshotKey(queue[i])
    if (key !== null) {
      if (previousKey === null) break
      if (previousKey === key) queue.splice(i, 1)
    } else {
      if (previousKey !== null) break
      if (JSON.stringify(queue[i]) === encoded) return queue
    }
  }
  queue.push(message)
  if (queue.length > MAX_QUEUED_CONTROL) queue.splice(0, queue.length - MAX_QUEUED_CONTROL)
  return queue
}

/** Only these messages replace a complete resource state; all others are commands. */
function snapshotKey(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const value = message as Record<string, unknown>
  if (value.t === 'council:draft' && typeof value.cellId === 'string')
    return JSON.stringify([value.t, value.cellId])
  if (value.t === 'notes:set' && typeof value.file === 'string' && typeof value.page === 'number')
    return JSON.stringify([value.t, value.file, value.page])
  return null
}

/* ------------------------------------------------------------ reconnecting */

/** We wait no longer than this: half a minute of "Reconnecting" is a wall, not a link. */
export const RECONNECT_MAX_MS = 8000

/**
 * How long until knocking again — with jitter, and the jitter is load-bearing.
 *
 * It is usually not one tab that drops the connection but the wire: a server
 * restart, the lecture hall's Wi-Fi going down, the relay. Then all five
 * hundred count down THE SAME backoff from the same event and come back in the
 * same milliseconds: the server comes up at exactly that moment, gets five
 * hundred handshakes at once, some do not make it — those tabs back off again
 * and again arrive together. The burst does not disperse by itself, it only
 * gets denser.
 *
 * Half of the backoff is random, the other half is the same doubling ladder as
 * before: 250 ms after the first failure, then doubling, the same ceiling.
 * Nobody is made to wait longer — the upper bound did not grow.
 *
 * `random` is a parameter so the rule can be checked without tossing a coin:
 * the generator has no value at which two tabs are bound to coincide.
 */
export function reconnectDelay(retries: number, random = Math.random()): number {
  const step = Math.min(500 * 2 ** Math.min(retries, 5), RECONNECT_MAX_MS)
  return step * (0.5 + random * 0.5)
}

/* ------------------------------------------- shared document backoff */

/**
 * The backoff ceiling of the shared-document provider — different in every tab.
 *
 * The control socket took jitter for itself long ago (`reconnectDelay` above),
 * but the shared document was driven by y-websocket with its own ladder:
 * `min(2^n · 100 ms, maxBackoffTime)`, and `maxBackoffTime` defaults to
 * 2500 ms — THE SAME for everyone. So after the sixth failure five hundred tabs
 * knock exactly every two and a half seconds, all together, from the same
 * event: the server comes up, gets five hundred handshakes in one millisecond,
 * some fall off — and those arrive together again. The burst does not
 * disperse, it gets denser.
 *
 * The provider has no other knob: its ladder has no jitter, but it reads the
 * ceiling from itself on every attempt. A random ceiling is what pulls the
 * burst apart — over six seconds, noticeably wider than the window in which
 * the server accepts a handshake.
 *
 * The lower bound is NOT below the former 2500 ms: waiting longer is a cost,
 * and it is named out loud. Reconnection still comes sooner, because the first
 * attempts follow the same ladder from a hundred milliseconds and never reach
 * the ceiling.
 *
 * `random` is a parameter so the rule can be checked without tossing a coin.
 */
export const COLLAB_BACKOFF_MIN_MS = 4000
export const COLLAB_BACKOFF_SPREAD_MS = 6000

export function collabBackoff(random = Math.random()): number {
  return Math.round(COLLAB_BACKOFF_MIN_MS + random * COLLAB_BACKOFF_SPREAD_MS)
}
