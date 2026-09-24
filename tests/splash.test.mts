/**
 * The splash: one and the same from the document's first frame to a ready
 * screen.
 *
 * The `#boot` shell lives in web/index.html because it is drawn without a
 * single request; its twin in the app is `Splash.svelte`. They cannot have a
 * common source (the app's CSS has not arrived yet at that moment), and the
 * price of the copy is exactly these checks: a number that drifted gives a
 * jump of the logo at the very moment the shell leaves.
 *
 * Also here is what all of this was started for: the "page" and "notebook"
 * skeletons are gone from every screen, and the shell is removed not on mount
 * but when the first screen has something to show.
 *
 * It is read straight from the files, like `screens-craft` and
 * `panels-craft`: a test with its own copy of the rule passes forever while
 * the file drifts away.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const SHELL = 'web/index.html'
const SPLASH = 'web/src/components/ui/Splash.svelte'
const BOOT = 'web/src/lib/boot.ts'
const MAIN = 'web/src/main.ts'
const APP = 'web/src/App.svelte'
const ADMIN = 'web/src/screens/AdminScreen.svelte'
const READER = 'web/src/screens/ReaderScreen.svelte'
const SESSION = 'web/src/screens/SessionScreen.svelte'
const NOTEBOOK = 'web/src/components/notebook/Notebook.svelte'
const COMPETITIONS = 'web/src/screens/CompetitionsScreen.svelte'
const ROWS = 'web/src/components/ui/RowsSkeleton.svelte'

/** All web sources — used to check that something is gone everywhere. */
function webFiles(): string[] {
  const root = path.resolve(import.meta.dirname, '..', 'web', 'src')
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(svelte|ts)$/.test(entry.name)) found.push(full)
    }
  }
  walk(root)
  return found
}

/* --------------------------------------------------- no more skeleton */

