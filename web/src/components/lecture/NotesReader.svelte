<!--
  THE SPEAKER NOTES AS THE CONSOLE READS THEM.

  The editor (NotesPad) is where the talk is written; this is where it is
  read: in the notes column of the landscape console, under the slide in
  portrait, and full-screen in the teleprompter. Reading happens with the
  head raised, in half-second glances between sentences, so the text is set
  the way a script is set, not the way a document is:

   · markdown is rendered (the same lazy pipeline and the same sanitizer as a
     text cell in the notebook, lib/render.svelte.ts) and inert: a link is its
     words, an image its alt text, because a tap that leaves the console
     mid-lecture is the worst thing a reader can do;
   · a fully italic paragraph is a stage direction ("Pause. Let the room
     guess"): smaller and muted, so it is seen and not read out;
   · bold is the line the slide exists for: brighter than the rest;
   · "If asked" paragraphs fold into a callout with the question on its face
     (the rule is in ./notes-script.ts);
   · every page starts at the top: the reader's scroll box is the same
     element across pages, and without a reset the next slide opened halfway
     through its note.

  There is no input here at all, and the text cannot be selected: the column
  lies where a right hand's palm rests while writing on the slide, and a long
  touch on selectable text starts a system selection with a loupe in the
  middle of a formula.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { tick } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import { readNote } from './notes-script'

  interface Props {
    /** The note's markdown, as stored. */
    text: string
    /** This document's notes have arrived: "none yet" and "none" are different screens. */
    arrived: boolean
    /** A blank sheet: it never has a note. */
    onBoard?: boolean
    /** Body size in px: 18 / 22 / 28 in the column and in portrait, up to 40 in the teleprompter. */
    size: number
    /**
     * Where the note belongs, as `file:page`. A change means another page:
     * the reader scrolls back to the top and folds the callouts again.
     */
    place: string
    /** Open "If asked" callouts from the start: the teleprompter has the room for the answer. */
    asksOpen?: boolean
    /**
     * A narrow column (the landscape notes column, 380 px): the callout puts
     * its label on a line of its own instead of beside the question.
     */
    narrow?: boolean
    /** The ground the reader lies on, for the fade at the bottom edge. */
    ground?: 'canvas' | 'surface'
    /** Padding classes of the text column. */
    pad?: string
    /** The longest line, in px: past ~60 characters a line is not read in one glance. */
    measure?: number
    /**
     * The slide's budget ("≈ 1.2 мин") as the first line of the text, set as
     * a stage direction. For the homes that have no header to lift it into:
     * the portrait dock and the prompter. The column says it in its header
     * and passes nothing.
     */
    timing?: string
  }

  let {
    text,
    arrived,
    onBoard = false,
    size,
    place,
    asksOpen = false,
    narrow = false,
    ground = 'canvas',
    pad = 'px-7',
    measure = 720,
    timing = '',
  }: Props = $props()

  /*
   * The renderer arrives as a chunk of its own (lib/render.svelte.ts); until
   * then every block is shown as its plain source with the line structure
   * kept, which is how markdown is meant to read anyway.
   */
  loadRenderers()
  const render = $derived(renderers())

  const script = $derived(readNote(text))
  const blocks = $derived(
    script.blocks.map((block) =>
      block.kind === 'text'
        ? { ...block, html: render ? render.markdown(block.source, { inert: true }) : null }
        : {
            ...block,
            questionHtml: render ? inline(render.markdown(block.question, { inert: true })) : null,
            answerHtml: block.answer && render ? render.markdown(block.answer, { inert: true }) : null,
          },
    ),
  )
  const empty = $derived(script.blocks.length === 0)

  /** One paragraph's worth of markup without its `<p>`: the question sits in a row. */
  function inline(html: string): string {
    return html.replace(/^\s*<p>([\s\S]*)<\/p>\s*$/, '$1')
  }

  /*
   * Type steps. The body, the stage direction, the quote and the callout each
   * have their own size per step, taken from the console drawings (Paper
   * N1/N2): a remark one step below the body, a quote between the two.
   */
  const SCALE: Record<number, { body: number; lead: number; remark: number; quote: number; ask: number; gap: number }> = {
    18: { body: 18, lead: 26, remark: 16, quote: 17, ask: 16, gap: 16 },
    22: { body: 22, lead: 32, remark: 18, quote: 20, ask: 18, gap: 20 },
    28: { body: 28, lead: 40, remark: 22, quote: 26, ask: 20, gap: 20 },
    34: { body: 34, lead: 46, remark: 26, quote: 30, ask: 22, gap: 24 },
    40: { body: 40, lead: 54, remark: 30, quote: 34, ask: 24, gap: 28 },
  }
  const scale = $derived(SCALE[size] ?? SCALE[22])
  const vars = $derived(
    `--pp-body:${scale.body}px;--pp-lead:${scale.lead}px;--pp-remark:${scale.remark}px;` +
      `--pp-quote:${scale.quote}px;--pp-ask:${scale.ask}px;--pp-gap:${scale.gap}px;max-width:${measure}px`,
  )

  /* ------------------------------------------------------- callouts */

  /** Which callouts are open, by index on this page. */
  let open = $state<Record<number, boolean>>({})

  /* ------------------------------------------------- scroll and fade */

  let scroller = $state<HTMLDivElement | null>(null)
  let content = $state<HTMLDivElement | null>(null)
  /** The track of the scroll indicator: shown only when the note is longer than the box. */
  let track = $state({ over: false, atEnd: true, top: 0, height: 0 })

  function measureScroll(): void {
    const node = scroller
    if (!node) return
    const over = node.scrollHeight > node.clientHeight + 2
    const ratio = node.clientHeight / Math.max(1, node.scrollHeight)
    track = {
      over,
      atEnd: node.scrollTop + node.clientHeight >= node.scrollHeight - 4,
      top: (node.scrollTop / Math.max(1, node.scrollHeight)) * 100,
      height: Math.max(8, ratio * 100),
    }
  }

  /*
   * A new page starts at the top, with its callouts folded (or open, in the
   * teleprompter). After a tick: the new text has to be in the box before
   * the box can be scrolled.
   */
  $effect(() => {
    void place
    open = {}
    void tick().then(() => {
      if (scroller) scroller.scrollTop = 0
      measureScroll()
    })
  })

  /* The box and the text change size on rotation, A−/A+ and a callout opening. */
  $effect(() => {
    const box = scroller
    const inner = content
    if (!box || !inner) return
    const watch = new ResizeObserver(() => measureScroll())
    watch.observe(box)
    watch.observe(inner)
    return () => watch.disconnect()
  })

  /*
   * Stage directions are found in the rendered markup, not in the source: a
   * paragraph that consists of one `<em>` and nothing else. CSS cannot say
   * that (`:only-child` ignores the text around an element), so the class is
   * set after each render.
   */
  $effect(() => {
    void blocks
    void open
    const inner = content
    if (!inner) return
    void tick().then(() => {
      for (const paragraph of inner.querySelectorAll('.pp-text p, .pp-answer p')) {
        const nodes = [...paragraph.childNodes].filter(
          (node) => !(node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()),
        )
        const remark = nodes.length === 1 && (nodes[0] as Element).tagName === 'EM'
        paragraph.classList.toggle('pp-remark', remark)
      }
      measureScroll()
    })
  })
</script>

<div class="relative flex min-h-0 flex-1 flex-col">
  <div
    bind:this={scroller}
    class="pult-prompt pult-reader min-h-0 flex-1 overflow-y-auto overscroll-contain {pad}"
    onscroll={measureScroll}
  >
    <div bind:this={content} class="pult-prose pb-10" style={vars}>
      {#if !arrived}
        <p class="flex items-center gap-2 py-2 text-ui text-muted" aria-live="polite">
          <Icon name="spinner" size={14} class="shrink-0 animate-spin" />
          {tr('room.ui.196')}
        </p>
      {:else if onBoard}
        <p class="pp-quiet">{tr('room.ui.314')}</p>
      {:else if empty}
        <p class="pp-quiet">{tr('room.ui.315')}</p>
      {:else}
        {#if timing}
          <p class="pp-remark italic">{timing}</p>
        {/if}
        {#each blocks as block, index (index)}
          {#if block.kind === 'text'}
            {#if block.html !== null}
              <div class="pp-text">{@html block.html}</div>
            {:else}
              <div class="pp-text whitespace-pre-wrap">{block.source}</div>
            {/if}
          {:else}
            {@const shown = open[index] ?? asksOpen}
            {@const foldable = block.answer !== ''}
            <div class="pp-ask border-l-2 border-accent bg-raised" data-pult-ask>
              <button
                type="button"
                class="pp-ask-head flex w-full text-left {narrow ? 'flex-wrap' : 'items-center'} gap-x-3 gap-y-1.5"
                aria-expanded={foldable ? shown : undefined}
                disabled={!foldable}
                onclick={() => (open = { ...open, [index]: !shown })}
              >
                <span
                  class="shrink-0 font-mono text-micro font-bold uppercase tracking-label text-accent-text {narrow
                    ? 'order-1 flex-1'
                    : ''}"
                >
                  {tr('room.prompter.ask')}
                </span>
                <span class="pp-question min-w-0 {narrow ? 'order-3 basis-full' : 'flex-1'}">
                  {#if block.questionHtml !== null}{@html block.questionHtml}{:else}{block.question}{/if}
                </span>
                {#if foldable}
                  <Icon
                    name={shown ? 'chevron-up' : 'chevron-down'}
                    size={20}
                    class="shrink-0 text-muted {narrow ? 'order-2' : ''}"
                  />
                {/if}
              </button>
              {#if shown && foldable}
                <div class="pp-answer">
                  {#if block.answerHtml !== null}{@html block.answerHtml}{:else}
                    <div class="whitespace-pre-wrap">{block.answer}</div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        {/each}
      {/if}
    </div>
  </div>

  {#if track.over}
    <!--
      The fade says "there is more below" without a word: the reader is a
      column of text, and its last visible line would otherwise look like the
      end of the note.
    -->
    {#if !track.atEnd}
      <span
        class="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent {ground ===
        'surface'
          ? 'to-surface'
          : 'to-canvas'}"
        aria-hidden="true"
      ></span>
    {/if}
    <!-- The track instead of the system scrollbar: same place, a hairline, no hover state. -->
    <span class="pointer-events-none absolute bottom-2.5 right-3.5 top-1.5 w-0.5 bg-line" aria-hidden="true">
      <span class="absolute inset-x-0 bg-muted" style={`top:${track.top}%;height:${track.height}%`}></span>
    </span>
  {/if}
</div>

<style>
  /*
   * The scroll box draws no system scrollbar: the hairline track above
   * replaces it, and a 15 px desktop gutter would eat the measure.
   */
  .pult-reader {
    scrollbar-width: none;
    touch-action: pan-y;
    /* Spelled out rather than inherited from the console root: see the header. */
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .pult-reader::-webkit-scrollbar {
    display: none;
  }

  .pult-prose {
    display: flex;
    flex-direction: column;
    gap: var(--pp-gap);
    color: rgb(var(--ink));
    font-size: var(--pp-body);
    line-height: var(--pp-lead);
    letter-spacing: -0.005em;
    overflow-wrap: anywhere;
  }

  .pp-quiet {
    color: rgb(var(--muted));
  }

  /* Markdown inside a text block: the rules reach {@html}, hence :global. */
  .pp-text {
    display: flex;
    flex-direction: column;
    gap: var(--pp-gap);
  }
  .pp-text :global(:where(p, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6, .table-scroll, .katex-display)) {
    margin: 0;
  }
  /*
   * Bold is the line the slide exists for, and on the night ground it is set
   * one step brighter than the body: pure white is the only value above the
   * ink token, and the console is always dark (see borrowTheme in
   * ConsoleView), so it never lands on a light ground.
   */
  .pult-prose :global(strong) {
    font-weight: 700;
    color: #fff;
  }
  .pult-prose :global(em) {
    font-style: italic;
  }
  /* A stage direction: a whole paragraph in italics. */
  .pult-prose :global(p.pp-remark),
  .pp-remark {
    font-size: var(--pp-remark);
    line-height: 1.45;
    color: rgb(var(--muted));
  }
  /* Headings are cue lines, not chapter titles: body size, heavier. */
  .pult-prose :global(:where(h1, h2, h3, h4, h5, h6)) {
    font-size: var(--pp-body);
    line-height: var(--pp-lead);
    font-weight: 700;
  }
  .pult-prose :global(ul) {
    list-style: square;
    padding-left: 1.1em;
  }
  .pult-prose :global(ol) {
    list-style: decimal;
    padding-left: 1.3em;
  }
  .pult-prose :global(li + li) {
    margin-top: 0.25em;
  }
  .pult-prose :global(li::marker) {
    color: rgb(var(--faint));
  }
  /* Nested items keep their outline: that is how talks are drafted. */
  .pult-prose :global(li > :where(ul, ol)) {
    margin-top: 0.25em;
  }
  .pult-prose :global(blockquote) {
    border-left: 2px solid rgb(var(--faint));
    padding-left: 22px;
    font-size: var(--pp-quote);
    line-height: 1.45;
    font-style: italic;
  }
  .pult-prose :global(code) {
    font-family: var(--font-mono);
    font-size: 0.78em;
    background: rgb(var(--raised));
    padding: 0.05em 0.3em;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }
  .pult-prose :global(pre) {
    max-width: 100%;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    border-left: 2px solid rgb(var(--line));
    background: rgb(var(--surface));
    padding: 8px 12px;
    font-size: 0.7em;
    line-height: 1.5;
  }
  .pult-prose :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: 1em;
  }
  .pult-prose :global(.table-scroll) {
    max-width: 100%;
    overflow-x: auto;
  }
  .pult-prose :global(table) {
    border-collapse: collapse;
    font-size: 0.75em;
    line-height: 1.4;
  }
  .pult-prose :global(:where(th, td)) {
    border: 1px solid rgb(var(--line));
    padding: 4px 8px;
    overflow-wrap: break-word;
  }
  .pult-prose :global(hr) {
    border: 0;
    border-top: 1px solid rgb(var(--line));
  }

  /* The "If asked" callout. */
  .pp-ask {
    padding: 14px 16px 16px 20px;
  }
  .pp-ask-head {
    min-height: 24px;
  }
  .pp-question {
    font-size: var(--pp-ask);
    line-height: 1.4;
    font-weight: 600;
    color: rgb(var(--ink));
  }
  .pp-answer {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: calc(var(--pp-gap) * 0.6);
    font-size: max(var(--pp-ask), calc(var(--pp-body) * 0.8));
    line-height: 1.45;
  }
  .pp-answer :global(p) {
    margin: 0;
  }
</style>
