<script lang="ts">
  import Icon from '@/components/ui/Icon.svelte'

  interface Props {
    /** sm is the lockup as every artboard draws it; md is the step up. */
    size?: 'sm' | 'md'
    tone?: 'onDark' | 'onLight'
    /** Appends the em-dashed institution line. */
    faculty?: boolean
    /** A quiet trailing tag such as "v0.1", pushed to the far edge. */
    version?: string
  }

  let { size = 'sm', tone = 'onDark', faculty = false, version }: Props = $props()

  /*
   * The artboards draw one lockup everywhere it appears — join poster, sign-in
   * poster, workspace masthead, admin sidebar — at a 16px mark against 11px
   * caps. That sameness is the point: the mark is the one thing a person sees
   * on all five screens, so it does not get to change size between them.
   * md exists for a placement where the lockup carries a surface on its own.
   */
  const MARK = { sm: 16, md: 20 } as const
  const WORD = { sm: 'text-2xs', md: 'text-ui' } as const

  const onDark = $derived(tone === 'onDark')
</script>

<div
  class="flex items-center gap-2.5 {version ? 'w-full' : ''} {onDark
    ? 'text-white'
    : 'text-ink'}"
>
  <!-- The nine-cell grid, taken from the icon set rather than redrawn: the
       edge cells are the same colour at 0.42, which is what keeps the mark two
       tones of one ink instead of two colours. -->
  <Icon name="logo" size={MARK[size]} class="shrink-0" />

  <span class="{WORD[size]} shrink-0 font-bold uppercase tracking-wordmark">Colloq</span>

  {#if faculty}
    <!-- The em dash is a rule, not a character: at 0.22em tracking a real dash
         sits too close to the Q and reads as part of the word. -->
    <span
      class="h-px w-3.5 shrink-0 {onDark ? 'bg-brand-2' : 'bg-line'}"
      aria-hidden="true"
    ></span>
    <span
      class="{WORD[size]} min-w-0 truncate uppercase tracking-institution {onDark
        ? 'text-white/60'
        : 'text-muted'}"
    >
      HSE University · Faculty of Computer Science
    </span>
  {/if}

  {#if version}
    <span class="flex-1"></span>
    <span class="shrink-0 font-mono text-micro {onDark ? 'text-white/50' : 'text-faint'}">
      {version}
    </span>
  {/if}
</div>
