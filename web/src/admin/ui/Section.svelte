<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    description?: string
    children: Snippet
  }

  let { title, description, children }: Props = $props()
</script>

<!-- Two columns, because a setting and the sentence explaining it belong on the
     same line: a caption under a control is read after the damage is done.
     `last:` drops the trailing rule so the page does not end on a hairline. -->
<section class="flex gap-10 border-b border-line-soft py-6 last:border-b-0">
  <div class="w-[210px] shrink-0">
    <h2 class="text-ui font-semibold text-ink">{title}</h2>
    {#if description}
      <p class="mt-1.5 text-2xs text-muted">{description}</p>
    {/if}
  </div>
  <div class="min-w-0 flex-1">
    {@render children()}
  </div>
</section>
