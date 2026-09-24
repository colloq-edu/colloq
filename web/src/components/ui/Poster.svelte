<script lang="ts">
  import type { Snippet } from 'svelte'
  import Wordmark from '@/components/ui/Wordmark.svelte'
  import Skeleton from './Skeleton.svelte'
  import { tr } from '@shared/i18n'

  interface Props {
    /** Small caps-tracked line above the masthead, e.g. "YOU'RE JOINING". */
    eyebrow?: string
    title: string
    loading?: boolean
    /** The line under the masthead — date · time | host. */
    meta?: Snippet
    children?: Snippet
    /** Pinned to the bottom: the avatar stack, or the note about students. */
    footer?: Snippet
    /** Tailwind width class — join runs wider than sign-in. */
    width?: string
    /**
     * The instance's organisation, next to the logo. Empty means there is none.
     *
     * Deliberately not read here from anything global: on the seminar join
     * poster the line arrives together with the room card, and the panel
     * sign-in poster has no room card at all — nor should it.
     */
    institution?: string
    /**
     * Which step the headline is set at. `masthead` is the join poster, where
     * the seminar name is the whole screen; `banner` is sign-in, where the
     * title shares its column with a lede and a footnote.
     */
    headline?: 'masthead' | 'banner'
  }

  let {
    eyebrow,
    title,
    loading = false,
    meta,
    children,
    footer,
    width = 'w-1/2',
    headline = 'masthead',
    institution = '',
  }: Props = $props()
</script>

<!--
  A poster, not a themed surface. The ground is the brand navy in both themes
  and everything on it is white or a translucent white, because this half of the
  screen is the same printed object whichever theme the person arrived in — a
  poster that inverted with the OS would be a different poster.

  The two flex spacers hold the headline on the optical centre whether or not
  there is a footer, and collapse first when a long seminar name needs the room.
-->
<aside class="flex shrink-0 flex-col bg-brand px-14 py-11 {width}">
  <Wordmark {institution} tone="onDark" />

  <div class="min-h-0 flex-1"></div>

  <div class="flex flex-col gap-3.5">
    {#if eyebrow}
      <p class="text-2xs font-bold uppercase tracking-wordmark text-white/60">{eyebrow}</p>
    {/if}

    <!-- Black, not bold: the artboards are drawn in HSE Sans Black and Inter at
         700 reads thin at this size. break-words keeps an unbroken 60-character
         seminar name inside the column instead of over the edge of it. -->
    <h1
      class="text-balance break-words font-black text-white
             {headline === 'banner' ? 'text-banner' : 'text-masthead'}"
    >
      {#if loading}
        <span role="status" aria-label={tr('common.loading')} aria-busy="true" class="flex flex-col gap-4 py-2">
          <Skeleton width="88%" height="0.78em" tone="onDark" />
          <Skeleton width="60%" height="0.78em" tone="onDark" />
        </span>
      {:else}
        {title}
      {/if}
    </h1>

    {#if meta}
      <div class="flex flex-wrap items-center gap-3.5 pt-1.5 text-ui-lg text-white/70">
        {@render meta()}
      </div>
    {/if}

    {#if children}
      <div class="pt-2 text-ui-lg text-white/70">
        {@render children()}
      </div>
    {/if}
  </div>

  <div class="min-h-0 flex-1"></div>

  {#if footer}
    <div class="text-ui-lg text-white/75">
      {@render footer()}
    </div>
  {/if}
</aside>
