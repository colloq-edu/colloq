/**
 * The hold ring: on the console, a ring that closes round the pen's tip while
 * a stroke that would straighten is held still, full at the moment the line
 * snaps. In the design's words: the pen has frozen at the end of the stroke,
 * and a ring closes at its tip; it is drawn on the console only, and it does
 * not light up at the short stops of handwriting.
 *
 * What is checked here, with numbers:
 *
 *   — the ring keeps out of the first moments of a rest, so the stops of a
 *     writing hand never light it;
 *   — it shows up empty and is full exactly when the line straightens: it is
 *     a countdown, and a countdown that ends early or late lies;
 *   — once the line has snapped it goes out within a blink;
 *   — it asks for frames only while it closes or fades: a ring waiting for
 *     its line, or no ring, costs the live canvas nothing;
 *   — and in the ink layer: it is the console's only, drawn on the live
 *     canvas only, never sent, and promised by the very rule that straightens.
 *
 * The timing is a pure function of web/src/components/lecture/ink.ts; the
 * ink layer's use of it is read off its source at the end.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOLD_RING_AFTER_MS,
  HOLD_RING_FADE_MS,
  holdRingAt,
  STRAIGHT_HOLD_MS,
} from '../web/src/components/lecture/ink.js'

/** A rest that began at an arbitrary moment of `performance.now()`. */
const SINCE = 12_345.6

/* ------------------------------------------------------------ the timing */

test('a short stop of the writing hand shows no ring', () => {
  assert.equal(holdRingAt(SINCE, SINCE), null, 'the ring is there the moment the pen stops')
  assert.equal(holdRingAt(SINCE + HOLD_RING_AFTER_MS - 1, SINCE), null)
  // Long enough to sit out a stop of handwriting, short enough to leave the
  // ring most of the hold to run its course in.
  assert.ok(HOLD_RING_AFTER_MS >= 100, `the ring lights after ${HOLD_RING_AFTER_MS} ms of rest`)
  assert.ok(HOLD_RING_AFTER_MS <= STRAIGHT_HOLD_MS / 3, 'the ring has no time left to close')
})

test('the ring shows up empty and closes evenly, full exactly when the line straightens', () => {
  const first = holdRingAt(SINCE + HOLD_RING_AFTER_MS, SINCE)
  assert.deepEqual(first, { closed: 0, alpha: 1, moving: true }, 'it jumps in part-way or faded')
  // Half-way between showing up and the snap, half of it is closed.
  const half = holdRingAt(SINCE + (HOLD_RING_AFTER_MS + STRAIGHT_HOLD_MS) / 2, SINCE)
  assert.ok(half && Math.abs(half.closed - 0.5) < 1e-9, `half-way it is ${half?.closed} closed`)
  // Never ahead of the clock: a millisecond before the snap it is still open.
  const before = holdRingAt(SINCE + STRAIGHT_HOLD_MS - 1, SINCE)
  assert.ok(before && before.closed < 1 && before.moving)
  assert.deepEqual(holdRingAt(SINCE + STRAIGHT_HOLD_MS, SINCE), { closed: 1, alpha: 1, moving: false })
  // A late timer: the full ring simply waits for its line.
  assert.deepEqual(holdRingAt(SINCE + STRAIGHT_HOLD_MS + 40, SINCE), { closed: 1, alpha: 1, moving: false })
})

test('it only ever closes while the pen rests', () => {
  let last = -1
  for (let t = HOLD_RING_AFTER_MS; t <= STRAIGHT_HOLD_MS + 50; t += 7) {
    const ring = holdRingAt(SINCE + t, SINCE)
    assert.ok(ring, `no ring at ${t} ms of rest`)
    assert.ok(ring.closed >= last, `it opened up again at ${t} ms`)
    last = ring.closed
  }
  // The pen moved past its resting spot: the rest starts over, and so does the ring, from nothing.
  assert.equal(holdRingAt(SINCE + 400, SINCE + 400), null)
})

