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
 *     projector as a dot;
 *   — a thumb coming to rest beside a drawing finger turned it into a pinch,
 *     and two seconds of its curve were taken back from the hall for good;
 *   — with the eraser armed, the first finger of a pinch or of a two-finger
 *     tap erased the ink under it for the whole hall.
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
  mayTakeBack,
  mergeInkPiece,
  PALM_TRAVEL_PX,
  PALM_YOUNG_MS,
  STRAIGHT_HOLD_MS,
  STRAIGHT_MIN_PX,
  STRAIGHT_STILL_PX,
  straightens,
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

test('under a zoom the eraser still reaches as far as its ring on the glass', () => {
  for (const zoom of [1, 2, 4]) {
    // In px of the glass: the page is the sheet times the zoom wide there.
    const glass = eraserReach(0.004 / zoom, 1084 * zoom) * 1084 * zoom
    assert.ok(
      Math.abs(glass - (ERASER_PX + (0.004 * 1084) / 2)) < 1e-9,
      `at ×${zoom} the eraser reaches ${glass.toFixed(2)} px on the glass`,
    )
  }
})

/* --------------------------------------------------- straight on hold */

/** A hand-drawn line in page fractions: from (x0, y0) to (x1, y1) with a wobble across it. */
function wobbly(x0: number, y0: number, x1: number, y1: number, wobble: number, steps = 40): number[] {
  const out: number[] = []
  const len = Math.hypot(x1 - x0, y1 - y0)
  const nx = -(y1 - y0) / len
  const ny = (x1 - x0) / len
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const off = wobble * Math.sin(t * Math.PI * 3)
    out.push(x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off)
  }
  return out
}

/** The landscape console's sheet. */
const PX = 1084
const PY = 610

test('an underline held at its end straightens; the hold is a still pen, not a pause between strokes', () => {
  // Three hundred pixels with a three-pixel wobble: an underline as the hand draws it.
  const line = wobbly(0.2, 0.5, 0.48, 0.5, 3 / PX)
  assert.ok(straightens(line, { x: 0.48, y: 0.5 }, PX, PY))
  // An axis drawn down the slide, with a slight bow.
  const axis = wobbly(0.1, 0.1, 0.1, 0.8, 12 / PX)
  assert.ok(straightens(axis, { x: 0.1, y: 0.8 }, PX, PY), 'a bowed axis is still a line')
  // The rule's numbers: about half a second of rest, a few pixels of tremor.
  assert.ok(STRAIGHT_HOLD_MS >= 400 && STRAIGHT_HOLD_MS <= 800)
  assert.ok(STRAIGHT_STILL_PX >= 3 && STRAIGHT_STILL_PX <= 6)
})

test('a dot, a tick, a bracket, an arc or a corner held still stays as it was drawn', () => {
  // Shorter than STRAIGHT_MIN_PX on the glass: a dot or a tick.
  const tick = [0.5, 0.5, 0.5 + (STRAIGHT_MIN_PX - 4) / PX, 0.5]
  assert.ok(!straightens(tick, { x: tick[2], y: tick[3] }, PX, PY))
  // A bracket forty pixels tall: its bow is a fifth of its length.
  const bracket: number[] = []
  for (let i = 0; i <= 20; i += 1) {
    const a = -0.6 + (1.2 * i) / 20
    bracket.push(0.5 - (Math.cos(a) * 24) / PX, 0.5 + (Math.sin(a) * 24) / PY)
  }
  assert.ok(!straightens(bracket, { x: bracket[40], y: bracket[41] }, PX, PY), 'a bracket became a bar')
  // Three quarters of a circle.
  const arc: number[] = []
  for (let i = 0; i <= 30; i += 1) {
    const a = (Math.PI * 1.5 * i) / 30
    arc.push(0.5 + (Math.cos(a) * 80) / PX, 0.5 + (Math.sin(a) * 80) / PY)
  }
  assert.ok(!straightens(arc, { x: arc[60], y: arc[61] }, PX, PY), 'an arc became a chord')
  // A corner: along, then down.
  const corner = [...wobbly(0.2, 0.2, 0.4, 0.2, 0), ...wobbly(0.4, 0.2, 0.4, 0.5, 0)]
  assert.ok(!straightens(corner, { x: 0.4, y: 0.5 }, PX, PY), 'a corner became its hypotenuse')
  // Out and back along the same line: the end is not the far end.
  const back = [...wobbly(0.2, 0.5, 0.5, 0.5, 0), ...wobbly(0.5, 0.5, 0.35, 0.5, 0)]
  assert.ok(!straightens(back, { x: 0.35, y: 0.5 }, PX, PY), 'a scribble back became a shorter line')
})

test('the thresholds are on the glass: under a zoom a short page distance is a long line', () => {
  // Twelve page pixels across: too short at ×1, forty-eight on the glass at ×4.
  const short = wobbly(0.5, 0.5, 0.5 + 12 / PX, 0.5, 0, 6)
  const end = { x: short[short.length - 2], y: short[short.length - 1] }
  assert.ok(!straightens(short, end, PX, PY))
  assert.ok(straightens(short, end, PX * 4, PY * 4))
})

/* ------------------------------------------- the start of a gesture */

