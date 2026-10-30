<!--
  The person's submissions (K2): every try, newest first, with a filter by
  problem and by verdict, the strip of tests under a running one, and a row
  that opens into what explains its verdict (SubmissionDetail).

  The list is the person's own (`GET …/submissions`), kept current by the
  stream; an opened row fetches its details (`GET …/submissions/:id`) once,
  and again only when the row's state has moved on since — a submission that
  was running when opened is fetched again once it is judged, or its diff
  would never appear.

  The time and memory columns are the largest over the tests run, as the note
  above the table says: «0,21» is the slowest test, not the sum.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { tr } from '@shared/i18n'
  import { VERDICTS, verdictWords, type ContestRules, type Verdict } from '@shared/contests'
  import type {
    EntrantContestSubmission,
    EntrantProblem,
    EntrantSubmissionDetail,
    LanguageOption,
  } from '@shared/contests-entrant'
  import SubmissionDetail from './SubmissionDetail.svelte'
  import TestStrip from './TestStrip.svelte'
  import VerdictBadge from './VerdictBadge.svelte'
  import { clockOf } from '@/lib/competition-words'
  import {
    inFlight,
    languageLabel,
    memoryWords,
    overLimitValue,
    secondsValue,
    submissionTone,
    testColumn,
    usageWords,
    VERDICT_TEXT,
    verdictLine,
  } from '@/lib/contest-words'

  interface Props {
    /** Newest first. */
    submissions: EntrantContestSubmission[]
    problems: EntrantProblem[]
    languages: LanguageOption[]
    rules: ContestRules
    phone: boolean
    /** The problem filter, kept by the screen: «все посылки» under a problem arrives with it set. */
    problemFilter: string | null
    onfilter: (problemId: string | null) => void
    /** One submission's details, from the door. */
    load: (id: string) => Promise<EntrantSubmissionDetail>
  }

  const { submissions, problems, languages, rules, phone, problemFilter, onfilter, load }: Props = $props()

  /** 'all', 'running' (still with the judge) or a verdict. */
  let verdictFilter = $state<'all' | 'running' | Verdict>('all')
  const PAGE = 20
  let shown = $state(PAGE)

  const problemOf = $derived(new Map(problems.map((problem) => [problem.id, problem])))
  const filtered = $derived(
    submissions.filter((submission) => {
      if (problemFilter !== null && submission.problemId !== problemFilter) return false
      if (verdictFilter === 'all') return true
      if (verdictFilter === 'running') return inFlight(submission)
      return !inFlight(submission) && submission.verdict === verdictFilter
    }),
  )
  const visible = $derived(filtered.slice(0, shown))
  const running = $derived(submissions.filter(inFlight).length)
  /** Only the verdicts the person has: a list of eight where three are possible is a list to read for nothing. */
  const seenVerdicts = $derived(VERDICTS.filter((verdict) => submissions.some((submission) => submission.verdict === verdict)))

  /* ------------------------------------------------------------- opening */

  /** Rows opened to their explanation; `code` — rows showing their code. */
  let open = $state<Record<string, boolean>>({})
  let code = $state<Record<string, boolean>>({})
  let details = $state<Record<string, { detail: EntrantSubmissionDetail; state: string }>>({})
  let loading = $state<Record<string, boolean>>({})
  let errors = $state<Record<string, string>>({})

  /** The details, fetched when missing or fetched before the submission moved on. */
  async function ensure(submission: EntrantContestSubmission): Promise<void> {
    const known = details[submission.id]
    if (known && known.state === submission.state) return
    if (loading[submission.id]) return
    loading = { ...loading, [submission.id]: true }
    try {
      const detail = await load(submission.id)
      details = { ...details, [submission.id]: { detail, state: detail.state } }
      const { [submission.id]: _gone, ...rest } = errors
      errors = rest
    } catch (error: unknown) {
      errors = { ...errors, [submission.id]: error instanceof Error ? error.message : tr('common.networkError') }
    } finally {
      const { [submission.id]: _done, ...rest } = loading
      loading = rest
    }
  }

  /*
   * An opened row that is judged since it was fetched: fetched again, for its
   * explanation. The fetch itself is untracked — it reads and writes `loading`,
   * and an effect that writes what it reads runs itself again.
   */
  $effect(() => {
    const stale = submissions.filter((submission) => {
      if (!open[submission.id] && !code[submission.id]) return false
      const known = details[submission.id]
      return known !== undefined && known.state !== submission.state && !inFlight(submission)
    })
    if (stale.length > 0) untrack(() => stale.forEach((submission) => void ensure(submission)))
  })

  /** Accepted and running rows open to their code; the rest to their explanation. */
  function codeOnly(submission: EntrantContestSubmission): boolean {
    return inFlight(submission) || submission.verdict === 'OK'
  }

  function toggle(submission: EntrantContestSubmission): void {
    if (codeOnly(submission)) {
      code = { ...code, [submission.id]: !code[submission.id] }
      if (code[submission.id]) void ensure(submission)
      return
    }
    open = { ...open, [submission.id]: !open[submission.id] }
    if (open[submission.id]) void ensure(submission)
  }

  function toggleCode(submission: EntrantContestSubmission): void {
    code = { ...code, [submission.id]: !code[submission.id] }
    if (code[submission.id]) void ensure(submission)
  }

  function actionWord(submission: EntrantContestSubmission): string {
    if (codeOnly(submission)) return code[submission.id] ? tr('contests.p.hideCode') : tr('contests.p.code')
    return open[submission.id] ? tr('contests.p.collapse') : tr('contests.p.more')
  }

  function expanded(submission: EntrantContestSubmission): boolean {
    return codeOnly(submission) ? code[submission.id] === true : open[submission.id] === true
  }

  function seconds(submission: EntrantContestSubmission): { text: string; tone: string } {
    const problem = problemOf.get(submission.problemId)
    if (submission.verdict === 'TL' && problem) return { text: overLimitValue(problem.timeLimitMs), tone: 'text-warning' }
    if (submission.timeMs === null) return { text: '—', tone: 'text-faint' }
    return { text: secondsValue(submission.timeMs), tone: 'text-ink' }
  }
