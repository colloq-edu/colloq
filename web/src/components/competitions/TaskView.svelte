<script lang="ts">
  /**
   * The "Task and data" tab — the only one the mockup does not have at all.
   *
   * It is assembled from what the mockup promises elsewhere: the statement
   * written by the teacher (a Markdown description, with `$…$` formulas), the
   * open files for download and the same check conditions that stand on the
   * right in the submissions tab. It invents nothing of its own — all of it
   * is already in the door's response.
   *
   * The markup is someone else's: the teacher writes it, and it goes through
   * `{@html}` only after the sanitiser (lib/render.svelte.ts) — the same one
   * the notes in the room go through.
   */
  import { tr } from '@shared/i18n'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import { sealedTarget } from '@/lib/competition-words'
  import type { EntrantCompetitionView } from '@shared/competitions-entrant'
  import Conditions from './Conditions.svelte'
  import DataFiles from './DataFiles.svelte'
  import HowChecked from './HowChecked.svelte'

  interface Props {
    view: EntrantCompetitionView
    phone: boolean
    fileUrl: (name: string) => string
    /** «Скачать всё»: the archive of the open files. */
    zipUrl?: string
  }

  const { view, phone, fileUrl, zipUrl }: Props = $props()

  loadRenderers()
  const render = $derived(renderers())
  const html = $derived(
    render && view.competition.description ? render.markdown(view.competition.description) : null,
  )
  /** The hidden test the steps below the data explain; null — no hidden test, no steps. */
  const target = $derived(sealedTarget(view))
</script>

<div class="flex flex-col gap-8 xl:flex-row xl:gap-12">
  <div class="flex min-w-0 grow flex-col gap-6">
    {#if view.competition.description}
      {#if html}
        <div class="prose-note prose-cell max-w-[720px] leading-relaxed">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html html}
        </div>
      {:else}
        <pre class="max-w-[720px] whitespace-pre-wrap font-sans text-ui-lg leading-6 text-ink">{view
            .competition.description}</pre>
      {/if}
    {:else}
      <p class="text-ui text-muted">{tr('competitions.p.noDescription')}</p>
    {/if}

    <DataFiles files={view.files} sealedFiles={view.sealedFiles ?? []} {fileUrl} {zipUrl} />
    {#if target}
      <HowChecked competition={view.competition} {target} />
    {/if}
  </div>

  <aside class="w-full shrink-0 xl:w-[300px]">
    <Conditions competition={view.competition} sealedFiles={view.sealedFiles ?? []} />
  </aside>
</div>
