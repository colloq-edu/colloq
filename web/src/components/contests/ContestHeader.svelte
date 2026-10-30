<!--
  The contest's header (K1–K3, K5): what this is, how long is left, where I
  stand — and the tabs.

  One for every tab and both widths, because the tabs are one page: going
  «Задачи → Посылки → Лидерборд» must not redraw the title or restart the
  countdown. The countdown runs on the server's clock (`serverNow`, measured
  by the page from the door's answer), so a laptop five minutes fast does not
  count to a start that has not come.

  The tabs are links, not buttons: each is an address (`/a/<slug>/…`) a
  student pastes into the course chat, opens in a second tab, or reaches with
  «back». A click stays inside the page (onnavigate); a ⌘-click opens a tab.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { contestPhase } from '@shared/contests'
  import type { EntrantContestView } from '@shared/contests-entrant'
  import Badge from '@/components/competitions/Badge.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { remainingClock } from '@/lib/competition-words'
  import { contestCountdown, contestMeta, ofWords, phaseBadge } from '@/lib/contest-words'
  import { COMPETITIONS_LANDING, contestRoutePath, type ContestView } from '@/lib/routes'

  interface Props {
    view: EntrantContestView
    tab: ContestView
    /** The problem the «Задачи» tab returns to: the one last open. */
    letter: string | null
    serverNow: number
    phone: boolean
    /** The «Посылки 9» count; null — not known (a stranger, or still loading). */
    submissions: number | null
    /** New answers or announcements since the person last looked: the dot beside «Вопросы». */
    unread: boolean
    /** The viewer's place among the participants; null — not on the board. */
    place: number | null
    onnavigate: (path: string) => void
  }

  const { view, tab, letter, serverNow, phone, submissions, unread, place, onnavigate }: Props = $props()

  const contest = $derived(view.contest)
  const phase = $derived(contestPhase(contest, serverNow))
  const badge = $derived(phaseBadge(phase))
  /** Over, and still taking solutions outside the standings: «ДОРЕШИВАНИЕ» beside the badge. */
  const late = $derived(phase === 'over' && contest.upsolving && contest.state !== 'draft')
  const countdown = $derived(contestCountdown(contest, serverNow))
  const left = $derived(countdown ? countdown.at - serverNow : null)
  /*
   * The last five minutes of a class test are amber. Not the competitions'
   * six hours: a contest lasts an hour or two, and the colour has to mean
   * «send what you have» or people learn to ignore it.
   */
  const urgent = $derived(countdown?.kind === 'end' && left !== null && left <= 5 * 60_000)
  const joined = $derived(view.mine?.joined === true)
  const ioi = $derived(contest.rules === 'ioi')
  const maxScore = $derived(view.problems.reduce((sum, problem) => sum + problem.maxScore, 0))
  const meta = $derived(
    contestMeta({
      rules: contest.rules,
      problems: view.problems.length,
      entrants: view.entrants,
      penaltyMinutes: contest.penaltyMinutes,
    }),
  )

  const tabs = $derived([
    { id: 'problems' as const, label: tr('contests.p.tabProblems'), path: contestRoutePath({ slug: contest.slug, view: 'problems', letter }) },
    {
      id: 'submissions' as const,
      label: submissions ? `${tr('contests.p.tabSubmissions')} ${submissions}` : tr('contests.p.tabSubmissions'),
      path: contestRoutePath({ slug: contest.slug, view: 'submissions', letter: null }),
    },
    { id: 'leaderboard' as const, label: tr('contests.p.tabLeaderboard'), path: contestRoutePath({ slug: contest.slug, view: 'leaderboard', letter: null }) },
    { id: 'questions' as const, label: tr('contests.p.tabQuestions'), path: contestRoutePath({ slug: contest.slug, view: 'questions', letter: null }) },
  ])

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    onnavigate(path)
  }
</script>

