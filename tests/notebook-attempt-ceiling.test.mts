import { translate, tr } from '../shared/i18n.js'
/**
 * The council attempt ceiling through the notebook's eyes: the sheet, the
 * counter and "submitted".
 *
 * The pure half of the ceiling — a number in shared and three functions in
 * council.svelte.ts — is checked in tests/weblib-council-limit.test.mts. Here
 * is the second half, the one on screen: the sheet editor knows the ceiling
 * and refuses a PASTE (not typing), "Submit" does not send what the server
 * does not have, and "submitted" is not drawn under text that never reached
 * the server.
 *
 * It is read straight from the components, as in panels-craft: a test with
 * its own copy of the rule passes forever while the file drifts away.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { changeFits } from '../web/src/components/notebook/cell-paste.js'
import { MAX_ATTEMPT_CHARS } from '../shared/notebook.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

const CELL = read('web/src/components/notebook/CellView.svelte')
const EDITOR = read('web/src/components/notebook/CodeEditor.svelte')

/* ------------------------------------------------------------- rule */

test('the ceiling does not forbid typing by hand, but it does forbid a paste beyond it', () => {
  const ceiling = MAX_ATTEMPT_CHARS
  // Exactly the ceiling fits — by paste too.
  assert.equal(changeFits({ chars: ceiling, ceiling, pasted: true }), true)
  // One letter over the ceiling: whoever typed it sees the counter and decides
  // what to cut.
  assert.equal(changeFits({ chars: ceiling + 1, ceiling, pasted: false }), true)
  // Twelve thousand characters in one move — that is what gets refused.
  assert.equal(changeFits({ chars: 12_400, ceiling, pasted: true }), false)
})

test('where there is no ceiling, nothing is refused', () => {
  assert.equal(changeFits({ chars: 1_000_000, ceiling: null, pasted: true }), true)
})

/* --------------------------------------------------------------- editor */

test('the editor filter refuses only a user paste', () => {
  const at = EDITOR.indexOf('EditorState.changeFilter.of')
  assert.ok(at > 0, 'there is no filter at all')
  const filter = EDITOR.slice(at, at + 500)
  // Exactly two events count as a paste. The transactions through which
  // y-codemirror applies Y.Text edits (other people's and our own SEED) have
  // no userEvent at all — refusing them would split the editor from the
  // document.
  assert.match(filter, /isUserEvent\('input\.paste'\)/)
  assert.match(filter, /isUserEvent\('input\.drop'\)/)
  assert.match(filter, /changeFits\(\{ chars: tr\.newDoc\.length, ceiling, pasted \}\)/)
  // The refusal is not silent: a refused paste has words.
  assert.match(filter, /handlers\.onoverflow\?\.\(tr\.newDoc\.length\)/)
})

test('the sheet tells the editor the ceiling, and takes it from common ground', () => {
  assert.match(CELL, /import \{[\s\S]*?MAX_ATTEMPT_CHARS,[\s\S]*?\} from '@shared\/notebook'/)
  const at = CELL.indexOf("label={tr('room.extra.132'")
  assert.ok(at > 0, 'the notebook no longer has its own sheet')
  const sheet = CELL.slice(at, at + 900)
  assert.match(sheet, /maxChars=\{MAX_ATTEMPT_CHARS\}/, 'the sheet does not know the ceiling')
  assert.match(sheet, /onoverflow=\{/, 'a refused paste is silent')
})

/* ------------------------------------------------------- counter and "submitted" */

test('the ceiling is reported by a counter under the sheet, not by a toast on every pause', () => {
  // The snapshot is handed to the queue as is: beyond the ceiling `draft`
  // (council.svelte.ts) does not take it, and there is no refusal on every
  // pause in typing here.
  assert.match(CELL, /session\.council\.draft\(id, sheetText\)/)
  assert.match(CELL, /const attemptCount = \$derived\(attemptCounter\(sheetText\.length\)\)/)
  assert.match(CELL, /const attemptOver = \$derived\(attemptTooLong\(sheetText\)\)/)
  assert.match(CELL, /\{#if attemptCount\}/, 'there is no counter under the sheet')
})

test('"Submit" does not send what the server does not have', () => {
  const at = CELL.indexOf('function submitAttempt()')
  const submit = CELL.slice(at, CELL.indexOf('function withdrawAttempt', at))
  assert.match(submit, /if \(attemptOver\) \{/, 'a submission over the ceiling goes out silently')
  assert.match(submit, /session\.showError\(/, 'a refusal without words')
  // The refusal comes before sending: otherwise the previous, short snapshot
  // would be submitted.
  assert.ok(
    submit.indexOf('if (attemptOver)') < submit.indexOf('session.council.submit(id)'),
    'the check comes after sending — it saves nothing',
  )
})

test('"submitted" is not drawn under text the teacher does not have', () => {
  assert.match(CELL, /const attemptSynced = \$derived\(attemptInSync\(mine, sheetText\)\)/)
  // A mismatch is not a label branch but a sheet state: the chip, the main
  // action and the bar colour all carry it at once (boards E and G).
  const at = CELL.indexOf('const sheetState = $derived(')
  const state = CELL.slice(at, CELL.indexOf('const reviewedAt', at))
  assert.match(state, /submittedAt !== null && !attemptSynced/, 'the mismatch is not told apart')
  // The mismatch branch comes FIRST: otherwise "submitted" would always win
  // over it.
  assert.ok(
    state.indexOf('!attemptSynced') < state.indexOf("'submitted'"),
    '"submitted" comes before the check and wins over it',
  )
  assert.match(CELL, /tr\('room\.ui\.1228'\)/, 'there are no words for the mismatch')
  assert.match(translate('ru', 'room.ui.1228'), /Есть правки/)
  assert.match(translate('ru', 'room.ui.1229'), /Сдать заново/)
})
