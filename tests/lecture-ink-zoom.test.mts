/**
 * The ink under the zoom: what the presenter's fingers and magnifier ask
 * for, and how the ink keeps its look on the glass while the page is
 * magnified inside its frame.
 *
 * The owner asked to "zoom in on the console, and have the projector show the
 * same, to point something out or look at a picture closer". Each part of it
 * is checked here with numbers:
 *
 *   — two fingers that spread or slide move the view, and only once they
 *     clearly do: until then they are still the two-finger tap, which is
 *     Undo, and the stand's tap does not move at all;
 *   — and only two fingers put down together, with no palm on the glass and
 *     the pen not near it, hovering included: a thumb resting beside a
 *     drawing finger, or the small contacts of a resting hand, never zoom;
 *   — the place under the fingers stays under them, computed from where the
 *     gesture began, so the page does not creep under resting fingers;
 *   — the magnifier's frame becomes the view, and a tap comes twice as close;
 *   — a stroke written on a magnified detail looks as thick as at ×1, and is
 *     clamped into the server's range before it is sent.
 *
 * Pure functions from web/src/components/lecture/ink.ts, and the ink layer's
 * use of them read off its source at the end.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INK_WIDTH_MAX, INK_WIDTH_MIN, ZOOM_MAX, type LectureZoom } from '../shared/lecture.js'
import {
  fingerPair,
  frameZoom,
  inkWidthAt,
  PALM_QUIET_MS,
  PINCH_SLIDE_PX,
  PINCH_SPREAD,
  PINCH_SPREAD_PX,
  pinchCommits,
  pinchMayStart,
  pinchZoom,
  RestingPalms,
  TAP_TOGETHER_MS,
} from '../web/src/components/lecture/ink.js'
import { boxToPage, zoomStep, zoomToRect } from '../web/src/components/lecture/zoom.js'

/** The landscape console's sheet on screen. */
const FRAME = { left: 96, top: 12, width: 1084, height: 610 }

/** Two fingers around a point of the frame, `d` px apart, side by side. */
function pair(u: number, v: number, d: number) {
  const x = FRAME.left + u * FRAME.width
  const y = FRAME.top + v * FRAME.height
  return fingerPair({ x: x - d / 2, y }, { x: x + d / 2, y })
}

/* ---------------------------------------------------------- the width */

test('a stroke written under the zoom is as thick on the glass as at ×1', () => {
  const sheet = 1084
  for (const z of [1, 1.5, 2.5, 4]) {
    const width = inkWidthAt(0.0035, { x: 0, y: 0, z })
    // On the glass: the page is the sheet times the zoom wide.
    assert.ok(Math.abs(width * sheet * z - 0.0035 * sheet) < 0.01, `at ×${z} the line is ${width * sheet * z} px`)
  }
  assert.equal(inkWidthAt(0.0035, null), 0.0035)
  assert.equal(inkWidthAt(0.0035, undefined), 0.0035)
})

test('the width is clamped into the server’s range before it is sent', () => {
  // A thin pen deep in the zoom would go under the floor; the server would
  // clamp it quietly and the hall would draw a thicker line than the presenter.
  assert.equal(inkWidthAt(0.0015, { x: 0, y: 0, z: 4 }), INK_WIDTH_MIN)
  assert.equal(inkWidthAt(0.2, null), INK_WIDTH_MAX)
  // The thinnest pen of the console at the deepest zoom stays above the floor.
  assert.ok(inkWidthAt(0.0025, { x: 0, y: 0, z: ZOOM_MAX }) > INK_WIDTH_MIN)
})

/* ---------------------------------------------------------- the pinch */

test('the stand’s two-finger tap is not a pinch: until the fingers clearly move, they are Undo', () => {
  // Two touches 56 px apart that do not move at all (pencil-check scenario 7).
  const start = pair(0.5, 0.5, 56)
  assert.equal(pinchCommits(start, start), false)
  // A real tap wobbles by a pixel or two.
  const wobble = fingerPair({ x: start.x - 27, y: start.y + 1 }, { x: start.x + 29, y: start.y - 1 })
  assert.equal(pinchCommits(start, wobble), false)
})

