import type { Locale } from '../../shared/i18n-types.js'

/**
 * What each route of the built app fetches at once, per language.
 *
 * Written next to the build by the first-paint plugin (web/vite.config.ts),
 * from the same lists it writes into the head scripts, and read by the perf
 * harness (scripts/perf.mts). The harness used to recover these lists by
 * pulling every "/assets/…" literal out of the head scripts, which cannot see
 * the conditions around them: the panel's and the reader's files, in both
 * languages, were charged to a seminar link, and the room's own files, behind
 * a script it skipped, were counted as lazy.
 *
 * Under .vite/, like Vite's own manifest: the static handler does not serve
 * dotfiles and the wheel leaves the folder out (scripts/pack.mts), so the
 * file stays with the build and is never sent to a browser.
 */
export const PRELOAD_MANIFEST = '.vite/colloq-preload.json'

export type PreloadRoute = 'room' | 'admin' | 'reader'

export interface RoutePreload {
  /** The addresses the route answers, for whoever reads the file. */
  paths: string[]
  /**
   * When the head asks for `preload`: on load, or on load only for a saved
   * identity in that room and after the join form paints for everyone else.
   */
  warm: 'at-once' | 'after-form-unless-known'
  /** Exactly what the head script requests on this route, per language. */
  preload: Record<Locale, string[]>
  /**
   * Everything the route fetches at once beyond `entry`, per language: the
   * preloads plus the chunks and stylesheets importing the screen pulls in
   * statically. On the room the two lists are the same; the panel's and the
   * reader's heads name only the screen and leave its imports to Vite's
   * preload helper, which fetches them when App imports the screen.
   */
  fetch: Record<Locale, string[]>
}

export interface PreloadManifest {
  version: 1
  /**
   * Fetched at once on every route: the entry script's graph, the form's code
   * (App and its static imports, named in the head by tag) and their
   * stylesheets, the page's own included.
   */
  entry: string[]
  routes: Record<PreloadRoute, RoutePreload>
}