test('once the line has snapped, the closed ring goes out within a blink', () => {
  const snap = SINCE + STRAIGHT_HOLD_MS
  assert.ok(HOLD_RING_FADE_MS > 0 && HOLD_RING_FADE_MS <= 120, `it fades for ${HOLD_RING_FADE_MS} ms`)
  assert.deepEqual(holdRingAt(snap, SINCE, snap), { closed: 1, alpha: 1, moving: true })
  const going = holdRingAt(snap + HOLD_RING_FADE_MS / 2, SINCE, snap)
  assert.ok(going && going.closed === 1 && Math.abs(going.alpha - 0.5) < 1e-9 && going.moving)
  assert.equal(holdRingAt(snap + HOLD_RING_FADE_MS, SINCE, snap), null)
  assert.equal(holdRingAt(snap + 5_000, SINCE, snap), null)
  // A frame stamped a hair before the snap (the timer and the frame keep different
  // clocks) draws it whole, never brighter than whole.
  assert.equal(holdRingAt(snap - 3, SINCE, snap)?.alpha, 1)
})

test('the ring asks for frames only while it closes or fades', () => {
  /** How many 60 Hz frames ask for the next one, from the start of a rest on. */
  const frames = (snapAt: number | null): number => {
    let asked = 0
    for (let t = 0; t <= 2_000; t += 1000 / 60) {
      const ring = holdRingAt(SINCE + t, SINCE, snapAt !== null && t >= snapAt ? SINCE + snapAt : null)
      if (ring?.moving) asked += 1
    }
    return asked
  }
  // A rest that ends in no line (the stroke is no line, or the pen lifts at
  // the last moment): only the closing, about a frame per 16.7 ms of it.
  const closing = ((STRAIGHT_HOLD_MS - HOLD_RING_AFTER_MS) * 60) / 1000
  assert.ok(Math.abs(frames(null) - closing) <= 1, `${frames(null)} frames, not ${closing}`)
  // A rest that ends in a line: the closing and the fade, nothing after.
  const fading = (HOLD_RING_FADE_MS * 60) / 1000
  assert.ok(Math.abs(frames(STRAIGHT_HOLD_MS) - (closing + fading)) <= 2, `${frames(STRAIGHT_HOLD_MS)} frames`)
})

/* ------------------------------------------------- the ink layer itself */

/** The source without comments: an explanation is not a promise. */
function code(rel: string): string {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}

const INK = code('web/src/components/lecture/InkLayer.svelte')

/** One function's body, from its name to the next top-level function. */
function body(name: string): string {
  const from = INK.indexOf(`function ${name}(`)
  assert.notEqual(from, -1, `${name} is gone from the ink layer`)
  const rest = INK.slice(from + 1)
  const to = rest.search(/\n {2}function /)
  return to === -1 ? rest : rest.slice(0, to)
}

test('the ring is the console’s: off unless the parent turns it on, and nobody else does', () => {
  assert.match(INK, /holdRing = false,/, 'the ring is on by default, on the projector too')
  // The projector, the audience and the laptop column all render the ink layer from here.
  assert.doesNotMatch(code('web/src/components/lecture/LectureView.svelte'), /holdRing/)
  // Without the prop no rest even sets the ring's timer.
  assert.match(body('restAt'), /holdTimer = holdRing \? window\.setTimeout\(holdCheck, HOLD_RING_AFTER_MS\)/)
})

test('the ring lives on the live canvas only and never goes down the wire', () => {
  assert.match(body('paintLive'), /const hold = holdShown\(now\)/)
  for (const name of ['paintDry', 'paintWetAll', 'growWet', 'paintMarkers']) {
    assert.doesNotMatch(body(name), /holdShown|holdRingAt|HOLD_RING/, `${name} draws the hold ring into the ink`)
  }
  for (const name of ['holdCheck', 'holdHide', 'holdShown']) {
    assert.doesNotMatch(body(name), /send\(/, `${name} tells the room about the ring`)
  }
})

test('the ring is promised by the very rule that straightens the line', () => {
  assert.match(body('straightenNow'), /straightPlan\(held\)/)
  assert.match(body('holdCheck'), /straightPlan\(held\) !== null/)
  // A rest whose line did not come shows no ring that would never close on anything.
  assert.match(body('holdCheck'), /stillTimer !== undefined/)
  // The line going in, the ring going out: only after a ring was shown.
  assert.match(body('straightenNow'), /if \(promised\) holdSnapped = /)
})

test('the ring costs a frame only while it moves', () => {
  const tick = body('tick')
  assert.match(tick, /if \(moving \|\| alive \|\| hold\?\.moving\) liveFrame = requestAnimationFrame\(tick\)/)
  // A frame repaints for the ring only when it would look different.
  assert.match(tick, /hold\?\.closed !== holdDrawn\?\.closed \|\| hold\?\.alpha !== holdDrawn\?\.alpha/)
})
