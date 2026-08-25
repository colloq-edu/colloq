<script lang="ts">
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import { cn } from '@/lib/utils'

  interface Props {
    source: string
    class?: string
  }

  let { source, class: className = '' }: Props = $props()

  /*
   * Every note in the room was typed by another student, so its markup is
   * untrusted and is sanitized in lib/render before it reaches {@html}.
   *
   * The renderer arrives a chunk late. Markdown source is designed to be
   * readable as-is, so the gap shows the source itself rather than a spinner or
   * a blank — the words are on screen either way, and only the formatting
   * settles a frame later.
   */
  loadRenderers()

  const render = $derived(renderers())
  const html = $derived(render ? render.markdown(source ?? '') : null)
</script>

{#if html !== null}
  <div class={cn('prose-note', className)}>
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized in lib/render -->
    {@html html}
  </div>
{:else}
  <div class={cn('prose-note whitespace-pre-wrap', className)}>{source ?? ''}</div>
{/if}
