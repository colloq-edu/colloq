<script lang="ts">
  /**
   * The "Submissions" tab — P2 on a desktop, P4 on a phone.
   *
   * In three blocks: what to send with, what has already been sent, and
   * under what conditions it runs. The conditions stand to the SIDE, not
   * under the list, because they are read exactly once — before the first
   * submission — while the list refreshes every few seconds; swap them and a
   * person would be scrolling past an unchanging table to look at their
   * timer.
   */
  import { tr } from '@shared/i18n'
  import { countedSubmission, compareScores, type EntrantSubmission } from '@shared/competitions'
  import type {
    EntrantBoardLine,
    EntrantCompetitionView,
    EntrantSubmissions,
    SubmissionAccepted,
  } from '@shared/competitions-entrant'
  import { outsideQuota, ownOrdinals } from '@/lib/competition-words'
  import Conditions from './Conditions.svelte'
  import MiniBoard from './MiniBoard.svelte'
  import SendBox from './SendBox.svelte'
  import SubmissionCard from './SubmissionCard.svelte'
  import SubmissionRow from './SubmissionRow.svelte'

  interface Props {
    view: EntrantCompetitionView
    mine: EntrantSubmissions
    board: EntrantBoardLine[]
    /** The board is open to entrants only, and this visitor is not one. */
    boardClosed?: boolean
    phone: boolean
    now: number
    sending: boolean
    busy: boolean
    refusal: string | null
    notebookUrl: (id: string) => string
    /** Resolves to the server's answer once the notebook is in, or null when it was refused. */
    onsend: (file: File, bundleId?: string | null) => Promise<SubmissionAccepted | null>
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
    boardClosed = false,
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

  /** The first page is seven rows, as in the mockup; the rest behind a button. */
  const PAGE = 7
  let shown = $state(PAGE)

  const rows = $derived(
    [...mine.submissions].sort((a, b) => b.acceptedAt - a.acceptedAt || b.number - a.number),
  )
  /** "3rd" ahead of "#28": the person counts their own submissions, not the class's. */
  const ordinals = $derived(ownOrdinals(mine.submissions))
  const liveFor = (id: string) => mine.live.find((row) => row.submissionId === id) ?? null
  /*
   * Choosing the counted submission freezes together with submissions.
   *
   * The final results open at the deadline, and "my submissions" then shows
   * each row's private number: a button left after that is outright fitting
   * to the hidden part. The door refuses (routes/competitions.ts · choose),
   * and the button must disappear before the refusal — offering an action
   * the server will not perform is worse than not offering it at all.
   */
  const canChoose = $derived(view.competition.scoring === 'chosen')
  const counted = $derived(countedSubmission(view.competition.scoring, mine.submissions.map((s) => ({ ...s, privateScore: s.privateScore ?? null })), view.competition.metric.direction)?.id ?? null)
  const frozen = $derived(mine.accepting !== 'open')
  const limitMs = $derived(view.competition.limits.wallSeconds * 1000)

  /**
   * Your own best submission — the one that counts without a choice.
   *
   * Computed with the same comparison as the leaderboard (`compareScores`):
   * the "best result" under the file name and the place in the table must
   * name the same row, otherwise a person chooses to count something other
   * than what they were promised.
   */
  const best = $derived.by(() => {
    // Under "the last scored submission counts" the best one is not the one
    // that counts: a "best result" mark on an older card, next to "counted" on
    // the newest, told a student in the rehearsal (30 Sep 2026) the opposite
    // of the rule. There the counted mark alone says which one it is.
    if (view.competition.scoring === 'last') return null
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
  The right column moves under the list before the room runs out: at 1024 px
  (a laptop at half screen) the row's five columns and 300 px of conditions
  leave the file name a hundred pixels, and `lgbm_lags_v4_holidays.ipynb`
  turns into "lgbm_lags_v...". As a column, everything reads.
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

    <!--
      After the deadline, while submissions accepted before it are still in
      the queue. Said here, above the student's own list, and not only on the
      leaderboard tab: this is the screen people stare at in the minute after
      the bell, and "why hasn't the board opened" is the question it answers.
    -->
    {#if view.accepting === 'closed' && !view.privateOpen && (view.privatePending ?? 0) > 0}
      <div class="flex flex-wrap items-center gap-x-6 gap-y-3 border-l-[3px] border-accent bg-surface px-5 py-4">
        <div class="min-w-0 flex-1 basis-72">
          <p class="text-title font-bold leading-6 text-ink">{tr('competitions.p.countingTitle')}</p>
          <p class="mt-1 text-ui leading-5 text-muted">{tr('competitions.p.countingNote')}</p>
        </div>
        <p class="shrink-0 font-mono text-[20px] leading-6 text-ink">
          {tr('competitions.p.countingLeft', { count: view.privatePending ?? 0 })}
        </p>
      </div>
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
            ordinal={ordinals.get(submission.id) ?? null}
            offQuota={outsideQuota(submission, mine.perDay)}
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
            ordinal={ordinals.get(submission.id) ?? null}
            offQuota={outsideQuota(submission, mine.perDay)}
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
      <MiniBoard lines={board} closed={boardClosed} onopen={onboard} />
    {/if}
  </aside>
</div>
