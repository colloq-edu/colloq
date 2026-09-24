<!--
  The PDF reader in the room.

  Two modes, and they are not the same thing. Anyone can look on their own — a
  room file can be downloaded by anyone in it anyway. Following the teacher is a
  viewing mode, not a lock: any gesture of the student breaks following
  immediately, and a pill offers the way back. Immediately, not on a timer:
  programmatic scrolling fighting a finger on the trackpad causes a stickiness
  that looks like a breakage.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { onMount } from 'svelte'
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import type { Lead } from '@/lib/follow'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { mayBeFollowed } from '@shared/rules'
  import { fits } from './budget'
  import PageRail from './PageRail.svelte'

  interface Props {
    /** What this person has open. May differ from what the room has. */
    file: string
    /** Whether the room shared it: if so, we follow the teacher by default. */
    shared: boolean
    /**
     * The counter of "catch up" presses in the tab row.
     *
     * A counter, not a flag: one can catch up twice in a row, and a flag would
     * not change the second time, so nothing would happen.
     */
    catchUp: number
    /** Out to the tab row: it shows both the position and whom we follow. */
    page: number
    pages: number
    /**
     * Whom to follow through this document — computed by the screen, not the
     * reader.
     *
     * It used to be computed here, and that was a mistake in exactly one place:
     * the reader unmounts when the person goes to the notebook, while the
     * "teacher on p. 4" mark on the tab must stay live from there too.
     * Computing it in the screen costs the same, and it works even when nobody
     * is watching.
     */
    lead: Lead | null
    /**
     * Whether we are following the presenter right now — out to the tab row.
     *
     * The tab row writes "Following …" and offers "catch up", and it knew about
     * this only from the page number: someone who had fallen half a page behind
     * read "you are on your own" in the reader and "Following Anna" a line
     * above. Two indicators next to each other saying opposite things are worse
     * than one.
     */
    following?: boolean
    /** Whether this person may start a lecture from the document. */
    mayLead?: boolean
    /** A lecture on this document runs while they read alone: the way back. */
    backToLecture?: (() => void) | null
  }

  let {
    file,
    shared,
    catchUp,
    lead,
    mayLead = false,
    backToLecture = null,
    page = $bindable(1),
    pages = $bindable(0),
    following = $bindable(false),
  }: Props = $props()
  const session = getSessionState()

  let doc = $state<PDFDocumentProxy | null>(null)
  let failureRender = $state<() => string | null>(() => null)
  const failure = $derived(failureRender())
  let scroller = $state<HTMLElement | null>(null)

  /**
   * How much space a page that has not been drawn yet takes.
   *
   * The space has to be right BEFORE drawing: both `place` and `goTo` measure
   * the page's height — following the teacher goes by it, and so does returning
   * to one's place after zooming. The proportion is taken from the first page
   * (as in the thumbnail strip) and refined by each drawn one: an appendix at
   * the end of a deck has its own orientation.
   */
  let aspect = $state('1 / 1.414')
  const ratios = $state<Record<number, string>>({})

  /*
   * Scale is computed FROM THE COLUMN WIDTH, not from the page size in points.
   *
   * A hundred percent is "fit to width": the reason the reader is opened at
   * all, and what needs no adjusting. Everything else is a multiplier on that.
   * Scale "as in Acrobat", where a hundred percent means the physical size of
   * the sheet, means nothing in a column half a screen wide.
   */
  const STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]
  let scale = $state(read(`colloq.zoom.${session.session.id}`, 1))
  let railOpen = $state(read(`colloq.rail.${session.session.id}`, 0) === 1)

  function read(key: string, fallback: number): number {
    try {
      const raw = localStorage.getItem(key)
      const value = raw === null ? NaN : Number(raw)
      return Number.isFinite(value) ? value : fallback
    } catch {
      return fallback
    }
  }

  function remember(key: string, value: number): void {
    try {
      localStorage.setItem(key, String(value))
    } catch {
      /* private mode — the zoom simply will not survive the visit */
    }
  }

  /**
   * Change the scale without losing one's place in the document.
   *
   * Scrolling holds on to pixels, and scale changes them: without this, page
   * twenty-four would slide back to the start after a single press on "plus".
   * The place is taken as a page and a fraction of its height — the same way it
   * is followed around the room.
   */
  function zoom(next: number): void {
    const wanted = Math.min(3, Math.max(0.5, next))
    if (wanted === scale) return
    const was = place()
    scale = wanted
    remember(`colloq.zoom.${session.session.id}`, wanted)
    // A frame: the canvases get to rebuild, and only then can heights be
    // measured.
    requestAnimationFrame(() => requestAnimationFrame(() => goTo(was)))
  }

  function step(direction: -1 | 1): void {
    const at = STEPS.findIndex((value) => value >= scale - 0.001)
    const next = direction === 1 ? STEPS[Math.min(STEPS.length - 1, at + 1)] : STEPS[Math.max(0, at - 1)]
    zoom(next ?? scale)
  }
  /** Set while code moves the page, so as not to take that for a gesture. */
  let programmatic = false

  onMount(() => {
    let cancelled = false
    let opened: PDFDocumentProxy | null = null
    /*
     * The page counter in the tab row — from THIS document from the first
     * second.
     *
     * The reader is recreated for every tab (`{#key activePath}` in the room
     * screen), while `page`/`pages` are bound to the screen and survive the
     * recreation: without a reset, "12 / 40" from the previous file hung over
     * the new one until it was scrolled.
     */
    page = 1
    pages = 0
    /*
     * Default following: a document put up by the room is watched together; a
     * document opened for oneself from the files panel is looked at alone. The
     * person came to look at their own thing, and dragging them to someone
     * else's page would be rude.
     */
    following = shared
    void loadPdf()
      .then((pdf) => pdf.open(api.fileRaw(session.session.id, file), session.token))
      .then(async (ready) => {
        opened = ready
        if (cancelled) return
        // The page proportion comes before the first render: following the
        // teacher goes by the page heights, and a deck of slides laid out as a
        // column of A4 would send a jump to a page off target.
        const view = (await ready.getPage(1)).getViewport({ scale: 1 })
        if (cancelled) return
        aspect = `${Math.round(view.width)} / ${Math.round(view.height)}`
        doc = ready
        pages = ready.numPages
        /*
         * The place is reported by the effect below, not by this line.
         *
         * Where we are has to be said at once — without waiting for scrolling:
         * otherwise a teacher who opened the document and did not touch it does
         * not publish a position at all, the room sees the board but has no one
         * to follow, and not a line about why. The usual case: opened it on the
         * first page and started talking. But the role arrives in a separate
         * frame and may come later than the document, and only someone who can
         * be followed publishes their place — so this is not one event but two,
         * and both have to be waited for.
         */
      })
      .catch(() => {
        if (!cancelled) failureRender = () => (tr('room.ui.730'))
      })
    return () => {
      cancelled = true
      // Free the pages' memory: thirty drawn A4 canvases are hundreds of
      // megabytes, and a tab where the document was opened three times grinds
      // to a halt. Close the document entirely: `loadingTask.destroy()` stops
      // both the worker and unfinished chunk requests. `cleanup` alone is not
      // enough — it frees the pages but keeps the transport alive.
      //
      // By its own variable, not by `doc`: a document that arrived after
      // leaving will never make it into `doc` — and without this it would keep
      // its worker alive.
      void opened?.loadingTask.destroy()
    }
  })

  /**
   * The render that is going into this canvas right now.
   *
   * pdf.js refuses to draw into the same canvas a second time until the first
   * render is finished: "Cannot use the same canvas during multiple render()
   * operations". And the zoom is switched faster than an A4 page is computed —
   * two presses on "plus" in a row are exactly that second time.
   */
  interface Job {
    /** Stop request: a flag before `render`, a task cancel after it. */
    cancel(): void
    /** Resolves when the canvas is free. Never rejects. */
    free: Promise<void>
  }
  const rendering = new WeakMap<HTMLCanvasElement, Job>()

  /**
   * Show a page: a canvas per page, rendering in the worker.
   *
   * The slot in the map is taken AT ONCE, before the first `await`. It used to
   * be taken after `getPage`, and in that window a second render passed the
   * guard as if the map were empty: it reset the canvas dimensions under the
   * running first one — that is, wiped it and knocked its coordinate system
   * off — and the "same canvas" exception went into an empty catch. The page
   * stayed empty or half-drawn with an offset, silently, until the next zoom
   * change.
   */
  async function draw(node: HTMLCanvasElement, index: number): Promise<void> {
    const previous = rendering.get(node)
    let stopped = false
    let task: { cancel(): void } | null = null
    let done!: () => void
    const job: Job = {
      cancel() {
        stopped = true
        task?.cancel()
      },
      free: new Promise<void>((resolve) => (done = resolve)),
    }
    rendering.set(node, job)
    /*
     * First cancel the previous render and WAIT for it: `cancel()` only asks it
     * to stop, and the canvas stays busy until the promise settles. A rejection
     * here is routine — that is what the cancellation is.
     */
    previous?.cancel()
    try {
      await previous?.free
      if (stopped || !doc) return
      const source = await doc.getPage(index)
      if (stopped) return
      // Screen density: without it a page on retina looks blurry, like a scan.
      const density = Math.min(window.devicePixelRatio || 1, 2)
      const width = node.parentElement?.clientWidth ?? 800
      const base = source.getViewport({ scale: 1 })
      const css = width / base.width
      // …but density is a wish, not an entitlement: at 250–300% the page goes
      // over the shared canvas budget, and WebKit starts blanking arbitrary
      // canvases (see budget.ts and `release`). A blurry page can be read, an
      // empty one cannot.
      const ratio = fits(base.width * css, base.height * css, density)
      const viewport = source.getViewport({ scale: css * ratio })
      // The page's space is held by CSS, not by the buffer size: the buffer
      // changes on every zoom and is given back when the page leaves the
      // screen, while the page height must not change because of that —
      // following the teacher goes by it.
      ratios[index] = `${Math.round(base.width)} / ${Math.round(base.height)}`
      node.width = viewport.width
      node.height = viewport.height
      const context = node.getContext('2d')
      if (!context) return
      const started = source.render({ canvas: node, canvasContext: context, viewport })
      task = started
      await started.promise
    } catch {
      // Cancelled for a new zoom, or the document was closed — not a breakage.
    } finally {
      if (rendering.get(node) === job) rendering.delete(node)
      done()
    }
  }

  /**
   * A page's canvas: drawn when it is scrolled to, and REDRAWN when the zoom or
   * the column width changes.
   *
   * They used to be drawn all at once, a canvas per page, at the moment of
   * opening. A deck of forty slides is forty buffers of a couple of megapixels
   * each (hundreds of megabytes) and forty parses in one queue: the tab stops
   * responding for seconds, and the page the person is looking at comes last —
   * "plus" looks broken. Zoom multiplies the buffer quadratically, and on iPad,
   * where the canvas budget is one per process, that is exactly the overflow
   * that makes WebKit start blanking arbitrary canvases (see `release`). The
   * thumbnail strip next to it draws lazily for the same reason, and
   * `disableAutoFetch` in pdf.svelte.ts promises the same thing: the first
   * frame at once, the rest as needed.
   *
   * An action's `update` is the only place where Svelte reports that a
   * parameter changed without recreating the node. Recreating the canvas would
   * mean collapsing the page to zero height for a moment — that is, pulling the
   * scroll away from everyone reading at that moment.
   */
  interface Sheet {
    index: number
    scale: number
    /** Column width: canvases are drawn to it; more than buttons change it. */
    column: number
  }

  function canvas(node: HTMLCanvasElement, args: Sheet) {
    let at = args
    let near = false
    /*
     * A margin of a screen and more: the page gets drawn before it becomes
     * visible, and the document does not flash white sheets under the finger.
     * The scroll root is taken from the markup, not from `scroller`: the
     * binding may not have arrived yet at the moment the canvas mounts.
     */
    const watcher = new IntersectionObserver(
      (entries) => {
        const shown = entries.some((entry) => entry.isIntersecting)
        if (shown === near) return
        near = shown
        if (shown) void draw(node, at.index)
        else release(node)
      },
      { root: node.closest('[data-sheets]'), rootMargin: '1200px 0px' },
    )
    watcher.observe(node)
    return {
      update(next: Sheet) {
        if (next.index === at.index && next.scale === at.scale && next.column === at.column) return
        at = next
        if (near) void draw(node, at.index)
      },
      destroy() {
        watcher.disconnect()
        release(node)
      },
    }
  }

  /**
   * The canvas gives up its buffer — when leaving the page or going off the
   * edge of the screen.
   *
   * `width = height = 1` is the only thing that makes WebKit let it go: the
   * garbage collector gives these buffers back whenever it likes, just never in
   * time. On iPad the canvas memory budget is one PER PROCESS, and a sixty-page
   * deck uses it up entirely; once it overflows, WebKit starts drawing canvases
   * transparent — arbitrary ones, not necessarily those that overflowed it. The
   * page of a running lecture in a neighbouring tab can be blanked, and this
   * line protects that page, not the reader.
   *
   * The page height does not change meanwhile: it is held by `aspect-ratio`,
   * not by the buffer.
   */
  function release(node: HTMLCanvasElement): void {
    rendering.get(node)?.cancel()
    node.width = 1
    node.height = 1
  }

  /**
   * The column width is the same scale as the "plus" buttons.
   *
   * The canvas buffer is computed from the page's actual width, and it is
   * changed not only by those buttons: the page strip takes 148 pixels, the
   * oracle panel a third of the screen, the window gets maximized. Without the
   * observer the pages stayed drawn for the old width and were stretched by
   * CSS — on a projector, where the screen density is one, the text stays
   * blurry until the end of class, even though the `toggleRail` comment
   * promises a redraw. With a delay: dragging a window with the mouse is a
   * hundred events in a row, and it is worth paying only for the last one.
   */
  let column = $state(0)
  $effect(() => {
    const root = scroller
    if (!root) return
    let later = 0
    const watcher = new ResizeObserver(() => {
      clearTimeout(later)
      later = window.setTimeout(() => (column = root.clientWidth), 150)
    })
    column = root.clientWidth
    watcher.observe(root)
    return () => {
      clearTimeout(later)
      watcher.disconnect()
    }
  })

  /**
   * Where the page lies INSIDE the scroll area.
   *
   * By rectangles, not by `offsetTop`: that is measured from the nearest
   * positioned ancestor, and that turned out to be the whole reader section —
   * together with the control bar above the scroll area. Thirty-four pixels of
   * its height were added to every jump: the page went above the edge, and
   * instead of its start one saw the end of the previous page.
   */
  function topOf(sheet: HTMLElement, root: HTMLElement): number {
    return sheet.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
  }

  /** Where it is scrolled to — as a page and a fraction of its height. */
  function place(): { page: number; y: number } {
    const root = scroller
    if (!root) return { page: 1, y: 0 }
    const sheets = [...root.querySelectorAll<HTMLElement>('[data-page]')]
    const top = root.scrollTop
    for (const sheet of sheets) {
      const at = topOf(sheet, root)
      const bottom = at + sheet.offsetHeight
      if (bottom > top + 4) {
        return {
          page: Number(sheet.dataset.page),
          y: Math.min(1, Math.max(0, (top - at) / Math.max(1, sheet.offsetHeight))),
        }
      }
    }
    return { page: pages || 1, y: 0 }
  }

  function goTo(target: { page: number; y: number }, smooth = false): void {
    const root = scroller
    const sheet = root?.querySelector<HTMLElement>(`[data-page="${target.page}"]`)
    if (!root || !sheet) return
    const at = topOf(sheet, root)
    /*
     * The start of the page has to be VISIBLE.
     *
     * A jump exactly to the top edge presses the page against the edge of the
     * window: one sees that something changed, but not where the page began. So
     * there is an offset for the margin — the same twelve pixels by which a
     * page is always set off from the edge.
     *
     * And a page that fits entirely into the window is put in the middle: it
     * has no "start at the top", it needs air on both sides.
     */
    const gap = 12
    const fits = sheet.offsetHeight + gap * 2 <= root.clientHeight
    const centred = at - (root.clientHeight - sheet.offsetHeight) / 2
    const top =
      target.y > 0
        ? at + target.y * sheet.offsetHeight
        : fits
          ? Math.max(0, centred)
          : Math.max(0, at - gap)
    programmatic = true
    root.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    // A frame, not a timer: the scroll gets to happen, and a gesture does not
    // yet.
    requestAnimationFrame(() => requestAnimationFrame(() => (programmatic = false)))
  }

  /* The screen follows the teacher. By jumping, not smoothly: smoothness on
     each of their pixels would turn the class into one continuous animation. */
  $effect(() => {
    if (!following || !lead || !doc) return
    goTo({ page: lead.page, y: lead.y })
  })

  /*
   * "Catch up" was pressed in the tab row. Smoothly — this is the only place
   * where smoothness is appropriate: a person's gesture, not someone else's
   * scroll pixel.
   */
  // svelte-ignore state_referenced_locally
  let caught = catchUp
  $effect(() => {
    if (catchUp === caught) return
    caught = catchUp
    if (!lead) return
    following = true
    goTo({ page: lead.page, y: lead.y }, true)
  })

  /**
   * Open or close the page strip.
   *
   * The strip is a column, and the column width is the scale: the page is drawn
   * to it. So opening and closing cost a redraw (done by the width observer
   * above) — and demand the same as zooming: take the place in the document
   * before and give it back after, otherwise someone reading page twenty-four
   * slides back to the start after pressing "pages".
   */
  function toggleRail(): void {
    const was = place()
    railOpen = !railOpen
    remember(`colloq.rail.${session.session.id}`, railOpen ? 1 : 0)
    requestAnimationFrame(() => requestAnimationFrame(() => goTo(was)))
  }

  /**
   * Whether the room can follow THIS person — and, therefore, whether the room
   * needs their place.
   *
   * `leaderFor` takes only a teacher as the leader, so nobody reads a student's
   * place, yet it costs a presence frame for the WHOLE room — and not just one:
   * the reader of whoever follows the teacher scrolls programmatically, that
   * is, it answers each of their steps with its own frame. At a lecture of five
   * hundred people, one step of the teacher unfolded into five hundred frames
   * and two hundred and fifty thousand deliveries; a scrolled page, into
   * millions. The rule is one for both sides and lives in shared/rules.ts, so
   * that "who is chosen as the leader" and "who publishes a place" do not drift
   * apart.
   */
  const leads = $derived(mayBeFollowed(session.me.role))

  /**
   * One's last place — in the same form in which it is followed around the
   * room.
   *
   * A plain variable, not `$state`: the effect below reads it, and it must not
   * depend on it — otherwise every scroll would wake it instead of `onScroll`.
   */
  let seen = { page: 1, y: 0 }

  /*
   * The place goes into presence when two things have come together: the
   * document has opened and the role has arrived. These frames are independent,
   * so this is an effect, not a line in onMount: the teacher cookie is
   * confirmed by the control socket, and easily later than pdf.js parses the
   * first page.
   *
   * The role was removed in the middle of a class — the place is removed too:
   * otherwise the room would keep following the last thing the former leader
   * managed to report.
   */
  $effect(() => {
    if (!doc) return
    if (leads) session.setViewing({ file, page: seen.page, y: seen.y })
    else session.setViewing(null)
  })

  function onScroll(): void {
    const here = place()
    page = here.page
    // One's own gesture breaks following. Programmatic scrolling does not count
    // as a gesture.
    if (!programmatic && following && lead) following = false
    seen = here
    // One's own place goes into presence, so that this person can be followed.
    // Nobody will follow someone who cannot be followed: their frame is pure
    // waste.
    if (leads) session.setViewing({ file, page: here.page, y: here.y })
  }

