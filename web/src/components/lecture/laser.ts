/**
 * The pointer's samples: how they are gathered under the presenter's hand,
 * cut into frames, and played back in the hall.
 *
 * WHAT WAS WRONG. The pointer travelled as "where the hand is now", fifteen
 * times a second, and every screen rebuilt the line itself: the console from
 * a spring chasing its own pen, the hall from a spring chasing those sparse
 * points, both laying one point per animation frame and keeping the last six
 * hundred of them, thinned to a hundred and twenty for drawing. The owner's
 * words from the lecture hall: "if you draw a long line it becomes a jagged
 * polyline, then its total length gets capped and it starts to unwind".
 * Every part of that sentence was a separate mechanism: the stride that thinned
 * the line, the frame-counted cap that ate the start of a shape while the pen
 * was still down, the spring that turned the hall's circle into a rounded
 * fifteen-gon and cut its end off on release.
 *
 * WHAT IT IS NOW, in the manner of a Keynote or GoodNotes laser:
 *  — the shape is the presenter's real samples, as the pen reported them,
 *    so that the console and the hall hold the SAME points. Not filtered:
 *    the pen's input filter lags the tip by a fraction of a step on every
 *    sample and never catches up once the hand stops, and a glowing line
 *    six to fourteen pixels thick hides sensor jitter by itself; the curve
 *    through midpoints does the rest;
 *  — every sample travels, in batches, each with its time (`LaserPress`);
 *  — the hall replays them on a timeline a little behind the presenter, so a
 *    frame that comes late still lands before it is needed, and the head
 *    moves between real samples instead of chasing them (`LaserPlayback`);
 *  — a held shape never shortens; it fades by time, as a whole, after the
 *    pen is lifted — and not alone: shapes written in a row are one PHRASE,
 *    which stays lit while the hand keeps writing and fades together once it
 *    stops (`PHRASE_HOLD_MS`, `PhraseClock`).
 *
 * Pure logic, no canvas and no runes: it is checked in a test without a
 * browser (tests/lecture-laser.test.mts), and the ink layer draws what it
 * returns.
 */
import { LASER_EVERY_MS, MAX_LASER_SAMPLES } from '@shared/lecture'

/**
 * Red. Not in the presenter's colour.
 *
 * A pointer is recognised without thinking: a red dot on a slide means
 * "look here", in every lecture hall in the world that has a laser
 * pointer. The presenter's colour came here from a general habit of
 * colouring everything by author, and a second teacher's pointer turned
 * out blue, that is, indistinguishable from their own ink with which they
 * will underline a line a second later.
 *
 * One value for every place that shows it: the ink layer burns the pointer
 * in it, and the console's key, its palette and the laptop bar's key draw
 * their comet in it, so no key shows a red the hall does not see.
 */
export const LASER_RED = '#ff2b1d'

/** A pointer frame as the room delivers it (protocol `laser.at`). */
export interface LaserAt {
  page: number
  x: number
  y: number
  shape: 'dot' | 'line'
  mark?: number
  /** The phrase the press belongs to (`PhraseClock`); absent from an older console. */
  trail?: number
  pts?: number[]
}

/**
 * The smallest step worth a sample, in page widths: about a pixel on the
 * projector. Closer samples add vertices and nothing the eye can see, and a
 * pen standing still would pile hundreds of them in one spot.
 */
export const LASER_STEP = 0.0006

/**
 * How far the hand must move before the hall is told, in page widths.
 *
 * Most often the pointer STANDS ("right here"), and a tablet reports hand
 * tremor every few milliseconds. Two thousandths of the width is less than
 * the red dot itself even on a 4K projector: such samples are kept and drawn
 * on the console, but they wait in the queue instead of costing the room a
 * frame; the first real movement takes them along, and the release flushes
 * them, so nothing of the shape is lost.
 */
export const LASER_STAND = 0.002

/**
 * How far behind the presenter the hall plays the samples.
 *
 * A sample can wait up to a tick on the console before its frame goes, the
 * server may hold a frame for a window, and the network adds its jitter. Two
 * ticks and a margin cover all three, so the playhead almost never runs out
 * of samples; it is about what the old spring cost in lag anyway, and in
 * exchange the hall draws the real curve.
 */
export const LASER_DELAY_MS = LASER_EVERY_MS * 2 + 20

