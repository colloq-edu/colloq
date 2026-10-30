<!--
  What an opened submission says (K2): the strip of tests, and then the one
  thing that explains the verdict — the example the solution failed with its
  input, the answer and the solution's own output side by side, or the
  compiler's words — and the code, on demand.

  The output is shown for EXAMPLES only, and that is the server's rule, not
  this page's: a hidden test's data never leaves the server for the person
  (shared/contests.ts · TestReport). The page only says so, so that an empty
  space does not read as «the solution printed nothing».

  The compiler's log is drawn as text, piece by piece, never as markup: it is
  the program's words, and `<queue>` in it is a header, not a tag.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { EntrantContestSubmission, EntrantProblem, EntrantSubmissionDetail } from '@shared/contests-entrant'
  import CodeEditor from './CodeEditor.svelte'
  import TestStrip from './TestStrip.svelte'
  import { COMPILER_LINE, firstErrorLine, logPieces } from '@/lib/contest-words'

  interface Props {
    /** The row as the live list has it: the strip moves with the stream. */
    submission: EntrantContestSubmission
    detail: EntrantSubmissionDetail | null
    loading: boolean
    error: string | null
    problem: EntrantProblem | null
    /** Only the code (an accepted or a running submission), without the explanation. */
    codeOnly?: boolean
    showCode: boolean
    phone?: boolean
    ontogglecode: () => void
  }

  const { submission, detail, loading, error, problem, codeOnly = false, showCode, phone = false, ontogglecode }: Props = $props()

  const failed = $derived(
    detail && submission.failedTest !== null ? (detail.tests.find((test) => test.ordinal === submission.failedTest) ?? null) : null,
  )
  /** «пример 2»: the failed test's place among the problem's examples. */
  const sampleIndex = $derived(
    failed && problem ? problem.samples.findIndex((sample) => sample.ordinal === failed.ordinal) + 1 : 0,
  )
  const compileError = $derived(submission.verdict === 'CE')
  const log = $derived(detail?.compileLog ?? '')
  const errorLine = $derived(compileError ? firstErrorLine(log) : null)
  let reveal = $state<number | null>(null)

  function openAt(line: number): void {
    reveal = line
    if (!showCode) ontogglecode()
  }

  /** The code box grows with the code up to a screen, then scrolls inside. */
  const codeHeight = $derived(`${Math.min(480, Math.max(120, ((detail?.source ?? '').split('\n').length + 1) * 21 + 32))}px`)
</script>

<div class="flex flex-col gap-3">
  {#if !codeOnly}
    <TestStrip {submission} />
  {/if}

  {#if loading && !detail}
    <p class="text-2xs text-muted" role="status">{tr('contests.p.loadingDetail')}</p>
  {:else if error}
    <p class="text-2xs text-danger" role="alert">{error}</p>
  {/if}

  {#if detail && !codeOnly}
    {#if compileError}
      <div class="flex flex-col border border-line bg-surface">
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-3.5 py-2">
          <span class="text-micro font-black uppercase leading-[14px] tracking-label text-muted">
            {tr('contests.p.compilerOutput')} · <span class="font-mono normal-case tracking-normal">{COMPILER_LINE[submission.language]}</span>
          </span>
          {#if errorLine !== null}
            <button class="text-micro leading-[14px] text-accent-text hover:underline" type="button" onclick={() => openAt(errorLine)}>
              {tr('contests.p.openAtLine', { line: errorLine })}
            </button>
          {/if}
        </div>
        <pre class="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-5 text-ink">{#each log.split('\n') as line, index (index)}{#each logPieces(line) as piece, part (part)}<span
                class={piece.kind === 'error'
                  ? 'font-bold text-danger'
                  : piece.kind === 'warning'
                    ? 'font-bold text-warning'
                    : piece.kind === 'note'
                      ? 'text-accent-text'
                      : ''}>{piece.text}</span>{/each}{'\n'}{/each}</pre>
      </div>
    {:else if failed && failed.sample && failed.output !== undefined}
      <!-- An example: everything about it is in the statement already, so its output may be shown (K2). -->
      <div class="flex flex-col border border-danger/30 bg-danger/[0.03] dark:bg-danger/10">
        <p class="border-b border-danger/30 px-3.5 py-2.5 text-ui leading-5 text-ink">
          {tr('contests.p.sampleFailed', { n: failed.ordinal, k: sampleIndex || 1 })}
        </p>
        <div class="flex {phone ? 'flex-col' : ''}">
          <div class="flex min-w-0 flex-1 flex-col gap-1.5 px-3.5 py-3 {phone ? 'border-b' : 'border-r'} border-danger/30">
            <span class="text-micro font-black uppercase leading-[14px] tracking-label text-muted">{tr('contests.p.input')}</span>
            <pre class="overflow-x-auto font-mono text-[13px] leading-5 text-ink">{failed.input ?? ''}</pre>
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-1.5 px-3.5 py-3 {phone ? 'border-b' : 'border-r'} border-danger/30">
            <span class="text-micro font-black uppercase leading-[14px] tracking-label text-muted">{tr('contests.p.expected')}</span>
            <pre class="overflow-x-auto font-mono text-[13px] leading-5 text-ink">{failed.answer ?? ''}</pre>
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-1.5 px-3.5 py-3">
            <span class="text-micro font-black uppercase leading-[14px] tracking-label text-muted">{tr('contests.p.solutionOutput')}</span>
            {#if failed.output}
              <pre class="overflow-x-auto font-mono text-[13px] font-bold leading-5 text-danger">{failed.output}</pre>
            {:else}
              <span class="font-mono text-[13px] leading-5 text-muted">{tr('contests.p.emptyOutput')}</span>
            {/if}
            {#if failed.note}
              <span class="text-micro leading-4 text-muted">{failed.note}</span>
            {/if}
          </div>
        </div>
      </div>
    {:else if failed}
      <p class="text-2xs leading-5 text-muted">{tr('contests.p.hiddenFailed', { n: failed.ordinal })}</p>
    {/if}
  {/if}

  {#if detail}
    {#if !codeOnly}
      <button class="self-start text-2xs text-accent-text hover:underline" type="button" onclick={ontogglecode}>
        {showCode ? tr('contests.p.hideCode') : tr('contests.p.code')}
      </button>
    {/if}
    {#if showCode}
      <CodeEditor
        initial={detail.source}
        language={detail.language}
        label={tr('contests.p.codeOf', { number: submission.number })}
        readonly
        height={codeHeight}
        revealLine={reveal}
      />
    {/if}
  {/if}
</div>
