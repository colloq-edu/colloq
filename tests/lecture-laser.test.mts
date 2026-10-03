/**
 * The pointer, measured the way the lecture hall sees it.
 *
 * The owner's words: "the pointer is fine overall, but if you draw a long
 * line it becomes a jagged polyline, then its total length gets capped and it
 * starts to unwind". Each part of that sentence was its own mechanism, and
 * each is checked here with numbers rather than by eye:
 *
 *   — the shape is the presenter's samples, every one of them, laid with one
 *     curve per sample: no stride, no hundred-and-twenty-vertex polygon;
 *   — a held shape never loses its start, however long it is held;
 *   — the hall replays the same samples on a timeline: its head lies on the
 *     presenter's line, also through a Wi-Fi burst, and the shape ends where
 *     the pen left the glass;
 *   — a standing pointer with a trembling hand does not cost the room frames.
 *
 * Pure logic from web/src/components/lecture/laser.ts and ink.ts; what the ink
 * layer does with it is read off its source at the end.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LASER_EVERY_MS, MAX_LASER_SAMPLES } from '../shared/lecture.js'
import { layCurve } from '../web/src/components/lecture/ink.js'
import {
  hearLaser,
  laserArrived,
  LaserPlayback,
  LaserPress,
  LASER_DELAY_MS,
  MARK_MAX_SAMPLES,
  type LaserAt,
} from '../web/src/components/lecture/laser.js'

/** The projector: 1920 × 1080, a 16:9 slide. */
const W = 1920
const H = 1080
const ASPECT = H / W

/** A circle on the slide, `loops` per second, sampled like a Pencil. */
function circle(seconds: number, hz = 240, loops = 1.5): { x: number; y: number; t: number }[] {
  const out: { x: number; y: number; t: number }[] = []
  const r = 300
  for (let i = 0; i <= seconds * hz; i += 1) {
    const t = (i * 1000) / hz
    const a = (t / 1000) * loops * Math.PI * 2
    out.push({ x: (W / 2 + r * Math.cos(a)) / W, y: (H / 2 + r * Math.sin(a)) / H, t })
  }
  return out
}

/** What the presenter's console keeps and what it sends, frame by frame. */
function present(raw: { x: number; y: number; t: number }[]) {
  const press = new LaserPress(1, 0)
  const kept: number[] = []
  const frames: { at: number; pts: number[] }[] = []
  let nextSend = LASER_EVERY_MS
  for (const sample of raw) {
    while (sample.t >= nextSend) {
      for (const pts of press.take(false)) frames.push({ at: nextSend, pts })
      nextSend += LASER_EVERY_MS
    }
    const k = press.add(sample.x, sample.y, sample.t, ASPECT)
    if (k) kept.push(k.x, k.y, k.t)
  }
  const end = raw[raw.length - 1].t
  for (const pts of press.take(true)) frames.push({ at: end, pts })
  return { kept, frames }
}

/** Distance in projector px from a point to the polyline through samples. */
function offLine(x: number, y: number, xy: number[]): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i + 3 < xy.length; i += 2) {
    const ax = xy[i] * W
    const ay = xy[i + 1] * H
    const bx = xy[i + 2] * W
    const by = xy[i + 3] * H
    const dx = bx - ax
    const dy = by - ay
    const len = dx * dx + dy * dy
    const along = ((x * W - ax) * dx + (y * H - ay) * dy) / len
    const k = len === 0 ? 0 : Math.max(0, Math.min(1, along))
    best = Math.min(best, Math.hypot(ax + k * dx - x * W, ay + k * dy - y * H))
  }
  return best
}

