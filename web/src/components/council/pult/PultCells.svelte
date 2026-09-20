<script lang="ts">
  import { tr } from '@shared/i18n'
  import { tick } from 'svelte'
  import type { PultCellRow } from '@/lib/council-pult'

  /**
   * Номер ячейки в шапке — и список всех ячеек консилиума за ним.
   *
   * Пульт один на комнату (одно имя окна, council-pult-window.ts), а
   * консилиумов в тетради идёт несколько, и до 20.09 переход между ними был
   * возвращением в тетрадь, прокруткой до другой ячейки и нажатием «Пульт ↗».
   * «Будет круто иметь один общий пульт, в котором можно перемещаться между
   * ячейками: пусть „ячейка 60“ вверху слева станет выпадающим списком.»
   *
   * Список — своё меню, не `<select>`: в строке стоит не одно слово, а четыре
   * факта («сдали 12 из 25», «идёт запуск», «на экране», «просмотр»), и
   * выбирают по ним, а не по номеру. Манера — та же, что у меню доступа на
   * вкладке тетради (reader/TabStrip.svelte) и у меню бана: `position: fixed` от
   * кнопки, потому что шапка пульта сжата до 56 px и обрезает всё, что из неё
   * выпадает; Escape и щелчок мимо закрывают, фокус возвращается на кнопку.
   *
   * Одна ячейка — кнопки нет вовсе: меню из одной строки не выбор, а лишняя
   * дверь в шапке, где счёт идёт на пиксели.
   */

  interface Props {
    cells: readonly PultCellRow[]
    /** Ячейка, на которой пульт стоит сейчас. */
    current: string
    onpick: (cellId: string) => void
  }

  let { cells, current, onpick }: Props = $props()

  const here = $derived(cells.find((cell) => cell.cellId === current) ?? null)
  const many = $derived(cells.length > 1)
  /** Слово ячейки: номер, а без номера (ячейку удалили) — общее имя. */
  const nameOf = (cell: PultCellRow | null): string =>
    cell?.index != null ? tr('room.ui.1272', { p0: String(cell.index).padStart(2, '0') }) : tr('room.ui.34')

  let open = $state(false)
  let button = $state<HTMLButtonElement | null>(null)
  let sheet = $state<HTMLElement | null>(null)
  let at = $state<{ x: number; y: number } | null>(null)

  const WIDTH = 288
  /* Измеренная, а не вычисленная: нужна ровно затем, чтобы меню не ушло под
     нижнюю кромку окна 900×650, и ошибка в большую сторону безобидна. */
  const MAX_HEIGHT = 320

  function toggle(): void {
    if (open) {
      close()
      return
    }
    const box = button?.getBoundingClientRect()
    if (!box) return
    at = {
      x: Math.max(8, Math.min(box.left, window.innerWidth - WIDTH - 8)),
      y: Math.max(8, Math.min(box.bottom + 2, window.innerHeight - MAX_HEIGHT - 8)),
    }
    open = true
    // Клавиатура забирается сразу, и первой берётся строка, на которой стоим:
    // список открывают, чтобы уйти с неё, и видеть её положение обязательно.
    void tick().then(() =>
      (sheet?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
        sheet?.querySelector<HTMLButtonElement>('button'))?.focus(),
    )
  }

  function close(back = true): void {
    if (!open) return
    open = false
    at = null
    if (back) void tick().then(() => button?.focus())
  }

  function pick(cellId: string): void {
    close(false)
    if (cellId !== current) onpick(cellId)
  }

  $effect(() => {
    if (!open) return
    const away = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-pult-cells-sheet], [data-pult-cells-open]')) return
      close(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Не доходит до окна: иначе Esc закрыл бы заодно поиск в списке работ.
      event.stopPropagation()
      close()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', escape, true)
    }
  })

  /* Ячейку убрали из комнаты, пока меню открыто, — закрывать нечего. */
  $effect(() => {
    if (open && cells.length === 0) close(false)
  })
</script>

