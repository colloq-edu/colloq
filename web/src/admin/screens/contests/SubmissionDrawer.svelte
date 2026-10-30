<!--
  One submission opened beside the feed (Paper 19 · A4, right): who, which
  problem, in what; the verdict in words; every test it ran with its time and
  memory; and for the test it failed, its output against the answer.

  The teacher sees here what nobody else does: the hidden tests' data, the
  program's stderr and exit, the judge's own failure. The participant's
  drawer shows examples only (shared/contests-entrant.ts) — the line under
  the table says so, so a teacher does not promise the class a diff it will
  never see.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import CodeEditor from '@/components/contests/CodeEditor.svelte'
  import VerdictBadge from './VerdictBadge.svelte'
  import { cn } from '@/lib/utils'
  import { verdictTone } from '@shared/contests'
  import type { AdminSubmissionDetail, ContestView } from '@shared/contests-api'
  import {
    failedReport,
    languageLabel,
    memoryWords,
    momentOf,
    notRunRange,
    seconds,
    verdictLine,
  } from '@/admin/contests'

  interface Props {
    detail: AdminSubmissionDetail | null
    /** The detail is on its way (a row was just picked, or a running one is re-read). */
    loading?: boolean
    view: ContestView
    zone: string | null
    now: number
    busy?: boolean
    onrejudge: (submissionId: string) => void
    onclose: () => void
  }

  let { detail, loading = false, view, zone, now, busy = false, onrejudge, onclose }: Props = $props()

  let showCode = $state(false)
  let shownFor: string | null = null
  $effect(() => {
    const id = detail?.id ?? null
    if (id === shownFor) return
    shownFor = id
    showCode = false
  })

  const problem = $derived(detail ? (view.problems.find((one) => one.id === detail.problemId) ?? null) : null)
  const failed = $derived(detail ? failedReport(detail.tests) : null)
  const notRun = $derived(detail && detail.state === 'done' ? notRunRange(detail.tests, detail.total) : null)
  const line = $derived(
    detail ? verdictLine(detail, view.contest.rules === 'ioi' && problem ? problem.maxScore : null) : '',
  )
  const LINE_TONE = {
    positive: 'text-positive',
    danger: 'text-danger',
    warning: 'text-warning',
    neutral: 'text-ink',
    accent: 'text-accent-text',
  } as const
</script>

