<script lang="ts">
  /**
   * The same submission on a phone (P4) — and it is a different layout, not
   * the same one made narrower.
   *
   * Five columns do not fit in 390 px, so the row unfolds into a card: on top
   * the "badge · number · timer" row, under it the file name, under that one
   * sentence of state. There are no actions on the right at all — the timer
   * has taken their place, and that is the mockup's decision: a finger misses
   * a 13 px link in a cramped row.
   *
   * There is no strip of stages here: five capitalised captions do not fit
   * in such a width. Instead there is "Running cell 9 of 14" and a progress
   * bar.
   */
  import { tr } from '@shared/i18n'
  import { entrantBadge, type EntrantSubmission } from '@shared/competitions'
  import type { SubmissionLive } from '@shared/competitions-entrant'
  import SubmissionEnvironment from './SubmissionEnvironment.svelte'
  import Badge from './Badge.svelte'
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
  const words = $derived(rowWords({ submission, live, best, paused, now, phone: true }))
  const running = $derived(submission.state === 'running')
  const queued = $derived(submission.state === 'queued')
  const failed = $derived(
    submission.state !== 'scored' && submission.state !== 'running' && submission.state !== 'queued',
  )
  const timer = $derived.by(() => {
    if (running && live?.startedAt) {
      return tr('competitions.p.ofLimit', {
        elapsed: elapsedClock(now - live.startedAt),
        limit: elapsedClock(live.limitMs || limitMs),
      })
    }
    if (queued && !live?.resourcePending && live?.etaMs != null) {
      return tr('competitions.p.eta', { duration: spellDuration(live.etaMs) })
    }
    return ''
  })
</script>

<div
  class="flex flex-col gap-1.5 border-b border-line py-3.5 {counted
    ? 'bg-[#F2FAF7] dark:bg-positive/10'
    : ''}"
  data-submission={submission.number}
  data-state={submission.state}
>
  <div class="flex items-center gap-2">
    {#if badge}
      <Badge word={badge.word} tone={badge.tone} form={badge.form} phone />
    {/if}
    <span class="font-mono text-micro leading-4 text-muted">#{submission.number}</span>
    {#if counted}
      <span class="bg-positive px-1.5 py-0.5 text-micro font-bold leading-5 text-white dark:text-canvas">
        {tr('competitions.counted')}
      </span>
    {/if}
    <span class="grow"></span>
    {#if timer}
      <span class="shrink-0 font-mono text-micro leading-4 text-ink">{timer}</span>
    {:else if submission.state === 'scored'}
      <span class="shrink-0 font-mono text-[20px] font-bold leading-6 text-ink">
        {formatScore(submission.publicScore)}
      </span>
    {/if}
  </div>

  <span class="truncate text-ui font-bold leading-[18px] text-ink" title={submission.fileName}>
    {words.title}
  </span>

  {#if running}
    <div class="h-1 w-full bg-raised">
      <div
        class="h-1 bg-accent transition-[width] duration-500"
        style="width: {live ? runProgress(live) : 5}%"
      ></div>
    </div>
  {/if}

  <SubmissionEnvironment execution={submission.execution} slug={dependenciesSlug} />
      {#each words.lines as line, index (index)}
    <span class="text-2xs leading-[18px] text-muted">{line}</span>
  {/each}

  {#if failed && submission.participantError}
    <span class="font-mono text-micro leading-[18px] text-ink">
      {open ? submission.participantError : submission.participantError.split('\n')[0]}
    </span>
    <button
      class="self-start text-2xs leading-[18px] text-accent-text"
      type="button"
      onclick={() => (open = !open)}
    >
      {tr(open ? 'competitions.p.less' : 'competitions.p.phoneMore')}
    </button>
  {/if}

  {#if open && failed}
    <a class="self-start text-2xs text-accent-text underline" href={notebookUrl} download>
      {tr('competitions.p.downloadRun')}
    </a>
  {/if}

  <!-- The only action left at the bottom of the card on a phone: withdraw
       your submission and choose the counted one — which is what a person
       opened this for on a phone, standing in the corridor. -->
  {#if running || queued}
    <button
      class="self-start text-2xs text-danger disabled:text-faint"
      type="button"
      disabled={busy}
      onclick={() => oncancel(submission.id)}
    >
      {tr('competitions.p.cancelRun')}
    </button>
  {:else if submission.state === 'scored' && canChoose && !counted && !frozen}
    <button
      class="self-start text-2xs text-accent-text disabled:text-faint"
      type="button"
      disabled={busy}
      onclick={() => onchoose(submission.id)}
    >
      {tr('competitions.p.chooseIt')}
    </button>
  {/if}
</div>
