import { translate, tr } from '../shared/i18n.js'
/**
 * The public pages are the only Colloq addresses that get opened from a phone,
 * from home, a week after the class. And they are also the only place in the
 * product with no socket, no kernel and no pure function: almost everything
 * here is markup, and markup breaks quietly and reverts with one line.
 *
 * What is checked is what can be checked without a browser: that the step rail
 * exists on a narrow screen, that the tab title is not "Colloq", that the
 * address under a course is the one that was read out, that the download
 * caption tells the truth and that a clipboard refusal is visible. Layout and
 * the accessibility tree live in scripts/ui-check.mts.
 *
 * The same technique as in `panels-craft.test.mts`, and for the same reason: a
 * test with its own copy of the rule passes forever while the file drifts away.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup and code without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const SCREEN = code(read('web/src/screens/ReaderScreen.svelte'))
const COURSE = code(read('web/src/components/reader/CourseList.svelte'))
const NOTEBOOK = code(read('web/src/components/reader/PublicNotebook.svelte'))

/* --------------------------------------------- steps on a narrow screen */

test('on a phone a publication has step navigation', () => {
  /*
   * The only navigation was the side rail `hidden … sm:flex`: below 640 px it
   * does not exist at all, while the header honestly said "6 steps". A six-step
   * publication came down to the first step — the rest reachable only by editing
   * the address. The static export of the same publication keeps the rail as a
   * block on a narrow screen (publish/render.ts), so the SPA was worse than static.
   */
  const navs = SCREEN.match(/<nav[\s\S]*?aria-label=\{tr\('room\.ui\.869'\)\}/g) ?? []
  assert.ok(navs.length >= 2, 'there is again only one step rail, which means only for a wide screen')

  const narrow = navs.filter((nav) => /\bsm:hidden\b/.test(nav))
  assert.equal(narrow.length, 1, 'there is no rail that lives SPECIFICALLY on a narrow screen')
  assert.doesNotMatch(narrow[0], /\bhidden\b(?!\S)/, 'the narrow rail is hidden from itself')

  const wide = navs.filter((nav) => /\bsm:flex\b/.test(nav))
  assert.equal(wide.length, 1, 'the wide-screen side rail is gone')
})

test('the step strip on a phone scrolls sideways and sticks to the top', () => {
  const nav = (SCREEN.match(/<nav[^>]*sm:hidden[\s\S]*?>/) ?? [''])[0]
  assert.match(nav, /overflow-x-auto/, 'eleven steps in one line will not fit without scrolling')
  assert.match(nav, /sticky top-0/, 'once down the notebook, there is nothing to move to the next step with')
})

