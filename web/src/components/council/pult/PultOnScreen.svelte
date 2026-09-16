<script lang="ts">
  import { tr } from '@shared/i18n'
  import Avatar from '@/components/ui/Avatar.svelte'
  import type { CouncilShown } from '@shared/protocol'
  import { clock } from '@/lib/history'
  import { spell } from '@/lib/utils'

  interface Props {
    shown: CouncilShown
    now: number
    hasNeighbour: boolean
    disabled: boolean
    onneighbour: () => void
    onclear: () => void
  }

  let { shown, now, hasNeighbour, disabled, onneighbour, onclear }: Props = $props()
</script>

<div class="projection-banner" data-pult-onscreen>
  <span class="projection-label">{tr('room.pult.v2.projection.title')}</span>
  <span class="projection-avatar" style:background-color={shown.name !== null ? shown.color ?? 'rgb(var(--line))' : 'rgb(var(--line))'} aria-hidden="true">
    {#if shown.name !== null}
      <Avatar name={shown.name} color={shown.color ?? '#888888'} avatar={shown.avatar} size="md" />
    {/if}
  </span>
  <strong class="projection-name">{shown.name ?? tr('room.ui.1255', { p0: shown.variant })}</strong>
  <span class="projection-time">
    {#if shown.shownAt !== null}
      {tr('room.pult.v2.projection.since', { time: clock(shown.shownAt), duration: spell(Math.max(now - shown.shownAt, 0)) })}
    {/if}
  </span>
  <div class="projection-actions">
    {#if hasNeighbour}
      <button type="button" class="pult-button" {disabled} onclick={onneighbour}>{tr('room.pult.v2.projection.neighbour')} →</button>
    {/if}
    <button type="button" class="pult-button pult-button--danger" {disabled} onclick={onclear}>{tr('room.pult.v2.projection.clear')}</button>
  </div>
</div>

<style>
  .projection-banner { display: flex; align-items: center; flex-wrap: wrap; flex-shrink: 0; gap: 12px; padding: 12px 24px; border-bottom: 1px solid rgb(var(--line)); border-left: 4px solid rgb(var(--positive)); background: rgb(var(--raised)); color: rgb(var(--ink)); }
  .projection-label { color: rgb(var(--positive)); font-size: 14px; line-height: 20px; font-weight: 700; }
  .projection-avatar { width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%; }
  .projection-name { max-width: 240px; overflow: hidden; text-overflow: ellipsis; font-size: 16px; line-height: 22px; white-space: nowrap; }
  .projection-time { flex: 1; min-width: 80px; color: rgb(var(--muted)); font-size: 14px; line-height: 20px; font-variant-numeric: tabular-nums; }
  .projection-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  @media (max-width: 850px) { .projection-banner { padding: 12px 16px; } }
</style>
