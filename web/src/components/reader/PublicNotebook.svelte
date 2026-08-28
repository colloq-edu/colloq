<!--
  Тетрадь на опубликованной странице.

  Те же ячейки и те же выводы, что в комнате, — и ни одной кнопки, которая
  что-нибудь меняет. Редактора здесь нет вовсе: код показывается подсвеченным
  текстом. Это не «редактор только для чтения», а другой предмет — за страницей
  нет ни документа, ни ядра, и менять в ней нечего.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import CellOutputs from '@/components/notebook/CellOutputs.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { copyText } from '@/lib/clipboard'
  import Code from '@/components/ui/Code.svelte'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import { BLOB_PREFIX, type PublicCell } from '@shared/publish'
  import type { CellOutput } from '@shared/notebook'

  interface Props {
    cells: PublicCell[]
    /** Публикация, чьи картинки раздаются по адресу — см. `blobbed`. */
    publication: string
  }

  let { cells, publication }: Props = $props()

  onMount(() => void loadRenderers())

  const render = $derived(renderers())

  /**
   * Крупные картинки лежат отдельными записями и здесь превращаются в адрес.
   *
   * В странице стоит `blob:<хэш>` — то есть содержимое, вынесенное из JSON,
   * чтобы шесть шагов не несли шесть копий одного графика. Хэш и есть версия,
   * поэтому адрес раздаётся с вечным кэшем.
   */
  function blobbed(output: CellOutput): CellOutput {
    if (output.kind !== 'data') return output
    const data: Record<string, string> = {}
    for (const [mime, value] of Object.entries(output.data)) {
      data[mime] = value.startsWith(BLOB_PREFIX)
        ? `/api/p/${publication}/blob/${value.slice(BLOB_PREFIX.length)}`
        : value
    }
    return { ...output, data }
  }

  let copied = $state<string | null>(null)

  async function copy(cell: PublicCell): Promise<void> {
    await copyText(cell.source)
    copied = cell.id
    setTimeout(() => (copied = copied === cell.id ? null : copied), 1600)
  }

  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
</script>

<div class="flex flex-col gap-6">
  {#each cells as cell (cell.id)}
    {#if cell.type === 'markdown'}
      <!-- Проза семинара — без рамки: она и есть текст страницы. -->
      <div class="prose-cell text-ui-lg leading-relaxed text-ink">
        {#if render}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized in lib/render -->
          {@html render.markdown(cell.source)}
        {:else}
          <p class="whitespace-pre-wrap">{cell.source}</p>
        {/if}
      </div>
    {:else}
      <div class="border border-line bg-canvas">
        <div class="flex items-start gap-3 bg-surface/60 px-4 py-3">
          <Code code={cell.source} lang="python" class="min-w-0 flex-1 text-code-lg leading-relaxed" />
          <!--
            «Скопировать» у каждой ячейки — десять строк и вся разница между
            страницей, которую читают, и страницей, которой пользуются: в самой
            комнате ячейки — отдельные редакторы CodeMirror, и выделить код
            мышью через несколько штук нельзя.
          -->
          <button
            class="mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center border border-line
                   text-muted transition-colors duration-100 hover:border-faint hover:text-ink"
            title={copied === cell.id ? 'Скопировано' : 'Скопировать ячейку'}
            aria-label="Скопировать ячейку"
            onclick={() => void copy(cell)}
          >
            <Icon name={copied === cell.id ? 'check' : 'copy'} size={11} />
          </button>
        </div>

        {#if cell.outputs.length > 0}
          <div class="border-t border-line px-4 py-3">
            <CellOutputs outputs={cell.outputs.map(blobbed)} />
          </div>
        {/if}

        <div
          class="flex items-center justify-end gap-2 border-t border-line bg-surface/60 px-4 py-1.5"
        >
          {#if cell.execCount === null && cell.outputs.length > 0}
            <!--
              Вывод есть, а выполнения за ним уже нет: перезапускали ядро или
              возвращали версию. Промолчать здесь честнее, чем подставить номер.
            -->
            <span class="font-mono text-2xs text-warning">Out [—]</span>
          {:else if cell.execCount !== null}
            <span class="font-mono text-2xs text-muted">
              Out [{cell.execCount}]{cell.ranMs !== null ? ` · ${seconds(cell.ranMs)}` : ''}
            </span>
          {:else}
            <span class="font-mono text-2xs text-faint">не запускалась</span>
          {/if}
        </div>
      </div>
    {/if}
  {/each}
</div>