test('the marked step brings itself into view', () => {
  // Having opened a link to the seventh step, a person sees the first three and
  // no sign that they are on the seventh: the strip is scrolled to the start.
  assert.match(SCREEN, /scrollIntoView\(/, 'nothing scrolls the step strip to the marked step')
  assert.match(SCREEN, /inline: 'center'/, 'the marked step is not brought to the middle of the strip')
})

/* ---------------------------------------------------------- the tab title */

test('the tab of a course or a publication carries its own name', () => {
  /*
   * The course page is the only Colloq address a person bookmarks, and the page
   * itself says so. In bookmarks, in the history and in the tab switcher, every
   * course and every seminar was called "Colloq".
   */
  assert.match(SCREEN, /document\.title\s*=/, 'ReaderScreen again does not touch the tab title')
  assert.match(
    SCREEN,
    /document\.title = 'Colloq'/,
    'the title is not restored on exit: the seminar name would stay hanging over the room',
  )
})

/* --------------------------------------------- an extra request per step */

test('a publication step does not reload the seminar', () => {
  /*
   * `readPublicRoute` builds a new object on every address change, including
   * `/p/x/3` → `/p/x/4`. Effects reading `publication?.id` depended on the
   * object — and every step cost an extra GET /api/p/:id, exactly what the
   * `{#key}` in App.svelte promised not to do.
   */
  assert.match(SCREEN, /const pubId = \$derived\(/, 'the publication id is again not split out')
  const effects = SCREEN.match(/\$effect\(\(\) => \{[\s\S]*?\n  \}\)/g) ?? []
  assert.ok(effects.length > 0, 'no effects found in the screen: the test is looking in the wrong place')
  for (const effect of effects) {
    assert.doesNotMatch(
      effect,
      /publication\?\.id/,
      'an effect again depends on the route object: an extra seminar request on every step',
    )
  }
})

/* ----------------------------------------------- downloading the notebook */

test('the download carries the step being viewed, and the caption says so', () => {
  /*
   * The link was one for all steps, and the server built from it the notebook of
   * the LAST step, without outputs (publish/notebook.ts). A reader comparing
   * "before" and "after" at step 2 of 5 — exactly the reader for whom the step
   * lives in the address — took away the state of step 5 and learned of it only
   * on opening the file.
   *
   * The server accepts `?step=<seq>` and answers an unknown number with the last
   * step rather than a 404 (routes/courses.ts → notebookOfStep). Two things are
   * needed from the reader: to carry its own step in the link and not to promise
   * another one in words — "the last step" where the last one is served, "this
   * step" where the current one is.
   */
  const at = SCREEN.indexOf('notebook.ipynb')
  assert.ok(at > 0, 'there is no .ipynb link on the page')
  const near = SCREEN.slice(at, at + 600)
  assert.match(near, /\?step=\$\{current\}/, 'the link is again one for all steps: people will take away the last one')
  assert.match(near, /tr\('room\.ui\.882'\)/, 'the caption says nothing about serving the step being viewed')
  assert.match(near, /tr\('room\.ui\.881'\)/, 'on the last step the caption does not call it the last')
  assert.match(translate('ru', 'room.ui.882'), /без выводов/, 'the link says nothing about the file having no outputs')
})

/* ----------------------------------------------------- the course address */

test('under a course stands the address that was read out loud', () => {
  /*
   * The panel copies and reads out `/c/<slug>`, the static page prints
   * `slug ?? id` — while the SPA printed eight random letters of the id under
   * the words "save this page".
   */
  assert.match(COURSE, /\/c\/\{course\.slug \?\? course\.id\}/, 'the course address is by id again')
})

/* ------------------------------------------------- a clipboard refusal */

test('a clipboard refusal is visible on screen, not in the console', () => {
  /*
   * `copyText` throws when there is no permission or execCommand refused: on a
   * department's http instance and in a strict browser the "copy" button did
   * nothing — no checkmark, no word, the rejection went to unhandledrejection.
   */
  assert.match(NOTEBOOK, /catch \{/, 'copying again has no refusal handling')
  assert.match(NOTEBOOK, /refused/, 'there is no "not copied" state')
  assert.match(NOTEBOOK, /tr\('room\.ui\.731'\)/, 'the person is told nothing and offered no way out')
})

test('the cell button has press feedback and a finger-sized target', () => {
  const button = (NOTEBOOK.match(/<button[\s\S]*?<\/button>/) ?? [''])[0]
  assert.match(button, /\bpress\b/, 'pressable without .press: the only proof that the click was heard')
  const size = /h-\[(\d+)px\] w-\[(\d+)px\]/.exec(button)
  assert.ok(size, 'the copy button size is no longer explicit')
  assert.ok(
    Number(size[1]) >= 24 && Number(size[2]) >= 24,
    `a ${size[1]}×${size[2]} px target on a page that is opened from a phone`,
  )
})

/* ----------------------------------------------------------- dead code */

test('a class no stylesheet knows is not applied', () => {
  /*
   * `documentElement.classList.add('reader')` promised a "reader mode", but the
   * project has not a single rule for `.reader`: the next person to look for why
   * the public page looks different would be looking for something that does not exist.
   */
  assert.doesNotMatch(SCREEN, /classList\.add\('reader'\)/, 'the dead class is back')
  const css = read('web/src/index.css')
  assert.doesNotMatch(css, /(^|[\s,{])(html)?\.reader\b/m, 'a rule for .reader appeared: then bring the class back too')
})
