/**
 * The council console window: how to open it, where it stood and whether it is
 * open.
 *
 * The console is a separate browser window, not a panel: the 308 list and the
 * 591 work pane must stand side by side (Paper · 05c · board 11), and that does
 * not fit into the notebook's right panel. Hence two problems the product did
 * not have before.
 *
 * THE FIRST — placement. The browser remembers window sizes by itself only for
 * a window the user opened; a window opened by a script lands wherever it is
 * told every time. So the position and size are remembered per room in
 * localStorage, and the second time the console opens exactly there. This is
 * BEST EFFORT: the last word still belongs to the browser and the window
 * manager, and a refusal here breaks nothing.
 *
 * THE SECOND — "is it open". There is one button under the cell, and it must
 * know what to do: open the window, raise it, or switch it to this cell (there
 * is one console per room — otherwise it is a second place with names, which
 * is what the window was set up to avoid). A reference to the window is not
 * enough for that: `window.open` returns a handle, but neither `closed` nor
 * `onunload` survives a reload of the notebook, and the notebook tab does get
 * reloaded. The window itself knocks on a BroadcastChannel once a second, and
 * the notebook considers it open while the last knock is younger than three
 * seconds. Silence means closed: the absence of news of its death must not
 * leave the button in the "Console is open" position forever.
 *
 * No runes and no DOM: `beatsAlive` and `windowFeatures` are checked by tests.
 */

/** Shared by the whole browser — the message carries the room and the cell. */
export const PULT_CHANNEL = 'colloq-council-pult'
/** How often the window knocks. */
export const PULT_BEAT_MS = 1000
/** Older than this — we consider it closed. Three knocks: one missed is too few. */
export const PULT_STALE_MS = 3000

export const PULT_WIDTH = 1120
export const PULT_HEIGHT = 820
export const PULT_MIN_WIDTH = 760
export const PULT_MIN_HEIGHT = 600
/**
 * The share of the screen beyond which a "window" stops being a window.
 *
 * The remembered placement is best effort, but one of its values is
 * poisonous: FULL SCREEN. A console opened once as a tab or by direct address
 * (which is how it gets opened when the window's link is pasted into the
 * address bar) wrote the geometry of the WHOLE browser into memory — and the
 * next `window.open` asked for a screen-sized popup from point 0,0. Such a
 * window cannot be told from a tab in any way, and the complaint "it opens as
 * a tab" stays true forever after that: every opening confirmed the memory
 * for the next one.
 *
 * Hence 0.95: a placement larger than this share on BOTH sides counts not as
 * a placement but as the trace of a tab, and the window opens with the
 * default — 1120×820 wherever the browser puts it. An error in this direction
 * costs one window drag; an error in the other costs the very possibility of
 * sharing one window out of two.
 */
export const PULT_MAX_SHARE = 0.95

/** How much room the screen has at all. `null` — the screen is unknown (test, SSR). */
export interface PultScreen {
  width: number
  height: number
}

export interface PultBeat {
  sessionId: string
  cellId: string
  at: number
  /** The window is leaving: `pagehide` sends this to skip three seconds of silence. */
  closed?: boolean
}

export interface PultPlace {
  left: number
  top: number
  width: number
  height: number
}

/** Whether the window is alive, by its last knock. `null` — it has never knocked. */
export function beatsAlive(beat: PultBeat | null, now: number): boolean {
  if (!beat || beat.closed) return false
  // The neighbouring window's clock is the same (`Date.now` of one machine), but
  // on a laptop woken from sleep a knock from a couple of ms in the future happens.
  return now - beat.at < PULT_STALE_MS
}

/** The window name: one room — one window, a second cell reuses it. */
export function pultWindowName(sessionId: string): string {
  return `colloq-council-pult-${sessionId}`
}

/** The console address. The same parsing as in lib/routes.ts. */
export function pultPath(sessionId: string, cellId: string): string {
  return `/s/${sessionId}/council/${cellId}`
}

const placeKey = (sessionId: string): string => `colloq.council.pult.${sessionId}`

/** This machine's screen as the browser knows it. `null` — nowhere to ask. */
export function availScreen(): PultScreen | null {
  try {
    const { availWidth, availHeight } = window.screen
    if (!Number.isFinite(availWidth) || !Number.isFinite(availHeight)) return null
    if (availWidth <= 0 || availHeight <= 0) return null
    return { width: availWidth, height: availHeight }
  } catch {
    return null
  }
}

