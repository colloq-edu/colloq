<script lang="ts">
  /**
   * P1 — choosing a competition.
   *
   * Two sections under a shared header: live ones large, with a button and
   * your own place, and finished ones as a single line each. The difference
   * in size is the screen's hierarchy: a live competition needs action today,
   * a finished one is only a reason to look at how it ended.
   */
  import { tr } from '@shared/i18n'
  import type { EntrantCompetitionRow } from '@shared/competitions-entrant'
  import {
    dateOf,
    deadlineNote,
    deadlineUrgent,
    formatScore,
    metricArrow,
    placeWithScore,
    remainingWords,
  } from '@/lib/competition-words'

  interface Props {
    rows: EntrantCompetitionRow[]
    now: number
    /** Who is being asked for a name right now: the competition's slug or null. */
    joining: string | null
    joinBusy: boolean
    joinRefusal: string | null
    defaultName: string
    onopen: (slug: string) => void
    onjoin: (slug: string, name: string) => void
    onjoinstart: (slug: string | null) => void
  }

  const {
    rows,
    now,
    joining,
    joinBusy,
    joinRefusal,
    defaultName,
    onopen,
    onjoin,
    onjoinstart,
  }: Props = $props()

  const running = $derived(rows.filter((row) => row.competition.state === 'live'))
  const finished = $derived(rows.filter((row) => row.competition.state !== 'live'))

  let name = $state('')
  /*
   * The name is filled in with the one the person already joined under: a
   * second competition should not ask for it again. Exactly once, and only
   * while the field is untouched — otherwise the effect would overwrite what
   * is being typed in it.
   */
  let typed = false
  $effect(() => {
    if (joining && !typed && defaultName) name = defaultName
  })

