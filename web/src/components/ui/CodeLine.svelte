<script lang="ts">
  /**
   * One line of highlighted code.
   *
   * Deliberately renders nothing of its own — no element, no padding, no
   * background — because its two callers frame a line completely differently: a
   * code block puts lines in a column, a diff puts each one in a row with a
   * gutter and a tint. All this owns is the spans.
   *
   * Written on one line in the template because the surrounding element is
   * `white-space: pre`, where Svelte's own indentation would be printed as
   * indentation of the code.
   */
  import type { Token } from '@/lib/syntax.svelte'

  interface Props {
    tokens: Token[]
  }

  let { tokens }: Props = $props()
</script>

{#each tokens as token, index (index)}<span class={token.cls}>{token.text}</span>{/each}
