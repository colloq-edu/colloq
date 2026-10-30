<!--
  The two-letter verdict box (K1, K2, K5): «WA» on a red tint, «OK» solid
  green, «…» outlined in the live accent while the judge works.

  A fixed width, so that a column of them reads as a column: «OK», «WA» and
  «…» are all one box wide whatever the letters. The words beside it are the
  caller's — the problem's list says «· тест 4» after them, the table has a
  column for the test.
-->
<script lang="ts">
  import type { EntrantContestSubmission } from '@shared/contests-entrant'
  import { BADGE_PAINT, submissionTone, verdictCode } from '@/lib/contest-words'

  interface Props {
    submission: Pick<EntrantContestSubmission, 'state' | 'verdict'>
    /** The phone's box is a little narrower (K5). */
    phone?: boolean
  }

  const { submission, phone = false }: Props = $props()

  const tone = $derived(submissionTone(submission))
</script>

<span
  class="inline-flex shrink-0 justify-center py-[3px] font-mono text-[12px] font-bold leading-4 {phone ? 'w-10' : 'w-11'} {BADGE_PAINT[tone]}"
  aria-hidden="true"
>
  {verdictCode(submission)}
</span>
