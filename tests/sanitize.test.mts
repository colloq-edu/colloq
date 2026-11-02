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
import {
  MARKDOWN_FORBIDDEN_ATTRS,
  MARKDOWN_FORBIDDEN_TAGS,
  noteClasses,
  noteReference,
} from '../web/src/lib/sanitize.js'
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
  const markdown = source.slice(source.indexOf('markdown(source'), source.indexOf('ansi(text)'))
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
  const markdown = source.slice(source.indexOf('markdown(source'), source.indexOf('ansi(text)'))
  assert.ok(markdown.indexOf('safeStyle(') < markdown.indexOf('katex.renderToString'))
})

/* ------------------------------------------------------------------ names */

test('a note keeps no class the app styles itself with', () => {
  // The overlay measured on the production build: four utility classes and no
  // `style` at all, so the property allowlist never saw it.
  assert.equal(noteClasses('div', 'fixed inset-0 z-[95] bg-canvas'), '')
  assert.equal(noteClasses('div', 'prose-note table-scroll katex output-stream'), '')
  assert.equal(noteClasses('code', 'language-js fixed'), 'language-js')
})

test('the classes the renderer itself writes into the markup survive', () => {
  // marked marks a fenced block with its language; the oracle's streaming
  // caret rides in the answer's text. Both are drawn inside the note only.
  assert.equal(noteClasses('code', 'language-python'), 'language-python')
  assert.equal(noteClasses('code', 'language-c++'), 'language-c++')
  assert.equal(noteClasses('span', 'ai-caret'), 'ai-caret')
  // Only where they are written: on any other element they are someone's.
  assert.equal(noteClasses('div', 'language-python'), '')
  assert.equal(noteClasses('div', 'ai-caret'), '')
})

test('a note refers only to its own names', () => {
  // The ids themselves are renamed by DOMPurify (SANITIZE_NAMED_PROPS); what
  // points at them has to follow, or a label, a link and an arrowhead lose
  // their targets — and, left as they were, could find the page's.
  assert.equal(noteReference('for', 'answer'), 'user-content-answer')
  assert.equal(noteReference('aria-describedby', 'a  b'), 'user-content-a user-content-b')
  assert.equal(noteReference('href', '#part-2'), '#user-content-part-2')
  assert.equal(noteReference('xlink:href', '#shape'), '#user-content-shape')
  assert.equal(noteReference('usemap', '#map'), '#user-content-map')
  assert.equal(noteReference('fill', 'url(#g)'), 'url(#user-content-g)')
  assert.equal(noteReference('marker-end', "url('#arrow')"), "url('#user-content-arrow')")
  // Already in the namespace — as DOMPurify itself leaves such an id.
  assert.equal(noteReference('href', '#user-content-x'), '#user-content-x')
  assert.equal(noteReference('fill', 'url(#user-content-g)'), null)
  // Not a name in this page: the top of it, an address elsewhere, a colour.
  assert.equal(noteReference('href', '#'), null)
  assert.equal(noteReference('href', 'https://example.com/#x'), null)
  assert.equal(noteReference('fill', 'red'), null)
  assert.equal(noteReference('title', 'see #2'), null)
  assert.equal(noteReference('alt', 'url(#x) in words'), null)
})

test('nothing in a note opens above the interface or takes the Tab key', () => {
  // A manual popover covered the room after one click and ignored Escape.
  for (const attribute of ['popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor', 'tabindex']) {
    assert.ok(MARKDOWN_FORBIDDEN_ATTRS.includes(attribute), `${attribute} reaches past the note`)
  }
  // `<dialog open>` is absolutely positioned by the browser's own stylesheet.
  assert.ok(MARKDOWN_FORBIDDEN_TAGS.includes('dialog'))
})

test("markdown() keeps the page's names out of a note before anything else draws", () => {
  const source = read('web/src/lib/render.svelte.ts')
  const markdown = source.slice(source.indexOf('markdown(source'), source.indexOf('ansi(text)'))
  assert.ok(markdown.includes('ALLOW_DATA_ATTR: false'), 'a note may carry the data-* the notebook finds its cells by')
  assert.ok(markdown.includes('SANITIZE_NAMED_PROPS: true'), 'a note may carry ids the page looks things up by')
  // Before KaTeX and the table wrapper add classes of their own, or those go too.
  assert.ok(markdown.indexOf('noteClasses(') < markdown.indexOf('katex.renderToString'))
  assert.ok(markdown.indexOf('noteClasses(') < markdown.indexOf("box.className = 'table-scroll'"))
})
