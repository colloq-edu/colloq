<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { SubmissionEnvironment, DependencyBundle } from '@shared/dependencies'
  import { entrantApi } from '@/lib/entrantApi'
  import DependencyBundleCard from './DependencyBundleCard.svelte'
  let { execution, slug }: { execution?: SubmissionEnvironment; slug?: string } = $props()
  let opened = $state(false)
  let bundle = $state<DependencyBundle | null>(null)
  let error = $state('')
  async function toggle(): Promise<void> {
    opened = !opened
    if (!opened || bundle || !slug || !execution?.bundleId) return
    try { bundle = await entrantApi.dependencyBundle(slug, execution.bundleId); error = '' }
    catch (cause) { error = cause instanceof Error ? cause.message : tr('common.networkError') }
  }
</script>

{#if execution && !execution.legacy}
  <div class="break-words text-[14px] leading-5 text-muted">
    {#if execution.bundleNumber !== null && slug}
      <button type="button" class="text-accent-text underline" aria-expanded={opened} onclick={toggle}>{tr('dependencies.set', { number: execution.bundleNumber })}</button>
    {:else}{execution.bundleNumber === null ? tr('dependencies.base') : tr('dependencies.set', { number: execution.bundleNumber })}{/if}
    · {execution.environmentName}{#if execution.pythonVersion} · Python {execution.pythonVersion}{/if}
    {#if opened}
      <div class="my-3">
        {#if bundle}<DependencyBundleCard {bundle} lockUrl={slug ? entrantApi.dependencyLockUrl(slug, bundle.id) : undefined} />
        {:else if error}<p class="text-danger" role="alert">{error}</p>
        {:else}<p role="status">{tr('dependencies.loading')}</p>{/if}
      </div>
    {/if}
  </div>
{:else}
  <span class="block text-[14px] leading-5 text-muted">{tr('dependencies.legacy')}</span>
{/if}
