<!--
  A markdown text with «Текст / Просмотр» (Paper 19 · A2, A3): the contest's
  introduction and a problem's statement.

  The preview is the participant's renderer (lib/render.svelte.ts) — the same
  sanitizing, the same KaTeX — so a formula that breaks here breaks on the
  problem page too, and is seen before the class sees it. The chunk is asked
  for only when the preview is opened: a teacher who never looks does not pay
  for marked and KaTeX.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import { cn } from '@/lib/utils'

  interface Props {
    value: string
    /** The field's accessible name. */
    label: string
    placeholder?: string
    maxlength: number
    /** Taller for a statement than for an introduction. */
    rows?: number
  }

  let { value = $bindable(), label, placeholder = '', maxlength, rows = 6 }: Props = $props()

  let previewing = $state(false)
  const rendered = $derived(previewing ? (renderers()?.markdown(value) ?? null) : null)

  $effect(() => {
    if (previewing) void loadRenderers().catch(() => undefined)
  })
</script>

<div class="border border-line">
  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2">
    <button
      type="button"
      class={cn('text-micro font-bold uppercase tracking-caps', previewing ? 'text-faint hover:text-muted' : 'text-ink')}
      aria-pressed={!previewing}
      onclick={() => (previewing = false)}
    >
      {tr('admin.contests.md.text')}
    </button>
    <button
      type="button"
      class={cn('text-micro font-bold uppercase tracking-caps', previewing ? 'text-ink' : 'text-faint hover:text-muted')}
      aria-pressed={previewing}
      onclick={() => (previewing = true)}
    >
      {tr('admin.contests.md.preview')}
    </button>
    <span class="ml-auto text-micro text-muted">{tr('admin.contests.md.hint')}</span>
  </div>
  {#if previewing}
    <div class="prose-note px-3 py-3" style:min-height="{rows * 20 + 24}px">
      {#if value.trim() === ''}
        <p class="text-ui text-muted">{tr('admin.contests.md.empty')}</p>
      {:else if rendered === null}
        <div class="flex flex-col gap-2.5 pt-1" role="status" aria-busy="true" aria-label={tr('admin.contests.md.loading')}>
          <span class="sr-only">{tr('admin.contests.md.loading')}</span>
          {#each ['92%', '84%', '96%', '58%'] as width, i (i)}
            <Skeleton {width} height="0.75rem" />
          {/each}
        </div>
      {:else}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html rendered}
      {/if}
    </div>
  {:else}
    <textarea
      class="block w-full resize-y bg-canvas px-3 py-3 font-mono text-micro leading-5 text-ink focus:outline-none"
      {rows}
      aria-label={label}
      {placeholder}
      {maxlength}
      spellcheck="false"
      bind:value
    ></textarea>
  {/if}
</div>
