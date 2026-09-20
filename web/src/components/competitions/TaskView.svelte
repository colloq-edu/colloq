<script lang="ts">
  /**
   * Вкладка «Задача и данные» — единственная, которой в макете нет вовсе.
   *
   * Собрана из того, что макет обещает в других местах: условие, написанное
   * преподавателем (описание в Markdown, с формулами `$…$`), открытые файлы на
   * скачивание и те же условия проверки, что стоят справа во вкладке посылок.
   * Ничего своего она не придумывает — всё это уже есть в ответе двери.
   *
   * Разметка чужая: её пишет преподаватель, и через `{@html}` она проходит
   * только после санитайзера (lib/render.svelte.ts) — того же самого, через
   * который проходят заметки в комнате.
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
      <h2 class="text-[11px] font-black uppercase leading-[14px] tracking-label text-muted">
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

  {#if !phone}
    <aside class="w-full shrink-0 xl:w-[300px]">
      <Conditions competition={view.competition} />
    </aside>
  {/if}
</div>
