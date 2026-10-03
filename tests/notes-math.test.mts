import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/*
 * Formulas in speaker notes.
 *
 * The owner writes notes with $…$ and $$…$$ and reads them on the tablet. The
 * console reader, the Prompter and the editor's «как на пульте» preview all go
 * through one component, and that component must draw through the shared
 * markdown renderer, which is the only place KaTeX and its stylesheet are
 * loaded. A reader that rendered markdown on its own would show `$$\sum$$` as
 * text on the console while the notebook draws it.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the notes reader draws through the shared renderer, so math goes through KaTeX', () => {
  const reader = read('web/src/components/lecture/NotesReader.svelte')
  assert.match(reader, /render\.markdown\(block\.source, \{ inert: true \}\)/, 'note bodies skip the shared renderer')
  assert.match(reader, /render\.markdown\(block\.answer, \{ inert: true \}\)/, '«Если спросят» answers skip the shared renderer')
})

test('the shared renderer loads KaTeX together with its stylesheet and keeps math in inert mode', () => {
  const render = read('web/src/lib/render.svelte.ts')
  assert.match(render, /import\('katex'\)/, 'KaTeX is no longer loaded with the renderer')
  assert.match(render, /import\('katex\/dist\/katex\.min\.css'\)/, 'formulas would render without KaTeX fonts')
  const inert = render.slice(render.indexOf('if (options.inert)'))
  assert.doesNotMatch(inert.slice(0, 1200), /katex/, 'inert mode must not touch rendered formulas')
})

test('the editor preview reuses the console reader', () => {
  const editor = read('web/src/components/lecture/NotesEditor.svelte')
  assert.match(editor, /<NotesReader\b/, 'the «как на пульте» preview no longer shows what the console shows')
})