/** The hall: frames arrive with network delays, the playhead advances at 60 Hz. */
function hall(
  frames: { at: number; pts: number[] }[],
  delay: (index: number) => number,
  release: number | null,
) {
  // One socket keeps the order: a frame never overtakes the one before it.
  let previous = Number.NEGATIVE_INFINITY
  const arrivals = frames.map((frame, index) => {
    previous = Math.max(previous, frame.at + delay(index))
    return { ...frame, arrive: previous }
  })
  const play = new LaserPlayback(1, 1, 'line')
  const heads: { x: number; y: number; t: number }[] = []
  let next = 0
  const until = Math.max(...arrivals.map((frame) => frame.arrive)) + 1500
  let ended = false
  for (let now = arrivals[0].arrive; now <= until; now += 1000 / 60) {
    while (next < arrivals.length && arrivals[next].arrive <= now) {
      play.hear(arrivals[next].pts, arrivals[next].arrive)
      next += 1
    }
    if (release !== null && !ended && now >= release) {
      play.end(now)
      ended = true
    }
    play.advance(now)
    const head = play.head()
    if (head) heads.push({ ...head, t: now })
    if (play.done) break
  }
  return { play, heads }
}

/* ---------------------------------------------------------- the shape */

test('a twelve-second circle keeps every sample, from the very first, and sends all of them', () => {
  const raw = circle(12)
  const { kept, frames } = present(raw)
  // A Pencil at 240 Hz moving fast: every sample is a step worth keeping.
  assert.ok(
    kept.length / 3 > raw.length * 0.95,
    `only ${kept.length / 3} of ${raw.length} samples were kept`,
  )
  // The start of the shape is the start of the gesture: nothing is unwound.
  assert.ok(Math.abs(kept[0] - raw[0].x) < 1e-4 && Math.abs(kept[1] - raw[0].y) < 1e-4)
  assert.ok(
    kept.length / 3 < MARK_MAX_SAMPLES,
    'the safety net would already fire on an ordinary circle',
  )
  // Everything that was kept went to the room, in order, in frames of bounded size.
  const sent = frames.flatMap((frame) => frame.pts)
  assert.deepEqual(sent, kept, 'the room got a different shape than the console draws')
  assert.ok(frames.every((frame) => frame.pts.length <= MAX_LASER_SAMPLES * 3))
})

test('the line is laid one curve per sample: no stride, no polygon of a hundred and twenty corners', () => {
  const { kept } = present(circle(10, 240, 0.6))
  const xy: number[] = []
  for (let i = 0; i < kept.length; i += 3) xy.push(kept[i], kept[i + 1])
  const count = xy.length / 2
  const curves: [number, number][] = []
  const sink = {
    moveTo() {},
    lineTo() {},
    quadraticCurveTo(cx: number, cy: number) {
      curves.push([cx, cy])
    },
  }
  // Laid piece by piece, as the samples come, the way the ink layer extends a shape.
  let laid = 0
  for (let n = 1; n <= count; n += 37) laid = layCurve(sink, xy, n, laid, W, H)
  laid = layCurve(sink, xy, count, laid, W, H)
  assert.equal(curves.length, count - 2, 'the path does not have a curve for every sample')
  // The control points ARE the samples: no refinement, no thinning.
  for (let i = 0; i < curves.length; i += 97) {
    assert.ok(Math.abs(curves[i][0] - xy[(i + 1) * 2] * W) < 1e-6)
  }
  // The longest straight piece between samples is a few pixels, not 96.
  let longest = 0
  for (let i = 2; i < xy.length; i += 2) {
    longest = Math.max(longest, Math.hypot((xy[i] - xy[i - 2]) * W, (xy[i + 1] - xy[i - 1]) * H))
  }
  assert.ok(longest < 8, `a chord of ${longest.toFixed(1)} px between samples`)
})

/* ----------------------------------------------------------- the hall */

