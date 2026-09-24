<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Everything the room has — with one key.
   *
   * Until now the keyboard covered only the notebook (command mode, arrows, ⇧↵)
   * and the terminal; panels, tabs, jumping to a cell and the oracle's input
   * line lived only under the mouse. A teacher running a class from the
   * keyboard reached for the trackpad for every such action — and those are
   * exactly the seconds during which the classroom sits in silence.
   *
   * The palette is not a second menu but a single list of what the room can
   * already do: its rows call the very same functions as the buttons. That is
   * also why it knows nothing about the room: the list is brought to it
   * ready-made, as a snapshot taken when it opens. A snapshot on purpose: while
   * a person reads the list, cells must not rearrange themselves under the
   * selection cursor because of someone else's keypress.
   *
   * Nothing is animated. This is a surface that is opened dozens of times per
   * class, and any motion on opening turns into a delay between the key and the
   * first letter of the query (Raycast does not animate for exactly this
   * reason).
   */
  import Icon from '@/components/ui/Icon.svelte'
  import { groupHeads, matchItems, type PaletteItem } from '@/components/ui/palette'

  interface Props {
    items: PaletteItem[]
    onclose: () => void
  }

  let { items, onclose }: Props = $props()

  let query = $state('')
  let cursor = $state(0)
  let field = $state<HTMLInputElement | null>(null)
  let listBox = $state<HTMLElement | null>(null)

  /** Filtering and order live in palette.ts — and are tested there. */
  const shown = $derived(matchItems(items, query))

  // A typed letter resets the choice: the row under it is a different one now.
  $effect(() => {
    void query
    cursor = 0
  })

  const active = $derived(shown[Math.min(cursor, Math.max(shown.length - 1, 0))] ?? null)

  $effect(() => {
    field?.focus()
  })

  /** Keep the chosen row in view, with no smoothing: a step, not a ride. */
  $effect(() => {
    const id = active?.id
    if (!id || !listBox) return
    listBox.querySelector(`[data-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  })

  function choose(item: PaletteItem | null): void {
    if (!item) return
    // Close first, then act: half of the actions open a panel or set focus, and
    // a palette still standing on top would take it back.
    onclose()
    item.run()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onclose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      cursor = shown.length === 0 ? 0 : (Math.min(cursor, shown.length - 1) + 1) % shown.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      cursor =
        shown.length === 0 ? 0 : (Math.min(cursor, shown.length - 1) + shown.length - 1) % shown.length
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(active)
    }
  }

  const headings = $derived(groupHeads(shown))

</script>

<!--
  The palette does not need a layer above the console and the projection
  (z-[95]/z-[90]) for its own sake: it lives only in the room. But it has to be
  above the sliding panels (z-40) and the refusal window — those panels are
  opened from the palette, and the refusal window has since risen above the
  console (z-[97], SessionScreen), so the palette followed it. Nothing rises
  above the room's final-state overlays (z-[100]): at that point there is
  nothing left to open.
-->
<div
  class="fixed inset-0 z-[98] flex justify-center bg-brand/30 px-4 pt-[12vh]"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose()
  }}
>
  <!-- tabindex, so that the window can take focus if the input field gives
       it up: keys are handled here, and they bubble up from whatever has
       focus. -->
  <div
    class="flex max-h-[70vh] w-full max-w-[560px] flex-col border border-line bg-raised shadow-pop focus:outline-none"
    role="dialog"
    aria-modal="true"
    aria-label={tr('room.ui.751')}
    tabindex="-1"
    onkeydown={onKeydown}
  >
    <div class="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
      <Icon name="search" size={14} class="shrink-0 text-faint" />
      <input
        bind:this={field}
        bind:value={query}
        class="min-w-0 flex-1 bg-transparent text-ui-lg text-ink placeholder:text-faint focus:outline-none"
        placeholder={tr('room.ui.752')}
        aria-label={tr('room.ui.753')}
        autocomplete="off"
        spellcheck="false"
      />
      <kbd class="shrink-0 border border-line px-1.5 py-0.5 font-mono text-micro text-muted">esc</kbd>
    </div>

    <div bind:this={listBox} class="min-h-0 flex-1 overflow-y-auto py-1">
      {#each shown as item, index (item.id)}
        {#if headings[index]}
          <p class="px-4 pb-1 pt-2.5 text-micro font-bold uppercase tracking-section text-muted">
            {headings[index]}
          </p>
        {/if}
        <!-- 36px: a row is picked with a finger on a tablet, with the console
             in the other hand, and 24px is the lower limit, not the target. -->
        <button
          type="button"
          data-row={item.id}
          class="flex h-9 w-full items-center gap-3 border-l-2 px-4 text-left
                 transition-colors duration-quick ease-out active:bg-line
                 {item.id === active?.id ? 'border-accent bg-surface' : 'border-transparent'}"
          onmousemove={() => (cursor = index)}
          onclick={() => choose(item)}
        >
          <span class="min-w-0 flex-1 truncate text-ui text-ink">{item.label}</span>
          {#if item.hint}
            <span class="shrink-0 font-mono text-2xs text-muted">{item.hint}</span>
          {/if}
        </button>
      {:else}
        <p class="px-4 py-6 text-center text-ui text-muted">{tr('room.ui.756')}</p>
      {/each}
    </div>
  </div>
</div>
