<script lang="ts">
  /**
   * "Connect a machine" (Paper 16 · M2): how many machines, how long the code
   * lives, their places, and whether they get the hidden test (off unless the
   * owner says so, decision 1). Then the code, shown this once, inside the
   * three commands the server filled in with its own address and release
   * (MintRemoteCodeResponse.commands): the owner copies a command, never a
   * bare code, and a command copied is a machine joined.
   *
   * Under the commands a live line names the machines as they join, read
   * from the list the Resources block keeps polling (every three seconds
   * while this is open). How many joined is this code's own count: the
   * machines the server says came with it (RemoteMachine.codeId), or its
   * uses as the list's codes count them — a machine new since the code was
   * shown may have come with another code. The code is never kept here, and
   * closing the window only hides it: it stays valid until it expires, is
   * used up, or the owner cancels it in the list of codes.
   *
   * Take classes (Paper 18 · Z2, D2): the code's machines take classes
   * from the start, and the block says what that hands them — students'
   * code, data, files and personal notebooks. The hidden test is greyed
   * while it is on, with the reason (D3), and the other way round.
   */
  import { onMount } from 'svelte'
  import { tr } from '@shared/i18n'
  import type { MintRemoteCodeResponse, RemoteCodeView, RemoteMachine } from '@shared/remote-admin'
  import Check from '@/admin/ui/Check.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import {
    HOURS_BOUNDS,
    MACHINES_BOUNDS,
    connectDefaults,
    connectProgress,
    joinCommands,
    mintRequest,
    runnersApi,
    type ConnectForm,
  } from '@/admin/runners'
  import { AdminApiError } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { cn } from '@/lib/utils'

  interface Props {
    /** The list as the Resources block last read it. */
    machines: RemoteMachine[]
    /** The codes still valid, from the same read: this code's own count of joins. */
    codes: RemoteCodeView[]
    onclose: () => void
  }

  let { machines, codes, onclose }: Props = $props()

  let form = $state<ConnectForm>(connectDefaults())
  let minted = $state<MintRemoteCodeResponse | null>(null)
  /** The machines the list had when the code was shown: the newcomers since are named when the code's count says they are all its own. */
  let known = $state<ReadonlySet<string>>(new Set())
  /** The list has shown this code at least once: from then on its absence before expiry means it is spent (admin/runners.ts · codeJoined). */
  let codeSeen = $state(false)
  let busy = $state(false)
  let errorText = $state<(() => string) | null>(null)
  const error = $derived(errorText?.() ?? null)
  let copied = $state<string | null>(null)
  let copyFailed = $state(false)

  $effect(() => {
    const id = minted?.id
    if (id && codes.some((code) => code.id === id)) codeSeen = true
  })

  /*
   * By this code's own machines when the server names each machine's code,
   * otherwise by the code's count of uses (admin/runners.ts · connectProgress):
   * a code used up before any read showed it no longer leaves "waiting for
   * the first machine" over the machine that used it.
   */
  const progress = $derived(minted ? connectProgress(minted, known, machines, codes, Date.now(), codeSeen) : null)

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /**
   * Escape and the cross close the window, and once the code is shown that
   * loses it: it is shown this once and kept nowhere, so a reflex Escape
   * between copying the first command and pasting it on the third VM meant
   * minting a new code. So they ask first, while machines are still
   * expected; "Done" is the owner saying they have what they need, and asks
   * nothing.
   */
  function requestClose(): void {
    if (minted && (progress?.joined ?? 0) < minted.machines && !window.confirm(tr('admin.runners.connect.closeConfirm'))) return
    onclose()
  }

  async function mint(): Promise<void> {
    if (busy || minted) return
    const asked = mintRequest(form)
    if ('error' in asked) {
      errorText = () => asked.error
      return
    }
    busy = true
    errorText = null
    try {
      known = new Set(machines.map((machine) => machine.id))
      minted = await runnersApi.mintCode(asked.request)
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (cause instanceof Error && cause.message ? cause.message : tr('admin.the.server.did.not.answer'))
    } finally {
      busy = false
    }
  }

  async function copy(text: string, key: string): Promise<void> {
    try {
      await copyText(text)
    } catch {
      // The command is on screen and selectable: say so rather than pretend.
      copyFailed = true
      return
    }
    copyFailed = false
    copied = key
    setTimeout(() => (copied = copied === key ? null : copied), 1600)
  }

  /** Focus lands where the typing goes. */
  function takeFocus(node: HTMLElement): void {
    node.focus()
  }

  /** Only the commands the server filled in; `vast` is left out on purpose for an instance on its own image (admin/runners.ts · joinCommands). */
  const shown = $derived(minted ? joinCommands(minted.commands) : null)
  const COMMANDS = $derived(shown?.commands ?? [])
