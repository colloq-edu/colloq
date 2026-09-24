<!--
  A plotly chart — in a sandboxed frame, not in the class page.

  Why exactly this way is written in `shared/plotly.ts` and
  `server/src/plotly-frame.ts`; here is the notebook's side. Three things it
  does that the frame does not:

  LAZINESS. The frame is not created until the chart has come close to the
  screen, and the figure is not downloaded until the frame has been created.
  Otherwise a notebook with twenty charts would pull twenty copies of a
  five-megabyte bundle and twenty figures in the very first second — while one
  and a half fit on the screen.

  ROOM FOR THE CHART. The height is computed BEFORE anything loads
  (`figureHeight`), and the backdrop is drawn at full size right away: otherwise
  the notebook jumps under the cursor every time another frame arrives. The
  white backdrop is the same as for matplotlib images, and it also removes the
  white flash: the frame itself is transparent.

  WORDS INSTEAD OF EMPTINESS. If nothing got drawn — a line with the reason. An
  empty space under "Out [7]" reads as "the code printed nothing", and that is a
  lie.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import {
    PLOTLY_DEFAULT_HEIGHT,
    PLOTLY_FRAME_PATH,
    PLOTLY_MSG,
    PLOTLY_ORIGIN_PARAM,
    figureHeight,
    isPlotlyMessage,
    normalizeFigure,
    type PlotlyFigure,
  } from '@shared/plotly'

  interface Props {
    /**
     * The figure: JSON text if it lies in the document, or an address if it has
     * been moved out into a separate record (large ones always are, see
     * `SPILL_MIMES`).
     */
    payload: string
    /** Address: the figure must be fetched; otherwise it is already here. */
    address: boolean
    /**
     * The key in the address has gone stale — the same case as with images: the
     * room is open for an hour and a half, a key lives five minutes. The
     * notebook takes a new one and redraws the record with the new address;
     * this must not be called more than once per record.
     */
    onstale?: () => void
  }

  let { payload, address, onstale }: Props = $props()

  /**
   * The figure, normalized to `{data, layout, frames}`; `null` means there is
   * nothing to read.
   *
   * `$state.raw`, not ordinary state, and this is not an optimization: ordinary
   * Svelte state wraps the WHOLE depth of the object in a Proxy, and
   * `postMessage` clones structurally and fails on a Proxy with DataCloneError.
   * The figure is replaced as a whole, so there is no point in tracking its
   * insides anyway.
   */
  let figure = $state.raw<PlotlyFigure | null>(null)
  /** The reason there will be no chart. Shown in words. */
  let failure = $state<string | null>(null)
  /** Drawn: the frame reported its height. Until then the placeholder shows. */
  let drawn = $state(false)
  /** Whether the output is near the screen. Until then nothing is set up. */
  let near = $state(false)

  let frame = $state<HTMLIFrameElement | null>(null)
  /** Height: from the figure before drawing, from the frame after. */
  let height = $state(PLOTLY_DEFAULT_HEIGHT)
  /** So a record missing on the server does not ask for new keys forever. */
  let asked = false

  const src = $derived(
    `${PLOTLY_FRAME_PATH}?${PLOTLY_ORIGIN_PARAM}=${encodeURIComponent(location.origin)}`,
  )

  /**
   * The visibility observer — one root for the whole notebook is not needed: a
   * margin of half a screen below gives the frame time to load before it is
   * scrolled to, and leaves alone whatever lies pages further down.
   */
  function watch(node: HTMLElement) {
    if (typeof IntersectionObserver !== 'function') {
      near = true
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        near = true
        // Not switched back off: an unloaded frame would lose the zoom and the
        // legend position that the person has just set by hand.
        observer.disconnect()
      },
      { rootMargin: '400px 0px' },
    )
    observer.observe(node)
    return { destroy: () => observer.disconnect() }
  }

  /** Parse what lies in the document — or fetch what has been moved out. */
  $effect(() => {
    const body = payload
    const remote = address
    if (!near) return
    let alive = true
    failure = null
    if (!remote) {
      // Through a local variable: reading state that has just been written,
      // right inside the effect, is an update loop, and Svelte fails it out
      // loud.
      const here = read(body)
      figure = here
      failure = here ? null : tr('room.output.plotlyBroken')
      return
    }
    figure = null
    void fetch(body, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        return read(await res.text())
      })
      .then((got) => {
        if (!alive) return
        figure = got
        if (!got) failure = tr('room.output.plotlyBroken')
      })
      .catch(() => {
        if (!alive) return
        /*
         * A refusal at the address is almost always a stale key, and it is
         * cured the same way as for images: ask for a new one and redraw. Once:
         * otherwise a record that does not exist on the server at all would go
         * round in circles.
         */
        if (!asked && onstale) {
          asked = true
          onstale()
          return
        }
        failure = tr('room.output.plotlyBroken')
      })
    return () => {
      alive = false
    }
  })

  function read(text: string): PlotlyFigure | null {
    try {
      return normalizeFigure(JSON.parse(text))
    } catch {
      return null
    }
  }

  /** Room for the chart — from the figure, until the frame gives its own. */
  $effect(() => {
    const got = figure
    if (got && !drawn) height = figureHeight(got)
  })

  /**
   * Talking to the frame.
   *
   * A sandbox's origin is the string "null", the same as that of any other
   * sandbox on the page, so checking it is pointless. What is checked is the
   * SOURCE: a message is accepted only from the window that we created
   * ourselves.
   */
  $effect(() => {
    const node = frame
    if (!node) return
    const listener = (event: MessageEvent): void => {
      if (event.source !== node.contentWindow) return
      if (!isPlotlyMessage(event.data)) return
      const msg = event.data as { kind: string; height?: unknown; reason?: unknown }
      if (msg.kind === 'ready') {
        send(node)
      } else if (msg.kind === 'height' && typeof msg.height === 'number') {
        height = Math.max(40, Math.round(msg.height))
        drawn = true
      } else if (msg.kind === 'failed') {
        const reason = typeof msg.reason === 'string' ? msg.reason : ''
        failure =
          reason === 'bundle'
            ? tr('room.output.plotlyBundle')
            : tr('room.output.plotlyFailed', { p0: reason.slice(0, 200) })
      }
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  })

  /** The figure arrived after the frame said "ready" — send it again. */
  $effect(() => {
    const node = frame
    const got = figure
    if (node && got && node.dataset.ready === '1') send(node)
  })

  /**
   * The frame did not answer at all — say so in words.
   *
   * A placeholder instead of a chart is an honest answer only as long as
   * something really is on its way. If the frame did not open at all (the route
   * refused, a build without the bundle), there is nothing to wait for, and the
   * screen would show an eternal placeholder that does not tell "loading" from
   * "broken".
   *
   * A minute and a half, because the bundle is five megabytes (1.1 MB brotli),
   * and on seminar wifi that is tens of seconds, not fractions of one.
   */
  const SILENCE_MS = 90_000

  $effect(() => {
    const node = frame
    if (!node || drawn || failure) return
    const timer = setTimeout(() => {
      if (!drawn) failure = tr('room.output.plotlyBundle')
    }, SILENCE_MS)
    return () => clearTimeout(timer)
  })

  function send(node: HTMLIFrameElement): void {
    node.dataset.ready = '1'
    const got = figure
    if (!got) return
    /*
     * The height travels along with the figure so that the frame does not
     * invent its own: the notebook has already reserved the space for the chart
     * with this same number, and letting the two diverge would mean jerking the
     * page at the moment of drawing.
     *
     * `targetOrigin` is "*", and it cannot be anything else: a sandbox's origin
     * is opaque, and any other value simply will not match. There is no leak
     * here: the message carries exactly what already lies in the notebook in
     * plain view of everyone.
     */
    node.contentWindow?.postMessage(
      {
        colloq: PLOTLY_MSG,
        kind: 'draw',
        figure: { ...got, layout: { ...got.layout, height: figureHeight(got) } },
      },
      '*',
    )
  }
</script>

<div use:watch>
  {#if failure}
    <div class="px-2 py-1 text-code text-warning">{failure}</div>
  {:else}
    <!--
      A backdrop of exactly the same colour as for matplotlib images: we do not
      recolour the figure (it has its own template, and in the dark theme it
      stays light), and the frame around it has to look the same as the frame
      around a chart drawn by the neighbouring cell.
    -->
    <div
      class="relative overflow-hidden rounded bg-white/95 p-1"
      style:height={`${height + 8}px`}
    >
      {#if near}
        <iframe
          bind:this={frame}
          {src}
          title={tr('room.output.plotlyTitle')}
          sandbox="allow-scripts allow-downloads"
          referrerpolicy="no-referrer"
          loading="lazy"
          class="block h-full w-full border-0"
          onload={() => {
            /*
             * The figure is sent on `load`, not on "ready" from the frame, and
             * this is not duplication. `load` happens when the frame's markup
             * has been parsed, that is, when its loader has ALREADY installed
             * its listener — whereas "ready" also waits for five megabytes of
             * bundle. A message that arrives before the bundle is held by the
             * frame and drawn as soon as plotly arrives; that way there is
             * exactly one load between "the cell is visible" and "the chart is
             * visible", not two.
             */
            if (frame) send(frame)
          }}
        ></iframe>
      {/if}
      {#if !drawn}
        <!-- A placeholder the size of the chart: while five megabytes of plotly
             are on their way, the chart's place should show that a chart will
             be there. The shared one, not a local one: there is one for the
             whole product, and only it knows how to keep still under
             `prefers-reduced-motion`. -->
        <div class="pointer-events-none absolute inset-1 flex">
          <Skeleton width="100%" height="100%" radius="3px" />
        </div>
      {/if}
    </div>
  {/if}
</div>