/**
 * The ceiling of samples in one shape: a safety net, not a design.
 *
 * Twenty thousand samples is well over a minute of continuous circling with a
 * Pencil; nobody holds the pointer down that long. If somebody does, the shape
 * is never shortened from its start (that was the "unwinding"): it is let go
 * whole, to hold and fade like any released shape, and a new one continues
 * from the head without a break.
 */
export const MARK_MAX_SAMPLES = 20_000

/**
 * A gap between two samples longer than this is a PAUSE: the hand stood
 * still and nothing was worth sending. At 240 Hz a moving pen gives a kept
 * sample every few milliseconds; eighty without one is a hand at rest.
 *
 * A pause is not replayed second by second. A playhead that is behind (it
 * waited for frames) skips it at once, and the head holds on the last sample
 * and moves to the next one only in the last `PAUSE_STEP_MS` before it.
 * Interpolating across the whole gap would creep the head through the pause
 * and replay every movement after a rest late and at triple speed.
 */
const PAUSE_MS = LASER_EVERY_MS * 2
const PAUSE_STEP_MS = 16

/**
 * How many standing samples the sender keeps queued: the newest few, so that
 * the movement that ends the stand starts from where the hand really was.
 * The older ones lie within `LASER_STAND` of what the hall already has, under
 * the red dot, and holding them would make the hall replay a whole stand of
 * tremor before the movement that follows it.
 */
const STAND_KEEP = 8

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4
}

/** A number for a new press: new numbers are new shapes for the hall. */
export function newMarkId(): number {
  return Math.floor(Math.random() * 2 ** 31)
}

/* ------------------------------------------------------------ sender */

/** One kept sample: page fractions and milliseconds since the press. */
export interface LaserSample {
  x: number
  y: number
  t: number
}

/**
 * One press of the pointer on the presenter's side: samples in, frames out.
 *
 * Every sample goes through the same threshold whether it is drawn on the
 * console or sent to the hall: there is exactly one shape.
 */
export class LaserPress {
  mark: number
  readonly #t0: number
  #last: LaserSample | null = null
  #queue: number[] = []
  #sentX = Number.NaN
  #sentY = Number.NaN

  /** `t0` is the press's timestamp: samples are timed from it. */
  constructor(mark: number, t0: number) {
    this.mark = mark
    this.#t0 = t0
  }

  /** The last kept sample, or `null` before the first. */
  get last(): LaserSample | null {
    return this.#last
  }

