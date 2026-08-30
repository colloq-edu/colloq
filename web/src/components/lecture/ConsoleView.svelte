<!--
  ПУЛЬТ — отдельное приложение для планшета в руках преподавателя.

  Не «комната, ужатая до планшета»: вкладок, панели файлов, оракула и терминала
  здесь нет вовсе. У человека, который говорит перед аудиторией, ровно четыре
  вопроса — что сейчас на экране, что дальше, что сказать, сколько прошло, — и
  каждый лишний орган управления это лишняя секунда молчания в аудитории.

  ПЛАНКА — GOODNOTES, А НЕ СТРАНИЦА В БРАУЗЕРЕ. Первый заход на iPad кончился
  словами «слишком плохо»: лист стоял окошком в верхней трети, ладонь на его
  полях запускала системное выделение, второй контакт ладони ронял штрих, а
  указка жила отдельной пружиной, которую перо не снимало. Из этого выведены
  четыре правила, по которым построен файл.

  1. ЛИСТ — ВЕСЬ ОСТАТОК ЭКРАНА. Один рейл (72 px в ландшафте, 64 снизу в
     портрете), поля 12 px, и всё остальное — бумага. Раньше поле листа было
     постоянной высоты 584 под один iPad 11", а под ним лежала лента заметок
     236 px и колонка «дальше»: на 12.9" и в портрете лист тонул. Теперь
     заметки — выдвижной лист снизу поверх бумаги (ландшафт) или пристыкованный
     остаток под ней (портрет), а «дальше» — эскиз в полосе-подглядке.
  2. У КАСАНИЙ НА ЛИСТЕ ОДИН ХОЗЯИН — слой чернил. Пульт не слушает на
     `.pult-sheet` ни одного pointer-события: ладонь — не жест, свайпа по листу
     нет, второй палец ничего не роняет. Единственный жест пальцами на листе —
     двухпальцевый тап, и его разбирает сам слой, отдавая сюда `onundo`.
  3. УКАЗКА — ИНСТРУМЕНТ ПАЛИТРЫ, в одном ряду с пером, маркером и ластиком.
     Взяли перо — указка снялась сама, как в любом приложении для заметок.
     Пружина осталась только там, где её держат физически: клавиша L и
     удержание клавиши на рейле дольше 300 мс.
  4. ВЕСЬ ПУЛЬТ — БЕЗ ВЫДЕЛЕНИЯ И БЕЗ СИСТЕМНЫХ ЖЕСТОВ: `user-select: none` на
     корне, `touch-action: none` на листе с полями. Единственное место, где
     текст выделяют, — поле заметок.

  СВЕТ. Единственный источник — лист. Всё остальное живёт на ночном корпусе.
  Пульт НЕ СЛЕДУЕТ ТЕМЕ КОМНАТЫ: тёмный зал — факт о мире, а не настройка, и в
  светлой теме (умолчание ОС у большинства) человек получал бы белую плиту
  1180×820 в руки в тёмной аудитории. Тему одалживаем через `borrowTheme`.

  ПУЛЬТ НЕ ЖДЁТ СЕРВЕР. Страницу листает у себя мгновенно и показывает
  расхождение с проектором линейкой темпа, а не подменой числа: число, которое
  приезжает, — это число, которого ждут.