test('the hall draws the presenter’s own circle: the head stays on the line, the shape closes', () => {
  const raw = circle(3)
  const { kept, frames } = present(raw)
  // A believable network: 30 ms, plus up to 25 ms of jitter.
  const jitter = (i: number) => 30 + ((i * 7919) % 25)
  const { play, heads } = hall(frames, jitter, raw[raw.length - 1].t + 60)
  const xy = play.xy
  const worst = Math.max(...heads.map((head) => offLine(head.x, head.y, xy)))
  assert.ok(worst < 1, `the hall's head left the presenter's line by ${worst.toFixed(1)} px`)
  // Every sample is drawn in the end, the last one where the pen was lifted.
  assert.equal(play.shown, kept.length / 3, 'the end of the shape never reached the hall')
  assert.ok(play.done)
  const last = heads[heads.length - 1]
  assert.ok(Math.abs(last.x - kept[kept.length - 3]) < 1e-9)
  assert.ok(Math.abs(last.y - kept[kept.length - 2]) < 1e-9)
  // And it follows: between frames the head moves every 60 Hz frame, not in fifteen steps a second.
  const moving = heads.slice(10, -10)
  const stalls = moving.filter(
    (head, i) => i > 0 && head.x === moving[i - 1].x && head.y === moving[i - 1].y,
  )
  assert.ok(
    stalls.length <= moving.length * 0.05,
    `${stalls.length} of ${moving.length} frames the head stood still`,
  )
})

test('a Wi-Fi burst is replayed along the path, not across it, and the playhead catches up', () => {
  const raw = circle(3)
  const { frames } = present(raw)
  // Frame 20 is held for a quarter of a second, and the next ones queue
  // behind it: they arrive back to back.
  const stall = (i: number) => (i === 20 ? 280 : 30)
  const { play, heads } = hall(frames, stall, raw[raw.length - 1].t + 60)
  const worst = Math.max(...heads.map((head) => offLine(head.x, head.y, play.xy)))
  assert.ok(worst < 1, `the head cut ${worst.toFixed(1)} px across the circle`)
  // Per frame the head never jumps more than three times the hand's own pace.
  const speed = (2 * Math.PI * 300 * 1.5) / 60
  let jump = 0
  for (let i = 1; i < heads.length; i += 1) {
    const step = Math.hypot((heads[i].x - heads[i - 1].x) * W, (heads[i].y - heads[i - 1].y) * H)
    jump = Math.max(jump, step)
  }
  assert.ok(
    jump <= speed * 3.2,
    `a jump of ${jump.toFixed(0)} px in one frame (the hand moves ${speed.toFixed(0)})`,
  )
  assert.ok(play.done, 'after the burst the playback never caught up with the release')
})

test('after the hand rests, the next movement is not replayed late or fast', () => {
  // Half a second of movement, two seconds of rest (nothing worth a sample), half a second more.
  const raw: { x: number; y: number; t: number }[] = []
  for (let t = 0; t <= 500; t += 4) raw.push({ x: 0.2 + t / 5000, y: 0.5, t })
  for (let t = 2500; t <= 3000; t += 4) raw.push({ x: 0.3 + (t - 2500) / 5000, y: 0.5, t })
  const { frames } = present(raw)
  const { heads } = hall(frames, () => 30, 3060)
  // The presenter moved off the resting point at 2500 ms; the hall should
  // follow a delay later, not after crawling through the two seconds of rest.
  const resumed = heads.find((head) => head.t > 600 && head.x > 0.3 + 0.02)
  assert.ok(resumed, 'the hall never moved again')
  const lag = resumed.t - (2500 + 0.02 * 5000)
  assert.ok(
    lag <= LASER_DELAY_MS + 60,
    `the movement after the rest reached the hall ${lag.toFixed(0)} ms late`,
  )
})

test('the first sample shows at once; the movement follows a little behind the presenter', () => {
  const play = new LaserPlayback(5, 1, 'dot')
  play.hear([0.5, 0.5, 0], 1000)
  assert.deepEqual(play.head(), { x: 0.5, y: 0.5 }, 'the dot appeared only after the delay')
  play.hear([0.6, 0.5, 40], 1040)
  play.advance(1040 + LASER_DELAY_MS / 2)
  assert.ok((play.head()?.x ?? 0) < 0.6, 'the head ran ahead of the jitter margin')
  play.advance(1040 + LASER_DELAY_MS + 50)
  assert.deepEqual(play.head(), { x: 0.6, y: 0.5 })
})

