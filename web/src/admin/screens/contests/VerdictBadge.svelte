<!--
  A submission's verdict as the console's feed and drawer draw it (Paper 19 ·
  A4): the two-letter code in mono, then the test it is about — the failed
  one, or the one a running submission is on.

  The colour families are the shared rule (shared/contests.ts · verdictTone):
  OK green, WA/RE red, TL/ML/OL amber, CE and SE grey, pending framed in the
  live accent. Only "accepted" is filled solid: it is the one a teacher's eye
  looks for down a column of reds.
-->
<script lang="ts">
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import { verdictBadge } from '@/admin/contests'
  import { cn } from '@/lib/utils'
  import type { JudgeState, Verdict } from '@shared/contests'

  interface Props {
    verdict: Verdict | null
    state: JudgeState
    /** The failed test, or the one a running submission is on; null — none to name. */
    test?: number | null
    /** The test number in the verdict's colour (the drawer), or plain ink (the feed). */
    quiet?: boolean
  }

  let { verdict, state, test = null, quiet = true }: Props = $props()

  const look = $derived(verdictBadge(verdict, state))
  const TEST_TONE = {
    positive: 'text-positive',
    danger: 'text-danger',
    warning: 'text-warning',
    neutral: 'text-muted',
    accent: 'text-accent-text',
  } as const
</script>

<span class="inline-flex items-center gap-1.5">
  <Badge word={look.word} tone={look.tone} form={look.form} case="lower" class="font-mono font-bold" />
  {#if test !== null}
    <span class={cn('font-mono text-micro', quiet && look.tone !== 'accent' ? 'text-ink' : TEST_TONE[look.tone])}>{test}</span>
  {/if}
</span>
