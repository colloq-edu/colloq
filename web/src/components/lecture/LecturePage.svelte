<!--
  Одна страница, вписанная в отведённое место.

  Читалка кладёт страницы в столбик и прокручивает их; лекция показывает ровно
  одну и целиком — это разные задачи, и вторая проще: нет прокрутки, нет
  масштаба, есть прямоугольник и лист, который в него вписан.

  Вписан ПО ОБЕИМ сторонам, а не по ширине: на проекторе 16:9, а слайд бывает
  4:3 и A4, и страница, вписанная по ширине, уезжает низом за край экрана — то
  есть последняя строка слайда не видна залу. Незаметно для того, кто ведёт: у
  него на планшете другая пропорция.

  Своё место компонент отдаёт наружу: чернила обязаны лечь ровно на лист, а не
  на контейнер вокруг него, иначе они разъедутся с текстом на любом экране,
  пропорция которого отличается от страницы.
-->
<script lang="ts">
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import type { Snippet } from 'svelte'

  interface Props {
    doc: PDFDocumentProxy | null
    page: number
    /**
     * Что положить поверх листа — ровно по его границам.
     *
     * Размер листа передаётся внутрь, а не меряется там заново: слой чернил
     * обязан совпадать с листом пиксель в пиксель, а два измерения одного и того
     * же расходятся — сначала на кадр, а на планшете, где кадры приходят по
     * мере видимости вкладки, и навсегда.
     */
    over?: Snippet<[{ w: number; h: number }]>
    /** Тише и мельче: следующая страница на пульте. */
    dim?: boolean
  }

  let { doc, page, over, dim = false }: Props = $props()

  let box = $state<HTMLDivElement | null>(null)
  let canvas = $state<HTMLCanvasElement | null>(null)
  let room = $state({ w: 0, h: 0 })
  /**
   * Пропорция страницы — из самой страницы, а не из предположения.
   *
   * Умолчанием тут стоял A4, и это была ошибка: лекции читают по слайдам, а
   * слайд ГОРИЗОНТАЛЬНЫЙ. Лист, нарисованный вертикальным до прихода настоящих
   * размеров, прыгал на первом же кадре, а на проекторе прыжок во весь экран
   * видит вся аудитория. Пока не знаем — не рисуем ничего: полкадра пустоты
   * честнее полкадра неправды.
   */
  let aspect = $state<number | null>(null)

  /**
   * Сколько места отведено. Меряется сразу и потом по наблюдателю.
   *
   * Сразу — потому что ResizeObserver сообщает о размере в такте отрисовки, а
   * его у вкладки может не быть: браузер не рисует фоновые вкладки вовсе.
   * Проекция, открытая вторым окном и не получившая фокуса, оставалась в этом
   * случае пустой — размер приходил только после того, как в неё щёлкнут.
   */
  function measure(node: HTMLElement): void {
    const rect = node.getBoundingClientRect()
    const next = { w: Math.round(rect.width), h: Math.round(rect.height) }
    if (next.w !== room.w || next.h !== room.h) room = next
  }

  $effect(() => {
    const node = box
    /*
     * Пропорция читается НАРОЧНО: она приезжает вместе с документом, то есть
     * через сотни миллисекунд после появления компонента и заведомо после того,
     * как дерево вставлено в страницу. Это единственный момент, про который
     * точно известно, что мерить уже есть что, — и он же единственный, который
     * работает во вкладке без отрисовки: там ни наблюдатель за размером, ни
     * кадры не приходят вовсе, а проекция чаще всего именно такая — второе окно,
     * которому не давали фокуса.
     */
    void aspect
    if (!node) return
    /*
     * Три измерения на одно место, и каждое закрывает свой случай.
     *
     * Сразу — для обычной перерисовки. Микрозадачей — для первого кадра: эффект
     * дочернего компонента выполняется ДО того, как родитель вставит своё
     * дерево в документ, а у элемента вне документа размер нулевой, и первый
     * замер честно возвращает ноль. Наблюдателем — для поворота планшета и
     * Split View, где размер меняется без всякой перерисовки.
     */
    let alive = true
    measure(node)
    queueMicrotask(() => {
      if (alive) measure(node)
    })
    const watch = new ResizeObserver(() => measure(node))
    watch.observe(node)
    return () => {
      alive = false
      watch.disconnect()
    }
  })

  /*
   * Пропорция узнаётся отдельно от отрисовки: размер листа нужен раньше, чем
   * появится, во что рисовать, а отрисовка ждёт размера. Одним эффектом это
   * замыкается само на себя.
   */
  $effect(() => {
    const source = doc
    /*
     * У чистого листа своей страницы в документе нет (см. shared/lecture.ts):
     * пропорцию он берёт у первой — чтобы белое поле было той же формы, что и
     * слайды, и лекция не меняла бы формат посреди себя.
     */
    const index = page < 0 ? 1 : page
    if (!source) return
    let dropped = false
    void source
      .getPage(index)
      .then((sheet) => {
        if (dropped) return
        const base = sheet.getViewport({ scale: 1 })
        aspect = base.width / base.height
      })
      .catch(() => {
        /* страницы нет — рисовать нечего, и пустой лист об этом и говорит */
      })
    return () => {
      dropped = true
    }
  })

  /** Место листа внутри отведённого прямоугольника: вписываем по обеим сторонам. */
  const fit = $derived.by(() => {
    const { w, h } = room
    if (w === 0 || h === 0 || aspect === null) return { w: 0, h: 0 }
    const byWidth = { w, h: w / aspect }
    return byWidth.h <= h ? byWidth : { w: h * aspect, h }
  })

  /**
   * Отрисовка. Отменяет предыдущую: страницу листают быстрее, чем считается
   * A4, и pdf.js отказывается рисовать в занятый холст — «Cannot use the same
   * canvas during multiple render() operations».
   */
  let running: { cancel(): void; promise: Promise<unknown> } | null = null

  $effect(() => {
    const node = canvas
    const source = doc
    const index = page
    const { w, h } = fit
    if (!node || w === 0) return
    if (index < 0) {
      /*
       * Чистый лист. Холст гасится, а белым его делает подложка: рисовать
       * пустоту незачем, но и оставлять на холсте прошлый слайд нельзя — под
       * чернилами проступил бы текст страницы, с которой на него ушли.
       */
      const paint = node.getContext('2d')
      if (paint) paint.clearRect(0, 0, node.width, node.height)
      return
    }
    if (!source) return

    let dropped = false
    void (async () => {
      const previous = running
      if (previous) {
        previous.cancel()
        await previous.promise.catch(() => {})
      }
      if (dropped) return
      const sheet = await source.getPage(index).catch(() => null)
      if (!sheet || dropped) return
      const base = sheet.getViewport({ scale: 1 })
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = sheet.getViewport({ scale: (w / base.width) * ratio })
      /*
       * Присвоение width/height стирает и пиксели, и состояние контекста — и
       * делает это даже когда значение то же самое. Поэтому только при
       * настоящей смене размера: поворот планшета иначе гасил бы страницу на
       * ровном месте.
       */
      if (node.width !== Math.round(viewport.width) || node.height !== Math.round(viewport.height)) {
        node.width = Math.round(viewport.width)
        node.height = Math.round(viewport.height)
      }
      const paint = node.getContext('2d')
      if (!paint) return
      const task = sheet.render({ canvas: node, canvasContext: paint, viewport })
      running = task
      try {
        await task.promise
      } catch {
        // Отменили ради следующей страницы — обычный ход дела.
      } finally {
        if (running === task) running = null
      }
    })()

    return () => {
      dropped = true
    }
  })
</script>

<div bind:this={box} class="relative flex min-h-0 min-w-0 flex-1 items-center justify-center">
  <!-- Лист и всё, что на нём, — одним блоком: слой чернил обязан совпадать с
       листом пиксель в пиксель, а не с контейнером вокруг. -->
  <div
    class="relative shadow-pop {dim ? 'opacity-70' : ''}"
    style={`width:${fit.w}px;height:${fit.h}px;background:#fff`}
  >
    <canvas bind:this={canvas} class="block h-full w-full"></canvas>
    {@render over?.(fit)}
  </div>
</div>
