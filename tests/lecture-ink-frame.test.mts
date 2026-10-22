/**
 * A box held where it closes becomes a frame: on the console, a rectangle
 * drawn round a formula with the pen and held still at its close for
 * `STRAIGHT_HOLD_MS` turns into a clean rectangle frame, an empty box with
 * upright sides, the way GoodNotes does it. The same road as the straight
 * line: the same hold, the same ring, the same replace-and-finalise path, so
 * the room gets one stroke and one Undo removes it.
 *
 * What is checked here:
 *
 *   — rough hand-drawn boxes become frames wherever they start and whichever
 *     way they go round, with jitter, rounded corners, a gap or an overshoot
 *     at the close, and the overshoot does not make the frame bigger;
 *   — so do wide, low boxes round a formula drawn a degree or two aslant
 *     and sagging, as a hand draws them;
 *   — circles, ellipses (flat ones too), triangles, an open U or L, a
 *     zigzag, a line and a letter at lecture size (a squarish "0", a boxy
 *     "D") stay as drawn (a line straightens instead: the line wins);
 *   — the thresholds are on the glass: a non-square sheet, a zoom;
 *   — the frame is one ordinary stroke with every corner given twice, so the
 *     renderers' midpoint curves draw sharp corners and straight sides;
 *   — after the snap the corner nearest the pen follows it, the opposite
 *     one stays;
 *   — and in the ink layer: the snap, the ring's promise and the drag go
 *     through the line's own road, and the highlighter's canvas, which knows
 *     a stroke by its last point, is drawn anew while a frame is dragged,
 *     read off its source.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dragFrame,
  framePoints,
  layCurve,
  rectangleOf,
  RECT_MIN_PX,
  STRAIGHT_MIN_PX,
  straightens,
  type InkRect,
} from '../web/src/components/lecture/ink.js'

/** The landscape console's sheet, in screen px. */
const PX = 1084
const PY = 610

/** A deterministic tremble, in px: the same hand on every run. */
const tremble = (i: number, amount: number) => amount * Math.sin(i * 2.3 + Math.cos(i * 0.7))

interface Box {
  /** Where on the perimeter the pen lands, 0..1 clockwise from the top left corner. */
  start?: number
  /** Clockwise (`1`) or counter-clockwise (`-1`). */
  dir?: 1 | -1
  jitter?: number
  /** How far the pen runs on past the start, straight on, in px. */
  overshoot?: number
  /** How far short of the start it stops, along the way round, in px. */
  gap?: number
  /** How round the hand turns the corners, in px. */
  radius?: number
  /** How far apart the samples are, in px. */
  step?: number
}

/**
 * A rectangle as a hand draws it, in screen px, from (x, y), `w` by `h`:
 * sampled every 4 px along the way round, trembling across it.
 */
function boxPx(x: number, y: number, w: number, h: number, box: Box = {}): [number, number][] {
  const { start = 0, dir = 1, jitter = 0, overshoot = 0, gap = 0, radius = 0, step = 4 } = box
  const perimeter = 2 * (w + h)
  /** The point at `s` px clockwise from the top left corner, its corners cut round by `radius`. */
  const at = (s: number): [number, number] => {
    const t = ((s % perimeter) + perimeter) % perimeter
    let px: number
    let py: number
    if (t < w) [px, py] = [x + t, y]
    else if (t < w + h) [px, py] = [x + w, y + t - w]
    else if (t < 2 * w + h) [px, py] = [x + w - (t - w - h), y + h]
    else [px, py] = [x, y + h - (t - 2 * w - h)]
    if (radius > 0) {
      // Pull a point near a corner onto the arc of radius `radius` inside it.
      const cx = Math.min(Math.max(px, x + radius), x + w - radius)
      const cy = Math.min(Math.max(py, y + radius), y + h - radius)
      const dx = px - cx
      const dy = py - cy
      const d = Math.hypot(dx, dy)
      if (d > 0 && dx !== 0 && dy !== 0) [px, py] = [cx + (dx / d) * radius, cy + (dy / d) * radius]
    }
    return [px, py]
  }
  const out: [number, number][] = []
  const from = start * perimeter
  const run = perimeter - gap
  let i = 0
  for (let s = 0; s <= run; s += step, i += 1) {
    const [px, py] = at(from + dir * s)
    out.push([px + tremble(i, jitter), py + tremble(i + 17, jitter)])
  }
  // Straight on past the close, the way the last stretch was going.
  if (overshoot > 0) {
    const [ax, ay] = at(from + dir * (run - step))
    const [bx, by] = at(from + dir * run)
    const len = Math.hypot(bx - ax, by - ay) || 1
    for (let s = step; s <= overshoot; s += step, i += 1) {
      out.push([bx + ((bx - ax) / len) * s, by + ((by - ay) / len) * s])
    }
  }
  return out
}