{#if many}
  <button
    type="button"
    class="pult-cell-open"
    bind:this={button}
    data-pult-cells-open
    aria-haspopup="menu"
    aria-expanded={open}
    title={tr('room.pult.v3.cells.open')}
    onclick={toggle}
  >{nameOf(here)}<span class="pult-cell-caret" aria-hidden="true">▾</span></button>
{:else}
  <span class="pult-cell-plain">{nameOf(here)}</span>
{/if}

{#if open && at}
  <div
    class="pult-cells-sheet"
    role="menu"
    tabindex="-1"
    bind:this={sheet}
    data-pult-cells-sheet
    aria-label={tr('room.pult.v3.cells.title')}
    style={`left:${at.x}px; top:${at.y}px; width:${WIDTH}px`}
  >
    {#each cells as cell (cell.cellId)}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={cell.cellId === current}
        class="pult-cells-row"
        class:selected={cell.cellId === current}
        data-pult-cell={cell.cellId}
        onclick={() => pick(cell.cellId)}
      >
        <span class="pult-cells-name">
          {nameOf(cell)}
          <!-- Имя тетради — только когда ячейки из разных: номера уникальны
               внутри тетради, и «ячейка 03» дважды в списке не различалась бы
               ничем. -->
          {#if cell.book}<span class="pult-cells-book">· {cell.book}</span>{/if}
        </span>
        <span class="pult-cells-counts">{tr('room.pult.v3.cells.submitted', { submitted: cell.submitted, total: cell.total })}</span>
        <span class="pult-cells-marks">
          {#if cell.running}<span class="pult-cells-mark" data-tone="accent">{tr('room.pult.v3.cells.running')}</span>{/if}
          {#if cell.onScreen}<span class="pult-cells-mark" data-tone="positive">{tr('room.pult.v3.cells.onScreen')}</span>{/if}
          {#if cell.review}<span class="pult-cells-mark">{tr('room.pult.v3.cells.review')}</span>{/if}
        </span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .pult-cell-open {
    flex-shrink: 0;
    display: inline-flex; align-items: baseline; gap: 3px;
    padding: 0 2px;
    border-bottom: 1px dashed rgb(var(--primary) / .5);
    color: rgb(var(--ink)); font-size: 13px; line-height: 18px; font-weight: 700;
    cursor: pointer;
  }
  .pult-cell-open:hover { border-bottom-color: rgb(var(--primary)); }
  /* Одна ячейка — то же слово тем же весом, только без двери. */
  .pult-cell-plain { flex-shrink: 0; color: rgb(var(--ink)); font-size: 13px; line-height: 18px; font-weight: 700; }
  .pult-cell-caret { color: rgb(var(--muted)); font-size: 10px; }
  .pult-cells-sheet {
    position: fixed; z-index: 60;
    max-height: 320px; overflow-y: auto; overscroll-behavior: contain;
    padding: 4px;
    border: 1px solid rgb(var(--line));
    background: rgb(var(--canvas));
    box-shadow: 0 12px 32px rgb(0 0 0 / .28);
  }
  .pult-cells-row {
    display: grid; grid-template-columns: 1fr auto; align-items: baseline;
    gap: 2px 10px; width: 100%;
    padding: 7px 10px;
    text-align: left; cursor: pointer;
  }
  .pult-cells-row:hover { background: rgb(var(--raised)); }
  .pult-cells-row.selected { background: rgb(var(--raised)); }
  .pult-cells-row:focus-visible { outline: 2px solid rgb(var(--accent-text)); outline-offset: -2px; }
  .pult-cells-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: rgb(var(--ink)); font-size: 14px; line-height: 20px; font-weight: 700; }
  .pult-cells-book { color: rgb(var(--muted)); font-weight: 400; }
  .pult-cells-counts { flex-shrink: 0; color: rgb(var(--muted)); font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; }
  /* Пометки во всю ширину строки: их бывает три, и перенос на второй ряд
     читается лучше, чем обрезанная «на экра…» рядом с числом. */
  .pult-cells-marks { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px; }
  .pult-cells-marks:empty { display: none; }
  .pult-cells-mark {
    padding: 0 5px;
    border: 1px solid rgb(var(--line));
    color: rgb(var(--muted)); font-size: 11px; line-height: 16px;
  }
  .pult-cells-mark[data-tone='accent'] { border-color: rgb(var(--accent) / .5); color: rgb(var(--accent-text)); }
  .pult-cells-mark[data-tone='positive'] { border-color: rgb(var(--positive) / .5); color: rgb(var(--positive)); }
  @media (max-width: 650px) {
    /* Палец: строка меню не опускается ниже собственной цели нажатия. */
    .pult-cells-row { padding: 10px 12px; }
    .pult-cell-open, .pult-cell-plain { font-size: 14px; }
  }
</style>