</script>

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
      <h2 class="border-b-2 border-ink pb-2.5 text-micro font-black uppercase leading-5 tracking-section text-ink">
        {tr('competitions.p.sectionRunning')}
      </h2>
      {#if running.length === 0}
        <p class="border-b border-line py-6 text-ui text-muted">{tr('competitions.p.emptyRunning')}</p>
      {/if}
      {#each running as row (row.competition.id)}
        {@const urgent = deadlineUrgent(row.competition.deadlineAt, now)}
        {@const closed = row.competition.deadlineAt !== null && row.competition.deadlineAt <= now}
        {@const mine = row.mine}
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
                {tr('competitions.p.left')}
              </span>
              <span
                class="font-mono text-title font-bold {urgent ? 'text-warning' : 'text-ink'}"
              >
                {row.competition.deadlineAt === null
                  ? '—'
                  : remainingWords(row.competition.deadlineAt - now)}
              </span>
              <!-- The caption under the number explains the NUMBER: "6 d 3 h" —
                   "until 27.09, 02:39". Once the deadline has passed, both lines
                   say "submissions closed", and the caption would only repeat
                   it; instead it shows the date it closed, because that is
                   what people look at. -->
              <span class="text-micro text-muted">
                {closed
                  ? tr('competitions.p.finishedAt', { date: dateOf(row.competition.deadlineAt!) })
                  : deadlineNote(row.competition.deadlineAt, now)}
              </span>
            </div>

            <div class="flex min-w-[140px] flex-1 basis-[150px] flex-col gap-0.5">
              <span class="text-micro font-black uppercase leading-5 tracking-label text-muted">
                {tr('competitions.p.you')}
              </span>
              {#if mine?.joined}
                <span class="font-mono text-title font-bold text-ink">
                  {mine.place === null ? '—' : placeWithScore(mine.place, mine.score)}
                </span>
                <span class="text-micro text-muted">
                  {[
                    tr('competitions.p.submissionsCount', { count: mine.submissions }),
                    mine.inFlight > 0 ? tr('competitions.p.inFlight', { count: mine.inFlight }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              {:else}
                <span class="text-ui leading-6 text-muted">{tr('competitions.p.notJoined')}</span>
              {/if}
            </div>

            <div class="flex w-full shrink-0 items-center self-center sm:ml-auto sm:w-auto">
              {#if mine?.joined}
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
                  onclick={() => onjoinstart(row.competition.slug)}
                >
                  {tr('competitions.p.join')}
                </button>
              {/if}
            </div>
          </div>
        </article>

        {#if joining === row.competition.slug}
          <!-- The name is asked for right under the card: the mockup has one
               button, but without a name there is nothing to call the person
               on the leaderboard, and sending them to a separate screen for
               it means losing those who came just to look. -->
          <form
            class="flex flex-col gap-2 border-b border-line bg-surface p-4"
            onsubmit={(event) => {
              event.preventDefault()
              if (name.trim()) onjoin(row.competition.slug, name.trim())
            }}
          >
            <h4 class="text-ui font-bold text-ink">{tr('competitions.p.joinTitle')}</h4>
            <p class="text-micro text-muted">{tr('competitions.p.joinHint')}</p>
            <div class="flex flex-wrap gap-2">
              <input
                class="h-9 min-w-0 grow border border-line bg-canvas px-3 text-2xs text-ink placeholder:text-faint focus:border-accent focus:outline-none"
                placeholder={tr('competitions.p.namePlaceholder')}
                aria-label={tr('competitions.p.namePlaceholder')}
                bind:value={name}
                oninput={() => (typed = true)}
                maxlength="80"
              />
              <button
                class="h-9 shrink-0 bg-brand px-4 text-micro font-black uppercase tracking-label text-white disabled:bg-faint"
                type="submit"
                disabled={!name.trim() || joinBusy}
              >
                {tr('competitions.p.join')}
              </button>
              <button
                class="h-9 shrink-0 px-2 text-2xs text-muted"
                type="button"
                onclick={() => onjoinstart(null)}
              >
                {tr('competitions.p.cancel')}
              </button>
            </div>
            {#if joinRefusal}
              <p class="text-micro leading-[18px] text-danger">{joinRefusal}</p>
            {/if}
          </form>
        {/if}
      {/each}
    </section>

    <section class="flex flex-col">
      <h2 class="border-b-2 border-ink pb-2.5 text-micro font-black uppercase leading-5 tracking-section text-ink">
        {tr('competitions.p.sectionFinished')}
      </h2>
      {#if finished.length === 0}
        <p class="border-b border-line py-4 text-ui text-muted">
          {tr('competitions.p.emptyFinished')}
        </p>
      {/if}
      {#each finished as row (row.competition.id)}
        <article class="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-line py-4">
          <div class="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
            <h3 class="text-title font-bold leading-[22px] text-ink">
              <a class="break-words hover:text-accent-text hover:underline underline-offset-4" href={`/k/${encodeURIComponent(row.competition.slug)}`}>{row.competition.title}</a>
            </h3>
            <p class="text-micro text-muted">
              {[
                metricArrow(row.competition.metric.name, row.competition.metric.direction),
                tr('competitions.p.entrants', { count: row.entrants }),
                row.privateOpen
                  ? tr('competitions.p.resultsOpen')
                  : tr('competitions.p.resultsClosed'),
              ].join(' · ')}
            </p>
          </div>
          <span class="w-[150px] shrink-0 text-2xs text-muted">
            {row.competition.deadlineAt === null
              ? ''
              : tr('competitions.p.finishedAt', { date: dateOf(row.competition.deadlineAt) })}
          </span>
          <span class="w-[150px] shrink-0 font-mono text-ui text-ink">
            {row.mine?.place ? placeWithScore(row.mine.place, row.mine.score) : '—'}
          </span>
          <button
            class="shrink-0 whitespace-nowrap text-left text-2xs text-accent-text hover:underline sm:ml-auto"
            type="button"
            onclick={() => onopen(row.competition.slug)}
          >
            {tr('competitions.p.results')}
          </button>
        </article>
      {/each}
    </section>
  {/if}
</div>
