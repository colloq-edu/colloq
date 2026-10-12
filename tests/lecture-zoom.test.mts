/**
 * The zoom's arithmetic and its motion (web/src/components/lecture/zoom.ts),
 * the one module the page, the ink and the console share so that the picture
 * and the ink move as one:
 *
 *  • the frame and the page convert into each other both ways, and a zoom
 *    about a point keeps that point where it was;
 *  • a pan, a frame drawn with the magnifier and its tap stay on the page and
 *    never go past `ZOOM_MAX`;
 *  • the CSS transform moves a bitmap painted at one zoom exactly onto
 *    another, and leaves a resting bitmap alone (a sub-pixel transform blurs
 *    the sharp picture);
 *  • the motion: a jump is there at once, an ease takes `EASE_MS` and lands
 *    EXACTLY on its target, a glide arrives, and the bitmaps are redrawn only
 *    `SETTLE_MS` after the view has rested.
 *
 * Pure logic, no DOM: called directly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readZoom, ZOOM_MAX, type LectureZoom } from '../shared/lecture.js'
import {
  boxToPage,
  EASE_MS,
  pageToBox,
  panZoom,
  sameRegion,
  SETTLE_MS,
  visibleRect,
  zoomAround,
  zoomCss,
  ZoomMotion,
  zoomStep,
  zoomToRect,
} from '../web/src/components/lecture/zoom.js'

const close = (a: number, b: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`)

/** Where a point of the element (fractions of its box) lands under `css`, origin at the corner. */
function through(css: string, u: number, v: number): { u: number; v: number } {
  if (css === '') return { u, v }
  const match = /^translate\((-?[\d.]+)%, (-?[\d.]+)%\) scale\((-?[\d.]+)\)$/.exec(css)
  assert.ok(match, `a transform this test cannot read: "${css}"`)
  const [tx, ty, s] = [Number(match[1]) / 100, Number(match[2]) / 100, Number(match[3])]
  return { u: tx + s * u, v: ty + s * v }
}

/* --------------------------------------------------------- the frame */

test('the frame and the page convert into each other, and the whole page is the frame', () => {
  const zoom: LectureZoom = { x: 0.25, y: 0.5, z: 2 }
  for (const [u, v] of [
    [0, 0],
    [1, 1],
    [0.3, 0.7],
  ]) {
    const page = boxToPage(zoom, u, v)
    const back = pageToBox(zoom, page.x, page.y)
    close(back.u, u)
    close(back.v, v)
  }
  assert.deepEqual(boxToPage(null, 0.4, 0.6), { x: 0.4, y: 0.6 })
  assert.deepEqual(visibleRect(zoom), { x: 0.25, y: 0.5, w: 0.5, h: 0.5 })
  assert.deepEqual(visibleRect(null), { x: 0, y: 0, w: 1, h: 1 })
})

test('a zoom about a point keeps the point under the fingers', () => {
  // The page point under the frame point (0.3, 0.6) at ×1.5 stays under it at ×3.
  const from: LectureZoom = { x: 0.1, y: 0.2, z: 1.5 }
  const before = boxToPage(from, 0.3, 0.6)
  const after = zoomAround(from, 0.3, 0.6, 3)
  assert.ok(after)
  const place = pageToBox(after, before.x, before.y)
  close(place.u, 0.3, 2e-4)
  close(place.v, 0.6, 2e-4)
  assert.equal(after.z, 3)
  // Past the ceiling it stops there; under ×1 it is the whole page.
  assert.equal(zoomAround(null, 0.5, 0.5, 40)?.z, ZOOM_MAX)
  assert.equal(zoomAround(from, 0.5, 0.5, 0.5), null)
})

