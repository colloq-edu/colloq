<script lang="ts">
  import { tr } from '@shared/i18n'
  import { cn, spell } from '@/lib/utils'

  interface Props {
    /** Эта работа сейчас в зале. */
    onScreen: boolean
    /** Эта работа считается в ядре. */
    running: boolean
    queued: boolean
    /** Сколько уже считает. */
    elapsed: number
    /** Сколько уже в кадре. */
    inFrame: number
    /** Запускали ли её раньше — «Запустить» или «Запустить снова». */
    ran: boolean
    correct: boolean | null
    /** Работа — черновик: показывать классу нечего. */
    writing: boolean
    disabled: boolean
    /** Сосед внутри той же группы есть. */
    hasNeighbour: boolean
    onshow: () => void
    onclear: () => void
    onrun: () => void
    oninterrupt: () => void
    onneighbour: () => void
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
      {onScreen ? tr('room.pult.v2.workClear') : tr('room.ui.1336')}
      <span aria-hidden="true">{onScreen ? '×' : '↗'}</span>
    </button>
    <button type="button" class="pult-button action-run" disabled={disabled || running || queued}
      title={ran ? tr('room.ui.1338') : tr('room.ui.1337')} data-pult-run onclick={onrun}>
      <span aria-hidden="true">▶</span> {tr('room.ui.1337')}
    </button>
    <div class="actions-grades" role="group" aria-label={tr('room.pult.v2.workReview')}>
      <button type="button" class={cn('pult-button action-grade', correct === true && 'pult-button--selected')}
        data-tone="positive" aria-pressed={correct === true} disabled={disabled} onclick={() => onmark(true)}>
        <span aria-hidden="true">✓</span> {tr('room.pult.v2.workCorrect')}
      </button>
      <button type="button" class={cn('pult-button action-grade', correct === false && 'pult-button--selected')}
        data-tone="warning" aria-pressed={correct === false} disabled={disabled} onclick={() => onmark(false)}>
        <span aria-hidden="true">↺</span> {tr('room.pult.v2.workRevise')}
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
  .actions { flex-shrink: 0; padding: 12px 24px; border-top: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
  .actions-main { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-height: 44px; }
  .actions :global(.pult-button) { min-height: 42px; padding: 10px 12px; font-size: 14px; line-height: 20px; white-space: nowrap; }
  .actions :global(.action-show), .actions :global(.action-run) { font-size: 15px; }
  .actions-grades { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .actions :global(.action-grade[data-tone='positive'][aria-pressed='true']) { border-color: rgb(var(--positive)); background: rgb(var(--positive) / 0.1); color: rgb(var(--positive)); }
  .actions :global(.action-grade[data-tone='warning'][aria-pressed='true']) { border-color: rgb(var(--warning)); background: rgb(var(--warning) / 0.1); color: rgb(var(--warning)); }
  .actions-run-state { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-top: 10px; }
  .actions-queued { margin: 10px 0 0; }
  @media (max-width: 1000px) { .actions { padding-inline: 16px; } }
</style>
