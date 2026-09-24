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
  // so nothing can rewrite transition-property.
  assert.match(inks, /class="press flex w-8/, 'the pen button does not press')
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
