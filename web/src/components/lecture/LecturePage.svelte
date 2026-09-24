<!--
  One page, fitted into the space it is given.

  The reader stacks pages in a column and scrolls them; the lecture shows
  exactly one, whole. These are different tasks, and the second is simpler:
  no scrolling, no zoom, just a rectangle and a sheet fitted into it.

  Fitted on BOTH sides, not by width: the projector is 16:9, while a slide
  can be 4:3 or A4, and a page fitted by width runs off the bottom of the
  screen, that is, the last line of the slide is invisible to the audience.
  The presenter does not notice: their tablet has a different aspect ratio.

  The component hands its own space outward: the ink must lie exactly on the
  sheet, not on the container around it, or it drifts off the text on any
  screen whose proportions differ from the page.
-->
<script lang="ts">
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import { onDestroy, type Snippet, untrack } from 'svelte'

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
     */
    over?: Snippet<[{ w: number; h: number }]>
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
  }

  let { doc, page, over, dim = false, bare = false, align = 'center', onfit }: Props = $props()

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
   */
  async function sheetOf(
    source: PDFDocumentProxy,
    index: number,
    alive: () => boolean,
  ): Promise<Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null> {
    for (let tries = 0; tries < 5 && alive(); tries += 1) {
      const sheet = await source.getPage(index).catch(() => null)
      if (sheet) return sheet
      if (!alive()) break
      await new Promise((r) => setTimeout(r, 120 * (tries + 1)))
    }
    return null
  }

  /*
   * The aspect ratio is learned separately from rendering: the sheet's size
   * is needed before there is anything to draw into, and rendering waits for
   * the size. In one effect this closes in on itself.
   */
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
      if (!sheet && index !== 1 && !dropped) sheet = await sheetOf(source, 1, () => !dropped)
      if (!sheet || dropped) return
      const base = sheet.getViewport({ scale: 1 })
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
   * `width = height = 1`.
   */
  let buffer: HTMLCanvasElement | null = null

  $effect(() => {
    const node = canvas
    const source = doc
    const index = page
    const { w, h } = fit
    if (!node || w === 0) return
    if (index < 0) {
      /*
       * A blank sheet. The canvas is cleared, and the backing makes it white:
       * there is no point drawing emptiness, but the previous slide cannot be
       * left on the canvas either: the text of the page we came from would
       * show through under the ink.
       */
      const paint = node.getContext('2d')
      if (paint) paint.clearRect(0, 0, node.width, node.height)
      return
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
      if (!sheet || dropped) return
      const base = sheet.getViewport({ scale: 1 })
      /*
       * THE ASPECT RATIO COMES FROM HERE TOO, not only from the effect above.
       *
       * That effect answers the question "what shape is the sheet" BEFORE
       * there is anything to draw into, and on a page change it answers late
       * or not at all. While the sheet kept the PREVIOUS page's ratio and this
       * code computed the scale from the new page's real width, the
       * `h-full w-full` canvas stretched the finished picture into someone
       * else's box: on a mixed deck (16:9 plus an inserted A4) the audience
       * saw a distorted slide, and kept seeing it until something unrelated
       * recomputed the layout.
       *
       * Here the sheet is real and already in hand, so the question is
       * settled by fact. If it differs, we record it and LEAVE: `aspect` feeds
       * `fit`, `fit` feeds this effect, and it comes right back here with the
       * box's real size. Drawing into the old one would be a frame of a
       * distorted picture on the projector, and writing unconditionally would
       * be a loop ending in effect_update_depth_exceeded.
       */
      const real = base.width / base.height
      if (untrack(() => aspect) !== real) {
        aspect = real
        return
      }
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = sheet.getViewport({ scale: (w / base.width) * ratio })
      /*
       * Assigning width/height wipes both the pixels and the context state,
       * and does so even when the value is the same. So only on a real size
       * change: otherwise rotating the tablet would blank the page out of
       * nowhere.
       */
      const W = Math.round(viewport.width)
      const H = Math.round(viewport.height)
      const paint = node.getContext('2d')
      if (!paint) return
      buffer ??= document.createElement('canvas')
      // Assigning a size wipes the canvas and the context state, but the
      // buffer is drawn from scratch anyway, so here it costs nothing.
      if (buffer.width !== W || buffer.height !== H) {
        buffer.width = W
        buffer.height = H
      }
      const spare = buffer.getContext('2d')
      if (!spare) return
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
       */
      task.onContinue = (next: () => void) => {
        let went = false
        let late = 0
        const go = (): void => {
          if (went) return
          went = true
          window.clearTimeout(late)
          next()
        }
        const frame = window.requestAnimationFrame(go)
        late = window.setTimeout(() => {
          window.cancelAnimationFrame(frame)
          go()
        }, 100)
      }
      running = task
      try {
        await task.promise
        if (dropped) return
        /*
         * The finished result goes to the screen. The visible canvas is
         * resized ONLY here, and only on a real change: assignment wipes the
         * pixels even when the value is the same, and rotating the tablet
         * would otherwise blank the page out of nowhere.
         */
        if (node.width !== W || node.height !== H) {
          node.width = W
          node.height = H
        }
        paint.drawImage(buffer, 0, 0)
      } catch {
        // Cancelled for the sake of the next page: business as usual.
      } finally {
        if (running === task) running = null
      }
    })()

    return () => {
      dropped = true
    }
  })

  /*
   * On the way out, give the buffer back. A canvas left in memory is not free
   * on iPad: the budget is one per process, and the lecture sheet lives next
   * to the thumbnail strip, which holds another dozen canvases.
   */
  onDestroy(() => {
    if (!buffer) return
    buffer.width = 1
    buffer.height = 1
    buffer = null
  })
</script>

<div
  bind:this={box}
  class="relative flex min-h-0 min-w-0 flex-1 justify-center {align === 'top' ? 'items-start' : 'items-center'}"
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
    style={`width:${fit.w}px;height:${fit.h}px;background:${page < 0 ? '#F4F6FA' : '#fff'}`}
  >
    <canvas bind:this={canvas} class="block h-full w-full"></canvas>
    {@render over?.(fit)}
  </div>
</div>
