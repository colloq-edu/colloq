/**
 * What a text cell has no right to bring into other people's browsers.
 *
 * The tag list is checked in security-headers.test.mts together with the
 * headers — here is the second half of the same policy, the attributes.
 *
 * The `style` attribute left this file, and not by oversight: banning it
 * outright closed the hole (`<div style="position:fixed;inset:0">` — a black
 * screen for all thirty people and for the laptop on the projector, on top of
 * the interface, so the cell can no longer be deleted with the mouse) — but it
 * took all the usual markup of a teaching notebook along with it. Now the
 * PROPERTIES are judged, by a pure function that note-css.test.mts checks by
 * behaviour rather than by source.
 *
 * What stays here is what cannot be checked otherwise: markdown() calls
 * document.createElement and loads dompurify through a dynamic import, so it
 * needs a browser, which this suite does not have. And losing the line is one
 * line in one place, and a line like that can be seen by reading.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKDOWN_FORBIDDEN_ATTRS, MARKDOWN_FORBIDDEN_TAGS } from '../web/src/lib/sanitize.js'
import { safeStyle } from '../shared/note-css.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

test('a link in a note may not POST to a stranger', () => {
  // DOMPurify keeps `ping` by default, and `<a href="…" ping="http://…">` is a
  // request from the browser of whoever clicked a link in somebody else's note.
  assert.ok(MARKDOWN_FORBIDDEN_ATTRS.includes('ping'))
})

test('note styling is judged property by property, not by banning the attribute', () => {
  // The `style` ban was lifted on purpose — but strictly in exchange for an
  // allowlist of properties. Lose the list, and that very overlay over the whole room comes back.
  assert.ok(!MARKDOWN_FORBIDDEN_ATTRS.includes('style'))
  assert.equal(safeStyle('position:fixed;inset:0;background:#000'), 'background: #000')
})

test('a text cell may not play sound at the room', () => {
  // <audio autoplay loop> and its attributes are in DOMPurify's default lists,
  // and whoever it plays for has nothing to turn it off with.
  assert.ok(MARKDOWN_FORBIDDEN_TAGS.includes('audio'))
  assert.ok(MARKDOWN_FORBIDDEN_TAGS.includes('video'))
})

test('a list of tasks is still a list of tasks', () => {
  // `- [ ] do this` in GFM is <input type=checkbox disabled>. Banning input
  // would mean fixing the overlay at the cost of an ordinary note.
  for (const tag of ['input', 'canvas']) {
    assert.ok(!MARKDOWN_FORBIDDEN_TAGS.includes(tag), `${tag} is not a threat`)
  }
})

test('the one place that renders a note still hands the sanitizer both lists', () => {
  const source = read('web/src/lib/render.svelte.ts')
  const markdown = source.slice(source.indexOf('markdown(source)'), source.indexOf('ansi(text)'))
  assert.ok(
    markdown.includes('FORBID_ATTR: MARKDOWN_FORBIDDEN_ATTRS'),
    'markdown() renders the note without the shared list of forbidden attributes',
  )
  assert.ok(
    markdown.includes('safeStyle('),
    'markdown() lets `style` from a note into the page without checking its properties',
  )
})

test('styling is cleaned BEFORE formulas become markup', () => {
  /*
   * The order of the two passes in markdown(), and it is not cosmetic in either
   * direction. KaTeX lays a formula out with `position: absolute` and `top` —
   * exactly what a note may not use — so its output must not go through the
   * filter, or fractions and radicals collapse into a mess. But a foreign
   * `style` has to go through it. Only the order separates them: the foreign
   * first, then our own.
   */
  const source = read('web/src/lib/render.svelte.ts')
  const markdown = source.slice(source.indexOf('markdown(source)'), source.indexOf('ansi(text)'))
  assert.ok(markdown.indexOf('safeStyle(') < markdown.indexOf('katex.renderToString'))
})
