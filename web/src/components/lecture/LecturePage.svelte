<!--
  One page, fitted into the space it is given.

  The reader stacks pages in a column and scrolls them; the lecture shows
  exactly one, whole. These are different tasks, and the second is simpler:
  no scrolling, just a rectangle and a sheet fitted into it.

  Fitted on BOTH sides, not by width: the projector is 16:9, while a slide
  can be 4:3 or A4, and a page fitted by width runs off the bottom of the
  screen, that is, the last line of the slide is invisible to the audience.
  The presenter does not notice: their tablet has a different aspect ratio.

  The component hands its own space outward: the ink must lie exactly on the
  sheet, not on the container around it, or it drifts off the text on any
  screen whose proportions differ from the page.

  ZOOM HAPPENS INSIDE THE SHEET (shared/lecture.ts · `LectureZoom`). The
  sheet keeps its size and its place, and a region of the page fills it, so
  the console, the projector and a student's laptop, each fitting the page
  its own way, all show the same region. This component owns the motion of
  the zoom and hands it to whatever lies over the sheet as a `ZoomView`
  (zoom.ts): the picture and the ink read the same view, and so cannot
  drift apart while it moves.

  And it says whether its picture is light or dark (`data-ink-backdrop`):
  the ink's highlighter multiplies with a light page and screens a dark
  one, and only the page knows which it painted (page-region.ts ·
  `InkBackdrop`).
