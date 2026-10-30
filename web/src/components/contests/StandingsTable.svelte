<!--
  The contest's board — ICPC (K3) and IOI (K4), on a page, on a phone and on
  the projector (K6). One component for the participant's leaderboard tab,
  the projector screen and the teacher's console (A4), so that the three
  never draw the same cell three ways.

  It draws, it does not count. Who is above whom, what a frozen cell may
  say, who was first, which places — all of that arrives computed by the
  server (shared/contests.ts · computeStandings), places distinct, the freeze
  already applied for this viewer. What a cell LOOKS like is
  lib/contest-words.ts (icpcCell, ioiCell), where it is tested without a DOM.

  Self-contained on purpose: no child components. The panel imports it from
  another chunk, and the render test compiles this one file on the server.
-->
<script lang="ts" module>
  import type { ContestRules, StandingProblemTotals, StandingRow } from '@shared/contests'

  /** The board as both sides hold it: EntrantStandings and AdminStandings are both this. */
  export interface StandingsView {
    rules: ContestRules
    problems: { id: string; letter: string; title: string; maxScore: number }[]
    rows: StandingRow[]
    totals: StandingProblemTotals[]
    frozen: boolean
    freezeAt: number | null
    penaltyMinutes: number
    startsAt: number | null
  }
</script>

<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { StandingCell } from '@shared/contests'
  import { avatarTint } from '@/lib/competition-words'
  import { cellFace, nearRows, totalsPair, type CellFace, type CellTone } from '@/lib/contest-words'

  interface Props {
    standings: StandingsView
    /** The viewer's own row (entrant id): highlighted, marked «ВЫ». The panel passes nothing. */
    me?: string | null
    phone?: boolean
    /** The projector: night type sizes, no avatars, no «ВЫ», no legend, the top rows only. */
    projector?: boolean
    /** «Рядом со мной»: only the viewer's row and three on either side. */
    near?: boolean
    /** Rows shown before «Показать ещё»; on the projector, the rows that fit. null — all. */
    limit?: number | null
    /** The legend and the tie rule under the table. */
    legend?: boolean
    /** The test the viewer's own run is on, per problem id: «тест 7» in their row (K3). */
    pending?: Record<string, number | null>
  }

  const {
    standings,
    me = null,
    phone = false,
    projector = false,
    near = false,
    limit = 25,
    legend = true,
    pending = {},
  }: Props = $props()

  const icpc = $derived(standings.rules === 'icpc')
  /** Rows revealed by «Показать ещё»: grows by this much a press. */
  const MORE = 50
  let extra = $state(0)

  const around = $derived(near && !projector ? nearRows(standings.rows, me) : null)
  const visible = $derived.by(() => {
    if (around?.found) return around.rows
    if (limit === null) return standings.rows
    return standings.rows.slice(0, limit + extra)
  })
  /** Rows the table has and does not show: the «7–34» row offers them, the projector counts them. */
  const hidden = $derived(around?.found ? 0 : standings.rows.length - visible.length)

  const EMPTY: StandingCell = {
    solved: false,
    attempts: 0,
    minutes: null,
    first: false,
    pending: 0,
    frozen: 0,
    score: null,
    tried: false,
  }

  function face(row: StandingRow, index: number): CellFace {
    const problem = standings.problems[index]
    const own = me !== null && row.entrantId === me
    return cellFace(
      standings.rules,
      row.cells[index] ?? EMPTY,
      problem?.maxScore ?? 0,
      own && problem ? (pending[problem.id] ?? null) : null,
    )
  }

  /*
   * The paint of a cell's box by its tone. The pale fills are the solid
   * tokens at a tenth (a little more on navy, where a tenth is not seen),
   * laid over the page's ground as an inset shadow rather than as a
   * translucent background: on the viewer's lifted row a translucent tint
   * mixes with the lift, and the one row a student looks at would be the one
   * whose greens look grey. The solid green is the first solve's — on the
   * dark ground the green is light, and white on it would be 2:1, so the ink
   * there is the ground's.
   */
  const BOX: Record<CellTone, string> = {
    first: 'bg-positive',
    solved: 'bg-canvas shadow-[inset_0_0_0_100px_rgb(var(--positive)/0.1)] dark:shadow-[inset_0_0_0_100px_rgb(var(--positive)/0.15)]',
    failed: 'bg-canvas shadow-[inset_0_0_0_100px_rgb(var(--danger)/0.1)] dark:shadow-[inset_0_0_0_100px_rgb(var(--danger)/0.15)]',
    frozen: 'bg-raised',
    pending: 'border border-dashed border-accent bg-canvas',
    empty: '',
  }
  const MAIN: Record<CellTone, string> = {
    first: 'text-white dark:text-canvas',
    solved: 'text-positive',
    failed: 'text-danger',
    frozen: 'text-brand-2 dark:text-ink',
    pending: 'text-accent-text',
    empty: '',
  }
  const SUB: Record<CellTone, string> = {
    first: 'text-white/80 dark:text-canvas/75',
    solved: 'text-muted',
    failed: 'text-muted',
    frozen: 'text-brand-2 dark:text-muted',
    pending: 'text-accent-text',
    empty: '',
  }

  /* Sizes by the three places the board stands in (Paper K3/K4, K6, and a phone). */
  const boxSize = $derived(
    projector
      ? 'h-[60px] w-[94px]'
      : phone
        ? 'h-9 w-10'
        : icpc ? 'h-[42px] w-[72px]' : 'h-10 w-[84px]',
  )
  const mainSize = $derived(projector ? 'text-[20px] leading-6' : phone ? 'text-[13px] leading-4' : icpc ? 'text-[14px] leading-[17px]' : 'text-[15px] leading-[18px]')
  const subSize = $derived(projector ? 'text-[14px] leading-[18px]' : phone ? 'text-[10px] leading-3' : 'text-[12px] leading-[14px]')
  const column = $derived(projector ? 'w-[110px]' : phone ? 'w-11' : icpc ? 'w-[88px]' : 'w-[104px]')
  const label = $derived(
    projector
      ? 'text-[13px] font-black uppercase leading-4 tracking-label text-muted'
      : 'text-micro font-black uppercase leading-5 tracking-label text-muted',
  )
  /* Wide enough that the problems never squeeze the names to nothing; it scrolls sideways instead. */
  const minWidth = $derived(
    `${(projector ? 360 : phone ? 150 : 300) + standings.problems.length * (projector ? 110 : phone ? 44 : icpc ? 88 : 104) + (projector ? 220 : phone ? 76 : icpc ? 192 : 120)}px`,
  )
