/**
 * The pen on the console: what it puts on the sheet, what it sends, and what
 * a finger or a palm is allowed to do.
 *
 * Each case was seen on an iPad or reproduced on the stand:
 *
 *   — a pen tap (a period, the dot on an i) vanished with the echo, because
 *     a tap is four identical numbers and a zero-length path draws nothing;
 *   — one finger tapping twice undid the last stroke for the whole hall;
 *   — the eraser ring was a fixed sixteen pixels while the reach was a share
 *     of the page width: in portrait a line inside the ring survived;
 *   — a hall that missed a stream frame glued the next piece on with a chord;
 *   — a resting pinky lit the pointer for the hall while the pen hovered (now the
 *     finger leads the pointer only once the pen has been away for a moment);
 *   — the palm that landed a moment before the first pen stroke stayed on the
 *     projector as a dot.
 *
 * Pure functions from web/src/components/lecture/ink.ts, and the ink layer's
 * use of them read off its source.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InkStroke } from '../shared/lecture.js'
import {
  eraserReach,
  ERASER_PX,
  isDot,
  mergeInkPiece,
  TAP_TOGETHER_MS,
  twoFingerTap,
  type Tap,
} from '../web/src/components/lecture/ink.js'

const stroke = (id: string, points: number[]): InkStroke => ({
  id,
  page: 1,
  color: '#111',
  width: 0.004,
  points,
})

/* ------------------------------------------------------------- dots */

test('a tap is a dot however many numbers it took; a real line is not', () => {
  // Down plus up on the same spot, and a Pencil reporting pressure in place.
  assert.ok(isDot([0.5, 0.5, 0.5, 0.5], 1180, 664))
  assert.ok(
    isDot([0.5, 0.5, 0.5, 0.5, 0.5002, 0.5, 0.5, 0.5], 1180, 664),
    'a quarter-pixel wobble is still the spot',
  )
  assert.ok(!isDot([0.5, 0.5, 0.5, 0.5, 0.502, 0.5], 1180, 664), 'two pixels of travel is a line')
  assert.ok(!isDot([0.5], 1180, 664))
})

/* ------------------------------------------------------ two-finger tap */

const tap = (pointer: number, down: number, up: number | null, moved = false): Tap => ({
  pointer,
  x: 0,
  y: 0,
  down,
  up,
  moved,
})

test('one finger tapping twice is not a two-finger tap', () => {
  // The iOS double-tap habit, or the edge of the hand bouncing: never both on the glass.
  assert.equal(twoFingerTap(tap(1, 0, 60), tap(2, 150, 210)), false)
  assert.equal(
    twoFingerTap(tap(1, 0, 60), tap(2, 60, 120)),
    false,
    'touching exactly as the first lifted',
  )
})

test('two fingers on the glass together, lifted together, are undo', () => {
  assert.equal(twoFingerTap(tap(1, 0, 140), tap(2, 40, 150)), true)
  assert.equal(
    twoFingerTap(tap(2, 40, 150), tap(1, 0, 140)),
    true,
    'the order of the lifts does not matter',
  )
})

test('a held, a moved or a late second touch is not undo', () => {
  assert.equal(twoFingerTap(tap(1, 0, 500), tap(2, 40, 520)), false, 'held')
  assert.equal(twoFingerTap(tap(1, 0, 140, true), tap(2, 40, 150)), false, 'moved')
  assert.equal(
    twoFingerTap(tap(1, 0, 400), tap(2, TAP_TOGETHER_MS + 10, 420)),
    false,
    'landed too late',
  )
  assert.equal(twoFingerTap(tap(1, 0, null), tap(2, 40, 150)), false, 'still down')
})

/* --------------------------------------------------------- the eraser */

test('the eraser takes what lies under its ring, in portrait as in landscape', () => {
  // The stand case: an iPad in portrait, an 810 px sheet, a line 12 px from the ring's centre.
  for (const sheet of [810, 1084, 1290]) {
    const reach = eraserReach(0.004, sheet) * sheet
    assert.ok(
      reach >= ERASER_PX,
      `a ${sheet} px sheet: the eraser reaches ${reach.toFixed(1)} px, the ring ${ERASER_PX}`,
    )
    assert.ok(reach >= 12, `a line inside the ring survives on a ${sheet} px sheet`)
    // And no further than the ring and the stroke's own edge.
    assert.ok(reach <= ERASER_PX + (0.004 * sheet) / 2 + 1e-9)
  }
})

