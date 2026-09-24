/**
 * The council attempt cap — one number on both sides.
 *
 * This broke silently and badly. The client did not know the number: a
 * snapshot of the sheet went out on every pause in typing, the server answered
 * with a length refusal — and a person finishing a long attempt got a toast
 * once a second that told them neither how much was typed nor how much was
 * allowed. And then worse: a snapshot over the cap does not get through, and
 * "Submit" sends WHAT THE SERVER HAS — on the student's screen the long text
 * is marked submitted, while the teacher's stack holds the previous, short
 * one. This is discovered at the review, when it is too late to rewrite.
 *
 * What is checked here is the pure half: the number is one
 * (`MAX_ATTEMPT_CHARS` from shared), the counter appears before the cap, not
 * after, and "does the server have what is on the sheet" is a separate
 * question that there is a way to answer.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ATTEMPT_CHARS } from '../shared/notebook.js'
import {
  attemptCounter,
  attemptInSync,
  attemptTooLong,
} from '../web/src/lib/council.svelte.js'
import type { CouncilMine } from '../shared/protocol.js'

function mine(text: string): CouncilMine {
  return {
    text,
    submittedAt: 1,
    updatedAt: 1,
    shown: false,
    correct: null,
    reply: null,
    run: null,
    queue: null,
    closed: false,
  }
}

/* --------------------------------------------------------------- the cap */

test('the cap is one and the same, and it comes from the shared ground', () => {
  assert.equal(MAX_ATTEMPT_CHARS, 8000)
  assert.equal(attemptTooLong('x'.repeat(MAX_ATTEMPT_CHARS)), false, 'exactly the cap fits')
  assert.equal(attemptTooLong('x'.repeat(MAX_ATTEMPT_CHARS + 1)), true)
  // An empty sheet is not "too long": an attempt that does not exist yet has
  // no length.
  assert.equal(attemptTooLong(''), false)
})

test('the counter stays silent while the cap is far away, and speaks in digit groups', () => {
  assert.equal(attemptCounter(0), null)
  assert.equal(attemptCounter(3000), null, 'over every sheet from the first letter — that is noise')
  // Nine tenths: the point where the counter is still a warning, not a
  // verdict.
  assert.equal(attemptCounter(MAX_ATTEMPT_CHARS * 0.9 - 1), null)
  const near = attemptCounter(MAX_ATTEMPT_CHARS * 0.9)
  assert.ok(near !== null, 'at the threshold it appeared')
  const over = attemptCounter(9012)
  assert.ok(over !== null)
  // A non-breaking space in the digit groups: "9 012" must not break in the
  // middle of the number.
  assert.match(over, /^9 012 из 8 000$/)
})

/* --------------------------------------------- "submitted" — but what? */

test('"does the server have what is on the sheet" is a separate question', () => {
  assert.equal(attemptInSync(mine('print(1)'), 'print(1)'), true)
  assert.equal(attemptInSync(mine('print(1)'), 'print(2)'), false, 'they diverged — "submitted" is lying')
  // There is no attempt on the server at all yet: an empty sheet equals it,
  // and any text does not.
  assert.equal(attemptInSync(undefined, ''), true)
  assert.equal(attemptInSync(null, 'x'), false)
})

/* ---------------------------------- what cannot be checked through runes */

const STATE = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'web/src/lib/council.svelte.ts'),
  'utf8',
)

test('a snapshot over the cap does not go out at all — no more toast on every pause', () => {
  const at = STATE.indexOf('  draft(cellId: string')
  const draft = STATE.slice(at, at + 200)
  assert.match(draft, /if \(attemptTooLong\(text\)\) return/)
  assert.match(draft, /#outbox\.hold\(cellId, text\)/)
})

test('output over the budget is asked for once per run, not on every frame', () => {
  const at = STATE.indexOf('  wantOutputs(')
  const want = STATE.slice(at, STATE.indexOf('  /** Run:', at))
  // The only reason is a trimmed attempt: the empty output of a real run asks
  // for nothing.
  assert.match(want, /if \(!run\?\.outputsOmitted\) return/)
  assert.match(want, /\$\{cellId\}:\$\{participantId\}:\$\{run\.startedAt\}/, 'the key includes the run')
  assert.match(want, /#askedOutputs\.has\(key\)/)
  assert.match(want, /t: 'council:attempt', cellId, participantId/)
  // The full stack arrives again and is trimmed again — the memory of requests
  // for this cell is cleared, otherwise the card would stay without output
  // forever.
  assert.match(STATE, /startsWith\(`\$\{message\.cellId\}:`\)\) this\.#askedOutputs\.delete\(key\)/)
})
