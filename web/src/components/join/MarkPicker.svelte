<script lang="ts">
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import { MARKS } from '@/lib/marks'

  interface Props {
    /** The mark this browser is holding — highlighted, and where the keyboard starts. */
    value: string | null
    /** mark → colour of the person in the room already wearing it. */
    taken: ReadonlyMap<string, string>
    onpick: (mark: string) => void
    /** Escape from anywhere in the picker. */
    onclose: () => void
  }

  let { value, taken, onpick, onclose }: Props = $props()

  /* Eight across is what makes the grid land exactly on the column: eight 49px
     cells and seven 8px gaps is the 448px the form is drawn at. The cells are
     square and flexible, so a narrower window shrinks them instead of pushing
     the last column out — the bug that made the old picker "кривой". */
  const COLS = 8

  let query = $state('')
  let cursor = $state(0)
  let cells: HTMLButtonElement[] = $state([])
  let search = $state<HTMLInputElement | null>(null)

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase()
    if (!q) return MARKS
    return MARKS.filter(
      (entry) => entry.name.toLowerCase().includes(q) || entry.alt?.includes(q),
    )
  })

  // Clamped on read rather than written back: filtering shortens the list under
  // the cursor, and a $state that fixes itself in an effect flickers a frame.
  const active = $derived(Math.min(cursor, Math.max(0, shown.length - 1)))

  $effect(() => {
    // The picker opens because the student asked to change their mark, so the
    // search box is where the caret belongs.
    search?.focus()
  })

  function focusCell(index: number): void {
    cursor = index
    cells[index]?.focus()
  }

  function choose(mark: string): void {
    // A taken mark stays visible — it tells the student who is already here —
    // but it is not a thing they can have.
    if (taken.has(mark)) return
    onpick(mark)
  }

  function onGridKey(event: KeyboardEvent, index: number): void {
    const last = shown.length - 1
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: COLS,
      ArrowUp: -COLS,
    }

    if (event.key === 'Escape') {
      onclose()
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusCell(event.key === 'Home' ? 0 : last)
      return
    }
    const delta = step[event.key]
    if (delta === undefined) return

    event.preventDefault()
    // Up from the top row leaves the grid for the search box, which is the only
    // other thing here; every other move is clamped inside the grid.
    if (delta === -COLS && index < COLS) {
      search?.focus()
      return
    }
    focusCell(Math.min(Math.max(index + delta, 0), last))
  }

  function onSearchKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      onclose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusCell(0)
      return
    }
    // The form's submit button is a keystroke away; Enter here means "the one I
    // just searched for", not "join now".
    if (event.key === 'Enter') {
      event.preventDefault()
      const first = shown.find((entry) => !taken.has(entry.mark))
      if (first) choose(first.mark)
    }
  }

  function surprise(): void {
    const pool = shown.filter((entry) => !taken.has(entry.mark) && entry.mark !== value)
    if (pool.length > 0) onpick(pool[Math.floor(Math.random() * pool.length)].mark)
  }

  // The legend borrows a real holder's colour rather than inventing a swatch:
  // the dot it explains is always somebody's.
  const legendColor = $derived([...taken.values()][0] ?? null)
</script>

<div class="flex flex-col gap-2.5">
  <div class="flex items-center gap-2">
    <!-- Square, like everything else on this form. The focus ring lives on the
         box rather than the input because the picker opens with the caret
         already in here, and a focus that shows nowhere is a focus lost. -->
    <div
      class="flex min-w-0 flex-1 items-center gap-2.5 border border-line px-3
             focus-within:border-accent"
    >
      <Icon name="search" size={13} strokeWidth={2} class="shrink-0 text-faint" />
      <input
        bind:this={search}
        bind:value={query}
        onkeydown={onSearchKey}
        type="search"
        class="h-9 min-w-0 flex-1 bg-transparent text-ui text-ink placeholder:text-faint focus:outline-none"
        placeholder={tr('room.ui.120')}
        aria-label={tr('room.ui.121')}
        autocomplete="off"
      />
    </div>

    <!-- The picker's own button, and the only one here a student presses more
         than once — a couple of taps while they read the marks. `press` is the
         house helper for controls that do not route through .btn: transform
         only, 120ms (--speed-press, the middle of the press tier) on
         --ease-out, scale(0.97) under the finger. Opting in by name keeps one
         press in the product instead of a near-miss copy of it. -->
    <button
      type="button"
      class="press flex h-9 shrink-0 items-center gap-2 border border-line bg-canvas px-3
             text-ui font-semibold text-ink hover:border-faint"
      onclick={surprise}
    >
      <Icon name="restart" size={13} /> {tr('room.ui.122')} </button>
  </div>

  <div
    class="grid grid-cols-8 gap-2 pt-0.5"
    role="radiogroup"
    aria-label={tr('room.ui.123')}
  >
    {#each shown as entry, i (entry.mark)}
      {@const held = taken.get(entry.mark)}
      {@const selected = entry.mark === value}
      <!-- The same `press` the two buttons above wear, for the same reason: a
           tile is the most-tapped thing on this screen and the only proof the
           tap was heard — the border and the ring arrive from `value`, which
           is a round trip away. These tiles carry no other transition utility,
           so the helper class is enough; a `transition-*` utility would
           rewrite transition-property and leave transform out of the list.

           Not on a taken mark: `choose` returns without doing anything there
           (the tile is the roster, not a thing to have), and a press is a
           promise that something happened.

           Своя метка остаётся своей, даже когда её успели занять: ростер
           перечитывается при открытии подборщика (JoinScreen · `openPicker`),
           и выбранный руками зверь может приехать сюда уже занятым. Серым он
           тогда становиться не должен — «где мой» на сорока плитках без рамки
           не читается, — но точка носителя остаётся: рядом с вами его носит
           кто-то ещё, и это ровно то, что советует сделать карточка входа. -->
      <button
        bind:this={cells[i]}
        type="button"
        role="radio"
        aria-checked={selected}
        aria-disabled={held ? 'true' : undefined}
        aria-label={entry.name}
        title={held ? tr('room.mark.taken', { name: entry.name }) : entry.name}
        tabindex={i === active ? 0 : -1}
        onclick={() => choose(entry.mark)}
        onkeydown={(event) => onGridKey(event, i)}
        class="relative flex aspect-square items-center justify-center border
               {held ? '' : 'press'}
               {selected
          ? 'border-accent bg-canvas ring-1 ring-inset ring-accent'
          : held
            ? 'border-line-soft bg-surface'
            : 'border-line bg-canvas hover:border-faint'}"
      >
        <!-- Faded rather than hidden: the grid is also the roster, and a
             student recognising "the wolf is already someone" is the point. -->
        <span class="text-display leading-none {held && !selected ? 'opacity-25' : ''}"
          >{entry.mark}</span
        >
        {#if held}
          <span
            class="absolute right-1 top-1 h-2.5 w-2.5 rounded-full"
            style="background-color: {held}"
          ></span>
        {/if}
      </button>
    {/each}
  </div>

  {#if shown.length === 0}
    <p class="text-2xs text-muted">{tr('room.ui.127')}</p>
  {:else if legendColor}
    <div class="flex items-center gap-2 pt-0.5">
      <span class="relative h-4 w-4 shrink-0 border border-line-soft bg-surface">
        <span
          class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full"
          style="background-color: {legendColor}"
        ></span>
      </span>
      <span class="text-2xs text-muted">{tr('room.ui.128')}</span>
    </div>
  {/if}
</div>
