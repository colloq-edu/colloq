<script lang="ts">
  /**
   * The mini leaderboard in the right column of P2: the top three, your own
   * row, the baseline.
   *
   * Not the first six rows of the table but a SELECTION: a person in seventh
   * place needs the three at the top (what to reach for), themselves, and
   * the baseline solution (which it is embarrassing to fall below).
   * Everything in between is folded into "· · ·" — the only row of the table
   * that means nothing.
   */
  import { tr } from '@shared/i18n'
  import type { EntrantBoardLine } from '@shared/competitions-entrant'
  import { boardPlaces, formatScore } from '@/lib/competition-words'

  interface Props {
    lines: EntrantBoardLine[]
    onopen: () => void
  }

  const { lines, onopen }: Props = $props()

  const TOP = 3
  const ranked = $derived(boardPlaces(lines))
  const shown = $derived.by(() => {
    const people = ranked.filter((line) => !line.baseline)
    const top = people.slice(0, TOP)
    const me = people.find((line) => line.you)
    const baseline = ranked.find((line) => line.baseline)
    const out: { line: EntrantBoardLine & { place: number | null }; gap: boolean }[] = top.map(
      (line) => ({ line, gap: false }),
    )
    if (me && !top.includes(me)) out.push({ line: me, gap: (me.place ?? 0) > TOP + 1 })
    if (baseline) out.push({ line: baseline, gap: !me && people.length > TOP })
    return out
  })
</script>

<section class="flex flex-col gap-2.5">
  <div class="flex items-baseline justify-between gap-2">
    <h2 class="text-micro font-black uppercase leading-5 tracking-label text-muted">
      {tr('competitions.p.publicBoard')}
    </h2>
    <button class="text-micro text-accent-text hover:underline" type="button" onclick={onopen}>
      {tr('competitions.p.openBoard')}
    </button>
  </div>
  {#if shown.length === 0}
    <p class="text-2xs text-muted">{tr('competitions.p.boardEmpty')}</p>
  {:else}
    <div class="flex flex-col border-t border-line">
      {#each shown as row (row.line.entrantId)}
        {#if row.gap}
          <div class="flex items-center gap-2.5 py-1.5">
            <span class="w-5 shrink-0"></span>
            <span class="text-micro text-faint">· · ·</span>
          </div>
        {/if}
        <div
          class="flex items-center gap-2.5 {row.line.you
            ? 'bg-raised p-2 font-bold'
            : 'border-b border-line py-2'}"
        >
          <span
            class="w-5 shrink-0 font-mono text-micro leading-4 {row.line.you
              ? 'text-ink'
              : 'text-muted'}"
          >
            {row.line.place ?? '—'}
          </span>
          <span
            class="min-w-0 grow truncate text-2xs leading-4 {row.line.baseline
              ? 'text-muted'
              : 'text-ink'}"
          >
            {row.line.you
              ? tr('competitions.p.youRow')
              : row.line.baseline
                ? tr('competitions.p.baselineRow')
                : row.line.name}
          </span>
          <span
            class="shrink-0 font-mono text-micro leading-4 {row.line.baseline
              ? 'text-muted'
              : 'text-ink'}"
          >
            {formatScore(row.line.score)}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</section>
