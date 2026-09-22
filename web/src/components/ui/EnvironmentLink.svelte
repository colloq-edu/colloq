<script lang="ts">
  import { tr } from '@shared/i18n'
  import EnvironmentDetails from './EnvironmentDetails.svelte'

  interface Props { name: string; endpoint: string }
  const { name, endpoint }: Props = $props()
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
  <EnvironmentDetails {name} {endpoint} onclose={() => (open = false)} />
{/if}
