<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Шапка пульта, 34 px. Ничего нажимаемого, кроме «в тетрадь ⇤».
   *
   * Своих кнопок закрытия окно не рисует: закрывают системным крестиком или
   * ⌘W. Внутри остаётся одна дверь наружу, и она же говорит, куда вернётся
   * консоль. Обещание приватности стоит в шапке, а не в подсказке: пультом
   * пользуются, пока тетрадь висит на проекторе, и «зал этого не видит» —
   * единственное, что надо знать про это окно.
   */
  import { cn } from '@/lib/utils'

  interface Props {
    /** Номер ячейки в тетради, с единицы; `null` — не знаем. */
    cellIndex: number | null
    /** Имя занятия — справа от номера ячейки. */
    title: string
    onexit: () => void
  }

  let { cellIndex, title, onexit }: Props = $props()

  const CAPS = 'text-micro font-bold uppercase tracking-caps'
  const where = $derived(
    [cellIndex === null ? '' : tr('room.ui.1272', { p0: String(cellIndex).padStart(2, '0') }), title]
      .filter(Boolean)
      .join(' · '),
  )
</script>

<header class="flex h-[34px] shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
  <span class="h-2 w-2 shrink-0 bg-accent" aria-hidden="true"></span>
  <span class="shrink-0 text-2xs font-bold uppercase tracking-caps text-ink">{tr('room.ui.1269')}</span>
  <span class="min-w-0 flex-1 truncate font-mono text-2xs text-faint">{where}</span>
  <span class="hidden shrink-0 font-mono text-2xs text-muted sm:inline">{tr('room.ui.1270')}</span>
  <span class="h-3.5 w-px shrink-0 bg-line" aria-hidden="true"></span>
  <button type="button" class={cn(CAPS, 'shrink-0 text-faint hover:text-ink')} onclick={onexit}>
    {tr('room.ui.1271')} ⇤
  </button>
</header>
