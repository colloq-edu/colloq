import { translate } from '../shared/i18n.js'
/**
 * The history panel finishes the sentence about the trimmed beginning.
 *
 * The server computes the flag and carries it in the feed response
 * (`history-trimmed-route.test.mts`), but as long as the panel does not draw
 * it, the trimming stays just as silent: the list starts in the middle of the
 * class and looks like the whole history of a short one. And people usually
 * look at the history when they have lost something — and "there was nothing
 * before" reads as an answer here.
 *
 * Three things are checked, each of which on its own cancels the flag: the
 * response shape in `lib/history` (its own copy of `{ versions }` silently cut
 * the field off halfway), reading the field into the panel state, and the
 * place of the line — AFTER the list. The feed goes from newest to oldest, so
 * the boundary of what survived runs under the last row; saying it at the top
 * would point at the fresh edits.
 *
 * And separately — the words. The feed window (`MAX_VERSIONS`) does not return
 * everything either, but those versions are in the database and open by link.
 * The line speaks of deleted ones: "not kept", not "not shown".
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

const TAB = code(read('web/src/components/panels/HistoryTab.svelte'))
const LIB = code(read('web/src/lib/history.ts'))
const SHARED = read('shared/history.ts')

test('the feed response shape is named once — in shared', () => {
  assert.match(SHARED, /export interface VersionList \{[\s\S]*?trimmed: boolean/, 'shared/history.ts')
  assert.match(LIB, /listVersions\([\s\S]*?\): Promise<VersionList>/, 'the browser takes the shape from the same place')
  assert.doesNotMatch(
    LIB,
    /Promise<\{ versions: Version\[\] \}>/,
    'its own copy of the shape would again cut trimmed off on the way to the panel',
  )
})

test('the panel reads the trim flag from the response', () => {
  assert.match(TAB, /let trimmed = \$state\(false\)/, 'the flag is not in the state')
  assert.match(TAB, /trimmed = body\.trimmed/, 'the response is read, but the field is thrown away')
})

test('the line about the lost beginning sits at the end of the feed and only when trimmed', () => {
  const tail = TAB.slice(TAB.indexOf('{#each versions as v'))
  const each = tail.indexOf('{/each}')
  const note = tail.indexOf("tr('room.ui.634')")
  assert.ok(each >= 0, 'the version list was not found — the test is looking in the wrong place')
  assert.ok(note > each, 'the note is not under the oldest row of the list')
  assert.match(
    tail.slice(each, note),
    /\{#if trimmed\}/,
    'the note is not under the condition: it would lie to a complete feed',
  )
  // About what was deleted, not about the feed window: versions pushed out by
  // MAX_VERSIONS are in the database, and they need different words.
  assert.match(translate('ru', 'room.ui.634'), /история комнаты ограничена по объёму/)
  assert.doesNotMatch(translate('ru', 'room.ui.634'), /не показаны|показаны не все/)
})
