<!--
  «+ из другого контеста» (Paper 19 · A2): a problem of another contest,
  taken whole — statement, tests, checker, reference — as this contest's new
  last letter. The original is not touched: last year's contest keeps its
  problem, and its board keeps meaning what it meant.

  Two steps in one dialog: the contests this teacher may see, then the
  problems of the one picked. The problems are asked for only then — a
  contest's view carries every test's list, and twenty of them would be a
  long wait for a list the teacher reads one line of.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { onMount } from 'svelte'
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { limitsLine, testsLine } from '@/admin/contests'
  import type { ContestListRow, ProblemView } from '@shared/contests-api'

  interface Props {
    /** The contest the problem goes into: not offered as a source. */
    contestId: string
    busy?: boolean
    error?: string | null
    onpick: (problemId: string) => void
    oncancel: () => void
  }

  let { contestId, busy = false, error = null, onpick, oncancel }: Props = $props()

  let contests = $state<ContestListRow[] | null>(null)
  let chosen = $state<ContestListRow | null>(null)
  let problems = $state<ProblemView[] | null>(null)
  let refusal = $state<string | null>(null)
  let request = 0

  const explain = (cause: unknown) => (cause instanceof AdminApiError ? cause.message : tr('admin.contests.requestFailed'))

  onMount(() => {
    void adminApi.contests
      .list()
      .then((list) => (contests = list.contests.filter((row) => row.contest.id !== contestId && row.problems > 0)))
      .catch((cause: unknown) => {
        contests = []
        refusal = explain(cause)
      })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) oncancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function choose(row: ContestListRow): Promise<void> {
    chosen = row
    problems = null
    refusal = null
    const asked = ++request
    try {
      const view = await adminApi.contests.get(row.contest.id)
      if (asked === request) problems = [...view.problems].sort((a, b) => a.position - b.position)
    } catch (cause) {
      if (asked !== request) return
      problems = []
      refusal = explain(cause)
    }
  }
</script>

<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="contest-problem-picker"
  class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
>
  <div class="dialog-card flex max-h-[80vh] w-full max-w-[600px] flex-col border border-line bg-canvas shadow-pop">
    <div class="flex items-start gap-4 border-b border-line px-5 py-4">
      <div class="min-w-0 flex-1">
        <h2 id="contest-problem-picker" class="text-title font-semibold text-ink">
          {chosen ? chosen.contest.title : tr('admin.contests.copy.heading')}
        </h2>
        <p class="mt-1 text-2xs text-muted">{tr('admin.contests.copy.hint')}</p>
      </div>
      <button type="button" class="admin-icon-btn -mr-2 -mt-1" aria-label={tr('admin.close')} onclick={oncancel}>
        <Icon name="x" size={15} />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-5 py-3">
      {#if refusal || error}
        <p class="py-2 text-ui text-danger" role="alert">{error ?? refusal}</p>
      {/if}
      {#if chosen === null}
        {#if contests === null}
          <RowsSkeleton label={tr('admin.contests.copy.loading')} />
        {:else if contests.length === 0 && !refusal}
          <p class="py-8 text-center text-ui text-muted">{tr('admin.contests.copy.empty')}</p>
        {:else}
          {#each contests as row (row.contest.id)}
            <button
              type="button"
              class="admin-data-row w-full text-left hover:bg-surface"
              onclick={() => void choose(row)}
            >
              <span class="min-w-0 flex-1">
                <span class="admin-row-title block truncate">{row.contest.title}</span>
                <span class="admin-meta block font-mono">/a/{row.contest.slug}</span>
              </span>
              <span class="shrink-0 text-2xs text-muted">{tr('admin.contests.copy.problems', { count: row.problems })}</span>
              <Icon name="chevron-right" size={14} class="shrink-0 text-faint" />
            </button>
          {/each}
        {/if}
      {:else}
        <button type="button" class="admin-link mb-2" onclick={() => ((chosen = null), (problems = null), (refusal = null))}>
          {tr('admin.contests.copy.back')}
        </button>
        {#if problems === null}
          <RowsSkeleton label={tr('admin.contests.copy.problemsLoading')} />
        {:else}
          {#each problems as problem (problem.id)}
            <div class="admin-data-row">
              <span class="flex size-7 shrink-0 items-center justify-center border border-line bg-surface font-mono text-ui font-bold text-ink">
                {problem.letter}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-ui font-semibold text-ink">{problem.title}</span>
                <span class="admin-meta block font-mono">{limitsLine(problem)} · {testsLine(problem)}</span>
              </span>
              <button type="button" class="btn-outline shrink-0" disabled={busy} onclick={() => onpick(problem.id)}>
                {tr('admin.contests.copy.take')}
              </button>
            </div>
          {/each}
        {/if}
      {/if}
    </div>
  </div>
</div>
