<script lang="ts">
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
  const parts = $derived.by(() => {
    const all = splitAnswer(source)
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
    // Ответ оракула становится ячейкой — то есть добавляется ячейка, а это
    // право комнаты. Иначе кнопка «в ячейку» делала бы вид, что сработала.
    const may = permitsIn(session.session.rules, session.me.role)
    if (!may.add) {
      session.showError(may.structureWhy + '.')
      return
    }
    /*
     * В ту тетрадь, о которой был разговор, — и в ту, что открыта, если
     * разговор был ни о какой. Тетрадей несколько, и класть ответ про чужой
     * лист в свой значило бы отвечать не туда, куда смотрели; а тетрадь
     * комнаты, выбранная за неимением ячейки, — это чужой лист для всякого,
     * кто открыл второй.
     */
    const open = session.editingPath ? bookAt(session.doc, session.editingPath) : null
    const root =
      (cellId ? rootOfCell(session.doc, cellId) : null) ?? open?.root ?? mainRoot(session.doc)
    const found = cellId ? findCell(session.doc, cellId) : null
    const at = found ? found.index + 1 : bookCells(session.doc, root).length
    const created = insertCell(session.doc, root, 'code', at, code)
    /*
     * Через revealCell, а не выделением с прокруткой: тетрадь, в которую легла
     * ячейка, может быть спрятанной — все открытые смонтированы, неактивные
     * скрыты классом, — и `scrollIntoView` внутри спрятанного не делает
     * ничего. Нажатие выглядело как несработавшее, а второе нажатие заводило
     * вторую такую же ячейку.
     */
    revealCell(session, created)
  }

  const STRIP =
    'inline-flex h-[19px] shrink-0 items-center gap-1 border border-line px-1.5 text-2xs ' +
    'font-bold uppercase tracking-caps text-muted transition-colors duration-[var(--speed-quick)] ' +
    'hover:border-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-accent/40'
</script>

<div class={cn('flex flex-col gap-2.5', className)}>
  {#each parts as part, index (index)}
    {#if part.kind === 'prose'}
      <Markdown
        class="prose-answer"
        source={streaming && index === parts.length - 1 ? part.text + CARET : part.text}
      />
    {:else}
      <div class="flex flex-col items-stretch border border-line bg-canvas">
        <div
          class="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-surface pl-2 pr-1.5"
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
              {copied === index ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              class={STRIP}
              title="Put this into the notebook as a new cell"
              onclick={() => toCell(part.code)}
            >
              <Icon name="plus" size={10} />
              New cell
            </button>
          {/if}
        </div>
        <Code code={part.code} lang={part.lang} class="px-2.5 py-2" />
      </div>
    {/if}
  {/each}
</div>