test('a pan moves the view the way the fingers went, and never off the page', () => {
  const at: LectureZoom = { x: 0.25, y: 0.25, z: 2 }
  // Fingers moved right by a tenth of the frame: what was a tenth to the left comes in.
  const moved = panZoom(at, 0.1, 0)
  assert.ok(moved)
  close(moved.x, 0.25 - 0.1 / 2)
  close(moved.y, 0.25)
  // A long drag stops at the page's edge.
  assert.deepEqual(panZoom(at, 5, 5), { x: 0, y: 0, z: 2 })
  assert.deepEqual(panZoom(at, -5, -5), { x: 0.5, y: 0.5, z: 2 })
  // The whole page has nothing to pan.
  assert.equal(panZoom(null, 0.2, 0.2), null)
})

test('the magnifier: a frame fills the sheet centred, a tap comes twice as close', () => {
  // A frame a quarter of the page wide and an eighth high: its longer side fills.
  const framed = zoomToRect({ x: 0.5, y: 0.25, w: 0.25, h: 0.125 })
  assert.ok(framed)
  assert.equal(framed.z, 4)
  close(framed.x + 0.5 / framed.z, 0.625, 1e-4)
  close(framed.y + 0.5 / framed.z, 0.3125, 1e-4)
  // Dragged up and to the left, the same frame.
  assert.deepEqual(zoomToRect({ x: 0.75, y: 0.375, w: -0.25, h: -0.125 }), framed)
  // A frame bigger than the page is the whole page; a dot is the closest zoom.
  assert.equal(zoomToRect({ x: 0, y: 0, w: 1, h: 1 }), null)
  assert.equal(zoomToRect({ x: 0.5, y: 0.5, w: 0, h: 0 })?.z, ZOOM_MAX)
  // The tap: ×2 around the point, then ×4, and no further.
  const twice = zoomStep(null, 0.5, 0.5)
  assert.deepEqual(twice, { x: 0.25, y: 0.25, z: 2 })
  assert.equal(zoomStep(twice, 0.5, 0.5)?.z, 4)
  assert.equal(zoomStep({ x: 0, y: 0, z: 4 }, 0.1, 0.1)?.z, 4)
  // At a corner the view stays on the page.
  const corner = zoomStep(null, 0.99, 0.99)
  assert.ok(corner)
  assert.ok(corner.x + 1 / corner.z <= 1 + 1e-4 && corner.y + 1 / corner.z <= 1 + 1e-4)
})

test('every operation hands out a zoom as the wire reads it', () => {
  // The console compares its own echo with what it sent (sameZoom): what it
  // sends must already be the value the server will store.
  const values = [
    zoomAround({ x: 0.1234567, y: 0.7654321, z: 1.3333333 }, 0.37, 0.61, 2.71828),
    panZoom({ x: 0.3, y: 0.3, z: 2.5 }, 0.0123456, -0.0654321),
    zoomToRect({ x: 0.111111, y: 0.222222, w: 0.333333, h: 0.1 }),
    zoomStep({ x: 0.2, y: 0.2, z: 1.7 }, 0.987654, 0.012345),
  ]
  for (const value of values) {
    assert.ok(value)
    assert.deepEqual(readZoom(value), value, `${JSON.stringify(value)} reads differently on the wire`)
  }
})

/* ----------------------------------------------------------- the css */

test('the transform moves a bitmap painted at one zoom exactly onto another', () => {
  const cases: [LectureZoom | null, LectureZoom | null][] = [
    [null, { x: 0.25, y: 0.25, z: 2 }],
    [{ x: 0.25, y: 0.25, z: 2 }, null],
    [{ x: 0.1, y: 0.5, z: 2 }, { x: 0.4, y: 0.2, z: 3.5 }],
  ]
  for (const [painted, shown] of cases) {
    const css = zoomCss(painted, shown)
    assert.notEqual(css, '')
    // A page point drawn on the bitmap at `painted` must appear where `shown` puts it.
    for (const [x, y] of [
      [0.3, 0.4],
      [0.5, 0.5],
      [0.6, 0.3],
    ]) {
      const drawn = pageToBox(painted, x, y)
      const seen = through(css, drawn.u, drawn.v)
      const wanted = pageToBox(shown, x, y)
      close(seen.u, wanted.u, 1e-5)
      close(seen.v, wanted.v, 1e-5)
    }
  }
})

