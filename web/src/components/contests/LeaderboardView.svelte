<!--
  The leaderboard tab (K3, K4): «Все · 34» or «Рядом со мной», the freeze
  banner, the board, the legend.

  «Рядом со мной» is the person's own race — the three just above to catch
  and the three just below catching up — and is offered only to someone who
  is on the board; for anyone else it would show the whole table under a
  label that promised a part of it.

  The banner says what a frozen board means in one sentence, where the «?»
  cells are: without it a «?» reads as a bug, and the teacher answers the same
  question thirty times.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { EntrantStandings } from '@shared/contests-entrant'
  import StandingsTable from './StandingsTable.svelte'
  import { clockOf } from '@/lib/competition-words'

  interface Props {
    standings: EntrantStandings
    phone: boolean
    /** The test the viewer's own runs are on, per problem: «тест 7» in their row. */
    pending: Record<string, number | null>
  }

  const { standings, phone, pending }: Props = $props()

  let near = $state(false)
  const onBoard = $derived(standings.me !== null && standings.rows.some((row) => row.entrantId === standings.me))
</script>

<div class="flex flex-col">
  <div class="flex flex-col gap-3 pb-5 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
    <div class="flex shrink-0 self-start" role="group">
      <button
        class="px-4 py-2 text-2xs leading-4 {near ? 'border border-line text-muted hover:text-ink' : 'border border-brand bg-brand font-bold text-white'}"
        type="button"
        aria-pressed={!near}
        onclick={() => (near = false)}
      >
        {tr('contests.p.viewAll', { count: standings.rows.length })}
      </button>
      <button
        class="px-4 py-2 text-2xs leading-4 disabled:cursor-not-allowed disabled:opacity-50 {near ? 'border border-brand bg-brand font-bold text-white' : 'border border-line text-muted hover:text-ink'}"
        type="button"
        aria-pressed={near}
        disabled={!onBoard}
        title={onBoard ? undefined : tr('contests.p.notOnBoard')}
        onclick={() => (near = true)}
      >
        {tr('contests.p.viewNear')}
      </button>
    </div>
    {#if standings.frozen && standings.freezeAt !== null}
      <p class="flex items-start gap-2.5 bg-raised px-3.5 py-2 text-2xs leading-[17px] text-brand dark:text-ink" role="note">
        <svg class="mt-px size-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1v14M2 4.5l12 7M2 11.5l12-7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" class="text-brand-2 dark:text-accent" />
        </svg>
        <span>
          <b class="font-bold">{tr('contests.p.frozenBold', { time: clockOf(standings.freezeAt) })}</b>
          {tr('contests.p.frozenRest')}
        </span>
      </p>
    {/if}
  </div>

  <StandingsTable {standings} me={standings.me} {phone} near={near && onBoard} {pending} />
</div>
