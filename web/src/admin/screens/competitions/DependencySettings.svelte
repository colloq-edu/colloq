<script lang="ts">
  import { onMount } from 'svelte'
  import { tr } from '@shared/i18n'
  import { dependencyActive, type AdminDependencyOverview } from '@shared/dependencies'
  import { adminApi } from '@/lib/adminApi'
  import Section from '@/admin/ui/Section.svelte'
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

<Section title={tr('dependencies.adminTitle')} description={tr('dependencies.adminHint')}>
  <div class="space-y-5 text-[15px] leading-6">
    {#if !data}<p role="status">{tr('dependencies.loading')}</p>{:else}
      <label class="flex items-start gap-3 text-ink"><input class="mt-1 size-4 accent-accent" type="checkbox" bind:checked={enabled} disabled={busy} /><span>{tr('dependencies.enabled')}</span></label>
      <div class="flex flex-wrap items-end gap-3"><label class="flex flex-col gap-1 text-[14px] text-ink">{tr('dependencies.maxDownload')}<input type="number" class="field w-40 max-w-full text-[15px]" min="1" max="500" step="1" bind:value={limit} disabled={busy} /></label><button type="button" class="min-h-11 border border-line px-4 font-bold text-ink disabled:opacity-50" disabled={busy} onclick={save}>{tr('dependencies.savePolicy')}</button></div>
      <div class="border border-line bg-surface p-4"><h3 class="font-bold text-ink">{tr('dependencies.base')}</h3>
        {#if data.revision}<p class="mt-2 break-words font-mono text-[14px] text-ink">{data.revision.environmentName} · Python {data.revision.pythonVersion} · {data.revision.platform}</p><details class="mt-2 text-[14px]"><summary class="cursor-pointer text-accent-text">{tr('dependencies.inventory', { count: data.revision.packages.length })}</summary><pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono">{data.revision.packages.map((pkg) => `${pkg.name}==${pkg.version}`).join('\n')}</pre></details>{:else}<p class="mt-2 text-warning">{tr('dependencies.noRevision')}</p>{/if}
        <p class="mt-3 text-[14px] text-muted">{tr('dependencies.refreshHint')}</p><button type="button" class="mt-3 min-h-11 border border-line px-4 text-[14px] font-bold text-accent-text disabled:opacity-50" disabled={busy} onclick={() => act(async () => { data = await adminApi.refreshDependencyBase(competitionId); notice = tr('dependencies.baseRefreshed') })}>{tr('dependencies.refreshBase')}</button>
      </div>
      <div class="space-y-3"><div class="flex flex-wrap items-center justify-between gap-2"><h3 class="font-bold text-ink">{tr('dependencies.queue')}</h3><button type="button" class="min-h-10 text-[14px] text-accent-text underline" disabled={busy} onclick={() => act(load)}>{tr('dependencies.reload')}</button></div>
        {#if !data.bundles.length}<p class="text-muted">{tr('dependencies.queueEmpty')}</p>{/if}
        {#each data.bundles as bundle (bundle.id)}<div class="min-w-0"><p class="mb-1 break-words text-[14px] font-bold text-ink">{bundle.entrantName}</p><DependencyBundleCard {bundle} {busy} compatible={bundle.revisionId === data.revision?.id} oncancel={() => act(async () => { await adminApi.cancelCompetitionDependencies(competitionId, bundle.id); await load() })} /></div>{/each}
      </div>
    {/if}
    {#if busy || notice}<p role="status" class="text-[14px] text-positive">{busy ? tr('dependencies.busy') : notice}</p>{/if}
    {#if error}<p role="alert" class="text-[15px] text-danger">{error}</p>{#if !data}<button type="button" class="text-accent-text underline" onclick={() => act(load)}>{tr('dependencies.reload')}</button>{/if}{/if}
  </div>
</Section>
