<script lang="ts" generics="T">
  import { untrack, type Snippet } from 'svelte'
  import { tr } from '@shared/i18n'
  import Splash from './Splash.svelte'
  import { loadLocalizedFeature } from '@/lib/screen-language'
  import { handleModuleFailure } from '@/lib/module-failures'

  let { load, children, loading }: {
    load: () => Promise<{ default: T }>
    children: Snippet<[T]>
    /** Small controls reserve their own space instead of a whole content pane. */
    loading?: Snippet
  } = $props()
  let attempt = $state(0)
  const pending = $derived.by(() => {
    attempt
    const loader = load
    // Locale/catalog revisions update labels through the app's dictionary
    // loader. They must not replace this promise and remount a live editor.
    return untrack(() => loadLocalizedFeature(loader)).catch((error: unknown) => {
      handleModuleFailure(error)
      throw error
    })
  })
</script>

{#await pending}
  {#if loading}
    {@render loading()}
  {:else}
    <Splash size="pane" />
  {/if}
{:then module}
  {@render children(module.default)}
{:catch}
  <div class="flex min-h-60 shrink-0 flex-col items-center justify-center gap-3 p-4" role="alert">
    <p class="max-w-xl text-center text-ui text-muted">
      {tr(attempt > 0 ? 'common.moduleLoadFailed' : 'common.loadError')}
    </p>
    <div class="flex gap-2">
      {#if attempt > 0}
        <!-- A browser may cache a rejected import for this document. Another
             request cannot clear that module map; a user-chosen reload can. -->
        <button class="btn-primary" type="button" onclick={() => location.reload()}>{tr('common.reload')}</button>
      {/if}
      <button class="btn" type="button" onclick={() => (attempt += 1)}>{tr('common.retry')}</button>
    </div>
  </div>
{/await}
