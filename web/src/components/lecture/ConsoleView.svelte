<!--
  ПУЛЬТ — отдельное приложение для планшета в руках преподавателя.

  Не «комната, ужатая до планшета»: вкладок, панели файлов, оракула и терминала
  здесь нет вовсе. У человека, который говорит перед аудиторией, ровно четыре
  вопроса — что сейчас на экране, что дальше, что сказать, сколько прошло, — и
  каждый лишний орган управления это лишняя секунда молчания в аудитории.

  ПЛАНИРОВКА. Две ручки: рейлы по краям, лист посередине, лента заметок под
  ним. Всё нажимаемое прижато к НИЖНЕЙ части рейлов, потому что планшет держат
  двумя руками и большие пальцы лежат внизу — и в ландшафте, и в портрете.
  Верх рейлов — мёртвая зона: там проходит запястье пишущей руки, и кнопка,
  поставленная туда, нажималась бы ладонью посреди штриха.

  РЕЖИМА «РУКА» НЕТ. Инструмент — это то, чем становится ПЕРО; палец не рисует
  никогда, если перо на этом экране уже видели (`InkLayer` знает это сам).
  Переключаться в «руку», чтобы перелистнуть, значит делать два нажатия там,
  где хватает движения пальцем по листу.

  ПУЛЬТ НЕ ЖДЁТ СЕРВЕР. Страницу листает у себя мгновенно и показывает
  расхождение с проектором вслух («7 → 8»), а не прячет: преподаватель,
  говорящий про восьмой слайд над седьмым, — самый дорогой отказ этого
  продукта.