test('a resting bitmap carries no transform, however its zoom differs in the last digits', () => {
  assert.equal(zoomCss(null, null), '')
  const zoom: LectureZoom = { x: 0.25, y: 0.25, z: 2 }
  assert.equal(zoomCss(zoom, { ...zoom }), '')
  // A hair: less than any screen shows as a region, but a sub-pixel translate
  // would resample, and blur, the whole sharp picture.
  assert.equal(zoomCss(zoom, { x: 0.25003, y: 0.24996, z: 2.00004 }), '')
  assert.ok(sameRegion(zoom, { x: 0.25003, y: 0.24996, z: 2.00004 }))
  // A few rounding steps of the wire are a real move.
  assert.notEqual(zoomCss(zoom, { x: 0.2503, y: 0.25, z: 2 }), '')
})

/* -------------------------------------------------------- the motion */

/** Run a motion to `until` in frames of `every` ms; returns when it stopped asking. */
function play(motion: ZoomMotion, from: number, until: number, every = 16): number {
  let now = from
  while (now < until) {
    now += every
    motion.step(now)
    if (!motion.busy) break
  }
  return now
}

test('a jump is shown at once and drawn sharp only once the hand has rested', () => {
  const motion = new ZoomMotion(null)
  const target: LectureZoom = { x: 0.5, y: 0.5, z: 2 }
  motion.aim(target, 0, 'jump')
  assert.equal(motion.shown, motion.target)
  assert.ok(sameRegion(motion.shown, target))
  assert.equal(motion.moving, false)
  assert.equal(motion.painted, null)
  assert.notEqual(motion.view().css, '')
  assert.deepEqual(motion.step(SETTLE_MS - 1), { shown: false, painted: false })
  assert.deepEqual(motion.step(SETTLE_MS), { shown: false, painted: true })
  assert.equal(motion.painted, motion.shown)
  assert.equal(motion.view().css, '')
  assert.equal(motion.busy, false)
})

test('an ease takes its quarter second and lands exactly on the target', () => {
  // Pans and zooms, at frame lengths that do and do not divide EASE_MS: the
  // last stretch of an ease is within a hair of the target, and a motion
  // that counted that as arrival rested there for good.
  const ends: [LectureZoom | null, LectureZoom | null][] = [
    [{ x: 0.5, y: 0, z: 2 }, { x: 0.25, y: 0.25, z: 2 }],
    [null, { x: 0.6, y: 0.1, z: 4 }],
    [{ x: 0.6, y: 0.1, z: 4 }, null],
    [{ x: 0.1, y: 0.2, z: 1.5 }, { x: 0.3, y: 0.1, z: 2.75 }],
  ]
  for (const [from, to] of ends) {
    for (const frame of [16, 16.7, 7, 33]) {
      const motion = new ZoomMotion(from)
      motion.aim(to, 0, 'ease')
      motion.step(frame)
      assert.equal(motion.moving, true, 'an ease arrived in its first frame')
      play(motion, frame, 5000, frame)
      assert.equal(motion.shown, motion.target, `frames of ${frame} ms stopped short of ${JSON.stringify(to)}`)
      assert.equal(motion.painted, motion.shown)
      assert.equal(motion.view().css, '')
      assert.equal(motion.busy, false)
    }
  }
  // And on time: the view is there at EASE_MS, not after a creeping tail.
  const motion = new ZoomMotion(null)
  motion.aim({ x: 0.25, y: 0.25, z: 2 }, 1000, 'ease')
  motion.step(1000 + EASE_MS / 2)
  assert.equal(motion.moving, true)
  motion.step(1000 + EASE_MS)
  assert.equal(motion.moving, false)
  assert.equal(motion.shown, motion.target)
})

test('an ease passes the halfway magnification halfway, as the eye expects', () => {
  // Interpolated in log scale: from ×1 to ×4 the view is near ×2 at the
  // point where the eased fraction reaches one half.
  const motion = new ZoomMotion(null)
  motion.aim({ x: 0.375, y: 0.375, z: 4 }, 0, 'ease')
  // 1 - (1 - t)^3 = 0.5 at t = 1 - 0.5^(1/3).
  motion.step(EASE_MS * (1 - Math.cbrt(0.5)))
  close(motion.shown?.z ?? 1, 2, 1e-3)
})

