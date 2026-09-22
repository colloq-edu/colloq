<script lang="ts">
  import { tr } from '@shared/i18n'
  import { dependencyActive, type DependencyBundle } from '@shared/dependencies'
  import { fileSize } from '@/lib/competition-words'
  let { bundle, selected = false, compatible = true, busy = false, lockUrl, onselect, oncancel, onretry, onedit }: {
    bundle: DependencyBundle; selected?: boolean; compatible?: boolean; busy?: boolean; lockUrl?: string
    onselect?: () => void; oncancel?: () => void; onretry?: () => void; onedit?: () => void
  } = $props()
  const active = $derived(dependencyActive(bundle.state))
  const steps = ['queued', 'resolving', 'downloading', 'verifying', 'ready'] as const
  const progress = $derived(steps.indexOf(bundle.state as typeof steps[number]))
</script>

<article class="min-w-0 border border-line bg-surface p-4 sm:p-5" class:border-accent={selected}>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-[16px] font-bold text-ink">{tr('dependencies.set', { number: bundle.number })}</h3>
    <span class="text-[14px] font-bold" class:text-positive={bundle.state === 'ready'} class:text-danger={bundle.state === 'failed'} class:text-muted={bundle.state !== 'ready' && bundle.state !== 'failed'} aria-live="polite">{tr(`dependencies.state.${bundle.state}`)}</span>
  </div>
  {#if selected}<p class="mt-1 text-[14px] text-accent-text">{tr('dependencies.selected')}</p>{/if}
  {#if !compatible}<p class="mt-2 text-[14px] text-warning">{tr('dependencies.oldBase')}</p>{/if}
  {#if active}
    <ol class="my-4 flex flex-wrap gap-x-4 gap-y-2 text-[14px]" aria-label={tr('dependencies.prepare')}>
      {#each steps as step, index}
        <li class={index < progress ? 'text-positive' : index === progress ? 'font-bold text-accent-text' : 'text-muted'} aria-current={index === progress ? 'step' : undefined}>{index + 1}. {tr(`dependencies.state.${step}`)}</li>
      {/each}
    </ol>
  {/if}
  {#if bundle.error}
    <div class="mt-3 border-l-2 border-danger bg-danger/5 p-3 text-[15px] leading-6 text-ink" role="alert">
      {#if bundle.error.line}<strong>{tr('dependencies.line', { line: bundle.error.line })}:</strong>{' '}{/if}{bundle.error.message}
    </div>
  {/if}
  {#if bundle.state === 'ready'}
    <p class="mt-2 text-[14px] text-muted">{tr('dependencies.sizes', { download: fileSize(bundle.downloadBytes), installed: fileSize(bundle.installedBytes) })}</p>
  {/if}
  <details class="mt-3 text-[14px] text-ink">
    <summary class="cursor-pointer py-1 text-accent-text">{tr('dependencies.details')}</summary>
    <pre class="my-2 overflow-x-auto whitespace-pre-wrap break-words border border-line bg-canvas p-3 font-mono text-[14px]">{bundle.requirementsText}</pre>
    {#if bundle.state === 'ready' && !bundle.packages.length}<p class="py-2 text-muted">{tr('dependencies.noDownloads')}</p>{/if}
    <ul class="divide-y divide-line">
      {#each bundle.packages as pkg (pkg.name)}
        <li class="flex flex-wrap justify-between gap-x-3 py-2"><span class="break-all font-mono">{pkg.name}=={pkg.version}</span><span class="text-muted">{fileSize(pkg.bytes)}</span></li>
      {/each}
    </ul>
  </details>
  {#if bundle.log.length}
    <details class="mt-2 text-[14px] text-muted">
      <summary class="cursor-pointer py-1">{tr('dependencies.logs')}</summary>
      <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words bg-canvas p-3 font-mono text-[14px]">{bundle.log.join('\n')}</pre>
    </details>
  {/if}
  <div class="mt-3 flex flex-wrap items-center gap-3 text-[14px]">
    {#if bundle.state === 'ready' && compatible && onselect && !selected}<button type="button" class="min-h-10 bg-brand px-4 font-bold text-white disabled:opacity-50" disabled={busy} onclick={onselect}>{tr('dependencies.use')}</button>{/if}
    {#if active && oncancel}<button type="button" class="min-h-10 text-danger underline disabled:opacity-50" disabled={busy} onclick={oncancel}>{tr('dependencies.cancel')}</button>{/if}
    {#if !active && bundle.state !== 'ready' && onretry}<button type="button" class="min-h-10 text-accent-text underline disabled:opacity-50" disabled={busy} onclick={onretry}>{tr('dependencies.retry')}</button>{/if}
    {#if onedit}<button type="button" class="min-h-10 text-accent-text underline disabled:opacity-50" disabled={busy} onclick={onedit}>{tr('dependencies.edit')}</button>{/if}
    {#if bundle.state === 'ready' && lockUrl}<a class="inline-flex min-h-10 items-center text-accent-text underline" href={lockUrl} download>{tr('dependencies.lock')}</a>{/if}
  </div>
</article>