/**
 * Whether this placement takes the whole screen — that is, the trace of a tab,
 * not of the console.
 *
 * On BOTH sides at once: a console stretched to full height on a narrow
 * monitor is common, while a window the size of the screen in both width and
 * height is never the console.
 */
export function fillsScreen(place: PultPlace, screen: PultScreen | null): boolean {
  if (!screen) return false
  return place.width >= screen.width * PULT_MAX_SHARE && place.height >= screen.height * PULT_MAX_SHARE
}

/**
 * A placement that MAY be requested from the browser — or `null` if there is
 * nothing to request.
 *
 * It clamps from two sides, and these are two different concerns. From below
 * — so that the window does not open as a 200 px slit: the list and the work
 * must stand side by side. From above — the cure for the poisoned memory: a
 * full-screen placement is thrown out ENTIRELY rather than trimmed, because a
 * window trimmed by five percent still reads as a tab, and one trimmed more
 * would lie about where it was left.
 *
 * Coordinates are neither touched nor clamped: a negative `left` is a second
 * monitor on the left, and `screen` knows nothing about it. A console left on
 * a neighbouring monitor must come back there.
 */
export function fitPlace(place: PultPlace, screen: PultScreen | null): PultPlace | null {
  if (fillsScreen(place, screen)) return null
  const left = Math.round(place.left)
  const top = Math.round(place.top)
  let width = Math.max(PULT_MIN_WIDTH, Math.round(place.width))
  let height = Math.max(PULT_MIN_HEIGHT, Math.round(place.height))
  if (screen) {
    width = Math.max(PULT_MIN_WIDTH, Math.min(width, Math.round(screen.width * PULT_MAX_SHARE)))
    height = Math.max(PULT_MIN_HEIGHT, Math.min(height, Math.round(screen.height * PULT_MAX_SHARE)))
  }
  return { left, top, width, height }
}

/**
 * Whether this placement is worth remembering.
 *
 * `ownWindow` — whether we opened the window (`window.opener` exists). A
 * console opened as a tab or by direct address measures the WHOLE browser,
 * and its geometry is not the console's placement but the size of someone
 * else's window; writing it down means poisoning the next opening. The second
 * condition is the same thing, but for the case where `opener` exists and the
 * window has meanwhile been maximised to full screen.
 */
export function savesPlace(place: PultPlace, screen: PultScreen | null, ownWindow: boolean): boolean {
  return ownWindow && !fillsScreen(place, screen)
}

