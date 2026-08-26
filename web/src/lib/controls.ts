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

/** Said by every control that needs the server, so the room reads one sentence. */
export const OFFLINE_REASON = 'Waiting for the connection — nothing can run until it is back'

/**
 * The title a server-backed control should carry.
 *
 * Being offline outranks whatever else would have stopped the press: telling a
 * student "only the host can restart the kernel" while the room is disconnected
 * answers a question nobody asked, and hides the one fact that matters.
 */
export function controlTitle(connected: boolean, reason: string): string {
  return connected ? reason : OFFLINE_REASON
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
