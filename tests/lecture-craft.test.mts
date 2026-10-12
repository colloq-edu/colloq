/**
 * Press feedback in the lecture: the notebook bar, the pen circles, the dead
 * console.
 *
 * None of these lines has a function or a socket — they live in a class
 * attribute and a markup branch, and they break silently: `transition-colors`
 * instead of the listed properties throws transform out of the transition,
 * that is, the press itself, and on screen this looks no different from "the
 * server is thinking". Nobody will check this in a browser on every edit, and
 * it reverts with a single line — which is exactly how finding design-9 came
 * about.
 *
 * It is read straight from the components, with the same trick as
 * panels-craft: a test with its own copy of the rule passes forever while the
 * file drifts away.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup and styles without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const VIEW = 'web/src/components/lecture/LectureView.svelte'
const CONSOLE = 'web/src/components/lecture/ConsoleView.svelte'

/* ------------------------------------------------------------- press */

test('the lecture toolbar presses, and transform is not thrown out by a transition utility', () => {
  const view = code(read(VIEW))
  const tool = /const TOOL =\s*((?:'[^']*'\s*\+?\s*)+)/.exec(view)
  assert.ok(tool, 'the TOOL constant is gone from LectureView')
  const classes = tool[1]
  /*
   * The properties are listed, rather than `transition-colors` plus `.press`:
   * the Tailwind utility rewrites transition-property wholesale, and the
   * helper's transform would not make it into the list — the press would not
   * animate at all.
   */
  assert.match(classes, /transition-\[[^\]]*\btransform\b[^\]]*\]/, 'transform is not in the transition list')
  assert.match(classes, /\bduration-press\b/, 'the press does not follow --speed-press')
  assert.match(classes, /enabled:active:scale-\[0\.97\]/, 'the lecture bar does not respond to a press')
})

test('the pen circle changes size instantly, and the press is left to the finger', () => {
  const view = code(read(VIEW))
  const each = /\{#each INKS as choice[\s\S]*?\{\/each\}/.exec(view)
  assert.ok(each, 'the row of pens is gone from the lecture bar')
  const inks = each[0]
  // State arrives on its own; animating it means drawing it later than it
  // happened. scale-110 stays, transition-transform goes.
  assert.doesNotMatch(inks, /transition-transform/, 'the state change of the circle is animated again')
  assert.match(inks, /scale-110/, 'the selected pen no longer differs in size')
  // The helper is used by name: the button has no other transition utilities,
  // so nothing can rewrite transition-property. 24 px a pen, not 32: eight
  // pens stand where four stood.
  assert.match(inks, /class="press flex w-6/, 'the pen button does not press')
})

test('eight pens on the laptop bar: each one seen, the chosen one ringed, the folded ones still there', () => {
  const view = code(read(VIEW))
  const inks = /\{#each INKS as choice[\s\S]*?\{\/each\}/.exec(view)?.[0] ?? ''
  /*
   * White on the day bar and black on the night bar were circles nobody
   * could see: the light pens (pult.ts · `light`) and the near-black one
   * carry a hairline in the ink colour.
   */
  assert.match(inks, /\{edge\(choice\)\}/, 'a pen circle lost its edge')
  const edge = view.slice(view.indexOf('function edge('), view.indexOf('function edge(') + 300)
  assert.match(edge, /if \(choice\.light\) return 'border-ink\/25'/, 'the light pens vanish on the day bar')
  assert.match(edge, /dark:border-ink\/35/, 'the black pen vanishes on the night bar')
  // A ring laid straight on the circle vanished around black by day and white
  // by night: the chosen pen is ringed with a gap of the bar's own ground.
  assert.match(inks, /scale-110 ring-\[1\.5px\] ring-ink ring-offset-\[1\.5px\] ring-offset-canvas/)
  // One set of pen keys, in the row or in the palette: the palette is hidden,
  // not unmounted, so "Pen, red" is always there to be pressed.
  assert.match(view, /\{#snippet pens\(\)\}\s*\{#each INKS as choice/)
  const palette = view.slice(view.indexOf('id="lecture-pens"'), view.indexOf('{@render pens()}', view.indexOf('id="lecture-pens"')))
  assert.match(palette, /\{penOpen\s*\?\s*'grid'\s*:\s*'hidden'\}/, 'the folded pens leave the document while closed')
  assert.doesNotMatch(view, /\{#if penOpen\}/)
})

/* --------------------------------------------------- dead console */

test('the console explains a mismatch with the server in its own words and offers a reload', () => {
  const pult = code(read(CONSOLE))
  assert.match(
    pult,
    /import \{ reloadByHand \} from '@\/lib\/refusal'/,
    'the manual reload does not come from the shared copy of the rule',
  )
  /*
   * The room's banner sits above the console (SessionScreen, z-[100]), but it
   * is built for a window with a mouse. Before this branch the console had
   * nothing left but the rail's red seam: keys dimmed, the sheet hanging, no
   * words.
   */
  assert.match(pult, /\{:else if session\.stuck\}/, 'the console is silent about the mismatch again')
  assert.match(pult, /onclick=\{\(\) => reloadByHand\(\)\}/, 'the console has no reload button')
})
