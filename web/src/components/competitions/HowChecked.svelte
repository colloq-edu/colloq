<script lang="ts">
  /**
   * "How a submission is checked" — three steps under the data on the task
   * tab, drawn only when the competition has a hidden test (C3).
   *
   * The hidden test changes what a participant should expect from the check
   * more than any limit does: the notebook reads other rows than the ones it
   * was written against, and a failure comes back as a cell number and an
   * exception class. Said once, before the first submission, with an example
   * of exactly what a failure will look like, it is a rule; found out from a
   * row with no traceback, it reads as a broken page.
   */
  import { tr } from '@shared/i18n'
  import type { BadgeForm, BadgeTone, CompetitionPublic } from '@shared/competitions'
  import Badge from './Badge.svelte'
  import { blindCellLine, rowsWords, type SealedTarget } from '@/lib/competition-words'

  interface Props {
    competition: Pick<CompetitionPublic, 'limits' | 'outputPolicy'>
    target: SealedTarget
  }

  const { competition, target }: Props = $props()

  const brief = $derived((competition.outputPolicy ?? 'brief') !== 'full')
  const minutes = $derived(Math.max(1, Math.round(competition.limits.wallSeconds / 60)))
  const memory = $derived(
    tr('competitions.p.gigabytes', { count: Math.round((competition.limits.memoryMb / 1024) * 10) / 10 }),
  )
  const steps = $derived([
    tr('competitions.p.howRun', { count: minutes, memory }),
    target.replaces
      ? target.rows === null
        ? tr('competitions.p.howSwapBare', { file: target.file })
        : tr('competitions.p.howSwap', { file: target.file, rows: rowsWords(target.rows) })
      : tr('competitions.p.howAdd', { file: target.file }),
    [
      tr(brief ? 'competitions.p.howBrief' : 'competitions.p.howFull'),
      competition.limits.perDay > 0 ? tr('competitions.p.howFree') : '',
    ]
      .filter(Boolean)
      .join(' '),
  ])
  /*
   * The example under the third step is an illustration, not a row: a cell
   * and an exception class anyone has met, in the same words and badge a
   * real blind failure gets.
   */
  const EXAMPLE = { cell: 7, cells: 14 }
  const example = $derived(
    blindCellLine({ state: 'notebookFailed', cellsDone: EXAMPLE.cell, cellsTotal: EXAMPLE.cells, errorType: 'KeyError' }),
  )
  const badge: { tone: BadgeTone; form: BadgeForm } = { tone: 'danger', form: 'filled' }
</script>

<section class="flex max-w-[760px] flex-col gap-[18px] border-l-[3px] border-brand-2 py-1 pl-4 sm:pl-6 dark:border-accent">
  <h2 class="text-[20px] font-bold leading-[26px] text-ink">{tr('competitions.p.howTitle')}</h2>
  <ol class="flex flex-col gap-3.5">
    {#each steps as step, index (index)}
      <li class="flex items-start gap-3">
        <span class="w-6 shrink-0 font-mono text-ui font-bold text-brand-2 dark:text-accent">{index + 1}</span>
        <div class="flex min-w-0 grow flex-col gap-3">
          <p class="text-ui text-ink">{step}</p>
          {#if index === 2 && brief}
            <div class="flex flex-col gap-2 border border-line bg-canvas px-4 py-3.5">
              <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                <Badge word={tr('competitions.entrant.notebookFailed')} tone={badge.tone} form={badge.form} />
                <span class="font-mono text-micro text-ink">{example}</span>
                {#if competition.limits.perDay > 0}
                  <span class="ml-auto flex items-center gap-1.5 text-micro font-semibold text-positive">
                    <svg width="14" height="14" viewBox="0 0 14 14" class="shrink-0" aria-hidden="true">
                      <path d="M2.5 7.2 5.6 10.2 11.5 3.8" fill="none" stroke="currentColor" stroke-width="1.6" />
                    </svg>
                    {tr('competitions.p.limitNotSpent')}
                  </span>
                {/if}
              </div>
              <p class="text-micro text-muted">
                {tr('competitions.p.blindShort')}
                {#if target.replaces}{tr('competitions.p.howExampleCheck', { cell: EXAMPLE.cell, file: target.file })}{/if}
              </p>
            </div>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
</section>
