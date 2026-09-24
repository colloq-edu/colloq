/**
 * "On screen": a solution the class sees has an author.
 *
 * "Show to the class" used to rewrite the shared cell's text with someone
 * else's solution in the teacher's name. The stub disappeared for everyone,
 * the document history listed the lead as the author of the edit, there was
 * no rollback, and nothing on the screen said this was someone's solution:
 * no name, no chip, no line in the class events. The projector bar meanwhile
 * counted the submitted as if there had been no show at all, and the "names
 * on the projector" control lay in the document as a dead field.
 *
 * Now a show is an add-on to the same cell: a signed badge under it for
 * EVERYONE (the `council:shown` frame), the cell text is not touched, and it
 * is removed with one press. What is checked here is the markup of that
 * promise — with the same technique as in `council-sheet-craft` and
 * `panels-craft`: the template is read, not rendered.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate } from '../shared/i18n.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const BLOCK = code(read('web/src/components/council/CouncilOnScreen.svelte'))
const CELL = code(read('web/src/components/notebook/CellView.svelte'))
const SCREEN = code(read('web/src/screens/SessionScreen.svelte'))
const COUNCIL = code(read('web/src/lib/council.svelte.ts'))

/** The student's own sheet — from `{#if ownSheet && sheet}` to the editor's shared branch. */
const SHEET = CELL.slice(CELL.indexOf('{#if ownSheet && sheet}'), CELL.indexOf('{:else if showEditor}'))

/* ---------------------------------------------------------------- badge */

test('the badge is signed: a chip, the author, who showed it and when', () => {
  // The stripe is one for the whole block and positive in colour: this is
  // one object — the caption, the code and the output — not three neighbours.
  assert.match(BLOCK, /class="border-l-4 border-positive"/)
  assert.match(BLOCK, /tr\('room\.ui\.52'\)/, 'there is no "on screen" chip')
  assert.match(BLOCK, /<Avatar name=\{shown\.name\}/, 'the author has no face')
  assert.match(BLOCK, /\{shown\.name\}<\/span>/, 'the author\'s name is not in the badge')
  assert.match(BLOCK, /tr\('room\.ui\.1256'\)/, 'it is not said who showed it')
  assert.match(BLOCK, /clock\(shown\.shownAt\)/, 'it is not said when it was shown')
  assert.match(translate('ru', 'room.ui.1256'), /^показал преподаватель$/)
  // Only a real time: a show started before shows began to be signed has
  // none, and a made-up hour is worse than silence.
  assert.match(BLOCK, /shown\.shownAt !== null/)
})

test('the code of the shown attempt uses the same slab as everywhere else, read-only', () => {
  assert.match(BLOCK, /import Code from '@\/components\/ui\/Code\.svelte'/)
  assert.match(BLOCK, /<Code code=\{shown\.text\} \/>/)
  // There is no editor here and there cannot be: someone else's attempt is
  // not edited.
  assert.doesNotMatch(BLOCK, /CodeEditor/)
})

