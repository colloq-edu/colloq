<!--
  Читалка PDF в комнате.

  Два режима, и они не одно и то же. Смотреть самому может любой — файл комнаты
  и так скачивается кем угодно из неё. Идти за преподавателем — режим просмотра,
  а не замок: любой жест студента снимает следование немедленно, а вернуться
  предлагает плашка. Немедленно, а не по таймеру: программная прокрутка,
  дерущаяся с пальцем на трекпаде, даёт залипание, которое выглядит поломкой.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { onMount } from 'svelte'
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import type { Lead } from '@/lib/follow'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { mayBeFollowed } from '@shared/rules'
  import { fits } from './budget'
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
    /**
     * Идём ли за ведущим прямо сейчас — наружу, в строку вкладок.
     *
     * Она пишет «Идём за …» и предлагает «догнать», а знала об этом только по
     * номеру страницы: отставший на пол-листа читал в читалке «смотрите сами»,
     * а строкой выше — «Идём за Анной». Два индикатора рядом, говорящие
     * противоположное, — хуже одного.
     */
    following?: boolean
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
    following = $bindable(false),
  }: Props = $props()
  const session = getSessionState()

  let doc = $state<PDFDocumentProxy | null>(null)
  let failureRender = $state<() => string | null>(() => null)
  const failure = $derived(failureRender())
  let scroller = $state<HTMLElement | null>(null)

  /**
   * Сколько места занимает лист, который ещё не нарисован.
   *
   * Место обязано быть верным ДО отрисовки: и `place`, и `goTo` меряют высоту
   * листа — по ней идут за преподавателем и по ней же возвращаются на своё
   * место после зума. Пропорция берётся с первой страницы (как в полосе
   * миниатюр) и уточняется по каждой нарисованной: у приложения в конце колоды
   * своя ориентация.
   */
  let aspect = $state('1 / 1.414')
  const ratios = $state<Record<number, string>>({})

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
  /** Ставится, пока страницу двигает код, — чтобы не принять это за жест. */
  let programmatic = false

  onMount(() => {
    let cancelled = false
    let opened: PDFDocumentProxy | null = null
    /*
     * Счётчик страниц в строке вкладок — от ЭТОГО документа с первой секунды.
     *
     * Читалка пересоздаётся на каждую вкладку (`{#key activePath}` в экране
     * комнаты), а `page`/`pages` связаны с экраном и переживают пересоздание:
     * без сброса над новым файлом висело «12 / 40» от прежнего, пока его не
     * прокрутят.
     */
    page = 1
    pages = 0
    /*
     * Умолчание следования: документ, который поставила комната, смотрят
     * вместе; документ, открытый самому из панели файлов, — сам по себе.
     * Человек пришёл смотреть своё, и утаскивать его на чужую страницу было бы
     * грубо.
     */
    following = shared
    void loadPdf()
      .then((pdf) => pdf.open(api.fileRaw(session.session.id, file), session.token))
      .then(async (ready) => {
        opened = ready
        if (cancelled) return
        // Пропорция листа — до первой отрисовки: по высоте листов идут за
        // преподавателем, и колода слайдов, разложенная столбиком A4, увела бы
        // прыжок на страницу мимо.
        const view = (await ready.getPage(1)).getViewport({ scale: 1 })
        if (cancelled) return
        aspect = `${Math.round(view.width)} / ${Math.round(view.height)}`
        doc = ready
        pages = ready.numPages
        /*
         * Место сообщает эффект ниже, а не эта строка.
         *
         * Сказать, где мы, надо сразу — не дожидаясь прокрутки: иначе
         * преподаватель, открывший документ и не тронувший его, не публикует
         * позицию вовсе, комната видит доску, но идти не за кем, и ни строки о
         * том, почему. Обычный случай — открыл на первой странице и начал
         * говорить. Но роль приезжает отдельным кадром и может прийти позже
         * документа, а публикует место только тот, за кем можно пойти, — то
         * есть это не одно событие, а два, и ждать надо оба.
         */
      })
      .catch(() => {
        if (!cancelled) failureRender = () => (tr('room.ui.730'))
      })
    return () => {
      cancelled = true
      // Освободить память страниц: тридцать отрисованных холстов A4 — это
      // сотни мегабайт, и вкладка, где документ открывали трижды, встаёт.
      // Закрыть документ целиком: `loadingTask.destroy()` останавливает и
      // воркер, и незавершённые запросы кусков. Одного `cleanup` мало — он
      // освобождает страницы, но оставляет транспорт живым.
      //
      // По своей переменной, а не по `doc`: документ, доехавший после ухода, в
      // `doc` уже не попадёт — и без этого уносил бы с собой живой воркер.
      void opened?.loadingTask.destroy()
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
  interface Job {
    /** Просьба остановиться: до `render` — флагом, после — отменой задачи. */
    cancel(): void
    /** Разрешается, когда холст свободен. Не отклоняется никогда. */
    free: Promise<void>
  }
  const rendering = new WeakMap<HTMLCanvasElement, Job>()

  /**
   * Показать страницу: холст на страницу, отрисовка в воркере.
   *
   * Место в карте занимается СРАЗУ, до первого `await`. Занималось после
   * `getPage`, и в это окно вторая отрисовка проходила защиту как по пустой
   * карте: она переставляла размеры холста под работающей первой — то есть
   * стирала её и сбивала ей систему координат, — а исключение про «тот же
   * холст» уходило в пустой catch. Страница оставалась пустой или наполовину
   * нарисованной со сдвигом, молча, до следующей смены масштаба.
   */
  async function draw(node: HTMLCanvasElement, index: number): Promise<void> {
    const previous = rendering.get(node)
    let stopped = false
    let task: { cancel(): void } | null = null
    let done!: () => void
    const job: Job = {
      cancel() {
        stopped = true
        task?.cancel()
      },
      free: new Promise<void>((resolve) => (done = resolve)),
    }
    rendering.set(node, job)
    /*
     * Прошлую отрисовку сначала отменить и ДОЖДАТЬСЯ: `cancel()` только просит
     * остановиться, а холст остаётся занятым до тех пор, пока обещание не
     * разрешится. Отказ здесь — обычное дело, это и есть отмена.
     */
    previous?.cancel()
    try {
      await previous?.free
      if (stopped || !doc) return
      const source = await doc.getPage(index)
      if (stopped) return
      // Плотность экрана: без неё страница на retina выглядит размытой, как скан.
      const density = Math.min(window.devicePixelRatio || 1, 2)
      const width = node.parentElement?.clientWidth ?? 800
      const base = source.getViewport({ scale: 1 })
      const css = width / base.width
      // …но плотность — пожелание, а не право: на 250–300% лист выходит за общий
      // бюджет холстов, и WebKit начинает гасить произвольные из них (см.
      // budget.ts и `release`). Мутный лист читается, пустой — нет.
      const ratio = fits(base.width * css, base.height * css, density)
      const viewport = source.getViewport({ scale: css * ratio })
      // Место под лист держит CSS, а не размер буфера: буфер меняется на каждый
      // зум и отдаётся, когда страница уходит с экрана, а высота листа от этого
      // меняться не должна — по ней идут за преподавателем.
      ratios[index] = `${Math.round(base.width)} / ${Math.round(base.height)}`
      node.width = viewport.width
      node.height = viewport.height
      const context = node.getContext('2d')
      if (!context) return
      const started = source.render({ canvas: node, canvasContext: context, viewport })
      task = started
      await started.promise
    } catch {
      // Отменили ради нового масштаба или закрыли документ — не поломка.
    } finally {
      if (rendering.get(node) === job) rendering.delete(node)
      done()
    }
  }

  /**
   * Холст страницы: рисуется, когда до неё доскроллили, и ПЕРЕРИСОВЫВАЕТСЯ при
   * смене масштаба или ширины колонки.
   *
   * Рисовались все сразу, по холсту на страницу, в момент открытия. Колода на
   * сорок слайдов — это сорок буферов по паре мегапикселей (сотни мегабайт) и
   * сорок разборов в одной очереди: вкладка не отвечает секунды, а страница, на
   * которую человек смотрит, приходит последней — «плюс» выглядит сломанным.
   * Масштаб при этом множит буфер квадратично, и на iPad, где бюджет холстов
   * один на процесс, это ровно то переполнение, из-за которого WebKit начинает
   * гасить произвольные холсты (см. `release`). Полоса миниатюр рядом рисует
   * лениво по той же причине, и `disableAutoFetch` в pdf.svelte.ts обещает то
   * же самое: первый кадр сразу, остальное — по мере надобности.
   *
   * `update` действия — единственное место, где Svelte сообщает, что параметр
   * изменился, не пересоздавая узел. Пересоздать холст значило бы на мгновение
   * схлопнуть страницу в ноль высоты — то есть увести прокрутку у всех, кто в
   * этот момент читает.
   */
  interface Sheet {
    index: number
    scale: number
    /** Ширина колонки: холст рисуется по ней, а меняют её не только кнопки. */
    column: number
  }

  function canvas(node: HTMLCanvasElement, args: Sheet) {
    let at = args
    let near = false
    /*
     * Запас в экран с лишним: страница успевает нарисоваться до того, как её
     * видно, и документ не мигает белыми листами под пальцем. Прокрутка берётся
     * с разметки, а не из `scroller`: привязка может ещё не доехать к моменту,
     * когда монтируется холст.
     */
    const watcher = new IntersectionObserver(
      (entries) => {
        const shown = entries.some((entry) => entry.isIntersecting)
        if (shown === near) return
        near = shown
        if (shown) void draw(node, at.index)
        else release(node)
      },
      { root: node.closest('[data-sheets]'), rootMargin: '1200px 0px' },
    )
    watcher.observe(node)
    return {
      update(next: Sheet) {
        if (next.index === at.index && next.scale === at.scale && next.column === at.column) return
        at = next
        if (near) void draw(node, at.index)
      },
      destroy() {
        watcher.disconnect()
        release(node)
      },
    }
  }

  /**
   * Холст отдаёт свой буфер — уходя со страницы или уходя за край экрана.
   *
   * `width = height = 1` — единственное, что заставляет WebKit его отпустить:
   * сборщик мусора отдаёт эти буферы когда угодно, только не вовремя. Бюджет
   * памяти холстов на iPad один НА ПРОЦЕСС, и колода в шестьдесят страниц
   * выбирает его целиком; переполнив его, WebKit начинает рисовать холсты
   * прозрачными — причём произвольные, не обязательно те, что его переполнили.
   * Обнулиться может лист идущей лекции в соседней вкладке, и эта строка
   * защищает не читалку, а его.
   *
   * Высота листа при этом не меняется: её держит `aspect-ratio`, а не буфер.
   */
  function release(node: HTMLCanvasElement): void {
    rendering.get(node)?.cancel()
    node.width = 1
    node.height = 1
  }

  /**
   * Ширина колонки — тот же масштаб, что и кнопки «плюс».
   *
   * Буфер холста считается от фактической ширины листа, а её меняют не только
   * они: полоса страниц забирает 148 пикселей, панель оракула — треть экрана,
   * окно разворачивают. Без наблюдателя страницы оставались нарисованными под
   * прежнюю ширину и растягивались средствами CSS — на проекторе, где плотность
   * экрана единица, текст мутнеет до конца пары, хотя комментарий `toggleRail`
   * обещает перерисовку. С задержкой: тянуть окно мышью — это сотня событий
   * подряд, и платить стоит за последнее.
   */
  let column = $state(0)
  $effect(() => {
    const root = scroller
    if (!root) return
    let later = 0
    const watcher = new ResizeObserver(() => {
      clearTimeout(later)
      later = window.setTimeout(() => (column = root.clientWidth), 150)
    })
    column = root.clientWidth
    watcher.observe(root)
    return () => {
      clearTimeout(later)
      watcher.disconnect()
    }
  })

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
   * ней. Значит, открытие и закрытие стоят перерисовки (её делает наблюдатель
   * ширины выше) — и требуют того же, что и масштаб: снять место в документе до
   * и вернуть после, иначе читающий двадцать четвёртую страницу уезжает в
   * начало от нажатия на «страницы».
   */
  function toggleRail(): void {
    const was = place()
    railOpen = !railOpen
    remember(`colloq.rail.${session.session.id}`, railOpen ? 1 : 0)
    requestAnimationFrame(() => requestAnimationFrame(() => goTo(was)))
  }

  /**
   * Может ли комната пойти за ЭТИМ человеком — и, значит, нужно ли комнате его
   * место.
   *
   * Ведущим `leaderFor` берёт только преподавателя, поэтому место студента не
   * читает никто, а стоит оно кадра присутствия ВСЕЙ комнате — и не одного: у
   * следующего за преподавателем читалка прокручивается программно, то есть на
   * каждый его шаг отвечает своим кадром. На лекции в пятьсот человек один шаг
   * преподавателя разворачивался в пятьсот кадров и двести пятьдесят тысяч
   * доставок; прокрученная страница — в миллионы. Правило одно на обе стороны
   * и живёт в shared/rules.ts, чтобы «кого выбирают ведущим» и «кто публикует
   * место» не разъехались.
   */
  const leads = $derived(mayBeFollowed(session.me.role))

  /**
   * Последнее своё место — тем же способом, каким за ним идут по комнате.
   *
   * Обычная переменная, не `$state`: её читает эффект ниже, и зависеть от неё
   * он не должен — иначе каждая прокрутка будила бы его вместо `onScroll`.
   */
  let seen = { page: 1, y: 0 }

  /*
   * Место уходит в присутствие, когда сошлось двое: документ открылся и роль
   * приехала. Кадры эти независимы, поэтому это эффект, а не строка в onMount:
   * преподавательская кука подтверждается управляющим сокетом и запросто
   * позже, чем pdf.js разберёт первую страницу.
   *
   * Роль сняли посреди пары — место снимается тоже: иначе комната продолжила бы
   * идти за последним, что бывший ведущий успел сообщить.
   */
  $effect(() => {
    if (!doc) return
    if (leads) session.setViewing({ file, page: seen.page, y: seen.y })
    else session.setViewing(null)
  })

  function onScroll(): void {
    const here = place()
    page = here.page
    // Свой жест снимает следование. Программную прокрутку за жест не считаем.
    if (!programmatic && following && lead) following = false
    seen = here
    // Своё место — в присутствие, чтобы за этим человеком могли пойти. За тем,
    // за кем идти нельзя, никто и не пойдёт: его кадр — чистый расход.
    if (leads) session.setViewing({ file, page: here.page, y: here.y })
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
      aria-label={tr('room.ui.720')}
      title={tr('room.ui.156')}
      onclick={toggleRail}
    >
      <Icon name="text" size={12} /> {tr('room.ui.206')} </button>

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
      aria-label={tr('room.ui.721')}
      title={tr('room.ui.721')}
      onclick={() => step(-1)}
    >
      −
    </button>
    <button
      type="button"
      class="flex w-16 shrink-0 items-center justify-center font-mono text-2xs tabular-nums
             text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none
             focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      title={tr('room.ui.722')}
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
      aria-label={tr('room.ui.723')}
      title={tr('room.ui.723')}
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
        title={tr('room.ui.724')}
        onclick={() => backToLecture?.()}
      >
        <Icon name="board" size={12} /> {tr('room.ui.725')} </button>
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
        title={tr('room.ui.726')}
        onclick={() => session.send({ t: 'lecture:start', file })}
      >
        <Icon name="pencil" size={12} /> {tr('room.ui.444')} </button>
    {/if}

    {#if !following && lead}
      <!-- Отстал намеренно: следование снимается любым своим жестом, и сказать
           об этом надо там же, где кнопки, а не только в строке вкладок. -->
      <span class="flex shrink-0 items-center gap-1.5 px-4 text-2xs text-muted">
        <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span> {tr('room.ui.727')} </span>
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
      data-sheets
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
      <p class="p-4 text-ui text-muted">{tr('room.ui.728')} {file}…</p>
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
          <!-- Пропорция на холсте, а не размер буфера: у ненарисованного листа
               высота обязана быть настоящей, иначе прыжок на страницу и место
               после зума считаются по пустоте. -->
          <canvas
            use:canvas={{ index, scale, column }}
            class="block w-full"
            style={`aspect-ratio: ${ratios[index] ?? aspect}`}
          ></canvas>
        </div>
      {/each}
    {/if}
    </div>
  </div>
</section>
