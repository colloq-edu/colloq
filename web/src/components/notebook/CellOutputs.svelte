<script lang="ts">
  import type { CellOutput } from '@shared/notebook'
  import Icon from '@/components/ui/Icon.svelte'
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

  /**
   * Растровые картинки — те, что показывает `<img>`.
   *
   * Набор тот же, что публикация выносит в отдельные записи (`BLOB_MIMES` в
   * shared/publish.ts), и это не совпадение: вынесенное приезжает сюда не
   * base64, а адресом, а показать адрес умеет только картинка. Список
   * кончался на png и jpeg, так что гифка — единственное, чем показывают
   * обучение по эпохам, — не рисовалась вовсе: `pickMime` её не выбирал.
   */
  const IMG_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

  /*
   * Preference order for a rich result. The second list is what we can show
   * before the sanitizer exists: a data URI needs no sanitizing, and text/plain
   * goes out as text — SVG and HTML wait, because rendering either of them
   * unsanitized is not a trade worth one frame.
   */
  const MIME_ORDER = [...IMG_MIMES, 'image/svg+xml', 'text/html', 'text/plain']
  const MIME_ORDER_PLAIN = [...IMG_MIMES, 'text/plain']

  function pickMime(data: Record<string, string>, rich: boolean): string | null {
    for (const mime of rich ? MIME_ORDER : MIME_ORDER_PLAIN) if (data[mime]) return mime
    return Object.keys(data).find((mime) => mime.startsWith('text/')) ?? null
  }

  /**
   * Не само содержимое, а адрес, по которому оно лежит.
   *
   * Третий случай после base64 и data-URI: на опубликованной странице крупные
   * картинки вынесены в отдельные записи, и в наборе стоит
   * `/api/p/<pub>/blob/<хэш>`.
   *
   * Узнаётся по `/api/`, а не по одной косой черте: base64 любого JPEG
   * начинается с «/9j/» — так кодируется SOI FF D8 FF, — и по косой черте
   * фотография с CV-семинара уходила в src сырым payload'ом, то есть битым
   * значком у всей комнаты. PNG спасала только своя первая буква.
   */
  function isAddress(payload: string): boolean {
    return payload.startsWith('/api/')
  }

  /**
   * Показывать ли эту запись картинкой.
   *
   * Не только по mime. Соседние ветки отдают значение как разметку (SVG, HTML)
   * или как текст, поэтому адрес, попавший в любую из них, напечатался бы
   * строкой «/api/p/…/blob/…» на месте графика. Что именно публикация выносит
   * в записи, решает сервер, и список там может вырасти — а картинкой, взятой
   * по адресу, показывается что угодно из вынесенного.
   */
  function asImage(mime: string, payload: string): boolean {
    return IMG_MIMES.includes(mime) || isAddress(payload)
  }

  /** Kernels send bare base64; a few libraries send a full data URI already. */
  function imageSrc(mime: string, payload: string): string {
    if (payload.startsWith('data:') || isAddress(payload)) return payload
    return `data:${mime};base64,${payload.replace(/\s/g, '')}`
  }

  /**
   * Картинку не режем.
   *
   * Порог считан по строкам текста, а картинка не строки: у обрезанного
   * графика под кромкой остаются нижняя ось и подписи, и кнопка обещает «Show
   * more» — как будто ниже ещё вывод, а не остаток той же картинки. Сетка из
   * make_grid и retina-фигура выше 460 пикселей на семинаре — обычное дело.
   * Таблица и текст схлопываются по-прежнему: у них ниже кромки правда лежит
   * продолжение.
   */
  function isPicture(output: CellOutput, rich: boolean): boolean {
    if (output.kind !== 'data') return false
    const mime = pickMime(output.data, rich)
    return mime !== null && (IMG_MIMES.includes(mime) || mime === 'image/svg+xml')
  }

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
                alt="Cell output"
                class="max-w-full bg-white/95 p-1"
              />
            {:else if mime === 'image/svg+xml' && render}
              <div class="output-svg max-w-full overflow-x-auto bg-white/95 p-1">
                {@html render.svg(payload)}
              </div>
            {:else if mime === 'text/html' && render}
              <div class="output-html overflow-x-auto px-2 py-1 text-code text-ink">
                {@html render.html(payload)}
              </div>
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
            {expanded[i] ? 'Show less' : 'Show more'}
          </button>
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  /*
   * A pandas DataFrame arrives as its own light-theme HTML table. These rules
   * take the borders and text back to the app palette; !important is here
   * because the kernel ships an inline <style> block of its own.
   */
  .output-html :global(table) {
    border-collapse: collapse;
    margin: 2px 0;
  }
  .output-html :global(th),
  .output-html :global(td) {
    border: 1px solid rgb(var(--line)) !important;
    padding: 3px 8px !important;
    color: rgb(var(--ink)) !important;
    text-align: right;
    white-space: nowrap;
  }
  .output-html :global(thead th) {
    background: rgb(var(--raised)) !important;
    color: rgb(var(--muted)) !important;
    font-weight: 600;
  }
  .output-html :global(tbody th) {
    color: rgb(var(--muted)) !important;
    text-align: left;
  }
  .output-html :global(tbody tr:hover td) {
    background: rgb(var(--raised) / 0.55) !important;
  }
  .output-html :global(a) {
    color: rgb(var(--accent));
    text-decoration: underline;
  }
  .output-html :global(pre) {
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap;
  }

  .output-svg :global(svg) {
    max-width: 100%;
    height: auto;
  }
</style>
