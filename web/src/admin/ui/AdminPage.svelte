<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    subtitle?: string
    actions?: Snippet
    children: Snippet
  }

  let { title, subtitle, actions, children }: Props = $props()
</script>

<!-- The header is fixed and the body scrolls under it: a settings page can run
     long, and losing the title you are editing under is disorienting. -->
<div class="flex min-h-0 flex-1 flex-col">
  <!-- 64px with no subtitle (1EX-0), 94px with one (2YU-0): the topbar is a
       lane for the title, and a lede is the only thing that makes it a block. -->
  <header
    class="flex shrink-0 gap-4 border-b border-line px-7
           {subtitle ? 'items-start py-5' : 'h-16 items-center'}"
  >
    <div class="min-w-0 flex-1">
      <h1 class="truncate text-display font-black text-ink">{title}</h1>
      {#if subtitle}
        <p class="mt-1 text-ui text-muted">{subtitle}</p>
      {/if}
    </div>
    {#if actions}
      <div class="flex shrink-0 items-center gap-2">
        {@render actions()}
      </div>
    {/if}
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto px-7 pb-10">
    {@render children()}
  </div>
</div>
