<script lang="ts">
  /**
   * One row of "My submissions" on a desktop (P2).
   *
   * Five columns of the same width in every row: number, badge, description,
   * number or timer, action. The columns are fixed on purpose — the eye
   * checks thirteen rows top to bottom by them, and a "DONE" shifted twenty
   * pixels by a long file name breaks that reading completely.
   *
   * An error unfolds RIGHT HERE, not on a separate page: a traceback is two
   * lines, and for their sake a person should not lose sight of the list.
   */
  import { tr } from '@shared/i18n'
  import { entrantBadge, isTerminal, type EntrantSubmission } from '@shared/competitions'
  import type { SubmissionLive } from '@shared/competitions-entrant'
  import SubmissionEnvironment from './SubmissionEnvironment.svelte'
  import Badge from './Badge.svelte'
  import StageStrip from './StageStrip.svelte'
  import {
    elapsedClock,
    formatScore,
    rowWords,
    runProgress,
    spellDuration,
  } from '@/lib/competition-words'

  interface Props {
    submission: EntrantSubmission
    live: SubmissionLive | null
    best: boolean
    counted?: boolean
    canChoose?: boolean
    paused: boolean
    now: number
    busy: boolean
    /** The competition's run ceiling — the right half of "01:12 of 10:00". */
    limitMs: number
    dependenciesSlug?: string
    notebookUrl: string
    /** Submissions are closed: the counted submission can no longer be changed. */
    frozen: boolean
    oncancel: (id: string) => void
    onchoose: (id: string) => void
  }

  const { submission, live, best, counted = submission.chosen, canChoose = true, paused, now, busy, limitMs, notebookUrl, dependenciesSlug, frozen, oncancel, onchoose }: Props =
    $props()

  let open = $state(false)

  const badge = $derived(entrantBadge(submission.state))
  const words = $derived(rowWords({ submission, live, best, paused, now }))
  const running = $derived(submission.state === 'running')
  const queued = $derived(submission.state === 'queued')
  const failed = $derived(
    submission.state === 'notebookFailed' ||
      submission.state === 'rejected' ||
      submission.state === 'timedOut' ||
      submission.state === 'outOfMemory',
  )
  /** What goes in the number column: the score, a stopwatch, a wait estimate, a dash. */
  const rightSide = $derived.by(() => {
    if (submission.state === 'scored') return { kind: 'score' as const }
    if (running && live?.startedAt) {
      return {
        kind: 'clock' as const,
        text: tr('competitions.p.ofLimit', {
          elapsed: elapsedClock(now - live.startedAt),
          limit: elapsedClock(live.limitMs || limitMs),
        }),
        tone: 'text-ink',
      }
    }
    if (queued) {
      return {
        kind: 'clock' as const,
        text: live?.resourcePending || live?.etaMs === null || live?.etaMs === undefined
          ? '—'
          : tr('competitions.p.eta', { duration: spellDuration(live.etaMs) }),
        tone: 'text-ink',
      }
    }
    // Time that ran out is drawn as the ceiling on both sides: "10:00 of
    // 10:00" is exactly what happened, while the run's duration here is a
    // fraction shorter.
    if (submission.state === 'timedOut') {
      return {
        kind: 'clock' as const,
        text: tr('competitions.p.ofLimit', {
          elapsed: elapsedClock(limitMs),
          limit: elapsedClock(limitMs),
        }),
        tone: 'text-danger',
      }
    }
    return { kind: 'dash' as const }
  })
</script>

<div
  class="flex flex-col gap-3 border-b border-line py-4 {counted
    ? 'bg-[#F2FAF7] dark:bg-positive/10'
    : ''}"
  data-submission={submission.number}
  data-state={submission.state}