-->
<script lang="ts">
  import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
  import { onDestroy, type Snippet, untrack } from 'svelte'
  import type { LectureZoom, SheetPaper } from '@shared/lecture'
  import { deviceKind } from '@/lib/device'
  import { acquirePage, releasePage } from '@/lib/pdf-pages'
  import {
    backdropOf,
    backdropOfColor,
    meanLuminance,
    PAPER_GROUND,
    paperMarks,
    regionBudget,
    regionViewport,
    SLIDE_GROUND,
    type InkBackdrop,
    type PaperMarks,
  } from './page-region'
  import { EARLY_MS, SheetZoom } from './sheet-zoom'
  import type { ZoomHow, ZoomView } from './zoom'

  interface Props {
    doc: PDFDocumentProxy | null
    page: number
    /**
     * What to lay over the sheet, exactly within its bounds.
     *
     * The sheet's size is passed inside rather than measured again there: the
     * ink layer must match the sheet pixel for pixel, and two measurements of
     * the same thing diverge, first by a frame, and on a tablet, where frames
     * come only as the tab happens to be visible, for good.
     *
     * The second argument is the zoom the picture under it is drawn at and
     * moved to (zoom.ts · `ZoomView`): the ink paints at `painted` and is
     * moved by `css`, exactly like the picture, or it slides off the text
     * for the length of every motion.
     */
    over?: Snippet<[{ w: number; h: number }, ZoomView]>
    /** Quieter and smaller: the next page on the console. */
    dim?: boolean
    /**
     * No shadow: the console draws the sheet and does the feathering around
     * the paper itself.
     *
     * `shadow-pop` is a #0F2D69 shadow plus a `line` ring. In the room it is
     * needed: there the sheet lies on a light `surface`, and without the ring
     * white paper merges with the background. On the console's night ground
     * it draws nothing (the four feathering steps on top of it cover the ring
     * anyway), and the price is a full repaint of the sheet every frame while
     * a pen moves across it.
     */
    bare?: boolean
    /**
     * Where to pin the sheet when it is shorter than the space it is given.
     *
     * The default is centred: the reader, the projection and the presenter's
     * column live that way, and we leave them alone. The console asks for
     * `top`: there the sheet's box is the whole rest of the screen, and 16:9
     * in it is shorter than the box; a sheet hanging in the centre would leave
     * an empty well above itself, and a hand reaching to write on the top line
     * of a slide would land in the middle of the tablet. The remainder goes
     * DOWN, under the notes strip and the "next" thumbnail (see `onfit`).
     */
    align?: 'center' | 'top'
    /**
     * How much the sheet took and how much is left.
     *
     * `rest` is the height of the well under the sheet inside the given box.
     * The console uses it to decide whether the notes peek strip fits there:
     * this is KNOWLEDGE OF THE SHEET, and a second measurement from outside
     * would disagree with it by a frame, making the strip flicker on every
     * rotation. Called only once there is a sheet (w > 0): before the aspect
     * ratio arrives the remainder equals the whole box, and that is not "room
     * for notes" but "we know nothing yet".
     */
    onfit?: (size: { w: number; h: number; rest: number }) => void
    /**
     * The page whose picture is ACTUALLY on the sheet now; `null` when the
     * sheet shows nothing yet.
     *
     * `page` is what was asked for, and between the two lies a render: on the
     * relay a heavy slide takes a second or more, and all that time the sheet
     * keeps the previous slide on purpose (see `buffer`). Whatever lies over
     * the sheet must follow THIS, not `page`: ink of the new page painted
     * over the old picture, and a live pen circling a formula of slide 6 that
     * lands on slide 7, is what the hall saw before.
     */
    onshown?: (page: number | null) => void
    /**
     * The part of `page` to show (shared/lecture.ts · `LectureZoom`), or
     * `null` / absent for the whole page. A target: the view travels to it
     * as `zoomHow` says, and a new page starts at its own zoom at once.
     */
    zoom?: LectureZoom | null
    /**
     * How the view reaches a new `zoom` (zoom.ts · `ZoomMotion`): `jump`
     * while the presenter's own fingers move it (any lag reads as dragging
     * through syrup), `ease` for a deliberate jump made here, `glide` for
     * targets that arrive over the wire. Those come either alone (the
     * magnifier, "whole slide": eased like a jump made here) or as the
     * stream of a pinch, twenty-five a second, which is chased
     * (sheet-zoom.ts · `STREAM_MS`).
     */
    zoomHow?: ZoomHow
    /** What a blank sheet (a negative page) is ruled with. Ignored on a slide. */
    paper?: SheetPaper
    /**
     * This sheet is the projection: a blank sheet's rules are drawn a little
     * stronger there (page-region.ts · `paperMarks`), to survive the
     * projector's contrast in a lit room.
     */
    projector?: boolean
  }

  let {
    doc,
    page,
    over,
    dim = false,
    bare = false,
    align = 'center',
    onfit,
    onshown,
    zoom = null,
    zoomHow = 'ease',
    paper = 'plain',
    projector = false,
  }: Props = $props()

  let box = $state<HTMLDivElement | null>(null)
  let canvas = $state<HTMLCanvasElement | null>(null)
  let room = $state({ w: 0, h: 0 })
  /**
   * The page's aspect ratio, from the page itself rather than from a guess.
   *
   * The default here used to be A4, and that was a mistake: lectures are read
   * from slides, and a slide is LANDSCAPE. A sheet drawn portrait before the
   * real dimensions arrived jumped on the very first frame, and on a projector
   * a full-screen jump is seen by the whole audience. Until we know, we draw
   * nothing: half a frame of emptiness is more honest than half a frame of
   * untruth.
   */
  let aspect = $state<number | null>(null)

  /**
   * How much space is given. Measured right away and then by the observer.
   *
   * Right away because ResizeObserver reports sizes in the rendering step,
   * and a tab may not have one: the browser does not render background tabs
   * at all. A projection opened as a second window that never got focus
   * stayed empty in that case: the size came only after someone clicked in
   * it.
   */
  function measure(node: HTMLElement): void {
    const rect = node.getBoundingClientRect()
    const next = { w: Math.round(rect.width), h: Math.round(rect.height) }
    if (next.w !== room.w || next.h !== room.h) room = next
  }

  $effect(() => {
    const node = box
    /*
     * The aspect ratio is read ON PURPOSE: it arrives together with the
     * document, that is, hundreds of milliseconds after the component appears
     * and certainly after the tree is inserted into the page. It is the only
     * moment known for sure to have something to measure, and it is also the
     * only one that works in a tab without rendering: there neither the size
     * observer nor frames come at all, and the projection is most often
     * exactly that, a second window that was never given focus.
     */
    void aspect
    if (!node) return
    /*
     * Three measurements of one space, and each covers its own case.
     *
     * Right away, for an ordinary re-render. In a microtask, for the first
     * frame: a child component's effect runs BEFORE the parent inserts its
     * tree into the document, an element outside the document has zero size,
     * and the first measurement honestly returns zero. By the observer, for
     * tablet rotation and Split View, where the size changes without any
     * re-render.
     */
    let alive = true
    measure(node)
    queueMicrotask(() => {
      if (alive) measure(node)
    })
    const watch = new ResizeObserver(() => measure(node))
    watch.observe(node)
    return () => {
      alive = false
      watch.disconnect()
    }
  })

  /**
   * THE PAGE IS FETCHED WITH RETRIES, AND BY ONE FUNCTION FOR BOTH EFFECTS.
   *
   * `getPage` is not "take it from an array" but "wait until this page's data
   * arrives": the document downloads in chunks, and on the ninth page of a
   * thirty-megabyte deck the chunk may well not be there yet. The refusal is
   * silent and final: the effect will not be called again, there is nothing
   * to call it, all its dependencies are in place. On the test bench this is
   * visible literally: "no page" at 256 ms and the next attempt only at
   * 1066 ms, and only because the aspect ratio arrived and the layout was
   * recomputed.
   *
   * Only one of the two effects had retries, and the aspect ratio, the one
   * without them, held the whole layout: the first page did not arrive,
   * `aspect` stayed null, `fit` was zero by zero, rendering never started
   * (`w === 0`), no error was set, and the projection stood empty without a
   * single word.
   *
   * Five attempts in a little over a second is about the network, not about
   * patience. `alive` is asked of the caller: the page may have changed
   * while we waited.
   *
   * A page that comes back is HELD (lib/pdf-pages.ts): the caller gives it
   * back with `releasePage` once it is done with it, or pdf.js keeps its
   * decoded images for the rest of the lecture.
   */
  async function sheetOf(
    source: PDFDocumentProxy,
    index: number,
    alive: () => boolean,
  ): Promise<PDFPageProxy | null> {
    for (let tries = 0; tries < 5 && alive(); tries += 1) {
      const sheet = await acquirePage(source, index)
      if (sheet) {
        if (alive()) return sheet
        releasePage(source, index)
        return null
      }
      if (!alive()) break
      await new Promise((r) => setTimeout(r, 120 * (tries + 1)))
    }
    return null
  }

  /* ------------------------------------------------------------- zoom */

  /*
   * The zoom's state lives in `SheetZoom` (sheet-zoom.ts): where the view is
   * going, what to render next and what the ink is given, decided without a
   * canvas so that it can be tested without one. Here are its clock, its
   * timers, and its two runes: `paintAt`, which the render effect follows,
   * and `view`, which the canvas and the `over` snippet read.
   */
  const zoomer = new SheetZoom(
    untrack(() => page),
    untrack(() => zoom),
  )
  /** The zoom the next picture is to be drawn at. */
  let paintAt = $state.raw<LectureZoom | null>(zoomer.paintAt)
  /** What the picture and everything over it are given (zoom.ts · `ZoomView`). */
  let view = $state.raw<ZoomView>(zoomer.view)
  /**
   * The zoom of the picture just put on the canvas: `show` reports it along
   * with the page, and only then does the ink repaint at it.
   */
  let canvasZoom: LectureZoom | null = null

  /** Carry the zoom's decisions out to the runes; it hands out new objects only on a change. */
  function sync(): void {
    untrack(() => {
      if (zoomer.paintAt !== paintAt) paintAt = zoomer.paintAt
      if (zoomer.view !== view) view = zoomer.view
    })
  }

  // A new target, or a new page (sheet-zoom.ts · `aim`).
  $effect(() => {
    const at = page
    const target = zoom
    const how = zoomHow
    untrack(() => {
      if (at !== zoomer.page) window.clearTimeout(earlyTimer)
      const moving = zoomer.aim(at, target, how, performance.now())
      sync()
      if (!moving) return
      if (how !== 'jump') drawAheadSoon()
      run()
    })
  })

  /**
   * THE MOTION IS DRIVEN BY FRAMES AND BY A TIMER, whichever comes first.
   *
   * The same two messengers as pdf.js's `onContinue` below, for the same
   * reason: a projection window that is covered, or shared into a call, gets
   * no animation frames at all, and the hall would stay on the old region
   * until somebody clicked into it. Its picture must still arrive; smoothly
   * where frames come, in 40 ms steps (the pointer's tick) where they do
   * not.
   */
  const LATE_MS = 40
  let tickFrame = 0
  let tickLate = 0
  function run(): void {
    if (tickFrame !== 0 || tickLate !== 0) return
    tickFrame = window.requestAnimationFrame(tick)
    tickLate = window.setTimeout(tick, LATE_MS)
  }

  function tick(): void {
    window.cancelAnimationFrame(tickFrame)
    window.clearTimeout(tickLate)
    tickFrame = 0
    tickLate = 0
    const more = zoomer.step(performance.now())
    sync()
    wake()
    if (more) run()
  }

  /** The region of a deliberate move is drawn ahead of the view (sheet-zoom.ts · `drawAhead`). */
  let earlyTimer = 0
  function drawAheadSoon(): void {
    window.clearTimeout(earlyTimer)
    earlyTimer = window.setTimeout(() => {
      zoomer.drawAhead()
      sync()
    }, EARLY_MS)
  }

  /**
   * Pictures that are ready and wait for the view to come inside their
   * region (`until`, sheet-zoom.ts · `fits`). Checked on every step of the
   * motion, and by the effects that drop them.
   */
  const waiting = new Set<() => void>()
  function wake(): void {
    for (const check of [...waiting]) check()
  }
  function until(ready: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (!ready()) return
        waiting.delete(check)
        resolve()
      }
      waiting.add(check)
      check()
    })
  }

  /* ------------------------------------------------------------ sheet */

  /**
   * Tell the parent what is on the sheet, once per change. Through `untrack`
   * for the same reason as `onfit`: the parent rearranges itself in response.
   *
   * The zoom hears every call, not once per page: a new picture of the same
   * page at another zoom (`canvasZoom`) is news for the ink too. The view
   * and the page go out in one step, so the ink of the new page is never
   * painted at the old picture's zoom, nor the other way round.
   */
  let shownNow: number | null | undefined
  function show(at: number | null): void {
    const fresh = at !== shownNow
    shownNow = at
    untrack(() => (backdrop = backdropNow(at)))
    zoomer.holds(at, canvasZoom)
    sync()
    if (fresh) untrack(() => onshown?.(at))
  }

  /** The sheet's own colour under the canvas: a blank sheet's paper, or white under a slide. */
  function groundOf(index: number): string {
    return index < 0 ? PAPER_GROUND : SLIDE_GROUND
  }

  /**
   * WHETHER THE PICTURE IS DARK, for the highlighter (page-region.ts ·
   * `InkBackdrop`), and the attribute the sheet carries it in
   * (`data-ink-backdrop`, see the style at the end).
   *
   * Read off the canvas itself, every time it changes (`show`), not guessed
   * from the deck: a dark theme, a photograph, a zoom into the dark corner of
   * a light slide are all just pixels here. The picture is shrunk into a
   * canvas of 32 × 18 and averaged: a few hundred pixels, read back once per
   * picture that lands, never per frame. A blank sheet, a wiped one and
   * anything that cannot be read are their ground, which is light. Only a
   * sheet with something laid over it asks: the thumbnails carry no ink.
   */
  let backdrop = $state<InkBackdrop>('light')
  let probe: HTMLCanvasElement | null = null
  const PROBE_W = 32
  const PROBE_H = 18

  function backdropNow(at: number | null): InkBackdrop {
    const ground = groundOf(at ?? page)
    const node = canvas
    if (!over || !node || at === null || at < 0 || node.width === 0 || node.height === 0) {
      return backdropOfColor(ground)
    }
    try {
      probe ??= document.createElement('canvas')
      if (probe.width !== PROBE_W || probe.height !== PROBE_H) {
        probe.width = PROBE_W
        probe.height = PROBE_H
      }
      const look = probe.getContext('2d')
      if (!look) return backdropOfColor(ground)
      look.clearRect(0, 0, PROBE_W, PROBE_H)
      // An average, not a sample: smoothing on, at its best where there is a best.
      look.imageSmoothingEnabled = true
      look.imageSmoothingQuality = 'high'
      look.drawImage(node, 0, 0, node.width, node.height, 0, 0, PROBE_W, PROBE_H)
      return backdropOf(meanLuminance(look.getImageData(0, 0, PROBE_W, PROBE_H).data, ground))
    } catch {
      return backdropOfColor(ground)
    }
  }

  /** Wipe the visible sheet: what it holds is no longer the page asked for. */
  function wipe(node: HTMLCanvasElement | null): void {
    node?.getContext('2d')?.clearRect(0, 0, node.width, node.height)
  }

  /*
   * The document is gone or not here yet: whatever the sheet still holds
   * belongs to another document. A lecture switched to a new PDF used to
   * keep showing the old deck's slide (and the new deck's ink over it) until
   * the new one rendered.
   */
  $effect(() => {
    if (doc) return
    untrack(() => {
      wipe(canvas)
      show(null)
    })
  })

  /*
   * The aspect ratio is learned separately from rendering: the sheet's size
   * is needed before there is anything to draw into, and rendering waits for
   * the size. In one effect this closes in on itself.
   *
   * ONLY THE FIRST SHAPE, AND THE SHAPE OF A BLANK SHEET, ARE LEARNED HERE.
   * A real page's shape is set by the render effect below, in the same step
   * as its picture. When this effect also answered every page turn, the box
   * took the new page's shape while the sheet still held the old picture,
   * and on a mixed deck (16:9 plus an inserted A4) the hall watched the
   * previous slide stretched into the new box until the render finished.
   */
  /** The document whose shape `aspect` holds. Not a rune: only checked against. */
  let aspectOf: PDFDocumentProxy | null = null
  $effect(() => {
    const source = doc
    /*
     * A blank sheet has no page of its own in the document (see
     * shared/lecture.ts): it takes its aspect ratio from the first page, so
     * that the white field has the same shape as the slides and the lecture
     * does not change format midway.
     */
    const index = page < 0 ? 1 : page
    if (!source) return
    if (page > 0 && aspectOf === source && untrack(() => aspect) !== null) return
    let dropped = false
    void (async () => {
      let sheet = await sheetOf(source, index, () => !dropped)
      /*
       * Our own page never came: take the shape of the FIRST one, like a
       * blank sheet.
       *
       * The aspect ratio holds the whole layout: without it `fit` is zero by
       * zero, and rendering never starts at all. A neighbouring page's shape is
       * at worst a wrong box for a fraction of a second (rendering corrects it
       * as soon as it gets the real sheet), while its absence is an empty
       * projection with not a word of explanation until the end of class. The
       * first page travels in the document's very first chunk, so this
       * fallback almost always works.
       */
      let held = index
      if (!sheet && index !== 1 && !dropped) {
        sheet = await sheetOf(source, 1, () => !dropped)
        held = 1
      }
      if (!sheet) return
      // Only the shape was wanted: the page goes back at once.
      const base = sheet.getViewport({ scale: 1 })
      releasePage(source, held)
      if (dropped) return
      aspectOf = source
      aspect = base.width / base.height
    })()
    return () => {
      dropped = true
    }
  })

  /** The sheet's place inside the given rectangle: fitted on both sides. */
  const fit = $derived.by(() => {
    const { w, h } = room
    if (w === 0 || h === 0 || aspect === null) return { w: 0, h: 0 }
    const byWidth = { w, h: w / aspect }
    return byWidth.h <= h ? byWidth : { w: h * aspect, h }
  })

  /*
   * Hand the space outward. Through `untrack`: the parent rearranges its
   * layout in response, and if its runes were read here as tracked, the
   * effect would subscribe to what it triggers itself, a loop ending in
   * effect_update_depth_exceeded, which this product has been burned by
   * before.
   */
  $effect(() => {
    const size = fit
    const rest = Math.max(0, room.h - size.h)
    if (size.w === 0) return
    untrack(() => onfit?.({ w: size.w, h: size.h, rest }))
  })

  /**
   * Rendering. Cancels the previous one: pages are flipped faster than an A4
   * page renders, and pdf.js refuses to draw into a busy canvas: "Cannot use
   * the same canvas during multiple render() operations".
   */
  let running: { cancel(): void; promise: Promise<unknown> } | null = null

  /**
   * A SPARE CANVAS, AGAINST BLINKING.
   *
   * pdf.js fills the canvas with white BEFORE drawing the page. While the page
   * renders, that fill is on screen, and switching slides reads as a flash;
   * on a tablet, where rendering is slower, as a blink on every press. No
   * cancellation cures this: the fill is not a bug, it is part of rendering.
   *
   * So we draw off to the side and move the finished result to the screen
   * with a single `drawImage`, too quick for the viewer to catch any
   * intermediate state. All that time the visible canvas holds the PREVIOUS
   * page: better to look at the previous slide for a second than at a white
   * field for half a second.
   *
   * One canvas per component, not per render: on iPad the canvas budget is
   * one per process, and when it overflows WebKit starts handing out
   * canvases transparent, including ones that did not overflow it (see the
   * thumbnail strip). On the way out we give the buffer back:
   * `width = height = 1`. Under a zoom it stays the frame's size too: only
   * the visible region is rendered into it (page-region.ts).
   */
  let buffer: HTMLCanvasElement | null = null

  $effect(() => {
    const node = canvas
    const source = doc
    const index = page
    const at = paintAt
    const { w, h } = fit
    if (!node || w === 0) return
    if (index < 0) {
      /*
       * A blank sheet. The canvas holds its paper's rules and nothing else
       * (the sheet's own background is the paper's colour): there is no point
       * drawing emptiness, but the previous slide cannot be left on the canvas
       * either, or the text of the page we came from would show through under
       * the ink. The rules are drawn at the zoom like a page's region, so they
       * zoom with the ink written over them.
       */
      const ruled = paper
      const strong = projector
      // A slide still rendering would only finish into a buffer nobody shows.
      running?.cancel()
      let dropped = false
      const lay = (): void => {
        if (dropped) return
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const W = Math.round(w * ratio)
        const H = Math.round(h * ratio)
        layPaper(node, W, H, paperMarks(ruled, W, H, at, strong))
        canvasZoom = at
        show(index)
      }
      // Drawn ahead of a zoom-in, the rules wait for the view like a page's
      // region does (see `paintSheet`).
      if (zoomer.fits(at)) lay()
      else void until(() => dropped || zoomer.fits(at)).then(lay)
      return () => {
        dropped = true
        wake()
      }
    }
    if (!source) return

    let dropped = false
    void (async () => {
      const previous = running
      if (previous) {
        previous.cancel()
        await previous.promise.catch(() => {})
      }
      if (dropped) return
      // The page, with retries: the same `sheetOf` as for the aspect ratio.
      const sheet = await sheetOf(source, index, () => !dropped)
      if (!sheet) {
        /*
         * The page never came. The sheet must not go on passing the previous
         * slide off as this one: it is wiped and reported as this page, so
         * that the ink and the pen follow the number the hall is on (a white
         * page with its ink is honest; a dead pen until the end of class is
         * not).
         */
        if (!dropped) {
          wipe(node)
          canvasZoom = at
          show(index)
        }
        return
      }
      try {
        let done: boolean
        try {
          done = await paintSheet(sheet, node, w, at, () => dropped)
        } catch (error) {
          /*
           * A zoomed region that failed is drawn once more at half the scale
           * (page-region.ts · `REGION_BUDGET`): a softer picture of the right
           * region beats none. A cancelled render is not tried again.
           */
          if (dropped || at === null) throw error
          done = await paintSheet(sheet, node, w, at, () => dropped, true)
        }
        if (done && !dropped) show(index)
      } catch {
        /*
         * Cancelled for the sake of the next page: business as usual.
         * Anything else leaves a wiped sheet rather than the previous slide
         * under this page's ink. But a picture of THIS page, drawn at
         * another zoom, stays: moved by the view to where the hall looks, it
         * is the right slide, if soft; wiped, it was a white sheet under the
         * presenter's ink at every zoom that failed. It is reported again
         * all the same (`canvasZoom` is still its own), so that the view
         * moves it with the zoom rather than holding a picture from before
         * a turn still for good (sheet-zoom.ts · `#outdated`).
         */
        if (!dropped) {
          if (shownNow !== index) {
            wipe(node)
            canvasZoom = at
          }
          show(index)
        }
      } finally {
        releasePage(source, index)
      }
    })()

    return () => {
      dropped = true
      // A finished render waiting for the view (`paintSheet`) lets go now.
      wake()
    }
  })

  /**
   * The most pixels the whole page may span at a region's scale on this
   * device (page-region.ts · `REGION_BUDGET`): past it pdf.js's scratch
   * canvases outgrow what an iPad can hold, and the slide's text vanishes.
   */
  const budget = regionBudget(deviceKind())

  /**
   * Draw one page into the visible canvas through the spare one. `false`
   * when the box first has to take this page's shape (the effect comes back
   * with the new size) or when the render was dropped; throws when it was
   * cancelled.
   *
   * `at` is the zoom to draw: the region of the page under it, rendered into
   * a canvas the size of the frame (page-region.ts · `regionViewport`), or a
   * smaller one where the device's budget lowers the scale. `coarse` halves
   * the scale once more: the second try at a region whose render failed.
   */
  async function paintSheet(
    sheet: PDFPageProxy,
    node: HTMLCanvasElement,
    w: number,
    at: LectureZoom | null,
    dropped: () => boolean,
    coarse = false,
  ): Promise<boolean> {
    const base = sheet.getViewport({ scale: 1 })
    /*
     * THE ASPECT RATIO COMES FROM HERE, not from the effect above.
     *
     * That effect answers the question "what shape is the sheet" BEFORE
     * there is anything to draw into, and it answers only once per document
     * (and for blank sheets). While the sheet kept the PREVIOUS page's ratio
     * and this code computed the scale from the new page's real width, the
     * `h-full w-full` canvas stretched the finished picture into someone
     * else's box: on a mixed deck (16:9 plus an inserted A4) the audience
     * saw a distorted slide, and kept seeing it until something unrelated
     * recomputed the layout.
     *
     * Here the sheet is real and already in hand, so the question is
     * settled by fact. If it differs, we record it and LEAVE: `aspect` feeds
     * `fit`, `fit` feeds the effect, and it comes right back here with the
     * box's real size. Drawing into the old one would be a frame of a
     * distorted picture on the projector, and writing unconditionally would
     * be a loop ending in effect_update_depth_exceeded. The visible sheet is
     * wiped on the way: the box is about to take the new shape, and the old
     * picture stretched into it is exactly the distorted slide described
     * above, only for the length of one render.
     */
    const real = base.width / base.height
    if (untrack(() => aspect) !== real) {
      wipe(node)
      show(null)
      aspect = real
      return false
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    let region = regionViewport(base, w, at, ratio, budget)
    if (coarse) {
      // Half the scale is a quarter of the pixels the whole page spans.
      const area = base.width * region.scale * base.height * region.scale
      region = regionViewport(base, w, at, ratio, area / 4)
    }
    const viewport = sheet.getViewport({
      scale: region.scale,
      offsetX: region.offsetX,
      offsetY: region.offsetY,
    })
    /*
     * Assigning width/height wipes both the pixels and the context state,
     * and does so even when the value is the same. So only on a real size
     * change: otherwise rotating the tablet would blank the page out of
     * nowhere. The size is the frame's, never the zoomed page's (or less,
     * past the budget: the canvas's CSS size stretches it over the frame).
     */
    const W = region.width
    const H = region.height
    /*
     * No context means the iPad's canvas budget is spent: nothing can be
     * drawn, and saying "shown" at least keeps the pen on the right page.
     */
    const paint = node.getContext('2d')
    if (!paint) return true
    buffer ??= document.createElement('canvas')
    // Assigning a size wipes the canvas and the context state, but the
    // buffer is drawn from scratch anyway, so here it costs nothing.
    if (buffer.width !== W || buffer.height !== H) {
      buffer.width = W
      buffer.height = H
    }
    const spare = buffer.getContext('2d')
    if (!spare) return true
    spare.clearRect(0, 0, W, H)
    const task = sheet.render({ canvas: buffer, canvasContext: spare, viewport })
    /*
     * WHO DRIVES THE RENDERING.
     *
     * pdf.js draws a page not in one piece but in portions, and by default
     * it asks `requestAnimationFrame` for the next portion. For the reader
     * that is right: the frame leaves time for scrolling. For the PROJECTION
     * it is a refusal to work. The projection window lives on a second
     * screen or is shared into Zoom, the teacher switches to another app,
     * and the browser, noticing that the window is not visible at all,
     * stops handing out frames. `document.hidden` is false meanwhile: the
     * window is not hidden, it is covered by another one. Rendering stalls
     * after the first portion, that is, after the white background fill,
     * and the audience stays on the previous slide while the presenter
     * flips on. Exactly this is what came back from class: "catches up in
     * about five seconds, or never".
     *
     * So the frame here is not the boss but one of two messengers: whichever
     * arrives first carries on. A hundred milliseconds is six missed frames:
     * no live page ever accumulates that many, and on a dead one they will
     * never come.
     *
     * AND THE MESSENGER MUST BE THE LAST ONE. What `onContinue` is handed is
     * pdf.js's own `_scheduleNext`, and for any render that is not printing
     * it asks for ANOTHER frame before the next portion. So the timeout only
     * passed the baton to a runner who waited for a frame anyway: measured in
     * Chrome with frames stopped, neither a page turn nor a zoom ever
     * rendered. pdf.js's own wait is switched off (an internal flag of the
     * pinned 6.x, set only when present) and taken over here: the same two
     * frames per portion as before where frames come, which leaves every
     * other frame to the pen on a tablet, and 100 ms where they do not.
     */
    const internal = (task as unknown as { _internalRenderTask?: { _useRequestAnimationFrame?: boolean } })
      ._internalRenderTask
    if (internal && '_useRequestAnimationFrame' in internal) internal._useRequestAnimationFrame = false
    task.onContinue = (next: () => void) => {
      let went = false
      let late = 0
      let frame = 0
      const go = (): void => {
        if (went) return
        went = true
        window.clearTimeout(late)
        window.cancelAnimationFrame(frame)
        next()
      }
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(go)
      })
      late = window.setTimeout(go, 100)
    }
    running = task
    try {
      await task.promise
    } finally {
      if (running === task) running = null
    }
    if (dropped()) return false
    /*
     * A region drawn ahead of a zoom-in waits for the view to come inside it
     * (sheet-zoom.ts · `drawAhead`): put up now, it would show the hall a
     * small sharp picture in a white field instead of the old one enlarged.
     * Any other picture covers the view already and goes straight up. The
     * render is over by then, so the next one does not wait for this:
     * dropping it is enough, and the effect's cleanup does that.
     */
    if (!zoomer.fits(at)) await until(() => dropped() || zoomer.fits(at))
    if (dropped()) return false
    /*
     * The finished result goes to the screen. The visible canvas is resized
     * ONLY here, and only on a real change: assignment wipes the pixels even
     * when the value is the same, and rotating the tablet would otherwise
     * blank the page out of nowhere.
     */
    if (node.width !== W || node.height !== H) {
      node.width = W
      node.height = H
    }
    paint.drawImage(buffer, 0, 0)
    // From this moment the canvas holds `at`; `show` tells the ink.
    canvasZoom = at
    return true
  }

  /**
   * A blank sheet's paper on the visible canvas: its rules on a clear
   * ground (the sheet's background is the paper itself). Plain paper leaves
   * the canvas clear, which is what the projection checks for a blank sheet.
   */
  function layPaper(node: HTMLCanvasElement, W: number, H: number, marks: PaperMarks): void {
    if (node.width !== W || node.height !== H) {
      node.width = W
      node.height = H
    }
    const paint = node.getContext('2d')
    if (!paint) return
    paint.setTransform(1, 0, 0, 1, 0, 0)
    paint.clearRect(0, 0, W, H)
    if (marks.lines.length > 0) {
      paint.strokeStyle = marks.color
      paint.lineWidth = marks.width
      paint.lineCap = 'butt'
      paint.beginPath()
      for (let i = 0; i + 3 < marks.lines.length; i += 4) {
        paint.moveTo(marks.lines[i], marks.lines[i + 1])
        paint.lineTo(marks.lines[i + 2], marks.lines[i + 3])
      }
      paint.stroke()
    }
    if (marks.dots.length > 0) {
      paint.fillStyle = marks.color
      paint.beginPath()
      for (let i = 0; i + 1 < marks.dots.length; i += 2) {
        paint.moveTo(marks.dots[i] + marks.radius, marks.dots[i + 1])
        paint.arc(marks.dots[i], marks.dots[i + 1], marks.radius, 0, Math.PI * 2)
      }
      paint.fill()
    }
  }

  /*
   * On the way out, give the buffer back. A canvas left in memory is not free
   * on iPad: the budget is one per process, and the lecture sheet lives next
   * to the thumbnail strip, which holds another dozen canvases.
   */
  onDestroy(() => {
    // A render left running would finish into a buffer nobody shows and keep
    // its page held until then.
    running?.cancel()
    window.cancelAnimationFrame(tickFrame)
    window.clearTimeout(tickLate)
    window.clearTimeout(earlyTimer)
    if (probe) {
      probe.width = 1
      probe.height = 1
      probe = null
    }
    if (!buffer) return
    buffer.width = 1
    buffer.height = 1
    buffer = null
  })
