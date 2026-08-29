<!--
  Полоса страниц: миниатюры, по которым прыгают.

  КОЛОНКОЙ, а не накладкой. Накладка была бы дешевле — ширина колонки и есть
  масштаб, и открыть полосу значит перерисовать документ, — но полоса, по которой
  ходят, остаётся открытой, а открытая накладка закрывает собой левую треть
  страницы. Платим перерисовкой ровно там же, где платим за масштаб, и тем же
  способом: место в документе снимается до и возвращается после.

  Закрыта по умолчанию: комнате, которая смотрит слайды подряд, она не нужна ни
  разу. Выбор страницы её НЕ закрывает — по ней обычно ходят несколько раз
  подряд, и закрываться после каждого прыжка значит заставлять открывать снова.

  Своей шапки у полосы нет: и заголовок, и крестик повторяли бы кнопку
  «Страницы» в полосе управления, а два места, говорящие одно и то же,
  расходятся. Закрывает её то же, что открыло.

  Миниатюры рисуются по мере того, как до них доскроллили. Сорок отрисованных
  холстов — это сотни мегабайт, и полоса, которая при открытии считает весь
  документ, хуже полосы, которой нет.
-->
<script lang="ts">
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import type { Lead } from '@/lib/follow'

  interface Props {
    doc: PDFDocumentProxy
    pages: number
    /** Где сейчас смотрящий — эта страница отмечена. */
    page: number
    /** Где преподаватель, если за ним идут: метка его цветом. */
    lead: Lead | null
    onpick: (page: number) => void
  }

  let { doc, pages, page, lead, onpick }: Props = $props()

  /** Ширина миниатюры. Больше — уже не миниатюра, меньше — уже не страница. */
  const WIDTH = 108

  /**
   * Пропорция места под миниатюру — из первой страницы документа.
   *
   * Стоял A4 намертво, и полоса врала на всём, что не A4: лекцию читают по
   * слайдам, а слайд горизонтальный — то есть в полосе висел столбик высоких
   * белых прямоугольников, в каждый из которых потом впечатывалась плоская
   * картинка, и до первой отрисовки полоса показывала документ, которого нет.
   * Считается один раз по первой странице: миниатюра — это место под картинку,
   * а не сама картинка, и разнобой в двести страниц её не касается.
   */
  let aspect = $state('1 / 1.414')
  $effect(() => {
    const source = doc
    let dropped = false
    void source
      .getPage(1)
      .then((first) => {
        if (dropped) return
        const view = first.getViewport({ scale: 1 })
        aspect = `${Math.round(view.width)} / ${Math.round(view.height)}`
      })
      .catch(() => {
        /* документ не читается — полоса и так останется пустой */
      })
    return () => {
      dropped = true
    }
  })

  /*
   * Что уже нарисовано. Обычный Set, а не $state: он не читается разметкой —
   * им пользуется только наблюдатель, чтобы не рисовать одно и то же дважды.
   */
  const drawn = new Set<number>()

  async function paint(node: HTMLCanvasElement, index: number): Promise<void> {
    if (drawn.has(index)) return
    drawn.add(index)
    try {
      const source = await doc.getPage(index)
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const base = source.getViewport({ scale: 1 })
      const viewport = source.getViewport({ scale: (WIDTH / base.width) * ratio })
      node.width = viewport.width
      node.height = viewport.height
      node.style.width = '100%'
      node.style.height = 'auto'
      /*
       * Нарисованная страница знает свою пропорцию сама, а заданная снаружи
       * пропорция места её бы перекрыла: в документе, где после сотни слайдов
       * идёт вертикальное приложение, оно оказалось бы сплющенным в слайд.
       */
      node.style.aspectRatio = 'auto'
      const context = node.getContext('2d')
      if (!context) return
      await source.render({ canvas: node, canvasContext: context, viewport }).promise
    } catch {
      // Страница, которую не удалось нарисовать, остаётся пустым листом — это
      // честнее, чем красная плашка на полосе, по которой просто прыгают.
      drawn.delete(index)
    }
  }

  /**
   * Рисовать, когда до миниатюры дошли глазами.
   *
   * `rootMargin` в две высоты полосы: страница успевает нарисоваться до того,
   * как её видно, и полоса не мигает пустыми листами под пальцем.
   */
  function lazy(node: HTMLCanvasElement, index: number) {
    const watcher = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        watcher.disconnect()
        void paint(node, index)
      },
      { root: node.closest('[data-rail]'), rootMargin: '400px 0px' },
    )
    watcher.observe(node)
    return {
      destroy() {
        watcher.disconnect()
      },
    }
  }

  /* Открытую полосу ведёт текущая страница: пролистал документ — метка на
     месте, а не там, где её оставили. */
  let rail = $state<HTMLElement | null>(null)
  $effect(() => {
    const at = page
    rail?.querySelector(`[data-thumb="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  })
</script>

<div
  class="flex w-[148px] shrink-0 flex-col border-r border-line bg-surface"
  data-rail
  bind:this={rail}
>
  <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
    {#each Array.from({ length: pages }, (_, i) => i + 1) as index (index)}
      {@const here = index === page}
      {@const teacher = lead?.page === index}
      <button
        type="button"
        data-thumb={index}
        class="mb-2 flex w-full items-start gap-1.5 text-left focus-visible:outline-none"
        title={`Страница ${index}`}
        onclick={() => onpick(index)}
      >
        <span
          class="w-4 shrink-0 pt-1 text-right font-mono text-micro tabular-nums {here
            ? 'font-bold text-ink'
            : 'text-faint'}"
        >
          {index}
        </span>
        <span class="relative min-w-0 flex-1">
          <!-- Рамка ставится на обёртку, а не на холст: холст меняет размер,
               когда страница дорисовывается, и рамка на нём дёргалась бы. -->
          <span
            class="block border bg-white transition-colors duration-100 {here
              ? 'border-accent'
              : 'border-line hover:border-faint'}"
          >
            <canvas use:lazy={index} class="block w-full" style={`aspect-ratio: ${aspect}`}></canvas>
          </span>
          {#if teacher && lead}
            <!-- Метка цветом преподавателя: из дизайна, и она отвечает на
                 вопрос «а где сейчас он», не заставляя листать. -->
            <span
              class="absolute -left-1 top-1 h-2 w-2 rounded-full ring-2 ring-surface"
              style={`background:${lead.color}`}
              title={`${lead.name} здесь`}
            ></span>
          {/if}
        </span>
      </button>
    {/each}
  </div>
</div>
