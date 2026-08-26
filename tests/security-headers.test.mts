/**
 * The headers a seminar answers with, and the tags a text cell may not carry.
 *
 * Both were written after measuring, not after reading. Fourteen hostile
 * payloads were written into a live seminar's notebook from a second client and
 * read back in a real browser: nothing scriptable survived — no <script>, no
 * on* attribute, no javascript: href — but `<style>` and `<form>` did, and
 * `<style>@import "http://…"</style>` made every browser in the room fetch a
 * stranger's URL.
 *
 * These tests pin the decisions. Whether DOMPurify honours the list is a
 * browser fact and is checked in a browser; what belongs here is that the list
 * says what we decided it says, and that the headers do not quietly acquire a
 * directive that would break the app shell.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../server/src/headers.js'
import { MARKDOWN_FORBIDDEN_TAGS } from '../web/src/lib/sanitize.js'

/* --------------------------------------------------------- what we forbid */

test('a text cell may not ship a stylesheet', () => {
  // <style> is page-wide: `<style>* { display: none }</style>` in one student's
  // cell blanks the seminar for the whole room.
  assert.ok(MARKDOWN_FORBIDDEN_TAGS.includes('style'))
})

test('a text cell may not put a form in the notebook', () => {
  // It survives with its action intact — a button that posts wherever its
  // author chose, in the middle of everybody else's notebook.
  assert.ok(MARKDOWN_FORBIDDEN_TAGS.includes('form'))
})

test('nothing a note legitimately uses is on the list', () => {
  // Headings, code, tables, links and images are what a seminar note is made
  // of. Forbidding any of them would be a product change dressed as a fix.
  for (const tag of ['a', 'img', 'code', 'pre', 'table', 'h1', 'h2', 'ul', 'blockquote']) {
    assert.ok(!MARKDOWN_FORBIDDEN_TAGS.includes(tag), `${tag} is not a threat`)
  }
})

/* --------------------------------------------------------- what we answer */

test('the policy says no to the four things a seminar never does', () => {
  for (const directive of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
    assert.ok(CONTENT_SECURITY_POLICY.includes(directive), `missing: ${directive}`)
  }
})

test('the policy does not police scripts or styles', () => {
  /*
   * The app shell runs an inline theme script before the first paint and paints
   * itself with an inline stylesheet, and the webfonts come from Google's
   * origin. A script-src or style-src here would need 'unsafe-inline' to keep
   * the app working, which is a longer header buying nothing — and one written
   * without it would blank the product on the first load.
   */
  assert.ok(!/script-src/.test(CONTENT_SECURITY_POLICY))
  assert.ok(!/style-src/.test(CONTENT_SECURITY_POLICY))
  assert.ok(!/default-src/.test(CONTENT_SECURITY_POLICY))
})

test('directives are separated the way a browser reads them', () => {
  // One malformed separator and the whole header is ignored, silently.
  assert.equal(CONTENT_SECURITY_POLICY.split('; ').length, 4)
  assert.ok(!CONTENT_SECURITY_POLICY.endsWith(';'))
})

test('a seminar link never leaves in a Referer', () => {
  // The path IS the credential: /s/<id> is the whole authentication story. This
  // sends the origin cross-origin and never the path, so an image somebody
  // linked in a note cannot hand out the room's door.
  assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'strict-origin-when-cross-origin')
  assert.ok(!/no-referrer-when-downgrade|unsafe-url/.test(SECURITY_HEADERS['Referrer-Policy']))
})

test('uploads are not sniffed into something executable', () => {
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff')
})

test('the header set is frozen, so a route cannot weaken it in passing', () => {
  assert.throws(() => {
    ;(SECURITY_HEADERS as Record<string, string>)['Referrer-Policy'] = 'unsafe-url'
  })
})
