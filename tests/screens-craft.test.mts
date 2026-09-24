/**
 * Small things on the join and room screens that have neither a function nor a
 * socket.
 *
 * Everything here is about markup: a tile's response under a finger, the list
 * of properties on a transition, the truncation flag reaching the tabs, the
 * refusal dialog with ALL the lost text, and the pointer to the published
 * version on a finished class. Each of these decisions reverts with one line
 * and breaks no test — which is exactly how all of them turned up in the audit.
 *
 * It is read straight from the components, as in `panels-craft.test.mts`: a
 * test with its own copy of the rule passes forever while the file drifts away.
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

const SESSION = 'web/src/screens/SessionScreen.svelte'
const JOIN = 'web/src/screens/JoinScreen.svelte'
const PICKER = 'web/src/components/join/MarkPicker.svelte'
const FILEBAR = 'web/src/components/editor/FileBar.svelte'

/* ---------------------------------------------------------------- press */

test('mark tiles respond to the finger, and the roster decides whether they are free', () => {
  const picker = code(read(PICKER))
  const grid = picker.slice(picker.indexOf('role="radiogroup"'))
  // Forty tiles are the most pressed spot on the join screen, and the border and
  // ring arrive from `value`, that is, by a round trip through the server. `press`
  // is the only thing that responds on the press itself (index.css · .press).
  assert.match(grid, /\bpress\b/, 'the tile wears the house press')
  assert.match(grid, /held \? '' : 'press'/, 'a taken mark does not promise what it will not do')
  // No `transition-*` utilities nearby: they would overwrite transition-property
  // and leave transform off the list.
  assert.doesNotMatch(grid, /transition-/, 'nothing gets in the way of the helper')
})

test('the buttons in the bars under a tab transition only what actually moves', () => {
  // The `transition` shortcut transitions ALL properties — including border-color
  // and the box-shadow of the focus ring, which has to appear on the frame of the
  // key press. An explicit list, as for .btn (index.css). Both buttons are twins
  // (one bar under a tab, one height, one ground), and they have nowhere to drift apart.
  const session = code(read(SESSION))
  assert.doesNotMatch(session, /\btransition duration-/, 'no bare shortcut is left')
  const board = session.slice(session.indexOf('showToRoom(activePath)') - 900)
  const run = code(read(FILEBAR))
  for (const [name, source] of [
    ['"Share screen"', board],
    ['"Run"', run],
  ] as const) {
    assert.match(source, /transition-\[filter,transform\]/, `${name}: the property list is written by hand`)
    assert.match(source, /duration-press ease-out/, `${name}: speed and curve from the scale`)
    assert.match(source, /enabled:active:scale-\[0\.97\]/, `${name}: and there is something to move`)
  }
  assert.doesNotMatch(run, /\btransition duration-/, '"Run" goes without the shortcut too')
})

/* -------------------------------------------------------- a truncated list */