test('the output under the badge is the teacher\'s, under a hairline and labelled', () => {
  assert.match(BLOCK, /\{#if shown\.run\}/)
  assert.match(BLOCK, /<CellOutputs outputs=\{shown\.run\.outputs\} \/>/)
  assert.match(BLOCK, /border-top-color="rgb\(var\(--line\)\)"/, 'there is no line between the code and the output')
  assert.match(BLOCK, /tr\('room\.ui\.61'\)/, 'the output is not labelled as the teacher\'s run')
  assert.match(BLOCK, /spell\(shown\.run\.ranMs\)/, 'the run has no duration')
  assert.match(translate('ru', 'room.ui.61'), /^запускал преподаватель$/)
})

test('"clear the screen" is there only for the one entitled to press it', () => {
  assert.match(BLOCK, /\{#if mayClear\}/)
  const link = BLOCK.slice(BLOCK.indexOf('{#if mayClear}'), BLOCK.indexOf('{/if}', BLOCK.indexOf('{#if mayClear}')))
  assert.match(link, /tr\('room\.ui\.1254'\)/)
  assert.match(link, /onclick=\{\(\) => onclear\?\.\(\)\}/)
  assert.match(translate('ru', 'room.ui.1254'), /^убрать с экрана$/)
})

test('names off — "Variant N" instead of the name, and no face either', () => {
  assert.match(BLOCK, /\{#if shown\.name !== null\}/)
  assert.match(BLOCK, /tr\('room\.ui\.1255', \{ p0: shown\.variant \}\)/)
  assert.match(translate('ru', 'room.ui.1255'), /^Вариант \{p0\}$/)
  // The branch without a name goes WITHOUT an avatar: with names off there
  // is no one else's face, and a hole in the line is worse than an empty
  // circle.
  const nameless = BLOCK.slice(BLOCK.indexOf('{:else}'), BLOCK.indexOf('{/if}', BLOCK.indexOf('{:else}')))
  assert.doesNotMatch(nameless, /<Avatar/)
})

/* ------------------------------------------------------- in the notebook */

test('the badge stands under its cell — for both the student and the teacher', () => {
  assert.match(CELL, /import CouncilOnScreen from '@\/components\/council\/CouncilOnScreen\.svelte'/)
  // For the student — inside their own sheet, AFTER the teacher's letters
  // and before the footer.
  assert.match(SHEET, /<CouncilOnScreen shown=\{onScreen\} \/>/)
  assert.ok(
    SHEET.indexOf('councilLetters') < SHEET.indexOf('<CouncilOnScreen') ||
      SHEET.indexOf('letters as letter') < SHEET.indexOf('<CouncilOnScreen'),
    'the badge moved above the teacher\'s letters',
  )
  assert.ok(
    SHEET.indexOf('<CouncilOnScreen') < SHEET.indexOf('{#if restoreAsking}'),
    'the badge moved below the footer',
  )
  // For the teacher — under the compact council block, with a "clear the
  // screen" link. The badge is the only thing left in the notebook of the
  // console: it is not private, it is exactly what the audience sees at this
  // second.
  const host = CELL.slice(CELL.indexOf('data-council-host'))
  assert.match(host, /\{#if leads && showsOnScreen && onScreen\}/)
  assert.match(host, /mayClear\s+onclear=\{\(\) => session\.council\.clearShown\(id\)\}/)
})

test('the author gets no second badge: "your variant is on screen" is lit for them', () => {
  assert.match(
    CELL,
    /const showsOnScreen = \$derived\(\s*onScreen !== null && onScreen\.participantId !== session\.me\.id,\s*\)/,
  )
  /*
   * And there is no lock in the condition — 20 Sep 2026. The teacher closes
   * the council to stop the work (editing sheets, submitting, the queue), and
   * the shown solution used to vanish for the whole class together with the
   * discussion it was brought up for. Only "clear the screen" removes a show;
   * the server keeps it independently of the lock (control.ts ·
   * council:show:clear).
   */
  assert.doesNotMatch(
    CELL,
    /const showsOnScreen = \$derived\(\s*inCouncil/,
    'the show dies together with the council again',
  )
  // The author's green chip stays in its place, in the sheet footer.
  assert.match(SHEET, /\{#if mine\?\.shown\}/)
  assert.match(SHEET, /tr\('room\.ui\.1227'\)/)
  assert.match(translate('ru', 'room.ui.1227'), /Ваш вариант на экране/)
})

test('a removed badge folds by height, and instantly under reduced-motion', () => {
  const folds = CELL.match(/transition:slide=\{\{ duration: prefersReducedMotion\(\) \? 0 : 200/g) ?? []
  assert.equal(folds.length, 2, 'the fold is not on both badges (student and teacher)')
  assert.match(CELL, /import \{ slide \} from 'svelte\/transition'/)
})

/* ------------------------------------------------------------ projector */

test('on the projector the shown solution has the same caption as in the notebook', () => {
  const strip = SCREEN.slice(SCREEN.indexOf('{#each councilsOnAir as council'))
  assert.match(strip, /\{#if council\.shown\}/)
  assert.match(strip, /<Avatar name=\{shown\.name\}/)
  assert.match(strip, /tr\('room\.ui\.1255', \{ p0: shown\.variant \}\)/, 'there is no variant number')
  assert.match(strip, /tr\('room\.ui\.1256'\)/, 'it is not said who showed it')
  assert.match(strip, /clock\(shown\.shownAt\)/)
  assert.match(strip, /\{shown\.text\}<\/pre>/, 'there is no code on the projector')
  assert.match(strip, /shownOutputLines\(council\.shown\.run\)/, 'there is no output on the projector')
  // And while nothing is shown — the count and the bar, as before.
  assert.match(strip, /countLine\(council\.count\)/)
  assert.match(strip, /scaleX\(/)
})

test('the output on the projector is lines of text, without pictures and without a tail', () => {
  assert.match(COUNCIL, /export function shownOutputLines\(/)
  const fn = COUNCIL.slice(COUNCIL.indexOf('export function shownOutputLines('))
  assert.match(fn, /lines\.slice\(0, limit\)/)
  assert.match(fn, /output\.data\['text\/plain'\]/)
  // Pictures do not go into the strip at the bottom of the screen at all.
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}')), /image\//)
})

/* ---------------------------------------------------------- names control */

test('the "names on the projector" control lives in the cell rules — in the console, not in the notebook', () => {
  /*
   * The decision "whether to sign it with a name on the wall" is a CELL rule,
   * on a par with who is allowed to run: both controls are about what the
   * class may do, and both get changed a second before a show. It stood as a
   * switch in the status line and moved to the rules sheet with all four;
   * the status line kept the mirror of the audience — what it sees now.
   */
  const rules = code(read('web/src/components/council/pult/PultRules.svelte'))
  const status = code(read('web/src/components/council/pult/PultStatusLine.svelte'))
  const window = code(read('web/src/components/council/pult/PultWindow.svelte'))
  assert.match(rules, /room\.pult\.v2\.rules\.screenNamesOption/, 'the "on the class screen" row disappeared')
  assert.match(rules, /room\.pult\.v2\.rules\.screenAnonOption/)
  assert.match(rules, /onchange\(\{ namesOnProjector: value \}\)/)
  assert.doesNotMatch(status, /namesOnProjector|role="switch"/, 'the control is back in the status line')
  assert.match(window, /function setRule\(patch: Partial<CouncilSettings>\): void/)
  assert.match(window, /session\.council\.lock\(cellId, 'council', patch\)/)
  // And it is not in the notebook: the lock menu is three positions and
  // nothing else.
  assert.doesNotMatch(CELL, /namesOnProjector/, 'the names control is back in the lock menu')
  assert.match(translate('ru', 'room.ui.1258'), /^Имена на проекторе$/)
})

test('the show confirmation no longer promises to replace the text', () => {
  for (const key of ['room.confirm.showNamed', 'room.confirm.showAnswer']) {
    for (const locale of ['ru', 'en'] as const) {
      const text = translate(locale, key)
      assert.doesNotMatch(text, /заменит|replace/i, `${key} (${locale}) promises a replacement`)
    }
  }
  assert.match(translate('ru', 'room.confirm.showNamed'), /плашкой под ячейкой/)
})
