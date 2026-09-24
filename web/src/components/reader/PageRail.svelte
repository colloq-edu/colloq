<!--
  The page strip: thumbnails to jump by.

  As a COLUMN, not an overlay. An overlay would be cheaper — the column width is
  the scale, and opening the strip means re-rendering the document — but a strip
  people navigate with stays open, and an open overlay covers the left third of
  the page. We pay with a re-render exactly where we pay for scale, and in the
  same way: the space in the document is taken away before and given back after.

  Closed by default: a room that watches the slides in order never needs it
  once. Picking a page does NOT close it — people usually go through it several
  times in a row, and closing after every jump means making them open it again.

  The strip has no header of its own: both a title and a close cross would
  repeat the "Pages" button in the control bar, and two places that say the same
  thing drift apart. It is closed by the same thing that opened it.

  Thumbnails are drawn as they are scrolled to. Forty drawn canvases are
  hundreds of megabytes, and a strip that renders the whole document when it
  opens is worse than no strip at all.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import type { Lead } from '@/lib/follow'

  interface Props {
    doc: PDFDocumentProxy
    pages: number
    /** Where the viewer is now — this page is marked. */
    page: number
    /** Where the teacher is, when followed: a mark in their colour. */
    lead: Lead | null
    onpick: (page: number) => void
  }

  let { doc, pages, page, lead, onpick }: Props = $props()

  /** Thumbnail width: wider is not a thumbnail, narrower is not a page. */
  const WIDTH = 108

  /**
   * The proportion of the thumbnail slot — taken from the document's first
   * page.
   *
   * It was hard-wired to A4, and the strip lied about everything that is not
   * A4: a lecture is given from slides, and a slide is landscape — so the strip
   * showed a column of tall white rectangles, each of which later got a flat
   * picture stamped into it, and until the first render the strip showed a
   * document that did not exist. Computed once from the first page: a thumbnail
   * is a slot for a picture, not the picture itself, and variety across two
   * hundred pages is not its business.
   */
  let aspect = $state('1 / 1.414')
  $effect(() => {
    const source = doc
    let dropped = false
    void source
      .getPage(1)
      .then((first) => {
        if (dropped) return
        const view = first.getViewport({ scale: 1 })
        aspect = `${Math.round(view.width)} / ${Math.round(view.height)}`
      })
      .catch(() => {
        /* the document cannot be read — the strip will stay empty anyway */
      })
    return () => {
      dropped = true
    }
  })

  /*
   * What has already been drawn. A plain Set, not $state: the markup does not
   * read it — only the observer uses it, so as not to draw the same thing
   * twice.
   */
  const drawn = new Set<number>()

  async function paint(node: HTMLCanvasElement, index: number): Promise<void> {
    if (drawn.has(index)) return
    drawn.add(index)
    try {
      const source = await doc.getPage(index)
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const base = source.getViewport({ scale: 1 })
      const viewport = source.getViewport({ scale: (WIDTH / base.width) * ratio })
      node.width = viewport.width
      node.height = viewport.height
      node.style.width = '100%'
      node.style.height = 'auto'
      /*
       * A drawn page knows its own proportion, and a slot proportion set from
       * outside would override it: in a document where a hundred slides are
       * followed by a portrait appendix, the appendix would come out squashed
       * into a slide.
       */
      node.style.aspectRatio = 'auto'
      const context = node.getContext('2d')
      if (!context) return
      await source.render({ canvas: node, canvasContext: context, viewport }).promise
    } catch {
      // A page that could not be drawn stays an empty sheet — that is more
      // honest than a red pill on a strip people merely jump around with.
      drawn.delete(index)
    }
  }

  /**
   * Draw when the eyes have reached the thumbnail.
   *
   * `rootMargin` of two strip heights: the page has time to be drawn before it
   * is visible, and the strip does not flash empty sheets under the finger.
   */
  function lazy(node: HTMLCanvasElement, index: number) {
    const watcher = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        watcher.disconnect()
        void paint(node, index)
      },
      { root: node.closest('[data-rail]'), rootMargin: '400px 0px' },
    )
    watcher.observe(node)
    return {
      destroy() {
        watcher.disconnect()
      },
    }
  }

  /* An open strip follows the current page: scroll the document, and the mark
     is in place rather than where it was left. */
  let rail = $state<HTMLElement | null>(null)
  $effect(() => {
    const at = page
    rail?.querySelector(`[data-thumb="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  })
</script>

<div
  class="flex w-[148px] shrink-0 flex-col border-r border-line bg-surface"
  data-rail
  bind:this={rail}
>
  <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
    {#each Array.from({ length: pages }, (_, i) => i + 1) as index (index)}
      {@const here = index === page}
      {@const teacher = lead?.page === index}
      <button
        type="button"
        data-thumb={index}
        class="mb-2 flex w-full items-start gap-1.5 text-left focus-visible:outline-none"
        title={tr('room.extra.297', { p0: index })}
        onclick={() => onpick(index)}
      >
        <span
          class="w-4 shrink-0 pt-1 text-right font-mono text-micro tabular-nums {here
            ? 'font-bold text-ink'
            : 'text-faint'}"
        >
          {index}
        </span>
        <span class="relative min-w-0 flex-1">
          <!-- The border goes on the wrapper, not on the canvas: the canvas
               changes size when the page finishes drawing, and a border on it
               would twitch. -->
          <span
            class="block border bg-white transition-colors duration-100 {here
              ? 'border-accent'
              : 'border-line hover:border-faint'}"
          >
            <canvas use:lazy={index} class="block w-full" style={`aspect-ratio: ${aspect}`}></canvas>
          </span>
          {#if teacher && lead}
            <!-- A mark in the teacher's colour: it comes from the design, and
                 it answers the question "where are they now" without making
                 anyone scroll. -->
            <span
              class="absolute -left-1 top-1 h-2 w-2 rounded-full ring-2 ring-surface"
              style={`background:${lead.color}`}
              title={tr('room.extra.300', { p0: lead.name })}
            ></span>
          {/if}
        </span>
      </button>
    {/each}
  </div>
</div>