</script>

<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="connect-machine-title"
  class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6 max-[640px]:p-3"
>
  <div class="dialog-card flex max-h-full w-full max-w-[760px] flex-col border border-line bg-canvas shadow-pop">
    <div class="flex shrink-0 items-start gap-4 border-b border-line px-6 pb-4 pt-5 max-[640px]:px-4">
      <div class="min-w-0 flex-1">
        <h2 id="connect-machine-title" class="text-head font-black text-ink">{tr('admin.runners.connect')}</h2>
        <p class="mt-1 text-2xs text-muted">{tr('admin.runners.connect.lede')}</p>
      </div>
      <button type="button" class="admin-icon-btn -mr-2 -mt-1" aria-label={tr('admin.close')} disabled={busy} onclick={requestClose}>
        <Icon name="x" size={15} />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5 max-[640px]:px-4">
      <form
        class="flex flex-wrap items-start gap-x-4 gap-y-4"
        onsubmit={(event) => {
          event.preventDefault()
          void mint()
        }}
      >
        <label class="w-[160px] max-[640px]:w-[calc(50%-8px)]">
          <span class="admin-label mb-1.5 block">{tr('admin.runners.connect.machines')}</span>
          <span class="admin-affix gap-2">
            <input
              use:takeFocus
              bind:value={form.machines}
              disabled={minted !== null}
              inputmode="numeric"
              autocomplete="off"
              aria-describedby="connect-machines-unit"
            />
            <span id="connect-machines-unit" class="shrink-0 text-2xs text-muted">{tr('admin.runners.connect.machinesUnit')}</span>
          </span>
        </label>
        <label class="w-[160px] max-[640px]:w-[calc(50%-8px)]">
          <span class="admin-label mb-1.5 block">{tr('admin.runners.connect.hours')}</span>
          <span class="admin-affix gap-2">
            <input bind:value={form.hours} disabled={minted !== null} inputmode="numeric" autocomplete="off" />
            <span class="shrink-0 text-2xs text-muted">{tr('admin.runners.connect.hoursUnit', { count: Number(form.hours) || HOURS_BOUNDS.max })}</span>
          </span>
        </label>
        <label class="w-[160px] max-[640px]:w-[calc(50%-8px)]">
          <span class="admin-label mb-1.5 block">{tr('admin.runners.connect.places')}</span>
          <span class="admin-affix gap-2">
            <input
              bind:value={form.places}
              disabled={minted !== null}
              class="placeholder:font-sans placeholder:text-ink"
              inputmode="numeric"
              autocomplete="off"
              placeholder={tr('admin.runners.auto')}
            />
            <span class="shrink-0 text-2xs text-muted">
              {form.places.trim() === '' ? tr('admin.runners.connect.placesAuto') : tr('admin.runners.connect.placesFixed')}
            </span>
          </span>
        </label>
        <div class="min-w-[220px] flex-1 max-[640px]:w-[calc(50%-8px)] max-[640px]:min-w-0 max-[640px]:flex-none">
          <!-- While classes are on, the label and the box grey; the reason under them does not (Z2): it is what is read here. -->
          <span class={cn('admin-label mb-1.5 block', form.classes && 'opacity-[0.45]')}>{tr('admin.runners.connect.sealed')}</span>
          <label
            class={cn(
              'flex min-h-10 items-center gap-2.5 max-[640px]:min-h-11',
              minted === null && !form.classes && 'cursor-pointer',
              form.classes && 'opacity-[0.45]',
            )}
          >
            <Check bind:checked={form.trusted} disabled={minted !== null || form.classes} />
            <span class="text-ui text-ink">{tr('admin.runners.connect.trust')}</span>
          </label>
          {#if form.classes}
            <!-- D3: a machine with classes holds students' work, and the hidden test never goes beside it. -->
            <p class="mt-1 text-2xs text-warning">{tr('admin.runners.connect.classesSealed')}</p>
          {/if}
        </div>
        {#if !minted && !form.classes}
          <p class="w-full text-2xs text-muted">
            {form.trusted ? tr('admin.runners.connect.trustNote') : tr('admin.runners.connect.untrustedNote')}
          </p>
        {/if}

        <!-- The classes block (Z2): full width, a checkbox in a tinted box
             with the brand's frame while it is on. -->
        <div class="w-full">
          <span class="admin-label mb-1.5 block">{tr('admin.runners.connect.classesTitle')}</span>
          <label
            class={cn(
              'flex items-start gap-3 border px-3.5 py-3 max-[640px]:min-h-11',
              form.classes ? 'border-primary bg-primary/[0.05]' : 'border-line',
              minted === null && !form.trusted && 'cursor-pointer',
            )}
          >
            <!-- While the hidden test is trusted, the box and its title grey, and the reason stays whole, as the other way round. -->
            <span class={cn('mt-0.5 shrink-0', form.trusted && 'opacity-[0.45]')}>
              <Check bind:checked={form.classes} disabled={minted !== null || form.trusted} />
            </span>
            <span class="min-w-0">
              <span class={cn('block text-ui font-semibold text-ink', form.trusted && 'opacity-[0.45]')}>{tr('admin.runners.connect.classes')}</span>
              <span class={cn('mt-1 block text-2xs', form.trusted ? 'text-warning' : 'text-muted')}>
                {form.trusted ? tr('admin.runners.menu.classesNotWithTrust') : tr('admin.runners.connect.classesNote')}
              </span>
            </span>
          </label>
        </div>
      </form>

      {#if error}
        <p class="mt-4 text-ui text-danger" role="alert">{error}</p>
      {/if}

      {#if minted}
        <div class="mt-5 flex flex-col gap-3">
          <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p class="text-ui font-semibold text-ink">{tr('admin.runners.connect.run')}</p>
            <p class="text-2xs font-semibold text-warning">
              {tr('admin.runners.connect.once', { count: minted.machines, hours: Math.max(1, Math.round((minted.expiresAt - Date.now()) / 3_600_000)) })}
            </p>
          </div>
          {#if minted.loopback}
            <!-- The commands carry this server's own loopback (PUBLIC_URL of
                 localhost or 127.x), as colloq-host runner-code warns too: a
                 machine anywhere else would dial itself and never join. -->
            <p class="flex items-start gap-2 border-l-[3px] border-danger bg-danger/[0.06] px-3 py-2.5 text-2xs font-semibold text-danger" role="alert">
              <Icon name="alert" size={14} class="mt-0.5 shrink-0" />
              <span>{tr('admin.runners.connect.loopback')}</span>
            </p>
          {/if}
          {#each COMMANDS as command (command.key)}
            <div class="flex flex-col gap-1.5">
              <p class="admin-label">{command.label}</p>
              <!-- Dark in both themes, like the build log on Environments: a
                   terminal is where this text goes. Lines wrap rather than
                   scroll: a box with its own sideways scroll on a phone shows
                   in no way that it scrolls, and Copy takes the exact text. -->
              <div class="flex items-start gap-2.5 bg-[#0A1330] px-3 py-2.5">
                <pre class="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-micro leading-5 text-[#E6E7E8]">{command.text}</pre>
                <button
                  type="button"
                  class="min-h-8 shrink-0 border border-[#16244B] px-2.5 text-2xs text-[#9BA6BE] transition-colors duration-quick hover:border-[#5E6B85] hover:text-white max-[640px]:min-h-11"
                  onclick={() => void copy(command.text, command.key)}
                >
                  {copied === command.key ? tr('admin.copied') : tr('admin.runners.connect.copy')}
                </button>
              </div>
            </div>
          {/each}
          {#if shown?.vastLeftOut}
            <p class="text-2xs text-muted">{tr('admin.runners.connect.vastLeftOut')}</p>
          {/if}
          {#if copyFailed}
            <p class="text-2xs text-danger" role="alert">{tr('admin.runners.connect.copyFailed')}</p>
          {/if}
        </div>
      {/if}
    </div>

    <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-t border-line bg-surface px-6 py-3.5 max-[640px]:px-4">
      {#if progress}
        <span class={cn('size-2.5 shrink-0', progress.joined > 0 ? 'bg-positive' : 'bg-accent')} aria-hidden="true"></span>
        <div class="min-w-0 flex-1 basis-[240px]" role="status" aria-live="polite">
          <p class="text-ui font-semibold text-ink">{progress.title}</p>
          <p class="mt-0.5 text-2xs text-muted">{progress.text}</p>
        </div>
        <button type="button" class="btn-outline shrink-0 max-[640px]:w-full" onclick={onclose}>{tr('admin.runners.connect.done')}</button>
      {:else}
        <p class="min-w-0 flex-1 basis-[240px] text-2xs text-muted">
          {tr('admin.runners.connect.bounds', { machines: MACHINES_BOUNDS.max, hours: HOURS_BOUNDS.max })}
        </p>
        <div class="flex shrink-0 flex-wrap gap-2 max-[640px]:w-full">
          <button type="button" class="btn-ghost max-[640px]:flex-1" disabled={busy} onclick={onclose}>{tr('admin.cancel')}</button>
          <button type="button" class="btn-primary max-[640px]:flex-1" disabled={busy} onclick={() => void mint()}>
            {#if busy}
              <Icon name="spinner" size={15} class="animate-spin" />
            {/if}
            {tr('admin.runners.connect.mint')}
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>
