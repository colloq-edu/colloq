<script lang="ts">
  import { tr } from '@shared/i18n'
  import EnvironmentDetails from './EnvironmentDetails.svelte'
  import type { EnvironmentFreeze } from './EnvironmentDetails.svelte'

  /** `freeze`: the panel's pip freeze download for the window; the competition pages leave it out. */
  interface Props { name: string; endpoint: string; freeze?: EnvironmentFreeze }
  const { name, endpoint, freeze }: Props = $props()
  let open = $state(false)
</script>

<button
  type="button"
  class="max-w-full break-all border-b border-dashed border-accent-text font-mono text-accent-text hover:text-ink"
  aria-label={tr('common.environmentOpen', { name })}
  aria-haspopup="dialog"
  onclick={() => (open = true)}
>{name}</button>

{#if open}
  <EnvironmentDetails {name} {endpoint} {freeze} onclose={() => (open = false)} />
{/if}
