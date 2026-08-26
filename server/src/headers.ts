/**
 * The headers every response carries, and why each one is here.
 *
 * A seminar is one shared document rendered in everybody's browser, so the
 * sanitizer in the web app is doing real work on every text cell. A sanitizer
 * is one layer, and it is the layer that has to keep guessing; these say no
 * once, for everything, and none of them constrains anything the product does.
 */

/**
 * Four things a seminar page is never asked to do.
 *
 *   object-src       nothing here embeds a plugin
 *   base-uri         nothing rewrites the document base
 *   form-action      every form in the app posts to this origin
 *   frame-ancestors  a seminar is not framed by anybody
 *
 * Deliberately absent: script-src and style-src. The app shell carries an
 * inline theme script that has to run before the first paint and an inline
 * stylesheet that paints it, and the webfonts come from Google's origin, so
 * policing those needs 'unsafe-inline' anyway — a longer header buying nothing.
 * What that would have covered is covered where it belongs, in the tags a text
 * cell may not carry (web/src/lib/sanitize.ts).
 */
export const CONTENT_SECURITY_POLICY = [
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  /** A .csv the room uploaded must not be sniffed into something executable. */
  'X-Content-Type-Options': 'nosniff',
  /**
   * A seminar link is the whole authentication story — the path IS the secret.
   * This sends the origin and never the path when a note links out, so an image
   * or a link a student writes cannot hand the room's door to a third party.
   */
  'Referrer-Policy': 'strict-origin-when-cross-origin',
})
