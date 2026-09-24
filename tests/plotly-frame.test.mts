/**
 * The frame in which somebody else's chart is drawn, and its policy.
 *
 * What is checked here is exactly what makes the frame a sandbox rather than
 * just a second `<div>`: the header. A failure here is doubly silent — the page
 * will keep showing charts as if nothing happened, only foreign code will again
 * sit next to the room token. So the directives are checked one by one, with an
 * explanation of what each is responsible for.
 *
 * That the sandbox itself works is a property of the browser, and it was
 * measured live: in the frame `window.origin === "null"`, and `document.cookie`,
 * `localStorage` and `window.parent.document` throw SecurityError. The header
 * comes from the same measurement: `img-src data: blob:` refused a figure image
 * from a foreign address.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { app } from '../server/src/app.js'
import { FRAME_HTML, frameOrigin, framePolicy } from '../server/src/plotly-frame.js'
import { CONTENT_SECURITY_POLICY } from '../server/src/headers.js'
import {
  PLOTLY_BUNDLE_PATH,
  PLOTLY_FRAME_PATH,
  PLOTLY_MSG,
  PLOTLY_ORIGIN_PARAM,
} from '../shared/plotly.js'

const ORIGIN = 'http://localhost:5173'
const policy = framePolicy(ORIGIN)
const directives = new Map(
  policy.split('; ').map((one) => {
    const at = one.indexOf(' ')
    return at < 0 ? [one, ''] : [one.slice(0, at), one.slice(at + 1)]
  }),
)

/* ----------------------------------------------------------- the policy */

test('the frame origin is opaque, and the header does that, not the attribute', () => {
  /*
   * `sandbox` from the header applies even when the address is opened directly
   * in a separate tab (verified live: there too `window.origin === "null"`).
   * The `sandbox` attribute on the `<iframe>` is set as well, but it is the
   * second line: it is visible from the page DOM, and the header is not.
   */
  assert.ok(directives.has('sandbox'), 'without sandbox the frame origin stays ours')
  assert.match(directives.get('sandbox')!, /\ballow-scripts\b/)
  // `allow-same-origin` here would cancel the whole idea: it gives the frame our
  // origin back, and with it cookies, localStorage and access to the page DOM.
  assert.ok(!/allow-same-origin/.test(directives.get('sandbox')!))
})

test('exactly two scripts: our loader by hash and the bundle by exact address', () => {
  const scripts = directives.get('script-src')!.split(' ')
  assert.equal(scripts.length, 2, `script-src has ${scripts.length} sources: ${scripts.join(' ')}`)
  assert.match(scripts[0], /^'sha256-[A-Za-z0-9+/=]+'$/, 'the loader is not allowed by hash')
  assert.equal(scripts[1], `${ORIGIN}${PLOTLY_BUNDLE_PATH}`)
  /*
   * `'self'` is absent on purpose. In the sandbox the origin is opaque, so the
   * word has nothing to rest on — and where it does match after all (Chrome
   * reads it from the ADDRESS of the response, this was measured), it lets any
   * file of our instance into the frame, including what students uploaded to the room.
   */
  assert.ok(!/'self'/.test(directives.get('script-src')!))
  assert.ok(!/unsafe-eval/.test(policy), 'the strict build of plotly does not need eval, and must not get it')
  assert.ok(!/unsafe-inline/.test(directives.get('script-src')!))
})

test('the loader hash is computed from the very text that goes into the markup', () => {
  const inline = /<script>([\s\S]*?)<\/script>/.exec(FRAME_HTML)
  assert.ok(inline, 'the frame markup has no inline loader')
  const hash = directives.get('script-src')!.split(' ')[0].slice(1, -1) // without the quotes
  const [algorithm, digest] = hash.split('-')
  assert.equal(algorithm, 'sha256')
  // Byte for byte: a mismatch here is a frame that silently stopped drawing
  // anything at all, and a CSP error in one person's console.
  assert.equal(crypto.createHash('sha256').update(inline[1], 'utf8').digest('base64'), digest)
})

