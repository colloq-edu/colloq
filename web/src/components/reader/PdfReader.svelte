<!--
  Читалка PDF в комнате.

  Два режима, и они не одно и то же. Смотреть самому может любой — файл комнаты
  и так скачивается кем угодно из неё. Идти за преподавателем — режим просмотра,
  а не замок: любой жест студента снимает следование немедленно, а вернуться
  предлагает плашка. Немедленно, а не по таймеру: программная прокрутка,
  дерущаяся с пальцем на трекпаде, даёт залипание, которое выглядит поломкой.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import type { Lead } from '@/lib/follow'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { getSessionState } from '@/lib/session.svelte'

  interface Props {
    /** Что открыто у этого человека. Может отличаться от того, что у комнаты. */
    file: string
    /** Пришёл ли документ от комнаты — тогда по умолчанию идём за преподавателем. */
    shared: boolean
    /**
     * Счётчик нажатий «догнать» в строке вкладок.
     *
     * Счётчик, а не флаг: догнать можно дважды подряд, а флаг во второй раз не
     * изменится и ничего не произойдёт.
     */
    catchUp: number
    /** Наружу — строке вкладок: она показывает и место, и за кем идём. */
    page: number
    pages: number
    /**
     * За кем идти по этому документу — считает экран, а не читалка.
     *
     * Считалось здесь, и это было ошибкой ровно в одном месте: читалка
     * размонтируется, когда человек уходит в тетрадь, а метка «преподаватель на
     * стр. 4» на вкладке должна оставаться живой и оттуда. Считать её в экране
     * стоит того же, а работает и когда смотреть некому.
     */
    lead: Lead | null
  }

  let { file, shared, catchUp, lead, page = $bindable(1), pages = $bindable(0) }: Props = $props()
  const session = getSessionState()

  let doc = $state<PDFDocumentProxy | null>(null)
  let failure = $state<string | null>(null)
  let scroller = $state<HTMLElement | null>(null)
  /*
   * Умолчание: документ, который поставила комната, смотрят вместе; документ,
   * открытый самому из панели файлов, — сам по себе. Человек пришёл смотреть
   * своё, и утаскивать его на чужую страницу было бы грубо.
   */
  // svelte-ignore state_referenced_locally
  let following = $state(shared)
  /** Ставится, пока страницу двигает код, — чтобы не принять это за жест. */
  let programmatic = false

  onMount(() => {
    let cancelled = false
    void loadPdf()
      .then((pdf) => pdf.open(api.fileRaw(session.session.id, file), session.token))
      .then((opened) => {
        if (cancelled) return
        doc = opened
        pages = opened.numPages
        /*
         * Сказать, где мы, сразу — не дожидаясь прокрутки.
         *
         * Иначе преподаватель, открывший документ и не тронувший его, не
         * публикует позицию вовсе: комната видит доску, но идти не за кем, и
         * ни строки о том, почему. Обычный случай — открыл на первой странице
         * и начал говорить.
         */
        session.setViewing({ file, page: 1, y: 0 })
      })
      .catch(() => {
        if (!cancelled) failure = 'Не удалось открыть этот файл.'
      })
    return () => {
      cancelled = true
      // Освободить память страниц: тридцать отрисованных холстов A4 — это
      // сотни мегабайт, и вкладка, где документ открывали трижды, встаёт.
      // Закрыть документ целиком: `loadingTask.destroy()` останавливает и
      // воркер, и незавершённые запросы кусков. Одного `cleanup` мало — он
      // освобождает страницы, но оставляет транспорт живым.
      void doc?.loadingTask.destroy()
    }
  })

  /** Показать страницу: холст на страницу, отрисовка в воркере. */
  async function draw(node: HTMLCanvasElement, index: number): Promise<void> {
    if (!doc) return
    const source = await doc.getPage(index)
    // Плотность экрана: без неё страница на retina выглядит размытой, как скан.
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const width = node.parentElement?.clientWidth ?? 800
    const base = source.getViewport({ scale: 1 })
    const viewport = source.getViewport({ scale: (width / base.width) * ratio })
    node.width = viewport.width
    node.height = viewport.height
    node.style.width = '100%'
    node.style.height = 'auto'
    const context = node.getContext('2d')
    if (!context) return
    await source.render({ canvas: node, canvasContext: context, viewport }).promise
  }

  function canvas(node: HTMLCanvasElement, index: number) {
    void draw(node, index)
    return { destroy() {} }
  }

  /** Куда прокручено — страницей и долей её высоты. */
  function place(): { page: number; y: number } {
    const root = scroller
    if (!root) return { page: 1, y: 0 }
    const sheets = [...root.querySelectorAll<HTMLElement>('[data-page]')]
    const top = root.scrollTop
    for (const sheet of sheets) {
      const bottom = sheet.offsetTop + sheet.offsetHeight
      if (bottom > top + 4) {
        return {
          page: Number(sheet.dataset.page),
          y: Math.min(1, Math.max(0, (top - sheet.offsetTop) / Math.max(1, sheet.offsetHeight))),
        }
      }
    }
    return { page: pages || 1, y: 0 }
  }

  function goTo(target: { page: number; y: number }, smooth = false): void {
    const root = scroller
    const sheet = root?.querySelector<HTMLElement>(`[data-page="${target.page}"]`)
    if (!root || !sheet) return
    programmatic = true
    root.scrollTo({
      top: sheet.offsetTop + target.y * sheet.offsetHeight,
      behavior: smooth ? 'smooth' : 'auto',
    })
    // Кадр, а не таймер: прокрутка успевает произойти, а жест — ещё нет.
    requestAnimationFrame(() => requestAnimationFrame(() => (programmatic = false)))
  }

  /* Экран идёт за преподавателем. Прыжком, а не плавно: плавность на каждый
     его пиксель превратила бы занятие в непрерывную анимацию. */
  $effect(() => {
    if (!following || !lead || !doc) return
    goTo({ page: lead.page, y: lead.y })
  })

  /*
   * «Догнать» нажали в строке вкладок. Плавно — это единственное место, где
   * плавность уместна: жест человека, а не чужой пиксель прокрутки.
   */
  // svelte-ignore state_referenced_locally
  let caught = catchUp
  $effect(() => {
    if (catchUp === caught) return
    caught = catchUp
    if (!lead) return
    following = true
    goTo({ page: lead.page, y: lead.y }, true)
  })

  function onScroll(): void {
    const here = place()
    page = here.page
    // Свой жест снимает следование. Программную прокрутку за жест не считаем.
    if (!programmatic && following && lead) following = false
    // Своё место — в присутствие, чтобы за этим человеком могли пойти.
    session.setViewing({ file, page: here.page, y: here.y })
  }