test('a tenth of spread or sixteen pixels of slide make a pinch, a little less does not', () => {
  const start = pair(0.5, 0.5, 200)
  assert.equal(pinchCommits(start, pair(0.5, 0.5, 200 * (1 + PINCH_SPREAD * 1.01))), true, 'spread')
  assert.equal(pinchCommits(start, pair(0.5, 0.5, 200 * (1 - PINCH_SPREAD * 1.01))), true, 'closed')
  assert.equal(pinchCommits(start, pair(0.5, 0.5, 200 * (1 + PINCH_SPREAD * 0.9))), false)
  assert.equal(pinchCommits(start, pair(0.5, 0.5, 200 * (1 - PINCH_SPREAD * 0.9))), false)
  const slid = { ...start, x: start.x + PINCH_SLIDE_PX }
  assert.equal(pinchCommits(start, slid), true, 'slid')
  assert.equal(pinchCommits(start, { ...start, y: start.y + PINCH_SLIDE_PX - 1 }), false)
})

test('a pinch is two fingers put down together, with no palm resting and the pen away', () => {
  // The stand's pinch: the second finger 30 ms after the first.
  assert.equal(pinchMayStart(30, 0, false), true)
  assert.equal(pinchMayStart(TAP_TOGETHER_MS, 0, false), true)
  // A thumb coming to rest beside a finger that has been drawing for a while.
  assert.equal(pinchMayStart(TAP_TOGETHER_MS + 1, 0, false), false, 'a late second finger made a pinch')
  assert.equal(pinchMayStart(1_200, 0, false), false)
  // The heel lies on the glass: the two small contacts are its pinky and knuckle.
  assert.equal(pinchMayStart(40, 1, false), false, 'the resting hand zoomed the hall')
  // The pen touches, or touched or hovered a moment ago.
  assert.equal(pinchMayStart(40, 0, true), false, 'a hand beside a hovering pen zoomed the hall')
  // The same window as the tap's "together": what a finger holds back waits exactly that long.
  assert.ok(TAP_TOGETHER_MS >= 150 && TAP_TOGETHER_MS <= 300, `fingers ${TAP_TOGETHER_MS} ms apart are together`)
})

test('the place between the fingers stays between them while they spread and travel', () => {
  const from: LectureZoom = { x: 0.2, y: 0.1, z: 1.5 }
  const start = pair(0.3, 0.4, 120)
  const now = pair(0.45, 0.5, 240)
  const next = pinchZoom(from, FRAME, start, now)
  assert.ok(next, 'the pinch lost the zoom')
  assert.ok(Math.abs(next.z - 3) < 1e-3, `spreading twice from ×1.5 gave ×${next.z}`)
  // The page point under the first midpoint is now under the current midpoint.
  const grabbed = boxToPage(from, 0.3, 0.4)
  const held = boxToPage(next, 0.45, 0.5)
  assert.ok(Math.abs(grabbed.x - held.x) < 2e-4 && Math.abs(grabbed.y - held.y) < 2e-4, 'the page slid under the fingers')
})

test('the pinch is measured from where it began: fingers back where they started give the view back', () => {
  const from: LectureZoom = { x: 0.25, y: 0.25, z: 2 }
  const start = pair(0.5, 0.5, 150)
  // However the fingers went in between, only where they are now counts.
  for (const d of [300, 90, 260, 150]) pinchZoom(from, FRAME, start, pair(0.6, 0.4, d))
  assert.deepEqual(pinchZoom(from, FRAME, start, start), from)
})