>
  <div class="flex items-start gap-0">
    <span class="w-12 shrink-0 font-mono text-2xs leading-4 text-muted">#{submission.number}</span>
    <span class="flex w-[184px] shrink-0">
      {#if badge}
        <Badge word={badge.word} tone={badge.tone} form={badge.form} />
      {/if}
    </span>
    <div class="flex min-w-0 grow flex-col gap-[3px]">
      <span class="truncate text-ui font-bold leading-[18px] text-ink" title={submission.fileName}>
        {words.title}
      </span>
      <SubmissionEnvironment execution={submission.execution} slug={dependenciesSlug} />
      {#each words.lines as line, index (index)}
        <span class="text-micro leading-[18px] text-muted">{line}</span>
      {/each}
    </div>
    <span class="flex w-[130px] shrink-0 flex-col items-end gap-0.5 text-right xl:w-[150px]">
      {#if rightSide.kind === 'score'}
        <span class="font-mono text-title font-bold leading-[22px] text-ink">
          {formatScore(submission.publicScore)}
        </span>
        {#if best}
          <span class="text-micro leading-4 text-muted">{tr('competitions.p.publicPart')}</span>
        {/if}
      {:else if rightSide.kind === 'clock'}
        <span class="font-mono text-2xs leading-4 {rightSide.tone}">{rightSide.text}</span>
      {:else}
        <span class="font-mono text-2xs leading-4 text-faint">—</span>
      {/if}
    </span>
    <span class="flex w-[104px] shrink-0 justify-end text-right xl:w-[120px]">
      {#if running || queued}
        <button
          class="text-2xs leading-4 text-danger hover:underline disabled:text-faint"
          type="button"
          disabled={busy}
          onclick={() => oncancel(submission.id)}
        >
          {tr('competitions.p.cancelRun')}
        </button>
      {:else if counted}
        <span class="flex items-center gap-1.5 bg-positive px-[9px] py-1 text-white dark:text-canvas">
          <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true">
            <path d="M1 4l2.75 2.75L9 1.25" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <span class="text-micro font-bold leading-4">{tr('competitions.counted')}</span>
        </span>
      {:else if submission.state === 'scored' && canChoose && !frozen}
        <button
          class="text-2xs leading-4 text-accent-text hover:underline disabled:text-faint"
          type="button"
          disabled={busy}
          onclick={() => onchoose(submission.id)}
        >
          {tr('competitions.p.chooseIt')}
        </button>
      {:else if failed || submission.state === 'metricFailed'}
        <button
          class="text-2xs leading-4 text-accent-text hover:underline"
          type="button"
          onclick={() => (open = !open)}
        >
          {tr(open ? 'competitions.p.less' : 'competitions.p.more')}
        </button>
      {/if}
    </span>
  </div>

  {#if running}
    <div class="flex flex-col gap-3 pl-12">
      <div class="h-1 w-full bg-raised">
        <div
          class="h-1 bg-accent transition-[width] duration-500"
          style="width: {live ? runProgress(live) : 5}%"
        ></div>
      </div>
      <StageStrip state={submission.state} stage={live?.stage ?? submission.stage} />
    </div>
  {/if}

  {#if open && (failed || submission.state === 'metricFailed')}
    <!-- The block has its own pale red highlight: it lies INSIDE the row, and
         an ordinary border would read as one more submission. -->
    <div class="ml-12 flex flex-col border border-[#F3C6CC] bg-[#FEF6F7] dark:border-danger/40 dark:bg-danger/10">
      {#if submission.participantError}
        <pre class="overflow-x-auto whitespace-pre-wrap px-3.5 py-2.5 font-mono text-micro leading-[19px] text-ink">{submission.participantError}</pre>
      {/if}
      <div class="flex flex-wrap items-center gap-3 border-t border-[#F3C6CC] px-3.5 py-3 dark:border-danger/40">
        {#if isTerminal(submission.state)}
          <a
            class="border-b border-dashed border-accent-text text-micro text-accent-text"
            href={notebookUrl}
            download
          >
            {tr('competitions.p.downloadRun')}
          </a>
        {/if}
      </div>
    </div>
  {/if}
</div>
