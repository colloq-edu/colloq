<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Строка состояния, 26 px — единственное место в окне, где 10 px допустимы.
   *
   * Слева то, что сейчас видит зал, справа — где вы в ленте и клавиша помощи.
   *
   * РУЧКА ИМЁН ЖИВЁТ ЗДЕСЬ, а не в настройках ячейки: решение «подписывать ли
   * на стене именем» принимается за секунду до показа, а не за день, и стоять
   * оно должно рядом с тем, что печатает имена. Выключенная — и зал видит
   * «Вариант N»; автор у себя всё равно видит, что его вариант на экране.
   * Скрыть имя постфактум нельзя: уехавшее в чужой браузер считается
   * показанным, — поэтому ручку и щёлкают до показа.
   */
  import { cn } from '@/lib/utils'

  interface Props {
    /** Кто на экране словами; `null` — в зале ничего. */
    onScreen: string | null
    /** Сколько уже в кадре, словами. */
    inFrame: string
    names: boolean
    /** Место открытой работы в ленте. */
    index: number
    total: number
    disabled: boolean
    onnames: (names: boolean) => void
    onclear: () => void
    onhelp: () => void
  }

  let { onScreen, inFrame, names, index, total, disabled, onnames, onclear, onhelp }: Props = $props()
</script>

<footer class="flex min-h-[32px] shrink-0 flex-wrap py-1 items-center gap-3 border-t border-line bg-surface px-4">
  <span class="flex min-w-0 flex-1 items-center gap-2 font-mono text-micro text-faint">
    {#if onScreen !== null}
      <span class="min-w-0 max-w-[180px] truncate text-positive">{tr('room.ui.1352', { p0: onScreen })}</span>
      {#if inFrame}<span class="shrink-0">· {inFrame}</span>{/if}
      <span class="shrink-0">·</span>
    {/if}
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 hover:text-ink"
      role="switch"
      aria-checked={names}
      disabled={disabled}
      onclick={() => onnames(!names)}
    >
      <span
        class={cn(
          'flex h-3 w-[22px] shrink-0 items-center p-px',
          names ? 'justify-end bg-accent' : 'justify-start bg-line',
        )}
        aria-hidden="true"
      >
        <span class={cn('h-2.5 w-2.5 shrink-0', names ? 'bg-accent-ink' : 'bg-faint')}></span>
      </span>
      {names ? tr('room.ui.1353') : tr('room.ui.1354')}
    </button>
    {#if onScreen !== null}
      <span class="shrink-0">·</span>
      <button
        type="button"
        class="shrink-0 uppercase tracking-caps text-danger hover:underline"
        disabled={disabled}
        onclick={onclear}
      >{tr('room.ui.1348')}</button>
    {/if}
  </span>
  <span class="shrink-0 font-mono text-micro text-faint">{index} / {total}</span>
  <button type="button" class="shrink-0 font-mono text-micro text-faint hover:text-ink" onclick={onhelp}>
    {tr('room.ui.1355')}
  </button>
</footer>
