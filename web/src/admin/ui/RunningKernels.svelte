<script lang="ts">
  /**
   * «Работают сейчас» on the Resources tab (Paper, page 12: K1 owner, K2
   * dialogs, K3 teacher, K4 phone): every container holding memory right now,
   * what it really uses, and — for the owner — the stop that frees it.
   *
   * It exists because of one night: three idle rooms held 3 × 4 GB of a
   * 15 GB machine, every new kernel was refused, and nobody could see what
   * held the memory or let it go without a shell on the server. So the list
   * leads with the two numbers that decide it (what is reserved, what is
   * really used) and an idle room says how long it has been empty and when
   * it would let go by itself.
   *
   * The server decides what is idle, busy and stoppable and re-checks it at
   * the moment of stopping (routes/admin-running.ts); this component words
   * what it was told (admin/running-kernels.ts) and never guesses. A row of a
   * room the viewer does not teach arrives as numbers only (`hidden`), the
   * way a teacher sees another course's competition run.
   */
  import { onMount } from 'svelte'
  import { tr } from '@shared/i18n'
  import type { RunningBook, RunningBusy, RunningClass, RunningKernels, RunningRun } from '@shared/admin'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { courseColor } from '@/admin/course-color'
  import { ago } from '@/admin/panel'
  import {
    bookChip,
    bulkOutcome,
    busyBody,
    busyChip,
    busyOf,
    clock,
    coresLane,
    duration,
    emptyLine,
    freedMb,
    gb,
    gbText,
    idleClasses,
    memoryLane,
    shortName,
    since,
    statusLines,
    stopBody,
    stopOutcome,
    totals,
    type Outcome,
    type Tone,
  } from '@/admin/running-kernels'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'

  interface Props {
    /** The room setting (minutes; 0 = never), for the footnote. `null` while unknown. */
    roomIdleMin: number | null
    /** After a stop: what the machine holds changed, so the gauge above can catch up. */
    onchange?: () => void
  }

  let { roomIdleMin, onchange }: Props = $props()

  type Dialog =
    | { kind: 'stop'; row: RunningClass; what: 'class' | 'own'; busy: RunningBusy | null }
    | { kind: 'bulk'; rows: RunningClass[] }
    | { kind: 'run'; run: RunningRun }

  let data = $state<RunningKernels | null>(null)
  let loadErrorText = $state<(() => string) | null>(null)
  const loadError = $derived(loadErrorText?.() ?? null)
  let now = $state(Date.now())
  /** Open notebook lists, by `<class id>:<role>`. */
  let expanded = $state<Record<string, boolean>>({})
  let dialog = $state<Dialog | null>(null)
  let working = $state(false)
  let dialogErrorText = $state<(() => string) | null>(null)
  const dialogError = $derived(dialogErrorText?.() ?? null)
  /** The line under the header after a stop (K2-Г); it stays until the next periodic refresh. */
  let outcome = $state<(Outcome & { at: number }) | null>(null)

  const isOwner = $derived(adminAuth.isOwner)
  const sum = $derived(data ? totals(data) : null)
  const idle = $derived(data ? idleClasses(data) : [])
  const idleFreedMb = $derived(idle.reduce((total, row) => total + freedMb(row, 'class'), 0))
  const empty = $derived(
    data !== null && data.classes.length === 0 && data.runs.length === 0 && data.preparations.length === 0,
  )

  onMount(() => {
    void load()
    // The tab's own rule (ResourcesTab · refreshBudget): every 15 s, only
    // while someone is looking. A result line outlives the refresh that
    // follows the stop itself, and goes with the next one.
    const refresh = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (outcome && Date.now() - outcome.at > 10_000) outcome = null
      void load()
    }, 15_000)
    // A second: the run lane and the busy dialog count seconds, and an idle
    // countdown must not stand still between two refreshes.
    const tick = setInterval(() => (now = Date.now()), 1000)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearInterval(refresh)
      clearInterval(tick)
      window.removeEventListener('keydown', onKey)
    }
  })

  function messageFor(cause: unknown): string {
    if (cause instanceof Error && cause.message) return cause.message
    return tr('admin.the.server.did.not.answer')
  }

  async function load(): Promise<void> {
    try {
      data = await adminApi.runningKernels()
      now = Date.now()
      loadErrorText = null
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      // A list already on screen stays: one missed refresh is not worth
      // replacing it with an error, the next tick tries again.
      if (!data) loadErrorText = () => messageFor(cause)
    }
  }

  /* ------------------------------------------------------------- dialogs */

  function open(next: Dialog): void {
    dialogErrorText = null
    dialog = next
  }

  function close(): void {
    if (working) return
    dialog = null
    dialogErrorText = null
  }

  async function settle(result: Outcome): Promise<void> {
    outcome = { ...result, at: Date.now() }
    dialog = null
    await load()
    onchange?.()
  }

  async function confirm(): Promise<void> {
    const current = dialog
    if (!current || working) return
    working = true
    dialogErrorText = null
    try {
      if (current.kind === 'stop') {
        const id = current.row.id
        if (!id) return
        const answer = await adminApi.stopKernel(id, current.what, current.busy !== null)
        await settle(stopOutcome(current.row.name, current.what, answer.freedMb))
      } else if (current.kind === 'bulk') {
        // Exactly the rows the dialog named: the server stops and reports only these.
        const confirmed = current.rows.flatMap((row) => (row.id ? [row] : []))
        const names = new Map(confirmed.map((row) => [row.id!, row.name] as const))
        await settle(bulkOutcome(await adminApi.stopIdleKernels([...names.keys()]), names))
      } else {
        const id = current.run.submissionId
        if (!id) return
        await adminApi.killCompetitionRun(id)
        await settle({
          tone: 'positive',
          text: tr('admin.resourcesTab.running.run.stopped', { name: shortName(current.run.competition) }),
        })
      }
    } catch (cause: unknown) {
      // Something started computing between the list and the press: the
      // dialog turns into K2-Б and offers the forced stop, instead of a
      // refusal the owner has to decode.
      const busy = cause instanceof AdminApiError && cause.status === 409 ? busyOf(cause.body) : null
      if (busy && current.kind === 'stop' && dialog === current) dialog = { ...current, busy }
      else dialogErrorText = () => messageFor(cause)
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
    } finally {
      working = false
    }
  }

  /* ------------------------------------------------------------- helpers */

  const TONE: Record<Tone, string> = {
    accent: 'font-semibold text-accent-text',
    warning: 'font-semibold text-warning',
    ink: 'text-ink',
    muted: 'text-muted',
  }

  function booksOf(row: RunningClass, role: 'room' | 'own'): RunningBook[] {
    return row.books.filter((book) => book.role === role)
  }

  function toggle(key: string): void {
    expanded = { ...expanded, [key]: !expanded[key] }
  }

  function runShare(run: RunningRun): number | null {
    const elapsed = since(run.startedAt, now)
    if (elapsed === null || !run.limitSec) return null
    return Math.min(1, elapsed / (run.limitSec * 1000))
  }