test('a glide chases a moving target and arrives exactly', () => {
  const motion = new ZoomMotion(null)
  let now = 0
  for (let k = 1; k <= 5; k += 1) {
    motion.aim({ x: 0.05 * k, y: 0.05 * k, z: 1 + k * 0.3 }, now, 'glide')
    now += 40
    motion.step(now - 24)
    motion.step(now)
    assert.equal(motion.moving, true, 'a glide jumped onto each target of the stream')
  }
  play(motion, now, now + 5000)
  assert.equal(motion.shown, motion.target)
  assert.equal(motion.painted, motion.shown)
})

test('a glide ends as gently at ×4 as at ×1.5: arrival is measured in the frame, not on the page', () => {
  /*
   * The hall follows a pan or a pinch that has just stopped. Arrival used to
   * be a five-hundredth of the PAGE, which is four times as many pixels at
   * ×4: the projector settled through steps of 13, 9.5 and 6.9 px and then
   * jumped 18 px in the last frame, a click at the end of every motion.
   * Here the last frame is measured as the picture moves on the glass, in
   * fractions of the frame: under 0.4 % (8 px of a 1920-px sheet) at any zoom.
   */
  /** How far any point of the frame moved between two views, in frames. */
  const moved = (from: LectureZoom | null, to: LectureZoom | null): number => {
    let most = 0
    for (const [u, v] of [
      [0, 0],
      [1, 1],
    ]) {
      const page = boxToPage(from, u, v)
      const now = pageToBox(to, page.x, page.y)
      most = Math.max(most, Math.abs(now.u - u), Math.abs(now.v - v))
    }
    return most
  }
  for (const z of [1.5, 2, 3, 3.8]) {
    for (const kind of ['pan', 'pinch'] as const) {
      const motion = new ZoomMotion({ x: 0.05, y: 0.05, z })
      let now = 0
      // The stream of a two-finger gesture at the pointer's tick, then nothing.
      for (let k = 1; k <= 4; k += 1) {
        const next =
          kind === 'pan'
            ? { x: 0.05 + 0.0125 * k, y: 0.05, z }
            : { x: 0.05, y: 0.05, z: Math.min(ZOOM_MAX, z * (1 + 0.04 * k)) }
        motion.aim(next, now, 'glide')
        now += 40
      }
      const steps: number[] = []
      while (motion.moving && steps.length < 200) {
        const before = motion.shown
        now += 16
        motion.step(now)
        steps.push(moved(before, motion.shown))
      }
      assert.equal(motion.shown, motion.target, `×${z} ${kind}: the glide never arrived`)
      const last = steps[steps.length - 1]
      assert.ok(last < 0.004, `×${z} ${kind}: the last frame jumped ${(last * 1920).toFixed(1)} px of 1920`)
    }
  }
})

test('a target a hair away from the view is landed on, and changes no picture', () => {
  const zoom: LectureZoom = { x: 0.25, y: 0.25, z: 2 }
  const motion = new ZoomMotion(zoom)
  const hair: LectureZoom = { x: 0.25003, y: 0.25, z: 2 }
  motion.aim(hair, 0, 'ease')
  motion.step(16)
  assert.equal(motion.shown, motion.target, 'the view rested a hair off its target')
  assert.equal(motion.view().css, '', 'a hair became a sub-pixel transform')
  assert.equal(motion.busy, false)
})

test('a reset is the whole thing at once, bitmaps included', () => {
  const motion = new ZoomMotion({ x: 0.5, y: 0.5, z: 2 })
  motion.aim({ x: 0, y: 0, z: 4 }, 0, 'ease')
  motion.step(100)
  motion.reset(null)
  assert.equal(motion.shown, null)
  assert.equal(motion.painted, null)
  assert.equal(motion.target, null)
  assert.equal(motion.busy, false)
  assert.equal(motion.view().css, '')
})