/** A finger stroke along the sheet, `px` long on the glass, sampled every 4 px. */
function along(px: number): number[] {
  const out: number[] = []
  for (let x = 0; x <= px; x += 4) out.push(0.2 + x / PX, 0.5)
  return out
}

test('a young or a hardly moved finger stroke may be taken back; an established one may not', () => {
  // The palm under a landing pen, the first finger of a pinch: a moment old.
  assert.equal(mayTakeBack(along(200), PALM_YOUNG_MS - 1, PX, PY), true, 'young')
  // Resting where it landed, however long.
  assert.equal(mayTakeBack(along(PALM_TRAVEL_PX - 4), 5_000, PX, PY), true, 'short')
  assert.equal(mayTakeBack([0.5, 0.5], 5_000, PX, PY), true, 'a dot')
  // The review's case: a finger drawing for 1.2 s when a thumb came to rest beside it.
  assert.equal(mayTakeBack(along(150), 1_200, PX, PY), false, 'two seconds of a curve vanished from the hall')
  assert.equal(mayTakeBack(along(PALM_TRAVEL_PX + 4), PALM_YOUNG_MS, PX, PY), false)
  // Travel is on the glass: under ×4 a short page distance is a long way for the finger.
  const short = along(4)
  assert.equal(mayTakeBack(short, 1_000, PX, PY), true)
  assert.equal(mayTakeBack(short, 1_000, PX * 4, PY * 4), false)
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
  // Both on the glass: under a zoom the page is the sheet times the zoom
  // wide, and the ring and the reach are divided by the same factor.
  assert.match(body('rub'), /eraserReach\(stroke\.width, w \* near\)/)
  assert.match(body('paintLive'), /arc\(x, y, ERASER_PX \/ near/)
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

test('the palm under a pen and the first finger of a pinch take back only what may be taken back', () => {
  // One rule for both, from ink.ts: an older and longer stroke is ink the hall has watched.
  assert.match(body('dropPalm'), /mayTakeBack\(stroke\.points, performance\.now\(\) - stroke\.bornAt, w \* near, h \* near\)/)
  const commit = body('commitPinch')
  assert.match(
    commit,
    /if \(mayTakeBack\(stroke\.points, performance\.now\(\) - stroke\.bornAt, w \* near, h \* near\)\) takeBack\(\)\s*else closeStroke\(\)/,
    'a pinch takes back a long stroke again',
  )
  assert.doesNotMatch(INK, /const PALM_(YOUNG_MS|TRAVEL_PX) =/, 'the ink layer keeps a rule of its own again')
})

test('a second finger landing with the first forgets what the first held back: stroke, erase, beam', () => {
  const down = body('down')
  // Before `mine`: with the finger off, the first finger may be leading the beam.
  const forget = down.indexOf('forgetFirst()')
  assert.ok(forget !== -1 && forget < down.indexOf('if (!mine(event)) return'), 'the second finger is judged after `mine`')
  const first = body('forgetFirst')
  assert.match(first, /drawing\.stroke\.handed === 0/)
  assert.match(first, /performance\.now\(\) - first\.down <= TAP_TOGETHER_MS/)
  assert.match(first, /forgetUnsent\(\)/)
  assert.match(first, /if \(erasing !== null && eraseHeld\) \{\s*forgetErase\(\)/)
  assert.match(first, /if \(beaming !== null && beamHeld\) \{\s*dropBeam\(\)/)
})

test('a finger’s erase is hidden at once but reaches the room only once a second finger is ruled out', () => {
  const down = body('down')
  // A finger's sweep is held for the same window as its stroke; a pen's is not.
  assert.match(
    down,
    /if \(event\.pointerType === 'touch'\) \{\s*eraseHeld = \{ gesture: eraseGesture, hits: \[\], wet: \[\] \}\s*eraseHeldTimer = window\.setTimeout\(sendErase, TAP_TOGETHER_MS\)/,
  )
  // A pen landing on a finger's held erase: the finger was the palm.
  assert.match(down, /if \(eraseHeld\) forgetErase\(\)\s*erasing = event\.pointerId/)
  const rub = body('rub')
  const held = rub.indexOf('if (eraseHeld) {')
  const send = rub.indexOf("session.send({ t: 'ink:erase'")
  assert.ok(held !== -1 && held < send, 'a held finger erases for the room at the touch again')
  assert.match(rub, /erased = new Set\(\[\.\.\.erased, \.\.\.hit\]\)/, 'the held erase is not hidden at once')
  // The window closes or the finger lifts alone: what it hid goes out, under its own sweep.
  assert.match(body('sendErase'), /session\.send\(\{ t: 'ink:erase', page: hit\.page, id: hit\.id, gesture: held\.gesture \}\)/)
  assert.match(body('stopErase'), /^[^]*?\{\s*sendErase\(\)/, 'a lift inside the window loses the erase')
  // A second finger or a pen: nothing was erased, and the strokes show again.
  const forget = body('forgetErase')
  assert.match(forget, /unhide\(held\)/)
  assert.doesNotMatch(forget, /send\(/)
  assert.match(body('unhide'), /erased = new Set\(\[\.\.\.erased\]\.filter\(\(id\) => !back\.has\(id\)\)\)/)
  assert.match(body('unhide'), /wet = \[\.\.\.wet, \.\.\.held\.wet\]/)
})
