<script lang="ts">
  /**
   * The competition page header: what this is, how much is left, where I am —
   * and the tabs.
   *
   * One for all three tabs and both layouts, because this is one page: going
   * "Task → Submissions → Leaderboard" must not redraw the title and reset
   * the timer, and a phone differs from a desktop not in what it contains but
   * in WHAT fits into it — three figures in a row instead of two large ones
   * on the right, and short tab names ("Task" instead of "Task and data").
   */
  import { tr } from '@shared/i18n'
  import { competitionWord, directionWord } from '@shared/competitions'
  import type { EntrantCompetitionView } from '@shared/competitions-entrant'
  import Badge from './Badge.svelte'
  import {
    deadlineUrgent,
    formatScore,
    metricArrow,
    remainingClock,
    shortName,
    avatarLetter,
    avatarTint,
  } from '@/lib/competition-words'
  import { COMPETITIONS_LANDING } from '@/lib/routes'
  import type { CompetitionView } from '@/lib/routes'

  interface Props {
    view: EntrantCompetitionView
    tab: CompetitionView
    now: number
    phone: boolean
    /** The tab counter — only while the competition is live, and only on desktop. */
    submissions: number | null
    place: number | null
    total: number
    /** Final place and shift: they appear along with the private leaderboard. */
    finalPlace: number | null
    shift: number | null
    /** The person's best public result — the third figure on a phone. */
    score: number | null
    name: string | null
    ontab: (tab: CompetitionView) => void
    onnavigate: (path: string) => void
  }

  const {
    view,
    tab,
    now,
    phone,
    submissions,
    place,
    total,
    finalPlace,
    shift,
    score,
    name,
    ontab,
    onnavigate,
  }: Props = $props()

  const competition = $derived(view.competition)
  /*
   * "Over" means submissions are closed, not the state of a row in the
   * database.
   *
   * A passed deadline does NOT move the competition to `finished`: the
   * teacher changes the state with the "Finish now" button, and at that
   * moment they are at the review and have not got to it yet. But
   * submissions are already closed, the final results have already opened
   * by themselves, and the page meanwhile showed a "LIVE" badge next to a
   * "00:00" timer — the only thing on it that lied. The P3 mockup
   * ("leaderboard after the deadline") draws "FINISHED" here, and this is
   * where it comes from. `accepting` arrives from the server via the same
   * `submissionsOpen` the door uses to refuse a submission — two answers to
   * one question would diverge at exactly the minute the whole class notices.
   */
  const over = $derived(view.accepting === 'closed')
  /** Submissions are open: the tab counter and the clock only make sense then. */
  const open = $derived(view.accepting === 'open')
  const urgent = $derived(deadlineUrgent(competition.deadlineAt, now))
  const stateBadge = $derived({
    word: competitionWord(over ? 'finished' : competition.state),
    tone: (!over && competition.state === 'live' ? 'accent' : 'neutral') as 'accent' | 'neutral',
  })
  const placeWords = $derived(
    place === null ? '—' : tr('competitions.p.placeOf', { place, total }),
  )
  const tabs: { id: CompetitionView; label: string }[] = $derived([
    { id: 'task', label: tr(phone ? 'competitions.p.tabTaskShort' : 'competitions.p.tabTask') },
    {
      id: 'submissions',
      label:
        !phone && open && submissions !== null
          ? `${tr('competitions.p.tabSubmissions')} ${submissions}`
          : tr('competitions.p.tabSubmissions'),
    },
    { id: 'dependencies', label: tr('dependencies.title') },
    { id: 'leaderboard', label: tr('competitions.p.tabLeaderboard') },
  ])
</script>

