<script lang="ts">
  import { onMount } from 'svelte'
  import { tr } from '@shared/i18n'
  import type { EnvironmentInventory } from '@shared/environment-inventory'

  interface Props { name: string; endpoint: string; onclose: () => void }
  const { name, endpoint, onclose }: Props = $props()
  let dialog: HTMLDialogElement
  let inventory = $state<EnvironmentInventory | null>(null)
  let loading = $state(true)
  let failed = $state(false)
  let query = $state('')
  const controller = new AbortController()
  const shown = $derived(inventory?.packages.filter(pkg =>
    pkg.name.toLowerCase().includes(query.trim().toLowerCase())) ?? [])

  async function load(): Promise<void> {
    loading = true
    failed = false
    try {
      const response = await fetch(endpoint, { credentials: 'include', signal: controller.signal })
      if (!response.ok) throw new Error('Inventory unavailable')
      inventory = await response.json()
    } catch {
      if (!controller.signal.aborted) failed = true
    } finally {
      loading = false
    }
  }

  onMount(() => {
    dialog.showModal()
    void load()
    return () => { controller.abort(); dialog.close() }
  })
</script>

<dialog
  bind:this={dialog}
  class="competition-ui m-auto h-[min(720px,85dvh)] max-h-[85dvh] w-[640px] max-w-[calc(100%-32px)] overflow-hidden whitespace-normal border border-line bg-canvas p-0 text-left font-sans font-normal text-ink shadow-pop backdrop:bg-black/50"
  aria-labelledby="environment-details-title"
  onclose={onclose}
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      dialog.close()
    }
  }}
>
  <div class="flex h-full flex-col">
    <header class="flex shrink-0 items-start justify-between gap-4 border-b border-line p-5">
      <div class="min-w-0">
        <h2 id="environment-details-title" class="text-title font-bold">{tr('common.environmentDetails')}</h2>
        <p class="mt-1 break-all font-mono text-ui text-muted">{name}</p>
      </div>
      <button type="button" class="flex size-10 shrink-0 items-center justify-center border border-line bg-surface text-head hover:bg-raised" aria-label={tr('common.environmentClose')} onclick={() => dialog.close()}>×</button>
    </header>

    {#if loading}
      <p class="p-5 text-ui text-muted" role="status">{tr('common.environmentLoading')}</p>
    {:else if failed}
      <div class="p-5">
        <p class="text-ui text-danger" role="alert">{tr('common.environmentUnavailable')}</p>
        <button type="button" class="btn-outline mt-4" onclick={() => void load()}>{tr('common.environmentRetry')}</button>
      </div>
    {:else if inventory}
      <div class="shrink-0 space-y-3 border-b border-line p-5">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <p class="font-mono text-title font-bold">Python {inventory.python}</p>
          <p class="text-micro text-muted">{tr('common.environmentPackageCount', { count: inventory.packages.length })}</p>
        </div>
        <p class="text-micro text-muted">{tr('common.environmentInstalled')}</p>
        <input class="field text-ui" type="search" bind:value={query} placeholder={tr('common.environmentSearch')} aria-label={tr('common.environmentSearch')} autocomplete="off" spellcheck="false" />
      </div>
      <div class="min-h-0 flex-1 overflow-auto overscroll-contain px-5 pb-5">
        <table class="w-full border-collapse text-ui">
          <thead class="sticky top-0 bg-canvas">
            <tr class="border-b border-line text-micro text-muted">
              <th scope="col" class="py-3 pr-4 text-left font-semibold">{tr('common.environmentPackage')}</th>
              <th scope="col" class="py-3 text-right font-semibold">{tr('common.environmentVersion')}</th>
            </tr>
          </thead>
          <tbody>
            {#each shown as pkg (pkg.name)}
              <tr class="border-b border-line-soft">
                <td class="break-all py-2 pr-4 font-mono text-2xs">{pkg.name}</td>
                <td class="break-all py-2 text-right font-mono text-2xs tabular-nums">{pkg.version}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if shown.length === 0}<p class="py-5 text-ui text-muted" role="status">{tr('common.environmentNoMatches')}</p>{/if}
      </div>
    {/if}
  </div>
</dialog>