  /**
   * One sample from the pen. Returns it rounded if it was kept, `null` if it
   * was too close to the previous one.
   *
   * `aspect` is the sheet's height over its width: distances are measured in
   * page widths, so that the threshold is the same pixel across and down.
   *
   * `near` is the zoom's magnification (1 for the whole page). The step is
   * about a pixel of the SCREEN, and every screen shows the same magnified
   * region: under a ×4 zoom a pixel is a quarter of the page distance, and a
   * threshold kept in page units would draw a magnified circle in visible
   * chords.
   */
  add(x: number, y: number, at: number, aspect: number, near = 1): LaserSample | null {
    const px = round(x)
    const py = round(y)
    const last = this.#last
    if (last && Math.hypot(px - last.x, (py - last.y) * aspect) < LASER_STEP / Math.max(1, near)) return null
    const t = Math.max(last?.t ?? 0, Math.round(at - this.#t0))
    const kept = { x: px, y: py, t }
    this.#last = kept
    this.#queue.push(px, py, t)
    return kept
  }

  /**
   * The frames to send now: everything queued, cut by `MAX_LASER_SAMPLES`.
   *
   * Not `final`, a queue that has not left the hall's last known position by
   * `LASER_STAND` is held back (the pointer stands, the hand trembles), and
   * only its newest few samples are kept (`STAND_KEEP`). `final` (the press,
   * the release, the end of a shape) sends whatever is there. `near` is the
   * zoom's magnification, as in `add`: a stand is still the size of the red
   * dot on the screen.
   */
  take(final: boolean, near = 1): number[][] {
    const queue = this.#queue
    if (queue.length === 0) return []
    if (!final && !Number.isNaN(this.#sentX)) {
      const stand = LASER_STAND / Math.max(1, near)
      let far = false
      for (let i = 0; i + 1 < queue.length; i += 3) {
        const dx = Math.abs(queue[i] - this.#sentX)
        const dy = Math.abs(queue[i + 1] - this.#sentY)
        if (dx >= stand || dy >= stand) {
          far = true
          break
        }
      }
      if (!far) {
        if (queue.length > STAND_KEEP * 3) this.#queue = queue.slice(queue.length - STAND_KEEP * 3)
        return []
      }
    }
    const frames: number[][] = []
    for (let i = 0; i < queue.length; i += MAX_LASER_SAMPLES * 3) {
      frames.push(queue.slice(i, i + MAX_LASER_SAMPLES * 3))
    }
    this.#sentX = queue[queue.length - 3]
    this.#sentY = queue[queue.length - 2]
    this.#queue = []
    return frames
  }

  /**
   * Continue under a new number from the current head: the shape reached
   * `MARK_MAX_SAMPLES`. Call `take(true)` first, so that the old shape's last
   * samples go out under its own number.
   */
  roll(mark: number): void {
    this.mark = mark
    const last = this.#last
    if (last) this.#queue.push(last.x, last.y, last.t)
  }
}

/* ---------------------------------------------------------- playback */

/**
 * One press of SOMEONE ELSE's pointer, replayed on a timeline.
 *
 * The samples carry the presenter's times; the playhead runs on ours,
 * `LASER_DELAY_MS` behind. "Behind what" is learned from the frames
 * themselves: the smallest gap ever seen between a sample's time and its
 * arrival is the network at its quickest, and everything later than that is
 * jitter the delay absorbs. No clocks are compared: only differences.
 *
 * When frames come late anyway (a Wi-Fi stall), the playhead waits at the
 * last sample and then catches up at up to three times the pace, following
 * the real path rather than flying a chord across it.
 */
export class LaserPlayback {
  readonly mark: number
  readonly page: number
  readonly shape: 'dot' | 'line'
  /** The samples as page fractions, pairs: the same layout as ink, drawn by the same curve. */
  readonly xy: number[] = []
  /** The presenter's time of each sample. */
  readonly ts: number[] = []
  /** How many samples the playhead has passed: those are drawn. */
  shown = 0
  /** The presenter let go: play to the end and stop. */
  ending = false
  #offset = Number.POSITIVE_INFINITY
  #play = Number.NEGATIVE_INFINITY
  #at = 0
  #endedAt = 0

  constructor(mark: number, page: number, shape: 'dot' | 'line') {
    this.mark = mark
    this.page = page
    this.shape = shape
  }

  /** Samples from a frame (`x, y, t` triples), arrived at local time `now`. */
  hear(pts: readonly number[], now: number): void {
    // The playhead stood at the end waiting: its clock starts again from now,
    // or the wait itself would be counted as playing time and the head would
    // jump along the new samples in one frame.
    const count = this.ts.length
    if (count > 0 && this.#play >= this.ts[count - 1]) this.#at = now
    let newest = Number.NaN
    for (let i = 0; i + 2 < pts.length; i += 3) {
      const t = pts[i + 2]
      newest = t
      const last = this.ts.length - 1
      // The timeline only goes forward: a duplicate or a stale sample adds nothing.
      if (last >= 0 && t < this.ts[last]) continue
      const same = pts[i] === this.xy[last * 2] && pts[i + 1] === this.xy[last * 2 + 1]
      if (last >= 0 && t === this.ts[last] && same) continue
      this.xy.push(pts[i], pts[i + 1])
      this.ts.push(t)
    }
    if (Number.isNaN(newest)) return
    this.#offset = Math.min(this.#offset, now - newest)
    if (this.#play === Number.NEGATIVE_INFINITY && this.ts.length > 0) {
      // The first sample shows at once: a pointer that appears a delay after
      // the press reads as "stuck". The movement from it is what is delayed.
      this.#play = this.ts[0]
      this.#at = now
      this.shown = 1
    }
  }

  /** The presenter let go at local time `now`. */
  end(now: number): void {
    if (this.ending) return
    this.ending = true
    this.#endedAt = now
  }

  /** Move the playhead to local time `now`. Returns whether more frames are needed. */
  advance(now: number): boolean {
    const count = this.ts.length
    if (count === 0) return false
    const elapsed = Math.min(100, Math.max(0, now - this.#at))
    this.#at = now
    const avail = this.ts[count - 1]
    const target = now - this.#offset - LASER_DELAY_MS
    // Standing before a pause while behind: skip the pause (see PAUSE_MS).
    const shown = this.shown
    if (shown > 0 && shown < count && this.ts[shown] - this.ts[shown - 1] > PAUSE_MS) {
      const resume = this.ts[shown] - PAUSE_STEP_MS
      if (this.#play < resume) this.#play = Math.max(this.#play, Math.min(target, resume))
    }
    const behind = target - this.#play
    const rate = behind > 40 ? Math.min(3, 1 + behind / 100) : 1
    // A release long overdue (frames lost on the way): finish rather than hang.
    const cap = this.ending && now - this.#endedAt > 1000 ? avail : Math.min(avail, target)
    let next = this.#play + elapsed * rate
    if (next > cap) next = Math.max(this.#play, cap)
    this.#play = next
    while (this.shown < count && this.ts[this.shown] <= next) this.shown += 1
    return next < avail
  }

  /** Played to the end after the release. */
  get done(): boolean {
    return this.ending && (this.ts.length === 0 || this.#play >= this.ts[this.ts.length - 1])
  }

  /** Reveal everything at once: the shape is over (a new press, a lost release). */
  finish(): void {
    if (this.ts.length === 0) return
    this.#play = this.ts[this.ts.length - 1]
    this.shown = this.ts.length
  }

  /** Where the head is: on the line between the last passed sample and the next one. */
  head(): { x: number; y: number } | null {
    const count = this.ts.length
    if (this.shown === 0 || count === 0) return null
    const a = this.shown - 1
    if (this.shown >= count) return { x: this.xy[a * 2], y: this.xy[a * 2 + 1] }
    let from = this.ts[a]
    let span = this.ts[a + 1] - from
    // Across a pause the head holds, and moves only just before the next sample.
    if (span > PAUSE_MS) {
      from = this.ts[a + 1] - PAUSE_STEP_MS
      span = PAUSE_STEP_MS
    }
    const k = span > 0 ? Math.min(1, Math.max(0, (this.#play - from) / span)) : 0
    return {
      x: this.xy[a * 2] + (this.xy[a * 2 + 2] - this.xy[a * 2]) * k,
      y: this.xy[a * 2 + 1] + (this.xy[a * 2 + 3] - this.xy[a * 2 + 1]) * k,
    }
  }
}

/* ----------------------------------------------------------- phrases */

/**
 * A PHRASE: shapes written in a row, lit together and put out together.
 *
 * The owner, from the hall: a word written with the pointer must keep its
 * strokes while the hand is still writing, and go once the hand stops. Every
 * shape used to hold for 0.9 s after its OWN lift and fade by itself, so a
 * word melted from its first letter while its last was being written (and
 * the ninth stroke pushed the first off the slide: the ceiling was eight).
 *
 * The rule, one for the console and the hall:
 *  — a press that starts while a press of the phrase is held, or less than
 *    `PHRASE_HOLD_MS` after the phrase's last lift, joins the phrase;
 *  — every shape of the phrase stays at full strength until the phrase's
 *    LAST lift plus `PHRASE_HOLD_MS`, then all of them fade together over
 *    `PHRASE_FADE_MS`;
 *  — a press that starts once the phrase has begun to fade starts a new one.
 *    The fading phrase is not revived: a word on its way out does not flash
 *    back because the hand came down somewhere else;
 *  — a screen that hears the phrase from the wire holds it whole
 *    `PHRASE_WIRE_MS` longer, for the network's jitter, and fades it that
 *    much quicker: it still goes out with the console (`HeardPhrases`).
 *
 * A second and a half is longer than the pause between the letters of a word
 * and most pauses between words, and short enough that a phrase does not
 * outstay the thought it was written for. The fade is shorter than the old
 * 0.9 s: after the longer hold, a phrase that has started to go should be
 * gone before the hand writes the next one over the same place.
 */
export const PHRASE_HOLD_MS = 1500
export const PHRASE_FADE_MS = 600

/**
 * How much longer a phrase the presenter named on the wire (`trail`) holds
 * whole on the screens that hear it, and how much quicker it then fades.
 *
 * The hall learns that a press joined the phrase only when the press's first
 * frame arrives, and the hall's clock for the phrase starts from the last
 * lift, which it hears at the network's best (InkLayer · `finishStream`). Any
 * Wi-Fi delay above that best stretches the pause on the hall's clock: a press
 * the console joined 1.45 s after the lift arrived 400 ms late, at 1.85 s,
 * when the projector had begun to fade the word. It flashed back to full, and
 * past the fade the earlier letters were gone while the console still showed
 * them. Holding whole this much longer, the hall absorbs the ordinary jitter
 * of a classroom network; a press later than that starts a phrase of its own
 * there (`HeardPhrases`), never a flash back.
 *
 * THE END STAYS WHERE IT WAS: the grace comes out of the fade, not on top of
 * it. A word still goes out on the projector when it goes out on the console,
 * so the presenter, seeing their own word gone, is right about the hall; it
 * only starts going a moment later there, and goes quicker.
 */
export const PHRASE_WIRE_MS = 300

/**
 * How many shapes a screen keeps.
 *
 * A ceiling against a slide turning red over a class, not a design. It was
 * eight while every shape lived alone; a phrase is a word or a line, and a
 * handwritten word is ten to twenty presses, a short formula forty. Ninety-six
 * holds that and the phrase before it while it fades. Past the ceiling the
 * oldest shape goes at once. Each released shape keeps a small bitmap
 * (InkLayer · `bakeOf`), freed as soon as the shape burns out.
 */
export const MARKS_MAX = 96

/** A shape as its phrase sees it: which phrase, and when it was let go (`null` while held). */
export interface PhraseMark {
  phrase: number
  letGo: number | null
  /**
   * How much longer than `PHRASE_HOLD_MS` its phrase holds whole on this
   * screen (and how much quicker it fades): `PHRASE_WIRE_MS` for a shape
   * heard from the wire with the presenter's phrase, none (absent) for one's
   * own and for an older console's.
   */
  grace?: number
}

/** A phrase: whether any of its shapes is held, its newest lift, and how long it holds after it. */
export interface PhraseState {
  held: boolean
  /** The newest lift among its shapes; −∞ while none was let go. */
  lift: number
  /** The longest grace among its shapes (`PhraseMark.grace`): see `PHRASE_WIRE_MS`. */
  grace: number
}

/** Every phrase on screen, from its shapes. */
export function phrasesOf(marks: Iterable<PhraseMark>): Map<number, PhraseState> {
  const out = new Map<number, PhraseState>()
  for (const mark of marks) {
    let state = out.get(mark.phrase)
    if (!state) {
      state = { held: false, lift: Number.NEGATIVE_INFINITY, grace: 0 }
      out.set(mark.phrase, state)
    }
    if (mark.letGo === null) state.held = true
    else if (mark.letGo > state.lift) state.lift = mark.letGo
    if ((mark.grace ?? 0) > state.grace) state.grace = mark.grace ?? 0
  }
  return out
}

/**
 * How long a phrase holds whole after its last lift, and how long it then
 * fades: a grace lengthens the one and shortens the other by as much, and
 * the end stays `PHRASE_HOLD_MS + PHRASE_FADE_MS` after the lift (see
 * `PHRASE_WIRE_MS`).
 */
function holdOf(state: PhraseState): number {
  return PHRASE_HOLD_MS + Math.min(state.grace, PHRASE_FADE_MS / 2)
}

/** How brightly a phrase glows at `now`: whole while held and for the hold after its last lift, then down to nothing. */
export function phraseGlow(state: PhraseState | undefined, now: number): number {
  if (!state || state.held) return 1
  const since = now - state.lift
  const hold = holdOf(state)
  if (since <= hold) return 1
  return Math.max(0, 1 - (since - hold) / (PHRASE_HOLD_MS + PHRASE_FADE_MS - hold))
}

/** Whether a phrase has burnt out completely, so its shapes can go. */
export function phraseOver(state: PhraseState | undefined, now: number): boolean {
  return state !== undefined && !state.held && now - state.lift >= PHRASE_HOLD_MS + PHRASE_FADE_MS
}

/** Whether a press starting at `now` still joins the phrase: it has not begun to fade. */
function phraseOpen(state: PhraseState | undefined, now: number): boolean {
  return state !== undefined && (state.held || now - state.lift < holdOf(state))
}

/**
 * The phrase a press starting at `now` joins BY THE TIMING RULE, judged from
 * the shapes on screen; `null` starts a new one.
 *
 * The hall's fallback for frames that do not name their phrase (a console
 * from before phrases): the same rule the console applies, on the hall's own
 * clock, where a release is back-dated to the moment the presenter let go
 * (InkLayer · `finishStream`). Only the newest shape's phrase can still be
 * open, since presses come one after another.
 */
export function phraseFor(marks: readonly PhraseMark[], now: number): number | null {
  const newest = marks[marks.length - 1]
  if (!newest) return null
  const state = phrasesOf(marks.filter((mark) => mark.phrase === newest.phrase)).get(newest.phrase)
  return phraseOpen(state, now) ? newest.phrase : null
}

/**
 * The presenter's phrase clock: which phrase each press belongs to.
 *
 * The console decides, and says it in every pointer frame (`trail`), so that
 * the hall groups the shapes as the presenter wrote them instead of guessing
 * from the gaps between frames: the network stretches and squeezes those, and
 * a 1.45 s pause on the console arriving as 1.55 s would split a word in two
 * on the projector only. A clock of its own rather than the shapes, because a
 * dot (`laserShape`) leaves no shape and still belongs to the phrase.
 */
export class PhraseClock {
  #id = 0
  #held = 0
  #lift = Number.NEGATIVE_INFINITY
  readonly #fresh: () => number

  constructor(fresh: () => number = newMarkId) {
    this.#fresh = fresh
  }

  /** A press starts at `now`: the phrase it belongs to. */
  press(now: number): number {
    const state = { held: this.#held > 0, lift: this.#lift, grace: 0 }
    if (!phraseOpen(state, now)) this.#id = this.#fresh()
    this.#held += 1
    return this.#id
  }

  /** A press of the phrase was let go at `now`. */
  lift(now: number): void {
    if (this.#held === 0) return
    this.#held -= 1
    this.#lift = Math.max(this.#lift, now)
  }

  /**
   * A press that turned out not to be one: the first finger of a two-finger
   * gesture, or the palm before the pen (InkLayer · `dropBeam`). Nothing of it
   * reached the room, and here too it is as if it never was: it holds the
   * phrase no longer, and leaves no lift behind to keep the phrase open.
   */
  cancel(): void {
    if (this.#held > 0) this.#held -= 1
  }

  /** The phrase of the latest press; 0 before the first. */
  get id(): number {
    return this.#id
  }
}

/**
 * The phrases of presses heard from the wire, as a screen that hears them
 * groups them: which phrase each new press joins HERE.
 *
 * The presenter's phrase (`trail`) while it still holds on this screen, its
 * grace included (`PHRASE_WIRE_MS`): the console's grouping, not a guess from
 * gaps the network stretched. But when the press arrives so late that the
 * phrase has begun to fade here, the press starts a phrase of its own and the
 * fading one keeps fading: the rule for every screen is that a phrase on its
 * way out is not revived, and on the projector a word flashing back to full
 * reads as a glitch. Later presses of the same trail follow it to that phrase,
 * so the rest of the word still holds together. A frame naming no phrase (a
 * console from before phrases) is grouped by the timing rule (`phraseFor`).
 */
export class HeardPhrases {
  /** Trails whose phrase was fading here when a press of theirs came: where their presses go now. */
  readonly #moved = new Map<number, number>()
  readonly #fresh: () => number

  constructor(fresh: () => number = newMarkId) {
    this.#fresh = fresh
  }

  /** The phrase a press heard at `now` joins, judged from the shapes on its page. */
  join(marks: readonly PhraseMark[], trail: number | undefined, now: number): number {
    if (trail === undefined) return phraseFor(marks, now) ?? this.#fresh()
    const here = this.#moved.get(trail) ?? trail
    const state = phrasesOf(marks.filter((mark) => mark.phrase === here)).get(here)
    // Nothing of it is on screen (new, or burnt out): nothing to revive either.
    if (state === undefined || phraseOpen(state, now)) return here
    const next = this.#fresh()
    this.#moved.set(trail, next)
    // A trail is a phrase or two: the oldest ones are long over.
    if (this.#moved.size > 16) this.#moved.delete(this.#moved.keys().next().value as number)
    return next
  }
}

/* ----------------------------------------------------------- hearers */

const hearers = new WeakMap<object, Set<(at: LaserAt | null) => void>>()

/**
 * Listen for pointer frames. Returns the unsubscribe.
 *
 * A listener, not the session's `laser` field: the field holds the LAST
 * frame, and with samples in every frame two of them overwriting each other
 * between two effect runs is a piece of the shape lost. Every frame reaches
 * every ink layer, in order.
 */
export function hearLaser(session: object, hear: (at: LaserAt | null) => void): () => void {
  const set = hearers.get(session) ?? new Set()
  hearers.set(session, set)
  set.add(hear)
  return () => set.delete(hear)
}

/** Called by the session's parsing of a `laser` frame. */
export function laserArrived(session: object, at: LaserAt | null): void {
  for (const hear of hearers.get(session) ?? []) hear(at)
}
