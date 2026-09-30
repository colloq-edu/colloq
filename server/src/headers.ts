/**
 * The headers every response carries, and why each one is here.
 *
 * A seminar is one shared document rendered in everybody's browser, so the
 * sanitizer in the web app is doing real work on every text cell. A sanitizer
 * is one layer, and it is the layer that has to keep guessing; these say no
 * once, for everything, and none of them constrains anything the product does.
 *
 * No imports from the rest of the server on purpose: tests read these values
 * without setting up a data directory (security-headers.test.mts).
 */
import { isIP } from 'node:net'

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
 * stylesheet that paints it, so policing either needs 'unsafe-inline' anyway —
 * a longer header buying nothing. What that would have covered is covered where
 * it belongs, in the tags a text cell may not carry (web/src/lib/sanitize.ts).
 *
 * The webfonts used to be part of that argument and no longer are: JetBrains
 * Mono and HSE Sans are served from /fonts and declared @font-face in
 * web/index.html, so the room page has no external origin left at all. That
 * makes font-src 'self' the one directive here that could be tightened without
 * 'unsafe-inline' — say so out loud, because the next person to read this
 * should not have to re-derive it. It is not added yet for one reason: a CSP
 * that blocks a font fails silently and in the type, and this header is set on
 * every response the process makes, including a web/dist built before the fonts
 * moved. Add it together with a check that the served bundle self-hosts them.
 *
 * `script-src 'self'` was weighed again for the university install (September
 * 2026) and stays out, for reasons the built page, not the source, shows. It
 * carries five inline scripts: two from web/index.html and three the build
 * writes into the head (web/vite.config.ts · firstPaint), one of which lists
 * the build's own file names, so its hash changes with every release. And each
 * preloaded stylesheet is switched on by an inline `onload` handler. Hashes
 * would have to be computed from the served bundle at start, and a handler can
 * be allowed only with 'unsafe-hashes', which older Safari and Firefox do not
 * know: there the stylesheet would never apply, and main.ts shows the app
 * undressed once it stops waiting for it. Nothing needs eval: the plotly frame
 * answers with a policy of its own (routes/plotly.ts), and pdf.js falls back
 * without it in its worker. So the day the handlers leave the build, this
 * becomes a hash list read from web/dist/index.html.
 */
export const CONTENT_SECURITY_POLICY = [
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * Half a year of "this name speaks https only", for this name alone.
 *
 * A student who types the room's address by hand, or follows an old http
 * link, otherwise makes the first request in the clear, where the café Wi-Fi
 * can answer instead of the university. No includeSubDomains: a university
 * domain holds plenty of http-only hosts that are not ours to pin. HSTS=0
 * turns it off (net/inbound.ts), for a name that must go back to plain http.
 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=15552000'

/**
 * Whether this response carries STRICT_TRANSPORT_SECURITY.
 *
 * Only on a request that arrived over https, by the same test the cookies use
 * for Secure (admin/auth.ts · secureCookie): the connection itself, or the
 * proxy's X-Forwarded-Proto. A client that fakes that header over plain http
 * gains nothing: browsers ignore the header on an insecure response. Never for
 * localhost or a bare IP address: browsers do not pin an IP, and localhost
 * pinned to https would break every other development server on that machine
 * for half a year.
 */
export function sendsStrictTransport(input: { enabled: boolean; https: boolean; hostname: string }): boolean {
  if (!input.enabled || !input.https) return false
  const name = input.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!name || name === 'localhost' || name.endsWith('.localhost')) return false
  return isIP(name) === 0
}

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
