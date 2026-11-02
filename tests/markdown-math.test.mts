/**
 * The math placeholders of markdown(): only the renderer's own are formulas.
 *
 * Raw HTML in a note brings its own `data-math`, and the renderer used to take
 * every one for its placeholder and URI-decode it: `<span data-math="%">`
 * threw a URIError out of markdown() and out of Svelte's update, and on the
 * production build no note on the page was formatted any more. Now a
 * placeholder only names a formula of the current render, by a token drawn
 * for that render, and the TeX never travels in the markup.
 *
 * The whole path — marked, DOMPurify, KaTeX, the component — needs a browser:
 * tests/browser/markdown.spec.ts runs it. Here is the rule itself.
 *
 * There is no Svelte compiler here: `$state` is a fake that returns the value
 * as is (as in tests/council-client.test.mts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const shim = <T,>(value: T): T => value
;(globalThis as { $state?: unknown }).$state = shim

const { formulaAt } = await import('../web/src/lib/render.svelte.js')

const formulas = [
  { tex: 'x^2', display: false },
  { tex: '\\frac{a}{b}', display: true },
]

test("the renderer's own placeholder names its formula", () => {
  assert.deepEqual(formulaAt('k3x9q-0', 'k3x9q', formulas), formulas[0])
  assert.deepEqual(formulaAt('k3x9q-1', 'k3x9q', formulas), formulas[1])
})

test('a data-math the render did not write is no formula, whatever it holds', () => {
  // What the audit wrote into a note, the TeX the old placeholder carried,
  // and near misses of the new one.
  for (const forged of ['%', '%ZZ', '%E0%A4%A', 'x', '', '%5Cfrac%7B1%7D%7B2%7D', '0', 'k3x9q', 'k3x9q-', 'k3x9q-2', 'k3x9q-01x', 'k3x9q--1', 'other-0']) {
    assert.equal(formulaAt(forged, 'k3x9q', formulas), undefined, `"${forged}" was taken for a formula`)
  }
  assert.equal(formulaAt(null, 'k3x9q', formulas), undefined)
})

test('markdown() never decodes a placeholder and draws each formula on its own', () => {
  const source = readFileSync(new URL('../web/src/lib/render.svelte.ts', import.meta.url), 'utf8')
  const markdown = source.slice(source.indexOf('markdown(source'), source.indexOf('ansi(text)'))
  assert.doesNotMatch(source, /decodeURIComponent\(/, 'the TeX is back in the markup')
  assert.match(markdown, /const token = renderToken\(\)/, 'the token is no longer drawn per render')
  assert.match(markdown, /formulaAt\(slot\.getAttribute\('data-math'\), token, formulas\)/)
  // KaTeX's own failure stays one formula: the call sits in a try.
  const drawing = markdown.slice(markdown.indexOf("querySelectorAll('[data-math]')"))
  assert.ok(drawing.indexOf('try {') < drawing.indexOf('katex.renderToString'))
})