test('the pinch stays within the page and the zoom’s range', () => {
  const start = pair(0.5, 0.5, 50)
  const far = pinchZoom(null, FRAME, start, pair(0.5, 0.5, 2000))
  assert.equal(far?.z, ZOOM_MAX, 'the fingers zoomed past the ceiling')
  // Closing the fingers below ×1 is the whole page.
  assert.equal(pinchZoom({ x: 0.1, y: 0.1, z: 1.2 }, FRAME, pair(0.5, 0.5, 300), pair(0.5, 0.5, 100)), null)
  // A two-finger drag of the whole page has nothing to move.
  assert.equal(pinchZoom(null, FRAME, start, pair(0.8, 0.5, 50)), null)
  // Dragging a magnified view far to the right brings it to the page's left edge, no further.
  const dragged = pinchZoom({ x: 0.3, y: 0.3, z: 2 }, FRAME, pair(0.2, 0.5, 80), pair(0.95, 0.5, 80))
  assert.equal(dragged?.x, 0)
})

/* ------------------------------------------------------ the magnifier */

test('a tap with the magnifier comes twice as close around the point', () => {
  assert.deepEqual(frameZoom(null, { x: 0.3, y: 0.4 }, null), zoomStep(null, 0.3, 0.4))
  const twice = frameZoom({ x: 0.2, y: 0.2, z: 1.5 }, { x: 0.4, y: 0.5 }, null)
  assert.equal(twice?.z, 3)
})

test('a dragged frame fills the sheet, whichever corner it was drawn from', () => {
  const a = { x: 0.75, y: 0.525 }
  const b = { x: 0.25, y: 0.275 }
  const expected = zoomToRect({ x: 0.25, y: 0.275, w: 0.5, h: 0.25 })
  assert.deepEqual(frameZoom(null, a, b), expected)
  assert.deepEqual(frameZoom(null, b, a), expected)
  assert.equal(expected?.z, 2)
  // Its centre is the frame's centre.
  const centre = boxToPage(expected, 0.5, 0.5)
  assert.ok(Math.abs(centre.x - 0.5) < 1e-4 && Math.abs(centre.y - 0.4) < 1e-4)
})

