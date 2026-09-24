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
  import { formatNumber, tr } from '@shared/i18n'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import { fileSize } from '@/lib/competition-words'
  import type { EntrantCompetitionView } from '@shared/competitions-entrant'
  import Conditions from './Conditions.svelte'

  interface Props {
    view: EntrantCompetitionView
    phone: boolean
    fileUrl: (name: string) => string
  }

  const { view, phone, fileUrl }: Props = $props()

  loadRenderers()
  const render = $derived(renderers())
  const html = $derived(
    render && view.competition.description ? render.markdown(view.competition.description) : null,
  )
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

    <section class="flex max-w-[720px] flex-col gap-3">
      <h2 class="text-micro font-black uppercase leading-5 tracking-label text-muted">
        {tr('competitions.p.dataTitle')}
      </h2>
      {#if view.files.length === 0}
        <p class="text-2xs text-muted">{tr('competitions.p.noFiles')}</p>
      {:else}
        <div class="flex flex-col border-t border-line">
          {#each view.files as file (file.name)}
            <div class="flex items-center gap-3 border-b border-line py-2.5">
              <a
                class="min-w-0 grow truncate font-mono text-micro text-accent-text hover:underline"
                href={fileUrl(file.name)}
                download
                title={file.name}
              >
                {file.name}
              </a>
              <span class="w-[120px] shrink-0 text-micro text-muted">
                {file.rows === null
                  ? ''
                  : tr('competitions.p.rows', { count: file.rows, n: formatNumber(file.rows) })}
              </span>
              <span class="w-16 shrink-0 text-right text-micro text-muted">
                {fileSize(file.bytes)}
              </span>
            </div>
          {/each}
        </div>
        <p class="text-micro leading-[18px] text-muted">{tr('competitions.p.dataNote')}</p>
      {/if}
    </section>
  </div>

  <aside class="w-full shrink-0 xl:w-[300px]">
    <Conditions competition={view.competition} />
  </aside>
</div>