{#snippet figure(labelText: string, value: string, tone: string = 'text-ink')}
  <div class="flex flex-col items-end gap-0.5">
    <span class="text-micro font-black uppercase leading-5 tracking-label {tone === 'text-warning' ? 'text-warning' : 'text-muted'}">
      {labelText}
    </span>
    <span class="font-mono text-[22px] font-bold leading-7 {tone}">{value}</span>
  </div>
{/snippet}

{#snippet tabRow()}
  <nav class="flex gap-x-5 gap-y-2 overflow-x-auto sm:flex-wrap sm:gap-x-7" aria-label={tr('contests.p.tabsLabel')}>
    {#each tabs as item (item.id)}
      <a
        class="flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-[3px] pb-2 text-ui no-underline {tab === item.id || (item.id === 'leaderboard' && tab === 'screen')
          ? 'border-accent font-bold text-ink'
          : 'border-transparent text-muted hover:text-ink'}"
        href={item.path}
        aria-current={tab === item.id ? 'page' : undefined}
        onclick={(event) => go(event, item.path)}
      >
        {item.label}
        {#if item.id === 'questions' && unread}
          <span class="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true"></span>
          <span class="sr-only">{tr('contests.p.unread')}</span>
        {/if}
      </a>
    {/each}
  </nav>
{/snippet}

{#if phone}
  <!-- K5: the bar is the header — the mark (back to the list), the name, the clock. -->
  <div class="flex flex-col border-b border-line">
    <div class="flex h-[52px] items-center justify-between gap-3 border-b border-line px-4">
      <span class="flex min-w-0 items-center gap-2.5">
        <a
          class="flex shrink-0 items-center text-primary"
          href={COMPETITIONS_LANDING}
          aria-label={tr('contests.p.back')}
          onclick={(event) => go(event, COMPETITIONS_LANDING)}
        >
          <Icon name="logo" size={14} />
        </a>
        <h1 class="min-w-0 truncate text-ui font-bold text-ink">{contest.title}</h1>
      </span>
      {#if countdown && left !== null}
        <span class="shrink-0 font-mono text-ui font-bold {urgent ? 'text-warning' : 'text-ink'}">
          <span class="sr-only">{tr(countdown.kind === 'start' ? 'contests.p.toStart' : 'contests.p.toEnd')}</span>
          {remainingClock(left)}
        </span>
      {:else if phase !== 'open'}
        <Badge word={badge.word} tone={badge.tone} form={badge.form} phone />
      {/if}
    </div>
    <div class="px-4 pt-2.5">
      {@render tabRow()}
    </div>
  </div>
{:else}
  <div class="flex flex-col gap-[18px] border-b border-line px-4 pt-7 sm:px-10">
    <div class="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
      <div class="flex min-w-0 flex-col gap-2.5">
        <div class="flex flex-wrap items-center gap-2.5">
          <Badge word={badge.word} tone={badge.tone} form={badge.form} />
          {#if late}
            <span class="flex items-center gap-1.5 border border-brand-2 px-2 py-0.5 text-micro font-semibold leading-4 text-brand-2 dark:border-accent dark:text-accent">
              <span class="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true"></span>
              {tr('contests.p.upsolving')}
            </span>
          {/if}
          <span class="text-2xs text-muted">{meta}</span>
        </div>
        <h1 class="text-[32px] font-black leading-9 tracking-[-0.03em] text-ink lg:text-gauge-lg lg:leading-[44px]">
          {contest.title}
        </h1>
      </div>
      <div class="flex shrink-0 flex-wrap gap-9 pb-1">
        {#if countdown && left !== null}
          {@render figure(
            tr(countdown.kind === 'start' ? 'contests.p.toStart' : 'contests.p.toEnd'),
            remainingClock(left),
            urgent ? 'text-warning' : 'text-ink',
          )}
        {/if}
        {#if joined && view.problems.length > 0}
          {@render figure(
            tr(ioi ? 'contests.p.pointsLabel' : 'contests.p.solvedLabel'),
            ioi ? ofWords(view.mine?.score ?? 0, maxScore) : ofWords(view.mine?.solved ?? 0, view.problems.length),
          )}
        {/if}
        {#if joined}
          {@render figure(tr('contests.p.placeLabel'), ofWords(place, view.entrants))}
        {/if}
      </div>
    </div>
    {@render tabRow()}
  </div>
{/if}