<div class="flex flex-col gap-3 border-b border-line px-4 pt-1.5 sm:gap-[18px] sm:px-10 sm:pt-8">
  {#if phone}
    <div class="flex items-center justify-between gap-3">
      <span class="flex min-w-0 items-center gap-2">
        <button
          class="shrink-0 text-micro text-accent-text"
          type="button"
          onclick={() => onnavigate(COMPETITIONS_LANDING)}
        >
          {tr('competitions.p.back')}
        </button>
        <!-- On a phone the state badge lives here, not above the title: in the
             P4 mockup the competition is live and there is nothing to say
             about it, but "FINISHED" must be said — otherwise closed
             submissions look like a broken button. -->
        {#if over || competition.state !== 'live'}
          <Badge word={stateBadge.word} tone={stateBadge.tone} form="filled" phone />
        {/if}
      </span>
      {#if name}
        <span class="flex min-w-0 items-center gap-1.5">
          <span
            class="flex size-5 shrink-0 items-center justify-center rounded-full text-micro font-bold text-[#7A4A12]"
            style="background: {avatarTint(name)}"
            aria-hidden="true">{avatarLetter(name)}</span
          >
          <span class="truncate text-micro font-bold text-ink">{shortName(name)}</span>
        </span>
      {/if}
    </div>
    <h1 class="text-display font-black text-ink">{competition.title}</h1>
    <div class="flex flex-wrap gap-6">
      {#if !over && competition.deadlineAt !== null}
        <div class="flex flex-col gap-px">
          <span
            class="text-micro font-black uppercase leading-5 tracking-label {urgent
              ? 'text-warning'
              : 'text-muted'}"
          >
            {tr('competitions.p.toDeadline')}
          </span>
          <span class="font-mono text-title font-bold leading-5 {urgent ? 'text-warning' : 'text-ink'}">
            {remainingClock(competition.deadlineAt - now)}
          </span>
        </div>
      {/if}
      <div class="flex flex-col gap-px">
        <span class="text-micro font-black uppercase leading-5 tracking-label text-muted">
          {tr(finalPlace === null ? 'competitions.p.placeShort' : 'competitions.p.finalPlace')}
        </span>
        <span class="font-mono text-title font-bold leading-5 text-ink">
          {finalPlace === null
            ? placeWords
            : tr('competitions.p.placeOf', { place: finalPlace, total })}
        </span>
      </div>
      <div class="flex flex-col gap-px">
        <span class="text-micro font-black uppercase leading-5 tracking-label text-muted">
          {metricArrow(competition.metric.name, competition.metric.direction)}
        </span>
        <span class="font-mono text-title font-bold leading-5 text-ink">{formatScore(score)}</span>
      </div>
    </div>
  {:else}
    <div class="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
      <div class="flex min-w-0 flex-col gap-2.5">
        <div class="flex flex-wrap items-center gap-2.5">
          <Badge word={stateBadge.word} tone={stateBadge.tone} form="filled" />
          <span class="text-2xs text-muted">
            {[
              competition.metric.name,
              directionWord(competition.metric.direction),
              tr('competitions.p.entrants', { count: view.entrants }),
              over ? tr('competitions.p.submissionsCount', { count: view.submissions }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <h1 class="text-[32px] font-black leading-9 tracking-[-0.03em] text-ink lg:text-gauge-lg lg:leading-[44px]">
          {competition.title}
        </h1>
      </div>
      <div class="flex shrink-0 gap-9 pb-1">
        {#if !over && competition.deadlineAt !== null}
          <div class="flex flex-col items-end gap-0.5">
            <span
              class="text-micro font-black uppercase leading-5 tracking-label {urgent
                ? 'text-warning'
                : 'text-muted'}"
            >
              {tr('competitions.p.toDeadline')}
            </span>
            <span
              class="font-mono text-[22px] font-bold leading-7 {urgent ? 'text-warning' : 'text-ink'}"
            >
              {remainingClock(competition.deadlineAt - now)}
            </span>
          </div>
        {/if}
        <div class="flex flex-col items-end gap-0.5">
          <span class="text-micro font-black uppercase leading-5 tracking-label text-muted">
            {tr(finalPlace === null ? 'competitions.p.yourPlace' : 'competitions.p.finalPlace')}
          </span>
          <span class="font-mono text-[22px] font-bold leading-7 text-ink">
            {finalPlace === null
              ? placeWords
              : tr('competitions.p.placeOf', { place: finalPlace, total })}
          </span>
        </div>
        {#if shift !== null}
          <div class="flex flex-col items-end gap-0.5">
            <span class="text-micro font-black uppercase leading-5 tracking-label text-muted">
              {tr(
                shift > 0
                  ? 'competitions.p.shiftUp'
                  : shift < 0
                    ? 'competitions.p.shiftDown'
                    : 'competitions.p.shiftNone',
              )}
            </span>
            <span
              class="font-mono text-[22px] font-bold leading-7 {shift > 0
                ? 'text-positive'
                : shift < 0
                  ? 'text-danger'
                  : 'text-muted'}"
            >
              {shift === 0
                ? '—'
                : `${tr('competitions.p.places', { count: Math.abs(shift) })} ${shift > 0 ? '↑' : '↓'}`}
            </span>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <nav class="flex flex-wrap gap-x-4 gap-y-2 sm:gap-x-7">
    {#each tabs as item (item.id)}
      <button
        class="pb-2 text-ui {tab === item.id
          ? 'border-b-[3px] border-accent font-bold text-ink'
          : 'border-b-[3px] border-transparent text-muted hover:text-ink'}"
        type="button"
        aria-current={tab === item.id ? 'page' : undefined}
        onclick={() => ontab(item.id)}
      >
        {item.label}
      </button>
    {/each}
  </nav>
</div>
