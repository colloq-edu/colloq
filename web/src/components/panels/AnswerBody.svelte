<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * An answer, with its code taken out of the prose.
   *
   * Everything the oracle says is markdown, but not all of it is text to read.
   * A fenced block is code, and code in a seminar is something a person copies,
   * runs, or puts into a cell — none of which a paragraph offers. Rendering the
   * whole answer through the markdown renderer produced a `<pre>` that could be
   * selected with a mouse and nothing else, and that quietly clipped its long
   * lines at the panel's edge.
   *
   * So the answer is split first: prose goes to the renderer as before, and each
   * block comes back as itself, with a strip naming its language and offering
   * the two things anybody wants from it.
   */
  import { splitAnswer } from '@shared/answer'
  import { getSessionState } from '@/lib/session.svelte'
  import { insertCell } from '@/lib/notebook-ops'
  import { permitsIn } from '@/lib/may'
  import { bookAt, bookCells, findCell, mainRoot, rootOfCell } from '@shared/notebook'
  import { cn } from '@/lib/utils'
  import { revealCell } from '@/lib/reveal'
  import Icon from '@/components/ui/Icon.svelte'
  import Code from '@/components/ui/Code.svelte'
  import Markdown from '@/components/notebook/Markdown.svelte'
  import { copyText } from '@/lib/clipboard'

  interface Props {
    source: string
    /** True while the answer is still arriving; the caret rides the last part. */
    streaming?: boolean
    /** The cell the question was about — where a new cell goes. */
    cellId?: string | null
    /**
     * A block the caller draws itself, and which must not appear twice.
     *
     * A rewrite turn ends with the complete new source of a cell, and the
     * proposal block below renders exactly that — as a diff, with the decision
     * attached. Left in the prose as well it appeared twice in a row: once as
     * something to copy and once as something to accept, the second one being
     * the only one that means anything.
     */
    omit?: string | null
    class?: string
  }

  let {
    source,
    streaming = false,
    cellId = null,
    omit = null,
    class: className = '',
  }: Props = $props()

  const session = getSessionState()

  /**
   * While the answer is being written — no more often than the eye can follow.
   *
   * Every piece of the answer arrives as a separate document frame, and on each
   * one the whole accumulated text was split into parts again, run through
   * marked and DOMPurify and replaced in the DOM via {@html}: work proportional
   * to the length of the WHOLE answer on every token, that is, quadratic in it,
   * for everyone who has the thread open. For stdout such a "tail" has long
   * been incremental (render.svelte.ts); markdown markup has no tail — but none
   * is needed: eight updates a second read to a person as continuous typing,
   * not as jerks.
   *
   * A finished answer is shown in the same frame it arrived in: as soon as
   * `streaming` is cleared, the timer is cleared with it and the text is put in
   * whole. Waiting 120 ms on the last word would be visible.
   */
  const STREAM_TICK = 120
  /**
   * The shown slice of the stream — or null when there is nothing to wait for.
   *
   * Via null, not a copy of `source`: while `streamed` is empty, `shown` reads
   * `source` itself and stays exact (first frame, finished answer,
   * cancellation). As soon as there is a slice, `source` drops out of the
   * dependencies — and the arrival of a piece by itself recomputes nothing.
   */
  let streamed = $state<string | null>(null)
  let tick: number | undefined

  const shown = $derived(streaming ? (streamed ?? source) : source)

  $effect(() => {
    const text = source
    if (!streaming) {
      window.clearTimeout(tick)
      tick = undefined
      streamed = null
      return
    }
    // The first piece — at once: a bubble waiting for its first frame reads as
    // a question that was never asked.
    if (tick !== undefined) return
    streamed = text
    tick = window.setTimeout(() => {
      tick = undefined
      streamed = source
    }, STREAM_TICK)
  })

  $effect(() => () => window.clearTimeout(tick))

  const parts = $derived.by(() => {
    const all = splitAnswer(shown)
    if (omit === null) return all
    // The LAST matching block only: an answer that shows the broken line first
    // and the fix second has two blocks, and the first one is an illustration
    // the reader still wants.
    for (let i = all.length - 1; i >= 0; i--) {
      const part = all[i]
      if (part.kind !== 'code' || !part.closed) continue
      if (part.code.replace(/\s+$/, '') !== omit) continue
      return [...all.slice(0, i), ...all.slice(i + 1)]
    }
    return all
  })

  /** Rides inside the prose markdown so it sits right after the last token. */
  const CARET = '<span class="ai-caret" aria-hidden="true"></span>'

  /**
   * Which block said "copied", and a timer to take it back.
   *
   * Indexed rather than boolean: an answer can hold two blocks, and a single
   * flag would light the wrong one.
   */
  let copied = $state<number | null>(null)
  let copiedTimer: number | undefined

  $effect(() => () => window.clearTimeout(copiedTimer))

  async function copy(index: number, code: string) {
    try {
      await copyText(code)
      copied = index
      window.clearTimeout(copiedTimer)
      copiedTimer = window.setTimeout(() => (copied = null), 1400)
    } catch {
      // A browser that refuses the clipboard leaves the text selectable, which
      // is the fallback every reader already knows. Nothing to announce.
    }
  }

  /**
   * Put the block into the notebook as a new cell, below the one asked about.
   *
   * Deliberately additive. Overwriting the cell is a different act with a
   * different name — a rewrite the room accepts — and it is offered by the
   * proposal block, against a base the model actually read. Code inside an
   * explanation was never written against anything, so it may only ever arrive
   * as something new.
   */
  function toCell(code: string) {
    // The oracle's answer becomes a cell — that is, a cell is added, and that
    // is a room permission. Otherwise the "To cell" button would pretend it had
    // worked.
    const may = permitsIn(session.session.rules, session.me.role, session.finished)
    if (!may.add) {
      session.showError(may.structureWhy + '.')
      return
    }
    /*
     * Into the notebook the conversation was about — and into the open one if
     * the conversation was about none. There are several notebooks, and putting
     * an answer about someone else's sheet into one's own would mean answering
     * somewhere other than where people were looking; and the room's notebook,
     * chosen for lack of a cell, is someone else's sheet for anyone who has
     * opened a second one.
     */
    const open = session.editingPath ? bookAt(session.doc, session.editingPath) : null
    const root =
      (cellId ? rootOfCell(session.doc, cellId) : null) ?? open?.root ?? mainRoot(session.doc)
    const found = cellId ? findCell(session.doc, cellId) : null
    const at = found ? found.index + 1 : bookCells(session.doc, root).length
    const created = insertCell(session.doc, root, 'code', at, code)
    /*
     * Via revealCell, not selection plus scrolling: the notebook the cell went
     * into may be hidden — all open ones are mounted, the inactive ones hidden
     * by a class — and `scrollIntoView` inside a hidden one does nothing. The
     * press looked as if it had not worked, and a second press created a second
     * identical cell.
     */
    revealCell(session, created)
  }

  const STRIP =
    'inline-flex min-h-6 shrink-0 items-center gap-1 border border-line px-1.5 py-0.5 text-2xs ' +
    'font-bold uppercase tracking-caps text-muted transition-colors duration-[var(--speed-quick)] ' +
    'hover:border-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-accent/40'
