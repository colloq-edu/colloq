<!--
  Ink and the pointer on top of the page.

  A canvas exactly the size of the page, coordinates as fractions of that
  page. The projector has 1920 pixels, the tablet 1180, a student half a
  browser window: the presenter's pixel means nothing to any of them, while
  a fraction means the same thing everywhere.

  It ALWAYS draws, and takes input only for the presenter. It is one
  component rather than two precisely because drawing and showing what was
  drawn must be one piece of code: if they drifted apart, they would give a
  line that runs under the pen for the presenter and lies a centimetre to the
  left on the projector, and nobody could notice it anywhere but in the
  lecture hall.

  THREE CANVASES, NOT ONE, and that is the main decision of this file.

  At first there was one canvas, and it drew exactly what the server had
  confirmed: the presenter saw their own line after a round trip, a hundred
  milliseconds between pen and pixel, and that felt not like "the network is
  slow" but like "the tablet is broken". A second, WET, canvas appeared for
  one's own not-yet-confirmed strokes. But the pointer and the eraser ring
  landed on it too, and every frame of the glowing tail redrew all the wet
  strokes in full: on a heavily inked page the pointer "jumped", because a
  frame cost more than a frame's time.

  Now there are three, and each has its own rhythm of life:
  — DRY (`ink-dry`): the room's ink, the same for everyone: the presenter,
    the audience, the projector. It changes on the server's echo, and even
    then incrementally: only a stroke disappearing, a page change or a size
    change makes it redraw in full.
  — WET (`ink-wet`): only one's own unfinished and unconfirmed strokes. It
    grows right from the pen handler, in pieces of curve, with no
    `clearRect` and no full path on every movement. A stroke is put out not
    when the pen lifts but when its echo has arrived and landed on the dry
    canvas; on lift the line would have a gap exactly as long as the round
    trip to the server.
  — LIVE (`ink-live`): everything that glows and fades by itself: the
    pointer's head and tail, the eraser ring, the predicted tip of a stroke.
    One frame loop, cheap clearing, nothing lasting: it can be wiped at any
    moment, and nobody loses anything.

  All three build their path with ONE function. If they drifted apart, they
  would give a stroke that twitches at the moment the wet line gives way to
  the dry one, and again nobody could notice it anywhere but in the lecture
  hall.

  THE PALM IS NOT AN EVENT. The layer used to hand a "foreign" finger to the
  parent, which read it as a swipe, and two fingers as "this stroke never
  happened", erasing what had been started. The heel of the palm and the
  little finger are exactly two fingers, and the palm rests on the tablet the
  whole time one writes: the third of three quick strokes did not get drawn.
  Now the only owner of touches on the sheet is this layer, and a finger,
  when there is a pen, means nothing except a two-finger tap: undo.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { untrack } from 'svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { inkFullSays, LASER_EVERY_MS } from '@shared/lecture'
  import { askInkPage } from './ink'
  import { inkRefusal } from './pult'

  interface Props {
    /** The page whose ink we show. */
    page: number
    /**
     * Whether to accept the pen: yes for the presenter, no for the audience.
     *
     * `false` in the middle of a stroke CLOSES the stroke rather than erasing
     * it: raised the notes sheet, pressed a button, that means "finished
     * writing", not "this never happened".
     */
    live: boolean
    /** What we draw with now: pen, marker, eraser or pointer. */
    tool: 'pen' | 'marker' | 'eraser' | 'laser' | 'off'
    /**
     * The pointer: as a dot or as a line.
     *
     * These are two different gestures, and there used to be only the
     * second. With a LINE one circles: "this area", "from here to here", and
     * the trail must stay while the circled thing is being talked about. With
     * a DOT one points: "right here", "this line", and then a trail gets in
     * the way: in half a minute of explanation the slide is covered in a red
     * web through which the slide itself can no longer be seen. Neither works
     * in place of the other, either way round, hence the choice.
     */
    laserShape?: 'dot' | 'line'
    color: string
    /** Thickness as a fraction of the page width. */
    width: number
    /**
     * Thickness from Pencil pressure: reserved, always `false`.
     *
     * Pressure is read into the point model (see `Wet.force`), but it goes
     * neither into drawing nor down the wire: a local thickness without the
     * wire would give the projector a different line than the presenter's,
     * and this file exists precisely so that there is one line.
     */
    pressure?: boolean
    /**
     * Whether a finger draws with the current tool.
     *
     * On a laptop and until the first Pencil touch, yes: otherwise there is
     * nothing to draw with. Once a pen has been seen on this screen, the
     * parent turns it off: from that moment a finger is the palm, and the
     * palm is always there.
     */
    finger?: boolean
    /*
     * The sheet's size in pixels, from whoever computed it.
     *
     * Not measured here again: the canvas must match the sheet pixel for
     * pixel, and two measurements of the same thing diverge, and the
     * divergence shows as ink shifted against the text. Besides, there would
     * be nothing to measure with: the size observer is silent while the
     * browser does not render the tab.
     */
    w: number
    h: number
    /**
     * How far the input layer reaches beyond the page, in px on each side.
     *
     * The console puts the page into a box with margins, and the input layer
     * must cover the whole box: a margin given away to the system is a palm
     * that selects and scrolls the sheet, and a pen that "didn't work"
     * because the stroke was started at the paper's edge. The default is
     * zero: for the audience and in the laptop column the page is the whole
     * box.
     */
    reach?: { top: number; right: number; bottom: number; left: number }
    /**
     * The layer has captured the pointer: a stroke, an erase or the laser
     * pointer is in progress.
     *
     * The parent uses this flag to keep the palm away from the rail buttons.
     * Without it the console would press "Back" with the heel of the writing
     * hand.
     */
    onbusy?: (busy: boolean) => void
    /** Two fingers tapped the sheet: undo the last stroke. */
    onundo?: () => void
    /** First pen on this screen in the component's lifetime: fingers stop drawing. */
    onpen?: () => void
    /**
     * The layer refused to do something, and that must be said out loud.
     *
     * There are exactly two refusals, and both used to be silent. The eraser
     * without a connection erased locally and put the erase into the queue,
     * and half a minute later strokes vanished for the audience by
     * themselves, in the middle of the next slide. A stroke on a full page
     * was not accepted by the server at all, and the layer, not telling this
     * from a lost frame, resent it whole eight times and removed it from the
     * sheet four seconds later: the line was drawn and disappeared, without a
     * line of explanation.
     *
     * Not passed: we stay silent, as before: for the audience and on the
     * projection there is nobody to tell and nothing to tell about, nothing
     * is drawn there.
     */
    onrefuse?: (says: string) => void
  }

  let {
    page,
    live,
    tool,
    laserShape = 'line',
    color,
    width,
    // `pressure` is deliberately not read: see the comment on the prop.
    finger = true,
    w,
    h,
    reach = { top: 0, right: 0, bottom: 0, left: 0 },
    onbusy,
    onundo,
    onpen,
    onrefuse,
  }: Props = $props()
  const session = getSessionState()

  let dryCanvas = $state<HTMLCanvasElement | null>(null)
  let wetCanvas = $state<HTMLCanvasElement | null>(null)
  let liveCanvas = $state<HTMLCanvasElement | null>(null)
  let inputNode = $state<HTMLDivElement | null>(null)

  /* -------------------------------------------------- stroke geometry */

  /**
   * Fit the canvas to the sheet and get the pen ready.
   *
   * Assigning width/height wipes both the pixels and the context state, and
   * does so even when the value is the same. So only on a real size change:
   * otherwise rotating the tablet would blank the page out of nowhere.
   *
   * Returns whether that change happened: the canvas is empty after it, and
   * one can no longer draw into it "from where we stopped"; the path has to
   * be rebuilt from fractions. The recomputation is free: the points are
   * stored as fractions anyway.
   *
   * `desynchronized` for the wet and the live canvas: the browser then does
   * not wait for the compositor and puts pixels under the pen a frame
   * earlier. Not for the dry one: it changes over the network, a tear in a
   * frame shows on it as flicker, and there is no gain whatsoever.
   */
  function fitTo(
    node: HTMLCanvasElement,
    fast: boolean,
  ): { paint: CanvasRenderingContext2D; blank: boolean } | null {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const wide = Math.round(w * ratio)
    const high = Math.round(h * ratio)
    let blank = false
    if (node.width !== wide || node.height !== high) {
      node.width = wide
      node.height = high
      blank = true
    }
    const paint = node.getContext('2d', fast ? { desynchronized: true } : undefined)
    if (!paint) return null
    paint.setTransform(ratio, 0, 0, ratio, 0, 0)
    paint.lineCap = 'round'
    paint.lineJoin = 'round'
    paint.globalAlpha = 1
    return { paint, blank }
  }

  /**
   * A path through the points: quadratic curves through segment midpoints.
   *
   * It used to be a polyline of `lineTo`, that is, exactly the points the
   * browser managed to send. On a slow stroke there is no difference, on a
   * fast one facets show, and on a 1920 projector they show to the whole
   * audience: the hand covers a centimetre per frame, and the line becomes
   * a polygon. A curve through midpoints costs as many path operations (the
   * same one per point) but passes through the points smoothly.
   *
   * This function is the only place a path is built. All three canvases
   * call it; otherwise the line would twitch at the moment one replaces
   * another.
   */
  function trace(paint: CanvasRenderingContext2D, points: number[], px: number, py: number): void {
    const last = points.length / 2 - 1
    paint.beginPath()
    paint.moveTo(points[0] * px, points[1] * py)
    for (let i = 1; i < last; i += 1) {
      const cx = points[i * 2] * px
      const cy = points[i * 2 + 1] * py
      paint.quadraticCurveTo(cx, cy, (cx + points[i * 2 + 2] * px) / 2, (cy + points[i * 2 + 3] * py) / 2)
    }
    paint.lineTo(points[last * 2] * px, points[last * 2 + 1] * py)
  }

  /**
   * A whole stroke, with one `stroke()`.
   *
   * One, not per segment: the marker is translucent, and at the joint of two
   * separate calls the alpha adds up. The line would come out blotchy
   * exactly where the hand slowed down and the points fell close together.
   */
  function drawStroke(
    paint: CanvasRenderingContext2D,
    points: number[],
    tint: string,
    thick: number,
    px: number,
    py: number,
  ): void {
    if (points.length < 2) return
    const line = Math.max(1, thick * px)
    if (points.length === 2) {
      /*
       * A pen tap is exactly two coordinates, and such a stroke used to reach
       * the server, be stored there and never be drawn: a path of one point
       * draws nothing. A circle draws the dot.
       */
      paint.fillStyle = tint
      paint.beginPath()
      paint.arc(points[0] * px, points[1] * py, line / 2, 0, Math.PI * 2)
      paint.fill()
      return
    }
    paint.strokeStyle = tint
    paint.lineWidth = line
    trace(paint, points, px, py)
    paint.stroke()
  }

  /** Translucent = 8-digit (or 4-digit) hex: the marker's alpha lives in its colour. */
  function seeThrough(tint: string): boolean {
    return /^#(?:[\da-f]{4}|[\da-f]{8})$/i.test(tint)
  }

  /** How far the curve on the canvas reaches: last point index and path end in px. */
  interface Tail {
    /** How many of the stroke's numbers are already on the canvas. */
    n: number
    curved: number
    tipX: number
    tipY: number
  }

  /** The tail of a stroke drawn whole through `drawStroke`. */
  function tailOf(points: number[]): Tail {
    const last = points.length / 2 - 1
    if (last < 1) return { n: points.length, curved: 0, tipX: points[0] * w, tipY: points[1] * h }
    return {
      n: points.length,
      curved: Math.max(0, last - 1),
      tipX: ((points[(last - 1) * 2] + points[last * 2]) / 2) * w,
      tipY: ((points[(last - 1) * 2 + 1] + points[last * 2 + 1]) / 2) * h,
    }
  }

  /**
   * Continue drawing a stroke from where we stopped.
   *
   * Not `clearRect` on every pen movement: clearing and rebuilding the whole
   * stroke means trading one full repaint for another, and the wet layer
   * exists precisely to avoid it. We lay down only the new pieces of the
   * curve.
   *
   * The tail from the last midpoint to the last point is laid down
   * provisionally and covered by the real curve on the next movement.
   * Without it the line lags behind the pen by half a sample, that is, by a
   * centimetre on a fast flourish, exactly the distance all of this is done
   * for. For an opaque colour the overlap is invisible; a translucent marker
   * cannot be drawn this way, so call it only for opaque ones.
   *
   * One and the same function grows one's own wet stroke under the pen and
   * someone else's dry one by echo: otherwise the dry canvas would have to
   * repaint the page on every frame of someone else's pen, twenty-five
   * times a second over six hundred strokes.
   */
  function growPath(paint: CanvasRenderingContext2D, points: number[], tint: string, thick: number, tail: Tail): void {
    const last = points.length / 2 - 1
    if (last < 0) return
    if (last === 0) {
      drawStroke(paint, points, tint, thick, w, h)
      Object.assign(tail, tailOf(points))
      return
    }
    paint.strokeStyle = tint
    paint.lineWidth = Math.max(1, thick * w)
    for (let i = tail.curved + 1; i < last; i += 1) {
      const cx = points[i * 2] * w
      const cy = points[i * 2 + 1] * h
      const mx = (cx + points[i * 2 + 2] * w) / 2
      const my = (cy + points[i * 2 + 3] * h) / 2
      paint.beginPath()
      paint.moveTo(tail.tipX, tail.tipY)
      paint.quadraticCurveTo(cx, cy, mx, my)
      paint.stroke()
      tail.tipX = mx
      tail.tipY = my
      tail.curved = i
    }
    paint.beginPath()
    paint.moveTo(tail.tipX, tail.tipY)
    paint.lineTo(points[last * 2] * w, points[last * 2 + 1] * h)
    paint.stroke()
    tail.n = points.length
  }

  /* ----------------------------------------------------- dry canvas */

  /** Strokes held by the wet layer now: the dry one skips them, or they double. */
  let wetIds = $state.raw<Set<string>>(new Set())
  /**
   * Erased with the eraser but not yet confirmed by the server.
   *
   * We put it out at once, without waiting for `ink:drop`: an eraser that
   * takes effect after a round trip to the server feels broken, and people
   * go over the stroke a second time. If the confirmation never comes, the
   * stroke returns with the nearest full batch: a self-correcting lie a
   * second long is more honest than an eraser that "doesn't work".
   */
  let erased = $state.raw<Set<string>>(new Set())

  /**
   * What lies on the dry canvas, by stroke id.
   *
   * By this map the echo is applied incrementally: a new stroke in full, a
   * grown one only by its new piece. A full repaint remains for the three
   * cases when pixels must be REMOVED: a stroke vanished (undo, eraser,
   * clearing), the page changed, the size changed. Someone else's growing
   * translucent marker is a repaint too: it cannot be laid down in pieces
   * (see drawStroke), and it only ever comes from a second teacher.
   */
  const drawn = new Map<string, Tail>()
  let drawnPage = Number.NaN

  $effect(() => {
    const node = dryCanvas
    // Read the edit counter: it is the very reason to repaint.
    void session.inkRevision
    const hidden = wetIds
    const gone = erased
    const now = page
    if (!node || w === 0 || h === 0) return
    untrack(() => paintDry(node, hidden, gone, now))
  })

  /*
   * INK FOR THE PAGE BEING SHOWN: ask for it if it has not arrived.
   *
   * The welcome batch no longer has to carry all of the lecture's writing:
   * it carries the current page and an inventory of the rest, and a page
   * one moved to without asking arrives on request (ink.ts · `askInkPage`).
   * The request lives here rather than on the console precisely because
   * this layer is the only place where a page is SHOWN: the projection, the
   * audience and the sheet under the pen are all built from it alone, and
   * what was asked once will reach all three.
   *
   * AFTER A PAUSE, AND THAT IS THE MAIN THING HERE. The page the presenter
   * moved the audience to is sent by the server itself, right after the
   * lecture frame. If the layer asked at once, every page turn would cost
   * five hundred identical questions in the second while that delivery is
   * still on its way, that is, exactly the broadcast round for which the
   * batch was trimmed. So the question is not the first move but a repair:
   * it is asked only if the ink is still missing after `INK_WAIT_MS`.
   *
   * The edit counter is read because the wait starts over on every change
   * in the ink: the inventory arrives together with it, and a page that has
   * arrived closes the question by itself (`askInkPage` stays silent when
   * the ink is on hand).
   */
  /** How long to await delivery before asking ourselves: a round trip plus margin. */
  const INK_WAIT_MS = 600

  $effect(() => {
    void session.inkRevision
    void session.connected
    const now = page
    const timer = window.setTimeout(() => untrack(() => askInkPage(session, now)), INK_WAIT_MS)
    return () => window.clearTimeout(timer)
  })

  function paintDry(node: HTMLCanvasElement, hidden: Set<string>, gone: Set<string>, now: number): void {
    const ready = fitTo(node, false)
    if (!ready) return
    const paint = ready.paint
    const visible = session.ink.filter(
      (stroke) => stroke.page === now && !hidden.has(stroke.id) && !gone.has(stroke.id),
    )
    let full = ready.blank || drawnPage !== now
    if (!full) {
      const present = new Set(visible.map((stroke) => stroke.id))
      for (const id of drawn.keys()) {
        if (!present.has(id)) {
          full = true
          break
        }
      }
    }
    if (!full) {
      for (const stroke of visible) {
        const known = drawn.get(stroke.id)
        if (known && stroke.points.length > known.n && seeThrough(stroke.color)) {
          full = true
          break
        }
      }
    }
    if (full) {
      paint.clearRect(0, 0, w, h)
      drawn.clear()
      drawnPage = now
      for (const stroke of visible) {
        drawStroke(paint, stroke.points, stroke.color, stroke.width, w, h)
        drawn.set(stroke.id, tailOf(stroke.points))
      }
      return
    }
    for (const stroke of visible) {
      const known = drawn.get(stroke.id)
      if (!known) {
        drawStroke(paint, stroke.points, stroke.color, stroke.width, w, h)
        drawn.set(stroke.id, tailOf(stroke.points))
      } else if (stroke.points.length > known.n) {
        growPath(paint, stroke.points, stroke.color, stroke.width, known)
      }
    }
  }

  /* ----------------------------------------------------- wet canvas */

  interface Wet {
    id: string
    page: number
    color: string
    width: number
    /** All the stroke's points, as pairs of fractions. */
    points: number[]
    /**
     * Pressure per point, 0..1, one number per pair.
     *
     * It goes neither down the wire nor onto the canvas (see the `pressure`
     * prop), but it is collected already: when the wire learns thickness,
     * what will have to change is the sending, not the point model.
     */
    force: number[]
    /** How many numbers have gone to the server: that is how we know our echo. */
    sent: number
    /** The pen was lifted: we may wait for the echo. */
    closed: boolean
    /** When it was closed: resending does not start before the echo could arrive. */
    closedAt: number
    /** How many times the unconfirmed tail has been resent. */
    resent: number
    /** This stroke's echo was seen: if it vanishes, the stroke was removed for all. */
    echoed: boolean
    /** How far the curve on the wet canvas reaches. */
    tail: Tail
  }

  /**
   * Strokes the server has not confirmed yet. A list, not one stroke: on a
   * broken connection any number of them pile up, and each waits for its own
   * echo on its own.
   */
  let wet: Wet[] = []

  function rememberWet(): void {
    wetIds = new Set(wet.map((stroke) => stroke.id))
  }

  /**
   * The whole wet canvas, only when the LIST of wet strokes has changed: a
   * stroke landed on the dry one, the page was turned, the sheet changed
   * size. One's own pen movement is put on the canvas by `growWet` right
   * from the handler; neither the pointer nor the ring is here: they live on
   * the live canvas and do not compete with the ink for a frame.
   */
  function paintWetAll(): void {
    const node = wetCanvas
    if (!node || w === 0 || h === 0) return
    const ready = fitTo(node, true)
    if (!ready) return
    const paint = ready.paint
    paint.clearRect(0, 0, w, h)
    for (const stroke of wet) {
      if (stroke.page !== page) continue
      drawStroke(paint, stroke.points, stroke.color, stroke.width, w, h)
      stroke.tail = tailOf(stroke.points)
    }
  }

  $effect(() => {
    void wetIds
    void page
    void w
    void h
    void wetCanvas
    untrack(() => paintWetAll())
  })

  /** One's own stroke under the pen: incrementally, in this same frame. */
  function growWet(stroke: Wet): void {
    const node = wetCanvas
    if (!node || w === 0 || h === 0) return
    const ready = fitTo(node, true)
    if (!ready) return
    /*
     * The marker is translucent and must be one `stroke()`: for it the wet
     * canvas is rebuilt. The list of wet strokes is short (closed ones go out
     * after a round trip to the server), so this is cheap, and there is no
     * other way.
     */
    if (ready.blank || seeThrough(stroke.color)) {
      paintWetAll()
      return
    }
    growPath(ready.paint, stroke.points, stroke.color, stroke.width, stroke.tail)
  }

  /* ---------------------------------------------------- live canvas */

  /**
   * Red. Not in the presenter's colour.
   *
   * A pointer is recognised without thinking: a red dot on a slide means
   * "look here", in every lecture hall in the world that has a laser
   * pointer. The presenter's colour came here from a general habit of
   * colouring everything by author, and a second teacher's pointer turned
   * out blue, that is, indistinguishable from their own ink with which they
   * will underline a line a second later.
   */
  const LASER = '#ff2b1d'

  /**
   * The tail.
   *
   * A dot without a tail gets lost on a projector: it travels half a metre
   * between two frames, and an eye in the hall catches it only where it
   * stopped, that is, after it has already pointed. The tail shows MOVEMENT:
   * where the hand is leading from and to, and it lasts exactly long enough
   * to trace the path without turning into a line that would be taken for
   * ink.
   *
   * The tail's points are real samples with real timestamps. The gaps
   * between wire frames used to be padded with "midpoints" with made-up
   * times, and the tail flickered because of it: the midpoints faded out of
   * the order in which they were laid. Smoothness now comes from the head
   * (see below), not from forgery.
   */
  /*
   * How long the trail lives. It was 420 ms: a flourish faded before the
   * presenter could finish the sentence about what they had circled with it:
   * "circled it, and it's gone". A second and more holds the circled thing
   * exactly long enough for it to be seen even from the back row, and does
   * not turn the trail into a line that would be taken for ink: it melts the
   * whole time.
   */
  /*
   * How long the trail holds WHOLE and how long it fades.
   *
   * With the pointer one circles a shape and talks about it: "this area".
   * While they talk, the shape must stand, all of it, rather than melt from
   * the tail. So the trail has two phases: it holds at full strength for
   * HOLD_MS after the pen is lifted, and then fades WHOLE over FADE_MS.
   * Individual points no longer have an age: the old "each point lives its
   * 1.2 s" was that very crystallisation: the trail was eaten away from the
   * tail while the head was still writing.
   */
  const HOLD_MS = 900
  const FADE_MS = 900
  /*
   * The ceiling of points in one shape. A point is laid by a frame (see
   * `tick`), that is, sixty per second: six hundred is ten seconds of
   * continuous circling, longer than anyone moves in one motion, and beyond
   * that the oldest points drop off the front of the shape.
   */
  const TRAIL_MAX = 600
  /*
   * The trail rebuild step, in canvas pixels.
   *
   * Over the wire the pointer travels at twenty-five frames per second: in a
   * fast movement there are centimetres between two samples, and a trail
   * joined with straight lines reads as a polygon on the projector: "I draw
   * a circle, and I get a pentagon". So before drawing, the points are
   * rebuilt with a Catmull–Rom curve at a four-pixel step: locally this
   * changes almost nothing (the samples are dense anyway), while in the hall
   * and on the projector it gives the same smooth line the presenter sees.
   */
  const TRAIL_STEP_PX = 4
  /*
   * There are several shapes on a slide.
   *
   * People do not circle with the pointer in a single flourish: they
   * underline a line, then circle a formula, then poke at an axis. While each
   * new touch erased the previous one, it was impossible to finish a
   * sentence: half of what was shown vanished under the hand. Now a touch
   * starts ITS OWN shape, and each one lives out its life by itself; the
   * ceiling keeps the slide from turning into ink over a class.
   */
  const MARKS_MAX = 8
  interface Dot {
    x: number
    y: number
  }
  interface Mark {
    page: number
    dots: Dot[]
    /** When the pen let go; `null` means this shape is being drawn right now. */
    letGo: number | null
    /** At what brightness the shape is currently drawn on the canvas. */
    shown: number
  }

  /** How brightly a shape glows: it stands for HOLD_MS, melts over FADE_MS. */
  function glow(mark: Mark, now: number): number {
    if (mark.letGo === null) return 1
    const since = now - mark.letGo
    return since <= HOLD_MS ? 1 : Math.max(0, 1 - (since - HOLD_MS) / FADE_MS)
  }
  let marks: Mark[] = []

  /** The shape under the pen: the last one, until it is let go. */
  function drawnNow(): Mark | null {
    const last = marks[marks.length - 1]
    return last && last.letGo === null ? last : null
  }

  /**
   * The pointer's head is a spring, not the last point.
   *
   * Where the pointer is being led is known at the moment of the sample;
   * where to DRAW it is a question for the frame. Putting the head exactly at
   * the last sample, at the wire's 25 Hz we get a spot jumping by half a
   * centimetre: that is the "pointer jumps" reported from the lecture hall.
   * The head goes to the target on a critically damped spring with a
   * settling time of about fifty milliseconds: the presenter's own hand is
   * caught up with in three frames and goes unnoticed, while someone else's
   * trail in the hall is smoothed between wire frames. The spring is
   * analytic, not stepped: a stepped one with this stiffness blows up on a
   * missed frame.
   *
   * The head lives while the pointer is held: most often the pointer STANDS
   * still ("right here"), and a dot living on a timer would vanish under the
   * hand. Only a released pointer (laser:off) puts the head out, or moving to
   * another page; the shape itself then stands and melts in its own time.
   */
  /**
   * Stiffness goes BY THE SAMPLE SOURCE, and that is not a subtlety.
   *
   * The spring smooths the gap between two samples, and the gaps for one's
   * own hand and for the wire differ by an order of magnitude: the pen
   * reports its position a hundred and twenty times a second, the wire
   * fifteen. One number for both gives only one of the two: a stiff one
   * (110 rad/s, 4 % left after 50 ms) keeps ONE'S OWN pointer under the
   * hand, but for the audience it reaches the target and stands waiting for
   * the next frame, that is, in steps; a soft one smooths the audience's
   * view, but one's own pointer starts lagging behind one's own hand, and it
   * is the presenter who sees that.
   *
   * So there are two, and the second is derived from the wire's tick: the
   * 4 % remainder is reached in about 3.2/k seconds, so k ≈ 3.2 / tick: the
   * head arrives exactly as the next sample does and does not stop between
   * them. For `LASER_EVERY_MS` = 66 ms that is 3.2 / 0.066 ≈ 48. The number
   * is written out rather than computed from the tick: 3.2 is an estimate by
   * eye, not an identity, and a `const` derived from the tick would drag the
   * spring's stiffness along with every edit of the tick without ever once
   * being shown to a person on screen.
   */
  const SPRING_HAND = 110
  const SPRING_WIRE = 48
  interface Head {
    page: number
    /** Where we are heading. */
    tx: number
    ty: number
    /** Where we draw and how fast we fly. */
    x: number
    y: number
    vx: number
    vy: number
    /** This head's stiffness: one's own hand or the wire. */
    k: number
  }
  let head: Head | null = null
  let headAt = 0
  /**
   * Where the head was drawn in the last frame, in canvas px, for the test
   * bench (see `window.__inkLat`). The bench used to track the head by the
   * live canvas's pixels, reading them on every frame; but reading pixels
   * forces the browser to rasterise the canvas right away, and with a
   * software rasteriser that cost more than a frame: the bench was measuring
   * its own shadow. From here it takes what the frame actually drew.
   */
  let shownHead: { x: number; y: number; at: number } | null = null

  function settleHead(now: number): boolean {
    if (!head) return false
    const dt = Math.min(0.05, Math.max(0, (now - headAt) / 1000))
    headAt = now
    const k = head.k
    const decay = Math.exp(-k * dt)
    const dx = head.x - head.tx
    const dy = head.y - head.ty
    const bx = head.vx + k * dx
    const by = head.vy + k * dy
    head.x = head.tx + (dx + bx * dt) * decay
    head.y = head.ty + (dy + by * dt) * decay
    head.vx = (bx - k * (dx + bx * dt)) * decay
    head.vy = (by - k * (dy + by * dt)) * decay
    // Arrived, to within a third of a pixel: no more frames spin for the head.
    const still = Math.hypot(head.x - head.tx, head.y - head.ty) * w < 0.3
    if (still) {
      head.x = head.tx
      head.y = head.ty
      head.vx = 0
      head.vy = 0
    }
    return !still
  }

  /**
   * Where the pointer is being led. The line itself is not laid here.
   *
   * Raw samples used to go into the trail while the head went to them on a
   * spring, and the ribbon, having reached the freshest sample, came back
   * to the lagging head. That loop read as "the tail is catching up with its
   * own start", and only on the tablet: there are a hundred and twenty
   * samples a second there, and the head's lag has time to build up to a
   * centimetre, while over the wire there are twenty-five and the head
   * arrives between frames.
   *
   * Now a sample only moves the TARGET, and what goes into the line is what
   * was drawn: the head's position on each frame. So the ribbon always ends
   * exactly at the head (a fold is impossible in principle), and the spring
   * doubles as smoothing: pen jitter does not pass through it, and over the
   * wire, between two sparse samples, we get our own sixty points a second
   * rather than a straight line.
   */
  function aim(x: number, y: number, at: number, k: number): void {
    if (!head || head.page !== at) {
      // Appeared: right in place at once; a head flying in from a corner
      // would read as "the pointer got stuck".
      head = { page: at, tx: x, ty: y, x, y, vx: 0, vy: 0, k }
      headAt = performance.now()
    } else {
      head.tx = x
      head.ty = y
      // The pointer may have been taken over: the spring follows the sample source.
      head.k = k
    }
    /*
     * As a dot, no shapes are started at all. Not "draw and hide": a shape
     * that does not exist accumulates no points, asks for no frames to fade
     * and does not go down the wire, and the pointer has always had its own
     * head: that is the dot.
     */
    if (shapeNow === 'line' && !drawnNow()) {
      marks.push({ page: at, dots: [{ x: head.x, y: head.y }], letGo: null, shown: 0 })
      if (marks.length > MARKS_MAX) marks = marks.slice(-MARKS_MAX)
    }
    wake()
  }

  /**
   * The pointer was released.
   *
   * `soft` is the usual case: the HEAD goes out, and the trail burns down by
   * itself over its TRAIL_MS. That is exactly what one expects of a pointer:
   * circled, let go, and the circled thing is visible for another second to
   * the audience and on the projector. A clean wipe (`soft = false`) puts
   * out only what leaves the trail no place to lie: a page change, the layer
   * leaving, the sheet taken away.
   */
  function douse(soft = false): void {
    head = null
    if (soft) {
      // The shape that was just circled is left standing: HOLD_MS at full
      // strength, then FADE_MS to fade out as a whole. The count starts here.
      const now = drawnNow()
      if (now) now.letGo = performance.now()
    } else {
      marks = []
    }
    wake()
  }

  /** Where the eraser is right now: the ring under the pen is drawn only for us. */
  let ring: { x: number; y: number } | null = null
  /**
   * The predicted tip of a stroke.
   *
   * Between a sample and a pixel there is a frame, and on a fast flourish
   * the line lags behind the pen by a centimetre. The browser
   * (`getPredictedEvents`), or we ourselves from the speed of the last
   * samples, draw ten milliseconds ahead. It lives on the live canvas: it is
   * wiped before the next increment and never gets into the points: on the
   * projector it would be a line the hand never drew.
   */
  let guess: { fromX: number; fromY: number; x: number; y: number; color: string; width: number } | null = null

  let liveFrame: number | undefined
  let liveDirty = false

  /** The live canvas has something to draw in the next frame. */
  function wake(): void {
    liveDirty = true
    if (liveFrame !== undefined) return
    liveFrame = requestAnimationFrame(tick)
  }

  function tick(): void {
    liveFrame = undefined
    const now = performance.now()
    const moving = settleHead(now)
    /*
     * The line is laid by the frame, not by the sample: a point is placed
     * where the head is DRAWN (see `aim`). Half a pixel is the threshold
     * below which a point adds nothing but work: a pointer standing still
     * does not pile up a thousand points in one spot.
     */
    const led = drawnNow()
    if (head && led && led.page === head.page) {
      const last = led.dots[led.dots.length - 1]
      if (!last || Math.hypot((head.x - last.x) * w, (head.y - last.y) * h) >= 0.5) {
        led.dots.push({ x: head.x, y: head.y })
        if (led.dots.length > TRAIL_MAX) led.dots = led.dots.slice(-TRAIL_MAX)
      }
    }
    /*
     * Burnt down completely: the shape leaves whole, in one piece, as it
     * stood.
     *
     * And the main thing: while a shape HOLDS, nothing on the canvas changes,
     * yet the frame used to redraw it sixty times a second for nearly a
     * second in a row. On a projector with a software rasteriser that was the
     * most expensive idle work in the show: labour for the sake of the same
     * image. Now a frame draws only if some shape's brightness really is
     * different (or a shape appeared, left, or the head is flying).
     */
    let alive = false
    let burnt = false
    let changed = false
    for (const mark of marks) {
      if (mark.letGo !== null && now - mark.letGo >= HOLD_MS + FADE_MS) {
        burnt = true
        continue
      }
      if (mark.letGo !== null) alive = true
      // A shape from another page is not drawn at all, and asks for no frame.
      if (mark.page === page && Math.abs(glow(mark, now) - mark.shown) > 0.004) changed = true
    }
    if (burnt) marks = marks.filter((mark) => mark.letGo === null || now - mark.letGo < HOLD_MS + FADE_MS)
    if (liveDirty || moving || changed || burnt) paintLive(now)
    liveDirty = false
    /*
     * Frames keep spinning while there is unfinished business: the head is
     * flying to the pen or some shape has not burnt down yet. A standing
     * shape is still visited by the frame (otherwise nobody would notice
     * that HOLD_MS is up and it is time to fade), but it is NOT DRAWN: while
     * the brightness is the same, `changed` stays false and the live canvas
     * is not touched at all. What is expensive here is rasterising, not
     * walking the list.
     */
    if (moving || alive) liveFrame = requestAnimationFrame(tick)
  }

  /**
   * The trail, rebuilt as a curve in canvas pixels.
   *
   * A centripetal Catmull–Rom curve: the ordinary (uniform) one gives a loop
   * on a sharp turn, and circling is exactly what the pointer is for, so a
   * turn here is not an exception but the main case. The head is added as
   * the last point: it lags behind the last sample by the spring, and
   * without it the ribbon would hang in the air in front of the spot.
   */
  function smoothTrail(mark: Mark): { x: number; y: number }[] {
    const pts: { x: number; y: number }[] = []
    for (const dot of mark.dots) pts.push({ x: dot.x * w, y: dot.y * h })
    const out: { x: number; y: number }[] = []
    if (pts.length === 0) return out
    out.push({ x: pts[0].x, y: pts[0].y })
    if (pts.length === 1) return out

    for (let i = 0; i < pts.length - 1; i += 1) {
      const p0 = pts[i === 0 ? 0 : i - 1]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1]
      const span = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      // Exactly as many steps as this gap needs: in slow movement samples
      // are within a pixel of each other anyway, and there is no point
      // dividing them.
      const steps = Math.max(1, Math.min(16, Math.ceil(span / TRAIL_STEP_PX)))
      for (let k = 1; k <= steps; k += 1) {
        const t = k / steps
        const t2 = t * t
        const t3 = t2 * t
        out.push({
          x:
            0.5 *
            (2 * p1.x +
              (-p0.x + p2.x) * t +
              (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
              (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y:
            0.5 *
            (2 * p1.y +
              (-p0.y + p2.y) * t +
              (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
              (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        })
      }
    }
    /*
     * The ceiling of points per frame. A long shape is up to a thousand
     * points after rebuilding, and the ribbon is built from them TWICE (halo
     * and core), that is, four thousand segments per frame. Three hundred
     * and sixty is the limit past which the eye no longer sees a difference
     * (on a long shape that is a point every six to eight pixels, and the
     * join is round), and the frame stops depending on how long the pointer
     * was moved. The number is small for a reason: a stroke with a round join
     * costs an arc at every point, and on the projector's software rasteriser
     * that is the most expensive part of the frame.
     */
    if (out.length > 120) {
      const stride = Math.ceil(out.length / 120)
      const thin: { x: number; y: number }[] = []
      for (let i = 0; i < out.length; i += stride) thin.push(out[i])
      const last = out[out.length - 1]
      if (thin[thin.length - 1] !== last) thin.push(last)
      return thin
    }
    return out
  }


  function paintLive(now: number): void {
    const node = liveCanvas
    if (!node || w === 0 || h === 0) return
    const ready = fitTo(node, true)
    if (!ready) return
    const paint = ready.paint
    paint.clearRect(0, 0, w, h)

    if (guess) {
      paint.strokeStyle = guess.color
      paint.lineWidth = Math.max(1, guess.width * w)
      paint.beginPath()
      paint.moveTo(guess.fromX * w, guess.fromY * h)
      paint.lineTo(guess.x * w, guess.y * h)
      paint.stroke()
    }

    const radius = Math.max(9, w * 0.011)
    if (marks.length > 0) {
      /*
       * THE TRAIL IS ONE DENSE GLOWING LINE.
       *
       * No chain of blobs, no tapering towards the tail, no per-point fading:
       * all of that read as "a tail of beads chasing the head", and as
       * crystallisation: the trail was eaten away from the end while the hand
       * was still leading. The pointer is not a comet: it circles a shape, and
       * the shape must stand whole while it is being talked about. It goes out
       * whole as well: it stands for HOLD_MS, melts over FADE_MS.
       *
       * The line is STROKED, not filled. Filling an outline (both sides of the
       * ribbon as one path) cancels itself at a self-intersection: at a loop
       * and at a sharp turn the sides run towards each other, the windings add
       * up to zero, and holes appear in the stroke. Over the wire with its
       * twenty-five samples this almost never happened, while on the tablet,
       * where there are five times as many points, the trail crumbled into
       * roughness and then suddenly became dense again. A stroke with a round
       * join knows no such holes at all and costs no more.
       */
      /*
       * The join is BEVELLED, not round. A round join is an arc at every
       * point, and the projector's rasteriser (software, no graphics card)
       * spends a quarter of a frame on them for a long shape. With a step of
       * six to eight pixels and a smooth turn of the hand a bevel cannot be
       * told from an arc, and the line's caps are round anyway: there are
       * only two of them.
       */
      paint.lineJoin = 'bevel'
      paint.lineCap = 'round'
      paint.strokeStyle = LASER
      const core = radius * 0.34
      for (const mark of marks) {
        if (mark.page !== page) continue
        const dim = glow(mark, now)
        mark.shown = dim
        if (dim <= 0) continue
        const path = smoothTrail(mark)
        if (path.length === 0) continue
        if (path.length === 1) {
          // Poked and not moved: a "right here" dot is a shape too.
          paint.globalAlpha = 0.85 * dim
          paint.beginPath()
          paint.arc(path[0].x, path[0].y, core, 0, Math.PI * 2)
          paint.fill()
          continue
        }
        const line = new Path2D()
        line.moveTo(path[0].x, path[0].y)
        for (let i = 1; i < path.length; i += 1) line.lineTo(path[i].x, path[i].y)
        /*
         * The halo follows THE SAME path as the core.
         *
         * It used to follow a sparse copy, every fourth point: the saving was
         * meant against the round join on the software rasteriser. But the
         * join has long been bevelled and is cheap, and a sixteen-pixel step
         * on a band five times wider than the core shows as a polyline: the
         * glowing outline around the smooth core went in corners. We saved on
         * what was no longer expensive and paid with the very thing the
         * pointer exists for.
         */
        paint.globalAlpha = 0.18 * dim
        paint.lineWidth = core * 5.2
        paint.stroke(line)
        // The core.
        paint.globalAlpha = 0.85 * dim
        paint.lineWidth = core * 2
        paint.stroke(line)
      }
      paint.globalAlpha = 1
    }

    if (head && head.page === page) {
      /*
       * The head. A soft spot around the core: on a projector a bright
       * four-pixel dot gets lost on a white slide, while the glow is visible
       * from the back row.
       */
      const x = head.x * w
      const y = head.y * h
      shownHead = { x, y, at: now }
      /*
       * The head is not a separate ball chasing the ribbon but its glowing
       * end: the halo is half its former size and the core slightly larger,
       * so together with the ribbon they read as one thing. The glow is
       * still needed: a bright four-pixel dot gets lost on a white slide at
       * ten metres.
       */
      const halo = paint.createRadialGradient(x, y, 0, x, y, radius * 1.5)
      halo.addColorStop(0, LASER)
      halo.addColorStop(1, 'transparent')
      paint.globalAlpha = 0.5
      paint.fillStyle = halo
      paint.beginPath()
      paint.arc(x, y, radius * 1.5, 0, Math.PI * 2)
      paint.fill()
      paint.globalAlpha = 1
      paint.fillStyle = LASER
      paint.beginPath()
      paint.arc(x, y, radius * 0.55, 0, Math.PI * 2)
      paint.fill()
    }

    if (!head || head.page !== page) shownHead = null

    if (ring && live && tool === 'laser') {
      /*
       * The pointer's shadow is GREY, not red: on this screen only what the
       * audience sees glows red, and a shadow painted the same colour would
       * read as "I'm already pointing", although the pen is not on the glass
       * yet.
       */
      const x = ring.x * w
      const y = ring.y * h
      const r = Math.max(4, radius * 0.42)
      paint.globalAlpha = 0.5
      paint.fillStyle = 'rgba(120,132,153,1)'
      paint.beginPath()
      paint.arc(x, y, r, 0, Math.PI * 2)
      paint.fill()
      paint.globalAlpha = 0.45
      paint.strokeStyle = 'rgba(255,255,255,0.9)'
      paint.lineWidth = 1.5
      paint.beginPath()
      paint.arc(x, y, r + 1.5, 0, Math.PI * 2)
      paint.stroke()
      paint.globalAlpha = 1
    }

    if (ring && live && (tool === 'pen' || tool === 'marker')) {
      /*
       * The pen's shadow: a spot exactly as wide as the stroke will be and of
       * the same colour, but at half strength: this is not ink yet. A thin
       * dark outline holds it on a white slide, where a translucent spot of
       * its own colour would otherwise get lost.
       */
      const x = ring.x * w
      const y = ring.y * h
      const r = Math.max(3, (width * w) / 2)
      paint.globalAlpha = 0.55
      paint.fillStyle = color
      paint.beginPath()
      paint.arc(x, y, r, 0, Math.PI * 2)
      paint.fill()
      paint.globalAlpha = 0.5
      paint.strokeStyle = 'rgba(255,255,255,0.85)'
      paint.lineWidth = 1.5
      paint.beginPath()
      paint.arc(x, y, r + 1.5, 0, Math.PI * 2)
      paint.stroke()
      paint.globalAlpha = 1
    }

    if (ring && live && tool === 'eraser') {
      /*
       * The eraser ring is our own, and only ours: it is not on the
       * projector. Hollow, not filled: people look under it to see whether it
       * hits the stroke. A white outline under a dark one is the only way to
       * stay visible both on a white slide and on a dark full-sheet picture.
       */
      const x = ring.x * w
      const y = ring.y * h
      paint.beginPath()
      paint.arc(x, y, 16, 0, Math.PI * 2)
      paint.strokeStyle = 'rgba(255,255,255,0.9)'
      paint.lineWidth = 3
      paint.stroke()
      paint.strokeStyle = 'rgba(16,26,51,0.85)'
      paint.lineWidth = 1.5
      paint.stroke()
    }
  }

  // The live canvas: a page or size change means repaint; a tool change may
  // have made the eraser ring out of place.
  $effect(() => {
    void page
    void w
    void h
    void tool
    void liveCanvas
    untrack(() => wake())
  })

  /*
   * Someone else's pointer comes from the room; our own straight from under
   * the pen.
   *
   * While the pointer is our tool, the server's echo is ignored: it lags a
   * network round trip behind, and the tail would follow the hand with a
   * delay visible precisely to the one presenting. And for four hundred
   * milliseconds more after letting go: the last echo frames arrive after
   * `laser:off` and would flash as a dot on an empty spot.
   */
  const QUIET_AFTER_OFF_MS = 400
  let quietUntil = 0
  /**
   * The pointer shape the PRESENTER is using.
   *
   * Locally we know it from the prop, while the audience and the projector
   * know it only from the echo: their own prop is always the default
   * `line`, and without this line the presenter would point with a dot
   * while the audience saw a line. Our own shape outranks the arrived one
   * exactly as long as the pointer is ours.
   */
  let shownShape = $state<'dot' | 'line'>('line')
  const shapeNow = $derived(live && tool === 'laser' ? laserShape : shownShape)
  $effect(() => {
    const spot = session.laser
    const own = live && tool === 'laser'
    untrack(() => {
      if (own || performance.now() < quietUntil) return
      if (!spot) {
        // The presenter let go: the head goes out, what was circled burns down.
        douse(true)
        return
      }
      shownShape = spot.shape
      // Someone else's pointer: samples come at the wire's tick, so a softer spring.
      aim(spot.x, spot.y, spot.page, SPRING_WIRE)
    })
  })

  /*
   * A dropped connection puts out SOMEONE ELSE'S pointer.
   *
   * The presenter's `laser:off` goes down the wire past whoever is offline
   * at that moment, and the welcome batch for someone reconnecting has no
   * pointer at all. Without this, a red spot stood on the slide until the
   * end of the lecture, and the presenter's next movement drew a straight
   * line from it across half the page, because the shape was left unclosed.
   * We put it out softly: what was circled burns down, as on an ordinary
   * "let go".
   *
   * Our own pointer is not affected: it is local, and a dropped connection
   * does not bother it.
   */
  $effect(() => {
    if (session.connected) return
    untrack(() => {
      if (live && tool === 'laser') return
      douse(true)
    })
  })

  /* ----------------------------------------------------- echo and resend */

  /** How often we check closed wet strokes. */
  const SETTLE_EVERY_MS = 250
  /** How long to wait for the echo on a live connection before resending the tail. */
  const RESEND_AFTER_MS = 500
  /**
   * How many times to resend before admitting that the server does not want
   * this stroke: it has hit the ceiling of strokes per page or of points per
   * stroke. Otherwise the wet line would live on the console forever, while
   * the audience does not have it and never will.
   */
  const RESEND_MAX = 8
  let settleTimer: number | undefined

  /**
   * Remove wet strokes that have already landed on the dry canvas, and
   * resend those whose echo is lagging.
   *
   * The sign is the echo: a stroke with this id is in the room's ink and has
   * no fewer points than we sent. Putting it out on pen lift is not
   * possible: the dry canvas has not yet received the last piece at that
   * moment, and the line would get a gap as long as a round trip to the
   * server. Putting it out on a timer is not possible either: that is how it
   * was, and six strokes in a row on a slow tablet "went out and came back".
   *
   * Resending generalises the old "connection is back": the socket queue
   * holds sixteen frames and throws out old ones, and a frame lost on a
   * blinking Wi-Fi is made up for right here, from the point the server
   * confirmed.
   */
  function settle(): void {
    if (wet.length === 0) return
    const now = performance.now()
    let changed = false
    const keep = wet.filter((stroke) => {
      const echo = session.ink.find((known) => known.id === stroke.id)
      if (echo) stroke.echoed = true
      if (!stroke.closed) return true
      if (echo && echo.points.length >= stroke.sent) {
        changed = true
        return false
      }
      // The echo was there and vanished: the stroke was undone, erased or the
      // page cleared for everyone, so the wet copy on the console has no place
      // anymore either.
      if (!echo && stroke.echoed) {
        changed = true
        return false
      }
      if (!session.connected || now - stroke.closedAt < RESEND_AFTER_MS) return true
      if (stroke.resent >= RESEND_MAX) {
        changed = true
        return false
      }
      const have = echo?.points.length ?? 0
      sendPoints(stroke, stroke.points.slice(have))
      stroke.resent += 1
      stroke.closedAt = now
      return true
    })
    if (changed) {
      wet = keep
      rememberWet()
    }
    arm()
  }

  function arm(): void {
    if (settleTimer !== undefined) return
    if (!wet.some((stroke) => stroke.closed)) return
    settleTimer = window.setTimeout(() => {
      settleTimer = undefined
      settle()
    }, SETTLE_EVERY_MS)
  }

  $effect(() => {
    void session.inkRevision
    void session.connected
    untrack(() => settle())
  })

  /* ------------------------------------------------------------ input */

  /** When the pen last showed signs of life. See the two-finger tap. */
  let lastPenAt = 0
  /** A pen has been seen on this screen: `onpen` is called once. */
  let penKnown = false
  /**
   * The stroke being drawn now. `pointer` so that no other touch closes it;
   * `byFinger` so that the pen can: see `down`.
   */
  let drawing: { pointer: number; byFinger: boolean; stroke: Wet } | null = null
  /** The pointer that pressed the laser: a hovering pen does not put it out. */
  let beaming: number | null = null
  /** The laser is lit: `laser:off` must go out exactly once. */
  let lit = false
  /** The pointer that is erasing. */
  let erasing: number | null = null
  /** Points collected since the last send. */
  let pending: number[] = []
  let flushTimer: number | undefined

  /**
   * TWO TICKS, NOT ONE: ink and the pointer have different costs of error.
   *
   * The tick used to be shared, forty milliseconds, and with five hundred
   * listeners one presenter's hand, leading the pointer over a stroke, gave
   * fifty frames a second, that is, twenty-five thousand `ws.send` calls a
   * second in one Node process, and for every listener a rebuild of the ink
   * array twenty-five times a second.
   *
   * INK: 50 ms. A frame carries ALL points collected since the previous
   * send, so the line does not depend on the tick at all: only the tail's
   * delay changes, and nobody can tell ten milliseconds of it apart. Twenty
   * frames a second is exactly what it takes for the line to "follow the
   * hand" for the audience rather than appear in pieces.
   *
   * THE POINTER: less often, `LASER_EVERY_MS`, fifteen frames a second. It
   * has no accumulation: only the last point matters, and between two sparse
   * samples the viewer's head is built by the spring, with its own sixty
   * points a second (see `aim`). The spring, however, must know where the
   * samples come from: one's own hand gives them a hundred and twenty times
   * a second, the wire fifteen, and one and the same stiffness for both
   * gives either a lag behind one's own hand or steps for the audience.
   *
   * The pointer's tick is not ours but SHARED, and comes from
   * `@shared/lecture`: with the same window the server holds a point back
   * and broadcasts the last one (control.ts · `laserTo`). A copy of our own
   * used to stand here, and it left behind exactly the trouble for which
   * numbers move to shared: the server's copy explained itself by reference
   * to `SEND_EVERY_MS`, that is, to the INK tick, a different number, and
   * the next person to reconcile them would have moved the wrong constant.
   *
   * The ink tick, meanwhile, stays HERE and need not be shared: a frame
   * carries all points collected since the previous send, so the server has
   * nothing to check against it.
   */
  const SEND_EVERY_MS = 50
  /**
   * How far the pointer must move to be worth sending.
   *
   * Most often the pointer STANDS still ("right here"), and hand tremor on a
   * tablet produces a sample every eight milliseconds. Two thousandths of
   * the page width is four pixels on a 4K projector, that is, less than the
   * red dot itself: no difference is visible, and there are no frames.
   */
  const LASER_MIN_MOVE = 0.002

  /**
   * How many numbers fit into a frame.
   *
   * The control socket's frame ceiling is 32 KB (`MAX_FRAME_BYTES` in
   * server/src/control.ts), and a frame that exceeds it is silently dropped
   * by the server: no error, not a line in the log. With four decimal places
   * a number takes seven characters with the comma, so four hundred numbers
   * are 2800 bytes, a margin of more than ten times. The number itself comes
   * not from the frame ceiling but from the server's ceiling on NUMBERS in
   * one message (`MAX_POINTS_PER_MESSAGE` = 512 in shared/lecture.ts):
   * everything beyond it the server cuts off, and a piece of the line would
   * vanish for the audience silently. A pen held back by the system for half
   * a second gives up its samples in a batch, and without slicing such a
   * batch would go as one message.
   */
  const MAX_NUMBERS_PER_FRAME = 400
  /**
   * The server's ceiling is four thousand numbers per stroke, and it
   * silently discards everything beyond. A long wavy line across the whole
   * slide reaches it. A little before the ceiling the stroke is closed and
   * continued with a new one, from the same point, so nobody sees a break in
   * the line.
   */
  const SPLIT_AT_NUMBERS = 3900

  /**
   * Rounding to four decimal places.
   *
   * A page fraction with four decimals is a quarter of a pixel on a 4K
   * projector. Without rounding, a `0.1` coming out of a division gives
   * "0.10000000000000009": eighteen characters instead of six, that is, a
   * wire three times fatter for a precision that does not exist.
   */
  function round(value: number): number {
    return Math.round(value * 1e4) / 1e4
  }

  /**
   * Where the sheet is on screen: taken once on touch and by the size
   * observer.
   *
   * `getBoundingClientRect` on every sample is a forced layout two hundred
   * times a second; Pencil does not forgive that.
   */
  let rect: DOMRect | null = null
  function measure(): void {
    const node = wetCanvas
    rect = node ? node.getBoundingClientRect() : null
  }

  /**
   * Coordinates as fractions of the sheet, clamped to [0, 1].
   *
   * The input layer is wider than the sheet: the margins are on it too. A
   * stroke started on the margin and carried onto the sheet does start: on
   * paper one draws from the edge, and a pen that stays silent until it
   * crosses an invisible line is a pen that "didn't work".
   */
  function at(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    if (!rect || rect.width === 0 || rect.height === 0) return null
    const x = (event.clientX - rect.left) / rect.width
    const y = (event.clientY - rect.top) / rect.height
    return {
      x: round(x < 0 ? 0 : x > 1 ? 1 : x),
      y: round(y < 0 ? 0 : y > 1 ? 1 : y),
    }
  }

  /**
   * A contact patch 40 px wide or more is a palm, not a finger.
   *
   * A fingertip on glass is 15–20 px, the heel of the palm 40–60. This is
   * the only sign by which a palm can be told from a finger BEFORE the pen
   * has touched the sheet: the heel, landing 200 ms before the tip, used to
   * count as a finger and drew a dot (or shone the pointer) where the hand
   * rests. The browser does not always report the size (for a mouse and on
   * older WebKit it is 1×1), so the sign works only one way: large is
   * certainly a palm, small does not yet mean a finger.
   */
  const PALM_PX = 40
  function palmish(event: PointerEvent): boolean {
    return event.pointerType === 'touch' && (event.width >= PALM_PX || event.height >= PALM_PX)
  }

  /** The pen showed signs of life: the pause before a two-finger tap counts from now. */
  function penSeen(event: PointerEvent): void {
    if (event.pointerType !== 'pen') return
    lastPenAt = performance.now()
    if (!penKnown) {
      penKnown = true
      onpen?.()
    }
  }

  /**
   * Whose pointer this is: the tool's or the palm's.
   *
   * A pen and a mouse are always the tool, whatever the number of resting
   * touches: the palm always rests while writing, and "the pen does not draw
   * with two touches down" would mean "the pen does not draw". A finger is
   * the tool until the parent says otherwise.
   *
   * With the pointer tool a finger shines even with finger drawing off (to
   * point with a finger, as in Freeform), but only if it is alone and the
   * pen is not in play: previously "a finger with the pointer always shines"
   * meant that the heel of the palm landing on the sheet while the pen was
   * leading the pointer TOOK OVER the beam, and for the audience the dot
   * jumped to the palm and got stuck there, while the pen no longer obeyed.
   *
   * The beam's owner ALWAYS passes here, and without that the promise was not
   * kept at all: the beam is lit by the same touch, `down` sets `beaming` to
   * its pointerId, and all subsequent `pointermove` events of that same
   * finger died on `beaming === null` before reaching the pointer branch.
   * The finger lit the dot and could not move it: the audience saw a
   * motionless spot away from where one was pointing. The heel of the palm
   * is still cut off: it has a different pointerId.
   */
  function mine(event: PointerEvent): boolean {
    if (!live || tool === 'off') return false
    if (event.pointerType === 'pen') {
      penSeen(event)
      return true
    }
    if (event.pointerType === 'touch') {
      if (palmish(event)) return false
      if (finger) return true
      return (
        tool === 'laser' &&
        (beaming === null || beaming === event.pointerId) &&
        drawing === null &&
        performance.now() - lastPenAt > TAP_AFTER_PEN_MS
      )
    }
    return true
  }

  /** Whether we hold the pointer. The parent uses it to keep the palm off the buttons. */
  let busy = false
  function syncBusy(): void {
    const next = drawing !== null || erasing !== null || beaming !== null || lit
    if (next === busy) return
    busy = next
    onbusy?.(next)
  }

  /**
   * Hand the points to the server. Returns whether they went out.
   *
   * ON A CLOSED SOCKET AN INK FRAME IS NOT SENT AT ALL.
   *
   * `session.send` puts what could not be sent into the control queue, and
   * that holds sixteen messages and throws out THE OLDEST. Three seconds of
   * writing on a blinking Wi-Fi are seventy-five frames, of which the last
   * sixteen get through: the server starts the stroke FROM THE MIDDLE of the
   * formula, and its copy stops being the beginning of ours. Resending
   * (`settle`) treats it precisely as the beginning (it sends the tail from
   * the count of confirmed points), so on top of the stump came a jump back
   * as well, and the audience saw a line running from its end and written
   * over itself. On top of that, the frames pushed out of the queue the
   * presses it exists for.
   *
   * The invariant that holds everything else up: the server's copy of a
   * stroke is always the BEGINNING of ours. So what was not sent is not lost
   * but stays in `pending` (see `flush`) and goes out as a whole piece when
   * the connection returns; for a closed stroke resending does the same.
   */
  function sendPoints(stroke: Wet, numbers: number[]): boolean {
    if (!session.connected) return false
    /*
     * Sliced into frames, not one message: see MAX_NUMBERS_PER_FRAME. The
     * pieces go under one and the same stroke id: the server appends them to
     * the same stroke rather than starting a new one.
     */
    for (let from = 0; from < numbers.length; from += MAX_NUMBERS_PER_FRAME) {
      const chunk = numbers.slice(from, from + MAX_NUMBERS_PER_FRAME)
      session.send({
        t: 'ink',
        page: stroke.page,
        id: stroke.id,
        color: stroke.color,
        width: stroke.width,
        points: chunk,
      })
    }
    // Count what was sent: that is how the wet stroke recognises its echo.
    stroke.sent = stroke.points.length
    return true
  }

  function flush(): void {
    window.clearTimeout(flushTimer)
    flushTimer = undefined
    if (!drawing || pending.length < 2) return
    // Not sent: the points stay accumulated and will go as one piece when the
    // connection returns. Clearing `pending` here would cut a hole in the
    // stroke exactly where the Wi-Fi blinked.
    if (!sendPoints(drawing.stroke, pending)) return
    pending = []
  }

  function schedule(): void {
    if (flushTimer !== undefined) return
    flushTimer = window.setTimeout(flush, SEND_EVERY_MS)
  }

  function newStroke(x: number, y: number, force: number): Wet {
    return {
      id: `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      page,
      color,
      width,
      points: [x, y],
      force: [force],
      sent: 0,
      closed: false,
      closedAt: 0,
      resent: 0,
      echoed: false,
      tail: { n: 0, curved: 0, tipX: x * w, tipY: y * h },
    }
  }

  function openStroke(pointer: number, byFinger: boolean, place: { x: number; y: number }, force: number): void {
    /*
     * The pen touched down: the tip's shadow is removed. For the eraser the
     * ring stays in contact (people watch it to see whether it hits the
     * stroke), but under the pen's tip there is already its own line: a spot
     * on top of it reads as a blot the hand never made.
     */
    if (ring && tool !== 'eraser') ring = null
    const stroke = newStroke(place.x, place.y, force)
    // The filter starts at the point where the pen touched down: otherwise
    // the new stroke would come out of the end of the previous one, pulled
    // by its last value.
    smoothX = place.x
    smoothY = place.y
    wet = [...wet, stroke]
    rememberWet()
    drawing = { pointer, byFinger, stroke }
    pending = [place.x, place.y]
    growWet(stroke)
    /*
     * The first point goes at once: a pen tap must arrive even if the pen was
     * lifted right away, and nobody will notice forty milliseconds of tick on
     * the first point.
     *
     * With a finger, after a quarter-second delay: that much is set aside for
     * a second finger to turn the touch into an undo tap (see `down`). A sent
     * point cannot be taken back, while an unsent one "never happened": this
     * is the only case when a stroke disappears silently, and it is allowed
     * precisely because nothing from it has gone out.
     */
    if (byFinger) {
      window.clearTimeout(flushTimer)
      flushTimer = window.setTimeout(flush, TAP_TOGETHER_MS)
    } else {
      flush()
    }
    syncBusy()
  }

  /** A stroke from which not a single point went out: forget it, see `openStroke`. */
  function forgetUnsent(): void {
    if (!drawing || drawing.stroke.sent !== 0) return
    window.clearTimeout(flushTimer)
    flushTimer = undefined
    const gone = drawing.stroke
    drawing = null
    pending = []
    guess = null
    wet = wet.filter((stroke) => stroke !== gone)
    rememberWet()
    paintWetAll()
    wake()
    syncBusy()
  }

  /**
   * The pen was lifted, the tool changed, the page turned, the sheet taken:
   * the stroke is FINISHED, and from here on it waits for its echo. It is
   * never erased: what the presenter has already drawn, the audience has
   * already seen; "this never happened" is only the eraser and undo, and
   * both by hand.
   */
  function closeStroke(): void {
    if (!drawing) return
    flush()
    drawing.stroke.closed = true
    drawing.stroke.closedAt = performance.now()
    drawing = null
    guess = null
    wake()
    syncBusy()
    arm()
  }

  /**
   * LIGHT SMOOTHING OF THE INPUT.
   *
   * The curve through segment midpoints (`trace`) removes the facets between
   * samples, but it runs EXACTLY through the points the browser sent, along
   * with hand tremor and sensor noise. On a 1084 px sheet this is invisible,
   * on a 1920 projector the whole audience sees it: a letter is drawn with
   * confidence but looks rough.
   *
   * The filter here is the simplest and cheapest: the new point is pulled
   * seven tenths of the way towards the incoming one. Exactly `0.7`, not
   * less: at this coefficient the tip lags by about a third of a sample; for
   * a pen with its hundred and twenty samples a second that is about three
   * milliseconds, that is, no lag at all. Anything stronger starts to
   * "float" on a sharp turn, and a turn is the main case in handwriting.
   *
   * Smoothing happens BEFORE sending and before drawing, with one value: the
   * audience must get the same line the presenter sees, otherwise the
   * projector would have its own handwriting. The first point of a stroke is
   * not smoothed at all: it has nothing to be smoothed with.
   */
  const SMOOTH = 0.7
  let smoothX = 0
  let smoothY = 0

  /** Add a sample to the stroke; at the server's ceiling start a new one from this point. */
  function addPoint(place: { x: number; y: number }, force: number): void {
    if (!drawing) return
    const stroke = drawing.stroke
    if (stroke.points.length >= 2) {
      smoothX += (place.x - smoothX) * SMOOTH
      smoothY += (place.y - smoothY) * SMOOTH
      place = { x: smoothX, y: smoothY }
    } else {
      smoothX = place.x
      smoothY = place.y
    }
    pending.push(place.x, place.y)
    stroke.points.push(place.x, place.y)
    stroke.force.push(force)
    if (stroke.points.length >= SPLIT_AT_NUMBERS) {
      const { pointer, byFinger } = drawing
      growWet(stroke)
      closeStroke()
      openStroke(pointer, byFinger, place, force)
    }
  }

  /*
   * The pointer goes at ITS OWN tick, less often than ink (see
   * `LASER_EVERY_MS`).
   *
   * It has neither accumulation nor history: only the last point matters.
   * But sending it on every pointer movement means sending a hundred and
   * twenty frames a second to the whole room, and the eye cannot tell any
   * difference: the spot already flies faster than anyone can follow it,
   * and the gap between samples is filled in by the head's spring for every
   * viewer.
   */
  let spot: { x: number; y: number } | null = null
  let spotTimer: number | undefined
  /** The last thing sent down the wire: the move threshold is measured from it. */
  let beamed: { x: number; y: number } | null = null

  function beamNow(): void {
    window.clearTimeout(spotTimer)
    spotTimer = undefined
    if (!spot) return
    /*
     * The move threshold. The pointer stands still more often than it moves,
     * yet samples keep coming, and each went out as a frame to all five
     * hundred sockets, showing hand tremor. The first frame
     * (`beamed === null`) always goes out: it lights the dot, and there would
     * be no movement to wait for from it.
     */
    const far =
      beamed === null ||
      Math.abs(spot.x - beamed.x) >= LASER_MIN_MOVE ||
      Math.abs(spot.y - beamed.y) >= LASER_MIN_MOVE
    // On a closed socket the pointer frame is not queued: only the last point
    // matters, and it will go with the next movement, while the places in
    // the sixteen-message queue belong to presses.
    if (far && session.connected) {
      session.send({ t: 'laser', page, x: spot.x, y: spot.y, shape: laserShape })
      beamed = spot
    }
    lit = true
    spot = null
  }

  function beam(to: { x: number; y: number }, when: number): void {
    spot = to
    // For ourselves, at once, without waiting for a network round trip: one's
    // own pointer is compared with one's own hand, and the lag is visible
    // only here. The spring is stiff here: the samples are our own, a hundred
    // and twenty a second.
    aim(to.x, to.y, page, SPRING_HAND)
    if (spotTimer === undefined) spotTimer = window.setTimeout(beamNow, LASER_EVERY_MS)
  }

  /** The pointer was released or the tool changed: `laser:off` once, our own at once. */
  function beamOff(): void {
    window.clearTimeout(spotTimer)
    spotTimer = undefined
    spot = null
    beamed = null
    beaming = null
    if (lit) {
      lit = false
      session.send({ t: 'laser:off' })
      quietUntil = performance.now() + QUIET_AFTER_OFF_MS
    }
    // Our own, at once: waiting for the echo to put out OUR OWN pointer means
    // keeping it on screen one extra network round trip after the finger was
    // lifted. The trail stays behind to burn down: it is exactly what one
    // circles with the pointer for.
    douse(true)
    syncBusy()
  }

  /* ----------------------------------------------------------- eraser */

  /** Hit margin: otherwise a thin stroke cannot be caught with a moving pen. */
  const ERASE_REACH = 0.012
  /** How long erased strokes stay hidden if the server says nothing. */
  const ERASE_GRACE_MS = 1200
  let forgetTimer: number | undefined
  /** Where the eraser was at the previous sample: we erase by segment, not by point. */
  let rubbed: { x: number; y: number } | null = null
  /** Offline already reported for this sweep. Cleared when the eraser lifts. */
  let erasingTold = false

  /** Squared distance from a point to a segment. All in fractions of the page WIDTH. */
  function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax
    const dy = by - ay
    const len = dx * dx + dy * dy
    let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const qx = ax + t * dx - px
    const qy = ay + t * dy - py
    return qx * qx + qy * qy
  }

  function side(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
  }

  /**
   * Whether the eraser went over a stroke.
   *
   * Two checks, and both are needed. Intersection, because people erase with
   * a crosswise sweep, and all four ends of such a sweep are far from the
   * stroke. Distance from the ends, because people also erase lengthwise,
   * and with a short jab at a thick line, where there is no intersection at
   * all.
   */
  function crosses(
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number,
    reach: number,
  ): boolean {
    const s1 = side(cx, cy, dx, dy, ax, ay)
    const s2 = side(cx, cy, dx, dy, bx, by)
    const s3 = side(ax, ay, bx, by, cx, cy)
    const s4 = side(ax, ay, bx, by, dx, dy)
    // The eraser's ends are on different sides of the stroke, and the
    // stroke's ends on different sides of the eraser: that is a crosswise
    // intersection.
    if ((s1 > 0) !== (s2 > 0) && (s3 > 0) !== (s4 > 0)) return true
    const near = reach * reach
    return (
      toSegment(ax, ay, cx, cy, dx, dy) <= near ||
      toSegment(bx, by, cx, cy, dx, dy) <= near ||
      toSegment(cx, cy, ax, ay, bx, by) <= near ||
      toSegment(dx, dy, ax, ay, bx, by) <= near
    )
  }

  /**
   * Erase the strokes that were swept over.
   *
   * The WHOLE stroke is erased, not the pixels under the pen: the wire only
   * has "remove the stroke with this id", and pixel erasing would need a new
   * format and a rewrite of the whole lecture history for a gesture that is
   * made three times per class in a lecture.
   *
   * We count in fractions of the WIDTH: a fraction of the height on a wide
   * slide is a different centimetre, and the hit threshold would be skewed
   * along with the sheet.
   */
  function rub(from: { x: number; y: number }, to: { x: number; y: number }): void {
    if (w === 0 || h === 0) return
    /*
     * WITHOUT A CONNECTION THE ERASER DOES NOT ERASE, and says so.
     *
     * `ink:erase` is not one of the frames that are dropped on a closed
     * socket: it went into the control queue, one per stroke touched. Then
     * three things happened at once. The stroke vanished locally and came
     * back after 1.2 s (see `ERASE_GRACE_MS`), that is, the eraser looked
     * broken. The sixteen-message queue filled up with erases, pushing real
     * presses out of it. And when the Wi-Fi came back, it fired: strokes
     * vanished for the whole audience by themselves, with nobody doing it,
     * in the middle of the next slide. Exactly what "Undo" and "Erase page"
     * on the console call worse than a refusal, and are protected from
     * themselves.
     *
     * One refusal per gesture, not per stroke: the eraser crosses the paper
     * dozens of times a second, and a toast for every sweep is the same
     * noise, only in words.
     */
    if (!session.connected) {
      if (!erasingTold) {
        erasingTold = true
        onrefuse?.(tr('room.ui.274'))
      }
      return
    }
    const skew = h / w
    const ax = from.x
    const ay = from.y * skew
    const bx = to.x
    const by = to.y * skew
    /*
     * We erase both what the server has already confirmed and what is still
     * drying on the wet layer: a stroke drawn a second ago is visible on the
     * sheet, and an eraser passing through it looks broken. It already has
     * its id on the server: its points went out while it was being drawn.
     */
    const targets: { id: string; width: number; points: number[] }[] = [
      ...session.ink.filter((stroke) => stroke.page === page && !erased.has(stroke.id)),
      ...wet.filter(
        (stroke) =>
          stroke.page === page &&
          !erased.has(stroke.id) &&
          !session.ink.some((known) => known.id === stroke.id),
      ),
    ]
    const hit: string[] = []
    for (const stroke of targets) {
      const reach = Math.max(stroke.width, ERASE_REACH)
      const loX = Math.min(ax, bx) - reach
      const hiX = Math.max(ax, bx) + reach
      const loY = Math.min(ay, by) - reach
      const hiY = Math.max(ay, by) + reach
      const points = stroke.points
      const last = points.length / 2 - 1
      for (let i = 0; i <= last; i += 1) {
        const cx = points[i * 2]
        const cy = points[i * 2 + 1] * skew
        const nx = i < last ? points[i * 2 + 2] : cx
        const ny = i < last ? points[i * 2 + 3] * skew : cy
        // A cheap rejection by bounding box: a page has up to six hundred
        // strokes, and there is no point computing the full geometry of every
        // segment on every pen movement.
        if (Math.min(cx, nx) > hiX || Math.max(cx, nx) < loX) continue
        if (Math.min(cy, ny) > hiY || Math.max(cy, ny) < loY) continue
        if (!crosses(ax, ay, bx, by, cx, cy, nx, ny, reach)) continue
        hit.push(stroke.id)
        break
      }
    }
    if (hit.length === 0) return
    erased = new Set([...erased, ...hit])
    for (const id of hit) session.send({ t: 'ink:erase', page, id })
    // Otherwise the wet copy of what was erased would stay until the echo,
    // that is, for a network round trip a line would live on that was just
    // removed in front of everyone.
    const dried = wet.filter((stroke) => !hit.includes(stroke.id))
    if (dried.length !== wet.length) {
      wet = dried
      rememberWet()
    }
    window.clearTimeout(forgetTimer)
    forgetTimer = window.setTimeout(() => {
      // Time is up: what the server confirmed has already left the ink, and
      // what did not get through is more honest to show again than to leave
      // erased only for ourselves.
      erased = new Set()
    }, ERASE_GRACE_MS)
  }

  function stopErase(): void {
    erasing = null
    rubbed = null
    ring = null
    erasingTold = false
    wake()
    syncBusy()
  }

  /* ---------------------------------------------------- two-finger tap */

  /**
   * Two fingers briefly touching the sheet mean undo. As in Procreate.
   *
   * The only thing fingers on the sheet mean when there is a pen. Everything
   * else is the palm: it rests, creeps, lifts off and lands again, and any
   * other reading of fingers sooner or later fires from it. The conditions
   * are strict precisely for that reason: two touches within a quarter of a
   * second, both lifted within a third of a second, neither moved, the pen
   * not in contact and not touching the sheet in the last half second; a
   * palm does not behave like that while one writes.
   */
  const TAP_TOGETHER_MS = 250
  const TAP_HOLD_MS = 300
  const TAP_SLACK_PX = 12
  const TAP_AFTER_PEN_MS = 600
  interface Tap {
    pointer: number
    x: number
    y: number
    down: number
    up: number | null
    moved: boolean
  }
  let taps: Tap[] = []

  function tapDown(event: PointerEvent): void {
    const now = performance.now()
    taps = taps.filter((tap) => now - tap.down < 1000)
    taps.push({ pointer: event.pointerId, x: event.clientX, y: event.clientY, down: now, up: null, moved: false })
  }

  function tapMove(event: PointerEvent): void {
    const tap = taps.find((known) => known.pointer === event.pointerId)
    if (!tap || tap.moved) return
    if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_SLACK_PX) tap.moved = true
  }

  function tapUp(event: PointerEvent, cancelled: boolean): void {
    const now = performance.now()
    const tap = taps.find((known) => known.pointer === event.pointerId)
    // The lift arrives twice when there was a capture: pointerup and lostpointercapture.
    if (!tap || tap.up !== null) return
    if (cancelled) {
      taps = taps.filter((known) => known !== tap)
      return
    }
    tap.up = now
    if (drawing || now - lastPenAt < TAP_AFTER_PEN_MS) return
    const done = taps.filter((known) => known.up !== null && !known.moved)
    if (done.length < 2) return
    const [first, second] = done.slice(-2).sort((a, b) => a.down - b.down)
    if (second.down - first.down > TAP_TOGETHER_MS) return
    if ((first.up ?? 0) - second.down > TAP_HOLD_MS || (second.up ?? 0) - second.down > TAP_HOLD_MS) return
    taps = []
    onundo?.()
  }

  /* ----------------------------------------------------------- pointer */

  function capture(event: PointerEvent): void {
    /*
     * Pointer capture is an attempt, not a demand. A stroke that goes past
     * the sheet's edge must be drawn to the end rather than cut off at the
     * border; but capturing a pointer the browser no longer considers active
     * throws an exception, and the stroke would be cut off entirely.
     */
    try {
      inputNode?.setPointerCapture(event.pointerId)
    } catch {
      /* the pen has already been released: draw without capture */
    }
  }

  function down(event: PointerEvent): void {
    measure()
    // The heel of the palm is not a finger and does not count towards a
    // two-finger tap: a tap is two SMALL touches, while the heel plus the
    // little finger is exactly the pair that used to be taken for undo.
    if (event.pointerType === 'touch' && !palmish(event)) tapDown(event)
    if (!mine(event)) return
    const place = at(event)
    if (!place) return
    /*
     * Two fingers landed almost at once, the pen has not been found yet and
     * the finger draws: this is an undo tap, not two dots. The first finger
     * has already opened a stroke, but its points have not gone out yet (see
     * `openStroke`): the stroke is simply forgotten, and the second finger
     * opens no stroke. Previously the first put a dot and the second, on
     * lift, undid "the last stroke", and on the server that was a race
     * between the point just sent and the real previous stroke.
     */
    if (event.pointerType === 'touch' && drawing?.byFinger && drawing.stroke.sent === 0) {
      const first = taps.find((tap) => tap.pointer === drawing?.pointer)
      if (first && performance.now() - first.down <= TAP_TOGETHER_MS) {
        forgetUnsent()
        return
      }
    }
    event.preventDefault()
    capture(event)
    if (tool === 'laser') {
      // The beam is already led by another pointer: the pen takes it from a
      // finger (the pen always wins), a finger from the pen never. Otherwise
      // a second touch dragged the pointer's head to itself mid-show.
      if (beaming !== null && beaming !== event.pointerId) {
        if (event.pointerType === 'touch') return
      }
      // The first touch, at once: a pointer appearing forty milliseconds
      // after it was pressed feels stuck.
      beaming = event.pointerId
      aim(place.x, place.y, page, SPRING_HAND)
      spot = place
      beamNow()
      // And the pixel too, in this same handler, without waiting for a frame:
      // the pointer's cold start is measured from the press to the first red.
      paintLive(performance.now())
      syncBusy()
      return
    }
    if (tool === 'eraser') {
      erasing = event.pointerId
      ring = place
      rubbed = place
      rub(place, place)
      wake()
      syncBusy()
      return
    }
    /*
     * One stroke. A second pen on the same sheet does not happen; a mouse on
     * top of a pen is the test bench: the second pointer waits. But a pen on
     * top of a FINGER does not wait: until a pen has been seen on this
     * screen, a finger draws, and the first thing to land on the sheet is the
     * palm. The stroke it started gets closed; without that the pen was
     * locked out until the palm was lifted, that is, the whole time one
     * writes.
     */
    if (drawing) {
      if (event.pointerType === 'touch' || !drawing.byFinger) return
      closeStroke()
    }
    /*
     * THE PAGE IS FULL: THE STROKE DOES NOT OPEN AT ALL.
     *
     * At the 601st stroke (and at the 201st inked page) the server returns
     * `null` and sends nothing. The layer could not tell that from a lost
     * frame: it dutifully resent the stroke WHOLE every half second (up to
     * ten frames of four hundred numbers, eight times) and only then removed
     * it from the sheet. On the console it looked like this: a line was
     * drawn, hung for four seconds and vanished; the next one likewise; the
     * audience never had it at all. On a blank sheet six hundred strokes add
     * up over one long derivation of a formula; a letter is one to three
     * strokes.
     *
     * The refusal is here, BEFORE the first point: a line the audience will
     * not have must not appear for the presenter either. The words are not
     * "the same ones the server would give" but literally the server's:
     * `inkFullSays` from shared is one for both ends, and the server answers
     * with it too (control.ts · `case 'ink'`).
     */
    const full = inkRefusal(session.ink, wet, page)
    if (full) {
      onrefuse?.(inkFullSays(full))
      return
    }
    openStroke(event.pointerId, event.pointerType === 'touch', place, event.pressure)
  }

  /** The event's samples: the coalesced ones, if the browser provides them. */
  function samples(event: PointerEvent): PointerEvent[] {
    /*
     * `getCoalescedEvents` is what sets a pen apart from a mouse: between two
     * frames Pencil manages to report a dozen positions, and a line built
     * from frames alone comes out faceted on a fast movement. The existence
     * check is not a formality: in Safari the method appeared only in 18.2,
     * and people draw on older tablets too.
     */
    const steps = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
    return steps.length > 0 ? steps : [event]
  }

  /** Where the pen will be in ten milliseconds: from the browser or from velocity. */
  function foresee(event: PointerEvent, stroke: Wet): { x: number; y: number } | null {
    const told = typeof event.getPredictedEvents === 'function' ? event.getPredictedEvents() : []
    if (told.length > 0) return at(told[told.length - 1])
    const points = stroke.points
    const count = points.length / 2
    if (count < 3) return null
    const ax = points[count * 2 - 2]
    const ay = points[count * 2 - 1]
    const bx = points[count * 2 - 6]
    const by = points[count * 2 - 5]
    // The average step over the last two samples, and exactly one such step
    // ahead: that is the "ten milliseconds" at Pencil's rate. No further: a
    // prediction that overtakes the hand sticks out like a whisker on a turn.
    return { x: round(ax + (ax - bx) / 2), y: round(ay + (ay - by) / 2) }
  }

  function move(event: PointerEvent): void {
    if (event.pointerType === 'touch') tapMove(event)
    /*
     * The pen is alive while it moves, not only while it goes down: the "pen
     * seen" time used to be set only on touch, and after a stroke lasting a
     * second and a half the two-finger tap guard thought there had been no
     * pen for a second and a half: the heel and the little finger, landing
     * 120 ms after a letter, undid it for the whole audience. Only IN
     * CONTACT: Pencil hovers above the glass the whole time the hand is over
     * the tablet, and hovering does not count, otherwise two fingers would
     * never undo anything.
     */
    if (event.buttons !== 0) penSeen(event)
    // One's own stroke continues with its own pointer, whatever changes
    // around it: a spring-loaded pointer on a key does not cut a letter off
    // in the middle.
    if (drawing && drawing.pointer === event.pointerId) {
      event.preventDefault()
      for (const step of samples(event)) {
        const place = at(step)
        if (!place) continue
        addPoint(place, step.pressure)
      }
      if (!drawing) return
      // The line under the pen: in this same frame, not after a round trip to the server.
      growWet(drawing.stroke)
      const ahead = foresee(event, drawing.stroke)
      const points = drawing.stroke.points
      guess = ahead
        ? {
            fromX: points[points.length - 2],
            fromY: points[points.length - 1],
            x: ahead.x,
            y: ahead.y,
            color: drawing.stroke.color,
            width: drawing.stroke.width,
          }
        : null
      wake()
      measureLatency(event.timeStamp)
      schedule()
      return
    }
    if (!mine(event)) return
    if (tool === 'laser') {
      /*
       * HOVERING NO LONGER SHINES.
       *
       * Previously a Pencil brought to the glass already led the beam across
       * the projector: the hand moves to the sheet, and the audience sees a
       * red line nobody was pointing with. Now hovering shows only ONE'S OWN
       * shadow (grey, like the pen's), and the beam is lit by touch, the same
       * motion with which one picks up a real pointer and presses its button.
       */
      const hover = event.buttons === 0
      if (hover) {
        if (event.pointerType === 'touch') return
        const place = at(event)
        if (!place) return
        ring = place
        wake()
        return
      }
      if (beaming !== event.pointerId) return
      if (ring) ring = null
      event.preventDefault()
      for (const step of samples(event)) {
        const place = at(step)
        if (place) beam(place, step.timeStamp)
      }
      return
    }
    /*
     * The pen and marker shadow is the same as the eraser ring: a spot
     * exactly where the stroke will land, and exactly as wide. Without it a
     * Pencil on the tablet "misses the line": there is no cursor on glass,
     * and until the first touch one cannot see where the tip is. IN CONTACT
     * it is not there: the stroke itself is already there, and a second mark
     * under the pen would get in the way of looking at the letter (for the
     * eraser it is the other way round: the ring is its working area, which
     * is why it stays).
     */
    if (tool === 'pen' || tool === 'marker') {
      // A finger neither moves nor puts out the shadow: otherwise a palm
      // resting on the sheet would knock the shadow of a pen hovering nearby
      // with its every tremor.
      if (event.pointerType === 'touch') return
      const place = event.buttons === 0 ? at(event) : null
      if (!place) {
        if (ring) {
          ring = null
          wake()
        }
        return
      }
      ring = place
      wake()
      return
    }
    if (tool === 'eraser') {
      const place = at(event)
      if (!place) return
      ring = place
      if (erasing === event.pointerId) {
        event.preventDefault()
        for (const step of samples(event)) {
          const where = at(step)
          if (!where) continue
          rub(rubbed ?? where, where)
          rubbed = where
        }
      }
      wake()
    }
  }

  function up(event: PointerEvent): void {
    if (event.pointerType === 'touch') tapUp(event, event.type === 'pointercancel')
    penSeen(event)
    if (drawing && drawing.pointer === event.pointerId) {
      if (event.type === 'pointerup') {
        const place = at(event)
        if (place) {
          addPoint(place, event.pressure)
          if (drawing) growWet(drawing.stroke)
        }
      }
      closeStroke()
      return
    }
    if (beaming === event.pointerId) {
      /*
       * The pen was lifted: the beam is off, and without any burn-down:
       * hovering no longer picks it up, so there is nothing left to put out
       * "just in case after 300 ms". The circled shape stays standing,
       * though: see `douse`.
       */
      beamOff()
      return
    }
    if (erasing === event.pointerId) {
      stopErase()
      return
    }
  }

  /**
   * The pen left the sheet without pressing: put out what lived from
   * hovering, the eraser ring and the hovering pointer. The stroke is NOT
   * closed here: it has a capture and lives until the pen is lifted; it used
   * to be closed here, and a stroke that went past the margin was cut off at
   * the edge.
   */
  function leave(event: PointerEvent): void {
    if (drawing && drawing.pointer === event.pointerId) return
    if (beaming === event.pointerId) return
    if (erasing === event.pointerId) return
    if (ring) {
      ring = null
      wake()
    }
    // The beam is lit only by touch, so a hovering pen leaving does not
    // concern it: there is nothing to put out, and the circled shape holds by
    // itself.
  }

  /*
   * The tool changed, the sheet was taken away or the role changed
   * mid-stroke.
   *
   * An open stroke is closed, not erased: the pen lift will no longer reach
   * it through another tool, and there would be nobody to close the stroke.
   * Switching to and from the pointer does NOT touch the stroke: the
   * spring-loaded pointer on a key lights up in the middle of a letter, and
   * the letter must be finished with its own pen.
   */
  let wasTool: Props['tool'] | null = null
  $effect(() => {
    const now = tool
    const on = live
    untrack(() => {
      const before = wasTool ?? now
      wasTool = now
      if (!on || now === 'off') {
        closeStroke()
        if (erasing !== null || ring) stopErase()
        beamOff()
        taps = []
        return
      }
      if (now !== 'laser' && before !== 'laser' && now !== before) closeStroke()
      if (now !== 'laser') beamOff()
      if (now !== 'eraser' && (erasing !== null || ring)) stopErase()
    })
  })

  // The parent turned the finger off (a pen was found): the finger's stroke is finished.
  $effect(() => {
    const on = finger
    untrack(() => {
      if (!on && drawing?.byFinger) closeStroke()
    })
  })

  /*
   * The page was turned while the pen is still down.
   *
   * This happens not only because of the palm: pages are turned from the
   * clicker, with an arrow key, and by a second teacher from a laptop. The
   * stroke is closed on the OLD page (that is where it is drawn, and where
   * its points have already gone), and the pen on the new sheet starts from
   * a clean spot. The pointer on a new page starts afresh.
   */
  $effect(() => {
    const now = page
    untrack(() => {
      if (drawing && drawing.stroke.page !== now) closeStroke()
      // The page changed: the previous one's trail does not melt before one's
      // eyes but leaves together with it; on the new sheet it has nowhere to
      // come from.
      if ((head && head.page !== now) || marks.some((mark) => mark.page !== now)) {
        if (head && head.page !== now) head = null
        marks = marks.filter((mark) => mark.page === now)
        wake()
      }
    })
  })

  /*
   * The input layer is the only owner of touches on the sheet.
   *
   * `touch-action: none` in CSS does not cancel the system's text selection
   * under the palm or the magnifier on a long press; only `preventDefault`
   * on a NON-passive `touchstart` cancels them. Svelte attaches touch
   * listeners as passive, hence by hand. Along with it, a size observer: the
   * sheet's rect is cached, and the sheet moves when the tablet rotates and
   * when the notes slide out.
   */
  $effect(() => {
    const node = inputNode
    if (!node) return
    const swallow = (event: TouchEvent): void => {
      if (event.cancelable) event.preventDefault()
    }
    node.addEventListener('touchstart', swallow, { passive: false })
    node.addEventListener('touchmove', swallow, { passive: false })
    const watch = new ResizeObserver(() => measure())
    watch.observe(node)
    return () => {
      node.removeEventListener('touchstart', swallow)
      node.removeEventListener('touchmove', swallow)
      watch.disconnect()
    }
  })

  /* ------------------------------------------------------ measurement */

  /**
   * "Sample → pixel" latency for the test bench: a ring buffer in
   * `window.__inkLat`.
   *
   * Measured from the timestamp of the last sample to the frame after the
   * increment and on to the macrotask after it, that is, to the moment the
   * browser handed the frame to the compositor. The bench reads p50/p95. Not
   * disabled in the build: the bench drives precisely the build, and the
   * price is one frame callback per pen event.
   */
  const LAT_SIZE = 128
  let latencies: number[] = []
  function measureLatency(stamp: number): void {
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        latencies.push(performance.now() - stamp)
        if (latencies.length > LAT_SIZE) latencies = latencies.slice(-LAT_SIZE)
      }, 0)
    })
  }
  if (typeof window !== 'undefined') {
    const quantile = (q: number): number => {
      if (latencies.length === 0) return 0
      const sorted = [...latencies].sort((a, b) => a - b)
      return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    }
    ;(window as unknown as { __inkLat: unknown }).__inkLat = {
      get samples(): number[] {
        return latencies
      },
      p50: () => quantile(0.5),
      p95: () => quantile(0.95),
      reset: () => {
        latencies = []
      },
      get head(): { x: number; y: number; at: number } | null {
        return shownHead
      },
    }
  }

  // The tab was closed mid-stroke: we take the timers with us.
  $effect(() => () => {
    window.clearTimeout(flushTimer)
    window.clearTimeout(spotTimer)
    window.clearTimeout(settleTimer)
    window.clearTimeout(forgetTimer)
    if (liveFrame !== undefined) cancelAnimationFrame(liveFrame)
    /*
     * And tell the outside that the pointer is released.
     *
     * The ink layer disappears entirely (the lecture ended, the tablet went
     * into Split View), and if it leaves silently, the parent is left with
     * "pen on the sheet" forever. And by that sign the console swallows
     * finger touches so that the palm does not press buttons: the whole
     * console goes dead to the finger, including the document picker screen,
     * and the only way out is a reload.
     */
    if (busy) {
      busy = false
      onbusy?.(false)
    }
  })

  const cursor = $derived(tool === 'laser' || tool === 'eraser' ? 'none' : 'crosshair')
</script>

<!--
  The canvases are exactly the size of the page; the input layer covers the
  whole sheet box, `reach` beyond the page on each side, margins included. It
  is always `touch-action: none` and without selection, not only when there
  is something to draw with: margins given away to the system are a palm
  that selects and scrolls the sheet in the middle of writing. It catches
  the pointer only for the presenter with a tool: for the audience a live
  page lies under it.

  The canvases never catch the pointer: only the input layer takes input.
-->
<div class="pointer-events-none absolute inset-0">
  <div class="ink-page absolute inset-0" style="width: {w}px; height: {h}px">
    <canvas bind:this={dryCanvas} class="ink ink-dry absolute inset-0 h-full w-full select-none"></canvas>
    <canvas bind:this={wetCanvas} class="ink ink-wet absolute inset-0 h-full w-full select-none"></canvas>
    <canvas bind:this={liveCanvas} class="ink ink-live absolute inset-0 h-full w-full select-none"></canvas>
  </div>
  <div
    bind:this={inputNode}
    class="ink ink-input absolute {live && tool !== 'off' ? 'pointer-events-auto' : ''}"
    style="cursor: {cursor}; top: {-reach.top}px; right: {-reach.right}px; bottom: {-reach.bottom}px; left: {-reach.left}px"
    role="application"
    aria-label={tr('room.ui.273')}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onlostpointercapture={up}
    onpointerleave={leave}
  ></div>
</div>

<style>
  /*
   * A long press on iPad brings up the system magnifier and the "copy" menu,
   * over the page, in the middle of a lecture. Only WebKit properties cancel
   * it: an unprefixed `touch-callout` does not exist at all, and the grey
   * flash on touch is `-webkit-tap-highlight-color`, which blinks at every
   * point of a stroke.
   */
  .ink {
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    -webkit-user-select: none;
  }
  /*
   * `touch-action: none` always, not only while there is something to draw
   * with: without it the very first stroke scrolls the page instead of
   * drawing a line, and a palm on the margins starts a system selection,
   * which cannot be allowed on a drawing sheet.
   */
  .ink-input {
    touch-action: none;
  }
</style>
