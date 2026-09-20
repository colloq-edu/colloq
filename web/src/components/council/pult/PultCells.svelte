<script lang="ts">
  import { tr } from '@shared/i18n'
  import { tick } from 'svelte'
  import { cellNotes, cellTaskTitle, type PultCellRow } from '@/lib/council-pult'

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
  /**
   * Что стоит в строке и на кнопке: НАЗВАНИЕ задания, а не только номер.
   *
   * «Ячейка 60» и «ячейка 65» в меню неразличимы: номер — это место в файле, а
   * выбирают между ячейками по заданию. Правило названия целиком лежит в
   * council-pult.ts (`cellHeadline` / `markdownHeadline`) и проверяется без
   * браузера; сюда приезжает готовая строка, и «ячейка NN» остаётся честным
   * запасным словом, когда выводить название не из чего.
   */
  const nameOf = (cell: PultCellRow | null): string =>
    cell === null ? tr('room.ui.34') : cellTaskTitle(cell)
  /** Номер отдельной меткой: он всё ещё нужен, чтобы найти ячейку в тетради. */
  const numberOf = (cell: PultCellRow | null): string =>
    cell?.index != null ? String(cell.index).padStart(2, '0') : '—'
  /**
   * Тетради в списке: одна — называем её один раз в шапке, несколько — в
   * каждой строке.
   *
   * Номер ячейки уникален только внутри тетради, и «09» в семинаре и «09» в
   * лекции — разные ячейки с одинаковой подписью. Пока тетрадь одна, имя в
   * каждой строке было бы шумом; как только их две, молчание становится
   * ложью — по номеру уже не понять, куда идёшь.
   */
  const books = $derived([...new Set(cells.map((cell) => cell.book).filter(Boolean))])
  const book = $derived(books.length === 1 ? books[0] : '')
  const manyBooks = $derived(books.length > 1)

  let open = $state(false)
  let button = $state<HTMLButtonElement | null>(null)
  let sheet = $state<HTMLElement | null>(null)
  let at = $state<{ x: number; y: number } | null>(null)

  /* 380 — ширина, на которой в строку встают название, строка внимания и
     «13 из 24» с полоской; в 900-пиксельном окне она зажимается по месту. */
  const WIDTH = 380
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
      x: Math.max(8, Math.min(box.left, window.innerWidth - Math.min(WIDTH, window.innerWidth - 16) - 8)),
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
  ><span class="pult-cell-no" aria-hidden="true">{numberOf(here)}</span><span class="pult-cell-title">{nameOf(here)}</span><span class="pult-cell-caret" aria-hidden="true">▾</span></button>
{:else}
  <span class="pult-cell-plain"><span class="pult-cell-no" aria-hidden="true">{numberOf(here)}</span><span class="pult-cell-title">{nameOf(here)}</span></span>
{/if}

