<!--
  The rail of problems (K1) and its phone row of letters (K5).

  A letter's box is the person's state on it at a glance: solved — a filled
  green box, tried — a red tint with «−2», being judged — a dashed accent with
  «тест 7», untried — an outline (IOI adds a green tint with the score). The
  state comes from the page's copy of the person's results (ProblemMine),
  and «being judged» from their own live list, which the stream keeps moving
  test by test (contest-words · liveRun, railFace).

  Every letter is a link to its address (`/a/<slug>/c`): a problem is opened
  in a second tab as often as it is clicked.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { ContestRules } from '@shared/contests'
  import type { EntrantContestSubmission, EntrantProblem } from '@shared/contests-entrant'
  import { liveRun, problemName, railFace, type RailTone } from '@/lib/contest-words'
  import { contestRoutePath } from '@/lib/routes'

  interface Props {
    slug: string
    problems: EntrantProblem[]
    rules: ContestRules
    /** The open problem's letter; null — the contest's first page (the intro). */
    letter: string | null
    submissions: readonly EntrantContestSubmission[]
    phone?: boolean
    /** The contest has a page of its own before the problems (a description): «О контесте» heads the rail. */
    intro?: boolean
    onnavigate: (path: string) => void
  }

  const { slug, problems, rules, letter, submissions, phone = false, intro = false, onnavigate }: Props = $props()

  const items = $derived(
    problems.map((problem) => ({
      problem,
      face: railFace(rules, problem.maxScore, problem.mine, liveRun(submissions, problem.id)),
      path: contestRoutePath({ slug, view: 'problems', letter: problem.letter }),
    })),
  )

  const BOX: Record<RailTone, string> = {
    solved: 'bg-positive text-white dark:text-canvas',
    partial: 'border border-positive/30 bg-positive/10 text-positive dark:bg-positive/15',
    failed: 'border border-danger/30 bg-danger/10 text-danger dark:bg-danger/15',
    pending: 'border border-dashed border-accent text-accent-text',
    untried: 'border border-line text-muted',
  }
  const MARK: Record<RailTone, string> = {
    solved: 'text-positive',
    partial: 'text-positive',
    failed: 'text-danger',
    pending: 'text-accent-text',
    untried: 'text-muted',
  }

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    onnavigate(path)
  }
</script>

{#if phone}
  <!-- shrink-0: in the page's fixed-height column a scroller's minimum height is zero, and the row would be squeezed to a sliver. -->
  <nav class="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line px-4 py-3" aria-label={tr('contests.p.railTitle')}>
    {#each items as item (item.problem.id)}
      {@const current = item.problem.letter === letter}
      <a
        class="flex h-9 w-11 shrink-0 items-center justify-center font-mono text-[14px] font-bold leading-[18px] no-underline {BOX[item.face.tone]} {current
          ? 'outline outline-2 -outline-offset-2 outline-brand dark:outline-accent'
          : ''}"
        href={item.path}
        aria-current={current ? 'page' : undefined}
        aria-label="{problemName(item.problem.letter, item.problem.title)} — {item.face.label}"
        onclick={(event) => go(event, item.path)}
      >
        {item.problem.letter}
      </a>
    {/each}
  </nav>
{:else}
  <nav class="flex w-full flex-col" aria-label={tr('contests.p.railTitle')}>
    <h2 class="border-b border-ink pb-3 text-micro font-black uppercase leading-5 tracking-label text-muted">
      {tr('contests.p.railTitle')}
    </h2>
    {#if intro}
      {@const path = contestRoutePath({ slug, view: 'problems', letter: null })}
      <a
        class="flex items-center gap-3 border-b border-line py-[11px] text-[14px] leading-[18px] no-underline {letter === null
          ? '-ml-3 border-l-[3px] border-l-brand bg-raised pl-[9px] font-bold text-ink dark:border-l-accent'
          : 'text-muted hover:text-ink'}"
        href={path}
        aria-current={letter === null ? 'page' : undefined}
        onclick={(event) => go(event, path)}
      >
        <span class="flex size-[26px] shrink-0 items-center justify-center border border-line font-mono text-[13px] font-bold text-muted" aria-hidden="true">i</span>
        {tr('contests.p.intro')}
      </a>
    {/if}
    {#each items as item (item.problem.id)}
      {@const current = item.problem.letter === letter}
      <a
        class="flex items-center gap-3 border-b border-line py-[11px] no-underline {current
          ? '-ml-3 border-l-[3px] border-l-brand bg-raised pl-[9px] dark:border-l-accent'
          : 'hover:bg-surface'}"
        href={item.path}
        aria-current={current ? 'page' : undefined}
        aria-label="{problemName(item.problem.letter, item.problem.title)} — {item.face.label}"
        onclick={(event) => go(event, item.path)}
      >
        <span
          class="flex size-[26px] shrink-0 items-center justify-center font-mono text-[13px] font-bold leading-4 {BOX[item.face.tone]}"
          aria-hidden="true"
        >
          {item.problem.letter}
        </span>
        <span class="min-w-0 flex-1 text-[14px] leading-[18px] text-ink {current ? 'font-bold' : ''}" aria-hidden="true">
          {item.problem.title}
        </span>
        <span class="w-11 shrink-0 text-right font-mono text-[12px] font-bold leading-4 {MARK[item.face.tone]}" aria-hidden="true">
          {item.face.mark}
        </span>
      </a>
    {/each}
    <p class="pt-4 text-micro leading-[17px] text-muted">
      {tr(rules === 'ioi' ? 'contests.p.railLegendIoi' : 'contests.p.railLegendIcpc')}
    </p>
  </nav>
{/if}
