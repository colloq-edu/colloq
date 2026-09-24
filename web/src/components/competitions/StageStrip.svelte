<script lang="ts">
  /**
   * The strip of stages under a running submission: ACCEPTED · QUEUE ·
   * RUNNING NOTEBOOK · CHECKING CSV · SCORING.
   *
   * It answers the only question of a person watching the timer: "is it
   * moving at all or is it stuck". The colour of a passed stage is green, of
   * the current one link blue, of future ones pale; three colours are
   * enough, because a stage has no fourth state.
   *
   * Desktop only. On a phone its place is taken by one sentence ("Running
   * cell 9 of 14"): five captions in 390 px fold into two rows and stop
   * reading as one line.
   */
  import type { SubmissionStage, SubmissionState } from '@shared/competitions'
  import { stageStrip } from '@/lib/competition-words'

  interface Props {
    state: SubmissionState
    stage: SubmissionStage
  }

  const { state, stage }: Props = $props()
  const cells = $derived(stageStrip(state, stage))
</script>

<div class="flex flex-wrap items-center gap-2">
  {#each cells as cell, index (cell.stage)}
    {#if index > 0}
      <span class="h-px w-5 shrink-0 bg-line" aria-hidden="true"></span>
    {/if}
    <span
      class="text-micro font-black uppercase leading-5 tracking-label {cell.position ===
      'done'
        ? 'text-positive'
        : cell.position === 'current'
          ? 'text-accent-text'
          : 'text-faint'}"
    >
      {cell.word}
    </span>
  {/each}
</div>
