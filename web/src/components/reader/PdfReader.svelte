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
  import ConsoleLink from '@/components/lecture/ConsoleLink.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import type { Lead } from '@/lib/follow'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import PageRail from './PageRail.svelte'

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
    /** Может ли этот человек начать по документу лекцию. */
    mayLead?: boolean
    /** Лекция по этому документу идёт, а он ушёл читать сам, — как вернуться. */
    backToLecture?: (() => void) | null
  }

  let {
    file,
    shared,
    catchUp,
    lead,
    mayLead = false,
    backToLecture = null,
    page = $bindable(1),
    pages = $bindable(0),
  }: Props = $props()
  const session = getSessionState()

  let doc = $state<PDFDocumentProxy | null>(null)
  let failure = $state<string | null>(null)
  let scroller = $state<HTMLElement | null>(null)

  /*
   * Масштаб считается ОТ ШИРИНЫ КОЛОНКИ, а не от размера страницы в пунктах.
   *
   * Сто процентов — это «страница по ширине»: то, ради чего читалку и
   * открывают, и то, что не приходится настраивать. Всё остальное — множитель к
   * этому. Масштаб «как в акробате», где сто процентов означают физический
   * размер листа, в колонке шириной в пол-экрана не значит ничего.
   */
  const STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]
  let scale = $state(read(`colloq.zoom.${session.session.id}`, 1))
  let railOpen = $state(read(`colloq.rail.${session.session.id}`, 0) === 1)

  function read(key: string, fallback: number): number {
    try {
      const raw = localStorage.getItem(key)
      const value = raw === null ? NaN : Number(raw)
      return Number.isFinite(value) ? value : fallback
    } catch {
      return fallback
    }
  }

  function remember(key: string, value: number): void {
    try {
      localStorage.setItem(key, String(value))
    } catch {
      /* приватный режим — масштаб просто не переживёт заход */
    }
  }

  /**
   * Сменить масштаб, не потеряв место в документе.
   *
   * Прокрутка держится за пиксели, а масштаб их меняет: без этого страница
   * двадцать четыре уезжала бы к началу от одного нажатия на «плюс». Место
   * снимается страницей и долей её высоты — тем же способом, которым за ним
   * идут по комнате.
   */
  function zoom(next: number): void {
    const wanted = Math.min(3, Math.max(0.5, next))
    if (wanted === scale) return
    const was = place()
    scale = wanted
    remember(`colloq.zoom.${session.session.id}`, wanted)
    // Кадр: холсты успевают пересобраться, и только потом можно мерить высоты.
    requestAnimationFrame(() => requestAnimationFrame(() => goTo(was)))
  }

  function step(direction: -1 | 1): void {
    const at = STEPS.findIndex((value) => value >= scale - 0.001)
    const next = direction === 1 ? STEPS[Math.min(STEPS.length - 1, at + 1)] : STEPS[Math.max(0, at - 1)]
    zoom(next ?? scale)
  }
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

  /**
   * Отрисовка, которая идёт в этот холст прямо сейчас.
   *
   * pdf.js отказывается рисовать во второй раз в тот же холст, пока не
   * закончилась первая: «Cannot use the same canvas during multiple render()
   * operations». А масштаб переключают быстрее, чем считается страница A4, —
   * два нажатия на «плюс» подряд и есть тот самый второй раз.
   */
  const rendering = new WeakMap<HTMLCanvasElement, { cancel(): void; promise: Promise<unknown> }>()

  /** Показать страницу: холст на страницу, отрисовка в воркере. */
  async function draw(node: HTMLCanvasElement, index: number): Promise<void> {
    /*
     * Прошлую отрисовку сначала отменить и ДОЖДАТЬСЯ: `cancel()` только просит
     * остановиться, а холст остаётся занятым до тех пор, пока обещание не
     * разрешится. Отказ здесь — обычное дело, это и есть отмена.
     */
    const previous = rendering.get(node)
    if (previous) {
      previous.cancel()
      await previous.promise.catch(() => {})
    }
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
    const task = source.render({ canvas: node, canvasContext: context, viewport })
    rendering.set(node, task)
    try {
      await task.promise
    } catch {
      // Отменили ради нового масштаба или закрыли документ — не поломка.
    } finally {
      if (rendering.get(node) === task) rendering.delete(node)
    }
  }

  /**
   * Холст страницы: рисуется при появлении и ПЕРЕРИСОВЫВАЕТСЯ при смене
   * масштаба.
   *
   * `update` действия — единственное место, где Svelte сообщает, что параметр
   * изменился, не пересоздавая узел. Пересоздать холст значило бы на мгновение
   * схлопнуть страницу в ноль высоты — то есть увести прокрутку у всех, кто в
   * этот момент читает.
   */
  function canvas(node: HTMLCanvasElement, args: { index: number; scale: number }) {
    let at = args
    void draw(node, at.index)
    return {
      update(next: { index: number; scale: number }) {
        if (next.index === at.index && next.scale === at.scale) return
        at = next
        void draw(node, at.index)
      },
      destroy() {},
    }
  }

  /**
   * Где лежит лист ВНУТРИ прокрутки.
   *
   * По прямоугольникам, а не по `offsetTop`: тот меряется от ближайшего
   * позиционированного предка, а им оказалась вся секция читалки — вместе с
   * полосой управления над прокруткой. Тридцать четыре пикселя её высоты
   * прибавлялись к каждому прыжку: страница уезжала выше края, и вместо её
   * начала было видно конец предыдущей.
   */
  function topOf(sheet: HTMLElement, root: HTMLElement): number {
    return sheet.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
  }

  /** Куда прокручено — страницей и долей её высоты. */
  function place(): { page: number; y: number } {
    const root = scroller
    if (!root) return { page: 1, y: 0 }
    const sheets = [...root.querySelectorAll<HTMLElement>('[data-page]')]
    const top = root.scrollTop
    for (const sheet of sheets) {
      const at = topOf(sheet, root)
      const bottom = at + sheet.offsetHeight
      if (bottom > top + 4) {
        return {
          page: Number(sheet.dataset.page),
          y: Math.min(1, Math.max(0, (top - at) / Math.max(1, sheet.offsetHeight))),
        }
      }
    }
    return { page: pages || 1, y: 0 }
  }

  function goTo(target: { page: number; y: number }, smooth = false): void {
    const root = scroller
    const sheet = root?.querySelector<HTMLElement>(`[data-page="${target.page}"]`)
    if (!root || !sheet) return
    const at = topOf(sheet, root)
    /*
     * Начало страницы должно быть ВИДНО.
     *
     * Прыжок ровно на верхний край прижимает лист к кромке окна: видно, что
     * что-то сменилось, и не видно, где страница началась. Поэтому отступ на
     * поле — те же двенадцать пикселей, которыми лист отбит от края всегда.
     *
     * А страницу, которая целиком помещается в окно, ставим посередине: у неё
     * не бывает «начала сверху», ей нужен воздух с обеих сторон.
     */
    const gap = 12
    const fits = sheet.offsetHeight + gap * 2 <= root.clientHeight
    const centred = at - (root.clientHeight - sheet.offsetHeight) / 2
    const top =
      target.y > 0
        ? at + target.y * sheet.offsetHeight
        : fits
          ? Math.max(0, centred)
          : Math.max(0, at - gap)
    programmatic = true
    root.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
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

  /**
   * Открыть или закрыть полосу страниц.
   *
   * Полоса — колонка, а ширина колонки и есть масштаб: страница рисуется по
   * ней. Значит, открытие и закрытие стоят перерисовки — и требуют того же, что
   * и масштаб: снять место в документе до и вернуть после, иначе читающий
   * двадцать четвёртую страницу уезжает в начало от нажатия на «страницы».
   */
  function toggleRail(): void {
    const was = place()
    railOpen = !railOpen
    remember(`colloq.rail.${session.session.id}`, railOpen ? 1 : 0)
    requestAnimationFrame(() => requestAnimationFrame(() => goTo(was)))
  }

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
<section class="relative flex min-h-0 flex-1 flex-col bg-surface">
  <!--
    Полоса управления читалкой — там же, где у тетради Run All, а у скрипта
    «Запустить»: у каждой вкладки своя, и она всегда под строкой вкладок.
    Номер страницы сюда не переезжает: он живёт в строке вкладок, и два места,
    говорящие одно и то же, расходятся.
  -->
  <div class="flex h-[34px] shrink-0 items-stretch border-b border-line bg-canvas">
    <button
      type="button"
      class="flex shrink-0 items-center gap-2 px-4 text-2xs font-bold uppercase tracking-label
             transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-inset focus-visible:ring-accent/40
             {railOpen ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}"
      aria-pressed={railOpen}
      aria-label="Полоса страниц"
      title="Страницы — прыгнуть к нужной"
      onclick={toggleRail}
    >
      <Icon name="text" size={12} />
      Страницы
    </button>

    <span class="my-2 w-px bg-line" aria-hidden="true"></span>

    <!--
      Минус, доля, плюс. Доля — кнопка: нажатие возвращает «по ширине», и это
      единственный масштаб, который не приходится выбирать.
    -->
    <button
      type="button"
      class="flex w-9 shrink-0 items-center justify-center text-ui text-muted transition-colors
             duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-inset focus-visible:ring-accent/40 disabled:opacity-40"
      disabled={scale <= 0.5}
      aria-label="Мельче"
      title="Мельче"
      onclick={() => step(-1)}
    >
      −
    </button>
    <button
      type="button"
      class="flex w-16 shrink-0 items-center justify-center font-mono text-2xs tabular-nums
             text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none
             focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      title="По ширине"
      onclick={() => zoom(1)}
    >
      {Math.round(scale * 100)}%
    </button>
    <button
      type="button"
      class="flex w-9 shrink-0 items-center justify-center text-ui text-muted transition-colors
             duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-inset focus-visible:ring-accent/40 disabled:opacity-40"
      disabled={scale >= 3}
      aria-label="Крупнее"
      title="Крупнее"
      onclick={() => step(1)}
    >
      +
    </button>

    <span class="flex-1"></span>

    {#if backToLecture}
      <!--
        Лекция по этому документу идёт прямо сейчас, а этот человек отошёл
        читать сам. Дорога назад обязана быть там же, где он ушёл, — иначе
        «Читать самому» это дверь в одну сторону до конца пары.
      -->
      <button
        type="button"
        class="flex shrink-0 items-center gap-2 px-4 text-2xs font-bold uppercase tracking-label
               text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none
               focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        title="Вернуться к странице, на которой ведущий"
        onclick={() => backToLecture?.()}
      >
        <Icon name="board" size={12} />
        К лекции
      </button>
    {:else if mayLead}
      <!--
        Начать лекцию. Кнопка стоит в читалке, а не в панели файлов, потому что
        решение это не про файл, а про то, что с ним делают: тот же PDF минуту
        назад листали молча, а теперь по нему ведут пару.
      -->
      <button
        type="button"
        class="flex shrink-0 items-center gap-2 px-4 text-2xs font-bold uppercase tracking-label
               text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none
               focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        title="Вести по этому документу лекцию: страница, перо и указка — у вас"
        onclick={() => session.send({ t: 'lecture:start', file })}
      >
        <Icon name="pencil" size={12} />
        Лекция
      </button>
      <!--
        Ссылка на пульт стоит рядом с «Лекцией», а не только внутри неё: пульт
        нужен ДО начала — планшет берут в руки, а лекцию начинают уже с него.
      -->
      <ConsoleLink
        class="flex shrink-0 items-center gap-2 px-4 text-2xs font-bold uppercase tracking-label
               text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none
               focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      />
    {/if}

    {#if !following && lead}
      <!-- Отстал намеренно: следование снимается любым своим жестом, и сказать
           об этом надо там же, где кнопки, а не только в строке вкладок. -->
      <span class="flex shrink-0 items-center gap-1.5 px-4 text-2xs text-muted">
        <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span>
        смотрите сами
      </span>
    {/if}
  </div>

  <div class="flex min-h-0 flex-1">
    {#if doc && railOpen}
      <PageRail
        {doc}
        {pages}
        {page}
        {lead}
        onpick={(target) => {
          /*
           * Прыжком, а не плавно, и это не экономия. «Догнать» плавно — потому
           * что это поправка на страницу-другую, и видно, куда уехали. Выбор в
           * полосе — это переход куда угодно, хоть на двухсотую: анимировать
           * его значит показать полминуты пролетающих страниц вместо той, за
           * которой пришли.
           *
           * И полоса при этом ОСТАЁТСЯ открытой: по ней ходят несколько раз
           * подряд, и закрываться после каждого прыжка — значит заставлять
           * открывать её снова.
           */
          goTo({ page: target, y: 0 })
        }}
      />
    {/if}
    <div
      bind:this={scroller}
      class="min-h-0 min-w-0 flex-1 overflow-auto px-3 py-3"
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
        <!-- Ширина листа — и есть масштаб: страница рисуется по ширине своего
             места. Крупнее колонки — появляется горизонтальная прокрутка, и
             это единственный честный способ показать увеличенное. -->
        <div
          data-page={index}
          class="mx-auto mb-3 bg-white shadow-sm"
          style={`width:${scale * 100}%`}
        >
          <canvas use:canvas={{ index, scale }} class="block w-full"></canvas>
        </div>
      {/each}
    {/if}
    </div>
  </div>
</section>
