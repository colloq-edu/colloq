/**
 * A screen that does not go dark.
 *
 * iPad auto-lock defaults to two minutes. A teacher who talks for two minutes
 * without touching the tablet gets a black console mid-sentence, and the
 * laptop at the projector gets a screensaver over the slide. Before, there
 * was no protection from this at all: the whole project did not mention
 * wakeLock once.
 *
 * Three quirks of the API are why it lives here rather than being written in
 * two lines at the call site:
 *
 *  1. It may be missing. `navigator.wakeLock` exists only in a secure context
 *     and only since Safari 16.4 — a page opened in a lecture hall via
 *     `http://192.168.x.x` does not have the object at all. Hence the check
 *     `'wakeLock' in navigator`, not try/catch: "not there at all" and
 *     "refused" are different things, and they call for different words.
 *  2. The lock is released BY ITSELF as soon as the tab goes to the
 *     background — switched to mail, minimized, put the tablet into Split
 *     View — and it does not come back. The only way to survive that is to
 *     ask again on `visibilitychange`.
 *  3. It may be refused for reasons the page will never learn: low power
 *     mode, low battery. A refusal is routine, not an error, and it leaves as
 *     a state, not an exception: a screen that crashed because it was not
 *     allowed to stay on is worse than a screen that goes dark.
 *
 * The voice is the same as in `fullscreen.ts`: check, request, release. There
 * are deliberately no runes here (the file is not `.svelte.ts`) — the state is
 * returned through a callback, and whoever shows it owns it.
 */

/** `on` — holding; `refused` — asked and denied; `unavailable` — nothing to ask for. */
export type WakeState = 'on' | 'refused' | 'unavailable'

/** Whether this browser can keep the screen on at all. */
export function canKeepAwake(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

/**
 * Keep the screen on until the returned function is called.
 *
 * `report` is called on every state change, including again with the same
 * value after coming back from the background: whoever shows it must be
 * ready to be assigned the same thing.
 *
 * The returned function releases the lock and removes the listener. It can
 * be called any number of times.
 */
export function keepAwake(report: (state: WakeState) => void): () => void {
  if (!canKeepAwake()) {
    report('unavailable')
    return () => {}
  }

  let wanted = true
  let held: WakeLockSentinel | null = null
  /*
   * A retry after a refusal runs on a timer, not only on returning to the tab.
   *
   * The user agent can release the lock at any moment, even with the page
   * VISIBLE: the battery dropped, low power mode came on. Then
   * `visibilitychange` never happens, and without this timer the console
   * would claim until the end of the class that the tablet will not sleep —
   * while it falls asleep after two minutes of talking without a touch. A
   * minute, because the cause goes away by itself (the tablet was put on the
   * charger), and asking more often changes nothing and burns the same
   * battery.
   */
  const RETRY_MS = 60_000
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const retryLater = (): void => {
    if (!wanted || retryTimer !== undefined) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void ask()
    }, RETRY_MS)
  }

  const ask = async (): Promise<void> => {
    // Asking while the page is hidden is pointless — the browser will refuse,
    // and we would announce "the screen may go dark" exactly when it is dark
    // anyway. When they come back to the tab, we ask again, below.
    if (!wanted || held !== null || document.visibilityState !== 'visible') return
    try {
      const next = await navigator.wakeLock.request('screen')
      if (!wanted) {
        // While we waited, the console was already left. Release at once,
        // otherwise this lock would outlive the screen it was taken for.
        void next.release().catch(() => {})
        return
      }
      held = next
      /*
       * The browser released it — not us. On going to the BACKGROUND we stay
       * silent: the screen is dark anyway, and when they return to the tab we
       * ask again on `visibilitychange`. But a lock released while the page is
       * VISIBLE is a refusal, and we must not keep quiet about it: whoever
       * shows the state would go on promising that the screen stays on.
       */
      next.addEventListener('release', () => {
        if (held !== next) return
        held = null
        if (!wanted || document.visibilityState !== 'visible') return
        report('refused')
        retryLater()
      })
      report('on')
    } catch {
      held = null
      report('refused')
      retryLater()
    }
  }

  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void ask()
  }

  document.addEventListener('visibilitychange', onVisible)
  void ask()

  return () => {
    wanted = false
    clearTimeout(retryTimer)
    retryTimer = undefined
    document.removeEventListener('visibilitychange', onVisible)
    const last = held
    held = null
    if (last) void last.release().catch(() => {})
  }
}

/*
 * TAKE THE CONSOLE — one gesture, two permissions.
 *
 * The browser grants both fullscreen and "stay awake" only from a live touch:
 * from an effect after navigation the first is silently rejected, and the
 * second most often too (Safari wants a gesture for it as well). So the
 * "Tap to take the console" landing screen calls `goFullscreen` and then
 * `keepAwake` in one handler, and imports both FROM HERE: two entry points
 * from two modules for a single tap is exactly the gap where one of them gets
 * forgotten.
 *
 * The fullscreen mechanism itself stays in `fullscreen.ts`: it is shared with
 * the projection, and the projection is not forbidden to sleep — the laptop at
 * the projector has its own settings, and there is no reason to touch them
 * from the browser. Here there is only an adapter, and it answers NOT with
 * "nothing" but with "did it work": after a refusal the console shows a
 * "Fullscreen ▸" strip and has to know whether to show it again.
 */
import { fullscreenNow, goFullscreen as enter } from './fullscreen'

export { fullscreenPossible } from './fullscreen'

/**
 * Expand a node to full screen. `true` — expanded; `false` — refused or not
 * possible (iPhone), and the console goes on living in a window.
 */
export async function goFullscreen(node: Element): Promise<boolean> {
  await enter(node as HTMLElement)
  return fullscreenNow()
}