test('a stale or repeated sample does not move the timeline backwards', () => {
  const play = new LaserPlayback(5, 1, 'line')
  play.hear([0.1, 0.1, 0, 0.2, 0.2, 10], 0)
  play.hear([0.2, 0.2, 10, 0.15, 0.15, 5, 0.3, 0.3, 20], 15)
  assert.deepEqual(play.ts, [0, 10, 20])
})

/* -------------------------------------------------------- the sender */

test('a standing pointer with a trembling hand does not cost the room a frame per tick', () => {
  const press = new LaserPress(9, 0)
  press.add(0.5, 0.5, 0, ASPECT)
  assert.equal(press.take(true).length, 1, 'the press itself did not go out at once')
  let frames = 0
  for (let t = 1; t < 2000; t += 4) {
    const wobble = 0.0012 * Math.sin(t / 7)
    press.add(0.5 + wobble, 0.5 - wobble, t, ASPECT)
    if (t % LASER_EVERY_MS < 4) frames += press.take(false).length
  }
  assert.equal(frames, 0, 'tremor went out to five hundred sockets')
  // Nothing is lost: the release flushes what stood in the queue.
  assert.ok(press.take(true).length >= 1)
})

test('a press continued under a new number starts from the head', () => {
  const press = new LaserPress(1, 0)
  press.add(0.1, 0.1, 0, ASPECT)
  press.add(0.2, 0.2, 10, ASPECT)
  press.take(true)
  press.roll(2)
  assert.equal(press.mark, 2)
  const [frame] = press.take(true)
  assert.deepEqual(frame.slice(0, 2), [press.last?.x, press.last?.y])
})

test('every pointer frame reaches every listener, in order, and unsubscribing stops it', () => {
  const session = {}
  const heard: (LaserAt | null)[] = []
  const stop = hearLaser(session, (at) => heard.push(at))
  const a: LaserAt = { page: 1, x: 0.1, y: 0.1, shape: 'line', mark: 1, pts: [0.1, 0.1, 0] }
  const b: LaserAt = { page: 1, x: 0.2, y: 0.2, shape: 'line', mark: 1, pts: [0.2, 0.2, 40] }
  laserArrived(session, a)
  laserArrived(session, b)
  laserArrived(session, null)
  stop()
  laserArrived(session, a)
  assert.deepEqual(heard, [a, b, null])
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

test('the ink layer neither thins the shape by a stride nor cuts its start', () => {
  const ink = code('web/src/components/lecture/InkLayer.svelte')
  assert.doesNotMatch(ink, /stride/, 'the shape is thinned by a stride again')
  assert.doesNotMatch(ink, /TRAIL_MAX|dots\.slice\(-/, 'the shape is cut to a count again')
  assert.match(
    ink,
    /layCurve\(trail\.body, mark\.xy/,
    'the pointer builds its own geometry instead of the ink curve',
  )
  assert.match(ink, /MARK_MAX_SAMPLES/, 'the safety net for a very long press is gone')
})

test('the release sends the end of the shape before "off", and own echoes are told by the press number', () => {
  const ink = code('web/src/components/lecture/InkLayer.svelte')
  const off = ink.slice(ink.indexOf('function beamOff('))
  const flush = off.indexOf('beamNow(true)')
  const said = off.indexOf("t: 'laser:off'")
  assert.ok(
    flush !== -1 && said !== -1 && flush < said,
    'the queued samples are dropped or sent after "off"',
  )
  assert.match(
    ink,
    /ownMarks\.includes\(at\.mark\)/,
    'the echo of our own pointer is replayed as someone else’s',
  )
})
