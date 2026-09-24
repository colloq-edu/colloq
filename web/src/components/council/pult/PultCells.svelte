<script lang="ts">
  import { tr } from '@shared/i18n'
  import { tick } from 'svelte'
  import { cellNotes, cellTaskTitle, type PultCellRow } from '@/lib/council-pult'

  /**
   * The cell number in the header — and the list of all council cells behind
   * it.
   *
   * There is one console per room (one window name, council-pult-window.ts),
   * while a notebook runs several councils, and until 20 Sep 2026 moving
   * between them meant going back to the notebook, scrolling to another cell
   * and pressing "Console ↗". "It would be great to have one shared console
   * where you can move between cells: let "cell 60" at the top left become a
   * dropdown."
   *
   * The list is a menu of its own, not a `<select>`: a row holds not one word
   * but four facts ("12 of 25 submitted", "running", "on screen", "review
   * only"), and people choose by them, not by the number. The manner is the
   * same as the access menu on the notebook tab (reader/TabStrip.svelte) and
   * the ban menu: `position: fixed` from the button, because the console
   * header is squeezed to 56 px and clips everything that falls out of it;
   * Escape and a click outside close it, and focus returns to the button.
   *
   * With one cell there is no button at all: a one-row menu is not a choice
   * but an extra door in a header where every pixel counts.
   */

  interface Props {
    cells: readonly PultCellRow[]
    /** The cell the console is on right now. */
    current: string
    onpick: (cellId: string) => void
  }

  let { cells, current, onpick }: Props = $props()

  const here = $derived(cells.find((cell) => cell.cellId === current) ?? null)
  const many = $derived(cells.length > 1)
  /**
   * What stands in the row and on the button: the task's NAME, not only the
   * number.
   *
   * "Cell 60" and "cell 65" are indistinguishable in a menu: the number is a
   * place in the file, while people choose between cells by task. The naming
   * rule lives entirely in council-pult.ts (`cellHeadline` /
   * `markdownHeadline`) and is checked without a browser; a ready string
   * arrives here, and "cell NN" remains an honest fallback word when there
   * is nothing to derive a name from.
   */
  const nameOf = (cell: PultCellRow | null): string =>
    cell === null ? tr('room.ui.34') : cellTaskTitle(cell)
  /** The number as a separate label: still needed to find the cell in the notebook. */
  const numberOf = (cell: PultCellRow | null): string =>
    cell?.index != null ? String(cell.index).padStart(2, '0') : '—'
  /**
   * Notebooks in the list: with one, we name it once in the header; with
   * several, in every row.
   *
   * A cell number is unique only within a notebook, and "09" in the seminar
   * and "09" in the lecture are different cells with the same caption. While
   * there is one notebook, its name in every row would be noise; as soon as
   * there are two, silence becomes a lie — the number no longer tells where
   * you are going.
   */
  const books = $derived([...new Set(cells.map((cell) => cell.book).filter(Boolean))])
  const book = $derived(books.length === 1 ? books[0] : '')
  const manyBooks = $derived(books.length > 1)

  let open = $state(false)
  let button = $state<HTMLButtonElement | null>(null)
  let sheet = $state<HTMLElement | null>(null)
  let at = $state<{ x: number; y: number } | null>(null)

  /* 380 is the width at which the name, the attention line and "13 of 24"
     with its bar fit in a row; in a 900-pixel window it is squeezed to fit. */
  const WIDTH = 380
  /* Measured, not computed: it is needed exactly so that the menu does not
     go under the bottom edge of a 900×650 window, and erring on the large
     side is harmless. */
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
    // The keyboard is taken at once, and the current row comes first: the
    // list is opened to leave it, and its position has to be visible.
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
      // Does not reach the window: otherwise Esc would also close the search
      // in the work list.
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

  /* The cell was taken out of the room while the menu was open — nothing is left to pick. */
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
    <!-- The menu header: where we are and how many cells there are. The
         notebook's name stands here while there is one for the whole list;
         with two notebooks it moves into the rows. -->
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
          <!-- The attention line: not "how much is there" but "what to go
               there for". Content and order come from cellNotes
               (council-pult.ts), in one place. -->
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
          <!-- The share who submitted as a bar: three pixels of height answer
               "how far do they still have to go" faster than two numbers
               that have to be divided in your head. -->
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
   * The picker button is a box with a number and a name, not an underlined
   * word.
   *
   * The dotted-underlined word "cell 03" was a door into the list, but it
   * was not the task's name: people look at it for the whole seminar, and it
   * deserves a frame, not a utility dotted line. The number stays a label on
   * the left — it is how the cell is found in the notebook.
   */
  /*
   * The button does not shrink into nothing.
   *
   * The `min-width` here is load-bearing: without it, in a 1120 px header
   * the rules sentence ate all the free width, the button collapsed to 40
   * px, and of "60 Task 1" only "60" remained, with the caption creeping over
   * it from above. The task's name is what the button was made for; it is
   * the sentence that gives way (PultHeader).
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
  /* One cell — the same box without a door: a door into a one-row menu is an
     extra press in a header where every pixel counts. */
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
  /* Current row: left rail and tone — the eye seeks it first, in order to leave it. */
  .pult-cells-row.selected { border-left-color: rgb(var(--primary)); background: rgb(var(--raised)); }
  .pult-cells-row.closed { color: rgb(var(--faint)); }
  .pult-cells-row:focus-visible { outline: 2px solid rgb(var(--accent-text)); outline-offset: -2px; }
  .pult-cells-no { flex-shrink: 0; width: 24px; color: rgb(var(--muted)); font-family: var(--font-mono); font-size: 12px; line-height: 16px; font-weight: 700; }
  .pult-cells-row.selected .pult-cells-no { color: rgb(var(--primary)); }
  .pult-cells-main { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
  .pult-cells-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: rgb(var(--ink)); font-size: 14px; line-height: 19px; font-weight: 600; }
  .pult-cells-row.selected .pult-cells-name { font-weight: 700; }
  .pult-cells-row.closed .pult-cells-name { color: rgb(var(--muted)); font-weight: 400; }
  /* The notebook is quieter than the task name and above the attention line:
     it is an address, not what people go into the cell for. */
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
    /* A finger: a menu row does not get smaller than its own touch target. */
    .pult-cells-row { padding: 11px 12px 11px 9px; }
    /* At 390 px the button takes all the remaining width and cuts the name
       with an ellipsis: there is no room to hold 140 px — three more targets
       stand next to it. */
    .pult-cell-open, .pult-cell-plain { flex: 1 1 auto; min-width: 0; max-width: none; height: 34px; }
    .pult-cell-title { font-size: 15px; }
  }
</style>
