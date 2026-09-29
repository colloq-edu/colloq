<script lang="ts">
  /**
   * The leaderboard — P3.
   *
   * Two tables behind one switch, not two pages: the question people come
   * here with after the deadline is "how far did I slide", and its answer is
   * the difference in places, that is, both tables at once. While the final
   * results are closed, there is no switch at all: showing a disabled
   * "Final" button would promise a number that does not exist yet.
   *
   * The baseline solution stands at the bottom, set off by a dashed line: it
   * is not an entrant, but not a footnote either — it is what people measure
   * against to see whether submitting makes sense at all.
   *
   * There is no "submission that counts" column: "#12 · latest submission"
   * next to every name told the class nothing it could act on and took a
   * quarter of the table (removed on 29 Sep 2026 at the teacher's request).
   * Which submission counts is the rule in the task, and each person sees
   * their own in "My submissions".
   */
  import { tr } from '@shared/i18n'
  import { placeShift } from '@shared/competitions'
  import type { CompetitionPublic } from '@shared/competitions'
  import type { EntrantBoardLine, EntrantLeaderboard } from '@shared/competitions-entrant'
  import { avatarLetter, avatarTint, boardPlaces, formatScore, ordinalPlace } from '@/lib/competition-words'

  interface Props {
    competition: CompetitionPublic
    board: EntrantLeaderboard
    phone: boolean
    /** The final table is selected; always false while the results are closed. */
    final: boolean
    onfinal: (value: boolean) => void
  }

  const { competition, board, phone, final, onfinal }: Props = $props()

  const PAGE = 6
  /** How many more rows appear each time the reader nears the end. */
  const MORE = 20
  let shown = $state(PAGE)
  const canWatch = typeof IntersectionObserver === 'function'

  /**
   * The box that actually scrolls. Both places that show the board scroll
   * inside their own `overflow-auto` container, not the window, and an
   * observer without that root measures its margin against the window: the
   * list would grow only once the sentinel is already on screen. The
   * notebook's jumping scroll (13 Sep 2026) had exactly this cause.
   */
  function scrollParent(node: HTMLElement): HTMLElement | null {
    for (let el = node.parentElement; el; el = el.parentElement) {
      const { overflowY } = getComputedStyle(el)
      if (overflowY === 'auto' || overflowY === 'scroll') return el
    }
    return null
  }

  /**
   * Kaggle-style: the list grows by itself as the reader scrolls towards its
   * end, instead of a "show more" button after every six names. The sentinel
   * is recreated on every growth ({#key} below), so a list still too short to
   * fill the screen keeps growing until the sentinel is out of reach: an
   * observer reports only changes, and "still visible" is not one.
   */
  function revealOnScroll(node: HTMLElement) {
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) shown += MORE
      },
      { root: scrollParent(node), rootMargin: '0px 0px 480px 0px' },
    )
    watcher.observe(node)
    return { destroy: () => watcher.disconnect() }
  }

  const open = $derived(board.privateOpen && board.private !== null)
  const lines = $derived(boardPlaces(final && board.private ? board.private : board.public))
  const people = $derived(lines.filter((line) => !line.baseline))
  const baseline = $derived(lines.find((line) => line.baseline) ?? null)
  /** The place in the public table — the second column and the shift's base. */
  const publicPlace = $derived(
    new Map(boardPlaces(board.public).map((line) => [line.entrantId, line] as const)),
  )

  function shiftOf(line: EntrantBoardLine): number | null {
    if (!final) return null
    return placeShift(publicPlace.get(line.entrantId)?.place ?? null, line.place)
  }
</script>