-->
<script lang="ts">
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import { untrack } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { fullscreenNow, fullscreenPossible, goFullscreen, leaveFullscreen } from '@/lib/fullscreen'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { theme } from '@/lib/theme.svelte'
  import { canKeepAwake, keepAwake, type WakeState } from '@/lib/wakelock'
  import { baseOf } from '@shared/paths'
  import InkLayer from './InkLayer.svelte'
  import LecturePage from './LecturePage.svelte'
  import NotesPad from './NotesPad.svelte'

  interface Props {
    /**
     * Выйти в комнату. Лекцию НЕ останавливает: уйти с пульта и закончить
     * лекцию — разные решения, и второе стоит отдельной кнопки с
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
   * 600 мс — после них расхождение показываем плитой. 1200 мс — после них
   * сдаёмся и следуем за проектором: значит, либо листает кто-то другой, либо
   * наше сообщение потерялось, и врать про восьмую страницу над седьмой
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
     * догонять нечего: у него нет своей страницы, есть только серверная, — и
     * ожидание в секунду показывало бы ему «7 → 8» с обещанием, что восьмую
     * хотел он. Хотел её другой человек, а этот на неё смотрит.
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
    const top = pages > 0 ? pages : next
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
   * возвращаются той же лентой, что и к слайду.
   */
  let boards = $state(0)
  /** Куда вернуться со стола: последний слайд, на котором были. */
  let lastSlide = 1

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
    const next = wanted + dir
    if (next === 0) {
      backToSlides()
      return
    }
    if (next < 0 && -next > boards) return
    goTo(next)
  }

  function blank(on: boolean): void {
    if (!leading || offline) return
    session.send({ t: 'lecture:blank', on })
  }

  /* ------------------------------------------------------------ инструмент */

  type Tool = 'pen' | 'marker' | 'eraser' | 'laser' | 'off'

  /** Четыре цвета: все читаются и на белом слайде, и на проекторе в зале. */
  const INKS = [
    { color: '#d4162f', name: 'Красное перо' },
    { color: '#0f2d69', name: 'Синее перо' },
    { color: '#0c7a64', name: 'Зелёное перо' },
    { color: '#101a33', name: 'Чёрное перо' },
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

  let tool = $state<Tool>('pen')
  let inkColor = $state(INKS[0].color)

  const strokeColor = $derived(tool === 'marker' ? MARKER : inkColor)
  const strokeWidth = $derived(tool === 'marker' ? MARKER_WIDTH : PEN_WIDTH)

  /**
   * Маркер, ластик и указка переключаются туда и обратно.
   *
   * Обратно — в перо, а не в «руку»: руки здесь нет, и вернуться к письму
   * человек обязан тем же нажатием, каким ушёл.
   */
  function pick(next: Exclude<Tool, 'off' | 'pen'>): void {
    tool = tool === next ? 'pen' : next
  }

  function penIn(color: string): void {
    tool = 'pen'
    inkColor = color
  }

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
      say('Нет связи — отменять нечем')
      return
    }
    session.send({ t: 'ink:undo', page: wanted })
  }

  function wipePage(): void {
    if (!leading) return
    if (offline) {
      say('Нет связи — страница останется как есть')
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
   * Тикает раз в секунду — и только ради двух чисел в верхней нити.
   *
   * Секунда, а не кадр: часы лекции читают, подняв голову, а не следят за
   * ними; перерисовывать полосу шестьдесят раз в секунду ради этого значит
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

  function stopwatch(ms: number): string {
    const total = Math.floor(ms / 1000)
    const mm = String(Math.floor(total / 60) % 60).padStart(2, '0')
    const ss = String(total % 60).padStart(2, '0')
    const hours = Math.floor(total / 3600)
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
  }

  /*
   * Стенные часы собираются руками, а не `toLocaleTimeString`: в аудитории
   * время читают в двадцатичетырёхчасовом виде независимо от того, какой язык
   * стоит в планшете, а «2:36 PM» под секундомером лекции читается вдвое
   * дольше.
   */
  const wall = $derived.by(() => {
    const at = new Date(tick)
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  })

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

  /** Левша: рейлы меняются местами целиком, вместе с полосами «включено». */
  const HAND_KEY = 'colloq.pult.hand'
  const NOTES_KEY = 'colloq.pult.notes'

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

  let hand = $state<'right' | 'left'>(remembered(HAND_KEY) === 'left' ? 'left' : 'right')

  /**
   * Свёрнута ли лента заметок: выбор человека, а `null` — выбора ещё не было.
   *
   * Три состояния, а не два, потому что умолчание здесь зависит от документа.
   * Тому, у кого к этой колоде не написано ни строчки, лента отнимает 136 px
   * листа и не даёт взамен ничего; тому, кто вчера расписал двадцать четыре
   * страницы, свёрнутая лента прячет ровно то, ради чего он открыл пульт.
   * Поэтому пока не тронули шеврон — решает содержимое, а тронули один раз —
   * дальше решает человек, и уже навсегда.
   */
  const NOTES_CHOICE = remembered(NOTES_KEY)
  let foldChoice = $state<'folded' | 'open' | null>(
    NOTES_CHOICE === 'folded' || NOTES_CHOICE === 'open' ? NOTES_CHOICE : null,
  )
  /*
   * Пока заметки не приехали (`notesFile !== file`), лента открыта: пустая
   * лента с надписью «Заметки загружаются» честнее, чем свёрнутая полоска, из
   * которой потом что-то выскочит.
   */
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

  /** С какой стороны у рейла кромка, смотрящая на лист. */
  const leftInner = $derived(hand === 'right' ? 'right' : 'left')
  const rightInner = $derived(hand === 'right' ? 'left' : 'right')

  /* --------------------------------------------------------------- листы */

  /**
   * Что поднято снизу. Один лист за раз: два — это уже интерфейс, а не пульт.
   *
   * Объявлено раньше всего, что его читает: пока лист открыт, перо на слайде
   * не рисует, и `canDraw` ниже спрашивает именно отсюда.
   */
  let pane = $state<'pages' | 'more' | 'stop' | 'grab' | 'ink' | 'files' | null>(null)
  /** Подтверждение «стереть страницу» — внутри строки листа «Ещё». */
  let wipeAsked = $state(false)

  function openPane(next: typeof pane): void {
    pane = next
    wipeAsked = false
  }

  /* --------------------------------------------------- перо, ладонь, свайп */

  /** Слой чернил держит указатель: идёт штрих, стирание или пружинная указка. */
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
   * Лист исключён нарочно: его касания разбирает слой чернил (пружинная
   * указка пальцем), и проглоченный `pointerup` оставил бы указку гореть.
   * `preventDefault` на `pointerdown` НЕ отменяет последующий `click` — его
   * глотаем отдельно; в Safari он приходит как PointerEvent и несёт
   * `pointerType`.
   */
  const PALM_MS = 600

  $effect(() => {
    const node = root
    if (!node) return
    const watch = (event: Event): void => {
      const pointer = event as PointerEvent
      if (!('pointerType' in pointer)) return
      if (pointer.pointerType === 'pen') {
        penSeen = true
        return
      }
      if (pointer.pointerType !== 'touch') return
      if ((event.target as Element | null)?.closest('.pult-sheet')) return
      if (!busy && performance.now() - lastBusyAt >= PALM_MS) return
      event.stopPropagation()
      if (event.cancelable) event.preventDefault()
    }
    const names = ['pointerdown', 'pointerup', 'click'] as const
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
  const mayGoDark = $derived(awakeWanted && (!canKeepAwake() || wake === 'refused' || wake === 'unavailable'))

  const AUTOLOCK = 'Настройки → Экран и яркость → Автоблокировка → Никогда.'

  /* -------------------------------------------------------------- строка */

  /**
   * Одна строка на шесть секунд — вместо модального окна.
   *
   * Модальное окно встаёт поперёк того, ради чего его открыли; молчание —
   * хуже обоих. «Лекция закончена», «Страница очищена» читают один раз и
   * забывают.
   */
  let notice = $state<string | null>(null)
  let noticeTimer: number | undefined

  function say(text: string): void {
    notice = text
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
      say(trouble)
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

  const THUMB_W = 120
  const THUMB_H = 68
  const THUMB_STEP = THUMB_W + 8

  let strip = $state<HTMLDivElement | null>(null)
  let stripFrom = $state(1)
  let stripTo = $state(0)

  const pageList = $derived(Array.from({ length: pages }, (_, i) => i + 1))

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
    node.scrollLeft = Math.max(0, (wanted - 1) * THUMB_STEP - node.clientWidth / 3)
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
      event.preventDefault()
      pick('laser')
    } else if (event.code === 'KeyN') {
      event.preventDefault()
      setFolded(!folded)
    } else if (/^Digit[1-4]$/.test(event.code)) {
      event.preventDefault()
      penIn(INKS[Number(event.code.slice(5)) - 1].color)
    }
  }

  /* ------------------------------------------------------------- классы */

  /*
   * Кнопки собраны руками, поэтому список свойств перехода выписан целиком:
   * утилита `transition-colors` переписала бы `transition-property` и
   * выбросила из него `transform`, то есть само нажатие.
   */
  const PRESS =
    'transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'enabled:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'

  const RAIL =
    `relative flex w-full shrink-0 flex-col items-center justify-center gap-1 ` +
    `text-2xs font-bold uppercase tracking-caps disabled:opacity-30 ${PRESS}`

  const ROW = `flex h-14 w-full items-center gap-3 px-4 text-left text-ui ${PRESS}`

  /** «Включено» — не яркостью: бледнее читается как «этот хуже», а не «этот выбран». */
  function tone(on: boolean): string {
    return on ? 'bg-raised text-ink' : 'text-muted'
  }
</script>

<svelte:window {onkeydown} />

<!--
  Отступы под вырезом и домашним индикатором — на корне, одним местом. Ни
  одного `vh`: цепочка `height: 100%` не зависит ни от панелей Safari, ни от
  того, в каком окне сейчас живёт планшет.
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
  {:else}
    {@render thread()}

    {#if lecture === null && prep === null}
      {@render chooser()}
    {:else if wide}
      <div class="flex min-h-0 flex-1 {hand === 'left' ? 'flex-row-reverse' : ''}">
        {@render leftRail()}
        {@render middle()}
        {#if leading}{@render rightRail()}{/if}
      </div>
    {:else}
      <!--
        Узкий пульт: рейлов нет, всё нажимаемое уходит в нижнюю полосу. Это
        названная деградация, а не вторая раскладка.
      -->
      <div class="flex min-h-0 flex-1 flex-col">
        {@render middle()}
        {@render bar()}
      </div>
    {/if}
  {/if}

  {@render panes()}

  {#if notice}
    <div
      class="pointer-events-none absolute inset-x-0 bottom-4 z-40 flex justify-center"
      aria-live="polite"
    >
      <span class="bg-ink px-3 py-1.5 text-2xs font-bold uppercase tracking-caps text-canvas">
        {notice}
      </span>
    </div>
  {/if}
</div>

<!-- =============================================================== нить -->

{#snippet thread()}
  <div
    class="pult-thread flex h-[52px] shrink-0 items-stretch border-b {offline
      ? 'border-danger/40 bg-danger/10'
      : 'border-line bg-canvas'}"
  >
    {#if offline}
      <!--
        Обрыв говорит ровно то, что нужно знать: зал видит СВОЮ страницу, а
        рисовать всё равно можно. Ни модального окна, ни блокировки — лекция не
        останавливается оттого, что упал вайфай.
      -->
      <div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-4">
        <span class="text-2xs font-bold uppercase tracking-label text-danger">
          Нет связи{#if lecture} · зал видит стр. {lecture.page}{/if}
        </span>
        <span class="truncate text-2xs text-muted">Рисуйте — линии сохранятся</span>
      </div>
      {#if lecture}
        <span class="flex items-center px-3 font-mono text-2xs tabular-nums text-muted">
          {stopwatch(runningFor)}
        </span>
      {/if}
    {:else}
      <div class="flex w-[88px] shrink-0 flex-col items-center justify-center">
        {#if lecture}
          <span class="font-mono text-head tabular-nums text-ink">{stopwatch(runningFor)}</span>
          <span class="font-mono text-2xs tabular-nums text-muted">{wall}</span>
        {:else}
          <span class="font-mono text-ui-lg tabular-nums text-muted">{wall}</span>
        {/if}
      </div>
      <div class="flex min-w-0 flex-1 items-center gap-2 px-2">
        {#if preparing}
          <span class="shrink-0 text-2xs font-bold uppercase tracking-institution text-muted">
            подготовка
          </span>
        {:else if lecture}
          <span class="shrink-0 font-mono text-ui-lg tabular-nums text-muted">
            {#if onBoard}
              лист {-wanted}
            {:else}
              {wanted} / {pages || '—'}
            {/if}
          </span>
        {/if}
        {#if file}
          <span class="shrink-0 text-faint" aria-hidden="true">·</span>
          <span class="truncate font-mono text-2xs text-muted">{baseOf(file)}</span>
        {:else}
          <span class="truncate text-ui text-muted">{session.session.name}</span>
        {/if}
        {#if mayGoDark}
          <button
            type="button"
            class="{PRESS} ml-1 shrink-0 px-2 text-2xs font-bold uppercase tracking-caps text-warning"
            onclick={() => openPane('more')}
          >
            Экран может погаснуть
          </button>
        {/if}
      </div>
    {/if}

    {#if preparing}
      <button
        type="button"
        class="btn-primary h-full w-[112px] shrink-0 text-2xs font-bold uppercase tracking-caps"
        onclick={() => prep && start(prep)}
      >
        Вести
      </button>
      <button
        type="button"
        class="{PRESS} flex h-full w-[88px] shrink-0 items-center justify-center text-2xs font-bold uppercase tracking-caps text-muted"
        onclick={() => (prep = null)}
      >
        Готово
      </button>
    {:else}
      {#if fullscreenPossible()}
        <button
          type="button"
          class="{PRESS} flex h-full w-[44px] shrink-0 items-center justify-center text-muted"
          aria-label={full ? 'Выйти из полного экрана' : 'Во весь экран'}
          aria-pressed={full}
          onclick={toggleFullscreen}
        >
          <Icon name="expand" size={16} />
        </button>
      {/if}
      <button
        type="button"
        class="{PRESS} flex h-full w-[44px] shrink-0 items-center justify-center text-muted"
        aria-label="Ещё"
        onclick={() => openPane('more')}
      >
        <Icon name="more" size={16} />
      </button>
      {#if leading}
        <!--
          «Закончить» не в самом углу: угол находят вслепую, а эту кнопку
          вслепую находить нельзя. При нехватке ширины теряет слово, но не
          размер цели: 44 px — пол для пальца, и он держится даже здесь.
        -->
        <button
          type="button"
          class="{PRESS} flex h-full shrink-0 items-center justify-center gap-1.5 text-2xs font-bold uppercase tracking-label text-danger {box.w >=
          560
            ? 'w-[112px]'
            : 'w-[44px]'}"
          aria-label="Закончить лекцию"
          onclick={() => openPane('stop')}
        >
          <Icon name="x" size={14} />
          {#if box.w >= 560}Закончить{/if}
        </button>
      {/if}
    {/if}
  </div>
{/snippet}

<!-- ============================================================== рейлы -->

{#snippet plate()}
  <!--
    Номер страницы живёт в ОДНОМ месте продукта — здесь. При расхождении
    показывает обе: слева то, что видит зал, справа то, что видите вы.
  -->
  <button
    type="button"
    class="{RAIL} h-[76px] {tone(false)}"
    aria-label="Выбрать страницу"
    onclick={() => openPane('pages')}
  >
    {#if behind && lecture}
      <span class="flex items-baseline gap-1 font-mono tabular-nums">
        <span class="text-ui-lg text-muted">{lecture.page}</span>
        <span class="text-2xs text-faint" aria-hidden="true">→</span>
        <span class="text-head text-ink">{wanted}</span>
      </span>
      <span class="pult-catchup h-px w-8 bg-accent" aria-hidden="true"></span>
    {:else}
      <span class="font-mono text-head tabular-nums text-ink">{wanted}</span>
      <span class="font-mono text-2xs tabular-nums text-muted">/ {pages || '—'}</span>
    {/if}
  </button>
{/snippet}

{#snippet mark(on: boolean, side: 'left' | 'right')}
  {#if on}
    <span
      class="absolute inset-y-0 {side === 'left' ? 'left-0' : 'right-0'} w-[3px] bg-ink"
      aria-hidden="true"
    ></span>
  {/if}
{/snippet}

{#snippet leftRail()}
  <div
    class="pult-rail flex w-[88px] shrink-0 flex-col bg-canvas {hand === 'left'
      ? 'border-l'
      : 'border-r'} border-line"
    style={`--pult-from:${hand === 'left' ? '100%' : '-100%'}`}
  >
    {@render plate()}
    <span class="h-2 shrink-0" aria-hidden="true"></span>

    {#if leading}
      <!-- Полная инверсия — только у «Паузы»: забытая пауза значит десять
           минут речи в чёрный экран, и её видно должно быть издалека. -->
      <button
        type="button"
        class="{RAIL} h-[80px] {lecture?.blank ? 'bg-ink text-canvas' : tone(false)}"
        aria-pressed={lecture?.blank}
        disabled={offline}
        onclick={() => blank(!lecture?.blank)}
      >
        Пауза
      </button>
    {/if}

    <!-- Мёртвая зона: сюда ложится ладонь держащей руки. -->
    <span class="min-h-0 flex-1" aria-hidden="true"></span>

    {#if mayTurn}
      <button
        type="button"
        class="{RAIL} h-[80px] {tone(false)}"
        disabled={onBoard ? -wanted >= boards : wanted <= 1}
        aria-label="Предыдущая страница"
        onclick={() => step(-1)}
      >
        <Icon name="chevron-left" size={20} />
        Назад
      </button>
      <!-- Зазор нащупывается краем пальца: две соседние кнопки без него
           различаются только на глаз, а на пульт не смотрят. -->
      <span class="h-2 shrink-0" aria-hidden="true"></span>
      <!--
        Самая большая вещь на пульте, и центр её лежит там, где лежит большой
        палец: вперёд листают в восемь раз чаще, чем назад.
      -->
      <button
        type="button"
        class="{RAIL} h-[160px] {tone(false)}"
        disabled={!onBoard && pages > 0 && wanted >= pages}
        aria-label="Следующая страница"
        onclick={() => step(1)}
      >
        <Icon name="chevron-right" size={28} />
        Вперёд
      </button>
      <span class="h-[128px] shrink-0" aria-hidden="true"></span>
      {#if leading}
        <button
          type="button"
          class="{RAIL} h-[88px] {tone(false)}"
          onclick={undoStroke}
          aria-label="Отменить последний штрих"
        >
          <Icon name="undo" size={20} />
          Отменить
        </button>
      {/if}
    {/if}
    <span class="h-1 shrink-0" aria-hidden="true"></span>
  </div>
{/snippet}

{#snippet rightRail()}
  <div
    class="pult-rail flex w-[88px] shrink-0 flex-col bg-canvas {hand === 'left'
      ? 'border-r'
      : 'border-l'} border-line"
    style={`--pult-from:${hand === 'left' ? '-100%' : '100%'}`}
  >
    <!-- Мёртвая зона: здесь проходит запястье пишущей руки. -->
    <span class="min-h-0 flex-1" aria-hidden="true"></span>

    <!--
      Цвет и перо — один вопрос, а не два: нажатие по диску выбирает и то, и
      другое. Пока активны маркер, ластик или указка, цвет, к которому вернётся
      перо, помечен только увеличенным диском — без полосы, потому что полоса
      значит «работает сейчас».
    -->
    {#each INKS as choice, index (choice.color)}
      {#if index > 0}<span class="h-px w-full shrink-0 bg-line" aria-hidden="true"></span>{/if}
      <button
        type="button"
        class="{RAIL} h-[62px] {tool === 'pen' && inkColor === choice.color ? 'bg-raised' : ''}"
        aria-label={choice.name}
        aria-pressed={tool === 'pen' && inkColor === choice.color}
        onclick={() => penIn(choice.color)}
      >
        {@render mark(tool === 'pen' && inkColor === choice.color, rightInner)}
        <span
          class="rounded-full transition-transform duration-press ease-out {inkColor ===
          choice.color
            ? 'h-7 w-7'
            : 'h-[22px] w-[22px]'}"
          style={`background:${choice.color}`}
        ></span>
      </button>
    {/each}

    <span class="h-2 shrink-0" aria-hidden="true"></span>

    <button
      type="button"
      class="{RAIL} h-[88px] {tone(tool === 'marker')}"
      aria-pressed={tool === 'marker'}
      onclick={() => pick('marker')}
    >
      {@render mark(tool === 'marker', rightInner)}
      <Icon name="marker" size={20} />
      Маркер
    </button>
    <!--
      Ластик стирает ШТРИХАМИ, а не пикселями: в проводе есть только «убрать
      штрих по имени», и пиксельное стирание потребовало бы нового формата и
      переписывания всей истории лекции. Удержание полсекунды стирает страницу.
    -->
    <button
      type="button"
      class="{RAIL} h-[88px] {tone(tool === 'eraser')}"
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
      {@render mark(tool === 'eraser', rightInner)}
      <Icon name="eraser" size={20} />
      Ластик
    </button>

    <span class="h-[68px] shrink-0" aria-hidden="true"></span>

    <!--
      Чистый лист — там же, где инструменты, потому что это инструмент и есть:
      слайд кончился, а вывод формулы нет. Нажатие заводит НОВЫЙ лист, повторное
      возвращает к слайду, с которого ушли: исписанный лист никуда не девается,
      к нему возвращаются лентой, как к любой странице.
    -->
    {#if mayTurn}
      <button
        type="button"
        class="{RAIL} h-[88px] {onBoard ? 'bg-ink text-canvas' : tone(false)}"
        aria-pressed={onBoard}
        onclick={() => (onBoard ? backToSlides() : newBoard())}
      >
        <Icon name={onBoard ? 'pdf' : 'plus'} size={20} />
        {onBoard ? 'К слайду' : 'Лист'}
      </button>
    {/if}

    <button
      type="button"
      class="{RAIL} h-[88px] {tone(tool === 'laser')}"
      aria-pressed={tool === 'laser'}
      disabled={offline}
      onclick={() => pick('laser')}
    >
      {@render mark(tool === 'laser', rightInner)}
      <Icon name="bolt" size={20} />
      Указка
    </button>
    <span class="h-1 shrink-0" aria-hidden="true"></span>
  </div>
{/snippet}

<!-- ============================================================== середина -->

{#snippet middle()}
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    {#if lecture?.blank}
      <!--
        Полоса и есть кнопка: тысяча пикселей на сорок четыре — цель, в которую
        попадают не глядя. Лист под ней остаётся виден и продолжает принимать
        перо: рисунок можно подготовить и снять паузу уже с ним.
      -->
      <button
        type="button"
        class="{PRESS} flex h-[44px] w-full shrink-0 items-center justify-center bg-ink text-2xs font-bold uppercase tracking-institution text-canvas"
        onclick={() => blank(false)}
        disabled={!leading || offline}
      >
        Проекция погашена — нажмите, чтобы вернуть
      </button>
    {/if}

    <!--
      Роль стоит ради проверки доступности, и она честная: свайп по листу — это
      удобство для пальца, а не единственный путь. Всё, что он делает, делают и
      кнопки рейла, и стрелки на клавиатуре.
    -->
    <div
      class="pult-sheet relative flex min-h-0 min-w-0 flex-1 p-2"
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
          у проектора документ, скорее всего, открыт. Поэтому страница, пауза,
          заметки и часы продолжают работать: отнимать управление из-за
          собственной неудачи — худшее, что пульт может сделать. Гаснут только
          перо и указка: целиться в страницу, которой не видно, нельзя.
        -->
        <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Icon name="alert" size={24} class="text-danger" />
          <p class="text-ui-lg text-ink">Не удалось открыть документ</p>
          <p class="font-mono text-2xs text-muted">{file}</p>
          <div class="mt-2 flex gap-3">
            <button
              type="button"
              class="btn-outline h-12 w-[160px]"
              onclick={() => (attempt += 1)}
            >
              Попробовать снова
            </button>
            {#if leading}
              <button type="button" class="btn-outline h-12 w-[160px]" onclick={() => openPane('stop')}>
                Закончить лекцию
              </button>
            {/if}
          </div>
        </div>
      {:else}
        <div
          class="flex min-h-0 min-w-0 flex-1"
          style={`transform:translateX(${drag}px);transition:${sliding ? 'none' : 'transform 100ms var(--ease-out)'}`}
        >
          <LecturePage {doc} page={wanted}>
            {#snippet over(size)}
              <InkLayer
                page={wanted}
                live={canDraw}
                tool={canDraw ? tool : 'off'}
                color={strokeColor}
                width={strokeWidth}
                w={size.w}
                h={size.h}
                {onbusy}
                suspend={suspend || editing || sheetOpen}
              />
            {/snippet}
          </LecturePage>
        </div>
      {/if}
    </div>

    {#if watching}
      <!--
        Стены здесь нет: чужую лекцию видно целиком — лист, чужие чернила,
        часы, номер. Заметки тоже: они привязаны к ФАЙЛУ, а не к лекции, и
        второй преподаватель правит их законно. Поэтому полоса «взять пульт»
        встаёт НАД лентой заметок, а не вместо неё.
      -->
      <div class="flex h-[56px] shrink-0 items-center justify-center gap-4 border-t border-line px-4">
        <button type="button" class="btn-primary h-[44px] w-[280px]" onclick={() => openPane('grab')}>
          Взять пульт
        </button>
        <span class="truncate text-2xs text-muted">Ведёт {lecture?.byName}</span>
      </div>
    {/if}

    {#if file !== null && !tiny}
      <!--
        Лента заметок живёт ПОД листом, во всю его ширину, а не колонкой сбоку:
        колонка в 300 px даёт 35 знаков в строке и превращает речь в столбик
        обрывков, полоса в 700 — настоящий абзац, который читается одним
        взглядом. Высоту ей задаёт пульт: сама она растягивается по месту.

        Заметки видит только хост — NotesPad проверяет это сам, но пульт
        всё равно не показывает ленту там, где показывать нечего.
      -->
      <div class="flex shrink-0 {folded || !wide ? 'h-[32px]' : 'h-[168px]'}">
        <NotesPad
          {file}
          page={wanted}
          compact={!wide}
          folded={folded || !wide}
          onfold={wide ? setFolded : undefined}
          onedit={(next) => (editing = next)}
        />
        {#if wide && !folded && doc && !onBoard && pages > wanted}
          <!--
            «Что дальше» — второй из четырёх вопросов говорящего, и ответ на
            него обязан стоять рядом с третьим («что сказать»), а не в другом
            углу экрана. Заодно это кнопка: нажатие листает вперёд.
          -->
          <button
            type="button"
            class="{PRESS} flex w-[249px] shrink-0 flex-col gap-1 border-l border-t border-line p-2"
            aria-label="Следующая страница"
            onclick={() => step(1)}
          >
            <span class="text-2xs font-bold uppercase tracking-section text-muted">дальше</span>
            <LecturePage {doc} page={wanted + 1} dim />
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<!-- ====================================================== нижняя полоса -->

{#snippet bar()}
  <!--
    Узкий пульт. Инструменты сворачиваются в одну кнопку текущего цвета, пауза
    уезжает в «Ещё», эскиза «дальше» нет вовсе: миниатюра меньше 160 px не
    читается, а нечитаемая картинка хуже её отсутствия.
  -->
  <div class="pult-bar flex h-[76px] shrink-0 items-stretch border-t border-line bg-canvas">
    <button
      type="button"
      class="{PRESS} flex w-[72px] shrink-0 flex-col items-center justify-center"
      aria-label="Выбрать страницу"
      onclick={() => openPane('pages')}
    >
      <span class="font-mono text-ui-lg tabular-nums text-ink">{wanted}</span>
      <span class="font-mono text-micro tabular-nums text-muted">/ {pages || '—'}</span>
    </button>
    <button
      type="button"
      class="{PRESS} flex w-[72px] shrink-0 items-center justify-center text-muted"
      disabled={!mayTurn || wanted <= 1}
      aria-label="Предыдущая страница"
      onclick={() => step(-1)}
    >
      <Icon name="chevron-left" size={20} />
    </button>
    <button
      type="button"
      class="{PRESS} flex min-w-[132px] flex-1 items-center justify-center gap-2 text-2xs font-bold uppercase tracking-caps text-ink"
      disabled={!mayTurn || (pages > 0 && wanted >= pages)}
      onclick={() => step(1)}
    >
      <Icon name="chevron-right" size={20} />
      Вперёд
    </button>
    {#if leading && !tiny}
      <button
        type="button"
        class="{PRESS} flex w-[72px] shrink-0 items-center justify-center"
        aria-label="Перо и цвет"
        onclick={() => openPane('ink')}
      >
        <span
          class="h-6 w-6 rounded-full"
          style={`background:${tool === 'marker' ? MARKER : inkColor}`}
        ></span>
      </button>
    {/if}
    {#if leading}
      <button
        type="button"
        class="{PRESS} flex w-[72px] shrink-0 items-center justify-center text-muted"
        aria-label="Отменить последний штрих"
        onclick={undoStroke}
      >
        <Icon name="undo" size={20} />
      </button>
    {/if}
    {#if leading && !tiny}
      <button
        type="button"
        class="{PRESS} flex w-[88px] shrink-0 flex-col items-center justify-center gap-1 text-2xs font-bold uppercase tracking-caps {tone(
          tool === 'laser',
        )}"
        aria-pressed={tool === 'laser'}
        disabled={offline}
        onclick={() => pick('laser')}
      >
        <Icon name="bolt" size={18} />
        Указка
      </button>
    {/if}
  </div>
{/snippet}

<!-- ====================================================== выбор документа -->

{#snippet fileList(onpick: (path: string) => void, withNotes: boolean)}
  {#if slides.length === 0}
    <p class="px-4 py-6 text-ui text-muted">
      В комнате нет документов. Загрузите PDF с компьютера — он появится здесь.
    </p>
  {:else}
    <ul class="border-t border-line">
      {#each slides as entry (entry.path)}
        {@const going = lecture?.file === entry.path}
        <li class="flex items-stretch border-b border-line">
          <!--
            Идущая лекция стоит в этом же ряду, и нажатие по ней читается как
            «убедиться, что открыт правильный документ». Сервер такое нажатие не
            выполняет вовсе — но молчаливый отказ выглядит как поломка, поэтому
            строка сама говорит, что она уже открыта, и нажимать её незачем.
          -->
          <button
            type="button"
            class="{PRESS} flex h-[88px] min-w-0 flex-1 flex-col justify-center gap-1 px-4 text-left disabled:opacity-60"
            disabled={going}
            onclick={() => onpick(entry.path)}
          >
            <span class="truncate text-title text-ink">{entry.name}</span>
            <span class="truncate font-mono text-2xs text-muted">
              {going ? 'идёт сейчас' : entry.path}
            </span>
          </button>
          {#if withNotes}
            <button
              type="button"
              class="{PRESS} flex h-[88px] w-[88px] shrink-0 items-center justify-center border-l border-line text-2xs font-bold uppercase tracking-caps text-muted"
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
    Лекции нет — и рейлов нет вовсе: пустой рейл выглядит как сломанный пульт.
    Нажатие по строке начинает лекцию И просит полный экран одним живым жестом.
  -->
  <div class="flex min-h-0 flex-1 justify-center overflow-y-auto p-6">
    <div class="w-full max-w-[720px]">
      <h2 class="pb-3 text-2xs font-bold uppercase tracking-section text-muted">
        Выберите документ
      </h2>
      {@render fileList(start, true)}
    </div>
  </div>
{/snippet}

<!-- =============================================================== листы -->

{#snippet panes()}
  {#if pane !== null}
    <!-- Ложе гасит нажатие мимо листа: закрыть можно и им, и Escape. -->
    <div class="absolute inset-0 z-30 flex flex-col justify-end">
      <button
        type="button"
        class="absolute inset-0 bg-ink/28"
        aria-label="Закрыть"
        onclick={() => openPane(null)}
      ></button>

      {#if pane === 'stop'}
        <!--
          Приколот к кнопке, а не поднят снизу: подтверждение обязано стоять
          там, куда человек только что нажал.
        -->
        <div class="absolute right-1 top-[52px] w-[280px] border border-line bg-canvas p-4 shadow-pop">
          <p class="text-ui text-ink">
            Закончить лекцию? Проекция погаснет, чернила сотрутся.
            <b class="font-semibold">Заметки останутся.</b>
          </p>
          <div class="mt-4 flex gap-2">
            <!-- Опасное слева, «Отмена» справа — под пальцем той руки, которая
                 держит планшет. -->
            <button
              type="button"
              class="btn-outline h-11 flex-1 border-danger/40 text-danger"
              onclick={stop}
            >
              Закончить
            </button>
            <button type="button" class="btn-outline h-11 flex-1" onclick={() => openPane(null)}>
              Отмена
            </button>
          </div>
        </div>
      {:else}
        <div class="pult-slide relative max-h-full border-t-2 border-ink bg-canvas shadow-pop">
          {#if pane === 'pages'}
            <div class="flex h-[40px] items-center justify-between px-4">
              <span class="text-2xs font-bold uppercase tracking-section text-muted">Страница</span>
              <button
                type="button"
                class="{PRESS} h-[40px] px-2 text-2xs font-bold uppercase tracking-caps text-muted"
                onclick={() => openPane(null)}
              >
                Отмена
              </button>
            </div>
            <div
              bind:this={strip}
              class="flex gap-2 overflow-x-auto px-4 pb-4"
              onscroll={(event) => scanStrip(event.currentTarget)}
            >
              {#each pageList as index (index)}
                <button
                  type="button"
                  class="{PRESS} flex shrink-0 flex-col items-center gap-1 border-b-[3px] {index ===
                  wanted
                    ? 'border-ink bg-raised'
                    : 'border-transparent'}"
                  onclick={() => {
                    goTo(index)
                    openPane(null)
                  }}
                >
                  <span
                    class="flex items-center justify-center bg-white"
                    style={`width:${THUMB_W}px;height:${THUMB_H}px`}
                  >
                    {#if index >= stripFrom && index <= stripTo && doc}
                      <canvas use:thumb={index} class="block"></canvas>
                    {/if}
                  </span>
                  <span class="pb-1 font-mono text-2xs tabular-nums text-muted">{index}</span>
                </button>
              {/each}
            </div>
          {:else if pane === 'ink'}
            <div class="flex h-[40px] items-center px-4">
              <span class="text-2xs font-bold uppercase tracking-section text-muted">Перо</span>
            </div>
            <div class="flex items-stretch border-t border-line">
              {#each INKS as choice (choice.color)}
                <button
                  type="button"
                  class="{PRESS} flex h-[76px] flex-1 items-center justify-center {tool === 'pen' &&
                  inkColor === choice.color
                    ? 'bg-raised'
                    : ''}"
                  aria-label={choice.name}
                  aria-pressed={tool === 'pen' && inkColor === choice.color}
                  onclick={() => {
                    penIn(choice.color)
                    openPane(null)
                  }}
                >
                  <span class="h-7 w-7 rounded-full" style={`background:${choice.color}`}></span>
                </button>
              {/each}
            </div>
            <button
              type="button"
              class="{ROW} border-t border-line {tone(tool === 'marker')}"
              onclick={() => {
                pick('marker')
                openPane(null)
              }}
            >
              <Icon name="marker" size={18} />
              Маркер
            </button>
            <button
              type="button"
              class="{ROW} border-t border-line {tone(tool === 'eraser')}"
              onclick={() => {
                pick('eraser')
                openPane(null)
              }}
            >
              <Icon name="eraser" size={18} />
              Ластик
            </button>
          {:else if pane === 'grab'}
            <div class="p-5">
              <p class="text-ui text-ink">
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
            <div class="flex h-[40px] items-center px-4">
              <span class="text-2xs font-bold uppercase tracking-section text-muted">Документ</span>
            </div>
            <!-- Пиксели, а не `vh`: единица высоты окна на iPad живёт своей
                 жизнью между панелями Safari и Split View, а лист и без того
                 ограничен сверху высотой пульта. -->
            <div class="max-h-[360px] overflow-y-auto">
              {@render fileList(start, false)}
            </div>
          {:else if pane === 'more'}
            <button type="button" class="{ROW} text-ink" onclick={onexit}>
              <Icon name="board" size={18} class="text-muted" />
              В комнату
            </button>
            <button
              type="button"
              class="{ROW} border-t border-line text-ink"
              aria-pressed={hand === 'left'}
              onclick={() => setHand(hand === 'left' ? 'right' : 'left')}
            >
              <span class="flex-1">Левая рука</span>
              <span class="text-2xs font-bold uppercase tracking-caps text-muted">
                {hand === 'left' ? 'вкл' : 'выкл'}
              </span>
            </button>
            <button
              type="button"
              class="{ROW} border-t border-line text-ink"
              aria-pressed={theme.current === 'dark'}
              onclick={() => theme.toggle()}
            >
              <Icon name={theme.current === 'dark' ? 'moon' : 'sun'} size={18} class="text-muted" />
              <span class="flex-1">Тёмная тема</span>
              <span class="text-2xs font-bold uppercase tracking-caps text-muted">
                {theme.current === 'dark' ? 'вкл' : 'выкл'}
              </span>
            </button>
            {#if leading}
              <!--
                Пауза здесь, а не только в рейле.
                
                Рейлы рисуются лишь в широкой раскладке, а погасить слайд,
                отходя к доске, нужнее всего как раз в узкой: в Split View
                рядом с пультом открыт конспект, и планшет в этот момент
                держат одной рукой. До сих пор снять паузу было можно, а
                поставить — нечем.
              -->
              <button
                type="button"
                class="{ROW} border-t border-line {lecture?.blank ? 'text-danger' : 'text-ink'}"
                aria-pressed={lecture?.blank === true}
                disabled={offline}
                onclick={() => {
                  blank(!(lecture?.blank ?? false))
                  openPane(null)
                }}
              >
                <Icon name="moon" size={18} class="text-muted" />
                <span class="flex-1">Погасить проекцию</span>
                <span class="text-2xs font-bold uppercase tracking-caps text-muted">
                  {lecture?.blank ? 'сейчас погашена' : 'B'}
                </span>
              </button>
              <div class="flex items-center border-t border-line">
                {#if wipeAsked}
                  <span class="flex-1 px-4 text-ui text-ink">Стереть чернила с этой страницы?</span>
                  <button
                    type="button"
                    class="{PRESS} h-14 px-4 text-2xs font-bold uppercase tracking-caps text-danger"
                    onclick={() => {
                      wipePage()
                      openPane(null)
                    }}
                  >
                    Стереть
                  </button>
                  <button
                    type="button"
                    class="{PRESS} h-14 px-4 text-2xs font-bold uppercase tracking-caps text-muted"
                    onclick={() => (wipeAsked = false)}
                  >
                    Отмена
                  </button>
                {:else}
                  <button
                    type="button"
                    class="{ROW} text-danger"
                    onclick={() => (wipeAsked = true)}
                  >
                    <Icon name="eraser" size={18} />
                    Стереть страницу
                  </button>
                {/if}
              </div>
              <button
                type="button"
                class="{ROW} border-t border-line text-ink"
                onclick={() => {
                  if (onBoard) backToSlides()
                  else newBoard()
                  openPane(null)
                }}
              >
                <Icon name={onBoard ? 'pdf' : 'plus'} size={18} class="text-muted" />
                <span class="flex-1">{onBoard ? 'Вернуться к слайду' : 'Чистый лист'}</span>
                {#if boards > 0 && !onBoard}
                  <span class="text-2xs font-bold uppercase tracking-caps text-muted">
                    {boards} завед{boards === 1 ? 'ён' : 'ено'}
                  </span>
                {/if}
              </button>
              <button
                type="button"
                class="{ROW} border-t border-line text-ink"
                onclick={() => openPane('files')}
              >
                <Icon name="pdf" size={18} class="text-muted" />
                Сменить документ…
              </button>
            {/if}
            <div class="h-px w-full bg-line" aria-hidden="true"></div>
            <div class="px-4 py-3">
              <p class="text-ui text-ink">Экран не гаснет</p>
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
          {/if}
        </div>
      {/if}
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

  .pult-thread,
  .pult-rail,
  .pult-bar {
    touch-action: manipulation;
  }

  /*
   * Рейлы въезжают от краёв — единственная анимация появления на пульте, и она
   * заодно показывает, где рейлы живут. Только transform: геометрию и тени
   * анимировать нельзя, это layout на каждом кадре.
   */
  .pult-rail {
    animation: rail-in 220ms var(--ease-out) both;
  }

  @keyframes rail-in {
    from {
      transform: translateX(var(--pult-from, -100%));
    }
    to {
      transform: none;
    }
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

  /* Полоса схождения: ползёт scaleX, а не width — ширина это раскладка. */
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
   * приехала мимо человека, попросившего не двигать экран.
   */
  @media (prefers-reduced-motion: reduce) {
    .pult-rail,
    .pult-slide,
    .pult-catchup {
      animation-duration: 1ms;
    }
  }
</style>
