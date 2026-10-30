<!--
  The contest editor (Paper 19 · A2) — and the «Настройки» tab of a live one.

  Five sections in the order a contest is made: what it is called, its
  problems, how it counts, when it runs, who may write in what. The problems
  have pages of their own (A3); here they are one table whose last column is
  the reason a contest will not open — a reference that does not pass all its
  tests (the competitions' baseline rule: a contest even its author cannot
  solve has nothing to open).

  The fields live a life of their own until «Сохранить», reset only when
  another contest is opened: the view is replaced by every answer — a
  reorder, an imported problem, the reference's state polled — and a draft
  tied to the object would wipe a typed introduction at the first of them.
  Leaving for a problem saves first, so nothing typed is lost on the way.
-->
<script lang="ts">
  import { getLocale, tr } from '@shared/i18n'
  import { onMount, untrack } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Section from '@/admin/ui/Section.svelte'
  import Choice from '@/admin/ui/Choice.svelte'
  import Check from '@/admin/ui/Check.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import MarkdownField from './MarkdownField.svelte'
  import ProblemTable from './ProblemTable.svelte'
  import ProblemPicker from './ProblemPicker.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'
  import {
    CONTEST_LANGUAGES,
    CONTEST_LIMITS,
    MAX_PROBLEMS,
    contestPath,
    contestPhase,
    parseContestSlug,
    type ContestLanguage,
    type ContestRules,
  } from '@shared/contests'
  import type { BoardVisibility } from '@shared/competitions'
  import type { AdminEnvironment } from '@shared/admin'
  import type { Course } from '@shared/publish'
  import type { ContestPatch, ContestView } from '@shared/contests-api'
  import type { LanguageOption } from '@shared/contests-entrant'
  import {
    contestSlugRefusal,
    durationWords,
    fromZonedInput,
    instanceZone,
    languageShort,
    phaseBadge,
    problemPath,
    zonedInput,
    zoneName,
  } from '@/admin/contests'

  interface Props {
    view: ContestView
    navigate: (path: string) => void
    /** A fresh snapshot from the server: every action answers with it whole. */
    onview: (view: ContestView) => void
    /** Inside a live contest's console: no header of its own. */
    embedded?: boolean
  }

  let { view, navigate, onview, embedded = false }: Props = $props()

  const c = $derived(view.contest)
  const draftState = $derived(c.state === 'draft')
  const zone = $derived(instanceZone(view))

  let busy = $state(false)
  let errorText = $state<(() => string) | null>(null)
  const error = $derived(errorText?.() ?? null)
  let saved = $state(false)
  let now = $state(Date.now())

  /* --------------------------------------------------------------- drafts */

  let drafted: string | null = null
  let title = $state('')
  let slug = $state('')
  let blurb = $state('')
  let description = $state('')
  let rules = $state<ContestRules>('icpc')
  let penalty = $state<number | null>(CONTEST_LIMITS.penaltyMinutes.default)
  let freeze = $state<number | null>(CONTEST_LIMITS.freezeMinutes.default)
  /** Attempts per problem; empty or 0 — no limit, which the tile says as «∞». */
  let attempts = $state<number | null>(null)
  let languages = $state<ContestLanguage[]>([])
  let environment = $state('base')
  let startsAt = $state('')
  let endsAt = $state('')
  let upsolving = $state(false)
  let boardVisibility = $state<BoardVisibility>('public')
  /** «Курс»: '' is «Без курса». */
  let courseId = $state('')

  $effect(() => {
    const open = view.contest
    const at = untrack(() => zone)
    if (drafted === open.id) return
    drafted = open.id
    title = open.title
    slug = open.slug
    blurb = open.blurb
    description = open.description
    rules = open.rules
    penalty = open.penaltyMinutes
    freeze = open.freezeMinutes
    attempts = open.attemptsPerProblem > 0 ? open.attemptsPerProblem : null
    languages = [...open.languages]
    environment = open.environment
    startsAt = zonedInput(open.startsAt, at)
    endsAt = zonedInput(open.endsAt, at)
    upsolving = open.upsolving
    boardVisibility = open.boardVisibility
    courseId = open.courseId ?? ''
  })

  const minute = (at: number | null) => (at === null ? null : Math.floor(at / 60_000))
  const startsAtMs = $derived(fromZonedInput(startsAt, zone))
  const endsAtMs = $derived(fromZonedInput(endsAt, zone))

  /** Something typed is not on the server yet: leaving for a problem saves it first. */
  const dirty = $derived(
    title !== c.title ||
      slug !== c.slug ||
      blurb !== c.blurb ||
      description !== c.description ||
      rules !== c.rules ||
      Number(penalty ?? 0) !== c.penaltyMinutes ||
      Number(freeze ?? 0) !== c.freezeMinutes ||
      Number(attempts ?? 0) !== c.attemptsPerProblem ||
      languages.join(',') !== c.languages.join(',') ||
      environment !== c.environment ||
      minute(startsAtMs) !== minute(c.startsAt) ||
      minute(endsAtMs) !== minute(c.endsAt) ||
      upsolving !== c.upsolving ||
      boardVisibility !== c.boardVisibility ||
      (courseId || null) !== c.courseId,
  )

  /* ------------------------------------------------------------- requests */

  const explain = (cause: unknown): string =>
    cause instanceof AdminApiError ? cause.message : tr('admin.contests.requestFailed')

  function lost(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
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

  /** A number field within its bounds, or the refusal that names the field. */
  function bounded(value: number | null, limit: { min: number; max: number }, what: string): number | null {
    const n = Number(value ?? 0)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < limit.min || n > limit.max) {
      errorText = () => tr('admin.contests.refusal.range', { what, min: limit.min, max: limit.max })
      return null
    }
    return n
  }

  /** The edit body: what the form shows — and nothing beyond it. */
  function formBody(): ContestPatch | null {
    const address = parseContestSlug(slug)
    if (!address) {
      const why = contestSlugRefusal(slug)
      errorText = () => why ?? tr('admin.contests.slug.chars')
      return null
    }
    if (!title.trim()) {
      errorText = () => tr('admin.contests.refusal.title')
      return null
    }
    const penaltyMinutes = bounded(penalty, CONTEST_LIMITS.penaltyMinutes, tr('admin.contests.penalty'))
    if (penaltyMinutes === null) return null
    const freezeMinutes = bounded(freeze, CONTEST_LIMITS.freezeMinutes, tr('admin.contests.freeze'))
    if (freezeMinutes === null) return null
    const attemptsPerProblem = bounded(attempts, CONTEST_LIMITS.attemptsPerProblem, tr('admin.contests.attempts'))
    if (attemptsPerProblem === null) return null
    if (languages.length === 0) {
      errorText = () => tr('admin.contests.refusal.noLanguage')
      return null
    }
    if (startsAtMs !== null && endsAtMs !== null && endsAtMs <= startsAtMs) {
      errorText = () => tr('admin.contests.refusal.endBeforeStart')
      return null
    }
    return {
      title: title.trim(),
      slug: address,
      blurb: blurb.trim(),
      description,
      rules,
      penaltyMinutes,
      freezeMinutes,
      attemptsPerProblem,
      // In the order the editor offers them: the participant's editor offers them so too.
      languages: CONTEST_LANGUAGES.filter((one) => languages.includes(one)),
      environment,
      startsAt: startsAtMs,
      endsAt: endsAtMs,
      upsolving,
      boardVisibility,
      courseId: courseId || null,
    }
  }

  /*
   * The id is taken before the first await: opening the contest tears this
   * editor down (the draft gives way to the console), and a derived value
   * read after its owner is gone is a stale one.
   */
  async function save(): Promise<boolean> {
    const id = c.id
    const body = formBody()
    if (!body) return false
    const fresh = await act(() => adminApi.contests.update(id, body))
    if (!fresh) return false
    onview(fresh)
    saved = true
    setTimeout(() => (saved = false), 1600)
    return true
  }

  async function open(): Promise<void> {
    const id = c.id
    if (!(await save())) return
    const fresh = await act(() => adminApi.contests.open(id))
    if (fresh) onview(fresh)
    // A refusal names what blocks it in words; the list below is read again,
    // so the two say the same thing.
    else await refresh(id)
  }

  async function refresh(id: string): Promise<void> {
    try {
      const fresh = await adminApi.contests.get(id)
      if (id === c.id) onview(fresh)
    } catch (cause) {
      lost(cause)
    }
  }

  /* ------------------------------------------------------------- problems */

  let picking = $state(false)
  let pickError = $state<string | null>(null)

  async function openProblem(problemId: string): Promise<void> {
    const id = c.id
    if (dirty && !(await save())) return
    navigate(problemPath(id, problemId))
  }

  async function addProblem(): Promise<void> {
    const id = c.id
    if (dirty && !(await save())) return
    const made = await act(() => adminApi.contests.createProblem(id, { title: tr('admin.contests.newProblemTitle') }))
    if (made) navigate(problemPath(id, made.id))
  }

  async function importProblem(files: FileList | null): Promise<void> {
    const id = c.id
    const file = files?.[0]
    if (!file) return
    if (dirty && !(await save())) return
    const made = await act(() => adminApi.contests.importProblem(id, file))
    if (made) await refresh(id)
  }

  async function reorder(ids: string[]): Promise<void> {
    const id = c.id
    const fresh = await act(() => adminApi.contests.orderProblems(id, ids))
    if (fresh) onview(fresh)
  }

  async function copyFrom(problemId: string): Promise<void> {
    const id = c.id
    if (busy) return
    busy = true
    pickError = null
    try {
      await adminApi.contests.copyProblem(id, problemId)
      picking = false
      await refresh(id)
    } catch (cause) {
      lost(cause)
      pickError = explain(cause)
    } finally {
      busy = false
    }
  }

  const full = $derived(view.problems.length >= MAX_PROBLEMS)

  /*
   * While a reference is judged or writes answers the screen asks about it
   * itself: the editor has no stream, and «в очереди» left hanging until a
   * reload reads as a check that never started.
   */
  const judging = $derived(
    view.problems.some(
      (problem) => problem.reference.state === 'queued' || problem.reference.state === 'running' || problem.answersRunning,
    ),
  )

  $effect(() => {
    const id = c.id
    if (!judging) return
    const tick = window.setInterval(() => untrack(() => void refresh(id)), 3000)
    return () => window.clearInterval(tick)
  })

  /* ----------------------------------------------------------- languages */

  /**
   * The chips: what the image can run, with versions (ContestView.languages).
   * An older server that sends none still gets three chips by name — a form
   * with no way to pick a language could not be saved.
   */
  const options = $derived<LanguageOption[]>(
    view.languages.length > 0
      ? view.languages
      : CONTEST_LANGUAGES.map((id) => ({ id, label: languageShort(id), available: true })),
  )

  function toggleLanguage(id: ContestLanguage): void {
    languages = languages.includes(id) ? languages.filter((one) => one !== id) : [...languages, id]
  }

  /* --------------------------------------------- environments and courses */

  let environments = $state<AdminEnvironment[]>([])
  let environmentsRead = $state(false)
  let courses = $state<Course[]>([])
  let coursesRead = $state(false)

  onMount(() => {
    const tick = window.setInterval(() => (now = Date.now()), 30_000)
    void adminApi
      .listEnvironments()
      .then((state) => (environments = state.environments))
      .catch(() => (environments = []))
      .finally(() => (environmentsRead = true))
    void adminApi
      .listCourses(adminAuth.isOwner ? 'all' : 'mine')
      .then((list) => (courses = list))
      .catch(() => (courses = []))
      .finally(() => (coursesRead = true))
    return () => window.clearInterval(tick)
  })

  /* ---------------------------------------------------------------- terms */

  const duration = $derived(durationWords(startsAtMs, endsAtMs))
  const backwards = $derived(startsAtMs !== null && endsAtMs !== null && endsAtMs <= startsAtMs)
  const zoneShort = $derived(zoneName(startsAtMs ?? now, zone, getLocale()))

  const phase = $derived(contestPhase(c, now))
  const badge = $derived(phaseBadge(phase))
  const HEAD = 'admin-label'
  const TILE = 'flex min-w-0 flex-1 basis-[160px] flex-col gap-1.5 border border-line px-3.5 py-3'
  const TILE_INPUT =
    'w-[72px] border-b border-line bg-transparent font-mono text-head font-bold text-ink focus:border-accent focus:outline-none'
