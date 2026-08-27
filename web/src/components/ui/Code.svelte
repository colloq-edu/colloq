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
  import { loadSyntax, plain, syntax, type Token } from '@/lib/syntax.svelte'
  import { cn } from '@/lib/utils'
  import CodeLine from './CodeLine.svelte'

  interface Props {
    code: string
    /** The fence's language, lowercased. Empty counts as Python — see PYTHON. */
    lang?: string
    class?: string
  }

  let { code, lang = '', class: className = '' }: Props = $props()

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
  const lines = $derived.by((): Token[][] =>
    ready ? ready.lines(code) : code.split('\n').map(plain),
  )
</script>

<div class={cn('overflow-x-auto whitespace-pre font-mono text-code text-ink', className)}>
  {#each lines as line, index (index)}<span class="block min-h-[19px]"><CodeLine tokens={line} /></span
    >{/each}
</div>
