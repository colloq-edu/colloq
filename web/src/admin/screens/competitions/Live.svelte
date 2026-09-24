<!--
  The console of a live competition (A3).

  Four tabs, and the first of them is the submission feed: this is the screen
  open on the projector or on a second monitor while the class sends in
  solutions. Three things here are seen ONLY by the teacher, and all three are
  about the teacher's own work: the private column, the "METRIC FAILED" badge
  with its traceback, and the queue block with "Kill". None of it reaches an
  entrant.

  The live state arrives as a stream (SSE), like the environments' build log:
  one direction, the browser reconnects by itself, and no second protocol for
  the sake of five numbers. The feed is re-read by server revision, including
  rescoring and choices.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { onMount, untrack } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import Editor from '@/admin/screens/competitions/Editor.svelte'
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { cn, formatBytes } from '@/lib/utils'
  import {
    competitionPath,
    metricFailedNote,
    placeShift,
    privateBoardOpen,
    teacherBadge,
  } from '@shared/competitions'
  import type {
    CompetitionLive,
    CompetitionLeaderboard,
    CompetitionView,
    EntrantRow,
    SubmissionDetail,
    SubmissionFeed,
  } from '@shared/competitions-api'
  import {
    clock,
    count,
    deadlineLine,
    etaWords,
    feedWhen,
    metricNumber,
    outcomeLine,
    spanWords,
    stateTone,
    stateWord,
    worstCell,
  } from '@/admin/competitions'

  export type LiveTab = 'submissions' | 'board' | 'entrants' | 'settings'

  interface Props {
    view: CompetitionView
    tab?: LiveTab
    navigate: (path: string) => void
    onview: (view: CompetitionView) => void
  }

  let { view, tab = 'submissions', navigate, onview }: Props = $props()

  const c = $derived(view.competition)

  let live = $state<CompetitionLive | null>(null)
  let feed = $state<SubmissionFeed | null>(null)
  let board = $state<CompetitionLeaderboard | null>(null)
  let feedRequest = 0
  let boardRequest = 0
  let generation = 0
  $effect(() => {
    c.id
    generation += 1
    live = null
    feed = null
    board = null
    entrants = null
    detail = null
  })
  let entrants = $state<EntrantRow[] | null>(null)
  let detail = $state<SubmissionDetail | null>(null)
  let busy = $state(false)
  let errorText = $state<(() => string) | null>(null)
  const error = $derived(errorText?.() ?? null)
  let openMenu = $state<string | null>(null)
  let copied = $state<string | null>(null)
  let finishing = $state(false)
  let now = $state(Date.now())

  /** How many feed rows are fetched at a time and how many in total. */
  const PAGE = 200

  const explain = (cause: unknown): string =>
    cause instanceof AdminApiError ? cause.message : tr('admin.competitions.requestFailed')

  function lost(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') {
      void adminAuth.refresh('revoked')
    }
  }

  async function act<T>(what: () => Promise<T>): Promise<T | null> {
    if (busy) return null
    busy = true
    errorText = null
    try {
      return await what()
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
      return null
    } finally {
      busy = false
    }
  }

  /* ------------------------------------------------------------- live state */

  /*
   * A stream, and if it did not come up — polling.
   *
   * `EventSource` reconnects by itself, but only as long as the server
   * answers; behind a proxy that cuts `text/event-stream` it will reconnect
   * forever and silently. The stopwatch of the running submission will
   * freeze, and that is the only thing a person could guess from. So on the
   * very first error the stream is closed and polling switches on — less
   * often, but honestly.
   */
  let streaming = $state(true)

  $effect(() => {
    const id = c.id
    if (!streaming) return
    const active = generation
    const source = new EventSource(adminApi.competitionStreamUrl(id))
    source.addEventListener('state', (event) => {
      if (active === generation && id === c.id) live = JSON.parse((event as MessageEvent<string>).data) as CompetitionLive
    })
    source.onerror = () => {
      source.close()
      streaming = false
    }
    return () => source.close()
  })

  $effect(() => {
    if (streaming) return
    const id = c.id
    const active = generation
    const pull = () => {
      void adminApi
        .competitionLive(id)
        .then((fresh) => { if (active === generation && id === c.id) live = fresh })
        .catch(() => undefined)
    }
    pull()
    const tick = window.setInterval(pull, 5000)
    return () => window.clearInterval(tick)
  })

  // A server mutation revision includes all terminal outcomes, score changes
  // and manual choices, even when the summary counts stay the same.
  $effect(() => {
    c.id
    live?.revision
    untrack(() => void loadFeed())
  })

  async function loadFeed(more = false): Promise<void> {
    const id = c.id
    const active = generation
    const request = ++feedRequest
    const previous = more ? feed?.rows ?? [] : []
    try {
      const next = await adminApi.competitionSubmissions(id, { limit: PAGE, offset: previous.length })
      if (id !== c.id || active !== generation || request !== feedRequest) return
      feed = { rows: [...previous, ...next.rows], total: next.total }
      errorText = null
    } catch (cause) {
      if (id !== c.id || active !== generation || request !== feedRequest) return
      lost(cause)
      errorText = () => explain(cause)
    }
  }

  async function loadBoard(): Promise<void> {
    const id = c.id
    const active = generation
    const request = ++boardRequest
    try {
      const fresh = await adminApi.competitionLeaderboard(id)
      if (id === c.id && active === generation && request === boardRequest) board = fresh
    } catch (cause) {
      if (id !== c.id || active !== generation || request !== boardRequest) return
      lost(cause)
      errorText = () => explain(cause)
    }
  }

  $effect(() => {
    c.id
    live?.revision
    if (tab === 'board') untrack(() => void loadBoard())
  })

  $effect(() => {
    const id = c.id
    if (tab !== 'entrants' || untrack(() => entrants) !== null) return
    const active = generation
    untrack(() => {
      void adminApi
        .competitionEntrants(id)
        /*
         * The service entrant the sample notebook is recorded under is not in
         * the list of people: it has a name, a place and even a sign-in key,
         * but there is no person behind it — and a key shown next to living
         * people will get dictated out loud by someone one day.
         */
        .then((list) => { if (active === generation && id === c.id) entrants = list.entrants.filter((row) => !row.baseline) })
        .catch((cause: unknown) => {
          if (active !== generation || id !== c.id) return
          lost(cause)
          errorText = () => explain(cause)
        })
    })
  })

  onMount(() => {
    // A second: a stopwatch stands under the running submission, and it has
    // to tick.
    const tick = window.setInterval(() => (now = Date.now()), 1000)
    const close = () => (openMenu = null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        openMenu = null
        detail = null
      }
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(tick)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  })

  /* ---------------------------------------------------------------- actions */

  async function togglePause(): Promise<void> {
    const queue = await act(() => adminApi.pauseCompetitionQueue(!(live?.queue.paused ?? false)))
    if (queue && live) live = { ...live, queue }
  }

  async function kill(submissionId: string): Promise<void> {
    await act(() => adminApi.killCompetitionRun(submissionId))
  }

  async function finish(): Promise<void> {
    const id = c.id
    const fresh = await act(() => adminApi.finishCompetition(id))
    if (fresh) {
      onview(fresh)
      finishing = false
    }
  }

  async function openPrivate(): Promise<void> {
    const id = c.id
    const fresh = await act(() => adminApi.openPrivateBoard(id))
    if (fresh) onview(fresh)
  }

  async function rerun(submissionId: string): Promise<void> {
    const id = c.id
    if (await act(() => adminApi.rerunSubmission(id, submissionId))) await loadFeed()
  }

  async function rescoreOne(submissionId: string): Promise<void> {
    const id = c.id
    if (await act(() => adminApi.rescoreSubmission(id, submissionId))) await loadFeed()
  }

  async function rescoreAll(): Promise<void> {
    const id = c.id
    if (await act(() => adminApi.rescoreCompetition(id))) await loadFeed()
  }

  async function drop(submissionId: string): Promise<void> {
    const id = c.id
    if (await act(() => adminApi.dropSubmission(id, submissionId))) await loadFeed()
  }

  async function showDetail(submissionId: string): Promise<void> {
    const found = await act(() => adminApi.competitionSubmission(c.id, submissionId))
    if (found) detail = found
  }

  async function rotate(entrantId: string): Promise<void> {
    const made = await act(() => adminApi.rotateEntrantKey(entrantId))
    if (made && entrants) {
      entrants = entrants.map((row) =>
        row.id === entrantId ? { ...row, ...made.entrant, key: made.key } : row,
      )
    }
  }

  async function copy(text: string, key: string): Promise<void> {
    try {
      await copyText(text)
    } catch {
      errorText = () => tr('admin.competitions.copyFailed', { link: text })
      return
    }
    copied = key
    setTimeout(() => (copied = copied === key ? null : copied), 1600)
  }

  /* ----------------------------------------------------------------- output */

  const counts = $derived(live?.counts ?? view.counts)
  const queue = $derived(live?.queue ?? null)
  const waiting = $derived(live?.waiting ?? [])
  /** Runs in progress: the queue is shared, so others' are named by their address. */
  const running = $derived(queue?.running ?? [])
  const rows = $derived(feed?.rows ?? [])
  const deadline = $derived(deadlineLine(c, now))
  const privateOpen = $derived(privateBoardOpen(c, now))
  const worst = $derived(worstCell(rows))
  const boardBaseline = $derived(board?.baseline ?? null)
  const publicBoard = $derived(board?.public ?? [])
  const privateBoard = $derived(board?.private ?? [])
  const nameOf = $derived(
    new Map(publicBoard.map((row) => [row.entrantId, row.entrantName] as const)),
  )

  function goTab(next: LiveTab): void {
    navigate(`/admin/competitions/${c.id}${next === 'submissions' ? '' : `/${next}`}`)
  }

  const HEAD = 'text-micro font-bold uppercase tracking-caps text-muted'
  const MENU_ITEM =
    'block w-full px-3 py-2 text-left text-ui text-ink transition-colors duration-100 hover:bg-raised'
  const TABS: { id: LiveTab; label: string }[] = [
    { id: 'submissions', label: tr('admin.competitions.tab.submissions') },
    { id: 'board', label: tr('admin.competitions.tab.board') },
    { id: 'entrants', label: tr('admin.competitions.tab.entrants') },
    { id: 'settings', label: tr('admin.competitions.tab.settings') },
  ]
