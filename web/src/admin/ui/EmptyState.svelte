<!--
  What a list says when it has nothing to show — no competitions yet, no
  match for the search, nobody on the leaderboard.

  One component because every tab had its own: a 17 px title here, a muted
  14 px sentence there, the button a different distance below it. An empty
  list is the first screen of every new instance, so it is the one people
  see the panel by before anything else is in it.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    /** What to do about it, in one or two sentences. */
    hint?: string
    /** The way out: usually one primary button. */
    children?: Snippet
  }

  let { title, hint, children }: Props = $props()
</script>

<div class="py-16 text-center">
  <p class="text-title font-semibold text-ink">{title}</p>
  {#if hint}
    <p class="mx-auto mt-2 max-w-md text-ui text-muted">{hint}</p>
  {/if}
  {#if children}
    <div class="mt-4 flex flex-wrap justify-center gap-2">{@render children()}</div>
  {/if}
</div>
