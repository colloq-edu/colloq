<script lang="ts">
  import { tr } from '@shared/i18n'
  import { cn, spell } from '@/lib/utils'

  /**
   * Четыре действия над работой — и они всегда на экране.
   *
   * До этого ряд стоял последним в колонке, которая целиком прокручивалась в
   * невысоком окне: «Показать классу», «Запустить» и обе отметки уезжали под
   * сгиб, и чтобы отметить работу верной, надо было сначала долистать до них.
   * Теперь ряд — дно дока, прибитого к низу панели, и прокручивается над ним
   * только код с выводом.
   *
   * На телефоне четыре кнопки равной ширины по 44 px: подписи там короткие
   * («Классу», «Запуск», «Верно», «Правки») — не ради краткости, а потому что
   * четыре цели нажатия в 360 px шириной иначе не помещаются, а уменьшать их
   * ниже пальца нельзя.
   */
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
  /* Узкая панель работы: подписи короткие, но кнопки остаются кнопками.
     760 — та ширина окна, на которой четыре полных подписи перестают
     помещаться в панель работы рядом со списком. */
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
