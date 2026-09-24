<script lang="ts" module>
  import type { IconName } from '@/components/ui/Icon.svelte'

  /**
   * One menu item.
   *
   * `gap` is a divider BEFORE the item, not a separate entry in the list: a
   * list with two kinds of elements would have to be taken apart on every
   * render, and the very first "remove this item because of permissions" would
   * leave a line hanging with nothing after it.
   *
   * `why` is not decoration. A dimmed item without a reason reads as a
   * breakage, and this is exactly the place where the room has to say that a
   * rule stopped it, not the button (see lib/may.ts). The reason is not hidden
   * in `title`, though: under a pointer it can be seen, but with a finger
   * never, and on a phone a dimmed item would stay mute. That is why the
   * reasons are gathered into a line under the menu.
   */
  export interface ContextMenuItem {
    /** A line before the item: the start of a new group. */
    gap?: boolean
    label: string
    icon?: IconName
    /** Key shortcut on the right — quiet, like a caption, not like a button. */
    keys?: string
    danger?: boolean
    disabled?: boolean
    /** Why not. Shown as a line under the menu, and also in `title`. */
    why?: string
    run: () => void
  }
</script>

<script lang="ts">
  /**
   * A menu that pops up at a point — shared by the whole room.
   *
   * `position: fixed` and a computed point, not `absolute` inside the row. All
   * the places this menu is called from sit in scrolling strips, and by the
   * spec `overflow` clips vertically too: a menu opened at the bottom row of a
   * 240-pixel-wide panel would be cut off exactly where people are looking at
   * it. The same technique, for the same reason, as the ban menu
   * (panels/BanMenu.svelte) and the access menu on the tab
   * (reader/TabStrip.svelte).
   *
   * The size is not set by a constant, as in those two: the set of items here
   * depends on what was clicked, and an "approximate height" would part ways
   * with the truth at the first item hidden by permissions. The real box is
   * measured — once, right after the menu appears and before anyone gets to see
   * it: the entrance starts from transparency, and the correction for the
   * window edge fits into the very first frame.
   *
   * ON A FINGER the menu is not a popover but a bottom sheet. A popover at a
   * finger is covered by the finger itself, lands where the person held their
   * hand, and demands 28-pixel targets; a sheet arrives from below, takes the
   * full width and gives 44-pixel rows. The signal is
   * `(hover: none) and (pointer: coarse)`, the same one that
   * `hoverOnlyWhenSupported` in tailwind.config.js uses to switch off the
   * `hover:` utilities.
   *
   * Animation is on entry only. The menu is dismissed with a key (Escape) and
   * with a click outside, and a response to a key must not be animated: the
   * same decision was taken for the drawers, the rules console and both
   * neighbouring menus.
   */
  import { tr } from '@shared/i18n'
  import { tick } from 'svelte'
  import { quintOut } from 'svelte/easing'
  import { fly } from 'svelte/transition'
  import Icon from '@/components/ui/Icon.svelte'
  import { prefersReducedMotion } from '@/lib/utils'

  interface Props {
    /** Where it was clicked, in window coordinates; `null`: menu closed. */
    at: { x: number; y: number } | null
    /** How this menu is labelled for a screen reader. */
    label: string
    /** Header line: what was clicked. A file name, for example. */
    title?: string | null
    items: ContextMenuItem[]
    /**
     * Where to return focus. The menu is fully keyboard-navigable, and leaving
     * it has to return to where one came in from — otherwise Escape drops focus
     * to the start of the page, and the file list has to be tabbed through all
     * over again.
     */
    opener?: HTMLElement | null
    onclose: () => void
  }

  let { at, label, title = null, items, opener = null, onclose }: Props = $props()

  let box = $state<HTMLElement | null>(null)
  /**
   * Where the menu actually landed.
   *
   * First it is just the click point, then the same point pressed against the
   * window edges according to the measured box. A right click on the bottom row
   * is routine, and a menu that has gone under the edge looks like a click that
   * did not work.
   */
  let place = $state({ x: 0, y: 0 })

  /**
   * This is a finger, not a pointer.
   *
   * The question is asked about the input DEVICE, not about the window width: a
   * narrow window on a laptop is still a mouse, and a bottom sheet there would
   * be a whim. The answer is read afresh on every opening and listens for
   * changes (a tablet with a mouse attached answers differently from one minute
   * to the next).
   */
  let coarse = $state(false)

  $effect(() => {
    const media = window.matchMedia('(hover: none) and (pointer: coarse)')
    coarse = media.matches
    const again = (): void => {
      coarse = media.matches
    }
    media.addEventListener('change', again)
    return () => media.removeEventListener('change', again)
  })

  $effect(() => {
    const point = at
    const element = box
    if (!point || !element || coarse) return
    const rect = element.getBoundingClientRect()
    place = {
      x: Math.max(8, Math.min(point.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(point.y, window.innerHeight - rect.height - 8)),
    }
  })

  /* An open menu takes the keyboard at once — and first takes an item that CAN
     be chosen: focus on a dimmed one would mean a menu the keyboard cannot move
     forward out of. The same technique as in the access menu. */
  $effect(() => {
    if (!at) return
    void tick().then(() => live()[0]?.focus())
  })

  /**
   * Why some items are dimmed — in words, and under the menu itself.
   *
   * Not in each item's `title`: under a pointer a tooltip takes a second to
   * appear, and with a finger it is never seen. The reason is usually one for
   * the whole menu ("only the teacher renames and deletes"), so repeating it on
   * every item would mean writing the same thing three times in a list of eight
   * rows. Two is the ceiling: beyond that it is no longer a caption but a
   * paragraph.
   */
  const reasons = $derived.by(() => {
    const out: string[] = []
    for (const item of items) {
      if (!item.disabled || !item.why || out.includes(item.why)) continue
      out.push(item.why)
      if (out.length === 2) break
    }
    return out
  })

  /**
   * Close — and return focus. One door for every exit: Escape, a click outside,
   * scrolling, a chosen item.
   */
  function close(): void {
    const back = opener
    onclose()
    void tick().then(() => {
      if (back?.isConnected) back.focus()
    })
  }

  function choose(item: ContextMenuItem): void {
    if (item.disabled) return
    // Close first, then act: half of the items open an input line or a
    // confirmation in the same panel, and a menu on top of them is an extra
    // layer between the person and what they have just asked for. Focus returns
    // to the row meanwhile, and the action carries it further on its own.
    close()
    item.run()
  }

  /** Items that can be chosen — in render order. */
  function live(): HTMLButtonElement[] {
    if (!box) return []
    return [...box.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')]
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // The consumed key is marked: the room closes the terminal drawer with
      // the same Escape, and "dismissed the menu" is exactly the case it was
      // needed for.
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Tab') {
      // There is deliberately no Tab cycle inside the menu: the menu is not a
      // window, leaving it with Tab is natural, and a focus trap in a list of
      // eight rows only locks in whoever hit the wrong key.
      event.preventDefault()
      close()
      return
    }
    const list = live()
    if (list.length === 0) return
    const now = list.indexOf(document.activeElement as HTMLButtonElement)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = now < 0 ? 0 : (now + 1) % list.length
    else if (event.key === 'ArrowUp') {
      next = now < 0 ? list.length - 1 : (now - 1 + list.length) % list.length
    } else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = list.length - 1
    if (next === null) return
    event.preventDefault()
    list[next].focus()
  }

  /*
   * The menu closes from outside: a click outside, scrolling, a window resize,
   * leaving the tab. The listeners live exactly as long as the menu is open —
   * following the access menu — so that no extra handlers hang on the window
   * for the whole class.
   *
   * Scrolling is caught in the capture phase: the strip holding the row that
   * called the menu scrolls on its own, while the menu is pinned to the
   * window — it would stay hanging over a file that is no longer under it. The
   * bottom sheet survives scrolling: it is not tied to any point, and there is
   * a backdrop under it anyway.
   */
  $effect(() => {
    if (!at) return
    const away = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-context-menu]')) return
      // The button that opened the menu closes it itself on a second press:
      // without this, the backdrop managed to close the menu first, and the
      // button immediately opened it again.
      if (target?.closest('[data-menu-button]')) return
      close()
    }
    const scrolled = (): void => {
      if (!coarse) close()
    }
    const resized = (): void => close()
    const hidden = (): void => {
      if (document.visibilityState === 'hidden') close()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', resized)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('scroll', scrolled, true)
      window.removeEventListener('resize', resized)
      document.removeEventListener('visibilitychange', hidden)
    }
  })
