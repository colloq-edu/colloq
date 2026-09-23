<script lang="ts">
  /**
   * Та же посылка на телефоне (P4) — и это другая раскладка, а не та же, но уже.
   *
   * Пять колонок в 390 px не помещаются, поэтому строка разворачивается в
   * карточку: сверху ряд «плашка · номер · таймер», под ним имя файла, под ним
   * одна фраза состояния. Действий справа нет вовсе — их место занял таймер,
   * и это решение макета: палец промахивается по ссылке 13 px в тесном ряду.
   *
   * Полосы этапов здесь нет: пять подписей капсом в такую ширину не ложатся.
   * Вместо неё — «Выполняется ячейка 9 из 14» и полоска прогресса.
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
    /** Приём закрыт: зачётную посылку больше не переставить. */
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

  <!-- Единственное действие, которое на телефоне осталось внизу карточки:
       снять свою посылку и выбрать зачётную — то, ради чего человек сюда и
       зашёл с телефона, стоя в коридоре. -->
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
