<script lang="ts">
  import { onMount } from 'svelte'
  import { tr } from '@shared/i18n'
  import { DEPENDENCY_LIMITS, dependencyActive, type DependencyOverview, type DependencyBundle } from '@shared/dependencies'
  import { entrantApi } from '@/lib/entrantApi'
  import DependencyBundleCard from './DependencyBundleCard.svelte'
  let { slug, signedIn, onjoin }: { slug: string; signedIn: boolean; onjoin: () => void } = $props()
  let overview = $state<DependencyOverview | null>(null)
  let text = $state('')
  let savedText = $state('')
  let loaded = $state(false)
  let busy = $state(false)
  let error = $state('')
  let notice = $state('')
  let streamLost = $state(false)
  let importing = $state<HTMLInputElement>()
  const lines = $derived(text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#')).length)
  const bytes = $derived(new TextEncoder().encode(text).length)
  const invalid = $derived(lines > DEPENDENCY_LIMITS.lines || bytes > DEPENDENCY_LIMITS.requestBytes)
  const activeId = $derived(overview?.bundles.find((bundle) => dependencyActive(bundle.state))?.id ?? null)
  const canPrepare = $derived(!!overview?.joined && !!overview.policy.enabled && !!overview.revision && !activeId && !invalid && !!text.trim() && !busy)
  const changed = $derived(text !== savedText)
  const failure = (cause: unknown) => cause instanceof Error ? cause.message : tr('common.networkError')

  async function load(): Promise<void> {
    try {
      const next = await entrantApi.dependencies(slug)
      if (!loaded) { text = next.draft.requirementsText; savedText = text }
      overview = next
      loaded = true
      error = ''
    } catch (cause) { error = failure(cause) }
  }
  onMount(() => { if (signedIn) void load() })

  function update(bundle: DependencyBundle): void {
    if (!overview) return
    overview = { ...overview, bundles: [bundle, ...overview.bundles.filter((item) => item.id !== bundle.id)].sort((a, b) => b.number - a.number) }
  }
  $effect(() => {
    const id = activeId
    if (!id) return
    const stream = new EventSource(entrantApi.dependencyStreamUrl(slug, id))
    stream.addEventListener('state', (event) => {
      try { update(JSON.parse((event as MessageEvent<string>).data)); streamLost = false } catch { streamLost = true }
    })
    stream.addEventListener('error', () => { streamLost = true })
    // Polling also catches a terminal event lost while reconnecting.
    const timer = setInterval(() => { void entrantApi.dependencyBundle(slug, id).then(update).catch(() => { streamLost = true }) }, 5000)
    return () => { stream.close(); clearInterval(timer) }
  })
  async function act(task: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true; error = ''; notice = ''
    try { await task() } catch (cause) { error = failure(cause) } finally { busy = false }
  }
  function save(selectedBundleId?: string | null): Promise<void> {
    if (invalid) { error = tr('dependencies.limitError'); return Promise.resolve() }
    return act(async () => {
      const submitted = text
      overview = await entrantApi.dependencyDraft(slug, submitted, selectedBundleId)
      savedText = submitted
      notice = tr('dependencies.saved')
    })
  }
  function prepare(requirementsText = text): Promise<void> {
    return act(async () => {
      const next = await entrantApi.dependencyDraft(slug, requirementsText)
      overview = next
      if (text === requirementsText) savedText = requirementsText
      const result = await entrantApi.prepareDependencies(slug, requirementsText)
      update(result.bundle)
    })
  }
  async function importFile(file?: File): Promise<void> {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.txt') || file.size > DEPENDENCY_LIMITS.requestBytes) { error = tr('dependencies.fileError'); return }
    try { text = await file.text(); error = ''; notice = '' } catch (cause) { error = failure(cause) }
  }
</script>

<div class="mx-auto w-full max-w-[1200px] space-y-6 text-[16px] leading-6">
  <header><h2 class="text-[24px] font-black text-ink">{tr('dependencies.title')}</h2><p class="mt-2 max-w-[760px] text-muted">{tr('dependencies.intro')}</p></header>
  {#if !signedIn || (overview && !overview.joined)}
    <div class="border border-line bg-surface p-5"><p>{tr('dependencies.access')}</p><button type="button" class="mt-4 min-h-11 bg-brand px-4 font-bold text-white" onclick={onjoin}>{tr('competitions.p.join')}</button></div>
  {:else if !overview}
    <p role="status">{error || tr('dependencies.loading')}</p>
    {#if error}<button type="button" class="text-accent-text underline" onclick={load}>{tr('dependencies.reload')}</button>{/if}
  {:else}
    <section class="border border-line bg-surface p-4 sm:p-6">
      <div class="flex flex-wrap items-start justify-between gap-4"><div><h3 class="font-bold text-ink">{tr('dependencies.base')}</h3><p class="mt-1 text-[15px] text-muted">{tr('dependencies.baseHint')}</p></div>
        {#if overview.draft.selectedBundleId}<button type="button" class="min-h-11 border border-line px-4 text-[14px] font-bold text-accent-text disabled:opacity-50" disabled={busy || invalid} onclick={() => save(null)}>{tr('dependencies.useBase')}</button>{:else}<span class="text-[14px] text-positive">{tr('dependencies.selected')}</span>{/if}
      </div>
      {#if overview.revision}
        <p class="mt-3 break-words font-mono text-[14px] text-ink">{overview.revision.environmentName} · Python {overview.revision.pythonVersion} · {overview.revision.platform}</p>
        <details class="mt-3 text-[14px]"><summary class="cursor-pointer text-accent-text">{tr('dependencies.inventory', { count: overview.revision.packages.length })}</summary><ul class="mt-3 grid max-h-80 gap-x-8 overflow-auto sm:grid-cols-2">{#each overview.revision.packages as pkg (pkg.name)}<li class="flex flex-wrap justify-between gap-x-3 border-b border-line py-1 font-mono"><span class="break-all">{pkg.name}</span><span>{pkg.version}</span></li>{/each}</ul></details>
      {:else}<p class="mt-3 text-[15px] text-warning">{tr('dependencies.noRevision')}</p>{/if}
    </section>
    <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section class="min-w-0 border border-line bg-surface p-4 sm:p-6">
        <h3 class="font-bold text-ink">{tr('dependencies.extra')}</h3>
        <p id="requirements-hint" class="mt-2 text-[15px] text-muted">{tr('dependencies.requirementsHint')}</p><details class="mt-2 text-[14px] text-muted"><summary class="cursor-pointer text-accent-text">{tr('dependencies.requirementsHelp')}</summary><p class="mt-2">{tr('dependencies.rules')}</p></details>
        {#if !overview.policy.enabled}<p class="mt-3 text-[15px] text-warning">{tr('dependencies.disabled')}</p>{/if}
        <label for="requirements" class="mt-5 block text-[14px] font-bold text-ink">requirements.txt</label>
        <textarea id="requirements" class="mt-2 block min-h-52 w-full resize-y border border-line bg-canvas p-3 font-mono text-[14px] leading-6 text-ink focus:outline-accent" spellcheck="false" rows="8" bind:value={text} aria-describedby="requirements-hint requirements-count" aria-invalid={invalid} placeholder={'# PyPI\nscikit-learn==1.5.2'}></textarea>
        <p id="requirements-count" class="mt-2 text-[14px]" class:text-danger={invalid} class:text-muted={!invalid}>{invalid ? tr('dependencies.limitError') : tr('dependencies.limits', { lines, bytes })}</p>
        <input type="file" class="hidden" accept=".txt,text/plain" bind:this={importing} onchange={(event) => { void importFile(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
        <button type="button" class="mt-2 min-h-10 text-[14px] text-accent-text underline" onclick={() => importing?.click()}>{tr('dependencies.import')}</button>
        <div class="mt-4 flex flex-wrap gap-3"><button type="button" class="min-h-11 bg-brand px-4 text-[15px] font-bold text-white disabled:opacity-50" disabled={!canPrepare} onclick={() => prepare()}>{tr('dependencies.prepare')}</button><button type="button" class="min-h-11 border border-line px-4 text-[14px] text-ink disabled:opacity-50" disabled={busy || invalid || !changed} onclick={() => save()}>{tr('dependencies.save')}</button></div>
        <p class="mt-3 text-[14px] text-muted" role="status">{busy ? tr('dependencies.busy') : changed ? tr('dependencies.unsaved') : notice}</p>
        <p class="mt-3 text-[14px] text-muted">{tr('dependencies.quotaNote')}</p>
        {#if error}<p class="mt-3 text-[15px] text-danger" role="alert">{error}</p>{/if}
      </section>
      <section class="min-w-0 space-y-4"><h3 class="font-bold text-ink">{tr('dependencies.history')}</h3><p class="text-[14px] text-muted">{tr('dependencies.immutable')}</p>
        {#if streamLost && activeId}<p class="text-[14px] text-warning" role="status">{tr('dependencies.streamLost')}</p>{/if}
        {#if !overview.bundles.length}<p class="border border-line p-5 text-[15px] text-muted">{tr('dependencies.empty')}</p>{/if}
        {#each overview.bundles as bundle (bundle.id)}
          <DependencyBundleCard {bundle} selected={overview.draft.selectedBundleId === bundle.id} compatible={overview.revision?.id === bundle.revisionId} busy={busy} lockUrl={entrantApi.dependencyLockUrl(slug, bundle.id)} onselect={() => save(bundle.id)} oncancel={() => act(async () => update(await entrantApi.cancelDependencies(slug, bundle.id)))} onretry={overview.policy.enabled && !activeId ? () => prepare(bundle.requirementsText) : undefined} onedit={() => { text = bundle.requirementsText; notice = ''; document.getElementById('requirements')?.focus() }} />
        {/each}
      </section>
    </div>
  {/if}
</div>
