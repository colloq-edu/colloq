<!--
  The console's «Участники» tab (Paper 19 · A4): who joined, when, how much
  they sent and solved, and the one action a teacher needs here — taking a
  person out of this contest (a namesake who joined by mistake, a test
  account). Their submissions go with them and the places close up; the
  identity and its key stay, since they are shared with every competition
  and contest of the instance (contests.md §0).
-->
<script lang="ts">
  import { formatNumber, tr } from '@shared/i18n'
  import EmptyState from '@/admin/ui/EmptyState.svelte'
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { momentOf } from '@/admin/contests'
  import type { ContestEntrantRow } from '@shared/contests-api'

  interface Props {
    contestId: string
    /** Changes whenever a submission does: the counts are read again. */
    version: string
    zone: string | null
    now: number
    /** A person removed: the console re-reads its own numbers. */
    onremoved?: () => void
  }

  let { contestId, version, zone, now, onremoved }: Props = $props()

  let entrants = $state<ContestEntrantRow[] | null>(null)
  let refusal = $state<string | null>(null)
  let request = 0

  const explain = (cause: unknown) => (cause instanceof AdminApiError ? cause.message : tr('admin.contests.requestFailed'))

  async function load(id: string): Promise<void> {
    const asked = ++request
    try {
      const list = await adminApi.contests.entrants(id)
      if (asked !== request) return
      entrants = [...list.entrants].sort((a, b) => a.joinedAt - b.joinedAt)
      refusal = null
    } catch (cause) {
      if (asked !== request) return
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      refusal = explain(cause)
    }
  }

  $effect(() => {
    void version
    void load(contestId)
  })

  let removing = $state<ContestEntrantRow | null>(null)
  let removeError = $state<string | null>(null)
  let busy = $state(false)

  async function remove(): Promise<void> {
    const row = removing
    const id = contestId
    if (!row || busy) return
    busy = true
    removeError = null
    try {
      await adminApi.contests.removeEntrant(id, row.id)
      if (entrants) entrants = entrants.filter((one) => one.id !== row.id)
      removing = null
      onremoved?.()
    } catch (cause) {
      removeError = explain(cause)
    } finally {
      busy = false
    }
  }
</script>

<div class="entrants py-5">
  {#if refusal}
    <div class="flex flex-wrap items-center gap-3 pb-4">
      <p class="min-w-0 flex-1 text-ui text-danger" role="alert">{refusal}</p>
      <button type="button" class="btn-outline shrink-0" onclick={() => void load(contestId)}>{tr('admin.try.again')}</button>
    </div>
  {/if}
  {#if entrants === null}
    {#if !refusal}<RowsSkeleton label={tr('admin.contests.entrants.loading')} />{/if}
  {:else if entrants.length === 0}
    <EmptyState title={tr('admin.contests.entrants.none')} hint={tr('admin.contests.entrants.noneHint')} />
  {:else}
    <div class="entrants-head admin-list-head">
      <span class="admin-label min-w-0 flex-1">{tr('admin.contests.col.entrant')}</span>
      <span class="entrants-when admin-label w-[140px] shrink-0">{tr('admin.contests.col.joined')}</span>
      <span class="entrants-cell admin-label w-[96px] shrink-0 text-right">{tr('admin.contests.col.submissions')}</span>
      <span class="entrants-cell admin-label w-[96px] shrink-0 text-right">{tr('admin.contests.col.solved')}</span>
      <span class="entrants-when admin-label w-[150px] shrink-0">{tr('admin.contests.col.last')}</span>
      <span class="w-[88px] shrink-0" aria-hidden="true"></span>
    </div>
    {#each entrants as row (row.id)}
      <div class="entrants-row admin-data-row">
        <span class="admin-row-title min-w-0 flex-1 truncate">{row.name}</span>
        <span class="entrants-when w-[140px] shrink-0 font-mono text-micro text-muted">{momentOf(row.joinedAt, now, zone)}</span>
        <span class="entrants-cell admin-num w-[96px] shrink-0 text-right">{formatNumber(row.submissions)}</span>
        <span class="entrants-cell admin-num w-[96px] shrink-0 text-right">{formatNumber(row.solved)}</span>
        <span class="entrants-when w-[150px] shrink-0 font-mono text-micro text-muted">
          {row.lastSubmissionAt === null ? '—' : momentOf(row.lastSubmissionAt, now, zone)}
        </span>
        <span class="flex w-[88px] shrink-0 justify-end">
          <button
            type="button"
            class="text-2xs text-muted hover:text-danger disabled:text-faint"
            disabled={busy}
            aria-label={tr('admin.contests.entrants.removeLabel', { name: row.name })}
            onclick={() => ((removing = row), (removeError = null))}
          >
            {tr('admin.contests.entrants.remove')}
          </button>
        </span>
      </div>
    {/each}
    <p class="admin-meta py-3.5">{tr('admin.contests.entrants.count', { count: entrants.length })}</p>
  {/if}
</div>

{#if removing}
  <ConfirmDialog
    title={tr('admin.contests.entrants.removeHeading', { name: removing.name })}
    body={removing.submissions > 0
      ? tr('admin.contests.entrants.removeBody', { count: removing.submissions })
      : tr('admin.contests.entrants.removeBodyNone')}
    confirm={tr('admin.contests.entrants.remove')}
    {busy}
    error={removeError}
    onconfirm={() => void remove()}
    oncancel={() => (removing = null)}
  />
{/if}

<style>
  .entrants {
    container-type: inline-size;
  }

  /* Narrow: the name and the counts; when they joined and last sent go first. */
  @container (max-width: 640px) {
    .entrants-when {
      display: none;
    }

    .entrants-cell {
      width: auto;
      min-width: 56px;
    }
  }
</style>
