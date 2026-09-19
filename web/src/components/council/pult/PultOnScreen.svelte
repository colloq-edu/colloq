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
      <Avatar name={shown.name} color={shown.color ?? '#888888'} avatar={shown.avatar} size="xs" emojiPx={14} class="!h-full !w-full" />
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
      <button type="button" class="pult-button projection-neighbour" {disabled} onclick={onneighbour}>{tr('room.pult.v2.projection.neighbour')} →</button>
    {/if}
    <button type="button" class="pult-button pult-button--danger" {disabled} onclick={onclear}>
      <span class="projection-clear-long">{tr('room.pult.v2.projection.clear')}</span>
      <span class="projection-clear-short">{tr('room.pult.v3.shortClear')}</span>
    </button>
  </div>
</div>

<style>
  /*
   * Одна строка, 40 px.
   *
   * Полоса говорит одно: вот это сейчас на стене. Она стояла в два ряда по
   * 64 px, и вместе с шапкой и вкладками от окна 650 px высотой оставалось
   * меньше половины — при том что менялась она за пару дважды. Переносов
   * больше нет: длинное имя обрезается, время прячется раньше кнопки «Убрать»,
   * потому что убрать важнее, чем знать, сколько уже висит.
   */
  .projection-banner { display: flex; align-items: center; flex-wrap: nowrap; flex-shrink: 0; gap: 8px; min-height: 40px; padding: 4px 16px 4px 12px; border-bottom: 1px solid rgb(var(--line)); border-left: 3px solid rgb(var(--positive)); background: rgb(var(--raised)); color: rgb(var(--ink)); }
  .projection-label { flex-shrink: 0; color: rgb(var(--positive)); font-size: 13px; line-height: 18px; font-weight: 700; }
  .projection-avatar { width: 22px; height: 22px; flex-shrink: 0; overflow: hidden; border-radius: 50%; }
  .projection-name { max-width: 240px; overflow: hidden; text-overflow: ellipsis; font-size: 14px; line-height: 20px; font-weight: 700; white-space: nowrap; }
  .projection-time { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: rgb(var(--muted)); font-size: 13px; line-height: 18px; font-variant-numeric: tabular-nums; }
  .projection-actions { display: flex; flex-shrink: 0; gap: 6px; margin-left: auto; }
  .projection-actions :global(.pult-button) { min-height: 30px; padding: 5px 10px; font-size: 13px; }
  .projection-clear-short { display: none; }
  @media (max-width: 900px) { .projection-banner { padding-inline: 12px 12px; } .projection-neighbour { display: none; } }
  @media (max-width: 650px) {
    .projection-time { display: none; }
    .projection-clear-long { display: none; }
    .projection-clear-short { display: inline; }
    .projection-name { flex: 1; min-width: 0; max-width: none; }
    .projection-actions :global(.pult-button) { min-height: 34px; }
  }
</style>
