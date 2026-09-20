<!--
  График plotly — во фрейме-песочнице, а не в странице занятия.

  Почему именно так, написано в `shared/plotly.ts` и `server/src/plotly-frame.ts`;
  здесь — сторона тетради. Три вещи, которые она делает и которых нет в рамке:

  ЛЕНИВОСТЬ. Рамка не заводится, пока график не подъехал к экрану, а фигура не
  качается, пока не заведена рамка. Тетрадь с двадцатью графиками иначе тянула
  бы двадцать копий пятимегабайтного бандла и двадцать фигур в первую же
  секунду — при том что на экране помещаются полтора.

  МЕСТО ПОД ГРАФИК. Высота считается ДО того, как что-либо загрузится
  (`figureHeight`), и подложка рисуется сразу в размер: иначе тетрадь прыгает
  под курсором каждый раз, когда очередная рамка доехала. Белая подложка — та
  же, что у картинок matplotlib, и она же убирает белую вспышку: сама рамка
  прозрачная.

  СЛОВА ВМЕСТО ПУСТОТЫ. Не нарисовалось — строка с причиной. Пустое место под
  «Out [7]» читается как «код ничего не вывел», и это враньё.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import {
    PLOTLY_DEFAULT_HEIGHT,
    PLOTLY_FRAME_PATH,
    PLOTLY_MSG,
    PLOTLY_ORIGIN_PARAM,
    figureHeight,
    isPlotlyMessage,
    normalizeFigure,
    type PlotlyFigure,
  } from '@shared/plotly'

  interface Props {
    /**
     * Фигура: текст JSON, если она лежит в документе, или адрес, если она
     * вынесена в отдельную запись (крупные — всегда, см. `SPILL_MIMES`).
     */
    payload: string
    /** Адрес — значит, за фигурой надо сходить; иначе она уже здесь. */
    address: boolean
    /**
     * Ключ в адресе протух — тот же случай, что у картинок: комната открыта
     * полтора часа, ключ живёт пять минут. Тетрадь берёт новый и перерисовывает
     * запись с новым адресом; звать это больше одного раза на запись нельзя.
     */
    onstale?: () => void
  }

  let { payload, address, onstale }: Props = $props()

  /**
   * Фигура, приведённая к `{data, layout, frames}`; `null` — читать нечего.
   *
   * `$state.raw`, а не обычное состояние, и это не оптимизация: обычное Svelte
   * оборачивает в Proxy ВСЮ глубину объекта, а `postMessage` клонирует
   * структурно и на Proxy падает с DataCloneError. Меняется она целиком, так
   * что следить за её внутренностями и незачем.
   */
  let figure = $state.raw<PlotlyFigure | null>(null)
  /** Причина, по которой графика не будет. Показывается словами. */
  let failure = $state<string | null>(null)
  /** График нарисован: рамка сказала свою высоту. До этого видна заставка. */
  let drawn = $state(false)
  /** Подъехал ли вывод к экрану. До этого не заводится вообще ничего. */
  let near = $state(false)

  let frame = $state<HTMLIFrameElement | null>(null)
  /** Высота: из фигуры до отрисовки, от рамки — после. */
  let height = $state(PLOTLY_DEFAULT_HEIGHT)
  /** Чтобы не просить новый ключ по кругу на записи, которой на сервере нет. */
  let asked = false

  const src = $derived(
    `${PLOTLY_FRAME_PATH}?${PLOTLY_ORIGIN_PARAM}=${encodeURIComponent(location.origin)}`,
  )

  /**
   * Наблюдатель видимости — один корень на всю тетрадь не нужен: запас в
   * пол-экрана снизу даёт рамке время загрузиться до того, как до неё
   * долистали, и не трогает то, что лежит страницами ниже.
   */
  function watch(node: HTMLElement) {
    if (typeof IntersectionObserver !== 'function') {
      near = true
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        near = true
        // Обратно не выключаем: выгруженная рамка потеряла бы масштаб и
        // положение легенды, которые человек только что выставил руками.
        observer.disconnect()
      },
      { rootMargin: '400px 0px' },
    )
    observer.observe(node)
    return { destroy: () => observer.disconnect() }
  }

  /** Разобрать то, что лежит в документе, — или сходить за тем, что вынесено. */
  $effect(() => {
    const body = payload
    const remote = address
    if (!near) return
    let alive = true
    failure = null
    if (!remote) {
      // Через местную переменную: прочитать только что записанное состояние
      // прямо в эффекте — это цикл обновления, и Svelte роняет его вслух.
      const here = read(body)
      figure = here
      failure = here ? null : tr('room.output.plotlyBroken')
      return
    }
    figure = null
    void fetch(body, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        return read(await res.text())
      })
      .then((got) => {
        if (!alive) return
        figure = got
        if (!got) failure = tr('room.output.plotlyBroken')
      })
      .catch(() => {
        if (!alive) return
        /*
         * Отказ по адресу — это почти всегда протухший ключ, и лечится он так
         * же, как у картинок: попросить новый и перерисоваться. Один раз:
         * запись, которой на сервере нет вовсе, иначе гоняла бы по кругу.
         */
        if (!asked && onstale) {
          asked = true
          onstale()
          return
        }
        failure = tr('room.output.plotlyBroken')
      })
    return () => {
      alive = false
    }
  })

  function read(text: string): PlotlyFigure | null {
    try {
      return normalizeFigure(JSON.parse(text))
    } catch {
      return null
    }
  }

  /** Место под график — из фигуры, пока рамка не сказала своё число. */
  $effect(() => {
    const got = figure
    if (got && !drawn) height = figureHeight(got)
  })

  /**
   * Разговор с рамкой.
   *
   * Origin у песочницы — строка «null», одинаковая у любой другой песочницы на
   * странице, и сверять его бессмысленно. Сверяется ИСТОЧНИК: сообщение
   * принимается только от того окна, которое мы сами и завели.
   */
  $effect(() => {
    const node = frame
    if (!node) return
    const listener = (event: MessageEvent): void => {
      if (event.source !== node.contentWindow) return
      if (!isPlotlyMessage(event.data)) return
      const msg = event.data as { kind: string; height?: unknown; reason?: unknown }
      if (msg.kind === 'ready') {
        send(node)
      } else if (msg.kind === 'height' && typeof msg.height === 'number') {
        height = Math.max(40, Math.round(msg.height))
        drawn = true
      } else if (msg.kind === 'failed') {
        const reason = typeof msg.reason === 'string' ? msg.reason : ''
        failure =
          reason === 'bundle'
            ? tr('room.output.plotlyBundle')
            : tr('room.output.plotlyFailed', { p0: reason.slice(0, 200) })
      }
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  })

  /** Фигура доехала позже, чем рамка сказала «готова», — послать ещё раз. */
  $effect(() => {
    const node = frame
    const got = figure
    if (node && got && node.dataset.ready === '1') send(node)
  })

  /**
   * Рамка не ответила совсем — сказать об этом словами.
   *
   * Заставка вместо графика — честный ответ ровно до тех пор, пока что-то
   * правда едет. Если рамка не открылась вовсе (маршрут отказал, сборка без
   * бандла), ждать нечего, а на экране стояла бы вечная заставка, по которой не
   * отличить «грузится» от «сломалось».
   *
   * Полторы минуты, потому что бандл — пять мегабайт (1,1 МБ brotli), и на
   * семинарском вайфае это десятки секунд, а не доли.
   */
  const SILENCE_MS = 90_000

  $effect(() => {
    const node = frame
    if (!node || drawn || failure) return
    const timer = setTimeout(() => {
      if (!drawn) failure = tr('room.output.plotlyBundle')
    }, SILENCE_MS)
    return () => clearTimeout(timer)
  })

  function send(node: HTMLIFrameElement): void {
    node.dataset.ready = '1'
    const got = figure
    if (!got) return
    /*
     * Высота уезжает вместе с фигурой, чтобы рамка не выдумывала свою: место
     * под график тетрадь уже зарезервировала этим же числом, и разойтись им
     * значило бы дёрнуть страницу в момент отрисовки.
     *
     * `targetOrigin` — «*», и иначе нельзя: origin песочницы непрозрачный, и
     * любое другое значение просто не совпадёт. Утечки тут нет: в сообщении
     * едет ровно то, что и так лежит в тетради у всех на виду.
     */
    node.contentWindow?.postMessage(
      {
        colloq: PLOTLY_MSG,
        kind: 'draw',
        figure: { ...got, layout: { ...got.layout, height: figureHeight(got) } },
      },
      '*',
    )
  }
</script>

<div use:watch>
  {#if failure}
    <div class="px-2 py-1 text-code text-warning">{failure}</div>
  {:else}
    <!--
      Подложка ровно того же цвета, что у картинок matplotlib: фигуру мы не
      перекрашиваем (у неё свой шаблон, и в тёмной теме он остаётся светлым),
      а рамка вокруг неё обязана выглядеть так же, как рамка вокруг графика,
      нарисованного соседней ячейкой.
    -->
    <div
      class="relative overflow-hidden rounded bg-white/95 p-1"
      style:height={`${height + 8}px`}
    >
      {#if near}
        <iframe
          bind:this={frame}
          {src}
          title={tr('room.output.plotlyTitle')}
          sandbox="allow-scripts allow-downloads"
          referrerpolicy="no-referrer"
          loading="lazy"
          class="block h-full w-full border-0"
          onload={() => {
            /*
             * Фигура уезжает по `load`, а не по «готова» от рамки, и это
             * не дублирование. `load` случается, когда разметка рамки
             * разобрана, то есть когда её загрузчик УЖЕ поставил свой
             * слушатель, — а «готова» ждёт ещё пять мегабайт бандла. Кадр,
             * пришедший раньше бандла, рамка держит у себя и рисует, как
             * только plotly доедет; так между «видно ячейку» и «виден
             * график» остаётся ровно одна загрузка, а не две.
             */
            if (frame) send(frame)
          }}
        ></iframe>
      {/if}
      {#if !drawn}
        <!-- Заставка в размер графика: пока едут пять мегабайт plotly, на
             месте графика должно быть видно, что он там будет. Общая, а не
             своя: она одна на продукт и одна умеет молчать при
             `prefers-reduced-motion`. -->
        <div class="pointer-events-none absolute inset-1 flex">
          <Skeleton width="100%" height="100%" radius="3px" />
        </div>
      {/if}
    </div>
  {/if}
</div>
