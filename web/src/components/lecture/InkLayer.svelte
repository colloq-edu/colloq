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

  And a fourth UNDER them, for the highlighter (`ink-mark`): every
  translucent stroke, the room's and one's own, on a canvas blended with
  `multiply`. A highlighter belongs under the writing: on paper the text
  shows black through the yellow. Drawn among the pen strokes, a marker
  greyed the slide's text and covered the presenter's own formula on the
  projector. Below the pen ink and multiplied with the slide, text stays
  crisp under it, and no marker can cover a pen line, whichever came first.
  On a dark page `multiply` can only darken the dark, and the highlight
  vanished: there LecturePage marks itself `data-ink-backdrop="dark"` from
  what it painted and switches this canvas to `screen`, the same idea turned
  over (light text stays light, the band glows on the dark ground).

  THE ZOOM (`zoom`, zoom.ts): the page may be magnified inside its frame, the
  same region on every screen. Every canvas is PAINTED at `zoom.painted`: the
  zoom folds into `fitTo`'s transform and nowhere else, so all the geometry
  stays page fractions times the sheet size. While the view is on its way
  somewhere, each canvas is MOVED by `zoom.css`, exactly like the page's own
  bitmap; once it rests, both are painted again, sharp, together. What is
  about the hand rather than the page keeps its size on the glass under a
  zoom: the eraser ring, the pointer, the pen's shadow, the thresholds for a
  step, a dot, a palm. A new stroke keeps its look too: its width is divided
  by the zoom (ink.ts · `inkWidthAt`).

  THE PALM IS NOT AN EVENT. The layer used to hand a "foreign" finger to the
  parent, which read it as a swipe, and two fingers as "this stroke never
  happened", erasing what had been started. The heel of the palm and the
  little finger are exactly two fingers, and the palm rests on the tablet the
  whole time one writes: the third of three quick strokes did not get drawn.
  Now the only owner of touches on the sheet is this layer, and a finger,
  when there is a pen, means nothing except two gestures of two fingers: a
  tap is Undo, a pinch or a two-finger drag moves the zoom (see `pinch`).
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { untrack } from 'svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { inkFullSays, LASER_EVERY_MS, sameZoom, type InkStroke, type LectureZoom } from '@shared/lecture'
  import {
    askInkPage,
    ERASER_PX,
    eraserReach,
    fingerPair,
    FRAME_TAP_PX,
    frameZoom,
    hearInkNeed,
    HOLD_RING_AFTER_MS,
    holdRingAt,
    inkWidthAt,
    isDot,
    layCurve,
    mayTakeBack,
    pinchCommits,
    pinchMayStart,
    pinchZoom,
    STRAIGHT_HOLD_MS,
    STRAIGHT_STILL_PX,
    straightens,
    TAP_TOGETHER_MS,
    twoFingerTap,
    type FingerPair,
    type HoldRing,
    type Tap,
  } from './ink'
  import {
    HeardPhrases,
    hearLaser,
    LASER_DELAY_MS,
    LASER_RED,
    LaserPlayback,
    LaserPress,
    MARK_MAX_SAMPLES,
    MARKS_MAX,
    newMarkId,
    PHRASE_WIRE_MS,
    PhraseClock,
    phraseGlow,
    phraseOver,
    phrasesOf,
    type LaserAt,
    type LaserSample,
  } from './laser'
  import { inkRefusal } from './pult'
  import { boxToPage, visibleRect, WHOLE, type ZoomView } from './zoom'

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
    /**
     * What we draw with now: pen, marker, eraser, pointer, or the magnifier
     * (`zoom`: a frame dragged on the sheet becomes the view, see `framing`).
     */
    tool: 'pen' | 'marker' | 'eraser' | 'laser' | 'zoom' | 'off'
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
     * The zoom the page is shown at, as the page hands it to its `over`
     * snippet (zoom.ts · `ZoomView`): the zoom the canvases are painted at,
     * the zoom the hall sees now, and the transform between the two. The
     * whole page when absent.
     */
    zoom?: ZoomView
    /**
     * The presenter moved the zoom on the sheet: a pinch (`final` false while
     * the fingers move, true once they lift) or the magnifier's frame (always
     * `final`). `null` is the whole page.
     *
     * Not passed, nothing on the sheet zooms: the projector, the audience and
     * the laptop column FOLLOW the zoom, they do not move it.
     */
    onzoom?: (zoom: LectureZoom | null, final: boolean) => void
    /**
     * Whether a pen stroke held still at its end straightens into a line
     * (see `straightenNow`). On unless the parent turns it off.
     */
    straighten?: boolean
    /**
     * Whether to show the hold ring: a ring that closes round the pen's tip
     * while a stroke that would straighten is held still, and is full at the
     * moment it does (see `holdShown`). The console's, and only the
     * console's: it is about the hand on this glass, the hall never sees it
     * and nothing of it goes down the wire. Off unless the parent turns it
     * on, so the projector, the audience and the laptop column never draw it.
     */
    holdRing?: boolean
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
    zoom = WHOLE,
    onzoom,
    straighten = true,
    holdRing = false,
    onbusy,
    onundo,
    onpen,
    onrefuse,
  }: Props = $props()
  const session = getSessionState()

  let markerCanvas = $state<HTMLCanvasElement | null>(null)
  let dryCanvas = $state<HTMLCanvasElement | null>(null)
  let wetCanvas = $state<HTMLCanvasElement | null>(null)
  let liveCanvas = $state<HTMLCanvasElement | null>(null)
  let frameNode = $state<HTMLDivElement | null>(null)
  let inputNode = $state<HTMLDivElement | null>(null)

  /**
   * The zoom the canvases are painted at, as a key. Its change is the reason
   * to repaint every canvas whole; the transform that moves them meanwhile
   * (`zoom.css`) costs nothing and repaints nothing.
   */
  const paintedKey = $derived(zoom.painted ? `${zoom.painted.x},${zoom.painted.y},${zoom.painted.z}` : '')
  /**
   * How many times closer the canvases are painted: everything about the
   * hand is divided by it to keep its size on the glass (see the header).
   */
  const near = $derived(zoom.painted?.z ?? 1)

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
   * frame shows on it as flicker, and there is no gain whatsoever. Nor for
   * the marker canvas: it is blended with the page, and a canvas the browser
   * may hand straight to the display is one it may not blend.
   *
   * THE ZOOM LIVES HERE AND NOWHERE ELSE. The bitmap stays the size of the
   * sheet (memory does not grow with the zoom), and the transform maps the
   * page so that the region `zoom.painted` fills it, exactly as the page's
   * own picture is rendered (LecturePage, `getViewport` with an offset).
   * Every path is still built from fractions times `w` and `h`, so the wet
   * line's incremental tail, the pointer's laid body and every cache keyed on
   * the sheet size hold under any zoom.
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
    const view = zoom.painted
    const k = ratio * (view?.z ?? 1)
    paint.setTransform(k, 0, 0, k, -(view?.x ?? 0) * w * k, -(view?.y ?? 0) * h * k)
    paint.lineCap = 'round'
    paint.lineJoin = 'round'
    paint.globalAlpha = 1
    return { paint, blank }
  }

  /**
   * Clear the whole bitmap, in device pixels. Not through the page
   * transform: under a zoom it maps the page past the canvas's edges, and
   * "clear the page" is then a rectangle somewhere off to the side.
   */
  function wipe(paint: CanvasRenderingContext2D): void {
    paint.save()
    paint.setTransform(1, 0, 0, 1, 0, 0)
    paint.clearRect(0, 0, paint.canvas.width, paint.canvas.height)
    paint.restore()
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
   * The curve itself is laid by `layCurve` (ink.ts), and so is the pointer's:
   * all three canvases and the pointer build their lines with it, otherwise
   * the line would twitch at the moment one replaces another.
   */
  function trace(paint: CanvasRenderingContext2D, points: number[], px: number, py: number): void {
    const count = points.length / 2
    paint.beginPath()
    layCurve(paint, points, count, 0, px, py)
    paint.lineTo(points[(count - 1) * 2] * px, points[(count - 1) * 2 + 1] * py)
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
    // At least a pixel of the screen, which under a zoom is a fraction of a
    // pixel of the page; and a dot is a dot by what the screen shows.
    const line = Math.max(1 / near, thick * px)
    if (isDot(points, px * near, py * near)) {
      /*
       * A tap: one spot, however many numbers it took (see `isDot`). A path
       * of zero length draws nothing, and the dot on an i vanished with the
       * echo; a circle draws it.
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

  /** What a stroke belongs to: its motion of the pen (see `InkStroke.group`). */
  function groupOf(stroke: { id: string; group?: string }): string {
    return stroke.group ?? stroke.id
  }

  /**
   * Strokes, with the pieces of one TRANSLUCENT motion drawn as one path,
   * motion by motion in the order they began.
   *
   * A motion longer than the point ceiling is several strokes (see
   * `InkStroke.group`), and two marker pieces stroked apart overlap at the
   * joint with doubled alpha: a dark blot in the middle of a highlighted line.
   * An opaque pen does not care, and draws stroke by stroke. The pieces are
   * gathered by motion wherever they stand in the list: someone else's
   * stroke may arrive between two pieces of a long highlight.
   */
  function drawRuns(
    paint: CanvasRenderingContext2D,
    strokes: readonly Pick<InkStroke, 'id' | 'group' | 'color' | 'width' | 'points'>[],
    px: number,
    py: number,
  ): void {
    const runs = new Map<string, { color: string; width: number; points: number[] }>()
    for (const stroke of strokes) {
      if (!seeThrough(stroke.color)) {
        drawStroke(paint, stroke.points, stroke.color, stroke.width, px, py)
        continue
      }
      const run = runs.get(groupOf(stroke))
      if (run) run.points = [...run.points, ...stroke.points]
      else runs.set(groupOf(stroke), { color: stroke.color, width: stroke.width, points: stroke.points })
    }
    for (const run of runs.values()) drawStroke(paint, run.points, run.color, run.width, px, py)
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
    // Still one spot (a Pencil pressed and not yet moved): a dot, not
    // zero-length segments the canvas would drop.
    if (last === 0 || isDot(points, w * near, h * near)) {
      drawStroke(paint, points, tint, thick, w, h)
      Object.assign(tail, tailOf(points))
      return
    }
    paint.strokeStyle = tint
    paint.lineWidth = Math.max(1 / near, thick * w)
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
   * Erased ids the room's ink has been seen holding since the hit.
   *
   * Once such a stroke leaves the ink, the server has confirmed the erase and
   * the id need not be hidden any more: if Undo brings the stroke back, it
   * must show at once rather than when the grace timer runs out. An id the ink
   * has NOT held yet (a wet stroke erased before its echo) stays hidden: its
   * echo is still on the way, and showing it would be a flash.
   */
  const erasedSeen = new Set<string>()
  /**
   * Hidden ids the grace timer must not bring back: the freehand pieces a
   * straight line is replacing while the pen still holds it (see
   * `straightenNow`). The room keeps them until the pen lifts, so the server
   * cannot confirm anything yet, and a second and a half of holding the line
   * must not resurrect the wobbly original under it.
   */
  const withheld = new Set<string>()

  $effect(() => {
    void session.inkRevision
    untrack(() => {
      if (erased.size === 0) return
      const present = new Set(session.ink.map((stroke) => stroke.id))
      const keep = new Set<string>()
      for (const id of erased) {
        if (present.has(id)) erasedSeen.add(id)
        if (present.has(id) || !erasedSeen.has(id)) keep.add(id)
        else erasedSeen.delete(id)
      }
      if (keep.size !== erased.size) erased = keep
    })
  })

  /**
   * What lies on the dry canvas, by stroke id.
   *
   * By this map the echo is applied incrementally: a new stroke in full, a
   * grown one only by its new piece. A full repaint remains for the cases
   * when pixels must be REMOVED or reordered: a stroke vanished (undo,
   * eraser, clearing), a stroke came back under others (undo of an erase), the
   * page changed, the size changed, the zoom was painted anew.
   *
   * Opaque strokes only. A marker cannot be laid down in pieces (see
   * `drawStroke`), and it used to cost this canvas a full repaint per echo
   * batch, or a detour through the wet canvas while it grew; now every
   * translucent stroke lives on the marker canvas (`paintMarkers`), and this
   * one never has to take a stroke back out.
   */
  const drawn = new Map<string, Tail>()
  let drawnPage = Number.NaN
  /** The zoom the dry canvas was painted at (`paintedKey`). */
  let drawnAt = ''

  $effect(() => {
    const node = dryCanvas
    // Read the edit counter: it is the very reason to repaint.
    void session.inkRevision
    void paintedKey
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
      (stroke) =>
        stroke.page === now && !hidden.has(stroke.id) && !gone.has(stroke.id) && !seeThrough(stroke.color),
    )
    let full = ready.blank || drawnPage !== now || drawnAt !== paintedKey
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
      /*
       * A stroke that is not on the canvas yet, lying UNDER one that is: an
       * erased stroke brought back by Undo. Laid on top it would cover what
       * was drawn over it; the order is the page's, so the page is repainted.
       */
      let newestKnown = -1
      visible.forEach((stroke, index) => {
        if (drawn.has(stroke.id)) newestKnown = index
      })
      for (let i = 0; i < newestKnown; i += 1) {
        if (!drawn.has(visible[i].id)) {
          full = true
          break
        }
      }
    }
    if (full) {
      wipe(paint)
      drawn.clear()
      drawnPage = now
      drawnAt = paintedKey
      for (const stroke of visible) {
        drawStroke(paint, stroke.points, stroke.color, stroke.width, w, h)
        drawn.set(stroke.id, tailOf(stroke.points))
      }
    } else {
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
  }

  /* --------------------------------------------------- marker canvas */

  /**
   * What the marker canvas holds now, as a key: the strokes with their
   * lengths and ends, the page, the size, the zoom. The room's ink changes
   * twenty times a second while someone writes with a PEN, and that is no
   * reason to repaint the highlights. The end is in the key because one's
   * own marker can change without growing: its predicted tip moves, and a
   * straight line's end follows the pen.
   */
  let markersDrawn = ''

  /** The translucent strokes of the page as they should look now: the room's, and one's own still drying. */
  function markersHere(): Pick<InkStroke, 'id' | 'group' | 'color' | 'width' | 'points'>[] {
    const out: Pick<InkStroke, 'id' | 'group' | 'color' | 'width' | 'points'>[] = session.ink.filter(
      (stroke) =>
        stroke.page === page && seeThrough(stroke.color) && !wetIds.has(stroke.id) && !erased.has(stroke.id),
    )
    for (const stroke of wet) {
      if (stroke.page !== page || !seeThrough(stroke.color) || erased.has(stroke.id)) continue
      /*
       * The predicted tip of one's own marker is part of ITS path, not a
       * second stroke on the live canvas: two translucent strokes overlapping
       * at the round end used to darken into a blot that ran ahead of the
       * pen. Here it costs nothing, the canvas is repainted whole anyway.
       */
      const ahead = drawing?.stroke === stroke && guess ? [...stroke.points, guess.x, guess.y] : stroke.points
      out.push({ id: stroke.id, group: stroke.group, color: stroke.color, width: stroke.width, points: ahead })
    }
    return out
  }

  /**
   * THE HIGHLIGHTER'S CANVAS: every translucent stroke of the page, under
   * the pen ink, blended with the page by `multiply` (see the header).
   *
   * Repainted WHOLE on every change. A translucent stroke cannot be laid in
   * pieces (the joints would darken), and highlights on a page are few, so
   * one canvas repainted whole is both the simplest and the cheapest: no
   * stroke has to be taken out of a canvas that also holds the pen's ink. An
   * empty one gives its bitmap back: a page-sized canvas per screen is the
   * scarcest thing on an iPad (one canvas budget per process), and most
   * pages have no highlight at all.
   */
  function paintMarkers(): void {
    const node = markerCanvas
    if (!node) return
    const strokes = w > 0 && h > 0 ? markersHere() : []
    if (strokes.length === 0) {
      if (node.width !== 1 || node.height !== 1) {
        node.width = 1
        node.height = 1
      }
      markersDrawn = ''
      return
    }
    const key =
      `${page}|${w}x${h}|${paintedKey}|` +
      strokes
        .map((stroke) => {
          const n = stroke.points.length
          return `${stroke.id}:${n}:${stroke.points[n - 2]},${stroke.points[n - 1]}`
        })
        .join(',')
    const ready = fitTo(node, false)
    if (!ready) return
    if (!ready.blank && key === markersDrawn) return
    wipe(ready.paint)
    drawRuns(ready.paint, strokes, w, h)
    markersDrawn = key
  }

  $effect(() => {
    void markerCanvas
    void session.inkRevision
    void wetIds
    void erased
    void page
    void w
    void h
    void paintedKey
    untrack(() => paintMarkers())
  })

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
    /**
     * How many of the stroke's numbers have been handed to the socket.
     *
     * Every piece says where it starts (`from` on the wire), and this is that
     * position: the next piece starts here, and a resend starts where the
     * server's copy ends, so neither can be appended twice. It is also how the
     * wet stroke recognises its echo.
     */
    handed: number
    /** The first piece's id when this stroke continues one long motion (see `InkStroke.group`). */
    group?: string
    /** When the stroke was opened: a young finger stroke is the palm (see `dropPalm`). */
    bornAt: number
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
    /**
     * A straight line still held under the pen (see `straightenNow`): its end
     * follows the pen, so nothing of it goes out until the lift.
     */
    straight?: boolean
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

  /** The zoom the wet canvas was painted at: a stroke cannot grow onto a canvas painted at another. */
  let wetAt = ''

  /**
   * The whole wet canvas, only when the LIST of wet strokes has changed: a
   * stroke landed on the dry one, the page was turned, the sheet changed
   * size, the zoom was painted anew. One's own pen movement is put on the
   * canvas by `growWet` right from the handler; neither the pointer nor the
   * ring is here: they live on the live canvas and do not compete with the
   * ink for a frame. One's own markers are not here either: they lie under
   * the ink, on the marker canvas.
   */
  function paintWetAll(): void {
    const node = wetCanvas
    if (!node || w === 0 || h === 0) return
    const ready = fitTo(node, true)
    if (!ready) return
    const paint = ready.paint
    wipe(paint)
    wetAt = paintedKey
    for (const stroke of wet) {
      if (stroke.page !== page || seeThrough(stroke.color)) continue
      drawStroke(paint, stroke.points, stroke.color, stroke.width, w, h)
      stroke.tail = tailOf(stroke.points)
    }
  }

  $effect(() => {
    void wetIds
    void page
    void w
    void h
    void paintedKey
    void wetCanvas
    untrack(() => paintWetAll())
  })

  /** One's own stroke under the pen: incrementally, in this same frame. */
  function growWet(stroke: Wet): void {
    /*
     * The marker is translucent and must be one `stroke()`: its canvas is
     * rebuilt (see `paintMarkers`). Highlights on a page are few, so this is
     * cheap, and there is no other way.
     */
    if (seeThrough(stroke.color)) {
      paintMarkers()
      return
    }
    const node = wetCanvas
    if (!node || w === 0 || h === 0) return
    const ready = fitTo(node, true)
    if (!ready) return
    // A straight line's end moves rather than grows: it is drawn anew.
    if (ready.blank || wetAt !== paintedKey || stroke.straight) {
      paintWetAll()
      return
    }
    growPath(ready.paint, stroke.points, stroke.color, stroke.width, stroke.tail)
  }

  /* ---------------------------------------------------- live canvas */

  /*
   * How long the trail holds WHOLE and how long it fades.
   *
   * With the pointer one circles a shape and talks about it: "this area".
   * While they talk, the shape must stand, all of it, rather than melt from
   * the tail. So the trail has two phases: it holds at full strength after
   * the pen is lifted, and then fades WHOLE. Individual points have no age,
   * and a shape that is being drawn has no length limit to be cut to: both
   * the old "each point lives its 1.2 s" and the later "the last six hundred
   * frame-points" ate the start of the shape while the hand was still drawing
   * it, the "unwinding" from the lecture hall. The fading is by time and only
   * after the release; the one safety net for a press held over a minute is
   * in laser.ts (`MARK_MAX_SAMPLES`), and it, too, lets the old shape go whole
   * instead of shortening it.
   *
   * And not each shape by itself: by PHRASE (laser.ts · `PHRASE_HOLD_MS`).
   * People do not circle with the pointer in a single flourish: they
   * underline a line, then circle a formula, then write a word with it. While
   * each shape lived out its life alone, a word written with the pointer
   * melted from its first letter while its last was being written. Shapes
   * pressed in a row now hold together while the hand keeps going and go out
   * together once it stops; the ceiling (`MARKS_MAX`) keeps the slide from
   * turning into ink over a class.
   */

  /**
   * A shape's path in canvas px, laid piece by piece as samples come.
   *
   * The shape is the samples themselves, drawn with the ink's curve
   * (`layCurve`): no refinement, no thinning. The body is extended, never
   * rebuilt, so a long shape costs a frame as much as a short one to BUILD;
   * what it costs to stroke is the length of the line, the same on every
   * screen.
   */
  interface Trail {
    w: number
    h: number
    body: Path2D
    laid: number
    count: number
  }
  /**
   * A released shape, rendered once into a canvas the size of its bounds.
   *
   * While it holds and fades, its geometry no longer changes, and stroking it
   * twice a frame (halo and core) for nearly two seconds was the most
   * expensive idle work on a projector with a software rasteriser. A blit
   * with `globalAlpha` costs the area of the shape, once.
   *
   * `canvas` is `null` when nothing of the shape can be seen (a zoom has
   * left it off the sheet): there is nothing to blit and nothing to stroke.
   */
  interface Bake {
    canvas: HTMLCanvasElement | null
    x: number
    y: number
    w: number
    h: number
  }
  interface Mark {
    id: number
    page: number
    /** The phrase the shape belongs to (laser.ts · `PhraseClock`): it glows and goes out with it. */
    phrase: number
    /** How much longer its phrase holds here: the wire's jitter, for someone else's (`PHRASE_WIRE_MS`). */
    grace: number
    /** The samples, page fractions in pairs: the same layout as ink. */
    xy: number[]
    /** How many samples are drawn: all of one's own, up to the playhead of someone else's. */
    shown: number
    /** When the pen let go; `null` means this shape is being drawn right now. */
    letGo: number | null
    /** At what brightness the shape is currently drawn on the canvas. */
    alpha: number
    trail: Trail | null
    bake: Bake | null
    /** The sheet size and zoom the bake was tried for: a refitted or re-zoomed canvas bakes again. */
    bakedFor: string
  }

  let marks: Mark[] = []

  function newMark(id: number, at: number, xy: number[], phrase: number, grace = 0): Mark {
    const mark: Mark = {
      id,
      page: at,
      phrase,
      grace,
      xy,
      shown: 0,
      letGo: null,
      alpha: 0,
      trail: null,
      bake: null,
      bakedFor: '',
    }
    marks.push(mark)
    if (marks.length > MARKS_MAX) {
      for (const gone of marks.slice(0, marks.length - MARKS_MAX)) unbake(gone)
      marks = marks.slice(-MARKS_MAX)
    }
    return mark
  }

  /**
   * The bitmaps of released shapes, in device pixels, all together.
   *
   * A phrase keeps every one of its shapes lit, and so baked, until it goes
   * out: a word written with the pointer is twenty bitmaps alive at once
   * where there used to be one or two. On an iPad every canvas comes out of
   * one budget per process, and when it runs out WebKit hands out canvases
   * that silently stay transparent, the PAGE among them. So the bakes have a
   * budget of their own: past it a shape is stroked per frame, which costs
   * time, never the page. Each bitmap is given back the moment its shape
   * goes (`unbake`).
   */
  const BAKE_BUDGET_PX = 8_000_000
  let bakedPx = 0

  /** Give a shape's bitmap back: width and height of one is how WebKit frees a canvas at once. */
  function unbake(mark: Mark): void {
    const canvas = mark.bake?.canvas
    mark.bake = null
    if (!canvas) return
    bakedPx = Math.max(0, bakedPx - canvas.width * canvas.height)
    canvas.width = 1
    canvas.height = 1
  }

  /**
   * THE HEAD IS WHERE THE SAMPLES ARE, not a spring chasing them.
   *
   * It used to be a spring on both sides. On the console it lagged the
   * Pencil by a few millimetres and rounded every check mark; in the hall it
   * chased points that came fifteen times a second, and the trail, laid from
   * where the head was drawn on each frame, was the spring's polygon rather
   * than the presenter's circle. Now on the console the head is the newest
   * sample, pushed ahead by the predicted tip (`tip`); in the hall it moves
   * along the presenter's own samples on a timeline (`LaserPlayback`).
   *
   * The head lives while the pointer is held: most often the pointer STANDS
   * still ("right here"), and a dot living on a timer would vanish under the
   * hand. Only a released pointer puts the head out, or moving to another
   * page; the shape itself then stands and melts in its own time.
   */
  let head: { page: number; x: number; y: number } | null = null
  /**
   * Where the presenter's pen will be in a moment: from the browser's
   * prediction, or one step ahead from the last samples. Drawn on the live
   * canvas only, never stored or sent, exactly like the predicted tip of a
   * stroke (`guess`): in the hall it would be a line the hand never drew.
   */
  let tip: { x: number; y: number } | null = null
  /**
   * When the prediction was made. A prediction is about the NEXT moment: once
   * the pen has stopped, the last one stays where the browser guessed the
   * pen was going, and the shape ends in a straight whisker past the real
   * tip. So it lives two frames and is dropped (see `tick`).
   */
  let tipAt = 0
  const TIP_TTL_MS = 40
  /** The longest a prediction may reach past the last sample, in px of the glass. */
  const TIP_MAX_PX = 12
  /**
   * Where the head was drawn in the last frame, in canvas px, for the test
   * bench (see `window.__inkLat`). The bench used to track the head by the
   * live canvas's pixels, reading them on every frame; but reading pixels
   * forces the browser to rasterise the canvas right away, and with a
   * software rasteriser that cost more than a frame: the bench was measuring
   * its own shadow. From here it takes what the frame actually drew.
   */
  let shownHead: { x: number; y: number; at: number } | null = null

  /** One's own press: the samples and the frames for the room (laser.ts). */
  let press: LaserPress | null = null
  /** The page the press draws on: its samples go out labelled with it, not with a later page. */
  let pressPage = 0
  /** One's own shape being drawn now (a line), or `null` (a dot, or not pressed). */
  let ownMark: Mark | null = null
  /** The last kept samples of one's own press, newest last: the fallback prediction. */
  let ownBack: LaserSample[] = []
  /**
   * The numbers of one's own recent presses. The room echoes every pointer
   * frame back to its sender, and a frame of ours must not be replayed as
   * someone else's pointer, not even after the tool has changed: it would be
   * a second copy of the shape, a network round trip late.
   */
  let ownMarks: number[] = []

  /** Someone else's press being played back now, and its shape (a line). */
  let stream: LaserPlayback | null = null
  let streamMark: Mark | null = null
  /** How this screen groups the presses it hears into phrases (laser.ts · `HeardPhrases`). */
  const heard = new HeardPhrases()

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
   * projector it would be a line the hand never drew. A marker's tip is the
   * exception: it extends the marker's own path on the marker canvas
   * (`markersHere`), since a second translucent stroke over its end darkens.
   */
  let guess: { fromX: number; fromY: number; x: number; y: number; color: string; width: number } | null = null

  /**
   * The hold ring's look (see `holdShown`), in px of the glass: 2.5 px on a
   * radius of 15, closing over a track of its own colour at a quarter
   * strength.
   *
   * THE ACCENT, not the pen's colour and not the pointer's red. It is the
   * interface speaking, not ink: in the pen's colour it would read as a blot
   * the hand made, and red is what the hall looks at. The accent is the cyan
   * that means "under way" everywhere in the app (`--accent`, the same in
   * both themes), and it holds on a white slide and on a dark one alike.
   * Wide enough to show round the Pencil's tip rather than under it, small
   * enough not to hide the end of the line it is about.
   */
  const HOLD_RING = '#0fa0d7'
  const HOLD_RING_PX = 15
  const HOLD_RING_LINE_PX = 2.5
  const HOLD_RING_TRACK = 0.25
  /**
   * The ring the live canvas holds now, and where (page fractions): a frame
   * repaints for it only when it would look different. The test bench reads
   * it too (`window.__inkLat.hold`), for the reason it reads `head`.
   */
  let holdDrawn: (HoldRing & { x: number; y: number }) | null = null

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
    /*
     * Someone else's pointer: the playhead moves along the presenter's
     * samples. Frames spin while there are samples ahead of it; a playhead
     * that has caught up with the last sample waits for the next frame from
     * the wire, and costs nothing meanwhile.
     */
    let moving = false
    // A stale prediction goes (see `tipAt`), and the head returns to the last sample.
    if (tip) {
      if (now - tipAt >= TIP_TTL_MS) {
        tip = null
        liveDirty = true
      } else {
        moving = true
      }
    }
    if (stream) {
      moving = stream.advance(now)
      if (streamMark) streamMark.shown = stream.shown
      const at = stream.head()
      if (at && !press) head = { page: stream.page, x: at.x, y: at.y }
      if (stream.done) finishStream(now, LASER_DELAY_MS)
      liveDirty = true
    }
    /*
     * Burnt down completely: the shape leaves whole, in one piece, as it
     * stood, together with its whole phrase, and gives its bitmap back.
     *
     * And the main thing: while a shape HOLDS, nothing on the canvas changes,
     * yet the frame used to redraw it sixty times a second for nearly a
     * second in a row. On a projector with a software rasteriser that was the
     * most expensive idle work in the show: labour for the sake of the same
     * image. Now a frame draws only if some shape's brightness really is
     * different (or a shape appeared, left, or the head moved).
     */
    let alive = false
    let burnt = false
    let changed = false
    const phrases = phrasesOf(marks)
    for (const mark of marks) {
      const phrase = phrases.get(mark.phrase)
      if (phraseOver(phrase, now)) {
        burnt = true
        continue
      }
      if (mark.letGo !== null) alive = true
      // A shape from another page is not drawn at all, and asks for no frame.
      if (mark.page === page && Math.abs(phraseGlow(phrase, now) - mark.alpha) > 0.004) changed = true
    }
    if (burnt) {
      const kept: Mark[] = []
      for (const mark of marks) {
        if (phraseOver(phrases.get(mark.phrase), now)) unbake(mark)
        else kept.push(mark)
      }
      marks = kept
    }
    /*
     * The hold ring runs by the clock: a frame while it closes or fades, one
     * more to draw where it stopped, and none while it waits full for its
     * line or is not there at all.
     */
    const hold = holdShown(now)
    if (hold?.closed !== holdDrawn?.closed || hold?.alpha !== holdDrawn?.alpha) liveDirty = true
    if (liveDirty || moving || changed || burnt) paintLive(now)
    liveDirty = false
    /*
     * Frames keep spinning while there is unfinished business: samples ahead
     * of the playhead, or some shape not burnt down yet. A standing shape is
     * still visited by the frame (otherwise nobody would notice that its
     * phrase's hold is up and it is time to fade), but it is NOT DRAWN: while the
     * brightness is the same, `changed` stays false and the live canvas is
     * not touched at all. What is expensive here is rasterising, not walking
     * the list.
     */
    if (moving || alive || hold?.moving) liveFrame = requestAnimationFrame(tick)
  }

  /** A shape's body for its first `count` samples, extended from where it was laid last. */
  function bodyOf(mark: Mark, count: number): Path2D {
    let trail = mark.trail
    if (!trail || trail.w !== w || trail.h !== h || trail.count > count) {
      trail = { w, h, body: new Path2D(), laid: 0, count: 0 }
      mark.trail = trail
    }
    if (count > trail.count) {
      trail.laid = layCurve(trail.body, mark.xy, count, trail.laid, w, h)
      trail.count = count
    }
    return trail.body
  }

  /** The whole path of a shape: its body, the last sample and, while held, the head. */
  function pathOf(mark: Mark, count: number, end: { x: number; y: number } | null): Path2D {
    const path = new Path2D(bodyOf(mark, count))
    const last = count - 1
    path.lineTo(mark.xy[last * 2] * w, mark.xy[last * 2 + 1] * h)
    if (end) path.lineTo(end.x * w, end.y * h)
    return path
  }

  /*
   * THE TRAIL IS ONE DENSE GLOWING LINE.
   *
   * No chain of blobs, no tapering towards the tail, no per-point fading:
   * all of that read as "a tail of beads chasing the head". The line is
   * STROKED, not filled: filling an outline cancels itself at a
   * self-intersection, and a loop is the pointer's main case. A halo five
   * times wider than the core, on THE SAME path: the glow is what is seen from
   * the back row.
   *
   * The join is ROUND. It used to be bevelled to spare the projector's
   * software rasteriser an arc at every vertex of a path rebuilt every frame;
   * with the path laid once and a released shape baked into a bitmap, the
   * only shape stroked per frame is the one under the hand, and a bevel on a
   * thick halo shows as facets exactly where the hand turned.
   */
  function strokeTrail(
    paint: CanvasRenderingContext2D,
    path: Path2D,
    core: number,
    dim: number,
  ): void {
    paint.lineJoin = 'round'
    paint.lineCap = 'round'
    paint.strokeStyle = LASER_RED
    paint.globalAlpha = 0.18 * dim
    paint.lineWidth = core * 5.2
    paint.stroke(path)
    paint.globalAlpha = 0.85 * dim
    paint.lineWidth = core * 2
    paint.stroke(path)
  }

  /**
   * The largest bake, in device pixels: a shape circling the whole slide on a
   * 4K projector is better stroked per frame than kept as forty megabytes.
   */
  const BAKE_MAX_PX = 2_500_000

  /**
   * A released shape's bitmap, made once per sheet size and zoom.
   *
   * At the zoom's resolution, so that a shape under a magnified detail is as
   * sharp as the ink around it, and only the part of it that can be seen:
   * at ×4 the rest of the shape lies off the sheet, and baking it would cost
   * sixteen times its area for nothing.
   */
  function bakeOf(mark: Mark, core: number): Bake | null {
    const size = `${w}x${h}@${paintedKey}`
    if (mark.bakedFor === size) return mark.bake
    unbake(mark)
    mark.bakedFor = size
    const count = mark.shown
    if (count < 2) return null
    let loX = Number.POSITIVE_INFINITY
    let loY = Number.POSITIVE_INFINITY
    let hiX = Number.NEGATIVE_INFINITY
    let hiY = Number.NEGATIVE_INFINITY
    for (let i = 0; i < count; i += 1) {
      const x = mark.xy[i * 2] * w
      const y = mark.xy[i * 2 + 1] * h
      if (x < loX) loX = x
      if (x > hiX) hiX = x
      if (y < loY) loY = y
      if (y > hiY) hiY = y
    }
    const pad = core * 2.6 + 2 / near
    const seen = visibleRect(zoom.painted)
    const left = Math.floor(Math.max(loX - pad, seen.x * w))
    const top = Math.floor(Math.max(loY - pad, seen.y * h))
    const wide = Math.ceil(Math.min(hiX + pad, (seen.x + seen.w) * w)) - left
    const high = Math.ceil(Math.min(hiY + pad, (seen.y + seen.h) * h)) - top
    if (wide <= 0 || high <= 0) {
      mark.bake = { canvas: null, x: left, y: top, w: 0, h: 0 }
      return mark.bake
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 2) * near
    const cost = Math.ceil(wide * ratio) * Math.ceil(high * ratio)
    if (cost > BAKE_MAX_PX || bakedPx + cost > BAKE_BUDGET_PX) return null
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(wide * ratio))
    canvas.height = Math.max(1, Math.ceil(high * ratio))
    const paint = canvas.getContext('2d')
    if (!paint) {
      canvas.width = 1
      canvas.height = 1
      return null
    }
    bakedPx += canvas.width * canvas.height
    paint.setTransform(ratio, 0, 0, ratio, -left * ratio, -top * ratio)
    strokeTrail(paint, pathOf(mark, count, null), core, 1)
    mark.bake = { canvas, x: left, y: top, w: wide, h: high }
    return mark.bake
  }

  function paintLive(now: number): void {
    const node = liveCanvas
    if (!node || w === 0 || h === 0) return
    const ready = fitTo(node, true)
    if (!ready) return
    const paint = ready.paint
    wipe(paint)

    // A marker's predicted tip is part of its own path (see `markersHere`).
    if (guess && !seeThrough(guess.color)) {
      paint.strokeStyle = guess.color
      paint.lineWidth = Math.max(1 / near, guess.width * w)
      paint.beginPath()
      paint.moveTo(guess.fromX * w, guess.fromY * h)
      paint.lineTo(guess.x * w, guess.y * h)
      paint.stroke()
    }

    // Sizes on the glass, the same under any zoom: the canvas is painted `near` times closer.
    const radius = Math.max(9, w * 0.011) / near
    const core = radius * 0.34
    // The head as drawn: one's own pushed to the predicted tip, someone else's on the playhead.
    const shown = head && head.page === page ? (press && tip ? { x: tip.x, y: tip.y } : head) : null
    const phrases = phrasesOf(marks)
    for (const mark of marks) {
      if (mark.page !== page) continue
      const dim = phraseGlow(phrases.get(mark.phrase), now)
      mark.alpha = dim
      if (dim <= 0 || mark.shown === 0) continue
      const held = mark === ownMark || mark === streamMark
      const end = held && shown ? shown : null
      if (mark.shown === 1 && !end) {
        // Poked and not moved: a "right here" dot is a shape too.
        paint.globalAlpha = 0.85 * dim
        paint.fillStyle = LASER_RED
        paint.beginPath()
        paint.arc(mark.xy[0] * w, mark.xy[1] * h, core, 0, Math.PI * 2)
        paint.fill()
        continue
      }
      const bake = held ? null : bakeOf(mark, core)
      if (bake) {
        if (bake.canvas) {
          paint.globalAlpha = dim
          paint.drawImage(bake.canvas, bake.x, bake.y, bake.w, bake.h)
        }
        continue
      }
      strokeTrail(paint, pathOf(mark, mark.shown, end), core, dim)
    }
    paint.globalAlpha = 1

    if (shown) {
      /*
       * The head. A soft spot around the core: on a projector a bright
       * four-pixel dot gets lost on a white slide, while the glow is visible
       * from the back row.
       */
      const x = shown.x * w
      const y = shown.y * h
      shownHead = { x, y, at: now }
      /*
       * The head is not a separate ball chasing the ribbon but its glowing
       * end: the halo is half its former size and the core slightly larger,
       * so together with the ribbon they read as one thing. The glow is
       * still needed: a bright four-pixel dot gets lost on a white slide at
       * ten metres.
       */
      const halo = paint.createRadialGradient(x, y, 0, x, y, radius * 1.5)
      halo.addColorStop(0, LASER_RED)
      halo.addColorStop(1, 'transparent')
      paint.globalAlpha = 0.5
      paint.fillStyle = halo
      paint.beginPath()
      paint.arc(x, y, radius * 1.5, 0, Math.PI * 2)
      paint.fill()
      paint.globalAlpha = 1
      paint.fillStyle = LASER_RED
      paint.beginPath()
      paint.arc(x, y, radius * 0.55, 0, Math.PI * 2)
      paint.fill()
    } else {
      shownHead = null
    }

    if (ring && live && tool === 'laser') {
      /*
       * The pointer's shadow is GREY, not red: on this screen only what the
       * audience sees glows red, and a shadow painted the same colour would
       * read as "I'm already pointing", although the pen is not on the glass
       * yet.
       */
      const x = ring.x * w
      const y = ring.y * h
      const r = Math.max(4 / near, radius * 0.42)
      paint.globalAlpha = 0.5
      paint.fillStyle = 'rgba(120,132,153,1)'
      paint.beginPath()
      paint.arc(x, y, r, 0, Math.PI * 2)
      paint.fill()
      paint.globalAlpha = 0.45
      paint.strokeStyle = 'rgba(255,255,255,0.9)'
      paint.lineWidth = 1.5 / near
      paint.beginPath()
      paint.arc(x, y, r + 1.5 / near, 0, Math.PI * 2)
      paint.stroke()
      paint.globalAlpha = 1
    }

    if (ring && live && (tool === 'pen' || tool === 'marker')) {
      /*
       * The pen's shadow: a spot exactly as wide as the stroke will be and of
       * the same colour, but at half strength: this is not ink yet. A thin
       * dark outline holds it on a white slide, where a translucent spot of
       * its own colour would otherwise get lost. As wide as the stroke WILL
       * be: under a zoom that is the chosen width divided by it.
       */
      const x = ring.x * w
      const y = ring.y * h
      const r = Math.max(3 / near, (inkWidthAt(width, zoom.shown) * w) / 2)
      paint.globalAlpha = 0.55
      paint.fillStyle = color
      paint.beginPath()
      paint.arc(x, y, r, 0, Math.PI * 2)
      paint.fill()
      paint.globalAlpha = 0.5
      paint.strokeStyle = 'rgba(255,255,255,0.85)'
      paint.lineWidth = 1.5 / near
      paint.beginPath()
      paint.arc(x, y, r + 1.5 / near, 0, Math.PI * 2)
      paint.stroke()
      paint.globalAlpha = 1
    }

    if (ring && live && tool === 'eraser') {
      /*
       * The eraser ring is our own, and only ours: it is not on the
       * projector. Hollow, not filled: people look under it to see whether it
       * hits the stroke, and its radius is exactly the reach that erases
       * (`ERASER_PX`, see `rub`): on the glass, so under a zoom both are the
       * same fraction of the page, divided by the same `near`. A white
       * outline under a dark one is the only way to stay visible both on a
       * white slide and on a dark full-sheet picture.
       */
      const x = ring.x * w
      const y = ring.y * h
      paint.beginPath()
      paint.arc(x, y, ERASER_PX / near, 0, Math.PI * 2)
      paint.strokeStyle = 'rgba(255,255,255,0.9)'
      paint.lineWidth = 3 / near
      paint.stroke()
      paint.strokeStyle = 'rgba(16,26,51,0.85)'
      paint.lineWidth = 1.5 / near
      paint.stroke()
    }

    if (framing && framing.moved) {
      /*
       * The magnifier's frame, ours only: the hall sees where it leads, not
       * the frame. Drawn like the eraser ring, white under dark, dashed so
       * that it reads as "a choice", not as ink.
       */
      const x = Math.min(framing.from.x, framing.to.x) * w
      const y = Math.min(framing.from.y, framing.to.y) * h
      const fw = Math.abs(framing.to.x - framing.from.x) * w
      const fh = Math.abs(framing.to.y - framing.from.y) * h
      paint.strokeStyle = 'rgba(255,255,255,0.9)'
      paint.lineWidth = 3 / near
      paint.strokeRect(x, y, fw, fh)
      paint.setLineDash([6 / near, 5 / near])
      paint.strokeStyle = 'rgba(16,26,51,0.85)'
      paint.lineWidth = 1.5 / near
      paint.strokeRect(x, y, fw, fh)
      paint.setLineDash([])
    }

    const hold = holdShown(now)
    holdDrawn = hold
    if (hold) {
      /*
       * The hold ring, round the pen's tip (see `holdShown`): the track
       * first, then the part that has closed, clockwise from twelve o'clock,
       * as a clock runs. Its sizes are on the glass, so under a zoom they are
       * divided by it like the eraser's ring.
       */
      const x = hold.x * w
      const y = hold.y * h
      const r = HOLD_RING_PX / near
      paint.lineWidth = HOLD_RING_LINE_PX / near
      paint.lineCap = 'round'
      paint.strokeStyle = HOLD_RING
      paint.globalAlpha = HOLD_RING_TRACK * hold.alpha
      paint.beginPath()
      paint.arc(x, y, r, 0, Math.PI * 2)
      paint.stroke()
      if (hold.closed > 0) {
        paint.globalAlpha = hold.alpha
        paint.beginPath()
        paint.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * hold.closed)
        paint.stroke()
      }
      paint.globalAlpha = 1
    }
  }

  // The live canvas: a page, size or painted zoom change means repaint; a
  // tool change may have made the eraser ring out of place, and turning the
  // hold ring or the straight line off takes a showing ring away.
  $effect(() => {
    void page
    void w
    void h
    void paintedKey
    void tool
    void holdRing
    void straighten
    void liveCanvas
    untrack(() => wake())
  })

  /* ------------------------------------------- someone else's pointer */

  /**
   * Someone else's press is over: everything it drew shows at once, the
   * head goes out, and the shape stands and melts with its phrase.
   *
   * `early` is how long ago, in the presenter's terms, the pen really left the
   * glass: a playback that ran to its end is `LASER_DELAY_MS` behind the
   * presenter, and the shape's life is counted from the release, not from
   * the replay. So it goes out in the hall at the same moment as on the
   * console: the presenter, seeing their own shape gone, is right about the
   * projector too. (A phrase the console named holds whole a little longer
   * here and fades quicker, for the network's jitter: laser.ts ·
   * `PHRASE_WIRE_MS`. It still ends with the console's.)
   */
  function finishStream(now: number, early = 0): void {
    if (!stream) return
    stream.finish()
    if (streamMark) {
      streamMark.shown = stream.shown
      streamMark.letGo = now - early
    }
    stream = null
    streamMark = null
    if (!press) head = null
    liveDirty = true
  }

  /**
   * A pointer frame from the room.
   *
   * Our own frames come back too (the room echoes to its sender), and they
   * are told apart by the press number, not by the tool: the echo of the last
   * samples arrives after the release, often after the tool has already
   * changed, and used to flash as a dot on an empty spot.
   *
   * A NEW press number while a shape is still being played closes that shape
   * first. The release ("off") could be lost on the way, and a still-open
   * shape then got a straight line from the old spot to the new one.
   */
  function hearRemote(at: LaserAt | null): void {
    const now = performance.now()
    if (at === null) {
      // The presenter let go: the playhead finishes the samples it has and
      // the shape is let go there (see `tick`).
      if (stream) {
        stream.end(now)
        wake()
      }
      return
    }
    if (at.mark !== undefined && ownMarks.includes(at.mark)) return
    if (live && tool === 'laser') return
    const mark = at.mark ?? 0
    if (stream && (stream.mark !== mark || stream.page !== at.page)) finishStream(now)
    if (!stream) {
      stream = new LaserPlayback(mark, at.page, at.shape)
      /*
       * As a dot, no shape is started at all. Not "draw and hide": a shape
       * that does not exist accumulates no points and asks for no frames to
       * fade, and the pointer has always had its own head: that is the dot.
       *
       * The phrase is the presenter's (`trail`): the hall groups the shapes
       * as the hand wrote them, and holds them the wire's grace longer, so a
       * press the network brought late still finds its word lit. One later
       * still starts a phrase here rather than revive a fading one. A console
       * from before phrases does not say, and then the same rule is applied
       * here, to this screen's shapes (laser.ts · `HeardPhrases`).
       */
      const grace = at.trail === undefined ? 0 : PHRASE_WIRE_MS
      streamMark =
        at.shape === 'line' ? newMark(mark, at.page, stream.xy, phraseHere(at.page, at.trail, now), grace) : null
    }
    stream.hear(at.pts && at.pts.length >= 3 ? at.pts : [at.x, at.y, Math.round(now)], now)
    wake()
  }

  /** The phrase someone else's press joins here: the one its frames name, or the timing rule's. */
  function phraseHere(at: number, trail: number | undefined, now: number): number {
    return heard.join(
      marks.filter((mark) => mark.page === at),
      trail,
      now,
    )
  }

  $effect(() => hearLaser(session, hearRemote))

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
      if (!stream) return
      finishStream(performance.now())
      wake()
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
      if (echo && echo.points.length >= stroke.handed) {
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
      // From where the server's copy ends, and SAYING so: if the original
      // frames were only late, the server drops what it already has instead
      // of drawing the tail a second time (see `addInk`).
      sendPoints(stroke, echo?.points.length ?? 0)
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

  /*
   * The server is missing a piece of one of our strokes (`ink:need`): a frame
   * handed to a socket that died on the way. Resent at once from where the
   * server stopped, without waiting for the settle timer: the stroke may still
   * be under the pen, and every piece until then would be refused the same way.
   */
  $effect(() =>
    hearInkNeed(session, (need) => {
      const stroke = wet.find((known) => known.id === need.id && known.page === need.page)
      if (stroke && need.have < stroke.points.length) sendPoints(stroke, need.have)
    }),
  )

  /* ------------------------------------------------------------ input */

  /** When the pen last touched the glass. See the two-finger tap. */
  let lastPenAt = 0
  /** Any sign of the pen near the glass, hover included: while it is recent, a finger never leads the pointer. */
  let lastPenNearAt = 0
  const FINGER_POINTER_AFTER_PEN_MS = 2500
  /** A pen has been seen on this screen: `onpen` is called once. */
  let penKnown = false
  /**
   * The stroke being drawn now. `pointer` so that no other touch closes it;
   * `byFinger` so that the pen can: see `down`.
   */
  interface Drawing {
    pointer: number
    byFinger: boolean
    stroke: Wet
    /** Where the pointer is now, unsmoothed: where a straight line ends. */
    tip: { x: number; y: number }
    /**
     * Set once the stroke has straightened (`straightenNow`): the freehand
     * pieces the line replaces, to be taken back from the room on the lift.
     */
    replaced: { page: number; id: string }[] | null
  }
  let drawing: Drawing | null = null
  /** The pointer that pressed the laser: a hovering pen does not put it out. */
  let beaming: number | null = null
  /** It is a finger: when the finger is turned off, it lets the beam go. */
  let beamingByFinger = false
  /** The laser is lit: `laser:off` must go out exactly once. */
  let lit = false
  /** The pointer that is erasing. */
  let erasing: number | null = null
  /**
   * The current eraser sweep's name: every stroke it takes is sent with it,
   * and one Undo brings the whole sweep back (see `eraseInk` on the server).
   */
  let eraseGesture = ''
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
   * THE POINTER: `LASER_EVERY_MS`, shared with the server. Its frames now
   * carry every sample too, with their times (laser.ts), so the tick no
   * longer shapes the line either: it sets how far behind the presenter the
   * hall plays it. It lives in `@shared/lecture` because the server derives
   * its window from it (control.ts · `laserTo`).
   */
  const SEND_EVERY_MS = 50

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
   * the line; the new one names the first as its `group`, so that one Undo
   * takes the whole motion back and a marker is drawn as one path.
   */
  const SPLIT_AT_NUMBERS = 3900
  /**
   * The smallest step worth a point, in px of the screen (the sheet times
   * the zoom).
   *
   * Every coalesced sample used to be kept, and a Pencil held still keeps
   * reporting pressure and tilt: the four-thousand-number budget filled up
   * without the pen travelling, and the motion split for no visible reason.
   * Half a pixel is below what any screen in the room can show, the
   * magnified ones included: every screen shows the same zoom.
   */
  const INK_MIN_STEP_PX = 0.5

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
  /**
   * The view moved since `rect` was taken. The size observer does not see a
   * transform, and under a moving zoom the canvas's rect is not the sheet's:
   * it is the bitmap painted at `zoom.painted`, moved by `zoom.css`. The next
   * point asks for a fresh one, once per change, not per sample.
   */
  let rectStale = true
  function measure(): void {
    const node = wetCanvas
    rect = node ? node.getBoundingClientRect() : null
    rectStale = false
  }

  $effect(() => {
    void zoom
    rectStale = true
  })

  /**
   * Coordinates as fractions of the PAGE, clamped to what the sheet shows.
   *
   * The input layer is wider than the sheet: the margins are on it too. A
   * stroke started on the margin and carried onto the sheet does start: on
   * paper one draws from the edge, and a pen that stays silent until it
   * crosses an invisible line is a pen that "didn't work".
   *
   * Under a zoom the rect is the bitmap's, which is painted at
   * `zoom.painted`: the place across it is a place in that region of the
   * page (`boxToPage`), whatever transform moves the bitmap meanwhile. The
   * clamp is to the region the hall sees, not to the page: a stroke carried
   * past the edge of a magnified detail stays on its edge, as it stays on
   * the page's edge at ×1, instead of running on where nobody can see it.
   */
  function at(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    if (rectStale) measure()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    const place = boxToPage(
      zoom.painted,
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    )
    const seen = visibleRect(zoom.shown)
    return {
      x: round(Math.min(seen.x + seen.w, Math.max(seen.x, place.x))),
      y: round(Math.min(seen.y + seen.h, Math.max(seen.y, place.y))),
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

  /**
   * The pen showed signs of life.
   *
   * Two different facts, and they used to be one. A pen anywhere near the
   * glass, hovering included, proves this screen has a pen: `onpen`, and
   * fingers stop drawing. Only a pen IN CONTACT starts the pause before a
   * two-finger tap: Pencil hovers above the glass the whole time the hand is
   * over the tablet, and counting hover meant two fingers never undid
   * anything, while the comment in `move` promised the opposite.
   */
  function penSeen(event: PointerEvent): void {
    if (event.pointerType !== 'pen') return
    lastPenNearAt = performance.now()
    if (event.buttons !== 0 || event.type === 'pointerdown' || event.type === 'pointerup') {
      lastPenAt = performance.now()
    }
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
   * THE POINTER is the one place where a finger may lead with finger drawing
   * off: the pen back in its case and people pointing with a finger is the
   * common case in class (stand scenario R13b). It used to be guarded by
   * "alone, and the pen not on the glass for 600 ms", which a pinky or a
   * knuckle of the resting hand passes while the presenter talks with the pen
   * HOVERING: the red dot lit for the hall and followed the hand. So the
   * guard now counts the pen NEAR the glass, hover included, and waits
   * FINGER_POINTER_AFTER_PEN_MS: while the pen is in the hand, the finger
   * never leads; once the pen has been away for a moment, it does.
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
        performance.now() - lastPenNearAt > FINGER_POINTER_AFTER_PEN_MS
      )
    }
    return true
  }

  /** Whether we hold the pointer. The parent uses it to keep the palm off the buttons. */
  let busy = false
  function syncBusy(): void {
    const next =
      drawing !== null || erasing !== null || beaming !== null || lit || framing !== null || pinch?.committed === true
    if (next === busy) return
    busy = next
    onbusy?.(next)
  }

  /**
   * Hand the stroke's numbers from position `from` on to the server. Returns
   * whether they went out.
   *
   * ON A CLOSED SOCKET AN INK FRAME IS NOT SENT AT ALL.
   *
   * `session.send` puts what could not be sent into the control queue, and
   * that holds sixteen messages and throws out THE OLDEST. Three seconds of
   * writing on a blinking Wi-Fi are seventy-five frames, of which the last
   * sixteen get through: the server would start the stroke FROM THE MIDDLE of
   * the formula. So what was not sent stays behind `handed` and goes out as
   * one piece when the connection returns; for a closed stroke resending does
   * the same.
   *
   * EVERY PIECE SAYS WHERE IT STARTS (`from`), and that is what holds
   * everything else up. The server appends a piece only at its place: what it
   * already has is dropped (a resend after a slow echo used to be appended a
   * second time, a straight line back across the slide for the whole hall),
   * and a piece beyond its end is answered with `ink:need` instead of being
   * glued on with a chord (a frame handed to a socket that died).
   */
  function sendPoints(stroke: Wet, from: number): boolean {
    if (!session.connected) return false
    const numbers = stroke.points.slice(from)
    /*
     * Sliced into frames, not one message: see MAX_NUMBERS_PER_FRAME. The
     * pieces go under one and the same stroke id, each with its own position.
     */
    for (let offset = 0; offset < numbers.length; offset += MAX_NUMBERS_PER_FRAME) {
      session.send({
        t: 'ink',
        page: stroke.page,
        id: stroke.id,
        color: stroke.color,
        width: stroke.width,
        points: numbers.slice(offset, offset + MAX_NUMBERS_PER_FRAME),
        from: from + offset,
        ...(stroke.group ? { group: stroke.group } : {}),
      })
    }
    stroke.handed = Math.max(stroke.handed, stroke.points.length)
    return true
  }

  function flush(): void {
    window.clearTimeout(flushTimer)
    flushTimer = undefined
    if (!drawing) return
    const stroke = drawing.stroke
    // A straight line still held: its end moves, and the wire only appends.
    if (stroke.straight) return
    // Not sent: the points stay behind `handed` and go as one piece when the
    // connection returns. Nothing is cut out of the stroke where the Wi-Fi
    // blinked.
    if (stroke.points.length - stroke.handed < 2) return
    sendPoints(stroke, stroke.handed)
  }

  function schedule(): void {
    if (flushTimer !== undefined) return
    flushTimer = window.setTimeout(flush, SEND_EVERY_MS)
  }

  function newStrokeId(): string {
    return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
  }

  function newStroke(x: number, y: number, force: number, group?: string): Wet {
    return {
      id: newStrokeId(),
      page,
      color,
      // As thick on the glass as the chosen pen, under whatever zoom (ink.ts · `inkWidthAt`).
      width: inkWidthAt(width, zoom.shown),
      points: [x, y],
      force: [force],
      handed: 0,
      group,
      bornAt: performance.now(),
      closed: false,
      closedAt: 0,
      resent: 0,
      echoed: false,
      tail: { n: 0, curved: 0, tipX: x * w, tipY: y * h },
    }
  }

  function openStroke(
    pointer: number,
    byFinger: boolean,
    place: { x: number; y: number },
    force: number,
    group?: string,
  ): void {
    /*
     * The pen touched down: the tip's shadow is removed. For the eraser the
     * ring stays in contact (people watch it to see whether it hits the
     * stroke), but under the pen's tip there is already its own line: a spot
     * on top of it reads as a blot the hand never made.
     */
    if (ring && tool !== 'eraser') ring = null
    const stroke = newStroke(place.x, place.y, force, group)
    // The filter starts at the point where the pen touched down: otherwise
    // the new stroke would come out of the end of the previous one, pulled
    // by its last value.
    smoothX = place.x
    smoothY = place.y
    wet = [...wet, stroke]
    rememberWet()
    drawing = { pointer, byFinger, stroke, tip: place, replaced: null }
    growWet(stroke)
    /*
     * The first point goes at once: a pen tap must arrive even if the pen was
     * lifted right away, and nobody will notice forty milliseconds of tick on
     * the first point.
     *
     * With a finger, after a quarter-second delay: that much is set aside for
     * a second finger to turn the touch into an undo tap or a pinch (see
     * `forgetFirst`). A sent point cannot be taken back, while an unsent one
     * "never happened": this is the only case when a stroke disappears
     * silently, and it is allowed precisely because nothing from it has gone
     * out.
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
    if (!drawing || drawing.stroke.handed !== 0 || drawing.replaced) return
    window.clearTimeout(flushTimer)
    flushTimer = undefined
    unrest()
    const gone = drawing.stroke
    drawing = null
    guess = null
    wet = wet.filter((stroke) => stroke !== gone)
    rememberWet()
    paintWetAll()
    paintMarkers()
    wake()
    syncBusy()
  }

  /**
   * The stroke under the finger was the start of a gesture, not ink (a
   * pinch, see `commitPinch`): take it back whole. What never went out is
   * forgotten; what did is retracted, like the palm in `dropPalm`, and so is
   * the freehand motion a straight line was about to replace.
   */
  function takeBack(): void {
    const held = drawing
    if (!held) return
    if (held.stroke.handed === 0 && !held.replaced) {
      forgetUnsent()
      return
    }
    window.clearTimeout(flushTimer)
    flushTimer = undefined
    unrest()
    drawing = null
    guess = null
    const stroke = held.stroke
    const out = [...(held.replaced ?? [])]
    if (stroke.handed > 0) out.push({ page: stroke.page, id: stroke.id })
    for (const piece of out) {
      session.send({ t: 'ink:erase', page: piece.page, id: piece.id, retract: true })
      withheld.delete(piece.id)
    }
    if (out.length > 0) {
      erased = new Set([...erased, ...out.map((piece) => piece.id)])
      forgetLater()
    }
    wet = wet.filter((known) => known !== stroke)
    rememberWet()
    paintWetAll()
    paintMarkers()
    wake()
    syncBusy()
  }

  /**
   * The finger stroke under the pen that just landed is the palm, if it is
   * young or has hardly moved: take it back instead of leaving a dot for the
   * hall where the hand came down.
   *
   * On a device's first pen use finger drawing is still on, and the writing
   * hand's pinky lands a moment before the tip. Its stroke used to be CLOSED
   * here, and closing flushed the very point that was being held back so that
   * it could be forgotten: a dot stayed on the projector. Unsent, it is simply
   * forgotten; already sent, it is retracted on the server, which leaves no
   * trace for Undo (`retract`). An older and longer finger stroke is a real
   * one and is finished as usual (ink.ts · `mayTakeBack`).
   */
  function dropPalm(): void {
    if (!drawing?.byFinger) return
    const stroke = drawing.stroke
    // Its travel is on the glass: the sheet times the zoom.
    if (!mayTakeBack(stroke.points, performance.now() - stroke.bornAt, w * near, h * near)) {
      closeStroke()
      return
    }
    if (stroke.handed === 0) {
      forgetUnsent()
      return
    }
    window.clearTimeout(flushTimer)
    flushTimer = undefined
    unrest()
    drawing = null
    guess = null
    session.send({ t: 'ink:erase', page: stroke.page, id: stroke.id, retract: true })
    erased = new Set([...erased, stroke.id])
    wet = wet.filter((known) => known !== stroke)
    rememberWet()
    paintWetAll()
    paintMarkers()
    wake()
    syncBusy()
  }

  /**
   * The pen was lifted, the tool changed, the page turned, the sheet taken:
   * the stroke is FINISHED, and from here on it waits for its echo. It is
   * never erased: what the presenter has already drawn, the audience has
   * already seen; "this never happened" is only the eraser and undo, and
   * both by hand.
   *
   * A straight line is finished here too, and only here does the room learn
   * about it: the freehand motion it replaces is taken back (`retract`, so
   * Undo never brings it back), and the line goes out as a stroke of its own,
   * in this order on one socket. Until this moment the hall kept seeing the
   * freehand line, so it never sees the place go blank in between.
   */
  function closeStroke(): void {
    if (!drawing) return
    unrest()
    const held = drawing
    if (held.replaced) {
      for (const piece of held.replaced) {
        session.send({ t: 'ink:erase', page: piece.page, id: piece.id, retract: true })
        withheld.delete(piece.id)
      }
      if (held.replaced.length > 0) forgetLater()
      held.replaced = null
      held.stroke.straight = false
    }
    const translucent = guess !== null && seeThrough(held.stroke.color)
    flush()
    held.stroke.closed = true
    held.stroke.closedAt = performance.now()
    drawing = null
    guess = null
    // A marker's predicted tip was part of its path: the path loses it now.
    if (translucent) paintMarkers()
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
      /*
       * Rounded AFTER smoothing, to the same four decimals as the wire
       * (`round`): a filtered value is never round, and it travelled as
       * eighteen characters where six were meant.
       */
      place = { x: round(smoothX), y: round(smoothY) }
    } else {
      smoothX = place.x
      smoothY = place.y
    }
    // A sample on the spot adds nothing (see INK_MIN_STEP_PX); the filter has
    // still taken it in, so the next one that moves starts from the truth.
    const last = stroke.points.length - 2
    if (
      last >= 0 &&
      Math.hypot((place.x - stroke.points[last]) * w, (place.y - stroke.points[last + 1]) * h) * near <
        INK_MIN_STEP_PX
    ) {
      return
    }
    stroke.points.push(place.x, place.y)
    stroke.force.push(force)
    if (stroke.points.length >= SPLIT_AT_NUMBERS) {
      const { pointer, byFinger } = drawing
      growWet(stroke)
      closeStroke()
      openStroke(pointer, byFinger, place, force, stroke.group ?? stroke.id)
    }
  }

  /*
   * ONE'S OWN POINTER: every sample into the shape and into the queue for the
   * room, the queue out at the pointer's tick (see `LASER_EVERY_MS`).
   *
   * It used to send only the latest position, and only every sixty-six
   * milliseconds: the samples in between were simply overwritten. Now the
   * shape on this screen and the shape in the hall are the same samples
   * (laser.ts · `LaserPress`), and the tick only sets how often the room is
   * bothered.
   */
  let spotTimer: number | undefined
  /**
   * Which phrase each press of ours belongs to (laser.ts · `PhraseClock`),
   * and the one being held now: it goes out with every frame (`trail`), so
   * that the hall groups the shapes exactly as they were written here.
   */
  const phraseClock = new PhraseClock()
  let pressTrail = 0

  function rememberOwn(mark: number): void {
    ownMarks = [...ownMarks.slice(-15), mark]
  }

  /** A sample was kept: into the shape, and the head onto it. */
  function keepOwn(sample: LaserSample): void {
    head = { page: pressPage, x: sample.x, y: sample.y }
    ownBack = [...ownBack.slice(-2), sample]
    if (!ownMark) return
    ownMark.xy.push(sample.x, sample.y)
    ownMark.shown += 1
    if (ownMark.shown < MARK_MAX_SAMPLES || !press) return
    /*
     * A press held for over a minute: the shape is let go WHOLE, to hold and
     * fade like any released one, and a new one continues from the head. Its
     * start is never shortened (see `MARK_MAX_SAMPLES`). The old shape's last
     * samples go out under its own number first.
     */
    beamNow(true)
    const next = newMarkId()
    rememberOwn(next)
    press.roll(next)
    ownMark.letGo = performance.now()
    ownMark = newMark(next, pressPage, [sample.x, sample.y], pressTrail)
    ownMark.shown = 1
  }

  /**
   * A FINGER'S BEAM IS HELD BACK FROM THE ROOM for `TAP_TOGETHER_MS`, like its
   * stroke (`openStroke`) and its erase (`eraseHeld`).
   *
   * A finger that comes down may be the first of two: an Undo tap or a pinch.
   * The beam it lit used to go out at once, and every pinch made with the
   * pointer armed left a red squiggle at the pinch spot on the projector, held
   * there for the phrase's two seconds. Now the console lights it at once (a
   * pointer that appears late under the finger feels stuck), but the room gets
   * it only once a second finger is ruled out: when the window closes
   * (`sendBeam`), or when the finger lifts alone, a poke. A second finger
   * inside the window takes the beam back as if it never was (`dropBeam`), and
   * so does a pen that lands in it: the finger was the palm. The hall replays
   * the held samples from the press on, a quarter of a second late, a little
   * faster until it catches up (`LaserPlayback`).
   */
  let beamHeld = false
  let beamHeldTimer: number | undefined

  /** The press: the shape starts, the first frame goes at once (a finger's: see `beamHeld`). */
  function beamStart(event: PointerEvent, place: { x: number; y: number }): void {
    const mark = newMarkId()
    rememberOwn(mark)
    press = new LaserPress(mark, event.timeStamp)
    pressPage = page
    pressTrail = phraseClock.press(performance.now())
    ownBack = []
    tip = null
    ownMark = laserShape === 'line' ? newMark(mark, page, [], pressTrail) : null
    const first = press.add(place.x, place.y, event.timeStamp, h / w, near)
    if (first) keepOwn(first)
    window.clearTimeout(beamHeldTimer)
    beamHeldTimer = undefined
    beamHeld = event.pointerType === 'touch'
    if (beamHeld) beamHeldTimer = window.setTimeout(sendBeam, TAP_TOGETHER_MS)
    else beamNow(true)
  }

  /** No second finger came: the finger's beam is the pointer after all, sent from the press on. */
  function sendBeam(): void {
    window.clearTimeout(beamHeldTimer)
    beamHeldTimer = undefined
    if (!beamHeld) return
    beamHeld = false
    beamNow(true)
  }

  /**
   * The finger's held beam was the first finger of a two-finger gesture, or
   * the palm under a landing pen: it goes from this screen as if it had never
   * been lit, and the room, which got nothing of it, hears nothing either.
   */
  function dropBeam(): void {
    window.clearTimeout(beamHeldTimer)
    beamHeldTimer = undefined
    beamHeld = false
    window.clearTimeout(spotTimer)
    spotTimer = undefined
    if (press) phraseClock.cancel()
    press = null
    beaming = null
    tip = null
    ownBack = []
    const gone = ownMark
    ownMark = null
    if (gone) {
      unbake(gone)
      marks = marks.filter((mark) => mark !== gone)
    }
    if (!stream) head = null
    wake()
    syncBusy()
  }

  /** Samples of a moving press, and where the pen will be a moment from now. */
  function beamMove(event: PointerEvent): void {
    if (!press) return
    for (const step of samples(event)) {
      const place = at(step)
      if (!place) continue
      const kept = press.add(place.x, place.y, step.timeStamp, h / w, near)
      if (kept) keepOwn(kept)
    }
    tip = foreseeLaser(event)
    tipAt = performance.now()
    if (spotTimer === undefined) spotTimer = window.setTimeout(() => beamNow(false), LASER_EVERY_MS)
    wake()
  }

  /**
   * The predicted tip for one's own pointer: the browser's prediction, or one
   * average step ahead of the last samples, exactly as for a stroke
   * (`foresee`). No further than one sample step and `TIP_MAX_PX`: a
   * prediction that overtakes the hand sticks out like a whisker on a turn,
   * and on a glowing line five times thicker than ink it is seen at once.
   */
  function foreseeLaser(event: PointerEvent): { x: number; y: number } | null {
    const last = ownBack[ownBack.length - 1]
    if (!last) return null
    const told = typeof event.getPredictedEvents === 'function' ? event.getPredictedEvents() : []
    let ahead: { x: number; y: number } | null = null
    if (told.length > 0) ahead = at(told[told.length - 1])
    else if (ownBack.length >= 3) {
      const back = ownBack[ownBack.length - 3]
      ahead = { x: last.x + (last.x - back.x) / 2, y: last.y + (last.y - back.y) / 2 }
    }
    if (!ahead) return null
    // In px of the glass: the sheet times the zoom.
    const before = ownBack[ownBack.length - 2]
    const step = before ? Math.hypot((last.x - before.x) * w, (last.y - before.y) * h) * near : 0
    const reach = Math.hypot((ahead.x - last.x) * w, (ahead.y - last.y) * h) * near
    const limit = Math.min(TIP_MAX_PX, step * 1.5)
    if (reach <= 0.5 || limit <= 0.5) return null
    const k = reach > limit ? limit / reach : 1
    return { x: round(last.x + (ahead.x - last.x) * k), y: round(last.y + (ahead.y - last.y) * k) }
  }

  /**
   * What the press has gathered: into the wire. `final` (the press itself,
   * the release, the end of a shape) sends everything; otherwise a pointer
   * standing still with a trembling hand waits (laser.ts · `LASER_STAND`).
   */
  function beamNow(final: boolean): void {
    window.clearTimeout(spotTimer)
    spotTimer = undefined
    // A finger's beam waits for its window (`beamHeld`): the samples stay queued in the press.
    if (!press || beamHeld) return
    const frames = press.take(final, near)
    // On a closed socket the pointer frame is not queued: a hand's position
    // a second ago has nowhere to be delivered, while the places in the
    // sixteen-message queue belong to presses.
    if (session.connected) {
      for (const pts of frames) {
        session.send({
          t: 'laser',
          page: pressPage,
          x: pts[pts.length - 3],
          y: pts[pts.length - 2],
          shape: laserShape,
          mark: press.mark,
          trail: pressTrail,
          pts,
        })
      }
    }
    lit = true
  }

  /**
   * The pointer was released or the tool changed: `laser:off` once, our own
   * at once.
   *
   * `end` is where the pen left the glass (a real release, not a cancel). It
   * goes into the shape and out to the room BEFORE the "off", together with
   * everything still queued: the samples gathered since the last tick used to
   * be dropped here, and in the hall a quick underline ended a quarter of a
   * slide short of where the pen was lifted.
   */
  function beamOff(end?: { x: number; y: number; t: number }): void {
    window.clearTimeout(spotTimer)
    spotTimer = undefined
    const pressed = press !== null
    if (press && end) {
      const kept = press.add(end.x, end.y, end.t, h / w, near)
      if (kept) keepOwn(kept)
    }
    // A finger let go inside its window (`beamHeld`): a poke, not half of a
    // gesture, and the room gets all of it.
    window.clearTimeout(beamHeldTimer)
    beamHeldTimer = undefined
    beamHeld = false
    if (press) beamNow(true)
    press = null
    beaming = null
    tip = null
    ownBack = []
    if (lit) {
      lit = false
      session.send({ t: 'laser:off' })
    }
    // Our own, at once: waiting for the echo to put out OUR OWN pointer means
    // keeping it on screen one extra network round trip after the finger was
    // lifted. The shape stays behind to hold and burn down with its phrase:
    // it is exactly what one circles with the pointer for.
    const now = performance.now()
    if (pressed) phraseClock.lift(now)
    if (ownMark) {
      ownMark.letGo = now
      ownMark = null
    }
    if (!stream) head = null
    wake()
    syncBusy()
  }

  /* ----------------------------------------------------------- eraser */

  /** How long erased strokes stay hidden if the server says nothing. */
  const ERASE_GRACE_MS = 1200
  let forgetTimer: number | undefined
  /** Where the eraser was at the previous sample: we erase by segment, not by point. */
  let rubbed: { x: number; y: number } | null = null
  /** Offline already reported for this sweep. Cleared when the eraser lifts. */
  let erasingTold = false
  /**
   * A FINGER'S ERASE IS HELD BACK FROM THE ROOM for `TAP_TOGETHER_MS`, as its
   * stroke is (`openStroke`).
   *
   * A finger that comes down may be the first of two: an Undo tap or a pinch.
   * With the eraser armed it used to erase at the touch, for the whole hall:
   * a pinch over the ink (zooming in to erase precisely is exactly when one
   * pinches) took away every line its first finger crossed, and a two-finger
   * tap undid the erase its own first finger had just made instead of the
   * stroke before it. Now what a finger rubs in its first moments vanishes
   * here at once and is kept, not sent: when the window closes, or the finger
   * lifts alone, it goes out (`sendErase`); a second finger inside the window,
   * or a pen landing in it (the finger was the palm), and it shows again as if
   * it had never been touched (`forgetErase`). `wet` keeps the drying strokes
   * it took, to be put back.
   */
  let eraseHeld: { gesture: string; hits: { page: number; id: string }[]; wet: Wet[] } | null = null
  let eraseHeldTimer: number | undefined

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
      // The ring on screen and the reach are one number (ink.ts · `eraserReach`),
      // on the glass: the page is the sheet times the zoom wide there.
      const reach = eraserReach(stroke.width, w * near)
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
    if (eraseHeld) {
      // A finger's first moments: gone here, kept for the room (see `eraseHeld`).
      eraseHeld.hits.push(...hit.map((id) => ({ page, id })))
      eraseHeld.wet.push(...wet.filter((stroke) => hit.includes(stroke.id)))
    } else {
      for (const id of hit) session.send({ t: 'ink:erase', page, id, gesture: eraseGesture })
    }
    // Otherwise the wet copy of what was erased would stay until the echo,
    // that is, for a network round trip a line would live on that was just
    // removed in front of everyone.
    const dried = wet.filter((stroke) => !hit.includes(stroke.id))
    if (dried.length !== wet.length) {
      wet = dried
      rememberWet()
    }
    forgetLater()
  }

  /**
   * Show again, after `ERASE_GRACE_MS`, whatever was hidden here and never
   * confirmed by the server: what the server confirmed has already left the
   * ink, and what did not get through is more honest to show again than to
   * leave erased only for ourselves. Except what a straight line still held
   * under the pen replaces (`withheld`): the room has not been asked yet.
   */
  function forgetLater(): void {
    window.clearTimeout(forgetTimer)
    forgetTimer = window.setTimeout(() => {
      erased = withheld.size === 0 ? new Set() : new Set([...erased].filter((id) => withheld.has(id)))
      erasedSeen.clear()
    }, ERASE_GRACE_MS)
  }

  /** No second finger came: what the finger hid is erased for the room too, the rest as it goes. */
  function sendErase(): void {
    window.clearTimeout(eraseHeldTimer)
    eraseHeldTimer = undefined
    const held = eraseHeld
    eraseHeld = null
    if (!held || held.hits.length === 0) return
    // The connection went meanwhile: the eraser erases nothing, and says so (see `rub`).
    if (!session.connected) {
      unhide(held)
      if (!erasingTold) {
        erasingTold = true
        onrefuse?.(tr('room.ui.274'))
      }
      return
    }
    for (const hit of held.hits) {
      session.send({ t: 'ink:erase', page: hit.page, id: hit.id, gesture: held.gesture })
    }
    forgetLater()
  }

  /** A second finger or the pen came within the window: the finger's erase never happened. */
  function forgetErase(): void {
    window.clearTimeout(eraseHeldTimer)
    eraseHeldTimer = undefined
    const held = eraseHeld
    eraseHeld = null
    if (held) unhide(held)
    stopErase()
  }

  /** What a held erase hid shows again, its drying strokes back among the wet ones. */
  function unhide(held: NonNullable<typeof eraseHeld>): void {
    if (held.hits.length === 0) return
    const back = new Set(held.hits.map((hit) => hit.id))
    erased = new Set([...erased].filter((id) => !back.has(id)))
    for (const id of back) erasedSeen.delete(id)
    if (held.wet.length > 0) {
      wet = [...wet, ...held.wet]
      rememberWet()
    }
  }

  /** The eraser lifts, or the tool changes: what a finger still held back stands, and goes first. */
  function stopErase(): void {
    sendErase()
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
   * One of the two things fingers on the sheet mean when there is a pen (the
   * other is the pinch, below, and it waits for this one to be ruled out).
   * Everything else is the palm: it rests, creeps, lifts off and lands
   * again, and any other reading of fingers sooner or later fires from it.
   * The conditions are strict precisely for that reason (ink.ts · `twoFingerTap`): two
   * touches ON THE GLASS AT ONCE, landing within a quarter of a second and
   * lifting together, neither held nor moved, the pen not in contact and not
   * touching the sheet in the last half second; a palm does not behave like
   * that while one writes, and neither does one finger tapping twice.
   */
  const TAP_SLACK_PX = 12
  const TAP_AFTER_PEN_MS = 600
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
    const done = taps.filter((known) => known.up !== null)
    if (done.length < 2) return
    if (!twoFingerTap(done[done.length - 2], done[done.length - 1])) return
    taps = []
    onundo?.()
  }

  /* -------------------------------------------------------------- pinch */

  /*
   * TWO FINGERS THAT SPREAD, CLOSE OR SLIDE MOVE THE ZOOM, for the presenter
   * only (`onzoom`), and the hall sees the same region.
   *
   * The console used to forbid it outright: "drawing on a magnified piece
   * means not knowing where the stroke will land on the projector". With the
   * zoom mirrored, the objection is gone: the projector shows exactly the
   * magnified piece. What is left is the palm, which must not zoom any more
   * than it may write or undo, and a pinch's own test is a few pixels of
   * spread, which a settling hand gives at once. So the pinch is guarded
   * harder than the tap:
   *  — fingers only, never the pen, never a palm-sized contact; and only two
   *    fingers that LANDED TOGETHER, with no palm on the glass and the pen not
   *    near, hover included (ink.ts · `pinchMayStart`). A palm is kept count
   *    of while it rests (`palms`) rather than ignored: the heel lying on the
   *    glass is what gives away its pinky and knuckles as the hand's;
   *  — a pinch finger is judged again on every move: a heel whose first patch
   *    was small spreads past a palm's size as it settles, and then the pair
   *    was the hand all along (`palmPinch`);
   *  — and it COMMITS late (ink.ts · `pinchCommits`): until the fingers have
   *    spread by a tenth or slid by sixteen pixels, they still belong to the
   *    two-finger tap, which is Undo. Once committed, the tap is cancelled.
   *    What the first finger had begun, the room never saw: landing together,
   *    the second finger came within the window for which a finger's stroke,
   *    erase and beam are held back, and `down` forgot them (`forgetFirst`).
   *
   * The view is computed from where it was when the second finger landed
   * (ink.ts · `pinchZoom`), never step by step, and handed to the parent per
   * move (`onzoom(next, false)`) and once more when a finger lifts (`final`).
   */
  /** Fingers on the sheet: where they are now, in screen px, and when they landed. */
  const fingers = new Map<number, { x: number; y: number; down: number }>()
  /**
   * Palm-sized contacts on the glass: those that landed so, and pinch fingers
   * that grew so. While one rests, no two fingers start a pinch.
   */
  const palms = new Set<number>()
  /** Fingers left over from a pinch: they do nothing more until they lift. */
  const spent = new Set<number>()
  /** Pens touching the glass now. */
  const pens = new Set<number>()
  interface Pinch {
    /** The first finger: whatever it began has been forgotten (`forgetFirst`). */
    a: number
    /** The second finger: reserved for the gesture from the moment it lands. */
    b: number
    /** The sheet on screen: the zoom happens inside it, it does not move. */
    frame: DOMRect
    /** The view the hall saw when the second finger landed. */
    from: LectureZoom | null
    start: FingerPair
    committed: boolean
    /** The latest view the fingers asked for. */
    last: LectureZoom | null
  }
  let pinch: Pinch | null = null

  /**
   * The pen writes, or was near the glass a moment ago: two fingers now are
   * the palm.
   *
   * HOVER COUNTS HERE, unlike for the tap (`penSeen`). A hand resting while
   * the presenter talks keeps the Pencil hovering over the glass, and its
   * pinky and knuckles, small contacts that creep, passed a guard of contact
   * alone and zoomed the hall around the palm. The window is the tap's short
   * one, so a pinch right after writing stays possible once the pen is
   * lifted away; the price is a pinch with one hand while the other holds the
   * Pencil hovering over the sheet, which waits for the pen to go.
   */
  function penNear(): boolean {
    return pens.size > 0 || performance.now() - lastPenNearAt < TAP_AFTER_PEN_MS
  }

  /**
   * A pointer came down: count the finger (or the palm), and start a pinch if
   * it is the second free finger and the pair may be one. Returns whether this
   * pointer is now reserved for the gesture (it then does nothing else). A pen
   * coming down ends any pinch: the pen always wins, and the view stays where
   * the fingers left it.
   */
  function pinchDown(event: PointerEvent): boolean {
    if (event.pointerType === 'pen') {
      pens.add(event.pointerId)
      if (pinch?.committed) endPinch()
      else dropPinch()
      return false
    }
    if (event.pointerType !== 'touch') return false
    if (palmish(event)) {
      palms.add(event.pointerId)
      // The hand came to rest: the two "fingers" still waiting to move are its own.
      if (pinch && !pinch.committed) dropPinch()
      return false
    }
    const landed = performance.now()
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY, down: landed })
    if (!onzoom) return false
    if (pinch) {
      // A third finger: a committed pinch ignores it; a candidate was not a pinch.
      if (pinch.committed) {
        spent.add(event.pointerId)
        return true
      }
      dropPinch()
      return false
    }
    const free = [...fingers.keys()].filter((id) => !spent.has(id))
    if (free.length !== 2) return false
    const a = free[0] === event.pointerId ? free[1] : free[0]
    const first = fingers.get(a)
    if (!first || !pinchMayStart(landed - first.down, palms.size, penNear())) return false
    const frame = frameNode?.getBoundingClientRect()
    if (!frame || frame.width === 0 || frame.height === 0) return false
    pinch = {
      a,
      b: event.pointerId,
      frame,
      from: zoom.shown,
      start: fingerPair(first, { x: event.clientX, y: event.clientY }),
      committed: false,
      last: zoom.shown,
    }
    return true
  }

  /**
   * A finger moved. Returns whether the move is the pinch's: the reserved
   * finger's always, the first finger's once the pinch has committed, and any
   * spent finger's.
   */
  function pinchMove(event: PointerEvent): boolean {
    const finger = fingers.get(event.pointerId)
    if (!finger) return false
    finger.x = event.clientX
    finger.y = event.clientY
    const held = pinch
    if (!held || (event.pointerId !== held.a && event.pointerId !== held.b)) return spent.has(event.pointerId)
    // A pinch finger spread to a palm's size: the pair was the resting hand.
    if (palmish(event)) {
      palms.add(event.pointerId)
      palmPinch(held)
      return true
    }
    const a = fingers.get(held.a)
    const b = fingers.get(held.b)
    if (!a || !b) return event.pointerId === held.b
    const now = fingerPair(a, b)
    if (!held.committed) {
      if (!pinchCommits(held.start, now)) return event.pointerId === held.b
      // The pen touched or came near the glass since the second finger landed: the palm after all.
      if (penNear()) {
        dropPinch()
        return event.pointerId === held.b
      }
      commitPinch(held)
    }
    const next = pinchZoom(held.from, held.frame, held.start, now)
    if (!sameZoom(next, held.last)) {
      held.last = next
      onzoom?.(next, false)
    }
    return true
  }

  /**
   * The fingers became a pinch: no Undo. What the first finger began was
   * forgotten when the second landed (`forgetFirst`); should anything of it
   * still stand, held work is forgotten too, and a stroke is taken back only
   * if a pinch could have begun it (ink.ts · `mayTakeBack`), or else finished
   * as the ink it is.
   */
  function commitPinch(held: Pinch): void {
    held.committed = true
    for (const tap of taps) if (tap.pointer === held.a || tap.pointer === held.b) tap.moved = true
    const stroke = drawing?.pointer === held.a ? drawing.stroke : null
    if (stroke) {
      if (mayTakeBack(stroke.points, performance.now() - stroke.bornAt, w * near, h * near)) takeBack()
      else closeStroke()
    }
    if (erasing === held.a) {
      if (eraseHeld) forgetErase()
      else stopErase()
    }
    if (beaming === held.a) {
      if (beamHeld) dropBeam()
      else beamOff()
    }
    if (framing?.pointer === held.a) cancelFrame()
    syncBusy()
  }

  /** A candidate that never became a pinch: the reserved finger stays idle until it lifts. */
  function dropPinch(): void {
    if (!pinch) return
    if (fingers.has(pinch.b)) spent.add(pinch.b)
    pinch = null
  }

  /**
   * A pinch finger turned out to be the palm: the pair was the resting hand,
   * and no gesture at all. A candidate simply goes. A committed pinch has
   * already moved the hall: the view goes back to where the fingers found it,
   * said as final. Both are spent, and neither is half of a tap.
   */
  function palmPinch(held: Pinch): void {
    pinch = null
    for (const id of [held.a, held.b]) if (fingers.has(id)) spent.add(id)
    for (const tap of taps) if (tap.pointer === held.a || tap.pointer === held.b) tap.moved = true
    if (held.committed) onzoom?.(held.from, true)
    syncBusy()
  }

  /** The pinch is over: the view stays where the fingers left it, said once more as final. */
  function endPinch(): void {
    const held = pinch
    if (!held) return
    pinch = null
    for (const id of [held.a, held.b]) if (fingers.has(id)) spent.add(id)
    if (held.committed) onzoom?.(held.last, true)
    syncBusy()
  }

  /**
   * A pointer lifted (or was cancelled). Returns whether the lift was the
   * pinch's: the tool must not act on it.
   */
  function pinchUp(event: PointerEvent): boolean {
    if (event.pointerType === 'pen') {
      pens.delete(event.pointerId)
      return false
    }
    palms.delete(event.pointerId)
    if (!fingers.delete(event.pointerId)) return false
    const idle = spent.delete(event.pointerId)
    const held = pinch
    if (!held || (event.pointerId !== held.a && event.pointerId !== held.b)) return idle
    if (held.committed) {
      endPinch()
      spent.delete(event.pointerId)
      return true
    }
    // A candidate that never moved enough: a tap, or nothing. The first
    // finger's lift is its tool's, as usual; the reserved one did nothing.
    const reserved = event.pointerId === held.b
    if (reserved) pinch = null
    else dropPinch()
    return reserved
  }

  /* ------------------------------------------------------ magnifier */

  /**
   * THE MAGNIFIER'S FRAME (`tool === 'zoom'`): drag a rectangle over what
   * should fill the sheet, and on the lift the view goes there; a tap
   * without a drag comes twice as close around the point (ink.ts ·
   * `frameZoom`). Relative to the view the presenter sees: a frame drawn on a
   * magnified detail magnifies further. It never draws ink, and the parent
   * gives the previous tool back once it has been used, so that one can write
   * on the magnified detail at once.
   */
  let framing: {
    pointer: number
    byFinger: boolean
    /** Where the press came down and where the pointer is now, in page fractions. */
    from: { x: number; y: number }
    to: { x: number; y: number }
    /** Where it came down on the glass: a press that travels less than `FRAME_TAP_PX` is a tap. */
    downX: number
    downY: number
    moved: boolean
  } | null = null

  function frameStart(event: PointerEvent, place: { x: number; y: number }): void {
    framing = {
      pointer: event.pointerId,
      byFinger: event.pointerType === 'touch',
      from: place,
      to: place,
      downX: event.clientX,
      downY: event.clientY,
      moved: false,
    }
    ring = null
    wake()
    syncBusy()
  }

  function frameMove(event: PointerEvent): void {
    if (!framing) return
    const place = at(event)
    if (place) framing.to = place
    if (!framing.moved && Math.hypot(event.clientX - framing.downX, event.clientY - framing.downY) > FRAME_TAP_PX) {
      framing.moved = true
    }
    wake()
  }

  /** The frame was let go: the view goes where it says. Not on a cancel: a frame cut short asks for nothing. */
  function frameEnd(event: PointerEvent, cancelled: boolean): void {
    const done = framing
    if (!done) return
    framing = null
    wake()
    syncBusy()
    if (cancelled) return
    const place = (done.moved ? at(event) : null) ?? done.to
    onzoom?.(frameZoom(zoom.shown, done.from, done.moved ? place : null), true)
  }

  function cancelFrame(): void {
    if (!framing) return
    framing = null
    wake()
    syncBusy()
  }

  /* ---------------------------------------------- straight on hold */

  /**
   * HOLD THE PEN AT THE END AND THE LINE STRAIGHTENS, as in drawing apps.
   *
   * An underline, an axis, a fraction bar: freehand, they wobble on the
   * projector at three metres wide. Now the pen that rests, still pressed,
   * for `STRAIGHT_HOLD_MS` turns the stroke into a straight segment from its
   * first point to where the pen rests, if the stroke already was a line
   * (ink.ts · `straightens`: a bracket or an arc under a resting hand stays
   * as drawn). Moving the pen before lifting moves the end; the lift
   * finalises (`closeStroke`): the room takes the freehand motion back and
   * gets the line as a stroke of its own, so one Undo removes the line.
   *
   * On a timer, not on movement: a pen standing perfectly still may send no
   * events at all.
   *
   * THE RULE IS SHOWN, NOT ONLY KEPT (`holdRing`, the console's): while a
   * stroke that would straighten rests under the pen, a ring closes round
   * the tip and is full at the moment the line snaps. A rule nobody can see
   * is found out by accident, in front of the hall; and "how long is long
   * enough" is learnt by watching the ring, not from a manual nobody opens
   * in the middle of a lecture.
   */
  let still: { x: number; y: number } | null = null
  let stillTimer: number | undefined
  /** When the pen came to rest on `still`: the ring counts from this moment, like the line. */
  let stillSince = 0
  /** The ring waits out the first moments of a rest (ink.ts · `HOLD_RING_AFTER_MS`). */
  let holdTimer: number | undefined
  /** This rest's stroke would straighten, so the ring may promise it (see `holdCheck`). */
  let holdFits = false
  /** Where and when the line straightened: its closed ring goes out right there. */
  let holdSnapped: { page: number; x: number; y: number; at: number } | null = null

  /** The drawing pen is at `x, y` on the glass: moving off its resting spot starts the wait over. */
  function restAt(x: number, y: number): void {
    if (!straighten || !drawing || drawing.replaced) return
    if (still && Math.hypot(x - still.x, y - still.y) <= STRAIGHT_STILL_PX) {
      // Still resting, but the stroke under a showing ring may have changed:
      // a trembling tip adds points, and the promise is judged again.
      if (holdRing && holdTimer === undefined && stillTimer !== undefined) holdCheck()
      return
    }
    still = { x, y }
    stillSince = performance.now()
    window.clearTimeout(stillTimer)
    stillTimer = window.setTimeout(straightenNow, STRAIGHT_HOLD_MS)
    // The pen moved on: the last rest's ring goes at once, the next one waits its turn.
    holdHide()
    window.clearTimeout(holdTimer)
    holdTimer = holdRing ? window.setTimeout(holdCheck, HOLD_RING_AFTER_MS) : undefined
  }

  function unrest(): void {
    window.clearTimeout(stillTimer)
    stillTimer = undefined
    window.clearTimeout(holdTimer)
    holdTimer = undefined
    still = null
    holdHide()
  }

  /** What straightening a stroke takes (see `straightPlan`). */
  interface Straight {
    /** The whole motion's points, its first piece first: the line starts where they do. */
    points: number[]
    /** Its pieces still drying here: the line takes their place among the wet strokes. */
    drying: Wet[]
    /** Its pieces the room already has: taken back on the lift. */
    out: { id: string; page: number }[]
  }

  /**
   * What straightening the held stroke takes, or `null` when it would not
   * straighten now.
   *
   * ONE JUDGEMENT for the line and for the ring that promises it: a ring that
   * closes over a stroke which then stays as drawn lies to the hand, and a
   * hand lied to once stops looking at the ring.
   */
  function straightPlan(held: Drawing): Straight | null {
    if (!straighten || held.replaced || (tool !== 'pen' && tool !== 'marker')) return null
    const stroke = held.stroke
    const key = groupOf(stroke)
    // Every piece of the motion: a long one may already be several strokes,
    // some still drying here, some only in the room's ink.
    const drying = wet.filter((piece) => piece.page === stroke.page && groupOf(piece) === key)
    const ids = new Set(drying.map((piece) => piece.id))
    const landed = session.ink.filter(
      (piece) => piece.page === stroke.page && groupOf(piece) === key && !ids.has(piece.id),
    )
    const pieces: { id: string; page: number; points: number[]; handed: number }[] = [
      ...landed.map((piece) => ({ id: piece.id, page: piece.page, points: piece.points, handed: piece.points.length })),
      ...drying,
    ]
    pieces.sort((p, q) => (p.id === key ? -1 : q.id === key ? 1 : 0))
    const points = pieces.flatMap((piece) => piece.points)
    if (!straightens(points, held.tip, w * near, h * near)) return null
    // What the room has must be taken back on the lift; without a connection
    // that cannot be promised, and the freehand line stays as it is.
    const out = pieces.filter((piece) => piece.handed > 0)
    if (out.length > 0 && !session.connected) return null
    return { points, drying, out }
  }

  /**
   * Whether this rest shows the ring: its stroke would straighten now. Asked
   * once the rest has lasted `HOLD_RING_AFTER_MS`, and again whenever the
   * pen stirs within it, not every frame: a frame only draws what was
   * decided here.
   */
  function holdCheck(): void {
    holdTimer = undefined
    const held = drawing
    const fits =
      holdRing && held !== null && still !== null && stillTimer !== undefined && straightPlan(held) !== null
    if (fits === holdFits) return
    holdFits = fits
    wake()
  }

  /** The ring of this rest goes, at once: the pen moved on, lifted, or the stroke was taken back. */
  function holdHide(): void {
    if (!holdFits) return
    holdFits = false
    wake()
  }

  /**
   * The hold ring this frame draws, and where, or `null` (ink.ts ·
   * `holdRingAt` keeps the time). Round the tip while the rest goes on; once
   * the line has snapped, full and fading where it snapped, even if the pen
   * is lifted or drags the line's end away meanwhile: it says "done" in the
   * place where it was done. Ours only: it is drawn on the live canvas,
   * which nobody else sees, and goes nowhere.
   */
  function holdShown(now: number): (HoldRing & { x: number; y: number }) | null {
    if (!live || !holdRing) return null
    if (holdSnapped && holdSnapped.page === page) {
      const going = holdRingAt(now, 0, holdSnapped.at)
      if (going) return { ...going, x: holdSnapped.x, y: holdSnapped.y }
    }
    const held = drawing
    if (!straighten || !holdFits || !held || !still || held.replaced) return null
    if (held.stroke.page !== page || (tool !== 'pen' && tool !== 'marker')) return null
    const closing = holdRingAt(now, stillSince)
    return closing ? { ...closing, x: held.tip.x, y: held.tip.y } : null
  }

  /** The pen has rested long enough: if the stroke is a line, it becomes a straight one. */
  function straightenNow(): void {
    stillTimer = undefined
    // The ring's count is over either way: it steps aside for the line, or goes.
    const promised = holdFits
    holdFits = false
    const held = drawing
    const plan = held ? straightPlan(held) : null
    if (!held || !plan) {
      if (promised) wake()
      return
    }
    const stroke = held.stroke
    const { points, drying, out } = plan
    const ids = new Set(drying.map((piece) => piece.id))
    window.clearTimeout(flushTimer)
    flushTimer = undefined
    const line: Wet = {
      id: newStrokeId(),
      page: stroke.page,
      color: stroke.color,
      width: stroke.width,
      points: [points[0], points[1], held.tip.x, held.tip.y],
      force: [stroke.force[0] ?? 0, stroke.force[stroke.force.length - 1] ?? 0],
      handed: 0,
      // As old as the motion: `dropPalm` judges a stroke's age by it.
      bornAt: Math.min(...drying.map((piece) => piece.bornAt)),
      closed: false,
      closedAt: 0,
      resent: 0,
      echoed: false,
      tail: { n: 0, curved: 0, tipX: points[0] * w, tipY: points[1] * h },
      straight: true,
    }
    held.replaced = out.map((piece) => ({ page: piece.page, id: piece.id }))
    held.stroke = line
    for (const piece of held.replaced) withheld.add(piece.id)
    if (held.replaced.length > 0) erased = new Set([...erased, ...held.replaced.map((piece) => piece.id)])
    wet = [...wet.filter((piece) => !ids.has(piece.id)), line]
    guess = null
    if (promised) holdSnapped = { page: stroke.page, x: held.tip.x, y: held.tip.y, at: performance.now() }
    rememberWet()
    paintWetAll()
    paintMarkers()
    wake()
  }

  /** The straight line's end follows the pen until the lift. */
  function moveEnd(place: { x: number; y: number }): void {
    const held = drawing
    if (!held?.replaced) return
    held.tip = place
    held.stroke.points[2] = place.x
    held.stroke.points[3] = place.y
    growWet(held.stroke)
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

  /**
   * TWO FINGERS LANDING TOGETHER ARE A GESTURE, NOT INK: an Undo tap, or a
   * pinch. A second finger has just landed; whatever the first one began and
   * is still holding back from the room is forgotten, as if it never was.
   * Returns whether something was, and then the second finger starts nothing.
   *
   * Everything a finger does waits `TAP_TOGETHER_MS` for exactly this: its
   * stroke's first points (`openStroke`), its erase (`eraseHeld`), its beam
   * (`beamHeld`). It used to be the stroke alone. The first finger of a
   * two-finger tap had already put a dot, and the tap's Undo raced it on the
   * server against the real previous stroke; with the eraser armed it erased
   * the ink under it for the hall, and with the pointer it drew a red squiggle
   * there, for every pinch.
   */
  function forgetFirst(): boolean {
    if (drawing?.byFinger && drawing.stroke.handed === 0 && !drawing.replaced) {
      const first = taps.find((tap) => tap.pointer === drawing?.pointer)
      if (first && performance.now() - first.down <= TAP_TOGETHER_MS) {
        forgetUnsent()
        return true
      }
    }
    if (erasing !== null && eraseHeld) {
      forgetErase()
      return true
    }
    if (beaming !== null && beamHeld) {
      dropBeam()
      return true
    }
    return false
  }

  function down(event: PointerEvent): void {
    measure()
    // The heel of the palm is not a finger and does not count towards a
    // two-finger tap: a tap is two SMALL touches, while the heel plus the
    // little finger is exactly the pair that used to be taken for undo.
    if (event.pointerType === 'touch' && !palmish(event)) tapDown(event)
    // The second finger of a pinch is the gesture's from the moment it lands.
    const reserved = pinchDown(event)
    // A second finger, landed with the first: the first one's work never was.
    // Before `mine`: with the finger off, the first may be leading the beam.
    if (event.pointerType === 'touch' && !palmish(event) && forgetFirst()) return
    if (!mine(event)) return
    const place = at(event)
    if (!place) return
    // A second finger is not a frame: the magnifier is a one-finger gesture,
    // and two fingers are Undo or a pinch, never both that and a zoom step.
    if (framing?.byFinger && event.pointerType === 'touch') {
      cancelFrame()
      return
    }
    if (reserved || spent.has(event.pointerId)) return
    event.preventDefault()
    capture(event)
    if (tool === 'zoom') {
      // The pen takes the frame over from a finger, as it takes the beam.
      if (framing?.byFinger && event.pointerType !== 'touch') cancelFrame()
      if (!framing) frameStart(event, place)
      return
    }
    if (tool === 'laser') {
      // The beam is already led by another pointer: the pen takes it from a
      // finger (the pen always wins), a finger from the pen never. Otherwise
      // a second touch dragged the pointer's head to itself mid-show.
      if (beaming !== null && beaming !== event.pointerId) {
        if (event.pointerType === 'touch') return
      }
      // The pen takes the beam over from a finger: the finger's press ends
      // here, with its shape let go whole, and the pen's starts afresh. A
      // finger's beam still held back was the palm, and goes as if never lit.
      if (beaming !== null) {
        if (beamHeld) dropBeam()
        else beamOff()
      }
      // The first touch, at once: a pointer appearing forty milliseconds
      // after it was pressed feels stuck. A finger's goes to the room a
      // moment later (`beamHeld`).
      beaming = event.pointerId
      beamingByFinger = event.pointerType === 'touch'
      ring = null
      beamStart(event, place)
      // And the pixel too, in this same handler, without waiting for a frame:
      // the pointer's cold start is measured from the press to the first red.
      paintLive(performance.now())
      syncBusy()
      return
    }
    if (tool === 'eraser') {
      // A pen landing on a finger's held erase: the finger was the palm.
      if (eraseHeld) forgetErase()
      erasing = event.pointerId
      eraseGesture = `e${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
      window.clearTimeout(eraseHeldTimer)
      eraseHeldTimer = undefined
      if (event.pointerType === 'touch') {
        eraseHeld = { gesture: eraseGesture, hits: [], wet: [] }
        eraseHeldTimer = window.setTimeout(sendErase, TAP_TOGETHER_MS)
      }
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
      dropPalm()
      if (drawing) return
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
    restAt(event.clientX, event.clientY)
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
    if (event.pointerType === 'touch') {
      tapMove(event)
      if (pinchMove(event)) return
    }
    /*
     * The pen is alive while it moves, not only while it goes down: the "pen
     * seen" time used to be set only on touch, and after a stroke lasting a
     * second and a half the two-finger tap guard thought there had been no
     * pen for a second and a half: the heel and the little finger, landing
     * 120 ms after a letter, undid it for the whole audience. Only IN
     * CONTACT does it start that pause (`penSeen` checks): Pencil hovers above
     * the glass the whole time the hand is over the tablet, and if hovering
     * counted two fingers would never undo anything.
     */
    penSeen(event)
    // A hovering pen is not on the glass, whatever lift the layer missed.
    if (event.pointerType === 'pen' && event.buttons === 0) pens.delete(event.pointerId)
    // One's own stroke continues with its own pointer, whatever changes
    // around it: a spring-loaded pointer on a key does not cut a letter off
    // in the middle.
    if (drawing && drawing.pointer === event.pointerId) {
      event.preventDefault()
      if (drawing.replaced) {
        const place = at(event)
        if (place) moveEnd(place)
        return
      }
      let reached: { x: number; y: number } | null = null
      for (const step of samples(event)) {
        const place = at(step)
        if (!place) continue
        addPoint(place, step.pressure)
        reached = place
      }
      if (!drawing) return
      if (reached) drawing.tip = reached
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
      // The line under the pen: in this same frame, not after a round trip to
      // the server. After the prediction: a marker's tip is part of its path.
      growWet(drawing.stroke)
      wake()
      restAt(event.clientX, event.clientY)
      measureLatency(event.timeStamp)
      schedule()
      return
    }
    if (framing && framing.pointer === event.pointerId) {
      event.preventDefault()
      frameMove(event)
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
      beamMove(event)
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
    const theirs = pinchUp(event)
    penSeen(event)
    if (drawing && drawing.pointer === event.pointerId) {
      if (event.type === 'pointerup') {
        const place = at(event)
        if (place && drawing.replaced) moveEnd(place)
        else if (place) {
          addPoint(place, event.pressure)
          if (drawing) growWet(drawing.stroke)
        }
      }
      closeStroke()
      return
    }
    if (theirs) return
    if (framing && framing.pointer === event.pointerId) {
      frameEnd(event, event.type !== 'pointerup')
      return
    }
    if (beaming === event.pointerId) {
      /*
       * The pen was lifted: the beam is off, and without any burn-down:
       * hovering no longer picks it up, so there is nothing left to put out
       * "just in case after 300 ms". The circled shape stays standing,
       * though: see `beamOff`. A real lift ends the shape where the pen left
       * the glass; a cancel has no such place.
       */
      const place = event.type === 'pointerup' ? at(event) : null
      beamOff(place ? { x: place.x, y: place.y, t: event.timeStamp } : undefined)
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
    if (framing && framing.pointer === event.pointerId) return
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
   *
   * With the input gone (`live` off, no tool) the layer hears no more lifts:
   * the fingers and pens it counted are forgotten, and a pinch in progress
   * ends where it stands, said as final.
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
        cancelFrame()
        endPinch()
        fingers.clear()
        palms.clear()
        spent.clear()
        pens.clear()
        taps = []
        return
      }
      if (now !== 'laser' && before !== 'laser' && now !== before) closeStroke()
      if (now !== 'laser') beamOff()
      if (now !== 'eraser' && (erasing !== null || ring)) stopErase()
      if (now !== 'zoom') cancelFrame()
    })
  })

  /*
   * The parent turned the finger off (a pen was found): the finger's stroke
   * is finished, or, if it is the palm that landed a moment before the pen,
   * taken back (`dropPalm`). A finger leading the pointer lets go of it: from
   * now on a finger leads nothing, and frames nothing. What a finger still
   * held back from the room (a beam, an erase) was that palm too: it goes as
   * if it never was.
   */
  $effect(() => {
    const on = finger
    untrack(() => {
      if (on) return
      if (drawing?.byFinger) dropPalm()
      if (beaming !== null && beamingByFinger) {
        if (beamHeld) dropBeam()
        else beamOff()
      }
      if (eraseHeld) forgetErase()
      if (framing?.byFinger) cancelFrame()
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
  let wasPage: number | null = null
  $effect(() => {
    const now = page
    untrack(() => {
      const turned = wasPage !== null && wasPage !== now
      wasPage = now
      if (drawing && drawing.stroke.page !== now) closeStroke()
      /*
       * A frame or a pinch belongs to the page it began on: the new page
       * starts at the whole page (the server resets the zoom on a turn). A
       * pinch caught by the turn says so once, as final, so that whoever
       * follows it stops following.
       */
      if (turned) {
        cancelFrame()
        if (pinch) {
          const held = pinch
          pinch = null
          for (const id of [held.a, held.b]) if (fingers.has(id)) spent.add(id)
          if (held.committed) onzoom?.(null, true)
          syncBusy()
        }
      }
      /*
       * One's own pointer held across the turn: what was gathered goes out
       * labelled with the OLD page, and the press continues on the new one as
       * a new shape, from the same spot under the pen.
       */
      if (press && pressPage !== now) {
        // A finger's beam still held back goes out too, on its own page.
        sendBeam()
        beamNow(true)
        const next = newMarkId()
        rememberOwn(next)
        press.roll(next)
        pressPage = now
        const last = press.last
        ownMark = laserShape === 'line' && last ? newMark(next, now, [last.x, last.y], pressTrail) : null
        if (ownMark) ownMark.shown = 1
        if (last) head = { page: now, x: last.x, y: last.y }
      }
      // Someone else's press on the old page is over for us.
      if (stream && stream.page !== now) {
        stream = null
        streamMark = null
      }
      // The page changed: the previous one's trail does not melt before one's
      // eyes but leaves together with it; on the new sheet it has nowhere to
      // come from.
      if ((head && head.page !== now) || marks.some((mark) => mark.page !== now)) {
        if (head && head.page !== now) head = null
        const kept: Mark[] = []
        for (const mark of marks) {
          if (mark.page === now) kept.push(mark)
          else unbake(mark)
        }
        marks = kept
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
      get hold(): { closed: number; alpha: number; x: number; y: number } | null {
        return holdDrawn ? { closed: holdDrawn.closed, alpha: holdDrawn.alpha, x: holdDrawn.x, y: holdDrawn.y } : null
      },
    }
  }

  // The tab was closed mid-stroke: we take the timers with us, and give the
  // pointer's bitmaps back.
  $effect(() => () => {
    window.clearTimeout(flushTimer)
    window.clearTimeout(spotTimer)
    window.clearTimeout(settleTimer)
    window.clearTimeout(forgetTimer)
    window.clearTimeout(stillTimer)
    window.clearTimeout(holdTimer)
    window.clearTimeout(eraseHeldTimer)
    window.clearTimeout(beamHeldTimer)
    if (liveFrame !== undefined) cancelAnimationFrame(liveFrame)
    for (const mark of marks) unbake(mark)
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

  const cursor = $derived(
    tool === 'laser' || tool === 'eraser' ? 'none' : tool === 'zoom' ? 'zoom-in' : 'crosshair',
  )
  /** How the canvases are moved while the view travels: as the page's own bitmap is (zoom.ts · `zoomCss`). */
  const moved = $derived(zoom.css || null)
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

  Under a moving zoom EACH canvas carries the transform, not a wrapper: a
  transformed wrapper would be a stacking context of its own, and the marker
  canvas would multiply with that empty wrapper instead of with the page. The
  page box only clips, with `overflow: hidden`, which isolates nothing. The
  input layer stays outside the clip: it reaches over the margins.
-->
<div class="pointer-events-none absolute inset-0">
  <div bind:this={frameNode} class="ink-page absolute inset-0 overflow-hidden" style="width: {w}px; height: {h}px">
    <canvas
      bind:this={markerCanvas}
      class="ink ink-mark absolute inset-0 h-full w-full select-none"
      style:transform={moved}
    ></canvas>
    <canvas
      bind:this={dryCanvas}
      class="ink ink-dry absolute inset-0 h-full w-full select-none"
      style:transform={moved}
    ></canvas>
    <canvas
      bind:this={wetCanvas}
      class="ink ink-wet absolute inset-0 h-full w-full select-none"
      style:transform={moved}
    ></canvas>
    <canvas
      bind:this={liveCanvas}
      class="ink ink-live absolute inset-0 h-full w-full select-none"
      style:transform={moved}
    ></canvas>
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
  /* The zoom's transform is a mapping of the page's corner: see `zoomCss`. */
  .ink-page canvas {
    transform-origin: 0 0;
  }
  /*
   * The highlighter multiplies with the page under it: yellow over white is
   * yellow, yellow over black text is black text. Where a screen cannot
   * blend, it is still drawn under the pen ink, so a marker never covers a
   * pen line either way. On a dark page LecturePage's
   * `[data-ink-backdrop='dark']` rule outranks this one with `screen`.
   */
  .ink-mark {
    mix-blend-mode: multiply;
  }
</style>