<div class="flex flex-col gap-5">
  <div class="flex flex-col justify-between gap-4 lg:flex-row lg:gap-8">
    {#if open}
      <div class="flex shrink-0 self-start border border-line">
        <button
          class="px-4 py-[9px] text-2xs {final ? 'text-muted' : 'bg-brand font-bold text-white'}"
          type="button"
          onclick={() => onfinal(false)}
        >
          {tr('competitions.p.segmentPublic', { percent: competition.publicPercent })}
        </button>
        <button
          class="px-4 py-[9px] text-2xs {final ? 'bg-brand font-bold text-white' : 'text-muted'}"
          type="button"
          onclick={() => onfinal(true)}
        >
          {tr('competitions.p.segmentFinal', { percent: 100 - competition.publicPercent })}
        </button>
      </div>
    {/if}
    <div class="flex max-w-[640px] flex-col gap-1">
      <p class="text-ui leading-5 text-muted">
        {tr(final ? 'competitions.p.finalNote' : 'competitions.p.publicNote')}
      </p>
      <!-- Intake is over, but the final table waits for the queue: saying so
           beats a closed board that looks forgotten. -->
      {#if !open && (board.privatePending ?? 0) > 0}
        <p class="text-ui leading-5 text-warning" role="status">
          {tr('competitions.p.resultsCounting', { count: board.privatePending ?? 0 })}
        </p>
      {/if}
    </div>
  </div>

  {#if people.length === 0 && baseline === null}
    <p class="border-t border-line py-6 text-ui text-muted">{tr('competitions.p.boardEmpty')}</p>
  {:else if phone}
    <!-- Phone: the same rows without the "shift" column — at 390 px it pushes
         out the name the table is opened for. -->
    <div class="flex flex-col border-t-2 border-ink">
      {#each people.slice(0, shown) as line (line.entrantId)}
        <div
          class="flex items-center gap-3 border-b border-line py-3 {line.you ? 'bg-raised' : ''}"
        >
          <span class="w-8 shrink-0 font-mono text-title font-bold leading-6 text-ink">
            {line.place}
          </span>
          <span
            class="flex size-7 shrink-0 items-center justify-center rounded-full text-micro font-bold text-[#7A4A12]"
            style="background: {avatarTint(line.name)}"
            aria-hidden="true">{avatarLetter(line.name)}</span
          >
          <span class="min-w-0 grow truncate text-2xs font-bold text-ink">{line.name}</span>
          <span class="shrink-0 font-mono text-ui font-bold text-ink">{formatScore(line.score)}</span>
        </div>
      {/each}
      {#if baseline}
        <div class="flex items-center gap-3 border-b border-line border-t border-dashed border-t-brand-2 py-3">
          <span class="w-8 shrink-0 font-mono text-ui text-muted">{baseline.place ?? '—'}</span>
          <span class="size-7 shrink-0 border border-dashed border-brand-2" aria-hidden="true"></span>
          <span class="min-w-0 grow text-2xs text-muted">{tr('competitions.p.baselineRow')}</span>
          <span class="shrink-0 font-mono text-ui text-muted">{formatScore(baseline.score)}</span>
        </div>
      {/if}
    </div>
  {:else}
    <div class="w-full overflow-x-auto">
      <table class="w-full min-w-[650px] border-collapse text-left">
        <thead>
          <tr class="border-b-2 border-ink">
            <th class="w-16 py-3 text-micro font-black uppercase leading-5 tracking-label text-muted">
              {tr('competitions.p.colPlace')}
            </th>
            <th class="w-20 text-micro font-black uppercase leading-5 tracking-label text-muted">
              {final ? tr('competitions.p.colShift') : ''}
            </th>
            <th class="text-micro font-black uppercase leading-5 tracking-label text-muted">
              {tr('competitions.p.colEntrant')}
            </th>
            <th
              class="w-[140px] text-right text-micro font-black uppercase leading-5 tracking-[0.06em] text-ink"
            >
              {tr(final ? 'competitions.p.colFinalMetric' : 'competitions.p.colPublicMetric', {
                metric: competition.metric.name,
              })}
            </th>
            {#if final}
              <th
                class="w-[140px] text-right text-micro font-black uppercase leading-5 tracking-[0.06em] text-muted"
              >
                {tr('competitions.p.colPublicMetric', { metric: competition.metric.name })}
              </th>
            {/if}
            <th class="w-[110px] text-right text-micro font-black uppercase leading-5 tracking-label text-muted">
              {tr('competitions.p.colSubmissions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {#each people.slice(0, shown) as line (line.entrantId)}
            {@const shift = shiftOf(line)}
            <tr class="h-14 border-b border-line {line.you ? 'bg-raised' : ''}">
              <td class="font-mono text-[22px] font-bold leading-7 text-ink">{line.place}</td>
              <td class="font-mono text-2xs font-bold">
                {#if shift === null}
                  <span class="text-faint"></span>
                {:else if shift > 0}
                  <span class="text-positive">▲ {shift}</span>
                {:else if shift < 0}
                  <span class="text-danger">▼ {Math.abs(shift)}</span>
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </td>
              <td>
                <span class="flex min-w-0 items-center gap-3">
                  <span
                    class="flex size-7 shrink-0 items-center justify-center rounded-full text-micro font-bold text-[#7A4A12]"
                    style="background: {avatarTint(line.name)}"
                    aria-hidden="true">{avatarLetter(line.name)}</span
                  >
                  <span class="min-w-0 truncate text-ui-lg font-bold text-ink">{line.name}</span>
                  {#if line.you}
                    <span
                      class="shrink-0 bg-brand px-2 py-[3px] text-micro font-black uppercase leading-5 tracking-label text-white"
                    >
                      {tr('competitions.p.you')}
                    </span>
                  {/if}
                </span>
              </td>
              <td class="text-right font-mono text-title font-bold text-ink">
                {formatScore(line.score)}
              </td>
              {#if final}
                <td class="text-right font-mono text-2xs text-muted">
                  {#if publicPlace.get(line.entrantId)}
                    {formatScore(publicPlace.get(line.entrantId)!.score)} · {ordinalPlace(
                      publicPlace.get(line.entrantId)!.place,
                    )}
                  {:else}
                    —
                  {/if}
                </td>
              {/if}
              <td class="text-right font-mono text-2xs text-muted">{line.submissions}</td>
            </tr>
          {/each}



          {#if baseline}
            <tr class="h-12 border-b border-line border-t border-dashed border-t-brand-2">
              <td class="font-mono text-ui-lg text-muted">{baseline.place ?? '—'}</td>
              <td class="text-muted">—</td>
              <td>
                <span class="flex items-center gap-3">
                  <span
                    class="size-7 shrink-0 border border-dashed border-brand-2"
                    aria-hidden="true"
                  ></span>
                  <span class="text-ui text-muted">{tr('competitions.p.baselineRow')}</span>
                </span>
              </td>
              <td class="text-right font-mono text-ui text-muted">{formatScore(baseline.score)}</td>
              {#if final}
                <td class="text-right font-mono text-2xs text-muted">
                  {formatScore(publicPlace.get(baseline.entrantId)?.score ?? null)}
                </td>
              {/if}
              <td></td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}

  {#if people.length > shown}
    {#if canWatch}
      {#key shown}
        <div class="h-px w-full" aria-hidden="true" use:revealOnScroll></div>
      {/key}
    {:else}
      <button class="self-start text-2xs text-accent-text hover:underline" type="button" onclick={() => (shown += MORE)}>
        {tr('competitions.p.showMoreEntrants', { count: people.length - shown })}
      </button>
    {/if}
  {/if}

  <p class="text-2xs leading-5 text-muted">{tr('competitions.p.tieNote')}</p>
</div>