</script>

{#snippet detailOf(submission: EntrantContestSubmission)}
  <SubmissionDetail
    {submission}
    detail={details[submission.id]?.detail ?? null}
    loading={loading[submission.id] === true}
    error={errors[submission.id] ?? null}
    problem={problemOf.get(submission.problemId) ?? null}
    codeOnly={codeOnly(submission)}
    showCode={code[submission.id] === true}
    {phone}
    ontogglecode={() => toggleCode(submission)}
  />
{/snippet}

<div class="flex flex-col">
  <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pb-[22px]">
    <div class="flex flex-wrap gap-2">
      <label class="flex">
        <span class="sr-only">{tr('contests.p.filterProblem')}</span>
        <select
          class="max-w-[260px] border border-line bg-canvas py-1.5 pl-3 pr-8 text-2xs text-ink"
          value={problemFilter ?? ''}
          onchange={(event) => {
            const value = (event.currentTarget as HTMLSelectElement).value
            shown = PAGE
            onfilter(value === '' ? null : value)
          }}
        >
          <option value="">{tr('contests.p.allProblems')}</option>
          {#each problems as problem (problem.id)}
            <option value={problem.id}>{problem.letter} · {problem.title}</option>
          {/each}
        </select>
      </label>
      <label class="flex">
        <span class="sr-only">{tr('contests.p.filterVerdict')}</span>
        <select
          class="max-w-[260px] border border-line bg-canvas py-1.5 pl-3 pr-8 text-2xs text-ink"
          value={verdictFilter}
          onchange={(event) => {
            verdictFilter = (event.currentTarget as HTMLSelectElement).value as typeof verdictFilter
            shown = PAGE
          }}
        >
          <option value="all">{tr('contests.p.allVerdicts')}</option>
          <option value="running">{tr('contests.p.filterRunning')}</option>
          {#each seenVerdicts as verdict (verdict)}
            <option value={verdict}>{verdict} · {verdictWords(verdict)}</option>
          {/each}
        </select>
      </label>
    </div>
    <p class="text-2xs text-muted">
      {[running > 0 ? tr('contests.p.inFlightCount', { count: running }) : '', tr('contests.p.maxNote')].filter(Boolean).join(' · ')}
    </p>
  </div>

  {#if submissions.length === 0}
    <p class="border-t-2 border-ink py-6 text-ui text-muted">{tr('contests.p.noSubmissions')}</p>
  {:else if filtered.length === 0}
    <p class="border-t-2 border-ink py-6 text-ui text-muted">{tr('contests.p.noMatches')}</p>
  {:else if phone}
    <!-- A phone: one block per submission, the same words in three lines. -->
    <ul class="flex flex-col border-t-2 border-ink">
      {#each visible as submission (submission.id)}
        {@const problem = problemOf.get(submission.problemId)}
        {@const tone = submissionTone(submission)}
        <li class="flex flex-col gap-2 border-b border-line py-3 {submission.verdict === 'OK' && !inFlight(submission) ? 'bg-positive/5' : ''}">
          <div class="flex items-baseline justify-between gap-3">
            <span class="min-w-0 truncate text-ui text-ink">
              <span class="font-mono text-faint">#{submission.number}</span>
              <span class="font-mono font-bold text-faint">{submission.letter}</span>
              <span class="font-bold">{problem?.title ?? ''}</span>
            </span>
            <span class="shrink-0 font-mono text-[12px] text-muted">{clockOf(submission.submittedAt)}</span>
          </div>
          <div class="flex items-center gap-2.5">
            <VerdictBadge {submission} phone />
            <span class="min-w-0 flex-1 text-2xs {VERDICT_TEXT[tone]}">{verdictLine(submission, rules)}</span>
            <span class="shrink-0 font-mono text-[12px] text-muted">
              {submission.failedTest !== null ? tr('contests.p.testN', { n: submission.failedTest }) : testColumn(submission) === '—' ? '' : testColumn(submission)}
            </span>
          </div>
          {#if inFlight(submission)}
            <TestStrip {submission} note={false} />
          {/if}
          <div class="flex items-center justify-between gap-3">
            <span class="font-mono text-[12px] text-muted">{usageWords(submission, problem?.timeLimitMs ?? null)}</span>
            <button class="text-2xs text-accent-text" type="button" aria-expanded={expanded(submission)} onclick={() => toggle(submission)}>
              {actionWord(submission)}
            </button>
          </div>
          {#if expanded(submission)}
            {@render detailOf(submission)}
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <div class="w-full overflow-x-auto">
      <table class="w-full min-w-[960px] border-collapse text-left">
        <thead>
          <tr class="border-b-2 border-ink">
            {#each [
              ['contests.p.colNumber', 'w-12'],
              ['contests.p.colTime', 'w-20'],
              ['contests.p.colProblem', ''],
              ['contests.p.colLanguage', 'w-[136px]'],
              ['contests.p.colVerdict', 'w-[296px]'],
              ['contests.p.colTest', 'w-16 text-right'],
              ['contests.p.colSeconds', 'w-24 text-right'],
              ['contests.p.colMemory', 'w-24 text-right'],
            ] as [key, width] (key)}
              <th scope="col" class="px-2 pb-2.5 text-micro font-black uppercase leading-5 tracking-label text-muted first:pl-0 {width}">
                {tr(key)}
              </th>
            {/each}
            <th scope="col" class="w-[100px] pb-2.5"><span class="sr-only">{tr('contests.p.more')}</span></th>
          </tr>
        </thead>
        {#each visible as submission (submission.id)}
          {@const problem = problemOf.get(submission.problemId)}
          {@const tone = submissionTone(submission)}
          {@const time = seconds(submission)}
          {@const accepted = submission.verdict === 'OK' && !inFlight(submission)}
          <tbody class="border-b border-line {accepted ? 'bg-positive/5' : ''}">
            <tr class="align-middle">
              <td class="py-3.5 pr-2 font-mono text-[13px] leading-[18px] text-faint">#{submission.number}</td>
              <td class="px-2 py-3.5 font-mono text-[13px] leading-[18px] text-muted">{clockOf(submission.submittedAt)}</td>
              <td class="px-2 py-3.5">
                <span class="flex items-baseline gap-2.5">
                  <span class="font-mono text-[14px] font-bold leading-[18px] text-faint">{submission.letter}</span>
                  <span class="min-w-0 truncate text-[15px] font-bold leading-[18px] text-ink">{problem?.title ?? ''}</span>
                </span>
              </td>
              <td class="px-2 py-3.5 font-mono text-[12px] leading-[18px] text-ink">{languageLabel(submission.language, languages)}</td>
              <td class="px-2 py-3.5">
                <span class="flex items-center gap-2.5">
                  <VerdictBadge {submission} />
                  <span class="text-[15px] leading-[18px] {VERDICT_TEXT[tone]}">{verdictLine(submission, rules)}</span>
                </span>
              </td>
              <td class="px-2 py-3.5 text-right font-mono text-[13px] leading-[18px] {submission.failedTest !== null ? 'font-bold text-ink' : inFlight(submission) ? 'text-ink' : 'text-faint'}">
                {testColumn(submission)}
              </td>
              <td class="px-2 py-3.5 text-right font-mono text-[13px] leading-[18px] {time.tone}">{time.text}</td>
              <td class="px-2 py-3.5 text-right font-mono text-[13px] leading-[18px] {submission.memoryKb === null ? 'text-faint' : 'text-ink'}">
                {memoryWords(submission.memoryKb)}
              </td>
              <td class="py-3.5 pl-2 text-right">
                <button
                  class="text-2xs leading-[18px] text-accent-text hover:underline"
                  type="button"
                  aria-expanded={expanded(submission)}
                  onclick={() => toggle(submission)}
                >
                  {actionWord(submission)}
                </button>
              </td>
            </tr>
            {#if inFlight(submission) && !expanded(submission)}
              <!-- K2: a running row grows its strip without being opened. -->
              <tr>
                <td></td>
                <td></td>
                <td class="px-2 pb-3.5" colspan="7"><TestStrip {submission} note={false} /></td>
              </tr>
            {/if}
            {#if expanded(submission)}
              <tr>
                <td></td>
                <td></td>
                <td class="px-2 pb-[18px]" colspan="7">{@render detailOf(submission)}</td>
              </tr>
            {/if}
          </tbody>
        {/each}
      </table>
    </div>
  {/if}

  {#if filtered.length > shown}
    <button class="self-start pt-4 text-ui text-accent-text hover:underline" type="button" onclick={() => (shown += PAGE)}>
      {tr('contests.p.showMoreSubmissions', { count: Math.min(PAGE, filtered.length - shown) })}
    </button>
  {/if}
</div>