/** Screen px to the layer's page fractions on a `px` by `py` sheet. */
function page(pts: [number, number][], px = PX, py = PY): { points: number[]; end: { x: number; y: number } } {
  const points = pts.flatMap(([x, y]) => [x / px, y / py])
  return { points, end: { x: points[points.length - 2], y: points[points.length - 1] } }
}

/** What the layer asks: the rectangle the stroke becomes, in screen px, or `null`. */
function frameOf(pts: [number, number][], px = PX, py = PY): InkRect | null {
  const { points, end } = page(pts, px, py)
  const rect = rectangleOf(points, end, px, py)
  return rect && { x0: rect.x0 * px, y0: rect.y0 * py, x1: rect.x1 * px, y1: rect.y1 * py }
}

/** A frame within `slack` px of the box the hand meant. */
function near(rect: InkRect | null, x: number, y: number, w: number, h: number, slack = 5): boolean {
  return (
    !!rect &&
    Math.abs(rect.x0 - x) <= slack &&
    Math.abs(rect.y0 - y) <= slack &&
    Math.abs(rect.x1 - (x + w)) <= slack &&
    Math.abs(rect.y1 - (y + h)) <= slack
  )
}
const words = (rect: InkRect | null) =>
  rect ? `${rect.x0.toFixed(1)},${rect.y0.toFixed(1)} … ${rect.x1.toFixed(1)},${rect.y1.toFixed(1)}` : 'null'

/** A closed curve: the centre, the radii, and how many samples round. */
function oval(cx: number, cy: number, rx: number, ry: number, steps = 90, jitter = 0): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i <= steps; i += 1) {
    const a = (Math.PI * 2 * i) / steps - Math.PI / 2
    out.push([cx + Math.cos(a) * rx + tremble(i, jitter), cy + Math.sin(a) * ry + tremble(i + 5, jitter)])
  }
  return out
}

/** Straight runs through the given corners, sampled every 4 px. */
function through(...corners: [number, number][]): [number, number][] {
  const out: [number, number][] = [corners[0]]
  for (let k = 1; k < corners.length; k += 1) {
    const [ax, ay] = corners[k - 1]
    const [bx, by] = corners[k]
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 4))
    for (let i = 1; i <= steps; i += 1) out.push([ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps])
  }
  return out
}

/**
 * A box round a formula as a hand draws it, in screen px: clockwise from the
 * top left corner, its long sides `slope` px aslant end to end and sagging
 * `sag` px in the middle, its short sides following them.
 */
function formulaPx(x: number, y: number, w: number, h: number, slope: number, sag: number, jitter: number) {
  const at = (t: number): [number, number] => {
    if (t < w) return [x + t, y + slope * (t / w) + sag * Math.sin((Math.PI * t) / w)]
    if (t < w + h) return [x + w, y + slope + (t - w)]
    if (t < 2 * w + h) {
      const f = 1 - (t - w - h) / w
      return [x + f * w, y + h + slope * f + sag * Math.sin(Math.PI * f)]
    }
    return [x, y + h - (t - 2 * w - h)]
  }
  const out: [number, number][] = []
  for (let s = 0, i = 0; s <= 2 * (w + h); s += 4, i += 1) {
    const [px, py] = at(s)
    out.push([px + tremble(i, jitter), py + tremble(i + 17, jitter)])
  }
  return out
}