/*
 * Позиция НЕ снимается при размонтировании.
 *
 * Читалка исчезает, когда человек переключился на тетрадь, — но место в
 * документе от этого не перестало существовать. Снимать его здесь значило бы:
 * преподаватель на секунду ушёл в тетрадь дописать ячейку — и вся комната
 * потеряла метку «он на странице 4», хотя лекция никуда не делась. Снимает её
 * тот, кто знает, что документ закрыт совсем, — экран комнаты.
 */
</script>

<!--
  Ни шапки, ни нижней плашки: имя файла, номер страницы и «за кем идём» живут в
  строке вкладок над центром. Два места, говорящие одно и то же, расходятся.
-->
<section class="flex min-h-0 flex-1 flex-col bg-surface">
  <div
    bind:this={scroller}
    class="min-h-0 flex-1 overflow-y-auto px-3 py-3"
    onscroll={onScroll}
    role="document"
  >
    {#if failure}
      <p class="p-4 text-ui text-muted">{failure}</p>
    {:else if !doc}
      <!-- Не спиннер, а имя файла: человек знает, что открывает, и видит, что
           это уже происходит. Библиотека и воркер — полтора мегабайта, на
           лекционном вайфае это секунды. -->
      <p class="p-4 text-ui text-muted">Открывается {file}…</p>
    {:else}
      {#each Array.from({ length: pages }, (_, i) => i + 1) as index (index)}
        <div data-page={index} class="mb-3 bg-white shadow-sm">
          <canvas use:canvas={index} class="block w-full"></canvas>
        </div>
      {/each}
    {/if}
  </div>

</section>
