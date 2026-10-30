<!--
  Contests: the list (Paper 19 · A1) and the door into one of them.

  A contest is a set of problems a judge runs code against; the list answers
  what a teacher comes here for in the middle of a week: which contest is
  live and how far along the class is, which is about to start and whether
  its references pass, which draft still cannot open and why. Groups by
  phase — ИДУТ, СКОРО, ЧЕРНОВИКИ, ЗАВЕРШЁННЫЕ — on the list's own clock, so a
  contest moves from «скоро» to «идут» at its start without a reload.

  Above the table, the judge: one per instance, shared by every contest, so
  it is a strip of its own rather than a number in each row (two rows with
  different numbers about the same queue make a screen nobody trusts).

  One contest opens by its state, as a competition does: a draft in the
  editor (A2), a live or finished one in the console (A4); a problem of
  either in its own editor (A3), at its own address.
-->
<script lang="ts">
  import { formatNumber, tr } from '@shared/i18n'
  import { onMount, tick, untrack } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import EmptyState from '@/admin/ui/EmptyState.svelte'
  import SearchField from '@/admin/ui/SearchField.svelte'
  import Check from '@/admin/ui/Check.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import ContestEditor from '@/admin/screens/contests/ContestEditor.svelte'
  import ContestLive from '@/admin/screens/contests/ContestLive.svelte'
  import ProblemEditor from '@/admin/screens/contests/ProblemEditor.svelte'
  import ConfirmDialog from '@/admin/screens/contests/ConfirmDialog.svelte'
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { cn } from '@/lib/utils'
  import { CONTEST_LIMITS, JUDGE_SLOTS, contestPath, contestPhase, parseContestSlug } from '@shared/contests'
  import type { ContestList, ContestListRow, ContestSettings, ContestView } from '@shared/contests-api'
  import {
    averageWords,
    contestMeta,
    contestSlugFor,
    contestSlugRefusal,
    groupContests,
    judgeLine,
    phaseBadge,
    stateNote,
    windowLine,
    type ContestTab,
  } from '@/admin/contests'

  interface Props {
    /** The open contest if the address names one; `new` is the creation form. */
    open: string | null
    /** The console's tab: the address carries it too. */
    tab?: ContestTab
    /** The problem open in its editor (A3). */
    problem?: string | null
    navigate: (path: string) => void
  }

  let { open, tab = 'submissions', problem = null, navigate }: Props = $props()

  let list = $state<ContestList | null>(null)
  let view = $state<ContestView | null>(null)
  let loadingList = $state(true)
  let loadingOne = $state(false)
  let errorText = $state<(() => string) | null>(null)
  const error = $derived(errorText?.() ?? null)
  let busy = $state(false)
  let query = $state('')
  let openMenu = $state<string | null>(null)
  let copied = $state<string | null>(null)
  /** The list's clock: «осталось 52 мин» counts down by itself. */
  let now = $state(Date.now())

  const explain = (cause: unknown): string =>
    cause instanceof AdminApiError ? cause.message : tr('admin.contests.requestFailed')

  function lost(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
  }

  async function loadList(): Promise<void> {
    loadingList = true
    try {
      list = await adminApi.contests.list()
      // The rail's number comes from here: the shell would otherwise ask the
      // same list a second time during the same navigation.
      navCounts.contests = list.contests.length
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
      view = await adminApi.contests.get(id)
      errorText = null
    } catch (cause) {
      lost(cause)
      // People arrive at a contest's address from a chat a week later: an
      // empty area is not an answer, a sentence is.
      view = null
      errorText = () => explain(cause)
    } finally {
      loadingOne = false
    }
  }

  /*
   * One load per opening. Moving between a contest's tabs and its problems
   * keeps the same `open`, and the view in hand: the editors and the
   * console hand every fresh snapshot up through `onview`.
   */
  $effect(() => {
    const id = open
    if (id !== null && id !== 'new') {
      // The view is read untracked: a failed load sets it to null, and a
      // tracked read would ask again at once, forever.
      if (untrack(() => view)?.contest.id !== id) void loadOne(id)
      return
    }
    view = null
    void loadList()
  })

  /* ----------------------------------------------------------- creating */

  /* Not an address: a half-typed title behind a link promises it will stay.
     `/admin/contests/new` typed by hand leads to the same form. */
  let creating = $state(false)
  let draftTitle = $state('')
  let draftSlug = $state('')
  let slugTouched = $state(false)
  let titleField = $state<HTMLInputElement | null>(null)

  $effect(() => {
    if (open === 'new' && !creating) void startCreating()
  })

  const proposedSlug = $derived(slugTouched ? draftSlug : contestSlugFor(draftTitle))

  async function startCreating(): Promise<void> {
    creating = true
    openMenu = null
    await tick()
    titleField?.focus()
  }

  function stopCreating(): void {
    creating = false
    errorText = null
    if (open === 'new') navigate('/admin/contests')
  }

  async function create(): Promise<void> {
    const title = draftTitle.trim()
    // `busy` is checked, not only shown: Enter with auto-repeat does not
    // grey out, and half a second of holding it made five drafts.
    if (!title || busy) return
    const slug = parseContestSlug(proposedSlug)
    if (!slug) {
      const why = contestSlugRefusal(proposedSlug)
      errorText = () => why ?? tr('admin.contests.slug.chars')
      return
    }
    busy = true
    errorText = null
    try {
      const made = await adminApi.contests.create({ title, slug })
      navCounts.contests = (navCounts.contests ?? 0) + 1
      creating = false
      draftTitle = ''
      draftSlug = ''
      slugTouched = false
      view = made
      navigate(`/admin/contests/${encodeURIComponent(made.contest.id)}`)
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
    } finally {
      busy = false
    }
  }

  /* ------------------------------------------------------------ the judge */

  async function togglePause(): Promise<void> {
    if (!list || busy) return
    busy = true
    try {
      const judge = await adminApi.contests.pauseJudge(!list.judge.paused)
      list = { ...list, judge }
      errorText = null
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
    } finally {
      busy = false
    }
  }

  /** The slots editor under the strip (owner only): a number, or «авто» — half the CPUs. */
  let settings = $state<ContestSettings | null>(null)
  let slotsOpen = $state(false)
  let slotsAuto = $state(true)
  let slotsValue = $state<number | null>(null)
  let slotsError = $state<string | null>(null)

  async function openSlots(): Promise<void> {
    slotsOpen = !slotsOpen
    slotsError = null
    if (!slotsOpen) return
    try {
      settings = await adminApi.contests.settings()
      slotsAuto = settings.judgeSlots === null
      slotsValue = settings.judgeSlots ?? settings.autoSlots
    } catch (cause) {
      lost(cause)
      slotsError = explain(cause)
    }
  }

  async function saveSlots(): Promise<void> {
    if (busy) return
    const value = Number(slotsValue)
    if (!slotsAuto && (!Number.isInteger(value) || value < JUDGE_SLOTS.min || value > JUDGE_SLOTS.max)) {
      slotsError = tr('admin.contests.judge.slotsRange', { min: JUDGE_SLOTS.min, max: JUDGE_SLOTS.max })
      return
    }
    busy = true
    slotsError = null
    try {
      settings = await adminApi.contests.saveSettings({ judgeSlots: slotsAuto ? null : value })
      slotsOpen = false
      await loadList()
    } catch (cause) {
      lost(cause)
      slotsError = explain(cause)
    } finally {
      busy = false
    }
  }

  /* ------------------------------------------------------------- the rows */

  const groups = $derived(groupContests(list?.contests ?? [], now, query))
  const shownCount = $derived(groups.reduce((sum, group) => sum + group.rows.length, 0))

  /** Deleting takes the problems, the tests and every submission: the owner or the contest's author. */
  function mayDelete(row: ContestListRow): boolean {
    return adminAuth.isOwner || (row.contest.createdBy !== null && row.contest.createdBy === adminAuth.me?.teacher.id)
  }

  let doomed = $state<ContestListRow | null>(null)
  let deleteError = $state<string | null>(null)

  async function destroy(): Promise<void> {
    const going = doomed
    if (!going || busy) return
    busy = true
    deleteError = null
    try {
      await adminApi.contests.remove(going.contest.id)
      doomed = null
      await loadList()
    } catch (cause) {
      lost(cause)
      deleteError = explain(cause)
    } finally {
      busy = false
    }
  }

  async function setHidden(row: ContestListRow, hidden: boolean): Promise<void> {
    if (busy) return
    busy = true
    try {
      await (hidden ? adminApi.contests.hide(row.contest.id) : adminApi.contests.show(row.contest.id))
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
      errorText = () => tr('admin.contests.copyFailed', { link: text })
      return
    }
    copied = key
    setTimeout(() => (copied = copied === key ? null : copied), 1600)
  }

  onMount(() => {
    const clock = window.setInterval(() => (now = Date.now()), 30_000)
    const close = () => (openMenu = null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') openMenu = null
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(clock)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  })

  const NOTE_TONE = { brand: 'text-brand-2 dark:text-accent', warning: 'text-warning', accent: 'text-accent-text', muted: 'text-muted' } as const
</script>

<!-- A column caption that moves into the row once there are no columns:
     «34 · 187» on a phone is two numbers with no names otherwise. -->
{#snippet caption(label: string)}
  <span class="contest-label admin-label mr-1.5 font-sans">{label}</span>
{/snippet}

{#if open !== null && open !== 'new'}
  {#if view && view.contest.id === open}
    {#if problem}
      <ProblemEditor {view} problemId={problem} {navigate} onview={(fresh) => (view = fresh)} />
    {:else if view.contest.state === 'draft'}
      <ContestEditor {view} {navigate} onview={(fresh) => (view = fresh)} />
    {:else}
      <ContestLive {view} {tab} {navigate} onview={(fresh) => (view = fresh)} />
    {/if}
  {:else if loadingOne || (view === null && error === null)}
    <!-- The contest is on its way: its header is the same whatever it turns
         out to be, the body below (an editor or a console) is the answer. -->
    <AdminPage title={tr('admin.contests.title')}>
      {#snippet eyebrow()}
        <button type="button" class="shrink-0 transition-colors duration-100 hover:text-ink" onclick={() => navigate('/admin/contests')}>
          {tr('admin.contests.title')}
        </button>
        <span aria-hidden="true">/</span>
      {/snippet}
      {#snippet lede()}
        <span class="inline-flex h-[22px] basis-full items-center" aria-hidden="true"><Skeleton width="15rem" height="0.8rem" /></span>
        <span class="inline-flex h-[22px] items-center" aria-hidden="true"><Skeleton width="13rem" height="0.8rem" /></span>
      {/snippet}
      {#snippet actions()}
        {#each ['132px', '176px'] as width, i (i)}
          <span class="block h-10 max-[640px]:h-11 max-[640px]:grow" style:width aria-hidden="true">
            <Skeleton width="100%" height="100%" radius="0" />
          </span>
        {/each}
      {/snippet}
      <div role="status" aria-busy="true" aria-label={tr('admin.contests.loadingOne')}>
        <span class="sr-only">{tr('admin.contests.loadingOne')}</span>
      </div>
    </AdminPage>
  {:else}
    <AdminPage title={tr('admin.contests.title')}>
      <EmptyState title={tr('admin.contests.notOpened')} hint={error ?? tr('admin.contests.checkAddress')}>
        <button type="button" class="btn-primary" onclick={() => navigate('/admin/contests')}>
          {tr('admin.contests.all')}
        </button>
      </EmptyState>
    </AdminPage>
  {/if}
{:else}
  <AdminPage title={tr('admin.contests.title')} subtitle={tr('admin.contests.lede')}>
    {#snippet actions()}
      <SearchField label={tr('admin.contests.search')} placeholder={tr('admin.contests.searchPlaceholder')} bind:value={query} />
      <button type="button" class="btn-primary btn-caps gap-2 px-4 max-[640px]:w-full" onclick={() => void startCreating()}>
        <Icon name="plus" size={14} />
        {tr('admin.contests.new')}
      </button>
    {/snippet}

    <!-- The judge strip: one judge for the instance (A1). -->
    {#if list}
      {@const line = judgeLine(list.judge)}
      <div class="-mx-7 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-b border-line bg-surface px-7 py-3">
        <span class={cn('h-2 w-2 shrink-0', line.lit ? 'bg-accent' : 'bg-faint')} aria-hidden="true"></span>
        <span class="admin-label shrink-0 text-primary">{tr('admin.contests.judge.head')}</span>
        <span class="text-2xs text-ink">{line.head}</span>
        {#if line.slots}
          {#if adminAuth.isOwner}
            <button type="button" class="admin-link text-muted" aria-expanded={slotsOpen} onclick={() => void openSlots()}>
              {line.slots}
            </button>
          {:else}
            <span class="text-2xs text-muted">{line.slots}</span>
          {/if}
        {/if}
        <span class="min-w-0 text-2xs text-muted">{line.tail}</span>
        {#if adminAuth.isOwner && list.judge.backend !== 'none'}
          <button type="button" class="admin-link ml-auto shrink-0" disabled={busy} onclick={() => void togglePause()}>
            {list.judge.paused ? tr('admin.contests.judge.resume') : tr('admin.contests.judge.pause')}
          </button>
        {/if}
      </div>
      {#if slotsOpen}
        <div class="-mx-7 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-7 py-3">
          <span class="admin-label">{tr('admin.contests.judge.slotsLabel')}</span>
          <label class="flex cursor-pointer items-center gap-2">
            <Check bind:checked={slotsAuto} label={tr('admin.contests.judge.auto')} />
            <span class="text-2xs text-ink">
              {settings ? tr('admin.contests.judge.autoHint', { count: settings.autoSlots }) : tr('admin.contests.judge.auto')}
            </span>
          </label>
          <input
            class="field w-[96px] font-mono"
            type="number"
            min={JUDGE_SLOTS.min}
            max={JUDGE_SLOTS.max}
            disabled={slotsAuto}
            aria-label={tr('admin.contests.judge.slotsLabel')}
            bind:value={slotsValue}
          />
          <button type="button" class="btn-primary" disabled={busy || settings === null} onclick={() => void saveSlots()}>
            {tr('admin.contests.save')}
          </button>
          <button type="button" class="btn-ghost" onclick={() => (slotsOpen = false)}>{tr('admin.cancel')}</button>
          <span class="min-w-0 flex-1 basis-[240px] text-micro text-muted">{tr('admin.contests.judge.slotsHint')}</span>
          {#if slotsError}
            <p class="basis-full text-ui text-danger" role="alert">{slotsError}</p>
          {/if}
        </div>
      {/if}
    {:else if loadingList}
      <div class="-mx-7 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-b border-line bg-surface px-7 py-3" aria-hidden="true">
        <span class="h-2 w-2 shrink-0 bg-faint"></span>
        <span class="admin-label shrink-0 text-primary">{tr('admin.contests.judge.head')}</span>
        <span class="text-2xs"><Skeleton width="11rem" height="0.65rem" /></span>
        <span class="min-w-0 text-2xs"><Skeleton width="18rem" height="0.65rem" /></span>
      </div>
    {/if}

    <div class="py-1">
      {#if error && !creating}
        <div class="flex flex-wrap items-center gap-3 py-4">
          <p class="min-w-0 flex-1 text-ui text-danger">{error}</p>
          <button type="button" class="btn-outline shrink-0" onclick={() => void loadList()}>{tr('admin.try.again')}</button>
        </div>
      {/if}

      {#if creating}
        <!-- Made as a draft: the title and the address are what it is looked
             up by, in this list and in a chat; the rest is the editor's. -->
        <div class="mb-5 mt-4 flex flex-wrap items-center gap-3 border border-line bg-surface px-4 py-3">
          <input
            bind:this={titleField}
            class="field min-w-0 flex-[3_1_240px]"
            placeholder={tr('admin.contests.titlePlaceholder')}
            aria-label={tr('admin.contests.titleLabel')}
            maxlength={CONTEST_LIMITS.title}
            bind:value={draftTitle}
            onkeydown={(event) => {
              if (event.key === 'Enter') void create()
              if (event.key === 'Escape') stopCreating()
            }}
          />
          <div class="admin-affix flex-[1_1_200px]">
            <span class="shrink-0 font-mono text-2xs text-muted">/a/</span>
            <input
              aria-label={tr('admin.contests.slugLabel')}
              maxlength={64}
              spellcheck="false"
              autocapitalize="none"
              value={proposedSlug}
              oninput={(event) => {
                slugTouched = true
                draftSlug = event.currentTarget.value
              }}
              onkeydown={(event) => {
                if (event.key === 'Enter') void create()
                if (event.key === 'Escape') stopCreating()
              }}
            />
          </div>
          <button type="button" class="btn-primary shrink-0" disabled={busy || !draftTitle.trim()} onclick={() => void create()}>
            {tr('admin.contests.createDraft')}
          </button>
          <button type="button" class="btn-ghost shrink-0" onclick={stopCreating}>{tr('admin.cancel')}</button>
          {#if error}
            <p class="basis-full text-ui text-danger" role="alert">{error}</p>
          {/if}
        </div>
      {/if}

      {#if loadingList && !list}
        <RowsSkeleton label={tr('admin.contests.loading')} />
      {:else if shownCount === 0 && list}
        {#if query.trim()}
          <EmptyState title={tr('admin.contests.noMatch', { query: query.trim() })} />
        {:else}
          <EmptyState title={tr('admin.contests.none')} hint={tr('admin.contests.noneHint')}>
            {#if !creating}
              <button type="button" class="btn-primary" onclick={() => void startCreating()}>{tr('admin.contests.new')}</button>
            {/if}
          </EmptyState>
        {/if}
      {:else if list}
        <div class="contest-rows">
          <div class="contest-head admin-list-head">
            <span class="admin-label min-w-0 flex-1">{tr('admin.contests.col.contest')}</span>
            <span class="contest-cell admin-label w-[160px] shrink-0">{tr('admin.contests.col.state')}</span>
            <span class="contest-cell admin-label w-[180px] shrink-0">{tr('admin.contests.col.window')}</span>
            <span class="contest-cell admin-label w-[72px] shrink-0 text-right">{tr('admin.contests.col.problems')}</span>
            <span class="contest-cell admin-label w-[104px] shrink-0 text-right">{tr('admin.contests.col.entrants')}</span>
            <span class="contest-cell admin-label w-[88px] shrink-0 text-right">{tr('admin.contests.col.submissions')}</span>
            <span class="contest-cell admin-label w-[120px] shrink-0 text-right">{tr('admin.contests.col.solved')}</span>
            <span class="w-10 shrink-0"></span>
          </div>

          {#each groups as group (group.key)}
            <div class="contest-group">
              <span class="admin-label text-ink">{tr(`admin.contests.group.${group.key}`)}</span>
              <span class="font-mono text-micro text-muted">{group.rows.length}</span>
            </div>
            {#each group.rows as row (row.contest.id)}
              {@const c = row.contest}
              {@const phase = contestPhase(c, now)}
              {@const look = phaseBadge(phase)}
              {@const note = stateNote(row, now)}
              {@const dates = windowLine(c, now)}
              {@const counted = phase === 'open' || phase === 'over'}
              {@const average = counted ? averageWords(row) : null}
              <div class="contest-row admin-list-row">
                <button
                  type="button"
                  class="contest-name min-w-0 flex-1 text-left"
                  onclick={() => navigate(`/admin/contests/${encodeURIComponent(c.id)}`)}
                >
                  <p class="admin-row-title truncate">{c.title}</p>
                  <p class="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                    <span class="admin-meta font-mono text-ink">{contestPath(c.slug)}</span>
                    <span class="admin-meta min-w-0">{contestMeta(row, now)}</span>
                  </p>
                </button>

                <div class="contest-cell flex w-[160px] shrink-0 flex-col items-start gap-1">
                  <span class="flex flex-wrap items-center gap-1.5">
                    <Badge word={tr(`contests.phase.${phase}`)} tone={look.tone} form={look.form} />
                    {#if c.hiddenAt !== null}
                      <Badge word={tr('admin.contests.hiddenBadge')} tone="warning" form="outline" />
                    {/if}
                  </span>
                  {#if note}
                    <span class={cn('flex items-center gap-1.5 text-micro', NOTE_TONE[note.tone])}>
                      {#if note.dot}<span class="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true"></span>{/if}
                      {note.text}
                    </span>
                  {/if}
                </div>

                <div class="contest-cell w-[180px] shrink-0">
                  <p class={cn('truncate text-2xs', dates.empty ? 'text-muted' : 'text-ink')}>{dates.when}</p>
                  {#if dates.note}
                    <p class="mt-0.5 truncate text-micro text-muted">{dates.note}</p>
                  {/if}
                </div>

                <span class="contest-cell admin-num w-[72px] shrink-0 text-right">
                  {@render caption(tr('admin.contests.col.problems'))}{formatNumber(row.problems)}
                </span>
                <!-- Before the start the people and their numbers do not
                     exist yet: a dash says so, a zero would be a claim. -->
                <span class={cn('contest-cell admin-num w-[104px] shrink-0 text-right', !counted && 'text-faint')}>
                  {@render caption(tr('admin.contests.col.entrants'))}{counted ? formatNumber(row.entrants) : '—'}
                </span>
                <span class={cn('contest-cell admin-num w-[88px] shrink-0 text-right', !counted && 'text-faint')}>
                  {@render caption(tr('admin.contests.col.submissions'))}{counted ? formatNumber(row.submissions) : '—'}
                </span>
                <div class="contest-cell w-[120px] shrink-0 text-right">
                  {#if average}
                    <p class="admin-num font-bold">{@render caption(tr('admin.contests.col.solved'))}{average}</p>
                    <p class="mt-0.5 text-micro text-muted">{tr('admin.contests.average')}</p>
                  {:else}
                    <p class="admin-num text-faint">{@render caption(tr('admin.contests.col.solved'))}—</p>
                  {/if}
                </div>

                <div class="relative w-10 shrink-0 text-right">
                  <button
                    type="button"
                    class="admin-icon-btn"
                    aria-haspopup="menu"
                    aria-expanded={openMenu === c.id}
                    aria-label={tr('admin.contests.rowMenu', { name: c.title })}
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
                      class="row-menu admin-menu absolute right-0 top-full z-20 mt-1 w-[260px]"
                      onclick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        class="admin-menu-item"
                        onclick={() => {
                          openMenu = null
                          navigate(`/admin/contests/${encodeURIComponent(c.id)}`)
                        }}
                      >
                        {c.state === 'draft' ? tr('admin.contests.menu.editor') : tr('admin.contests.menu.open')}
                      </button>
                      <a
                        role="menuitem"
                        class="admin-menu-item"
                        href={contestPath(c.slug)}
                        target="_blank"
                        rel="noreferrer"
                        onclick={() => (openMenu = null)}
                      >
                        {c.state === 'draft' ? tr('admin.contests.preview') : tr('admin.contests.menu.entrantPage')}
                      </a>
                      {#if c.state !== 'draft'}
                        <button
                          type="button"
                          role="menuitem"
                          class="admin-menu-item"
                          onclick={() => {
                            openMenu = null
                            void copy(`${location.origin}${contestPath(c.slug)}`, c.id)
                          }}
                        >
                          {copied === c.id ? tr('admin.copied') : tr('admin.contests.menu.copyLink')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          class="admin-menu-item"
                          disabled={busy}
                          onclick={() => {
                            openMenu = null
                            void setHidden(row, c.hiddenAt === null)
                          }}
                        >
                          {c.hiddenAt === null ? tr('admin.contests.hide') : tr('admin.contests.show')}
                        </button>
                      {/if}
                      {#if mayDelete(row)}
                        <div class="admin-menu-sep"></div>
                        <button
                          type="button"
                          role="menuitem"
                          class="admin-menu-item text-danger"
                          onclick={() => {
                            openMenu = null
                            doomed = row
                            deleteError = null
                          }}
                        >
                          {tr('admin.contests.menu.delete')}
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          {/each}

          <p class="admin-meta py-3.5">{tr('admin.contests.countAll', { count: list.contests.length })}</p>
        </div>
      {/if}
    </div>
  </AdminPage>
{/if}

{#if doomed}
  <ConfirmDialog
    title={tr('admin.contests.deleteHeading', { name: doomed.contest.title })}
    body={doomed.submissions > 0
      ? tr('admin.contests.deleteBody', { count: doomed.submissions })
      : tr('admin.contests.deleteBodyEmpty')}
    confirm={tr('admin.contests.deleteConfirm')}
    {busy}
    error={deleteError}
    onconfirm={() => void destroy()}
    oncancel={() => (doomed = null)}
  />
{/if}

<style>
  /*
   * The narrow table: the title on its own line, the rest under it, the
   * captions moved into the cells. The threshold is the list's own width,
   * not the window's (the rail takes 236 px of a desktop and 56 of a phone):
   * 920 px is seven columns, their gaps and something for the title.
   */
  .contest-rows {
    container-type: inline-size;
  }

  /* A phase group's heading: a word and a count over an ink rule (A1). */
  .contest-group {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 1.125rem 0 0.5rem;
    border-bottom: 1px solid rgb(var(--ink));
  }

  .contest-label {
    display: none;
  }

  @container (max-width: 920px) {
    .contest-row {
      flex-wrap: wrap;
      align-items: flex-start;
      row-gap: 0.5rem;
    }

    .contest-name {
      flex-basis: calc(100% - 56px);
    }

    .contest-cell {
      width: auto;
      min-width: 0;
      text-align: left;
    }

    .contest-head {
      display: none;
    }

    .contest-label {
      display: inline;
    }
  }
</style>
