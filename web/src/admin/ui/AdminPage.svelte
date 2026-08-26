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
<!-- min-w-0: without it this column sizes to its content, and the table inside
     pushed the whole page sideways instead of scrolling in its own box. -->
<div class="flex min-h-0 min-w-0 flex-1 flex-col">
  <!-- 64px with no subtitle (1EX-0), 94px with one (2YU-0): the topbar is a
       lane for the title, and a lede is the only thing that makes it a block. -->
  <!--
    The title is the last thing that gives. It used to be the first: the actions
    beside it were shrink-0 and the heading was the only flexible thing in the
    row, so at 768 the Seminars page was headed "Semin…" while a search box it
    could have done without kept every pixel. Wrapping instead of shrinking is
    the honest answer — below `basis` the actions drop to their own line and the
    heading gets the width back.
  -->
  <header
    class="flex shrink-0 flex-wrap gap-x-4 gap-y-2 border-b border-line px-7
           {subtitle ? 'items-start py-5' : 'min-h-16 items-center py-3'}"
  >
    <div class="min-w-0 flex-1 basis-48">
      <h1 class="truncate text-display font-black text-ink">{title}</h1>
      {#if subtitle}
        <p class="mt-1 text-ui text-muted">{subtitle}</p>
      {/if}
    </div>
    {#if actions}
      <div class="flex min-w-0 max-w-full flex-wrap items-center gap-2">
        {@render actions()}
      </div>
    {/if}
  </header>

  <!-- min-w-0 here too: this is the box a wide table sits in, and without it
       the table's own minimum becomes the page's. -->
  <!-- overflow-auto, not overflow-y-auto: both axes named out loud. A box that
       scrolls in one axis only is the reason a form narrower than its content
       was unreachable rather than scrollable — the shell's <main> clips, so if
       this box does not scroll sideways, nothing does. -->
  <div class="min-h-0 min-w-0 flex-1 overflow-auto px-7 pb-10">
    {@render children()}
  </div>
</div>
