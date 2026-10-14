<script lang="ts">
  /**
   * "Machines for submissions" on the Resources tab (Paper 16 · M1, and M7 on
   * a phone): the machines that run competition submissions for this server,
   * what each holds, whether it is ready for the competition the fleet is busy
   * with, and the owner's way to connect, trust, drain and disconnect them.
   *
   * The list is read again every few seconds while it is on screen. A
   * machine's state is its last heartbeat, and an "online" chip that stays up
   * for a minute after the VM was destroyed is the one lie this block could
   * tell. Everything it says is home's (shared/remote-admin.ts), worded by
   * admin/runners.ts; the component only lays it out.
   *
   * The two settings above the list (notebooks on this server, scores at
   * once) are the Resources form's own fields: its Save sends them with the
   * queue's half of the form. The form draws them into the `settings`
   * snippet, and this block reports what the server holds for them on every
   * read (`onsettings`), so the form measures its unsaved edits against the
   * server and not against a value from when the page opened.
   *
   * Owner-only, like every door behind it: a machine sees rivals' notebooks,
   * and who may connect one is the instance's business.
   */
  import { onMount, type Snippet } from 'svelte'
  import { tr } from '@shared/i18n'
  import type { RemoteMachine, RemoteMachinesResponse } from '@shared/remote-admin'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import ConnectMachine from '@/admin/ui/ConnectMachine.svelte'
  import EmptyState from '@/admin/ui/EmptyState.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import {
    PER_DEVICE_BOUNDS,
    PLACES_BOUNDS,
    cardsLine,
    clockTime,
    focusCompetition,
    heardLine,
    listOrder,
    machineGone,
    machineMenu,
    machinePagePath,
    machinePlaces,
    placesWords,
    readinessLine,
    resourcesLine,
    runnersApi,
    stateChip,
    summaryGauges,
    wholeOrAuto,
    type LineTone,
  } from '@/admin/runners'
  import { AdminApiError } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'

  interface Props {
    navigate: (path: string) => void
    /** The form's two fields, drawn between the numbers and the list. */
    settings?: Snippet
    /** What the server holds for those two fields, after every read. */
    onsettings?: (saved: { homeNotebooks: boolean; scoreSlots: number }) => void
    /** Bumped by the form after its Save: read the list again now. */
    reload?: number
  }

  let { navigate, settings, onsettings, reload = 0 }: Props = $props()

  /** One member per kind, so a branch on `kind` narrows to its own fields. */
  type Dialog =
    | { kind: 'places'; machine: RemoteMachine }
    | { kind: 'perDevice'; machine: RemoteMachine }
    | { kind: 'trust'; machine: RemoteMachine }
    | { kind: 'revoke'; machine: RemoteMachine }
    | { kind: 'revokeAll'; count: number }

  let data = $state<RemoteMachinesResponse | null>(null)
  let loadErrorText = $state<(() => string) | null>(null)
  const loadError = $derived(loadErrorText?.() ?? null)
  let now = $state(Date.now())
  let openMenu = $state<string | null>(null)
  let connecting = $state(false)
  let dialog = $state<Dialog | null>(null)
  let working = $state(false)
  let dialogErrorText = $state<(() => string) | null>(null)
  const dialogError = $derived(dialogErrorText?.() ?? null)
  /** The number typed in the places or runs-per-card dialog, and whether it was refused. */
  let fieldText = $state('')
  let fieldInvalid = $state(false)
  /** A failed menu action (drain, resume, untrust): said above the list, not in a dialog that is not open. */
  let actionErrorText = $state<(() => string) | null>(null)
  const actionError = $derived(actionErrorText?.() ?? null)
  let block = $state<HTMLElement | null>(null)

  const isOwner = $derived(adminAuth.isOwner)
  const machines = $derived(data ? listOrder(data.machines) : [])
  const live = $derived(machines.filter((machine) => !machineGone(machine.state)))
  const focus = $derived(data ? focusCompetition(data.machines) : null)
  const gauges = $derived(data ? summaryGauges(data.summary) : [])

  /** How a line's tone is painted (admin/runners.ts · LineTone). */
  const TONE: Record<LineTone, string> = {
    positive: 'text-positive',
    warning: 'text-warning',
    danger: 'text-danger',
    accent: 'text-accent-text',
    muted: 'text-muted',
    ink: 'text-ink',
  }

  function messageFor(cause: unknown): string {
    if (cause instanceof Error && cause.message) return cause.message
    return tr('admin.the.server.did.not.answer')
  }

  function reauthenticate(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
  }

  let loadedAt = 0
  let disposed = false

  async function load(): Promise<void> {
    loadedAt = Date.now()
    try {
      const fresh = await runnersApi.list()
      if (disposed) return
      data = fresh
      now = Date.now()
      loadErrorText = null
      onsettings?.({ homeNotebooks: fresh.homeNotebooks, scoreSlots: fresh.scoreSlots })
    } catch (cause: unknown) {
      reauthenticate(cause)
      // A list already on screen stays: one missed read is not worth an
      // error in its place, and the next tick reads again.
      if (!data) loadErrorText = () => messageFor(cause)
    }
  }

  $effect(() => {
    // After the form's Save: what it sent is now the server's.
    if (reload > 0) void load()
  })

  onMount(() => {
    void load()
    // Every ten seconds, and every three while the connect dialog waits for
    // a machine to join: that line is the only feedback the owner has that
    // the command they pasted on a VM worked.
    const refresh = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - loadedAt >= (connecting ? 3_000 : 10_000)) void load()
    }, 1_000)
    const tick = setInterval(() => (now = Date.now()), 1_000)
    const close = () => (openMenu = null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      openMenu = null
      if (!working) dialog = null
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)

    // Sent here from elsewhere: the editor's "Connect a machine", the
    // machine page's way back (admin/runners.ts · machinesListPath). The
    // query is read once and dropped, so a reload does not open the dialog
    // again.
    const asked = new URLSearchParams(location.search).get('machines')
    if (asked !== null) {
      history.replaceState(history.state, '', location.pathname + location.hash)
      requestAnimationFrame(() => block?.scrollIntoView({ block: 'start' }))
      if (asked === 'connect' && adminAuth.isOwner) connecting = true
    }

    return () => {
      disposed = true
      clearInterval(refresh)
      clearInterval(tick)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  })

  /* ------------------------------------------------------------- actions */

  function openPage(event: MouseEvent, id: string): void {
    // A middle click or a modifier is "new tab", and that is the browser's.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    navigate(machinePagePath(id))
  }

  function ask(next: Dialog): void {
    openMenu = null
    dialogErrorText = null
    fieldInvalid = false
    if (next.kind === 'places') fieldText = next.machine.places.approved === null ? '' : String(next.machine.places.approved)
    if (next.kind === 'perDevice') fieldText = next.machine.perDevice === null ? '' : String(next.machine.perDevice)
    dialog = next
  }

  /** Focus lands where the typing goes, as in the console's forms. */
  function takeFocus(node: HTMLElement): void {
    node.focus()
  }

  function closeDialog(): void {
    if (working) return
    dialog = null
    dialogErrorText = null
  }

  /** A menu item that acts at once: drain, resume, untrust. Reversible, so no question first. */
  async function act(what: () => Promise<void>): Promise<void> {
    openMenu = null
    actionErrorText = null
    try {
      await what()
      await load()
    } catch (cause: unknown) {
      reauthenticate(cause)
      actionErrorText = () => messageFor(cause)
    }
  }

  function toggleTrust(machine: RemoteMachine): void {
    // Trusting gives a rented machine the hidden test, so it is asked;
    // untrusting is the safe direction and purges it at once.
    if (machine.trusted) void act(() => runnersApi.update(machine.id, { trusted: false }))
    else ask({ kind: 'trust', machine })
  }

  async function confirm(): Promise<void> {
    const current = dialog
    if (!current || working) return
    let patch: (() => Promise<void>) | null = null
    if (current.kind === 'places' || current.kind === 'perDevice') {
      const bounds = current.kind === 'places' ? PLACES_BOUNDS : PER_DEVICE_BOUNDS
      const parsed = wholeOrAuto(fieldText, bounds.min, bounds.max)
      if ('error' in parsed) {
        fieldInvalid = true
        return
      }
      const id = current.machine.id
      patch =
        current.kind === 'places'
          ? () => runnersApi.update(id, { approvedSlots: parsed.value })
          : () => runnersApi.update(id, { perDevice: parsed.value })
    } else if (current.kind === 'trust') {
      const id = current.machine.id
      patch = () => runnersApi.update(id, { trusted: true })
    } else if (current.kind === 'revoke') {
      const id = current.machine.id
      patch = () => runnersApi.act(id, 'revoke')
    } else {
      patch = () => runnersApi.revokeAll()
    }
    working = true
    dialogErrorText = null
    try {
      await patch()
      dialog = null
      await load()
    } catch (cause: unknown) {
      reauthenticate(cause)
      dialogErrorText = () => messageFor(cause)
    } finally {
      working = false
    }
  }