</script>

{#snippet form()}
  {#if error}
    <p class="pt-4 text-ui text-danger" role="alert">{error}</p>
  {/if}
  {#if embedded && !draftState}
    <p class="flex items-start gap-2 pt-4 text-2xs text-warning">
      <Icon name="alert" size={13} class="mt-1 shrink-0" />
      <span>{tr('admin.contests.liveSettingsNote')}</span>
    </p>
  {/if}

  <!-- 1 · Basics -->
  <Section title={tr('admin.contests.section.basics')} description={tr('admin.contests.basicsHint')}>
    <div class="flex flex-col gap-2.5">
      <div class="flex flex-wrap items-center gap-2.5">
        <input
          class="field min-w-0 flex-[3_1_260px]"
          aria-label={tr('admin.contests.titleLabel')}
          maxlength={CONTEST_LIMITS.title}
          bind:value={title}
        />
        <div class="admin-affix flex-[1_1_200px]">
          <span class="shrink-0 font-mono text-2xs text-muted">/a/</span>
          <input aria-label={tr('admin.contests.slugLabel')} maxlength={64} spellcheck="false" autocapitalize="none" bind:value={slug} />
        </div>
      </div>
      <input
        class="field"
        aria-label={tr('admin.contests.blurbLabel')}
        placeholder={tr('admin.contests.blurbPlaceholder')}
        maxlength={CONTEST_LIMITS.blurb}
        bind:value={blurb}
      />
      <MarkdownField
        bind:value={description}
        label={tr('admin.contests.descriptionLabel')}
        placeholder={tr('admin.contests.descriptionPlaceholder')}
        maxlength={CONTEST_LIMITS.description}
        rows={4}
      />
    </div>
  </Section>

  <!-- 2 · Problems -->
  <Section title={tr('admin.contests.section.problems')} description={tr('admin.contests.problemsHint')}>
    <div class="flex flex-col">
      {#if view.problems.length > 0}
        <ProblemTable
          problems={view.problems}
          {busy}
          onopen={(id) => void openProblem(id)}
          onorder={draftState ? (ids) => void reorder(ids) : undefined}
        />
      {:else}
        <div class="border border-dashed border-line px-4 py-6 text-center">
          <p class="text-ui font-semibold text-ink">{tr('admin.contests.noProblems')}</p>
          <p class="mt-1 text-2xs text-muted">{tr('admin.contests.noProblemsHint')}</p>
        </div>
      {/if}
      <div class="flex flex-wrap gap-x-5 gap-y-2 pt-3">
        <button type="button" class="text-2xs text-accent-text hover:brightness-110 disabled:text-faint" disabled={busy || full} onclick={() => void addProblem()}>
          {tr('admin.contests.addProblem')}
        </button>
        <label class={cn('text-2xs text-accent-text hover:brightness-110', busy || full ? 'pointer-events-none text-faint' : 'cursor-pointer')}>
          <input
            type="file"
            accept=".zip,application/zip"
            class="sr-only"
            disabled={busy || full}
            onchange={(event) => {
              void importProblem(event.currentTarget.files)
              event.currentTarget.value = ''
            }}
          />
          {tr('admin.contests.importProblem')}
        </label>
        <button
          type="button"
          class="text-2xs text-accent-text hover:brightness-110 disabled:text-faint"
          disabled={busy || full}
          onclick={() => ((picking = true), (pickError = null))}
        >
          {tr('admin.contests.copyProblem')}
        </button>
        {#if full}
          <span class="text-2xs text-muted">{tr('admin.contests.problemsFull', { max: MAX_PROBLEMS })}</span>
        {/if}
      </div>
    </div>
  </Section>

  <!-- 3 · Scoring -->
  <Section title={tr('admin.contests.section.rules')} description={tr('admin.contests.rulesHint')}>
    <div class="flex flex-col gap-4">
      <Choice
        size="lg"
        options={[
          { value: 'icpc', label: tr('admin.contests.rules.icpc'), hint: tr('admin.contests.rules.icpcHint') },
          { value: 'ioi', label: tr('admin.contests.rules.ioi'), hint: tr('admin.contests.rules.ioiHint') },
        ]}
        value={rules}
        onchange={(value) => (rules = value as ContestRules)}
      />
      <div class="flex flex-wrap gap-3">
        {#if rules === 'icpc'}
          <!-- The penalty is ICPC's alone: under IOI the place is points, and a
               tile that changes nothing would still be read as a rule. -->
          <label class={TILE}>
            <span class={HEAD}>{tr('admin.contests.penalty')}</span>
            <span class="flex items-baseline gap-1.5">
              <input
                class={TILE_INPUT}
                type="number"
                min={CONTEST_LIMITS.penaltyMinutes.min}
                max={CONTEST_LIMITS.penaltyMinutes.max}
                bind:value={penalty}
              />
              <span class="text-2xs text-muted">{tr('admin.contests.minutes')}</span>
            </span>
          </label>
        {/if}
        <label class={TILE}>
          <span class={HEAD}>{tr('admin.contests.freeze')}</span>
          <span class="flex items-baseline gap-1.5">
            <input
              class={TILE_INPUT}
              type="number"
              min={CONTEST_LIMITS.freezeMinutes.min}
              max={CONTEST_LIMITS.freezeMinutes.max}
              placeholder="0"
              bind:value={freeze}
            />
            <span class="text-2xs text-muted">{freeze ? tr('admin.contests.freezeUnit') : tr('admin.contests.freezeOff')}</span>
          </span>
        </label>
        <label class={TILE}>
          <span class={HEAD}>{tr('admin.contests.attempts')}</span>
          <span class="flex items-baseline gap-1.5">
            <input
              class={TILE_INPUT}
              type="number"
              min={CONTEST_LIMITS.attemptsPerProblem.min}
              max={CONTEST_LIMITS.attemptsPerProblem.max}
              placeholder="∞"
              bind:value={attempts}
            />
            <span class="text-2xs text-muted">
              {attempts ? tr('admin.contests.attemptsUnit', { count: attempts }) : tr('admin.contests.attemptsUnlimited')}
            </span>
          </span>
        </label>
      </div>
      <p class="text-2xs text-muted">
        {rules === 'icpc' ? tr('admin.contests.rules.icpcNote') : tr('admin.contests.rules.ioiNote')}
      </p>
    </div>
  </Section>

  <!-- 4 · Dates -->
  <Section title={tr('admin.contests.section.terms')} description={tr('admin.contests.termsHint')}>
    <div class="flex flex-col gap-3.5">
      <div class="flex flex-wrap gap-3">
        <label class="flex min-w-0 flex-1 basis-[200px] flex-col gap-1.5">
          <span class={HEAD}>{tr('admin.contests.startsAt')}</span>
          <input class="field font-mono" type="datetime-local" aria-label={tr('admin.contests.startsAt')} bind:value={startsAt} />
        </label>
        <label class="flex min-w-0 flex-1 basis-[200px] flex-col gap-1.5">
          <span class={HEAD}>{tr('admin.contests.endsAt')}</span>
          <input
            class={cn('field font-mono', backwards && 'border-danger')}
            type="datetime-local"
            aria-label={tr('admin.contests.endsAt')}
            aria-invalid={backwards}
            bind:value={endsAt}
          />
        </label>
        <div class="flex w-[150px] shrink-0 flex-col gap-1.5 max-[640px]:w-full">
          <span class={HEAD}>{tr('admin.contests.duration')}</span>
          <span class="flex h-10 items-center bg-surface px-3 font-mono text-2xs text-ink max-[640px]:h-11">
            {duration ?? '—'}
          </span>
        </div>
      </div>
      {#if backwards}
        <p class="text-2xs text-danger">{tr('admin.contests.refusal.endBeforeStart')}</p>
      {/if}
      <p class="text-micro text-muted">
        {zone
          ? tr('admin.contests.zoneInstance', { zone: zoneShort ? `${zone} (${zoneShort})` : zone })
          : tr('admin.contests.zoneLocal', { zone: zoneShort ?? '' })}
      </p>
      <label class="flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1">
        <Check bind:checked={upsolving} label={tr('admin.contests.upsolving')} />
        <span class="text-ui text-ink">{tr('admin.contests.upsolving')}</span>
        <span class="text-2xs text-muted">{tr('admin.contests.upsolvingHint')}</span>
      </label>
    </div>
  </Section>

  <!-- 5 · Languages and access -->
  <Section
    title={tr('admin.contests.section.access')}
    description={tr('admin.contests.accessHint', { environment })}
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <span id="contest-languages-{c.id}" class={HEAD}>{tr('admin.contests.languagesLabel')}</span>
        <div class="flex flex-wrap gap-2.5" role="group" aria-labelledby="contest-languages-{c.id}">
          {#each options as option (option.id)}
            {@const on = languages.includes(option.id)}
            <button
              type="button"
              aria-pressed={on}
              disabled={!option.available && !on}
              title={option.available ? undefined : tr('admin.contests.languageMissing', { environment })}
              class={cn(
                'inline-flex min-h-10 items-center gap-2 border px-3.5 font-mono text-2xs transition-colors duration-quick max-[640px]:min-h-11',
                on ? 'border-brand-2 bg-raised font-semibold text-ink' : 'border-line text-muted hover:bg-surface',
                !option.available && 'cursor-not-allowed opacity-60',
              )}
              onclick={() => toggleLanguage(option.id)}
            >
              {#if on}<Icon name="check" size={12} class="shrink-0 text-primary" />{/if}
              {option.label}
              {#if !option.available}
                <span class="font-sans text-micro text-warning">{tr('admin.contests.languageMissingShort')}</span>
              {/if}
            </button>
          {/each}
        </div>
        <!--
          A compiler missing from the image is almost always an image from
          before 0.30.0, which a server keeps through updates: the way to C and
          C++ is a fresh image, and the teacher is told where to get it rather
          than left with greyed-out chips.
        -->
        {#if options.some((option) => !option.available)}
          <p class="text-micro leading-5 text-muted">{tr('admin.contests.languageMissingHint', { environment })}</p>
        {/if}
      </div>

      <label class="flex flex-wrap items-center gap-2.5">
        <span class="{HEAD} w-[110px] shrink-0">{tr('admin.contests.environmentLabel')}</span>
        {#if !environmentsRead}
          <span class="block h-10 w-[220px] max-[640px]:h-11" role="status" aria-busy="true" aria-label={tr('admin.loading.environments')}>
            <span class="sr-only">{tr('admin.loading.environments')}</span>
            <Skeleton width="100%" height="100%" radius="0" />
          </span>
        {:else}
          <select class="field w-auto min-w-0 font-mono" aria-label={tr('admin.contests.environmentLabel')} bind:value={environment}>
            {#if !environments.some((one) => one.name === environment)}
              <option value={environment}>{environment}</option>
            {/if}
            {#each environments as one (one.name)}
              <option value={one.name}>{one.name}</option>
            {/each}
          </select>
        {/if}
        {#if environment !== c.environment}
          <span class="min-w-0 flex-1 text-micro text-muted">{tr('admin.contests.environmentUnsaved')}</span>
        {/if}
      </label>

      <div class="flex flex-col gap-1.5">
        <span class={HEAD}>{tr('admin.contests.boardLabel')}</span>
        <Choice
          size="lg"
          options={[
            { value: 'public', label: tr('admin.contests.board.public') },
            { value: 'entrants', label: tr('admin.contests.board.entrants') },
          ]}
          value={boardVisibility}
          onchange={(value) => (boardVisibility = value as BoardVisibility)}
        />
      </div>

      <label class="flex flex-wrap items-center gap-2.5">
        <span class="{HEAD} w-[110px] shrink-0">{tr('admin.contests.courseLabel')}</span>
        {#if !coursesRead}
          <span class="block h-10 min-w-0 flex-[0_1_320px] max-[640px]:h-11" role="status" aria-busy="true" aria-label={tr('admin.loading.courses')}>
            <span class="sr-only">{tr('admin.loading.courses')}</span>
            <Skeleton width="100%" height="100%" radius="0" />
          </span>
        {:else}
          <select class="field w-auto min-w-0 flex-[0_1_320px]" aria-label={tr('admin.contests.courseLabel')} bind:value={courseId}>
            <option value="">{tr('admin.contests.noCourse')}</option>
            {#if courseId && !courses.some((one) => one.id === courseId)}
              <option value={courseId}>{view.course?.name ?? tr('admin.contests.courseNotYours')}</option>
            {/if}
            {#each courses as one (one.id)}
              <option value={one.id}>{one.name}</option>
            {/each}
          </select>
        {/if}
        <span class="min-w-0 flex-1 text-micro text-muted">
          {courseId ? tr('admin.contests.courseHint') : tr('admin.contests.noCourseHint')}
        </span>
      </label>
    </div>
  </Section>

  <!--
    The bottom bar: on a draft the second, nearer copy of the header's
    buttons (the form is two screens long), on a live contest's «Настройки»
    the only one. What blocks the opening is listed here, in the server's
    words, under the button it blocks.
  -->
  <div class="flex flex-col gap-3 border-t border-line py-5">
    <div class="flex flex-wrap items-center gap-3">
      <button type="button" class="btn-primary" disabled={busy} onclick={() => void save()}>
        {saved ? tr('admin.contests.saved') : tr('admin.contests.save')}
      </button>
      {#if draftState}
        <button type="button" class="btn-outline" disabled={busy || view.readiness.length > 0} onclick={() => void open()}>
          {tr('admin.contests.openContest')}
        </button>
      {/if}
      {#if dirty && !saved}
        <span class="text-micro text-muted">{tr('admin.contests.unsaved')}</span>
      {/if}
    </div>
    {#if draftState}
      {#if view.readiness.length > 0}
        <div class="flex flex-col gap-1.5 border-l-[3px] border-warning bg-warning/5 px-3.5 py-3">
          <span class="admin-label text-warning">{tr('admin.contests.readiness.head')}</span>
          <ul class="flex flex-col gap-1">
            {#each view.readiness as reason, i (i)}
              <li class="flex items-start gap-2 text-2xs text-ink">
                <span class="mt-2 size-1.5 shrink-0 bg-warning" aria-hidden="true"></span>
                <span>{reason}</span>
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <p class="flex items-center gap-2 text-2xs text-positive">
          <Icon name="check" size={13} class="shrink-0" />
          {tr('admin.contests.readiness.ready')}
        </p>
      {/if}
    {/if}
  </div>
{/snippet}

{#if embedded}
  {@render form()}
{:else}
  <AdminPage title={c.title}>
    {#snippet eyebrow()}
      <button type="button" class="shrink-0 transition-colors duration-100 hover:text-ink" onclick={() => navigate('/admin/contests')}>
        {tr('admin.contests.title')}
      </button>
      <span aria-hidden="true">/</span>
      {#if draftState}
        <span class="truncate">{tr('admin.contests.crumbDraft')}</span>
      {/if}
    {/snippet}

    {#snippet beside()}
      <Badge word={tr(`contests.phase.${phase}`)} tone={badge.tone} form={badge.form} />
    {/snippet}

    {#snippet lede()}
      <span class="font-mono text-2xs text-ink">{location.host}{contestPath(c.slug)}</span>
      {#if draftState}
        <span class="text-2xs text-muted">{tr('admin.contests.addressWhenOpen')}</span>
      {/if}
    {/snippet}

    {#snippet actions()}
      <!-- Staff may open a draft's page (contests.md §3): the problems as the
           class will read them, before the class can. -->
      <a class="btn-outline" href={contestPath(c.slug)} target="_blank" rel="noreferrer">
        {tr('admin.contests.preview')}
      </a>
      <button type="button" class="btn-outline max-[640px]:flex-1" disabled={busy} onclick={() => void save()}>
        {saved ? tr('admin.contests.saved') : tr('admin.contests.save')}
      </button>
      {#if draftState}
        <button
          type="button"
          class="btn-primary btn-caps max-[640px]:flex-1"
          disabled={busy || view.readiness.length > 0}
          title={view.readiness.length > 0 ? view.readiness.join('\n') : undefined}
          onclick={() => void open()}
        >
          {tr('admin.contests.openContest')}
        </button>
      {/if}
    {/snippet}

    {@render form()}
  </AdminPage>
{/if}

{#if picking}
  <ProblemPicker
    contestId={c.id}
    {busy}
    error={pickError}
    onpick={(problemId) => void copyFrom(problemId)}
    oncancel={() => (picking = false)}
  />
{/if}