test('no grey "page" or "notebook" is left on any screen', () => {
  /*
   * The complaint that started it all: "this skeleton appears out of nowhere,
   * while there is no interface anywhere". The skeleton promised a specific
   * screen — a header, cells — before anything at all was known about it.
   */
  for (const file of webFiles()) {
    const source = code(fs.readFileSync(file, 'utf8'))
    const at = path.relative(path.resolve(import.meta.dirname, '..'), file)
    assert.doesNotMatch(source, /ContentSkeleton/, `${at}: the page skeleton is back`)
    assert.doesNotMatch(
      source,
      /variant=["'](?:page|notebook)["']/,
      `${at}: a skeleton variant that the splash replaced is back`,
    )
  }
  // But the list rows stayed: there the placeholder stands exactly where the
  // future row will be, in an already drawn panel, and makes nothing up.
  const rows = read(ROWS)
  assert.doesNotMatch(code(rows), /variant/, 'the list placeholder has no variants — there is only one')
  assert.match(rows, /data-skeleton="rows"/, 'the list placeholder names itself')
  const users = webFiles().filter(
    (file) =>
      !file.endsWith('RowsSkeleton.svelte') &&
      /RowsSkeleton/.test(fs.readFileSync(file, 'utf8')),
  )
  assert.ok(users.length >= 2, 'list rows are used by the files panel and the classes table')
})

/* ----------------------------------------- the splash and its shell */

test('the app splash repeats the shell number for number', () => {
  const shell = read(SHELL)
  const splash = read(SPLASH)
  // The shell's piece — from `#boot {` to the end of its media query: numbers
  // next to other rules (fonts, the background) mean nothing here.
  const boot = shell.slice(shell.indexOf('#boot {'))
  assert.ok(boot.length > 400, 'the shell no longer has splash rules')

  // The bar, the gap — and how the splash appears and runs.
  for (const [what, pattern] of [
    ['bar 88', /width:\s*88px/],
    ['bar of 2 px', /height:\s*2px/],
    ['gap 16', /gap:\s*16px/],
    ['fade-in 0.25s after a 0.25s delay', /0\.25s ease 0\.25s forwards/],
    ['running accent 1.1s', /1\.1s ease-in-out infinite/],
    ['accent 40% wide', /width:\s*40%/],
    ['run to 250%', /translateX\(250%\)/],
    ['start from beyond the left edge', /translateX\(-100%\)/],
  ] as const) {
    assert.match(boot, pattern, `the shell lost: ${what}`)
    assert.match(splash, pattern, `the app splash lost: ${what}`)
  }

  /*
   * The mark is the only number that in the app splash lives outside CSS:
   * Icon draws it, the size comes as a prop. 28 is the same as in the shell.
   * The pane one is smaller, and that is not a forgotten number: it stands
   * INSIDE an already drawn interface and cannot be larger than the one that
   * stands in place of a whole screen.
   */
  const mark = boot.slice(boot.indexOf('#boot svg'))
  assert.match(mark, /width:\s*28px/, 'the shell lost: mark 28')
  assert.match(mark, /height:\s*28px/, 'the shell mark is no longer square')
  assert.match(splash, /MARK = \{ screen: 28, pane: (\d+) \}/, 'the mark sizes are set by a table')
  const pane = Number(/MARK = \{ screen: 28, pane: (\d+) \}/.exec(splash)?.[1])
  assert.ok(pane > 0 && pane < 28, `the pane mark ${pane} is not smaller than the screen one`)
  // And it is drawn by the same nine squares — the icon set, not a third
  // copy.
  assert.match(splash, /Icon name="logo"/, 'the mark was redrawn next to the icon set')
})

test('both splashes respect "no animation"', () => {
  const shell = read(SHELL)
  const splash = read(SPLASH)
  for (const [what, source] of [
    ['shell', shell.slice(shell.indexOf('#boot {'))],
    ['splash', splash],
  ] as const) {
    const reduced = source.slice(source.indexOf('prefers-reduced-motion'))
    assert.ok(reduced.length > 40, `${what}: no branch without animation`)
    assert.match(reduced, /animation-delay:\s*0s/, `${what}: the fade-in delay is not removed`)
    assert.match(reduced, /animation:\s*none/, `${what}: the running accent is not stopped`)
    assert.match(reduced, /width:\s*100%/, `${what}: no bar is left in place of the runner`)
    assert.match(reduced, /opacity:\s*0\.4/, `${what}: the bar is not dimmed`)
  }
})

test('the splash announces itself to those who cannot see it', () => {
  const splash = code(read(SPLASH))
  assert.match(splash, /role="status"/, 'the splash is a status, not a picture')
  assert.match(splash, /aria-busy="true"/, 'the splash did not say that waiting is in progress')
  assert.match(splash, /aria-label=\{label\}/, 'the splash has no name')
  assert.match(splash, /label = tr\('common\.loading'\)/, 'the default name is not from the dictionary')
  // The same for the shell: it speaks the instance's language (main.ts fixes
  // the label).
  assert.match(read(SHELL), /id="boot" role="status" aria-label=/, 'the shell is silent')
})

test('the shell and the splash know about each other', () => {
  /*
   * A copy without a pointer is a copy people learn about from a complaint.
   * Both files name the other BY NAME, so that an edit finds its neighbour by
   * search.
   */
  assert.match(read(SHELL), /Splash\.svelte/, 'the shell does not point to the app splash')
  assert.match(read(SPLASH), /index\.html/, 'the app splash does not point to the shell')
})

/* --------------------------------------------- when the shell leaves */

test('the shell is removed on the first screen, not on mount', () => {
  const main = read(MAIN)
  /*
   * That very order: mounted, waited for the styles, waited for the screen —
   * and only then removed the shell. While `dismissShell` stood right after
   * the styles, a skeleton ended up in its place: App was mounted, but under
   * it were an `{#await}` over the route chunk and empty data.
   */
  const mount = main.indexOf('mount(App')
  const wait = main.indexOf('await whenFirstScreen(', mount)
  const dismiss = main.indexOf('dismissShell()', mount)
  assert.ok(mount > 0 && wait > mount, 'waiting for the first screen disappeared from main.ts')
  assert.ok(dismiss > wait, 'the shell is removed before the screen has anything to show')
  // The "form is drawn" event does not wait for the splash: the room chunks
  // warm up on it.
  assert.ok(main.indexOf("'colloq:ready'") < wait, 'the room warm-up is postponed until the splash leaves')
})

test('the splash does not hang forever', () => {
  const boot = read(BOOT)
  const limit = Number(/SCREEN_WAIT = (\d+)/.exec(boot)?.[1])
  assert.ok(limit > 0 && limit <= 3000, `a waiting cap of ${limit} is no cap`)
  assert.match(code(boot), /whenFirstScreen/, 'waiting without a cap is not allowed')
  // An app chunk did not arrive — there is nothing left to wait for, and the
  // splash leaves.
  const main = code(read(MAIN))
  const offer = main.slice(main.indexOf('function offerReload'))
  assert.match(offer, /firstScreenReady\(\)/, 'a load failure leaves the splash up forever')
})

test('every screen that takes over from the splash reports readiness', () => {
  /*
   * A forgotten report is visible only on a slow network: the screen comes
   * out by the cap, that is, a second later than it could. That is why the
   * list is here.
   */
  for (const [what, file] of [
    ['panel', ADMIN],
    ['reader', READER],
    ['room', SESSION],
    ['notebook', NOTEBOOK],
    ['competitions', COMPETITIONS],
    ['router', APP],
  ] as const) {
    const source = code(read(file))
    assert.match(source, /firstScreenReady\(\)/, `${what}: does not report readiness`)
    assert.match(
      source,
      /from '@\/lib\/boot'/,
      `${what}: the report does not come from the shared gate (lib/boot.ts)`,
    )
  }

  // The panel — when it knows what to draw: itself or the sign-in.
  const admin = code(read(ADMIN))
  assert.match(admin, /adminAuth\.ready && !exchanging\) firstScreenReady/, 'the panel is in a hurry')
  // The notebook — when it is no longer unread.
  assert.match(code(read(NOTEBOOK)), /if \(!cold\) firstScreenReady/, 'the notebook is in a hurry')
  // A failure screen is a screen: there is nothing left to wait for under the
  // splash.
  assert.match(code(read(APP)), /if \(failure \|\|/, 'on a failure the splash stays up')
})

test('the splash stands where the skeleton was, and on a screen it is the screen-sized one', () => {
  // Router: all five waits for a route chunk — reader, competitions, panel
  // (twice: the panel address and the root) and room.
  const app = code(read(APP))
  assert.equal(app.match(/<Splash \/>/g)?.length, 5, 'not every route wait shows the splash')
  assert.doesNotMatch(app, /<Splash size="pane"/, 'a pane splash in place of a screen')
  // Panel and reader: the whole screen.
  assert.match(code(read(ADMIN)), /<Splash \/>/, 'the panel lost the splash')
  // Inside an already drawn interface — the pane one.
  assert.match(code(read(NOTEBOOK)), /<Splash size="pane"/, 'the notebook area does not use the pane one')
  const reader = code(read(READER))
  assert.match(reader, /<Splash size="pane"/, 'the page body does not use the pane one')
  assert.match(reader, /<Splash label=/, 'the empty page does not use the screen one')
})