</script>

<!--
  `min-w-0` on the answer column and on the block box: without it a flex child
  takes the width of its content as its minimum, and one long code block would
  stretch the whole turn, and the feed with it — instead of scrolling inside
  itself.
-->
<div class={cn('flex min-w-0 flex-col gap-2.5', className)}>
  {#each parts as part, index (index)}
    {#if part.kind === 'prose'}
      <Markdown
        class="prose-answer"
        source={streaming && index === parts.length - 1 ? part.text + CARET : part.text}
      />
    {:else}
      <div class="flex min-w-0 flex-col items-stretch border border-line bg-canvas">
        <!--
          The strip wraps rather than poking out sideways. On a phone the panel
          is 92vw, and on a 320-pixel screen that is 294 px: "Copy" and "To
          cell" do not fit there next to the language name, and `shrink-0` is on
          them for a reason — a button squeezed down to an ellipsis does not say
          what it does. Hence wrapping onto lines and `min-h-7` instead of
          `h-7`: the second row of buttons has to be visible, not clipped in
          height.
        -->
        <div
          class="flex min-h-7 shrink-0 flex-wrap items-center gap-1.5 border-b border-line
                 bg-surface py-0.5 pl-2 pr-1.5"
        >
          <span class="shrink-0 font-mono text-micro text-faint">{part.lang || 'code'}</span>
          <div class="flex-1"></div>
          <!--
            A block still being written offers nothing: half a snippet copied is
            a paste that does not run, and a cell made from one is a cell
            somebody has to repair.
          -->
          {#if part.closed}
            <button type="button" class={STRIP} onclick={() => void copy(index, part.code)}>
              <Icon name={copied === index ? 'check' : 'copy'} size={10} />
              {copied === index ? tr('room.ui.138') : tr('room.ui.532')}
            </button>
            <button
              type="button"
              class={STRIP}
              title={tr('room.ui.533')}
              onclick={() => toCell(part.code)}
            >
              <Icon name="plus" size={10} /> {tr('room.ui.534')} </button>
          {/if}
        </div>
        <Code code={part.code} lang={part.lang} class="px-2.5 py-2" />
      </div>
    {/if}
  {/each}
</div>