/** Points turned by `deg` degrees round (cx, cy). */
function turn(pts: [number, number][], deg: number, cx: number, cy: number): [number, number][] {
  const a = (deg * Math.PI) / 180
  return pts.map(([x, y]) => [
    cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a),
    cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a),
  ])
}

/* ------------------------------------------------------- what becomes a frame */

test('a rough box becomes a frame from any corner, either way round', () => {
  for (const start of [0, 0.25, 0.5, 0.75, 0.12, 0.4, 0.63, 0.9]) {
    for (const dir of [1, -1] as const) {
      const rect = frameOf(boxPx(200, 150, 300, 160, { start, dir, jitter: 2.5 }))
      assert.ok(near(rect, 200, 150, 300, 160), `started at ${start}, ${dir > 0 ? 'clockwise' : 'anticlockwise'}: ${words(rect)}`)
    }
  }
})

test('an overshoot at the close does not make the frame bigger', () => {
  // Started at a corner, closed coming up the left side and running on 20 px past the top.
  const corner = frameOf(boxPx(300, 200, 220, 220, { start: 0, dir: 1, jitter: 2, overshoot: 20 }))
  assert.ok(near(corner, 300, 200, 220, 220), `overshoot past the corner: ${words(corner)}`)
  // Started mid-side, running on along the first stretch.
  const side = frameOf(boxPx(300, 200, 260, 140, { start: 0.1, dir: -1, jitter: 2, overshoot: 30 }))
  assert.ok(near(side, 300, 200, 260, 140), `overshoot along the side: ${words(side)}`)
})

test('round corners and a close that stops short still make a frame', () => {
  const round = frameOf(boxPx(150, 120, 240, 120, { start: 0.3, radius: 10, jitter: 2 }))
  assert.ok(near(round, 150, 120, 240, 120, 6), `round corners: ${words(round)}`)
  const short = frameOf(boxPx(150, 120, 240, 120, { start: 0, gap: 14, jitter: 2 }))
  assert.ok(near(short, 150, 120, 240, 120), `stopped 14 px short: ${words(short)}`)
  // A box round one symbol: just over the minimum size.
  const small = frameOf(boxPx(500, 300, RECT_MIN_PX + 8, RECT_MIN_PX + 4, { start: 0.6, jitter: 1 }))
  assert.ok(small, 'a small box round a symbol stayed as drawn')
})

test('a wide box round a formula, aslant and sagging as a hand draws it, becomes a frame', () => {
  const cases: [string, [number, number][], number, number, number, number][] = [
    ['400×60, 1.4° aslant, sagging 5 px', formulaPx(150, 200, 400, 60, 10, 5, 2), 150, 200, 400, 60],
    ['400×50, 1° aslant', formulaPx(150, 200, 400, 50, 7, 0, 2), 150, 200, 400, 50],
    ['500×90, 1.6° aslant, sagging 5 px', formulaPx(100, 250, 500, 90, 14, 5, 2), 100, 250, 500, 90],
    ['300×60, 1.5° aslant, sagging 4 px', formulaPx(200, 200, 300, 60, 8, 4, 2), 200, 200, 300, 60],
    ['300×60 bowing out 8 px', formulaPx(200, 200, 300, 60, 0, 8, 2), 200, 200, 300, 60],
    ['400×70 turned 2°', turn(boxPx(150, 200, 400, 70, { start: 0.3, dir: -1, jitter: 2 }), 2, 350, 235), 150, 200, 400, 70],
    ['500×90 turned 3°', turn(boxPx(100, 250, 500, 90, { start: 0.7, jitter: 2 }), 3, 350, 295), 100, 250, 500, 90],
  ]
  for (const [what, pts, x, y, w, h] of cases) {
    const rect = frameOf(pts)
    assert.ok(rect, `${what} stayed as drawn`)
    // Upright, round the middle of what the hand drew: the slant splits either side.
    const lean = Math.abs(rect.x1 - rect.x0) * 0.03 + 8
    assert.ok(near(rect, x, y, w, h, lean), `${what}: ${words(rect)}`)
  }
})

/* ---------------------------------------------------- what stays as drawn */

