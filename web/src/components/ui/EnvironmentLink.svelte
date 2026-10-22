<script lang="ts">
  import { tr } from '@shared/i18n'
  import EnvironmentDetails from './EnvironmentDetails.svelte'
  import type { EnvironmentFreeze, ListedFreeze } from './EnvironmentDetails.svelte'

  /**
   * `freeze`: the window's pip freeze download, the panel's with what it knows
   * of the image, a competition page's learnt with the list (ListedFreeze).
   */
  interface Props { name: string; endpoint: string; freeze?: EnvironmentFreeze | ListedFreeze }
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