test('tabs are weeded against the full file list, not a truncated one', () => {
  const session = code(read(SESSION))
  // MAX_ENTRIES=2000 (server/src/workspace.ts): a dataset a student unpacked pushes
  // somebody else's notebook out of the list, and without this flag `Tabs` would
  // close the tabs for the whole room. The field is optional — silence here would
  // mean "the list is complete", that is, the old behaviour.
  assert.match(session, /tabs\.settle\(\{[^}]*\btruncated\b/, 'the truncation flag reaches Tabs')
  assert.match(session, /session\.filesTruncated/, 'and is taken from the room state')
})

/* ----------------------------------------------------- the refusal dialog */

test('the refusal dialog shows everything lost, not the cell under the cursor', () => {
  const session = code(read(SESSION))
  // The gate refuses a frame whole, and a frame after a disconnect is all the
  // offline edits at once (lib/refusal.ts). While there was a single cell here,
  // the rest went away silently with the cache.
  assert.match(session, /stillLost\(/, 'comparison with the server copy')
  assert.match(session, /refusalHasText\(/, 'and one rule for "is there anything to show"')
  assert.match(session, /\{#each refusedCells as cell/, 'a list is drawn, not a single line')
  assert.doesNotMatch(session, /\{#if refusal\.text\}/, 'no single-cell markup is left')
})

test('losses are counted only after the server has sent its copy', () => {
  const session = code(read(SESSION))
  // Before the sync the document is empty, and emptiness means "not read yet":
  // counting earlier would declare the whole notebook lost.
  assert.match(session, /provider\.on\('sync', settle\)/, 'we wait for the provider sync')
  assert.match(session, /provider\.off\('sync', settle\)/, 'and unsubscribe')
  assert.match(session, /lostCells !== null/, 'it is counted exactly once')
})

/* ------------------------------------------------------ a finished class */

test('a finished class shows the way to the published version', () => {
  const join = code(read(JOIN))
  // The link in the chat leads to the room, and that is the only address a student
  // has: without this line, a week later they walk alone into the live notebook
  // (shared/protocol.ts · SessionInfo.published). The field was added for exactly this screen.
  assert.match(join, /session\.published/, 'the field is read')
  assert.match(
    join,
    /href="\/p\/\{publicationAddress\(session\.published\)\}"/,
    'the address comes from the page name, not assembled by hand',
  )
  assert.match(join, /plural\(session\.published\.steps/, 'the step count follows the plural rule')
  assert.match(join, /href="\/c\/\{session\.course\.id\}"/, 'and the course next to it, when there is one')
})

test('the pointer to the publication sits inside "class is over", not on its own', () => {
  const join = code(read(JOIN))
  // A running class with an earlier publication is common (the page is put
  // together between classes), and there is no reason to lead people off it to the reading.
  const finished = join.indexOf('{#if finishedStamp}')
  assert.ok(finished > 0, 'the end-of-class block is in place')
  const published = join.indexOf('{#if session.published}')
  assert.ok(published > finished, 'the pointer is inside it')
})

/* ---------------------------------------------------------- the room header */

test('the header fold: under reduced motion BOTH transitions get zero', () => {
  const session = code(read(SESSION))
  const fold = session.slice(session.indexOf('{#if headOpen}'), session.indexOf('{#if room.length'))
  assert.notEqual(fold, '', 'the fold is in place')
  // A block leaves the DOM only after its last transition: a 0 ms height next to
  // a 120 ms fade left the header standing at full height for those 120 ms and
  // then cut it off in one jump (measured on the bench: 157 px after 35 ms).
  assert.match(
    fold,
    /transition:slide=\{\{ duration: prefersReducedMotion\(\) \? 0 : 200, easing: quintOut \}\}/,
    'the height moves over 200 ms, and nothing moves under prefers-reduced-motion',
  )
  const fades = fold.match(/transition:fade=\{\{ duration: prefersReducedMotion\(\) \? 0 : 120 \}\}/g)
  assert.equal(fades?.length, 2, 'both contents fade by the same rule')
})

test('a folded header leaves the mark in the bar and the class name for screen readers', () => {
  const session = code(read(SESSION))
  const band = session.slice(session.indexOf('{#if !headOpen}'), session.indexOf('{#if room.length'))
  assert.match(band, /<h1 class="sr-only">\{title\}<\/h1>/, 'the page does not stay nameless')
  assert.match(band, /<Icon name="logo" size=\{16\} \/>/, 'the mark is the same as in the header')
  assert.match(band, /title=\{title\}/, 'and under the pointer it says which room this is')
  // The two marks overlap: the incoming one waits 40 ms, the outgoing one fades
  // faster than the move.
  assert.match(band, /in:fade=\{\{ duration: 160, delay: 40 \}\}/)
  assert.match(band, /out:fade=\{\{ duration: 100 \}\}/)
})

test('the header toggle is a disclosure, and its state survives a reload', () => {
  const session = code(read(SESSION))
  const button = session.slice(session.indexOf('onclick={toggleHead}') - 200)
  assert.match(button, /aria-expanded=\{headOpen\}/, 'not aria-pressed: it is a disclosure')
  assert.match(
    button,
    /aria-label=\{headOpen \? tr\('room\.head\.fold'\) : tr\('room\.head\.unfold'\)\}/,
    'the label changes with the state and is translated',
  )
  // The room layout is stored as one entry: a separate key would be a second
  // place where people forget to clean it up.
  assert.match(session, /JSON\.stringify\(\{ left: leftOpen, right: rightOpen, head: headOpen \}\)/)
  assert.match(session, /head: saved\.head !== false/, 'an old entry without the field means an unfolded header')
})