</script>

{#snippet rows(sheet: boolean)}
  {#each items as item, index (item.label)}
    {#if item.gap && index > 0}
      <span class="my-1 block h-px bg-line" aria-hidden="true"></span>
    {/if}
    <button
      role="menuitem"
      type="button"
      disabled={item.disabled}
      title={item.disabled ? (item.why ?? undefined) : undefined}
      class="flex w-full items-center text-left transition-colors duration-100
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
             disabled:pointer-events-none disabled:opacity-45
             {sheet ? 'h-11 gap-3 px-4 text-ui-lg' : 'h-7 gap-2 px-2.5 text-ui'}
             {item.danger
        ? 'text-danger hover:bg-danger/[0.08] focus-visible:ring-danger/40'
        : 'text-ink hover:bg-raised focus-visible:ring-accent/40'}"
      onclick={() => choose(item)}
    >
      {#if item.icon}
        <!-- The icon sits in a fixed-width slot: without it, the labels in rows
             that have no icon would fall out of line. -->
        <span class="flex shrink-0 items-center justify-center {sheet ? 'w-4' : 'w-[13px]'}">
          <Icon name={item.icon} size={sheet ? 16 : 13} />
        </span>
      {/if}
      <span class="min-w-0 flex-1 truncate">{item.label}</span>
      {#if item.keys && !sheet}
        <span class="shrink-0 font-mono text-micro text-faint">{item.keys}</span>
      {/if}
    </button>
  {/each}
{/snippet}

{#snippet why()}
  {#if reasons.length > 0}
    <!-- The reason is one for the whole menu and sits under it: see `reasons`.
         The strip is separated by a line and filled with surface so that it
         does not read as one more item that can be clicked. -->
    <div data-menu-why class="mt-1 border-t border-line bg-surface px-2.5 py-2">
      {#each reasons as reason (reason)}
        <p class="text-2xs leading-snug text-muted">{reason}</p>
      {/each}
    </div>
  {/if}
{/snippet}

{#if at && coarse}
  <!--
    Finger: a full-width bottom sheet. The same layer as the popover below.
  -->
  <div class="fixed inset-0 z-[60]" role="presentation">
    <!--
      The backdrop listens to nothing itself, and that is not an oversight. The
      sheet opens on a LONG press: by that second the finger is already resting
      on the screen, and the browser delivers its lift-off as a `click` — to
      whatever turned out to be under the finger, that is, to the backdrop. A
      button on it would close the sheet at the very moment it was opened. A
      click outside is caught by the shared `pointerdown` listener (see the
      effect above): it fires on a NEW touch, not at the end of the previous
      one.
    -->
    <div class="absolute inset-0 bg-canvas/70" aria-hidden="true"></div>
    <div
      bind:this={box}
      data-context-menu
      role="menu"
      tabindex="-1"
      aria-label={label}
      class="absolute inset-x-0 bottom-0 flex flex-col border-t border-line bg-canvas
             pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-pop"
      {onkeydown}
      in:fly={{ y: prefersReducedMotion() ? 0 : 20, duration: 160, easing: quintOut }}
    >
      {#if title}
        <div class="flex h-11 items-center gap-2 border-b border-line pl-4 pr-1">
          <p class="min-w-0 flex-1 truncate text-2xs font-bold uppercase tracking-label text-muted">
            {title}
          </p>
          <!-- A way out that can be seen. The backdrop closes the sheet anyway,
               but on a phone "tap outside" is knowledge, not a hint. -->
          <button
            type="button"
            class="flex h-11 w-11 shrink-0 items-center justify-center text-muted
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
                   focus-visible:ring-accent/40"
            aria-label={tr('room.files.menu.close')}
            onclick={close}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      {/if}
      <div class="flex flex-col py-1">{@render rows(true)}</div>
      {@render why()}
    </div>
  </div>
{:else if at}
  <!--
    The layer is the same as that of the access menu on the notebook tab
    (z-[60]): above the room's drawers (z-40) and the rules console (z-50),
    below the ban menu (z-[96]), the refusal window (z-[97]) and the "you have
    been removed" overlays (z-[100]). The order matters both ways: under a
    drawer the menu would be drawn, clickable and invisible, and on top of the
    refusal window it would cover the only thing that matters at that minute.
  -->
  <div
    bind:this={box}
    data-context-menu
    role="menu"
    tabindex="-1"
    aria-label={label}
    class="fixed z-[60] w-60 border border-line bg-canvas pt-1 shadow-pop
           {reasons.length > 0 ? '' : 'pb-1'}"
    style={`left:${place.x}px; top:${place.y}px`}
    {onkeydown}
    in:fly={{ y: prefersReducedMotion() ? 0 : -4, duration: 120, easing: quintOut }}
  >
    <div class="px-1">
      {#if title}
        <!-- The name of what was clicked — as in the ban menu and the access
             menu. The menu lands on top of the list and covers the neighbouring
             rows: without the name inside, it is easy to believe you are
             deleting something other than what you aimed at. -->
        <p
          class="truncate px-2.5 pb-1 pt-0.5 text-2xs font-bold uppercase tracking-label text-muted"
        >
          {title}
        </p>
      {/if}
      <div class="flex flex-col">{@render rows(false)}</div>
    </div>
    {@render why()}
  </div>
{/if}
