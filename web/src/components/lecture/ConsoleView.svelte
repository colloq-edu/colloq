<!--
  ПУЛЬТ — отдельное приложение для планшета в руках преподавателя.

  Не «комната, ужатая до планшета»: вкладок, панели файлов, оракула и терминала
  здесь нет вовсе. У человека, который говорит перед аудиторией, ровно четыре
  вопроса — что сейчас на экране, что дальше, что сказать, сколько прошло, — и
  каждый лишний орган управления это лишняя секунда молчания в аудитории.

  ПУЛЬТ — ПРЕДМЕТ, А НЕ ЭКРАН: тёмный корпус с двумя обработанными кромками и
  одним светящимся окном. Горизонтальных полос chrome нет ни одной. Верхней
  нити, которая жила здесь раньше, больше нет: на ночном грунте это была
  волосяная почти белая линия во всю ширину — второй по яркости предмет после
  листа, — и она ставила стенные часы (смотрят раз в десять минут) в позицию
  первого чтения, а номер страницы (смотрят каждую фразу) — ниже, в рейл.
  Иерархия была перевёрнута. Груз нити разложен: часы и номер — в ПРИБОР слева,
  имя документа — на экран выбора, полный экран, «Закончить», «Сменить
  документ», «Левая рука» и справка про сон экрана — в лист «Ещё», который
  открывается кнопкой «⋯» в шапке ленты заметок.

  ТРИ ПРАВИЛА, ИЗ КОТОРЫХ ВЫВЕДЕНО ОСТАЛЬНОЕ.

  1. Цель мерится инструментом, который на неё жмёт. Палец — 17–20 мм, отсюда
     держащий рейл 104 px и клавиши от 88. Pencil — 1 мм, отсюда пишущий рейл
     88 px и клавиши от 64. Рейлы РАЗНОЙ ширины, и ширина принадлежит руке: при
     «левой руке» 104 едут вместе с рейлом.
  2. Верх рейла — глазу, низ — пальцу. Прибор наверху и почти не нажимается;
     всё, что жмут вслепую посреди фразы, прижато к низу.
  3. Справа — то, что жмёт перо; слева — то, что жмёт большой палец. Отсюда
     «Отменить» на пишущем рейле (ошибка пера, и рука уже над листом) и «Лист»
     на держащем (это навигация, а не инструмент).

  СВЕТ. Единственный источник — лист. Всё остальное живёт на ночном корпусе.
  Пульт НЕ СЛЕДУЕТ ТЕМЕ КОМНАТЫ: тёмный зал — факт о мире, а не настройка, и в
  светлой теме (умолчание ОС у большинства) человек получал бы белую плиту
  1180×820 в руки в тёмной аудитории. Тему одалживаем через `borrowTheme`.

  РЕЖИМА «РУКА» НЕТ. Инструмент — это то, чем становится ПЕРО; палец не рисует
  никогда, если перо на этом экране уже видели (`InkLayer` знает это сам).

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
      wanted = at
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
    drag = 0
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
   * Освободившиеся 75 px ушли в мёртвую зону запястья, которой не хватало.
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
   * одним `stroke()` и альфа не удваивалась на самопересечениях.
   */
  const MARKER = '#ffd60a80'
  const PEN_WIDTH = 0.005
  const MARKER_WIDTH = 0.022

  /** Перо по умолчанию — ЧЁРНОЕ: на рейле оно ближе всех к руке. */
  let tool = $state<'pen' | 'marker' | 'eraser'>('pen')
  let inkColor = $state(INKS[2].color)

  const strokeColor = $derived(tool === 'marker' ? MARKER : inkColor)
  const strokeWidth = $derived(tool === 'marker' ? MARKER_WIDTH : PEN_WIDTH)

  /**
   * Маркер и ластик переключаются туда и обратно — обратно в перо, а не в
   * «руку»: руки здесь нет, и вернуться к письму человек обязан тем же
   * нажатием, каким ушёл.
   */
  function pick(next: 'marker' | 'eraser'): void {
    tool = tool === next ? 'pen' : next
  }

  function penIn(color: string): void {
    tool = 'pen'
    inkColor = color
  }

  /**
   * УКАЗКА: короткое нажатие включает, долгое — пружина.
   *
   * Пружиной она была задумана из хорошего довода: забытая указка — красная
   * точка, гуляющая по проектору всю оставшуюся пару. Но чистая пружина
   * оказалась кнопкой, которая ничего не делает: чтобы точка появилась, надо
   * ДЕРЖАТЬ клавишу на рейле И одновременно вести по листу, а это две руки на
   * планшете и ни одной мыши на ноутбуке. Первое же, что о ней сказали вслух:
   * «нажимается, но указка не работает — просто пустое нажатие».
   *
   * Поэтому оба поведения, и различает их время удержания. Тап (меньше 300 мс)
   * — режим: указка остаётся включённой, пока её не выключат тем же тапом или
   * не возьмут другой инструмент. Удержание — как держат настоящую указку:
   * отпустили клавишу, и погасло.
   *
   * Довод про забытую указку при этом не пропал: пока она включена, клавиша
   * горит плитой на рейле, а на листе живёт красная точка — забыть её труднее,
   * чем режим пера.
   */
  let pointing = $state(false)
  /** Когда нажали клавишу: тап и удержание — разные жесты. */
  let pointFrom = 0
  /** Тап включил указку режимом — тогда подъём клавиши её не гасит. */
  let pointLatched = $state(false)
  const TAP_MS = 300

  const pointingNow = $derived((pointing || pointLatched) && leading && !offline)

  function pointDown(): void {
    if (!leading || offline) return
    // Второй тап по горящей указке — выключить: тем же нажатием, каким включили.
    if (pointLatched) {
      pointLatched = false
      pointing = false
      return
    }
    pointFrom = performance.now()
    pointing = true
  }

  function pointUp(): void {
    if (!pointing) return
    if (performance.now() - pointFrom < TAP_MS) {
      // Это был тап: указка остаётся гореть.
      pointLatched = true
      return
    }
    pointing = false
  }

  function pointOff(): void {
    pointing = false
    pointLatched = false
  }

  /*
   * Указку гасит всё, что отменяет её смысл: обрыв связи (светить некуда),
   * потеря пульта и уход с экрана. Без этого «горит, а не работает» —
   * состояние, из которого не выбраться нажатием.
   */
  $effect(() => {
    const alive = leading && !offline
    untrack(() => {
      if (!alive && (pointing || pointLatched)) pointOff()
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
  let held = false

  function eraserDown(): void {
    held = false
    window.clearTimeout(holdTimer)
    holdTimer = window.setTimeout(() => {
      held = true
      wipePage()
    }, HOLD_MS)
  }

  function eraserUp(): void {
    window.clearTimeout(holdTimer)
    holdTimer = undefined
    if (!held) pick('eraser')
    held = false
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
   * Секундомер, и ПОСЛЕ ЧАСА ОН ТЕРЯЕТ СЕКУНДЫ: «1:02», а не «1:02:15».
   *
   * Семь знаков моноширинного тридцатого кегля — это 126 px, а рейл шириной
   * 104. Резать кегль ради второй половины пары нельзя: часы читают боковым
   * зрением. К тому же через час секунды и не значат ничего — вопрос в этот
   * момент звучит «сколько осталось», а не «сколько прошло».
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
   * стоит в планшете, а «2:36 PM» под секундомером лекции читается вдвое
   * дольше.
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
   * Порог раскладки читается наблюдателем за размером, а не медиа-запросом.
   *
   * На iPadOS окно меняет размер непрерывно (Split View, оконная
   * многозадачность), `orientationchange` приходит раньше, чем раскладка
   * устоится, а «портрет» — это не поворот, а ширина. Наблюдатель отвечает на
   * тот вопрос, который мы на самом деле задаём.
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

  /** Полная раскладка с рейлами. Ниже порога — честная деградация, не вторая схема. */
  const wide = $derived(box.w >= 700 && box.h >= 560)
  /** Slide Over: пульт остаётся живым, но перестаёт быть пультом. */
  const tiny = $derived(box.w > 0 && box.w < 420)

  const HAND_KEY = 'colloq.pult.hand'
  const NOTES_KEY = 'colloq.pult.notes'
  const LAMP_KEY = 'colloq.pult.lamp'

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

  /**
   * Левша: рейлы меняются местами ЦЕЛИКОМ — вместе с шириной и с полосами
   * «включено». Ширина принадлежит руке, а не стороне экрана: под большим
   * пальцем всегда 104, под пером всегда 88.
   */
  let hand = $state<'right' | 'left'>(remembered(HAND_KEY) === 'left' ? 'left' : 'right')

  /**
   * Свёрнута ли лента заметок: выбор человека, а `null` — выбора ещё не было.
   *
   * Три состояния, а не два, потому что умолчание здесь зависит от документа.
   * Тому, у кого к этой колоде не написано ни строчки, лента отнимает 200 px
   * колодца и не даёт взамен ничего; тому, кто вчера расписал двадцать четыре
   * страницы, свёрнутая лента прячет ровно то, ради чего он открыл пульт.
   */
  const NOTES_CHOICE = remembered(NOTES_KEY)
  let foldChoice = $state<'folded' | 'open' | null>(
    NOTES_CHOICE === 'folded' || NOTES_CHOICE === 'open' ? NOTES_CHOICE : null,
  )
  const folded = $derived(
    foldChoice !== null
      ? foldChoice === 'folded'
      : session.notesFile === file && Object.keys(session.notes).length === 0,
  )

  function setHand(next: 'right' | 'left'): void {
    hand = next
    remember(HAND_KEY, next)
  }

  function setFolded(next: boolean): void {
    foldChoice = next ? 'folded' : 'open'
    remember(NOTES_KEY, next ? 'folded' : 'open')
  }

  /* ------------------------------------------------------------- фейдер */

  /**
   * ФЕЙДЕР ЛИСТА — регулятор единственного источника света на этом экране.
   *
   * Лист — единственное светлое пятно пульта, и в тёмной аудитории на второй
   * половине пары он слепит: 928×522 белого в руках, пока зал сидит в темноте.
   * Выходить за этим в системную яркость нельзя — она гасит заодно заметки,
   * которые как раз надо читать, и стоит трёх касаний по шторке.
   *
   * Три детента, а не циклическая кнопка: у фейдера всегда видно текущее
   * положение. Работает пеленой ПОВЕРХ листа и чернил — и не касается ни
   * рейлов, ни ленты заметок, ни проектора вовсе: зал видит свою проекцию
   * такой, какой видел.
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
   * Что поднято снизу. Один лист за раз: два — это уже интерфейс, а не пульт.
   *
   * Объявлено раньше всего, что его читает: пока лист открыт, перо на слайде
   * не рисует, и `canDraw` ниже спрашивает именно отсюда.
   */
  let pane = $state<'pages' | 'more' | 'grab' | 'ink' | 'files' | null>(null)
  /** Подтверждение «стереть страницу» — внутри строки листа «Ещё». */
  let wipeAsked = $state(false)
  /** Подтверждение «закончить лекцию» — там же, последней строкой. */
  let stopAsked = $state(false)

  function openPane(next: typeof pane): void {
    pane = next
    wipeAsked = false
    stopAsked = false
  }

  /* --------------------------------------------------- перо, ладонь, свайп */

  /** Слой чернил держит указатель: идёт штрих, стирание или указка. */
  let busy = $state(false)
  let lastBusyAt = 0
  /** Отменить начатый штрих: второй палец, открытый лист, правка заметки. */
  let suspend = $state(false)
  /** Лист правки заметки открыт — перо на слайде в это время не рисует. */
  let editing = $state(false)
  /** Видели ли перо на ЭТОМ экране: пока нет — палец рисует, а не листает. */
  let penSeen = false

  const sheetOpen = $derived(pane !== null)
  const canDraw = $derived(leading && !failure && !editing && !sheetOpen)
  /** Чем слой чернил занят прямо сейчас. Указка — пружина и бьёт всё остальное. */
  const liveTool = $derived(!canDraw ? 'off' : pointingNow ? 'laser' : tool)

  function onbusy(next: boolean): void {
    busy = next
    if (!next) lastBusyAt = performance.now()
  }

  /**
   * Ладонь, легшая на рейл.
   *
   * Отсечение внутри слоя чернил спасает только сам лист; кнопки — нет.
   * Левша кладёт руку слева сверху, ровно туда, где живёт «Назад». Поэтому
   * на корне пульта стоит перехватчик: пока перо занято или отпущено меньше
   * 600 мс назад, касания до КНОПОК не доходят.
   *
   * 600 мс — эвристика: короче — ладонь успеет нажать «Указку», длиннее —
   * большой палец перестанет работать сразу после того, как дописали слово.
   *
   * Лист исключён нарочно: его касания разбирает слой чернил (указка пальцем),
   * и проглоченный `pointerup` оставил бы указку гореть. `preventDefault` на
   * `pointerdown` НЕ отменяет последующий `click` — его глотаем отдельно; в
   * Safari он приходит как PointerEvent и несёт `pointerType`.
   */
  const PALM_MS = 600

  $effect(() => {
    const node = root
    if (!node) return
    /*
     * Перехватчик помнит УКАЗАТЕЛЬ, а не только момент.
     *
     * Решать про каждое событие отдельно было половиной охраны: `pointerdown`
     * ладони глотался, пока перо занято, а `pointerup` и `click` того же
     * касания проходили, стоило истечь шестистам миллисекундам с подъёма пера.
     * То есть ровно в том случае, ради которого всё написано: ладонь легла на
     * «ЛИСТ», преподаватель дописал строку, поднял перо — и палец, всё ещё
     * лежащий на кнопке, нажимал её на подъёме. Нажатие принадлежит касанию
     * целиком, поэтому проглоченное касание глотается до конца.
     */
    const swallowed = new Set<number>()
    const watch = (event: Event): void => {
      const pointer = event as PointerEvent
      if (!('pointerType' in pointer)) return
      if (pointer.pointerType === 'pen') {
        penSeen = true
        return
      }
      if (pointer.pointerType !== 'touch') return
      if ((event.target as Element | null)?.closest('.pult-sheet')) return
      const id = pointer.pointerId
      const known = swallowed.has(id)
      if (!known && !busy && performance.now() - lastBusyAt >= PALM_MS) return
      if (event.type === 'pointerdown') swallowed.add(id)
      else if (event.type === 'pointerup' || event.type === 'pointercancel') {
        // `click` приходит ПОСЛЕ `pointerup`, поэтому забываем указатель не
        // сразу, а следующей задачей — иначе нажатие проскочит последним.
        setTimeout(() => swallowed.delete(id), 0)
      }
      event.stopPropagation()
      if (event.cancelable) event.preventDefault()
    }
    const names = ['pointerdown', 'pointerup', 'pointercancel', 'click'] as const
    for (const name of names) node.addEventListener(name, watch, true)
    return () => {
      for (const name of names) node.removeEventListener(name, watch, true)
    }
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

  /*
   * Свайп по листу.
   *
   * Одним пальцем — только когда перо уже видели: пока рисует палец, свайп
   * забрал бы у него штрих. Двумя — всегда: это запасной путь для того, у
   * кого Pencil сел посреди пары.
   *
   * Старт дальше 24 px от левой кромки листа: у самой кромки живёт системный
   * «назад» Safari, который не выключается ничем.
   *
   * Одиночного тапа по листу нет вовсе. Планшет лежит на кафедре, его задевают
   * рукавом, а перелистнувшийся слайд посреди фразы видит весь зал.
   */
  const SWIPE_MIN = 64
  const SWIPE_CAP = 56
  const EDGE_GUARD = 24

  let drag = $state(0)
  let sliding = $state(false)
  /** Сколько живёт касание, о конце которого нам не сказали. */
  const STALE_MS = 4000
  const touching = new Map<number, { x: number; y: number; at: number }>()
  let gesture: { id: number; x: number; y: number; live: boolean } | null = null

  function sheetDown(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return
    /*
     * Перо на листе — значит, и рука на нём.
     *
     * Ладонь пишущей руки приходит обычным `touch` и едет вправо вместе с
     * рукой: ровно свайп, ровно те же 64 пикселя. Слайд перелистывался
     * посреди формулы, у всего зала. Та же мера, что и на кнопках: пока перо
     * занято и 600 мс после — палец на листе не значит ничего.
     */
    if (busy || performance.now() - lastBusyAt < PALM_MS) return
    /*
     * Заодно выкидываем фантомы. Касание, начатое на листе и отпущенное над
     * рейлом, не приносит сюда `pointerup` — а один такой призрак в карте
     * значит, что следующий же палец даёт «двое», и перо не рисует до
     * перезагрузки вкладки.
     */
    const now = performance.now()
    for (const [id, seen] of touching) if (now - seen.at > STALE_MS) touching.delete(id)
    touching.set(event.pointerId, { x: event.clientX, y: event.clientY, at: now })
    if (!mayTurn) return
    if (touching.size === 2) {
      // Второй палец отменяет начатый пальцем штрих и берёт листание себе.
      suspend = true
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, live: true }
      sliding = true
      return
    }
    if (touching.size > 2) return
    const edge = (event.target as Element | null)?.closest('.pult-sheet')?.getBoundingClientRect()
    const far = edge === undefined ? true : event.clientX - edge.left > EDGE_GUARD
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, live: penSeen && far }
    sliding = gesture.live
  }

  function sheetMove(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return
    const seen = touching.get(event.pointerId)
    if (seen) {
      seen.x = event.clientX
      seen.y = event.clientY
      seen.at = performance.now()
    }
    if (!gesture || gesture.id !== event.pointerId || !gesture.live) return
    const dx = event.clientX - gesture.x
    const dy = event.clientY - gesture.y
    if (Math.abs(dx) <= Math.abs(dy) * 1.6) return
    // Лист едет за пальцем, но недалеко: это ответ на жест, а не путешествие.
    drag = Math.max(-SWIPE_CAP, Math.min(SWIPE_CAP, dx))
  }

  function sheetUp(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return
    const done = gesture && gesture.id === event.pointerId ? gesture : null
    touching.delete(event.pointerId)
    if (done) {
      const dx = event.clientX - done.x
      const dy = event.clientY - done.y
      gesture = null
      sliding = false
      drag = 0
      if (done.live && Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.6) {
        step(dx < 0 ? 1 : -1)
      }
    }
    if (touching.size === 0) {
      suspend = false
      gesture = null
      sliding = false
      drag = 0
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
   * Живёт в шве между листом и лентой заметок, а не белой плашкой со дна:
   * `bg-ink text-canvas` на тёмной ветке — это светлый чип #E6E7E8,
   * вспыхивающий на шесть секунд в тёмном зале, и вдобавок он накрывал бы
   * речь заметки, которая теперь внизу.
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
   * Про сон экрана говорим ОДИН РАЗ и тостом.
   *
   * Раньше это была постоянная янтарная кнопка в нити — вторая по громкости
   * вещь на ночном пульте ради разового предупреждения о факте про
   * УСТРОЙСТВО, а не про лекцию. Дальше справка живёт текстом в «Ещё».
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
    if (root) void goFullscreen(root)
  }

  function grab(): void {
    if (!lecture) return
    // Тот же `lecture:start` по тому же файлу: на сервере это передача пульта,
    // а не новая лекция — страница, чернила и часы остаются на месте.
    session.send({ t: 'lecture:start', file: lecture.file })
    pane = null
    if (root) void goFullscreen(root)
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
    const at = wanted > 0 ? wanted : pages + (-wanted)
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
   * пересчёт в 160×90 — умножение, а `vector-effect` тут не нужен: масштаба
   * у SVG нет, координаты уже в пикселях плитки.
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
      if (pane !== null) {
        event.preventDefault()
        openPane(null)
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
      // Указка — пружина и на клавиатуре тоже: держат — светит. Автоповтор
      // сюда приходит десятками, и каждый повтор просто подтверждает `true`.
      event.preventDefault()
      pointDown()
    } else if (event.code === 'KeyN') {
      event.preventDefault()
      setFolded(!folded)
    } else if (/^Digit[1-3]$/.test(event.code)) {
      event.preventDefault()
      penIn(INKS[Number(event.code.slice(5)) - 1].color)
    }
  }

  function onkeyup(event: KeyboardEvent): void {
    if (event.code === 'KeyL') pointUp()
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
   * коробок. Под пальцем — `bg-line` (ближайший домашний токен к плите
   * нажатия #1B2540). Включённая — `bg-raised` (ближайший к #16233F) плюс
   * полоса 3 px на ВНУТРЕННЕЙ кромке, см. `mark()`.
   *
   * Шаблон «глиф сверху, слово снизу» здесь не используется: именно он делал
   * пульт таблицей, выдавая каждому органу одинаковую двухстрочную массу.
   */
  const KEY = `relative flex w-full shrink-0 items-center justify-center ${PRESS} enabled:active:bg-line`
  /** Подпись действия: 0.14em называет ДЕЙСТВИЕ. Трекингов на пульте ровно два. */
  const CAP = 'text-2xs font-bold uppercase tracking-label'
  /** Название места: 0.2em называет МЕСТО (полоса, область). */
  const SECTION = 'text-micro font-bold uppercase tracking-section'
  /** Строка поднятого листа. */
  const ROW = `flex h-16 w-full items-center gap-3 px-6 text-left text-answer ${PRESS} enabled:active:bg-line`

  /**
   * Подпись выключенной клавиши.
   *
   * Чертёж просит #47526E — нарочно ниже пола читаемости: это ОТСУТСТВИЕ, а
   * не информация. Голого хекса в разметке не заводим: `faint` (#5E6B85) на
   * 70 % поверх корпуса даёт (69,81,108) — тот же цвет с точностью до
   * кодового значения.
   *
   * Константой — только для варианта БЕЗ приставки. `disabled:text-faint/70`
   * и `bg-faint/70` выписаны в разметке буквами: сборщик Tailwind ищет классы
   * ТЕКСТОМ по исходнику и склеенной строки `disabled:{OFF}` не увидит — из
   * такой записи получается класс, для которого не сгенерировано правило, то
   * есть молча ничего.
   */
  const OFF = 'text-faint/70'
</script>

<svelte:window {onkeydown} {onkeyup} onblur={pointOff} />

<!--
  Отступы под вырезом и домашним индикатором — на корне, одним местом. Ни
  одного `vh`: цепочка `height: 100%` не зависит ни от панелей Safari, ни от
  того, в каком окне сейчас живёт планшет.

  Грунт корня — колодец (`canvas`): середина проваливается, а корпус рейлов
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
  {:else if wide}
    <!--
      Рейлы разной ширины, и ширина принадлежит РУКЕ, а не стороне экрана:
      под большим пальцем всегда 104, под пером всегда 88. При «левой руке»
      меняется порядок колонок, и 104 едут вместе с держащим рейлом.
    -->
    <div class="flex min-h-0 flex-1 {hand === 'left' ? 'flex-row-reverse' : ''}">
      {@render holdRail()}
      {@render middle()}
      <!-- У подготовки пишущего рейла нет вовсе: писать пером накануне
           незачем — чернила живут в лекции, а не в документе. -->
      {#if leading || watching}{@render penRail()}{/if}
    </div>
  {:else}
    <!--
      Узкий пульт: рейлов нет, потому что для двух рук нет места; всё, что
      жали большим пальцем, уезжает в нижнюю полосу, где большой палец и
      лежит. Это названная деградация, а не вторая раскладка.
    -->
    <div class="flex min-h-0 flex-1 flex-col">
      {@render middle()}
      {@render bar()}
    </div>
  {/if}

  {@render panes()}
</div>

<!-- ============================================================== прибор -->

{#snippet fader(cell: string, gap: string, tall: number)}
  <!--
    Три детента, а не циклическая кнопка: у фейдера всегда видно текущее
    положение. Столбики растут 4 / 9 / 14 — положение читается формой, а не
    подписью, и нащупывается на слух руки за один взгляд.
  -->
  <div class="flex {gap}" role="radiogroup" aria-label="Яркость листа">
    {#each LAMPS as level, index (level.name)}
      <button
        type="button"
        role="radio"
        aria-checked={lamp === index}
        aria-label={level.name}
        class="{PRESS} flex {cell} items-end justify-center pb-1.5 {lamp === index
          ? 'bg-raised'
          : ''}"
        onclick={() => setLamp(index)}
      >
        <span
          class="block w-[14px] {lamp === index ? 'bg-ink' : 'bg-faint/70'}"
          style={`height:${Math.round((level.bar * tall) / 36)}px`}
          aria-hidden="true"
        ></span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet gauge()}
  <!--
    ПРИБОР. Не кнопка по своей сути, а ПОКАЗАНИЕ: номер, темп, часы, яркость.
    Плита остаётся нажимаемой (открывает ленту страниц), но на это не
    рассчитывают — лентой листают, когда планшет лежит на кафедре, а не когда
    его держат и говорят. Верх рейла — глазу, низ — пальцу.

    Всё флагуется влево на x = 16, кроме самого номера: у моноцифр боковые
    полуапроши, метрический край стоит правее видимого, и без поправки −2 px
    сорокапиксельное число выглядит сдвинутым вправо относительно всего
    столбца под ним.
  -->
  <div class="relative h-[220px] w-full shrink-0">
    <button
      type="button"
      class="{PRESS} absolute inset-x-0 top-0 h-[150px] enabled:active:bg-line"
      aria-label="Выбрать страницу"
      onclick={() => openPane('pages')}
    >
      {#if behind && lecture}
        <!--
          ЧТО ВИДИТ ЗАЛ, когда проектор отстал. Мелко, сбоку и ПЕРВЫМ — и
          порядок здесь носит смысл, а не украшает: сноска отвечает на вопрос
          «где они», большое число — на вопрос «где я», и первым читают тот,
          которого не видно из-за спины. Само большое число при этом не
          трогается вовсе: оно показывает то, что вы РЕШИЛИ, и обязано стоять
          неподвижно — иначе пульт начинает спорить с собственной кнопкой.

          Появляется только после 600 мс расхождения, вместе с петлёй на
          линейке темпа: на каждом обычном перелистывании эта строчка мигала
          бы по сотне миллисекунд, то есть весь час.
        -->
        <span
          class="absolute right-2.5 top-[26px] flex h-[13px] items-center font-mono text-code tabular-nums text-muted"
        >
          {lecture.page < 0 ? `Л${-lecture.page}` : lecture.page}&nbsp;→
        </span>
      {/if}
      <span
        class="absolute left-[14px] top-4 flex h-10 items-center font-mono text-gauge-lg tabular-nums {watching ||
        preparing
          ? 'text-muted'
          : 'text-ink'}"
      >
        {onBoard ? `Л${-wanted}` : wanted}
      </span>

      {#if !onBoard}
        <!-- Знаменатель отдельной строкой, а не в хвост номеру: иначе он
             ездит при переходе 9 → 10. -->
        <span
          class="absolute left-4 top-[58px] flex h-[13px] items-center font-mono text-code tabular-nums text-faint"
        >
          / {pages || '—'}
        </span>
      {/if}

      {#if onBoard}
        <!-- У чистого листа доли колоды нет, и рисовать пустую линейку значит
             врать. На её месте — имя того, что показано. -->
        <span class="absolute left-4 top-[73px] flex h-[13px] items-center {SECTION} text-muted">
          лист
        </span>
      {:else}
        <!--
          ЛИНЕЙКА ТЕМПА — доля колоды как форма, а не как арифметика: где мы в
          этой пачке. При расхождении с проектором она же становится циановой
          и ползёт петлёй 1.2 с — «мы всё ещё ждём». Это сноска, а не замена
          числа: большое число показывает то, что вы РЕШИЛИ, и обязано стоять
          неподвижно.
        -->
        <span class="absolute left-4 top-[79px] block h-[2px] w-[72px] bg-line" aria-hidden="true">
          <span
            class="block h-full w-full origin-left {behind
              ? 'pult-catchup bg-accent'
              : 'bg-muted transition-transform duration-[160ms] ease-out'}"
            style={behind
              ? undefined
              : `transform:scaleX(${pages > 0 ? Math.min(1, wanted / pages) : 0})`}
          ></span>
        </span>
      {/if}

      {#if preparing}
        <!-- Лекции нет — числу не с чем сходиться, и часов у подготовки тоже
             нет: секундомер от «когда открыл вкладку» врал бы про пару. -->
        <span class="absolute left-4 top-[93px] flex h-8 items-center {SECTION} text-faint">
          подготовка
        </span>
      {:else}
        <span
          class="absolute left-4 top-[93px] flex h-8 items-center font-mono text-gauge tabular-nums text-ink"
        >
          {stopwatch(runningFor)}
        </span>
        <span
          class="absolute left-4 top-[129px] flex h-[13px] items-center font-mono text-code tabular-nums text-muted"
        >
          {wall}
        </span>
      {/if}
    </button>

    <div class="absolute left-4 top-[150px]">
      {@render fader('h-9 w-6', 'gap-1', 36)}
    </div>

    {#if offline}
      <!--
        Второй знак обрыва (первый — красный шов по внутренним кромкам
        рейлов). Ни модального окна, ни блокировки: пульт не сломан, рисовать
        можно, зал видит последнюю доехавшую страницу — и её номер здесь и
        назван, чтобы человек знал, о чём говорит зал.
      -->
      <div class="absolute inset-x-4 top-[186px]" aria-live="polite">
        <span class="block {CAP} text-danger">Нет связи</span>
        <span class="block pt-0.5 font-mono text-code tabular-nums text-muted">
          зал видит {lecture ? Math.abs(lecture.page) : '—'}
        </span>
      </div>
    {/if}
  </div>
{/snippet}

<!-- ============================================================== рейлы -->

{#snippet toast()}
  <!--
    Одна строка на шесть секунд. Полоса 2 px слева называет род: accent —
    сообщение, danger — отказ. Рисуется в ДВУХ домах — в шве под листом и внизу
    экрана выбора документа, — и второй дом не украшение: «Лекция закончена»
    говорится ровно в тот момент, когда лист исчезает и остаётся выбор, и в
    одном только шве этой строки не увидел бы никто.
  -->
  {#if notice}
    <div class="pointer-events-none relative flex h-8 items-center bg-raised px-4" aria-live="polite">
      <span
        class="absolute inset-y-0 left-0 w-[2px] {noticeKind === 'refusal'
          ? 'bg-danger'
          : 'bg-accent'}"
        aria-hidden="true"
      ></span>
      <span class="{CAP} text-ink">{notice}</span>
    </div>
  {/if}
{/snippet}

{#snippet mark(on: boolean, side: 'left' | 'right', amber: boolean)}
  <!--
    Полоса «включено» на ВНУТРЕННЕЙ кромке — той, что смотрит на лист.
    Направление несёт смысл: «вот что перо делает там». При смене на левшу
    переезжает вместе с рейлом. Не анимируется: состояние приходит мгновенно.
  -->
  {#if on}
    <span
      class="absolute inset-y-0 {side === 'left' ? 'left-0' : 'right-0'} w-[3px] {amber
        ? 'bg-warning'
        : 'bg-ink'}"
      aria-hidden="true"
    ></span>
  {/if}
{/snippet}

{#snippet holdRail()}
  {@const inner = hand === 'right' ? 'right' : 'left'}
  <!--
    ДЕРЖАЩИЙ РЕЙЛ, 104 px под большой палец. Разделительных волосков между
    клавишами нет: разделяет корпус — зазор 8 значит «соседи по семейству»,
    вырез 16 значит «граница семейств» и нащупывается краем пальца. Восемь
    светящихся линий на рейле были бы восемью источниками света.

    Внутренняя кромка при обрыве связи краснеет: тонкий красный шов по
    стороне светящегося окна виден боковым зрением и не занимает ни одного
    пикселя раскладки.
  -->
  <div
    class="pult-rail flex w-[104px] shrink-0 flex-col bg-surface {hand === 'left'
      ? 'border-l'
      : 'border-r'} {offline ? 'border-danger/40' : 'border-line'}"
  >
    {@render gauge()}

    <!-- Мёртвая зона: сюда ложится ладонь держащей руки. -->
    <span class="min-h-[72px] flex-1" aria-hidden="true"></span>

    {#if mayTurn}
      <!--
        ЛИСТ остаётся клавишей, хотя чертёж кладёт его в ленту страниц: чистый
        лист заводят посреди фразы («слайд кончился, а вывод формулы — нет»),
        и два нажатия для этого — уже отказ. В ленте он тоже есть, последней
        плиткой, и это чинит дыру с недостижимыми заведёнными листами.
      -->
      <button
        type="button"
        class="{KEY} h-[72px] {onBoard ? 'bg-raised text-ink' : 'text-muted'} {CAP}"
        aria-label={onBoard ? 'Вернуться к слайду' : 'Чистый лист'}
        aria-pressed={onBoard}
        onclick={() => (onBoard ? backToSlides() : newBoard())}
      >
        {@render mark(onBoard, inner, false)}
        {onBoard ? 'Слайд' : 'Лист'}
      </button>
      <span class="h-2 shrink-0" aria-hidden="true"></span>
    {/if}

    {#if preparing}
      <!--
        На месте ЗАТЕМНИТЬ у подготовки — «ВЕСТИ». Единственная залитая
        циановая плита на пульте, и она оправдана тем, что за ней ровно одно
        действие и оно кончает подготовку.
      -->
      <button
        type="button"
        class="{KEY} h-[88px] bg-accent text-accent-ink {CAP}"
        onclick={() => prep && start(prep)}
      >
        Вести
      </button>
      <span class="h-2 shrink-0" aria-hidden="true"></span>
      <!-- Слот указки у подготовки пуст: указывать некому. -->
      <span class="h-[88px] shrink-0" aria-hidden="true"></span>
    {:else if leading}
      <!--
        ЗАТЕМНИТЬ. Состояние света показывает сам свет: у пульта отнимается
        свет, а не добавляется. Янтарь — единственное его место на пульте;
        красного здесь нет, потому что пауза — не отказ.
      -->
      <button
        type="button"
        class="{KEY} h-[88px] {CAP} {lecture?.blank ? 'bg-raised' : ''} {offline
          ? OFF
          : lecture?.blank
            ? 'text-warning'
            : 'text-muted'}"
        aria-label={lecture?.blank ? 'Вернуть проекцию' : 'Затемнить проекцию'}
        aria-pressed={lecture?.blank}
        disabled={offline}
        onclick={() => blank(!lecture?.blank)}
      >
        {@render mark(lecture?.blank === true, inner, true)}
        {lecture?.blank ? 'Затемнено' : 'Затемнить'}
      </button>
      <span class="h-2 shrink-0" aria-hidden="true"></span>
      <!--
        УКАЗКА — пружина: держат пальцем, светит на проекторе, отпустили —
        погасла. Клавиатурная L ведёт себя так же. Забытая указка — красная
        точка, гуляющая по проектору до конца пары.
      -->
      <button
        type="button"
        class="{KEY} h-[88px] {CAP} {pointingNow ? 'bg-raised' : ''} {offline
          ? OFF
          : pointingNow
            ? 'text-ink'
            : 'text-muted'}"
        aria-label="Указка"
        aria-pressed={pointingNow}
        disabled={offline}
        onpointerdown={pointDown}
        onpointerup={pointUp}
        onpointercancel={pointOff}
        onkeydown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') pointDown()
        }}
        onkeyup={pointUp}
        onclick={(event) => {
          /*
           * Нажатие БЕЗ пары pointerdown/pointerup: клавиатура, VoiceOver,
           * автоматическая проверка. Их `click` приходит с detail === 0, и без
           * этой ветки клавиша была бы доступна только пальцу и мыши — то есть
           * недоступна ровно тем, ради кого пишут aria-имена.
           */
          if (event.detail === 0) pointLatched = !pointLatched
        }}
      >
        {@render mark(pointingNow, inner, false)}
        Указка
      </button>
    {/if}
    <!-- Ведёт другой: свет и указка не рисуются вовсе, и пустота на их месте
         и есть сообщение. Место разбирают распорки выше и ниже. -->

    <!-- ВЫРЕЗ 16: граница семейств «свет» и «навигация». -->
    <span class="h-4 shrink-0" aria-hidden="true"></span>

    {#if mayTurn}
      <!-- Только шеврон, без слова: назад листают в восемь раз реже, и работу
           подписи здесь берёт размер цели — 80 против 140 у «Вперёд». -->
      <button
        type="button"
        class="{KEY} h-[80px] text-muted disabled:text-faint/70"
        disabled={onBoard ? -wanted >= boards : wanted <= 1}
        aria-label="Предыдущая страница"
        onclick={() => step(-1)}
      >
        <Icon name="chevron-left" size={24} />
      </button>
      <span class="h-2 shrink-0" aria-hidden="true"></span>
      <!--
        Самая большая вещь на пульте, и это верно: вперёд листают в восемь раз
        чаще, чем назад, и жмут вслепую посреди фразы.
      -->
      <button
        type="button"
        class="{KEY} h-[140px] flex-col gap-1.5 text-ink disabled:text-faint/70"
        disabled={!onBoard && pages > 0 && wanted >= pages}
        aria-label="Следующая страница"
        onclick={() => step(1)}
      >
        <Icon name="chevron-right" size={28} />
        <span class="text-ui font-bold uppercase tracking-label">
          {forwardReturns ? 'К слайду' : 'Вперёд'}
        </span>
        {#if forwardReturns}
          <!-- Иначе переход с последней доски обратно выглядит как сбой. -->
          <span class="font-mono text-code tabular-nums text-faint">{lastSlide}</span>
        {/if}
      </button>
    {:else}
      <span class="min-h-0 flex-1" aria-hidden="true"></span>
      <!-- Чтобы пустота внизу рейла не читалась поломкой. -->
      <span class="flex h-5 shrink-0 items-center justify-center px-1 {SECTION} text-muted">
        <span class="truncate">Ведёт {lecture?.byName}</span>
      </span>
    {/if}

    <!-- Резерв домашнего индикатора: ни одна клавиша сюда не заходит. -->
    <span class="h-5 shrink-0" aria-hidden="true"></span>
  </div>
{/snippet}

{#snippet chip(color: string, marker: boolean)}
  <!--
    ЧИП ПИГМЕНТА — не кружок краски в воздухе, а ОБРАЗЕЦ НА БУМАГЕ: плашка
    52×30 белой бумаги, внутри настоящий штрих настоящей ширины с круглой
    концевой. Перо 5 px = PEN_WIDTH 0.005 × 928, маркер 20 px = 0.022 × 928.

    Три причины разом. Тёмный диск #101a33 на ночном корпусе — это 1.5:1,
    чёрного пера на рейле не было видно вовсе. Чип показывает, ЧЕМ штрих ляжет
    на слайд. И маркер с перьями читаются одной семьёй пигмента, а не
    «инструмент и цвет», — после чего слово «Маркер» перестаёт быть нужным.

    Размера выбранный чип НЕ меняет: рост 22 → 28 читается как «эта краска
    толще», то есть врёт про инструмент. Выбор показывают плита и кромка.
  -->
  <span class="block h-[30px] w-[52px] bg-white" aria-hidden="true">
    <svg width="52" height="30" viewBox="0 0 52 30" class="block">
      {#if marker}
        <line x1="12" y1="15" x2="40" y2="15" stroke={color} stroke-width="20" stroke-linecap="round" />
      {:else}
        <line x1="12" y1="21" x2="40" y2="9" stroke={color} stroke-width="5" stroke-linecap="round" />
      {/if}
    </svg>
  </span>
{/snippet}

{#snippet penRail()}
  {@const inner = hand === 'right' ? 'left' : 'right'}
  <!--
    ПИШУЩИЙ РЕЙЛ, 88 px под перо. Ни одного слова: пигмент показывают, а не
    называют. Верхние 348 px — мёртвая зона запястья пишущей руки, почти
    половина рейла; раньше её было 88, и это была причина ложных нажатий
    посреди штриха.
  -->
  <div
    class="pult-rail flex w-[88px] shrink-0 flex-col bg-surface {hand === 'left'
      ? 'border-r'
      : 'border-l'} {offline ? 'border-danger/40' : 'border-line'}"
  >
    <span class="min-h-0 flex-1" aria-hidden="true"></span>

    {#if leading}
      <!--
        ОТМЕНИТЬ приехало сюда с держащего рейла, и это главный переезд:
        плохой штрих делает ПЕРО, и рука, которая его сделала, уже в воздухе
        над листом. Тянуться через весь лист или снимать с хвата большой палец
        — оба варианта неправильные. «Отменить» и «стереть» — одно семейство
        «вернуть назад», и стоять они должны вместе.
      -->
      <button
        type="button"
        class="{KEY} h-16 text-muted"
        onclick={undoStroke}
        aria-label="Отменить последний штрих"
      >
        <Icon name="undo" size={24} />
      </button>
      <span class="h-2 shrink-0" aria-hidden="true"></span>
      <!--
        Ластик стирает ШТРИХАМИ, а не пикселями: в проводе есть только «убрать
        штрих по имени», и пиксельное стирание потребовало бы нового формата и
        переписывания всей истории лекции. Удержание полсекунды стирает
        страницу целиком.
      -->
      <button
        type="button"
        class="{KEY} h-16 {tool === 'eraser' ? 'bg-raised text-ink' : 'text-muted'}"
        aria-label="Ластик"
        aria-pressed={tool === 'eraser'}
        onpointerdown={eraserDown}
        onpointerup={eraserUp}
        onpointerleave={() => window.clearTimeout(holdTimer)}
        onpointercancel={() => window.clearTimeout(holdTimer)}
        onclick={(event) => {
          // С клавиатуры `click` приходит с detail === 0 и без пары
          // pointerdown/pointerup — иначе кнопка была бы недоступна без пальца.
          if (event.detail === 0) pick('eraser')
        }}
      >
        {@render mark(tool === 'eraser', inner, false)}
        <Icon name="eraser" size={24} />
      </button>

      <!-- ВЫРЕЗ 16: граница «вернуть назад» и «пигмент». Волоска здесь нет. -->
      <span class="h-4 shrink-0" aria-hidden="true"></span>

      <button
        type="button"
        class="{KEY} h-[75px] {tool === 'marker' ? 'bg-raised' : ''}"
        aria-label="Маркер"
        aria-pressed={tool === 'marker'}
        onclick={() => pick('marker')}
      >
        {@render mark(tool === 'marker', inner, false)}
        {@render chip(MARKER, true)}
      </button>
      {#each INKS as choice (choice.color)}
        {@const on = tool === 'pen' && inkColor === choice.color}
        <!-- Волосок только между чипами одного семейства — самый тихий из
             трёх весов линий на пульте. -->
        <span class="h-px w-full shrink-0 bg-line-soft" aria-hidden="true"></span>
        <button
          type="button"
          class="{KEY} h-[75px] {on ? 'bg-raised' : ''}"
          aria-label={choice.name}
          aria-pressed={on}
          onclick={() => penIn(choice.color)}
        >
          {@render mark(on, inner, false)}
          {@render chip(choice.color, false)}
        </button>
      {/each}
    {:else if watching}
      <!--
        Ведёт другой. Единственная клавиша рейла, прижатая к низу: контур без
        заливки — залитая циановая плита горела бы все сорок минут чужой
        лекции ради одного нажатия.
      -->
      <button
        type="button"
        class="{PRESS} mx-auto mb-0 flex h-[172px] w-[88px] shrink-0 items-center justify-center border border-accent px-2 text-center {CAP} text-accent-text active:bg-line"
        onclick={() => openPane('grab')}
      >
        Взять пульт
      </button>
    {/if}

    <span class="h-5 shrink-0" aria-hidden="true"></span>
  </div>
{/snippet}

<!-- ============================================================== середина -->

{#snippet sheetOver(size: { w: number; h: number })}
  <!--
    Всё, что лежит НА листе, — одним местом и в порядке отрисовки.

    1. Пелена затемнения. Чертёж просит увести полотно страницы на opacity
       0.28, оставив чернила на 1.0: рисунок готовят под затемнением и
       снимают паузу уже с ним. Полотно рисует LecturePage, и снаружи его
       непрозрачность не достать — зато пелена цвета колодца на 0.72 ПОД
       слоем чернил даёт ровно тот же кадр.
    2. Чернила.
    3. Пелена фейдера — поверх листа И чернил, но ни на рейлы, ни на ленту
       заметок она не заходит: пелена живёт внутри листа.
    4. Растушёвка — ступенями, наружу.
    5. Плита «зал видит чёрное» и цель во весь лист.
  -->
  {#if lecture?.blank}
    <span class="pointer-events-none absolute inset-0 bg-canvas opacity-[0.72]" aria-hidden="true"
    ></span>
  {/if}

  <InkLayer
    page={wanted}
    live={canDraw}
    tool={liveTool}
    color={strokeColor}
    width={strokeWidth}
    w={size.w}
    h={size.h}
    {onbusy}
    suspend={suspend || editing || sheetOpen}
  />

  <!--
    Мгновенный скачок яркости на треть — событие вспышечной адаптации;
    театральные фейдеры не щёлкают. 320 мс, и туда, и обратно.

    `data-pult-veil` — метка для проверки интерфейса, и она здесь не украшение:
    поверх листа лежат ДВЕ пелены цвета колодца, и вторая, затемнение на 0.72,
    темнее любой ступени фейдера. Не назвав нужную, проверка мерила бы самую
    тёмную и на затемнённом слайде объявляла бы фейдер сломанным. Метка стоит
    ровно на одной пелене — на той, которой управляет фейдер.
  -->
  <span
    class="pult-veil pointer-events-none absolute inset-0 bg-canvas"
    style={`opacity:${veil}`}
    data-pult-veil
    aria-hidden="true"
  ></span>

  <!-- В узкой раскладке растушёвка сжимается до 12 px (2/5/5): двадцать
       четыре просто не помещаются в поля 22/26. -->
  <span
    class="{wide ? 'pult-halo' : 'pult-halo-tight'} pointer-events-none absolute inset-0"
    aria-hidden="true"
  ></span>

  {#if lecture?.blank}
    <!--
      Цель — ВЕСЬ лист, а не полоска: это цель, в которую попадают не глядя.
      Прежняя белая полоса 1004×44 и полная инверсия «паузы» были двумя самыми
      яркими объектами ночного пульта, и оба стояли рядом с пальцем.
    -->
    <button
      type="button"
      class="absolute inset-0 flex items-center justify-center"
      onclick={() => blank(false)}
      disabled={!leading || offline}
    >
      <span
        class="flex h-[56px] w-[320px] flex-col items-center justify-center gap-1 border border-line bg-surface/[0.88]"
      >
        <span class="{CAP} text-warning">Зал видит чёрное</span>
        <span class="{SECTION} text-muted">Нажмите, чтобы вернуть</span>
      </span>
    </button>
  {/if}
{/snippet}

{#snippet middle()}
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <!--
      ПОЛЕ ЛИСТА. Поля вокруг (30 сбоку, 30 сверху, 32 снизу) выбраны так,
      чтобы 24 px растушёвки помещались со всех сторон, а нижние 32 остались
      швом, в котором живёт тост.

      Роль стоит ради проверки доступности, и она честная: свайп по листу —
      это удобство для пальца, а не единственный путь. Всё, что он делает,
      делают и клавиши рейла, и стрелки на клавиатуре.
    -->
    <!--
      Высота поля ПОСТОЯННА, а не «сколько осталось».
      
      Была `flex-1`, и сворачивание ленты растило лист на двести пикселей:
      LecturePage пересчитывал вписывание, холст переразмеривался, а вместе с
      ним ехали чернила, растушёвка и пелена — от нажатия на шеврон, который к
      листу отношения не имеет. Освободившееся место остаётся голым колодцем
      ниже (распорка под этим блоком): пустота дешевле движения.
    -->
    <div
      class="pult-sheet relative flex min-h-0 min-w-0 shrink-0 {wide
        ? 'h-[584px] px-[30px] pb-8 pt-[30px]'
        : 'h-[376px] px-[22px] pb-[26px] pt-[26px]'}"
      role="group"
      aria-label="Страница лекции"
      onpointerdown={sheetDown}
      onpointermove={sheetMove}
      onpointerup={sheetUp}
      onpointercancel={sheetUp}
    >
      {#if failure}
        <!--
          Не открылся ВАШ экземпляр — истёк токен, лопнула сеть, битый кэш, — а
          у проектора документ, скорее всего, открыт. Поэтому рейлы, часы,
          номер и заметки продолжают работать: отнимать управление из-за
          собственной неудачи — худшее, что пульт может сделать. На месте
          листа не светится НИЧЕГО: пустое место честно говорит, что
          показывать нечем.
        -->
        <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
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
        <div
          class="flex min-h-0 min-w-0 flex-1"
          style={`transform:translateX(${drag}px);transition:${sliding ? 'none' : 'transform 100ms var(--ease-out)'}`}
        >
          <LecturePage {doc} page={wanted} bare>
            {#snippet over(size)}
              {@render sheetOver(size)}
            {/snippet}
          </LecturePage>
        </div>
      {/if}

      <!--
        ТОСТ живёт в шве между листом и лентой — ровно в тех свободных
        пикселях, которые оставлены под растушёвку и ниже неё.
      -->
      <div class="absolute bottom-0 {wide ? 'left-[30px]' : 'left-[22px]'}">
        {@render toast()}
      </div>
    </div>

    {#if file !== null}
      <!--
        ЛЕНТА ЗАМЕТОК живёт ПОД листом, во всю его ширину, а не колонкой сбоку:
        колонка в 300 px даёт 35 знаков в строке и превращает речь в столбик
        обрывков, полоса в 658 — настоящий абзац, который читается одним
        взглядом.

        Рисуется во ВСЕХ состояниях, где пульт вообще что-то показывает, — в
        том числе когда ведёт другой и когда документ не открылся: её шапка
        несёт «⋯», а «⋯» — единственный вход в «Ещё», то есть в «В комнату»,
        «Во весь экран» и «Закончить лекцию». Свёрнутая лента шапку сохраняет.

        Свёрнутая — 36 px, и ЛИСТ ПРИ ЭТОМ НЕ ДВИГАЕТСЯ И НЕ МЕНЯЕТ РАЗМЕРА:
        освободившиеся 200 px остаются голым колодцем. Движение листа стоит
        дороже пустоты. Заметки видит только хост — NotesPad проверяет это сам.

        Шов сверху рисует ЭТА коробка, и только она: справа от ленты стоит ещё
        и колонка «дальше», а волосок обязан идти через обе. При обрыве связи
        он не краснеет — знаков обрыва ровно два, и оба названы (внутренние
        кромки рейлов и две строки в приборе). Третья красная линия во всю
        ширину окна — это уже заливка тревогой той поверхности, на которой
        человек в этот момент читает свою следующую фразу.
      -->
      <!-- Голый колодец: сюда уходит место, освобождённое свёрнутой лентой. -->
      <div class="min-h-0 flex-1" aria-hidden="true"></div>

      <!--
        В УЗКОМ ДОМЕ ЛЕНТА НЕ СВОРАЧИВАЕТСЯ НАСИЛЬНО.
        
        Раньше она была свёрнута всегда, а шеврон родитель не передавал — то
        есть в Split View заметок не было вовсе и развернуть их было нечем.
        Это ровно наоборот: рядом с пультом в такой раскладке лежит конспект
        или чат, лист мелкий, и главным содержимым экрана становится как раз
        то, что надо СКАЗАТЬ. Сворачивать вручную можно и здесь — тем же
        шевроном.
      -->
      <div class="flex shrink-0 border-t border-line {folded ? 'h-9' : wide ? 'h-[236px]' : 'h-[284px]'}">
        <NotesPad
          {file}
          page={wanted}
          compact={!wide}
          {folded}
          onfold={setFolded}
          onmore={() => openPane('more')}
          onedit={(next) => (editing = next)}
        />
        {#if wide && !folded && doc && !onBoard && pages > wanted}
          <!--
            «Что дальше» — второй из четырёх вопросов говорящего, и ответ на
            него обязан стоять рядом с третьим («что сказать»).

            НЕ НАЖИМАЕТСЯ. 249 px кнопки, листающей страницу, стояли ровно
            там, куда ложится основание ладони пишущей руки при письме в
            нижней части листа. Эскиз — показание, как и номер; листает
            качалка.
          -->
          <div class="relative flex w-[276px] shrink-0 flex-col border-l border-line">
            <span class="flex h-8 shrink-0 items-center pl-[22px] {SECTION} text-muted">дальше</span>
            <span class="relative ml-[22px] flex h-[126px] w-[224px] bg-white">
              <LecturePage {doc} page={wanted + 1} bare />
              <!-- Эскиз едет по фейдеру вместе с листом: он такая же бумага. -->
              <span
                class="pult-veil pointer-events-none absolute inset-0 bg-canvas"
                style={`opacity:${veil}`}
                aria-hidden="true"
              ></span>
            </span>
            <span
              class="mt-2 flex h-[13px] items-center justify-end pr-[30px] font-mono text-code tabular-nums text-faint"
            >
              {wanted + 1}
            </span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<!-- ====================================================== нижняя полоса -->

{#snippet bar()}
  <!--
    УЗКАЯ РАСКЛАДКА. Честная деградация той же логикой: рейлов нет, потому что
    для двух рук нет места; всё, что жали большим пальцем, уезжает вниз, где
    большой палец и лежит. 84 px, а не 76: на ночном пульте цель нащупывают, а
    не видят.

    «Указка» уходит совсем — она стала пружиной и живёт удержанием пальца на
    листе. «Отменить» — в листе «Перо». Всё остальное — в «Ещё».
  -->
  <div class="pult-bar flex h-[84px] shrink-0 items-stretch border-t border-line bg-surface">
    <button
      type="button"
      class="{PRESS} relative flex w-[104px] shrink-0 flex-col items-center justify-center gap-0.5 active:bg-line"
      aria-label="Выбрать страницу"
      onclick={() => openPane('pages')}
    >
      <span class="font-mono text-gauge tabular-nums text-ink">
        {onBoard ? `Л${-wanted}` : wanted}
      </span>
      {#if !onBoard}
        <span class="font-mono text-2xs tabular-nums text-faint">/ {pages || '—'}</span>
        <span class="mt-0.5 block h-[2px] w-[56px] bg-line" aria-hidden="true">
          <span
            class="block h-full w-full origin-left {behind
              ? 'pult-catchup bg-accent'
              : 'bg-muted transition-transform duration-[160ms] ease-out'}"
            style={behind
              ? undefined
              : `transform:scaleX(${pages > 0 ? Math.min(1, wanted / pages) : 0})`}
          ></span>
        </span>
      {/if}
    </button>
    <button
      type="button"
      class="{PRESS} flex w-[72px] shrink-0 items-center justify-center text-muted active:bg-line disabled:text-faint/70"
      disabled={!mayTurn || (onBoard ? -wanted >= boards : wanted <= 1)}
      aria-label="Предыдущая страница"
      onclick={() => step(-1)}
    >
      <Icon name="chevron-left" size={24} />
    </button>
    <button
      type="button"
      class="{PRESS} flex min-w-[100px] flex-1 items-center justify-center gap-2 text-ink active:bg-line disabled:text-faint/70"
      disabled={!mayTurn || (!onBoard && pages > 0 && wanted >= pages)}
      aria-label="Следующая страница"
      onclick={() => step(1)}
    >
      <Icon name="chevron-right" size={28} />
      <span class="text-ui font-bold uppercase tracking-label">
        {forwardReturns ? 'К слайду' : 'Вперёд'}
      </span>
    </button>
    {#if leading}
      <button
        type="button"
        class="{PRESS} flex w-[72px] shrink-0 items-center justify-center active:bg-line"
        aria-label="Перо и цвет"
        onclick={() => openPane('ink')}
      >
        {@render chip(tool === 'marker' ? MARKER : inkColor, tool === 'marker')}
      </button>
      {#if !tiny}
        <button
          type="button"
          class="{PRESS} flex w-[72px] shrink-0 items-center justify-center {tool === 'eraser'
            ? 'bg-raised text-ink'
            : 'text-muted'} active:bg-line"
          aria-label="Ластик"
          aria-pressed={tool === 'eraser'}
          onclick={() => pick('eraser')}
        >
          <Icon name="eraser" size={24} />
        </button>
      {/if}
    {/if}
    {#if !tiny}
      <!-- Фейдер едет сюда, а не в «Ещё»: за яркостью тянутся посреди фразы,
           и два нажатия для этого — уже отказ. -->
      <div class="flex w-[56px] shrink-0 items-center justify-center">
        {@render fader('h-7 w-4', 'gap-0.5', 28)}
      </div>
    {/if}
    {#if leading}
      <button
        type="button"
        class="{PRESS} flex w-[72px] shrink-0 items-center justify-center px-1 text-center {CAP} {lecture?.blank
          ? 'bg-raised'
          : ''} {offline ? OFF : lecture?.blank ? 'text-warning' : 'text-muted'} active:bg-line"
        aria-label={lecture?.blank ? 'Вернуть проекцию' : 'Затемнить проекцию'}
        aria-pressed={lecture?.blank}
        disabled={offline}
        onclick={() => blank(!lecture?.blank)}
      >
        {lecture?.blank ? 'Затемнено' : 'Затемнить'}
      </button>
    {:else if preparing}
      <!--
        «Вести» живёт на держащем рейле, а рейлов здесь нет. Без этой клавиши
        подготовка в Split View была бы ловушкой: документ выбран, заметки
        пишутся, а начать лекцию нечем.
      -->
      <button
        type="button"
        class="{PRESS} flex w-[88px] shrink-0 items-center justify-center bg-accent {CAP} text-accent-ink"
        onclick={() => prep && start(prep)}
      >
        Вести
      </button>
    {/if}
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
    ЛЕКЦИИ НЕТ. Рейлы не рисуются вовсе: пустой рейл выглядит как сломанный
    пульт. Грунт остаётся ночным — сюда приходят из освещённого коридора, и
    пусть глаза адаптируются на настройке, а не на первом слайде.

    Никакого крупного набора: числу здесь нечего показывать, и ступень
    прибора просто молчит. Нажатие по строке начинает лекцию И просит полный
    экран одним живым жестом.
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

      <!-- Фейдер надо один раз показать, и это единственное место, где на это
           есть время. -->
      <p class="pt-6 {CAP} text-faint">
        Яркость листа — три ступени в левом рейле. Начните с «зала»
      </p>

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

      <div class="pult-slide relative max-h-full overflow-y-auto border-t border-line bg-surface">
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
              За вырезом — ЗАВЕДЁННЫЕ ЧИСТЫЕ ЛИСТЫ. Это чинит дыру: раньше в
              ленте были только 1…pages, и к исписанному чистому листу можно
              было вернуться единственным способом — нажать «Назад» нужное
              число раз.
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
                <span
                  class="relative block bg-white"
                  style={`width:${THUMB_W}px;height:${THUMB_H}px`}
                >
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
        {:else if pane === 'ink'}
          <!-- Лист «Перо» узкой раскладки: пигмент, ластик и «отменить», -->
          <!-- которому в полосе места нет. -->
          <div class="flex h-10 items-center px-6">
            <span class="{SECTION} text-muted">Перо</span>
          </div>
          <div class="flex items-stretch border-t border-line-soft">
            <button
              type="button"
              class="{PRESS} flex h-[76px] flex-1 items-center justify-center {tool === 'marker'
                ? 'bg-raised'
                : ''}"
              aria-label="Маркер"
              aria-pressed={tool === 'marker'}
              onclick={() => {
                pick('marker')
                openPane(null)
              }}
            >
              {@render chip(MARKER, true)}
            </button>
            {#each INKS as choice (choice.color)}
              {@const on = tool === 'pen' && inkColor === choice.color}
              <button
                type="button"
                class="{PRESS} flex h-[76px] flex-1 items-center justify-center border-l border-line-soft {on
                  ? 'bg-raised'
                  : ''}"
                aria-label={choice.name}
                aria-pressed={on}
                onclick={() => {
                  penIn(choice.color)
                  openPane(null)
                }}
              >
                {@render chip(choice.color, false)}
              </button>
            {/each}
          </div>
          <button
            type="button"
            class="{ROW} border-t border-line-soft text-ink"
            aria-label="Отменить последний штрих"
            onclick={() => {
              undoStroke()
              openPane(null)
            }}
          >
            <Icon name="undo" size={18} class="text-muted" />
            Отменить штрих
          </button>
          <button
            type="button"
            class="{ROW} border-t border-line-soft text-ink"
            aria-pressed={tool === 'eraser'}
            onclick={() => {
              pick('eraser')
              openPane(null)
            }}
          >
            <Icon name="eraser" size={18} class="text-muted" />
            <span class="flex-1">Ластик</span>
            {#if tool === 'eraser'}<span class="{CAP} text-muted">вкл</span>{/if}
          </button>
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
               жизнью между панелями Safari и Split View, а лист и без того
               ограничен сверху высотой пульта. -->
          <div class="max-h-[360px] overflow-y-auto border-t border-line-soft px-6">
            {@render fileList(start, false)}
          </div>
        {:else if pane === 'more'}
          <!--
            ЛИСТ «ЕЩЁ» — единственный вход ко всему, что делают раз за пару или
            раз в жизни. Здесь же живёт «Закончить лекцию», и живёт ПОСЛЕДНЕЙ
            СТРОКОЙ: красное в тёмном зале — самое громкое, что бывает, и
            висеть рядом с пальцем весь час ради одного нажатия оно не должно.
          -->
          <!--
            Глифов в строках нет ни одного, и это то же решение, что и на
            рейлах: список из восьми одинаковых значков — двенадцать коробок,
            а не восемь действий. Слева имя действия, справа его значение.
          -->
          <button type="button" class="{ROW} text-ink" onclick={onexit}>В комнату</button>
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
          {#if mayTurn}
            <!--
              «Чистый лист» дублем: в узкой раскладке клавиши ЛИСТ нет вовсе,
              а лист заводят посреди фразы.
            -->
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
            <!--
              У подготовки заканчивать нечего: та же последняя строка выводит
              обратно к выбору документа, и красного здесь нет — ничего не
              разрушается.
            -->
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
   * Лупа и меню «скопировать» по долгому нажатию, серая вспышка по касанию и
   * зум по двойному тапу — три системных жеста, которые на пульте не значат
   * ничего, а стоят посреди лекции дорого. Первые два отменяются только
   * вебкитовскими свойствами; третий — `touch-action` на полосах, потому что
   * листают быстрыми повторными нажатиями, а это и есть двойной тап.
   *
   * Правила живут здесь, а не в `index.css`: за пределами пульта они вредны —
   * в тетради текст выделяют осмысленно, а по документу в читалке щипком
   * ведут.
   */
  .pult-root {
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }

  .pult-rail,
  .pult-bar {
    touch-action: manipulation;
  }

  /*
   * РАСТУШЁВКА ВОКРУГ ЛИСТА — вместо тени.
   *
   * Тень `shadow-pop` цвета #0F2D69 на ночном грунте не рисовала ничего и
   * стоила полной перерисовки каждого кадра. Здесь вместо неё четыре КОЛЬЦА с
   * нулевым размытием: бумага → 1 px кромки → 2 px → 10 px → 12 px → колодец.
   *
   * ИМЕННО СТУПЕНЯМИ, А НЕ ГРАДИЕНТОМ. Между двумя последними ступенями
   * три-шесть кодовых значений на канал; градиент, растянутый на 24 px,
   * разложит их в полосы Маха каждые пять пикселей, и на IPS-панели iPad в
   * тёмной комнате это видно невооружённым глазом — вокруг листа появляется
   * концентрическая рябь, которой нет в разметке.
   *
   * Голые хексы здесь — сознательное исключение, названное в задании: это
   * растушёвка бумаги, а не краска интерфейса, и её ступени подобраны к
   * конкретным кодовым значениям колодца. Токена, который значил бы «на два
   * шага светлее колодца», в продукте нет и заводить его ради одного места
   * незачем.
   *
   * Свечения (glow) нет: свечение в этом продукте означает состояние, а лист —
   * не состояние.
   */
  .pult-halo {
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.1),
      0 0 0 3px #2a3654,
      0 0 0 13px #131b31,
      0 0 0 25px #0e1526;
  }

  .pult-halo-tight {
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.1),
      0 0 0 3px #2a3654,
      0 0 0 8px #131b31,
      0 0 0 13px #0e1526;
  }

  /*
   * Пелена фейдера. Непрозрачность, и только она: анимировать можно две вещи
   * бесплатно, и это одна из них. 320 мс — театральные фейдеры не щёлкают.
   */
  .pult-veil {
    transition: opacity 320ms var(--ease-out);
  }

  .pult-slide {
    animation: slide-in 220ms var(--ease-drawer) both;
  }

  @keyframes slide-in {
    from {
      transform: translateY(100%);
    }
    to {
      transform: none;
    }
  }

  /*
   * Петля схождения — ЕДИНСТВЕННАЯ на пульте, и она честна: «мы всё ещё
   * ждём». Живёт на линейке темпа, которая и так есть, а не заводит второй
   * объект под числом. Ползёт scaleX, а не width: ширина — это раскладка.
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
   * Сокращение, а не выключатель: движение уходит, появление остаётся. Панель,
   * возникшая без всякого перехода, всё равно честнее панели, которая
   * приехала мимо человека, попросившего не двигать экран. Нажатие
   * (`scale(0.97)`) остаётся всегда: на экране, который может не измениться
   * вовсе, это единственное доказательство, что касание услышано.
   */
  @media (prefers-reduced-motion: reduce) {
    .pult-slide,
    .pult-catchup {
      animation-duration: 1ms;
    }

    .pult-veil {
      transition-duration: 1ms;
    }
  }
</style>
