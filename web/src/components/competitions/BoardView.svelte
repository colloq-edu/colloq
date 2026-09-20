<script lang="ts">
  /**
   * Лидерборд — P3.
   *
   * Две таблицы за одним переключателем, а не две страницы: вопрос, ради
   * которого сюда приходят после дедлайна, звучит «как я съехал», и ответ на
   * него — разница мест, то есть обе таблицы сразу. Пока итоги закрыты,
   * переключателя нет вовсе: показывать выключенную кнопку «Итоговый» значит
   * обещать число, которого ещё не существует.
   *
   * Базовое решение стоит внизу и отбито пунктиром: это не участник, но и не
   * сноска — по нему меряют, имеет ли смысл вообще сдавать.
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
    /** Итоговая таблица выбрана; пока итоги закрыты — всегда false. */
    final: boolean
    onfinal: (value: boolean) => void
  }

  const { competition, board, phone, final, onfinal }: Props = $props()

  const PAGE = 6
  let shown = $state(PAGE)

  const open = $derived(board.privateOpen && board.private !== null)
  const lines = $derived(boardPlaces(final && board.private ? board.private : board.public))
  const people = $derived(lines.filter((line) => !line.baseline))
  const baseline = $derived(lines.find((line) => line.baseline) ?? null)
  /** Место в публичной таблице — вторая колонка и то, из чего считается сдвиг. */
  const publicPlace = $derived(
    new Map(boardPlaces(board.public).map((line) => [line.entrantId, line] as const)),
  )

  function shiftOf(line: EntrantBoardLine): number | null {
    if (!final) return null
    return placeShift(publicPlace.get(line.entrantId)?.place ?? null, line.place)
  }

  function countedWords(line: EntrantBoardLine): string {
    if (line.number === 0) return ''
    if (line.chosen) {
      return tr(line.you ? 'competitions.p.countedYours' : 'competitions.p.countedChosen', {
        number: line.number,
      })
    }
    return tr('competitions.p.countedBest', { number: line.number })
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
    <p class="max-w-[640px] text-ui leading-5 text-muted">
      {tr(final ? 'competitions.p.finalNote' : 'competitions.p.publicNote')}
    </p>
  </div>

  {#if people.length === 0}
    <p class="border-t border-line py-6 text-ui text-muted">{tr('competitions.p.boardEmpty')}</p>
  {:else if phone}
    <!-- Телефон: те же строки без колонок «сдвиг» и «в зачёт» — в 390 px они
         вытесняют имя, ради которого таблицу и открывают. -->
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
    </div>
  {:else}
    <div class="w-full overflow-x-auto">
      <table class="w-full min-w-[900px] border-collapse text-left">
        <thead>
          <tr class="border-b-2 border-ink">
            <th class="w-16 py-3 text-[11px] font-black uppercase leading-[14px] tracking-label text-muted">
              {tr('competitions.p.colPlace')}
            </th>
            <th class="w-20 text-[11px] font-black uppercase leading-[14px] tracking-label text-muted">
              {final ? tr('competitions.p.colShift') : ''}
            </th>
            <th class="text-[11px] font-black uppercase leading-[14px] tracking-label text-muted">
              {tr('competitions.p.colEntrant')}
            </th>
            <th
              class="w-[140px] text-right text-[11px] font-black uppercase leading-[14px] tracking-[0.06em] text-ink"
            >
              {tr(final ? 'competitions.p.colFinalMetric' : 'competitions.p.colPublicMetric', {
                metric: competition.metric.name,
              })}
            </th>
            {#if final}
              <th
                class="w-[140px] text-right text-[11px] font-black uppercase leading-[14px] tracking-[0.06em] text-muted"
              >
                {tr('competitions.p.colPublicMetric', { metric: competition.metric.name })}
              </th>
            {/if}
            <th class="w-[110px] text-right text-[11px] font-black uppercase leading-[14px] tracking-label text-muted">
              {tr('competitions.p.colSubmissions')}
            </th>
            <th class="w-[250px] pl-10 text-[11px] font-black uppercase leading-[14px] tracking-label text-muted">
              {tr('competitions.p.colCounted')}
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
                      class="shrink-0 bg-brand px-2 py-[3px] text-[11px] font-black uppercase leading-[14px] tracking-label text-white"
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
              <td class="pl-10 text-2xs text-muted">{countedWords(line)}</td>
            </tr>
          {/each}

          {#if people.length > shown}
            <tr class="h-9 border-b border-line">
              <td class="font-mono text-micro text-faint">
                {shown + 1}–{people.length}
              </td>
              <td></td>
              <td colspan="5">
                <button
                  class="text-micro text-accent-text hover:underline"
                  type="button"
                  onclick={() => (shown = people.length)}
                >
                  {tr('competitions.p.showMoreEntrants', { count: people.length - shown })}
                </button>
              </td>
            </tr>
          {/if}

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
              <td></td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}

  <p class="text-2xs leading-5 text-muted">{tr('competitions.p.tieNote')}</p>
</div>
