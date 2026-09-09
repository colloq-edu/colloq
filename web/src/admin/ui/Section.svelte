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
<!--
  The pair wraps rather than squeezing, and it wraps on the width it actually
  has rather than on a breakpoint: the panel's rail is 236px, so a viewport
  number would be measuring the wrong box. A 210px label beside a 40px gutter
  used to leave the oracle's provider form 226px on a 768px window, which is
  where BASE URL and MODEL printed on top of each other. Below 340px of room for
  the control, the explanation goes above it instead of eating it.
-->
<section class="flex flex-wrap gap-x-10 gap-y-4 border-b border-line-soft py-6 last:border-b-0">
  <div class="w-[210px] max-w-full shrink-0">
    <h2 class="text-ui font-semibold text-ink">{title}</h2>
    {#if description}
      <p class="mt-1.5 text-2xs text-muted">{description}</p>
    {/if}
  </div>
  <!-- The basis keeps the two-column layout when it fits. Once wrapped,
       controls can use the actual width available beside the mobile rail. -->
  <div class="min-w-0 grow basis-[340px]">
    {@render children()}
  </div>
</section>