</script>

<!--
  A column caption that moves into the row once there are no columns left:
  without it "— — 0:00" on a narrow screen is three numbers with no names.
-->
{#snippet caption(label: string)}
  <span class="feed-label mr-1.5 font-sans text-micro font-bold uppercase tracking-caps text-faint">
    {label}
  </span>
{/snippet}

{#snippet stat(label: string, value: number, tone: string)}
  <div class="shrink-0">
    <p class="text-micro font-bold uppercase tracking-caps {tone}">{label}</p>
    <p class="font-mono text-gauge font-bold text-ink">{count(value)}</p>
  </div>
{/snippet}

<AdminPage title={c.title}>
  {#snippet eyebrow()}
    <button
      type="button"
      class="shrink-0 text-micro text-muted transition-colors duration-100 hover:text-ink"
      onclick={() => navigate('/admin/competitions')}
    >
      {tr('competitions.title')}
    </button>
    <span aria-hidden="true">/</span>
    <span class="truncate font-mono">/k/{c.slug}</span>
  {/snippet}

  {#snippet beside()}
    <Badge word={stateWord(c.state)} tone={stateTone(c.state)} />
    <span class="text-2xs text-muted">{deadline.note}</span>
  {/snippet}

  {#snippet actions()}
    <button
      type="button"
      class="btn-outline max-[640px]:h-11"
      onclick={() => void copy(`${location.origin}${competitionPath(c.slug)}`, 'link')}
    >
      {copied === 'link' ? tr('admin.copied') : tr('admin.competitions.entrantLink')}
    </button>
    <a
      class="btn-outline max-[640px]:h-11"
      href={`${competitionPath(c.slug)}/leaderboard/screen`}
      target="_blank"
      rel="noreferrer"
    >
      {tr('admin.competitions.boardOnScreen')}
    </a>
    {#if c.state === 'live' && adminAuth.isOwner}
      <button
        type="button"
        class="btn border border-danger text-danger hover:bg-danger/10 max-[640px]:h-11"
        onclick={() => (finishing = true)}
      >
        {tr('admin.competitions.finishNow')}
      </button>
    {/if}
    {#if c.state === 'finished' && !privateOpen}
      <!-- "I will open it by hand — at the review": the teacher picks the
           moment, and until that second the private table is visible to
           nobody but them. -->
      <button type="button" class="btn-primary max-[640px]:h-11" disabled={busy} onclick={() => void openPrivate()}>
        {tr('admin.competitions.openPrivate')}
      </button>
    {/if}
  {/snippet}

  <!-- Tabs are addresses: "Leaderboard · both" gets linked to a colleague, and
       "Settings" is opened in the middle of a class and returned to. -->
  <div class="-mx-7 flex gap-7 overflow-x-auto border-b border-line px-7">
    {#each TABS as one (one.id)}
      <button
        type="button"
        aria-current={tab === one.id ? 'page' : undefined}
        class={cn(
          'shrink-0 whitespace-nowrap border-b-[3px] text-ui transition-colors duration-100',
          tab === one.id
            ? 'border-accent pb-2.5 pt-3 font-semibold text-ink'
            : 'border-transparent pb-3 pt-3 text-muted hover:text-ink',
        )}
        onclick={() => goTab(one.id)}
      >
        {one.label}
        {#if one.id === 'submissions' && counts.submissions > 0}
          <span class="ml-1.5 font-mono text-micro text-muted">{counts.submissions}</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if error}
    <div class="flex flex-wrap items-center gap-3 pt-4">
      <p class="min-w-0 flex-1 text-ui text-danger" role="alert">{error}</p>
      <button type="button" class="btn-outline shrink-0" onclick={() => void loadFeed()}>
        {tr('admin.try.again')}
      </button>
    </div>
  {/if}

  {#if tab === 'settings'}
    <Editor {view} {navigate} {onview} embedded />
  {:else if tab === 'entrants'}
    <div class="comp-feed py-5">
      {#if entrants === null}
        <RowsSkeleton label={tr('competitions.loading')} />
      {:else if entrants.length === 0}
        <div class="py-16 text-center">
          <p class="text-title font-semibold text-ink">{tr('admin.competitions.noEntrants')}</p>
          <p class="mx-auto mt-2 max-w-md text-ui text-muted">{tr('admin.competitions.noEntrantsHint')}</p>
        </div>
      {:else}
        <div class="flex items-center gap-4 border-b border-line py-2.5 feed-head">
          <span class="min-w-0 flex-1 {HEAD}">{tr('admin.competitions.col.entrant')}</span>
          <span class="w-[80px] shrink-0 text-right {HEAD}">{tr('admin.competitions.col.place')}</span>
          <span class="w-[88px] shrink-0 text-right {HEAD}">{tr('admin.competitions.col.submissions')}</span>
          <span class="w-[180px] shrink-0 {HEAD}">{tr('admin.competitions.col.key')}</span>
          <span class="w-[150px] shrink-0"></span>
        </div>
        {#each entrants as row (row.id)}
          <div class="feed-row flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line-soft py-3">
            <div class="min-w-0 flex-1 basis-[200px]">
              <p class="truncate text-ui text-ink">{row.name}</p>
              {#if row.disabled}
                <p class="mt-0.5 text-micro text-warning">{tr('admin.competitions.keyRevoked')}</p>
              {/if}
            </div>
            <span class="w-[80px] shrink-0 text-right font-mono text-2xs text-ink">
              {@render caption(tr('admin.competitions.col.place'))}{row.place === null
                ? '—'
                : row.place}
            </span>
            <span class="w-[88px] shrink-0 text-right font-mono text-2xs text-ink">
              {@render caption(tr('admin.competitions.col.submissions'))}{count(row.submissions)}
            </span>
            <!--
              The key is visible here and nowhere else in the product: it is
              dictated out loud and pasted into the course chat; it is the
              only way to bring a person back from another device.
            -->
            <button
              type="button"
              class="w-[180px] shrink-0 text-left font-mono text-2xs text-accent-text hover:brightness-110"
              disabled={row.key === null}
              onclick={() => row.key && void copy(row.key, row.id)}
            >
              {copied === row.id ? tr('admin.copied') : (row.key ?? '—')}
            </button>
            {#if adminAuth.isOwner}
              <button
                type="button"
                class="w-[150px] shrink-0 text-left text-2xs text-muted hover:text-ink disabled:text-faint"
                disabled={busy}
                onclick={() => void rotate(row.id)}
              >
                {tr('admin.competitions.rotateKey')}
              </button>
            {/if}
          </div>
        {/each}
        <p class="py-3.5 text-micro leading-snug text-faint">{tr('admin.competitions.keyNote')}</p>
      {/if}
    </div>
  {:else if tab === 'board'}
    <div class="comp-feed py-5">
      {#if board === null}
        <RowsSkeleton label={tr('competitions.loading')} />
      {:else if publicBoard.length === 0}
        <div class="py-16 text-center">
          <p class="text-title font-semibold text-ink">{tr('admin.competitions.noBoard')}</p>
          <p class="mx-auto mt-2 max-w-md text-ui text-muted">{tr('admin.competitions.noBoardHint')}</p>
        </div>
      {:else}
        <p class="pb-3 text-micro leading-snug text-muted">
          {privateOpen
            ? tr('admin.competitions.boardBothOpen')
            : tr('admin.competitions.boardBothHidden')}
        </p>
        <div class="feed-head flex items-center gap-4 border-b-2 border-ink py-2.5">
          <span class="w-[64px] shrink-0 {HEAD}">{tr('admin.competitions.col.place')}</span>
          <span class="min-w-0 flex-1 {HEAD}">{tr('admin.competitions.col.entrant')}</span>
          <span class="w-[104px] shrink-0 text-right {HEAD}">{tr('admin.competitions.col.public')}</span>
          <span class="w-[112px] shrink-0 text-right text-micro font-bold uppercase tracking-caps text-primary">
            {tr('admin.competitions.col.private')}
          </span>
          <span class="feed-shift w-[88px] shrink-0 text-right {HEAD}">
            {tr('admin.competitions.col.shift')}
          </span>
        </div>
        {#each publicBoard as row (row.entrantId)}
          {@const mirror = privateBoard.find((one) => one.entrantId === row.entrantId) ?? null}
          {@const shift = placeShift(row.place, mirror?.place ?? null)}
          <div class="feed-row flex flex-wrap items-center gap-4 border-b border-line-soft py-2.5">
            <span class="w-[64px] shrink-0 font-mono text-2xs text-muted">{row.place}</span>
            <span class="min-w-0 flex-1 truncate text-ui text-ink">
              {nameOf.get(row.entrantId) ?? tr('admin.competitions.unknownEntrant')}
            </span>
            <span class="w-[104px] shrink-0 text-right font-mono text-2xs text-ink">
              {@render caption(tr('admin.competitions.col.public'))}{metricNumber(row.score)}
            </span>
            <span class="w-[112px] shrink-0 text-right font-mono text-2xs text-primary">
              {@render caption(tr('admin.competitions.col.private'))}{metricNumber(
                mirror?.score ?? null,
              )}
            </span>
            <span
              class={cn(
                'feed-shift w-[88px] shrink-0 text-right font-mono text-2xs',
                shift === null || shift === 0 ? 'text-faint' : shift > 0 ? 'text-positive' : 'text-danger',
              )}
            >
              {shift === null ? '—' : shift === 0 ? '—' : shift > 0 ? `▲ ${shift}` : `▼ ${-shift}`}
            </span>
          </div>
        {/each}
        {#if boardBaseline?.state === 'scored'}
          <!-- The baseline solution is a row without a place: it is not an
               entrant, and ranking it together with the class would take a
               place away from someone in favour of the teacher. -->
          <div class="feed-row flex flex-wrap items-center gap-4 border-b border-line-soft py-2.5">
            <span class="w-[64px] shrink-0 font-mono text-2xs text-faint">—</span>
            <span class="min-w-0 flex-1 truncate text-ui text-muted">
              {tr('competitions.baselineEntrant')}
            </span>
            <span class="w-[104px] shrink-0 text-right font-mono text-2xs text-muted">
              {@render caption(tr('admin.competitions.col.public'))}{metricNumber(
                boardBaseline.publicScore,
              )}
            </span>
            <span class="w-[112px] shrink-0 text-right font-mono text-2xs text-muted">
              {@render caption(tr('admin.competitions.col.private'))}{metricNumber(
                boardBaseline.privateScore,
              )}
            </span>
            <span class="feed-shift w-[88px] shrink-0"></span>
          </div>
        {/if}
      {/if}
    </div>
  {:else}
    <!-- -------------------------------------------------- submissions (A3) -->
    <div class="flex flex-col gap-5 py-5">
      <!-- 1 · Queue -->
      <div class="flex flex-wrap items-stretch border border-line">
        <div class="flex min-w-0 flex-[2_1_420px] flex-col gap-2.5 px-4 py-3.5">
          <div class="flex items-center gap-2.5">
            <span
              class={cn('h-2 w-2 shrink-0', running.length > 0 ? 'bg-accent' : 'bg-faint')}
              aria-hidden="true"
            ></span>
            <span class="text-micro font-bold uppercase tracking-caps text-primary">
              {tr('admin.competitions.runningNow')}
            </span>
          </div>

          {#each running as run (run.submissionId)}
            {@const elapsed = Math.max(0, now - run.startedAt)}
            <div class="flex flex-col gap-2">
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span class="text-ui-lg font-semibold text-ink">
                  {run.baseline ? tr('competitions.baselineEntrant') : run.entrantName} · #{run.number}
                </span>
                <span class="min-w-0 truncate text-2xs text-muted">
                  {run.fileName}{run.cellsTotal > 0
                    ? ` · ${tr('admin.competitions.cellOf', { done: run.cellsDone, total: run.cellsTotal })}`
                    : ''}
                </span>
                {#if run.competitionId !== c.id}
                  <!-- There is one runner per instance: another competition's
                       submission takes the same queue, and staying silent
                       about it means explaining "why are we stuck" through
                       docker ps. -->
                  <span class="font-mono text-micro text-faint">/k/{run.competitionSlug}</span>
                {/if}
                <span class="ml-auto shrink-0 font-mono text-2xs text-ink">
                  {tr('admin.competitions.ofClock', {
                    now: clock(elapsed, true),
                    limit: clock(run.limitMs, true),
                  })}
                </span>
                <button
                  type="button"
                  class="shrink-0 text-2xs text-danger hover:brightness-110 disabled:text-faint"
                  disabled={busy}
                  onclick={() => void kill(run.submissionId)}
                >
                  {tr('admin.competitions.kill')}
                </button>
              </div>
              <div class="h-1 w-full bg-raised" aria-hidden="true">
                <div
                  class="h-full bg-accent transition-[width] duration-[var(--speed-quick)] ease-out"
                  style="width: {Math.min(100, (elapsed / Math.max(1, run.limitMs)) * 100).toFixed(1)}%"
                ></div>
              </div>
              <p class="text-micro text-muted">
                {[run.container, tr('admin.competitions.noNetwork')].filter(Boolean).join(' · ')}
              </p>
            </div>
          {:else}
            <p class="text-2xs text-muted">
              {queue?.paused ? tr('admin.competitions.queuePausedLong') : tr('admin.competitions.nothingRunning')}
            </p>
          {/each}
        </div>

        <div
          class="flex min-w-0 flex-[1_1_320px] flex-col gap-2 border-l border-line bg-surface px-4 py-3.5
                 max-[900px]:border-l-0 max-[900px]:border-t"
        >
          <div class="flex items-center gap-3">
            <span class="text-micro font-bold uppercase tracking-caps text-primary">
              {tr('admin.competitions.waitingHead', { count: waiting.length })}
            </span>
            <button
              type="button"
              class="ml-auto shrink-0 text-micro text-accent-text underline decoration-dotted
                     underline-offset-4 hover:brightness-110 disabled:text-faint"
              disabled={busy}
              onclick={() => void togglePause()}
            >
              {queue?.paused
                ? tr('admin.competitions.resumeQueue')
                : tr('admin.competitions.pauseQueue')}
            </button>
          </div>
          {#each waiting as row (row.submissionId)}
            <div class="flex items-center gap-2.5">
              <span class="w-4 shrink-0 font-mono text-micro text-muted">{row.place ?? '—'}</span>
              <span class="min-w-0 flex-1 truncate text-2xs text-ink">
                {row.baseline ? tr('competitions.baselineEntrant') : row.entrantName} · #{row.number}
              </span>
              <span class="shrink-0 font-mono text-micro text-muted">{row.resourcePending ? tr('competitions.runtime.retrying') : etaWords(row.etaMs)}</span>
            </div>
          {:else}
            <p class="text-2xs text-muted">{tr('admin.competitions.queueEmpty')}</p>
          {/each}
          {#if queue && queue.waiting > waiting.length}
            <p class="text-micro text-muted">
              {tr('admin.competitions.waitingElsewhere', { count: queue.waiting - waiting.length })}
            </p>
          {/if}
          <p class="text-micro leading-snug text-muted">{tr('admin.competitions.fairQueue')}</p>
        </div>
      </div>

      <!-- 2 · Summary -->
      <div class="flex flex-wrap items-end gap-x-10 gap-y-4">
        {@render stat(tr('admin.competitions.sum.submissions'), counts.submissions, 'text-muted')}
        {@render stat(tr('admin.competitions.sum.scored'), counts.scored, 'text-positive')}
        {@render stat(tr('admin.competitions.sum.notebookFailed'), counts.notebookFailed, 'text-danger')}
        {@render stat(tr('admin.competitions.sum.rejected'), counts.rejected, 'text-warning')}
        {@render stat(tr('admin.competitions.sum.timedOut'), counts.timedOut, 'text-danger')}
        <p class="ml-auto max-w-[330px] text-right text-micro leading-snug text-muted">
          {live?.medianMs != null
            ? tr('admin.competitions.median', { span: spanWords(live.medianMs) })
            : ''}
          {#if worst}
            {tr('admin.competitions.worstCell', {
              cell: worst.cell,
              hits: worst.hits,
              total: worst.total,
            })}
          {/if}
        </p>
      </div>

      <!-- 3 · Submission feed -->
      <div class="comp-feed">
        {#if feed === null}
          <RowsSkeleton label={tr('competitions.loading')} />
        {:else if rows.length === 0}
          <div class="py-16 text-center">
            <p class="text-title font-semibold text-ink">{tr('admin.competitions.noSubmissions')}</p>
            <p class="mx-auto mt-2 max-w-md text-ui text-muted">
              {tr('admin.competitions.noSubmissionsHint', { link: `/k/${c.slug}` })}
            </p>
          </div>
        {:else}
          <div class="feed-head flex items-center gap-4 border-b-2 border-ink py-2.5">
            <span class="w-[74px] shrink-0 {HEAD}">{tr('admin.competitions.col.when')}</span>
            <span class="w-[210px] shrink-0 {HEAD}">{tr('admin.competitions.col.entrant')}</span>
            <span class="w-[180px] shrink-0 {HEAD}">{tr('admin.competitions.col.outcome')}</span>
            <span class="min-w-0 flex-1 {HEAD}">{tr('admin.competitions.col.happened')}</span>
            <span class="w-[96px] shrink-0 text-right {HEAD}">{tr('admin.competitions.col.public')}</span>
            <span class="w-[104px] shrink-0 text-right text-micro font-bold uppercase tracking-caps text-primary">
              {tr('admin.competitions.col.private')}
            </span>
            <span class="w-[72px] shrink-0 text-right {HEAD}">{tr('admin.competitions.col.took')}</span>
            <span class="w-9 shrink-0"></span>
          </div>

          {#each rows as row (row.submission.id)}
            {@const s = row.submission}
            {@const badge = teacherBadge(s.state)}
            {@const broken = s.state === 'metricFailed'}
            <div
              class={cn('feed-row flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line py-3', broken && 'bg-danger/5')}
            >
              <span class="w-[74px] shrink-0 font-mono text-micro text-muted">
                {feedWhen(s.acceptedAt, now)}
              </span>
              <span class="w-[210px] shrink-0 truncate text-2xs font-semibold text-ink">
                {row.baseline ? tr('competitions.baselineEntrant') : row.entrantName} · #{s.number}
              </span>
              <span class="w-[180px] shrink-0">
                {#if badge}
                  <Badge word={badge.word} tone={badge.tone} form={badge.form} />
                {:else}
                  <!-- The running one and the queued ones live in the block at
                       the top: a second badge about the same thing is the
                       same thing twice. -->
                  <span class="text-micro text-muted">
                    {s.state === 'running'
                      ? tr('admin.competitions.stateRunning')
                      : tr('admin.competitions.stateQueued')}
                  </span>
                {/if}
              </span>
              <div class="min-w-0 flex-1 basis-[240px]">
                <p class={cn('text-2xs', broken ? 'text-ink' : 'text-muted')}>
                  {outcomeLine(row, row.best)}
                </p>
                {#if broken}
                  <!-- The metric traceback — here and only here: the person
                       looking at it is the one at fault, and only they can
                       fix it. -->
                  <div class="mt-2 flex flex-wrap items-start gap-4">
                    {#if s.teacherError}
                      <pre class="min-w-0 flex-1 basis-[280px] overflow-x-auto whitespace-pre-wrap
                                  font-mono text-micro leading-5 text-ink">{s.teacherError}</pre>
                    {/if}
                    <button
                      type="button"
                      class="btn-outline h-8 shrink-0 border-primary px-3 text-micro font-bold text-primary"
                      disabled={busy}
                      onclick={() => void rescoreAll()}
                    >
                      {tr('admin.competitions.fixAndRescore')}
                    </button>
                  </div>
                  <p class="mt-2 text-micro text-muted">
                    {tr('admin.competitions.entrantSees', { text: metricFailedNote() })}
                  </p>
                {/if}
              </div>
              <span class="w-[96px] shrink-0 text-right font-mono text-2xs {row.best ? 'font-bold text-ink' : 'text-ink'}">
                {@render caption(tr('admin.competitions.col.public'))}{metricNumber(s.publicScore)}
              </span>
              <span class="w-[104px] shrink-0 text-right font-mono text-2xs text-primary">
                {@render caption(tr('admin.competitions.col.private'))}{metricNumber(s.privateScore)}
              </span>
              <span class="w-[72px] shrink-0 text-right font-mono text-micro text-muted">
                {@render caption(tr('admin.competitions.col.took'))}{s.durationMs === null
                  ? '—'
                  : clock(s.durationMs)}
              </span>

              <div class="relative w-9 shrink-0 text-right">
                <button
                  type="button"
                  class="inline-flex h-8 w-8 items-center justify-center text-faint transition-colors
                         duration-100 hover:bg-raised hover:text-ink max-[640px]:h-11 max-[640px]:w-11"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === s.id}
                  aria-label={tr('admin.competitions.submissionMenu', { number: s.number })}
                  onclick={(event) => {
                    event.stopPropagation()
                    openMenu = openMenu === s.id ? null : s.id
                  }}
                >
                  <Icon name="more" size={13} />
                </button>
                {#if openMenu === s.id}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div
                    role="menu"
                    tabindex="-1"
                    class="row-menu absolute right-0 top-full z-20 mt-1 w-[260px] border border-line
                           bg-canvas py-1 text-left shadow-pop"
                    onclick={(event) => event.stopPropagation()}
                  >
                    <a
                      role="menuitem"
                      class={MENU_ITEM}
                      href={adminApi.submissionFileUrl(c.id, s.id, 'notebook.ipynb')}
                      target="_blank"
                      rel="noreferrer"
                      onclick={() => (openMenu = null)}
                    >
                      {tr('admin.competitions.menu.notebook')}
                    </a>
                    <button
                      type="button"
                      role="menuitem"
                      class={MENU_ITEM}
                      onclick={() => {
                        openMenu = null
                        void showDetail(s.id)
                      }}
                    >
                      {tr('admin.competitions.menu.output')}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class={MENU_ITEM}
                      onclick={() => {
                        openMenu = null
                        void rerun(s.id)
                      }}
                    >
                      {tr('admin.competitions.menu.rerun')}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class={MENU_ITEM}
                      onclick={() => {
                        openMenu = null
                        void rescoreOne(s.id)
                      }}
                    >
                      {tr('admin.competitions.menu.rescore')}
                    </button>
                    {#if adminAuth.isOwner}
                      <button
                        type="button"
                        role="menuitem"
                        class="{MENU_ITEM} text-danger"
                        onclick={() => {
                          openMenu = null
                          void drop(s.id)
                        }}
                      >
                        {tr('admin.competitions.menu.drop')}
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
          {/each}

          {#if feed.total > rows.length}
            <div class="flex items-center gap-3 py-3.5">
              <p class="min-w-0 flex-1 text-micro text-muted">
                {tr('admin.competitions.moreRows', { count: feed.total - rows.length })}
              </p>
              <button type="button" class="btn-outline shrink-0" onclick={() => void loadFeed(true)}>
                {tr('admin.competitions.showAll')}
              </button>
            </div>
          {/if}

          <p class="py-3.5 text-micro leading-snug text-muted">{tr('admin.competitions.feedNote')}</p>
        {/if}
      </div>
    </div>
  {/if}
</AdminPage>

{#if detail}
  {@const shown = detail}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="submission-detail-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card flex max-h-[80vh] w-full max-w-[720px] flex-col border border-line bg-canvas shadow-pop">
      <div class="flex items-start gap-4 border-b border-line px-5 py-4">
        <div class="min-w-0 flex-1">
          <h2 id="submission-detail-title" class="text-title font-semibold text-ink">
            {shown.entrant.name} · #{shown.submission.number}
          </h2>
          <p class="mt-0.5 truncate font-mono text-micro text-muted">{shown.submission.fileName}</p>
        </div>
        <button
          type="button"
          class="shrink-0 text-muted hover:text-ink"
          aria-label={tr('admin.cancel')}
          onclick={() => (detail = null)}
        >
          <Icon name="x" size={15} />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div class="flex flex-col gap-4">
          {#each shown.runs as run (run.id)}
            <div class="border border-line-soft px-3.5 py-3">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class={HEAD}>
                  {run.kind === 'metric'
                    ? tr('admin.competitions.runMetric')
                    : tr('admin.competitions.runNotebook')}
                </span>
                <span class="font-mono text-micro text-muted">#{run.seq}</span>
                <span class="font-mono text-micro text-muted">{run.verdict ?? '—'}</span>
                {#if run.container}
                  <span class="truncate font-mono text-micro text-faint">{run.container}</span>
                {/if}
                <span class="ml-auto font-mono text-micro text-muted">
                  {run.finishedAt === null ? '—' : spanWords(run.finishedAt - run.startedAt)}
                </span>
              </div>
              {#if run.teacherError}
                <pre class="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-micro leading-5 text-danger">{run.teacherError}</pre>
              {/if}
              {#if run.participantError}
                <p class="mt-2 text-micro text-warning">{run.participantError}</p>
              {/if}
            </div>
          {:else}
            <p class="text-ui text-muted">{tr('admin.competitions.noRuns')}</p>
          {/each}

          {#if shown.artifacts.length > 0}
            <div>
              <p class="pb-1.5 {HEAD}">{tr('admin.competitions.artifacts')}</p>
              {#each shown.artifacts as file (file.name)}
                <div class="flex items-center gap-3 border-b border-line-soft py-2 last:border-b-0">
                  <a
                    class="min-w-0 flex-1 truncate font-mono text-2xs text-accent-text hover:brightness-110"
                    href={adminApi.submissionFileUrl(c.id, shown.submission.id, file.name)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {file.name}
                  </a>
                  <span class="shrink-0 font-mono text-micro text-muted">{formatBytes(file.bytes)}</span>
                </div>
              {/each}
            </div>
          {:else}
            <p class="text-micro text-muted">{tr('admin.competitions.noArtifacts')}</p>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

{#if finishing}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="finish-competition-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[460px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="finish-competition-title" class="text-title font-semibold text-ink">
        {tr('admin.competitions.finishHeading', { name: c.title })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {c.privateRelease === 'auto'
          ? tr('admin.competitions.finishBodyAuto')
          : tr('admin.competitions.finishBodyManual')}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger" role="alert">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (finishing = false)}>
          {tr('admin.cancel')}
        </button>
        <button
          type="button"
          class="btn bg-danger text-white dark:text-canvas hover:brightness-110 disabled:opacity-40"
          disabled={busy}
          onclick={() => void finish()}
        >
          {tr('admin.competitions.finishNow')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /*
   * The feed on a narrow screen: eight columns do not fit into 320 pixels in
   * any form, and column widths there mean eight stacks forty pixels each.
   * The threshold goes by the width of the feed itself, as in the
   * competitions list.
   */
  .comp-feed {
    container-type: inline-size;
  }

  .feed-label {
    display: none;
  }

  @container (max-width: 900px) {
    .feed-head {
      display: none;
    }

    .feed-row > span,
    .feed-row > div {
      width: auto;
      min-width: 0;
      text-align: left;
    }

    .feed-label {
      display: inline;
    }

    /*
     * "SHIFT" goes first: it is the only leaderboard column read not for the
     * number but for the arrow — and it is also the only one whose absence
     * does not get in the way of understanding the table.
     */
    .feed-shift {
      display: none;
    }
  }
</style>
