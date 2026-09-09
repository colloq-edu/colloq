<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { CellOutput } from '@shared/notebook'
  import Icon from '@/components/ui/Icon.svelte'
  import ScopedOutput from './ScopedOutput.svelte'
  // Что показывать картинкой, что разметкой, что текстом — в своём модуле:
  // список растровых типов там связан с публикацией, а не переписан от руки.
  import { asImage, imageSrc, isPicture, pickMime } from './output-mimes'
  import { loadRenderers, renderers, stripAnsi } from '@/lib/render.svelte'
  import { withoutEcho } from '@/lib/traceback'
  import { cn, collapseCarriage } from '@/lib/utils'
  import { outputKey } from '@/lib/output-seat'

  interface Props {
    outputs: CellOutput[]
    /**
     * Сколько картинок ещё не сообщили свой размер.
     *
     * Наружу — чтобы ячейка не отпустила зарезервированное место раньше, чем
     * появится чем его занять. См. `outputSeat`.
     */
    pending?: number
  }

  let { outputs, pending = $bindable(0) }: Props = $props()

  /**
   * Картинка, которая ещё не раскодировалась.
   *
   * `imageSrc` собирает data-URI, а у `<img>` нет ни width, ни height, ни
   * aspect-ratio — значит, только что созданный элемент занимает нисколько,
   * пока base64 не раскодируется. Без этого счётчика место освобождалось бы в
   * тот кадр, когда массив перестал быть пустым, и комната видела бы три
   * состояния подряд: девятьсот пикселей резерва, восьмипиксельная белая
   * полоска и рывок обратно на девятьсот. То есть ровно тот рывок, от
   * которого избавлялись, только с лишним промежуточным кадром.
   *
   * По событиям load/error, никаких таймеров; и всё это в любом случае
   * ограничено выполнением, потому что резерв живёт только пока `running`.
   */
  function decoding(node: HTMLImageElement) {
    if (node.complete) return
    let counted = true
    pending += 1
    const done = () => {
      if (!counted) return
      counted = false
      pending -= 1
    }
    node.addEventListener('load', done)
    node.addEventListener('error', done)
    return {
      destroy() {
        done()
        node.removeEventListener('load', done)
        node.removeEventListener('error', done)
      },
    }
  }

  /** Roughly twenty-five lines of output — past that a cell starts eating the page. */
  const COLLAPSE_PX = 420

  let heights = $state<number[]>([])
  let expanded = $state<boolean[]>([])

  /*
   * ANSI colouring and HTML sanitising live in lib/render, which is fetched the
   * first time a notebook renders. Until it lands, output still appears — the
   * escape codes are stripped and the text goes out as text. Colour is the only
   * thing missing for that one frame, and a student watching a cell finish
   * cares that it printed, not that it printed in green.
   */
  loadRenderers()

  const render = $derived(renderers())

  function tall(index: number, output: CellOutput): boolean {
    if (isPicture(output, render !== null)) return false
    return (heights[index] ?? 0) > COLLAPSE_PX + 40
  }
</script>

<div class="space-y-1.5">
  <!--
    Ключ по форме места, а не по его номеру: `clear_output(wait=True)` меняет
    N записей на M в одной транзакции, и трейсбек на девятьсот пикселей
    становится графиком на двести внутри той же обёртки с прежним `heights[0]`
    — график рисуется подрезанным, под ним висит «Show more» из ниоткуда.
  -->
  {#each outputs as output, i (outputKey(i, output))}
    {@const clipped = tall(i, output) && !expanded[i]}
    <div class="relative">
      <div class="overflow-hidden" style:max-height={clipped ? `${COLLAPSE_PX}px` : undefined}>
        <div bind:clientHeight={heights[i]}>
          <!-- eslint-disable svelte/no-at-html-tags -- every {@html} below is sanitized in lib/render -->
          {#if output.kind === 'stream'}
            <!-- Прогресс-бар — одна перерисовываемая строка, а не двести
                 напечатанных: см. collapseCarriage. -->
            {@const text = collapseCarriage(output.text)}
            <div
              class={cn(
                'output-stream px-2 py-1',
                // A warning is not a failure. Painting every stderr line in the
                // colour of a crash is how a room learns to ignore the colour of
                // a crash — and pip and matplotlib write to stderr constantly.
                output.name === 'stderr' ? 'text-warning' : 'text-ink/90',
              )}
            >{#if render}{@html render.ansi(text)}{:else}{stripAnsi(text)}{/if}</div>
          {:else if output.kind === 'error'}
            {@const traceback = withoutEcho(output.traceback, output.ename, output.evalue)}
            <div class="px-1 py-0.5">
              <div class="font-mono text-code font-semibold text-danger">
                {output.ename}{output.evalue ? `: ${output.evalue}` : ''}
              </div>
              {#if traceback}
                <div
                  class="output-stream mt-1.5 text-muted"
                >{#if render}{@html render.ansi(traceback)}{:else}{stripAnsi(traceback)}{/if}</div>
              {/if}
            </div>
          {:else}
            {@const mime = pickMime(output.data, render !== null)}
            {@const payload = mime ? output.data[mime] : ''}
            {#if mime && asImage(mime, payload)}
              <!-- Plots are drawn for paper: a transparent figure needs a light
                   backing or its black axes vanish into the canvas. -->
              <img
                use:decoding
                src={imageSrc(mime, payload)}
                alt={tr('room.ui.329')}
                class="max-w-full bg-white/95 p-1"
              />
            {:else if mime === 'image/svg+xml' && render}
              <ScopedOutput
                kind="svg"
                markup={render.svg(payload)}
                class="max-w-full overflow-x-auto bg-white/95 p-1"
              />
            {:else if mime === 'text/html' && render}
              <ScopedOutput
                kind="html"
                markup={render.html(payload)}
                class="overflow-x-auto px-2 py-1 text-code text-ink"
              />
            {:else if mime}
              <div
                class="output-stream px-2 py-1 text-ink/90"
              >{#if render}{@html render.ansi(payload)}{:else}{stripAnsi(payload)}{/if}</div>
            {/if}
          {/if}
          <!-- eslint-enable svelte/no-at-html-tags -->
        </div>
      </div>

      {#if tall(i, output)}
        <div class="mt-1 border-t border-line-soft pt-1">
          <button
            type="button"
            class="inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-medium
                   text-faint transition-colors duration-100 hover:bg-raised hover:text-ink
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onclick={() => (expanded[i] = !expanded[i])}
          >
            <Icon name={expanded[i] ? 'chevron-up' : 'chevron-down'} size={12} />
            {expanded[i] ? tr('room.ui.330') : tr('room.ui.331')}
          </button>
        </div>
      {/if}
    </div>
  {/each}
</div>
