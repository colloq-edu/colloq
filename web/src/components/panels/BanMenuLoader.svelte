<script lang="ts">
  import { tr } from '@shared/i18n'
  import { BAN_MENU_EVENT, type BanTarget } from '@/lib/bans'
  import Lazy from '@/components/ui/Lazy.svelte'

  // The listener is part of the room, even while the optional menu is still
  // downloading. Keep the first gesture and its focus target until it arrives.
  let request = $state<{ target: BanTarget; opener: HTMLElement | null } | null>(null)
  let ready = $state(false)
  let overlay = $state<HTMLDivElement | null>(null)
  let cancelButton = $state<HTMLButtonElement | null>(null)
  const loadBanMenu = () => import('./BanMenu.svelte')

  $effect(() => {
    const open = (event: Event) => {
      if (!request) ready = false
      request = {
        target: (event as CustomEvent<BanTarget>).detail,
        opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      }
    }
    window.addEventListener(BAN_MENU_EVENT, open)
    return () => window.removeEventListener(BAN_MENU_EVENT, open)
  })

  $effect(() => {
    if (request && !ready) cancelButton?.focus()
  })

  function cancelLoading(): void {
    const back = request?.opener
    request = null
    if (back?.isConnected) back.focus()
  }

  // Retry removes its own focused button. Every new loading view moves focus
  // back to the persistent Cancel before the module succeeds or fails again.
  function focusCancel(_node: HTMLElement): void {
    cancelButton?.focus()
  }

  function pendingKeys(event: KeyboardEvent): void {
    if (ready || event.key !== 'Tab' || !overlay) return
    const controls = [...overlay.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const first = controls[0]
    const last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
</script>

<svelte:window onkeydown={(event) => {
  // Once mounted, the menu owns Escape and its in-flight ban guard.
  if (event.key === 'Escape' && request && !ready) cancelLoading()
}} />

{#if request}
  {@const current = request}
  <!-- Loading and recovery occupy the same overlay tier as the menu. They
       never insert a content-pane splash into the room's normal layout. -->
  <div
    bind:this={overlay}
    role={ready ? 'presentation' : 'dialog'}
    aria-modal={ready ? undefined : true}
    aria-label={ready ? undefined : tr('room.ui.540')}
    onkeydown={pendingKeys}
    class="fixed inset-0 z-[96] flex flex-col items-center gap-4 overflow-y-auto p-6 {ready ? '' : 'bg-brand/40'}"
  >
    <div class="my-auto shrink-0 {ready ? '' : 'w-full max-w-xl border border-line bg-canvas p-5 shadow-pop'}">
      <Lazy load={loadBanMenu}>
        {#snippet loading()}
          <div use:focusCancel class="flex justify-center py-5" role="status" aria-busy="true">
            <span>{tr('common.loading')}</span>
          </div>
        {/snippet}
        {#snippet children(BanMenu)}
          <BanMenu request={current} onready={() => (ready = true)} onclose={() => (request = null)} />
        {/snippet}
      </Lazy>
      {#if !ready}
        <!-- Keep a focused way out after a failed import as well as during it. -->
        <div class="flex justify-end">
          <button bind:this={cancelButton} class="btn-outline" type="button" onclick={cancelLoading}>{tr('room.ui.29')}</button>
        </div>
      {/if}
    </div>
  </div>
{/if}
