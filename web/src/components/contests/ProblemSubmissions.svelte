<!--
  The latest submissions of the open problem, under the editor (K1) or under
  the statement on a phone (K5): what the judge said about the last few tries
  without leaving the problem.

  A running one carries its progress as a bar of tests — green for the ones
  passed, the accent for the one running, grey for the rest — the same three
  colours as the strip on the submissions tab, so the eye learns them once.
  The bar follows the person's own list, which the stream updates test by
  test; nothing here asks the server.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { ContestRules } from '@shared/contests'
  import type { EntrantContestSubmission, EntrantProblem } from '@shared/contests-entrant'
  import VerdictBadge from './VerdictBadge.svelte'
  import { clockOf } from '@/lib/competition-words'
  import { inFlight, phoneHead, submissionHead, usageWords } from '@/lib/contest-words'

  interface Props {
    problem: EntrantProblem
    /** This problem's submissions, newest first. */
    submissions: readonly EntrantContestSubmission[]
    rules: ContestRules
    phone?: boolean
    /** «все посылки»: to the submissions tab, filtered by this problem. */
    onall: () => void
  }

  const { problem, submissions, rules, phone = false, onall }: Props = $props()

  /** Three on a page, as K1 draws them: the last tries are what matters while working on it. */
  const shown = $derived(submissions.slice(0, phone ? 4 : 3))
</script>

<section class="flex flex-col {phone ? 'px-4 pb-4 pt-1' : 'pt-3.5'}" aria-labelledby="contest-problem-submissions-{problem.id}">
  <div class="flex items-center justify-between gap-3 border-b border-ink {phone ? 'pb-2' : 'pb-2.5'}">
    <h2 id="contest-problem-submissions-{problem.id}" class="text-micro font-black uppercase leading-5 tracking-label text-muted">
      {tr(phone ? 'contests.p.mySubmissions' : 'contests.p.problemSubmissions', { letter: problem.letter })}
    </h2>
    {#if submissions.length > 0}
      <button class="text-micro text-accent-text hover:underline" type="button" onclick={onall}>
        {tr('contests.p.allSubmissions')}
      </button>
    {/if}
  </div>

  {#if shown.length === 0}
    <p class="py-3 text-2xs text-muted">{tr('contests.p.noProblemSubmissions')}</p>
  {/if}

  {#each shown as submission (submission.id)}
    {@const running = submission.state === 'running'}
    {@const done = submission.progress ?? 0}
    <div class="flex flex-col gap-2 border-b border-line {phone ? 'py-[11px]' : 'py-3'}">
      <div class="flex items-center {phone ? 'gap-2.5' : 'gap-3'}">
        {#if !phone}
          <span class="w-[30px] shrink-0 font-mono text-[12px] leading-4 text-faint">#{submission.number}</span>
        {/if}
        <VerdictBadge {submission} {phone} />
        <span class="min-w-0 flex-1 text-ui leading-[18px] text-ink">
          {phone ? phoneHead(submission, rules, problem.timeLimitMs, problem.samples) : submissionHead(submission, rules)}
        </span>
        <span class="shrink-0 font-mono text-[12px] leading-4 text-muted">
          {phone || inFlight(submission) || !usageWords(submission, problem.timeLimitMs)
            ? clockOf(submission.submittedAt)
            : usageWords(submission, problem.timeLimitMs)}
        </span>
      </div>
      {#if running && submission.total !== null && submission.total > 0}
        <!-- Passed, the one running, the rest: three widths of one bar. -->
        <div class="flex gap-[3px] {phone ? '' : 'pl-[42px]'}" aria-hidden="true">
          {#if done > 0}<span class="h-1 bg-positive" style:flex-grow={done}></span>{/if}
          <span class="h-1 bg-accent" style:flex-grow="1"></span>
          {#if submission.total - done - 1 > 0}<span class="h-1 bg-line" style:flex-grow={submission.total - done - 1}></span>{/if}
        </div>
      {/if}
    </div>
  {/each}
</section>
