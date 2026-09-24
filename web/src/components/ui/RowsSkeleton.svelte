<script lang="ts">
  /**
   * List placeholder: rows where there will be rows in a moment.
   *
   * This file used to be called ContentSkeleton and could do two more things —
   * a "page" (header and text) and a "notebook" (grey cells). Both drew NOT
   * what was loading: in their place there could turn out to be the staff
   * sign-in instead of the panel, an empty notebook instead of ten cells, a
   * refusal screen instead of everything — and they appeared where there was no
   * interface at all yet, right after the splash went away. They were replaced
   * by Splash.svelte, that is, the same splash that index.html draws.
   *
   * The list rows stayed, because here the placeholder does not lie: the files
   * panel and the classes table are both already drawn around it, it is known
   * that what arrives will be a list, and the grey row stands exactly where the
   * real one will — that is, it holds the place and does not shift the layout
   * under the hand.
   */
  import { tr } from '@shared/i18n'
  import Skeleton from './Skeleton.svelte'

  let { label = tr('common.loading') }: { label?: string } = $props()
</script>

<div role="status" aria-label={label} aria-busy="true" data-skeleton="rows">
  <span class="sr-only">{label}</span>
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
</div>