/*
 * The position is NOT removed on unmount.
 *
 * The reader disappears when the person switches to the notebook — but the
 * place in the document has not stopped existing because of that. Removing it
 * here would mean: the teacher went to the notebook for a second to finish a
 * cell — and the whole room lost the "they are on page 4" mark, although the
 * lecture has not gone anywhere. It is removed by whoever knows that the
 * document is closed for good — the room screen.
 */
</script>

<!--
  No header, no bottom pill: the file name, the page number and "whom we follow"
  live in the tab row above the centre. Two places saying the same thing drift
  apart.
-->
<section class="relative flex min-h-0 flex-1 flex-col bg-surface">
  <!--
    The reader's control bar — in the same place as Run All for a notebook and
    "Run" for a script: every tab has its own, and it is always under the tab
    row. The page number does not move here: it lives in the tab row, and two
    places saying the same thing drift apart.
  -->
  <div class="flex h-[34px] shrink-0 items-stretch border-b border-line bg-canvas">
    <button
      type="button"
      class="flex shrink-0 items-center gap-2 px-4 text-2xs font-bold uppercase tracking-label
             transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-inset focus-visible:ring-accent/40
             {railOpen ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}"
      aria-pressed={railOpen}
      aria-label={tr('room.ui.720')}
      title={tr('room.ui.156')}
      onclick={toggleRail}
    >
      <Icon name="text" size={12} /> {tr('room.ui.206')} </button>

    <span class="my-2 w-px bg-line" aria-hidden="true"></span>

    <!--
      Minus, fraction, plus. The fraction is a button: pressing it returns "fit
      to width", and that is the only scale that does not have to be chosen.
    -->
    <button
      type="button"
      class="flex w-9 shrink-0 items-center justify-center text-ui text-muted transition-colors
             duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-inset focus-visible:ring-accent/40 disabled:opacity-40"
      disabled={scale <= 0.5}
      aria-label={tr('room.ui.721')}
      title={tr('room.ui.721')}
      onclick={() => step(-1)}
    >
      −
    </button>
    <button
      type="button"
      class="flex w-16 shrink-0 items-center justify-center font-mono text-2xs tabular-nums
             text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none
             focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      title={tr('room.ui.722')}
      onclick={() => zoom(1)}
    >
      {Math.round(scale * 100)}%
    </button>
    <button
      type="button"
      class="flex w-9 shrink-0 items-center justify-center text-ui text-muted transition-colors
             duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-inset focus-visible:ring-accent/40 disabled:opacity-40"
      disabled={scale >= 3}
      aria-label={tr('room.ui.723')}
      title={tr('room.ui.723')}
      onclick={() => step(1)}
    >
      +
    </button>

    <span class="flex-1"></span>

    {#if backToLecture}
      <!--
        A lecture on this document is running right now, and this person has
        gone off to read on their own. The way back has to be right where they
        left — otherwise "Read on my own" is a one-way door until the end of
        class.
      -->
      <button
        type="button"
        class="flex shrink-0 items-center gap-2 px-4 text-2xs font-bold uppercase tracking-label
               text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none
               focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        title={tr('room.ui.724')}
        onclick={() => backToLecture?.()}
      >
        <Icon name="board" size={12} /> {tr('room.ui.725')} </button>
    {:else if mayLead}
      <!--
        Start a lecture. The button is in the reader, not in the files panel,
        because this decision is not about the file but about what is done with
        it: the same PDF was being leafed through silently a minute ago, and now
        a class is being taught from it.
      -->
      <button
        type="button"
        class="flex shrink-0 items-center gap-2 px-4 text-2xs font-bold uppercase tracking-label
               text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none
               focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        title={tr('room.ui.726')}
        onclick={() => session.send({ t: 'lecture:start', file })}
      >
        <Icon name="pencil" size={12} /> {tr('room.ui.444')} </button>
    {/if}

    {#if !following && lead}
      <!-- Fell behind on purpose: following is broken by any gesture of one's
           own, and that has to be said right where the buttons are, not only in
           the tab row. -->
      <span class="flex shrink-0 items-center gap-1.5 px-4 text-2xs text-muted">
        <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span> {tr('room.ui.727')} </span>
    {/if}
  </div>

  <div class="flex min-h-0 flex-1">
    {#if doc && railOpen}
      <PageRail
        {doc}
        {pages}
        {page}
        {lead}
        onpick={(target) => {
          /*
           * By jumping, not smoothly, and this is not economy. "Catch up" is
           * smooth because it is a correction by a page or two, and one can see
           * where one went. A choice in the strip is a move to anywhere, even
           * to page two hundred: animating it means showing half a minute of
           * pages flying by instead of the one people came for.
           *
           * And the strip STAYS open meanwhile: people move through it several
           * times in a row, and closing after every jump means making them open
           * it again.
           */
          goTo({ page: target, y: 0 })
        }}
      />
    {/if}
    <div
      bind:this={scroller}
      data-sheets
      class="min-h-0 min-w-0 flex-1 overflow-auto px-3 py-3"
      onscroll={onScroll}
      role="document"
    >
    {#if failure}
      <p class="p-4 text-ui text-muted">{failure}</p>
    {:else if !doc}
      <!-- Not a spinner but the file name: the person knows what they are
           opening and sees that it is already happening. The library and the
           worker are a megabyte and a half, which is seconds on lecture-hall
           wifi. -->
      <p class="p-4 text-ui text-muted">{tr('room.ui.728')} {file}…</p>
    {:else}
      {#each Array.from({ length: pages }, (_, i) => i + 1) as index (index)}
        <!-- The page width is the scale: a page is drawn to the width of its
             slot. Wider than the column, a horizontal scroll appears, and that
             is the only honest way to show the enlarged page. -->
        <div
          data-page={index}
          class="mx-auto mb-3 bg-white shadow-sm"
          style={`width:${scale * 100}%`}
        >
          <!-- The proportion is on the canvas, not the buffer size: an undrawn
               page must have its real height, otherwise a jump to a page and
               the place after zooming are computed against emptiness. -->
          <canvas
            use:canvas={{ index, scale, column }}
            class="block w-full"
            style={`aspect-ratio: ${ratios[index] ?? aspect}`}
          ></canvas>
        </div>
      {/each}
    {/if}
    </div>
  </div>
</section>
