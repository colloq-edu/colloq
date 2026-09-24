<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * One ban menu for the whole room — and the window that confirms it.
   *
   * It is opened from two places: a right click on a row in the people list and
   * on the author of an entry in the oracle's thread. The menu, though, is one,
   * and it lives here, at the very top of the screen, not inside the panel it
   * was called from. That would have had to be done even without any talk of
   * consistency: both panels scroll and clip everything that pokes out past
   * their edge — a popup menu inside a 240-pixel-wide rail would be clipped
   * exactly when it was opened at the bottom row.
   *
   * Confirmation is mandatory, and it lists EVERYTHING that will happen. A ban
   * is the only punishment in the product, and it has a consequence nobody
   * would guess on their own: the person's questions leave the shared feed. So
   * the same place says how to bring them back, and also that the mark is held
   * by the browser. Promising a seal that does not exist costs more than
   * admitting that it is not there.
   */
  import { quintOut } from 'svelte/easing'
  import { tick } from 'svelte'
  import { fade, fly } from 'svelte/transition'
  import { api } from '@/lib/api'
  import { BAN_MENU_EVENT, banConsequences, bansChanged, type BanTarget } from '@/lib/bans'
  import { getSessionState } from '@/lib/session.svelte'
  import { prefersReducedMotion } from '@/lib/utils'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'

  const session = getSessionState()

  let target = $state<BanTarget | null>(null)
  /** The menu item was pressed — the confirmation window is on screen. */
  let asked = $state(false)
  let busy = $state(false)
  let errorRender = $state<() => string | null>(() => null)
  const error = $derived(errorRender())
  let opener = $state<HTMLElement | null>(null)
  let menuButton = $state<HTMLButtonElement | null>(null)
  let cancelButton = $state<HTMLButtonElement | null>(null)
  let dialog = $state<HTMLElement | null>(null)

  $effect(() => {
    const open = (event: Event) => {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      target = (event as CustomEvent<BanTarget>).detail
      asked = false
      busy = false
      errorRender = () => (null)
    }
    window.addEventListener(BAN_MENU_EVENT, open)
    return () => window.removeEventListener(BAN_MENU_EVENT, open)
  })

  // The opened layer gets the keyboard at once. In the confirmation the safe
  // action comes first: nothing irreversible will happen on the first Enter.
  $effect(() => {
    if (asked) (busy ? dialog : cancelButton)?.focus()
    else if (target) menuButton?.focus()
  })

  const MENU_W = 208
  const MENU_H = 44
  /**
   * The menu does not go past the window.
   *
   * A right click on the bottom row of the list is routine, and a menu that has
   * gone under the bottom edge looks like a click that did not work.
   */
  const at = $derived.by(() => {
    if (!target) return { x: 0, y: 0 }
    return {
      x: Math.max(8, Math.min(target.x, window.innerWidth - MENU_W - 8)),
      y: Math.max(8, Math.min(target.y, window.innerHeight - MENU_H - 8)),
    }
  })

  /**
   * Close — and only while there is still something to close.
   *
   * While the request is in flight, "Cancel" is dimmed: there is nothing left
   * to cancel, the server will set the ban. Escape and a click on the backdrop
   * still took the window away, though — the person saw that they had "changed
   * their mind", and a moment later the participant was removed; and a server
   * refusal landed as text in a window that was no longer on screen. The same
   * `busy` now holds those too: the only way out of the wait is its end.
   */
  function dismiss(): void {
    const back = opener
    target = null
    asked = false
    opener = null
    void tick().then(() => {
      if (back?.isConnected) back.focus()
    })
  }

  /** Same, for gestures: they do nothing while the request is in flight. */
  function close(): void {
    if (busy) return
    dismiss()
  }

  async function ban(): Promise<void> {
    const who = target
    if (!who || busy) return
    busy = true
    errorRender = () => (null)
    try {
      await api.ban(session.session.id, session.token, who.id)
      // The teacher's list re-reads itself: it is drawn in another panel, and
      // without this a fresh ban would show up in it only a minute later.
      bansChanged()
      // Not `close`: `busy` is cleared only in finally, and the gesture exit is
      // exactly what would not work from inside it.
      dismiss()
    } catch (cause) {
      errorRender = () => (cause instanceof Error ? tr(cause.message) : tr('room.ui.543'))
    } finally {
      busy = false
    }
  }

  /** The two confirmation buttons form one modal Tab cycle. */
  function trapDialogFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !dialog) return
    const controls = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const first = controls[0]
    const last = controls.at(-1)
    if (!first || !last) {
      event.preventDefault()
      dialog.focus()
      return
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && target) close()
  }}