/** Where the window stood last time. Garbage and a tab's trace count as nothing. */
export function readPultPlace(sessionId: string, screen = availScreen()): PultPlace | null {
  try {
    const raw = localStorage.getItem(placeKey(sessionId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const place = parsed as Record<string, unknown>
    const numbers = ['left', 'top', 'width', 'height'].map((key) => place[key])
    if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
    return fitPlace(place as unknown as PultPlace, screen)
  } catch {
    return null
  }
}

/**
 * Remember the placement — if it is a console placement at all.
 *
 * The second checkpoint after `savesPlace`: that one knows about
 * `window.opener`, this one about the screen, and full-screen geometry cannot
 * be written from here by any means. One forgotten check at the caller would
 * cost a poisoned memory for the whole room — and a complaint "the console
 * opens as a tab" that nothing could explain afterwards.
 */
export function savePultPlace(sessionId: string, place: PultPlace, screen = availScreen()): void {
  if (fillsScreen(place, screen)) return
  try {
    localStorage.setItem(placeKey(sessionId), JSON.stringify(place))
  } catch {
    // A private window, a full storage — the placement simply will not be remembered.
  }
}

/**
 * Whether the browser seems to be in full screen.
 *
 * Not asked out of curiosity: in full-screen Chrome and Safari on macOS a
 * popup lands as a TAB in the same space, whatever `features` says — and this
 * is the only part of the "it opens as a tab" complaint that code cannot fix.
 * Since it cannot be fixed, it is put into words, and exactly when it is true.
 *
 * `document.fullscreenElement` knows only about the full-screen mode a script
 * turned on; it does not see the macOS green button. That one shows
 * differently: the window covers the screen ENTIRELY, menu bar included — that
 * is, `outerHeight` grows to `screen.height`, not to `availHeight`.
 */
export function looksFullscreen(): boolean {
  try {
    if (document.fullscreenElement) return true
    const { width, height, availHeight } = window.screen
    if (!Number.isFinite(height) || height <= 0) return false
    // A maximised (not full-screen) window stops at availHeight and does not
    // cover the menu bar — the difference between the two is the sign.
    if (availHeight >= height) return false
    return window.outerHeight >= height - 2 && window.outerWidth >= width - 2
  } catch {
    return false
  }
}

/**
 * The `features` string for `window.open`.
 *
 * `popup=yes` is mandatory: without it Chrome opens a TAB and silently ignores
 * the size, and a console in a tab is the same notebook a second time.
 * Coordinates are set only when they are known: `left=NaN` breaks the whole
 * string.
 */
export function windowFeatures(place: PultPlace | null): string {
  const parts = [
    'popup=yes',
    'noopener=no',
    `width=${place?.width ?? PULT_WIDTH}`,
    `height=${place?.height ?? PULT_HEIGHT}`,
  ]
  if (place) parts.push(`left=${place.left}`, `top=${place.top}`)
  return parts.join(',')
}

/**
 * Open the console — or raise the one already open.
 *
 * The window name does all the work: a second `window.open` with the same name
 * does not open a second window but returns the first, and all that is left
 * is to focus it. `null` — the window was blocked: the caller says so in
 * words, because a silent button reads as a broken one.
 */
export function openPult(sessionId: string, cellId: string): Window | null {
  const place = readPultPlace(sessionId)
  let opened: Window | null = null
  try {
    opened = window.open(pultPath(sessionId, cellId), pultWindowName(sessionId), windowFeatures(place))
  } catch {
    return null
  }
  try {
    opened?.focus()
  } catch {
    // Cross-window focus can refuse; the window is open all the same.
  }
  return opened
}

/**
 * Knock from the console window. Returns "stop": the last message sent is
 * `closed`, so that the notebook unfolds the console at once, not three
 * seconds later.
 */
export function announcePult(sessionId: string, cellId: string): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(PULT_CHANNEL)
  const beat = (closed = false): void => {
    const message: PultBeat = { sessionId, cellId, at: Date.now(), ...(closed ? { closed: true } : {}) }
    try {
      channel.postMessage(message)
    } catch {
      // The channel was closed before the timer — nowhere left to knock.
    }
  }
  beat()
  const timer = setInterval(() => beat(), PULT_BEAT_MS)
  const bye = (): void => beat(true)
  window.addEventListener('pagehide', bye)
  return () => {
    clearInterval(timer)
    window.removeEventListener('pagehide', bye)
    bye()
    channel.close()
  }
}

/**
 * Listen for knocks from the notebook. `onbeat` is called on every message of
 * THIS room; the caller decides "alive or not" by `beatsAlive` — it is also
 * the one that needs a timer for the fade.
 */
export function watchPult(sessionId: string, onbeat: (beat: PultBeat) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(PULT_CHANNEL)
  channel.onmessage = (event: MessageEvent<PultBeat>) => {
    const beat = event.data
    if (!beat || beat.sessionId !== sessionId) return
    onbeat(beat)
  }
  return () => channel.close()
}

/**
 * What to do with the window when the teacher asks for the console of THIS
 * cell.
 *
 * There is one window per room (`pultWindowName`), but several councils can be
 * running in a notebook, and the three cases differ by the last knock:
 *  — not knocking — open;
 *  — knocking for this cell — raise it without reloading;
 *  — knocking for another one — switch it over here rather than opening a
 *    second window next to it: two consoles of one room are two places with
 *    names, which is what the window was set up to avoid.
 * The decision is a separate function without DOM — a test checks it.
 */
export type PultReach = 'open' | 'navigate' | 'focus'

export function pultReach(beat: PultBeat | null, cellId: string, now: number): PultReach {
  if (!beatsAlive(beat, now)) return 'open'
  return beat?.cellId === cellId ? 'focus' : 'navigate'
}

/**
 * Raise the already open window WITHOUT reloading it.
 *
 * `window.open` with an empty address finds the window by name and opens
 * nothing in it — otherwise a repeated address would reload the console and
 * wipe the filter, the cursor and the expanded groups, that is, the whole way
 * of looking. Called only when the knock says the window is alive: without a
 * live window an empty address would open an empty one.
 */
export function focusPult(sessionId: string): Window | null {
  try {
    const opened = window.open('', pultWindowName(sessionId))
    opened?.focus()
    return opened
  } catch {
    return null
  }
}