</script>

{#snippet trustedMark()}
  <Badge word={tr('admin.runners.trusted')} tone="accent" form="outline" />
{/snippet}

<div class="rn" bind:this={block}>
  {#if !isOwner}
    <!-- The doors behind this block answer the owner only. -->
    <p class="text-ui text-muted">{tr('admin.runners.ownerOnly')}</p>
  {:else if loadError && !data}
    <p class="text-ui text-danger" role="alert">{tr('admin.runners.loadFailed')} {loadError}</p>
    <button type="button" class="btn-outline mt-3" onclick={() => void load()}>{tr('admin.try.again')}</button>
  {:else if !data}
    <p class="text-ui text-muted">{tr('admin.runners.loading')}</p>
  {:else}
    {#if data.banner}
      {@const banner = data.banner}
      <!-- Home drained a machine by itself (3 losses or 5 declines within
           half an hour): said until the owner opens its page. -->
      <div class="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-l-[3px] border-danger bg-danger/[0.06] px-4 py-3" role="status">
        <Icon name="alert" size={15} class="shrink-0 text-danger" />
        <p class="min-w-0 flex-1 basis-[240px] text-2xs text-ink">
          {tr('admin.runners.banner', { name: banner.name, time: clockTime(banner.at, now) })}
        </p>
        <a
          class="btn-outline shrink-0"
          href={machinePagePath(banner.machineId)}
          onclick={(event) => openPage(event, banner.machineId)}
        >
          {tr('admin.runners.bannerOpen')}
        </a>
      </div>
    {/if}

    {#if machines.length > 0}
      <!-- The three numbers the fleet is read by, and the way to grow it.
           Not with no machine at all: three zeros say less than the empty
           state below, which carries the same button. -->
      <div class="mb-5 flex flex-wrap items-center gap-x-7 gap-y-3">
        {#each gauges as gauge, index (index)}
          <div class="flex items-baseline gap-2">
            <span class="font-mono text-gauge font-bold text-ink">{gauge.value}</span>
            <span class="text-2xs text-muted">{gauge.label}</span>
          </div>
        {/each}
        <button
          type="button"
          class="btn-primary ml-auto shrink-0 max-[640px]:ml-0 max-[640px]:w-full"
          onclick={() => (connecting = true)}
        >
          <Icon name="plus" size={14} />
          {tr('admin.runners.connect')}
        </button>
      </div>
    {/if}

    {#if settings}
      {@render settings()}
    {/if}

    {#if !data.homeNotebooks && data.summary.online === 0}
      <!-- This server runs no notebooks and no machine answers: every
           submission waits, and the console says so row by row. Said here,
           where the switch is. -->
      <p class="mt-3 flex items-start gap-2 text-2xs font-semibold text-warning" role="status">
        <Icon name="alert" size={14} class="mt-0.5 shrink-0" />
        <span>{tr('admin.runners.nobodyRuns')}</span>
      </p>
    {/if}

    {#if actionError}
      <p class="mt-4 text-ui text-danger" role="alert">{actionError}</p>
    {/if}

    {#if machines.length === 0}
      <div class="mt-5 border border-dashed border-line">
        <EmptyState title={tr('admin.runners.empty.title')} hint={tr('admin.runners.empty.hint')}>
          <button type="button" class="btn-primary" onclick={() => (connecting = true)}>
            {tr('admin.runners.connect')}
          </button>
        </EmptyState>
      </div>
    {:else}
      <div class="rn-list mt-5">
        <div class="rn-head" aria-hidden="true">
          <span class="admin-label">{tr('admin.runners.col.state')}</span>
          <span class="admin-label">{tr('admin.runners.col.machine')}</span>
          <span class="admin-label">{tr('admin.runners.col.resources')}</span>
          <span class="admin-label">{tr('admin.runners.col.places')}</span>
          <span class="admin-label min-w-0 truncate">
            {focus ? tr('admin.runners.col.readinessOf', { title: focus.title }) : tr('admin.runners.col.readiness')}
          </span>
          <span></span>
        </div>

        {#each machines as machine (machine.id)}
          {@const chip = stateChip(machine.state, machine.silentSince, now)}
          {@const places = machinePlaces(machine.places)}
          {@const ready = readinessLine(machine, focus, data.home.version)}
          {@const menu = machineMenu(machine)}
          {@const gone = machineGone(machine.state)}
          <div class={cn('rn-row', gone && 'rn-gone')}>
            <div class="rn-state flex min-w-0 flex-col items-start gap-1">
              <span class="flex flex-wrap items-center gap-1.5">
                <Badge word={chip.word} tone={chip.tone} />
                <!-- On a card the trusted mark rides with the chip (M7). -->
                <span class="rn-card-only">{#if machine.trusted}{@render trustedMark()}{/if}</span>
              </span>
              <span class="text-micro text-muted">{heardLine(machine, now)}</span>
            </div>

            <div class="rn-name min-w-0">
              <p class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  class="min-w-0 truncate font-mono text-ui font-bold text-ink hover:underline max-[640px]:min-h-11 max-[640px]:leading-[44px]"
                  href={machinePagePath(machine.id)}
                  onclick={(event) => openPage(event, machine.id)}
                >{machine.name}</a>
                <span class="rn-row-only">{#if machine.trusted}{@render trustedMark()}{/if}</span>
              </p>
              <p class="mt-0.5 truncate font-mono text-micro text-muted">
                {[machine.address, machine.version].filter(Boolean).join(' · ') || '—'}
              </p>
            </div>

            <div class="rn-res min-w-0">
              <p class="text-2xs text-ink">{resourcesLine(machine.facts)}</p>
              <p class={cn('mt-0.5 text-micro', machine.cards.length > 0 ? 'font-semibold text-accent-text' : 'text-muted')}>
                {cardsLine(machine.cards)}
              </p>
            </div>

            <div class="rn-places flex min-w-0 flex-col gap-1.5">
              <span class="whitespace-nowrap font-mono text-2xs text-ink">{placesWords(places)}</span>
              <div class="h-1 bg-raised" aria-hidden="true">
                <div class="h-full bg-accent" style:width="{(places.share * 100).toFixed(1)}%"></div>
              </div>
            </div>

            <div class="rn-ready min-w-0">
              <p class={cn('break-words text-2xs', TONE[ready.tone])}>
                {#if focus}<span class="rn-card-only font-semibold">{tr('admin.runners.readyFor', { title: focus.title })}</span>{/if}
                {ready.lead}
              </p>
              {#if ready.detail}
                <p class="mt-0.5 break-words text-micro text-muted">{ready.detail}</p>
              {/if}
            </div>

            <div class="rn-act relative flex justify-end">
              {#if !gone}
                <button
                  type="button"
                  class="rn-more admin-icon-btn"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === machine.id}
                  aria-label={tr('admin.runners.menu.label', { name: machine.name })}
                  onclick={(event) => {
                    event.stopPropagation()
                    openMenu = openMenu === machine.id ? null : machine.id
                  }}
                >
                  <Icon name="more" size={15} />
                </button>
                {#if openMenu === machine.id}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div
                    role="menu"
                    tabindex="-1"
                    class="row-menu admin-menu absolute right-0 top-full z-20 mt-1 w-[260px]"
                    onclick={(event) => event.stopPropagation()}
                  >
                    <a
                      role="menuitem"
                      class="admin-menu-item"
                      href={machinePagePath(machine.id)}
                      onclick={(event) => {
                        openMenu = null
                        openPage(event, machine.id)
                      }}
                    >
                      {tr('admin.runners.menu.open')}
                    </a>
                    {#if menu.places}
                      <button
                        type="button"
                        role="menuitem"
                        class="admin-menu-item"
                        onclick={() => ask({ kind: 'places', machine })}
                      >
                        {tr('admin.runners.menu.places')}
                      </button>
                    {/if}
                    {#if menu.perDevice}
                      <button
                        type="button"
                        role="menuitem"
                        class="admin-menu-item"
                        onclick={() => ask({ kind: 'perDevice', machine })}
                      >
                        {tr('admin.runners.menu.perDevice')}
                      </button>
                    {/if}
                    {#if menu.trust}
                      <button
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={machine.trusted}
                        class="admin-menu-item flex items-center justify-between gap-3"
                        onclick={() => toggleTrust(machine)}
                      >
                        {tr('admin.runners.menu.trust')}
                        {#if machine.trusted}<Icon name="check" size={14} class="shrink-0 text-accent-text" />{/if}
                      </button>
                    {/if}
                    {#if menu.drain}
                      <button type="button" role="menuitem" class="admin-menu-item" onclick={() => void act(() => runnersApi.act(machine.id, 'drain'))}>
                        {tr('admin.runners.menu.drain')}
                      </button>
                    {/if}
                    {#if menu.resume}
                      <button type="button" role="menuitem" class="admin-menu-item" onclick={() => void act(() => runnersApi.act(machine.id, 'resume'))}>
                        {tr('admin.runners.menu.resume')}
                      </button>
                    {/if}
                    {#if menu.revoke}
                      <div class="admin-menu-sep" role="separator"></div>
                      <button type="button" role="menuitem" class="admin-menu-item text-danger" onclick={() => ask({ kind: 'revoke', machine })}>
                        {tr('admin.runners.menu.revoke')}
                      </button>
                    {/if}
                  </div>
                {/if}
              {/if}
            </div>
          </div>
        {/each}
      </div>

      {#if live.length > 0}
        <div class="flex justify-end pt-3">
          <button type="button" class="btn-danger max-[640px]:w-full" onclick={() => ask({ kind: 'revokeAll', count: live.length })}>
            {tr('admin.runners.revokeAll')}
          </button>
        </div>
      {/if}
    {/if}

    <div class="mt-5 flex items-start gap-2.5 bg-surface px-4 py-3.5">
      <Icon name="info" size={16} class="mt-px shrink-0 text-muted" />
      <p class="text-2xs text-muted">{tr('admin.runners.footnote')}</p>
    </div>
  {/if}
</div>

{#if connecting && data}
  <ConnectMachine machines={data.machines} onclose={() => (connecting = false)} />
{/if}

{#if dialog}
  {@const current = dialog}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="runners-dialog-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6 max-[640px]:p-4"
  >
    <div class="dialog-card w-full max-w-[460px] border border-line bg-canvas p-5 shadow-pop">
      {#if current.kind === 'places' || current.kind === 'perDevice'}
        {@const placesKind = current.kind === 'places'}
        {@const bounds = placesKind ? PLACES_BOUNDS : PER_DEVICE_BOUNDS}
        <form
          onsubmit={(event) => {
            event.preventDefault()
            void confirm()
          }}
        >
          <h2 id="runners-dialog-title" class="break-words text-title font-semibold text-ink">
            {placesKind
              ? tr('admin.runners.places.title', { name: current.machine.name })
              : tr('admin.runners.perDevice.title', { name: current.machine.name })}
          </h2>
          <p class="mt-2 text-ui leading-relaxed text-muted">
            {placesKind ? tr('admin.runners.places.body') : tr('admin.runners.perDevice.body')}
          </p>
          <label class="mt-4 block">
            <span class="admin-label mb-1.5 block">{placesKind ? tr('admin.runners.places.field') : tr('admin.runners.perDevice.field')}</span>
            <span class={cn('admin-affix w-[260px] max-w-full gap-2', fieldInvalid && '!border-danger')}>
              <input
                use:takeFocus
                bind:value={fieldText}
                oninput={() => (fieldInvalid = false)}
                aria-invalid={fieldInvalid}
                class="placeholder:font-sans"
                inputmode="numeric"
                autocomplete="off"
                placeholder={placesKind
                  ? tr('admin.runners.places.autoNow', { count: current.machine.places.offered })
                  : tr('admin.runners.perDevice.inherit')}
              />
              <span class="shrink-0 text-2xs text-muted">
                {tr('admin.resourcesTab.gpuPerDeviceUnit', { min: bounds.min, max: bounds.max })}
              </span>
            </span>
          </label>
          {#if fieldInvalid}
            <p class="mt-2 text-2xs text-danger" role="alert">
              {tr('admin.runners.places.invalid', { min: bounds.min, max: bounds.max })}
            </p>
          {/if}
          {#if dialogError}
            <p class="mt-3 text-ui text-danger" role="alert">{dialogError}</p>
          {/if}
          <div class="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" class="btn-outline" disabled={working} onclick={closeDialog}>{tr('admin.cancel')}</button>
            <button type="submit" class="btn-primary" disabled={working}>{tr('admin.save')}</button>
          </div>
        </form>
      {:else}
        <h2 id="runners-dialog-title" class="break-words text-title font-semibold text-ink">
          {current.kind === 'trust'
            ? tr('admin.runners.trust.title', { name: current.machine.name })
            : current.kind === 'revoke'
              ? tr('admin.runners.revoke.title', { name: current.machine.name })
              : tr('admin.runners.revokeAll.title', { count: current.count })}
        </h2>
        <p class="mt-2 text-ui leading-relaxed text-muted">
          {current.kind === 'trust'
            ? tr('admin.runners.trust.body')
            : current.kind === 'revoke'
              ? tr('admin.runners.revoke.body')
              : tr('admin.runners.revokeAll.body')}
        </p>
        {#if dialogError}
          <p class="mt-3 text-ui text-danger" role="alert">{dialogError}</p>
        {/if}
        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" class="btn-outline" disabled={working} onclick={closeDialog}>{tr('admin.cancel')}</button>
          {#if current.kind === 'trust'}
            <button type="button" class="btn-primary" disabled={working} onclick={() => void confirm()}>
              {working ? tr('admin.runners.working') : tr('admin.runners.trust.confirm')}
            </button>
          {:else}
            <button type="button" class="btn-danger-solid" disabled={working} onclick={() => void confirm()}>
              {working ? tr('admin.runners.working') : tr('admin.runners.revoke.confirm')}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /*
   * One markup, two drawings, switched by the width of the list itself (as
   * RunningKernels and the competitions list do): the panel's rail is 236 px
   * on a desktop and 56 on a phone, so a window width would measure the wrong
   * box. From 780 px the row is the M1 table — state, machine, resources,
   * places, readiness, menu; below it a machine is the M7 card: the chip
   * with the trusted mark and the menu on top, the name, what it has, the
   * places bar, and the readiness with the competition's name in front.
   */
  .rn {
    container-type: inline-size;
  }

  .rn-list {
    border-top: 2px solid rgb(var(--ink));
  }

  .rn-head {
    display: none;
  }

  .rn-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'state act'
      'name name'
      'res res'
      'places places'
      'ready ready';
    column-gap: 12px;
    row-gap: 10px;
    padding: 16px 0;
    border-bottom: 1px solid rgb(var(--line));
  }

  /* A disconnected machine stays listed for its history, quieter than the rest. */
  .rn-gone {
    opacity: 0.6;
  }

  .rn-state {
    grid-area: state;
  }

  .rn-name {
    grid-area: name;
  }

  .rn-res {
    grid-area: res;
  }

  .rn-places {
    grid-area: places;
    max-width: 460px;
  }

  .rn-ready {
    grid-area: ready;
  }

  .rn-act {
    grid-area: act;
  }

  /* On a card the menu is a framed 44 px square (M7). */
  .rn-more {
    border: 1px solid rgb(var(--line));
  }

  .rn-row-only {
    display: none;
  }

  .rn-card-only {
    display: inline;
  }

  @container (min-width: 780px) {
    .rn-head,
    .rn-row {
      display: grid;
      grid-template-columns: 136px minmax(0, 1.1fr) 150px 92px minmax(0, 1.6fr) 40px;
      grid-template-areas: 'state name res places ready act';
      column-gap: 12px;
      row-gap: 0;
    }

    .rn-head {
      align-items: center;
      height: 38px;
      border-bottom: 1px solid rgb(var(--line));
    }

    .rn-row {
      align-items: start;
      padding: 12px 0;
    }

    .rn-places {
      max-width: none;
    }

    .rn-more {
      border: 0;
    }

    .rn-row-only {
      display: inline;
    }

    .rn-card-only {
      display: none;
    }
  }
</style>