/* ------------------------------------------------- positional appends */

test('a piece is laid at its place: an overlap is cut, a resend adds nothing', () => {
  const ink = [stroke('s1', [0.1, 0.1, 0.2, 0.2])]
  const grown = mergeInkPiece(ink, stroke('s1', [0.2, 0.2, 0.3, 0.3]), 2)
  assert.deepEqual(grown?.[0].points, [0.1, 0.1, 0.2, 0.2, 0.3, 0.3])
  assert.equal(
    mergeInkPiece(grown!, stroke('s1', [0.1, 0.1, 0.2, 0.2]), 0),
    grown,
    'a resend changed the copy',
  )
})

test('a piece beyond the copy is a gap, not a chord', () => {
  const ink = [stroke('s1', [0.1, 0.1, 0.2, 0.2])]
  assert.equal(mergeInkPiece(ink, stroke('s1', [0.8, 0.8]), 8), null)
  assert.equal(
    mergeInkPiece(ink, stroke('new', [0.8, 0.8]), 4),
    null,
    "a stroke whose beginning we never got",
  )
  // A new stroke from its beginning is simply added.
  assert.equal(mergeInkPiece(ink, stroke('new', [0.8, 0.8]), 0)?.length, 2)
})

test('a piece without a position (an older server) is appended as before', () => {
  const ink = [stroke('s1', [0.1, 0.1])]
  assert.deepEqual(
    mergeInkPiece(ink, stroke('s1', [0.2, 0.2]), undefined)?.[0].points,
    [0.1, 0.1, 0.2, 0.2],
  )
})

/* ------------------------------------------------- the ink layer itself */

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

test('a finger leads the pointer only when the pen has been away from the glass, hover included', () => {
  const mine = body('mine')
  assert.match(mine, /if \(finger\) return true/, 'a drawing finger must still lead every tool')
  assert.match(mine, /tool === 'laser'/, 'pointing with a finger with the pen in its case is gone (R13b)')
  assert.match(mine, /lastPenNearAt > FINGER_POINTER_AFTER_PEN_MS/, 'a pinky could light the pointer while the pen hovers')
  assert.match(body('penSeen'), /lastPenNearAt = performance\.now\(\)/, 'hover must count as the pen being near')
})

test('hovering proves a pen exists but does not start the pause before a two-finger tap', () => {
  const seen = body('penSeen')
  assert.match(seen, /event\.buttons !== 0/, 'hover counts as contact again')
})

test('the two-finger tap demands both fingers on the glass at once', () => {
  assert.match(body('tapUp'), /twoFingerTap\(/)
})

test('the eraser draws its ring with the radius it erases with', () => {
  assert.match(body('rub'), /eraserReach\(stroke\.width, w\)/)
  assert.match(body('paintLive'), /arc\(x, y, ERASER_PX/)
})

test('a pen landing on a fresh finger stroke takes the palm back instead of closing it', () => {
  const down = body('down')
  assert.match(down, /dropPalm\(\)/)
  const drop = body('dropPalm')
  assert.match(drop, /forgetUnsent\(\)/)
  assert.match(drop, /retract: true/)
})

test('ink pieces carry their position, and a resend starts where the server copy ends', () => {
  assert.match(body('sendPoints'), /from: from \+ offset/)
  assert.match(body('settle'), /sendPoints\(stroke, echo\?\.points\.length \?\? 0\)/)
})

test('samples on the spot are dropped and the smoothed point is rounded like the wire', () => {
  const add = body('addPoint')
  assert.match(add, /round\(smoothX\)/)
  assert.match(add, /INK_MIN_STEP_PX/)
  assert.match(
    add,
    /openStroke\(pointer, byFinger, place, force, stroke\.group \?\? stroke\.id\)/,
    'a continuation lost its group',
  )
})