<div class="flex min-w-0 flex-col gap-4">
  {#if !detail}
    {#if loading}
      <div class="flex flex-col gap-3" role="status" aria-busy="true" aria-label={tr('admin.contests.drawer.loading')}>
        <span class="sr-only">{tr('admin.contests.drawer.loading')}</span>
        <Skeleton width="12rem" height="0.7rem" />
        <Skeleton width="16rem" height="1.1rem" />
        <Skeleton width="100%" height="7rem" radius="0" />
      </div>
    {:else}
      <p class="text-2xs text-muted">{tr('admin.contests.drawer.empty')}</p>
    {/if}
  {:else}
    <div class="flex items-start justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-1">
        <span class="font-mono text-micro text-muted">
          #{detail.number} · {momentOf(detail.submittedAt, now, zone)} · {languageLabel(detail.language, view.languages)}
        </span>
        <h2 class="text-title font-black text-ink">
          {detail.entrant?.name ?? tr('admin.contests.teacherRun')} · {detail.letter}. {problem?.title ?? ''}
        </h2>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button type="button" class="btn-outline" aria-pressed={showCode} onclick={() => (showCode = !showCode)}>
          {showCode ? tr('admin.contests.drawer.tests') : tr('admin.contests.drawer.code')}
        </button>
        <button type="button" class="btn-outline border-primary font-semibold text-primary" disabled={busy} onclick={() => onrejudge(detail.id)}>
          {tr('admin.contests.drawer.rejudge')}
        </button>
        <button type="button" class="admin-icon-btn" aria-label={tr('admin.close')} onclick={onclose}>
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2.5">
      <VerdictBadge verdict={detail.verdict} state={detail.state} />
      <span class={cn('text-ui', LINE_TONE[verdictTone(detail.verdict, detail.state)])}>{line}</span>
      {#if detail.late}
        <span class="text-micro text-muted">· {tr('admin.contests.drawer.lateNote')}</span>
      {/if}
    </div>

    {#if showCode}
      {#key detail.id}
        <CodeEditor initial={detail.source} language={detail.language} label={tr('admin.contests.drawer.codeLabel')} readonly height="360px" />
      {/key}
    {:else if detail.verdict === 'CE'}
      <div class="flex flex-col gap-1.5">
        <span class="admin-label">{tr('admin.contests.drawer.compileLog')}</span>
        <pre class="max-h-[320px] overflow-auto whitespace-pre-wrap border-l-[3px] border-danger bg-danger/5 px-3 py-2.5 font-mono text-micro leading-5 text-ink">{detail.compileLog || '—'}</pre>
      </div>
    {:else}
      {#if detail.verdict === 'SE'}
        <div class="flex flex-col gap-1.5 border-l-[3px] border-warning bg-warning/5 px-3 py-2.5">
          <span class="text-2xs text-ink">{tr('admin.contests.drawer.system')}</span>
          {#if detail.systemDetail}
            <pre class="overflow-auto whitespace-pre-wrap font-mono text-micro leading-5 text-muted">{detail.systemDetail}</pre>
          {/if}
        </div>
      {/if}
      {#if detail.tests.length > 0}
        <div class="flex flex-col border border-line bg-canvas">
          <div class="flex gap-2.5 border-b border-line px-3 py-1.5">
            <span class="admin-label w-8 shrink-0">{tr('admin.contests.col.number')}</span>
            <span class="admin-label min-w-0 flex-1">{tr('admin.contests.col.verdict')}</span>
            <span class="admin-label w-14 shrink-0 text-right">{tr('admin.contests.col.seconds')}</span>
            <span class="admin-label w-16 shrink-0 text-right">{tr('admin.contests.col.memory')}</span>
          </div>
          {#each detail.tests as test (test.ordinal)}
            {@const bad = failed?.ordinal === test.ordinal}
            <div class={cn('flex gap-2.5 border-b border-line-soft px-3 py-1.5 last:border-b-0', bad && 'bg-danger/5')}>
              <span class={cn('w-8 shrink-0 font-mono text-micro text-ink', bad && 'font-bold')}>{test.ordinal}</span>
              <span
                class={cn(
                  'min-w-0 flex-1 font-mono text-micro font-bold',
                  test.verdict === 'OK' ? 'text-positive' : test.verdict === 'skipped' ? 'font-normal text-muted' : LINE_TONE[verdictTone(test.verdict)],
                )}
              >
                {test.verdict === 'skipped' ? tr('admin.contests.test.skipped') : test.verdict}{test.sample ? ` · ${tr('admin.contests.drawer.sample')}` : ''}
              </span>
              <span class="w-14 shrink-0 text-right font-mono text-micro text-ink">{test.timeMs === null ? '—' : seconds(test.timeMs)}</span>
              <span class="w-16 shrink-0 text-right font-mono text-micro text-ink">{memoryWords(test.memoryKb)}</span>
            </div>
            {#if bad}
              <!-- The failed test's data, staff only: what the program printed
                   against what was expected, and why it stopped. -->
              <div class="flex flex-col border-b border-line">
                {#if test.input !== undefined}
                  <details class="border-b border-line-soft px-3 py-2">
                    <summary class="cursor-pointer text-micro font-bold uppercase tracking-caps text-muted">{tr('admin.contests.drawer.input')}</summary>
                    <pre class="mt-1.5 max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-micro text-ink">{test.input}</pre>
                  </details>
                {/if}
                {#if test.output !== undefined || test.answer !== undefined}
                  <div class="grid grid-cols-2">
                    <div class="flex min-w-0 flex-col gap-1 border-r border-line px-3 py-2">
                      <span class="admin-label">{tr('admin.contests.drawer.output')}</span>
                      <pre class="max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-micro font-bold text-danger">{test.output ?? ''}</pre>
                    </div>
                    <div class="flex min-w-0 flex-col gap-1 px-3 py-2">
                      <span class="admin-label">{tr('admin.contests.drawer.answer')}</span>
                      <pre class="max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-micro text-ink">{test.answer ?? ''}</pre>
                    </div>
                  </div>
                {/if}
                {#if test.note}
                  <p class="border-t border-line-soft px-3 py-1.5 text-micro text-ink">{test.note}</p>
                {/if}
                {#if test.exit || test.stderr}
                  <div class="flex flex-col gap-1 border-t border-line-soft px-3 py-2">
                    {#if test.exit}
                      <span class="text-micro text-muted">{tr('admin.contests.drawer.exit')}: <span class="font-mono text-ink">{test.exit}</span></span>
                    {/if}
                    {#if test.stderr}
                      <span class="admin-label">{tr('admin.contests.drawer.stderr')}</span>
                      <pre class="max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-micro text-ink">{test.stderr}</pre>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
          <p class="border-t border-line px-3 py-1.5 text-micro text-muted">
            {#if notRun}{notRun}{' '}{/if}{tr('admin.contests.drawer.staffOnly')}
          </p>
        </div>
      {:else if detail.state === 'queued' || detail.state === 'running'}
        <p class="text-2xs text-muted">{tr('admin.contests.drawer.waitingTests')}</p>
      {/if}
      {#if detail.compileLog}
        <!-- Warnings of a program that compiled: rarely read, never hidden. -->
        <details class="text-micro text-muted">
          <summary class="cursor-pointer">{tr('admin.contests.drawer.warnings')}</summary>
          <pre class="mt-1.5 max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-micro text-ink">{detail.compileLog}</pre>
        </details>
      {/if}
    {/if}
  {/if}
</div>