test('not a single request leaves the frame, neither for data nor for an image', () => {
  assert.equal(directives.get('default-src'), "'none'")
  assert.equal(directives.get('connect-src'), "'none'")
  /*
   * Images only from `data:` and `blob:`. NOT `https:` — and this is not
   * pedantry: `layout.images` with a foreign address would hand the figure's
   * author the IP of everyone who opened it, that is, of the whole audience.
   * The price is known and accepted: a figure with an image by link shows without it.
   */
  assert.equal(directives.get('img-src'), 'data: blob:')
  assert.ok(!/https?:/.test(directives.get('img-src')!))
})

test('plotly styling is let in, foreign navigation is not', () => {
  // plotly lays a chart out with inline styles and its own <style>: without
  // 'unsafe-inline' in style-src nothing is drawn at all.
  assert.equal(directives.get('style-src'), "'unsafe-inline'")
  assert.equal(directives.get('base-uri'), "'none'")
  assert.equal(directives.get('form-action'), "'none'")
  // Only the instance itself may embed the frame. `'none'`, as in the shared
  // header, would forbid it here for OUR notebook too.
  assert.equal(directives.get('frame-ancestors'), "'self'")
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/)
})

/* --------------------------------------------------------------- origin */

test('an origin gets into the header only if it passes an allowlist of shapes', () => {
  assert.equal(frameOrigin('http://localhost:5173'), 'http://localhost:5173')
  assert.equal(frameOrigin('https://hse.colloq.ru'), 'https://hse.colloq.ru')
  // The value goes into Content-Security-Policy, where a semicolon and a newline
  // are not junk but a SECOND directive. Hence a shape check rather than escaping.
  assert.equal(frameOrigin('https://ok.ru; script-src *'), null)
  assert.equal(frameOrigin('https://ok.ru\nX-Frame-Options: none'), null)
  assert.equal(frameOrigin('javascript:alert(1)'), null)
  assert.equal(frameOrigin('https://ok.ru/path'), null)
  assert.equal(frameOrigin(undefined), null)
  assert.equal(frameOrigin('x'.repeat(400)), null)
})

/* ------------------------------------------------------------ the route */

let server: http.Server | undefined
let base = ''

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

const frameUrl = (origin: string) =>
  `${base}${PLOTLY_FRAME_PATH}?${PLOTLY_ORIGIN_PARAM}=${encodeURIComponent(origin)}`

test('the frame is served with its own policy instead of the shared one, and without credentials', async () => {
  const res = await fetch(frameUrl(ORIGIN))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-security-policy'), policy)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  const body = await res.text()
  // The page is empty: it can show only what it is sent by postMessage, that
  // is, only what the person already sees in their notebook.
  assert.ok(body.includes(PLOTLY_MSG))
  assert.ok(body.includes(PLOTLY_BUNDLE_PATH))
  assert.ok(!body.includes('<script src='), 'the bundle is attached by the script, not by a tag in the markup')
})

test('no origin, no frame: there is nothing to build the policy from', async () => {
  assert.equal((await fetch(`${base}${PLOTLY_FRAME_PATH}`)).status, 400)
  assert.equal((await fetch(frameUrl('ftp://nope'))).status, 400)
})

test('the frame loader checks the source of a message, not its origin', () => {
  /*
   * The sandbox origin is the string "null", and it is THE SAME for any other
   * sandbox on the page: comparing it is pointless. The source window is
   * compared, and that is enough — a foreign frame will not become our `window.parent`.
   */
  assert.match(FRAME_HTML, /e\.source!==window\.parent/)
  assert.match(FRAME_HTML, /msg\.colloq!==TAG/)
  // A transparent background, against a white flash: the notebook draws the backdrop.
  assert.match(FRAME_HTML, /background:transparent/)
})
