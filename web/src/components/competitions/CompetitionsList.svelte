<script lang="ts">
  /**
   * P1 — choosing a competition (Paper 07 · D1, D4).
   *
   * Two sections under a shared header: live ones large, with a button and
   * your own place, and finished ones below. The difference in size is the
   * screen's hierarchy: a live competition needs action today, a finished one
   * is mostly a reason to look at how it ended.
   *
   * The sections go by the PHASE, not the stored state (competitionPhase): a
   * competition past its deadline is finished here even while nobody pressed
   * «Завершить», as it is on its own page. One that still takes late
   * submissions stays a card — it can still be solved — with the late mark
   * over its title, so the list says what the page says.
   *
   * «Участвовать» on a card leads to the competition's own join step, the
   * first step of its «Посылки» tab (JoinStep): the name used to be asked for
   * in a form unfolding under the card, and the same form was where every
   * «Участвовать» on a competition's pages sent the visitor — to the top of
   * this list, with the form below the fold.
   */
  import { tr } from '@shared/i18n'
  import { competitionPhase, submissionsOpen } from '@shared/competitions'
  import type { EntrantCompetitionRow } from '@shared/competitions-entrant'
  import {
    dateOf,
    deadlineNote,
    deadlineUrgent,
    formatScore,
    metricArrow,
    placeWithScore,
    remainingWords,
    whenWords,
  } from '@/lib/competition-words'

  interface Props {
    rows: EntrantCompetitionRow[]
    now: number
    onopen: (slug: string) => void
    /** «Участвовать»: to the competition's join step. */
    onjoin: (slug: string) => void
  }

  const { rows, now, onopen, onjoin }: Props = $props()

  /** On-time intake first, then those still waiting for their start. */
  const running = $derived(
    rows
      .filter((row) => competitionPhase(row.competition, now) !== 'over')
      .sort((a, b) => Number(soonOf(a)) - Number(soonOf(b))),
  )
  /** Late intake first: those can still be solved, the rest only looked at. */
  const finished = $derived(
    rows
      .filter((row) => competitionPhase(row.competition, now) === 'over')
      .sort((a, b) => Number(lateOpen(b)) - Number(lateOpen(a))),
  )
  const anyLate = $derived(finished.some((row) => lateOpen(row)))

  function soonOf(row: EntrantCompetitionRow): boolean {
    return competitionPhase(row.competition, now) === 'soon'
  }

  function lateOpen(row: EntrantCompetitionRow): boolean {
    return submissionsOpen(row.competition, now) === 'late'
  }

  /** "ROC AUC ↑ · 24 участника · итоги опубликованы · лучший в зачёте 0.8102". */
  function overMeta(row: EntrantCompetitionRow): string {
    return [
      metricArrow(row.competition.metric.name, row.competition.metric.direction),
      tr('competitions.p.entrants', { count: row.entrants }),
      row.privateOpen ? tr('competitions.p.resultsOpen') : tr('competitions.p.resultsClosed'),
      row.bestFinal === null || row.bestFinal === undefined
        ? ''
        : tr('competitions.p.bestCounted', { score: formatScore(row.bestFinal) }),
    ]
      .filter(Boolean)
      .join(' · ')
  }

  /** The person's standing: the final place once the results are open, the public one before. */
  function standing(row: EntrantCompetitionRow): string {
    const mine = row.mine
    if (!mine) return '—'
    if (mine.finalPlace !== undefined && mine.finalPlace !== null) {
      return placeWithScore(mine.finalPlace, mine.finalScore ?? null)
    }
    return mine.place === null ? '—' : placeWithScore(mine.place, mine.score)
  }
</script>

