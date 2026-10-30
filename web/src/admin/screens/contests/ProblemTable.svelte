<!--
  A contest's problems as one table (Paper 19 · A2 «Задачи»): the letter, the
  title, the limits, the tests, and how the reference fares — the column the
  teacher reads before «Открыть контест», since a reference that does not
  pass is what keeps a contest closed.

  The draft's editor reorders here (the letters follow the order: dragging B
  above A makes it A), by dragging a row or with the arrows for a keyboard; the
  live console's «Задачи» tab draws the same table read-only with its own
  action at the end of each row.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { Snippet } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { cn } from '@/lib/utils'
  import { limitsLine, referenceLook, testsLine } from '@/admin/contests'
  import type { ProblemView } from '@shared/contests-api'

  interface Props {
    problems: ProblemView[]
    busy?: boolean
    onopen: (problemId: string) => void
    /** Given: the rows can be reordered, and this receives every id in the new order. */
    onorder?: (ids: string[]) => void
    /** A trailing cell of the row's own: «Перепроверить» on the console. */
    action?: Snippet<[ProblemView]>
  }

  let { problems, busy = false, onopen, onorder, action }: Props = $props()

  const ordered = $derived([...problems].sort((a, b) => a.position - b.position))
  /** The trailing lane: two arrows, or the console's word — one width per table, so the header lines up. */
  const tail = $derived(onorder ? 'w-[80px]' : 'w-[128px]')
  const DOT = { positive: 'bg-positive', danger: 'bg-danger', warning: 'bg-warning', accent: 'bg-accent' } as const
  const WORD = { positive: 'text-positive', danger: 'text-danger', warning: 'text-warning', accent: 'text-accent-text' } as const

  /* ------------------------------------------------------------ reorder */

  let dragging = $state<string | null>(null)
  let over = $state<string | null>(null)

  function move(id: string, to: number): void {
    if (!onorder) return
    const ids = ordered.map((problem) => problem.id)
    const from = ids.indexOf(id)
    if (from < 0 || to < 0 || to >= ids.length || to === from) return
    ids.splice(from, 1)
    ids.splice(to, 0, id)
    onorder(ids)
  }

  function drop(target: string): void {
    const id = dragging
    dragging = null
    over = null
    if (!id || id === target) return
    move(id, ordered.findIndex((problem) => problem.id === target))
  }
</script>

<div class="problem-table">
  <div class="problem-head admin-list-head">
    <span class="w-7 shrink-0" aria-hidden="true"></span>
    <span class="admin-label min-w-0 flex-1">{tr('admin.contests.col.problem')}</span>
    <span class="problem-cell admin-label w-[120px] shrink-0">{tr('admin.contests.col.limits')}</span>
    <span class="problem-cell admin-label w-[110px] shrink-0">{tr('admin.contests.col.tests')}</span>
    <span class="problem-cell admin-label w-[220px] shrink-0">{tr('admin.contests.col.reference')}</span>
    {#if onorder || action}
      <span class={cn('shrink-0', tail)} aria-hidden="true"></span>
    {/if}
  </div>

  {#each ordered as problem, index (problem.id)}
    {@const look = referenceLook(problem)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class={cn(
        'problem-row admin-list-row py-3',
        problem.reference.state === 'fails' && 'bg-danger/5',
        dragging === problem.id && 'opacity-50',
        over === problem.id && dragging !== problem.id && 'border-t-2 border-t-accent',
      )}
      draggable={onorder ? 'true' : undefined}
      ondragstart={(event) => {
        if (!onorder) return
        dragging = problem.id
        event.dataTransfer?.setData('text/plain', problem.id)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      }}
      ondragover={(event) => {
        if (!onorder || dragging === null) return
        event.preventDefault()
        over = problem.id
      }}
      ondragleave={() => {
        if (over === problem.id) over = null
      }}
      ondrop={(event) => {
        event.preventDefault()
        drop(problem.id)
      }}
      ondragend={() => {
        dragging = null
        over = null
      }}
    >
      <span
        class={cn(
          'flex size-7 shrink-0 items-center justify-center border border-line bg-surface font-mono text-ui font-bold text-ink',
          onorder && 'cursor-grab',
        )}
        title={onorder ? tr('admin.contests.dragHint') : undefined}
      >
        {problem.letter}
      </span>
      <button
        type="button"
        class="problem-name min-w-0 flex-1 truncate text-left text-ui font-semibold text-ink hover:text-accent-text"
        aria-label={tr('admin.contests.problemOpen', { letter: problem.letter, title: problem.title })}
        onclick={() => onopen(problem.id)}
      >
        {problem.title || tr('admin.contests.untitled')}
      </button>
      <span class="problem-cell w-[120px] shrink-0 font-mono text-micro text-ink">{limitsLine(problem)}</span>
      <span class="problem-cell w-[110px] shrink-0 font-mono text-micro text-ink">{testsLine(problem)}</span>
      <span class="problem-cell flex w-[220px] min-w-0 shrink-0 items-center gap-2">
        <span class={cn('size-2 shrink-0', DOT[look.tone])} aria-hidden="true"></span>
        <span class={cn('shrink-0 text-2xs font-semibold', WORD[look.tone])}>{look.word}</span>
        {#if look.detail}
          <span class="min-w-0 truncate font-mono text-micro text-muted">{look.detail}</span>
        {/if}
      </span>
      {#if onorder}
        <span class={cn('flex shrink-0 items-center justify-end', tail)}>
          <button
            type="button"
            class="admin-icon-btn"
            disabled={busy || index === 0}
            aria-label={tr('admin.contests.moveUp', { letter: problem.letter })}
            title={tr('admin.contests.moveUp', { letter: problem.letter })}
            onclick={() => move(problem.id, index - 1)}
          >
            <Icon name="chevron-up" size={14} />
          </button>
          <button
            type="button"
            class="admin-icon-btn"
            disabled={busy || index === ordered.length - 1}
            aria-label={tr('admin.contests.moveDown', { letter: problem.letter })}
            title={tr('admin.contests.moveDown', { letter: problem.letter })}
            onclick={() => move(problem.id, index + 1)}
          >
            <Icon name="chevron-down" size={14} />
          </button>
        </span>
      {:else if action}
        <span class={cn('flex shrink-0 items-center justify-end', tail)}>{@render action(problem)}</span>
      {/if}
    </div>
  {/each}
</div>

<style>
  /*
   * Narrow: the title takes the row, the facts go under it. The threshold is
   * the table's own width (the panel's rail and the Section's caption take
   * theirs out of the window), as in the competitions' list.
   */
  .problem-table {
    container-type: inline-size;
  }

  @container (max-width: 640px) {
    .problem-row {
      flex-wrap: wrap;
      row-gap: 0.375rem;
    }

    .problem-name {
      flex-basis: calc(100% - 140px);
    }

    .problem-cell {
      width: auto;
      min-width: 0;
    }

    .problem-head {
      display: none;
    }
  }
</style>