</script>

{#snippet box(cell: CellFace)}
  {#if cell.tone !== 'empty'}
    <span
      class="relative mx-auto flex flex-col items-center justify-center font-mono {boxSize} {BOX[cell.tone]} {cell.busy && cell.tone !== 'pending' ? 'outline-dashed outline-1 outline-offset-[-1px] outline-accent' : ''}"
      title={cell.label}
    >
      <span class="font-bold {mainSize} {MAIN[cell.tone]}" aria-hidden="true">{cell.main}</span>
      {#if cell.sub}
        <span class="{subSize} {SUB[cell.tone]}" aria-hidden="true">{cell.sub}</span>
      {/if}
      {#if cell.bar !== null}
        <span class="absolute bottom-0 left-0 h-[3px] bg-positive" style:width="{Math.round(cell.bar * 100)}%" aria-hidden="true"></span>
      {/if}
      <span class="sr-only">{cell.label}</span>
    </span>
  {/if}
{/snippet}

<div class="flex flex-col">
  <div class="w-full overflow-x-auto">
    <table class="w-full border-collapse text-left" style:min-width={minWidth} data-board={standings.rules}>
      <thead>
        <tr class="border-b-2 border-ink">
          <th
            scope="col"
            class="pb-2.5 align-bottom {label} {phone ? 'sticky left-0 z-10 bg-canvas' : 'w-20'}"
          >
            {phone ? `${tr('contests.p.colPlace')} · ${tr('contests.p.colEntrant')}` : tr('contests.p.colPlace')}
          </th>
          {#if !phone}
            <th scope="col" class="pb-2.5 align-bottom {label}">{tr('contests.p.colEntrant')}</th>
          {/if}
          {#each standings.problems as problem (problem.id)}
            <th scope="col" class="pb-2.5 text-center align-bottom {column}" title={problem.title}>
              <span
                class="block font-mono font-bold text-ink {projector ? 'text-[22px] leading-[26px]' : 'text-[15px] leading-[18px]'}"
              >
                {problem.letter}
              </span>
              {#if !icpc && !phone}
                <span class="block font-mono text-[11px] leading-[14px] text-faint">
                  {tr('contests.p.outOf', { max: problem.maxScore })}
                </span>
              {/if}
            </th>
          {/each}
          {#if icpc}
            <th scope="col" class="pb-2.5 text-right align-bottom {label} {projector ? 'w-[110px]' : phone ? 'w-10' : 'w-24'}">
              {tr('contests.p.colSolved')}
            </th>
            <th scope="col" class="pb-2.5 text-right align-bottom {label} {projector ? 'w-[110px]' : phone ? 'w-12' : 'w-24'}">
              {tr('contests.p.colPenalty')}
            </th>
          {:else}
            <th scope="col" class="pb-2.5 text-right align-bottom {label} {projector ? 'w-[140px]' : phone ? 'w-14' : 'w-[120px]'}">
              {tr('contests.p.colSum')}
            </th>
          {/if}
        </tr>
      </thead>

      <tbody>
        {#if standings.rows.length === 0}
          <tr>
            <td class="py-6 text-ui text-muted" colspan={standings.problems.length + (phone ? 1 : 2) + (icpc ? 2 : 1)}>
              {tr('contests.p.boardEmpty')}
            </td>
          </tr>
        {/if}

        {#each visible as row (row.entrantId)}
          {@const own = !projector && me !== null && row.entrantId === me}
          <tr
            class="border-b {projector ? 'h-[84px] border-line' : phone ? 'h-12 border-line' : 'h-[60px] border-line'} {own ? 'bg-raised' : ''}"
            aria-current={own ? 'true' : undefined}
          >
            {#if phone}
              <!-- One sticky column on a phone: the place and the name stay put while the problems scroll. -->
              <th scope="row" class="sticky left-0 z-10 max-w-[150px] pr-2 text-left font-normal {own ? 'bg-raised' : 'bg-canvas'}">
                <span class="flex min-w-0 items-center gap-2">
                  <span class="w-6 shrink-0 font-mono text-[16px] font-bold leading-5 text-ink">{row.place}</span>
                  <span class="min-w-0 truncate text-2xs font-bold text-ink">{row.name}</span>
                  {#if own}
                    <span class="shrink-0 bg-brand px-1 text-[10px] font-black uppercase leading-[14px] tracking-label text-white dark:bg-accent dark:text-accent-ink">
                      {tr('contests.p.you')}
                    </span>
                  {/if}
                </span>
              </th>
            {:else}
              <td class="font-mono font-bold text-ink {projector ? 'text-[34px] leading-10' : 'text-[20px] leading-6'}">{row.place}</td>
              <th scope="row" class="pr-4 text-left font-normal">
                <span class="flex min-w-0 items-center gap-3">
                  {#if !projector}
                    <span class="size-7 shrink-0 rounded-full" style:background={avatarTint(row.name)} aria-hidden="true"></span>
                  {/if}
                  <span class="min-w-0 truncate font-bold text-ink {projector ? 'text-[28px] leading-[34px]' : 'text-[16px] leading-5'}">{row.name}</span>
                  {#if own}
                    <span class="shrink-0 bg-brand px-[7px] py-0.5 text-[10px] font-black uppercase leading-[14px] tracking-label text-white dark:bg-accent dark:text-accent-ink">
                      {tr('contests.p.you')}
                    </span>
                  {/if}
                </span>
              </th>
            {/if}
            {#each standings.problems as problem, index (problem.id)}
              <td class="px-1 text-center">{@render box(face(row, index))}</td>
            {/each}
            {#if icpc}
              <td class="text-right font-mono font-bold text-ink {projector ? 'text-[34px] leading-10' : phone ? 'text-[16px] leading-5' : 'text-[20px] leading-6'}">
                {row.solved}
              </td>
              <td class="text-right font-mono text-muted {projector ? 'text-[22px] leading-7' : phone ? 'text-[13px] leading-4' : 'text-[14px] leading-[18px]'}">
                {row.penalty}
              </td>
            {:else}
              <td class="text-right font-mono font-bold text-ink {projector ? 'text-[34px] leading-10' : phone ? 'text-[16px] leading-5' : 'text-[20px] leading-6'}">
                {row.score}
              </td>
            {/if}
          </tr>
        {/each}

        {#if hidden > 0 && !projector}
          <!-- «7–34 · Показать ещё 28 участников»: the rest of the table, a press away (K3). -->
          <tr class="h-11 border-b border-line">
            <td class="font-mono text-[13px] leading-[18px] text-faint {phone ? 'sticky left-0 bg-canvas' : ''}">
              {visible.length + 1}–{standings.rows.length}
            </td>
            <td colspan={standings.problems.length + (phone ? 0 : 1) + (icpc ? 2 : 1)}>
              <button class="text-ui text-accent-text hover:underline" type="button" onclick={() => (extra += MORE)}>
                {tr('contests.p.showMoreRows', { count: hidden })}
              </button>
            </td>
          </tr>
        {/if}

        {#if !projector && standings.rows.length > 0}
          <tr class="border-b-2 border-ink">
            {#if !phone}<td></td>{/if}
            <th scope="row" class="py-3 text-left align-middle {label} {phone ? 'sticky left-0 bg-canvas' : ''}">
              {tr('contests.p.totals')}
            </th>
            {#each standings.problems as problem, index (problem.id)}
              {@const pair = totalsPair(standings.totals[index])}
              <td class="py-3 text-center font-mono text-[13px] leading-[18px] text-ink">
                <span class="sr-only">{tr('contests.p.totalsCell', { solved: pair.solved, attempts: pair.attempts })}</span>
                <span aria-hidden="true"><span class="font-bold">{pair.solved}</span><span class="text-faint">{` / ${pair.attempts}`}</span></span>
              </td>
            {/each}
            <td colspan={icpc ? 2 : 1}></td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>

  {#if projector && hidden > 0}
    <p class="pt-4 text-[18px] leading-6 text-muted">{tr('contests.p.moreBelow', { count: hidden })}</p>
  {/if}

  {#if legend && !projector}
    <ul class="flex flex-wrap items-center gap-x-7 gap-y-2 pt-[18px]">
      {#if icpc}
        <li class="flex items-center gap-2 text-2xs text-muted">
          <span class="size-3.5 shrink-0 bg-positive" aria-hidden="true"></span>{tr('contests.p.legendFirst')}
        </li>
        <li class="flex items-center gap-2 text-2xs text-muted">
          <span class="size-3.5 shrink-0 bg-positive/10 dark:bg-positive/15" aria-hidden="true"></span>{tr('contests.p.legendSolved')}
        </li>
        <li class="flex items-center gap-2 text-2xs text-muted">
          <span class="size-3.5 shrink-0 bg-danger/10 dark:bg-danger/15" aria-hidden="true"></span>{tr('contests.p.legendFailed')}
        </li>
      {:else}
        <li class="flex items-center gap-2 text-2xs text-muted">
          <span class="size-3.5 shrink-0 bg-positive" aria-hidden="true"></span>{tr('contests.p.legendFull')}
        </li>
        <li class="flex items-center gap-2 text-2xs text-muted">
          <span class="relative size-3.5 shrink-0 bg-positive/10 dark:bg-positive/15" aria-hidden="true">
            <span class="absolute bottom-0 left-0 h-[3px] w-2/3 bg-positive"></span>
          </span>{tr('contests.p.legendPartial')}
        </li>
        <li class="flex items-center gap-2 text-2xs text-muted">
          <span class="size-3.5 shrink-0 bg-danger/10 dark:bg-danger/15" aria-hidden="true"></span>{tr('contests.p.legendZero')}
        </li>
      {/if}
      {#if standings.frozen}
        <li class="flex items-center gap-2 text-2xs text-muted">
          <span class="size-3.5 shrink-0 bg-raised" aria-hidden="true"></span>{tr('contests.p.legendFrozen')}
        </li>
      {/if}
    </ul>
    <p class="pt-2.5 text-2xs leading-5 text-muted">
      {icpc ? tr('contests.p.tieIcpc', { penalty: standings.penaltyMinutes }) : tr('contests.p.tieIoi')}
    </p>
  {/if}
</div>