/>

{#if target && !asked}
  <!-- The backdrop catches clicks outside the menu, as the rules console
       does. -->
  <!--
    The layer is above the council console. The menu is called from two places:
    from the people panel and from the console, and the console is an opaque
    wrapper at z-[95] (SessionScreen). While the menu lived at z-40/z-50, from
    the console it opened UNDER it: drawn, clickable and invisible — "Remove
    from class" silently did nothing. 96 is above the console and below the
    refusal window (97) and the "removed" overlays (100).
  -->
  <div class="fixed inset-0 z-[96]" role="presentation" onclick={close}></div>
  <!--
    Entry only, and the curve is the house one. Here and for the window below.

    `transition:` is two-way, and the exit animates along it too: Escape (see
    `svelte:window` above) took the menu away over 120 ms, even though the key
    is pressed precisely to GET RID of it. An action from the keyboard must not
    be animated — the same decision was taken for the drawers and the rules
    console in SessionScreen and is written down in words in admin/motion.css.
    `quintOut` = 1−(1−t)⁵ is the closest one in svelte/easing to `--ease-out`
    (index.css), which everything in this product moves with; `cubicOut` is
    noticeably softer and reads as foreign.
  -->
  <div
    class="fixed z-[96] border border-line bg-raised py-1 shadow-pop"
    style="left: {at.x}px; top: {at.y}px; width: {MENU_W}px"
    role="menu"
    aria-label={tr('room.ui.540')}
    in:fly={{ y: prefersReducedMotion() ? 0 : -4, duration: 120, easing: quintOut }}
  >
    <p class="truncate px-2.5 pb-1 pt-0.5 text-2xs font-bold uppercase tracking-label text-muted">
      {target.name}
    </p>
    <button
      bind:this={menuButton}
      role="menuitem"
      type="button"
      class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-ui text-danger
             transition-colors duration-100 hover:bg-danger/[0.08]
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
      onclick={() => (asked = true)}
    >
      <Icon name="lock" size={14} /> {tr('room.ui.541')} </button>
  </div>
{/if}

{#if target && asked}
  {@const who = target}
  <div
    class="fixed inset-0 z-[96] flex items-center justify-center bg-brand/40 p-6"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) close()
    }}
    in:fade={{ duration: 120 }}
  >
    <div
      bind:this={dialog}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="ban-title"
      onkeydown={trapDialogFocus}
      class="w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop"
      in:fly={{ y: prefersReducedMotion() ? 0 : -6, duration: 140, easing: quintOut }}
    >
      <h2 id="ban-title" class="text-title font-semibold text-ink">{tr('room.ui.78')}</h2>

      <!-- The name on its own line with the person's mark, not inside the
           heading: the people list has only names, no faces, and it is easy to
           hit the wrong row. -->
      <div class="mt-3 flex items-center gap-2.5 border border-line bg-surface px-3 py-2.5">
        <Avatar name={who.name} color={who.color} avatar={who.avatar} size="sm" />
        <span class="min-w-0 flex-1 truncate text-ui-lg font-semibold text-ink">{who.name}</span>
      </div>

      <ul class="mt-3 flex flex-col gap-1.5">
        {#each banConsequences(who.name) as line (line)}
          <li class="flex gap-2 text-ui leading-relaxed text-muted">
            <span class="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-faint" aria-hidden="true"></span>
            <span class="min-w-0">{line}</span>
          </li>
        {/each}
      </ul>

      {#if error}
        <p class="mt-3 text-ui text-danger" role="alert">{error}</p>
      {/if}

      <div class="mt-5 flex justify-end gap-2">
        <button
          bind:this={cancelButton}
          type="button"
          class="btn-outline"
          disabled={busy}
          onclick={close}
        > {tr('room.ui.29')} </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 active:brightness-95"
          disabled={busy}
          onclick={() => void ban()}
        >
          {#if busy}
            <Icon name="spinner" size={15} class="animate-spin" /> {tr('room.ui.542')} {:else}
            <Icon name="lock" size={15} /> {tr('room.ui.78')} {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
