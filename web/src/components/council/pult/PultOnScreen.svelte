<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * «На экране сейчас» — обратная сторона единственной двери из пульта в зал.
   *
   * Стоит под полосой очереди и НЕ ЗАВИСИТ от того, какую работу вы читаете
   * сейчас: показанная и открытая — разные вещи, и пока что-то горит на стене,
   * преподаватель обязан видеть, что именно, не отвлекаясь на список.
   *
   * Подпись берётся из кадра показа (`CouncilShown`), а не из стопки: при
   * выключенных именах в кадре нет ни имени, ни цвета — подписывает «Вариант
   * N», и в пульте стоит ровно то, что стоит в зале.
   */
  import type { CouncilShown } from '@shared/protocol'
  import { clock } from '@/lib/history'
  import { cn, spell } from '@/lib/utils'

  interface Props {
    shown: CouncilShown
    now: number
    /** Есть сосед в той же группе — можно показать следующий такой же. */
    hasNeighbour: boolean
    disabled: boolean
    onneighbour: () => void
    onclear: () => void
  }

  let { shown, now, hasNeighbour, disabled, onneighbour, onclear }: Props = $props()

  const CAPS = 'text-micro font-bold uppercase tracking-caps'
</script>

<div
  class="flex h-11 shrink-0 items-center gap-3 border-b border-l-[3px] border-b-line border-l-positive bg-raised px-4"
  data-pult-onscreen
>
  <span class={cn(CAPS, 'shrink-0 text-positive')}>{tr('room.ui.1345')}</span>
  <span
    class="h-5 w-5 shrink-0 rounded-full"
    style:background-color={shown.color ?? 'rgb(var(--line))'}
    aria-hidden="true"
  ></span>
  <span class="shrink-0 truncate text-ui-lg font-bold text-ink">
    {shown.name ?? tr('room.ui.1255', { p0: shown.variant })}
  </span>
  <span class="min-w-0 flex-1 truncate font-mono text-micro text-faint">
    {#if shown.shownAt !== null}
      {tr('room.ui.1346', { p0: clock(shown.shownAt) })} · {tr('room.ui.1341', {
        p0: spell(Math.max(now - shown.shownAt, 0)),
      })}
    {/if}
  </span>
  {#if hasNeighbour}
    <button
      type="button"
      class={cn(CAPS, 'h-6 shrink-0 border border-line px-3 text-ink')}
      disabled={disabled}
      onclick={onneighbour}
    >{tr('room.ui.1347')} →</button>
  {/if}
  <button
    type="button"
    class={cn(CAPS, 'h-6 shrink-0 border border-danger px-3 text-danger')}
    disabled={disabled}
    onclick={onclear}
  >{tr('room.ui.1348')}</button>
</div>