</script>

<!-- The outlined square of K1: a filled grey one beside the room's square
     read as a second colour swatch. -->
{#snippet stopGlyph()}
  <svg viewBox="0 0 12 12" class="size-3 shrink-0" aria-hidden="true">
    <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.5" />
  </svg>
{/snippet}

{#snippet memory(container: RunningClass['room'], hidden: boolean)}
  {@const lane = memoryLane(container)}
  <div class="rk-mem flex min-w-0 flex-col gap-1.5">
    {#if lane.text === null}
      <span class="font-mono text-2xs text-faint">—</span>
    {:else}
      <span class="whitespace-nowrap">
        <span class="admin-num font-bold">{lane.text}</span>
        {#if lane.reserveOnly}<span class="text-2xs text-muted">{tr('admin.resourcesTab.running.reserve')}</span>{/if}
      </span>
      {#if lane.share !== null}
        <div class="h-[3px] bg-raised" aria-hidden="true">
          <div
            class={cn('h-full', hidden ? 'bg-faint' : lane.tight ? 'bg-warning' : 'bg-primary')}
            style:width="{(lane.share * 100).toFixed(1)}%"
          ></div>
        </div>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet cores(container: RunningClass['room'], gpu: string | null)}
  {@const text = coresLane(container)}
  <div class="rk-cores min-w-0">
    {#if text}
      <span class="block whitespace-nowrap font-mono text-micro text-muted">{text}</span>
    {:else}
      <span class="font-mono text-2xs text-faint">—</span>
    {/if}
    {#if gpu}
      <span class="block whitespace-nowrap font-mono text-micro text-muted">{tr('admin.resourcesTab.running.gpu', { value: gpu })}</span>
    {/if}
  </div>
{/snippet}

<!-- The notebooks lane: a bare count and a chevron in the table, the counted
     word with a link's underline on a card (K4), one button for both. -->
{#snippet booksToggle(row: RunningClass, role: 'room' | 'own')}
  {@const books = booksOf(row, role)}
  {@const key = `${row.id}:${role}`}
  <div class="rk-books">
    {#if row.hidden || books.length === 0}
      <span class="rk-dash font-mono text-2xs text-faint">—</span>
    {:else}
      <button
        type="button"
        class="rk-books-btn inline-flex items-center gap-1.5 text-accent-text hover:brightness-110"
        aria-expanded={expanded[key] === true}
        aria-label={expanded[key]
          ? tr('admin.resourcesTab.running.hideBooks', { name: shortName(row.name) })
          : tr('admin.resourcesTab.running.showBooks', { name: shortName(row.name) })}
        onclick={() => toggle(key)}
      >
        <span class="rk-books-count admin-num font-bold">{books.length}</span>
        <span class="rk-books-word text-2xs underline decoration-dotted underline-offset-4">
          {tr('admin.resourcesTab.running.booksCount', { count: books.length })}
        </span>
        <Icon name={expanded[key] ? 'chevron-up' : 'chevron-down'} size={14} class="shrink-0" />
      </button>
    {/if}
  </div>
{/snippet}

{#snippet bookList(row: RunningClass, role: 'room' | 'own')}
  {#if expanded[`${row.id}:${role}`] && !row.hidden}
    <div class="rk-booklist bg-surface py-1.5">
      {#each booksOf(row, role) as book (book.root)}
        {@const chip = bookChip(book)}
        <div class="rk-book">
          <p class="rk-book-path min-w-0 break-words">
            <span class="font-mono text-micro text-ink">{book.path}</span>
            {#if book.owner}<span class="text-2xs text-muted"> · {book.owner}</span>{/if}
          </p>
          <div class="rk-book-state flex min-w-0 items-center gap-2">
            <Badge word={chip.word} tone={chip.tone} />
            {#if book.phase === 'busy' && row.busy?.book === book.path && row.busy.who}
              <span class="min-w-0 truncate text-2xs text-muted">{row.busy.who}</span>
            {:else if book.phase !== 'busy' && book.lastWorkAt}
              {@const at = Date.parse(book.lastWorkAt)}
              {#if Number.isFinite(at)}<span class="min-w-0 truncate text-2xs text-muted">{ago(at, now)}</span>{/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet stopButton(row: RunningClass, what: 'class' | 'own')}
  <div class="rk-act flex justify-end">
    {#if row.canStop && row.id}
      {@const label = what === 'class' ? tr('admin.resourcesTab.running.stopButton') : tr('admin.resourcesTab.running.stopOwnButton')}
      <button
        type="button"
        class="rk-stop admin-icon-btn hover:bg-danger/10 hover:text-danger"
        title={label}
        aria-label={`${label} · ${shortName(row.name)}`}
        onclick={() => open({ kind: 'stop', row, what, busy: null })}
      >
        {@render stopGlyph()}
      </button>
    {/if}
  </div>
{/snippet}

<div class="rk">
  <div class="rk-body">
    {#if loadError && !data}
      <p class="text-ui text-danger" role="alert">{tr('admin.resourcesTab.running.loadFailed')} {loadError}</p>
      <button type="button" class="btn-outline mt-3" onclick={() => void load()}>{tr('admin.try.again')}</button>
    {:else if !data || !sum}
      <p class="text-ui text-muted">{tr('admin.resourcesTab.running.loading')}</p>
    {:else if empty}
      {@const line = emptyLine(data)}
      <!-- An empty answer from a census that did not complete is not "nothing
           runs": containers this process does not track may hold memory. -->
      <p class={cn('text-ui', TONE[line.tone])}>{line.text}</p>
      {#if outcome}
        <p class={cn('mt-2 text-ui font-semibold', outcome.tone === 'positive' ? 'text-positive' : 'text-warning')}>{outcome.text}</p>
      {/if}
    {:else}
      <!-- The two numbers first: what the containers hold, and what they
           really use. Only measured use counts as "really": a run's
           reservation is a ceiling, not use. -->
      <div class="rk-summary flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-3 pb-3.5">
        <p class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-ui text-muted">
          <span>{tr('admin.resourcesTab.running.held', { count: sum.containers })}</span>
          <span class="admin-num font-bold">{gbText(sum.reservedMb)}</span>
          <span class="text-faint" aria-hidden="true">·</span>
          {#if sum.usedMb !== null}
            <span>{tr('admin.resourcesTab.running.realUse')}</span>
            <span class="admin-num font-bold">{gbText(sum.usedMb)}</span>
          {:else}
            <span>{tr('admin.resourcesTab.running.useUnknown')}</span>
          {/if}
        </p>
        {#if idle.length > 0}
          <button type="button" class="rk-bulk btn-danger gap-2" onclick={() => open({ kind: 'bulk', rows: idle })}>
            {@render stopGlyph()}
            {tr('admin.resourcesTab.running.stopIdle', { count: idle.length, memory: gb(idleFreedMb) })}
          </button>
        {:else if !isOwner}
          <p class="text-ui text-muted">{tr('admin.resourcesTab.running.ownerOnly')}</p>
        {/if}
      </div>
      {#if !data.complete}
        <p class="pb-3 text-2xs text-warning">{tr('admin.resourcesTab.running.incomplete')}</p>
      {/if}

      <div class="rk-head" aria-hidden="true">
        <span class="admin-label">{tr('admin.resourcesTab.running.col.class')}</span>
        <span class="admin-label">{tr('admin.resourcesTab.running.col.now')}</span>
        <span class="admin-label whitespace-nowrap text-right">{tr('admin.resourcesTab.running.col.books')}</span>
        <span class="admin-label text-right">{tr('admin.resourcesTab.running.col.memory')}</span>
        <span class="admin-label text-right">{tr('admin.resourcesTab.running.col.cores')}</span>
        <span></span>
      </div>

      <div class="rk-list">
        {#if outcome}
          <div class="flex min-h-10 items-center gap-2 border-b border-line py-2" role="status">
            {#if outcome.tone === 'positive'}
              <Icon name="check" size={16} class="shrink-0 text-positive" />
            {:else}
              <svg viewBox="0 0 16 16" class="size-4 shrink-0 text-warning" aria-hidden="true">
                <path d="M8 3.5V9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" />
                <rect x="7" y="11.5" width="2" height="2" fill="currentColor" />
              </svg>
            {/if}
            <p class={cn('min-w-0 flex-1 text-2xs font-semibold', outcome.tone === 'positive' ? 'text-positive' : 'text-warning')}>
              {outcome.text}
            </p>
            <span class="shrink-0 text-2xs text-faint">{ago(outcome.at, now)}</span>
          </div>
        {/if}

        {#each data.classes as row, index (row.id ?? `hidden-${index}`)}
          {@const status = statusLines(row, now)}
          {@const ownBooks = booksOf(row, 'own')}
          <div class="border-b border-line">
            <div class="rk-row">
              <div class="rk-lead flex min-w-0 items-start">
                <span class={cn('rk-square shrink-0', row.hidden ? 'bg-faint' : 'bg-primary')} aria-hidden="true"></span>
                <div class="min-w-0 flex-1">
                  {#if row.hidden}
                    <p class="text-ui font-semibold text-muted">{tr('admin.resourcesTab.running.hiddenClass')}</p>
                  {:else}
                    {#if row.id}
                      <a
                        href={`/s/${row.id}`}
                        target="_blank"
                        rel="noreferrer"
                        class="admin-row-title font-bold hover:underline"
                      >{row.name ?? tr('admin.resourcesTab.running.unnamed')}</a>
                    {:else}
                      <p class="admin-row-title font-bold">{row.name ?? tr('admin.resourcesTab.running.unnamed')}</p>
                    {/if}
                    {#if row.course || row.environment}
                      <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                        {#if row.course}
                          <span class="inline-flex min-w-0 items-center gap-1.5 bg-surface px-1.5 py-0.5">
                            <span class="size-[7px] shrink-0" style:background={courseColor(row.course.id)} aria-hidden="true"></span>
                            <span class="truncate text-micro font-semibold text-ink">{row.course.name}</span>
                          </span>
                        {/if}
                        {#if row.environment}
                          <span class="font-mono text-micro text-muted">{row.environment}</span>
                        {/if}
                      </div>
                    {/if}
                  {/if}
                </div>
              </div>
              {@render stopButton(row, 'class')}
              <div class="rk-now min-w-0 text-2xs">
                <p class={TONE[status.tone]}>{status.first}</p>
                {#if status.second}<p class="text-muted">{status.second}</p>{/if}
              </div>
              {@render memory(row.room, row.hidden)}
              <div class="rk-meta">
                {@render cores(row.room, row.gpu)}
                {@render booksToggle(row, 'room')}
              </div>
            </div>
            {@render bookList(row, 'room')}

            {#if row.own || ownBooks.length > 0}
              <!-- The students' personal notebooks run in a container of their
                   own (0.15): it holds its own memory and stops on its own. -->
              <div class="rk-sub">
                <div class={cn('rk-row', row.own?.state !== 'starting' && 'rk-quiet')}>
                  <div class="rk-lead flex min-w-0 items-start">
                    <span class={cn('rk-square shrink-0', row.hidden ? 'bg-faint' : 'bg-brand-2')} aria-hidden="true"></span>
                    <div class="min-w-0 flex-1">
                      <p class={cn('text-2xs font-semibold', row.hidden ? 'text-muted' : 'text-ink')}>{tr('admin.resourcesTab.running.ownRow')}</p>
                      {#if !row.hidden}<p class="admin-meta">{tr('admin.resourcesTab.running.ownMeta')}</p>{/if}
                    </div>
                  </div>
                  {@render stopButton(row, 'own')}
                  <!-- Only when there is something to say: an empty lane would
                       still take a row and its gap on a card. -->
                  {#if row.own?.state === 'starting'}
                    <p class="rk-now min-w-0 text-2xs text-muted">{tr('admin.resourcesTab.running.busy.starting')}</p>
                  {/if}
                  {@render memory(row.own, row.hidden)}
                  <div class="rk-meta">
                    {@render cores(row.own, null)}
                    {@render booksToggle(row, 'own')}
                  </div>
                </div>
                {@render bookList(row, 'own')}
              </div>
            {/if}
          </div>
        {/each}

        {#each data.runs as run, index (run.submissionId ?? `run-${index}`)}
          {@const elapsed = since(run.startedAt, now)}
          {@const share = runShare(run)}
          <div class="border-b border-line">
            <div class="rk-row rk-row-end">
              <div class="rk-lead flex min-w-0 items-start">
                <span class={cn('rk-square shrink-0', run.hidden ? 'bg-faint' : 'bg-accent')} aria-hidden="true"></span>
                <div class="min-w-0 flex-1">
                  {#if run.hidden}
                    <p class="text-ui font-semibold text-muted">{tr('admin.resourcesTab.running.hiddenRun')}</p>
                  {:else}
                    <p class="admin-row-title font-bold">{run.competition ?? tr('admin.resourcesTab.running.unnamed')}</p>
                    <p class="admin-meta">
                      {run.kind === 'score' ? tr('admin.resourcesTab.running.run.metaScore') : tr('admin.resourcesTab.running.run.meta')}
                    </p>
                  {/if}
                </div>
              </div>
              <div class="rk-act flex justify-end">
                {#if run.canStop && run.submissionId}
                  <button
                    type="button"
                    class="rk-stop admin-icon-btn hover:bg-danger/10 hover:text-danger"
                    title={tr('admin.resourcesTab.running.run.stop')}
                    aria-label={`${tr('admin.resourcesTab.running.run.stop')} · ${shortName(run.competition)}`}
                    onclick={() => open({ kind: 'run', run })}
                  >
                    <Icon name="x" size={12} />
                  </button>
                {/if}
              </div>
              <div class="rk-now flex min-w-0 flex-col gap-1.5">
                <p class="flex flex-wrap items-baseline gap-x-1.5">
                  <span class={cn('text-2xs', run.hidden ? 'text-muted' : 'font-semibold text-accent-text')}>
                    {run.kind === 'score' ? tr('admin.resourcesTab.running.run.labelScore') : tr('admin.resourcesTab.running.run.label')}
                  </span>
                  {#if elapsed !== null}
                    <span class={cn('whitespace-nowrap font-mono text-micro', run.hidden ? 'text-muted' : 'text-accent-text')}>
                      {run.limitSec
                        ? tr('admin.resourcesTab.running.run.of', { elapsed: clock(elapsed), limit: clock(run.limitSec * 1000) })
                        : clock(elapsed)}
                    </span>
                  {/if}
                </p>
                {#if share !== null}
                  <div class="h-[3px] bg-raised" aria-hidden="true">
                    <div class={cn('h-full', run.hidden ? 'bg-faint' : share > 0.85 ? 'bg-warning' : 'bg-accent')} style:width="{(share * 100).toFixed(1)}%"></div>
                  </div>
                {/if}
              </div>
              <div class="rk-mem whitespace-nowrap">
                <span class="admin-num font-bold">{gbText(run.reservedMb)}</span>
                <span class="text-2xs text-muted">{tr('admin.resourcesTab.running.reserve')}</span>
              </div>
              <div class="rk-meta rk-meta-quiet">
                <span class="rk-cores font-mono text-2xs text-faint">—</span>
                <span class="rk-books font-mono text-2xs text-faint">—</span>
              </div>
            </div>
          </div>
        {/each}

        {#each data.preparations as prep (prep.id)}
          {@const elapsed = since(prep.startedAt, now)}
          <div class="border-b border-line">
            <div class="rk-row rk-row-end">
              <div class="rk-lead flex min-w-0 items-start">
                <span class="rk-square shrink-0 bg-faint" aria-hidden="true"></span>
                <div class="min-w-0 flex-1">
                  <p class="text-ui font-semibold text-muted">{tr('admin.resourcesTab.running.prep.title')}</p>
                  <p class="admin-meta">{prep.label ?? tr('admin.resourcesTab.running.prep.meta')}</p>
                </div>
              </div>
              <div class="rk-act"></div>
              <p class="rk-now min-w-0 text-2xs text-muted">
                {tr('admin.resourcesTab.running.prep.status')}{#if elapsed !== null}{' · '}{tr('admin.resourcesTab.running.busyFor', { time: duration(elapsed) })}{/if}
              </p>
              <div class="rk-mem whitespace-nowrap">
                <span class="admin-num font-bold">{gbText(prep.reservedMb)}</span>
                <span class="text-2xs text-muted">{tr('admin.resourcesTab.running.reserve')}</span>
              </div>
              <div class="rk-meta rk-meta-quiet">
                <span class="rk-cores font-mono text-2xs text-faint">—</span>
                <span class="rk-books font-mono text-2xs text-faint">—</span>
              </div>
            </div>
          </div>
        {/each}
      </div>

      <p class="pt-3.5 text-2xs text-muted">
        {tr('admin.resourcesTab.running.footnote')}
        <!-- "Change it under Default room" only to whoever can. -->
        {#if roomIdleMin !== null && isOwner}
          {roomIdleMin > 0
            ? tr('admin.resourcesTab.running.footnoteIdle', { time: duration(roomIdleMin * 60_000) })
            : tr('admin.resourcesTab.running.footnoteNever')}
        {:else if roomIdleMin !== null}
          {roomIdleMin > 0
            ? tr('admin.resourcesTab.running.footnoteIdleRead', { time: duration(roomIdleMin * 60_000) })
            : tr('admin.resourcesTab.running.footnoteNeverRead')}
        {/if}
      </p>
    {/if}
  </div>
</div>

{#if dialog}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="running-dialog-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      {#if dialog.kind === 'stop' && dialog.busy}
        {@const busy = dialog.busy}
        {@const running = since(busy.since, now)}
        <!-- K2-Б: the server said something computes. What, since when, and
             the forced stop as the only way on. -->
        <h2 id="running-dialog-title" class="break-words text-title font-semibold text-ink">
          {busy.kind === 'terminal'
            ? tr('admin.resourcesTab.running.busy.titleTerminal', { name: shortName(dialog.row.name) })
            : tr('admin.resourcesTab.running.busy.title', { name: shortName(dialog.row.name) })}
        </h2>
        <p class="mt-2 text-ui leading-relaxed text-muted">
          {busyBody(busy)}
          {#if dialog.row.online > 0}
            {tr('admin.resourcesTab.running.busy.people', { people: tr('admin.count.people', { count: dialog.row.online }) })}
          {/if}
          {tr('admin.resourcesTab.running.busy.loss')}
        </p>
        <div class="mt-4 flex h-10 items-center gap-3 border-l-[3px] border-accent bg-surface px-3">
          <span class="admin-label shrink-0 text-accent-text">{busyChip(busy.kind)}</span>
          {#if running !== null}
            <span class="shrink-0 font-mono text-2xs font-bold tabular-nums text-ink">{clock(running)}</span>
          {/if}
          {#if busy.book || busy.who}
            <span class="min-w-0 truncate text-2xs text-muted">{[busy.book, busy.who].filter(Boolean).join(' · ')}</span>
          {/if}
        </div>
      {:else if dialog.kind === 'stop'}
        <!-- K2-А: always asked, even for an empty room — it is cheap, and the
             numbers in it are the reason to press. -->
        <h2 id="running-dialog-title" class="break-words text-title font-semibold text-ink">
          {dialog.what === 'class'
            ? tr('admin.resourcesTab.running.stop.title', { name: shortName(dialog.row.name) })
            : tr('admin.resourcesTab.running.stop.titleOwn', { name: shortName(dialog.row.name) })}
        </h2>
        <p class="mt-2 text-ui leading-relaxed text-muted">{stopBody(dialog.row, dialog.what, now)}</p>
      {:else if dialog.kind === 'bulk'}
        <!-- K2-В: one confirmation for the batch, with every class it takes. -->
        <h2 id="running-dialog-title" class="break-words text-title font-semibold text-ink">
          {tr('admin.resourcesTab.running.bulk.title', { count: dialog.rows.length })}
        </h2>
        <p class="mt-2 text-ui leading-relaxed text-muted">{tr('admin.resourcesTab.running.bulk.body')}</p>
        <div class="mt-3 border-t border-line">
          {#each dialog.rows as row (row.id)}
            <div class="flex items-start gap-2.5 border-b border-line py-2.5 last:border-b-0">
              <span class="flex h-6 shrink-0 items-center" aria-hidden="true"><span class="size-2.5 bg-primary"></span></span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-ui font-semibold text-ink">{row.name ?? tr('admin.resourcesTab.running.unnamed')}</p>
                <p class="text-2xs text-warning">{statusLines(row, now).first}</p>
              </div>
              <span class="w-16 shrink-0 text-right admin-num font-bold leading-6">{gbText(freedMb(row, 'class'))}</span>
            </div>
          {/each}
          <div class="flex h-10 items-center gap-2.5 border-t border-ink">
            <span class="flex-1 text-ui font-semibold text-ink">{tr('admin.resourcesTab.running.bulk.total')}</span>
            <span class="w-16 shrink-0 text-right font-mono text-2xs font-bold text-positive">
              {gbText(dialog.rows.reduce((total, row) => total + freedMb(row, 'class'), 0))}
            </span>
          </div>
        </div>
      {:else}
        <h2 id="running-dialog-title" class="break-words text-title font-semibold text-ink">
          {tr('admin.resourcesTab.running.run.title', { name: shortName(dialog.run.competition) })}
        </h2>
        <p class="mt-2 text-ui leading-relaxed text-muted">
          {tr('admin.resourcesTab.running.run.body', { memory: gb(dialog.run.reservedMb) })}
        </p>
      {/if}
      {#if dialogError}
        <p class="mt-3 text-ui text-danger" role="alert">{dialogError}</p>
      {/if}
      <div class="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" class="btn-outline" disabled={working} onclick={close}>{tr('admin.cancel')}</button>
        <button type="button" class="btn-danger-solid" disabled={working} onclick={() => void confirm()}>
          {#if working}
            {tr('admin.resourcesTab.running.stop.working')}
          {:else if dialog.kind === 'stop' && dialog.busy}
            {tr('admin.resourcesTab.running.busy.force')}
          {:else if dialog.kind === 'bulk'}
            {tr('admin.resourcesTab.running.bulk.confirm', { count: dialog.rows.length })}
          {:else}
            {tr('admin.resourcesTab.running.stop.confirm')}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /*
   * One markup, two drawings, switched by the width of the list itself (as
   * Competitions does): the panel's rail is 236 px on a desktop and 56 on a
   * phone, so a window width would measure the wrong box. Below 780 px the
   * five lanes (232 + 72 + 120 + 120 + 36, five gaps) leave the class name
   * too little, so a row becomes the K4 card: the name with the stop beside it,
   * then the status, the memory bar, and cores with notebooks on one line.
   *
   * The lanes are wider than Paper's (204 / 68 / 104 / 116) because the
   * panel reads a step larger than the mockup: «14,6 из 16 ГБ» in the 15 px
   * mono, «2 ядра · 140 %» in the 14 px one, «идёт 3 мин · в комнате 18
   * человек» and the caps header «ТЕТРАДИ» need them.
   */
  .rk {
    container-type: inline-size;
  }

  .rk-body {
    --rk-indent: 18px;
  }

  .rk-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'lead act'
      'now now'
      'mem mem'
      'meta meta';
    column-gap: 12px;
    row-gap: 12px;
    padding-top: 16px;
  }

  /* A card skips the lines a row has nothing for: a template row with no
     element in it still takes its two gaps. */
  .rk-row-end {
    grid-template-areas:
      'lead act'
      'now now'
      'mem mem';
    padding-bottom: 18px;
  }

  .rk-quiet {
    grid-template-areas:
      'lead act'
      'mem mem'
      'meta meta';
  }

  .rk-lead {
    grid-area: lead;
    gap: calc(var(--rk-indent) - 10px);
  }

  /* 10 px, centred on the first line of the 24 px title. */
  .rk-square {
    width: 10px;
    height: 10px;
    margin-top: 7px;
  }

  .rk-act {
    grid-area: act;
  }

  .rk-now {
    grid-area: now;
    max-width: 460px;
    padding-left: var(--rk-indent);
  }

  /* A card in a wide-ish column (a 1280 laptop gets cards too) keeps its
     bar and its meta line to a reading width, not a 700 px rule. */
  .rk-mem {
    grid-area: mem;
    max-width: 460px;
    padding-left: var(--rk-indent);
  }

  /* Cores on the left, the notebooks link on the right, a finger tall. */
  .rk-meta {
    grid-area: meta;
    display: flex;
    min-height: 44px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    max-width: 460px;
    padding-left: var(--rk-indent);
  }

  /* A run has neither cores nor notebooks; on a card the dashes are noise. */
  .rk-meta-quiet {
    display: none;
  }

  .rk-books-count {
    display: none;
  }

  .rk-books-btn {
    min-height: 44px;
  }

  .rk-dash {
    display: none;
  }

  /* On a card the stop is framed: borderless, its grey square read as a
     second colour swatch beside the room's (K4). */
  .rk-stop {
    border: 1px solid rgb(var(--line));
    color: rgb(var(--muted));
  }

  /* Hover is a danger glyph on a danger tint (K1), for a real pointer only:
     the tailwind flag keeps a tapped button from staying lit on an iPad. */
  @media (hover: hover) and (pointer: fine) {
    .rk-stop:hover {
      color: rgb(var(--danger));
    }
  }

  /* On a card the batch stop takes the whole line (K4). */
  .rk-bulk {
    flex: 1 1 100%;
  }

  .rk-head {
    display: none;
  }

  /* The table's ink rule; on a card the header is gone and the list carries it. */
  .rk-list {
    border-top: 2px solid rgb(var(--ink));
  }

  .rk-sub {
    padding-left: var(--rk-indent);
  }

  .rk-sub .rk-row {
    border-top: 1px dashed rgb(var(--line));
    padding-top: 12px;
  }

  .rk-booklist {
    margin: 0 0 14px var(--rk-indent);
  }

  .rk-book {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: 12px;
    row-gap: 4px;
    padding: 8px 12px;
  }

  .rk-book-path {
    flex: 1 1 100%;
  }

  @container (min-width: 780px) {
    .rk-body {
      --rk-indent: 22px;
    }

    .rk-row,
    .rk-head,
    .rk-book {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 232px 72px 120px 120px 36px;
      column-gap: 12px;
      row-gap: 0;
    }

    .rk-row,
    .rk-row.rk-quiet,
    .rk-row.rk-row-end {
      grid-template-areas: 'lead now books mem cores act';
      align-items: center;
      padding: 13px 0;
    }

    .rk-head {
      height: 38px;
      align-items: center;
      border-bottom: 2px solid rgb(var(--ink));
    }

    .rk-list {
      border-top: 0;
    }

    .rk-now,
    .rk-mem,
    .rk-meta {
      max-width: none;
      padding-left: 0;
    }

    .rk-mem {
      text-align: right;
    }

    .rk-meta,
    .rk-meta-quiet {
      display: contents;
    }

    .rk-cores {
      grid-area: cores;
      justify-self: end;
      text-align: right;
    }

    .rk-books {
      grid-area: books;
      justify-self: end;
    }

    .rk-books-count,
    .rk-dash {
      display: inline;
    }

    .rk-books-word {
      display: none;
    }

    .rk-books-btn {
      min-height: 0;
      color: rgb(var(--ink));
    }

    .rk-stop {
      border: 0;
      color: rgb(var(--faint));
    }

    .rk-bulk {
      flex: 0 0 auto;
    }

    .rk-sub .rk-row {
      padding: 10px 0;
    }

    .rk-book {
      min-height: 34px;
      align-items: center;
      padding: 5px 0 5px 12px;
    }

    .rk-book-path {
      grid-column: 1;
    }

    .rk-book-state {
      grid-column: 2;
    }
  }
</style>