test('circles, ellipses, triangles and open shapes stay as drawn', () => {
  const cases: [string, [number, number][]][] = [
    ['a circle', oval(400, 300, 80, 80, 90, 1.5)],
    ['a circle round a word', oval(400, 300, 120, 50, 120, 1.5)],
    ['a flat ellipse', oval(400, 300, 200, 40, 140)],
    ['an ellipse round a formula', oval(450, 300, 200, 30, 160, 2)],
    ['a long ellipse round a formula', oval(450, 300, 250, 45, 160, 2)],
    ['a big "o"', oval(400, 300, 26, 34, 40, 1)],
    ['a triangle', through([200, 400], [400, 400], [200, 250], [200, 400])],
    ['a triangle on its base', through([200, 400], [400, 400], [300, 250], [200, 400])],
    ['an open U', through([200, 150], [200, 350], [420, 350], [420, 150])],
    ['a U closed by a hair', through([200, 150], [200, 350], [420, 350], [420, 150], [300, 150])],
    ['an L', through([200, 150], [200, 350], [420, 350])],
    ['an L and back', through([200, 150], [200, 350], [420, 350], [200, 350], [200, 150])],
    ['a zigzag', through([200, 300], [250, 200], [300, 300], [350, 200], [400, 300], [200, 300])],
    ['a diamond', through([300, 150], [420, 280], [300, 410], [180, 280], [300, 150])],
    ['three sides and a diagonal', through([200, 150], [420, 150], [420, 350], [200, 350], [420, 150])],
  ]
  for (const [what, pts] of cases) assert.equal(frameOf(pts), null, `${what} became a frame: ${words(frameOf(pts))}`)
})

/** A squarish letter: a superellipse of exponent `n` (2 an ellipse, more a box with round corners). */
function squarish(cx: number, cy: number, rx: number, ry: number, n: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i <= 80; i += 1) {
    const a = (2 * Math.PI * i) / 80 - Math.PI / 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    out.push([
      cx + rx * Math.sign(c) * Math.abs(c) ** (2 / n) + tremble(i, 1),
      cy + ry * Math.sign(s) * Math.abs(s) ** (2 / n) + tremble(i + 5, 1),
    ])
  }
  return out
}

/** A "D": down its stem, then round a boxy bowl back up to the top. */
function boxyD(x: number, y: number, w: number, h: number): [number, number][] {
  const out: [number, number][] = []
  for (let s = 0; s <= h; s += 3) out.push([x, y + s])
  for (let i = 0; i <= 40; i += 1) {
    const a = Math.PI / 2 - (Math.PI * i) / 40
    const c = Math.cos(a)
    const s = Math.sin(a)
    out.push([x + w * Math.abs(c) ** 0.4, y + h / 2 + (h / 2) * Math.sign(s) * Math.abs(s) ** 0.4])
  }
  return out
}

test('a letter stays a letter, a line stays a line', () => {
  // A "□" written as a letter: under the minimum size on the glass.
  const letter = boxPx(500, 300, STRAIGHT_MIN_PX - 6, STRAIGHT_MIN_PX - 4, { start: 0, jitter: 0.5 })
  assert.equal(frameOf(letter), null, `a small square letter became a frame`)
  // Letters at lecture size a presenter may rest on at the close: a squarish "0" or "O", a boxy "D".
  for (const [what, pts] of [
    ['a squarish "0", 30×40', squarish(400, 300, 15, 20, 3)],
    ['a boxy "O", 30×40', squarish(400, 300, 15, 20, 5)],
    ['a squarish "O", 36×48', squarish(400, 300, 18, 24, 3)],
    ['a boxy "O", 36×48', squarish(400, 300, 18, 24, 4)],
    ['a boxy "D", 30×40', boxyD(300, 200, 30, 40)],
  ] as [string, [number, number][]][]) {
    assert.equal(frameOf(pts), null, `${what} became a frame: ${words(frameOf(pts))}`)
  }
  // A line straightens; it is never also a frame.
  const line = through([200, 300], [520, 302])
  const { points, end } = page(line)
  assert.ok(straightens(points, end, PX, PY))
  assert.equal(rectangleOf(points, end, PX, PY), null, 'a line became a frame')
})

