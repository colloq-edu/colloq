<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    subtitle?: string
    /**
     * A line ABOVE the title: the section you came here from.
     *
     * A single competition's screen is opened from a link in a chat and
     * returned to a week later — and without this line the title "Rohlik: how
     * many orders there will be tomorrow" does not say which section of the
     * panel you are in or where "back" leads. Optional: the other panel
     * screens do not need it, they are the section.
     */
    eyebrow?: Snippet
    /** Beside the title: state badge, deadline — what is read along with the name. */
    beside?: Snippet
    actions?: Snippet
    children: Snippet
  }

  let { title, subtitle, eyebrow, beside, actions, children }: Props = $props()
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
      {#if eyebrow}
        <div class="mb-1 flex min-w-0 items-center gap-1.5 text-micro text-muted">
          {@render eyebrow()}
        </div>
      {/if}
      <!-- The title and what is read together with it are one line: a "LIVE"
           badge under the name would read as a caption to something else. -->
      <div class="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1">
        <h1 class="min-w-0 max-w-full truncate text-display font-black text-ink">{title}</h1>
        {#if beside}{@render beside()}{/if}
      </div>
      {#if subtitle}
        <p class="mt-1 text-ui text-muted">{subtitle}</p>
      {/if}
    </div>
    <!--
      On a phone the actions row takes the whole line, and that is not
      cosmetic: without a width it "shrinks to content", and `w-full` inside
      it — a full-line search field, a full-line button — resolves against a
      width that this very width defines. The browser computes a percentage of
      an unknown parent as best it can, and the field came out now at 220px,
      now at the screen edge. Above 640 there is no width here at all — the
      old shrink-to-content remains.
    -->
    {#if actions}
      <div class="flex min-w-0 max-w-full flex-wrap items-center gap-2 max-[640px]:w-full">
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
