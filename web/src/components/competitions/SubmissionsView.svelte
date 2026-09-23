<script lang="ts">
  /**
   * Вкладка «Посылки» — P2 на десктопе, P4 на телефоне.
   *
   * Тремя блоками: чем отправить, что уже отправлено, и в каких условиях это
   * исполняется. Условия стоят СБОКУ, а не под списком, потому что читают их
   * ровно один раз — перед первой посылкой, — а список обновляется каждые
   * несколько секунд; поменяй их местами, и человек будет пролистывать
   * неизменную таблицу, чтобы посмотреть на свой таймер.
   */
  import { tr } from '@shared/i18n'
  import { countedSubmission, compareScores, type EntrantSubmission } from '@shared/competitions'
  import type {
    EntrantBoardLine,
    EntrantCompetitionView,
    EntrantSubmissions,
  } from '@shared/competitions-entrant'
  import Conditions from './Conditions.svelte'
  import MiniBoard from './MiniBoard.svelte'
  import SendBox from './SendBox.svelte'
  import SubmissionCard from './SubmissionCard.svelte'
  import SubmissionRow from './SubmissionRow.svelte'

  interface Props {
    view: EntrantCompetitionView
    mine: EntrantSubmissions
    board: EntrantBoardLine[]
    phone: boolean
    now: number
    sending: boolean
    busy: boolean
    refusal: string | null
    notebookUrl: (id: string) => string
    onsend: (file: File, bundleId?: string | null) => Promise<boolean>
    onrefuse: (message: string) => void
    oncancel: (id: string) => void
    onchoose: (id: string) => void
    onboard: () => void
    onjoin: () => void
  }

  const {
    view,
    mine,
    board,
    phone,
    now,
    sending,
    busy,
    refusal,
    notebookUrl,
    onsend,
    onrefuse,
    oncancel,
    onchoose,
    onboard,
    onjoin,
  }: Props = $props()

  /** Первая страница — семь строк, как в макете; остальное по кнопке. */
  const PAGE = 7
  let shown = $state(PAGE)

  const rows = $derived(
    [...mine.submissions].sort((a, b) => b.acceptedAt - a.acceptedAt || b.number - a.number),
  )
  const liveFor = (id: string) => mine.live.find((row) => row.submissionId === id) ?? null
  /*
   * Выбор зачётной посылки замерзает вместе с приёмом.
   *
   * Итоги открываются на дедлайне, и в «моих посылках» становится видно
   * приватное число каждой строки: кнопка, оставленная после этого, — прямая
   * подгонка под скрытую часть. Дверь отказывает (routes/competitions.ts ·
   * choose), а кнопка обязана исчезнуть раньше отказа — предлагать действие,
   * которое сервер не выполнит, хуже, чем не предлагать его вовсе.
   */
  const canChoose = $derived(view.competition.scoring === 'chosen')
  const counted = $derived(countedSubmission(view.competition.scoring, mine.submissions.map((s) => ({ ...s, privateScore: s.privateScore ?? null })), view.competition.metric.direction)?.id ?? null)
  const frozen = $derived(mine.accepting !== 'open')
  const limitMs = $derived(view.competition.limits.wallSeconds * 1000)

  /**
   * Лучшая своя посылка — та, что пойдёт в зачёт без выбора.
   *
   * Считается тем же сравнением, что и лидерборд (`compareScores`): «лучший
   * результат» под именем файла и место в таблице обязаны называть одну и ту
   * же строку, иначе человек выбирает в зачёт не то, что ему обещано.
   */
  const best = $derived.by(() => {
    const scored = mine.submissions.filter(
      (submission): submission is EntrantSubmission =>
        submission.state === 'scored' && submission.publicScore !== null,
    )
    if (scored.length === 0) return null
    return scored.reduce((winner, next) =>
      compareScores(
        { score: next.publicScore!, at: next.acceptedAt },
        { score: winner.publicScore!, at: winner.acceptedAt },
        view.competition.metric.direction,
      ) < 0
        ? next
        : winner,
    ).id
  })
</script>

<!--
  Правая колонка уезжает под список раньше, чем кончается место: при 1024 px
  (ноутбук в половину экрана) пять колонок строки и 300 px условий оставляют
  имени файла сотню пикселей, и `lgbm_lags_v4_holidays.ipynb` превращается в
  «lgbm_lags_v...». Столбиком читается всё.
-->
<div class="flex flex-col gap-6 xl:flex-row xl:gap-12">
  <div class="flex min-w-0 grow flex-col gap-4 sm:gap-7">
    {#if mine.joined || mine.submissions.length > 0}
      <SendBox {view} {mine} {phone} busy={sending} {refusal} {onsend} {onrefuse} />
    {:else}
      <div class="flex flex-col items-start gap-3 border border-line bg-surface p-4">
        <p class="text-ui text-muted">{tr('competitions.p.joinFirst')}</p>
        <button
          class="h-[38px] bg-brand px-4 text-micro font-black uppercase tracking-label text-white"
          type="button"
          onclick={onjoin}
        >
          {tr('competitions.p.join')}
        </button>
      </div>
    {/if}

    {#if mine.paused && mine.inFlight > 0}
      <p class="text-2xs text-warning">{tr('competitions.p.queuePaused')}</p>
    {/if}

    <section class="flex flex-col">
      <header
        class="flex items-start justify-between gap-5 border-b-2 border-ink pb-3.5"
      >
        <h2 class="text-[20px] font-black leading-6 tracking-[-0.01em] text-ink">
          {tr('competitions.p.mine')}
        </h2>
        {#if !phone && canChoose && !frozen}
          <p class="whitespace-pre-line text-right text-2xs leading-[18px] text-muted">
            {tr('competitions.p.chooseHint')}
          </p>
        {/if}
      </header>

      {#if rows.length === 0}
        <p class="py-6 text-ui text-muted">{tr('competitions.p.noSubmissions')}</p>
      {/if}

      {#each rows.slice(0, shown) as submission (submission.id)}
        {#if phone}
          <SubmissionCard
            {submission}
            dependenciesSlug={view.competition.slug}
            live={liveFor(submission.id)}
            best={submission.id === best}
            counted={submission.id === counted}
            {canChoose}
            paused={mine.paused}
            {now}
            {busy}
            {limitMs}
            notebookUrl={notebookUrl(submission.id)}
            {frozen}
            {oncancel}
            {onchoose}
          />
        {:else}
          <SubmissionRow
            {submission}
            dependenciesSlug={view.competition.slug}
            live={liveFor(submission.id)}
            best={submission.id === best}
            counted={submission.id === counted}
            {canChoose}
            paused={mine.paused}
            {now}
            {busy}
            {limitMs}
            notebookUrl={notebookUrl(submission.id)}
            {frozen}
            {oncancel}
            {onchoose}
          />
        {/if}
      {/each}

      {#if rows.length > shown}
        <div class="pt-3.5 sm:pl-12">
          <button
            class="text-2xs text-accent-text hover:underline"
            type="button"
            onclick={() => (shown += PAGE)}
          >
            {tr('competitions.p.showMore', { count: rows.length - shown })}
          </button>
        </div>
      {/if}
    </section>
  </div>

  <aside class="flex w-full shrink-0 flex-col gap-6 xl:w-[300px]">
    <Conditions competition={view.competition} />
    {#if !phone}
      <MiniBoard lines={board} onopen={onboard} />
    {/if}
  </aside>
</div>