test('the thresholds are on the glass: a non-square sheet, a zoom', () => {
  // The portrait console's sheet: the frame comes back in page fractions of its own sheet.
  const [px, py] = [810, 1140]
  const rect = rectangleOf(...(() => {
    const { points, end } = page(boxPx(120, 400, 300, 180, { start: 0.5, jitter: 2 }), px, py)
    return [points, end, px, py] as const
  })())
  assert.ok(rect, 'a box on the portrait sheet stayed as drawn')
  assert.ok(Math.abs(rect.x0 - 120 / px) < 6 / px && Math.abs(rect.x1 - 420 / px) < 6 / px)
  assert.ok(Math.abs(rect.y0 - 400 / py) < 6 / py && Math.abs(rect.y1 - 580 / py) < 6 / py)
  // A box fifteen page pixels across: a letter at ×1, a frame drawn on a detail magnified ×4
  // (sampled as densely on the glass as the others).
  const tiny = page(boxPx(400, 300, 15, 12, { start: 0, step: 1 }), PX, PY)
  assert.equal(rectangleOf(tiny.points, tiny.end, PX, PY), null)
  assert.ok(rectangleOf(tiny.points, tiny.end, PX * 4, PY * 4), 'under ×4 the box is big on the glass')
})

/* ---------------------------------------------------------- the frame stroke */

test('the frame is one stroke whose curves are straight sides meeting at sharp corners', () => {
  const rect = { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.5 }
  const points = framePoints(rect)
  assert.equal(points.length % 2, 0)
  const count = points.length / 2
  // Every corner twice, round and back to the first.
  const corners = [
    [0.2, 0.3],
    [0.6, 0.3],
    [0.6, 0.5],
    [0.2, 0.5],
    [0.2, 0.3],
  ]
  assert.equal(count, corners.length * 2)
  for (let k = 0; k < corners.length; k += 1) {
    for (const i of [k * 2, k * 2 + 1]) assert.deepEqual([points[i * 2], points[i * 2 + 1]], corners[k])
  }
  // Laid as every renderer lays a stroke: each curve's control point is on
  // the straight segment between its ends, so no curve cuts a corner off.
  let pen: [number, number] = [0, 0]
  const passes: [number, number][] = []
  const sink = {
    moveTo(x: number, y: number) {
      pen = [x, y]
      passes.push(pen)
    },
    lineTo(x: number, y: number) {
      pen = [x, y]
      passes.push(pen)
    },
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
      const cross = (cx - pen[0]) * (y - pen[1]) - (cy - pen[1]) * (x - pen[0])
      assert.ok(Math.abs(cross) < 1e-9, `a curve from ${pen} through ${cx},${cy} to ${x},${y} bends`)
      const along = (cx - pen[0]) * (x - cx) + (cy - pen[1]) * (y - cy)
      assert.ok(along >= -1e-12, 'a curve doubles back on itself')
      pen = [x, y]
      passes.push(pen)
    },
  }
  layCurve(sink, points, count, 0, 1000, 1000)
  sink.lineTo(points[points.length - 2] * 1000, points[points.length - 1] * 1000)
  for (const [x, y] of corners) {
    assert.ok(
      passes.some(([px, py]) => Math.abs(px - x * 1000) < 1e-6 && Math.abs(py - y * 1000) < 1e-6),
      `the path never reaches the corner ${x},${y}`,
    )
  }
})

/** The same frame, to a rounding error. */
function same(a: InkRect, b: InkRect, what: string): void {
  for (const key of ['x0', 'y0', 'x1', 'y1'] as const) {
    assert.ok(Math.abs(a[key] - b[key]) < 1e-9, `${what}: ${key} is ${a[key]}, not ${b[key]}`)
  }
}

