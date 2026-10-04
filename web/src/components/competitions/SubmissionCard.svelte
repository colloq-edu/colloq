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
  import type { EntrantSubmission } from '@shared/competitions'
  import type { SubmissionLive } from '@shared/competitions-entrant'
  import SubmissionEnvironment from './SubmissionEnvironment.svelte'
  import Badge from './Badge.svelte'
  import {
    blindCellLine,
    blindWhy,
    elapsedClock,
    formatScore,
    rowWords,
    submissionBadge,
    submissionOrdinal,
    runProgress,
    spellDuration,
    splitError,
    type SealedTarget,
  } from '@/lib/competition-words'

  interface Props {
    submission: EntrantSubmission
    live: SubmissionLive | null
    best: boolean
    counted?: boolean
    /** Its place among the person's own submissions (`ownOrdinals`); null — unknown. */
    ordinal?: number | null
    /** Finished without spending the day's limit (`outsideQuota`). */
    offQuota?: boolean
    /** The hidden file a blind run's details talk about (`sealedTarget`); null — none. */
    sealed?: SealedTarget | null
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

  const { submission, live, best, counted = submission.chosen, ordinal = null, offQuota = false, sealed = null, canChoose = true, paused, now, busy, limitMs, notebookUrl, dependenciesSlug, frozen, oncancel, onchoose }: Props =
    $props()

  let open = $state(false)

  const badge = $derived(submissionBadge(submission))
  const words = $derived(rowWords({ submission, live, best, paused, now, phone: true }))
  // Outside the standings, whatever the props say (SubmissionRow says why).
  const late = $derived(!!submission.late)
  const isCounted = $derived(counted && !late)
  /*
   * A blind failure on a phone (C3): the cell and the exception class in one
   * mono line, "output hidden" under it — no first line of a traceback to
   * show, because there is none.
   */
  const blind = $derived(!!submission.blind)
  const cellLine = $derived(blind ? blindCellLine(submission) : '')
  /*
   * The brief words of any other blind outcome are our own and safe to show;
   * a rejected answer's first sentence is already the card's title.
   */
  const blindText = $derived(
    !blind || !submission.participantError || submission.state === 'notebookFailed'
      ? ''
      : submission.state === 'rejected'
        ? splitError(submission.participantError).rest
        : submission.participantError,
  )
  // What the notebook link hands out, in its own words (SubmissionRow says why).
  const notebookWord = $derived(
    submission.notebook === null
      ? null
      : tr(submission.notebook === 'sent' ? 'competitions.p.downloadSent' : 'competitions.p.downloadRun'),
  )
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
  class="flex flex-col gap-1.5 border-b border-line py-3.5 {isCounted
    ? 'bg-[#F2FAF7] dark:bg-positive/10'
    : ''}"
  data-submission={submission.number}
  data-state={submission.state}
  data-late={late ? '' : undefined}
>
  <div class="flex items-center gap-2">
    {#if badge}
      <Badge word={badge.word} tone={badge.tone} form={badge.form} phone />
    {/if}
    <!-- The person's own count first, the competition-wide "#28" small after
         it. The ordinal is the one that gives way when a long timer needs the
         room: the number next to it still names the row. -->
    {#if ordinal !== null}
      <!-- A late card carries its chip in the same line, and "15-я посылка"
           beside it was cut to "15-я посыл…" on a phone: there the bare
           ordinal says the same. -->
      <span class="min-w-0 truncate text-micro font-bold leading-4 text-ink">
        {late ? submissionOrdinal(ordinal) : tr('competitions.p.ownOrdinal', { ordinal: submissionOrdinal(ordinal) })}
      </span>
    {/if}
    <span class="shrink-0 font-mono text-micro leading-4 text-muted">#{submission.number}</span>
    {#if late}
      <!-- Every late card carries it (C3): on a phone the list is read in
           passing, and the caption alone is easy to miss. -->
      <span class="shrink-0 border border-brand-2 px-1 text-[10px] font-black uppercase leading-4 tracking-[0.12em] text-brand-2 dark:border-accent dark:text-accent">
        {tr('competitions.p.lateBadge')}
      </span>
    {/if}
    {#if isCounted}
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

  <span class="truncate text-ui leading-[18px] {submission.replacedBy != null ? 'font-normal text-muted' : 'font-bold text-ink'}" title={submission.fileName}>
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

  {#if blind && failed}
    {#if cellLine}
      <span class="font-mono text-micro leading-[18px] text-ink">{cellLine}</span>
    {/if}
    {#if blindText}
      <span class="text-2xs leading-[18px] text-ink">{blindText}</span>
    {/if}
    <span class="text-2xs leading-[18px] text-muted">{tr('competitions.p.blindShort')}</span>
    {#if open}
      <span class="text-2xs leading-[18px] text-muted">{blindWhy(submission, sealed)}</span>
    {/if}
  {/if}

  {#snippet notSpent()}
    <span class="inline-flex items-center gap-1 font-semibold text-positive">
      <svg width="12" height="12" viewBox="0 0 14 14" class="shrink-0" aria-hidden="true">
        <path d="M2.5 7.2 5.6 10.2 11.5 3.8" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
      {tr('competitions.p.limitNotSpent')}
    </span>
  {/snippet}
  <!-- "Limit not spent" closes the last caption line (C3): the time and the
       mark are one remark about the run, and a phone line is a finger's
       height of scrolling. -->
  {#each words.lines as line, index (index)}
    <span class="text-2xs leading-[18px] text-muted">
      {line}{#if offQuota && index === words.lines.length - 1}{' · '}{@render notSpent()}{/if}
    </span>
  {/each}
  {#if offQuota && words.lines.length === 0}
    <span class="text-2xs leading-[18px]">{@render notSpent()}</span>
  {/if}

  {#if failed && submission.participantError && !blind}
    <span class="font-mono text-micro leading-[18px] text-ink">
      {open ? submission.participantError : submission.participantError.split('\n')[0]}
    </span>
  {/if}
  {#if failed && (submission.participantError || blind)}
    <button
      class="self-start text-2xs leading-[18px] text-accent-text"
      type="button"
      onclick={() => (open = !open)}
    >
      {tr(open ? 'competitions.p.less' : 'competitions.p.phoneMore')}
    </button>
  {/if}

  {#if (open && failed && notebookWord) || (submission.state === 'scored' && submission.notebook === 'executed')}
    <a class="self-start text-2xs text-accent-text underline" href={notebookUrl} download>
      {notebookWord}
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
  {:else if submission.state === 'scored' && canChoose && !isCounted && !frozen && !late}
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
