<script lang="ts">
  import { tr } from '@shared/i18n'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { ADOPT_UNDO_MS, type CouncilShown } from '@shared/protocol'
  import type { CouncilAdopted } from '@/lib/council.svelte'
  import { clock } from '@/lib/history'
  import { spell } from '@/lib/utils'

  interface Props {
    shown: CouncilShown
    now: number
    disabled: boolean
    onclear: () => void
    /**
     * "Put in the cell" went through: the success line takes the place of the
     * time and of the two buttons — for the attempt it was about, and no
     * other.
     */
    adopted?: CouncilAdopted | null
    /** The cell is in council: the class sees its output only once the council closes. */
    later?: boolean
    onadopt?: (participantId: string, run: boolean) => void
    onundo?: () => void
  }

  let {
    shown,
    now,
    disabled,
    onclear,
    adopted = null,
    later = false,
    onadopt,
    onundo,
  }: Props = $props()

  const done = $derived(adopted !== null && adopted.participantId === shown.participantId)
  const minutes = Math.round(ADOPT_UNDO_MS / 60_000)
</script>

<div class="projection-banner" class:adopted={done} data-pult-onscreen>
  <span class="projection-label">{tr('room.pult.v2.projection.title')}</span>
  <span class="projection-avatar" style:background-color={shown.name !== null ? shown.color ?? 'rgb(var(--line))' : 'rgb(var(--line))'} aria-hidden="true">
    {#if shown.name !== null}
      <Avatar name={shown.name} color={shown.color ?? '#888888'} avatar={shown.avatar} size="xs" emojiPx={14} class="!h-full !w-full" />
    {/if}
  </span>
  <strong class="projection-name">{shown.name ?? tr('room.ui.1255', { p0: shown.variant })}</strong>
  {#if done && adopted}
    <span class="projection-adopted" role="status">
      <Icon name="check" size={14} strokeWidth={2.4} class="projection-adopted-mark" />
      <span class="projection-adopted-text"><span class="projection-adopted-long">{adopted.run ? tr('room.council.adoptedRun') : tr('room.council.adopted')}{later ? ` · ${tr('room.council.adoptedLater')}` : ''}</span><span class="projection-adopted-short">{tr('room.council.adopted')}</span></span>
      <button type="button" class="projection-undo" {disabled} onclick={() => onundo?.()}>{tr('room.council.adoptUndo')}</button>
    </span>
  {:else}
    <span class="projection-time">
      {#if shown.shownAt !== null}
        {tr('room.pult.v2.projection.since', { time: clock(shown.shownAt), duration: spell(Math.max(now - shown.shownAt, 0)) })}
      {/if}
    </span>
  {/if}
  <div class="projection-actions">
    {#if onadopt && !done}
      <!--
        Two ways into the cell, and the run is the filled one: copying the
        code in order to run it where the variables stay for the next cells is
        exactly what teachers did by hand. The labels give way to the icons on
        a phone; the name stays for the reader and in the tooltip.
      -->
      <button
        type="button"
        class="pult-button"
        {disabled}
        title={tr('room.council.adoptHint', { p0: minutes })}
        aria-label={tr('room.council.adopt')}
        data-pult-adopt
        onclick={() => onadopt?.(shown.participantId, false)}
      >
        <Icon name="download" size={14} />
        <span class="projection-adopt-label">{tr('room.council.adopt')}</span>
      </button>
      <button
        type="button"
        class="pult-button pult-button--primary"
        {disabled}
        title={tr('room.council.adoptRunHint')}
        aria-label={tr('room.council.adoptRun')}
        data-pult-adopt-run
        onclick={() => onadopt?.(shown.participantId, true)}
      >
        <Icon name="play" size={12} />
        <span class="projection-adopt-label">{tr('room.council.adoptRun')}</span>
      </button>
    {/if}
    <button type="button" class="pult-button pult-button--danger" {disabled} onclick={onclear}>
      <span class="projection-clear-long">{tr('room.pult.v2.projection.clear')}</span>
      <span class="projection-clear-short">{tr('room.pult.v3.shortClear')}</span>
    </button>
  </div>
</div>

<style>
  /*
   * One line, 40 px.
   *
   * The strip says one thing: this is on the wall right now. It used to
   * stand in two rows of 64 px, and together with the header and the tabs
   * less than half of a 650 px tall window was left — while it changed twice
   * per class. There is no wrapping any more: a long name is cut, the time
   * hides before the "Clear" button does, because clearing matters more than
   * knowing how long it has been up. The same goes for the success line
   * after "Put in the cell": its tail is cut before its "undo" is.
   */
  .projection-banner { display: flex; align-items: center; flex-wrap: nowrap; flex-shrink: 0; gap: 8px; min-height: 40px; padding: 4px 16px 4px 12px; border-bottom: 1px solid rgb(var(--line)); border-left: 3px solid rgb(var(--positive)); background: rgb(var(--raised)); color: rgb(var(--ink)); }
  .projection-label { flex-shrink: 0; color: rgb(var(--positive)); font-size: 13px; line-height: 18px; font-weight: 700; }
  .projection-avatar { width: 22px; height: 22px; flex-shrink: 0; overflow: hidden; border-radius: 50%; }
  .projection-name { max-width: 240px; overflow: hidden; text-overflow: ellipsis; font-size: 14px; line-height: 20px; font-weight: 700; white-space: nowrap; }
  .projection-time { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: rgb(var(--muted)); font-size: 13px; line-height: 18px; font-variant-numeric: tabular-nums; }
  /* No `min-width: 0` here on purpose: the line never gets narrower than its
     mark and its "undo", so the sentence is what gets cut, not the button. */
  .projection-adopted { display: flex; flex: 1; align-items: center; gap: 8px; color: rgb(var(--positive)); font-size: 13px; line-height: 18px; }
  .projection-adopted :global(.projection-adopted-mark) { flex-shrink: 0; }
  .projection-adopted-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .projection-adopted-short { display: none; }
  .projection-undo { flex-shrink: 0; color: rgb(var(--accent-text)); font-size: 13px; line-height: 18px; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .projection-undo:disabled { opacity: .48; cursor: default; }
  .projection-actions { display: flex; flex-shrink: 0; gap: 6px; margin-left: auto; }
  .projection-actions :global(.pult-button) { min-height: 30px; padding: 5px 10px; font-size: 13px; }
  .projection-clear-short { display: none; }
  @media (max-width: 900px) { .projection-banner { padding-inline: 12px 12px; } }
  @media (max-width: 650px) {
    .projection-time { display: none; }
    .projection-clear-long { display: none; }
    .projection-clear-short { display: inline; }
    .projection-adopt-label { display: none; }
    .projection-adopted-long { display: none; }
    .projection-adopted-short { display: inline; }
    /* After the press the green edge and the tick say "on screen" well
       enough; the label gives its width to the sentence and the undo. */
    .projection-banner.adopted .projection-label { display: none; }
    .projection-name { flex: 1; min-width: 0; max-width: none; }
    .projection-actions :global(.pult-button) { min-height: 34px; }
  }
</style>
