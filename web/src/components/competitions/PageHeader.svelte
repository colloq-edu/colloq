<script lang="ts">
  /**
   * Шапка страницы соревнования: кто это, сколько осталось, где я — и вкладки.
   *
   * Одна на все три вкладки и на обе раскладки, потому что это одна страница:
   * переход «Задача → Посылки → Лидерборд» не должен перерисовывать название и
   * сбрасывать таймер, а телефон отличается от десктопа не составом, а тем,
   * ЧТО в него помещается — три показателя в ряд вместо двух крупных справа и
   * короткие имена вкладок («Задача» вместо «Задача и данные»).
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
    /** Счётчик во вкладке — только пока соревнование идёт и только на десктопе. */
    submissions: number | null
    place: number | null
    total: number
    /** Итоговое место и сдвиг: появляются вместе с приватным лидербордом. */
    finalPlace: number | null
    shift: number | null
    /** Лучший публичный результат человека — третий показатель на телефоне. */
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
   * «Кончилось» — это закрытый приём, а не состояние строки в базе.
   *
   * Прошедший дедлайн НЕ переводит соревнование в `finished`: состояние меняет
   * преподаватель кнопкой «Завершить сейчас», а он в это время на разборе и до
   * неё не дошёл. Но приём уже закрыт, итоги уже открылись сами, и страница
   * при этом показывала плашку «ИДЁТ» рядом с таймером «00:00» — единственное,
   * что на ней врало. Макет P3 («лидерборд после дедлайна») рисует здесь
   * «ЗАВЕРШЕНО», и берётся оно отсюда. `accepting` приезжает с сервера тем же
   * `submissionsOpen`, которым дверь отказывает в посылке, — два ответа на один
   * вопрос разошлись бы ровно в ту минуту, когда это заметит весь класс.
   */
  const over = $derived(view.accepting === 'closed')
  /** Приём идёт: счётчик во вкладке и часы имеют смысл только тогда. */
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
        <!-- Плашка состояния на телефоне живёт здесь, а не над названием: в
             макете P4 соревнование идёт, и говорить об этом нечего, а вот
             «ЗАВЕРШЕНО» сказать обязательно — иначе закрытый приём выглядит
             как сломанная кнопка. -->
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
