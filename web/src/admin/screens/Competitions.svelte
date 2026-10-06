<!--
  Competitions: the list (A1) and the door into one of them.

  A competition is a task with answers the entrant does not see. The list
  answers the one question people come here for in the middle of a class:
  what is wrong with each of them right now. So a row holds not only numbers
  but also the reason — the baseline has not passed its check, the deadline
  is burning, the metric crashed.

  The screen for a single competition is chosen by its state, not by a
  separate address: a draft opens in the editor (A2), a live or finished one
  in the console (A3). The same way a click on the row opens them.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { onMount, tick } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import EmptyState from '@/admin/ui/EmptyState.svelte'
  import SearchField from '@/admin/ui/SearchField.svelte'
  import Editor from '@/admin/screens/competitions/Editor.svelte'
  import Live, { type LiveTab } from '@/admin/screens/competitions/Live.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { cn } from '@/lib/utils'
  import {
    competitionPath,
    competitionPhase,
    LIMITS,
    parseSlug,
    phaseWord,
    slugRefusal,
    submissionsOpen,
    type CompetitionPhase,
  } from '@shared/competitions'
  import { suggestSlug } from '@shared/publish'
  import type { CompetitionRow, CompetitionView, CompetitionsList } from '@shared/competitions-api'
  import {
    baselineNote,
    bestLine,
    count,
    deadlineLine,
    metricLine,
    metricNumber,
    phaseTone,
    runnerLine,
  } from '@/admin/competitions'

  interface Props {
    /** The open competition if the address names one; `new` is the creation form. */
    open: string | null
    /** The console tab: the address carries it too. */
    tab?: LiveTab
    navigate: (path: string) => void
  }

  let { open, tab = 'submissions', navigate }: Props = $props()

  let list = $state<CompetitionsList | null>(null)
  let view = $state<CompetitionView | null>(null)
  let loadingList = $state(true)
  let loadingOne = $state(false)
  let errorText = $state<(() => string) | null>(null)
  const error = $derived(errorText?.() ?? null)
  let busy = $state(false)
  let query = $state('')
  let copied = $state<string | null>(null)
  let openMenu = $state<string | null>(null)
  let doomed = $state<CompetitionRow | null>(null)
  /** The list's clock: "1 h 12 min left" has to count down by itself. */
  let now = $state(Date.now())

  const explain = (cause: unknown): string =>
    cause instanceof AdminApiError ? cause.message : tr('admin.competitions.requestFailed')

  function lost(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') {
      void adminAuth.refresh('revoked')
    }
  }

  async function loadList(): Promise<void> {
    loadingList = true
    try {
      list = await adminApi.listCompetitions()
      // The number in the rail comes from here: otherwise the shell asks for
      // the same list a second time during the same navigation.
      navCounts.competitions = list.competitions.length
      errorText = null
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
    } finally {
      loadingList = false
    }
  }

  async function loadOne(id: string): Promise<void> {
    loadingOne = true
    try {
      view = await adminApi.competition(id)
      errorText = null
    } catch (cause) {
      lost(cause)
      // An empty area where the competition should be is not an answer:
      // people arrive at this address from a chat, even a week later, when
      // it may already be gone.
      view = null
      errorText = () => explain(cause)
    } finally {
      loadingOne = false
    }
  }

  /*
   * One load per opening. The list is needed on a single competition's
   * screen too — there is one runner strip per instance — but there is no
   * point in fetching it with a second request: the competition screen keeps
   * its queue as a live stream.
   */
  $effect(() => {
    const id = open
    if (id !== null && id !== 'new') {
      void loadOne(id)
      return
    }
    view = null
    void loadList()
  })

  /* The creation form is not an address: a half-typed title behind a link
     promises that it will stay there. But `/admin/competitions/new` gets
     typed by hand, and it must lead to the same place as the button. */
  let creating = $state(false)
  let draftTitle = $state('')
  let draftSlug = $state('')
  let slugTouched = $state(false)
  let titleField = $state<HTMLInputElement | null>(null)

  $effect(() => {
    if (open === 'new' && !creating) void startCreating()
  })

  const proposedSlug = $derived(slugTouched ? draftSlug : suggestSlug(draftTitle))

  async function startCreating(): Promise<void> {
    creating = true
    openMenu = null
    await tick()
    titleField?.focus()
  }

  async function create(): Promise<void> {
    const title = draftTitle.trim()
    const slug = parseSlug(proposedSlug)
    // busy is checked, not only set: the button greys out on it, but Enter
    // with auto-repeat does not, and half a second of holding it creates five
    // drafts.
    if (!title || busy) return
    if (!slug) {
      const why = slugRefusal(proposedSlug) ?? 'chars'
      errorText = () => tr(`competitions.refusal.slug.${why}`)
      return
    }
    busy = true
    errorText = null
    try {
      const made = await adminApi.createCompetition({ title, slug })
      // The list keeps the counter in the rail, and we are about to leave the
      // list: without this line "Competitions" kept showing zero until you
      // came back.
      navCounts.competitions = (navCounts.competitions ?? 0) + 1
      creating = false
      draftTitle = ''
      draftSlug = ''
      slugTouched = false
      navigate(`/admin/competitions/${made.competition.id}`)
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
    } finally {
      busy = false
    }
  }

  async function togglePause(): Promise<void> {
    if (!list || busy) return
    busy = true
    try {
      const queue = await adminApi.pauseCompetitionQueue(!list.queue.paused)
      list = { ...list, queue }
      errorText = null
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
    } finally {
      busy = false
    }
  }

  async function destroy(): Promise<void> {
    const going = doomed
    if (!going || busy) return
    busy = true
    errorText = null
    try {
      await adminApi.deleteCompetition(going.competition.id)
      doomed = null
      await loadList()
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
    } finally {
      busy = false
    }
  }

  async function copy(text: string, key: string): Promise<void> {
    try {
      await copyText(text)
    } catch {
      // The clipboard is closed (the panel over http on another host is the
      // usual thing for a department's instance): the link is then shown in
      // words instead of staying silent.
      errorText = () => tr('admin.competitions.copyFailed', { link: text })
      return
    }
    copied = key
    setTimeout(() => (copied = copied === key ? null : copied), 1600)
  }

  const shown = $derived.by(() => {
    const rows = list?.competitions ?? []
    const needle = query.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(
      (row) =>
        row.competition.title.toLowerCase().includes(needle) ||
        row.competition.slug.toLowerCase().includes(needle) ||
        row.competition.metric.name.toLowerCase().includes(needle) ||
        (row.course?.name.toLowerCase().includes(needle) ?? false),
    )
  })

  /*
   * Groups by phase, as the participants' list has them (Paper 07 · D2):
   * running ones first, then drafts, then the finished — a competition past
   * its deadline among the finished even before anyone presses «Завершить».
   * Empty groups are not drawn.
   */
  const GROUPS: { key: 'open' | 'draft' | 'over'; has: (phase: CompetitionPhase) => boolean }[] = [
    { key: 'open', has: (phase) => phase === 'open' || phase === 'soon' },
    { key: 'draft', has: (phase) => phase === 'draft' },
    { key: 'over', has: (phase) => phase === 'over' },
  ]
  /** Inside a group: on-time intake before «скоро», late intake before closed — what still moves first. */
  const weight = (row: CompetitionRow): number => {
    const c = row.competition
    return competitionPhase(c, now) === 'soon' || (competitionPhase(c, now) === 'over' && submissionsOpen(c, now) !== 'late') ? 1 : 0
  }
  const groups = $derived(
    GROUPS.map((group) => ({
      key: group.key,
      rows: shown
        .filter((row) => group.has(competitionPhase(row.competition, now)))
        .sort((a, b) => weight(a) - weight(b)),
    })).filter((group) => group.rows.length > 0),
  )

  onMount(() => {
    // Half a minute: the deadline line counts hours and minutes, and a second
    // here would redraw the whole list for a digit that is not on the screen.
    const tick = window.setInterval(() => (now = Date.now()), 30_000)
    const close = () => (openMenu = null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') openMenu = null
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(tick)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  })

</script>

<!--
  A column caption that moves into the row once there are no columns left.

  On a narrow screen the header is hidden, and without captions "28 · 143 ·
  0.0412" is three numbers with no names: the list of classes has been
  through exactly this already (admin-phone).
-->
{#snippet caption(label: string)}
  <span class="comp-label admin-label mr-1.5 font-sans">{label}</span>
{/snippet}

{#if open !== null && open !== 'new'}
  {#if view}
    {#if view.competition.state === 'draft'}
      <Editor {view} {navigate} onview={(fresh) => (view = fresh)} />
    {:else}
      <Live {view} {tab} {navigate} onview={(fresh) => (view = fresh)} />
    {/if}
  {:else}
    <!-- There is no competition at this address. Links to it get shared with
         colleagues, so people will come here by a stale one — and an empty
         area without words would be the only thing they saw here. -->
    <AdminPage title={tr('competitions.title')}>
      {#if loadingOne}
        <p class="py-16 text-center text-ui text-muted">{tr('competitions.loading')}</p>
      {:else}
        <EmptyState
          title={tr('admin.competitions.notOpened')}
          hint={error ?? tr('admin.competitions.checkAddress')}
        >
          <button type="button" class="btn-primary" onclick={() => navigate('/admin/competitions')}>
            {tr('admin.competitions.all')}
          </button>
        </EmptyState>
      {/if}
    </AdminPage>
  {/if}
{:else}
  <AdminPage title={tr('competitions.title')} subtitle={tr('admin.competitions.lede')}>
    {#snippet actions()}
      <SearchField label={tr('admin.competitions.search')} bind:value={query} />
      <button
        type="button"
        class="btn-primary btn-caps gap-2 px-4 max-[640px]:w-full"
        onclick={() => void startCreating()}
      >
        <Icon name="plus" size={14} />
        {tr('admin.competitions.new')}
      </button>
    {/snippet}

    <!--
      The runner strip: the state of the INSTANCE's queue, one for all
      competitions.

      It sits above the table rather than in each competition's row, because
      there is one runner: two rows with different numbers about the same
      queue make a screen people stop trusting.
    -->
    {#if list}
      {@const line = runnerLine(list.queue)}
      <div
        class="-mx-7 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-b border-line bg-surface
               px-7 py-3"
      >
        <span
          class={cn('h-2 w-2 shrink-0', list.queue.paused ? 'bg-faint' : 'bg-accent')}
          aria-hidden="true"
        ></span>
        <span class="admin-label shrink-0 text-primary">{tr('admin.competitions.runner')}</span>
        <span class="text-2xs text-ink">{line.head}</span>
        <span class="min-w-0 text-2xs text-muted">{line.tail}</span>
        <!-- One queue for the whole instance: pausing it is the owner's. -->
        {#if adminAuth.isOwner}
          <button
            type="button"
            class="admin-link ml-auto shrink-0"
            disabled={busy}
            onclick={() => void togglePause()}
          >
            {list.queue.paused
              ? tr('admin.competitions.resumeQueue')
              : tr('admin.competitions.pauseQueue')}
          </button>
        {/if}
      </div>
    {/if}

    <div class="py-1">
      {#if error && !creating}
        <div class="flex flex-wrap items-center gap-3 py-4">
          <p class="min-w-0 flex-1 text-ui text-danger">{error}</p>
          <button type="button" class="btn-outline shrink-0" onclick={() => void loadList()}>
            {tr('admin.try.again')}
          </button>
        </div>
      {/if}

      {#if creating}
        <!-- Created as a draft: the address and the title are needed right
             away (they are what people look it up by, both in the list and in
             a chat), the rest is edited in the editor. -->
        <div class="mb-5 mt-4 flex flex-wrap items-center gap-3 border border-line bg-surface px-4 py-3">
          <input
            bind:this={titleField}
            class="field min-w-0 flex-[3_1_240px]"
            placeholder={tr('admin.competitions.titlePlaceholder')}
            aria-label={tr('admin.competitions.titleLabel')}
            maxlength={LIMITS.title}
            bind:value={draftTitle}
            onkeydown={(event) => {
              if (event.key === 'Enter') void create()
              if (event.key === 'Escape') creating = false
            }}
          />
          <div class="admin-affix flex-[1_1_200px]">
            <span class="shrink-0 font-mono text-2xs text-muted">/k/</span>
            <input
              aria-label={tr('admin.competitions.slugLabel')}
              maxlength={LIMITS.slug}
              value={proposedSlug}
              oninput={(event) => {
                slugTouched = true
                draftSlug = event.currentTarget.value
              }}
              onkeydown={(event) => {
                if (event.key === 'Enter') void create()
                if (event.key === 'Escape') creating = false
              }}
            />
          </div>
          <button
            type="button"
            class="btn-primary shrink-0"
            disabled={busy || !draftTitle.trim()}
            onclick={() => void create()}
          >
            {tr('admin.competitions.createDraft')}
          </button>
          <button
            type="button"
            class="btn-ghost shrink-0"
            onclick={() => {
              creating = false
              errorText = null
              if (open === 'new') navigate('/admin/competitions')
            }}
          >
            {tr('admin.cancel')}
          </button>
          {#if error}
            <p class="basis-full text-ui text-danger" role="alert">{error}</p>
          {/if}
        </div>
      {/if}

      {#if loadingList && !list}
        <RowsSkeleton label={tr('competitions.loading')} />
      {:else if shown.length === 0}
        {#if query.trim()}
          <EmptyState title={tr('admin.competitions.noMatch', { query: query.trim() })} />
        {:else}
          <EmptyState title={tr('admin.competitions.none')} hint={tr('admin.competitions.noneHint')}>
            {#if !creating}
              <button type="button" class="btn-primary" onclick={() => void startCreating()}>
                {tr('admin.competitions.new')}
              </button>
            {/if}
          </EmptyState>
        {/if}
      {:else}
        <div class="comp-rows">
          <div class="comp-head admin-list-head">
            <span class="admin-label min-w-0 flex-1">{tr('admin.competitions.col.competition')}</span>
            <span class="comp-cell admin-label w-[196px] shrink-0">{tr('admin.competitions.col.status')}</span>
            <span class="comp-cell admin-label w-[176px] shrink-0">{tr('admin.competitions.col.deadline')}</span>
            <span class="comp-cell admin-label w-[104px] shrink-0 text-right">
              {tr('admin.competitions.col.entrants')}
            </span>
            <span class="comp-cell admin-label w-[88px] shrink-0 text-right">
              {tr('admin.competitions.col.submissions')}
            </span>
            <span class="comp-cell admin-label w-[200px] shrink-0 text-right">
              {tr('admin.competitions.col.bestPublic')}
            </span>
            <span class="w-10 shrink-0"></span>
          </div>

          {#each groups as group (group.key)}
          <div class="comp-group">
            <span class="admin-label text-ink">{tr(`admin.competitions.group.${group.key}`)}</span>
            <span class="font-mono text-micro text-muted">{group.rows.length}</span>
          </div>
          {#each group.rows as row (row.competition.id)}
            {@const c = row.competition}
            {@const phase = competitionPhase(c, now)}
            {@const deadline = deadlineLine(c, now, row.ready)}
            {@const baseline = baselineNote(row)}
            {@const best = bestLine(row, now)}
            {@const draft = c.state === 'draft'}
            {@const late = submissionsOpen(c, now) === 'late'}
            <div class="comp-row admin-list-row">
              <button
                type="button"
                class="comp-name min-w-0 flex-1 text-left"
                onclick={() => navigate(`/admin/competitions/${c.id}`)}
              >
                <p class="admin-row-title truncate">{c.title}</p>
                <p class="mt-1 flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5">
                  <span class="admin-meta font-mono">/k/{c.slug}</span>
                  {#if row.course}
                    <span class="admin-meta min-w-0 truncate">{tr('admin.competitions.courseMeta', { name: row.course.name })}</span>
                  {/if}
                  <span class="admin-meta min-w-0">{metricLine(row, now)}</span>
                </p>
              </button>

              <div class="comp-cell w-[196px] shrink-0">
                <Badge word={phaseWord(phase)} tone={phaseTone(phase)} />
                {#if late}
                  <!-- Intake for the standings is over, the door is not: said
                       in the row, since nothing else in it moves any more. -->
                  <p class="mt-1.5 flex items-center gap-1.5 whitespace-nowrap text-micro font-semibold text-accent-text">
                    <span class="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true"></span>
                    {row.late
                      ? tr('admin.competitions.lateLine', { count: count(row.late) })
                      : tr('admin.competitions.lateLineNone')}
                  </p>
                {/if}
              </div>

              <div class="comp-cell w-[176px] shrink-0">
                <p class="truncate text-2xs text-ink">{deadline.when}</p>
                <p
                  class={cn(
                    'mt-0.5 truncate text-micro',
                    deadline.hot ? 'font-bold text-warning' : 'text-muted',
                  )}
                >
                  {deadline.note}
                </p>
              </div>

              <!-- A draft has no numbers at all: zero entrants and zero
                   submissions would be a claim about a class that has not
                   been shown the competition yet. A dash tells the truth. -->
              <span class="comp-cell admin-num w-[104px] shrink-0 text-right">
                {@render caption(tr('admin.competitions.col.entrants'))}{draft
                  ? '—'
                  : count(row.entrants)}
              </span>
              <span class="comp-cell admin-num w-[88px] shrink-0 text-right">
                {@render caption(tr('admin.competitions.col.submissions'))}{draft
                  ? '—'
                  : count(row.submissions)}
              </span>

              <div class="comp-cell w-[200px] shrink-0 text-right">
                <p class="admin-num font-bold">
                  {@render caption(tr('admin.competitions.col.bestPublic'))}{draft
                    ? '—'
                    : metricNumber(best.score)}
                </p>
                {#if best.note}
                  <p class="mt-0.5 truncate text-micro text-muted">{best.note}</p>
                {:else}
                  <p class={cn('mt-0.5 truncate text-micro', baseline.bad ? 'text-danger' : 'text-muted')}>
                    {baseline.text}
                  </p>
                {/if}
              </div>

              <div class="relative w-10 shrink-0 text-right">
                <button
                  type="button"
                  class="admin-icon-btn"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === c.id}
                  aria-label={tr('admin.competitions.rowMenu', { name: c.title })}
                  onclick={(event) => {
                    event.stopPropagation()
                    openMenu = openMenu === c.id ? null : c.id
                  }}
                >
                  <Icon name="more" size={15} />
                </button>
                {#if openMenu === c.id}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div
                    role="menu"
                    tabindex="-1"
                    class="row-menu admin-menu absolute right-0 top-full z-20 mt-1 w-[240px]"
                    onclick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      class="admin-menu-item"
                      onclick={() => {
                        openMenu = null
                        navigate(`/admin/competitions/${c.id}`)
                      }}
                    >
                      {draft ? tr('admin.competitions.menu.editor') : tr('admin.competitions.menu.open')}
                    </button>
                    {#if !draft}
                      <a
                        role="menuitem"
                        class="admin-menu-item"
                        href={competitionPath(c.slug)}
                        target="_blank"
                        rel="noreferrer"
                        onclick={() => (openMenu = null)}
                      >
                        {tr('admin.competitions.menu.entrantPage')}
                      </a>
                      <button
                        type="button"
                        role="menuitem"
                        class="admin-menu-item"
                        onclick={() => {
                          openMenu = null
                          void copy(`${location.origin}${competitionPath(c.slug)}`, c.id)
                        }}
                      >
                        {copied === c.id ? tr('admin.copied') : tr('admin.copy.link')}
                      </button>
                    {/if}
                    {#if adminAuth.isOwner}
                      <!-- Deleting also takes the directory with the answers.
                           Owner only, and behind a confirmation. -->
                      <button
                        type="button"
                        role="menuitem"
                        class="admin-menu-item text-danger"
                        onclick={() => {
                          openMenu = null
                          doomed = row
                        }}
                      >
                        {tr('admin.competitions.menu.delete')}
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
          {/each}

          <p class="admin-meta py-3.5">
            {tr('admin.competitions.countAll', { count: list?.competitions.length ?? 0 })} ·
            {tr('admin.competitions.seenAt')}
          </p>
        </div>
      {/if}
    </div>
  </AdminPage>
{/if}

{#if doomed}
  {@const going = doomed.competition}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="delete-competition-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[460px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="delete-competition-title" class="text-title font-semibold text-ink">
        {tr('admin.competitions.deleteHeading', { name: going.title })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr('admin.competitions.deleteBody', { count: doomed.submissions })}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger" role="alert">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (doomed = null)}>
          {tr('admin.cancel')}
        </button>
        <button type="button" class="btn-danger-solid" disabled={busy} onclick={() => void destroy()}>
          {tr('admin.competitions.deleteConfirm')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /*
   * The narrow table: the title on its own line, the rest below it.
   *
   * The threshold goes by the width of the list itself, not the window: the
   * panel's rail takes 236px on a desktop and 56 on a phone, so the same
   * window width leaves the list a different amount of room. 940px is six
   * columns (196 + 176 + 104 + 88 + 200 + 40), five gaps and at least
   * something for the title.
   */
  .comp-rows {
    container-type: inline-size;
  }

  /* A phase group's heading: a word and a count over an ink rule, as the
     sections of the participants' list (D1, D2). */
  .comp-group {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 1.125rem 0 0.5rem;
    border-bottom: 1px solid rgb(var(--ink));
  }

  .comp-label {
    display: none;
  }

  @container (max-width: 940px) {
    .comp-row {
      flex-wrap: wrap;
      align-items: flex-start;
      row-gap: 0.5rem;
    }

    /* The title takes the whole first line, except the room for the menu. */
    .comp-name {
      flex-basis: calc(100% - 56px);
    }

    /* The cells line up in a row below it and share the rest by content:
       their own column widths here would mean six columns in 320 pixels. */
    .comp-cell {
      width: auto;
      min-width: 0;
      text-align: left;
    }

    /* A column header without columns means nothing. */
    .comp-head {
      display: none;
    }

    /* Instead, the captions move into the row itself. */
    .comp-label {
      display: inline;
    }
  }
</style>
