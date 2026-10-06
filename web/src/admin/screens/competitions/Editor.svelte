<!--
  The competition editor (A2) — and also the "Settings" tab of a live one.

  Six sections, and their order is not decorative: it is the order in which
  the server checks readiness (server/src/competitions/panel.ts ·
  openRefusal). A person refused an opening goes down the form from top to
  bottom and fixes the first thing named, instead of jumping around the
  screen after each next refusal. The hidden test sits right under the data
  it replaces and blocks nothing: a competition without one runs on the open
  example, as it always did.

  The screen's main rule is the answers. `solution.csv` goes through a door of
  its own, lives outside the classes' working directories and is handed back
  to NOBODY: the panel shows the name, the row count and the columns, and
  never shows the bytes (see SECURITY.md).
-->
<script lang="ts">
  import { tr, formatNumber } from '@shared/i18n'
  import { onMount, untrack } from 'svelte'
  import DependencySettings from './DependencySettings.svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Section from '@/admin/ui/Section.svelte'
  import Choice from '@/admin/ui/Choice.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn, formatBytes } from '@/lib/utils'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import {
    failedAttemptsCeiling,
    LIMITS,
    parseSlug,
    slugRefusal,
    type BoardVisibility,
    type CompetitionLimits,
    type MetricDirection,
    type OutputPolicy,
    type PrivateRelease,
    type ScoringRule,
  } from '@shared/competitions'
  import type { AdminEnvironment, InstanceResources } from '@shared/admin'
  import type { Course } from '@shared/publish'
  import type { CompetitionInput, CompetitionView, FileView } from '@shared/competitions-api'
  import {
    answerColumns,
    applyPreset,
    columnsCheck,
    count,
    isUntouchedPreset,
    METRIC_PRESETS,
    metricNumber,
    moment,
    presetCode,
    refusalSection,
    refusalText,
    sealedPath,
    sealedTarget,
    spanWords,
    stateTone,
    stateWord,
  } from '@/admin/competitions'

  interface Props {
    view: CompetitionView
    navigate: (path: string) => void
    /** A fresh snapshot from the server: every file upload returns it whole. */
    onview: (view: CompetitionView) => void
    /** Inside a live competition's console: the form then has no header of its own. */
    embedded?: boolean
  }

  let { view, navigate, onview, embedded = false }: Props = $props()

  const c = $derived(view.competition)
  const draftState = $derived(c.state === 'draft')

  let busy = $state(false)
  let errorText = $state<(() => string) | null>(null)
  const error = $derived(errorText?.() ?? null)
  /**
   * Where the refusal is drawn: the hidden test's own section answers in
   * place. "The hidden test is limited to 200 MB" printed a screen and a half
   * above the drop zone it refused is a drop that seemed to do nothing.
   */
  let errorAt = $state<'form' | 'sealed'>('form')
  let saved = $state(false)
  let now = $state(Date.now())

  /* --------------------------------------------------------------- drafts */

  /*
   * The fields live a life of their own until "Save".
   *
   * The reset key is the competition id, not the object itself: `view` is
   * reassigned by the server's response after EVERY file upload, and a draft
   * that depended on the object would wipe a typed description at exactly
   * the moment the teacher dragged the first csv onto the form.
   */
  let drafted: string | null = null
  let title = $state('')
  let slug = $state('')
  let blurb = $state('')
  let description = $state('')
  let metricName = $state('')
  let metricDirection = $state<MetricDirection>('lower')
  let metricCode = $state('')
  let publicPercent = $state<number | null>(LIMITS.publicPercent.default)
  let limits = $state<CompetitionLimits>({
    wallSeconds: LIMITS.wallSeconds.default,
    memoryMb: LIMITS.memoryMb.default,
    cpus: LIMITS.cpus.default,
    perDay: LIMITS.perDay.default,
  })
  let environment = $state('base')
  let deadline = $state('')
  let startsAt = $state('')
  let privateRelease = $state<PrivateRelease>('auto')
  let scoring = $state<ScoringRule>('chosen')
  let boardVisibility = $state<BoardVisibility>('public')
  let lateSubmissions = $state(false)
  let outputPolicy = $state<OutputPolicy>('brief')
  /** «Курс»: '' is «Без курса». */
  let courseId = $state('')

  $effect(() => {
    const open = view.competition
    if (drafted === open.id) return
    drafted = open.id
    title = open.title
    slug = open.slug
    blurb = open.blurb
    description = open.description
    metricName = open.metric.name
    metricDirection = open.metric.direction
    metricCode = open.metric.code
    publicPercent = open.publicPercent
    limits = { ...open.limits }
    environment = open.environment
    deadline = localInput(open.deadlineAt)
    startsAt = localInput(open.startsAt)
    privateRelease = open.privateRelease
    scoring = open.scoring
    boardVisibility = open.boardVisibility ?? 'public'
    lateSubmissions = open.lateSubmissions ?? false
    outputPolicy = open.outputPolicy ?? 'brief'
    courseId = open.courseId ?? ''
  })

  /**
   * A moment into what `datetime-local` understands, and back.
   *
   * Through the local time of the PERSON's machine, not through ISO: a
   * "27.09 23:59" deadline is set while looking at the class timetable, and a
   * three-hour shift here is a class whose submissions closed at nine in the
   * evening.
   */
  function localInput(at: number | null): string {
    if (at === null) return ''
    const date = new Date(at)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function fromInput(value: string): number | null {
    if (!value.trim()) return null
    const at = new Date(value).getTime()
    return Number.isFinite(at) ? at : null
  }

  /* ------------------------------------------------------------- requests */

  const explain = (cause: unknown): string =>
    cause instanceof AdminApiError ? cause.message : tr('admin.competitions.requestFailed')

  function lost(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') {
      void adminAuth.refresh('revoked')
    }
  }

  /** The edit body: only what the form showed — and nothing beyond it. */
  function formBody(): CompetitionInput | null {
    const address = parseSlug(slug)
    if (!address) {
      const why = slugRefusal(slug) ?? 'chars'
      errorText = () => tr(`competitions.refusal.slug.${why}`)
      return null
    }
    if (!title.trim()) {
      errorText = () => tr('competitions.refusal.title')
      return null
    }
    const percent = Number(publicPercent)
    if (!Number.isFinite(percent) || percent < LIMITS.publicPercent.min || percent > LIMITS.publicPercent.max) {
      errorText = () =>
        tr('admin.competitions.percentRange', {
          min: LIMITS.publicPercent.min,
          max: LIMITS.publicPercent.max,
        })
      return null
    }
    return {
      slug: address,
      title: title.trim(),
      blurb: blurb.trim(),
      description,
      metric: { name: metricName.trim(), direction: metricDirection, code: metricCode },
      publicPercent: Math.round(percent),
      limits: { ...limits },
      environment,
      startsAt: fromInput(startsAt),
      deadlineAt: fromInput(deadline),
      privateRelease,
      scoring,
      boardVisibility,
      lateSubmissions,
      outputPolicy,
      courseId: courseId || null,
    }
  }

  async function act<T>(what: () => Promise<T>, at: 'form' | 'sealed' = 'form'): Promise<T | null> {
    if (busy) return null
    busy = true
    errorText = null
    errorAt = at
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

  /*
   * The id is taken BEFORE the first await.
   *
   * `c` is derived from a prop, and opening the competition tears down the
   * editor itself: the draft form gives way to the console. Reading a
   * derived value after its owner has been destroyed means `derived_inert`
   * in the console and a stale value instead of an error. The request has to
   * know what it is editing from the first line to the last.
   */
  async function save(): Promise<boolean> {
    const id = c.id
    const body = formBody()
    if (!body) return false
    const fresh = await act(() => adminApi.updateCompetition(id, body))
    if (!fresh) return false
    onview(fresh)
    saved = true
    setTimeout(() => (saved = false), 1600)
    return true
  }

  async function open(): Promise<void> {
    const id = c.id
    if (!(await save())) return
    const fresh = await act(() => adminApi.openCompetition(id))
    if (fresh) onview(fresh)
  }

  async function upload(files: FileList | null, what: 'data' | 'solution' | 'baseline'): Promise<void> {
    const id = c.id
    const list = [...(files ?? [])]
    if (list.length === 0) return
    const fresh = await act(() => {
      if (what === 'data') return adminApi.uploadCompetitionData(id, list)
      if (what === 'solution') return adminApi.uploadCompetitionSolution(id, list[0])
      return adminApi.uploadCompetitionBaseline(id, list[0])
    })
    if (fresh) onview(fresh)
  }

  async function dropFile(file: FileView): Promise<void> {
    const id = c.id
    const fresh = await act(() =>
      file.visibility === 'open'
        ? adminApi.deleteCompetitionFile(id, file.name)
        : adminApi.deleteCompetitionSolution(id, file.name),
    )
    if (fresh) onview(fresh)
  }

  /* ---------------------------------------------------------- hidden test */

  /** The name typed in "PATH DURING THE CHECK"; empty — each file keeps its own. */
  let sealedName = $state('')
  let dragging = $state(false)

  const sealedFiles = $derived(view.sealedFiles ?? [])
  /** Open files the check swaps out: the data panel marks them "example". */
  const swapped = $derived(new Set(sealedFiles.map((file) => file.replaces).filter(Boolean)))
  const shownPath = $derived(sealedPath(view, sealedName))

  /*
   * One door for the drop zone, the picker and a row's "Replace".
   *
   * A row's "Replace" passes that row's name, so a test_v2.csv picked to
   * replace test.csv lands as test.csv instead of becoming a second file next
   * to it. A typed name goes with one file only — the server refuses two files
   * under one name, and saying so here costs nothing.
   */
  async function uploadSealed(files: FileList | null | undefined, name = sealedTarget(sealedName)): Promise<void> {
    const id = c.id
    const list = [...(files ?? [])]
    if (list.length === 0) return
    if (name && list.length > 1) {
      errorAt = 'sealed'
      errorText = () => tr('admin.competitions.sealedPathOne')
      return
    }
    const fresh = await act(() => adminApi.uploadCompetitionSealed(id, list, name), 'sealed')
    if (!fresh) return void resyncSealed(id)
    onview(fresh)
    sealedName = ''
  }

  /*
   * After a refused upload the list is read again from the server.
   *
   * Several files are written one after another, and a refusal on the third
   * (a name the disk will not take) leaves the first two stored while the
   * answer is an error: the panel would go on showing the hidden test as it
   * was, and the class would be checked on files the teacher believes were
   * never uploaded.
   */
  async function resyncSealed(id: string): Promise<void> {
    try {
      const { sealedFiles: listed } = await adminApi.competitionSealed(id)
      if (id !== c.id) return
      onview({ ...view, sealedFiles: listed, sealedBytes: listed.reduce((sum, file) => sum + file.bytes, 0) })
    } catch (cause) {
      lost(cause)
    }
  }

  async function dropSealed(name: string): Promise<void> {
    const id = c.id
    const fresh = await act(() => adminApi.deleteCompetitionSealed(id, name), 'sealed')
    if (fresh) onview(fresh)
  }

  /** Checking the sample notebook: it goes into the shared queue as a real submission. */
  async function checkBaseline(): Promise<void> {
    if (view.capabilities?.execution.available === false) return
    const id = c.id
    const started = await act(() => adminApi.checkCompetitionBaseline(id))
    if (started) await refresh(id)
  }

  /** "Check against the baseline" — only the metric; the notebook is not run again. */
  async function checkMetric(): Promise<void> {
    if (view.capabilities?.execution.available === false) return
    const id = c.id
    if (!(await save())) return
    const started = await act(() => adminApi.checkCompetitionMetric(id))
    if (started) await refresh(id)
  }

  async function refresh(id: string): Promise<void> {
    try {
      onview(await adminApi.competition(id))
    } catch (cause) {
      lost(cause)
    }
  }

  /*
   * While the sample notebook's run is going, the screen asks about it
   * itself.
   *
   * The editor has no live stream (the console does), and the baseline is
   * the only thing on this form that changes without the person's help, and
   * it changes over minutes. Without polling, "IN QUEUE" hangs until the page
   * is reloaded, and the teacher leaves the screen thinking the check did
   * not start.
   */
  const baselineInFlight = $derived(
    view.baseline?.state === 'queued' || view.baseline?.state === 'running',
  )

  $effect(() => {
    const id = c.id
    if (!baselineInFlight) return
    const tick = window.setInterval(() => untrack(() => void refresh(id)), 3000)
    return () => window.clearInterval(tick)
  })

  onMount(() => {
    const tick = window.setInterval(() => (now = Date.now()), 30_000)
    return () => window.clearInterval(tick)
  })

  /* --------------------------------------------------------- environments */

  let environments = $state<AdminEnvironment[]>([])
  let resources = $state<InstanceResources | null>(null)
  /**
   * The courses the «Курс» select offers: the ones this person teaches, or
   * every course for an owner — the same set the server accepts.
   */
  let courses = $state<Course[]>([])

  onMount(() => {
    // Both answers are an addendum to the form, not the form itself: without
    // them the "Running a submission" section shows its own numbers and says
    // nothing about the machine.
    void adminApi
      .listEnvironments()
      .then((state) => (environments = state.environments))
      .catch(() => (environments = []))
    void adminApi
      .resources()
      .then((state) => (resources = state))
      .catch(() => (resources = null))
    void adminApi
      .listCourses(adminAuth.isOwner ? 'all' : 'mine')
      .then((list) => (courses = list))
      .catch(() => (courses = []))
  })

  const chosenEnvironment = $derived(environments.find((one) => one.name === environment) ?? null)

  /** Gigabytes to a tenth — with the decimal mark the instance's language uses. */
  const gb = (mb: number): string =>
    formatNumber(mb / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

  /* --------------------------------------------------------------- metric */

  const solution = $derived(view.hiddenFiles[0] ?? null)
  const columns = $derived(answerColumns(solution?.columns))
  const presetName = $derived(
    METRIC_PRESETS.find((preset) => preset.name === metricName)?.name ?? '',
  )
  const codeLines = $derived(Math.max(10, metricCode.split('\n').length))

  function pickPreset(name: string): void {
    const next = applyPreset(
      { name: metricName, direction: metricDirection, code: metricCode },
      name,
      columns,
    )
    metricName = next.name
    metricDirection = next.direction
    metricCode = next.code
  }

  /* ---------------------------------------------------------- description */

  let previewing = $state(false)
  const rendered = $derived(previewing ? (renderers()?.markdown(description) ?? null) : null)

  $effect(() => {
    if (previewing) void loadRenderers().catch(() => undefined)
  })

  /* ----------------------------------------------------------------- gate */

  /** The ceiling on failed submissions a day, by the same rule the upload door refuses with. */
  const ceiling = $derived(failedAttemptsCeiling(Number(limits.perDay)))

  /** The first thing blocking the opening; null — go. The server counts, the screen names. */
  const refusal = $derived(view.ready)
  const blocked = $derived<string | null>(refusal === null ? null : refusalSection(refusal))

  const HEAD = 'admin-label'
  const TILE = 'flex flex-col gap-1.5 border border-line px-3.5 py-3'
</script>

{#snippet marker(section: string)}
  <!-- The section holding the refusal's reason is named right inside it:
       otherwise "There is no answer file" is six places to look for it. -->
  {#if blocked === section && refusal}
    <p class="flex items-start gap-2 pt-2 text-micro leading-snug text-warning">
      <Icon name="alert" size={13} class="mt-px shrink-0" />
      <span>{refusalText(refusal)}</span>
    </p>
  {/if}
{/snippet}

{#snippet form()}
  {#if error && errorAt === 'form'}
    <p class="pt-4 text-ui text-danger" role="alert">{error}</p>
  {/if}

  <!-- 1 · Basics -->
  <Section title={tr('admin.competitions.section.basics')} description={tr('admin.competitions.basicsHint')}>
    <div class="flex flex-col gap-2.5">
      <div class="flex flex-wrap items-center gap-2.5">
        <input
          class="field min-w-0 flex-[3_1_260px]"
          aria-label={tr('admin.competitions.titleLabel')}
          maxlength={LIMITS.title}
          bind:value={title}
        />
        <div class="admin-affix flex-[1_1_200px]">
          <span class="shrink-0 font-mono text-2xs text-muted">/k/</span>
          <input
            aria-label={tr('admin.competitions.slugLabel')}
            maxlength={LIMITS.slug}
            bind:value={slug}
          />
        </div>
      </div>
      <input
        class="field"
        aria-label={tr('admin.competitions.blurbLabel')}
        placeholder={tr('admin.competitions.blurbPlaceholder')}
        maxlength={LIMITS.blurb}
        bind:value={blurb}
      />
      <!--
        «Курс» decides who else runs the competition: the course's teachers
        see it in their panel, alongside its creator and the owners. The
        options are this person's courses; one they no longer teach stays
        listed while it is the chosen one, so a save does not move it.
      -->
      <label class="flex flex-wrap items-center gap-2.5">
        <span class="{HEAD} shrink-0">{tr('admin.competitions.courseLabel')}</span>
        <select
          class="field w-auto min-w-0 flex-[0_1_320px]"
          aria-label={tr('admin.competitions.courseLabel')}
          bind:value={courseId}
        >
          <option value="">{tr('admin.competitions.noCourse')}</option>
          {#if courseId && !courses.some((one) => one.id === courseId)}
            <option value={courseId}>{tr('admin.competitions.courseNotYours')}</option>
          {/if}
          {#each courses as one (one.id)}
            <option value={one.id}>{one.name}</option>
          {/each}
        </select>
        <span class="min-w-0 flex-1 text-micro text-muted">
          {courseId ? tr('admin.competitions.courseHint') : tr('admin.competitions.noCourseHint')}
        </span>
      </label>

      <div class="border border-line">
        <div class="flex items-center gap-4 border-b border-line px-3 py-2">
          <button
            type="button"
            class={cn('text-micro font-bold uppercase tracking-caps', previewing ? 'text-faint' : 'text-primary')}
            aria-pressed={!previewing}
            onclick={() => (previewing = false)}
          >
            {tr('admin.competitions.tabText')}
          </button>
          <button
            type="button"
            class={cn('text-micro font-bold uppercase tracking-caps', previewing ? 'text-primary' : 'text-faint')}
            aria-pressed={previewing}
            onclick={() => (previewing = true)}
          >
            {tr('admin.competitions.tabPreview')}
          </button>
          <span class="ml-auto text-micro text-faint">{tr('admin.competitions.markdownHint')}</span>
        </div>
        {#if previewing}
          <div class="prose-note min-h-[140px] px-3 py-3">
            {#if rendered === null}
              <p class="text-ui text-muted">{tr('admin.competitions.previewLoading')}</p>
            {:else if description.trim() === ''}
              <p class="text-ui text-muted">{tr('admin.competitions.descriptionEmpty')}</p>
            {:else}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html rendered}
            {/if}
          </div>
        {:else}
          <textarea
            class="block min-h-[140px] w-full resize-y bg-canvas px-3 py-3 font-mono text-micro
                   leading-5 text-ink focus:outline-none"
            aria-label={tr('admin.competitions.descriptionLabel')}
            placeholder={tr('admin.competitions.descriptionPlaceholder')}
            maxlength={LIMITS.description}
            bind:value={description}
          ></textarea>
        {/if}
      </div>
    </div>
    {@render marker('basics')}
  </Section>

  <!-- 2 · Data -->
  <Section title={tr('admin.competitions.section.data')} description={tr('admin.competitions.dataHint')}>
    <div class="flex flex-wrap items-start gap-3">
      <div class="open-files min-w-0 flex-[2_1_320px] border border-line">
        <div class="flex items-center border-b border-line px-3 py-2">
          <span class={HEAD}>{tr('admin.competitions.openFilesHead')}</span>
          <span class="ml-auto font-mono text-micro text-faint">
            {formatBytes(view.dataBytes)} / {formatBytes(LIMITS.dataBytes)}
          </span>
        </div>
        {#each view.openFiles as file (file.name)}
          {@const example = swapped.has(file.name)}
          <div
            class={cn(
              'open-file flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-b-0',
              example && 'bg-accent/5',
            )}
          >
            <span class="open-file-name flex min-w-0 flex-1 items-center gap-2.5">
              <span class="min-w-0 truncate font-mono text-micro text-ink" title={file.name}>
                {file.name}
              </span>
              {#if example}
                <!-- The class downloads this one; the check reads the hidden
                     file of the same name. Without the mark the teacher reads
                     "test.csv · 200 rows" and wonders where the 2 000 went. -->
                <span class="shrink-0" title={tr('admin.competitions.exampleTitle')}>
                  <Badge word={tr('admin.competitions.exampleBadge')} tone="accent" />
                </span>
              {/if}
            </span>
            <span class="w-[110px] shrink-0 text-micro text-muted">
              {file.rows === null
                ? ''
                : tr('admin.competitions.rows', { count: file.rows, n: count(file.rows) })}
            </span>
            <span class="w-[64px] shrink-0 text-right font-mono text-micro text-muted">
              {formatBytes(file.bytes)}
            </span>
            <button
              type="button"
              class="shrink-0 text-muted transition-colors duration-100 hover:text-danger disabled:text-faint"
              disabled={busy}
              aria-label={tr('admin.competitions.dropFile', { name: file.name })}
              title={tr('admin.competitions.dropFile', { name: file.name })}
              onclick={() => void dropFile(file)}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        {:else}
          <p class="px-3 py-4 text-ui text-muted">{tr('admin.competitions.noData')}</p>
        {/each}
        <label class="flex cursor-pointer items-center px-3 py-2.5 text-micro text-accent-text hover:brightness-110">
          <input
            type="file"
            multiple
            class="sr-only"
            disabled={busy}
            onchange={(event) => {
              void upload(event.currentTarget.files, 'data')
              event.currentTarget.value = ''
            }}
          />
          {tr('admin.competitions.addFiles', { mb: Math.round(LIMITS.dataBytes / 1024 / 1024) })}
        </label>
      </div>

      <!--
        The answers get their own frame and their own colour, and that is not
        decoration: the only mistake on this form that cannot be undone is
        putting the answers into the open files. A different colour is worth
        more than any caption.
      -->
      <div class="min-w-0 flex-[1_1_300px] border border-brand">
        <div class="flex items-center gap-2 border-b border-primary bg-brand px-3 py-2">
          <Icon name="lock" size={12} class="shrink-0 text-white" />
          <span class="text-micro font-bold uppercase tracking-caps text-white">
            {tr('admin.competitions.hiddenHead')}
          </span>
        </div>
        {#each view.hiddenFiles as file (file.name)}
          <div class="flex items-center gap-3 border-b border-line px-3 py-2">
            <span class="min-w-0 flex-1 truncate font-mono text-micro text-ink">{file.name}</span>
            <span class="shrink-0 text-micro text-muted">
              {[
                file.rows === null
                  ? null
                  : tr('admin.competitions.rows', { count: file.rows, n: count(file.rows) }),
                file.columns?.join(', ') ?? null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {#if adminAuth.isOwner}
              <button
                type="button"
                class="shrink-0 text-muted transition-colors duration-100 hover:text-danger disabled:text-faint"
                disabled={busy}
                aria-label={tr('admin.competitions.dropFile', { name: file.name })}
                title={tr('admin.competitions.dropFile', { name: file.name })}
                onclick={() => void dropFile(file)}
              >
                <Icon name="trash" size={13} />
              </button>
            {/if}
          </div>
        {:else}
          <label class="flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2.5 text-micro text-accent-text hover:brightness-110">
            <input
              type="file"
              accept=".csv,text/csv"
              class="sr-only"
              disabled={busy}
              onchange={(event) => {
                void upload(event.currentTarget.files, 'solution')
                event.currentTarget.value = ''
              }}
            />
            {tr('admin.competitions.addSolution')}
          </label>
        {/each}

        <div class="flex flex-col gap-1.5 px-3 py-2.5">
          <div class="flex items-center gap-2">
            <input
              class="field w-[76px] px-2 text-center font-mono"
              type="number"
              min={LIMITS.publicPercent.min}
              max={LIMITS.publicPercent.max}
              aria-label={tr('admin.competitions.publicPercentLabel')}
              bind:value={publicPercent}
            />
            <span class="text-2xs text-ink">{tr('admin.competitions.publicPercentUnit')}</span>
          </div>
          <p class="text-micro leading-snug text-muted">
            {#if view.split}
              {tr('admin.competitions.splitNow', {
                count: view.split.publicRows,
                n: count(view.split.publicRows),
              })},
              {tr('admin.competitions.splitAfter', { n: count(view.split.privateRows) })}
              {view.split.byUsage
                ? tr('admin.competitions.splitByUsage')
                : tr('admin.competitions.splitBySeed')}
            {:else}
              {tr('admin.competitions.splitUnknown')}
            {/if}
            {#if sealedFiles.length > 0}
              {tr('admin.competitions.solutionForSealed')}
            {/if}
          </p>
        </div>
      </div>
    </div>
    {@render marker('data')}
  </Section>

  <!-- 2½ · Hidden test -->
  <Section title={tr('admin.competitions.section.sealed')} description={tr('admin.competitions.sealedHint')}>
    <div class="flex flex-col gap-5">
      {#if error && errorAt === 'sealed'}
        <p class="text-ui text-danger" role="alert">{error}</p>
      {/if}

      <!--
        The same frame and colour as the answers, and for the same reason: a
        hidden test dropped into the open files is downloaded by the whole
        class, and that mistake cannot be undone.
      -->
      <div class="border border-brand">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-primary bg-brand px-3 py-2">
          <Icon name="lock" size={12} class="shrink-0 text-white" />
          <span class="text-micro font-bold uppercase tracking-caps text-white">
            {tr('admin.competitions.sealedHead')}
          </span>
          <span class="ml-auto text-micro text-white/80">{tr('admin.competitions.sealedHeadNote')}</span>
        </div>

        {#each sealedFiles as file (file.name)}
          {@const example = view.openFiles.find((one) => one.name === file.replaces) ?? null}
          {@const check = columnsCheck(file, example)}
          <div class="flex flex-wrap items-start gap-x-3.5 gap-y-2 border-b border-line px-3.5 py-3">
            <div class="flex min-w-0 flex-1 basis-[260px] items-start gap-3.5">
              <Icon name="file" size={15} class="mt-0.5 shrink-0 text-primary" />
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <p class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ui text-ink">
                  <span class="font-mono text-2xs font-semibold">{file.name}</span>
                  {#if file.rows !== null}
                    <span>· {tr('admin.competitions.rows', { count: file.rows, n: count(file.rows) })}</span>
                  {/if}
                  {#if file.replaces}
                    <span>· {tr('admin.competitions.sealedReplaces')}</span>
                    <span class="font-mono text-2xs">data/{file.replaces}</span>
                    <span class="text-muted">
                      {example?.rows != null
                        ? tr('admin.competitions.sealedExampleOpen', {
                            rows: tr('admin.competitions.rows', { count: example.rows, n: count(example.rows) }),
                          })
                        : tr('admin.competitions.sealedExampleOpenPlain')}
                    </span>
                  {:else}
                    <span class="text-muted">· {tr('admin.competitions.sealedNewFile')}</span>
                  {/if}
                </p>
                <p class="flex flex-wrap items-center gap-x-1.5 text-micro leading-snug">
                  {#if check?.same}
                    <span class="inline-flex items-center gap-1.5 text-positive">
                      <Icon name="check" size={13} class="shrink-0" />
                      {tr('admin.competitions.sealedColumnsSame', { n: check.count })}
                    </span>
                    <span class="text-muted">·</span>
                  {:else if check}
                    <!-- A test with other columns than its example breaks every
                         notebook written against the example, and the class reads
                         that as their own bug. -->
                    <span class="inline-flex items-start gap-1.5 text-warning">
                      <Icon name="alert" size={13} class="mt-px shrink-0" />
                      {tr('admin.competitions.sealedColumnsDiffer', { sealed: check.sealed, open: check.open })}
                    </span>
                    <span class="text-muted">·</span>
                  {/if}
                  <span class="text-muted">
                    {formatBytes(file.bytes)} · {tr('admin.competitions.uploadedAt', { when: moment(file.uploadedAt, now) })}
                  </span>
                </p>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-4 max-[640px]:pl-[29px]">
              <label class="admin-link cursor-pointer no-underline">
                <input
                  type="file"
                  class="sr-only"
                  disabled={busy}
                  onchange={(event) => {
                    void uploadSealed(event.currentTarget.files, file.name)
                    event.currentTarget.value = ''
                  }}
                />
                {tr('admin.competitions.replace')}
              </label>
              <button
                type="button"
                class="text-2xs text-danger transition-colors duration-100 hover:brightness-110 disabled:text-faint"
                disabled={busy}
                aria-label={tr('admin.competitions.dropFile', { name: file.name })}
                onclick={() => void dropSealed(file.name)}
              >
                {tr('competitions.entrant.delete')}
              </button>
            </div>
          </div>
        {/each}

        <div class="px-3.5 py-3">
          <!-- A drop zone and a picker in one: the teacher drags the file
               from the folder the task was built in, or presses the button. -->
          <label
            class={cn(
              'flex cursor-pointer flex-wrap items-center gap-x-3.5 gap-y-2.5 border border-dashed px-4 py-3.5 transition-colors duration-100',
              dragging ? 'border-accent-text bg-accent/5' : 'border-faint bg-surface',
            )}
            ondragover={(event) => {
              event.preventDefault()
              dragging = true
            }}
            ondragleave={() => (dragging = false)}
            ondrop={(event) => {
              event.preventDefault()
              dragging = false
              void uploadSealed(event.dataTransfer?.files)
            }}
          >
            <input
              type="file"
              multiple
              class="sr-only"
              disabled={busy}
              onchange={(event) => {
                void uploadSealed(event.currentTarget.files)
                event.currentTarget.value = ''
              }}
            />
            <span class="flex min-w-0 flex-1 basis-[240px] items-start gap-3.5">
              <Icon name="upload" size={17} class="mt-0.5 shrink-0 text-accent-text" />
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-ui font-semibold text-ink">
                  {sealedFiles.length > 0
                    ? tr('admin.competitions.sealedDropMore')
                    : tr('admin.competitions.sealedDropFirst')}
                </span>
                <span class="text-2xs text-muted">
                  {tr('admin.competitions.sealedDropHint', {
                    mb: Math.round(LIMITS.sealedBytes / 1024 / 1024),
                    max: LIMITS.sealedFiles,
                  })}
                </span>
              </span>
            </span>
            <span class="btn-outline shrink-0">{tr('admin.competitions.pickFile')}</span>
          </label>
          {#if (view.sealedBytes ?? 0) > 0}
            <p class="admin-meta pt-2 text-right font-mono">
              {formatBytes(view.sealedBytes ?? 0)} / {formatBytes(LIMITS.sealedBytes)}
            </p>
          {/if}
        </div>
      </div>

      <div class="flex flex-wrap items-start gap-x-7 gap-y-4">
        <label class="flex min-w-0 flex-[1_1_240px] flex-col gap-2">
          <span class={HEAD}>{tr('admin.competitions.sealedPathHead')}</span>
          <span class="admin-affix">
            <span class="shrink-0 font-mono text-2xs text-muted">data/</span>
            <input
              aria-label={tr('admin.competitions.sealedPathLabel')}
              placeholder={tr('admin.competitions.sealedPathPlaceholder')}
              maxlength={LIMITS.fileName}
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              class="font-mono"
              bind:value={sealedName}
            />
          </span>
          <span class="text-2xs text-muted">{tr('admin.competitions.sealedPathHint')}</span>
        </label>

        {#if shownPath}
          <!--
            One path, two files: the whole idea of a hidden test, and the one
            thing the teacher has to see side by side before the class does.
          -->
          <div class="flex min-w-0 flex-[2_1_320px] flex-col gap-2">
            <span class={HEAD}>{tr('admin.competitions.sealedWhatHead')}</span>
            <div class="border-t-2 border-ink">
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-2.5 py-2.5">
                <span class="w-[150px] shrink-0 text-2xs text-muted">{tr('admin.competitions.sealedInNotebook')}</span>
                <span class="min-w-0 flex-1 basis-[140px] text-ui text-ink">
                  {shownPath.open
                    ? shownPath.open.rows !== null
                      ? tr('admin.competitions.sealedExampleRows', {
                          rows: tr('admin.competitions.rows', { count: shownPath.open.rows, n: count(shownPath.open.rows) }),
                        })
                      : tr('admin.competitions.sealedExampleFile')
                    : tr('admin.competitions.sealedNoFile')}
                </span>
                {#if shownPath.open}
                  <span class="shrink-0 text-2xs text-muted">{tr('admin.competitions.sealedDownloadable')}</span>
                {/if}
              </div>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-raised px-2.5 py-2.5">
                <span class="w-[150px] shrink-0 text-2xs text-primary">{tr('admin.competitions.sealedOnCheck')}</span>
                <span class="min-w-0 flex-1 basis-[140px] text-ui font-bold text-primary">
                  {#if shownPath.sealed}
                    {shownPath.sealed.rows !== null
                      ? tr('admin.competitions.sealedTestRows', {
                          rows: tr('admin.competitions.rows', { count: shownPath.sealed.rows, n: count(shownPath.sealed.rows) }),
                        })
                      : tr('admin.competitions.sealedTestFile')}
                  {:else}
                    <span class="font-normal text-muted">
                      {shownPath.open ? tr('admin.competitions.sealedNotYet') : tr('admin.competitions.sealedNoFile')}
                    </span>
                  {/if}
                </span>
                {#if shownPath.sealed}
                  <span class="flex shrink-0 items-center gap-1.5 text-2xs text-primary">
                    <Icon name="lock" size={11} class="shrink-0" />
                    {tr('admin.competitions.sealedNotGiven')}
                  </span>
                {/if}
              </div>
            </div>
            <p class="pt-1 text-2xs leading-snug text-ink">{tr('admin.competitions.sealedNote')}</p>
          </div>
        {/if}
      </div>

      <!--
        What a participant reads of a run on the hidden test. Two cards, not a
        segmented switch: the second one carries a warning that has to be
        read BEFORE it is chosen, and a switch hides it until after.
      -->
      <div class="flex min-w-0 flex-col gap-2.5">
        <p class="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
          <span id="output-policy-{c.id}" class={HEAD}>{tr('admin.competitions.policyHead')}</span>
          <span class="text-2xs text-muted">{tr('admin.competitions.policyAside')}</span>
        </p>
        <div class="flex flex-wrap gap-3" role="radiogroup" aria-labelledby="output-policy-{c.id}">
          {#each ['brief', 'full'] as const as one (one)}
            {@const chosen = outputPolicy === one}
            <label
              class={cn(
                'flex min-w-0 flex-1 basis-[280px] cursor-pointer flex-col gap-2.5 transition-colors duration-100',
                chosen ? 'border-2 border-primary bg-surface p-4' : 'border border-line p-[17px] hover:bg-surface',
              )}
            >
              <span class="flex flex-wrap items-center gap-2.5">
                <input
                  type="radio"
                  name="output-policy-{c.id}"
                  value={one}
                  checked={chosen}
                  class="size-4 shrink-0 accent-primary"
                  onchange={() => (outputPolicy = one)}
                />
                <span class="text-ui font-semibold text-ink">
                  {one === 'brief' ? tr('admin.competitions.policyBrief') : tr('admin.competitions.policyFull')}
                </span>
                {#if one === 'brief'}
                  <Badge word={tr('admin.competitions.policyRecommended')} tone="positive" />
                {/if}
              </span>
              <span class="pl-[26px] text-2xs leading-snug text-muted max-[640px]:pl-0">
                {one === 'brief' ? tr('admin.competitions.policyBriefHint') : tr('admin.competitions.policyFullHint')}
              </span>
              {#if one === 'brief'}
                <span class="ml-[26px] flex flex-col gap-1 border border-line bg-canvas px-3 py-2.5 max-[640px]:ml-0">
                  <span class="admin-label">{tr('admin.competitions.policySees')}</span>
                  <!-- The server's own words for such a run, not a picture of them. -->
                  <span class="text-2xs text-danger">
                    {tr('competitions.answer.sealed.cellFailed', { cell: 9, cells: 16, type: 'ValueError' })}
                  </span>
                </span>
              {:else}
                <span class="ml-[26px] flex gap-2.5 border-l-[3px] border-warning bg-warning/10 px-3 py-2.5 max-[640px]:ml-0">
                  <Icon name="alert" size={15} class="mt-0.5 shrink-0 text-warning" />
                  <span class="text-2xs leading-snug text-ink">{tr('admin.competitions.policyFullWarning')}</span>
                </span>
              {/if}
            </label>
          {/each}
        </div>
        {#if sealedFiles.length === 0}
          <p class="admin-meta">{tr('admin.competitions.policyNoSealed')}</p>
        {/if}
      </div>
    </div>
  </Section>

  <!-- 3 · Sample notebook -->
  <Section
    title={tr('admin.competitions.section.baseline')}
    description={tr('admin.competitions.baselineHint')}
  >
    <div class="flex flex-col gap-2.5">
      {#if view.baseline}
        {@const b = view.baseline.inputsCurrent === false && view.baseline.state === 'scored' ? { ...view.baseline, state: null } : view.baseline}
        <div class="flex flex-wrap items-center gap-3.5 border border-line px-3.5 py-3">
          <Icon name="notebook" size={16} class="shrink-0 text-primary" />
          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-2xs text-ink">{b.fileName}</p>
            <p class="mt-0.5 text-micro text-muted">
              {[
                b.cells === null ? null : tr('admin.competitions.cells', { count: b.cells }),
                tr('admin.competitions.uploadedAt', { when: moment(b.uploadedAt, now) }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <label class="shrink-0 cursor-pointer text-2xs text-accent-text hover:brightness-110">
            <input
              type="file"
              accept=".ipynb"
              class="sr-only"
              disabled={busy}
              onchange={(event) => {
                void upload(event.currentTarget.files, 'baseline')
                event.currentTarget.value = ''
              }}
            />
            {tr('admin.competitions.replace')}
          </label>
        </div>

        <!--
          The baseline check is not a checkbox but a real submission: the same
          throwaway container, the same queue, the same path to a number.
          Until it has made it through, the competition cannot be opened.
        -->
        <div
          class={cn(
            'flex flex-wrap items-stretch border',
            b.state === 'scored'
              ? 'border-positive'
              : b.state === null || b.state === 'queued' || b.state === 'running'
                ? 'border-line'
                : 'border-danger',
          )}
        >
          <div
            class={cn(
              'flex w-[150px] shrink-0 flex-col justify-center gap-1 px-3.5 py-3 max-[640px]:w-full',
              b.state === 'scored'
                ? 'bg-positive text-white dark:text-canvas'
                : b.state === null || b.state === 'queued' || b.state === 'running'
                  ? 'bg-surface text-ink'
                  : 'bg-danger text-white dark:text-canvas',
            )}
          >
            <span class="text-micro font-bold uppercase tracking-caps">
              {b.state === null
                ? tr('admin.competitions.baselineNotRunShort')
                : b.state === 'scored'
                  ? tr('admin.competitions.baselinePasses')
                  : b.state === 'queued' || b.state === 'running'
                    ? tr('admin.competitions.baselineGoing')
                    : tr('admin.competitions.baselineBroken')}
            </span>
            {#if b.durationMs !== null}
              <span class="text-micro opacity-85">
                {tr('admin.competitions.ofLimit', {
                  span: spanWords(b.durationMs),
                  limit: Math.round(c.limits.wallSeconds / 60),
                })}
              </span>
            {/if}
          </div>

          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-9 gap-y-3 px-4 py-3">
            <div class="shrink-0">
              <p class={HEAD}>{tr('admin.competitions.publicScore')}</p>
              <p class="font-mono text-head font-bold text-ink">{metricNumber(b.publicScore)}</p>
            </div>
            <div class="shrink-0">
              <p class={HEAD}>{tr('admin.competitions.privateScore')}</p>
              <p class="font-mono text-head font-bold text-ink">{metricNumber(b.privateScore)}</p>
            </div>
            <p class="min-w-0 flex-1 basis-[240px] text-micro leading-snug text-muted">
              {#if b.teacherError}
                <!-- The traceback only here and only for the teacher: it
                     explains nothing to an entrant, and it is someone else's
                     code at fault. -->
                <span class="whitespace-pre-wrap font-mono text-danger">{b.teacherError}</span>
              {:else if b.participantError}
                <span class="text-warning">{b.participantError}</span>
              {:else if b.state === 'scored'}
                {tr('admin.competitions.baselinePassed', { env: c.environment })}
              {:else}
                {tr('admin.competitions.baselineWaiting')}
              {/if}
            </p>
            {#if view.capabilities?.execution.available === false}
              <p class="text-micro text-warning" role="status">{view.capabilities.execution.reason}</p>
            {/if}
            <button
              type="button"
              class="admin-link shrink-0"
              disabled={busy || baselineInFlight || view.capabilities?.execution.available === false}
              onclick={() => void checkBaseline()}
            >
              {b.state === null
                ? tr('admin.competitions.checkBaseline')
                : tr('admin.competitions.checkAgain')}
            </button>
          </div>
        </div>
      {:else}
        <label
          class="flex cursor-pointer flex-col items-center gap-2 border border-dashed border-brand-2
                 bg-surface px-4 py-8 text-center"
        >
          <input
            type="file"
            accept=".ipynb"
            class="sr-only"
            disabled={busy}
            onchange={(event) => {
              void upload(event.currentTarget.files, 'baseline')
              event.currentTarget.value = ''
            }}
          />
          <span class="text-ui font-semibold text-ink">{tr('admin.competitions.noBaseline')}</span>
          <span class="max-w-sm text-micro leading-snug text-muted">
            {tr('admin.competitions.noBaselineHint', {
              mb: Math.round(LIMITS.notebookBytes / 1024 / 1024),
            })}
          </span>
          <span class="btn-outline mt-1">{tr('admin.competitions.pickFile')}</span>
        </label>
      {/if}
    </div>
    {@render marker('baseline')}
  </Section>

  <!-- 4 · Metric -->
  <Section title={tr('admin.competitions.section.metric')} description={tr('admin.competitions.metricHint')}>
    <div class="flex flex-col gap-2.5">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class={HEAD}>{tr('admin.competitions.presets')}</span>
        <div class="min-w-0">
          <Choice
            options={METRIC_PRESETS.map((preset) => ({ value: preset.name, label: preset.name }))}
            value={presetName}
            onchange={pickPreset}
          />
        </div>
        <!-- shrink-0: otherwise the "lower is better | higher is better" pair
             shrinks to the room left by the chips and wraps mid-word. -->
        <div class="ml-auto shrink-0 whitespace-nowrap">
          <Choice
            size="lg"
            options={[
              { value: 'lower', label: tr('competitions.direction.lower') },
              { value: 'higher', label: tr('competitions.direction.higher') },
            ]}
            value={metricDirection}
            onchange={(value) => (metricDirection = value as MetricDirection)}
          />
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2.5">
        <input
          class="field w-[200px] max-w-full"
          aria-label={tr('admin.competitions.metricNameLabel')}
          placeholder={tr('admin.competitions.metricNamePlaceholder')}
          maxlength={LIMITS.metricName}
          bind:value={metricName}
        />
        <span class="text-micro text-muted">{tr('admin.competitions.metricNameHint')}</span>
      </div>

      <!--
        The line-number gutter is not decoration: a metric traceback that
        arrives from someone's submission names a line ("score(), line 9"),
        and in a field without numbers you have to hunt for it with a finger
        on the screen.
      -->
      <div class="flex border border-line bg-surface">
        <div
          class="w-9 shrink-0 select-none border-r border-line py-3 pr-2 text-right font-mono
                 text-micro leading-5 text-faint"
          aria-hidden="true"
        >
          {#each Array.from({ length: codeLines }, (_, i) => i + 1) as line (line)}
            <div>{line}</div>
          {/each}
        </div>
        <textarea
          class="block min-h-[200px] w-full resize-y bg-transparent px-3.5 py-3 font-mono text-micro
                 leading-5 text-ink focus:outline-none"
          spellcheck="false"
          aria-label={tr('admin.competitions.metricCodeLabel')}
          placeholder={presetCode('MAPE', columns)}
          maxlength={LIMITS.metricCode}
          bind:value={metricCode}
        ></textarea>
      </div>

      <div class="flex flex-wrap items-center gap-3.5">
        <button
          type="button"
          class="btn-outline shrink-0"
          disabled={busy || !view.baseline || view.capabilities?.execution.available === false}
          onclick={() => void checkMetric()}
        >
          {tr('admin.competitions.checkMetric')}
        </button>
        <p class="min-w-0 flex-1 basis-[280px] text-micro leading-snug text-muted">
          {tr('admin.competitions.checkMetricHint')}
        </p>
      </div>
      {#if isUntouchedPreset(metricCode, columns) && solution}
        <p class="text-micro text-muted">
          {tr('admin.competitions.presetColumns', { id: columns.id, target: columns.target })}
        </p>
      {/if}
    </div>
    {@render marker('metric')}
  </Section>

  <!-- 5 · Running a submission -->
  <Section title={tr('admin.competitions.section.run')} description={tr('admin.competitions.runHint')}>
    <div class="flex flex-col gap-3.5">
      <div class="flex flex-wrap items-center gap-2.5 border border-line px-3.5 py-2.5">
        <span class="h-2 w-2 shrink-0 bg-accent" aria-hidden="true"></span>
        <select
          class="field w-auto min-w-0 font-mono"
          aria-label={tr('admin.competitions.environmentLabel')}
          bind:value={environment}
        >
          {#if !environments.some((one) => one.name === environment)}
            <option value={environment}>{environment}</option>
          {/if}
          {#each environments as one (one.name)}
            <option value={one.name}>{one.name}</option>
          {/each}
        </select>
        {#if chosenEnvironment}
          <Badge
            word={chosenEnvironment.state === 'ready'
              ? tr('admin.competitions.envReady')
              : tr('admin.competitions.envUnbuilt')}
            tone={chosenEnvironment.state === 'ready' ? 'positive' : 'warning'}
          />
          <span class="min-w-0 flex-1 truncate text-micro text-muted">
            {chosenEnvironment.packages.slice(0, 6).join(', ')}
          </span>
        {/if}
        <span class="ml-auto shrink-0 text-micro text-muted">
          {tr('admin.competitions.sameAsRoom')}
        </span>
      </div>

      <div class="flex flex-wrap gap-2.5">
        <label class="{TILE} min-w-0 flex-1 basis-[150px]">
          <span class={HEAD}>{tr('admin.competitions.limit.time')}</span>
          <span class="flex items-baseline gap-1.5">
            <input
              class="w-[64px] border-b border-line bg-transparent font-mono text-head font-bold text-ink
                     focus:outline-none focus:border-accent"
              type="number"
              min={Math.ceil(LIMITS.wallSeconds.min / 60)}
              max={Math.floor(LIMITS.wallSeconds.max / 60)}
              value={Math.round(limits.wallSeconds / 60)}
              oninput={(event) => {
                const minutes = Number(event.currentTarget.value)
                if (Number.isFinite(minutes) && minutes > 0) limits.wallSeconds = Math.round(minutes * 60)
              }}
            />
            <span class="text-2xs text-muted">{tr('admin.competitions.limit.timeUnit')}</span>
          </span>
        </label>
        <label class="{TILE} min-w-0 flex-1 basis-[150px]">
          <span class={HEAD}>{tr('admin.competitions.limit.memory')}</span>
          <span class="flex items-baseline gap-1.5">
            <input
              class="w-[64px] border-b border-line bg-transparent font-mono text-head font-bold text-ink
                     focus:outline-none focus:border-accent"
              type="number"
              step="0.5"
              min={LIMITS.memoryMb.min / 1024}
              max={LIMITS.memoryMb.max / 1024}
              value={Number((limits.memoryMb / 1024).toFixed(1))}
              oninput={(event) => {
                const gb = Number(event.currentTarget.value)
                if (Number.isFinite(gb) && gb > 0) limits.memoryMb = Math.round(gb * 1024)
              }}
            />
            <span class="text-2xs text-muted">{tr('admin.competitions.limit.memoryUnit')}</span>
          </span>
        </label>
        <label class="{TILE} min-w-0 flex-1 basis-[150px]">
          <span class={HEAD}>{tr('admin.competitions.limit.cpu')}</span>
          <span class="flex items-baseline gap-1.5">
            <input
              class="w-[64px] border-b border-line bg-transparent font-mono text-head font-bold text-ink
                     focus:outline-none focus:border-accent"
              type="number"
              min={LIMITS.cpus.min}
              max={LIMITS.cpus.max}
              bind:value={limits.cpus}
            />
            <span class="text-2xs text-muted">{tr('admin.competitions.limit.cpuUnit')}</span>
          </span>
        </label>
        <!-- Framed apart: the one limit the class feels, and the one the rule below is about. -->
        <label class="flex min-w-0 flex-1 basis-[150px] flex-col gap-1.5 border border-primary px-3.5 py-3">
          <span class="admin-label text-primary">{tr('admin.competitions.limit.perDay')}</span>
          <span class="flex items-baseline gap-1.5">
            <input
              class="w-[64px] border-b border-line bg-transparent font-mono text-head font-bold text-ink
                     focus:outline-none focus:border-accent"
              type="number"
              min={LIMITS.perDay.min}
              max={LIMITS.perDay.max}
              bind:value={limits.perDay}
            />
            <span class="text-2xs text-muted">{tr('admin.competitions.limit.perDayUnit')}</span>
          </span>
        </label>
      </div>

      {#if resources?.memory.availableMb != null}
        <p class="text-micro leading-snug text-muted">
          {tr('admin.competitions.machineFree', {
            free: gb(resources.memory.availableMb),
            rest: gb(Math.max(0, resources.memory.availableMb - limits.memoryMb)),
          })}
        </p>
      {/if}

      <!--
        What spends the limit, in three columns, and the ceiling under them.

        The rule changed on 4 Oct 2026 (only a score spends one), and the
        teacher is the one the class asks "why did my failed one eat my
        limit". The ceiling sits under the column it is the brake for; on a
        narrow form the cells stack, and the negative margins keep one hairline
        between neighbours either way.
      -->
      {#if Number(limits.perDay) > 0}
        <div class="rule-frame overflow-hidden border border-line">
          <div class="rule-grid">
            <div class="-ml-px -mt-px flex min-w-0 flex-col gap-2.5 border-l border-t border-line bg-surface px-4 py-3.5">
              <span class="admin-label text-primary">{tr('admin.competitions.rule.spends')}</span>
              <span class="flex"><Badge word={tr('competitions.teacher.scored')} tone="positive" /></span>
              <span class="text-2xs leading-snug text-ink">{tr('admin.competitions.rule.spendsText')}</span>
            </div>
            <div class="-ml-px -mt-px flex min-w-0 flex-col gap-2.5 border-l border-t border-line px-4 py-3.5">
              <span class={HEAD}>{tr('admin.competitions.rule.holds')}</span>
              <span class="flex flex-wrap gap-1.5">
                <Badge word={tr('admin.competitions.stateQueued')} tone="accent" form="outline" />
                <Badge word={tr('admin.competitions.stateRunning')} tone="accent" />
              </span>
              <span class="text-2xs leading-snug text-ink">{tr('admin.competitions.rule.holdsText')}</span>
            </div>
            <div class="-ml-px -mt-px flex min-w-0 flex-col gap-2.5 border-l border-t border-line px-4 py-3.5">
              <span class={HEAD}>{tr('admin.competitions.rule.free')}</span>
              <span class="text-2xs leading-snug text-ink">{tr('admin.competitions.rule.freeText')}</span>
            </div>
            <div class="-ml-px -mt-px flex min-w-0 flex-col gap-1 border-l border-t border-line px-4 py-3.5">
              <span class={HEAD}>{tr('admin.competitions.ceiling.head')}</span>
              <span class="flex items-baseline gap-1.5">
                <span class="font-mono text-head font-bold text-ink">{ceiling ?? '—'}</span>
                <span class="text-2xs text-muted">{tr('admin.competitions.ceiling.unit')}</span>
              </span>
            </div>
            <div class="rule-wide -ml-px -mt-px flex min-w-0 flex-col gap-1 border-l border-t border-line px-4 py-3.5">
              <span class="text-2xs leading-snug text-ink">
                {tr('admin.competitions.ceiling.text', { perDay: Math.floor(Number(limits.perDay)) })}
              </span>
              <span class="text-2xs leading-snug text-muted">{tr('admin.competitions.ceiling.hit')}</span>
            </div>
          </div>
        </div>
      {:else}
        <p class="text-micro leading-snug text-muted">{tr('admin.competitions.ceiling.offText')}</p>
      {/if}
    </div>
  </Section>

  {#key c.id}<DependencySettings competitionId={c.id} />{/key}

  <!-- 6 · Dates and standings -->
  <Section title={tr('admin.competitions.section.terms')} description={tr('admin.competitions.termsHint')}>
    <div class="flex flex-col gap-3.5">
      <div class="flex flex-wrap gap-2.5">
        <label class="min-w-0 flex-1 basis-[220px]">
          <span class="mb-1.5 block {HEAD}">{tr('admin.competitions.startsAt')}</span>
          <input
            class="field font-mono"
            type="datetime-local"
            aria-label={tr('admin.competitions.startsAt')}
            bind:value={startsAt}
          />
          <span class="admin-meta mt-1.5 block">{tr('admin.competitions.startsAtHint')}</span>
        </label>
        <label class="min-w-0 flex-1 basis-[220px]">
          <span class="mb-1.5 block {HEAD}">{tr('admin.competitions.deadlineAt')}</span>
          <input
            class="field font-mono"
            type="datetime-local"
            aria-label={tr('admin.competitions.deadlineAt')}
            bind:value={deadline}
          />
          <span class="admin-meta mt-1.5 block">{tr('admin.competitions.deadlineHint')}</span>
        </label>
        <!--
          «Поздние посылки» stands next to the deadline it is about. A real
          switch (role="switch"), not a checkbox: it is a state of the
          competition the console header repeats, and the label next to it
          says the state in words, so the colour is never the only signal.
        -->
        <div class="min-w-0 flex-1 basis-[220px]">
          <span class="mb-1.5 block {HEAD}">{tr('admin.competitions.afterDeadline')}</span>
          <label class="flex min-h-10 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 max-[640px]:min-h-11">
            <button
              type="button"
              role="switch"
              aria-checked={lateSubmissions}
              aria-label={tr('admin.competitions.lateSwitch')}
              class={cn(
                'flex h-[22px] w-10 shrink-0 items-center rounded-full px-[3px] transition-colors duration-quick',
                'focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/15',
                lateSubmissions ? 'justify-end bg-primary' : 'justify-start bg-faint/60',
              )}
              onclick={() => (lateSubmissions = !lateSubmissions)}
            >
              <span class="size-4 rounded-full bg-canvas shadow-sm" aria-hidden="true"></span>
            </button>
            <span class="text-ui font-semibold text-ink">{tr('admin.competitions.lateSwitch')}</span>
            <span class="text-2xs text-muted">
              {lateSubmissions ? tr('admin.competitions.lateOn') : tr('admin.competitions.lateOff')}
            </span>
          </label>
        </div>
      </div>

      {#if lateSubmissions}
        <!-- The three things a teacher asks before switching it on, answered
             where the switch is: are they taken, what do they cost, do they count. -->
        <div class="flex flex-wrap overflow-hidden border-l-[3px] border-primary bg-surface">
          <div class="-ml-px flex min-w-0 flex-[1_1_220px] flex-col gap-1.5 border-l border-line px-4 py-3.5">
            <span class="admin-label text-primary">{tr('admin.competitions.late.accepted')}</span>
            <span class="text-2xs leading-snug text-ink">{tr('admin.competitions.late.acceptedText')}</span>
          </div>
          <div class="-ml-px flex min-w-0 flex-[1_1_220px] flex-col gap-1.5 border-l border-line px-4 py-3.5">
            <span class="admin-label text-primary">{tr('admin.competitions.late.sameLimit')}</span>
            <span class="text-2xs leading-snug text-ink">
              {Number(limits.perDay) > 0
                ? tr('admin.competitions.late.sameLimitText', { count: Math.floor(Number(limits.perDay)) })
                : tr('admin.competitions.late.noLimitText')}
            </span>
          </div>
          <div class="-ml-px flex min-w-0 flex-[1.2_1_240px] flex-col gap-1.5 border-l border-line px-4 py-3.5">
            <span class="admin-label text-primary">{tr('admin.competitions.late.outside')}</span>
            <span class="text-2xs leading-snug text-ink">{tr('admin.competitions.late.outsideText')}</span>
          </div>
        </div>
      {:else}
        <p class="text-micro leading-snug text-muted">{tr('admin.competitions.late.offNote')}</p>
      {/if}
      {#if !draftState && (lateSubmissions || (view.counts.late ?? 0) > 0)}
        <!-- Said where the date is changed: moving it frees late work, and
             only one way (server · store.ts · forgiveLateSubmissions). -->
        <p class="text-micro leading-snug text-muted">{tr('admin.competitions.late.moveNote')}</p>
      {/if}

      <div>
        <p class="mb-1.5 {HEAD}">{tr('admin.competitions.privateBoard')}</p>
        <Choice
          size="lg"
          options={[
            { value: 'auto', label: tr('admin.competitions.privateAuto') },
            { value: 'manual', label: tr('admin.competitions.privateManual') },
          ]}
          value={privateRelease}
          onchange={(value) => (privateRelease = value as PrivateRelease)}
        />
      </div>

      <div>
        <p class="mb-1.5 {HEAD}">{tr('admin.competitions.scoringHead')}</p>
        <Choice
          size="lg"
          options={[
            { value: 'chosen', label: tr('admin.competitions.scoringChosen') },
            { value: 'bestPublic', label: tr('admin.competitions.scoringBest') },
            { value: 'last', label: tr('admin.competitions.scoringLast') },
          ]}
          value={scoring}
          onchange={(value) => (scoring = value as ScoringRule)}
        />
      </div>

      <p class="text-micro leading-snug text-muted">{tr('admin.competitions.scoringNote')}</p>

      <!-- Who sees the board: anyone with the link (as before), or the
           competition's own participants — a course that must keep its list
           of students inside the class. Staff always see it. -->
      <div>
        <p class="mb-1.5 {HEAD}">{tr('competitions.visibility.head')}</p>
        <Choice
          size="lg"
          options={[
            { value: 'public', label: tr('competitions.visibility.public') },
            { value: 'entrants', label: tr('competitions.visibility.entrants') },
          ]}
          value={boardVisibility}
          onchange={(value) => (boardVisibility = value as BoardVisibility)}
        />
      </div>
      <p class="text-micro leading-snug text-muted">{tr('competitions.visibility.note')}</p>
    </div>
    {@render marker('terms')}
  </Section>

  <!--
    The buttons at the bottom of the form are not a duplicate of the top ones
    but the only ones for the "Settings" tab: there the form has no header of
    its own. On a draft they remain as a second, nearer copy: the form is a
    screen and a half long, and going back to the header for "Save" is
    scrolling for the sake of a press.
  -->
  <div class="flex flex-wrap items-center gap-3 border-t border-line py-5">
    <!-- "Save draft" only on a draft: on a live competition what gets saved is
         not a draft but the settings the class sees right now. -->
    <button type="button" class="btn-primary" disabled={busy} onclick={() => void save()}>
      {saved
        ? tr('admin.competitions.savedWord')
        : draftState
          ? tr('admin.competitions.saveDraft')
          : tr('admin.save')}
    </button>
    {#if draftState}
      <button type="button" class="btn-outline" disabled={busy || refusal !== null || view.capabilities?.execution.available === false} onclick={() => void open()}>
        {tr('admin.competitions.openCompetition')}
      </button>
    {/if}
    {#if refusal !== null && draftState}
      <p class="min-w-0 flex-1 basis-[280px] text-micro leading-snug text-warning">
        {refusalText(refusal)}
      </p>
    {/if}
  </div>
{/snippet}

{#if embedded}
  {@render form()}
{:else}
  <AdminPage title={c.title}>
    {#snippet eyebrow()}
      <button
        type="button"
        class="shrink-0 transition-colors duration-100 hover:text-ink"
        onclick={() => navigate('/admin/competitions')}
      >
        {tr('competitions.title')}
      </button>
      <span aria-hidden="true">/</span>
      <span class="truncate font-mono">
        {draftState ? tr('admin.competitions.crumbDraft') : `/k/${c.slug}`}
      </span>
    {/snippet}

    {#snippet beside()}
      <Badge word={stateWord(c.state)} tone={stateTone(c.state)} />
    {/snippet}

    {#snippet actions()}
      <button
        type="button"
        class="btn-ghost"
        onclick={() => navigate('/admin/competitions')}
      >
        {tr('admin.cancel')}
      </button>
      <button
        type="button"
        class="btn-outline max-[640px]:flex-1"
        disabled={busy}
        onclick={() => void save()}
      >
        {saved ? tr('admin.competitions.savedWord') : tr('admin.competitions.saveDraft')}
      </button>
      <!-- A gate: opening a competition whose task cannot be solved even by its
           author means a hundred people vainly looking for the bug in their
           own code. -->
      {#if draftState}
        <button
          type="button"
          class="btn-primary btn-caps max-[640px]:flex-1"
          disabled={busy || refusal !== null || view.capabilities?.execution.available === false}
          title={refusal === null ? undefined : refusalText(refusal)}
          onclick={() => void open()}
        >
          {tr('admin.competitions.openCompetition')}
        </button>
      {/if}
    {/snippet}

    {@render form()}
  </AdminPage>
{/if}

<style>
  /*
   * The open files on a narrow panel (a phone): the name takes a line of its
   * own and the rows, size and bin go under it. Side by side, the fixed rows
   * and size columns left the name 40 px, and the «пример» mark, which cannot
   * shrink, lay over the row count.
   */
  .open-files {
    container-type: inline-size;
  }

  @container (max-width: 420px) {
    .open-file {
      flex-wrap: wrap;
      row-gap: 0.25rem;
    }

    .open-file-name {
      flex-basis: 100%;
    }
  }

  /*
   * The limits block: three columns and the ceiling under the first, on the
   * width of the form itself rather than the window (the panel's rail takes
   * 236 px of it), as the competitions list and the feed do.
   */
  .rule-frame {
    container-type: inline-size;
  }

  .rule-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }

  @container (min-width: 620px) {
    .rule-grid {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1.4fr);
    }

    .rule-wide {
      grid-column: span 2;
    }
  }
</style>
