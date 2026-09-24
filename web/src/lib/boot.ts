/**
 * The splash from `web/index.html`, and when it is taken down.
 *
 * The `#boot` shell — a logo and a bar in the middle of an empty screen — is
 * drawn without a single request and stays while the app loads. It used to be
 * removed on mount (`main.ts`), and that was a frame ahead of the truth: a
 * mounted App is not a screen yet, it is an `{#await}` over a route chunk and
 * an empty `session` and `adminAuth`. The splash left, and in its place a
 * notebook skeleton appeared out of nowhere — grey bars where there is no
 * interface at all yet. Measured on a test bench (2.5 s delay on /api/**): the
 * shell left at 430 ms, the skeleton stayed until 2.7 s, and only then did the
 * panel appear.
 *
 * So taking the shell down is tied not to mounting but to the first screen
 * HAVING SOMETHING TO SHOW: the panel has the instance state, the reader has
 * the publication, the room has the notebook's first frame. The screen says so
 * itself, with one `firstScreenReady()` call; exactly who reports is listed
 * below, so that the next screen is not forgotten.
 *
 * The shell never lives longer than `SCREEN_WAIT`, whatever happens. This is
 * not a "just in case" timeout but the limit of the genre: waiting for the
 * network under a splash is reasonable for a fraction of a second, and after
 * that the person must be shown the interface — even if it is one where the
 * data's place is taken by the very same splash (`Splash`, `size="screen"`),
 * landing exactly where `#boot` was, without a jump.
 *
 * Who reports readiness:
 *  - `App.svelte` — the refusal screen and the sign-in form, once everything
 *    about the room is known;
 *  - `AdminScreen.svelte` — when the panel knows what to draw: sign-in or
 *    itself;
 *  - `ReaderScreen.svelte` — when the course or publication has arrived (or a
 *    refusal);
 *  - `SessionScreen.svelte` — when the centre of the room is not a notebook
 *    (console, projection, an open file); the council console also waits for
 *    the stack's first frame, otherwise between the splash and itself it
 *    managed to flash "the cell is not in the council"
 *    (council.svelte.ts · boardPhase);
 *  - `Notebook.svelte` — when the notebook has stopped being "unread";
 *  - `CompetitionsScreen.svelte` — when the key from the sign-in link has been
 *    exchanged: under the splash this is one request, and an empty page under
 *    it would flash;
 *  - `main.ts` — when an app chunk failed to arrive: there is no point
 *    standing under a splash that will never get anything more.
 */

/**
 * The wait ceiling, milliseconds. Counted from applied styles, that is, from
 * the moment the shell used to leave before.
 */
export const SCREEN_WAIT = 2000

let told = false
let tell: (() => void) | null = null
const screen = new Promise<void>((resolve) => {
  tell = resolve
})

/** The first screen has something to show — the shell can come down. */
export function firstScreenReady(): void {
  if (told) return
  told = true
  tell?.()
}

/** Already reported? For tests, and for whoever wants to know if it is awaited. */
export function firstScreenShown(): boolean {
  return told
}

/**
 * Wait for the first screen, but no longer than the ceiling.
 *
 * Returns `true` if the screen reported by itself, and `false` if time ran
 * out — the caller needs this so as not to pass one off as the other in the
 * log.
 */
export function whenFirstScreen(limit = SCREEN_WAIT): Promise<boolean> {
  if (told) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), limit)
    void screen.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
