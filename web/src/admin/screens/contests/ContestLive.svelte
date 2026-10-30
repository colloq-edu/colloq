<!--
  The console of a live contest (Paper 19 · A4).

  The screen on the teacher's laptop while the class writes code: the feed of
  submissions as the judge answers them, one of them opened beside the feed
  test by test — hidden tests' data and stderr included, the teacher's alone
  — and the oldest question nobody has answered yet, under it, with the two
  ways to answer. Six tabs, each an address: «Лидерборд» unfrozen with full
  names, «Вопросы», «Задачи», «Участники», and «Настройки», which is the
  contest's editor.

  The header carries the clock (ДО КОНЦА, on the server's time, not the
  laptop's), the queue, and the class's moments: «Продлить» when the room
  needs ten more minutes, «Завершить сейчас», «Разморозить» after the end —
  the reveal is a moment of the class, never of the clock.

  Live state comes by a stream (event `state`: revisions to compare, nothing
  heavy) and the screen re-reads only what changed; where the stream cannot
  come up (a proxy that cuts event streams) it polls instead, less often but
  honestly, as the competitions' console does.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { onMount, untrack } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import EmptyState from '@/admin/ui/EmptyState.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import ContestEditor from './ContestEditor.svelte'
  import ProblemTable from './ProblemTable.svelte'
  import SubmissionDrawer from './SubmissionDrawer.svelte'
  import QuestionCard from './QuestionCard.svelte'
  import QuestionsPanel from './QuestionsPanel.svelte'
  import BoardPanel from './BoardPanel.svelte'
  import EntrantsPanel from './EntrantsPanel.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import VerdictBadge from './VerdictBadge.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { cn } from '@/lib/utils'
  import { boardFrozen, contestPath, contestPhase, judged, VERDICTS } from '@shared/contests'
  import type {
    AdminQuestion,
    AdminQuestions,
    AdminSubmissionDetail,
    AdminSubmissionRow,
    AdminSubmissions,
    ContestLiveState,
    ContestView,
    ProblemView,
  } from '@shared/contests-api'
  import {
    contestTabPath,
    countdown,
    extendedEnd,
    freezeNote,
    fromZonedInput,
    instanceZone,
    languageShort,
    momentOf,
    phaseBadge,
    problemPath,
    waitsForAnswer,
    zonedInput,
    type ContestTab,
  } from '@/admin/contests'

  interface Props {
    view: ContestView
    tab?: ContestTab
    navigate: (path: string) => void
    onview: (view: ContestView) => void
  }

  let { view, tab = 'submissions', navigate, onview }: Props = $props()

  const c = $derived(view.contest)
  const zone = $derived(instanceZone(view))

  let busy = $state(false)
  let errorText = $state<(() => string) | null>(null)
  const error = $derived(errorText?.() ?? null)
  /** Which load a refusal came from: «Повторить» re-asks the feed, an action's refusal is only said. */
  let errorAt = $state<'feed' | 'action'>('action')
  /** A sentence about what an action did («12 посылок ушли на перепроверку»): gone with the next action. */
  let notice = $state<string | null>(null)
  let now = $state(Date.now())
  /** The server's clock minus this laptop's: the countdown is the server's, a laptop's clock drifts. */
  let skew = $state(0)
  const serverNow = $derived(now + skew)

  const explain = (cause: unknown): string =>
    cause instanceof AdminApiError ? cause.message : tr('admin.contests.requestFailed')

  function lost(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
  }

  async function act<T>(what: () => Promise<T>): Promise<T | null> {
    if (busy) return null
    busy = true
    errorText = null
    notice = null
    try {
      return await what()
    } catch (cause) {
      lost(cause)
      errorAt = 'action'
      errorText = () => explain(cause)
      return null
    } finally {
      busy = false
    }
  }

  /* ------------------------------------------------------------ live state */

  let live = $state<ContestLiveState | null>(null)
  /** Bumped by every poll when there is no stream: the board and the people re-read on it. */
  let polls = $state(0)
  let streaming = $state(true)

  /** What changed since the last state, re-read; the first state only sets the clock. */
  function applyLive(next: ContestLiveState): void {
    const before = untrack(() => live)
    live = next
    skew = next.now - Date.now()
    if (!before) return
    if (next.revision !== before.revision) void refreshView()
    if (next.submissions !== before.submissions) {
      void loadFeed()
      const open = untrack(() => detail)
      if (open && !judged(open.state)) void loadDetail(open.id, true)
    }
    if (next.questions !== before.questions) void loadQuestions()
  }

  $effect(() => {
    const id = c.id
    if (!streaming) return
    const source = new EventSource(adminApi.contests.streamUrl(id))
    source.addEventListener('state', (event) => {
      if (id !== untrack(() => c.id)) return
      try {
        applyLive(JSON.parse((event as MessageEvent<string>).data) as ContestLiveState)
      } catch {
        /* a broken frame is skipped: the next one says the same, newer */
      }
    })
    source.onerror = () => {
      source.close()
      streaming = false
    }
    return () => source.close()
  })

  $effect(() => {
    if (streaming) return
    const tick = window.setInterval(() => {
      untrack(() => {
        polls += 1
        void refreshView()
        void loadFeed()
        void loadQuestions()
        if (detail && !judged(detail.state)) void loadDetail(detail.id, true)
      })
    }, 5000)
    return () => window.clearInterval(tick)
  })

  async function refreshView(): Promise<void> {
    const id = c.id
    try {
      const fresh = await adminApi.contests.get(id)
      if (id === c.id) onview(fresh)
    } catch (cause) {
      lost(cause)
    }
  }

  /* ----------------------------------------------------------------- feed */

  const PAGE = 100
  let feed = $state<AdminSubmissions | null>(null)
  let feedRequest = 0
  let filterProblem = $state('')
  let filterVerdict = $state('')
  /** What is typed in «Участник…»; the request waits for a pause in the typing. */
  let search = $state('')
  let query = $state('')

  $effect(() => {
    const typed = search
    const timer = window.setTimeout(() => (query = typed.trim()), 300)
    return () => window.clearTimeout(timer)
  })

  $effect(() => {
    void c.id
    void filterProblem
    void filterVerdict
    void query
    untrack(() => void loadFeed())
  })

  /**
   * The feed, at the depth already shown: a push from the stream must not
   * fold «Показать ещё» back to the first page under the teacher's eyes.
   */
  async function loadFeed(more = false): Promise<void> {
    const id = c.id
    const asked = ++feedRequest
    const previous = more ? (feed?.submissions ?? []) : []
    const depth = more ? PAGE : Math.min(500, Math.max(PAGE, feed?.submissions.length ?? 0))
    try {
      const next = await adminApi.contests.submissions(id, {
        problem: filterProblem || undefined,
        verdict: filterVerdict || undefined,
        q: query || undefined,
        limit: depth,
        offset: previous.length,
      })
      if (id !== c.id || asked !== feedRequest) return
      feed = { submissions: [...previous, ...next.submissions], total: next.total }
      if (errorAt === 'feed') errorText = null
    } catch (cause) {
      if (id !== c.id || asked !== feedRequest) return
      lost(cause)
      errorAt = 'feed'
      errorText = () => explain(cause)
    }
  }


  /* --------------------------------------------------------------- drawer */

  let selected = $state<string | null>(null)
  let detail = $state<AdminSubmissionDetail | null>(null)
  let detailLoading = $state(false)
  let detailRequest = 0

  async function loadDetail(sid: string, quiet = false): Promise<void> {
    const id = c.id
    const asked = ++detailRequest
    if (!quiet) {
      detail = null
      detailLoading = true
    }
    try {
      const fresh = await adminApi.contests.submission(id, sid)
      if (asked === detailRequest && selected === sid) detail = fresh
    } catch (cause) {
      if (asked !== detailRequest || quiet) return
      lost(cause)
      errorAt = 'action'
      errorText = () => explain(cause)
    } finally {
      if (asked === detailRequest) detailLoading = false
    }
  }

  function pick(row: AdminSubmissionRow): void {
    if (selected === row.id) return
    selected = row.id
    void loadDetail(row.id)
  }

  function closeDrawer(): void {
    selected = null
    detail = null
  }

  async function rejudge(sid: string): Promise<void> {
    const id = c.id
    const row = await act(() => adminApi.contests.rejudge(id, sid))
    if (!row) return
    if (feed) feed = { ...feed, submissions: feed.submissions.map((one) => (one.id === row.id ? row : one)) }
    if (selected === sid) void loadDetail(sid, true)
  }

  /* --------------------------------------------- rejudging a whole problem */

  let rejudgeMenu = $state(false)
  let rejudging = $state<ProblemView | null>(null)
  let rejudgeError = $state<string | null>(null)

  async function rejudgeProblem(): Promise<void> {
    const problem = rejudging
    const id = c.id
    if (!problem || busy) return
    busy = true
    rejudgeError = null
    try {
      const { queued } = await adminApi.contests.rejudgeProblem(id, problem.id)
      rejudging = null
      notice = tr('admin.contests.rejudgeQueued', { count: queued })
      void loadFeed()
    } catch (cause) {
      lost(cause)
      rejudgeError = explain(cause)
    } finally {
      busy = false
    }
  }

  /* ------------------------------------------------------------ questions */

  let questions = $state<AdminQuestions | null>(null)
  let questionsRequest = 0

  async function loadQuestions(): Promise<void> {
    const id = c.id
    const asked = ++questionsRequest
    try {
      const fresh = await adminApi.contests.questions(id)
      if (id === c.id && asked === questionsRequest) questions = fresh
    } catch (cause) {
      lost(cause)
    }
  }

  $effect(() => {
    void c.id
    untrack(() => void loadQuestions())
  })

  const unanswered = $derived(questions?.unanswered ?? 0)
  /** The question on the first tab, under the drawer: whoever asked first has waited longest. */
  const firstWaiting = $derived(
    (questions?.questions ?? []).filter((one) => waitsForAnswer(one)).sort((a, b) => a.askedAt - b.askedAt)[0] ?? null,
  )

  async function answer(question: AdminQuestion, text: string, toEveryone: boolean): Promise<void> {
    const id = c.id
    const updated = await act(() => adminApi.contests.answer(id, question.id, { answer: text, public: toEveryone }))
    if (!updated) return
    if (questions) {
      const list = questions.questions.map((one) => (one.id === updated.id ? updated : one))
      questions = { questions: list, unanswered: list.filter((one) => waitsForAnswer(one)).length }
    }
    void loadQuestions()
  }

  async function announce(text: string, problemId: string | null): Promise<boolean> {
    const id = c.id
    const made = await act(() => adminApi.contests.announce(id, { text, problemId }))
    if (!made) return false
    void loadQuestions()
    return true
  }

  let doomedQuestion = $state<AdminQuestion | null>(null)
  let questionError = $state<string | null>(null)

  async function deleteQuestion(): Promise<void> {
    const question = doomedQuestion
    const id = c.id
    if (!question || busy) return
    busy = true
    questionError = null
    try {
      await adminApi.contests.deleteQuestion(id, question.id)
      doomedQuestion = null
      if (questions) {
        const list = questions.questions.filter((one) => one.id !== question.id)
        questions = { questions: list, unanswered: list.filter((one) => waitsForAnswer(one)).length }
      }
      void loadQuestions()
    } catch (cause) {
      lost(cause)
      questionError = explain(cause)
    } finally {
      busy = false
    }
  }

  /* -------------------------------------------------------- the class's moments */

  const phase = $derived(contestPhase(c, serverNow))
  const badge = $derived(phaseBadge(phase))
  const frozen = $derived(boardFrozen(c, serverNow))
  const freeze = $derived(freezeNote(c, phase, serverNow, zone))
  const judge = $derived(live?.judge ?? view.judge)

  /** The header's clock: to the end while it runs, to the start before it; nothing to count after. */
  const clockGauge = $derived.by(() => {
    if (phase === 'open' && c.endsAt !== null) return { label: tr('admin.contests.live.toEnd'), value: countdown(c.endsAt - serverNow) }
    if (phase === 'soon' && c.startsAt !== null) return { label: tr('admin.contests.live.toStart'), value: countdown(c.startsAt - serverNow) }
    return null
  })

  let extendOpen = $state(false)
  let extendPicking = $state(false)
  let extendTo = $state('')

  async function patchEnd(endsAt: number): Promise<void> {
    const id = c.id
    const fresh = await act(() => adminApi.contests.update(id, { endsAt }))
    if (!fresh) return
    onview(fresh)
    extendOpen = false
    extendPicking = false
    notice = tr('admin.contests.extend.done', { time: momentOf(endsAt, Date.now(), zone) })
  }

  function extendBy(minutes: number): void {
    void patchEnd(extendedEnd(c.endsAt, serverNow, minutes))
  }

  function extendPicked(): void {
    const at = fromZonedInput(extendTo, zone)
    if (at === null) return
    void patchEnd(at)
  }

  type Dialog = 'finish' | 'unfreeze' | 'hide' | null
  let dialog = $state<Dialog>(null)
  let dialogError = $state<string | null>(null)

  async function confirmDialog(): Promise<void> {
    const id = c.id
    const which = dialog
    if (!which || busy) return
    busy = true
    dialogError = null
    try {
      const fresh =
        which === 'finish'
          ? await adminApi.contests.finish(id)
          : which === 'unfreeze'
            ? await adminApi.contests.unfreeze(id)
            : await adminApi.contests.hide(id)
      onview(fresh)
      dialog = null
    } catch (cause) {
      lost(cause)
      dialogError = explain(cause)
    } finally {
      busy = false
    }
  }

  async function showAgain(): Promise<void> {
    const id = c.id
    const fresh = await act(() => adminApi.contests.show(id))
    if (fresh) onview(fresh)
  }

  async function reopen(): Promise<void> {
    const id = c.id
    const fresh = await act(() => adminApi.contests.reopen(id))
    if (fresh) onview(fresh)
  }

  let copied = $state(false)
  async function copyAddress(): Promise<void> {
    const link = `${location.origin}${contestPath(c.slug)}`
    try {
      await copyText(link)
      copied = true
      setTimeout(() => (copied = false), 1600)
    } catch {
      errorAt = 'action'
      errorText = () => tr('admin.contests.copyFailed', { link })
    }
  }

  onMount(() => {
    // A second: the countdown in the header is a clock, and it has to tick.
    const tick = window.setInterval(() => (now = Date.now()), 1000)
    const close = () => {
      extendOpen = false
      rejudgeMenu = false
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (extendOpen || rejudgeMenu) close()
      else if (selected && dialog === null && rejudging === null && doomedQuestion === null) closeDrawer()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(tick)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  })

  const problems = $derived([...view.problems].sort((a, b) => a.position - b.position))
  const problemOf = $derived(new Map(view.problems.map((one) => [one.id, one] as const)))
  const rows = $derived(feed?.submissions ?? [])
  const filtered = $derived(filterProblem !== '' || filterVerdict !== '' || query !== '')
  const ioi = $derived(c.rules === 'ioi')
  const boardVersion = $derived(live?.submissions ?? `poll:${polls}`)

  const TABS = $derived<{ id: ContestTab; label: string; count?: number | null; alert?: number }[]>([
    { id: 'submissions', label: tr('admin.contests.tab.submissions'), count: view.submissions },
    { id: 'board', label: tr('admin.contests.tab.board') },
    { id: 'questions', label: tr('admin.contests.tab.questions'), alert: unanswered },
    { id: 'problems', label: tr('admin.contests.tab.problems') },
    { id: 'entrants', label: tr('admin.contests.tab.entrants'), count: view.entrants },
    { id: 'settings', label: tr('admin.contests.tab.settings') },
  ])
</script>

<AdminPage title={c.title}>
  {#snippet eyebrow()}
    <button type="button" class="shrink-0 transition-colors duration-100 hover:text-ink" onclick={() => navigate('/admin/contests')}>
      {tr('admin.contests.title')}
    </button>
    <span aria-hidden="true">/</span>
  {/snippet}

  <!-- Under the title: the phase and the freeze, then the participants'
       address with «открыть» and «скопировать», as a competition's console
       and a course's header draw theirs. -->
  {#snippet lede()}
    <div class="flex min-w-0 basis-full flex-wrap items-center gap-x-2.5 gap-y-1.5">
      <Badge word={tr(`contests.phase.${phase}`)} tone={badge.tone} form={badge.form} />
      {#if c.hiddenAt !== null}
        <Badge word={tr('admin.contests.hiddenBadge')} tone="warning" form="outline" />
      {/if}
      {#if freeze}
        <span class={cn('text-2xs', freeze.frozen ? 'text-brand-2 dark:text-accent' : 'text-muted')}>{freeze.text}</span>
      {/if}
      {#if phase === 'over' && c.upsolving}
        <span class="flex items-center gap-1.5 text-2xs text-accent-text">
          <span class="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true"></span>
          {tr('admin.contests.upsolvingOpen')}
        </span>
      {/if}
    </div>
    <span class="font-mono text-2xs text-ink">{location.host}{contestPath(c.slug)}</span>
    <span class="inline-flex items-baseline gap-x-4 whitespace-nowrap">
      <a class="admin-link" href={contestPath(c.slug)} target="_blank" rel="noreferrer">{tr('admin.course.openPage')}</a>
      <button type="button" class="admin-link" onclick={() => void copyAddress()}>
        {copied ? tr('admin.copied') : tr('admin.course.copyLink')}
      </button>
    </span>
  {/snippet}

  {#snippet actions()}
    {#if clockGauge}
      <div class="flex flex-col items-end px-1">
        <span class="admin-label">{clockGauge.label}</span>
        <span class="font-mono text-head font-bold text-ink" role="timer">{clockGauge.value}</span>
      </div>
    {/if}
    <div class="flex flex-col items-end px-1">
      <span class="admin-label">{tr('admin.contests.live.inQueue')}</span>
      <span class="font-mono text-head font-bold text-ink">{judge.queued}</span>
    </div>
    {#if c.endsAt !== null && c.state === 'live'}
      <div class="relative">
        <button
          type="button"
          class="btn-outline"
          aria-haspopup="menu"
          aria-expanded={extendOpen}
          disabled={busy}
          onclick={(event) => {
            event.stopPropagation()
            extendOpen = !extendOpen
            extendPicking = false
            rejudgeMenu = false
          }}
        >
          {tr('admin.contests.extend')}
          <Icon name="chevron-down" size={13} />
        </button>
        {#if extendOpen}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            role="menu"
            tabindex="-1"
            class="row-menu admin-menu absolute right-0 top-full z-20 mt-1 w-[260px]"
            onclick={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" class="admin-menu-item" onclick={() => extendBy(15)}>
              {tr('admin.contests.extend.by', { minutes: 15 })}
            </button>
            <button type="button" role="menuitem" class="admin-menu-item" onclick={() => extendBy(30)}>
              {tr('admin.contests.extend.by', { minutes: 30 })}
            </button>
            <div class="admin-menu-sep"></div>
            {#if extendPicking}
              <div class="flex flex-col gap-2 px-3 py-2">
                <input class="field font-mono" type="datetime-local" aria-label={tr('admin.contests.extend.label')} bind:value={extendTo} />
                <button type="button" class="btn-primary" disabled={busy || fromZonedInput(extendTo, zone) === null} onclick={extendPicked}>
                  {tr('admin.contests.extend.save')}
                </button>
              </div>
            {:else}
              <button
                type="button"
                role="menuitem"
                class="admin-menu-item"
                onclick={() => {
                  extendPicking = true
                  extendTo = zonedInput(extendedEnd(c.endsAt, serverNow, 15), zone)
                }}
              >
                {tr('admin.contests.extend.pick')}
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <a class="btn-outline" href={`${contestPath(c.slug)}/leaderboard/screen`} target="_blank" rel="noreferrer">
      {tr('admin.contests.screen')}
    </a>
    {#if frozen && phase === 'over'}
      <button type="button" class="btn-primary" disabled={busy} onclick={() => ((dialog = 'unfreeze'), (dialogError = null))}>
        {tr('admin.contests.unfreeze')}
      </button>
    {/if}
    {#if c.hiddenAt !== null}
      <button type="button" class="btn-primary" disabled={busy} onclick={() => void showAgain()}>{tr('admin.contests.show')}</button>
    {:else}
      <button type="button" class="btn-outline" disabled={busy} onclick={() => ((dialog = 'hide'), (dialogError = null))}>
        {tr('admin.contests.hide')}
      </button>
    {/if}
    {#if c.state === 'finished'}
      <button type="button" class="btn-outline" disabled={busy} onclick={() => void reopen()}>{tr('admin.contests.reopen')}</button>
    {:else if phase === 'open'}
      <button type="button" class="btn-danger" disabled={busy} onclick={() => ((dialog = 'finish'), (dialogError = null))}>
        {tr('admin.contests.finishNow')}
      </button>
    {/if}
  {/snippet}

  <div class="admin-tabs">
    {#each TABS as one (one.id)}
      <button type="button" aria-current={tab === one.id ? 'page' : undefined} class="admin-tab" onclick={() => navigate(contestTabPath(c.id, one.id))}>
        {one.label}
        {#if one.count}
          <span class="ml-1.5 font-mono text-micro font-normal text-muted">{one.count}</span>
        {/if}
        {#if one.alert}
          <span class="ml-1.5 bg-danger px-1.5 font-mono text-micro font-bold text-white dark:text-canvas">{one.alert}</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if error}
    <div class="flex flex-wrap items-center gap-3 pt-4">
      <p class="min-w-0 flex-1 text-ui text-danger" role="alert">{error}</p>
      {#if errorAt === 'feed'}
        <button type="button" class="btn-outline shrink-0" onclick={() => void loadFeed()}>{tr('admin.try.again')}</button>
      {/if}
    </div>
  {:else if notice}
    <p class="pt-4 text-ui text-positive" role="status">{notice}</p>
  {/if}

  {#if tab === 'settings'}
    <ContestEditor {view} {navigate} {onview} embedded />
  {:else if tab === 'board'}
    <BoardPanel contestId={c.id} version={boardVersion} />
  {:else if tab === 'questions'}
    <QuestionsPanel
      {questions}
      {view}
      {zone}
      now={serverNow}
      {busy}
      onanswer={(question, text, toEveryone) => void answer(question, text, toEveryone)}
      ondelete={(question) => ((doomedQuestion = question), (questionError = null))}
      onannounce={announce}
    />
  {:else if tab === 'problems'}
    <div class="py-5">
      {#if problems.length === 0}
        <EmptyState title={tr('admin.contests.noProblems')} />
      {:else}
        <ProblemTable problems={view.problems} {busy} onopen={(id) => navigate(problemPath(c.id, id))}>
          {#snippet action(problem)}
            <button
              type="button"
              class="text-2xs text-accent-text hover:brightness-110 disabled:text-faint"
              disabled={busy}
              onclick={() => ((rejudging = problem), (rejudgeError = null))}
            >
              {tr('admin.contests.problems.rejudge')}
            </button>
          {/snippet}
        </ProblemTable>
        <p class="admin-meta py-3.5">{tr('admin.contests.problems.liveNote')}</p>
      {/if}
    </div>
  {:else if tab === 'entrants'}
    <EntrantsPanel contestId={c.id} version={boardVersion} {zone} now={serverNow} onremoved={() => void refreshView()} />
  {:else}
    <!-- ------------------------------------------------ submissions (A4) -->
    <div class="live-body py-5">
      <div class="live-grid">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2 pb-3.5">
            <select class="field w-auto min-w-0" aria-label={tr('admin.contests.filter.problemLabel')} bind:value={filterProblem}>
              <option value="">{tr('admin.contests.filter.allProblems')}</option>
              {#each problems as problem (problem.id)}
                <option value={problem.id}>{problem.letter}. {problem.title}</option>
              {/each}
            </select>
            <select class="field w-auto min-w-0" aria-label={tr('admin.contests.filter.verdictLabel')} bind:value={filterVerdict}>
              <option value="">{tr('admin.contests.filter.allVerdicts')}</option>
              {#each VERDICTS as verdict (verdict)}
                <option value={verdict}>{verdict}</option>
              {/each}
            </select>
            <input
              class="field w-[180px] min-w-0 max-[640px]:w-full"
              type="search"
              aria-label={tr('admin.contests.filter.entrantLabel')}
              placeholder={tr('admin.contests.filter.entrant')}
              bind:value={search}
            />
            <div class="relative ml-auto">
              <button
                type="button"
                class="admin-link"
                aria-haspopup="menu"
                aria-expanded={rejudgeMenu}
                disabled={busy || problems.length === 0}
                onclick={(event) => {
                  event.stopPropagation()
                  rejudgeMenu = !rejudgeMenu
                  extendOpen = false
                }}
              >
                {tr('admin.contests.rejudgeProblem')}
              </button>
              {#if rejudgeMenu}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  role="menu"
                  tabindex="-1"
                  class="row-menu admin-menu absolute right-0 top-full z-20 mt-1 w-[280px]"
                  onclick={(event) => event.stopPropagation()}
                >
                  {#each problems as problem (problem.id)}
                    <button
                      type="button"
                      role="menuitem"
                      class="admin-menu-item truncate"
                      onclick={() => {
                        rejudgeMenu = false
                        rejudging = problem
                        rejudgeError = null
                      }}
                    >
                      {problem.letter}. {problem.title}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>

          {#if feed === null}
            <RowsSkeleton label={tr('admin.contests.live.loading')} />
          {:else if rows.length === 0}
            {#if filtered}
              <EmptyState title={tr('admin.contests.noMatchSubmissions')} />
            {:else}
              <EmptyState
                title={tr('admin.contests.noSubmissions')}
                hint={tr('admin.contests.noSubmissionsHint', { link: `${location.host}${contestPath(c.slug)}` })}
              />
            {/if}
          {:else}
            <div class="feed-head flex items-center gap-3 border-b border-ink pb-2">
              <span class="admin-label w-14 shrink-0">{tr('admin.contests.col.time')}</span>
              <span class="admin-label min-w-0 flex-1">{tr('admin.contests.col.entrant')}</span>
              <span class="admin-label w-7 shrink-0">{tr('admin.contests.col.letter')}</span>
              <span class="feed-language admin-label w-16 shrink-0">{tr('admin.contests.col.language')}</span>
              <span class="admin-label w-24 shrink-0">{tr('admin.contests.col.verdict')}</span>
              {#if ioi}
                <span class="admin-label w-12 shrink-0 text-right">{tr('admin.contests.col.score')}</span>
              {/if}
            </div>
            {#each rows as row (row.id)}
              {@const on = selected === row.id}
              <button
                type="button"
                class={cn(
                  'flex w-full items-center gap-3 border-b border-line py-2.5 text-left transition-colors duration-quick hover:bg-surface',
                  on && 'border-l-[3px] border-l-brand bg-raised pl-2 hover:bg-raised dark:border-l-accent',
                )}
                aria-pressed={on}
                onclick={() => pick(row)}
              >
                <span class="w-14 shrink-0 font-mono text-micro text-muted">{momentOf(row.submittedAt, serverNow, zone)}</span>
                <span class={cn('min-w-0 flex-1 truncate text-ui text-ink', on && 'font-semibold')}>
                  {row.entrant?.name ?? tr('admin.contests.teacherRun')}
                  {#if row.late}
                    <span class="ml-1.5 text-micro font-normal text-accent-text">{tr('admin.contests.lateMark')}</span>
                  {/if}
                </span>
                <span class="w-7 shrink-0 font-mono text-2xs font-bold text-ink">{row.letter}</span>
                <span class="feed-language w-16 shrink-0 font-mono text-micro text-muted">{languageShort(row.language)}</span>
                <span class="w-24 shrink-0">
                  <VerdictBadge
                    verdict={row.verdict}
                    state={row.state}
                    test={row.state === 'running' ? (row.progress === null ? null : row.progress + 1) : row.failedTest}
                  />
                </span>
                {#if ioi}
                  <span class="w-12 shrink-0 text-right font-mono text-micro text-ink">{row.score ?? '—'}</span>
                {/if}
              </button>
            {/each}
            {#if feed.total > rows.length}
              <div class="flex items-center gap-3 py-3.5">
                <p class="admin-meta min-w-0 flex-1">{tr('admin.contests.moreSubmissions', { count: feed.total - rows.length })}</p>
                <button type="button" class="btn-outline shrink-0" onclick={() => void loadFeed(true)}>{tr('admin.contests.showMore')}</button>
              </div>
            {/if}
          {/if}
        </div>

        <!-- The drawer and the waiting question: beside the feed on a wide
             screen and held in view as it scrolls, under it on a narrow one. -->
        <aside class="live-aside flex min-w-0 flex-col gap-4">
          <SubmissionDrawer
            {detail}
            loading={detailLoading}
            {view}
            {zone}
            now={serverNow}
            {busy}
            onrejudge={(sid) => void rejudge(sid)}
            onclose={closeDrawer}
          />
          {#if firstWaiting}
            {@const question = firstWaiting}
            <QuestionCard
              {question}
              {zone}
              now={serverNow}
              {busy}
              highlight
              onanswer={(text, toEveryone) => void answer(question, text, toEveryone)}
            />
            {#if unanswered > 1}
              <button type="button" class="admin-link self-start" onclick={() => navigate(contestTabPath(c.id, 'questions'))}>
                {tr('admin.contests.moreQuestions', { count: unanswered - 1 })}
              </button>
            {/if}
          {/if}
        </aside>
      </div>
    </div>
  {/if}
</AdminPage>

{#if dialog === 'finish'}
  <ConfirmDialog
    title={tr('admin.contests.finishHeading', { name: c.title })}
    body={c.upsolving ? tr('admin.contests.finishBodyUpsolving') : tr('admin.contests.finishBody')}
    confirm={tr('admin.contests.finishNow')}
    {busy}
    error={dialogError}
    onconfirm={() => void confirmDialog()}
    oncancel={() => (dialog = null)}
  />
{:else if dialog === 'unfreeze'}
  <ConfirmDialog
    title={tr('admin.contests.unfreezeHeading')}
    body={tr('admin.contests.unfreezeBody', { minutes: c.freezeMinutes })}
    confirm={tr('admin.contests.unfreeze')}
    danger={false}
    {busy}
    error={dialogError}
    onconfirm={() => void confirmDialog()}
    oncancel={() => (dialog = null)}
  />
{:else if dialog === 'hide'}
  <ConfirmDialog
    title={tr('admin.contests.hideHeading', { name: c.title })}
    body={tr('admin.contests.hideBody')}
    confirm={tr('admin.contests.hide')}
    danger={false}
    {busy}
    error={dialogError}
    onconfirm={() => void confirmDialog()}
    oncancel={() => (dialog = null)}
  />
{/if}

{#if rejudging}
  <ConfirmDialog
    title={tr('admin.contests.rejudgeHeading', { letter: rejudging.letter })}
    body={tr('admin.contests.rejudgeBody', { letter: rejudging.letter })}
    confirm={tr('admin.contests.problems.rejudge')}
    danger={false}
    {busy}
    error={rejudgeError}
    onconfirm={() => void rejudgeProblem()}
    oncancel={() => (rejudging = null)}
  />
{/if}

{#if doomedQuestion}
  <ConfirmDialog
    title={tr('admin.contests.question.deleteHeading')}
    body={tr('admin.contests.question.deleteBody')}
    confirm={tr('admin.contests.question.delete')}
    {busy}
    error={questionError}
    onconfirm={() => void deleteQuestion()}
    oncancel={() => (doomedQuestion = null)}
  />
{/if}

<style>
  /*
   * The feed and its drawer side by side while there is room for both (A4:
   * 470 px of drawer), one over the other below that. The threshold is the
   * body's own width — the panel's rail takes its share of the window.
   */
  .live-body {
    container-type: inline-size;
  }

  .live-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1.5rem;
  }

  @container (min-width: 960px) {
    .live-grid {
      grid-template-columns: minmax(0, 1fr) 440px;
    }

    .live-aside {
      position: sticky;
      top: 1rem;
      align-self: start;
      max-height: calc(100vh - 7rem);
      overflow: auto;
      border-left: 1px solid rgb(var(--line));
      padding-left: 1.5rem;
    }
  }

  @container (max-width: 959px) {
    .live-aside {
      border-top: 1px solid rgb(var(--line));
      padding-top: 1.25rem;
    }
  }

  @container (max-width: 520px) {
    .feed-language {
      display: none;
    }
  }
</style>
