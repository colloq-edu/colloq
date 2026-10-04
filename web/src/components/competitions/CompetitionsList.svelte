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
   */
  import { tr } from '@shared/i18n'
  import { LIMITS, competitionPhase, nameForJoin, submissionsOpen } from '@shared/competitions'
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

  /*
   * The name is checked here by the same function the door uses
   * (shared/competitions.ts · nameForJoin): a Telegram username or an email,
   * or the name the person already carries sent back untouched — so someone
   * who joined as "Anna Kim" before the rule is not stopped at the second
   * competition by the name the form itself filled in. A name that will not
   * pass never leaves the browser: the refusal is the same sentence the door
   * would answer with, only without the round trip.
   */
  const invalid = $derived(name.trim() !== '' && nameForJoin(name, defaultName || null) === null)
  /*
   * While the person is still typing, the rule is a hint in grey; once they
   * leave the field or press JOIN with a name that will not do, it is a
   * refusal in red. Red from the first keystroke would scold "@i" for not yet
   * being "@ivan". JOIN itself stays pressable: a dim button would swallow
   * Enter without a word, and pressing it is exactly when the person wants
   * to hear why.
   */
  let touched = $state(false)
  $effect(() => {
    void joining
    touched = false
  })
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
        onclick={() => onjoinstart(row.competition.slug)}
      >
        {tr('competitions.p.join')}
      </button>
    {/if}
  </div>
{/snippet}

{#snippet joinForm(row: EntrantCompetitionRow)}
  <!-- The name is asked for right under the card: the mockup has one
       button, but without a name there is nothing to call the person
       on the leaderboard, and sending them to a separate screen for
       it means losing those who came just to look. -->
  <form
    class="flex flex-col gap-2 border-b border-line bg-surface p-4"
    onsubmit={(event) => {
      event.preventDefault()
      if (!name.trim()) return
      if (invalid) {
        touched = true
        return
      }
      onjoin(row.competition.slug, name.trim())
    }}
  >
    <label class="text-ui font-bold text-ink" for="competition-join-name">
      {tr('competitions.handle.label')}
    </label>
    <p id="competition-join-hint" class="text-micro text-muted">{tr('competitions.p.joinHint')}</p>
    <div class="flex flex-wrap gap-2">
      <!-- `inputmode="email"` puts "@" on a phone's first keyboard
           page, which both kinds of name start or hinge on; `type`
           stays text, since "@ivan_petrov" is no address to a browser. -->
      <input
        id="competition-join-name"
        class="h-9 min-w-0 grow border border-line bg-canvas px-3 text-2xs text-ink placeholder:text-faint focus:border-accent focus:outline-none"
        placeholder={tr('competitions.handle.placeholder')}
        aria-describedby={invalid ? 'competition-join-hint competition-join-rule' : 'competition-join-hint'}
        aria-invalid={invalid && touched}
        bind:value={name}
        oninput={() => (typed = true)}
        onblur={() => (touched = invalid)}
        maxlength={LIMITS.entrantName}
        inputmode="email"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
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
    {#if invalid}
      <p
        id="competition-join-rule"
        class="text-micro leading-[18px] {touched ? 'text-danger' : 'text-muted'}"
      >
        {tr('competitions.refusal.nameNotHandle')}
      </p>
    {:else if joinRefusal}
      <p class="text-micro leading-[18px] text-danger">{joinRefusal}</p>
    {/if}
  </form>
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

        {#if joining === row.competition.slug}
          {@render joinForm(row)}
        {/if}
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

          {#if joining === row.competition.slug}
            {@render joinForm(row)}
          {/if}
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