test('a frame drawn on a magnified detail magnifies further', () => {
  // ×2 shows [0.25, 0.75]; a frame over the left half of what is seen is ×4.
  const seen: LectureZoom = { x: 0.25, y: 0.25, z: 2 }
  const next = frameZoom(seen, boxToPage(seen, 0, 0), boxToPage(seen, 0.5, 0.5))
  assert.equal(next?.z, 4)
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

test('the canvases are painted at the zoom and read back through it', () => {
  // The zoom lives in one transform, the same as the page's own render.
  assert.match(body('fitTo'), /setTransform\(k, 0, 0, k, -\(view\?\.x \?\? 0\) \* w \* k, -\(view\?\.y \?\? 0\) \* h \* k\)/)
  // A place on the glass is a place in the painted region of the page.
  assert.match(body('at'), /boxToPage\(\s*zoom\.painted/)
  assert.match(body('at'), /if \(rectStale\) measure\(\)/, 'a moved view would map the pen through a stale rect')
  // Clearing is in device pixels: under a zoom the page transform misses the canvas.
  assert.match(body('wipe'), /setTransform\(1, 0, 0, 1, 0, 0\)/)
  // A new stroke keeps its look on the glass.
  assert.match(body('newStroke'), /inkWidthAt\(width, zoom\.shown\)/)
})

test('each canvas moves by itself and nothing between the page and the highlighter isolates it', () => {
  const page = INK.slice(INK.indexOf('<div bind:this={frameNode}'), INK.indexOf('<div\n    bind:this={inputNode}'))
  assert.equal(page.match(/style:transform=\{moved\}/g)?.length, 4, 'a canvas does not follow the zoom')
  const wrapper = page.slice(0, page.indexOf('>'))
  assert.match(wrapper, /overflow-hidden/)
  assert.doesNotMatch(wrapper, /transform|opacity|isolat|z-\[|filter/, 'the page box makes a stacking context')
  // The highlighter is the bottom canvas, and it multiplies.
  assert.ok(page.indexOf('ink-mark') < page.indexOf('ink-dry'), 'the marker lies over the pen ink')
  assert.match(INK, /\.ink-mark \{\s*mix-blend-mode: multiply;/)
  assert.match(INK, /\.ink-page canvas \{\s*transform-origin: 0 0;/)
})

test('translucent strokes never land among the pen ink', () => {
  assert.match(body('paintDry'), /!seeThrough\(stroke\.color\)/, 'a highlight is drawn over the pen ink again')
  assert.match(body('paintWetAll'), /seeThrough\(stroke\.color\)\) continue/)
  assert.match(body('growWet'), /if \(seeThrough\(stroke\.color\)\) \{\s*paintMarkers\(\)/)
  // A marker's predicted tip is part of its path, not a second translucent stroke over its end.
  assert.match(body('paintLive'), /if \(guess && !seeThrough\(guess\.color\)\)/)
})

test('only the presenter zooms: without `onzoom` two fingers are what they always were', () => {
  assert.match(body('pinchDown'), /if \(!onzoom\) return false/)
  // The pen never zooms and ends a pinch it lands in.
  assert.match(body('pinchDown'), /if \(event\.pointerType === 'pen'\) \{\s*pens\.add\(event\.pointerId\)/)
  // A committed pinch cancels the tap and takes back what the first finger began.
  const commit = body('commitPinch')
  assert.match(commit, /tap\.moved = true/)
  assert.match(commit, /takeBack\(\)/)
})

test('the pinch judges how the fingers landed: together, no palm resting, the pen not even hovering', () => {
  const down = body('pinchDown')
  // A palm is no finger; it was counted, and a candidate dropped, before the sheet heard of it.
  assert.match(down, /if \(palmish\(event\)\) return false/)
  assert.doesNotMatch(down, /palms\.(add|rest)\(/, 'the sheet counts palms of its own again: the console root hides them from it')
  assert.match(down, /fingers\.set\(event\.pointerId, \{ x: event\.clientX, y: event\.clientY, down: landed \}\)/)
  // The palms resting NOW: one silent past its time has gone (ink.ts · RestingPalms).
  assert.match(down, /pinchMayStart\(landed - first\.down, palms\.count\(landed\), penNear\(\)\)/)
  // Hover counts, in the tap's short window, not the pointer's long one.
  assert.match(body('penNear'), /performance\.now\(\) - lastPenNearAt < TAP_AFTER_PEN_MS/)
  assert.match(INK, /const palms = new RestingPalms\(\)/)
  assert.match(INK, /fingers\.clear\(\)\s*palms\.clear\(\)/, 'a palm outlives the input layer')
})

/*
 * The review's A6 as the console really sees it: ConsoleView's root swallows
 * a palm-sized touch in the capture phase, anywhere on the console, the sheet
 * included, so the ink layer's own handlers never heard of the heel. Its palm
 * count stayed empty, and the pinky and a knuckle of the resting hand zoomed
 * the hall ×1.13 (replayed on the real layer under a copy of that root).
 */
test('palms are heard from the whole window, before the console’s root, and counted until they lift', () => {
  const hear = body('hearPalms')
  // Heard in the capture phase on the window: nothing on the page runs before it.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    assert.match(
      hear,
      new RegExp(`window\\.addEventListener\\('${type}', hearPalms, options\\)`),
      `${type} is not heard from the window`,
    )
    assert.match(hear, new RegExp(`window\\.removeEventListener\\('${type}', hearPalms, options\\)`))
  }
  assert.match(hear, /const options = \{ capture: true, passive: true \}/)
  // Only while the layer takes input: off live, the count is wiped (see above).
  assert.match(INK, /const hearing = \$derived\(live && tool !== 'off'\)/)
  assert.match(hear, /\$effect\(\(\) => \{\s*if \(!hearing\) return/)
  // Touches only; a lift or a cancel takes the palm off.
  assert.match(hear, /if \(event\.pointerType !== 'touch'\) return/)
  assert.match(hear, /if \(event\.type === 'pointerup' \|\| event\.type === 'pointercancel'\) \{\s*palms\.lift\(id\)/)
  // A contact that lands palm-sized or grows so counts; a palm that stirs is heard again.
  assert.match(hear, /if \(!known && !palmish\(event\)\) return\s*palms\.rest\(id, performance\.now\(\)\)/)
  // A palm coming to rest drops a pinch that has not moved; its own fingers growing are the pinch's business.
  assert.match(
    hear,
    /if \(known \|\| !pinch \|\| pinch\.committed \|\| id === pinch\.a \|\| id === pinch\.b\) return\s*dropPinch\(\)/,
  )
  // Counting only: the touch goes on to the console's root untouched.
  assert.doesNotMatch(hear.slice(0, hear.indexOf('const hearing')), /stopPropagation|preventDefault/)
})

test('a palm whose lift the page missed stops counting once it falls silent; a resting one is heard again', () => {
  const palms = new RestingPalms()
  palms.rest(901, 0)
  palms.rest(902, 100)
  assert.equal(palms.count(200), 2)
  palms.lift(902)
  assert.equal(palms.count(300), 1)
  assert.ok(palms.has(901))
  // The lift of 901 never came: it forbids pinching for a few seconds, not for the rest of the lecture.
  assert.equal(palms.count(PALM_QUIET_MS - 1), 1)
  assert.equal(palms.count(PALM_QUIET_MS), 0, 'a palm whose lift was missed blocks every pinch for good')
  assert.ok(!palms.has(901))
  // A palm that keeps saying something (a heel stirring, a size changing) keeps counting.
  palms.rest(903, 10_000)
  for (let at = 11_000; at <= 30_000; at += 1_000) palms.rest(903, at)
  assert.equal(palms.count(30_000 + PALM_QUIET_MS - 1), 1)
  palms.clear()
  assert.equal(palms.count(0), 0)
  // A few seconds: longer than a heel lies still while one talks, short against a lecture.
  assert.ok(PALM_QUIET_MS >= 3000 && PALM_QUIET_MS <= 10_000, `${PALM_QUIET_MS} ms`)
})

test('a resting hand that rolls a few pixels is no pinch: the spread is counted in pixels too', () => {
  // The review's A6: the pinky and a knuckle land 51 px apart, the pinky rolls 6 px.
  const start = fingerPair({ x: 740, y: 430 }, { x: 790, y: 420 })
  const rolled = fingerPair({ x: 734, y: 433 }, { x: 790, y: 420 })
  assert.ok(rolled.d / start.d - 1 > PINCH_SPREAD, 'the roll is more than a tenth of the spread')
  assert.equal(pinchCommits(start, rolled), false, 'a 6 px roll of a resting hand zoomed the hall ×1.13')
  // Fingers close together still need their twelve pixels, and get them.
  const near = pair(0.5, 0.5, 40)
  assert.equal(pinchCommits(near, pair(0.5, 0.5, 40 + PINCH_SPREAD_PX - 1)), false)
  assert.equal(pinchCommits(near, pair(0.5, 0.5, 40 + PINCH_SPREAD_PX)), true)
  assert.equal(pinchCommits(near, pair(0.5, 0.5, 40 - PINCH_SPREAD_PX)), true, 'closing counts as spreading')
  // The stand's pinch (pencil-check 15): 80 px apart, 5 px per step each side, commits on the second step.
  const stand = pair(0.5, 0.5, 80)
  assert.equal(pinchCommits(stand, pair(0.5, 0.5, 90)), false)
  assert.equal(pinchCommits(stand, pair(0.5, 0.5, 100)), true)
  // Twelve pixels: more than a hand settles, less than the first moment of any pinch.
  assert.ok(PINCH_SPREAD_PX >= 8 && PINCH_SPREAD_PX < PINCH_SLIDE_PX)
})

test('a pinch finger that spreads to a palm’s size undoes the pinch, and the hall goes back', () => {
  const move = body('pinchMove')
  const palm = move.indexOf('if (palmish(event)) {')
  assert.ok(palm !== -1 && palm < move.indexOf('pinchCommits('), 'a heel that grew is judged after it moved the view')
  assert.match(move, /if \(palmish\(event\)\) \{\s*palmPinch\(held\)/)
  const undo = body('palmPinch')
  assert.match(undo, /if \(held\.committed\) onzoom\?\.\(held\.from, true\)/, 'the palm\'s zoom stays in the hall')
  assert.match(undo, /tap\.moved = true/, 'the palm still counts as half of an Undo tap')
})