</script>

<div
  bind:this={box}
  class="relative flex min-h-0 min-w-0 flex-1 justify-center {align === 'top' ? 'items-start' : 'items-center'}"
  data-ink-backdrop={backdrop}
>
  <!-- The sheet and everything on it, as one block: the ink layer must match
       the sheet pixel for pixel, not the container around it.

       The paper of a blank sheet (a page with a negative number) is slightly
       darker than white. A solid white 928×522 rectangle is the brightest
       frame in the whole product, and it is held at arm's length in a dark
       lecture hall; the projector's gamma eats those five percent, so the
       audience will not see the difference, and on the console they are shed
       for free. -->
  <div
    class="relative {bare ? '' : 'shadow-pop'} {dim ? 'opacity-70' : ''}"
    style={`width:${fit.w}px;height:${fit.h}px;background:${groundOf(page)}`}
  >
    <!-- The frame the zoomed picture moves in. It clips by `overflow` and by
         nothing else: no transform, opacity, filter or z-index here or on the
         sheet (the dimmed "next" thumbnail carries no ink), because any of
         them makes a stacking context, and the ink's highlighter blends
         with the page only while nothing stands between them. The clip is
         the picture's own, not the sheet's: the ink clips its canvases
         itself, and its input layer reaches past the sheet on the console
         (InkLayer · `reach`), where a clip on the sheet would cut it off,
         and the console's feathering around the paper with it. -->
    <div class="absolute inset-0 overflow-hidden">
      <canvas
        bind:this={canvas}
        class="block h-full w-full origin-top-left"
        style:transform={view.css || null}
      ></canvas>
    </div>
    {@render over?.(fit, view)}
  </div>
</div>

<style>
  /*
   * THE HIGHLIGHTER ON A DARK PAGE (page-region.ts · `InkBackdrop`). The ink
   * layer multiplies its marker canvas with the page, and multiply only
   * darkens: on a dark slide the highlight vanished. On a picture this sheet
   * found dark (`backdrop`), the marker canvas screens instead, which only
   * lightens: light text stays light, and the dark ground lights up in the
   * marker's colour. Here, not in the ink layer, because only the page knows
   * what it painted; and it out-ranks the ink layer's own `.ink-mark` rule
   * (once scoped: an attribute, two classes and a tag against two classes).
   */
  [data-ink-backdrop='dark'] :global(canvas.ink-mark) {
    mix-blend-mode: screen;
  }
</style>
