<script lang="ts">
  import { tr } from '@shared/i18n'
  import Skeleton from './Skeleton.svelte'

  let { variant = 'page', label = tr('common.loading') }: {
    variant?: 'page' | 'notebook' | 'rows'
    label?: string
  } = $props()
</script>

<div role="status" aria-label={label} aria-busy="true" class:page={variant === 'page'}>
  <span class="sr-only">{label}</span>
  {#if variant === 'page'}
    <div class="mb-10 flex flex-col gap-4 border-b border-line pb-8">
      <Skeleton width="7rem" height="0.7rem" />
      <Skeleton width="min(70%, 32rem)" height="2.5rem" />
      <Skeleton width="12rem" height="0.8rem" />
    </div>
  {/if}
  {#if variant === 'rows'}
    <div class="flex flex-col gap-6 py-3">
      {#each ['72%', '55%', '64%', '46%'] as width}
        <div class="flex items-center gap-3">
          <Skeleton width="1.5rem" height="1.5rem" />
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton {width} height="0.85rem" />
            <Skeleton width="30%" height="0.55rem" />
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="flex flex-col gap-5 py-4">
      {#each [['65%', '88%', '48%'], ['78%', '52%', '64%', '36%'], ['58%', '82%']] as lines, index}
        <div class="flex gap-4">
          <div class="w-8 shrink-0 pt-4"><Skeleton width="1.25rem" height="0.65rem" /></div>
          <div class="flex min-w-0 flex-1 flex-col gap-3 border-l-[3px] border-line bg-surface/50 p-5">
            {#each lines as width}
              <Skeleton {width} height={index === 0 ? '0.85rem' : '0.65rem'} />
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { width: 100%; max-width: 76rem; margin: 0 auto; padding: clamp(1.5rem, 5vw, 4rem); }
</style>