-->
<script lang="ts">
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import { untrack } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { fullscreenNow, fullscreenPossible, goFullscreen, leaveFullscreen } from '@/lib/fullscreen'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { borrowTheme } from '@/lib/theme.svelte'
  import { canKeepAwake, keepAwake, type WakeState } from '@/lib/wakelock'
  import { baseOf } from '@shared/paths'
  import InkLayer from './InkLayer.svelte'
  import LecturePage from './LecturePage.svelte'
  import NotesPad from './NotesPad.svelte'

  interface Props {
    /**
     * Выйти в комнату. Лекцию НЕ останавливает: уйти с пульта и закончить
     * лекцию — разные решения, и второе стоит отдельной строки с
     * подтверждением.
     */
    onexit: () => void
  }

  let { onexit }: Props = $props()

  const session = getSessionState()

  /* ------------------------------------------------------- кто мы здесь */

  const lecture = $derived(session.lecture)
  /** Право на пульт — хостовое. Ссылка-ключ может уехать студенту. */
  const host = $derived(session.me.role === 'host')
  const leading = $derived(lecture !== null && lecture.by === session.me.id)
  /** Лекцию ведёт ДРУГОЙ преподаватель: смотрим, но не управляем. */
  const watching = $derived(lecture !== null && !leading)
  const offline = $derived(!session.connected)

  /**
   * Документ, к которому пишут заметки, пока лекции нет.
   *
   * Заметки готовят накануне, и право на них — «хост», а не «ведёт лекцию».
   * Подготовка — та же планировка, только ничего не рассылается.
   */
  let prep = $state<string | null>(null)
  const preparing = $derived(lecture === null && prep !== null)
  /** Документ на экране: лекционный или тот, что готовим. */
  const file = $derived(lecture?.file ?? prep)
  /** Листать можно, когда пульт наш: в лекции или в подготовке. */
  const mayTurn = $derived(leading || preparing)

  /* --------------------------------------------------------- документ */

  let doc = $state<PDFDocumentProxy | null>(null)
  let pages = $state(0)
  let failure = $state(false)
  /** Счётчик попыток открыть: «Попробовать снова» перезапускает эффект. */
  let attempt = $state(0)

  /**
   * PDF открывается ЗДЕСЬ, а не берётся у комнаты.
   *
   * Пульт — отдельное приложение и живёт на другом устройстве: под ним нет ни
   * читалки, ни вкладок, и просить документ было бы не у кого.
   */
  $effect(() => {
    const path = file
    void attempt
    doc = null
    pages = 0
    failure = false
    if (!path) return
    let dropped = false
    let opened: PDFDocumentProxy | null = null
    void loadPdf()
      .then((pdf) => pdf.open(api.fileRaw(session.session.id, path), session.token))
      .then((ready) => {
        opened = ready
        if (dropped) {
          void ready.loadingTask.destroy()
          return
        }
        doc = ready
        pages = ready.numPages
      })
      .catch(() => {
        if (!dropped) failure = true
      })
    return () => {
      dropped = true
      void opened?.loadingTask.destroy()
    }
  })

  /* ------------------------------------------------------------ страница */

  /**
   * Страница, которую хотим показать, — своя, а не серверная.
   *
   * Кнопка «Вперёд» обязана двигать лист в тот же кадр, в который её нажали:
   * на релее через VPS ответ приходит через сотню миллисекунд, и лист,
   * ждущий этот ответ, ощущается как залипший. Расхождение показываем (см.
   * `behind`), а не прячем.
   */
  let wanted = $state(1)
  /** Проектор отстал дольше, чем на человеческую задержку. */
  let behind = $state(false)
  /** Файл, для которого страница уже взята у сервера. Не руна: только сверка. */
  let settledFile: string | null = null

  $effect(() => {
    const path = file
    const at = lecture?.page ?? 1
    // Смена документа — единственный повод взять страницу у сервера: во всём
    // остальном хозяин номера здесь, на планшете.
    if (path !== settledFile) {
      settledFile = path
      wanted = at
    }
  })

  /*
   * Схождение с проектором.
   *
   * 600 мс — после них расхождение показываем линейкой темпа. 1200 мс — после
   * них сдаёмся и следуем за проектором: значит, либо листает кто-то другой,
   * либо наше сообщение потерялось, и врать про восьмую страницу над седьмой
   * дороже, чем признать чужую.
   */
  $effect(() => {
    const at = lecture?.page ?? null
    const mine = wanted
    if (at === null || at === mine) {
      behind = false
      return
    }
    /*
     * Расхождение бывает только у того, кто листает. Смотрящему чужую лекцию
     * догонять нечего: у него нет своей страницы, есть только серверная.
     */
    if (!mayTurn) {
      behind = false
      // Эффект читает `wanted` и здесь же пишет его: без `untrack` это тот
      // самый цикл, который валит приложение (effect_update_depth_exceeded),
      // стоит `at !== wanted` продержаться дольше одного повтора.
      untrack(() => (wanted = at))
      return
    }
    const late = window.setTimeout(() => (behind = true), 600)
    const settle = window.setTimeout(() => (wanted = at), 1200)
    return () => {
      window.clearTimeout(late)
      window.clearTimeout(settle)
    }
  })

  function goTo(next: number): void {
    if (!mayTurn) return
    /*
     * Верхняя граница, когда своя копия документа не открылась.
     *
     * `pages` тогда ноль, и границы не было вовсе: клавиша ВПЕРЁД гнала залу
     * номера за конец колоды — на проекторе пусто, а на пульте не видно даже
     * этого, потому что показывать нечем. Зал при этом свою копию открыл и
     * знает, где конец; мы — нет. Поэтому шаг разрешён ровно на одну страницу
     * дальше того, что зал УЖЕ показывает: пролистать вперёд можно сколько
     * угодно, но по одному нажатию и вслед за подтверждением с сервера, а не
     * очередью в двадцать страниц от зажатой кнопки.
     */
    const top = pages > 0 ? pages : Math.max(next, (lecture?.page ?? 1) + 1)
    // Отрицательный номер — чистый лист, и его в границы документа не загоняют.
    const target = next < 0 ? next : Math.min(Math.max(1, next), top)
    if (target === wanted) return
    wanted = target
    if (leading) session.send({ t: 'lecture:page', page: target })
  }

  /* ------------------------------------------------------------ чистый лист */

  /**
   * Белое поле поверх лекции.
   *
   * Самое частое, чего не хватает на паре: слайд кончился, а вывод формулы —
   * нет. До сих пор преподаватель либо писал поверх слайда, закрывая то, что
   * зал ещё читает, либо уходил к меловой доске — то есть переставал показывать
   * что-либо вовсе, а половине аудитории эту доску не видно.
   *
   * Лист — страница с отрицательным номером (см. shared/lecture.ts), поэтому
   * чернила, лента и «дальше» работают на нём сами собой. Каждое нажатие
   * заводит НОВЫЙ: исписанный лист не стирается ради следующего — к нему
   * возвращаются лентой страниц, где заведённые листы стоят за вырезом после
   * последнего слайда.
   */
  let boards = $state(0)
  /** Куда вернуться с листа: последний слайд, на котором были. */
  let lastSlide = $state(1)

  $effect(() => {
    const at = wanted
    untrack(() => {
      if (at > 0) lastSlide = at
      if (at < 0 && -at > boards) boards = -at
    })
  })

  const onBoard = $derived(wanted < 0)

  function newBoard(): void {
    if (!mayTurn) return
    boards += 1
    goTo(-boards)
  }

  function backToSlides(): void {
    goTo(lastSlide)
  }

  /**
   * Шаг вперёд-назад — единственный ход, который знает про границу листов.
   *
   * Нулевой страницы не бывает: между последним чистым листом и слайдами
   * граница, и переходить её надо в ту сторону, откуда пришли, — «вперёд» с
   * листа возвращает к слайду, на котором его завели, а не в пустоту. Назад за
   * самый старый лист не пускаем вовсе: там нет ничего, а выглядело бы это как
   * потерянная разметка.
   */
  function step(dir: -1 | 1): void {
    /*
     * На чистых листах шаг идёт ПО ПОРЯДКУ ЗАВЕДЕНИЯ, а не по номеру.
     *
     * Номера у листов отрицательные, и наивное «+1» уводило с листа 2 на лист
     * 1, то есть НАЗАД по времени, пока лента страниц рисовала их слева
     * направо от первого к последнему. Стрелка, гоняющая подсветку против
     * ленты, — это стрелка, которой не верят. Вперёд за последним листом
     * возвращает к слайду: дальше ничего нет и заводить лист молча нельзя.
     */
    if (onBoard) {
      const at = -wanted
      const nextBoard = at + dir
      if (nextBoard < 1 || nextBoard > boards) {
        backToSlides()
        return
      }
      goTo(-nextBoard)
      return
    }
    const next = wanted + dir
    if (next === 0) {
      backToSlides()
      return
    }
    goTo(next)
  }

  /** Вперёд с последнего листа возвращает в колоду, и клавиша об этом говорит. */
  const forwardReturns = $derived(onBoard && wanted === -1)

  function blank(on: boolean): void {
    if (!leading || offline) return
    session.send({ t: 'lecture:blank', on })
  }

  /* ------------------------------------------------------------ инструмент */

  /**
   * Три цвета и маркер. Синее перо #0f2d69 из набора убрано, и обе причины
   * измеримы: на проекторе с внутризальным контрастом ~300:1 синий и чёрный
   * оба падают в нижние 8 % шкалы и с восьмого ряда неразличимы, а на ночном
   * рейле диск #0f2d69 на корпусе — это 1.5:1, его не видно вовсе.
   *
   * Имена — договор с проверкой интерфейса, менять нельзя.
   */
  const INKS = [
    { color: '#d4162f', name: 'Перо, красное' },
    { color: '#0c7a64', name: 'Перо, зелёное' },
    { color: '#101a33', name: 'Перо, чёрное' },
  ]
  /**
   * Маркер — один цвет, и это решение, а не недоделка.
   *
   * Подсветка обязана быть светлее бумаги под текстом, и такой цвет ровно
   * один. Прозрачность едет В САМОМ цвете (восемь знаков), чтобы штрих лёг
   * одним `stroke()` и альфа не удваивалась на самопересечениях. Поэтому
   * повторный тап по «Маркеру» не открывает ничего: выбирать там нечего.
   */
  const MARKER = '#ffd60a80'
  const MARKER_WIDTH = 0.022
  /**
   * Три толщины пера долями ширины страницы. Средняя — прежняя единственная
   * 0.005 (5 px на 1084): тонкая под формулы мелким почерком, толстая под
   * заголовок через весь слайд. Точки в палитре 4/6/10 px — это форма, а не
   * масштаб: разница в толщине читается за один взгляд.
   */
  const WIDTHS = [
    { width: 0.0035, name: 'Тонкое', dot: 4 },
    { width: 0.005, name: 'Среднее', dot: 6 },
    { width: 0.008, name: 'Толстое', dot: 10 },
  ]

  type Tool = 'pen' | 'marker' | 'eraser' | 'laser'

  /**
   * Инструмент — ОДИН, и указка в нём. «Перо, чёрное, среднее» при входе, и
   * это не хранится: инструмент — состояние руки на эту пару, а не настройка.
   */
  let tool = $state<Tool>('pen')
  let inkColor = $state(INKS[2].color)
  let penWidth = $state(WIDTHS[1].width)

  const strokeColor = $derived(tool === 'marker' ? MARKER : inkColor)
  const strokeWidth = $derived(tool === 'marker' ? MARKER_WIDTH : penWidth)

  /**
   * Любой выбор — присваивание. Указка при этом снимается сама: в GoodNotes,
   * Notability и Freeform указка — такой же инструмент, как перо, и взятое
   * перо её убирает. Прежняя схема «указка поверх выбранного пера» требовала
   * отдельного выключения и оставляла красную точку гулять по проектору.
   */
  function pick(next: Tool): void {
    tool = next
    palette = false
  }

  function penIn(color: string): void {
    tool = 'pen'
    inkColor = color
    palette = false
  }

  function penWide(width: number): void {
    tool = 'pen'
    penWidth = width
    palette = false
  }

  /**
   * ПАЛИТРА ПЕРА — всплывает по тапу по УЖЕ АКТИВНОМУ перу, как в любом
   * приложении для заметок: первый тап берёт инструмент, второй открывает его
   * настройки. Закрывается выбором, тапом мимо, Escape и первым же касанием
   * листа (`busy`): палитра, оставшаяся висеть над формулой, — это лишний
   * объект между глазом и тем, что пишут.
   */
  let palette = $state(false)

  function penKey(): void {
    if (tool === 'pen') palette = !palette
    else pick('pen')
  }

  /**
   * ПРУЖИНА УКАЗКИ — временная подмена инструмента, а не режим.
   *
   * Держат клавишу L или клавишу «Указка» на рейле дольше 300 мс — светит;
   * отпустили — вернулся тот инструмент, что был. Тап короче 300 мс — обычный
   * выбор инструмента. Довод про забытую указку при этом не пропал: пока
   * она выбрана, клавиша горит плитой на рейле, а на листе живёт красная
   * точка, и первое же перо её снимает.
   */
  let sprung = $state(false)
  const SPRING_MS = 300
  let springTimer: number | undefined
  /** Клавиша на рейле нажата и ещё не отпущена. */
  let laserKeyDown = false

  function laserDown(): void {
    if (!leading || offline) return
    laserKeyDown = true
    window.clearTimeout(springTimer)
    springTimer = window.setTimeout(() => {
      if (laserKeyDown) sprung = true
    }, SPRING_MS)
  }

  function laserUp(): void {
    if (!laserKeyDown) return
    laserKeyDown = false
    window.clearTimeout(springTimer)
    if (sprung) {
      sprung = false
      return
    }
    laserToggle()
  }

  function laserToggle(): void {
    if (!leading || offline) return
    pick(tool === 'laser' ? 'pen' : 'laser')
  }

  function laserCancel(): void {
    laserKeyDown = false
    window.clearTimeout(springTimer)
    sprung = false
  }

  /*
   * Обрыв связи и потеря пульта снимают указку: светить некуда, а горящая
   * клавиша при этом обещала бы то, чего не делает. Возвращаемся к перу —
   * тому инструменту, которым продолжают работать и без связи.
   */
  $effect(() => {
    const alive = leading && !offline
    untrack(() => {
      if (alive) return
      laserCancel()
      if (tool === 'laser') tool = 'pen'
    })
  })

  /*
   * Отмена и «стереть страницу» — только по живой связи.
   *
   * Без связи нажатие уходит в очередь: на листе всё остаётся на месте, экран
   * говорит «страница очищена», а через тридцать секунд, когда вайфай
   * вернётся, страница действительно очистится — сама, без человека, посреди
   * следующего слайда. Отложенное разрушение хуже отказа.
   */
  function undoStroke(): void {
    if (!leading) return
    if (offline) {
      say('Нет связи — отменять нечем', 'refusal')
      return
    }
    session.send({ t: 'ink:undo', page: wanted })
  }

  function wipePage(): void {
    if (!leading) return
    if (offline) {
      say('Нет связи — страница останется как есть', 'refusal')
      return
    }
    session.send({ t: 'ink:clear', page: wanted })
    say('Страница очищена')
  }

  /*
   * «Стереть страницу» — удержанием ластика, полсекунды.
   *
   * Единственная защита, которая ничего не стоит правильному жесту: нажатие
   * ластиком по кнопке ластика — это переключение инструмента, а стирание
   * всей страницы посреди лекции — не то, что делают мимоходом. Модального
   * окна на это нет: оно встало бы поперёк того, ради чего его открыли.
   */
  const HOLD_MS = 500
  let holdTimer: number | undefined
  let wiped = false
  /**
   * Клавиша ластика нажата и ещё не отпущена — как `laserKeyDown` у указки.
   *
   * Без этого флага `pointerup` срабатывал БЕЗ пары: перехватчик ладони
   * глотает `pointerdown`, а подъём пропускает (иначе удержание не отпустить),
   * и пятка ладони, легшая на «Ластик» посреди буквы и поднявшаяся, брала
   * ластик — следующим движением пера преподаватель стирал написанное.
   */
  let eraserKeyDown = false

  function eraserDown(): void {
    wiped = false
    eraserKeyDown = true
    window.clearTimeout(holdTimer)
    holdTimer = window.setTimeout(() => {
      wiped = true
      wipePage()
    }, HOLD_MS)
  }

  function eraserUp(): void {
    window.clearTimeout(holdTimer)
    holdTimer = undefined
    if (!eraserKeyDown) return
    eraserKeyDown = false
    if (!wiped) pick('eraser')
    wiped = false
  }

  function eraserCancel(): void {
    window.clearTimeout(holdTimer)
    holdTimer = undefined
    eraserKeyDown = false
  }

  /* ---------------------------------------------------------------- часы */

  /**
   * Тикает раз в секунду — и только ради двух чисел в приборе.
   *
   * Секунда, а не кадр: часы лекции читают, подняв голову, а не следят за
   * ними; перерисовывать прибор шестьдесят раз в секунду ради этого значит
   * будить раскладку рядом с рисованием пером.
   */
  let tick = $state(Date.now())
  $effect(() => {
    const id = window.setInterval(() => (tick = Date.now()), 1000)
    return () => window.clearInterval(id)
  })

  /** Часы ЛЕКЦИИ, а не вкладки: отметка серверная, поправка часов — оттуда же. */
  const runningFor = $derived(
    lecture ? Math.max(0, tick - session.clockSkewMs - lecture.startedAt) : 0,
  )

  /**
   * Секундомер, и ПОСЛЕ ЧАСА ОН ТЕРЯЕТ СЕКУНДЫ: «1:02», а не «1:02:15». Через
   * час секунды не значат ничего — вопрос в этот момент звучит «сколько
   * осталось», а не «сколько прошло».
   */
  function stopwatch(ms: number): string {
    const total = Math.floor(ms / 1000)
    const hours = Math.floor(total / 3600)
    const mm = String(Math.floor(total / 60) % 60).padStart(2, '0')
    if (hours > 0) return `${hours}:${mm}`
    return `${mm}:${String(total % 60).padStart(2, '0')}`
  }

  /*
   * Стенные часы собираются руками, а не `toLocaleTimeString`: в аудитории
   * время читают в двадцатичетырёхчасовом виде независимо от того, какой язык
   * стоит в планшете, а «2:36 PM» под номером страницы читается вдвое дольше.
   */
  function hhmm(ms: number): string {
    const at = new Date(ms)
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  }

  const wall = $derived(hhmm(tick))

  /* ------------------------------------------------------------ раскладка */

  let root = $state<HTMLDivElement | null>(null)
  let box = $state({ w: 0, h: 0 })

  /**
   * Ориентация читается наблюдателем за размером, а не медиа-запросом.
   *
   * На iPadOS окно меняет размер непрерывно (Split View, оконная
   * многозадачность), `orientationchange` приходит раньше, чем раскладка
   * устоится, а «портрет» — это не поворот, а пропорция окна. Наблюдатель
   * отвечает на тот вопрос, который мы на самом деле задаём.
   */
  $effect(() => {
    const node = root
    if (!node) return
    let seen = { w: 0, h: 0 }
    const measure = (): void => {
      const rect = node.getBoundingClientRect()
      const next = { w: Math.round(rect.width), h: Math.round(rect.height) }
      if (next.w === seen.w && next.h === seen.h) return
      seen = next
      box = next
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(node)
    return () => watch.disconnect()
  })

  /**
   * Две раскладки одной логики, а не «широкая и деградация». Портрет — рейл
   * снизу под большой палец держащей руки, заметки пристыкованы под листом;
   * ландшафт — рейл сбоку, заметки выдвигаются. Порога «wide» больше нет: он
   * был мерой одного экрана 1180×820, а планшетов у людей три размера и две
   * ориентации.
   */
  const portrait = $derived(box.h > box.w)
  /** Slide Over: пульт остаётся живым, но перестаёт быть пультом. */
  const tiny = $derived(box.w > 0 && box.w < 420)

  const HAND_KEY = 'colloq.pult.hand'
  const NOTES_KEY = 'colloq.pult.notes'
  const LAMP_KEY = 'colloq.pult.lamp'
  const FINGER_KEY = 'colloq.pult.finger'

  function remembered(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      // Приватный просмотр бросает и на чтении — умолчание тоже годится.
      return null
    }
  }

  function remember(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Не запомнили — на эту пару настройка всё равно работает.
    }
  }

  /** Левша: рейл переезжает на правую кромку целиком, вместе с палитрой. */
  let hand = $state<'right' | 'left'>(remembered(HAND_KEY) === 'left' ? 'left' : 'right')

  function setHand(next: 'right' | 'left'): void {
    hand = next
    remember(HAND_KEY, next)
  }

  /**
   * Открыт ли выдвижной лист заметок (ландшафт). Ключ тот же, что у прежней
   * ленты: `open` — человек хочет видеть заметки с первой секунды, всё
   * остальное — закрыто. Умолчание закрыто, потому что лист лежит ПОВЕРХ
   * бумаги: открытый при входе, он прятал бы ровно то, ради чего пульт
   * открыли. Заметка при этом не пропадает — её первые строки видны в
   * полосе-подглядке под листом.
   */
  let notesOpen = $state(remembered(NOTES_KEY) === 'open')

  function setNotes(open: boolean): void {
    notesOpen = open
    remember(NOTES_KEY, open ? 'open' : 'folded')
  }

  /**
   * РИСОВАТЬ ПАЛЬЦЕМ. Умолчание — да: у того, кто открыл пульт без Pencil'а,
   * иначе нет способа поставить на слайде ни одной черты. Первое же перо на
   * этом экране выключает палец (`onpen` из слоя чернил) и говорит об этом
   * тостом: с этого момента палец на листе — ладонь, а не инструмент. Строка
   * в «Ещё» возвращает, если Pencil сел посреди пары.
   */
  let fingerOn = $state(remembered(FINGER_KEY) !== 'off')

  function setFinger(on: boolean): void {
    fingerOn = on
    remember(FINGER_KEY, on ? 'on' : 'off')
  }

  function penFound(): void {
    if (!fingerOn) return
    setFinger(false)
    say('Перо найдено — палец больше не рисует')
  }

  /* ------------------------------------------------------------- фейдер */

  /**
   * ФЕЙДЕР ЛИСТА — регулятор единственного источника света на этом экране.
   *
   * Лист — единственное светлое пятно пульта, и в тёмной аудитории на второй
   * половине пары он слепит: 1084×610 белого в руках, пока зал сидит в
   * темноте. Выходить за этим в системную яркость нельзя — она гасит заодно
   * заметки, которые как раз надо читать, и стоит трёх касаний по шторке.
   *
   * Три детента, а не циклическая кнопка: у фейдера всегда видно текущее
   * положение. Работает пеленой ПОВЕРХ листа и чернил — и не касается ни
   * рейла, ни заметок, ни проектора вовсе: зал видит свою проекцию такой,
   * какой видел.
   */
  const LAMPS = [
    { name: 'Полный свет', veil: 0, bar: 4 },
    { name: 'Свет зала', veil: 0.28, bar: 9 },
    { name: 'Ночь', veil: 0.55, bar: 14 },
  ]
  /*
   * Умолчание — «зал»: полный свет в тёмной аудитории никому не нужен.
   *
   * Пустое хранилище читается ЯВНО, а не через `Number(null)`: ноль — это
   * «полный свет», то есть ровно та ступень, ради ухода от которой фейдер и
   * заведён, и первый запуск отдавал бы её каждому.
   */
  const LAMP_STORED = remembered(LAMP_KEY)
  let lamp = $state(
    LAMP_STORED !== null && LAMPS[Number(LAMP_STORED)] !== undefined ? Number(LAMP_STORED) : 1,
  )
  const veil = $derived(LAMPS[lamp].veil)

  function setLamp(next: number): void {
    lamp = next
    remember(LAMP_KEY, String(next))
  }

  /* --------------------------------------------------------------- листы */

  /**
   * Что поднято снизу поверх всего. Один лист за раз: два — это уже
   * интерфейс, а не пульт. Пока такой лист открыт, перо на слайде не рисует:
   * лист накрывает лист.
   */
  let pane = $state<'pages' | 'more' | 'grab' | 'files' | null>(null)
  /** Подтверждение «стереть страницу» — внутри строки листа «Ещё». */
  let wipeAsked = $state(false)
  /** Подтверждение «закончить лекцию» — там же, последней строкой. */
  let stopAsked = $state(false)

  function openPane(next: typeof pane): void {
    pane = next
    palette = false
    wipeAsked = false
    stopAsked = false
  }

  /* ----------------------------------------------------- перо и ладонь */

  /** Слой чернил держит указатель: идёт штрих, стирание или указка светит. */
  let busy = $state(false)
  let lastBusyAt = 0
  /** В поле заметок фокус — перо на слайде в это время не рисует. */
  let editing = $state(false)

  const paneOpen = $derived(pane !== null)
  /**
   * Открытый лист заметок `canDraw` НЕ меняет: он занимает нижнюю половину, а
   * верхняя остаётся бумагой, на которой пишут. Гасит перо только фокус в
   * поле — и тогда слой чернил закрывает штрих, а не стирает его.
   */
  const canDraw = $derived(leading && !failure && !paneOpen)
  /** Чем слой чернил занят прямо сейчас. Пружина подменяет инструмент на время. */
  const liveTool = $derived(!canDraw ? 'off' : sprung ? 'laser' : tool)

  function onbusy(next: boolean): void {
    busy = next
    if (!next) lastBusyAt = performance.now()
    // Первое касание листа закрывает палитру: её работа кончилась.
    else palette = false
  }

  /**
   * Ладонь, легшая на рейл.
   *
   * Слой чернил игнорирует ладонь на самом листе; кнопки рейла — нет. Левша
   * кладёт руку справа сверху, ровно туда, где живёт «Перо». Поэтому на корне
   * пульта стоит перехватчик: пока перо занято или отпущено меньше 600 мс
   * назад, касания пальцем до КЛАВИШ РЕЙЛА не доходят.
   *
   * 600 мс — эвристика: короче — ладонь успеет нажать «Указку», длиннее —
   * большой палец перестанет работать сразу после того, как дописали слово.
   *
   * Глотаются ТОЛЬКО `pointerdown` и `click`; `pointerup` и `pointercancel`
   * проходят всегда — иначе клавиша с удержанием (ластик, указка) осталась
   * бы нажатой без подъёма и стёрла бы страницу по таймеру. `preventDefault`
   * на `pointerdown` НЕ отменяет последующий `click`, поэтому перехватчик
   * помнит указатель: нажатие принадлежит касанию целиком, и проглоченное
   * касание глотается до конца, в том числе его `click`.
   *
   * ВТОРОЕ ПРАВИЛО — ПО РАЗМЕРУ ПЯТНА, и оно действует на всём пульте, а не
   * только на рейле: касание шириной от 40 px — пятка ладони, и она не
   * нажимает ничего. Подушечка пальца на стекле — 15–20 px, пятка — 40–60.
   * Первое правило молчит, пока перо не коснулось листа, а пятка садится на
   * 100–300 мс РАНЬШЕ кончика — ровно на «Вперёд» (правша) или на «Указку»
   * (левша, рейл справа), и на поле заметок в портрете, где она уводила фокус
   * в textarea и поднимала клавиатуру посреди фразы. Размер браузер отдаёт не
   * везде (старые WebKit — 1×1), поэтому это второй замок, а не замена
   * первому.
   */
  const PALM_MS = 600
  const PALM_PX = 40

  $effect(() => {
    const node = root
    if (!node) return
    const swallowed = new Set<number>()
    const watch = (event: Event): void => {
      const pointer = event as PointerEvent
      if (!('pointerType' in pointer) || pointer.pointerType !== 'touch') return
      const id = pointer.pointerId
      const known = swallowed.has(id)
      const heel =
        event.type === 'pointerdown' && (pointer.width >= PALM_PX || pointer.height >= PALM_PX)
      const onRail = !!(event.target as Element | null)?.closest('.pult-rail')
      if (!known && !heel && !(onRail && (busy || performance.now() - lastBusyAt < PALM_MS))) return
      if (event.type === 'pointerdown') {
        swallowed.add(id)
        // `click` приходит после `pointerup`, а `pointerup` мы не трогаем —
        // забываем указатель по таймеру, которого хватит на любой тап.
        setTimeout(() => swallowed.delete(id), 1500)
      }
      event.stopPropagation()
      if (event.cancelable) event.preventDefault()
    }
    node.addEventListener('pointerdown', watch, true)
    node.addEventListener('click', watch, true)
    return () => {
      node.removeEventListener('pointerdown', watch, true)
      node.removeEventListener('click', watch, true)
    }
  })

  /**
   * Палитра закрывается ПЕРВЫМ касанием мимо неё — и касание идёт дальше.
   *
   * Раньше под палитрой лежало ложе-кнопка во весь пульт, поверх слоя ввода:
   * первый штрих уходил в ложе и не рисовался, а сама палитра оставалась
   * открытой — перо, начав на ложе, поднималось на листе, и `click` не
   * приходил. Теперь ложа нет: слушаем `pointerdown` на корне в фазе захвата,
   * закрываем палитру и НЕ останавливаем событие — как в GoodNotes, где
   * попап уходит, а штрих идёт. Касание по самой палитре и по клавише
   * «Перо» (она палитру и переключает) не в счёт.
   */
  $effect(() => {
    const node = root
    if (!node) return
    const away = (event: Event): void => {
      if (!palette) return
      const target = event.target as Element | null
      if (target?.closest('[data-pult-palette], [aria-label="Перо"]')) return
      palette = false
    }
    node.addEventListener('pointerdown', away, true)
    return () => node.removeEventListener('pointerdown', away, true)
  })

  /**
   * Щипок и двойной тап гасятся на корне пульта, а не на документе.
   *
   * Вебкитовские `gesture*` — единственный способ выключить зум страницы в
   * Safari, и выключать его надо ТОЛЬКО здесь: в тетради и в читалке щипок
   * людям нужен. Пульт показывает ровно то, что видит зал; рисовать на
   * увеличенном куске значит не знать, куда ляжет штрих на проекторе.
   */
  $effect(() => {
    const node = root
    if (!node) return
    const stop = (event: Event): void => event.preventDefault()
    const names = ['gesturestart', 'gesturechange', 'gestureend']
    for (const name of names) node.addEventListener(name, stop)
    return () => {
      for (const name of names) node.removeEventListener(name, stop)
    }
  })

  /**
   * ЛИСТАНИЕ СВАЙПОМ — ПО РЕЙЛУ, а не по листу.
   *
   * Свайп по листу убран целиком: ладонь пишущей руки приходит обычным
   * `touch` и едет вместе с рукой ровно на те же 64 px, и слайд
   * перелистывался посреди формулы у всего зала. Рейл ладонью не задевают,
   * а большой палец на нём и так лежит. Горизонтальный в ландшафте (рейл
   * сбоку), вертикальный в портрете (рейл снизу). Клавиша под пальцем при
   * сдвиге больше 12 px не нажимается: её `click` глотается на подъёме.
   */
  const SWIPE_MIN = 64
  const SWIPE_SLOP = 12

  function swipe(node: HTMLElement, axis: () => 'x' | 'y') {
    let start: { id: number; x: number; y: number } | null = null
    let moved = false
    const down = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch' || start !== null) return
      start = { id: event.pointerId, x: event.clientX, y: event.clientY }
      moved = false
    }
    const move = (event: PointerEvent): void => {
      if (!start || start.id !== event.pointerId) return
      const d = axis() === 'x' ? event.clientX - start.x : event.clientY - start.y
      if (Math.abs(d) > SWIPE_SLOP) moved = true
    }
    const up = (event: PointerEvent): void => {
      if (!start || start.id !== event.pointerId) return
      const along = axis() === 'x' ? event.clientX - start.x : event.clientY - start.y
      const across = axis() === 'x' ? event.clientY - start.y : event.clientX - start.x
      start = null
      if (event.type === 'pointercancel') return
      /*
       * Подъём тоже обязан быть на рейле, и перо в этот момент — не в деле.
       * Касание, начатое на рейле и уехавшее на лист, — это ладонь левши,
       * севшая на правый рейл и поехавшая влево вместе с рукой: те же 64 px,
       * что и свайп, и у зала переворачивалась страница посреди формулы.
       */
      const under = document.elementFromPoint(event.clientX, event.clientY)
      if (!under || !node.contains(under)) return
      if (busy) return
      if (Math.abs(along) >= SWIPE_MIN && Math.abs(along) > Math.abs(across) * 1.6) {
        // Влево или вверх — вперёд: лист «утаскивают» за собой.
        if (mayTurn) step(along < 0 ? 1 : -1)
      }
    }
    const click = (event: Event): void => {
      if (!moved) return
      moved = false
      event.stopPropagation()
      event.preventDefault()
    }
    node.addEventListener('pointerdown', down)
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', up)
    node.addEventListener('pointercancel', up)
    node.addEventListener('click', click, true)
    return {
      destroy() {
        node.removeEventListener('pointerdown', down)
        node.removeEventListener('pointermove', move)
        node.removeEventListener('pointerup', up)
        node.removeEventListener('pointercancel', up)
        node.removeEventListener('click', click, true)
      },
    }
  }

  /**
   * Свайп вниз по шапке листа заметок закрывает его — так закрывают любой
   * выдвижной лист на планшете, и палец тянется туда раньше, чем к шеврону.
   */
  function sheetSwipe(node: HTMLElement) {
    let start: { id: number; y: number } | null = null
    const down = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return
      const top = node.getBoundingClientRect().top
      if (event.clientY - top > 48) return
      start = { id: event.pointerId, y: event.clientY }
    }
    const up = (event: PointerEvent): void => {
      if (!start || start.id !== event.pointerId) return
      const dy = event.clientY - start.y
      start = null
      if (dy >= 40) setNotes(false)
    }
    node.addEventListener('pointerdown', down)
    node.addEventListener('pointerup', up)
    node.addEventListener('pointercancel', () => (start = null))
    return {
      destroy() {
        node.removeEventListener('pointerdown', down)
        node.removeEventListener('pointerup', up)
      },
    }
  }

  /* --------------------------------------------------- полный экран и сон */

  let full = $state(false)

  $effect(() => {
    const sync = (): void => {
      full = fullscreenNow()
    }
    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  })

  function toggleFullscreen(): void {
    if (full) void leaveFullscreen()
    else if (root) void goFullscreen(root)
  }

  /**
   * ПОЛНЫЙ ЭКРАН — ТОЛЬКО ПО ПРОСЬБЕ.
   *
   * Пульт разворачивался сам: «Вести» и «Взять пульт» просили полный экран
   * тем же живым жестом, а пришедшему по ссылке-ключу показывалось ложе
   * «коснитесь, чтобы взять пульт» — исключительно ради того, чтобы получить
   * жест и развернуться. То есть человек, открывший пульт посмотреть, чинить
   * заметки или подготовиться к паре, всякий раз оказывался в экране без
   * адресной строки и выходил из него руками.
   *
   * Теперь разворачивает только клавиша «Во весь экран» — в углу листа, в
   * нижней полосе и в листе «Ещё». Ложа первого касания нет вовсе.
   */

  /**
   * Экран не гаснет, пока пульт в работе.
   *
   * Автоблокировка iPad по умолчанию — две минуты, а преподаватель говорит
   * дольше. Блокировка отпускается сама, стоит вкладке уйти в фон, и обратно
   * не возвращается — переполучение живёт внутри `keepAwake`.
   */
  let wake = $state<WakeState | null>(null)
  const awakeWanted = $derived(leading || preparing)

  $effect(() => {
    if (!awakeWanted) {
      wake = null
      return
    }
    const release = keepAwake((next) => (wake = next))
    return () => {
      release()
    }
  })

  /** Молчать тут нельзя: это случается на каждой лекции. */
  const mayGoDark = $derived(
    awakeWanted && (!canKeepAwake() || wake === 'refused' || wake === 'unavailable'),
  )

  const AUTOLOCK = 'Настройки → Экран и яркость → Автоблокировка → Никогда.'
  /**
   * Гид-доступ — единственное, что убирает с iPad жест «домой» и шторки, и
   * без него ладонь, съехавшая к нижней кромке, сворачивает пульт посреди
   * лекции. Это настройка устройства, и пульт может только о ней сказать.
   */
  const GUIDED = 'Настройки → Универсальный доступ → Гид-доступ, затем трижды боковая кнопка.'

  /*
   * Пульт всегда тёмный — и это не вкус, а физика аудитории: см. borrowTheme.
   * Тема человека не трогается, в комнату он вернётся со своей.
   */
  $effect(() => {
    /*
     * `untrack` здесь обязателен, и это не осторожность.
     *
     * `borrowTheme` читает нынешнюю тему, чтобы вернуть её потом, — и пишет
     * новую. Эффект, читающий и пишущий одну руну, подписывается сам на себя:
     * Svelte честно крутит его до effect_update_depth_exceeded, после чего
     * падает всё приложение. На пульте это выглядит как «нет связи и нет
     * документов» посреди лекции, и по этой картинке причину не найти.
     */
    const release = untrack(() => borrowTheme('dark'))
    return release
  })

  /* -------------------------------------------------------------- тост */

  /**
   * Одна строка на шесть секунд — вместо модального окна.
   *
   * Живёт в левом нижнем углу листа, а не белой плашкой со дна: `bg-ink
   * text-canvas` на тёмной ветке — это светлый чип #E6E7E8, вспыхивающий на
   * шесть секунд в тёмном зале.
   */
  let notice = $state<string | null>(null)
  let noticeKind = $state<'note' | 'refusal'>('note')
  let noticeTimer: number | undefined

  function say(text: string, kind: 'note' | 'refusal' = 'note'): void {
    notice = text
    noticeKind = kind
    window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => (notice = null), 6000)
  }

  /*
   * Отказ сервера — той же строкой, что и всё остальное.
   *
   * Общая плашка комнаты на пульте не рисуется (см. SessionScreen): она
   * говорит по-английски и приносит крестик, который на планшете нажимают
   * ладонью. Но молчать об отказе нельзя — «Взять пульт у ведущего может
   * преподаватель» это ответ на нажатие, и без него нажатие выглядит
   * сломанным. Забираем сообщение себе и гасим его в комнате.
   */
  $effect(() => {
    const trouble = session.lastError
    if (!trouble) return
    untrack(() => {
      say(trouble, 'refusal')
      session.dismissError()
    })
  })

  let hadLecture = false
  $effect(() => {
    const live = lecture !== null
    if (hadLecture && !live) {
      // Закончил сам или закончил другой — разницы для экрана нет: пульт
      // возвращается к выбору документа и говорит об этом одной строкой.
      prep = null
      say('Лекция закончена')
    }
    hadLecture = live
  })

  /*
   * Про сон экрана говорим ОДИН РАЗ и тостом. Дальше справка живёт текстом в
   * «Ещё».
   */
  let darkTold = false
  $effect(() => {
    const dark = mayGoDark
    untrack(() => {
      if (!dark || darkTold) return
      darkTold = true
      say('Экран может погаснуть — см. «Ещё»', 'refusal')
    })
  })

  $effect(() => () => {
    window.clearTimeout(noticeTimer)
    window.clearTimeout(holdTimer)
    window.clearTimeout(springTimer)
  })

  /* ------------------------------------------------------------- лекция */

  const slides = $derived(
    session.files
      .filter((entry) => !entry.dir && entry.path.toLowerCase().endsWith('.pdf'))
      .sort((a, b) => b.modifiedAt - a.modifiedAt),
  )

  /**
   * Начать лекцию — и тем же живым нажатием попросить полный экран.
   *
   * Полный экран дают только из жеста человека: вызов из эффекта после
   * навигации браузер молча отклоняет.
   */
  function start(path: string): void {
    session.send({ t: 'lecture:start', file: path })
    if (preparing && wanted > 1) session.send({ t: 'lecture:page', page: wanted })
    /*
     * `prep` держим до ответа сервера.
     *
     * Сбросив его здесь, пульт на мгновение остаётся без файла вовсе — и
     * рисует экран выбора документа поверх того, что человек только что
     * выбрал. На релее через VPS это мгновение растягивается на секунду, а на
     * оборванной связи — навсегда: нажатие ушло в очередь, а на экране список
     * файлов, как будто ничего не нажимали. Снимет его приход лекции.
     */
    prep = path
    pane = null
  }

  function grab(): void {
    if (!lecture) return
    // Тот же `lecture:start` по тому же файлу: на сервере это передача пульта,
    // а не новая лекция — страница, чернила и часы остаются на месте.
    session.send({ t: 'lecture:start', file: lecture.file })
    pane = null
  }

  function stop(): void {
    session.send({ t: 'lecture:stop' })
    pane = null
  }

  /* --------------------------------------------------------- лента страниц */

  /**
   * Эскиз 160×90, а не 120×68.
   *
   * 120 px по ширине — ниже порога узнавания слайда: на такой картинке
   * различимы только цветные пятна, а неузнаваемая картинка хуже её
   * отсутствия. Цена названа вслух: каждый эскиз теперь дороже в 1.76 раза,
   * и окно отрисовки ±4 приходится держать тем строже.
   */
  const THUMB_W = 160
  const THUMB_H = 90
  const THUMB_STEP = THUMB_W + 8

  let strip = $state<HTMLDivElement | null>(null)
  let stripFrom = $state(1)
  let stripTo = $state(0)

  const pageList = $derived(Array.from({ length: pages }, (_, i) => i + 1))
  /** Заведённые чистые листы — «ЛИСТ 1», «ЛИСТ 2»…, самый старый первым. */
  const boardList = $derived(Array.from({ length: boards }, (_, i) => i + 1))

  /**
   * Эскизы рисуются только видимые, плюс четыре про запас.
   *
   * Бюджет памяти холстов на iPad один на процесс, и при переполнении WebKit
   * начинает рисовать холсты ПРОЗРАЧНЫМИ — причём не обязательно те, что его
   * переполнили. Обнулиться может лист лекции.
   */
  function scanStrip(node: HTMLElement): void {
    const first = Math.floor(node.scrollLeft / THUMB_STEP) + 1
    const last = Math.ceil((node.scrollLeft + node.clientWidth) / THUMB_STEP)
    stripFrom = Math.max(1, first - 4)
    stripTo = Math.min(pages, last + 4)
  }

  $effect(() => {
    const node = strip
    if (!node || pane !== 'pages') return
    // Открываем прокрученной так, чтобы текущая стояла в левой трети: соседи
    // справа — это то, куда идут, и они должны быть видны сразу.
    const at = wanted > 0 ? wanted : pages + -wanted
    node.scrollLeft = Math.max(0, (at - 1) * THUMB_STEP - node.clientWidth / 3)
    scanStrip(node)
  })

  /**
   * Один эскиз. Уезжая, отдаёт буфер: `width = height = 1` — единственный
   * способ заставить WebKit его отпустить, сборщик мусора не отдаёт вовремя.
   */
  function thumb(node: HTMLCanvasElement, index: number) {
    let dropped = false
    void (async () => {
      const source = doc
      if (!source) return
      const page = await source.getPage(index).catch(() => null)
      if (!page || dropped) return
      const base = page.getViewport({ scale: 1 })
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const scale = Math.min(THUMB_W / base.width, THUMB_H / base.height)
      const viewport = page.getViewport({ scale: scale * ratio })
      node.width = Math.round(viewport.width)
      node.height = Math.round(viewport.height)
      node.style.width = `${Math.round(viewport.width / ratio)}px`
      node.style.height = `${Math.round(viewport.height / ratio)}px`
      const paint = node.getContext('2d')
      if (!paint || dropped) return
      try {
        await page.render({ canvas: node, canvasContext: paint, viewport }).promise
      } catch {
        // Лист закрыли посреди отрисовки — обычный ход дела.
      }
    })()
    return {
      destroy() {
        dropped = true
        node.width = 1
        node.height = 1
      },
    }
  }

  /**
   * Чернила чистого листа — в эскиз, и НЕ холстом.
   *
   * Заведённый лист без разметки неотличим от любого другого белого
   * прямоугольника, а именно по разметке к нему и возвращаются («там, где я
   * выводил предел»). Холст на это тратить нельзя: бюджет один на процесс и
   * уже расписан под слайды. Точки хранятся долями страницы, так что
   * пересчёт в 160×90 — умножение.
   */
  function boardInk(index: number): { d: string; color: string; width: number }[] {
    return session.ink
      .filter((stroke) => stroke.page === -index && stroke.points.length >= 4)
      .map((stroke) => {
        let d = ''
        for (let at = 0; at + 1 < stroke.points.length; at += 2) {
          const x = (stroke.points[at] * THUMB_W).toFixed(1)
          const y = (stroke.points[at + 1] * THUMB_H).toFixed(1)
          d += `${at === 0 ? 'M' : 'L'}${x} ${y}`
        }
        return { d, color: stroke.color, width: Math.max(0.6, stroke.width * THUMB_W) }
      })
  }

  /* ---------------------------------------------------------- лист и заметки */

  /**
   * Что LecturePage оставил под листом (ландшафт) и сколько занял (портрет).
   * Приходит через `onfit`; на этом строится полоса-подглядка и высота
   * листовой коробки в портрете.
   */
  let fitRest = $state(0)
  let fitHeight = $state(0)

  function onfit(size: { w: number; h: number; rest: number }): void {
    fitRest = size.rest
    fitHeight = size.h
  }

  /**
   * Высота коробки листа в портрете — ПО ЛИСТУ, а не «половина экрана».
   *
   * До первого замера отдаём 45 % высоты: слайд 16:9 на 834 впишется по
   * ширине и займёт 456, а не 537, и остаток сообщит `onfit`. Сжав коробку до
   * листа плюс поля, получаем то же вписывание (по ширине — ничего не
   * меняется, по высоте — остаётся ровно та высота, что и была), то есть
   * схема сходится за один шаг и не качается.
   */
  /**
   * ПОДЛОКОТНИК в портрете: 96 px колодца под листом, принадлежащих коробке
   * листа, а не заметкам. Поле заметок начиналось в 53 px под нижней кромкой
   * бумаги, и пятка ладони, пишущей на нижней трети слайда, попадала в
   * textarea: фокус уходил в заметки, слой ввода гас, на iPad всплывала
   * клавиатура на полэкрана, а Pencil, заехавший на поле, начинал Scribble.
   * Слой ввода накрывает подлокотник вместе с бумагой (`reach`), и ладонь на
   * нём — ничто.
   */
  const PALM_REST = 96
  const portraitSheetH = $derived(
    fitHeight > 0 ? fitHeight + 24 + PALM_REST : Math.round(box.h * 0.45) + PALM_REST,
  )

  /**
   * Размер коробки листа — для слоя ввода чернил.
   *
   * Слой ввода накрывает коробку целиком, а не одну страницу: поля — это
   * место пятки ладони и край, с которого начинают штрих (InkLayer, `reach`).
   * Страница лежит по центру коробки по ширине и прижата к её верху под
   * полем 12; остаток под ней — тоже коробка.
   */
  const SHEET_PAD = 12
  let sheetW = $state(0)
  let sheetH = $state(0)
  function inkReach(size: { w: number; h: number }): { top: number; right: number; bottom: number; left: number } {
    const side = Math.max(0, (sheetW - size.w) / 2)
    return { top: SHEET_PAD, right: side, bottom: Math.max(0, sheetH - SHEET_PAD - size.h), left: side }
  }

  /** Заметка к этой странице, для подглядки: только когда они уже приехали. */
  const peekNote = $derived(session.notesFile === file ? (session.notes[wanted] ?? '') : '')
  /** Полоса-подглядка живёт, когда под листом есть хотя бы 110 px. */
  const peekShown = $derived(!portrait && !notesOpen && fitRest >= 110 && file !== null)

  /** Ширина выдвижного листа заметок по кеглю: 400 на 820, 480 на 12.9". */
  const notesSheetH = $derived(box.h >= 1000 ? 480 : 400)

  /* ---------------------------------------------------------- клавиатура */

  /*
   * Клавиатура — для кликалки, воткнутой в ноутбук у проектора, и для того,
   * кто ведёт с ноутбука. Ни одной клавиши, заканчивающей лекцию или стирающей
   * страницу: нащупать их вслепую слишком легко. Буквы читаются по `code`, а
   * не по `key`: на русской раскладке `key` — это «и», «м» и «д».
   */
  function onkeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null
    const typing = target?.closest('input, textarea, [contenteditable]') != null
    if (event.key === 'Escape') {
      if (palette) {
        event.preventDefault()
        palette = false
      } else if (pane !== null) {
        event.preventDefault()
        openPane(null)
      } else if (!portrait && notesOpen) {
        event.preventDefault()
        setNotes(false)
      }
      return
    }
    if (typing || !mayTurn) return
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault()
      step(1)
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault()
      step(-1)
    } else if (event.code === 'KeyB') {
      event.preventDefault()
      blank(!lecture?.blank)
    } else if (event.code === 'KeyZ') {
      event.preventDefault()
      undoStroke()
    } else if (event.code === 'KeyE') {
      event.preventDefault()
      pick('eraser')
    } else if (event.code === 'KeyM') {
      event.preventDefault()
      pick('marker')
    } else if (event.code === 'KeyL') {
      // Указка на клавиатуре — пружина: держат — светит. Автоповтор сюда
      // приходит десятками, и каждый повтор просто подтверждает `true`.
      event.preventDefault()
      if (leading && !offline) sprung = true
    } else if (event.code === 'KeyN') {
      event.preventDefault()
      if (!portrait) setNotes(!notesOpen)
    } else if (/^Digit[1-3]$/.test(event.code)) {
      event.preventDefault()
      penIn(INKS[Number(event.code.slice(5)) - 1].color)
    }
  }

  function onkeyup(event: KeyboardEvent): void {
    if (event.code === 'KeyL') sprung = false
  }

  /* ------------------------------------------------------------- классы */

  /*
   * Кнопки собраны руками, поэтому список свойств перехода выписан целиком:
   * утилита `transition-colors` переписала бы `transition-property` и
   * выбросила из него `transform`, то есть само нажатие.
   *
   * Нажатие — единственное доказательство, что касание услышано, на экране,
   * который может не измениться вовсе. Поэтому оно остаётся и при
   * `prefers-reduced-motion`.
   */
  const PRESS =
    'transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'enabled:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'

  /*
   * КЛАВИША.
   *
   * В покое заливки нет вовсе — только подпись или глиф на корпусе: панель
   * инструментов в покое это надписи на теле предмета, а не двенадцать
   * коробок. Под пальцем — `bg-line`. Включённая — `bg-raised` плюс полоса
   * 3 px на ВНУТРЕННЕЙ кромке, см. `mark()`.
   */
  const KEY = `relative flex shrink-0 items-center justify-center ${PRESS} enabled:active:bg-line`
  /** Подпись действия: 0.14em называет ДЕЙСТВИЕ. Трекингов на пульте ровно два. */
  const CAP = 'text-2xs font-bold uppercase tracking-label'
  /** Название места: 0.2em называет МЕСТО (полоса, область). */
  const SECTION = 'text-micro font-bold uppercase tracking-section'
  /** Строка поднятого листа. */
  const ROW = `flex h-16 w-full items-center gap-3 px-6 text-left text-answer ${PRESS} enabled:active:bg-line`

  /**
   * Подпись выключенной клавиши: `faint` на 70 % — ОТСУТСТВИЕ, а не
   * информация. `disabled:text-faint/70` выписан в разметке буквами: сборщик
   * Tailwind ищет классы текстом и склеенной строки не увидит.
   */
  const OFF = 'text-faint/70'

  /** Сторона «внутренней» кромки клавиши: та, что смотрит на лист. */
  const inner = $derived<'left' | 'right' | 'top'>(
    portrait ? 'top' : hand === 'left' ? 'left' : 'right',
  )
