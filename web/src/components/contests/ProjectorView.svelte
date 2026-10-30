<!--
  The board on the projector (K6): `/a/<slug>/leaderboard/screen`.

  Night colours whatever the laptop's theme: a white slab on the wall of a
  dark room is what the class looks at for an hour, and the dark board is the
  one read from the back row. The theme is BORROWED for the screen's life
  (lib/theme.svelte.ts · borrowTheme, as the lecture console does) — the
  person's own choice is not touched, and leaving the screen gives it back.

  The class's view of the board (the screen asks with `audience=class`):
  nobody's own row is lifted or unfrozen on a screen everybody looks at. As
  many rows as fit the wall without scrolling — nobody scrolls a projector —
  and a count of the rest.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { tr } from '@shared/i18n'
  import type { EntrantContestView, EntrantStandings } from '@shared/contests-entrant'
  import StandingsTable from './StandingsTable.svelte'
  import { clockOf, remainingClock } from '@/lib/competition-words'
  import { contestCountdown, firstSolvers } from '@/lib/contest-words'
  import { borrowTheme } from '@/lib/theme.svelte'

  interface Props {
    view: EntrantContestView
    standings: EntrantStandings | null
    /** The board is shown to participants only, and this browser is not one. */
    closed: boolean
    serverNow: number
    /** «colloq.ru/a/algo-k2»: where the class finds the page on their own screens. */
    address: string
  }

  const { view, standings, closed, serverNow, address }: Props = $props()

  /*
   * `untrack`: borrowTheme reads the current theme to give it back later and
   * writes the borrowed one — an effect that read and wrote one rune would run
   * itself until Svelte gave up (ConsoleView learned this the hard way).
   */
  $effect(() => untrack(() => borrowTheme('dark')))

  /* The rows that fit under the header (about 210 px) and above the footer and its padding (about 130), at 84 px a row. */
  let height = $state(typeof window === 'undefined' ? 1080 : window.innerHeight)
  $effect(() => {
    const measure = (): void => {
      height = window.innerHeight
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  })
  const fit = $derived(Math.max(3, Math.floor((height - 340) / 84)))

  const countdown = $derived(contestCountdown(view.contest, serverNow))
  const firsts = $derived(standings ? firstSolvers(standings.rows, standings.problems) : [])
</script>

<main class="competition-ui flex h-full flex-col overflow-auto bg-canvas px-6 py-8 sm:px-14 sm:py-12">
  <header class="flex flex-wrap items-end justify-between gap-x-12 gap-y-6 pb-8">
    <div class="flex min-w-0 flex-col gap-2.5">
      <p class="text-[15px] font-black uppercase leading-[18px] tracking-section text-muted">{view.contest.title}</p>
      <h1 class="text-[56px] font-black leading-[60px] tracking-[-0.03em] text-ink">{tr('contests.p.screenTitle')}</h1>
    </div>
    <div class="flex items-end gap-12">
      {#if standings?.frozen && standings.freezeAt !== null}
        <p class="flex items-center gap-2.5 border border-brand-2 px-4 py-2.5 text-[16px] font-bold leading-5 text-[#9BB4F0]">
          <svg class="size-5 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1v14M2 4.5l12 7M2 11.5l12-7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          {tr('contests.p.frozenSince', { time: clockOf(standings.freezeAt) })}
        </p>
      {/if}
      {#if countdown}
        <div class="flex flex-col items-end gap-1">
          <span class="text-[13px] font-black uppercase leading-4 tracking-label text-muted">
            {tr(countdown.kind === 'start' ? 'contests.p.toStart' : 'contests.p.toEnd')}
          </span>
          <span class="font-mono text-[48px] font-bold leading-[52px] text-ink">{remainingClock(countdown.at - serverNow)}</span>
        </div>
      {/if}
    </div>
  </header>

  {#if standings}
    <StandingsTable {standings} projector limit={fit} />
    <footer class="flex flex-wrap justify-between gap-x-8 gap-y-2 pt-6">
      <p class="text-[18px] leading-6 text-muted">
        {#if firsts.length > 0}
          {tr('contests.p.firstSolvers', { list: firsts.map((first) => `${first.letter} — ${first.name}`).join(', ') })}
        {/if}
      </p>
      <p class="font-mono text-[16px] leading-6 text-faint">{address}</p>
    </footer>
  {:else if closed}
    <p class="text-[22px] leading-8 text-muted">{tr('contests.p.boardClosedTitle')}</p>
  {/if}
</main>
