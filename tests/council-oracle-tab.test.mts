/**
 * The oracle-on-the-class tab — markup promises the types cannot show.
 *
 * Five of them break silently, and each would cost a class a complaint of its
 * own.
 *
 * The input panel sits outside the scrolling: asking is possible only when
 * the field is at hand, not at the end of a feed that has to be scrolled
 * first. Should it move inside the scroll area, in a 900×650 window it would
 * disappear exactly after the second answer.
 *
 * The empty state does NOT say "waiting for submitted work" and does NOT set
 * conditions: since 20 Sep 2026 one can always ask, including on a cell where
 * not a single line has been written yet. Waiting for submissions in order to
 * ask "what is this task about" — that was the complaint.
 *
 * A refusal stays in the feed together with its question: otherwise there is
 * nothing to repeat.
 *
 * A person's label is a button, not bold text: it is clicked to open the
 * work. And the label is twofold: the name when names are on, "Variant N"
 * when they are off. One forgotten branch here means a student's name in a
 * window where the teacher deliberately turned names off.
 *
 * The markup is read from the component, as in council-pult-craft.test.mts.
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

const TAB = code(read('web/src/components/council/pult/PultOracleTab.svelte'))
const WINDOW = code(read('web/src/components/council/pult/PultWindow.svelte'))

test('the input panel sits outside the scroll area — it is always visible', () => {
  const body = TAB.indexOf('<div class="oracle-body"')
  const ask = TAB.indexOf('<footer class="oracle-ask"')
  assert.ok(body > 0 && ask > body, 'the input panel is missing or sits above the body')
  // Between the end of the body and the panel there is only the closing tag:
  // the panel is not nested in the body.
  assert.match(TAB.slice(TAB.indexOf('</div>', TAB.lastIndexOf('{/if}', ask)), ask), /^<\/div>\s*$/)
  assert.match(TAB, /\.oracle-body \{[^}]*overflow-y: auto/, 'the body does not scroll')
  assert.match(TAB, /\.oracle-ask \{[^}]*flex-shrink: 0/, 'the input panel shrinks together with the feed')
})

test('the empty state invites asking rather than waiting for submitted work', () => {
  const empty = TAB.slice(TAB.indexOf('{#if empty}'), TAB.indexOf('{#if answers.length > 0'))
  assert.ok(empty.length > 0, 'there is no empty state at all')
  assert.ok(!empty.includes('noSubmissions'), 'the tab again asks to wait for submissions')
  assert.ok(!empty.includes('noSheets'), 'the tab again sets the condition "at least one sheet is needed"')
  assert.match(empty, /ask\.emptyHint/)
  // Empty means "not a single turn in the feed, and nobody is reading right
  // now". There is no summary by groups here any more, and no "wait for
  // submissions" condition either.
  assert.match(TAB, /const empty = \$derived\(answers\.length === 0 && pending === null\)/)
})

test('no quick question waits for submissions: one can always ask', () => {
  const quick = TAB.slice(TAB.indexOf('<div class="quick-row">'), TAB.indexOf('<div class="ask-field">'))
  assert.match(quick, /disabled=\{!canSend\}/)
  assert.ok(!quick.includes('submitted === 0'), 'the chip goes dark again without submissions')
  assert.ok(!TAB.includes('summaryWhy'), 'the "wait for a submission" explanation is still in the markup')
  // `room.pult.v2.oracle.drafts` in the header means "how many are still
  // writing", not a draft of a group letter: of the group ones only these two
  // names are left.
  assert.ok(!TAB.includes('groupLabels') && !TAB.includes('oracle.drafts['), 'the groups are back')
  assert.ok(!TAB.includes('summary'), 'the summary by groups is back in the tab')
})

test('a failure is visible in the feed together with its question', () => {
  const thread = TAB.slice(TAB.indexOf('{#each answers as answer'), TAB.indexOf('{#if pending}'))
  assert.match(thread, /class="turn-question"/, 'the question disappears on a refusal')
  assert.match(thread, /\{#if answer\.failed\}/)
  assert.match(thread, /\{answer\.failed\}/)
  // And it can be repeated with the same click, without retyping anything.
  assert.match(thread, /onclick=\{\(\) => ask\(answer\.question\)\}/)
})

test('the reasoning level sits by the field and is remembered in the browser', () => {
  assert.match(TAB, /data-pult-oracle-effort/)
  assert.match(TAB, /rememberedEffort\(\)/, 'the choice is not restored when the console opens')
  assert.match(TAB, /rememberEffort\(effort\)/, 'the choice is not remembered')
  // "As on the instance" comes back with a second click: otherwise there is
  // no way to clear the choice.
  assert.match(TAB, /effort = effort === next \? null : next/)
  // And it travels together with the question, not as a separate setting.
  assert.match(TAB, /onask\(text, effort \?\? undefined\)/)
})

test('the label in an answer is a button that opens the work; without names it shows the variant', () => {
  const snippet = TAB.slice(TAB.indexOf('{#snippet answerText'), TAB.indexOf('{/snippet}'))
  assert.match(snippet, /class="answer-person"/)
  assert.match(snippet, /onclick=\{\(\) => onopen\(piece\.participantId\)\}/)
  // A label with nobody behind it in the stack stays plain text.
  assert.match(snippet, /\{:else\}\{piece\.label\}/)
  assert.match(
    TAB,
    /if \(names && attempt\.name\.trim\(\)\) return attempt\.name[\s\S]{0,200}tr\('room\.ui\.1255', \{ p0: no \}\)/,
    'the chip label does not tell names on from names off',
  )
  // Opening is the same function as for a list row: the console knows one
  // "open".
  assert.match(WINDOW, /<PultOracleTab[\s\S]{0,400}onopen=\{open\}/)
  assert.match(WINDOW, /<PultOracleTab[\s\S]{0,400}\{variants\}/)
})

test('Enter sends, Shift+Enter breaks the line, the length is cut on input', () => {
  const field = TAB.slice(TAB.indexOf('<textarea class="ask-text"'), TAB.indexOf('</textarea>'))
  assert.match(field, /maxlength=\{MAX_ORACLE_QUESTION\}/, 'the length ceiling is the shared one, not a copied number')
  assert.match(field, /event\.key !== 'Enter' \|\| event\.shiftKey \|\| event\.isComposing/)
  assert.match(field, /event\.preventDefault\(\)[\s\S]{0,80}sendDraft\(\)/)
  // While reading, the send button's place holds "Stop", and it works for
  // both kinds.
  assert.match(TAB, /\{#if reading\}[\s\S]{0,300}onclick=\{onstop\}/)
})
