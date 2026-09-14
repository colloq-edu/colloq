<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Полоса действий открытой работы, 591×56, прибитая к низу правой колонки.
   *
   * Порядок кнопок не меняется НИКОГДА: показать · запустить · разделитель ·
   * верно · ошибка · … · хвост. Меняются смысл первых двух и хвост — по тому,
   * что сейчас в зале и что сейчас в ядре. Кнопка, которая переезжает под
   * пальцем, стоит одного промаха перед аудиторией.
   *
   * «Показать классу» — единственная заливка в окне: из пульта наружу ведёт
   * ровно одна дверь, и она обязана быть видна с одного взгляда.
   *
   * ВРЕМЕНИ ОТМЕТКИ ЗДЕСЬ НЕТ. На макете в хвосте отмеченной работы стоит
   * «отмечено 14:39»; в протоколе у отметки только `correct: boolean | null`,
   * времени нет, и выдумывать его на месте — значит поставить в пульт час,
   * который ничему не соответствует.
   */
  import { cn, spell } from '@/lib/utils'

  interface Props {
    /** Эта работа сейчас в зале. */
    onScreen: boolean
    /** Эта работа считается в ядре. */
    running: boolean
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
    elapsed,
    inFrame,
    ran,
    correct,
    writing,
    disabled,
    hasNeighbour,
    onshow,
    onclear,
    onrun,
    oninterrupt,
    onneighbour,
    onmark,
  }: Props = $props()

  const CAPS = 'text-2xs font-bold uppercase tracking-label'
  const BTN = 'flex h-8 shrink-0 items-center px-3.5'
</script>

<div
  class={cn(
    'flex h-14 shrink-0 items-center gap-2 border-t bg-surface px-4',
    onScreen ? 'border-t-positive' : 'border-t-line',
  )}
  data-pult-actions
>
  {#if onScreen}
    <button
      type="button"
      class={cn(BTN, CAPS, 'border border-danger text-danger')}
      disabled={disabled}
      onclick={onclear}
    >{tr('room.ui.1254')}</button>
  {:else}
    <button
      type="button"
      class={cn(BTN, CAPS, 'bg-accent text-accent-ink disabled:opacity-50')}
      disabled={disabled || writing}
      onclick={onshow}
    >{tr('room.ui.1336')}</button>
  {/if}

  {#if running}
    <!-- Нажимать больше нечего: показание со счётчиком вместо кнопки. -->
    <span class={cn(BTN, 'gap-2 border border-accent')} aria-live="polite">
      <span class={cn(CAPS, 'text-accent')}>{tr('room.ui.1343')}</span>
      <span class="font-mono text-2xs text-accent">{spell(elapsed)}</span>
    </span>
  {:else if onScreen && hasNeighbour}
    <button
      type="button"
      class={cn(BTN, CAPS, 'border border-line text-ink')}
      disabled={disabled}
      onclick={onneighbour}
    >{tr('room.ui.1339')} →</button>
  {:else}
    <button
      type="button"
      class={cn(BTN, CAPS, 'border border-line text-ink disabled:text-faint')}
      disabled={disabled}
      onclick={onrun}
    >{ran ? tr('room.ui.1338') : tr('room.ui.1337')}</button>
  {/if}

  <span class="h-5 w-px shrink-0 bg-line" aria-hidden="true"></span>

  <button
    type="button"
    class={cn(
      'flex h-8 w-8 shrink-0 items-center justify-center border font-mono text-ui-lg font-bold',
      correct === true ? 'border-positive bg-positive text-canvas' : 'border-line text-faint',
    )}
    aria-pressed={correct === true}
    title={tr('room.ui.1046')}
    disabled={disabled}
    onclick={() => onmark(true)}
  >✓</button>
  <button
    type="button"
    class={cn(
      'flex h-8 w-8 shrink-0 items-center justify-center border font-mono text-ui-lg font-bold',
      correct === false ? 'border-danger bg-danger text-canvas' : 'border-line text-faint',
    )}
    aria-pressed={correct === false}
    title={tr('room.ui.1047')}
    disabled={disabled}
    onclick={() => onmark(false)}
  >✗</button>

  <span class="min-w-0 flex-1"></span>

  {#if running}
    <button
      type="button"
      class={cn(BTN, CAPS, 'border border-line text-ink')}
      disabled={disabled}
      onclick={oninterrupt}
    >{tr('room.ui.1284')}</button>
  {:else if onScreen}
    <span class="h-1.5 w-1.5 shrink-0 bg-positive" aria-hidden="true"></span>
    <span class="shrink-0 font-mono text-micro text-positive">{tr('room.ui.1341', { p0: spell(inFrame) })}</span>
  {:else}
    <span class="shrink-0 font-mono text-micro text-faint">← → {tr('room.ui.1340')}</span>
  {/if}
</div>
