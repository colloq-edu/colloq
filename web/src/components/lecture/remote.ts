/**
 * What a presentation clicker sends, agreed on once for the console, the
 * laptop bar and the projection.
 *
 * A USB clicker is a keyboard with four or five keys, plugged most often
 * into the laptop at the projector. The common ones (Logitech R400 and its
 * kin) send PageUp/PageDown for the arrows, a "slideshow" key that alternates
 * F5 and Escape, and a "black screen" key that sends '.' (PowerPoint's
 * shortcut; B, W and ',' are its siblings). Every one of those keys used to do
 * something harmful or nothing in a browser window: F5 reloaded the
 * projection, the second press (Escape) closed it in front of the hall, and
 * the blank key did nothing.
 *
 * Letters are read by `code`, not by `key`: on a Russian layout `key` is
 * "и", "ц", "ю" and "б", while a clicker sends the same codes everywhere.
 */

/** Keys that blank the screen for the hall and bring it back. */
export const BLANK_KEYS: ReadonlySet<string> = new Set(['KeyB', 'KeyW', 'Period', 'Comma'])

/**
 * How long the projection waits for the second Escape before forgetting the
 * first. Long enough for a deliberate double press, short enough that two
 * presses of the clicker's slideshow key a minute apart never add up.
 */
export const ESCAPE_AGAIN_MS = 1500

/**
 * The clicker's reload: F5, with or without Shift (`key` is "F5" either
 * way). Ctrl/Cmd+R is deliberately not caught: that is a person at the
 * laptop who means it, and the projection answers them with the browser's
 * "leave the page?" question instead (see SessionScreen).
 */
export function isClickerReload(event: Pick<KeyboardEvent, 'key'>): boolean {
  return event.key === 'F5'
}
