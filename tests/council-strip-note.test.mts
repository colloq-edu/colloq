/**
 * The shared kernel is mentioned where the control is switched on — and in
 * borrowed words.
 *
 * Attempts run in the room's ONE kernel: each gets its own data, and the
 * server restores names and bindings after it (kernel/council-isolation.ts),
 * but files and module state stay shared. The teacher marks "correct" based
 * on the output, so this has to be said where they look at the output and
 * where they decide who runs.
 * The header of `COUNCIL_SHARED_KERNEL_NOTE` names three such places: the
 * "who can run" control, the run button hint for a student, README. The
 * first was in the lock menu, then in the console queue bar, now in the
 * footer of the rules sheet, under all four rules; the second and third are
 * covered by their own tests (notebook-craft, docs-promises), the first —
 * here.
 *
 * It is also checked that the line is not rewritten in its own words: there
 * is one copy, in shared/notebook.ts, otherwise the control and the line
 * would drift apart at the very first edit — and that it stands as text, not
 * as a tooltip: the console is driven from a tablet, where there is no hover
 * at all.
 *
 * With the rules sheet (PultRules.svelte) the control moved from the queue
 * footer to where all four cell rules stand — and the line about the shared
 * kernel moved with it: it explains the cost of EXACTLY this control.
 *
 * The markup is read straight from the component — the same technique as in
 * panels-craft.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COUNCIL_SHARED_KERNEL_NOTE } from '../shared/notebook.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const RULES = code(read('web/src/components/council/pult/PultRules.svelte'))

/** The rules sheet: the "Who runs" row and the footer under all rules. */
function knob(): string {
  const from = RULES.indexOf("PULT_RULES.map")
  assert.ok(from > 0, 'there are no rules rows any more')
  return RULES.slice(from)
}

test('the run control speaks about the shared kernel — with a line from shared', () => {
  assert.match(RULES, /import \{ COUNCIL_SHARED_KERNEL_NOTE[^}]*\} from '@shared\/notebook'/)
  assert.match(knob(), /\{tr\(COUNCIL_SHARED_KERNEL_NOTE\)\}/, 'the control has no line')

  // No copy of its own: the first words of the phrase must not occur in the
  // component.
  const opening = COUNCIL_SHARED_KERNEL_NOTE.slice(0, 24)
  assert.ok(!RULES.includes(opening), 'the line was rewritten as a copy')
})

test('the line is visible without hovering — a tablet has no hover', () => {
  assert.doesNotMatch(knob(), /title=\{COUNCIL_SHARED_KERNEL_NOTE\}/)
  assert.doesNotMatch(knob(), /title="\{COUNCIL_SHARED_KERNEL_NOTE\}"/)
})

test('the run control is gone from the notebook: its place is the console', () => {
  const cell = code(read('web/src/components/notebook/CellView.svelte'))
  assert.doesNotMatch(cell, /setStudentRun|studentRun \}/, 'the control is back in the lock menu')
  assert.doesNotMatch(cell, /tr\('room\.ui\.335'\)/, 'the control title remained in the notebook')
})