</script>

<svelte:window {onkeydown} {onkeyup} onblur={laserCancel} />

<!--
  Отступы под вырезом и домашним индикатором — на корне, одним местом. Ни
  одного `vh`: цепочка `height: 100%` не зависит ни от панелей Safari, ни от
  того, в каком окне сейчас живёт планшет.

  Грунт корня — колодец (`canvas`): середина проваливается, а корпус рейла
  (`surface`) выходит вперёд. Шаг между ними ~1,5 % — его не читают, его
  чувствуют.
-->
<div
  bind:this={root}
  class="pult-root relative flex h-full w-full flex-col overflow-hidden bg-canvas text-ink"
  style="padding-top: env(safe-area-inset-top); padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); padding-bottom: env(safe-area-inset-bottom)"
>
  {#if !host}
    <!--
      Ссылка-ключ может уехать студенту, и он окажется здесь. Пульт об этом
      говорит и предлагает единственное, что ему тут нужно.
    -->
    <div class="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <p class="text-ui-lg text-ink">Пульт открывается у преподавателя</p>
      <button type="button" class="btn-outline h-11 px-6" onclick={onexit}>В комнату</button>
    </div>
  {:else if lecture === null && prep === null}
    {@render chooser()}
  {:else if portrait}
    <!--
      ПОРТРЕТ. Лист сверху на полях 12, заметки пристыкованы на весь остаток,
      рейл снизу — под большим пальцем держащей руки. Клавиши «Заметки» нет:
      заметки и так на экране.
    -->
    <div class="flex min-h-0 flex-1 flex-col">
      <div
        class="pult-sheet relative shrink-0 p-3"
        style={`height:${portraitSheetH}px`}
        role="group"
        aria-label="Страница лекции"
        bind:clientWidth={sheetW}
        bind:clientHeight={sheetH}
      >
        {@render sheet()}
      </div>
      {#if file !== null}
        <div class="flex min-h-0 flex-1 flex-col border-t border-line" data-pult-notes>
          <NotesPad
            {file}
            page={wanted}
            folded={false}
            docked
            onmore={() => openPane('more')}
            onedit={(next) => (editing = next)}
          />
        </div>
      {/if}
      {@render bottomRail()}
    </div>
  {:else}
    <!--
      ЛАНДШАФТ. Один рейл 72 px у кромки, и ширина принадлежит руке: при
      «левой руке» он переезжает на правую кромку вместе с палитрой.
    -->
    <div class="flex min-h-0 flex-1 {hand === 'left' ? 'flex-row-reverse' : ''}">
      {@render sideRail()}
      <div class="relative min-h-0 min-w-0 flex-1">
        <!--
          Коробка листа — С ПОЛЯМИ 12 px, как и в портрете: поля принадлежат
          листу, а не колодцу. На них лежит пятка ладони и с них начинают
          штрих, и слой ввода чернил накрывает их вместе с бумагой.
        -->
        <div
          class="pult-sheet absolute inset-0 p-3"
          role="group"
          aria-label="Страница лекции"
          bind:clientWidth={sheetW}
          bind:clientHeight={sheetH}
        >
          {@render sheet()}
          {#if peekShown}
            {@render peek()}
          {/if}
        </div>
        {#if file !== null && notesOpen}
          {@render notesSheet()}
        {/if}
      </div>
    </div>
  {/if}

  {#if palette && leading}
    {@render palettePop()}
  {/if}

  {@render panes()}

</div>

<!-- ============================================================== прибор -->

{#snippet fader(cell: string, tall: number)}
  <!--
    Три детента, а не циклическая кнопка: у фейдера всегда видно текущее
    положение. Столбики растут 4 / 9 / 14 — положение читается формой, а не
    подписью, и нащупывается на слух руки за один взгляд.
  -->
  <div class="flex" role="radiogroup" aria-label="Яркость листа">
    {#each LAMPS as level, index (level.name)}
      <button
        type="button"
        role="radio"
        aria-checked={lamp === index}
        aria-label={level.name}
        class="{PRESS} flex {cell} items-end justify-center pb-1 {lamp === index ? 'bg-raised' : ''}"
        onclick={() => setLamp(index)}
      >
        <span
          class="block w-[14px] {lamp === index ? 'bg-ink' : 'bg-faint/70'}"
          style={`height:${Math.round((level.bar * tall) / 14)}px`}
          aria-hidden="true"
        ></span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet tempo(width: string)}
  <!--
    ЛИНЕЙКА ТЕМПА — доля колоды как форма, а не как арифметика: где мы в
    этой пачке. При расхождении с проектором она же становится циановой и
    ползёт петлёй 1.2 с — «мы всё ещё ждём». Это сноска, а не замена числа:
    большое число показывает то, что вы РЕШИЛИ, и обязано стоять неподвижно.
  -->
  <span class="block h-[2px] {width} bg-line" aria-hidden="true">
    <span
      class="block h-full w-full origin-left {behind
        ? 'pult-catchup bg-accent'
        : 'bg-muted transition-transform duration-[160ms] ease-out'}"
      style={behind ? undefined : `transform:scaleX(${pages > 0 ? Math.min(1, wanted / pages) : 0})`}
    ></span>
  </span>
{/snippet}

{#snippet gauge()}
  <!--
    ПРИБОР 72×120. Не кнопка по своей сути, а ПОКАЗАНИЕ: номер, доля колоды,
    стенные часы, яркость. Плита нажимается (открывает ленту страниц), но на
    это не рассчитывают. Секундомер отсюда уехал в шапку заметок и в «Ещё»:
    на 72 px ему не встать рядом с номером, а смотрят его реже номера.

    Номер флагуется влево с поправкой −2 px: у моноцифр боковые полуапроши,
    и без поправки число выглядит сдвинутым вправо относительно столбца.
  -->
  <div class="relative h-[120px] w-full shrink-0">
    <button
      type="button"
      class="{PRESS} absolute inset-x-0 top-0 h-[92px] enabled:active:bg-line"
      aria-label="Выбрать страницу"
      onclick={() => openPane('pages')}
    >
      {#if behind && lecture}
        <!--
          ЧТО ВИДИТ ЗАЛ, когда проектор отстал. Мелко, справа и ПЕРВЫМ:
          сноска отвечает на вопрос «где они», большое число — «где я».
          Появляется только после 600 мс расхождения, вместе с петлёй.
        -->
        <span
          class="absolute right-1.5 top-1.5 flex h-[13px] items-center font-mono text-code tabular-nums text-muted"
        >
          {lecture.page < 0 ? `Л${-lecture.page}` : lecture.page}&nbsp;→
        </span>
      {/if}
      <span
        class="absolute left-[10px] top-2 flex h-8 items-center font-mono text-gauge tabular-nums {watching ||
        preparing
          ? 'text-muted'
          : 'text-ink'}"
      >
        {onBoard ? `Л${-wanted}` : wanted}
      </span>
      {#if onBoard}
        <span class="absolute left-3 top-[44px] flex h-[13px] items-center {SECTION} text-muted">
          лист
        </span>
      {:else}
        <!-- Знаменатель отдельной строкой: иначе он ездит при переходе 9 → 10. -->
        <span
          class="absolute left-3 top-[44px] flex h-[13px] items-center font-mono text-code tabular-nums text-faint"
        >
          / {pages || '—'}
        </span>
        <span class="absolute left-3 top-[62px]">{@render tempo('w-[52px]')}</span>
      {/if}
      <span
        class="absolute left-3 top-[70px] flex h-[13px] items-center font-mono text-code tabular-nums text-muted"
      >
        {preparing ? 'подготовка' : wall}
      </span>
    </button>

    <div class="absolute left-[3px] top-[94px]">
      {@render fader('h-6 w-[22px]', 14)}
    </div>
  </div>
{/snippet}

{#snippet gaugeFlat()}
  <!--
    Прибор нижнего рейла, 104×64: номер слева, знаменатель, темп и фейдер
    столбиком справа. Та же иерархия, положенная набок.
  -->
  <div class="relative flex h-full w-[104px] shrink-0">
    <button
      type="button"
      class="{PRESS} relative flex h-full w-[52px] flex-col items-start justify-center pl-2 enabled:active:bg-line"
      aria-label="Выбрать страницу"
      onclick={() => openPane('pages')}
    >
      <span
        class="font-mono text-gauge tabular-nums {watching || preparing ? 'text-muted' : 'text-ink'}"
      >
        {onBoard ? `Л${-wanted}` : wanted}
      </span>
      {#if !onBoard}
        <span class="font-mono text-micro tabular-nums text-faint">/ {pages || '—'}</span>
      {/if}
    </button>
    <div class="flex w-[52px] flex-col items-start justify-center gap-1">
      {#if !onBoard}
        {@render tempo('w-[44px]')}
      {/if}
      {#if !tiny}
        {@render fader('h-5 w-4', 12)}
      {/if}
    </div>
  </div>
{/snippet}

<!-- ============================================================== рейл -->

{#snippet toast()}
  <!--
    Одна строка на шесть секунд. Полоса 2 px слева называет род: accent —
    сообщение, danger — отказ.
  -->
  {#if notice}
    <div class="pointer-events-none relative flex h-8 items-center bg-raised px-4" aria-live="polite">
      <span
        class="absolute inset-y-0 left-0 w-[2px] {noticeKind === 'refusal' ? 'bg-danger' : 'bg-accent'}"
        aria-hidden="true"
      ></span>
      <span class="{CAP} text-ink">{notice}</span>
    </div>
  {/if}
{/snippet}

{#snippet mark(on: boolean, amber: boolean)}
  <!--
    Полоса «включено» на ВНУТРЕННЕЙ кромке — той, что смотрит на лист.
    Направление несёт смысл: «вот что перо делает там». Не анимируется:
    состояние приходит мгновенно.
  -->
  {#if on}
    <span
      class="absolute {inner === 'top'
        ? 'inset-x-0 top-0 h-[3px]'
        : inner === 'left'
          ? 'inset-y-0 left-0 w-[3px]'
          : 'inset-y-0 right-0 w-[3px]'} {amber ? 'bg-warning' : 'bg-ink'}"
      aria-hidden="true"
    ></span>
  {/if}
{/snippet}

{#snippet chip(color: string, marker: boolean, dot: number)}
  <!--
    ЧИП ПИГМЕНТА — ОБРАЗЕЦ НА БУМАГЕ: плашка 40×24 белой бумаги, внутри
    настоящий штрих с круглой концевой. Тёмный диск #101a33 на ночном корпусе
    — это 1.5:1, чёрного пера на рейле не было видно вовсе; на бумаге видно
    всё. Точка толщины — та же, что в палитре: чип говорит, ЧЕМ ляжет штрих.
  -->
  <span class="block h-6 w-10 bg-white" aria-hidden="true">
    <svg width="40" height="24" viewBox="0 0 40 24" class="block">
      {#if marker}
        <line x1="9" y1="12" x2="31" y2="12" stroke={color} stroke-width="14" stroke-linecap="round" />
      {:else}
        <line x1="9" y1="16" x2="31" y2="8" stroke={color} stroke-width={dot} stroke-linecap="round" />
      {/if}
    </svg>
  </span>
{/snippet}

{#snippet toolKeys(size: string, gap: string)}
  <!--
    ПАЛИТРА ИНСТРУМЕНТОВ — ОДИН РЯД: перо, маркер, ластик, указка. Ровно
    так, как в приложениях для заметок: взял одно — снял другое. Указка тут
    же, а не отдельной пружиной на другом рейле.
  -->
  <button
    type="button"
    class="{KEY} {size} {tool === 'pen' ? 'bg-raised' : ''}"
    aria-label="Перо"
    aria-pressed={tool === 'pen'}
    aria-expanded={palette}
    onclick={penKey}
  >
    {@render mark(tool === 'pen', false)}
    {@render chip(inkColor, false, WIDTHS.find((w) => w.width === penWidth)?.dot ?? 6)}
  </button>
  <span class={gap} aria-hidden="true"></span>
  <button
    type="button"
    class="{KEY} {size} {tool === 'marker' ? 'bg-raised' : ''}"
    aria-label="Маркер"
    aria-pressed={tool === 'marker'}
    onclick={() => pick('marker')}
  >
    {@render mark(tool === 'marker', false)}
    {@render chip(MARKER, true, 0)}
  </button>
  <span class={gap} aria-hidden="true"></span>
  <!--
    Ластик стирает ШТРИХАМИ, а не пикселями: в проводе есть только «убрать
    штрих по имени». Удержание полсекунды стирает страницу целиком.
  -->
  <button
    type="button"
    class="{KEY} {size} {tool === 'eraser' ? 'bg-raised text-ink' : 'text-muted'}"
    aria-label="Ластик"
    aria-pressed={tool === 'eraser'}
    onpointerdown={eraserDown}
    onpointerup={eraserUp}
    onpointerleave={eraserCancel}
    onpointercancel={eraserCancel}
    onclick={(event) => {
      // С клавиатуры `click` приходит с detail === 0 и без пары
      // pointerdown/pointerup — иначе кнопка была бы недоступна без пальца.
      if (event.detail === 0) pick('eraser')
    }}
  >
    {@render mark(tool === 'eraser', false)}
    <Icon name="eraser" size={24} />
  </button>
  <span class={gap} aria-hidden="true"></span>
  <button
    type="button"
    class="{KEY} {size} {CAP} {tool === 'laser' || sprung ? 'bg-raised' : ''} {offline
      ? OFF
      : tool === 'laser' || sprung
        ? 'text-ink'
        : 'text-muted'}"
    aria-label="Указка"
    aria-pressed={tool === 'laser'}
    disabled={offline}
    onpointerdown={laserDown}
    onpointerup={laserUp}
    onpointercancel={laserCancel}
    onpointerleave={laserCancel}
    onclick={(event) => {
      // Нажатие БЕЗ пары pointerdown/pointerup: клавиатура, VoiceOver,
      // автоматическая проверка. Их `click` приходит с detail === 0.
      if (event.detail === 0) laserToggle()
    }}
  >
    {@render mark(tool === 'laser' || sprung, false)}
    Указка
  </button>
{/snippet}

{#snippet sideRail()}
  <!--
    ОДИН РЕЙЛ, 72 px. Разделительных волосков между клавишами нет: разделяет
    корпус — зазор 4 значит «соседи по семейству», вырез 16 значит «граница
    семейств». Сверху вниз: прибор, инструменты, «Отменить», распорка,
    навигация по колоде, листание. Верх рейла — глазу, низ — пальцу.

    Внутренняя кромка при обрыве связи краснеет: тонкий красный шов по
    стороне светящегося окна виден боковым зрением и не занимает ни одного
    пикселя раскладки.
  -->
  <div
    use:swipe={() => 'x'}
    class="pult-rail flex w-[72px] shrink-0 flex-col bg-surface {hand === 'left'
      ? 'border-l'
      : 'border-r'} {offline ? 'border-danger/40' : 'border-line'}"
  >
    {@render gauge()}
    <span class="h-4 shrink-0" aria-hidden="true"></span>

    {#if leading}
      {@render toolKeys('h-14 w-full', 'h-1 shrink-0')}
      <span class="h-2 shrink-0" aria-hidden="true"></span>
      <!--
        ОТМЕНИТЬ — под инструментами: плохой штрих делает перо, и рука уже
        над листом рядом с рейлом.
      -->
      <button
        type="button"
        class="{KEY} h-11 w-full text-muted"
        onclick={undoStroke}
        aria-label="Отменить последний штрих"
      >
        <Icon name="undo" size={22} />
      </button>
    {/if}

    <span class="min-h-6 flex-1" aria-hidden="true"></span>

    {#if mayTurn}
      <!--
        ЛИСТ остаётся клавишей: чистый лист заводят посреди фразы («слайд
        кончился, а вывод формулы — нет»), и два нажатия для этого — уже
        отказ. В ленте страниц он тоже есть, последней плиткой.
      -->
      <button
        type="button"
        class="{KEY} h-14 w-full {onBoard ? 'bg-raised text-ink' : 'text-muted'} {CAP}"
        aria-label={onBoard ? 'Вернуться к слайду' : 'Чистый лист'}
        aria-pressed={onBoard}
        onclick={() => (onBoard ? backToSlides() : newBoard())}
      >
        {@render mark(onBoard, false)}
        {onBoard ? 'Слайд' : 'Лист'}
      </button>
      <span class="h-1 shrink-0" aria-hidden="true"></span>
    {/if}

    {#if preparing}
      <!-- На месте ГАСИТЬ у подготовки — «ВЕСТИ»: единственная залитая
           циановая плита на пульте, и за ней ровно одно действие. -->
      <button
        type="button"
        class="{KEY} h-14 w-full bg-accent text-accent-ink {CAP}"
        onclick={() => prep && start(prep)}
      >
        Вести
      </button>
      <span class="h-1 shrink-0" aria-hidden="true"></span>
    {:else if leading}
      <!--
        ГАСИТЬ. Состояние света показывает сам свет: у пульта отнимается
        свет, а не добавляется. Янтарь — единственное его место на пульте;
        красного здесь нет, потому что пауза — не отказ. Слово короткое не
        от бедности: «ЗАТЕМНИТЬ» в девять капителей с разрядкой шире клавиши
        72 px и выползало за рейл на обе стороны.
      -->
      <button
        type="button"
        class="{KEY} h-14 w-full {CAP} {lecture?.blank ? 'bg-raised' : ''} {offline
          ? OFF
          : lecture?.blank
            ? 'text-warning'
            : 'text-muted'}"
        aria-label={lecture?.blank ? 'Вернуть проекцию' : 'Затемнить проекцию'}
        aria-pressed={lecture?.blank}
        disabled={offline}
        onclick={() => blank(!lecture?.blank)}
      >
        {@render mark(lecture?.blank === true, true)}
        {lecture?.blank ? 'Темно' : 'Гасить'}
      </button>
      <span class="h-1 shrink-0" aria-hidden="true"></span>
    {:else if watching}
      <!--
        Ведёт другой. Единственная клавиша: контур без заливки — залитая
        плита горела бы все сорок минут чужой лекции ради одного нажатия.
      -->
      <button
        type="button"
        class="{PRESS} mx-1 flex h-[112px] shrink-0 items-center justify-center border border-accent px-1 text-center {CAP} text-accent-text active:bg-line"
        onclick={() => openPane('grab')}
      >
        Взять пульт
      </button>
      <span class="h-1 shrink-0" aria-hidden="true"></span>
    {/if}

    {#if file !== null}
      <button
        type="button"
        class="{KEY} h-14 w-full {CAP} {notesOpen ? 'bg-raised text-ink' : 'text-muted'}"
        aria-label="Заметки"
        aria-pressed={notesOpen}
        onclick={() => setNotes(!notesOpen)}
      >
        {@render mark(notesOpen, false)}
        Заметки
      </button>
    {/if}

    <!-- ВЫРЕЗ 16: граница семейств «колода» и «листание». -->
    <span class="h-4 shrink-0" aria-hidden="true"></span>

    {#if mayTurn}
      <button
        type="button"
        class="{KEY} h-14 w-full text-muted disabled:text-faint/70"
        disabled={onBoard ? -wanted >= boards : wanted <= 1}
        aria-label="Предыдущая страница"
        onclick={() => step(-1)}
      >
        <Icon name="chevron-left" size={24} />
      </button>
      <span class="h-1 shrink-0" aria-hidden="true"></span>
      <!-- Самая большая клавиша: вперёд листают в восемь раз чаще, чем назад. -->
      <button
        type="button"
        class="{KEY} h-24 w-full flex-col gap-1 text-ink disabled:text-faint/70"
        disabled={!onBoard && pages > 0 && wanted >= pages}
        aria-label="Следующая страница"
        onclick={() => step(1)}
      >
        <Icon name="chevron-right" size={28} />
        <span class="{CAP}">{forwardReturns ? 'К слайду' : 'Вперёд'}</span>
        {#if forwardReturns}
          <span class="font-mono text-code tabular-nums text-faint">{lastSlide}</span>
        {/if}
      </button>
    {:else}
      <span class="flex h-14 shrink-0 items-center justify-center px-1 {SECTION} text-muted">
        <span class="truncate">Ведёт {lecture?.byName}</span>
      </span>
    {/if}

    <!-- Резерв домашнего индикатора: ни одна клавиша сюда не заходит. -->
    <span class="h-5 shrink-0" aria-hidden="true"></span>
  </div>
{/snippet}

{#snippet bottomRail()}
  <!--
    НИЖНИЙ РЕЙЛ портрета, 64 px: та же последовательность, положенная набок.
    Свайп по нему — вертикальный.
  -->
  <div
    use:swipe={() => 'y'}
    class="pult-rail flex h-16 shrink-0 items-stretch border-t bg-surface {offline
      ? 'border-danger/40'
      : 'border-line'}"
  >
    {@render gaugeFlat()}
    <span class="w-4 shrink-0" aria-hidden="true"></span>
    {#if leading}
      {@render toolKeys('h-full w-[72px]', 'w-0')}
      <span class="w-2 shrink-0" aria-hidden="true"></span>
      <button
        type="button"
        class="{KEY} h-full w-12 text-muted"
        onclick={undoStroke}
        aria-label="Отменить последний штрих"
      >
        <Icon name="undo" size={22} />
      </button>
    {/if}
    <span class="min-w-4 flex-1" aria-hidden="true"></span>
    {#if mayTurn}
      <button
        type="button"
        class="{KEY} h-full w-[72px] {onBoard ? 'bg-raised text-ink' : 'text-muted'} {CAP}"
        aria-label={onBoard ? 'Вернуться к слайду' : 'Чистый лист'}
        aria-pressed={onBoard}
        onclick={() => (onBoard ? backToSlides() : newBoard())}
      >
        {@render mark(onBoard, false)}
        {onBoard ? 'Слайд' : 'Лист'}
      </button>
    {/if}
    {#if preparing}
      <button
        type="button"
        class="{KEY} h-full w-[72px] bg-accent text-accent-ink {CAP}"
        onclick={() => prep && start(prep)}
      >
        Вести
      </button>
    {:else if leading}
      <button
        type="button"
        class="{KEY} h-full w-[72px] {CAP} {lecture?.blank ? 'bg-raised' : ''} {offline
          ? OFF
          : lecture?.blank
            ? 'text-warning'
            : 'text-muted'}"
        aria-label={lecture?.blank ? 'Вернуть проекцию' : 'Затемнить проекцию'}
        aria-pressed={lecture?.blank}
        disabled={offline}
        onclick={() => blank(!lecture?.blank)}
      >
        {@render mark(lecture?.blank === true, true)}
        {lecture?.blank ? 'Темно' : 'Гасить'}
      </button>
    {:else if watching}
      <button
        type="button"
        class="{PRESS} my-2 flex w-[104px] shrink-0 items-center justify-center border border-accent px-1 text-center {CAP} text-accent-text active:bg-line"
        onclick={() => openPane('grab')}
      >
        Взять пульт
      </button>
    {/if}
    <span class="w-4 shrink-0" aria-hidden="true"></span>
    {#if mayTurn}
      <button
        type="button"
        class="{KEY} h-full w-16 text-muted disabled:text-faint/70"
        disabled={onBoard ? -wanted >= boards : wanted <= 1}
        aria-label="Предыдущая страница"
        onclick={() => step(-1)}
      >
        <Icon name="chevron-left" size={24} />
      </button>
      <button
        type="button"
        class="{KEY} h-full w-[112px] gap-2 text-ink disabled:text-faint/70"
        disabled={!onBoard && pages > 0 && wanted >= pages}
        aria-label="Следующая страница"
        onclick={() => step(1)}
      >
        <Icon name="chevron-right" size={28} />
        <span class="{CAP}">{forwardReturns ? 'К слайду' : 'Вперёд'}</span>
      </button>
    {:else}
      <span class="flex w-[112px] shrink-0 items-center justify-center px-1 {SECTION} text-muted">
        <span class="truncate">Ведёт {lecture?.byName}</span>
      </span>
    {/if}
  </div>
{/snippet}

<!-- ============================================================== палитра -->

{#snippet palettePop()}
  <!--
    ПАЛИТРА ПЕРА: цвет и толщина, 232×120. Стоит рядом с клавишей «Перо» —
    справа от рейла на её высоте (ландшафт) или над рейлом (портрет), — а не
    листом снизу: это настройка инструмента, и глаз не должен уходить от
    руки. Ложа под ней нет: тап мимо закрывает её перехватчиком на корне
    (см. эффект у `palette`) и идёт дальше — на лист, на клавишу, куда
    попал; ложе-кнопка во весь пульт съедало первый штрих.

    Корпус палитры для указателя ПРОЗРАЧЕН, нажимаются только её кнопки:
    палитра висит над бумагой, и перо, севшее в её поле или зазор, раньше
    уходило в корпус — штрих не рисовался, палитра не закрывалась. Теперь
    такое перо попадает в слой ввода, а перехватчик закрывает палитру.
  -->
  <div
    class="pointer-events-none absolute z-20 flex w-[232px] flex-col gap-2 border border-line bg-surface p-3"
    style={portrait
      ? `left: calc(120px + env(safe-area-inset-left)); bottom: calc(76px + env(safe-area-inset-bottom))`
      : hand === 'left'
        ? `right: calc(84px + env(safe-area-inset-right)); top: calc(136px + env(safe-area-inset-top))`
        : `left: calc(84px + env(safe-area-inset-left)); top: calc(136px + env(safe-area-inset-top))`}
    data-pult-palette
  >
    <div class="flex gap-2" role="radiogroup" aria-label="Цвет пера">
      {#each INKS as choice (choice.color)}
        {@const on = inkColor === choice.color}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          aria-label={choice.name}
          class="{PRESS} pointer-events-auto flex h-11 w-16 items-center justify-center {on ? 'bg-raised' : ''} active:bg-line"
          onclick={() => penIn(choice.color)}
        >
          {@render chip(choice.color, false, 6)}
        </button>
      {/each}
    </div>
    <div class="flex gap-2" role="radiogroup" aria-label="Толщина">
      {#each WIDTHS as choice (choice.width)}
        {@const on = penWidth === choice.width}
        <button
          type="button"
          role="radio"
          aria-checked={on}
          aria-label={choice.name}
          class="{PRESS} pointer-events-auto flex h-11 w-16 items-center justify-center {on ? 'bg-raised' : ''} active:bg-line"
          onclick={() => penWide(choice.width)}
        >
          <span
            class="block rounded-full {on ? 'bg-ink' : 'bg-muted'}"
            style={`width:${choice.dot}px;height:${choice.dot}px`}
            aria-hidden="true"
          ></span>
        </button>
      {/each}
    </div>
  </div>
{/snippet}

<!-- ============================================================== лист -->

{#snippet sheetOver(size: { w: number; h: number })}
  <!--
    Всё, что лежит НА листе, — одним местом и в порядке отрисовки.

    1. Пелена затемнения: полотно на 0.28, чернила на 1.0 — рисунок готовят
       под затемнением и снимают паузу уже с ним. Пелена цвета колодца на
       0.72 ПОД слоем чернил даёт ровно тот кадр.
    2. Чернила — три холста и слой ввода, хозяин всех касаний листа.
    3. Пелена фейдера — поверх листа И чернил, внутри листа.
    4. Растушёвка: 1 px кромка `line` и 6 px тени бумаги на колодце.
    5. Плита «зал видит чёрное» и цель во весь лист.
  -->
  {#if lecture?.blank}
    <span class="pointer-events-none absolute inset-0 bg-canvas opacity-[0.72]" aria-hidden="true"
    ></span>
  {/if}

  <InkLayer
    page={wanted}
    live={canDraw && !editing}
    tool={liveTool}
    color={strokeColor}
    width={strokeWidth}
    finger={fingerOn}
    w={size.w}
    h={size.h}
    reach={inkReach(size)}
    {onbusy}
    onundo={undoStroke}
    onpen={penFound}
  />

  <!--
    `data-pult-veil` — метка для проверки интерфейса: поверх листа лежат ДВЕ
    пелены цвета колодца, и метка стоит ровно на той, которой управляет
    фейдер. 320 мс — театральные фейдеры не щёлкают.
  -->
  <span
    class="pult-veil pointer-events-none absolute inset-0 bg-canvas"
    style={`opacity:${veil}`}
    data-pult-veil
    aria-hidden="true"
  ></span>

  <span class="pult-halo pointer-events-none absolute inset-0" aria-hidden="true"></span>

  {#if lecture?.blank}
    <!--
      Цель — ПЛИТА 320×56 внизу листа, а не весь лист. Была во весь лист
      «чтобы попадать не глядя», и это отменяло то, ради чего затемняют:
      спрятать зал, подготовить вывод пером, показать — первое же касание
      пера возвращало проекцию и не рисовало, а случайная ладонь снимала
      затемнение. Внизу по центру: туда не ложится ни пятка правши, ни левши,
      и туда же смотрят, когда ищут «вернуть».
    -->
    <button
      type="button"
      class="{PRESS} absolute bottom-6 left-1/2 z-10 flex h-[56px] w-[320px] -translate-x-1/2 flex-col items-center justify-center gap-1 border border-line bg-surface/[0.88]"
      onclick={() => blank(false)}
      disabled={!leading || offline}
    >
      <span class="{CAP} text-warning">Зал видит чёрное</span>
      <span class="{SECTION} text-muted">Нажмите, чтобы вернуть</span>
    </button>
  {/if}
{/snippet}

{#snippet sheet()}
  {#if failure}
    <!--
      Не открылся ВАШ экземпляр — истёк токен, лопнула сеть, битый кэш, — а
      у проектора документ, скорее всего, открыт. Поэтому рейл, номер и
      заметки продолжают работать: отнимать управление из-за собственной
      неудачи — худшее, что пульт может сделать.
    -->
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon name="alert" size={24} class="text-danger" />
      <p class="text-answer text-ink">Не удалось открыть документ</p>
      <p class="font-mono text-code text-faint">{file}</p>
      <div class="mt-3 flex gap-3">
        <button
          type="button"
          class="{PRESS} flex h-12 w-[176px] items-center justify-center border border-line {CAP} text-muted"
          onclick={() => (attempt += 1)}
        >
          Попробовать снова
        </button>
        <button
          type="button"
          class="{PRESS} flex h-12 w-[176px] items-center justify-center border border-line {CAP} text-muted"
          onclick={() => openPane('files')}
        >
          Сменить документ
        </button>
      </div>
    </div>
  {:else}
    <!--
      Лист прижат к ВЕРХУ коробки, а не к центру: остаток под ним — место
      подглядки заметок и эскиза «дальше», а не два одинаковых зазора.
    -->
    <div class="flex h-full min-h-0 min-w-0 flex-col">
      <LecturePage {doc} page={wanted} bare align="top" {onfit}>
        {#snippet over(size)}
          {@render sheetOver(size)}
        {/snippet}
      </LecturePage>
    </div>
  {/if}

  {#if fullscreenPossible() && !full && !lecture?.blank}
    <!--
      Клавиша «Во весь экран» 200×44 — В ЛЕВОМ НИЖНЕМ УГЛУ коробки листа, там
      же, где тост: единственное место, куда не ложится ни ладонь, ни перо.
      Была полосой 400 по центру верха — на первой строке слайда, поверх слоя
      ввода, и штрих по заголовку уходил в кнопку; под листом по центру —
      ровно там, откуда начинают штрих с нижнего поля. Просить полный экран
      можно только из жеста, и клавиша — это жест. При затемнении её место
      занимает плита «Зал видит чёрное».
    -->
    <button
      type="button"
      class="{PRESS} absolute bottom-2 left-2 z-10 flex h-11 w-[200px] items-center justify-center gap-2 border border-line bg-surface/[0.88] {CAP} text-accent-text"
      aria-label="Во весь экран"
      onclick={toggleFullscreen}
    >
      Во весь экран <Icon name="chevron-right" size={16} />
    </button>
  {/if}

  <!-- Тост — в левом нижнем углу листа: там, куда не ложится ни ладонь, ни перо; над клавишей «Во весь экран», если она есть. -->
  <div class="absolute left-2 z-10 {fullscreenPossible() && !full && !lecture?.blank ? 'bottom-14' : 'bottom-2'}">
    {@render toast()}
  </div>
{/snippet}

{#snippet peek()}
  <!--
    ПОДГЛЯДКА под листом: первые строки заметки к этой странице и эскиз
    «дальше» справа. ПОКАЗАНИЕ, А НЕ КНОПКА: полоса лежит ровно там, где у
    правши пятка ладони, и пока она была входом в лист заметок, ладонь
    открывала его поверх нижней половины бумаги посреди письма, а штрих,
    начатый с нижнего поля, уходил в кнопку. Под бумагой в приложениях для
    заметок не лежит ничего нажимаемого; вход в заметки — клавиша «Заметки» на
    рейле и N. `pointer-events: none`: касания идут в слой ввода, который
    ладонь игнорирует. Живёт только когда под листом ≥110 px; меньше — голый
    колодец, полоса в две строки читалась бы как обрезанный текст.
  -->
  <div
    class="pointer-events-none absolute inset-x-3 bottom-3 flex gap-3"
    style={`height:${Math.max(0, fitRest - 12)}px`}
    data-pult-notes
    aria-hidden="true"
  >
    <div
      class="flex min-w-0 flex-1 flex-col items-start overflow-hidden px-3 py-2 text-left"
    >
      <span class="flex items-center gap-2">
        <span class="{SECTION} text-muted">заметки</span>
        {#if peekNote.trim()}
          <span class="h-3 w-0.5 shrink-0 bg-accent" aria-hidden="true"></span>
        {/if}
        <span class="font-mono text-code tabular-nums text-muted">
          {preparing ? '' : stopwatch(runningFor)}
        </span>
      </span>
      <span class="mt-1 line-clamp-3 whitespace-pre-line text-prompt-sm text-ink">
        {peekNote.trim() || 'Что сказать на этой странице…'}
      </span>
    </div>
    {#if doc && !onBoard && pages > wanted && !tiny}
      <!-- «Что дальше» — показание, как и номер; не нажимается. -->
      <div class="relative flex w-40 shrink-0 flex-col">
        <span class="relative flex h-[90px] w-40 bg-white">
          <LecturePage {doc} page={wanted + 1} bare />
          <span
            class="pult-veil pointer-events-none absolute inset-0 bg-canvas"
            style={`opacity:${veil}`}
            aria-hidden="true"
          ></span>
        </span>
        <span class="mt-1 flex justify-end font-mono text-code tabular-nums text-faint">
          дальше {wanted + 1}
        </span>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet notesSheet()}
  <!--
    ВЫДВИЖНОЙ ЛИСТ ЗАМЕТОК — снизу, поверх бумаги, на 400 (480 на 12.9").
    Корпус на 0.96: сквозь него чуть виден лист, чтобы не терялось, где ты.
    Верхняя половина бумаги остаётся рабочей: перо там рисует, пока фокус не
    в поле. Секундомер лекции — в шапке, его ведёт сам NotesPad: сюда
    поднимают глаза между фразами, и «сколько прошло» читается тем же
    взглядом.
  -->
  <div
    use:sheetSwipe
    class="animate-pult-slide absolute inset-x-0 bottom-0 z-10 flex flex-col border-t border-line bg-surface/[0.96]"
    style={`height:${notesSheetH}px`}
    data-pult-notes
  >
    <div class="flex min-h-0 flex-1 flex-col">
      <NotesPad
        file={file ?? ''}
        page={wanted}
        folded={false}
        onfold={() => setNotes(false)}
        onmore={() => openPane('more')}
        onedit={(next) => (editing = next)}
      />
    </div>
  </div>
{/snippet}

<!-- ====================================================== выбор документа -->

{#snippet fileList(onpick: (path: string) => void, withNotes: boolean)}
  {#if slides.length === 0}
    <p class="px-1 py-6 text-answer text-muted">
      В комнате нет документов. Загрузите PDF с компьютера — он появится здесь.
    </p>
  {:else}
    <ul>
      {#each slides as entry (entry.path)}
        {@const going = lecture?.file === entry.path}
        <li class="relative flex items-stretch border-b border-line-soft">
          {#if going}
            <!-- Идущая лекция — единственное цветное на этом экране. -->
            <span class="absolute inset-y-0 left-0 w-[4px] bg-accent" aria-hidden="true"></span>
          {/if}
          <!--
            Нажатие по идущей лекции читается как «убедиться, что открыт
            правильный документ». Сервер такое нажатие не выполняет вовсе — но
            молчаливый отказ выглядит как поломка, поэтому строка сама
            говорит, что она уже открыта, и нажимать её незачем.
          -->
          <button
            type="button"
            class="{PRESS} flex h-[88px] min-w-0 flex-1 flex-col justify-center gap-1 px-4 text-left disabled:opacity-60"
            disabled={going}
            onclick={() => onpick(entry.path)}
          >
            <span class="truncate text-head font-semibold text-ink">{entry.name}</span>
            <span class="truncate font-mono text-code text-faint">
              {going ? 'идёт сейчас' : entry.path}
            </span>
          </button>
          {#if withNotes}
            <button
              type="button"
              class="{PRESS} flex h-[88px] w-[88px] shrink-0 items-center justify-center border-l border-line-soft {CAP} text-muted"
              onclick={() => (prep = entry.path)}
            >
              Заметки
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#snippet chooser()}
  <!--
    ЛЕКЦИИ НЕТ. Рейл не рисуется вовсе: пустой рейл выглядит как сломанный
    пульт. Грунт остаётся ночным — сюда приходят из освещённого коридора, и
    пусть глаза адаптируются на настройке, а не на первом слайде.
  -->
  <div class="flex min-h-0 flex-1 justify-center overflow-y-auto px-6 pb-10 pt-12">
    <div class="w-full max-w-[720px]">
      <h2 class="pb-3 {SECTION} text-muted">Выберите документ</h2>
      <div class="border-t border-line-soft">
        {@render fileList(start, true)}
      </div>

      <!--
        Настройки, которых во время лекции быть не должно. Руку выбирают до
        того, как взяли планшет, а не из листа посреди пары.
      -->
      <div class="mt-8 flex items-stretch border-y border-line-soft">
        <button
          type="button"
          class="{PRESS} flex h-16 flex-1 items-center gap-3 px-4 {CAP} text-muted"
          aria-pressed={hand === 'left'}
          onclick={() => setHand(hand === 'left' ? 'right' : 'left')}
        >
          <span class="flex-1 text-left">Левая рука</span>
          <span class={hand === 'left' ? 'text-ink' : 'text-faint'}>
            {hand === 'left' ? 'вкл' : 'выкл'}
          </span>
        </button>
        {#if fullscreenPossible()}
          <button
            type="button"
            class="{PRESS} flex h-16 w-[200px] shrink-0 items-center justify-center border-l border-line-soft {CAP} text-muted"
            aria-pressed={full}
            onclick={toggleFullscreen}
          >
            {full ? 'Выйти из полного' : 'Во весь экран'}
          </button>
        {/if}
      </div>

      <p class="pt-6 {CAP} text-faint">Яркость листа — три ступени под номером страницы. Начните с «зала»</p>

      <div class="pt-6">{@render toast()}</div>
    </div>
  </div>
{/snippet}

<!-- =============================================================== листы -->

{#snippet panes()}
  {#if pane !== null}
    <!--
      Ложе гасит нажатие мимо листа: закрыть можно и им, и Escape. Цвет —
      колодец на 0.72; прежний `bg-ink/28` на тёмной ветке ОСВЕТЛЯЛ экран при
      подъёме листа, потому что `ink` там #E6E7E8.
    -->
    <div class="absolute inset-0 z-30 flex flex-col justify-end">
      <button
        type="button"
        class="absolute inset-0 bg-canvas/[0.72]"
        aria-label="Закрыть"
        onclick={() => openPane(null)}
      ></button>

      <div class="animate-pult-slide relative max-h-full overflow-y-auto border-t border-line bg-surface">
        {#if pane === 'pages'}
          <div class="flex h-10 items-center justify-between px-6">
            <span class="{SECTION} text-muted">Страницы</span>
            <button
              type="button"
              class="{PRESS} h-10 px-2 {CAP} text-muted"
              onclick={() => openPane(null)}
            >
              Отмена
            </button>
          </div>
          <div
            bind:this={strip}
            class="flex items-start gap-2 overflow-x-auto px-6 pb-6"
            onscroll={(event) => scanStrip(event.currentTarget)}
          >
            {#each pageList as index (index)}
              <button
                type="button"
                class="{PRESS} flex shrink-0 flex-col items-center gap-1 border-b-[3px] {index ===
                wanted
                  ? 'border-ink'
                  : 'border-transparent'}"
                onclick={() => {
                  goTo(index)
                  openPane(null)
                }}
              >
                <!-- Подложка эскизов — не белая: двадцать четыре белых
                     прямоугольника полосой это 195 000 px² чистого белого,
                     пока лента открыта. Сами эскизы едут по фейдеру. -->
                <span
                  class="relative flex items-center justify-center bg-line"
                  style={`width:${THUMB_W}px;height:${THUMB_H}px`}
                >
                  {#if index >= stripFrom && index <= stripTo && doc}
                    <canvas use:thumb={index} class="block"></canvas>
                  {/if}
                  <span
                    class="pult-veil pointer-events-none absolute inset-0 bg-canvas"
                    style={`opacity:${veil}`}
                    aria-hidden="true"
                  ></span>
                </span>
                <span
                  class="pb-1 font-mono text-2xs tabular-nums {index === wanted
                    ? 'text-ink'
                    : 'text-faint'}"
                >
                  {index}
                </span>
              </button>
            {/each}

            <!--
              За вырезом — ЗАВЕДЁННЫЕ ЧИСТЫЕ ЛИСТЫ: иначе к исписанному листу
              можно было бы вернуться только нажимая «Назад» нужное число раз.
            -->
            <span class="h-[90px] w-4 shrink-0" aria-hidden="true"></span>
            <span class="h-[90px] w-px shrink-0 bg-line" aria-hidden="true"></span>
            <span class="h-[90px] w-4 shrink-0" aria-hidden="true"></span>

            {#each boardList as index (index)}
              <button
                type="button"
                class="{PRESS} flex shrink-0 flex-col items-center gap-1 border-b-[3px] {-wanted ===
                index
                  ? 'border-ink'
                  : 'border-transparent'}"
                onclick={() => {
                  goTo(-index)
                  openPane(null)
                }}
              >
                <span class="relative block bg-white" style={`width:${THUMB_W}px;height:${THUMB_H}px`}>
                  <svg width={THUMB_W} height={THUMB_H} class="block">
                    {#each boardInk(index) as line, at (at)}
                      <path
                        d={line.d}
                        fill="none"
                        stroke={line.color}
                        stroke-width={line.width}
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    {/each}
                  </svg>
                  <span
                    class="pult-veil pointer-events-none absolute inset-0 bg-canvas"
                    style={`opacity:${veil}`}
                    aria-hidden="true"
                  ></span>
                </span>
                <span
                  class="pb-1 font-mono text-2xs tabular-nums {-wanted === index
                    ? 'text-ink'
                    : 'text-faint'}"
                >
                  Лист {index}
                </span>
              </button>
            {/each}

            {#if mayTurn}
              <button
                type="button"
                class="{PRESS} flex shrink-0 flex-col items-center gap-1 border-b-[3px] border-transparent"
                onclick={() => {
                  newBoard()
                  openPane(null)
                }}
              >
                <span
                  class="flex items-center justify-center border border-line text-muted"
                  style={`width:${THUMB_W}px;height:${THUMB_H}px`}
                >
                  <Icon name="plus" size={24} />
                </span>
                <span class="pb-1 {CAP} text-faint">Новый лист</span>
              </button>
            {/if}
          </div>
        {:else if pane === 'grab'}
          <div class="p-6">
            <p class="text-answer text-ink">
              Перехватить пульт у {lecture?.byName}? Он перестанет управлять проекцией. Страница и
              чернила сохранятся.
            </p>
            <div class="mt-4 flex gap-2">
              <button type="button" class="btn-primary h-12 flex-1" onclick={grab}>
                Перехватить
              </button>
              <button type="button" class="btn-outline h-12 flex-1" onclick={() => openPane(null)}>
                Отмена
              </button>
            </div>
          </div>
        {:else if pane === 'files'}
          <div class="flex h-10 items-center px-6">
            <span class="{SECTION} text-muted">Документ</span>
          </div>
          <!-- Пиксели, а не `vh`: единица высоты окна на iPad живёт своей
               жизнью между панелями Safari и Split View. -->
          <div class="max-h-[360px] overflow-y-auto border-t border-line-soft px-6">
            {@render fileList(start, false)}
          </div>
        {:else if pane === 'more'}
          <!--
            ЛИСТ «ЕЩЁ» — единственный вход ко всему, что делают раз за пару или
            раз в жизни. Здесь же живёт «Закончить лекцию», и живёт ПОСЛЕДНЕЙ
            СТРОКОЙ: красное в тёмном зале — самое громкое, что бывает.
            Глифов в строках нет ни одного: слева имя действия, справа его
            значение.
          -->
          {#if lecture}
            <div class="flex h-12 items-center justify-between px-6">
              <span class="{SECTION} text-muted">лекция идёт</span>
              <span class="font-mono text-gauge tabular-nums text-ink">{stopwatch(runningFor)}</span>
            </div>
          {/if}
          <button type="button" class="{ROW} border-t border-line-soft text-ink" onclick={onexit}>
            В комнату
          </button>
          {#if fullscreenPossible()}
            <button
              type="button"
              class="{ROW} border-t border-line-soft text-ink"
              aria-pressed={full}
              onclick={() => {
                toggleFullscreen()
                openPane(null)
              }}
            >
              <span class="flex-1">Во весь экран</span>
              <span class="{CAP} text-muted">{full ? 'вкл' : 'выкл'}</span>
            </button>
          {/if}
          <button
            type="button"
            class="{ROW} border-t border-line-soft text-ink"
            aria-pressed={hand === 'left'}
            onclick={() => setHand(hand === 'left' ? 'right' : 'left')}
          >
            <span class="flex-1">Левая рука</span>
            <span class="{CAP} text-muted">{hand === 'left' ? 'вкл' : 'выкл'}</span>
          </button>
          {#if leading}
            <button
              type="button"
              class="{ROW} border-t border-line-soft text-ink"
              aria-label="Рисовать пальцем"
              aria-pressed={fingerOn}
              onclick={() => setFinger(!fingerOn)}
            >
              <span class="flex-1">Рисовать пальцем</span>
              <span class="{CAP} text-muted">{fingerOn ? 'вкл' : 'выкл'}</span>
            </button>
          {/if}
          {#if mayTurn}
            <button
              type="button"
              class="{ROW} border-t border-line-soft text-ink"
              onclick={() => {
                if (onBoard) backToSlides()
                else newBoard()
                openPane(null)
              }}
            >
              <span class="flex-1">{onBoard ? 'Вернуться к слайду' : 'Чистый лист'}</span>
              {#if boards > 0 && !onBoard}
                <span class="{CAP} text-muted">заведено {boards}</span>
              {/if}
            </button>
            <button
              type="button"
              class="{ROW} border-t border-line-soft text-ink"
              onclick={() => openPane('files')}
            >
              <span class="shrink-0">Сменить документ…</span>
              <span class="min-w-0 flex-1 truncate text-right font-mono text-code text-faint">
                {file ? baseOf(file) : ''}
              </span>
            </button>
          {/if}
          {#if leading}
            <div class="flex items-center border-t border-line-soft">
              {#if wipeAsked}
                <span class="flex-1 px-6 text-answer text-ink">
                  Стереть чернила с этой страницы?
                </span>
                <button
                  type="button"
                  class="{PRESS} h-16 px-4 {CAP} text-danger"
                  onclick={() => {
                    wipePage()
                    openPane(null)
                  }}
                >
                  Стереть
                </button>
                <button
                  type="button"
                  class="{PRESS} h-16 px-6 {CAP} text-muted"
                  onclick={() => (wipeAsked = false)}
                >
                  Отмена
                </button>
              {:else}
                <button type="button" class="{ROW} text-danger" onclick={() => (wipeAsked = true)}>
                  Стереть страницу
                </button>
              {/if}
            </div>
          {/if}

          <div class="h-px w-full bg-line-soft" aria-hidden="true"></div>
          <div class="px-6 py-4">
            <p class="text-answer text-ink">Экран не гаснет</p>
            <p class="pt-1 text-2xs text-muted">
              {#if wake === 'on'}
                Пока пульт открыт, планшет не заснёт.
              {:else if wake === 'refused'}
                Система отказала — обычно это режим энергосбережения. {AUTOLOCK}
              {:else if !canKeepAwake()}
                Этот браузер не умеет держать экран. {AUTOLOCK}
              {:else}
                {AUTOLOCK}
              {/if}
            </p>
            <p class="pt-3 text-answer text-ink">Ладонь не сворачивает пульт</p>
            <p class="pt-1 text-2xs text-muted">{GUIDED}</p>
          </div>
          <div class="h-px w-full bg-line-soft" aria-hidden="true"></div>

          {#if leading}
            {#if stopAsked}
              <div class="px-6 py-4">
                <p class="text-answer text-ink">
                  Закончить лекцию? Проекция погаснет, чернила сотрутся.
                  <b class="font-semibold">Заметки останутся.</b>
                </p>
                <div class="mt-4 flex gap-2">
                  <!-- Опасное слева, «Отмена» справа — под пальцем той руки,
                       которая держит планшет. -->
                  <button
                    type="button"
                    class="{PRESS} h-12 flex-1 border border-danger/40 {CAP} text-danger"
                    onclick={stop}
                  >
                    Закончить
                  </button>
                  <button type="button" class="btn-outline h-12 flex-1" onclick={() => (stopAsked = false)}>
                    Отмена
                  </button>
                </div>
              </div>
            {:else}
              <button type="button" class="{ROW} text-danger" onclick={() => (stopAsked = true)}>
                Закончить лекцию
              </button>
            {/if}
          {:else if preparing}
            <!-- У подготовки заканчивать нечего: та же последняя строка
                 выводит обратно к выбору документа, и красного здесь нет. -->
            <button
              type="button"
              class="{ROW} text-muted"
              onclick={() => {
                prep = null
                openPane(null)
              }}
            >
              Закончить подготовку
            </button>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

<style>
  /*
   * ВЕСЬ ПУЛЬТ — БЕЗ ВЫДЕЛЕНИЯ И БЕЗ СИСТЕМНЫХ ЖЕСТОВ: `.pult-root`,
   * `.pult-sheet` и поле заметок описаны в `index.css` под `[data-pult]` —
   * признак адреса гарантирует, что запреты не доедут до тетради. Здесь
   * остаётся рейл: по нему листают свайпом, и браузеру его отдавать нельзя.
   */
  .pult-rail {
    touch-action: none;
  }

  /*
   * РАСТУШЁВКА ВОКРУГ ЛИСТА — вместо тени: 1 px кромки цвета `line` и 6 px
   * тени бумаги на колодце. Ступенями, а не градиентом: градиент на IPS
   * в тёмной комнате раскладывается в полосы Маха. #131b31 — единственный
   * голый хекс: это тень бумаги, подобранная к кодовым значениям колодца, а
   * не краска интерфейса; токена «на два шага светлее колодца» в продукте
   * нет, и заводить его ради одного места незачем.
   */
  .pult-halo {
    box-shadow:
      0 0 0 1px rgb(var(--line)),
      0 0 0 7px #131b31;
  }

  /*
   * Пелена фейдера. Непрозрачность, и только она: анимировать можно две вещи
   * бесплатно, и это одна из них. 320 мс — театральные фейдеры не щёлкают.
   */
  .pult-veil {
    transition: opacity 320ms var(--ease-out);
  }

  /*
   * Петля схождения — ЕДИНСТВЕННАЯ на пульте, и она честна: «мы всё ещё
   * ждём». Ползёт scaleX, а не width: ширина — это раскладка.
   */
  .pult-catchup {
    animation: catchup 1.2s var(--ease-out) infinite;
    transform-origin: left center;
  }

  @keyframes catchup {
    from {
      transform: scaleX(0.1);
    }
    to {
      transform: scaleX(1);
    }
  }

  /*
   * Сокращение, а не выключатель: движение уходит, появление остаётся.
   * Нажатие (`scale(0.97)`) остаётся всегда: на экране, который может не
   * измениться вовсе, это единственное доказательство, что касание услышано.
   */
  @media (prefers-reduced-motion: reduce) {
    .pult-catchup {
      animation-duration: 1ms;
    }

    .pult-veil {
      transition-duration: 1ms;
    }
  }
</style>
