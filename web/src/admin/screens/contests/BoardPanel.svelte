<!--
  The console's «Лидерборд» tab (Paper 19 · A4, the board of K3/K4).

  The teacher's board is the unfrozen one with full names: during the
  freeze it is the only place the real order exists. «как видят участники»
  asks for the class's view (`?audience=class`) — what the projector shows,
  «?» and all — so the teacher checks the board before turning the screen
  to the hall. The table itself is the participants' component, drawn the
  same three ways nowhere.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Choice from '@/admin/ui/Choice.svelte'
  import EmptyState from '@/admin/ui/EmptyState.svelte'
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import StandingsTable from '@/components/contests/StandingsTable.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import type { AdminStandings } from '@shared/contests-api'

  interface Props {
    contestId: string
    /** Changes whenever a submission does: the board is read again. */
    version: string
  }

  let { contestId, version }: Props = $props()

  let audience = $state<'staff' | 'class'>('staff')
  let standings = $state<AdminStandings | null>(null)
  let refusal = $state<string | null>(null)
  let request = 0

  async function load(id: string, who: 'staff' | 'class'): Promise<void> {
    const asked = ++request
    try {
      const fresh = await adminApi.contests.standings(id, who)
      if (asked !== request) return
      standings = fresh
      refusal = null
    } catch (cause) {
      if (asked !== request) return
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      refusal = cause instanceof AdminApiError ? cause.message : tr('admin.contests.requestFailed')
    }
  }

  $effect(() => {
    void version
    void load(contestId, audience)
  })
</script>

<div class="flex flex-col gap-4 py-5">
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
    <Choice
      options={[
        { value: 'staff', label: tr('admin.contests.board.audience.staff') },
        { value: 'class', label: tr('admin.contests.board.audience.class') },
      ]}
      value={audience}
      onchange={(value) => {
        audience = value as 'staff' | 'class'
        standings = null
      }}
    />
    <span class="min-w-0 flex-1 basis-[240px] text-2xs text-muted">
      {audience === 'staff' ? tr('admin.contests.board.staffNote') : tr('admin.contests.board.classNote')}
    </span>
    <a class="btn-outline" href={adminApi.contests.standingsCsvUrl(contestId)} download>
      <Icon name="download" size={14} />
      {tr('admin.contests.board.csv')}
    </a>
  </div>

  {#if refusal}
    <div class="flex flex-wrap items-center gap-3">
      <p class="min-w-0 flex-1 text-ui text-danger" role="alert">{refusal}</p>
      <button type="button" class="btn-outline shrink-0" onclick={() => void load(contestId, audience)}>
        {tr('admin.try.again')}
      </button>
    </div>
  {/if}

  {#if standings === null}
    {#if !refusal}
      <RowsSkeleton label={tr('admin.contests.board.loading')} />
    {/if}
  {:else if standings.rows.length === 0}
    <EmptyState title={tr('admin.contests.board.empty')} hint={tr('admin.contests.board.emptyHint')} />
  {:else}
    <StandingsTable {standings} limit={null} />
  {/if}
</div>
