<!--
  Чернила и указка поверх страницы.

  Холст ровно по странице, координаты — доли этой страницы. У проектора 1920
  пикселей, у планшета 1180, у студента — половина окна браузера: пиксель
  ведущего не значит ничего ни у кого из них, а доля значит одно и то же везде.

  Рисует ВСЕГДА, а принимает ввод — только у ведущего. Это один компонент, а не
  два, ровно потому, что рисовать и показывать нарисованное должно одним кодом:
  разойдясь, они дадут линию, которая у ведущего идёт под пером, а на проекторе
  ложится на сантиметр левее, и заметить это можно только в аудитории.
-->
<script lang="ts">
  import { getSessionState } from '@/lib/session.svelte'

  interface Props {
    /** Страница, чернила которой показываем. */
    page: number
    /** Принимать ли перо: у ведущего да, у зала нет. */
    live: boolean
    /** Чем рисуем сейчас: перо своего цвета, ластик или указка. */
    tool: 'pen' | 'laser' | 'off'
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
  }

  let { page, live, tool, color, width, w, h }: Props = $props()

  const session = getSessionState()

  let canvas = $state<HTMLCanvasElement | null>(null)

  /*
   * Перерисовка целиком, а не по новым точкам.
   *
   * Полсотни штрихов на странице — это доли миллисекунды на холсте, а
   * дорисовывание «с того места, где остановились» требует помнить, сколько
   * нарисовано у каждого штриха, и разъезжается на каждой смене страницы,
   * повороте планшета и стирании. Перерисовка целиком не разъезжается никогда.
   */
  $effect(() => {
    const node = canvas
    // Читаем счётчик правок: он и есть повод перерисовать.
    void session.inkRevision
    const spot = session.laser
    if (!node || w === 0 || h === 0) return

    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    if (node.width !== Math.round(w * ratio) || node.height !== Math.round(h * ratio)) {
      node.width = Math.round(w * ratio)
      node.height = Math.round(h * ratio)
    }
    const paint = node.getContext('2d')
    if (!paint) return
    paint.setTransform(ratio, 0, 0, ratio, 0, 0)
    paint.clearRect(0, 0, w, h)
    paint.lineCap = 'round'
    paint.lineJoin = 'round'

    for (const stroke of session.ink) {
      if (stroke.page !== page || stroke.points.length < 4) continue
      paint.strokeStyle = stroke.color
      paint.lineWidth = Math.max(1, stroke.width * w)
      paint.beginPath()
      paint.moveTo(stroke.points[0] * w, stroke.points[1] * h)
      for (let i = 2; i < stroke.points.length; i += 2) {
        paint.lineTo(stroke.points[i] * w, stroke.points[i + 1] * h)
      }
      paint.stroke()
    }

    if (spot && spot.page === page) {
      /*
       * Указка — не курсор: она видна с последнего ряда. Мягкое пятно вокруг
       * ядра, потому что на проекторе яркая точка в четыре пикселя теряется в
       * белом слайде.
       */
      const x = spot.x * w
      const y = spot.y * h
      const radius = Math.max(10, w * 0.012)
      const halo = paint.createRadialGradient(x, y, 0, x, y, radius * 2.4)
      halo.addColorStop(0, spot.color)
      halo.addColorStop(1, 'transparent')
      paint.globalAlpha = 0.35
      paint.fillStyle = halo
      paint.beginPath()
      paint.arc(x, y, radius * 2.4, 0, Math.PI * 2)
      paint.fill()
      paint.globalAlpha = 1
      paint.fillStyle = spot.color
      paint.beginPath()
      paint.arc(x, y, radius * 0.45, 0, Math.PI * 2)
      paint.fill()
    }
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
  let drawing: { id: string; sent: number } | null = null
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
    const node = canvas
    if (!node) return null
    const rect = node.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: round((event.clientX - rect.left) / rect.width),
      y: round((event.clientY - rect.top) / rect.height),
    }
  }

  function mine(event: PointerEvent): boolean {
    if (!live || tool === 'off') return false
    if (event.pointerType === 'pen') {
      sawPen = true
      return true
    }
    // Ладонь на планшете — это `touch`, и она приходит всегда. Отсекаем её
    // ровно тогда, когда есть чем рисовать по-настоящему.
    if (event.pointerType === 'touch' && sawPen) return false
    return true
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
      session.send({
        t: 'ink',
        page,
        id: drawing.id,
        color,
        width,
        points: pending.slice(from, from + MAX_NUMBERS_PER_FRAME),
      })
    }
    pending = []
  }

  function schedule(): void {
    if (flushTimer !== undefined) return
    flushTimer = window.setTimeout(flush, SEND_EVERY_MS)
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
    if (spotTimer === undefined) spotTimer = window.setTimeout(beamNow, SEND_EVERY_MS)
  }

  function down(event: PointerEvent): void {
    if (!mine(event)) return
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
      canvas?.setPointerCapture(event.pointerId)
    } catch {
      /* перо уже отпустили — рисуем без захвата */
    }
    if (tool === 'laser') {
      // Первое касание — сразу: указка, появляющаяся через сорок миллисекунд
      // после того, как на неё нажали, ощущается как залипшая.
      spot = place
      beamNow()
      return
    }
    drawing = { id: `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, sent: 0 }
    pending = [place.x, place.y]
    flush()
  }

  function move(event: PointerEvent): void {
    if (!mine(event)) return
    if (tool === 'laser') {
      const place = at(event)
      if (!place || event.buttons === 0) return
      event.preventDefault()
      beam(place)
      return
    }
    if (!drawing) return
    event.preventDefault()
    /*
     * `getCoalescedEvents` — то, чем перо отличается от мыши: между двумя
     * кадрами Pencil успевает сообщить десяток положений, и линия, собранная
     * только по кадрам, выходит гранёной на быстром движении. Проверка на
     * существование не формальная: в Safari метод появился только в
     * восемнадцатом поколении, а рисуют на планшетах и постарше.
     */
    const steps = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
    for (const step of steps.length > 0 ? steps : [event]) {
      const place = at(step)
      if (place) pending.push(place.x, place.y)
    }
    schedule()
  }

  function up(event: PointerEvent): void {
    if (tool === 'laser') {
      if (!live) return
      beamNow()
      session.send({ t: 'laser:off' })
      return
    }
    if (!drawing) return
    const place = at(event)
    if (place) pending.push(place.x, place.y)
    flush()
    drawing = null
  }

  // Вкладку закрыли посреди штриха — таймеры уносим с собой.
  $effect(() => () => {
    window.clearTimeout(flushTimer)
    window.clearTimeout(spotTimer)
  })
</script>

<!--
  `touch-action: none` — единственное, без чего рисование на планшете
  невозможно: без него первый же штрих прокручивает страницу вместо линии.
  Слой не ловит указатель, когда рисовать нечем: под ним живая страница.
-->
<div class="pointer-events-none absolute inset-0">
  <canvas
    bind:this={canvas}
    class="ink h-full w-full select-none {live && tool !== 'off' ? 'pointer-events-auto' : ''}"
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
