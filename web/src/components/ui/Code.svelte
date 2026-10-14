<script lang="ts">
  /**
   * A block of code outside an editor, painted the way the editor paints it.
   *
   * Lines are block spans rather than one run of text with newlines in it. That
   * is how CodeMirror itself lays a document out, and it is what makes an empty
   * line keep its height instead of collapsing — a blank line between two
   * functions is part of how the code reads.
   *
   * `lang` decides whether to highlight at all. A block the model tagged `bash`
   * or `json` is still code and still gets its strip and its scroll, but running
   * shell through a Python grammar would colour it confidently and wrongly,
   * which is worse than leaving it alone.
   */
  import { untrack } from 'svelte'
  import { loadSyntax, plain, syntax, type Token } from '@/lib/syntax.svelte'
  import { cn } from '@/lib/utils'
  import CodeLine from './CodeLine.svelte'

  interface Props {
    code: string
    /** The fence's language, lowercased. Empty counts as Python — see PYTHON. */
    lang?: string
    class?: string
    /**
     * Line numbers in a column to the left: the room's rule
     * (shared/rules.ts · lineNumbers), passed in by whoever draws code inside
     * a room — the attempt on screen and the council console.
     *
     * Off unless asked. A published class page and an oracle answer carry no
     * room rules at all, and a number on a snippet in a chat answer would
     * point at a line of nothing in particular.
     */
    lineNumbers?: boolean
    /**
     * How many lines the whole text has, when `code` is only its beginning.
     *
     * The council console shows a long attempt as its first forty lines
     * (PultWork · CODE_LINES) and unfolds the rest on a press. The number
     * column is sized for the whole text from the start, as the editor sizes
     * its own by the whole document, so unfolding a hundred-line attempt does
     * not move its code a digit to the right.
     */
    lineCount?: number
  }

  let { code, lang = '', class: className = '', lineNumbers = false, lineCount = 0 }: Props = $props()

  /*
   * An unlabelled fence is Python here. This is a Python seminar, the prompt
   * asks for Python, and the same assumption is already what decides whether a
   * block can become a cell (shared/answer.ts). Two places disagreeing about
   * what an untagged block is would be worse than either answer.
   */
  const PYTHON = new Set(['', 'python', 'py', 'python3'])
  const highlightable = $derived(PYTHON.has(lang))

  // Warms the chunk; harmless when it is already here.
  $effect(() => {
    if (highlightable) void loadSyntax()
  })

  const ready = $derived(highlightable ? syntax() : null)

  /*
   * The parse lags behind the text while the text is being written.
   *
   * The answer block grows in flushes (ANSWER_FLUSH_MS = 60 ms on the server),
   * and parsing here is not incremental: every flush is Lezer over the whole
   * block plus a pass over all the lines in CodeLine, and a five-hundred-line
   * file gets parsed dozens of times, each time more expensive than the last,
   * for everyone who has the panel open.
   *
   * Five frames a second instead of sixteen: to the eye it is the same stream,
   * and there are three times fewer parses. The last flush always gets
   * through — the timer is set on EVERY change, not only on the first — so a
   * finished block stands on screen in full, not without its last line.
   */
  const PAINT_MS = 200
  // svelte-ignore state_referenced_locally
  let shown = $state(code)
  let painted = 0

  $effect(() => {
    const next = code
    if (next === untrack(() => shown)) return
    const wait = Math.max(0, PAINT_MS - (Date.now() - painted))
    const timer = setTimeout(() => {
      painted = Date.now()
      shown = next
    }, wait)
    return () => clearTimeout(timer)
  })

  const lines = $derived.by((): Token[][] =>
    ready ? ready.lines(shown) : shown.split('\n').map(plain),
  )

  /*
   * How many digits the number column is wide: the editor's rule (cm-theme.ts
   * · cellNumbers), so a block reads like the cell it came from — at least
   * two, so a short attempt and a long one put their code at the same place,
   * and otherwise as many as the last number has. The last of the whole text
   * when the block shows only its beginning (`lineCount`), and never fewer
   * than the lines on screen: the paint lags the text (PAINT_MS), and for a
   * moment those may still be a longer text's.
   */
  const digits = $derived(Math.max(2, String(Math.max(lines.length, lineCount)).length))
</script>

<!--
  The only thing here that scrolls sideways is the block itself, and only the
  block. `max-w-full` so that a four-hundred-character line does not stretch the
  turn's box; `overscroll-x-contain` so that a gesture that has reached the end
  of a line does not carry on into the panel's feed.
-->
<!--
  A number is an empty span whose digits are drawn by CSS from `data-line`,
  and that is the point of the trick: generated text is not selected and not
  copied, so code taken from the block with the mouse comes without a column
  of numbers in front of every line. `aria-hidden` keeps the column away from
  screen readers, as CodeMirror keeps its gutter.
-->
<div
  class={cn(
    'max-w-full overflow-x-auto overscroll-x-contain whitespace-pre font-mono text-code text-ink',
    className,
  )}
  style:--code-digits={lineNumbers ? digits : null}
>
  {#each lines as line, index (index)}<span class="block min-h-[19px]"
      >{#if lineNumbers}<span class="code-number" aria-hidden="true" data-line={index + 1}></span
        >{/if}<CodeLine tokens={line} /></span
    >{/each}
</div>

<style>
  /*
   * The editor's number column at this block's scale: faint, right-aligned,
   * a step smaller than the code (12 px against 13), 12 px before the code,
   * no line and no ground of its own. The width is counted in the number's
   * own `ch`, so every row's column is as wide as the widest number.
   */
  .code-number {
    display: inline-block;
    box-sizing: border-box;
    width: calc(var(--code-digits) * 1ch + 12px);
    padding-right: 12px;
    text-align: right;
    font-size: 12px;
    color: rgb(var(--faint));
    user-select: none;
  }
  .code-number::before {
    content: attr(data-line);
  }
</style>
