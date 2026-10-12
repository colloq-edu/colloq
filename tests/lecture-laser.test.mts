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
 *   — a standing pointer with a trembling hand does not cost the room frames;
 *   — and the owner's later words, "if I keep writing with the pointer the
 *     strokes must not disappear, and when I stop, let it go": strokes written
 *     in a row are one phrase, lit together and put out together, grouped
 *     the same way in the hall, which holds a phrase through the network's
 *     jitter and never flashes a fading one back;
 *   — a finger's beam reaches the room only once it is not the first finger
 *     of a two-finger gesture: every pinch used to leave a red squiggle.
 *
 * Pure logic from web/src/components/lecture/laser.ts and ink.ts; what the ink
 * layer does with it is read off its source at the end.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LASER_EVERY_MS, MAX_LASER_SAMPLES } from '../shared/lecture.js'
import { layCurve, TAP_TOGETHER_MS } from '../web/src/components/lecture/ink.js'
import {
  HeardPhrases,
  hearLaser,
  laserArrived,
  LaserPlayback,
  LaserPress,
  LASER_DELAY_MS,
  LASER_STAND,
  LASER_STEP,
  MARK_MAX_SAMPLES,
  MARKS_MAX,
  PHRASE_FADE_MS,
  PHRASE_HOLD_MS,
  PHRASE_WIRE_MS,
  PhraseClock,
  phraseFor,
  phraseGlow,
  phraseOver,
  phrasesOf,
  pressBegan,
  PRESS_HELD_MAX_MS,
  type LaserAt,
  type PhraseMark,
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

test('under a zoom the sender keeps the steps and stands of the screen, not of the page', () => {
  // Steps of half the ×1 threshold: dropped at ×1, kept at ×4 (each is two of the threshold there).
  const whole = new LaserPress(1, 0)
  const near = new LaserPress(2, 0)
  let keptWhole = 0
  let keptNear = 0
  for (let i = 0; i < 20; i += 1) {
    const x = 0.5 + (i * LASER_STEP) / 2
    if (whole.add(x, 0.5, i, ASPECT)) keptWhole += 1
    if (near.add(x, 0.5, i, ASPECT, 4)) keptNear += 1
  }
  assert.ok(keptWhole <= 11, `at ×1 ${keptWhole} of 20 half-steps were kept`)
  assert.equal(keptNear, 20, 'at ×4 a pixel of the screen is a quarter of the page step')
  // A move of half the stand: still standing at ×1, a real move at ×4.
  for (const [press, zoom, frames] of [
    [new LaserPress(3, 0), 1, 0],
    [new LaserPress(4, 0), 4, 1],
  ] as const) {
    press.add(0.5, 0.5, 0, ASPECT, zoom)
    press.take(true, zoom)
    press.add(0.5 + LASER_STAND / 2, 0.5, 40, ASPECT, zoom)
    assert.equal(press.take(false, zoom).length, frames, `at ×${zoom}`)
  }
})

/* ---------------------------------------------------------- phrases */

/** A phrase clock with readable ids. */
function clock(): PhraseClock {
  let next = 0
  return new PhraseClock(() => (next += 1))
}

test('strokes written in a row are one phrase; a pause of the hold starts a new one', () => {
  const phrases = clock()
  // A word: presses 200–600 ms apart.
  const word: number[] = []
  let t = 0
  for (let i = 0; i < 12; i += 1) {
    word.push(phrases.press(t))
    t += 150
    phrases.lift(t)
    t += 200 + ((i * 97) % 400)
  }
  assert.equal(new Set(word).size, 1, 'a written word was split into phrases')
  // A press while another of the phrase is held joins it too (the pen takes the beam from a finger).
  const held = phrases.press(t)
  assert.equal(phrases.press(t + 5000), held, 'a press during a held one started a new phrase')
  phrases.lift(t + 5100)
  phrases.lift(t + 5100)
  // Just under the hold after the last lift: the same phrase; at the hold: a new one.
  assert.equal(phrases.press(t + 5100 + PHRASE_HOLD_MS - 1), held)
  phrases.lift(t + 7000)
  const after = phrases.press(t + 7000 + PHRASE_HOLD_MS)
  assert.notEqual(after, held, 'a press after the phrase began to fade revived it')
})

test('a phrase stays whole until its last lift and the hold, then fades together', () => {
  // Three strokes lifted at 0, 400 and 900 ms.
  const marks: PhraseMark[] = [
    { phrase: 1, letGo: 0 },
    { phrase: 1, letGo: 400 },
    { phrase: 1, letGo: 900 },
  ]
  const state = phrasesOf(marks).get(1)
  const last = 900
  // The first stroke has long passed the old per-shape 0.9 + 0.9 s; it still glows whole.
  assert.equal(phraseGlow(state, 1900), 1, 'the first letter faded while the word was still held')
  assert.equal(phraseGlow(state, last + PHRASE_HOLD_MS), 1)
  assert.ok(Math.abs(phraseGlow(state, last + PHRASE_HOLD_MS + PHRASE_FADE_MS / 2) - 0.5) < 1e-9)
  assert.equal(phraseGlow(state, last + PHRASE_HOLD_MS + PHRASE_FADE_MS), 0)
  assert.ok(!phraseOver(state, last + PHRASE_HOLD_MS + PHRASE_FADE_MS - 1))
  assert.ok(phraseOver(state, last + PHRASE_HOLD_MS + PHRASE_FADE_MS))
  // While any stroke of it is held, the phrase holds, however old the others are.
  const writing = phrasesOf([...marks, { phrase: 1, letGo: null }]).get(1)
  assert.equal(phraseGlow(writing, 60_000), 1)
  assert.ok(!phraseOver(writing, 60_000))
  // Hold and fade are the stand's numbers: a word stays a second and a half, then goes in 0.6 s.
  assert.equal(PHRASE_HOLD_MS, 1500)
  assert.equal(PHRASE_FADE_MS, 600)
})

test('a new phrase does not revive the one that is fading', () => {
  const marks: PhraseMark[] = [
    { phrase: 1, letGo: 0 },
    { phrase: 2, letGo: null },
  ]
  const fading = phrasesOf(marks).get(1)
  const at = PHRASE_HOLD_MS + PHRASE_FADE_MS / 3
  assert.ok(phraseGlow(fading, at) < 1, 'the old phrase stopped fading when a new one began')
  assert.equal(phraseGlow(phrasesOf(marks).get(2), at), 1)
})

test('the hall groups by the phrase the console names, not by gaps the network stretched', () => {
  // The console: a lift at 0, the next press at 1450 ms. One phrase.
  const phrases = clock()
  const first = phrases.press(-300)
  phrases.lift(0)
  assert.equal(phrases.press(1450), first)
  // The hall: the release is back-dated to the presenter's lift, but the next
  // press arrives with the network's jitter on top, 120 ms later than sent.
  const hall: PhraseMark[] = [{ phrase: first, letGo: 0 }]
  assert.equal(
    phraseFor(hall, 1450 + 120),
    null,
    'without the phrase on the wire the hall would split this word',
  )
  // Which is why the frames carry it: the ink layer hands `at.trail` to its grouping, and holds it the wire's grace.
  const ink = code('web/src/components/lecture/InkLayer.svelte')
  assert.match(
    ink,
    /const grace = at\.trail === undefined \? 0 : PHRASE_WIRE_MS[^]*?newMark\(mark, at\.page, stream\.xy, phraseHere\(at\.page, at\.trail, began\), grace\)/,
    'the hall ignores the phrase the console sent',
  )
  assert.match(ink, /heard\.join\(/)
  const now = ink.slice(ink.indexOf('function beamNow('))
  assert.match(now.slice(0, now.indexOf('\n  function ')), /trail: pressTrail/, 'pointer frames do not carry the phrase')
})

test('the hall holds a phrase the console named through the network’s jitter, and still ends with the console', () => {
  // The review's case: the console lifts at 0 and joins the next press at 1450 ms.
  const lift = 0
  const named: PhraseMark[] = [{ phrase: 5, letGo: lift, grace: PHRASE_WIRE_MS }]
  const state = phrasesOf(named).get(5)
  // The press arriving 300 ms late, at 1750: the hall had begun to fade the word, now it is still whole.
  assert.equal(phraseGlow(state, 1450 + 300), 1, 'a late joining press finds its word half faded')
  const hold = lift + PHRASE_HOLD_MS + PHRASE_WIRE_MS
  assert.equal(phraseGlow(state, hold), 1)
  // The grace comes out of the fade: the word goes out on the projector when it does on the console.
  const end = lift + PHRASE_HOLD_MS + PHRASE_FADE_MS
  assert.ok(Math.abs(phraseGlow(state, (hold + end) / 2) - 0.5) < 1e-9)
  assert.ok(!phraseOver(state, end - 1))
  assert.ok(phraseOver(state, end), 'the projector outlives the console')
  const own = phrasesOf([{ phrase: 6, letGo: lift }]).get(6)
  assert.ok(phraseOver(own, end) && !phraseOver(own, end - 1), 'the console and the hall end apart')
  // A grace is jitter, not a second hold, and the fade stays a fade.
  assert.ok(PHRASE_WIRE_MS >= 150 && PHRASE_WIRE_MS <= PHRASE_FADE_MS / 2, `the hall holds ${PHRASE_WIRE_MS} ms longer`)
  // One's own shapes have none: the console's word fades on the console's clock.
  assert.equal(own?.grace, 0)
  assert.ok(phraseGlow(own, PHRASE_HOLD_MS + 1) < 1)
})

test('a press later than the grace starts its own phrase in the hall: a fading word is never revived', () => {
  let next = 100
  const heard = new HeardPhrases(() => (next += 1))
  const trail = 5
  const marks: PhraseMark[] = [{ phrase: trail, letGo: 0, grace: PHRASE_WIRE_MS }]
  // Within the hold and its grace: the console's phrase, as the console wrote it.
  assert.equal(heard.join(marks, trail, PHRASE_HOLD_MS + PHRASE_WIRE_MS - 1), trail)
  // 400 ms late, at 1850 (the review's case): even with the grace the word has begun to fade here.
  const late = 1450 + 400
  assert.ok(phraseGlow(phrasesOf(marks).get(trail), late) < 1)
  const own = heard.join(marks, trail, late)
  assert.notEqual(own, trail, 'the fading word flashed back to full')
  // The fading one keeps fading, untouched by the newcomer.
  const after = [...marks, { phrase: own, letGo: null, grace: PHRASE_WIRE_MS }]
  assert.ok(phraseGlow(phrasesOf(after).get(trail), late + 100) < 1)
  // The rest of the word follows the press that split off, not the old phrase.
  assert.equal(heard.join([...marks, { phrase: own, letGo: late + 200, grace: PHRASE_WIRE_MS }], trail, late + 600), own)
  // Nothing of the phrase left here: nothing to revive, the trail is the phrase again.
  assert.equal(new HeardPhrases(() => 1).join([], trail, 10_000), trail)
  // An older console names no phrase: the timing rule decides (`phraseFor`).
  assert.equal(heard.join([{ phrase: 9, letGo: 1000 }], undefined, 1000 + PHRASE_HOLD_MS - 1), 9)
  assert.notEqual(heard.join([{ phrase: 9, letGo: 1000 }], undefined, 1000 + PHRASE_HOLD_MS), 9)
})

/*
 * The review's recheck of A17: a finger's beam reaches the wire a quarter of
 * a second after its touch (held back for the two-finger window), and the
 * hall judged the phrase when that first frame arrived. The quarter came out
 * of the grace for the network's jitter: a press the console joined 1.45 s
 * after the lift, with 120 ms of jitter, split the word on the projector, its
 * first letters dark while the console kept them lit.
 */
test('the hall judges a press where it began: a finger’s held beam does not eat the grace for jitter', () => {
  const trail = 77
  // The hall back-dates the lift to the presenter's, at the network's best.
  const best = 30
  const marks: PhraseMark[] = [{ phrase: trail, letGo: best, grace: PHRASE_WIRE_MS }]
  for (const [gap, jitter] of [
    [1450, 120],
    [1490, 60],
    [1350, 200],
    [1200, 280],
  ]) {
    assert.ok(gap < PHRASE_HOLD_MS, 'the console joins this press to the word')
    for (const finger of [false, true]) {
      // A finger standing still through its window: its first frame leaves after the hold, stamped.
      const press = new LaserPress(1, 0)
      press.add(0.5, 0.5, 0, ASPECT)
      if (finger) press.stamp(TAP_TOGETHER_MS)
      const [pts] = press.take(true)
      const arrives = gap + (finger ? TAP_TOGETHER_MS : 0) + best + jitter
      const joined = new HeardPhrases(() => 1000).join(marks, trail, pressBegan(pts, arrives))
      assert.equal(joined, trail, `${finger ? 'a finger' : 'the pen'} ${gap} ms after the lift, ${jitter} ms late: the word split`)
    }
  }
  // Judged on arrival, the same finger press split it: the hold and the jitter passed the grace.
  assert.notEqual(new HeardPhrases(() => 1000).join(marks, trail, 1450 + TAP_TOGETHER_MS + best + 120), trail)
})

test('a held press says how old it is, standing still too, and the hall keeps no vertex for the saying', () => {
  // A finger held still through the window: one sample, then the stamp as the beam goes out.
  const press = new LaserPress(3, 1000)
  press.add(0.4, 0.6, 1000, ASPECT)
  press.stamp(TAP_TOGETHER_MS)
  const [pts] = press.take(true)
  assert.deepEqual(pts, [0.4, 0.6, 0, 0.4, 0.6, TAP_TOGETHER_MS])
  assert.equal(pressBegan(pts, 5000), 5000 - TAP_TOGETHER_MS)
  // A stamp no later than what is queued says nothing; nor one with nothing pressed.
  const moving = new LaserPress(4, 0)
  moving.add(0.1, 0.1, 0, ASPECT)
  moving.add(0.2, 0.2, 240, ASPECT)
  moving.stamp(200)
  assert.deepEqual(moving.take(true), [[0.1, 0.1, 0, 0.2, 0.2, 240]])
  const empty = new LaserPress(5, 0)
  empty.stamp(250)
  assert.deepEqual(empty.take(true), [])
  // The hall holds the console's shape, one vertex on the spot, and the movement after it plays as a pen's.
  const play = new LaserPlayback(3, 1, 'line')
  play.hear(pts, 5000)
  assert.deepEqual(play.xy, [0.4, 0.6], 'the stamp became a vertex of the hall’s shape')
  assert.deepEqual(play.ts, [0])
  play.hear([0.5, 0.6, TAP_TOGETHER_MS + 100], 5100)
  play.advance(5100 + LASER_DELAY_MS + 1)
  assert.deepEqual(play.head(), { x: 0.5, y: 0.6 })
  // Nothing in a frame, or a press older than any hold (one continued under a new number): the hold is all that is undone.
  assert.equal(pressBegan(undefined, 70_000), 70_000)
  assert.equal(pressBegan([], 70_000), 70_000)
  assert.equal(pressBegan([0.1, 0.1, 60_000], 70_000), 70_000 - PRESS_HELD_MAX_MS)
  assert.ok(PRESS_HELD_MAX_MS >= TAP_TOGETHER_MS + LASER_EVERY_MS, `a late hold timer is cut at ${PRESS_HELD_MAX_MS} ms`)
  assert.ok(PRESS_HELD_MAX_MS < PHRASE_HOLD_MS / 2)
})

test('a press taken back as half of a gesture neither holds the phrase nor keeps it open', () => {
  const phrases = clock()
  const word = phrases.press(0)
  phrases.lift(100)
  // A finger lit the beam within the word's hold, and a second finger came: the press never was.
  assert.equal(phrases.press(1_000), word)
  phrases.cancel()
  // It holds the word no longer and left no lift of its own: the word closes on its last real lift.
  assert.notEqual(phrases.press(100 + PHRASE_HOLD_MS), word, 'a cancelled press kept the word open')
  // A cancel with nothing held changes nothing.
  const fresh = clock()
  fresh.cancel()
  const first = fresh.press(0)
  fresh.lift(10)
  fresh.cancel()
  assert.equal(fresh.press(10 + PHRASE_HOLD_MS - 1), first)
})

test('without a phrase on the wire the hall applies the console’s timing rule itself', () => {
  const marks: PhraseMark[] = [{ phrase: 9, letGo: 1000 }]
  assert.equal(phraseFor(marks, 1000 + PHRASE_HOLD_MS - 1), 9)
  assert.equal(phraseFor(marks, 1000 + PHRASE_HOLD_MS), null)
  // A held shape keeps its phrase open, however long it has been held.
  assert.equal(phraseFor([...marks, { phrase: 9, letGo: null }], 99_000), 9)
  // Only the newest shape's phrase is open: an old phrase is not rejoined.
  assert.equal(phraseFor([{ phrase: 3, letGo: null }, { phrase: 4, letGo: 0 }], 99_000), null)
  assert.equal(phraseFor([], 0), null)
})

test('a phrase fits under the ceiling of kept shapes, and burnt shapes give their bitmaps back', () => {
  // A line of handwriting is dozens of presses; the old ceiling of eight popped
  // the first letter off the projector mid-word.
  assert.ok(MARKS_MAX >= 64, `only ${MARKS_MAX} shapes are kept`)
  const ink = code('web/src/components/lecture/InkLayer.svelte')
  assert.doesNotMatch(ink, /const MARKS_MAX = /, 'the ink layer keeps a ceiling of its own again')
  assert.match(ink, /marks\.slice\(-MARKS_MAX\)/)
  // WebKit frees a canvas at once only when it is shrunk to one pixel.
  const unbake = ink.slice(ink.indexOf('function unbake('))
  assert.match(unbake.slice(0, unbake.indexOf('\n  function ')), /canvas\.width = 1/)
  assert.match(ink, /if \(phraseOver\(phrases\.get\(mark\.phrase\), now\)\) unbake\(mark\)/, 'burnt shapes keep their bitmaps')
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

test('a finger’s beam lights on the console at once and reaches the room only once a second finger is ruled out', () => {
  const ink = code('web/src/components/lecture/InkLayer.svelte')
  const fn = (name: string) => {
    const at = ink.indexOf(`function ${name}(`)
    assert.notEqual(at, -1, `${name} is gone from the ink layer`)
    const rest = ink.slice(at + 1)
    const to = rest.search(/\n {2}function /)
    return to === -1 ? rest : rest.slice(0, to)
  }
  // A finger's press is held for the tap's window; a pen's goes out at once.
  assert.match(
    fn('beamStart'),
    /beamHeld = event\.pointerType === 'touch'\s*if \(beamHeld\) beamHeldTimer = window\.setTimeout\(sendBeam, TAP_TOGETHER_MS\)\s*else beamNow\(true\)/,
  )
  assert.match(fn('beamNow'), /if \(!press \|\| beamHeld\) return/, 'a held beam reaches the hall at the touch again')
  // Lifted alone inside the window: a poke, sent whole before the "off".
  const off = fn('beamOff')
  const release = off.indexOf('beamHeld = false')
  assert.ok(release !== -1 && release < off.indexOf('beamNow(true)'), 'a poke never reaches the hall')
  // The second finger or a pen: the beam goes from the console too, and the room hears nothing.
  const drop = fn('dropBeam')
  assert.match(drop, /phraseClock\.cancel\(\)/)
  assert.match(drop, /marks = marks\.filter\(\(mark\) => mark !== gone\)/)
  assert.doesNotMatch(drop, /send\(|beamNow/, 'a dropped beam tells the room')
  // A pen taking a finger's held beam: the finger was the palm.
  assert.match(fn('down'), /if \(beaming !== null\) \{\s*if \(beamHeld\) dropBeam\(\)\s*else beamOff\(\)/)
  // A held beam's first frame says how long it waited, however still the finger stood (a poke too).
  assert.match(fn('beamStart'), /pressedAt = performance\.now\(\)\s*pressTrail = phraseClock\.press\(pressedAt\)/)
  const send = fn('sendBeam')
  const stamp = send.indexOf('press?.stamp(performance.now() - pressedAt)')
  assert.ok(stamp !== -1 && stamp < send.indexOf('beamNow(true)'), 'a held beam goes out without its age')
  assert.match(off, /if \(press && beamHeld\) press\.stamp\(performance\.now\(\) - pressedAt\)\s*beamHeld = false\s*if \(press\) beamNow\(true\)/)
  // The hall judges a named phrase where its press began; an older console's samples are timed by the server's clock.
  assert.match(fn('hearRemote'), /const began = at\.trail === undefined \? now : pressBegan\(at\.pts, now\)/)
})
