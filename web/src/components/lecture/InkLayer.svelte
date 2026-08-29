<!--
  Чернила и указка поверх страницы.

  Холст ровно по странице, координаты — доли этой страницы. У проектора 1920
  пикселей, у планшета 1180, у студента — половина окна браузера: пиксель
  ведущего не значит ничего ни у кого из них, а доля значит одно и то же везде.

  Рисует ВСЕГДА, а принимает ввод — только у ведущего. Это один компонент, а не
  два, ровно потому, что рисовать и показывать нарисованное должно одним кодом:
  разойдясь, они дадут линию, которая у ведущего идёт под пером, а на проекторе
  ложится на сантиметр левее, и заметить это можно только в аудитории.

  ДВА ХОЛСТА, А НЕ ОДИН — и это главное решение файла.

  Раньше здесь был один холст, и он рисовал ровно то, что подтвердил сервер.
  Значит, свою собственную линию ведущий видел после кругосветки: сорок
  миллисекунд накопления, круг до сервера и обратно через ретранслятор, разбор
  кадра — от шестидесяти до полутораста миллисекунд между пером и пикселем. На
  ProMotion это восемнадцать кадров. Ощущается это не как «сеть медленная», а
  как «планшет сломан»: чернила тянутся за пером на палец.

  Поэтому: нижний холст — СУХОЙ, на нём лежит то, что подтвердил сервер, и он
  один у всех — у ведущего, у зала, у проектора. Верхний — МОКРЫЙ, он есть
  только там, где рисуют: на нём линия, которую ведут прямо сейчас, указка и
  кольцо ластика. Мокрый штрих гаснет не по подъёму пера, а когда его эхо
  доехало и легло на сухой холст, — по подъёму в линии образовалась бы дыра
  ровно длиной в круг до сервера.

  Оба холста строят путь ОДНОЙ функцией. Разойдясь, они дадут штрих, который
  дёргается в тот миг, когда мокрая линия сменяется сухой, — и заметить это
  снова можно будет только в аудитории.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { getSessionState } from '@/lib/session.svelte'

  interface Props {
    /** Страница, чернила которой показываем. */
    page: number
    /** Принимать ли перо: у ведущего да, у зала нет. */
    live: boolean
    /** Чем рисуем сейчас: перо, маркер, ластик или указка. */
    tool: 'pen' | 'marker' | 'eraser' | 'laser' | 'off'
    color: string
    /** Толщина в долях ширины страницы. */
    width: number
    /*
     * Размер листа в пикселях — от того, кто его посчитал.
     *
     * Не меряется здесь заново: холст обязан совпадать с листом пиксель в
     * пиксель, а два измерения одного и того же расходятся — и расхождение
     * видно как чернила, съехавшие относительно текста. К тому же мерить было
     * бы нечем: наблюдатель размера молчит, пока браузер не рисует вкладку.
     */
    w: number
    h: number
    /**
     * Слой держит указатель: идёт штрих, стирание или пружинная указка.
     *
     * Родитель по этому флагу не листает свайпом и глотает ладонь. Без него
     * пульт пролистнул бы страницу под рукой, которая на ней рисует.
     */
    onbusy?: (busy: boolean) => void
    /**
     * Не принимать ввод и оборвать начатое: подняли лист правки заметок или на
     * листе появился второй палец.
     */
    suspend?: boolean
  }

  let { page, live, tool, color, width, w, h, onbusy, suspend = false }: Props = $props()

  const session = getSessionState()

  let dryCanvas = $state<HTMLCanvasElement | null>(null)
  let wetCanvas = $state<HTMLCanvasElement | null>(null)

  /* ------------------------------------------------- геометрия штриха */

  /**
   * Подогнать холст под лист и приготовить перо.
   *
   * Присвоение width/height стирает и пиксели, и состояние контекста — и делает
   * это даже когда значение то же самое. Поэтому только при настоящей смене
   * размера: поворот планшета иначе гасил бы страницу на ровном месте.
   *
   * Возвращает, случилась ли эта смена: мокрый холст после неё пуст, и
   * дорисовывать в него «с того места, где остановились» уже нельзя — штрих
   * надо собрать заново из долей. Пересчёт бесплатный: точки и хранятся в долях.
   */
  function fitTo(node: HTMLCanvasElement): { paint: CanvasRenderingContext2D; blank: boolean } | null {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const wide = Math.round(w * ratio)
    const high = Math.round(h * ratio)
    let blank = false
    if (node.width !== wide || node.height !== high) {
      node.width = wide
      node.height = high
      blank = true
    }
    const paint = node.getContext('2d')
    if (!paint) return null
    paint.setTransform(ratio, 0, 0, ratio, 0, 0)
    paint.lineCap = 'round'
    paint.lineJoin = 'round'
    return { paint, blank }
  }

  /**
   * Путь по точкам: квадратичные кривые через середины отрезков.
   *
   * Было — ломаная из `lineTo`, то есть ровно те точки, что успел прислать
   * браузер. На медленном штрихе разницы нет, на быстром видны грани, а на
   * проекторе в 1920 они видны всему залу: рука за кадр проходит сантиметр, и
   * линия становится многоугольником. Кривая через середины стоит столько же
   * операций пути — та же одна на точку, — но проходит через точки гладко.
   *
   * Эта функция — единственное место, где строится путь. И мокрый холст, и
   * сухой зовут её; иначе линия дёрнется в тот миг, когда один сменит другой.
   */
  function trace(paint: CanvasRenderingContext2D, points: number[], px: number, py: number): void {
    const last = points.length / 2 - 1
    paint.beginPath()
    paint.moveTo(points[0] * px, points[1] * py)
    for (let i = 1; i < last; i += 1) {
      const cx = points[i * 2] * px
      const cy = points[i * 2 + 1] * py
      paint.quadraticCurveTo(cx, cy, (cx + points[i * 2 + 2] * px) / 2, (cy + points[i * 2 + 3] * py) / 2)
    }
    paint.lineTo(points[last * 2] * px, points[last * 2 + 1] * py)
  }

  /**
   * Штрих целиком — одним `stroke()`.
   *
   * Одним, а не по отрезкам: маркер полупрозрачный, и на стыке двух отдельных
   * вызовов альфа складывается. Линия вышла бы пятнистой ровно там, где рука
   * замедлилась и точки легли часто.
   */
  function drawStroke(
    paint: CanvasRenderingContext2D,
    points: number[],
    tint: string,
    thick: number,
    px: number,
    py: number,
  ): void {
    if (points.length < 2) return
    const line = Math.max(1, thick * px)
    if (points.length === 2) {
      /*
       * Тап пером — это ровно две координаты, и раньше такой штрих доезжал до
       * сервера, хранился там и не рисовался никогда: путь из одной точки не
       * рисует ничего. Точку рисует круг.
       */
      paint.fillStyle = tint
      paint.beginPath()
      paint.arc(points[0] * px, points[1] * py, line / 2, 0, Math.PI * 2)
      paint.fill()
      return
    }
    paint.strokeStyle = tint
    paint.lineWidth = line
    trace(paint, points, px, py)
    paint.stroke()
  }

  /* ---------------------------------------------------- сухой холст */

  /** Штрихи, которые сейчас держит мокрый слой: сухой их не рисует — задвоятся. */
  let wetIds = $state.raw<Set<string>>(new Set())
  /** Перо на листе. Пока оно там, сухому холсту нечего показывать нового. */
  let penDown = $state(false)
  /**
   * Стёртое ластиком, чего сервер ещё не подтвердил.
   *
   * Гасим сразу, не дожидаясь `ink:drop`: ластик, который срабатывает через
   * круг до сервера, ощущается как неисправный, и по штриху водят второй раз.
   * Если подтверждения не будет, штрих вернётся с ближайшей полной пачкой —
   * самоисправляющаяся ложь длиной в секунду честнее ластика, который «не
   * работает».
   */
  let erased = $state.raw<Set<string>>(new Set())

  $effect(() => {
    const node = dryCanvas
    // Читаем счётчик правок: он и есть повод перерисовать.
    void session.inkRevision
    const hidden = wetIds
    const gone = erased
    if (!node || w === 0 || h === 0) return

    /*
     * Пока перо на листе, единственное, что меняется в чернилах комнаты, — эхо
     * своего же штриха; оно уже нарисовано мокрым слоем поверх. Перебирать под
     * ним все штрихи страницы двадцать пять раз в секунду — работа, которой
     * никто не увидит. Смену размера пропускать нельзя: холст после неё пуст.
     */
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const fits = node.width === Math.round(w * ratio) && node.height === Math.round(h * ratio)
    if (penDown && fits) return

    const ready = fitTo(node)
    if (!ready) return
    const paint = ready.paint
    paint.clearRect(0, 0, w, h)

    for (const stroke of session.ink) {
      if (stroke.page !== page) continue
      if (hidden.has(stroke.id) || gone.has(stroke.id)) continue
      drawStroke(paint, stroke.points, stroke.color, stroke.width, w, h)
    }
  })

  /* --------------------------------------------------- мокрый холст */

  interface Wet {
    id: string
    page: number
    color: string
    width: number
    /** Все точки штриха, парами долей. */
    points: number[]
    /** Сколько чисел уже ушло на сервер: по ним и узнаём своё эхо. */
    sent: number
    /** Перо подняли — можно ждать эха. */
    closed: boolean
    /** До какого времени ждём эхо, если оно не приедет вовсе. */
    until: number
    /** Докуда доведена кривая на холсте (индекс точки) и где её конец. */
    curved: number
    tipX: number
    tipY: number
  }

  /**
   * Штрихи, которых сервер ещё не подтвердил. Список, а не один штрих: на
   * оборванной связи их накапливается сколько угодно, и каждый ждёт своего эха
   * сам по себе.
   */
  let wet: Wet[] = []
  /** Где ластик прямо сейчас: кольцо под пером рисуем только себе. */
  let ring: { x: number; y: number } | null = null

  /** Прозрачный цвет — восьмизначный (или четырёхзначный) hex: у маркера альфа в цвете. */
  function seeThrough(tint: string): boolean {
    return /^#(?:[\da-f]{4}|[\da-f]{8})$/i.test(tint)
  }

  /** Куда пришла кривая, когда штрих нарисован целиком. */
  function markTail(stroke: Wet): void {
    const points = stroke.points
    const last = points.length / 2 - 1
    stroke.curved = Math.max(0, last - 1)
    if (last < 1) {
      stroke.tipX = points[0] * w
      stroke.tipY = points[1] * h
      return
    }
    stroke.tipX = ((points[(last - 1) * 2] + points[last * 2]) / 2) * w
    stroke.tipY = ((points[(last - 1) * 2 + 1] + points[last * 2 + 1]) / 2) * h
  }

  /* ------------------------------------------------------------- указка */

  /**
   * Красная. Не цветом ведущего.
   *
   * Указку узнают, не думая: красная точка на слайде — это «смотрите сюда», и
   * так во всех аудиториях мира, где есть лазерная указка. Цвет ведущего
   * приезжал сюда из общей привычки красить всё по автору, и у второго
   * преподавателя указка оказывалась синей — то есть неотличимой от его же
   * чернил, которыми он через секунду подчеркнёт строку.
   */
  const LASER = '#ff2b1d'

  /**
   * Хвост.
   *
   * Точка без хвоста на проекторе теряется: она проходит полметра между двумя
   * кадрами, и глаз в зале ловит её только там, где она остановилась, — то
   * есть уже после того, как ей показали. Хвост показывает ДВИЖЕНИЕ: откуда
   * рука ведёт и куда, — и держится ровно столько, чтобы прочертить путь и
   * не превратиться в линию, которую примут за чернила.
   *
   * Живёт целиком у смотрящего: по проводу едут те же 44 байта на кадр, и
   * догорает хвост у каждого сам. Иначе за него пришлось бы платить потоком
   * кадров ради того, что и так известно каждому.
   */
  const TRAIL_MS = 420
  const TRAIL_MAX = 96
  let trail: { x: number; y: number; page: number; at: number }[] = []
  let trailFrame: number | undefined
  /**
   * Где указка СЕЙЧАС. Отдельно от хвоста, и это не мелочь.
   *
   * Хвост гаснет по времени — на то он и хвост. Голова живёт, пока указку
   * держат: указкой чаще всего СТОЯТ на месте («вот здесь») — точек больше не
   * приходит, и точка, живущая по тому же таймеру, что и след, пропадала через
   * четыре десятых секунды. На экране это выглядело так: нажал — мигнуло —
   * ничего. Гасит голову только отпущенная указка (laser:off) — или уход на
   * другую страницу.
   */
  let head: { x: number; y: number; page: number } | null = null

  function pushTrail(x: number, y: number, at: number): void {
    const now = performance.now()
    head = { x, y, page: at }
    /*
     * Между кадрами указки сорок миллисекунд и полметра экрана. Ломаная из
     * присланных точек рвётся на быстром движении, поэтому промежуток
     * добивается серединами — их видно как ровный след, а не как пунктир.
     */
    const last = trail.at(-1)
    if (last && last.page === at) {
      const steps = Math.min(6, Math.max(1, Math.round(Math.hypot(x - last.x, y - last.y) / 0.012)))
      for (let i = 1; i < steps; i += 1) {
        trail.push({
          x: last.x + ((x - last.x) * i) / steps,
          y: last.y + ((y - last.y) * i) / steps,
          page: at,
          at: last.at + ((now - last.at) * i) / steps,
        })
      }
    }
    trail.push({ x, y, page: at, at: now })
    if (trail.length > TRAIL_MAX) trail = trail.slice(-TRAIL_MAX)
    burn()
  }

  /** Пока хвост горит, холст перерисовывается покадрово: он гаснет сам по себе. */
  function burn(): void {
    if (trailFrame !== undefined) return
    trailFrame = requestAnimationFrame(() => {
      trailFrame = undefined
      const now = performance.now()
      const kept = trail.filter((dot) => now - dot.at < TRAIL_MS)
      const changed = kept.length !== trail.length
      trail = kept
      if (changed || trail.length > 0) paintWet()
      // Догорает только хвост. Голова стоит, пока указку держат, и кадры ради
      // неё не крутятся: она не меняется.
      if (trail.length > 0) burn()
    })
  }

  /** Указку отпустили — гаснет всё, и голова первой. */
  function douse(): void {
    head = null
    trail = []
    paintWet()
  }

  function paintLaser(paint: CanvasRenderingContext2D): void {
    if (!head || head.page !== page) return
    const dots = trail.filter((dot) => dot.page === page)
    const now = performance.now()
    const radius = Math.max(9, w * 0.011)

    /*
     * Хвост рисуется отрезками, а не одной линией: у каждого своя прозрачность
     * и своя толщина, иначе он не сужается к концу и читается как штрих.
     */
    paint.lineCap = 'round'
    for (let i = 1; i < dots.length; i += 1) {
      const life = 1 - (now - dots[i].at) / TRAIL_MS
      if (life <= 0) continue
      paint.globalAlpha = 0.5 * life * life
      paint.strokeStyle = LASER
      paint.lineWidth = Math.max(1.5, radius * 0.9 * life)
      paint.beginPath()
      paint.moveTo(dots[i - 1].x * w, dots[i - 1].y * h)
      paint.lineTo(dots[i].x * w, dots[i].y * h)
      paint.stroke()
    }

    /*
     * Голова. Мягкое пятно вокруг ядра: на проекторе яркая точка в четыре
     * пикселя теряется в белом слайде, а свечение видно с последнего ряда.
     */
    const x = head.x * w
    const y = head.y * h
    const halo = paint.createRadialGradient(x, y, 0, x, y, radius * 2.6)
    halo.addColorStop(0, LASER)
    halo.addColorStop(1, 'transparent')
    paint.globalAlpha = 0.42
    paint.fillStyle = halo
    paint.beginPath()
    paint.arc(x, y, radius * 2.6, 0, Math.PI * 2)
    paint.fill()
    paint.globalAlpha = 1
    paint.fillStyle = LASER
    paint.beginPath()
    paint.arc(x, y, radius * 0.5, 0, Math.PI * 2)
    paint.fill()
    paint.globalAlpha = 1
  }

  /*
   * Чужая указка — из комнаты; своя — прямо из-под пальца.
   *
   * Пока показывают здесь, эхо сервера игнорируется: оно отстаёт на круг по
   * сети, и хвост шёл бы за пальцем с задержкой, которую видно именно у того,
   * кто ведёт, — то есть у единственного, кто сравнивает точку с рукой.
   */
  $effect(() => {
    const spot = session.laser
    if (untrack(() => beaming !== null || hold?.beaming === true)) return
    if (!spot) {
      untrack(() => douse())
      return
    }
    pushTrail(spot.x, spot.y, spot.page)
  })

  /** Мокрый холст целиком: смена страницы, размера, указка, стирание. */
  function paintWet(): void {
    const node = wetCanvas
    if (!node || w === 0 || h === 0) return
    const ready = fitTo(node)
    if (!ready) return
    const paint = ready.paint
    paint.clearRect(0, 0, w, h)

    for (const stroke of wet) {
      if (stroke.page !== page) continue
      drawStroke(paint, stroke.points, stroke.color, stroke.width, w, h)
      markTail(stroke)
    }

    paintLaser(paint)

    if (ring && live && tool === 'eraser') {
      /*
       * Кольцо ластика — своё, и только своё: на проекторе его нет. Полое, а не
       * залитое: под ним смотрят, попадает ли оно по штриху. Белая обводка под
       * тёмной — единственный способ остаться видимым и на белом слайде, и на
       * тёмной картинке во весь лист.
       */
      const x = ring.x * w
      const y = ring.y * h
      paint.beginPath()
      paint.arc(x, y, 16, 0, Math.PI * 2)
      paint.strokeStyle = 'rgba(255,255,255,0.9)'
      paint.lineWidth = 3
      paint.stroke()
      paint.strokeStyle = 'rgba(16,26,51,0.85)'
      paint.lineWidth = 1.5
      paint.stroke()
    }
  }

  /**
   * Дорисовать мокрый штрих с того места, где остановились.
   *
   * Не `clearRect` на каждое движение пера: чистить и собирать заново весь
   * штрих — это менять одну полную перерисовку на другую, а мокрый слой затеян
   * ровно ради того, чтобы её не делать. Кладём только новые куски кривой.
   *
   * Хвост от последней середины до последней точки кладём предварительно и
   * перекрываем на следующем движении настоящей кривой. Без него линия отстаёт
   * от пера на полсэмпла — то есть на сантиметр при быстром росчерке, ровно на
   * то расстояние, ради которого всё это и делается. Для непрозрачного цвета
   * перекрытие невидимо; прозрачный маркер так рисовать нельзя, и он идёт
   * полной перерисовкой — она у него всё равно обязана быть одним `stroke()`.
   */
  function growWet(stroke: Wet): void {
    const node = wetCanvas
    if (!node || w === 0 || h === 0) return
    if (seeThrough(stroke.color)) {
      paintWet()
      return
    }
    const ready = fitTo(node)
    if (!ready) return
    if (ready.blank) {
      // Лист поменял размер посреди штриха: холст пуст, дорисовывать не к чему.
      paintWet()
      return
    }
    const paint = ready.paint
    const points = stroke.points
    const last = points.length / 2 - 1
    if (last < 0) return
    if (last === 0) {
      drawStroke(paint, points, stroke.color, stroke.width, w, h)
      markTail(stroke)
      return
    }
    paint.strokeStyle = stroke.color
    paint.lineWidth = Math.max(1, stroke.width * w)
    for (let i = stroke.curved + 1; i < last; i += 1) {
      const cx = points[i * 2] * w
      const cy = points[i * 2 + 1] * h
      const mx = (cx + points[i * 2 + 2] * w) / 2
      const my = (cy + points[i * 2 + 3] * h) / 2
      paint.beginPath()
      paint.moveTo(stroke.tipX, stroke.tipY)
      paint.quadraticCurveTo(cx, cy, mx, my)
      paint.stroke()
      stroke.tipX = mx
      stroke.tipY = my
      stroke.curved = i
    }
    paint.beginPath()
    paint.moveTo(stroke.tipX, stroke.tipY)
    paint.lineTo(points[last * 2] * w, points[last * 2 + 1] * h)
    paint.stroke()
  }

  // Мокрый холст перерисовывается целиком только по внешним поводам: своё
  // движение пера кладёт на него `growWet` прямо из обработчика.
  $effect(() => {
    void wetIds
    void session.laser
    void page
    void w
    void h
    paintWet()
  })

  /**
   * Сколько ждать эха, прежде чем признать, что его не будет.
   *
   * Не будет его в трёх случаях: связь оборвалась, штрих упёрся в потолок точек
   * на сервере, кадр не влез в восемь килобайт. Во всех трёх мокрая линия —
   * ложь о том, что зал видит; но ложь молчаливая, и лучше её убрать, чем
   * оставить навсегда.
   */
  const ECHO_WAIT_MS = 1500
  /** Как часто проверяем, не пора ли. */
  const SETTLE_EVERY_MS = 250
  let settleTimer: number | undefined

  /**
   * Убрать мокрые штрихи, которые уже легли на сухой холст.
   *
   * Признак — эхо: штрих с этим именем есть в чернилах комнаты и в нём не
   * меньше точек, чем мы отправили. По подъёму пера гасить нельзя: сухой холст
   * в этот момент ещё не получил последний кусок, и в линии появилась бы дыра
   * длиной в круг до сервера.
   */
  function settle(): void {
    if (wet.length === 0) return
    const now = performance.now()
    let changed = false
    const keep = wet.filter((stroke) => {
      if (!stroke.closed) return true
      const echo = session.ink.find((known) => known.id === stroke.id)
      if (echo && echo.points.length >= stroke.sent) {
        changed = true
        return false
      }
      /*
       * Ждём, пока связь есть. На оборванной гасить нечем: сухой холст не
       * придёт вовсе, и мокрая линия — единственное, что осталось от штриха.
       */
      if (session.connected && stroke.until <= now) {
        changed = true
        return false
      }
      return true
    })
    if (changed) {
      wet = keep
      wetIds = new Set(keep.map((stroke) => stroke.id))
    }
    arm()
  }

  function arm(): void {
    if (settleTimer !== undefined) return
    if (!wet.some((stroke) => stroke.closed)) return
    settleTimer = window.setTimeout(() => {
      settleTimer = undefined
      settle()
    }, SETTLE_EVERY_MS)
  }

  $effect(() => {
    void session.inkRevision
    settle()
  })

  /* ------------------------------------------------------------- ввод */

  /**
   * Видели ли перо.
   *
   * Пока пера не видели, рисует и палец, и мышь — иначе на ноутбуке рисовать
   * было бы нечем. Как только перо появилось, палец перестаёт рисовать
   * совсем: это ладонь, лежащая на планшете, и она есть всегда.
   */
  let sawPen = false
  /** Когда перо в последний раз подавало признаки жизни. См. `down`. */
  let lastPenAt = 0
  /** Штрих, который ведут сейчас. `pointer` — чтобы ладонь его не закрыла. */
  let drawing: { pointer: number; stroke: Wet } | null = null
  /** Указатель, которым нажали указку: парение пера её не гасит. */
  let beaming: number | null = null
  /** Указатель, которым стирают. */
  let erasing: number | null = null
  /** Точки, набранные с прошлой отправки. */
  let pending: number[] = []
  let flushTimer: number | undefined

  /** Сколько ждать между посылками. Двадцать пять раз в секунду — предел,
      за которым линия уже не становится глаже, а трафик растёт. */
  const SEND_EVERY_MS = 40

  /**
   * Сколько чисел влезает в кадр.
   *
   * У управляющего сокета жёсткий потолок в 8192 символа, и кадр, который его
   * перебрал, сервер молча выбрасывает — ни ошибки, ни строки в журнале. При
   * четырёх знаках после запятой число занимает семь символов с запятой, так
   * что четыреста чисел — это 2800, с запасом в три раза. Перо, задержанное
   * системой на полсекунды, отдаёт свои сэмплы пачкой, и без нарезки такая
   * пачка исчезла бы целиком — вместе с куском линии посреди слайда.
   */
  const MAX_NUMBERS_PER_FRAME = 400

  /**
   * Округление до четырёх знаков.
   *
   * Доля страницы с четырьмя знаками — это четверть пикселя на проекторе в
   * 4К. Без округления `0.1` пришедшее из деления даёт «0.10000000000000009»:
   * восемнадцать символов вместо шести, то есть втрое более толстый провод
   * ради точности, которой не существует.
   */
  function round(value: number): number {
    return Math.round(value * 1e4) / 1e4
  }

  function at(event: PointerEvent): { x: number; y: number } | null {
    const node = wetCanvas
    if (!node) return null
    const rect = node.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: round((event.clientX - rect.left) / rect.width),
      y: round((event.clientY - rect.top) / rect.height),
    }
  }

  function mine(event: PointerEvent): boolean {
    if (!live || tool === 'off' || suspend) return false
    if (event.pointerType === 'pen') {
      sawPen = true
      lastPenAt = performance.now()
      return true
    }
    // Ладонь на планшете — это `touch`, и она приходит всегда. Отсекаем её
    // ровно тогда, когда есть чем рисовать по-настоящему.
    if (event.pointerType === 'touch' && sawPen) return false
    return true
  }

  /** Держим ли указатель. Родитель по этому не листает свайпом и глотает ладонь. */
  let busy = false
  function syncBusy(): void {
    const next = drawing !== null || erasing !== null || beaming !== null || hold?.beaming === true
    if (next === busy) return
    busy = next
    onbusy?.(next)
  }

  function flush(): void {
    window.clearTimeout(flushTimer)
    flushTimer = undefined
    if (!drawing || pending.length < 2) return
    /*
     * Нарезка по кадрам, а не одно сообщение: см. MAX_NUMBERS_PER_FRAME. Куски
     * идут под одним и тем же именем штриха — сервер дописывает их в тот же
     * штрих, а не заводит новый.
     */
    for (let from = 0; from < pending.length; from += MAX_NUMBERS_PER_FRAME) {
      const chunk = pending.slice(from, from + MAX_NUMBERS_PER_FRAME)
      session.send({
        t: 'ink',
        page: drawing.stroke.page,
        id: drawing.stroke.id,
        color: drawing.stroke.color,
        width: drawing.stroke.width,
        points: chunk,
      })
      // Счёт отправленному: по нему мокрый штрих узнаёт своё эхо.
      drawing.stroke.sent += chunk.length
    }
    pending = []
  }

  function schedule(): void {
    if (flushTimer !== undefined) return
    flushTimer = window.setTimeout(flush, SEND_EVERY_MS)
  }

  /** Перо подняли: штрих дописан, дальше он ждёт своего эха. */
  function closeStroke(): void {
    if (!drawing) return
    flush()
    drawing.stroke.closed = true
    drawing.stroke.until = performance.now() + ECHO_WAIT_MS
    drawing = null
    penDown = false
    syncBusy()
    arm()
  }

  /**
   * Оборвать штрих и убрать его отовсюду.
   *
   * Второй палец на листе или поднятый лист правки — это не «дорисовать», а
   * «этого штриха не было»: обрывок, оставшийся на проекторе, хуже, чем его
   * отсутствие. Отправленное уже ушло, поэтому стираем его тем же ластиком.
   */
  function dropStroke(): void {
    if (!drawing) return
    const stroke = drawing.stroke
    flush()
    drawing = null
    penDown = false
    if (stroke.sent > 0) session.send({ t: 'ink:erase', page: stroke.page, id: stroke.id })
    wet = wet.filter((known) => known !== stroke)
    wetIds = new Set(wet.map((known) => known.id))
    pending = []
    syncBusy()
  }

  /*
   * Указка — тем же тактом, что и чернила.
   *
   * У неё нет ни накопления, ни истории: важна только последняя точка. Но
   * посылать её на каждое движение указателя значит слать по сто двадцать
   * кадров в секунду на всю комнату — а глазом от этого не отличить ничего:
   * пятно и так летит быстрее, чем за ним успевают следить.
   */
  let spot: { x: number; y: number } | null = null
  let spotTimer: number | undefined

  function beamNow(): void {
    window.clearTimeout(spotTimer)
    spotTimer = undefined
    if (!spot) return
    session.send({ t: 'laser', page, x: spot.x, y: spot.y })
    spot = null
  }

  function beam(to: { x: number; y: number }): void {
    spot = to
    // Себе — сразу, не дожидаясь круга по сети: свою указку сравнивают с
    // собственной рукой, и отставание видно только здесь.
    pushTrail(to.x, to.y, page)
    if (spotTimer === undefined) spotTimer = window.setTimeout(beamNow, SEND_EVERY_MS)
  }

  function beamOff(): void {
    beamNow()
    session.send({ t: 'laser:off' })
    // Своё — сразу: ждать эха, чтобы погасить СВОЮ же указку, значит держать
    // её на экране лишний круг по сети после того, как палец подняли.
    douse()
  }

  /* --------------------------------------------- пружинная указка пальцем */

  /**
   * Палец, задержанный на листе, — это указка, пока его держат.
   *
   * Самое частое действие в аудитории — показать на формулу. Через кнопку это
   * «переключиться, показать, переключиться обратно», три касания вместо
   * одного, и перо в руке всё это время ничего не рисует. Держать палец —
   * ровно тот жест, которым показывают и на бумаге.
   *
   * Работает только там, где палец не рисует: увидели перо — значит, палец на
   * этом экране свободен.
   */
  const HOLD_MS = 500
  /** Смещение, после которого это уже не «держат», а «ведут». */
  const HOLD_SLACK = 10
  interface Hold {
    pointer: number
    x: number
    y: number
    timer?: number
    beaming: boolean
  }
  let hold: Hold | null = null

  function holdOff(): void {
    if (!hold) return
    window.clearTimeout(hold.timer)
    const wasBeaming = hold.beaming
    hold = null
    if (wasBeaming) beamOff()
    syncBusy()
  }

  /* ------------------------------------------------------------ ластик */

  /** Запас попадания: тонкий штрих иначе невозможно поймать движущимся пером. */
  const ERASE_REACH = 0.012
  /** Сколько держим стёртое несбывшимся, если сервер промолчал. */
  const ERASE_GRACE_MS = 1200
  let forgetTimer: number | undefined
  /** Где ластик был на прошлом сэмпле: стираем отрезком, а не точкой. */
  let rubbed: { x: number; y: number } | null = null

  /** Квадрат расстояния от точки до отрезка. Всё — в долях ШИРИНЫ страницы. */
  function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax
    const dy = by - ay
    const len = dx * dx + dy * dy
    let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const qx = ax + t * dx - px
    const qy = ay + t * dy - py
    return qx * qx + qy * qy
  }

  function side(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
  }

  /**
   * Прошёл ли ластик по штриху.
   *
   * Двумя проверками, и обе нужны. Пересечение — потому что стирают
   * поперечным росчерком, и у такого росчерка все четыре конца далеко от
   * штриха. Расстояние от концов — потому что стирают и вдоль, и коротким
   * тычком по толстой линии, где пересечения нет вовсе.
   */
  function crosses(
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number,
    reach: number,
  ): boolean {
    const s1 = side(cx, cy, dx, dy, ax, ay)
    const s2 = side(cx, cy, dx, dy, bx, by)
    const s3 = side(ax, ay, bx, by, cx, cy)
    const s4 = side(ax, ay, bx, by, dx, dy)
    // Концы ластика по разные стороны штриха, и концы штриха — по разные
    // стороны ластика: это и есть пересечение крест-накрест.
    if ((s1 > 0) !== (s2 > 0) && (s3 > 0) !== (s4 > 0)) return true
    const near = reach * reach
    return (
      toSegment(ax, ay, cx, cy, dx, dy) <= near ||
      toSegment(bx, by, cx, cy, dx, dy) <= near ||
      toSegment(cx, cy, ax, ay, bx, by) <= near ||
      toSegment(dx, dy, ax, ay, bx, by) <= near
    )
  }

  /**
   * Стереть штрихи, по которым провели.
   *
   * Стирается ШТРИХ целиком, а не пиксели под пером: в проводе есть только
   * «убрать штрих с таким именем», а пиксельное стирание потребовало бы нового
   * формата и переписывания всей истории лекции ради жеста, который в лекции
   * делают трижды за пару.
   *
   * Считаем в долях ШИРИНЫ: доля высоты на широком слайде — это другой
   * сантиметр, и порог попадания перекосило бы вместе с листом.
   */
  function rub(from: { x: number; y: number }, to: { x: number; y: number }): void {
    if (w === 0 || h === 0) return
    const skew = h / w
    const ax = from.x
    const ay = from.y * skew
    const bx = to.x
    const by = to.y * skew
    /*
     * Стираем и то, что уже подтвердил сервер, и то, что ещё сохнет на мокром
     * слое: штрих, нарисованный секунду назад, виден на листе, и ластик,
     * проходящий сквозь него, выглядит сломанным. Имя у сервера он уже имеет —
     * точки ушли, пока его вели.
     */
    const targets: { id: string; width: number; points: number[] }[] = [
      ...session.ink.filter((stroke) => stroke.page === page && !erased.has(stroke.id)),
      ...wet.filter(
        (stroke) =>
          stroke.page === page &&
          !erased.has(stroke.id) &&
          !session.ink.some((known) => known.id === stroke.id),
      ),
    ]
    const hit: string[] = []
    for (const stroke of targets) {
      const reach = Math.max(stroke.width, ERASE_REACH)
      const loX = Math.min(ax, bx) - reach
      const hiX = Math.max(ax, bx) + reach
      const loY = Math.min(ay, by) - reach
      const hiY = Math.max(ay, by) + reach
      const points = stroke.points
      const last = points.length / 2 - 1
      for (let i = 0; i <= last; i += 1) {
        const cx = points[i * 2]
        const cy = points[i * 2 + 1] * skew
        const nx = i < last ? points[i * 2 + 2] : cx
        const ny = i < last ? points[i * 2 + 3] * skew : cy
        // Дешёвый отказ по рамке: штрихов на странице до шестисот, и считать
        // для каждого отрезка полную геометрию на каждое движение пера незачем.
        if (Math.min(cx, nx) > hiX || Math.max(cx, nx) < loX) continue
        if (Math.min(cy, ny) > hiY || Math.max(cy, ny) < loY) continue
        if (!crosses(ax, ay, bx, by, cx, cy, nx, ny, reach)) continue
        hit.push(stroke.id)
        break
      }
    }
    if (hit.length === 0) return
    erased = new Set([...erased, ...hit])
    for (const id of hit) session.send({ t: 'ink:erase', page, id })
    // Мокрая копия стёртого держалась бы до конца ожидания эха — то есть
    // полторы секунды жила бы линия, которую при всех только что убрали.
    const dried = wet.filter((stroke) => !hit.includes(stroke.id))
    if (dried.length !== wet.length) {
      wet = dried
      wetIds = new Set(dried.map((stroke) => stroke.id))
    }
    window.clearTimeout(forgetTimer)
    forgetTimer = window.setTimeout(() => {
      // Срок вышел: то, что сервер подтвердил, из чернил уже ушло, а то, что
      // не дошло, честнее показать снова, чем оставить стёртым только у себя.
      erased = new Set()
    }, ERASE_GRACE_MS)
  }

  /* --------------------------------------------------------- указатель */

  function down(event: PointerEvent): void {
    if (!mine(event)) {
      /*
       * Палец, которым не рисуют, — кандидат в пружинную указку. Ни
       * `preventDefault`, ни захвата: этот же палец родитель слушает как свайп
       * по листу, и событие обязано до него дойти.
       */
      if (!live || suspend || tool === 'off') return
      if (event.pointerType !== 'touch' || !sawPen || hold) return
      /*
       * Ладонь, лежащая на планшете, — это тоже «палец, который держат», и без
       * этой строки она через полсекунды зажигала бы указку посреди слова.
       * Полсекунды после последнего события пера рука считается пишущей: перо
       * между двумя буквами отрывают меньше чем на столько.
       */
      if (drawing || performance.now() - lastPenAt < 600) return
      const start: Hold = { pointer: event.pointerId, x: event.clientX, y: event.clientY, beaming: false }
      hold = start
      start.timer = window.setTimeout(() => {
        if (hold !== start) return
        const place = at(event)
        if (!place) {
          hold = null
          return
        }
        start.beaming = true
        spot = place
        beamNow()
        syncBusy()
      }, HOLD_MS)
      return
    }
    const place = at(event)
    if (!place) return
    event.preventDefault()
    /*
     * Захват указателя — попытка, а не требование. Штрих, ушедший за край
     * страницы, должен дорисоваться, а не оборваться на кромке; но захват у
     * указателя, которого браузер уже не считает активным, бросает исключение —
     * и штрих обрывался бы совсем.
     */
    try {
      wetCanvas?.setPointerCapture(event.pointerId)
    } catch {
      /* перо уже отпустили — рисуем без захвата */
    }
    if (tool === 'laser') {
      // Первое касание — сразу: указка, появляющаяся через сорок миллисекунд
      // после того, как на неё нажали, ощущается как залипшая.
      beaming = event.pointerId
      spot = place
      beamNow()
      syncBusy()
      return
    }
    if (tool === 'eraser') {
      erasing = event.pointerId
      ring = place
      rubbed = place
      rub(place, place)
      paintWet()
      syncBusy()
      return
    }
    const stroke: Wet = {
      id: `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      page,
      color,
      width,
      points: [place.x, place.y],
      sent: 0,
      closed: false,
      until: 0,
      curved: 0,
      tipX: place.x * w,
      tipY: place.y * h,
    }
    wet = [...wet, stroke]
    wetIds = new Set(wet.map((known) => known.id))
    drawing = { pointer: event.pointerId, stroke }
    penDown = true
    pending = [place.x, place.y]
    growWet(stroke)
    flush()
    syncBusy()
  }

  function move(event: PointerEvent): void {
    if (hold && hold.pointer === event.pointerId) {
      if (hold.beaming) {
        const place = at(event)
        if (place) beam(place)
        return
      }
      // Палец поехал — это не «показать», а свайп родителя. Не мешаем.
      const slid = Math.abs(event.clientX - hold.x) + Math.abs(event.clientY - hold.y)
      if (slid > HOLD_SLACK) holdOff()
      return
    }
    if (!mine(event)) return
    if (tool === 'laser') {
      const place = at(event)
      if (!place || event.buttons === 0) return
      event.preventDefault()
      beam(place)
      return
    }
    if (tool === 'eraser') {
      const place = at(event)
      if (!place) return
      ring = place
      if (erasing === event.pointerId) {
        event.preventDefault()
        const steps = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
        for (const step of steps.length > 0 ? steps : [event]) {
          const where = at(step)
          if (!where) continue
          rub(rubbed ?? where, where)
          rubbed = where
        }
      }
      paintWet()
      return
    }
    if (!drawing || drawing.pointer !== event.pointerId) return
    event.preventDefault()
    /*
     * `getCoalescedEvents` — то, чем перо отличается от мыши: между двумя
     * кадрами Pencil успевает сообщить десяток положений, и линия, собранная
     * только по кадрам, выходит гранёной на быстром движении. Проверка на
     * существование не формальная: в Safari метод появился только в 18.2, а
     * рисуют на планшетах и постарше.
     */
    const steps = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
    for (const step of steps.length > 0 ? steps : [event]) {
      const place = at(step)
      if (!place) continue
      pending.push(place.x, place.y)
      drawing.stroke.points.push(place.x, place.y)
    }
    // Линия под пером — в этом же кадре, а не после круга до сервера.
    growWet(drawing.stroke)
    schedule()
  }

  function up(event: PointerEvent): void {
    if (hold && hold.pointer === event.pointerId) {
      holdOff()
      return
    }
    /*
     * Ладонь, легшая и снявшаяся во время штриха, раньше дописывала в него СВОЮ
     * координату и закрывала его: линия дёргалась к пятке ладони и обрывалась.
     * Захват от этого не спасает — он перенаправляет только свой указатель, а
     * чужие продолжают приходить.
     */
    if (!mine(event)) return
    if (tool === 'laser') {
      if (!live || beaming !== event.pointerId) return
      beaming = null
      beamOff()
      syncBusy()
      return
    }
    if (tool === 'eraser') {
      if (erasing === event.pointerId) {
        erasing = null
        rubbed = null
        syncBusy()
      }
      ring = null
      paintWet()
      return
    }
    if (!drawing || drawing.pointer !== event.pointerId) return
    const place = at(event)
    if (place) {
      pending.push(place.x, place.y)
      drawing.stroke.points.push(place.x, place.y)
      growWet(drawing.stroke)
    }
    closeStroke()
  }

  /*
   * Инструмент сменили, лист забрали или роль поменялась посреди штриха.
   *
   * Открытый штрих иначе остался бы висеть мокрым навсегда: подъём пера до него
   * уже не дойдёт — `mine` для нового инструмента отвечает иначе, и штрих
   * некому закрыть. Условие читает и `tool`, поэтому эффект просыпается на
   * любой смене инструмента, а не только на уходе в «ничего».
   */
  $effect(() => {
    if (suspend || !live || tool === 'off') {
      if (drawing) dropStroke()
      if (erasing !== null) {
        erasing = null
        rubbed = null
      }
      if (beaming !== null) {
        beaming = null
        beamOff()
      }
      holdOff()
      ring = null
      syncBusy()
      return
    }
    if (drawing) closeStroke()
  })

  // Вкладку закрыли посреди штриха — таймеры уносим с собой.
  $effect(() => () => {
    window.clearTimeout(flushTimer)
    window.clearTimeout(spotTimer)
    window.clearTimeout(settleTimer)
    window.clearTimeout(forgetTimer)
    if (hold) window.clearTimeout(hold.timer)
    if (trailFrame !== undefined) cancelAnimationFrame(trailFrame)
    /*
     * И сказать наружу, что указатель отпущен.
     *
     * Слой чернил исчезает целиком — кончилась лекция, планшет уехал в Split
     * View, — и если он уходит молча, у родителя навсегда остаётся «перо на
     * листе». А по этому признаку пульт глотает касания пальцем, чтобы ладонь
     * не нажимала кнопок: пульт становится мёртвым для пальца весь, включая
     * экран выбора документа, и выйти из этого можно только перезагрузкой.
     */
    if (busy) {
      busy = false
      onbusy?.(false)
    }
  })

  /*
   * Страницу перелистнули, а перо не поднято.
   *
   * Так бывает не только от ладони: страницу листают и с кликалки, и стрелкой,
   * и вторым преподавателем с ноутбука. Штрих закрывается на СТАРОЙ странице —
   * там он и нарисован, туда уже уехали его точки, — а перо на новом листе
   * начинает с чистого места. Без этого приращение мокрой кривой ложится на
   * новый лист от старых координат: обрывок линии, которого нет ни у зала, ни
   * на сухом холсте.
   */
  $effect(() => {
    const now = page
    untrack(() => {
      if (drawing && drawing.stroke.page !== now) closeStroke()
    })
  })

  /*
   * Связь вернулась — дорисовать серверу то, чего он не слышал.
   *
   * Очередь управляющего сокета держит шестнадцать кадров и выбрасывает самые
   * старые, а чернила шлют кадр каждые сорок миллисекунд: из минуты рисования
   * на оборванной связи переживает последняя секунда. Мокрые штрихи при этом
   * всё это время лежат на экране ведущего целиком — то есть пульт показывает
   * ему разметку, которой у зала нет и не будет.
   *
   * Досылаем по эху: сколько точек сервер подтвердил, с той и продолжаем.
   * Это же чинит и одиночный кадр, потерянный на моргнувшем вайфае.
   */
  let wasConnected = true
  $effect(() => {
    const live = session.connected
    untrack(() => {
      const back = live && !wasConnected
      wasConnected = live
      if (!back || wet.length === 0) return
      for (const stroke of wet) {
        const echo = session.ink.find((known) => known.id === stroke.id)
        const have = echo?.points.length ?? 0
        if (have >= stroke.points.length) continue
        const rest = stroke.points.slice(have)
        for (let from = 0; from < rest.length; from += MAX_NUMBERS_PER_FRAME) {
          const chunk = rest.slice(from, from + MAX_NUMBERS_PER_FRAME)
          session.send({
            t: 'ink',
            page: stroke.page,
            id: stroke.id,
            color: stroke.color,
            width: stroke.width,
            points: chunk,
          })
        }
        stroke.sent = stroke.points.length
        // Эха ждём заново: прежний срок истёк, пока связи не было.
        stroke.until = performance.now() + ECHO_WAIT_MS
      }
      arm()
    })
  })
</script>

<!--
  `touch-action: none` — единственное, без чего рисование на планшете
  невозможно: без него первый же штрих прокручивает страницу вместо линии.
  Слой не ловит указатель, когда рисовать нечем: под ним живая страница.

  Сухой холст указателя не ловит никогда: ввод принимает только верхний.
-->
<div class="pointer-events-none absolute inset-0">
  <canvas bind:this={dryCanvas} class="ink ink-dry absolute inset-0 h-full w-full select-none"></canvas>
  <canvas
    bind:this={wetCanvas}
    class="ink ink-wet absolute inset-0 h-full w-full select-none {live && tool !== 'off'
      ? 'pointer-events-auto'
      : ''}"
    style={live && tool !== 'off' ? 'touch-action: none; cursor: crosshair' : ''}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onpointerleave={up}
  ></canvas>
</div>

<style>
  /*
   * Долгое нажатие на iPad вызывает системную лупу и меню «скопировать» —
   * поверх страницы, посреди лекции. Отменяется это только вебкитовскими
   * свойствами: беспрефиксного `touch-callout` не существует вовсе, а серая
   * вспышка по касанию — это `-webkit-tap-highlight-color`, и она мигает на
   * каждой точке штриха.
   */
  .ink {
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }
</style>
