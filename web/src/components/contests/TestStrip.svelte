<!--
  The strip of tests under a submission (K2): one square per test — passed
  green, failed red, skipped as an outline, the one running now in the live
  accent — and, once judged, a note that says why the tail is empty («дальше
  проверка остановилась»).

  The squares are drawn from the submission's own list (`strip`, `progress`,
  `total`), which the stream keeps current, so a running row grows its green
  without the details being opened. What each square means is
  lib/contest-words.ts · stripCells.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { EntrantContestSubmission } from '@shared/contests-entrant'
  import { stripCells, stripNote, type StripCell } from '@/lib/contest-words'

  interface Props {
    submission: Pick<EntrantContestSubmission, 'state' | 'progress' | 'total' | 'strip' | 'passed' | 'verdict'>
    /** The note beside a finished strip. */
    note?: boolean
  }

  const { submission, note = true }: Props = $props()

  const cells = $derived(stripCells(submission))
  const words = $derived(note ? stripNote(submission) : '')

  const PAINT: Record<StripCell, string> = {
    ok: 'bg-positive',
    fail: 'bg-danger',
    skip: 'border border-line',
    current: 'bg-accent',
    todo: 'border border-line',
    done: 'bg-positive/50',
  }
  const NAME: Record<StripCell, string> = {
    ok: 'OK',
    fail: '×',
    skip: '–',
    current: '…',
    todo: '·',
    done: '✓',
  }
</script>

{#if cells.length > 0}
  <div class="flex flex-wrap items-center gap-[3px]">
    <!-- Read as one sentence, not as twenty-two squares. -->
    <span class="sr-only">{words || tr('contests.p.testsCount', { count: cells.length })}</span>
    {#each cells as cell, index (index)}
      <span class="size-3.5 shrink-0 {PAINT[cell]}" title="{index + 1} · {NAME[cell]}" aria-hidden="true"></span>
    {/each}
    {#if words}
      <span class="pl-3 text-2xs leading-4 text-muted" aria-hidden="true">{words}</span>
    {/if}
  </div>
{/if}