test('after the snap the corner nearest the pen follows it, the opposite corner stays', () => {
  const rect = { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.5 }
  // The pen closed the box at its bottom right corner and drags it out.
  same(dragFrame(rect, { x: 0.6, y: 0.5 }, { x: 0.7, y: 0.55 }), { x0: 0.2, y0: 0.3, x1: 0.7, y1: 0.55 }, 'dragged out')
  // Closed a little way down the left side: the nearer corner moves by the pen's own movement, no jump.
  same(dragFrame(rect, { x: 0.2, y: 0.36 }, { x: 0.2, y: 0.36 }), rect, 'the frame jumped at the first tremble')
  same(dragFrame(rect, { x: 0.2, y: 0.36 }, { x: 0.15, y: 0.33 }), { x0: 0.15, y0: 0.27, x1: 0.6, y1: 0.5 }, 'top left')
  // Past the opposite corner: the frame turns over, its sides still upright.
  same(dragFrame(rect, { x: 0.6, y: 0.5 }, { x: 0.1, y: 0.2 }), { x0: 0.1, y0: 0.2, x1: 0.2, y1: 0.3 }, 'turned over')
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

test('one judgement for the line, the frame and the ring that promises them', () => {
  const plan = body('straightPlan')
  // The frame is asked for on the glass, as the line is, and only when the stroke is not a line.
  assert.match(plan, /rectangleOf\(points, held\.tip, w \* near, h \* near\)/)
  assert.match(plan, /if \(!frame && !straightens\(points, held\.tip, w \* near, h \* near\)\) return null/)
  assert.match(plan, /return \{ points, drying, out, frame \}/)
  // The ring promises whatever the hold would make.
  assert.match(body('holdCheck'), /straightPlan\(held\) !== null/)
})

test('the frame takes the line’s place: one stroke in for the whole motion, withheld until the lift', () => {
  const now = body('straightenNow')
  assert.match(now, /const shape = frame \? framePoints\(frame\)\.map\(round\) : \[points\[0\], points\[1\], held\.tip\.x, held\.tip\.y\]/)
  assert.match(now, /points: shape,/)
  // One pressure per point.
  assert.match(now, /force: frame \? shape\.filter\(\(_, i\) => i % 2 === 0\)\.map\(\(\) => last\)/)
  // The same road as the line: one wet stroke replaces every piece, the room's pieces withheld.
  assert.match(now, /straight: true/)
  assert.match(now, /wet = \[\.\.\.wet\.filter\(\(piece\) => !ids\.has\(piece\.id\)\), line\]/)
  assert.match(now, /held\.frame = frame \? \{ rect: frame, grip: held\.tip \} : null/)
  // The frame IS the line's stroke: one fresh id for the whole motion, and the
  // pieces it replaces go back on the lift whichever shape it took.
  assert.equal(now.match(/newStrokeId\(\)/g)?.length, 1, 'the snap makes more than one stroke')
  assert.match(now, /held\.stroke = line/)
  assert.match(now, /held\.replaced = out\.map/)
  assert.doesNotMatch(
    now.slice(now.indexOf('held.replaced = out.map') - 40, now.indexOf('held.replaced = out.map')),
    /if \(.*frame/,
    'a frame skips the pieces it replaces',
  )
  // The lift has no road of its own for a frame: the line's finalises it, so
  // the room gets one stroke and one Undo removes it.
  assert.doesNotMatch(body('closeStroke'), /frame/)
})

test('until the lift the pen drags the frame’s nearest corner, as it drags the line’s end', () => {
  const end = body('moveEnd')
  assert.match(end, /dragFrame\(held\.frame\.rect, held\.frame\.grip, place\)/)
  assert.match(end, /growWet\(held\.stroke\)/)
})

test('a highlighter frame dragged by a corner that is not its last point is drawn anew', () => {
  // The marker canvas skips a repaint while every stroke keeps its id, length and last point.
  assert.match(body('paintMarkers'), /stroke\.points\[n - 2\]\},\$\{stroke\.points\[n - 1\]\}/)
  assert.match(body('paintMarkers'), /key === markersDrawn\) return/)
  // A frame ends at its top left corner; dragged by any other, only its middle changes.
  const rect = { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.5 }
  const before = framePoints(rect)
  const after = framePoints(dragFrame(rect, { x: 0.6, y: 0.5 }, { x: 0.7, y: 0.55 }))
  assert.notDeepEqual(after, before)
  assert.deepEqual(after.slice(-2), before.slice(-2))
  // So `moveEnd` forgets what the canvas holds whenever a frame moves.
  assert.match(body('moveEnd'), /if \(held\.frame\) \{[^}]*markersDrawn = ''/)
})
