<script lang="ts">
  import { onMount } from 'svelte'
  import { tr } from '@shared/i18n'
  import { dependencyActive, type AdminDependencyOverview } from '@shared/dependencies'
  import { adminApi } from '@/lib/adminApi'
  import Section from '@/admin/ui/Section.svelte'
  import Check from '@/admin/ui/Check.svelte'
  import DependencyBundleCard from '@/components/competitions/DependencyBundleCard.svelte'
  let { competitionId }: { competitionId: string } = $props()
  let data = $state<AdminDependencyOverview | null>(null)
  let enabled = $state(false)
  let limit = $state<number | undefined>(500)
  let busy = $state(false)
  let error = $state('')
  let notice = $state('')
  let loaded = false
  const active = $derived(data?.bundles.some((bundle) => dependencyActive(bundle.state)) ?? false)
  async function load(): Promise<void> {
    try {
      data = await adminApi.competitionDependencies(competitionId)
      if (!loaded) { enabled = data.policy.enabled; limit = Math.round(data.policy.maxDownloadBytes / 1024 / 1024); loaded = true }
    } catch (cause) { error = cause instanceof Error ? cause.message : tr('common.networkError') }
  }
  onMount(() => { void load() })
  $effect(() => {
    if (!active) return
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  })
  async function act(task: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true; error = ''; notice = ''
    try { await task() } catch (cause) { error = cause instanceof Error ? cause.message : tr('common.networkError') } finally { busy = false }
  }
  function save(): Promise<void> {
    if (!Number.isInteger(limit) || !limit || limit < 1 || limit > 500) { error = tr('dependencies.policyInvalid'); return Promise.resolve() }
    const maxDownloadBytes = limit * 1024 * 1024
    return act(async () => { data = await adminApi.updateDependencyPolicy(competitionId, { enabled, maxDownloadBytes }); notice = tr('dependencies.policySaved') })
  }
</script>

<!--
  The panel's vocabulary (index.css · the teacher's panel): a caption over the
  field, an outline button at the control height, a text link to reload.
  It was the one block on the competition form typed in pixels, and it read a
  step off from the sections around it.
-->
<Section title={tr('dependencies.adminTitle')} description={tr('dependencies.adminHint')}>
  <div class="space-y-5 text-2xs text-ink">
    {#if !data}
      <p class="text-muted" role="status">{tr('dependencies.loading')}</p>
    {:else}
      {#if data.capabilities?.preparation.available === false}
        <p class="text-warning" role="status">{data.capabilities.preparation.reason}</p>
      {/if}
      <label class="flex cursor-pointer items-start gap-3 text-ui text-ink">
        <span class="mt-[3px]">
          <Check
            bind:checked={enabled}
            disabled={busy || data.capabilities?.preparation.available === false}
          />
        </span>
        <span>{tr('dependencies.enabled')}</span>
      </label>
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col">
          <span class="admin-label mb-1.5 block">{tr('dependencies.maxDownload')}</span>
          <input
            type="number"
            class="field w-40 max-w-full font-mono"
            min="1"
            max="500"
            step="1"
            bind:value={limit}
            disabled={busy}
          />
        </label>
        <button type="button" class="btn-outline" disabled={busy} onclick={save}>
          {tr('dependencies.savePolicy')}
        </button>
      </div>
      <div class="border border-line bg-surface p-4">
        <h3 class="text-ui font-semibold text-ink">{tr('dependencies.base')}</h3>
        {#if data.revision}
          <p class="mt-2 break-words font-mono text-micro text-ink">
            {data.revision.environmentName} · Python {data.revision.pythonVersion} · {data.revision.platform}
          </p>
          <details class="mt-2 text-micro">
            <summary class="cursor-pointer text-accent-text">
              {tr('dependencies.inventory', { count: data.revision.packages.length })}
            </summary>
            <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono">{data.revision.packages
                .map((pkg) => `${pkg.name}==${pkg.version}`)
                .join('\n')}</pre>
          </details>
        {:else}
          <p class="mt-2 text-warning">{tr('dependencies.noRevision')}</p>
        {/if}
        <p class="admin-meta mt-3">{tr('dependencies.refreshHint')}</p>
        <button
          type="button"
          class="btn-outline mt-3"
          disabled={busy || data.capabilities?.preparation.available === false}
          onclick={() =>
            act(async () => {
              data = await adminApi.refreshDependencyBase(competitionId)
              notice = tr('dependencies.baseRefreshed')
            })}
        >
          {tr('dependencies.refreshBase')}
        </button>
      </div>
      <div class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-ui font-semibold text-ink">{tr('dependencies.queue')}</h3>
          <button type="button" class="admin-link" disabled={busy} onclick={() => act(load)}>
            {tr('dependencies.reload')}
          </button>
        </div>
        {#if !data.bundles.length}
          <p class="text-muted">{tr('dependencies.queueEmpty')}</p>
        {/if}
        {#each data.bundles as bundle (bundle.id)}
          <div class="min-w-0">
            <p class="mb-1 break-words text-2xs font-semibold text-ink">{bundle.entrantName}</p>
            <DependencyBundleCard
              {bundle}
              {busy}
              compatible={bundle.revisionId === data.revision?.id}
              oncancel={() =>
                act(async () => {
                  await adminApi.cancelCompetitionDependencies(competitionId, bundle.id)
                  await load()
                })}
            />
          </div>
        {/each}
      </div>
    {/if}
    {#if busy || notice}
      <p role="status" class="text-micro text-positive">{busy ? tr('dependencies.busy') : notice}</p>
    {/if}
    {#if error}
      <p role="alert" class="text-ui text-danger">{error}</p>
      {#if !data}
        <button type="button" class="admin-link" onclick={() => act(load)}>{tr('dependencies.reload')}</button>
      {/if}
    {/if}
  </div>
</Section>
