<script lang="ts">
  import { tr } from '@shared/i18n'
  import { cn, spell } from '@/lib/utils'

  /**
   * Four actions on a piece of work — and they are always on screen.
   *
   * Before this the row stood last in a column that scrolled as a whole in a
   * short window: "Show the class", "Run" and both marks slid below the
   * fold, and to mark a piece of work correct you first had to scroll down
   * to them. Now the row is the bottom of a dock pinned to the bottom of the
   * panel, and only the code with its output scrolls above it.
   *
   * On a phone there are four equal-width buttons of 44 px: the labels there
   * are short ("Show", "Run", "Correct", "Revise") — not for brevity's sake,
   * but because four touch targets do not otherwise fit into 360 px of
   * width, and they must not be made smaller than a finger.
   */
  interface Props {
    /** This work is shown to the room right now. */
    onScreen: boolean
    /** This work is running in the kernel. */
    running: boolean
    queued: boolean
    /** How long it has been running. */
    elapsed: number
    /** How long it has been in the frame. */
    inFrame: number
    /** Whether it was run before — "Run" or "Run again". */
    ran: boolean
    correct: boolean | null
    /** The work is a draft: there is nothing to show the class. */
    writing: boolean
    disabled: boolean
    onshow: () => void
    onclear: () => void
    onrun: () => void
    oninterrupt: () => void
    onmark: (correct: boolean) => void
  }

  let {
    onScreen,
    running,
    queued,
    elapsed,
    ran,
    correct,
    writing,
    disabled,
    onshow,
    onclear,
    onrun,
    oninterrupt,
    onmark,
  }: Props = $props()

</script>

<div class="actions" data-pult-actions>
  <div class="actions-main">
    <button type="button" class="pult-button pult-button--primary action-show"
      disabled={disabled || (!onScreen && writing)} onclick={onScreen ? onclear : onshow}>
      <span class="act-long">{onScreen ? tr('room.pult.v2.workClear') : tr('room.ui.1336')}</span>
      <span class="act-short">{onScreen ? tr('room.pult.v3.shortClear') : tr('room.pult.v3.shortShow')}</span>
      <span aria-hidden="true">{onScreen ? '×' : '↗'}</span>
    </button>
    <button type="button" class="pult-button action-run" disabled={disabled || running || queued}
      title={ran ? tr('room.ui.1338') : tr('room.ui.1337')} data-pult-run onclick={onrun}>
      <span aria-hidden="true">▶</span>
      <span class="act-long">{tr('room.ui.1337')}</span>
      <span class="act-short">{tr('room.pult.v3.shortRun')}</span>
    </button>
    <div class="actions-grades" role="group" aria-label={tr('room.pult.v2.workReview')}>
      <button type="button" class={cn('pult-button action-grade', correct === true && 'pult-button--selected')}
        data-tone="positive" aria-pressed={correct === true} disabled={disabled} onclick={() => onmark(true)}>
        <span aria-hidden="true">✓</span>
        <span class="act-long">{tr('room.pult.v2.workCorrect')}</span>
        <span class="act-short">{tr('room.pult.v3.shortCorrect')}</span>
      </button>
      <button type="button" class={cn('pult-button action-grade', correct === false && 'pult-button--selected')}
        data-tone="warning" aria-pressed={correct === false} disabled={disabled} onclick={() => onmark(false)}>
        <span aria-hidden="true">↺</span>
        <span class="act-long">{tr('room.pult.v2.workRevise')}</span>
        <span class="act-short">{tr('room.pult.v3.shortRevise')}</span>
      </button>
    </div>
  </div>
  {#if running}
    <div class="actions-run-state">
      <span class="pult-meta" role="status">{tr('room.pult.v2.workRunning')} · {spell(elapsed)}</span>
      <button type="button" class="pult-button pult-button--danger" disabled={disabled} onclick={oninterrupt}>
        {tr('room.ui.1284')}
      </button>
    </div>
  {:else if queued}
    <p class="pult-meta actions-queued" role="status">{tr('room.pult.v2.workQueued')}</p>
  {/if}
</div>

<style>
  .actions { flex-shrink: 0; }
  .actions-main { display: flex; align-items: center; gap: 8px; }
  .actions :global(.pult-button) { min-height: 38px; padding: 8px 12px; font-size: 14px; line-height: 20px; white-space: nowrap; }
  .actions-grades { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .actions :global(.action-grade[data-tone='positive'][aria-pressed='true']) { border-color: rgb(var(--positive)); background: rgb(var(--positive) / 0.1); color: rgb(var(--positive)); }
  .actions :global(.action-grade[data-tone='warning'][aria-pressed='true']) { border-color: rgb(var(--warning)); background: rgb(var(--warning) / 0.1); color: rgb(var(--warning)); }
  .actions-run-state { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-top: 8px; }
  .actions-queued { margin: 8px 0 0; }
  .act-short { display: none; }
  /* A narrow work panel: the labels are short, but the buttons stay buttons.
     760 is the window width at which four full labels stop fitting into the
     work panel next to the list. */
  @media (max-width: 760px) {
    .actions :global(.pult-button) { padding: 8px 10px; }
    .act-long { display: none; }
    .act-short { display: inline; }
  }
  @media (max-width: 650px) {
    .actions-main { gap: 6px; }
    .actions-grades { gap: 6px; margin-left: 0; flex: 2; }
    .actions :global(.pult-button) { flex: 1; min-width: 0; min-height: 44px; padding: 8px 4px; font-size: 14px; }
    .actions-main > :global(.pult-button) { flex: 1; }
  }
</style>
