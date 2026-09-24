/**
 * One trouble is told once, in the voice of whatever is on the screen.
 *
 * The room's terminal states — "this seminar was deleted" and "this tab has
 * diverged from the server" — are drawn by the room on top of everything
 * (z-[100]): under the projection (z-90) and the console wrapper (z-95) they
 * were drawn and invisible, while both surfaces kept looking alive. The plates
 * were raised — and on the tablet there came to be two messages about the
 * same thing: the console sheet inside the wrapper and the room's bar on top
 * of it. Nothing actually breaks from this, but it is said twice, and the
 * second voice is one built for a window with a mouse: a line in text-ui and a
 * 30 px button at the bottom edge of the tablet.
 *
 * Hence the agreement: on the console, ConsoleView speaks about a deleted room
 * and about the divergence — in its own words, at its own finger-sized scale,
 * and with the promise that the lecture has not been interrupted — and the
 * room stays silent on the console. On the projection it is the other way
 * round: LectureView has no words of its own, and the room's bar there is the
 * only thing that explains the frozen page to the hall.
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

const SESSION = code(read('web/src/screens/SessionScreen.svelte'))
const CONSOLE = code(read('web/src/components/lecture/ConsoleView.svelte'))

test('the room stays silent about a deleted seminar where the console speaks', () => {
  assert.match(SESSION, /\{#if session\.gone && !pult\}/, 'the room plate is drawn on the console again')
  assert.match(CONSOLE, /\{#if session\.gone\}/, 'and the console says nothing at all about a deleted room')
})

test('the room stays silent about diverging from the server where the console speaks', () => {
  assert.match(
    SESSION,
    /\{#if session\.stuck && !session\.gone && !pult\}/,
    'the room bar lies over the console sheet again: two messages about one thing',
  )
  assert.match(CONSOLE, /\{:else if session\.stuck\}/, 'and the console is silent about the divergence')
  assert.match(CONSOLE, /reloadByHand\(\)/, 'the console has no reload button')
})

test('both plates stay on the projection: it has no words of its own', () => {
  // The projector screen is exactly the case the plates were raised above z-90
  // for: the hall sees a frozen page, and there is no reason on screen. The
  // projection has not gained words of its own, so there is nothing to switch off on it.
  const lecture = code(read('web/src/components/lecture/LectureView.svelte'))
  assert.doesNotMatch(lecture, /session\.stuck/, 'the projection has words of its own: the agreement has changed')
  const gone = SESSION.match(/\{#if session\.gone[^}]*\}/)?.[0] ?? ''
  const stuck = SESSION.match(/\{#if session\.stuck && !session\.gone[^}]*\}/)?.[0] ?? ''
  for (const [what, plate] of [
    ['"deleted"', gone],
    ['"diverged"', stuck],
  ] as const) {
    assert.doesNotMatch(plate, /projection/, `${what}: the plate was switched off on the projector screen too`)
  }
})

test('lifting the notification stack above the bar stays tied to the bar', () => {
  // The stack is drawn only in the room anyway (`!pult && !projection`), but the
  // height of its bottom offset is computed from `session.stuck` — that is, from
  // whether there is a bar under it. These two must not drift apart: the toasts would land on it.
  assert.match(
    SESSION,
    /\{#if !session\.gone && !pult && !projection\}/,
    'the notification stack is drawn outside the room too',
  )
  assert.match(
    SESSION,
    /session\.stuck \? 'bottom-\[4\.75rem\]' : 'bottom-4'/,
    'the stack lift is gone',
  )
})