{#if open && at}
  <div
    class="pult-cells-sheet"
    role="menu"
    tabindex="-1"
    bind:this={sheet}
    data-pult-cells-sheet
    aria-label={tr('room.pult.v3.cells.title')}
    style={`left:${at.x}px; top:${at.y}px; width:${WIDTH}px; max-width:calc(100vw - 16px)`}
  >
    <!-- Шапка меню: где мы и сколько тут ячеек. Имя тетради стоит здесь, пока
         она одна на весь список; с двумя тетрадями оно уезжает в строки. -->
    <div class="pult-cells-head">
      <span class="pult-cells-where">{#if book}{book} · {/if}{tr('room.pult.v3.cells.headCount', { count: cells.length })}</span>
      <span class="pult-cells-where">{tr('room.pult.v3.cells.headSubmitted')}</span>
    </div>
    {#each cells as cell (cell.cellId)}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={cell.cellId === current}
        class="pult-cells-row"
        class:selected={cell.cellId === current}
        class:closed={cell.review}
        data-pult-cell={cell.cellId}
        onclick={() => pick(cell.cellId)}
      >
        <span class="pult-cells-no" aria-hidden="true">{numberOf(cell)}</span>
        <span class="pult-cells-main">
          <span class="pult-cells-name">{nameOf(cell)}</span>
          {#if manyBooks && cell.book}
            <span class="pult-cells-book">{cell.book}</span>
          {/if}
          <!-- Строка внимания: не «сколько там всего», а «за чем туда идти».
               Состав и порядок — cellNotes (council-pult.ts), одно место. -->
          <span class="pult-cells-notes">
            {#each cellNotes(cell) as note, index (note.text)}
              {#if index > 0}<span class="pult-cells-dot" aria-hidden="true">·</span>{/if}
              {#if note.chip}
                <span class="pult-cells-chip">{note.text}</span>
              {:else}
                <span class="pult-cells-note" data-tone={note.tone}>{note.text}</span>
              {/if}
            {/each}
          </span>
        </span>
        <span class="pult-cells-tail">
          <span class="pult-cells-counts">{tr('room.pult.v3.cells.submitted', { submitted: cell.submitted, total: cell.total })}</span>
          <!-- Доля сдавших полоской: три пикселя высоты отвечают на «далеко ли
               им ещё» быстрее, чем два числа, которые надо поделить в уме. -->
          <span class="pult-cells-bar" aria-hidden="true">
            <span class="pult-cells-bar-fill" data-tone={cell.review ? 'done' : cell.submitted >= cell.total ? 'full' : 'part'}
              style={`width:${cell.total > 0 ? Math.round((Math.min(cell.submitted, cell.total) / cell.total) * 100) : 0}%`}></span>
          </span>
        </span>
      </button>
    {/each}
  </div>
{/if}

<style>
  /*
   * Кнопка выбора — коробка с номером и названием, а не подчёркнутое слово.
   *
   * Слово «ячейка 03» под пунктиром было дверью в список, но самим названием
   * задания не было: на него смотрят весь семинар, и оно заслуживает рамки, а
   * не служебного пунктира. Номер остаётся меткой слева — по нему ячейку ищут
   * в тетради.
   */
  /*
   * Кнопка не сжимается в ничто.
   *
   * `min-width` здесь несущий: без него в шапке 1120 px предложение регламента
   * съедало всю свободную ширину, кнопка схлопывалась в 40 px, и от «60 Задача
   * 1» оставалось «60» с наползающей сверху подписью. Название задания — то,
   * ради чего кнопку и завели; место ей уступает предложение (PultHeader).
   */
  .pult-cell-open, .pult-cell-plain {
    flex: 0 1 auto; min-width: 140px; max-width: 300px; overflow: hidden;
    display: inline-flex; align-items: center; gap: 7px; height: 28px;
    padding: 0 9px 0 7px;
    border: 1px solid rgb(var(--line)); background: rgb(var(--canvas));
  }
  .pult-cell-open { cursor: pointer; }
  .pult-cell-open:hover { border-color: rgb(var(--primary)); background: rgb(var(--raised)); }
  .pult-cell-open[aria-expanded='true'] { border-color: rgb(var(--primary)); background: rgb(var(--raised)); }
  /* Одна ячейка — та же коробка без двери: дверь в меню из одной строки это
     лишнее нажатие в шапке, где счёт идёт на пиксели. */
  .pult-cell-plain { border-style: dashed; border-color: rgb(var(--line) / .7); }
  .pult-cell-no { flex-shrink: 0; padding: 0 4px; background: rgb(var(--raised)); color: rgb(var(--primary)); font-family: var(--font-mono); font-size: 12px; line-height: 16px; font-weight: 700; }
  .pult-cell-title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: rgb(var(--ink)); font-size: 14px; line-height: 18px; font-weight: 600; }
  .pult-cell-caret { flex-shrink: 0; color: rgb(var(--muted)); font-size: 10px; }
  .pult-cells-sheet {
    position: fixed; z-index: 60;
    max-height: 320px; overflow-y: auto; overscroll-behavior: contain;
    border: 1px solid rgb(var(--line));
    background: rgb(var(--canvas));
    box-shadow: 0 12px 32px rgb(0 0 0 / .28);
  }
  .pult-cells-head {
    position: sticky; top: 0; z-index: 1;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid rgb(var(--line));
    background: rgb(var(--canvas));
  }
  .pult-cells-where { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: rgb(var(--muted)); font-size: 11px; line-height: 14px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  .pult-cells-row {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 9px 12px 9px 9px;
    border-bottom: 1px solid rgb(var(--line));
    border-left: 3px solid transparent;
    text-align: left; cursor: pointer;
  }
  .pult-cells-row:last-child { border-bottom: 0; }
  .pult-cells-row:hover { background: rgb(var(--surface)); }
  /* Текущая — левым рельсом и тоном: её ищут глазами первой, чтобы уйти с неё. */
  .pult-cells-row.selected { border-left-color: rgb(var(--primary)); background: rgb(var(--raised)); }
  .pult-cells-row.closed { color: rgb(var(--faint)); }
  .pult-cells-row:focus-visible { outline: 2px solid rgb(var(--accent-text)); outline-offset: -2px; }
  .pult-cells-no { flex-shrink: 0; width: 24px; color: rgb(var(--muted)); font-family: var(--font-mono); font-size: 12px; line-height: 16px; font-weight: 700; }
  .pult-cells-row.selected .pult-cells-no { color: rgb(var(--primary)); }
  .pult-cells-main { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
  .pult-cells-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: rgb(var(--ink)); font-size: 14px; line-height: 19px; font-weight: 600; }
  .pult-cells-row.selected .pult-cells-name { font-weight: 700; }
  .pult-cells-row.closed .pult-cells-name { color: rgb(var(--muted)); font-weight: 400; }
  /* Тетрадь — тише названия задания и выше строки внимания: это адрес, а не
     то, ради чего в ячейку идут. */
  .pult-cells-book { font-size: 12px; line-height: 16px; color: rgb(var(--faint)); }
  .pult-cells-notes { display: flex; align-items: center; flex-wrap: nowrap; gap: 5px; min-width: 0; overflow: hidden; }
  .pult-cells-note { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: rgb(var(--muted)); font-size: 12px; line-height: 16px; }
  .pult-cells-note[data-tone='accent'] { color: rgb(var(--accent-text)); font-weight: 700; }
  .pult-cells-note[data-tone='warning'] { color: rgb(var(--warning)); font-weight: 700; }
  .pult-cells-note[data-tone='faint'] { color: rgb(var(--faint)); }
  .pult-cells-dot { flex-shrink: 0; color: rgb(var(--faint)); font-size: 12px; }
  .pult-cells-chip { flex-shrink: 0; padding: 0 5px; background: rgb(var(--positive)); color: rgb(var(--canvas)); font-size: 11px; line-height: 16px; font-weight: 700; white-space: nowrap; }
  .pult-cells-tail { display: flex; flex-shrink: 0; flex-direction: column; align-items: flex-end; gap: 4px; width: 84px; }
  .pult-cells-counts { color: rgb(var(--muted)); font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pult-cells-bar { display: block; width: 100%; height: 3px; background: rgb(var(--line)); }
  .pult-cells-bar-fill { display: block; height: 100%; background: rgb(var(--accent)); }
  .pult-cells-bar-fill[data-tone='full'] { background: rgb(var(--positive)); }
  .pult-cells-bar-fill[data-tone='done'] { background: rgb(var(--faint) / .6); }
  @media (max-width: 650px) {
    /* Палец: строка меню не опускается ниже собственной цели нажатия. */
    .pult-cells-row { padding: 11px 12px 11px 9px; }
    /* На 390 px кнопка берёт всю оставшуюся ширину и обрезает название
       многоточием: держать 140 px нечем — рядом стоят ещё три цели. */
    .pult-cell-open, .pult-cell-plain { flex: 1 1 auto; min-width: 0; max-width: none; height: 34px; }
    .pult-cell-title { font-size: 15px; }
  }
</style>