{#snippet sectionHead(label: string, count: number)}
  <h2 class="flex items-baseline gap-2.5 border-b-2 border-ink pb-2.5 text-micro font-black uppercase leading-5 tracking-section text-ink">
    {label}
    <span class="font-mono text-2xs font-normal tracking-normal text-muted">{count}</span>
  </h2>
{/snippet}

{#snippet youLane(row: EntrantCompetitionRow, over: boolean)}
  {@const mine = row.mine}
  {@const final = over && mine?.finalPlace !== undefined && mine?.finalPlace !== null}
  <div class="flex min-w-[140px] flex-1 basis-[150px] flex-col gap-0.5">
    <span class="text-micro font-black uppercase leading-5 tracking-label text-muted">
      {tr(final ? 'competitions.p.countedScore' : 'competitions.p.you')}
    </span>
    {#if mine?.joined}
      <span class="font-mono text-title font-bold text-ink">{standing(row)}</span>
      <span class="text-micro text-muted">
        {[
          tr('competitions.p.submissionsCount', { count: mine.submissions }),
          mine.inFlight > 0 ? tr('competitions.p.inFlight', { count: mine.inFlight }) : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    {:else}
      <span class="text-ui leading-6 text-muted">
        {tr(over ? 'competitions.p.notJoinedOver' : 'competitions.p.notJoined')}
      </span>
      {#if over}
        <span class="text-micro text-muted">{tr('competitions.p.lateJoinHint')}</span>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet action(row: EntrantCompetitionRow)}
  <div class="flex w-full shrink-0 items-center self-center sm:ml-auto sm:w-auto">
    {#if row.mine?.joined}
      <button
        class="min-h-11 w-full whitespace-nowrap border border-primary px-5 py-2 text-micro font-bold uppercase tracking-caps text-primary hover:bg-surface"
        type="button"
        onclick={() => onopen(row.competition.slug)}
      >
        {tr('competitions.p.openCompetition')}
      </button>
    {:else}
      <button
        class="min-h-11 w-full whitespace-nowrap bg-brand px-5 py-2 text-micro font-bold uppercase tracking-caps text-white hover:bg-brand-2"
        type="button"
        onclick={() => onjoin(row.competition.slug)}
      >
        {tr('competitions.p.join')}
      </button>
    {/if}
  </div>
{/snippet}
<div class="flex flex-col gap-9">
  <div class="flex flex-col gap-3">
    <h1 class="break-words text-[36px] font-black leading-[40px] tracking-[-0.03em] text-ink sm:text-[48px] sm:leading-[52px]">
      {tr('competitions.title')}
    </h1>
    <p class="max-w-[680px] whitespace-pre-line text-[16px] leading-6 text-muted">
      {tr('competitions.p.lead')}
    </p>
  </div>

  {#if rows.length === 0}
    <p class="border-y border-line bg-surface px-5 py-6 text-ui text-ink">{tr('competitions.p.emptyAll')}</p>
  {/if}

  {#if rows.length > 0}
    <section class="flex flex-col">
      {@render sectionHead(tr('competitions.p.sectionRunning'), running.length)}
      {#if running.length === 0}
        <p class="border-b border-line py-6 text-ui text-muted">
          {tr(anyLate ? 'competitions.p.emptyRunningLate' : 'competitions.p.emptyRunning')}
        </p>
      {/if}
      {#each running as row (row.competition.id)}
        {@const soon = competitionPhase(row.competition, now) === 'soon'}
        {@const urgent = !soon && deadlineUrgent(row.competition.deadlineAt, now)}
        <article class="flex flex-col gap-5 border-b border-line py-6">
          <div class="flex min-w-0 grow flex-col gap-2">
            <h3 class="text-display font-black text-ink">
              <a class="break-words hover:text-accent-text hover:underline underline-offset-4" href={`/k/${encodeURIComponent(row.competition.slug)}`}>{row.competition.title}</a>
            </h3>
            {#if row.competition.blurb}
              <p class="text-ui text-muted">{row.competition.blurb}</p>
            {/if}
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5 text-micro text-muted">
              <span class="font-mono">
                {metricArrow(row.competition.metric.name, row.competition.metric.direction)}
              </span>
              <span>{tr('competitions.p.entrants', { count: row.entrants })}</span>
              {#if row.bestPublic !== null || row.baselinePublic !== null}
                <span>
                  {[
                    row.bestPublic === null
                      ? ''
                      : tr('competitions.p.leader', { score: formatScore(row.bestPublic) }),
                    row.baselinePublic === null
                      ? ''
                      : tr('competitions.p.baseline', { score: formatScore(row.baselinePublic) }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              {/if}
            </div>
          </div>

          <div class="flex flex-wrap items-start gap-x-8 gap-y-4">
            <div class="flex min-w-[140px] flex-1 basis-[150px] flex-col gap-0.5">
              <span
                class="text-micro font-black uppercase leading-5 tracking-label {urgent
                  ? 'text-warning'
                  : 'text-muted'}"
              >
                {tr(soon ? 'competitions.p.startsIn' : 'competitions.p.left')}
              </span>
              <span
                class="font-mono text-title font-bold {urgent ? 'text-warning' : 'text-ink'}"
              >
                {soon
                  ? remainingWords(row.competition.startsAt! - now)
                  : row.competition.deadlineAt === null
                    ? '—'
                    : remainingWords(row.competition.deadlineAt - now)}
              </span>
              <!-- The caption under the number explains the NUMBER: "6 d 3 h" —
                   "until 27.09, 02:39", or "starts 12.10" before the start. -->
              <span class="text-micro text-muted">
                {soon
                  ? tr('competitions.p.startsAt', { date: dateOf(row.competition.startsAt!) })
                  : deadlineNote(row.competition.deadlineAt, now)}
              </span>
            </div>

            {@render youLane(row, false)}
            {@render action(row)}
          </div>
        </article>
      {/each}
    </section>

    <section class="flex flex-col">
      {@render sectionHead(tr('competitions.p.sectionFinished'), finished.length)}
      {#if finished.length === 0}
        <p class="border-b border-line py-4 text-ui text-muted">
          {tr('competitions.p.emptyFinished')}
        </p>
      {/if}
      {#each finished as row (row.competition.id)}
        {#if lateOpen(row)}
          <!-- Still takes notebooks, outside the standings: a card with a
               button, as a running one, and the late mark over the title —
               the same words the competition's own header carries. -->
          <article class="flex flex-col gap-5 border-b border-line py-6">
            <div class="flex min-w-0 grow flex-col gap-2">
              <span class="flex items-center gap-1.5 self-start border border-brand-2 px-2 py-0.5 text-micro font-semibold leading-4 text-brand-2 dark:border-accent dark:text-accent">
                <span class="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true"></span>
                {tr('competitions.p.lateOpen')}
              </span>
              <h3 class="text-head font-black text-ink">
                <a class="break-words hover:text-accent-text hover:underline underline-offset-4" href={`/k/${encodeURIComponent(row.competition.slug)}`}>{row.competition.title}</a>
              </h3>
              <p class="text-micro text-muted">{overMeta(row)}</p>
            </div>
            <div class="flex flex-wrap items-start gap-x-8 gap-y-4">
              <div class="flex min-w-[140px] flex-1 basis-[150px] flex-col gap-0.5">
                <span class="text-micro font-black uppercase leading-5 tracking-label text-muted">
                  {tr('competitions.p.deadlinePassedLabel')}
                </span>
                <span class="font-mono text-title font-bold text-ink">
                  {row.competition.deadlineAt === null ? '—' : whenWords(row.competition.deadlineAt, now)}
                </span>
              </div>
              {@render youLane(row, true)}
              {@render action(row)}
            </div>
          </article>
        {:else}
          <article class="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-line py-4">
            <div class="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
              <h3 class="text-title font-bold leading-[22px] text-ink">
                <a class="break-words hover:text-accent-text hover:underline underline-offset-4" href={`/k/${encodeURIComponent(row.competition.slug)}`}>{row.competition.title}</a>
              </h3>
              <p class="text-micro text-muted">{overMeta(row)}</p>
            </div>
            <span class="w-[150px] shrink-0 text-2xs text-muted">
              {row.competition.deadlineAt === null
                ? ''
                : tr('competitions.p.finishedAt', { date: dateOf(row.competition.deadlineAt) })}
            </span>
            <span class="w-[150px] shrink-0 font-mono text-ui text-ink">
              {row.mine?.joined ? standing(row) : '—'}
            </span>
            <button
              class="shrink-0 whitespace-nowrap text-left text-2xs text-accent-text hover:underline sm:ml-auto"
              type="button"
              onclick={() => onopen(row.competition.slug)}
            >
              {tr('competitions.p.results')}
            </button>
          </article>
        {/if}
      {/each}
    </section>
  {/if}
</div>
