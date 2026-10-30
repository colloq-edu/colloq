<!--
  A problem's editor (Paper 19 · A3): the statement, the limits and how an
  output is checked, the tests, and the reference solution with its check.

  The order is the order a problem is made in, and the last section is the
  gate: a contest opens only when every reference passes every test of its
  problem (contests.md §0). So the reference's strip says not only «passes»
  but how much room it leaves under the time limit — a C++ reference at half
  the limit is a problem only C++ can pass, and the class finds that out in
  the middle of the test.

  Tests change through their own doors at once (an archive, a test typed in,
  a sample mark); the statement, the limits, the checker and the reference
  wait for «Сохранить», and «Проверить эталон» saves first — a check of a
  reference the server has not seen would pass the old one.

  Everything here is the teacher's: the tests' data, the answers, the checker,
  the reference. The participant's page gets the examples and nothing else
  (shared/contests-entrant.ts).
-->
<script lang="ts">
  import { formatNumber, tr } from '@shared/i18n'
  import { untrack } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Section from '@/admin/ui/Section.svelte'
  import Choice from '@/admin/ui/Choice.svelte'
  import Check from '@/admin/ui/Check.svelte'
  import EmptyState from '@/admin/ui/EmptyState.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import CodeEditor from '@/components/contests/CodeEditor.svelte'
  import MarkdownField from './MarkdownField.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn, formatBytes } from '@/lib/utils'
  import {
    CHECKER_KINDS,
    CONTEST_LANGUAGES,
    CONTEST_LIMITS,
    LANGUAGE_FILE,
    PROBLEM_POINTS,
    pointGroups,
    problemMaxPoints,
    type CheckerKind,
    type ContestLanguage,
    type PointsMode,
  } from '@shared/contests'
  import type { AdminSubmissionDetail, ArchiveImport, ContestView, ProblemPatch, ProblemView } from '@shared/contests-api'
  import {
    backFromProblem,
    dataPreview,
    epsilonWords,
    failedReport,
    languageLabel,
    marginWords,
    memoryWords,
    referenceBadge,
    referenceFailure,
    reportByTest,
    secondsWords,
    testResultWords,
  } from '@/admin/contests'

  interface Props {
    view: ContestView
    problemId: string
    navigate: (path: string) => void
    onview: (view: ContestView) => void
  }

  let { view, problemId, navigate, onview }: Props = $props()

  const c = $derived(view.contest)
  const problem = $derived(view.problems.find((one) => one.id === problemId) ?? null)

  let busy = $state(false)
  let errorText = $state<(() => string) | null>(null)
  const error = $derived(errorText?.() ?? null)
  /** Where the refusal is said: a test's upload answers in the tests' section, not two screens up. */
  let errorAt = $state<'form' | 'tests' | 'reference'>('form')
  let saved = $state(false)

  /* --------------------------------------------------------------- drafts */

  let drafted: string | null = null
  let title = $state('')
  let statement = $state('')
  /** Seconds, as the tile shows them; the server keeps milliseconds. */
  let timeSeconds = $state<number | null>(1)
  let memoryMb = $state<number | null>(CONTEST_LIMITS.memoryMb.default)
  let checker = $state<CheckerKind>('tokens')
  let epsilon = $state<number | null>(CONTEST_LIMITS.epsilon.default)
  let checkerCode = $state('')
  let points = $state<PointsMode>('tests')
  let referenceLanguage = $state<ContestLanguage>('python3')
  let referenceSource = $state('')

  $effect(() => {
    const open = problem
    if (!open || drafted === open.id) return
    drafted = open.id
    title = open.title
    statement = open.statement
    timeSeconds = open.timeLimitMs / 1000
    memoryMb = open.memoryMb
    checker = open.checker
    epsilon = open.checkerEpsilon
    checkerCode = open.checkerCode
    points = open.points
    referenceLanguage = open.referenceLanguage
    referenceSource = open.referenceSource
    untrack(() => {
      manual = null
      pendingArchive = null
      imported = null
      showAll = false
    })
  })

  const timeLimitMs = $derived(Math.round(Number(timeSeconds ?? 0) * 1000))
  const referenceDirty = $derived(
    !!problem && (referenceSource !== problem.referenceSource || referenceLanguage !== problem.referenceLanguage),
  )
  const dirty = $derived(
    !!problem &&
      (referenceDirty ||
        title !== problem.title ||
        statement !== problem.statement ||
        timeLimitMs !== problem.timeLimitMs ||
        Number(memoryMb ?? 0) !== problem.memoryMb ||
        checker !== problem.checker ||
        (checker === 'float' && Number(epsilon) !== problem.checkerEpsilon) ||
        (checker === 'custom' && checkerCode !== problem.checkerCode) ||
        points !== problem.points),
  )

  /* ------------------------------------------------------------- requests */

  const explain = (cause: unknown): string =>
    cause instanceof AdminApiError ? cause.message : tr('admin.contests.requestFailed')

  function lost(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
  }

  async function act<T>(what: () => Promise<T>, at: 'form' | 'tests' | 'reference' = 'form'): Promise<T | null> {
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

  /** A problem's fresh snapshot into the contest's view; the rest (letters, readiness) comes with the next read. */
  function merge(fresh: ProblemView): void {
    onview({ ...view, problems: view.problems.map((one) => (one.id === fresh.id ? fresh : one)) })
  }

  async function refresh(): Promise<void> {
    const id = c.id
    try {
      const fresh = await adminApi.contests.get(id)
      if (id === c.id) onview(fresh)
    } catch (cause) {
      lost(cause)
    }
  }

  function range(what: string, limit: { min: number; max: number }, unit = ''): () => string {
    return () => tr('admin.contests.refusal.range', { what, min: `${formatNumber(limit.min)}${unit}`, max: `${formatNumber(limit.max)}${unit}` })
  }

  function problemBody(): ProblemPatch | null {
    errorAt = 'form'
    if (!title.trim()) {
      errorText = () => tr('admin.contests.refusal.problemTitle')
      return null
    }
    const time = CONTEST_LIMITS.timeLimitMs
    if (!Number.isFinite(timeLimitMs) || timeLimitMs < time.min || timeLimitMs > time.max) {
      errorText = () => tr('admin.contests.refusal.range', { what: tr('admin.contests.timeLimit'), min: formatNumber(time.min / 1000), max: formatNumber(time.max / 1000) })
      return null
    }
    const memory = Number(memoryMb ?? 0)
    if (!Number.isInteger(memory) || memory < CONTEST_LIMITS.memoryMb.min || memory > CONTEST_LIMITS.memoryMb.max) {
      errorText = range(tr('admin.contests.memoryLimit'), CONTEST_LIMITS.memoryMb)
      return null
    }
    const eps = Number(epsilon ?? 0)
    if (checker === 'float' && (!Number.isFinite(eps) || eps <= CONTEST_LIMITS.epsilon.min || eps > CONTEST_LIMITS.epsilon.max)) {
      errorText = () => tr('admin.contests.refusal.epsilon')
      return null
    }
    if (checker === 'custom' && !checkerCode.trim()) {
      errorText = () => tr('admin.contests.refusal.checkerCode')
      return null
    }
    return {
      title: title.trim(),
      statement,
      timeLimitMs,
      memoryMb: memory,
      checker,
      checkerEpsilon: checker === 'float' ? eps : (problem?.checkerEpsilon ?? CONTEST_LIMITS.epsilon.default),
      checkerCode,
      points,
      referenceLanguage,
      referenceSource,
    }
  }

  async function save(): Promise<boolean> {
    const id = c.id
    const pid = problemId
    const body = problemBody()
    if (!body) return false
    const fresh = await act(() => adminApi.contests.updateProblem(id, pid, body))
    if (!fresh) return false
    merge(fresh)
    saved = true
    setTimeout(() => (saved = false), 1600)
    void refresh()
    return true
  }

  async function back(): Promise<void> {
    if (dirty && !(await save())) return
    navigate(backFromProblem(c))
  }

  /* --------------------------------------------------------------- delete */

  let deleting = $state(false)
  let deleteError = $state<string | null>(null)

  async function destroy(): Promise<void> {
    const id = c.id
    const pid = problemId
    const contest = c
    if (busy) return
    busy = true
    deleteError = null
    try {
      const fresh = await adminApi.contests.deleteProblem(id, pid)
      deleting = false
      if (fresh && typeof fresh === 'object' && 'contest' in fresh) onview(fresh)
      navigate(backFromProblem(contest))
    } catch (cause) {
      lost(cause)
      deleteError = explain(cause)
    } finally {
      busy = false
    }
  }

  /* ---------------------------------------------------------------- tests */

  /** A picked archive waiting for «Заменить» or «Добавить» — asked only when there are tests to lose. */
  let pendingArchive = $state<File | null>(null)
  let imported = $state<ArchiveImport | null>(null)
  let showAll = $state(false)
  const SHOWN = 20

  async function upload(file: File, mode: 'replace' | 'append'): Promise<void> {
    const id = c.id
    const pid = problemId
    pendingArchive = null
    const result = await act(() => adminApi.contests.uploadTests(id, pid, file, mode), 'tests')
    if (!result) return
    imported = result
    merge(result.problem)
    void refresh()
  }

  function picked(files: FileList | null): void {
    const file = files?.[0]
    if (!file || !problem) return
    imported = null
    if (problem.tests.length === 0) void upload(file, 'replace')
    else pendingArchive = file
  }

  /** The hand-typed test's form; null — closed. */
  let manual = $state<{ input: string; answer: string; sample: boolean; group: number } | null>(null)

  async function addTest(): Promise<void> {
    const form = manual
    if (!form) return
    const id = c.id
    const pid = problemId
    const fresh = await act(
      () =>
        adminApi.contests.addTest(id, pid, {
          input: form.input,
          answer: form.answer.trim() === '' ? null : form.answer,
          sample: form.sample,
          group: form.group,
        }),
      'tests',
    )
    if (!fresh) return
    merge(fresh)
    manual = null
    void refresh()
  }

  async function patchTest(ordinal: number, body: { sample?: boolean; group?: number }): Promise<void> {
    const id = c.id
    const pid = problemId
    const fresh = await act(() => adminApi.contests.updateTest(id, pid, ordinal, body), 'tests')
    if (fresh) merge(fresh)
  }

  async function dropTest(ordinal: number): Promise<void> {
    const id = c.id
    const pid = problemId
    const fresh = await act(() => adminApi.contests.deleteTest(id, pid, ordinal), 'tests')
    if (fresh) {
      merge(fresh)
      void refresh()
    }
  }

  let clearing = $state(false)
  let clearError = $state<string | null>(null)

  async function dropAllTests(): Promise<void> {
    const id = c.id
    const pid = problemId
    if (busy) return
    busy = true
    clearError = null
    try {
      merge(await adminApi.contests.deleteTests(id, pid))
      clearing = false
      imported = null
      void refresh()
    } catch (cause) {
      lost(cause)
      clearError = explain(cause)
    } finally {
      busy = false
    }
  }

  /** «Ответы из эталона»: saved first, so the answers are written by the reference on the screen. */
  async function writeAnswers(): Promise<void> {
    const id = c.id
    const pid = problemId
    if (referenceDirty && !(await save())) return
    const fresh = await act(() => adminApi.contests.writeAnswers(id, pid), 'tests')
    if (fresh) merge(fresh)
  }

  /* ----------------------------------------------------- IOI: the points */

  const ioi = $derived(c.rules === 'ioi')
  /** The groups the tests name, with the points the table gives each; edited here, saved by «Сохранить баллы». */
  let groupPoints = $state<Record<number, number | null>>({})
  let groupsFor: string | null = null

  $effect(() => {
    const open = problem
    if (!open) return
    const key = `${open.id}:${open.tests.map((test) => test.group).join(',')}:${open.groups.map((g) => `${g.group}=${g.points}`).join(',')}`
    if (groupsFor === key) return
    groupsFor = key
    const next: Record<number, number | null> = {}
    for (const test of open.tests) next[test.group] = open.groups.find((g) => g.group === test.group)?.points ?? 0
    groupPoints = next
  })

  const groupNumbers = $derived(Object.keys(groupPoints).map(Number).sort((a, b) => a - b))
  const groupsTotal = $derived(groupNumbers.reduce((sum, group) => sum + Number(groupPoints[group] ?? 0), 0))
  /** Under «поровну за тесты»: what each test is worth, by ordinal (shared rule, pointGroups). */
  const testPoints = $derived(
    problem && ioi && points === 'tests'
      ? new Map(pointGroups(problem.tests, 'tests', []).map((group) => [group.tests[0], group.points]))
      : null,
  )

  async function saveGroups(): Promise<void> {
    const id = c.id
    const pid = problemId
    const groups = groupNumbers.map((group) => ({ group, points: Math.max(0, Math.round(Number(groupPoints[group] ?? 0))) }))
    const fresh = await act(() => adminApi.contests.saveGroups(id, pid, groups), 'tests')
    if (fresh) merge(fresh)
  }

  /* ------------------------------------------------------- the reference */

  const reference = $derived(problem?.reference ?? null)
  const inFlight = $derived(
    !!problem && (problem.reference.state === 'queued' || problem.reference.state === 'running' || problem.answersRunning),
  )

  /*
   * While the reference is judged (or writes answers) the screen asks about
   * it itself, every few seconds: there is no stream on an editor, and a
   * «проверяется» that never moves reads as a check that never started.
   */
  $effect(() => {
    if (!inFlight) return
    const tick = window.setInterval(() => untrack(() => void refresh()), 2500)
    return () => window.clearInterval(tick)
  })

  /**
   * The last reference run's report: the per-test results of the table's
   * «ЭТАЛОН» column, the strip's squares, the compiler's log of a CE. Asked
   * once per run, when the run has a verdict.
   */
  let report = $state<AdminSubmissionDetail | null>(null)
  let reportFor: string | null = null

  $effect(() => {
    const sid = reference?.submissionId ?? null
    const settled = reference?.state === 'passes' || reference?.state === 'fails'
    const id = c.id
    if (!sid || !settled) {
      if (!sid) report = null
      return
    }
    if (reportFor === sid) return
    reportFor = sid
    void adminApi.contests
      .submission(id, sid)
      .then((detail) => {
        if (reportFor === sid) report = detail
      })
      .catch(() => {
        // The table and the strip keep what the problem's own status says.
        if (reportFor === sid) reportFor = null
      })
  })

  /*
   * The table's «ЭТАЛОН» column and its data's first bytes, from the run the
   * status is about — never from an older one: after the tests change the
   * reference is «не проверен», and last run's «OK · 0,02» beside a test
   * that was just replaced would be a claim about a test nobody ran.
   */
  const byTest = $derived(
    reportByTest(
      report && reference && (reference.state === 'passes' || reference.state === 'fails') && report.id === reference.submissionId
        ? report.tests
        : null,
    ),
  )

  async function checkReference(): Promise<void> {
    const id = c.id
    const pid = problemId
    if (dirty && !(await save())) return
    const fresh = await act(() => adminApi.contests.checkReference(id, pid), 'reference')
    if (fresh) merge(fresh)
  }

  /** The languages the reference can be in: what the image runs; the saved one stays listed whatever it is. */
  const referenceOptions = $derived(
    CONTEST_LANGUAGES.filter(
      (one) => one === referenceLanguage || view.languages.length === 0 || view.languages.some((option) => option.id === one && option.available),
    ),
  )

  const referenceFile = $derived(`reference.${LANGUAGE_FILE[referenceLanguage].split('.').pop()}`)
  const referenceLines = $derived(referenceSource === '' ? 0 : referenceSource.replace(/\n$/, '').split('\n').length)
  const margin = $derived(reference ? marginWords(reference, timeLimitMs) : null)
  const failed = $derived(report ? failedReport(report.tests) : null)

  const STRIP = {
    passes: { frame: 'border-positive', block: 'bg-positive text-white dark:text-canvas' },
    fails: { frame: 'border-danger', block: 'bg-danger text-white dark:text-canvas' },
    queued: { frame: 'border-line', block: 'bg-surface text-ink' },
    running: { frame: 'border-accent', block: 'bg-accent/15 text-accent-text' },
    unchecked: { frame: 'border-warning', block: 'bg-warning/10 text-warning' },
    missing: { frame: 'border-line', block: 'bg-surface text-muted' },
  } as const

  const CELL: Record<string, string> = {
    OK: 'bg-positive',
    skipped: 'bg-line',
  }

  const MARGIN_TONE = { ink: 'text-ink', warning: 'text-warning', danger: 'text-danger', muted: 'text-muted' } as const
  const HEAD = 'admin-label'
  const TILE = 'flex min-w-0 flex-1 basis-[150px] flex-col gap-1.5 border border-line px-3.5 py-3'
  const TILE_INPUT =
    'w-[84px] border-b border-line bg-transparent font-mono text-head font-bold text-ink focus:border-accent focus:outline-none'
  const CHECKER_SIGNATURE = 'def check(input, output, answer) -> bool'
</script>

{#if !problem}
  <AdminPage title={c.title}>
    <EmptyState title={tr('admin.contests.problemMissing')} hint={tr('admin.contests.problemMissingHint')}>
      <button type="button" class="btn-primary" onclick={() => navigate(backFromProblem(c))}>
        {tr('admin.contests.backToContest')}
      </button>
    </EmptyState>
  </AdminPage>
{:else}
  {@const shownTests = showAll ? problem.tests : problem.tests.slice(0, SHOWN)}
  {@const refLook = referenceBadge(problem.reference)}
  <AdminPage title={`${problem.letter}. ${problem.title || tr('admin.contests.untitled')}`}>
    {#snippet eyebrow()}
      <button type="button" class="shrink-0 transition-colors duration-100 hover:text-ink" onclick={() => navigate('/admin/contests')}>
        {tr('admin.contests.title')}
      </button>
      <span aria-hidden="true">/</span>
      <button type="button" class="min-w-0 truncate transition-colors duration-100 hover:text-ink" onclick={() => void back()}>
        {c.title}
      </button>
      <span aria-hidden="true">/</span>
      <span class="shrink-0">{tr('admin.contests.crumbProblems')}</span>
    {/snippet}

    {#snippet beside()}
      <Badge word={refLook.word} tone={refLook.tone} />
    {/snippet}

    {#snippet actions()}
      <button type="button" class="btn-ghost text-danger hover:text-danger" disabled={busy} onclick={() => ((deleting = true), (deleteError = null))}>
        {tr('admin.contests.deleteProblem')}
      </button>
      <button type="button" class="btn-outline" disabled={busy} onclick={() => void back()}>
        <Icon name="chevron-left" size={14} />
        {tr('admin.contests.backToContest')}
      </button>
      <button type="button" class="btn-primary max-[640px]:flex-1" disabled={busy} onclick={() => void save()}>
        {saved ? tr('admin.contests.saved') : tr('admin.contests.save')}
      </button>
    {/snippet}

    {#if error && errorAt === 'form'}
      <p class="pt-4 text-ui text-danger" role="alert">{error}</p>
    {/if}

    <!-- 1 · Statement -->
    <Section title={tr('admin.contests.section.statement')} description={tr('admin.contests.statementHint')}>
      <div class="flex flex-col gap-2.5">
        <input
          class="field"
          aria-label={tr('admin.contests.problemTitleLabel')}
          maxlength={CONTEST_LIMITS.problemTitle}
          bind:value={title}
        />
        <MarkdownField
          bind:value={statement}
          label={tr('admin.contests.statementLabel')}
          placeholder={tr('admin.contests.statementPlaceholder')}
          maxlength={CONTEST_LIMITS.statement}
          rows={10}
        />
      </div>
    </Section>

    <!-- 2 · Limits and the checker -->
    <Section title={tr('admin.contests.section.limits')} description={tr('admin.contests.limitsHint')}>
      <div class="flex flex-col gap-4">
        <div class="flex flex-wrap gap-3">
          <label class={TILE}>
            <span class={HEAD}>{tr('admin.contests.timeLimit')}</span>
            <span class="flex items-baseline gap-1.5">
              <input
                class={TILE_INPUT}
                type="number"
                step="0.1"
                min={CONTEST_LIMITS.timeLimitMs.min / 1000}
                max={CONTEST_LIMITS.timeLimitMs.max / 1000}
                bind:value={timeSeconds}
              />
              <span class="text-2xs text-muted">{tr('admin.contests.secondsShort')}</span>
            </span>
          </label>
          <label class={TILE}>
            <span class={HEAD}>{tr('admin.contests.memoryLimit')}</span>
            <span class="flex items-baseline gap-1.5">
              <input
                class={TILE_INPUT}
                type="number"
                min={CONTEST_LIMITS.memoryMb.min}
                max={CONTEST_LIMITS.memoryMb.max}
                bind:value={memoryMb}
              />
              <span class="text-2xs text-muted">{tr('admin.contests.megabytes')}</span>
            </span>
          </label>
          <div class="flex min-w-0 flex-[2_1_260px] flex-col gap-1.5 bg-surface px-3.5 py-3">
            <span class={HEAD}>{tr('admin.contests.margin')}</span>
            {#if margin}
              <span class={cn('text-2xs', MARGIN_TONE[margin.tone])}>{margin.text}</span>
            {/if}
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Choice
            options={CHECKER_KINDS.map((kind) => ({
              value: kind,
              label:
                kind === 'float'
                  ? tr('admin.contests.checker.float', { epsilon: epsilonWords(Number(epsilon ?? CONTEST_LIMITS.epsilon.default)) })
                  : tr(`admin.contests.checker.${kind}`),
            }))}
            value={checker}
            onchange={(value) => (checker = value as CheckerKind)}
          />
          {#if checker === 'float'}
            <label class="flex items-center gap-2">
              <span class={HEAD}>{tr('admin.contests.epsilonLabel')}</span>
              <input
                class="field w-[130px] font-mono"
                type="number"
                step="any"
                min={CONTEST_LIMITS.epsilon.min}
                max={CONTEST_LIMITS.epsilon.max}
                bind:value={epsilon}
              />
            </label>
          {/if}
        </div>

        <p class="text-2xs text-muted">
          {#if checker === 'tokens'}
            {tr('admin.contests.checkerNote.tokens')}
            <span class="font-mono text-ink">{CHECKER_SIGNATURE}</span>.
          {:else if checker === 'lines'}
            {tr('admin.contests.checkerNote.lines')}
          {:else if checker === 'float'}
            {tr('admin.contests.checkerNote.float', { epsilon: epsilonWords(Number(epsilon ?? 0)) })}
          {:else}
            {tr('admin.contests.checkerNote.custom')}
            <span class="font-mono text-ink">{CHECKER_SIGNATURE}</span>.
          {/if}
        </p>

        {#if checker === 'custom'}
          {#key problem.id}
            <CodeEditor
              initial={checkerCode}
              language="python3"
              label={tr('admin.contests.checkerCodeLabel')}
              placeholder={tr('admin.contests.checkerPlaceholder')}
              height="240px"
              onchange={(text) => (checkerCode = text)}
            />
          {/key}
        {/if}
      </div>
    </Section>

    <!-- 3 · Tests -->
    <Section title={tr('admin.contests.section.tests')} description={tr('admin.contests.testsHint')}>
      <div class="tests-block flex flex-col">
        <div class="flex flex-wrap items-center gap-2 pb-3">
          <label class={cn('btn-outline border-primary font-semibold text-primary', busy ? 'pointer-events-none opacity-40' : 'cursor-pointer')}>
            <input
              type="file"
              accept=".zip,application/zip"
              class="sr-only"
              disabled={busy}
              onchange={(event) => {
                picked(event.currentTarget.files)
                event.currentTarget.value = ''
              }}
            />
            <Icon name="upload" size={14} />
            {tr('admin.contests.uploadArchive')}
          </label>
          <button
            type="button"
            class="btn-outline"
            disabled={busy || problem.tests.length >= CONTEST_LIMITS.tests}
            onclick={() => (manual = manual ? null : { input: '', answer: '', sample: false, group: 1 })}
          >
            {tr('admin.contests.addTest')}
          </button>
          <button
            type="button"
            class="btn-outline"
            disabled={busy || problem.answersRunning || !problem.referenceSource.trim() || problem.tests.length === 0}
            title={problem.referenceSource.trim() ? undefined : tr('admin.contests.answersNeedReference')}
            onclick={() => void writeAnswers()}
          >
            {problem.answersRunning
              ? tr('admin.contests.answersRunning')
              : problem.missingAnswers > 0
                ? tr('admin.contests.answersFromReferenceCount', { count: problem.missingAnswers })
                : tr('admin.contests.answersFromReference')}
          </button>
          <span class="ml-auto text-2xs text-muted">
            {tr('admin.contests.testsSummary', { count: problem.tests.length, size: formatBytes(problem.testBytes) })}
          </span>
        </div>

        {#if error && errorAt === 'tests'}
          <p class="pb-3 text-ui text-danger" role="alert">{error}</p>
        {/if}

        {#if pendingArchive}
          {@const file = pendingArchive}
          <!-- An archive over existing tests: whether it replaces them or goes
               after them is asked, never guessed — a replace wipes answers
               typed in by hand. -->
          <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border border-line bg-surface px-3.5 py-3">
            <span class="min-w-0 flex-1 basis-[200px] text-2xs text-ink">
              {tr('admin.contests.archive.mode', { name: file.name, count: problem.tests.length })}
            </span>
            <button type="button" class="btn-outline" disabled={busy} onclick={() => void upload(file, 'append')}>
              {tr('admin.contests.archive.append')}
            </button>
            <button type="button" class="btn-danger" disabled={busy} onclick={() => void upload(file, 'replace')}>
              {tr('admin.contests.archive.replace')}
            </button>
            <button type="button" class="btn-ghost" onclick={() => (pendingArchive = null)}>{tr('admin.cancel')}</button>
          </div>
        {/if}

        {#if imported}
          {@const result = imported}
          <div class="mb-3 flex items-start gap-3 border-l-[3px] border-positive bg-positive/5 px-3.5 py-2.5" role="status">
            <p class="min-w-0 flex-1 text-2xs text-ink">
              {tr('admin.contests.archive.result', { count: result.added })}
              {#if result.withoutAnswers > 0}
                {tr('admin.contests.archive.withoutAnswers', { count: result.withoutAnswers })}
              {/if}
              {#if result.skipped.length > 0}
                <span class="text-muted">{tr('admin.contests.archive.skipped', { names: result.skipped.join(', ') })}</span>
              {/if}
            </p>
            <button type="button" class="shrink-0 text-faint hover:text-ink" aria-label={tr('admin.close')} onclick={() => (imported = null)}>
              <Icon name="x" size={13} />
            </button>
          </div>
        {/if}

        {#if manual}
          <form
            class="mb-3 flex flex-col gap-3 border border-line bg-surface px-3.5 py-3"
            onsubmit={(event) => {
              event.preventDefault()
              void addTest()
            }}
          >
            <div class="flex flex-wrap gap-3">
              <label class="flex min-w-0 flex-1 basis-[220px] flex-col gap-1.5">
                <span class={HEAD}>{tr('admin.contests.manual.input')}</span>
                <textarea
                  class="field min-h-[96px] resize-y py-2 font-mono text-micro"
                  spellcheck="false"
                  bind:value={manual.input}
                ></textarea>
              </label>
              <label class="flex min-w-0 flex-1 basis-[220px] flex-col gap-1.5">
                <span class={HEAD}>{tr('admin.contests.manual.answer')}</span>
                <textarea
                  class="field min-h-[96px] resize-y py-2 font-mono text-micro"
                  spellcheck="false"
                  placeholder={tr('admin.contests.manual.answerHint')}
                  bind:value={manual.answer}
                ></textarea>
              </label>
            </div>
            <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
              <label class="flex cursor-pointer items-center gap-2.5">
                <Check bind:checked={manual.sample} label={tr('admin.contests.manual.sample')} />
                <span class="text-2xs text-ink">{tr('admin.contests.manual.sample')}</span>
              </label>
              {#if ioi && points === 'groups'}
                <label class="flex items-center gap-2">
                  <span class={HEAD}>{tr('admin.contests.manual.group')}</span>
                  <input class="field w-[84px] font-mono" type="number" min="0" max="99" bind:value={manual.group} />
                </label>
              {/if}
              <span class="ml-auto flex gap-2">
                <button type="button" class="btn-ghost" onclick={() => (manual = null)}>{tr('admin.cancel')}</button>
                <button type="submit" class="btn-primary" disabled={busy || manual.input === ''}>
                  {tr('admin.contests.manual.add')}
                </button>
              </span>
            </div>
          </form>
        {/if}

        {#if ioi}
          <!-- IOI: how the problem's points split. The groups' table is its own
               door (PUT …/groups) and its own button: points are not a field
               of the statement. -->
          <div class="mb-3 flex flex-col gap-2.5 border border-line px-3.5 py-3">
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span class={HEAD}>{tr('admin.contests.points.head')}</span>
              <Choice
                options={[
                  { value: 'tests', label: tr('admin.contests.points.tests') },
                  { value: 'groups', label: tr('admin.contests.points.groups') },
                ]}
                value={points}
                onchange={(value) => (points = value as PointsMode)}
              />
            </div>
            <p class="text-2xs text-muted">
              {points === 'tests'
                ? tr('admin.contests.points.testsHint', { max: PROBLEM_POINTS })
                : tr('admin.contests.points.groupsHint')}
            </p>
            {#if points === 'groups' && groupNumbers.length > 0}
              <div class="flex flex-wrap items-end gap-3">
                {#each groupNumbers as group (group)}
                  <label class="flex flex-col gap-1">
                    <span class="text-micro text-muted">
                      {tr('admin.contests.points.group', { group })} ·
                      {tr('admin.contests.points.groupTests', { count: problem.tests.filter((test) => test.group === group).length })}
                    </span>
                    <input class="field w-[96px] font-mono" type="number" min="0" max="1000" bind:value={groupPoints[group]} />
                  </label>
                {/each}
                <span class="pb-2.5 font-mono text-2xs text-ink">
                  {tr('admin.contests.points.total', { count: groupsTotal })}
                  {#if groupsTotal !== problemMaxPoints(problem.groups)}
                    <span class="text-muted">· {tr('admin.contests.points.saved', { count: problemMaxPoints(problem.groups) })}</span>
                  {/if}
                </span>
                <button type="button" class="btn-outline" disabled={busy} onclick={() => void saveGroups()}>
                  {tr('admin.contests.points.save')}
                </button>
              </div>
              {#if points !== problem.points}
                <p class="text-micro text-muted">{tr('admin.contests.points.saveMode')}</p>
              {/if}
            {/if}
          </div>
        {/if}

        {#if problem.tests.length === 0}
          <div class="border border-dashed border-line px-4 py-6 text-center">
            <p class="text-ui font-semibold text-ink">{tr('admin.contests.noTests')}</p>
            <p class="mt-1 text-2xs text-muted">{tr('admin.contests.noTestsHint')}</p>
          </div>
        {:else}
          <div class="tests-head admin-list-head">
            <span class="admin-label w-10 shrink-0">{tr('admin.contests.col.number')}</span>
            <span class="admin-label w-[76px] shrink-0">{tr('admin.contests.col.sample')}</span>
            {#if ioi}
              <span class="admin-label w-[72px] shrink-0">
                {points === 'groups' ? tr('admin.contests.col.group') : tr('admin.contests.col.points')}
              </span>
            {/if}
            <span class="admin-label min-w-0 flex-1">{tr('admin.contests.col.input')}</span>
            <span class="tests-answer admin-label w-[190px] shrink-0">{tr('admin.contests.col.answer')}</span>
            <span class="admin-label w-[110px] shrink-0 text-right">{tr('admin.contests.col.reference')}</span>
            <span class="w-[124px] shrink-0" aria-hidden="true"></span>
          </div>
          {#each shownTests as test (test.ordinal)}
            {@const seen = byTest.get(test.ordinal)}
            {@const result = testResultWords(seen)}
            <div class="tests-row admin-data-row py-2">
              <span class="w-10 shrink-0 font-mono text-2xs text-ink">{test.ordinal}</span>
              <span class="w-[76px] shrink-0">
                <Check
                  checked={test.sample}
                  size={16}
                  disabled={busy}
                  label={tr('admin.contests.sampleToggle', { test: test.ordinal })}
                  onchange={(sample) => void patchTest(test.ordinal, { sample })}
                />
              </span>
              {#if ioi}
                <span class="w-[72px] shrink-0">
                  {#if points === 'groups'}
                    <input
                      class="w-[56px] border-b border-line bg-transparent font-mono text-2xs text-ink focus:border-accent focus:outline-none"
                      type="number"
                      min="0"
                      max="99"
                      value={test.group}
                      aria-label={tr('admin.contests.groupOf', { test: test.ordinal })}
                      onchange={(event) => {
                        const group = Number(event.currentTarget.value)
                        if (Number.isInteger(group) && group >= 0 && group !== test.group) void patchTest(test.ordinal, { group })
                      }}
                    />
                  {:else}
                    <span class="font-mono text-2xs text-muted">{testPoints?.get(test.ordinal) ?? 0}</span>
                  {/if}
                </span>
              {/if}
              <span class="flex min-w-0 flex-1 items-baseline gap-2.5">
                {#if dataPreview(seen?.input)}
                  <span class="min-w-0 truncate font-mono text-micro text-ink">{dataPreview(seen?.input)}</span>
                {/if}
                <span class="shrink-0 font-mono text-micro text-faint">{formatBytes(test.inputBytes)}</span>
              </span>
              <span class="tests-answer flex w-[190px] min-w-0 shrink-0 items-baseline gap-2.5">
                {#if test.answerBytes === null}
                  <span class="text-micro text-warning">{tr('admin.contests.answer.missing')}</span>
                {:else}
                  {#if dataPreview(seen?.answer, 16)}
                    <span class="min-w-0 truncate font-mono text-micro text-ink">{dataPreview(seen?.answer, 16)}</span>
                  {/if}
                  <span class="shrink-0 font-mono text-micro text-faint">
                    {test.answerFrom === 'reference' ? tr('admin.contests.answer.fromReference') : formatBytes(test.answerBytes)}
                  </span>
                {/if}
              </span>
              <span
                class={cn(
                  'w-[110px] shrink-0 text-right font-mono text-micro',
                  !seen ? 'text-faint' : seen.verdict === 'OK' ? 'text-positive' : seen.verdict === 'skipped' ? 'text-muted' : 'text-danger',
                )}
              >
                {result ?? '—'}
              </span>
              <span class="flex w-[124px] shrink-0 items-center justify-end">
                <a
                  class="admin-icon-btn"
                  href={adminApi.contests.testFileUrl(c.id, problem.id, test.ordinal, 'input')}
                  download
                  aria-label={tr('admin.contests.downloadInput', { test: test.ordinal })}
                  title={tr('admin.contests.downloadInput', { test: test.ordinal })}
                >
                  <Icon name="download" size={13} />
                </a>
                {#if test.answerBytes !== null}
                  <a
                    class="admin-icon-btn"
                    href={adminApi.contests.testFileUrl(c.id, problem.id, test.ordinal, 'answer')}
                    download
                    aria-label={tr('admin.contests.downloadAnswer', { test: test.ordinal })}
                    title={tr('admin.contests.downloadAnswer', { test: test.ordinal })}
                  >
                    <Icon name="file" size={13} />
                  </a>
                {/if}
                <button
                  type="button"
                  class="admin-icon-btn hover:text-danger"
                  disabled={busy}
                  aria-label={tr('admin.contests.deleteTest', { test: test.ordinal })}
                  title={tr('admin.contests.deleteTest', { test: test.ordinal })}
                  onclick={() => void dropTest(test.ordinal)}
                >
                  <Icon name="trash" size={13} />
                </button>
              </span>
            </div>
          {/each}
          <div class="flex flex-wrap items-center gap-x-5 gap-y-2 pt-2.5">
            {#if problem.tests.length > SHOWN}
              <button type="button" class="text-2xs text-accent-text hover:brightness-110" onclick={() => (showAll = !showAll)}>
                {showAll
                  ? tr('admin.contests.showFewerTests')
                  : tr('admin.contests.showMoreTests', { count: problem.tests.length - SHOWN })}
              </button>
            {/if}
            <button
              type="button"
              class="ml-auto text-2xs text-danger hover:brightness-110 disabled:text-faint"
              disabled={busy}
              onclick={() => ((clearing = true), (clearError = null))}
            >
              {tr('admin.contests.deleteAllTests')}
            </button>
          </div>
        {/if}
      </div>
    </Section>

    <!-- 4 · The reference -->
    <Section title={tr('admin.contests.section.reference')} description={tr('admin.contests.referenceHint')}>
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <select
            class="field w-auto min-w-0 font-mono"
            aria-label={tr('admin.contests.referenceLanguage')}
            bind:value={referenceLanguage}
          >
            {#each referenceOptions as one (one)}
              <option value={one}>{languageLabel(one, view.languages)}</option>
            {/each}
          </select>
          <span class="text-micro text-muted">
            {referenceFile} · {tr('admin.contests.lines', { count: referenceLines })}
          </span>
        </div>
        {#key problem.id}
          <CodeEditor
            initial={referenceSource}
            language={referenceLanguage}
            label={tr('admin.contests.referenceLabel')}
            placeholder={tr('admin.contests.referencePlaceholder')}
            height="320px"
            onchange={(text) => (referenceSource = text)}
            onsubmit={() => void checkReference()}
          />
        {/key}

        {#if error && errorAt === 'reference'}
          <p class="text-ui text-danger" role="alert">{error}</p>
        {/if}

        {#if reference}
          {@const look = STRIP[reference.state]}
          <!--
            The strip: the verdict in its colour, every test as a square (the
            failed one red, the ones never reached grey), the slowest test and
            the peak memory — the margin the class will have — and the way to
            check again. A reference changed since its check says «не
            проверен» whatever the last verdict was: that verdict is about
            code that no longer exists.
          -->
          <div class={cn('flex flex-wrap items-stretch border', look.frame)}>
            <div class={cn('flex w-[150px] shrink-0 flex-col justify-center gap-0.5 px-4 py-3 max-[640px]:w-full', look.block)}>
              <span class="text-micro font-bold uppercase tracking-caps">{tr(`admin.contests.strip.${reference.state}`)}</span>
              {#if report && report.total !== null && (reference.state === 'passes' || reference.state === 'fails')}
                <span class="text-micro opacity-85">
                  {tr('admin.contests.strip.passed', { passed: report.passed ?? 0, count: report.total })}
                </span>
              {/if}
            </div>
            <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              {#if report && report.tests.length > 0 && (reference.state === 'passes' || reference.state === 'fails')}
                <span class="flex max-w-full flex-wrap gap-[3px]" aria-hidden="true">
                  {#each report.tests as test (test.ordinal)}
                    <span class={cn('size-3 shrink-0', CELL[test.verdict] ?? 'bg-danger')} title={`${test.ordinal}: ${test.verdict}`}></span>
                  {/each}
                </span>
              {/if}
              <span class="min-w-0 flex-1 basis-[220px] text-2xs text-muted">
                {#if reference.state === 'passes'}
                  {[
                    reference.slowestTest !== null && reference.timeMs !== null
                      ? tr('admin.contests.strip.slowest', { test: reference.slowestTest, time: secondsWords(reference.timeMs) })
                      : null,
                    reference.memoryKb !== null ? tr('admin.contests.strip.memory', { memory: memoryWords(reference.memoryKb) }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                {:else if reference.state === 'fails'}
                  <span class="font-semibold text-danger">{referenceFailure(reference)}</span>
                  {#if failed?.note}
                    <span> · {failed.note}</span>
                  {/if}
                {:else if reference.state === 'missing'}
                  {tr('admin.contests.strip.missingHint')}
                {:else if reference.state === 'unchecked'}
                  {tr('admin.contests.strip.uncheckedHint')}
                {:else}
                  {tr('admin.contests.strip.runningHint')}
                {/if}
              </span>
            </div>
            <div class="flex items-center px-4 py-3">
              <button
                type="button"
                class="admin-link"
                disabled={busy || inFlight || !referenceSource.trim() || problem.tests.length === 0}
                onclick={() => void checkReference()}
              >
                {reference.state === 'passes' || reference.state === 'fails'
                  ? tr('admin.contests.checkAgain')
                  : tr('admin.contests.checkReference')}
              </button>
            </div>
          </div>
          {#if reference.state === 'fails' && report}
            {#if report.verdict === 'CE' && report.compileLog}
              <div class="flex flex-col gap-1.5">
                <span class={HEAD}>{tr('admin.contests.drawer.compileLog')}</span>
                <pre class="max-h-[240px] overflow-auto whitespace-pre-wrap border-l-[3px] border-danger bg-danger/5 px-3 py-2.5 font-mono text-micro leading-5 text-ink">{report.compileLog}</pre>
              </div>
            {:else if report.verdict === 'SE' && report.systemDetail}
              <pre class="max-h-[240px] overflow-auto whitespace-pre-wrap border-l-[3px] border-warning bg-warning/5 px-3 py-2.5 font-mono text-micro leading-5 text-ink">{report.systemDetail}</pre>
            {:else if failed && (failed.output !== undefined || failed.answer !== undefined)}
              <div class="grid gap-px border border-line bg-line sm:grid-cols-2">
                <div class="flex min-w-0 flex-col gap-1 bg-canvas px-3 py-2">
                  <span class="admin-label">{tr('admin.contests.drawer.output')}</span>
                  <pre class="max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-micro text-danger">{failed.output ?? ''}</pre>
                </div>
                <div class="flex min-w-0 flex-col gap-1 bg-canvas px-3 py-2">
                  <span class="admin-label">{tr('admin.contests.drawer.answer')}</span>
                  <pre class="max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-micro text-ink">{failed.answer ?? ''}</pre>
                </div>
              </div>
            {/if}
          {/if}
        {/if}
        {#if referenceDirty}
          <p class="text-micro text-muted">{tr('admin.contests.referenceUnsaved')}</p>
        {/if}
      </div>
    </Section>

    <div class="flex flex-wrap items-center gap-3 border-t border-line py-5">
      <button type="button" class="btn-primary" disabled={busy} onclick={() => void save()}>
        {saved ? tr('admin.contests.saved') : tr('admin.contests.save')}
      </button>
      <button type="button" class="btn-outline" disabled={busy} onclick={() => void back()}>
        {tr('admin.contests.backToContest')}
      </button>
      {#if dirty && !saved}
        <span class="text-micro text-muted">{tr('admin.contests.unsaved')}</span>
      {/if}
    </div>
  </AdminPage>

  {#if deleting}
    <ConfirmDialog
      title={tr('admin.contests.deleteProblemHeading', { letter: problem.letter, title: problem.title })}
      body={tr('admin.contests.deleteProblemBody')}
      confirm={tr('admin.contests.deleteProblem')}
      {busy}
      error={deleteError}
      onconfirm={() => void destroy()}
      oncancel={() => (deleting = false)}
    />
  {/if}

  {#if clearing}
    <ConfirmDialog
      title={tr('admin.contests.deleteAllHeading', { letter: problem.letter })}
      body={tr('admin.contests.deleteAllBody', { count: problem.tests.length })}
      confirm={tr('admin.contests.deleteAllTests')}
      {busy}
      error={clearError}
      onconfirm={() => void dropAllTests()}
      oncancel={() => (clearing = false)}
    />
  {/if}
{/if}

<style>
  /*
   * The tests' table on a narrow screen: the answer column goes first — the
   * input's size and the reference's verdict are what a phone has room for,
   * and the answer is a download away.
   */
  .tests-block {
    container-type: inline-size;
  }

  @container (max-width: 560px) {
    .tests-answer {
      display: none;
    }
  }
</style>
