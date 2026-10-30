<!--
  The contests on the `/k` list: one section under the competitions, one row
  per contest — its phase, its name (a link to `/a/<slug>`), the line about
  it, and where the person stands in it.

  On `/k`, not on a page of its own: a student has one address for
  everything the course runs against a clock, and the participant behind
  both is the same person with the same key (docs/architecture/contests.md ·
  §0). The section is drawn only when there is a contest to show — an empty
  heading under the competitions would only make the list longer.

  Ordered by what can be done now: running first, then the ones about to
  start (soonest first), then the finished (latest first). The phase is the
  shared rule (contestPhase), the same one the contest's own header uses.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { contestPhase, type ContestPhase } from '@shared/contests'
  import type { EntrantContestRow } from '@shared/contests-entrant'
  import Badge from '@/components/competitions/Badge.svelte'
  import { clockOf, dateOf, remainingWords } from '@/lib/competition-words'
  import { contestMeta, phaseBadge } from '@/lib/contest-words'
  import { contestRoutePath } from '@/lib/routes'

  interface Props {
    rows: EntrantContestRow[]
    now: number
    onopen: (path: string) => void
  }

  const { rows, now, onopen }: Props = $props()

  const RANK: Record<ContestPhase, number> = { open: 0, soon: 1, over: 2, draft: 3 }

  const ordered = $derived(
    [...rows].sort((a, b) => {
      const pa = contestPhase(a.contest, now)
      const pb = contestPhase(b.contest, now)
      if (pa !== pb) return RANK[pa] - RANK[pb]
      if (pa === 'soon') return (a.contest.startsAt ?? 0) - (b.contest.startsAt ?? 0)
      return (b.contest.endsAt ?? b.contest.updatedAt) - (a.contest.endsAt ?? a.contest.updatedAt)
    }),
  )

  /** «ДО КОНЦА · 1 ч 12 мин», «ДО НАЧАЛА · 2 дн 4 ч», «ЗАВЕРШЁН · 30.10, 16:00»: a label over the number. */
  function timing(row: EntrantContestRow): { label: string; value: string } | null {
    const phase = contestPhase(row.contest, now)
    if (phase === 'open' && row.contest.endsAt !== null) {
      return { label: tr('contests.p.toEnd'), value: remainingWords(row.contest.endsAt - now) }
    }
    if (phase === 'soon' && row.contest.startsAt !== null) {
      return { label: tr('contests.p.toStart'), value: remainingWords(row.contest.startsAt - now) }
    }
    if (phase === 'over' && row.contest.endsAt !== null) {
      return { label: tr('contests.p.endedLabel'), value: `${dateOf(row.contest.endsAt)}, ${clockOf(row.contest.endsAt)}` }
    }
    return null
  }

  /** «решено 3 из 6 · место 5», «245 баллов · место 2». */
  function standing(row: EntrantContestRow): string {
    const mine = row.mine
    if (!mine?.joined) return tr('contests.p.listNotJoined')
    const result = row.contest.rules === 'ioi'
      ? tr('contests.p.points', { count: mine.score })
      : tr('contests.p.listSolved', { value: mine.solved, total: row.problems })
    return mine.place === null ? result : `${result} · ${tr('contests.p.listPlace', { place: mine.place })}`
  }

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    onopen(path)
  }
</script>

{#if ordered.length > 0}
  <section class="flex flex-col" aria-labelledby="contests-list-title">
    <h2
      id="contests-list-title"
      class="flex items-baseline gap-2.5 border-b-2 border-ink pb-2.5 text-micro font-black uppercase leading-5 tracking-section text-ink"
    >
      {tr('contests.p.listTitle')}
      <span class="font-mono text-2xs font-normal tracking-normal text-muted">{ordered.length}</span>
    </h2>
    {#each ordered as row (row.contest.id)}
      {@const phase = contestPhase(row.contest, now)}
      {@const badge = phaseBadge(phase)}
      {@const path = contestRoutePath({ slug: row.contest.slug, view: 'problems', letter: null })}
      {@const time = timing(row)}
      <article class="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-line py-5" data-contest={row.contest.slug}>
        <div class="flex min-w-0 flex-[1_1_320px] flex-col gap-1.5">
          <div class="flex flex-wrap items-center gap-2.5">
            <Badge word={badge.word} tone={badge.tone} form={badge.form} />
            <span class="text-micro text-muted">
              {contestMeta({ rules: row.contest.rules, problems: row.problems, entrants: row.entrants, penaltyMinutes: row.contest.penaltyMinutes })}
            </span>
          </div>
          <h3 class="{phase === 'over' ? 'text-title font-bold leading-[22px]' : 'text-head font-black'} text-ink">
            <a class="break-words underline-offset-4 hover:text-accent-text hover:underline" href={path} onclick={(event) => go(event, path)}>
              {row.contest.title}
            </a>
          </h3>
          {#if row.contest.blurb}
            <p class="text-ui text-muted">{row.contest.blurb}</p>
          {/if}
        </div>
        <div class="flex min-w-[170px] flex-col gap-0.5">
          {#if time}
            <span class="text-micro font-black uppercase leading-5 tracking-label text-muted">{time.label}</span>
            <span class="font-mono text-title font-bold text-ink">{time.value}</span>
          {/if}
          <span class="text-micro {row.mine?.joined ? 'text-ink' : 'text-muted'}">{standing(row)}</span>
        </div>
        <a
          class="min-h-11 shrink-0 whitespace-nowrap border border-primary px-5 py-2.5 text-micro font-bold uppercase tracking-caps text-primary no-underline hover:bg-surface sm:ml-auto"
          href={path}
          onclick={(event) => go(event, path)}
        >
          {tr('contests.p.listOpen')}
        </a>
      </article>
    {/each}
  </section>
{/if}
